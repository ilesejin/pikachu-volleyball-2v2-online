// Visual recordings never execute replay-file code or rerun physics.
export const ROOM_VERSION = 'pikavolley-2v2-room-replay-v1';
export const VERSION = 'pikavolley-offline-2v2-replay-v1';
export const MAX_BYTES = 128 * 1024 * 1024;
export const STRIDE = 9;
export const HEADER = 5;
export const SOUND_NAMES = [
  'pipikachu',
  'pika',
  'chu',
  'pi',
  'pikachu',
  'powerHit',
  'ballTouchesGround',
];
export function checksum(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++)
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}
// Same signed 32-bit checksum as the online room replay container.
export function roomChecksum(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i++)
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return hash;
}
export function toRoomReplay(pack) {
  return {
    version: ROOM_VERSION,
    source: 'offline',
    rendering: 'sprites-v1',
    createdAt: pack.createdAt,
    ...(pack.language ? { language: pack.language } : {}),
    complete: true,
    authoritative: true,
    events: pack.segments.flatMap((segment) =>
      segment.frames.map((frame, index) => ({
        type: 'visual',
        dt: frame.dt / 1000,
        ...(index === 0 ? { settings: segment.settings } : {}),
        ...(frame.key ? { key: frame.key } : { delta: frame.delta }),
        sounds: frame.sounds,
      }))
    ),
  };
}
function fromRoomReplay(pack) {
  if (
    pack.source !== 'offline' ||
    pack.rendering !== 'sprites-v1' ||
    !Array.isArray(pack.events) ||
    !pack.events.length ||
    pack.events.length > 1000000 ||
    pack.complete !== true ||
    pack.authoritative !== true
  )
    throw Error('Invalid visual replay timeline.');
  const result = {
    version: VERSION,
    createdAt: pack.createdAt,
    ...(pack.language ? { language: pack.language } : {}),
    segments: [],
  };
  let segment;
  for (const event of pack.events) {
    if (
      !event ||
      event.type !== 'visual' ||
      !Number.isFinite(event.dt) ||
      event.dt <= 0 ||
      event.dt > 3600
    )
      throw Error('Invalid visual replay event.');
    if (event.settings) {
      segment = { settings: event.settings, frames: [] };
      result.segments.push(segment);
    }
    if (!segment) throw Error('Missing visual replay settings.');
    segment.frames.push({
      dt: event.dt * 1000,
      ...(event.key ? { key: event.key } : { delta: event.delta }),
      sounds: event.sounds,
    });
  }
  return result;
}
export function encode(pack) {
  const room = toRoomReplay(pack);
  const text = JSON.stringify({
    _comment: 'Pikachu Volleyball 2v2 replay. Open in either replay viewer.',
    pack: room,
    checksum: roomChecksum(JSON.stringify(room)),
  });
  if (new TextEncoder().encode(text).length > MAX_BYTES)
    throw Error('Replay is too large.');
  return text;
}
export function vectorLength(width) {
  return HEADER + STRIDE * (32 + Math.ceil(width / 16));
}
export function differences(previous, current) {
  const result = [];
  current.forEach((value, i) => {
    if (value !== previous[i]) result.push(i, value);
  });
  return result;
}
export function patch(vector, delta) {
  for (let i = 0; i < delta.length; i += 2) vector[delta[i]] = delta[i + 1];
  return vector;
}
export function packedInputs(inputs) {
  return inputs.reduce(
    (bits, value, i) =>
      bits |
      (((value.xDirection & 3) |
        ((value.yDirection & 3) << 2) |
        (value.powerHit ? 16 : 0)) <<
        (i * 5)),
    0
  );
}
export function unpackedInputs(bits) {
  return Array.from({ length: 4 }, (_, i) => {
    const value = (bits >>> (i * 5)) & 31;
    return {
      x: (value & 3) === 3 ? -1 : value & 3,
      y: ((value >>> 2) & 3) === 3 ? -1 : (value >>> 2) & 3,
      hit: !!(value & 16),
    };
  });
}
const finite = (value) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  Math.abs(value) <= 1000000000;
export function decode(text) {
  if (
    typeof text !== 'string' ||
    text.length > MAX_BYTES ||
    new TextEncoder().encode(text).length > MAX_BYTES
  )
    throw Error('Replay is too large.');
  const data = JSON.parse(text, (key, value) => {
    if (['__proto__', 'constructor', 'prototype'].includes(key))
      throw Error('Invalid replay field.');
    if (typeof value === 'number' && !Number.isFinite(value))
      throw Error('Invalid replay number.');
    return value;
  });
  let pack = data?.pack;
  if (pack?.version === ROOM_VERSION) {
    if (data.checksum !== roomChecksum(JSON.stringify(pack)))
      throw Error('Invalid or damaged replay file.');
    pack = fromRoomReplay(pack);
  } else if (!pack || data.checksum !== checksum(JSON.stringify(pack)))
    throw Error('Invalid or damaged offline replay.');
  if (
    !pack ||
    pack.version !== VERSION ||
    typeof pack.createdAt !== 'string' ||
    pack.createdAt.length > 40 ||
    !Array.isArray(pack.segments) ||
    !pack.segments.length ||
    pack.segments.length > 10000
  )
    throw Error('Invalid or damaged offline replay.');
  let count = 0;
  for (const segment of pack.segments) {
    const s = segment.settings;
    if (
      !s ||
      !Number.isInteger(s.width) ||
      s.width < 432 ||
      s.width > 20000 ||
      s.width % 2 ||
      ![20, 25, 30].includes(s.fps) ||
      !['rotate-players', 'rotate-ball', 'fixed'].includes(s.serveMode) ||
      typeof s.practice !== 'boolean' ||
      !Array.isArray(segment.frames) ||
      !segment.frames.length
    )
      throw Error('Invalid replay segment.');
    const length = vectorLength(s.width);
    if (!segment.frames[0]?.key)
      throw Error('Replay segment has no initial frame.');
    let distance = 0;
    for (const frame of segment.frames) {
      if (
        ++count > 1000000 ||
        !frame ||
        !finite(frame.dt) ||
        frame.dt <= 0 ||
        frame.dt > 3600000
      )
        throw Error('Invalid replay timing.');
      if (frame.key) {
        if (
          !Array.isArray(frame.key) ||
          frame.key.length !== length ||
          !frame.key.every(finite) ||
          frame.delta !== undefined
        )
          throw Error('Invalid replay keyframe.');
        distance = 0;
      } else {
        if (
          ++distance > 149 ||
          !Array.isArray(frame.delta) ||
          frame.delta.length % 2 ||
          frame.delta.length > length * 2
        )
          throw Error('Invalid replay frame.');
        const indices = new Set();
        for (let i = 0; i < frame.delta.length; i += 2) {
          const index = frame.delta[i];
          if (
            !Number.isInteger(index) ||
            index < 0 ||
            index >= length ||
            indices.has(index) ||
            !finite(frame.delta[i + 1])
          )
            throw Error('Invalid replay difference.');
          indices.add(index);
        }
      }
      if (
        !Array.isArray(frame.sounds) ||
        frame.sounds.length > 32 ||
        frame.sounds.some(
          (sound) =>
            !Array.isArray(sound) ||
            sound.length !== 2 ||
            !SOUND_NAMES.includes(sound[0]) ||
            ![-1, 0, 1].includes(sound[1])
        )
      )
        throw Error('Invalid replay sound.');
    }
  }
  return pack;
}
export function timeline(pack) {
  let duration = 0;
  const frames = [];
  pack.segments.forEach((segment, segmentIndex) => {
    let keyIndex = 0;
    segment.frames.forEach((frame, frameIndex) => {
      if (frame.key) keyIndex = frameIndex;
      frames.push({
        segment: segmentIndex,
        frame: frameIndex,
        key: keyIndex,
        at: duration,
      });
      duration += frame.dt;
    });
  });
  return { frames, duration };
}
export function frameAt(frames, time) {
  let low = 0,
    high = frames.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (frames[middle].at <= time) low = middle;
    else high = middle - 1;
  }
  return low;
}
