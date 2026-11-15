// 水面：细分平面，CPU 每帧按三个正弦叠加做顶点起伏；浪峰略提亮做柔和高光；
// 深色海床让水显得深；崖脚水线处一圈随浪起伏的白色泡沫带。
// waveHeight 就是网格用的同一个函数，waterLevelAt 直接调用它。

import * as THREE from 'three';
import { CFG } from '../config.js';
import { THEME } from '../theme.js';
import { hash, sstep, col, shade } from './world-geo.js';

// [振幅, kx, kz, 角频率, 相位]；振幅和 0.144 m，不超过 0.16
const W1 = [0.068, 0.58, 0.27, 1.25, 0.0];
const W2 = [0.048, -0.41, 0.74, 1.7, 1.7];
const W3 = [0.028, 1.07, -0.52, 2.35, 0.4];
const AMP_SUM = W1[0] + W2[0] + W3[0];

/** 远处网格粗，振幅渐小以免锯齿闪烁 */
function ampAt(z) {
  if (z > 40) return z > 100 ? 0.4 : 1 - 0.6 * ((z - 40) / 60);
  return z > -25 ? 1 : z < -85 ? 0.25 : 1 - 0.75 * ((-25 - z) / 60);
}

/** 水面高度（米）。x, z 世界坐标，t 秒 */
export function waveHeight(x, z, t) {
  const h = W1[0] * Math.sin(W1[1] * x + W1[2] * z + W1[3] * t + W1[4])
    + W2[0] * Math.sin(W2[1] * x + W2[2] * z + W2[3] * t + W2[4])
    + W3[0] * Math.sin(W3[1] * x + W3[2] * z + W3[3] * t + W3[4]);
  return CFG.waterY + h * ampAt(z);
}

function rowsZ() {
  // 前方一直铺到相机脚下（视野拉远时屏幕底边也落在水面上），近处细、远处粗
  const front = [];
  for (let z = 30, step = 1.6; z < 230; step *= 1.15) { z += step; front.push(z); }
  const zs = front.reverse();
  for (let z = 30; z > -20; z -= 1.6) zs.push(z);
  let z = -20, step = 1.6;
  while (z > -150) { zs.push(z); step *= 1.2; z -= step; }
  zs.push(-150);
  return zs;
}

export class Water {
  /** faceLines: [左崖水线, 右崖水线]，每条为 [[x, z], ...]（z 从后往前） */
  constructor(faceLines) {
    this.group = new THREE.Group();
    this.group.name = 'water';
    this._buildSurface();
    this._buildSeabed();
    this._buildFoam(faceLines);
  }

  _buildSurface() {
    const zs = rowsZ();
    const NX = 86;
    const nz = zs.length;
    const n = (NX + 1) * nz;
    const pos = new Float32Array(n * 3);
    const colr = new Float32Array(n * 3);
    const base = new Float32Array(n * 3);
    const nrm = new Float32Array(n * 3);
    const cNear = col(THEME.world.water), cFar = col(THEME.world.waterDeep);
    const cx = CFG.fieldW / 2;
    let v = 0;
    for (let k = 0; k < nz; k++) {
      const z = zs[k];
      const widen = Math.max(0, -z - 20) * 0.75;
      const xL = -70 - widen, xR = 100 + widen;
      for (let i = 0; i <= NX; i++, v++) {
        const x = xL + (xR - xL) * (i / NX);
        pos[v * 3] = x; pos[v * 3 + 1] = CFG.waterY; pos[v * 3 + 2] = z;
        nrm[v * 3 + 1] = 1;
        const d = Math.hypot((x - cx) / 1.4, z);
        const t = sstep(10, 75, d);
        base[v * 3] = cNear.r + (cFar.r - cNear.r) * t;
        base[v * 3 + 1] = cNear.g + (cFar.g - cNear.g) * t;
        base[v * 3 + 2] = cNear.b + (cFar.b - cNear.b) * t;
      }
    }
    const idx = [];
    for (let k = 0; k < nz - 1; k++) {
      for (let i = 0; i < NX; i++) {
        const a = k * (NX + 1) + i, b = a + 1, c = a + (NX + 1), d = c + 1;
        // a 前左, b 前右, c 后左, d 后右 → 朝上
        idx.push(a, b, d, a, d, c);
      }
    }
    colr.set(base);
    const geo = new THREE.BufferGeometry();
    const pa = new THREE.BufferAttribute(pos, 3); pa.setUsage(THREE.DynamicDrawUsage);
    const ca = new THREE.BufferAttribute(colr, 3); ca.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', pa);
    geo.setAttribute('color', ca);
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, flatShading: true, roughness: 0.32, metalness: 0,
      transparent: true, opacity: 0.84,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'water-surface';
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.renderOrder = -2; // 透明物体里最先画：水上的特效叠在水面之上，水下部分被水面深度挡住
    this.group.add(mesh);
    this.surface = mesh;
    this._pos = pos; this._col = colr; this._base = base; this._n = n;
    this._pa = pa; this._ca = ca;
    const hi = col(THEME.world.foam);
    this._hi = [hi.r, hi.g, hi.b];
  }

