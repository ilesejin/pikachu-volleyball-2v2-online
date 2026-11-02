import seedrandom from 'seedrandom';
import { setCustomRng } from '../offline_2v2/rand.js';
import { Lockstep, INPUT_WINDOW } from './lockstep.js';
import { PikaKeyboard } from '../offline_2v2/keyboard.js';
import { createAliasedKeyboard } from './keyboard_aliases.js';
import {
  PLAYER_KEYS,
  RemoteInput,
  matchSettings,
  canUpdateLive,
  ownedInputs,
  lobbyReady,
} from './protocol.js';
import { randomId } from './room.js';

const PAIR_FIRST_KEYS = ['KeyD', 'KeyG', 'KeyR', 'KeyV', 'KeyZ', 'KeyF'];

const PLAYER_FIELDS = [
  'isPlayer2',
  'isComputer',
  'x',
  'y',
  'yVelocity',
  'isCollisionWithBallHappened',
  'state',
  'frameNumber',
  'normalStatusArmSwingDirection',
  'delayBeforeNextFrame',
  'computerBoldness',
  'divingDirection',
  'lyingDownDurationLeft',
  'isWinner',
  'gameEnded',
  'computerWhereToStandBy',
  'coverageRole',
];
const BALL_FIELDS = [
  'x',
  'y',
  'xVelocity',
  'yVelocity',
  'punchEffectRadius',
  'isPowerHit',
  'expectedLandingPointX',
  'rotation',
  'fineRotation',
  'punchEffectX',
  'punchEffectY',
  'previousX',
  'previousPreviousX',
  'previousY',
  'previousPreviousY',
];
const CLOUD_FIELDS = [
  'topLeftPointX',
  'topLeftPointY',
  'topLeftPointXVelocity',
  'sizeDiffTurnNumber',
];
const MESSAGE_FIELDS = ['x', 'y', 'width', 'height', 'visible'];
const pick = (object, fields) =>
  Object.fromEntries(fields.map((key) => [key, object[key]]));
function assignFields(target, source, fields) {
  if (!source || typeof source !== 'object') return;
  for (const key of fields) {
    const value = source[key];
    if (
      (typeof value === 'number' && Number.isFinite(value)) ||
      typeof value === 'boolean' ||
      (key === 'coverageRole' && ['front', 'back'].includes(value))
    )
      target[key] = value;
  }
}

export function captureSnapshot(game, epoch, frame, phase, events = []) {
  const view = game.view.game;
  return {
    type: 'state',
    epoch,
    frame,
    phase,
    scores: game.scores.slice(),
    gameEnded: game.gameEnded,
    players: game.players.map((player) => pick(player, PLAYER_FIELDS)),
    ball: pick(game.physics.ball, BALL_FIELDS),
    clouds: view.cloudArray.map((cloud) => pick(cloud, CLOUD_FIELDS)),
    wave: view.wave.yCoords.slice(),
    fade: game.view.fadeInOut.black.alpha,
    messages: Object.fromEntries(
      Object.entries(view.messages).map(([key, message]) => [
        key,
        pick(message, MESSAGE_FIELDS),
      ])
    ),
    events,
  };
}

export function validSnapshot(packet, epoch, lastFrame) {
  return (
    !!packet &&
    packet.type === 'state' &&
    packet.epoch === epoch &&
    Number.isSafeInteger(packet.frame) &&
    packet.frame > lastFrame &&
    ['playing', 'paused', 'finished'].includes(packet.phase) &&
    Array.isArray(packet.players) &&
    packet.players.length === 4 &&
    packet.players.every(
      (p) =>
        p &&
        Number.isFinite(p.x) &&
        Number.isFinite(p.y) &&
        Number.isInteger(p.state) &&
        p.state >= 0 &&
        p.state <= 6
    ) &&
    packet.ball &&
    Number.isFinite(packet.ball.x) &&
    Number.isFinite(packet.ball.y) &&
    Array.isArray(packet.scores) &&
    packet.scores.length === 2 &&
    packet.scores.every(
      (score) => Number.isInteger(score) && score >= 0 && score <= 99
    ) &&
    Array.isArray(packet.clouds) &&
    packet.clouds.length === 10 &&
    Array.isArray(packet.wave) &&
    packet.wave.length === 27 &&
    packet.wave.every(Number.isFinite) &&
    Number.isFinite(packet.fade) &&
    packet.fade >= 0 &&
    packet.fade <= 1
  );
}

