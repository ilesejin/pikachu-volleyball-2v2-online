const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const source = fs
  .readFileSync(
    path.join(__dirname, '../src/resources/js/online_2v2/room_activity.js'),
    'utf8'
  )
  .replace(/export /g, '');
const { RoomActivity, activityTransport } = Function(
  source + ';return {RoomActivity,activityTransport};'
)();
const room = () => ({
  closed: true,
  isHost: false,
  id: 'a'.repeat(20),
  data: { status: 'lobby', visibility: 'private' },
});
function fixture() {
  const current = room(),
    reports = [],
    states = [],
    timers = new Map();
  let reads = 0,
    shown = true,
    fail = false;
  const activity = new RoomActivity({
    room: current,
    report: async (...args) => reports.push(args),
    read: async () => {
      reads++;
      if (fail) throw Error('offline');
      return { active: 3, publicWaiting: 1, publicPlaying: 1 };
    },
    changed: (value) => states.push(value),
    visible: () => shown,
    every: (fn, ms) => {
      timers.set(ms, fn);
      return ms;
    },
    clear: (id) => timers.delete(id),
  });
  return {
    current,
    reports,
    states,
    timers,
    activity,
    get reads() {
      return reads;
    },
    set shown(v) {
      shown = v;
    },
    set fail(v) {
      fail = v;
    },
  };
}

test('only hosts report; public/private state and playing status update immediately without affecting matchmaking', async () => {
  const f = fixture();
  f.activity.start();
  await f.activity.tail;
  await f.activity.refresh();
  assert.equal(f.reports.length, 0);
  assert.ok(f.reads > 0);
  f.current.closed = false;
  f.current.isHost = true;
  await f.activity.sync();
  assert.deepEqual(f.reports.at(-1)[0], {
    active: true,
    roomId: 'a'.repeat(20),
    visibility: 'private',
    status: 'lobby',
    revision: f.activity.revision,
  });
  await f.activity.sync();
  assert.equal(f.reports.length, 1);
  f.current.data.visibility = 'public';
  f.current.data.status = 'playing';
  await f.activity.sync();
  assert.equal(f.reports.at(-1)[0].status, 'playing');
  assert.equal(f.reports.at(-1)[0].visibility, 'public');
  f.current.isHost = false;
  await f.activity.sync();
  assert.deepEqual(f.reports.at(-1)[0], {
    active: false,
    revision: f.activity.revision,
  });
  await f.activity.sync(true);
  assert.equal(f.reports.length, 3);
  await f.activity.stop();
});

test('30-second host reports and 60-second visible entry-page refreshes; unavailable never becomes zero', async () => {
  const f = fixture();
  f.activity.start();
  await f.activity.refresh();
  assert.deepEqual([...f.timers.keys()], [30000, 60000]);
  let reads = f.reads;
  f.shown = false;
  await f.timers.get(60000)();
  assert.equal(f.reads, reads);
  f.shown = true;
  f.current.closed = false;
  await f.timers.get(60000)();
  assert.equal(f.reads, reads);
  f.current.isHost = true;
  await f.timers.get(30000)();
  assert.equal(f.reports.length, 1);
  f.current.closed = true;
  f.fail = true;
  await f.activity.sync();
  await f.activity.refresh();
  assert.equal(f.states.at(-1), null);
  f.fail = false;
  await f.activity.refresh();
  assert.deepEqual(f.states.at(-1), {
    active: 3,
    publicWaiting: 1,
    publicPlaying: 1,
  });
  await f.activity.stop();
  assert.equal(f.timers.size, 0);
});

test('serial reports apply privacy/leave after an in-flight report and stop removes presence with keepalive', async () => {
  const current = room(),
    sent = [];
  let resolve;
  current.closed = false;
  current.isHost = true;
  current.data.visibility = 'public';
  const a = new RoomActivity({
    room: current,
    every: () => 0,
    clear: () => {},
    visible: () => false,
    read: async () => ({}),
    report: async (packet, options) => {
      sent.push([packet, options]);
      if (sent.length === 1) await new Promise((r) => (resolve = r));
    },
  });
  a.start();
  await Promise.resolve();
  current.data.visibility = 'private';
  a.sync();
  resolve();
  await a.tail;
  assert.deepEqual(
    sent.map((v) => v[0].visibility),
    ['public', 'private']
  );
  await a.stop();
  assert.deepEqual(sent.at(-1), [
    { active: false, revision: a.revision },
    { keepalive: true },
  ]);
});

