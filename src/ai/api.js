// AI 对战接口：把「一份堡垒描述」变成蓝图、检查它、让两座堡垒打一场并给出可供改进的反馈。
// 不依赖浏览器，node 里直接 import 即可用；命令行封装见 tools/duel.mjs，说明见 AI.md。
//
// 堡垒描述（fort spec）用搭建者自己的本地坐标：永远朝 +x 开火，核心在 (4,3)，对方核心在 (fieldW-4, 3)。
// 所以同一份描述放在左边或右边都能用，右边由引擎自动镜像。

import { CFG, MATERIALS, MATERIAL_ORDER, CANNON, CORE } from '../config.js';
import { Blueprint } from '../sim/blueprint.js';
import { Sim } from '../sim/sim.js';
import { solveAngle, predictShot } from '../sim/ballistics.js';

const DEG = Math.PI / 180;
const FOE_CORE = [CFG.fieldW - CFG.corePos[0], CFG.corePos[1]];
const r3 = (v) => Math.round(v * 1000) / 1000;

/** 给 AI 看的规则（全部取自 config.js，不会和游戏本身脱节） */
export function rules() {
  return {
    units: '米，y 向上。本地坐标：己方崖顶 y=0（x<=0 是山体顶面），崖壁在 x=0，朝 +x 开火',
    field: { width: CFG.fieldW, waterY: CFG.waterY, foeCore: FOE_CORE },
    grid: CFG.grid,
    buildZone: CFG.build,
    forbidden: '节点不能在山体内部（x<0 且 y<0）；杆件不能穿过山体',
    anchors: CFG.anchors,
    core: { at: CFG.corePos, mass: CORE.mass, hp: CORE.hp, radius: CORE.radius, note: '核心固定在这里，是一个普通节点，必须靠杆件托住；耐久归零或落水即判负' },
    budget: CFG.budget,
    materials: MATERIAL_ORDER.map((id) => {
      const m = MATERIALS[id];
      return {
        id, costPerMeter: m.cost, massPerMeter: m.density, maxLength: m.maxLen,
        tensionLimitN: m.strT, compressionLimitN: Number.isFinite(m.strC) ? m.strC : null,
        hp: m.hp, tensionOnly: !!m.tensionOnly,
      };
    }),
    cannon: {
      cost: CANNON.cost, max: CFG.maxCannons, mass: CANNON.mass, hp: CANNON.hp,
      mountMaterials: CANNON.mountMats, minMountLength: CANNON.minBeamLen, maxMountSlopeDeg: CANNON.maxSlopeDeg,
      angleRangeDeg: [CANNON.angleMin, CANNON.angleMax], interval: CANNON.interval, firstShotDelay: CANNON.firstDelay,
      pivotHeight: CANNON.pivotH, barrelLength: CANNON.barrelLen,
      note: '火炮架在一根杆件的中点上方，自重平分到杆件两端；射角相对炮座杆件固定，炮座歪了炮口就跟着歪。后坐力是真实载荷',
    },
    shell: {
      speed: CFG.shell.speed, mass: CFG.shell.mass, gravity: CFG.gravity,
      directDamage: CFG.shell.directDamage, blastDamage: CFG.shell.blastDamage, blastRadius: CFG.shell.blastRadius,
      dispersionDeg: CFG.shell.dispersion,
      note: '所有杆件都挡炮弹（自家的也挡）。受伤的杆件承载力下降，可能被自己扛的力压断',
    },
    battle: {
      settleSeconds: CFG.settleTime, timeLimit: CFG.battleTime,
      win: '对方核心耐久归零或落水；到时未分胜负则核心剩余耐久多者胜',
      automatic: '开战后双方全自动，射角在蓝图里定好；同样的两座堡垒 + 同样的种子，结果完全相同',
    },
    physics: '铰接桁架：没有三角形支撑的方框是机构，会折叠。每根杆只受轴向拉压，超过极限即断',
  };
}

