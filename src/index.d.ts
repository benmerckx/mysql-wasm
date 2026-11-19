import type { CreateOptions, Database } from './types.js';

export { types } from './types.js';
export type { CreateOptions, Database, Field, QueryOptions, QueryResult, SqlParam, Transaction } from './types.js';

export interface MySQLOptions extends CreateOptions {
  /** A filesystem path or file:// URL. Omit or use memory:// for a temporary database. */
  dataDir?: string;
}

/** Runs MySQL in this process, on worker threads. */
export interface MySQL extends Database {
  /** A crash-consistent snapshot of the data directory, for `load`. */
  dump(): Promise<Uint8Array>;
}
export declare class MySQL {
  private constructor();
  static create(options?: MySQLOptions): Promise<MySQL>;
}
