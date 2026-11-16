// 平衡回归测试：node --test
// 每条断言的消息都以「目标 N」开头，对应 src/sim/forts.js 顶部写的平衡目标。
import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG, CANNON } from '../src/config.js';
import { getRules } from '../src/rules.js';
import { Blueprint } from '../src/sim/blueprint.js';
import { Sim } from '../src/sim/sim.js';
import { predictShot } from '../src/sim/ballistics.js';
import {
  ENEMY_SPEC, STARTER_SPEC, REFERENCE_SPEC, buildFort,
  makeEnemyFort, makeStarterFort, makeReferenceFort,
} from '../src/sim/forts.js';

const DEG = 180 / Math.PI;
const pct = (bp) => bp.cost() / CFG.budget;

/** 和平模式下沉降 6 秒：返回断杆数和沉降后的峰值受力比 */
function statics(bp) {
  const sim = new Sim(bp.clone('player'), new Blueprint('enemy'), { peace: true });
  let peak = 0;
  for (let f = 0; f < 60 * 6; f++) {
    sim.step(); sim.events.length = 0;
    if (sim.time > 3.5) peak = Math.max(peak, sim.maxStress(0));
  }
  return { lost: sim.stats[0].beamsLost, peak };
}

/** 打一整场，返回胜负、交火时长、双方火炮最大偏转 */
function fight(bpP, bpE, seed = CFG.seed) {
  const sim = new Sim(bpP, bpE, { seed });
  const tilt = [0, 0];
  for (let f = 0; f < 60 * 140 && sim.phase !== 'ended'; f++) {
    sim.step(); sim.events.length = 0;
    if (sim.phase === 'fight') for (const c of sim.cannons) if (c.alive) tilt[c.side] = Math.max(tilt[c.side], Math.abs(c.tilt) * DEG);
  }
  return { sim, winner: sim.winner, reason: sim.endReason, t: sim.fightTime, tilt };
}
const fmt = (r) => `${r.winner}（${r.reason}）交火 ${r.t.toFixed(1)}s`;

// ---------------------------------------------------------------- 目标 1：敌方堡垒
test('目标 1 敌方堡垒：造价与静力', () => {
  const bp = makeEnemyFort();
  const p = pct(bp);
  assert.ok(p >= 0.85 && p <= 1, `目标 1 敌方造价 ${bp.cost()} = ${(p * 100).toFixed(1)}% 预算，应在 85%~100%`);
  const s = statics(bp);
  assert.equal(s.lost, 0, `目标 1 敌方自重下断了 ${s.lost} 根杆`);
  assert.ok(s.peak <= 0.55, `目标 1 敌方静载峰值受力比 ${s.peak.toFixed(3)}，应 ≤ 0.55`);
});

test('目标 1 敌方堡垒：一门高位平射炮 + 一门高抛炮，都打得出自家结构', () => {
  const bp = makeEnemyFort();
  const n = bp.cannons.size;
  assert.ok(n >= 2 && n <= 3, `目标 1 敌方应有 2~3 门炮，现在 ${n} 门`);
  const target = makeStarterFort();
  let flatHigh = false, lob = false;
  for (const c of bp.cannons.values()) {
    const deg = c.angle * DEG;
    const pose = bp.cannonPose(c);
    const shot = predictShot(bp, c, target);
    assert.notEqual(shot.end.kind, 'own', `目标 1 敌方 ${deg.toFixed(1)}° 的炮打在自家结构上 (${shot.end.x.toFixed(1)}, ${shot.end.y.toFixed(1)})`);
    if (deg < 20 && pose.py >= 6) flatHigh = true;
    if (deg > 45) lob = true;
  }
  assert.ok(flatHigh, '目标 1 敌方缺少架在 6 米以上的平射炮（射角 < 20°）');
  assert.ok(lob, '目标 1 敌方缺少高抛炮（射角 > 45°）');
});

test('目标 1 敌方堡垒：无人还击连开完整时限，不被自己的后坐震断', () => {
  // 玩家一侧只有一个钉死、打不坏的核心：敌方一直开火到时限
  const sim = new Sim(new Blueprint('player'), makeEnemyFort(), { seed: CFG.seed });
  const ci = sim.cores[0].node;
  sim.fixed[ci] = 1; sim.w[ci] = 0; sim.cores[0].hp = Infinity;
  let tilt = 0, ownHits = 0;
  // v2 时限从 90 秒延长到 120 秒：必须覆盖完整交火期，不能只验旧规则的前 90 秒。
  const battleTime = getRules().battleTime;
  for (let f = 0; f < 60 * (CFG.settleTime + battleTime + 1); f++) {
    sim.step();
    for (const e of sim.events) if (e.type === 'explode' && e.side === 1 && e.hitSide === 1) ownHits++;
    sim.events.length = 0;
    if (sim.phase === 'fight') for (const c of sim.cannons) if (c.alive && c.side === 1) tilt = Math.max(tilt, Math.abs(c.tilt) * DEG);
  }
  // 原来的 40 发下限只对应旧时限；按最晚首发的炮计算每门应有的完整轮数，v2 两门共 60 发。
  const gunCount = sim.cannons.filter(c => c.side === 1).length;
  const lastFirstShot = CANNON.firstDelay + CANNON.enemyOffset + (gunCount - 1) * CANNON.stagger;
  const minShots = gunCount * (Math.floor((battleTime - lastFirstShot) / CANNON.interval) + 1);
  assert.ok(sim.stats[1].shots >= minShots, `目标 1 ${battleTime} 秒里应开火至少 ${minShots} 发，实际 ${sim.stats[1].shots}`);
  assert.equal(ownHits, 0, `目标 1 敌方炮弹打中自家结构 ${ownHits} 次`);
  assert.equal(sim.stats[1].beamsLost, 0, `目标 1 敌方被自己的后坐震断 ${sim.stats[1].beamsLost} 根杆`);
  assert.equal(sim.stats[1].cannonsLost, 0, '目标 1 敌方无故丢炮');
  assert.ok(tilt < 1.5, `目标 1 敌方炮管最大偏转 ${tilt.toFixed(2)}°，应 < 1.5°`);
});

