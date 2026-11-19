/** @externs */

// Emscripten's Node externs cover getuid and getgid, and omit these variants.
/** @return {number} */
process.geteuid = function() {};
/** @return {number} */
process.getegid = function() {};
