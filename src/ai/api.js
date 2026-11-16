// AI 对战接口：把「一份堡垒描述」变成蓝图、检查它、让两座堡垒打一场并给出可供改进的反馈。
// 不依赖浏览器，node 里直接 import 即可用；命令行封装见 tools/duel.mjs，说明见 AI.md。
//
// 堡垒描述（fort spec）用搭建者自己的本地坐标：永远朝 +x 开火。场地是对称的，对方的点 (x, y) 在己方坐标里是 (fieldW - x, y)，
// 所以同一份描述放在左边或右边都能用，右边由引擎自动镜像。
// 场地由地图决定（见 src/map.js）：凡是带 map 参数的函数，可以传内置地图的名字、一份地图数据，或者不传（默认地图「海峡」）。

import { CFG, MATERIALS, MATERIAL_ORDER, CANNON, CORE } from '../config.js';
import { Blueprint } from '../sim/blueprint.js';
import { Sim } from '../sim/sim.js';
import { solveAngle, predictShot } from '../sim/ballistics.js';
import { getRules, CURRENT_RULES } from '../rules.js';
import { getMap, mapData, MAPS, MAP_ORDER } from '../map.js';

const DEG = Math.PI / 180;
const r3 = (v) => Math.round(v * 1000) / 1000;

/** 内置地图一览：[{ id, name, water, fieldW }] */
export function maps() {
  return MAP_ORDER.map((id) => ({ id, name: MAPS[id].name, fieldW: MAPS[id].fieldW, water: MAPS[id].water }));
}