test('目标 1 敌方堡垒：对付一座没炮的玩家堡垒，打到对方核心被毁也不掉一根杆', () => {
  const unarmed = makeStarterFort();
  unarmed.cannons.clear();
  const r = fight(unarmed, makeEnemyFort());
  assert.equal(r.winner, 'enemy', `目标 1 应由敌方获胜，实际 ${fmt(r)}`);
  assert.equal(r.sim.stats[1].beamsLost, 0, `目标 1 敌方掉了 ${r.sim.stats[1].beamsLost} 根杆`);
  assert.ok(r.tilt[1] < 1.5, `目标 1 敌方炮管最大偏转 ${r.tilt[1].toFixed(2)}°`);
});

// ---------------------------------------------------------------- 目标 2：起手堡垒
test('目标 2 起手堡垒：造价、静力、炮数', () => {
  const bp = makeStarterFort();
  const p = pct(bp);
  assert.ok(p >= 0.3 && p <= 0.45, `目标 2 起手造价 ${bp.cost()} = ${(p * 100).toFixed(1)}% 预算，应在 30%~45%`);
  assert.ok(bp.cannons.size >= 1 && bp.cannons.size <= 2, `目标 2 起手应有 1~2 门炮，现在 ${bp.cannons.size} 门`);
  const s = statics(bp);
  assert.equal(s.lost, 0, `目标 2 起手自重下断了 ${s.lost} 根杆`);
  assert.ok(s.peak < 0.7, `目标 2 起手静载峰值受力比 ${s.peak.toFixed(3)}`);
});

test('目标 2 起手堡垒：输给敌方，但撑 15~45 秒', () => {
  const r = fight(makeStarterFort(), makeEnemyFort());
  assert.equal(r.winner, 'enemy', `目标 2 起手堡垒应该输，实际 ${fmt(r)}`);
  assert.ok(r.t >= 15 && r.t <= 45, `目标 2 起手堡垒交火 ${r.t.toFixed(1)}s，应在 15~45s`);
});

// ---------------------------------------------------------------- 目标 3：参考堡垒
test('目标 3 参考堡垒：预算内、站得住', () => {
  const bp = makeReferenceFort();
  assert.ok(bp.cost() <= CFG.budget, `目标 3 参考造价 ${bp.cost()} 超出预算 ${CFG.budget}`);
  assert.ok(bp.cannons.size <= CFG.maxCannons);
  const s = statics(bp);
  assert.equal(s.lost, 0, `目标 3 参考自重下断了 ${s.lost} 根杆`);
  assert.ok(s.peak <= 0.6, `目标 3 参考静载峰值受力比 ${s.peak.toFixed(3)}`);
  for (const c of bp.cannons.values()) {
    const shot = predictShot(bp, c, buildFort(ENEMY_SPEC, 'enemy'));
    assert.notEqual(shot.end.kind, 'own', `目标 3 参考 ${(c.angle * DEG).toFixed(1)}° 的炮打在自家结构上`);
  }
});

test('目标 3 参考堡垒：默认种子 25~75 秒内获胜，四个种子至少赢三场', () => {
  const runs = [0, 1, 2, 3].map(k => fight(makeReferenceFort(), makeEnemyFort(), CFG.seed + k));
  const r0 = runs[0];
  assert.equal(r0.winner, 'player', `目标 3 默认种子应由参考堡垒获胜，实际 ${fmt(r0)}`);
  assert.ok(r0.t >= 25 && r0.t <= 75, `目标 3 默认种子交火 ${r0.t.toFixed(1)}s，应在 25~75s`);
  const wins = runs.filter(r => r.winner === 'player').length;
  assert.ok(wins >= 3, `目标 3 四个种子只赢了 ${wins} 场：${runs.map(fmt).join('；')}`);
});

// ---------------------------------------------------------------- 目标 4：镜像对战
test('目标 4 镜像：敌方 vs 敌方，多数种子在时限内分出胜负', () => {
  const runs = [0, 1, 2, 3].map(k => fight(makeEnemyFort().clone('player'), makeEnemyFort(), CFG.seed + k));
  const decided = runs.filter(r => r.reason !== 'timeout').length;
  assert.ok(decided >= 3, `目标 4 只有 ${decided}/4 场在时限内结束：${runs.map(fmt).join('；')}`);
});

// 起手和参考堡垒的描述本身也要合法（Blueprint.build 会在违规时抛错）
test('预设描述可以重复构建', () => {
  for (const spec of [ENEMY_SPEC, STARTER_SPEC, REFERENCE_SPEC]) {
    const a = buildFort(spec, 'player').toJSON(), b = buildFort(spec, 'player').toJSON();
    assert.deepEqual(a, b);
  }
  assert.equal(makeReferenceFort('enemy').side, 'enemy');
});
