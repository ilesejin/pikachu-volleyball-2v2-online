const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
function load(file, names, bindings = {}) {
  const source = fs
    .readFileSync(
      path.join(__dirname, '../src/resources/js/online_2v2', file),
      'utf8'
    )
    .replace(/^import[^;]+;\s*/gm, '')
    .replace(/export /g, '');
  return Function(
    ...Object.keys(bindings),
    source + ';return {' + names.join(',') + '};'
  )(...Object.values(bindings));
}
const { InputPacer } = load('input_pacer.js', ['InputPacer']);
const normalizeInput = (v) => ({
  xDirection: v?.xDirection || 0,
  yDirection: v?.yDirection || 0,
  powerHit: v?.powerHit || 0,
});
const { Lockstep } = load('lockstep.js', ['Lockstep'], { normalizeInput });
function fixture({
  mesh = true,
  pairs = false,
  count = 2,
  late = 0,
  delay = () => 10,
} = {}) {
  let time = 0,
    seq = 0;
  const events = new Map(),
    nodes = {},
    pacers = {},
    logs = {},
    samples = {},
    ages = {};
  const ids = pairs ? ['host', 'a'] : ['host', 'a', 'b', 'c'].slice(0, count);
  const members = Object.fromEntries(
    ids.map((id, i) => [id, { slots: pairs ? [i * 2, i * 2 + 1] : [i] }])
  );
  const offsets = { host: 500000, a: 1234, b: 900000, c: 40000 };
  const later = (fn, delay) => {
    const key = ++seq;
    events.set(key, { at: time + Math.max(1, delay), fn, key });
    return key;
  };
  const send = (id, to, p) =>
    later(
      () =>
        p.type.startsWith('pacing-')
          ? pacers[to].receive(id, p)
          : nodes[to].receive(id, p),
      delay(id, to)
    );
  for (const id of ids) {
    logs[id] = [];
    samples[id] = new Map();
    ages[id] = [];
    nodes[id] = new Lockstep({
      epoch: 'test',
      selfId: id,
      hostId: 'host',
      mesh,
      members,
      send: (to, p) => send(id, to, p),
      broadcast: (p) =>
        ids.filter((to) => to !== id).forEach((to) => send(id, to, p)),
      advance: (inputs, humans, frame) => {
        logs[id].push(JSON.parse(JSON.stringify({ inputs, humans, frame })));
        ages[id].push(time - samples[id].get(frame));
      },
    });
    pacers[id] = new InputPacer({
      epoch: 'test',
      selfId: id,
      hostId: 'host',
      members: () => [...nodes[id].members.keys()],
      send: (to, p) => send(id, to, p),
      now: () => time + offsets[id],
      later,
      cancel: (key) => events.delete(key),
      peers: () => (mesh ? ids : ['host']),
      canSample: (ahead) => nodes[id].canSampleAhead(ahead),
      sample: () => {
        const driver = nodes[id];
        if (driver.sampled >= driver.frame + 3 || driver.paused) return;
        const frame = driver.sampled + 1;
        samples[id].set(frame, time);
        driver.sample(
          members[id].slots.map((slot) => ({
            slot,
            xDirection: slot % 2 ? 1 : -1,
            yDirection: 0,
            powerHit: frame % 7 === 0 ? 1 : 0,
          }))
        );
      },
    });
  }
  const run = (until) => {
    for (let guard = 0; guard < 100000; guard++) {
      const next = [...events.values()].sort(
        (a, b) => a.at - b.at || a.key - b.key
      )[0];
      if (!next || next.at > until) {
        time = until;
        return;
      }
      time = next.at;
      events.delete(next.key);
      next.fn();
    }
    throw Error('Event loop did not settle');
  };
  for (const id of ids)
    later(() => pacers[id].reset(0, 30, false), id === 'host' ? 1 : late + 20);
  return {
    nodes,
    pacers,
    logs,
    samples,
    ages,
    ids,
    run,
    later,
    now: () => time,
    events,
  };
}
for (const options of [
  {},
  { count: 4 },
  { pairs: true },
  { mesh: false, count: 4 },
  { mesh: false, pairs: true },
])
  test(
    'aligned pacing preserves identical frames ' + JSON.stringify(options),
    () => {
      const f = fixture({ ...options, late: 150 });
      f.run(100);
      assert.equal(f.nodes.host.sampled, 0, 'Host must wait for late guests');
      f.run(2000);
      const complete = Math.min(...f.ids.map((id) => f.logs[id].length));
      assert.ok(complete > 40);
      for (const id of f.ids)
        assert.deepEqual(
          f.logs[id].slice(0, complete),
          f.logs.host.slice(0, complete)
        );
      if (options.mesh !== false)
        for (let frame = 1; frame < complete; frame++) {
          const times = f.ids.map((id) => f.samples[id].get(frame));
          assert.ok(
            Math.max(...times) - Math.min(...times) <= 1.01,
            'Clock-skewed browsers sample together'
          );
          const ages = f.ids.map((id) => f.ages[id][frame - 1]);
          assert.ok(
            Math.max(...ages) - Math.min(...ages) <= 2.01,
            JSON.stringify({ frame, ages, times })
          );
        }
      for (const p of Object.values(f.pacers)) p.stop();
      f.run(f.now() + 100);
      assert.equal(
        f.events.size,
        0,
        'Stopping removes all scheduling and clock timers'
      );
    }
  );
