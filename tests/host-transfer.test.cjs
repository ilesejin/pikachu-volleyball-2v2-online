const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs
  .readFileSync(
    path.join(__dirname, '../src/resources/js/online_2v2/host_transfer.js'),
    'utf8'
  )
  .replace('export class', 'class');
const { HostTransfer } = Function(source + ';return {HostTransfer};')();
function fixture() {
  const calls = [];
  const room = {
    selfId: 'host',
    id: 'same-room',
    isHost: true,
    closed: false,
    handoff: null,
    rebuildingTarget: null,
    data: {
      hostId: 'host',
      status: 'lobby',
      layout: 'four',
      visibility: 'public',
      settings: { fps: 30 },
      networkRevision: 2,
      stateVersion: 5,
      members: {
        host: { name: 'Host', connected: true, slots: [0] },
        a: { name: 'A', connected: true, slots: [1] },
        b: { name: 'B', connected: true, slots: [3] },
      },
      seats: ['host', 'a', '', 'b'],
    },
    peers: new Map(
      ['a', 'b'].map((id) => [
        id,
        {
          signalId: id,
          pendingAdmission: false,
          unsubs: [],
          signalingWrites: Promise.resolve(),
        },
      ])
    ),
    ready: () => true,
    connected: () => true,
    emit: () => {},
    callbacks: { beforeHostTransfer: async () => calls.push('withdraw') },
    transport: {
      clearSignal: async (id, peer) => calls.push('clear:' + peer),
      transferHost: async () => calls.push('owner'),
    },
    adoptHostTransfer: async function (data) {
      calls.push('adopt');
      this.data = data;
      this.isHost = false;
      this.handoff = null;
    },
  };
  const transfer = new HostTransfer(room);
  room.broadcast = (packet) => {
    calls.push(packet.type);
    if (
      packet.type === 'host-transfer-prepare' ||
      packet.type === 'host-transfer-commit'
    )
      for (const id of ['a', 'b'])
        transfer.receive(id, {
          type:
            packet.type === 'host-transfer-prepare'
              ? 'host-transfer-ready'
              : 'host-transfer-committed',
          token: packet.token,
        });
  };
  return { room, transfer, calls };
}
test('host handoff preserves the lobby and serializes cleanup before ownership commit', async () => {
  const { room, transfer, calls } = fixture();
  const before = JSON.parse(JSON.stringify(room.data));
  const data = await transfer.perform('a');
  assert.equal(data.hostId, 'a');
  assert.equal(room.isHost, false);
  assert.deepEqual(data.settings, before.settings);
  assert.deepEqual(data.seats, before.seats);
  assert.equal(data.visibility, 'public');
  assert.equal(data.members.host.name, 'Host');
  assert.equal(data.networkRevision, 3);
  assert.ok(calls.indexOf('withdraw') < calls.indexOf('owner'));
  assert.ok(calls.indexOf('clear:a') < calls.indexOf('owner'));
  assert.ok(calls.indexOf('clear:b') < calls.indexOf('owner'));
  assert.ok(calls.indexOf('owner') < calls.indexOf('host-transfer-commit'));
});
test('failed ownership update cancels the barrier and leaves the old host intact', async () => {
  const { room, transfer, calls } = fixture();
  room.transport.transferHost = async () => {
    throw Error('rules denied');
  };
  await assert.rejects(transfer.perform('a'), /rules denied/);
  assert.equal(room.data.hostId, 'host');
  assert.equal(room.isHost, true);
  assert.equal(room.handoff, null);
  assert.ok(calls.includes('host-transfer-cancel'));
  assert.equal(calls.includes('adopt'), false);
});
test('handoff rejects guests, in-game actions, unknown targets and unfinished admission', () => {
  const { room, transfer } = fixture();
  room.isHost = false;
  assert.throws(() => transfer.validate('a'), /Only the host/);
  room.isHost = true;
  room.data.status = 'playing';
  assert.throws(() => transfer.validate('a'), /ready lobby/);
  room.data.status = 'lobby';
  assert.throws(() => transfer.validate('host'), /all players/);
  assert.throws(() => transfer.validate('missing'), /all players/);
  room.peers.get('a').pendingAdmission = true;
  assert.throws(() => transfer.validate('a'), /all players/);
});
test('guests ignore spoofed handoff messages and unrelated acknowledgements cannot commit ownership', () => {
  const { room, transfer } = fixture();
  room.isHost = false;
  room.selfId = 'a';
  transfer.receive('b', {
    type: 'host-transfer-prepare',
    token: 'spoof',
    targetId: 'b',
    revision: 2,
  });
  assert.equal(room.handoff, null);
  room.isHost = true;
  transfer.receive('a', {
    type: 'host-transfer-commit',
    token: 'spoof',
    data: { hostId: 'a' },
  });
  assert.equal(room.data.hostId, 'host');
});

test('browser signaling fixture initializes without Node globals or Firebase access', () => {
  const vm = require('node:vm');
  const context = { window: {}, crypto: require('node:crypto').webcrypto };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, 'browser-store.js'), 'utf8'),
    context
  );
  assert.ok(context.window.__PIKA_TEST_STORE__.uid.startsWith('test'));
  assert.equal(
    typeof context.window.__PIKA_TEST_STORE__.transferHost,
    'function'
  );
});
