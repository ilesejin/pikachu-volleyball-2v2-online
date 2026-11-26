const path = require('node:path');
const { spawnSync } = require('node:child_process');
const result = spawnSync(
  process.execPath,
  [path.join(__dirname, 'browser-online.cjs')],
  {
    env: {
      ...process.env,
      PIKA_ROOM_ACTIVITY_ONLY: '1',
      PIKA_QUICK_MATCH_SERVER:
        process.env.PIKA_QUICK_MATCH_SERVER ||
        path.resolve(
          __dirname,
          '../../pikachu-volleyball-2v2-online-quick-match-server-main'
        ),
    },
    stdio: 'inherit',
    windowsHide: true,
  }
);
if (result.error) throw result.error;
process.exitCode = result.status === null ? 1 : result.status;
