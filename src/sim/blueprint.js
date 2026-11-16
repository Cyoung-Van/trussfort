// 蓝图：堡垒的唯一数据源。编辑器只改蓝图；开战时由蓝图生成一份物理模拟，
// 退回蓝图界面时模拟被丢弃，蓝图原样保留。
// 坐标一律是己方本地坐标（朝 +x 开火），敌方在进入世界时镜像。

import { CFG, MATERIALS, CANNON } from '../config.js';
import { getRules } from '../rules.js';
import { getMap } from '../map.js';

const EPS = 1e-6;
const DEG = Math.PI / 180;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const hasMat = (m) => typeof m === 'string' && Object.prototype.hasOwnProperty.call(MATERIALS, m);

export class Blueprint {
  /**
   * @param rules 规则版本号或规则对象，不传就是当前版本（见 rules.js）。决定炮座规则和计价方式
   * @param map   地图名字或地图数据，不传就是默认地图（见 map.js）。决定地形、锚点、建造范围和核心范围
   */
  constructor(side = 'player', rules, map) {
    this.side = side;
    this.rules = getRules(rules);
    this.map = getMap(map);
    this.nodes = new Map();   // id → {id, x, y, kind: 'free' | 'anchor' | 'core'}
    this.beams = new Map();   // id → {id, a, b, mat}
    this.cannons = new Map(); // id → {id, beam, angle}（弧度，本地坐标，0 = 水平朝敌方）
    this._next = 1;
    this.reset();
  }

  /** 清空为只有锚点和核心的初始状态 */
  reset() {
    this.nodes.clear(); this.beams.clear(); this.cannons.clear();
    this._next = 1;
    for (const [x, y] of this.map.anchors) this._putNode(x, y, 'anchor');
    this._putNode(this.map.core[0], this.map.core[1], 'core');
  }

  _putNode(x, y, kind) {
    const id = this._next++;
    this.nodes.set(id, { id, x, y, kind });
    return id;
  }

  // ---------- 查询 ----------
  nodeAt(x, y) {
    for (const n of this.nodes.values()) {
      if (Math.abs(n.x - x) < 1e-4 && Math.abs(n.y - y) < 1e-4) return n;
    }
    return null;
  }
  coreNode() { for (const n of this.nodes.values()) if (n.kind === 'core') return n; return null; }
  beamBetween(a, b) {
    for (const bm of this.beams.values()) {
      if ((bm.a === a && bm.b === b) || (bm.a === b && bm.b === a)) return bm;
    }
    return null;
  }
  beamsOf(nodeId) {
    const out = [];
    for (const bm of this.beams.values()) if (bm.a === nodeId || bm.b === nodeId) out.push(bm);
    return out;
  }
  cannonOn(beamId) {
    for (const c of this.cannons.values()) if (c.beam === beamId) return c;
    return null;
  }
  beamLength(bm) {
    const a = this.nodes.get(bm.a), b = this.nodes.get(bm.b);
    return Math.hypot(b.x - a.x, b.y - a.y);
  }
  /** 一根杆的材料费（不含装配费） */
  beamCost(bm) { return Math.round(MATERIALS[bm.mat].cost * this.beamLength(bm)); }
  /** 两点间用某种材料新造一根杆的价格，含装配费（编辑器拖拽预览用，按当前规则） */
  static priceFor(mat, x1, y1, x2, y2) {
    return Math.round(MATERIALS[mat].cost * Math.hypot(x2 - x1, y2 - y1)) + getRules().assemblyFee;
  }
  /** 装配费：每根「构件」收一次。共线合并后的几段算一根构件 */
  assemblyCost() {
    const fee = this.rules.assemblyFee;
    return fee ? fee * this.mergeGroups().length : 0;
  }
  cost() {
    let c = 0;
    for (const bm of this.beams.values()) c += this.beamCost(bm);
    c += this.assemblyCost();
    c += this.cannons.size * CANNON.cost;
    return c;
  }
  breakdown() {
    const out = { wood: 0, steel: 0, rope: 0, spring: 0, assembly: this.assemblyCost(), cannon: this.cannons.size * CANNON.cost };
    for (const bm of this.beams.values()) out[bm.mat] += this.beamCost(bm);
    return out;
  }

