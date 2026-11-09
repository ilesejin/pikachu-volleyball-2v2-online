'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = path.join(__dirname, '..');
const read = (name) =>
  fs.readFileSync(path.join(root, 'src/resources/js/offline_2v2', name), 'utf8');
const original = read('physics.js');
const adapted = read('doubles_physics.js');
function load(source, names, bindings = {}) {
  const context = vm.createContext(bindings);
  vm.runInContext(
    source
      .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?\r?\n/gm, '')
      .replace(/export /g, '') +
      '\nthis.result = {' +
      names.join(',') +
      '};',
    context
  );
  return context.result;
}
function physics(doubles = true, halfWidth = 432) {
  let seed = 123;
  const config = { courtWidth: halfWidth, serveMode: 'rotate-players' };
  const bindings = {
    DOUBLES_CONFIG: config,
    rand: () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % 32768;
    },
  };
  const result = doubles
    ? load(adapted, ['DoublesPhysics', 'createDoublesRules'], bindings)
    : load(
        original,
        [
          'PikaPhysics',
          'PikaUserInput',
          'processCollisionBetweenBallAndWorldAndSetBallPosition',
          'processPlayerMovementAndSetPlayerPosition',
          'processCollisionBetweenBallAndPlayer',
          'calculateExpectedLandingPointXFor',
          'expectedLandingPointXWhenPowerHit',
          'letComputerDecideUserInput',
        ],
        bindings
      );
  if (doubles) Object.assign(result, result.createDoublesRules(halfWidth));
  return {
    ...result,
    config,
    rngState: () => seed,
    resetRng: () => {
      seed = 123;
    },
  };
}
const plain = (object) => JSON.parse(JSON.stringify(object));
const inputs = (count = 4) =>
  Array.from({ length: count }, () => ({
    xDirection: 0,
    yDirection: 0,
    powerHit: 0,
  }));
function humans() {
  const engine = new (physics().DoublesPhysics)();
  engine.initializeRound(false, true);
  engine.players.forEach((player) => {
    player.isComputer = false;
  });
  return engine;
}

test('legacy physics is byte-for-byte unchanged', () => {
  assert.equal(
    crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(root, 'src/resources/js/offline_2v2/physics.js')))
      .digest('hex'),
    '00270c8a426921d04e5e09b3207ec4fd81ead7e956561488518834c0e90b08e6'
  );
});

test('all copied movement/collision/AI helpers retain identical source tokens', () => {
  const acorn = require('acorn');
  const functions = (source) => {
    const found = {};
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'FunctionDeclaration') {
        found[node.id.name] = Array.from(
          acorn.tokenizer(source.slice(node.start, node.end), {
            ecmaVersion: 2020,
          })
        ).map((token) => [token.type.label, token.value]);
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === 'object') walk(value);
      }
    };
    walk(acorn.parse(source, { ecmaVersion: 2020, sourceType: 'module' }));
    return found;
  };
  const baseline = functions(original);
  delete baseline.physicsEngine;
  const copied = functions(adapted);
  for (const [name, tokens] of Object.entries(baseline)) {
    assert.deepEqual(copied[name], tokens, name);
  }
});

test('world trajectories, prediction quirks and ball hits match original at equal geometry', () => {
  const legacy = physics(false, 216);
  const doubles = physics(true, 216);
  const a = new legacy.PikaPhysics(false, false);
  const b = new doubles.DoublesPhysics();
  legacy.resetRng();
  doubles.resetRng();
  for (let i = 0; i < 1000; i++) {
    const ball = {
      ...plain(a.ball),
      x: (i * 17) % 450,
      y: ((i * 13) % 265) - 5,
      xVelocity: (i % 41) - 20,
      yVelocity: (i % 43) - 21,
      fineRotation: i % 51,
    };
    Object.assign(a.ball, plain(ball));
    Object.assign(b.ball, plain(ball));
    assert.equal(
      legacy.processCollisionBetweenBallAndWorldAndSetBallPosition(a.ball),
      doubles.processCollisionBetweenBallAndWorldAndSetBallPosition(b.ball)
    );
    assert.deepEqual(plain(a.ball), plain(b.ball));
    legacy.calculateExpectedLandingPointXFor(a.ball);
    doubles.calculateExpectedLandingPointXFor(b.ball);
    assert.deepEqual(plain(a.ball), plain(b.ball));
    const input = { xDirection: (i % 3) - 1, yDirection: ((i + 1) % 3) - 1 };
    assert.equal(
      legacy.expectedLandingPointXWhenPowerHit(
        input.xDirection,
        input.yDirection,
        a.ball
      ),
      doubles.expectedLandingPointXWhenPowerHit(
        input.xDirection,
        input.yDirection,
        b.ball
      )
    );
    legacy.processCollisionBetweenBallAndPlayer(
      a.ball,
      (i * 11) % 400,
      input,
      i % 3
    );
    doubles.processCollisionBetweenBallAndPlayer(
      b.ball,
      (i * 11) % 400,
      input,
      i % 3
    );
    assert.deepEqual(plain(a.ball), plain(b.ball));
  }
});

