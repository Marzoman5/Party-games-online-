/** Room-code entry (no ?room / room not found) and fatal connection errors. */
import { lsGet, lsSet } from '../settings';
import { net, normalizeRoom, tokenKey } from '../net';
import { setState, state, type ViewId } from '../store';
import { button, h, setText, show } from '../ui';
import type { View } from './view';

export function joinRoom(code: string): void {
  const room = normalizeRoom(code);
  if (room.length !== 4) return;
  try {
    const u = new URL(location.href);
    u.searchParams.set('room', room);
    history.replaceState(null, '', u.toString());
  } catch {
    /* ignore */
  }
  net.connect(room);
}

export class JoinView implements View {
  readonly el: HTMLElement;
  private input: HTMLInputElement;
  private msg: HTMLElement;
  private go: HTMLButtonElement;

  constructor() {
    this.input = h('input', {
      class: 'code-input',
      testid: 'room-input',
      type: 'text',
      inputmode: 'text',
      maxlength: 4,
      autocomplete: 'off',
      autocorrect: 'off',
      autocapitalize: 'characters',
      spellcheck: 'false',
      enterkeyhint: 'go',
      placeholder: 'ABCD',
      'aria-label': 'Room code',
    });
    this.input.addEventListener('input', () => {
      const v = normalizeRoom(this.input.value);
      if (this.input.value !== v) this.input.value = v;
      this.go.disabled = v.length !== 4;
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.submit();
    });
    this.msg = h('div', { class: 'join-msg', testid: 'join-msg' });
    this.go = button('JOIN ▶', 'btn-join', () => this.submit(), 'btn btn-start');
    this.go.disabled = true;
    this.el = h(
      'div',
      { class: 'screen join', testid: 'screen-join' },
      h(
        'div',
        { class: 'join-card' },
        h('div', { class: 'logo', html: 'KART<span>PARTY</span>' }),
        this.msg,
        h('div', { class: 'join-label', text: 'Enter the 4-letter code shown on the TV' }),
        h('div', { class: 'join-row' }, this.input, this.go),
      ),
    );
  }

  private submit(): void {
    const v = normalizeRoom(this.input.value);
    if (v.length !== 4) return;
    this.input.blur();
    joinRoom(v);
  }

  enter(): void {
    if (!this.input.value) this.input.value = state.room || lsGet('kp.lastRoom') || '';
    this.go.disabled = normalizeRoom(this.input.value).length !== 4;
  }

  update(_view: ViewId): void {
    const e = state.error;
    if (e && e.code === 'no_room') {
      setText(this.msg, `Room ${state.room} not found — check the code on the TV`);
      show(this.msg, true);
    } else {
      show(this.msg, false);
    }
  }
}

export class ErrorView implements View {
  readonly el: HTMLElement;
  private icon: HTMLElement;
  private title: HTMLElement;
  private text: HTMLElement;
  private retry: HTMLButtonElement;
  private other: HTMLButtonElement;

  constructor() {
    this.icon = h('div', { class: 'err-icon' });
    this.title = h('div', { class: 'err-title', testid: 'error-title' });
    this.text = h('div', { class: 'err-text' });
    this.retry = button('Try again', 'btn-retry', () => this.onRetry(), 'btn btn-start');
    this.other = button('Enter another code', 'btn-other-room', () => {
      net.halt();
      setState({ error: null, room: '' });
    }, 'btn btn-alt');
    this.el = h(
      'div',
      { class: 'screen error', testid: 'screen-error' },
      h('div', { class: 'join-card' }, this.icon, this.title, this.text, h('div', { class: 'err-btns' }, this.retry, this.other)),
    );
  }

  private onRetry(): void {
    const code = state.error?.code;
    if (code === 'bad_version') {
      location.reload();
      return;
    }
    if (code === 'kicked') lsSet(tokenKey(state.room), null);
    net.retry();
  }

  update(_view: ViewId): void {
    const e = state.error;
    const code = e?.code ?? '';
    let icon = '😕';
    let title = 'Connection problem';
    let text = e?.message || '';
    let retry = 'Try again';
    if (code === 'room_full') {
      icon = '🚗🚗🚗🚗';
      title = 'This party is full';
      text = 'Up to 4 racers can play at once. Try again when someone leaves.';
    } else if (code === 'bad_version') {
      icon = '🔄';
      title = 'Update needed';
      text = 'The game was updated. Reload to get the latest controller.';
      retry = 'Reload';
    } else if (code === 'kicked') {
      icon = '👋';
      title = 'You left the party';
      text = 'You were removed from this room.';
      retry = 'Join again';
    }
    setText(this.icon, icon);
    setText(this.title, title);
    setText(this.text, text);
    setText(this.retry, retry);
    this.retry.setAttribute('data-testid', code === 'bad_version' ? 'btn-reload' : 'btn-retry');
  }
}
