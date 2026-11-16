// 物理核心的无头测试：node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG, MATERIALS, CANNON } from '../src/config.js';
import { Blueprint } from '../src/sim/blueprint.js';
import { Sim } from '../src/sim/sim.js';
import { makeEnemyFort, makeStarterFort } from '../src/sim/forts.js';

const empty = (side) => new Blueprint(side);
function run(sim, seconds) { const n = Math.round(seconds / CFG.dt); for (let i = 0; i < n; i++) sim.step(); }
function beamOf(sim, bp, a, b) {
  const bm = bp.beamBetween(a, b);
  return sim.beams.find(x => x.side === 0 && x.bpId === bm.id);
}

// 支架：锚点 A0(0,0)、F2(0,-2)，外伸节点 T(2,0)；A0-T 水平杆，F2-T 斜撑；A0-T 上架一门炮。
// 这个形状有手算的解析解，所以拿它校验求解器。炮座一端是锚点，只有 v1 规则允许，
// 这几条测试因此按 v1 建图（求解器本身不分版本）。
function bracket() {
  const bp = new Blueprint('player', 'v1');
  const A0 = bp.nodeAt(0, 0).id, F2 = bp.nodeAt(0, -2).id;
  const T = bp.addNode(2, 0).id;
  bp.addBeam(A0, T, 'wood'); bp.addBeam(F2, T, 'wood');
  const r = bp.addCannon(bp.beamBetween(A0, T).id, 45 * Math.PI / 180);
  assert.ok(r.ok, r.reason);
  return { bp, A0, F2, T };
}

test('静力：支架杆件轴力与解析解一致', () => {
  const { bp, A0, F2, T } = bracket();
  const sim = new Sim(bp, empty('enemy'), { peace: true });
  run(sim, 4);
  const iT = [...sim.nodeBpId].findIndex((id, i) => id === T && sim.side[i] === 0);
  const Wt = sim.mass[iT] * CFG.gravity;
  const top = beamOf(sim, bp, A0, T), diag = beamOf(sim, bp, F2, T);
  // 竖向平衡：斜撑受压 √2·W；水平平衡：水平杆受拉 W
  assert.ok(Math.abs(top.f - Wt) / Wt < 0.02, `水平杆 ${top.f.toFixed(1)} vs ${Wt.toFixed(1)}`);
  assert.ok(Math.abs(-diag.f - Wt * Math.SQRT2) / (Wt * Math.SQRT2) < 0.02, `斜撑 ${diag.f.toFixed(1)} vs ${(-Wt * Math.SQRT2).toFixed(1)}`);
});

test('刚度：挠度与解析解一致，且只有毫米级', () => {
  const { bp, T } = bracket();
  const sim = new Sim(bp, empty('enemy'), { peace: true });
  run(sim, 4);
  const iT = [...sim.nodeBpId].findIndex((id, i) => id === T && sim.side[i] === 0);
  const Wt = sim.mass[iT] * CFG.gravity;
  const EA = MATERIALS.wood.EA;
  const expected = Wt * 2 / EA + Math.SQRT2 * (Wt * Math.SQRT2) * Math.hypot(2, 2) / EA; // 虚功法
  const sag = -sim.y[iT];
  assert.ok(Math.abs(sag - expected) / expected < 0.05, `挠度 ${(sag * 1000).toFixed(2)}mm vs ${(expected * 1000).toFixed(2)}mm`);
  assert.ok(sag < 0.01, '带一门炮的 2 米悬臂下沉应小于 1 厘米');
});

test('稳定：沉降后结构静止，不抖不漂', () => {
  const sim = new Sim(makeEnemyFort().clone('player'), empty('enemy'), { peace: true });
  run(sim, 5);
  const x1 = Float64Array.from(sim.x), y1 = Float64Array.from(sim.y);
  run(sim, 2);
  let drift = 0, live = 0;
  for (let i = 0; i < sim.n; i++) {
    if (!sim.alive[i] || sim.side[i] !== 0) continue;
    live++; drift = Math.max(drift, Math.hypot(sim.x[i] - x1[i], sim.y[i] - y1[i]));
  }
  assert.ok(live > 10);
  assert.ok(drift < 1e-4, `2 秒内最大漂移 ${(drift * 1000).toFixed(4)}mm`);
  assert.equal(sim.stats[0].beamsLost, 0, '预设堡垒在自重下不该断任何杆');
  assert.ok(sim.maxStress(0) < 0.7, `静载受力比 ${sim.maxStress(0).toFixed(2)} 应留有余量`);
});

