'use strict';
// Integration check for the actual Firebase Auth SDK; requires a local Auth emulator.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const appSDK = require('firebase/app'),
  authSDK = require('firebase/auth'),
  dbSDK = require('firebase/firestore');
const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host || ''))
  throw Error('A local Auth emulator is required.');
const source = fs
  .readFileSync(
    path.join(__dirname, '../src/resources/js/online_2v2/firebase_store.js'),
    'utf8'
  )
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?\r?\n/gm, '')
  .replace(/export /g, '');
const apps = [];
function tab(label) {
  const bindings = {
    firebaseConfig: {
      projectId: 'demo-pikavolley-2v2',
      apiKey: 'fake-api-key',
      appId: 'demo-app',
    },
    getApps: () => [],
    initializeApp: (config, name) => {
      const app = appSDK.initializeApp(config, label + '-' + name);
      apps.push(app);
      return app;
    },
    initializeAuth: (app, options) => {
      assert.equal(options.persistence, authSDK.inMemoryPersistence);
      const auth = authSDK.initializeAuth(app, options);
      authSDK.connectAuthEmulator(auth, 'http://' + host, {
        disableWarnings: true,
      });
      return auth;
    },
    inMemoryPersistence: authSDK.inMemoryPersistence,
    signInAnonymously: authSDK.signInAnonymously,
    getFirestore: dbSDK.getFirestore,
  };
  const { FirebaseRoomStore } = Function(
    ...Object.keys(bindings),
    source + ';return{FirebaseRoomStore};'
  )(...Object.values(bindings));
  return new FirebaseRoomStore();
}
(async () => {
  const one = tab('first'),
    two = tab('second'),
    duplicate = tab('duplicated-page');
  const ids = await Promise.all([
    one.identity(),
    one.identity(),
    two.identity(),
    duplicate.identity(),
  ]);
  assert.equal(ids[0], ids[1]);
  assert.equal(new Set(ids).size, 3);
  for (const [store, uid] of [
    [one, ids[0]],
    [two, ids[2]],
    [duplicate, ids[3]],
  ]) {
    const token = await store.token();
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString()
    );
    assert.equal(payload.sub, uid);
  }
  console.log(
    'Actual Firebase Auth SDK: independent tab identities, concurrent sign-in reuse, and matching ID tokens passed.'
  );
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const app of apps) {
      await dbSDK.terminate(dbSDK.getFirestore(app));
      await appSDK.deleteApp(app);
    }
  });
