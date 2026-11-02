'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const base = path.join(__dirname, '../src/resources/js');
function load(file, names, bindings = {}) {
  const context = vm.createContext(bindings);
  const source = fs
    .readFileSync(path.join(base, file), 'utf8')
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?\r?\n/gm, '')
    .replace(/export /g, '');
  vm.runInContext(source + '\nthis.result={' + names.join(',') + '};', context);
  return context.result;
}
const config = load('offline_2v2/doubles_config.js', [
  'DOUBLES_CONFIG',
]).DOUBLES_CONFIG;
const protocol = load(
  'online_2v2/protocol.js',
  [
    'ROOM_SCHEMA',
    'playerNames',
    'playerName',
    'lobbyReady',
    'matchSettings',
    'canUpdateLive',
    'validSlots',
    'occupiedSlots',
    'normalizeInput',
    'ownedInputs',
    'RemoteInput',
  ],
  { DOUBLES_CONFIG: config }
);
const plain = (value) => JSON.parse(JSON.stringify(value));

test('online settings match the preserved 2v2 defaults and validate incoming values', () => {
  assert.deepEqual(plain(protocol.matchSettings()), {
    courtWidth: 384,
    serveMode: 'rotate-ball',
    fps: 25,
    winningScore: 15,
    practice: false,
    synchronization: 'lockstep',
  });
  for (const invalid of [
    { courtWidth: 215 },
    { courtWidth: Infinity },
    { courtWidth: 384.5 },
    { serveMode: 'bogus' },
    { fps: 60 },
    { winningScore: 99 },
    { synchronization: 'bogus' },
  ]) {
    assert.throws(() => protocol.matchSettings(invalid));
  }
});

test('both lobby arrangements have unambiguous player ownership', () => {
  for (let slot = 0; slot < 4; slot++)
    assert.equal(protocol.validSlots('four', [slot]), true);
  assert.equal(protocol.validSlots('pairs', [0, 1]), true);
  assert.equal(protocol.validSlots('pairs', [2, 3]), true);
  for (const invalid of [[0, 2], [1, 0], [0], [3, 3], []])
    assert.equal(protocol.validSlots('pairs', invalid), false);
  assert.equal(protocol.validSlots('four', [0, 1]), false);
  assert.equal(protocol.validSlots('four', [-1]), false);
  assert.equal(protocol.validSlots('four', [4]), false);
});

test('peer inputs cannot control another slot or replay an old match or sequence', () => {
  const packet = {
    type: 'input',
    epoch: 'match-1',
    seq: 2,
    inputs: [{ slot: 2, xDirection: 1, yDirection: -1, powerHit: 1 }],
  };
  assert.deepEqual(plain(protocol.ownedInputs(packet, [2], 'match-1', 1)), [
    { slot: 2, input: { xDirection: 1, yDirection: -1, powerHit: 1 } },
  ]);
  assert.equal(protocol.ownedInputs(packet, [3], 'match-1', 1), null);
  assert.equal(protocol.ownedInputs(packet, [2], 'match-2', 1), null);
  assert.equal(protocol.ownedInputs(packet, [2], 'match-1', 2), null);
  assert.equal(
    protocol.ownedInputs({ ...packet, seq: NaN }, [2], 'match-1', 1),
    null
  );
  assert.equal(
    protocol.ownedInputs(
      { ...packet, inputs: [packet.inputs[0], packet.inputs[0]] },
      [2, 3],
      'match-1',
      1
    ),
    null
  );
  assert.deepEqual(
    plain(
      protocol.normalizeInput({
        xDirection: 99,
        yDirection: 'left',
        powerHit: true,
      })
    ),
    { xDirection: 0, yDirection: 0, powerHit: 0 }
  );
});

test('input buffering retains a hit until a simulation step and releases stale movement', () => {
  const input = new protocol.RemoteInput();
  input.push({ xDirection: 1, yDirection: -1, powerHit: 1 });
  input.push({ xDirection: 1, yDirection: 0, powerHit: 0 });
  input.getInput();
  assert.equal(input.powerHit, 1);
  assert.equal(input.xDirection, 1);
  input.getInput();
  assert.equal(input.powerHit, 0);
  input.push(
    { xDirection: -1, yDirection: -1, powerHit: 1 },
    Date.now() - 1000
  );
  input.getInput();
  assert.equal(input.powerHit, 0);
  assert.equal(input.xDirection, 0);
  assert.equal(input.yDirection, 0);
});