export class OnlineMatch {
  constructor(game, ticker, notify = () => {}) {
    this.game = game;
    this.ticker = ticker;
    this.notify = notify;
    this.room = null;
    this.phase = 'idle';
    this.epoch = null;
    this.frame = 0;
    this.lastFrame = -1;
    this.inputSequence = 0;
    this.peerSequences = new Map();
    this.localSlots = [];
    this.matchSlots = null;
    this.keyboards = [];
    this.controlStyle = 'standard';
    this.events = [];
    this.lockstep = null;
    this.inputTimer = null;
    this.rng = null;
    const play = game.playSoundEffect.bind(game);
    game.playSoundEffect = () => {
      game.players.forEach((player, i) => {
        for (const name of ['pipikachu', 'pika', 'chu'])
          if (player.sound[name])
            this.events.push({
              name,
              side: player.isPlayer2 ? 1 : -1,
              slot: i,
            });
      });
      for (const name of ['powerHit', 'ballTouchesGround'])
        if (game.physics.ball.sound[name])
          this.events.push({
            name,
            side: game.physics.ball.punchEffectX < game.halfWidth ? -1 : 1,
          });
      play();
    };
    this.detachGameKeys();
    this.inputs = Array.from({ length: 4 }, () => new RemoteInput());
    game.keyboardArray = this.inputs;
    game.paused = true;
    window.addEventListener('blur', () => this.releaseLocalKeys());
  }
  detachGameKeys() {
    this.game.keyboardArray.forEach((keyboard) => keyboard.unsubscribe());
  }
  attachRoom(room) {
    this.room = room;
  }
  releaseLocalKeys() {
    this.keyboards.forEach(({ keyboard }) => {
      keyboard.unsubscribe();
      keyboard.powerHitKeyIsDownPrevious = false;
      keyboard.subscribe();
    });
    if (!this.lockstep) this.inputs.forEach((input) => input.reset());
  }
  clearKeys() {
    this.keyboards.forEach(({ keyboard }) => keyboard.unsubscribe());
    this.keyboards = [];
  }
  controls(style) {
    this.controlStyle = style;
    if (this.epoch) this.bindLocalKeys();
  }
  bindLocalKeys() {
    this.clearKeys();
    const member =
      this.room && this.room.data && this.room.data.members[this.room.selfId];
    this.localSlots = this.matchSlots
      ? this.matchSlots.slice()
      : member
      ? member.slots.slice()
      : [];
    this.localSlots.forEach((slot, index) => {
      const keys =
        this.controlStyle === 'position'
          ? PLAYER_KEYS[slot]
          : this.localSlots.length === 1 || index === 1
          ? PLAYER_KEYS[3]
          : PAIR_FIRST_KEYS;
      const keyboard =
        this.controlStyle !== 'position' && this.localSlots.length === 1
          ? createAliasedKeyboard(keys, PAIR_FIRST_KEYS)
          : new PikaKeyboard(...keys);
      this.keyboards.push({ slot, keyboard });
    });
  }
  prepare(settings) {
    this.settings = matchSettings(settings);
    const game = this.game;
    this.clearKeys();
    game.doublesCourtWidth = this.settings.courtWidth;
    game.doublesServeMode = this.settings.serveMode;
    game.setMode(true);
    this.detachGameKeys();
    this.inputs = Array.from({ length: 4 }, () => new RemoteInput());
    game.keyboardArray = this.inputs;
    game.normalFPS = this.settings.fps;
    game.winningScore = this.settings.winningScore;
    game.isPracticeMode = this.settings.practice;
    this.ticker.maxFPS = this.settings.fps;
    game.view.intro.visible = false;
    game.view.menu.visible = false;
    game.view.fadeInOut.setBlackAlphaTo(0);
    game.paused = true;
    this.bindLocalKeys();
    this.peerSequences.clear();
    this.inputSequence = 0;
    this.events = [];
  }
  async start(settings) {
    if (!this.room || !this.room.isHost || this.room.closed)
      throw new Error('Only the room host can start a match.');
    for (const id of Object.keys(this.room.data.members)) {
      if (id !== this.room.selfId && !this.room.connected(id))
        throw new Error(
          'Wait for all players to connect, or remove the disconnected player.'
        );
    }
    const checked = matchSettings(settings);
    if (!lobbyReady(this.room.data))
      throw new Error(
        'Every joined player must select a slot before starting.'
      );
    this.room.data = await this.room.store.beginMatch(
      this.room.id,
      this.room.selfId,
      checked
    );
    this.epoch = randomId();
    this.phase = 'playing';
    this.frame = 0;
    this.initialize(checked, this.room.data.members);
    this.room.broadcast({
      type: 'begin',
      epoch: this.epoch,
      settings: checked,
      members: this.room.data.members,
    });
    if (!this.lockstep) this.sendState();
    this.notify();
  }
  refreshRoster() {
    if (!this.room || !this.epoch) return;
    const member = this.room.data.members[this.room.selfId];
    const slots = this.matchSlots || (member ? member.slots : []);
    if (JSON.stringify(slots) !== JSON.stringify(this.localSlots))
      this.bindLocalKeys();
    if (!this.room.isHost) return;
    const humans = [];
    Object.entries(this.room.data.members).forEach(([id, member]) => {
      if (id === this.room.selfId || this.room.connected(id))
        humans.push(...member.slots);
    });
    if (this.lockstep) {
      for (const id of this.lockstep.members.keys()) {
        if (
          !this.room.data.members[id] ||
          (id !== this.room.selfId && !this.room.connected(id))
        )
          this.lockstep.remove(id);
      }
    } else
      this.game.players.forEach((player, i) => {
        player.isComputer = !humans.includes(i);
      });
  }
  peerOpened(id) {
    if (this.room.isHost && this.epoch && !this.lockstep) {
      this.room.send(id, {
        type: 'begin',
        epoch: this.epoch,
        settings: this.settings,
      });
      this.room.send(
        id,
        captureSnapshot(this.game, this.epoch, ++this.frame, this.phase)
      );
    }
    this.refreshRoster();
    this.notify();
  }
  peerClosed(id) {
    if (!this.room) return;
    if (this.room.isHost) {
      const member = this.room.data.members[id];
      if (this.lockstep) this.lockstep.remove(id);
      if (member && !this.lockstep)
        member.slots.forEach((slot) => {
          this.game.players[slot].isComputer = true;
          this.inputs[slot].reset();
        });
      this.room.removeMember(id).catch((error) => this.notify(error));
    } else {
      this.stop();
      this.room.shutdown();
      this.notify(new Error('The host disconnected. The room has closed.'));
    }
    this.notify();
  }
  applyLiveSettings(settings) {
    this.settings = settings;
    this.game.normalFPS = settings.fps;
    this.ticker.maxFPS = settings.fps;
    this.game.isPracticeMode = settings.practice;
    if (this.lockstep) {
      this.stopInputTimer();
      this.inputTimer = setInterval(() => this.tick(true), 1000 / settings.fps);
    }
  }
  async updateLiveSettings(value) {
    if (!this.room || this.room.closed || !this.room.isHost || !this.epoch)
      throw new Error('Only the host can change match settings.');
    const checked = matchSettings(value);
    if (!canUpdateLive(this.settings, checked))
      throw new Error('These settings require a match restart.');
    const epoch = this.epoch;
    await this.room.store.update(this.room.id, { settings: checked });
    if (this.room.closed || this.epoch !== epoch) return;
    if (this.lockstep) {
      // Reliable ordered delivery puts this change after all preceding frames.
      // Discard queued inputs on every browser, keeping the match and pause state.
      const generation = this.lockstep.generation + 1;
      this.lockstep.control(generation, this.game.paused);
      this.inputs.forEach((input) => input.reset());
      this.room.broadcast({
        type: 'frame-control',
        epoch,
        generation,
        paused: this.game.paused,
        frame: this.lockstep.frame,
        settings: checked,
      });
    } else
      this.room.broadcast({ type: 'live-settings', epoch, settings: checked });
    this.applyLiveSettings(checked);
    if (!this.lockstep) this.sendState();
    this.notify();
  }
  pause() {
    if (
      !this.room ||
      !this.room.isHost ||
      !this.epoch ||
      this.phase === 'finished'
    )
      return;
    this.game.paused = !this.game.paused;
    this.phase = this.game.paused ? 'paused' : 'playing';
    this.inputs.forEach((input) => input.reset());
    if (this.lockstep) {
      const generation = this.lockstep.generation + 1;
      this.lockstep.control(generation, this.game.paused);
      this.room.broadcast({
        type: 'frame-control',
        epoch: this.epoch,
        generation,
        paused: this.game.paused,
        frame: this.lockstep.frame,
      });
    } else this.sendState();
    this.notify();
  }
  withRng(callback) {
    setCustomRng(this.rng);
    try {
      return callback();
    } finally {
      setCustomRng(null);
    }
  }
  stopInputTimer() {
    clearInterval(this.inputTimer);
    this.inputTimer = null;
  }
  initialize(settings, members) {
    this.stopInputTimer();
    this.lockstep = null;
    this.matchSlots = members[this.room.selfId].slots.slice();
    this.rng =
      settings.synchronization === 'lockstep'
        ? seedrandom.alea(this.epoch)
        : null;
    this.withRng(() => {
      this.prepare(settings);
      const humans = Object.values(members).flatMap((member) => member.slots);
      this.game.players.forEach((player, slot) => {
        player.isComputer = !humans.includes(slot);
      });
      this.game.frameCounter = 0;
      this.game.state = this.game.startOfNewGame;
      this.game.paused = false;
      this.game.startOfNewGame();
    });
    if (settings.synchronization === 'lockstep') {
      this.lockstep = new Lockstep({
        epoch: this.epoch,
        selfId: this.room.selfId,
        hostId: this.room.data.hostId,
        members,
        send: (id, packet) => this.room.send(id, packet),
        broadcast: (packet) => this.room.broadcast(packet),
        advance: (inputs, humans, frame) => {
          this.lastFrame = this.frame = frame;
          this.game.players.forEach((player, slot) => {
            player.isComputer = !humans.includes(slot);
          });
          inputs.forEach((input, slot) => this.inputs[slot].push(input));
          this.withRng(() => this.step());
          this.events = [];
        },
      });
      // Background tabs may suspend requestAnimationFrame, so sample inputs separately.
      this.inputTimer = setInterval(() => this.tick(true), 1000 / settings.fps);
    }
  }
  step() {
    this.game.gameLoop();
    if (this.game.state === this.game.intro) {
      this.phase = 'finished';
      this.game.paused = true;
      if (this.lockstep) this.lockstep.paused = true;
      this.game.view.intro.visible = false;
      this.game.view.game.visible = true;
      this.game.view.game.messages.gameEnd.visible = true;
      this.notify();
    }
  }
  tick(fromInputTimer = false) {
    if (this.lockstep && !fromInputTimer) return;
    if (!this.room || this.room.closed || !this.epoch) return;
    // Do not consume a power-hit edge while the input pipeline is full.
    if (
      this.lockstep &&
      (this.phase !== 'playing' ||
        this.lockstep.sampled >= this.lockstep.frame + INPUT_WINDOW)
    )
      return;
    const typing =
      !!document.querySelector('.fade-in-box:not(.hidden)') ||
      (document.activeElement &&
        ['INPUT', 'SELECT', 'TEXTAREA'].includes(
          document.activeElement.tagName
        ));
    const values = this.keyboards.map(({ slot, keyboard }) => {
      keyboard.getInput();
      return {
        slot,
        xDirection:
          typing || this.phase !== 'playing' ? 0 : keyboard.xDirection,
        yDirection:
          typing || this.phase !== 'playing' ? 0 : keyboard.yDirection,
        powerHit: typing || this.phase !== 'playing' ? 0 : keyboard.powerHit,
      };
    });
    if (this.lockstep) {
      if (this.phase === 'playing') this.lockstep.sample(values);
      return;
    }
    if (this.room.isHost) {
      values.forEach((value) => this.inputs[value.slot].push(value));
      if (this.phase === 'playing') this.step();
      this.sendState();
    } else {
      this.room.send(
        this.room.data.hostId,
        {
          type: 'input',
          epoch: this.epoch,
          seq: ++this.inputSequence,
          inputs: values,
        },
        true
      );
    }
  }
  sendState() {
    if (!this.epoch || !this.room || !this.room.isHost || this.lockstep) return;
    this.room.broadcast(
      captureSnapshot(
        this.game,
        this.epoch,
        ++this.frame,
        this.phase,
        this.events.splice(0)
      ),
      true
    );
  }
  message(id, message) {
    if (!this.room || this.room.closed) return;
    if (
      this.lockstep &&
      ['frame-input', 'frame', 'frame-control'].includes(message.type)
    ) {
      if (message.type === 'frame-control') {
        let settings;
        if (message.settings !== undefined) {
          try {
            settings = matchSettings(message.settings);
          } catch (_) {
            return;
          }
          if (!canUpdateLive(this.settings, settings)) return;
        }
        if (
          id !== this.room.data.hostId ||
          message.epoch !== this.epoch ||
          message.frame !== this.lockstep.frame ||
          !this.lockstep.control(message.generation, message.paused)
        )
          return;
        if (settings) this.applyLiveSettings(settings);
        this.game.paused = message.paused;
        if (this.phase !== 'finished')
          this.phase = message.paused ? 'paused' : 'playing';
        this.inputs.forEach((input) => input.reset());
        this.notify();
      } else this.lockstep.receive(id, message);
      return;
    }
    if (this.room.isHost) {
      if (this.lockstep) return;
      const member = this.room.data.members[id];
      if (!member || this.phase !== 'playing') return;
      const inputs = ownedInputs(
        message,
        member.slots,
        this.epoch,
        this.peerSequences.has(id) ? this.peerSequences.get(id) : -1
      );
      if (!inputs) return;
      this.peerSequences.set(id, message.seq);
      inputs.forEach(({ slot, input }) => this.inputs[slot].push(input));
      return;
    }
    if (id !== this.room.data.hostId) return;
    if (message.type === 'live-settings') {
      if (this.lockstep || message.epoch !== this.epoch) return;
      let settings;
      try {
        settings = matchSettings(message.settings);
      } catch (_) {
        return;
      }
      if (!canUpdateLive(this.settings, settings)) return;
      this.applyLiveSettings(settings);
      this.notify();
      return;
    }
    if (message.type === 'lobby') {
      this.stop();
      return;
    }
    if (message.type === 'begin') {
      if (typeof message.epoch !== 'string' || message.epoch.length > 64)
        return;
      if (message.epoch === this.epoch) return;
      try {
        const settings = matchSettings(message.settings);
        this.epoch = message.epoch;
        this.lastFrame = -1;
        this.phase = 'playing';
        if (settings.synchronization === 'lockstep') {
          if (
            !message.members ||
            !message.members[this.room.selfId] ||
            !message.members[this.room.data.hostId]
          )
            throw new Error('Invalid lockstep roster.');
          this.initialize(settings, message.members);
        } else {
          this.stopInputTimer();
          this.lockstep = null;
          this.matchSlots =
            message.members && message.members[this.room.selfId]
              ? message.members[this.room.selfId].slots.slice()
              : null;
          this.rng = null;
          this.prepare(settings);
          this.game.audio.sounds.bgm.play();
        }
        this.notify();
      } catch (error) {
        this.notify(error);
      }
      return;
    }
    if (this.lockstep || !validSnapshot(message, this.epoch, this.lastFrame))
      return;
    this.lastFrame = message.frame;
    const phaseChanged = this.phase !== message.phase;
    this.phase = message.phase;
    this.applySnapshot(message);
    if (phaseChanged) this.notify();
  }
  applySnapshot(packet) {
    const game = this.game,
      view = game.view.game;
    game.players.forEach((player, i) =>
      assignFields(player, packet.players[i], PLAYER_FIELDS)
    );
    assignFields(game.physics.ball, packet.ball, BALL_FIELDS);
    game.scores = packet.scores.slice();
    game.gameEnded = !!packet.gameEnded;
    view.visible = true;
    const visualBall = {
      ...game.physics.ball,
      punchEffectRadius:
        game.physics.ball.punchEffectRadius > 0
          ? game.physics.ball.punchEffectRadius + 2
          : 0,
    };
    view.drawPlayersAndBall({ players: game.players, ball: visualBall });
    view.drawScoresToScoreBoards(game.scores);
    view.cloudArray.forEach((cloud, i) => {
      assignFields(cloud, packet.clouds[i], CLOUD_FIELDS);
      const sprite = view.cloudContainer.getChildAt(i);
      sprite.x = cloud.spriteTopLeftPointX;
      sprite.y = cloud.spriteTopLeftPointY;
      sprite.width = cloud.spriteWidth;
      sprite.height = cloud.spriteHeight;
    });
    view.wave.yCoords = packet.wave.slice();
    view.waveContainer.children.forEach((sprite, i) => {
      sprite.y = packet.wave[i % packet.wave.length];
    });
    if (packet.messages)
      for (const key of ['ready', 'gameStart', 'gameEnd'])
        assignFields(view.messages[key], packet.messages[key], MESSAGE_FIELDS);
    game.view.fadeInOut.setBlackAlphaTo(packet.fade);
    if (Array.isArray(packet.events))
      packet.events.slice(0, 16).forEach((event) => {
        if (
          event &&
          [
            'pipikachu',
            'pika',
            'chu',
            'powerHit',
            'ballTouchesGround',
          ].includes(event.name)
        )
          game.audio.sounds[event.name].play(
            event.side === -1 ? -1 : event.side === 1 ? 1 : 0
          );
      });
  }
  stop() {
    this.stopInputTimer();
    this.clearKeys();
    this.inputs.forEach((input) => input.reset());
    this.phase = 'idle';
    this.matchSlots = null;
    this.epoch = null;
    this.lockstep = null;
    this.rng = null;
    this.lastFrame = -1;
    this.game.paused = true;
    this.game.audio.sounds.bgm.stop();
    this.game.view.game.visible = false;
    this.game.view.menu.visible = false;
    this.game.view.intro.visible = false;
    this.game.view.fadeInOut.setBlackAlphaTo(0);
    this.notify();
  }
}
