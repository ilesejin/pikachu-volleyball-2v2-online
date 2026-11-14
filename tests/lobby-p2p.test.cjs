const clientVersion = require('./client-version-fixture.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
function load(file, names, bindings = {}) {
  const source = fs
    .readFileSync(path.join(__dirname, '../src/resources/js', file), 'utf8')
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?\r?\n/gm, '')
    .replace(/export /g, '');
  return Function(
    ...Object.keys(bindings),
    source + ';return {' + names.join(',') + '};'
  )(...Object.values(bindings));
}
const { DOUBLES_CONFIG } = load('offline_2v2/doubles_config.js', [
  'DOUBLES_CONFIG',
]);
const protocol = load(
  'online_2v2/protocol.js',
  [
    'ROOM_SCHEMA',
    'SKIN_IDS',
    'playerSkins',
    'slotSkins',
    'validSlots',
    'playerNames',
    'matchSettings',
    'lobbyReady',
    'randomizedPositions',
  ],
  { DOUBLES_CONFIG, crypto: require('node:crypto').webcrypto }
);
const { LobbyStore } = load('online_2v2/lobby_store.js', ['LobbyStore'], {
  ...clientVersion,
  ...protocol,
  setTimeout,
  clearTimeout,
});
async function fixture(layout = 'four') {
  const calls = [];
  const room = {
    id: 'room',
    selfId: 'host',
    isHost: true,
    closed: false,
    peers: new Map(),
    transport: {
      publish: async (...args) => calls.push(['publish', ...args]),
      unpublish: async (...args) => calls.push(['unpublish', ...args]),
    },
    publishData(data) {
      this.data = data;
    },
  };
  const store = new LobbyStore(room);
  room.data = await store.create('room', 'host', 'Host', layout, [], {});
  return { room, store, calls };
}
test('host serializes competing selections and all ordinary lobby edits avoid signaling storage', async () => {
  const { room, store, calls } = await fixture();
  await store.enqueue('a', 'claim', {
    compatibility: clientVersion.CLIENT_VERSION,
    name: 'A',
    slots: [],
  });
  await store.enqueue('b', 'claim', {
    compatibility: clientVersion.CLIENT_VERSION,
    name: 'B',
    slots: [],
  });
  const results = await Promise.allSettled([
    store.enqueue('a', 'selectSlots', { slots: [1] }),
    store.enqueue('b', 'selectSlots', { slots: [1] }),
  ]);
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1
  );
  assert.equal(room.data.seats[1], 'a');
  await store.enqueue('a', 'rename', { names: ['Renamed'] });
  await store.randomizeSlots();
  await store.networkReady('room', 'a', 0, true);
  assert.equal(calls.length, 1);
  assert.equal(room.data.members.a.name, 'Renamed');
  assert.equal(room.data.stateVersion, 6);
});
test('guest requests cannot edit another identity or run host-only actions', async () => {
  const { room, store } = await fixture();
  await store.enqueue('guest', 'claim', {
    compatibility: clientVersion.CLIENT_VERSION,
    name: 'Guest',
    slots: [],
  });
  for (const action of [
    'beginMatch',
    'update',
    'rebuildNetwork',
    'randomizeSlots',
    'networkReady',
  ])
    await assert.rejects(store.enqueue('guest', action, {}), /host/);
  await store.enqueue('guest', 'selectSlots', { clientId: 'host', slots: [2] });
  assert.deepEqual(room.data.members.host.slots, []);
  await store.enqueue('guest', 'remove', { clientId: 'host' });
  assert.ok(room.data.members.host);
  assert.equal(room.data.members.guest, undefined);
});
test('pair admission preserves teams, limits capacity, and locks selection during play', async () => {
  const { room, store, calls } = await fixture('pairs');
  await assert.rejects(
    store.enqueue('bad', 'claim', {
      compatibility: clientVersion.CLIENT_VERSION,
      name: 'Bad',
      slots: [0, 2],
    })
  );
  await store.enqueue('guest', 'claim', {
    compatibility: clientVersion.CLIENT_VERSION,
    name: ['A', 'B'],
    slots: [2, 3],
  });
  await assert.rejects(
    store.enqueue('late', 'claim', {
      compatibility: clientVersion.CLIENT_VERSION,
      name: 'Late',
      slots: [],
    }),
    /full/
  );
  await store.selectSlots('room', 'host', [0, 1]);
  await store.networkReady('room', 'guest', 0, true);
  await store.beginMatch('room', 'host', {});
  assert.equal(calls.at(-1)[0], 'unpublish');
  await assert.rejects(
    store.enqueue('guest', 'selectSlots', { slots: [] }),
    /lobby/
  );
  await store.update('room', { status: 'lobby' });
  assert.equal(calls.at(-1)[0], 'publish');
  assert.deepEqual(room.data.members.guest.names, ['A', 'B']);
});
test('failed rendezvous changes do not publish a false room transition', async () => {
  const { room, store } = await fixture();
  await store.selectSlots('room', 'host', [0]);
  await store.enqueue('guest', 'claim', {
    compatibility: clientVersion.CLIENT_VERSION,
    name: 'Guest',
    slots: [1],
  });
  await store.networkReady('room', 'guest', 0, true);
  room.transport.unpublish = async () => {
    throw new Error('offline');
  };
  await assert.rejects(store.beginMatch('room', 'host', {}), /offline/);
  assert.equal(room.data.status, 'lobby');
});
const { RelaySignaling } = load('online_2v2/relay_signaling.js', [
  'RelaySignaling',
]);
test('mesh signaling is host-relayed, scoped to current endpoints/revision, and buffered before listeners', () => {
  const data = {
    hostId: 'host',
    layout: 'four',
    networkRevision: 1,
    settings: { topology: 'mesh' },
    members: { host: {}, a: {}, b: {} },
  };
  const forwarded = [];
  const host = new RelaySignaling({
    isHost: true,
    data,
    send: (id, message) => forwarded.push([id, message]),
  });
  const packet = {
    type: 'mesh-signal',
    revision: 1,
    key: '1~a~b',
    target: 'b',
    kind: 'offer',
    value: { type: 'offer', sdp: 'test' },
  };
  host.receive('outsider', packet);
  host.receive('a', { ...packet, revision: 0 });
  assert.equal(forwarded.length, 0);
  host.receive('a', packet);
  assert.equal(forwarded.length, 1);
  const guest = new RelaySignaling({ selfId: 'b', isHost: false, data });
  guest.receive('host', forwarded[0][1]);
  let received;
  guest.watchSignal('room', '1~a~b', (value) => (received = value));
  assert.equal(received.offer.sdp, 'test');
  guest.receive('a', { ...forwarded[0][1], value: { sdp: 'forged' } });
  assert.equal(received.offer.sdp, 'test');
});

