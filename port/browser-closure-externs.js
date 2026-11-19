/** @externs */

// These properties are read by src/engine.mjs and its hosts outside Closure's input.
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
/** @type {{IDBFS: !Object, NODEFS: !Object}} */
MySQLWasmFileSystem.prototype.filesystems;

/** @constructor */
function MySQLWasmFileStat() {}
/** @type {number} */
MySQLWasmFileStat.prototype.mode;

/** @constructor */
function MySQLWasmRuntime() {}
/** @type {!MySQLWasmFileSystem} */
MySQLWasmRuntime.prototype.FS;
/** @type {!Object<string, string>} */
MySQLWasmRuntime.prototype.ENV;
MySQLWasmRuntime.prototype.callMain = function(args) {};
MySQLWasmRuntime.prototype.ccall = function(name, result, types, args) {};
