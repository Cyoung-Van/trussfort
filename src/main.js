// 桁垒 TRUSSFORT — 入口：状态机、主循环、模块接线。
//
// 状态：blueprint ⇄ (toBattle) ⇄ battle ⇄ (toBlueprint)
// blend：0 = 蓝图界面，1 = 实景。蓝图画布按 blend 淡出，3D 相机按 blend 从正视推成透视。
// 蓝图是唯一数据源：开战时由蓝图生成一份 Sim，退回蓝图时 Sim 被丢弃，蓝图原样保留。

import { CFG } from './config.js';
import { View } from './view.js';
import { Blueprint } from './sim/blueprint.js';
import { Sim } from './sim/sim.js';
import { presetFort, hasPreset } from './sim/forts.js';
import { getMap, mapData, validateMap, MAPS, MAP_ORDER } from './map.js';
import { Editor } from './editor/editor.js';
import { MapEditor, blankMap } from './editor/mapedit.js';
import { SetupUI } from './ui/setup.js';
import { World } from './render/world.js';
import { StructureView } from './render/structure.js';
import { Fx } from './render/fx.js';
import { GameAudio } from './audio/audio.js';
import { Hud } from './ui/hud.js';
import { ArenaPanel, shortName } from './ui/arena.js';
import { rules, loadFort, exportFort, formatFort } from './ai/api.js';

