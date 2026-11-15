// 桁垒 TRUSSFORT 音效：全部用 Web Audio API 现场合成，没有音频文件。
// 结构：每个声音是一个 voice（若干源 -> 包络 -> voice.out -> 声像 -> 总线），
// 总线 ui / battle -> 压缩器 -> 主增益 -> 输出。
// 只读 sim 状态（取坐标做声像），从不写入。
import { CFG } from '../config.js';

const MAX_VOICES = 14;
const MASTER_GAIN = 0.5;
const UI_BUS_GAIN = 0.6;
const SILENT = 0.0001;

// 每类声音的最小间隔（秒，真实时间）
const GAP = {
  tick: 0.04, snap: 0.03, place: 0.05, cannon: 0.08, aim: 0.03, delete: 0.05, error: 0.2, undo: 0.06,
  start: 0.5, back: 0.4, win: 1, lose: 1, draw: 1,
  fire: 0.035, explode: 0.05, break: 0.035, blast: 0.04, splash: 0.07, coreHit: 0.08,
  coreDestroyed: 0.5, coreSunk: 0.5, cannonLost: 0.08, fightStart: 0.5,
};

// 优先级：满载时先挤掉低优先级的旧声音
const PRIO = {
  snap: 0, aim: 0, tick: 1, splash: 1, blast: 1, break: 2, place: 2, undo: 2, delete: 2,
  fire: 3, explode: 3, cannon: 3, cannonLost: 3, coreHit: 4, error: 4,
  start: 5, back: 5, fightStart: 5, win: 6, lose: 6, draw: 6, coreSunk: 6, coreDestroyed: 7,
};

function getAC() {
  try {
    const g = typeof globalThis !== 'undefined' ? globalThis : {};
    return g.AudioContext || g.webkitAudioContext || null;
  } catch (_) { return null; }
}

