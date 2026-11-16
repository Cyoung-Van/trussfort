// 蓝图画布的绘制原语。只画，不碰蓝图数据。
// 颜色一律来自 THEME.bp；需要的派生色（加深 / 透明度）在这里由已有色值算出。

import { CFG, CANNON, CORE } from '../config.js';
import { THEME } from '../theme.js';
import { getMap } from '../map.js';

const BP = THEME.bp;

export const FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif';
export const MONO = 'ui-monospace,"SF Mono",Menlo,Consolas,monospace';

// ---------- 颜色工具 ----------
function parseHex(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const _rgbaCache = new Map();
/** '#rrggbb' + 透明度 → 'rgba(...)' */
export function rgba(hex, a) {
  const k = hex + a;
  let s = _rgbaCache.get(k);
  if (!s) {
    const [r, g, b] = parseHex(hex);
    s = `rgba(${r},${g},${b},${a})`;
    if (_rgbaCache.size < 4000) _rgbaCache.set(k, s);
  }
  return s;
}
/** 两个 '#rrggbb' 线性混合 */
export function mix(h1, h2, t) {
  const a = parseHex(h1), b = parseHex(h2);
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

// 派生色：价签底色 = paperEdge 再压暗 35%
export const CHIP_BG = rgba(mix(BP.paperEdge, '#000000', 0.35), 0.9);
export const PAPER_DEEP = mix(BP.paperEdge, '#000000', 0.18);

export function money(n) { return '$' + Math.round(n).toLocaleString('en-US'); }

// ---------- 画家 ----------
export class Painter {
  constructor(ctx) {
    this.ctx = ctx;
    this.view = null; this.dpr = 1; this.w = 1; this.h = 1; this.time = 0;
    this.map = getMap();
    this._vig = null; this._vigKey = '';
  }
  /** map：当前地图（地形、水面、建造区都按它画） */
  frame(view, dpr, w, h, time, map) { this.view = view; this.dpr = dpr; this.w = w; this.h = h; this.time = time; if (map) this.map = map; }

  sx(x) { return this.view.sx(x); }
  sy(y) { return this.view.sy(y); }
  /** 把坐标对齐到设备像素，让给定线宽（CSS 像素）的直线落得干净 */
  al(v, lw = 1) {
    const dev = Math.max(1, Math.round(lw * this.dpr));
    const off = dev % 2 ? 0.5 : 0;
    return (Math.round(v * this.dpr - off) + off) / this.dpr;
  }
  textW(t) {
    const m = this.ctx.measureText(t);
    return m && typeof m.width === 'number' ? m.width : t.length * 7;
  }

  // ---------- 图纸 ----------
  paper() {
    const c = this.ctx, w = this.w, h = this.h;
    c.fillStyle = BP.paper;
    c.fillRect(0, 0, w, h);
    const key = w + 'x' + h;
    if (this._vigKey !== key) {
      const g = c.createRadialGradient(w / 2, h * 0.46, Math.min(w, h) * 0.32, w / 2, h * 0.46, Math.hypot(w, h) * 0.62);
      if (g && g.addColorStop) {
        g.addColorStop(0, rgba(BP.paperEdge, 0));
        g.addColorStop(0.55, rgba(BP.paperEdge, 0.45));
        g.addColorStop(1, rgba(BP.paperEdge, 1));
      }
      this._vig = g; this._vigKey = key;
    }
    c.fillStyle = this._vig;
    c.fillRect(0, 0, w, h);
  }

  grid() {
    const c = this.ctx, v = this.view, w = this.w, h = this.h, g = CFG.grid;
    const x0 = v.wx(0), x1 = v.wx(w), y0 = v.wy(h), y1 = v.wy(0);
    // 1 米细网格
    if (v.ppm >= 14) {
      c.beginPath();
      for (let x = Math.ceil(x0 / g) * g; x <= x1; x += g) {
        if (Math.abs(x / 5 - Math.round(x / 5)) < 1e-6) continue;
        const s = this.al(v.sx(x)); c.moveTo(s, 0); c.lineTo(s, h);
      }
      for (let y = Math.ceil(y0 / g) * g; y <= y1; y += g) {
        if (Math.abs(y / 5 - Math.round(y / 5)) < 1e-6) continue;
        const s = this.al(v.sy(y)); c.moveTo(0, s); c.lineTo(w, s);
      }
      c.strokeStyle = BP.gridMinor; c.lineWidth = 1; c.stroke();
    }
    // 5 米粗网格
    c.beginPath();
    for (let x = Math.ceil(x0 / 5) * 5; x <= x1; x += 5) { const s = this.al(v.sx(x)); c.moveTo(s, 0); c.lineTo(s, h); }
    for (let y = Math.ceil(y0 / 5) * 5; y <= y1; y += 5) { const s = this.al(v.sy(y)); c.moveTo(0, s); c.lineTo(w, s); }
    c.strokeStyle = BP.gridMajor; c.lineWidth = 1; c.stroke();

    // 建造区边上的米数标注
    if (v.ppm >= 11) {
      const B = this.map.build;
      c.font = `10px ${MONO}`;
      c.fillStyle = BP.inkFaint;
      c.textBaseline = 'bottom'; c.textAlign = 'center';
      const ty = v.sy(B.yMax) - 5;
      for (let x = Math.ceil(B.xMin / 5) * 5; x <= B.xMax; x += 5) c.fillText(String(x), v.sx(x), ty);
      c.textBaseline = 'middle'; c.textAlign = 'right';
      const tx = v.sx(B.xMin) - 6;
      for (let y = Math.ceil(B.yMin / 5) * 5; y <= B.yMax; y += 5) c.fillText(String(y), tx, v.sy(y));
    }
  }

  // ---------- 地形剖面 ----------
  /** 地表折线的屏幕坐标（两头伸出画面） */
  _groundPts(align) {
    const v = this.view, w = this.w, h = this.h;
    const out = [];
    for (const [x, y] of this.map.worldGround) {
      let sx = v.sx(x), sy = v.sy(y);
      sx = sx < -40 ? -40 : sx > w + 40 ? w + 40 : sx;      // 两头的点在千米之外，夹到画面边上
      sy = sy < -4 * h ? -4 * h : sy > 5 * h ? 5 * h : sy;
      out.push(align ? [this.al(sx, 2), this.al(sy, 2)] : [sx, sy]);
    }
    return out;
  }
  _terrainPath() {
    const c = this.ctx, h = this.h;
    const pts = this._groundPts(false);
    c.beginPath();
    pts.forEach(([x, y], i) => { if (i === 0) c.moveTo(x, y); else c.lineTo(x, y); });
    c.lineTo(pts[pts.length - 1][0], 6 * h);
    c.lineTo(pts[0][0], 6 * h);
    c.closePath();
  }

  water() {
    const M = this.map;
    if (!M.hasWater) return;
    const c = this.ctx, v = this.view, t = this.time, h = this.h;
    const wave = (x) => M.waterY + 0.07 * Math.sin(x * 1.25 + t * 1.6) + 0.045 * Math.sin(x * 2.9 - t * 1.15);
    let widest = null;
    for (const [x0, x1] of M.waterSpans) {
      // 只画落在画面里的那一段
      const a = Math.max(x0, v.wx(-20)), b = Math.min(x1, v.wx(this.w + 20));
      if (b <= a) continue;
      if (!widest || x1 - x0 > widest[1] - widest[0]) widest = [x0, x1];
      const n = Math.max(8, Math.ceil((v.sx(b) - v.sx(a)) / 10));
      const line = () => {
        for (let i = 0; i <= n; i++) {
          const x = a + ((b - a) * i) / n;
          const px = v.sx(x), py = v.sy(wave(x));
          if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
        }
      };
      // 水体：上边是波浪线，下边沿着水底的地形走回来
      c.beginPath(); line();
      const bed = M.worldGround.filter(([x]) => x >= a - 1e-6 && x <= b + 1e-6);
      c.lineTo(v.sx(b), v.sy(Math.min(M.waterY, M.groundIn(b))));
      for (let i = bed.length - 1; i >= 0; i--) c.lineTo(v.sx(bed[i][0]), Math.min(h + 10, v.sy(Math.min(M.waterY, bed[i][1]))));
      c.lineTo(v.sx(a), v.sy(Math.min(M.waterY, M.groundIn(a))));
      c.closePath();
      c.fillStyle = BP.water; c.fill();
      c.beginPath(); line();
      c.strokeStyle = BP.waterLine; c.lineWidth = 1.5; c.lineJoin = 'round'; c.stroke();
    }
    if (!widest) return;
    // 剖面图里的水面符号：三道渐短的短线，画在最宽的那片水中间
    const cx = v.sx((widest[0] + widest[1]) / 2), y0 = v.sy(M.waterY);
    const k0 = Math.min(1.4, v.ppm / 24, (v.sx(widest[1]) - v.sx(widest[0])) / 60);
    c.beginPath();
    for (let k = 0; k < 3; k++) {
      const half = (22 - k * 7) * k0;
      const yy = this.al(y0 + (k + 1) * 5 * Math.min(1.4, v.ppm / 24));
      c.moveTo(cx - half, yy); c.lineTo(cx + half, yy);
    }
    c.strokeStyle = BP.waterLine; c.globalAlpha = 0.45; c.lineWidth = 1; c.stroke(); c.globalAlpha = 1;
  }

  terrain() {
    const c = this.ctx, v = this.view, w = this.w, h = this.h;
    this._terrainPath();
    c.fillStyle = BP.terrainFill; c.fill();
    // 45 度剖面线，间距按屏幕像素固定，相位钉在世界原点上，平移时不游动
    c.save();
    this._terrainPath();
    c.clip();
    const s = 9;
    const phase = ((v.sx(0) + v.sy(0)) % s + s) % s;
    c.beginPath();
    for (let k = phase - h; k < w + h; k += s) { c.moveTo(k, 0); c.lineTo(k - h, h); }
    c.strokeStyle = BP.terrainHatch; c.lineWidth = 1; c.stroke();
    c.restore();
    // 地表的实线
    c.beginPath();
    this._groundPts(true).forEach(([x, y], i) => { if (i === 0) c.moveTo(x, y); else c.lineTo(x, y); });
    c.strokeStyle = BP.ink; c.lineWidth = 2; c.lineJoin = 'miter'; c.stroke();
  }

  // ---------- 建造区 ----------
  /** 建造区的轮廓：矩形里露在地面以上的那部分（屏幕坐标的点列） */
  _zonePts(mirror) {
    const M = this.map, v = this.view, B = M.build, W = M.fieldW;
    const X = (x) => v.sx(mirror ? W - x : x);
    // 上边和两条侧边照矩形走；下边沿着地表走（地表低于矩形下沿的地方走矩形下沿）
    const floor = (x) => Math.max(B.yMin, Math.min(B.yMax, M.groundTop(x)));
    const xs = [B.xMin];
    for (const [x] of M.localGround) if (x > B.xMin + 1e-6 && x < B.xMax - 1e-6 && x > xs[xs.length - 1] + 1e-6) xs.push(x);
    xs.push(B.xMax);
    const pts = [[X(B.xMin), v.sy(B.yMax)], [X(B.xMax), v.sy(B.yMax)]];
    for (let i = xs.length - 1; i >= 0; i--) {
      const x = xs[i];
      // 崖壁处地表有高低两个值：从右往左走，先到低的一侧，再到高的一侧
      const lo = Math.max(B.yMin, Math.min(B.yMax, M.groundIn(x))), hi = floor(x);
      pts.push([X(x), v.sy(lo)]);
      if (hi - lo > 1e-6) pts.push([X(x), v.sy(hi)]);
    }
    return pts.map(([x, y]) => [this.al(x), this.al(y)]);
  }
  zone(mirror, alpha, label) {
    const c = this.ctx, v = this.view, B = this.map.build, W = this.map.fieldW;
    const X = (x) => v.sx(mirror ? W - x : x);
    c.beginPath();
    roundPoly(c, this._zonePts(mirror), 7);
    c.globalAlpha = alpha;
    c.setLineDash([7, 5]); c.lineDashOffset = 0;
    c.strokeStyle = BP.zone; c.lineWidth = 1; c.stroke();
    c.setLineDash([]);
    if (label) {
      c.font = `600 11px ${FONT}`; c.fillStyle = BP.zone; c.textAlign = 'left'; c.textBaseline = 'top';
      c.fillText(label, X(B.xMin) + 8, v.sy(B.yMax) + 7);
    }
    c.globalAlpha = 1;
  }
  /** 核心可以放的范围：一圈点线，拖动核心时才亮起来 */
  coreZone(mirror, alpha, color, label) {
    const c = this.ctx, v = this.view, Z = this.map.coreZone, W = this.map.fieldW;
    if (!Z || alpha <= 0) return;
    const xa = v.sx(mirror ? W - Z.xMax : Z.xMin), xb = v.sx(mirror ? W - Z.xMin : Z.xMax);
    const ya = v.sy(Z.yMax), yb = v.sy(Z.yMin);
    const pad = Math.min(14, 0.5 * v.ppm);
    c.globalAlpha = alpha;
    c.beginPath();
    roundRect(c, this.al(xa - pad), this.al(ya - pad), xb - xa + pad * 2, yb - ya + pad * 2, 8);
    c.setLineDash([2, 5]); c.lineDashOffset = 0; c.lineCap = 'round';
    c.strokeStyle = color; c.lineWidth = 1.5; c.stroke();
    c.setLineDash([]); c.lineCap = 'butt';
    if (label) {
      c.font = `600 11px ${FONT}`; c.fillStyle = color; c.textAlign = 'right'; c.textBaseline = 'bottom';
      c.fillText(label, xb + pad - 6, ya - pad - 4);
    }
    c.globalAlpha = 1;
  }

  // ---------- 杆件 ----------
  /** 屏幕坐标下画一根杆件；color 覆盖材料色；w 是线宽（像素） */
  member(ax, ay, bx, by, mat, color, w, alpha = 1) {
    const c = this.ctx;
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    if (L < 0.5) return;
    const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
    c.globalAlpha = alpha;
    c.lineCap = 'round'; c.lineJoin = 'round';
    if (mat === 'wood') {
      c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by);
      c.strokeStyle = color; c.lineWidth = w; c.stroke();
    } else if (mat === 'steel') {
      const hw = Math.max(2, w / 2);
      const ew = Math.max(1.1, hw * 0.42);
      c.beginPath();
      c.moveTo(ax + nx * hw, ay + ny * hw); c.lineTo(bx + nx * hw, by + ny * hw);
      c.lineTo(bx - nx * hw, by - ny * hw); c.lineTo(ax - nx * hw, ay - ny * hw); c.closePath();
      c.globalAlpha = alpha * 0.25; c.fillStyle = color; c.fill();
      c.globalAlpha = alpha;
      c.beginPath();
      c.moveTo(ax + nx * hw, ay + ny * hw); c.lineTo(bx + nx * hw, by + ny * hw);
      c.moveTo(ax - nx * hw, ay - ny * hw); c.lineTo(bx - nx * hw, by - ny * hw);
      c.strokeStyle = color; c.lineWidth = ew; c.lineCap = 'butt'; c.stroke();
      // 端部封板
      c.beginPath();
      c.moveTo(ax + nx * hw, ay + ny * hw); c.lineTo(ax - nx * hw, ay - ny * hw);
      c.moveTo(bx + nx * hw, by + ny * hw); c.lineTo(bx - nx * hw, by - ny * hw);
      c.lineWidth = ew * 0.8; c.stroke();
      c.lineCap = 'round';
    } else if (mat === 'rope') {
      c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by);
      const d = Math.max(4, w * 2.2);
      c.setLineDash([d, d * 0.75]); c.lineDashOffset = 0;
      c.strokeStyle = color; c.lineWidth = w; c.lineCap = 'butt'; c.stroke();
      c.setLineDash([]); c.lineCap = 'round';
    } else {
      // 弹簧：两端一小段直线，中间锯齿
      const lead = Math.min(L * 0.2, Math.max(4, w * 1.2));
      const zl = L - lead * 2;
      const amp = Math.max(2.6, w * 0.8);
      const teeth = Math.max(3, Math.round(zl / Math.max(4.5, w * 1.15)));
      c.beginPath(); c.moveTo(ax, ay);
      const sx = ax + ux * lead, sy = ay + uy * lead;
      c.lineTo(sx, sy);
      for (let i = 0; i < teeth; i++) {
        const t = (i + 0.5) / teeth;
        const s = i % 2 ? -1 : 1;
        c.lineTo(sx + ux * zl * t + nx * amp * s, sy + uy * zl * t + ny * amp * s);
      }
      c.lineTo(bx - ux * lead, by - uy * lead); c.lineTo(bx, by);
      c.strokeStyle = color; c.lineWidth = Math.max(1.4, w * 0.34); c.stroke();
    }
    c.globalAlpha = 1;
  }

  /** 杆件的光晕（悬停 / 报告 / 闪光用） */
  halo(ax, ay, bx, by, color, w, alpha) {
    const c = this.ctx;
    c.globalAlpha = alpha;
    c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by);
    c.strokeStyle = color; c.lineWidth = w; c.lineCap = 'round'; c.stroke();
    c.globalAlpha = 1;
  }

  node(x, y, r, stroke, fill = BP.paper, alpha = 1) {
    const c = this.ctx;
    c.globalAlpha = alpha;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2);
    c.fillStyle = fill; c.fill();
    c.strokeStyle = stroke; c.lineWidth = Math.max(1.2, r * 0.42); c.stroke();
    c.globalAlpha = 1;
  }

  /** 锚点：方块 + 指向山体一侧的地面斜线。face = 'down' 顶面 | 'left' 崖壁 | 'right' */
  anchor(x, y, size, color, face, alpha = 1) {
    const c = this.ctx, hs = size / 2;
    c.globalAlpha = alpha;
    c.beginPath();
    const m = size * 0.95, k = 4, sp = size * 0.42;
    for (let i = -k / 2; i <= k / 2; i++) {
      const o = i * sp;
      if (face === 'down') { c.moveTo(x + o + 2, y + hs + 1); c.lineTo(x + o - sp + 2, y + hs + 1 + sp); }
      else if (face === 'left') { c.moveTo(x - hs - 1, y + o); c.lineTo(x - hs - 1 - sp, y + o + sp); }
      else { c.moveTo(x + hs + 1, y + o); c.lineTo(x + hs + 1 + sp, y + o + sp); }
    }
    if (face === 'down') { c.moveTo(x - m, y + hs + 1); c.lineTo(x + m, y + hs + 1); }
    else if (face === 'left') { c.moveTo(x - hs - 1, y - m); c.lineTo(x - hs - 1, y + m); }
    else { c.moveTo(x + hs + 1, y - m); c.lineTo(x + hs + 1, y + m); }
    c.strokeStyle = color; c.lineWidth = 1.2; c.lineCap = 'butt'; c.stroke();
    c.fillStyle = color;
    c.fillRect(x - hs, y - hs, size, size);
    c.strokeStyle = BP.paper; c.lineWidth = 1; c.strokeRect(x - hs + 2, y - hs + 2, size - 4, size - 4);
    c.globalAlpha = 1;
  }

  /** 核心：六边形 + 半径为 CORE.radius 的圆环 */
  core(x, y, color, ppm, label, alpha = 1, pulse = 0) {
    const c = this.ctx;
    c.globalAlpha = alpha;
    const R = CORE.radius * ppm;
    const r = Math.max(5, R * 0.62);
    c.beginPath(); c.arc(x, y, R, 0, Math.PI * 2);
    c.strokeStyle = color; c.lineWidth = 1.2; c.setLineDash([3, 3]); c.stroke(); c.setLineDash([]);
    if (pulse > 0) {
      c.beginPath(); c.arc(x, y, R + 3 + pulse * 6, 0, Math.PI * 2);
      c.globalAlpha = alpha * (1 - pulse) * 0.5; c.lineWidth = 1.5; c.stroke(); c.globalAlpha = alpha;
    }
    c.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 6 + (i * Math.PI) / 3;
      const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
      if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
    }
    c.closePath();
    c.fillStyle = rgba(color, 0.28); c.fill();
    c.strokeStyle = color; c.lineWidth = 2; c.lineJoin = 'round'; c.stroke();
    c.beginPath(); c.arc(x, y, Math.max(1.6, r * 0.22), 0, Math.PI * 2); c.fillStyle = color; c.fill();
    if (label) {
      c.font = `600 11px ${FONT}`; c.fillStyle = color; c.textAlign = 'center'; c.textBaseline = 'top';
      c.fillText(label, x, y + R + 4);
    }
    c.globalAlpha = 1;
  }

  /**
   * 火炮（世界坐标的位姿 → 屏幕）。pose: {px,py,mx,my,angle,beamAngle}，已是世界坐标（敌方已镜像）。
   * body: 炮管填充色；line: 描边色。
   */
  cannon(pose, body, line, alpha = 1, scale = 1) {
    const c = this.ctx, v = this.view;
    const ux = Math.cos(pose.beamAngle), uy = Math.sin(pose.beamAngle);
    // 炮座中点 = 炮耳轴沿法线退回 pivotH
    let nx = -uy, ny = ux; if (ny < 0) { nx = -nx; ny = -ny; }
    const k = scale;
    const P = [pose.px, pose.py];
    const C = [pose.px - nx * CANNON.pivotH * k, pose.py - ny * CANNON.pivotH * k];
    const S = (x, y) => [v.sx(x), v.sy(y)];
    c.globalAlpha = alpha;
    c.lineJoin = 'round';
    // 炮架：梯形
    const q = [
      S(C[0] - ux * 0.5 * k, C[1] - uy * 0.5 * k), S(C[0] + ux * 0.5 * k, C[1] + uy * 0.5 * k),
      S(P[0] + ux * 0.2 * k, P[1] + uy * 0.2 * k), S(P[0] - ux * 0.2 * k, P[1] - uy * 0.2 * k),
    ];
    c.beginPath(); c.moveTo(q[0][0], q[0][1]); for (let i = 1; i < 4; i++) c.lineTo(q[i][0], q[i][1]); c.closePath();
    c.fillStyle = PAPER_DEEP; c.fill();
    c.strokeStyle = line; c.lineWidth = 1.4; c.stroke();
    // 炮管：从炮耳轴后方到炮口，略收口
    const dx = Math.cos(pose.angle), dy = Math.sin(pose.angle);
    const L = CANNON.barrelLen * k;
    const back = 0.32 * k;
    const r0 = 0.15 * k, r1 = 0.11 * k;
    const ex = -dy, ey = dx;
    const b0 = [P[0] - dx * back, P[1] - dy * back], b1 = [P[0] + dx * L, P[1] + dy * L];
    const bq = [
      S(b0[0] + ex * r0, b0[1] + ey * r0), S(b1[0] + ex * r1, b1[1] + ey * r1),
      S(b1[0] - ex * r1, b1[1] - ey * r1), S(b0[0] - ex * r0, b0[1] - ey * r0),
    ];
    c.beginPath(); c.moveTo(bq[0][0], bq[0][1]); for (let i = 1; i < 4; i++) c.lineTo(bq[i][0], bq[i][1]); c.closePath();
    c.fillStyle = body; c.fill();
    c.strokeStyle = line; c.lineWidth = 1.2; c.stroke();
    // 炮口箍
    const m0 = [P[0] + dx * (L - 0.16 * k), P[1] + dy * (L - 0.16 * k)];
    const a1 = S(m0[0] + ex * (r1 + 0.04 * k), m0[1] + ey * (r1 + 0.04 * k)), a2 = S(m0[0] - ex * (r1 + 0.04 * k), m0[1] - ey * (r1 + 0.04 * k));
    c.beginPath(); c.moveTo(a1[0], a1[1]); c.lineTo(a2[0], a2[1]);
    c.lineWidth = Math.max(1.5, 0.08 * v.ppm * k); c.strokeStyle = line; c.stroke();
    // 炮耳轴
    const pp = S(P[0], P[1]);
    c.beginPath(); c.arc(pp[0], pp[1], Math.max(2, 0.1 * v.ppm * k), 0, Math.PI * 2);
    c.fillStyle = line; c.fill();
    c.globalAlpha = 1;
  }

  /** 世界坐标点列 → 点状弧线 */
  dotted(pts, color, alpha, lw, gap) {
    const c = this.ctx, v = this.view;
    if (!pts || pts.length < 2) return;
    c.beginPath();
    c.moveTo(v.sx(pts[0][0]), v.sy(pts[0][1]));
    for (let i = 1; i < pts.length; i++) c.lineTo(v.sx(pts[i][0]), v.sy(pts[i][1]));
    c.globalAlpha = alpha;
    c.setLineDash([0.01, gap]); c.lineDashOffset = 0;
    c.strokeStyle = color; c.lineWidth = lw; c.lineCap = 'round'; c.stroke();
    c.setLineDash([]);
    c.globalAlpha = 1;
  }

  cross(x, y, r, color, lw = 2, alpha = 1) {
    const c = this.ctx;
    c.globalAlpha = alpha;
    c.beginPath();
    c.moveTo(x - r, y - r); c.lineTo(x + r, y + r); c.moveTo(x + r, y - r); c.lineTo(x - r, y + r);
    c.strokeStyle = color; c.lineWidth = lw; c.lineCap = 'round'; c.stroke();
    c.globalAlpha = 1;
  }

  ring(x, y, r, color, lw = 1.5, alpha = 1, dash = null) {
    const c = this.ctx;
    c.globalAlpha = alpha;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2);
    if (dash) c.setLineDash(dash);
    c.strokeStyle = color; c.lineWidth = lw; c.stroke();
    if (dash) c.setLineDash([]);
    c.globalAlpha = 1;
  }

  /** 靶环：命中核心的终点标记 */
  target(x, y, color, t) {
    const c = this.ctx;
    const p = (t * 1.4) % 1;
    this.ring(x, y, 11, color, 2);
    this.ring(x, y, 5, color, 1.6);
    this.ring(x, y, 11 + p * 9, color, 1.2, (1 - p) * 0.7);
    c.beginPath();
    c.moveTo(x - 16, y); c.lineTo(x - 12, y); c.moveTo(x + 12, y); c.lineTo(x + 16, y);
    c.moveTo(x, y - 16); c.lineTo(x, y - 12); c.moveTo(x, y + 12); c.lineTo(x, y + 16);
    c.strokeStyle = color; c.lineWidth = 1.6; c.lineCap = 'butt'; c.stroke();
  }

  /**
   * 小价签。(x, y) 为锚点；align: 'cursor' 放在光标右下并避开屏幕边 | 'center' 以 (x,y) 为中心。
   * 返回价签矩形，方便叠放。
   */
  chip(x, y, text, color, opts = {}) {
    const c = this.ctx;
    const size = opts.size || 12;
    c.font = `600 ${size}px ${FONT}`;
    const tw = this.textW(text);
    const padX = 7, hgt = size + 9;
    const wd = tw + padX * 2;
    let bx, by;
    if (opts.align === 'center') { bx = x - wd / 2; by = y - hgt / 2; }
    else {
      bx = x + 16; by = y + 16;
      if (bx + wd > this.w - 6) bx = x - 16 - wd;
      if (by + hgt > this.h - 6) by = y - 16 - hgt;
    }
    const alpha = opts.alpha ?? 1;
    c.globalAlpha = alpha;
    c.beginPath(); roundRect(c, bx, by, wd, hgt, hgt / 2);
    c.fillStyle = CHIP_BG; c.fill();
    c.strokeStyle = color; c.globalAlpha = alpha * 0.55; c.lineWidth = 1; c.stroke();
    c.globalAlpha = alpha;
    c.fillStyle = color; c.textAlign = 'left'; c.textBaseline = 'middle';
    c.fillText(text, bx + padX, by + hgt / 2 + 0.5);
    c.globalAlpha = 1;
    return { x: bx, y: by, w: wd, h: hgt };
  }

  /** 编号徽章 */
  badge(x, y, r, text, fill, stroke, textColor, alpha = 1) {
    const c = this.ctx;
    c.globalAlpha = alpha;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2);
    c.fillStyle = fill; c.fill();
    c.strokeStyle = stroke; c.lineWidth = 1.5; c.stroke();
    c.font = `700 ${Math.round(r * 1.15)}px ${MONO}`;
    c.fillStyle = textColor; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(text, x, y + 0.5);
    c.globalAlpha = 1;
  }

  label(x, y, text, color, size = 11, align = 'center', base = 'middle', alpha = 1, weight = 600) {
    const c = this.ctx;
    c.globalAlpha = alpha;
    c.font = `${weight} ${size}px ${FONT}`;
    c.fillStyle = color; c.textAlign = align; c.textBaseline = base;
    c.fillText(text, x, y);
    c.globalAlpha = 1;
  }
}

export function roundRect(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

/** 圆角多边形（闭合） */
export function roundPoly(c, pts, r) {
  const n = pts.length;
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const s = mid(pts[n - 1], pts[0]);
  c.moveTo(s[0], s[1]);
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    c.arcTo(p[0], p[1], q[0], q[1], r);
  }
  c.closePath();
}
