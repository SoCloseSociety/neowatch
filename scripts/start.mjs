#!/usr/bin/env node
// `npm start`: production start that works on every OS. The POSIX form
// `NODE_ENV=production node server/src/index.js` fails under cmd.exe / PowerShell.
// An explicit NODE_ENV (e.g. `test` in CI) wins. The dynamic import runs AFTER the
// assignment, so server/src/config.js reads the right value.
process.env.NODE_ENV ||= 'production';
await import('../server/src/index.js');
