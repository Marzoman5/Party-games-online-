# PARTY HUB — build contract (Kart Party + Smash Party on one party engine)

Everything in `CONTRACT.md` (Kart Party) still applies. This file adds the Party Hub layer and the
new game **Smash Party** (an original 2.5D platform fighter — no Nintendo names, characters,
sprites, sounds or stage likenesses; everything procedural, no asset files).

## Frozen contract files (LEAD only; additive changes, documented at the bottom)

- `src/net/protocol.ts` — wire protocol. PARTY HUB additions are marked `PARTY HUB`: `GameId`,
  `GameInfo`, `SmashSetup`, `DEFAULT_SMASH_SETUP`, `TEAM_COLORS`, Smash input packet
  (`[1, seq, x, y, buttons, attackPresses, specialPresses, jumpPresses, grabPresses]`,
  `encodeFightInput` / `decodeFightInput`, `FBTN_*`), `PhoneFightStatus` (`t:'fight'`, ~10 Hz),
  extended `PhoneFx`, `ScreenId 'sandbox'`, new phone→host messages `game`, `gsetup`, `team`,
  `practice_done`, `post` action `switch`, and optional `PhoneState` fields `game`, `games`,
  `gameSetup`, `sandbox`, `resultsInfo`, `LobbyPlayer.team`, smash stats on `ResultRow`.
- `src/games/smash/types.ts` — sim/view/model/AI shared types, knockback formula, input semantics.
- `src/games/smash/api.ts` — `ISmashHost` (engine ↔ party hub) + `window.__smash` hooks.
- `src/game/api.ts` (kart `IGameHost`) — unchanged; an OPTIONAL `setSuspended?(on)` may be added by HUB.

## Workstreams & exclusive file ownership

| Agent | Owns (exclusive write) | Delivers |
|---|---|---|
| **LEAD** | contract files above, `README.md`, `CONTRACT.md`, `docs/*.md`, `package.json`, git | contracts, integration, commits, PR |
| **HUB** | `src/party/**`, `src/engine/**`, `src/games/kart/**`, `src/games/smash/module/**` (the Smash game-module adapter: setup sanitising, tutorial steps, status/results mapping, host setup/results overlays), `src/games/registry.ts`, `src/main.ts`, `index.html`, minimal edits in `src/game/Game.ts` (suspend) + `src/game/api.ts` (optional member only) | Party engine layer + game-module interface, hub/lobby game picker, per-game setup/tutorial/sandbox/results/pause host overlays, game switching, `window.__party` |
| **SIM** | `src/games/smash/sim/**` (except `sim/ai/**`), `src/games/smash/roster.ts`, `src/games/smash/stages.ts` | Deterministic 60 Hz fighting simulation `SmashSim implements ISmashSim`, fighters' move data (8 fighters), knockback, items, stages, rules, sudden death |
| **AI** | `src/games/smash/sim/ai/**` | `CpuController` levels 1–9 (sim calls it for CPU fighters) |
| **VIEW** | `src/games/smash/SmashGame.ts`, `src/games/smash/view/**`, `src/games/smash/smash.css` | `SmashGame implements ISmashHost`: renderer, camera, stages visuals, effects, in-match HUD, magnifiers, audio + music, intro/GAME!/victory, debug overlay, `window.__smash` |
| **MODEL** | `src/games/smash/model/**` | Procedural low-poly full-body fighter models + keyframed animation + portraits |
| **PHONE** | `play.html`, `src/phone/**` | Game-aware phone app: fighter controller, game picker, smash setup, character select info, sandbox, results/post-match actions |
| **TEST** | `server/**`, `scripts/**`, `tests/**`, `playwright.config.ts`, `docs/screenshots/**` | Relay for fight packets, bot harness for Smash, Playwright specs, combat unit test |

Rules: only edit files you own. Import anything. Never run `git` write commands (the LEAD commits).
`npm run typecheck` may show errors in other agents' files while they work — fix only yours.
Don't run the Playwright suite or `npm run build` concurrently on the default port — use
`KP_TEST_PORT=<your port>` and prefer `npx tsc --noEmit -p tsconfig.json` + targeted checks while
the integration isn't done.

## Module skeleton files (create FIRST so everyone compiles)

- SIM: `src/games/smash/roster.ts` (`FIGHTERS: FighterDef[]` (8), `getFighter(id)`),
  `src/games/smash/stages.ts` (`STAGES: StageDef[]` incl. training, `getStage(id)`, `PICKABLE_STAGES`),
  `src/games/smash/sim/SmashSim.ts` (`export class SmashSim implements ISmashSim { constructor(cfg: SimConfig) }`),
  `src/games/smash/sim/knockback.ts` (re-exports the formula helpers from `types.ts`).
