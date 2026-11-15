// 实景静态地形：两侧悬崖、锚点底座、崖顶布景（针叶树、石块、旗杆）、远景山岛。
// 悬崖用沿 z 排列的一组剖面放样而成。|z| <= BAND 的剖面与物理完全一致：
// 顶面 y = 0，崖面竖直（左崖 x = 0，右崖 x = fieldW）。带外才加块面起伏、岩层台阶、收窄的崖脚。
//
// 剖面用「离崖边的距离」s 描述：左崖 x = s，右崖 x = fieldW - s（s <= 0 是陆地，s = 0 是崖面）。

import * as THREE from 'three';
import { CFG } from '../config.js';
import { THEME } from '../theme.js';
import { GeoBuilder, hash, clamp, sstep, col, shade, mix } from './world-geo.js';

export const BAND = 1.6;
// 主剖面的 z 位置（从后往前）
export const SLICES = [-16, -13.5, -11, -8.6, -6.6, -4.8, -3.1, -1.6, 1.6, 2.5, 3.5, 4.5, 5.35, 6.0];
const BOTTOM = -16;
const BACK_S = -60;
const TOP_FAR = [-60, -42, -30, -21];          // 顶面远处的点（绝对 s）
const TOP_NEAR = [-9.5, -6.5, -4, -2.2, -0.9]; // 顶面近崖边的点（相对崖边）
const WY = CFG.waterY;
// 崖面各层：[y, 台阶外凸系数]
const FACE = [
  [-1.5, 0.05], [-1.62, 0.42], [-3.2, 0.3], [-3.34, 0.78],
  [WY + 1.0, 0.62], [WY, 0.7], [WY - 1.2, 0.82], [-10, 1.5], [-13, 2.4], [BOTTOM, 3.4],
];
export const FACE_WATER_INDEX = 5; // FACE 里水线那一层

const C = {
  rock: col(THEME.world.rock),
  rockDark: col(THEME.world.rockDark),
  rockWet: col(THEME.world.rockWet),
  grass: col(THEME.world.grass),
  grassDark: col(THEME.world.grassDark),
  tree: col(THEME.world.tree),
  trunk: col(THEME.world.trunk),
  anchor: col(THEME.material.anchor),
  joint: col(THEME.material.joint),
  pole: col(THEME.cannon.band),
  fog: col(THEME.world.fog),
};
C.under = shade(C.rockWet, 0.82);      // 水下岩体：rockWet 压暗
C.treeDark = shade(C.tree, 0.84);      // 树冠下层：tree 压暗

// ------------------------------------------------------------------ 剖面
function sliceProfile(side, j) {
  const z = SLICES[j];
  const az = Math.abs(z);
  const inBand = az <= BAND + 1e-6;
  const t = inBand ? 0 : clamp((az - BAND) / 1.4, 0, 1);
  const H = (k) => hash(side * 101 + 3, j, k);
  let R = t * (0.6 + 1.2 * H(1));       // 带外崖面整体后缩
  let drop = 0;                          // 前端收头：崖顶下压
  if (z >= 5.9) { R += 2.6; drop = 0.95; } else if (z >= 5.3) { R += 0.9; drop = 0.25; }
  if (z <= -15.9) R += 1.2 * H(2);
  const sEdge = -R;
  const yEdge = inBand ? 0 : -drop - 0.05 * t * H(3);
  const lip = inBand ? 0.04 : 0.1 + 0.06 * H(4);

  const topY = (s, k) => {
    if (inBand) return 0;
    let y = -drop * (0.55 + 0.45 * H(20 + k)) - 0.06 * t * H(30 + k);
    if (z < 0) y += sstep(-3.5, -13, z) * sstep(-9, -24, s) * (1.6 + 2.6 * H(40 + k)) + 0.1 * t * H(50 + k);
    return y;
  };

  const pts = [], kinds = [];
  const push = (s, y, dz, kind) => { pts.push([s, y, dz]); kinds.push(kind); };
  push(BACK_S, BOTTOM, 0, 'back');
  TOP_FAR.forEach((s0, k) => {
    const s = s0 + (k > 0 ? (H(60 + k) - 0.5) * 3 : 0);
    push(s, topY(s, k), 0, 'top');
  });
  TOP_NEAR.forEach((d, k) => {
    const s = sEdge + d + (H(70 + k) - 0.5) * 0.4 * t;
    push(s, topY(s, 10 + k), 0, 'top');
  });
  const lipIndex = pts.length;
  push(sEdge + lip, yEdge, 0, 'lip');          // 草皮外沿（略微探出）
  push(sEdge + lip, yEdge - 0.22, 0, 'lip');
  push(sEdge, yEdge - 0.3, 0, 'face');         // 草皮底 = 岩面顶
  const faceStart = pts.length;
  FACE.forEach(([y, f], k) => {
    let s = 0, dz = 0;
    if (!inBand) {
      s = sEdge + f * 0.6 * t + (H(80 + k) - 0.5) * 0.36 * t;
      if (y > WY - 0.4) s = Math.min(s, -0.05);   // 水面以上不许探出崖线
      dz = (H(90 + k) - 0.5) * 0.5 * t;
    }
    push(s, y, dz, k === FACE.length - 1 ? 'bottom' : 'face');
  });
  return { z, pts, kinds, lipIndex, faceStart, inBand };
}

