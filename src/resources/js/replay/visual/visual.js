import { HEADER, STRIDE, packedInputs } from './format.js';
export function sprites(view) {
  return [
    ...view.playerSprites,
    view.ball,
    view.ballHyper,
    view.ballTrail,
    view.punch,
    ...view.playerShadows,
    view.shadows.forBall,
    ...view.cloudContainer.children,
    ...view.waveContainer.children,
    ...view.scoreBoards.flatMap((board) => [board, ...board.children]),
    view.messages.gameStart,
    view.messages.ready,
    view.messages.gameEnd,
  ];
}
export function capture(game) {
  const vector = [
    game.view.fadeInOut.black.alpha,
    packedInputs(game.keyboardArray),
    game.players.reduce(
      (mask, player, i) => mask | (player.isComputer ? 1 << i : 0),
      0
    ),
    ...game.scores,
  ];
  for (const sprite of sprites(game.view.game))
    vector.push(
      sprite.x,
      sprite.y,
      sprite.scale.x,
      sprite.scale.y,
      sprite.rotation,
      sprite.alpha,
      sprite.visible ? 1 : 0,
      Number.isInteger(sprite.currentFrame) ? sprite.currentFrame : -1,
      sprite.tint === undefined ? 0xffffff : sprite.tint
    );
  return vector;
}
export function apply(view, fade, vector) {
  const objects = sprites(view);
  if (vector.length !== HEADER + STRIDE * objects.length)
    throw Error('Replay image does not match this viewer.');
  objects.forEach((sprite, i) => {
    const at = HEADER + i * STRIDE,
      frame = vector[at + 7];
    if (sprite.gotoAndStop) {
      if (!Number.isInteger(frame) || frame < 0 || frame >= sprite.totalFrames)
        throw Error('Invalid replay animation.');
      sprite.gotoAndStop(frame);
    }
    sprite.position.set(vector[at], vector[at + 1]);
    sprite.scale.set(vector[at + 2], vector[at + 3]);
    sprite.rotation = vector[at + 4];
    sprite.alpha = vector[at + 5];
    sprite.visible = !!vector[at + 6];
    if ('tint' in sprite) sprite.tint = vector[at + 8];
  });
  view.container.visible = true;
  fade.black.alpha = vector[0];
}
