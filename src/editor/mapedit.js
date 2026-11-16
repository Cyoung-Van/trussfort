// 地图编辑器：在蓝图画布上直接改一张地图的草稿。
// 只画己方半场的数据，对方半场自动镜像，所以画出来的地图永远左右对称。
//
// 三种工具：
//   地形：拖动地表上的点；双击地表加一个点；右键点删掉它。第一个点往后方、最后一个点到中线都按水平延伸。
//   锚点：点地表上的网格点放 / 拿掉锚点。
//   范围：拖动建造范围和核心范围的四条边；拖动核心的默认位置。
// 名字、场地宽度、水面、预算、火炮上限在侧边面板里填。草稿随时可以是不合法的，面板底部会说哪里不对，合法了才能保存。

import { THEME } from '../theme.js';
import { Painter, FONT } from './draw.js';
import { compileMapLoose, validateMap } from '../map.js';
import { ICON } from '../ui/icons.js';
import { fieldBounds } from '../view.js';

const BP = THEME.bp;
const FAR_X = -60;

function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const snap = (v) => Math.round(v);

/** 一张新地图的起点：平地，没有水 */
export function blankMap(name = '新地图') {
  return {
    id: '', name, fieldW: 32,
    ground: [[FAR_X, 0], [0, 0]],
    water: null,
    build: { xMin: -8, xMax: 8, yMin: 0, yMax: 12 },
    anchors: [[-6, 0], [-3, 0], [0, 0], [3, 0], [6, 0]],
    coreZone: { xMin: -4, xMax: 6, yMin: 2, yMax: 8 },
    core: [2, 4],
    budget: 20000, maxCannons: 3,
  };
}

export class MapEditor {
  /**
   * @param {{ canvas: HTMLCanvasElement, view: object, root: HTMLElement, onSave: (raw: object) => void, onCancel: () => void, toast: (text: string, kind?: string) => void }} o
   */
  constructor({ canvas, view, root, onSave, onCancel, toast }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.view = view;
    this.p = new Painter(this.ctx);
    this.onSave = onSave; this.onCancel = onCancel; this.toast = toast || (() => {});
    this.active = false;
    this.tool = 'ground';
    this.draft = null;      // 正在改的地图数据
    this.pts = [];          // 可拖动的地表点（不含往后方延伸的那个远点）
    this.M = null;          // 草稿编译出来的地形（画图、判断锚点是否贴地用）
    this.why = null;        // 草稿哪里不合法；null 表示可以保存
    this.drag = null;
    this.hover = null;
    this.pointer = { sx: -1e4, sy: -1e4 };
    this.w = 1280; this.h = 720; this.dpr = 1; this.time = 0;
    this._buildPanel(root);
    this._bind();
  }

  // ------------------------------------------------------------ 面板
  _buildPanel(root) {
    const P = el('div', 'panel mapedit pe', root);
    this.panel = P;
    el('div', 'me-title', P, '地图编辑');
    const field = (label, input) => { const r = el('label', 'me-field', P); el('span', 'me-k', r, label); r.appendChild(input); return input; };
    const num = (min, max, step = 1) => { const i = el('input', 'me-in'); i.type = 'number'; i.min = min; i.max = max; i.step = step; return i; };
    this.inName = field('名称', Object.assign(el('input', 'me-in'), { type: 'text', maxLength: 16 }));
    this.inW = field('场地宽度（米）', num(16, 60, 2));
    const wr = el('div', 'me-field', P);
    const wl = el('label', 'me-check', wr);
    this.inWater = el('input', '', wl); this.inWater.type = 'checkbox';
    el('span', '', wl, '有水，水面高度');
    this.inWaterY = num(-40, 40, 0.5); wr.appendChild(this.inWaterY);
    this.inBudget = field('预算', num(1000, 200000, 1000));
    this.inCannons = field('火炮上限', num(1, 8));

    el('div', 'me-k me-gap', P, '工具');
    const seg = el('div', 'me-tools', P);
    this.toolBtns = {};
    for (const [id, name] of [['ground', '地形'], ['anchor', '锚点'], ['zone', '范围']]) {
      const b = el('button', 'btn me-tool', seg, name);
      b.type = 'button'; b.tabIndex = -1;
      b.addEventListener('click', () => this.setTool(id));
      this.toolBtns[id] = b;
    }
    this.tip = el('div', 'me-tip', P, '');
    this.status = el('div', 'me-status', P, '');
    const row = el('div', 'me-btns', P);
    const cancel = el('button', 'btn me-cancel', row, '取消');
    cancel.type = 'button'; cancel.tabIndex = -1;
    cancel.addEventListener('click', () => this.onCancel());
    this.saveBtn = el('button', 'btn me-save', row);
    this.saveBtn.type = 'button'; this.saveBtn.tabIndex = -1;
    this.saveBtn.insertAdjacentHTML('beforeend', ICON.check);
    el('span', '', this.saveBtn, '保存并使用');
    this.saveBtn.addEventListener('click', () => { if (!this.why) this.onSave(this._export()); });

    const upd = () => this._readPanel();
    for (const i of [this.inName, this.inW, this.inWater, this.inWaterY, this.inBudget, this.inCannons]) {
      i.addEventListener('input', upd); i.addEventListener('change', upd);
    }
  }

