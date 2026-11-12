import manifest from '../../../../offline-engine.manifest.json';
import { getHashCode } from '../utils/hash_code.js';
export const REPLAY_VERSION = 'pikavolley-2v2-room-replay-v1';
export const ENGINE_ID = JSON.stringify(manifest.files);
export const MAX_REPLAY_BYTES = 128 * 1024 * 1024;
export const copy = (value) => JSON.parse(JSON.stringify(value));
export function packInputs(inputs) {
  return inputs.reduce(
    (bits, input, i) =>
      bits |
      (((input.xDirection & 3) |
        ((input.yDirection & 3) << 2) |
        ((input.powerHit ? 1 : 0) << 4)) <<
        (5 * i)),
    0
  );
}
export function unpackInputs(bits) {
  return Array.from({ length: 4 }, (_, i) => {
    const value = (bits >>> (i * 5)) & 31;
    return {
      xDirection: (value & 3) === 3 ? -1 : value & 3,
      yDirection: ((value >>> 2) & 3) === 3 ? -1 : (value >>> 2) & 3,
      powerHit: value >>> 4,
    };
  });
}
export function encodeReplay(pack) {
  const text = JSON.stringify({
    _comment: 'Pikachu Volleyball 2v2 room replay. Open in the replay viewer.',
    pack,
    checksum: getHashCode(JSON.stringify(pack)),
  });
  if (new TextEncoder().encode(text).byteLength > MAX_REPLAY_BYTES)
    throw new Error('Replay file is too large.');
  return text;
}
export function decodeReplay(text) {
  if (typeof text !== 'string' || text.length > MAX_REPLAY_BYTES)
    throw new Error('Replay file is too large.');
  const data = JSON.parse(text, (key, value) => {
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new Error('Invalid replay number.');
    if (['__proto__', 'constructor', 'prototype'].includes(key))
      throw new Error('Invalid replay field.');
    return value;
  });
  const pack = data.pack;
  if (
    !pack ||
    pack.version !== REPLAY_VERSION ||
    data.checksum !== getHashCode(JSON.stringify(pack))
  )
    throw new Error('Invalid or damaged replay file.');
  if (pack.engine !== ENGINE_ID)
    throw new Error('This replay needs a different game engine version.');
  if (
    !Array.isArray(pack.events) ||
    pack.events.length > 1000000 ||
    !pack.events.length ||
    typeof pack.roomId !== 'string' ||
    pack.roomId.length > 128 ||
    typeof pack.createdAt !== 'string' ||
    pack.createdAt.length > 40 ||
    typeof pack.complete !== 'boolean' ||
    typeof pack.authoritative !== 'boolean'
  )
    throw new Error('Invalid replay timeline.');
  let started = false;
  for (const event of pack.events) {
    if (
      !event ||
      !['checkpoint', 'step', 'snapshot', 'lobby', 'chat', 'end'].includes(
        event.type
      ) ||
      !Number.isFinite(event.dt) ||
      event.dt < 0 ||
      event.dt > 1
    )
      throw new Error('Invalid replay event.');
    if (event.type === 'checkpoint' || event.type === 'snapshot')
      started = true;
    if (event.type === 'step') {
      if (
        !started ||
        !Number.isInteger(event.inputs) ||
        event.inputs < 0 ||
        event.inputs >= 1048576 ||
        unpackInputs(event.inputs).some(
          (input) =>
            ![-1, 0, 1].includes(input.xDirection) ||
            ![-1, 0, 1].includes(input.yDirection)
        ) ||
        !Array.isArray(event.random) ||
        event.random.length > 100000 ||
        !event.random.every(
          (value) => Number.isInteger(value) && value >= 0 && value < 32768
        )
      )
        throw new Error('Invalid replay input frame.');
    }
  }
  return pack;
}

// RTCDataChannel encodes each string independently; keep surrogate pairs intact.
export function* replayChunks(text, size = 16000) {
  for (let offset = 0; offset < text.length; ) {
    let end = Math.min(offset + size, text.length);
    const last = text.charCodeAt(end - 1),
      next = text.charCodeAt(end);
    if (
      end < text.length &&
      last >= 0xd800 &&
      last <= 0xdbff &&
      next >= 0xdc00 &&
      next <= 0xdfff
    )
      end--;
    yield text.slice(offset, end);
    offset = end;
  }
}
