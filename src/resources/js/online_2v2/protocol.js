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

export function occupiedSlots(members) {
  return Object.values(members || {}).reduce(
    (all, member) => all.concat(member.slots || []),
    []
  );
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
    (data.layout !== 'pairs' || Object.keys(data.members).length === 2) &&
    Object.values(data.members).every((member) =>
      validSlots(data.layout, member.slots)
    )
  );
}
