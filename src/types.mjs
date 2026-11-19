// MySQL column type codes, as reported in `Field.type`.
export const types = Object.freeze({
  decimal: 0, tiny: 1, short: 2, long: 3, float: 4, double: 5, null: 6,
  timestamp: 7, longlong: 8, int24: 9, date: 10, time: 11, datetime: 12,
  year: 13, newdate: 14, varchar: 15, bit: 16, vector: 242, json: 245,
  newdecimal: 246, enum: 247, set: 248, tinyBlob: 249, mediumBlob: 250,
  longBlob: 251, blob: 252, varString: 253, string: 254, geometry: 255,
});

// Binary strings and blobs carry this charset instead of a text one.
export const binary = 63;
