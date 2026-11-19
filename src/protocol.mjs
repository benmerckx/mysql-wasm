export const prefix = 'MYSQL_WASM\t';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const digits = '0123456789abcdef';

function toHex(bytes) {
  let hex = '';
  for (const byte of bytes) hex += digits[byte >> 4] + digits[byte & 15];
  return hex;
}

function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export function encodeRequest(mode, sql, params) {
  return [mode, toHex(encoder.encode(sql)), ...(params?.map(encodeParam) ?? [])].join('\t') + '\n';
}

export function queryError(message) {
  const error = new Error(message.error);
  if (message.errno) error.errno = message.errno;
  if (message.sqlstate) error.sqlstate = message.sqlstate;
  return error;
}

function encodeParam(value) {
  if (value === null) return 'n';
  if (typeof value === 'string') return 's' + toHex(encoder.encode(value));
  if (value instanceof Date) {
    return encodeParam(value.toISOString().slice(0, 23).replace('T', ' '));
  }
  if (value instanceof ArrayBuffer) return 'b' + toHex(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) {
    return 'b' + toHex(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (typeof value === 'boolean') value = BigInt(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('SQL numbers must be finite');
    if (Number.isSafeInteger(value)) value = BigInt(value);
    else {
      const data = new DataView(new ArrayBuffer(8));
      data.setFloat64(0, value, true);
      return 'd' + toHex(new Uint8Array(data.buffer));
    }
  }
  if (typeof value === 'bigint') {
    if (value < -(1n << 63n) || value >= (1n << 64n)) throw new RangeError('SQL integer is outside the 64-bit range');
    const data = new DataView(new ArrayBuffer(8));
    if (value > 0x7fff_ffff_ffff_ffffn) {
      data.setBigUint64(0, value, true);
      return 'u' + toHex(new Uint8Array(data.buffer));
    }
    data.setBigInt64(0, value, true);
    return 'i' + toHex(new Uint8Array(data.buffer));
  }
  throw new TypeError('Unsupported SQL parameter');
}

function decodeCell(value, field) {
  if (value === null) return null;
  const bytes = fromHex(value);
  const text = () => decoder.decode(bytes);
  switch (field.type) {
    case 1: case 2: case 3: case 4: case 5: case 9: case 13:
      return Number(text());
    case 8: {
      const s = text();
      const number = Number(s);
      return Number.isSafeInteger(number) ? number : s;
    }
    case 245:
      return JSON.parse(text());
    case 0: case 7: case 10: case 11: case 12: case 14: case 246:
      return text();
    default:
      return field.charset === 63 ? bytes : text();
  }
}

export function decodeResults(results) {
  return results.map(({ rows, fields, affectedRows }) => ({
    rows: rows.map(row => Object.fromEntries(
      fields.map((field, i) => [field.name, decodeCell(row[i], field)]),
    )),
    fields,
    affectedRows,
  }));
}
