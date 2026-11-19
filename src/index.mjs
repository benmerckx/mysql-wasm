import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { prefix, queryError } from './protocol.mjs';
import { Connection } from './connection.mjs';

const defaultBuild = fileURLToPath(new URL('../dist/', import.meta.url));

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
      const args = [
        '--no-defaults',
        `--basedir=${root}`,
        ...(process.getuid?.() === 0 ? ['--user=root'] : []),
        `--datadir=${data}`,
        `--lc-messages-dir=${join(root, 'share')}`,
        `--character-sets-dir=${join(root, 'share', 'charsets')}`,
        `--secure-file-priv=${scratch}`,
        `--tmpdir=${scratch}`,
        `--pid-file=${join(scratch, 'mysqld.pid')}`,
        '--skip-networking', '--skip-log-bin',
        '--innodb-buffer-pool-size=33554432',
        '--innodb-read-io-threads=1', '--innodb-write-io-threads=1', '--innodb-purge-threads=1',
      ];
      if (!(await readdir(data)).some(name => !name.startsWith('.'))) {
        await launch(server, [...args, '--initialize-insecure'], true).exit;
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
