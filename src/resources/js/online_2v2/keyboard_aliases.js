import { PikaKeyboard } from '../offline_2v2/keyboard.js';

// Combine physical keys before the original input reader handles direction priority
// and the power-hit edge, so aliases remain one controller and one hit button.
export function createAliasedKeyboard(primaryKeys, aliasKeys) {
  const keyboard = new PikaKeyboard(...primaryKeys);
  const aliases = new PikaKeyboard(...aliasKeys);
  for (const field of [
    'leftKey',
    'rightKey',
    'upKey',
    'downKey',
    'powerHitKey',
    'downRightKey',
  ]) {
    const keys = [keyboard[field], aliases[field]];
    keyboard[field] = {
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
  return keyboard;
}