function setP(param, v) { if (param && typeof param === 'object' && 'value' in param) param.value = v; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function rnd(a, b) { return a + Math.random() * (b - a); }
function fin(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }

// 打击包络：attack 线性升到 peak，再指数衰减到无声
function envPerc(p, t0, a, peak, d) {
  a = Math.max(0.0005, a);
  d = Math.max(a + 0.004, d);
  p.setValueAtTime(SILENT, t0);
  p.linearRampToValueAtTime(Math.max(SILENT * 2, peak), t0 + a);
  p.exponentialRampToValueAtTime(SILENT, t0 + d);
}

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.ok = !!getAC();
    this.muted = false;
    this.rate = 1;
    this.fMul = 1;      // 战斗声频率倍率
    this.tMul = 1;      // 战斗声时长倍率
    this.bGain = 1;     // 战斗总线增益
    this.voices = [];   // 计入上限的活动 voice
    this.dying = [];    // 正在淡出、等待回收的 voice
    this.last = Object.create(null);
    this.noise = null;  // 白噪声
    this.brown = null;  // 褐噪声（低沉）
  }

  // ------------------------------------------------------------ 生命周期
  unlock() {
    try {
      if (!this.ok) return;
      if (!this.ctx) {
        const AC = getAC();
        if (!AC) { this.ok = false; return; }
        this.ctx = new AC();
        this._buildGraph();
      }
      if (this.ctx.state === 'suspended' && typeof this.ctx.resume === 'function') {
        const p = this.ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    } catch (_) {
      this.ctx = null; this.ok = false;
    }
  }

  _buildGraph() {
    const c = this.ctx;
    const comp = c.createDynamicsCompressor();
    setP(comp.threshold, -16); setP(comp.knee, 10); setP(comp.ratio, 5);
    setP(comp.attack, 0.003); setP(comp.release, 0.22);
    const master = c.createGain();
    master.gain.value = this.muted ? 0 : MASTER_GAIN;
    comp.connect(master); master.connect(c.destination);
    const ui = c.createGain(); ui.gain.value = UI_BUS_GAIN; ui.connect(comp);
    const battle = c.createGain(); battle.gain.value = this.bGain; battle.connect(comp);
    this.comp = comp; this.master = master; this.uiBus = ui; this.battleBus = battle;
    this.hasPanner = typeof c.createStereoPanner === 'function';

    const sr = c.sampleRate || 44100;
    const len = Math.floor(sr * 2);
    this.noise = c.createBuffer(1, len, sr);
    this.brown = c.createBuffer(1, len, sr);
    const w = this.noise.getChannelData(0), b = this.brown.getChannelData(0);
    let acc = 0;
    for (let i = 0; i < len; i++) {
      const r = Math.random() * 2 - 1;
      w[i] = r;
      acc = (acc + 0.02 * r) / 1.02;
      b[i] = acc * 3.5;
    }
  }

  setMuted(m) {
    this.muted = !!m;
    const c = this.ctx;
    if (!c || !this.master) return;
    try {
      const g = this.master.gain, now = c.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.setTargetAtTime(this.muted ? 0 : MASTER_GAIN, now, 0.03);
    } catch (_) {}
  }

  setRate(speed) {
    const s = fin(speed, 1);
    this.rate = s;
    if (s < 0.75) { this.fMul = 0.6; this.tMul = 1.6; } else { this.fMul = 1; this.tMul = 1; }
    this.bGain = s >= 4 ? 0.62 : s >= 2 ? 0.8 : 1;
    const c = this.ctx;
    if (!c || !this.battleBus) return;
    try { this.battleBus.gain.setTargetAtTime(this.bGain, c.currentTime, 0.05); } catch (_) {}
  }

  stopBattle() {
    const c = this.ctx;
    if (!c) return;
    try {
      const list = this.voices.slice();
      for (const v of list) if (v.battle) this._kill(v, 0.07);
    } catch (_) {}
  }

  // ------------------------------------------------------------ 界面音
  ui(name) {
    try { this._ui(name); } catch (_) {}
  }

  _ui(name) {
    switch (name) {
      case 'tick': {
        const v = this._voice('tick', false, 0, 1); if (!v) return;
        const f = 1800 * rnd(0.97, 1.03);
        this._osc(v, { type: 'triangle', f, f1: f * 0.85, d: 0.012, g: 0.16, a: 0.0008 });
        this._noise(v, { d: 0.006, g: 0.06, filt: 'highpass', f: 3500, a: 0.0005 });
        break;
      }
      case 'snap': {
        const v = this._voice('snap', false, 0, 1); if (!v) return;
        const f = 1150 * rnd(0.96, 1.04);
        this._osc(v, { type: 'sine', f, f1: f * 0.9, d: 0.009, g: 0.045, a: 0.0008 });
        break;
      }
      case 'place': {
        const v = this._voice('place', false, 0, 1); if (!v) return;
        const k = rnd(0.97, 1.03);
        // 木质「笃」：带通噪声瞬态 + 快速下滑的三角波主体
        this._noise(v, { d: 0.018, g: 0.18, filt: 'bandpass', f: 1500 * k, q: 3, a: 0.0006 });
        this._osc(v, { type: 'triangle', f: 560 * k, f1: 360 * k, fd: 0.05, d: 0.07, g: 0.34, a: 0.001 });
        this._osc(v, { type: 'sine', f: 1120 * k, f1: 900 * k, d: 0.03, g: 0.08, a: 0.0008 });
        // 小小的上扬尾音
        this._osc(v, { type: 'sine', at: 0.028, f: 1500 * k, f1: 2500 * k, fd: 0.045, d: 0.06, g: 0.06, a: 0.004 });
        break;
      }
      case 'cannon': {
        const v = this._voice('cannon', false, 0, 1); if (!v) return;
        this._noise(v, { d: 0.03, g: 0.2, filt: 'bandpass', f: 2200, q: 1.5, a: 0.0006 });
        this._osc(v, { type: 'triangle', f: 150, f1: 85, fd: 0.12, d: 0.18, g: 0.42, a: 0.0015, lp: 1200 });
        this._partials(v, 640, [1, 1.47, 2.09, 2.76], { d: 0.2, g: 0.12, at: 0.002 });
        this._osc(v, { type: 'square', at: 0.06, f: 110, f1: 70, d: 0.08, g: 0.1, lp: 500 });
        break;
      }
      case 'aim': {
        const v = this._voice('aim', false, 0, 1); if (!v) return;
        this._noise(v, { d: 0.004, g: 0.07, filt: 'highpass', f: 3000, a: 0.0004 });
        this._osc(v, { type: 'triangle', f: 2600 * rnd(0.98, 1.02), d: 0.006, g: 0.05, a: 0.0004 });
        break;
      }
      case 'delete': {
        const v = this._voice('delete', false, 0, 1); if (!v) return;
        this._osc(v, { type: 'triangle', f: 950, f1: 280, fd: 0.09, d: 0.1, g: 0.2, a: 0.002 });
        this._noise(v, { at: 0.01, d: 0.06, g: 0.09, filt: 'bandpass', f: 3200, f1: 900, q: 1.2, a: 0.004 });
        break;
      }
      case 'error': {
        const v = this._voice('error', false, 0, 1); if (!v) return;
        for (const at of [0, 0.13]) {
          this._osc(v, { type: 'triangle', at, f: 150, f1: 105, fd: 0.08, d: 0.11, g: 0.4, a: 0.003, lp: 600 });
          this._noise(v, { at, d: 0.03, g: 0.06, filt: 'lowpass', f: 500, a: 0.002 });
        }
        break;
      }
      case 'undo': {
        const v = this._voice('undo', false, 0, 1); if (!v) return;
        // 倒放感：慢起、骤停
        const c = this.ctx, t0 = v.t;
        const o = c.createOscillator(); o.type = 'sine';
        o.frequency.setValueAtTime(520, t0);
        o.frequency.exponentialRampToValueAtTime(880, t0 + 0.07);
        const g = c.createGain();
        g.gain.setValueAtTime(SILENT, t0);
        g.gain.exponentialRampToValueAtTime(0.16, t0 + 0.065);
        g.gain.linearRampToValueAtTime(SILENT, t0 + 0.075);
        o.connect(g); g.connect(v.out);
        o.start(t0); o.stop(t0 + 0.09);
        this._track(v, o, t0 + 0.09, [g]);
        break;
      }
      case 'start': {
        const v = this._voice('start', false, 0, 1); if (!v) return;
        // 上扬的风声，接一记低沉鼓
        this._swell(v, { d: 0.62, peakAt: 0.55, g: 0.22, filt: 'bandpass', f: 300, f1: 2600, q: 1.4 });
        const hit = 0.6;
        this._osc(v, { type: 'sine', at: hit, f: 125, f1: 42, fd: 0.35, d: 0.55, g: 0.7, a: 0.002 });
        this._noise(v, { at: hit, d: 0.12, g: 0.22, filt: 'lowpass', f: 700, f1: 200, buf: 'brown', a: 0.001 });
        this._noise(v, { at: hit, d: 0.02, g: 0.08, filt: 'highpass', f: 2500, a: 0.0005 });
        break;
      }
      case 'back': {
        const v = this._voice('back', false, 0, 1); if (!v) return;
        this._swell(v, { d: 0.55, peakAt: 0.12, g: 0.16, filt: 'bandpass', f: 2200, f1: 280, q: 1.2 });
        break;
      }
      case 'win': {
        const v = this._voice('win', false, 0, 1); if (!v) return;
        const notes = [523.25, 659.25, 783.99, 1046.5];
        notes.forEach((f, i) => this._note(v, f, i * 0.12, i === 3 ? 0.9 : 0.4, i === 3 ? 0.26 : 0.2));
        break;
      }
      case 'lose': {
        const v = this._voice('lose', false, 0, 1); if (!v) return;
        const notes = [329.63, 261.63, 220.0]; // E4 C4 A3，A 小调下行
        notes.forEach((f, i) => this._note(v, f, i * 0.22, i === 2 ? 1.0 : 0.45, 0.22, 1800));
        break;
      }
      case 'draw': {
        const v = this._voice('draw', false, 0, 1); if (!v) return;
        this._note(v, 587.33, 0, 0.45, 0.2, 2600);
        this._note(v, 440.0, 0.2, 0.7, 0.2, 2600);
        break;
      }
      default: break;
    }
  }

  // ------------------------------------------------------------ 战斗音
  onEvent(e, sim) {
    try { if (e && typeof e === 'object') this._event(e, sim); } catch (_) {}
  }

  _pan(x) {
    const w = CFG && CFG.fieldW ? CFG.fieldW : 30;
    const t = clamp(fin(x, w / 2) / w, 0, 1);
    return -0.6 + 1.2 * t;
  }

  _event(e, sim) {
    if (!this.ctx || this.muted) return;
    switch (e.type) {
      case 'fire': {
        const v = this._voice('fire', true, this._pan(e.x), 1); if (!v) return;
        const k = rnd(0.94, 1.06);
        this._noise(v, { d: 0.5, g: 0.7, filt: 'lowpass', f: 900 * k, f1: 120, fd: 0.4, q: 0.9, buf: 'brown', a: 0.002 });
        this._noise(v, { d: 0.05, g: 0.22, filt: 'bandpass', f: 1800 * k, q: 0.8, a: 0.0008 });
        this._osc(v, { type: 'sine', f: 90 * k, f1: 40, fd: 0.3, d: 0.45, g: 0.85, a: 0.002 });
        break;
      }
      case 'explode': {
        const kind = e.kind;
        const v = this._voice('explode', true, this._pan(e.x), 1); if (!v) return;
        const k = rnd(0.88, 1.12);
        const ground = kind === 'ground';
        this._noise(v, { d: 0.9, g: ground ? 0.75 : 0.85, filt: 'lowpass', f: (ground ? 650 : 1500) * k, f1: 110, fd: 0.7, q: 0.8, buf: 'brown', a: 0.003 });
        if (!ground) this._noise(v, { d: 0.12, g: 0.3, filt: 'bandpass', f: 2200 * k, f1: 700, q: 0.7, a: 0.001 });
        else this._noise(v, { at: 0.03, d: 0.4, g: 0.14, filt: 'bandpass', f: 500, q: 1, a: 0.02 });
        this._osc(v, { type: 'sine', f: 72 * k, f1: 30, fd: 0.5, d: 0.7, g: ground ? 0.7 : 0.9, a: 0.003 });
        if (kind === 'steel' || kind === 'cannon') {
          this._partials(v, rnd(700, 820), [1, 1.37, 1.71, 1.93], { d: 0.6, g: kind === 'steel' ? 0.22 : 0.16, at: 0.004 });
        } else if (kind === 'core') {
          this._zap(v, 0.3, 0.005);
        } else if (kind === 'wood') {
          this._noise(v, { at: 0.01, d: 0.09, g: 0.12, filt: 'highpass', f: 2800, a: 0.001 });
        }
        break;
      }
      case 'break': {
        if (e.cause === 'sunk') return;   // 沉没的杆件不出声
        const mx = (fin(e.x1, 0) + fin(e.x2, 0)) / 2;
        if (e.cause === 'blast') {
          const v = this._voice('blast', true, this._pan(mx), 1); if (!v) return;
          this._noise(v, { d: 0.09, g: 0.2, filt: 'bandpass', f: 900 * rnd(0.85, 1.15), q: 1.2, a: 0.001 });
          this._noise(v, { d: 0.14, g: 0.14, filt: 'lowpass', f: 400, buf: 'brown', a: 0.002 });
          return;
        }
        const v = this._voice('break', true, this._pan(mx), 1); if (!v) return;
        const k = rnd(0.94, 1.06);
        switch (e.mat) {
          case 'steel':
            this._noise(v, { d: 0.015, g: 0.2, filt: 'highpass', f: 4000, a: 0.0005 });
            this._partials(v, 1150 * k, [1, 2.76, 5.4], { d: 0.35, g: 0.2 });
            this._partials(v, 410 * k, [1, 1.59, 2.14, 2.83], { d: 0.6, g: 0.22, at: 0.004 });
            break;
          case 'rope': {
            // 拨弦：锯齿波 + 下扫低通
            this._osc(v, { type: 'sawtooth', f: 240 * k, f1: 190 * k, fd: 0.25, d: 0.28, g: 0.24, a: 0.001, lp: 3200, lp1: 350, q: 4 });
            this._noise(v, { d: 0.02, g: 0.1, filt: 'highpass', f: 3000, a: 0.0005 });
            break;
          }
          case 'spring': {
            const o = this._osc(v, { type: 'sine', f: 330 * k, f1: 260 * k, fd: 0.4, d: 0.42, g: 0.3, a: 0.002 });
            this._lfo(v, o, 15, 90 * k, 0.4);
            this._osc(v, { type: 'triangle', f: 660 * k, d: 0.06, g: 0.06, a: 0.001 });
            break;
          }
          default: // wood
            this._noise(v, { d: 0.03, g: 0.42, filt: 'highpass', f: 2600 * k, a: 0.0005 });
            this._osc(v, { type: 'triangle', f: 300 * k, f1: 220 * k, fd: 0.06, d: 0.09, g: 0.36, a: 0.001 });
            this._noise(v, { at: 0.012, d: 0.06, g: 0.1, filt: 'bandpass', f: 1200, q: 2, a: 0.001 });
        }
        break;
      }
      case 'splash': {
        const p = clamp(fin(e.power, 0.5), 0.15, 1);
        const v = this._voice('splash', true, this._pan(e.x), 0.4 + 0.6 * p); if (!v) return;
        this._swell(v, { d: 0.6, peakAt: 0.1, g: 0.42 * p, filt: 'bandpass', f: 600, mid: 1800, f1: 800, q: 1.1 });
        this._noise(v, { at: 0.05, d: 0.45, g: 0.1 * p, filt: 'highpass', f: 3500, a: 0.04 });
        if (p > 0.5) this._osc(v, { type: 'sine', f: 380, f1: 130, fd: 0.06, d: 0.09, g: 0.25 * p, a: 0.002 });
        break;
      }
      case 'coreHit': {
        const x = this._coreX(e, sim);
        const v = this._voice('coreHit', true, this._pan(x), 1); if (!v) return;
        this._zap(v, 0.45, 0);
        this._noise(v, { d: 0.04, g: 0.12, filt: 'highpass', f: 3000, a: 0.0006 });
        break;
      }
      case 'coreDestroyed': {
        const v = this._voice('coreDestroyed', true, this._pan(e.x), 1); if (!v) return;
        this._noise(v, { d: 2.6, g: 1.3, filt: 'lowpass', f: 2200, f1: 70, fd: 2.0, q: 0.8, buf: 'brown', a: 0.004 });
        this._noise(v, { d: 0.25, g: 0.4, filt: 'bandpass', f: 2500, f1: 600, q: 0.7, a: 0.001 });
        this._osc(v, { type: 'sine', f: 64, f1: 24, fd: 1.6, d: 1.9, g: 1.2, a: 0.004 });
        this._osc(v, { type: 'sawtooth', at: 0.02, f: 1600, f1: 70, fd: 1.4, d: 1.6, g: 0.18, a: 0.01, lp: 2400, lp1: 200 });
        this._zap(v, 0.35, 0.01);
        this._noise(v, { at: 0.35, d: 1.6, g: 0.4, filt: 'lowpass', f: 300, buf: 'brown', a: 0.15 });
        break;
      }
      case 'coreSunk': {
        const v = this._voice('coreSunk', true, this._pan(e.x), 1); if (!v) return;
        this._osc(v, { type: 'sine', f: 230, f1: 55, fd: 0.5, d: 0.7, g: 0.8, a: 0.01 });
        this._swell(v, { d: 0.9, peakAt: 0.12, g: 0.45, filt: 'bandpass', f: 600, mid: 1800, f1: 700, q: 1 });
        for (let i = 0; i < 5; i++) {
          const f = rnd(280, 520);
          this._osc(v, { type: 'sine', at: 0.25 + i * rnd(0.09, 0.16), f, f1: f * 2.2, fd: 0.05, d: 0.07, g: 0.12, a: 0.004 });
        }
        break;
      }
      case 'cannonLost': {
        const v = this._voice('cannonLost', true, this._pan(e.x), 1); if (!v) return;
        this._noise(v, { d: 0.03, g: 0.25, filt: 'bandpass', f: 2600, q: 1.2, a: 0.0006 });
        this._partials(v, 420 * rnd(0.95, 1.05), [1, 1.45, 2.33, 3.4], { d: 0.38, g: 0.26 });
        this._osc(v, { type: 'triangle', f: 120, f1: 70, d: 0.15, g: 0.3, a: 0.002, lp: 800 });
        break;
      }
      case 'fightStart': {
        const v = this._voice('fightStart', true, 0, 1); if (!v) return;
        // 一记钟声
        this._partials(v, 392, [1, 2.0, 2.76, 4.07, 5.43], { d: 1.6, g: 0.22, at: 0.002, fall: 0.25 });
        this._osc(v, { type: 'sine', f: 196, d: 1.2, g: 0.12, a: 0.004 });
        break;
      }
      default: break; // 'end' 等：不出声
    }
  }

  _coreX(e, sim) {
    try {
      const core = sim && sim.cores && sim.cores[e.side];
      if (core && sim.x && core.node != null) return sim.x[core.node];
    } catch (_) {}
    return e.side === 1 ? (CFG.fieldW || 30) : 0;
  }

  // ------------------------------------------------------------ voice 管理
  _voice(key, battle, pan, gain) {
    const c = this.ctx;
    if (!c || this.muted) return null;
    const now = c.currentTime;
    const gap = (GAP[key] || 0.03) * (battle && this.rate > 2 ? 1.5 : 1);
    const lt = this.last[key];
    if (lt != null && now - lt < gap && now >= lt) return null;
    this.last[key] = now;

    this._gc(now);
    const prio = PRIO[key] ?? 2;
    if (this.voices.length >= MAX_VOICES) {
      let cand = null;
      for (const v of this.voices) {
        if (!cand || v.prio < cand.prio || (v.prio === cand.prio && v.born < cand.born)) cand = v;
      }
      if (!cand || cand.prio > prio) return null;
      this._kill(cand, 0.012);
    }

    const out = c.createGain();
    out.gain.value = gain;
    const nodes = [out];
    let tail = out;
    if (pan && this.hasPanner) {
      try {
        const p = c.createStereoPanner();
        p.pan.value = clamp(pan, -1, 1);
        out.connect(p); nodes.push(p); tail = p;
      } catch (_) { tail = out; }
    }
    tail.connect(battle ? this.battleBus : this.uiBus);
    const v = {
      key, battle, prio, out, nodes, srcs: [], live: 0, born: now, t: now + 0.004, end: now + 0.05, dead: false,
      fm: battle ? this.fMul : 1, tm: battle ? this.tMul : 1,
    };
    this.voices.push(v);
    return v;
  }

  _track(v, src, stopAt, extra) {
    v.srcs.push(src);
    if (extra) for (const n of extra) if (n) v.nodes.push(n);
    v.live++;
    if (stopAt > v.end) v.end = stopAt;
    src.onended = () => { if (--v.live <= 0) this._free(v); };
  }

  _kill(v, tau) {
    const c = this.ctx;
    const now = c.currentTime;
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
    if (v.dead) return;
    this.dying.push(v);
    try {
      const g = v.out.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.setTargetAtTime(0, now, tau);
    } catch (_) {}
    const stopAt = now + tau * 7;
    for (const s of v.srcs) { try { s.stop(stopAt); } catch (_) {} }
    v.end = Math.min(v.end, stopAt);
  }

  _free(v) {
    if (v.dead) return;
    v.dead = true;
    for (const s of v.srcs) { try { s.onended = null; s.disconnect(); } catch (_) {} }
    for (const n of v.nodes) { try { n.disconnect(); } catch (_) {} }
    v.srcs.length = 0; v.nodes.length = 0;
    let i = this.voices.indexOf(v); if (i >= 0) this.voices.splice(i, 1);
    i = this.dying.indexOf(v); if (i >= 0) this.dying.splice(i, 1);
  }

  // onended 未触发时的兜底回收
  _gc(now) {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (now > v.end + 0.3) this._free(v);
    }
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const v = this.dying[i];
      if (now > v.end + 0.3) this._free(v);
    }
  }

  // ------------------------------------------------------------ 合成积木
  // 振荡器：o = { type, at, f, f1, fd, d, g, a, lp, lp1, q, to }
  _osc(v, o) {
    const c = this.ctx;
    const t0 = v.t + (o.at || 0) * v.tm;
    const d = o.d * v.tm;
    const a = (o.a ?? 0.002) * v.tm;
    const osc = c.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f * v.fm, t0);
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1 * v.fm), t0 + (o.fd ?? o.d) * v.tm);
    const g = c.createGain();
    envPerc(g.gain, t0, a, o.g, d);
    const extra = [g];
    if (o.lp) {
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.setValueAtTime(o.lp * v.fm, t0);
      if (o.lp1) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.lp1 * v.fm), t0 + d);
      setP(f.Q, o.q ?? 0.7);
      osc.connect(f); f.connect(g); extra.push(f);
    } else {
      osc.connect(g);
    }
    g.connect(o.to || v.out);
    const stopAt = t0 + d + 0.03;
    osc.start(t0); osc.stop(stopAt);
    this._track(v, osc, stopAt, extra);
    return osc;
  }

  // 滤波噪声：o = { at, d, a, g, filt, f, f1, fd, q, buf }
  _noise(v, o) {
    const c = this.ctx;
    const t0 = v.t + (o.at || 0) * v.tm;
    const d = o.d * v.tm;
    const a = (o.a ?? 0.002) * v.tm;
    const src = c.createBufferSource();
    src.buffer = o.buf === 'brown' ? this.brown : this.noise;
    src.loop = true;
    const f = c.createBiquadFilter();
    f.type = o.filt || 'bandpass';
    f.frequency.setValueAtTime(Math.min(18000, o.f * v.fm), t0);
    if (o.f1) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1 * v.fm), t0 + (o.fd ?? o.d) * v.tm);
    setP(f.Q, o.q ?? 0.8);
    const g = c.createGain();
    envPerc(g.gain, t0, a, o.g, d);
    src.connect(f); f.connect(g); g.connect(v.out);
    const stopAt = t0 + d + 0.03;
    src.start(t0, Math.random() * 1.5); src.stop(stopAt);
    this._track(v, src, stopAt, [f, g]);
    return src;
  }

  // 渐起渐落的噪声（风声 / 水花）：o = { d, peakAt, g, filt, f, mid?, f1, q }
  _swell(v, o) {
    const c = this.ctx;
    const t0 = v.t;
    const d = o.d * v.tm;
    const pk = Math.min(d - 0.01, o.peakAt * v.tm);
    const src = c.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    const f = c.createBiquadFilter();
    f.type = o.filt || 'bandpass';
    setP(f.Q, o.q ?? 1);
    f.frequency.setValueAtTime(o.f * v.fm, t0);
    if (o.mid) {
      f.frequency.exponentialRampToValueAtTime(o.mid * v.fm, t0 + pk);
      f.frequency.exponentialRampToValueAtTime(o.f1 * v.fm, t0 + d);
    } else {
      f.frequency.exponentialRampToValueAtTime(o.f1 * v.fm, t0 + d);
    }
    const g = c.createGain();
    g.gain.setValueAtTime(SILENT, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(SILENT * 2, o.g), t0 + pk);
    g.gain.exponentialRampToValueAtTime(SILENT, t0 + d);
    src.connect(f); f.connect(g); g.connect(v.out);
    const stopAt = t0 + d + 0.03;
    src.start(t0, Math.random() * 1.5); src.stop(stopAt);
    this._track(v, src, stopAt, [f, g]);
  }

  // 非谐泛音（金属 / 钟）：opts = { d, g, at, fall }
  _partials(v, base, ratios, opts) {
    const n = ratios.length;
    const fall = opts.fall ?? 0.35;
    ratios.forEach((r, i) => {
      this._osc(v, {
        type: 'sine', at: opts.at || 0, f: base * r * rnd(0.995, 1.005),
        d: opts.d / (1 + i * fall), g: (opts.g / Math.sqrt(n)) / (1 + i * 0.25), a: 0.0008,
      });
    });
  }

  // 共振电击声
  _zap(v, g, at) {
    this._osc(v, { type: 'sawtooth', at, f: 1300, f1: 240, fd: 0.16, d: 0.2, g, a: 0.001, lp: 3200, lp1: 500, q: 9 });
    this._osc(v, { type: 'square', at, f: 1760, d: 0.12, g: g * 0.2, a: 0.001, lp: 2500, q: 6 });
  }

  // 调频 LFO（弹簧）
  _lfo(v, target, rate, depth, dur) {
    const c = this.ctx;
    const t0 = v.t, d = dur * v.tm;
    const l = c.createOscillator();
    l.type = 'sine';
    l.frequency.setValueAtTime(rate / v.tm, t0);
    const g = c.createGain();
    g.gain.setValueAtTime(depth * v.fm, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(1, depth * 0.1), t0 + d);
    l.connect(g); g.connect(target.frequency);
    const stopAt = t0 + d + 0.03;
    l.start(t0); l.stop(stopAt);
    this._track(v, l, stopAt, [g]);
  }

  // 柔和乐音（结算）：三角波 + 高八度正弦，带低通
  _note(v, f, at, d, g, lp = 4200) {
    this._osc(v, { type: 'triangle', at, f, d, g, a: 0.006, lp });
    this._osc(v, { type: 'sine', at, f: f * 2, d: d * 0.6, g: g * 0.25, a: 0.004 });
  }
}
