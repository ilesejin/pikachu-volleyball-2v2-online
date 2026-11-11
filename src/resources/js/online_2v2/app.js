import { settings } from '@pixi/settings';
import { SCALE_MODES } from '@pixi/constants';
import { Renderer, BatchRenderer, autoDetectRenderer } from '@pixi/core';
import { Prepare } from '@pixi/prepare';
import { Container } from '@pixi/display';
import { Loader } from '@pixi/loaders';
import { SpritesheetLoader } from '@pixi/spritesheet';
import { Ticker } from '@pixi/ticker';
import { CanvasRenderer } from '@pixi/canvas-renderer';
import { CanvasSpriteRenderer } from '@pixi/canvas-sprite';
import { CanvasPrepare } from '@pixi/canvas-prepare';
import '@pixi/canvas-display';
import { PikachuVolleyball } from '../offline_2v2/pikavolley.js';
import { ASSETS_PATH } from '../offline_2v2/assets_path.js';
import { OnlineRoom } from './room.js';
import { FirebaseRoomStore } from './firebase_store.js';
import { OnlineMatch } from './session.js';
import {
  matchSettings,
  canUpdateLive,
  ROOM_SCHEMA,
  lobbyReady,
  playerName,
} from './protocol.js';
import { QuickMatch } from './quick_match.js';
import { quickMatchServerURL } from './quick_match_config.js';
import '../../style.css';
import '../offline_version_js/utils/dark_color_scheme.js';
import { setUpClassicUI } from './classic_ui.js';
import './style.css';

const matchmakingURL =
  process.env.NODE_ENV === 'development' &&
  ['localhost', '127.0.0.1'].includes(location.hostname) &&
  window.__PIKA_TEST_MATCH_URL__
    ? window.__PIKA_TEST_MATCH_URL__
    : quickMatchServerURL;
const ko = document.documentElement.lang === 'ko';
const text = (en, korean) => (ko ? korean : en);
const $ = (id) => document.getElementById(id);
const status = (message, error = false) => {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
};
const params = new URLSearchParams(location.search);
let classicUI,
  quickMatch,
  room,
  session,
  game,
  inspected = null,
  busy = false;
