import {
  CLIENT_VERSION,
  assertCompatible,
  assertRoomCompatible,
} from './client_version.js';
import {
  ROOM_SCHEMA,
  validSlots,
  playerNames,
  matchSettings,
  lobbyReady,
  randomizedPositions,
} from './protocol.js';

// The host serializes every mutation. Guests can only edit their own entry.
export class LobbyStore {
  constructor(room) {
    this.room = room;
    this.tail = Promise.resolve();
    this.pending = new Map();
    this.sequence = 0;
    this.generation = 0;
  }
  async create(
    id,
    hostId,
    name,
    layout,
    slots,
    settings,
    visibility = 'private'
  ) {
    if (!['public', 'private'].includes(visibility))
      throw new Error('Invalid room visibility.');
    if (!validSlots(layout, slots, true))
      throw new Error('Invalid player positions.');
    const names = playerNames(name, layout);
    const data = {
      schema: ROOM_SCHEMA,
      compatibility: CLIENT_VERSION,
      hostId,
      layout,
      visibility,
      settings: matchSettings(settings),
      status: 'lobby',
      networkRevision: 0,
      stateVersion: 0,
      members: {
        [hostId]: {
          name: names[0],
          names,
          slots,
          connected: true,
          compatibility: CLIENT_VERSION,
        },
      },
      seats: [0, 1, 2, 3].map((slot) => (slots.includes(slot) ? hostId : '')),
    };
    await this.room.transport.publish(id, data);
    return data;
  }
  request(action, args = {}) {
    const room = this.room;
    if (room.closed) return Promise.reject(new Error('The room has closed.'));
    if (room.isHost) return this.enqueue(room.selfId, action, args);
    const request = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request);
        reject(new Error('The host did not respond.'));
      }, 15000);
      this.pending.set(request, { resolve, reject, timer });
      if (
        !room.send(room.data.hostId, {
          type: 'lobby-request',
          request,
          action,
          args,
        })
      ) {
        clearTimeout(timer);
        this.pending.delete(request);
        reject(new Error('Wait for the host connection.'));
      }
    });
  }
  enqueue(actor, action, args) {
    const generation = this.generation;
    const task = this.tail.then(() => {
      if (generation !== this.generation)
        throw new Error('The room has closed.');
      return this.apply(actor, action, args);
    });
    this.tail = task.catch(() => {});
    return task;
  }
  async apply(actor, action, args) {
    const room = this.room;
    if (room.closed) throw new Error('The room has closed.');
    const generation = this.generation;
    const data = JSON.parse(JSON.stringify(room.data));
    const host = actor === data.hostId;
    if (!host && !['claim', 'selectSlots', 'rename', 'remove'].includes(action))
      throw new Error('Only the host can change this setting.');
    if (action !== 'claim' && !data.members[actor])
      throw new Error('Join the lobby first.');
    if (action === 'claim' && data.status !== 'lobby')
      throw new Error('The match has started or the room has closed.');
    if (
      ['claim', 'selectSlots', 'rename', 'randomizeSlots'].includes(action) &&
      data.status !== 'lobby'
    )
      throw new Error('This action is only available in the lobby.');
    if (action === 'claim') {
      if (args.quickMatch && data.visibility !== 'public')
        throw new Error('This room is private. Find another Quick Match room.');
      assertCompatible(args.compatibility);
      assertRoomCompatible(data);
      if (data.members[actor])
        throw new Error('This tab already joined the room.');
      if (Object.keys(data.members).length >= (data.layout === 'pairs' ? 2 : 4))
        throw new Error('This lobby is full.');
      const names = playerNames(args.name, data.layout);
      data.members[actor] = {
        name: names[0],
        compatibility: args.compatibility,
        names,
        slots: [],
        connected: false,
      };
      args.slots = args.slots || [];
    }
    if (action === 'claim' || action === 'selectSlots') {
      if (!validSlots(data.layout, args.slots, true))
        throw new Error('Select a whole team for local pairs.');
      if (
        args.slots.some(
          (slot) => data.seats[slot] && data.seats[slot] !== actor
        )
      )
        throw new Error('That position is already occupied.');
      data.members[actor].slots = args.slots;
      data.seats = data.seats.map((owner, slot) =>
        args.slots.includes(slot) ? actor : owner === actor ? '' : owner
      );
    } else if (action === 'rename') {
      const names = playerNames(args.names, data.layout);
      Object.assign(data.members[actor], { name: names[0], names });
    } else if (action === 'randomizeSlots')
      Object.assign(data, randomizedPositions(data));
    else if (action === 'remove') {
      const uid = host ? args.clientId : actor;
      if (uid === data.hostId) throw new Error('The host must close the room.');
      const wasMember = !!data.members[uid];
      delete data.members[uid];
      data.seats = data.seats.map((owner) => (owner === uid ? '' : owner));
      // Serialized removals make simultaneous departures observe the final roster.
      if (
        wasMember &&
        data.layout === 'four' &&
        data.status === 'playing' &&
        Object.keys(data.members).length === 1
      )
        data.status = 'lobby';
    } else if (action === 'visibility') {
      if (!['public', 'private'].includes(args.value))
        throw new Error('Invalid room visibility.');
      data.visibility = args.value;
    } else if (action === 'networkReady') {
      if (
        data.networkRevision !== args.revision ||
        !data.members[args.clientId]
      )
        return data;
      if (data.members[args.clientId].connected === args.value) return data;
      data.members[args.clientId].connected = args.value;
    } else if (action === 'beginMatch') {
      assertRoomCompatible(data);
      if (data.layout === 'pairs' && Object.keys(data.members).length !== 2)
        throw new Error(
          'Two connected duo clients are required to start a duo match.'
        );
      if (data.layout === 'four' && Object.keys(data.members).length < 2)
        throw new Error(
          'At least two connected players are required to start a solo match.'
        );
      if (!lobbyReady(data))
        throw new Error(
          'Every joined player must select a slot before starting.'
        );
      if (Object.values(data.members).some((member) => !member.connected))
        throw new Error('Wait for all players to connect before starting.');
      data.settings = matchSettings(args.settings);
      data.status = 'playing';
    } else if (action === 'update') {
      if (
        Object.keys(args.value).some(
          (key) => !['settings', 'status'].includes(key)
        )
      )
        throw new Error('Invalid lobby update.');
      if (args.value.settings)
        data.settings = matchSettings(args.value.settings);
      if (args.value.status !== undefined) {
        if (!['lobby', 'playing'].includes(args.value.status))
          throw new Error('Invalid room status.');
        data.status = args.value.status;
      }
    } else if (action === 'rebuildNetwork') {
      if (
        args.expectedRevision !== undefined &&
        (args.expectedRevision !== data.networkRevision ||
          JSON.stringify(args.expectedMembers.slice().sort()) !==
            JSON.stringify(Object.keys(data.members).sort()))
      )
        throw new Error(
          'Lobby membership changed. Retry the connection change.'
        );
      data.settings = matchSettings(args.settings);
      data.status = 'lobby';
      data.networkRevision++;
      Object.values(data.members).forEach((member) => {
        member.connected = false;
      });
    } else if (!['claim', 'selectSlots'].includes(action))
      throw new Error('Invalid lobby request.');
    // Complete rendezvous changes before publishing a state transition to peers.
    if (room.data.status !== data.status) {
      if (data.status === 'lobby') await room.transport.publish(room.id, data);
      else await room.transport.unpublish(room.id);
    }
    if (generation !== this.generation || room.closed)
      throw new Error('The room has closed.');
    if (action === 'claim') {
      const peer = room.peers.get(actor);
      if (peer) {
        peer.pendingAdmission = false;
        clearTimeout(peer.setupTimer);
      }
    }
    data.stateVersion = (room.data.stateVersion || 0) + 1;
    room.publishData(data);
    return data;
  }
  receive(id, message) {
    const room = this.room;
    if (message.type === 'lobby-state') {
      if (
        !room.isHost &&
        id === room.data.hostId &&
        message.data?.schema === ROOM_SCHEMA
      ) {
        try {
          assertRoomCompatible(message.data);
        } catch (error) {
          room.joinReject?.(error);
          room.fail(error);
          room.shutdown();
          room.emit('ended');
          return true;
        }
        if (!message.data.members[room.selfId]) {
          room.shutdown();
          room.emit('ended');
        } else room.acceptData(message.data);
      }
      return true;
    }
    if (message.type === 'lobby-request') {
      if (
        room.isHost &&
        typeof message.request === 'string' &&
        message.request.length < 32 &&
        typeof message.action === 'string' &&
        message.args &&
        typeof message.args === 'object'
      ) {
        this.enqueue(id, message.action, message.args).then(
          (data) =>
            room.send(id, {
              type: 'lobby-response',
              request: message.request,
              data,
            }),
          (error) =>
            room.send(id, {
              type: 'lobby-response',
              request: message.request,
              error: error.message,
            })
        );
      }
      return true;
    }
    if (message.type === 'lobby-response') {
      if (!room.isHost && id === room.data.hostId) {
        const pending = this.pending.get(message.request);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(message.request);
          if (message.error) pending.reject(new Error(message.error));
          else {
            try {
              assertRoomCompatible(message.data);
              room.acceptData(message.data);
              pending.resolve(message.data);
            } catch (error) {
              pending.reject(error);
            }
          }
        }
      }
      return true;
    }
    return false;
  }
  selectSlots(id, clientId, slots) {
    return this.request('selectSlots', { slots });
  }
  randomizeSlots() {
    return this.request('randomizeSlots');
  }
  rename(id, clientId, names) {
    return this.request('rename', { names });
  }
  beginMatch(id, hostId, settings) {
    return this.request('beginMatch', { settings });
  }
  update(id, value) {
    return this.request('update', { value });
  }
  remove(id, clientId) {
    return this.request('remove', { clientId });
  }
  networkReady(id, clientId, revision, value) {
    return this.request('networkReady', { clientId, revision, value });
  }
  rebuildNetwork(id, hostId, settings, expectedRevision, expectedMembers) {
    return this.request('rebuildNetwork', {
      settings,
      expectedRevision,
      expectedMembers,
    });
  }
  shutdown() {
    this.generation++;
    this.tail = Promise.resolve();
    for (const task of this.pending.values()) {
      clearTimeout(task.timer);
      task.reject(new Error('The room has closed.'));
    }
    this.pending.clear();
  }
}
