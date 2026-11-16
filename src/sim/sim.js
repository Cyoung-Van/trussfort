// 桁架物理模拟（不依赖浏览器，可在 node 里无头运行）。
//
// 模型：节点是质点，杆件是带柔度的距离约束，用 XPBD + 小子步求解（每子步一遍 Gauss-Seidel）。
// 每根杆的约束乘子 λ 直接给出轴力：T = -λ / h²（拉为正）。这个数同时驱动变色和崩断，
// 所以「看起来红」和「真的要断」永远一致。
//
// 确定性：固定步长、固定遍历顺序、带种子的随机数。同一对蓝图 + 同一个种子，结果逐位相同。

import { CFG, MATERIALS, CANNON, CORE, worldX, worldAngle } from '../config.js';
import { cannonPoseFrom } from './blueprint.js';
import { makeRng } from './rng.js';
import { getRules } from '../rules.js';

const DEG = Math.PI / 180;

function smooth01(t) { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }
function wrapPi(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }

export class Sim {
  /**
   * @param {Blueprint} bpPlayer 左侧（玩家）蓝图
   * @param {Blueprint} bpEnemy  右侧（敌方）蓝图，本地坐标，这里做镜像
   * @param {{seed?:number, peace?:boolean, rules?:string|object}} opts peace=true 时永不开火、不判胜负（只看结构受力）；
   *   rules 是规则版本（见 rules.js），不传就用左侧蓝图自带的版本
   */
  constructor(bpPlayer, bpEnemy, opts = {}) {
    this.R = opts.rules ? getRules(opts.rules) : bpPlayer.rules || getRules();
    this.seed = opts.seed ?? 20261115;
    this.peace = !!opts.peace;
    this.rng = makeRng(this.seed);

    this.time = 0;         // 模拟总时间（含沉降阶段）
    this.frame = 0;
    this.fightTime = 0;    // 交火阶段已进行的时间
    this.phase = 'settle'; // 'settle' → 'fight' → 'ended'
    this.winner = null;    // 'player' | 'enemy' | 'draw'
    this.endReason = null; // 'coreDestroyed' | 'coreSunk' | 'timeout' | 'stalemate'
    this.endTime = 0;
    this.events = [];      // 由外部每帧取走并清空
    this.stats = [
      { shots: 0, hits: 0, beamsLost: 0, cannonsLost: 0 },
      { shots: 0, hits: 0, beamsLost: 0, cannonsLost: 0 },
    ];

    this.beams = [];
    this.cannons = [];
    this.shells = [];
    this.cores = [null, null];
    this.nodeBeams = [];
    this._shellId = 1;
    this._sub = 0;
    this._stale = 0;
    this._gscale = 0;
    this._damp = CFG.settleDamping;
    this._toBreak = [];

    const n = bpPlayer.nodes.size + bpEnemy.nodes.size;
    this.n = n;
    this.x = new Float64Array(n); this.y = new Float64Array(n);
    this.px = new Float64Array(n); this.py = new Float64Array(n);
    this.vx = new Float64Array(n); this.vy = new Float64Array(n);
    this.w = new Float64Array(n);      // 逆质量，锚点为 0
    this.mass = new Float64Array(n);
    this.alive = new Uint8Array(n);
    this.fixed = new Uint8Array(n);
    this.side = new Uint8Array(n);
    this.wet = new Uint8Array(n);
    this.contact = new Uint8Array(n);  // 0 无接触, 1 顶面 / 海床, 2 崖壁
    this.nodeBpId = new Int32Array(n);
    // 上一帧的位置快照：画面可在两帧之间插值（慢动作、高刷新率屏幕）
    this.ox = new Float64Array(n); this.oy = new Float64Array(n);

    let off = this._addFort(bpPlayer, 0, 0);
    this._addFort(bpEnemy, 1, off);
    for (let i = 0; i < n; i++) this._refreshNode(i);
    for (const c of this.cannons) { this._poseCannon(c); c.opx = c.px; c.opy = c.py; c.oangle = c.angle; }
    this.ox.set(this.x); this.oy.set(this.y);
  }