- AI: `src/games/smash/sim/ai/CpuController.ts` —
  `export class CpuController { constructor(fighter: number, level: number, seed: number); think(sim: ISmashSim): SimInput; }`
- MODEL: `src/games/smash/model/FighterModel.ts` —
  `export function buildFighterModel(characterId: string, opts?: { teamColor?: string | null }): FighterRig`
  where `FighterRig { root: THREE.Group; height: number; update(v: FighterView, dt: number, time: number): void; setPose(pose: 'idle' | 'victory' | 'portrait' | 'defeat', time: number): void; dispose(): void; }`
  and `src/games/smash/model/portrait.ts` — `renderPortrait(renderer: THREE.WebGLRenderer, characterId: string, size: number): string` (data URL).
- VIEW: `src/games/smash/SmashGame.ts` — `export class SmashGame implements ISmashHost { constructor(container: HTMLElement) }`.

## Party flow (Party Hub)

title (QR, attract demo of the active game) → **lobby** (players join once; name + character
— the same 8 characters for both games; the **leader picks the game** on their phone, host shows
big game cards) → leader START → **tutorial** (first start of *each* game in the session;
replayable; leader-skippable) → (Smash only) **sandbox** "try it" practice on the training stage
with a dummy whose % rises; each player taps "I'm ready" (`practice_done`), leader START (or
everyone ready) → **setup** (per-game: kart = mode/track/cc/laps, smash = stage/mode/stocks/
time/teams/friendly fire/CPU fill + level/items + frequency/hazards; players pick team in team
mode) → loading → **race/match** → **results** → leader: **Rematch** (`post replay`) / **Change
Settings** (`post track`) / **Switch Game** (`post switch`) / **Lobby** (`post lobby`) — kart also
keeps **Next Race** (`post next`). Switching games never reloads phones; `PhoneState.game` flips
and the phone swaps its controller layout. Switch Game goes to the other game's tutorial (if not
seen yet this session) or setup, keeping all players.

Pause/vote, disconnect → AI/CPU takes over → reconnect reclaims, late joiners, leader succession:
identical for both games (engine layer).

## Smash Party tutorial steps (host and phone MUST agree; index = `PhoneState.tutorial.step`, total 6)

| # | zone | host title | phone text |
|---|---|---|---|
| 0 | `stick` | Move with the stick | Put your thumb anywhere on the left side and push |
| 1 | `jump` | JUMP — tap again in the air to double jump | Tap JUMP (twice for a double jump) |
| 2 | `attack` | ATTACK — the stick picks the move | Tap ATTACK. Flick the stick + ATTACK = SMASH attack (hold to charge) |
| 3 | `special` | SPECIAL — 4 special moves. UP + SPECIAL = recovery | Tap SPECIAL with a direction. Fell off? UP + SPECIAL! |
| 4 | `shield` | Hold SHIELD to block — + stick to dodge. GRAB to throw | Hold SHIELD; tap GRAB near someone to grab & throw |
| 5 | `goal` | Push them off the stage — higher % = they fly farther! | Hit them to raise their %, then smash them off the screen |

Kart Party keeps its 6 steps (`steer, gas, drift, item, brake, pause`).

## Phone ↔ host in Smash Party

- Controller (landscape): floating analog stick (left) — 8-way + analog, decides attack
  direction; fast flick + ATTACK = smash attack (`FBTN_FLICK`); tap-jump setting (off by default).
  Right: big ATTACK (A), SPECIAL (B), JUMP, SHIELD (hold; + stick = roll/spot dodge; + ATTACK =
  grab), GRAB. Pause in a corner. Shows fighter, colour, damage %, stocks (from `t:'fight'`).
- Inputs at 60 Hz + immediately on edges; press counters; the host converts counter increments to
  one-frame press edges (`SimInput.*Pressed`, one per sim frame, queued) and the sim buffers each
  press for `INPUT_BUFFER_FRAMES` (5). Shield edges come from the held bit.
- Haptics: `fx` `hit` (strength 0..1 scales vibration), `ko`, `koOther`, `shieldBreak`, `game`, `go`.

## Test hooks

- `window.__party.getState()` adds: `game`, `games`, `gameSetup`, `sandbox`, `resultsInfo`.
- `window.__smash` — see `SmashDebugHooks` in `src/games/smash/api.ts`.
- `window.__phone.getState()` adds: `game`, `layout` ('kart' | 'fighter'), `fight` (last PhoneFightStatus),
  `lastFightInput`.

## Contract additions log

(append here: who, what, why)
