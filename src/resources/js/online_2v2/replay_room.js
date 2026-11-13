import { saveAs } from 'file-saver';
import { ReplayRecorder } from './replay_recorder.js';
import {
  decodeReplay,
  encodeReplay,
  MAX_REPLAY_BYTES,
  replayChunks,
} from './replay_format.js';
import { localStorageWrapper } from '../offline_version_js/utils/local_storage_wrapper.js';
import { translate } from './i18n.js';

export class RoomReplay extends ReplayRecorder {
  constructor(session, status) {
    super(session);
    this.status = status;
    this.requests = new Map();
    this.transfers = new Set();
    this.savedClose = null;
    const savedAuto =
      localStorageWrapper.get('pv-online-auto-replay') ??
      localStorageWrapper.get('willSaveReplayAutomatically');
    this.auto = savedAuto === null ? true : savedAuto !== 'false';
    const checkbox = document.getElementById('auto-save-replay-checkbox');
    checkbox.checked = this.auto;
    this.saveContainer = document.getElementById('replay-save-container');
    this.saveAnchor = document.createComment('Replay save position');
    this.saveContainer.before(this.saveAnchor);
    checkbox.addEventListener('change', () => {
      this.auto = checkbox.checked;
      localStorageWrapper.set('pv-online-auto-replay', String(this.auto));
    });
    document
      .getElementById('save-replay-btn')
      .addEventListener('click', () =>
        this.save().catch((error) => status(error.message, true))
      );
    window.addEventListener('beforeunload', () => {
      if (this.auto && !this.session.room?.closed) this.saveLocal(true);
    });
  }
  update() {
    this.sync();
    this.boundary();
    document.getElementById('save-replay-btn').disabled =
      !this.pack ||
      !this.pack.events.some(
        (event) => event.type === 'step' || event.type === 'snapshot'
      );
    const lastReplay = document.getElementById('last-replay-save');
    const hasFrames = !document.getElementById('save-replay-btn').disabled;
    if (this.session.room?.closed && hasFrames) {
      lastReplay.append(this.saveContainer);
      lastReplay.hidden = false;
    } else {
      this.saveAnchor.after(this.saveContainer);
      lastReplay.hidden = true;
    }
    if (
      this.session.room?.closed &&
      this.pack &&
      this.savedClose !== this.pack.roomId
    ) {
      this.savedClose = this.pack.roomId;
      if (this.auto) this.saveLocal(true);
      for (const channel of this.transfers) channel.close();
    }
  }
  download(text) {
    const pack = decodeReplay(text);
    const name =
      'pikavolley-2v2_' +
      pack.createdAt.replace(/[:.]/g, '-') +
      (pack.complete ? '' : '_partial') +
      '.txt';
    saveAs(new Blob([text], { type: 'text/plain;charset=utf-8' }), name, {
      autoBom: true,
    });
  }
  saveLocal(silent = false) {
    try {
      this.download(this.text());
      if (!silent)
        this.status(
          translate(
            'Replay saved. Guest recordings may be partial.',
            '리플레이를 저장했습니다. 게스트 기록은 일부만 포함할 수 있습니다.'
          )
        );
    } catch (error) {
      if (!silent) throw error;
    }
  }
  async prepareTakeover() {
    const room = this.session.room;
    const request = crypto.randomUUID();
    const text = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(request);
        reject(new Error('Replay transfer timed out.'));
      }, 30000);
      this.requests.set(request, { resolve, reject, timer });
      if (
        !room.send(room.data.hostId, {
          type: 'replay-request',
          request,
          takeover: true,
        })
      ) {
        clearTimeout(timer);
        this.requests.delete(request);
        reject(new Error('The host connection is unavailable.'));
      }
    });
    this.pendingTakeover = decodeReplay(text);
  }
  commitTakeover(host) {
    if (host && this.pendingTakeover) {
      this.pack = this.pendingTakeover;
      this.count = this.pack.events.filter(
        (event) => event.type === 'step'
      ).length;
      this.signature = this.roomSignature = '';
    } else if (!host && this.pack) {
      this.pack.authoritative = false;
      this.pack.complete = false;
    }
    if (host && this.pack) this.pack.authoritative = true;
    this.pendingTakeover = null;
  }
  async save() {
    const room = this.session.room;
    if (
      room &&
      !room.closed &&
      !room.isHost &&
      room.connected(room.data.hostId) &&
      this.session.phase !== 'playing'
    ) {
      const request = crypto.randomUUID();
      try {
        const text = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            this.requests.delete(request);
            reject(new Error('Replay transfer timed out.'));
          }, 30000);
          this.requests.set(request, { resolve, reject, timer });
          room.send(room.data.hostId, { type: 'replay-request', request });
        });
        this.download(text);
        this.status(
          translate('Host replay saved.', '방장 리플레이를 저장했습니다.')
        );
        return;
      } catch (error) {
        this.status(
          translate(
            'Host replay unavailable; saving your local recording.',
            '방장 기록을 받을 수 없어 로컬 기록을 저장합니다.'
          )
        );
      }
    }
    this.saveLocal();
  }
  message(id, packet) {
    const room = this.session.room;
    if (packet.type === 'replay-request') {
      if (
        room.isHost &&
        room.data.members[id] &&
        typeof packet.request === 'string' &&
        /^[a-f0-9-]{36}$/.test(packet.request)
      ) {
        if (this.session.phase === 'playing' || this.sending)
          room.send(id, {
            type: 'replay-unavailable',
            request: packet.request,
          });
        else
          this.send(
            id,
            packet.request,
            !!packet.takeover && room.handoff?.targetId === id
          ).catch(() =>
            room.send(id, {
              type: 'replay-unavailable',
              request: packet.request,
            })
          );
      }
      return true;
    }
    if (packet.type === 'replay-unavailable') {
      if (!room.isHost && id === room.data.hostId) {
        const task = this.requests.get(packet.request);
        if (task) {
          clearTimeout(task.timer);
          this.requests.delete(packet.request);
          task.reject(new Error('Host replay unavailable.'));
        }
      }
      return true;
    }
    return false;
  }
  async send(id, request, takeover = false) {
    this.sync();
    const room = this.session.room,
      text = takeover ? encodeReplay(this.pack) : this.text();
    if (text.length > MAX_REPLAY_BYTES)
      throw new Error('Replay file is too large.');
    const channel = room.peers
      .get(id)
      .pc.createDataChannel('pikavolley-replay:' + request, { ordered: true });
    this.sending = true;
    this.transfers.add(channel);
    let timeout;
    const touch = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => channel.close(), 30000);
    };
    touch();
    try {
      await new Promise((resolve, reject) => {
        channel.onopen = resolve;
        channel.onclose = () => reject(new Error('Replay connection closed.'));
      });
      channel.send(JSON.stringify({ size: text.length }));
      for (const chunk of replayChunks(text)) {
        while (channel.bufferedAmount > 131072 && channel.readyState === 'open')
          await new Promise((resolve) => setTimeout(resolve, 20));
        if (channel.readyState !== 'open' || this.session.phase === 'playing')
          throw new Error('Replay transfer stopped.');
        channel.send(chunk);
        touch();
      }
      await new Promise((resolve) => {
        channel.onmessage = resolve;
        channel.onclose = resolve;
      });
    } finally {
      clearTimeout(timeout);
      channel.close();
      this.transfers.delete(channel);
      this.sending = false;
    }
  }
  channel(id, channel) {
    const room = this.session.room,
      request = channel.label.slice('pikavolley-replay:'.length);
    const task = this.requests.get(request);
    if (room.isHost || id !== room.data.hostId || !task) {
      channel.close();
      return;
    }
    if (task.channel) {
      channel.close();
      return;
    }
    task.channel = channel;
    this.transfers.add(channel);
    let size = null,
      length = 0,
      chunks = [],
      complete = false;
    channel.onmessage = (event) => {
      clearTimeout(task.timer);
      task.timer = setTimeout(() => {
        this.requests.delete(request);
        task.reject(new Error('Replay transfer timed out.'));
        channel.close();
      }, 30000);
      try {
        if (typeof event.data !== 'string')
          throw new Error('Invalid replay transfer.');
        if (size === null) {
          size = JSON.parse(event.data).size;
          if (!Number.isInteger(size) || size < 1 || size > MAX_REPLAY_BYTES)
            throw new Error('Invalid replay size.');
          return;
        }
        length += event.data.length;
        if (event.data.length > 16000 || length > size)
          throw new Error('Invalid replay chunk.');
        chunks.push(event.data);
        if (length === size) {
          const text = chunks.join('');
          chunks = [];
          const pack = decodeReplay(text);
          if (!pack.authoritative || pack.roomId !== room.id)
            throw new Error('Invalid host replay.');
          complete = true;
          clearTimeout(task.timer);
          this.requests.delete(request);
          task.resolve(text);
          channel.send('received');
        }
      } catch (error) {
        clearTimeout(task.timer);
        this.requests.delete(request);
        task.reject(error);
        channel.close();
      }
    };
    channel.onclose = () => {
      this.transfers.delete(channel);
      if (!complete) {
        clearTimeout(task.timer);
        this.requests.delete(request);
        task.reject(new Error('Replay transfer interrupted.'));
      }
    };
  }
}