function fail(msg) { const e = new Error(msg); e.fortError = true; return e; }

/**
 * 把堡垒描述变成蓝图。接受三种写法：
 *   1. 坐标式（最适合 AI）：{ beams: [[[x1,y1],[x2,y2],"wood"], ...], cannons: [[[x1,y1],[x2,y2], 射角], ...] }
 *   2. 命名式：{ nodes: {名字:[x,y]}, beams: [["A","B","steel"], ...], cannons: [["A","B", 射角], ...] }
 *   3. 游戏存档格式（编辑器导出 / Blueprint.toJSON()）
 * 射角可以是数字（度，0 = 水平朝敌方），也可以是 { core:true, high:bool, dx, dy } 或 { at:[x,y], high:bool }，由引擎解算。
 * 任何不合规则的地方都会抛出带原因的错误。
 */
export function loadFort(desc, side = 'player') {
  if (!desc || typeof desc !== 'object') throw fail('堡垒描述必须是一个对象');
  if (desc instanceof Blueprint) return desc.clone(side);
  // 3. 存档格式
  if (Array.isArray(desc.nodes)) {
    let bp;
    try { bp = Blueprint.fromJSON(desc, side); } catch (e) { throw fail('存档格式无法解析：' + e.message); }
    const why = bp.validate();
    if (why) throw fail(why);
    return bp;
  }
  if (!Array.isArray(desc.beams)) throw fail('缺少 beams 数组');
  const bp = new Blueprint(side);
  const named = desc.nodes && typeof desc.nodes === 'object' ? desc.nodes : {};
  const ids = new Map();
  const nodeOf = (ref, what) => {
    let x, y, label;
    if (Array.isArray(ref)) { [x, y] = ref; label = `(${x},${y})`; }
    else if (typeof ref === 'string' && Object.prototype.hasOwnProperty.call(named, ref)) { [x, y] = named[ref]; label = ref; }
    else throw fail(`${what}：端点 ${JSON.stringify(ref)} 既不是 [x,y] 也不是已定义的节点名`);
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) throw fail(`${what}：端点 ${label} 的坐标无效`);
    if (Math.abs(x / CFG.grid - Math.round(x / CFG.grid)) > 1e-6 || Math.abs(y / CFG.grid - Math.round(y / CFG.grid)) > 1e-6) throw fail(`${what}：端点 ${label} 不在 ${CFG.grid} 米网格上`);
    const key = `${Math.round(x / CFG.grid)},${Math.round(y / CFG.grid)}`;
    if (ids.has(key)) return ids.get(key);
    const r = bp.addNode(Math.round(x / CFG.grid) * CFG.grid, Math.round(y / CFG.grid) * CFG.grid);
    if (!r.ok) throw fail(`${what}：端点 ${label} ${r.reason}`);
    ids.set(key, r.id);
    return r.id;
  };
  desc.beams.forEach((b, i) => {
    if (!Array.isArray(b) || b.length < 3) throw fail(`beams[${i}] 应为 [端点A, 端点B, 材料]`);
    const what = `beams[${i}]`;
    const r = bp.addBeam(nodeOf(b[0], what), nodeOf(b[1], what), b[2]);
    if (!r.ok) throw fail(`${what}：${r.reason}`);
  });
  (desc.cannons || []).forEach((c, i) => {
    if (!Array.isArray(c) || c.length < 3) throw fail(`cannons[${i}] 应为 [端点A, 端点B, 射角]`);
    const what = `cannons[${i}]`;
    const bm = bp.beamBetween(nodeOf(c[0], what), nodeOf(c[1], what));
    if (!bm) throw fail(`${what}：这两个端点之间没有杆件`);
    const aim = c[2];
    const r = bp.addCannon(bm.id, typeof aim === 'number' ? aim * DEG : 45 * DEG);
    if (!r.ok) throw fail(`${what}：${r.reason}`);
    if (typeof aim === 'number') {
      if (!Number.isFinite(aim)) throw fail(`${what}：射角无效`);
    } else if (aim && typeof aim === 'object') {
      const t = Array.isArray(aim.at) ? aim.at : [FOE_CORE[0] + (aim.dx || 0), FOE_CORE[1] + (aim.dy || 0)];
      const pose = bp.cannonPose(bp.cannons.get(r.id));
      const ang = solveAngle(pose.px, pose.py, t[0], t[1], !!aim.high);
      if (ang == null) throw fail(`${what}：从这个位置打不到目标 (${t})`);
      bp.setCannonAngle(r.id, ang);
    } else throw fail(`${what}：射角应为数字或 {core|at, high}`);
  });
  return bp;
}

