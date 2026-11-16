// 对局设置：在哪张地图上打、和谁打、现在编辑的是哪一方。
// 字标下面一排小按钮，加两个弹出面板（地图、对手）。只管界面，所有决定都通过 actions 交给 main.js。

import { ICON } from './icons.js';
import { THEME } from '../theme.js';
import { compileMapLoose } from '../map.js';

const BP = THEME.bp;

function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}
function button(parent, cls, label, onClick) {
  const b = el('button', 'btn ' + cls, parent);
  b.type = 'button'; b.tabIndex = -1;
  if (label) { b.title = label; b.setAttribute('aria-label', label); }
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', (e) => { if (!b.disabled) onClick(e); });
  return b;
}
const money = (n) => '$' + Math.round(n).toLocaleString('en-US');

/** 地图缩略图：蓝图画法的整张剖面（两侧对称） */
export function drawMapThumb(canvas, raw) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || 220, h = canvas.clientHeight || 96;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const c = canvas.getContext('2d');
  if (!c) return;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = BP.paper; c.fillRect(0, 0, w, h);
  let M;
  try { M = compileMapLoose(raw); } catch { return; }
  const B = M.build, W = M.fieldW;
  const x0 = B.xMin - 3, x1 = W - B.xMin + 3;
  let lo = M.hasWater ? M.waterY - 3 : Infinity, hi = Math.max(B.yMax + 1, M.gMax + 2);
  for (const [x, y] of M.worldGround) if (x >= x0 && x <= x1) lo = Math.min(lo, y - 2);
  lo = Math.min(lo, M.groundIn(x0) - 2, B.yMin - 1);
  const k = Math.min(w / (x1 - x0), h / (hi - lo));
  const ox = (w - (x1 - x0) * k) / 2, oy = (h - (hi - lo) * k) / 2;
  const X = (x) => ox + (x - x0) * k, Y = (y) => oy + (hi - y) * k;
  if (M.hasWater) {
    c.fillStyle = BP.water;
    for (const [a, b] of M.waterSpans) c.fillRect(X(Math.max(a, x0)), Y(M.waterY), (Math.min(b, x1) - Math.max(a, x0)) * k, h);
  }
  const trace = () => {
    c.beginPath();
    let first = true;
    for (const [x, y] of M.worldGround) {
      const px = Math.max(-20, Math.min(w + 20, X(x)));
      if (first) { c.moveTo(px, Y(y)); first = false; } else c.lineTo(px, Y(y));
    }
  };
  trace(); c.lineTo(w + 20, h + 20); c.lineTo(-20, h + 20); c.closePath();
  c.fillStyle = BP.paperEdge; c.fill();
  c.fillStyle = 'rgba(255,255,255,0.10)'; c.fill();
  trace(); c.strokeStyle = BP.ink; c.lineWidth = 1.5; c.lineJoin = 'round'; c.stroke();
  if (M.hasWater) {
    c.strokeStyle = BP.waterLine; c.lineWidth = 1;
    for (const [a, b] of M.waterSpans) { c.beginPath(); c.moveTo(X(Math.max(a, x0)), Y(M.waterY)); c.lineTo(X(Math.min(b, x1)), Y(M.waterY)); c.stroke(); }
  }
  // 锚点和核心默认位置：左蓝右橙
  for (let side = 0; side < 2; side++) {
    const mx = (x) => X(side ? W - x : x);
    c.fillStyle = BP.anchor;
    for (const [ax, ay] of M.anchors) { c.beginPath(); c.arc(mx(ax), Y(ay), 2.2, 0, 6.3); c.fill(); }
    if (M.core) {
      c.fillStyle = side ? BP.enemy : BP.player;
      c.beginPath(); c.arc(mx(M.core[0]), Y(M.core[1]), 3.2, 0, 6.3); c.fill();
    }
  }
}

