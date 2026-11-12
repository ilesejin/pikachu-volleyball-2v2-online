import { requiredPeers } from './protocol.js';

const TYPES = ['diag-ping', 'diag-pong', 'diag-report', 'diag-summary'];
const ROUTES = ['direct', 'turn', 'unknown'];
const finite = (value) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 60000;

// Observers only. No simulation state, seeded randomness, or replay events are changed.
export class NetworkDiagnostics {
  constructor(
    room,
    session,
    { now = () => performance.now(), changed = () => {} } = {}
  ) {
    Object.assign(this, { room, session, now, changed });
    this.links = new Map();
    this.reports = new Map();
    this.sequence = 0;
    this.context = null;
    this.summary = [];
    this.summaryAt = -Infinity;
    this.nextReport = 0;
    this.nextRender = 0;
    this.wait = null;
  }
  start() {
    if (!this.timer) this.timer = setInterval(() => this.tick(), 100);
  }
  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.clear();
  }
  clear() {
    this.links.clear();
    this.reports.clear();
    this.context = null;
    this.summary = [];
    this.summaryAt = -Infinity;
    this.nextReport = 0;
    this.wait = null;
  }
  member(id) {
    return Object.prototype.hasOwnProperty.call(this.room.data.members, id);
  }
  sync() {
    const room = this.room;
    const context =
      room.closed || !room.data || room.joinDetails
        ? null
        : room.id + ':' + room.data.networkRevision;
    if (context !== this.context) {
      this.clear();
      this.context = context;
    }
    if (!context) return false;
    for (const id of this.reports.keys())
      if (!this.member(id)) this.reports.delete(id);
    for (const [id, link] of this.links)
      if (
        !room.data.members[id] ||
        room.peers.get(id) !== link.peer ||
        !room.connected(id)
      )
        this.links.delete(id);
    for (const id of Object.keys(room.data.members)) {
      if (id === room.selfId || !room.connected(id)) continue;
      const peer = room.peers.get(id);
      if (!this.links.has(id))
        this.links.set(id, {
          peer,
          samples: [],
          pending: new Map(),
          sent: 0,
          nextProbe: 0,
          lastSample: -Infinity,
          lastTimeout: -Infinity,
          route: 'unknown',
          protocol: 'unknown',
          nextStats: 0,
          statsBusy: false,
          lastReply: -Infinity,
        });
    }
    return true;
  }
  tick() {
    const active = this.sync(),
      now = this.now();
    if (active) {
      for (const [id, link] of this.links) {
        for (const [seq, sent] of link.pending)
          if (now - sent >= 5000) {
            link.pending.delete(seq);
            link.lastTimeout = Math.max(link.lastTimeout, sent);
          }
        if (now >= link.nextProbe) {
          link.nextProbe = now + (link.sent < 4 ? 1000 : 2000);
          if (
            link.peer.channel.bufferedAmount <= 16384 &&
            link.pending.size < 5
          ) {
            const seq = ++this.sequence;
            if (
              this.room.send(
                id,
                {
                  type: 'diag-ping',
                  revision: this.room.data.networkRevision,
                  seq,
                },
                true
              )
            ) {
              link.pending.set(seq, now);
              link.sent++;
            }
          }
        }
        if (now >= link.nextStats && !link.statsBusy) this.readStats(id, link);
      }
      if (
        now >= this.nextReport &&
        this.localLinks().some((link) => link.count)
      ) {
        this.nextReport = now + 5000;
        const links = this.localLinks();
        if (this.room.isHost) {
          this.reports.set(this.room.selfId, { links, at: now });
          const rows = this.aggregate();
          this.room.broadcast(
            {
              type: 'diag-summary',
              revision: this.room.data.networkRevision,
              rows,
            },
            true
          );
        } else
          this.room.send(
            this.room.data.hostId,
            {
              type: 'diag-report',
              revision: this.room.data.networkRevision,
              links,
            },
            true
          );
      }
      this.observeWait();
    } else this.wait = null;
    if (now >= this.nextRender) {
      this.nextRender = now + 500;
      this.changed(this.snapshot());
    }
  }
  readStats(id, link) {
    link.nextStats = this.now() + 5000;
    link.statsBusy = true;
    Promise.resolve()
      .then(() => link.peer.pc.getStats())
      .then((stats) => {
        if (this.links.get(id) !== link) return;
        let pair;
        stats.forEach((report) => {
          if (report.type === 'transport' && report.selectedCandidatePairId)
            pair = stats.get(report.selectedCandidatePairId);
        });
        if (!pair)
          stats.forEach((report) => {
            if (report.type === 'candidate-pair' && report.selected === true)
              pair = report;
          });
        const local = pair && stats.get(pair.localCandidateId),
          remote = pair && stats.get(pair.remoteCandidateId);
        link.route =
          local?.candidateType === 'relay' || remote?.candidateType === 'relay'
            ? 'turn'
            : local &&
              remote &&
              ['host', 'srflx', 'prflx'].includes(local.candidateType) &&
              ['host', 'srflx', 'prflx'].includes(remote.candidateType)
            ? 'direct'
            : 'unknown';
        link.protocol = ['udp', 'tcp'].includes(local?.protocol)
          ? local.protocol
          : 'unknown';
      })
      .catch(() => {
        if (this.links.get(id) === link) {
          link.route = 'unknown';
          link.protocol = 'unknown';
        }
      })
      .finally(() => {
        link.statsBusy = false;
      });
  }
  localLinks() {
    const now = this.now();
    return [...this.links].map(([peerId, link]) => {
      const samples = link.samples;
      return {
        peerId,
        average: samples.length
          ? samples.reduce((a, b) => a + b, 0) / samples.length
          : null,
        low: samples.length ? Math.min(...samples) : null,
        high: samples.length ? Math.max(...samples) : null,
        count: samples.length,
        age: samples.length ? Math.min(60000, now - link.lastSample) : null,
        noResponse: link.lastTimeout > link.lastSample,
        route: link.route,
        protocol: link.protocol,
      };
    });
  }
  validLink(value) {
    return (
      !!value &&
      Object.keys(value).every((key) =>
        [
          'peerId',
          'average',
          'low',
          'high',
          'count',
          'age',
          'noResponse',
          'route',
          'protocol',
          'source',
        ].includes(key)
      ) &&
      typeof value.peerId === 'string' &&
      this.member(value.peerId) &&
      Number.isInteger(value.count) &&
      value.count >= 0 &&
      value.count <= 10 &&
      (value.count === 0
        ? value.average === null &&
          value.low === null &&
          value.high === null &&
          value.age === null
        : finite(value.average) &&
          finite(value.low) &&
          finite(value.high) &&
          value.low <= value.average &&
          value.average <= value.high &&
          finite(value.age)) &&
      typeof value.noResponse === 'boolean' &&
      ROUTES.includes(value.route) &&
      ['udp', 'tcp', 'unknown'].includes(value.protocol)
    );
  }
  receive(id, message) {
    if (!TYPES.includes(message.type)) return false;
    if (
      !this.sync() ||
      !this.member(id) ||
      !this.room.connected(id) ||
      message.revision !== this.room.data.networkRevision
    )
      return true;
    const now = this.now(),
      link = this.links.get(id);
    if (message.type === 'diag-ping') {
      if (
        Number.isSafeInteger(message.seq) &&
        message.seq > 0 &&
        link &&
        now - link.lastReply >= 250
      ) {
        link.lastReply = now;
        if (link.peer.channel.bufferedAmount <= 16384)
          this.room.send(
            id,
            { type: 'diag-pong', revision: message.revision, seq: message.seq },
            true
          );
      }
    } else if (message.type === 'diag-pong') {
      const sent = link?.pending.get(message.seq);
      if (sent !== undefined) {
        link.pending.delete(message.seq);
        const value = now - sent;
        if (value >= 0 && value < 5000) {
          link.samples.push(value);
          if (link.samples.length > 10) link.samples.shift();
          link.lastSample = now;
          if (link.samples.length === 1) this.nextReport = 0;
        }
      }
    } else if (message.type === 'diag-report') {
      if (
        !this.room.isHost ||
        !Array.isArray(message.links) ||
        message.links.length > 3
      )
        return true;
      const wanted = requiredPeers(this.room.data, id);
      if (
        !message.links.every(
          (value) => this.validLink(value) && wanted.includes(value.peerId)
        ) ||
        new Set(message.links.map((x) => x.peerId)).size !==
          message.links.length
      )
        return true;
      if (now - (this.reports.get(id)?.at ?? -Infinity) < 1000) return true;
      this.reports.set(id, { links: message.links, at: now });
    } else if (message.type === 'diag-summary') {
      if (
        this.room.isHost ||
        id !== this.room.data.hostId ||
        !Array.isArray(message.rows) ||
        message.rows.length > 6
      )
        return true;
      if (
        !message.rows.every(
          (value) =>
            this.validLink(value) &&
            typeof value.source === 'string' &&
            this.member(value.source) &&
            requiredPeers(this.room.data, value.source).includes(value.peerId)
        ) ||
        new Set(
          message.rows.map((row) => [row.source, row.peerId].sort().join(':'))
        ).size !== message.rows.length
      )
        return true;
      if (now - this.summaryAt < 1000) return true;
      this.summary = message.rows;
      this.summaryAt = now;
    }
    return true;
  }
  aggregate() {
    const now = this.now(),
      room = this.room,
      rows = new Map();
    const reports = new Map(this.reports);
    reports.set(room.selfId, { links: this.localLinks(), at: now });
    for (const [source, report] of reports) {
      if (!room.data.members[source] || now - report.at > 10000) continue;
      for (const value of report.links) {
        if (
          !room.data.members[value.peerId] ||
          !requiredPeers(room.data, source).includes(value.peerId)
        )
          continue;
        const row = {
          ...value,
          source,
          age:
            value.age === null
              ? null
              : Math.min(60000, value.age + now - report.at),
        };
        const key = [source, row.peerId].sort().join(':');
        const previous = rows.get(key);
        const fresh = row.age !== null && row.age < 10000 && !row.noResponse;
        const previousFresh =
          previous &&
          previous.age !== null &&
          previous.age < 10000 &&
          !previous.noResponse;
        if (
          !previous ||
          (!previousFresh && fresh) ||
          (fresh === previousFresh &&
            (row.average ?? -1) > (previous.average ?? -1))
        )
          rows.set(key, row);
      }
    }
    return [...rows.values()];
  }
  observeWait() {
    const s = this.session,
      d = s.lockstep,
      now = this.now();
    if (!d || d.paused || s.phase !== 'playing' || d.sampled <= d.frame) {
      this.wait = null;
      return;
    }
    const key = s.epoch + ':' + d.generation + ':' + d.frame;
    let peers;
    if (!d.mesh && this.room.selfId !== this.room.data.hostId)
      peers = [this.room.data.hostId];
    else {
      const entries = d.pending.get(d.frame + 1);
      peers = [...d.members.keys()].filter((id) => !entries?.has(id));
    }
    if (!peers.length) {
      this.wait = null;
      return;
    }
    if (this.wait?.key !== key)
      this.wait = {
        key,
        since: now,
        peers,
        hostFrame: !d.mesh && this.room.selfId !== this.room.data.hostId,
      };
    this.wait.peers = peers;
  }
  snapshot() {
    const room = this.room,
      now = this.now();
    if (room.closed || !room.data || room.joinDetails)
      return { active: false, rows: [], wait: null };
    let rows = room.isHost
      ? this.aggregate()
      : this.summary
          .filter(() => now - this.summaryAt < 10000)
          .map((row) => ({
            ...row,
            age:
              row.age === null
                ? null
                : Math.min(60000, row.age + now - this.summaryAt),
          }));
    const local = this.localLinks().map((row) => ({
      ...row,
      source: room.selfId,
    }));
    // The current browser's own probe is fresher than a relayed summary of it.
    const map = new Map(
      rows.map((row) => [[row.source, row.peerId].sort().join(':'), row])
    );
    local.forEach((row) => {
      const key = [row.source, row.peerId].sort().join(':');
      const previous = map.get(key);
      if (!previous || (row.count && (row.age < 10000 || !previous.count)))
        map.set(key, row);
    });
    rows = [...map.values()].filter(
      (row) => room.data.members[row.source] && room.data.members[row.peerId]
    );
    const lockstep =
      (this.session.epoch ? this.session.settings : room.data.settings)
        .synchronization === 'lockstep';
    const mesh =
      room.data.layout === 'four' && room.data.settings.topology === 'mesh';
    rows = rows.map((row) => ({
      ...row,
      used:
        (lockstep && mesh) ||
        row.source === room.data.hostId ||
        row.peerId === room.data.hostId,
    }));
    const relevant = rows.filter(
      (row) =>
        row.used && row.age !== null && row.age < 10000 && !row.noResponse
    );
    const average = relevant.length
      ? Math.max(...relevant.map((row) => row.average))
      : null;
    const participants = Object.keys(room.data.members).length;
    const expected =
      lockstep && mesh
        ? (participants * (participants - 1)) / 2
        : participants - 1;
    const unavailable = Math.max(0, expected - relevant.length);
    const elapsed = this.wait
      ? Math.max(
          0,
          now - this.wait.since - 1000 / (this.session.settings?.fps || 30)
        )
      : 0;
    const wait =
      elapsed >= 100
        ? {
            milliseconds: elapsed,
            peers: this.wait.peers,
            hostFrame: this.wait.hostFrame,
          }
        : null;
    return {
      active: true,
      rows,
      average,
      unavailable,
      expected,
      wait,
      mesh,
      lockstep,
      pairs: room.data.layout === 'pairs',
    };
  }
}
