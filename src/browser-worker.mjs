import createEngine from '../dist/browser/mysqld.js';
import { readAssets } from './assets.mjs';
import { prefix, queryError } from './protocol.mjs';

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

function saveFiles(fs, root, path = '', files = []) {
  for (const entry of fs.readdir(root + path)) {
    if (entry === '.' || entry === '..') continue;
    const child = path + '/' + entry;
    if (fs.isDir(fs.stat(root + child).mode)) {
      files.push([child, null]);
      saveFiles(fs, root, child, files);
    } else {
      files.push([child, fs.readFile(root + child)]);
    }
  }
  return files;
}

function createRuntime() {
  const ready = Promise.withResolvers();
  const exited = Promise.withResolvers();
  const pending = [];
  ready.promise.catch(() => {});
  exited.promise.catch(() => {});
  let stderr = '';
  function fail(error) {
    ready.reject(error);
    exited.reject(error);
    for (const request of pending.splice(0)) request.reject(error);
  }
  const module = createEngine({
    noInitialRun: true,
    locateFile: (name, directory) => name === 'mysqld.wasm' ? wasmUrl : directory + name,
    print(line) {
      if (!line.startsWith(prefix)) return;
      try {
        const message = JSON.parse(line.slice(prefix.length));
        if (message.ready) ready.resolve();
        else {
          const request = pending.shift();
          if (!request) throw new Error('Unexpected MySQL response');
          if (message.error) request.reject(queryError(message));
          else request.resolve(message.results);
        }
      } catch (error) {
        fail(error);
      }
    },
    printErr(line) {
      stderr = (stderr + line + '\n').slice(-8192);
    },
    onExit(code) {
      if (code) {
        fail(new Error(`MySQL exited (${code})\n${stderr.trimEnd()}`));
      } else {
        ready.reject(new Error('MySQL exited before starting a session'));
        for (const request of pending.splice(0)) request.reject(new Error('MySQL exited'));
        exited.resolve();
      }
    },
    onAbort(reason) {
      fail(new Error(`MySQL aborted: ${reason}\n${stderr.trimEnd()}`));
    },
  });
  return {
    module,
    ready: ready.promise,
    exited: exited.promise,
    async send(frame) {
      const instance = await module;
      const request = Promise.withResolvers();
      pending.push(request);
      instance.ccall('mysql_wasm_submit', null, ['string'], [frame]);
      return request.promise;
    },
  };
}

async function openDatabase(dataDir) {
  const name = dataDir.startsWith('idb://') ? dataDir.slice(6) : null;
  if (dataDir !== 'memory://' && !name) {
    throw new TypeError('Browser dataDir must be memory:// or idb://name');
  }
  const release = name ? await holdStorageLock(name) : () => {};
  const directory = name ? '/db-' + encodeURIComponent(name) : '/db';
  const args = [
    '--no-defaults', '--user=root', '--basedir=/',
    `--datadir=${directory}`, '--lc-messages-dir=/share',
    '--character-sets-dir=/share/charsets',
    '--secure-file-priv=NULL', '--pid-file=/tmp/mysqld.pid',
    '--skip-networking', '--skip-log-bin',
    '--innodb-buffer-pool-size=33554432',
    '--innodb-read-io-threads=1', '--innodb-write-io-threads=1', '--innodb-purge-threads=1',
  ];
  async function prepare(assets) {
    const runtime = createRuntime();
    const [instance, files] = await Promise.all([runtime.module, assets]);
    const fs = instance.FS;
    for (const [path, bytes] of files) {
      fs.mkdirTree('/' + path.slice(0, path.lastIndexOf('/')));
      fs.writeFile('/' + path, bytes);
    }
    fs.mkdir(directory);
    if (name) {
      fs.mount(fs.filesystems.IDBFS, {}, directory);
      await sync(fs, true);
    }
    return { ...runtime, instance, fs };
  }

  try {
    const assets = fetchAssets();
    let engine = await prepare(assets);
    if (engine.fs.readdir(directory).length === 2) {
      engine.instance.callMain([...args, '--initialize-insecure']);
      await engine.exited;
      let files;
      if (name) await sync(engine.fs, false);
      else files = saveFiles(engine.fs, directory);
      engine = await prepare(assets);
      if (files) for (const [path, bytes] of files) {
        if (bytes === null) engine.fs.mkdir(directory + path);
        else engine.fs.writeFile(directory + path, bytes);
      }
    }
    engine.instance.callMain(args);
    await engine.ready;
    return {
      send: engine.send,
      persist: async () => { if (name) await sync(engine.fs, false); },
      async close() {
        try {
          engine.instance.ccall('mysql_wasm_finish', null, [], []);
          await engine.exited;
          if (name) await sync(engine.fs, false);
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