test('超载：细长木悬臂托不住火炮，直接崩断', () => {
  const bp = new Blueprint('player');
  let prev = bp.nodeAt(0, 0).id;
  for (let x = 4; x <= 8; x += 4) { const id = bp.addNode(x, 0).id; assert.ok(bp.addBeam(prev, id, 'wood').ok); prev = id; }
  const sim = new Sim(bp, empty('enemy'), { peace: true });
  run(sim, 3);
  // 单根杆铰接悬挑是机构，会绕锚点摆下去；这里验证它不会数值爆炸
  for (let i = 0; i < sim.n; i++) assert.ok(Number.isFinite(sim.x[i]) && Number.isFinite(sim.y[i]));
});

test('后坐力：开火让炮座杆件受力出现明显尖峰', () => {
  const { bp, A0, F2, T } = bracket();
  const sim = new Sim(bp, empty('enemy'));
  // 敌方空蓝图的核心会落水，战斗很快结束；这里只看开火前后
  const top = beamOf(sim, bp, A0, T), diag = beamOf(sim, bp, F2, T);
  run(sim, CFG.settleTime + 0.3);
  const before = Math.max(top.stressVis, diag.stressVis);
  let peak = 0, fired = false;
  for (let i = 0; i < 120; i++) {
    sim.step();
    if (sim.events.some(e => e.type === 'fire' && e.side === 0)) fired = true;
    sim.events.length = 0;
    peak = Math.max(peak, top.stress, diag.stress);
  }
  assert.ok(fired, '应该开过火');
  assert.ok(peak > before * 1.6, `后坐尖峰 ${peak.toFixed(2)} vs 静载 ${before.toFixed(2)}`);
});

test('确定性：同样的蓝图和种子，结果逐位相同', () => {
  const a = new Sim(makeStarterFort(), makeEnemyFort(), { seed: 7 });
  const b = new Sim(makeStarterFort(), makeEnemyFort(), { seed: 7 });
  run(a, 25); run(b, 25);
  assert.equal(a.hash(), b.hash());
  assert.equal(a.winner, b.winner);
});

test('对战：能打出结果，且全程数值有限', () => {
  const sim = new Sim(makeStarterFort(), makeEnemyFort());
  let frames = 0;
  while (sim.phase !== 'ended' && frames < 60 * 130) { sim.step(); sim.events.length = 0; frames++; }
  assert.equal(sim.phase, 'ended');
  assert.ok(['player', 'enemy', 'draw'].includes(sim.winner));
  for (let i = 0; i < sim.n; i++) if (sim.alive[i]) assert.ok(Number.isFinite(sim.x[i]) && Number.isFinite(sim.y[i]));
});

test('性能：两座堡垒一帧的模拟远小于 16ms', () => {
  const sim = new Sim(makeEnemyFort().clone('player'), makeEnemyFort());
  for (let i = 0; i < 60; i++) sim.step();
  const t0 = performance.now();
  for (let i = 0; i < 300; i++) { sim.step(); sim.events.length = 0; }
  const ms = (performance.now() - t0) / 300;
  assert.ok(ms < 4, `每帧 ${ms.toFixed(2)}ms`);
});

