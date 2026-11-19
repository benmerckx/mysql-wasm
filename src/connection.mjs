import { decodeResults, encodeRequest } from './protocol.mjs';

export class Connection {
  #process;
  #cleanup;
  #closing;
  #persisting;
  #transaction = false;

  constructor(transport, cleanup = () => {}) {
    this.#process = transport;
    this.#cleanup = cleanup;
  }

  #checkAvailable() {
    if (this.#closing) throw new Error('Database is closed');
    if (this.#transaction) throw new Error('Use the active transaction');
  }

  async #run(mode, sql, params) {
    if (typeof sql !== 'string') throw new TypeError('SQL must be a string');
    return decodeResults(await this.#process.send(encodeRequest(mode, sql, params)));
  }

  async #query(sql, params) {
    if (params !== undefined && !Array.isArray(params)) throw new TypeError('SQL parameters must be an array');
    const [result] = await this.#run(params === undefined ? 'q' : 'p', sql, params);
    return result ?? { rows: [], fields: [], affectedRows: 0 };
  }

  async query(sql, params) {
    this.#checkAvailable();
    return this.#query(sql, params);
  }

  async exec(sql) {
    this.#checkAvailable();
    if (arguments.length > 1) throw new TypeError('Use query() with parameters');
    return this.#exec(sql);
  }

  async #exec(sql) {
    if (typeof sql === 'string' && !sql.trim()) return [];
    return this.#run('e', sql);
  }

  async transaction(callback) {
    this.#checkAvailable();
    this.#transaction = true;
    let active = true;
    const checkActive = () => {
      if (!active) throw new Error('Transaction has ended');
    };
    try {
      await this.#persisting;
      await this.#query('START TRANSACTION');
      try {
        const result = await callback({
          query: async (sql, params) => { checkActive(); return this.#query(sql, params); },
          exec: async (sql) => { checkActive(); return this.#exec(sql); },
        });
        active = false;
        await this.#query('COMMIT');
        return result;
      } catch (error) {
        active = false;
        try {
          await this.#query('ROLLBACK');
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'MySQL transaction and rollback failed');
        }
        throw error;
      }
    } finally {
      this.#transaction = false;
    }
  }

  async persist() {
    this.#checkAvailable();
    const previous = this.#persisting;
    const pending = this.#persisting = (async () => {
      await previous?.catch(() => {});
      await this.#query('FLUSH ENGINE LOGS');
      await this.#process.persist?.();
    })();
    try {
      await pending;
    } finally {
      if (this.#persisting === pending) this.#persisting = undefined;
    }
  }

  async close() {
    if (this.#closing) return this.#closing;
    this.#checkAvailable();
    this.#closing = (async () => {
      try {
        await this.#persisting;
      } finally {
        await this.#process.close();
      }
    })().finally(this.#cleanup);
    return this.#closing;
  }
}
