// 实景 3D 世界：渲染器、相机机位、灯光、天空、悬崖、水面、布景。
// 干净明快的低多边形画风；所有颜色取自 THEME。
// 其他模块把自己的物体挂到 world.groups.structure / world.groups.fx 下面。

import * as THREE from 'three';
import { THEME } from '../theme.js';
import { computeRig, applyRig, newRig } from './world-camera.js';
import { buildTerrain, buildBackdrop, waterlineFace } from './world-terrain.js';
import { buildMapTerrain } from './world-terrain-map.js';
import { getMap, MAPS } from '../map.js';
import { Water, waveHeight } from './world-water.js';
import { GeoBuilder, hash, col, shade } from './world-geo.js';

// 灯光强度（物理单位，配合 MeshStandardMaterial + 无色调映射）
const LIGHT = {
  sun: 2.75,
  hemi: 1.6,
};
// 雾：相对相机距离 D 的偏移，保证任何 blend 下近景都不起雾，远景渐隐
const FOG_NEAR = 22, FOG_FAR = 195;
// 震屏：strength 1 时约为可见高度的 1.2%
const SHAKE_AMP = 0.012, SHAKE_DECAY = 9;

function cssHex(hex) { return '#' + hex.toString(16).padStart(6, '0'); }
function smooth(t) { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }

