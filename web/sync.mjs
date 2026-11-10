import { createId, makeBundle, mergeRecords, parseBundle, recordKey } from './core.mjs';

const protocol = 'hsannu-icc-sync-v1';
const peerCode = /^icc-[0-9a-f]{32}$/;
const publisherCode = /^[A-Za-z0-9_-]{1,128}$/;
const partLength = 8_000;
const maxParts = 2_000;
const handshakeTimeout = 15_000;
const confirmationTimeout = 120_000;
const acknowledgementTimeout = 30_000;
const defaultIceConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  sdpSemantics: 'unified-plan',
};
const turnUrl = /^(turns?):(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([0-9]{1,5}))?(?:\?transport=(udp|tcp))?$/i;
const invalidTurnUrl = '请填写一个有效的 turn: 或 turns: 地址。';

function turnServer({ url = '', username = '', credential = '' } = {}) {
  const address = url.trim();
  if (!address && !username && !credential) return null;
  const match = turnUrl.exec(address);
  if (!match) throw new Error(invalidTurnUrl);
  const [, rawScheme, host, port, rawTransport] = match;
  const scheme = rawScheme.toLowerCase();
  const transport = rawTransport?.toLowerCase();
  if ((port && (Number(port) < 1 || Number(port) > 65535)) || (scheme === 'turns' && transport === 'udp')) {
    throw new Error(invalidTurnUrl);
  }
  let hostname;
  try {
    hostname = new URL(`https://${host}`).hostname;
  } catch {
    throw new Error(invalidTurnUrl);
  }
  if (!username.trim() || !credential.trim() || /[\u0000-\u001f\u007f]/.test(username + credential)) {
    throw new Error('请一起填写 TURN 用户名和凭证。');
  }
  const urls = `${scheme}:${hostname}${port ? `:${Number(port)}` : ''}${transport ? `?transport=${transport}` : ''}`;
  return { urls, username, credential };
}

function connectionOptions(peerOptions, turn) {
  const relay = turnServer(turn);
  const config = { ...defaultIceConfig, ...peerOptions?.config };
  if (relay) config.iceServers = [...defaultIceConfig.iceServers, relay];
  return { ...peerOptions, config };
}

export function selectedRecords(state) {
  const keys = new Set(state.published);
  return state.records.filter(record => record.publisherId === state.publisherId && keys.has(recordKey(record)));
}

