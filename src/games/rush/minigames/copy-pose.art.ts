/**
 * Copy the Pose (MG3) — procedural pose pictures: a big cartoon phone in one of the 6 gravity poses
 * (RUSH_POSES) with a reference (table / hand / floor), a ghost of the "normal" grip and a fat arrow,
 * so "face up" vs "face down" and "left" vs "right" are unmistakable from across the room.
 */
import { drawText, roundRect } from '../draw';

/** Big label under the picture (TV). */
export const POSE_LABELS = ['SCREEN UP', 'SCREEN DOWN', 'STAND IT UP', 'UPSIDE DOWN', 'LEFT SIDE DOWN', 'RIGHT SIDE DOWN'] as const;
/** Giant word on the phone. */
export const POSE_WORDS = ['FACE UP', 'FACE DOWN', 'UPRIGHT', 'FLIP IT!', 'LEFT SIDE', 'RIGHT SIDE'] as const;

const INK = '#1a1033';
const SKIN = '#f3c79b';
const SKIN_DARK = '#c98f5f';
const ARROW = '#ff3ab8';

/** Phone front (screen with a smiley + notch), centred, portrait, w×h. */
function phoneFront(g: CanvasRenderingContext2D, w: number, h: number, alpha = 1, ghost = false): void {
  g.save();
  g.globalAlpha *= alpha;
  if (ghost) {
    g.setLineDash([18, 14]);
    g.lineWidth = 8;
    g.strokeStyle = 'rgba(40,20,80,0.55)';
    roundRect(g, -w / 2, -h / 2, w, h, w * 0.16);
    g.stroke();
    g.restore();
    return;
  }
  g.fillStyle = INK;
  roundRect(g, -w / 2, -h / 2, w, h, w * 0.16);
  g.fill();
  const m = w * 0.07;
  const sg = g.createLinearGradient(0, -h / 2, 0, h / 2);
  sg.addColorStop(0, '#6fd3ff');
  sg.addColorStop(1, '#b77bff');
  g.fillStyle = sg;
  roundRect(g, -w / 2 + m, -h / 2 + m, w - 2 * m, h - 2 * m, w * 0.1);
  g.fill();
  // notch (top)
  g.fillStyle = INK;
  roundRect(g, -w * 0.18, -h / 2 + m - 2, w * 0.36, h * 0.05, h * 0.025);
  g.fill();
  // smiley (shows which way is up)
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(-w * 0.15, -h * 0.12, w * 0.07, 0, Math.PI * 2);
  g.arc(w * 0.15, -h * 0.12, w * 0.07, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#ffffff';
  g.lineWidth = w * 0.06;
  g.lineCap = 'round';
  g.beginPath();
  g.arc(0, h * 0.02, w * 0.24, 0.15 * Math.PI, 0.85 * Math.PI);
  g.stroke();
  // big "top" bar on the top edge
  g.fillStyle = '#ffd23a';
  roundRect(g, -w * 0.3, -h / 2 - h * 0.035, w * 0.6, h * 0.05, h * 0.02);
  g.fill();
  g.restore();
}

/** Fat arrow from (x0,y0) to (x1,y1). */
function arrow(g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, color = ARROW, wdt = 26): void {
  const a = Math.atan2(y1 - y0, x1 - x0);
  const len = Math.hypot(x1 - x0, y1 - y0);
  g.save();
  g.translate(x0, y0);
  g.rotate(a);
  g.fillStyle = color;
  g.strokeStyle = '#ffffff';
  g.lineWidth = 6;
  g.beginPath();
  g.moveTo(0, -wdt / 2);
  g.lineTo(len - wdt * 1.8, -wdt / 2);
  g.lineTo(len - wdt * 1.8, -wdt * 1.4);
  g.lineTo(len, 0);
  g.lineTo(len - wdt * 1.8, wdt * 1.4);
  g.lineTo(len - wdt * 1.8, wdt / 2);
  g.lineTo(0, wdt / 2);
  g.closePath();
  g.stroke();
  g.fill();
  g.restore();
}

/** Curved rotation arrow around (cx,cy) from angle a0 to a1 (radians, canvas coords). */
function curvedArrow(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, a0: number, a1: number): void {
  g.save();
  g.strokeStyle = '#ffffff';
  g.lineCap = 'round';
  g.lineWidth = 34;
  g.beginPath();
  g.arc(cx, cy, r, a0, a1, a1 < a0);
  g.stroke();
  g.strokeStyle = ARROW;
  g.lineWidth = 22;
  g.stroke();
  // head
  const dir = a1 < a0 ? -1 : 1;
  const hx = cx + Math.cos(a1) * r;
  const hy = cy + Math.sin(a1) * r;
  const tang = a1 + (dir * Math.PI) / 2;
  g.translate(hx, hy);
  g.rotate(tang);
  g.fillStyle = ARROW;
  g.strokeStyle = '#ffffff';
  g.lineWidth = 6;
  g.beginPath();
  g.moveTo(34, 0);
  g.lineTo(-18, -36);
  g.lineTo(-18, 36);
  g.closePath();
  g.stroke();
  g.fill();
  g.restore();
}

/** A cartoon hand cupping from below (palm + fingers + thumb), centred at the palm top. */
function hand(g: CanvasRenderingContext2D, w: number): void {
  g.save();
  g.fillStyle = SKIN;
  g.strokeStyle = SKIN_DARK;
  g.lineWidth = 6;
  // wrist
  roundRect(g, -w * 0.22, w * 0.25, w * 0.44, w * 0.5, w * 0.1);
  g.fill();
  g.stroke();
  // palm
  g.beginPath();
  g.ellipse(0, w * 0.18, w * 0.42, w * 0.26, 0, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  // fingers wrapping the front (left side)
  for (let i = 0; i < 3; i++) {
    roundRect(g, -w * 0.5 - i * 0, -w * 0.08 + i * w * 0.13, w * 0.36, w * 0.13, w * 0.065);
    g.fill();
    g.stroke();
  }
  // thumb (right side)
  roundRect(g, w * 0.18, -w * 0.12, w * 0.32, w * 0.14, w * 0.07);
  g.fill();
  g.stroke();
  g.restore();
}

/** Flat phone on a table in perspective; `up` = screen up (else the back is up). */
function tablePhone(g: CanvasRenderingContext2D, up: boolean, t: number): void {
  // table
  g.save();
  g.fillStyle = '#8a5a2b';
  g.beginPath();
  g.moveTo(-270, 40);
  g.lineTo(270, 40);
  g.lineTo(220, -60);
  g.lineTo(-220, -60);
  g.closePath();
  g.fill();
  g.fillStyle = '#b97b3d';
  g.beginPath();
  g.moveTo(-262, 34);
  g.lineTo(262, 34);
  g.lineTo(216, -56);
  g.lineTo(-216, -56);
  g.closePath();
  g.fill();
  g.fillStyle = '#6b4220';
  g.fillRect(-270, 40, 540, 22);
  g.fillRect(-250, 62, 26, 150);
  g.fillRect(224, 62, 26, 150);
  g.restore();
  // phone slab (landscape, squashed) — thickness first
  const W = 300;
  const H = 150;
  const k = 0.42;
  g.save();
  g.translate(0, 0);
  g.fillStyle = '#0d0820';
  g.save();
  g.transform(1, 0, -0.35, k, 0, 14);
  roundRect(g, -W / 2, -H / 2, W, H, 24);
  g.fill();
  g.restore();
  g.save();
  g.transform(1, 0, -0.35, k, 0, 0);
  if (up) {
    g.rotate(-Math.PI / 2);
    phoneFront(g, H, W);
  } else {
    g.fillStyle = '#3a3555';
    roundRect(g, -W / 2, -H / 2, W, H, 24);
    g.fill();
    g.lineWidth = 6;
    g.strokeStyle = '#1a1033';
    g.stroke();
    // camera bump
    g.fillStyle = '#1a1033';
    roundRect(g, -W / 2 + 16, -H / 2 + 16, 70, 70, 18);
    g.fill();
    g.fillStyle = '#5a5a7a';
    g.beginPath();
    g.arc(-W / 2 + 36, -H / 2 + 36, 13, 0, Math.PI * 2);
    g.arc(-W / 2 + 66, -H / 2 + 66, 13, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
  // screen glow leaking under the face-down phone
  if (!up) {
    g.fillStyle = `rgba(111,211,255,${0.35 + 0.15 * Math.sin(t * 4)})`;
    g.beginPath();
    g.ellipse(0, 26, 190, 18, 0, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
}

/**
 * Draw pose `idx` centred at (cx, cy); `s` = scale (1 ≈ a 620×620 picture). `t` animates the arrows.
 */
export function drawPosePicture(g: CanvasRenderingContext2D, idx: number, cx: number, cy: number, s: number, t: number): void {
  g.save();
  g.translate(cx, cy);
  g.scale(s, s);
  const bob = Math.sin(t * 5) * 8;
  const PW = 170;
  const PH = 320;
  switch (idx) {
    case 0: {
      // face up: screen to the ceiling
      g.translate(0, 60);
      tablePhone(g, true, t);
      arrow(g, -20, -40, -20, -250 + bob);
      drawText(g, '👀', 110, -210 + bob, 70, '#fff', { outline: 0 });
      break;
    }
    case 1: {
      // face down: screen to the table
      g.translate(0, 60);
      arrow(g, 0, -290 + bob, 0, -70);
      tablePhone(g, false, t);
      drawText(g, 'SCREEN', 160, -230, 34, INK, { outline: 0 });
      drawText(g, 'HIDDEN', 160, -190, 34, INK, { outline: 0 });
      break;
    }
    case 2: {
      // upright: like a selfie
      g.translate(0, -10);
      phoneFront(g, PW, PH);
      g.save();
      g.translate(0, PH / 2 - 30);
      hand(g, 190);
      g.restore();
      arrow(g, 170, 80, 170, -170 + bob);
      drawText(g, 'TOP', 170, 140, 40, INK, { outline: 0 });
      break;
    }
    default: {
      // rotations from the ghost upright grip
      const ang = idx === 3 ? Math.PI : idx === 4 ? -Math.PI / 2 : Math.PI / 2;
      // floor right under the edge that must point down
      const fy = idx === 3 ? PH / 2 + 18 : PW / 2 + 18;
      g.fillStyle = '#b97b3d';
      roundRect(g, -260, fy, 520, 26, 13);
      g.fill();
      g.fillStyle = '#8a5a2b';
      g.fillRect(-240, fy + 26, 480, 10);
      phoneFront(g, PW, PH, 1, true);
      g.save();
      g.rotate(ang);
      phoneFront(g, PW, PH);
      g.restore();
      // the edge that must point down: highlight + a down arrow under it
      if (idx === 3) {
        curvedArrow(g, 0, 0, 230, -Math.PI * 0.35, Math.PI * 0.5 - 0.3 + Math.sin(t * 3) * 0.04);
      } else if (idx === 4) {
        // left side down = rotate counter-clockwise
        curvedArrow(g, 0, 0, 240, -Math.PI * 0.6, -Math.PI * 1.05 - Math.sin(t * 3) * 0.04);
      } else {
        curvedArrow(g, 0, 0, 240, -Math.PI * 0.4, Math.PI * 0.05 + Math.sin(t * 3) * 0.04);
      }
      break;
    }
  }
  g.restore();
}

/** Tiny glyph of a phone in pose idx (-1 = unknown) for the player tiles. */
export function drawPoseGlyph(g: CanvasRenderingContext2D, idx: number, x: number, y: number, size: number, color: string): void {
  g.save();
  g.translate(x, y);
  const w = size * 0.5;
  const h = size;
  if (idx < 0) {
    g.globalAlpha *= 0.5;
    drawText(g, '?', 0, 0, size * 0.8, '#fff', { outline: 3 });
    g.restore();
    return;
  }
  if (idx === 0 || idx === 1) {
    g.transform(1, 0, -0.4, 0.45, 0, 0);
    g.fillStyle = idx === 0 ? color : '#2a2440';
    roundRect(g, -h / 2, -w / 2, h, w, 6);
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = '#fff';
    g.stroke();
  } else {
    g.rotate(idx === 3 ? Math.PI : idx === 4 ? -Math.PI / 2 : idx === 5 ? Math.PI / 2 : 0);
    g.fillStyle = color;
    roundRect(g, -w / 2, -h / 2, w, h, 6);
    g.fill();
    g.lineWidth = 3;
    g.strokeStyle = '#fff';
    g.stroke();
    g.fillStyle = '#ffd23a';
    g.fillRect(-w * 0.3, -h / 2 - 2, w * 0.6, 6);
  }
  g.restore();
}
