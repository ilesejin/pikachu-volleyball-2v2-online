const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const source = fs
  .readFileSync(
    path.join(__dirname, '../src/resources/js/online_2v2/diagnostics.js'),
    'utf8'
  )
  .replace(/^import[\s\S]*?from ['"][^'"]+['"];?\r?\n/gm, '')
  .replace(/export /g, '');
const requiredPeers = (data, id) =>
  data.settings.topology === 'mesh' || id === data.hostId
    ? Object.keys(data.members).filter((peer) => peer !== id)
    : [data.hostId];
const { NetworkDiagnostics } = Function(
  'requiredPeers',
  source + ';return {NetworkDiagnostics};'
)(requiredPeers);
function fixture() {
  let time = 0;
  const sent = [],
    broadcast = [];
  const room = {
    id: 'room',
    selfId: 'host',
    isHost: true,
    closed: false,
    data: {
      hostId: 'host',
      layout: 'four',
      networkRevision: 0,
      settings: { topology: 'mesh', synchronization: 'lockstep' },
      members: {
        host: { slots: [0] },
        a: { slots: [1] },
        b: { slots: [2] },
        c: { slots: [3] },
      },
    },
    peers: new Map(),
    connected(id) {
      return this.peers.has(id);
    },
    send(id, message) {
      sent.push({ id, message });
      return true;
    },
    broadcast(message) {
      broadcast.push(message);
    },
  };
  for (const id of ['a', 'b', 'c'])
    room.peers.set(id, {
      channel: { bufferedAmount: 0 },
      pc: { getStats: async () => new Map() },
    });
  const session = {
    phase: 'idle',
    settings: { synchronization: 'lockstep', fps: 30 },
  };
  const diagnostics = new NetworkDiagnostics(room, session, {
    now: () => time,
  });
  return {
    room,
    session,
    diagnostics,
    sent,
    broadcast,
    at: (value) => {
      time = value;
    },
  };
}
const value = (peerId, average = 42) => ({
  peerId,
  average,
  low: average,
  high: average,
  count: 5,
  age: 0,
  noResponse: false,
  route: 'direct',
  protocol: 'udp',
});

test('measures numbered RTT probes, rejects duplicate pongs, bounds samples and leaves game state untouched', () => {
  const f = fixture(),
    before = JSON.stringify({ room: f.room.data, session: f.session });
  f.diagnostics.tick();
  assert.equal(f.sent.length, 3);
  const seq = f.sent[0].message.seq;
  f.at(42);
  f.diagnostics.receive('a', { type: 'diag-pong', revision: 0, seq });
  assert.equal(
    f.diagnostics.localLinks().find((x) => x.peerId === 'a').average,
    42
  );
  f.at(100);
  f.diagnostics.receive('a', { type: 'diag-pong', revision: 0, seq });
  assert.equal(f.diagnostics.links.get('a').samples.length, 1);
  for (let i = 1; i < 14; i++) {
    f.at(i * 2000);
    f.diagnostics.tick();
    const packet = f.sent
      .filter((x) => x.id === 'a' && x.message.type === 'diag-ping')
      .at(-1);
    f.at(i * 2000 + 30);
    f.diagnostics.receive('a', {
      type: 'diag-pong',
      revision: 0,
      seq: packet.message.seq,
    });
  }
  assert.equal(f.diagnostics.links.get('a').samples.length, 10);
  assert.equal(
    JSON.stringify({ room: f.room.data, session: f.session }),
    before
  );
});

test('timeouts are not reported as zero ping, and congestion skips diagnostics without reporting packet loss', () => {
  const f = fixture();
  f.diagnostics.tick();
  f.at(5100);
  f.diagnostics.tick();
  const row = f.diagnostics.localLinks()[0];
  assert.equal(row.average, null);
  assert.equal(row.noResponse, true);
  assert.equal(f.diagnostics.snapshot().average, null);
  const g = fixture();
  g.room.peers.get('a').channel.bufferedAmount = 65536;
  g.diagnostics.tick();
  assert.equal(
    g.sent.some((x) => x.id === 'a'),
    false
  );
  assert.equal(g.diagnostics.links.get('a').pending.size, 0);
});

test('reports reveal guest-to-guest mesh links, enforce membership/revision and ignore unrelated packets', () => {
  const f = fixture();
  f.diagnostics.tick();
  assert.equal(
    f.diagnostics.receive('a', {
      type: 'diag-report',
      revision: 0,
      links: [value('b')],
    }),
    true
  );
  assert.equal(
    f.diagnostics
      .snapshot()
      .rows.find((x) => x.source === 'a' && x.peerId === 'b').average,
    42
  );
  f.diagnostics.receive('a', {
    type: 'diag-report',
    revision: 1,
    links: [value('c', 900)],
  });
  assert.equal(f.diagnostics.snapshot().average, 42);
  f.diagnostics.receive('intruder', {
    type: 'diag-report',
    revision: 0,
    links: [value('c', 900)],
  });
  assert.equal(f.diagnostics.snapshot().average, 42);
  assert.equal(f.diagnostics.receive('a', { type: 'input' }), false);
  f.at(11000);
  assert.equal(f.diagnostics.snapshot().average, null);
});