function fakeStore() {
  const documents = new Map();
  let queue = Promise.resolve();
  const bindings = {
    initializeApp: () => ({}),
    getApps: () => [],
    firebaseConfig: {},
    getFirestore: () => ({}),
    doc: (db, ...parts) => parts.join('/'),
    collection: () => null,
    serverTimestamp: () => 'timestamp',
    deleteField: () => null,
    ...protocol,
    runTransaction: (db, action) => {
      const result = queue.then(() =>
        action({
          get: async (key) => ({
            exists: () => documents.has(key),
            data: () => plain(documents.get(key)),
          }),
          set: (key, value) => documents.set(key, plain(value)),
          update: (key, value) => {
            const data = documents.get(key);
            for (const [field, entry] of Object.entries(value)) {
              const [parent, child] = field.split('.');
              if (child) data[parent][child] = plain(entry);
              else data[parent] = plain(entry);
            }
          },
        })
      );
      queue = result.catch(() => {});
      return result;
    },
  };
  const { FirebaseRoomStore } = load(
    'online_2v2/firebase_store.js',
    ['FirebaseRoomStore'],
    bindings
  );
  return { store: new FirebaseRoomStore(), documents };
}

test('transactional claims reject duplicate positions and joining after a match starts', async () => {
  const { store, documents } = fakeStore();
  await store.create('room', 'host', 'Host', 'four', [0], {});
  const results = await Promise.allSettled([
    store.claim('room', 'one', 'One', [1]),
    store.claim('room', 'two', 'Two', [1]),
  ]);
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1
  );
  assert.equal(
    results.filter((result) => result.status === 'rejected').length,
    1
  );
  await store.claim('room', 'three', 'Three', [2]);
  await store.claim('room', 'four', 'Four', [3]);
  assert.equal(Object.keys(documents.get('rooms/room').members).length, 4);
  documents.get('rooms/room').status = 'playing';
  await assert.rejects(store.claim('room', 'late', 'Late', [1]));
});

test('a pair occupies exactly one whole team and cannot claim a mixed team', async () => {
  const { store, documents } = fakeStore();
  await store.create('pair-room', 'host', 'Host', 'pairs', [2, 3], {});
  await assert.rejects(store.claim('pair-room', 'mixed', 'Mixed', [0, 2]));
  await store.claim('pair-room', 'guest', 'Guest', [0, 1]);
  assert.deepEqual(
    plain(documents.get('rooms/pair-room').members.guest.slots),
    [0, 1]
  );
});
const codec = load('online_2v2/session.js', [
  'captureSnapshot',
  'validSnapshot',
]);
function snapshotGame() {
  return {
    scores: [2, 3],
    gameEnded: false,
    players: Array.from({ length: 4 }, (_, i) => ({
      x: 36 + i * 192,
      y: 244,
      state: 0,
      frameNumber: 0,
      isPlayer2: i >= 2,
      isComputer: false,
      coverageRole: i === 0 || i === 3 ? 'back' : 'front',
    })),
    physics: {
      ball: {
        x: 100,
        y: 90,
        xVelocity: 6,
        yVelocity: -15,
        punchEffectRadius: 12,
        rotation: 1,
      },
    },
    view: {
      game: {
        cloudArray: Array.from({ length: 10 }, () => ({
          topLeftPointX: 0,
          topLeftPointY: 20,
          topLeftPointXVelocity: 1,
          sizeDiffTurnNumber: 0,
        })),
        wave: { yCoords: Array(27).fill(300) },
        messages: {
          ready: { x: 0, y: 0, width: 80, height: 20, visible: false },
        },
      },
      fadeInOut: { black: { alpha: 0 } },
    },
  };
}

test('snapshot capture preserves the authoritative game and includes four players and effects', () => {
  const game = snapshotGame();
  const before = plain(game);
  const packet = codec.captureSnapshot(game, 'match', 10, 'playing', [
    { name: 'pika', side: 1 },
  ]);
  assert.deepEqual(plain(game), before);
  assert.equal(packet.players.length, 4);
  assert.equal(packet.ball.punchEffectRadius, 12);
  assert.equal(packet.events[0].name, 'pika');
  assert.equal(
    codec.validSnapshot(JSON.parse(JSON.stringify(packet)), 'match', 9),
    true
  );
});

