// 共享视图：蓝图画布和 3D 相机用同一份 (cx, cy, ppm)，
// 这样蓝图淡出、实景淡入时，结构在屏幕上的位置严丝合缝。
//   cx, cy : 屏幕中心对应的世界坐标（米）
//   ppm    : 每米多少 CSS 像素
//   w, h   : 视口尺寸（CSS 像素）

import { getMap } from './map.js';

/** 全景取景范围（世界坐标）：两座堡垒的建造区、中间的地形，水面以下留一截 */
export function fieldBounds(M) {
  const B = M.build;
  let lo = Infinity, hi = M.gMax;
  for (const [x, y] of M.worldGround) if (x >= B.xMin - 3 && x <= M.fieldW - B.xMin + 3) lo = Math.min(lo, y);
  lo = Math.min(lo, M.groundIn(B.xMin - 3));
  const yMin = M.hasWater ? M.waterY - 2.5 : Math.min(lo, B.yMin) - 3;
  return { xMin: B.xMin - 3, xMax: M.fieldW - B.xMin + 3, yMin, yMax: Math.max(B.yMax + 8, hi + 6) };
}
/** 我方建造区取景范围 */
export function buildBounds(M) {
  const B = M.build;
  return { xMin: B.xMin - 2, xMax: B.xMax + 3, yMin: B.yMin - 3, yMax: B.yMax + 2 };
}

export class View {
  constructor(map) {
    this.w = 1280; this.h = 720;
    this.minPpm = 10; this.maxPpm = 110;
    // 平滑动画目标（animateTo 设置，update 推进）
    this._anim = null;
    this.setMap(map);
    this.cx = this.map.fieldW / 2; this.cy = 5; this.ppm = 24;
  }

  /** 换地图：取景范围跟着地图走 */
  setMap(map) {
    this.map = getMap(map);
    this.fieldB = fieldBounds(this.map);
    this.buildB = buildBounds(this.map);
    this.resize(this.w, this.h);
  }

  resize(w, h) {
    this.w = w; this.h = h;
    const F = this.fieldB;
    this.minPpm = Math.min(w / (F.xMax - F.xMin + 30), h / (F.yMax - F.yMin + 14));
  }

  // ---- 坐标换算 ----
  sx(x) { return this.w / 2 + (x - this.cx) * this.ppm; }
  sy(y) { return this.h / 2 - (y - this.cy) * this.ppm; }
  wx(sx) { return this.cx + (sx - this.w / 2) / this.ppm; }
  wy(sy) { return this.cy - (sy - this.h / 2) / this.ppm; }

  // ---- 操作 ----
  /** 以屏幕点 (sx, sy) 为中心缩放 */
  zoomAt(sx, sy, factor) {
    this._anim = null;
    const x = this.wx(sx), y = this.wy(sy);
    this.ppm = Math.min(this.maxPpm, Math.max(this.minPpm, this.ppm * factor));
    this.cx = x - (sx - this.w / 2) / this.ppm;
    this.cy = y + (sy - this.h / 2) / this.ppm;
    this._clamp();
  }
  /** 按屏幕像素平移 */
  panBy(dsx, dsy) {
    this._anim = null;
    this.cx -= dsx / this.ppm; this.cy += dsy / this.ppm;
    this._clamp();
  }
  _clamp() {
    const F = this.fieldB;
    this.cx = Math.min(F.xMax + 4, Math.max(F.xMin - 4, this.cx));
    this.cy = Math.min(F.yMax + 6, Math.max(F.yMin - 2, this.cy));
  }

  /** 让给定世界范围刚好落进视口（留出边距，单位像素）后的目标值 */
  fitTarget(b, pad = { l: 24, r: 24, t: 24, b: 24 }) {
    const aw = Math.max(50, this.w - pad.l - pad.r), ah = Math.max(50, this.h - pad.t - pad.b);
    const ppm = Math.min(aw / (b.xMax - b.xMin), ah / (b.yMax - b.yMin));
    const cx = (b.xMin + b.xMax) / 2 - ((pad.l - pad.r) / 2) / ppm;
    const cy = (b.yMin + b.yMax) / 2 - ((pad.t - pad.b) / 2) / ppm;
    return { cx, cy, ppm };
  }
  fit(b, pad) { const t = this.fitTarget(b, pad); this.cx = t.cx; this.cy = t.cy; this.ppm = t.ppm; this._anim = null; }
  /** 平滑移动到目标取景 */
  animateTo(target, seconds = 0.6) {
    this._anim = { t: 0, dur: seconds, from: { cx: this.cx, cy: this.cy, ppm: this.ppm }, to: target };
  }
  update(dt) {
    const a = this._anim;
    if (!a) return;
    a.t = Math.min(1, a.t + dt / a.dur);
    const e = 1 - Math.pow(1 - a.t, 3);
    this.cx = a.from.cx + (a.to.cx - a.from.cx) * e;
    this.cy = a.from.cy + (a.to.cy - a.from.cy) * e;
    this.ppm = Math.exp(Math.log(a.from.ppm) + (Math.log(a.to.ppm) - Math.log(a.from.ppm)) * e);
    if (a.t >= 1) this._anim = null;
  }
}
