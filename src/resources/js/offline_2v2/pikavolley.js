/**
 * The Controller part in MVC pattern
 */
'use strict';
import { GROUND_HALF_WIDTH, PikaPhysics } from './physics.js';
import { MenuView, GameView, FadeInOut, IntroView } from './view.js';
import { PikaKeyboard } from './keyboard.js';
import { PikaAudio } from './audio.js';
import { DoublesPhysics } from './doubles_physics.js';
import { DOUBLES_CONFIG } from './doubles_config.js';

/** @typedef {import('@pixi/display').Container} Container */
/** @typedef {import('@pixi/loaders').LoaderResource} LoaderResource */

/** @typedef GameState @type {function():void} */

/**
 * Class representing Pikachu Volleyball game
 */
export class PikachuVolleyball {
  /**
   * Create a Pikachu Volleyball game which includes physics, view, audio
   * @param {Container} stage container which is rendered by PIXI.Renderer or PIXI.CanvasRenderer
   * @param {Object.<string,LoaderResource>} resources resources property of the PIXI.Loader object which is used for loading the game resources
   */
  constructor(stage, resources, resize = () => {}) {
    this.stage = stage;
    this.resources = resources;
    this.resize = resize;
    this.isDoubles = false;
    this.doublesCourtWidth = DOUBLES_CONFIG.courtWidth;
    this.doublesServeMode = DOUBLES_CONFIG.serveMode;
    this.view = {
      intro: new IntroView(resources),
      menu: new MenuView(resources),
      game: new GameView(resources),
      fadeInOut: new FadeInOut(resources),
    };
    stage.addChild(this.view.intro.container);
    stage.addChild(this.view.menu.container);
    stage.addChild(this.view.game.container);
    stage.addChild(this.view.fadeInOut.black);
    this.view.intro.visible = false;
    this.view.menu.visible = false;
    this.view.game.visible = false;
    this.view.fadeInOut.visible = false;

    this.audio = new PikaAudio(resources);
    this.physics = new PikaPhysics(true, true);
    this.keyboardArray = [
      new PikaKeyboard('KeyD', 'KeyG', 'KeyR', 'KeyV', 'KeyZ', 'KeyF'), // for player1
      new PikaKeyboard( // for player2
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
        'Enter'
      ),
    ];

    /** @type {number} game fps */
    this.normalFPS = 25;
    /** @type {number} fps for slow motion */
    this.slowMotionFPS = 5;

    /** @constant @type {number} number of frames for slow motion */
    this.SLOW_MOTION_FRAMES_NUM = 6;
    /** @type {number} number of frames left for slow motion */
    this.slowMotionFramesLeft = 0;
    /** @type {number} number of elapsed normal fps frames for rendering slow motion */
    this.slowMotionNumOfSkippedFrames = 0;

    /** @type {number} 0: vs computers, 1: all humans, 2: solo human (2v2 only) */
    this.selectedWithWho = 0;

    /** @type {number[]} [0] for player 1 score, [1] for player 2 score */
    this.scores = [0, 0];
    /** @type {number} winning score: if either one of the players reaches this score, game ends */
    this.winningScore = 15;

    /** @type {boolean} Is the game ended? */
    this.gameEnded = false;
    /** @type {boolean} Is the round ended? */
    this.roundEnded = false;
    /** @type {boolean} Will player 2 serve? */
    this.isPlayer2Serve = false;

    /** @type {number} frame counter */
    this.frameCounter = 0;
    /** @type {Object.<string,number>} total number of frames for each game state */
    this.frameTotal = {
      intro: 165,
      afterMenuSelection: 15,
      beforeStartOfNewGame: 15,
      startOfNewGame: 71,
      afterEndOfRound: 5,
      beforeStartOfNextRound: 30,
      gameEnd: 211,
    };

    /** @type {number} counter for frames while there is no input from keyboard */
    this.noInputFrameCounter = 0;
    /** @type {Object.<string,number>} total number of frames to be rendered while there is no input */
    this.noInputFrameTotal = {
      menu: 225,
    };

    /** @type {boolean} true: paused, false: not paused */
    this.paused = false;

    /** @type {boolean} true: stereo, false: mono */
    this.isStereoSound = true;

    /** @type {boolean} true: practice mode on, false: practice mode off */
    this._isPracticeMode = false;

    /**
     * The game state which is being rendered now
     * @type {GameState}
     */
    this.state = this.intro;
    // Chinese pages retain the original game; EN/KO default to 2v2.
    if (document.documentElement.lang !== 'zh') this.setMode(true);
  }

