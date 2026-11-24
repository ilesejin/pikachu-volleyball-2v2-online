import { GameView, FadeInOut } from '../offline_2v2/view.js';
import { PikaAudio } from '../offline_2v2/audio.js';
import { ASSETS_PATH } from '../offline_2v2/assets_path.js';
import { ASSETS_PATH as VIEWER_ASSETS } from '../offline_version_js/assets_path.js';
import { DOUBLES_CONFIG } from '../offline_2v2/doubles_config.js';
import { timeline, patch, unpackedInputs } from './visual/format.js';
import { apply } from './visual/visual.js';
import { DoublesPlayback } from './doubles_playback.js';
import {
  noticeEndOfReplay,
  adjustPlayPauseBtnIcon,
  adjustFPSInputValue,
  moveScrubberTo,
  showTimeCurrent,
} from './ui_replay.js';

// Visual events share the room replay container but need no physics engine version.
export class VisualPlayback {
  constructor(owner, pack) {
    this.owner = owner;
    this.pack = pack;
    const value = timeline(pack);
    this.frames = value.frames;
    this.events = this.frames;
    this.duration = value.duration / 1000;
    this.times = this.frames
      .map((frame) => frame.at / 1000)
      .concat(this.duration);
    this.cursor = 0;
    this.segment = -1;
    ASSETS_PATH.SPRITE_SHEET = VIEWER_ASSETS.SPRITE_SHEET;
    Object.assign(ASSETS_PATH.SOUNDS, VIEWER_ASSETS.SOUNDS);
    this.game = {
      audio: new PikaAudio(owner.loader.resources),
      timeCurrent: 0,
      replayFrameCounter: 0,
      normalFPS: 30,
      players: [],
    };
    this.keys = document.createElement('div');
    this.keys.id = 'doubles-keys';
    document.getElementById('keyboard-container').append(this.keys);
    document
      .querySelectorAll('#keyboard-container > .grid-for-keyboard')
      .forEach((node) => (node.hidden = true));
    document.querySelector('.nicknames-container').hidden = true;
    for (const id of [
      'show-chat-checkbox',
      'show-nicknames-checkbox',
      'show-ip-addresses-checkbox',
    ]) {
      const node = document.getElementById(id);
      node.checked = false;
      node.disabled = true;
      node.parentElement.hidden = true;
    }
    const info = document.createElement('p');
    info.id = 'replay-session-info';
    info.textContent =
      document.documentElement.lang === 'ko'
        ? '\uC624\uD504\uB77C\uC778 2\uB3002 \uC138\uC158 \uAE30\uB85D'
        : document.documentElement.lang === 'zh'
        ? '\u96E2\u7DDA2\u5C0D2\u5206\u9801\u8A18\u9304'
        : 'Offline 2v2 page-session recording';
    document.getElementById('scrubber-range-input').after(info);
    this.seek(0);
  }
  showFrame(index) {
    const entry = this.frames[index];
    const segment = this.pack.segments[entry.segment];
    if (this.segment !== entry.segment) {
      if (this.view) {
        this.owner.stage.removeChild(this.view.container);
        this.view.container.destroy({ children: true });
      }
      if (this.fade) {
        this.owner.stage.removeChild(this.fade.black);
        this.fade.black.destroy();
      }
      ASSETS_PATH.TEXTURES.GAME_START =
        this.pack.language === 'ko'
          ? 'messages/ko/game_start.png'
          : 'messages/ja/game_start.png';
      this.view = new GameView(
        this.owner.loader.resources,
        segment.settings.width,
        DOUBLES_CONFIG.playerTints
      );
      this.fade = new FadeInOut(this.owner.loader.resources);
      this.fade.black.width = segment.settings.width;
      this.owner.stage.addChild(this.view.container, this.fade.black);
      this.owner.renderer.resize(segment.settings.width, 304);
      document.documentElement.style.setProperty(
        '--aspect-ratio',
        String(segment.settings.width / 304)
      );
      document.documentElement.style.setProperty(
        '--inverse-aspect-ratio',
        String(304 / segment.settings.width)
      );
      this.segment = entry.segment;
      this.game.view = { game: this.view, fadeInOut: this.fade };
    }
    const vector = segment.frames[entry.key].key.slice();
    for (let i = entry.key + 1; i <= entry.frame; i++) {
      const frame = segment.frames[i];
      if (frame.key) vector.splice(0, vector.length, ...frame.key);
      else patch(vector, frame.delta);
    }
    apply(this.view, this.fade, vector);
    this.game.normalFPS = segment.settings.fps;
    this.game.scores = vector.slice(3, 5);
    this.game.players = Array.from({ length: 4 }, (_, i) => ({
      isComputer: !!(vector[2] & (1 << i)),
    }));
    DoublesPlayback.prototype.showInputs.call(
      this,
      unpackedInputs(vector[1]).map((v) => ({
        xDirection: v.x,
        yDirection: v.y,
        powerHit: +v.hit,
      }))
    );
    this.keys.querySelectorAll('.replay-keypad-label').forEach((node, i) => {
      node.textContent =
        'P' +
        (i + 1) +
        ' \u00b7 ' +
        (this.game.players[i].isComputer
          ? 'AI'
          : document.documentElement.lang === 'ko'
          ? '\uC0AC\uB78C'
          : document.documentElement.lang === 'zh'
          ? '\u73A9\u5BB6'
          : 'Human');
    });
    this.current = index;
    this.vector = vector;
    this.owner.ticker.maxFPS =
      this.owner.playBackSpeedFPS ||
      (1000 / segment.frames[entry.frame].dt) * this.owner.playBackSpeedTimes;
    adjustFPSInputValue();
  }
  render() {
    this.owner.renderer.render(this.owner.stage);
    moveScrubberTo(this.cursor);
    showTimeCurrent(this.game.timeCurrent);
  }
  seek(index) {
    this.error = null;
    this.cursor = Math.max(0, Math.min(this.frames.length, Math.floor(index)));
    this.game.audio.sounds.bgm.stop();
    this.showFrame(Math.max(0, this.cursor - 1));
    this.game.timeCurrent = this.times[this.cursor];
    this.game.replayFrameCounter = this.cursor;
    this.render();
  }
  seekTime(seconds) {
    let low = 0,
      high = this.times.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >>> 1;
      if (this.times[mid] <= seconds) low = mid;
      else high = mid - 1;
    }
    this.seek(low);
  }
  tick() {
    try {
      if (this.cursor >= this.frames.length) {
        this.owner.ticker.stop();
        this.owner.stopBGM();
        adjustPlayPauseBtnIcon();
        noticeEndOfReplay();
        return;
      }
      this.showFrame(this.cursor);
      const entry = this.frames[this.cursor];
      this.pack.segments[entry.segment].frames[entry.frame].sounds.forEach(
        ([name, side]) => this.game.audio.sounds[name].play(side)
      );
      this.cursor++;
      this.game.timeCurrent = this.times[this.cursor];
      this.game.replayFrameCounter = this.cursor;
      this.render();
    } catch (error) {
      this.error = error;
      this.owner.ticker.stop();
      this.owner.stopBGM();
      document.getElementById('replay-session-info').textContent =
        error.message;
    }
  }
}
