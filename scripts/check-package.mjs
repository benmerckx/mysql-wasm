import { access, readFile } from 'node:fs/promises';
import { readAssets } from '../src/assets.mjs';

for (const file of [
  'browser/mysqld.js',
  'mysqld.wasm',
  'assets.data',
  'datadir.data',
  'licenses/mysql-server.txt',
  'licenses/openssl.txt',
  'runtime_output_directory/package.json',
  'runtime_output_directory/mysqld.js',
]) {
  try {
    await access(new URL(`../dist/${file}`, import.meta.url));
  } catch {
    throw new Error(`Missing dist/${file}. Run ./scripts/stage-runtime after building mysqld.`);
  }
}

const files = readAssets(await readFile(new URL('../dist/assets.data', import.meta.url)));
for (const name of ['share/english/errmsg.sys', 'share/charsets/Index.xml', 'lib/private/icudt77l/unames.icu']) {
  if (!files.get(name)?.length) throw new Error(`Missing ${name} in dist/assets.data.`);
}