test('star and host physics do not present unused guest links as gameplay ping', () => {
  const f = fixture();
  f.diagnostics.tick();
  f.diagnostics.receive('a', {
    type: 'diag-report',
    revision: 0,
    links: [value('b', 900), value('host', 20)],
  });
  f.session.settings.synchronization = 'host';
  f.room.data.settings.synchronization = 'host';
  assert.equal(f.diagnostics.snapshot().average, 20);
  assert.equal(
    f.diagnostics
      .snapshot()
      .rows.find((x) => x.source === 'a' && x.peerId === 'b').used,
    false
  );
  f.room.data.settings.topology = 'star';
  assert.equal(
    f.diagnostics
      .snapshot()
      .rows.some((x) => x.peerId === 'b' && x.source === 'a'),
    false
  );
});

test('rebuilds and closed rooms discard measurements and late responses', () => {
  const f = fixture();
  f.diagnostics.tick();
  const seq = f.sent[0].message.seq;
  f.room.data.networkRevision++;
  f.at(100);
  f.diagnostics.tick();
  f.diagnostics.receive('a', { type: 'diag-pong', revision: 0, seq });
  assert.equal(f.diagnostics.snapshot().average, null);
  f.room.closed = true;
  f.diagnostics.tick();
  assert.equal(f.diagnostics.snapshot().active, false);
  assert.equal(f.diagnostics.links.size, 0);
});

test('input wait observation excludes pause and normal pacing and identifies the missing member', () => {
  const f = fixture();
  f.session.phase = 'playing';
  f.session.epoch = 'match';
  f.session.lockstep = {
    mesh: true,
    frame: 1,
    sampled: 2,
    generation: 0,
    paused: false,
    members: new Map([
      ['host', [0]],
      ['a', [1]],
    ]),
    pending: new Map([[2, new Map([['host', []]])]]),
  };
  f.diagnostics.observeWait();
  f.at(200);
  assert.equal(f.diagnostics.snapshot().wait.peers[0], 'a');
  assert.ok(f.diagnostics.snapshot().wait.milliseconds >= 160);
  f.session.lockstep.paused = true;
  f.diagnostics.observeWait();
  assert.equal(f.diagnostics.snapshot().wait, null);
  f.session.lockstep.paused = false;
  f.session.lockstep.sampled = 1;
  f.diagnostics.observeWait();
  assert.equal(f.diagnostics.snapshot().wait, null);
});

test('uses selected ICE pair for direct/TURN labels without exposing addresses, and tolerates missing stats', async () => {
  const f = fixture();
  const stats = new Map([
    ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
    [
      'pair',
      {
        type: 'candidate-pair',
        localCandidateId: 'local',
        remoteCandidateId: 'remote',
      },
    ],
    [
      'local',
      { candidateType: 'host', protocol: 'udp', address: 'private-address' },
    ],
    ['remote', { candidateType: 'relay' }],
  ]);
  f.room.peers.get('a').pc.getStats = async () => stats;
  f.diagnostics.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(f.diagnostics.localLinks()[0].route, 'turn');
  assert.equal(
    JSON.stringify(f.diagnostics.snapshot()).includes('private-address'),
    false
  );
  stats.get('remote').candidateType = 'srflx';
  f.at(6000);
  f.diagnostics.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(f.diagnostics.localLinks()[0].route, 'direct');
  assert.equal(f.diagnostics.localLinks()[1].route, 'unknown');
});

test('admission is completed before probing and a newer reply supersedes an older missed probe', () => {
  const f = fixture();
  f.room.joinDetails = { name: 'Joining' };
  f.diagnostics.tick();
  assert.equal(f.sent.length, 0);
  assert.equal(f.diagnostics.snapshot().active, false);
  f.room.joinDetails = null;
  f.diagnostics.tick();
  assert.equal(f.sent.length, 3);
  f.at(1000);
  f.diagnostics.tick();
  const packet = f.sent
    .filter((x) => x.id === 'a' && x.message.type === 'diag-ping')
    .at(-1);
  f.at(1042);
  f.diagnostics.receive('a', {
    type: 'diag-pong',
    revision: 0,
    seq: packet.message.seq,
  });
  f.at(5100);
  f.diagnostics.tick();
  const row = f.diagnostics.localLinks().find((x) => x.peerId === 'a');
  assert.equal(row.average, 42);
  assert.equal(row.noResponse, false);
});