test('pause/resume and FPS changes establish a new shared cadence without replaying old inputs', () => {
  const f = fixture({ count: 4 });
  f.run(800);
  for (const id of f.ids) {
    f.nodes[id].control(1, true);
    f.pacers[id].reset(1, 20, true);
  }
  const frames = f.ids.map((id) => f.nodes[id].frame);
  f.run(1100);
  assert.deepEqual(
    f.ids.map((id) => f.nodes[id].frame),
    frames
  );
  for (const id of f.ids) {
    f.nodes[id].control(2, false);
    f.pacers[id].reset(2, 20, false);
  }
  f.run(2100);
  const complete = Math.min(...f.ids.map((id) => f.logs[id].length));
  for (const id of f.ids)
    assert.deepEqual(
      f.logs[id].slice(0, complete),
      f.logs.host.slice(0, complete)
    );
  const times = [...f.samples.host.values()].filter((at) => at > 1250);
  for (let i = 1; i < times.length; i++)
    assert.ok(Math.abs(times[i] - times[i - 1] - 50) <= 1);
});
test('pacer rejects stale or spoofed controls and never advances physics on control packets', () => {
  const f = fixture();
  f.run(500);
  const p = f.pacers.a,
    start = p.startAt;
  for (const [id, packet] of [
    ['host', { type: 'pacing-start', epoch: 'wrong', generation: 0, at: 0 }],
    ['stranger', { type: 'pacing-start', epoch: 'test', generation: 0, at: 0 }],
    ['host', { type: 'pacing-start', epoch: 'test', generation: 99, at: 0 }],
    [
      'host',
      { type: 'pacing-start', epoch: 'test', generation: 0, at: Infinity },
    ],
  ])
    assert.equal(p.receive(id, packet), true);
  assert.equal(p.receive('host', { type: 123 }), false);
  assert.equal(p.startAt, start);
  p.stop();
  assert.equal(
    p.receive('host', {
      type: 'pacing-start',
      epoch: 'test',
      generation: 0,
      at: 500,
    }),
    true
  );
});

test('a missed input deadline catches up within the input window and does not permanently deepen one queue', () => {
  const f = fixture();
  f.run(600);
  const guest = f.pacers.a;
  guest.cancel(guest.timer);
  guest.timer = f.later(() => guest.wake(), 100);
  f.run(1800);
  const complete = Math.min(f.logs.host.length, f.logs.a.length);
  assert.deepEqual(f.logs.host.slice(0, complete), f.logs.a.slice(0, complete));
  for (let frame = complete - 10; frame < complete; frame++)
    assert.ok(
      Math.abs(f.samples.host.get(frame) - f.samples.a.get(frame)) <= 2,
      JSON.stringify({
        frame,
        host: f.samples.host.get(frame),
        guest: f.samples.a.get(frame),
        tail: f.ids.map((id) => [id, [...f.samples[id]].slice(-12)]),
      })
    );
  for (const id of f.ids)
    assert.ok(f.nodes[id].sampled - f.nodes[id].frame <= 3);
});

test('slower guest-to-guest links receive enough input lead to sustain 30 FPS', () => {
  const f = fixture({
    count: 4,
    delay: (from, to) => (from === 'host' || to === 'host' ? 10 : 50),
  });
  f.run(2500);
  const complete = Math.min(...f.ids.map((id) => f.logs[id].length));
  assert.ok(
    complete >= 60,
    'The input lead must account for guest-to-guest RTT, not just host ping'
  );
  for (const id of f.ids) {
    assert.deepEqual(
      f.logs[id].slice(0, complete),
      f.logs.host.slice(0, complete)
    );
    assert.equal(f.pacers[id].ahead, 1);
  }
});

test('lead adapts when network latency rises and recovers, without changing the simulated inputs', () => {
  let slow = false;
  const f = fixture({
    count: 4,
    delay: (from, to) => (slow && from !== 'host' && to !== 'host' ? 50 : 10),
  });
  f.run(500);
  slow = true;
  f.run(3500);
  for (const id of f.ids) assert.equal(f.pacers[id].ahead, 1);
  slow = false;
  f.run(22000);
  const complete = Math.min(...f.ids.map((id) => f.logs[id].length));
  for (const id of f.ids) {
    assert.equal(f.pacers[id].ahead, 0);
    assert.deepEqual(
      f.logs[id].slice(0, complete),
      f.logs.host.slice(0, complete)
    );
  }
});
test('two-browser clock estimation balances asymmetric network directions', () => {
  const f = fixture({ delay: (from, to) => (from === 'host' ? 10 : 30) });
  f.run(2200);
  const complete = Math.min(f.logs.host.length, f.logs.a.length);
  assert.deepEqual(f.logs.host.slice(0, complete), f.logs.a.slice(0, complete));
  const average = (id) =>
    f.ages[id].slice(10, complete).reduce((a, b) => a + b, 0) / (complete - 10);
  assert.ok(Math.abs(average('host') - average('a')) < 2);
});
