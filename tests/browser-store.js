/* Development-only signaling double. No Firebase requests or hosted service are used. */
class BrowserTestStore {
  constructor() {
    this.uid = 'test' + crypto.randomUUID().replace(/-/g, '');
  }
  async token() {
    return this.uid;
  }
  async identity() {
    return this.uid;
  }
  async request(action, value) {
    const result = await fetch('/__test_signaling', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...value }),
    });
    const data = await result.json();
    if (!result.ok) throw new Error(data.error);
    return data;
  }
  create(id, hostId, name, layout, slots, settings) {
    return this.request('create', {
      id,
      hostId,
      name,
      layout,
      slots,
      settings,
    });
  }
  claim(id, clientId, name, slots) {
    return this.request('claim', { id, clientId, name, slots });
  }
  selectSlots(id, clientId, slots) {
    return this.request('selectSlots', { id, clientId, slots });
  }
  rename(id, clientId, names) {
    return this.request('rename', { id, clientId, names });
  }
  beginMatch(id, hostId, settings) {
    return this.request('beginMatch', { id, hostId, settings });
  }
  peek(id) {
    return this.request('get', { id });
  }
  update(id, value) {
    return this.request('update', { id, value });
  }
  remove(id, clientId) {
    return this.request('remove', { id, clientId });
  }
  connected(id, clientId) {
    return this.update(id, { ['members.' + clientId + '.connected']: true });
  }
  poll(action, value, receive, error, candidates = false) {
    let active = true,
      previous = '',
      seen = 0;
    const tick = async () => {
      try {
        const data = await this.request(action, value);
        if (!active) return;
        if (candidates) {
          for (const candidate of data.slice(seen)) receive(candidate);
          seen = data.length;
        } else {
          const key = JSON.stringify(data);
          if (key !== previous) {
            previous = key;
            receive(data);
          }
        }
      } catch (failure) {
        if (active) error(failure);
      }
      if (active) setTimeout(tick, 80);
    };
    tick();
    return () => {
      active = false;
    };
  }
  watch(id, receive, error) {
    return this.poll('get', { id }, receive, error);
  }
  watchSignal(id, peerId, receive, error) {
    return this.poll(
      'signal',
      { id, peerId },
      (value) => {
        if (value) receive(value);
      },
      error
    );
  }
  offer(id, peerId, offer) {
    return this.request('offer', { id, peerId, offer });
  }
  answer(id, peerId, answer) {
    return this.request('answer', { id, peerId, answer });
  }
  candidate(id, peerId, side, candidate) {
    return this.request('candidate', { id, peerId, side, candidate });
  }
  watchCandidates(id, peerId, side, receive, error) {
    return this.poll('candidates', { id, peerId, side }, receive, error, true);
  }
  close(id) {
    return this.request('close', { id });
  }
}
window.__PIKA_TEST_STORE__ = new BrowserTestStore();
