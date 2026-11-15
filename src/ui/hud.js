// 桁垒 TRUSSFORT — 界面层（HUD）：蓝图模式与实景模式下的全部 DOM。
// 只读 sim，从不改动 sim。每帧 setBattle 时只在显示值变化后才碰 DOM。

import { CFG, MATERIALS, MATERIAL_ORDER, CANNON } from '../config.js';
import { THEME, stressRGB } from '../theme.js';
import { ICON, SWATCH } from './icons.js';

const HINT_KEY = 'trussfort.hint.v1';
const ROLL_MS = 260;
const DELTA_MS = 700;
const TOAST_MS = 2400;
const ARM_MS = 2000;
const SPEEDS = [0.25, 1, 2, 4];

const BREAKDOWN_ROWS = [
  ['wood', '木杆'], ['steel', '钢梁'], ['rope', '绳索'], ['spring', '弹簧'], ['cannon', '火炮'],
];

const HELP_LINES = [
  '从锚点或已有节点拖出杆件',
  '单击节点可连续搭建',
  '右键或拆除工具删除（全额退款）',
  '拖动炮管调整射角',
  '滚轮缩放，空格或中键拖动平移',
  'Ctrl/Cmd+Z 撤销',
];

// ------------------------------------------------------------ 小工具
const raf = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(() => fn(Date.now()), 16));
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const money = (n) => '$' + Math.round(Math.abs(n)).toLocaleString('en-US');
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
function clock(sec) {
  const s = Math.max(0, Math.ceil(sec - 1e-6));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function reducedMotion() {
  try { return !!(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches); } catch { return false; }
}
function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}
function html(tag, cls, parent, markup) {
  const e = el(tag, cls, parent);
  e.innerHTML = markup;
  return e;
}
function keycap(parent, text, extra = '') { return el('span', 'kc' + (extra ? ' ' + extra : ''), parent, text); }
/** 重新触发一次 CSS 动画 */
function retrigger(e, cls) {
  e.classList.remove(cls);
  void e.offsetWidth;
  e.classList.add(cls);
}