test('failed report is retried on heartbeat and a possibly accepted report is cancelled on leave', async () => {
  const f = fixture();
  let calls = 0;
  f.activity.report = async () => {
    calls++;
    throw Error('network');
  };
  f.current.closed = false;
  f.current.isHost = true;
  f.activity.start();
  await f.activity.tail;
  assert.equal(calls, 1);
  await f.activity.sync();
  assert.equal(calls, 1);
  await f.activity.sync(true);
  assert.equal(calls, 2);
  const cancelled = [];
  f.activity.report = async (packet) => cancelled.push(packet);
  f.current.closed = true;
  await f.activity.sync();
  assert.deepEqual(cancelled, [
    { active: false, revision: f.activity.revision },
  ]);
  await f.activity.stop();
});

test('malformed statistics and synchronous read failures recover on a subsequent refresh', async () => {
  const f = fixture();
  f.activity.read = () => {
    throw Error('sync');
  };
  f.activity.start();
  await f.activity.refresh();
  assert.equal(f.states.at(-1), null);
  f.activity.read = async () => ({
    active: 1,
    publicWaiting: 2,
    publicPlaying: 0,
  });
  await f.activity.refresh();
  assert.equal(f.states.at(-1), null);
  f.activity.read = async () => ({
    active: 0,
    publicWaiting: 0,
    publicPlaying: 0,
  });
  await f.activity.refresh();
  assert.equal(f.states.at(-1).active, 0);
  await f.activity.stop();
});

test('transport reads aggregates without identity and authenticates only minimal host reports', async () => {
  let tokens = 0;
  const requests = [];
  const transport = activityTransport(
    'https://example.test/',
    async () => {
      tokens++;
      return 'token';
    },
    async (url, options) => {
      requests.push([url, options]);
      return {
        ok: true,
        json: async () => ({ active: 0, publicWaiting: 0, publicPlaying: 0 }),
      };
    }
  );
  await transport.read();
  assert.equal(tokens, 0);
  assert.equal(requests[0][1].headers, undefined);
  assert.equal(requests[0][0], 'https://example.test/v2/rooms/stats');
  await transport.report({ active: false }, { keepalive: true });
  assert.equal(tokens, 1);
  assert.equal(requests[1][1].headers.Authorization, 'Bearer token');
  assert.equal(requests[1][1].keepalive, true);
  assert.equal(requests[1][1].body, '{"active":false}');
});

test('acknowledged public lobby heartbeats replace dedicated reports, with fallback when acknowledgements stop', async () => {
  const f = fixture();
  let now = 0;
  f.activity.now = () => now;
  f.current.closed = false;
  f.current.isHost = true;
  f.current.data.visibility = 'public';
  f.activity.start();
  await f.activity.tail;
  const body = { roomId: f.current.id, visibility: 'public', status: 'lobby' };
  const revision = f.activity.publicationRevision(body);
  f.activity.published(body, { activityRecorded: true }, revision);
  const count = f.reports.length;
  await f.activity.sync(true);
  assert.equal(f.reports.length, count);
  now = 14000;
  await f.activity.sync(true);
  assert.equal(f.reports.length, count);
  now = 16000;
  await f.activity.sync(true);
  assert.equal(f.reports.length, count + 1);
  f.current.data.visibility = 'private';
  await f.activity.sync();
  f.activity.published(body, { activityRecorded: true }, revision);
  assert.equal(f.activity.publicationRevision(body), undefined);
  const previous = f.reports.length;
  await f.activity.sync(true);
  assert.equal(f.reports.length, previous + 1);
  assert.equal(f.reports.at(-1)[0].visibility, 'private');
  assert.ok(f.reports.at(-1)[0].revision > revision);
  await f.activity.stop();
  assert.equal(f.activity.publicationRevision(body), undefined);
});

test('old or rejected publication replies never suppress dedicated presence reports', async () => {
  const f = fixture();
  f.current.closed = false;
  f.current.isHost = true;
  f.current.data.visibility = 'public';
  f.activity.start();
  await f.activity.tail;
  const body = { roomId: f.current.id, visibility: 'public', status: 'lobby' };
  const revision = f.activity.publicationRevision(body);
  for (const response of [{}, { activityRecorded: false }]) {
    f.activity.published(body, response, revision);
    const before = f.reports.length;
    await f.activity.sync(true);
    assert.equal(f.reports.length, before + 1);
  }
  await f.activity.stop();
});