test('player movement and independent AI match original with equal geometry and opponent', () => {
  for (const computer of [false, true]) {
    const a = physics(false, 216),
      b = physics(true, 216);
    const legacy = new a.PikaPhysics(computer, false),
      doubles = new b.DoublesPhysics();
    const player = doubles.players[0];
    Object.assign(player, plain(legacy.player1));
    a.resetRng();
    b.resetRng();
    for (let frame = 0; frame < 800; frame++) {
      const ball = {
        ...plain(legacy.ball),
        x: (frame * 23) % 432,
        y: (frame * 7) % 250,
        xVelocity: (frame % 25) - 12,
        yVelocity: (frame % 27) - 13,
        expectedLandingPointX: (frame * 19) % 432,
      };
      const inputA = {
        xDirection: (frame % 3) - 1,
        yDirection: frame % 4 === 0 ? -1 : 0,
        powerHit: frame % 9 === 0 ? 1 : 0,
      };
      const inputB = { ...inputA };
      a.processPlayerMovementAndSetPlayerPosition(
        legacy.player1,
        inputA,
        legacy.player2,
        plain(ball)
      );
      b.processPlayerMovementAndSetPlayerPosition(
        player,
        inputB,
        legacy.player2,
        plain(ball)
      );
      assert.deepEqual(plain(player), plain(legacy.player1));
      assert.deepEqual(inputA, inputB);
    }
  }
});

test('both teams rotate only when they serve; a new match resets rotation', () => {
  const engine = humans();
  assert.equal(engine.servingPlayer, 0);
  assert.equal(engine.players[0].x, 36);
  assert.equal(engine.players[1].x, 216);
  engine.initializeRound(true);
  assert.equal(engine.servingPlayer, 3);
  assert.equal(engine.players[3].x, 828);
  assert.equal(engine.ball.x, 808);
  engine.initializeRound(true);
  assert.equal(engine.servingPlayer, 2);
  assert.equal(engine.players[2].x, 828);
  engine.initializeRound(false);
  assert.equal(engine.servingPlayer, 1);
  assert.equal(engine.players[1].x, 36);
  assert.equal(engine.ball.x, 56);
  engine.initializeRound(false, true);
  assert.equal(engine.servingPlayer, 0);
  const module = physics();
  module.config.serveMode = 'fixed';
  const fixed = new module.DoublesPhysics();
  for (const side of [false, false, true, true, false]) {
    fixed.initializeRound(side);
    assert.equal(fixed.servingPlayer, side ? 3 : 0);
  }
});

test('ball advances once; teammates can overlap and pass through each other', () => {
  const engine = humans();
  Object.assign(engine.ball, { x: 600, y: 100, xVelocity: 3, yVelocity: 2 });
  engine.players[0].x = 100;
  engine.players[1].x = 106;
  const input = inputs();
  input[0].xDirection = 1;
  input[1].xDirection = -1;
  engine.runEngineForNextFrame(input);
  assert.equal(engine.ball.x, 603);
  assert.equal(engine.ball.y, 102);
  assert.equal(engine.ball.yVelocity, 3);
  assert.equal(engine.players[0].x, 106);
  assert.equal(engine.players[1].x, 100);
});

test('overlapping hits are resolved in fixed player order, retaining individual latches', () => {
  const engine = humans();
  Object.assign(engine.ball, { x: 105, y: 230, xVelocity: 0, yVelocity: 0 });
  engine.players[0].x = 100;
  engine.players[1].x = 110;
  engine.runEngineForNextFrame(inputs());
  assert.equal(engine.players[0].isCollisionWithBallHappened, true);
  assert.equal(engine.players[1].isCollisionWithBallHappened, true);
  assert.equal(engine.ball.xVelocity, -1); // P2's response follows P1's response.
});

test('configurable widths keep all players inside their own half', () => {
  for (const half of [216, 432, 501]) {
    const engine = new (physics(true, half).DoublesPhysics)();
    engine.initializeRound(false, true);
    engine.players.forEach((p) => {
      p.isComputer = false;
    });
    for (const direction of [-1, 1]) {
      for (let i = 0; i < 200; i++)
        engine.runEngineForNextFrame(
          inputs().map((input) => ({ ...input, xDirection: direction }))
        );
      engine.players.forEach((p) => {
        assert.ok(p.x >= (p.isPlayer2 ? half + 32 : 32));
        assert.ok(p.x <= (p.isPlayer2 ? half * 2 - 32 : half - 32));
      });
    }
  }
});

test('long four-computer rallies remain finite', () => {
  const engine = new (physics().DoublesPhysics)();
  engine.initializeRound(false, true);
  for (let i = 0; i < 3000; i++) {
    const landed = engine.runEngineForNextFrame(inputs());
    for (const object of [...engine.players, engine.ball]) {
      assert.ok(Number.isFinite(object.x) && Number.isFinite(object.y));
    }
    if (landed) engine.initializeRound(i % 2 === 0);
  }
});

