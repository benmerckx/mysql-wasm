// Node and browser glue use the same Wasm binary. In the npm package it
// lives one level above this file. Keep direct CMake runs working as well.
Module['locateFile'] = function (file, directory) {
  const fs = require('node:fs');
  const path = require('node:path');
  const local = path.join(directory, file);
  return fs.existsSync(local) ? local : path.join(directory, '..', file);
};
