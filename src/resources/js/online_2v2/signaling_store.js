import { FirebaseRoomStore } from './firebase_store.js';
import {
  doc,
  collection,
  setDoc,
  deleteDoc,
  onSnapshot,
  getDocFromServer,
  getDocs,
  writeBatch,
  query,
  where,
} from 'firebase/firestore';
import { ROOM_SCHEMA } from './protocol.js';

// Only rendezvous and temporary host/guest signaling use Firestore.
// Inherit the existing per-tab authentication, not its legacy lobby operations.
export class SignalingStore extends FirebaseRoomStore {
  constructor() {
    super();
    this.cleanups = new Map();
  }
  room(id) {
    return doc(this.db, 'rendezvous', id);
  }
  connection(id, guestId) {
    return doc(this.db, 'rendezvous', id, 'requests', guestId);
  }
  async peek(id) {
    const snapshot = await getDocFromServer(this.room(id));
    return snapshot.exists() ? snapshot.data() : null;
  }
  publish(id, data) {
    return setDoc(this.room(id), {
      schema: ROOM_SCHEMA,
      hostId: data.hostId,
      layout: data.layout,
      status: 'lobby',
    });
  }
  unpublish(id) {
    return deleteDoc(this.room(id));
  }
  requestJoin(id, guestId, hostId) {
    return setDoc(this.connection(id, guestId), { guestId, hostId });
  }
  watchRequests(id, receive, error) {
    return onSnapshot(
      query(
        collection(this.room(id), 'requests'),
        where('hostId', '==', this.auth.currentUser.uid)
      ),
      (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === 'added') {
            receive(change.doc.id, change.doc.data());
          }
        });
      },
      error
    );
  }
  // The guest creates the request first; only its authenticated host adds the offer.
  offer(id, guestId, offer, endpoints) {
    return setDoc(
      this.connection(id, guestId),
      {
        hostId: endpoints.offererId,
        guestId: endpoints.answererId,
        offer: { type: offer.type, sdp: offer.sdp },
      },
      { merge: true }
    );
  }
  clearSignal(id, guestId) {
    const key = id + '/' + guestId;
    if (!this.cleanups.has(key)) {
      const task = this.deleteSignal(id, guestId).finally(() => {
        if (this.cleanups.get(key) === task) this.cleanups.delete(key);
      });
      this.cleanups.set(key, task);
    }
    return this.cleanups.get(key);
  }
  async deleteSignal(id, guestId) {
    const existing = await getDocFromServer(this.connection(id, guestId));
    if (!existing.exists()) return;
    const refs = [];
    for (const side of ['hostCandidates', 'guestCandidates']) {
      const snapshot = await getDocs(
        collection(this.connection(id, guestId), side)
      );
      snapshot.forEach((candidate) => refs.push(candidate.ref));
    }
    refs.push(this.connection(id, guestId));
    for (let i = 0; i < refs.length; i += 400) {
      const batch = writeBatch(this.db);
      refs.slice(i, i + 400).forEach((ref) => batch.delete(ref));
      await batch.commit();
    }
  }
  async close(id) {
    await this.unpublish(id);
    const requests = await getDocs(
      query(
        collection(this.room(id), 'requests'),
        where('hostId', '==', this.auth.currentUser.uid)
      )
    );
    for (const request of requests.docs) await this.clearSignal(id, request.id);
  }
}
