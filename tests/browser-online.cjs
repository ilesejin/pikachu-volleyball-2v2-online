'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  http = require('node:http');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const root = path.resolve(__dirname, '../dist'),
  artifacts = path.resolve(__dirname, '../.test-artifacts');
const signalingOperations = new Map();
const rooms = new Map(),
  signals = new Map(),
  candidates = new Map();
const randomizedPositions = Function(
  'crypto',
  fs
    .readFileSync(
      path.join(__dirname, '../src/resources/js/online_2v2/protocol.js'),
      'utf8'
    )
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?\r?\n/gm, '')
    .replace(/export /g, '') + ';return randomizedPositions;'
)(require('node:crypto').webcrypto);
function handle(data) {
  const { action, id, peerId, side } = data;
  signalingOperations.set(action, (signalingOperations.get(action) || 0) + 1);
  const names = Array.isArray(data.name)
    ? data.name
    : [data.name, ...(data.layout === 'pairs' ? ['Player 2'] : [])];
  if (action === 'publish') {
    rooms.set(id, {
      schema: 'pikavolley-2v2-v5',
      hostId: data.data.hostId,
      layout: data.data.layout,
      status: 'lobby',
    });
    return {};
  }
  if (action === 'unpublish') {
    rooms.delete(id);
    return {};
  }
  if (action === 'requestJoin') {
    signals.set(id + '/' + data.guestId, {
      guestId: data.guestId,
      hostId: data.hostId,
    });
    return {};
  }
  if (action === 'requests')
    return Array.from(signals)
      .filter(([key]) => key.startsWith(id + '/'))
      .map(([key, value]) => [key.slice(id.length + 1), value]);
  if (action === 'clearSignal') {
    signals.delete(id + '/' + peerId);
    for (const key of candidates.keys())
      if (key.startsWith(id + '/' + peerId + '/')) candidates.delete(key);
    return {};
  }
  if (action === 'create') {
    if (rooms.has(id)) throw Error('Room already exists');
    const room = {
      schema: 'pikavolley-2v2-v5',
      hostId: data.hostId,
      layout: data.layout,
      settings: data.settings,
      status: 'lobby',
      networkRevision: 0,
      members: {
        [data.hostId]: {
          name: names[0],
          names,
          slots: data.slots,
          connected: true,
        },
      },
      seats: [0, 1, 2, 3].map((slot) =>
        data.slots.includes(slot) ? data.hostId : ''
      ),
    };
    rooms.set(id, room);
    return room;
  }
  const room = rooms.get(id),
    key = id + '/' + peerId,
    ice = key + '/' + side;
  if (action === 'get') return room || null;
  if (action === 'close') {
    rooms.delete(id);
    for (const map of [signals, candidates])
      for (const key of map.keys())
        if (key.startsWith(id + '/')) map.delete(key);
    return {};
  }
  if (
    !room &&
    !['offer', 'answer', 'signal', 'candidate', 'candidates'].includes(action)
  )
    throw Error('Room not found');
  if (action === 'claim') {
    if (
      room.status !== 'lobby' ||
      room.members[data.clientId] ||
      data.slots.some((slot) => room.seats[slot])
    )
      throw Error('Position unavailable');
    const expected =
      data.slots.length === 0 ||
      (room.layout === 'four'
        ? data.slots.length === 1
        : JSON.stringify(data.slots) === '[0,1]' ||
          JSON.stringify(data.slots) === '[2,3]');
    if (Object.keys(room.members).length >= (room.layout === 'pairs' ? 2 : 4))
      throw Error('This lobby is full.');
    if (!expected) throw Error('Wrong arrangement');
    room.members[data.clientId] = {
      name: names[0],
      names: Array.isArray(data.name)
        ? data.name
        : [data.name, ...(room.layout === 'pairs' ? ['Player 2'] : [])],
      slots: data.slots,
      connected: false,
    };
    data.slots.forEach((slot) => {
      room.seats[slot] = data.clientId;
    });
    return room;
  }
  if (action === 'selectSlots') {
    if (room.status !== 'lobby')
      throw Error('Slots can only change in the lobby.');
    const member = room.members[data.clientId];
    if (!member) throw Error('Join first.');
    if (
      data.slots.some(
        (slot) => room.seats[slot] && room.seats[slot] !== data.clientId
      )
    )
      throw Error('That position is already occupied.');
    member.slots = data.slots;
    room.seats = room.seats.map((owner, slot) =>
      data.slots.includes(slot)
        ? data.clientId
        : owner === data.clientId
        ? ''
        : owner
    );
    return {};
  }
  if (action === 'networkReady') {
    if (room.networkRevision === data.revision && room.members[data.clientId])
      room.members[data.clientId].connected = data.value;
    return {};
  }
  if (action === 'rebuildNetwork') {
    if (data.hostId !== room.hostId) throw Error('Host only.');
    room.networkRevision++;
    room.settings = data.settings;
    room.status = 'lobby';
    Object.values(room.members).forEach((member) => {
      member.connected = false;
    });
    return room;
  }
  if (action === 'randomizeSlots') {
    if (room.hostId !== data.hostId || room.status !== 'lobby')
      throw Error('Host lobby action only.');
    Object.assign(room, randomizedPositions(room));
    return {};
  }
  if (action === 'rename') {
    if (room.status !== 'lobby')
      throw Error('Names can only change in the lobby.');
    room.members[data.clientId].names = data.names;
    room.members[data.clientId].name = data.names[0];
    return {};
  }
  if (action === 'beginMatch') {
    if (
      room.hostId !== data.hostId ||
      Object.values(room.members).some((m) => !m.slots.length)
    )
      throw Error('Every joined player must select a slot before starting.');
    if (Object.values(room.members).some((m) => !m.connected))
      throw Error('Wait for all players to connect before starting.');
    room.settings = data.settings;
    room.status = 'playing';
    return room;
  }
  if (action === 'update') {
    for (const [field, value] of Object.entries(data.value)) {
      const parts = field.split('.');
      let target = room;
      for (const part of parts.slice(0, -1)) target = target[part];
      target[parts[parts.length - 1]] = value;
    }
    return {};
  }
  if (action === 'remove') {
    delete room.members[data.clientId];
    room.seats = room.seats.map((owner) =>
      owner === data.clientId ? '' : owner
    );
    return {};
  }
  if (action === 'offer') {
    signals.set(key, {
      ...signals.get(key),
      ...data.endpoints,
      offer: data.offer,
    });
    return {};
  }
  if (action === 'answer') {
    signals.set(key, { ...signals.get(key), answer: data.answer });
    return {};
  }
  if (action === 'signal') return signals.get(key) || null;
  if (action === 'candidate') {
    if (!candidates.has(ice)) candidates.set(ice, []);
    candidates.get(ice).push(data.candidate);
    return {};
  }
  if (action === 'candidates') return candidates.get(ice) || [];
  throw Error('Unknown test action');
}
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
};
let matchmakingApp;
let versionResponse = null;
const server = http.createServer(async (req, res) => {
  if (req.url.split('?')[0] === '/version.json' && versionResponse) {
    res.writeHead(versionResponse.status, {
      'content-type': 'application/json',
    });
    res.end(JSON.stringify(versionResponse.data));
    return;
  }
  if (req.url === '/v2/match' && matchmakingApp)
    return matchmakingApp(req, res);
  if (req.url === '/__test_signaling' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1000000) {
        res.writeHead(413);
        res.end();
        return;
      }
    }
    try {
      const data = handle(JSON.parse(body));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(data));
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  let file = path.resolve(
    root,
    '.' + decodeURIComponent(req.url.split('?')[0])
  );
  if (!file.startsWith(root + path.sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory())
    file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.setHeader(
    'content-type',
    types[path.extname(file)] || 'application/octet-stream'
  );
  fs.createReadStream(file).pipe(res);
});
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pikavolley-online-'));
let chrome, browser;
const allConnections = [],
  errors = [];
