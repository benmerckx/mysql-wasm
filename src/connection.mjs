import { decodeResults, encodeRequest } from './protocol.mjs';

const empty = { rows: [], fields: [], affectedRows: 0, insertId: 0 };

export class Connection {
  #transport;
  #cleanup;
  #closing;
  #queue = Promise.resolve();

  constructor(transport, cleanup = () => {}) {
    this.#transport = transport;
    this.#cleanup = cleanup;
  }

  #check() {
    if (this.#closing) throw new Error('Database is closed');
  }

  // The server has one session, so calls run in order and a transaction holds
  // it until it ends. Calls made meanwhile wait, as they do in PGlite.
  #serial(run) {
    this.#check();
    const result = this.#queue.then(run);
    this.#queue = result.catch(() => {});
    return result;
  }

  async #run(mode, sql, params, rowMode) {
    if (typeof sql !== 'string') throw new TypeError('SQL must be a string');
    return decodeResults(await this.#transport.send(encodeRequest(mode, sql, params)), rowMode);
  }

  async #query(sql, params, options) {
    if (params !== undefined && !Array.isArray(params)) throw new TypeError('SQL parameters must be an array');
    const [result] = await this.#run(params === undefined ? 'q' : 'p', sql, params, options?.rowMode);
    return result ?? empty;
  }

  async #exec(sql) {
    if (typeof sql === 'string' && !sql.trim()) return [];
    return this.#run('e', sql);
  }

  query(sql, params, options) {
    return this.#serial(() => this.#query(sql, params, options));
  }

  sql(strings, ...params) {
    return this.query(strings.join('?'), params);
  }

  exec(sql) {
    if (arguments.length > 1) throw new TypeError('Use query() with parameters');
    return this.#serial(() => this.#exec(sql));
  }

  // Calling the database instead of `tx` inside the callback waits for the
  // transaction to end, so it never finishes.
  transaction(callback) {
    return this.#serial(async () => {
      let active = true;
      const check = () => {
        if (!active) throw new Error('Transaction has ended');
      };
      const tx = {
        query: async (sql, params, options) => (check(), this.#query(sql, params, options)),
        sql: (strings, ...params) => tx.query(strings.join('?'), params),
        exec: async sql => (check(), this.#exec(sql)),
      };
      await this.#query('START TRANSACTION');
      try {
        const result = await callback(tx);
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
    });
  }

  persist() {
    return this.#serial(async () => {
      await this.#query('FLUSH ENGINE LOGS');
      await this.#transport.persist?.();
    });
  }

  dump() {
    return this.#serial(() => {
      if (!this.#transport.dump) throw new Error('dump() is only available on MySQL, not MySQLProcess');
      return this.#transport.dump();
    });
  }

  close() {
    if (this.#closing) return this.#closing;
    const closing = this.#serial(() => this.#transport.close());
    this.#closing = closing.finally(this.#cleanup);
    return this.#closing;
  }
}

if (Symbol.asyncDispose) {
  Connection.prototype[Symbol.asyncDispose] = function () { return this.close(); };
}
