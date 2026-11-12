const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { buildMetadata } = require('../scripts/client-version.cjs');
const {
  CLIENT_VERSION,
  ClientUpdates,
  sameVersion,
  assertRoomCompatible,
} = require('./client-version-fixture.cjs');
const response = (value) => ({ ok: true, json: async () => value });

test('build identity changes with source, engine, revision and build mode, and is stable otherwise', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pika-version-'));
  t.after(() =>
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 4,
      retryDelay: 100,
    })
  );
  fs.mkdirSync(path.join(root, 'src/resources/js/online_2v2'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, 'src/resources/js/online_2v2/protocol.js'),
    "export const ROOM_SCHEMA = 'test-protocol';"
  );
  fs.writeFileSync(path.join(root, 'src', 'main.js'), 'initial');
  const manifest = path.join(root, 'offline-engine.manifest.json');
  fs.writeFileSync(
    manifest,
    JSON.stringify({ files: { 'physics.js': 'first' } })
  );
  const first = buildMetadata(root, 'production', 'commit').metadata;
  assert.deepEqual(buildMetadata(root, 'production', 'commit').metadata, first);
  assert.notEqual(
    buildMetadata(root, 'development', 'commit').metadata.build,
    first.build
  );
  assert.notEqual(
    buildMetadata(root, 'production', 'other').metadata.build,
    first.build
  );
  fs.writeFileSync(path.join(root, 'src', 'main.js'), 'changed');
  const changed = buildMetadata(root, 'production', 'commit').metadata;
  assert.notEqual(changed.build, first.build);
  assert.equal(changed.engine, first.engine);
  fs.writeFileSync(
    manifest,
    JSON.stringify({ files: { 'physics.js': 'second' } })
  );
  assert.notEqual(
    buildMetadata(root, 'production', 'commit').metadata.engine,
    first.engine
  );
});

test('version checks preserve repository URL prefix, bypass cache and coalesce concurrent requests', async () => {
  const seen = [];
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const updates = new ClientUpdates({
    url: 'https://example.com/repo/version.json',
    fetcher: async (url, options) => {
      seen.push({ url, options });
      await pending;
      return response(CLIENT_VERSION);
    },
  });
  const a = updates.ensureCurrent(),
    b = updates.ensureCurrent();
  release();
  await Promise.all([a, b]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url.pathname, '/repo/version.json');
  assert.ok(seen[0].url.searchParams.has('check'));
  assert.equal(seen[0].options.cache, 'no-store');
  assert.equal(updates.state, 'current');
});

test('stale clients and unavailable or invalid version files fail closed; successful checks recover', async () => {
  let value = response({ ...CLIENT_VERSION, build: 'new-release' });
  const updates = new ClientUpdates({
    url: 'https://example.com/version.json',
    fetcher: async () => value,
  });
  await assert.rejects(updates.ensureCurrent(), /update is available/);
  value = { ok: false };
  await assert.rejects(updates.ensureCurrent(), /update is available/);
  value = response(CLIENT_VERSION);
  await updates.ensureCurrent();
  value = response({});
  await assert.rejects(updates.ensureCurrent(), /Could not check/);
  value = { ok: false };
  await assert.rejects(updates.ensureCurrent(), /Could not check/);
  value = response(CLIENT_VERSION);
  await updates.ensureCurrent();
});

test('room compatibility requires a matching build, protocol and engine for every participant', () => {
  const data = {
    compatibility: CLIENT_VERSION,
    members: {
      host: { compatibility: CLIENT_VERSION },
      guest: { compatibility: CLIENT_VERSION },
    },
  };
  assert.doesNotThrow(() => assertRoomCompatible(data));
  for (const field of ['build', 'engine', 'protocol', 'format']) {
    const bad = { ...CLIENT_VERSION, [field]: 'different' };
    assert.equal(sameVersion(bad), false);
    assert.throws(
      () =>
        assertRoomCompatible({
          ...data,
          members: { ...data.members, guest: { compatibility: bad } },
        }),
      /versions do not match/
    );
  }
  assert.throws(
    () => assertRoomCompatible({ ...data, compatibility: undefined }),
    /reload/
  );
  assert.throws(
    () => assertRoomCompatible({ ...data, members: { host: {} } }),
    /reload/
  );
});
