/** @externs */

// The shared Wasm imports a batch input function that uses require in Node.
function require(name) {}

// These properties are read by src/browser-worker.mjs outside Closure's input.
/** @constructor */
function MySQLWasmFileSystem() {}
MySQLWasmFileSystem.prototype.mkdirTree = function(path) {};
MySQLWasmFileSystem.prototype.mkdir = function(path) {};
MySQLWasmFileSystem.prototype.writeFile = function(path, bytes) {};
MySQLWasmFileSystem.prototype.readFile = function(path) {};
MySQLWasmFileSystem.prototype.readdir = function(path) {};
MySQLWasmFileSystem.prototype.stat = function(path) {};
MySQLWasmFileSystem.prototype.isDir = function(mode) {};
MySQLWasmFileSystem.prototype.mount = function(type, options, path) {};
MySQLWasmFileSystem.prototype.syncfs = function(populate, done) {};
/** @type {{IDBFS: !Object}} */
MySQLWasmFileSystem.prototype.filesystems;

/** @constructor */
function MySQLWasmFileStat() {}
/** @type {number} */
MySQLWasmFileStat.prototype.mode;

/** @constructor */
function MySQLWasmRuntime() {}
/** @type {!MySQLWasmFileSystem} */
MySQLWasmRuntime.prototype.FS;
MySQLWasmRuntime.prototype.callMain = function(args) {};
MySQLWasmRuntime.prototype.ccall = function(name, result, types, args) {};
