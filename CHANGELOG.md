# Changelog

All notable changes to Party Hub. Versions follow `MAJOR.MINOR.PATCH` (see `CONTRIBUTING.md`):
minor for new features or games, patch for fixes.

## [Unreleased]

## [1.0.0] - 2026-10-08

First release: Party Hub as a free website. Open <https://marzoman5.github.io/Party-games-online-/> on the
computer connected to the TV and scan the QR code with phones — nothing to install, no laptop to carry.

### Games
- **Kart Party**: arcade kart racer, 8 karts, 4 tracks, items, drifting, Grand Prix, up to 4-way split-screen.
- **Smash Party**: original 2.5D platform fighter, 8 fighters, 3 stages, items, CPU fighters, stock/time, 2v2.
- **Party Rush**: endless drop-in stream of 10 motion minigames for 1–16 players.
- Party Hub: one lobby for everyone, leader picks and switches games without anyone rejoining.

### Website hosting (new)
- The host page is the server: room codes, player ids, reconnect tokens and message routing run in the
  host's browser (the same code as the Node server), and phones connect to it **directly over WebRTC**
  for low latency.
- Free signalling with a fallback: the public PeerJS server, plus public Nostr relays (encrypted with the
  room code) so one outage doesn't stop people joining. Free public STUN by default; TURN optional and
  configurable (`src/net/rtc/config.ts` or repository variables).
- Same behaviour as the server: a dropped phone gets its seat back, reloading the host page keeps the
  room and its players, a second host tab takes the room over.
- Phones explain connection problems instead of spinning: blocked direct connection ("join the same
  Wi-Fi as the computer"), no signalling service ("you seem to be offline"), unknown room code.
- Motion controls work on the website without any certificate step (it's HTTPS).
- QR codes are generated in the browser; links work under the GitHub Pages project path, including the
  typed shortcut `…/play/ABCD`.
- Version shown on the title screen and the phone's room-code screen.

### Local / offline
- `npm start` (Node server, WebSocket relay) works exactly as before for offline parties.

### Project
- `main` branch, pull-request CI (typecheck, builds, self-tests, Playwright for both transports),
  automatic GitHub Pages deploy from `main`, GitHub Releases from version tags, `CONTRIBUTING.md`.
- WebRTC end-to-end suite with local signalling stand-ins (no test depends on a public service).
- Live check after every deploy (`.github/workflows/live-check.yml`, also `npm run test:live`): joins and
  plays every game on the deployed site through the real public signalling services.
- Fixed two pre-existing test problems: the Party Rush phone test counted Darts throws as flicks (Darts
  throws on a tap since the last gameplay pass), and the Android phone-UI drift check could fail when its
  single drift press landed just below drift speed.
