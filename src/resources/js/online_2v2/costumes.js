import { CanvasRenderer } from '@pixi/canvas-renderer';
import { Container } from '@pixi/display';
import { Sprite } from '@pixi/sprite';
import { Texture } from '@pixi/core';
import { DOUBLES_CONFIG } from '../offline_2v2/doubles_config.js';
import { SKIN_IDS } from './protocol.js';
import capSheet from '../../assets/images/costumes/cap.png';
import crownSheet from '../../assets/images/costumes/crown.png';
import headphonesSheet from '../../assets/images/costumes/headphones.png';
import bowtieSheet from '../../assets/images/costumes/bowtie.png';
import starSunglassesSheet from '../../assets/images/costumes/star-sunglasses.png';
import headbandSheet from '../../assets/images/costumes/headband.png';
import scarfSheet from '../../assets/images/costumes/scarf.png';
import sunglassesSheet from '../../assets/images/costumes/sunglasses.png';
import roundGlassesSheet from '../../assets/images/costumes/round-glasses.png';
import triangleSunglassesSheet from '../../assets/images/costumes/triangle-sunglasses.png';
import cyborgSheet from '../../assets/images/skins/cyborg.png';
import cyborgLayout from '../../assets/images/skins/cyborg.json';
import costumeLayout from '../../assets/images/costumes/frames.json';

export const COSTUME_SHEETS = {
  cap: capSheet,
  crown: crownSheet,
  headphones: headphonesSheet,
  bowtie: bowtieSheet,
  'star-sunglasses': starSunglassesSheet,
  headband: headbandSheet,
  scarf: scarfSheet,
  sunglasses: sunglassesSheet,
  'round-glasses': roundGlassesSheet,
  'triangle-sunglasses': triangleSunglassesSheet,
};
export const SKIN_SHEETS = { cyborg: cyborgSheet };
export function loadCostumeSheets(loader) {
  [...Object.values(COSTUME_SHEETS), ...Object.values(SKIN_SHEETS)].forEach(
    (url) => loader.add(url)
  );
}
// Stable IDs keep earlier saved preferences and replay files compatible.
export function costumeParts(id) {
  const valid = SKIN_IDS.includes(id) ? id : 'classic';
  const skin = valid.startsWith('cyborg') ? 'cyborg' : 'pikachu';
  const accessory =
    skin === 'cyborg' ? valid.slice('cyborg'.length).replace(/^-/, '') : valid;
  return {
    skin,
    head:
      ['cap', 'headband', 'crown', 'headphones'].find(
        (part) => accessory === part || accessory.startsWith(part + '-')
      ) || 'none',
    neck: accessory.includes('bowtie')
      ? 'bowtie'
      : accessory.includes('scarf')
      ? 'scarf'
      : 'none',
    eyes:
      [
        'star-sunglasses',
        'triangle-sunglasses',
        'round-glasses',
        'sunglasses',
      ].find((part) => accessory === part || accessory.endsWith('-' + part)) ||
      'none',
  };
}
export function costumeId(head, neck, skin = 'pikachu', eyes = 'none') {
  const hat = ['cap', 'headband', 'crown', 'headphones'].includes(head)
    ? head
    : '';
  const accessory = [
    hat,
    ['scarf', 'bowtie'].includes(neck) ? neck : '',
    [
      'sunglasses',
      'round-glasses',
      'triangle-sunglasses',
      'star-sunglasses',
    ].includes(eyes)
      ? eyes
      : '',
  ]
    .filter(Boolean)
    .join('-');
  return skin === 'cyborg'
    ? 'cyborg' + (accessory ? '-' + accessory : '')
    : accessory || 'classic';
}

const ITEM_NAMES = {
  cap: 'Cap',
  headband: 'Headband',
  crown: 'Crown',
  headphones: 'Headphones',
  scarf: 'Scarf',
  bowtie: 'Bow Tie',
  sunglasses: 'Sunglasses',
  'round-glasses': 'Round Glasses',
  'triangle-sunglasses': 'Triangular Sunglasses',
  'star-sunglasses': 'Star Sunglasses',
};
export const COSTUME_NAMES = Object.fromEntries(
  SKIN_IDS.map((id) => {
    const parts = costumeParts(id);
    const names = [
      parts.skin === 'cyborg' ? 'Cyborg Pikachu' : '',
      ...[parts.head, parts.neck, parts.eyes]
        .filter((part) => part !== 'none')
        .map((part) => ITEM_NAMES[part]),
    ].filter(Boolean);
    return [id, names.join(' + ') || 'Classic'];
  })
);
const canvas = (width = 64, height = 64) => {
  const image = document.createElement('canvas');
  image.width = width;
  image.height = height;
  return image;
};
// PNGs share a vertical crop of the original atlas. Subtract its saved offset.
// Frame origins and spacing stay unchanged. Combine once,
// then reuse cached textures; no accessory drawing or compositing in the ticker.
function compose(source, id, frame, resources, attachment) {
  const image = canvas(),
    ctx = image.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const parts = costumeParts(id);
  const drawSheet = (url, label, offset = { x: 0, y: 0 }) => {
    const sheet = resources[url]?.texture?.baseTexture.resource.source;
    if (
      !sheet ||
      sheet.width !== costumeLayout.size.w ||
      sheet.height !== costumeLayout.size.h
    )
      throw new Error('Invalid character sprite sheet: ' + label);
    ctx.drawImage(
      sheet,
      frame.x - costumeLayout.offset.x,
      frame.y - costumeLayout.offset.y,
      frame.width,
      frame.height,
      offset.x,
      offset.y,
      frame.width,
      frame.height
    );
  };
  // A skin replaces the body completely; accessories are independent overlays.
  if (parts.skin === 'cyborg') drawSheet(SKIN_SHEETS.cyborg, 'cyborg');
  else ctx.drawImage(source, 0, 0);
  // Eyewear is last so its lenses stay visible with either headwear option.
  for (const [slot, accessory] of [
    ['neck', parts.neck],
    ['head', parts.head],
    ['eyes', parts.eyes],
  ]) {
    if (accessory !== 'none')
      drawSheet(
        COSTUME_SHEETS[accessory],
        accessory,
        parts.skin === 'cyborg' ? attachment?.[slot] : undefined
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
      const attachments = new Map(
        Object.entries(costumeLayout.frames).map(([name, info]) => [
          info.frame.x + ':' + info.frame.y,
          cyborgLayout.attachments[name],
        ])
      );
      const sources = base.map((texture) => {
        sprite.texture = texture;
        renderer.render(stage);
        const source = canvas();
        source.getContext('2d').drawImage(renderer.view, 0, 0);
        return source;
      });
      // Cache a full animation only when that outfit is actually requested.
      // Adding catalog combinations must not prebuild thousands of unused canvases.
      for (const id of SKIN_IDS.slice(1))
        Object.defineProperty(this.frames, id, {
          enumerable: true,
          configurable: true,
          get: () => {
            const frames = base.map((texture, index) =>
              compose(
                sources[index],
                id,
                texture.frame,
                resources,
                attachments.get(texture.frame.x + ':' + texture.frame.y)
              )
            );
            Object.defineProperty(this.frames, id, {
              value: frames,
              enumerable: true,
              configurable: true,
            });
            return frames;
          },
        });
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
