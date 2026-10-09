# Contributing / working on Party Hub

## Branches

- **`main`** is always releasable. Every push to it rebuilds and redeploys the website
  (<https://marzoman5.github.io/Party-games-online-/>). Nobody pushes to it directly: changes arrive by
  pull request.
- Work happens on **short-lived branches** cut from the latest `main`, one topic each:
  - `feat/<topic>`: new features and new games (`feat/bowling`, `feat/turn-server-setting`)
  - `fix/<topic>`: bug fixes (`fix/rush-darts-aim`)
  - `chore/<topic>` / `docs/<topic>`: tooling, dependencies, docs
- Open a pull request into `main`. CI (`.github/workflows/ci.yml`) runs typecheck, both builds, the unit
  self-tests and the two Playwright projects (`ws` = `npm start` route, `rtc` = website route). Merge when
  it's green, then delete the branch.

```bash
git checkout main && git pull
git checkout -b feat/my-thing
# … work, commit …
npm run typecheck && npm run build && npm run build:static
npx playwright test --project=rtc          # quick (~5 min); the full `npm test` takes ~1 h on one worker
git push -u origin feat/my-thing           # then open the PR on GitHub
```

## Versions and releases

Versions are `vMAJOR.MINOR.PATCH` git tags, matching `"version"` in `package.json`:

- **MINOR** (`1.1.0`): new features or games.
- **PATCH** (`1.0.1`): fixes only.
- **MAJOR** (`2.0.0`): breaking changes, e.g. a `PROTOCOL_VERSION` bump in `src/net/protocol.ts`
  (old phones/hosts can't talk to new ones).

Every PR that changes behaviour adds a line under **Unreleased** in `CHANGELOG.md`.

To release:

1. PR: `npm version 1.1.0 --no-git-tag-version` (updates `package.json` + lock), and in `CHANGELOG.md` rename
   *Unreleased* to `## [1.1.0] - YYYY-MM-DD` (start a fresh empty *Unreleased* above it). Merge.
2. Tag and publish, either way:
   - on GitHub (works from a phone too): **Actions → Release → Run workflow**, version `1.1.0`. It tags the
     tip of `main`;
   - or from a terminal: `git fetch origin && git tag v1.1.0 origin/main && git push origin v1.1.0`.
3. `.github/workflows/release.yml` publishes the GitHub Release with that CHANGELOG section as notes
   (it refuses if `package.json` or the CHANGELOG don't match the version). The
   website already deployed from the merge. The version appears small on the host title screen and on the
   phone's room-code screen.

## Where things live

- Adding a game: README → *How to add a game*. Adding a Party Rush minigame: README → *Adding an 11th
  minigame*.
- Networking: `src/net/protocol.ts` (wire contract; games only see this), `src/net/hub.ts` (rooms, tokens,
  routing; runs in the Node server *and* in the website's host page), `src/net/link.ts` (transport seam),
  `src/net/rtc/` (WebRTC + signalling + config), `src/engine/net/` (host side), `src/phone/net.ts` +
  `src/phone/rtcLink.ts` (phone side).
- Website settings (STUN/TURN, signalling servers): `src/net/rtc/config.ts`, or repository variables
  `ICE_SERVERS`, `PEERJS`, `NOSTR` (Settings → Secrets and variables → Actions → Variables) picked up by
  `.github/workflows/deploy.yml`.
- Tests never use the public signalling services: `scripts/signal-standins.mjs` runs local stand-ins.
