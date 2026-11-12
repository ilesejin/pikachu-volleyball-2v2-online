import { applyChatPosition } from '../online_2v2/chat_position.js';
import { PikachuVolleyball } from '../offline_2v2/pikavolley.js';
import { ASSETS_PATH as DOUBLES_ASSETS } from '../offline_2v2/assets_path.js';
import { ASSETS_PATH } from '../offline_version_js/assets_path.js';
import { restoreCheckpoint } from '../online_2v2/checkpoint.js';
import { OnlineMatch, validSnapshot } from '../online_2v2/session.js';
import { setCustomRng } from '../offline_2v2/rand.js';
import { unpackInputs } from '../online_2v2/replay_format.js';
import { translateMessage } from '../online_2v2/i18n.js';
import { matchSettings, playerName } from '../online_2v2/protocol.js';
import {
  noticeEndOfReplay,
  adjustPlayPauseBtnIcon,
  adjustFPSInputValue,
  moveScrubberTo,
  showTimeCurrent,
} from './ui_replay.js';
import './doubles_replay.css';

export class DoublesPlayback {
  constructor(owner, pack) {
    this.owner = owner;
    this.pack = pack;
    this.events = pack.events;
    this.cursor = 0;
    this.chats = [];
    DOUBLES_ASSETS.SPRITE_SHEET = ASSETS_PATH.SPRITE_SHEET;
    Object.assign(DOUBLES_ASSETS.SOUNDS, ASSETS_PATH.SOUNDS);
    Object.assign(DOUBLES_ASSETS.TEXTURES, ASSETS_PATH.TEXTURES);
    this.game = new PikachuVolleyball(
      owner.stage,
      owner.loader.resources,
      (width) => {
        owner.renderer.resize(width, 304);
        document.documentElement.style.setProperty(
          '--aspect-ratio',
          String(width / 304)
        );
        document.documentElement.style.setProperty(
          '--inverse-aspect-ratio',
          String(304 / width)
        );
      }
    );
    this.game.keyboardArray.forEach((keyboard) => keyboard.unsubscribe());
    this.driver = {
      game: this.game,
      ticker: owner.ticker,
      clearKeys: () => {},
      detachGameKeys: () =>
        this.game.keyboardArray.forEach((keyboard) => keyboard.unsubscribe()),
      bindLocalKeys: () => {},
      peerSequences: new Map(),
    };
    this.times = [0];
    this.checkpoints = [];
    this.events.forEach((event, index) => {
      this.times.push(this.times[index] + event.dt);
      if (['checkpoint', 'snapshot'].includes(event.type))
        this.checkpoints.push(index);
    });
    if (!this.checkpoints.length)
      throw new Error('Replay has no playable frames.');
    this.duration = this.times.at(-1);
    for (const id of ['doubles-names', 'doubles-chat', 'doubles-keys'])
      document.getElementById(id)?.remove();
    this.names = document.createElement('div');
    this.names.id = 'doubles-names';
    this.chatLayer = document.createElement('div');
    this.chatLayer.id = 'doubles-chat';
    document
      .getElementById('game-canvas-container')
      .append(this.names, this.chatLayer);
    this.keys = document.createElement('div');
    this.keys.id = 'doubles-keys';
    document.getElementById('keyboard-container').append(this.keys);
    document
      .querySelectorAll('#keyboard-container .grid-for-keyboard')
      .forEach((element) => {
        element.hidden = true;
      });
    document.querySelector('.nicknames-container').hidden = true;
    document.getElementById(
      'show-ip-addresses-checkbox'
    ).parentElement.hidden = true;
    const info = document.createElement('p');
    info.id = 'replay-session-info';
    info.textContent = pack.complete
      ? document.documentElement.lang === 'ko'
        ? '방장 전체 세션 기록'
        : document.documentElement.lang === 'zh'
        ? '房主完整房間紀錄'
        : 'Authoritative room-session recording'
      : document.documentElement.lang === 'ko'
      ? '일부 로컬 기록 — 방장의 전체 기록과 다를 수 있습니다.'
      : document.documentElement.lang === 'zh'
      ? '本機部分紀錄，可能與房主的完整紀錄不同。'
      : 'Partial local recording — may differ from the host’s complete recording.';
    document.getElementById('scrubber-range-input').after(info);
    this.seek(0);
  }
  prepare(event) {
    const settings = matchSettings(event.settings);
    if (
      !this.settings ||
      this.settings.courtWidth !== settings.courtWidth ||
      this.settings.serveMode !== settings.serveMode
    )
      OnlineMatch.prototype.prepare.call(this.driver, settings);
    this.game.normalFPS = settings.fps;
    this.game.winningScore = settings.winningScore;
    this.game.isPracticeMode = settings.practice;
    this.settings = settings;
    this.members = event.members || {};
    const baseline = new Set(
      Object.keys(this.game).filter((key) =>
        ['number', 'boolean', 'string'].includes(typeof this.game[key])
      )
    );
    if (event.type === 'checkpoint') {
      const cp = event.checkpoint;
      if (
        !cp ||
        ![
          'startOfNewGame',
          'round',
          'afterEndOfRound',
          'beforeStartOfNextRound',
          'intro',
        ].includes(cp.state) ||
        !cp.values ||
        Object.keys(cp.values).some((key) => !baseline.has(key)) ||
        !Array.isArray(cp.players) ||
        cp.players.length !== 4 ||
        !Array.isArray(cp.inputs) ||
        cp.inputs.length !== 4 ||
        !Array.isArray(cp.clouds) ||
        cp.clouds.length !== 10 ||
        !cp.ball ||
        !cp.physics ||
        !Array.isArray(cp.nextServer) ||
        cp.nextServer.length !== 2 ||
        !cp.wave ||
        !Array.isArray(cp.scores) ||
        cp.scores.length !== 2
      )
        throw new Error('Invalid replay checkpoint.');
      this.rng = restoreCheckpoint(this.game, this.driver.inputs, cp);
      this.showInputs(cp.inputs);
    }
    if (!validSnapshot(event.visual, event.epoch, -1))
      throw new Error('Invalid replay image.');
    this.applyVisual(event.visual);
    this.game.view.intro.visible = false;
    this.game.view.menu.visible = false;
    this.game.view.game.scoreBoards.forEach((board) => {
      board.visible = !settings.practice;
    });
    this.owner.ticker.maxFPS =
      this.owner.playBackSpeedFPS ||
      settings.fps * this.owner.playBackSpeedTimes;
    adjustFPSInputValue();
  }
  applyVisual(visual) {
    OnlineMatch.prototype.applySnapshot.call(
      { game: this.game },
      { ...visual, events: [] }
    );
  }
  event(event, silent) {
    if (event.type === 'checkpoint' || event.type === 'snapshot') {
      this.prepare(event);
      if (event.type === 'snapshot') this.showInputs(null);
      if (event.type === 'snapshot' && !silent)
        OnlineMatch.prototype.applySnapshot.call(
          { game: this.game },
          event.visual
        );
    } else if (event.type === 'step') {
      const values = unpackInputs(event.inputs);
      let draw = 0;
      this.driver.inputs.forEach((input, i) => {
        input.getInput = function () {
          Object.assign(this, values[i]);
          this.pendingHit = false;
        };
      });
      const oldAudio = this.game.audio;
      if (silent) this.game.audio = this.silentAudio();
      setCustomRng(() => {
        if (draw >= event.random.length)
          throw new Error('Replay random sequence does not match the engine.');
        const recorded = event.random[draw++];
        if (!this.rng) return recorded / 32768;
        const value = this.rng();
        if (Math.floor(value * 32768) !== recorded)
          throw new Error('Replay random sequence does not match the engine.');
        return value;
      });
      try {
        OnlineMatch.prototype.stepGame.call({
          game: this.game,
          phase: 'playing',
          lockstep: null,
          notify: () => {},
        });
      } finally {
        setCustomRng(null);
        this.game.audio = oldAudio;
      }
      if (draw !== event.random.length)
        throw new Error('Replay random sequence does not match the engine.');
      this.showInputs(values);
    } else if (event.type === 'chat')
      this.chats.push({
        packet: event.packet,
        until: this.times[this.cursor] + 3,
      });
    else if (event.type === 'lobby')
      this.members = event.data.members || this.members;
    this.game.timeCurrent = this.times[this.cursor + 1];
    this.game.replayFrameCounter = this.cursor + 1;
  }
  silentAudio() {
    const sound = {
      play: () => {},
      stop: () => {},
      center: { isPlaying: false },
    };
    return {
      sounds: Object.fromEntries(
        Object.keys(this.game.audio.sounds).map((key) => [key, sound])
      ),
    };
  }
  showInputs(values) {
    if (!this.keyPads) {
      this.keyPads = Array.from({ length: 4 }, (_, slot) => {
        const card = document.createElement('div');
        card.className = 'replay-player-input';
        card.setAttribute('role', 'group');
        card.setAttribute('aria-label', 'P' + (slot + 1));
        const label = document.createElement('div');
        label.className = 'replay-keypad-label';
        label.textContent = 'P' + (slot + 1);
        const grid = document.createElement('div');
        grid.className = 'grid-for-keyboard replay-keypad';
        const buttons = {};
        for (const [action, text] of [
          ['hit', 'Enter'],
          ['up', '↑'],
          ['left', '←'],
          ['down', '↓'],
          ['right', '→'],
        ]) {
          const key = document.createElement('div');
          key.className = 'keyboard-key replay-key-' + action;
          key.textContent = text;
          key.dataset.action = action;
          grid.append(key);
          buttons[action] = key;
        }
        card.append(label, grid);
        this.keys.append(card);
        return { grid, buttons };
      });
    }
    this.keyPads.forEach(({ grid, buttons }, slot) => {
      const input = values && values[slot];
      grid.classList.toggle('unavailable', !input);
      const pressed = {
        hit: !!input?.powerHit,
        up: input?.yDirection < 0,
        down: input?.yDirection > 0,
        left: input?.xDirection < 0,
        right: input?.xDirection > 0,
      };
      for (const [action, key] of Object.entries(buttons))
        key.classList.toggle('pressed', !!pressed[action]);
    });
  }
  render() {
    this.names.replaceChildren();
    if (document.getElementById('show-nicknames-checkbox').checked)
      for (let slot = 0; slot < 4; slot++) {
        const member = Object.values(this.members || {}).find((value) =>
          value.slots.includes(slot)
        );
        const label = document.createElement('span');
        label.textContent =
          'P' +
          (slot + 1) +
          ' · ' +
          (member && !this.game.players[slot].isComputer
            ? playerName(member, slot)
            : 'AI');
        this.names.append(label);
      }
    this.chatLayer.replaceChildren();
    const time = this.game.timeCurrent || 0;
    this.chats = this.chats.filter((chat) => chat.until > time);
    if (document.getElementById('show-chat-checkbox').checked)
      for (const chat of this.chats) {
        const packet = chat.packet;
        if (
          !packet ||
          typeof packet.text !== 'string' ||
          !packet.position ||
          !Number.isFinite(packet.position.top) ||
          !Number.isFinite(packet.position.offset)
        )
          continue;
        const bubble = document.createElement('div');
        bubble.className = 'chat-box pre-wrap';
        bubble.textContent = packet.text;
        bubble.title = packet.name;
        applyChatPosition(bubble, packet.position);
        this.chatLayer.append(bubble);
      }
    this.owner.renderer.render(this.owner.stage);
    moveScrubberTo(this.cursor);
    showTimeCurrent(time);
  }
  tick() {
    try {
      if (this.cursor >= this.events.length) {
        this.owner.ticker.stop();
        this.owner.stopBGM();
        adjustPlayPauseBtnIcon();
        noticeEndOfReplay();
        return;
      }
      let stepped = false;
      while (this.cursor < this.events.length) {
        const event = this.events[this.cursor];
        if (stepped && event.dt > 0) break;
        this.event(event, false);
        this.cursor++;
        if (event.dt > 0) stepped = true;
      }
      this.render();
    } catch (error) {
      this.error = error;
      this.owner.ticker.stop();
      this.owner.stopBGM();
      document.getElementById('replay-session-info').textContent =
        translateMessage(error.message);
    }
  }
  seek(index) {
    this.error = null;
    index = Math.max(0, Math.min(this.events.length, Math.floor(index)));
    this.game.audio.sounds.bgm.stop();
    this.chats = [];
    let start = this.checkpoints[0];
    for (const checkpoint of this.checkpoints) {
      if (checkpoint > index) break;
      start = checkpoint;
    }
    this.cursor = start;
    this.event(this.events[start], true);
    this.cursor++;
    while (this.cursor < index) {
      this.event(this.events[this.cursor], true);
      this.cursor++;
    }
    this.game.timeCurrent = this.times[this.cursor];
    this.game.replayFrameCounter = this.cursor;
    this.chats = [];
    for (
      let i = this.cursor - 1;
      i >= 0 && this.times[i] >= this.game.timeCurrent - 3;
      i--
    )
      if (this.events[i].type === 'chat')
        this.chats.unshift({
          packet: this.events[i].packet,
          until: this.times[i] + 3,
        });
    this.render();
  }
  seekTime(time) {
    let low = 0,
      high = this.times.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >>> 1;
      if (this.times[mid] <= time) low = mid;
      else high = mid - 1;
    }
    this.seek(low);
  }
}
