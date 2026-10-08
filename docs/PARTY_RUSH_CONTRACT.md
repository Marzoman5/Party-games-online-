# PARTY RUSH — build contract (the third Party Hub game)

**Party Rush** (id `rush`, shown as **Party Rush**) is an endless, drop-in / drop-out stream of fast motion
minigames. Phones are one-handed motion controllers in portrait grip, the TV shows everything. Everything in
`CONTRACT.md` and `docs/PARTY_HUB_CONTRACT.md` still applies (original content only, procedural, no assets,
no CDNs, no web fonts, offline on a LAN). Kart Party and Smash Party must not regress.

The design test for every decision is **"drunk-playable"**: a standing player, drink in one hand, phone in
the other, looking at the TV, joined 20 s ago and never saw this game. If a choice makes that player
confused, stuck, blamed or left out, it is wrong. (Full list of rules: the build prompt; the binding parts
are restated below.)

## Frozen contract files (LEAD only; additive, documented in the log at the bottom)

- `src/net/protocol.ts` — PARTY RUSH additions are marked `PARTY RUSH`: `MAX_PLAYERS = 16` (room cap),
  `MAX_MATCH_PLAYERS = 4`, 16 `SLOT_COLORS`, `PLAYER_EMOJIS`, `LobbyPlayer.emoji`, `PhoneState.watch` /
  `secure`, `GameId 'rush'`, the minigame channel (`RushStream`, `RushEvent`, `RushDemo`, `RushPhase`,
  `RushMe`, `RushFx`, `RUSH_POSES`, `RushCue`, `RushPhoneMsg` host→phone `{t:'mg'}`, `MgFromPhone`
  phone→host `{t:'mg'}`), the tag-2 stream packet (`encodeStream` / `decodeStream`).
- `src/engine/GameModule.ts` — optional drop-in members (`dropIn`, `startEndless`, `onPlayer`, `onMg`,
  `inputFrom`), `AnyInput` tag 2, `ControllerLayout 'rush'`, `ModuleViews.setup/results` optional.
- `src/games/rush/types.ts` — the minigame plug-in interface (`Minigame`, `MinigameDef`, `MinigameCtx`,
  `MinigameMeta`, `MinigameResult`, bot brains `BotFactory` / `Bot`), the 1920×1080 logical stage.
- `src/games/rush/draw.ts` — shared canvas helpers: `drawToken` (THE way to draw a player: colour disc +
  emoji + name), `drawText`, `drawEmoji`, `gridCells`, `rankBy`, `seededRandom`, easing, palette.
- `src/phone/motion/index.ts` — the phone motion API (`motion`: `enable`, `configure`, `calibrate`,
  `sample`, `drain`, `activeSince`, `inject`, `injectGesture`).
- `src/games/rush/minigames/index.ts`, `src/games/rush/bots.ts` — registries (LEAD adds entries).
- `src/games/rush/headless.ts`, `scripts/rush-selftest.ts` — headless runner (LEAD; TEST may extend the script).

## Workstreams & exclusive file ownership

