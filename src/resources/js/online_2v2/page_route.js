// Directory-relative assets/links need a trailing slash, including on dev servers.
export function normalizeLanguageDirectory(
  location = window.location,
  history = window.history
) {
  const url = new URL(location.href);
  if (!/\/(?:en|ko|zh)(?:\/replay)?$/.test(url.pathname)) return;
  url.pathname += '/';
  history.replaceState(history.state, '', url.href);
}
