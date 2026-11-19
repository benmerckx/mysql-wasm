// A prebuilt data directory skips `--initialize-insecure` on first start.
// The gzip stream holds a little-endian uint32 manifest size, UTF-8 JSON
// [path, size, [[offset, length], ...]] entries and the chunks in order.
// A null size marks a directory; files are sparse outside their chunks.
export async function readDatadir(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const data = new Uint8Array(await new Response(stream).arrayBuffer());
  const invalid = () => new Error('Invalid MySQL data directory template');
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
      entries.push({ path, size, chunks: [] });
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
