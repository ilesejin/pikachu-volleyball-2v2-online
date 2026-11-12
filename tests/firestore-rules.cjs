'use strict';
// Run with Firebase emulators only; this script never addresses a live project.
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  assert = require('node:assert/strict');
const appSDK = require('firebase/app'),
  authSDK = require('firebase/auth'),
  dbSDK = require('firebase/firestore');
const projectId = 'demo-pikavolley-2v2';
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8085';
if (
  !/^(localhost|127\.0\.0\.1):\d+$/.test(authHost) ||
  !/^(localhost|127\.0\.0\.1):\d+$/.test(firestoreHost)
)
  throw Error('Tests require local emulators.');
function load(file, names, bindings = {}) {
  const source = fs
    .readFileSync(path.join(__dirname, '../src/resources/js', file), 'utf8')
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?\r?\n/gm, '')
    .replace(/export /g, '');
  return Function(
    ...Object.keys(bindings),
    source + ';return{' + names.join(',') + '};'
  )(...Object.values(bindings));
}
const DOUBLES_CONFIG = load('offline_2v2/doubles_config.js', [
  'DOUBLES_CONFIG',
]).DOUBLES_CONFIG;
const protocol = load(
  'online_2v2/protocol.js',
  [
    'ROOM_SCHEMA',
    'validSlots',
    'occupiedSlots',
    'randomizedPositions',
    'matchSettings',
    'playerNames',
    'lobbyReady',
    'connectionKey',
  ],
  { DOUBLES_CONFIG }
);
const { FirebaseRoomStore } = load(
  'online_2v2/firebase_store.js',
  ['FirebaseRoomStore'],
  { ...appSDK, ...authSDK, ...dbSDK, ...protocol, ROOM_SCHEMA: 'pikavolley-2v2-v4', firebaseConfig: {} }
);
const clients = [];
async function client(name, login = true) {
  const app = appSDK.initializeApp(
    { projectId, apiKey: 'fake-api-key', appId: 'demo-app' },
    name
  );
  const auth = authSDK.getAuth(app);
  authSDK.connectAuthEmulator(auth, 'http://' + authHost, {
    disableWarnings: true,
  });
  const db = dbSDK.getFirestore(app);
  dbSDK.connectFirestoreEmulator(
    db,
    firestoreHost.split(':')[0],
    Number(firestoreHost.split(':')[1])
  );
  if (login) await authSDK.signInAnonymously(auth);
  const store = new FirebaseRoomStore();
  store.db = db;
  const result = {
    app,
    auth,
    db,
    store,
    uid: auth.currentUser && auth.currentUser.uid,
  };
  clients.push(result);
  return result;
}
async function denied(action) {
  await assert.rejects(action, (error) => error.code === 'permission-denied');
}
(async () => {
  const host = await client('rules-host'),
    guest = await client('rules-guest'),
    other = await client('rules-other'),
    anonymous = await client('rules-unsigned', false);
  const id = crypto.randomBytes(10).toString('hex');
  await host.store.create(id, host.uid, 'Host', 'four', [0], {});
  await denied(dbSDK.getDoc(dbSDK.doc(anonymous.db, 'rooms', id)));
  await denied(dbSDK.getDocs(dbSDK.collection(guest.db, 'rooms')));
  await guest.store.claim(id, guest.uid, 'Guest', [1]);
  await denied(
    dbSDK.updateDoc(dbSDK.doc(guest.db, 'rooms', id), {
      settings: {
        courtWidth: 999,
        serveMode: 'fixed',
        fps: 30,
        winningScore: 5,
      },
    })
  );
  await denied(
    dbSDK.updateDoc(dbSDK.doc(other.db, 'rooms', id), {
      ['members.' + other.uid]: { name: 'Steal', slots: [1], connected: false },
      seats: [host.uid, other.uid, '', ''],
    })
  );
  const signalId = protocol.connectionKey(
    await host.store.peek(id),
    host.uid,
    guest.uid
  );
  await host.store.offer(
    id,
    signalId,
    { type: 'offer', sdp: 'test-offer' },
    { revision: 0, offererId: host.uid, answererId: guest.uid }
  );
  await denied(
    dbSDK.getDoc(dbSDK.doc(other.db, 'rooms', id, 'connections', signalId))
  );
  await guest.store.answer(id, signalId, {
    type: 'answer',
    sdp: 'test-answer',
  });
  await guest.store.candidate(id, signalId, 'guestCandidates', {
    candidate: 'guest-ice',
    sdpMid: '0',
    sdpMLineIndex: 0,
  });
  await denied(
    guest.store.candidate(id, signalId, 'hostCandidates', {
      candidate: 'spoofed-host-ice',
    })
  );
  await host.store.candidate(id, signalId, 'hostCandidates', {
    candidate: 'host-ice',
    sdpMid: '0',
    sdpMLineIndex: 0,
  });
  await host.store.connected(id, guest.uid);
  await host.store.update(id, { status: 'playing' });
  await guest.store.remove(id, guest.uid);
  assert.equal((await host.store.peek(id)).seats[1], '');
  await host.store.close(id);
  assert.equal(
    (await dbSDK.getDoc(dbSDK.doc(host.db, 'rooms', id))).exists(),
    false
  );
  const meshRoom = crypto.randomBytes(10).toString('hex');
  await host.store.create(meshRoom, host.uid, 'Host', 'four', [0], {});
  await guest.store.claim(meshRoom, guest.uid, 'Guest', [1]);
  await other.store.claim(meshRoom, other.uid, 'Other', [2]);
  const offerer = guest.uid < other.uid ? guest : other;
  const answerer = offerer === guest ? other : guest;
  const linkId = protocol.connectionKey(
    await host.store.peek(meshRoom),
    guest.uid,
    other.uid
  );
  // A member may subscribe before the offer document exists.
  assert.equal(
    (
      await dbSDK.getDoc(
        dbSDK.doc(answerer.db, 'rooms', meshRoom, 'connections', linkId)
      )
    ).exists(),
    false
  );
  await offerer.store.offer(
    meshRoom,
    linkId,
    { type: 'offer', sdp: 'guest-to-guest' },
    { revision: 0, offererId: offerer.uid, answererId: answerer.uid }
  );
  await answerer.store.answer(meshRoom, linkId, {
    type: 'answer',
    sdp: 'direct-answer',
  });
  await denied(
    offerer.store.answer(meshRoom, linkId, {
      type: 'answer',
      sdp: 'wrong-role',
    })
  );
  await offerer.store.candidate(meshRoom, linkId, 'hostCandidates', {
    candidate: 'offerer-ice',
  });
  await answerer.store.candidate(meshRoom, linkId, 'guestCandidates', {
    candidate: 'answerer-ice',
  });
  await denied(
    answerer.store.candidate(meshRoom, linkId, 'hostCandidates', {
      candidate: 'spoof',
    })
  );
  await host.store.rebuildNetwork(meshRoom, host.uid, { topology: 'star' });
  await denied(
    dbSDK.getDoc(
      dbSDK.doc(answerer.db, 'rooms', meshRoom, 'connections', linkId)
    )
  );
  const starPeerLink = protocol.connectionKey(
    await host.store.peek(meshRoom),
    guest.uid,
    other.uid
  );
  await denied(
    offerer.store.offer(
      meshRoom,
      starPeerLink,
      { type: 'offer', sdp: 'forbidden-star-mesh' },
      { revision: 1, offererId: offerer.uid, answererId: answerer.uid }
    )
  );
  await host.store.close(meshRoom);
  const pairs = crypto.randomBytes(10).toString('hex');
  await host.store.create(pairs, host.uid, 'Host', 'pairs', [2, 3], {});
  await guest.store.claim(pairs, guest.uid, 'Guest', [0, 1]);
  await assert.rejects(
    other.store.claim(pairs, other.uid, 'Duplicate', [0, 1])
  );
  await host.store.close(pairs);
  const randomRoom = crypto.randomBytes(10).toString('hex');
  await host.store.create(randomRoom, host.uid, ['H1', 'H2'], 'pairs', [], {});
  await guest.store.claim(randomRoom, guest.uid, ['G1', 'G2'], []);
  await assert.rejects(
    guest.store.randomizeSlots(randomRoom, guest.uid),
    /host/
  );
  await host.store.randomizeSlots(randomRoom, host.uid);
  const assigned = await host.store.peek(randomRoom);
  assert.equal(protocol.lobbyReady(assigned), true);
  assert.deepEqual(assigned.members[host.uid].names, ['H1', 'H2']);
  assert.deepEqual(assigned.members[guest.uid].names, ['G1', 'G2']);
  for (const [uid, member] of Object.entries(assigned.members)) {
    assert.equal(protocol.validSlots('pairs', member.slots), true);
    for (const slot of member.slots) assert.equal(assigned.seats[slot], uid);
  }
  await host.store.connected(randomRoom, guest.uid);
  await host.store.beginMatch(randomRoom, host.uid, {});
  await assert.rejects(
    host.store.randomizeSlots(randomRoom, host.uid),
    /lobby/
  );
  await host.store.close(randomRoom);
  const lobby = crypto.randomBytes(10).toString('hex');
  await host.store.create(lobby, host.uid, ['One', 'Two'], 'pairs', [], {});
  await guest.store.claim(lobby, guest.uid, ['Three', 'Four'], []);
  assert.deepEqual((await host.store.peek(lobby)).seats, ['', '', '', '']);
  await assert.rejects(
    host.store.beginMatch(lobby, host.uid, {}),
    /select a slot/
  );
  await denied(host.store.update(lobby, { status: 'playing' }));
  await host.store.selectSlots(lobby, host.uid, [0, 1]);
  await host.store.connected(lobby, guest.uid);
  await guest.store.selectSlots(lobby, guest.uid, [2, 3]);
  await assert.rejects(
    host.store.selectSlots(lobby, host.uid, [2, 3]),
    /occupied/
  );
  await guest.store.rename(lobby, guest.uid, ['Alice', 'Bob']);
  assert.deepEqual((await host.store.peek(lobby)).members[guest.uid].names, [
    'Alice',
    'Bob',
  ]);
  await guest.store.selectSlots(lobby, guest.uid, []);
  await assert.rejects(
    host.store.beginMatch(lobby, host.uid, {}),
    /select a slot/
  );
  await guest.store.selectSlots(lobby, guest.uid, [2, 3]);
  const begun = await host.store.beginMatch(lobby, host.uid, {
    practice: true,
  });
  assert.equal(begun.settings.practice, true);
  await assert.rejects(
    guest.store.selectSlots(lobby, guest.uid, []),
    /only change in the lobby/
  );
  await denied(
    dbSDK.updateDoc(dbSDK.doc(guest.db, 'rooms', lobby), {
      ['members.' + guest.uid + '.names']: ['Sneaky', 'Change'],
    })
  );
  await host.store.close(lobby);
  const four = crypto.randomBytes(10).toString('hex'),
    fourth = await client('rules-fourth');
  await host.store.create(four, host.uid, 'Host', 'four', [], {});
  for (const c of [guest, other, fourth])
    await c.store.claim(four, c.uid, 'Guest', []);
  await assert.rejects(
    host.store.beginMatch(four, host.uid, {}),
    /select a slot/
  );
  const contestants = await Promise.allSettled([
    guest.store.selectSlots(four, guest.uid, [1]),
    other.store.selectSlots(four, other.uid, [1]),
  ]);
  assert.equal(contestants.filter((r) => r.status === 'fulfilled').length, 1);
  await guest.store.selectSlots(four, guest.uid, []);
  await other.store.selectSlots(four, other.uid, []);
  await host.store.selectSlots(four, host.uid, [0]);
  await guest.store.selectSlots(four, guest.uid, [1]);
  await other.store.selectSlots(four, other.uid, [2]);
  await fourth.store.selectSlots(four, fourth.uid, [3]);
  for (const c of [guest, other, fourth])
    await host.store.connected(four, c.uid);
  const race = await Promise.allSettled([
    host.store.beginMatch(four, host.uid, {}),
    fourth.store.selectSlots(four, fourth.uid, []),
  ]);
  assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
  await host.store.close(four);
  console.log(
    'Firestore emulator: authenticated room claims, both arrangements, host-only settings, protected signaling, ICE ownership, guest leaving, and full cleanup passed.'
  );
})()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const client of clients) {
      await dbSDK.terminate(client.db);
      await appSDK.deleteApp(client.app);
    }
  });