| Agent | Owns (exclusive write) | Delivers |
|---|---|---|
| **LEAD** | contract files above, `docs/*.md`, `README.md`, `package.json`, git; `src/engine/**`, `src/party/**`, `src/games/registry.ts`, `server/**` (relay), `src/games/kart/ui/ResultsOverlay.ts` + `src/games/smash/module/ui/SmashResultsOverlay.ts` (switch picker only) | 16-player party, drop-in session mode, relay + HostNet tag 2 / `mg`, hub card + HTTPS notice, Kart/Smash seat cap + "watching" chip, game picker for Switch Game, integration, commits |
| **SHELL** | `src/games/rush/RushModule.ts`, `src/games/rush/shell/**`, `src/games/rush/rush.css`, the `LOOP` block of `tuning.ts` | `RushModule implements GameModule` (dropIn): loop, phases, watchdog, scoring, shuffle bag, heat, settings + Esc menu, scoreboard, UP NEXT card + gesture demo, 3-2-1, results + superlatives + sip mode, HUD, QR + cert help + HTTPS notice, TV audio + music, per-phone `RushPhoneMsg` sync, host solo bots, away handling, snapshot/restore, `window.__rush` |
| **MOTION** | `src/phone/motion/**` (except `index.ts`), `scripts/motion-selftest.ts` | sensor pipeline (permission, devicemotion + deviceorientation, axis normalisation, filters, gravity), detectors (shake, flick, stillness + table, pose, tilt, raise/pitch, aim, activity), `src/phone/motion/tuning.ts`, synthetic-trace unit tests |
| **PHONE** | `src/phone/**` except `src/phone/motion/**` | Rush controller layout (portrait): join tap (audio unlock + motion permission + wake lock), giant word, colour/emoji/name, triple cues, gesture demo mirror, touch fallbacks, Hot Potato bomb, pose pictures, away/back screen, "Hold tight" card, results line, leader NEXT, corner menu (name edit); 16-player lobby bits, "watching this one", switch-game picker, `window.__phone.motion` injector |
| **MG1** | `minigames/{shake-race,quick-draw,hot-potato,dont-move}.ts` + `.bot.ts`, their `tuning.ts` blocks | 4 minigames |
| **MG2** | `minigames/{balance,tilt-maze,darts}.ts` + `.bot.ts`, their `tuning.ts` blocks | 3 minigames |
| **MG3** | `minigames/{tug-of-war,copy-pose,fishing}.ts` + `.bot.ts`, their `tuning.ts` blocks | 3 minigames |
| **TEST** | `scripts/bots.ts`, `scripts/server-selftest.ts`, `tests/**`, `docs/screenshots/**`, `scripts/rush-soak.ts` | Rush bot phones, Playwright specs, soak test, screenshots |

Rules: only edit files you own (a minigame agent may add a private helper file `minigames/<id>.*.ts`).
Import anything. Never run `git` write commands (LEAD commits). Use `KP_TEST_PORT=<your port>` for any
server/Playwright run and never run the full Playwright suite concurrently with someone else.
`npx tsc --noEmit -p tsconfig.json` may show errors in other agents' files while they work — fix only yours.

## Party engine changes (LEAD)

- **16 players.** Lobby slots 0..15, colour = `SLOT_COLORS[slot]`, a unique `emoji` from `PLAYER_EMOJIS`
  and a funny clean two-word default name (`"Wobbly Waffle"`) on join, all persisted in the session
  snapshot. The relay accepts 16 connected phones per room (`room_full` on the 17th).
- **Kart / Smash stay 4 players.** `matchSeats()` takes the first `GameInfo.maxPlayers` ready players by
  **join order**; everyone else gets `PhoneState.watch = 'full'` (phone: "You're watching this one") and the
  TV shows a "👀 watching this one: …" chip on setup / loading / race / results. Characters stay unique while
  the roster allows; beyond 8 players duplicates are allowed (only the first 4 race anyway).
- **Drop-in mode** (`GameModule.dropIn`): picking Rush (leader phone, host click) from title / lobby /
  setup / results, leader START in the lobby, or a host reload with Rush active → `screen = 'race'`, `match`
  with an empty seat map, `module.startEndless()`. `screenFor()` returns `'race'` for EVERY player (no
  'waiting'). `onInput` tag 2 → `module.inputFrom(playerId)`, `{t:'mg'}` → `module.onMg(playerId)`, player
  join / rejoin / disconnect / remove / profile → `module.onPlayer`. Host "Back to hub" = `session.hostQuit()`
  → `module.quit()` → lobby. `session.hostKickPlayer(id)` removes a player (connected or not).
- **Switch Game** with three games: phone results screen + host results overlays show one button per other
  game (`post switch` with `game`), never a blind cycle.
- **Hub card** for Rush: when `!session.https` it shows "Motion controls need secure mode — start with
  *Start Party Hub (Tilt Steering)*".

## Protocol: the minigame channel

- **Host → phone** `RushPhoneMsg` (`t:'mg'`): the whole Rush view of one phone (phase, round id `rid`,
  minigame id/name/instruction/demo/word, which stream + events to detect, touch hint, countdown, seconds
  left, `me` (status, name, emoji, colour, points, rank, leader), `cue`, `res`, `safe`, `canNext`, `sip`).
  The SHELL sends it per player **only when it changed** (JSON diff), immediately (not on a ticker), so cue
  latency is one relay hop. Typical size 400–700 bytes; hard ceiling 2 KB.
- **Cues**: `cue.id` changes ⇒ the phone fires the triple cue once (full-screen flash + phone sound +
  vibration where supported — iOS has no vibration, so never the only cue) and restarts its reaction timer.
