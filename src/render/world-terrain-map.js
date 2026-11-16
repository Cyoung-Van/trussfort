// 按地图数据生成的实景地形（「海峡」以外的地图用；海峡有自己手调的悬崖，见 world-terrain.js）。
//
// 做法：把地图的地表折线沿 z 放样。|z| <= BAND 的那一条和物理完全一致；
// 带外才加起伏和扰动。往后（z 负方向）一直铺进雾里；往前（朝相机）地形渐渐收平：
// 有水的地图沉到水面以下，露出前景的水；没水的地图收成一片平地，不挡镜头。
// 颜色、树、石头、旗杆、锚点底座都沿用海峡那一套，画风一致。

import * as THREE from 'three';
import { GeoBuilder, hash, clamp, sstep } from './world-geo.js';
import { BAND, TERRAIN_COLORS as C, placeMatrix as mat, emitTree, emitRock, FLAG_Z, POLE_H } from './world-terrain.js';

// 放样用的 z 位置（从后往前）
const ROWS = [-150, -112, -84, -62, -46, -34, -25, -18.5, -13.5, -10, -7.4, -5.4, -3.8, -2.6, -BAND, BAND, 2.5, 3.6, 5, 6.8, 9.2, 12.5, 17, 24, 34, 50, 80, 130, 230];
const X_PAD = 130;   // 场地两侧各铺多远

/** 沿地表折线取一串点：每个转折点都在，长段再细分（靠近场地的分得密） */
function columns(M) {
  const xl = -X_PAD, xr = M.fieldW + X_PAD;
  const out = [];
  const push = (x, y, seg) => {
    const q = out[out.length - 1];
    if (q && Math.abs(q.x - x) < 1e-6 && Math.abs(q.y - y) < 1e-6) return;
    out.push({ x, y, seg });
  };
  for (const s of M.segs) {
    let ax = s.ax, ay = s.ay, bx = s.bx, by = s.by;
    if (bx < xl || ax > xr) continue;
    if (s.kind !== 'v') {
      if (ax < xl) { ay += (by - ay) * (xl - ax) / (bx - ax); ax = xl; }
      if (bx > xr) { by = ay + (by - ay) * (xr - ax) / (bx - ax); bx = xr; }
    }
    const near = Math.max(ax, bx) > -14 && Math.min(ax, bx) < M.fieldW + 14;
    const step = s.kind === 'v' ? 1.7 : near ? 2.1 : 9;
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 0; k <= n; k++) push(ax + (bx - ax) * (k / n), ay + (by - ay) * (k / n), s);
  }
  return out;
}

function levels(M) {
  const base = M.localGround[0][1];                 // 己方后方的地面高度
  return { base, front: M.hasWater ? M.waterY - 2.6 : base };
}

/** 一个放样点在第 z 行的位置。i 是列号（只用来取扰动） */
function place(M, L, c, i, z) {
  const az = Math.abs(z);
  if (az <= BAND + 1e-6) return [c.x, c.y, z];
  const t = clamp((az - BAND) / 1.6, 0, 1);
  const H = (k) => hash(i * 7 + 3, Math.round(z * 10), k);
  let x = c.x + (H(1) - 0.5) * 0.5 * t, y = c.y + (H(2) - 0.5) * 0.14 * t, dz = (H(3) - 0.5) * 0.4 * t;
  if (z > 0) {
    // 朝相机方向收平
    const f = M.hasWater ? sstep(4.4, 7.6, z) : sstep(2.2, 9.5, z);
    y += (L.front - y) * f;
    if (M.hasWater && c.y > M.waterY) x += (c.x < M.fieldW / 2 ? -1 : 1) * 2.2 * f;   // 岸线往后退一点，收头不显得齐
  } else {
    // 没水的地图：场地里的土梁、沟壑往后也渐渐收平，成为一座有头有尾的小山，而不是一道伸到天边的墙
    if (!M.hasWater) y += (L.base - y) * sstep(-6, -27, z);
    // 场地两侧远处、后方：陆地隆起成缓丘
    const out = Math.max(M.build.xMin - c.x, c.x - (M.fieldW - M.build.xMin), 0);
    if (c.y > M.waterY + 0.4) y += sstep(-3.5, -14, z) * sstep(2, 20, out) * (1.4 + 2.6 * H(4));
  }
  return [x, y, z + dz];
}

