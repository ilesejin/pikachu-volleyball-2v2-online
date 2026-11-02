import { RoomChat } from './chat.js';
import { playerName, matchSettings } from './protocol.js';

export function setUpClassicUI({
  room,
  session,
  game,
  renderer,
  applySettings,
}) {
  const $ = (id) => document.getElementById(id);
  const ko = document.documentElement.lang === 'ko';
  const t = (en, korean) => (ko ? korean : en);
  let pending = null,
    courtBefore = null,
    lastEpoch = undefined,
    lastRoom = null;
  let bgm = true,
    sfx = 'stereo';
  let editedNamesKey = '';
  const closeMenus = () => {
    document
      .querySelectorAll('#menu-bar .show')
      .forEach((el) => el.classList.remove('show'));
    document
      .querySelectorAll('#menu-bar .open')
      .forEach((el) => el.classList.remove('open'));
    document
      .querySelectorAll('#menu-bar [aria-expanded]')
      .forEach((el) => el.setAttribute('aria-expanded', 'false'));
  };
  function closeDialog(id) {
    $(id).classList.add('hidden');
    if (document.activeElement && document.activeElement.blur)
      document.activeElement.blur();
  }
  function openDialog(id) {
    closeMenus();
    session.releaseLocalKeys();
    const inCourt =
      !!session.epoch &&
      $('game-canvas-container').getBoundingClientRect().height >= 360;
    (inCourt ? $('game-canvas-container') : document.body).appendChild($(id));
    $(id).classList.toggle('fixed', !inCourt);
    $(id).classList.remove('hidden');
    const focus = $(id).querySelector(
      'input:not([hidden]),select:not([hidden]),button'
    );
    if (focus) focus.focus();
  }
  function formSettings() {
    return {
      courtWidth: Number($('court-width').value),
      serveMode: $('serve-mode').value,
      fps: Number($('speed').value),
      winningScore: Number($('winning-score').value),
      practice: $('practice-mode').checked,
      synchronization: $('synchronization').value,
    };
  }
  function setForm(value) {
    $('court-width').value = value.courtWidth;
    $('serve-mode').value = value.serveMode;
    $('speed').value = value.fps;
    $('winning-score').value = value.winningScore;
    $('practice-mode').checked = !!value.practice;
    $('synchronization').value = value.synchronization;
  }
  const choose = async (value) => {
    if (!room.isHost || room.closed) return;
    closeMenus();
    if (session.epoch) {
      pending = value;
      $('settings-confirm-text').textContent = t(
        'Apply the selected game options to everyone?',
        '선택한 경기 설정을 모두에게 적용할까요?'
      );
      openDialog('settings-confirm');
    } else await applySettings(value);
  };
  for (const [button, panel] of [
    ['options-dropdown-btn', 'options-dropdown'],
    ['match-dropdown-btn', 'host-panel'],
  ]) {
    $(button).setAttribute('aria-expanded', 'false');
    $(button).addEventListener('click', (event) => {
      event.stopPropagation();
      const open = !$(panel).classList.contains('show');
      closeMenus();
      $(panel).classList.toggle('show', open);
      $(button).setAttribute('aria-expanded', String(open));
    });
  }
  for (const id of ['start', 'pause', 'back-lobby'])
    $(id).addEventListener('click', closeMenus);
  document.querySelectorAll('.submenu-btn').forEach((button) => {
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('mouseenter', () => {
      const panel = $(button.id.replace('-btn', ''));
      if (
        !panel.classList.contains('show') &&
        button.closest('.dropdown').classList.contains('show')
      )
        button.click();
    });
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const panel = $(button.id.replace('-btn', ''));
      const open = !panel.classList.contains('show');
      document
        .querySelectorAll('.submenu')
        .forEach((el) => el.classList.remove('show'));
      document.querySelectorAll('.submenu-btn').forEach((el) => {
        el.classList.remove('open');
        el.setAttribute('aria-expanded', 'false');
      });
      panel.classList.toggle('show', open);
      button.classList.toggle('open', open);
      button.setAttribute('aria-expanded', String(open));
    });
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#menu-bar')) closeMenus();
  });
  document.querySelectorAll('[data-close]').forEach((button) =>
    button.addEventListener('click', () => {
      const id = button.dataset.close;
      if (id === 'match-settings-dialog' && courtBefore) setForm(courtBefore);
      closeDialog(id);
    })
  );
  $('with-your-friend-btn').addEventListener('click', () => {
    $('about-with-your-friend').hidden = !$('about-with-your-friend').hidden;
  });
  $('court-submenu-btn').addEventListener('click', () => {
    courtBefore = formSettings();
    openDialog('match-settings-dialog');
  });
  $('controls-open-btn').addEventListener('click', () =>
    openDialog('controls-dialog')
  );
  $('settings-apply').addEventListener('click', () => {
    if (!$('settings-form').reportValidity()) return;
    const value = formSettings();
    if (courtBefore) setForm(courtBefore);
    closeDialog('match-settings-dialog');
    choose(value);
  });
  $('settings-confirm-yes').addEventListener('click', () => {
    const value = pending;
    pending = null;
    closeDialog('settings-confirm');
    if (value) applySettings(value);
  });
  $('settings-confirm-no').addEventListener('click', () => {
    pending = null;
    closeDialog('settings-confirm');
  });
  for (const [id, fps] of [
    ['slow', 20],
    ['medium', 25],
    ['fast', 30],
  ])
    $(id + '-speed-btn').addEventListener('click', () =>
      choose({ ...formSettings(), fps })
    );
  for (const winningScore of [5, 10, 15])
    $('winning-score-' + winningScore + '-btn').addEventListener('click', () =>
      choose({ ...formSettings(), winningScore })
    );
  for (const practice of [true, false])
    $('practice-mode-' + (practice ? 'on' : 'off') + '-btn').addEventListener(
      'click',
      () => choose({ ...formSettings(), practice })
    );
  let resetLocalPending = false;
  const resetLocal = () => {
    $('graphic-sharp-btn').click();
    $('bgm-on-btn').click();
    $('stereo-btn').click();
    $('controls').value = 'standard';
    session.controls('standard');
    $('mute').checked = false;
    volume();
  };
  $('reset-to-default-btn').addEventListener('click', () => {
    resetLocalPending = !!session.epoch;
    if (!session.epoch) resetLocal();
    choose(matchSettings({}));
  });
  $('settings-confirm-yes').addEventListener('click', () => {
    if (resetLocalPending) resetLocal();
    resetLocalPending = false;
  });
  $('settings-confirm-no').addEventListener('click', () => {
    resetLocalPending = false;
  });
  $('names-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const names =
      room.data.layout === 'pairs'
        ? [$('local-name-1').value, $('local-name-2').value]
        : [$('local-name-1').value];
    try {
      await room.store.rename(room.id, room.selfId, names);
    } catch (error) {
      $('status').textContent = error.message;
    }
  });
  async function selectSlots(slots) {
    if (room.closed || room.data.status !== 'lobby') return;
    try {
      await room.store.selectSlots(room.id, room.selfId, slots);
    } catch (error) {
      $('status').textContent = error.message;
    }
  }
  $('cancel-slot').addEventListener('click', () => selectSlots([]));
  function selected(ids, choice) {
    for (const id of ids) $(id).classList.toggle('selected', id === choice);
  }
  for (const graphic of ['sharp', 'soft'])
    $('graphic-' + graphic + '-btn').addEventListener('click', () => {
      renderer.view.classList.toggle('graphic-soft', graphic === 'soft');
      selected(
        ['graphic-sharp-btn', 'graphic-soft-btn'],
        'graphic-' + graphic + '-btn'
      );
      closeMenus();
    });
  function volume() {
    game.audio.turnBGMVolume(bgm && !$('mute').checked);
    game.audio.turnSFXVolume(sfx !== 'off' && !$('mute').checked);
  }
  for (const on of [true, false])
    $('bgm-' + (on ? 'on' : 'off') + '-btn').addEventListener('click', () => {
      bgm = on;
      volume();
      selected(
        ['bgm-on-btn', 'bgm-off-btn'],
        'bgm-' + (on ? 'on' : 'off') + '-btn'
      );
      closeMenus();
    });
  const originalPlays = Object.entries(game.audio.sounds)
    .filter(([name]) => name !== 'bgm')
    .map(([, sound]) => ({ sound, play: sound.play.bind(sound) }));
  originalPlays.forEach(({ sound, play }) => {
    sound.play = (side = 0) => play(sfx === 'mono' ? 0 : side);
  });
  for (const value of ['stereo', 'mono', 'off'])
    $(value === 'off' ? 'sfx-off-btn' : value + '-btn').addEventListener(
      'click',
      () => {
        sfx = value;
        volume();
        selected(
          ['stereo-btn', 'mono-btn', 'sfx-off-btn'],
          value === 'off' ? 'sfx-off-btn' : value + '-btn'
        );
        closeMenus();
      }
    );
  $('mute').addEventListener('change', volume);
  let bubbleSequence = 0;
  function display(packet) {
    const prefix =
      (packet.slots.length
        ? packet.slots.map((slot) => 'P' + (slot + 1)).join('+')
        : t('Lobby', '대기실')) +
      ' · ' +
      packet.name;
    const line = document.createElement('li');
    line.textContent = prefix + ': ' + packet.text;
    $('chat-log').appendChild(line);
    while ($('chat-log').children.length > 100)
      $('chat-log').firstChild.remove();
    $('chat-log').scrollTop = $('chat-log').scrollHeight;
    const bubble = document.createElement('div');
    bubble.className = 'chat-box pre-wrap';
    const speech =
      !session.epoch ||
      !!document.querySelector('.fade-in-box:not(.hidden)') ||
      game.state === game.intro ||
      game.state === game.menu;
    bubble.classList.toggle('in-speech-bubble', speech);
    bubble.textContent = packet.text;
    bubble.title = prefix;
    bubble.style.top = packet.position.top + '%';
    if (packet.position.side === 'left')
      bubble.style.right = packet.position.offset + '%';
    else if (packet.position.side === 'right')
      bubble.style.left = packet.position.offset + '%';
    else {
      bubble.style.left = '50%';
      bubble.style.transform = 'translateX(-50%)';
    }
    bubble.dataset.sender = packet.sender + ':' + (packet.speaker || 0);
    bubble.dataset.chat = String(++bubbleSequence);
    for (const previous of Array.from($('chat-bubbles').children))
      if (previous.dataset.sender === bubble.dataset.sender) previous.remove();
    $('chat-bubbles').appendChild(bubble);
    setTimeout(() => bubble.remove(), 5100);
  }
  const chat = new RoomChat(room, display);
  const closeChat = () => {
    $('chat-input-and-send-btn-container').classList.add('hidden');
    $('chat-open-btn-and-chat-disabling-btn-container').classList.remove(
      'hidden'
    );
    $('chat-input').blur();
    session.releaseLocalKeys();
  };
  const openChat = () => {
    if (room.closed || !chat.enabled) return;
    closeMenus();
    session.releaseLocalKeys();
    $('chat-input-and-send-btn-container').classList.remove('hidden');
    $('chat-open-btn-and-chat-disabling-btn-container').classList.add('hidden');
    $('chat-input').focus();
  };
  $('chat-open-btn').addEventListener('click', openChat);
  $('send-btn').addEventListener('click', () => {
    if (
      chat.send($('chat-input').value, Number($('chat-speaker').value || 0))
    ) {
      $('chat-input').value = '';
      closeChat();
    }
  });
  $('chat-input').addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.code === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      $('send-btn').click();
    }
    if (event.code === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeChat();
    }
  });
  $('chat-disabling-btn').addEventListener('click', () => {
    chat.enabled = !chat.enabled;
    closeChat();
    $('chat-open-btn').disabled = !chat.enabled;
    $('chat-disabling-btn').textContent = chat.enabled
      ? t('Disable chat', '채팅 끄기')
      : t('Enable chat', '채팅 켜기');
    if (!chat.enabled) $('chat-bubbles').replaceChildren();
  });
  document.addEventListener('keydown', (event) => {
    const typing = event.target.closest('input,select,textarea,button');
    const dialog = document.querySelector('.fade-in-box:not(.hidden)');
    if (event.code === 'Tab' && dialog) {
      const focusable = Array.from(
        dialog.querySelectorAll(
          'button,input:not([hidden]),select:not([hidden])'
        )
      ).filter((el) => !el.disabled);
      const first = focusable[0],
        last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    if (event.code === 'Escape') {
      pending = null;
      resetLocalPending = false;
      closeMenus();
      if (
        !dialog &&
        !event.target.closest('input,select,textarea') &&
        !room.closed
      )
        $('menu-bar').classList.toggle('hidden');
      if (dialog) {
        if (dialog.id === 'match-settings-dialog' && courtBefore)
          setForm(courtBefore);
        closeDialog(dialog.id);
      }
    }
    if (event.code === 'Space' && !typing && !dialog && !room.closed) {
      event.preventDefault();
      openChat();
    }
    if (
      event.code === 'Enter' &&
      !typing &&
      !dialog &&
      room.closed &&
      !$('quick-match').disabled
    ) {
      event.preventDefault();
      $('quick-match').click();
    }
  });
  return {
    chat,
    closeMenus,
    update() {
      const connected = !room.closed;
      $('before-connection').hidden = connected;
      $('flex-container').hidden = !connected;
      $('match-dropdown-btn').disabled = !connected || !room.isHost;
      $('fill-ai-label').hidden = !room.isHost;
      $('synchronization').disabled = !room.isHost;
      for (const id of [
        'practice-mode-submenu-btn',
        'reset-to-default-btn',
        'speed-submenu-btn',
        'winning-score-submenu-btn',
        'court-submenu-btn',
      ])
        $(id).disabled = !room.isHost;
      for (const id of [
        'slow-speed-btn',
        'medium-speed-btn',
        'fast-speed-btn',
        'practice-mode-on-btn',
        'practice-mode-off-btn',
        ...['5', '10', '15'].map((n) => 'winning-score-' + n + '-btn'),
      ])
        $(id).disabled = !room.isHost;
      $('lobby-banner').hidden = !!session.epoch;
      if (lastEpoch !== session.epoch) {
        $('room-panel').open = !session.epoch;
        lastEpoch = session.epoch;
        closeMenus();
      }
      if (lastRoom !== (connected ? room.id : null)) {
        lastRoom = connected ? room.id : null;
        chat.reset();
        $('chat-log').replaceChildren();
        $('chat-bubbles').replaceChildren();
        closeChat();
        document
          .querySelectorAll('[role="dialog"]')
          .forEach((el) => el.classList.add('hidden'));
      }
      const current = formSettings();
      selected(
        ['practice-mode-on-btn', 'practice-mode-off-btn'],
        'practice-mode-' + (current.practice ? 'on' : 'off') + '-btn'
      );
      const me = connected ? room.data.members[room.selfId] : null;
      $('lobby-editor').hidden = !connected || room.data.status !== 'lobby';
      $('slot-choices').replaceChildren();
      $('lobby-participants').replaceChildren();
      if (me) {
        const names = me.names || [me.name];
        const key = room.id + ':' + JSON.stringify(names);
        if (key !== editedNamesKey) {
          editedNamesKey = key;
          $('nickname').value = names[0];
          $('pair-name').value = names[1] || 'Player 2';
          $('local-name-1').value = names[0];
          $('local-name-2').value = names[1] || '';
          $('local-name-2-label').hidden = room.data.layout !== 'pairs';
          $('local-name-2').required = room.data.layout === 'pairs';
          const selectedSpeaker = $('chat-speaker').value;
          $('chat-speaker').replaceChildren();
          names.forEach((name, index) => {
            const option = document.createElement('option');
            option.value = index;
            option.textContent = name;
            $('chat-speaker').appendChild(option);
          });
          $('chat-speaker').value =
            selectedSpeaker && Number(selectedSpeaker) < names.length
              ? selectedSpeaker
              : '0';
          $('chat-speaker-label').hidden = names.length !== 2;
        }
        const choices =
          room.data.layout === 'pairs'
            ? [
                [0, 1],
                [2, 3],
              ]
            : [[0], [1], [2], [3]];
        for (const slots of choices) {
          const button = document.createElement('button');
          button.type = 'button';
          button.dataset.slots = slots.join(',');
          const own = JSON.stringify(me.slots) === JSON.stringify(slots);
          button.textContent =
            slots.map((slot) => 'P' + (slot + 1)).join(' + ') +
            (own ? t(' (selected)', ' (선택됨)') : '');
          button.disabled =
            room.data.status !== 'lobby' ||
            own ||
            slots.some(
              (slot) =>
                room.data.seats[slot] && room.data.seats[slot] !== room.selfId
            );
          button.addEventListener('click', () => selectSlots(slots));
          $('slot-choices').appendChild(button);
        }
        $('cancel-slot').disabled =
          me.slots.length === 0 || room.data.status !== 'lobby';
        for (const [id, member] of Object.entries(room.data.members)) {
          const line = document.createElement('p');
          line.textContent =
            (member.names || [member.name]).join(' / ') +
            ' — ' +
            (member.slots.length
              ? member.slots.map((slot) => 'P' + (slot + 1)).join(' + ')
              : t('Not assigned', '자리 미선택'));
          if (room.isHost && id !== room.selfId) {
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = t('Remove', '내보내기');
            remove.addEventListener('click', () => session.peerClosed(id));
            line.append(' ', remove);
          }
          $('lobby-participants').appendChild(line);
        }
      }
      selected(
        ['slow-speed-btn', 'medium-speed-btn', 'fast-speed-btn'],
        { 20: 'slow', 25: 'medium', 30: 'fast' }[current.fps] + '-speed-btn'
      );
      selected(
        [5, 10, 15].map((n) => 'winning-score-' + n + '-btn'),
        'winning-score-' + current.winningScore + '-btn'
      );
      $('player-names').replaceChildren();
      if (connected)
        for (let slot = 0; slot < 4; slot++) {
          const owner = room.data.seats[slot],
            member = owner && room.data.members[owner];
          const span = document.createElement('span');
          span.className = 'nickname';
          span.textContent =
            'P' +
            (slot + 1) +
            ' · ' +
            (member ? playerName(member, slot) : t('Computer', '컴퓨터'));
          $('player-names').appendChild(span);
        }
    },
  };
}
