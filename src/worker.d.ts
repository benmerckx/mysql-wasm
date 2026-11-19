import type { QueryResult, SqlParam, Transaction } from './index.js';

export interface MySQLWorkerOptions {
  /** A filesystem path or file:// URL. Omit or use memory:// for a temporary database. */
  dataDir?: string;
}

export class MySQLWorker implements Transaction {
  private constructor();
  static create(options?: MySQLWorkerOptions): Promise<MySQLWorker>;
  query<Row = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): Promise<QueryResult<Row>>;
  exec(sql: string): Promise<QueryResult[]>;
  transaction<T>(callback: (tx: Transaction) => Promise<T> | T): Promise<T>;
  persist(): Promise<void>;
  close(): Promise<void>;
}

export type { Field, QueryResult, SqlParam, Transaction } from './index.js';