  /**
   * 把蓝图里的杆件归并成「构件」：同材质、共线、中间那个节点没有别的连接也没有装置、
   * 合并后不超过该材料的最长限制的相邻杆件，算作一根构件（计价只收一次装配费，模拟里是一根杆、一份耐久）。
   * 这样把一根直杆切成几段既不会多收钱，也不会白得好几份耐久。规则不要求合并时，每根杆自己是一根构件。
   * @returns {{ids:number[], a:number, b:number, mat:string, len:number}[]} a、b 是构件两端的节点 id
   */
  mergeGroups(rules = this.rules) {
    const of = new Map();
    for (const bm of this.beams.values()) of.set(bm.id, { ids: [bm.id], a: bm.a, b: bm.b, mat: bm.mat, len: this.beamLength(bm) });
    if (rules.mergeCollinear) {
      // 按位置排好再处理，结果不依赖搭建先后
      const mids = [...this.nodes.values()].filter((n) => n.kind === 'free').sort((p, q) => p.x - q.x || p.y - q.y);
      for (const n of mids) {
        const bs = this.beamsOf(n.id);
        if (bs.length !== 2) continue;
        const [b1, b2] = bs;
        if (b1.mat !== b2.mat || this.cannonOn(b1.id) || this.cannonOn(b2.id)) continue;
        const g1 = of.get(b1.id), g2 = of.get(b2.id);
        if (g1 === g2) continue;
        const e1 = g1.a === n.id ? g1.b : g1.a, e2 = g2.a === n.id ? g2.b : g2.a;
        const p1 = this.nodes.get(e1), p2 = this.nodes.get(e2);
        const ux = p1.x - n.x, uy = p1.y - n.y, vx = p2.x - n.x, vy = p2.y - n.y;
        if (Math.abs(ux * vy - uy * vx) > 1e-6 || ux * vx + uy * vy >= 0) continue;   // 不共线，或者折回去了
        if (g1.len + g2.len > MATERIALS[b1.mat].maxLen + 1e-4) continue;
        const g = { ids: [...g1.ids, ...g2.ids], a: e1, b: e2, mat: b1.mat, len: g1.len + g2.len };
        for (const id of g.ids) of.set(id, g);
      }
    }
    return [...new Set(of.values())];
  }

