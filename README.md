# mysql-wasm

An experimental port of MySQL Community Server to WebAssembly. The first
milestone is to start the server, create an InnoDB table, insert a row, shut
down cleanly, and read the row after reopening the same data directory.

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

## Target probes

The scripts run out-of-source CMake configuration and require CMake and
Ninja. Both accept additional CMake arguments.

- `./scripts/configure-wasix` uses [wasixcc](https://github.com/wasix-org/wasixcc)
  under `~/.wasixcc` or `$WASIXCC_ROOT`. With wasixcc 0.4.7, configuration
  reports `SIZEOF_VOIDP 4` and stops with `MySQL supports only 64-bit platforms.`
- `./scripts/configure-emscripten` uses an activated
  [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html).
  With Emscripten 6.0.9, `-m64 -pthread` passes MySQL's pointer-size check.
  Configuration then stops at `No mysys timer support detected!` because
  Emscripten exposes neither the POSIX timer functions MySQL checks for nor
  the kqueue alternative. A separate wasm64 probe created and joined a
  pthread in Node 24.

Neither probe currently produces a runnable MySQL server. The Emscripten
wasm64 target is the next candidate for the InnoDB milestone. MySQL removed
`libmysqld` in 8.0, so the 8.4 port will need its own startup and SQL bridge.
[MySQL 8.0 removal notes](https://dev.mysql.com/doc/refman/8.0/en/mysql-nutshell.html)