function settingsFromForm() {
  return matchSettings({
    courtWidth: $('court-width').value,
    serveMode: $('serve-mode').value,
    fps: $('speed').value,
    winningScore: $('winning-score').value,
    practice: $('practice-mode').checked,
    topology: $('topology').value,
    synchronization: $('synchronization').value,
  });
}
function namesFromForm() {
  return $('layout').value === 'pairs'
    ? [$('nickname').value, $('pair-name').value]
    : [$('nickname').value];
}
function slotsFromForm() {
  return [];
}
function renderPositions() {
  $('pair-name-label').hidden = $('layout').value !== 'pairs';
  $('join').disabled = !inspected;
}
function updateSettingsForm(value) {
  $('court-width').value = value.courtWidth;
  $('serve-mode').value = value.serveMode;
  $('speed').value = value.fps;
  $('winning-score').value = value.winningScore;
  $('practice-mode').checked = !!value.practice;
  $('topology').value = value.topology;
  $('synchronization').value = value.synchronization;
}
function update(error) {
  if (error) status(error.message || String(error), true);
  $('quick-match').disabled =
    busy || !matchmakingURL || !!(quickMatch && quickMatch.active);
  $('cancel-search').hidden = !quickMatch || !quickMatch.active || !room.closed;
  if (!room || room.closed) {
    $('connect-panel').hidden = false;
    $('room-panel').hidden = true;
    $('host-panel').hidden = true;
    $('local-panel').hidden = true;
    $('game-panel').hidden = true;
    $('create').disabled = busy;
    $('find').disabled = busy;
    if (classicUI) classicUI.update();
    return;
  }
  $('start').disabled =
    busy ||
    !lobbyReady(room.data) ||
    !room.ready() ||
    Object.values(room.data.members).some((member) => !member.connected) ||
    Object.keys(room.data.members).some(
      (id) => id !== room.selfId && !room.connected(id)
    );
  $('leave').disabled = busy;
  $('connect-panel').hidden = true;
  $('room-panel').hidden = false;
  $('host-panel').hidden = !room.isHost;
  $('local-panel').hidden = false;
  $('game-panel').hidden = !session.epoch;
  $('room-code').textContent = room.id;
  const invite = new URL(location.href);
  invite.search = '';
  invite.searchParams.set('room', room.id);
  $('invite-link').value = invite.toString();
  const data = room.data;
  $('arrangement').textContent =
    data.layout === 'four'
      ? text(
          'One human per browser · up to four browsers',
          '브라우저당 1명 · 최대 4개 브라우저'
        )
      : text(
          'Two humans per browser · two browsers',
          '브라우저당 2명 · 2개 브라우저'
        );
  $('roster').replaceChildren();
  for (let slot = 0; slot < 4; slot++) {
    const owner = data.seats[slot];
    const member = owner && data.members[owner];
    const card = document.createElement('li');
    card.className = 'player player-' + slot;
    const title = document.createElement('strong');
    title.textContent =
      'P' +
      (slot + 1) +
      ' · ' +
      (slot < 2 ? text('Left', '왼쪽') : text('Right', '오른쪽'));
    const name = document.createElement('span');
    name.textContent = member
      ? playerName(member, slot) +
        (owner === room.selfId ? text(' (you)', ' (나)') : '')
      : text('Computer / open slot', '컴퓨터 / 빈 자리');
    const connection = document.createElement('small');
    connection.textContent = member
      ? owner === data.hostId
        ? text('Host', '방장')
        : member.connected
        ? text('Connected', '연결됨')
        : text('Connecting…', '연결 중…')
      : text('AI fills this position', 'AI가 이 자리를 담당합니다');
    card.append(title, name, connection);
    if (room.isHost && owner && owner !== room.selfId) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'secondary';
      remove.textContent = text('Remove', '내보내기');
      remove.addEventListener('click', () =>
        run(async () => {
          session.peerClosed(owner);
        })
      );
      card.appendChild(remove);
    }
    $('roster').appendChild(card);
  }
  const me = data.members[room.selfId];
  $('my-positions').textContent =
    text('You control: ', '조작 선수: ') +
    (me ? me.slots.map((slot) => 'P' + (slot + 1)).join(' + ') : '—');
  const phase = {
    idle: text('Lobby', '대기실'),
    playing: text('Playing', '경기 중'),
    paused: text('Paused by host', '방장이 일시정지함'),
    finished: text('Match finished', '경기 종료'),
  }[session.phase];
  $('phase').textContent = phase;
  $('pause').disabled = busy || !session.epoch || session.phase === 'finished';
  $('pause').textContent =
    session.phase === 'paused'
      ? text('Resume', '계속')
      : text('Pause', '일시정지');
  $('back-lobby').disabled = busy || !session.epoch;
  if (!room.isHost && data.settings)
    updateSettingsForm(session.epoch ? session.settings : data.settings);
  if (classicUI) classicUI.update();
}
async function run(action) {
  if (busy) return;
  busy = true;
  $('create').disabled = true;
  $('join').disabled = true;
  $('find').disabled = true;
  update();
  try {
    await action();
  } catch (error) {
    status(error.message || String(error), true);
  } finally {
    busy = false;
    update();
    if (room.closed) $('join').disabled = !inspected;
  }
}
function makeRoom(store) {
  return new OnlineRoom(
    {
      networkReset: () => session.stop(),
      change: () => {
        if (session.epoch && room.data.status === 'lobby') session.stop();
        session.refreshRoster();
        update();
      },
      open: (id) => {
        session.peerOpened(id);
        status(
          text(
            'Connected. The host can start the match.',
            '연결되었습니다. 방장이 경기를 시작할 수 있습니다.'
          )
        );
        update();
      },
      message: (id, message) => {
        if (!classicUI || !classicUI.chat.receive(id, message))
          session.message(id, message);
      },
      peerClosed: (id) => session.peerClosed(id),
      ended: () => {
        session.stop();
        status(
          text(
            'The room closed or you left the room.',
            '방이 닫혔거나 방에서 나왔습니다.'
          )
        );
        update();
      },
      error: (error) => status(error.message || String(error), true),
    },
    store
  );
}

