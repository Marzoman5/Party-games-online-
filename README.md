# 🏁 Kart Party

> **Party quick start**
> 1. Install [Node.js 18+](https://nodejs.org), then in this folder run: `npm install && npm start`
> 2. The game opens in your browser — plug the laptop into the TV and press **F** (fullscreen).
> 3. Make sure everyone's phone is on the **same Wi-Fi** as the laptop.
> 4. Players scan the **QR code** (or type the address + 4-letter code shown on screen).
> 5. Pick a racer, tap **READY**, and the first player (the 👑 leader) starts the race from their phone.

Kart Party is a couch-multiplayer arcade kart racer: the game runs on a laptop or TV, and
**1–4 players use their phones as controllers** — no app install, just a web page. 8 karts per
race (humans + AI), 4 tracks, 13 items, drifting with mini-turbos, rocket starts, ramp tricks,
split-screen, Grand Prix mode. All characters, tracks and item names are original.

It works completely **offline on a local network**: no CDNs, no web fonts, no internet needed —
everything (3D models, textures, sounds, music, QR codes) is generated locally.

---

## Contents
- [Setup](#setup)
- [Firewall tips](#firewall-tips-phones-cant-connect)
- [TV mode](#tv-mode)
- [HTTPS / tilt steering](#https-mode-tilt-steering-on-iphone)
- [Controls](#controls)
- [Game flow](#game-flow)
- [Architecture & protocol](#architecture)
- [Testing](#testing)
- [Design decisions](#design-decisions)
- [Known limitations](#known-limitations)
- [Credits & licenses](#credits--licenses)

## Setup

Requirements: **Node.js 18 or newer** (20/22 recommended) and a modern browser on the host
(Chrome / Edge / Firefox / Safari with WebGL 2). Phones: iOS Safari 15+ or Android Chrome.

```bash
npm install        # once (needs internet once, to download dependencies)
npm start          # builds the game and starts the server, opens the host page
```

The server prints a banner like:

```
  KART PARTY is running!
  Open on the TV/laptop:  http://localhost:3000
  Phones join:            http://192.168.1.23:3000/play
```

1. Open `http://localhost:3000` on the laptop (it opens automatically) — that's the **host screen**.
2. Phones must be on the **same Wi-Fi network** as the laptop. They scan the QR code, or open
   the printed URL and type the 4-letter room code (also `http://<ip>:3000/play/ABCD` works).
3. If the laptop has several network adapters and the QR shows the wrong address, restart with
   `npm start -- --host-ip 192.168.1.23`.

Other options: `npm start -- --port 4000`, `--no-open`, `--quiet`. After the first build you can
start faster with `npm run serve` (skips the rebuild).

Guest Wi-Fi networks often have **"client isolation"** turned on (devices can't see each other) —
use the main network, or turn on the laptop's mobile hotspot and have everyone join that.

### Firewall tips (phones can't connect)

The phone page must reach the laptop on port 3000 (and 3443 for HTTPS mode).

- **Windows**: the first time you run `npm start`, Windows Defender Firewall asks whether Node.js may
  communicate on networks — tick **Private networks** and click *Allow*. If you missed it:
  *Windows Security → Firewall & network protection → Allow an app through firewall → Node.js →
  tick Private*. Also make sure your Wi-Fi is set to a **Private** network
  (*Settings → Network → Wi-Fi → your network → Network profile: Private*).
  Command-line alternative (admin PowerShell):
  `New-NetFirewallRule -DisplayName "Kart Party" -Direction Inbound -Protocol TCP -LocalPort 3000,3443 -Action Allow -Profile Private`
- **macOS**: if asked "Do you want the application node to accept incoming network connections?",
  click **Allow**. Otherwise: *System Settings → Network → Firewall → Options* → add/allow `node`,
  and make sure "Block all incoming connections" is off.
- **Linux**: e.g. `sudo ufw allow 3000/tcp` (and `3443/tcp`).
- Quick check: open `http://<laptop-ip>:3000/play` on a phone. If it doesn't load, it's the
  network/firewall, not the game.

## TV mode

The host UI has a "10-foot" **TV mode**: bigger HUD, text and QR code, higher contrast, and ~5%
overscan-safe margins so nothing is cut off at the TV's edges.

- On by default when the browser window is **≥ 1920 px wide**; toggle with the **📺 button** or
  **T** key on the title/lobby screens (remembered). Force it with `?tv=1` / `?tv=0`.
- **Fullscreen**: the ⛶ button or the **F** key. The mouse cursor hides itself during races.
- Rendering uses the device pixel ratio with a resolution cap, plus an **automatic quality scaler**
  (4 tiers: resolution, shadows, particles, bloom) that adapts to hold ~60 fps — e.g. 4-player
  split-screen on a 4K TV renders at a capped internal resolution. Force a tier with `?quality=0..3`.

## HTTPS mode (tilt steering on iPhone)

Touch steering works everywhere over plain HTTP. **Tilt steering** needs motion sensors, which
iOS (and newer Android) only allow on **HTTPS** pages. Kart Party can make its own certificate:

```bash
npm run start:https
```

This serves HTTPS on port **3443** (plus HTTP on 3000) with an automatically generated
self-signed certificate (cached in `./certs/`), and the QR code points to the `https://` address.

Because the certificate is self-signed, each phone shows a warning the first time:
- **iPhone (Safari)**: "This Connection Is Not Private" → tap **Show Details** → **visit this
  website** → **Visit Website**. Then on the controller open ⚙️ → **Tilt steering** and allow
  "Motion & Orientation Access" when asked. Use **Calibrate** while holding the phone in your
  normal driving position.
- **Android (Chrome)**: "Your connection is not private" → **Advanced** → **Proceed to … (unsafe)**.
  Then ⚙️ → Tilt steering.
- To avoid warnings entirely you can install the certificate (`certs/kart-party.crt`) as a trusted
  profile on the phone (iOS: AirDrop/email it, install the profile, then *Settings → General →
  About → Certificate Trust Settings* → enable it). Not needed for normal use.

## Controls

### Phone (hold sideways)

| Area | Action |
|---|---|
| **Left half** | **Steer** — put your thumb down anywhere and drag left/right (relative to where you touched) |
| **GAS** | Accelerate. **Auto-accelerate is ON by default**, so you don't need to hold it (turn off in ⚙️) |
| **DRIFT / HOP** | Hold while steering through corners. Sparks go **blue → orange → purple**; let go for a **mini-turbo**. Tap it while flying off a ramp for a **trick boost** |
| **ITEM** | Tap to use the item shown on the button (hold **BRAKE** while tapping to throw backwards) |
| **BRAKE** | Brake / reverse |
| **⏸** | Pause (everyone sees the pause menu) |
| **⚙️** | Settings: auto-accelerate, tilt steering + calibrate, sensitivity, vibration, left-handed layout |

**Rocket start:** with auto-accelerate on, the phone gives the gas at the right moment
automatically. Pressing GAS yourself just as **"1"** disappears also gives a rocket start —
press too early and you'll burn out.

The phone shows your position, lap, drift-spark meter and held item, vibrates on hits/boosts/laps
(Android; iOS doesn't support vibration), keeps the screen awake, and reconnects by itself.

### Host keyboard / gamepad (solo play without a phone)

On the title screen press **Enter** for single-player with keyboard/gamepad.

| Keyboard | Gamepad | Action |
|---|---|---|
| W / ↑ | RT | Accelerate |
| S / ↓ | LT | Brake / reverse |
| A D / ← → | Left stick | Steer |
| Space / Shift | A / RB | Hop / drift |
| E / Ctrl / Enter | X / LB | Use item |
| Q | | Look back |
| Esc / P | Start | Pause |
| M | | Mute |
| F | | Fullscreen |

## Game flow

1. **Title** — a live AI demo race plays behind the logo and the big QR code.
2. **Lobby** — players join, pick a name and a racer (each racer can be taken once), tap READY.
   The first player to join is the **leader 👑** (they can hand it over from their phone).
3. **How to play** — a ~25 s animated tutorial on the TV (and in sync on every phone) before
   the first race. Press DRIFT or ITEM to see your avatar react — proof your controller works.
   Everyone taps **Got it!**. Replay any time with *How to Play*. The leader can skip it.
4. **Setup** — the leader picks **Single Race** or **Grand Prix** (all 4 tracks, points table),
   track, **50/100/150cc**, and laps.
5. **Race** — intro flyover, countdown, go! Split-screen: 1 player full screen, 2 side-by-side
   (stacked on non-widescreen), 3–4 in quadrants (with 3 players the 4th quadrant shows the map
   and live standings). AI fills the grid to 8 karts. The first race shows helpful tips.
6. **Results** — then the leader picks **Next Race / Replay / Change Track / Back to Lobby**.

Anyone can **pause**; the leader can resume, restart or quit; others vote to resume.
If a phone disconnects mid-race an AI takes over that kart; reopening the page reclaims it.
New players can join between races (late joiners wait for the next race).

## Architecture

```
 phone /play ──ws──┐                          ┌── host page "/" (laptop/TV browser)
 phone /play ──ws──┤   Node server            │     Game engine (Three.js) — AUTHORITATIVE
 phone /play ──ws──┼── Express (static dist/) ├──   PartyApp: lobby, tutorial, overlays,
 phone /play ──ws──┘   ws relay /ws, QR, LAN  │     phone sync, pause/results/GP
                       IP, rooms, tokens      └──
```

- **Server** (`server/`, bundled to `dist-server/server.mjs`): Express serves the built pages
  (`/` host, `/play` phone), `GET /api/info`, `GET /api/qr.svg?data=…` (QR rendered server-side,
  offline), and a WebSocket relay at `/ws`. It owns only identity: 4-letter room codes, player ids
  and reconnect tokens. It relays phone input to the host immediately (no batching, no compression).
- **Host** (`src/game`, `src/party`, plus the base game modules): the browser simulation is
  authoritative — physics at a 120 Hz fixed step, AI, items, race logic. `src/game/api.ts`
  (`IGameHost`) is the boundary between the engine and the party layer.
- **Phone** (`src/phone`, `play.html`): a thin, three.js-free (~22 KB gzipped) view that renders
  whatever screen the host says and sends input.

### Protocol (`src/net/protocol.ts`)

All frames are JSON text over one WebSocket per client.

- **Input** (phone → host, ~60 Hz plus immediately on any button change), a compact array:
  `[0, seq, steer(-100..100), throttle(0..100), brake(0..100), buttons, itemPresses]` — buttons is
  a bitmask (1 drift, 2 item held, 4 look back); `itemPresses` is a wrapping counter incremented on
  every ITEM tap, so the host fires exactly one "use item" per tap even if a tap is shorter than a
  packet interval. The server appends the player id and forwards it instantly. On local Wi-Fi the
  added latency is the Wi-Fi hop (typically 5–30 ms); the relay itself adds < 1 ms.
- **Control** messages `{t: …}`: phone → server `join {room, token}` / `ping`; server → host
  `p_join`, `p_leave`, `from {p, m}`; host → server `host_hello {room, hostToken}`, `to {p, m}`,
  `kick`.
- **Host → phone**: `state` (full personalised menu/session snapshot: screen, players, setup,
  tutorial step, pause votes, results — sent only when it changes), `race` (position, lap, item,
  roulette, drift stage, countdown — ~10 Hz), `fx` (one-shot haptic cues).
- **Phone → host**: `profile`, `ready`, `tut_ok`, `tut_skip`, `setup`, `start`, `pause`, `resume`,
  `restart`, `quit`, `post {next|replay|track|lobby}`, `leader`, `tips`, `leave`.
- **Reconnect**: the phone keeps its token in `localStorage`; reconnecting (backoff 0.5 → 8 s)
  with the same token gets the same player id, so the host gives back the same slot and kart.
  The host page keeps its room in `sessionStorage`, so reloading the TV page keeps the room code.

See `CONTRACT.md` for the full module contract and file ownership.

## Testing

```bash
npm run typecheck   # host + phone + server + tests
npm run build       # production build (dist/ + dist-server/)
npm test            # builds, starts the server, runs the Playwright suite (headless Chromium)
npm run bots -- --url http://localhost:3000 --n 4   # 4 simulated phones play against a real host
```

The bot controller (`scripts/bots.ts`) opens N simulated phones over WebSocket and plays the whole
loop (join, pick racers, ready, tutorial, setup, drive with steering/drift/items, next race;
`--chaos` randomly disconnects/reconnects bots). The Playwright suite (`tests/`) covers the QR
code at laptop and 4K sizes, joining and readying, the tutorial (acks and skip), 4-way
split-screen, bots driving/drifting/using items, pause/resume from a phone, three races
back-to-back (errors + memory), disconnect → AI → reclaim, a 1-player keyboard race, and the
phone UI at iPhone and Android landscape sizes. Screenshots are saved to `docs/screenshots/`.
Debug hooks: `window.__game` (engine), `window.__party` (host session), `window.__phone`.

## Design decisions

Judgment calls made while building (the brief said "decide, document, keep going"):

**Flow**
- The how-to-play tutorial plays automatically the **first time the leader presses START** in a
  session (between lobby and setup), rather than the instant the first phone joins — people are
  still picking racers at that point. It can be replayed from the lobby (leader phone or host
  button) and skipped by the leader, host **Esc**, or the Skip button.
- Tutorial timing: 6 steps × 3.8 s (~23 s), then a "Got it!" phase that ends 1.2 s after everyone
  has tapped Got it, or after 10 s.
- The leader's START needs every *connected* player to be ready; disconnected players never block it.
- Late joiners during a race are auto-marked ready and race next time.
- A **Grand Prix** always runs the 4 tracks in order (Sunny Circuit → Dune Drift → Frostbite Falls →
  Neon Nexus) with the chosen cc and laps; the track picker only matters for Single Race.
  Points 15/12/10/8/6/4/2/1 for all 8 karts (AI included). Replaying a GP race replaces its points.
- Single Race "Next Race" goes to the next track (wrapping) with the same settings.
- Pause: the leader resumes instantly; other players' resume votes count, and a majority of
  connected racers resumes the race.
- Contextual tips are on for the first race of the session only (leader can toggle tips off).
- If the host page loses the server mid-race, the race auto-pauses (karts would otherwise keep
  driving on stale input).

**Controls & feel**
- Auto-accelerate is on by default. During the countdown the phone holds the gas off and applies
  it ~0.35 s before GO — which is inside the rocket-start window, so casual players get a fair
  rocket start. Holding gas from the very start of the countdown is neutral; pressing it too early
  causes a burnout.
- Touch steering is relative to the touch-down point: ±22% of the screen width is full lock, 6%
  deadzone, gentle curve, ~40 ms smoothing.
- Item taps are counted (`itemPresses`), so quick taps are never lost; each tap waits up to 0.6 s
  for the item to become usable.
- Throw backwards = hold BRAKE and tap ITEM (no separate look-back button on phones).
- When a phone disconnects mid-race the AI drives that kart (labelled "AI DRIVING") until the
  same phone (same browser token) comes back; after finishing, the AI also drives your kart to
  the end of the race.
- 50/100/150cc set kart speed to 80/92/100% and AI difficulty to easy/normal/hard.

**Display**
- TV mode default: window ≥ 1920 px wide. 2-player split is side-by-side when the screen aspect
  is ≥ 1.5 (TV / widescreen laptop), stacked otherwise.
- Post-processing (bloom, speed lines) is used in 1-player view only; split-screen renders plain
  for performance. Quality tiers: 0 (0.6 MP, no shadows) … 3 (up to 8.3 MP, DPR 2, 2048 shadows);
  starting tier depends on view count and screen size, and adapts (drop after 2 s < 50 fps, raise
  after 8 s > 58 fps).

**Originality**
- Base-game item ids are kept internally, but every player-facing name and model is original:
  BANANA, BOUNCER, SEEKER, LEADER ZAP, TURBO, GOLD TURBO, SUPERNOVA, THUNDER, BOOMER.
- Racers (Zippy Nova, Pixel Pop, Fennec Flash, Max Vortex, Juno Bolt, Kai Tidewater, Boulder Bram,
  Big Rig Rosa) and tracks are the base game's originals.

## Known limitations

- **Real devices untested in this build environment.** Everything was tested in headless Chromium
  (desktop + iPhone/Android emulation). iOS Safari specifics (scroll/zoom blocking, motion
  permission, add-to-home-screen) were implemented carefully but not verified on a physical phone.
  Do a 2-minute rehearsal before guests arrive.
- **Performance on real hardware is unmeasured.** The test machine renders with a software GPU
  (1–10 fps). The automatic quality scaler should hold frame rate with 4 views on a 4K TV, but if
  it looks choppy add `?quality=1` (or `0`) to the host URL.
- **iPhone fullscreen**: iOS Safari doesn't allow web pages to go fullscreen on iPhone; the browser
  bars stay visible (use "Add to Home Screen" for a fullscreen controller). Vibration is not
  supported on iOS (silently ignored).
- **Wake lock** needs HTTPS on some browsers; on plain HTTP the phone may dim after a while
  (players touch it constantly while racing, so it rarely matters).
- **Tilt steering requires HTTPS** (`npm run start:https`) and clicking through a certificate
  warning on each phone.
- Networking is local only (same Wi-Fi). Networks with client isolation (many guest/hotel Wi-Fi)
  block phones from reaching the laptop — use a phone/laptop hotspot instead.
- Only one host screen per room; opening the game in a second tab takes over the room (the first
  tab shows "open in another tab").
- Split-screen renders a shadow pass per view; on weak GPUs the scaler turns shadows off.
- Tutorial sound effects on the host only play after someone has clicked/pressed a key on the
  host page once (browser autoplay rules).
- Fonts are system fonts (Impact etc.) — no web fonts, so the look varies slightly per OS.
- No online play and no battle mode (out of scope).

## Credits & licenses

Kart Party is MIT-licensed (see `LICENSE`). It is built on two MIT-licensed projects by BridgeMind,
whose license texts are kept in `licenses/`:

- **[turbo-kart-rush](https://github.com/bridge-mind/turbo-kart-rush)** (commit `6c0456c`) — the base
  game: Three.js/TypeScript engine, 8 racers, 4 tracks, items, AI, drift/mini-turbo, procedural
  audio, architecture contract. Its original README is in `docs/BASE_README_turbo-kart-rush.md`.
- **[turbo-kart-rally](https://github.com/bridge-mind/turbo-kart-rally)** (commit `c52aca3`) — ideas
  and logic ported to TypeScript: rocket start, ramp trick boosts, intro flyover, live demo race
  behind the title, `window.__game` debug hooks.
