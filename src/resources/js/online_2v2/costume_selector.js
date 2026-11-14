import { SKIN_IDS, playerSkins } from './protocol.js';
import { COSTUME_NAMES, costumeParts, costumeId } from './costumes.js';
import { translate, translateMessage } from './i18n.js';
import { localStorageWrapper } from '../offline_version_js/utils/local_storage_wrapper.js';
const KEY = 'pv-online-costumes';
function costumeLabel(id) {
  const name = COSTUME_NAMES[id];
  return (typeof name === 'string' ? name : 'Classic')
    .split(' + ')
    .map((part) => translateMessage(part))
    .join(' + ');
}
export function loadCostumes(layout, storage = localStorageWrapper) {
  let saved;
  try {
    saved = JSON.parse(storage.get(KEY) || 'null');
  } catch {}
  return Array.from({ length: layout === 'pairs' ? 2 : 1 }, (_, i) =>
    SKIN_IDS.includes(saved?.[i]) ? saved[i] : 'classic'
  );
}
export class CostumeSelector {
  constructor({ room, library, status, layout, changed }) {
    Object.assign(this, { room, library, status, layout, changed });
    this.renderKey = '';
    this.dialog = document.createElement('dialog');
    this.dialog.id = 'costume-picker';
    this.title = document.createElement('h2');
    this.title.id = 'costume-picker-title';
    this.dialog.setAttribute('aria-labelledby', this.title.id);
    this.preview = document.createElement('figure');
    this.preview.className = 'costume-preview';
    this.previewImage = document.createElement('img');
    this.previewImage.width = this.previewImage.height = 128;
    this.previewImage.alt = '';
    this.previewName = document.createElement('figcaption');
    this.preview.append(this.previewImage, this.previewName);
    this.grid = document.createElement('div');
    this.grid.className = 'costume-grid';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = translate('Close', '닫기');
    close.addEventListener('click', () => this.dialog.close());
    this.applyButton = document.createElement('button');
    this.applyButton.type = 'button';
    this.applyButton.dataset.costumeApply = '';
    this.applyButton.textContent = translate('Apply', '적용');
    this.applyButton.addEventListener('click', () =>
      this.choose(
        costumeId(
          this.draft.head,
          this.draft.neck,
          this.draft.skin,
          this.draft.eyes
        )
      )
    );
    const actions = document.createElement('div');
    actions.className = 'costume-actions';
    actions.append(this.applyButton, close);
    this.dialog.append(this.title, this.preview, this.grid, actions);
    document.body.append(this.dialog);
    this.dialog.addEventListener('close', () =>
      document
        .querySelector(
          (room.closed ? '#costume-landing' : '#costume-lobby') +
            ' [data-local-costume="' +
            this.index +
            '"]'
        )
        ?.focus()
    );
  }
  own() {
    const r = this.room;
    return !r.closed ? r.data?.members[r.selfId] : null;
  }
  choices() {
    const member = this.own();
    return member
      ? playerSkins(member.skins, this.room.data.layout)
      : loadCostumes(this.layout());
  }
  open(index) {
    if (this.pending) return;
    if (
      !this.room.closed &&
      (this.room.data.status !== 'lobby' || this.room.handoff)
    )
      return;
    if (index < 0 || index >= this.choices().length) return;
    this.index = index;
    this.title.textContent =
      translate('Choose a costume', '의상 선택') +
      ' — ' +
      translate('Player', '플레이어') +
      ' ' +
      (index + 1);
    this.draft = costumeParts(this.choices()[index]);
    this.renderOptions();
    if (!this.dialog.open) this.dialog.showModal();
    this.grid.querySelector('[aria-pressed="true"]')?.focus();
  }
  showSelection() {
    const id = costumeId(
      this.draft.head,
      this.draft.neck,
      this.draft.skin,
      this.draft.eyes
    );
    this.previewImage.src = this.library.icon(id);
    this.previewName.textContent = costumeLabel(id);
  }
  renderOptions(focusPart, focusOption) {
    this.grid.replaceChildren();
    this.showSelection();
    for (const [part, options] of [
      ['skin', ['pikachu', 'cyborg']],
      ['head', ['none', 'cap', 'headband', 'crown', 'headphones']],
      ['neck', ['none', 'scarf', 'bowtie']],
      [
        'eyes',
        [
          'none',
          'sunglasses',
          'round-glasses',
          'triangle-sunglasses',
          'star-sunglasses',
        ],
      ],
    ]) {
      const group = document.createElement('fieldset');
      const legend = document.createElement('legend');
      legend.textContent =
        part === 'skin'
          ? translate('Skin', '스킨')
          : part === 'head'
          ? translate('Head', '머리')
          : part === 'neck'
          ? translate('Neck', '목')
          : translate('Eyewear', '안경');
      const row = document.createElement('div');
      row.className = 'costume-options';
      group.append(legend, row);
      for (const option of options) {
        const candidate = { ...this.draft, [part]: option };
        const id = costumeId(
          candidate.head,
          candidate.neck,
          candidate.skin,
          candidate.eyes
        );
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.part = part;
        button.dataset.option = option;
        button.setAttribute(
          'aria-pressed',
          String(this.draft[part] === option)
        );
        const image = document.createElement('img');
        image.src = this.library.icon(id);
        image.alt = '';
        image.width = image.height = 64;
        const name = document.createElement('span');
        name.textContent =
          option === 'none'
            ? translate('None', '없음')
            : translateMessage(
                option === 'pikachu' ? 'Pikachu' : COSTUME_NAMES[option]
              );
        button.append(image, name);
        button.addEventListener('click', () => {
          this.draft[part] = option;
          this.renderOptions(part, option);
        });
        row.append(button);
      }
      this.grid.append(group);
    }
    if (focusPart)
      this.grid
        .querySelector(
          '[data-part="' + focusPart + '"][data-option="' + focusOption + '"]'
        )
        ?.focus();
  }
  async choose(id) {
    if (this.pending) return;
    this.pending = true;
    this.applyButton.disabled = true;
    const index = this.index;
    this.grid.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      if (!this.room.closed)
        await this.room.store.request('skin', {
          index,
          skinId: id,
        });
      const saved = loadCostumes('pairs');
      saved[index] = id;
      localStorageWrapper.set(KEY, JSON.stringify(saved));
      this.dialog.close();
      this.renderKey = '';
      this.changed();
    } catch (error) {
      this.status(error.message, true);
    } finally {
      this.pending = false;
      this.applyButton.disabled = false;
      this.grid.querySelectorAll('button').forEach((b) => (b.disabled = false));
    }
  }
  update() {
    const r = this.room,
      member = this.own(),
      skins = this.choices(),
      layout = !r.closed ? r.data.layout : this.layout();
    const allowed = r.closed || (r.data.status === 'lobby' && !r.handoff);
    if (!allowed && this.dialog.open) this.dialog.close();
    const key = JSON.stringify([
      r.closed,
      layout,
      skins,
      member?.slots,
      allowed,
    ]);
    if (key === this.renderKey) return;
    this.renderKey = key;
    for (const id of ['costume-landing', 'costume-lobby']) {
      const root = document.getElementById(id);
      root.replaceChildren();
      for (let i = 0; i < (layout === 'pairs' ? 2 : 1); i++) {
        const card = document.createElement('div');
        card.className = 'local-costume';
        const image = document.createElement('img');
        image.src = this.library.icon(skins[i], member?.slots[i] ?? -1);
        image.alt = '';
        image.width = image.height = 64;
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.localCostume = i;
        button.disabled = !allowed;
        button.textContent =
          (i === 0
            ? translate('Costume', '의상')
            : translate('Second player costume', '두 번째 선수 의상')) +
          ': ' +
          costumeLabel(skins[i]);
        button.addEventListener('click', () => this.open(i));
        card.append(image, button);
        root.append(card);
      }
    }
  }
}