export class World {
  constructor({ canvas, view, map }) {
    this.view = view;
    this.canvas = canvas;
    this.blend = 0;
    this.time = 0;
    this._shake = 0;
    this._rig = newRig();

    const r = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NoToneMapping;
    r.shadowMap.enabled = true;
    // three r187 已移除 PCFSoftShadowMap（会告警并回退）；PCFShadowMap + shadow.radius 即为软阴影
    r.shadowMap.type = THREE.PCFShadowMap;
    r.setPixelRatio(Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
    r.setSize(view.w, view.h);
    this.renderer = r;

    const scene = new THREE.Scene();
    this.scene = scene;
    this.camera = new THREE.PerspectiveCamera(30, view.w / view.h, 0.5, 1000);

    this.groups = { structure: new THREE.Group(), fx: new THREE.Group() };
    this.groups.structure.name = 'structure';
    this.groups.fx.name = 'fx';

    this._buildSky();
    this._buildLights();
    this._buildClouds();
    this._landMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.92, metalness: 0 });
    this._backMat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1, metalness: 0 });
    this._mapObjs = [];
    this.water = null;
    this.flags = [];
    this.setMap(map);

    scene.add(this.groups.structure, this.groups.fx);
    this.update(0, 0);
  }

  /**
   * 换地图：重建地形、水面、旗子，阴影范围跟着场地宽度走。
   * 「海峡」用手调的悬崖（world-terrain.js），其它地图按地表折线生成（world-terrain-map.js）。
   */
  setMap(map) {
    const M = getMap(map);
    if (this.map === M) return;
    this.map = M;
    const scene = this.scene;
    for (const o of this._mapObjs) { scene.remove(o); if (o.geometry) o.geometry.dispose(); }
    this._mapObjs.length = 0;
    for (const f of this.flags) { scene.remove(f.mesh); f.mesh.geometry.dispose(); f.mesh.material.dispose(); }
    if (this.water) { scene.remove(this.water.group); this.water.dispose(); this.water = null; }

    const classic = M.raw === MAPS.strait;
    const t = classic ? buildTerrain() : buildMapTerrain(M);
    const land = new THREE.Mesh(t.geometry, this._landMat);
    land.name = 'terrain';
    land.castShadow = true;
    land.receiveShadow = true;
    const back = new THREE.Mesh(buildBackdrop(M.hasWater ? M.waterY : t.baseY - 1.5), this._backMat);
    back.name = 'backdrop';
    scene.add(land, back);
    this._mapObjs.push(land, back);
    this._flagMounts = t.flagMounts;
    this._buildFlags();

    if (M.hasWater) {
      const shores = classic ? [{ dir: 1, line: waterlineFace(0) }, { dir: -1, line: waterlineFace(1) }] : t.shore;
      this.water = new Water(shores, { waterY: M.waterY, bedY: Math.min(M.gMin, M.waterY - 4), midX: M.fieldW / 2 });
      scene.add(this.water.group);
    }
    this._fitShadow();
  }

  /** 阴影相机紧贴「战场 + 两侧近景」这个盒子 */
  _fitShadow() {
    const M = this.map, sun = this.sun;
    const W = M.fieldW;
    const T = new THREE.Vector3(W / 2, 6, -4);
    const dir = new THREE.Vector3(-22, 42, 28).normalize();
    sun.position.copy(T).addScaledVector(dir, 90);
    sun.target.position.copy(T);
    const look = new THREE.Matrix4().lookAt(sun.position, T, new THREE.Vector3(0, 1, 0));
    const inv = look.clone().transpose();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, d0 = Infinity, d1 = -Infinity;
    const v = new THREE.Vector3();
    const lo = M.hasWater ? Math.min(-13, M.gMin) : Math.min(M.gMin, M.build.yMin) - 2;
    const hi = Math.max(26, M.build.yMax + 14, M.gMax + 8);
    for (const bx of [-18, W + 18]) for (const by of [lo, hi]) for (const bz of [-16, 8]) {
      v.set(bx, by, bz).sub(sun.position).applyMatrix4(inv);
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x);
      y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
      d0 = Math.min(d0, -v.z); d1 = Math.max(d1, -v.z);
    }
    const cam = sun.shadow.camera;
    cam.left = x0; cam.right = x1; cam.bottom = y0; cam.top = y1;
    cam.near = Math.max(0.5, d0 - 4); cam.far = d1 + 4;
    cam.updateProjectionMatrix();
    sun.target.updateMatrixWorld();
  }

  // ------------------------------------------------------------------ 构建
  _buildSky() {
    const w = THEME.world;
    const c = document.createElement('canvas');
    c.width = 4; c.height = 256;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, cssHex(w.skyTop));
    grad.addColorStop(0.62, cssHex(w.skyHorizon));
    grad.addColorStop(1, cssHex(w.skyHorizon));
    g.fillStyle = grad;
    g.fillRect(0, 0, 4, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    this.scene.background = tex;
    this.scene.fog = new THREE.Fog(w.fog, 100, 300);
  }

  _buildLights() {
    const w = THEME.world;
    const hemi = new THREE.HemisphereLight(w.ambientSky, w.ambientGround, LIGHT.hemi);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(w.sun, LIGHT.sun);
    // 左上前方；位置和阴影范围在 _fitShadow 里按地图定
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    sun.shadow.radius = 2.5;
    this.scene.add(sun, sun.target);
    this.sun = sun;
    this.hemi = hemi;
  }

  _buildClouds() {
    const white = col(THEME.world.cloud);
    const under = shade(white, 0.93); // 云底略暗：cloud 压暗
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, flatShading: true, roughness: 1, metalness: 0,
      emissive: THEME.world.cloud, emissiveIntensity: 0.3,
    });
    const puff = new THREE.IcosahedronGeometry(1, 1);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    this.clouds = [];
    const N = 8;
    for (let i = 0; i < N; i++) {
      const b = new GeoBuilder();
      const n = 3 + Math.floor(hash(i, 1) * 3);
      const R = 2.2 + hash(i, 2) * 2.0;
      for (let k = 0; k < n; k++) {
        const u = n === 1 ? 0 : k / (n - 1) - 0.5;
        const r = R * (1 - Math.abs(u) * 0.7) * (0.85 + 0.3 * hash(i, k, 3));
        p.set(u * R * 2.6, r * 0.25 + hash(i, k, 4) * R * 0.15, (hash(i, k, 5) - 0.5) * R * 0.8);
        s.set(r * 1.25, r * 0.8, r);
        q.setFromAxisAngle(up, hash(i, k, 6) * 6.28);
        m.compose(p, q, s);
        b.addGeometry(puff, m, (cx, cy) => (cy < R * 0.05 ? under : white), { vary: 0.02, jitter: 0.08, seed: i * 10 + k });
      }
      const geo = b.build();
      // 压平云底
      const pa = geo.attributes.position;
      for (let v = 0; v < pa.count; v++) if (pa.getY(v) < -R * 0.12) pa.setY(v, -R * 0.12);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'cloud';
      mesh.position.set(-140 + (i / N) * 300 + hash(i, 7) * 20, 14 + hash(i, 8) * 14, -40 - hash(i, 9) * 60);
      mesh.userData.speed = 0.35 + hash(i, 10) * 0.5;
      this.scene.add(mesh);
      this.clouds.push(mesh);
    }
    puff.dispose();
  }

  _buildFlags() {
    const colors = [THEME.team.player, THEME.team.enemy];
    this.flags = this._flagMounts.map((mt, i) => {
      const g = new THREE.PlaneGeometry(1.7, 1.05, 8, 4);
      g.translate(0.85, -0.525, 0); // 左上角 = 旗杆挂点
      const pa = g.attributes.position;
      pa.setUsage(THREE.DynamicDrawUsage);
      const base = Float32Array.from(pa.array);
      const mat = new THREE.MeshStandardMaterial({ color: colors[i], flatShading: true, roughness: 0.8, metalness: 0, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(g, mat);
      mesh.name = i === 0 ? 'flag-player' : 'flag-enemy';
      mesh.position.set(mt.x, mt.y, mt.z);
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      return { mesh, base, pa, phase: i * 1.9 };
    });
  }

  // ------------------------------------------------------------------ 每帧
  setBlend(t) { this.blend = t < 0 ? 0 : t > 1 ? 1 : t; }

  addShake(strength) {
    if (!(strength > 0)) return;
    this._shake = Math.min(1.2, this._shake + Math.min(1, strength));
  }

  /** 水面高度；这张图没有水时是负无穷 */
  waterLevelAt(x, z = 0) { return this.water ? waveHeight(x, z, this.time) : -Infinity; }

  update(dt, time) {
    dt = dt > 0 ? dt : 0;
    this.time = typeof time === 'number' ? time : this.time + dt;
    const t = this.time;

    // 相机
    const rig = computeRig(this.view, this.blend, this._rig);
    this._shake *= Math.exp(-dt * SHAKE_DECAY);
    let ox = 0, oy = 0, oz = 0;
    const gate = smooth((this.blend - 0.5) / 0.3);
    if (this._shake > 1e-4 && gate > 0) {
      const a = SHAKE_AMP * rig.Hm * Math.min(1, this._shake) * gate;
      ox = a * (0.62 * Math.sin(t * 37.1) + 0.38 * Math.sin(t * 23.3 + 1.3));
      oy = a * (0.62 * Math.sin(t * 31.7 + 2.1) + 0.38 * Math.sin(t * 19.9 + 0.7));
      oz = a * 0.35 * Math.sin(t * 27.3 + 0.4);
    } else if (this._shake <= 1e-4) this._shake = 0;
    applyRig(this.camera, rig, ox, oy, oz);

    const fog = this.scene.fog;
    fog.near = rig.D + FOG_NEAR;
    fog.far = rig.D + FOG_FAR;

    // 水面、泡沫
    if (this.water) this.water.update(t);

    // 云
    const cl = this.clouds;
    for (let i = 0; i < cl.length; i++) {
      const c = cl[i];
      c.position.x += c.userData.speed * dt;
      if (c.position.x > 170) c.position.x -= 330;
    }

    // 旗
    const fl = this.flags;
    for (let i = 0; i < fl.length; i++) {
      const f = fl[i], arr = f.pa.array, b = f.base, ph = f.phase;
      const squeeze = 1 - 0.03 * (1 + Math.sin(t * 1.3 + ph));
      for (let o = 0; o < arr.length; o += 3) {
        const bx = b[o], u = bx / 1.7;
        arr[o] = bx * squeeze;
        arr[o + 1] = b[o + 1] - 0.06 * u * u;
        arr[o + 2] = u * (0.17 * Math.sin(u * 3.4 - t * 4.6 + ph) + 0.045 * Math.sin(u * 7.1 - t * 7.3 + ph * 2));
      }
      f.pa.needsUpdate = true;
    }
  }

  render() { this.renderer.render(this.scene, this.camera); }

  resize(w, h, dpr) {
    this.renderer.setPixelRatio(dpr || 1);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
