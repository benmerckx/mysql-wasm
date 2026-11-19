import { access, mkdir, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// macOS and Windows volumes are usually case-insensitive, where MySQL forces
// lower_case_table_names=2 and rejects the prebuilt data directory.
export async function caseSensitive(path) {
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

export async function restore(path, entries) {
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