test('snapshot receivers reject old matches, duplicate frames, and malformed state', () => {
  const packet = codec.captureSnapshot(snapshotGame(), 'match', 10, 'playing');
  assert.equal(codec.validSnapshot(packet, 'older-match', 0), false);
  assert.equal(codec.validSnapshot(packet, 'match', 10), false);
  assert.equal(
    codec.validSnapshot({ ...packet, ball: { x: NaN, y: 0 } }, 'match', 0),
    false
  );
  assert.equal(
    codec.validSnapshot(
      { ...packet, players: packet.players.slice(0, 3) },
      'match',
      0
    ),
    false
  );
  assert.equal(
    codec.validSnapshot({ ...packet, scores: [999, 0] }, 'match', 0),
    false
  );
});
const { QuickMatch } = load('online_2v2/quick_match.js', ['QuickMatch'], {
  setTimeout,
  clearTimeout,
});
test('Quick Match creates and advertises an immediately playable host room', async () => {
  const calls = [];
  const room = {
    closed: true,
    isHost: true,
    id: 'a'.repeat(20),
    data: { status: 'lobby' },
    async create(name, layout, slots, settings) {
      this.closed = false;
      assert.equal(layout, 'four');
      assert.deepEqual(plain(slots), []);
      assert.equal(settings.courtWidth, 384);
    },
  };
  const quick = new QuickMatch({
    room,
    request: async (packet) => {
      calls.push(packet.action);
      return packet.action === 'find'
        ? { action: 'create', slots: [0] }
        : { action: 'advertised' };
    },
  });
  await quick.start({
    name: 'Host',
    layout: 'four',
    settings: { courtWidth: 384 },
  });
  assert.deepEqual(calls, ['find', 'publish']);
  assert.equal(quick.active, true);
  await quick.stop();
  assert.equal(
    room.closed,
    false,
    'Withdrawing the advert must not close the match'
  );
});
test('Quick Match retries an occupied advisory seat and acknowledges the eventual join', async () => {
  const calls = [];
  let attempts = 0;
  const room = {
    closed: true,
    isHost: false,
    async join() {
      if (++attempts === 1) throw Error('That position is already occupied.');
      this.closed = false;
    },
  };
  const quick = new QuickMatch({
    room,
    wait: async () => {},
    request: async (packet) => {
      calls.push(packet.action);
      return { action: 'join', roomId: 'a'.repeat(20), slots: [2, 3] };
    },
  });
  await quick.start({ layout: 'pairs' });
  assert.deepEqual(calls, ['find', 'cancel', 'find', 'joined']);
  assert.equal(quick.active, false);
});
test('Quick Match cancellation ignores an in-flight assignment', async () => {
  let resolveFind;
  const room = {
    closed: true,
    async create() {
      assert.fail('Cancelled searches must not create a room');
    },
  };
  const quick = new QuickMatch({
    room,
    request: (packet) =>
      packet.action === 'find'
        ? new Promise((resolve) => {
            resolveFind = resolve;
          })
        : Promise.resolve({ action: 'cancelled' }),
  });
  const pending = quick.start({ layout: 'four' });
  await quick.stop();
  resolveFind({ action: 'create', slots: [0] });
  await pending;
  assert.equal(quick.active, false);
});
test('Quick Match surfaces permission errors rather than retrying indefinitely', async () => {
  const room = {
    closed: true,
    isHost: false,
    async join() {
      throw Error('permission-denied');
    },
  };
  const quick = new QuickMatch({
    room,
    request: async () => ({ action: 'join', slots: [1] }),
  });
  await assert.rejects(quick.start({ layout: 'four' }), /permission-denied/);
  assert.equal(quick.active, false);
});

