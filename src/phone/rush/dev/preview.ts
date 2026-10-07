/**
 * DEV ONLY — mounts the Party Rush phone layout with a fake RushPhoneMsg built from the URL, no host needed.
 *   npx vite → http://localhost:5178/src/phone/rush/dev/preview.html?ph=play&s=shake&word=SHAKE!&touch=1
 * Params: ph, st (new|play|next|away), s (stream|''), ev (comma list), word, name, instr, demo, touchline,
 *   cd, left, round, pts, rank, lead=1, next=1 (canNext), cue (bomb|pose|fish|word), v, fx, cueword, bg,
 *   place, gained, line, sip, safe=1, touch=1 (touch fallback), tapped=0 (show TAP TO PLAY), emoji, color,
 *   pname, team, menu=1 (open the corner menu).
 */
import '../../phone.css';
import type { RushCue, RushDemo, RushEvent, RushPhase, RushPhoneMsg, RushStream } from '../../../net/protocol';
import { setState } from '../../store';
import { RushView } from '../RushView';
import { rush } from '../runtime';

const q = new URLSearchParams(location.search);
const str = (k: string, d = ''): string => q.get(k) ?? d;
const num = (k: string, d: number): number => (q.get(k) !== null ? Number(q.get(k)) : d);

const cueKind = str('cue');
let cue: RushCue | null = null;
if (cueKind) {
  cue = { id: num('cueid', 1), fx: (str('fx', 'none') as RushCue['fx']) };
  if (cueKind === 'bomb' || cueKind === 'pose' || cueKind === 'fish') cue.show = cueKind;
  if (q.get('v') !== null) cue.v = num('v', 0);
  if (q.get('cueword')) cue.word = str('cueword');
  if (q.get('bg')) cue.bg = str('bg');
}

const msg: RushPhoneMsg = {
  t: 'mg',
  ph: str('ph', 'lobby') as RushPhase,
  rid: num('rid', 3),
  round: num('round', 4),
  heat: 1,
  g: str('g', 'shake-race'),
  name: str('name', 'Shake Race'),
  instr: str('instr', 'Shake to run!'),
  demo: str('demo', 'shake') as RushDemo,
  word: str('word', 'SHAKE!'),
  s: (str('s', 'shake') || null) as RushStream | null,
  ev: (str('ev') ? str('ev').split(',') : []) as RushEvent[],
  touch: str('touchline', 'Mash the button!'),
  cd: num('cd', 3),
  left: num('left', 12),
  me: {
    st: str('st', 'play') as RushPhoneMsg['me']['st'],
    name: str('pname', 'Wobbly Waffle'),
    emoji: str('emoji', '🦊'),
    color: str('color', '#3d8bff'),
    pts: num('pts', 12),
    rank: num('rank', 2),
    lead: q.get('lead') === '1',
    ...(q.get('team') !== null ? { team: num('team', 0) } : {}),
  },
  cue,
  res: q.get('place') !== null ? { place: num('place', 1), pts: num('gained', 6), line: str('line') } : null,
  safe: q.get('safe') === '1',
  canNext: q.get('next') !== '0',
  sip: str('sip'),
};

rush.tapped = q.get('tapped') !== '0';
rush.motionOk = q.get('touch') !== '1';
setState({ joined: true, room: 'ABCD', rush: msg, rushAt: performance.now() });

const root = document.getElementById('phone-app')!;
const view = new RushView();
root.append(view.el);
view.update('race');
if (q.get('menu') === '1') (view.el.querySelector('[data-testid="rush-menu-btn"]') as HTMLButtonElement)?.click();
setInterval(() => view.update('race'), 250);
(window as unknown as { __preview: { ready: boolean } }).__preview = { ready: true };