/** 蓝图 → 坐标式堡垒描述（可直接再喂给 loadFort） */
export function exportFort(bp, name) {
  const pt = (id) => { const n = bp.nodes.get(id); return [n.x, n.y]; };
  const out = {
    beams: [...bp.beams.values()].map((b) => [pt(b.a), pt(b.b), b.mat]),
    cannons: [...bp.cannons.values()].map((c) => { const b = bp.beams.get(c.beam); return [pt(b.a), pt(b.b), r3(c.angle / DEG)]; }),
  };
  return name ? { name, ...out } : out;
}

/** 把坐标式堡垒描述排成一行一根杆的 JSON 文本（人和 AI 都好读） */
export function formatFort(desc) {
  const rows = (arr) => (arr || []).map((r) => '    ' + JSON.stringify(r)).join(',\n');
  const head = desc.name ? `  "name": ${JSON.stringify(desc.name)},\n` : '';
  return `{\n${head}  "beams": [\n${rows(desc.beams)}\n  ],\n  "cannons": [\n${rows(desc.cannons)}\n  ]\n}\n`;
}

/**
 * 检查一座堡垒：规则是否合法、是否超预算、在自重下站不站得住、每门炮的理想弹道打到哪。
 * 不会抛错；有问题写在 errors 里。
 */
export function checkFort(desc, opts = {}) {
  let bp;
  try { bp = loadFort(desc, 'player'); } catch (e) {
    if (!e.fortError) throw e;
    return { ok: false, errors: [e.message] };
  }
  const cost = bp.cost();
  const errors = [];
  if (cost > CFG.budget && !opts.ignoreBudget) errors.push(`超出预算：造价 ${cost}，预算 ${CFG.budget}`);
  // 静载体检：只有自己，不开火，看 6 秒
  const sim = new Sim(bp, new Blueprint('enemy'), { peace: true });
  for (let i = 0; i < 360; i++) { sim.step(); sim.events.length = 0; }
  const core = sim.cores[0];
  const other = opts.versus ? safeLoad(opts.versus, 'enemy') : null;
  return {
    ok: errors.length === 0,
    errors,
    cost, budget: CFG.budget, breakdown: bp.breakdown(),
    members: bp.beams.size, cannons: bp.cannons.size,
    static: {
      membersLostUnderOwnWeight: sim.stats[0].beamsLost,
      coreHeld: core.alive !== false && sim.y[core.node] > CFG.waterY && Math.abs(sim.y[core.node] - CFG.corePos[1]) < 0.5,
      coreSagMeters: r3(CFG.corePos[1] - sim.y[core.node]),
      peakStressRatio: r3(sim.maxStress(0)),
    },
    // 蓝图姿态下的理想弹道（不含结构下沉和散布）。给了 versus 就连对方结构一起判定
    shots: [...bp.cannons.values()].map((c) => {
      const p = predictShot(bp, c, other);
      const b = bp.beams.get(c.beam), a = bp.nodes.get(b.a), d = bp.nodes.get(b.b);
      return { mount: [[a.x, a.y], [d.x, d.y]], angleDeg: r3(c.angle / DEG), lands: p.end.kind, at: [r3(p.end.x), r3(p.end.y)], flightSeconds: r3(p.t) };
    }),
  };
}
function safeLoad(desc, side) { try { return loadFort(desc, side); } catch { return null; } }

