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
  const names = Array.isArray(data.name)
    ? data.name
    : [data.name, ...(data.layout === 'pairs' ? ['Player 2'] : [])];
  if (action === 'create') {
    if (rooms.has(id)) throw Error('Room already exists');
    const room = {
      schema: 'pikavolley-2v2-v4',
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
  if (!room) throw Error('Room not found');
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
    signals.set(key, { ...data.endpoints, offer: data.offer });
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
const server = http.createServer(async (req, res) => {
  if (req.url === '/v1/match' && matchmakingApp)
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
        '; status=' +
        (await ev('document.getElementById("status")?.textContent')) +
        '; debug=' +
        JSON.stringify(
          await ev(
            '({phase:window.__volley?.session.phase,status:window.__volley?.room.data?.status,isHost:window.__volley?.room.isHost,closed:window.__volley?.room.closed,back:window.backDebug,network:__volley?.room&&{revision:__volley.room.data?.networkRevision,hold:__volley.room.rebuildingTarget,fault:__volley.room.networkFault,flags:Object.fromEntries(Object.entries(__volley.room.data?.members||{}).map(([id,m])=>[id,m.connected])),reports:Array.from(__volley.room.readyReports),writes:Array.from(__volley.room.readyWrites),peers:Array.from(__volley.room.peers).map(([id,p])=>({id,pc:p.pc.connectionState,channel:p.channel?.readyState,closed:p.notifiedClosed}))}})'
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
  const data = await host.ev('__volley.room.store.peek(__volley.room.id)');
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
  if (['create', 'find', 'join'].includes(id))
    await page.ev(
      "document.getElementById('about-with-your-friend').hidden=false"
    );
  await page.until(
    '(()=>{const button=document.getElementById(' +
      JSON.stringify(id) +
      ');if(button.disabled)return false;button.click();return true;})()'
  );
}
async function join(page, roomId, slot) {
  await page.ev(`document.getElementById('room-id').value='${roomId}'`);
  await click(page, 'find');
  await page.until('!document.getElementById("join").disabled');
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
    const { Matchmaker } = await import(
      pathToFileURL(path.join(serverRoot, 'src/matchmaker.js')).href
    );
    const { createApp } = await import(
      pathToFileURL(path.join(serverRoot, 'src/http_app.js')).href
    );
    const matchmaker = new Matchmaker({
      readRoom: async (id) => structuredClone(rooms.get(id)),
    });
    matchmakingApp = createApp({
      matchmaker,
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
  for (let i = 0; i < 100 && !fs.existsSync(active); i++) await delay(100);
  assert.ok(
    fs.existsSync(active),
    'Chrome must be installed or PIKA_CHROME set'
  );
  const port = Number(fs.readFileSync(active, 'utf8').split('\n')[0]);
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
  await host.ev('document.getElementById("synchronization").value="host"');
  await click(host, 'start');
  await host.until('__volley.session.epoch && __volley.game.view.game.visible');
  assert.deepEqual(
    await host.ev('__volley.game.players.map(p=>p.isComputer)'),
    [false, true, true, true]
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
  const guests = [];
  for (let slot = 1; slot < 4; slot++) {
    const guest = await tab(port, slot === 2 ? 'ko' : 'en');
    await join(guest, id, String(slot));
    guests.push(guest);
  }
  await host.until(
    '__volley.room.peers.size===3 && Array.from(__volley.room.peers.keys()).every(id=>__volley.room.connected(id))'
  );
  await assertConnections(host, guests, 'mesh');
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
  await host.until('__volley.session.lastFrame>' + (stalled + 15));
  await assertSameSimulation(host, [player3]);
  await click(host, 'leave');
  await player3.until(
    '__volley.room.closed && __volley.session.phase==="idle"'
  );
  console.log(
    'Four browsers: real WebRTC input, host snapshots, switching to four-browser lockstep, identical full states, missing-input stalls, pause/resume, AI takeover, and host departure passed.'
  );
  const pairHost = await tab(port, 'ko');
  await pairHost.ev(
    'document.getElementById("layout").value="pairs";document.getElementById("layout").dispatchEvent(new Event("change"))'
  );
  await click(pairHost, 'create');
  await pairHost.until(
    '!__volley.room.closed && !!__volley.room.data && !!__volley.room.data.members[__volley.room.selfId]'
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
    'document.getElementById("chat-log").textContent.includes("P2 · Dave: Dave speaking")'
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
  await pairGuest.until('__volley.room.closed');
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
  await sharedGuest.until('__volley.room.closed');
  await click(sharedHost, 'create');
  await sharedHost.until('!__volley.room.closed && !!__volley.room.data');
  await selectSlot(sharedHost, '0');
  await join(sharedGuest, await sharedHost.ev('__volley.room.id'), '1');
  await assertConnections(sharedHost, [sharedGuest], 'mesh');
  await click(sharedHost, 'start');
  await sharedGuest.until('__volley.session.lastFrame>3');
  await click(sharedHost, 'leave');
  await sharedGuest.until('__volley.room.closed');
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
    await click(early, 'start');
    await early.until('__volley.session.epoch !== null');
    assert.deepEqual(
      await early.ev('__volley.game.players.map(p=>p.isComputer)'),
      [false, true, true, true]
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
