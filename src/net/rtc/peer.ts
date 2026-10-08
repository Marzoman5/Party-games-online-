/**
 * One phone <-> host WebRTC connection with two pre-negotiated data channels:
 *   - `ctl` (id 0): reliable + ordered. Every JSON control message (join, state, menus…).
 *   - `in`  (id 1): ordered but unreliable (no retransmits). The ~60 Hz input packets (JSON arrays):
 *     a lost packet is superseded 16 ms later (packets carry absolute stick state and press counters),
 *     so retransmitting it would only add lag behind it.
 * The phone makes the offer; the host answers. Candidates trickle through the signaller.
 */
import type { SignalMsg } from './signal';

export type PeerEnd = 'closed' | 'failed';

export class RtcPeer {
  readonly pc: RTCPeerConnection;
  private readonly ctl: RTCDataChannel;
  private readonly inp: RTCDataChannel;
  private pending: RTCIceCandidateInit[] = [];
  private haveRemote = false;
  private answered = false;
  private opened = false;
  private ended = false;
  private discTimer = 0;
  onopen: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  onend: ((why: PeerEnd) => void) | null = null;
  /** Local offer/answer/candidates to deliver to the other side. */
  onsignal: ((m: SignalMsg) => void) | null = null;

  constructor(
    readonly cid: string,
    iceServers: RTCIceServer[],
  ) {
    this.pc = new RTCPeerConnection({ iceServers });
    this.ctl = this.pc.createDataChannel('ctl', { negotiated: true, id: 0, ordered: true });
    this.inp = this.pc.createDataChannel('in', { negotiated: true, id: 1, ordered: true, maxRetransmits: 0 });
    for (const ch of [this.ctl, this.inp]) {
      ch.onmessage = (ev) => {
        if (typeof ev.data === 'string') this.onmessage?.(ev.data);
      };
    }
    this.ctl.onopen = () => {
      if (this.ended || this.opened) return;
      this.opened = true;
      this.onopen?.();
    };
    this.ctl.onclose = () => this.end('closed');
    this.pc.onicecandidate = (ev) => {
      this.onsignal?.({ kind: 'candidate', cid: this.cid, cand: ev.candidate ? ev.candidate.toJSON() : null });
    };
    this.pc.onconnectionstatechange = () => {
      const st = this.pc.connectionState;
      window.clearTimeout(this.discTimer);
      if (st === 'failed') this.end('failed');
      else if (st === 'closed') this.end('closed');
      // 'disconnected' often recovers by itself (Wi-Fi blip); give it a moment.
      else if (st === 'disconnected') this.discTimer = window.setTimeout(() => this.end('closed'), 6000);
    };
  }

  get isOpen(): boolean {
    return !this.ended && this.ctl.readyState === 'open';
  }

  get wasOpened(): boolean {
    return this.opened;
  }

  /** Phone side. */
  async makeOffer(): Promise<void> {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.onsignal?.({ kind: 'offer', cid: this.cid, sdp: this.pc.localDescription?.sdp ?? offer.sdp });
  }

  /** Host side. */
  async acceptOffer(sdp: string): Promise<void> {
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    this.remoteReady();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.onsignal?.({ kind: 'answer', cid: this.cid, sdp: this.pc.localDescription?.sdp ?? answer.sdp });
  }

  /** Phone side. Returns false for a duplicate (the answer can arrive through several signallers). */
  async acceptAnswer(sdp: string): Promise<boolean> {
    if (this.answered || this.pc.signalingState !== 'have-local-offer') return false;
    this.answered = true;
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
    this.remoteReady();
    return true;
  }

  addCandidate(c: RTCIceCandidateInit | null | undefined): void {
    if (!c || !c.candidate) return; // end-of-candidates marker
    if (!this.haveRemote) {
      this.pending.push(c);
      return;
    }
    this.pc.addIceCandidate(c).catch(() => {
      /* duplicate via another signaller, or stale */
    });
  }

  send(data: string): void {
    // Input packets (JSON arrays) take the unreliable channel once it is up.
    const ch = data.charCodeAt(0) === 91 /* [ */ && this.inp.readyState === 'open' ? this.inp : this.ctl;
    if (ch.readyState !== 'open') return;
    try {
      ch.send(data);
    } catch {
      /* closing */
    }
  }

  /** Bytes queued on the control channel (wait for 0 before closing after a final message). */
  get buffered(): number {
    return this.ctl.readyState === 'open' ? this.ctl.bufferedAmount : 0;
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    window.clearTimeout(this.discTimer);
    this.detach();
    try {
      this.pc.close();
    } catch {
      /* ignore */
    }
  }

  private remoteReady(): void {
    this.haveRemote = true;
    const q = this.pending;
    this.pending = [];
    for (const c of q) this.addCandidate(c);
  }

  private end(why: PeerEnd): void {
    if (this.ended) return;
    const cb = this.onend;
    this.close();
    cb?.(why);
  }

  private detach(): void {
    this.ctl.onopen = this.ctl.onclose = this.ctl.onmessage = null;
    this.inp.onmessage = null;
    this.pc.onicecandidate = this.pc.onconnectionstatechange = null;
  }
}