  // ------------------------------------------------------------------ 构建
  _addFort(bp, side, off) {
    const map = new Map();
    let i = off;
    // 节点、杆件、火炮都按几何位置排成固定顺序再进模拟。
    // 求解器按顺序逐根处理约束，顺序不同结果会有细微差别；这样同一个形状不管是按什么先后搭出来的，
    // 打出来的结果都一样（玩家拆了重搭同一根杆，不该换一个结局）。
    const nodes = [...bp.nodes.values()].sort((p, q) => p.x - q.x || p.y - q.y);
    for (const nd of nodes) {
      this.x[i] = this.px[i] = worldX(side, nd.x);
      this.y[i] = this.py[i] = nd.y;
      this.fixed[i] = nd.kind === 'anchor' ? 1 : 0;
      this.alive[i] = 1;
      this.side[i] = side;
      this.nodeBpId[i] = nd.id;
      this.nodeBeams[i] = [];
      map.set(nd.id, i);
      if (nd.kind === 'core') {
        this.cores[side] = { side, node: i, hp: CORE.hp, hpMax: CORE.hp, alive: true, sunk: false, lastHit: -10 };
      }
      i++;
    }
    const beamIdx = new Map();
    const rank = (bm) => { const p = map.get(bm.a), q = map.get(bm.b); return p < q ? [p, q] : [q, p]; };
    // 进模拟的是「构件」：规则要求时，同材质共线的几段杆合成一根（见 Blueprint.mergeGroups）；
    // 被合并掉的中间节点没有杆件连着，下面 _refreshNode 会把它当孤立节点移除
    // 归并按这场模拟的规则来（不是蓝图自带的），排序把材料也算进去：端点相同的两根构件也有确定的先后
    const beamList = bp.mergeGroups(this.R).sort((u, v) => { const ru = rank(u), rv = rank(v); return ru[0] - rv[0] || ru[1] - rv[1] || (u.mat < v.mat ? -1 : u.mat > v.mat ? 1 : 0); });
    for (const bm of beamList) {
      const a = map.get(bm.a), b = map.get(bm.b);
      const mat = MATERIALS[bm.mat];
      const rest = Math.hypot(this.x[a] - this.x[b], this.y[a] - this.y[b]);
      const beam = {
        idx: this.beams.length, bpId: bm.ids[0], bpIds: bm.ids, side, a, b, mat, matId: bm.mat,
        rest, compliance: rest / mat.EA, beta: mat.beta, tensionOnly: mat.tensionOnly, mass: mat.density * rest,
        alive: true, hp: mat.hp, hpMax: mat.hp,
        slack: false,  // 绳索当前是否松弛
        touch: false,  // 杆件中段是否正搭在地形上（见地形碰撞那一步）
        lam: 0,        // 本子步的约束乘子
        f: 0,          // 滤波后的轴力 N（拉为正）
        stress: 0,     // 当前受力 / 极限
        stressVis: 0,  // 给画面用：瞬间升到峰值、缓慢回落，保证后坐和冲击的闪红看得见
        _smax: 0,
      };
      this.beams.push(beam);
      this.nodeBeams[a].push(beam.idx);
      this.nodeBeams[b].push(beam.idx);
      for (const id of bm.ids) beamIdx.set(id, beam.idx);
    }
    let k = 0;
    const cannonList = [...bp.cannons.values()].sort((u, v) => beamIdx.get(u.beam) - beamIdx.get(v.beam));
    for (const c of cannonList) {
      const bi = beamIdx.get(c.beam);
      const b = this.beams[bi];
      const pose = cannonPoseFrom(this.x[b.a], this.y[b.a], this.x[b.b], this.y[b.b], worldAngle(side, c.angle));
      this.cannons.push({
        idx: this.cannons.length, bpId: c.id, side, beam: bi,
        rel: pose.rel, up: pose.up, designAngle: pose.angle,
        alive: true, hp: CANNON.hp, hpMax: CANNON.hp,
        cool: CANNON.firstDelay + k * CANNON.stagger + (side === 1 ? CANNON.enemyOffset : 0),
        shots: 0,
        recoil: 0,     // 画面用的后坐动画量：开火瞬间置 1，随后回落到 0
        px: pose.px, py: pose.py, mx: pose.mx, my: pose.my, angle: pose.angle,
        tilt: 0,       // 炮管当前方向相对设计方向的偏差（弧度）
        grounded: false, // 炮座节点正贴着地面（规则不允许时，这门炮不能开火）
        lastHit: -10,
      });
      k++;
    }
    return i;
  }

  _refreshNode(i) {
    if (!this.alive[i]) return;
    let m = CFG.nodeMass;
    let nAlive = 0;
    const nb = this.nodeBeams[i];
    for (let k = 0; k < nb.length; k++) {
      const b = this.beams[nb[k]];
      if (b.alive) { m += 0.5 * b.mass; nAlive++; }
    }
    for (const c of this.cannons) {
      if (!c.alive) continue;
      const b = this.beams[c.beam];
      if (b.a === i || b.b === i) m += 0.5 * CANNON.mass;
    }
    const core = this.cores[this.side[i]];
    const isLiveCore = core && core.node === i && core.alive;
    if (isLiveCore) m += CORE.mass;
    this.mass[i] = m;
    this.w[i] = this.fixed[i] ? 0 : 1 / m;
    if (nAlive === 0 && !isLiveCore && !this.fixed[i]) this.alive[i] = 0; // 孤立节点直接移除
  }

  _refreshAround(i) { this._refreshNode(i); }

  _poseCannon(c) {
    const b = this.beams[c.beam];
    const ax = this.x[b.a], ay = this.y[b.a], bx = this.x[b.b], by = this.y[b.b];
    const phi = Math.atan2(by - ay, bx - ax);
    const nx = -Math.sin(phi) * c.up, ny = Math.cos(phi) * c.up;
    c.px = (ax + bx) / 2 + nx * CANNON.pivotH;
    c.py = (ay + by) / 2 + ny * CANNON.pivotH;
    c.angle = phi + c.rel;
    c.mx = c.px + Math.cos(c.angle) * CANNON.barrelLen;
    c.my = c.py + Math.sin(c.angle) * CANNON.barrelLen;
    c.tilt = wrapPi(c.angle - c.designAngle);
  }

