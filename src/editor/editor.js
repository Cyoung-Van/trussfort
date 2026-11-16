// 蓝图编辑器：2D 画布绘制 + 全部指针交互。
// 只通过 Blueprint 的 API 修改玩家蓝图；每次成功修改后 bump 修订号并回调 onChange({delta})。
// 敌方蓝图只读，绘制时镜像：worldX = fieldW - x，炮角 PI - angle。

import { CFG, MATERIALS, CANNON, CORE } from '../config.js';
import { THEME, stressRGB } from '../theme.js';
import { Blueprint, cannonPoseFrom } from '../sim/blueprint.js';
import { predictShot } from '../sim/ballistics.js';
import { Painter, rgba, money } from './draw.js';

const BP = THEME.bp;
const DEG = Math.PI / 180;
const MEMBER_TOOLS = new Set(['wood', 'steel', 'rope', 'spring']);
const TOOLS = new Set(['wood', 'steel', 'rope', 'spring', 'cannon', 'move', 'erase']);
const UNDO_CAP = 200;
const DRAG_PX = 5;          // 超过这个像素才算拖动
const POP_T = 0.09;         // 新杆件弹出
const FLASH_T = 0.22;       // 新杆件高光
const DIE_T = 0.12;         // 删除收缩淡出
const SHAKE_T = 0.26;       // 非法操作抖动
const FLOAT_T = 0.8;        // 漂浮价签
const HINT_EVERY = 3000;    // 空白处按下的提示间隔（毫秒）

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function segDist(px, py, ax, ay, bx, by) {
  const ex = bx - ax, ey = by - ay;
  const l2 = ex * ex + ey * ey;
  let t = l2 > 0 ? ((px - ax) * ex + (py - ay) * ey) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + ex * t), py - (ay + ey * t));
}
function cssRGB(c) { return `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`; }
function signed(n) { return (n >= 0 ? '+' : '-') + money(Math.abs(n)); }

export class Editor {
  constructor({ canvas, view, player, enemy, hud, audio, onChange }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.view = view;
    this.player = player;
    this.enemy = enemy;
    this.hud = hud;
    this.audio = audio;
    this.onChange = onChange || (() => {});
    this.p = new Painter(this.ctx);

    this.w = view.w || 1280; this.h = view.h || 720; this.dpr = 1;
    this.time = 0;
    this.enabled = true;
    this._tool = 'wood';

    this.undoStack = [];
    this.redoStack = [];
    this.rev = 1;
    this._traj = new Map();          // cannonId → { rev, angle, res }
    this._hoverCache = { key: '', rev: -1, info: null };

    this.pointer = { sx: -1e4, sy: -1e4, inside: false, shift: false };
    this.space = false;
    this.shift = false;
    this.drag = null;                // 正在进行的按住操作
    this.chain = null;               // { from: nodeId } 连续点击造杆
    this.hover = null;               // { type: 'cannon'|'node'|'beam', id }
    this.report = null;
    this._reportT0 = 0;
    this.hideEnemy = false;          // 双人轮流设计时遮住对方的堡垒
    this.labels = { me: '', foe: '敌方堡垒' };   // 画在堡垒上方的名字；me 为空就不画

    // 动画
    this.pops = new Map();           // 'b'+id / 'n'+id / 'c'+id → t0
    this.dying = [];                 // { t0, beams, nodes, cannons }
    this.floats = [];                // { t0, x, y (世界), text, color }
    this.shakeT0 = -1;
    this.failGhost = null;           // 松手时失败的幽灵杆件，原地抖一下再消失

    this._lastErr = -1e9; this._lastSnap = -1e9; this._lastHint = -1e9;
    this._snapKey = '';
    this._cursor = '';

    this._bind();
  }

  // ================================================================ 公共 API
  setTool(tool) {
    if (!TOOLS.has(tool)) return;
    if (tool === this._tool) return;
    this.cancel();
    this._tool = tool;
    this._updateCursor();
  }
  get tool() { return this._tool; }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  undo() {
    this.cancel();                 // 先了结进行中的拖动（它可能会改动两个栈）
    if (!this.undoStack.length) return;
    const before = this.player.cost();
    this.redoStack.push(this.player.toJSON());
    this.player.load(this.undoStack.pop());
    this._afterRestore(before);
  }
  redo() {
    this.cancel();
    if (!this.redoStack.length) return;
    const before = this.player.cost();
    this.undoStack.push(this.player.toJSON());
    this.player.load(this.redoStack.pop());
    this._afterRestore(before);
  }
  _afterRestore(before) {
    this._bump();
    this.pops.clear();
    this.audio.ui('undo');
    this._changed(before);
  }

  clearAll() {
    this.cancel();
    const snap = this.player.toJSON();
    const before = this.player.cost();
    this._captureDying(() => this.player.reset());
    if (JSON.stringify(this.player.toJSON()) === JSON.stringify(snap)) return; // 本来就是空的：不占撤销步、不清重做
    this._commit(snap, before);
    this.audio.ui('delete');
  }

  loadBlueprint(bp) {
    this.cancel();
    const snap = this.player.toJSON();
    const before = this.player.cost();
    this.player.load(bp);
    if (JSON.stringify(this.player.toJSON()) === JSON.stringify(snap)) return;
    this._commit(snap, before);
    const t = this.time;
    for (const id of this.player.beams.keys()) this.pops.set('b' + id, t);
    this.audio.ui('place');
  }

  /** 蓝图被外部改过（比如换了一座敌方堡垒）：让弹道预览等缓存失效 */
  invalidate() { this._bump(); this._repCache = null; }

  /**
   * 换一对蓝图来编辑（换地图、换边时用）：player 是正在编辑的那座，enemy 是画在对面的那座。
   * 撤销记录属于被换下的那座蓝图，一并清空。
   */
  setForts(player, enemy) {
    this.cancel();
    this.player = player; this.enemy = enemy;
    this.undoStack.length = 0; this.redoStack.length = 0;
    this.pops.clear(); this.dying.length = 0; this.floats.length = 0;
    this.hover = null; this.report = null; this._traj.clear();
    this.invalidate();
  }
  get map() { return this.player.map; }

  setEnabled(on) {
    on = !!on;
    if (!on) { this.cancel(); this.hover = null; }
    this.enabled = on;
    this._updateCursor();
  }

  setBattleReport(report) {
    this._reportT0 = this.time;
    this._repCache = null;
    if (!report) { this.report = null; return; }
    // 进来的战报按杆件 id 记录；这里立刻换成按「两端坐标」记录。
    // id 在清空 / 载入示例后会被复用，按几何位置记才不会把旧标记贴到不相干的新杆上。
    const broken = new Map(), peak = new Map();
    for (const [id, info] of report.broken || []) {
      const b = this.player.beams.get(id);
      if (b) broken.set(this._beamKey(b), info);
    }
    for (const [id, pk] of report.peak || []) {
      const b = this.player.beams.get(id);
      if (b) peak.set(this._beamKey(b), pk);
    }
    this.report = { broken, peak, winner: report.winner };
  }
  _beamKey(b) {
    const a = this.player.nodes.get(b.a), c = this.player.nodes.get(b.b);
    const k1 = a.x + ',' + a.y, k2 = c.x + ',' + c.y;
    return k1 < k2 ? k1 + '|' + k2 : k2 + '|' + k1;
  }
  /** 当前蓝图里带战报标记的杆件（按修订号缓存） */
  _reportItems() {
    const rep = this.report;
    if (!rep) return null;
    const c = this._repCache;
    if (c && c.rev === this.rev) return c;
    const broken = [], peaks = [];
    for (const b of this.player.beams.values()) {
      const key = this._beamKey(b);
      const info = rep.broken.get(key);
      if (info) { broken.push({ b, info }); continue; }
      const pk = rep.peak.get(key);
      if (pk >= 0.6) peaks.push({ b, pk });
    }
    return (this._repCache = { rev: this.rev, broken, peaks });
  }

