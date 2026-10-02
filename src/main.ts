/**
 * Kart Party bootstrap: WebGL2 detection, global error toasts, then the engine (Game, an
 * IGameHost) and the party layer (PartyApp: phones-as-controllers, lobby, tutorial, overlays).
 *
 * Dev/test only: `?stub=1` swaps the engine for a lightweight stub (src/party/dev/StubGame.ts,
 * loaded via dynamic import so it never runs in a normal session).
 */
import type { IGameHost } from './game/api';
import { showToast } from './ui/toast';
import './party/party.css';

function hasWebGL2(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: false });
    return !!gl && typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  } catch {
    return false;
  }
}

function showFatal(title: string, body: string): void {
  document.getElementById('kp-fatal')?.remove();
  const wrap = document.createElement('div');
  wrap.id = 'kp-fatal';
  wrap.className = 'kp-fatal';
  const panel = document.createElement('div');
  panel.className = 'kp-fatal-panel';
  const kicker = document.createElement('div');
  kicker.className = 'kp-fatal-kicker';
  kicker.textContent = 'KART PARTY';
  const h = document.createElement('h2');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = body;
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'kp-fatal-btn';
  retry.textContent = 'RELOAD';
  retry.addEventListener('click', () => window.location.reload());
  panel.append(kicker, h, p, retry);
  wrap.appendChild(panel);
  document.body.appendChild(wrap);
}

function installErrorToasts(): void {
  let errorToasts = 0;
  let windowStart = performance.now();
  const report = (message: string, err: unknown): void => {
    console.error(message, err);
    const now = performance.now();
    if (now - windowStart > 30_000) {
      windowStart = now;
      errorToasts = 0;
    }
    if (errorToasts < 3) {
      errorToasts++;
      showToast(message, 'error');
    }
  };
  window.addEventListener('error', (ev) => {
    // Resource load errors (e.g. a missing QR image) bubble as plain Events: ignore them.
    if (!(ev instanceof ErrorEvent)) return;
    report(`Something went wrong: ${ev.message || 'unknown error'}`, ev.error);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev.reason instanceof Error ? ev.reason.message : String(ev.reason);
    report(`Something went wrong: ${reason}`, ev.reason);
  });
}

async function createEngine(app: HTMLElement): Promise<IGameHost> {
  const stub = new URLSearchParams(window.location.search).get('stub') === '1';
  if (stub) {
    const { StubGame } = await import('./party/dev/StubGame');
    return new StubGame(app);
  }
  const { Game } = await import('./game/Game');
  // Note: do NOT call the legacy `start()` — it opens the solo keyboard menu. PartyApp calls showDemo().
  return new Game(app) as unknown as IGameHost;
}

async function boot(): Promise<void> {
  const app = document.getElementById('app') ?? document.body.appendChild(document.createElement('div'));
  app.id = 'app';
  const stub = new URLSearchParams(window.location.search).get('stub') === '1';

  if (!stub && !hasWebGL2()) {
    showFatal(
      'WEBGL2 REQUIRED',
      'Kart Party needs a browser with WebGL 2 and hardware acceleration enabled. ' +
        'Try the latest Chrome, Edge, Firefox or Safari, and make sure GPU acceleration is switched on.',
    );
    return;
  }
  installErrorToasts();

  let game: IGameHost;
  try {
    game = await createEngine(app);
    (window as unknown as { __kartParty?: IGameHost }).__kartParty = game;
  } catch (err) {
    console.error('[main] failed to start the game engine', err);
    showFatal(
      'THE GAME COULDN’T START',
      'Something went wrong while starting the 3D engine. Try reloading; if it keeps happening, ' +
        'try another browser (Chrome or Edge work best) and check that graphics acceleration is on.',
    );
    return;
  }

  try {
    const { PartyApp } = await import('./party/PartyApp');
    const party = new PartyApp(game);
    (window as unknown as { __partyApp?: unknown }).__partyApp = party;
  } catch (err) {
    console.error('[main] failed to start the party layer', err);
    showFatal(
      'THE PARTY COULDN’T START',
      'The game loaded but the party lobby failed to start. Reload the page to try again.',
    );
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void boot(), { once: true });
} else {
  void boot();
}
