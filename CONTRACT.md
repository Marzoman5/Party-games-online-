# Turbo Kart Rush — Architecture Contract

AAA-quality Mario Kart style arcade racer. Three.js + TypeScript + Vite. **100% procedural: no external
assets** (no image/audio/model files). Everything is generated in code (geometry, textures via
CanvasTexture/DataTexture, audio via Web Audio API synthesis).

This document is the contract between five parallel workstreams. `src/core/**` is **frozen**: read it,
implement against it, never edit it (you may *add* optional fields to interfaces only if unavoidable, and
you must then note it at the bottom of this file under "Contract additions").

## Ownership (each owner has exclusive write access to their folders)

| Workstream | Folders | Public exports (exact paths & names) |
|---|---|---|
| **A — Game core + UI** | `src/main.ts`, `src/style.css`, `src/game/**`, `src/ui/**` | `src/game/Game.ts` → `class Game`; `src/game/RaceManager.ts` → `class RaceManager`; `src/game/FollowCamera.ts` → `class FollowCamera`; `src/ui/HUD.ts` → `class HUD`; `src/ui/MainMenu.ts` → `class MainMenu`; `src/ui/ResultsScreen.ts` → `class ResultsScreen`; `src/ui/PauseMenu.ts` → `class PauseMenu`; `src/ui/Minimap.ts` → `class Minimap`; `src/ui/LoadingScreen.ts` → `class LoadingScreen` |
| **B — Kart physics, model, input, roster** | `src/kart/**` | `src/kart/Kart.ts` → `class Kart implements IKart` with `constructor(id: number, character: CharacterDef, isPlayer: boolean)`; `src/kart/InputManager.ts` → `class InputManager`; `src/kart/roster.ts` → `export const CHARACTERS: CharacterDef[]` (exactly 8) and `getCharacter(id: string): CharacterDef`; `src/kart/KartModel.ts` → `buildKartModel(character: CharacterDef): KartModelParts` |
| **C — Track system + environment** | `src/track/**` | `src/track/Track.ts` → `class Track implements ITrack` with `constructor(def: TrackDefinition)`; `src/track/tracks/index.ts` → `export const TRACKS: TrackDefinition[]` (exactly 4) and `getTrackDef(id: string): TrackDefinition` |
| **D — Items + AI** | `src/items/**`, `src/ai/**` | `src/items/ItemManager.ts` → `class ItemManager implements IItemManager` with `constructor(particles: IParticleSystem \| null)`; `src/ai/AIDriver.ts` → `class AIDriver implements IAIDriver` with `constructor(kart: IKart, difficulty: Difficulty, personalitySeed: number)`; `src/items/itemVisuals.ts` → `buildItemIcon(item: ItemType): HTMLCanvasElement` (64x64 icon for HUD roulette) |
| **E — Audio + FX** | `src/audio/**`, `src/fx/**` | `src/audio/AudioEngine.ts` → `class AudioEngine implements IAudioEngine` (no-arg constructor); `src/fx/ParticleSystem.ts` → `class ParticleSystem implements IParticleSystem` (no-arg constructor); `src/fx/PostFX.ts` → `class PostFX implements IPostFX` (no-arg constructor) |

All cross-module communication is via:
1. The interfaces in `src/core/types.ts`.
2. The typed event bus in `src/core/events.ts` (`events.emit / events.on`).
3. Constants in `src/core/constants.ts`, helpers in `src/core/math.ts`.

Never import another workstream's concrete class except from `Game.ts` (workstream A wires everything).

## World conventions

- Units are metres, +Y up, right-handed. Kart forward is its local **-Z** (Three.js convention:
  `object.getWorldDirection` gives -Z). **forward = `new Vector3(0,0,-1).applyQuaternion(quaternion)`**,
  and `KartState.heading` is the Y rotation used to build that quaternion
  (`quaternion.setFromEuler(new Euler(0, heading, 0))`, so forward = `(-sin(heading), 0, -cos(heading))`).
  Track `tangent` follows the driving direction; the grid faces along the tangent at t≈0.
