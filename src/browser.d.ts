import type { CreateOptions, Database } from './types.js';

export { types } from './types.js';
export type { CreateOptions, Database, Field, QueryOptions, QueryResult, SqlParam, Transaction } from './types.js';

export interface MySQLOptions extends CreateOptions {
  /** Temporary storage by default, or IndexedDB when set to idb://name. */
  dataDir?: 'memory://' | `idb://${string}`;
}

/** Runs MySQL in a dedicated worker. */
export interface MySQL extends Database {
  /** A crash-consistent snapshot of the data directory, for `load`. */
  dump(): Promise<Uint8Array>;
}
export declare class MySQL {
  private constructor();
  static create(options?: MySQLOptions): Promise<MySQL>;
}
