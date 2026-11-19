import { binary, types } from './types.mjs';

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
    case types.tiny: case types.short: case types.long: case types.float:
    case types.double: case types.int24: case types.year:
      return Number(text());
    case types.longlong:
      return integer(text());
    case types.json:
      return JSON.parse(text());
    case types.decimal: case types.newdecimal: case types.timestamp: case types.date:
    case types.time: case types.datetime: case types.newdate:
      return text();
    default:
      return field.charset === binary ? bytes : text();
  }
}

// Like PGlite's int8: a number when exact, otherwise a bigint.
function integer(text) {
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : BigInt(text);
}

export function decodeResults(results, rowMode = 'object') {
  return results.map(({ rows, fields, affectedRows, insertId }) => {
    const cells = rows.map(row => fields.map((field, i) => decodeCell(row[i], field)));
    return {
      rows: rowMode === 'array' ? cells
        : cells.map(row => Object.fromEntries(fields.map((field, i) => [field.name, row[i]]))),
      fields,
      affectedRows,
      insertId: integer(insertId),
    };
  });
}