- Track parameter `t` in `[0,1)` wraps; `t = 0` is the finish line. Karts drive in the +t direction.
- Track is a closed CatmullRom loop; the **road is flat across its width** and the centerline may have
  gentle elevation (hills, small jumps). `ITrack.query` returns the ground height for any XZ; karts snap
  to `groundY` when not airborne.
- Speeds: medium kart top speed ≈ `BASE_TOP_SPEED` = 22 m/s (light ≈ 20.5, heavy ≈ 23.5). Mushroom boost
  ≈ +55% for 1.5s; drift mini-turbo stage 1/2/3 ≈ 0.7s / 1.2s / 1.8s at +40%. Boost pads ≈ +45% for 1.3s.
- Time: `Game` runs a fixed-step accumulator (`FIXED_DT`) for `Kart.update`, `ItemManager.update`,
  `AIDriver.update`, `RaceManager.update`; render-rate calls for `updateVisuals`, camera, particles, audio, HUD.
- Kart count is `KART_COUNT` = 8, ids `0..7`; the player is always id `0`.
- `KartState.raceProgress = lap + trackT` (RaceManager keeps this monotonic and uses it for `place`).
- Kart-kart collisions are resolved inside `Kart.update(dt, track, others)` (sphere-sphere, weight-based).
- Wall collisions: if `|lateral| > wallHalfWidth` push back along `binormal`, damp lateral velocity,
  emit `kart:collision` with `otherId: null`.
- Off-road (`surface === 'offroad'`): top speed ×0.55 unless boosting/star. `'boost'` surface (boost pad)
  → `applyBoost(0.45, 1.3, 'pad')` (once per pad crossing). `'void'` → fall; below `VOID_Y` respawn at last
  checkpoint (RaceManager calls `kart.resetTo` and emits `kart:respawn`).

## Player/AI input flow

```
InputManager.update()  → InputState (player) → kart0.setInput()
AIDriver.update(...)   → InputState (ai)     → kartN.setInput()
Kart.update(dt, track, others)               → physics
if (input.useItem) itemManager.requestUse(kart, input.brake > 0.5 || input.lookBack)
```

`InputManager` (workstream B) handles keyboard + gamepad and produces **edge-triggered** booleans
(`useItem`, `pause`, `confirm`, `back`, `menuUp/Down/Left/Right`) that are true for exactly one call of
`update()`. Default keys: W/↑ throttle, S/↓ brake, A/D or ←/→ steer, Space or Shift = hop/drift,
E / Ctrl / Enter = item, Q = look back, Esc or P = pause; Enter/Space confirm, Esc back. Gamepad: RT
throttle, LT brake, left stick steer, A/RB drift, X/LB item, B back, Start pause.

## Game flow (workstream A)

`boot → title → characterSelect → trackSelect → loading → countdown → racing → finished → results → title`

- `Game` owns `WebGLRenderer` (antialias, `ACESFilmicToneMapping`, `SRGBColorSpace`, shadows PCFSoft),
  `Scene`, `PerspectiveCamera`, lights (from `track.def.environment`), resize handling, the fixed-step loop,
  and constructs: `InputManager`, `AudioEngine`, `ParticleSystem`, `PostFX`, `Track`, 8 × `Kart`,
  7 × `AIDriver`, `ItemManager`, `RaceManager`, `FollowCamera`, `HUD`, menus.
- `RaceManager` owns countdown (3-2-1-GO with `race:countdown` / `race:start`), checkpoint/lap logic,
  positions, finish detection, results, respawns, wrong-way detection, and after the player finishes it
  keeps simulating AI until all finish or 12s pass (auto-drive the player kart with an AIDriver).
- `FollowCamera`: chase cam behind kart (distance ~6.5, height ~2.6), FOV widens with speed/boost
  (70° → 82°), slight lag on yaw, drift lean, look-back flips 180°, shake on hits.
- `HUD` is DOM (absolute-positioned divs over the canvas) — place numeral, lap counter, item slot with
  roulette (uses `buildItemIcon` from workstream D), speedometer, race timer, minimap (canvas), countdown,
  "FINAL LAP" banner, wrong-way warning, position-change flash, finish banner.
