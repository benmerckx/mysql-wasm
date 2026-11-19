import { access } from 'node:fs/promises';

for (const file of [
  'browser/mysqld.js',
  'mysqld.wasm',
  'browser/mysqld.data',
  'licenses/mysql-server.txt',
  'licenses/openssl.txt',
  'runtime_output_directory/package.json',
  'runtime_output_directory/mysqld.js',
  'share/english/errmsg.sys',
  'share/charsets/Index.xml',
  'lib/private/icudt77l/unames.icu',
]) {
  try {
    await access(new URL(`../dist/${file}`, import.meta.url));
  } catch {
    throw new Error(`Missing dist/${file}. Run ./scripts/stage-runtime after building mysqld.`);
  }
}