function sideReport(bp, sim, s, track) {
  const pt = (id) => { const n = bp.nodes.get(id); return [n.x, n.y]; };
  const core = sim.cores[s];
  const members = sim.beams.filter((b) => b.side === s).map((b) => {
    const m = bp.beams.get(b.bpId);
    const br = track.broke.get(b.idx);
    return { a: pt(m.a), b: pt(m.b), mat: m.mat, peak: r3(track.peak[b.idx] || 0), hpLeft: r3(Math.max(0, b.hp) / b.hpMax), broke: br || null };
  });
  const cannons = sim.cannons.filter((c) => c.side === s).map((c) => {
    const m = bp.beams.get(sim.beams[c.beam].bpId);
    const bc = bp.cannons.get(c.bpId);
    return {
      mount: [pt(m.a), pt(m.b)], angleDeg: r3(bc.angle / DEG), shots: c.shots,
      maxTiltDeg: r3(track.tilt[c.idx] || 0),
      // 这门炮的炮弹都打到了什么：敌方杆件 / 核心 / 火炮、自家结构、地面、水里
      landed: track.landed[c.idx] || {},
      lost: track.lost.get(c.idx) || null,
    };
  });
  return {
    cost: bp.cost(),
    coreHp: core.alive ? r3(Math.max(0, core.hp)) : 0, coreHpMax: core.hpMax,
    coreFate: core.alive ? 'alive' : core.sunk ? 'sunk' : 'destroyed',
    shots: sim.stats[s].shots, hits: sim.stats[s].hits,
    membersLost: sim.stats[s].beamsLost, cannonsLost: sim.stats[s].cannonsLost,
    firstFailure: members.filter((m) => m.broke).sort((x, y) => x.broke.order - y.broke.order)[0] || null,
    members, cannons,
  };
}

/**
 * 打一场。fortA 在左（先手方，早 CANNON.enemyOffset 秒开第一炮），fortB 在右。
 * @param {object} opts { seed, timeline:boolean, ignoreBudget:boolean }
 * @returns 胜负 + 双方逐杆 / 逐炮的反馈。坐标都是各自的本地坐标，可以直接对回自己的设计。
 */
