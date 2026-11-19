// The bundle starts with a little-endian uint32 manifest size, followed by
// UTF-8 JSON [path, size] pairs and the corresponding files in order.
export function readAssets(bytes) {
  const invalid = () => new Error('Invalid MySQL runtime asset bundle');
  if (bytes.length < 4) throw invalid();
  const manifestSize = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  let offset = 4 + manifestSize;
  if (offset > bytes.length) throw invalid();
  const manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(4, offset)));
  if (!Array.isArray(manifest)) throw invalid();
  const files = new Map();
  for (const entry of manifest) {
    if (!Array.isArray(entry) || entry.length !== 2) throw invalid();
    const [path, size] = entry;
    if (typeof path !== 'string' ||
        !/^(share|lib\/private)(\/[\w-]+(?:\.[\w-]+)*)+$/.test(path) ||
        files.has(path) || !Number.isSafeInteger(size) || size < 0 ||
        size > bytes.length - offset) throw invalid();
    files.set(path, bytes.subarray(offset, offset + size));
    offset += size;
  }
  if (offset !== bytes.length) throw invalid();
  return files;
}