const _profiles = [null, null];
export function profiles(side) {
  if (!_profiles[side]) _profiles[side] = SLICES.map((_, j) => sliceProfile(side, j));
  return _profiles[side];
}

function faceColor(y) {
  if (y > -1.56) return C.rock;
  if (y > -3.27) return C.rockDark;
  if (y > WY + 1.1) return C.rock;
  if (y > WY - 1.3) return C.rockWet;
  return C.under;
}

function segColor(kind, ymid, a, b) {
  if (kind === 'top') return hash(a, b, 5) < 0.3 ? C.grassDark : C.grass;
  if (kind === 'lip') return C.grassDark;
  if (kind === 'face') return faceColor(ymid);
  return C.rockDark;
}

/** 沿 z 放样一侧悬崖，前后两端各收两圈再封口 */
function emitCliff(b, side) {
  const W = CFG.fieldW;
  const X = side === 0 ? (s) => s : (s) => W - s;
  const profs = profiles(side);
  const N = profs[0].pts.length;
  const kinds = profs[0].kinds;

  // 环：每个点 [s, y, z]
  const rings = profs.map((p) => p.pts.map((q) => [q[0], q[1], p.z + q[2]]));
  const shrink = (ring, k, dz, seed) => {
    let cs = 0, cy = 0;
    for (const q of ring) { cs += q[0]; cy += q[1]; }
    cs /= ring.length; cy /= ring.length;
    return ring.map((q, i) => [
      q[0] + (cs - q[0]) * k + (hash(side, seed, i) - 0.5) * 0.3,
      Math.min(q[1] + (cy - q[1]) * k * 0.6, q[1] - 0.15 * k / 0.08),
      q[2] + dz + (hash(side, seed + 1, i) - 0.5) * 0.12,
    ]);
  };
  const front = rings[rings.length - 1], back = rings[0];
  const f1 = shrink(front, 0.08, 0.7, 31), f2 = shrink(front, 0.2, 1.15, 33);
  const b1 = shrink(back, 0.08, -0.7, 35), b2 = shrink(back, 0.2, -1.15, 37);
  const all = [b2, b1, ...rings, f1, f2];

  b.flip = side === 1;
  const P = (q) => [X(q[0]), q[1], q[2]];
  const yTopLip = 0;
  for (let j = 0; j < all.length - 1; j++) {
    const A = all[j], B = all[j + 1];
    const capRing = j < 2 || j >= all.length - 3;
    for (let i = 0; i < N; i++) {
      const i2 = (i + 1) % N;
      const a = P(A[i]), bb = P(A[i2]), c = P(B[i2]), d = P(B[i]);
      const ymid = (A[i][1] + A[i2][1] + B[i][1] + B[i2][1]) / 4;
      let color = segColor(kinds[i], ymid, side * 1000 + j, i);
      if (capRing && kinds[i] === 'top') color = hash(side, j, i) < 0.5 ? C.grassDark : C.grass;
      b.tri(a, d, c, color);
      b.tri(a, c, bb, color);
    }
  }
  // 两端封口（扇形）
  const fan = (ring, dz, front) => {
    let cs = 0, cy = 0, cz = 0;
    for (const q of ring) { cs += q[0]; cy += q[1]; cz += q[2]; }
    const n = ring.length;
    const ctr = P([cs / n, cy / n, cz / n + dz]);
    for (let i = 0; i < n; i++) {
      const i2 = (i + 1) % n;
      const ymid = (ring[i][1] + ring[i2][1]) / 2;
      const color = ymid > yTopLip - 0.9 && kinds[i] !== 'bottom' && kinds[i] !== 'back' ? C.grassDark : faceColor(ymid);
      if (front) b.tri(ctr, P(ring[i2]), P(ring[i]), color);
      else b.tri(ctr, P(ring[i]), P(ring[i2]), color);
    }
  };
  fan(f2, 0.25, true);
  fan(b2, -0.25, false);
  b.flip = false;
}