  get players() {
    return this.physics instanceof DoublesPhysics
      ? this.physics.players
      : [this.physics.player1, this.physics.player2];
  }

  get halfWidth() {
    return this.isDoubles ? this.doublesCourtWidth : GROUND_HALF_WIDTH;
  }

  setMode(isDoubles) {
    this.keyboardArray.forEach((keyboard) => keyboard.unsubscribe());
    this.isDoubles = isDoubles;
    this.physics = isDoubles
      ? new DoublesPhysics(this.doublesCourtWidth, this.doublesServeMode)
      : new PikaPhysics(true, true);
    this.keyboardArray = isDoubles
      ? [
          new PikaKeyboard('KeyA', 'KeyD', 'KeyW', 'KeyX', 'KeyZ', 'KeyS'),
          new PikaKeyboard('KeyG', 'KeyJ', 'KeyY', 'KeyB', 'KeyV', 'KeyH'),
          new PikaKeyboard('KeyL', 'Quote', 'KeyP', 'Semicolon', 'Comma'),
          new PikaKeyboard(
            'ArrowLeft',
            'ArrowRight',
            'ArrowUp',
            'ArrowDown',
            'Enter'
          ),
        ]
      : [
          new PikaKeyboard('KeyD', 'KeyG', 'KeyR', 'KeyV', 'KeyZ', 'KeyF'),
          new PikaKeyboard(
            'ArrowLeft',
            'ArrowRight',
            'ArrowUp',
            'ArrowDown',
            'Enter'
          ),
        ];
    const width = isDoubles ? this.doublesCourtWidth * 2 : 432;
    const oldView = this.view.game;
    const index = this.stage.getChildIndex(oldView.container);
    this.stage.removeChild(oldView.container);
    oldView.container.destroy({ children: true });
    this.view.game = new GameView(
      this.resources,
      width,
      isDoubles ? DOUBLES_CONFIG.playerTints : null
    );
    this.stage.addChildAt(this.view.game.container, index);
    this.view.menu.setDoublesMode(
      isDoubles,
      document.documentElement.lang === 'ko',
      width
    );
    this.view.menu.container.x = (width - 432) / 2;
    this.view.intro.container.x = (width - 432) / 2;
    this.view.fadeInOut.black.width = width;
    this.resize(width);
    this.isPracticeMode = this._isPracticeMode;
    this.audio.sounds.bgm.stop();
    this.restart();
    this.view.intro.visible = false;
    this.view.fadeInOut.setBlackAlphaTo(0);
    this.state = isDoubles ? this.menu : this.intro;
    for (const [id, selected] of [
      ['mode-original-btn', !isDoubles],
      ['mode-doubles-btn', isDoubles],
    ]) {
      const button = document.getElementById(id);
      if (button) button.classList.toggle('selected', selected);
    }
    const guide = document.getElementById('doubles-controls');
    if (guide) guide.hidden = !isDoubles;
  }

  setCourtWidth(width) {
    if (!Number.isInteger(width) || width < 216) return false;
    if (width === this.doublesCourtWidth) return true;
    this.doublesCourtWidth = width;
    if (this.isDoubles) this.restartDoublesMatch();
    return true;
  }

  setServeMode(mode) {
    if (!DoublesPhysics.isValidServeMode(mode)) return false;
    if (mode === this.doublesServeMode) return true;
    this.doublesServeMode = mode;
    if (this.isDoubles) this.restartDoublesMatch();
    return true;
  }

  restartDoublesMatch() {
    const lineup = this.players.map((player) => player.isComputer);
    const hadMatch = this.view.game.visible;
    this.setMode(true);
    this.players.forEach((player, i) => {
      player.isComputer = lineup[i];
    });
    if (hadMatch) {
      this.state = this.startOfNewGame;
      this.startOfNewGame();
    }
  }

  initializeRound(newMatch = false) {
    if (this.physics instanceof DoublesPhysics) {
      this.physics.initializeRound(this.isPlayer2Serve, newMatch);
    } else {
      this.physics.player1.initializeForNewRound();
      this.physics.player2.initializeForNewRound();
      this.physics.ball.initializeForNewRound(this.isPlayer2Serve);
    }
  }

