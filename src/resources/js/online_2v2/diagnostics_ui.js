import { translate } from './i18n.js';

export function setUpDiagnosticsUI(room, session, diagnostics) {
  const t = translate;
  const panel = document.createElement('details');
  panel.id = 'network-diagnostics';
  panel.hidden = true;
  const indicator = document.createElement('summary');
  indicator.id = 'ping-indicator';
  const body = document.createElement('div');
  body.className = 'network-diagnostics-body';
  const title = document.createElement('strong');
  title.textContent = t('Connection diagnostics', '연결 상태');
  const explanation = document.createElement('p');
  explanation.textContent = t(
    'Ping is round-trip time, including browser scheduling and data-channel queues. It is not exact input delay.',
    '핑은 브라우저 처리와 데이터 채널 대기를 포함한 왕복 시간입니다. 실제 입력 지연과는 다릅니다.'
  );
  const scroll = document.createElement('div');
  scroll.className = 'network-table-scroll';
  const table = document.createElement('table');
  table.id = 'ping-table';
  const head = document.createElement('thead'),
    headRow = document.createElement('tr');
  for (const label of [
    t('Connection', '연결'),
    t('Average ping', '평균 핑'),
    t('Recent range', '최근 범위'),
    t('Route', '경로'),
    t('Status', '상태'),
  ]) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = label;
    headRow.appendChild(th);
  }
  head.appendChild(headRow);
  const rows = document.createElement('tbody');
  table.append(head, rows);
  scroll.appendChild(table);
  const wait = document.createElement('p');
  wait.id = 'input-wait';
  wait.setAttribute('role', 'status');
  const footer = document.createElement('p');
  footer.className = 'network-diagnostics-note';
  footer.textContent = t(
    'Five initial samples; then a rolling average of up to ten. High ping or large variation can cause stalls. Background tabs may respond slowly.',
    '처음 5회 측정 후 최근 최대 10회의 평균을 표시합니다. 높은 핑이나 큰 변동은 끊김을 유발할 수 있습니다. 백그라운드 탭은 응답이 느릴 수 있습니다.'
  );
  body.append(title, explanation, scroll, wait, footer);
  panel.append(indicator, body);
  document.getElementById('menu-bar').insertAdjacentElement('afterend', panel);
  panel.addEventListener('keydown', (event) => event.stopPropagation());
  panel.addEventListener('keyup', (event) => event.stopPropagation());
  indicator.addEventListener('click', (event) => {
    if (event.detail) indicator.blur();
  });
  let previousRoom = null,
    previousLobby = null;
  const label = (id) => {
    const member = room.data?.members[id];
    if (!member) return t('Disconnected', '연결 끊김');
    const slots = member.slots || [];
    const names = Array.isArray(member.names)
      ? member.names
      : [member.name || t('Player', '플레이어')];
    return (
      (slots.length
        ? slots.map((slot) => 'P' + (slot + 1)).join('+')
        : t('Lobby', '대기실')) +
      ' (' +
      names.join(' + ') +
      ')'
    );
  };
  const route = (value) =>
    value === 'turn'
      ? 'TURN'
      : value === 'direct'
      ? t('Direct', '직접 연결')
      : t('Unknown', '알 수 없음');
  const render = (snapshot) => {
    panel.hidden = !snapshot.active;
    if (!snapshot.active) {
      rows.replaceChildren();
      wait.textContent = '';
      previousRoom = null;
      previousLobby = null;
      return;
    }
    const lobby = room.data.status === 'lobby';
    if (previousRoom !== room.id || previousLobby !== lobby) panel.open = lobby;
    previousRoom = room.id;
    previousLobby = lobby;
    const mode = snapshot.pairs
      ? t('Local pairs', '로컬 2명씩')
      : snapshot.mesh
      ? t('Mesh', '메시')
      : t('Star', '스타');
    const ping =
      snapshot.average === null
        ? snapshot.expected
          ? snapshot.rows.some((row) => row.used && row.noResponse)
            ? t('No response', '응답 없음')
            : snapshot.rows.some((row) => row.used && row.count)
            ? t('Unavailable', '측정 불가')
            : t('Measuring…', '측정 중…')
          : t('Waiting for peers', '참가자 대기 중')
        : Math.round(snapshot.average) + ' ms';
    const scope =
      snapshot.expected > 1
        ? t('Slowest required link', '필수 연결 중 최대')
        : t('Ping', '핑');
    indicator.textContent =
      scope +
      ': ' +
      ping +
      ' · ' +
      mode +
      (snapshot.lockstep ? '' : ' · ' + t('Host physics', '방장 물리')) +
      (snapshot.unavailable
        ? ' · ' + snapshot.unavailable + ' ' + t('unavailable', '미측정')
        : '');
    indicator.title = t(
      'Open connection details. Ping is round-trip time.',
      '연결 상세 정보를 엽니다. 핑은 왕복 시간입니다.'
    );
    rows.replaceChildren();
    const data = room.data,
      ids = Object.keys(data.members);
    const measured = new Map(
      snapshot.rows.map((row) => [
        [row.source, row.peerId].sort().join(':'),
        row,
      ])
    );
    for (let a = 0; a < ids.length; a++)
      for (let b = a + 1; b < ids.length; b++) {
        const first = ids[a],
          second = ids[b],
          key = [first, second].sort().join(':');
        const physical =
          snapshot.mesh || first === data.hostId || second === data.hostId;
        const row = physical ? measured.get(key) : null;
        const fresh =
          row && row.age !== null && row.age < 10000 && !row.noResponse;
        const status = !physical
          ? t(
              'Via host · not directly measured',
              '방장 경유 · 직접 측정하지 않음'
            )
          : row?.noResponse
          ? t('No response', '응답 없음')
          : !row || !row.count
          ? t('Measuring…', '측정 중…')
          : !fresh
          ? t('Stale', '오래된 측정')
          : row.count < 5
          ? t('Measuring…', '측정 중…')
          : row.used
          ? t('Gameplay link', '경기에 사용하는 연결')
          : t('Unused by host physics', '방장 물리 모드에서 미사용');
        const tr = document.createElement('tr');
        tr.dataset.link = key;
        for (const value of [
          label(first) + ' ↔ ' + label(second),
          row?.count ? Math.round(row.average) + ' ms' : '—',
          row?.count
            ? Math.round(row.low) + '–' + Math.round(row.high) + ' ms'
            : '—',
          physical
            ? route(row?.route) +
              (row?.protocol && row.protocol !== 'unknown'
                ? ' / ' + row.protocol.toUpperCase()
                : '')
            : t('Via host', '방장 경유'),
          status,
        ]) {
          const td = document.createElement('td');
          td.textContent = value;
          tr.appendChild(td);
        }
        rows.appendChild(tr);
      }
    if (!ids.length || ids.length === 1) {
      const tr = document.createElement('tr'),
        td = document.createElement('td');
      td.colSpan = 5;
      td.textContent = t('Waiting for peers', '참가자 대기 중');
      tr.appendChild(td);
      rows.appendChild(tr);
    }
    if (snapshot.wait) {
      wait.textContent =
        (snapshot.wait.hostFrame
          ? t('Waiting for host frame', '방장 프레임 대기 중')
          : t('Waiting for input', '입력 대기 중')) +
        ': ' +
        snapshot.wait.peers.map(label).join(', ') +
        ' · ' +
        Math.round(snapshot.wait.milliseconds) +
        ' ms';
    } else
      wait.textContent = snapshot.lockstep
        ? t(
            'No sustained input wait observed.',
            '지속적인 입력 대기가 관측되지 않았습니다.'
          )
        : t(
            'Host snapshots: input wait cannot be measured on guests.',
            '방장 스냅샷 방식: 게스트의 입력 대기 시간은 측정할 수 없습니다.'
          );
  };
  diagnostics.changed = render;
  render(diagnostics.snapshot());
  return { render, panel };
}
