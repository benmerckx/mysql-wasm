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
    const namedCharacter = await db.query("SELECT REGEXP_LIKE('α', ?) AS matched", [
      String.raw`\N{GREEK SMALL LETTER ALPHA}`,
    ]);
    assert.deepEqual(namedCharacter.rows, [{ matched: 1 }]);
    const regex = await db.query(
      `SELECT REGEXP_LIKE(?, ?, 'i') AS case_folded,
              REGEXP_LIKE(?, ?) AS word_boundary,
              REGEXP_LIKE(?, ?) AS dictionary_boundary,
              REGEXP_REPLACE(?, ?, ?) AS replaced,
              REGEXP_SUBSTR(?, ?) AS grapheme,
              REGEXP_INSTR(?, ?) AS position,
              REGEXP_LIKE(?, ?) AS unicode_property`,
      [
        'ΚαληΜΈΡΑ', '^καλημέρα$',
        '!猫!', String.raw`\b猫\b`,
        'ภาษาไทย', String.raw`(?w)\bไทย\b`,
        '東京-42', String.raw`\p{Nd}+`, '数',
        '👩🏽‍💻x', String.raw`^\X`,
        'é猫x', '猫',
        'क', String.raw`^\p{Indic_Syllabic_Category=Consonant}$`,
      ],
    );
    assert.deepEqual(regex.rows, [{
      case_folded: 1,
      word_boundary: 1,
      dictionary_boundary: 1,
      replaced: '東京-数',
      grapheme: '👩🏽‍💻',
      position: 2,
      unicode_property: 1,
    }]);
    assert.deepEqual((await db.query('SELECT CONVERT(_greek 0xE1 USING utf8mb4) AS word')).rows, [{ word: 'α' }]);
    const types = await db.query(
      "SELECT CAST(_latin1 0xe9 AS CHAR CHARACTER SET latin1) AS word, CAST(1.40 AS DECIMAL(4,2)) AS exact, JSON_OBJECT('key',42) AS j",
    );
    assert.deepEqual(types.rows, [{ word: 'é', exact: '1.40', j: { key: 42 } }]);
    const references = await db.query(
      'SELECT SRS_ID AS id FROM information_schema.ST_SPATIAL_REFERENCE_SYSTEMS ORDER BY SRS_ID',
    );
    assert.deepEqual(references.rows, [{ id: 0 }, { id: 3857 }, { id: 4326 }]);
    await db.exec(
      'CREATE TABLE places (id INT PRIMARY KEY, geom POINT NOT NULL SRID 0, SPATIAL INDEX(geom)) ENGINE=InnoDB; INSERT INTO places VALUES (1, POINT(1, 2));',
    );
    assert.deepEqual((await db.query('SELECT id FROM places WHERE geom IS NOT NULL')).rows, [{ id: 1 }]);
    await assert.rejects(db.query('SELECT ST_DISTANCE(POINT(0, 0), POINT(1, 1))'), { errno: 1305 });
    await assert.rejects(db.query('SELECT MBRCONTAINS(POINT(0, 0), POINT(1, 1))'), { errno: 1305 });
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

test('MySQLWorker runs in this process and shares data with MySQL', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mysql-wasm-test-'));
  let db;
  try {
    db = await MySQLWorker.create();
    await db.exec('CREATE TABLE t (id INT PRIMARY KEY); INSERT INTO t VALUES (1), (2)');
    assert.deepEqual((await db.query('SELECT COUNT(*) AS n FROM t')).rows, [{ n: 2 }]);
    await db.close();

    db = await MySQLWorker.create({ dataDir });
    await assert.rejects(MySQLWorker.create({ dataDir }), /EEXIST/);
    await db.transaction(tx => tx.query('CREATE TABLE t (id INT PRIMARY KEY, value TEXT)'));
    await db.query('INSERT INTO t VALUES (?, ?)', [1, 'worker']);
    await db.close();

    db = await MySQL.create({ dataDir });
    assert.deepEqual((await db.query('SELECT * FROM t')).rows, [{ id: 1, value: 'worker' }]);
  } finally {
    await db?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
