import { initializeApp, getApps } from 'firebase/app';
import {
  initializeAuth,
  inMemoryPersistence,
  signInAnonymously,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  collection,
  runTransaction,
  onSnapshot,
  updateDoc,
  setDoc,
  addDoc,
  getDocs,
  getDocFromServer,
  writeBatch,
  deleteField,
  serverTimestamp,
} from 'firebase/firestore';
import { firebaseConfig } from './config.js';
import {
  ROOM_SCHEMA,
  randomizedPositions,
  validSlots,
  occupiedSlots,
  matchSettings,
  playerNames,
  lobbyReady,
} from './protocol.js';

export class FirebaseRoomStore {
  constructor() {
    this.db = null;
    this.auth = null;
    this.identityPromise = null;
  }
  async identity() {
    if (
      !firebaseConfig.projectId ||
      firebaseConfig.projectId.includes('YOUR_') ||
      !firebaseConfig.apiKey ||
      firebaseConfig.apiKey.includes('YOUR_')
    ) {
      throw new Error(
        'Configure your new Firebase project in online_2v2/config.js. See ONLINE_SETUP.md.'
      );
    }
    if (!this.identityPromise) {
      this.identityPromise = (async () => {
        const app =
          getApps().find((item) => item.name === 'online-2v2-tabs') ||
          initializeApp(firebaseConfig, 'online-2v2-tabs');
        // Initialize with NONE persistence before anything can restore a shared user.
        // Each tab gets its own identity, including duplicated tabs/windows.
        this.auth = initializeAuth(app, { persistence: inMemoryPersistence });
        this.db = getFirestore(app);
        if (!this.auth.currentUser) await signInAnonymously(this.auth);
        return this.auth.currentUser.uid;
      })().catch((error) => {
        this.identityPromise = null;
        throw error;
      });
    }
    return this.identityPromise;
  }
  async token() {
    await this.identity();
    return this.auth.currentUser.getIdToken();
  }
  room(id) {
    return doc(this.db, 'rooms', id);
  }
  connection(roomId, peerId) {
    return doc(this.db, 'rooms', roomId, 'connections', peerId);
  }
  async peek(id) {
    const snapshot = await getDocFromServer(this.room(id));
    return snapshot.exists() ? snapshot.data() : null;
  }
  async create(id, hostId, name, layout, slots, settings) {
    if (!validSlots(layout, slots, true))
      throw new Error('Choose a valid player position.');
    const names = playerNames(name, layout);
    name = names[0];
    const data = {
      schema: ROOM_SCHEMA,
      hostId,
      layout,
      settings: matchSettings(settings),
      status: 'lobby',
      members: { [hostId]: { name, names, slots, connected: true } },
      createdAt: serverTimestamp(),
      seats: [0, 1, 2, 3].map((slot) => (slots.includes(slot) ? hostId : '')),
    };
    await runTransaction(this.db, async (transaction) => {
      const snapshot = await transaction.get(this.room(id));
      if (snapshot.exists())
        throw new Error('Room ID already exists. Please try again.');
      transaction.set(this.room(id), data);
    });
    return data;
  }
  async claim(id, clientId, name, slots = []) {
    let joined;
    await runTransaction(this.db, async (transaction) => {
      const snapshot = await transaction.get(this.room(id));
      if (!snapshot.exists()) throw new Error('Room not found.');
      const data = snapshot.data();
      if (data.schema !== ROOM_SCHEMA)
        throw new Error('This room uses an older version. Create a new room.');
      if (data.status !== 'lobby')
        throw new Error('The match has started or the room has closed.');
      if (!validSlots(data.layout, slots, true))
        throw new Error('Invalid player positions.');
      if (data.members[clientId])
        throw new Error(
          'This tab already joined the room. Open another tab to join separately.'
        );
      if (Object.keys(data.members).length >= (data.layout === 'pairs' ? 2 : 4))
        throw new Error('This lobby is full.');
      const used = occupiedSlots(data.members);
      if (slots.some((slot) => used.includes(slot)))
        throw new Error('That position is already occupied.');
      const names = playerNames(name, data.layout);
      const member = { name: names[0], names, slots, connected: false };
      const seats = data.seats.map((owner, slot) =>
        slots.includes(slot) ? clientId : owner
      );
      transaction.update(this.room(id), {
        ['members.' + clientId]: member,
        seats,
      });
      joined = {
        ...data,
        seats,
        members: { ...data.members, [clientId]: member },
      };
    });
    return joined;
  }
  async selectSlots(id, clientId, slots) {
    return runTransaction(this.db, async (transaction) => {
      const snapshot = await transaction.get(this.room(id));
      if (!snapshot.exists()) throw new Error('Room not found.');
      const data = snapshot.data();
      if (data.schema !== ROOM_SCHEMA || data.status !== 'lobby')
        throw new Error('Slots can only change in the lobby.');
      const member = data.members[clientId];
      if (!member) throw new Error('Join the lobby first.');
      if (!validSlots(data.layout, slots, true))
        throw new Error('Select a whole team for local pairs.');
      if (
        slots.some((slot) => data.seats[slot] && data.seats[slot] !== clientId)
      )
        throw new Error('That position is already occupied.');
      const seats = data.seats.map((owner, slot) =>
        slots.includes(slot) ? clientId : owner === clientId ? '' : owner
      );
      transaction.update(this.room(id), {
        ['members.' + clientId]: { ...member, slots },
        seats,
      });
    });
  }
  async randomizeSlots(id, hostId) {
    return runTransaction(this.db, async (transaction) => {
      const snapshot = await transaction.get(this.room(id));
      if (!snapshot.exists()) throw new Error('Room not found.');
      const data = snapshot.data();
      if (data.hostId !== hostId)
        throw new Error('Only the host can randomize positions.');
      if (data.schema !== ROOM_SCHEMA || data.status !== 'lobby')
        throw new Error('Positions can only be randomized in the lobby.');
      transaction.update(this.room(id), randomizedPositions(data));
    });
  }
  async rename(id, clientId, value) {
    return runTransaction(this.db, async (transaction) => {
      const snapshot = await transaction.get(this.room(id));
      if (!snapshot.exists()) throw new Error('Room not found.');
      const data = snapshot.data();
      if (data.status !== 'lobby' || !data.members[clientId])
        throw new Error('Names can only change in your own lobby entry.');
      const names = playerNames(value, data.layout);
      transaction.update(this.room(id), {
        ['members.' + clientId]: {
          ...data.members[clientId],
          names,
          name: names[0],
        },
      });
    });
  }
  async beginMatch(id, hostId, settings) {
    let result;
    await runTransaction(this.db, async (transaction) => {
      const snapshot = await transaction.get(this.room(id));
      if (!snapshot.exists()) throw new Error('Room not found.');
      const data = snapshot.data();
      if (data.hostId !== hostId) throw new Error('Only the host can start.');
      if (!lobbyReady(data))
        throw new Error(
          'Every joined player must select a slot before starting.'
        );
      if (Object.values(data.members).some((member) => !member.connected))
        throw new Error('Wait for all players to connect before starting.');
      const checked = matchSettings(settings);
      transaction.update(this.room(id), {
        settings: checked,
        status: 'playing',
      });
      result = { ...data, settings: checked, status: 'playing' };
    });
    return result;
  }
  watch(id, receive, error) {
    return onSnapshot(
      this.room(id),
      (snapshot) => receive(snapshot.exists() ? snapshot.data() : null),
      error
    );
  }
  update(id, value) {
    return updateDoc(this.room(id), value);
  }
  async remove(id, clientId) {
    return runTransaction(this.db, async (transaction) => {
      const snapshot = await transaction.get(this.room(id));
      if (!snapshot.exists()) return;
      const data = snapshot.data();
      transaction.update(this.room(id), {
        [`members.${clientId}`]: deleteField(),
        seats: data.seats.map((owner) => (owner === clientId ? '' : owner)),
      });
    });
  }
  connected(id, clientId) {
    return this.update(id, { [`members.${clientId}.connected`]: true });
  }
  watchSignal(roomId, peerId, receive, error) {
    return onSnapshot(
      this.connection(roomId, peerId),
      (snapshot) => {
        if (snapshot.exists()) receive(snapshot.data());
      },
      error
    );
  }
  offer(roomId, peerId, offer) {
    return setDoc(this.connection(roomId, peerId), {
      offer: { type: offer.type, sdp: offer.sdp },
    });
  }
  answer(roomId, peerId, answer) {
    return updateDoc(this.connection(roomId, peerId), {
      answer: { type: answer.type, sdp: answer.sdp },
    });
  }
  candidate(roomId, peerId, side, candidate) {
    return addDoc(collection(this.connection(roomId, peerId), side), candidate);
  }
  watchCandidates(roomId, peerId, side, receive, error) {
    return onSnapshot(
      collection(this.connection(roomId, peerId), side),
      (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === 'added') receive(change.doc.data());
        });
      },
      error
    );
  }
  async close(id) {
    await this.update(id, { status: 'closed' });
    const connections = await getDocs(collection(this.room(id), 'connections'));
    const refs = [];
    for (const connection of connections.docs) {
      for (const side of ['hostCandidates', 'guestCandidates']) {
        const candidates = await getDocs(collection(connection.ref, side));
        candidates.forEach((candidate) => refs.push(candidate.ref));
      }
      refs.push(connection.ref);
    }
    refs.push(this.room(id));
    for (let i = 0; i < refs.length; i += 400) {
      const batch = writeBatch(this.db);
      refs.slice(i, i + 400).forEach((ref) => batch.delete(ref));
      await batch.commit();
    }
  }
}