test('queued work from a departed room cannot change a newly created lobby', async () => {
  const { room, store } = await fixture();
  let release;
  store.tail = new Promise((resolve) => {
    release = resolve;
  });
  const old = store.enqueue('old-guest', 'claim', {
    compatibility: clientVersion.CLIENT_VERSION,
    name: 'Old',
    slots: [],
  });
  store.shutdown();
  room.data = await store.create(
    'new-room',
    'host',
    'New Host',
    'four',
    [],
    {}
  );
  release();
  await assert.rejects(old, /closed/);
  assert.deepEqual(Object.keys(room.data.members), ['host']);
  assert.equal(room.data.members.host.name, 'New Host');
});

test('legacy and mismatched guest admission cannot change the lobby, and mismatched rosters cannot start', async () => {
  const { room, store } = await fixture();
  const initial = JSON.stringify(room.data);
  for (const compatibility of [
    undefined,
    { ...clientVersion.CLIENT_VERSION, build: 'old' },
    { ...clientVersion.CLIENT_VERSION, engine: 'other' },
  ]) {
    await assert.rejects(
      store.enqueue('guest', 'claim', {
        name: 'Guest',
        slots: [],
        compatibility,
      }),
      /versions do not match/
    );
    assert.equal(JSON.stringify(room.data), initial);
  }
  await store.enqueue('guest', 'claim', {
    name: 'Guest',
    slots: [],
    compatibility: clientVersion.CLIENT_VERSION,
  });
  await store.randomizeSlots();
  room.data.members.guest.connected = true;
  room.data.members.guest.compatibility = {
    ...clientVersion.CLIENT_VERSION,
    engine: 'wrong',
  };
  await assert.rejects(
    store.beginMatch('room', 'host', {}),
    /versions do not match/
  );
  assert.equal(room.data.status, 'lobby');
});

