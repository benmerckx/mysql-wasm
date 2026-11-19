import type { Database } from './types.js';
import type { MySQLOptions } from './index.js';

export type { MySQLOptions } from './index.js';

/** Runs MySQL in a child Node process, isolated from the host's memory and crashes. */
export interface MySQLProcess extends Database {}
export declare class MySQLProcess {
  private constructor();
  static create(options?: MySQLOptions): Promise<MySQLProcess>;
}
