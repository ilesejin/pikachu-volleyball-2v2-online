const { spawnSync } = require('node:child_process');
const path = require('node:path');
const result = spawnSync(
  process.execPath,
  [path.join(__dirname, 'browser-online.cjs')],
  {
    env: { ...process.env, PIKA_REPLAY_ONLY: '1' },
    stdio: 'inherit',
    windowsHide: true,
  }
);
if (result.error) throw result.error;
process.exitCode = result.status === null ? 1 : result.status;
