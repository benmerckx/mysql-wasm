import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [dist, source, build] = process.argv.slice(2);
const index = [];
const files = [];

async function addFile(path, name) {
  const bytes = await readFile(path);
  index.push([name, bytes.length]);
  files.push(bytes);
}

async function addDirectory(path, name) {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
    const childPath = join(path, entry.name);
    const childName = name + '/' + entry.name;
    if (entry.isDirectory()) await addDirectory(childPath, childName);
    else if (entry.isFile()) await addFile(childPath, childName);
    else throw new Error(`Unexpected runtime asset: ${childPath}`);
  }
}

await addFile(join(build, 'share/english/errmsg.sys'), 'share/english/errmsg.sys');
await addDirectory(join(source, 'share/charsets'), 'share/charsets');
await addDirectory(join(source, 'extra/icu/icudt77l'), 'lib/private/icudt77l');

const manifest = Buffer.from(JSON.stringify(index));
const header = Buffer.alloc(4);
header.writeUInt32LE(manifest.length);
await writeFile(join(dist, 'assets.data'), Buffer.concat([header, manifest, ...files]));
