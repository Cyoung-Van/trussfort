// 实景静态几何的小工具：按材质合并的三角形收集器、确定性哈希、颜色运算。
// 所有颜色都是 THREE.Color（线性空间），由 THEME 里的 sRGB 十六进制值换算而来。

import * as THREE from 'three';

/** 确定性哈希 → [0, 1)。渲染层用固定种子，保证每次打开场景都一样 */
export function hash(a, b = 0, c = 0) {
  let h = Math.imul((a * 73856093) | 0, 0x27d4eb2d) ^ Math.imul((b * 19349663) | 0, 0x165667b1) ^ Math.imul((c * 83492791) | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function smooth01(t) { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }
/** a→b 之间的平滑阶跃（a > b 时反向） */
export function sstep(a, b, x) { return smooth01((x - a) / (b - a)); }

// ---- 颜色 ----
export function col(hex) { return new THREE.Color(hex); }
export function shade(c, k) { return new THREE.Color(c.r * k, c.g * k, c.b * k); }
export function mix(a, b, t) { return new THREE.Color(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t); }

const _v = new THREE.Vector3();

/**
 * 非索引三角形收集器。每个三角形一种颜色（配合 flatShading 出低多边形块面）。
 * flip = true 时翻转环绕方向（镜像到右崖时用）。
 */
export class GeoBuilder {
  constructor() { this.pos = []; this.col = []; this.flip = false; this._n = 0; }

  tri(a, b, c, color, vary = 0.05) {
    if (this.flip) { const t = b; b = c; c = t; }
    const k = 1 + (hash(this._n++, 7, 11) - 0.5) * 2 * vary;
    const r = color.r * k, g = color.g * k, bl = color.b * k;
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (let i = 0; i < 3; i++) this.col.push(r, g, bl);
  }

  /** 四边形 a b c d（逆时针）拆成两个三角形 */
  quad(a, b, c, d, color, vary) { this.tri(a, b, c, color, vary); this.tri(a, c, d, color, vary); }

  /**
   * 把一个 three 几何体按矩阵变换后并入。colorFn(cx, cy, cz, triIndex) 返回该三角形的颜色，
   * 也可以直接传一个 THREE.Color。jitter > 0 时对顶点做确定性扰动（低多边形岩石 / 树冠）。
   */
  addGeometry(geom, matrix, color, { vary = 0.05, jitter = 0, seed = 0 } = {}) {
    const g = geom.index ? geom.toNonIndexed() : geom;
    const p = g.attributes.position;
    const pts = [];
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i);
      if (jitter > 0) {
        // 同一位置的顶点扰动相同，保持网格闭合
        const kx = Math.round(_v.x * 1000), ky = Math.round(_v.y * 1000), kz = Math.round(_v.z * 1000);
        _v.x += (hash(kx, ky, kz + seed) - 0.5) * 2 * jitter;
        _v.y += (hash(ky, kz, kx + seed + 1) - 0.5) * 2 * jitter;
        _v.z += (hash(kz, kx, ky + seed + 2) - 0.5) * 2 * jitter;
      }
      if (matrix) _v.applyMatrix4(matrix);
      pts.push([_v.x, _v.y, _v.z]);
    }
    for (let i = 0; i + 2 < pts.length; i += 3) {
      const a = pts[i], b = pts[i + 1], c = pts[i + 2];
      const cc = typeof color === 'function'
        ? color((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3, i / 3)
        : color;
      this.tri(a, b, c, cc, vary);
    }
    if (g !== geom) g.dispose();
  }

  get triCount() { return this.pos.length / 9; }

  build() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.computeVertexNormals(); // 非索引 → 每个三角形自己的面法线（阴影 normalBias 要用）
    geo.computeBoundingSphere();
    return geo;
  }
}
