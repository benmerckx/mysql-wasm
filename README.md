# mysql-wasm

MySQL Community Server 8.4 compiled to WebAssembly, with an async JavaScript
API for Node.js and browsers. Node runs the server in a child process.
Browsers run it in a dedicated worker.

```js
import { MySQL } from 'mysql-wasm';

const db = await MySQL.create();
try {
  await db.exec('CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(80))');
  await db.query('INSERT INTO users VALUES (?, ?)', [1, "O'Brien"]);
  const { rows } = await db.query('SELECT * FROM users WHERE id = ?', [1]);
  console.log(rows);
} finally {
  await db.close();
}
```

- `query(sql, params?)` runs one statement and returns
  `{ rows, fields, affectedRows }`. Parameters use MySQL's prepared-statement
  protocol. Strings, numbers, booleans, bigints, dates, binary values and
  `null` are supported. Use one placeholder per value in an `IN` list.
- `exec(sql)` runs a script and returns an array of results. MySQL parses
  the script, including quoted semicolons and compound statements.
- `transaction(callback)` commits on success and rolls back on failure.
  Use the transaction object for queries inside the callback. MySQL can
  implicitly commit DDL.
- `persist()` flushes the engine logs and, in the browser, saves to
  IndexedDB. Always await `close()` to shut down cleanly.

Node.js 24 or later can use a filesystem path or `file://` URL for
`dataDir`. Browsers accept `idb://name`. Omit `dataDir` or use
`memory://` for temporary storage. Only one connection may open a given
persistent data directory at a time. The browser implementation is
also available explicitly as `MySQLWorker` from `mysql-wasm/worker`.
In Node, that export uses the same child-process implementation.

## Browser setup

Host the site with cross-origin isolation for WebAssembly threads.
Use a browser with WebAssembly Memory64 support.

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

For Vite, set `worker.format` to `'es'`, set `build.target` to
`'esnext'`, and exclude `mysql-wasm` and `mysql-wasm/worker` from
dependency optimization. Serve the WASM asset as `application/wasm`.

## Compact build

InnoDB and MySQL's default `utf8mb4_0900_ai_ci` collation remain available.
The build retains common utf8mb4 collations and the charset tables required
by the server and ICU. It omits many legacy and language-specific compiled
collations, the bundled SQL HELP text, MySQL X Plugin, NDB, and Group
Replication. Check schemas for explicit collation names before importing.
Snapshot import and export and network client connections are outside the
current JavaScript API.

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
native OpenSSL and ncurses development headers, Emscripten 6.0.9, and
Node.js 24. Activate the Emscripten SDK, then run:

```sh
./scripts/build-dependencies
./scripts/build-emscripten
npm test
npm pack --pack-destination dist
```

The build uses native code generators, static wasm64 OpenSSL, and a single
WASM binary shared by separate Node and browser loaders. The patches apply
to a generated checkout under `build/sources/`, keeping the MySQL submodule
at the upstream tag.

`./scripts/test-timers` exercises expiry, cancellation, and shutdown of the
timer dispatcher. The npm tests exercise the JS API and reopen an InnoDB
data directory. The low-level `./scripts/smoke-innodb` test uses the staged Node CLI with `--init-file`.

### WASIX

`./scripts/configure-wasix` preserves the baseline probe. wasixcc 0.4.7
targets wasm32, which MySQL 8.4 rejects because it requires 64-bit pointers.
The Emscripten build uses `-m64 -pthread`.