- **Phone → host** `MgFromPhone` (`t:'mg'`): `here` (join / come-back tap), `away` (tab hidden),
  `next` (leader), `mode` (v=1 sensors, v=0 touch), `act` (≤ 1/s activity heartbeat while hand-held or
  touched), gestures `flick` / `raise` / `pose` / `tap` with `rid`, and for cue-relative gestures
  `ms` (ms since cue `c` arrived, **measured on the phone**) — host clamps to 0..10000 and drops events whose
  `rid` is stale.
- **Stream** tag 2 `[2, seq, rid, a, b, c]` at **20 Hz**, only while the round asks for a stream (`s`), ints
  ±1000 (meaning per stream in protocol.ts). 16 phones × 20 Hz × ~30 B ≈ 10 KB/s through the relay.
- Relay: `'mg'` added to `PHONE_MSG_TYPES`; tag 2 needs 6 numeric fields; every message ≪ 16 KB.

### Streams (what `a, b, c` mean)

| stream | a | b | c | used by |
|---|---|---|---|---|
| `shake` | energy 0..1000 | shakes since GO | 0 | Shake Race, Fishing (reel) |
| `tilt` | right tilt ±1000 (≈ ±30°) | forward tilt ±1000 | 0 | Balance, Tilt Maze |
| `still` | movement now 0..1000 | 1 = resting on a table | accumulated movement since GO 0..1000 | Don't Move! |
| `pose` | pose index (`RUSH_POSES`) or -1 | confidence 0..1000 | 0 | Copy the Pose |
| `aim` | x ±1000 | y ±1000 | 0 | Darts |
| `pitch` | pitch ×10 (−900 top points at floor) | 0 | 0 | Quick Draw |

### Gesture events

| event | meaning | detector (phone) | touch fallback |
|---|---|---|---|
| `flick` | small quick wrist jerk in any direction (also "yank" / "cast" / "throw") | high-pass accel + gyro burst, low threshold so a small wrist motion always registers, 250 ms refractory | tap |
| `raise` | phone came up from pointing at the floor to level | holstered below −45° for 0.2 s, then above −20° within 600 ms | tap |
| `pose` | a new stable pose held ≥ 0.3 s (`v` = index) | gravity-only face classification | swipe ↑ upright, ↓ upside-down, ← left edge, → right edge, tap face-up, double-tap face-down |
| `tap` | screen tapped (touch players; always allowed) | — | — |

Touch-fallback streams: `shake` = mash a big button (energy from tap rate), `tilt` / `aim` = drag a thumb
pad, `still` = press-and-hold (release / finger drift = movement), `pose` = last swipe, `pitch` = −900.
Touch players get a small 👆 next to their token on the TV.

## Drunk-playable rules the code must enforce

1. One hand, one gesture, portrait; no on-phone button smaller than half the screen during play; no text
   entry, no reading on the phone during play (the phone shows colour, emoji, ONE giant word, flashes).
2. 5-second explanation: UP NEXT card (name, one line ≤ ~8 words, looping hand+phone gesture demo) on TV
   and phone, then 3-2-1-GO. No tutorials, practice rounds or ready-ups.
3. Forgiving input: wide thresholds, generous windows, smoothing, auto-calibration at GO.
4. Nobody can stall the party: no ready checks, no blocking turns, every phase has a hard timeout, a
   watchdog forces the next phase, a throwing minigame → "Oops — skipping that one!".
5. Never punish absence: no motion/input for a whole round → quietly 'away' (skipped, no penalty), back on
   the next tap; locked phone / closed tab / Wi-Fi blip = the same, score kept.
6. Readable from across the room: huge type, few elements, every player = colour + emoji + name.
7. Everyone gets a moment: big winner + a funny superlative for someone else (preferably last place).
8. Safe gestures: small wrist motions only; "Hold your phone tight!" (2 s) when a player first joins and
   before the two energetic games (Shake Race, Tug of War).

## The loop (SHELL)

```
scoreboard ─Next/auto─▶ UP NEXT (≈5 s, +2 s "hold tight" for energetic) ─▶ 3-2-1-GO ─▶ play (10–40 s)
     ▲                                                                                    │
     └──────────────── round results + points animation (≈6 s) ◀──────────────────────────┘
```

- Scoreboard: animated standings (all-time + "last 5 rounds" streak), big QR + room code + join URL, who
  just joined, who is away, "Round N", next game teased, auto-advance ring (default ON, 10 s), host key
  legend, HTTPS notice / certificate walkthrough (iPhone + Android, drawn in code) in secure mode.