- Menus are DOM too, styled premium (glassmorphism, animated gradients, big condensed display typography via
  CSS system fonts — no webfont downloads). Behind the title menu render a slowly orbiting 3D kart on a
  podium with bloom.

## Track (workstream C)

`new Track(def)` builds everything synchronously: centerline `CatmullRomCurve3(points, closed=true,
'centripetal')`, lookup table of ~2000 samples for `closestT`, road ribbon geometry (with UV along length),
striped curbs, painted start/finish line + checkered pattern, side barriers/walls (themed), terrain
(large `PlaneGeometry` displaced by `fbm2`, flattened near the road), sky dome (gradient shader),
themed decorations (trees, cacti, rocks, snowmen, palms, lava rocks, neon pylons — instanced),
grandstands + cheering crowd near the start, boost pads (glowing chevrons on `'boost'` surface),
item box rows (positions only — visuals are workstream D), start grid slots (4 rows × 2, staggered,
behind the finish line), checkpoints, minimap data. Four tracks: **Sunny Circuit** (grassland, easy),
**Dune Drift** (desert, medium), **Frostbite Falls** (snow, medium-hard, with a void section over ice),
**Neon Nexus** (neon night city, hard). Each 900–1400 m long with hills, at least one jump crest, hairpins,
sweeping S-bends and a long straight.

## Items (workstream D)

Item boxes: translucent rainbow-refracting rotating cubes with a "?" inside, bob + spin, burst on pickup,
respawn after `ITEM_BOX_RESPAWN_SECONDS`. Roulette: `ITEM_ROULETTE_SECONDS`, emit `item:rouletteTick`
~10 times, then `item:rouletteEnd`; probabilities weighted by `place` (leader → bananas/greens; last →
star/lightning/blue/golden). Items: banana (dropped behind / thrown forward with aimBack=false + throttle),
green shell (straight, bounces off walls up to 6 times), red shell (homes on next kart ahead via track t),
blue shell (flies to leader, explodes), mushroom / triple / golden (boost via `kart.applyBoost`), star
(`applyStar(8)`), lightning (`applyShrink(6)` + `applyHit('lightning')` on all non-star karts, emit
`item:lightning`), bob-omb (thrown, 2.5s fuse or contact, explosion radius 4 → `applyHit('explosion')`).
Triple items orbit the kart. Hitting a shell/banana with star destroys it. Items collide with karts using
`KART_RADIUS`. Emit particles via the `IParticleSystem` passed in the constructor (may be null).

## AI (workstream D)

Follow a racing line = centerline + personality lateral offset, look-ahead ~ speed × 0.9 s, steer with a
PD controller, drift on corners with curvature above threshold and release at stage 2–3, hop over small
things, avoid `getHazards()` by lateral dodge, steer toward `getActiveBoxPositions()` when no item,
use items sensibly (red/green when a kart is ahead within 40 m, banana when a kart is behind within 15 m,
mushroom on straights or to recover, star/lightning immediately-ish, blue shell when not first),
rubber-band: scale top speed ±8% based on distance to player (hard: less help). Recover from wrong-way /
being stuck (reverse for 0.8 s then turn).

## Audio (workstream E)

Web Audio API only. Engine: per-kart oscillator stack (saw + square + sub, lowpass, pitch from speed,
gain from throttle; positional via `PannerNode` for non-player karts, player kart louder/centred).
SFX: drift skid loop (filtered noise), mini-turbo charge tick + release whoosh, boost whoosh, hop, land
thud, wall bump, kart bump, item box pickup ding, roulette ticks, item use (throw), shell hit crash, banana
slip, explosion, star jingle loop (overrides music while player has star), lightning crack, lap bell,
final-lap fanfare, countdown beeps + GO, finish fanfare, UI move/select/back, crowd ambience near start.
Music: procedural chiptune-ish sequencer with chord progressions, bass, arps, drums (noise hats, synth kick)
for `menu` (chill), `race` (upbeat 150 bpm), `finalLap` (same but +10% tempo, +1 semitone),
`results` (fanfare then loop). Smooth crossfade between tracks.

