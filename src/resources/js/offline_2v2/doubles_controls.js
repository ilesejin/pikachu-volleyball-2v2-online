'use strict';
import { PikaKeyboard } from './keyboard.js';

export const DOUBLES_SLOT_KEYS = [
  ['KeyA', 'KeyD', 'KeyW', 'KeyX', 'KeyZ', 'KeyS'],
  ['KeyG', 'KeyJ', 'KeyY', 'KeyB', 'KeyV', 'KeyH'],
  ['KeyL', 'Quote', 'KeyP', 'Semicolon', 'Comma'],
  ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter'],
];
export const ARROW_KEYS = DOUBLES_SLOT_KEYS[3];

// Combine physical keys before direction priority and the shared hit edge are read.
export function combineKeyboards(primary, alias) {
  for (const field of [
    'leftKey',
    'rightKey',
    'upKey',
    'downKey',
    'powerHitKey',
    'downRightKey',
  ]) {
    const keys = [primary[field], alias[field]];
    primary[field] = {
      get isDown() {
        return keys.some((key) => key.isDown);
      },
      subscribe() {
        keys.forEach((key) => key.subscribe());
      },
      unsubscribe() {
        keys.forEach((key) => key.unsubscribe());
      },
    };
  }
  return primary;
}
export function createRdfKeyboard(slot, mode = 'diagonal') {
  return new PikaKeyboard(
    'KeyD',
    'KeyG',
    'KeyR',
    mode === 'down-only' ? 'KeyF' : 'KeyV',
    'KeyZ',
    mode === 'down-only' ? null : 'KeyF',
    slot >= 2 ? -1 : 1
  );
}
export function createDoublesMenuKeyboards(mode = 'diagonal') {
  const keys = DOUBLES_SLOT_KEYS.map(
    (bindings) => new PikaKeyboard(...bindings)
  );
  keys[0] = combineKeyboards(keys[0], createRdfKeyboard(0, mode));
  return keys;
}
export function createDoublesKeyboards(humans, mode = 'diagonal') {
  if (humans.length === 4)
    return DOUBLES_SLOT_KEYS.map((bindings) => new PikaKeyboard(...bindings));
  const keys = Array.from(
    { length: 4 },
    () => new PikaKeyboard(null, null, null, null, null)
  );
  humans.forEach((slot, index) => {
    keys[slot].unsubscribe();
    keys[slot] =
      index === 0
        ? createRdfKeyboard(slot, mode)
        : new PikaKeyboard(...ARROW_KEYS);
    if (humans.length === 1)
      keys[slot] = combineKeyboards(
        keys[slot],
        new PikaKeyboard(...ARROW_KEYS)
      );
  });
  return keys;
}
