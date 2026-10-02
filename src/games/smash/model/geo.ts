/**
 * Geometry helpers for the procedural fighters: unit primitives + a batch that bakes
 * transforms and vertex colours into one merged, indexed geometry with smooth normals
 * (materials use flatShading for the faceted look; the smooth normals feed the
 * inverted-hull outline so it has no cracks).
 */
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

export interface AddOpts {
  /** Per-vertex brightness jitter (0..1) — stone / fabric variation. */
  jitter?: number;
  /** Upward-facing vertices get this colour (moss on stone). */
  moss?: number;
  /** Normal-y threshold for moss (default 0.3). */
  mossAt?: number;
  /** Darken downward-facing vertices a little (fake AO), 0..1. */
  ao?: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _c2 = new THREE.Color();

function hash3(x: number, y: number, z: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
}

/** Lazily-created unit primitives (shared, never disposed). */
let _unit: ReturnType<typeof makeUnits> | null = null;
function makeUnits() {
  const coneUp = (radial: number) => new THREE.ConeGeometry(1, 1, radial, 1);
  return {
    sphere: new THREE.SphereGeometry(1, 10, 7),
    sphereLo: new THREE.SphereGeometry(1, 7, 5),
    hemi: new THREE.SphereGeometry(1, 10, 4, 0, Math.PI * 2, 0, Math.PI / 2),
    box: new THREE.BoxGeometry(1, 1, 1),
    rbox: new RoundedBoxGeometry(1, 1, 1, 1, 0.2),
    cyl: new THREE.CylinderGeometry(1, 1, 1, 8, 1),
    cyl6: new THREE.CylinderGeometry(1, 1, 1, 6, 1),
    cyl12: new THREE.CylinderGeometry(1, 1, 1, 12, 1),
    cone: coneUp(6),
    cone4: coneUp(4),
    cone8: coneUp(8),
    ico: new THREE.IcosahedronGeometry(1, 0),
    ico1: new THREE.IcosahedronGeometry(1, 1),
    dodec: new THREE.DodecahedronGeometry(1, 0),
    oct: new THREE.OctahedronGeometry(1, 0),
    torus: new THREE.TorusGeometry(1, 0.22, 6, 14),
    torusThin: new THREE.TorusGeometry(1, 0.1, 5, 16),
  };
}
export function U() {
  if (!_unit) _unit = makeUnits();
  return _unit;
}

export class GeoBatch {
  private parts: THREE.BufferGeometry[] = [];

  get empty(): boolean {
    return this.parts.length === 0;
  }

  /** Add a transformed, coloured copy of `src`. */
  add(
    src: THREE.BufferGeometry,
    color: number,
    x = 0,
    y = 0,
    z = 0,
    rx = 0,
    ry = 0,
    rz = 0,
    sx = 1,
    sy = 1,
    sz = 1,
    opts?: AddOpts,
  ): this {
    let g = src.clone();
    _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
    g.applyMatrix4(_m);
    if (g.index) {
      const n = g.toNonIndexed();
      g.dispose();
      g = n;
    }
    const pos = g.attributes.position as THREE.BufferAttribute;
    const nor = g.attributes.normal as THREE.BufferAttribute | undefined;
    const cnt = pos.count;
    const arr = new Float32Array(cnt * 3);
    _c.setHex(color);
    if (opts?.moss !== undefined) _c2.setHex(opts.moss);
    const mossAt = opts?.mossAt ?? 0.3;
    for (let i = 0; i < cnt; i++) {
      const px = pos.getX(i);
      const py = pos.getY(i);
      const pz = pos.getZ(i);
      const h = hash3(px * 9.1, py * 9.1, pz * 9.1);
      let r = _c.r;
      let gg = _c.g;
      let b = _c.b;
      const ny = nor ? nor.getY(i) : 0;
      if (opts?.moss !== undefined && ny > mossAt + (h - 0.5) * 0.4) {
        r = _c2.r;
        gg = _c2.g;
        b = _c2.b;
      }
      let f = 1;
      if (opts?.jitter) f *= 1 + (h - 0.5) * 2 * opts.jitter;
      if (opts?.ao && ny < 0) f *= 1 + ny * opts.ao;
      arr[i * 3] = r * f;
      arr[i * 3 + 1] = gg * f;
      arr[i * 3 + 2] = b * f;
    }
    for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    this.parts.push(g);
    return this;
  }

  /** Tapered limb hanging from the local origin down -y (cylinder + end balls). */
  limb(color: number, rTop: number, rBot: number, len: number, x = 0, y = 0, z = 0, opts?: AddOpts): this {
    const u = U();
    const g = new THREE.CylinderGeometry(rTop, rBot, len, 8, 1, true);
    this.add(g, color, x, y - len / 2, z, 0, 0, 0, 1, 1, 1, opts);
    g.dispose();
    this.add(u.sphereLo, color, x, y, z, 0, 0, 0, rTop, rTop, rTop, opts);
    this.add(u.sphereLo, color, x, y - len, z, 0, 0, 0, rBot, rBot, rBot, opts);
    return this;
  }

  /** Cylinder-ish segment between two points (thin straps, streamers). */
  seg(color: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, radial = 6): this {
    const dir = new THREE.Vector3(bx - ax, by - ay, bz - az);
    const len = dir.length();
    const g = new THREE.CylinderGeometry(r, r, len, radial, 1, false);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    g.applyQuaternion(q);
    g.translate((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    this.add(g, color);
    g.dispose();
    return this;
  }

  build(): THREE.BufferGeometry | null {
    if (!this.parts.length) return null;
    const merged = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts.length = 0;
    if (!merged) return null;
    const idx = mergeVertices(merged, 1e-4);
    merged.dispose();
    idx.computeVertexNormals();
    idx.computeBoundingSphere();
    return idx;
  }
}

/** Shared outline (inverted hull) material factory: extrudes along the smooth normal. */
export function makeOutlineMaterial(color: number, thickness: number): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `vec3 transformed = vec3( position ) + normal * ${thickness.toFixed(4)};`,
    );
  };
  m.customProgramCacheKey = () => 'fighterOutline' + thickness.toFixed(4);
  return m;
}
