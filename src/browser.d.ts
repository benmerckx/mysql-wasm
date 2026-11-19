import type { QueryResult, SqlParam, Transaction } from './index.js';

export interface MySQLOptions {
  /** Temporary storage by default, or IndexedDB when set to idb://name. */
  dataDir?: 'memory://' | `idb://${string}`;
}

export class MySQLWorker implements Transaction {
  private constructor();
  static create(options?: MySQLOptions): Promise<MySQLWorker>;
  query<Row = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): Promise<QueryResult<Row>>;
  exec(sql: string): Promise<QueryResult[]>;
  transaction<T>(callback: (tx: Transaction) => Promise<T> | T): Promise<T>;
  persist(): Promise<void>;
  close(): Promise<void>;
}

export { MySQLWorker as MySQL };
export type { Field, QueryResult, SqlParam, Transaction } from './index.js';
