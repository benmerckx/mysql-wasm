/** MySQL column type codes, as reported in `Field.type`. */
export declare const types: {
  readonly decimal: 0; readonly tiny: 1; readonly short: 2; readonly long: 3;
  readonly float: 4; readonly double: 5; readonly null: 6; readonly timestamp: 7;
  readonly longlong: 8; readonly int24: 9; readonly date: 10; readonly time: 11;
  readonly datetime: 12; readonly year: 13; readonly newdate: 14; readonly varchar: 15;
  readonly bit: 16; readonly vector: 242; readonly json: 245; readonly newdecimal: 246;
  readonly enum: 247; readonly set: 248; readonly tinyBlob: 249; readonly mediumBlob: 250;
  readonly longBlob: 251; readonly blob: 252; readonly varString: 253; readonly string: 254;
  readonly geometry: 255;
};
export declare const binary: 63;

export type SqlParam = string | number | bigint | boolean | null | Date | ArrayBuffer | ArrayBufferView;

export interface Field {
  name: string;
  /** One of `types`. */
  type: number;
  charset: number;
  flags: number;
}

export interface QueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  fields: Field[];
  affectedRows: number;
  /** The AUTO_INCREMENT value of the last inserted row, or 0. */
  insertId: number | bigint;
}

export interface QueryOptions {
  /** Rows as arrays keep columns that share a name. */
  rowMode?: 'object' | 'array';
}

export interface Transaction {
  query<Row extends unknown[] = unknown[]>(
    sql: string, params: readonly SqlParam[] | undefined, options: { rowMode: 'array' },
  ): Promise<QueryResult<Row>>;
  query<Row = Record<string, unknown>>(
    sql: string, params?: readonly SqlParam[], options?: QueryOptions,
  ): Promise<QueryResult<Row>>;
  sql<Row = Record<string, unknown>>(strings: TemplateStringsArray, ...params: SqlParam[]): Promise<QueryResult<Row>>;
  exec(sql: string): Promise<QueryResult[]>;
}

export interface Database extends Transaction {
  /** Calls made on the database meanwhile wait for the transaction to end. */
  transaction<T>(callback: (tx: Transaction) => Promise<T> | T): Promise<T>;
  persist(): Promise<void>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface CreateOptions {
  /** A snapshot from `dump()` to start an empty data directory from. */
  load?: Uint8Array;
}
