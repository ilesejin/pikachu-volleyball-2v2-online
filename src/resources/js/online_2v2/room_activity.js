// Room counts are independent of matchmaking, WebRTC frames, and Firestore.
export class RoomActivity {
  constructor({
    room,
    report,
    read,
    changed = () => {},
    visible = () => !document.hidden,
    now = Date.now,
    every = (callback, ms) => setInterval(callback, ms),
    clear = (timer) => clearInterval(timer),
  }) {
    Object.assign(this, {
      room,
      report,
      read,
      changed,
      visible,
      now,
      every,
      clear,
    });
    this.tail = Promise.resolve();
    this.desired = undefined;
    this.revision = 0;
    this.shared = null;
    this.sent = undefined;
    this.reported = false;
    this.running = false;
    this.wasClosed = room.closed;
  }
  packet() {
    const room = this.room;
    if (
      room.closed ||
      !room.isHost ||
      room.handoff ||
      !room.data ||
      !['lobby', 'playing'].includes(room.data.status)
    )
      return null;
    return {
      active: true,
      roomId: room.id,
      visibility: room.data.visibility || 'private',
      status: room.data.status,
    };
  }
  start() {
    if (this.running) return;
    this.running = true;
    this.reportTimer = this.every(() => this.sync(true), 30000);
    this.statsTimer = this.every(() => this.refresh(), 60000);
    this.reportTimer.unref?.();
    this.statsTimer.unref?.();
    this.sync();
    this.refresh();
  }
  sync(force = false) {
    if (!this.running) return this.tail;
    const closed = this.room.closed;
    if (closed && !this.wasClosed) this.refresh();
    this.wasClosed = closed;
    const desired = JSON.stringify(this.packet());
    if (!force && desired === this.desired) return this.tail;
    if (desired !== this.desired) this.revision++;
    this.desired = desired;
    this.tail = this.tail.then(async () => {
      if (!this.running) return;
      // Read the latest state after earlier requests settle. A late public report
      // must not overwrite a subsequent privacy/leave/host-transfer update.
      const packet = this.packet(),
        signature = JSON.stringify(packet);
      const shared =
        packet &&
        packet.visibility === 'public' &&
        packet.status === 'lobby' &&
        this.shared?.signature === signature &&
        this.shared.revision === this.revision &&
        this.now() - this.shared.at < 15000;
      if (
        shared ||
        (!force && signature === this.sent) ||
        (!packet && !this.reported)
      )
        return;
      this.reported = true; // Also cancel a report whose response was lost.
      try {
        await this.report({
          ...(packet || { active: false }),
          revision: this.revision,
        });
        this.sent = signature;
        this.reported = !!packet;
      } catch {
        this.sent = undefined; // Retry on the next heartbeat; never interrupt play.
      }
    });
    return this.tail;
  }
  publicationRevision(body) {
    if (!this.running) return undefined;
    this.sync();
    const packet = this.packet();
    return packet &&
      packet.roomId === body.roomId &&
      packet.visibility === 'public' &&
      packet.status === 'lobby' &&
      body.visibility === 'public' &&
      body.status === 'lobby'
      ? this.revision
      : undefined;
  }
  published(body, result, revision) {
    if (
      !this.running ||
      result.activityRecorded !== true ||
      revision !== this.revision
    )
      return;
    const packet = this.packet();
    if (
      !packet ||
      packet.roomId !== body.roomId ||
      packet.visibility !== 'public' ||
      packet.status !== 'lobby'
    )
      return;
    const signature = JSON.stringify(packet);
    this.shared = { signature, revision, at: this.now() };
    this.sent = signature;
    this.reported = true;
  }
  refresh() {
    if (!this.running || !this.visible() || !this.room.closed)
      return Promise.resolve();
    if (this.reading) return this.reading;
    this.reading = (async () => {
      await Promise.resolve();
      try {
        const counts = await this.read();
        if (
          !counts ||
          !['active', 'publicWaiting', 'publicPlaying'].every(
            (key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0
          ) ||
          counts.publicWaiting + counts.publicPlaying > counts.active
        )
          throw Error('Invalid room statistics.');
        if (this.running && this.visible() && this.room.closed)
          this.changed(counts);
      } catch {
        if (this.running && this.visible() && this.room.closed)
          this.changed(null);
      } finally {
        this.reading = null;
      }
    })();
    return this.reading;
  }
  stop() {
    this.running = false;
    const revision = ++this.revision;
    this.clear(this.reportTimer);
    this.clear(this.statsTimer);
    this.tail = this.tail.then(async () => {
      if (!this.reported) return;
      try {
        await this.report({ active: false, revision }, { keepalive: true });
      } catch {}
      this.reported = false;
    });
    return this.tail;
  }
}

export function activityTransport(base, token, fetcher = fetch) {
  const url = base.replace(/\/$/, '') + '/v2/rooms/';
  async function responseJSON(response) {
    if (!response.ok) throw Error('Room statistics unavailable.');
    return response.json();
  }
  return {
    read: async () =>
      responseJSON(
        await fetcher(url + 'stats', {
          cache: 'no-store',
          signal: AbortSignal.timeout(10000),
        })
      ),
    report: async (body, options = {}) => {
      const idToken = await token();
      return responseJSON(
        await fetcher(url + 'activity', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + idToken,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10000),
          keepalive: !!options.keepalive,
        })
      );
    },
  };
}
