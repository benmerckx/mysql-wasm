export type SqlParam = string | number | bigint | boolean | null | Date | ArrayBuffer | ArrayBufferView;

export interface Field {
  name: string;
  type: number;
  charset: number;
  flags: number;
}

export interface QueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  fields: Field[];
  affectedRows: number;
}

export interface Transaction {
  query<Row = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): Promise<QueryResult<Row>>;
  exec(sql: string): Promise<QueryResult[]>;
}

export interface MySQLOptions {
  /** A filesystem path. Omit for a temporary database. */
  dataDir?: string;
  /** Directory containing the staged runtime and its data files. */
  buildDir?: string;
}

export class MySQL implements Transaction {
  private constructor();
  static create(options?: MySQLOptions): Promise<MySQL>;
  query<Row = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): Promise<QueryResult<Row>>;
  exec(sql: string): Promise<QueryResult[]>;
  transaction<T>(callback: (tx: Transaction) => Promise<T> | T): Promise<T>;
  persist(): Promise<void>;
  close(): Promise<void>;
}
