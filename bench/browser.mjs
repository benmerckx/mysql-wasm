import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompress, constants } from 'node:zlib';
import { summarize } from './workload.mjs';

const trials = Number(process.argv[2] ?? 5);
if (!Number.isInteger(trials) || trials < 1) throw new Error('Usage: node bench/browser.mjs [positive trial count]');
const playwright = process.env.PLAYWRIGHT_CORE;
const { chromium } = await import(playwright ? pathToFileURL(playwright).href : 'playwright-core');
const root = new URL('../', import.meta.url);
const pglite = pathToFileURL(dirname(fileURLToPath(import.meta.resolve('@electric-sql/pglite'))) + '/');
const mime = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm' };
const engines = ['mysql', 'pglite'];
const files = Object.fromEntries(engines.map(engine => [engine, new Map()]));

const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cache-Control', 'no-store');
  if (path === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Wasm database benchmark</title>');
    return;
  }
  const route = [
    ['/pglite/', pglite, 'pglite'],
    ['/src/', new URL('src/', root), 'mysql'],
    ['/dist/', new URL('dist/', root), 'mysql'],
  ].find(([prefix]) => path.startsWith(prefix));
  let file;
  let engine;
  if (route) {
    const [prefix, scope, owner] = route;
    file = new URL(path.slice(prefix.length), scope);
    if (!file.href.startsWith(scope.href)) {
      response.writeHead(404).end();
      return;
    }
    engine = owner;
  } else if (path === '/bench/workload.mjs') {
    file = new URL('bench/workload.mjs', root);
  } else {
    response.writeHead(404).end();
    return;
  }
  try {
    const bytes = await readFile(file);
    if (engine) files[engine].set(path, bytes);
    response.setHeader('Content-Type', mime[extname(path)] ?? 'application/octet-stream');
    response.end(bytes);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const samples = Object.fromEntries(engines.map(engine => [engine, { cold: [], single: [] }]));
const launchOptions = process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : { channel: 'chrome' };
let chrome;
let version;
try {
  chrome = await chromium.launch(launchOptions);
  version = chrome.version();
  for (let i = 0; i < trials; i++) {
    for (const engine of i % 2 ? engines.toReversed() : engines) {
      const context = await chrome.newContext();
      try {
        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        const result = await page.evaluate(async engine => {
          const { checkCount, insertRows, ping, rowsTable } = await import('/bench/workload.mjs');
          const start = performance.now();
          let db;
          if (engine === 'mysql') {
            const { MySQL } = await import('/src/browser.mjs');
            db = await MySQL.create({ dataDir: 'memory://' });
          } else {
            const { PGlite } = await import('/pglite/index.js');
            db = await PGlite.create({ dataDir: 'memory://', relaxedDurability: false });
          }
          try {
            const { rows: [row] } = await db.query(ping);
            const cold = performance.now() - start;
            if (Number(row.n) !== 1) throw new Error('Unexpected first SELECT result');
            await db.exec(rowsTable);
            const insertStart = performance.now();
            await insertRows(db, engine, 1000);
            const single = performance.now() - insertStart;
            await checkCount(db, 'writes', 1000);
            return { cold, single };
          } finally {
            await db.close();
          }
        }, engine);
        for (const [name, ms] of Object.entries(result)) samples[engine][name].push(ms);
        console.error(`Chrome trial ${i + 1}/${trials} ${engine}`);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await chrome?.close();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

const compress = promisify(brotliCompress);
const downloads = {};
for (const [engine, assets] of Object.entries(files)) {
  downloads[engine] = {};
  for (const [path, buffer] of [...assets].sort(([a], [b]) => a.localeCompare(b))) {
    const compressed = await compress(buffer, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
    downloads[engine][path] = { raw: buffer.length, brotli: compressed.length };
  }
}
console.log(JSON.stringify({
  chrome: version,
  trials,
  results: Object.fromEntries(engines.map(engine => [engine,
    Object.fromEntries(Object.entries(samples[engine]).map(([name, values]) => [name, summarize(values)]))])),
  downloads,
}, null, 2));