  // ------------------------------------------------------------------ 主循环
  /** 推进一帧（CFG.dt 秒） */
  step() {
    const dt = CFG.dt, N = CFG.substeps, h = dt / N;
    this.ox.set(this.x); this.oy.set(this.y);
    for (const c of this.cannons) { c.opx = c.px; c.opy = c.py; c.oangle = c.angle; }
    for (const s of this.shells) { s.ox = s.x; s.oy = s.y; }
    if (this.phase === 'settle' && !this.peace && this.time >= CFG.settleTime) {
      this.phase = 'fight';
      this.events.push({ type: 'fightStart' });
    }
    this._gscale = smooth01(this.time / CFG.gravityRamp);
    this._damp = this.time < CFG.settleTime ? CFG.settleDamping : CFG.airDamping;
    for (let s = 0; s < N; s++) this._substep(h);
    this._updateCannons(dt);
    this._finishFrame(dt);
    this.time += dt;
    this.frame++;
  }

  _substep(h) {
    const x = this.x, y = this.y, px = this.px, py = this.py, vx = this.vx, vy = this.vy;
    const w = this.w, alive = this.alive, n = this.n;
    const beams = this.beams, nb = beams.length;
    const W = CFG.fieldW, waterY = CFG.waterY;
    const g = CFG.gravity * this._gscale;
    const damp = Math.exp(-this._damp * h);
    const wdamp = Math.exp(-CFG.waterDrag * h);
    const gw = g * CFG.waterGravity;

    // 1) 预测
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      if (w[i] === 0) { px[i] = x[i]; py[i] = y[i]; continue; }
      let vxi = vx[i], vyi = vy[i];
      if (y[i] < waterY) { vyi -= gw * h; vxi *= wdamp; vyi *= wdamp; }
      else { vyi -= g * h; vxi *= damp; vyi *= damp; }
      px[i] = x[i]; py[i] = y[i];
      x[i] += vxi * h; y[i] += vyi * h;
    }