test('solo aliases combine directions and power-hit edges, and unsubscribe every physical key', () => {
  const listeners = { keydown: new Set(), keyup: new Set() };
  const fakeWindow = {
    addEventListener(type, listener) {
      listeners[type].add(listener);
    },
    removeEventListener(type, listener) {
      listeners[type].delete(listener);
    },
  };
  const { PikaKeyboard } = load('offline_2v2/keyboard.js', ['PikaKeyboard'], {
    window: fakeWindow,
    PikaUserInput: class {},
  });
  const { createAliasedKeyboard } = load(
    'online_2v2/keyboard_aliases.js',
    ['createAliasedKeyboard'],
    { PikaKeyboard }
  );
  const keyboard = createAliasedKeyboard(
    ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter'],
    ['KeyD', 'KeyG', 'KeyR', 'KeyV', 'KeyZ', 'KeyF']
  );
  const event = (type, code) => {
    for (const listener of listeners[type])
      listener({ code, preventDefault() {} });
    keyboard.getInput();
  };
  event('keydown', 'KeyG');
  assert.equal(keyboard.xDirection, 1);
  event('keydown', 'ArrowLeft');
  assert.equal(keyboard.xDirection, -1);
  event('keyup', 'ArrowLeft');
  assert.equal(keyboard.xDirection, 1);
  event('keyup', 'KeyG');
  assert.equal(keyboard.xDirection, 0);
  event('keydown', 'KeyF');
  assert.equal(keyboard.xDirection, 1);
  assert.equal(keyboard.yDirection, 1);
  event('keydown', 'ArrowUp');
  assert.equal(keyboard.yDirection, -1);
  event('keyup', 'KeyF');
  event('keyup', 'ArrowUp');
  event('keydown', 'Enter');
  assert.equal(keyboard.powerHit, 1);
  event('keydown', 'KeyZ');
  assert.equal(keyboard.powerHit, 0);
  event('keyup', 'Enter');
  assert.equal(keyboard.powerHit, 0);
  event('keyup', 'KeyZ');
  event('keydown', 'KeyZ');
  assert.equal(keyboard.powerHit, 1);
  keyboard.unsubscribe();
  assert.equal(listeners.keydown.size, 0);
  assert.equal(listeners.keyup.size, 0);
  keyboard.subscribe();
  event('keydown', 'KeyD');
  assert.equal(keyboard.xDirection, -1);
  keyboard.unsubscribe();
});

const { RoomChat } = load('online_2v2/chat.js', ['RoomChat'], {
  crypto: require('node:crypto').webcrypto,
  Math: {
    random() {
      throw Error('Chat must not consume the physics RNG');
    },
  },
});
test('room chat authenticates sender ownership and relays to all guests without affecting physics', () => {
  let now = 1000;
  const received = [],
    sent = [];
  const room = {
    id: 'room1',
    selfId: 'host',
    isHost: true,
    closed: false,
    data: {
      hostId: 'host',
      members: {
        host: { name: 'Host', slots: [0] },
        guest: { name: 'Guest', slots: [2, 3] },
      },
    },
    broadcast: (packet) => sent.push(plain(packet)),
  };
  const chat = new RoomChat(
    room,
    (packet) => received.push(plain(packet)),
    () => now
  );
  assert.equal(
    chat.receive('guest', {
      type: 'chat',
      text: 'Hello',
      sender: 'host',
      name: 'Imposter',
    }),
    true
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].name, 'Guest');
  assert.equal(sent[0].sender, 'guest');
  assert.deepEqual(sent[0].slots, [2]);
  chat.receive('intruder', { type: 'chat', text: 'No' });
  assert.equal(sent.length, 1);
  chat.receive('guest', { type: 'chat', text: 'Too fast' });
  assert.equal(sent.length, 1);
  now += 500;
  chat.receive('guest', { type: 'chat', text: 'Next' });
  assert.equal(sent.length, 2);
  chat.receive('host', { type: 'chat', text: 'x'.repeat(51) });
  assert.equal(sent.length, 2);
  assert.equal(chat.send('Host here'), true);
  assert.equal(received.length, 3);
});
test('guests accept chat only from the host and reject duplicates, old rooms and malformed messages', () => {
  const shown = [];
  const room = {
    id: 'room1',
    selfId: 'guest',
    isHost: false,
    closed: false,
    data: { hostId: 'host' },
    send: () => true,
  };
  const chat = new RoomChat(room, (packet) => shown.push(packet));
  const packet = {
    type: 'chat-message',
    roomId: 'room1',
    seq: 1,
    name: 'Host',
    slots: [0],
    text: '<img src=x onerror=alert(1)>',
    sender: 'host',
    position: { top: 35, offset: 70, side: 'left' },
  };
  chat.receive('other', packet);
  assert.equal(shown.length, 0);
  chat.receive('host', packet);
  assert.equal(shown.length, 1);
  chat.receive('host', packet);
  assert.equal(shown.length, 1);
  chat.receive('host', { ...packet, seq: 2, roomId: 'previous' });
  assert.equal(shown.length, 1);
  chat.receive('host', { ...packet, seq: 2, slots: [9] });
  assert.equal(shown.length, 1);
  chat.enabled = false;
  chat.receive('host', { ...packet, seq: 2 });
  assert.equal(shown.length, 1);
  assert.equal(chat.send('Muted'), false);
  room.id = 'room2';
  chat.enabled = true;
  chat.receive('host', { ...packet, roomId: 'room2' });
  assert.equal(shown.length, 2);
});

