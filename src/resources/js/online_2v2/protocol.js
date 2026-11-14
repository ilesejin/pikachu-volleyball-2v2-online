import { DOUBLES_CONFIG } from '../offline_2v2/doubles_config.js';

export const ROOM_SCHEMA = 'pikavolley-2v2-v5';
export const SERVE_MODES = ['rotate-players', 'rotate-ball', 'fixed'];
export const PLAYER_KEYS = [
  ['KeyA', 'KeyD', 'KeyW', 'KeyX', 'KeyZ', 'KeyS'],
  ['KeyG', 'KeyJ', 'KeyY', 'KeyB', 'KeyV', 'KeyH'],
  ['KeyL', 'Quote', 'KeyP', 'Semicolon', 'Comma'],
  ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter'],
];

export function matchSettings(value = {}) {
  const courtWidth = Number(
    value.courtWidth === undefined
      ? DOUBLES_CONFIG.courtWidth
      : value.courtWidth
  );
  const serveMode = value.serveMode || DOUBLES_CONFIG.serveMode;
  const fps = Number(value.fps || 30);
  const winningScore = Number(value.winningScore || 15);
  const synchronization =
    value.synchronization === undefined ? 'lockstep' : value.synchronization;
  const topology = value.topology === undefined ? 'mesh' : value.topology;
  const practice = value.practice === undefined ? false : value.practice;
  if (
    !Number.isSafeInteger(courtWidth) ||
    courtWidth < 216 ||
    courtWidth > 10000 ||
    !SERVE_MODES.includes(serveMode) ||
    ![20, 25, 30].includes(fps) ||
    ![5, 10, 15].includes(winningScore) ||
    typeof practice !== 'boolean' ||
    !['lockstep', 'host'].includes(synchronization) ||
    !['mesh', 'star'].includes(topology)
  ) {
    throw new Error('Invalid match settings.');
  }
  return {
    courtWidth,
    serveMode,
    fps,
    winningScore,
    practice,
    synchronization,
    topology,
  };
}

// These options affect pacing/scoring policy, without rebuilding the match.
export function canUpdateLive(current, next) {
  return (
    !!current &&
    [
      'courtWidth',
      'serveMode',
      'winningScore',
      'synchronization',
      'topology',
    ].every((key) => current[key] === next[key])
  );
}

export function usesMesh(data) {
  return data.layout === 'four' && data.settings.topology === 'mesh';
}
export function requiredPeers(data, selfId) {
  if (usesMesh(data) || selfId === data.hostId)
    return Object.keys(data.members).filter((id) => id !== selfId);
  return [data.hostId];
}
export function connectionKey(data, a, b) {
  return [data.networkRevision, ...[a, b].sort()].join('~');
}

export function validSlots(layout, slots, unassigned = false) {
  if (!Array.isArray(slots)) return false;
  if (unassigned && slots.length === 0)
    return ['four', 'pairs'].includes(layout);
  if (layout === 'four')
    return (
      slots.length === 1 &&
      Number.isInteger(slots[0]) &&
      slots[0] >= 0 &&
      slots[0] < 4
    );
  if (layout === 'pairs')
    return (
      slots.length === 2 &&
      ((slots[0] === 0 && slots[1] === 1) || (slots[0] === 2 && slots[1] === 3))
    );
  return false;
}

// Lobby randomness is independent of the seeded physics RNG.
function randomIndex(limit) {
  const ceiling = Math.floor(0x100000000 / limit) * limit;
  const value = new Uint32Array(1);
  do {
    crypto.getRandomValues(value);
  } while (value[0] >= ceiling);
  return value[0] % limit;
}
export function randomizedPositions(data, chooseIndex = randomIndex) {
  const choices =
    data.layout === 'pairs'
      ? [
          [0, 1],
          [2, 3],
        ]
      : [[0], [1], [2], [3]];
  const ids = Object.keys(data.members);
  if (!['four', 'pairs'].includes(data.layout) || ids.length > choices.length)
    throw new Error('Invalid lobby arrangement.');
  for (let i = choices.length - 1; i > 0; i--) {
    const j = chooseIndex(i + 1);
    [choices[i], choices[j]] = [choices[j], choices[i]];
  }
  const members = {};
  const seats = ['', '', '', ''];
  ids.forEach((id, index) => {
    const slots = choices[index];
    members[id] = { ...data.members[id], slots };
    slots.forEach((slot) => {
      seats[slot] = id;
    });
  });
  return { members, seats };
}

export function normalizeInput(input) {
  return {
    xDirection:
      input && [-1, 0, 1].includes(input.xDirection) ? input.xDirection : 0,
    yDirection:
      input && [-1, 0, 1].includes(input.yDirection) ? input.yDirection : 0,
    powerHit: input && input.powerHit === 1 ? 1 : 0,
  };
}

