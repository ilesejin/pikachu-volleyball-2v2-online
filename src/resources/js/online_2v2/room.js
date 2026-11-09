import { FirebaseRoomStore } from './firebase_store.js';
import { rtcConfiguration } from '../data_channel/rtc_configuration.js';
import {
  ROOM_SCHEMA,
  usesMesh,
  requiredPeers,
  connectionKey,
} from './protocol.js';

export function randomId() {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(
    bytes,
    (byte) => 'abcdefghijklmnopqrstuvwxyz0123456789'[byte % 36]
  ).join('');
}

export class OnlineRoom {
  constructor(callbacks = {}, store = new FirebaseRoomStore()) {
    this.store = store;
    this.callbacks = callbacks;
    this.selfId = randomId();
    this.id = null;
    this.data = null;
    this.isHost = false;
    this.peers = new Map();
    this.departed = new Set();
    this.closed = true;
    this.readyReports = new Map();
    this.readyWrites = new Map();
    this.readyTasks = new Map();
    this.networkFault = false;
    this.rebuildingTarget = null;
  }
  emit(name, ...args) {
    if (this.callbacks[name]) this.callbacks[name](...args);
  }
  fail(error) {
    if (!this.closed) this.emit('error', error);
  }
  async create(name, layout, slots, settings) {
    if (!this.closed) throw new Error('Leave the current room first.');
    if (this.store.identity) this.selfId = await this.store.identity();
    this.departed.clear();
    this.closed = false;
    this.isHost = true;
    this.id = randomId();
    try {
      this.data = await this.store.create(
        this.id,
        this.selfId,
        name,
        layout,
        slots,
        settings
      );
      this.subscribe();
      return this.id;
    } catch (error) {
      this.closed = true;
      throw error;
    }
  }
  async join(id, name, slots) {
    if (!this.closed) throw new Error('Leave the current room first.');
    if (!/^[a-z0-9]{20}$/.test(id))
      throw new Error('Enter a valid 20-character room ID.');
    if (this.store.identity) this.selfId = await this.store.identity();
    this.departed.clear();
    this.closed = false;
    this.isHost = false;
    this.id = id;
    try {
      this.data = await this.store.claim(id, this.selfId, name, slots);
      this.subscribe();
    } catch (error) {
      this.closed = true;
      throw error;
    }
  }
  subscribe() {
    const watchedRoomId = this.id;
    clearInterval(this.reportTimer);
    this.reportTimer = setInterval(() => {
      if (!this.closed && this.id === watchedRoomId) this.reportReady();
    }, 1000);
    this.unsubscribe = this.store.watch(
      this.id,
      (data) => {
        if (this.closed || this.id !== watchedRoomId) return;
        if (
          !data ||
          data.schema !== ROOM_SCHEMA ||
          data.status === 'closed' ||
          !data.members ||
          !data.members[this.selfId]
        ) {
          this.shutdown();
          this.emit('ended');
          return;
        }
        this.acceptData(data);
      },
      (error) => this.fail(error)
    );
  }
  acceptData(data) {
    if (this.data && data.networkRevision < this.data.networkRevision) return;
    const reset =
      this.data && data.networkRevision !== this.data.networkRevision;
    this.data = data;
    if (reset) {
      this.peers.forEach((peer, id) => this.dropPeer(id));
      this.readyReports.clear();
      this.readyWrites.clear();
      this.networkFault = false;
      this.rebuildingTarget = null;
      clearTimeout(this.rebuildTimer);
      this.emit('networkReset');
    }
    const wanted = requiredPeers(data, this.selfId);
    this.peers.forEach((peer, id) => {
      if (!wanted.includes(id)) this.dropPeer(id);
    });
    for (const id of wanted) {
      if (this.peers.has(id) || this.departed.has(id)) continue;
      const offerer =
        this.selfId === data.hostId || (id !== data.hostId && this.selfId < id);
      const revision = data.networkRevision;
      this.makePeer(id, offerer).catch((error) => {
        if (!this.closed && this.data.networkRevision === revision)
          this.fail(error);
      });
    }
    this.reportReady();
    this.emit('change', data);
  }
  ready() {
    if (
      this.closed ||
      !this.data ||
      this.networkFault ||
      this.rebuildingTarget !== null
    )
      return false;
    if (
      !requiredPeers(this.data, this.selfId).every((id) => this.connected(id))
    )
      return false;
    if (!this.isHost) return true;
    return Object.keys(this.data.members).every(
      (id) => id === this.selfId || this.reportComplete(id)
    );
  }
  reportComplete(id) {
    const reported = this.readyReports.get(id) || [];
    return (
      this.connected(id) &&
      requiredPeers(this.data, id).every((peerId) => reported.includes(peerId))
    );
  }
  reportReady() {
    if (this.closed || !this.data) return;
    const peers = requiredPeers(this.data, this.selfId).filter((id) =>
      this.connected(id)
    );
    const roomId = this.id;
    if (this.isHost) {
      for (const id of Object.keys(this.data.members)) {
        const value =
          id === this.selfId
            ? peers.length === requiredPeers(this.data, id).length
            : this.reportComplete(id);
        const key = this.data.networkRevision + ':' + id;
        if (this.readyWrites.get(key) === value) continue;
        this.readyWrites.set(key, value);
        this.readyTasks.set(
          id,
          (this.readyTasks.get(id) || Promise.resolve())
            .then(() => {
              if (
                this.closed ||
                this.id !== roomId ||
                this.readyWrites.get(key) !== value
              )
                return;
              return this.store.networkReady(
                roomId,
                id,
                Number(key.split(':')[0]),
                value
              );
            })
            .catch((error) => {
              this.readyWrites.delete(key);
              this.fail(error);
            })
        );
      }
    } else
      this.send(this.data.hostId, {
        type: 'network-ready',
        revision: this.data.networkRevision,
        peers,
      });
  }
  internalMessage(id, message) {
    if (
      message.type === 'network-rebuild' &&
      !this.isHost &&
      id === this.data.hostId &&
      message.revision === this.data.networkRevision + 1
    ) {
      this.rebuildingTarget = message.revision;
      this.emit('networkReset');
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = setTimeout(() => {
        this.rebuildingTarget = null;
        if (!this.connected(this.data.hostId))
          this.emit('peerClosed', this.data.hostId);
      }, 12000);
      this.send(id, {
        type: 'network-rebuild-ready',
        revision: message.revision,
      });
      return true;
    }
    if (message.type === 'network-rebuild-ready' && this.isHost) {
      const wait = this.rebuildWait;
      if (wait && message.revision === wait.revision) {
        wait.pending.delete(id);
        if (!wait.pending.size) wait.resolve();
      }
      return true;
    }
    if (
      message.type === 'network-rebuild-cancel' &&
      !this.isHost &&
      id === this.data.hostId
    ) {
      this.rebuildingTarget = null;
      clearTimeout(this.rebuildTimer);
      return true;
    }
    if (!['network-ready', 'network-failed'].includes(message.type))
      return false;
    if (
      !this.isHost ||
      message.revision !== this.data.networkRevision ||
      !this.data.members[id]
    )
      return true;
    if (
      message.type === 'network-ready' &&
      Array.isArray(message.peers) &&
      message.peers.length <= 3
    ) {
      this.readyReports.set(
        id,
        message.peers.filter((peerId) => !!this.data.members[peerId])
      );
      this.reportReady();
      this.emit('change', this.data);
    } else if (
      message.type === 'network-failed' &&
      this.data.members[message.peerId] &&
      message.peerId !== this.selfId
    ) {
      this.meshLinkFailed(id, message.peerId);
    }
    return true;
  }
  meshLinkFailed(a, b) {
    const roomId = this.id;
    const revision = this.data.networkRevision;
    setTimeout(() => {
      if (
        !this.closed &&
        this.id === roomId &&
        this.data.networkRevision === revision &&
        this.data.members[a] &&
        this.data.members[b]
      )
        this.handleMeshLinkFailure(a, b);
    }, 500);
  }
  handleMeshLinkFailure(a, b) {
    if (
      !this.isHost ||
      this.rebuildingTarget !== null ||
      !usesMesh(this.data) ||
      this.networkFault ||
      !this.connected(a) ||
      !this.connected(b)
    )
      return;
    this.networkFault = true;
    this.emit('networkReset');
    this.broadcast({ type: 'lobby' });
    this.store
      .update(this.id, { status: 'lobby' })
      .catch((error) => this.fail(error));
    this.fail(
      new Error(
        'A guest-to-guest connection failed. Retry connections in the lobby or select the three-connection layout.'
      )
    );
    this.emit('change', this.data);
  }
  async rebuildNetwork(settings) {
    if (!this.isHost || this.closed || this.rebuildingTarget !== null)
      throw new Error('Only the host can rebuild connections.');
    const roomId = this.id;
    const revision = this.data.networkRevision;
    const members = Object.keys(this.data.members);
    this.rebuildingTarget = revision + 1;
    this.emit('networkReset');
    try {
      await new Promise((resolve, reject) => {
        const pending = new Set(members.filter((id) => id !== this.selfId));
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                'Wait for all host connections, or remove disconnected players before retrying.'
              )
            ),
          8000
        );
        this.rebuildWait = {
          revision: revision + 1,
          pending,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
          timer,
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        this.broadcast({ type: 'network-rebuild', revision: revision + 1 });
        if (!pending.size) this.rebuildWait.resolve();
      });
      const data = await this.store.rebuildNetwork(
        roomId,
        this.selfId,
        settings,
        revision,
        members
      );
      if (
        !this.closed &&
        this.id === roomId &&
        data.networkRevision > this.data.networkRevision
      )
        this.acceptData(data);
    } catch (error) {
      if (this.id === roomId) {
        this.rebuildingTarget = null;
        this.broadcast({ type: 'network-rebuild-cancel' });
        if (!this.closed) await this.store.update(roomId, { status: 'lobby' });
      }
      throw error;
    } finally {
      if (this.id === roomId) this.rebuildWait = null;
    }
  }
  async makePeer(id, host) {
    if (this.closed) return;
    const pc = new RTCPeerConnection(rtcConfiguration);
    const peer = {
      pc,
      channel: null,
      unsubs: [],
      candidates: [],
      negotiating: false,
      remoteSet: false,
      notifiedClosed: false,
      timer: null,
    };
    this.peers.set(id, peer);
    const revision = this.data.networkRevision;
    const signalId = connectionKey(this.data, this.selfId, id);
    const endpoints = {
      revision,
      offererId: host ? this.selfId : id,
      answererId: host ? id : this.selfId,
    };
    let signalReady = !host;
    const localCandidates = [];
    const current = () =>
      !this.closed &&
      this.peers.get(id) === peer &&
      this.data.networkRevision === revision;
    const localSide = host ? 'hostCandidates' : 'guestCandidates';
    const remoteSide = host ? 'guestCandidates' : 'hostCandidates';
    pc.addEventListener('icecandidate', (event) => {
      if (!event.candidate || !current()) return;
      if (!signalReady) {
        localCandidates.push(event.candidate.toJSON());
        return;
      }
      this.store
        .candidate(this.id, signalId, localSide, event.candidate.toJSON())
        .catch((error) => {
          if (current()) this.fail(error);
        });
    });
    peer.unsubs.push(
      this.store.watchCandidates(
        this.id,
        signalId,
        remoteSide,
        async (candidate) => {
          if (!current() || pc.signalingState === 'closed') return;
          if (!peer.remoteSet) {
            peer.candidates.push(candidate);
            return;
          }
          try {
            await pc.addIceCandidate(candidate);
          } catch (error) {
            if (current()) this.fail(error);
          }
        },
        (error) => this.fail(error)
      )
    );
    const remote = async (description) => {
      await pc.setRemoteDescription(description);
      peer.remoteSet = true;
      for (const candidate of peer.candidates.splice(0))
        await pc.addIceCandidate(candidate);
    };
    peer.unsubs.push(
      this.store.watchSignal(
        this.id,
        signalId,
        async (data) => {
          if (!current() || peer.negotiating || peer.remoteSet) return;
          const description = host ? data.answer : data.offer;
          if (!description) return;
          peer.negotiating = true;
          try {
            await remote(description);
            if (!host && current()) {
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              if (current()) await this.store.answer(this.id, signalId, answer);
            }
          } catch (error) {
            this.fail(error);
          }
        },
        (error) => this.fail(error)
      )
    );
    pc.addEventListener('connectionstatechange', () => {
      if (!current()) return;
      if (pc.connectionState === 'connected') {
        clearTimeout(peer.timer);
        peer.timer = null;
      }
      if (pc.connectionState === 'disconnected' && !peer.timer) {
        peer.timer = setTimeout(() => this.peerClosed(id), 8000);
      }
      if (['failed', 'closed'].includes(pc.connectionState))
        this.peerClosed(id);
    });
    if (host) {
      this.attachChannel(
        id,
        pc.createDataChannel('pikavolley-2v2', { ordered: true })
      );
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (current()) {
        await this.store.offer(this.id, signalId, offer, endpoints);
        signalReady = true;
        for (const candidate of localCandidates.splice(0)) {
          if (current())
            await this.store.candidate(this.id, signalId, localSide, candidate);
        }
      }
    } else {
      pc.addEventListener('datachannel', (event) => {
        if (current()) this.attachChannel(id, event.channel);
        else event.channel.close();
      });
    }
  }
  attachChannel(id, channel) {
    const peer = this.peers.get(id);
    if (!peer || this.closed) {
      channel.close();
      return;
    }
    peer.channel = channel;
    const opened = () => {
      if (this.closed || this.peers.get(id) !== peer || peer.openNotified)
        return;
      peer.openNotified = true;
      this.reportReady();
      this.emit('open', id);
    };
    channel.addEventListener('open', opened);
    if (channel.readyState === 'open') opened();
    channel.addEventListener('message', (event) => {
      if (
        this.closed ||
        this.peers.get(id) !== peer ||
        typeof event.data !== 'string' ||
        event.data.length > 65536
      )
        return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        return;
      }
      if (
        message &&
        typeof message.type === 'string' &&
        !this.internalMessage(id, message)
      )
        this.emit('message', id, message);
    });
    channel.addEventListener('close', () => {
      if (this.peers.get(id) === peer) this.peerClosed(id);
    });
    channel.addEventListener('error', () => {
      if (this.peers.get(id) === peer) this.peerClosed(id);
    });
  }
  peerClosed(id) {
    const peer = this.peers.get(id);
    if (this.closed || !peer || peer.notifiedClosed) return;
    peer.notifiedClosed = true;
    if (this.rebuildingTarget !== null) return;
    this.reportReady();
    if (!this.isHost && id !== this.data.hostId) {
      this.send(this.data.hostId, {
        type: 'network-failed',
        revision: this.data.networkRevision,
        peerId: id,
      });
      return;
    }
    this.emit('peerClosed', id);
  }
  dropPeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    clearTimeout(peer.timer);
    peer.unsubs.forEach((unsubscribe) => unsubscribe());
    if (peer.channel) peer.channel.close();
    peer.pc.close();
  }
  connected(id) {
    const peer = this.peers.get(id);
    return (
      !!peer &&
      !peer.notifiedClosed &&
      !!peer.channel &&
      peer.channel.readyState === 'open'
    );
  }
  send(id, message, disposable = false) {
    const peer = this.peers.get(id);
    if (!peer || !peer.channel || peer.channel.readyState !== 'open')
      return false;
    if (disposable && peer.channel.bufferedAmount > 65536) return false;
    const body = JSON.stringify(message);
    if (body.length > 65536) return false;
    try {
      peer.channel.send(body);
      return true;
    } catch (error) {
      return false;
    }
  }
  broadcast(message, disposable = false) {
    this.peers.forEach((peer, id) => this.send(id, message, disposable));
  }
  async removeMember(id) {
    if (!this.isHost || id === this.selfId || this.closed) return;
    this.departed.add(id);
    this.dropPeer(id);
    await this.store.remove(this.id, id);
  }
  async leave() {
    if (this.closed) return;
    const id = this.id,
      host = this.isHost;
    this.shutdown();
    if (host) await this.store.close(id);
    else await this.store.remove(id, this.selfId);
  }
  shutdown() {
    clearInterval(this.reportTimer);
    clearTimeout(this.rebuildTimer);
    if (this.rebuildWait)
      this.rebuildWait.reject(new Error('The room has closed.'));
    this.closed = true;
    this.readyReports.clear();
    this.readyWrites.clear();
    this.readyTasks.clear();
    this.rebuildingTarget = null;
    this.networkFault = false;
    if (this.unsubscribe) this.unsubscribe();
    this.peers.forEach((peer, id) => this.dropPeer(id));
  }
}
