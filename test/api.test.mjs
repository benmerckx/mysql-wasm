import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MySQL } from 'mysql-wasm';
import { MySQLProcess } from 'mysql-wasm/process';

test('MySQLProcess uses native parameters, executes scripts and persists InnoDB rows', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mysql-wasm-test-'));
  let db;
  try {
    db = await MySQLProcess.create({ dataDir });
    assert.equal((await db.query('SELECT VERSION() AS version')).rows[0].version, '9.7.4');
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
      str: payload, bytes: new Uint8Array([0, 255]), n: 9223372036854775807n,
      nil: null, fp: 3.25,
    }]);
    await assert.rejects(db.query('SELECT ?'), { errno: 1064 });
    await assert.rejects(db.query('SELECT ?', []), /parameter count/i);
    await assert.rejects(db.query('SELECT * FROM missing_table'), { errno: 1146, sqlstate: '42S02' });
    await assert.rejects(db.query("SELECT 1; INSERT INTO records VALUES (99,'unexpected')"));
    let waiting;
    await assert.rejects(db.transaction(async tx => {
      waiting = db.query('SELECT COUNT(*) AS n FROM records');
      await tx.query('INSERT INTO records VALUES (?, ?)', [2, 'rollback']);
      throw new Error('rollback marker');
    }), /rollback marker/);
    assert.deepEqual((await waiting).rows, [{ n: 1 }]);
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

    db = await MySQL.create({ dataDir });
    assert.deepEqual((await db.query('SELECT * FROM records ORDER BY id')).rows, [
      { id: 1, value: 'kept' }, { id: 3, value: payload },
    ]);
    await db.persist();
  } finally {
    await db?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('MySQL runs in this process and shares data with MySQLProcess', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mysql-wasm-test-'));
  let db;
  try {
    db = await MySQL.create();
    await db.exec('CREATE TABLE t (id INT PRIMARY KEY); INSERT INTO t VALUES (1), (2)');
    assert.deepEqual((await db.query('SELECT COUNT(*) AS n FROM t')).rows, [{ n: 2 }]);
    await db.close();

    db = await MySQL.create({ dataDir });
    await assert.rejects(MySQL.create({ dataDir }), /already open/);
    await db.transaction(tx => tx.query('CREATE TABLE t (id INT PRIMARY KEY, value TEXT)'));
    await db.query('INSERT INTO t VALUES (?, ?)', [1, 'worker']);
    await db.close();

    db = await MySQLProcess.create({ dataDir });
    assert.deepEqual((await db.query('SELECT * FROM t')).rows, [{ id: 1, value: 'worker' }]);
  } finally {
    await db?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('hashing, AES and random bytes work without TLS', async () => {
  const db = await MySQL.create();
  try {
    const { rows: [row] } = await db.query(`SELECT SHA2('abc', 256) AS sha2, SHA1('abc') AS sha1, MD5('abc') AS md5,
      CAST(AES_DECRYPT(AES_ENCRYPT('secret', 'key'), 'key') AS CHAR) AS aes,
      LENGTH(RANDOM_BYTES(16)) AS random, @@tls_version AS tls`);
    assert.deepEqual(row, {
      sha2: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      sha1: 'a9993e364706816aba3e25717850c26c9cd0d89d',
      md5: '900150983cd24fb0d6963f7d28e17f72',
      aes: 'secret', random: 16, tls: '',
    });
    await db.exec("CREATE USER reader IDENTIFIED BY 'secret'");
  } finally {
    await db.close();
  }
});

test('new databases start from the prebuilt data directory with their own identity', async () => {
  const uuids = [];
  for (let i = 0; i < 2; i++) {
    const db = await MySQL.create();
    try {
      const { rows: [row] } = await db.query('SELECT @@server_uuid AS uuid, @@lower_case_table_names AS names');
      assert.equal(row.names, 0);
      uuids.push(row.uuid);
    } finally {
      await db.close();
    }
  }
  assert.notEqual(uuids[0], uuids[1]);
});

test('results report insert ids, array rows and template queries', async () => {
  await using db = await MySQL.create();
  await db.exec('CREATE TABLE items (id INT AUTO_INCREMENT PRIMARY KEY, n BIGINT)');
  assert.equal((await db.query('INSERT INTO items (n) VALUES (?)', [5])).insertId, 1);
  assert.equal((await db.sql`INSERT INTO items (n) VALUES (${2n ** 60n})`).insertId, 2);
  assert.deepEqual((await db.sql`SELECT id, n FROM items WHERE id > ${0} ORDER BY id`).rows, [
    { id: 1, n: 5 }, { id: 2, n: 2n ** 60n },
  ]);
  assert.deepEqual((await db.query('SELECT 1 AS x, 2 AS x', undefined, { rowMode: 'array' })).rows, [[1, 2]]);
});

test('dump and load copy a database', async () => {
  const source = await MySQL.create();
  await source.exec("CREATE TABLE notes (id INT PRIMARY KEY, body TEXT); INSERT INTO notes VALUES (1, 'kept')");
  const snapshot = await source.dump();
  await source.close();

  const dataDir = await mkdtemp(join(tmpdir(), 'mysql-wasm-test-'));
  try {
    const copy = await MySQL.create({ load: snapshot });
    assert.deepEqual((await copy.query('SELECT * FROM notes')).rows, [{ id: 1, body: 'kept' }]);
    await copy.close();
    await (await MySQL.create({ dataDir })).close();
    await assert.rejects(MySQL.create({ load: snapshot, dataDir }), /existing data directory/);
    const child = await MySQLProcess.create();
    await assert.rejects(child.dump(), /only available/);
    await child.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a lock left by a crashed process is taken over', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'mysql-wasm-test-'));
  try {
    await writeFile(join(dataDir, '.mysql-wasm-lock'), '999999');
    const db = await MySQL.create({ dataDir });
    await db.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('objects with the default definer can be used', async () => {
  await using db = await MySQL.create();
  await db.exec(`CREATE TABLE t (id INT);
    CREATE VIEW v AS SELECT * FROM t;
    CREATE FUNCTION bump(x INT) RETURNS INT DETERMINISTIC RETURN x + 1;
    CREATE TRIGGER copy BEFORE INSERT ON t FOR EACH ROW SET NEW.id = bump(NEW.id);
    INSERT INTO t VALUES (1)`);
  assert.deepEqual((await db.query('SELECT id FROM v')).rows, [{ id: 2 }]);
  assert.deepEqual((await db.query('SELECT CURRENT_USER() AS user')).rows, [{ user: 'root@localhost' }]);
});

test('updates report matched and changed rows', async () => {
  await using db = await MySQL.create();
  await db.exec('CREATE TABLE t (id INT PRIMARY KEY, n INT); INSERT INTO t VALUES (1, 1), (2, 2)');
  const update = await db.query('UPDATE t SET n = 1');
  assert.equal(update.affectedRows, 2);
  assert.equal(update.changedRows, 1);
  assert.equal((await db.query('INSERT INTO t VALUES (3, 3)')).changedRows, 0);
  assert.equal((await db.query('DELETE FROM t')).changedRows, 0);
});

test('large values and tables survive the 32-bit build', async () => {
  await using db = await MySQL.create();
  const blob = new Uint8Array(16 << 20).map((_, i) => i * 31);
  await db.exec('CREATE TABLE big (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, data LONGBLOB)');
  await db.query('INSERT INTO big VALUES (?, ?)', [2n ** 63n, blob]);
  const { rows: [row] } = await db.query('SELECT id, data, LENGTH(data) AS size FROM big');
  assert.equal(row.id, 2n ** 63n);
  assert.equal(row.size, blob.length);
  assert.ok(Buffer.from(row.data).equals(blob));
  assert.equal((await db.query('INSERT INTO big (data) VALUES (NULL)')).insertId, 2n ** 63n + 1n);
  await db.exec(`SET cte_max_recursion_depth = 300000;
    CREATE TABLE n (i INT PRIMARY KEY, v BIGINT);
    INSERT INTO n WITH RECURSIVE s (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 300000)
      SELECT i, i * 4294967296 FROM s`);
  const { rows: [sum] } = await db.query('SELECT COUNT(*) AS c, SUM(v) AS s, MAX(v) AS m FROM n');
  assert.deepEqual(sum, { c: 300000, s: String(300000n * 300001n / 2n * 4294967296n), m: 300000 * 4294967296 });
});
