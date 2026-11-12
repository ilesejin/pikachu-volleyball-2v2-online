const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
function load(file, names, bindings = {}) {
  const source = fs
    .readFileSync(path.join(__dirname, '../src/resources/js', file), 'utf8')
    .replace(/^import\s+['"][^'"]+['"];?\r?\n/gm, '')
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?\r?\n/gm, '')
    .replace(/export /g, '');
  return Function(
    ...Object.keys(bindings),
    source + ';return {' + names.join(',') + '};'
  )(...Object.values(bindings));
}
const { getHashCode } = load('utils/hash_code.js', ['getHashCode']);
const format = load(
  'online_2v2/replay_format.js',
  [
    'REPLAY_VERSION',
    'ENGINE_ID',
    'packInputs',
    'unpackInputs',
    'encodeReplay',
    'decodeReplay',
    'copy',
    'replayChunks',
  ],
  { manifest: { files: { physics: 'test-engine' } }, getHashCode }
);
test('all legal inputs roundtrip through the four-player compact format', () => {
  for (const xDirection of [-1, 0, 1])
    for (const yDirection of [-1, 0, 1])
      for (const powerHit of [0, 1]) {
        const values = Array.from({ length: 4 }, () => ({
          xDirection,
          yDirection,
          powerHit,
        }));
        assert.deepEqual(
          format.unpackInputs(format.packInputs(values)),
          values
        );
      }
});
function pack() {
  return {
    version: format.REPLAY_VERSION,
    engine: format.ENGINE_ID,
    roomId: 'room',
    createdAt: '2026-11-12T00:00:00Z',
    complete: true,
    authoritative: true,
    events: [
      { type: 'checkpoint', dt: 0 },
      { type: 'step', dt: 1 / 30, inputs: 0, random: [123] },
    ],
  };
}
test('replay integrity and version checks reject corrupt, unsafe and incompatible files', () => {
  const valid = pack();
  assert.deepEqual(format.decodeReplay(format.encodeReplay(valid)), valid);
  assert.throws(() =>
    format.decodeReplay(format.encodeReplay(valid).replace('123', '124'))
  );
  assert.throws(
    () =>
      format.decodeReplay(
        format.encodeReplay({ ...valid, engine: 'old-engine' })
      ),
    /engine version/
  );
  assert.throws(() => format.decodeReplay('{"__proto__":{}}'));
  assert.throws(() =>
    format.decodeReplay(
      format.encodeReplay({
        ...valid,
        events: [{ type: 'step', dt: 1 / 30, inputs: 0, random: [] }],
      })
    )
  );
  assert.throws(() =>
    format.decodeReplay(
      format.encodeReplay({
        ...valid,
        events: [
          ...valid.events,
          { type: 'step', dt: 1 / 30, inputs: 2, random: [] },
        ],
      })
    )
  );
});
test('recording observes consumed inputs and RNG without changing the generated values or input methods', () => {
  let rng = null,
    draws = 0;
  const generated = [0.25, 0.75];
  const { ReplayRecorder } = load(
    'online_2v2/replay_recorder.js',
    ['ReplayRecorder'],
    {
      ...format,
      captureCheckpoint: () => ({}),
      captureSnapshot: () => ({}),
      setCustomRng: (value) => {
        rng = value;
      },
    }
  );
  const room = {
    id: 'room',
    closed: false,
    isHost: true,
    data: {
      layout: 'four',
      settings: {},
      status: 'playing',
      seats: [],
      members: {},
    },
  };
  const session = {
    room,
    epoch: 'match',
    phase: 'playing',
    settings: { fps: 30 },
    lastFrame: 0,
    rng: () => {
      draws++;
      return generated[draws - 1];
    },
    game: { players: Array.from({ length: 4 }, () => ({ isComputer: false })) },
    inputs: Array.from({ length: 4 }, () => ({
      getInput() {
        this.xDirection = 1;
        this.yDirection = -1;
        this.powerHit = 1;
      },
    })),
  };
  const methods = session.inputs.map((input) => input.getInput),
    recorder = new ReplayRecorder(session);
  recorder.frame(() => {
    session.inputs.forEach((input) => input.getInput());
    assert.equal(rng(), 0.25);
    assert.equal(rng(), 0.75);
  });
  const frame = recorder.pack.events.at(-1);
  assert.deepEqual(frame.random, [8192, 24576]);
  assert.equal(draws, 2);
  assert.equal(rng, null);
  assert.deepEqual(
    session.inputs.map((input) => input.getInput),
    methods
  );
  assert.equal(format.unpackInputs(frame.inputs)[3].powerHit, 1);
  session.epoch = 'rematch';
  recorder.frame(() => {});
  assert.equal(
    new Set(
      recorder.pack.events
        .filter((event) => event.type === 'checkpoint')
        .map((event) => event.epoch)
    ).size,
    2
  );
  assert.ok(format.decodeReplay(recorder.text()).events.length > 3);
});

