import { normalizeLanguageDirectory } from '../online_2v2/page_route.js';
import { ASSETS_PATH } from '../offline_version_js/assets_path.js';
import { replayPlayer } from './replay_player.js';
import { setUpUI } from './ui_replay.js';

normalizeLanguageDirectory();
adjustAssetsPath();
setUpUI();
if (process.env.NODE_ENV === 'development')
  window.__replayPlayer = replayPlayer;

/**
 * Adjust game assets path to the path from the perspective of en/replay/index.html
 */
function adjustAssetsPath() {
  ASSETS_PATH.SPRITE_SHEET = '../' + ASSETS_PATH.SPRITE_SHEET;
  for (const prop in ASSETS_PATH.SOUNDS) {
    ASSETS_PATH.SOUNDS[prop] = '../' + ASSETS_PATH.SOUNDS[prop];
  }
}