/** 崖顶高度（布景落地用）：在主剖面之间插值。s 为本侧的离崖距离 */
export function topHeightAt(side, s, z) {
  const profs = profiles(side);
  let j = 0;
  while (j < SLICES.length - 2 && z > SLICES[j + 1]) j++;
  const f = clamp((z - SLICES[j]) / (SLICES[j + 1] - SLICES[j]), 0, 1);
  const at = (p) => {
    const pts = p.pts;
    for (let i = 1; i < p.lipIndex; i++) {
      const a = pts[i], c = pts[i + 1];
      if (s >= a[0] && s <= c[0]) return a[1] + (c[1] - a[1]) * ((s - a[0]) / Math.max(1e-6, c[0] - a[0]));
    }
    return pts[p.lipIndex][1];
  };
  return at(profs[j]) * (1 - f) + at(profs[j + 1]) * f;
}

/** 两侧崖面在水线处的轮廓（泡沫带用）：[[x, z], ...]，z 从后往前 */
export function waterlineFace(side) {
  const W = CFG.fieldW;
  return profiles(side).map((p) => {
    const q = p.pts[p.faceStart + FACE_WATER_INDEX];
    return [side === 0 ? q[0] : W - q[0], p.z + q[2]];
  });
}

// ------------------------------------------------------------------ 锚点底座
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
function mat(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _q.setFromEuler(_e.set(rx, ry, rz));
  return _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
}

function emitFootings(b) {
  const W = CFG.fieldW;
  const bolt = new THREE.CylinderGeometry(0.055, 0.055, 0.07, 6);
  for (let side = 0; side < 2; side++) {
    const X = side === 0 ? (s) => s : (s) => W - s;
    const dir = side === 0 ? 1 : -1;
    for (const [ax, ay] of CFG.anchors) {
      const top = ay >= -1e-6, face = ax >= -1e-6;
      if (top) {
        // 顶面压板：上表面高出地面 3 cm
        const w = face ? 0.72 : 0.84;
        const cs = face ? ax - w / 2 + 0.03 : ax;
        const g = new THREE.BoxGeometry(w, 0.16, 1.4);
        b.addGeometry(g, mat(X(cs), -0.05, 0), C.anchor, { vary: 0.03 });
        for (const dz of [-0.5, 0.5]) {
          const bx = face ? [cs - 0.18] : [cs - 0.28, cs + 0.28];
          for (const s of bx) b.addGeometry(bolt, mat(X(s), 0.05, dz), C.joint, { vary: 0.02 });
        }
        g.dispose();
      }
      if (face) {
        // 崖面压板：外表面探出崖面 3 cm
        const hgt = top ? 0.72 : 0.84;
        const cy = top ? ay - hgt / 2 + 0.03 : ay;
        const g = new THREE.BoxGeometry(0.16, hgt, 1.4);
        b.addGeometry(g, mat(X(-0.05), cy, 0), C.anchor, { vary: 0.03 });
        for (const dz of [-0.5, 0.5]) {
          const by = top ? [cy - 0.18] : [cy - 0.28, cy + 0.28];
          for (const y of by) b.addGeometry(bolt, mat(X(0.05), y, dz, 0, 0, dir * Math.PI / 2), C.joint, { vary: 0.02 });
        }
        g.dispose();
      }
    }
  }
  bolt.dispose();
}

