const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs
  .readFileSync(
    path.join(__dirname, '../src/resources/js/online_2v2/client_version.js'),
    'utf8'
  )
  .replace(/export /g, '');
const context = vm.createContext({
  __CLIENT_VERSION__: {
    format: 1,
    protocol: 'pikavolley-2v2-v5',
    build: 'test-build',
    engine: 'test-engine',
  },
  URL,
  fetch,
  AbortSignal,
  setTimeout,
  clearTimeout,
});
vm.runInContext(
  source +
    ';this.result={CLIENT_VERSION,ClientUpdates,VERSION_MISMATCH,UPDATE_REQUIRED,UPDATE_CHECK_FAILED,sameVersion,assertCompatible,assertRoomCompatible};',
  context
);
module.exports = context.result;