  /**
   * Game loop
   * This function should be called at regular intervals ( interval = (1 / FPS) second )
   */
  gameLoop() {
    if (this.paused === true) {
      return;
    }
    if (this.slowMotionFramesLeft > 0) {
      this.slowMotionNumOfSkippedFrames++;
      if (
        this.slowMotionNumOfSkippedFrames %
          Math.round(this.normalFPS / this.slowMotionFPS) !==
        0
      ) {
        return;
      }
      this.slowMotionFramesLeft--;
      this.slowMotionNumOfSkippedFrames = 0;
    }
    // catch keyboard input and freeze it
    this.keyboardArray.forEach((keyboard) => keyboard.getInput());
    this.state();
  }

  /**
   * Intro: a man with a brief case
   * @type {GameState}
   */
  intro() {
    if (this.frameCounter === 0) {
      this.view.intro.visible = true;
      this.view.fadeInOut.setBlackAlphaTo(0);
      this.audio.sounds.bgm.stop();
    }
    this.view.intro.drawMark(this.frameCounter);
    this.frameCounter++;

    if (this.keyboardArray.some((keyboard) => keyboard.powerHit === 1)) {
      this.frameCounter = 0;
      this.view.intro.visible = false;
      this.state = this.menu;
    }

    if (this.frameCounter >= this.frameTotal.intro) {
      this.frameCounter = 0;
      this.view.intro.visible = false;
      this.state = this.menu;
    }
  }

  /**
   * Menu: select who do you want to play. With computer? With friend?
   * @type {GameState}
   */
  menu() {
    const physics = this.physics;
    if (this.frameCounter === 0) {
      this.view.menu.visible = true;
      this.view.fadeInOut.setBlackAlphaTo(0);
      this.selectedWithWho = 0;
      this.menuDirectionPrevious = 0;
      this.view.menu.selectWithWho(this.selectedWithWho);
    }
    this.view.menu.drawFightMessage(this.frameCounter);
    this.view.menu.drawSachisoft(this.frameCounter);
    this.view.menu.drawSittingPikachuTiles(this.frameCounter);
    this.view.menu.drawPikachuVolleyballMessage(this.frameCounter);
    this.view.menu.drawPokemonMessage(this.frameCounter);
    this.view.menu.drawWithWhoMessages(this.frameCounter);
    this.frameCounter++;

    if (
      this.frameCounter < 71 &&
      this.keyboardArray.some((keyboard) => keyboard.powerHit === 1)
    ) {
      this.frameCounter = 71;
      return;
    }

    if (this.frameCounter <= 71) {
      return;
    }

    if (this.isDoubles) {
      const direction = this.keyboardArray.some(
        (keyboard) => keyboard.yDirection === -1
      )
        ? -1
        : this.keyboardArray.some((keyboard) => keyboard.yDirection === 1)
        ? 1
        : 0;
      const selected = Math.max(
        0,
        Math.min(2, this.selectedWithWho + direction)
      );
      // One choice per press prevents a held direction skipping the middle option.
      if (
        direction !== 0 &&
        direction !== this.menuDirectionPrevious &&
        selected !== this.selectedWithWho
      ) {
        this.noInputFrameCounter = 0;
        this.selectedWithWho = selected;
        this.view.menu.selectWithWho(selected);
        this.audio.sounds.pi.play();
      } else {
        this.noInputFrameCounter++;
      }
      this.menuDirectionPrevious = direction;
    } else {
      if (
        this.keyboardArray.some((keyboard) => keyboard.yDirection === -1) &&
        this.selectedWithWho === 1
      ) {
        this.noInputFrameCounter = 0;
        this.selectedWithWho = 0;
        this.view.menu.selectWithWho(this.selectedWithWho);
        this.audio.sounds.pi.play();
      } else if (
        this.keyboardArray.some((keyboard) => keyboard.yDirection === 1) &&
        this.selectedWithWho === 0
      ) {
        this.noInputFrameCounter = 0;
        this.selectedWithWho = 1;
        this.view.menu.selectWithWho(this.selectedWithWho);
        this.audio.sounds.pi.play();
      } else {
        this.noInputFrameCounter++;
      }
    }

    if (this.keyboardArray.some((keyboard) => keyboard.powerHit === 1)) {
      if (physics instanceof DoublesPhysics) {
        const humanPosition = this.keyboardArray.findIndex(
          (keyboard) => keyboard.powerHit === 1
        );
        this.players.forEach((player, i) => {
          player.isComputer =
            this.selectedWithWho === 2
              ? i !== humanPosition
              : this.selectedWithWho === 0 && i >= 2;
        });
      } else if (this.selectedWithWho === 1) {
        physics.player1.isComputer = false;
        physics.player2.isComputer = false;
      } else {
        if (this.keyboardArray[0].powerHit === 1) {
          physics.player1.isComputer = false;
          physics.player2.isComputer = true;
        } else if (this.keyboardArray[1].powerHit === 1) {
          physics.player1.isComputer = true;
          physics.player2.isComputer = false;
        }
      }
      this.audio.sounds.pikachu.play();
      this.frameCounter = 0;
      this.noInputFrameCounter = 0;
      this.state = this.afterMenuSelection;
      return;
    }

    if (this.noInputFrameCounter >= this.noInputFrameTotal.menu) {
      this.players.forEach((player) => {
        player.isComputer = true;
      });
      this.frameCounter = 0;
      this.noInputFrameCounter = 0;
      this.state = this.afterMenuSelection;
    }
  }