## FX (workstream E)

`ParticleSystem`: GPU-friendly single `Points`/instanced quads pool (≥ 6000 particles) with per-particle
life, velocity, gravity, size over life, colour over life, additive + alpha blending groups. Continuous
emitters from kart state: drift sparks at rear wheels coloured by `driftStage` (blue/orange/purple),
boost flames from exhausts, tyre smoke while drifting, dust on off-road, star sparkle, shrink puff,
speed streaks. `emit()` presets per `ParticlePreset`.
`PostFX`: `EffectComposer` (`three/examples/jsm/postprocessing/*`) with `RenderPass`, selective-ish
`UnrealBloomPass` (strength ~0.5, threshold ~0.85), custom `ShaderPass` for speed lines + radial blur +
chromatic aberration + vignette + hit tint + flash, `OutputPass`. Must gracefully fall back to plain
`renderer.render` if disabled.

## Quality bar

- 60 fps on a 2020 laptop at 1080p: instancing for decorations, merged geometries, ≤ ~400 draw calls,
  shadow map 2048, single shadow-casting light, frustum culling on.
- No console errors, no TypeScript errors (`npm run typecheck` clean), `npm run build` clean.
- Everything disposable (`dispose()`) so returning to the menu and starting a new race doesn't leak.

## Contract additions

(None yet. If you must add an optional member to a core type, list it here with your workstream letter.)

---

# KART PARTY extension contract (couch multiplayer, phones as controllers)

Kart Party = Turbo Kart Rush (base, MIT) + ported features from Turbo Kart Rally (MIT) + a Node relay
server, a phone controller web app and a party layer. Everything above this line still applies.
The new frozen contract files are:

- `src/net/protocol.ts` — wire protocol (phones <-> server <-> host). Shared by browser + Node.
- `src/net/items.ts` — player-facing item names (original names; internal ItemType ids unchanged).
- `src/game/api.ts` — `IGameHost` (engine API used by the party layer) + `window.__game` debug hooks.

Do not edit these three files. If something is truly missing, add an OPTIONAL member and document it at
the very bottom under "Kart Party contract additions".

## Workstreams & exclusive file ownership

| Workstream | Owns | Delivers |
|---|---|---|
| **SERVER** | `server/**`, `scripts/**` (except build-server.mjs edits are allowed), `play.html` is NOT theirs | Express + ws relay, LAN IP detection, QR SVG endpoint, room codes, reconnect tokens, HTTPS self-signed mode, `scripts/bots.ts` bot controller (importable `BotPhone` class + CLI) |
| **PHONE** | `play.html`, `src/phone/**` | Mobile controller app (landscape controls, menus, tutorial mirror, settings, tilt, haptics, reconnect) |
| **PARTY** | `src/party/**`, `src/main.ts`, `index.html` | Host net client, party session state machine, title/lobby/tutorial/setup/pause/results/GP overlays, QR display, TV mode, fullscreen, cursor hiding, `window.__party` hooks. Orchestrates the engine via `IGameHost` |
| **ENGINE-A** | `src/game/**` (except `api.ts`), `src/ui/**`, `src/style.css` | `Game implements IGameHost`: multi-human karts, split-screen viewports + per-viewport HUD, 3-player minimap/standings quadrant, quality scaler + DPR cap, demo race, intro flyover, rocket start per human, AI takeover, contextual tips, `window.__game` hooks |
| **ENGINE-B** | `src/kart/**`, `src/ai/**`, `src/items/**`, `src/fx/**`, `src/audio/**`, `src/track/**`, `src/core/**` (additive only) | Ramp trick boosts, cc speed scaling, particle/postfx quality knobs, original item labels in visuals, multi-human awareness in AI/audio/items |
| **TEST** (later) | `tests/**`, `playwright.config.ts`, `docs/screenshots/**` | Playwright suite + screenshots |

Nobody runs `git commit` except the lead. Do not edit files you don't own; code against the contract.
`npm run typecheck` may show errors in other workstreams' files while they work — only fix your own.

## Runtime topology

