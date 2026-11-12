// Reliable host-relayed setup for guest-to-guest links; never accesses Firestore.
export class RelaySignaling {
  constructor(room) {
    this.room = room;
    this.entries = new Map();
  }
  entry(key) {
    if (!this.entries.has(key))
      this.entries.set(key, {
        data: {},
        candidates: {},
        signals: new Set(),
        listeners: {},
      });
    return this.entries.get(key);
  }
  send(key, kind, value) {
    const ids = key.split('~').slice(1);
    const target = ids.find((id) => id !== this.room.selfId);
    if (
      !this.room.send(this.room.data.hostId, {
        type: 'mesh-signal',
        revision: this.room.data.networkRevision,
        target,
        key,
        kind,
        value,
      })
    )
      throw new Error('The host connection is unavailable.');
    return Promise.resolve();
  }
  offer(id, key, offer) {
    return this.send(key, 'offer', { type: offer.type, sdp: offer.sdp });
  }
  answer(id, key, answer) {
    return this.send(key, 'answer', { type: answer.type, sdp: answer.sdp });
  }
  candidate(id, key, side, candidate) {
    return this.send(key, side, candidate);
  }
  watchSignal(id, key, receive) {
    const entry = this.entry(key);
    entry.signals.add(receive);
    receive(entry.data);
    return () => entry.signals.delete(receive);
  }
  watchCandidates(id, key, side, receive) {
    const entry = this.entry(key);
    (entry.listeners[side] ||= new Set()).add(receive);
    for (const candidate of entry.candidates[side] || []) receive(candidate);
    return () => entry.listeners[side].delete(receive);
  }
  receive(id, message) {
    if (message.type !== 'mesh-signal') return false;
    const room = this.room,
      data = room.data;
    if (
      !data ||
      message.revision !== data.networkRevision ||
      !['offer', 'answer', 'hostCandidates', 'guestCandidates'].includes(
        message.kind
      )
    )
      return true;
    if (room.isHost) {
      const target = message.target;
      if (
        id !== data.hostId &&
        target !== data.hostId &&
        id !== target &&
        data.members[id] &&
        data.members[target] &&
        data.layout === 'four' &&
        data.settings.topology === 'mesh' &&
        message.key === [data.networkRevision, ...[id, target].sort()].join('~')
      )
        room.send(target, { ...message, sender: id });
    } else if (
      id === data.hostId &&
      message.target === room.selfId &&
      data.members[message.sender] &&
      message.sender !== data.hostId &&
      message.key ===
        [data.networkRevision, ...[message.sender, room.selfId].sort()].join(
          '~'
        )
    ) {
      const parts = message.key.split('~');
      const offerer = parts[1];
      const expected = ['offer', 'hostCandidates'].includes(message.kind)
        ? offerer
        : parts[2];
      if (message.sender !== expected) return true;
      const entry = this.entry(message.key);
      if (message.kind === 'offer' || message.kind === 'answer') {
        entry.data[message.kind] = message.value;
        for (const receive of entry.signals) receive(entry.data);
      } else {
        const candidates = (entry.candidates[message.kind] ||= []);
        if (candidates.length >= 100) return true;
        candidates.push(message.value);
        for (const receive of entry.listeners[message.kind] || [])
          receive(message.value);
      }
    }
    return true;
  }
  clear() {
    this.entries.clear();
  }
}
