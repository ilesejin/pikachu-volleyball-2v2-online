import { normalizeInput } from './protocol.js';

// A small input pipeline hides a little jitter. Never predict a missing input.
export const INPUT_WINDOW = 3;
export class Lockstep {
  constructor({
    epoch,
    selfId,
    hostId,
    members,
    send,
    broadcast,
    advance,
    mesh = false,
  }) {
    Object.assign(this, {
      epoch,
      selfId,
      hostId,
      send,
      broadcast,
      advance,
      mesh,
    });
    this.future = new Map();
    this.members = new Map(
      Object.entries(members).map(([id, member]) => [id, member.slots.slice()])
    );
    this.frame = 0;
    this.sampled = 0;
    this.generation = 0;
    this.pending = new Map();
    this.latest = new Map();
    this.paused = false;
  }
  canSampleAhead(ahead) {
    if (!this.mesh) return true;
    const peers = [...this.members.keys()].filter((id) => id !== this.selfId);
    return (
      !peers.length ||
      this.sampled <=
        Math.min(...peers.map((id) => this.latest.get(id) ?? this.frame)) +
          ahead
    );
  }
  sample(values) {
    if (this.paused || this.sampled >= this.frame + INPUT_WINDOW) return;
    const packet = {
      type: 'frame-input',
      epoch: this.epoch,
      generation: this.generation,
      frame: ++this.sampled,
      inputs: values,
    };
    if (this.mesh) {
      this.broadcast(packet);
      this.receive(this.selfId, packet);
    } else if (this.selfId === this.hostId) this.receive(this.selfId, packet);
    else this.send(this.hostId, packet);
  }
  receive(id, packet) {
    // Control checkpoints and peer inputs travel on different reliable channels.
    // Retain a bounded amount of next-generation input until the host control arrives.
    if (
      this.mesh &&
      this.members.has(id) &&
      packet &&
      packet.type === 'frame-input' &&
      packet.epoch === this.epoch &&
      Number.isSafeInteger(packet.generation) &&
      packet.generation > this.generation &&
      Number.isSafeInteger(packet.frame) &&
      packet.frame >= 1 &&
      packet.frame <= this.frame + INPUT_WINDOW * 3
    ) {
      const key = id + ':' + packet.frame;
      if (
        (this.future.size < this.members.size * INPUT_WINDOW ||
          this.future.has(key)) &&
        (!this.future.has(key) ||
          this.future.get(key).packet.generation <= packet.generation)
      )
        this.future.set(key, { id, packet });
      return false;
    }
    if (
      !packet ||
      packet.epoch !== this.epoch ||
      packet.generation !== this.generation ||
      this.paused
    )
      return false;
    if (!this.mesh && this.selfId !== this.hostId) {
      if (
        id !== this.hostId ||
        packet.type !== 'frame' ||
        packet.frame !== this.frame + 1 ||
        !Array.isArray(packet.inputs) ||
        packet.inputs.length !== 4 ||
        !Array.isArray(packet.humans) ||
        new Set(packet.humans).size !== packet.humans.length ||
        !packet.humans.every(
          (slot) => Number.isInteger(slot) && slot >= 0 && slot < 4
        )
      )
        return false;
      this.frame = packet.frame;
      this.advance(
        packet.inputs.map(normalizeInput),
        packet.humans,
        this.frame
      );
      return true;
    }
    const slots = this.members.get(id);
    if (
      !slots ||
      packet.type !== 'frame-input' ||
      !Number.isSafeInteger(packet.frame) ||
      packet.frame <= this.frame ||
      packet.frame > this.frame + INPUT_WINDOW * (this.mesh ? 2 : 1) ||
      !Array.isArray(packet.inputs) ||
      packet.inputs.length !== slots.length ||
      new Set(packet.inputs.map((input) => input && input.slot)).size !==
        slots.length ||
      !packet.inputs.every((input) => input && slots.includes(input.slot))
    )
      return false;
    let entries = this.pending.get(packet.frame);
    if (!entries) this.pending.set(packet.frame, (entries = new Map()));
    if (entries.has(id)) return false;
    entries.set(
      id,
      packet.inputs.map((input) => ({
        slot: input.slot,
        ...normalizeInput(input),
      }))
    );
    this.latest.set(id, Math.max(this.latest.get(id) || 0, packet.frame));
    this.drain();
    return true;
  }
  drain() {
    while (!this.paused) {
      const entries = this.pending.get(this.frame + 1);
      if (!entries || ![...this.members.keys()].every((id) => entries.has(id)))
        return;
      const inputs = Array.from({ length: 4 }, () => normalizeInput(null));
      const humans = [];
      for (const [id, slots] of this.members) {
        humans.push(...slots);
        entries.get(id).forEach((input) => {
          inputs[input.slot] = normalizeInput(input);
        });
      }
      this.pending.delete(this.frame + 1);
      const packet = {
        type: 'frame',
        epoch: this.epoch,
        generation: this.generation,
        frame: ++this.frame,
        inputs,
        humans,
      };
      if (!this.mesh) this.broadcast(packet);
      this.advance(inputs, humans, this.frame);
    }
  }
  flushFuture() {
    const packets = [...this.future.values()];
    this.future.clear();
    packets.forEach(({ id, packet }) => this.receive(id, packet));
  }
  remove(id) {
    this.members.delete(id);
    this.drain();
  }
  control(generation, paused) {
    if (
      !Number.isSafeInteger(generation) ||
      generation <= this.generation ||
      typeof paused !== 'boolean'
    )
      return false;
    this.generation = generation;
    this.paused = paused;
    this.pending.clear();
    this.sampled = this.frame;
    this.latest.clear();
    return true;
  }
}