export function duel(fortA, fortB, opts = {}) {
  const seed = opts.seed ?? CFG.seed;
  const a = loadFort(fortA, 'player'), b = loadFort(fortB, 'enemy');
  if (!opts.ignoreBudget) {
    if (a.cost() > CFG.budget) throw fail(`A 超出预算：${a.cost()} > ${CFG.budget}`);
    if (b.cost() > CFG.budget) throw fail(`B 超出预算：${b.cost()} > ${CFG.budget}`);
  }
  const sim = new Sim(a, b, { seed });
  const track = { peak: new Float64Array(sim.beams.length), broke: new Map(), tilt: {}, landed: {}, lost: new Map(), order: [0, 0] };
  const tl = opts.timeline ? [] : null;
  const who = (s) => (s === 0 ? 'A' : 'B');
  const LAND = { wood: 'member', steel: 'member', rope: 'member', spring: 'member', core: 'core', cannon: 'cannon', ground: 'ground' };
  let guard = 0;
  const limit = Math.ceil((CFG.settleTime + CFG.battleTime + CFG.stalemateTime + 5) / CFG.dt);
  while (sim.phase !== 'ended' && guard++ < limit) {
    sim.step();
    const t = r3(sim.time);
    for (const e of sim.events) {
      switch (e.type) {
        case 'break':
          if (!track.broke.has(e.beam)) track.broke.set(e.beam, { t, cause: e.cause, order: ++track.order[e.side] });
          if (tl && e.cause !== 'sunk') tl.push({ t, type: 'break', side: who(e.side), cause: e.cause, mat: e.mat });
          break;
        case 'explode': {
          const L = (track.landed[e.cannon] ||= {});
          const k = e.hitSide < 0 ? 'ground' : (e.hitSide === e.side ? 'own_' : 'enemy_') + LAND[e.kind];
          L[k] = (L[k] || 0) + 1;
          if (tl) tl.push({ t, type: 'hit', by: who(e.side), what: k, x: r3(e.x), y: r3(e.y) });
          break;
        }
        case 'splash':
          if (e.shell) { const L = (track.landed[e.cannon] ||= {}); L.water = (L.water || 0) + 1; if (tl) tl.push({ t, type: 'hit', by: who(e.side), what: 'water', x: r3(e.x), y: r3(e.y) }); }
          break;
        case 'fire': if (tl) tl.push({ t, type: 'fire', side: who(e.side), angleDeg: r3((e.side === 0 ? e.angle : Math.PI - e.angle) / DEG) }); break;
        case 'cannonLost': track.lost.set(e.cannon, { t, cause: e.cause }); if (tl) tl.push({ t, type: 'cannonLost', side: who(e.side), cause: e.cause }); break;
        case 'coreHit': if (tl) tl.push({ t, type: 'coreHit', side: who(e.side), damage: r3(e.dmg), hpLeft: r3(e.hp) }); break;
        case 'coreDestroyed': case 'coreSunk': if (tl) tl.push({ t, type: e.type, side: who(e.side) }); break;
        case 'end': if (tl) tl.push({ t, type: 'end', winner: e.winner === 'player' ? 'A' : e.winner === 'enemy' ? 'B' : 'draw', reason: e.reason }); break;
      }
    }
    sim.events.length = 0;
    const beams = sim.beams;
    for (let i = 0; i < beams.length; i++) { const m = beams[i]; if (m.alive && m.stressVis > track.peak[i]) track.peak[i] = m.stressVis; }
    for (const c of sim.cannons) if (c.alive) { const d = Math.abs(c.tilt) / DEG; if (d > (track.tilt[c.idx] || 0)) track.tilt[c.idx] = d; }
  }
  const winner = sim.winner === 'player' ? 'A' : sim.winner === 'enemy' ? 'B' : 'draw';
  const out = {
    winner, reason: sim.endReason || 'unfinished', fightSeconds: r3(sim.fightTime), seed,
    A: sideReport(a, sim, 0, track),
    B: sideReport(b, sim, 1, track),
  };
  if (tl) out.timeline = tl;
  return out;
}

/**
 * 公平的对局：左边一方早 CANNON.enemyOffset 秒开第一炮，所以每个种子打主客两场，按总胜场判定。
 * @param {object} opts { seeds:number[] | games:number, ignoreBudget }
 */
export function match(fortA, fortB, opts = {}) {
  const seeds = opts.seeds || Array.from({ length: opts.games ? Math.ceil(opts.games / 2) : 2 }, (_, i) => CFG.seed + i);
  const games = [];
  let aWins = 0, bWins = 0, draws = 0;
  for (const seed of seeds) {
    for (const home of ['A', 'B']) {
      const r = home === 'A' ? duel(fortA, fortB, { seed, ignoreBudget: opts.ignoreBudget }) : duel(fortB, fortA, { seed, ignoreBudget: opts.ignoreBudget });
      // 第二场 A、B 互换了位置，把结果换回原来的称呼
      const w = r.winner === 'draw' ? 'draw' : (r.winner === 'A') === (home === 'A') ? 'A' : 'B';
      if (w === 'A') aWins++; else if (w === 'B') bWins++; else draws++;
      const mine = home === 'A' ? r.A : r.B, theirs = home === 'A' ? r.B : r.A;
      games.push({ seed, left: home, winner: w, reason: r.reason, fightSeconds: r.fightSeconds, coreHpA: mine.coreHp, coreHpB: theirs.coreHp });
    }
  }
  return { winner: aWins > bWins ? 'A' : bWins > aWins ? 'B' : 'draw', aWins, bWins, draws, games };
}