// ------------------------------------------------------------------ 布景
// [s, z, 缩放]（左崖本地；右崖镜像并稍作扰动）。全部在 z <= -2.6 或 z >= 3，且在建造区以外
const TREES = [
  [-11.4, -5.0, 1.0], [-12.6, -3.3, 0.8], [-14.6, -6.4, 1.25], [-17.2, -4.0, 1.05], [-19.8, -7.2, 1.35],
  [-13.8, -9.6, 1.4], [-23.5, -5.2, 1.2], [-10.2, -12.0, 1.25], [-7.2, -14.2, 1.3], [-27.5, -10.5, 1.5],
  [-13.2, 4.1, 0.85], [-16.8, 3.5, 1.0], [-21.5, 4.4, 0.9],
];
const ROCKS = [
  [-8.7, -3.0, 0.42], [-10.6, -2.9, 0.3], [-15.6, 4.7, 0.55], [-9.6, 3.3, 0.36],
  [-18.8, -9.8, 0.8], [-5.6, -6.3, 0.4], [-25.5, 3.6, 0.7], [-4.4, -10.8, 0.6],
];
export const FLAG_S = -9.6, FLAG_Z = -3.0, POLE_H = 6.2;

function emitTree(b, x, y, z, sc, seed) {
  const ry = hash(seed, 1) * Math.PI * 2;
  const trunk = new THREE.CylinderGeometry(0.11, 0.17, 1.0, 5);
  b.addGeometry(trunk, mat(x, y + 0.5 * sc - 0.2, z, 0, ry, 0, sc, sc, sc), C.trunk, { vary: 0.05 });
  trunk.dispose();
  const tiers = [[1.05, 1.5, 0.75], [0.82, 1.3, 1.5], [0.56, 1.1, 2.2]];
  tiers.forEach(([r, h, y0], k) => {
    const cone = new THREE.ConeGeometry(r, h, 7);
    const c = k === 0 ? C.treeDark : k === 1 ? C.tree : shade(C.tree, 1.08);
    b.addGeometry(cone, mat(x, y + (y0 + h / 2) * sc - 0.2, z, 0, ry + k * 0.6, 0, sc, sc * (0.92 + 0.16 * hash(seed, k)), sc),
      c, { vary: 0.07, jitter: 0.05, seed: seed * 3 + k });
    cone.dispose();
  });
}

function emitRock(b, x, y, z, sc, seed) {
  const g = new THREE.IcosahedronGeometry(1, 0);
  const yTop = y + sc * 0.15;
  b.addGeometry(g, mat(x, y + sc * 0.25, z, 0, hash(seed, 2) * 6.28, 0, sc * 1.3, sc * 0.75, sc),
    (cx, cy) => (cy > yTop ? C.rock : C.rockDark), { vary: 0.06, jitter: 0.22, seed: seed * 7 });
  g.dispose();
}

function emitScenery(b) {
  const W = CFG.fieldW;
  const mounts = [];
  for (let side = 0; side < 2; side++) {
    const X = side === 0 ? (s) => s : (s) => W - s;
    TREES.forEach(([s0, z0, sc], i) => {
      const s = s0 + (side ? (hash(i, 3) - 0.5) * 1.4 : 0);
      const z = z0 + (side ? (hash(i, 4) - 0.5) * 0.8 : 0);
      const zz = z < 0 ? Math.min(z, -2.9) : Math.max(z, 3.3);
      const scl = sc * (side ? 0.9 + 0.2 * hash(i, 5) : 1);
      emitTree(b, X(s), topHeightAt(side, s, zz), zz, scl, side * 100 + i);
    });
    ROCKS.forEach(([s0, z0, sc], i) => {
      const s = s0 + (side ? (hash(i, 6) - 0.5) * 1.6 : 0);
      emitRock(b, X(s), topHeightAt(side, s, z0), z0, sc, side * 100 + i);
    });
    // 旗杆
    const gy = topHeightAt(side, FLAG_S, FLAG_Z);
    const x = X(FLAG_S);
    const base = new THREE.BoxGeometry(0.62, 0.34, 0.62);
    b.addGeometry(base, mat(x, gy + 0.1, FLAG_Z, 0, 0.3, 0), C.rockDark, { vary: 0.05 });
    base.dispose();
    const pole = new THREE.CylinderGeometry(0.05, 0.075, POLE_H, 6);
    b.addGeometry(pole, mat(x, gy + POLE_H / 2, FLAG_Z), C.pole, { vary: 0.03 });
    pole.dispose();
    const knob = new THREE.IcosahedronGeometry(0.12, 0);
    b.addGeometry(knob, mat(x, gy + POLE_H + 0.08, FLAG_Z), C.pole, { vary: 0.03 });
    knob.dispose();
    mounts.push({ x: x + 0.04, y: gy + POLE_H - 0.12, z: FLAG_Z });
  }
  return mounts;
}