test('confirmed physical keyboard bindings and combined down-right input', () => {
  const listeners = { keydown: new Set(), keyup: new Set() };
  const window = {
    addEventListener: (type, callback) => listeners[type].add(callback),
    removeEventListener: (type, callback) => listeners[type].delete(callback),
  };
  const { PikaKeyboard } = load(read('keyboard.js'), ['PikaKeyboard'], {
    window,
    PikaUserInput: physics().PikaUserInput,
  });
  const bindings = [
    ['KeyA', 'KeyD', 'KeyW', 'KeyX', 'KeyZ', 'KeyS'],
    ['KeyG', 'KeyJ', 'KeyY', 'KeyB', 'KeyV', 'KeyH'],
    ['KeyL', 'Quote', 'KeyP', 'Semicolon', 'Comma'],
    ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter'],
  ];
  const keyboards = bindings.map((keys) => new PikaKeyboard(...keys));
  function event(type, code) {
    listeners[type].forEach((handler) =>
      handler({ code, preventDefault() {} })
    );
  }
  keyboards.forEach((keyboard, i) => {
    event('keydown', bindings[i][1]);
    keyboard.getInput();
    assert.equal(keyboard.xDirection, 1);
    event('keyup', bindings[i][1]);
    event('keydown', bindings[i][4]);
    keyboard.getInput();
    assert.equal(keyboard.powerHit, 1);
    keyboard.getInput();
    assert.equal(keyboard.powerHit, 0);
    event('keyup', bindings[i][4]);
    if (i < 2) {
      event('keydown', bindings[i][5]);
      keyboard.getInput();
      assert.equal(keyboard.xDirection, 1);
      assert.equal(keyboard.yDirection, 1);
      event('keyup', bindings[i][5]);
    }
    keyboard.unsubscribe();
  });
  assert.equal(listeners.keydown.size, 0);
  assert.equal(listeners.keyup.size, 0);
});

function controller() {
  const legacy = physics(false);
  const doubles = physics();
  class FakeContainer {
    constructor() {
      this.visible = false;
      this.children = [];
    }
    addChild(child) {
      this.children.push(child);
    }
    getChildIndex(child) {
      return this.children.indexOf(child);
    }
    removeChild(child) {
      this.children.splice(this.children.indexOf(child), 1);
    }
    addChildAt(child, index) {
      this.children.splice(index, 0, child);
    }
    destroy() {}
  }
  class FakeView {
    constructor() {
      this.container = new FakeContainer();
      this.black = {};
      this.scoreBoards = [{}, {}];
    }
    get visible() {
      return this.container.visible;
    }
    set visible(value) {
      this.container.visible = value;
    }
    setDoublesMode() {}
    setBlackAlphaTo() {}
    changeBlackAlphaBy() {}
    drawPlayersAndBall() {}
    drawScoresToScoreBoards(scores) {
      this.scores = [...scores];
    }
    drawCloudsAndWave() {}
    drawGameStartMessage() {}
    selectWithWho() {}
    drawFightMessage() {}
    drawSachisoft() {}
    drawSittingPikachuTiles() {}
    drawPikachuVolleyballMessage() {}
    drawPokemonMessage() {}
    drawWithWhoMessages() {}
  }
  class FakeKeyboard {
    constructor(...keys) {
      this.keys = keys;
      this.powerHit = 0;
      this.yDirection = 0;
    }
    unsubscribe() {
      this.unsubscribed = true;
    }
    getInput() {}
  }
  const { PikachuVolleyball } = load(
    read('pikavolley.js'),
    ['PikachuVolleyball'],
    {
      GROUND_HALF_WIDTH: 216,
      PikaPhysics: legacy.PikaPhysics,
      DoublesPhysics: doubles.DoublesPhysics,
      DOUBLES_CONFIG: load(read('doubles_config.js'), ['DOUBLES_CONFIG'])
        .DOUBLES_CONFIG,
      DOUBLES_WIDTH: 864,
      MenuView: FakeView,
      GameView: FakeView,
      IntroView: FakeView,
      FadeInOut: FakeView,
      PikaKeyboard: FakeKeyboard,
      ...load(
        read('doubles_controls.js'),
        ['createDoublesMenuKeyboards', 'createDoublesKeyboards'],
        { PikaKeyboard: FakeKeyboard }
      ),
      PikaAudio: class {
        constructor() {
          this.sounds = Object.fromEntries(
            [
              'bgm',
              'pi',
              'pikachu',
              'chu',
              'pika',
              'pipikachu',
              'powerHit',
              'ballTouchesGround',
            ].map((key) => [key, { play() {}, stop() {} }])
          );
        }
      },
      document: { documentElement: { lang: 'en' }, getElementById: () => null },
    }
  );
  let width;
  const game = new PikachuVolleyball(new FakeContainer(), {}, (value) => {
    width = value;
  });
  return { game, getWidth: () => width };
}

