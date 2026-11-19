# mysql-wasm and PGlite benchmark

Build and stage mysql-wasm, then install the pinned development dependency and
run the Node benchmark. It uses the staged build through the public package API.
The optional argument sets the trial count and defaults to five.

```sh
npm ci
npm run --silent bench -- 5 > node-results.json
```

The benchmark alternates engine order and runs each trial phase in a fresh Node
process. Cold timings start immediately before dynamic import and end when the
first `SELECT 1` returns. Processes are fresh and OS file caches are left warm.
Fresh filesystem trials start with an empty directory. Reopen trials use a
database seeded and closed before the timed trials. On Node, mysql-wasm
`memory://` is a temporary filesystem directory that is removed on close.
PGlite uses its in-memory virtual filesystem for that mode.

All engines use fresh Node filesystem databases for the workload trials. Each
insert and lookup is an awaited parameterized query. The batch measures one
transaction containing 10,000 such calls, including commit. The scan runs
`COUNT(*)`, `SUM`, and an ordered `GROUP BY` with both aggregates on 100,000
rows. The join aggregates over 10,000 parent and 100,000 child rows with a
foreign-key index. Fixture creation and result checks are outside the timers.

Cold starts use package defaults. The workload trials set MySQL
`innodb_flush_log_at_trx_commit=2` so redo writes reach the OS at commit and
InnoDB flushes approximately once a second. Binary logging is disabled by the
package. PGlite uses `fsync=off`, `synchronous_commit=on`, and
`relaxedDurability=false`. These are OS-buffered write comparisons. InnoDB
and PostgreSQL have different redo/WAL policies and make different crash
durability guarantees. Their default cache sizes differ too. The Node benchmark
runs mysql-wasm twice: `mysql` uses the child-process `MySQL` client and
`mysql-worker` uses `MySQLWorker`, which runs the server in the caller like
PGlite. Timings include each API's transport costs.

For memory, a separate process reopens the workload database and repeats the
scan. A parent samples RSS at roughly 10 ms intervals using `ps`, including a
snapshot before and after the scan. The peak is the largest simultaneous sum of
RSS across the benchmark process and its descendants. This includes runtime,
prepared-statement, and cache memory resident during the scan. Summed RSS can
count shared pages more than once, and samples can miss short-lived peaks.
Memory is reported in MiB and timings in milliseconds.

## Optional Chrome benchmark and download sizes

With Chrome and an existing Playwright Core installation, supply the latter
via `PLAYWRIGHT_CORE`. Set `CHROME_EXECUTABLE` to override Chrome discovery.

```sh
PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs \
  node bench/browser.mjs 5 > chrome-results.json
```

Each trial uses a fresh browser context on the local loopback server with HTTP
caching disabled. Both engines use in-memory filesystems. The measured
intervals cover import through the first query and the loop of 1,000
autocommit inserts. mysql-wasm communicates with a worker and PGlite runs in
the page. Chrome, the OS, and the physical storage caches can stay warm
between trials.

The output lists the core Wasm, data, and JS files the server actually served
to both engines, including initialization files when separately fetched.
Each file is compressed independently at Brotli quality 11. Summing those
sizes models HTTP transfer with Brotli. The benchmark page, npm packaging,
source maps, and unrequested optional modules are outside the download totals.

`results/` holds the reported runs on an Apple M4: `node.json` with Node
24.16.0 at commit 3696c57, and `chrome.json` with Chrome 157 at d2ffd15,
before the browser runtime also targeted Node.
