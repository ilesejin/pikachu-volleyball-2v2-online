import { localStorageWrapper } from '../offline_version_js/utils/local_storage_wrapper.js';

// Reuse the original P2P nickname key so existing players keep their name.
const NAME_KEYS = ['myNickname', 'mySecondNickname'];
export function loadPlayerNames(storage = localStorageWrapper) {
  return NAME_KEYS.map((key) => {
    const value = storage.get(key);
    return value === null || value === undefined
      ? null
      : String(value).trim().slice(0, 24);
  });
}
export function savePlayerName(index, value, storage = localStorageWrapper) {
  if (index !== 0 && index !== 1) return;
  storage.set(NAME_KEYS[index], String(value).trim().slice(0, 24));
}