```
 phone (/play)  ──ws──┐                         ┌── host page (/) : Game (engine) + PartyApp
 phone (/play)  ──ws──┤  Node server (relay)  ──┤        authoritative simulation
 ...                  └── express static dist/  └── ws (single host per room)
```

- `npm start` = `vite build` (host + phone pages into `dist/`) + esbuild server -> `node dist-server/server.mjs`.
- Server serves `dist/index.html` at `/`, `dist/play.html` at `/play`, `dist/assets/*`, WS at `/ws`.
- HTTP endpoints: `GET /api/info` -> `{ urls: string[], port, httpsPort|null }`;
  `GET /api/qr.svg?data=<url-encoded>` -> `image/svg+xml` QR code (generated server-side, works offline);
  `GET /api/debug/rooms` -> `[{ room, hostConnected, players: [{playerId, connected}] }]` (tests/bots).
- CLI flags: `--port N` (default 3000, env PORT; if busy, try next ports), `--https` (also serve HTTPS on
  3443 with an auto-generated self-signed cert in `./certs/`, and joinUrl uses https), `--host-ip X`
  (override LAN IP detection). Startup prints a big banner with the LAN URL(s).
- Rooms: host connects and sends `host_hello`; server creates a 4-letter room (or reclaims `room`+`hostToken`
  after a host reload; rooms survive 30 min without a host). Phones send `join` with room + optional token;
  the server assigns `playerId` (stable per token) and relays. Max 4 *connected* players per room (stale
  disconnected seats beyond that are evicted oldest-first). Room codes are case-insensitive on input.
- Server relays phone input packets to the host *immediately* (no batching, `ws` with `perMessageDeflate:false`,
  TCP_NODELAY default). Host -> phone messages are forwarded verbatim.
- Liveness: phones ping every 2 s; server drops sockets silent for >6 s (ws ping/pong on server side too).

## Party flow (PARTY owns the state machine; phones mirror `PhoneState.screen`)

1. `title` — engine `showDemo()` (AI demo race) + big QR + room code + URL. "Press ENTER / click for solo
   keyboard play" opens `openSoloMenu()`. First phone join -> `lobby`.
2. `lobby` — players pick name + racer (unique racers) and Ready. Host shows cards (slot colour, avatar,
   name, racer, ready tick, crown on leader). Leader = first joiner; transferable from the leader's phone;
   auto-passes to the next connected player if the leader disconnects. Leader's START is enabled when all
   connected players are ready.
3. `tutorial` — auto-plays the first time the leader presses START in a session; replay any time with
   "How to Play" (leader phone, or host button). Steps (index = `PhoneState.tutorial.step`, total 6):
   `0 steer, 1 gas, 2 drift, 3 item, 4 brake, 5 pause`. ~4 s per step, then waits for every player's
   "Got it!" (or 10 s, or leader skip). Pressing DRIFT or ITEM during the tutorial makes that player's
   avatar react on the host ("try it").
4. `setup` — leader's phone picks mode (single / gp), track, cc (50/100/150), laps (1–5, default 3);
   host shows the selection live. Leader taps START RACE.
5. `loading` -> `race` (engine phases loading/intro/countdown/racing/finished). Phones send input packets.
6. `results` — race standings (+ GP points table: 15,12,10,8,6,4,2,1). Leader's phone: Next Race / Replay /
   Change Track / Back to Lobby (GP: Next Race advances through the 4 tracks; after the 4th the final GP
   podium shows and Next Race starts a new GP).
- `paused` — any phone can pause. Leader: Resume / Restart / Quit to lobby. Others: "Vote resume" (resume
  when a majority of connected racers voted). Host overlay mirrors the vote count.
- Late joiners during a race get `waiting` (they can still pick name/racer), and join the next race.
- Disconnect mid-race -> `setSlotAI(slot, true)`; reconnect with the same token -> same slot, `setSlotAI(false)`.

## Host CSS conventions (shared by PARTY + ENGINE-A)