test('a new guest rejects an old host lobby response rather than accepting missing compatibility', async () => {
  let accepted = false,
    rejected = false,
    ended = false;
  const room = {
    isHost: false,
    selfId: 'guest',
    data: { hostId: 'host' },
    acceptData() {
      accepted = true;
    },
    joinReject() {
      rejected = true;
    },
    fail() {},
    shutdown() {
      ended = true;
    },
    emit() {},
  };
  const store = new LobbyStore(room);
  let error;
  store.pending.set('1', {
    timer: null,
    reject: (value) => {
      error = value;
    },
    resolve() {
      accepted = true;
    },
  });
  store.receive('host', {
    type: 'lobby-response',
    request: '1',
    data: { schema: protocol.ROOM_SCHEMA, members: { host: {}, guest: {} } },
  });
  assert.match(error.message, /versions do not match/);
  assert.equal(accepted, false);
  store.receive('host', {
    type: 'lobby-state',
    data: { schema: protocol.ROOM_SCHEMA, members: { host: {}, guest: {} } },
  });
  assert.equal(rejected, true);
  assert.equal(ended, true);
  assert.equal(accepted, false);
});

test('duo start requires a second connected client even when AI fill is enabled', async () => {
  const { room, store } = await fixture('pairs');
  await store.selectSlots('room', 'host', [0, 1]);
  assert.equal(protocol.lobbyReady(room.data), false);
  await assert.rejects(
    store.beginMatch('room', 'host', {}),
    /Two connected duo clients/
  );
  assert.equal(room.data.status, 'lobby');
  await store.enqueue('guest', 'claim', {
    compatibility: clientVersion.CLIENT_VERSION,
    name: ['A', 'B'],
    slots: [2, 3],
  });
  assert.equal(protocol.lobbyReady(room.data), true);
  await assert.rejects(store.beginMatch('room', 'host', {}), /connect/);
  await store.networkReady('room', 'guest', 0, true);
  await store.beginMatch('room', 'host', {});
  assert.equal(room.data.status, 'playing');
});

test('serialized solo departures republish the lobby only after the last opponent leaves', async () => {
  const { room, store, calls } = await fixture();
  await store.selectSlots('room', 'host', [0]);
  for (const [id, slot] of [
    ['a', 1],
    ['b', 2],
    ['c', 3],
  ]) {
    await store.enqueue(id, 'claim', {
      compatibility: clientVersion.CLIENT_VERSION,
      name: id,
      slots: [slot],
    });
    await store.networkReady('room', id, 0, true);
  }
  await store.beginMatch('room', 'host', {});
  await store.remove('room', 'not-admitted');
  assert.equal(room.data.status, 'playing');
  await store.remove('room', 'a');
  assert.equal(room.data.status, 'playing');
  await Promise.all([store.remove('room', 'b'), store.remove('room', 'c')]);
  assert.equal(room.data.status, 'lobby');
  assert.deepEqual(Object.keys(room.data.members), ['host']);
  assert.equal(calls.at(-1)[0], 'publish');
});

