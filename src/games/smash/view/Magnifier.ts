/**
 * Off-screen magnifier bubbles: when a fighter leaves the camera frame, a circular bubble at the
 * screen edge (in the fighter's direction) shows a mini render of it, ringed in the player colour
 * and sized by distance. Render targets are created once (lifetime) so memory stays flat.
 */
import * as THREE from 'three';

const MAX = 4;

interface Bubble {
  rt: THREE.WebGLRenderTarget;
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  arrow: THREE.Mesh;
  arrowMat: THREE.MeshBasicMaterial;
}

export interface MagnifyRequest {
  x: number; // world centre of the fighter
  y: number;
  h: number;
  ndcX: number;
  ndcY: number;
  color: number;
}

export class Magnifier {
  private readonly bubbles: Bubble[] = [];
  private readonly scene = new THREE.Scene();
  private readonly ortho = new THREE.OrthographicCamera(0, 1, 1, 0, -10, 10);
  private readonly cam = new THREE.PerspectiveCamera(32, 1, 0.5, 400);
  private readonly circle = new THREE.CircleGeometry(1, 48);
  private readonly tri: THREE.BufferGeometry;
  private rtSize: number;
  /** Bubbles drawn in the last frame (for tests / hooks). */
  shown = 0;

  constructor(size: number) {
    this.rtSize = size;
    this.tri = new THREE.BufferGeometry();
    this.tri.setAttribute('position', new THREE.Float32BufferAttribute([0, 0.55, 0, -0.42, -0.3, 0, 0.42, -0.3, 0], 3));
    for (let i = 0; i < MAX; i++) {
      const rt = new THREE.WebGLRenderTarget(size, size, { depthBuffer: true });
      rt.texture.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.ShaderMaterial({
        uniforms: { map: { value: rt.texture }, ring: { value: new THREE.Color(0xffffff) } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
        fragmentShader: `uniform sampler2D map; uniform vec3 ring; varying vec2 vUv;
          void main(){ vec2 p = vUv*2.0-1.0; float r = length(p);
            vec4 tex = texture2D(map, vUv);
            vec3 c = tex.rgb;
            float vig = smoothstep(0.55, 0.84, r);
            c = mix(c, c*0.75, vig);
            if (r > 0.8) c = ring;
            if (r > 0.93) c = vec3(0.04,0.04,0.08);
            float a = 1.0 - smoothstep(0.985, 1.0, r);
            gl_FragColor = vec4(c, a);
            #include <colorspace_fragment>
          }`,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.circle, mat);
      mesh.visible = false;
      this.scene.add(mesh);
      const arrowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false });
      const arrow = new THREE.Mesh(this.tri, arrowMat);
      arrow.visible = false;
      this.scene.add(arrow);
      this.bubbles.push({ rt, mesh, mat, arrow, arrowMat });
    }
  }

  setSize(size: number): void {
    if (size === this.rtSize) return;
    this.rtSize = size;
    for (const b of this.bubbles) b.rt.setSize(size, size);
  }

  /**
   * Render bubbles for the requested fighters. `w`/`h` = canvas CSS size, `unit` = HUD unit px.
   * Call after the main render (autoClear off for the overlay).
   */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, reqs: MagnifyRequest[], w: number, h: number, unit: number, safe: number): void {
    const n = Math.min(MAX, reqs.length);
    this.shown = n;
    for (let i = 0; i < MAX; i++) {
      this.bubbles[i].mesh.visible = false;
      this.bubbles[i].arrow.visible = false;
    }
    if (n === 0) return;
    // 1) mini renders
    const prevTarget = renderer.getRenderTarget();
    for (let i = 0; i < n; i++) {
      const r = reqs[i];
      const b = this.bubbles[i];
      this.cam.position.set(r.x, r.y, 5.6);
      this.cam.lookAt(r.x, r.y, 0);
      this.cam.updateMatrixWorld();
      renderer.setRenderTarget(b.rt);
      renderer.clear();
      renderer.render(scene, this.cam);
    }
    renderer.setRenderTarget(prevTarget);

    // 2) overlay circles in screen pixels
    this.ortho.left = 0;
    this.ortho.right = w;
    this.ortho.top = h;
    this.ortho.bottom = 0;
    this.ortho.updateProjectionMatrix();
    for (let i = 0; i < n; i++) {
      const r = reqs[i];
      const b = this.bubbles[i];
      const dist = Math.max(Math.abs(r.ndcX), Math.abs(r.ndcY)) - 1;
      const rad = unit * (9 - Math.min(3.5, dist * 4));
      const margin = rad + unit * 1.6 + safe;
      const len = Math.hypot(r.ndcX, r.ndcY) || 1;
      let dx = r.ndcX / len;
      let dy = r.ndcY / len;
      // scale direction to touch the inner screen rectangle
      const hx = w / 2 - margin;
      const hy = h / 2 - margin;
      const sx = Math.abs(dx) > 1e-4 ? hx / Math.abs(dx * (w / 2)) : Infinity;
      const sy = Math.abs(dy) > 1e-4 ? hy / Math.abs(dy * (h / 2)) : Infinity;
      const s = Math.min(sx, sy);
      let px = w / 2 + dx * (w / 2) * s;
      let py = h / 2 + dy * (h / 2) * s;
      // never beyond the actual fighter direction clamp
      px = Math.max(margin, Math.min(w - margin, px));
      py = Math.max(margin, Math.min(h - margin, py));
      b.mesh.position.set(px, py, 0);
      b.mesh.scale.set(rad, rad, 1);
      b.mesh.visible = true;
      (b.mat.uniforms.ring.value as THREE.Color).setHex(r.color);
      // pointer toward the fighter
      dx = r.ndcX * (w / 2) - (px - w / 2);
      dy = r.ndcY * (h / 2) - (py - h / 2);
      const a = Math.atan2(dy, dx);
      b.arrow.position.set(px + Math.cos(a) * rad * 1.12, py + Math.sin(a) * rad * 1.12, 0);
      b.arrow.rotation.z = a - Math.PI / 2;
      b.arrow.scale.setScalar(rad * 0.38);
      b.arrowMat.color.setHex(r.color);
      b.arrow.visible = true;
    }
    const ac = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.ortho);
    renderer.autoClear = ac;
  }

  dispose(): void {
    for (const b of this.bubbles) {
      b.rt.dispose();
      b.mat.dispose();
      b.arrowMat.dispose();
    }
    this.circle.dispose();
    this.tri.dispose();
  }
}