const SAVE_KEY = 'trussfort.blueprint.v1';   // 旧存档：只有「海峡」上左边那一座
const TIP_KEY = 'trussfort.tip.v1';
const MAP_KEY = 'trussfort.map.v1';          // 上次用的地图
const MAPS_KEY = 'trussfort.maps.v1';        // 自定义地图
const fortKey = (mapId, seat) => `trussfort.fort.v2.${mapId}.${seat}`;   // 每张地图、每个座位各存一座堡垒；导入的对手另存在 file 这一格
const rivalKey = (mapId) => `trussfort.rival.v1.${mapId}`;
const SEAT_NAMES = ['玩家 1', '玩家 2'];
// 右边坐谁
const RIVALS = [
  { kind: 'preset', name: '守军', desc: '这张图自带的对手', why: '这张图没有自带的对手' },
  { kind: 'mirror', name: '镜像', desc: '和自己这座堡垒的复制品打一场' },
  { kind: 'human', name: '玩家 2', desc: '两个人在同一台电脑上轮流搭建，再开战' },
  { kind: 'file', name: '导入的堡垒', desc: '从文件载入，比如 AI 设计的堡垒（也可以把文件拖到窗口右半边）' },
];
const ls = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* 无痕模式等 */ } };
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

    // 地图、对手和两座堡垒。forts[0] 在左、forts[1] 在右；player / enemy 是它们的别名
    this.customMaps = this._loadCustomMaps();
    this.map = this._openMap(ls(MAP_KEY));
    this.rival = this._savedRival();
    this.editing = 0;           // 编辑器现在改的是哪个座位（只有对手是「玩家 2」时才会是 1）
    this.hideFoe = false;       // 双人轮流搭建时遮住对方
    this.forts = [null, null];
    this.forts[0] = this._makeFort(0);
    this.forts[1] = this._makeFort(1);
    this._lostFort = false;     // 启动时读到坏存档就悄悄换成默认的，不打扰
    this.player = this.forts[0]; this.enemy = this.forts[1];
    this.reports = [null, null];
    this.view = new View(this.map);

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
    this.spectate = null;       // 观战回放：{ a, b, seed, map, names, caption, record, match, ri, gi }；此时不用也不改玩家的蓝图
    this._replayGen = 0;        // 回放请求的代号：用户关掉列表、返回、重播或另开一场时加一，让还在路上的旧请求作废
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
        arena: () => this.openArena(),
        next: () => this.playNext(),
      },
    });
    this.arena = new ArenaPanel({
      root: this.uiRoot,
      onPlay: (m, ri, gi) => this.playRecorded(m, ri, gi),
      onDismiss: () => { this._replayGen++; },
    });
    this.world = new World({ canvas: this.glCanvas, view: this.view, map: this.map });
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
    this.setup = new SetupUI({ root: this.uiRoot, box: this.hud.setupBox, actions: this._setupActions() });
    this.mapEditor = new MapEditor({
      canvas: this.bpCanvas, view: this.view, root: this.uiRoot,
      onSave: (raw) => this.closeMapEditor(raw),
      onCancel: () => this.closeMapEditor(null),
      toast: (t, k) => this.hud.toast(t, k),
    });

    this._bindInput();
    this._bindFortIO();
    this.resize();
    this.view.fit(this.view.fieldB, padFor('blueprint', this.view.w));
    this.setTool('wood');
    this.hud.setMode('blueprint');
    this.hud.setLimits(this.map);
    this._applySeats();
    this.structure.setStressView(this.stressView);
    this.hud.setStress(this.stressView);
    this.hud.setMuted(this.muted);
    this.hud.setFocus(this.focus);

    this._warmUp();
    if (this._droppedCannons) {
      this.hud.toast(`规则更新：炮座不能再接锚点或贴地，已拆除 ${this._droppedCannons} 门不合规的炮并退款`, 'info');
      this._save();
    }

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
      const W = this.map.fieldW, wy = this.map.hasWater ? this.map.waterY : this.map.groundTop(this.map.fieldW / 2);
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

  // ------------------------------------------------------------ 地图
  _loadCustomMaps() {
    try {
      const arr = JSON.parse(ls(MAPS_KEY) || '[]');
      return Array.isArray(arr) ? arr.filter((m) => m && typeof m.id === 'string' && !MAPS[m.id] && validateMap(m) === null) : [];
    } catch { return []; }
  }
  _saveCustomMaps() { lsSet(MAPS_KEY, JSON.stringify(this.customMaps)); }
  _rawMap(id) { return MAPS[id] || this.customMaps.find((m) => m.id === id) || null; }
  /** 取一张地图；找不到或数据坏了就回到「海峡」 */
  _openMap(id) {
    try { return getMap(this._rawMap(id) || MAPS.strait); } catch { return getMap('strait'); }
  }
  _mapList() {
    return [
      ...MAP_ORDER.map((id) => ({ id, name: MAPS[id].name, raw: MAPS[id], custom: false })),
      ...this.customMaps.map((raw) => ({ id: raw.id, name: raw.name, raw, custom: true })),
    ];
  }

  /** 换一张地图：存好手上的堡垒，换上这张图自己的那一套 */
  setMap(id) {
    if (this.state !== 'blueprint') { this.hud.toast('先返回蓝图，再换地图', 'error'); return false; }
    this.editor.cancel();
    this._saveNow();
    this.map = this._openMap(id);
    lsSet(MAP_KEY, this.map.id);
    this.rival = this._savedRival();
    this.editing = 0;
    this._lostFort = false;
    this.forts[0] = this._makeFort(0);
    this.forts[1] = this._makeFort(1);
    this.reports = [null, null];
    this._showMap(this.map);
    this.hud.setLimits(this.map);
    this.focus = 'field'; this.hud.setFocus('field');
    this.view.fit(this.view.fieldB, padFor('blueprint', this.view.w));
    this._bpView = null;
    this._applySeats();
    if (this._lostFort) {
      const f = this._lostFort;
      this._lostFort = false;
      this.hud.toast(f.kept
        ? (f.lost ? `地图变了：原来的堡垒有 ${f.lost} 根杆件放不下，已去掉，其余照旧` : '地图变了：原来的堡垒已照原样搬过来')
        : '原来存在这张图上的堡垒已经放不下（地图或规则变了），换成了新的蓝图', 'info');
    }
    return true;
  }

  /** 让画面（取景、实景、特效）用这张地图。观战回放时可能和玩家手上的地图不是同一张 */
  _showMap(M) {
    this.view.setMap(M);
    this.world.setMap(M);
    this.fx.setMap(M);
  }

  // ------------------------------------------------------------ 座位：谁在左、谁在右、现在改哪一座
  _savedRival() {
    const k = ls(rivalKey(this.map.id));
    if (k === 'file' && !ls(fortKey(this.map.id, 'file'))) return this._defaultRival();
    if (k === 'preset' && !hasPreset(this.map, 'garrison')) return this._defaultRival();
    return RIVALS.some((r) => r.kind === k) ? k : this._defaultRival();
  }
  _defaultRival() { return hasPreset(this.map, 'garrison') ? 'preset' : 'mirror'; }

  /** 读存档里的堡垒。规则更新后不再合法的炮会被拆掉（等于退款）；其它不合法的存档直接丢弃 */
  _readFort(seat) {
    const tryLoad = (raw) => {
      if (!raw) return null;
      try {
        const json = JSON.parse(raw);
        const bp = Blueprint.fromJSON(json, seat ? 'enemy' : 'player', undefined, this.map);
        const dropped = bp.dropIllegalCannons();
        if (bp.validate() === null) {
          if (dropped && seat === 0) this._droppedCannons = dropped;
          return bp;
        }
        // 地图改过（多了个锚点、挪了地形）之后原样读不进来：按坐标把还放得下的杆件重新搭上去，
        // 并把原件另存一份，免得接下来的自动存档把它冲掉
        lsSet(fortKey(this.map.id, this._slot(seat)) + '.bak', raw);
        const fix = this._salvage(json, seat);
        this._lostFort = { kept: fix.kept, lost: fix.lost };
        return fix.kept ? fix.bp : null;
      } catch { this._lostFort = { kept: 0, lost: 0 }; return null; }
    };
    return tryLoad(ls(fortKey(this.map.id, this._slot(seat)))) || (seat === 0 && this.map.raw === MAPS.strait ? tryLoad(ls(SAVE_KEY)) : null);
  }
  /** 把一份存档里的杆件和火炮按坐标重新搭到当前地图上，放不下的丢掉。返回 { bp, kept, lost } */
  _salvage(json, seat) {
    const DEG = Math.PI / 180;
    const bp = new Blueprint(seat ? 'enemy' : 'player', undefined, this.map);
    const at = new Map();
    for (const [id, x, y, kind] of json.nodes || []) { at.set(id, [x, y]); if (kind === 'core') bp.setCore(x, y); }
    const ends = new Map();
    let kept = 0, lost = 0;
    for (const [id, a, b, mat] of json.beams || []) {
      const pa = at.get(a), pb = at.get(b);
      const na = pa && bp.addNode(pa[0], pa[1]), nb = pb && bp.addNode(pb[0], pb[1]);
      const r = na && nb && na.ok && nb.ok ? bp.addBeam(na.id, nb.id, mat) : { ok: false };
      if (r.ok) { kept++; ends.set(id, r.id); } else {
        lost++;
        for (const n of [na, nb]) if (n && n.ok && !n.existed) bp._pruneNode(n.id);
      }
    }
    for (const [, beam, deg] of json.cannons || []) if (ends.has(beam)) bp.addCannon(ends.get(beam), deg * DEG);
    return { bp, kept, lost };
  }

  /** 存档位：左边是 0；右边是玩家 2 自己搭的（1）还是导入的（file），各存各的 */
  _slot(seat) { return seat === 0 ? 0 : this.rival === 'file' ? 'file' : 1; }

  _makeFort(seat) {
    const M = this.map;
    if (seat === 0) return this._readFort(0) || presetFort(M, 'starter', 'player') || new Blueprint('player', undefined, M);
    switch (this.rival) {
      case 'preset': return presetFort(M, 'garrison', 'enemy') || new Blueprint('enemy', undefined, M);
      case 'mirror': return this.forts[0].clone('enemy');
      default: return this._readFort(1) || new Blueprint('enemy', undefined, M);   // 玩家 2 自己搭的，或者导入的
    }
  }

  /** 换对手 */
  setRival(kind) {
    if (this.state !== 'blueprint') return false;
    if (!RIVALS.some((r) => r.kind === kind)) return false;
    if (kind === 'preset' && !hasPreset(this.map, 'garrison')) { this.hud.toast('这张图没有自带的对手', 'error'); return false; }
    if (kind === 'file' && !ls(fortKey(this.map.id, 'file'))) { this.hud.toast('还没有导入过堡垒：把文件拖到窗口右半边', 'info'); return false; }
    this.editor.cancel();
    this._saveNow();
    this.rival = kind;
    lsSet(rivalKey(this.map.id), kind);
    this.editing = 0;
    this.forts[1] = this._makeFort(1);
    this.reports = [null, null];
    this._applySeats();
    return true;
  }

  /** 双人轮流搭建时，换另一位来搭 */
  setEditing(seat) {
    if (this.state !== 'blueprint' || this.rival !== 'human' || seat === this.editing) return;
    this.editing = seat ? 1 : 0;
    this._applySeats();
    this.hud.toast(`现在由${SEAT_NAMES[this.editing]} 搭建${this.editing ? '（开战后在右边）' : ''}`, 'info');
  }

  /** 座位、对手或地图变了之后，把编辑器和界面对齐 */
  _applySeats() {
    this.player = this.forts[0]; this.enemy = this.forts[1];
    const two = this.rival === 'human';
    const e = this.editing;
    const rivalName = (RIVALS.find((r) => r.kind === this.rival) || {}).name || '';
    // 只有真的换了蓝图才换（换蓝图会清空撤销记录）；只是改了显示选项就原样留着
    if (this.editor.player !== this.forts[e] || this.editor.enemy !== this.forts[1 - e]) this.editor.setForts(this.forts[e], this.forts[1 - e]);
    else this.editor.invalidate();
    this.editor.hideEnemy = two && this.hideFoe;
    this.editor.labels = { me: two ? `${SEAT_NAMES[e]} 的堡垒` : '', foe: two ? `${SEAT_NAMES[1 - e]} 的堡垒` : this.rival === 'preset' ? '敌方堡垒' : rivalName };
    this.hud.setNames(two ? SEAT_NAMES : null);
    this._showReport();
    this.setup.setState({
      map: { id: this.map.id, name: this.map.name },
      maps: this._mapList(),
      rival: this.rival,
      rivals: RIVALS.map((r) => ({ ...r, ok: r.kind !== 'preset' || hasPreset(this.map, 'garrison') })),
      editing: e, hideFoe: this.hideFoe, names: two ? SEAT_NAMES : ['我方', '对手'],
    });
    this.onBlueprintChanged({ silent: true });
  }

  _setupActions() {
    return {
      pickMap: (id) => { if (id !== this.map.id) this.setMap(id); },
      newMap: () => this.openMapEditor(blankMap()),
      editMap: (id) => { const raw = this._rawMap(id); if (raw) this.openMapEditor(raw); },
      copyMap: (id) => { const raw = this._rawMap(id); if (raw) this.openMapEditor({ ...mapData(raw), id: '', name: `${raw.name} 改` }); },
      deleteMap: (id) => this.deleteMap(id),
      exportMap: (id) => { const raw = this._rawMap(id); if (raw) this._download(`map-${raw.name}.json`, JSON.stringify(mapData(raw), null, 2) + '\n', `已导出地图：${raw.name}`); },
      importMap: (o, name) => this.importMap(o, name),
      rival: (kind) => this.setRival(kind),
      editSeat: (seat) => this.setEditing(seat),
      hideFoe: (on) => { this.hideFoe = !!on; this._applySeats(); },
      exportFort: () => this._downloadFort(),
      importFort: (seat, o, name) => {
        if (!o) { this.hud.toast(`${name} 不是合法的 JSON`, 'error'); return false; }
        return this.setFort(seat ? 'enemy' : 'player', o, name);
      },
      // 把对手换成一座导入的堡垒（原来是玩家 2 的话，也换成导入的）
      importRival: (o, name) => {
        if (!o) { this.hud.toast(`${name} 不是合法的 JSON`, 'error'); return false; }
        return this.setFort('enemy', o, name, true);
      },
    };
  }

  // ------------------------------------------------------------ 自定义地图
  openMapEditor(raw) {
    if (this.state !== 'blueprint') return;
    this.editor.cancel();
    this._saveNow();
    this.editor.setEnabled(false);
    this.state = 'mapedit';
    this.uiRoot.classList.add('mode-mapedit');
    this.mapEditor.begin(raw);
  }

  /** 关掉地图编辑器。raw 是要保存的地图；取消时传 null */
  closeMapEditor(raw) {
    if (this.state !== 'mapedit') return;
    this.mapEditor.end();
    this.uiRoot.classList.remove('mode-mapedit');
    this.state = 'blueprint';
    this.editor.setEnabled(true);
    this.view.setMap(this.map);
    this.view.fit(this.view.fieldB, padFor('blueprint', this.view.w));
    if (!raw) return;
    const saved = { ...raw, id: raw.id && !MAPS[raw.id] ? raw.id : `custom-${Date.now().toString(36)}` };
    const why = validateMap(saved);
    if (why) { this.hud.toast('地图没有保存：' + why, 'error'); return; }
    const i = this.customMaps.findIndex((m) => m.id === saved.id);
    if (i >= 0) this.customMaps[i] = saved; else this.customMaps.push(saved);
    this._saveCustomMaps();
    this.setMap(saved.id);
    this.hud.toast(`地图「${saved.name}」已保存`, 'info');
  }

  deleteMap(id) {
    const i = this.customMaps.findIndex((m) => m.id === id);
    if (i < 0) return;
    const name = this.customMaps[i].name;
    this.customMaps.splice(i, 1);
    this._saveCustomMaps();
    for (const slot of [0, 1, 'file']) { lsSet(fortKey(id, slot), null); lsSet(fortKey(id, slot) + '.bak', null); }
    lsSet(rivalKey(id), null);
    if (this.map.id === id) this.setMap('strait'); else this._applySeats();
    this.hud.toast(`已删除地图「${name}」`, 'info');
  }

  /** 导入一份地图数据（文件、控制台接口都走这里）。成功后直接换到这张图 */
  importMap(o, name) {
    if (this.state !== 'blueprint') { this.hud.toast('先返回蓝图，再导入地图', 'error'); return false; }
    if (!o) { this.hud.toast(`${name || '这个文件'} 不是合法的 JSON`, 'error'); return false; }
    const raw = { ...o, id: `custom-${Date.now().toString(36)}`, name: typeof o.name === 'string' && o.name ? o.name.slice(0, 16) : (name || '导入的地图').slice(0, 16) };
    const why = validateMap(raw);
    if (why) { this.hud.toast('地图不可用：' + why, 'error'); this.audio.ui('error'); return false; }
    this.customMaps.push(raw);
    this._saveCustomMaps();
    this.setup.close();
    this.setMap(raw.id);
    this.hud.toast(`已导入地图「${raw.name}」`, 'info');
    return true;
  }

  // ------------------------------------------------------------ 存档
  _save() {
    // 拖动节点 / 调射角时每帧都会触发，合并成一次写入
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => this._saveNow(), 250);
  }
  _saveNow() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = 0; }
    lsSet(fortKey(this.map.id, 0), JSON.stringify(this.forts[0].toJSON()));
    // 右边那座只有是人搭的或导入的才需要存；守军和镜像随时能重新生成
    if (this.rival === 'human' || this.rival === 'file') lsSet(fortKey(this.map.id, this._slot(1)), JSON.stringify(this.forts[1].toJSON()));
  }

  // ------------------------------------------------------------ 蓝图界面
  onBlueprintChanged(info = {}) {
    const bp = this.forts[this.editing];
    // 对手是镜像：左边每改一下，右边跟着变
    if (this.rival === 'mirror') { this.forts[1].load(this.forts[0]); this.editor.invalidate(); }
    this.hud.setBudget({ cost: bp.cost(), budget: this.map.budget, breakdown: bp.breakdown(), delta: info.delta || 0, silent: !!info.silent });
    this.hud.setUndoState({ canUndo: this.editor.canUndo, canRedo: this.editor.canRedo });
    this._save();
  }

  /** 「示例」按钮：在这张图的几座示例堡垒之间轮换（可撤销） */
  loadExample() {
    if (this.state !== 'blueprint') return;
    const examples = [
      ['starter', '起手堡垒'],
      ['reference', '参考堡垒（预算内能打赢守军的一种搭法）'],
      ['garrison', '守军的堡垒（看看对手是怎么搭的）'],
    ].filter(([k]) => hasPreset(this.map, k));
    if (!examples.length) { this.hud.toast('自定义地图没有示例堡垒', 'info'); return; }
    this._example = ((this._example || 0) + 1) % examples.length;
    const [kind, name] = examples[this._example];
    const ex = { name };
    this.editor.loadBlueprint(presetFort(this.map, kind, this.editing ? 'enemy' : 'player'));
    this._clearReport();   // 上一战的损毁标记属于被换掉的那座堡垒
    this.hud.toast(`已载入示例：${ex.name}`, 'info');
  }

  // ------------------------------------------------------------ 堡垒导入 / 导出（AI 对战、观战用，见 AI.md）
  /**
   * 载入一座堡垒描述。side: 'player'（左）或 'enemy'（右）。成功返回 true。
   * 描述格式见 src/ai/api.js 的 loadFort：坐标式、命名式或存档格式都行。
   */
  setFort(side, desc, label, asRival = false) {
    const seat = side === 'enemy' || side === 'B' || side === 'right' || side === 1 ? 1 : 0;
    const swap = asRival && this.rival === 'human';   // 玩家 2 的位置让给导入的堡垒
    const two = this.rival === 'human' && !swap;
    const who = two ? SEAT_NAMES[seat] + ' ' : seat ? '对手' : '我方';
    if (this.state !== 'blueprint') { this.hud.toast('先返回蓝图，再载入堡垒', 'error'); return false; }
    let bp;
    try { bp = loadFort(desc, seat ? 'enemy' : 'player', undefined, this.map); } catch (e) {
      this.hud.toast(`${who}的堡垒不合规则：${e && e.message ? e.message : e}`, 'error');
      this.audio.ui('error');
      return false;
    }
    this.editor.cancel();
    if (swap) {
      // 先把玩家 2 自己搭的那座存好（它和导入的堡垒各有各的存档位），再回到玩家 1 这边
      this._saveNow();
      this.rival = 'mirror'; this.editing = 0;
      this.forts[1] = new Blueprint('enemy', undefined, this.map);
    }
    if (seat === this.editing) {
      this.editor.loadBlueprint(bp);          // 正在编辑的这一座：可以撤销
    } else {
      this.forts[seat].load(bp);
      if (seat === 1 && !two) {
        // 右边换成了导入的堡垒
        this.rival = 'file';
        lsSet(rivalKey(this.map.id), 'file');
        this._saveNow();
        this._applySeats();
      } else { this.editor.invalidate(); this._save(); }
    }
    this.reports[seat] = null;
    this._showReport();
    const cost = bp.cost();
    const name = label || (desc && desc.name) || '';
    const over = cost > this.map.budget;
    this.hud.toast(`已载入${who}的堡垒${name ? '「' + name + '」' : ''}：$${cost.toLocaleString()}${over ? '（超出预算）' : ''}`, over ? 'error' : 'info');
    return true;
  }
  resetEnemy() { return this.setRival(this._defaultRival()); }

  _download(filename, text, done) {
    try {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(link.href), 2000);
      this.hud.toast(done, 'info');
    } catch { this.hud.toast('导出失败', 'error'); }
  }
  _downloadFort() {
    const two = this.rival === 'human';
    this._download('fort.json', formatFort(exportFort(this.forts[this.editing], two ? `player-${this.editing + 1}` : 'my-fort')),
      `已导出${two ? SEAT_NAMES[this.editing] + ' ' : '我方'}的堡垒：fort.json（地图：${this.map.name}）`);
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
      rules: (version, map) => rules(version, map || this.map),   // rules() 当前规则和当前地图；rules('v1') 旧版本
      loadFort: (side, desc) => this.setFort(side, desc),
      exportFort: (side) => exportFort(side === 'enemy' ? this.forts[1] : this.forts[0]),
      resetEnemy: () => this.resetEnemy(),
      /** 地图：maps() 列出全部；map() 当前这张的数据；setMap(名字) 换图；importMap(数据) 导入一张自定义地图并换过去 */
      maps: () => this._mapList().map((m) => ({ id: m.id, name: m.name, custom: m.custom })),
      map: () => mapData(this.map),
      setMap: (id) => this.setMap(id),
      importMap: (data) => this.importMap(data),
      /** 对手：rival() 看当前是谁；rival('preset' | 'mirror' | 'human' | 'file') 换；edit(0 | 1) 双人时换人搭 */
      rival: (kind) => { if (kind) this.setRival(kind); return this.rival; },
      edit: (seat) => { this.setEditing(seat); return this.editing; },
      start: () => this.startBattle(),
      back: () => this.backToBlueprint(),
      /** 对战回放：open() 打开列表；play(比赛目录名, 第几轮, 第几局) 直接看一局，返回 Promise<是否开始> */
      replay: {
        open: () => this.openArena(),
        index: () => this.arena.load(),
        play: (id, round = 1, game = 1) => this._playById(id, round, game),
      },
      /** 当前这场的结果；还没打完时 winner 为 null */
      result: () => {
        const s = this.sim;
        if (!s) return null;
        const hp = (c) => (c.alive ? Math.max(0, c.hp) : 0);
        return { phase: s.phase, winner: s.winner, reason: s.endReason, fightSeconds: s.fightTime, coreHp: [hp(s.cores[0]), hp(s.cores[1])], stats: s.stats };
      },
    };

    // 3) 网址参数：?a=左边堡垒.json&b=右边堡垒.json&autostart=1（只在通过 http 打开时可用）
    //    ?replay 打开回放列表；?replay=比赛目录名&round=2&game=1 直接看那一局
    const q = new URLSearchParams(location.search);
    if (q.has('replay')) {
      const id = q.get('replay');
      if (id) this._playById(id, Number(q.get('round')) || 1, Number(q.get('game')) || 1).then((ok) => { if (!ok) this.openArena(); });
      else this.openArena();
    }
    //    ?map=地图名 换到那张图（内置地图的名字，或者自己存过的自定义地图）
    //    带 a / b 而不写 map 时按「海峡」算：这样一条网址在谁的浏览器里打开都是同一场
    const a = q.get('a'), b = q.get('b');
    const wantMap = q.get('map') || (a || b ? 'strait' : null);
    if (wantMap && wantMap !== this.map.id) {
      if (this._rawMap(wantMap)) this.setMap(wantMap); else this.hud.toast(`没有名叫 ${wantMap} 的地图`, 'error');
    }
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

  /** 按「比赛目录名 + 第几轮 + 第几局」（都从 1 数）找到记录并播放 */
  _playById(id, roundNo, gameNo) {
    const gen = this._replayGen;
    return this.arena.load().then((idx) => {
      if (gen !== this._replayGen) return false;   // 等清单的时候用户已经去做别的了
      const m = idx.matches.find((x) => x.id === id);
      const ri = m ? m.rounds.findIndex((r) => r.round === roundNo) : -1;
      if (ri < 0 || !m.rounds[ri].games[gameNo - 1]) { this.hud.toast('没有找到这一局的记录', 'error'); return false; }
      return this.playRecorded(m, ri, gameNo - 1);
    }, (e) => { this.hud.toast(e && e.message === 'file' ? '回放需要通过网址打开（在线版或本地服务器）' : `读取比赛清单失败：${e.message}`, 'error'); return false; });
  }

  _clearReport() {
    this.reports[this.editing] = null;
    this._showReport();
  }
  /** 把正在编辑的这一座的上一战损毁标记交给编辑器 */
  _showReport() {
    const rep = this.reports[this.editing];
    this.editor.setBattleReport(rep);
    this.hud.setReport(rep && rep.broken.size ? { count: rep.broken.size } : null);
  }

  setTool(tool) {
    if (this.state !== 'blueprint') return;
    this.editor.setTool(tool);
    this.hud.setTool(tool);
  }

  toggleFocus() {
    this.focus = this.focus === 'field' ? 'build' : 'field';
    const pad = padFor(this.state === 'blueprint' ? 'blueprint' : 'battle', this.view.w);
    this.view.animateTo(this.view.fitTarget(this.focus === 'field' ? this.view.fieldB : this.view.buildB, pad), 0.5);
    this.hud.setFocus(this.focus);
  }

  // ------------------------------------------------------------ 开战 / 返回
  /** @returns {boolean} 是否真的开战了 */
  startBattle(isReplay = false) {
    if (this.state !== 'blueprint') return false;
    this._replayGen++;      // 无论是自己开战还是开始一局回放，之前没到的回放请求都作废
    this.editor.cancel();   // 先了结进行中的拖动，保证校验的和拿去模拟的是同一张蓝图
    const spec = this.spectate;
    if (!spec) {
      // 回放的堡垒在比赛时已经过检查；自己打的，两边都要在预算以内
      const two = this.rival === 'human';
      for (const seat of [0, 1]) {
        const over = this.forts[seat].cost() - this.map.budget;
        if (over <= 0) continue;
        const who = two ? SEAT_NAMES[seat] + ' ' : seat ? '对手的堡垒' : '';
        this.hud.toast(`${who}超出预算 $${over.toLocaleString()}，先拆掉一些再开战`, 'error');
        this.audio.ui('error');
        return false;
      }
    }
    this.audio.unlock();
    this.editor.setEnabled(false);
    this.sim = spec
      ? new Sim(spec.a, spec.b, { seed: spec.seed, rules: spec.rules, map: spec.map })
      : new Sim(this.forts[0], this.forts[1], { seed: CFG.seed ?? 20261115, map: this.map });
    this.acc = 0;
    this.paused = false;
    this.resultTimer = -1;
    this._collect = [0, 1].map(() => ({ broken: new Map(), peak: new Map(), order: 0 }));
    this.structure.build(this.sim);
    this.structure.setStressView(this.stressView);
    this.fx.clear();
    if (!isReplay) {
      // 记住蓝图里的取景，返回时还原；重播时镜头不动
      this._bpView = { cx: this.view.cx, cy: this.view.cy, ppm: this.view.ppm };
      this._bpFocus = this.focus;
      this.focus = 'field';            // 实景一律从全景开始，指示也跟着切到「全景」
      this.hud.setFocus('field');
      this.view.animateTo(this.view.fitTarget(this.view.fieldB, padFor('battle', this.view.w)), T_IN);
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
    this._replayGen++;
    const spec = this.spectate;
    if (!spec) this.reports = [this._makeReport(0), this.rival === 'human' ? this._makeReport(1) : null];   // 回放打的不是玩家的蓝图，不留战损标记
    this.state = 'toBlueprint';
    this.tr = 1 - unsmooth(this.blend);   // 过渡中途返回时，从当前画面平滑反向
    this.hud.hideResult();
    this.hud.setMode('blueprint');
    if (!spec) this._showReport();
    // 回到进战斗前的取景；窗口在战斗中改过大小时那份取景已失效，按当前模式重新取景
    this.focus = this._bpFocus || 'field';
    this.hud.setFocus(this.focus);
    // 回放可能换过场地：取景范围先换回玩家手上的这张图
    if (spec) this.view.setMap(this.map);
    const back = this._bpView || this.view.fitTarget(this.focus === 'field' ? this.view.fieldB : this.view.buildB, padFor('blueprint', this.view.w));
    this.view.animateTo(back, T_OUT);
    this.audio.ui('back');
    this.audio.stopBattle();
    if (spec) { this.arena.open(); return; }   // 从回放退出来，回到列表
    // 第一次输了回来，提示一下标记的含义和示例的去处（只提示一次）
    const mine = this.reports[0];
    if (this.rival !== 'human' && mine && mine.lost && mine.broken.size) {
      let seen = false;
      try { seen = !!localStorage.getItem(TIP_KEY); localStorage.setItem(TIP_KEY, '1'); } catch { /* 忽略 */ }
      if (!seen) this.hud.toast('编号是杆件失守的先后，1 号最先。想看一种能赢的搭法，点「示例」', 'info');
    }
  }

  // ------------------------------------------------------------ 对战回放（看 arena/ 里记录的比赛）
  openArena() {
    if (this.state !== 'blueprint' && this.state !== 'toBlueprint') return;
    this.editor.cancel();
    this.arena.open();
  }

  /** 这一局之后还有没有下一局（同一场比赛里按轮次、局数顺序）；有就返回 [轮下标, 局下标] */
  _nextGame(match, ri, gi) {
    if (gi + 1 < match.rounds[ri].games.length) return [ri, gi + 1];
    for (let r = ri + 1; r < match.rounds.length; r++) if (match.rounds[r].games.length) return [r, 0];
    return null;
  }

  playNext() {
    const sp = this.spectate;
    const nx = sp && this._nextGame(sp.match, sp.ri, sp.gi);
    if (nx) this.playRecorded(sp.match, nx[0], nx[1]);
  }

  /**
   * 观看记录里的一局：载入双方当轮的堡垒，用记录的种子和左右站位开战。
   * 不经过编辑器，玩家自己的蓝图和存档都不受影响。可以从蓝图界面开始，也可以在实景里直接切到另一局。
   * @returns {Promise<boolean>} 是否开始了
   */
  async playRecorded(match, ri, gi) {
    const round = match && match.rounds[ri], g = round && round.games[gi];
    if (!g) return false;
    if (this.state === 'toBlueprint') this._finishBack();   // 正在退回蓝图时点了另一局：直接收尾
    const from = this.state;
    if (from !== 'blueprint' && !(from === 'battle' && this.spectate)) return false;
    // 文件要等一会儿才到。这期间用户可能关掉列表、返回、重播、自己开一场，或者又点了另一局：
    // 只有代号没变（没人改主意）而且界面还停在原地，才真的开始
    const gen = ++this._replayGen;
    const fromSim = this.sim;
    try {
      const get = (f) => fetch(`arena/${match.id}/${f}`).then((r) => { if (!r.ok) throw new Error(`${f}（${r.status}）`); return r.json(); });
      const [fl, fr] = await Promise.all([get(round.forts[g.left]), get(round.forts[1 - g.left])]);
      if (gen !== this._replayGen || this.state !== from || this.sim !== fromSim) return false;
      // 比赛记录带着自己的规则版本：堡垒的合法性和战斗结算都按当时的规则来，回放才会和记录一致
      const rules = match.rules || 'v1';
      // 记录里没写地图的是 2026-11 的老比赛，都打在「海峡」上
      const M = getMap(match.map || 'strait');
      const a = loadFort(fl, 'player', rules, M), b = loadFort(fr, 'enemy', rules, M);
      const names = [shortName(match.players[g.left]), shortName(match.players[1 - g.left])];
      const caption = `第 ${round.round} 轮 · 第 ${gi + 1} 局`;
      // 记录里的胜者是选手下标，换成这一局里的左（player）右（enemy）
      const record = { winner: g.winner == null ? null : g.winner === g.left ? 'player' : 'enemy', seconds: g.seconds };
      const inBattle = from === 'battle';
      if (inBattle) { this._teardownBattle(); this.state = 'blueprint'; }
      this.spectate = { a, b, seed: g.seed, rules, map: M, names, caption, record, match, ri, gi };
      this._showMap(M);
      this.hud.setSpectate({ names, caption, hasNext: !!this._nextGame(match, ri, gi) });
      this.arena.close();
      if (!this.startBattle(inBattle)) {
        this._endSpectate();
        if (inBattle) { this.blend = 0; this.hud.setMode('blueprint'); this.editor.setEnabled(true); }
        return false;
      }
      if (inBattle) { this.state = 'battle'; this.blend = 1; this.tr = 1; }   // 已经在实景里，跳过镜头过渡
      return true;
    } catch (e) {
      if (gen === this._replayGen) this.hud.toast(`读取回放失败：${e && e.message ? e.message : e}`, 'error');
      return false;
    }
  }

  _endSpectate() {
    this.spectate = null;
    this.hud.setSpectate(null);
    this._showMap(this.map);   // 回放可能换过场地：换回玩家手上的这张图
  }

  /** 退回蓝图的过渡结束（或被提前收尾）：丢掉这场模拟，交还编辑器 */
  _finishBack() {
    this.state = 'blueprint'; this.blend = 0;
    this._teardownBattle();
    this.editor.setEnabled(true);
    if (this.spectate) this._endSpectate();
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

  /** 某个座位这一战的损毁记录。lost：这个座位是不是输了 */
  _makeReport(seat) {
    const c = this._collect && this._collect[seat];
    if (!c) return null;
    const w = this.sim ? this.sim.winner : null;
    return { broken: c.broken, peak: c.peak, winner: w, lost: w === (seat ? 'player' : 'enemy') };
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
      if (e.type === 'break' && e.cause !== 'sunk' && !this._collect[e.side].broken.has(e.bpId)) {
        // 模拟里的一根构件可能对应蓝图里几段共线的杆：一起标上同一个序号
        const col = this._collect[e.side];
        const info = { order: ++col.order, cause: e.cause, t: sim.time };
        for (const id of e.bpIds || [e.bpId]) col.broken.set(id, info);
      } else if (e.type === 'fightStart' && !this.spectate) {
        const mine = this.rival === 'human' ? [0, 1] : [0];
        const stuck = sim.cannons.filter((c) => mine.includes(c.side) && c.alive && c.grounded).length;
        if (stuck) this.hud.toast(`有 ${stuck} 门炮的炮座贴在地面上，开不了火`, 'error');
      } else if (e.type === 'end') {
        this.resultTimer = RESULT_DELAY;
      }
    }
    evs.length = 0;
  }

  _trackPeaks(sim) {
    const beams = sim.beams;
    for (let i = 0; i < beams.length; i++) {
      const b = beams[i];
      if (!b.alive) continue;
      const peak = this._collect[b.side].peak;
      for (const id of b.bpIds) { if (b.stressVis > (peak.get(id) || 0)) peak.set(id, b.stressVis); }
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
      if (this.tr >= 1) this._finishBack();
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
            // 回放理应和比赛记录一模一样；不同浏览器的数学库有细微差别时可能走样，这时如实标出来
            const rec = this.spectate && this.spectate.record;
            const off = rec && (rec.winner !== (sim.winner === 'player' || sim.winner === 'enemy' ? sim.winner : null) || Math.abs(rec.seconds - sim.fightTime) > 0.11);
            const recWho = off ? (rec.winner === 'player' ? this.spectate.names[0] + ' 胜' : rec.winner === 'enemy' ? this.spectate.names[1] + ' 胜' : '平局') : '';
            this.hud.showResult({
              winner: sim.winner, reason: sim.endReason, time: sim.fightTime,
              stats: sim.stats, playerHp: hp(sim.cores[0]), enemyHp: hp(sim.cores[1]), hpMax: sim.cores[0].hpMax,
              note: off ? `这个浏览器算出的结果和比赛记录不同，记录是 ${recWho}、${rec.seconds} 秒` : '',
            });
            this.audio.ui(this.spectate || this.rival === 'human' || sim.winner === 'player' ? 'win' : sim.winner === 'enemy' ? 'lose' : 'draw');
          } else {
            this.resultTimer = 1e-6;   // 镜头过渡还没结束就分出了胜负：等进入实景再弹结算
          }
        }
      }
    }

    // 画面
    this.world.setBlend(this.blend);
    // 回放打的不是蓝图上那两座堡垒，所以过渡时不让蓝图画布和实景叠在一起：直接看实景从正视推成透视
    const hideBp = !!this.spectate;
    if (this.blend > 0.001 || hideBp) {  // 蓝图完全盖住实景时，水面和旗子不必白算
      this.world.update(dt, now / 1000);
      this.world.render();
    }
    const bpAlpha = hideBp ? 0 : 1 - smooth((this.blend - 0.08) / 0.6);
    this.bpCanvas.style.opacity = bpAlpha.toFixed(3);
    this.bpCanvas.style.visibility = bpAlpha > 0.001 ? 'visible' : 'hidden';
    if (bpAlpha > 0.001) { if (this.state === 'mapedit') this.mapEditor.draw(dt); else this.editor.draw(dt); }

    requestAnimationFrame((t) => this.frame(t));
  }

  // ------------------------------------------------------------ 输入
  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.view.resize(w, h);
    this.world.resize(w, h, dpr);
    this.editor.resize(w, h, dpr);
    this.mapEditor.resize(w, h, dpr);
    // 窗口尺寸变了就按当前取景模式重新取景（地图编辑器自己取景）
    if (this._sized && this.state !== 'mapedit') {
      const battle = this.state === 'battle' || this.state === 'toBattle';
      const b = battle || this.focus === 'field' ? this.view.fieldB : this.view.buildB;
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
      if (this.arena.isOpen) {           // 回放列表开着时，键盘只管关掉它
        if (e.code === 'Escape') { e.preventDefault(); this.arena.dismiss(); }
        return;
      }
      if (this.setup.isOpen) {           // 地图 / 对手面板同理
        if (e.code === 'Escape') { e.preventDefault(); this.setup.close(); }
        return;
      }
      if (this.state === 'mapedit') {
        if (e.code === 'Escape') { e.preventDefault(); this.closeMapEditor(null); }
        return;
      }
      if (this.state === 'blueprint') {
        if (mod && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) this.editor.redo(); else this.editor.undo(); return; }
        if (mod && e.code === 'KeyY') { e.preventDefault(); this.editor.redo(); return; }
        if (mod && e.code === 'KeyS') { e.preventDefault(); this._downloadFort(); return; }
        if (mod) return;
        if (TOOL_KEYS[e.code]) { this.setTool(TOOL_KEYS[e.code]); return; }
        if (e.code === 'Enter') { e.preventDefault(); this.startBattle(); return; }
        if (e.code === 'Tab' && this.rival === 'human') { e.preventDefault(); this.setEditing(1 - this.editing); return; }
        if (e.code === 'Escape') { this.editor.cancel(); return; }
        if (e.code === 'Delete' || e.code === 'Backspace') { e.preventDefault(); this.editor.deleteHovered(); return; }
      } else if (this.state === 'battle' || this.state === 'toBattle') {
        if (mod) return;
        if (e.code === 'Escape' || e.code === 'Backspace') { e.preventDefault(); this.backToBlueprint(); return; }
        if (e.code === 'Space') { e.preventDefault(); this.togglePause(); return; }
        if (e.code === 'KeyR') { this.replay(); return; }
        if (e.code === 'KeyN' && this.spectate) { this.playNext(); return; }
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
