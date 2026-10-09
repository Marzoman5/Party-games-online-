# 🎉 Party Hub — Kart Party + Smash Party + Party Rush

> **Party quick start**
> 1. On whatever computer is connected to the TV, open **<https://marzoman5.github.io/Party-games-online-/>**
>    (Chrome, Edge, Firefox or Safari) and press **F** for fullscreen. Nothing to install.
> 2. Everyone's phone on the **same Wi-Fi** as that computer → scan the **QR code** on the TV
>    (or open the link shown under it and type the 4-letter room code).
> 3. Pick a name + character, tap **READY**. The first player (👑 leader) picks **Kart Party**, **Smash Party** or **⚡ Party Rush** on their phone.
> 4. Leader taps **START**. After each match the leader picks **Rematch / Change Settings / Switch Game / Lobby**.
>
> No internet at the party, or phones can't connect to the website's game? Use the
> [local / offline route](#local--offline-npm-start): `npm install && npm start` on a laptop.

Party Hub is a couch-multiplayer party app: the game runs on a laptop or TV, and **up to 16 players use
their phones as controllers** (a web page, nothing to install; Kart and Smash seat 4 at a time). Players
join **once** and stay connected while the party switches between games:

- **🏁 Kart Party** — arcade kart racer: 8 karts, 4 tracks, 13 items, drifting, Grand Prix, split-screen.
- **🥊 Smash Party** — an original 2.5D platform fighter: damage %, knockback, blast-zone KOs, 8 fighters,
  3 stages (+ training), items, CPU fighters (levels 1–9), stock/time modes, 2v2 teams.
- **⚡ Party Rush** — an endless, drop-in / drop-out stream of 10 fast **motion minigames** for 1–16
  players: phones are one-handed motion controllers (shake, tilt, flick, freeze…), the TV shows everything.
  Built for a loud room: join any time with one tap, 5-second explanations, no setup, never stalls.

Everything is original and generated in code — no asset files, no web fonts, no internet needed at the
party. No Nintendo names, characters, sprites, sounds or stage likenesses are used.

---

## Contents
- [Hosting: the website or `npm start`](#hosting-the-website-or-npm-start)
- [Party Hub flow](#party-hub-flow)
- [⚡ Party Rush](#-party-rush) (quick start, the 10 games, host keys, settings, adding a minigame)
- [Smash Party: controls](#smash-party-controls)
- [Smash Party: mechanics](#smash-party-mechanics)
- [Smash Party: fighters & movesets](#smash-party-fighters--movesets)
- [Smash Party: stages & items](#smash-party-stages--items)
- [How the party engine works](#how-the-party-engine-works) · [**How to add a game**](#how-to-add-a-game) · [**How to release**](#how-to-release)
- [Local / offline: `npm start`](#local--offline-npm-start) · [Firewall tips](#firewall-tips-phones-cant-connect) · [TV mode](#tv-mode) · [HTTPS / tilt](#https-mode-tilt-steering-on-iphone)
- [Kart Party controls](#controls) · [Kart game flow](#game-flow)
- [Architecture & protocol](#architecture) · [Testing](#testing)
- [Design decisions](#design-decisions) · [Known limitations](#known-limitations) · [Credits](#credits--licenses)

## Hosting: the website or `npm start`

The game always runs in the **host's browser** (the computer on the TV); phones are controllers. There are
two ways to connect them, with the same games, screens and rules:

| | **Website** (GitHub Pages) | **Local / offline** (`npm start`) |
|---|---|---|
| Start | open <https://marzoman5.github.io/Party-games-online-/> | `npm install && npm start` on a laptop |
| Phones talk to the host | **directly** (WebRTC data channels) | through the Node server on the laptop (WebSocket) |
| Needs | internet to *join* (a free signalling service); phones on the host's Wi-Fi | nothing but the Wi-Fi; no internet at all |
| Motion sensors (Party Rush, tilt steering) | work out of the box (the site is HTTPS) | need `npm run start:https` + a certificate warning per phone |
| Cost | free (static hosting; free public signalling + STUN) | free |

**How the website version connects.** The host page *is* the server: it creates the room code and owns the
player ids, reconnect tokens and message routing (the same code the Node server runs,
`src/net/hub.ts`). A phone that opens the join link asks a public **signalling service** to pass a
connection offer to the host page, then talks to it over a direct WebRTC connection; after that no
third party is involved (on the same Wi-Fi, game input stays on the local network). Two independent free services are
used at once so one outage doesn't stop people joining: the **PeerJS** cloud server, with public
**Nostr relays** as the fallback (messages encrypted with the room code). Players already in the game keep
playing if both go down; only new joins wait. Free public **STUN** servers help phones find a route; a
**TURN** relay is optional (none by default). All of it is configurable in
[`src/net/rtc/config.ts`](src/net/rtc/config.ts) or with repository variables at build time
(`ICE_SERVERS`, `PEERJS`, `NOSTR`; see `.github/workflows/deploy.yml`).

**If a phone can't connect** it says so instead of spinning: *"Can't connect to the game… Connect this phone
to the same Wi-Fi as the computer showing the game"* (guest Wi-Fi with client isolation and some mobile
networks block direct connections), *"You seem to be offline"* (no signalling service reachable), or
*"Room ABCD not found"*. When the venue's network blocks direct connections, fall back to the
[local route](#local--offline-npm-start) or a phone/laptop hotspot.

**Links.** The phone page is `…/Party-games-online-/play/?room=ABCD`; typing
`…/Party-games-online-/play/ABCD` also works (GitHub Pages' `404.html` forwards it, no server needed).

## Party Hub flow

1. **Title** — big QR code + room code; the active game's attract demo plays behind it.
2. **Lobby (the hub)** — players join, pick a name and one of the 8 characters (the same roster is used
   by both games; each character can be taken once) and tap READY. The **leader picks the game** on their
   phone (the TV shows two big game cards; the host mouse can click them too).
3. **How to play** — plays automatically the first time **each** game is started in a session: an animated
   phone illustration on the TV with callouts, every phone shows the same step, players tap **Got it!**
   (leader can skip; replay any time with *How to Play*).
4. **Smash only: "try it" practice** — on the training stage everyone controls their fighter and can punch
   a training dummy whose % keeps rising. Each player taps **I'm ready** (their fighter leaves); the leader
   taps **START** (or it ends when everyone is ready).
5. **Setup** — the leader configures the match on their phone (Kart: mode/track/cc/laps; Smash:
   stage, stock/time, stocks/time, teams + friendly fire, CPU fill + level, items + frequency, hazards).
   In team mode every player picks their team on their own phone.
6. **Match** → **Results** → leader: **Rematch**, **Change Settings**, **Switch Game**, **Lobby**
   (Kart also has **Next Race**). Switch Game keeps every player, slot and the leader; phones swap their
   controller layout instantly, no reload or rejoin.

Pause from any phone (⏸): the leader resumes/restarts/quits, others vote to resume. A phone that
disconnects mid-match is handed to the AI/CPU; reopening the page on the same phone reclaims it.

## ⚡ Party Rush

An endless party show: a minigame is announced, everyone plays for 10–40 seconds with their phone as a
motion controller, points fly onto a scoreboard, the next one starts — forever. Designed to be
**drunk-playable**: one hand, one gesture, eyes on the TV, explained in 5 seconds, forgiving input, nobody
can stall the party, nobody is punished for walking off to get a drink.

### Quick start

1. Open the [website](https://marzoman5.github.io/Party-games-online-/): it is HTTPS, so phones can use their
   motion sensors right away. (Local route: start the server in **secure mode** — double-click
   **Start Party Hub (Tilt Steering)**, which runs `npm run start:https`. Over plain HTTP everything still
   works, but phones fall back to touch controls; the hub card and the scoreboard say so.)
2. On the TV pick **⚡ Party Rush** (leader's phone, or click the card). It starts immediately — no lobby,
   no ready-up, no tutorial.
3. Everyone scans the QR (always on the scoreboard, small in a corner during play) and taps **TAP TO PLAY**
   once. That tap unlocks sound, asks iOS for motion permission and keeps the screen awake. The TV shows the
   exact taps to get past the self-signed certificate warning on iPhone and Android.
4. Hold the phone in one hand, upright, look at the TV. Joined mid-round? "You're in next round!".

### The loop

`scoreboard → UP NEXT card (≈5 s: name, one-line instruction, looping hand+phone animation on TV and phone)
→ 3-2-1-GO → play (10–40 s) → results (≈6 s) → scoreboard`. Auto-advance is on (10 s ring). Every full pass
through the games raises the **HEAT** (shorter, faster, never fussier); every 10 rounds there's a crown
check. Scoring: among the N players who took part, 1st gets N points … last gets 1 (ties share, +2 for
1st); the "last 5 rounds" column lets newcomers be on fire quickly. Someone idle for a whole round (or with
the tab hidden / phone locked / Wi-Fi gone) is quietly marked away, skipped without penalty and back on
their next tap — score kept. Alone? Two or three 🤖 bots join so every game still works.

### The 10 minigames

| | Game | Gesture | No motion sensors (👆 touch) |
|---|---|---|---|
| 🏃 | **Shake Race** — shake to run (or pump a balloon, or shake a soda bottle) | shake | mash the button |
| 🤠 | **Quick Draw** — hold still… flick your phone on DRAW! (best of 3, beware fake-outs) | hold still, quick flick (any grip) | tap on DRAW |
| 🍽️ | **Balance** — keep the ball on your plate while the wobble grows | tilt | drag the pad |
| 🌀 | **Tilt Maze** — roll your marble through a shared maze to the exit | tilt | drag the pad |
| 💣 | **Hot Potato** — the bomb is ON your phone: flick it to someone else (3+ players) | small flick | tap |
| 🧊 | **Don't Move!** — freeze while the TV tries to make you laugh | hold still | hold your thumb still |
| 🪢 | **Tug of War** — random teams, pull on the drum beat (2+ players) | flick to pull (on the beat = power pull) | tap |
| 📱 | **Copy the Pose** — match the phone pose on screen, fastest wins | 6 gravity poses | swipe / tap / double-tap |
| 🎣 | **Fishing** — flick to cast, buzz? YANK!, shake to reel | flick, shake | tap, mash |
| 🎯 | **Darts** — aim with your wrist, flick to throw 3 darts | tilt to aim, tap the screen to throw | drag, tap to throw |

Two games (Shake Race, Tug of War) show a "Hold your phone tight!" card first. All gestures are small wrist
motions — detection thresholds are low so nobody learns to swing hard.

### Host keys (any moment)

`Space`/`Enter` next · `P` pause/resume · `S` skip this minigame · `R` replay the last one · `Esc` menu
(settings, remove a player, back to the hub). The party leader can also press the big **NEXT** on their
phone. **Settings** (persisted): auto-advance on/off + delay, which minigames are enabled, max heat, volume,
**sip mode** (off by default: adds one light "sip or dare" line to the results, including regular water
rounds; nothing mentions drinking when it's off), reset scores.

### More than 4 people in Kart / Smash

The party holds up to 16 phones. Kart Party and Smash Party still seat 4: the first 4 by join order play,
everyone else's phone says "You're watching this one 👀" and the TV shows who is watching.

### Tuning after a real party

Motion feel can only be approximated by bots. All the knobs are in two files:
- `src/games/rush/tuning.ts` — loop timings/scoring (`LOOP`) and one block per minigame (durations, speeds,
  windows, per-heat values).
- `src/phone/motion/tuning.ts` — gesture-detector thresholds (shake scale, flick threshold, table/still
  noise floors, pose angles, tilt range, raise window, aim range).

Try on real phones first: a small wrist flick in Hot Potato (should always register), shake energy in Shake
Race (a brisk shake ≈ full speed), Don't Move! with the phone in hand vs. on a table, Copy the Pose face-down,
Quick Draw holster + raise, and tilt direction in Balance. `__phone.motion.state()` in the phone's console
shows the detected iOS sign / gyro units.

### Adding an 11th minigame

1. Create `src/games/rush/minigames/<id>.ts` exporting a `MinigameDef` (`meta` + `create()`; see
   `src/games/rush/types.ts` — draw on the 1920×1080 stage, players only with `drawToken`) and a pure bot brain
   `<id>.bot.ts` (`BotFactory`).
2. Add one line to `src/games/rush/minigames/index.ts` and one to `src/games/rush/bots.ts`, and a tuning block.
3. `npm run test:rush` (headless: 1–16 players, heat 1–3, leavers, touch players), then look at it with the
   dev harness: `npx vite`, open `/src/games/rush/dev/harness.html?game=<id>&players=16`
   (or `npx tsx scripts/rush-shot.ts --game <id> --players 16 --at 8`).
If it needs a new phone gesture, add a detector in `src/phone/motion/` + a touch fallback in
`src/phone/rush/touch.ts` and extend `RushStream`/`RushEvent` in the protocol.

### How it fits the engine

Party Rush is a `GameModule` with `dropIn = true` (`src/games/rush/RushModule.ts`): the session skips
lobby/tutorial/setup/results, puts everyone on screen `race`, and hands the module player events, `{t:'mg'}`
messages and tag-2 stream packets by playerId. The shell (`src/games/rush/shell/`) owns the loop, scoring,
roster/away, solo bots, phone sync, audio and the TV views; each minigame is an isolated plug-in. The phone
(`src/phone/rush/`) is a generic, data-driven controller: the host tells it which sensor stream and gestures
to detect (`src/phone/motion/`), what giant word to show and when to fire a cue (full-screen flash + sound +
vibration — iOS has no vibration, so never the only cue). Reaction times are measured on the phone, so Wi-Fi
jitter doesn't decide Quick Draw. Full contract: `docs/PARTY_RUSH_CONTRACT.md`.

## Smash Party controls

### Phone (hold sideways)

| Control | Action |
|---|---|
| **Left side: floating stick** | Put your thumb anywhere on the left half — the stick appears there. Walk (light push), run (full push), crouch (down), drop through platforms (down on a thin platform), fast-fall (down in the air). The stick direction also picks the attack. |
| **A — ATTACK** | Neutral: jab (tap again for a 3-hit combo). With a direction: forward/up/down **tilt**. Running: dash attack. In the air: neutral/forward/back/up/down **aerial**. **Flick the stick + ATTACK = SMASH attack** — hold A to charge it (up to 1 s, +40 % damage). Near an item: pick it up; holding one: use/throw it. |
| **B — SPECIAL** | 4 specials per fighter: neutral / side / **up (recovery — use it when you fall off!)** / down. With the Party Orb power: your **final blast**. |
| **JUMP** | Jump (tap = short hop, hold = full jump), tap again in the air for the double jump. |
| **SHIELD** (hold) | Block. Shield + left/right = roll, shield + down = spot dodge, shield + ATTACK = grab. In the air: air dodge (in the stick direction). The shield shrinks while held — if it breaks you're dizzy! |
| **GRAB** | Grab; then the stick throws (forward/back/up/down) and ATTACK pummels. Holding an item: throw it. |
| **⏸ / ⚙️** | Pause · settings: **tap-jump** (flick up to jump — OFF by default), vibration, left-handed, stick size. |

The phone shows your fighter, colour, damage % (white → yellow → red), stocks (or score + timer), and
vibrates when you're hit (scaled by how hard), KO'd, or land a KO (Android; iOS has no vibration API).
Inputs go out at 60 Hz plus instantly on every button press; presses are counted, and the host buffers
each press for 5 frames, so mashing over Wi-Fi never loses an input.

### Host keyboard (during Smash)
**Esc/P** pause · **H** hitbox/hurtbox debug overlay · **M** mute · **F** fullscreen · **T** TV mode (title/lobby).

## Smash Party mechanics

- **Damage %, not health.** Every hit raises the target's %; the higher it is, the farther they fly.
- **Knockback** uses a Smash-style formula (`src/games/smash/types.ts`):
  `kb = ((((p/10 + p·d/20) · 200/(w+100) · 1.4) + 18) · kbg/100) + bkb` — target % after the hit `p`,
  move damage `d`, fighter weight `w`, the move's knockback growth `kbg` and base knockback `bkb`.
  Launch speed = kb × 0.003 units/frame, decaying 0.0051/frame; hitstun = 0.4 × kb frames; above 80 kb
  the fighter tumbles (smoke trail) and gets knocked down on landing. Every move has its own launch angle.
- **Hitlag** (freeze frames) on hits, longer on strong ones; hit sparks, screen shake, % number shake.
- **KO** = leaving the blast zone (left/right/top/bottom): explosion beam, shake, crowd roar.
  Respawn on a halo platform with ~2 s invincibility.
- **Stock mode** (default 3 stocks) or **Time mode** (default 2 min; +1 per KO, −1 per fall/self-destruct).
  Ties go to **sudden death** (300 %, one stock).
- **Movement:** walk, run, jump + one double jump, short hop, fast-fall, platform drop-through,
  **ledge grab** (brief invincibility; climb/jump/attack/roll/drop), air dodge, roll, spot dodge.
- **Shield** shrinks with use and under hits; **shield break = dizzy**. **Grab + 4 throws**, pummel.
- **Attacks:** jab combo, 3 tilts, 3 chargeable smashes, 5 aerials (with landing lag), 4 specials,
  get-up and ledge attacks. All hitboxes/hurtboxes are data (startup, active, end lag frames) in
  `src/games/smash/sim/moves.ts`; press **H** on the host to see them.
- The simulation is a deterministic fixed 60 Hz step (`src/games/smash/sim/SmashSim.ts`), independent of
  the render frame rate.

## Smash Party fighters & movesets

The 8 Kart Party racers, as full-body procedural low-poly fighters with keyframed animations
(idle, run, jump, attacks, hurt, tumble, ledge hang, unique victory poses):

| Fighter | Archetype | Weight | Neutral B | Side B | Up B (recovery) | Down B | Final blast | Tip |
|---|---|---|---|---|---|---|---|---|
| Max Vortex | All-rounder | 98 | Vortex Ball | Gust Cape | Vortex Uppercut | Cyclone Spin | Vortex Rush | Jab, tilt, then forward smash at high %! |
| Boulder Bram | Heavy bruiser | 125 | Boulder Toss | Rockslide Shoulder (armour) | Mountain Leap | Quake Stomp | Landslide | One charged forward smash ends stocks. |
| Zippy Nova | Speedy combo | 72 | Pinball Spin | Slipstream Dash | Corkscrew Climb | Tailwind Kick | Hyper Lap | Never stop moving: jab, dash in, juggle with up air! |
| Kai Tidewater | Sword / reach | 96 | Tidal Edge (charge) | Wave Breaker (3 hits) | Riptide Rise | Undertow Counter | Riptide Cleave | Fight at the tip of your blade. |
| Juno Bolt | Projectile zoner | 92 | Storm Bolt (charge) | Seeker Spark (homing) | Thunder Leap | Static Field | Storm Cannon | Charge Storm Bolt while they approach. |
| Fennec Flash | Trickster | 82 | Mirage Decoy | Fox Fire (homing) | Blink Step (teleport) | Mirror Tail (reflector) | Mirage Ambush | Bait with decoys, reflect zoners. |
| Pixel Pop* | Bubble-gum zoner | 78 | Gum Bomb | Sugar Rush | Bubble Lift | Pop Rocks | Sugar Storm | Lob gum bombs, float away. |
| Big Rig Rosa* | Grappler | 118 | Horn Blast | Big Rig Rush (charge, armour) | Jackknife | Tow Hook (beats shields) | Eighteen Wheeler | Throw them off the edge! |

\* rougher kits (less tuning than the six polished archetypes). Fighters also differ in run speed,
jump height, air speed/control, gravity and fall speed.

**CPU fighters** (levels 1–9) fill empty slots when the leader sets *CPU fill*: L1–2 are slow and
beatable, L5–6 short-hop and combo, L7–9 edge-guard and shield/dodge reactively. Every level recovers to
the stage, never walks off on purpose, uses items, and never targets teammates.

## Smash Party stages & items

| Stage | Layout | Music |
|---|---|---|
| **Skyline Summit** | Classic: main platform + 3 floating platforms, sunset above the clouds | its own song |
| **Neon Arena** | Flat, no platforms, moonlit arena with a crowd | its own song |
| **Magma Forge** | Two moving platforms + lava eruptions (warned ~2 s ahead). *Hazards off* = still platforms, no lava | its own song |
| Training Room | Flat practice stage with the dummy (used by "try it") | its own song |

Items (toggle + frequency low/medium/high in setup):
**Bat** (home-run swing, breaks after 4 swings) · **Bomb** (throw it; explodes on contact or after its
fuse) · **Power donut** (heals ~15 %) · **Surprise capsule** (throw/break it → random item, sometimes
explodes) · **Party Orb** (rare, floats around; break it with 3 hits to power up — your next SPECIAL is a
final blast that deals ~33–40 % and only launches hard at high %).

## How the party engine works

```
src/engine/        game-agnostic party engine
  PartySession.ts  screens state machine, players/slots/tokens/reconnect, leader + succession,
                   ready/teams, tutorial runner, sandbox, pause + resume vote, game switching
  PhoneSync.ts     personalised PhoneState per phone (diffed) + ~10 Hz per-phone match status
  net/HostNet.ts   host link to the relay, reconnect, decodes the input packets (kart 0, fighter 1, rush 2)
  net/rtc/RoomServer.ts  website only: the host page as the room server (hub + WebRTC + signalling)
  GameModule.ts    THE game-module interface (TSDoc)
  display.ts       TV mode (--ui-scale, --safe, html.tv), fullscreen, cursor hiding
src/party/         host UI shell: title (QR), lobby/hub with game cards, tutorial, race/pause overlays
src/games/registry.ts   the list of games
src/games/kart/         KartModule (wraps the kart engine, setup, Grand Prix, results, tutorial art)
src/games/smash/module/ SmashModule (setup sanitising, tutorial, sandbox, results, host setup/results UI)
src/games/smash/        Smash engine: sim/ (60 Hz simulation + CPU AI), model/ (fighters), view/ + SmashGame.ts
src/phone/         phone controller framework + layouts (kart controller, fighter controller, rush)
src/net/           protocol.ts (the wire contract), hub.ts (rooms/tokens/routing, shared by both transports),
                   link.ts (the transport seam), rtc/ (WebRTC peer, signalling, config)
server/            Node relay: serves the pages, runs src/net/hub.ts over WebSocket (game-agnostic)
scripts/bots.ts    bot phones (kart driving + Smash bot brain) for tests and soak runs
```

A game is a `GameModule` (`src/engine/GameModule.ts`) that declares:
- **metadata** (`info`: id, title, tagline, emoji, colour, min/max players) and its phone **controller layout** id;
- **tutorial** steps (+ the phone illustration and callout anchors) and an optional **sandbox**;
- **setup** (`getSetup` / `applySetup` with sanitising / snapshot) and its host setup + results **views**;
- **lifecycle hooks**: `load` (lazy engine import), `activate` / `deactivate` / `showAttract`,
  `startFromSetup`, `post` (rematch/next), `restart`, `quit`, `pause`, `resume`;
- **players**: `input(seat, …)`, `setSeatAI(seat, on)` for disconnect handover, `status(seat)` (the ~10 Hz
  message each phone gets), `tryIt` reactions, `look(characterId)` for portraits;
- **results** come back through the session (rows + winner info) and drive the post-match menu.

Games never see the network: they get decoded inputs and send `HostToPhone` messages through the session,
so they work unchanged on both transports. See [How to add a game](#how-to-add-a-game).

## How to add a game

The game-module structure already makes this a self-contained job; nothing in networking, hosting, the
lobby, QR/join, reconnect, pause/vote, TV mode or the tutorial runner needs to change.

1. **Branch**: `git checkout main && git pull && git checkout -b feat/<game>` (see `CONTRIBUTING.md`).
2. **Module**: create `src/games/<game>/` with a `GameModule` (`src/engine/GameModule.ts` documents every
   hook; copy the shape of `src/games/kart/KartModule.ts` or `src/games/smash/module/SmashModule.ts`).
   Load the heavy engine lazily in `load()` (dynamic `import()`), as Smash does, so the phone page and the
   first paint stay small. For a Party-Rush-style drop-in game set `dropIn = true`.
3. **Register** it in `src/games/registry.ts`, and add its id to `GameId` / `GAME_IDS` in
   `src/net/protocol.ts`.
4. **Phone controls**: reuse a layout (kart, fighter, rush) or add one in `src/phone/framework/layout.ts`
   (implement `ControllerLayout`, register it in `LAYOUT_FACTORIES` / `LAYOUT_FOR_GAME`). Input that needs
   to be fast goes in a compact array packet like `[1, …]` (fighter) or `[2, …]` (rush stream) — reuse one
   if it fits. A **new** packet tag must also be added to the validator in `src/net/hub.ts`
   (`relayInput`) and the decoder in `src/engine/net/HostNet.ts`; that's the only networking change ever
   needed, and it covers both transports. Keep packets to absolute state + press counters (the website
   sends them on an unreliable channel where a lost packet is simply superseded by the next one).
5. **Tests**: a Playwright spec with bot phones (`scripts/bots.ts`, `tests/smashHelpers.ts` as a model)
   in `tests/`, and a short real-phone check in `tests/rtc/rtc-games.spec.ts` proving that a tap on the
   phone reaches your game over WebRTC.
6. **Release** it as a minor version (`1.1.0`): add a line under *Unreleased* in `CHANGELOG.md`, open a
   PR, then follow [How to release](#how-to-release).

## How to release

`main` is always releasable and every push to it redeploys the website. Work happens on short-lived
`feat/…` / `fix/…` branches merged by pull request (CI runs typecheck, both builds and the end-to-end
suites on each PR). To publish a version:

1. Pick the number: **`1.1.0`** for new features or games, **`1.0.1`** for fixes (major only for breaking
   changes such as a protocol version bump).
2. In a PR: set `"version"` in `package.json` (`npm version 1.1.0 --no-git-tag-version`), move the
   *Unreleased* notes in `CHANGELOG.md` under `## [1.1.0] - YYYY-MM-DD`, merge.
3. Publish: on GitHub **Actions → Release → Run workflow** with the version (or push a tag:
   `git tag v1.1.0 origin/main && git push origin v1.1.0`). The *Release* workflow tags `main` and
   publishes a GitHub Release with that CHANGELOG section as its notes.
4. The version shows small on the title screen (bottom left) and under the phone's room-code box, so you
   can see at a glance which build a party is running.

Details and the branch rules: [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Local / offline: `npm start`

The original way to host, and the one to use without internet or when the venue's network blocks direct
phone ↔ computer connections for the website. Requirements: **Node.js 18 or newer** (20/22 recommended) and a modern browser on the host
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

- **Server** (`server/`, bundled to `dist-server/server.mjs`; `npm start` route): Express serves the
  built pages (`/` host, `/play` phone), `GET /api/info`, `GET /api/qr.svg?data=…`, and a WebSocket relay
  at `/ws`. It owns only identity: 4-letter room codes, player ids and reconnect tokens
  (`src/net/hub.ts`). It relays phone input to the host immediately (no batching, no compression).
- **Website route** (static build, `npm run build:static`): there is no server. The host page runs the
  same `src/net/hub.ts` itself (`src/engine/net/rtc/RoomServer.ts`), keeps the room in `sessionStorage` so a
  reload keeps it, hands it to a newer tab over a `BroadcastChannel`, and accepts phones over WebRTC
  (`src/phone/rtcLink.ts` on the phone, `src/net/rtc/` shared). Each phone gets two data channels: a
  reliable one for control messages and an ordered one without retransmits for the 60 Hz input arrays.
- **Transport seam** (`src/net/link.ts`): `HostNet` and the phone's `Net` run the same join / ping /
  reconnect protocol over a `Link` (a WebSocket, or the WebRTC equivalent), so neither the session nor any
  game knows which transport is in use. The build picks it (`VITE_TRANSPORT`); `?net=ws|rtc` overrides.
- QR codes are generated in the browser (`qrcode` package), for both routes.
- **Host** (`src/game`, `src/party`, plus the base game modules): the browser simulation is
  authoritative — physics at a 120 Hz fixed step, AI, items, race logic. `src/game/api.ts`
  (`IGameHost`) is the boundary between the engine and the party layer.
- **Phone** (`src/phone`, `play.html`): a thin, three.js-free (~22 KB gzipped) view that renders
  whatever screen the host says and sends input.

### Protocol (`src/net/protocol.ts`)

All frames are JSON text, over one WebSocket per client or the WebRTC data channels; the messages are
identical on both transports.

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
npm run build       # production build for `npm start` (dist/ + dist-server/)
npm run build:static            # the website (dist-static/, WebRTC, under /Party-games-online-/)
npm run preview:static          # build + serve it locally like GitHub Pages (http://localhost:4173/Party-games-online-/)
npm test            # both Playwright projects (headless Chromium):
npx playwright test --project=ws    #   the `npm start` route (Node server, bot phones + real phone pages)
npx playwright test --project=rtc   #   the website route (static build, real phone pages over WebRTC)
npm run test:live   # join + every game against the DEPLOYED site with the real public services (KP_LIVE_URL=… to point elsewhere);
                    # also runs automatically on GitHub after every deploy (Actions → "Live check")
npm run bots -- --url http://localhost:3000 --n 4   # 4 simulated phones play against a real host
npm run bots -- --url http://localhost:3000 --n 4 --game smash   # ...the Smash Party loop
npx tsx src/games/smash/sim/dev/selftest.ts         # Smash simulation self-test (knockback, all moves, rules)
npx tsx src/games/smash/sim/ai/dev/aiSoak.ts        # CPU-vs-CPU soak (match length, recovery, level ladder)
```

**Website / WebRTC coverage** (`tests/rtc/`, ~5 min): the static build served like GitHub Pages, real phone
pages in separate browser contexts, and **local stand-ins for the signalling services**
(`scripts/signal-standins.mjs`: a real PeerJS server and a minimal Nostr relay that checks signatures), so
no test depends on a public service. Covered: room + in-browser QR + version + project-path links, the
`/play/ABCD` shortcut, two phones joining and readying; Kart (phone steering turns the host kart, ITEM,
results), Smash (sandbox attack, match jump) and Party Rush (one-tap join, mashing moves the runner) from real
touches; phone drop → same seat; host reload → same room, players and seats, phones reconnect on their own;
second tab takes over and the first takes it back; wrong code → "not found"; PeerJS down → joins via Nostr,
Nostr down → joins via PeerJS; no signalling at all → phone "offline" screen and host warning; UDP blocked
(guest-Wi-Fi-like) → phone "connect to the same Wi-Fi" screen.

**Party Rush coverage** (`tests/rush-*.spec.ts`, ~20 min; `npm run test:rush`, `npm run test:motion`): real
phone pages (iPhone + Android portrait) join with one tap, play touch-fallback rounds and get results, and a
sensor flick through the motion injector reaches the host; every one of the 10 minigames with 1 (solo bots),
4 and 16 bot phones (every participant ranked once, points exactly N..1 / ties share / +2 for 1st, board
totals add up, phone result = host row, zero errors); mid-round join plays next round; idle → away with no
penalty and back on tap; hidden tab → away; disconnect/reconnect keeps the score; host reload restores the
scoreboard; 3 minutes of random Space/P/S/R/Esc; a throwing minigame → "Oops — skipping that one!"; the
no-HTTPS notices; 6 players: Kart and Smash seat the first 4 and park 2 ("watching this one"), back to Rush
with all 6; TV screenshots of the scoreboard and every minigame at 4 and 16 players (`docs/screenshots/30-*`,
`31-*`). Headless: `npm run test:rush` runs every minigame × 1–16 players × heat 1–3 with leavers and touch
players; `npm run test:motion` drives the gesture detectors with synthetic iPhone/Android traces (a small
wrist flick registers once, a slow drift / walking / a phone on a table don't).

**Party Rush soak** (`npx tsx scripts/rush-soak.ts --bots 16 --rounds 200`): 16 bot phones, random host
keys, drops/reconnects, hidden tabs, idle phones, leavers replaced by new phones, max-heat changes and host
reloads. Run 1 reached **169 rounds** (85 rounds/h) across heat 1–3 with **zero stuck phases, zero page or
shell errors and every round's points valid**; its one failure (after ~80 distinct phones, a host reload
dropped current players' scores — the snapshot kept the first 64 players ever seen) is fixed. Run 2, 45
rounds, clean. Relay traffic with 16 phones: ~4 KB/s into the host (147 frames/s, largest 188 B), ~14 KB/s
out; largest Rush message 473 B (the biggest frame is the 16-player hub state, 3.7 KB; limit 16 KB).

**Smash Party coverage** (`tests/smash-*.spec.ts`, ~12 min): a deterministic **combat unit test**
(knockback formula vs hand-computed values, then real hits in the simulation at several %: knockback and
launch distance match the formula); hub QR + 4 bots joining once, leader picks Smash, phone layouts swap;
character + stage select; tutorial (advances, mirrored on phones, skip) and the "try it" sandbox (bots hit
the dummy); a stock match to completion (hits, % rising on phones, KOs, GAME!, results); time mode + 2v2;
items spawn and are used (bomb, bat); pause/resume from a phone; disconnect → CPU → reclaim; Smash →
Kart race → Smash with the same players and three rematches without errors or leaks; host at 1366×768 and
3840×2160 and the real phone fighter UI at iPhone/Android landscape sizes. The Smash bot brain
(`scripts/bots.ts`) moves, jumps, attacks, smashes, shields, grabs and recovers, using positions the tests
read from `window.__smash`.

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

**Party Hub**
- The lobby *is* the hub: there is no separate game-picker screen. Kart Party is the default game.
  Picking a game in the lobby switches immediately; picking it on setup/results switches and continues to
  that game's tutorial (first time this session) or setup.
- Both games share one character roster (the 8 Kart Party racers), so a player's pick carries across games.
- The Smash engine loads lazily the first time it's picked (a separate WebGL canvas). If it fails to load,
  a toast says so and the party stays on Kart Party. The kart engine is suspended (no rendering/audio)
  while Smash is active, and vice versa.
- The tutorial auto-plays the first time **each** game is started; the Smash "try it" sandbox runs once
  per session after it (even if the tutorial was skipped). The sandbox ends when the leader presses START,
  everyone taps *I'm ready* (+1.2 s), or the host presses Esc. Disconnected players count as ready.
- Smash tutorial steps are 4.5 s (the first one 7 s); Kart's stay 6 × 3.8 s.
- After a match the leader gets **Rematch / Change Settings / Switch Game / Lobby**; for Smash "Next" = Rematch.
- A leader START pressed while a game engine is still loading is queued, not dropped.
- Phones create their reconnect token before the first join, so a dropped first connection never leaves
  a ghost "Player N (disconnected)" seat.

**Smash Party**
- CPU fill sets the *total* number of fighters (2–4); a lone human always gets at least one CPU opponent.
  CPUs use characters nobody picked. In team mode CPUs join the smaller team.
- Setup values from the phone are clamped (e.g. stocks 1–5, time 60–300 s rounded to 30 s, CPU level 1–9),
  never rejected. The training stage can't be picked for matches.
- A disconnected player's fighter is played by a level-5 CPU until the phone comes back.
- KO credit goes to the last attacker within 5 s **or for as long as the victim is still tumbling** from
  that hit; otherwise it's a self-destruct (−1 in time mode, nobody gets +1). "Falls" counts every lost stock.
- Mashing while grabbed only makes the grabber throw sooner (no mash-out); those presses are discarded so
  they don't fire a move after release.
- The bat breaks after 4 swings; final blasts deal ~33–40 % and only launch hard on the last hit — fun,
  not a guaranteed KO. The Party Orb is rare (~5 % of spawns, one at a time).
- Announcer lines ("3, 2, 1, GO!", "GAME!") use the browser's built-in speech synthesis when available,
  always backed by synth stingers (no voice samples).
- Default setup: Skyline Summit, 3 stocks, items on (medium), hazards on, no CPUs, FFA.

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

**Party Hub / Smash Party**
- Smash Party has no grab mash-out, no teching, no attack clanking and no stale-move decay.
  Pixel Pop and Big Rig Rosa have rougher, less-tuned kits than the other six fighters.
- Up-specials have generous reach, so recovering is easy (party-friendly, but less edge-guarding drama).
  Level-9 projectile CPUs can feel spammy.
- Fighter name tags overlap when fighters stand on top of each other; sideways limb motions read weakly from
  the camera angle; the Neon Arena's underside is plain.
- Headless test machines render Smash at only ~3–6 fps (software GPU); real laptops should hold 60 fps, but
  if it stutters add `?quality=1` (or `0`) to the host URL.
- The two games use separate WebGL contexts and AudioContexts (only the active one runs).

**Kart Party / general**

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
- Phones and host must reach each other directly (same Wi-Fi). Networks with client isolation (many
  guest/hotel Wi-Fi) block that on both routes — use the main network or a phone/laptop hotspot. On the
  website, phones on mobile data *may* connect through STUN, but often can't without a TURN server.
- Only one host screen per room; opening the game in a second tab takes over the room (the first
  tab shows "open in another tab").
- **Website vs `npm start` differences**: on the website a room lives in the host tab, so if that tab is
  *closed* (not reloaded) the room is gone (the Node server keeps it 30 minutes); a host reload or a tab
  takeover makes phones reconnect for a few seconds (with the server they stay connected); joining needs
  internet for the signalling service (playing doesn't); a wrong room code takes ~25 s to report
  "not found" (two attempts, so a slow signalling service isn't mistaken for a wrong code; the server
  answers at once).
- The public signalling services (0.peerjs.com, Nostr relays) are free community services with no uptime
  promise; that's why two are used. If both are down, use the local route.
- Split-screen renders a shadow pass per view; on weak GPUs the scaler turns shadows off.
- Tutorial sound effects on the host only play after someone has clicked/pressed a key on the
  host page once (browser autoplay rules).
- Fonts are system fonts (Impact etc.) — no web fonts, so the look varies slightly per OS.
- No online play and no battle mode (out of scope).

### Party Rush — known limitations

- **Motion feel is tuned against synthetic sensor traces and bots, not real phones yet.** Thresholds live in
  `src/phone/motion/tuning.ts` and `src/games/rush/tuning.ts`; expect to adjust them after the first party.
- **Motion needs HTTPS** (`npm run start:https`, self-signed certificate). Over plain HTTP every phone uses
  the touch fallback (a slightly worse experience; marked 👆 on the TV).
- iOS asks for motion permission on every page load (the join tap does it); iOS has no vibration, so cues are
  flash + sound there.
- Aim (Darts) integrates the gyro and slowly drifts; it re-centres on every dart and on a double tap.
- Tilt Maze layouts are generated per round (always solvable, length-checked) rather than hand-made.
- Darts at 16 players gets crowded around the bull (everyone aims there).
- Kart Party and Smash Party still seat 4 per match (the first 4 by join order); the others watch.
- Characters stay unique only for the first 8 players (the Kart/Smash roster has 8).
- Headings use the system font (no web fonts): punchier on Windows/macOS than on Linux.
- Pre-existing, Kart: rarely, three.js's parallel shader warm-up (`Game.warmShaders` → `compileAsync`) throws
  an uncaught error if a session is torn down mid-compile (seen once in a full suite run, passes on re-run).

## Credits & licenses

Kart Party is MIT-licensed (see `LICENSE`). It is built on two MIT-licensed projects by BridgeMind,
whose license texts are kept in `licenses/`:

- **[turbo-kart-rush](https://github.com/bridge-mind/turbo-kart-rush)** (commit `6c0456c`) — the base
  game: Three.js/TypeScript engine, 8 racers, 4 tracks, items, AI, drift/mini-turbo, procedural
  audio, architecture contract. Its original README is in `docs/BASE_README_turbo-kart-rush.md`.
- **[turbo-kart-rally](https://github.com/bridge-mind/turbo-kart-rally)** (commit `c52aca3`) — ideas
  and logic ported to TypeScript: rocket start, ramp trick boosts, intro flyover, live demo race
  behind the title, `window.__game` debug hooks.

**Smash Party** is original code written for this repo (simulation, CPU AI, fighters, stages, audio).
The Smash-style knockback formula is a general game-design formula; hitbox/hurtbox/knockback design
ideas were informed by reading [mega-mash-bros](https://github.com/kkysen/mega-mash-bros) (Apache-2.0) —
no code was copied from it or from any GPL/unlicensed project. No Nintendo names, characters, sprites,
sounds or stage likenesses are used.
