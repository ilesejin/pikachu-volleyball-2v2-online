import { CanvasRenderer } from '@pixi/canvas-renderer';
import { Container } from '@pixi/display';
import { Sprite } from '@pixi/sprite';
import { Texture } from '@pixi/core';
import { DOUBLES_CONFIG } from '../offline_2v2/doubles_config.js';
import { SKIN_IDS } from './protocol.js';
import capSheet from '../../assets/images/costumes/cap.png';
import headbandSheet from '../../assets/images/costumes/headband.png';
import scarfSheet from '../../assets/images/costumes/scarf.png';
import costumeLayout from '../../assets/images/costumes/frames.json';

export const COSTUME_SHEETS = {
  cap: capSheet,
  headband: headbandSheet,
  scarf: scarfSheet,
};
export function loadCostumeSheets(loader) {
  Object.values(COSTUME_SHEETS).forEach((url) => loader.add(url));
}
// Stable IDs keep earlier saved preferences and replay files compatible.
export function costumeParts(id) {
  if (!SKIN_IDS.includes(id)) return { head: 'none', neck: 'none' };
  return {
    head: id.startsWith('cap')
      ? 'cap'
      : id.startsWith('headband')
      ? 'headband'
      : 'none',
    neck: id.includes('scarf') ? 'scarf' : 'none',
  };
}
export function costumeId(head, neck) {
  const hat = ['cap', 'headband'].includes(head) ? head : '';
  return neck === 'scarf' ? (hat ? hat + '-scarf' : 'scarf') : hat || 'classic';
}

export const COSTUME_NAMES = {
  classic: 'Classic',
  cap: 'Cap',
  headband: 'Headband',
  scarf: 'Scarf',
  'cap-scarf': 'Cap + Scarf',
  'headband-scarf': 'Headband + Scarf',
};
const canvas = (width = 64, height = 64) => {
  const image = document.createElement('canvas');
  image.width = width;
  image.height = height;
  return image;
};
// PNGs share a vertical crop of the original atlas. Subtract its saved offset.
// Frame origins and spacing stay unchanged. Combine once,
// then reuse cached textures; no accessory drawing or compositing in the ticker.
function compose(source, id, frame, resources) {
  const image = canvas(),
    ctx = image.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(source, 0, 0);
  const parts = costumeParts(id);
  // Neck first, head last: a fixed layer order for every animation and replay.
  for (const accessory of [parts.neck, parts.head]) {
    if (accessory === 'none') continue;
    const sheet =
      resources[COSTUME_SHEETS[accessory]]?.texture?.baseTexture.resource
        .source;
    if (
      !sheet ||
      sheet.width !== costumeLayout.size.w ||
      sheet.height !== costumeLayout.size.h
    )
      throw new Error('Invalid costume sprite sheet: ' + accessory);
    ctx.drawImage(
      sheet,
      frame.x - costumeLayout.offset.x,
      frame.y - costumeLayout.offset.y,
      frame.width,
      frame.height,
      0,
      0,
      frame.width,
      frame.height
    );
  }
  return Texture.from(image);
}
export class CostumeLibrary {
  constructor(base, resources) {
    this.frames = { classic: base };
    this.icons = new Map();
    this.views = new WeakMap();
    const renderer = new CanvasRenderer({
      width: 64,
      height: 64,
      resolution: 1,
      backgroundAlpha: 0,
      antialias: false,
    });
    const stage = new Container(),
      sprite = new Sprite(base[0]);
    sprite.anchor.set(0.5);
    sprite.position.set(32, 32);
    stage.addChild(sprite);
    try {
      for (const id of SKIN_IDS.slice(1)) this.frames[id] = [];
      for (const texture of base) {
        sprite.texture = texture;
        renderer.render(stage);
        for (const id of SKIN_IDS.slice(1))
          this.frames[id].push(
            compose(renderer.view, id, texture.frame, resources)
          );
      }
    } finally {
      stage.destroy({ children: true });
      renderer.destroy(true);
    }
    this.markers = DOUBLES_CONFIG.playerTints.map((color) => {
      const image = canvas(10, 10),
        ctx = image.getContext('2d');
      const rows = [2, 6, 8, 10, 10, 10, 10, 8, 6, 2];
      rows.forEach((width, y) => {
        ctx.fillStyle = '#171717';
        ctx.fillRect((10 - width) / 2, y, width, 1);
      });
      ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
      ctx.fillRect(3, 2, 4, 6);
      ctx.fillRect(2, 3, 6, 4);
      return Texture.from(image);
    });
  }
  icon(id = 'classic', slot = -1) {
    if (!SKIN_IDS.includes(id)) id = 'classic';
    const key = id + ':' + slot;
    if (this.icons.has(key)) return this.icons.get(key);
    const renderer = new CanvasRenderer({
      width: 64,
      height: 64,
      resolution: 1,
      backgroundAlpha: 0,
      antialias: false,
    });
    const stage = new Container(),
      sprite = new Sprite(this.frames[id][0]);
    sprite.anchor.set(0.5);
    sprite.position.set(32, 32);
    sprite.scale.x = slot < 2 ? 1 : -1;
    sprite.tint =
      id === 'classic' && slot >= 0
        ? DOUBLES_CONFIG.playerTints[slot]
        : 0xffffff;
    stage.addChild(sprite);
    try {
      renderer.render(stage);
      const url = renderer.view.toDataURL('image/png');
      this.icons.set(key, url);
      return url;
    } finally {
      stage.destroy({ children: true });
      renderer.destroy(true);
    }
  }
  apply(game, skins, legacy = false) {
    const view = game.view.game;
    let record = this.views.get(view);
    if (!record) {
      const markers = this.markers.map((texture) => {
        const sprite = new Sprite(texture);
        sprite.anchor.set(0.5);
        view.container.addChildAt(
          sprite,
          view.container.getChildIndex(view.messages.gameStart)
        );
        return sprite;
      });
      record = { key: null, markers };
      this.views.set(view, record);
    }
    const ids = Array.from({ length: 4 }, (_, i) =>
      SKIN_IDS.includes(skins?.[i]) ? skins[i] : 'classic'
    );
    const key = JSON.stringify([ids, legacy]);
    if (record.key !== key) {
      view.playerSprites.forEach((sprite, i) => {
        const frame = sprite.currentFrame;
        sprite.textures = this.frames[ids[i]];
        sprite.tint =
          legacy || ids[i] === 'classic'
            ? DOUBLES_CONFIG.playerTints[i]
            : 0xffffff;
        sprite.gotoAndStop(frame);
      });
      record.key = key;
    }
    record.markers.forEach((marker, i) => {
      marker.visible = !legacy;
      marker.x = game.players[i].x;
      marker.y = game.players[i].y + 38;
    });
  }
}