async function cdp(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (entry) entry(message);
    }
    if (message.method === 'Runtime.exceptionThrown')
      errors.push(message.params.exceptionDetails);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id,
        timer = setTimeout(() => reject(Error('CDP timeout ' + method)), 20000);
      pending.set(n, (message) => {
        clearTimeout(timer);
        message.error
          ? reject(Error(JSON.stringify(message.error)))
          : resolve(message.result);
      });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const ev = async (expression) => {
    const value = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (value.exceptionDetails)
      throw Error(JSON.stringify(value.exceptionDetails));
    return value.result.value;
  };
  const until = async (expression) => {
    for (let i = 0; i < 250; i++) {
      if (await ev(expression)) return;
      await delay(80);
    }
    throw Error(
      'Condition timed out: ' +
        expression +
        '; replayError=' +
        (await ev(
          'document.getElementById("replay-error-detail")?.textContent'
        )) +
        '; status=' +
        (await ev('document.getElementById("status")?.textContent')) +
        '; debug=' +
        JSON.stringify(
          await ev(
            '({phase:window.__volley?.session.phase,status:window.__volley?.room.data?.status,isHost:window.__volley?.room.isHost,closed:window.__volley?.room.closed,back:window.backDebug,network:window.__volley?.room&&{revision:__volley.room.data?.networkRevision,hold:__volley.room.rebuildingTarget,fault:__volley.room.networkFault,flags:Object.fromEntries(Object.entries(__volley.room.data?.members||{}).map(([id,m])=>[id,m.connected])),reports:Array.from(__volley.room.readyReports),writes:Array.from(__volley.room.readyWrites),peers:Array.from(__volley.room.peers).map(([id,p])=>({id,pc:p.pc.connectionState,channel:p.channel?.readyState,closed:p.notifiedClosed}))}})'
          )
        )
    );
  };
  const result = { ws, send, ev, until };
  allConnections.push(result);
  return result;
}
async function tab(port, lang = 'en', injected = true, existingContext = null) {
  const context = existingContext
    ? { browserContextId: existingContext }
    : await browser.send('Target.createBrowserContext');
  const target = await browser.send('Target.createTarget', {
    url: 'about:blank',
    browserContextId: context.browserContextId,
  });
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = await cdp(
    list.find((item) => item.id === target.targetId).webSocketDebuggerUrl
  );
  page.targetId = target.targetId;
  page.contextId = context.browserContextId;
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  if (injected)
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source:
        fs.readFileSync(path.join(__dirname, 'browser-store.js'), 'utf8') +
        (process.env.PIKA_QUICK_MATCH_SERVER
          ? '\nwindow.__PIKA_TEST_MATCH_URL__=location.origin;'
          : ''),
    });
  await page.send('Page.navigate', {
    url: `http://127.0.0.1:${server.address().port}/${lang}/`,
  });
  await page.until(
    '!!window.__volley && !document.getElementById("create").disabled'
  );
  if (process.env.PIKA_DIAGNOSTICS_ONLY)
    await page.ev(
      'document.getElementById("auto-save-replay-checkbox").checked=false;document.getElementById("auto-save-replay-checkbox").dispatchEvent(new Event("change"))'
    );
  return page;
}
async function assertConnections(host, guests, topology) {
  for (const page of [host, ...guests]) {
    try {
      await page.until(
        '__volley.room.ready() && Object.values(__volley.room.data.members).every(m=>m.connected)'
      );
    } catch (error) {
      for (const item of [host, ...guests])
        console.error(
          'Connection diagnostic:',
          await item.ev(
            'JSON.stringify({self:__volley.room.selfId,data:__volley.room.data,hold:__volley.room.rebuildingTarget,reports:Array.from(__volley.room.readyReports),peers:Array.from(__volley.room.peers).map(([id,p])=>({id,state:p.pc.connectionState,ice:p.pc.iceConnectionState,signaling:p.pc.signalingState,channel:p.channel?.readyState,closed:p.notifiedClosed,remote:p.pc.remoteDescription?.type,local:p.pc.localDescription?.type,queued:p.candidates.length}))})'
          )
        );
      throw error;
    }
    assert.equal(
      await page.ev('__volley.room.peers.size'),
      topology === 'mesh' || page === host ? guests.length : 1
    );
    assert.equal(
      await page.ev(
        'Array.from(__volley.room.peers.keys()).every(id=>__volley.room.connected(id))'
      ),
      true
    );
  }
}
async function switchTopology(host, guests, topology) {
  const seats = await host.ev('__volley.room.data.seats');
  const revision = await host.ev('__volley.room.data.networkRevision');
  const wasPlaying = await host.ev('!!__volley.session.epoch');
  await click(host, 'options-dropdown-btn');
  await click(host, 'court-submenu-btn');
  await screenshot(host, 'network-layout-' + topology + '.png');
  await host.ev(
    'document.getElementById("topology").value=' + JSON.stringify(topology)
  );
  await click(host, 'settings-apply');
  if (wasPlaying) await click(host, 'settings-confirm-yes');
  for (const page of [host, ...guests]) {
    await page.until(
      '__volley.room.data.networkRevision>' +
        revision +
        ' && __volley.session.phase==="idle" && __volley.room.data.settings.topology===' +
        JSON.stringify(topology)
    );
    assert.deepEqual(await page.ev('__volley.room.data.seats'), seats);
  }
  await assertConnections(host, guests, topology);
  assert.equal(
    await guests[0].ev('document.getElementById("topology").disabled'),
    true
  );
}
async function randomizeLobby(host, guests) {
  const pages = [host, ...guests];
  const before = await host.ev('__volley.room.data.members');
  await click(host, 'randomize-slots');
  await host.until(
    'document.getElementById("status").textContent.includes("Positions randomized") || document.getElementById("status").textContent.includes("무작위로 배정")'
  );
  const data = await host.ev('__volley.room.data');
  for (const page of pages) {
    await page.until(
      'JSON.stringify(__volley.room.data.seats)===' +
        JSON.stringify(JSON.stringify(data.seats))
    );
    const me = await page.ev('__volley.room.selfId');
    const slots = data.members[me].slots;
    assert.ok(
      data.layout === 'pairs'
        ? JSON.stringify(slots) === '[0,1]' || JSON.stringify(slots) === '[2,3]'
        : slots.length === 1
    );
    assert.deepEqual(data.members[me].names, before[me].names);
    assert.equal(data.members[me].connected, before[me].connected);
    for (const slot of slots) assert.equal(data.seats[slot], me);
  }
  for (const guest of guests)
    assert.equal(
      await guest.ev('document.getElementById("randomize-slots").hidden'),
      true
    );
  // Restore the fixture's known slots before testing player-specific controls.
  for (const page of pages) {
    await click(page, 'cancel-slot');
    await page.until(
      '__volley.room.data.members[__volley.room.selfId].slots.length===0'
    );
  }
  console.log(
    'Random lobby positions: atomic host assignment, pair integrity, names, readiness and all-peer synchronization passed.'
  );
}
async function liveOption(host, guests, menu, button, condition) {
  const expression =
    'JSON.stringify({epoch:__volley.session.epoch,physics:__volley.game.physics,scores:__volley.game.scores,state:__volley.game.state.name,counter:__volley.game.frameCounter,serve:__volley.game.isPlayer2Serve,slow:[__volley.game.slowMotionFramesLeft,__volley.game.slowMotionNumOfSkippedFrames]})';
  const before = await host.ev(expression);
  await click(host, 'options-dropdown-btn');
  await click(host, menu);
  await click(host, button);
  await click(host, 'settings-confirm-yes');
  for (const page of [host, ...guests]) await page.until(condition);
  assert.equal(
    await host.ev(expression),
    before,
    'Live options must retain the paused match, score, serving rotation and rally'
  );
}
async function observeLocalSimulation(page) {
  await page.ev(
    'window.localSteps=0;const step=__volley.session.step.bind(__volley.session);__volley.session.step=()=>{localSteps++;return step();}'
  );
}
async function assertSameSimulation(host, guests) {
  if (await host.ev('__volley.session.phase==="playing"'))
    await click(host, 'pause');
  for (const guest of guests)
    await guest.until('__volley.session.phase==="paused"');
  const expression =
    'JSON.stringify({frame:__volley.session.lastFrame,physics:__volley.game.physics,scores:__volley.game.scores,state:__volley.game.state.name,counter:__volley.game.frameCounter,slow:[__volley.game.slowMotionFramesLeft,__volley.game.slowMotionNumOfSkippedFrames],roundEnded:__volley.game.roundEnded,serve:__volley.game.isPlayer2Serve,clouds:__volley.game.view.game.cloudArray,wave:__volley.game.view.game.wave})';
  const expected = await host.ev(expression);
  for (const guest of guests)
    assert.equal(
      await guest.ev(expression),
      expected,
      'Every browser must independently reach identical full simulation state'
    );
}
async function click(page, id) {
  if (id === 'back-lobby')
    await page.ev(
      'window.backDebug=[];document.getElementById("back-lobby").addEventListener("click",()=>backDebug.push({stage:"capture",disabled:document.getElementById("back-lobby").disabled,phase:__volley.session.phase,isHost:__volley.room.isHost}),{capture:true,once:true});document.addEventListener("click",()=>backDebug.push({stage:"bubbled",phase:__volley.session.phase,status:__volley.room.data.status}),{once:true});'
    );
  if (['create', 'join'].includes(id))
    await page.ev(
      "document.getElementById('about-with-your-friend').hidden=false"
    );
  await page.until(
    '(()=>{const button=document.getElementById(' +
      JSON.stringify(id) +
      ');if(button.disabled)return false;button.click();return true;})()'
  );
  // Leaving a hosted lobby includes an asynchronous rendezvous cleanup.
  if (id === 'leave')
    await page.until('!document.getElementById("create").disabled');
}
async function join(page, roomId, slot) {
  assert.equal(await page.ev('document.getElementById("find") === null'), true);
  await page.ev(`document.getElementById('room-id').value='${roomId}'`);
  await click(page, 'join');
  await page.until(
    '!__volley.room.closed && Array.from(__volley.room.peers.keys()).some(id=>__volley.room.connected(id))'
  );
  assert.deepEqual(
    await page.ev('__volley.room.data.members[__volley.room.selfId].slots'),
    []
  );
  await selectSlot(page, slot);
}
async function selectSlot(page, slot) {
  const selector = JSON.stringify('[data-slots="' + slot + '"]');
  await page.until(
    '!!document.querySelector(' +
      selector +
      ') && !document.querySelector(' +
      selector +
      ').disabled'
  );
  await page.ev('document.querySelector(' + selector + ').click()');
  await page.until(
    'JSON.stringify(__volley.room.data.members[__volley.room.selfId].slots)===' +
      JSON.stringify(JSON.stringify(slot.split(',').map(Number)))
  );
}
async function key(page, code, type) {
  await page.send('Input.dispatchKeyEvent', {
    type,
    code,
    key: code.startsWith('Arrow')
      ? code
      : code.replace('Key', '').toLowerCase(),
  });
}
async function assertLegacyReplay(port) {
  const loadLegacy = (file, name) =>
    Function(
      fs
        .readFileSync(
          path.join(__dirname, '../src/resources/js/utils', file),
          'utf8'
        )
        .replace(/export /g, '') +
        ';return ' +
        name +
        ';'
    )();
  const serialize = loadLegacy('serialize.js', 'serialize'),
    hash = loadLegacy('hash_code.js', 'getHashCode');
  const legacyPack = {
    version: 'p2p-online',
    roomID: 'a'.repeat(20),
    nicknames: ['Legacy A', 'Legacy B'],
    partialPublicIPs: ['1.2.*.*', '3.4.*.*'],
    chats: [
      [10, 1, 'Legacy left'],
      [20, 2, '<b>Legacy right</b>'],
      [25, 1, 'Hidden message'],
      [40, 1, 'Legacy after toggle'],
    ],
    options: [],
    inputs: Array(120).fill(0),
    hash: 0,
  };
  legacyPack.hash = hash(serialize(legacyPack));
  const legacy = await tab(port, 'en');
  await legacy.send('Page.navigate', {
    url: await legacy.ev('new URL("replay/", location.href).href'),
  });
  await legacy.until('!!window.__replayPlayer');
  await legacy.ev(
    '(()=>{const transfer=new DataTransfer();transfer.items.add(new File([' +
      JSON.stringify(JSON.stringify({ pack: legacyPack })) +
      '],"old.txt",{type:"text/plain"}));const input=document.getElementById("file-input");input.files=transfer.files;input.dispatchEvent(new Event("change"));})()'
  );
  await legacy.until('!!window.__replayPlayer.pikaVolley');
  assert.equal(
    await legacy.ev(
      'document.getElementById("dropbox").classList.contains("hidden")'
    ),
    true
  );
  await legacy.ev('__replayPlayer.ticker.stop();__replayPlayer.seekFrame(80)');
  assert.equal(
    await legacy.ev('__replayPlayer.pikaVolley.replayFrameCounter'),
    80
  );
  assert.equal(await legacy.ev('!!__replayPlayer.doubles'), false);
  await legacy.ev(
    '__replayPlayer.seekFrame(0);for(let i=0;i<21;i++)__replayPlayer.pikaVolley.gameLoop();__replayPlayer.renderer.render(__replayPlayer.stage)'
  );
  assert.equal(
    await legacy.ev('document.getElementById("player1-chat-box").textContent'),
    'Legacy left'
  );
  assert.equal(
    await legacy.ev('document.getElementById("player2-chat-box").textContent'),
    '<b>Legacy right</b>'
  );
  assert.equal(
    await legacy.ev(
      'document.getElementById("player2-chat-box").children.length'
    ),
    0
  );
  const seeded = require('seedrandom').alea('aaaaa');
  const expectedTop = 20 + 30 * seeded(),
    expectedOffset = 55 + 25 * seeded();
  const positions = await legacy.ev(
    '[1,2].map(n=>{const style=document.getElementById("player"+n+"-chat-box").style;return {top:parseFloat(style.top),offset:parseFloat(n===1?style.right:style.left)}})'
  );
  console.log(
    'Legacy chat positions:',
    JSON.stringify({ expectedTop, expectedOffset, positions })
  );
  // CSSOM serializes percentages with limited decimal precision.
  for (const position of positions) {
    assert.ok(Math.abs(position.top - expectedTop) < 0.0001);
    assert.ok(Math.abs(position.offset - expectedOffset) < 0.0001);
  }
  await legacy.until(
    'Number(getComputedStyle(document.getElementById("player1-chat-box")).opacity)>0.9'
  );
  await legacy.ev(
    'document.getElementById("show-chat-checkbox").checked=false;document.getElementById("show-chat-checkbox").dispatchEvent(new Event("change"));for(let i=21;i<31;i++)__replayPlayer.pikaVolley.gameLoop()'
  );
  assert.equal(
    await legacy.ev('document.getElementById("player1-chat-box").textContent'),
    'Legacy left'
  );
  assert.equal(
    await legacy.ev(
      'document.getElementById("player1-chat-box").classList.contains("hidden")'
    ),
    true
  );
  await legacy.ev(
    'document.getElementById("show-chat-checkbox").checked=true;document.getElementById("show-chat-checkbox").dispatchEvent(new Event("change"));for(let i=31;i<41;i++)__replayPlayer.pikaVolley.gameLoop()'
  );
  assert.equal(
    await legacy.ev('document.getElementById("player1-chat-box").textContent'),
    'Legacy after toggle'
  );
  assert.deepEqual(
    await legacy.ev(
      '[1,2].map(n=>document.getElementById("player"+n+"-nickname").textContent).sort()'
    ),
    ['Legacy A', 'Legacy B']
  );
  assert.deepEqual(
    await legacy.ev(
      '[1,2].map(n=>document.getElementById("player"+n+"-partial-ip").textContent).sort()'
    ),
    ['1.2.*.*', '3.4.*.*']
  );
  await legacy.ev(
    'document.getElementById("show-ip-addresses-checkbox").checked=true;document.getElementById("show-ip-addresses-checkbox").dispatchEvent(new Event("change"))'
  );
  assert.equal(
    await legacy.ev(
      'document.getElementById("player1-partial-ip").classList.contains("hidden")'
    ),
    false
  );
  await screenshot(legacy, 'legacy-replay-chat-preserved.png');
  console.log(
    'Legacy replay: original seeded chat positions, painted visibility, safe text, local chat toggle, nicknames and recorded partial-IP display passed without the retired networking stack.'
  );
}
async function screenshot(page, name) {
  const data = await page.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
  });
  fs.writeFileSync(
    path.join(artifacts, name),
    Buffer.from(data.data, 'base64')
  );
}
(async () => {
  if (process.env.PIKA_QUICK_MATCH_SERVER) {
    const { pathToFileURL } = require('node:url');
    const serverRoot = path.resolve(process.env.PIKA_QUICK_MATCH_SERVER);
    const { createApp } = await import(
      pathToFileURL(path.join(serverRoot, 'src/http_app.js')).href
    );
    matchmakingApp = createApp({
      verifyToken: async (token) => {
        if (!/^test[a-f0-9]+$/.test(token)) throw Error('Invalid test token');
        return { uid: token };
      },
      development: true,
    });
  }
  fs.mkdirSync(artifacts, { recursive: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const executable =
    process.env.PIKA_CHROME ||
    (process.platform === 'win32'
      ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
      : 'google-chrome');
  chrome = spawn(
    executable,
    [
      '--headless=new',
      '--mute-audio',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--remote-debugging-port=0',
      '--window-size=1280,1000',
      '--user-data-dir=' + profile,
      'about:blank',
    ],
    { windowsHide: true, stdio: 'ignore' }
  );
  chrome.on('error', (error) => {
    console.error(error.message);
  });
  const active = path.join(profile, 'DevToolsActivePort');
  let port;
  for (let i = 0; i < 100; i++) {
    try {
      if (fs.existsSync(active)) {
        const value = Number(fs.readFileSync(active, 'utf8').split('\n')[0]);
        if (Number.isInteger(value) && value > 0) {
          port = value;
          break;
        }
      }
    } catch (error) {
      if (!['EBUSY', 'ENOENT'].includes(error.code)) throw error;
    }
    await delay(100);
  }
  assert.ok(port, 'Chrome must be installed or PIKA_CHROME set');
  const version = await (
    await fetch(`http://127.0.0.1:${port}/json/version`)
  ).json();
  browser = await cdp(version.webSocketDebuggerUrl);
  const configSource = fs.readFileSync(
    path.join(__dirname, '../src/resources/js/online_2v2/config.js'),
    'utf8'
  );
  if (
    /export\s*\{\s*firebaseConfig\s*\}|apiKey:\s*['"]YOUR_/.test(configSource)
  ) {
    const unconfigured = await tab(port, 'en', false);
    await click(unconfigured, 'create');
    await unconfigured.until(
      'document.getElementById("status").textContent.includes("Configure your new Firebase project")'
    );
    console.log('Unconfigured page reports setup instructions.');
  } else
    console.log(
      'Live Firebase configuration detected; live requests skipped. All room tests use local fixtures.'
    );
  const host = await tab(port);
  if (process.env.PIKA_LEGACY_REPLAY_ONLY) {
    await assertLegacyReplay(port);
    assert.deepEqual(errors, []);
    return;
  }
  if (process.env.PIKA_INPUT_PACING_ONLY) {
    const guest = await tab(port);
    // A delayed begin reproduces a host starting its interval before the guest.
    // Both clock probes and gameplay inputs traverse the same delayed transport.
    for (const page of [host, guest])
      await page.ev(`(()=>{
      const room=__volley.room,send=room.send.bind(room);
      room.send=(id,packet,drop)=>{
        const delay=packet.type==='begin'?30:10;
        setTimeout(()=>send(id,packet,drop),delay);return true;
      };
      const s=__volley.session,init=s.initialize;
      s.initialize=function(...args){
        const result=init.apply(this,args),d=this.lockstep;
        if(window.legacyTiming){this.inputPacer.stop();this.inputPacer=null;this.inputTimer=setInterval(()=>this.tick(true),1000/this.settings.fps);}
        const times=new Map(),sample=d.sample,advance=d.advance;
        window.timing={age:[],lead:[],step:[]};
        d.sample=function(v){times.set(this.sampled+1,performance.now());timing.lead.push(this.sampled-this.frame);return sample.call(this,v);};
        d.advance=function(v,h,f){const at=performance.now();if(times.has(f))timing.age.push(at-times.get(f));const result=advance.call(this,v,h,f);timing.step.push(performance.now()-at);return result;};
        return result;
      };
      document.getElementById('auto-save-replay-checkbox').checked=false;
      document.getElementById('auto-save-replay-checkbox').dispatchEvent(new Event('change'));
    })()`);
    const results = [];
    for (const legacy of [true, false]) {
      for (const page of [host, guest])
        await page.ev('window.legacyTiming=' + legacy + ';window.timing=null');
      await click(host, 'create');
      await host.until('!__volley.room.closed');
      await selectSlot(host, '0');
      await join(guest, await host.ev('__volley.room.id'), '2');
      await host.until('!document.getElementById("start").disabled');
      await click(host, 'start');
      for (const page of [host, guest])
        await page.until('window.timing?.age.length>100');
      const stats = `(()=>{const average=a=>a.slice(20).reduce((s,n)=>s+n,0)/(a.length-20);return {age:average(timing.age),lead:average(timing.lead),physics:average(timing.step)}})()`;
      const result = {
        legacy,
        host: await host.ev(stats),
        guest: await guest.ev(stats),
      };
      results.push(result);
      console.log('Input pacing measurement:', JSON.stringify(result));
      await assertSameSimulation(host, [guest]);
      if (!legacy) {
        const before = await host.ev('__volley.session.lastFrame');
        await click(host, 'pause');
        await guest.until('!__volley.game.paused');
        await host.until('__volley.session.lastFrame>' + String(before + 20));
        await assertSameSimulation(host, [guest]);
      }
      await click(guest, 'leave');
      await click(host, 'leave');
    }
    // Exact latency depends on browser scheduling. Deterministic clock-skew tests
    // enforce fairness; this real-browser check also guards against added backlog.
    assert.equal(
      await host.ev(
        'JSON.stringify(__volley.session.replay.pack).includes("pacing-")'
      ),
      false
    );
    const paced = results[1];
    assert.ok(
      paced.host.lead < 1.5 && paced.guest.lead < 1.5,
      'Aligned sampling should not keep two-frame local backlogs'
    );
    assert.ok(
      paced.host.age < 100 && paced.guest.age < 100,
      'Local fixture should not acquire a fixed three-frame input delay'
    );
    assert.deepEqual(errors, []);
    console.log(
      'Input pacing: old/new timing, delayed startup, identical physics, pause/resume and bounded latency passed.'
    );
    return;
  }
  if (process.env.PIKA_CONNECTION_UI_ONLY) {
    await host.ev(
      'const store=__volley.room.transport,publish=store.publish.bind(store);store.publish=async(...args)=>{await new Promise(resolve=>window.releaseCreate=resolve);store.publish=publish;return publish(...args)}'
    );
    await click(host, 'create');
    await host.until(
      '!!window.releaseCreate && document.getElementById("connecting-screen").open'
    );
    assert.equal(
      await host.ev('document.getElementById("connecting-title").textContent'),
      'Creating the room…'
    );
    await host.ev('releaseCreate()');
    await host.until(
      '!!__volley.room.data && !document.getElementById("connecting-screen").open'
    );
    await host.until('!__volley.room.closed');
    await selectSlot(host, '0');
    const id = await host.ev('__volley.room.id');
    const guest = await tab(port, 'ko');
    await guest.ev(
      `(()=>{const store=__volley.room.transport,peek=store.peek.bind(store),join=store.requestJoin.bind(store);store.peek=async(...args)=>{await new Promise(resolve=>window.releaseLookup=resolve);store.peek=peek;return peek(...args);};store.requestJoin=async(...args)=>{await new Promise(resolve=>window.releaseHandshake=resolve);return join(...args);};})()`
    );
    await guest.ev(
      'document.getElementById("room-id").value=' + JSON.stringify(id)
    );
    await click(guest, 'join');
    await guest.until(
      'document.getElementById("connecting-screen").open && !!window.releaseLookup'
    );
    assert.equal(
      await guest.ev('document.getElementById("connecting-title").textContent'),
      '방장에게 연결 중…'
    );
    await guest.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    assert.equal(
      await guest.ev(
        '(()=>{const r=document.getElementById("connecting-screen").getBoundingClientRect();return r.left>=0 && r.right<=innerWidth;})()'
      ),
      true
    );
    await screenshot(guest, 'connecting-screen-ko-mobile.png');
    await guest.ev('releaseLookup()');
    await guest.until('!!window.releaseHandshake');
    assert.equal(
      await guest.ev('document.getElementById("connecting-screen").open'),
      true,
      'Must stay open through the WebRTC handshake'
    );
    await guest.ev('releaseHandshake()');
    await guest.until(
      '__volley.room.connected(__volley.room.data.hostId) && !document.getElementById("connecting-screen").open'
    );
    await selectSlot(guest, '2');
    for (const page of [host, guest]) {
      const heights = await page.ev(
        '["invite-link","copy-link","copy-code"].map(id=>document.getElementById(id).getBoundingClientRect().height)'
      );
      assert.ok(heights[0] > 0);
      assert.equal(heights[1], heights[0]);
      assert.equal(heights[2], heights[0]);
    }

    await host.ev(
      'window.copied=[];Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async value=>{copied.push(value)}}})'
    );
    for (const button of ['copy-link', 'copy-code']) {
      const before = await host.ev(
        '(()=>{const b=document.getElementById(' +
          JSON.stringify(button) +
          ');b.focus();const r=b.getBoundingClientRect();return {width:r.width,height:r.height,label:b.textContent}})()'
      );
      await click(host, button);
      await host.until(
        'document.getElementById(' +
          JSON.stringify(button) +
          ').classList.contains("copy-confirmed")'
      );
      const after = await host.ev(
        '(()=>{const b=document.getElementById(' +
          JSON.stringify(button) +
          ');const r=b.getBoundingClientRect();return {width:r.width,height:r.height,check:b.querySelector(".copy-result").textContent,focused:document.activeElement===b}})()'
      );
      assert.equal(after.width, before.width);
      assert.equal(after.height, before.height);
      assert.equal(after.check, '✓');
      assert.equal(after.focused, true);
      await click(host, button);
      await delay(800);
      assert.equal(
        await host.ev(
          'document.getElementById(' +
            JSON.stringify(button) +
            ').classList.contains("copy-confirmed")'
        ),
        true
      );
      await host.until(
        '!document.getElementById(' +
          JSON.stringify(button) +
          ').classList.contains("copy-confirmed")'
      );
      assert.equal(
        await host.ev(
          'document.getElementById(' + JSON.stringify(button) + ').textContent'
        ),
        before.label
      );
    }
    await click(host, 'copy-code');
    await host.until(
      'document.getElementById("copy-code").classList.contains("copy-confirmed")'
    );
    await host.until(
      'Number(getComputedStyle(document.querySelector("#copy-code .copy-result")).opacity)>0.9'
    );
    await screenshot(host, 'copy-code-confirmation.png');
    await host.ev(
      'navigator.clipboard.writeText=async()=>{throw Error("denied")}'
    );
    await click(host, 'copy-code');
    await host.until(
      'getSelection().toString()===document.getElementById("room-code").textContent'
    );
    assert.equal(
      await host.ev(
        'document.getElementById("copy-code").classList.contains("copy-confirmed")'
      ),
      false,
      'Clipboard failure must not claim success'
    );
    const failed = await tab(port, 'zh');
    await failed.ev(
      'document.getElementById("room-id").value="a".repeat(20);const store=__volley.room.transport,peek=store.peek.bind(store);store.peek=async(...args)=>{await new Promise(resolve=>window.releaseFailure=resolve);return peek(...args)}'
    );
    await click(failed, 'join');
    await failed.until(
      '!!window.releaseFailure && document.getElementById("connecting-screen").open'
    );
    assert.equal(
      await failed.ev(
        'document.querySelector("#connecting-screen p").textContent'
      ),
      '連線建立中，請稍候。'
    );
    await failed.ev('releaseFailure()');
    await failed.until(
      '!document.getElementById("connecting-screen").open && document.getElementById("status").classList.contains("error")'
    );
    // Direct joins are also used by Quick Match, without the manual lookup wrapper.
    await failed.ev(
      'window.releaseFailure=null;window.joinAttempt=__volley.room.join("b".repeat(20),["Test"],[]).catch(()=>{});true'
    );
    await failed.until(
      '!!window.releaseFailure && document.getElementById("connecting-screen").open'
    );
    await failed.ev('releaseFailure();joinAttempt');
    assert.equal(
      await failed.ev('document.getElementById("connecting-screen").open'),
      false
    );
    await failed.ev(
      '(()=>{const store=__volley.room.transport;store.publish=async()=>{await new Promise(resolve=>window.releaseCreateFailure=resolve);throw Error("Creation failed fixture")};})()'
    );
    await click(failed, 'create');
    await failed.until(
      '!!window.releaseCreateFailure && document.getElementById("connecting-screen").open'
    );
    assert.equal(
      await failed.ev(
        'document.getElementById("connecting-title").textContent'
      ),
      '正在建立房間…'
    );
    await failed.ev('releaseCreateFailure()');
    await failed.until(
      '!document.getElementById("connecting-screen").open && __volley.room.closed && document.getElementById("status").classList.contains("error")'
    );
    await click(guest, 'leave');
    await click(host, 'leave');
    assert.deepEqual(errors, []);
    console.log(
      'Connection/copy feedback: lookup and handshake progress, failure cleanup, direct Quick Match join path, translated mobile dialog, repeatable copy checks, stable dimensions, focus and clipboard failure passed.'
    );
    return;
  }
  if (process.env.PIKA_SOLO_EXIT_ONLY) {
    const guests = [
      await tab(port),
      await tab(port, 'ko'),
      await tab(port, 'zh'),
    ];
    for (const page of [host, ...guests])
      await page.ev(
        'document.getElementById("auto-save-replay-checkbox").checked=false;document.getElementById("auto-save-replay-checkbox").dispatchEvent(new Event("change"))'
      );
    for (const [sync, topology] of [
      ['lockstep', 'mesh'],
      ['lockstep', 'star'],
      ['host', 'mesh'],
    ]) {
      await host.ev(
        'document.getElementById("layout").value="four";document.getElementById("synchronization").value=' +
          JSON.stringify(sync) +
          ';document.getElementById("topology").value=' +
          JSON.stringify(topology)
      );
      await click(host, 'create');
      await host.until('!__volley.room.closed');
      await selectSlot(host, '0');
      const id = await host.ev('__volley.room.id');
      const lobby = async (page) => {
        await page.until(
          '!__volley.room.closed && __volley.room.isHost && __volley.room.data.status==="lobby" && __volley.session.epoch===null && Object.keys(__volley.room.data.members).length===1'
        );
        assert.equal(await page.ev('__volley.room.id'), id);
        assert.equal(await page.ev('__volley.game.paused'), true);
        assert.equal(
          await page.ev('document.getElementById("start").disabled'),
          true
        );
        assert.match(
          await page.ev(
            '__volley.session.start(__volley.room.data.settings).then(()=>"started",e=>e.message)'
          ),
          /At least two connected players/
        );
        assert.equal(await page.ev('__volley.session.epoch'), null);

        assert.equal(await page.ev('__volley.session.inputPacer===null'), true);
      };
      const start = async (owner) => {
        await owner.until('!document.getElementById("start").disabled');
        await click(owner, 'start');
        await owner.until(
          '__volley.session.epoch!==null && __volley.session.phase==="playing" && __volley.room.data.status==="playing" && (__volley.room.isHost && !__volley.session.lockstep ? __volley.session.frame:__volley.session.lastFrame)>10'
        );
      };
      for (let n = 0; n < 3; n++) await join(guests[n], id, String(n + 1));
      await start(host);
      await click(guests[0], 'leave');
      await host.until(
        'Object.keys(__volley.room.data.members).length===3 && __volley.game.players[1].isComputer'
      );
      assert.ok(await host.ev('__volley.session.epoch!==null'));
      await Promise.all([click(guests[1], 'leave'), click(guests[2], 'leave')]);
      await lobby(host);
      assert.deepEqual(
        await host.ev('__volley.room.data.members[__volley.room.selfId].slots'),
        [0]
      );
      const frame = await host.ev('__volley.game.frameCounter');
      await delay(100);
      assert.equal(
        await host.ev('__volley.game.frameCounter'),
        frame,
        'No AI-only continuation after returning to lobby'
      );
      await join(guests[0], id, '2');
      await start(host);
      const names = await guests[0].ev(
        '__volley.room.data.members[__volley.room.selfId].names'
      );
      await click(host, 'leave');
      await lobby(guests[0]);
      assert.deepEqual(
        await guests[0].ev(
          '__volley.room.data.members[__volley.room.selfId].slots'
        ),
        [2]
      );
      assert.deepEqual(
        await guests[0].ev(
          '__volley.room.data.members[__volley.room.selfId].names'
        ),
        names
      );
      await join(host, id, '0');
      await start(guests[0]);
      await guests[0].ev('__volley.room.shutdown();__volley.session.stop()');
      await lobby(host);
      await join(guests[0], id, '2');
      await start(host);
      await guests[0].ev('__volley.room.shutdown();__volley.session.stop()');
      await lobby(host);
      await click(host, 'leave');
      console.log(
        'Solo exit passed:',
        sync,
        topology,
        'concurrent departures, AI with multiple humans, blocked solo start, graceful/abrupt host promotion and guest loss.'
      );
    }
    assert.deepEqual(errors, []);
    assert.equal(rooms.size, 0);
    return;
  }
  if (process.env.PIKA_DUO_ABORT_ONLY) {
    const guest = await tab(port, 'ko');
    for (const mode of ['lockstep', 'host']) {
      console.log('Testing duo abort:', mode);
      for (const page of [host, guest])
        await page.ev(
          'document.getElementById("auto-save-replay-checkbox").checked=false;document.getElementById("auto-save-replay-checkbox").dispatchEvent(new Event("change"))'
        );
      await host.ev(
        'document.getElementById("layout").value="pairs";document.getElementById("synchronization").value=' +
          JSON.stringify(mode) +
          ';document.getElementById("layout").dispatchEvent(new Event("change"))'
      );
      await click(host, 'create');
      await host.until('!__volley.room.closed');
      await selectSlot(host, '0,1');
      const id = await host.ev('__volley.room.id');
      const start = async (owner) => {
        await owner.until('!document.getElementById("start").disabled');
        await click(owner, 'start');
        for (const page of [host, guest])
          await page.until(
            '(__volley.room.isHost && !__volley.session.lockstep ? __volley.session.frame : __volley.session.lastFrame)>10'
          );
      };
      const lobby = async (page) => {
        await page.until(
          '!__volley.room.closed && __volley.room.isHost && __volley.room.data.status==="lobby" && !__volley.session.epoch && Object.keys(__volley.room.data.members).length===1'
        );
        assert.equal(await page.ev('__volley.room.id'), id);
        assert.equal(
          await page.ev('document.getElementById("start").disabled'),
          true
        );
        assert.equal(await page.ev('__volley.game.paused'), true);
        assert.equal(
          await page.ev('__volley.room.data.settings.synchronization'),
          mode
        );
      };
      await join(guest, id, '2,3');
      const guestNames = await guest.ev(
        '__volley.room.data.members[__volley.room.selfId].names'
      );
      await start(host);
      await click(guest, 'leave');
      await lobby(host);
      await join(guest, id, '2,3');
      await start(host);
      await click(host, 'leave');
      await lobby(guest);
      assert.deepEqual(
        await guest.ev(
          '__volley.room.data.members[__volley.room.selfId].names'
        ),
        guestNames
      );
      assert.deepEqual(
        await guest.ev(
          '__volley.room.data.members[__volley.room.selfId].slots'
        ),
        [2, 3]
      );
      await join(host, id, '0,1');
      await start(guest);
      await host.ev('__volley.room.shutdown();__volley.session.stop()');
      await lobby(guest);
      await join(host, id, '0,1');
      await start(guest);
      await guest.ev('__volley.room.shutdown();__volley.session.stop()');
      await lobby(host);
      await click(host, 'leave');
    }
    assert.deepEqual(errors, []);
    assert.equal(rooms.size, 0);
    console.log(
      'Duo abort: guest/host graceful leave and abrupt channel loss, same-code host takeover, names/slots/settings, rejoin/rematch and blocked solo restart passed in lockstep and host physics.'
    );
    return;
  }
  if (process.env.PIKA_LOBBY_LAYOUT_ONLY) {
    const pages = [host, await tab(port, 'ko'), await tab(port, 'zh')];
    for (const page of pages) {
      await page.ev(
        'document.getElementById("layout").value="pairs";document.getElementById("layout").dispatchEvent(new Event("change"));document.getElementById("auto-save-replay-checkbox").checked=false;document.getElementById("auto-save-replay-checkbox").dispatchEvent(new Event("change"))'
      );
      await click(page, 'create');
      await page.until('!!__volley.room.data');
      await selectSlot(page, '0,1');
      assert.equal(
        await page.ev('document.getElementById("start").disabled'),
        true
      );
      assert.match(
        await page.ev(
          '__volley.session.start(__volley.room.data.settings).then(()=>"started",e=>e.message)'
        ),
        /Two connected duo clients/
      );
      for (const width of [390, 760, 1200]) {
        await page.send('Emulation.setDeviceMetricsOverride', {
          width,
          height: 844,
          deviceScaleFactor: 1,
          mobile: width === 390,
        });
        const boxes = await page.ev(
          '(()=>{const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width}};return {parent:rect(document.querySelector(".invite-controls")),items:["invite-link","copy-link","copy-code"].map(id=>rect(document.getElementById(id)))}})()'
        );
        for (const item of boxes.items) {
          assert.ok(item.width > 0);
          assert.ok(
            item.left >= boxes.parent.left - 1 &&
              item.right <= boxes.parent.right + 1,
            'Invitation controls must fit their container'
          );
        }
        for (let a = 0; a < 3; a++)
          for (let b = a + 1; b < 3; b++) {
            const x = boxes.items[a],
              y = boxes.items[b];
            assert.ok(
              x.right <= y.left + 1 ||
                y.right <= x.left + 1 ||
                x.bottom <= y.top + 1 ||
                y.bottom <= x.top + 1,
              'Invitation controls must not overlap'
            );
          }
      }
    }
    await screenshot(pages[2], 'invitation-controls-zh.png');
    const id = await host.ev('__volley.room.id');
    await click(pages[1], 'leave');
    await click(pages[2], 'leave');
    await join(pages[1], id, '2,3');
    await host.until('!document.getElementById("start").disabled');
    await click(host, 'start');
    for (const page of [host, pages[1]])
      await page.until('__volley.session.lastFrame>10');
    await click(host, 'back-lobby');
    await host.until('__volley.room.data.status==="lobby"');
    await click(pages[1], 'leave');
    await host.until(
      'Object.keys(__volley.room.data.members).length===1 && document.getElementById("start").disabled'
    );
    await click(host, 'leave');
    console.log(
      'Lobby: invitation controls fit without overlap at 390/760/1200px in all languages; lone duo blocked through UI and start API, two connected duos can play, and returning to one duo blocks starting again.'
    );
    return;
  }
  if (process.env.PIKA_ROOM_CODE_ONLY) {
    await click(host, 'create');
    await host.until('!!__volley.room.data');
    const id = await host.ev('__volley.room.id');
    const code = id.match(/.{5}/g).join('-');
    assert.match(id, /^[2-9a-km-np-z]{20}$/);
    assert.equal(
      await host.ev('document.getElementById("room-code").textContent'),
      code
    );
    await host.ev(
      'window.copied=[];Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async text=>{copied.push(text)}}})'
    );
    await click(host, 'copy-code');
    assert.equal(await host.ev('copied.at(-1)'), code);
    await click(host, 'copy-link');
    assert.equal(
      new URL(await host.ev('copied.at(-1)')).searchParams.get('room'),
      id
    );
    await host.ev(
      'navigator.clipboard.writeText=async()=>{throw Error("denied")}'
    );
    await click(host, 'copy-code');
    assert.equal(await host.ev('getSelection().toString()'), code);
    const guest = await tab(port, 'ko');
    await join(guest, code.toUpperCase(), '1');
    assert.equal(await guest.ev('__volley.room.id'), id);
    assert.equal(
      await guest.ev('document.getElementById("room-code").textContent'),
      code
    );
    assert.equal(
      await guest.ev('document.getElementById("copy-code").textContent'),
      '코드 복사'
    );
    const chinese = await tab(port, 'zh');
    await join(chinese, id, '2');
    assert.equal(
      await chinese.ev('document.getElementById("copy-code").textContent'),
      '複製代碼'
    );
    await click(chinese, 'leave');
    await click(guest, 'leave');
    await click(host, 'leave');
    console.log(
      'Room codes: original generator/grouping, clipboard code/link, fallback selection, formatted/raw joins and translated buttons passed.'
    );
    return;
  }
  if (process.env.PIKA_CHAT_AREAS_ONLY) {
    await host.ev(
      'document.getElementById("auto-save-replay-checkbox").checked=false;document.getElementById("auto-save-replay-checkbox").dispatchEvent(new Event("change"))'
    );
    await click(host, 'create');
    await host.until('!!__volley.room.data');
    await selectSlot(host, '0');
    const id = await host.ev('__volley.room.id'),
      guests = [];
    for (let i = 1; i < 4; i++) {
      const guest = await tab(port);
      guests.push(guest);
      await guest.ev(
        'document.getElementById("auto-save-replay-checkbox").checked=false;document.getElementById("auto-save-replay-checkbox").dispatchEvent(new Event("change"))'
      );
      await join(guest, id, String(i));
    }
    await host.until(
      '__volley.room.ready() && !document.getElementById("start").disabled'
    );
    await click(host, 'start');
    await host.until('__volley.session.lastFrame>40');
    const pages = [host, ...guests];
    for (let i = 0; i < 4; i++) {
      await click(pages[i], 'chat-open-btn');
      await pages[i].ev(
        'document.getElementById("chat-input").value=' +
          JSON.stringify('P' + (i + 1) + ' ' + 'A'.repeat(46))
      );
      await click(pages[i], 'send-btn');
    }
    const bounds =
      '(()=>{const court=document.getElementById("game-canvas-container").getBoundingClientRect();return Array.from(document.querySelectorAll("#chat-bubbles .chat-box")).map(b=>{const r=b.getBoundingClientRect();const slot=Number(b.title.match(/P([1-4])/)[1])-1;return {slot,left:(r.left-court.left)/court.width*100,right:(r.right-court.left)/court.width*100,top:(r.top-court.top)/court.height*100,bottom:(r.bottom-court.top)/court.height*100,style:[b.style.left,b.style.right,b.style.top,b.style.transform]};});})()';
    for (const page of pages) {
      await page.until(
        'document.querySelectorAll("#chat-bubbles .chat-box").length===4'
      );
      const boxes = await page.ev(bounds);
      for (const box of boxes) {
        assert.ok(box.left >= box.slot * 25 - 0.1);
        assert.ok(box.right <= (box.slot + 1) * 25 + 0.1);
        assert.ok(box.top >= -0.1);
        assert.ok(box.bottom <= 100.1);
      }
    }
    const styles = await host.ev(bounds);
    for (const guest of guests)
      assert.deepEqual(
        (await guest.ev(bounds)).map((b) => b.style),
        styles.map((b) => b.style)
      );
    const packets = await host.ev(
      '__volley.session.replay.pack.events.filter(e=>e.type==="chat").map(e=>e.packet)'
    );
    assert.deepEqual(
      packets.map((p) => p.position.area),
      [0, 1, 2, 3]
    );
    await screenshot(host, 'chat-assigned-quarters.png');
    await host.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    for (const box of await host.ev(bounds)) {
      assert.ok(box.left >= box.slot * 25 - 0.1);
      assert.ok(box.right <= (box.slot + 1) * 25 + 0.1);
      assert.ok(box.top >= -0.1);
      assert.ok(box.bottom <= 100.1);
    }
    await screenshot(host, 'chat-assigned-quarters-mobile.png');
    await assertSameSimulation(host, guests);
    for (const guest of guests) await click(guest, 'leave');
    await click(host, 'leave');
    console.log(
      'Solo chat: all four slot areas, long-message wrapping, synchronized positions, responsive bounds, recorded area metadata, and unchanged lockstep physics passed.'
    );
    return;
  }
  if (process.env.PIKA_DIAGNOSTICS_ONLY) {
    await click(host, 'create');
    await host.until('!!__volley.room.data');
    await selectSlot(host, '0');
    const id = await host.ev('__volley.room.id'),
      guests = [];
    for (let i = 1; i < 4; i++) {
      const guest = await tab(port);
      guests.push(guest);
      await join(guest, id, String(i));
    }
    for (const page of [host, ...guests])
      await page.until(
        '__volley.diagnostics.snapshot().rows.filter(row=>row.count && row.age<10000).length===6'
      );
    assert.equal(
      await host.ev('document.querySelectorAll("#ping-table tbody tr").length'),
      6
    );
    assert.equal(
      await host.ev('document.getElementById("network-diagnostics").open'),
      false
    );
    await click(host, 'ping-indicator');
    await host.until('document.getElementById("network-diagnostics").open');
    await host.until(
      'Array.from(__volley.diagnostics.links.values()).every(link=>link.samples.length>=5)'
    );
    assert.ok(
      await host.ev(
        'Array.from(__volley.diagnostics.links.values()).every(link=>link.route==="direct")'
      )
    );
    await screenshot(host, 'diagnostics-lobby-mesh.png');
    await click(host, 'start');
    await host.until('__volley.session.lastFrame>40');
    await host.until('!document.getElementById("network-diagnostics").open');
    const stalledId = await guests[0].ev('__volley.room.selfId');
    await guests[0].ev(
      'window.diagHeld=[];window.diagSend=__volley.room.send.bind(__volley.room);__volley.room.send=(id,message,disposable)=>{if(message.type==="frame-input"){diagHeld.push([id,message,disposable]);return true;}return diagSend(id,message,disposable);}'
    );
    await host.until(
      '__volley.diagnostics.snapshot().wait?.peers.includes(' +
        JSON.stringify(stalledId) +
        ')'
    );
    await host.until(
      'document.getElementById("input-wait").textContent.includes("P2")'
    );
    assert.equal(
      await host.ev('__volley.diagnostics.snapshot().average!==null'),
      true
    );
    await host.ev('document.getElementById("network-diagnostics").open=true');
    await screenshot(host, 'diagnostics-input-wait.png');
    const stalledFrame = await host.ev('__volley.session.lastFrame');
    await guests[0].ev(
      '__volley.room.send=window.diagSend;for(const args of diagHeld)diagSend(...args);diagHeld=[]'
    );
    await host.until(
      '__volley.session.lastFrame>' + JSON.stringify(stalledFrame + 8)
    );
    await assertSameSimulation(host, guests);
    await host.until('__volley.diagnostics.snapshot().wait===null');
    assert.equal(
      await host.ev(
        'JSON.stringify(__volley.session.replay.pack).includes("diag-")'
      ),
      false
    );
    await click(host, 'options-dropdown-btn');
    await click(host, 'court-submenu-btn');
    await host.ev('document.getElementById("synchronization").value="host"');
    await click(host, 'settings-apply');
    await click(host, 'settings-confirm-yes');
    await host.until(
      '__volley.session.settings.synchronization==="host" && __volley.session.phase==="playing"'
    );
    for (const page of [host, ...guests])
      await page.until(
        '__volley.diagnostics.snapshot().rows.filter(row=>row.used).length===3'
      );
    assert.equal(
      await host.ev('__volley.diagnostics.snapshot().rows.length'),
      6
    );
    await switchTopology(host, guests, 'star');
    for (const page of [host, ...guests])
      await page.until(
        '__volley.diagnostics.snapshot().rows.filter(row=>row.count && row.age<10000).length===3'
      );
    await host.until(
      'document.getElementById("ping-table").textContent.includes("Via host")'
    );
    await screenshot(host, 'diagnostics-star.png');
    for (const guest of guests) await click(guest, 'leave');
    await click(host, 'leave');
    await host.ev(
      'document.getElementById("layout").value="pairs";document.getElementById("synchronization").value="lockstep"'
    );
    await click(host, 'create');
    await host.until('!!__volley.room.data');
    await selectSlot(host, '0,1');
    const pair = await tab(port, 'zh');
    await join(pair, await host.ev('__volley.room.id'), '2,3');
    for (const page of [host, pair])
      await page.until(
        '__volley.diagnostics.snapshot().rows.filter(row=>row.count>=5).length===1'
      );
    assert.equal(
      await pair.ev('document.querySelectorAll("#ping-table tbody tr").length'),
      1
    );
    assert.equal(
      await pair.ev(
        'document.getElementById("ping-indicator").textContent.includes("本機雙人")'
      ),
      true
    );
    await pair.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await screenshot(pair, 'diagnostics-pairs-mobile-zh.png');
    const mobileLayout = await pair.ev(
      '(()=>{const width=document.documentElement.clientWidth;const normal=document.documentElement.scrollWidth;const items=Array.from(document.querySelectorAll("body *")).map(e=>({id:e.id,tag:e.tagName,right:e.getBoundingClientRect().right})).filter(e=>e.right>width+1).slice(0,12);const panel=document.getElementById("network-diagnostics");panel.hidden=true;const baseline=document.documentElement.scrollWidth;panel.hidden=false;return {width,normal,baseline,items};})()'
    );
    console.log('Diagnostics mobile layout:', JSON.stringify(mobileLayout));
    assert.ok(
      mobileLayout.normal <=
        Math.max(mobileLayout.width, mobileLayout.baseline) + 1,
      'Diagnostics must not widen the page'
    );
    await click(pair, 'leave');
    await click(host, 'leave');
    await host.until('document.getElementById("network-diagnostics").hidden');
    console.log(
      'Diagnostics: six measured mesh links, real direct ICE routes, input-wait attribution and recovery, identical physics, replay exclusion, host-only relevance, three-link star, pairs, Traditional Chinese and mobile containment passed.'
    );
    return;
  }
  if (process.env.PIKA_VERSION_ONLY) {
    const current = JSON.parse(
      fs.readFileSync(path.join(root, 'version.json'), 'utf8')
    );
    await host.ev('__volley.updates.ensureCurrent()');
    await host.ev(
      'document.getElementById("auto-save-replay-checkbox").checked=false;document.getElementById("auto-save-replay-checkbox").dispatchEvent(new Event("change"))'
    );
    assert.deepEqual(await host.ev('__volley.version'), current);
    assert.ok(
      await host.ev(
        'document.getElementById("client-version").textContent.includes(__volley.version.build)'
      )
    );
    versionResponse = {
      status: 200,
      data: { ...current, build: 'new-deployment' },
    };
    await host.ev('__volley.updates.check()');
    assert.equal(
      await host.ev('document.getElementById("create").disabled'),
      true
    );
    assert.equal(
      await host.ev('document.getElementById("quick-match").disabled'),
      true
    );
    assert.equal(
      await host.ev('document.getElementById("join").disabled'),
      true
    );
    assert.equal(
      await host.ev('document.getElementById("reload-client").hidden'),
      false
    );
    assert.equal(
      await host.ev(
        '__volley.updates.ensureCurrent().then(()=>false,()=>true)'
      ),
      true
    );
    assert.equal(rooms.size, 0);
    versionResponse = { status: 503, data: {} };
    assert.equal(await host.ev('__volley.updates.check()'), 'outdated');
    versionResponse = null;
    await host.ev('__volley.updates.ensureCurrent()');
    await click(host, 'create');
    await host.until('!!__volley.room.data');
    const id = await host.ev('__volley.room.id');
    const guest = await tab(port);
    await guest.ev(
      'document.getElementById("auto-save-replay-checkbox").checked=false;document.getElementById("auto-save-replay-checkbox").dispatchEvent(new Event("change"))'
    );
    await guest.ev(
      'window.originalLobbyRequest=__volley.room.store.request.bind(__volley.room.store);__volley.room.store.request=(action,args)=>originalLobbyRequest(action,action==="claim"?{...args,compatibility:{...__volley.version,engine:"different"}}:args)'
    );
    await guest.ev(
      'document.getElementById("room-id").value=' + JSON.stringify(id)
    );
    await click(guest, 'join');
    await guest.until(
      'document.getElementById("status").textContent.includes("versions do not match")'
    );
    assert.equal(await guest.ev('__volley.room.closed'), true);
    assert.equal(
      await host.ev('Object.keys(__volley.room.data.members).length'),
      1
    );
    await guest.ev('__volley.room.store.request=window.originalLobbyRequest');
    await join(guest, id, '1');
    await selectSlot(host, '0');
    await host.until(
      '__volley.room.ready() && !document.getElementById("start").disabled'
    );
    await click(host, 'start');
    await host.until('__volley.session.lastFrame>35');
    const epoch = await host.ev('__volley.session.epoch');
    const frame = await host.ev('__volley.session.lastFrame');
    versionResponse = {
      status: 200,
      data: { ...current, build: 'another-deployment' },
    };
    await host.ev('__volley.updates.check()');
    await guest.ev('__volley.updates.check()');
    await host.until(
      '__volley.session.lastFrame>' + JSON.stringify(frame + 10)
    );
    assert.equal(await host.ev('__volley.session.epoch'), epoch);
    assert.equal(await guest.ev('__volley.session.phase'), 'playing');
    assert.equal(
      await host.ev('document.getElementById("reload-client").hidden'),
      false
    );
    await click(host, 'options-dropdown-btn');
    await click(host, 'court-submenu-btn');
    await host.ev('document.getElementById("court-width").value=384');
    await click(host, 'settings-apply');
    await click(host, 'settings-confirm-yes');
    await host.until(
      'document.getElementById("status").textContent.includes("update is available")'
    );
    assert.equal(await host.ev('__volley.session.epoch'), epoch);
    await screenshot(host, 'version-update-active-match.png');
    versionResponse = null;
    await click(guest, 'leave');
    await click(host, 'leave');
    await host.ev(
      'document.getElementById("nickname").value="Update Tester";document.getElementById("nickname").dispatchEvent(new Event("input"));window.__reloadMarker=true'
    );
    versionResponse = {
      status: 200,
      data: { ...current, build: 'reload-test' },
    };
    await host.ev('__volley.updates.check()');
    await click(host, 'reload-client');
    await host.until(
      '!window.__reloadMarker && !!window.__volley && location.search.includes("client-update=")'
    );
    assert.equal(
      await host.ev('document.getElementById("nickname").value'),
      'Update Tester'
    );
    versionResponse = null;
    await host.ev('__volley.updates.ensureCurrent()');
    console.log(
      'Version checks: generated build/engine metadata, stale admission blocking, fetch failure, recovery, mismatched guest rejection, settings-restart blocking, nickname-preserving reload, and uninterrupted active matches passed.'
    );
    return;
  }
  if (process.env.PIKA_REPLAY_ONLY) {
    await host.send('Page.navigate', {
      url: `http://127.0.0.1:${server.address().port}/en`,
    });
    await host.until(
      '!!window.__volley && !document.getElementById("create").disabled'
    );
    assert.equal(await host.ev('location.pathname'), '/en/');
    assert.equal(
      await host.ev(
        'new URL(document.querySelector(".replay-viewer-link a").href).pathname'
      ),
      '/en/replay/'
    );
    const rootReplay = await tab(port);
    await rootReplay.send('Page.navigate', {
      url: `http://127.0.0.1:${server.address().port}/replay/`,
    });
    await rootReplay.until('!!window.__replayPlayer');
    assert.equal(await rootReplay.ev('location.pathname'), '/en/replay/');
    await browser.send('Target.closeTarget', { targetId: rootReplay.targetId });

    assert.equal(
      await host.ev(
        '!!document.querySelector("#before-connection #replay-options #auto-save-replay-checkbox")'
      ),
      true
    );
    assert.equal(
      await host.ev(
        '!!document.querySelector("#menu-bar .btn-container.left #save-replay-btn")'
      ),
      true
    );
    const downloadDirectory = fs.mkdtempSync(
      path.join(artifacts, 'replay-download-')
    );
    await browser.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDirectory,
      browserContextId: host.contextId,
    });
    assert.equal(
      await host.ev(
        'document.getElementById("auto-save-replay-checkbox").checked'
      ),
      true
    );
    assert.equal(
      await host.ev(
        'document.querySelector("#about-box-head .replay-viewer-link a").getAttribute("href")'
      ),
      './replay/'
    );
    assert.equal(
      await host.ev('!!document.querySelector(".replay-tools a")'),
      false
    );
    await host.ev(
      'document.getElementById("auto-save-replay-checkbox").click()'
    );
    const preferenceTab = await tab(port, 'en', true, host.contextId);
    assert.equal(
      await preferenceTab.ev(
        'document.getElementById("auto-save-replay-checkbox").checked'
      ),
      false,
      'Saved opt-out must survive reopening'
    );
    await browser.send('Target.closeTarget', {
      targetId: preferenceTab.targetId,
    });
    await host.ev(
      'document.getElementById("auto-save-replay-checkbox").click()'
    );

    await click(host, 'create');
    await host.until('!__volley.room.closed && !!__volley.room.data');
    await selectSlot(host, '0');
    const guest = await tab(port, 'ko');
    await browser.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDirectory,
      browserContextId: guest.contextId,
    });
    await join(guest, await host.ev('__volley.room.id'), '3');
    await assertConnections(host, [guest], 'mesh');
    await host.ev(
      'window.replayStates={};const oldStep=__volley.session.stepGame.bind(__volley.session);__volley.session.stepGame=()=>{oldStep();replayStates[__volley.session.replay.count+1]=JSON.stringify({players:__volley.game.players,ball:__volley.game.physics.ball,scores:__volley.game.scores,state:__volley.game.state.name,counter:__volley.game.frameCounter,clouds:__volley.game.view.game.cloudArray,wave:__volley.game.view.game.wave,rng:__volley.session.rng?.state()||null});}'
    );
    await click(host, 'start');
    await key(host, 'KeyG', 'keyDown');
    await host.until('__volley.session.lastFrame>55');
    await key(host, 'KeyG', 'keyUp');
    await key(host, 'KeyR', 'keyDown');
    await host.until('__volley.session.lastFrame>65');
    await key(host, 'KeyR', 'keyUp');
    await host.until('__volley.session.lastFrame>160');
    await click(host, 'pause');
    await guest.until('__volley.session.phase==="paused"');
    await host.ev(
      '__volley.room.replay.chat({text:"Replay chat <safe>",name:"Host",slots:[0],position:{top:25,offset:60,side:"left"}})'
    );
    const firstText = await host.ev('__volley.session.replay.text()');
    const state =
      'JSON.stringify({players:__volley.game.players,ball:__volley.game.physics.ball,scores:__volley.game.scores,state:__volley.game.state.name,counter:__volley.game.frameCounter,clouds:__volley.game.view.game.cloudArray,wave:__volley.game.view.game.wave,rng:__volley.session.rng?.state()||null})';
    const firstExpected = await host.ev(state);
    await host.ev('__volley.session.replay.save()');
    let savedFile;
    for (let i = 0; i < 100; i++) {
      savedFile = fs
        .readdirSync(downloadDirectory)
        .find((name) => name.endsWith('.txt'));
      if (savedFile) break;
      await delay(50);
    }
    assert.ok(savedFile, 'FileSaver must directly download a replay');
    const downloaded = JSON.parse(
      fs
        .readFileSync(path.join(downloadDirectory, savedFile), 'utf8')
        .replace(/^\uFEFF/, '')
    );
    assert.equal(downloaded.pack.roomId, await host.ev('__volley.room.id'));

    async function viewer(text, lang = 'en') {
      const page = await tab(port, lang);
      await page.send('Page.navigate', {
        url: `http://127.0.0.1:${server.address().port}/${lang}/replay/`,
      });
      await page.until('!!window.__replayPlayer');
      await page.ev(
        '(()=>{const file=new File([' +
          JSON.stringify(text) +
          '],"session.pvreplay",{type:"application/json"});const dt=new DataTransfer();dt.items.add(file);const input=document.getElementById("file-input");input.files=dt.files;input.dispatchEvent(new Event("change"));})()'
      );
      await page.until('!!window.__replay?.doubles');
      await page.ev('__replay.ticker.stop()');
      assert.equal(
        await page.ev(
          '(()=>{const r=document.querySelector("canvas").getBoundingClientRect();return Math.abs(r.width/r.height-__replay.doubles.settings.courtWidth*2/304)<0.01;})()'
        ),
        true,
        'Replay court must preserve the recorded aspect ratio'
      );
      assert.equal(
        await page.ev(
          'getComputedStyle(document.querySelector(".grid-for-keyboard")).display'
        ),
        'none'
      );
      return page;
    }
    const replayState =
      'JSON.stringify({players:__replay.pikaVolley.players,ball:__replay.pikaVolley.physics.ball,scores:__replay.pikaVolley.scores,state:__replay.pikaVolley.state.name,counter:__replay.pikaVolley.frameCounter,clouds:__replay.pikaVolley.view.game.cloudArray,wave:__replay.pikaVolley.view.game.wave,rng:__replay.doubles.rng?.state()||null})';
    console.log('Replay check: loading lockstep viewer');
    const replay = await viewer(firstText);
    assert.deepEqual(
      await replay.ev(
        'Array.from(document.querySelectorAll("#doubles-keys .replay-keypad")).map(pad=>Array.from(pad.children).map(key=>key.textContent))'
      ),
      Array(4).fill(['Enter', '↑', '←', '↓', '→'])
    );
    await replay.ev(
      '__replay.doubles.showInputs([{xDirection:-1,yDirection:-1,powerHit:1},{xDirection:1,yDirection:1,powerHit:0},null,{xDirection:0,yDirection:0,powerHit:1}])'
    );
    assert.deepEqual(
      await replay.ev(
        'Array.from(document.querySelectorAll("#doubles-keys .replay-keypad")).map(pad=>Array.from(pad.querySelectorAll(".pressed")).map(key=>key.dataset.action))'
      ),
      [['hit', 'up', 'left'], ['down', 'right'], [], ['hit']]
    );

    const middleIndex =
      JSON.parse(firstText)
        .pack.events.map((event, index) => [event, index])
        .filter(([event]) => event.type === 'step')[74][1] + 1;
    await replay.ev('__replay.seekFrame(' + middleIndex + ')');
    assert.equal(
      await replay.ev(replayState),
      await host.ev('replayStates[75]'),
      'Re-simulating between checkpoints must preserve inputs, AI and RNG exactly'
    );
    await replay.ev('__replay.seekFrame(__replay.doubles.events.length)');
    assert.equal(
      await replay.ev(replayState),
      firstExpected,
      'Seeking must reproduce the exact authoritative simulation'
    );
    await replay.ev(
      '__replay.seekFrame(0);while(__replay.doubles.cursor<__replay.doubles.events.length){__replay.doubles.tick();if(__replay.doubles.error)throw __replay.doubles.error;}__replay.ticker.stop()'
    );
    assert.equal(
      await replay.ev(replayState),
      firstExpected,
      'Straight playback must match seeking'
    );
    assert.equal(
      await replay.ev(
        'document.getElementById("doubles-chat").textContent.includes("Replay chat <safe>")'
      ),
      true
    );
    await replay.ev('document.getElementById("show-chat-checkbox").click()');
    assert.equal(
      await replay.ev(
        'document.getElementById("doubles-chat").children.length'
      ),
      0
    );
    // Test actual painted chat, not just DOM text presence or physics state.
    const chatPack = JSON.parse(firstText).pack;
    chatPack.events = chatPack.events.filter((event) => event.type !== 'chat');
    const members = chatPack.events.find((event) => event.type === 'lobby').data
      .members;
    const chatStart = chatPack.events.reduce((sum, event) => sum + event.dt, 0);
    const packet = (text, sender, area) => ({
      text,
      name: sender,
      sender,
      speaker: 0,
      slots: [area],
      position: {
        top: 35,
        offset: 67.5,
        side: area < 2 ? 'left' : 'right',
        area,
      },
    });
    chatPack.events.push({
      type: 'chat',
      dt: 0,
      packet: packet('First message', 'Same player', 0),
    });
    for (let i = 0; i < 10; i++)
      chatPack.events.push({ type: 'lobby', dt: 0.1, data: { members } });
    chatPack.events.push({
      type: 'chat',
      dt: 0,
      packet: packet('Replacement message', 'Same player', 0),
    });
    chatPack.events.push({
      type: 'chat',
      dt: 0,
      packet: packet('Right slot message', 'Other player', 3),
    });
    const legacyPacket = packet('Old recording position', 'Legacy player', 2);
    delete legacyPacket.position.area;
    chatPack.events.push({ type: 'chat', dt: 0, packet: legacyPacket });
    for (let i = 0; i < 70; i++)
      chatPack.events.push({ type: 'lobby', dt: 0.1, data: { members } });
    const getHashCode = Function(
      fs
        .readFileSync(
          path.join(__dirname, '../src/resources/js/utils/hash_code.js'),
          'utf8'
        )
        .replace(/export /g, '') + ';return getHashCode;'
    )();
    const chatReplay = await viewer(
      JSON.stringify({
        pack: chatPack,
        checksum: getHashCode(JSON.stringify(chatPack)),
      })
    );
    await chatReplay.ev(
      '__replay.doubles.seekTime(' + JSON.stringify(chatStart + 2.5) + ')'
    );
    await chatReplay.ev(
      '(async()=>{for(let i=0;i<30;i++){__replay.doubles.render();await new Promise(requestAnimationFrame);}})()'
    );
    const painted = await chatReplay.ev(
      'Array.from(document.querySelectorAll("#doubles-chat .chat-box")).map(b=>({text:b.textContent,opacity:Number(getComputedStyle(b).opacity),visibility:getComputedStyle(b).visibility}))'
    );
    console.log('Replay painted chat:', JSON.stringify(painted));
    assert.ok(
      painted.length > 0 &&
        painted.every((b) => b.opacity > 0.9 && b.visibility === 'visible'),
      'Mid-life replay bubbles must remain visibly painted during repeated renders'
    );
    assert.deepEqual(
      painted.map((b) => b.text),
      ['Replacement message', 'Right slot message', 'Old recording position']
    );
    await screenshot(chatReplay, 'replay-chat-visible.png');
    const geometry =
      '(()=>{const c=document.getElementById("game-canvas-container").getBoundingClientRect();return Array.from(document.querySelectorAll("#doubles-chat .chat-box")).map(b=>{const r=b.getBoundingClientRect();return {text:b.textContent,left:(r.left-c.left)/c.width*100,right:(r.right-c.left)/c.width*100,opacity:Number(getComputedStyle(b).opacity),styleLeft:b.style.left,styleRight:b.style.right};});})()';
    for (const device of [
      null,
      { width: 390, height: 844, deviceScaleFactor: 1, mobile: true },
    ]) {
      if (device)
        await chatReplay.send('Emulation.setDeviceMetricsOverride', device);
      const boxes = await chatReplay.ev(geometry);
      const left = boxes.find((b) => b.text === 'Replacement message'),
        right = boxes.find((b) => b.text === 'Right slot message'),
        old = boxes.find((b) => b.text === 'Old recording position');
      assert.ok(left.left >= 0 && left.right <= 25.1);
      assert.ok(right.left >= 74.9 && right.right <= 100.1);
      assert.equal(old.styleLeft, '67.5%');
    }
    await chatReplay.ev(
      '__replay.doubles.seekTime(' + JSON.stringify(chatStart + 5.5) + ')'
    );
    const pausedOpacity = await chatReplay.ev(
      'Number(getComputedStyle(document.querySelector("#doubles-chat .chat-box")).opacity)'
    );
    assert.ok(
      pausedOpacity > 0 && pausedOpacity < 1,
      'Chat should still exist and fade during its fifth replay second'
    );
    await delay(1400);
    assert.equal(
      await chatReplay.ev(
        'Number(getComputedStyle(document.querySelector("#doubles-chat .chat-box")).opacity)'
      ),
      pausedOpacity,
      'Pausing the replay must freeze the chat fade'
    );
    await chatReplay.ev(
      '__replay.doubles.seekTime(' + JSON.stringify(chatStart + 6.2) + ')'
    );
    assert.equal(
      await chatReplay.ev(
        'document.getElementById("doubles-chat").children.length'
      ),
      0
    );
    await chatReplay.ev(
      '__replay.doubles.seekTime(' + JSON.stringify(chatStart + 2.5) + ')'
    );
    const beforeToggle = await chatReplay.ev(
      'document.getElementById("doubles-chat").textContent'
    );
    await chatReplay.ev(
      'document.getElementById("show-chat-checkbox").click()'
    );
    assert.equal(
      await chatReplay.ev(
        'document.getElementById("doubles-chat").children.length'
      ),
      0
    );
    await chatReplay.ev(
      'document.getElementById("show-chat-checkbox").click()'
    );
    assert.equal(
      await chatReplay.ev(
        'document.getElementById("doubles-chat").textContent'
      ),
      beforeToggle
    );
    await chatReplay.ev(
      '__replay.doubles.seek(0);while(__replay.doubles.times[__replay.doubles.cursor]<' +
        JSON.stringify(chatStart + 2.5) +
        '){__replay.doubles.tick();}__replay.ticker.stop()'
    );
    const linearChat = await chatReplay.ev(geometry),
      linearCursor = await chatReplay.ev('__replay.doubles.cursor');
    await chatReplay.ev('__replay.doubles.seek(' + linearCursor + ')');
    assert.deepEqual(
      await chatReplay.ev(geometry),
      linearChat,
      'Seeking must reconstruct the same chat boxes as straight playback'
    );
    await browser.send('Target.closeTarget', { targetId: chatReplay.targetId });
    console.log(
      'Replay chat: visible fade, five-second lifetime, pause, replacement, seek, visibility toggle, quarter bounds and old-file positions passed.'
    );
    await host.ev(
      'window.downloads=[];__volley.session.replay.download=text=>downloads.push(text)'
    );
    console.log('Replay check: requesting host transfer');
    await guest.ev(
      'window.downloads=[];__volley.session.replay.download=text=>downloads.push(text);__volley.session.replay.save()'
    );
    assert.equal(
      JSON.parse(await guest.ev('downloads[0]')).pack.authoritative,
      true
    );
    assert.equal(
      await guest.ev('__volley.room.connected(__volley.room.data.hostId)'),
      true
    );
    await host.ev(
      'if(!document.getElementById("auto-save-replay-checkbox").checked)document.getElementById("auto-save-replay-checkbox").click()'
    );
    assert.equal(
      await host.ev('localStorage.getItem("pv-online-auto-replay")'),
      'true'
    );
    await host.ev(
      '__volley.session.start({...__volley.session.settings,synchronization:"host",courtWidth:384})'
    );
    await guest.until('__volley.session.settings.synchronization==="host"');
    await host.until('__volley.session.frame>90');
    await click(host, 'pause');
    await guest.until('__volley.session.phase==="paused"');
    const secondExpected = await host.ev(state),
      sessionText = await host.ev('__volley.session.replay.text()');
    assert.equal(
      new Set(
        JSON.parse(sessionText)
          .pack.events.filter((e) => e.type === 'checkpoint')
          .map((e) => e.epoch)
      ).size,
      2
    );
    console.log('Replay check: loading host-only viewer');
    const second = await viewer(sessionText, 'zh');
    await second.ev('__replay.seekFrame(__replay.doubles.events.length)');
    assert.equal(
      await second.ev(replayState),
      secondExpected,
      'Host-only random draws must replay exactly'
    );
    await second.ev(
      '__replay.seekFrame(0);while(__replay.doubles.cursor<__replay.doubles.events.length){__replay.doubles.tick();if(__replay.doubles.error)throw __replay.doubles.error;}__replay.ticker.stop()'
    );
    assert.equal(
      await second.ev(replayState),
      secondExpected,
      'Two matches with different synchronization modes must replay in order'
    );
    console.log('Replay check: loading partial recording');
    const fallback = await guest.ev('__volley.session.replay.text()');
    assert.equal(JSON.parse(fallback).pack.complete, false);
    const partial = await viewer(fallback, 'ko');
    await partial.ev('__replay.seekFrame(__replay.doubles.events.length)');
    assert.equal(await partial.ev('__replay.pikaVolley.players.length'), 4);
    await click(host, 'leave');
    await guest.until(
      '__volley.room.isHost && __volley.room.data.status==="lobby"'
    );
    await click(guest, 'leave');
    assert.equal(
      await host.ev('downloads.length'),
      1,
      'Automatic room-exit saving must download once'
    );
    assert.ok(await guest.ev('__volley.session.replay.pack.events.length>0'));
    await assertLegacyReplay(port);
    await screenshot(second, 'replay-2v2-zh.png');
    await host.ev('document.getElementById("layout").value="pairs"');
    await click(host, 'create');
    await host.until('!__volley.room.closed');
    await selectSlot(host, '0,1');
    await join(guest, await host.ev('__volley.room.id'), '2,3');
    await assertConnections(host, [guest], 'mesh');
    await click(host, 'start');
    await host.until('__volley.session.lastFrame>65');
    await click(host, 'pause');
    const pairText = await host.ev('__volley.session.replay.text()'),
      pairExpected = await host.ev(state);
    const pairViewer = await viewer(pairText, 'ko');
    await pairViewer.ev('__replay.seekFrame(__replay.doubles.events.length)');
    assert.equal(await pairViewer.ev(replayState), pairExpected);
    assert.deepEqual(
      await pairViewer.ev('__replay.pikaVolley.players.map(p=>p.isComputer)'),
      [false, false, false, false]
    );
    await click(host, 'leave');
    await guest.until(
      '__volley.room.isHost && __volley.room.data.status==="lobby"'
    );
    await click(guest, 'leave');
    assert.deepEqual(errors, []);
    console.log(
      'Replay: exact lockstep and host-only playback, seeking, room-session rematches, randomized chat, guest transfer, local fallback, persistence and auto-save passed.'
    );
    return;
  }
  if (process.env.PIKA_NETWORK_ONLY) {
    await click(host, 'create');
    await host.until('!__volley.room.closed && !!__volley.room.data');
    await selectSlot(host, '0');
    const guests = [];
    for (let i = 1; i < 4; i++) {
      const guest = await tab(port);
      await join(guest, await host.ev('__volley.room.id'), String(i));
      guests.push(guest);
    }
    await assertConnections(host, guests, 'mesh');
    for (let i = 0; i < 3; i++) {
      await switchTopology(host, guests, 'star');
      await switchTopology(host, guests, 'mesh');
      console.log('Connection cycle', i);
    }
    await click(host, 'leave');
    console.log('Network-only test passed.');
    return;
  }
  // The original P2P nickname key must migrate, and both local names survive reopening.
  let nicknamePage = await tab(port, 'zh');
  assert.equal(
    await nicknamePage.ev('document.getElementById("speed").value'),
    '30'
  );
  assert.equal(
    await nicknamePage.ev(
      'document.getElementById("fast-speed-btn").classList.contains("selected")'
    ),
    true
  );
  await nicknamePage.ev(
    'localStorage.setItem("myNickname","  Legacy nickname  ")'
  );
  await nicknamePage.send('Page.reload', { ignoreCache: true });
  await nicknamePage.until(
    '!!window.__volley && document.getElementById("nickname").value==="Legacy nickname"'
  );
  await nicknamePage.ev(
    'document.getElementById("nickname").value="重新開啟的玩家";document.getElementById("nickname").dispatchEvent(new Event("input"));document.getElementById("pair-name").value="第二位隊友";document.getElementById("pair-name").dispatchEvent(new Event("input"))'
  );
  const nicknameContext = nicknamePage.contextId;
  await browser.send('Target.closeTarget', { targetId: nicknamePage.targetId });
  nicknamePage = await tab(port, 'zh', true, nicknameContext);
  assert.deepEqual(
    await nicknamePage.ev(
      '[document.getElementById("nickname").value,document.getElementById("pair-name").value]'
    ),
    ['重新開啟的玩家', '第二位隊友']
  );
  await nicknamePage.ev('document.getElementById("room-id").value="bad"');
  await click(nicknamePage, 'join');
  await nicknamePage.until(
    'document.getElementById("status").textContent.includes("請輸入20")'
  );
  assert.equal(
    await nicknamePage.ev('document.querySelector(".source-code-on a").href'),
    'https://github.com/ilesejin/pikachu-volleyball-2v2-online'
  );
  await nicknamePage.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await nicknamePage.ev('document.documentElement.dataset.colorScheme="dark"');
  assert.equal(
    await nicknamePage.ev(
      'document.getElementById("before-connection").scrollWidth<=document.getElementById("before-connection").clientWidth+1'
    ),
    true,
    'Chinese landing page fits mobile width'
  );
  await screenshot(nicknamePage, 'classic-landing-zh-mobile.png');
  await nicknamePage.send('Page.navigate', {
    url: 'http://127.0.0.1:' + server.address().port + '/zh/update-history/',
  });
  await nicknamePage.until(
    '!!document.getElementById("update-history-container")'
  );
  assert.equal(await nicknamePage.ev('document.documentElement.lang'), 'zh');
  assert.equal(
    await nicknamePage.ev('document.body.textContent.includes("2026-??-??")'),
    true
  );
  await browser.send('Target.closeTarget', { targetId: nicknamePage.targetId });
  await host.send('Page.bringToFront');
  console.log(
    'Chinese landing/history, fast default, legacy nickname migration, and both names after reopening passed.'
  );
  await screenshot(host, 'classic-landing.png');
  await click(host, 'create');
  await host.until('!__volley.room.closed && !!__volley.room.data');
  assert.deepEqual(
    await host.ev('__volley.room.data.members[__volley.room.selfId].slots'),
    []
  );
  assert.equal(
    await host.ev('document.getElementById("start").disabled'),
    true
  );
  await selectSlot(host, '0');
  assert.equal(
    await host.ev('document.getElementById("start").disabled'),
    true
  );
  const visualGuest = await tab(port);
  await join(visualGuest, await host.ev('__volley.room.id'), '1');
  await assertConnections(host, [visualGuest], 'mesh');
  await host.ev('document.getElementById("synchronization").value="host"');
  await click(host, 'start');
  await host.until('__volley.session.epoch && __volley.game.view.game.visible');
  assert.deepEqual(
    await host.ev('__volley.game.players.map(p=>p.isComputer)'),
    [false, false, true, true]
  );
  assert.equal(
    await host.ev(
      'getComputedStyle(document.getElementById("player-names")).display==="none"'
    ),
    false
  );
  await host.until(
    '__volley.game.state===__volley.game.round && !__volley.game.view.game.messages.gameStart.visible'
  );
  await host.until(
    'getComputedStyle(document.getElementById("player-names")).display==="none"'
  );
  // Cloud sprites must survive crossing the original 432-unit boundary.
  assert.equal(
    await host.ev(
      '(()=>{const v=__volley.game.view.game;const c=v.cloudArray[0];c.topLeftPointX=431;c.topLeftPointXVelocity=2;v.drawCloudsAndWave();return c.topLeftPointX===433 && v.cloudContainer.getChildAt(0).x>425;})()'
    ),
    true
  );
  await click(host, 'player-labels-always-btn');
  assert.equal(
    await host.ev(
      'getComputedStyle(document.getElementById("player-names")).display==="none"'
    ),
    false
  );
  assert.equal(
    await host.ev('localStorage.getItem("pv-online-player-labels")'),
    'always'
  );
  const preferencePage = await tab(port, 'ko', true, host.contextId);
  assert.equal(
    await preferencePage.ev(
      'document.getElementById("player-labels-always-btn").classList.contains("selected")'
    ),
    true
  );
  await preferencePage.send('Page.reload', { ignoreCache: true });
  await preferencePage.until(
    '!!window.__volley && document.getElementById("player-labels-always-btn").classList.contains("selected")'
  );
  await click(preferencePage, 'player-labels-auto-btn');
  await browser.send('Target.closeTarget', {
    targetId: preferencePage.targetId,
  });
  await host.send('Page.bringToFront');
  await click(host, 'player-labels-auto-btn');
  await host.until(
    'getComputedStyle(document.getElementById("player-names")).display==="none"'
  );
  await click(host, 'back-lobby');
  await host.until(
    '__volley.session.phase==="idle" && __volley.room.data.status==="lobby"'
  );
  const id = await host.ev('__volley.room.id');
  const guests = [visualGuest];
  for (let slot = 2; slot < 4; slot++) {
    const guest = await tab(port, slot === 2 ? 'ko' : slot === 3 ? 'zh' : 'en');
    await join(guest, id, String(slot));
    guests.push(guest);
  }
  await host.until(
    '__volley.room.peers.size===3 && Array.from(__volley.room.peers.keys()).every(id=>__volley.room.connected(id))'
  );
  await assertConnections(host, guests, 'mesh');
  assert.equal(
    signalingOperations.get('offer'),
    3,
    'The other three mesh links must use WebRTC signaling'
  );
  await delay(200);
  assert.equal(
    signals.size,
    0,
    'Successful setup must delete temporary signaling'
  );
  assert.equal(candidates.size, 0);
  await randomizeLobby(host, guests);
  for (const [index, page] of [host, ...guests].entries())
    await selectSlot(page, String(index));
  await click(guests[0], 'cancel-slot');
  await host.until(
    '!__volley.room.data.members[Object.keys(__volley.room.data.members).find(id=>id!==__volley.room.selfId)].slots.length'
  );
  assert.equal(
    await host.ev('document.getElementById("start").disabled'),
    true
  );
  assert.equal(
    await guests[0].ev(
      'document.querySelector("[data-slots=\\"0\\"]").disabled'
    ),
    true
  );
  await selectSlot(guests[0], '1');
  await host.until(
    'Object.values(__volley.room.data.members).every(m=>m.slots.length===1)'
  );
  // Empty submissions dismiss chat without producing a room message.
  for (const blank of ['', '   ', '\t \n']) {
    const count = await host.ev(
      'document.getElementById("chat-log").children.length'
    );
    await click(guests[0], 'chat-open-btn');
    await guests[0].ev(
      'document.getElementById("chat-input").value=' + JSON.stringify(blank)
    );
    await key(guests[0], 'Enter', 'keyDown');
    await key(guests[0], 'Enter', 'keyUp');
    assert.equal(
      await guests[0].ev(
        'document.activeElement.id!=="chat-input" && document.getElementById("chat-input-and-send-btn-container").classList.contains("hidden")'
      ),
      true
    );
    assert.equal(
      await guests[0].ev('document.getElementById("chat-input").value'),
      ''
    );
    assert.equal(
      await host.ev('document.getElementById("chat-log").children.length'),
      count
    );
  }
  await screenshot(host, 'four-browser-lobby.png');
  await click(guests[0], 'chat-open-btn');
  await guests[0].ev(
    'document.getElementById("chat-input").value="<b>Hello everyone</b>";document.getElementById("chat-input").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",code:"Enter",bubbles:true}))'
  );
  for (const page of [host, ...guests]) {
    await page.until(
      'document.getElementById("chat-log").textContent.includes("<b>Hello everyone</b>")'
    );
    assert.equal(
      await page.ev('document.querySelectorAll("#chat-log b").length'),
      0
    );
  }
  const chatPosition = await host.ev(
    'Array.from(document.getElementById("chat-bubbles").children).map(b=>[b.style.top,b.style.left,b.style.right])'
  );
  for (const page of guests)
    assert.deepEqual(
      await page.ev(
        'Array.from(document.getElementById("chat-bubbles").children).map(b=>[b.style.top,b.style.left,b.style.right])'
      ),
      chatPosition
    );
  await click(guests[2], 'chat-open-btn');
  await guests[2].ev(
    'document.getElementById("chat-input").value="中文房間聊天"'
  );
  await click(guests[2], 'send-btn');
  for (const page of [host, ...guests])
    await page.until(
      'document.getElementById("chat-log").textContent.includes("中文房間聊天")'
    );
  await click(guests[1], 'chat-disabling-btn');
  await click(host, 'chat-open-btn');
  await host.ev(
    'document.getElementById("chat-input").value="Host room-wide reply"'
  );
  await click(host, 'send-btn');
  await guests[2].until(
    'document.getElementById("chat-log").textContent.includes("Host room-wide reply")'
  );
  assert.equal(
    await guests[1].ev(
      'document.getElementById("chat-log").textContent.includes("Host room-wide reply")'
    ),
    false
  );
  await click(guests[1], 'chat-disabling-btn');
  await click(host, 'options-dropdown-btn');
  await click(host, 'graphic-submenu-btn');
  await click(host, 'graphic-soft-btn');
  assert.equal(
    await host.ev(
      'document.getElementById("game-canvas").classList.contains("graphic-soft")'
    ),
    true
  );
  await click(host, 'options-dropdown-btn');
  await click(host, 'graphic-submenu-btn');
  await click(host, 'graphic-sharp-btn');
  await click(host, 'options-dropdown-btn');
  await click(host, 'speed-submenu-btn');
  assert.equal(
    await host.ev(
      'document.getElementById("speed-submenu").classList.contains("show")'
    ),
    true
  );
  await screenshot(host, 'classic-options-menu.png');
  await click(host, 'medium-speed-btn');
  assert.equal(
    await guests[0].ev('document.getElementById("speed-submenu-btn").disabled'),
    true
  );
  await click(host, 'start');
  for (const guest of guests) await guest.until('__volley.session.lastFrame>3');
  assert.deepEqual(
    await host.ev('__volley.game.players.map(p=>p.isComputer)'),
    [false, false, false, false]
  );
  for (const guest of guests)
    await guest.ev(
      'window.guestPhysicsSteps=0; const original=__volley.game.physics.runEngineForNextFrame.bind(__volley.game.physics);__volley.game.physics.runEngineForNextFrame=(...args)=>{guestPhysicsSteps++;return original(...args);}'
    );
  await host.until('__volley.game.state === __volley.game.round');
  for (const page of [host, ...guests])
    await page.until(
      '!__volley.game.view.game.messages.gameStart.visible && getComputedStyle(document.getElementById("player-names")).display==="none"'
    );
  const labelEpoch = await guests[0].ev('__volley.session.epoch');
  await click(guests[0], 'player-labels-always-btn');
  assert.equal(
    await guests[0].ev(
      'getComputedStyle(document.getElementById("player-names")).display==="none"'
    ),
    false
  );
  assert.equal(
    await host.ev(
      'getComputedStyle(document.getElementById("player-names")).display==="none"'
    ),
    true,
    'label preference must not change another browser'
  );
  assert.equal(
    await guests[0].ev('__volley.session.epoch'),
    labelEpoch,
    'local visual preference must not restart a match'
  );
  await click(guests[0], 'player-labels-auto-btn');
  const player3 = guests[1],
    before = await host.ev('__volley.game.players[2].x');
  await key(player3, 'ArrowLeft', 'keyDown');
  await delay(400);
  await key(player3, 'ArrowLeft', 'keyUp');
  await delay(250);
  assert.ok(
    (await host.ev('__volley.game.players[2].x')) < before,
    'Remote P3 input must move P3 on the host'
  );
  const afterArrows = await host.ev('__volley.game.players[2].x');
  await key(player3, 'KeyG', 'keyDown');
  await delay(350);
  await key(player3, 'KeyG', 'keyUp');
  await delay(200);
  assert.ok(
    (await host.ev('__volley.game.players[2].x')) > afterArrows,
    'Solo RDFG aliases must control the same remote player as the arrow keys'
  );
  await key(player3, 'Space', 'keyDown');
  await key(player3, 'Space', 'keyUp');
  assert.equal(await player3.ev('document.activeElement.id'), 'chat-input');
  await key(player3, 'KeyG', 'keyDown');
  assert.equal(
    await player3.ev('__volley.session.keyboards[0].keyboard.rightKey.isDown'),
    false,
    'Typing in chat must not move the player'
  );
  await key(player3, 'KeyG', 'keyUp');
  await player3.ev(
    'document.getElementById("chat-input").value="In-game room chat"'
  );
  await key(player3, 'Enter', 'keyDown');
  await key(player3, 'Enter', 'keyUp');
  for (const page of [host, ...guests])
    await page.until(
      'document.getElementById("chat-log").textContent.includes("In-game room chat")'
    );
  await click(host, 'pause');
  for (const guest of guests)
    await guest.until('__volley.session.phase==="paused"');
  await delay(200);
  const positions = await host.ev('__volley.game.players.map(p=>[p.x,p.y])');
  const ball = await host.ev(
    '[__volley.game.physics.ball.x,__volley.game.physics.ball.y]'
  );
  for (const guest of guests) {
    assert.deepEqual(
      await guest.ev('__volley.game.players.map(p=>[p.x,p.y])'),
      positions
    );
    assert.deepEqual(
      await guest.ev(
        '[__volley.game.physics.ball.x,__volley.game.physics.ball.y]'
      ),
      ball
    );
    assert.equal(await guest.ev('guestPhysicsSteps'), 0);
  }
  await screenshot(player3, 'korean-guest-match.png');
  const beforeOptionsEpoch = await host.ev('__volley.session.epoch');
  await click(host, 'options-dropdown-btn');
  await click(host, 'speed-submenu-btn');
  await click(host, 'fast-speed-btn');
  await host.until(
    '!document.getElementById("settings-confirm").classList.contains("hidden")'
  );
  await delay(1100);
  await screenshot(host, 'classic-settings-dialog.png');
  await click(host, 'settings-confirm-no');
  assert.equal(await host.ev('__volley.session.epoch'), beforeOptionsEpoch);
  await click(host, 'options-dropdown-btn');
  await click(host, 'speed-submenu-btn');
  await click(host, 'fast-speed-btn');
  await click(host, 'settings-confirm-yes');
  await host.until(
    '__volley.session.settings.fps===30 && __volley.session.epoch===' +
      JSON.stringify(beforeOptionsEpoch)
  );
  for (const guest of guests)
    await guest.until(
      '__volley.session.settings.fps===30 && __volley.session.lastFrame>2'
    );
  assert.deepEqual(
    await host.ev('__volley.game.players.map(p=>p.isComputer)'),
    [false, false, false, false]
  );
  await liveOption(
    host,
    guests,
    'practice-mode-submenu-btn',
    'practice-mode-on-btn',
    '__volley.session.settings.practice===true && __volley.game.isPracticeMode===true'
  );
  for (const page of [host, ...guests])
    assert.deepEqual(
      await page.ev('__volley.game.view.game.scoreBoards.map(b=>b.visible)'),
      [false, false]
    );
  await liveOption(
    host,
    guests,
    'practice-mode-submenu-btn',
    'practice-mode-off-btn',
    '__volley.session.settings.practice===false && __volley.game.isPracticeMode===false'
  );
  console.log(
    'Classic UI: original menus, host-only live speed/practice options, room-wide chat, local chat disable, and text-safe rendering passed.'
  );
  if (process.env.PIKA_UI_ONLY) {
    await click(host, 'leave');
    console.log(
      'UI checks passed: actual rendered label visibility, local preference persistence, and chat behavior.'
    );
    return;
  }
  await host.ev(
    'document.getElementById("court-width").value="501";document.getElementById("serve-mode").value="fixed"'
  );
  const oldEpoch = await host.ev('__volley.session.epoch');
  await click(host, 'start');
  await host.until(`__volley.session.epoch!=='${oldEpoch}'`);
  for (const guest of guests)
    await guest.until(
      '__volley.game.halfWidth===501 && __volley.session.lastFrame>2'
    );
  assert.equal(
    await player3.ev('document.getElementById("game-canvas").width'),
    2004
  );
  await click(host, 'options-dropdown-btn');
  await click(host, 'court-submenu-btn');
  await host.ev('document.getElementById("synchronization").value="lockstep"');
  await click(host, 'settings-apply');
  await click(host, 'settings-confirm-yes');
  for (const page of [host, ...guests]) {
    await page.until(
      '__volley.session.lockstep && __volley.session.lastFrame>5'
    );
    assert.equal(await page.ev('__volley.session.lockstep.mesh'), true);
    await page.ev(
      'window.peerInputSenders=[];const receive=__volley.session.message.bind(__volley.session);__volley.session.message=(id,msg)=>{if(msg.type==="frame-input")peerInputSenders.push(id);return receive(id,msg);}'
    );
    await observeLocalSimulation(page);
  }
  await host.until('__volley.session.lastFrame>110');
  for (const page of [host, ...guests])
    assert.equal(await page.ev('new Set(peerInputSenders).size'), 3);
  for (const guest of guests) assert.ok(await guest.ev('localSteps>0'));
  // Missing input stalls all simulations; restoring the sender resumes them.
  await guests[0].ev(
    'window.originalTick=__volley.session.tick.bind(__volley.session);__volley.session.tick=()=>{}'
  );
  await delay(600);
  const stalled = await host.ev('__volley.session.lastFrame');
  await delay(350);
  assert.equal(await host.ev('__volley.session.lastFrame'), stalled);
  await guests[0].ev('__volley.session.tick=window.originalTick');
  await host.until('__volley.session.lastFrame>' + (stalled + 5));
  await assertSameSimulation(host, guests);
  await liveOption(
    host,
    guests,
    'speed-submenu-btn',
    'slow-speed-btn',
    '__volley.session.settings.fps===20 && __volley.game.normalFPS===20'
  );
  await liveOption(
    host,
    guests,
    'practice-mode-submenu-btn',
    'practice-mode-on-btn',
    '__volley.session.settings.practice===true && __volley.game.isPracticeMode===true'
  );
  await assertSameSimulation(host, guests);
  await liveOption(
    host,
    guests,
    'practice-mode-submenu-btn',
    'practice-mode-off-btn',
    '__volley.session.settings.practice===false && __volley.game.isPracticeMode===false'
  );
  await assertSameSimulation(host, guests);
  await click(host, 'pause');
  await host.until('__volley.session.phase==="playing"');
  await switchTopology(host, guests, 'star');
  await click(host, 'start');
  await host.until('__volley.session.lastFrame>95');
  for (const guest of guests)
    assert.equal(await guest.ev('__volley.session.lockstep.mesh'), false);
  await assertSameSimulation(host, guests);
  await switchTopology(host, guests, 'mesh');
  await click(host, 'start');
  await host.until('__volley.session.lastFrame>100');
  // A broken guest-to-guest edge must not misidentify either guest as the host.
  const otherGuest = await guests[1].ev('__volley.room.selfId');
  await guests[0].ev(
    '__volley.room.peers.get(' +
      JSON.stringify(otherGuest) +
      ').channel.close()'
  );
  for (const page of [host, ...guests])
    await page.until(
      '__volley.session.phase==="idle" && __volley.room.data.status==="lobby"'
    );
  assert.equal(
    await host.ev('Object.keys(__volley.room.data.members).length'),
    4
  );
  assert.equal(
    await host.ev('document.getElementById("start").disabled'),
    true
  );
  await click(host, 'reconnect-network');
  await assertConnections(host, guests, 'mesh');
  await click(host, 'start');
  await host.until('__volley.session.lastFrame>110');
  await click(guests[0], 'leave');
  await host.until(
    '__volley.game.players[1].isComputer && !__volley.room.data.seats[1]'
  );
  await browser.send('Target.closeTarget', { targetId: guests[2].targetId });
  await host.until(
    '__volley.game.players[3].isComputer && !__volley.room.data.seats[3]'
  );
  // A guest's mesh links can close before its host link. The approved
  // conservative fallback returns to the lobby until that departure settles.
  if (await host.ev('__volley.room.networkFault')) {
    assert.equal(
      await host.ev('Object.keys(__volley.room.data.members).length'),
      2
    );
    await click(host, 'reconnect-network');
    await assertConnections(host, [player3], 'mesh');
    await click(host, 'start');
  }
  await host.until('__volley.session.lastFrame>' + (stalled + 15));
  await assertSameSimulation(host, [player3]);
  await click(host, 'leave');
  await player3.until(
    '__volley.room.isHost && __volley.room.data.status==="lobby" && __volley.session.phase==="idle"'
  );
  await click(player3, 'leave');
  console.log(
    'Four browsers: real WebRTC input, host snapshots, switching to four-browser lockstep, identical full states, missing-input stalls, pause/resume, AI takeover, and host departure passed.'
  );
  const pairHost = await tab(port, 'ko');
  await pairHost.ev(
    'document.getElementById("layout").value="pairs";document.getElementById("layout").dispatchEvent(new Event("change"))'
  );
  await pairHost.ev(
    'document.getElementById("nickname").value="기억하는 이름";document.getElementById("pair-name").value="기억하는 친구"'
  );
  await click(pairHost, 'create');
  await pairHost.until(
    '!__volley.room.closed && !!__volley.room.data && !!__volley.room.data.members[__volley.room.selfId]'
  );
  assert.deepEqual(
    await pairHost.ev('__volley.room.data.members[__volley.room.selfId].names'),
    ['기억하는 이름', '기억하는 친구']
  );
  await pairHost.ev(
    'document.getElementById("local-name-1").value="Alice";document.getElementById("local-name-2").value="Bob";document.getElementById("names-form").requestSubmit()'
  );
  await pairHost.until(
    '__volley.room.data.members[__volley.room.selfId].names[1]==="Bob"'
  );
  await selectSlot(pairHost, '0,1');
  await selectSlot(pairHost, '2,3');
  assert.deepEqual(
    await pairHost.ev('__volley.room.data.members[__volley.room.selfId].names'),
    ['Alice', 'Bob']
  );
  await pairHost.until(
    'localStorage.getItem("myNickname")==="Alice" && localStorage.getItem("mySecondNickname")==="Bob"'
  );
  const pairGuest = await tab(port);
  await join(pairGuest, await pairHost.ev('__volley.room.id'), '0,1');
  await pairGuest.ev(
    'document.getElementById("local-name-1").value="Carol";document.getElementById("local-name-2").value="Dave";document.getElementById("names-form").requestSubmit()'
  );
  await pairHost.until(
    'Object.values(__volley.room.data.members).some(m=>m.names[1]==="Dave")'
  );
  await pairGuest.until(
    'document.getElementById("chat-speaker").options[1].textContent==="Dave"'
  );
  await randomizeLobby(pairHost, [pairGuest]);
  await selectSlot(pairHost, '2,3');
  await selectSlot(pairGuest, '0,1');
  await pairGuest.ev('document.getElementById("chat-speaker").value="1"');
  await click(pairGuest, 'chat-open-btn');
  await pairGuest.ev(
    'document.getElementById("chat-input").value="Dave speaking"'
  );
  await click(pairGuest, 'send-btn');
  await pairHost.until(
    'document.getElementById("chat-log").textContent.includes("Dave(P2): Dave speaking")'
  );
  await click(pairHost, 'options-dropdown-btn');
  await click(pairHost, 'practice-mode-submenu-btn');
  await click(pairHost, 'practice-mode-on-btn');
  await observeLocalSimulation(pairHost);
  await observeLocalSimulation(pairGuest);
  await click(pairHost, 'start');
  await pairGuest.until('__volley.game.isPracticeMode===true');
  assert.deepEqual(
    await pairGuest.ev('__volley.game.view.game.scoreBoards.map(b=>b.visible)'),
    [false, false]
  );
  assert.equal(
    await pairGuest.ev(
      'document.getElementById("practice-mode-submenu-btn").disabled'
    ),
    true
  );
  await pairGuest.until('__volley.session.lastFrame>3');
  await pairHost.until('__volley.game.state===__volley.game.round');
  const initial = await pairHost.ev(
    '__volley.game.players.slice(0,2).map(p=>p.x)'
  );
  await key(pairGuest, 'KeyG', 'keyDown');
  await key(pairGuest, 'ArrowRight', 'keyDown');
  await delay(350);
  await key(pairGuest, 'KeyG', 'keyUp');
  await key(pairGuest, 'ArrowRight', 'keyUp');
  await delay(200);
  const moved = await pairHost.ev(
    '__volley.game.players.slice(0,2).map(p=>p.x)'
  );
  assert.ok(
    moved[0] > initial[0] && moved[1] > initial[1],
    'Both local humans must independently control their slots'
  );
  await click(pairHost, 'pause');
  await pairGuest.until('__volley.session.phase==="paused"');
  await assertSameSimulation(pairHost, [pairGuest]);
  assert.ok(await pairGuest.ev('localSteps>0'));
  await screenshot(pairHost, 'two-browser-match.png');
  await pairGuest.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await screenshot(pairGuest, 'classic-mobile.png');
  assert.ok(
    await pairGuest.ev(
      'document.documentElement.scrollWidth<=window.innerWidth+2'
    ),
    'Mobile UI must not overflow horizontally'
  );
  await click(pairHost, 'options-dropdown-btn');
  await click(pairHost, 'court-submenu-btn');
  await pairHost.ev('document.getElementById("synchronization").value="host"');
  await click(pairHost, 'settings-apply');
  await click(pairHost, 'settings-confirm-yes');
  await pairGuest.until(
    '!__volley.session.lockstep && __volley.session.settings.synchronization==="host" && __volley.session.lastFrame>5'
  );
  const priorGuestSteps = await pairGuest.ev('localSteps');
  await pairGuest.until('__volley.session.lastFrame>15');
  assert.equal(
    await pairGuest.ev('localSteps'),
    priorGuestSteps,
    'Host-only mode must not simulate on guests'
  );
  const rosterBeforeReset = await pairHost.ev('__volley.room.data.members');
  await click(pairHost, 'options-dropdown-btn');
  await click(pairHost, 'reset-to-default-btn');
  await pairHost.until(
    '!document.getElementById("settings-confirm").classList.contains("hidden")'
  );
  await click(pairHost, 'settings-confirm-yes');
  await pairGuest.until(
    '__volley.game.isPracticeMode===false && __volley.session.lastFrame>2'
  );
  assert.deepEqual(
    await pairHost.ev('__volley.room.data.members'),
    rosterBeforeReset
  );
  assert.deepEqual(
    await pairGuest.ev('__volley.game.view.game.scoreBoards.map(b=>b.visible)'),
    [true, true]
  );
  assert.ok(await pairGuest.ev('!!__volley.session.lockstep'));
  console.log(
    'Lobby: unassigned entry, release/reselect, occupied-seat protection, per-player pair names, speaker selection, practice mode and reset preserving roster passed.'
  );
  await click(pairHost, 'leave');
  await pairGuest.until(
    '__volley.room.isHost && __volley.room.data.status==="lobby"'
  );
  await click(pairGuest, 'leave');
  assert.deepEqual(errors, []);
  assert.equal(rooms.size, 0);
  console.log(
    'Two browsers: two local players per browser, reverse-team host, controls, pause, and cleanup passed.'
  );
  const sharedHost = await tab(port);
  await click(sharedHost, 'create');
  await sharedHost.until(
    '!__volley.room.closed && !!__volley.room.data && !!__volley.room.data.members[__volley.room.selfId]'
  );
  await selectSlot(sharedHost, '0');
  const sharedGuest = await tab(port, 'en', true, sharedHost.contextId);
  assert.equal(sharedGuest.contextId, sharedHost.contextId);
  await join(sharedGuest, await sharedHost.ev('__volley.room.id'), '1');
  assert.notEqual(
    await sharedHost.ev('__volley.room.selfId'),
    await sharedGuest.ev('__volley.room.selfId')
  );
  await sharedHost.until(
    'Object.keys(__volley.room.data.members).length===2 && Object.values(__volley.room.data.members).every(m=>m.slots.length===1)'
  );
  await sharedHost.send('Page.bringToFront');
  await click(sharedHost, 'start');
  await sharedGuest.until('__volley.session.lastFrame>2');
  await click(sharedHost, 'leave');
  await sharedGuest.until(
    '__volley.room.isHost && __volley.room.data.status==="lobby"'
  );
  await click(sharedGuest, 'leave');
  await click(sharedHost, 'create');
  await sharedHost.until('!__volley.room.closed && !!__volley.room.data');
  await selectSlot(sharedHost, '0');
  await join(sharedGuest, await sharedHost.ev('__volley.room.id'), '1');
  await assertConnections(sharedHost, [sharedGuest], 'mesh');
  await click(sharedHost, 'start');
  await sharedGuest.until('__volley.session.lastFrame>3');
  await click(sharedHost, 'leave');
  await sharedGuest.until(
    '__volley.room.isHost && __volley.room.data.status==="lobby"'
  );
  await click(sharedGuest, 'leave');
  console.log(
    'Same browser profile: separate tabs join independently, select different slots, run lockstep physics, and close cleanly.'
  );
  if (matchmakingApp) {
    for (const layout of ['four', 'pairs']) {
      const pages = [];
      for (let i = 0; i < (layout === 'four' ? 4 : 2); i++) {
        const page = await tab(port, i % 2 ? 'ko' : 'en');
        pages.push(page);
        await page.ev(
          'document.getElementById("layout").value=' + JSON.stringify(layout)
        );
        await click(page, 'quick-match');
        await page.until(
          '!__volley.room.closed && !!__volley.room.data && !!__volley.room.data.members[__volley.room.selfId]'
        );
        assert.deepEqual(
          await page.ev(
            '__volley.room.data.members[__volley.room.selfId].slots'
          ),
          []
        );
        await selectSlot(
          page,
          layout === 'four' ? String(i) : i === 0 ? '0,1' : '2,3'
        );
        if (i > 0)
          await page.until(
            'Array.from(__volley.room.peers.keys()).some(id=>__volley.room.connected(id))'
          );
      }
      const h = pages[0];
      await h.until(
        'Object.keys(__volley.room.data.members).length===' + pages.length
      );
      assert.deepEqual(await h.ev('__volley.room.data.seats.map(Boolean)'), [
        true,
        true,
        true,
        true,
      ]);
      await h.until(
        'Array.from(__volley.room.peers.keys()).every(id=>__volley.room.connected(id))'
      );
      await click(h, 'start');
      await pages[1].until('__volley.session.lastFrame>2');
      await screenshot(h, 'quick-match-' + layout + '.png');
      await click(h, 'leave');
      for (const page of pages.slice(1))
        await page.until('__volley.room.closed');
    }
    const early = await tab(port);
    await click(early, 'quick-match');
    await early.until(
      '!__volley.room.closed && !!__volley.room.data && !!__volley.room.data.members[__volley.room.selfId]'
    );
    await selectSlot(early, '0');
    await early.until(
      '!document.getElementById("create").disabled || document.getElementById("connect-panel").hidden'
    );
    // Wait for the create/publish operation to release the UI before starting early.
    await early.until(
      'document.getElementById("status").textContent.includes("Quick Match room open")'
    );
    assert.equal(
      await early.ev('document.getElementById("start").disabled'),
      true
    );
    const buddy = await tab(port);
    await click(buddy, 'quick-match');
    await buddy.until(
      '!__volley.room.closed && !!__volley.room.data?.members[__volley.room.selfId]'
    );
    await selectSlot(buddy, '1');
    await assertConnections(early, [buddy], 'mesh');
    await click(early, 'start');
    await early.until('__volley.session.epoch !== null');
    assert.deepEqual(
      await early.ev('__volley.game.players.map(p=>p.isComputer)'),
      [false, false, true, true]
    );
    const next = await tab(port);
    await click(next, 'quick-match');
    await next.until(
      '!__volley.room.closed && !!__volley.room.data && !!__volley.room.data.members[__volley.room.selfId]'
    );
    assert.notEqual(
      await early.ev('__volley.room.id'),
      await next.ev('__volley.room.id')
    );
    await early.until('!document.getElementById("leave").disabled');
    await next.until('!document.getElementById("leave").disabled');
    await click(early, 'leave');
    await buddy.until(
      '__volley.room.isHost && __volley.room.data.status==="lobby"'
    );
    await click(buddy, 'leave');
    await click(next, 'leave');
    await early.until('__volley.room.closed');
    await next.until('__volley.room.closed');
    await delay(200);
    assert.equal(rooms.size, 0);
    assert.deepEqual(errors, []);
    console.log(
      'Quick Match: real server assignment for four solo browsers and two pairs, WebRTC, early AI start, and no joining a running match passed.'
    );
  }
  for (const action of [
    'claim',
    'selectSlots',
    'randomizeSlots',
    'rename',
    'networkReady',
    'beginMatch',
    'update',
    'remove',
    'rebuildNetwork',
  ])
    assert.equal(
      signalingOperations.get(action) || 0,
      0,
      action + ' must use WebRTC'
    );
  console.log('Screenshots: ' + artifacts);
})()
  .catch((error) => {
    console.error(error);
    if (errors.length)
      console.error('Browser exceptions:', JSON.stringify(errors));
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const item of allConnections)
      try {
        item.ws.close();
      } catch {}
    if (chrome) chrome.kill();
    server.close();
    await delay(1000);
    const target = path.resolve(profile),
      tempRoot = path.resolve(os.tmpdir()) + path.sep;
    if (
      target.startsWith(tempRoot) &&
      path.basename(target).startsWith('pikavolley-online-')
    ) {
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch {}
    }
  });
