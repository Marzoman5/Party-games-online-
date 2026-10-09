/**
 * Phone side of the WebRTC transport (static site): a `Link` that is a direct data channel to the
 * host page of room `room`. Net (./net.ts) runs the normal join/ping/reconnect protocol over it.
 *
 * One attempt = one RTCPeerConnection: wait for a signalling service, send an offer to the room's
 * host id through every reachable one, wait for the answer, wait for ICE. Each way it can fail closes
 * the link with a code Net turns into a plain-language screen instead of spinning forever.
 */
import type { Link, LinkClose } from '../net/link';
import { hostPeerId, rtcConfig } from '../net/rtc/config';
import { NostrSignal } from '../net/rtc/nostrSignal';
import { RtcPeer } from '../net/rtc/peer';
import { PeerJsSignal } from '../net/rtc/peerjsSignal';
import { randomId, type SignalMsg, type Signaller } from '../net/rtc/signal';

/** No direct route to the host (ICE failed): guest Wi-Fi isolation, some mobile carriers… */
export const RTC_CLOSE_NO_DIRECT = 4100;
/** No signalling service reachable (phone offline, or every service down). */
export const RTC_CLOSE_NO_SIGNAL = 4101;
/** Nobody answered for this room code (wrong code, or the host page is closed/reloading). */
export const RTC_CLOSE_NO_ROOM = 4102;

/** How long to wait for any signalling service. */
const SIGNAL_WAIT_MS = 10_000;
/** Offer sent, no answer: no such room (the PeerJS server holds offers ~5 s for a reloading host). */
const ANSWER_WAIT_MS = 12_000;
/** Answer received, data channel not open yet: the direct connection is blocked. */
const ICE_WAIT_MS = 15_000;

export const MSG_NO_DIRECT =
  "Your phone couldn't connect directly to the game screen. This happens on guest Wi-Fi and some mobile networks. Connect this phone to the same Wi-Fi as the computer showing the game, then tap Try again.";
export const MSG_NO_SIGNAL =
  "Can't reach the joining service. Check that this phone is online (Wi-Fi or mobile data), then tap Try again.";

/** This page's signalling identity + services, kept across reconnect attempts. */
let shared: { room: string; id: string; signals: Signaller[] } | null = null;
/** Open link attempts listening for signalling messages (each filters on its own cid). */
const listeners = new Set<(from: string, m: SignalMsg) => void>();

function signalsFor(room: string): { id: string; signals: Signaller[] } {
  if (shared && shared.room === room) return shared;
  for (const s of shared?.signals ?? []) s.close();
  const cfg = rtcConfig();
  const id = `ph-${randomId()}`;
  const signals: Signaller[] = [];
  if (cfg.peerjs.length) signals.push(new PeerJsSignal(cfg.peerjs, id, randomId()));
  if (cfg.nostr.length) signals.push(new NostrSignal(cfg.nostr, id, room));
  for (const s of signals) {
    s.onmessage = (from, m) => {
      for (const l of [...listeners]) l(from, m);
    };
    s.start();
  }
  shared = { room, id, signals };
  return shared;
}

/** Debug info for tests / the phone debug hooks. */
export function rtcSignalStatus(): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const s of shared?.signals ?? []) out[s.name] = s.up;
  return out;
}

export function openRtcLink(room: string): Link {
  const cfg = rtcConfig();
  const { signals } = signalsFor(room);
  const hostId = hostPeerId(room);
  const peer = new RtcPeer(randomId(), cfg.iceServers);
  let done = false;
  let answered = false;
  let timer = 0;
  let poll = 0;
  let replay = 0;
  /** Offer + candidates sent so far, and the services they went through. */
  const sent: SignalMsg[] = [];
  const reached = new Set<Signaller>();

  const link: Link = {
    get isOpen() {
      return !done && peer.isOpen;
    },
    send: (data) => peer.send(data),
    close() {
      if (done) return;
      done = true;
      cleanup();
      peer.close();
    },
    onopen: null,
    onmessage: null,
    onclose: null,
  };

  const cleanup = (): void => {
    window.clearTimeout(timer);
    window.clearInterval(poll);
    window.clearInterval(replay);
    listeners.delete(onSignal);
  };

  const fail = (ev: LinkClose): void => {
    if (done) return;
    done = true;
    cleanup();
    peer.close();
    link.onclose?.(ev);
  };

  const sendAll = (m: SignalMsg): void => {
    if (sent.length < 64) sent.push(m);
    for (const s of signals) {
      if (!s.up) continue;
      s.send(hostId, m);
      reached.add(s);
    }
  };

  /**
   * A service that comes up (or back) while we wait for the answer gets everything sent so far: the
   * host may be reachable only through it right now. The host ignores duplicates (same cid).
   */
  const replayToNewServices = (): void => {
    if (done || answered) {
      window.clearInterval(replay);
      return;
    }
    for (const s of signals) {
      if (!s.up) {
        reached.delete(s);
        continue;
      }
      if (reached.has(s)) continue;
      reached.add(s);
      for (const m of sent) s.send(hostId, m);
    }
  };

  const onSignal = (from: string, m: SignalMsg): void => {
    if (done || from !== hostId || m.cid !== peer.cid) return;
    if (m.kind === 'answer' && m.sdp) {
      answered = true;
      peer
        .acceptAnswer(m.sdp)
        .then((first) => {
          if (!first || done) return;
          window.clearTimeout(timer);
          timer = window.setTimeout(() => fail({ code: RTC_CLOSE_NO_DIRECT, reason: MSG_NO_DIRECT }), ICE_WAIT_MS);
        })
        .catch(() => fail({ code: RTC_CLOSE_NO_DIRECT, reason: MSG_NO_DIRECT }));
    } else if (m.kind === 'candidate') {
      peer.addCandidate(m.cand);
    }
  };

  peer.onsignal = sendAll;
  peer.onopen = () => {
    if (done) return;
    window.clearTimeout(timer);
    link.onopen?.();
  };
  peer.onmessage = (data) => {
    if (!done) link.onmessage?.(data);
  };
  peer.onend = (why) => {
    if (done) return;
    // ICE gave up before the channel ever opened: no direct route. After it was open: a normal drop.
    if (!peer.wasOpened && why === 'failed') fail({ code: RTC_CLOSE_NO_DIRECT, reason: MSG_NO_DIRECT });
    else fail({ code: 1006, reason: 'connection lost' });
  };
  listeners.add(onSignal);

  const begin = (): void => {
    if (done) return;
    timer = window.setTimeout(() => fail({ code: RTC_CLOSE_NO_ROOM, reason: 'no answer' }), ANSWER_WAIT_MS);
    replay = window.setInterval(replayToNewServices, 250);
    peer.makeOffer().catch(() => fail({ code: RTC_CLOSE_NO_DIRECT, reason: MSG_NO_DIRECT }));
  };

  // Wait (briefly) for at least one signalling service.
  if (signals.some((s) => s.up)) {
    window.setTimeout(begin, 0);
  } else if (signals.length === 0) {
    window.setTimeout(() => fail({ code: RTC_CLOSE_NO_SIGNAL, reason: MSG_NO_SIGNAL }), 0);
  } else {
    const t0 = performance.now();
    poll = window.setInterval(() => {
      if (done) return;
      if (signals.some((s) => s.up)) {
        window.clearInterval(poll);
        begin();
      } else if (performance.now() - t0 > SIGNAL_WAIT_MS) {
        fail({ code: RTC_CLOSE_NO_SIGNAL, reason: MSG_NO_SIGNAL });
      }
    }, 100);
  }
  return link;
}