test('a lone solo host cannot start even through the lobby API; a second connected player enables AI-filled matches', async () => {
  const { room, store } = await fixture();
  await store.selectSlots('room', 'host', [0]);
  assert.equal(protocol.lobbyReady(room.data), false);
  await assert.rejects(
    store.beginMatch('room', 'host', {}),
    /At least two connected players/
  );
  assert.equal(room.data.status, 'lobby');
  await store.enqueue('guest', 'claim', {
    compatibility: clientVersion.CLIENT_VERSION,
    name: 'Guest',
    slots: [2],
  });
  await assert.rejects(store.beginMatch('room', 'host', {}), /connect/);
  await store.networkReady('room', 'guest', 0, true);
  assert.equal(protocol.lobbyReady(room.data), true);
  await store.beginMatch('room', 'host', {});
  assert.equal(room.data.status, 'playing');
});

test('visibility is host-only, live, and blocks stale Quick Match claims without blocking invitations', async () => {
  const { room, store, calls } = await fixture();
  assert.equal(room.data.visibility, 'private');
  const claim = {
    compatibility: clientVersion.CLIENT_VERSION,
    name: 'Guest',
    slots: [],
  };
  await assert.rejects(
    store.enqueue('a', 'claim', { ...claim, quickMatch: true }),
    /private/
  );
  await store.enqueue('a', 'claim', claim);
  await assert.rejects(
    store.enqueue('a', 'visibility', { value: 'public' }),
    /Only the host/
  );
  await assert.rejects(
    store.enqueue('host', 'visibility', { value: 'invalid' }),
    /visibility/
  );
  const previousCalls = calls.length;
  await store.enqueue('host', 'visibility', { value: 'public' });
  await store.enqueue('b', 'claim', { ...claim, quickMatch: true });
  room.data.status = 'playing';
  await store.enqueue('host', 'visibility', { value: 'private' });
  assert.equal(room.data.status, 'playing');
  assert.equal(room.data.visibility, 'private');
  assert.equal(
    calls.length,
    previousCalls,
    'Visibility changes must not write Firestore or restart the match'
  );
});

test('costumes are per-local-player lobby metadata and duplicate choices are allowed', async () => {
  const { room, store, calls } = await fixture('pairs');
  assert.deepEqual(room.data.members.host.skins, ['classic', 'classic']);
  await store.enqueue('a', 'claim', {
    compatibility: clientVersion.CLIENT_VERSION,
    name: ['A', 'B'],
    slots: [],
    skins: ['cap', 'scarf'],
  });
  const writes = calls.length;
  await store.enqueue('a', 'skin', { index: 0, skinId: 'cap-scarf' });
  await store.enqueue('a', 'skin', {
    index: 1,
    skinId: 'cap-scarf',
    clientId: 'host',
  });
  assert.deepEqual(room.data.members.a.skins, ['cap-scarf', 'cap-scarf']);
  assert.deepEqual(room.data.members.host.skins, ['classic', 'classic']);
  await store.enqueue('a', 'selectSlots', { slots: [2, 3] });
  assert.deepEqual(protocol.slotSkins(room.data.members), [
    'classic',
    'classic',
    'cap-scarf',
    'cap-scarf',
  ]);
  await store.enqueue('a', 'rename', { names: ['New A', 'New B'] });
  assert.deepEqual(room.data.members.a.skins, ['cap-scarf', 'cap-scarf']);
  for (const args of [
    { index: 2, skinId: 'cap' },
    { index: 0, skinId: 'unknown' },
    { index: 0, skinId: '__proto__' },
  ])
    await assert.rejects(store.enqueue('a', 'skin', args), /Invalid costume/);
  assert.equal(calls.length, writes, 'Costumes must not write Firestore');
  await store.randomizeSlots();
  const resolved = protocol.slotSkins(room.data.members);
  for (const member of Object.values(room.data.members))
    member.slots.forEach((slot, i) =>
      assert.equal(resolved[slot], member.skins[i])
    );
  room.data.status = 'playing';
  await assert.rejects(
    store.enqueue('a', 'skin', { index: 0, skinId: 'scarf' }),
    /only available in the lobby/
  );
});