test('2v2 defaults, both match choices, mode switching and input cleanup', () => {
  const { game, getWidth } = controller();
  assert.equal(game.isDoubles, true);
  assert.equal(getWidth(), 680);
  assert.equal(game.keyboardArray.length, 4);
  // Enter chooses the right human team against the left computer team.
  game.menu();
  assert.equal(game.selectedWithWho, 0);
  game.frameCounter = 72;
  game.selectedWithWho = 1;
  game.keyboardArray[3].powerHit = 1;
  game.menu();
  assert.deepEqual(plain(game.players.map((p) => p.isComputer)), [
    true,
    true,
    false,
    false,
  ]);
  game.keyboardArray[3].powerHit = 0;
  game.frameCounter = 0;
  game.menu();
  game.frameCounter = 72;
  game.keyboardArray[0].yDirection = 1;
  game.menu();
  game.keyboardArray[0].yDirection = 0;
  game.menu();
  game.keyboardArray[0].yDirection = 1;
  game.menu();
  game.keyboardArray[0].yDirection = 0;
  game.keyboardArray[0].powerHit = 1;
  game.menu();
  assert.deepEqual(plain(game.players.map((p) => p.isComputer)), [
    false,
    false,
    false,
    false,
  ]);
  game.isPracticeMode = true;
  const oldKeyboards = game.keyboardArray;
  game.setMode(false);
  assert.equal(game.isDoubles, false);
  assert.equal(getWidth(), 432);
  assert.equal(game.keyboardArray.length, 2);
  assert.equal(game.players.length, 2);
  assert.ok(oldKeyboards.every((keyboard) => keyboard.unsubscribed));
  assert.equal(
    game.keyboardArray[0].keys.join(','),
    'KeyD,KeyG,KeyR,KeyV,KeyZ,KeyF'
  );
  assert.equal(game.view.game.scoreBoards[0].visible, false);
  // Original right-human vs left-computer still depends on the confirming key.
  game.state = game.menu;
  game.frameCounter = 0;
  game.menu();
  game.frameCounter = 72;
  game.keyboardArray[1].powerHit = 1;
  game.menu();
  assert.equal(game.physics.player1.isComputer, true);
  assert.equal(game.physics.player2.isComputer, false);
  game.setMode(true);
  assert.equal(game.players.length, 4);
  assert.equal(getWidth(), 680);
});

test('team scoring, serve side, match winners and practice use the widened midpoint', () => {
  const { game } = controller();
  game.frameCounter = 0;
  game.startOfNewGame();
  game.players.forEach((p) => {
    p.isComputer = false;
  });
  game.winningScore = 1;
  game.physics.runEngineForNextFrame = () => true;
  game.physics.ball.punchEffectX = 300; // Left side of widened court, right of legacy midpoint.
  game.round();
  assert.deepEqual(plain(game.scores), [0, 1]);
  assert.equal(game.isPlayer2Serve, true);
  assert.deepEqual(plain(game.players.map((p) => p.isWinner)), [
    false,
    false,
    true,
    true,
  ]);
  assert.ok(game.players.every((p) => p.gameEnded));
  game.frameCounter = 0;
  game.startOfNewGame();
  assert.ok(game.players.every((p) => !p.gameEnded && !p.isWinner));
  game.isPracticeMode = true;
  game.round();
  assert.deepEqual(plain(game.scores), [0, 0]);
  assert.equal(game.roundEnded, false);
  game.isPracticeMode = false;
  game.physics.ball.punchEffectX = 600;
  game.round();
  assert.deepEqual(plain(game.scores), [1, 0]);
  assert.deepEqual(plain(game.players.map((p) => p.isWinner)), [
    true,
    true,
    false,
    false,
  ]);
});

test('match widths are isolated; changing width restarts the same lineup and resets scores', () => {
  const module = physics();
  const narrow = new module.DoublesPhysics(216);
  const wide = new module.DoublesPhysics(501);
  narrow.initializeRound(true, true);
  wide.initializeRound(true, true);
  assert.equal(narrow.ball.x, 376);
  assert.equal(wide.ball.x, 946);
  for (const engine of [narrow, wide]) {
    engine.players.forEach((p) => {
      p.isComputer = false;
    });
    Object.assign(engine.ball, { x: 420, y: 20, xVelocity: 15, yVelocity: 0 });
    engine.runEngineForNextFrame(inputs());
  }
  assert.equal(narrow.ball.xVelocity, -15);
  assert.equal(wide.ball.xVelocity, 15);
  const { game, getWidth } = controller();
  game.players.forEach((player, i) => {
    player.isComputer = i >= 2;
  });
  game.startOfNewGame();
  game.scores = [3, 4];
  assert.equal(game.setCourtWidth(501), true);
  assert.equal(game.halfWidth, 501);
  assert.equal(game.physics.width, 1002);
  assert.equal(getWidth(), 1002);
  assert.deepEqual(plain(game.scores), [0, 0]);
  assert.deepEqual(plain(game.players.map((p) => p.isComputer)), [
    false,
    false,
    true,
    true,
  ]);
  assert.equal(game.physics.servingPlayer, 0);
  assert.equal(game.setCourtWidth(215), false);
  assert.equal(game.setCourtWidth(432.5), false);
  assert.equal(game.setCourtWidth(NaN), false);
  game.setMode(false);
  game.setCourtWidth(350);
  assert.equal(getWidth(), 432);
  assert.equal(game.halfWidth, 216);
  game.setMode(true);
  assert.equal(getWidth(), 700);
  assert.equal(game.physics.halfWidth, 350);
});