/** 给 AI 看的规则（全部取自 config.js、rules.js 和地图，不会和游戏本身脱节）。可以传规则版本号看旧版本，传地图看别的场地 */
export function rules(version, map) {
  const R = getRules(version);
  const M = getMap(map);
  const Z = M.coreZone;
  return {
    version: R.id,
    units: '米，y 向上。本地坐标：朝 +x 开火；场地左右对称，对方的点 (x, y) 在己方坐标里是 (fieldW - x, y)',
    map: {
      id: M.id, name: M.name, fieldWidth: M.fieldW,
      ground: M.ground,
      groundNote: '己方半场的地面轮廓，从后方画到中线（x = fieldWidth / 2），第一个点往左、最后一个点到中线按水平延伸；轮廓下方是实心的地。对方半场是镜像',
      water: M.water,
      waterNote: M.hasWater ? `水面在 y = ${M.water}。掉进水里的东西会沉没，核心落水即判负` : '这张图没有水',
    },
    field: { width: M.fieldW, waterY: M.water, foeCore: M.foeCore },
    grid: CFG.grid,
    buildZone: M.build,
    forbidden: '节点不能在地面轮廓以下（地里）；杆件不能穿过地里（贴着地表走可以）',
    anchors: M.anchors,
    core: {
      at: M.core, mass: CORE.mass, hp: CORE.hp, radius: CORE.radius,
      movable: !!R.coreZone,
      zone: R.coreZone ? Z : { xMin: M.core[0], xMax: M.core[0], yMin: M.core[1], yMax: M.core[1] },
      foeDefault: M.foeCore,
      foeZone: R.coreZone ? { xMin: M.fieldW - Z.xMax, xMax: M.fieldW - Z.xMin, yMin: Z.yMin, yMax: Z.yMax } : null,
      note: [
        R.coreZone
          ? `核心可以放在 zone 范围里的任意整数网格点（堡垒描述里写 "core": [x, y]；不写就在 at）。对方的核心同样可以挪，开战前你不知道它在哪，只知道在 foeZone 里`
          : '核心固定在 at',
        '核心是一个普通节点，必须靠杆件托住',
        `耐久归零${M.hasWater ? '、落水' : ''}${R.coreGroundKill ? '、碰到地面' : ''}即判负`,
      ].join('；'),
    },
    budget: M.budget,
    materials: MATERIAL_ORDER.map((id) => {
      const m = MATERIALS[id];
      return {
        id, costPerMeter: m.cost, assemblyFee: R.assemblyFee, massPerMeter: m.density, maxLength: m.maxLen,
        tensionLimitN: m.strT, compressionLimitN: Number.isFinite(m.strC) ? m.strC : null,
        hp: m.hp, tensionOnly: !!m.tensionOnly,
      };
    }),
    pricing: R.assemblyFee
      ? `杆件造价 = 每米单价 × 长度 + 每根 ${R.assemblyFee} 的装配费。${R.mergeCollinear ? '同材质、共线、中间节点没有别的连接也没有火炮的相邻杆件按一根算（只收一次装配费，模拟里也是一根杆、一份耐久），所以把直杆切成几段没有好处' : ''}`
      : '杆件造价 = 每米单价 × 长度',
    overlap: R.noOverlap ? '两根杆不能有一段叠在同一条线上' : '允许杆件重叠',
    cannon: {
      cost: CANNON.cost, max: M.maxCannons, mass: CANNON.mass, hp: CANNON.hp,
      mountRule: [
        R.anchorMounts ? null : '炮座杆件的两端都不能是锚点',
        R.groundMounts ? null : '炮座的两端不能贴在地表上；战斗中炮座节点碰到地面的炮不能开火',
      ].filter(Boolean).join('；') || '没有额外限制',
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
      pierce: R.pierce
        ? `每发炮弹有 ${CFG.shell.directDamage} 点直击伤害预算：碰到的杆件剩余耐久小于预算时，杆件被打断，炮弹减速并带着剩下的预算继续飞；否则在这根杆上引爆并产生溅射。所以薄木板、快断的杆和绳索挡不住一整发炮弹`
        : '炮弹碰到第一根杆就引爆，直击伤害全部给这根杆',
      blast: R.blastOcclusion ? '溅射伤害会被爆点和目标之间的杆件挡住（绳索不算），所以顶盖和外墙能护住后面的东西' : '溅射伤害只看距离，不看遮挡',
    },
    battle: {
      settleSeconds: CFG.settleTime, timeLimit: R.battleTime,
      win: `对方核心耐久归零${M.hasWater ? '、落水' : ''}${R.coreGroundKill ? '、碰到地面' : ''}；到时未分胜负则核心剩余耐久多者胜${R.drawMargin ? `，相差不超过 ${Math.round(R.drawMargin * CORE.hp)} 点算平局` : ''}`,
      entry: R.needCannon ? '参赛堡垒至少要有一门沉降后还能开火的火炮' : '没有额外要求',
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
 * 前两种写法可以加 "core": [x, y] 指定核心位置（要在地图的核心范围里；不写就是默认位置）。
 * 射角可以是数字（度，0 = 水平朝敌方），也可以是 { core:true, high:bool, dx, dy } 或 { at:[x,y], high:bool }，由引擎解算；
 * core:true 瞄的是对方核心的默认位置（对方把核心挪到哪，开战前并不知道）。
 * 任何不合规则的地方都会抛出带原因的错误。
 */
export function loadFort(desc, side = 'player', rules, map) {
  if (!desc || typeof desc !== 'object') throw fail('堡垒描述必须是一个对象');
  if (desc instanceof Blueprint) {
    // 换一套规则或换一张地图时要重新过一遍校验（比如旧规则下合法的锚点炮座）
    const bp = Blueprint.fromJSON(desc.toJSON(), side, rules || desc.rules, map || desc.map);
    const why = bp.validate();
    if (why) throw fail(why);
    return bp;
  }
  // 3. 存档格式
  if (Array.isArray(desc.nodes)) {
    let bp;
    try { bp = Blueprint.fromJSON(desc, side, rules, map); } catch (e) { throw fail('存档格式无法解析：' + e.message); }
    const why = bp.validate();
    if (why) throw fail(why);
    return bp;
  }
  if (!Array.isArray(desc.beams)) throw fail('缺少 beams 数组');
  const bp = new Blueprint(side, rules, map);
  const FOE_CORE = bp.map.foeCore;
  if (desc.core !== undefined && desc.core !== null) {
    if (!Array.isArray(desc.core) || desc.core.length < 2) throw fail('core 应为 [x, y]');
    const r = bp.setCore(desc.core[0], desc.core[1]);
    if (!r.ok) throw fail(`core (${desc.core[0]},${desc.core[1]})：${r.reason}`);
  }
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
  const core = bp.coreNode();
  const out = {
    core: [core.x, core.y],
    beams: [...bp.beams.values()].map((b) => [pt(b.a), pt(b.b), b.mat]),
    cannons: [...bp.cannons.values()].map((c) => { const b = bp.beams.get(c.beam); return [pt(b.a), pt(b.b), r3(c.angle / DEG)]; }),
  };
  return name ? { name, ...out } : out;
}

/** 把坐标式堡垒描述排成一行一根杆的 JSON 文本（人和 AI 都好读） */
export function formatFort(desc) {
  const rows = (arr) => (arr || []).map((r) => '    ' + JSON.stringify(r)).join(',\n');
  const head = (desc.name ? `  "name": ${JSON.stringify(desc.name)},\n` : '') + (desc.core ? `  "core": ${JSON.stringify(desc.core)},\n` : '');
  return `{\n${head}  "beams": [\n${rows(desc.beams)}\n  ],\n  "cannons": [\n${rows(desc.cannons)}\n  ]\n}\n`;
}

/**
 * 检查一座堡垒：规则是否合法、是否超预算、在自重下站不站得住、每门炮的理想弹道打到哪。
 * 不会抛错；有问题写在 errors 里。
 */
export function checkFort(desc, opts = {}) {
  const R = getRules(opts.rules);
  const M = getMap(opts.map);
  let bp;
  try { bp = loadFort(desc, 'player', R, M); } catch (e) {
    if (!e.fortError) throw e;
    return { ok: false, rules: R.id, map: M.id, errors: [e.message] };
  }
  const cost = bp.cost();
  const errors = [];
  if (cost > M.budget && !opts.ignoreBudget) errors.push(`超出预算：造价 ${cost}，预算 ${M.budget}`);
  const { sim, ready, coreGrounded } = staticCheck(bp, R);
  const core = sim.cores[0];
  const coreAt = bp.coreNode();
  const other = opts.versus ? safeLoad(opts.versus, 'enemy', R, M) : null;
  if (R.needCannon && ready === 0) errors.push(bp.cannons.size === 0 ? '至少要有一门火炮' : '沉降之后没有一门炮能开火（炮座塌了，或者贴在了地面上）');
  if (R.coreGroundKill && coreGrounded) errors.push('核心没有托住：只靠自重，它就掉到了地面上（开战即负）');
  return {
    ok: errors.length === 0,
    rules: R.id, map: M.id,
    errors,
    cost, budget: M.budget, breakdown: bp.breakdown(),
    members: bp.beams.size, cannons: bp.cannons.size,
    static: {
      membersLostUnderOwnWeight: sim.stats[0].beamsLost,
      coreAt: [coreAt.x, coreAt.y],
      coreHeld: core.alive !== false && !coreGrounded && sim.y[core.node] > M.waterY && Math.abs(sim.y[core.node] - coreAt.y) < 0.5,
      coreSagMeters: r3(coreAt.y - sim.y[core.node]),
      peakStressRatio: r3(sim.maxStress(0)),
      cannonsReady: ready,
    },
    // 蓝图姿态下的理想弹道（不含结构下沉和散布）。给了 versus 就连对方结构一起判定
    shots: [...bp.cannons.values()].map((c) => {
      const p = predictShot(bp, c, other);
      const b = bp.beams.get(c.beam), a = bp.nodes.get(b.a), d = bp.nodes.get(b.b);
      return { mount: [[a.x, a.y], [d.x, d.y]], angleDeg: r3(c.angle / DEG), lands: p.end.kind, at: [r3(p.end.x), r3(p.end.y)], flightSeconds: r3(p.t) };
    }),
  };
}
/**
 * 静载体检：只有自己，不开火，看 6 秒。ready 是沉降之后还能开火的炮数（没掉、炮座没贴地）。
 * 只沉降到开火那一刻（1.6 秒）是不够的：没有支撑的炮座那时可能还在半空。
 * 同一座堡垒在一轮比赛里会被查很多次，所以按内容缓存。
 */
const staticCache = new Map();
function staticCheck(bp, R) {
  const M = bp.map;
  const key = R.id + JSON.stringify(M.raw) + JSON.stringify(exportFort(bp));
  let hit = staticCache.get(key);
  if (!hit) {
    const self = bp.side === 'player' ? bp : Blueprint.fromJSON(bp.toJSON(), 'player', bp.rules, M);
    const sim = new Sim(self, new Blueprint('enemy', R, M), { peace: true, rules: R, map: M });
    for (let i = 0; i < 360; i++) { sim.step(); sim.events.length = 0; }
    const coreGrounded = !!sim.cores[0].touched;   // 沉降过程中核心碰过地面（哪怕只擦了一下）
    hit = { sim, coreGrounded, ready: sim.cannons.filter((c) => c.side === 0 && c.alive && !c.grounded).length };
    if (staticCache.size >= 64) staticCache.delete(staticCache.keys().next().value);
    staticCache.set(key, hit);
  }
  return hit;
}

function safeLoad(desc, side, rules, map) { try { return loadFort(desc, side, rules, map); } catch { return null; } }

function sideReport(bp, sim, s, track) {
  const pt = (id) => { const n = bp.nodes.get(id); return [n.x, n.y]; };
  const core = sim.cores[s];
  // 模拟里的一根构件可能是蓝图里几段共线的杆合成的，所以端点取模拟里这根构件的两个端节点
  const members = sim.beams.filter((b) => b.side === s).map((b) => {
    const m = { a: sim.nodeBpId[b.a], b: sim.nodeBpId[b.b], mat: b.matId };
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
      ...(c.alive && c.grounded ? { grounded: true } : {}),   // 炮座贴地，开不了火
    };
  });
  return {
    cost: bp.cost(),
    coreHp: core.alive ? r3(Math.max(0, core.hp)) : 0, coreHpMax: core.hpMax,
    coreAt: (() => { const c = bp.coreNode(); return [c.x, c.y]; })(),
    coreFate: core.alive ? 'alive' : core.sunk ? 'sunk' : core.grounded ? 'grounded' : 'destroyed',
    shots: sim.stats[s].shots, hits: sim.stats[s].hits,
    membersLost: sim.stats[s].beamsLost, cannonsLost: sim.stats[s].cannonsLost,
    firstFailure: members.filter((m) => m.broke).sort((x, y) => x.broke.order - y.broke.order)[0] || null,
    members, cannons,
  };
}

/**
 * 打一场。fortA 在左（先手方，早 CANNON.enemyOffset 秒开第一炮），fortB 在右。
 * @param {object} opts { seed, rules, map, timeline:boolean, ignoreBudget:boolean }
 * @returns 胜负 + 双方逐杆 / 逐炮的反馈。坐标都是各自的本地坐标，可以直接对回自己的设计。
 */
export function duel(fortA, fortB, opts = {}) {
  const seed = opts.seed ?? CFG.seed;
  const R = getRules(opts.rules);
  const M = getMap(opts.map);
  const a = loadFort(fortA, 'player', R, M), b = loadFort(fortB, 'enemy', R, M);
  if (!opts.ignoreBudget) {
    if (a.cost() > M.budget) throw fail(`A 超出预算：${a.cost()} > ${M.budget}`);
    if (b.cost() > M.budget) throw fail(`B 超出预算：${b.cost()} > ${M.budget}`);
  }
  if (R.needCannon && !opts.allowUnarmed) {
    for (const [k, bp] of [['A', a], ['B', b]]) {
      if (bp.cannons.size === 0) throw fail(`${k} 没有火炮：参赛堡垒至少要有一门`);
      if (staticCheck(bp, R).ready === 0) throw fail(`${k} 沉降之后没有一门炮能开火（炮座塌了，或者贴在了地面上）`);
    }
  }
  const sim = new Sim(a, b, { seed, rules: R, map: M });
  const track = { peak: new Float64Array(sim.beams.length), broke: new Map(), tilt: {}, landed: {}, lost: new Map(), order: [0, 0] };
  const tl = opts.timeline ? [] : null;
  const who = (s) => (s === 0 ? 'A' : 'B');
  const LAND = { wood: 'member', steel: 'member', rope: 'member', spring: 'member', core: 'core', cannon: 'cannon', ground: 'ground' };
  let guard = 0;
  const limit = Math.ceil((CFG.settleTime + R.battleTime + CFG.stalemateTime + 5) / CFG.dt);
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
        case 'pierce':   // 打断一根杆后继续飞：不算落点，只记进时间线
          if (tl) tl.push({ t, type: 'pierce', by: who(e.side), what: (e.hitSide === e.side ? 'own_' : 'enemy_') + 'member', x: r3(e.x), y: r3(e.y) });
          break;
        case 'splash':
          if (e.shell) { const L = (track.landed[e.cannon] ||= {}); L.water = (L.water || 0) + 1; if (tl) tl.push({ t, type: 'hit', by: who(e.side), what: 'water', x: r3(e.x), y: r3(e.y) }); }
          break;
        case 'fire': if (tl) tl.push({ t, type: 'fire', side: who(e.side), angleDeg: r3((e.side === 0 ? e.angle : Math.PI - e.angle) / DEG) }); break;
        case 'cannonLost': track.lost.set(e.cannon, { t, cause: e.cause }); if (tl) tl.push({ t, type: 'cannonLost', side: who(e.side), cause: e.cause }); break;
        case 'coreHit': if (tl) tl.push({ t, type: 'coreHit', side: who(e.side), damage: r3(e.dmg), hpLeft: r3(e.hp) }); break;
        case 'coreDestroyed': case 'coreSunk': if (tl) tl.push({ t, type: e.cause === 'ground' ? 'coreGrounded' : e.type, side: who(e.side) }); break;
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
    winner, reason: sim.endReason || 'unfinished', fightSeconds: r3(sim.fightTime), seed, rules: R.id, map: M.id,
    A: sideReport(a, sim, 0, track),
    B: sideReport(b, sim, 1, track),
  };
  if (tl) out.timeline = tl;
  return out;
}

/**
 * 公平的对局：左边一方早 CANNON.enemyOffset 秒开第一炮，所以每个种子打主客两场，按总胜场判定。
 * @param {object} opts { seeds:number[] | games:number, rules, map, ignoreBudget }
 */
export function match(fortA, fortB, opts = {}) {
  const seeds = opts.seeds || Array.from({ length: opts.games ? Math.ceil(opts.games / 2) : 2 }, (_, i) => CFG.seed + i);
  const games = [];
  let aWins = 0, bWins = 0, draws = 0;
  for (const seed of seeds) {
    for (const home of ['A', 'B']) {
      const o = { seed, ignoreBudget: opts.ignoreBudget, rules: opts.rules, map: opts.map, allowUnarmed: opts.allowUnarmed };
      const r = home === 'A' ? duel(fortA, fortB, o) : duel(fortB, fortA, o);
      // 第二场 A、B 互换了位置，把结果换回原来的称呼
      const w = r.winner === 'draw' ? 'draw' : (r.winner === 'A') === (home === 'A') ? 'A' : 'B';
      if (w === 'A') aWins++; else if (w === 'B') bWins++; else draws++;
      const mine = home === 'A' ? r.A : r.B, theirs = home === 'A' ? r.B : r.A;
      games.push({ seed, left: home, winner: w, reason: r.reason, fightSeconds: r.fightSeconds, coreHpA: mine.coreHp, coreHpB: theirs.coreHp });
    }
  }
  return { winner: aWins > bWins ? 'A' : bWins > aWins ? 'B' : 'draw', aWins, bWins, draws, games, rules: getRules(opts.rules).id, map: getMap(opts.map).id };
}

export { getMap, mapData, validateMap } from '../map.js';
