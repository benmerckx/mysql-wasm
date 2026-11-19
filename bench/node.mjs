import assert from 'node:assert/strict';
import { execFile, fork } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { cpus, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { checkCount, checkScan, insertRows, ping, rowsTable, scan, seed, summarize } from './workload.mjs';

const exec = promisify(execFile);

async function load(engine) {
  if (engine === 'mysql') {
    const { MySQL } = await import('mysql-wasm');
    return dataDir => MySQL.create({ dataDir });
  }
  if (engine === 'mysql-process') {
    const { MySQLProcess } = await import('mysql-wasm/process');
    return dataDir => MySQLProcess.create({ dataDir });
  }
  const { PGlite } = await import('@electric-sql/pglite');
  return dataDir => PGlite.create({ dataDir, relaxedDurability: false });
}

async function timed(operation) {
  const start = performance.now();
  const result = await operation();
  return [performance.now() - start, result];
}

async function settings(db, engine) {
  if (engine.startsWith('mysql')) {
    await db.exec('SET GLOBAL innodb_flush_log_at_trx_commit = 2');
    const { rows: [row] } = await db.query(`SELECT VERSION() AS version,
      @@global.innodb_flush_log_at_trx_commit AS commit_flush,
      @@global.innodb_flush_log_at_timeout AS flush_interval,
      @@global.innodb_flush_method AS flush_method,
      @@global.innodb_buffer_pool_size AS buffer_pool, @@global.log_bin AS log_bin`);
    assert.equal(Number(row.commit_flush), 2);
    return row;
  }
  const { rows: [row] } = await db.query(`SELECT version(),
    current_setting('fsync') AS fsync,
    current_setting('synchronous_commit') AS synchronous_commit,
    current_setting('full_page_writes') AS full_page_writes,
    current_setting('shared_buffers') AS shared_buffers`);
  assert.equal(row.fsync, 'off');
  return row;
}

async function workloads(db, engine) {
  const config = await settings(db, engine);
  await db.exec(rowsTable);
  const [single] = await timed(() => insertRows(db, engine, 1000));
  await checkCount(db, 'writes', 1000);
  await db.exec('TRUNCATE TABLE writes');
  const [batch] = await timed(() => db.transaction(tx => insertRows(tx, engine, 10_000)));
  await checkCount(db, 'writes', 10_000);
  await seed(db);

  const param = engine.startsWith('mysql') ? '?' : '$1';
  const ids = Array.from({ length: 1000 }, (_, i) => 1 + (i * 7919) % 10_000);
  const [lookup, rows] = await timed(async () => {
    const found = [];
    for (const id of ids) {
      const { rows: [row] } = await db.query(`SELECT id, label, value FROM parents WHERE id = ${param}`, [id]);
      found.push(row);
    }
    return found;
  });
  assert.deepEqual(rows, ids.map(id => ({ id, label: 'small row', value: id })));

  const [aggregate, aggregates] = await timed(() => scan(db));
  checkScan(aggregates);

  const [joinTime, joined] = await timed(() => db.query(`
    SELECT COUNT(*) AS n, SUM(c.value + p.value) AS total
    FROM parents p JOIN children c ON p.id = c.parent_id
  `));
  assert.equal(Number(joined.rows[0].n), 100_000);
  assert.equal(Number(joined.rows[0].total), 5_500_100_000);
  return { single, batch, lookup, aggregate, join: joinTime, settings: config };
}

async function worker(engine, scenario, dataDir) {
  const start = performance.now();
  const open = await load(engine);
  const db = await open(dataDir);
  try {
    const first = await db.query(ping);
    const cold = performance.now() - start;
    assert.equal(Number(first.rows[0].n), 1);

    if (scenario === 'prepare-reopen') {
      await db.exec(`${rowsTable}; INSERT INTO writes VALUES (1, 'persistent', 1)`);
      return null;
    }
    if (scenario === 'reopen') await checkCount(db, 'writes', 1);
    if (scenario === 'workloads') return await workloads(db, engine);
    if (scenario === 'rss') {
      await new Promise(resolve => {
        process.once('message', resolve);
        process.send({ rss: 'ready' });
      });
      checkScan(await scan(db));
      await new Promise(resolve => {
        process.once('message', resolve);
        process.send({ rss: 'done' });
      });
      return null;
    }
    return { cold };
  } finally {
    await db.close();
  }
}

async function rssMiB(pid) {
  const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,rss=']);
  const tree = new Map();
  const sizes = new Map();
  for (const line of stdout.trim().split('\n')) {
    const [id, parent, rss] = line.trim().split(/\s+/).map(Number);
    sizes.set(id, rss);
    const children = tree.get(parent) ?? [];
    children.push(id);
    tree.set(parent, children);
  }
  function sum(id) {
    return (sizes.get(id) ?? 0) + (tree.get(id) ?? []).reduce((total, child) => total + sum(child), 0);
  }
  return sum(pid) / 1024;
}

function run(engine, scenario, dataDir) {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), [engine, scenario, dataDir]);
    let result;
    let peak = 0;
    let timer;
    let sampling = Promise.resolve();
    let samplingActive = false;
    const sample = async () => { peak = Math.max(peak, await rssMiB(child.pid)); };
    const failSampling = error => {
      child.kill();
      reject(error);
    };
    child.on('message', message => {
      if (message.rss === 'ready') {
        sampling = sample();
        sampling.then(() => {
          timer = setInterval(() => {
            if (samplingActive) return;
            samplingActive = true;
            sampling = sample().finally(() => { samplingActive = false; });
            sampling.catch(failSampling);
          }, 10);
          child.send('scan');
        }).catch(failSampling);
      } else if (message.rss === 'done') {
        clearInterval(timer);
        sampling.then(sample).then(() => child.send('close')).catch(failSampling);
      } else {
        result = message.result;
      }
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearInterval(timer);
      if (code !== 0 || result === undefined) {
        reject(new Error(`${engine} ${scenario} failed (${signal ?? code})`));
      } else {
        resolve(scenario === 'rss' ? peak : result);
      }
    });
  });
}

