/** 2v2-only settings. Original 1v1 geometry and physics are unchanged. */
export const DOUBLES_CONFIG = {
  // Width of EACH half in engine units (original half: 216).
  courtWidth: 384,
  // 'rotate-players', 'rotate-ball', or 'fixed'.
  serveMode: 'rotate-ball',
  playerTints: [0xffdf72, 0xffa080, 0x70ffff, 0xff70ff],
};

if (
  !Number.isInteger(DOUBLES_CONFIG.courtWidth) ||
  DOUBLES_CONFIG.courtWidth < 216
) {
  throw new Error('2v2 courtWidth must be an integer of at least 216.');
}
export const DOUBLES_WIDTH = DOUBLES_CONFIG.courtWidth * 2;
