'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT_FILES = [
  'pikavolley.js',
  'physics.js',
  'doubles_physics.js',
  'doubles_config.js',
  'keyboard.js',
  'rand.js',
  'assets_path.js',
];
const MANIFEST = 'offline-engine.manifest.json';
const within = (root, file) => {
  const relative = path.relative(root, file);
  return (
    relative !== '..' &&
    !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative)
  );
};
const digest = (bytes) =>
  crypto
    .createHash('sha256')
    .update(bytes.toString('utf8').replace(/\r\n/g, '\n'))
    .digest('hex');
function relativeImports(source) {
  const { parse } = require('acorn');
  const found = new Set();
  const add = (node) => {
    if (!node || typeof node.value !== 'string')
      throw new Error(
        'Shared engine imports must use literal paths so they can be synchronized.'
      );
    if (node.value.startsWith('.')) found.add(node.value);
  };
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (
      [
        'ImportDeclaration',
        'ExportNamedDeclaration',
        'ExportAllDeclaration',
      ].includes(node.type) &&
      node.source
    )
      add(node.source);
    if (node.type === 'ImportExpression') add(node.source);
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'require'
    )
      add(node.arguments[0]);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(
    parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true,
    })
  );
  return [...found];
}
function readManifest(file) {
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (
    data.schema !== 1 ||
    !data.files ||
    typeof data.files !== 'object' ||
    Array.isArray(data.files) ||
    !ROOT_FILES.every((name) => data.files[name])
  )
    throw new Error(
      'Invalid offline engine manifest. Run npm run sync:offline with the offline repository available.'
    );
  for (const [name, hash] of Object.entries(data.files)) {
    if (
      name.includes('\\') ||
      path.posix.isAbsolute(name) ||
      name.split('/').some((part) => !part || part === '..' || part === '.') ||
      !/^[a-f0-9]{64}$/.test(hash)
    )
      throw new Error('Invalid managed engine path or hash: ' + name);
  }
  return data;
}
function atomicWrite(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.sync-' + process.pid + '-' + crypto.randomUUID();
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
function syncOfflineEngine(options = {}) {
  const onlineRoot = path.resolve(
    options.onlineRoot || path.join(__dirname, '..')
  );
  const configured = options.sourceRoot || process.env.PIKA_OFFLINE_ROOT;
  const sourceRoot = path.resolve(
    configured || path.join(onlineRoot, '..', 'pikachu-volleyball-2v2')
  );
  const sourceJS = path.join(sourceRoot, 'src/resources/js');
  const target = path.join(onlineRoot, 'src/resources/js/offline_2v2');
  const manifestPath = path.join(onlineRoot, MANIFEST);
  const previous = readManifest(manifestPath);
  const log = (message) => {
    if (!options.quiet) console.log('[offline engine] ' + message);
  };
  const checkedTarget = (name) => {
    const file = path.resolve(target, name);
    if (!within(target, file))
      throw new Error('Engine destination escapes the managed directory.');
    let parent = file;
    while (!fs.existsSync(parent)) parent = path.dirname(parent);
    if (!within(fs.realpathSync(onlineRoot), fs.realpathSync(parent)))
      throw new Error('Engine destination is outside the online repository.');
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink())
      throw new Error('The managed engine directory must not be a symlink.');
    return file;
  };
  if (!fs.existsSync(sourceRoot)) {
    if ((configured && options.allowMissingSource !== true) || !previous)
      throw new Error(
        'Offline repository not found: ' +
          sourceRoot +
          '. Set PIKA_OFFLINE_ROOT or place it beside this project.'
      );
    const mismatches = Object.entries(previous.files).filter(([name, hash]) => {
      const file = checkedTarget(name);
      return !fs.existsSync(file) || digest(fs.readFileSync(file)) !== hash;
    });
    if (mismatches.length)
      throw new Error(
        'Bundled offline engine differs from its recorded snapshot: ' +
          mismatches.map(([name]) => name).join(', ') +
          '. Restore the offline repository and run npm run sync:offline.'
      );
    log(
      'Offline repository unavailable; verified the bundled engine snapshot (' +
        Object.keys(previous.files).length +
        ' files).'
    );
    return {
      bundled: true,
      files: Object.keys(previous.files).map(checkedTarget),
      sourceFiles: [],
      sourceJS,
      missingSource: path.join(sourceRoot, 'package.json'),
      changed: [],
    };
  }
  if (
    !fs.existsSync(path.join(sourceRoot, 'package.json')) ||
    !fs.existsSync(sourceJS)
  )
    throw new Error('Incomplete offline repository: ' + sourceRoot);
  const realSource = fs.realpathSync(sourceJS);
  if (
    within(realSource, path.resolve(target)) ||
    within(path.resolve(target), realSource)
  )
    throw new Error(
      'Offline source and online engine directories must be separate.'
    );
  const collected = new Map();
  function collect(file) {
    file = path.resolve(file);
    if (!within(sourceJS, file) || !within(realSource, fs.realpathSync(file)))
      throw new Error(
        'Shared engine import escapes the offline JavaScript directory: ' + file
      );
    const name = path.relative(sourceJS, file).split(path.sep).join('/');
    if (collected.has(name)) return;
    const bytes = fs.readFileSync(file);
    collected.set(name, bytes);
    if (/\.[cm]?js$/.test(file))
      for (const imported of relativeImports(bytes.toString('utf8'))) {
        const base = path.resolve(path.dirname(file), imported);
        const resolved = [base, base + '.js', path.join(base, 'index.js')].find(
          (candidate) =>
            fs.existsSync(candidate) && fs.statSync(candidate).isFile()
        );
        if (!resolved)
          throw new Error(
            'Missing shared engine import ' + imported + ' in ' + name
          );
        collect(resolved);
      }
  }
  ROOT_FILES.forEach((name) => collect(path.join(sourceJS, name)));
  const files = Object.fromEntries(
    [...collected]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, bytes]) => [name, digest(bytes)])
  );
  const manifest = {
    schema: 1,
    sourceProject: 'pikachu-volleyball-2v2',
    files,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  const changed = [];
  const removed = [];
  for (const [name, bytes] of collected) {
    const destination = checkedTarget(name);
    if (
      !fs.existsSync(destination) ||
      !fs.readFileSync(destination).equals(bytes)
    )
      changed.push({ destination, bytes });
  }
  for (const [name, hash] of Object.entries(previous ? previous.files : {}))
    if (!collected.has(name)) {
      const destination = checkedTarget(name);
      if (fs.existsSync(destination)) {
        if (digest(fs.readFileSync(destination)) !== hash)
          throw new Error(
            'A retired managed engine file was edited locally: ' +
              name +
              '. Review it before synchronizing.'
          );
        removed.push(destination);
      }
    }
  const manifestChanged =
    !previous || JSON.stringify(previous) !== JSON.stringify(manifest);
  if (options.check && (changed.length || removed.length || manifestChanged))
    throw new Error(
      'Offline engine drift detected. Run npm run sync:offline. Changed files: ' +
        [
          ...changed.map((item) => path.relative(target, item.destination)),
          ...removed.map((file) => path.relative(target, file)),
          ...(manifestChanged ? [MANIFEST] : []),
        ].join(', ')
    );
  if (!options.check) {
    changed.forEach((item) => atomicWrite(item.destination, item.bytes));
    removed.forEach((file) => fs.unlinkSync(file));
    if (manifestChanged) atomicWrite(manifestPath, manifestBytes);
  }
  if (changed.length || removed.length || manifestChanged)
    log(
      'Synchronized ' +
        changed.length +
        ' files; removed ' +
        removed.length +
        ' retired files.'
    );
  else
    log(
      'Shared engine matches the offline source (' + collected.size + ' files).'
    );
  return {
    bundled: false,
    files: [...collected.keys()].map(checkedTarget),
    sourceFiles: [...collected.keys()].map((name) => path.join(sourceJS, name)),
    sourceJS,
    changed: [
      ...changed.map((item) => item.destination),
      ...removed,
      ...(manifestChanged ? [manifestPath] : []),
    ],
  };
}
class OfflineEnginePlugin {
  constructor(options = {}) {
    this.options = options;
  }
  apply(compiler) {
    let snapshot;
    const sync = () => {
      snapshot = syncOfflineEngine(this.options);
      if (snapshot.changed.length) {
        if (compiler.modifiedFiles)
          snapshot.changed.forEach((file) => compiler.modifiedFiles.add(file));
        if (compiler.inputFileSystem.purge) compiler.inputFileSystem.purge();
      }
    };
    compiler.hooks.beforeRun.tap('OfflineEnginePlugin', sync);
    compiler.hooks.watchRun.tap('OfflineEnginePlugin', sync);
    compiler.hooks.afterCompile.tap('OfflineEnginePlugin', (compilation) => {
      if (!snapshot) return;
      snapshot.sourceFiles.forEach((file) =>
        compilation.fileDependencies.add(file)
      );
      if (!snapshot.bundled)
        compilation.contextDependencies.add(snapshot.sourceJS);
      else compilation.missingDependencies.add(snapshot.missingSource);
      compilation.fileDependencies.add(
        path.join(
          this.options.onlineRoot || path.join(__dirname, '..'),
          MANIFEST
        )
      );
    });
  }
}
module.exports = { ROOT_FILES, syncOfflineEngine, OfflineEnginePlugin };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.some((arg) => arg !== '--check'))
      throw new Error('Usage: node scripts/sync-offline-engine.cjs [--check]');
    syncOfflineEngine({ check: args.includes('--check') });
  } catch (error) {
    console.error('[offline engine] ' + error.message);
    process.exitCode = 1;
  }
}
