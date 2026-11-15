// 桁垒 TRUSSFORT — 入口：状态机、主循环、模块接线。
//
// 状态：blueprint ⇄ (toBattle) ⇄ battle ⇄ (toBlueprint)
// blend：0 = 蓝图界面，1 = 实景。蓝图画布按 blend 淡出，3D 相机按 blend 从正视推成透视。
// 蓝图是唯一数据源：开战时由蓝图生成一份 Sim，退回蓝图时 Sim 被丢弃，蓝图原样保留。

import { CFG } from './config.js';
import { View, FIELD_BOUNDS, BUILD_BOUNDS } from './view.js';
import { Blueprint } from './sim/blueprint.js';
import { Sim } from './sim/sim.js';
import { makeEnemyFort, makeStarterFort, makeReferenceFort } from './sim/forts.js';
import { Editor } from './editor/editor.js';
import { World } from './render/world.js';
import { StructureView } from './render/structure.js';
import { Fx } from './render/fx.js';
import { GameAudio } from './audio/audio.js';
import { Hud } from './ui/hud.js';
import { rules, loadFort, exportFort, formatFort } from './ai/api.js';

const SAVE_KEY = 'trussfort.blueprint.v1';
const TIP_KEY = 'trussfort.tip.v1';
const T_IN = 1.5;    // 蓝图 → 实景 过渡时长（秒），略短于物理沉降阶段
const T_OUT = 0.7;   // 实景 → 蓝图
const RESULT_DELAY = 1.6; // 分出胜负后多久弹出结算（留给坍塌镜头）
const SPEEDS = [0.25, 1, 2, 4];
const TOOL_KEYS = { Digit1: 'wood', Digit2: 'steel', Digit3: 'rope', Digit4: 'spring', Digit5: 'cannon', KeyC: 'cannon', KeyV: 'move', KeyX: 'erase' };

// 取景时给界面留出的边距（像素），随窗口宽度变（和 style.css 的三档布局对应）
function padFor(mode, w) {
  if (w <= 700) return mode === 'battle' ? { l: 12, r: 12, t: 138, b: 78 } : { l: 12, r: 12, t: 196, b: 156 };
  if (w <= 980) return mode === 'battle' ? { l: 20, r: 20, t: 104, b: 76 } : { l: 20, r: 20, t: 112, b: 170 };
  return mode === 'battle' ? { l: 28, r: 28, t: 104, b: 36 } : { l: 28, r: 28, t: 92, b: 128 };
}

function smooth(t) { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }
// smooth 的反函数：给出 blend，求过渡进度（中途反向时用，保证画面不跳）
function unsmooth(y) { y = y < 0 ? 0 : y > 1 ? 1 : y; return 0.5 - Math.sin(Math.asin(1 - 2 * y) / 3); }