  _readPanel() {
    const d = this.draft;
    if (!d) return;
    d.name = this.inName.value.trim() || '自定义地图';
    const w = Number(this.inW.value);
    if (Number.isFinite(w) && w >= 16 && w <= 60 && Math.round(w) !== d.fieldW) {
      d.fieldW = Math.round(w);
      // 地表上的点不能越过新的中线
      for (const p of this.pts) p[0] = Math.min(p[0], Math.floor(d.fieldW / 2));
      this._refit = true;
    }
    this.inWaterY.disabled = !this.inWater.checked;
    const wy = Number(this.inWaterY.value);
    d.water = this.inWater.checked && Number.isFinite(wy) ? wy : null;
    const b = Number(this.inBudget.value); if (Number.isFinite(b)) d.budget = Math.round(b);
    const c = Number(this.inCannons.value); if (Number.isFinite(c)) d.maxCannons = Math.round(c);
    this._changed();
  }

  _fillPanel() {
    const d = this.draft;
    this.inName.value = d.name || '';
    this.inW.value = d.fieldW;
    this.inWater.checked = d.water != null;
    this.inWaterY.value = d.water != null ? d.water : -6;
    this.inWaterY.disabled = d.water == null;
    this.inBudget.value = d.budget;
    this.inCannons.value = d.maxCannons;
  }

  setTool(t) {
    this.tool = t;
    for (const id in this.toolBtns) this.toolBtns[id].classList.toggle('sel', id === t);
    this.tip.textContent = t === 'ground'
      ? '拖动地表上的点；双击地表加一个点；右键点一个点删掉它。两个点上下对齐就是一道崖壁。'
      : t === 'anchor' ? '点地表上的网格点放一个锚点，再点一下拿掉。锚点要在建造范围里。'
        : '拖动虚线框的四条边：白框是建造范围，蓝框是核心可以放的范围。拖动核心改它的默认位置。';
    this.drag = null; this.hover = null;
  }

  // ------------------------------------------------------------ 进出
  /** 开始编辑一份地图数据（会先复制一份，不动原件） */
  begin(raw) {
    const d = JSON.parse(JSON.stringify(raw));
    this.draft = d;
    // 往后方水平延伸的那个远点是多余的，不显示；别的点原样保留（打开再保存不能改动地形）
    const g = d.ground.map(([x, y]) => [x, y]);
    this.pts = g.length > 1 && g[0][0] <= -20 && g[0][1] === g[1][1] ? g.slice(1) : g;
    if (!this.pts.length) this.pts = [[0, 0]];
    this.active = true;
    this.panel.classList.add('on');
    this._fillPanel();
    this.setTool('ground');
    this._changed();
    this._refit = true;
  }
  end() { this.active = false; this.panel.classList.remove('on'); this.drag = null; this.draft = null; }

  _export() {
    const d = this.draft;
    const pts = this.pts.map(([x, y]) => [x, y]);
    return { ...d, ground: pts[0][0] > FAR_X ? [[FAR_X, pts[0][1]], ...pts] : pts };
  }