async function boot() {
  Renderer.registerPlugin('prepare', Prepare);
  Renderer.registerPlugin('batch', BatchRenderer);
  CanvasRenderer.registerPlugin('prepare', CanvasPrepare);
  CanvasRenderer.registerPlugin('sprite', CanvasSpriteRenderer);
  Loader.registerPlugin(SpritesheetLoader);
  settings.RESOLUTION = 2;
  settings.SCALE_MODE = SCALE_MODES.NEAREST;
  settings.ROUND_PIXELS = true;
  if (ko)
    for (const [name, file] of Object.entries({
      MARK: 'mark',
      POKEMON: 'pokemon',
      PIKACHU_VOLLEYBALL: 'pikachu_volleyball',
      FIGHT: 'fight',
      WITH_COMPUTER: 'with_computer',
      WITH_FRIEND: 'with_friend',
      GAME_START: 'game_start',
    }))
      ASSETS_PATH.TEXTURES[name] = 'messages/ko/' + file + '.png';
  const renderer = autoDetectRenderer({
    width: 768,
    height: 304,
    antialias: false,
    backgroundColor: 0,
    forceCanvas: true,
  });
  renderer.view.id = 'game-canvas';
  $('canvas-container').appendChild(renderer.view);
  const stage = new Container(),
    ticker = new Ticker(),
    loader = new Loader();
  loader.add(ASSETS_PATH.SPRITE_SHEET);
  Object.values(ASSETS_PATH.SOUNDS).forEach((url) => loader.add(url));
  await new Promise((resolve, reject) => {
    loader.onError.add((error) => reject(error));
    loader.load(resolve);
  });
  game = new PikachuVolleyball(stage, loader.resources, (width) => {
    renderer.resize(width, 304);
    document.documentElement.style.setProperty(
      '--aspect-ratio',
      String(width / 304)
    );
    document.documentElement.style.setProperty(
      '--inverse-aspect-ratio',
      String(304 / width)
    );
  });
  session = new OnlineMatch(game, ticker, update);
  let store = new FirebaseRoomStore();
  // Browser tests may inject a local signaling store; production builds ignore this hook.
  if (
    process.env.NODE_ENV === 'development' &&
    ['localhost', '127.0.0.1'].includes(location.hostname) &&
    window.__PIKA_TEST_STORE__
  )
    store = window.__PIKA_TEST_STORE__;
  room = makeRoom(store);
  session.attachRoom(room);
  quickMatch = new QuickMatch({
    room,
    changed: () => update(),
    notify: (state, error) => {
      if (error)
        status(text('Quick Match: ', '빠른 대전: ') + error.message, true);
      else
        status(
          {
            waiting: text(
              'Finding a Quick Match room…',
              '빠른 대전 방을 찾는 중…'
            ),
            hosting: text(
              'Quick Match room open. You may start early with computers.',
              '빠른 대전 방을 열었습니다. 컴퓨터와 먼저 시작할 수 있습니다.'
            ),
            joined: text(
              'Quick Match found. Connecting to the host…',
              '빠른 대전을 찾았습니다. 방장에게 연결 중…'
            ),
          }[state]
        );
    },
    request: async (body) => {
      if (!matchmakingURL)
        throw new Error(
          text(
            'Configure quick_match_config.js first.',
            '먼저 quick_match_config.js를 설정하세요.'
          )
        );
      const token = await store.token();
      const response = await fetch(
        matchmakingURL.replace(/\/$/, '') + '/v1/match',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + token,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10000),
        }
      );
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || 'Quick Match request failed.');
      return data;
    },
  });
  ticker.maxFPS = 25;
  ticker.add(() => {
    session.tick();
    if (classicUI) classicUI.render();
    renderer.render(stage);
  });
  ticker.start();
  if (process.env.NODE_ENV === 'development')
    window.__volley = { game, session, room };
  classicUI = setUpClassicUI({
    room,
    session,
    game,
    renderer,
    applySettings: (value) =>
      run(async () => {
        if (!room.isHost) return;
        const checked = matchSettings(value);
        if (checked.topology !== room.data.settings.topology) {
          await room.rebuildNetwork(checked);
        } else if (session.epoch) {
          if (canUpdateLive(session.settings, checked))
            await session.updateLiveSettings(checked);
          else await session.start(checked);
        }
        updateSettingsForm(checked);
        status(text('Game options applied.', '경기 설정을 적용했습니다.'));
      }),
  });
  updateSettingsForm(matchSettings());
  renderPositions();
  update();
  status(
    text(
      'Ready. Create a room or find a friend’s room.',
      '준비되었습니다. 방을 만들거나 친구의 방을 찾으세요.'
    )
  );
  $('settings-form').addEventListener('submit', (event) =>
    event.preventDefault()
  );
  $('layout').addEventListener('change', () => {
    inspected = null;
    renderPositions();
  });
  $('room-id').addEventListener('input', () => {
    inspected = null;
    $('join').disabled = true;
  });
  $('quick-match').addEventListener('click', () =>
    run(async () => {
      inspected = null;
      await quickMatch.start({
        name: namesFromForm(),
        layout: $('layout').value,
        region: $('match-region').value,
        settings: settingsFromForm(),
      });
      $('fill-ai').checked = true;
    })
  );
  $('cancel-search').addEventListener('click', () => {
    quickMatch.stop();
  });
  $('create').addEventListener('click', () =>
    run(async () => {
      await room.create(
        $('nickname').value || 'Player',
        $('layout').value,
        slotsFromForm(),
        settingsFromForm()
      );
      status(
        text(
          'Room created. Choose a slot and share the invitation link.',
          '방을 만들었습니다. 자리를 고르고 초대 링크를 공유하세요.'
        )
      );
      update();
    })
  );
  const find = () =>
    run(async () => {
      const id = $('room-id').value.trim().toLowerCase();
      if (!/^[a-z0-9]{20}$/.test(id))
        throw new Error(
          text('Enter the 20-character room ID.', '20자리 방 ID를 입력하세요.')
        );
      await store.identity();
      const data = await store.peek(id);
      if (!data || data.schema !== ROOM_SCHEMA || data.status !== 'lobby')
        throw new Error(
          text(
            'Room not found, or the match has already started.',
            '방이 없거나 이미 경기가 시작되었습니다.'
          )
        );
      inspected = { id, data };
      $('layout').value = data.layout;
      renderPositions(data);
      status(
        text(
          'Join the lobby, then choose an empty slot.',
          '대기실에 참가한 뒤 빈 자리를 선택하세요.'
        )
      );
    });
  $('find').addEventListener('click', find);
  $('join').addEventListener('click', () =>
    run(async () => {
      if (!inspected)
        throw new Error(text('Find the room first.', '먼저 방을 찾으세요.'));
      await room.join(
        inspected.id,
        $('nickname').value || 'Player',
        slotsFromForm()
      );
      status(text('Connecting to the host…', '방장에게 연결 중…'));
      update();
    })
  );
  $('leave').addEventListener('click', () =>
    run(async () => {
      if (quickMatch.active) await quickMatch.stop();
      session.stop();
      await room.leave();
      inspected = null;
      renderPositions();
      status(text('Left the room.', '방에서 나왔습니다.'));
    })
  );
  $('start').addEventListener('click', () =>
    run(async () => {
      if (!$('fill-ai').checked && room.data.seats.some((owner) => !owner))
        throw new Error(
          text(
            'Fill all four positions, or enable AI for empty positions.',
            '네 자리를 모두 채우거나 빈 자리 AI를 켜세요.'
          )
        );
      if (!$('settings-form').reportValidity()) return;
      await session.start(settingsFromForm());
      if (quickMatch.active) await quickMatch.stop();
      status(text('Match started.', '경기를 시작했습니다.'));
      update();
    })
  );
  $('pause').addEventListener('click', () => {
    session.pause();
    update();
  });
  $('back-lobby').addEventListener('click', () =>
    run(async () => {
      if (!room.isHost) return;
      session.stop();
      room.broadcast({ type: 'lobby' });
      await room.store.update(room.id, { status: 'lobby' });
      update();
    })
  );
  $('copy-link').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('invite-link').value);
      status(text('Invitation link copied.', '초대 링크를 복사했습니다.'));
    } catch (error) {
      $('invite-link').select();
      status(
        text(
          'Copy the selected invitation link.',
          '선택된 초대 링크를 복사하세요.'
        )
      );
    }
  });
  $('controls').addEventListener('change', () => {
    session.controls($('controls').value);
    update();
  });
  document.querySelectorAll('input,select').forEach((input) => {
    input.addEventListener('keydown', (event) => event.stopPropagation());
    input.addEventListener('keyup', (event) => event.stopPropagation());
  });
  window.addEventListener('beforeunload', () => {
    if (quickMatch.active) quickMatch.stop();
    if (!room.closed) {
      session.stop();
      room.leave().catch(() => {});
    }
  });
  if (params.get('room')) {
    $('room-id').value = params.get('room');
    await find();
  }
}
boot().catch((error) =>
  status(
    text('Could not load the game: ', '게임을 불러오지 못했습니다: ') +
      error.message,
    true
  )
);
