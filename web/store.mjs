import { createId } from './core.mjs';

const stateStore = 'state';
const attachmentStore = 'attachments';
const stateKey = 'workspace';

function openDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    let blocked = false;
    request.onblocked = () => {
      blocked = true;
      reject(new Error('请关闭此资料库的其他标签页后重试。'));
    };
    request.onupgradeneeded = () => {
      if (blocked) {
        request.transaction.abort();
        return;
      }
      const db = request.result;
      const state = db.createObjectStore(stateStore);
      db.createObjectStore(attachmentStore);
      state.put({
        publisherId: createId(),
        records: [],
        published: [],
        peers: [],
        syncEnabled: false,
        model: { endpoint: '', model: '' },
      }, stateKey);
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      if (blocked) db.close();
      else resolve(db);
    };
  });
}

function transact(db, name, mode, start, finish = value => value) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(name, mode);
    const store = transaction.objectStore(name);
    let result;
    let failure;
    const abort = error => {
      failure = error;
      transaction.abort();
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(failure || transaction.error || new Error('资料库操作已取消。'));

    let request;
    try {
      request = start(store);
    } catch (error) {
      abort(error);
      return;
    }
    request.onsuccess = () => {
      try {
        result = finish(request.result, store);
      } catch (error) {
        abort(error);
      }
    };
  });
}

function requireState(state) {
  if (!state) throw new Error('无法读取本机资料库状态。');
  return state;
}

export async function openStore(name = 'hsannu-icc-v1') {
  const db = await openDatabase(name);
  const getState = store => store.get(stateKey);
  return {
    read() {
      return transact(db, stateStore, 'readonly', getState, requireState);
    },
    update(mutator) {
      return transact(db, stateStore, 'readwrite', getState, (state, store) => {
        const result = mutator(requireState(state));
        if (typeof result?.then === 'function') {
          Promise.resolve(result).catch(() => {});
          throw new Error('资料库更新函数须同步执行。');
        }
        const { endpoint, model } = state.model ?? {};
        state.model = {
          endpoint: typeof endpoint === 'string' ? endpoint : '',
          model: typeof model === 'string' ? model : '',
        };
        const saved = structuredClone(state);
        store.put(saved, stateKey);
        return saved;
      });
    },
    async putAttachment(key, file) {
      if (!(file instanceof Blob)) throw new Error('请提供有效的本地附件。');
      return transact(db, attachmentStore, 'readwrite', store => store.put(file, key));
    },
    getAttachment(key) {
      return transact(db, attachmentStore, 'readonly', store => store.get(key));
    },
    deleteAttachment(key) {
      return transact(db, attachmentStore, 'readwrite', store => store.delete(key));
    },
  };
}