test('chat positions use the original random ranges and are relayed identically to every browser', () => {
  const sent = [],
    shown = [];
  let time = 1000;
  let sample = 0;
  const room = {
    id: 'random-room',
    selfId: 'host',
    isHost: true,
    closed: false,
    data: {
      members: {
        host: { name: 'Host', slots: [0] },
        right: { name: 'Right', slots: [3] },
      },
    },
    broadcast: (p) => sent.push(plain(p)),
  };
  const chat = new RoomChat(
    room,
    (p) => shown.push(plain(p)),
    () => time,
    () => {
      sample += 0.1;
      return sample;
    }
  );
  chat.send('First');
  time += 500;
  chat.send('Second');
  chat.receive('right', { type: 'chat', text: 'Right side' });
  assert.deepEqual(sent, shown);
  assert.notDeepEqual(sent[0].position, sent[1].position);
  for (const packet of sent) {
    assert.ok(packet.position.top >= 20 && packet.position.top <= 50);
    assert.ok(packet.position.offset >= 55 && packet.position.offset <= 80);
  }
  assert.equal(sent[0].position.side, 'left');
  assert.equal(sent[2].position.side, 'right');
});

test('lobby entry is unassigned; competing selections, cancelling, names and atomic start preserve ownership', async () => {
  const { store, documents } = fakeStore();
  await store.create('lobby', 'host', ['Host'], 'four', [], {});
  await store.claim('lobby', 'guest', ['Guest'], []);
  assert.deepEqual(plain(documents.get('rooms/lobby').seats), ['', '', '', '']);
  await assert.rejects(store.beginMatch('lobby', 'host', {}), /select a slot/);
  const attempts = await Promise.allSettled([
    store.selectSlots('lobby', 'host', [0]),
    store.selectSlots('lobby', 'guest', [0]),
  ]);
  assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 1);
  const winner = documents.get('rooms/lobby').seats[0];
  await store.selectSlots('lobby', winner, []);
  assert.equal(documents.get('rooms/lobby').seats[0], '');
  await store.selectSlots('lobby', 'host', [0]);
  await store.selectSlots('lobby', 'guest', [3]);
  await store.rename('lobby', 'guest', ['Renamed']);
  assert.deepEqual(plain(documents.get('rooms/lobby').members.guest.names), [
    'Renamed',
  ]);
  await assert.rejects(
    store.beginMatch('lobby', 'host', {}),
    /connect before starting/
  );
  documents.get('rooms/lobby').members.guest.connected = true;
  const started = await store.beginMatch('lobby', 'host', { practice: true });
  assert.equal(started.settings.practice, true);
  await assert.rejects(
    store.selectSlots('lobby', 'guest', []),
    /only change in the lobby/
  );
});
test('pair names follow local player order across whole-team switches and mixed slots are rejected', async () => {
  const { store, documents } = fakeStore();
  await store.create('pairs', 'host', ['Alice', 'Bob'], 'pairs', [], {});
  await store.selectSlots('pairs', 'host', [0, 1]);
  await store.selectSlots('pairs', 'host', [2, 3]);
  const member = documents.get('rooms/pairs').members.host;
  assert.equal(protocol.playerName(member, 2), 'Alice');
  assert.equal(protocol.playerName(member, 3), 'Bob');
  await assert.rejects(store.selectSlots('pairs', 'host', [0, 2]));
  await store.selectSlots('pairs', 'host', []);
  assert.deepEqual(plain(documents.get('rooms/pairs').seats), ['', '', '', '']);
});
test('pair chat selects the actual local player name and rejects spoofed speaker indexes', () => {
  const packets = [];
  let now = 1000;
  const room = {
    id: 'pair-chat',
    isHost: true,
    closed: false,
    selfId: 'host',
    data: {
      members: {
        host: { name: 'Alice', names: ['Alice', 'Bob'], slots: [2, 3] },
      },
    },
    broadcast: (p) => packets.push(plain(p)),
  };
  const chat = new RoomChat(
    room,
    () => {},
    () => now
  );
  assert.equal(chat.send('Bob here', 1), true);
  assert.equal(packets[0].name, 'Bob');
  assert.deepEqual(packets[0].slots, [3]);
  now += 500;
  assert.equal(chat.send('No one', 2), false);
});

