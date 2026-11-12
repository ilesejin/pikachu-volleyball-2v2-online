const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const root = path.join(__dirname, '../src/resources/js');
function fixture() {
  const nodes = new Map();
  function element(id, classes = ['hidden']) {
    const tokens = new Set(classes);
    return {
      id,
      style: {},
      textContent: '',
      classList: {
        add: (n) => tokens.add(n),
        remove: (n) => tokens.delete(n),
        contains: (n) => tokens.has(n),
      },
      cloneNode() {
        return element(id, [...tokens]);
      },
    };
  }
  for (const id of ['player1-chat-box', 'player2-chat-box'])
    nodes.set(id, element(id));
  const canvas = {
    replaceChild(next, previous) {
      assert.equal(nodes.get(previous.id), previous);
      nodes.set(previous.id, next);
    },
  };
  const document = {
    getElementById: (id) =>
      id === 'game-canvas-container' ? canvas : nodes.get(id),
    querySelectorAll: () => [],
  };
  const code = fs
    .readFileSync(path.join(root, 'replay/legacy_chat.js'), 'utf8')
    .replace(/export /g, '');
  const chat = Function(
    'document',
    code +
      ';return {setGetSpeechBubbleNeeded,setChatRngs,enableChat,hideChat,displayChatMessageAt};'
  )(document);
  return { chat, nodes };
}
test('old replay chat retains seeded positions and safe text without live channel state', () => {
  const { chat, nodes } = fixture();
  const left = [0.25, 0.75],
    right = [0.5, 0.1];
  chat.setChatRngs(
    () => left.shift(),
    () => right.shift()
  );
  const game = { state: () => {}, intro: () => {}, menu: () => {} };
  chat.setGetSpeechBubbleNeeded(game);
  chat.displayChatMessageAt('<b>left chat</b>', 1);
  chat.displayChatMessageAt('right chat', 2);
  assert.equal(nodes.get('player1-chat-box').textContent, '<b>left chat</b>');
  assert.deepEqual(nodes.get('player1-chat-box').style, {
    top: '27.5%',
    right: '73.75%',
  });
  assert.deepEqual(nodes.get('player2-chat-box').style, {
    top: '35%',
    left: '57.5%',
  });
  assert.equal(
    nodes.get('player1-chat-box').classList.contains('in-speech-bubble'),
    false
  );
  game.state = game.intro;
  chat.setChatRngs(
    () => 0,
    () => 0
  );
  chat.displayChatMessageAt('intro', 1);
  assert.equal(
    nodes.get('player1-chat-box').classList.contains('in-speech-bubble'),
    true
  );
});
test('legacy replay chat toggle hides both sides and does not consume RNG while disabled', () => {
  const { chat, nodes } = fixture();
  let draws = 0;
  chat.setChatRngs(
    () => {
      draws++;
      return 0.5;
    },
    () => {
      draws++;
      return 0.5;
    }
  );
  chat.displayChatMessageAt('first', 1);
  chat.displayChatMessageAt('second', 2);
  chat.enableChat(false);
  chat.hideChat();
  chat.displayChatMessageAt('hidden', 1);
  assert.equal(draws, 4);
  assert.equal(nodes.get('player1-chat-box').textContent, 'first');
  for (const n of nodes.values())
    assert.equal(n.classList.contains('hidden'), true);
  chat.enableChat(true);
  chat.displayChatMessageAt('visible', 2);
  assert.equal(draws, 6);
  assert.equal(
    nodes.get('player2-chat-box').classList.contains('hidden'),
    false
  );
});
test('replay dependency graph cannot pull in retired live P2P networking or recording', () => {
  const visited = new Set();
  const forbidden =
    /\/(?:ui_online|main_online|pikavolley_online|keyboard_online|chat_display)\.js$|\/data_channel\/(?!rtc_configuration\.js$)|\/quick_match\/|\/block_other_players\/|\/replay_saver\.js$/;
  function visit(file) {
    const normalized = file.replace(/\\/g, '/');
    assert.equal(forbidden.test(normalized), false, normalized);
    if (visited.has(file)) return;
    visited.add(file);
    if (!file.endsWith('.js')) return;
    const ast = acorn.parse(fs.readFileSync(file, 'utf8'), {
      sourceType: 'module',
      ecmaVersion: 'latest',
    });
    for (const node of ast.body)
      if (node.source?.value.startsWith('.')) {
        const base = path.resolve(path.dirname(file), node.source.value);
        const resolved = [base, base + '.js', base + '.css'].find((p) =>
          fs.existsSync(p)
        );
        assert.ok(resolved, 'Missing import ' + node.source.value);
        visit(resolved);
      }
  }
  visit(path.join(root, 'replay/main_replay.js'));
  assert.ok(visited.has(path.join(root, 'offline_version_js/physics.js')));
  assert.ok(visited.has(path.join(root, 'replay/legacy_chat.js')));
});