test('AI front/back zones produce distinct targets on both sides without moving objects directly', () => {
  const module = physics();
  const engine = new module.DoublesPhysics();
  engine.initializeRound(false, true);
  const rules = engine.rules;
  for (const right of [false, true]) {
    const pair = engine.players.filter((p) => p.isPlayer2 === right);
    const back = pair.find((p) => p.coverageRole === 'back');
    const front = pair.find((p) => p.coverageRole === 'front');
    const at = (distance) => (right ? 864 - distance : distance);
    back.x = at(140);
    front.x = at(290);
    for (const landing of [100, 330]) {
      const ball = { ...engine.ball, expectedLandingPointX: at(landing) };
      const backInput = {
        xDirection: right ? 1 : -1,
        yDirection: -1,
        powerHit: 1,
      };
      const frontInput = {
        xDirection: right ? -1 : 1,
        yDirection: -1,
        powerHit: 1,
      };
      const before = plain([back, front, ball]);
      rules.applyCoverageInput(back, ball, backInput);
      rules.applyCoverageInput(front, ball, frontInput);
      assert.deepEqual(plain([back, front, ball]), before);
      const idleInput = landing <= 216 ? frontInput : backInput;
      assert.equal(idleInput.powerHit, 0);
      assert.equal(idleInput.yDirection, 0);
      assert.notEqual(backInput.xDirection, frontInput.xDirection);
    }
  }
  const firstBack = engine.players.findIndex(
    (p) => !p.isPlayer2 && p.coverageRole === 'back'
  );
  engine.initializeRound(false);
  const secondBack = engine.players.findIndex(
    (p) => !p.isPlayer2 && p.coverageRole === 'back'
  );
  assert.notEqual(firstBack, secondBack);
  assert.equal(secondBack, engine.servingPlayer);
});

test('all serve modes preserve drop physics and independent team sequences at different widths', () => {
  const { DoublesPhysics } = physics();
  for (const half of [216, 384, 501]) {
    for (const mode of ['rotate-players', 'rotate-ball', 'fixed']) {
      const engine = new DoublesPhysics(half, mode);
      const next = [0, 1];
      for (const right of [false, false, true, false, true, true]) {
        const side = Number(right);
        const server = mode === 'fixed' ? side : next[side];
        engine.initializeRound(right);
        assert.equal(engine.servingPlayer, side * 2 + server);
        engine.players.forEach((player, i) => {
          const team = Math.floor(i / 2),
            member = i % 2;
          const outer = mode === 'rotate-players' ? next[team] : team;
          const distance = member === outer ? 36 : Math.floor(half / 2);
          assert.equal(player.x, team === 0 ? distance : half * 2 - distance);
          assert.equal(player.y, 244);
          assert.equal(
            player.coverageRole,
            member === outer ? 'back' : 'front'
          );
        });
        const ballDistance =
          mode === 'rotate-ball' && server !== side
            ? Math.floor(half / 2) + 20
            : 56;
        assert.equal(
          engine.ball.x,
          right ? half * 2 - ballDistance : ballDistance
        );
        assert.equal(engine.ball.y, 0);
        assert.equal(engine.ball.xVelocity, 0);
        assert.equal(engine.ball.yVelocity, 1);
        if (mode !== 'fixed') next[side] = 1 - server;
      }
      engine.initializeRound(false, true);
      assert.equal(engine.servingPlayer, 0);
      assert.equal(engine.ball.x, 56);
    }
  }
});

test('serve default is option 2; applying changes restarts the same lineup and preserves width', () => {
  const { game, getWidth } = controller();
  assert.equal(game.doublesCourtWidth, 340);
  assert.equal(game.doublesServeMode, 'rotate-ball');
  assert.equal(game.physics.serveMode, 'rotate-ball');
  game.players.forEach((p, i) => {
    p.isComputer = i >= 2;
  });
  game.startOfNewGame();
  game.scores = [2, 4];
  assert.equal(game.setServeMode('rotate-players'), true);
  assert.deepEqual(plain(game.scores), [0, 0]);
  assert.equal(getWidth(), 680);
  assert.deepEqual(plain(game.players.map((p) => p.isComputer)), [
    false,
    false,
    true,
    true,
  ]);
  game.scores = [1, 2];
  assert.equal(game.setServeMode('rotate-players'), true);
  assert.deepEqual(plain(game.scores), [1, 2]);
  assert.equal(game.setServeMode('invalid'), false);
  game.setServeMode('fixed');
  game.setCourtWidth(501);
  assert.equal(game.physics.serveMode, 'fixed');
  game.setMode(false);
  const legacy = game.physics;
  game.setServeMode('rotate-ball');
  assert.equal(game.physics, legacy);
  assert.equal(game.halfWidth, 216);
  game.setMode(true);
  assert.equal(game.physics.serveMode, 'rotate-ball');
  assert.equal(game.halfWidth, 501);
});