  _buildSeabed() {
    const g = new THREE.PlaneGeometry(420, 380, 1, 1);
    g.rotateX(-Math.PI / 2);
    g.translate(15, CFG.seabedY - 0.6, -20);
    // 海床：waterDeep 大幅压暗
    const m = new THREE.MeshStandardMaterial({ color: shade(col(THEME.world.waterDeep), 0.3), roughness: 1, metalness: 0 });
    const mesh = new THREE.Mesh(g, m);
    mesh.name = 'seabed';
    this.group.add(mesh);
  }

  _buildFoam(faceLines) {
    const strips = [];
    faceLines.forEach((line, side) => {
      const dir = side === 0 ? 1 : -1;
      // 加密：每两个剖面之间插 3 个点
      const pts = [];
      for (let i = 0; i < line.length - 1; i++) {
        const [x0, z0] = line[i], [x1, z1] = line[i + 1];
        for (let k = 0; k < 4; k++) {
          const u = k / 4;
          pts.push([x0 + (x1 - x0) * u, z0 + (z1 - z0) * u]);
        }
      }
      pts.push(line[line.length - 1]);
      strips.push({ dir, pts });
    });
    let nv = 0;
    for (const s of strips) nv += s.pts.length * 2;
    const pos = new Float32Array(nv * 3);
    const nrm = new Float32Array(nv * 3);
    const info = new Float32Array(nv * 4); // 每顶点：x0, z, 外扩方向 * 基础宽度（内侧为 0）, 相位
    const idx = [];
    let v = 0;
    strips.forEach((s, si) => {
      const start = v;
      s.pts.forEach(([x, z], i) => {
        const w = 0.32 + 0.3 * hash(si, i, 9);
        const ph = hash(si, i, 10) * 6.28;
        // 内侧：稍微压进岩体里
        info.set([x - s.dir * 0.12, z, 0, ph], v * 4); nrm[v * 3 + 1] = 1; v++;
        info.set([x, z, s.dir * w, ph], v * 4); nrm[v * 3 + 1] = 1; v++;
      });
      for (let i = 0; i < s.pts.length - 1; i++) {
        const a = start + i * 2, b = a + 1, c = a + 2, d = a + 3;
        idx.push(a, c, d, a, d, b);
      }
    });
    const geo = new THREE.BufferGeometry();
    const pa = new THREE.BufferAttribute(pos, 3); pa.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', pa);
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setIndex(idx);
    const foam = col(THEME.world.foam);
    const mat = new THREE.MeshStandardMaterial({
      color: foam, emissive: foam, emissiveIntensity: 0.18, roughness: 0.9, metalness: 0,
      flatShading: true, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'foam';
    mesh.frustumCulled = false;
    mesh.renderOrder = -1;
    this.group.add(mesh);
    this._foamPos = pos; this._foamInfo = info; this._foamN = nv; this._foamPa = pa;
    this.update(0);
  }

  update(t) {
    const pos = this._pos, colr = this._col, base = this._base, n = this._n;
    const hr = this._hi[0], hg = this._hi[1], hb = this._hi[2];
    const wy = CFG.waterY, inv = 1 / AMP_SUM;
    for (let v = 0, o = 0; v < n; v++, o += 3) {
      const y = waveHeight(pos[o], pos[o + 2], t);
      pos[o + 1] = y;
      // 浪峰提亮
      let c = (y - wy) * inv;
      c = c > 0 ? c * c * 0.2 : 0;
      colr[o] = base[o] + (hr - base[o]) * c;
      colr[o + 1] = base[o + 1] + (hg - base[o + 1]) * c;
      colr[o + 2] = base[o + 2] + (hb - base[o + 2]) * c;
    }
    this._pa.needsUpdate = true;
    this._ca.needsUpdate = true;

    const fp = this._foamPos, fi = this._foamInfo, fn = this._foamN;
    if (!fp) return;
    for (let v = 0; v < fn; v++) {
      const x0 = fi[v * 4], z = fi[v * 4 + 1], w = fi[v * 4 + 2], ph = fi[v * 4 + 3];
      const x = x0 + w * (0.8 + 0.3 * Math.sin(t * 1.6 + ph));
      fp[v * 3] = x;
      fp[v * 3 + 1] = waveHeight(x, z, t) + 0.055;
      fp[v * 3 + 2] = z;
    }
    this._foamPa.needsUpdate = true;
  }
}
