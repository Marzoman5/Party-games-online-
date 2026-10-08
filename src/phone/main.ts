/**
 * Party Hub — phone controller entry (play.html, served at /play?room=ABCD).
 * Plain TS + DOM; must never import three.js (keep imports to net/, kart/roster,
 * track/tracks/<def>.ts, games/smash/{roster,stages,types}.ts and src/phone/**).
 */
import './phone.css';
import './fighter.css';
import { App } from './app';
import { controls } from './controls';
import { fightControls } from './fightControls';
import { net, normalizeRoom } from './net';
import { settings, setSetting, type PhoneSettings } from './settings';
import { activeGame, currentView, state } from './store';
import { tilt } from './tilt';
import { motion, type RawMotion } from './motion/index';
import type { RushEvent } from '../net/protocol';
import { noteInjected, rush, touchMode } from './rush/runtime';

const root = document.getElementById('phone-app') ?? document.body.appendChild(document.createElement('div'));
const app = new App(root);

declare global {
  interface Window {
    __phone?: {
      getState(): unknown;
      setSetting(k: string, v: unknown): void;
      /** PARTY RUSH: drive the motion API without sensors (tests / bots). */
      motion: {
        inject(raw: Partial<RawMotion>): void;
        gesture(k: RushEvent, v?: number, x?: number, y?: number): void;
        state(): unknown;
      };
    };
  }
}

window.__phone = {
  getState() {
    return {
      connected: state.joined,
      conn: state.conn,
      playerId: state.playerId,
      room: state.room,
      screen: state.phone?.screen ?? null,
      view: currentView(),
      hostConnected: state.hostConnected,
      rtt: state.rtt,
      error: state.error,
      you: state.phone?.you ?? null,
      race: state.race,
      lastInput: { ...controls.lastInput },
      sending: controls.isActive || fightControls.isActive,
      // PARTY HUB
      game: activeGame(),
      layout: app.layoutId,
      fight: state.fight,
      lastFightInput: { ...fightControls.lastFightInput },
      fightSending: fightControls.isActive,
      fightPackets: fightControls.sent,
      tilt: { active: tilt.active, raw: tilt.raw, offset: tilt.offset },
      settings: { ...settings },
      // PARTY RUSH
      rush: state.rush,
      rushTouch: touchMode(),
      rushTapped: rush.tapped,
      rushSent: { stream: rush.sent.stream, act: rush.sent.act, here: rush.sent.here, away: rush.sent.away, mode: rush.sent.mode, next: rush.sent.next, events: { ...rush.sent.events } },
    };
  },
  motion: {
    inject(raw: Partial<RawMotion>) {
      motion.inject(raw);
      noteInjected();
    },
    gesture(k: RushEvent, v?: number, x?: number, y?: number) {
      motion.injectGesture(k, v, x, y);
      noteInjected();
    },
    state() {
      return {
        supported: motion.supported,
        enabled: motion.enabled,
        hasData: motion.hasData,
        sample: motion.sample(),
        motionOk: rush.motionOk,
        manualTouch: rush.manualTouch,
        touch: touchMode(),
        // Full pipeline debug (processor internals) for diagnosing real phones.
        raw: (motion as unknown as { state?: () => unknown }).state?.() ?? null,
      };
    },
  },
  setSetting(k: string, v: unknown) {
    setSetting(k as keyof PhoneSettings, v as never);
    app.render();
  },
};

const room = normalizeRoom(new URLSearchParams(location.search).get('room') ?? '');
if (room.length === 4) net.connect(room);
else app.render();
