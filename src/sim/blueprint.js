// 蓝图：堡垒的唯一数据源。编辑器只改蓝图；开战时由蓝图生成一份物理模拟，
// 退回蓝图界面时模拟被丢弃，蓝图原样保留。
// 坐标一律是己方本地坐标（朝 +x 开火），敌方在进入世界时镜像。

import { CFG, MATERIALS, CANNON } from '../config.js';

const EPS = 1e-6;
const DEG = Math.PI / 180;

export function insideCliffLocal(x, y) { return x < -EPS && y < -EPS; }

// 线段是否穿过山体内部（开区域 x<0 且 y<0）。精确解：先求线段落在 x<0 一侧的参数区间，再看这段里 y 的最小值
function segCrossesCliff(x1, y1, x2, y2) {
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  if (Math.abs(dx) < 1e-12) { if (!(x1 < -EPS)) return false; }
  else {
    const tc = (-EPS - x1) / dx;         // x(t) = -EPS 处
    if (dx > 0) t1 = Math.min(t1, tc); else t0 = Math.max(t0, tc);
    if (t0 >= t1) return false;
  }
  const ya = y1 + dy * t0, yb = y1 + dy * t1;
  // 端点恰在边界上不算穿过，所以用区间中点再确认一次
  if (Math.min(ya, yb) >= -EPS) return false;
  const tm = (t0 + t1) / 2;
  const lo = ya < yb ? t0 : t1;
  const ts = lo + (tm - lo) * 1e-6;       // 紧贴最低端的内点
  return insideCliffLocal(x1 + dx * ts, y1 + dy * ts) || insideCliffLocal(x1 + dx * tm, y1 + dy * tm);
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const hasMat = (m) => typeof m === 'string' && Object.prototype.hasOwnProperty.call(MATERIALS, m);

export class Blueprint {
  constructor(side = 'player') {
    this.side = side;
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
    for (const [x, y] of CFG.anchors) this._putNode(x, y, 'anchor');
    this._putNode(CFG.corePos[0], CFG.corePos[1], 'core');
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
  beamCost(bm) { return Math.round(MATERIALS[bm.mat].cost * this.beamLength(bm)); }
  /** 两点间用某种材料造一根杆的价格（编辑器拖拽预览用） */
  static priceFor(mat, x1, y1, x2, y2) {
    return Math.round(MATERIALS[mat].cost * Math.hypot(x2 - x1, y2 - y1));
  }
  cost() {
    let c = 0;
    for (const bm of this.beams.values()) c += this.beamCost(bm);
    c += this.cannons.size * CANNON.cost;
    return c;
  }
  breakdown() {
    const out = { wood: 0, steel: 0, rope: 0, spring: 0, cannon: this.cannons.size * CANNON.cost };
    for (const bm of this.beams.values()) out[bm.mat] += this.beamCost(bm);
    return out;
  }

  // ---------- 校验 ----------
  /** 返回 null 表示可放置，否则返回原因（给玩家看的中文短语） */
  checkNodePos(x, y) {
    if (!isNum(x) || !isNum(y)) return '坐标无效';
    const B = CFG.build;
    if (x < B.xMin - EPS || x > B.xMax + EPS || y < B.yMin - EPS || y > B.yMax + EPS) return '超出建造区';
    if (insideCliffLocal(x, y)) return '不能建在山体里';
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
    if (segCrossesCliff(x1, y1, x2, y2)) return '不能穿过山体';
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

  /** 这根杆上能不能架炮。返回 null 或原因（不检查数量上限时传 ignoreLimit=true） */
  checkCannonMount(beamId, ignoreLimit = false) {
    const bm = this.beams.get(beamId);
    if (!bm) return '杆件不存在';
    if (this.cannonOn(beamId)) return '这根杆上已经有火炮';
    if (!ignoreLimit && this.cannons.size >= CFG.maxCannons) return `最多 ${CFG.maxCannons} 门火炮`;
    const a = this.nodes.get(bm.a), b = this.nodes.get(bm.b);
    return this._checkCannonBeam(bm.mat, a.x, a.y, b.x, b.y);
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

  /** 拖动节点。任何相连杆件超长 / 穿山 / 炮座失效都会拒绝 */
  moveNode(id, x, y) {
    const n = this.nodes.get(id);
    if (!n) return { ok: false, reason: '节点不存在' };
    if (n.kind !== 'free') return { ok: false, reason: n.kind === 'core' ? '核心不能移动' : '锚点不能移动' };
    if (Math.abs(n.x - x) < 1e-6 && Math.abs(n.y - y) < 1e-6) return { ok: true };
    const why = this.checkNodePos(x, y);
    if (why) return { ok: false, reason: why };
    const hit = this.nodeAt(x, y);
    if (hit && hit.id !== id) return { ok: false, reason: '那里已经有节点' };
    for (const bm of this.beamsOf(id)) {
      const o = this.nodes.get(bm.a === id ? bm.b : bm.a);
      const w2 = this.checkSpan(bm.mat, x, y, o.x, o.y);
      if (w2) return { ok: false, reason: w2 };
      if (this.cannonOn(bm.id)) {
        const w3 = this._checkCannonBeam(bm.mat, x, y, o.x, o.y);
        if (w3) return { ok: false, reason: w3 };
      }
    }
    n.x = x; n.y = y;
    return { ok: true };
  }

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
    if (this.cannons.size >= CFG.maxCannons) return { ok: false, reason: `最多 ${CFG.maxCannons} 门火炮` };
    const a = this.nodes.get(bm.a), b = this.nodes.get(bm.b);
    const why = this._checkCannonBeam(bm.mat, a.x, a.y, b.x, b.y);
    if (why) return { ok: false, reason: why };
    const id = this._next++;
    this.cannons.set(id, { id, beam: beamId, angle: clampAngle(angle) });
    return { ok: true, id };
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
  static fromJSON(o, side = 'player') {
    const bp = new Blueprint(side);
    bp.nodes.clear(); bp.beams.clear(); bp.cannons.clear();
    for (const [id, x, y, kind] of o.nodes) bp.nodes.set(id, { id, x, y, kind });
    for (const [id, a, b, mat] of o.beams) bp.beams.set(id, { id, a, b, mat });
    for (const [id, beam, deg] of o.cannons) bp.cannons.set(id, { id, beam, angle: deg * DEG });
    bp._next = o.next;
    return bp;
  }
  clone(side = this.side) { return Blueprint.fromJSON(this.toJSON(), side); }

  /**
   * 完整性检查（读取存档后用）：锚点和核心齐全且在原位、节点不重叠且位置合法、
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
    for (const [x, y] of CFG.anchors) { const n = this.nodeAt(x, y); if (!n || n.kind !== 'anchor') return '缺少锚点'; }
    const core = this.nodeAt(CFG.corePos[0], CFG.corePos[1]);
    if (!core || core.kind !== 'core') return '缺少核心';
    let fixed = 0; for (const n of this.nodes.values()) if (n.kind !== 'free') fixed++;
    if (fixed !== CFG.anchors.length + 1) return '锚点或核心数量不对';
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
    }
    if (this.cannons.size > CFG.maxCannons) return '火炮太多';
    const mounts = new Set();
    for (const c of this.cannons.values()) {
      if (!Number.isInteger(c.id) || c.id < 1 || ids.has(c.id)) return '火炮 id 无效';
      ids.add(c.id); maxId = Math.max(maxId, c.id);
      const bm = this.beams.get(c.beam);
      if (!bm || mounts.has(c.beam) || !isNum(c.angle)) return '火炮无效';
      mounts.add(c.beam);
      const a = this.nodes.get(bm.a), b = this.nodes.get(bm.b);
      const w = this._checkCannonBeam(bm.mat, a.x, a.y, b.x, b.y);
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
   *   nodes:   { 名字: [x, y] }   —— 坐标恰好落在锚点 / 核心上的会自动复用
   *   beams:   [[名字A, 名字B, 材料], ...]
   *   cannons: [[名字A, 名字B, 射角度数], ...]
   * 任何一步不合法都抛错，保证预设数据不会悄悄坏掉。
   */
  static build(spec, side = 'player') {
    const bp = new Blueprint(side);
    const ids = {};
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
