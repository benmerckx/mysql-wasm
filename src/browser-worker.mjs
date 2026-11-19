import createEngine from '../dist/browser/mysqld.js';
import { readAssets } from './assets.mjs';
import { openEngine } from './engine.mjs';

const wasmUrl = new URL('../dist/mysqld.wasm', import.meta.url).href;

async function fetchAssets() {
  const response = await fetch(new URL('../dist/assets.data', import.meta.url));
  if (!response.ok) throw new Error(`Could not load MySQL runtime assets (HTTP ${response.status})`);
  return readAssets(new Uint8Array(await response.arrayBuffer()));
}

function sync(fs, populate) {
  return new Promise((resolve, reject) => {
    fs.syncfs(populate, error => error ? reject(error) : resolve());
  });
}

async function holdStorageLock(name) {
  const acquired = Promise.withResolvers();
  const release = Promise.withResolvers();
  navigator.locks.request('mysql-wasm:' + name, { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('MySQL data directory is already open');
    acquired.resolve();
    await release.promise;
  }).catch(acquired.reject);
  await acquired.promise;
  return release.resolve;
}

function indexedDB(name) {
  return {
    // IDBFS names its IndexedDB database after the mount path.
    directory: '/db-' + encodeURIComponent(name),
    async mount(fs, directory) {
      fs.mount(fs.filesystems.IDBFS, {}, directory);
      await sync(fs, true);
    },
    sync: fs => sync(fs, false),
  };
}

async function openDatabase(dataDir) {
  const name = dataDir.startsWith('idb://') ? dataDir.slice(6) : null;
  if (dataDir !== 'memory://' && !name) {
    throw new TypeError('Browser dataDir must be memory:// or idb://name');
  }
  const release = name ? await holdStorageLock(name) : () => {};
  try {
    const engine = await openEngine({
      createEngine,
      locateFile: (file, directory) => file === 'mysqld.wasm' ? wasmUrl : directory + file,
      assets: fetchAssets(),
      storage: name ? indexedDB(name) : undefined,
    });
    return {
      ...engine,
      async close() {
        try {
          await engine.close();
        } finally {
          release();
        }
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}

let database;
self.onmessage = async ({ data: { id, op, value } }) => {
  try {
    let results;
    if (op === 'create') database = await openDatabase(value);
    else if (op === 'query') results = await database.send(value);
    else if (op === 'persist') await database.persist();
    else if (op === 'close') await database.close();
    else throw new Error('Unknown MySQL worker operation');
    self.postMessage({ id, results });
  } catch (error) {
    self.postMessage({ id, error: error.message, errno: error.errno, sqlstate: error.sqlstate });
  }
};