export class SetupUI {
  /**
   * @param {{ root: HTMLElement, box: HTMLElement, actions: object }} o
   *   box 是字标下面放按钮的容器；actions 见 main.js 的 _setupActions
   */
  constructor({ root, box, actions }) {
    this.act = actions;
    this.state = null;
    this.isOpen = false;

    // ---- 字标下面的一排 ----
    this.mapBtn = button(box, 'chip setup-chip', '换地图，或者自己画一张', () => this.open('maps'));
    this.mapBtn.insertAdjacentHTML('beforeend', ICON.map);
    this.mapName = el('span', 'sc-text', this.mapBtn, '');
    this.rivalBtn = button(box, 'chip setup-chip', '选对手：守军、自己的镜像、另一位玩家，或者导入的堡垒', () => this.open('rival'));
    this.rivalBtn.insertAdjacentHTML('beforeend', ICON.versus);
    el('span', 'sc-k', this.rivalBtn, '对手');
    this.rivalName = el('span', 'sc-text', this.rivalBtn, '');
    this.seatSeg = el('div', 'chip seat-seg', box);
    el('span', 'sc-k', this.seatSeg, '正在搭');
    this.seatBtns = [0, 1].map((s) => button(this.seatSeg, 'seat-opt', '', () => this.act.editSeat(s)));

    // ---- 弹出面板（和回放列表同一种卡片）----
    this.veil = el('div', 'arena setup-veil pe', root);
    this.veil.addEventListener('pointerdown', (e) => { if (e.target === this.veil) this.close(); });
    const card = el('div', 'panel arena-card setup-card', this.veil);
    const head = el('div', 'ar-head', card);
    const ht = el('div', '', head);
    this.title = el('div', 'ar-title', ht, '');
    this.sub = el('div', 'ar-sub', ht, '');
    const x = button(head, 'icon-btn sm', '关闭（Esc）', () => this.close());
    x.innerHTML = ICON.close;
    this.body = el('div', 'ar-body setup-body', card);
    this.foot = el('div', 'setup-foot', card);

    // 读文件用的隐藏输入框
    this.file = el('input', '', root);
    this.file.type = 'file'; this.file.accept = '.json,application/json'; this.file.style.display = 'none';
    this.file.addEventListener('change', () => {
      const f = this.file.files && this.file.files[0];
      const cb = this._onFile;
      this.file.value = ''; this._onFile = null;
      if (!f || !cb) return;
      f.text().then((t) => {
        let o;
        try { o = JSON.parse(t); } catch { cb(null, f.name); return; }
        cb(o, f.name.replace(/\.json$/i, ''));
      });
    });
  }

  /** 让用户选一个 JSON 文件；cb(对象 | null, 文件名) */
  pickFile(cb) { this._onFile = cb; this.file.click(); }

  /**
   * @param {object} st { map:{id,name}, maps:[{id,name,raw,custom}], rival:kind, rivals:[{kind,name,desc,ok}],
   *                      editing:0|1, hideFoe:boolean, names:[左,右] }
   */
  setState(st) {
    this.state = st;
    this.mapName.textContent = st.map.name;
    this.rivalName.textContent = (st.rivals.find((r) => r.kind === st.rival) || {}).name || '';
    const two = st.rival === 'human';
    this.seatSeg.classList.toggle('on', two);
    this.seatBtns.forEach((b, s) => { b.textContent = st.names[s]; b.classList.toggle('on', st.editing === s); b.classList.toggle('p2', s === 1); });
    if (this.isOpen) this._render();
  }

  open(which) {
    this.which = which;
    this.isOpen = true;
    this.veil.classList.add('on');
    this._render();
  }
  close() { this.isOpen = false; this.veil.classList.remove('on'); }

  _render() {
    const st = this.state;
    if (!st) return;
    this.body.textContent = ''; this.foot.textContent = '';
    if (this.which === 'maps') this._renderMaps(st); else this._renderRival(st);
  }