/** 地表高度（布景落地用）：不带扰动的近似 */
function surfaceY(M, L, x, z) {
  let y = M.groundTop(x);
  if (z > BAND) y += (L.front - y) * (M.hasWater ? sstep(4.4, 7.6, z) : sstep(2.2, 9.5, z));
  else if (z < -BAND && !M.hasWater) y += (L.base - y) * sstep(-6, -27, z);
  return y;
}

function quadColor(M, seg, ymid, a, b) {
  if (M.hasWater && ymid < M.waterY - 1.2) return C.under;
  if (M.hasWater && ymid < M.waterY + 0.9) return C.rockWet;
  const steep = seg.kind === 'v' || Math.abs(seg.ey / seg.ex) > 0.75;   // 坡度超过约 37 度露出岩石
  if (!steep) return hash(a, b, 5) < 0.3 ? C.grassDark : C.grass;
  // 岩层：按高度分带
  return Math.floor((ymid + 200) / 1.7) % 2 ? C.rock : C.rockDark;
}

function emitLoft(b, M, L) {
  const cols = columns(M);
  const rings = ROWS.map((z) => cols.map((c, i) => place(M, L, c, i, z)));
  for (let j = 0; j < rings.length - 1; j++) {
    const A = rings[j], B = rings[j + 1];
    const inBand = Math.abs(ROWS[j]) <= BAND + 1e-6 && Math.abs(ROWS[j + 1]) <= BAND + 1e-6;
    for (let i = 0; i < cols.length - 1; i++) {
      const p = A[i], q = A[i + 1], r = B[i + 1], s = B[i];
      const seg = cols[i + 1].seg;
      const ymid = (p[1] + q[1] + r[1] + s[1]) / 4;
      // 前景收平以后原来的崖壁也躺平了：按实际坡度重新判断颜色
      const flatNow = !inBand && ROWS[j] > BAND && Math.abs(q[1] - p[1]) < 0.75 * Math.abs(q[0] - p[0]);
      const color = flatNow && !(M.hasWater && ymid < M.waterY + 0.9)
        ? (hash(i, j, 5) < 0.3 ? C.grassDark : C.grass)
        : quadColor(M, seg, ymid, i, j);
      b.tri(p, s, r, color);
      b.tri(p, r, q, color);
    }
  }
}

function emitFootings(b, M) {
  const bolt = new THREE.CylinderGeometry(0.055, 0.055, 0.07, 6);
  for (let side = 0; side < 2; side++) {
    for (const [lx, y] of M.anchors) {
      const x = side === 0 ? lx : M.fieldW - lx;
      if (M.surfaceKind(lx, y) === 'wall') {
        // 崖面压板：朝外探出 3 cm。实心的一侧在哪边，板就贴在哪边
        const dir = M.inside(x - 0.2, y) ? 1 : -1;
        const g = new THREE.BoxGeometry(0.16, 0.84, 1.4);
        b.addGeometry(g, mat(x - dir * 0.05, y, 0), C.anchor, { vary: 0.03 });
        g.dispose();
        for (const dz of [-0.5, 0.5]) for (const dy of [-0.28, 0.28]) b.addGeometry(bolt, mat(x + dir * 0.05, y + dy, dz, 0, 0, dir * Math.PI / 2), C.joint, { vary: 0.02 });
      } else {
        // 顶面压板：顺着坡面放，上表面高出地面 3 cm
        const seg = M.segs.find((s) => s.kind !== 'v' && x >= s.ax - 1e-6 && x <= s.bx + 1e-6 && Math.abs(s.ay + (x - s.ax) * s.slope - y) < 1e-3) || null;
        const ang = seg ? Math.atan2(seg.ey, seg.ex) : 0;
        const nx = -Math.sin(ang), ny = Math.cos(ang);
        const g = new THREE.BoxGeometry(0.84, 0.16, 1.4);
        b.addGeometry(g, mat(x - nx * 0.05, y - ny * 0.05, 0, 0, 0, ang), C.anchor, { vary: 0.03 });
        g.dispose();
        for (const dz of [-0.5, 0.5]) for (const ds of [-0.28, 0.28]) {
          b.addGeometry(bolt, mat(x + Math.cos(ang) * ds + nx * 0.05, y + Math.sin(ang) * ds + ny * 0.05, dz, 0, 0, ang), C.joint, { vary: 0.02 });
        }
      }
    }
  }
  bolt.dispose();
}

