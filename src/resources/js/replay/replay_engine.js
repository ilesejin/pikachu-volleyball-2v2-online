// Playback-only adapter; no signaling, authentication, or room connections.
import { matchSettings, RemoteInput } from '../online_2v2/protocol.js';
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
    inputs: game.keyboardArray.map((input) =>
      pick(input, ['xDirection', 'yDirection', 'powerHit'])
    ),
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
    (packet.inputs === undefined ||
      (Array.isArray(packet.inputs) &&
        packet.inputs.length === 4 &&
        packet.inputs.every(
          (input) =>
            input &&
            [-1, 0, 1].includes(input.xDirection) &&
            [-1, 0, 1].includes(input.yDirection) &&
            [0, 1].includes(input.powerHit)
        ))) &&
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
  stepGame() {
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
}
