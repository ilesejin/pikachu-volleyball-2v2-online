export class RoomChat {
  constructor(
    room,
    display,
    now = Date.now,
    random = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296
  ) {
    this.room = room;
    this.display = display;
    this.now = now;
    this.random = random;
    this.enabled = true;
    this.roomId = null;
    this.sequence = 0;
    this.lastSequence = 0;
    this.lastSent = new Map();
  }
  reset() {
    this.roomId = this.room.id;
    this.hostId = this.room.data?.hostId;
    this.sequence = this.lastSequence = 0;
    this.lastSent.clear();
  }
  sync() {
    if (this.roomId !== this.room.id) this.reset();
    if (this.hostId !== this.room.data?.hostId) {
      this.sequence = this.lastSequence = Math.max(
        this.sequence,
        this.lastSequence
      );
      this.hostId = this.room.data?.hostId;
    }
  }
  text(value) {
    return typeof value === 'string' &&
      value.trim().length > 0 &&
      value.length <= 50
      ? value.trim()
      : null;
  }
  send(text, speaker = 0) {
    this.sync();
    if (this.room.closed || this.room.handoff || !this.enabled) return false;
    text = this.text(text);
    if (!text) return false;
    if (this.room.isHost) return this.relay(this.room.selfId, text, speaker);
    return this.room.send(this.room.data.hostId, {
      type: 'chat',
      text,
      speaker,
    });
  }
  relay(id, text, speaker = 0) {
    if (this.room.handoff) return false;
    const member = this.room.data.members[id];
    if (!member) return false;
    const names = member.names || [member.name];
    if (!Number.isInteger(speaker) || speaker < 0 || speaker >= names.length)
      return false;
    const slots = member.slots.length ? [member.slots[speaker]] : [];
    const now = this.now();
    if (this.lastSent.has(id) && now - this.lastSent.get(id) < 500)
      return false;
    this.lastSent.set(id, now);
    const packet = {
      type: 'chat-message',
      roomId: this.room.id,
      seq: ++this.sequence,
      sender: id,
      name: names[speaker],
      speaker,
      slots,
      text,
      position: {
        top: 20 + 30 * this.random(),
        offset: 55 + 25 * this.random(),
        side: slots.length ? (slots[0] < 2 ? 'left' : 'right') : 'unassigned',
        ...(this.room.data.layout === 'four' && slots.length
          ? { area: slots[0] }
          : {}),
      },
    };
    if (this.room.replay) this.room.replay.chat(packet);
    this.room.broadcast(packet);
    if (this.enabled) this.display(packet);
    return true;
  }
  receive(id, packet) {
    if (!packet || !['chat', 'chat-message'].includes(packet.type))
      return false;
    this.sync();
    if (this.room.closed) return true;
    if (this.room.isHost) {
      if (packet.type === 'chat') {
        const text = this.text(packet.text);
        if (text)
          this.relay(
            id,
            text,
            packet.speaker === undefined ? 0 : packet.speaker
          );
      }
    } else if (
      id === this.room.data.hostId &&
      packet.type === 'chat-message' &&
      packet.roomId === this.room.id &&
      Number.isSafeInteger(packet.seq) &&
      packet.seq > this.lastSequence &&
      this.text(packet.text) &&
      packet.position &&
      Number.isFinite(packet.position.top) &&
      packet.position.top >= 20 &&
      packet.position.top <= 50 &&
      Number.isFinite(packet.position.offset) &&
      packet.position.offset >= 55 &&
      packet.position.offset <= 80 &&
      ['left', 'right', 'unassigned'].includes(packet.position.side) &&
      typeof packet.sender === 'string' &&
      packet.sender.length <= 128 &&
      typeof packet.name === 'string' &&
      packet.name.length <= 24 &&
      Array.isArray(packet.slots) &&
      packet.slots.length >= 0 &&
      packet.slots.length <= 1 &&
      packet.slots.every(
        (slot) => Number.isInteger(slot) && slot >= 0 && slot < 4
      ) &&
      (packet.position.area === undefined ||
        (this.room.data.layout === 'four' &&
          Number.isInteger(packet.position.area) &&
          packet.position.area >= 0 &&
          packet.position.area < 4 &&
          packet.slots.length === 1 &&
          packet.position.area === packet.slots[0] &&
          packet.position.side ===
            (packet.position.area < 2 ? 'left' : 'right')))
    ) {
      this.lastSequence = packet.seq;
      if (this.room.replay) this.room.replay.chat(packet);
      if (this.enabled) this.display(packet);
    }
    return true;
  }
}