test('solo 2v2 mode assigns the confirming key position and preserves its lineup on settings changes', () => {
  for (let human = 0; human < 4; human++) {
    const { game } = controller();
    game.menu();
    game.frameCounter = 72;
    assert.equal(game.selectedWithWho, 0);
    game.keyboardArray[human].powerHit = 1;
    game.menu();
    const expected = [0, 1, 2, 3].map((i) => i !== human);
    assert.deepEqual(plain(game.players.map((p) => p.isComputer)), expected);
    game.keyboardArray[human].powerHit = 0;
    game.frameCounter = 0;
    game.startOfNewGame();
    game.setCourtWidth(400);
    game.setServeMode('fixed');
    assert.deepEqual(plain(game.players.map((p) => p.isComputer)), expected);
  }
});

test('three-choice menu navigation stops at endpoints and moves up one row per press', () => {
  const { game } = controller();
  game.menu();
  game.frameCounter = 72;
  const move = (direction) => {
    game.keyboardArray[3].yDirection = 0;
    game.menu();
    game.keyboardArray[3].yDirection = direction;
    game.menu();
  };
  move(-1);
  assert.equal(game.selectedWithWho, 0);
  move(1);
  move(1);
  move(1);
  assert.equal(game.selectedWithWho, 2);
  move(-1);
  assert.equal(game.selectedWithWho, 1);
  move(-1);
  assert.equal(game.selectedWithWho, 0);
});

test('fixed-position modes start P1-P2-P3-P4 left to right with P4 serving first on the right', () => {
  const { DoublesPhysics } = physics();
  for (const width of [216, 384, 501]) {
    for (const mode of ['rotate-ball', 'fixed']) {
      const engine = new DoublesPhysics(width, mode);
      for (const right of [false, true, true, false]) {
        engine.initializeRound(right);
        assert.ok(
          engine.players.every((p, i, all) => i === 0 || all[i - 1].x < p.x)
        );
        assert.deepEqual(plain(engine.players.map((p) => p.coverageRole)), [
          'back',
          'front',
          'front',
          'back',
        ]);
      }
      engine.initializeRound(true, true);
      assert.equal(engine.servingPlayer, 3);
      assert.equal(engine.ball.x, width * 2 - 56);
      engine.initializeRound(true);
      assert.equal(engine.servingPlayer, mode === 'fixed' ? 3 : 2);
      assert.equal(
        engine.ball.x,
        mode === 'fixed'
          ? width * 2 - 56
          : width * 2 - Math.floor(width / 2) - 20
      );
    }
  }
});

