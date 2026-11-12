import { translate } from './i18n.js';

export function setUpConnectionFeedback() {
  const screen = document.createElement('dialog');
  screen.id = 'connecting-screen';
  screen.setAttribute('aria-labelledby', 'connecting-title');
  const spinner = document.createElement('div');
  spinner.className = 'connecting-spinner';
  spinner.setAttribute('aria-hidden', 'true');
  const title = document.createElement('h2');
  title.id = 'connecting-title';
  title.textContent = translate('Connecting to the host…', '방장에게 연결 중…');
  const description = document.createElement('p');
  description.textContent = translate(
    'Please wait while the connection is established.',
    '연결이 완료될 때까지 잠시 기다려 주세요.'
  );
  description.setAttribute('role', 'status');
  screen.append(spinner, title, description);
  screen.addEventListener('cancel', (event) => event.preventDefault());
  screen.addEventListener('keydown', (event) => event.stopPropagation());
  screen.addEventListener('keyup', (event) => event.stopPropagation());
  document.body.append(screen);
  const pending = new Set();
  const copies = new WeakMap();
  const clearCopy = (button) => {
    const state = copies.get(button);
    if (!state) return;
    clearTimeout(state.timer);
    button.classList.remove('copy-confirmed');
    button.textContent = state.label;
    if (state.aria === null) button.removeAttribute('aria-label');
    else button.setAttribute('aria-label', state.aria);
  };
  return {
    connecting(source, active) {
      if (active) pending.add(source);
      else pending.delete(source);
      const creating = [...pending].some((key) => key.startsWith('create'));
      title.textContent = creating
        ? translate('Creating the room…', '방을 만드는 중…')
        : translate('Connecting to the host…', '방장에게 연결 중…');
      description.textContent = creating
        ? translate(
            'Please wait while your room is created.',
            '방이 만들어질 때까지 잠시 기다려 주세요.'
          )
        : translate(
            'Please wait while the connection is established.',
            '연결이 완료될 때까지 잠시 기다려 주세요.'
          );
      if (pending.size && !screen.open) screen.showModal();
      else if (!pending.size && screen.open) screen.close();
    },
    clearCopy,
    copied(button) {
      let state = copies.get(button);
      if (!state) {
        state = {
          label: button.textContent,
          aria: button.getAttribute('aria-label'),
        };
        copies.set(button, state);
      }
      clearCopy(button);
      const label = document.createElement('span');
      label.className = 'copy-label';
      label.textContent = state.label;
      const result = document.createElement('span');
      result.className = 'copy-result';
      result.textContent = '✓';
      result.setAttribute('aria-hidden', 'true');
      button.replaceChildren(label, result);
      button.setAttribute(
        'aria-label',
        button.id === 'copy-link'
          ? translate('Invitation link copied.', '초대 링크를 복사했습니다.')
          : translate('Room code copied.', '방 코드를 복사했습니다.')
      );
      // Restart feedback on repeated copies; the hidden label preserves sizing.
      void button.offsetWidth;
      button.classList.add('copy-confirmed');
      state.timer = setTimeout(() => clearCopy(button), 1400);
    },
  };
}