  /**
   * 线段 (x1,y1)-(x2,y2) 是否和某根已有杆件有一段叠在同一条线上（只共用一个端点不算）。
   * skip 是要忽略的杆件 id 集合。返回叠上的那根杆，或 null。
   */
  _overlapping(x1, y1, x2, y2, skip) {
    const dx = x2 - x1, dy = y2 - y1;
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) return null;
    const ux = dx / L, uy = dy / L;
    for (const bm of this.beams.values()) {
      if (skip && skip.has(bm.id)) continue;
      const a = this.nodes.get(bm.a), b = this.nodes.get(bm.b);
      // 两个端点都在这条直线上才算共线
      if (Math.abs((a.x - x1) * uy - (a.y - y1) * ux) > 1e-6 || Math.abs((b.x - x1) * uy - (b.y - y1) * ux) > 1e-6) continue;
      const ta = (a.x - x1) * ux + (a.y - y1) * uy, tb = (b.x - x1) * ux + (b.y - y1) * uy;
      if (Math.min(L, Math.max(ta, tb)) - Math.max(0, Math.min(ta, tb)) > 1e-6) return bm;
    }
    return null;
  }

  // ---------- 校验 ----------
  /** 返回 null 表示可放置，否则返回原因（给玩家看的中文短语） */
  checkNodePos(x, y) {
    if (!isNum(x) || !isNum(y)) return '坐标无效';
    const B = this.map.build;
    if (x < B.xMin - EPS || x > B.xMax + EPS || y < B.yMin - EPS || y > B.yMax + EPS) return '超出建造区';
    if (this.map.inside(x, y)) return '不能建在山体里';
    return null;
  }
  /** 核心能不能放在这里。规则不允许挪核心时，只有地图的默认位置合法。返回 null 或原因 */
  checkCorePos(x, y) {
    if (!isNum(x) || !isNum(y)) return '坐标无效';
    const M = this.map;
    if (!this.rules.coreZone) return Math.abs(x - M.core[0]) < 1e-6 && Math.abs(y - M.core[1]) < 1e-6 ? null : '这套规则下核心不能移动';
    const g = CFG.grid;
    if (Math.abs(x / g - Math.round(x / g)) > 1e-6 || Math.abs(y / g - Math.round(y / g)) > 1e-6) return '核心要放在网格点上';
    const Z = M.coreZone;
    if (x < Z.xMin - EPS || x > Z.xMax + EPS || y < Z.yMin - EPS || y > Z.yMax + EPS) return '超出核心范围';
    if (M.inside(x, y)) return '核心不能放在山体里';
    if (M.onSurface(x, y)) return '核心不能贴着地面';
    if (M.hasWater && y <= M.waterY + EPS) return '核心不能放在水面以下';
    return null;
  }
  /** 检查两点之间能否用该材料连杆（不看是否已有节点）。返回 null 或原因 */
  checkSpan(mat, x1, y1, x2, y2) {
    if (!hasMat(mat)) return '未知材料';
    if (!isNum(x1) || !isNum(y1) || !isNum(x2) || !isNum(y2)) return '坐标无效';
    const m = MATERIALS[mat];
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < 0.5) return '太短';
    if (len > m.maxLen + 1e-4) return `${m.name}最长 ${m.maxLen} 米`;
    if (this.map.segCrosses(x1, y1, x2, y2)) return '不能穿过山体';
    return null;
  }
  _checkCannonBeam(mat, x1, y1, x2, y2) {
    if (!CANNON.mountMats.includes(mat)) return '火炮只能架在木杆或钢梁上';
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < CANNON.minBeamLen - 1e-4) return '炮座杆件太短';
    const slope = Math.abs(Math.atan2(y2 - y1, Math.abs(x2 - x1))) / DEG;
    if (slope > CANNON.maxSlopeDeg + 1e-4) return '炮座杆件太陡';
    return null;
  }
  /** 炮座两端的位置规则：后坐力必须由自己搭的结构承担，不能直接交给锚点或地面。ka、kb 是两端节点的类型 */
  _checkCannonEnds(ka, x1, y1, kb, x2, y2) {
    const R = this.rules;
    if (!R.anchorMounts && (ka === 'anchor' || kb === 'anchor')) return '炮座不能接在锚点上';
    if (!R.groundMounts && (this.map.onSurface(x1, y1) || this.map.onSurface(x2, y2))) return '炮座不能贴着地面';
    return null;
  }

  /** 这根杆上能不能架炮。返回 null 或原因（不检查数量上限时传 ignoreLimit=true） */
  checkCannonMount(beamId, ignoreLimit = false) {
    const bm = this.beams.get(beamId);
    if (!bm) return '杆件不存在';
    if (this.cannonOn(beamId)) return '这根杆上已经有火炮';
    if (!ignoreLimit && this.cannons.size >= this.map.maxCannons) return `最多 ${this.map.maxCannons} 门火炮`;
    const a = this.nodes.get(bm.a), b = this.nodes.get(bm.b);
    return this._checkCannonBeam(bm.mat, a.x, a.y, b.x, b.y) || this._checkCannonEnds(a.kind, a.x, a.y, b.kind, b.x, b.y);
  }

  // ---------- 修改（都返回 {ok, id?, reason?}） ----------
  addNode(x, y) {
    const hit = this.nodeAt(x, y);
    if (hit) return { ok: true, id: hit.id, existed: true };
    const why = this.checkNodePos(x, y);
    if (why) return { ok: false, reason: why };
    return { ok: true, id: this._putNode(x, y, 'free'), existed: false };
  }

  addBeam(a, b, mat) {
    if (a === b) return { ok: false, reason: '同一个节点' };
    const na = this.nodes.get(a), nb = this.nodes.get(b);
    if (!na || !nb) return { ok: false, reason: '节点不存在' };
    if (!hasMat(mat)) return { ok: false, reason: '未知材料' };
    if (this.beamBetween(a, b)) return { ok: false, reason: '这里已经有杆件' };
    const why = this.checkSpan(mat, na.x, na.y, nb.x, nb.y);
    if (why) return { ok: false, reason: why };
    if (this.rules.noOverlap && this._overlapping(na.x, na.y, nb.x, nb.y)) return { ok: false, reason: '和已有杆件重叠' };
    const id = this._next++;
    this.beams.set(id, { id, a, b, mat });
    return { ok: true, id };
  }

  removeBeam(id) {
    const bm = this.beams.get(id);
    if (!bm) return { ok: false, reason: '杆件不存在' };
    const c = this.cannonOn(id);
    if (c) this.cannons.delete(c.id);
    this.beams.delete(id);
    this._pruneNode(bm.a); this._pruneNode(bm.b);
    return { ok: true };
  }

  _pruneNode(id) {
    const n = this.nodes.get(id);
    if (n && n.kind === 'free' && this.beamsOf(id).length === 0) this.nodes.delete(id);
  }

  removeNode(id) {
    const n = this.nodes.get(id);
    if (!n) return { ok: false, reason: '节点不存在' };
    if (n.kind !== 'free') return { ok: false, reason: n.kind === 'core' ? '核心不能拆' : '锚点不能拆' };
    for (const bm of this.beamsOf(id)) {
      const c = this.cannonOn(bm.id);
      if (c) this.cannons.delete(c.id);
      this.beams.delete(bm.id);
      const other = bm.a === id ? bm.b : bm.a;
      this._pruneNode(other);
    }
    this.nodes.delete(id);
    return { ok: true };
  }

  /** 拖动节点。任何相连杆件超长 / 穿山 / 炮座失效都会拒绝。核心只能在地图给的核心范围里挪（规则允许时） */
  moveNode(id, x, y) {
    const n = this.nodes.get(id);
    if (!n) return { ok: false, reason: '节点不存在' };
    if (n.kind === 'anchor') return { ok: false, reason: '锚点不能移动' };
    if (Math.abs(n.x - x) < 1e-6 && Math.abs(n.y - y) < 1e-6) return { ok: true };   // 原地不动总是可以的（旧规则下带着 core 字段的堡垒描述也能读）
    if (n.kind === 'core' && !this.rules.coreZone) return { ok: false, reason: '核心不能移动' };
    const why = n.kind === 'core' ? this.checkCorePos(x, y) : this.checkNodePos(x, y);
    if (why) return { ok: false, reason: why };
    const hit = this.nodeAt(x, y);
    if (hit && hit.id !== id) return { ok: false, reason: '那里已经有节点' };
    for (const bm of this.beamsOf(id)) {
      const o = this.nodes.get(bm.a === id ? bm.b : bm.a);
      const w2 = this.checkSpan(bm.mat, x, y, o.x, o.y);
      if (w2) return { ok: false, reason: w2 };
      if (this.cannonOn(bm.id)) {
        const w3 = this._checkCannonBeam(bm.mat, x, y, o.x, o.y) || this._checkCannonEnds(n.kind, x, y, o.kind, o.x, o.y);
        if (w3) return { ok: false, reason: w3 };
      }
    }
    if (this.rules.noOverlap) {
      // 拖动后相连的杆件不能和别的杆叠到一条线上（包括同一个节点上的两根杆被拖成同向）
      const ox = n.x, oy = n.y;
      n.x = x; n.y = y;
      let clash = false;
      for (const bm of this.beamsOf(id)) {
        const o = this.nodes.get(bm.a === id ? bm.b : bm.a);
        if (this._overlapping(x, y, o.x, o.y, new Set([bm.id]))) { clash = true; break; }
      }
      if (clash) { n.x = ox; n.y = oy; return { ok: false, reason: '和已有杆件重叠' }; }
      return { ok: true };
    }
    n.x = x; n.y = y;
    return { ok: true };
  }

  /** 把核心放到 (x, y)。和拖动核心节点是一回事 */
  setCore(x, y) { return this.moveNode(this.coreNode().id, x, y); }

  setBeamMat(id, mat) {
    const bm = this.beams.get(id);
    if (!bm) return { ok: false, reason: '杆件不存在' };
    if (!hasMat(mat)) return { ok: false, reason: '未知材料' };
    if (bm.mat === mat) return { ok: true, same: true };
    const a = this.nodes.get(bm.a), b = this.nodes.get(bm.b);
    const why = this.checkSpan(mat, a.x, a.y, b.x, b.y);
    if (why) return { ok: false, reason: why };
    if (this.cannonOn(id) && !CANNON.mountMats.includes(mat)) return { ok: false, reason: '上面架着火炮，不能换成这种材料' };
    bm.mat = mat;
    return { ok: true };
  }

  addCannon(beamId, angle = 45 * DEG) {
    if (!isNum(angle)) return { ok: false, reason: '射角无效' };
    const bm = this.beams.get(beamId);
    if (!bm) return { ok: false, reason: '杆件不存在' };
    if (this.cannonOn(beamId)) return { ok: false, reason: '这根杆上已经有火炮' };
    if (this.cannons.size >= this.map.maxCannons) return { ok: false, reason: `最多 ${this.map.maxCannons} 门火炮` };
    const a = this.nodes.get(bm.a), b = this.nodes.get(bm.b);
    const why = this._checkCannonBeam(bm.mat, a.x, a.y, b.x, b.y) || this._checkCannonEnds(a.kind, a.x, a.y, b.kind, b.x, b.y);
    if (why) return { ok: false, reason: why };
    const id = this._next++;
    this.cannons.set(id, { id, beam: beamId, angle: clampAngle(angle) });
    return { ok: true, id };
  }
  /**
   * 拆掉不符合当前炮座规则的火炮（读取旧规则下保存的蓝图时用），返回拆掉的数量。
   * 只动火炮，杆件原样保留。
   */
  dropIllegalCannons() {
    let n = 0;
    for (const c of [...this.cannons.values()]) {
      const bm = this.beams.get(c.beam);
      const a = bm && this.nodes.get(bm.a), b = bm && this.nodes.get(bm.b);
      if (!a || !b) continue;   // 数据本身坏了，交给 validate 去报
      if (this._checkCannonBeam(bm.mat, a.x, a.y, b.x, b.y) || this._checkCannonEnds(a.kind, a.x, a.y, b.kind, b.x, b.y)) { this.cannons.delete(c.id); n++; }
    }
    return n;
  }
  removeCannon(id) {
    if (!this.cannons.has(id)) return { ok: false, reason: '火炮不存在' };
    this.cannons.delete(id);
    return { ok: true };
  }
  setCannonAngle(id, angle) {
    const c = this.cannons.get(id);
    if (!c) return { ok: false, reason: '火炮不存在' };
    if (!isNum(angle)) return { ok: false, reason: '射角无效' };
    c.angle = clampAngle(angle);
    return { ok: true };
  }

  /** 火炮在蓝图姿态下的几何：炮耳轴、炮口、炮座方向。本地坐标 */
  cannonPose(c) {
    const bm = this.beams.get(c.beam);
    const a = this.nodes.get(bm.a), b = this.nodes.get(bm.b);
    return cannonPoseFrom(a.x, a.y, b.x, b.y, c.angle);
  }

  // ---------- 序列化 ----------
  toJSON() {
    return {
      v: 1,
      next: this._next,
      nodes: [...this.nodes.values()].map(n => [n.id, n.x, n.y, n.kind]),
      beams: [...this.beams.values()].map(b => [b.id, b.a, b.b, b.mat]),
      cannons: [...this.cannons.values()].map(c => [c.id, c.beam, +(c.angle / DEG).toFixed(3)]),
    };
  }
  static fromJSON(o, side = 'player', rules, map) {
    const bp = new Blueprint(side, rules, map);
    bp.nodes.clear(); bp.beams.clear(); bp.cannons.clear();
    for (const [id, x, y, kind] of o.nodes) bp.nodes.set(id, { id, x, y, kind });
    for (const [id, a, b, mat] of o.beams) bp.beams.set(id, { id, a, b, mat });
    for (const [id, beam, deg] of o.cannons) bp.cannons.set(id, { id, beam, angle: deg * DEG });
    bp._next = o.next;
    return bp;
  }
  clone(side = this.side) { return Blueprint.fromJSON(this.toJSON(), side, this.rules, this.map); }

  /**
   * 完整性检查（读取存档后用）：锚点齐全且在原位、核心在允许的位置、节点不重叠且位置合法、
   * 杆件和火炮都满足建造规则。返回 null 表示合法，否则返回第一条问题。
   * 同时把 id 分配器校正到最大 id 之后。
   */
  validate() {
    const seen = new Set();
    let maxId = 0;
    const ids = new Set();
    for (const n of this.nodes.values()) {
      if (!Number.isInteger(n.id) || n.id < 1 || ids.has(n.id)) return '节点 id 无效';
      ids.add(n.id); maxId = Math.max(maxId, n.id);
      if (!isNum(n.x) || !isNum(n.y)) return '节点坐标无效';
      const key = `${Math.round(n.x * 1000)},${Math.round(n.y * 1000)}`;
      if (seen.has(key)) return '节点重叠';
      seen.add(key);
      if (n.kind === 'free') { const w = this.checkNodePos(n.x, n.y); if (w) return w; }
      else if (n.kind !== 'anchor' && n.kind !== 'core') return '节点类型无效';
    }
    const M = this.map;
    for (const [x, y] of M.anchors) { const n = this.nodeAt(x, y); if (!n || n.kind !== 'anchor') return '缺少锚点'; }
    const core = this.coreNode();
    if (!core) return '缺少核心';
    const cw = this.checkCorePos(core.x, core.y);
    if (cw) return cw === '这套规则下核心不能移动' ? '缺少核心' : cw;
    let fixed = 0; for (const n of this.nodes.values()) if (n.kind !== 'free') fixed++;
    if (fixed !== M.anchors.length + 1) return '锚点或核心数量不对';
    const pairs = new Set();
    for (const bm of this.beams.values()) {
      if (!Number.isInteger(bm.id) || bm.id < 1 || ids.has(bm.id)) return '杆件 id 无效';
      ids.add(bm.id); maxId = Math.max(maxId, bm.id);
      const a = this.nodes.get(bm.a), b = this.nodes.get(bm.b);
      if (!a || !b || a === b) return '杆件端点无效';
      const pk = bm.a < bm.b ? `${bm.a}-${bm.b}` : `${bm.b}-${bm.a}`;
      if (pairs.has(pk)) return '重复的杆件';
      pairs.add(pk);
      const w = this.checkSpan(bm.mat, a.x, a.y, b.x, b.y);
      if (w) return w;
      if (this.rules.noOverlap && this._overlapping(a.x, a.y, b.x, b.y, new Set([bm.id]))) return '有杆件重叠';
    }
    if (this.cannons.size > M.maxCannons) return '火炮太多';
    const mounts = new Set();
    for (const c of this.cannons.values()) {
      if (!Number.isInteger(c.id) || c.id < 1 || ids.has(c.id)) return '火炮 id 无效';
      ids.add(c.id); maxId = Math.max(maxId, c.id);
      const bm = this.beams.get(c.beam);
      if (!bm || mounts.has(c.beam) || !isNum(c.angle)) return '火炮无效';
      mounts.add(c.beam);
      const a = this.nodes.get(bm.a), b = this.nodes.get(bm.b);
      const w = this._checkCannonBeam(bm.mat, a.x, a.y, b.x, b.y) || this._checkCannonEnds(a.kind, a.x, a.y, b.kind, b.x, b.y);
      if (w) return w;
      c.angle = clampAngle(c.angle);
    }
    this._next = maxId + 1;
    return null;
  }
  /** 就地替换全部内容（撤销 / 重做 / 载入示例用），对象引用保持不变 */
  load(o) {
    if (!o) return this;          // 没有数据就什么也不做，绝不能先清空再报错
    const src = o instanceof Blueprint ? o.toJSON() : o;
    this.nodes.clear(); this.beams.clear(); this.cannons.clear();
    for (const [id, x, y, kind] of src.nodes) this.nodes.set(id, { id, x, y, kind });
    for (const [id, a, b, mat] of src.beams) this.beams.set(id, { id, a, b, mat });
    for (const [id, beam, deg] of src.cannons) this.cannons.set(id, { id, beam, angle: deg * DEG });
    this._next = src.next;
    return this;
  }

  /**
   * 用紧凑描述搭一座堡垒（给预设堡垒和测试用）：
   *   core:    [x, y]            —— 可选，核心放在哪（不写就是地图的默认位置）
   *   nodes:   { 名字: [x, y] }   —— 坐标恰好落在锚点 / 核心上的会自动复用
   *   beams:   [[名字A, 名字B, 材料], ...]
   *   cannons: [[名字A, 名字B, 射角度数], ...]
   * 任何一步不合法都抛错，保证预设数据不会悄悄坏掉。
   */
  static build(spec, side = 'player', rules, map) {
    const bp = new Blueprint(side, rules, map);
    const ids = {};
    if (spec.core) { const r = bp.setCore(spec.core[0], spec.core[1]); if (!r.ok) throw new Error(`核心 (${spec.core}): ${r.reason}`); }
    for (const [name, [x, y]] of Object.entries(spec.nodes)) {
      const r = bp.addNode(x, y);
      if (!r.ok) throw new Error(`节点 ${name} (${x},${y}): ${r.reason}`);
      ids[name] = r.id;
    }
    for (const [a, b, mat] of spec.beams) {
      if (!(a in ids) || !(b in ids)) throw new Error(`杆件 ${a}-${b}: 未定义的节点`);
      const r = bp.addBeam(ids[a], ids[b], mat);
      if (!r.ok) throw new Error(`杆件 ${a}-${b}: ${r.reason}`);
    }
    for (const [a, b, deg] of spec.cannons || []) {
      const bm = bp.beamBetween(ids[a], ids[b]);
      if (!bm) throw new Error(`火炮 ${a}-${b}: 没有这根杆`);
      const r = bp.addCannon(bm.id, deg * DEG);
      if (!r.ok) throw new Error(`火炮 ${a}-${b}: ${r.reason}`);
    }
    return bp;
  }
}

function clampAngle(a) {
  const lo = CANNON.angleMin * DEG, hi = CANNON.angleMax * DEG;
  return Math.min(hi, Math.max(lo, a));
}

/**
 * 由炮座杆件两端点和射角算出火炮几何。模拟和蓝图共用这一份，保证预览和实战一致。
 * 返回 { px, py 炮耳轴; mx, my 炮口; angle 炮管方向; beamAngle; up 炮在杆件哪一侧(+1/-1); rel 炮管相对杆件的夹角 }
 */
export function cannonPoseFrom(ax, ay, bx, by, angle) {
  const beamAngle = Math.atan2(by - ay, bx - ax);
  let nx = -Math.sin(beamAngle), ny = Math.cos(beamAngle);
  let up = 1;
  if (ny < 0) { nx = -nx; ny = -ny; up = -1; }
  const cx = (ax + bx) / 2, cy = (ay + by) / 2;
  const px = cx + nx * CANNON.pivotH, py = cy + ny * CANNON.pivotH;
  return {
    px, py,
    mx: px + Math.cos(angle) * CANNON.barrelLen,
    my: py + Math.sin(angle) * CANNON.barrelLen,
    angle, beamAngle, up, rel: angle - beamAngle,
  };
}
