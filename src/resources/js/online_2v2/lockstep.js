import { normalizeInput } from './protocol.js';

// A small input pipeline hides a little jitter. Never predict a missing input.
export const INPUT_WINDOW = 3;
export class Lockstep {
  constructor({ epoch, selfId, hostId, members, send, broadcast, advance }) {
    Object.assign(this, { epoch, selfId, hostId, send, broadcast, advance });
    this.members = new Map(
      Object.entries(members).map(([id, member]) => [id, member.slots.slice()])
    );
    this.frame = 0;
    this.sampled = 0;
    this.generation = 0;
    this.pending = new Map();
    this.paused = false;
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
    if (this.selfId === this.hostId) this.receive(this.selfId, packet);
    else this.send(this.hostId, packet);
  }
  receive(id, packet) {
    if (
      !packet ||
      packet.epoch !== this.epoch ||
      packet.generation !== this.generation ||
      this.paused
    )
      return false;
    if (this.selfId !== this.hostId) {
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
      packet.frame > this.frame + INPUT_WINDOW ||
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
      this.broadcast(packet);
      this.advance(inputs, humans, this.frame);
    }
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
    return true;
  }
}
