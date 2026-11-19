import { directory, file, local, readDatadir, writeDatadir } from './datadir.mjs';
import { serverOptions } from './options.mjs';
import { prefix, queryError } from './protocol.mjs';

const args = [
  '--no-defaults', '--user=root', '--basedir=/',
  '--lc-messages-dir=/share', '--character-sets-dir=/share/charsets',
  '--secure-file-priv=NULL', '--pid-file=/tmp/mysqld.pid',
  ...serverOptions,
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

function restore(fs, root, entries) {
  for (const { path, size, chunks } of entries) {
    if (size === null) {
      fs.mkdir(root + '/' + path);
      continue;
    }
    const bytes = new Uint8Array(size);
    for (const [at, chunk] of chunks) bytes.set(chunk, at);
    fs.writeFile(root + '/' + path, bytes);
  }
}

// Server threads proxy every filesystem call to this thread, so reading the
// files synchronously sees one point in time. The result is crash-consistent
// and InnoDB recovers it on load like any crash.
function snapshot(fs, root, path = '', entries = []) {
  for (const name of fs.readdir(root + '/' + path)) {
    if (name === '.' || name === '..' || local.test(name)) continue;
    const child = path ? path + '/' + name : name;
    if (fs.isDir(fs.stat(root + '/' + child).mode)) {
      entries.push(directory(child));
      snapshot(fs, root, child, entries);
    } else {
      entries.push(file(child, fs.readFile(root + '/' + child)));
    }
  }
  return entries;
}

// Runs the server inside this JavaScript realm. `storage` mounts a persistent
// filesystem at the data directory, or is omitted for in-memory storage. An
// empty data directory is filled from `load`, a snapshot from `dump()`, or the
// prebuilt `template`, which needs a case-sensitive filesystem like the
// in-memory and IndexedDB ones.
export async function openEngine({ createEngine, locateFile, assets, storage, load, template }) {
  const root = storage?.directory ?? '/db';
  async function prepare() {
    const runtime = createRuntime(createEngine, locateFile);
    const [instance, files] = await Promise.all([runtime.module, assets]);
    const fs = instance.FS;
    for (const [path, bytes] of files) {
      fs.mkdirTree('/' + path.slice(0, path.lastIndexOf('/')));
      fs.writeFile('/' + path, bytes);
    }
    fs.mkdir(root);
    if (storage) await storage.mount(fs, root);
    return { ...runtime, instance, fs };
  }

  let engine = await prepare();
  const serverArgs = [...args, `--datadir=${root}`];
  const empty = isEmpty(engine.fs, root);
  if (load && !empty) throw new Error('Cannot load a snapshot into an existing data directory');
  if (empty && (load || template)) {
    restore(engine.fs, root, await readDatadir(load ?? await template()));
  } else if (empty) {
    // A runtime cannot call main twice, so initialization uses its own instance.
    engine.instance.callMain([...serverArgs, '--initialize-insecure']);
    await engine.exited;
    const files = storage ? null : snapshot(engine.fs, root);
    if (storage) await storage.sync?.(engine.fs);
    engine = await prepare();
    if (files) restore(engine.fs, root, files);
  }
  engine.instance.callMain(serverArgs);
  await engine.ready;
  return {
    async send(frame) {
      const results = await engine.send(frame);
      storage?.changed?.(engine.fs);
      return results;
    },
    dump: () => writeDatadir(snapshot(engine.fs, root)),
    persist: async () => { await storage?.sync?.(engine.fs); },
    async close() {
      engine.instance.ccall('mysql_wasm_finish', null, [], []);
      await engine.exited;
      await storage?.sync?.(engine.fs);
    },
  };
}