- Advancing: Space / Enter / click on the host, or the leader's NEXT. Auto-advance only with ≥ 1 active human.
- Host keys (any moment): Space = next, P = pause/resume ("PAUSED — press Space"), S = skip minigame,
  R = replay last minigame, Esc = menu (settings, remove a player, back to hub).
- Picker: shuffle bag (each enabled game once before repeats, never twice in a row), skip games whose
  `minPlayers` isn't met; 1 human → add bots up to 3 participants (🤖, never on the all-time board).
- Heat: +1 per full bag pass (max = setting, ≤ 3) → shorter rounds, faster music, slightly harder params;
  "HEAT 2!" stinger. Never less forgiving input.
- Endless; every 10 rounds a "crown check" stinger.
- Settings (Esc menu, persisted in localStorage): auto-advance on/off + delay, enabled minigames, max heat,
  volume, sip mode, reset scores.
- Scoring: placement points among the N who took part: 1st = N … last = 1, ties share the higher value,
  +2 for 1st. Away players score 0 and are not shown. Team games: winners share place 1.
- Sip mode (default OFF): one light random line per results card ("Last place takes a sip — or a dare",
  water round regularly, never the same person twice in a row). Nothing mentions drinking when off.
- Roster: everyone in `session.players`. New phone → `new` until its join tap (`here`) → `next` (mid-round)
  or `play`. Idle for a whole round, tab hidden, or disconnected → `away`; back on `here` / reconnect.
  Away > 10 min → dropped from the board (score kept if they return with the same phone).
- Snapshot/restore through `GameModule.snapshot/restore` (scores, streaks, round, heat, bag) so a host
  reload restores the scoreboard; settings in localStorage.
- `window.__rush` (see Test hooks).

## Minigame interface (types.ts — summary)

`MinigameDef { meta, create() }` + a pure bot brain file. `Minigame`: `start(ctx)` (COUNT), `go()`,
`onStream`, `onEvent`, `onLeave` (must not leave anything stuck), `onReturn`, `update(dt)`,
`render(g, view)` on a 1920×1080 logical stage (top 110 units = shell HUD), `done()`, `results()` →
ranking (+ superlatives, headline), `botHint(id)`. `ctx`: heat, players, seeded `rand`, `time`,
`timeLeft`, `isPresent`, `cue(id, cue, fire)`, `word(id, w)`, `sfx`, `shout`, `end()`.
Players are drawn ONLY with `drawToken` (colour + emoji + name). Tuning constants live in
`src/games/rush/tuning.ts` (one block per minigame). Validate with `npx tsx scripts/rush-selftest.ts --game <id> --verbose`.

## The 10 minigames — design decisions

Durations are hard caps per heat [1,2,3] (seconds). "Scale" = behaviour at 1 / 2 / 4 / 8 / 16 players
(1 human always has bots, so "1" means a 3-participant round).

### 1. Shake Race (`shake-race`, MG1) — "Shake to run!" — stream `shake`, energetic
- Lanes: one per player (16 lanes fit: lane height shrinks, tokens ≥ 28 units). Speed = smoothed energy
  with diminishing returns above ~70 % (no reward for dangerous flailing); light rubber-band (leaders
  −15 %, last +15 %). First to the line or cap [12, 10, 9]; rank by distance.
- Themes rotate per round (same input): run (track), pump a balloon (pops at 100 %), shake a soda bottle
  (cap flies). Heat: shorter track/cap, faster music.
- Touch: mash the big button. Bot: energy noise around skill×800 with bursts.
- Superlatives: "Shook like a leaf" (top energy), "Slow and steady" (last), "Photo finish" (< 2 % gap).

### 2. Quick Draw (`quick-draw`, MG1) — "Phone down… raise on DRAW!" — stream `pitch`, event `raise`
- Best of 3 quick draws. Each: wait random 2–6 s (heat: 1.5–4.5 s) with TV fake-outs ("DRAWER!", "DRAMA!",
  a tumbleweed, a crow) — the phone never cues on fakes. DRAW → per-player cue (fx 'go', bg green) →
  phone measures ms to `raise`. Raising before DRAW = out for that draw (phone red 'OUT' cue). TV shows
  holstered state from pitch and everyone's reaction time. Score = sum of best 2 times; outs = 1.5 s.