test('a guest receiving its slot update after match start refreshes controls without running physics', () => {
  const { OnlineMatch } = load('online_2v2/session.js', ['OnlineMatch']);
  let bindings = 0;
  const guest = {
    epoch: 'active',
    localSlots: [],
    room: {
      isHost: false,
      selfId: 'me',
      data: { members: { me: { slots: [3] } } },
    },
    bindLocalKeys() {
      bindings++;
      this.localSlots = [3];
    },
  };
  OnlineMatch.prototype.refreshRoster.call(guest);
  assert.equal(bindings, 1);
  OnlineMatch.prototype.refreshRoster.call(guest);
  assert.equal(bindings, 1);
  guest.epoch = null;
  guest.localSlots = [];
  OnlineMatch.prototype.refreshRoster.call(guest);
  assert.equal(bindings, 1);
});

test('authentication is private to each tab, coalesces concurrent sign-ins, and reuses its own token', async () => {
  const makeTab = () => {
    const apps = [];
    let calls = 0;
    const persistence = { type: 'NONE' };
    const { FirebaseRoomStore } = load(
      'online_2v2/firebase_store.js',
      ['FirebaseRoomStore'],
      {
        firebaseConfig: { projectId: 'test-project', apiKey: 'test-key' },
        getApps: () => apps,
        initializeApp: (config, name) => {
          const app = { name };
          apps.push(app);
          return app;
        },
        initializeAuth: (app, options) => {
          assert.equal(options.persistence, persistence);
          return app.auth || (app.auth = { currentUser: null });
        },
        inMemoryPersistence: persistence,
        getFirestore: () => ({}),
        signInAnonymously: async (auth) => {
          calls++;
          await Promise.resolve();
          auth.currentUser = {
            uid: Math.random().toString(),
            getIdToken: async () => 'tab-token',
          };
        },
      }
    );
    return { store: new FirebaseRoomStore(), count: () => calls };
  };
  const first = makeTab(),
    second = makeTab();
  const [one, again, two] = await Promise.all([
    first.store.identity(),
    first.store.identity(),
    second.store.identity(),
  ]);
  assert.equal(one, again);
  assert.notEqual(one, two);
  assert.equal(first.count(), 1);
  assert.equal(await first.store.token(), 'tab-token');
  assert.equal(first.count(), 1);
});