export function ownedInputs(message, slots, epoch, previousSequence) {
  if (
    !message ||
    message.type !== 'input' ||
    message.epoch !== epoch ||
    !Number.isSafeInteger(message.seq) ||
    message.seq <= previousSequence ||
    !Array.isArray(message.inputs) ||
    message.inputs.length !== slots.length
  )
    return null;
  const seen = new Set();
  for (const entry of message.inputs) {
    if (!entry || !slots.includes(entry.slot) || seen.has(entry.slot))
      return null;
    seen.add(entry.slot);
  }
  return message.inputs.map((entry) => ({
    slot: entry.slot,
    input: normalizeInput(entry),
  }));
}

export class RemoteInput {
  constructor() {
    this.reset();
  }
  reset() {
    this.latest = normalizeInput(null);
    this.xDirection = this.yDirection = this.powerHit = 0;
    this.pendingHit = false;
    this.lastReceived = 0;
  }
  push(input, now = Date.now()) {
    this.latest = normalizeInput(input);
    this.pendingHit = this.pendingHit || this.latest.powerHit === 1;
    this.lastReceived = now;
  }
  getInput() {
    const fresh = Date.now() - this.lastReceived < 600;
    this.xDirection = fresh ? this.latest.xDirection : 0;
    this.yDirection = fresh ? this.latest.yDirection : 0;
    this.powerHit = fresh && this.pendingHit ? 1 : 0;
    this.pendingHit = false;
  }
  unsubscribe() {
    this.reset();
  }
}

export function playerNames(value, layout) {
  const count = layout === 'pairs' ? 2 : 1;
  const raw = Array.isArray(value)
    ? value
    : [value, ...(count === 2 ? ['Player 2'] : [])];
  if (raw.length !== count)
    throw new Error('Enter a name for each local player.');
  return raw.map(
    (name, i) =>
      String(name || 'Player ' + (i + 1))
        .trim()
        .slice(0, 24) || 'Player ' + (i + 1)
  );
}
export function playerName(member, slot) {
  const index = member.slots.indexOf(slot);
  return (member.names && member.names[index]) || member.name;
}
export function lobbyReady(data) {
  return (
    !!data &&
    Object.keys(data.members).length >= 2 &&
    (data.layout !== 'pairs' || Object.keys(data.members).length === 2) &&
    Object.values(data.members).every((member) =>
      validSlots(data.layout, member.slots)
    )
  );
}

