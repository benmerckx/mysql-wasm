import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { directory, encodeDatadir, file, local } from '../src/datadir.mjs';
import { serverOptions } from '../src/options.mjs';

const [dist] = process.argv.slice(2);
// After a clean shutdown InnoDB recreates the doublewrite files and the spare
// redo files, which hold only stale log data and are most of the size.
const recreated = /^(.*\.dblwr|#ib_redo\d+_tmp)$/;

const scratch = await mkdtemp(join(tmpdir(), 'mysql-wasm-datadir-'));
try {
  const data = join(scratch, 'data');
  const result = spawnSync(process.execPath, [
    join(dist, 'runtime_output_directory/mysqld.js'),
    '--no-defaults', `--basedir=${dist}`, `--datadir=${data}`,
    `--lc-messages-dir=${join(dist, 'share')}`,
    `--character-sets-dir=${join(dist, 'share/charsets')}`,
    `--secure-file-priv=${scratch}`, `--tmpdir=${scratch}`,
    // Runtimes only use the template where MySQL picks this setting itself,
    // and MySQL refuses it outright on a case-insensitive build host.
    ...serverOptions, '--lower-case-table-names=0', '--initialize-insecure',
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
  if (result.status !== 0) throw new Error(`mysqld --initialize-insecure failed (${result.status})`);

  const entries = [];
  async function add(path, name) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (local.test(entry.name) || recreated.test(entry.name)) continue;
      const child = join(path, entry.name);
      const childName = name ? name + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        entries.push(directory(childName));
        await add(child, childName);
      } else {
        entries.push(file(childName, await readFile(child)));
      }
    }
  }
  await add(data, '');
  await writeFile(join(dist, 'datadir.data'), gzipSync(encodeDatadir(entries), { level: 9 }));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