async function main(trials) {
  if (!Number.isInteger(trials) || trials < 1) throw new Error('Usage: node bench/node.mjs [positive trial count]');
  const root = await mkdtemp(join(tmpdir(), 'wasm-db-bench-'));
  const engines = ['mysql', 'mysql-process', 'pglite'];
  const output = Object.fromEntries(engines.map(engine => [engine, { samples: {}, settings: null }]));
  const record = (engine, scenario, sample) => (output[engine].samples[scenario] ??= []).push(sample);
  try {
    for (const engine of engines) {
      const path = join(root, `${engine}-existing`);
      await mkdir(path);
      await run(engine, 'prepare-reopen', path);
    }
    for (let i = 1; i <= trials; i++) {
      for (const engine of i % 2 ? engines : engines.toReversed()) {
        console.error(`Trial ${i}/${trials} ${engine}`);
        record(engine, 'coldMemory', (await run(engine, 'cold', 'memory://')).cold);
        const fresh = join(root, `${engine}-fresh-${i}`);
        await mkdir(fresh);
        record(engine, 'coldPersistent', (await run(engine, 'cold', fresh)).cold);
        record(engine, 'coldReopen', (await run(engine, 'reopen', join(root, `${engine}-existing`))).cold);
        const dataDir = join(root, `${engine}-workloads-${i}`);
        await mkdir(dataDir);
        const { settings: config, ...results } = await run(engine, 'workloads', dataDir);
        output[engine].settings = config;
        for (const [name, ms] of Object.entries(results)) record(engine, name, ms);
        record(engine, 'scanPeakRssMiB', await run(engine, 'rss', dataDir));
        await rm(dataDir, { recursive: true });
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  return {
    machine: { cpu: cpus()[0].model, cores: cpus().length, memoryBytes: totalmem(), platform: process.platform, release: release(), arch: process.arch },
    node: process.version,
    trials,
    engines: Object.fromEntries(engines.map(engine => [engine, {
      settings: output[engine].settings,
      results: Object.fromEntries(Object.entries(output[engine].samples).map(([name, samples]) => [name, summarize(samples)])),
    }])),
  };
}

if (process.send) {
  const result = await worker(...process.argv.slice(2));
  process.send({ result }, () => process.disconnect());
} else {
  console.log(JSON.stringify(await main(Number(process.argv[2] ?? 5)), null, 2));
}