// The store persists opt-in, the local code and accepted identities. Live links and
// pending requests belong to this page. Peer and peerOptions allow isolated tests.
export function createSync({
  store, Peer = globalThis.peerjs?.Peer ?? globalThis.Peer, peerOptions,
  onChange = () => {}, onReceive = () => {}, retryMs = 8_000,
}) {
  let state;
  let peer;
  let activeOptions;
  let running = false;
  let generation = 0;
  let status = 'disabled';
  let detail = '';
  let timer;
  const links = new Map();
  const ignored = new Set();
  const peerDetails = new Map();

  function trustedLink(link) {
    return running && links.get(link.id) === link && link.conn.open &&
      link.remoteAccepted && state.peers.some(item => item.id === link.id && item.publisherId === link.publisherId);
  }

  function getSnapshot() {
    const saved = state?.peers ?? [];
    const peers = saved.map(item => {
      const link = links.get(item.id);
      const last = peerDetails.get(item.id) ?? {};
      let connection = 'offline';
      if (link?.publisherId && trustedLink(link)) connection = 'online';
      else if (link?.publisherId && link.conn.open) connection = 'awaiting';
      else if (link) connection = 'connecting';
      else if (last.error) connection = 'error';
      return { ...item, ...last, connection };
    });
    const requests = [...links.values()]
      .filter(link => link.publisherId && !saved.some(item => item.id === link.id))
      .map(link => ({ id: link.id, publisherId: link.publisherId, outgoing: link.outgoing }));
    return { enabled: running, code: state?.syncPeerId ?? '', status, detail, peers, requests };
  }

  function emit() {
    onChange(getSnapshot());
  }

  function setStatus(next, message = '') {
    status = next;
    detail = message;
    emit();
  }

  function closeLink(link) {
    if (links.get(link.id) === link) links.delete(link.id);
    link.conn.close();
  }

  function linkError(link, message) {
    if (links.get(link.id) !== link) return;
    peerDetails.set(link.id, { ...peerDetails.get(link.id), error: message });
    closeLink(link);
    setStatus(status, message);
  }

  function send(link, body) {
    if (links.get(link.id) !== link || !link.conn.open) return false;
    try {
      link.conn.send({ protocol, ...body });
      return true;
    } catch {
      linkError(link, '资料传输中断，正在等待重连。');
      return false;
    }
  }

  async function sendSelection(link) {
    if (!trustedLink(link)) return;
    const current = await store.read();
    if (!trustedLink(link) || !current.syncEnabled) return;
    if (!current.peers.some(item => item.id === link.id && item.publisherId === link.publisherId)) return;
    const records = selectedRecords(current);
    const signature = records.map(record => `${recordKey(record)}:${record.version}`).join(',');
    if (signature === link.signature) return;

    const bundle = JSON.stringify(makeBundle(records));
    const total = Math.ceil(bundle.length / partLength);
    const transfer = createId();
    link.signature = signature;
    link.sent = { transfer, count: records.length, deadline: Date.now() + acknowledgementTimeout };
    for (let index = 0; index < total; index += 1) {
      const part = bundle.slice(index * partLength, (index + 1) * partLength);
      if (!send(link, { type: 'part', transfer, index, total, part })) break;
    }
  }

  async function receivePart(link, message) {
    const { transfer, index, total, part } = message;
    if (!publisherCode.test(transfer) || !Number.isInteger(index) || !Number.isInteger(total) ||
        index < 0 || index >= total || total > maxParts || typeof part !== 'string' || part.length > partLength) {
      throw new Error('收到格式无效的同步消息。');
    }
    if (index === 0) link.incoming = { transfer, total, parts: [] };
    const incoming = link.incoming;
    if (!incoming || incoming.transfer !== transfer || incoming.total !== total || incoming.parts.length !== index) {
      throw new Error('资料传输顺序异常，请重连。');
    }
    incoming.parts.push(part);
    if (index + 1 !== total) return;
    link.incoming = null;

    let result;
    let merged;
    try {
      const records = parseBundle(incoming.parts.join(''));
      if (records.some(record => record.publisherId !== link.publisherId)) throw new Error('发布者不匹配。');
      merged = await store.update(current => {
        const approved = current.peers.some(item => item.id === link.id && item.publisherId === link.publisherId);
        if (!trustedLink(link) || !current.syncEnabled || !approved || link.publisherId === current.publisherId) return;
        result = mergeRecords(current.records, records);
        current.records = result.records;
      });
    } catch {
      send(link, { type: 'rejected', transfer });
      setStatus(status, '对方资料包无法导入，已保留现有记录。');
      return;
    }
    if (!result || !trustedLink(link)) return;
    send(link, { type: 'received', transfer, conflicts: result.conflicts });
    if (result.added || result.updated || result.conflicts) onReceive(result, merged);
  }

  async function onData(link, message) {
    if (links.get(link.id) !== link || message?.protocol !== protocol) return;
    if (message.type === 'hello') {
      if (link.publisherId || typeof message.publisherId !== 'string' ||
          !publisherCode.test(message.publisherId) || message.publisherId === state.publisherId) {
        throw new Error('配对身份无效。');
      }
      const expected = state.peers.find(item => item.id === link.id);
      if (expected && expected.publisherId !== message.publisherId) throw new Error('对方发布者身份与已配对的记录不一致。');
      link.publisherId = message.publisherId;
      link.deadline = Date.now() + confirmationTimeout;
      if (expected) send(link, { type: 'accept' });
      emit();
      return;
    }
    if (!link.publisherId) return;
    if (message.type === 'decline') {
      linkError(link, '对方结束了本次配对。');
      return;
    }
    if (message.type === 'accept') {
      link.remoteAccepted = true;
      emit();
      await sendSelection(link);
      return;
    }
    if (!trustedLink(link)) return;
    if (message.type === 'part') {
      await receivePart(link, message);
      return;
    }
    if (!link.sent || message.transfer !== link.sent.transfer) return;
    if (message.type === 'received') {
      const conflicts = Number.isInteger(message.conflicts) ? message.conflicts : 0;
      peerDetails.set(link.id, { lastReceivedAt: new Date().toISOString(), count: link.sent.count, conflicts });
    } else if (message.type === 'rejected') {
      peerDetails.set(link.id, { error: '对方未能导入这次发送的资料。' });
    } else {
      return;
    }
    link.sent = null;
    emit();
  }

  function attach(conn, outgoing) {
    const id = conn.peer;
    if (!running || !peerCode.test(id) || id === state.syncPeerId || ignored.has(id) || links.size >= 24) {
      conn.close();
      return;
    }
    const existing = links.get(id);
    if (existing) {
      const preferOutgoing = state.syncPeerId < id;
      if (trustedLink(existing) || existing.outgoing === preferOutgoing || outgoing !== preferOutgoing) {
        conn.close();
        return;
      }
      closeLink(existing);
    }

    const link = { id, conn, outgoing, deadline: Date.now() + handshakeTimeout, inbox: Promise.resolve() };
    links.set(id, link);
    peerDetails.delete(id);
    conn.on('open', () => send(link, { type: 'hello', publisherId: state.publisherId }));
    conn.on('data', message => {
      link.inbox = link.inbox.then(() => onData(link, message)).catch(error => linkError(link, error.message));
    });
    conn.on('close', () => {
      if (links.get(id) === link) {
        links.delete(id);
        emit();
      }
    });
    conn.on('error', () => linkError(link, '与同学的连接中断，正在等待重连。'));
    if (conn.open) send(link, { type: 'hello', publisherId: state.publisherId });
    emit();
  }

  function connect(id) {
    if (links.has(id)) return true;
    try {
      const conn = peer.connect(id, { reliable: true, serialization: 'json' });
      if (conn) {
        attach(conn, true);
        return true;
      }
    } catch {
      // A browser may reject its ICE configuration when creating the data channel.
    }
    setStatus('error', '无法建立连接，请核对网络和 TURN 设置。');
    return false;
  }

  function tick(force = false) {
    if (!running) return;
    if (globalThis.navigator?.onLine === false) {
      if (status !== 'offline') setStatus('offline', '当前网络离线。');
      return;
    }
    if (!peer || peer.destroyed) {
      launch();
      return;
    }
    if (peer.disconnected) {
      try {
        setStatus('connecting', '正在重连信令服务。');
        peer.reconnect();
      } catch {
        setStatus('error', '信令服务重连失败。');
      }
      return;
    }
    for (const link of links.values()) {
      if (link.sent?.deadline < Date.now()) linkError(link, '未收到对方的导入确认，正在等待重连。');
      else if (!trustedLink(link) && link.deadline < Date.now()) {
        linkError(link, link.publisherId ? '等待配对确认超时。' : '未连接到对方网页，请确认对方在线。');
      }
    }
    if (!peer.open) return;
    for (const item of state.peers) {
      if (force || state.syncPeerId < item.id) connect(item.id);
    }
  }

  function launch() {
    if (!Peer) {
      setStatus('error', '同步组件暂不可用。');
      return;
    }
    setStatus('connecting', '正在连接信令服务。');
    let instance;
    try {
      instance = new Peer(state.syncPeerId, activeOptions);
    } catch {
      setStatus('error', '无法开启网页连接。');
      return;
    }
    peer = instance;
    const current = () => running && peer === instance;
    instance.on('open', () => {
      if (!current()) return;
      setStatus('ready', '网页在线，可以配对。');
      tick();
    });
    instance.on('connection', conn => {
      if (current()) attach(conn, false);
      else conn.close();
    });
    instance.on('disconnected', () => {
      if (current()) setStatus('offline', '信令连接断开，正在等待重连。');
    });
    instance.on('error', error => {
      if (!current()) return;
      if (error.type === 'peer-unavailable') {
        const id = error.message?.split(' ').at(-1);
        const link = links.get(id);
        if (link && !trustedLink(link)) linkError(link, '对方网页暂时离线。');
        return;
      }
      setStatus('error', '信令服务或浏览器连接失败，请重试。');
    });
  }

  async function start({ turn } = {}) {
    if (running) return;
    const options = connectionOptions(peerOptions, turn);
    const revision = ++generation;
    state = await store.update(current => {
      if (!current.syncPeerId) current.syncPeerId = `icc-${createId()}`;
      current.syncEnabled = true;
    });
    if (generation !== revision) return;
    activeOptions = options;
    running = true;
    timer = setInterval(tick, retryMs);
    tick();
  }

  async function stop() {
    ++generation;
    running = false;
    clearInterval(timer);
    for (const link of links.values()) closeLink(link);
    peer?.destroy();
    peer = undefined;
    activeOptions = undefined;
    peerDetails.clear();
    state = await store.update(current => { current.syncEnabled = false; });
    setStatus('disabled');
  }

  async function pair(id) {
    const code = id.trim().toLowerCase();
    if (!peerCode.test(code) || code === state?.syncPeerId) throw new Error('请填写同学的有效配对码。');
    if (!running || !peer?.open) throw new Error('请先开启同步并等网页上线。');
    ignored.delete(code);
    if (connect(code)) setStatus(status, '已发起连接，等双方确认配对。');
  }

  async function accept(id) {
    const link = links.get(id);
    if (!link?.publisherId) throw new Error('该请求已结束，请重新发起配对。');
    state = await store.update(current => {
      if (!running || links.get(id) !== link || !current.syncEnabled) throw new Error('配对连接已关闭。');
      if (current.peers.some(item => item.id !== id && item.publisherId === link.publisherId)) {
        throw new Error('该发布者已绑定到另一个配对码。');
      }
      if (!current.peers.some(item => item.id === id)) {
        current.peers.push({ id, publisherId: link.publisherId, pairedAt: new Date().toISOString() });
      }
    });
    send(link, { type: 'accept' });
    emit();
    await sendSelection(link);
  }

  function decline(id) {
    const link = links.get(id);
    if (!link) return;
    ignored.add(id);
    send(link, { type: 'decline' });
    closeLink(link);
    setStatus(status, '已结束本次配对。');
  }

  async function remove(id) {
    decline(id);
    ignored.add(id);
    state = await store.update(current => {
      current.peers = current.peers.filter(item => item.id !== id);
    });
    peerDetails.delete(id);
    emit();
  }

  async function broadcast() {
    await Promise.all([...links.values()].map(link => sendSelection(link)));
  }

  function retry() {
    tick(true);
  }

  return { start, stop, pair, accept, decline, remove, broadcast, retry, getSnapshot };
}
