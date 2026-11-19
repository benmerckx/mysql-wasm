import { Connection } from './connection.mjs';
import { queryError } from './protocol.mjs';

function openWorker() {
  const worker = new Worker(new URL('./browser-worker.mjs', import.meta.url), { type: 'module' });
  let sequence = 0;
  let failure;
  const pending = new Map();
  function fail(error) {
    failure ??= error;
    for (const request of pending.values()) request.reject(failure);
    pending.clear();
    worker.terminate();
  }
  worker.addEventListener('error', event => fail(new Error(event.message || 'MySQL worker failed')));
  worker.addEventListener('messageerror', () => fail(new Error('Could not read MySQL worker message')));
  worker.addEventListener('message', ({ data }) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(queryError(data));
    else request.resolve(data.results);
  });
  return {
    async call(op, value) {
      if (failure) throw failure;
      const id = ++sequence;
      const request = Promise.withResolvers();
      pending.set(id, request);
      try {
        worker.postMessage({ id, op, value });
      } catch (error) {
        pending.delete(id);
        throw error;
      }
      return request.promise;
    },
    terminate() { fail(new Error('MySQL worker is closed')); },
  };
}

export class MySQLWorker extends Connection {
  static async create({ dataDir = 'memory://' } = {}) {
    if (!globalThis.crossOriginIsolated) {
      throw new Error('MySQL requires a cross-origin isolated page');
    }
    const worker = openWorker();
    try {
      await worker.call('create', dataDir);
      const db = new MySQLWorker({
        send: (frame) => worker.call('query', frame),
        persist: () => worker.call('persist'),
        close: () => worker.call('close'),
      }, worker.terminate);
      try {
        await db.exec('CREATE DATABASE IF NOT EXISTS test; USE test');
        return db;
      } catch (error) {
        await db.close().catch(() => {});
        throw error;
      }
    } catch (error) {
      worker.terminate();
      throw error;
    }
  }
}

export { MySQLWorker as MySQL };
