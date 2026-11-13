import { CanvasRenderer } from '@pixi/canvas-renderer';
import { Container } from '@pixi/display';
import { Sprite } from '@pixi/sprite';

// Render the game's standing frame with the same Pixi tint and court-facing
// orientation. Cache the four images once; lobby updates reuse their URLs.
export function createPlayerIcons(texture, tints) {
  const renderer = new CanvasRenderer({
    width: 64,
    height: 64,
    resolution: 1,
    backgroundAlpha: 0,
    antialias: false,
  });
  const stage = new Container();
  const sprite = new Sprite(texture);
  sprite.anchor.set(0.5);
  sprite.position.set(32, 32);
  stage.addChild(sprite);
  try {
    return tints.map((tint, slot) => {
      sprite.tint = tint;
      sprite.scale.x = slot < 2 ? 1 : -1;
      renderer.render(stage);
      return renderer.view.toDataURL('image/png');
    });
  } finally {
    stage.destroy({ children: true });
    renderer.destroy(true);
  }
}
