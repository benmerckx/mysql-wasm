import { access, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readDatadir } from './datadir.mjs';

// macOS and Windows volumes are usually case-insensitive, where MySQL forces
// lower_case_table_names=2 and rejects the prebuilt data directory.
async function caseSensitive(path) {
  const probe = join(path, '.mysql-wasm-Case');
  await writeFile(probe, '');
  try {
    await access(join(path, '.mysql-wasm-case'));
    return false;
  } catch {
    return true;
  } finally {
    await rm(probe, { force: true });
  }
}

async function restore(path, entries) {
  for (const { path: name, size, chunks } of entries) {
    const target = join(path, name);
    if (size === null) {
      await mkdir(target);
      continue;
    }
    const file = await open(target, 'wx', 0o600);
    try {
      for (const [at, bytes] of chunks) await file.write(bytes, 0, bytes.length, at);
      await file.truncate(size);
    } finally {
      await file.close();
    }
  }
}

async function stale(lock) {
  // Version 0.1.0 locked with an ownerless directory.
  if ((await stat(lock)).isDirectory()) return true;
  const pid = Number(await readFile(lock, 'utf8'));
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

// The lock records its owner, so one left by a crashed process is taken over.
async function lock(path) {
  const target = join(path, '.mysql-wasm-lock');
  for (;;) {
    try {
      await writeFile(target, String(process.pid), { flag: 'wx', mode: 0o600 });
      return () => rm(target, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!(await stale(target))) throw new Error('MySQL data directory is already open');
      await rm(target, { recursive: true, force: true });
    }
  }
}

export function isEmpty(names) {
  return !names.some(name => !name.startsWith('.'));
}

// Locks a data directory and fills an empty one from `load` or the template.
export async function prepare(path, { load, template }) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const release = await lock(path);
  try {
    if (isEmpty(await readdir(path))) {
      if (load) await restore(path, await readDatadir(load));
      else if (await caseSensitive(path)) await restore(path, await readDatadir(await template()));
    } else if (load) {
      throw new Error('Cannot load a snapshot into an existing data directory');
    }
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}
