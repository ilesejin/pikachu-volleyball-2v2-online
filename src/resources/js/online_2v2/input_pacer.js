// Input scheduling only: simulation still advances exclusively from complete inputs.
const PREFIX = 'pacing-';
const BURST = 3;
export class InputPacer {
  constructor({
    epoch,
    selfId,
    hostId,
    members,
    send,
    sample,
    canSample = () => true,
    peers = () => [hostId],
    now = () => performance.now(),
    later = (fn, ms) => setTimeout(fn, ms),
    cancel = (timer) => clearTimeout(timer),
  }) {
    Object.assign(this, {
      epoch,
      selfId,
      hostId,
      members,
      send,
      sample,
      canSample,
      peers,
      now,
      later,
      cancel,
    });
    this.stopped = false;
    this.sequence = 0;
    this.pending = new Map();
    this.estimates = [];
    this.rtts = new Map();
    this.ahead = 2;
    this.offset = 0;
    this.generation = -1;
    this.ready = new Map();
    this.probes = new Map();
  }
  packet(type, fields = {}) {
    return { type: PREFIX + type, epoch: this.epoch, ...fields };
  }
  reset(generation, fps, paused) {
    this.cancel(this.timer);
    this.timer = null;
    this.startAt = null;
    this.generation = generation;
    this.period = 1000 / fps;
    this.paused = paused;
    this.ready.clear();
    if (this.selfId === this.hostId) {
      this.ready.set(this.selfId, 0);
      this.maybeStart();
    } else {
      if (!this.clockTimer) this.probe();
      this.announce();
    }
  }
  probe() {
    if (this.stopped) return;
    const now = this.now();
    for (const [seq, pending] of this.pending)
      if (now - pending.at > 5000) this.pending.delete(seq);
    for (const id of this.peers().filter((id) => id !== this.selfId)) {
      const count = (this.rtts.get(id)?.length || 0) < 3 ? 4 : 1;
      for (let i = 0; i < count; i++) {
        const seq = ++this.sequence;
        this.pending.set(seq, { at: now, id });
        this.send(id, this.packet('ping', { seq }));
      }
    }
    this.clockTimer = this.later(() => {
      this.clockTimer = null;
      this.probe();
    }, 2000);
  }
  announce() {
    if (this.stopped || this.paused || this.estimates.length < 3) return;
    const peers = this.peers().filter((id) => id !== this.selfId);
    if (!peers.every((id) => (this.rtts.get(id)?.length || 0) >= 3)) return;
    const rtt = Math.max(...peers.flatMap((id) => this.rtts.get(id)));
    this.send(
      this.hostId,
      this.packet('ready', { generation: this.generation, rtt })
    );
  }
  allowance() {
    return Math.min(
      2,
      Math.max(
        0,
        Math.ceil(Math.max(...this.ready.values()) / (2 * this.period)) - 1
      )
    );
  }
  maybeStart() {
    if (this.stopped || this.paused || this.startAt !== null) return;
    const ids = this.members();
    if (!ids.every((id) => this.ready.has(id))) return;
    const startAt =
      this.now() +
      Math.max(...ids.map((id) => this.ready.get(id))) +
      2 * this.period;
    for (const id of ids)
      if (id !== this.selfId)
        this.send(
          id,
          this.packet('start', {
            generation: this.generation,
            at: startAt,
            ahead: this.allowance(),
          })
        );
    this.schedule(startAt, this.allowance());
  }
  receive(id, message) {
    if (typeof message?.type !== 'string' || !message.type.startsWith(PREFIX))
      return false;
    if (
      this.stopped ||
      message.epoch !== this.epoch ||
      !this.members().includes(id)
    )
      return true;
    const now = this.now();
    if (message.type === PREFIX + 'ping') {
      const last = this.probes.get(id) || 0;
      if (
        Number.isSafeInteger(message.seq) &&
        message.seq > last &&
        message.seq <= last + 64
      ) {
        this.probes.set(id, message.seq);
        this.send(id, this.packet('pong', { seq: message.seq, at: now }));
      }
    } else if (message.type === PREFIX + 'pong') {
      const pending = this.pending.get(message.seq);
      if (
        !pending ||
        pending.id !== id ||
        !Number.isFinite(message.at) ||
        message.at < 0
      )
        return true;
      this.pending.delete(message.seq);
      const sent = pending.at;
      const rtt = now - sent;
      if (rtt < 0 || rtt > 5000) return true;
      const rtts = this.rtts.get(id) || [];
      rtts.push(rtt);
      if (rtts.length > 8) rtts.shift();
      this.rtts.set(id, rtts);
      if (id === this.hostId) {
        this.estimates.push({ rtt, offset: message.at - (sent + now) / 2 });
        if (this.estimates.length > 8) this.estimates.shift();
        const best = this.estimates.reduce((a, b) => (a.rtt <= b.rtt ? a : b));
        this.offset =
          this.startAt === null || this.paused
            ? best.offset
            : this.offset +
              Math.max(-1, Math.min(1, best.offset - this.offset));
      }
      this.announce();
    } else if (
      message.type === PREFIX + 'ready' &&
      this.selfId === this.hostId &&
      message.generation === this.generation
    ) {
      if (
        Number.isFinite(message.rtt) &&
        message.rtt >= 0 &&
        message.rtt <= 5000
      ) {
        this.ready.set(id, message.rtt);
        if (this.startAt !== null && this.allowance() !== this.ahead) {
          this.ahead = this.allowance();
          for (const peer of this.members())
            if (peer !== this.selfId)
              this.send(
                peer,
                this.packet('lead', {
                  generation: this.generation,
                  ahead: this.ahead,
                })
              );
        }
        this.maybeStart();
      }
    } else if (
      message.type === PREFIX + 'start' &&
      id === this.hostId &&
      message.generation === this.generation &&
      !this.paused &&
      this.estimates.length >= 3 &&
      this.startAt === null
    ) {
      const distance = message.at - (now + this.offset);
      if (
        Number.isFinite(distance) &&
        distance >= -1000 &&
        distance <= 6000 &&
        Number.isInteger(message.ahead) &&
        message.ahead >= 0 &&
        message.ahead <= 2
      )
        this.schedule(message.at, message.ahead);
    }
    if (
      message.type === PREFIX + 'lead' &&
      id === this.hostId &&
      message.generation === this.generation &&
      Number.isInteger(message.ahead) &&
      message.ahead >= 0 &&
      message.ahead <= 2
    )
      this.ahead = message.ahead;
    return true;
  }
  readyToSample() {
    return this.canSample(this.ahead);
  }
  schedule(at, ahead) {
    this.ahead = ahead;
    this.startAt = at;
    this.next = 0;
    this.arm();
  }
  arm() {
    if (this.stopped || this.paused || this.startAt === null) return;
    const clock = this.now() + (this.selfId === this.hostId ? 0 : this.offset);
    this.timer = this.later(
      () => this.wake(),
      Math.max(1, this.startAt + this.next * this.period - clock)
    );
  }
  wake() {
    this.timer = null;
    if (this.stopped || this.paused || this.startAt === null) return;
    const clock = this.now() + (this.selfId === this.hostId ? 0 : this.offset);
    const due = Math.floor((clock - this.startAt) / this.period);
    // Catch up bounded missed deadlines, rather than leaving one browser's
    // input frame numbers permanently behind after a scheduling hiccup.
    const count = Math.min(BURST, due - this.next + 1);
    for (let i = 0; i < count; i++) {
      if (!this.readyToSample()) break;
      this.sample();
    }
    if (count > 0) this.next = due + 1;
    this.arm();
  }
  stop() {
    this.stopped = true;
    this.cancel(this.timer);
    this.cancel(this.clockTimer);
    this.pending.clear();
    this.ready.clear();
  }
}