  /**
   * Fade out after menu selection
   * @type {GameState}
   */
  afterMenuSelection() {
    this.view.fadeInOut.changeBlackAlphaBy(1 / 16);
    this.frameCounter++;
    if (this.frameCounter >= this.frameTotal.afterMenuSelection) {
      this.frameCounter = 0;
      this.state = this.beforeStartOfNewGame;
    }
  }

  /**
   * Delay before start of new game (This is for the delay that exist in the original game)
   * @type {GameState}
   */
  beforeStartOfNewGame() {
    this.frameCounter++;
    if (this.frameCounter >= this.frameTotal.beforeStartOfNewGame) {
      this.frameCounter = 0;
      this.view.menu.visible = false;
      this.state = this.startOfNewGame;
    }
  }

  /**
   * Start of new game: Initialize ball and players and print game start message
   * @type {GameState}
   */
  startOfNewGame() {
    if (this.frameCounter === 0) {
      this.view.game.visible = true;
      this.gameEnded = false;
      this.roundEnded = false;
      this.isPlayer2Serve = false;
      this.players.forEach((player) => {
        player.gameEnded = false;
        player.isWinner = false;
      });

      this.scores[0] = 0;
      this.scores[1] = 0;
      this.view.game.drawScoresToScoreBoards(this.scores);

      this.initializeRound(true);
      this.view.game.drawPlayersAndBall(this.physics);

      this.view.fadeInOut.setBlackAlphaTo(1); // set black screen
      this.audio.sounds.bgm.play();
    }

    this.view.game.drawGameStartMessage(
      this.frameCounter,
      this.frameTotal.startOfNewGame
    );
    this.view.game.drawCloudsAndWave();
    this.view.fadeInOut.changeBlackAlphaBy(-(1 / 17)); // fade in
    this.frameCounter++;

    if (this.frameCounter >= this.frameTotal.startOfNewGame) {
      this.frameCounter = 0;
      this.view.fadeInOut.setBlackAlphaTo(0);
      this.state = this.round;
    }
  }

  /**
   * Round: the players play volleyball in this game state
   * @type {GameState}
   */
  round() {
    const pressedPowerHit = this.keyboardArray.some(
      (keyboard) => keyboard.powerHit === 1
    );

    if (this.players.every((player) => player.isComputer) && pressedPowerHit) {
      this.frameCounter = 0;
      this.view.game.visible = false;
      this.state = this.intro;
      return;
    }

    const isBallTouchingGround = this.physics.runEngineForNextFrame(
      this.keyboardArray
    );

    this.playSoundEffect();
    this.view.game.drawPlayersAndBall(this.physics);
    this.view.game.drawCloudsAndWave();

    if (this.gameEnded === true) {
      this.view.game.drawGameEndMessage(this.frameCounter);
      this.frameCounter++;
      if (
        this.frameCounter >= this.frameTotal.gameEnd ||
        (this.frameCounter >= 70 && pressedPowerHit)
      ) {
        this.frameCounter = 0;
        this.view.game.visible = false;
        this.state = this.intro;
      }
      return;
    }

    if (
      isBallTouchingGround &&
      this._isPracticeMode === false &&
      this.roundEnded === false &&
      this.gameEnded === false
    ) {
      if (this.physics.ball.punchEffectX < this.halfWidth) {
        this.isPlayer2Serve = true;
        this.scores[1] += 1;
        if (this.scores[1] >= this.winningScore) {
          this.gameEnded = true;
          this.players.forEach((player) => {
            player.isWinner = player.isPlayer2;
            player.gameEnded = true;
          });
        }
      } else {
        this.isPlayer2Serve = false;
        this.scores[0] += 1;
        if (this.scores[0] >= this.winningScore) {
          this.gameEnded = true;
          this.players.forEach((player) => {
            player.isWinner = !player.isPlayer2;
            player.gameEnded = true;
          });
        }
      }
      this.view.game.drawScoresToScoreBoards(this.scores);
      if (this.roundEnded === false && this.gameEnded === false) {
        this.slowMotionFramesLeft = this.SLOW_MOTION_FRAMES_NUM;
      }
      this.roundEnded = true;
    }

    if (this.roundEnded === true && this.gameEnded === false) {
      // if this is the last frame of this round, begin fade out
      if (this.slowMotionFramesLeft === 0) {
        this.view.fadeInOut.changeBlackAlphaBy(1 / 16); // fade out
        this.state = this.afterEndOfRound;
      }
    }
  }

