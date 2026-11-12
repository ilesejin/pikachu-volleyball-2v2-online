/** Original P2P room-code presentation; stored IDs remain unhyphenated. */
export function normalizeRoomCode(value) {
  return value.trim().toLowerCase().replace(/-/g, '');
}
export function formatRoomCode(id) {
  return id.match(/.{1,5}/g)?.join('-') || '';
}
