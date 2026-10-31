import { FirebaseRoomStore } from './firebase_store.js';
import { rtcConfiguration } from '../data_channel/rtc_configuration.js';
import { ROOM_SCHEMA } from './protocol.js';

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
    this.unsubscribe = this.store.watch(
      this.id,
      (data) => {
        if (this.closed) return;
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
        this.data = data;
        if (this.isHost) {
          Object.keys(data.members).forEach((id) => {
            if (
              id !== this.selfId &&
              !this.peers.has(id) &&
              !this.departed.has(id)
            )
              this.makePeer(id, true).catch((error) => this.fail(error));
          });
        } else if (!this.peers.has(data.hostId)) {
          this.makePeer(data.hostId, false).catch((error) => this.fail(error));
        }
        this.peers.forEach((peer, id) => {
          if (!data.members[id]) this.dropPeer(id);
        });
        this.emit('change', data);
      },
      (error) => this.fail(error)
    );
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
    const signalId = host ? id : this.selfId;
    const localSide = host ? 'hostCandidates' : 'guestCandidates';
    const remoteSide = host ? 'guestCandidates' : 'hostCandidates';
    pc.addEventListener('icecandidate', (event) => {
      if (event.candidate && !this.closed)
        this.store
          .candidate(this.id, signalId, localSide, event.candidate.toJSON())
          .catch((error) => this.fail(error));
    });
    peer.unsubs.push(
      this.store.watchCandidates(
        this.id,
        signalId,
        remoteSide,
        async (candidate) => {
          if (this.closed || pc.signalingState === 'closed') return;
          if (!peer.remoteSet) {
            peer.candidates.push(candidate);
            return;
          }
          try {
            await pc.addIceCandidate(candidate);
          } catch (error) {
            this.fail(error);
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
          if (this.closed || peer.negotiating || peer.remoteSet) return;
          const description = host ? data.answer : data.offer;
          if (!description) return;
          peer.negotiating = true;
          try {
            await remote(description);
            if (!host) {
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              await this.store.answer(this.id, signalId, answer);
            }
          } catch (error) {
            this.fail(error);
          }
        },
        (error) => this.fail(error)
      )
    );
    pc.addEventListener('connectionstatechange', () => {
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
      if (!this.closed) await this.store.offer(this.id, signalId, offer);
    } else {
      pc.addEventListener('datachannel', (event) =>
        this.attachChannel(id, event.channel)
      );
    }
  }
  attachChannel(id, channel) {
    const peer = this.peers.get(id);
    if (!peer || this.closed) {
      channel.close();
      return;
    }
    peer.channel = channel;
    channel.addEventListener('open', () => {
      if (this.closed) return;
      if (this.isHost)
        this.store.connected(this.id, id).catch((error) => this.fail(error));
      this.emit('open', id);
    });
    channel.addEventListener('message', (event) => {
      if (
        this.closed ||
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
      if (message && typeof message.type === 'string')
        this.emit('message', id, message);
    });
    channel.addEventListener('close', () => this.peerClosed(id));
    channel.addEventListener('error', () => this.peerClosed(id));
  }
  peerClosed(id) {
    const peer = this.peers.get(id);
    if (this.closed || !peer || peer.notifiedClosed) return;
    peer.notifiedClosed = true;
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
    return !!peer && !!peer.channel && peer.channel.readyState === 'open';
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
    this.closed = true;
    if (this.unsubscribe) this.unsubscribe();
    this.peers.forEach((peer, id) => this.dropPeer(id));
  }
}
