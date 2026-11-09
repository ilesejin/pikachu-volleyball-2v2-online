'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ROOT_FILES,
  syncOfflineEngine,
  OfflineEnginePlugin,
} = require('../scripts/sync-offline-engine.cjs');
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pika-engine-sync-'));
  const offline = path.join(directory, 'offline');
  const online = path.join(directory, 'online');
  const source = path.join(offline, 'src/resources/js');
  const target = path.join(online, 'src/resources/js/offline_2v2');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(
    path.join(offline, 'package.json'),
    '{"name":"offline-fixture"}'
  );
  ROOT_FILES.forEach((file) =>
    fs.writeFileSync(
      path.join(source, file),
      "export const marker = 'baseline-" + file + "';\n"
    )
  );
  const options = { onlineRoot: online, sourceRoot: offline, quiet: true };
  return {
    directory,
    offline,
    online,
    source,
    target,
    options,
    write(file, content) {
      const destination = path.join(source, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content);
    },
    cleanup() {
      const resolved = path.resolve(directory);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith('pika-engine-sync-'));
      fs.rmSync(resolved, { recursive: true, force: true });
    },
  };
}
test('sync follows real imports, ignores import-like comments/strings, detects drift, and only removes retired managed files', (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  f.write('main.js', 'this offline entry must not replace the online app');
  f.write(
    'physics.js',
    `export { marker } from './rules/one.js'; import './rules/two.js';
    import /* a comment */ './rules/three.js';
    const text = "import './missing-string.js'";
    // import './missing-comment.js';
    import('./rules/four.js');`
  );
  for (const name of ['one', 'two', 'three', 'four'])
    f.write('rules/' + name + '.js', "export const marker = '" + name + "';");
  const initial = syncOfflineEngine(f.options);
  assert.equal(initial.files.length, ROOT_FILES.length + 4);
  assert.equal(fs.existsSync(path.join(f.target, 'main.js')), false);
  assert.equal(
    fs.readFileSync(path.join(f.target, 'physics.js'), 'utf8'),
    fs.readFileSync(path.join(f.source, 'physics.js'), 'utf8')
  );
  f.write('rules/one.js', "export const marker = 'changed';");
  assert.throws(
    () => syncOfflineEngine({ ...f.options, check: true }),
    /drift/
  );
  assert.match(
    fs.readFileSync(path.join(f.target, 'rules/one.js'), 'utf8'),
    /'one'/
  );
  syncOfflineEngine(f.options);
  assert.match(
    fs.readFileSync(path.join(f.target, 'rules/one.js'), 'utf8'),
    /changed/
  );
  fs.writeFileSync(path.join(f.target, 'unmanaged.txt'), 'keep');
  f.write('physics.js', "export {marker} from './rules/one.js';");
  fs.writeFileSync(path.join(f.target, 'rules/two.js'), 'local edit');
  assert.throws(
    () => syncOfflineEngine(f.options),
    /retired managed engine file was edited/
  );
  assert.match(
    fs.readFileSync(path.join(f.target, 'physics.js'), 'utf8'),
    /rules\/two/
  );
  fs.writeFileSync(
    path.join(f.target, 'rules/two.js'),
    "export const marker = 'two';"
  );
  syncOfflineEngine(f.options);
  assert.equal(fs.existsSync(path.join(f.target, 'rules/two.js')), false);
  assert.equal(
    fs.readFileSync(path.join(f.target, 'unmanaged.txt'), 'utf8'),
    'keep'
  );
  assert.deepEqual(
    syncOfflineEngine({ ...f.options, check: true }).changed,
    []
  );
});
test('standalone builds verify the bundled snapshot, tolerate checkout line endings, and reject tampering or a missing explicit source', (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  syncOfflineEngine(f.options);
  const absent = path.join(f.directory, 'missing');
  const bundled = {
    ...f.options,
    sourceRoot: absent,
    allowMissingSource: true,
  };
  assert.equal(syncOfflineEngine(bundled).bundled, true);
  const file = path.join(f.target, 'physics.js');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
  assert.equal(syncOfflineEngine(bundled).bundled, true);
  assert.throws(
    () => syncOfflineEngine({ ...bundled, allowMissingSource: false }),
    /not found/
  );
  fs.appendFileSync(file, '\n// modified\n');
  assert.throws(
    () => syncOfflineEngine(bundled),
    /differs from its recorded snapshot/
  );
});
test('incomplete source trees and imports outside the shared directory fail before changing the copied engine', (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  syncOfflineEngine(f.options);
  const before = fs.readFileSync(path.join(f.target, 'physics.js'));
  fs.writeFileSync(
    path.join(f.offline, 'src/resources/outside.js'),
    'export const value=1;'
  );
  f.write('physics.js', "export * from '../outside.js';");
  assert.throws(() => syncOfflineEngine(f.options), /escapes/);
  assert.ok(fs.readFileSync(path.join(f.target, 'physics.js')).equals(before));
  fs.unlinkSync(path.join(f.offline, 'package.json'));
  assert.throws(() => syncOfflineEngine(f.options), /Incomplete/);
});
test(
  'webpack watch syncs source edits, newly imported modules, and repairs edits to the copied engine',
  { timeout: 30000 },
  async () => {
    const f = fixture();
    let compiler, watching;
    try {
      f.write('pikavolley.js', "export {marker} from './doubles_physics.js';");
      fs.writeFileSync(
        path.join(f.online, 'entry.js'),
        "import {marker} from './src/resources/js/offline_2v2/pikavolley.js';console.log(marker);"
      );
      const webpack = require('webpack');
      compiler = webpack({
        context: f.online,
        mode: 'development',
        target: 'node',
        entry: './entry.js',
        output: { path: path.join(f.online, 'bundle'), filename: 'main.js' },
        plugins: [new OfflineEnginePlugin(f.options)],
      });
      await new Promise((resolve, reject) => {
        let stage = 0;
        watching = compiler.watch({ aggregateTimeout: 50 }, (error, stats) => {
          if (error) return reject(error);
          if (stats.hasErrors())
            return reject(
              new Error(stats.toString({ all: false, errors: true }))
            );
          try {
            const built = fs.readFileSync(
              path.join(f.online, 'bundle/main.js'),
              'utf8'
            );
            if (stage === 0) {
              assert.match(built, /baseline-doubles_physics/);
              stage = 1;
              f.write('new_rule.js', "export const marker='watched-new';");
              f.write(
                'doubles_physics.js',
                "export {marker} from './new_rule.js';"
              );
            } else if (stage === 1 && built.includes('watched-new')) {
              assert.equal(
                fs.existsSync(path.join(f.target, 'new_rule.js')),
                true
              );
              stage = 2;
              f.write('new_rule.js', "export const marker='watched-second';");
            } else if (stage === 2 && built.includes('watched-second')) {
              stage = 3;
              fs.writeFileSync(
                path.join(f.target, 'new_rule.js'),
                "export const marker='bad-online-edit';"
              );
            } else if (stage === 3 && built.includes('watched-second')) {
              assert.equal(
                fs.readFileSync(path.join(f.target, 'new_rule.js'), 'utf8'),
                fs.readFileSync(path.join(f.source, 'new_rule.js'), 'utf8')
              );
              resolve();
            }
          } catch (failure) {
            reject(failure);
          }
        });
      });
    } finally {
      if (watching) await new Promise((resolve) => watching.close(resolve));
      if (compiler) await new Promise((resolve) => compiler.close(resolve));
      f.cleanup();
    }
  }
);

test('the real shared engine matches its authoritative source or its verified bundled snapshot', () => {
  syncOfflineEngine({ check: true, quiet: true });
});