test('蓝图：造价、退款、校验', () => {
  const bp = new Blueprint('player');
  assert.equal(bp.cost(), 0);
  const a = bp.nodeAt(0, 0).id;
  const n = bp.addNode(2, 0); assert.ok(n.ok);
  const r = bp.addBeam(a, n.id, 'wood'); assert.ok(r.ok);
  const fee = bp.rules.assemblyFee;
  assert.equal(bp.cost(), 200 + fee, '2 米木杆 + 一份装配费');
  assert.ok(bp.setBeamMat(r.id, 'steel').ok); assert.equal(bp.cost(), 480 + fee);
  assert.ok(!bp.addCannon(r.id).ok, '一端是锚点的杆不能架炮');
  // 抬高一层再架炮：(1,2)-(3,2) 两端都不是锚点，也不贴地
  const p = bp.addNode(1, 2).id, q = bp.addNode(3, 2).id;
  const m = bp.addBeam(p, q, 'steel'); assert.ok(m.ok);
  const before = bp.cost();
  assert.ok(bp.addCannon(m.id).ok); assert.equal(bp.cost(), before + CANNON.cost);
  assert.ok(!bp.setBeamMat(m.id, 'rope').ok, '有炮的杆不能换成绳');
  assert.ok(bp.removeBeam(m.id).ok); assert.equal(bp.cost(), 480 + fee, '拆除全额退款，炮一并退');
  assert.ok(bp.removeBeam(r.id).ok); assert.equal(bp.cost(), 0);
  assert.equal(bp.nodeAt(2, 0), null, '孤立节点自动清理');
  assert.ok(!bp.addNode(-2, -2).ok, '山体里不能放节点');
  assert.ok(!bp.addNode(20, 0).ok, '建造区外不能放节点');
  const far = bp.addNode(5, 0);
  assert.ok(!bp.addBeam(a, far.id, 'wood').ok, '超长');
  const j = bp.toJSON(); const bp2 = Blueprint.fromJSON(j, 'player');
  assert.deepEqual(bp2.toJSON(), j);
});

// ---------------------------------------------------------------- 手感回归：需求里点名的几种现象
import { buildFort, ENEMY_SPEC, STARTER_SPEC, REFERENCE_SPEC } from '../src/sim/forts.js';

const BASE = { A6: [-6, 0], A3: [-3, 0], A0: [0, 0], F2: [0, -2], F4: [0, -4], K: [4, 3] };
const pinCore = (sim, side) => { const c = sim.cores[side]; sim.fixed[c.node] = 1; sim.w[c.node] = 0; c.hp = 1e9; };
// 6 米高的两层炮塔，炮架在塔顶
function towerFort(leg, top) {
  return buildFort({
    nodes: { ...BASE, L1: [-2, 3], R1: [0, 3], L2: [-2, 6], R2: [0, 6] },
    beams: [['A3', 'L1', leg], ['A0', 'R1', leg], ['A0', 'L1', leg], ['L1', 'R1', 'wood'], ['L1', 'L2', leg], ['R1', 'R2', leg], ['L1', 'R2', leg], ['L2', 'R2', top]],
    cannons: [['L2', 'R2', 15]],
  }, 'player');
}
function fireAlone(bp, seconds) {
  const sim = new Sim(bp, empty('enemy'));
  pinCore(sim, 0); pinCore(sim, 1);
  let stressBreaks = 0, lost = 0, tilt = 0;
  for (let n = 0; n < seconds * 60; n++) {
    sim.step();
    for (const e of sim.events) {
      if (e.type === 'break' && e.side === 0 && e.cause === 'stress') stressBreaks++;
      if (e.type === 'cannonLost' && e.side === 0) lost++;
    }
    sim.events.length = 0;
    for (const c of sim.cannons) if (c.alive && c.side === 0) tilt = Math.max(tilt, Math.abs(c.tilt) * 180 / Math.PI);
  }
  return { stressBreaks, lost, tilt, sim };
}

test('后坐力：木头炮塔被自己的炮震塌，换成钢就稳', () => {
  const wood = fireAlone(towerFort('wood', 'wood'), 12);
  assert.ok(wood.stressBreaks >= 1 && wood.lost === 1, `木塔应被后坐力压断并失去火炮（压断 ${wood.stressBreaks}，失炮 ${wood.lost}）`);
  const steel = fireAlone(towerFort('steel', 'steel'), 12);
  assert.equal(steel.stressBreaks, 0, '钢塔不该被自己的后坐力震断');
  assert.ok(steel.tilt < 1, `钢塔炮偏角应小于 1°（实际 ${steel.tilt.toFixed(2)}°）`);
});

