import { Connection } from './connection.mjs';
import { queryError } from './protocol.mjs';

export { types } from './types.mjs';

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

// Runs MySQL in a dedicated worker, keeping the page responsive.
export class MySQL extends Connection {
  static async create({ dataDir = 'memory://', load } = {}) {
    if (!globalThis.crossOriginIsolated) {
      throw new Error('MySQL requires a cross-origin isolated page');
    }
    const worker = openWorker();
    try {
      await worker.call('create', { dataDir, load });
      const db = new MySQL({
        send: (frame) => worker.call('query', frame),
        dump: () => worker.call('dump'),
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