function emitScenery(b, M, L) {
  const W = M.fieldW, B = M.build;
  const dry = (x) => !M.hasWater || M.groundTop(x) > M.waterY + 0.8;
  const level = (x) => Math.abs(M.groundTop(x + 0.7) - M.groundTop(x - 0.7)) < 0.5;
  const inBuild = (x) => (x > B.xMin - 1.5 && x < B.xMax + 1.5) || (x > W - B.xMax - 1.5 && x < W - B.xMin + 1.5);
  let trees = 0, rocks = 0;
  for (let i = 0; i < 90 && trees < 26; i++) {
    const x = -34 + (W + 68) * hash(i, 61);
    let z = -3 - 13 * hash(i, 62);
    if (inBuild(x)) z = Math.min(z, -8.5);      // 堡垒正后方的树离远一点，别和结构叠在一起
    if (!dry(x) || !level(x)) continue;
    emitTree(b, x, surfaceY(M, L, x, z), z, 0.8 + 0.7 * hash(i, 63), 300 + i);
    trees++;
  }
  for (let i = 0; i < 40 && rocks < 12; i++) {
    const x = -30 + (W + 60) * hash(i, 71);
    const front = hash(i, 72) < 0.35 && !M.hasWater;
    const z = front ? 3.2 + 3 * hash(i, 73) : -2.9 - 9 * hash(i, 73);
    if (!dry(x) || !level(x)) continue;
    emitRock(b, x, surfaceY(M, L, x, z), z, 0.3 + 0.5 * hash(i, 74), 400 + i);
    rocks++;
  }
  // 旗杆：各自建造区的后方
  const mounts = [];
  for (let side = 0; side < 2; side++) {
    const lx = B.xMin - 1.6;
    const x = side === 0 ? lx : W - lx;
    const gy = surfaceY(M, L, x, FLAG_Z);
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

/** 水线处的岸线（泡沫带用）：[{ dir, line: [[x, z], ...] }]，dir 指向水的一侧 */
function shoreLines(M) {
  if (!M.hasWater) return [];
  const out = [];
  const zs = ROWS.filter((z) => z >= -18.5 && z <= 5);
  for (const [x0, x1] of M.waterSpans) {
    if (x0 > -X_PAD + 1) out.push({ dir: 1, line: zs.map((z) => [x0, z]) });
    if (x1 < M.fieldW + X_PAD - 1) out.push({ dir: -1, line: zs.map((z) => [x1, z]) });
  }
  return out;
}

/** 近景地形 + 底座 + 布景，合并成一个网格 */
export function buildMapTerrain(M) {
  const b = new GeoBuilder();
  const L = levels(M);
  emitLoft(b, M, L);
  emitFootings(b, M);
  const flagMounts = emitScenery(b, M, L);
  return { geometry: b.build(), flagMounts, shore: shoreLines(M), baseY: L.base };
}
