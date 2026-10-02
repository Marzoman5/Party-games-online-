/**
 * Character portraits: renders a 3/4 bust hero shot of a fighter into an offscreen render target
 * and returns a PNG data URL with a transparent background. Results are cached per (id, size).
 */
import * as THREE from 'three';
import { buildFighterModel } from './FighterModel';

const cache = new Map<string, string>();

let _lut: Uint8Array | null = null;
/** Linear -> sRGB byte lookup (render targets hold linear colour). */
function lut(): Uint8Array {
  if (_lut) return _lut;
  _lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    _lut[i] = Math.max(0, Math.min(255, Math.round(s * 255)));
  }
  return _lut;
}

export function renderPortrait(renderer: THREE.WebGLRenderer, characterId: string, size: number): string {
  const key = characterId + '@' + size;
  const hit = cache.get(key);
  if (hit) return hit;

  const ss = 2; // supersample, then downscale on a 2D canvas
  const W = Math.max(16, Math.round(size * ss));
  const rt = new THREE.WebGLRenderTarget(W, W, { type: THREE.UnsignedByteType, depthBuffer: true });

  const scene = new THREE.Scene();
  const rig = buildFighterModel(characterId);
  rig.setPose('portrait', 0);
  rig.setPose('portrait', 0.05);
  scene.add(rig.root);

  const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x3a2d40, 1.4);
  const key1 = new THREE.DirectionalLight(0xffffff, 2.6);
  key1.position.set(2.5, 4, 5);
  const rim = new THREE.DirectionalLight(0x9fd0ff, 2.0);
  rim.position.set(-4, 3, -3);
  scene.add(hemi, key1, rim);

  // frame the bust: top ~42% of the body
  const h = rig.height;
  const cam = new THREE.PerspectiveCamera(24, 1, 0.1, 50);
  const focusY = h * 0.78;
  const span = h * 0.62;
  const dist = span / 2 / Math.tan(THREE.MathUtils.degToRad(12));
  cam.position.set(0.1 * h, focusY + 0.08 * h, dist);
  cam.lookAt(0, focusY, 0);

  // save renderer state
  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  const prevAutoClear = renderer.autoClear;
  const prevShadow = renderer.shadowMap.enabled;

  let url = '';
  try {
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.autoClear = true;
    renderer.clear(true, true, true);
    renderer.render(scene, cam);
    const px = new Uint8Array(W * W * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, W, W, px);

    const big = document.createElement('canvas');
    big.width = big.height = W;
    const bctx = big.getContext('2d');
    const out = document.createElement('canvas');
    out.width = out.height = size;
    const octx = out.getContext('2d');
    if (bctx && octx) {
      const img = bctx.createImageData(W, W);
      const L = lut();
      for (let y = 0; y < W; y++) {
        const src = (W - 1 - y) * W * 4;
        const dst = y * W * 4;
        for (let x = 0; x < W * 4; x += 4) {
          const a = px[src + x + 3];
          img.data[dst + x] = L[px[src + x]];
          img.data[dst + x + 1] = L[px[src + x + 1]];
          img.data[dst + x + 2] = L[px[src + x + 2]];
          img.data[dst + x + 3] = a;
        }
      }
      bctx.putImageData(img, 0, 0);
      octx.imageSmoothingEnabled = true;
      octx.imageSmoothingQuality = 'high';
      octx.drawImage(big, 0, 0, size, size);
      url = out.toDataURL('image/png');
    }
  } finally {
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    renderer.autoClear = prevAutoClear;
    renderer.shadowMap.enabled = prevShadow;
    rt.dispose();
    rig.dispose();
    hemi.dispose();
    key1.dispose();
    rim.dispose();
  }
  if (url) cache.set(key, url);
  return url;
}
