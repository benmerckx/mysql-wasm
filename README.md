# mysql-wasm

MySQL Community Server 8.4 compiled to WebAssembly, with an async JavaScript
API for Node.js and browsers. Node runs the server in the current process, on
worker threads. Browsers run it in a dedicated worker.

```js
import { MySQL } from 'mysql-wasm';

await using db = await MySQL.create();
await db.exec('CREATE TABLE users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(80))');
const { insertId } = await db.query('INSERT INTO users (name) VALUES (?)', ["O'Brien"]);
const { rows } = await db.sql`SELECT * FROM users WHERE id = ${insertId}`;
```

- `query(sql, params?, { rowMode }?)` runs one statement and returns
  `{ rows, fields, affectedRows, changedRows, insertId }`. As in mysql2,
  `affectedRows` counts the rows an `UPDATE` matched and `changedRows` the
  ones it changed. Parameters use MySQL's prepared-statement protocol.
  Strings, numbers, booleans, bigints, dates,
  binary values and `null` are supported. Use one placeholder per value in an
  `IN` list. `rowMode: 'array'` returns rows as arrays, which keeps columns
  that share a name.
- `` sql`...` `` runs a template literal with its values as parameters.
- `exec(sql)` runs a script and returns an array of results. MySQL parses
  the script, including quoted semicolons and compound statements.
- `transaction(callback)` commits on success and rolls back on failure. Use
  the transaction object inside the callback: calls on the database itself
  wait until the transaction ends, so awaiting one there never finishes.
  MySQL can implicitly commit DDL.
- `dump()` returns a crash-consistent snapshot of the data directory as a
  gzip-compressed `Uint8Array`. Pass it as `load` to `MySQL.create()` to start
  a new database from it.
- `persist()` flushes the engine logs and waits until browser storage is
  saved. Await `close()`, or use `await using`, to shut down cleanly. Like
  PGlite's, the type declarations use `Symbol.asyncDispose`, so TypeScript
  needs an `esnext` lib or `skipLibCheck`.

Results decode integers and floats as numbers. `BIGINT` values outside the
safe integer range, and `insertId` beyond it, are bigints, as in PGlite.
`DECIMAL` and date and time values are strings, JSON columns are parsed,
and binary strings are `Uint8Array`s. `types` names the `Field.type` codes.

Node.js 24 or later and Bun can use a filesystem path or `file://` URL for
`dataDir`. Browsers accept `idb://name` and save writes to IndexedDB shortly
after each query. Omit `dataDir` or use `memory://` for temporary storage.
Only one connection may open a given persistent data directory at a time; a
lock left by a crashed process is taken over. Snapshots and the prebuilt
data directory use `lower_case_table_names=0`, so on a case-insensitive disk,
such as most macOS volumes, load them into memory or IndexedDB instead.

In Node and Bun, `MySQLProcess` from `mysql-wasm/process` runs the server in a child
process instead, so a crash in the server cannot take the host down. It has
the same API except `dump()`, and both open each other's data directories.

## Browser setup

Host the site with cross-origin isolation for WebAssembly threads.

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

For Vite, set `worker.format` to `'es'`, set `build.target` to
`'esnext'`, and exclude `mysql-wasm` from dependency optimization. Serve the WASM asset as `application/wasm`.

## Compact build

InnoDB and MySQL's default `utf8mb4_0900_ai_ci` collation remain available.
The build retains common utf8mb4 collations and the charset tables required
by the server and ICU. It omits many legacy and language-specific compiled
collations, the bundled SQL HELP text, MySQL X Plugin, NDB, and Group
Replication. Check schemas for explicit collation names before importing.
The ICU bundle includes the data used by regular expressions, including
named characters (`\N{name}`), grapheme clusters (`\X`), and dictionary
segmentation for Unicode word boundaries (`(?w)\b`). It omits ICU line,
sentence, and title break rules and locale overrides unused by the regex engine.

Performance Schema and its instrumentation are omitted. New data directories
skip the bundled `sys` schema, whose diagnostic views depend on Performance
Schema. `SHOW VARIABLES` and `SHOW STATUS` also use Performance Schema in
MySQL 8.4 and return an error in this build.

The Archive, Blackhole, and Federated storage engines are omitted, along with
the ngram full-text parser and the legacy `mysql_native_password` plugin.

The server is 32-bit WebAssembly, so it can use at most 4 GB of memory. It
runs with embedded-sized buffers: a 32 MB buffer pool, 8 MB redo capacity,
1 MB log buffer, and 64 MB of TempTable memory. TLS is not built:
the server links stubs instead of OpenSSL's libssl and generates no
certificates or RSA keys. OpenSSL's libcrypto still provides hashing, AES and
random bytes, built without unused algorithms such as DES, DSA, RC4 and SM2.

New databases start from a prebuilt data directory (`dist/datadir.data`)
instead of running `mysqld --initialize-insecure`. It is used for in-memory
and IndexedDB storage and for case-sensitive filesystems. On case-insensitive
filesystems, such as most macOS volumes, MySQL requires
`lower_case_table_names=2`, so new data directories there are still
initialized on first start. Building the package therefore needs a
case-sensitive temporary directory.

The `ST_*` spatial functions and `MBR*` predicates are omitted. Geometry
columns, spatial indexes, and constructors such as `POINT(x, y)` are
available. New databases include spatial reference IDs 0, 3857, and 4326.
Network client connections are outside the current JavaScript API.

## Upstream source

The `upstream/mysql-server` Git submodule pins the official
[MySQL 8.4.13 LTS tag](https://github.com/mysql/mysql-server/tree/mysql-8.4.13).
After cloning this repository, initialize the pinned checkout:

```sh
git submodule update --init --depth 1
```

To bump the pin, set `tag` to the desired upstream release tag, then run:

```sh
git -C upstream/mysql-server fetch --depth 1 origin tag "$tag"
git -C upstream/mysql-server checkout --detach "$tag"
git add upstream/mysql-server
```

Run the target probes and review upstream changes before committing the new
pin. The upstream license is in [upstream/mysql-server/LICENSE](upstream/mysql-server/LICENSE).

## Build and package

Use Linux with CMake, Ninja, GNU Make, Perl, Bison, a native C/C++ toolchain,
native OpenSSL and ncurses development headers, Emscripten 6.0.9,
Java for the SDK’s Closure Compiler, and Node.js 24. Activate the Emscripten
SDK, then run:

```sh
./scripts/build-dependencies
./scripts/build-emscripten
npm test
npm pack --pack-destination dist
```

The build uses native code generators and static wasm32 OpenSSL. The
Node and browser loaders share one WASM binary and one runtime data bundle
containing MySQL error messages, charset definitions, and ICU data. The
patches apply to a generated checkout under `build/sources/`, keeping the
MySQL submodule at the upstream tag.

`./scripts/test-timers` exercises expiry, cancellation, and shutdown of the
timer dispatcher. The npm tests exercise the JS API and reopen an InnoDB
data directory. The low-level `./scripts/smoke-innodb` test uses the staged Node CLI with `--init-file`.

### WASIX

`./scripts/configure-wasix` preserves the baseline probe for wasixcc 0.4.7,
which does not apply the patches. MySQL 8.4 only accepts 64-bit pointers;
the Emscripten build lifts that check and targets wasm32 with `-pthread`.
