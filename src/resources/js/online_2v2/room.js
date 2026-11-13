import { generatePushID } from '../utils/generate_pushid.js';
import { CLIENT_VERSION } from './client_version.js';
import { SignalingStore } from './signaling_store.js';
import { LobbyStore } from './lobby_store.js';
import { HostTransfer } from './host_transfer.js';
import { RelaySignaling } from './relay_signaling.js';
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
  constructor(callbacks = {}, store = new SignalingStore()) {
    this.transport = store;
    this.store = new LobbyStore(this);
    this.relay = new RelaySignaling(this);
    this.callbacks = callbacks;
    this.hostTransfer = new HostTransfer(this);
    this.handoff = null;
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
  async create(name, layout, slots, settings, visibility = 'private') {
    if (!this.closed) throw new Error('Leave the current room first.');
    this.emit('creating', true);
    try {
      await this.callbacks.beforeConnect?.();
      if (this.transport.identity)
        this.selfId = await this.transport.identity();
      this.departed.clear();
      this.closed = false;
      this.isHost = true;
      this.id = generatePushID();
      try {
        this.data = await this.store.create(
          this.id,
          this.selfId,
          name,
          layout,
          slots,
          settings,
          visibility
        );
        this.subscribe();
        return this.id;
      } catch (error) {
        this.closed = true;
        throw error;
      }
    } finally {
      this.emit('creating', false);
    }
  }
  async join(id, name, slots, expectedHost, quickMatch = false) {
    if (!this.closed) throw new Error('Leave the current room first.');
    this.emit('connecting', true);
    try {
      await this.callbacks.beforeConnect?.();
      if (!/^[a-z0-9]{20}$/.test(id))
        throw new Error('Enter a valid 20-character room ID.');
      if (this.transport.identity)
        this.selfId = await this.transport.identity();
      this.departed.clear();
      this.closed = false;
      this.isHost = false;
      this.id = id;
      try {
        const entry = await this.transport.peek(id);
        if (!entry || entry.schema !== ROOM_SCHEMA || entry.status !== 'lobby')
          throw new Error('Room not found, or the match has already started.');
        if (expectedHost && entry.hostId !== expectedHost)
          throw new Error('The advertised host does not own this room.');
        this.data = {
          ...entry,
          networkRevision: 0,
          settings: { topology: 'star' },
          seats: ['', '', '', ''],
          members: {
            [entry.hostId]: { slots: [], connected: true },
            [this.selfId]: { slots: [], connected: false },
          },
        };
        this.joinDetails = {
          name,
          slots,
          quickMatch,
          compatibility: CLIENT_VERSION,
        };
        const admitted = new Promise((resolve, reject) => {
          this.joinResolve = resolve;
          this.joinReject = reject;
          this.joinTimer = setTimeout(
            () => reject(new Error('The host did not respond.')),
            30000
          );
        });
        admitted.catch(() => {});
        this.startReports();
        await this.transport.requestJoin(id, this.selfId, entry.hostId);
        await this.makePeer(entry.hostId, false);
        await admitted;
        clearTimeout(this.joinTimer);
        this.joinResolve = null;
        this.joinReject = null;
      } catch (error) {
        this.shutdown();
        await this.transport.clearSignal(id, this.selfId).catch(() => {});
        throw error;
      }
    } finally {
      this.emit('connecting', false);
    }
  }
  startReports() {
    const watchedRoomId = this.id;
    clearInterval(this.reportTimer);
    this.reportTimer = setInterval(() => {
      if (!this.closed && this.id === watchedRoomId) this.reportReady();
    }, 1000);
  }
  subscribe() {
    this.startReports();
    const roomId = this.id;
    this.unsubscribe = this.transport.watchRequests(
      roomId,
      (id, request) => {
        if (
          this.closed ||
          !this.isHost ||
          this.id !== roomId ||
          request.hostId !== this.selfId ||
          request.guestId !== id ||
          this.peers.has(id)
        )
          return;
        if (
          (this.handoff &&
            !(
              this.handoff.stage === 'reconnecting' && this.data.members[id]
            )) ||
          this.data.status !== 'lobby' ||
          this.peers.size >= 7
        ) {
          this.transport
            .clearSignal(roomId, id)
            .catch((error) => this.fail(error));
          return;
        }
        this.makePeer(id, true).catch((error) => this.fail(error));
      },
      (error) => this.fail(error)
    );
    this.emit('change', this.data);
  }
  publishData(data) {
    // Send through the retained host channels before dropping obsolete mesh links.
    for (const id of Object.keys(data.members))
      if (id !== this.selfId) this.send(id, { type: 'lobby-state', data });
    this.acceptData(data);
  }
  acceptData(data) {
    if (
      this.data &&
      data.stateVersion !== undefined &&
      data.stateVersion < (this.data.stateVersion || 0)
    )
      return;
    if (this.data && data.networkRevision < this.data.networkRevision) return;
    const reset =
      this.data && data.networkRevision !== this.data.networkRevision;
    this.data = data;
    if (reset) {
      this.peers.forEach((peer, id) => {
        if (this.selfId !== data.hostId && id !== data.hostId)
          this.dropPeer(id);
      });
      this.relay.clear();
      this.readyReports.clear();
      this.readyWrites.clear();
      this.networkFault = false;
      this.rebuildingTarget = null;
      clearTimeout(this.rebuildTimer);
      this.emit('networkReset');
    }
    const wanted = requiredPeers(data, this.selfId);
    this.peers.forEach((peer, id) => {
      if (!wanted.includes(id) && !peer.pendingAdmission) this.dropPeer(id);
    });
    for (const id of wanted) {
      if (this.peers.has(id) || this.departed.has(id)) continue;
      // Host links require the guest to create its authenticated signal first.
      if (this.isHost) continue;
      if (
        this.selfId !== data.hostId &&
        id !== data.hostId &&
        !this.connected(data.hostId)
      )
        continue;
      const offerer =
        this.selfId === data.hostId || (id !== data.hostId && this.selfId < id);
      const revision = data.networkRevision;
      this.makePeer(id, offerer).catch((error) => {
        if (!this.closed && this.data.networkRevision === revision)
          this.fail(error);
      });
    }
    this.reportReady();
    this.hostTransfer?.completeIfReady();
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
    if (
      this.closed ||
      !this.data ||
      (this.handoff && this.handoff.stage !== 'reconnecting')
    )
      return;
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
        // A returning client can have the same identity but a fresh lobby entry.
        // Do not let the previous connection's cached write leave it unready.
        if (
          this.readyWrites.get(key) === value &&
          this.data.members[id].connected === value
        )
          continue;
        this.readyWrites.set(key, value);
        this.readyTasks.set(
          id,
          (this.readyTasks.get(id) || Promise.resolve())
            .then(() => {
              if (
                this.closed ||
                !this.isHost ||
                (this.handoff && this.handoff.stage !== 'reconnecting') ||
                this.data.networkRevision !== Number(key.split(':')[0]) ||
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
    if (this.hostTransfer?.receive(id, message)) return true;
    if (this.diagnostics?.receive(id, message)) return true;
    if (this.store?.receive && this.store.receive(id, message)) return true;
    if (this.relay?.receive(id, message)) return true;
    if (message.type === 'signal-open') {
      const peer = this.peers.get(id);
      if (peer) {
        peer.remoteOpened = true;
        this.finishSignal(id, peer);
      }
      return true;
    }
    if (message.type === 'room-leave' && this.isHost) {
      this.emit('peerClosed', id);
      return true;
    }
    if (
      message.type === 'room-closed' &&
      !this.isHost &&
      id === this.data.hostId
    ) {
      if (
        this.data.status === 'playing' &&
        (this.data.layout === 'pairs' ||
          Object.keys(this.data.members).length === 2)
      ) {
        this.emit('peerClosed', id);
        return true;
      }
      this.shutdown();
      this.emit('ended');
      return true;
    }
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
    if (this.closed || this.peers.has(id)) return;
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
      pendingAdmission: this.isHost && !this.data.members[id],
      signalingWrites: Promise.resolve(),
    };
    this.peers.set(id, peer);
    const revision = this.data.networkRevision;
    const roomId = this.id;
    const hostLink = this.isHost || id === this.data.hostId;
    const signalStore = hostLink ? this.transport : this.relay;
    const signalId = hostLink
      ? this.isHost
        ? id
        : this.selfId
      : connectionKey(this.data, this.selfId, id);
    peer.hostLink = hostLink;
    peer.signalId = signalId;
    peer.setupTimer = setTimeout(() => {
      if (
        this.peers.get(id) === peer &&
        (!peer.openNotified || peer.pendingAdmission)
      ) {
        if (this.data.members[id]) this.peerClosed(id);
        else {
          this.dropPeer(id);
          this.transport
            .clearSignal(roomId, id)
            .catch((error) => this.fail(error));
        }
      }
    }, 30000);
    const endpoints = {
      revision,
      offererId: host ? this.selfId : id,
      answererId: host ? id : this.selfId,
    };
    let signalReady = !host;
    const localCandidates = [];
    const active = () => !this.closed && this.peers.get(id) === peer;
    const current = () =>
      active() && (hostLink || this.data.networkRevision === revision);
    const localSide = host ? 'hostCandidates' : 'guestCandidates';
    const remoteSide = host ? 'guestCandidates' : 'hostCandidates';
    pc.addEventListener('icecandidate', (event) => {
      if (!event.candidate || !current() || peer.signalingFinished) return;
      if (!signalReady) {
        localCandidates.push(event.candidate.toJSON());
        return;
      }
      peer.signalingWrites = peer.signalingWrites
        .then(() =>
          current() && !peer.signalCleaned
            ? signalStore.candidate(
                roomId,
                signalId,
                localSide,
                event.candidate.toJSON()
              )
            : undefined
        )
        .catch((error) => {
          if (current()) this.fail(error);
        });
    });
    peer.unsubs.push(
      signalStore.watchCandidates(
        roomId,
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
      signalStore.watchSignal(
        roomId,
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
              if (current()) await signalStore.answer(roomId, signalId, answer);
            }
          } catch (error) {
            this.fail(error);
          }
        },
        (error) => this.fail(error)
      )
    );
    pc.addEventListener('connectionstatechange', () => {
      if (!active()) return;
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
    // Replay channels can originate at either endpoint after a host handoff.
    // Established peer lifetimes outlive the signaling revision that created them.
    pc.addEventListener('datachannel', (event) => {
      if (
        active() &&
        (event.channel.label.startsWith('pikavolley-replay:') ||
          (event.channel.label === 'pikavolley-2v2' && !peer.channel))
      )
        this.attachChannel(id, event.channel);
      else event.channel.close();
    });
    if (host) {
      this.attachChannel(
        id,
        pc.createDataChannel('pikavolley-2v2', { ordered: true })
      );
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (current()) {
        await signalStore.offer(roomId, signalId, offer, endpoints);
        signalReady = true;
        for (const candidate of localCandidates.splice(0)) {
          if (current())
            peer.signalingWrites = peer.signalingWrites
              .then(() =>
                current() && !peer.signalCleaned
                  ? signalStore.candidate(
                      roomId,
                      signalId,
                      localSide,
                      candidate
                    )
                  : undefined
              )
              .catch((error) => {
                if (current()) this.fail(error);
              });
        }
      }
    }
  }
  attachChannel(id, channel) {
    if (channel.label && channel.label.startsWith('pikavolley-replay:')) {
      if (this.closed) channel.close();
      else this.emit('extraChannel', id, channel);
      return;
    }
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
      peer.signalingFinished = true;
      (peer.signalingWrites || Promise.resolve()).then(() => {
        if (!this.closed && this.peers.get(id) === peer) {
          this.send(id, { type: 'signal-open' });
          this.finishSignal(id, peer);
        }
      });
      if (!this.isHost && id === this.data?.hostId && this.joinDetails) {
        this.store.request('claim', this.joinDetails).then(
          () => {
            this.joinDetails = null;
            this.joinResolve?.();
            this.reportReady();
          },
          (error) => this.joinReject?.(error)
        );
      }
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
        if (this.data.members[id]) this.emit('message', id, message);
    });
    channel.addEventListener('close', () => {
      if (this.peers.get(id) === peer) this.peerClosed(id);
    });
    channel.addEventListener('error', () => {
      if (this.peers.get(id) === peer) this.peerClosed(id);
    });
  }
  finishSignal(id, peer) {
    if (!peer.openNotified || !peer.remoteOpened || peer.signalCleaned) return;
    peer.signalCleaned = true;
    peer.unsubs.splice(0).forEach((unsubscribe) => unsubscribe());
    if (peer.hostLink && this.isHost) {
      const roomId = this.id;
      peer.signalingWrites
        .then(() => this.transport.clearSignal(roomId, peer.signalId))
        .catch((error) => this.fail(error));
    }
  }
  peerClosed(id) {
    const peer = this.peers.get(id);
    if (this.closed || !peer || peer.notifiedClosed) return;
    peer.notifiedClosed = true;
    this.hostTransfer?.peerClosed(id);
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
    clearTimeout(peer.setupTimer);
    peer.unsubs.forEach((unsubscribe) => unsubscribe());
    // A rejoining browser uses the same mesh key within this lobby revision.
    // Do not feed its new connection the previous offer/answer/ICE candidates.
    if (!peer.hostLink) this.relay.entries.delete(peer.signalId);
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
    this.peers.forEach((peer, id) => {
      if (this.data.members[id]) this.send(id, message, disposable);
    });
  }
  async removeMember(id) {
    if (!this.isHost || id === this.selfId || this.closed) return;
    this.departed.add(id);
    this.dropPeer(id);
    await this.store.remove(this.id, id);
  }
  transferHost(targetId) {
    this.hostTransfer.validate(targetId);
    return this.store.request('transferHost', { targetId });
  }
  async adoptHostTransfer(data) {
    const roomId = this.id;
    this.rebuildingTarget = data.networkRevision;
    clearInterval(this.reportTimer);
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    this.store.shutdown();
    const host = data.hostId === this.selfId;
    if (!host && !this.peers.has(data.hostId))
      await this.transport.requestJoin(roomId, this.selfId, data.hostId);
    if (this.closed || this.id !== roomId) return;
    this.isHost = host;
    this.departed.clear();
    this.readyReports.clear();
    this.readyWrites.clear();
    this.readyTasks.clear();
    this.diagnostics?.clear();
    if (this.replay) this.replay.commitTakeover(host);
    this.handoff = { ...this.handoff, stage: 'reconnecting' };
    this.acceptData(data);
    this.rebuildingTarget = null;
    if (host) this.subscribe();
    else this.startReports();
    this.reportReady();
    this.hostTransfer?.completeIfReady();
    this.emit('change', this.data);
  }
  async becomeLobbyHost() {
    if (
      this.closed ||
      this.isHost ||
      (this.data.layout !== 'pairs' &&
        Object.keys(this.data.members).length !== 2)
    )
      return;
    const id = this.id;
    const member = this.data.members[this.selfId];
    const settings = this.data.settings;
    const layout = this.data.layout;
    const visibility = this.data.visibility || 'private';
    this.shutdown();
    this.closed = false;
    this.isHost = true;
    this.departed.clear();
    try {
      this.data = await this.store.create(
        id,
        this.selfId,
        member.names || [member.name],
        layout,
        member.slots,
        settings,
        visibility
      );
      this.replay?.commitTakeover(true);
      this.subscribe();
    } catch (error) {
      this.shutdown();
      throw error;
    }
  }
  async leave() {
    if (this.closed) return;
    const id = this.id,
      host = this.isHost;
    // Finish old-host cleanup before the remaining player/team republishes this code.
    // Otherwise late cleanup could target the replacement lobby.
    if (
      host &&
      this.data.status === 'playing' &&
      (this.data.layout === 'pairs' ||
        Object.keys(this.data.members).length === 2)
    ) {
      try {
        await this.transport.close(id);
      } finally {
        this.broadcast({ type: 'room-closed' });
        this.shutdown();
      }
      return;
    }
    if (host) this.broadcast({ type: 'room-closed' });
    else this.send(this.data.hostId, { type: 'room-leave' });
    this.shutdown();
    if (host) await this.transport.close(id);
  }
  shutdown() {
    this.hostTransfer?.close();
    this.diagnostics?.clear();
    clearTimeout(this.joinTimer);
    if (this.joinReject) this.joinReject(new Error('The room has closed.'));
    this.joinResolve = null;
    this.joinReject = null;
    this.joinDetails = null;
    if (this.store.shutdown) this.store.shutdown();
    this.relay.clear();
    clearInterval(this.reportTimer);
    clearTimeout(this.rebuildTimer);
    if (this.rebuildWait)
      this.rebuildWait.reject(new Error('The room has closed.'));
    this.closed = true;
    if (this.replay && this.replay.update) this.replay.update();
    this.readyReports.clear();
    this.readyWrites.clear();
    this.readyTasks.clear();
    this.rebuildingTarget = null;
    this.networkFault = false;
    if (this.unsubscribe) this.unsubscribe();
    this.peers.forEach((peer, id) => this.dropPeer(id));
  }
}