  /** 草稿改过了：重新编译、重新检查 */
  _changed() {
    const raw = this._export();
    this.M = compileMapLoose(raw);
    this.why = validateMap(raw);
    this.status.textContent = this.why ? this.why : '可以保存';
    this.status.classList.toggle('bad', !!this.why);
    this.saveBtn.disabled = !!this.why;
  }

  resize(w, h, dpr) { this.w = w; this.h = h; this.dpr = dpr || 1; this._refit = true; }

  // ------------------------------------------------------------ 拾取
  _world() { return { x: this.view.wx(this.pointer.sx), y: this.view.wy(this.pointer.sy) }; }
  _near(x, y, px = 13) { return Math.hypot(this.view.sx(x) - this.pointer.sx, this.view.sy(y) - this.pointer.sy) <= px; }

  _pick() {
    const d = this.draft, t = this.tool;
    if (t === 'ground') {
      for (let i = this.pts.length - 1; i >= 0; i--) if (this._near(this.pts[i][0], this.pts[i][1])) return { kind: 'pt', i };
      if (d.water != null && Math.abs(this.view.sy(d.water) - this.pointer.sy) < 7 && this.M.waterSpans.some(([a, b]) => { const x = this._world().x; return x > a && x < b; })) return { kind: 'water' };
      return null;
    }
    if (t === 'zone') {
      if (this._near(d.core[0], d.core[1], 16)) return { kind: 'core' };
      for (const [key, Z] of [['coreZone', d.coreZone], ['build', d.build]]) {
        const mx = (Z.xMin + Z.xMax) / 2, my = (Z.yMin + Z.yMax) / 2;
        for (const [edge, x, y] of [['xMin', Z.xMin, my], ['xMax', Z.xMax, my], ['yMin', mx, Z.yMin], ['yMax', mx, Z.yMax]]) {
          if (this._near(x, y, 14)) return { kind: 'edge', key, edge };
        }
      }
      return null;
    }
    const { x, y } = this._world();
    return { kind: 'anchor', x: snap(x), y: snap(y) };
  }

