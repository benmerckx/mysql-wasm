import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readAssets } from './assets.mjs';
import { Connection } from './connection.mjs';
import { readDatadir } from './datadir.mjs';
import { caseSensitive, restore } from './disk.mjs';
import { openEngine } from './engine.mjs';

const dist = new URL('../dist/', import.meta.url);
const datadir = () => readFile(new URL('datadir.data', dist)).then(readDatadir);

function nodeFileSystem(path) {
  return {
    mount(fs, directory) {
      fs.mount(fs.filesystems.NODEFS, { root: path }, directory);
    },
  };
}

// Runs MySQL in this process, on worker threads, like the browser build.
export class MySQLWorker extends Connection {
  static async create({ dataDir = 'memory://' } = {}) {
    if (dataDir.startsWith('idb://')) throw new TypeError('IndexedDB requires a browser');
    const { default: createEngine } = await import(new URL('browser/mysqld.js', dist));
    const path = dataDir === 'memory://' ? null
      : resolve(dataDir.startsWith('file://') ? fileURLToPath(dataDir) : dataDir);
    const lock = path && resolve(path, '.mysql-wasm-lock');
    // Emscripten's threads do not keep Node alive while the server waits.
    const alive = setInterval(() => {}, 1 << 30);
    let locked = false;
    async function cleanup() {
      clearInterval(alive);
      if (!locked) return;
      locked = false;
      await rm(lock, { recursive: true });
    }
    try {
      if (path) {
        await mkdir(path, { recursive: true, mode: 0o700 });
        await mkdir(lock, { mode: 0o700 });
        locked = true;
        // Writing it here rather than through NODEFS keeps the files sparse.
        if (!(await readdir(path)).some(name => !name.startsWith('.')) && await caseSensitive(path)) {
          await restore(path, await datadir());
        }
      }
      const engine = await openEngine({
        createEngine,
        locateFile: file => fileURLToPath(new URL(file === 'mysqld.wasm' ? file : 'browser/' + file, dist)),
        assets: readFile(new URL('assets.data', dist)).then(readAssets),
        storage: path ? nodeFileSystem(path) : undefined,
        datadir: path ? undefined : datadir,
      });
      const db = new MySQLWorker(engine, cleanup);
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