export class Hud {
  constructor({ root, actions }) {
    this.root = root;
    this.act = actions || {};
    this.mode = null;
    this.tool = null;
    this._shown = 0;        // 预算数字当前显示值（滚动中）
    this._target = 0;
    this._roll = null;
    this._budgetInit = false;
    this._toasts = [];
    this._armed = new Map();
    this._sim = null;
    this._bt = null;
    this._pips = [[], []];
    this._helpOpen = false;
    this._reduced = reducedMotion();

    root.classList.add('hud');
    this.bp = el('div', 'hud-layer layer-bp', root);
    this.bt = el('div', 'hud-layer layer-bt', root);
    this.shared = el('div', 'hud-layer layer-shared on', root);

    this._buildBlueprint();
    this._buildBattle();
    this._buildShared();
    this.toastBox = el('div', 'toasts', root);

    // ? 打开帮助；Esc / 点外面 关闭帮助
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('keydown', (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === '?' && this.mode === 'blueprint') { this._toggleHelp(); return; }
        if (e.key === 'Escape' && this._helpOpen) this._toggleHelp(false);
      });
      window.addEventListener('resize', () => this._fit());
      window.addEventListener('pointerdown', (e) => {
        if (!this._helpOpen) return;
        const t = e.target;
        if (this.helpCard.contains(t) || this.helpBtn.contains(t)) return;
        this._toggleHelp(false);
      });
    }
  }

  // ============================================================ 构建：通用
  _button(parent, cls, onClick, label) {
    const b = el('button', 'btn ' + cls, parent);
    b.type = 'button';
    b.tabIndex = -1; // 不抢键盘焦点，避免 Space / Enter 与全局快捷键重复触发
    if (label) { b.setAttribute('aria-label', label); b.title = label; }
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => {
      if (b.disabled) return;
      if (b.blur) b.blur();
      onClick(e);
    });
    return b;
  }
  _call(name, ...args) { const f = this.act[name]; if (typeof f === 'function') f(...args); }

  // ============================================================ 构建：蓝图模式
  _buildBlueprint() {
    const L = this.bp;

    // 左上：字标 + 上一战标记
    const brand = el('div', 'brand', L);
    el('div', 'brand-cn', brand, '桁垒');
    el('div', 'brand-en', brand, 'TRUSSFORT');
    this.reportChip = this._button(L, 'chip report-chip pe', () => {
      this._call('report');
      this.setReport(null);
    }, '隐藏上一战的损毁标记');
    el('span', 'dot', this.reportChip);
    this.reportText = el('span', 'rc-text', this.reportChip, '');
    el('span', 'rc-sep', this.reportChip, '·');
    el('span', 'rc-act', this.reportChip, '隐藏标记');

    // 上中：预算
    const bud = el('div', 'panel budget pe', L);
    this.budgetEl = bud;
    const r1 = el('div', 'bud-row', bud);
    el('span', 'bud-label', r1, '预算');
    this.budStatus = el('span', 'bud-status', r1, '');
    const r2 = el('div', 'bud-num', bud);
    this.budSpent = el('span', 'bud-spent', r2, money(0));
    el('span', 'bud-max', r2, '/ ' + money(CFG.budget));
    this.deltaBox = el('span', 'bud-deltas', r2);
    const bar = el('div', 'bud-bar', bud);
    this.budFill = el('div', 'bud-fill', bar);
    // 悬停明细
    const pop = el('div', 'panel bud-pop', bud);
    el('div', 'pop-title', pop, '造价明细');
    this.popRows = {};
    for (const [k, name] of BREAKDOWN_ROWS) {
      const row = el('div', 'pop-row', pop);
      html('span', 'pop-sw', row, SWATCH[k]);
      el('span', 'pop-name', row, name);
      const meter = el('span', 'pop-meter', row);
      const fill = el('span', 'pop-meter-fill', meter);
      const val = el('span', 'pop-val', row, money(0));
      this.popRows[k] = { val, fill };
    }
    const tot = el('div', 'pop-row pop-total', pop);
    el('span', 'pop-name', tot, '合计');
    this.popTotal = el('span', 'pop-val', tot, money(0));

    // 首次提示条
    let hintSeen = false;
    try { hintSeen = localStorage.getItem(HINT_KEY) === '1'; } catch { /* 无痕模式等 */ }
    this.hint = el('div', 'panel hint pe' + (hintSeen ? ' gone' : ''), L);
    el('span', 'hint-dot', this.hint);
    el('span', 'hint-text', this.hint, '从锚点或已有节点拖出杆件，托住核心、架好火炮，然后开战。');
    const hx = this._button(this.hint, 'icon-btn sm hint-x', () => {
      this.hint.classList.add('gone');
      try { localStorage.setItem(HINT_KEY, '1'); } catch { /* 忽略 */ }
    }, '不再提示');
    hx.innerHTML = ICON.close;

    // 下中：工具栏
    const tb = el('div', 'panel toolbar pe', L);
    this.toolbar = tb;
    this.toolBtns = {};
    const toolBtn = (id, iconHtml, name, price, key) => {
      const b = this._button(tb, 'tool', () => this._call('tool', id), `${name}${price ? ' ' + price : ''}（${key}）`);
      b.dataset.tool = id;
      const top = el('span', 'tool-top', b);
      html('span', 'tool-ic', top, iconHtml);
      keycap(top, key);
      el('span', 'nm', b, name);
      if (price) el('span', 'pr', b, price);
      this.toolBtns[id] = b;
      return b;
    };
    for (const m of MATERIAL_ORDER) {
      const mat = MATERIALS[m];
      toolBtn(m, SWATCH[m], mat.name, `$${mat.cost}/m`, String(MATERIAL_ORDER.indexOf(m) + 1));
    }
    const cb = toolBtn('cannon', ICON.cannon, '火炮', money(CANNON.cost), '5');
    this.cannonCount = el('span', 'cnt', cb, `0/${CFG.maxCannons}`);
    el('span', 'tb-div', tb);
    toolBtn('move', ICON.move, '移动', '', 'V');
    toolBtn('erase', ICON.erase, '拆除', '', 'X');
    el('span', 'tb-div', tb);
    const cmd = (cls, iconHtml, name, fn, keyHint) => {
      const b = this._button(tb, 'cmd ' + cls, fn, keyHint ? `${name}（${keyHint}）` : name);
      html('span', 'cmd-ic', b, iconHtml);
      return { b, nm: el('span', 'nm', b, name) };
    };
    this.undoBtn = cmd('undo', ICON.undo, '撤销', () => this._call('undo'), 'Ctrl/Cmd+Z').b;
    this.redoBtn = cmd('redo', ICON.redo, '重做', () => this._call('redo'), 'Ctrl/Cmd+Shift+Z').b;
    this.undoBtn.disabled = true; this.redoBtn.disabled = true;
    // 破坏性操作：第一次点击「上膛」，2 秒内再点才执行
    const danger = (cls, iconHtml, name, actName) => {
      const b = this._button(tb, 'cmd danger ' + cls, () => this._armClick(b, actName), name);
      html('span', 'cmd-ic', b, iconHtml);
      const stack = el('span', 'nm stack', b);
      el('span', 'st-a', stack, name);
      el('span', 'st-b', stack, '再点一次确认');
      el('span', 'arm-tip', b, '再点一次确认');
      return b;
    };
    danger('clear', ICON.trash, '清空', 'clear');
    danger('starter', ICON.truss, '示例', 'starter');

    // 右下：开战
    this.goBtn = this._button(L, 'go pe', () => this._call('start'), '开战（Enter）');
    html('span', 'go-ic', this.goBtn, ICON.play);
    el('span', 'go-text', this.goBtn, '开战');
    keycap(this.goBtn, 'Enter', 'kc-go');
    el('span', 'go-tip', this.goBtn, '超出预算');
  }

  _armClick(b, actName) {
    const t = this._armed.get(b);
    if (t) {
      clearTimeout(t);
      this._armed.delete(b);
      b.classList.remove('armed');
      this._call(actName);
      return;
    }
    b.classList.add('armed');
    this._armed.set(b, setTimeout(() => { this._armed.delete(b); b.classList.remove('armed'); }, ARM_MS));
  }
  _disarmAll() {
    for (const [b, t] of this._armed) { clearTimeout(t); b.classList.remove('armed'); }
    this._armed.clear();
  }

  // ============================================================ 构建：实景模式
  _buildBattle() {
    const L = this.bt;

    // 左上：返回蓝图
    const back = this._button(L, 'panel back pe', () => this._call('back'), '返回蓝图（Esc）');
    html('span', 'back-ic', back, ICON.back);
    el('span', 'back-text', back, '返回蓝图');
    keycap(back, 'Esc');

    // 上中：对决条
    const duel = el('div', 'panel duel pe', L);
    this.sides = [0, 1].map((s) => {
      const side = el('div', 'duel-side ' + (s === 0 ? 'ds-player' : 'ds-enemy'), duel);
      const head = el('div', 'ds-head', side);
      el('span', 'ds-name', head, s === 0 ? '我方' : '敌方');
      const hp = el('span', 'ds-hp', head, '');
      const bar = el('div', 'ds-bar', side);
      const ghost = el('div', 'ds-ghost', bar);
      const fill = el('div', 'ds-fill', bar);
      el('div', 'ds-flash', bar);
      const pips = el('div', 'ds-pips', side);
      return { side, hp, bar, ghost, fill, pips };
    });
    const mid = el('div', 'duel-mid', duel);
    // DOM 顺序：我方 / 中间 / 敌方
    duel.insertBefore(mid, this.sides[1].side);
    this.timerEl = el('div', 'timer', mid, clock(CFG.battleTime));

    // 开火横幅
    this.banner = el('div', 'banner', L, '开火');

    // 下中：控制条
    const pill = el('div', 'panel ctrl pe', L);
    this.pauseBtn = this._button(pill, 'icon-btn pause', () => this._call('pause'), '暂停 / 继续（Space）');
    this.pauseIc = html('span', 'pause-ic', this.pauseBtn, ICON.pause);
    keycap(pill, 'Space', 'kc-inline');
    el('span', 'ctrl-div', pill);
    this.speedBtns = new Map();
    for (const s of SPEEDS) {
      const b = this._button(pill, 'speed', () => this._call('speed', s), `${s}x 速度`);
      b.textContent = `${s}x`;
      this.speedBtns.set(s, b);
    }
    el('span', 'ctrl-div', pill);
    this.stressBtn = this._button(pill, 'toggle stress', () => this._call('stress'), '受力显示（T）');
    const grad = el('span', 'stress-grad', this.stressBtn);
    grad.style.background = this._stressGradient();
    el('span', 'tg-text', this.stressBtn, '受力显示');
    keycap(this.stressBtn, 'T');
    this.replayBtn = this._button(pill, 'toggle replay', () => this._call('replay'), '重播（R）');
    html('span', 'rp-ic', this.replayBtn, ICON.replay);
    el('span', 'tg-text', this.replayBtn, '重播');
    keycap(this.replayBtn, 'R');

    // 结算卡
    this.result = el('div', 'result', L);
    const card = el('div', 'panel result-card pe', this.result);
    el('div', 'rs-eyebrow', card, '战斗结束');
    this.rsTitle = el('div', 'rs-title', card, '');
    this.rsReason = el('div', 'rs-reason', card, '');
    const table = el('div', 'rs-table', card);
    const hrow = el('div', 'rs-row rs-head', table);
    el('span', 'rs-k', hrow, '');
    el('span', 'rs-v rs-p', hrow, '我方');
    el('span', 'rs-v rs-e', hrow, '敌方');
    this.rsCells = {};
    for (const [k, name] of [['shots', '开火'], ['hits', '命中'], ['beamsLost', '损失杆件'], ['cannonsLost', '损失火炮'], ['core', '核心剩余']]) {
      const row = el('div', 'rs-row', table);
      el('span', 'rs-k', row, name);
      this.rsCells[k] = [el('span', 'rs-v', row, ''), el('span', 'rs-v', row, '')];
    }
    const trow = el('div', 'rs-row rs-time', table);
    el('span', 'rs-k', trow, '用时');
    this.rsTime = el('span', 'rs-v rs-span', trow, '');
    const btns = el('div', 'rs-btns', card);
    const b1 = this._button(btns, 'rs-primary', () => this._call('back'), '返回蓝图修改（Esc）');
    html('span', 'back-ic', b1, ICON.back);
    el('span', '', b1, '返回蓝图修改');
    keycap(b1, 'Esc', 'kc-go');
    const b2 = this._button(btns, 'rs-second', () => this._call('replay'), '重播（R）');
    html('span', 'rp-ic', b2, ICON.replay);
    el('span', '', b2, '重播');
    keycap(b2, 'R');
  }

  _stressGradient() {
    const c = [0, 0, 0];
    const stops = THEME.stress.map(([s]) => {
      stressRGB(s, c);
      return `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)}) ${Math.round(s * 100)}%`;
    });
    return `linear-gradient(90deg, ${stops.join(', ')})`;
  }

  // ============================================================ 构建：右上（两种模式共用）
  _buildShared() {
    const L = this.shared;
    const box = el('div', 'topright pe', L);
    // 全景 / 特写
    this.focusBtn = this._button(box, 'panel seg', () => this._call('focus'), '全景 / 特写（F）');
    this.focusOpts = { field: el('span', 'seg-opt on', this.focusBtn, '全景'), build: el('span', 'seg-opt', this.focusBtn, '特写') };
    keycap(this.focusBtn, 'F');
    // 声音
    this.muteBtn = this._button(box, 'panel icon-btn mute', () => this._call('mute'), '声音（M）');
    this.muteIc = html('span', 'mute-ic', this.muteBtn, ICON.sound);
    keycap(this.muteBtn, 'M');
    // 帮助（只在蓝图模式）
    this.helpBtn = this._button(box, 'panel icon-btn help bp-only', () => this._toggleHelp(), '操作说明（?）');
    html('span', 'help-ic', this.helpBtn, ICON.help);
    keycap(this.helpBtn, '?');
    this.helpCard = el('div', 'panel help-card pe', L);
    el('div', 'help-title', this.helpCard, '操作说明');
    const ul = el('ul', 'help-list', this.helpCard);
    for (const line of HELP_LINES) el('li', '', ul, line);
    const keys = el('div', 'help-keys', this.helpCard);
    for (const [k, t] of [['1-5', '选材料 / 火炮'], ['V', '移动'], ['X', '拆除'], ['F', '全景 / 特写'], ['Enter', '开战']]) {
      const r = el('span', 'hk', keys);
      keycap(r, k);
      el('span', '', r, t);
    }
  }

  /** 工具栏若会碰到开战按钮，就切到紧凑样式（与窄屏规则相同） */
  _fit() {
    const tb = this.toolbar, go = this.goBtn;
    if (!tb.getBoundingClientRect || this.mode !== 'blueprint') return;
    this.root.classList.remove('compact');
    const a = tb.getBoundingClientRect(), b = go.getBoundingClientRect();
    if (!a.width) return;
    if (a.right > b.left - 12 || a.left < 12) this.root.classList.add('compact');
  }

  _toggleHelp(force) {
    const open = force == null ? !this._helpOpen : !!force;
    this._helpOpen = open;
    this.helpCard.classList.toggle('on', open);
    this.helpBtn.classList.toggle('active', open);
    this.helpBtn.setAttribute('aria-pressed', open ? 'true' : 'false');
  }

  // ============================================================ 公共接口
  setMode(mode) {
    if (mode !== 'blueprint' && mode !== 'battle') return;
    this.mode = mode;
    const bp = mode === 'blueprint';
    this.bp.classList.toggle('on', bp);
    this.bt.classList.toggle('on', !bp);
    this.root.classList.toggle('mode-blueprint', bp);
    this.root.classList.toggle('mode-battle', !bp);
    this._toggleHelp(false);
    this._disarmAll();
    if (bp) { this.hideResult(); raf(() => this._fit()); }
    else { this._sim = null; this.banner.classList.remove('show'); }
  }

  setTool(tool) {
    this.tool = tool;
    for (const id in this.toolBtns) {
      const on = id === tool;
      this.toolBtns[id].classList.toggle('sel', on);
      this.toolBtns[id].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  setBudget({ cost = 0, budget = CFG.budget, breakdown = null, delta = 0, silent = false } = {}) {
    this._budget = budget;
    const instant = silent || this._reduced || !this._budgetInit;
    this._budgetInit = true;
    this._target = cost;
    if (instant) {
      this._roll = null;
      this._shown = cost;
      this._renderSpent();
    } else if (this._shown !== cost) {
      this._roll = { from: this._shown, to: cost, t0: now() };
      this._tickRoll();
    } else {
      this._roll = null; // 目标又回到当前显示值：取消还在滚向旧目标的动画
    }
    if (!silent && delta) this._deltaChip(delta);

    // 进度条与状态
    const r = budget > 0 ? cost / budget : 0;
    const state = r > 1 ? 'bad' : r >= 0.8 ? 'warn' : 'ok';
    if (state !== this._budState) {
      this.budgetEl.classList.remove('st-ok', 'st-warn', 'st-bad');
      this.budgetEl.classList.add('st-' + state);
      this._budState = state;
    }
    this.budFill.style.transform = `scaleX(${Math.min(1, Math.max(0, r)).toFixed(4)})`;
    this.budStatus.textContent = r > 1 ? `超支 ${money(cost - budget)}` : `剩余 ${money(budget - cost)}`;
    this.goBtn.classList.toggle('over', cost > budget);
    this.goBtn.setAttribute('aria-label', cost > budget ? '开战（超出预算）' : '开战（Enter）');

    // 明细
    if (breakdown) {
      let tot = 0;
      for (const [k] of BREAKDOWN_ROWS) tot += breakdown[k] || 0;
      for (const [k] of BREAKDOWN_ROWS) {
        const v = breakdown[k] || 0;
        const row = this.popRows[k];
        row.val.textContent = k === 'cannon' && v > 0 ? `${Math.round(v / CANNON.cost)} 门 · ${money(v)}` : money(v);
        row.fill.style.transform = `scaleX(${tot > 0 ? (v / tot).toFixed(4) : 0})`;
      }
      this.popTotal.textContent = money(tot);
      const n = Math.round((breakdown.cannon || 0) / CANNON.cost);
      this.cannonCount.textContent = `${n}/${CFG.maxCannons}`;
      this.cannonCount.classList.toggle('full', n >= CFG.maxCannons);
      this.cannonCount.classList.toggle('zero', n === 0);
    }
  }

  _tickRoll() {
    if (this._rollPending) return;
    this._rollPending = true;
    raf(() => {
      this._rollPending = false;
      const R = this._roll;
      if (!R) return;
      const t = Math.min(1, (now() - R.t0) / ROLL_MS);
      this._shown = t >= 1 ? R.to : R.from + (R.to - R.from) * easeOut(t);
      this._renderSpent();
      if (t < 1) this._tickRoll(); else this._roll = null;
    });
  }
  _renderSpent() {
    const txt = money(this._shown);
    if (txt !== this._spentTxt) { this._spentTxt = txt; this.budSpent.textContent = txt; }
  }
  _deltaChip(d) {
    const c = el('span', 'delta ' + (d > 0 ? 'spend' : 'refund'), this.deltaBox, (d > 0 ? '+' : '-') + money(d));
    // 同时最多留 3 个
    while (this.deltaBox.children.length > 3) this.deltaBox.removeChild(this.deltaBox.children[0]);
    setTimeout(() => { if (c.parentNode) c.parentNode.removeChild(c); }, DELTA_MS + 40);
  }

  setUndoState({ canUndo, canRedo } = {}) {
    this.undoBtn.disabled = !canUndo;
    this.redoBtn.disabled = !canRedo;
  }

  setReport(summary) {
    if (!summary) { this.reportChip.classList.remove('on'); return; }
    const n = summary.count | 0;
    this.reportText.textContent = n > 0 ? `上一战损毁 ${n} 根` : '上一战无杆件损毁';
    this.reportChip.classList.add('on');
  }

  toast(text, kind = 'info') {
    const t = el('div', 'panel toast ' + (kind === 'error' ? 'err' : 'info'), this.toastBox);
    el('span', 'toast-dot', t);
    el('span', 'toast-text', t, String(text));
    const rec = { el: t, timer: 0 };
    const kill = () => {
      clearTimeout(rec.timer);
      const i = this._toasts.indexOf(rec);
      if (i >= 0) this._toasts.splice(i, 1);
      t.classList.add('out');
      setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, 160);
    };
    rec.kill = kill;
    rec.timer = setTimeout(kill, TOAST_MS);
    this._toasts.push(rec);
    while (this._toasts.length > 3) this._toasts[0].kill();
  }

  setFocus(focus) {
    this.focusOpts.field.classList.toggle('on', focus !== 'build');
    this.focusOpts.build.classList.toggle('on', focus === 'build');
  }

  setSpeed(speed, paused) {
    for (const [s, b] of this.speedBtns) b.classList.toggle('sel', s === speed && !paused);
    this.pauseBtn.classList.toggle('active', !!paused);
    this.pauseIc.innerHTML = paused ? ICON.play : ICON.pause;
    this.pauseBtn.setAttribute('aria-label', paused ? '继续（Space）' : '暂停（Space）');
  }

  setMuted(muted) {
    this.muteIc.innerHTML = muted ? ICON.mute : ICON.sound;
    this.muteBtn.classList.toggle('active', !!muted);
    this.muteBtn.setAttribute('aria-label', muted ? '声音已关（M）' : '声音（M）');
  }

  setStress(on) {
    this.stressBtn.classList.toggle('on', !!on);
    this.stressBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  // ------------------------------------------------------------ 对战：每帧
  setBattle(sim) {
    if (!sim) return;
    if (sim !== this._sim) this._bindSim(sim);
    const B = this._bt;

    // 核心血条
    for (let s = 0; s < 2; s++) {
      const core = sim.cores[s];
      if (!core) continue;
      const hp = Math.max(0, core.alive === false || core.sunk ? 0 : core.hp);
      const r = core.hpMax > 0 ? hp / core.hpMax : 0;
      const key = Math.round(r * 1000);
      if (key !== B.hpKey[s]) {
        B.hpKey[s] = key;
        const S = this.sides[s];
        const sc = `scaleX(${(key / 1000).toFixed(3)})`;
        S.fill.style.transform = sc;
        S.ghost.style.transform = sc;
        S.side.classList.toggle('low', r < 0.3);
      }
      const hpTxt = String(Math.ceil(hp));
      if (hpTxt !== B.hpTxt[s]) { B.hpTxt[s] = hpTxt; this.sides[s].hp.textContent = hpTxt; }
    }

    // 火炮指示点
    const cs = sim.cannons;
    for (let s = 0; s < 2; s++) {
      for (const p of this._pips[s]) {
        const c = cs[p.idx];
        const alive = !!(c && c.alive);
        if (alive !== p.alive) { p.alive = alive; p.el.classList.toggle('dead', !alive); }
      }
    }

    // 计时
    if (sim.phase !== 'ended') {
      let txt, cls;
      if (sim.phase === 'settle') { txt = '结构沉降中'; cls = 'settle'; }
      else {
        const left = sim.timeLeft;
        txt = clock(left);
        cls = left < 10 ? 'low' : '';
      }
      if (txt !== B.timer) { B.timer = txt; this.timerEl.textContent = txt; }
      if (cls !== B.timerCls) {
        this.timerEl.classList.remove('settle', 'low');
        if (cls) this.timerEl.classList.add(cls);
        B.timerCls = cls;
      }
    } else if (B.timerCls !== 'ended') {
      this.timerEl.classList.remove('settle', 'low');
      this.timerEl.classList.add('ended');
      B.timerCls = 'ended';
      const txt = clock(sim.timeLeft);  // 结束瞬间把读数对齐到真实剩余时间（超时结束应显示 0:00）
      if (txt !== B.timer) { B.timer = txt; this.timerEl.textContent = txt; }
    }
  }

  _bindSim(sim) {
    this._sim = sim;
    this._bt = { hpKey: [-1, -1], hpTxt: ['', ''], timer: '', timerCls: null };
    this.timerEl.classList.remove('settle', 'low', 'ended');
    for (let s = 0; s < 2; s++) {
      const S = this.sides[s];
      S.side.classList.remove('hit', 'low');
      S.pips.textContent = '';
      this._pips[s] = [];
      for (const c of sim.cannons) {
        if (c.side !== s) continue;
        const p = el('span', 'pip', S.pips);
        this._pips[s].push({ el: p, idx: c.idx, alive: true });
      }
      if (!this._pips[s].length) el('span', 'pip-none', S.pips, '无火炮');
    }
  }

  onEvent(e, sim) {
    if (!e) return;
    switch (e.type) {
      case 'fightStart':
        retrigger(this.banner, 'show');
        break;
      case 'coreHit': {
        const S = this.sides[e.side];
        if (!S) break;
        retrigger(S.side, 'hit');
        break;
      }
      case 'cannonLost': {
        if (sim && sim !== this._sim) this._bindSim(sim);
        const list = this._pips[e.side] || [];
        const p = list.find((q) => q.idx === e.cannon);
        if (p) { p.alive = false; p.el.classList.add('dead'); retrigger(p.el, 'lost'); }
        break;
      }
      default: break;
    }
  }

  showResult({ winner, reason, time = 0, stats = null, playerHp = 0, enemyHp = 0, hpMax = 0 } = {}) {
    const title = winner === 'player' ? '胜利' : winner === 'enemy' ? '失败' : '平局';
    this.rsTitle.textContent = title;
    this.rsTitle.className = 'rs-title ' + (winner === 'player' ? 'win' : winner === 'enemy' ? 'lose' : 'draw');
    this.rsReason.textContent = reasonText(winner, reason);
    const st = stats || [{}, {}];
    for (const k of ['shots', 'hits', 'beamsLost', 'cannonsLost']) {
      for (let s = 0; s < 2; s++) this.rsCells[k][s].textContent = String((st[s] && st[s][k]) || 0);
    }
    const hm = Math.round(hpMax);
    this.rsCells.core[0].textContent = `${Math.ceil(Math.max(0, playerHp))} / ${hm}`;
    this.rsCells.core[1].textContent = `${Math.ceil(Math.max(0, enemyHp))} / ${hm}`;
    this.rsTime.textContent = clock(time);
    this.result.classList.add('on');
  }

  hideResult() { this.result.classList.remove('on'); }
}

function reasonText(winner, reason) {
  const both = winner !== 'player' && winner !== 'enemy';
  switch (reason) {
    // 平局时两个核心的失去方式可能不同（一毁一沉），所以用中性的说法
    case 'coreDestroyed': return both ? '双方核心同时失守' : winner === 'player' ? '敌方核心被击毁' : '我方核心被击毁';
    case 'coreSunk': return both ? '双方核心同时失守' : winner === 'player' ? '敌方核心坠入水中' : '我方核心坠入水中';
    case 'timeout': return '时间到，按核心剩余耐久判定';
    case 'stalemate': return '双方都已失去火力，按核心剩余耐久判定';
    default: return '';
  }
}