  // ------------------------------------------------------------ 输入
  _bind() {
    const c = this.canvas;
    const pos = (e) => { const r = c.getBoundingClientRect(); this.pointer.sx = e.clientX - r.left; this.pointer.sy = e.clientY - r.top; };
    c.addEventListener('pointerdown', (e) => {
      if (!this.active) return;
      pos(e);
      const hit = this._pick();
      if (e.button === 1 || (e.button === 0 && !hit && this.tool !== 'anchor')) {
        this.drag = { kind: 'pan', lx: this.pointer.sx, ly: this.pointer.sy };
      } else if (e.button === 2) {
        if (hit && hit.kind === 'pt' && this.pts.length > 1) { this.pts.splice(hit.i, 1); this._changed(); }
        else this.drag = { kind: 'pan', lx: this.pointer.sx, ly: this.pointer.sy };
      } else if (e.button === 0 && hit) {
        if (hit.kind === 'anchor') this._toggleAnchor(hit.x, hit.y);
        else this.drag = hit;
      }
      if (this.drag) { try { c.setPointerCapture(e.pointerId); } catch { /* 忽略 */ } }
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.active) return;
      pos(e);
      // 发起拖动的键已经松开（切窗口、系统手势等没收到 pointerup）：当作松手
      if (this.drag && typeof e.buttons === 'number' && e.buttons === 0) this.drag = null;
      const d = this.drag;
      if (!d) { this.hover = this._pick(); c.style.cursor = this.hover && this.hover.kind !== 'anchor' ? 'grab' : this.tool === 'anchor' ? 'crosshair' : 'default'; return; }
      c.style.cursor = 'grabbing';
      if (d.kind === 'pan') { this.view.panBy(this.pointer.sx - d.lx, this.pointer.sy - d.ly); d.lx = this.pointer.sx; d.ly = this.pointer.sy; return; }
      this._dragTo(d);
    });
    const up = () => { this.drag = null; };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    c.addEventListener('lostpointercapture', up);
    window.addEventListener('blur', up);
    c.addEventListener('dblclick', (e) => {
      if (!this.active || this.tool !== 'ground') return;
      pos(e);
      if (this._pick()) return;
      const { x, y } = this._world();
      const px = clamp(snap(x), -20, Math.floor(this.draft.fieldW / 2));
      // 只在离地表不远的地方加点
      if (Math.abs(this.M.groundTop(x) - y) * this.view.ppm > 26 && Math.abs(this.M.groundIn(x) - y) * this.view.ppm > 26) return;
      let i = 0;
      while (i < this.pts.length && this.pts[i][0] <= px) i++;
      this.pts.splice(i, 0, [px, clamp(snap(y), -30, 30)]);
      this._changed();
    });
    c.addEventListener('wheel', (e) => {
      if (!this.active) return;
      e.preventDefault();
      this.view.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });
    c.addEventListener('contextmenu', (e) => { if (this.active) e.preventDefault(); });
  }

  _dragTo(d) {
    const { x, y } = this._world();
    const D = this.draft, half = Math.floor(D.fieldW / 2);
    if (d.kind === 'pt') {
      const p = this.pts[d.i];
      const lo = d.i > 0 ? this.pts[d.i - 1][0] : Math.min(-20, p[0]), hi = d.i < this.pts.length - 1 ? this.pts[d.i + 1][0] : half;
      const nx = clamp(snap(x), lo, hi), ny = clamp(snap(y), -30, 30);
      // 不能和相邻的点重合
      const clash = (q) => q && q[0] === nx && q[1] === ny;
      if (clash(this.pts[d.i - 1]) || clash(this.pts[d.i + 1])) return;
      if (nx === p[0] && ny === p[1]) return;
      p[0] = nx; p[1] = ny;
    } else if (d.kind === 'water') {
      const ny = clamp(Math.round(y * 2) / 2, -40, 40);
      if (ny === D.water) return;
      D.water = ny; this.inWaterY.value = ny;
    } else if (d.kind === 'core') {
      const nx = snap(x), ny = snap(y);
      if (nx === D.core[0] && ny === D.core[1]) return;
      D.core = [nx, ny];
    } else if (d.kind === 'edge') {
      const Z = D[d.key];
      const v = snap(d.edge[0] === 'x' ? x : y);
      const lim = d.key === 'build' ? { xMin: [-30, Z.xMax - 2], xMax: [Z.xMin + 2, half - 1], yMin: [-30, Z.yMax - 2], yMax: [Z.yMin + 2, 40] }
        : { xMin: [D.build.xMin, Z.xMax - 1], xMax: [Z.xMin + 1, D.build.xMax], yMin: [D.build.yMin, Z.yMax - 1], yMax: [Z.yMin + 1, D.build.yMax] };
      const nv = clamp(v, lim[d.edge][0], lim[d.edge][1]);
      if (nv === Z[d.edge]) return;
      Z[d.edge] = nv;
      if (d.key === 'build') {
        // 核心范围要一直待在建造范围里
        const C = D.coreZone;
        C.xMin = clamp(C.xMin, Z.xMin, Z.xMax - 1); C.xMax = clamp(C.xMax, C.xMin + 1, Z.xMax);
        C.yMin = clamp(C.yMin, Z.yMin, Z.yMax - 1); C.yMax = clamp(C.yMax, C.yMin + 1, Z.yMax);
      }
    }
    this._changed();
  }

  _toggleAnchor(x, y) {
    const D = this.draft;
    const i = D.anchors.findIndex((a) => a[0] === x && a[1] === y);
    if (i >= 0) { D.anchors.splice(i, 1); this._changed(); return; }
    // 找不到正好在光标下的：拿掉光标附近那个已经不贴地的锚点
    const j = D.anchors.findIndex((a) => this._near(a[0], a[1], 12));
    if (j >= 0) { D.anchors.splice(j, 1); this._changed(); return; }
    if (!this.M.onSurface(x, y)) { this.toast('锚点要放在地表上', 'error'); return; }
    if (D.anchors.length >= 12) { this.toast('最多 12 个锚点', 'error'); return; }
    D.anchors.push([x, y]);
    this._changed();
  }

  // ------------------------------------------------------------ 绘制
  draw(dt) {
    if (!this.active || !this.ctx) return;
    this.time += dt || 0;
    const p = this.p, v = this.view, c = this.ctx, M = this.M, D = this.draft;
    if (this._refit) {
      this._refit = false;
      v.fieldB = fieldBounds(M);
      v.fit(v.fieldB, { l: v.w > 900 ? 320 : 24, r: 28, t: 80, b: 48 });
    }
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    p.frame(v, this.dpr, this.w, this.h, this.time, M);
    p.paper(); p.grid(); p.water(); p.terrain();
    const hot = this.tool === 'zone';
    p.zone(false, hot ? 1 : 0.55, '建造范围');
    p.zone(true, 0.3, null);
    p.coreZone(false, hot ? 0.95 : 0.4, BP.player, '核心范围');
    p.coreZone(true, 0.25, BP.enemy, null);
    // 中线
    c.beginPath(); c.setLineDash([3, 6]);
    c.moveTo(p.al(v.sx(D.fieldW / 2)), 0); c.lineTo(p.al(v.sx(D.fieldW / 2)), this.h);
    c.strokeStyle = BP.inkFaint; c.lineWidth = 1; c.stroke(); c.setLineDash([]);
    p.label(v.sx(D.fieldW / 2), 64, '中线 · 右半场自动镜像', BP.inkSoft, 11, 'center', 'top');

    // 锚点（不贴地的画成红色）
    for (let side = 0; side < 2; side++) {
      for (const [x, y] of D.anchors) {
        const ok = M.onSurface(x, y);
        const wx = side ? D.fieldW - x : x;
        p.anchor(v.sx(wx), v.sy(y), 8, ok ? (side ? BP.enemy : BP.anchor) : BP.invalid, M.surfaceKind(x, y) === 'wall' ? (side ? 'right' : 'left') : 'down', side ? 0.45 : 1);
      }
      const cx = side ? D.fieldW - D.core[0] : D.core[0];
      p.core(v.sx(cx), v.sy(D.core[1]), side ? BP.enemy : BP.player, v.ppm, side ? '' : '核心', side ? 0.45 : 1);
    }

    // 把手
    const h = this.drag && this.drag.kind !== 'pan' ? this.drag : this.hover;
    if (this.tool === 'ground') {
      this.pts.forEach(([x, y], i) => {
        const on = h && h.kind === 'pt' && h.i === i;
        p.node(v.sx(x), v.sy(y), on ? 7 : 5, on ? BP.highlight : BP.ink, on ? BP.highlight : BP.paper);
        if (on) p.label(v.sx(x), v.sy(y) - 14, `${x}, ${y}`, BP.highlight, 11, 'center', 'bottom');
      });
      if (D.water != null && h && h.kind === 'water') p.label(v.sx(this._world().x), v.sy(D.water) - 8, `水面 ${D.water}`, BP.highlight, 11, 'center', 'bottom');
    } else if (this.tool === 'zone') {
      for (const [key, Z, col] of [['build', D.build, BP.ink], ['coreZone', D.coreZone, BP.player]]) {
        const mx = (Z.xMin + Z.xMax) / 2, my = (Z.yMin + Z.yMax) / 2;
        for (const [edge, x, y] of [['xMin', Z.xMin, my], ['xMax', Z.xMax, my], ['yMin', mx, Z.yMin], ['yMax', mx, Z.yMax]]) {
          const on = h && h.kind === 'edge' && h.key === key && h.edge === edge;
          const sx = v.sx(x), sy = v.sy(y), r = on ? 6 : 4.5;
          c.fillStyle = on ? BP.highlight : col;
          c.fillRect(p.al(sx - r), p.al(sy - r), r * 2, r * 2);
          if (on) p.label(sx, sy - 12, String(Z[edge]), BP.highlight, 11, 'center', 'bottom');
        }
      }
      if (h && h.kind === 'core') p.ring(v.sx(D.core[0]), v.sy(D.core[1]), 0.95 * v.ppm, BP.highlight, 2);
    } else if (this.hover && this.hover.kind === 'anchor') {
      const { x, y } = this.hover;
      const has = D.anchors.some((a) => a[0] === x && a[1] === y);
      p.ring(v.sx(x), v.sy(y), 9, has ? BP.invalid : M.onSurface(x, y) ? BP.valid : BP.inkFaint, 2);
    }
    c.font = `600 12px ${FONT}`;
  }
}