const { Lockstep, INPUT_WINDOW } = load(
  'online_2v2/lockstep.js',
  ['Lockstep', 'INPUT_WINDOW'],
  {
    normalizeInput: protocol.normalizeInput,
  }
);
function lockstepFixture(layout = 'four') {
  const members =
    layout === 'pairs'
      ? { host: { slots: [2, 3] }, a: { slots: [0, 1] } }
      : {
          host: { slots: [0] },
          a: { slots: [1] },
          b: { slots: [2] },
          c: { slots: [3] },
        };
  const network = [],
    nodes = {},
    logs = {};
  for (const id of Object.keys(members)) {
    logs[id] = [];
    nodes[id] = new Lockstep({
      epoch: 'match',
      selfId: id,
      hostId: 'host',
      members,
      send: (to, packet) => network.push({ from: id, to, packet }),
      broadcast: (packet) =>
        Object.keys(members)
          .filter((peer) => peer !== id)
          .forEach((to) => network.push({ from: id, to, packet })),
      advance: (inputs, humans, frame) =>
        logs[id].push(plain({ inputs, humans, frame })),
    });
  }
  const sample = (id, hit = 0) =>
    nodes[id].sample(
      members[id].slots.map((slot) => ({
        slot,
        xDirection: slot % 2 ? 1 : -1,
        yDirection: 0,
        powerHit: hit,
      }))
    );
  const deliver = () => {
    while (network.length) {
      const item = network.shift();
      nodes[item.to].receive(item.from, item.packet);
    }
  };
  return { members, nodes, logs, network, sample, deliver };
}
test('lockstep stalls for missing input, pipelines a bounded number of frames and simulates identically on all browsers', () => {
  for (const layout of ['four', 'pairs']) {
    const f = lockstepFixture(layout);
    for (let i = 0; i < INPUT_WINDOW + 5; i++)
      f.sample('host', i === 0 ? 1 : 0);
    f.deliver();
    assert.equal(f.nodes.host.frame, 0);
    assert.equal(f.nodes.host.sampled, INPUT_WINDOW);
    for (let round = 0; round < 300; round++) {
      for (const id of Object.keys(f.members).reverse())
        f.sample(id, round % 11 === 0 ? 1 : 0);
      f.deliver();
    }
    assert.ok(f.logs.host.length >= 298);
    for (const id of Object.keys(f.members))
      assert.deepEqual(f.logs[id], f.logs.host);
    assert.equal(f.logs.host[0].inputs[layout === 'pairs' ? 2 : 0].powerHit, 1);
  }
});
test('lockstep rejects spoofed slots, stale epochs, duplicate frames and excessive future queues', () => {
  const f = lockstepFixture('pairs'),
    host = f.nodes.host;
  const packet = {
    type: 'frame-input',
    epoch: 'match',
    generation: 0,
    frame: 1,
    inputs: [{ slot: 0 }, { slot: 1 }],
  };
  for (const bad of [
    { ...packet, epoch: 'old' },
    { ...packet, frame: 0 },
    { ...packet, frame: 4 },
    { ...packet, inputs: [{ slot: 2 }, { slot: 3 }] },
    { ...packet, inputs: [null, null] },
    { ...packet, inputs: [{ slot: 0 }, { slot: 0 }] },
  ])
    assert.equal(host.receive('a', bad), false);
  assert.equal(host.receive('stranger', packet), false);
  assert.equal(host.receive('a', packet), true);
  assert.equal(host.receive('a', packet), false);
  const guest = f.nodes.a;
  assert.equal(
    guest.receive('a', {
      type: 'frame',
      epoch: 'match',
      generation: 0,
      frame: 1,
      inputs: [0, 0, 0, 0],
      humans: [0, 1, 2, 3],
    }),
    false
  );
  assert.equal(host.pending.size, 1);
});
test('lockstep pause generations discard queued inputs and reject pre-pause packets; disconnects switch slots to AI on the same frame', () => {
  const f = lockstepFixture('four');
  for (const id of Object.keys(f.members)) f.sample(id);
  f.deliver();
  for (const node of Object.values(f.nodes)) {
    assert.equal(node.control(1, true), true);
    assert.equal(node.control(1, false), false);
  }
  f.sample('a', 1);
  assert.equal(f.network.length, 0);
  for (const node of Object.values(f.nodes)) node.control(2, false);
  f.sample('a', 1);
  const stale = f.network.shift();
  stale.packet.generation = 0;
  assert.equal(f.nodes.host.receive('a', stale.packet), false);
  f.nodes.host.remove('a');
  for (const id of ['host', 'b', 'c']) f.sample(id);
  f.deliver();
  assert.deepEqual(f.logs.host[1].humans, [0, 2, 3]);
  assert.deepEqual(f.logs.host[1], f.logs.b[1]);
  assert.deepEqual(f.logs.host[1].inputs[1], {
    xDirection: 0,
    yDirection: 0,
    powerHit: 0,
  });
});