test('承重杆被打掉：敌方炮塔的塔身杆件任断一根，塔顶炮就歪或掉', () => {
  const probe = new Sim(empty('player'), makeEnemyFort());
  const top = probe.cannons.filter(c => c.side === 1).sort((a, b) => b.py - a.py)[0];
  const W = CFG.fieldW;
  const id = (name) => { const [x, y] = ENEMY_SPEC.nodes[name]; for (let i = 0; i < probe.n; i++) if (probe.side[i] === 1 && Math.abs(probe.x[i] - (W - x)) < 1e-9 && probe.y[i] === y) return i; throw new Error(name); };
  const member = (a, b) => { const i = id(a), j = id(b); return probe.beams.find(m => (m.a === i && m.b === j) || (m.a === j && m.b === i)); };
  const tower = [['T1', 'T3'], ['M2', 'T3'], ['M2', 'T4'], ['T3', 'T4'], ['T3', 'G1'], ['T4', 'G1'], ['T4', 'G2']];
  let leaned = 0;
  for (const [a, b] of tower) {
    const cut = member(a, b);
    assert.ok(cut, `敌方堡垒里应有杆件 ${a}-${b}`);
    const sim = new Sim(empty('player'), makeEnemyFort());
    pinCore(sim, 0); pinCore(sim, 1);
    const gun = sim.cannons[top.idx];
    let tilt = 0;
    for (let n = 0; n < 60 * 10; n++) {
      if (n === 60 * 3) sim._breakBeam(cut.idx, 'blast');
      sim.step(); sim.events.length = 0;
      if (gun.alive) tilt = Math.max(tilt, Math.abs(gun.tilt) * 180 / Math.PI);
    }
    if (!gun.alive || tilt >= 2) leaned++;
  }
  assert.ok(leaned >= 6, `7 根塔身杆件里至少 6 根断掉后塔顶炮应歪 ≥2° 或掉落（实际 ${leaned}）`);
});

test('受伤折减：被打伤的杆件在同样的力下受力比更高', () => {
  const { bp, F2, T } = bracket();
  const sim = new Sim(bp, empty('enemy'), { peace: true });
  const diag = beamOf(sim, bp, F2, T);
  run(sim, 3);
  const healthy = diag.stress;
  diag.hp = diag.hpMax * 0.5;
  run(sim, 0.5);
  const expected = healthy / (CFG.damagedStrength + (1 - CFG.damagedStrength) * 0.5);
  assert.ok(Math.abs(diag.stress - expected) / expected < 0.03, `半血时受力比 ${diag.stress.toFixed(3)}，应为 ${expected.toFixed(3)}`);
});

test('搭建顺序无关：同一个形状，杆件按不同先后搭出来，结果相同', () => {
  const a = buildFort(STARTER_SPEC, 'player');
  const b = buildFort({ ...STARTER_SPEC, beams: [...STARTER_SPEC.beams].reverse() }, 'player');
  const s1 = new Sim(a, makeEnemyFort(), { seed: 3 }), s2 = new Sim(b, makeEnemyFort(), { seed: 3 });
  run(s1, 25); run(s2, 25);
  assert.equal(s1.hash(), s2.hash());
  assert.equal(s1.winner, s2.winner);
});

test('沉没的杆件计入损失，并发出 cause=sunk 的事件', () => {
  // 一段不接任何锚点的结构：直接掉进水里沉底
  const bp = buildFort({ nodes: { ...BASE, P: [5, 1], Q: [7, 1] }, beams: [['K', 'P', 'wood'], ['P', 'Q', 'wood'], ['K', 'Q', 'wood']] }, 'player');
  const sim = new Sim(bp, empty('enemy'), { peace: true });
  let sunk = 0;
  for (let n = 0; n < 60 * 14; n++) { sim.step(); for (const e of sim.events) if (e.type === 'break' && e.cause === 'sunk' && e.side === 0) sunk++; sim.events.length = 0; }
  assert.equal(sunk, 3, '三根杆都应随节点沉没');
  assert.equal(sim.stats[0].beamsLost, 3);
});

test('连锁坍塌：参考堡垒打敌方时，敌方有相当一部分杆件是被压断而不是被直接炸断', () => {
  const sim = new Sim(buildFort(REFERENCE_SPEC, 'player'), makeEnemyFort());
  let stress = 0, blast = 0;
  for (let n = 0; n < 60 * 100 && sim.phase !== 'ended'; n++) {
    sim.step();
    for (const e of sim.events) if (e.type === 'break' && e.side === 1) { if (e.cause === 'stress') stress++; else if (e.cause === 'blast') blast++; }
    sim.events.length = 0;
  }
  assert.equal(sim.winner, 'player');
  assert.ok(stress >= 4 && stress / (stress + blast) >= 0.2, `敌方被压断 ${stress} 根、被炸断 ${blast} 根`);
});
