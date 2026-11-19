export const rowsTable = 'CREATE TABLE writes (id INT PRIMARY KEY, label VARCHAR(32) NOT NULL, value INT NOT NULL)';
export const ping = 'SELECT 1 AS n';

export function insertSQL(engine) {
  const params = engine.startsWith('mysql') ? '?, ?, ?' : '$1, $2, $3';
  return `INSERT INTO writes (id, label, value) VALUES (${params})`;
}

export async function insertRows(db, engine, count) {
  const sql = insertSQL(engine);
  for (let id = 1; id <= count; id++) {
    await db.query(sql, [id, 'small row', id]);
  }
}

export async function checkCount(db, table, expected) {
  const { rows: [row] } = await db.query(`SELECT COUNT(*) AS n FROM ${table}`);
  if (Number(row.n) !== expected) throw new Error(`Unexpected row count in ${table}: ${row.n}`);
}

function sequence(digits) {
  const terms = Array.from({ length: digits }, (_, i) => `d${i}.n * ${10 ** i}`);
  const tables = Array.from({ length: digits }, (_, i) => `digits d${i}`);
  return `SELECT 1 + ${terms.join(' + ')} AS id FROM ${tables.join(' CROSS JOIN ')}`;
}

export async function seed(db) {
  await db.exec(`
    CREATE TABLE digits (n INT PRIMARY KEY);
    INSERT INTO digits VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9);
    CREATE TABLE parents (id INT PRIMARY KEY, label VARCHAR(32) NOT NULL, value INT NOT NULL);
    CREATE TABLE children (
      id INT PRIMARY KEY,
      parent_id INT NOT NULL,
      bucket INT NOT NULL,
      value INT NOT NULL
    );
    CREATE INDEX children_parent_id ON children (parent_id);
    ALTER TABLE children ADD CONSTRAINT children_parent_fk FOREIGN KEY (parent_id) REFERENCES parents(id);
    INSERT INTO parents SELECT id, 'small row', id FROM (${sequence(4)}) numbers ORDER BY id;
    INSERT INTO children
      SELECT id, MOD(id - 1, 10000) + 1, MOD(id - 1, 100), id FROM (${sequence(5)}) numbers ORDER BY id;
    DROP TABLE digits;
  `);
}

export async function scan(db) {
  const { rows: [count] } = await db.query('SELECT COUNT(*) AS n FROM children');
  const { rows: [sum] } = await db.query('SELECT SUM(value) AS total FROM children');
  const { rows: buckets } = await db.query(`
    SELECT bucket, COUNT(*) AS n, SUM(value) AS total FROM children GROUP BY bucket ORDER BY bucket
  `);
  return { count, sum, buckets };
}

export function checkScan({ count, sum, buckets }) {
  const total = 5_000_050_000;
  if (Number(count.n) !== 100_000 || Number(sum.total) !== total ||
      buckets.length !== 100 || buckets.some((row, i) =>
        row.bucket !== i || Number(row.n) !== 1000 || Number(row.total) !== 49_951_000 + i * 1000)) {
    throw new Error('Unexpected scan result');
  }
}

export function summarize(samples) {
  const sorted = samples.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    min: sorted[0],
    max: sorted.at(-1),
    samples,
  };
}
