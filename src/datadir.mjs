// Data directory snapshots: the prebuilt template and `dump()` output.
// The gzip stream holds a little-endian uint32 manifest size, UTF-8 JSON
// [path, size, [[offset, length], ...]] entries and the chunks in order.
// A null size marks a directory; files are sparse outside their chunks.
const block = 4096;

// Files a new server creates for itself, so snapshots leave them out.
export const local = /^(auto\.cnf|ibtmp1|#innodb_temp|.*\.pem|\..*)$/;

export function directory(path) {
  return { path, size: null, chunks: [] };
}

export function file(path, bytes) {
  const chunks = [];
  for (let at = 0; at < bytes.length; at += block) {
    const end = Math.min(at + block, bytes.length);
    if (!bytes.subarray(at, end).some(byte => byte)) continue;
    const last = chunks.at(-1);
    if (last && last[0] + last[1].length === at) last[1] = bytes.subarray(last[0], end);
    else chunks.push([at, bytes.subarray(at, end)]);
  }
  return { path, size: bytes.length, chunks };
}

export function encodeDatadir(entries) {
  const manifest = new TextEncoder().encode(JSON.stringify(entries.map(({ path, size, chunks }) =>
    [path, size, chunks.map(([at, bytes]) => [at, bytes.length])])));
  const parts = entries.flatMap(entry => entry.chunks.map(([, bytes]) => bytes));
  const data = new Uint8Array(4 + manifest.length + parts.reduce((total, part) => total + part.length, 0));
  new DataView(data.buffer).setUint32(0, manifest.length, true);
  data.set(manifest, 4);
  let offset = 4 + manifest.length;
  for (const part of parts) data.set(part, offset), offset += part.length;
  return data;
}

export async function writeDatadir(entries) {
  const stream = new Blob([encodeDatadir(entries)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readDatadir(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const data = new Uint8Array(await new Response(stream).arrayBuffer());
  const invalid = () => new Error('Invalid MySQL data directory snapshot');
  if (data.length < 4) throw invalid();
  let offset = 4 + new DataView(data.buffer, 0, 4).getUint32(0, true);
  if (offset > data.length) throw invalid();
  const manifest = JSON.parse(new TextDecoder().decode(data.subarray(4, offset)));
  if (!Array.isArray(manifest)) throw invalid();
  const entries = [];
  for (const [path, size, chunks] of manifest) {
    if (typeof path !== 'string' || !path.split('/').every(part =>
      part !== '.' && part !== '..' && /^[\w#.@$-]+$/.test(part))) throw invalid();
    if (size === null) {
      entries.push(directory(path));
      continue;
    }
    if (!Number.isSafeInteger(size) || !Array.isArray(chunks)) throw invalid();
    entries.push({
      path, size,
      chunks: chunks.map(([at, length]) => {
        if (!Number.isSafeInteger(at) || !Number.isSafeInteger(length) ||
            at < 0 || length < 0 || at + length > size || offset + length > data.length) throw invalid();
        return [at, data.subarray(offset, offset += length)];
      }),
    });
  }
  if (offset !== data.length) throw invalid();
  return entries;
}
