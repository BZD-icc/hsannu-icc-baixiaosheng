// Replaces the PeerJS script in isolated browser contexts during the local test.
// The application, IndexedDB and sync protocol still run normally in both pages.
(() => {
  let activePeer;

  class Events {
    handlers = new Map();

    on(name, handler) {
      const listeners = this.handlers.get(name) ?? [];
      listeners.push(handler);
      this.handlers.set(name, listeners);
    }

    emit(name, data) {
      for (const handler of this.handlers.get(name) ?? []) handler(data);
    }
  }

  class TestConnection extends Events {
    open = false;

    constructor(owner, peer, id) {
      super();
      this.owner = owner;
      this.peer = peer;
      this.id = id;
    }

    send(data) {
      if (!this.open) throw new Error('Test connection is closed');
      this.owner.send('data', this, data).catch(error => this.emit('error', error));
    }

    finish() {
      this.open = false;
      this.owner.connections.delete(this.id);
      this.emit('close');
    }

    close() {
      this.finish();
      this.owner.send('close', this).catch(error => this.emit('error', error));
    }
  }

  class TestPeer extends Events {
    open = false;
    disconnected = false;
    destroyed = false;
    connections = new Map();

    constructor(id, options) {
      super();
      this.id = id;
      this.options = options;
      activePeer = this;
      this.reconnect();
    }

    send(type, connection, data) {
      return globalThis.testPeerRelay({ type, from: this.id, to: connection?.peer, id: connection?.id, data });
    }

    connect(to) {
      const connection = new TestConnection(this, to, crypto.randomUUID());
      this.connections.set(connection.id, connection);
      this.send('connect', connection).then(connected => {
        if (!connected) {
          this.emit('error', { type: 'peer-unavailable', message: `No peer with code ${to}` });
        }
      }).catch(error => this.emit('error', error));
      return connection;
    }

    reconnect() {
      this.send('register', undefined, this.options).then(() => {
        if (!this.destroyed) {
          this.open = true;
          this.disconnected = false;
          this.emit('open', this.id);
        }
      }).catch(error => this.emit('error', error));
    }

    destroy() {
      this.open = false;
      this.destroyed = true;
      for (const connection of this.connections.values()) connection.close();
      this.send('unregister').catch(error => this.emit('error', error));
    }
  }

  globalThis.receiveTestPeerFrame = ({ type, from, id, data }) => {
    if (!activePeer || activePeer.destroyed) return;
    if (type === 'incoming') {
      const connection = new TestConnection(activePeer, from, id);
      activePeer.connections.set(id, connection);
      activePeer.emit('connection', connection);
      return;
    }
    const connection = activePeer.connections.get(id);
    if (!connection) return;
    if (type === 'ready') connection.open = true;
    else if (type === 'open') connection.emit('open');
    else if (type === 'data') connection.emit('data', data);
    else if (type === 'close') connection.finish();
  };

  globalThis.peerjs = { Peer: TestPeer };
})();
