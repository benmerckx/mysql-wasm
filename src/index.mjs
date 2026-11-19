import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readAssets } from './assets.mjs';
import { Connection } from './connection.mjs';
import { prepare } from './disk.mjs';
import { openEngine } from './engine.mjs';

export { types } from './types.mjs';

const dist = new URL('../dist/', import.meta.url);
const template = () => readFile(new URL('datadir.data', dist));

function nodeFileSystem(path) {
  return {
    mount(fs, directory) {
      fs.mount(fs.filesystems.NODEFS, { root: path }, directory);
    },
  };
}

// Runs MySQL in this process, on worker threads, like the browser build.
export class MySQL extends Connection {
  static async create({ dataDir = 'memory://', load } = {}) {
    if (dataDir.startsWith('idb://')) throw new TypeError('IndexedDB requires a browser');
    const { default: createEngine } = await import(new URL('browser/mysqld.js', dist));
    const path = dataDir === 'memory://' ? null
      : resolve(dataDir.startsWith('file://') ? fileURLToPath(dataDir) : dataDir);
    // Emscripten's threads do not keep Node alive while the server waits.
    const alive = setInterval(() => {}, 1 << 30);
    let release;
    async function cleanup() {
      clearInterval(alive);
      await release?.();
    }
    try {
      // Restoring here rather than through NODEFS keeps the files sparse.
      if (path) release = await prepare(path, { load, template });
      const engine = await openEngine({
        createEngine,
        locateFile: file => fileURLToPath(new URL(file === 'mysqld.wasm' ? file : 'browser/' + file, dist)),
        assets: readFile(new URL('assets.data', dist)).then(readAssets),
        storage: path ? nodeFileSystem(path) : undefined,
        load: path ? undefined : load,
        template: path ? undefined : template,
      });
      const db = new MySQL(engine, cleanup);
      try {
        await db.exec('CREATE DATABASE IF NOT EXISTS test; USE test');
        return db;
      } catch (error) {
        await db.close().catch(() => {});
        throw error;
      }
    } catch (error) {
      await cleanup();
      throw error;
    }
  }
}