    // 2) 杆件约束（正反交替遍历，抵消 Gauss-Seidel 的方向偏差）
    const invH2 = 1 / (h * h), invH = 1 / h;
    const fwd = (this._sub & 1) === 0;
    for (let k = 0; k < nb; k++) {
      const b = beams[fwd ? k : nb - 1 - k];
      if (!b.alive) continue;
      const i = b.a, j = b.b;
      const wi = w[i], wj = w[j], ws = wi + wj;
      if (ws === 0) { b.lam = 0; continue; }
      const dx = x[i] - x[j], dy = y[i] - y[j];
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1e-9) { b.lam = 0; continue; }
      const C = len - b.rest;
      if (b.tensionOnly && C <= 0) { b.lam = 0; b.slack = true; continue; }
      const nx = dx / len, ny = dy / len;
      const at = b.compliance * invH2;
      let dl = -C / (ws + at);
      x[i] += wi * dl * nx; y[i] += wi * dl * ny;
      x[j] -= wj * dl * nx; y[j] -= wj * dl * ny;
      b.lam = dl; b.slack = false;
    }

    // 3) 地形碰撞
    const contact = this.contact;
    const seabed = CFG.seabedY;
    for (let i = 0; i < n; i++) {
      if (!alive[i] || w[i] === 0) continue;
      let c = 0;
      const yi = y[i];
      if (yi < 0) {
        const xi = x[i];
        if (xi < 0) { if (-yi <= -xi) { y[i] = 0; c = 1; } else { x[i] = 0; c = 2; } }
        else if (xi > W) { if (-yi <= xi - W) { y[i] = 0; c = 1; } else { x[i] = W; c = 2; } }
        if (y[i] < seabed) { y[i] = seabed; c = 1; }
      }
      contact[i] = c;
    }
    if ((this._sub & 1) === 0) {
      // 杆件中点也不许陷进山体（搭在崖角上的残骸）
      for (let k = 0; k < nb; k++) {
        const b = beams[k];
        if (!b.alive) continue;
        const i = b.a, j = b.b;
        if (w[i] + w[j] === 0) continue;
        b.touch = false;
        const my = (y[i] + y[j]) * 0.5;
        if (my >= 0) continue;
        const mx = (x[i] + x[j]) * 0.5;
        let dx = 0, dy = 0;
        if (mx < 0) { if (-my <= -mx) dy = -my; else dx = -mx; }
        else if (mx > W) { if (-my <= mx - W) dy = -my; else dx = W - mx; }
        else continue;
        b.touch = true;
        if (w[i] > 0) { x[i] += dx; y[i] += dy; }
        if (w[j] > 0) { x[j] += dx; y[j] += dy; }
      }
    }

    // 4) 由位置反推速度 + 摩擦 + 入水
    const fr = Math.exp(-CFG.groundFriction * h);
    const frWall = Math.exp(-2 * h);
    for (let i = 0; i < n; i++) {
      if (!alive[i] || w[i] === 0) continue;
      let vxi = (x[i] - px[i]) * invH, vyi = (y[i] - py[i]) * invH;
      if (contact[i] === 1) vxi *= fr; else if (contact[i] === 2) vyi *= frWall;
      vx[i] = vxi; vy[i] = vyi;
      if (y[i] < waterY) {
        if (!this.wet[i]) {
          this.wet[i] = 1;
          if (vyi < -1.2) {
            const p = this.mass[i] * -vyi / 900;
            this.events.push({ type: 'splash', x: x[i], y: waterY, power: p < 0.15 ? 0.15 : p > 1 ? 1 : p, side: this.side[i] });
          }
        }
        if (y[i] < CFG.killY) this._killNode(i);
      }
    }

    // 5) 杆件阻尼（速度层面，隐式）+ 轴力读数、滤波、超载崩断
    // 阻尼只作用在杆件的伸缩速率上：静平衡时速度为零，所以完全不影响静力精度；
    // 也不阻碍整体平动 / 转动，残骸照常自由下落。
    const a = h / (CFG.stressTau + h);
    const toBreak = this._toBreak;
    for (let k = 0; k < nb; k++) {
      const b = beams[fwd ? k : nb - 1 - k];
      if (!b.alive) continue;
      const i = b.a, j = b.b;
      const wi = w[i], wj = w[j], ws = wi + wj;
      let T = -b.lam * invH2;
      if (ws > 0 && !(b.tensionOnly && b.lam === 0)) {
        const dx = x[i] - x[j], dy = y[i] - y[j];
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 1e-9) {
          const nx = dx / len, ny = dy / len;
          const vrel = nx * (vx[i] - vx[j]) + ny * (vy[i] - vy[j]);
          const c = b.beta / b.compliance;            // c = β·k
          let p = -vrel * c * h / (1 + c * ws * h);    // 隐式：vrel' = vrel / (1 + c·ws·h)
          if (b.tensionOnly && p > 0) p = 0;           // 绳子不能推
          vx[i] += wi * p * nx; vy[i] += wi * p * ny;
          vx[j] -= wj * p * nx; vy[j] -= wj * p * ny;
          T -= p * invH;
        }
      }
      b.f += (T - b.f) * a;
      // 被炮火打伤的杆件承载力按剩余耐久折减（有下限）：受伤的承重杆会先变黄变红，再被自己扛着的力压断
      const cap = b.hp >= b.hpMax ? 1 : CFG.damagedStrength + (1 - CFG.damagedStrength) * Math.max(0, b.hp / b.hpMax);
      const s = b.f >= 0 ? b.f / (b.mat.strT * cap) : -b.f / (b.mat.strC * cap);
      b.stress = s;
      if (s > b._smax) b._smax = s;
      if (s >= 1) toBreak.push(b.idx);
    }
    if (toBreak.length) {
      for (let k = 0; k < toBreak.length; k++) this._breakBeam(toBreak[k], 'stress');
      toBreak.length = 0;
    }

    // 6) 炮弹（先把火炮位姿刷新到本子步，命中判定才不会用上一帧的位置）
    if (this.shells.length) {
      for (let k = 0; k < this.cannons.length; k++) if (this.cannons[k].alive) this._poseCannon(this.cannons[k]);
      this._stepShells(h);
    }

    this._sub++;
  }

  // ------------------------------------------------------------------ 破坏
  _breakBeam(bi, cause) {
    const b = this.beams[bi];
    if (!b.alive) return;
    b.alive = false;
    b.stress = 0; b.f = 0;
    this.stats[b.side].beamsLost++;
    const i = b.a, j = b.b;
    this.events.push({
      type: 'break', cause, side: b.side, beam: bi, bpId: b.bpId, bpIds: b.bpIds, mat: b.matId,
      x1: this.x[i], y1: this.y[i], x2: this.x[j], y2: this.y[j],
      vx1: this.vx[i], vy1: this.vy[i], vx2: this.vx[j], vy2: this.vy[j],
    });
    for (const c of this.cannons) if (c.alive && c.beam === bi) this._killCannon(c, 'fell');
    this._refreshAround(i);
    this._refreshAround(j);
  }

  _killNode(i) {
    if (!this.alive[i]) return;
    this.alive[i] = 0;
    const nbs = this.nodeBeams[i];
    for (let k = 0; k < nbs.length; k++) {
      const b = this.beams[nbs[k]];
      if (!b.alive) continue;
      b.alive = false; b.stress = 0; b.f = 0;
      // 跟着节点沉没的杆件：计入损失，并发一个 cause='sunk' 的事件（画面和音效不需要为它做什么）
      this.stats[b.side].beamsLost++;
      this.events.push({
        type: 'break', cause: 'sunk', side: b.side, beam: b.idx, bpId: b.bpId, bpIds: b.bpIds, mat: b.matId,
        x1: this.x[b.a], y1: this.y[b.a], x2: this.x[b.b], y2: this.y[b.b],
        vx1: this.vx[b.a], vy1: this.vy[b.a], vx2: this.vx[b.b], vy2: this.vy[b.b],
      });
      for (const c of this.cannons) if (c.alive && c.beam === b.idx) this._killCannon(c, 'sunk');
      this._refreshAround(b.a === i ? b.b : b.a);
    }
  }

  _killCannon(c, cause) {
    if (!c.alive) return;
    c.alive = false;
    this.stats[c.side].cannonsLost++;
    const b = this.beams[c.beam];
    this.events.push({
      type: 'cannonLost', cause, side: c.side, cannon: c.idx, bpId: c.bpId,
      x: c.px, y: c.py, angle: c.angle,
      vx: (this.vx[b.a] + this.vx[b.b]) * 0.5, vy: (this.vy[b.a] + this.vy[b.b]) * 0.5,
    });
    if (b.alive) { this._refreshAround(b.a); this._refreshAround(b.b); }
  }

  _destroyCore(core) {
    if (!core.alive) return;
    core.alive = false; core.hp = 0;
    const i = core.node;
    const cx = this.x[i], cy = this.y[i];
    this.events.push({ type: 'coreDestroyed', side: core.side, x: cx, y: cy });
    // 核心殉爆：重创周围结构
    this._blast(cx, cy, null, 220, 4.2, CFG.shell.impulse * 2.2, 5.0, null, null, this.R.blastOcclusion);
    this._refreshAround(i);
  }

  /** 爆点 (ex,ey) 到目标点 (tx,ty) 之间有没有别的杆件挡着。绳索太细不算；skip 是目标自己 */
  _blocked(ex, ey, tx, ty, skip) {
    const rx = tx - ex, ry = ty - ey;
    if (rx * rx + ry * ry < 0.12) return false;   // 贴脸的距离谈不上遮挡
    const x = this.x, y = this.y, beams = this.beams;
    for (let k = 0; k < beams.length; k++) {
      const b = beams[k];
      if (!b.alive || b === skip || b.tensionOnly) continue;
      const ax = x[b.a], ay = y[b.a], sx = x[b.b] - ax, sy = y[b.b] - ay;
      const den = rx * sy - ry * sx;
      if (den > -1e-9 && den < 1e-9) {
        // 平行。只有恰好躺在这条射线上的杆才可能挡：看它在射线上占的那一段是否落在中间
        if (Math.abs((ax - ex) * ry - (ay - ey) * rx) > 1e-6) continue;
        const rr = rx * rx + ry * ry;
        const t0 = ((ax - ex) * rx + (ay - ey) * ry) / rr, t1 = ((ax + sx - ex) * rx + (ay + sy - ey) * ry) / rr;
        if (Math.min(0.96, Math.max(t0, t1)) - Math.max(0.04, Math.min(t0, t1)) > 1e-6) return true;
        continue;
      }
      const t = ((ax - ex) * sy - (ay - ey) * sx) / den;   // 沿爆点→目标
      if (t <= 0.04 || t >= 0.96) continue;                 // 两头留一点余量：共用节点的邻杆不算挡
      const u = ((ax - ex) * ry - (ay - ey) * rx) / den;   // 沿挡路的杆
      if (u >= 0 && u <= 1) return true;
    }
    return false;
  }

  /**
   * 爆炸对杆件 / 节点 / 装置的作用。directBeam 已单独结算过直击伤害。
   * occlude=true 时，被别的杆件挡住的目标不吃溅射伤害（冲击波照常推动节点）。
   */
  _blast(ex, ey, directBeam, dmg0, R, imp, IR, skipCore = null, skipCannon = null, occlude = false) {
    const x = this.x, y = this.y, vx = this.vx, vy = this.vy, w = this.w, alive = this.alive;
    const beams = this.beams;
    const dead = [];
    for (let k = 0; k < beams.length; k++) {
      const b = beams[k];
      if (!b.alive) continue;
      if (b === directBeam) { if (b.hp <= 0) dead.push(k); continue; }
      const ax = x[b.a], ay = y[b.a], bx = x[b.b], by = y[b.b];
      if (ex < Math.min(ax, bx) - R || ex > Math.max(ax, bx) + R || ey < Math.min(ay, by) - R || ey > Math.max(ay, by) + R) continue;
      const sx = bx - ax, sy = by - ay;
      const l2 = sx * sx + sy * sy;
      let t = l2 > 0 ? ((ex - ax) * sx + (ey - ay) * sy) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const cx = ax + sx * t, cy = ay + sy * t;
      const d = Math.hypot(ex - cx, ey - cy);
      if (d >= R) continue;
      if (occlude && this._blocked(ex, ey, cx, cy, b)) continue;
      const f = 1 - d / R;
      b.hp -= dmg0 * f * f;
      if (b.hp <= 0) dead.push(k);
    }
    const maxKick = CFG.shell.maxKick;
    for (let i = 0; i < this.n; i++) {
      if (!alive[i] || w[i] === 0) continue;
      const dx = x[i] - ex, dy = y[i] - ey;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d >= IR) continue;
      let dv = imp * (1 - d / IR) * w[i];
      if (dv > maxKick) dv = maxKick;
      if (d > 1e-3) { vx[i] += dx / d * dv; vy[i] += dy / d * dv; } else vy[i] += dv;
    }
    for (const c of this.cannons) {
      if (!c.alive || c === skipCannon) continue;
      const dc = Math.hypot(c.px - ex, c.py - ey);
      const d = Math.max(0, dc - CANNON.radius);
      if (d >= R) continue;
      if (occlude && d > 0 && this._blocked(ex, ey, ex + (c.px - ex) * d / dc, ey + (c.py - ey) * d / dc, null)) continue;
      const f = 1 - d / R;
      this._damageCannon(c, dmg0 * f * f);
    }
    for (const core of this.cores) {
      if (!core || !core.alive || core === skipCore) continue;
      const dk = Math.hypot(x[core.node] - ex, y[core.node] - ey);
      const d = Math.max(0, dk - CORE.radius);
      if (d >= R) continue;
      if (occlude && d > 0 && this._blocked(ex, ey, ex + (x[core.node] - ex) * d / dk, ey + (y[core.node] - ey) * d / dk, null)) continue;
      const f = 1 - d / R;
      this._damageCore(core, dmg0 * f * f);
    }
    for (let k = 0; k < dead.length; k++) this._breakBeam(dead[k], 'blast');
  }

  _damageCore(core, dmg) {
    if (!core.alive || dmg <= 0) return;
    if (this.phase === 'ended') return; // 胜负已分，飞行中的炮弹不再改写结果
    core.hp -= dmg;
    core.lastHit = this.time;
    this.events.push({ type: 'coreHit', side: core.side, dmg, hp: Math.max(0, core.hp) });
    if (core.hp <= 0) this._destroyCore(core);
  }

  _damageCannon(c, dmg) {
    if (!c.alive || dmg <= 0) return;
    c.hp -= dmg;
    c.lastHit = this.time;
    if (c.hp <= 0) this._killCannon(c, 'destroyed');
  }

  // ------------------------------------------------------------------ 火炮与炮弹
  _updateCannons(dt) {
    for (const c of this.cannons) {
      if (!c.alive) continue;
      this._poseCannon(c);
      if (c.recoil > 0) c.recoil = Math.max(0, c.recoil - dt * 2.4);
      if (c.py < CFG.waterY) { this._killCannon(c, 'sunk'); continue; }
      if (!this.R.groundMounts) {
        const mb = this.beams[c.beam];
        // 炮座的任一端，或者杆件中段（悬在崖边、搭在崖角上的情况）碰着地形，都算贴地
        c.grounded = this.contact[mb.a] !== 0 || this.contact[mb.b] !== 0 || mb.touch;
      }
      if (this.phase !== 'fight') continue;
      c.cool -= dt;
      if (c.cool <= 0) {
        if (c.grounded) c.cool = 0;   // 炮座贴地：扣着不发，离地后立刻恢复
        else { this._fire(c); c.cool += CANNON.interval; }
      }
    }
  }

  _fire(c) {
    const S = CFG.shell;
    const b = this.beams[c.beam];
    const i = b.a, j = b.b;
    const ang = c.angle + (this.rng() * 2 - 1) * S.dispersion * DEG;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    const mvx = (this.vx[i] + this.vx[j]) * 0.5, mvy = (this.vy[i] + this.vy[j]) * 0.5;
    this.shells.push({
      id: this._shellId++, side: c.side, cannon: c.idx, mount: c.beam,
      x: c.px + dx * CANNON.barrelLen, y: c.py + dy * CANNON.barrelLen,
      ox: c.px + dx * CANNON.barrelLen, oy: c.py + dy * CANNON.barrelLen,
      vx: dx * S.speed + mvx, vy: dy * S.speed + mvy,
      age: 0, alive: true,
      dmg: S.directDamage,   // 这发炮弹还剩多少直击伤害可用（规则开启穿透时会被沿途的杆件逐步用掉）
      scored: false,         // 是否已经计过一次「命中」
    });
    // 后坐：冲量 P = -J·dir 作用在炮耳轴上（高出杆件 pivotH），
    // 静力等效分到两个端点：切向各半，法向带一个力偶 —— 所以平射时后脚压、前脚抬。
    const J = S.mass * S.speed * CANNON.recoil;
    const ex = this.x[j] - this.x[i], ey = this.y[j] - this.y[i];
    const L = Math.hypot(ex, ey) || 1;
    const tx = ex / L, ty = ey / L;
    const nx = -ty * c.up, ny = tx * c.up;
    const Pt = -J * (dx * tx + dy * ty), Pn = -J * (dx * nx + dy * ny);
    const couple = CANNON.pivotH * Pt / L;
    const an = Pn * 0.5 + couple, bn = Pn * 0.5 - couple, tt = Pt * 0.5;
    this.vx[i] += (tt * tx + an * nx) * this.w[i]; this.vy[i] += (tt * ty + an * ny) * this.w[i];
    this.vx[j] += (tt * tx + bn * nx) * this.w[j]; this.vy[j] += (tt * ty + bn * ny) * this.w[j];
    c.recoil = 1;
    c.shots++;
    this.stats[c.side].shots++;
    this.events.push({ type: 'fire', side: c.side, cannon: c.idx, x: c.px + dx * CANNON.barrelLen, y: c.py + dy * CANNON.barrelLen, angle: ang });
  }

  _stepShells(h) {
    const S = CFG.shell, g = CFG.gravity, W = CFG.fieldW;
    const x = this.x, y = this.y;
    const beams = this.beams;
    let anyDead = false;
    for (let si = 0; si < this.shells.length; si++) {
      const s = this.shells[si];
      if (!s.alive) { anyDead = true; continue; }
      s.vy -= g * h;
      s.x += s.vx * h; s.y += s.vy * h;
      s.age += h;
      if (s.y < CFG.waterY) {
        s.alive = false;
        this.events.push({ type: 'splash', x: s.x, y: CFG.waterY, power: 0.75, shell: true, side: s.side, cannon: s.cannon });
        continue;
      }
      if (s.y < 0 && (s.x < 0 || s.x > W)) { this._explode(s, null, null, null, 'ground'); continue; }
      if (s.x < -60 || s.x > W + 60 || s.y > 150) { s.alive = false; continue; }

      let done = false;
      for (const core of this.cores) {
        if (!core || !core.alive) continue;
        const dx = s.x - x[core.node], dy = s.y - y[core.node];
        const r = CORE.radius + S.radius;
        if (dx * dx + dy * dy < r * r) { this._explode(s, null, core, null, 'core'); done = true; break; }
      }
      if (done) continue;
      for (const c of this.cannons) {
        if (!c.alive) continue;
        if (c.idx === s.cannon && s.age < S.grace) continue;
        const dx = s.x - c.px, dy = s.y - c.py;
        const r = CANNON.radius + S.radius;
        if (dx * dx + dy * dy < r * r) { this._explode(s, null, null, c, 'cannon'); done = true; break; }
      }
      if (done) continue;
      const sx = s.x, sy = s.y;
      for (let k = 0; k < beams.length; k++) {
        const b = beams[k];
        if (!b.alive) continue;
        if (k === s.mount && s.age < S.grace) continue;
        const ax = x[b.a], ay = y[b.a], bx = x[b.b], by = y[b.b];
        const r = S.radius + b.mat.hitR;
        if (sx < (ax < bx ? ax : bx) - r || sx > (ax > bx ? ax : bx) + r) continue;
        if (sy < (ay < by ? ay : by) - r || sy > (ay > by ? ay : by) + r) continue;
        const ex = bx - ax, ey = by - ay;
        const l2 = ex * ex + ey * ey;
        let t = l2 > 0 ? ((sx - ax) * ex + (sy - ay) * ey) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = sx - (ax + ex * t), dy = sy - (ay + ey * t);
        if (dx * dx + dy * dy < r * r) {
          if (this._hitBeam(s, b)) break;   // 炮弹停在了这根杆上（引爆）
          // 否则：这根杆被打断，炮弹带着剩余伤害继续飞（本子步接着检查后面的杆件）
        }
      }
    }
    if (anyDead && (this._sub % 24) === 0) this.shells = this.shells.filter(s => s.alive);
  }

  /**
   * 炮弹碰到一根杆。不开穿透时直接引爆。开了穿透：
   * 杆件的耐久吃得下这一发（剩余耐久 >= 炮弹剩余伤害），就在这里引爆；吃不下，杆件被打断，炮弹按用掉的份额减速，带着剩下的伤害继续飞。
   * 伤害预算按动能算，所以速度按剩余份额的平方根缩；交给杆件的动量就是炮弹减掉的那部分，一发炮弹的冲量不会被重复使用。
   * @returns {boolean} 炮弹是否停在了这根杆上
   */
  _hitBeam(s, b) {
    if (!this.R.pierce || b.hp >= s.dmg) { this._explode(s, b, null, null, b.matId); return true; }
    const S = CFG.shell;
    const k = Math.sqrt((s.dmg - b.hp) / s.dmg);
    const px = S.mass * s.vx * (1 - k) * 0.5, py = S.mass * s.vy * (1 - k) * 0.5;
    const i = b.a, j = b.b;
    this.vx[i] += px * this.w[i]; this.vy[i] += py * this.w[i];
    this.vx[j] += px * this.w[j]; this.vy[j] += py * this.w[j];
    s.dmg -= b.hp; s.vx *= k; s.vy *= k;
    b.hp = 0;
    if (b.side !== s.side && !s.scored) { this.stats[s.side].hits++; s.scored = true; }
    this.events.push({ type: 'pierce', x: s.x, y: s.y, kind: b.matId, side: s.side, cannon: s.cannon, hitSide: b.side });
    this._breakBeam(b.idx, 'blast');
    return false;
  }

  _explode(s, beam, core, cannon, kind) {
    const S = CFG.shell;
    const direct = this.R.pierce ? s.dmg : S.directDamage;
    s.alive = false;
    const hitSide = beam ? beam.side : core ? core.side : cannon ? cannon.side : -1;
    if (hitSide >= 0 && hitSide !== s.side && !s.scored) { this.stats[s.side].hits++; s.scored = true; }
    this.events.push({ type: 'explode', x: s.x, y: s.y, kind, side: s.side, cannon: s.cannon, hitSide, vx: s.vx, vy: s.vy });
    if (beam) {
      beam.hp -= direct;
      // 炮弹动量传给被击中杆件的两个端点
      const i = beam.a, j = beam.b;
      const px = S.mass * s.vx * 0.5, py = S.mass * s.vy * 0.5;
      this.vx[i] += px * this.w[i]; this.vy[i] += py * this.w[i];
      this.vx[j] += px * this.w[j]; this.vy[j] += py * this.w[j];
    }
    if (core) {
      const i = core.node;
      this.vx[i] += S.mass * s.vx * this.w[i]; this.vy[i] += S.mass * s.vy * this.w[i];
    }
    if (cannon) {
      // 直击火炮：炮弹动量经炮座传给杆件两端
      const mb = this.beams[cannon.beam];
      if (mb.alive) {
        const px = S.mass * s.vx * 0.5, py = S.mass * s.vy * 0.5;
        this.vx[mb.a] += px * this.w[mb.a]; this.vy[mb.a] += py * this.w[mb.a];
        this.vx[mb.b] += px * this.w[mb.b]; this.vy[mb.b] += py * this.w[mb.b];
      }
    }
    // 先结算溅射，再结算直击（直击目标不重复吃溅射）
    this._blast(s.x, s.y, beam, S.blastDamage, S.blastRadius, S.impulse, S.impulseRadius, core, cannon, this.R.blastOcclusion);
    if (core) this._damageCore(core, direct);
    if (cannon) this._damageCannon(cannon, direct);
  }

  // ------------------------------------------------------------------ 帧末：显示量与胜负
  _finishFrame(dt) {
    const decay = Math.exp(-dt / 0.2);
    for (const b of this.beams) {
      if (!b.alive) continue;
      const v = b.stressVis * decay;
      b.stressVis = b._smax > v ? b._smax : v;
      b._smax = b.stress;
    }
    if (this.peace) return;

    for (const core of this.cores) {
      if (!core || !core.alive) continue;
      if (this.y[core.node] < CFG.waterY - 0.4) {
        core.alive = false; core.sunk = true;
        this.events.push({ type: 'coreSunk', side: core.side, x: this.x[core.node], y: CFG.waterY });
        this._refreshAround(core.node);
      }
    }
    if (this.phase === 'ended') return;

    const p = this.cores[0], e = this.cores[1];
    if (!p.alive || !e.alive) {
      const reason = (!p.alive && p.sunk) || (!e.alive && e.sunk) ? 'coreSunk' : 'coreDestroyed';
      this._end(!p.alive && !e.alive ? 'draw' : !p.alive ? 'enemy' : 'player', reason);
      return;
    }
    if (this.phase !== 'fight') return;
    this.fightTime += dt;
    if (this.fightTime >= this.R.battleTime) { this._endByHp('timeout'); return; }
    let armed = false;
    for (const c of this.cannons) if (c.alive && !c.grounded) { armed = true; break; }
    let flying = false;
    for (const s of this.shells) if (s.alive) { flying = true; break; }
    if (!armed && !flying) {
      this._stale += dt;
      if (this._stale >= CFG.stalemateTime) this._endByHp('stalemate');
    } else this._stale = 0;
  }

  _endByHp(reason) {
    const p = this.cores[0].hp, e = this.cores[1].hp;
    // 差距在规则给的幅度以内算平局（旧规则幅度为 0，只有完全相等才平）
    const margin = this.R.drawMargin * this.cores[0].hpMax;
    const tie = margin > 0 ? Math.abs(p - e) <= margin : Math.abs(p - e) < 1e-6;
    this._end(tie ? 'draw' : p > e ? 'player' : 'enemy', reason);
  }

  _end(winner, reason) {
    this.phase = 'ended';
    this.winner = winner;
    this.endReason = reason;
    this.endTime = this.time;
    this.events.push({ type: 'end', winner, reason });
  }

  // ------------------------------------------------------------------ 工具
  /** 剩余交火时间（秒） */
  get timeLeft() { return Math.max(0, this.R.battleTime - this.fightTime); }

  /** 状态指纹（确定性测试用） */
  hash() {
    let h = 0;
    for (let i = 0; i < this.n; i++) h = (h * 31 + this.x[i] * 1e6 + this.y[i] * 1e6) % 1e15;
    for (const b of this.beams) h = (h * 31 + (b.alive ? 1 : 0) + b.hp) % 1e15;
    h = (h * 31 + this.cores[0].hp * 7 + this.cores[1].hp * 13) % 1e15;
    return h;
  }

  /** 当前活着的杆件里最大的受力比 */
  maxStress(side = -1) {
    let m = 0;
    for (const b of this.beams) if (b.alive && (side < 0 || b.side === side) && b.stress > m) m = b.stress;
    return m;
  }
}