test('only speed and practice can change without rebuilding a match', () => {
  const current = protocol.matchSettings();
  assert.equal(
    protocol.canUpdateLive(
      current,
      protocol.matchSettings({ fps: 30, practice: true })
    ),
    true
  );
  assert.equal(protocol.canUpdateLive(current, current), true);
  for (const changed of [
    { courtWidth: 500 },
    { serveMode: 'fixed' },
    { winningScore: 5 },
    { synchronization: 'host' },
  ])
    assert.equal(
      protocol.canUpdateLive(current, protocol.matchSettings(changed)),
      false
    );
});
test('live settings preserve match objects and paused state, persist on the host and synchronize at a lockstep boundary', async () => {
  const { OnlineMatch } = load('online_2v2/session.js', ['OnlineMatch'], {
    matchSettings: protocol.matchSettings,
    canUpdateLive: protocol.canUpdateLive,
    setInterval: () => 42,
    clearInterval: () => {},
  });
  for (const lockstep of [false, true]) {
    const sent = [],
      persisted = [];
    const game = {
      normalFPS: 25,
      isPracticeMode: false,
      paused: true,
      scores: [4, 7],
      physics: { ball: { x: 123, y: 87 }, nextServer: [1, 0] },
      frameCounter: 12,
    };
    const before = plain(game);
    const session = Object.assign(Object.create(OnlineMatch.prototype), {
      game,
      ticker: { maxFPS: 25 },
      settings: protocol.matchSettings(),
      epoch: 'same-match',
      phase: 'paused',
      frame: 64,
      localSlots: [0],
      room: {
        id: 'room',
        isHost: true,
        closed: false,
        store: { update: async (...args) => persisted.push(args) },
        broadcast: (packet) => sent.push(packet),
      },
      lockstep: lockstep
        ? {
            generation: 2,
            frame: 64,
            control(generation, paused) {
              this.generation = generation;
              this.paused = paused;
            },
          }
        : null,
      inputs: [{ reset() {} }],
      notify() {},
      sendState() {},
    });
    const physics = game.physics,
      scores = game.scores;
    await session.updateLiveSettings({ fps: 30, practice: true });
    assert.equal(session.epoch, 'same-match');
    assert.equal(session.phase, 'paused');
    assert.equal(game.physics, physics);
    assert.equal(game.scores, scores);
    assert.equal(game.paused, true);
    assert.equal(game.frameCounter, before.frameCounter);
    assert.equal(game.normalFPS, 30);
    assert.equal(session.ticker.maxFPS, 30);
    assert.equal(game.isPracticeMode, true);
    assert.equal(persisted.length, 1);
    assert.equal(sent[0].type, lockstep ? 'frame-control' : 'live-settings');
    if (lockstep) {
      assert.equal(sent[0].frame, 64);
      assert.equal(sent[0].paused, true);
      assert.equal(sent[0].generation, 3);
    }
    await assert.rejects(
      session.updateLiveSettings({ courtWidth: 700 }),
      /restart/
    );
    assert.equal(persisted.length, 1);
  }
});

test('guests accept live options only from the current host and retain a finished match', () => {
  const { OnlineMatch } = load('online_2v2/session.js', ['OnlineMatch'], {
    matchSettings: protocol.matchSettings,
    canUpdateLive: protocol.canUpdateLive,
  });
  let applied = 0;
  const guest = Object.assign(Object.create(OnlineMatch.prototype), {
    room: { closed: false, isHost: false, data: { hostId: 'host' } },
    epoch: 'match',
    phase: 'finished',
    settings: protocol.matchSettings(),
    game: { paused: true },
    inputs: [],
    lockstep: lockstepFixture('pairs').nodes.a,
    applyLiveSettings(settings) {
      applied++;
      this.settings = settings;
    },
    notify() {},
  });
  const packet = {
    type: 'frame-control',
    epoch: 'match',
    frame: 0,
    generation: 1,
    paused: true,
    settings: protocol.matchSettings({ fps: 30, practice: true }),
  };
  guest.message('stranger', packet);
  guest.message('host', { ...packet, epoch: 'old' });
  guest.message('host', {
    ...packet,
    settings: protocol.matchSettings({ synchronization: 'host' }),
  });
  assert.equal(applied, 0);
  guest.message('host', packet);
  assert.equal(applied, 1);
  assert.equal(guest.settings.fps, 30);
  assert.equal(guest.phase, 'finished');
  assert.equal(guest.game.paused, true);
  guest.message('host', packet);
  assert.equal(applied, 1);
});