- Touch: tap on DRAW. Bot: raise at 220–600 ms after the cue (skill), small early-raise chance.
- Superlatives: "Fastest hand in the West", "Slowest draw in the West", "Itchy trigger finger" (early).
- Scale: 16 cowboys in a row/two rows. Cap [25, 22, 20].

### 3. Balance (`balance`, MG2) — "Keep the ball on the plate!" — stream `tilt`
- One plate per player in a grid; a ball rolls with tilt (heavy smoothing); a wobble force grows over time
  (heat: grows faster). Ball off the rim = out (TV splat, phone red cue). Last ball standing wins; cap
  [35, 30, 28]; rank by survival time, ties by distance from centre.
- Touch: drag pad. Bot: PD controller toward centre using `botHint = [ballX, ballY]` (Node bots: noise).
- Superlatives: "Steady as a surgeon" (winner), "Butterfingers" (first out), "Clutch save" (near-miss).

### 4. Tilt Maze (`tilt-maze`, MG2) — "Tilt to roll to the exit!" — stream `tilt`
- One shared maze (several hand-made layouts per heat), every marble = a token, no player collisions,
  wide corridors, bumpers + slow mud (no instant-fail holes). First to the exit; cap [40, 36, 32]; rest
  ranked by path distance to go (BFS on a grid).
- Touch: drag pad. Bot: follow the BFS gradient via `botHint`; Node bots wander.
- Superlatives: "Marble master", "Lost in the maze" (furthest), "Mud wrestler" (most time in mud).

### 5. Hot Potato (`hot-potato`, MG1) — "Flick to pass the bomb!" — event `flick`, min 3
- The bomb lives on phones: holder cue `show:'bomb'`, `v` = fuse progress (phone pulses + ticks faster),
  `fire:false` updates. Flick → bomb flies (TV arc) to a random other present player (not the one who just
  threw it to you); pass cooldown 0.8 s. Hidden fuse 8–20 s (heat shorter). 6+ players → 2 bombs, 11+ → 3.
  2–3 fuses per round; holders at the bang lose a life-point; rank by bangs (fewer = better), ties by total
  holding time. A holder who leaves → bomb jumps to someone else immediately.
- Touch: tap. Bot: flick after 0.3–1.5 s of holding.
- Superlatives: "Hot hands" (most bangs), "Teflon" (never held), "Hot potato hoarder" (longest hold).

### 6. Don't Move! (`dont-move`, MG1) — "Freeze! Don't move a muscle!" — stream `still`
- 15 s. TV: each player a jelly/seismograph wobbling with `a`; silly distractions (honks, "SNEEZE!",
  dancing emoji) to make people laugh. Least accumulated movement `c` wins. `b = 1` (table) → phone cue
  "PICK IT UP!" and that player counts as moving a lot until they do.
- Touch: press and hold; lifting = big movement. Bot: low noise scaled by (1 − skill).
- Superlatives: "Human statue", "Jelly legs" (most movement), "Sneezed" (biggest single spike).

### 7. Tug of War (`tug-of-war`, MG3) — "PULL on the beat!" — event `flick`, min 2, energetic
- Random balanced teams re-rolled every time (colour bands on the TV, `me.team` on the phone); odd counts
  normalised per player (team force = mean of member pulls × max team size). Drum beat (TV + `cue` per beat,
  fx 'tick', `fire:true` every beat so the phone pulses); a flick within ±160 ms of a beat (judged on the
  host from phone-measured `ms` vs. the beat cue) = strong pull (1.0), off-beat = 0.25, mashing (> 3/beat) =
  0.1 each. Rope + mud pit; cap [30, 26, 22]; else whoever is ahead. Winners all place 1.
- Touch: tap on the beat. Bot: flick at the beat ± jitter (skill).
- Superlatives: "Metronome" (best timing), "Rope burn" (most pulls), "Dead weight" (fewest pulls).

### 8. Copy the Pose (`copy-pose`, MG3) — "Match the phone on screen!" — stream `pose`, event `pose`
- TV shows a big phone in one of 6 gravity poses (cue `show:'pose'`, `v` = index, so the phone also draws
  it); 6–8 poses per round (heat: more, faster). A pose event matching the target with phone-measured `ms`
  scores; first matcher most points (per pose: N..1 by order). Pose must be held ≥ 0.3 s (phone-side).