- `<html class="tv">` when TV mode is on (PARTY toggles it; default ON when `innerWidth >= 1920` or `?tv=1`;
  `?tv=0` forces off). Also sets CSS custom properties on `:root`: `--ui-scale` (1 laptop, ~1.6 TV) and
  `--safe` (0px laptop, 5vh TV overscan margin). Engine HUD must scale with `--ui-scale` and keep content
  inside `--safe`. PARTY also calls `game.setTvMode(on)`.
- `<body class="hide-cursor">` during countdown/racing (PARTY).
- Z-order: engine canvas (0) < engine HUD (#ui, 10) < party overlays (#party, 50) < toasts (100).
- No webfonts / external URLs anywhere. Everything bundled.

## `window.__party` (PARTY) — test hooks

```ts
window.__party = {
  getState(): { screen: ScreenId; room: string; joinUrl: string; tvMode: boolean; engine: EnginePhase;
                players: LobbyPlayer[]; tutorial: { step: number; total: number; acks: string[] } | null;
                setup: RaceSetup; pause: PhoneState['pause']; gp: PhoneState['gp']; racesCompleted: number },
  setTvMode(on: boolean): void,
  skipTutorial(): void,
}
```

## Kart Party contract additions

(ENGINE-B, all additive / optional — no existing member changed.)

**`src/core/constants.ts`**
- `GAME_TITLE` is now `'KART PARTY'`.
- New: `JUMP_RAMP_LENGTH = 7`, `JUMP_RAMP_HEIGHT = 1.1`, `JUMP_RAMP_MIN_SPEED = 7` (m/s, scaled by the kart's speed scale),
  `TRICK_BOOST_STRENGTH = 0.4`, `TRICK_BOOST_DURATION = 0.9`.

**`src/core/events.ts`** (new events)
- `'kart:ramp': { kartId: number; speed: number }` — launched off a jump ramp.
- `'kart:trick': { kartId: number }` — mid-air trick performed (boost `applyBoost(0.4, 0.9, 'trick')` follows on landing unless hit).
- `'kart:burnout': { kartId: number }` — too-early start wheelspin (see `applyBurnout`).

**`src/core/types.ts`**
- `TrackDefinition.jumpRamps?: number[]` — t positions of jump ramps (kicker starts at t, lip `JUMP_RAMP_LENGTH` m later).
- `SurfaceQuery.ramp?: number` — 0..1 progress along a ramp under the queried point (groundY includes the ramp), -1 otherwise.
- `interface JumpRampInfo { t; tEnd; position (lip centre); forward; halfWidth; length; height }`.
- `ITrack.jumpRamps?: readonly JumpRampInfo[]`, `ITrack.setDetail?(tier: 0|1|2|3): void` (decor instance counts / shadows / tyre LOD; 3 = full).
- `KartState.trickReady?: boolean` (airborne and DRIFT would trick now — good for a HUD prompt), `KartState.isTricking?: boolean`,
  `KartState.isBurningOut?: boolean`, `KartState.speedScale?: number`.
- `IKart.setSpeedScale?(scale: number): void` (cc class: 50cc 0.8, 100cc 0.92, 150cc 1.0; scales top speed + acceleration,
  `topSpeed()` reflects it), `IKart.applyBurnout?(): void` (~0.9 s wheelspin stall + smoke; call right after `setFrozen(false)`).
- `IParticleSystem.setQuality?(tier: 0|1|2|3): void` (emission rates, burst counts, pool size; streaks only at tier ≥ 2 and only
  when exactly one kart has `isPlayer`).

**Semantics notes**
- Tricks: while airborne after a ramp (or a crest jump with ≥ 0.55 s predicted air time), a rising edge of `input.drift`
  performs a trick (body roll / flip). Getting hit (`applyHit`) cancels it. AI performs tricks by difficulty (35/70/95 %).
- `AudioEngine.update(..., playerKartId, ...)`: only `playerKartId` gets the centred engine voice (debounced 0.75 s when it
  changes); other human karts are positional like AI. HUD-like SFX (roulette, lap bell, finish, position change, wrong way)
  play for every human kart, at reduced volume (0.3) unless it is the listener kart.
- `PostFX.setFocusKart(kartId)` (class method, not in IPostFX): which kart's hits drive the red hit pulse (default 0).
