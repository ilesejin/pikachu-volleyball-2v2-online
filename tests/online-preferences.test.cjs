'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const acorn = require('acorn');
const directory = path.join(__dirname, '../src/resources/js/online_2v2');
function load(file, exports, bindings = {}) {
  const source = fs
    .readFileSync(path.join(directory, file), 'utf8')
    .replace(/^import[^;]+;\r?\n/gm, '')
    .replace(/export /g, '');
  const context = vm.createContext(bindings);
  vm.runInContext(
    source + '\nthis.result={' + exports.join(',') + '}',
    context
  );
  return context.result;
}
test('Chinese product text, nested status messages, and English/Korean fallbacks are correct', () => {
  const { translate, translateMessage } = load(
    'i18n.js',
    ['translate', 'translateMessage'],
    { document: { documentElement: { lang: 'zh' } } }
  );
  assert.equal(translate('Lobby', '대기실'), '大廳');
  assert.equal(translate('Lobby', '대기실', 'ko'), '대기실');
  assert.equal(translate('Lobby', '대기실', 'en'), 'Lobby');
  assert.equal(
    translateMessage('Quick Match: Room not found.'),
    '快速配對：找不到房間。'
  );
  assert.equal(
    translateMessage('Could not load the game: The room has closed.'),
    '無法載入遊戲：房間已關閉。'
  );
  assert.equal(
    translateMessage('Unknown technical diagnostic'),
    'Unknown technical diagnostic'
  );
});
test('every runtime lobby/settings/chat phrase has a Traditional Chinese translation', () => {
  const { ZH_MESSAGES } = load('i18n.js', ['ZH_MESSAGES']);
  const phrases = new Set();
  for (const file of ['app.js', 'classic_ui.js']) {
    const ast = acorn.parse(
      fs.readFileSync(path.join(directory, file), 'utf8'),
      { ecmaVersion: 2022, sourceType: 'module' }
    );
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (
        node.type === 'CallExpression' &&
        ['t', 'text'].includes(node.callee.name) &&
        typeof node.arguments[0]?.value === 'string'
      )
        phrases.add(node.arguments[0].value);
      for (const value of Object.values(node))
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') visit(value);
    }
    visit(ast);
  }
  assert.ok(phrases.size > 40);
  for (const phrase of phrases)
    assert.ok(
      Object.prototype.hasOwnProperty.call(ZH_MESSAGES, phrase),
      phrase
    );
});
test('nicknames reuse original P2P storage and preserve both local names across new loads', () => {
  const data = new Map([['myNickname', '  Original nickname  ']]);
  const storage = {
    get: (key) => (data.has(key) ? data.get(key) : null),
    set: (key, value) => data.set(key, value),
  };
  const create = () =>
    load('preferences.js', ['loadPlayerNames', 'savePlayerName'], {
      localStorageWrapper: storage,
    });
  let preferences = create();
  assert.deepEqual(Array.from(preferences.loadPlayerNames()), [
    'Original nickname',
    null,
  ]);
  preferences.savePlayerName(1, '  Pair teammate  ');
  preferences.savePlayerName(0, 'Reopened name');
  preferences = create();
  assert.deepEqual(Array.from(preferences.loadPlayerNames()), [
    'Reopened name',
    'Pair teammate',
  ]);
  preferences.savePlayerName(0, 'Solo name');
  assert.deepEqual(Array.from(create().loadPlayerNames()), [
    'Solo name',
    'Pair teammate',
  ]);
  preferences.savePlayerName(0, 'x'.repeat(40));
  assert.equal(create().loadPlayerNames()[0].length, 24);
});