// Cosmetic IDs are metadata; they never enter the physics input or RNG stream.
export const SKIN_IDS = [
  'classic',
  'cap',
  'headband',
  'scarf',
  'cap-scarf',
  'headband-scarf',
  'cyborg',
  'cyborg-cap',
  'cyborg-headband',
  'cyborg-scarf',
  'cyborg-cap-scarf',
  'cyborg-headband-scarf',
  'sunglasses',
  'cap-sunglasses',
  'headband-sunglasses',
  'scarf-sunglasses',
  'cap-scarf-sunglasses',
  'headband-scarf-sunglasses',
  'cyborg-sunglasses',
  'cyborg-cap-sunglasses',
  'cyborg-headband-sunglasses',
  'cyborg-scarf-sunglasses',
  'cyborg-cap-scarf-sunglasses',
  'cyborg-headband-scarf-sunglasses',
  'round-glasses',
  'cap-round-glasses',
  'headband-round-glasses',
  'scarf-round-glasses',
  'cap-scarf-round-glasses',
  'headband-scarf-round-glasses',
  'cyborg-round-glasses',
  'cyborg-cap-round-glasses',
  'cyborg-headband-round-glasses',
  'cyborg-scarf-round-glasses',
  'cyborg-cap-scarf-round-glasses',
  'cyborg-headband-scarf-round-glasses',
  'triangle-sunglasses',
  'cap-triangle-sunglasses',
  'headband-triangle-sunglasses',
  'scarf-triangle-sunglasses',
  'cap-scarf-triangle-sunglasses',
  'headband-scarf-triangle-sunglasses',
  'cyborg-triangle-sunglasses',
  'cyborg-cap-triangle-sunglasses',
  'cyborg-headband-triangle-sunglasses',
  'cyborg-scarf-triangle-sunglasses',
  'cyborg-cap-scarf-triangle-sunglasses',
  'cyborg-headband-scarf-triangle-sunglasses',
  'star-sunglasses',
  'scarf-star-sunglasses',
  'bowtie',
  'bowtie-sunglasses',
  'bowtie-round-glasses',
  'bowtie-triangle-sunglasses',
  'bowtie-star-sunglasses',
  'cap-star-sunglasses',
  'cap-scarf-star-sunglasses',
  'cap-bowtie',
  'cap-bowtie-sunglasses',
  'cap-bowtie-round-glasses',
  'cap-bowtie-triangle-sunglasses',
  'cap-bowtie-star-sunglasses',
  'headband-star-sunglasses',
  'headband-scarf-star-sunglasses',
  'headband-bowtie',
  'headband-bowtie-sunglasses',
  'headband-bowtie-round-glasses',
  'headband-bowtie-triangle-sunglasses',
  'headband-bowtie-star-sunglasses',
  'crown',
  'crown-sunglasses',
  'crown-round-glasses',
  'crown-triangle-sunglasses',
  'crown-star-sunglasses',
  'crown-scarf',
  'crown-scarf-sunglasses',
  'crown-scarf-round-glasses',
  'crown-scarf-triangle-sunglasses',
  'crown-scarf-star-sunglasses',
  'crown-bowtie',
  'crown-bowtie-sunglasses',
  'crown-bowtie-round-glasses',
  'crown-bowtie-triangle-sunglasses',
  'crown-bowtie-star-sunglasses',
  'headphones',
  'headphones-sunglasses',
  'headphones-round-glasses',
  'headphones-triangle-sunglasses',
  'headphones-star-sunglasses',
  'headphones-scarf',
  'headphones-scarf-sunglasses',
  'headphones-scarf-round-glasses',
  'headphones-scarf-triangle-sunglasses',
  'headphones-scarf-star-sunglasses',
  'headphones-bowtie',
  'headphones-bowtie-sunglasses',
  'headphones-bowtie-round-glasses',
  'headphones-bowtie-triangle-sunglasses',
  'headphones-bowtie-star-sunglasses',
  'cyborg-star-sunglasses',
  'cyborg-scarf-star-sunglasses',
  'cyborg-bowtie',
  'cyborg-bowtie-sunglasses',
  'cyborg-bowtie-round-glasses',
  'cyborg-bowtie-triangle-sunglasses',
  'cyborg-bowtie-star-sunglasses',
  'cyborg-cap-star-sunglasses',
  'cyborg-cap-scarf-star-sunglasses',
  'cyborg-cap-bowtie',
  'cyborg-cap-bowtie-sunglasses',
  'cyborg-cap-bowtie-round-glasses',
  'cyborg-cap-bowtie-triangle-sunglasses',
  'cyborg-cap-bowtie-star-sunglasses',
  'cyborg-headband-star-sunglasses',
  'cyborg-headband-scarf-star-sunglasses',
  'cyborg-headband-bowtie',
  'cyborg-headband-bowtie-sunglasses',
  'cyborg-headband-bowtie-round-glasses',
  'cyborg-headband-bowtie-triangle-sunglasses',
  'cyborg-headband-bowtie-star-sunglasses',
  'cyborg-crown',
  'cyborg-crown-sunglasses',
  'cyborg-crown-round-glasses',
  'cyborg-crown-triangle-sunglasses',
  'cyborg-crown-star-sunglasses',
  'cyborg-crown-scarf',
  'cyborg-crown-scarf-sunglasses',
  'cyborg-crown-scarf-round-glasses',
  'cyborg-crown-scarf-triangle-sunglasses',
  'cyborg-crown-scarf-star-sunglasses',
  'cyborg-crown-bowtie',
  'cyborg-crown-bowtie-sunglasses',
  'cyborg-crown-bowtie-round-glasses',
  'cyborg-crown-bowtie-triangle-sunglasses',
  'cyborg-crown-bowtie-star-sunglasses',
  'cyborg-headphones',
  'cyborg-headphones-sunglasses',
  'cyborg-headphones-round-glasses',
  'cyborg-headphones-triangle-sunglasses',
  'cyborg-headphones-star-sunglasses',
  'cyborg-headphones-scarf',
  'cyborg-headphones-scarf-sunglasses',
  'cyborg-headphones-scarf-round-glasses',
  'cyborg-headphones-scarf-triangle-sunglasses',
  'cyborg-headphones-scarf-star-sunglasses',
  'cyborg-headphones-bowtie',
  'cyborg-headphones-bowtie-sunglasses',
  'cyborg-headphones-bowtie-round-glasses',
  'cyborg-headphones-bowtie-triangle-sunglasses',
  'cyborg-headphones-bowtie-star-sunglasses',
];
export function playerSkins(value, layout) {
  const count = layout === 'pairs' ? 2 : 1;
  if (value === undefined) return Array(count).fill('classic');
  if (
    !Array.isArray(value) ||
    value.length !== count ||
    value.some((id) => !SKIN_IDS.includes(id))
  )
    throw new Error('Invalid costume selection.');
  return value.slice();
}
export function slotSkins(members) {
  const skins = Array(4).fill('classic');
  for (const member of Object.values(members || {}))
    (member.slots || []).forEach((slot, index) => {
      const id = member.skins?.[index];
      if (SKIN_IDS.includes(id)) skins[slot] = id;
    });
  return skins;
}