- Touch: swipe direction / tap / double-tap. Bot: correct pose after 0.6–1.8 s, sometimes wrong first.
- Superlatives: "Yoga master", "Upside-down specialist", "Still loading…" (slowest).

### 9. Fishing (`fishing`, MG3) — "Flick to cast. Buzz? YANK!" — stream `shake`, event `flick`
- Per player loop: flick = cast (TV line into the shared pond) → random 2–6 s wait → bite (cue fx 'buzz',
  `show:'fish'`, word 'YANK!') → flick within a generous 1.5 s window (phone-measured `ms`) = hooked →
  shake to reel (stream energy fills a reel bar). Fish sizes/points + the odd boot. Yanking with no bite
  scares fish 1.5 s. Cap [40, 36, 32]; highest total weight wins.
- Touch: tap to cast/hook, mash to reel. Bot: cast, yank 300–900 ms after the bite, shake energy.
- Superlatives: "Master angler" (heaviest fish), "Boot collector", "Scared the fish" (most early yanks).

### 10. Darts (`darts`, MG2) — "Aim… flick to throw!" — stream `aim`, event `flick`
- One big shared board; each player's crosshair (token-coloured ring + emoji) from `aim` with a small
  sway; flick throws (phone re-centres aim on every new dart + double-tap). 3 darts each in [25, 22, 20] s,
  all at once; darts stick in player colours. Very generous rings. Rank by total score.
- Touch: drag to aim, tap to throw. Bot: aim toward the bull via `botHint` with skill-scaled error.
- Superlatives: "Bullseye!", "Hit the wall" (missed the board), "Consistent" (smallest spread).

## Test hooks

- `window.__rush` (host): `getState()` → `{ phase, round, heat, game, rid, timeLeft, paused, auto,
  players: [{id, name, emoji, color, st, pts, streak, rank, touch, bot, connected}], lastResults, errors,
  bag, settings }`, `next()`, `skip()`, `pause(on?)`, `replay()`, `forceGame(id)`, `setSetting(k, v)`,
  `fps()`.
- `window.__phone.motion` (phone): `inject(raw)`, `gesture(k, v?, x?, y?)`, `state()`; `__phone.getState()`
  adds `rush` (last RushPhoneMsg) and `rushTouch` (touch-fallback mode).
- `scripts/bots.ts`: `bot.rushHere()`, `bot.rushEvent(k, v?)`, `bot.startRushBrain()` (uses the minigame
  bot brains from `src/games/rush/bots.ts`), `bot.rush` (last RushPhoneMsg).

## Contract additions log

(append here: who, what, why)
- LEAD: `Minigame.teamOf?(id)` (optional) — team minigames report each player's team; the SHELL puts it in
  `RushPhoneMsg.me.team`. Requested by MG3 (Tug of War).
- LEAD (MG3 notes for PHONE): cue updates with `fire:false` (same id, new `word`/`v`) must re-render the
  phone without re-firing the triple cue; `flick`/`tap`/`pose` events must carry `ms` + `c` whenever a cue
  is up; the `pose` stream must keep reporting the held pose (Copy the Pose relies on it when the player
  already holds the target pose).
- LEAD: `drawEmoji` sets an opaque fillStyle (Chrome tints colour emoji with the fill alpha). Found by MG1.
- MG1/MG2 deviations accepted: Don't Move! ranks by mean per-sample movement `a` (not `c`, which saturates
  and is skewed by dropped packets); Hot Potato caps catch grace at 0.8 s past the fuse; Tilt Maze generates
  seeded, length-checked layouts per round instead of hand-made ones; Quick Draw raise window 600 ms.
- SHELL: Rush overlays mark test ids with `data-rtid`; `StageView` sets `data-testid` only on the layers that
  are actually visible (HostUI's `data-tid` would tag hidden layers too). Only `rush-stage` uses `data-tid`.
- LEAD: Tug of War implements `teamOf` (team reaches phones as `me.team`).
- LEAD (TEST findings fixed): snapshot keeps current/most recent players when the 64-player cap bites (host
  reload lost scores late in a long party); Rush `kbd` hints readable; `drawToken` gains `labelMaxWidth`
  (Tug of War / Quick Draw names no longer overlap); 9+ player scoreboard gives names the room (no "+N" chip,
  short streak); phone says TAP instead of FLICK for touch players; phone header fits 14-char names.
