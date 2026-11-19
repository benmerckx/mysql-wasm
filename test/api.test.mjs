import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MySQL } from 'mysql-wasm';
import { MySQLWorker } from 'mysql-wasm/worker';

test('MySQL uses native parameters, executes scripts and persists InnoDB rows', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mysql-wasm-test-'));
  let db;
  try {
    db = await MySQL.create({ dataDir });
    assert.equal((await db.query('SELECT VERSION() AS version')).rows[0].version, '8.4.13');
    const [ddl, write, select] = await db.exec(
      "CREATE TABLE records (id BIGINT PRIMARY KEY, value VARCHAR(128)) ENGINE=InnoDB; INSERT INTO records VALUES (1,'kept'); SELECT id FROM records;",
    );
    assert.equal(ddl.affectedRows, 0);
    assert.equal(write.affectedRows, 1);
    assert.deepEqual(select.rows, [{ id: 1 }]);
    const payload = "emoji 😀, quote ' and NUL\0";
    const statement = await db.query('SELECT ? AS str, ? AS bytes, ? AS n, ? AS nil, ? AS fp', [
      payload, new Uint8Array([0, 255]), 9223372036854775807n, null, 3.25,
    ]);
    assert.deepEqual(statement.rows, [{
      str: payload, bytes: new Uint8Array([0, 255]), n: '9223372036854775807',
      nil: null, fp: 3.25,
    }]);
    await assert.rejects(db.query('SELECT ?'), { errno: 1064 });
    await assert.rejects(db.query('SELECT ?', []), /parameter count/i);
    await assert.rejects(db.query('SELECT * FROM missing_table'), { errno: 1146, sqlstate: '42S02' });
    await assert.rejects(db.query("SELECT 1; INSERT INTO records VALUES (99,'unexpected')"));
    await assert.rejects(db.transaction(async tx => {
      await assert.rejects(db.query('SELECT 1'), /active transaction/);
      await tx.query('INSERT INTO records VALUES (?, ?)', [2, 'rollback']);
      throw new Error('rollback marker');
    }), /rollback marker/);
    await db.transaction(tx => tx.query('INSERT INTO records VALUES (?, ?)', [3, payload]));
    const results = await Promise.all([db.query('SELECT 1 AS n'), db.query('SELECT 2 AS n')]);
    assert.deepEqual(results.map(result => result.rows[0].n), [1, 2]);
    assert.deepEqual((await db.query("SELECT REGEXP_LIKE('abc', '^a') AS matched")).rows, [{ matched: 1 }]);
    const types = await db.query(
      "SELECT CAST(_latin1 0xe9 AS CHAR CHARACTER SET latin1) AS word, CAST(1.40 AS DECIMAL(4,2)) AS exact, JSON_OBJECT('key',42) AS j",
    );
    assert.deepEqual(types.rows, [{ word: 'é', exact: '1.40', j: { key: 42 } }]);
    const persist = db.persist();
    await Promise.all([persist, db.close()]);

    db = await MySQLWorker.create({ dataDir });
    assert.deepEqual((await db.query('SELECT * FROM records ORDER BY id')).rows, [
      { id: 1, value: 'kept' }, { id: 3, value: payload },
    ]);
    await db.persist();
  } finally {
    await db?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