  /** Esc：取消当前拖动 / 连续造杆 */
  cancel() {
    const d = this.drag;
    if (d) {
      if ((d.kind === 'move' || d.kind === 'aim') && d.changed) {
        const before = this.player.cost();
        this.player.load(d.snap);
        this._bump();
        this._changed(before);
      } else if (d.kind === 'erase' && d.changed) {
        this._pushUndo(d.snap);
        this.onChange({ delta: 0 });
      }
      this._release(d.pointerId);
      this.drag = null;
    }
    this.chain = null;
    this._snapKey = '';
    this._updateCursor();
  }

  /** Delete 键：删掉光标下的东西 */
  deleteHovered() {
    if (!this.enabled || this.drag) return;
    if (!this.pointer.inside) return;   // 光标已经离开画布（比如停在工具栏上）：没有高亮的东西就不删
    this.chain = null;
    const { x, y } = this._world();
    const snap = this.player.toJSON();
    const before = this.player.cost();
    const r = this._deleteAt(x, y, false);
    if (r.ok) this._commit(snap, before);
    else if (r.reason) this._reject(r.reason, x, y);
  }

  resize(w, h, dpr) {
    this.w = w; this.h = h; this.dpr = dpr || 1;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    if (this.canvas.style) { this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px'; }
    this.p._vigKey = '';
  }

  // ================================================================ 内部：修改与撤销
  _bump() { this.rev++; }
  _pushUndo(snap) {
    this.undoStack.push(snap);
    if (this.undoStack.length > UNDO_CAP) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  _changed(costBefore) {
    this.onChange({ delta: this.player.cost() - costBefore });
  }
  /** 一次已经完成的修改：入撤销栈、bump、通知 */
  _commit(snap, costBefore) {
    this._pushUndo(snap);
    this._bump();
    this._changed(costBefore);
  }

  _reject(reason, x, y) {
    const t = now();
    if (t - this._lastErr > 250) { this._lastErr = t; this.audio.ui('error'); }
    this.shakeT0 = this.time;
    if (reason && x != null) this._float(reason, x, y, BP.invalid);
  }
  _float(text, x, y, color) {
    this.floats.push({ t0: this.time, x, y, text, color });
    if (this.floats.length > 8) this.floats.shift();
  }
  _snapSound() {
    const t = now();
    if (t - this._lastSnap > 45) { this._lastSnap = t; this.audio.ui('snap'); }
  }
  _hint() {
    const t = now();
    if (t - this._lastHint > HINT_EVERY) { this._lastHint = t; this.hud.toast('从锚点或已有节点拖出杆件', 'info'); }
  }

  /** 执行 fn，把被它删掉的杆件 / 节点 / 火炮记下来做收缩淡出动画 */
  _captureDying(fn) {
    const bp = this.player;
    const beams = new Map(), nodes = new Map(), cannons = new Map();
    for (const b of bp.beams.values()) {
      const a = bp.nodes.get(b.a), c = bp.nodes.get(b.b);
      beams.set(b.id, { ax: a.x, ay: a.y, bx: c.x, by: c.y, mat: b.mat });
    }
    for (const n of bp.nodes.values()) nodes.set(n.id, { x: n.x, y: n.y, kind: n.kind });
    for (const c of bp.cannons.values()) cannons.set(c.id, bp.cannonPose(c));
    const r = fn();
    const d = { t0: this.time, beams: [], nodes: [], cannons: [] };
    for (const [id, g] of beams) if (!bp.beams.has(id)) d.beams.push(g);
    for (const [id, g] of nodes) if (!bp.nodes.has(id) && g.kind === 'free') d.nodes.push(g);
    for (const [id, g] of cannons) if (!bp.cannons.has(id)) d.cannons.push(g);
    if (d.beams.length || d.nodes.length || d.cannons.length) {
      this.dying.push(d);
      if (this.dying.length > 12) this.dying.shift();
    }
    return r;
  }

  // ================================================================ 拾取
  _world() { return { x: this.view.wx(this.pointer.sx), y: this.view.wy(this.pointer.sy) }; }
  _snap(x, y) { const g = CFG.grid; return { x: Math.round(x / g) * g, y: Math.round(y / g) * g }; }

  pickNode(x, y, filter) {
    const r = Math.max(0.45, 14 / this.view.ppm);
    let best = null, bd = r;
    for (const n of this.player.nodes.values()) {
      if (filter && !filter(n)) continue;
      const d = Math.hypot(n.x - x, n.y - y);
      if (d <= bd) { bd = d; best = n; }
    }
    return best;
  }
  pickBeam(x, y) {
    const r = Math.max(0.25, 8 / this.view.ppm);
    const bp = this.player;
    let best = null, bd = r;
    for (const b of bp.beams.values()) {
      const a = bp.nodes.get(b.a), c = bp.nodes.get(b.b);
      const d = segDist(x, y, a.x, a.y, c.x, c.y);
      if (d <= bd) { bd = d; best = b; }
    }
    return best;
  }
  pickCannon(x, y) {
    const ppm = this.view.ppm;
    const rBar = Math.max(0.35, 7 / ppm), rPiv = Math.max(0.7, 12 / ppm);
    let best = null, bd = Infinity;
    for (const c of this.player.cannons.values()) {
      const p = this.player.cannonPose(c);
      const dp = Math.hypot(x - p.px, y - p.py);
      const db = segDist(x, y, p.px, p.py, p.mx, p.my);
      if (dp <= rPiv || db <= rBar) {
        const d = Math.min(dp, db);
        if (d < bd) { bd = d; best = c; }
      }
    }
    return best;
  }
  /** 删除用的拾取：火炮 > 节点 > 杆件 */
  _pickForDelete(x, y, skipFixed) {
    const c = this.pickCannon(x, y);
    if (c) return { type: 'cannon', id: c.id };
    const n = this.pickNode(x, y, skipFixed ? (q) => q.kind === 'free' : null);
    if (n) return { type: 'node', id: n.id };
    const b = this.pickBeam(x, y);
    if (b) return { type: 'beam', id: b.id };
    return null;
  }

  _deleteAt(x, y, swipe) {
    const hit = this._pickForDelete(x, y, swipe);
    if (!hit) return { ok: false };
    return this._deleteItem(hit, x, y);
  }
  _deleteItem(hit, x, y) {
    const bp = this.player;
    if (hit.type === 'node') {
      const n = bp.nodes.get(hit.id);
      if (n && n.kind !== 'free') return { ok: false, reason: n.kind === 'core' ? '核心不能拆' : '锚点不能拆' };
    }
    const before = bp.cost();
    const r = this._captureDying(() => (
      hit.type === 'cannon' ? bp.removeCannon(hit.id) : hit.type === 'node' ? bp.removeNode(hit.id) : bp.removeBeam(hit.id)
    ));
    if (!r.ok) return r;
    const refund = before - bp.cost();
    if (refund > 0) this._float('-' + money(refund), x, y, BP.highlight);
    this.audio.ui('delete');
    if (this.hover && this.hover.type === hit.type && this.hover.id === hit.id) this.hover = null;
    return { ok: true };
  }


  /** 假如这样改，造价会变多少：在蓝图副本上试一遍再比。改不成返回 null */
  _costIf(change) {
    const cl = this.player.clone();
    return change(cl) ? cl.cost() - this.player.cost() : null;
  }
  /** 造杆目标：光标附近的已有节点，否则最近网格点 */
  _target(from) {
    const { x, y } = this._world();
    const n = this.pickNode(x, y);
    const bp = this.player;
    const fn = bp.nodes.get(from);
    const mat = this._tool;
    const t = n ? { x: n.x, y: n.y, node: n.id } : { ...this._snap(x, y), node: null };
    if (!t.node) { const ex = bp.nodeAt(t.x, t.y); if (ex) t.node = ex.id; }
    t.same = t.node === from;
    t.len = Math.hypot(t.x - fn.x, t.y - fn.y);
    // 价格在蓝图副本上试搭一遍再比：装配费、和相邻杆件共线合并后少收的那份，都算在里面
    const hyp = t.same ? null : this._costIf((cl) => { const a = cl.addNode(fn.x, fn.y), b = cl.addNode(t.x, t.y); return a.ok && b.ok && cl.addBeam(a.id, b.id, mat).ok; });
    t.price = hyp != null ? hyp : Blueprint.priceFor(mat, fn.x, fn.y, t.x, t.y);
    let why = null;
    if (t.same) why = '同一个节点';
    else if (t.node && bp.beamBetween(from, t.node)) why = '这里已经有杆件';
    else if (!t.node) why = bp.checkNodePos(t.x, t.y);
    if (!why) why = bp.checkSpan(mat, fn.x, fn.y, t.x, t.y);
    if (!why && bp.rules.noOverlap && bp._overlapping(fn.x, fn.y, t.x, t.y)) why = '和已有杆件重叠';
    t.reason = why;
    t.valid = !why;
    t.fx = fn.x; t.fy = fn.y; t.mat = mat;
    return t;
  }

  _placeMember(from, t) {
    const bp = this.player;
    const snap = bp.toJSON();
    const before = bp.cost();
    let to = t.node, created = false;
    if (!to) {
      const r = bp.addNode(t.x, t.y);
      if (!r.ok) return r;
      to = r.id; created = !r.existed;
    }
    const r2 = bp.addBeam(from, to, t.mat);
    if (!r2.ok) { if (created) bp.load(snap); return r2; }
    this.pops.set('b' + r2.id, this.time);
    if (created) this.pops.set('n' + to, this.time);
    this._commit(snap, before);
    this.audio.ui('place');
    return { ok: true, to };
  }

  // ================================================================ 输入
  _bind() {
    const c = this.canvas;
    if (!c.addEventListener) return;
    c.addEventListener('pointerdown', (e) => this._down(e));
    c.addEventListener('pointermove', (e) => this._move(e));
    c.addEventListener('pointerup', (e) => this._up(e));
    c.addEventListener('pointercancel', (e) => { if (this._owns(e)) this.cancel(); });
    // 捕获丢失（切窗口、系统手势等）而又没收到 pointerup：了结这次拖动，免得回来后一动鼠标就接着删 / 接着拖
    c.addEventListener('lostpointercapture', (e) => { if (this.drag && this._owns(e)) this.cancel(); });
    c.addEventListener('pointerleave', () => { this.pointer.inside = false; if (!this.drag) this.hover = null; });
    c.addEventListener('pointerenter', () => { this.pointer.inside = true; });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (!this.enabled) return;
      this._setPointer(e);
      this.view.zoomAt(this.pointer.sx, this.pointer.sy, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('keydown', (e) => {
        if (e.code === 'Space') { this.space = true; this._updateCursor(); }
        if (e.key === 'Shift') this.shift = true;
      });
      window.addEventListener('keyup', (e) => {
        if (e.code === 'Space') { this.space = false; this._updateCursor(); }
        if (e.key === 'Shift') this.shift = false;
      });
      window.addEventListener('blur', () => { this.space = false; this.shift = false; if (this.drag) this.cancel(); });
    }
  }

  _setPointer(e) {
    let l = 0, t = 0;
    if (this.canvas.getBoundingClientRect) { const r = this.canvas.getBoundingClientRect(); l = r.left || 0; t = r.top || 0; }
    this.pointer.sx = e.clientX - l; this.pointer.sy = e.clientY - t;
    this.pointer.inside = true;
    if (typeof e.shiftKey === 'boolean') this.shift = e.shiftKey;
  }
  /** 这个指针事件是否属于当前拖动（没有拖动时任何指针都算） */
  _owns(e) {
    const d = this.drag;
    return !d || d.pointerId == null || e.pointerId == null || e.pointerId === d.pointerId;
  }
  _capture(id) { try { if (id != null && this.canvas.setPointerCapture) this.canvas.setPointerCapture(id); } catch { /* 忽略 */ } }
  _release(id) { try { if (id != null && this.canvas.releasePointerCapture) this.canvas.releasePointerCapture(id); } catch { /* 忽略 */ } }

  _down(e) {
    if (!this.enabled) return;
    if (this.drag) return; // 拖动中再按别的键 / 第二根手指：忽略，也不改光标位置
    this._setPointer(e);
    const { x, y } = this._world();
    const btn = e.button ?? 0;
    // 记下发起拖动的那个键在 e.buttons 里的位：它松开就算拖动结束（处理左右键同按）
    const mask = btn === 0 ? 1 : btn === 1 ? 4 : btn === 2 ? 2 : 0;
    const base = { pointerId: e.pointerId, sx0: this.pointer.sx, sy0: this.pointer.sy, moved: false, mask };

    // 平移：中键、空格 + 左键
    if (btn === 1 || (btn === 0 && this.space)) {
      if (e.preventDefault) e.preventDefault();
      this.drag = { ...base, kind: 'pan', lx: this.pointer.sx, ly: this.pointer.sy };
      this._capture(e.pointerId); this._updateCursor();
      return;
    }
    // 右键：结束连续造杆；空白处拖动 = 平移；点在东西上 = 删除
    if (btn === 2) {
      if (this.chain) { this.chain = null; this.audio.ui('tick'); this._updateCursor(); return; }
      const hit = this._pickForDelete(x, y, false);
      this.drag = { ...base, kind: 'right', hit, lx: this.pointer.sx, ly: this.pointer.sy, panning: false };
      this._capture(e.pointerId);
      return;
    }
    if (btn !== 0) return;

    // 连续造杆：每次点击放一根，并从新端点继续
    if (this.chain) { this._chainClick(); return; }

    const tool = this._tool;
    // 任意工具（橡皮除外）按在炮管上 = 调射角
    if (tool !== 'erase') {
      const c = this.pickCannon(x, y);
      if (c) {
        this.drag = {
          ...base, kind: 'aim', cannon: c.id, snap: this.player.toJSON(), start: c.angle, changed: false,
          lastWhole: Math.round(c.angle / DEG),
        };
        this._capture(e.pointerId); this._updateCursor();
        return;
      }
    }

    if (MEMBER_TOOLS.has(tool)) {
      const mid = this._midBeam(x, y);
      if (mid && mid.mat !== tool) { this._replaceMat(mid, x, y); return; }
      const n = this.pickNode(x, y);
      if (n) {
        this.drag = { ...base, kind: 'member', from: n.id };
        this._snapKey = '';
        this._capture(e.pointerId); this._updateCursor();
        return;
      }
      const b = this.pickBeam(x, y);
      if (b) {
        if (b.mat !== tool) this._replaceMat(b, x, y);
        return;
      }
      this._hint();
      return;
    }

    if (tool === 'cannon') {
      const b = this.pickBeam(x, y);
      if (!b) return;
      const snap = this.player.toJSON();
      const before = this.player.cost();
      const r = this.player.addCannon(b.id, 45 * DEG);
      if (!r.ok) { this._reject(r.reason, x, y); return; }
      this.pops.set('c' + r.id, this.time);
      this._commit(snap, before);
      this.audio.ui('cannon');
      return;
    }

    if (tool === 'move') {
      const n = this.pickNode(x, y);
      if (n) {
        if (n.kind === 'anchor' || (n.kind === 'core' && !this.player.rules.coreZone)) { this._reject(n.kind === 'core' ? '核心不能移动' : '锚点不能移动', x, y); return; }
        this.drag = {
          ...base, kind: 'move', node: n.id, snap: this.player.toJSON(), ox: n.x, oy: n.y, changed: false, reason: null,
        };
        this._snapKey = n.x + ',' + n.y;
        this._capture(e.pointerId); this._updateCursor();
        return;
      }
      // 空白处拖动 = 平移
      this.drag = { ...base, kind: 'pan', lx: this.pointer.sx, ly: this.pointer.sy };
      this._capture(e.pointerId); this._updateCursor();
      return;
    }

    if (tool === 'erase') {
      const d = { ...base, kind: 'erase', snap: this.player.toJSON(), changed: false };
      const before = this.player.cost();
      const r = this._deleteAt(x, y, false);
      if (r.ok) { d.changed = true; this._bump(); this._changed(before); }
      else if (r.reason) this._reject(r.reason, x, y);
      this.drag = d;
      this._capture(e.pointerId);
    }
  }

  _move(e) {
    if (!this.enabled) return;
    if (!this._owns(e)) return;    // 别的指针不许插手当前拖动
    const d = this.drag;
    // 发起拖动的键已经不在按着了（松开时没收到 pointerup）：当作松手处理
    if (d && d.mask && typeof e.buttons === 'number' && (e.buttons & d.mask) === 0) { this._up(e); return; }
    this._setPointer(e);
    const p = this.pointer;
    if (d && !d.moved && Math.hypot(p.sx - d.sx0, p.sy - d.sy0) > DRAG_PX) d.moved = true;
    if (!d) {
      if (this.chain) this._trackSnap(this.chain.from);
      this._updateCursor();
      return;
    }
    const { x, y } = this._world();
    switch (d.kind) {
      case 'pan':
        this.view.panBy(p.sx - d.lx, p.sy - d.ly); d.lx = p.sx; d.ly = p.sy;
        break;
      case 'right':
        if (!d.hit && d.moved) d.panning = true;
        if (d.panning) { this.view.panBy(p.sx - d.lx, p.sy - d.ly); }
        d.lx = p.sx; d.ly = p.sy;
        break;
      case 'member':
        this._trackSnap(d.from);
        break;
      case 'move': {
        const n = this.player.nodes.get(d.node);
        if (!n) break;
        const s = this._snap(x, y);
        if (s.x === n.x && s.y === n.y) { d.reason = null; break; }
        const key = s.x + ',' + s.y;
        const before = this.player.cost();
        const r = this.player.moveNode(d.node, s.x, s.y);
        if (r.ok) {
          d.changed = true; d.reason = null;
          this._bump();
          this._changed(before);
          if (key !== this._snapKey) { this._snapKey = key; this._snapSound(); }
        } else {
          if (d.reason !== r.reason) { const t = now(); if (t - this._lastErr > 250) { this._lastErr = t; this.audio.ui('error'); } }
          d.reason = r.reason;
        }
        break;
      }
      case 'aim': {
        const c = this.player.cannons.get(d.cannon);
        if (!c) break;
        const pose = this.player.cannonPose(c);
        const raw = Math.atan2(y - pose.py, x - pose.px) / DEG;
        const step = this.shift ? 0.1 : 0.5;
        const deg = Math.round(raw / step) * step;
        const prev = c.angle;
        this.player.setCannonAngle(c.id, deg * DEG);
        if (Math.abs(c.angle - prev) > 1e-9) {
          d.changed = true;
          this._bump();
          this.onChange({ delta: 0 });
          const whole = Math.round(c.angle / DEG);
          if (whole !== d.lastWhole) { d.lastWhole = whole; this.audio.ui('aim'); }
        }
        break;
      }
      case 'erase': {
        const before = this.player.cost();
        const r = this._deleteAt(x, y, true);
        if (r.ok) { d.changed = true; this._bump(); this._changed(before); }
        break;
      }
    }
    this._updateCursor();
  }

  _up(e) {
    const d = this.drag;
    if (!d || (e.pointerId != null && d.pointerId != null && e.pointerId !== d.pointerId)) return;
    if (!this.enabled) { this.drag = null; return; }
    this._setPointer(e);
    this.drag = null;
    this._release(d.pointerId);
    const { x, y } = this._world();
    switch (d.kind) {
      case 'right':
        if (!d.panning && d.hit) {
          const snap = this.player.toJSON();
          const before = this.player.cost();
          const r = this._deleteItem(d.hit, x, y);
          if (r.ok) this._commit(snap, before);
          else if (r.reason) this._reject(r.reason, x, y);
        }
        break;
      case 'member': {
        const t = this._target(d.from);
        if (t.same) {
          // 原地点一下：进入连续造杆
          if (!d.moved) { this.chain = { from: d.from }; this._snapKey = ''; this.audio.ui('tick'); }
          break;
        }
        if (!t.valid) { this._failGhost(t); this._reject(null); break; }
        const r = this._placeMember(d.from, t);
        if (!r.ok) { this._failGhost(t); this._reject(r.reason, t.x, t.y); }
        break;
      }
      case 'move': {
        const n = this.player.nodes.get(d.node);
        if (n && (n.x !== d.ox || n.y !== d.oy)) { this._pushUndo(d.snap); this.onChange({ delta: 0 }); }
        if (n) this.pops.set('n' + n.id, this.time);
        break;
      }
      case 'aim': {
        const c = this.player.cannons.get(d.cannon);
        if (c && Math.abs(c.angle - d.start) > 1e-9) { this._pushUndo(d.snap); this.onChange({ delta: 0 }); }
        break;
      }
      case 'erase':
        // 一次划动只算一步撤销；撤销按钮状态要刷新一下
        if (d.changed) { this._pushUndo(d.snap); this.onChange({ delta: 0 }); }
        break;
    }
    this._updateCursor();
  }

  _chainClick() {
    const from = this.chain.from;
    if (!this.player.nodes.has(from)) { this.chain = null; return; }
    const t = this._target(from);
    if (t.same) { this.chain = null; this.audio.ui('tick'); this._updateCursor(); return; }
    if (!t.valid) { this._reject(null); return; }
    const r = this._placeMember(from, t);
    if (!r.ok) { this._reject(r.reason, t.x, t.y); return; }
    this.chain = { from: r.to };
    this._snapKey = t.x + ',' + t.y;
  }

  _replaceMat(b, x, y) {
    const bp = this.player;
    const snap = bp.toJSON();
    const before = bp.cost();
    const r = bp.setBeamMat(b.id, this._tool);
    if (!r.ok) { this._reject(r.reason, x, y); return; }
    if (r.same) return;
    const delta = bp.cost() - before;
    this.pops.set('f' + b.id, this.time);
    this._float(signed(delta), x, y, delta > 0 ? BP.highlight : BP.valid);
    this._commit(snap, before);
    this.audio.ui('place');
  }

  _trackSnap(from) {
    if (!this.player.nodes.has(from)) return;
    const t = this._target(from);
    const key = t.x + ',' + t.y;
    if (key !== this._snapKey) {
      const first = this._snapKey === '';
      this._snapKey = key;
      if (!first) this._snapSound();
    }
  }

  _failGhost(t) { this.failGhost = { t0: this.time, t }; }

  // ================================================================ 光标
  _updateCursor() {
    let c = 'default';
    const d = this.drag;
    if (!this.enabled) c = 'default';
    else if (d && (d.kind === 'pan' || (d.kind === 'right' && d.panning))) c = 'grabbing';
    else if (d && (d.kind === 'aim' || d.kind === 'move')) c = (d.kind === 'move' && d.reason) ? 'not-allowed' : 'grabbing';
    else if (this.space) c = 'grab';
    else if ((d && d.kind === 'member') || this.chain) {
      const from = d ? d.from : this.chain.from;
      const t = this.player.nodes.has(from) ? this._target(from) : null;
      c = t && !t.valid && !t.same ? 'not-allowed' : 'crosshair';
    } else {
      const { x, y } = this._world();
      const tool = this._tool;
      if (tool !== 'erase' && this.pointer.inside && this.pickCannon(x, y)) c = 'grab';
      else if (tool === 'move') c = 'grab';
      else if (tool === 'cannon') {
        const b = this.pointer.inside ? this.pickBeam(x, y) : null;
        c = b && this.player.checkCannonMount(b.id) ? 'not-allowed' : 'crosshair';
      } else c = 'crosshair';
    }
    if (c !== this._cursor) {
      this._cursor = c;
      if (this.canvas.style) this.canvas.style.cursor = c;
    }
  }

  /**
   * 光标落在某根杆件的中段（沿杆 30%~70%）时返回它。
   * 低缩放下节点的拾取圈会盖住整根短杆，中段优先归杆件，短杆才点得到。
   */
  _midBeam(x, y) {
    const b = this.pickBeam(x, y);
    if (!b) return null;
    const a = this.player.nodes.get(b.a), c = this.player.nodes.get(b.b);
    const ex = c.x - a.x, ey = c.y - a.y;
    const t = ((x - a.x) * ex + (y - a.y) * ey) / (ex * ex + ey * ey || 1);
    return t >= 0.3 && t <= 0.7 ? b : null;
  }

  // ================================================================ 悬停
  _computeHover() {
    if (!this.enabled || !this.pointer.inside || this.chain) { this.hover = null; return; }
    const d = this.drag;
    if (d) {
      if (d.kind === 'aim') this.hover = { type: 'cannon', id: d.cannon };
      else if (d.kind === 'move') this.hover = { type: 'node', id: d.node };
      else if (d.kind === 'erase') this.hover = this._pickForDelete(this._world().x, this._world().y, true);
      else this.hover = null;
      return;
    }
    const { x, y } = this._world();
    const tool = this._tool;
    if (tool === 'erase') { this.hover = this._pickForDelete(x, y, false); return; }
    const c = this.pickCannon(x, y);
    if (c) { this.hover = { type: 'cannon', id: c.id }; return; }
    if (MEMBER_TOOLS.has(tool)) {
      const mid = this._midBeam(x, y);
      if (mid && mid.mat !== tool) { this.hover = { type: 'beam', id: mid.id }; return; }
    }
    if (tool !== 'cannon') {
      const n = this.pickNode(x, y);
      if (n) { this.hover = { type: 'node', id: n.id }; return; }
    }
    const b = this.pickBeam(x, y);
    this.hover = b ? { type: 'beam', id: b.id } : null;
  }

  /** 悬停价签的文字和颜色（按修订号缓存，删除退款要克隆一份蓝图来算） */
  _hoverInfo() {
    const h = this.hover;
    if (!h) return null;
    const tool = this._tool;
    const key = h.type + h.id + tool;
    const cache = this._hoverCache;
    if (cache.key === key && cache.rev === this.rev) return cache.info;
    const bp = this.player;
    let info = null;
    if (tool === 'erase' || (this.drag && this.drag.kind === 'erase')) {
      if (h.type === 'node' && bp.nodes.get(h.id)?.kind !== 'free') {
        const k = bp.nodes.get(h.id)?.kind;
        info = { text: k === 'core' ? '核心不能拆' : '锚点不能拆', color: BP.invalid, bad: true };
      } else {
        const cl = bp.clone();
        const r = h.type === 'cannon' ? cl.removeCannon(h.id) : h.type === 'node' ? cl.removeNode(h.id) : cl.removeBeam(h.id);
        const refund = r.ok ? bp.cost() - cl.cost() : 0;
        info = { text: '-' + money(refund), color: BP.invalid, del: true };
      }
    } else if (h.type === 'cannon') {
      const c = bp.cannons.get(h.id);
      if (c) info = { text: `火炮 · ${(c.angle / DEG).toFixed(1)}° · ${money(CANNON.cost)}`, color: BP.highlight };
    } else if (h.type === 'node') {
      const n = bp.nodes.get(h.id);
      if (n) {
        if (n.kind === 'core') info = { text: bp.rules.coreZone ? (tool === 'move' ? '核心 · 拖到范围里的任意位置' : '核心 · 需要结构托住（用「移动」可以挪）') : '核心 · 需要结构托住', color: BP.player };
        else if (n.kind === 'anchor') info = { text: tool === 'move' ? '锚点不能移动' : '锚点', color: tool === 'move' ? BP.invalid : BP.anchor };
        else info = { text: `节点 · ${bp.beamsOf(n.id).length} 根杆件`, color: BP.highlight };
      }
    } else if (h.type === 'beam') {
      const b = bp.beams.get(h.id);
      if (b) {
        const len = bp.beamLength(b);
        const cost = bp.beamCost(b);
        const m = MATERIALS[b.mat];
        if (MEMBER_TOOLS.has(tool) && tool !== b.mat) {
          const a = bp.nodes.get(b.a), c = bp.nodes.get(b.b);
          let why = bp.checkSpan(tool, a.x, a.y, c.x, c.y);
          if (!why && bp.cannonOn(b.id) && !CANNON.mountMats.includes(tool)) why = '上面架着火炮，不能换成这种材料';
          // 在副本上换一遍再比：换材料可能让原本合并的共线杆件分开，多出一份装配费
          const hyp = this._costIf((cl) => cl.setBeamMat(b.id, tool).ok);
          const delta = hyp != null ? hyp : Blueprint.priceFor(tool, a.x, a.y, c.x, c.y) - bp.rules.assemblyFee - cost;
          info = why ? { text: why, color: BP.invalid, bad: true }
            : { text: `换成${MATERIALS[tool].name} ${signed(delta)}`, color: BP.highlight };
        } else if (tool === 'cannon') {
          const why = bp.checkCannonMount(b.id);
          info = why ? { text: why, color: BP.invalid, bad: true } : { text: `架设火炮 +${money(CANNON.cost)}`, color: BP.valid };
        } else {
          info = { text: `${m.name} · ${len.toFixed(1)} m · ${money(cost)}`, color: BP.highlight };
        }
      }
    }
    cache.key = key; cache.rev = this.rev; cache.info = info;
    return info;
  }

  // ================================================================ 弹道缓存
  _shot(c) {
    const e = this._traj.get(c.id);
    if (e && e.rev === this.rev && e.angle === c.angle) return e.res;
    let res = null;
    try { res = predictShot(this.player, c, this.hideEnemy ? null : this.enemy); } catch { res = null; }
    this._traj.set(c.id, { rev: this.rev, angle: c.angle, res });
    if (this._traj.size > 16) {
      for (const id of this._traj.keys()) if (!this.player.cannons.has(id)) this._traj.delete(id);
    }
    return res;
  }

  // ================================================================ 绘制
  draw(dt) {
    this.time += dt || 0;
    const ctx = this.ctx;
    if (!ctx) return;
    const p = this.p, v = this.view;
    const t = this.time;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    p.frame(v, this.dpr, this.w, this.h, t, this.player.map);
    this._computeHover();

    p.paper();
    p.grid();
    p.water();
    p.terrain();
    p.zone(false, 1, '建造区');
    p.zone(true, 0.4, null);
    if (this.player.rules.coreZone) {
      // 核心范围：平时很淡，选了「移动」工具或正拖着核心时亮起来
      const d = this.drag;
      const dragging = d && d.kind === 'move' && this.player.nodes.get(d.node)?.kind === 'core';
      const hot = dragging || (this._tool === 'move' && this.enabled);
      p.coreZone(false, hot ? 0.95 : 0.3, BP.player, hot ? '核心范围' : null);
      if (this.hideEnemy) p.coreZone(true, 0.5, BP.enemy, null);
    }

    if (this.hideEnemy) this._drawHiddenEnemy(); else this._drawEnemy();

    // 所有火炮的弹道（弱）
    const active = this._activeCannon();
    for (const c of this.player.cannons.values()) {
      if (c.id === active) continue;
      const s = this._shot(c);
      if (s) p.dotted(s.pts, s.end.kind === 'own' ? BP.trajectoryBlocked : BP.trajectory, 0.34, 2, 7);
    }

    this._drawReportUnder();
    this._drawPlayer();
    this._drawReportOver();
    this._drawDying();
    this._drawHover();
    this._drawGhost();
    if (active != null) this._drawActiveShot(active);
    this._drawFloats();
    this._updateCursor();

    // 清理过期动画
    if (this.failGhost && t - this.failGhost.t0 > SHAKE_T) this.failGhost = null;
    if (this.pops.size > 0) for (const [k, t0] of this.pops) if (t - t0 > 0.5) this.pops.delete(k);
    while (this.dying.length && t - this.dying[0].t0 > DIE_T) this.dying.shift();
    while (this.floats.length && t - this.floats[0].t0 > FLOAT_T) this.floats.shift();
  }

  _activeCannon() {
    const d = this.drag;
    if (d && d.kind === 'aim') return d.cannon;
    if (this.hover && this.hover.type === 'cannon' && this._tool !== 'erase') return this.hover.id;
    return null;
  }

  _w(mat) {
    const w = Math.max(2.5, BP.matWidth[mat] * this.view.ppm);
    return mat === 'steel' ? Math.max(4, w) : w;
  }
  _nodeR() { return Math.min(5.5, Math.max(2.6, 0.11 * this.view.ppm)); }

  /** 新杆件弹出：沿长度方向的缩放（带一点过冲） */
  _popScale(key) {
    const t0 = this.pops.get(key);
    if (t0 == null) return 1;
    const k = (this.time - t0) / POP_T;
    if (k >= 1) return 1;
    if (k < 0.7) return 0.55 + 0.53 * (k / 0.7);
    return 1.08 - 0.08 * ((k - 0.7) / 0.3);
  }
  _flash(key) {
    const t0 = this.pops.get(key);
    if (t0 == null) return 0;
    const k = (this.time - t0) / FLASH_T;
    return k >= 1 || k < 0 ? 0 : 1 - k;
  }

  /** 对方的堡垒被遮住时：只画对面的锚点和一句说明 */
  _drawHiddenEnemy() {
    const p = this.p, v = this.view, M = this.map, W = M.fieldW;
    const r = this._nodeR();
    for (const [x, y] of M.anchors) p.anchor(v.sx(W - x), v.sy(y), Math.max(7, r * 2.2), BP.enemy, M.surfaceKind(x, y) === 'wall' ? 'right' : 'down', 0.5);
    // 说明写在对方核心范围的上方
    const Z = M.coreZone || M.build;
    const cx = v.sx(W - (Z.xMin + Z.xMax) / 2), cy = v.sy(Z.yMax) - Math.min(14, 0.5 * v.ppm) - 22;
    p.label(cx, cy, this.labels.foe, BP.enemy, 12, 'center', 'bottom', 0.9, 700);
    p.label(cx, cy + 2, '开战前看不到 · 核心在虚线框里', BP.enemyDim, 11, 'center', 'top', 1, 600);
  }

  _drawEnemy() {
    const p = this.p, v = this.view, bp = this.enemy, M = this.map, W = M.fieldW;
    if (!bp) return;
    const A = 0.62;
    const X = (x) => v.sx(W - x);
    for (const b of bp.beams.values()) {
      const a = bp.nodes.get(b.a), c = bp.nodes.get(b.b);
      p.member(X(a.x), v.sy(a.y), X(c.x), v.sy(c.y), b.mat, BP.enemy, this._w(b.mat), A);
    }
    for (const c of bp.cannons.values()) {
      const q = bp.cannonPose(c);
      p.cannon(this._mirrorPose(q), BP.enemyDim, BP.enemy, A);
    }
    let maxY = -Infinity, minX = Infinity, maxX = -Infinity;
    const r = this._nodeR();
    for (const n of bp.nodes.values()) {
      const sx = X(n.x), sy = v.sy(n.y);
      if (n.kind === 'anchor') p.anchor(sx, sy, Math.max(7, r * 2.2), BP.enemy, M.surfaceKind(n.x, n.y) === 'wall' ? 'right' : 'down', A);
      else if (n.kind === 'free') p.node(sx, sy, r, BP.enemy, BP.paper, A);
      maxY = Math.max(maxY, n.y); minX = Math.min(minX, W - n.x); maxX = Math.max(maxX, W - n.x);
    }
    const core = bp.coreNode();
    if (core) p.core(X(core.x), v.sy(core.y), BP.enemy, v.ppm, '核心', 0.85);
    if (maxY > -Infinity) {
      const cx = v.sx((minX + maxX) / 2), cy = v.sy(maxY) - 22;
      p.label(cx, cy, this.labels.foe, BP.enemy, 12, 'center', 'bottom', 0.9, 700);
      p.label(cx, cy + 2, money(bp.cost()), BP.enemyDim, 11, 'center', 'top', 1, 600);
    }
  }

  _mirrorPose(q) {
    const W = this.map.fieldW;
    return { px: W - q.px, py: q.py, mx: W - q.mx, my: q.my, angle: Math.PI - q.angle, beamAngle: Math.PI - q.beamAngle };
  }

  _beamScreen(b, bp = this.player) {
    const v = this.view;
    const a = bp.nodes.get(b.a), c = bp.nodes.get(b.b);
    let ax = v.sx(a.x), ay = v.sy(a.y), bx = v.sx(c.x), by = v.sy(c.y);
    const s = this._popScale('b' + b.id);
    if (s !== 1) {
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      ax = mx + (ax - mx) * s; ay = my + (ay - my) * s; bx = mx + (bx - mx) * s; by = my + (by - my) * s;
    }
    return [ax, ay, bx, by];
  }

  _drawPlayer() {
    const p = this.p, v = this.view, bp = this.player;
    // 杆件
    for (const b of bp.beams.values()) {
      const [ax, ay, bx, by] = this._beamScreen(b);
      const w = this._w(b.mat);
      p.member(ax, ay, bx, by, b.mat, BP.mat[b.mat], w);
      const f = Math.max(this._flash('b' + b.id), this._flash('f' + b.id));
      if (f > 0) {
        p.halo(ax, ay, bx, by, BP.highlight, w + 7, 0.35 * f);
        p.member(ax, ay, bx, by, b.mat, BP.highlight, w, f);
      }
    }
    // 火炮
    for (const c of bp.cannons.values()) {
      const pose = bp.cannonPose(c);
      const s = this._popScale('c' + c.id);
      p.cannon(pose, BP.player, BP.ink, 1, s);
      const f = this._flash('c' + c.id);
      if (f > 0) p.cannon(pose, BP.highlight, BP.highlight, f * 0.8, s);
    }
    // 节点
    const r = this._nodeR();
    for (const n of bp.nodes.values()) {
      const sx = v.sx(n.x), sy = v.sy(n.y);
      if (n.kind === 'anchor') p.anchor(sx, sy, Math.max(7, r * 2.2), BP.anchor, bp.map.surfaceKind(n.x, n.y) === 'wall' ? 'left' : 'down');
      else if (n.kind === 'free') {
        const s = this._popScale('n' + n.id);
        p.node(sx, sy, r * s, BP.ink);
      }
    }
    const core = bp.coreNode();
    if (core) p.core(v.sx(core.x), v.sy(core.y), BP.player, v.ppm, '核心', 1);
    // 双人轮流搭建时写明这是谁的堡垒
    if (this.labels.me) {
      const B = bp.map.build;
      p.label(v.sx(B.xMin) + 8, v.sy(B.yMax) + 24, this.labels.me, BP.player, 12, 'left', 'top', 0.95, 700);
    }
  }

  // ---------- 战报 ----------
  _drawReportUnder() {
    const rep = this._reportItems();
    if (!rep) return;
    const p = this.p;
    for (const { b, info } of rep.broken) {
      const [ax, ay, bx, by] = this._beamScreen(b);
      const col = info.cause === 'blast' ? BP.anchor : BP.invalid;
      const first = info.order === 1;
      const pulse = first ? 0.5 + 0.5 * Math.sin(this.time * 4) : 0;
      p.halo(ax, ay, bx, by, col, this._w(b.mat) + (first ? 14 + pulse * 4 : 10), first ? 0.42 : 0.28);
    }
  }

  _drawReportOver() {
    const rep = this._reportItems();
    if (!rep) return;
    const p = this.p, bp = this.player, v = this.view;
    // 幸存但受力高的杆件：下方一道细色线
    {
      const rgb = [0, 0, 0];
      for (const { b, pk } of rep.peaks) {
        const [ax, ay, bx, by] = this._beamScreen(b);
        const L = Math.hypot(bx - ax, by - ay);
        if (L < 1) continue;
        let nx = -(by - ay) / L, ny = (bx - ax) / L;
        if (ny < 0) { nx = -nx; ny = -ny; } // 朝屏幕下方
        const off = this._w(b.mat) / 2 + 3.5;
        const ctx = this.ctx;
        ctx.beginPath();
        ctx.moveTo(ax + nx * off, ay + ny * off); ctx.lineTo(bx + nx * off, by + ny * off);
        ctx.strokeStyle = cssRGB(stressRGB(pk, rgb)); ctx.lineWidth = 2; ctx.lineCap = 'round';
        ctx.globalAlpha = 0.95; ctx.stroke(); ctx.globalAlpha = 1;
      }
    }
    // 编号徽章：按顺序从后往前画，让 1 号压在最上面
    const items = rep.broken.slice();
    items.sort((a, b) => b.info.order - a.info.order);
    for (const { b, info } of items) {
      const [ax, ay, bx, by] = this._beamScreen(b);
      const mx = (ax + bx) / 2, my = (ay + by) / 2;
      const col = info.cause === 'blast' ? BP.anchor : BP.invalid;
      const k = Math.min(1, Math.max(0, (this.time - this._reportT0 - (info.order - 1) * 0.035) / 0.18));
      if (k <= 0) continue;
      const ease = 1 + 0.25 * Math.sin(k * Math.PI) * (1 - k);
      const first = info.order === 1;
      const r = (first ? 11 : 8) * ease * (0.6 + 0.4 * k);
      if (first) {
        const ph = (this.time * 1.1) % 1;
        p.ring(mx, my, r + 3 + ph * 10, col, 2, (1 - ph) * 0.8 * k);
        p.badge(mx, my, r, '1', col, BP.ink, BP.ink, k);
      } else {
        p.badge(mx, my, r, String(info.order), rgba(BP.paperEdge, 0.92), col, BP.ink, 0.92 * k);
      }
      if (info.order <= 3) {
        p.label(mx, my - r - 4, info.cause === 'blast' ? '击毁' : '超载', col, first ? 12 : 11, 'center', 'bottom', k, 700);
      }
    }
  }

  // ---------- 删除动画 ----------
  _drawDying() {
    const p = this.p, v = this.view;
    for (const d of this.dying) {
      const k = Math.min(1, (this.time - d.t0) / DIE_T);
      const s = 1 - 0.6 * k, a = 1 - k;
      if (a <= 0) continue;
      for (const g of d.beams) {
        const ax = v.sx(g.ax), ay = v.sy(g.ay), bx = v.sx(g.bx), by = v.sy(g.by);
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        p.member(mx + (ax - mx) * s, my + (ay - my) * s, mx + (bx - mx) * s, my + (by - my) * s, g.mat, BP.invalid, this._w(g.mat), a);
      }
      for (const g of d.cannons) p.cannon(g, BP.invalid, BP.invalid, a * 0.9, s);
      for (const g of d.nodes) p.node(v.sx(g.x), v.sy(g.y), this._nodeR() * s, BP.invalid, BP.paper, a);
    }
  }

  // ---------- 悬停 ----------
  _drawHover() {
    const h = this.hover;
    if (!h) return;
    const p = this.p, v = this.view, bp = this.player;
    const info = this._hoverInfo();
    const isDel = info && info.del;
    const col = isDel || (info && info.bad) ? BP.invalid : BP.highlight;
    const d = this.drag;
    if (h.type === 'beam') {
      const b = bp.beams.get(h.id);
      if (!b) return;
      const [ax, ay, bx, by] = this._beamScreen(b);
      const w = this._w(b.mat);
      p.halo(ax, ay, bx, by, col, w + 8, 0.28);
      p.member(ax, ay, bx, by, b.mat, col, w);
      if (this._tool === 'cannon' && !(info && info.bad)) {
        // 预览火炮
        const a = bp.nodes.get(b.a), c = bp.nodes.get(b.b);
        p.cannon(cannonPoseFrom(a.x, a.y, c.x, c.y, 45 * DEG), BP.valid, BP.valid, 0.55 + 0.1 * Math.sin(this.time * 6));
      }
      if (isDel) {
        const c = bp.cannonOn(b.id);
        if (c) p.cannon(bp.cannonPose(c), BP.invalid, BP.invalid, 0.85);
      }
    } else if (h.type === 'node') {
      const n = bp.nodes.get(h.id);
      if (!n) return;
      const sx = v.sx(n.x), sy = v.sy(n.y), r = this._nodeR();
      if (isDel) {
        for (const b of bp.beamsOf(n.id)) {
          const [ax, ay, bx, by] = this._beamScreen(b);
          p.member(ax, ay, bx, by, b.mat, BP.invalid, this._w(b.mat), 0.9);
          const c = bp.cannonOn(b.id);
          if (c) p.cannon(bp.cannonPose(c), BP.invalid, BP.invalid, 0.85);
        }
      }
      if (n.kind === 'free') {
        p.ring(sx, sy, r + 4, col, 2, 0.9);
        p.node(sx, sy, r, col, BP.paper);
      } else {
        p.ring(sx, sy, n.kind === 'core' ? CORE.radius * v.ppm + 4 : r * 1.6 + 4, col, 2, 0.9);
      }
      // 移动中且被拒：在光标边上显示原因
      if (d && d.kind === 'move' && d.reason) {
        p.chip(this.pointer.sx, this.pointer.sy, d.reason, BP.invalid);
        return;
      }
    } else if (h.type === 'cannon') {
      const c = bp.cannons.get(h.id);
      if (!c) return;
      const pose = bp.cannonPose(c);
      p.cannon(pose, isDel ? BP.invalid : BP.highlight, isDel ? BP.invalid : BP.ink, 1);
    }
    if (info && !(d && (d.kind === 'aim' || d.kind === 'move'))) p.chip(this.pointer.sx, this.pointer.sy, info.text, info.color);
  }

  // ---------- 幽灵杆件 ----------
  _drawGhost() {
    const p = this.p, v = this.view, bp = this.player;
    const d = this.drag;
    let from = null;
    if (d && d.kind === 'member') from = d.from;
    else if (this.chain) from = this.chain.from;

    // 失败的幽灵：原地抖一下淡出
    if (this.failGhost) {
      const k = (this.time - this.failGhost.t0) / SHAKE_T;
      if (k < 1) {
        const t = this.failGhost.t;
        const sh = Math.sin(k * Math.PI * 7) * 5 * (1 - k);
        p.member(v.sx(t.fx) + sh, v.sy(t.fy), v.sx(t.x) + sh, v.sy(t.y), t.mat, BP.invalid, this._w(t.mat), 1 - k);
        if (t.reason) p.chip(v.sx(t.x) + sh, v.sy(t.y), t.reason, BP.invalid, { alpha: 1 - k });
      }
    }

    if (from == null) {
      // 闲置时，造杆工具在建造区内显示吸附点
      if (MEMBER_TOOLS.has(this._tool) && this.enabled && this.pointer.inside && !d && !this.hover && !this.space) {
        const { x, y } = this._world();
        const s = this._snap(x, y);
        if (!bp.checkNodePos(s.x, s.y)) {
          const sx = v.sx(s.x), sy = v.sy(s.y);
          const ctx = this.ctx;
          ctx.beginPath(); ctx.moveTo(sx - 4, sy); ctx.lineTo(sx + 4, sy); ctx.moveTo(sx, sy - 4); ctx.lineTo(sx, sy + 4);
          ctx.strokeStyle = BP.inkSoft; ctx.lineWidth = 1; ctx.stroke();
        }
      }
      return;
    }
    if (!bp.nodes.has(from)) return;
    const t = this._target(from);
    const fx = v.sx(t.fx), fy = v.sy(t.fy);
    // 最大长度的范围圈
    p.ring(fx, fy, MATERIALS[t.mat].maxLen * v.ppm, BP.inkFaint, 1, 1, [4, 5]);
    p.ring(fx, fy, this._nodeR() + 4, BP.highlight, 1.5, 0.9);
    if (t.same) return;
    const sk = this.time - this.shakeT0 < SHAKE_T ? (1 - (this.time - this.shakeT0) / SHAKE_T) : 0;
    const sh = sk > 0 ? Math.sin((1 - sk) * Math.PI * 7) * 5 * sk : 0;
    const col = t.valid ? BP.valid : BP.invalid;
    const tx = v.sx(t.x) + sh, ty = v.sy(t.y);
    p.member(fx + sh, fy, tx, ty, t.mat, col, this._w(t.mat), t.valid ? 0.9 : 0.8);
    p.ring(tx, ty, t.node ? 9 : 5.5, col, 1.8);
    if (!t.node) p.node(tx, ty, this._nodeR() * 0.8, col, BP.paper, 0.9);
    let text, chipCol;
    if (t.valid) {
      text = `+${money(t.price)} · ${t.len.toFixed(1)} m`;
      chipCol = BP.highlight;
      if (bp.cost() + t.price > bp.map.budget) { text += ' · 超预算'; chipCol = BP.invalid; }
    } else { text = t.reason; chipCol = BP.invalid; }
    p.chip(this.pointer.sx + sh, this.pointer.sy, text, chipCol);
  }

  // ---------- 当前火炮的弹道 ----------
  _drawActiveShot(id) {
    const c = this.player.cannons.get(id);
    if (!c) return;
    const s = this._shot(c);
    const p = this.p, v = this.view;
    const pose = this.player.cannonPose(c);
    if (s) {
      const blocked = s.end.kind === 'own';
      p.dotted(s.pts, blocked ? BP.trajectoryBlocked : BP.trajectory, 1, 3, 8);
      const ex = v.sx(s.end.x), ey = v.sy(s.end.y);
      switch (s.end.kind) {
        case 'enemyCore':
          p.target(ex, ey, BP.trajectory, this.time);
          p.chip(ex, ey - 30, '命中核心', BP.highlight, { align: 'center' });
          break;
        case 'enemyBeam':
        case 'enemyCannon':
          p.cross(ex, ey, 6, BP.trajectory, 2.4);
          p.ring(ex, ey, 10, BP.trajectory, 1.2, 0.6);
          break;
        case 'own':
          p.cross(ex, ey, 7, BP.invalid, 2.6);
          p.chip(ex, ey - 26, '被自家结构挡住', BP.invalid, { align: 'center' });
          break;
        default:
          p.ring(ex, ey, 4, BP.trajectory, 1.4, 0.5);
      }
    }
    // 射角读数：小弧 + 数字
    const ctx = this.ctx;
    const px = v.sx(pose.px), py = v.sy(pose.py);
    const R = Math.max(22, CANNON.barrelLen * v.ppm * 0.55);
    ctx.beginPath();
    ctx.moveTo(px, py); ctx.lineTo(px + R + 6, py);
    ctx.strokeStyle = BP.inkFaint; ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(px, py, R, 0, -c.angle, c.angle > 0);
    ctx.strokeStyle = BP.highlight; ctx.lineWidth = 1.5; ctx.stroke();
    const deg = (c.angle / DEG).toFixed(1) + '°';
    const la = c.angle / 2;
    p.chip(px + Math.cos(la) * (R + 26), py - Math.sin(la) * (R + 26), deg, BP.highlight, { align: 'center' });
  }

  _drawFloats() {
    const p = this.p, v = this.view;
    for (const f of this.floats) {
      const k = (this.time - f.t0) / FLOAT_T;
      if (k >= 1) continue;
      const rise = 26 * (1 - Math.pow(1 - k, 2));
      const a = k < 0.45 ? 1 : 1 - (k - 0.45) / 0.55;
      p.chip(v.sx(f.x), v.sy(f.y) - 18 - rise, f.text, f.color, { align: 'center', alpha: a });
    }
  }
}