class Game {
  constructor() {
    this.glCanvas = document.getElementById('gl');
    this.bpCanvas = document.getElementById('bp');
    this.uiRoot = document.getElementById('ui');

    this.view = new View();
    this.player = this._loadSaved() || makeStarterFort();
    this.enemy = makeEnemyFort();

    this.state = 'blueprint';
    this.blend = 0;
    this.tr = 0;
    this.sim = null;
    this.acc = 0;
    this.speed = 1;
    this.paused = false;
    this.stressView = true;
    this.muted = false;
    this.focus = 'field';       // 'field' 全景 | 'build' 我方特写
    this.resultTimer = -1;
    this.report = null;         // 上一场的战损报告，交给编辑器标出薄弱点
    this._bpView = null;
    this._last = performance.now();

    this.audio = new GameAudio();
    this.hud = new Hud({
      root: this.uiRoot,
      actions: {
        tool: (t) => this.setTool(t),
        start: () => this.startBattle(),
        back: () => this.backToBlueprint(),
        replay: () => this.replay(),
        undo: () => this.editor.undo(),
        redo: () => this.editor.redo(),
        clear: () => { this.editor.clearAll(); this._clearReport(); },
        starter: () => this.loadExample(),
        speed: (s) => this.setSpeed(s),
        pause: () => this.togglePause(),
        mute: () => this.toggleMute(),
        stress: () => this.toggleStress(),
        focus: () => this.toggleFocus(),
        report: () => this._clearReport(),
      },
    });
    this.world = new World({ canvas: this.glCanvas, view: this.view });
    this.structure = new StructureView(this.world);
    this.fx = new Fx(this.world);
    this.editor = new Editor({
      canvas: this.bpCanvas,
      view: this.view,
      player: this.player,
      enemy: this.enemy,
      hud: this.hud,
      audio: this.audio,
      onChange: (info) => this.onBlueprintChanged(info),
    });

    this._bindInput();
    this._bindFortIO();
    this.resize();
    this.view.fit(FIELD_BOUNDS, padFor('blueprint', this.view.w));
    this.setTool('wood');
    this.hud.setMode('blueprint');
    this.onBlueprintChanged({ silent: true });
    this.structure.setStressView(this.stressView);
    this.hud.setStress(this.stressView);
    this.hud.setMuted(this.muted);
    this.hud.setFocus(this.focus);

    this._warmUp();

    requestAnimationFrame((t) => this.frame(t));
  }

  /**
   * 预热：把战斗里会出现的东西（结构、火炮、核心、炮弹、各种特效）都真的画一帧，
   * 让着色器在载入时编译完，而不是等到第一次开战、第一声炮响时卡一下。
   * 隐藏的物体不会被编译，所以这里要造一份临时模拟并喂一组假事件。
   */
  _warmUp() {
    try {
      const sim = new Sim(this.player, this.enemy, { seed: 1 });
      sim.shells.push({ id: 1, side: 0, cannon: 0, mount: 0, x: 12, y: 8, ox: 12, oy: 8, vx: 10, vy: 2, age: 0.2, alive: true });
      this.structure.build(sim);
      this.structure.setStressView(this.stressView);
      const W = CFG.fieldW, wy = CFG.waterY;
      const brk = (mat, cause) => ({ type: 'break', cause, side: 0, beam: 0, bpId: 0, mat, x1: 4, y1: 4, x2: 6, y2: 5, vx1: 0, vy1: 1, vx2: 1, vy2: 0 });
      const evs = [
        { type: 'fire', side: 0, cannon: 0, x: 2, y: 6, angle: 0.5 },
        ...['wood', 'steel', 'ground', 'core', 'cannon'].map((kind) => ({ type: 'explode', x: 6, y: 5, kind, side: 1, hitSide: 0, vx: -12, vy: -6 })),
        brk('wood', 'stress'), brk('steel', 'blast'), brk('rope', 'stress'), brk('spring', 'blast'),
        { type: 'splash', x: W / 2, y: wy, power: 0.9, side: 0 },
        { type: 'coreHit', side: 0, dmg: 50, hp: 300 },
        { type: 'coreDestroyed', side: 1, x: W - 4, y: 3 },
        { type: 'coreSunk', side: 1, x: W - 4, y: wy },
        { type: 'cannonLost', cause: 'destroyed', side: 0, cannon: 0, x: 2, y: 6, angle: 0.5, vx: 0, vy: 0 },
      ];
      for (const e of evs) this.fx.onEvent(e, sim);
      this.structure.sync(sim, 1);
      this.fx.update(1 / 60);
      this.world.setBlend(1); this.world.update(0, 0); this.world.render();
    } catch (err) {
      console.warn('预热失败（不影响游戏）', err);
    }
    this.fx.clear();
    this.structure.clear();
    this.world.setBlend(0);
  }