function realControls() {
  const listeners = { keydown: new Set(), keyup: new Set() };
  const { PikaKeyboard } = load(read('keyboard.js'), ['PikaKeyboard'], {
    PikaUserInput: physics(false).PikaUserInput,
    window: {
      addEventListener: (name, handler) => listeners[name].add(handler),
      removeEventListener: (name, handler) => listeners[name].delete(handler),
    },
  });
  const controls = load(
    read('doubles_controls.js'),
    ['createDoublesKeyboards', 'createDoublesMenuKeyboards'],
    { PikaKeyboard }
  );
  return {
    ...controls,
    listeners,
    event(type, code) {
      for (const listener of [...listeners[type]])
        listener({ code, preventDefault() {} });
    },
  };
}
test('two-human mode selects a complete left or right team and preserves it across width/serve changes', () => {
  for (const [confirm, humans] of [
    [0, [0, 1]],
    [3, [2, 3]],
  ]) {
    const { game } = controller();
    game.menu();
    game.frameCounter = 72;
    game.selectedWithWho = 1;
    game.keyboardArray[confirm].powerHit = 1;
    game.menu();
    assert.deepEqual(plain(game.doublesHumanSlots), humans);
    assert.deepEqual(
      plain(game.players.map((p) => p.isComputer)),
      [0, 1, 2, 3].map((i) => !humans.includes(i))
    );
    assert.equal(game.keyboardArray[humans[0]].keys[0], 'KeyD');
    assert.equal(game.keyboardArray[humans[1]].keys[0], 'ArrowLeft');
    game.frameCounter = 0;
    game.startOfNewGame();
    game.setCourtWidth(400);
    game.setServeMode('fixed');
    assert.deepEqual(plain(game.doublesHumanSlots), humans);
    assert.equal(game.keyboardArray[humans[0]].keys[0], 'KeyD');
    assert.equal(game.keyboardArray[humans[1]].keys[0], 'ArrowLeft');
  }
  for (const invalid of [1, 2]) {
    const { game } = controller();
    game.menu();
    game.frameCounter = 72;
    game.selectedWithWho = 1;
    game.keyboardArray[invalid].powerHit = 1;
    game.menu();
    assert.equal(game.state, game.menu);
    assert.equal(game.selectedWithWho, 1);
    assert.equal(game.doublesHumanSlots, null);
  }
});
test('solo aliases share one hit edge, F points inward on either side, and alternative F/V controls release every listener', () => {
  for (const slot of [0, 1, 2, 3])
    for (const mode of ['diagonal', 'down-only']) {
      const controls = realControls();
      const keys = controls.createDoublesKeyboards([slot], mode);
      const keyboard = keys[slot];
      controls.event('keydown', 'KeyF');
      keyboard.getInput();
      assert.equal(keyboard.yDirection, 1);
      assert.equal(
        keyboard.xDirection,
        mode === 'down-only' ? 0 : slot < 2 ? 1 : -1
      );
      controls.event('keyup', 'KeyF');
      controls.event('keydown', 'KeyV');
      keyboard.getInput();
      assert.equal(keyboard.yDirection, mode === 'down-only' ? 0 : 1);
      assert.equal(keyboard.xDirection, 0);
      controls.event('keyup', 'KeyV');
      controls.event('keydown', 'KeyZ');
      keyboard.getInput();
      assert.equal(keyboard.powerHit, 1);
      controls.event('keydown', 'Enter');
      keyboard.getInput();
      assert.equal(keyboard.powerHit, 0);
      controls.event('keyup', 'KeyZ');
      keyboard.getInput();
      assert.equal(keyboard.powerHit, 0);
      controls.event('keyup', 'Enter');
      keyboard.getInput();
      controls.event('keydown', 'ArrowUp');
      keyboard.getInput();
      assert.equal(keyboard.yDirection, -1);
      keys.forEach((key) => key.unsubscribe());
      assert.equal(controls.listeners.keydown.size, 0);
      assert.equal(controls.listeners.keyup.size, 0);
    }
});
test('pair controllers are independent and menu selection keys remain available with F-down enabled', () => {
  const controls = realControls();
  const keys = controls.createDoublesKeyboards([2, 3], 'down-only');
  controls.event('keydown', 'KeyG');
  controls.event('keydown', 'ArrowLeft');
  keys.forEach((key) => key.getInput());
  assert.equal(keys[2].xDirection, 1);
  assert.equal(keys[3].xDirection, -1);
  assert.equal(keys[0].xDirection, 0);
  keys.forEach((key) => key.unsubscribe());
  for (const [slot, code] of [
    [0, 'KeyZ'],
    [1, 'KeyV'],
    [2, 'Comma'],
    [3, 'Enter'],
  ]) {
    const menu = controls.createDoublesMenuKeyboards('down-only');
    controls.event('keydown', code);
    menu.forEach((key) => key.getInput());
    assert.equal(menu[slot].powerHit, 1);
    controls.event('keyup', code);
    menu.forEach((key) => key.unsubscribe());
  }
  assert.equal(controls.listeners.keydown.size, 0);
});
test('changing F/V controls preserves an active match and leaves original 1v1 bindings intact', () => {
  const { game } = controller();
  game.menu();
  game.frameCounter = 72;
  game.selectedWithWho = 1;
  game.keyboardArray[3].powerHit = 1;
  game.menu();
  game.frameCounter = 0;
  game.startOfNewGame();
  game.scores = [4, 6];
  const model = game.physics,
    state = game.state,
    ball = plain(game.physics.ball),
    players = plain(game.players);
  assert.equal(game.setDoublesFVMode('down-only'), true);
  assert.equal(game.physics, model);
  assert.equal(game.state, state);
  assert.deepEqual(plain(game.scores), [4, 6]);
  assert.deepEqual(plain(game.physics.ball), ball);
  assert.deepEqual(plain(game.players), players);
  assert.equal(game.keyboardArray[2].keys[3], 'KeyF');
  assert.equal(game.keyboardArray[2].keys[5], null);
  game.setMode(false);
  const originalKeys = game.keyboardArray;
  game.setDoublesFVMode('diagonal');
  assert.equal(game.keyboardArray, originalKeys);
  assert.deepEqual(plain(game.keyboardArray[0].keys), [
    'KeyD',
    'KeyG',
    'KeyR',
    'KeyV',
    'KeyZ',
    'KeyF',
  ]);
});

test('selected speed survives mode switches, width/serve restarts and a game restart', () => {
  for (const fps of [20, 25, 30]) {
    const { game } = controller();
    game.normalFPS = fps;
    game.setMode(false);
    assert.equal(game.normalFPS, fps);
    game.setMode(true);
    assert.equal(game.normalFPS, fps);
    game.setCourtWidth(360);
    game.setServeMode('fixed');
    game.restart();
    assert.equal(game.normalFPS, fps);
  }
});

test('2v2 near-net attacks lift over the pillar instead of hitting its lower face on either side', () => {
  for (const half of [216, 340, 501])
    for (const right of [false, true]) {
      const module = physics(true, half);
      const engine = new module.DoublesPhysics(half);
      engine.initializeRound(false, true);
      const player = engine.players[right ? 2 : 1];
      player.x = half + (right ? 32 : -32);
      player.y = 195;
      player.state = 2;
      const ball = {
        ...engine.ball,
        x: half + (right ? 35 : -35),
        y: 195,
        xVelocity: right ? -3 : 3,
        yVelocity: 8,
      };
      const opponents = engine.players.filter((p) => p.isPlayer2 !== right);
      const shot = engine.rules.chooseDoublesShot(
        player,
        ball,
        opponents,
        false
      );
      assert.equal(shot.safe, true, 'a safe lift exists at width ' + half);
      assert.equal(shot.input.yDirection, -1);
      assert.equal(shot.netTouched, false);
      assert.equal(right ? shot.landingX < half : shot.landingX > half, true);
      for (const yDirection of [0, 1]) {
        const bad = engine.rules.predictDoublesShot(
          player,
          ball,
          { xDirection: right ? -1 : 1, yDirection, powerHit: 1 },
          true
        );
        assert.equal(
          bad.safe,
          false,
          'flat/downward shots must not be selected'
        );
      }
    }
});