  /**
   * Fade out after end of round
   * @type {GameState}
   */
  afterEndOfRound() {
    this.view.fadeInOut.changeBlackAlphaBy(1 / 16);
    this.frameCounter++;
    if (this.frameCounter >= this.frameTotal.afterEndOfRound) {
      this.frameCounter = 0;
      this.state = this.beforeStartOfNextRound;
    }
  }

  /**
   * Before start of next round, initialize ball and players, and print ready message
   * @type {GameState}
   */
  beforeStartOfNextRound() {
    if (this.frameCounter === 0) {
      this.view.fadeInOut.setBlackAlphaTo(1);
      this.view.game.drawReadyMessage(false);

      this.initializeRound();
      this.view.game.drawPlayersAndBall(this.physics);
    }

    this.view.game.drawCloudsAndWave();
    this.view.fadeInOut.changeBlackAlphaBy(-(1 / 16));

    this.frameCounter++;
    if (this.frameCounter % 5 === 0) {
      this.view.game.toggleReadyMessage();
    }

    if (this.frameCounter >= this.frameTotal.beforeStartOfNextRound) {
      this.frameCounter = 0;
      this.view.game.drawReadyMessage(false);
      this.view.fadeInOut.setBlackAlphaTo(0);
      this.roundEnded = false;
      this.state = this.round;
    }
  }

  /**
   * Play sound effect on {@link round}
   */
  playSoundEffect() {
    const audio = this.audio;
    for (let i = 0; i < this.players.length; i++) {
      const player = this.players[i];
      const sound = player.sound;
      let leftOrCenterOrRight = 0;
      if (this.isStereoSound) {
        leftOrCenterOrRight = player.isPlayer2 ? 1 : -1;
      }
      if (sound.pipikachu === true) {
        audio.sounds.pipikachu.play(leftOrCenterOrRight);
        sound.pipikachu = false;
      }
      if (sound.pika === true) {
        audio.sounds.pika.play(leftOrCenterOrRight);
        sound.pika = false;
      }
      if (sound.chu === true) {
        audio.sounds.chu.play(leftOrCenterOrRight);
        sound.chu = false;
      }
    }
    const ball = this.physics.ball;
    const sound = ball.sound;
    let leftOrCenterOrRight = 0;
    if (this.isStereoSound) {
      if (ball.punchEffectX < this.halfWidth) {
        leftOrCenterOrRight = -1;
      } else if (ball.punchEffectX > this.halfWidth) {
        leftOrCenterOrRight = 1;
      }
    }
    if (sound.powerHit === true) {
      audio.sounds.powerHit.play(leftOrCenterOrRight);
      sound.powerHit = false;
    }
    if (sound.ballTouchesGround === true) {
      audio.sounds.ballTouchesGround.play(leftOrCenterOrRight);
      sound.ballTouchesGround = false;
    }
  }

  /**
   * Called if restart button clicked
   */
  restart() {
    this.frameCounter = 0;
    this.noInputFrameCounter = 0;
    this.slowMotionFramesLeft = 0;
    this.slowMotionNumOfSkippedFrames = 0;
    this.view.menu.visible = false;
    this.view.game.visible = false;
    this.state = this.intro;
  }

  /** @return {boolean} */
  get isPracticeMode() {
    return this._isPracticeMode;
  }

  /**
   * @param {boolean} bool true: turn on practice mode, false: turn off practice mode
   */
  set isPracticeMode(bool) {
    this._isPracticeMode = bool;
    this.view.game.scoreBoards[0].visible = !bool;
    this.view.game.scoreBoards[1].visible = !bool;
  }
}
