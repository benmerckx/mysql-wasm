import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { serverOptions } from '../src/options.mjs';

const [dist] = process.argv.slice(2);
const block = 4096;
// Each server generates its own UUID, TLS material and temporary tablespaces.
const skip = /^(auto\.cnf|ibtmp1|#innodb_temp|.*\.pem)$/;

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

  const manifest = [];
  const chunks = [];
  async function add(path, name) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (skip.test(entry.name)) continue;
      const child = join(path, entry.name);
      const childName = name ? name + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        manifest.push([childName, null, []]);
        await add(child, childName);
        continue;
      }
      const bytes = await readFile(child);
      const ranges = [];
      for (let at = 0; at < bytes.length; at += block) {
        if (!bytes.subarray(at, at + block).some(byte => byte)) continue;
        const end = Math.min(at + block, bytes.length);
        const last = ranges.at(-1);
        if (last && last[0] + last[1] === at) last[1] = end - last[0];
        else ranges.push([at, end - at]);
      }
      manifest.push([childName, bytes.length, ranges]);
      for (const [at, length] of ranges) chunks.push(bytes.subarray(at, at + length));
    }
  }
  await add(data, '');
  const header = Buffer.alloc(4);
  const json = Buffer.from(JSON.stringify(manifest));
  header.writeUInt32LE(json.length);
  await writeFile(join(dist, 'datadir.data'), gzipSync(Buffer.concat([header, json, ...chunks]), { level: 9 }));
} finally {
  await rm(scratch, { recursive: true, force: true });
}
