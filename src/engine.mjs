import { prefix, queryError } from './protocol.mjs';

const args = [
  '--no-defaults', '--user=root', '--basedir=/',
  '--lc-messages-dir=/share', '--character-sets-dir=/share/charsets',
  '--secure-file-priv=NULL', '--pid-file=/tmp/mysqld.pid',
  '--skip-networking', '--skip-log-bin',
  '--innodb-buffer-pool-size=33554432',
  '--innodb-read-io-threads=1', '--innodb-write-io-threads=1', '--innodb-purge-threads=1',
];

function createRuntime(createEngine, locateFile) {
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
    locateFile,
    // The session reads stdin in Node unless told to use the in-memory mailbox.
    preRun: [instance => { instance.ENV.MYSQL_WASM_MAILBOX = '1'; }],
    // Emscripten's Node default calls process.exit, which would end the host.
    quit(status, toThrow) { throw toThrow; },
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

// Dot entries include NODEFS lock directories, which are not MySQL data.
function isEmpty(fs, path) {
  return !fs.readdir(path).some(name => !name.startsWith('.'));
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

// Runs the server inside this JavaScript realm. `storage` mounts a persistent
// filesystem at the data directory, or is omitted for in-memory storage.
export async function openEngine({ createEngine, locateFile, assets, storage }) {
  const directory = storage?.directory ?? '/db';
  async function prepare() {
    const runtime = createRuntime(createEngine, locateFile);
    const [instance, files] = await Promise.all([runtime.module, assets]);
    const fs = instance.FS;
    for (const [path, bytes] of files) {
      fs.mkdirTree('/' + path.slice(0, path.lastIndexOf('/')));
      fs.writeFile('/' + path, bytes);
    }
    fs.mkdir(directory);
    if (storage) await storage.mount(fs, directory);
    return { ...runtime, instance, fs };
  }

  // A runtime cannot call main twice, so initialization uses its own instance.
  let engine = await prepare();
  const serverArgs = [...args, `--datadir=${directory}`];
  if (isEmpty(engine.fs, directory)) {
    engine.instance.callMain([...serverArgs, '--initialize-insecure']);
    await engine.exited;
    let files;
    if (storage) await storage.sync?.(engine.fs);
    else files = saveFiles(engine.fs, directory);
    engine = await prepare();
    if (files) for (const [path, bytes] of files) {
      if (bytes === null) engine.fs.mkdir(directory + path);
      else engine.fs.writeFile(directory + path, bytes);
    }
  }
  engine.instance.callMain(serverArgs);
  await engine.ready;
  return {
    send: engine.send,
    persist: async () => { await storage?.sync?.(engine.fs); },
    async close() {
      engine.instance.ccall('mysql_wasm_finish', null, [], []);
      await engine.exited;
      await storage?.sync?.(engine.fs);
    },
  };
}
