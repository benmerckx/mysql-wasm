import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { prefix, queryError } from './protocol.mjs';
import { Connection } from './connection.mjs';
import { readAssets } from './assets.mjs';
import { readDatadir } from './datadir.mjs';
import { caseSensitive, restore } from './disk.mjs';
import { serverOptions } from './options.mjs';

const defaultBuild = fileURLToPath(new URL('../dist/', import.meta.url));

async function prepareAssets(root, scratch) {
  let bundle;
  try {
    bundle = await readFile(join(root, 'assets.data'));
  } catch (error) {
    if (error.code === 'ENOENT') return root; // Existing build directories have loose assets.
    throw error;
  }
  const basedir = join(scratch, 'runtime');
  for (const [path, bytes] of readAssets(bundle)) {
    const target = join(basedir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  return basedir;
}

function launch(server, args, initialization = false) {
  const child = spawn(process.execPath, [server, ...args], {
    stdio: [initialization ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (part) => {
    stderr = (stderr + part).slice(-8192);
  });
  const ready = Promise.withResolvers();
  const finished = Promise.withResolvers();
  const pending = [];
  // Consumers await either startup or exit at different points in the lifecycle.
  ready.promise.catch(() => {});
  finished.promise.catch(() => {});
  let closing = initialization;
  let failure;
  function fail(error) {
    failure ??= error;
    ready.reject(failure);
    for (const request of pending.splice(0)) request.reject(failure);
  }
  child.on('error', fail);
  child.stdin?.on('error', fail);
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
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
  });
  child.once('close', (code, signal) => {
    if (code !== 0 || !closing) {
      fail(new Error(`MySQL exited (${signal ?? code})${stderr ? '\n' + stderr.trimEnd() : ''}`));
    } else if (pending.length) {
      fail(new Error('MySQL exited with requests pending'));
    }
    if (failure) finished.reject(failure);
    else finished.resolve();
  });

  return {
    ready: ready.promise,
    exit: finished.promise,
    send(frame) {
      if (failure) return Promise.reject(failure);
      const request = Promise.withResolvers();
      pending.push(request);
      child.stdin.write(frame);
      return request.promise;
    },
    async close() {
      closing = true;
      child.stdin.end();
      await finished.promise;
    },
  };
}

export class MySQL extends Connection {
  static async create({ dataDir, buildDir = defaultBuild } = {}) {
    if (dataDir?.startsWith('idb://')) throw new TypeError('IndexedDB requires a browser');
    const root = resolve(buildDir);
    const path = dataDir?.startsWith('file://') ? fileURLToPath(dataDir) : dataDir;
    const scratch = await mkdtemp(join(tmpdir(), 'mysql-wasm-'));
    const server = join(root, 'runtime_output_directory', 'mysqld.js');
    const data = path && path !== 'memory://' ? resolve(path) : join(scratch, 'data');
    const lock = join(data, '.mysql-wasm-lock');
    let locked = false;
    let child;
    async function cleanup() {
      try {
        if (locked) await rm(lock, { recursive: true });
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }
    try {
      await mkdir(data, { recursive: true, mode: 0o700 });
      await mkdir(lock, { mode: 0o700 });
      locked = true;
      const basedir = await prepareAssets(root, scratch);
      const args = [
        '--no-defaults',
        `--basedir=${basedir}`,
        ...(process.getuid?.() === 0 ? ['--user=root'] : []),
        `--datadir=${data}`,
        `--lc-messages-dir=${join(basedir, 'share')}`,
        `--character-sets-dir=${join(basedir, 'share', 'charsets')}`,
        `--secure-file-priv=${scratch}`,
        `--tmpdir=${scratch}`,
        `--pid-file=${join(scratch, 'mysqld.pid')}`,
        ...serverOptions,
      ];
      if (!(await readdir(data)).some(name => !name.startsWith('.'))) {
        if (await caseSensitive(data)) {
          await restore(data, await readDatadir(await readFile(join(root, 'datadir.data'))));
        } else {
          await launch(server, [...args, '--initialize-insecure'], true).exit;
        }
      }
      child = launch(server, args);
      await child.ready;
      const db = new MySQL(child, cleanup);
      await db.exec('CREATE DATABASE IF NOT EXISTS test; USE test');
      return db;
    } catch (error) {
      if (child) await child.close().catch(() => {});
      await cleanup();
      throw error;
    }
  }
}
