// Local Auth/Firestore emulators only; never use the frontend Firebase config.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict');
const app = require('firebase/app'),
  auth = require('firebase/auth'),
  db = require('firebase/firestore');
function load(file, names, bindings) {
  const source = fs
    .readFileSync(
      path.join(__dirname, '../src/resources/js/online_2v2', file),
      'utf8'
    )
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?\r?\n/gm, '')
    .replace(/export /g, '');
  return Function(
    ...Object.keys(bindings),
    source + ';return {' + names.join(',') + '};'
  )(...Object.values(bindings));
}
const { FirebaseIdentity } = load(
  'firebase_identity.js',
  ['FirebaseIdentity'],
  {
    ...app,
    ...auth,
    ...db,
  }
);
const { SignalingStore } = load('signaling_store.js', ['SignalingStore'], {
  ...db,
  FirebaseIdentity,
  ROOM_SCHEMA: 'pikavolley-2v2-v5',
});
const clients = [];
async function client() {
  const instance = app.initializeApp(
    { projectId: 'demo-pikavolley-2v2', apiKey: 'fake-key', appId: 'demo' },
    'signals-' + clients.length + '-' + Date.now()
  );
  const login = auth.getAuth(instance);
  auth.connectAuthEmulator(login, 'http://127.0.0.1:9099', {
    disableWarnings: true,
  });
  const database = db.getFirestore(instance);
  db.connectFirestoreEmulator(database, '127.0.0.1', 8085);
  await auth.signInAnonymously(login);
  const store = new SignalingStore();
  store.db = database;
  store.auth = login;
  clients.push(instance);
  return { store, uid: login.currentUser.uid };
}
const denied = (action) =>
  assert.rejects(action, (error) => error.code === 'permission-denied');
(async () => {
  const host = await client(),
    guest = await client(),
    outsider = await client();
  const id = 'rules' + Date.now();
  const oldRoom = db.doc(host.store.db, 'rooms', id);
  await denied(
    db.setDoc(oldRoom, { schema: 'pikavolley-2v2-v4', hostId: host.uid })
  );
  await denied(db.getDoc(oldRoom));
  await denied(db.getDocs(db.collection(host.store.db, 'rooms')));
  await denied(
    db.setDoc(db.doc(host.store.db, 'rooms', id, 'connections', 'old'), {
      offer: { type: 'offer', sdp: 'old' },
    })
  );

  await host.store.publish(id, { hostId: host.uid, layout: 'four' });
  assert.equal((await guest.store.peek(id)).hostId, host.uid);
  await denied(
    outsider.store.publish(id, { hostId: outsider.uid, layout: 'four' })
  );
  let stop;
  const seen = new Promise((resolve, reject) => {
    stop = host.store.watchRequests(
      id,
      (uid, value) => {
        if (uid === guest.uid) resolve(value);
      },
      reject
    );
  });
  await guest.store.requestJoin(id, guest.uid, host.uid);
  assert.equal(
    (
      await Promise.race([
        seen,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Request listener timeout')), 10000)
        ),
      ])
    ).hostId,
    host.uid
  );
  stop();
  await denied(outsider.store.requestJoin(id, guest.uid, host.uid));
  await denied(outsider.store.requestJoin(id, outsider.uid, guest.uid));
  await denied(
    guest.store.offer(
      id,
      guest.uid,
      { type: 'offer', sdp: 'bad' },
      { offererId: host.uid, answererId: guest.uid }
    )
  );
  await host.store.offer(
    id,
    guest.uid,
    { type: 'offer', sdp: 'offer' },
    { offererId: host.uid, answererId: guest.uid }
  );
  await guest.store.answer(id, guest.uid, { type: 'answer', sdp: 'answer' });
  await denied(
    outsider.store.answer(id, guest.uid, { type: 'answer', sdp: 'bad' })
  );
  let stopCandidates;
  const incomingCandidate = new Promise((resolve, reject) => {
    stopCandidates = guest.store.watchCandidates(
      id,
      guest.uid,
      'hostCandidates',
      resolve,
      reject
    );
  });
  await host.store.candidate(id, guest.uid, 'hostCandidates', {
    candidate: 'host-ice',
  });
  assert.equal(
    (
      await Promise.race([
        incomingCandidate,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Candidate listener timeout')),
            10000
          )
        ),
      ])
    ).candidate,
    'host-ice'
  );
  stopCandidates();
  await guest.store.candidate(id, guest.uid, 'guestCandidates', {
    candidate: 'guest-ice',
  });
  await denied(
    guest.store.candidate(id, guest.uid, 'hostCandidates', {
      candidate: 'forged',
    })
  );
  await denied(
    db.getDoc(
      db.doc(outsider.store.db, 'rendezvous', id, 'requests', guest.uid)
    )
  );
  await host.store.unpublish(id);
  assert.equal(await guest.store.peek(id), null);
  await denied(outsider.store.requestJoin(id, outsider.uid, host.uid));
  // Cleanup remains authorized after the public join entry has been deleted.
  await host.store.clearSignal(id, guest.uid);
  assert.equal(
    (await db.getDoc(guest.store.connection(id, guest.uid))).exists(),
    false
  );
  await host.store.close(id);
  await host.store.publish(id, { hostId: host.uid, layout: 'pairs' });
  await guest.store.requestJoin(id, guest.uid, host.uid);
  await host.store.close(id);
  assert.equal(await guest.store.peek(id), null);
  assert.equal(
    (await db.getDoc(guest.store.connection(id, guest.uid))).exists(),
    false
  );
  await host.store.clearSignal(id, guest.uid);
  console.log(
    'v5 signaling rules: authenticated ownership, endpoint isolation, host query, ICE permissions, cleanup after unpublish, and same-code reopening passed.'
  );
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const instance of clients) await app.deleteApp(instance);
  });