  // ------------------------------------------------------------ 存档
  _loadSaved() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const bp = Blueprint.fromJSON(JSON.parse(raw), 'player');
      // 存档损坏、或规则变了导致旧存档不合法时，直接丢弃
      return bp.validate() === null ? bp : null;
    } catch { return null; }
  }
  _save() {
    // 拖动节点 / 调射角时每帧都会触发，合并成一次写入
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = 0;
      try { localStorage.setItem(SAVE_KEY, JSON.stringify(this.player.toJSON())); } catch { /* 无痕模式等 */ }
    }, 250);
  }

  // ------------------------------------------------------------ 蓝图界面
  onBlueprintChanged(info = {}) {
    const cost = this.player.cost();
    this.hud.setBudget({ cost, budget: CFG.budget, breakdown: this.player.breakdown(), delta: info.delta || 0, silent: !!info.silent });
    this.hud.setUndoState({ canUndo: this.editor.canUndo, canRedo: this.editor.canRedo });
    this._save();
  }

  /** 「示例」按钮：在两座示例堡垒之间轮换（可撤销） */
  loadExample() {
    if (this.state !== 'blueprint') return;
    const examples = [
      { make: makeStarterFort, name: '起手堡垒' },
      { make: makeReferenceFort, name: '参考堡垒（预算内能打赢默认敌人的一种搭法）' },
    ];
    this._example = ((this._example || 0) + 1) % examples.length;
    const ex = examples[this._example];
    this.editor.loadBlueprint(ex.make());
    this._clearReport();   // 上一战的损毁标记属于被换掉的那座堡垒
    this.hud.toast(`已载入示例：${ex.name}`, 'info');
  }

  // ------------------------------------------------------------ 堡垒导入 / 导出（AI 对战、观战用，见 AI.md）
  /**
   * 载入一座堡垒描述。side: 'player'（左）或 'enemy'（右）。成功返回 true。
   * 描述格式见 src/ai/api.js 的 loadFort：坐标式、命名式或存档格式都行。
   */
  setFort(side, desc, label) {
    const enemy = side === 'enemy' || side === 'B' || side === 'right';
    const who = enemy ? '敌方' : '我方';
    if (this.state !== 'blueprint') { this.hud.toast('先返回蓝图，再载入堡垒', 'error'); return false; }
    let bp;
    try { bp = loadFort(desc, enemy ? 'enemy' : 'player'); } catch (e) {
      this.hud.toast(`${who}堡垒不合规则：${e && e.message ? e.message : e}`, 'error');
      this.audio.ui('error');
      return false;
    }
    this.editor.cancel();
    if (enemy) {
      this.enemy.load(bp);
      this.editor.invalidate();
    } else {
      this.editor.loadBlueprint(bp);
    }
    this._clearReport();
    const cost = bp.cost();
    const name = label || (desc && desc.name) || '';
    const over = cost > CFG.budget;
    this.hud.toast(`已载入${who}堡垒${name ? '「' + name + '」' : ''}：$${cost.toLocaleString()}${over ? '（超出预算）' : ''}`, over ? 'error' : 'info');
    return true;
  }
  resetEnemy() { return this.setFort('enemy', makeEnemyFort(), '默认敌人'); }

  _downloadFort() {
    try {
      const text = formatFort(exportFort(this.player, 'my-fort'));
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      link.download = 'fort.json';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(link.href), 2000);
      this.hud.toast('已导出我方堡垒：fort.json', 'info');
    } catch { this.hud.toast('导出失败', 'error'); }
  }

  _bindFortIO() {
    // 1) 把 JSON 文件拖进窗口：左半边 = 我方，右半边 = 敌方
    const veil = document.createElement('div');
    veil.className = 'drop-veil';
    veil.innerHTML = '<div class="drop-half"><b>我方</b><span>松手载入到左边</span></div><div class="drop-half"><b>敌方</b><span>松手载入到右边</span></div>';
    document.body.appendChild(veil);
    const halves = veil.children;
    let depth = 0;
    const isFile = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
    const mark = (e) => {
      const right = e.clientX > window.innerWidth / 2;
      halves[0].classList.toggle('on', !right);
      halves[1].classList.toggle('on', right);
    };
    window.addEventListener('dragenter', (e) => { if (!isFile(e)) return; e.preventDefault(); depth++; veil.classList.add('on'); mark(e); });
    window.addEventListener('dragover', (e) => { if (!isFile(e)) return; e.preventDefault(); mark(e); });
    window.addEventListener('dragleave', (e) => { if (!isFile(e)) return; depth = Math.max(0, depth - 1); if (!depth) veil.classList.remove('on'); });
    window.addEventListener('drop', (e) => {
      if (!isFile(e)) return;
      e.preventDefault();
      depth = 0; veil.classList.remove('on');
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      const side = e.clientX > window.innerWidth / 2 ? 'enemy' : 'player';
      f.text().then((t) => {
        let desc;
        try { desc = JSON.parse(t); } catch { this.hud.toast(`${f.name} 不是合法的 JSON`, 'error'); return; }
        this.setFort(side, desc, f.name.replace(/\.json$/i, ''));
      });
    });

    // 2) 控制台 / 外部脚本接口
    window.trussfort = {
      rules,
      loadFort: (side, desc) => this.setFort(side, desc),
      exportFort: (side) => exportFort(side === 'enemy' ? this.enemy : this.player),
      resetEnemy: () => this.resetEnemy(),
      start: () => this.startBattle(),
      back: () => this.backToBlueprint(),
      /** 当前这场的结果；还没打完时 winner 为 null */
      result: () => {
        const s = this.sim;
        if (!s) return null;
        const hp = (c) => (c.alive ? Math.max(0, c.hp) : 0);
        return { phase: s.phase, winner: s.winner, reason: s.endReason, fightSeconds: s.fightTime, coreHp: [hp(s.cores[0]), hp(s.cores[1])], stats: s.stats };
      },
    };

    // 3) 网址参数：?a=左边堡垒.json&b=右边堡垒.json&autostart=1（只在通过 http 打开时可用）
    const q = new URLSearchParams(location.search);
    const a = q.get('a'), b = q.get('b');
    if (a || b) {
      if (!/^https?:$/.test(location.protocol)) {
        this.hud.toast('双击打开时不能按网址读文件：直接把 JSON 文件拖进窗口', 'error');
      } else {
        const get = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(`${url}（${r.status}）`); return r.json(); });
        Promise.all([a ? get(a) : null, b ? get(b) : null]).then(([fa, fb]) => {
          let ok = true;
          if (fa) ok = this.setFort('player', fa) && ok;
          if (fb) ok = this.setFort('enemy', fb) && ok;
          if (ok && q.get('autostart')) setTimeout(() => this.startBattle(), 600);
        }).catch((e) => this.hud.toast(`读取堡垒失败：${e.message}`, 'error'));
      }
    }
  }

  _clearReport() {
    this.report = null;
    this.editor.setBattleReport(null);
    this.hud.setReport(null);
  }

  setTool(tool) {
    if (this.state !== 'blueprint') return;
    this.editor.setTool(tool);
    this.hud.setTool(tool);
  }

  toggleFocus() {
    this.focus = this.focus === 'field' ? 'build' : 'field';
    const pad = padFor(this.state === 'blueprint' ? 'blueprint' : 'battle', this.view.w);
    this.view.animateTo(this.view.fitTarget(this.focus === 'field' ? FIELD_BOUNDS : BUILD_BOUNDS, pad), 0.5);
    this.hud.setFocus(this.focus);
  }

  // ------------------------------------------------------------ 开战 / 返回
  /** @returns {boolean} 是否真的开战了 */
  startBattle(isReplay = false) {
    if (this.state !== 'blueprint') return false;
    this.editor.cancel();   // 先了结进行中的拖动，保证校验的和拿去模拟的是同一张蓝图
    const cost = this.player.cost();
    if (cost > CFG.budget) {
      this.hud.toast(`超出预算 $${(cost - CFG.budget).toLocaleString()}，先拆掉一些再开战`, 'error');
      this.audio.ui('error');
      return false;
    }
    this.audio.unlock();
    this.editor.setEnabled(false);
    this.sim = new Sim(this.player, this.enemy, { seed: CFG.seed ?? 20261115 });
    this.acc = 0;
    this.paused = false;
    this.resultTimer = -1;
    this._collect = { broken: new Map(), peak: new Map(), order: 0 };
    this.structure.build(this.sim);
    this.structure.setStressView(this.stressView);
    this.fx.clear();
    if (!isReplay) {
      // 记住蓝图里的取景，返回时还原；重播时镜头不动
      this._bpView = { cx: this.view.cx, cy: this.view.cy, ppm: this.view.ppm };
      this._bpFocus = this.focus;
      this.focus = 'field';            // 实景一律从全景开始，指示也跟着切到「全景」
      this.hud.setFocus('field');
      this.view.animateTo(this.view.fitTarget(FIELD_BOUNDS, padFor('battle', this.view.w)), T_IN);
    }
    this.state = 'toBattle';
    this.tr = 0;
    this.hud.hideResult();
    this.hud.setMode('battle');
    this.hud.setSpeed(this.speed, this.paused);
    this.audio.ui('start');
    return true;
  }

  backToBlueprint() {
    if (this.state !== 'battle' && this.state !== 'toBattle') return;
    this.report = this._makeReport();
    this.state = 'toBlueprint';
    this.tr = 1 - unsmooth(this.blend);   // 过渡中途返回时，从当前画面平滑反向
    this.hud.hideResult();
    this.hud.setMode('blueprint');
    this.editor.setBattleReport(this.report);
    this.hud.setReport(this.report && this.report.broken.size ? { count: this.report.broken.size } : null);
    // 回到进战斗前的取景；窗口在战斗中改过大小时那份取景已失效，按当前模式重新取景
    this.focus = this._bpFocus || 'field';
    this.hud.setFocus(this.focus);
    const back = this._bpView || this.view.fitTarget(this.focus === 'field' ? FIELD_BOUNDS : BUILD_BOUNDS, padFor('blueprint', this.view.w));
    this.view.animateTo(back, T_OUT);
    this.audio.ui('back');
    this.audio.stopBattle();
    // 第一次输了回来，提示一下标记的含义和示例的去处（只提示一次）
    if (this.report && this.report.winner === 'enemy' && this.report.broken.size) {
      let seen = false;
      try { seen = !!localStorage.getItem(TIP_KEY); localStorage.setItem(TIP_KEY, '1'); } catch { /* 忽略 */ }
      if (!seen) this.hud.toast('编号是杆件失守的先后，1 号最先。想看一种能赢的搭法，点「示例」', 'info');
    }
  }

  /** 同一张蓝图再打一遍（结果可复现，相当于回放） */
  replay() {
    if (this.state !== 'battle') return;
    this._teardownBattle();
    this.state = 'blueprint';
    if (this.startBattle(true)) {
      // 已经在实景里了，跳过镜头过渡
      this.state = 'battle'; this.blend = 1; this.tr = 1;
    } else {
      // 理论上不会发生（蓝图在战斗中改不了）；万一开不了战，老实退回蓝图
      this.blend = 0;
      this.hud.setMode('blueprint');
      this.editor.setEnabled(true);
    }
  }

  _teardownBattle() {
    this.sim = null;
    this.structure.clear();
    this.fx.clear();
    this.audio.stopBattle();
    this.resultTimer = -1;
  }

  _makeReport() {
    if (!this._collect) return null;
    return { broken: this._collect.broken, peak: this._collect.peak, winner: this.sim ? this.sim.winner : null };
  }

  setSpeed(s) {
    this.speed = s; this.paused = false;
    this.hud.setSpeed(this.speed, this.paused);
    this.audio.setRate(s);
  }
  togglePause() { this.paused = !this.paused; this.hud.setSpeed(this.speed, this.paused); }
  toggleMute() { this.muted = !this.muted; this.audio.setMuted(this.muted); this.hud.setMuted(this.muted); }
  toggleStress() { this.stressView = !this.stressView; this.structure.setStressView(this.stressView); this.hud.setStress(this.stressView); }

  // ------------------------------------------------------------ 事件分发
  _dispatch(sim) {
    const evs = sim.events;
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      this.structure.onEvent(e, sim);
      this.fx.onEvent(e, sim);
      this.audio.onEvent(e, sim);
      this.hud.onEvent(e, sim);
      if (e.type === 'break' && e.side === 0 && e.cause !== 'sunk' && !this._collect.broken.has(e.bpId)) {
        this._collect.broken.set(e.bpId, { order: ++this._collect.order, cause: e.cause, t: sim.time });
      } else if (e.type === 'end') {
        this.resultTimer = RESULT_DELAY;
      }
    }
    evs.length = 0;
  }

  _trackPeaks(sim) {
    const peak = this._collect.peak;
    const beams = sim.beams;
    for (let i = 0; i < beams.length; i++) {
      const b = beams[i];
      if (b.side !== 0 || !b.alive) continue;
      const p = peak.get(b.bpId) || 0;
      if (b.stressVis > p) peak.set(b.bpId, b.stressVis);
    }
  }

  // ------------------------------------------------------------ 主循环
  frame(now) {
    const dt = Math.min(0.05, Math.max(0, (now - this._last) / 1000));
    this._last = now;
    this.view.update(dt);

    if (this.state === 'toBattle') {
      this.tr += dt / T_IN;
      this.blend = smooth(this.tr);
      if (this.tr >= 1) { this.state = 'battle'; this.blend = 1; }
    } else if (this.state === 'toBlueprint') {
      this.tr += dt / T_OUT;
      this.blend = 1 - smooth(this.tr);
      if (this.tr >= 1) {
        this.state = 'blueprint'; this.blend = 0;
        this._teardownBattle();
        this.editor.setEnabled(true);
      }
    }

    const sim = this.sim;
    if (sim) {
      const speed = this.paused ? 0 : this.speed;
      // 结束后再跑一段让残骸落定，然后停掉物理省电
      const frozen = sim.phase === 'ended' && sim.time - sim.endTime > 14;
      if (!frozen && this.state !== 'toBlueprint') {
        this.acc += dt * speed;
        let steps = 0;
        while (this.acc >= CFG.dt && steps < 10) {
          sim.step();
          this._dispatch(sim);
          this.acc -= CFG.dt;
          steps++;
        }
        if (steps === 10) this.acc = 0;
        this._trackPeaks(sim);
      }
      this.structure.sync(sim, frozen ? 1 : Math.min(1, this.acc / CFG.dt));
      this.fx.update(dt * (this.state === 'toBlueprint' ? 1 : speed));
      this.hud.setBattle(sim);
      if (this.resultTimer > 0) {
        this.resultTimer -= dt * Math.max(1, speed);
        if (this.resultTimer <= 0) {
          if (this.state === 'battle') {
            this.resultTimer = -1;
            // 落水的核心耐久没清零，但它已经没了：结算里按 0 显示，和对决条一致
            const hp = (c) => (c.alive ? Math.max(0, c.hp) : 0);
            this.hud.showResult({
              winner: sim.winner, reason: sim.endReason, time: sim.fightTime,
              stats: sim.stats, playerHp: hp(sim.cores[0]), enemyHp: hp(sim.cores[1]), hpMax: sim.cores[0].hpMax,
            });
            this.audio.ui(sim.winner === 'player' ? 'win' : sim.winner === 'enemy' ? 'lose' : 'draw');
          } else {
            this.resultTimer = 1e-6;   // 镜头过渡还没结束就分出了胜负：等进入实景再弹结算
          }
        }
      }
    }

    // 画面
    this.world.setBlend(this.blend);
    if (this.blend > 0.001) {            // 蓝图完全盖住实景时，水面和旗子不必白算
      this.world.update(dt, now / 1000);
      this.world.render();
    }
    const bpAlpha = 1 - smooth((this.blend - 0.08) / 0.6);
    this.bpCanvas.style.opacity = bpAlpha.toFixed(3);
    this.bpCanvas.style.visibility = bpAlpha > 0.001 ? 'visible' : 'hidden';
    if (bpAlpha > 0.001) this.editor.draw(dt);

    requestAnimationFrame((t) => this.frame(t));
  }

  // ------------------------------------------------------------ 输入
  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.view.resize(w, h);
    this.world.resize(w, h, dpr);
    this.editor.resize(w, h, dpr);
    // 窗口尺寸变了就按当前取景模式重新取景
    if (this._sized) {
      const battle = this.state === 'battle' || this.state === 'toBattle';
      const b = battle || this.focus === 'field' ? FIELD_BOUNDS : BUILD_BOUNDS;
      this.view.fit(b, padFor(battle ? 'battle' : 'blueprint', w));
      if (battle) this._bpView = null;
    }
    this._sized = true;
  }

  _bindInput() {
    window.addEventListener('resize', () => this.resize());

    // 实景里的平移 / 缩放（蓝图里的由编辑器自己处理）
    const gl = this.glCanvas;
    let drag = null;
    gl.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; gl.setPointerCapture(e.pointerId); });
    gl.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.view.panBy(e.clientX - drag.x, e.clientY - drag.y);
      drag.x = e.clientX; drag.y = e.clientY;
    });
    const end = () => { drag = null; };
    gl.addEventListener('pointerup', end); gl.addEventListener('pointercancel', end);
    gl.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.view.zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
      // 按住不放产生的重复键只对「调速」和「撤销 / 重做」有意义，其余一律只认第一下
      const repeatOk = e.code === 'BracketLeft' || e.code === 'BracketRight' || e.code === 'KeyZ' || e.code === 'KeyY';
      if (e.repeat && !repeatOk) return;
      const mod = e.metaKey || e.ctrlKey;
      if (this.state === 'blueprint') {
        if (mod && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) this.editor.redo(); else this.editor.undo(); return; }
        if (mod && e.code === 'KeyY') { e.preventDefault(); this.editor.redo(); return; }
        if (mod && e.code === 'KeyS') { e.preventDefault(); this._downloadFort(); return; }
        if (mod) return;
        if (TOOL_KEYS[e.code]) { this.setTool(TOOL_KEYS[e.code]); return; }
        if (e.code === 'Enter') { e.preventDefault(); this.startBattle(); return; }
        if (e.code === 'Escape') { this.editor.cancel(); return; }
        if (e.code === 'Delete' || e.code === 'Backspace') { e.preventDefault(); this.editor.deleteHovered(); return; }
      } else if (this.state === 'battle' || this.state === 'toBattle') {
        if (mod) return;
        if (e.code === 'Escape' || e.code === 'Backspace') { e.preventDefault(); this.backToBlueprint(); return; }
        if (e.code === 'Space') { e.preventDefault(); this.togglePause(); return; }
        if (e.code === 'KeyR') { this.replay(); return; }
        if (e.code === 'KeyT') { this.toggleStress(); return; }
        if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
          const i = SPEEDS.indexOf(this.speed);
          const j = Math.min(SPEEDS.length - 1, Math.max(0, (i < 0 ? 1 : i) + (e.code === 'BracketRight' ? 1 : -1)));
          this.setSpeed(SPEEDS[j]);
          return;
        }
      }
      if (mod) return;
      if (e.code === 'KeyF') this.toggleFocus();
      else if (e.code === 'KeyM') this.toggleMute();
    });

    // 浏览器要求用户手势后才能出声
    const unlock = () => { this.audio.unlock(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
    window.addEventListener('pointerdown', unlock); window.addEventListener('keydown', unlock);
  }
}

window.addEventListener('DOMContentLoaded', () => { window.game = new Game(); });
