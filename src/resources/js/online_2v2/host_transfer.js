// Lobby-only host handoff. Existing reliable host channels carry the barrier
// and commit; Firestore changes only the owner of the same rendezvous entry.
export class HostTransfer {
  constructor(room) {
    this.room = room;
  }
  validate(targetId) {
    const r = this.room;
    if (r.closed || !r.isHost)
      throw new Error('Only the host can transfer hosting.');
    if (r.data.status !== 'lobby' || r.rebuildingTarget !== null || r.handoff)
      throw new Error('Host transfer is only available in a ready lobby.');
    if (
      targetId === r.selfId ||
      !r.data.members[targetId] ||
      !r.connected(targetId) ||
      !r.ready() ||
      Array.from(r.peers.values()).some((peer) => peer.pendingAdmission)
    )
      throw new Error(
        'Wait for all players to connect before transferring host.'
      );
  }
  barrier(ids, token, phase, timeout = 60000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Host transfer timed out.')),
        timeout
      );
      this.wait = {
        token,
        phase,
        pending: new Set(ids),
        resolve,
        reject,
        timer,
      };
      if (!ids.length) resolve();
    }).finally(() => {
      clearTimeout(this.wait?.timer);
      this.wait = null;
    });
  }
  async perform(targetId) {
    this.validate(targetId);
    const r = this.room,
      token = crypto.randomUUID();
    const ids = Object.keys(r.data.members).filter((id) => id !== r.selfId);
    r.handoff = { token, targetId };
    r.emit('change', r.data);
    let committed = false;
    try {
      await r.callbacks.beforeHostTransfer?.();
      const prepared = this.barrier(ids, token, 'ready');
      r.broadcast({
        type: 'host-transfer-prepare',
        token,
        targetId,
        revision: r.data.networkRevision,
        replay: !!r.replay,
      });
      await prepared;
      if (r.closed || !ids.every((id) => r.connected(id)))
        throw new Error('A player disconnected during host transfer.');
      const data = JSON.parse(JSON.stringify(r.data));
      data.hostId = targetId;
      data.networkRevision++;
      data.stateVersion++;
      for (const [id, member] of Object.entries(data.members))
        member.connected = id === targetId;
      // Finish old-owner signal cleanup before guests reuse these document IDs
      // for connections to the new owner.
      await Promise.all(
        ids.map(async (id) => {
          const peer = r.peers.get(id);
          peer.signalCleaned = peer.signalingFinished = true;
          peer.unsubs.splice(0).forEach((unsubscribe) => unsubscribe());
          await peer.signalingWrites;
          await r.transport.clearSignal(r.id, peer.signalId);
        })
      );
      await r.transport.transferHost(r.id, targetId);
      committed = true;
      // Suppress normal disconnect handling while obsolete star links close.
      r.rebuildingTarget = data.networkRevision;
      const accepted = this.barrier(ids, token, 'committed', 12000);
      r.broadcast({ type: 'host-transfer-commit', token, data });
      // Once ownership commits, the old owner must adopt the new role even if
      // a participant disappears before acknowledging the commit.
      await accepted.catch(() => {});
      await r.adoptHostTransfer(data);
    } finally {
      if (!committed) r.broadcast({ type: 'host-transfer-cancel', token });
      if (!committed && r.handoff?.token === token) {
        r.handoff = null;
        r.emit('change', r.data);
      }
    }
    return r.data;
  }
  receive(id, message) {
    if (!message.type?.startsWith('host-transfer-')) return false;
    const r = this.room;
    if (
      message.type === 'host-transfer-ready' ||
      message.type === 'host-transfer-committed'
    ) {
      const w = this.wait;
      const phase =
        message.type === 'host-transfer-ready' ? 'ready' : 'committed';
      if (
        r.isHost &&
        w &&
        w.token === message.token &&
        w.phase === phase &&
        w.pending.has(id)
      ) {
        if (message.error)
          w.reject(new Error('Host transfer preparation failed.'));
        else {
          w.pending.delete(id);
          if (!w.pending.size) w.resolve();
        }
      }
      return true;
    }
    if (r.isHost || id !== r.data?.hostId) return true;
    if (message.type === 'host-transfer-prepare') {
      if (
        r.handoff ||
        r.data.status !== 'lobby' ||
        message.revision !== r.data.networkRevision ||
        typeof message.token !== 'string' ||
        message.token.length > 64 ||
        !r.data.members[message.targetId] ||
        message.targetId === id
      )
        return true;
      r.handoff = { token: message.token, targetId: message.targetId };
      r.emit('change', r.data);
      (async () => {
        try {
          if (message.targetId === r.selfId && message.replay) {
            if (!r.replay) throw new Error('Replay recording unavailable.');
            await r.replay.prepareTakeover();
          }
          if (!r.closed && r.handoff?.token === message.token)
            r.send(id, { type: 'host-transfer-ready', token: message.token });
        } catch (error) {
          r.send(id, {
            type: 'host-transfer-ready',
            token: message.token,
            error: true,
          });
        }
      })();
    } else if (r.handoff?.token === message.token) {
      if (message.type === 'host-transfer-cancel') {
        r.handoff = null;
        if (r.replay) r.replay.pendingTakeover = null;
        r.emit('change', r.data);
      } else if (message.type === 'host-transfer-commit') {
        const data = message.data;
        if (
          !data ||
          data.hostId !== r.handoff.targetId ||
          data.status !== 'lobby' ||
          data.networkRevision !== r.data.networkRevision + 1 ||
          JSON.stringify(Object.keys(data.members).sort()) !==
            JSON.stringify(Object.keys(r.data.members).sort())
        )
          return true;
        r.send(id, { type: 'host-transfer-committed', token: message.token });
        r.adoptHostTransfer(data).catch((error) => {
          r.fail(error);
          r.shutdown();
          r.emit('ended');
        });
      }
    }
    return true;
  }
  completeIfReady() {
    const r = this.room;
    if (
      r.handoff?.stage === 'reconnecting' &&
      r.ready() &&
      Object.values(r.data.members).every((member) => member.connected)
    ) {
      r.handoff = null;
      r.emit('hostTransferred');
    }
  }
  peerClosed(id) {
    if (this.room.handoff?.stage === 'reconnecting') this.room.handoff = null;
    if (this.wait?.pending.has(id))
      this.wait.reject(
        new Error('A player disconnected during host transfer.')
      );
  }
  close() {
    this.wait?.reject(new Error('The room has closed.'));
    this.room.handoff = null;
  }
}
