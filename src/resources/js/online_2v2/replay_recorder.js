import { captureCheckpoint } from './checkpoint.js';
import { captureSnapshot } from './session.js';
import { setCustomRng } from '../offline_2v2/rand.js';
import {
  REPLAY_VERSION,
  ENGINE_ID,
  copy,
  packInputs,
  encodeReplay,
} from './replay_format.js';

export class ReplayRecorder {
  constructor(session) {
    this.session = session;
    this.pack = null;
    this.count = 0;
    this.signature = '';
    this.roomSignature = '';
  }
  sync() {
    const room = this.session.room;
    if (!room || room.closed || !room.data) return;
    if (!this.pack || this.pack.roomId !== room.id) {
      this.pack = {
        version: REPLAY_VERSION,
        engine: ENGINE_ID,
        roomId: room.id,
        createdAt: new Date().toISOString(),
        authoritative: room.isHost,
        complete: room.isHost,
        events: [],
      };
      this.count = 0;
      this.signature = this.roomSignature = '';
    }
    const data = {
      layout: room.data.layout,
      settings: room.data.settings,
      status: room.data.status,
      seats: room.data.seats,
      members: room.data.members,
    };
    const signature = JSON.stringify(data);
    if (signature !== this.roomSignature) {
      this.pack.events.push({ type: 'lobby', dt: 0, data: copy(data) });
      this.roomSignature = signature;
    }
  }
  boundary(force = false) {
    if (this.inFrame) return;
    this.sync();
    const s = this.session;
    if (!this.pack || !s.epoch || (!s.room.isHost && !s.lockstep)) return;
    const signature = JSON.stringify([
      s.epoch,
      s.settings,
      s.phase,
      s.game.players.map((player) => player.isComputer),
    ]);
    if (!force && this.signature === signature) return;
    this.signature = signature;
    this.pack.events.push({
      type: 'checkpoint',
      dt: 0,
      epoch: s.epoch,
      settings: copy(s.settings),
      members: copy(s.room.data.members),
      skins: s.skins ? copy(s.skins) : undefined,
      checkpoint: captureCheckpoint(s.game, s.inputs, s.rng),
      visual: captureSnapshot(
        s.game,
        s.epoch,
        Math.max(0, s.lastFrame),
        s.phase === 'idle' ? 'paused' : s.phase
      ),
    });
  }
  frame(advance) {
    this.boundary(this.count % 150 === 0);
    const s = this.session;
    if (!this.pack) return advance();
    const inputs = Array.from({ length: 4 }, () => ({
      xDirection: 0,
      yDirection: 0,
      powerHit: 0,
    }));
    const original = s.inputs.map((input) => input.getInput);
    const random = [];
    s.inputs.forEach((input, i) => {
      input.getInput = function () {
        original[i].call(this);
        inputs[i] = {
          xDirection: this.xDirection,
          yDirection: this.yDirection,
          powerHit: this.powerHit,
        };
      };
    });
    setCustomRng(() => {
      const value = s.rng ? s.rng() : Math.random();
      random.push(Math.floor(value * 32768));
      return value;
    });
    this.inFrame = true;
    try {
      advance();
    } finally {
      this.inFrame = false;
      s.inputs.forEach((input, i) => {
        input.getInput = original[i];
      });
      setCustomRng(null);
    }
    this.pack.events.push({
      type: 'step',
      dt: 1 / s.settings.fps,
      inputs: packInputs(inputs),
      random,
    });
    this.count++;
    if (s.phase === 'finished') this.boundary(true);
  }
  snapshot(packet) {
    this.sync();
    if (!this.pack || this.session.room.isHost || this.session.lockstep) return;
    const signature = JSON.stringify({ ...packet, frame: 0 });
    if (packet.phase !== 'playing' && signature === this.snapshotSignature)
      return;
    this.snapshotSignature = signature;
    this.pack.events.push({
      type: 'snapshot',
      skins: this.session.skins ? copy(this.session.skins) : undefined,
      dt: packet.phase === 'playing' ? 1 / this.session.settings.fps : 0,
      epoch: packet.epoch,
      settings: copy(this.session.settings),
      members: copy(this.session.room.data.members),
      visual: copy(packet),
    });
  }
  chat(packet) {
    this.sync();
    if (this.pack)
      this.pack.events.push({ type: 'chat', dt: 0, packet: copy(packet) });
  }
  end() {
    if (this.pack && this.session.epoch) {
      this.boundary();
      this.pack.events.push({ type: 'end', dt: 0, epoch: this.session.epoch });
      this.signature = '';
    }
  }
  text() {
    this.boundary();
    if (
      !this.pack ||
      !this.pack.events.some((event) =>
        ['step', 'snapshot'].includes(event.type)
      )
    )
      throw new Error('No replay frames have been recorded yet.');
    return encodeReplay(this.pack);
  }
}
