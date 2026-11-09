import seedrandom from 'seedrandom';
const clone = (value) => JSON.parse(JSON.stringify(value));
const primitives = (object) =>
  Object.fromEntries(
    Object.entries(object).filter(
      ([, value]) =>
        typeof value === 'boolean' ||
        typeof value === 'string' ||
        (typeof value === 'number' && Number.isFinite(value))
    )
  );
export function captureCheckpoint(game, inputs, rng) {
  return {
    values: primitives(game),
    state: game.state.name,
    scores: game.scores.slice(),
    physics: primitives(game.physics),
    nextServer: game.physics.nextServer.slice(),
    players: game.players.map(clone),
    ball: clone(game.physics.ball),
    clouds: game.view.game.cloudArray.map(clone),
    wave: clone(game.view.game.wave),
    inputs: inputs.map(clone),
    rng: rng.state(),
  };
}
export function restoreCheckpoint(game, inputs, checkpoint) {
  Object.assign(game, checkpoint.values);
  game.state = game[checkpoint.state];
  game.scores = checkpoint.scores.slice();
  Object.assign(game.physics, checkpoint.physics);
  game.physics.nextServer = checkpoint.nextServer.slice();
  game.players.forEach((player, index) =>
    Object.assign(player, clone(checkpoint.players[index]))
  );
  Object.assign(game.physics.ball, clone(checkpoint.ball));
  game.view.game.cloudArray.forEach((cloud, index) =>
    Object.assign(cloud, clone(checkpoint.clouds[index]))
  );
  Object.assign(game.view.game.wave, clone(checkpoint.wave));
  inputs.forEach((input, index) =>
    Object.assign(input, clone(checkpoint.inputs[index]), {
      lastReceived: Date.now(),
    })
  );
  return seedrandom.alea('', { state: checkpoint.rng });
}
export function validCheckpoint(value, game) {
  return (
    !!value &&
    value.values &&
    typeof game[value.state] === 'function' &&
    [
      'startOfNewGame',
      'round',
      'afterEndOfRound',
      'beforeStartOfNextRound',
      'intro',
    ].includes(value.state) &&
    Array.isArray(value.scores) &&
    value.scores.length === 2 &&
    Array.isArray(value.nextServer) &&
    value.nextServer.length === 2 &&
    Array.isArray(value.players) &&
    value.players.length === 4 &&
    Array.isArray(value.inputs) &&
    value.inputs.length === 4 &&
    Array.isArray(value.clouds) &&
    value.clouds.length === 10 &&
    value.wave &&
    value.ball &&
    value.rng &&
    ['c', 's0', 's1', 's2'].every((key) => Number.isFinite(value.rng[key]))
  );
}