test('WebRTC replay chunks preserve emoji at UTF-16 boundaries', () => {
  const text = 'a'.repeat(15999) + '🏐' + 'b'.repeat(15998) + '😀';
  const chunks = [...format.replayChunks(text)];
  assert.ok(chunks.every((chunk) => chunk.length <= 16000));
  assert.equal(
    chunks
      .map((chunk) => new TextDecoder().decode(new TextEncoder().encode(chunk)))
      .join(''),
    text
  );
});

const { normalizeLanguageDirectory } = load('online_2v2/page_route.js', [
  'normalizeLanguageDirectory',
]);
test('slashless language routes keep replay links, room queries and GitHub Pages prefixes correct', () => {
  for (const [path, expected] of [
    ['/en', '/en/'],
    ['/ko?room=abc#join', '/ko/?room=abc#join'],
    ['/project/zh', '/project/zh/'],
    ['/project/ko/replay', '/project/ko/replay/'],
  ]) {
    let current = 'https://example.com' + path;
    normalizeLanguageDirectory(
      { href: current },
      {
        state: {},
        replaceState(state, title, value) {
          current = value;
        },
      }
    );
    assert.equal(current, 'https://example.com' + expected);
    if (!current.includes('/replay/'))
      assert.ok(new URL('./replay/', current).pathname.endsWith('/replay/'));
  }
  let writes = 0;
  normalizeLanguageDirectory(
    { href: 'https://example.com/ko/' },
    {
      replaceState() {
        writes++;
      },
    }
  );
  assert.equal(writes, 0);
});

const { DoublesPlayback } = load('replay/doubles_playback.js', [
  'DoublesPlayback',
]);
test('replay chat replaces only the same speaker and retains the live five-second lifetime', () => {
  const playback = Object.create(DoublesPlayback.prototype);
  playback.chats = [];
  playback.addChat({ sender: 'pair', speaker: 0, name: 'A', text: 'first' }, 0);
  playback.addChat(
    { sender: 'pair', speaker: 1, name: 'B', text: 'partner' },
    0.5
  );
  playback.addChat(
    { sender: 'pair', speaker: 0, name: 'A', text: 'replacement' },
    1
  );
  assert.deepEqual(
    playback.chats.map((chat) => chat.packet.text),
    ['partner', 'replacement']
  );
  assert.equal(playback.chats[1].at, 1);
  assert.equal(playback.chats[1].until, 6);
  playback.addChat({ name: 'Legacy', slots: [0], text: 'old' }, 2);
  playback.addChat({ name: 'Legacy', slots: [0], text: 'old replacement' }, 3);
  assert.equal(
    playback.chats.filter((chat) => chat.packet.name === 'Legacy').length,
    1
  );
});
test('seeking rebuilds the latest chat per speaker across the full five-second window', () => {
  const p = Object.create(DoublesPlayback.prototype);
  p.events = [
    { type: 'checkpoint', dt: 0 },
    { type: 'chat', dt: 0, packet: { sender: 'a', text: 'first' } },
    { type: 'lobby', dt: 1 },
    { type: 'chat', dt: 0, packet: { sender: 'a', text: 'latest' } },
    { type: 'chat', dt: 0, packet: { sender: 'b', text: 'other' } },
    ...Array.from({ length: 7 }, () => ({ type: 'lobby', dt: 1 })),
  ];
  p.times = [0];
  p.events.forEach((e) => p.times.push(p.times.at(-1) + e.dt));
  p.checkpoints = [0];
  p.chats = [];
  p.game = { audio: { sounds: { bgm: { stop() {} } } } };
  p.render = () => {};
  p.event = function (e) {
    if (e.type === 'chat') this.addChat(e.packet, this.times[this.cursor]);
  };
  p.seek(9);
  assert.equal(p.game.timeCurrent, 5);
  assert.deepEqual(
    p.chats.map((chat) => chat.packet.text),
    ['latest', 'other']
  );
  p.seek(12);
  assert.deepEqual(p.chats, []);
});