test('2v2 shot forecasts agree with actual hits/world collisions and do not mutate state or consume RNG', () => {
  for (const half of [216, 340, 501])
    for (const right of [false, true]) {
      const module = physics(true, half);
      const engine = new module.DoublesPhysics(half);
      engine.initializeRound(false, true);
      const player = engine.players[right ? 2 : 1];
      const opponents = engine.players.filter((p) => p.isPlayer2 !== right);
      for (const y of [80, 175, 195, 235])
        for (const vy of [-20, 0, 18]) {
          const ball = {
            ...engine.ball,
            x: half + (right ? 35 : -35),
            y,
            xVelocity: 0,
            yVelocity: vy,
            sound: { ...engine.ball.sound },
          };
          player.x = ball.x; // Exercise the discarded random zero-speed bounce.
          const before = plain([player, ball, opponents]);
          const seed = module.rngState();
          const shot = engine.rules.chooseDoublesShot(
            player,
            ball,
            opponents,
            false
          );
          assert.equal(module.rngState(), seed);
          assert.deepEqual(plain([player, ball, opponents]), before);
          const actual = { ...ball, sound: { ...ball.sound } };
          engine.rules.processCollisionBetweenBallAndPlayer(
            actual,
            player.x,
            shot.input,
            2
          );
          let netTouched = false,
            landed = false;
          for (let frame = 1; frame <= 1000; frame++) {
            if (Math.abs(actual.x - half) < 25 && actual.y > 176)
              netTouched = true;
            if (
              engine.rules.processCollisionBetweenBallAndWorldAndSetBallPosition(
                actual
              )
            ) {
              assert.equal(frame, shot.frames);
              assert.equal(actual.x, shot.landingX);
              assert.equal(netTouched, shot.netTouched);
              assert.equal(
                shot.safe,
                !netTouched && (right ? actual.x < half : actual.x > half)
              );
              landed = true;
              break;
            }
          }
          assert.equal(landed, true);
        }
    }
});

test('2v2 shot choice considers the second defender, and impossible contacts fall back to an upward return', () => {
  const module = physics(true, 340),
    engine = new module.DoublesPhysics(340);
  engine.initializeRound(false, true);
  const player = engine.players[1];
  player.x = 308;
  const ball = { ...engine.ball, x: 318, y: 80, xVelocity: 3, yVelocity: 8 };
  const a = engine.rules.chooseDoublesShot(
    player,
    ball,
    [{ x: 360 }, { x: 400 }],
    false
  );
  const b = engine.rules.chooseDoublesShot(
    player,
    ball,
    [{ x: 360 }, { x: 650 }],
    false
  );
  assert.equal(a.safe && b.safe, true);
  assert.notDeepEqual(plain(a.input), plain(b.input));
  const impossible = engine.rules.chooseDoublesShot(
    player,
    { ...ball, x: 325, y: 235 },
    [{ x: 360 }, { x: 650 }],
    false
  );
  assert.equal(impossible.safe, false);
  assert.equal(impossible.input.yDirection, -1);
});

test('an ongoing AI smash is aimed at actual contact even when coverage cleared its inputs', () => {
  for (const right of [false, true]) {
    const module = physics(true, 340),
      engine = new module.DoublesPhysics(340);
    engine.initializeRound(false, true);
    engine.players.forEach((p) => {
      p.isComputer = false;
    });
    const player = engine.players[right ? 2 : 1];
    player.isComputer = true;
    player.x = 340 + (right ? 32 : -32);
    player.y = 195;
    player.yVelocity = 0;
    player.state = 2;
    player.frameNumber = 1;
    player.delayBeforeNextFrame = 5;
    Object.assign(engine.ball, {
      x: 340 + (right ? 38 : -38),
      y: 187,
      xVelocity: right ? -3 : 3,
      yVelocity: 8,
    });
    const input = inputs();
    engine.runEngineForNextFrame(input);
    assert.equal(player.isCollisionWithBallHappened, true);
    assert.equal(engine.ball.isPowerHit, true);
    assert.equal(input[right ? 2 : 1].yDirection, -1);
    assert.ok(engine.ball.yVelocity < 0);
    let hitGround = false;
    for (let frame = 0; frame < 1000; frame++) {
      if (
        engine.rules.processCollisionBetweenBallAndWorldAndSetBallPosition(
          engine.ball
        )
      ) {
        assert.equal(right ? engine.ball.x < 340 : engine.ball.x > 340, true);
        hitGround = true;
        break;
      }
    }
    assert.equal(hitGround, true);
  }
});
