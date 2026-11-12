export const CLIENT_VERSION = Object.freeze(__CLIENT_VERSION__);
export const VERSION_MISMATCH =
  'Game versions do not match. Everyone must reload before joining this room.';
export const UPDATE_REQUIRED =
  'An update is available. Reload before creating, joining, or starting a match.';
export const UPDATE_CHECK_FAILED =
  'Could not check for updates. Check your connection and try again.';
export function sameVersion(value, expected = CLIENT_VERSION) {
  return (
    !!value &&
    value.format === expected.format &&
    value.protocol === expected.protocol &&
    value.build === expected.build &&
    value.engine === expected.engine
  );
}
export function assertCompatible(value) {
  if (!sameVersion(value)) throw new Error(VERSION_MISMATCH);
}
export function assertRoomCompatible(data) {
  assertCompatible(data?.compatibility);
  for (const member of Object.values(data.members || {}))
    assertCompatible(member.compatibility);
}
export class ClientUpdates {
  constructor({
    url,
    fetcher = (url, options) => fetch(url, options),
    changed = () => {},
  }) {
    this.url = url;
    this.fetcher = fetcher;
    this.changed = changed;
    this.state = 'checking';
    this.pending = null;
  }
  check() {
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        const url = new URL(this.url);
        url.searchParams.set('check', String(Date.now()));
        const response = await this.fetcher(url, {
          cache: 'no-store',
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) throw new Error('Version file unavailable.');
        const latest = await response.json();
        if (
          latest?.format !== 1 ||
          typeof latest.build !== 'string' ||
          typeof latest.engine !== 'string' ||
          typeof latest.protocol !== 'string'
        )
          throw new Error('Invalid version file.');
        this.state = sameVersion(latest) ? 'current' : 'outdated';
      } catch {
        this.state = this.state === 'outdated' ? 'outdated' : 'unavailable';
      }
      this.changed(this.state);
      return this.state;
    })().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  async ensureCurrent() {
    const state = await this.check();
    if (state !== 'current')
      throw new Error(
        state === 'outdated' ? UPDATE_REQUIRED : UPDATE_CHECK_FAILED
      );
  }
}