/** 近景：两侧悬崖 + 底座 + 布景，合并成一个网格（投射并接收阴影） */
export function buildTerrain() {
  const b = new GeoBuilder();
  emitCliff(b, 0);
  emitCliff(b, 1);
  const cliffTris = b.triCount;
  emitFootings(b);
  const flagMounts = emitScenery(b);
  return { geometry: b.build(), flagMounts, cliffTris };
}

/** 只含悬崖本体（测试用） */
export function buildCliffsOnly() {
  const b = new GeoBuilder();
  emitCliff(b, 0);
  emitCliff(b, 1);
  return b.build();
}

// ------------------------------------------------------------------ 远景
/** 三层雾中山岛：z -64 / -92 / -126，不投影 */
export function buildBackdrop() {
  const b = new GeoBuilder();
  const layers = [
    { z: -64, depth: 9, color: mix(C.grassDark, C.tree, 0.5), hMin: 2.5, hMax: 7.5, step: 7, islands: [[-78, -40], [-14, 8], [36, 62], [86, 128]] },
    { z: -92, depth: 13, color: mix(C.tree, C.rockDark, 0.45), hMin: 5, hMax: 14, step: 13, islands: [[-230, -60], [-30, 120], [150, 280]] },
    { z: -126, depth: 18, color: mix(C.rockDark, C.fog, 0.3), hMin: 9, hMax: 23, step: 19, islands: [[-320, 360]] },
  ];
  layers.forEach((L, li) => {
    L.islands.forEach(([x0, x1], ii) => {
      const n = Math.max(3, Math.round((x1 - x0) / L.step));
      const ridge = [], skirt = [], base = [];
      for (let k = 0; k <= n; k++) {
        const u = k / n;
        const x = x0 + (x1 - x0) * u + (k > 0 && k < n ? (hash(li, ii * 50 + k, 1) - 0.5) * L.step * 0.5 : 0);
        const env = Math.pow(Math.sin(Math.PI * u), li === 2 ? 0.35 : 0.6);
        const h = (L.hMin + (L.hMax - L.hMin) * hash(li, ii * 50 + k, 2)) * env;
        const z = L.z + (hash(li, ii * 50 + k, 3) - 0.5) * 3;
        ridge.push([x, WY + h, z]);
        skirt.push([x + (hash(li, ii * 50 + k, 4) - 0.5) * L.step * 0.4, WY + h * (0.35 + 0.2 * hash(li, ii * 50 + k, 5)), z + L.depth * 0.55]);
        base.push([x, WY - 0.6, z + L.depth]);
      }
      const hTop = L.hMax;
      const cf = (cx, cy) => shade(L.color, 0.9 + 0.2 * clamp((cy - WY) / hTop, 0, 1));
      for (let k = 0; k < n; k++) {
        const c1 = (ridge[k][1] + skirt[k][1]) / 2;
        b.quad(ridge[k], skirt[k], skirt[k + 1], ridge[k + 1], cf(0, c1), 0.05);
        b.quad(skirt[k], base[k], base[k + 1], skirt[k + 1], cf(0, (skirt[k][1] + WY) / 2), 0.05);
      }
    });
  });
  return b.build();
}
