const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const digest = (value) => createHash('sha256').update(value).digest('hex');
function buildMetadata(root, mode, revision) {
  const files = [];
  const walk = (relative) => {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) return;
    if (fs.statSync(file).isDirectory())
      fs.readdirSync(file)
        .sort()
        .forEach((name) => walk(path.join(relative, name)));
    else files.push(relative);
  };
  [
    'src',
    'scripts',
    'package.json',
    'package-lock.json',
    'offline-engine.manifest.json',
    'webpack.common.js',
    'webpack.dev.js',
    'webpack.prod.js',
  ].forEach(walk);
  const hash = createHash('sha256').update(mode);
  files.sort().forEach((relative) => {
    const bytes = fs.readFileSync(path.join(root, relative));
    hash.update(relative.replace(/\\/g, '/')).update('\0');
    hash.update(
      /\.(js|cjs|json|html|css)$/.test(relative)
        ? bytes.toString('utf8').replace(/\r\n/g, '\n')
        : bytes
    );
    hash.update('\0');
  });
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'offline-engine.manifest.json'), 'utf8')
  );
  const protocolSource = fs.readFileSync(
    path.join(root, 'src/resources/js/online_2v2/protocol.js'),
    'utf8'
  );
  const protocol = protocolSource.match(
    /export const ROOM_SCHEMA = ['"]([^'"]+)['"]/
  );
  if (!protocol)
    throw new Error('Cannot read the room protocol for build metadata.');
  const engine = digest(JSON.stringify(Object.entries(manifest.files).sort()));
  let commit = revision;
  if (!commit) {
    try {
      commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      commit = 'snapshot';
    }
  }
  return {
    metadata: {
      format: 1,
      protocol: protocol[1],
      build: `${commit}-${hash.digest('hex').slice(0, 20)}`,
      engine,
      commit,
    },
    files,
  };
}
class ClientVersionPlugin {
  apply(compiler) {
    let snapshot;
    compiler.hooks.beforeCompile.tap('ClientVersionPlugin', () => {
      snapshot = buildMetadata(compiler.context, compiler.options.mode);
    });
    new compiler.webpack.DefinePlugin({
      __CLIENT_VERSION__: compiler.webpack.DefinePlugin.runtimeValue(
        () => JSON.stringify(snapshot.metadata),
        true
      ),
    }).apply(compiler);
    compiler.hooks.thisCompilation.tap('ClientVersionPlugin', (compilation) => {
      snapshot.files.forEach((file) =>
        compilation.fileDependencies.add(path.join(compiler.context, file))
      );
      ['src', 'scripts'].forEach((folder) =>
        compilation.contextDependencies.add(path.join(compiler.context, folder))
      );
      compilation.hooks.processAssets.tap(
        {
          name: 'ClientVersionPlugin',
          stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
        },
        () => {
          compilation.emitAsset(
            'version.json',
            new compiler.webpack.sources.RawSource(
              JSON.stringify(snapshot.metadata) + '\n'
            )
          );
        }
      );
    });
  }
}
module.exports = { buildMetadata, ClientVersionPlugin };