  _renderMaps(st) {
    this.title.textContent = '地图';
    this.sub.textContent = '场地左右对称，两边条件一样。可以复制一张来改，也可以从头画。每张地图各存各的堡垒。';
    const grid = el('div', 'map-grid', this.body);
    for (const m of st.maps) {
      const cell = el('div', 'map-cell' + (m.id === st.map.id ? ' sel' : ''), grid);
      const pick = button(cell, 'map-pick', `用「${m.name}」`, () => { this.act.pickMap(m.id); this.close(); });
      const cv = el('canvas', 'map-thumb', pick);
      const row = el('div', 'map-row', pick);
      el('span', 'map-name', row, m.name);
      if (m.id === st.map.id) { const ck = el('span', 'map-on', row); ck.innerHTML = ICON.check; }
      el('div', 'map-meta', pick, `${m.raw.water == null ? '无水' : '有水'} · 宽 ${m.raw.fieldW} 米 · ${money(m.raw.budget)} · ${m.raw.maxCannons} 门炮${m.custom ? ' · 自定义' : ''}`);
      const tools = el('div', 'map-tools', cell);
      const tb = (icon, label, fn) => { const b = button(tools, 'icon-btn sm', label, fn); b.innerHTML = icon; return b; };
      if (m.custom) tb(ICON.edit, '编辑这张地图', () => { this.close(); this.act.editMap(m.id); });
      tb(ICON.copy, '复制一份来改', () => { this.close(); this.act.copyMap(m.id); });
      tb(ICON.download, '导出成文件（可以发给别人，或者给 AI 对战用）', () => this.act.exportMap(m.id));
      if (m.custom) {
        const del = tb(ICON.trash, '删除这张地图', () => {
          if (!del.classList.contains('armed')) { del.classList.add('armed'); del.title = '再点一次确认删除'; setTimeout(() => { del.classList.remove('armed'); del.title = '删除这张地图'; }, 2000); return; }
          this.act.deleteMap(m.id);
        });
      }
      requestAnimationFrame(() => drawMapThumb(cv, m.raw));
    }
    const mk = (icon, text, fn) => { const b = button(this.foot, 'setup-act', text, fn); b.insertAdjacentHTML('beforeend', icon); el('span', '', b, text); };
    mk(ICON.plus, '新建地图', () => { this.close(); this.act.newMap(); });
    mk(ICON.upload, '导入地图文件', () => this.pickFile((o, name) => this.act.importMap(o, name)));
  }

  _renderRival(st) {
    this.title.textContent = '对手';
    this.sub.textContent = '左边是玩家 1，右边是对手。人和 AI 用的是同一套堡垒文件：导出的堡垒可以拿去打 AI，AI 设计的堡垒也可以导进来打。';
    const list = el('div', 'rival-list', this.body);
    for (const r of st.rivals) {
      const b = button(list, 'rival-opt' + (r.kind === st.rival ? ' sel' : ''), r.name, () => {
        if (r.kind === 'file') { this.pickFile((o, name) => { if (this.act.importRival(o, name)) this.close(); }); return; }
        this.act.rival(r.kind);
        if (r.kind !== 'human') this.close();
      });
      b.disabled = !r.ok;
      const dot = el('span', 'ro-dot', b);
      if (r.kind === st.rival) dot.innerHTML = ICON.check;
      const tx = el('span', 'ro-text', b);
      el('span', 'ro-name', tx, r.name);
      el('span', 'ro-desc', tx, r.ok ? r.desc : r.why || r.desc);
    }
    if (st.rival === 'human') {
      const row = el('label', 'rival-check', this.body);
      const cb = el('input', '', row);
      cb.type = 'checkbox'; cb.checked = !!st.hideFoe;
      cb.addEventListener('change', () => this.act.hideFoe(cb.checked));
      el('span', '', row, '搭建时遮住对方的堡垒（轮流搭，互相不看）');
    }
    const mk = (icon, text, fn) => { const b = button(this.foot, 'setup-act', text, fn); b.insertAdjacentHTML('beforeend', icon); el('span', '', b, text); };
    const me = st.rival === 'human' ? st.names[st.editing] + ' ' : '我方';
    mk(ICON.download, `导出${me}的堡垒`, () => this.act.exportFort());
    mk(ICON.upload, `导入${me}的堡垒`, () => this.pickFile((o, name) => { if (this.act.importFort(st.editing, o, name)) this.close(); }));
  }
}
