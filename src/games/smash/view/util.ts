import * as THREE from 'three';

/** Dispose every geometry / material / texture / light under `root` (skips userData.shared subtrees). */
export function disposeTree(root: THREE.Object3D): void {
  const seenMat = new Set<THREE.Material>();
  const seenGeo = new Set<THREE.BufferGeometry>();
  const visit = (o: THREE.Object3D): void => {
    if (o.userData && o.userData.shared) return;
    const any = o as THREE.Object3D & {
      geometry?: THREE.BufferGeometry;
      material?: THREE.Material | THREE.Material[];
      isLight?: boolean;
      isInstancedMesh?: boolean;
      dispose?: () => void;
    };
    if (any.geometry && !seenGeo.has(any.geometry)) {
      seenGeo.add(any.geometry);
      any.geometry.dispose();
    }
    if (any.material) {
      const mats = Array.isArray(any.material) ? any.material : [any.material];
      for (const m of mats) {
        if (!m || seenMat.has(m)) continue;
        seenMat.add(m);
        disposeMaterial(m);
      }
    }
    if (any.isLight && typeof any.dispose === 'function') any.dispose();
    if (any.isInstancedMesh && typeof any.dispose === 'function') any.dispose();
    for (const c of o.children) visit(c);
  };
  visit(root);
  root.removeFromParent();
}

export function disposeMaterial(m: THREE.Material): void {
  const rec = m as unknown as Record<string, unknown>;
  for (const k of Object.keys(rec)) {
    const v = rec[k] as { isTexture?: boolean; dispose?: () => void; userData?: { shared?: boolean } } | null;
    if (v && v.isTexture && !v.userData?.shared && typeof v.dispose === 'function') v.dispose();
  }
  const sm = m as THREE.ShaderMaterial;
  if (sm.uniforms) {
    for (const u of Object.values(sm.uniforms)) {
      const v = u?.value as { isTexture?: boolean; dispose?: () => void; userData?: { shared?: boolean } } | null;
      if (v && v.isTexture && !v.userData?.shared && typeof v.dispose === 'function') v.dispose();
    }
  }
  m.dispose();
}

export function cssToHex(css: string, fallback = 0xffffff): number {
  try {
    const c = new THREE.Color(css);
    return c.getHex();
  } catch {
    return fallback;
  }
}

export function canvasTexture(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void, srgb = true): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const c = cv.getContext('2d');
  if (c) draw(c);
  const t = new THREE.CanvasTexture(cv);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Deterministic tiny PRNG for decoration placement. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const damp = (a: number, b: number, rate: number, dt: number): number => b + (a - b) * Math.exp(-rate * dt);

/** Shared soft round sprite texture (lifetime). */
let softTex: THREE.Texture | null = null;
export function softCircleTexture(): THREE.Texture {
  if (softTex) return softTex;
  softTex = canvasTexture(
    64,
    64,
    (c) => {
      const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.35, 'rgba(255,255,255,0.75)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, 64, 64);
    },
    false,
  );
  softTex.userData.shared = true;
  return softTex;
}
