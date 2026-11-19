# mysql-wasm

An experimental port of MySQL Community Server to WebAssembly. The first
milestone is to start the server, create an InnoDB table, insert a row, shut
down cleanly, and read the row after reopening the same data directory.

Verified with Emscripten 6.0.9 and Node.js 24 on Linux. The wasm64 server
initialized a new data directory, wrote an InnoDB row, and recovered it
after a clean shutdown and restart.

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

## Build the wasm64 prototype

Use a Linux build host with CMake, Ninja, GNU Make, Perl, Bison, a native
C/C++ toolchain, native OpenSSL and ncurses development headers, Emscripten
6.0.9, and Node.js 24. Activate the Emscripten SDK, then run:

```sh
./scripts/build-dependencies
./scripts/configure-emscripten
source_dir=$(./scripts/prepare-source)
cmake --build "build/emscripten/$(basename "$source_dir")" --target mysqld --parallel 4
./scripts/smoke-innodb
```

The build prepares native code generators and static wasm64 OpenSSL.
The port patches are applied to a generated checkout under `build/sources/`,
so the MySQL submodule stays at the upstream tag. The prototype uses Node's
filesystem, runs SQL batches from `--init-file`, and uses MySQL's normal
shutdown path. It targets a local CLI experiment. A long-lived SQL bridge
and browser integration are separate milestones.

Run `./scripts/test-timers` to exercise the Emscripten timer backend in Node.
It covers expiry, cancellation, cleanup, and restarting the timer dispatcher.

### WASIX

`./scripts/configure-wasix` is preserved as a baseline probe. wasixcc 0.4.7
targets wasm32, which MySQL 8.4 rejects because it requires 64-bit pointers.
The Emscripten build uses `-m64 -pthread`.
