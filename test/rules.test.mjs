// v2 规则的无头测试：炮座位置、贴地不能开火、炮弹剩余伤害、溅射遮挡、装配费与共线合并、超时平局幅度。
import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG, MATERIALS, CANNON } from '../src/config.js';
import { RULESETS, CURRENT_RULES } from '../src/rules.js';
import { Blueprint } from '../src/sim/blueprint.js';
import { Sim } from '../src/sim/sim.js';
import { checkFort, duel } from '../src/ai/api.js';

const R = RULESETS.v2;
const run = (sim, seconds) => { for (let i = 0, n = Math.round(seconds / CFG.dt); i < n; i++) { sim.step(); sim.events.length = 0; } };
const simBeam = (sim, bp, bm) => sim.beams.find((x) => x.side === 0 && x.bpIds.includes(bm.id));

test('当前规则是 v2', () => { assert.equal(CURRENT_RULES, 'v2'); });

test('炮座：不能接锚点，不能贴地；抬高的台子可以', () => {
  const bp = new Blueprint('player');
  const A6 = bp.nodeAt(-6, 0).id, A3 = bp.nodeAt(-3, 0).id, A0 = bp.nodeAt(0, 0).id;
  const onAnchors = bp.addBeam(A6, A3, 'wood').id;
  assert.equal(bp.checkCannonMount(onAnchors), '炮座不能接在锚点上');
  // 贴地的两种情况各开一张图（它们和上面那根锚点间的杆在同一条线上，新规则不许重叠）
  const flat = new Blueprint('player');
  const f = flat.addBeam(flat.addNode(-5, 0).id, flat.addNode(-2, 0).id, 'wood');   // 整根平放在崖顶上，中间跨过锚点 (-3,0)
  assert.ok(f.ok, f.reason);
  assert.equal(flat.checkCannonMount(f.id), '炮座不能贴着地面');
  const oneEnd = new Blueprint('player');
  const o1 = oneEnd.addBeam(oneEnd.addNode(-2, 0).id, oneEnd.addNode(0, 1).id, 'wood');   // 只有一端在崖顶面上
  assert.ok(o1.ok, o1.reason);
  assert.equal(oneEnd.checkCannonMount(o1.id), '炮座不能贴着地面');
  const P1 = bp.addNode(-5, 2).id, P2 = bp.addNode(-2, 2).id;
  for (const [a, b] of [[A6, P1], [A3, P1], [A3, P2], [A0, P2]]) assert.ok(bp.addBeam(a, b, 'wood').ok);
  const deck = bp.addBeam(P1, P2, 'wood').id;
  assert.equal(bp.checkCannonMount(deck), null);
  assert.ok(bp.addCannon(deck).ok);
  assert.ok(!bp.moveNode(P1, -5, 0).ok, '不能把炮座的一端拖到地面上');
  // 旧规则下前两种都合法
  const old = new Blueprint('player', 'v1');
  const o = old.addBeam(old.nodeAt(-6, 0).id, old.nodeAt(-3, 0).id, 'wood').id;
  assert.equal(old.checkCannonMount(o), null);
});

test('贴地的炮不能开火：没有支撑的炮座掉到崖顶上，一炮不发', () => {
  const bp = new Blueprint('player');
  const a = bp.addNode(-5, 1).id, b = bp.addNode(-2, 1).id;
  const m = bp.addBeam(a, b, 'steel').id;
  assert.ok(bp.addCannon(m, 60 * Math.PI / 180).ok, '建造时离地 1 米，合法');
  const sim = new Sim(bp, new Blueprint('enemy'));
  const pin = (side) => { const c = sim.cores[side]; sim.fixed[c.node] = 1; sim.w[c.node] = 0; };
  pin(0); pin(1);
  run(sim, CFG.settleTime + 10);
  const c = sim.cannons[0];
  assert.ok(c.alive && c.grounded, '炮还在，但炮座贴地');
  assert.equal(c.shots, 0);
  // 同一座「堡垒」交给检查接口：没有能开火的炮，不合规
  const chk = checkFort({ beams: [[[-5, 1], [-2, 1], 'steel'], [[0, 0], [2, 0], 'steel'], [[2, 0], [4, 3], 'steel'], [[0, 0], [4, 3], 'rope'], [[0, -2], [2, 0], 'steel']], cannons: [[[-5, 1], [-2, 1], 60]] });
  assert.ok(!chk.ok && chk.errors.some((e) => e.includes('没有一门炮能开火')), chk.errors.join('；'));
  assert.equal(chk.static.cannonsReady, 0);
});

test('剩余伤害：打断耐久不够的杆后带着剩下的继续飞，够硬的杆把它拦下', () => {
  const bp = new Blueprint('player');
  const A0 = bp.nodeAt(0, 0).id;
  const n1 = bp.addNode(2, 2).id, n2 = bp.addNode(2, 0).id;
  const rope = bp.addBeam(A0, n1, 'rope'), steel = bp.addBeam(A0, n2, 'steel');
  bp.addBeam(n1, n2, 'steel');
  const sim = new Sim(bp, new Blueprint('enemy'), { peace: true });
  const rb = simBeam(sim, bp, bp.beams.get(rope.id)), sb = simBeam(sim, bp, bp.beams.get(steel.id));
  const budget = CFG.shell.directDamage;
  const s = { id: 99, side: 1, cannon: 0, mount: -1, x: 1, y: 1, ox: 1, oy: 1, vx: -10, vy: 0, age: 1, alive: true, dmg: budget, scored: false };
  const stopped = sim._hitBeam(s, rb);
  assert.equal(stopped, false, '绳索（耐久 40）拦不住一整发');
  assert.ok(!rb.alive && s.alive);
  assert.equal(s.dmg, budget - MATERIALS.rope.hp);
  assert.ok(Math.abs(s.vx - -10 * Math.sqrt((budget - MATERIALS.rope.hp) / budget)) < 1e-9, '按用掉的份额减速');
  assert.equal(sim.stats[1].hits, 1);
  const left = s.dmg;
  assert.equal(sim._hitBeam(s, sb), true, '钢杆（耐久 300）把剩下的吃掉');
  assert.ok(!s.alive && sb.alive);
  assert.ok(Math.abs(sb.hp - (MATERIALS.steel.hp - left)) < 1e-9);
  assert.equal(sim.stats[1].hits, 1, '一发炮弹只算一次命中');
  // 旧规则：碰到第一根就引爆，直击伤害全给它
  const bp1 = Blueprint.fromJSON(bp.toJSON(), 'player', 'v1');
  const sim1 = new Sim(bp1, new Blueprint('enemy', 'v1'), { peace: true });
  const s1 = { ...s, alive: true, dmg: budget, scored: false, vx: -10 };
  assert.equal(sim1._hitBeam(s1, simBeam(sim1, bp1, bp1.beams.get(rope.id))), true);
  assert.ok(!s1.alive);
});

test('溅射遮挡：钢板后面的木杆不吃溅射，绳索不算遮挡', () => {
  const build = (wallMat) => {
    const bp = new Blueprint('player');
    const A0 = bp.nodeAt(0, 0).id, F2 = bp.nodeAt(0, -2).id;
    const t = bp.addNode(2, 0).id, w1 = bp.addNode(2, 2).id, v1 = bp.addNode(4, 0).id, v2 = bp.addNode(4, 2).id;
    bp.addBeam(A0, t, 'steel'); bp.addBeam(F2, t, 'steel');
    const wall = bp.addBeam(t, w1, wallMat);       // 竖在 x=2 的墙
    bp.addBeam(A0, w1, 'steel');
    bp.addBeam(t, v1, 'steel'); bp.addBeam(w1, v2, 'steel');
    const victim = bp.addBeam(v1, v2, 'wood');     // 墙后 2 米处的木杆
    return { bp, wall, victim };
  };
  const hpAfter = (wallMat, occlude) => {
    const { bp, victim } = build(wallMat);
    const sim = new Sim(bp, new Blueprint('enemy'), { peace: true });
    sim._blast(3.2, 1, null, 60, 2.4, 0, 3, null, null, occlude);   // 爆点在墙和木杆之间偏木杆一侧？不：x=3.2 在墙的右边
    return simBeam(sim, bp, bp.beams.get(victim.id)).hp;
  };
  // 爆点在墙的左边（x=1.2），木杆在墙的右边（x=4）
  const behind = (wallMat, occlude) => {
    const { bp, victim } = build(wallMat);
    const sim = new Sim(bp, new Blueprint('enemy'), { peace: true });
    sim._blast(1.9, 1, null, 60, 2.4, 0, 3, null, null, occlude);
    return simBeam(sim, bp, bp.beams.get(victim.id)).hp;
  };
  assert.ok(hpAfter('steel', true) < MATERIALS.wood.hp, '没有东西挡着时照常受伤');
  assert.equal(behind('steel', true), MATERIALS.wood.hp, '钢墙挡住了');
  assert.ok(behind('steel', false) < MATERIALS.wood.hp, '关掉遮挡（旧规则）就挡不住');
  assert.ok(behind('rope', true) < MATERIALS.wood.hp, '绳索不算遮挡');
});

test('装配费与共线合并：切成两段的直杆按一根算', () => {
  const fee = R.assemblyFee;
  const bp = new Blueprint('player');
  const A0 = bp.nodeAt(0, 0).id;
  const m = bp.addNode(2, 0).id, e = bp.addNode(4, 0).id;
  const b1 = bp.addBeam(A0, m, 'wood'), b2 = bp.addBeam(m, e, 'wood');
  assert.equal(bp.mergeGroups().length, 1);
  assert.equal(bp.cost(), 400 + fee, '两段共 4 米木杆，只收一次装配费');
  assert.equal(bp.breakdown().assembly, fee);
  let sim = new Sim(bp, new Blueprint('enemy'), { peace: true });
  const mine = sim.beams.filter((b) => b.side === 0);
  assert.equal(mine.length, 1, '模拟里是一根杆');
  assert.equal(mine[0].hpMax, MATERIALS.wood.hp, '只有一份耐久');
  assert.deepEqual([...mine[0].bpIds].sort(), [b1.id, b2.id].sort());
  assert.ok(Math.abs(mine[0].rest - 4) < 1e-9);
  // 中间节点接上斜撑，就是真正的两根杆了
  const F2 = bp.nodeAt(0, -2).id;
  assert.ok(bp.addBeam(F2, m, 'wood').ok);
  assert.equal(bp.mergeGroups().length, 3);
  assert.equal(bp.cost(), 400 + Math.round(100 * Math.hypot(2, 2)) + 3 * fee);
  sim = new Sim(bp, new Blueprint('enemy'), { peace: true });
  assert.equal(sim.beams.filter((b) => b.side === 0).length, 3);
  // 材质不同、不共线、合起来超长，都不合并
  const bp2 = new Blueprint('player');
  const a0 = bp2.nodeAt(0, 0).id, m2 = bp2.addNode(3, 0).id, e2 = bp2.addNode(6, 0).id;
  bp2.addBeam(a0, m2, 'wood'); bp2.addBeam(m2, e2, 'wood');
  assert.equal(bp2.mergeGroups().length, 2, '合起来 6 米，超过木杆 4 米的上限');
  // 旧规则：不合并，不收装配费
  const old = Blueprint.fromJSON(bp.toJSON(), 'player', 'v1');
  assert.equal(old.mergeGroups().length, 3);
  assert.equal(old.cost(), 400 + Math.round(100 * Math.hypot(2, 2)));
});

test('超时判定：核心耐久相差 2% 以内算平局', () => {
  const mk = (rules) => new Sim(new Blueprint('player', rules), new Blueprint('enemy', rules), { rules });
  let sim = mk('v2'); sim.cores[0].hp = 300; sim.cores[1].hp = 308; sim._endByHp('timeout');
  assert.equal(sim.winner, 'draw');
  sim = mk('v2'); sim.cores[0].hp = 300; sim.cores[1].hp = 312; sim._endByHp('timeout');
  assert.equal(sim.winner, 'enemy');
  sim = mk('v1'); sim.cores[0].hp = 300; sim.cores[1].hp = 308; sim._endByHp('timeout');
  assert.equal(sim.winner, 'enemy', '旧规则没有平局幅度');
  assert.equal(mk('v2').timeLeft, 120);
  assert.equal(mk('v1').timeLeft, 90);
});

test('参赛堡垒至少要有一门火炮', () => {
  const noGun = { beams: [[[0, 0], [2, 0], 'steel'], [[2, 0], [4, 3], 'steel'], [[0, 0], [2, 3], 'steel'], [[2, 3], [4, 3], 'steel'], [[0, -2], [2, 0], 'steel'], [[2, 0], [2, 3], 'steel']], cannons: [] };
  assert.throws(() => duel(noGun, noGun), /没有火炮/);
  assert.ok(checkFort(noGun).errors.some((e) => e.includes('至少要有一门火炮')));
  assert.doesNotThrow(() => duel(noGun, noGun, { rules: 'v1' }));
});

// ---------------------------------------------------------------- 代码审查提出的几种绕过方式

test('悬在崖边、中段搭在崖角上的炮座也算贴地', () => {
  // 一根没有任何支撑的钢杆，从崖顶上方 (-2,3) 斜伸到崖外 (1,1)：落下后两端都不着地，是杆件中段搭在崖角上
  const fort = {
    beams: [[[-2, 3], [1, 1], 'steel'], [[0, 0], [2, 0], 'steel'], [[2, 0], [4, 3], 'steel'], [[0, 0], [2, 3], 'steel'], [[2, 3], [4, 3], 'steel'], [[0, -2], [2, 0], 'steel'], [[2, 0], [2, 3], 'steel']],
    cannons: [[[-2, 3], [1, 1], 60]],
  };
  const chk = checkFort(fort);
  assert.equal(chk.static.cannonsReady, 0, '沉降后这门炮应判定为贴地');
  assert.ok(!chk.ok);
  assert.throws(() => duel(fort, fort), /没有一门炮能开火/, '对战接口也要拦住');
});

test('杆件不能重叠：直杆上再叠一根、或者经过中间节点叠一段，都不行', () => {
  const bp = new Blueprint('player');
  const a = bp.addNode(1, 2).id, m = bp.addNode(2, 2).id, b = bp.addNode(3, 2).id;
  assert.ok(bp.addBeam(a, b, 'steel').ok);
  assert.equal(bp.addBeam(a, m, 'wood').reason, '和已有杆件重叠');
  // 只共用端点、方向不同，不算重叠
  const c = bp.addNode(3, 4).id;
  assert.ok(bp.addBeam(a, c, 'wood').ok);
  assert.ok(bp.addBeam(b, c, 'wood').ok);
  // 把节点拖到已有杆件的线上也不行
  assert.equal(bp.moveNode(c, 5, 2).reason, '和已有杆件重叠');
  assert.equal(bp.validate(), null);
  // 旧规则允许重叠
  const old = new Blueprint('player', 'v1');
  const a1 = old.addNode(1, 2).id, m1 = old.addNode(2, 2).id, b1 = old.addNode(3, 2).id;
  assert.ok(old.addBeam(a1, b1, 'steel').ok && old.addBeam(a1, m1, 'wood').ok && old.addBeam(m1, b1, 'wood').ok);
  // 同一份数据拿到新规则下，校验不通过
  assert.equal(Blueprint.fromJSON(old.toJSON(), 'player', 'v2').validate(), '有杆件重叠');
});

test('模拟按自己的规则归并：v1 的蓝图用 v2 规则模拟，共线的两段也只有一份耐久', () => {
  const bp = new Blueprint('player', 'v1');
  const A0 = bp.nodeAt(0, 0).id, m = bp.addNode(2, 0).id, e = bp.addNode(4, 0).id;
  bp.addBeam(A0, m, 'wood'); bp.addBeam(m, e, 'wood');
  assert.equal(new Sim(bp, new Blueprint('enemy', 'v1'), { peace: true }).beams.filter((b) => b.side === 0).length, 2);
  assert.equal(new Sim(bp, new Blueprint('enemy', 'v1'), { peace: true, rules: 'v2' }).beams.filter((b) => b.side === 0).length, 1);
});

test('溅射遮挡：恰好躺在射线上的杆也算挡住', () => {
  const bp = new Blueprint('player');
  const A0 = bp.nodeAt(0, 0).id;
  const p = bp.addNode(1, 2).id, q = bp.addNode(2, 2).id;
  bp.addBeam(A0, p, 'steel'); bp.addBeam(A0, q, 'steel'); bp.addBeam(p, q, 'steel');
  const sim = new Sim(bp, new Blueprint('enemy'), { peace: true });
  assert.equal(sim._blocked(0, 2, 3, 2, null), true, '(1,2)-(2,2) 躺在 (0,2)→(3,2) 上');
  assert.equal(sim._blocked(0, 2.5, 3, 2.5, null), false, '平行但不在同一条线上');
});

test('旧规则的超时判定边界没有变：差一丁点也分胜负', () => {
  const sim = new Sim(new Blueprint('player', 'v1'), new Blueprint('enemy', 'v1'), { rules: 'v1' });
  sim.cores[0].hp = 2e-6; sim.cores[1].hp = 1e-6; sim._endByHp('timeout');
  assert.equal(sim.winner, 'player');
});

test('搭建先后不影响结果（含共线合并）：同一个形状正着搭、反着搭，对战指纹相同', () => {
  const beams = [[[0, 0], [2, 0], 'steel'], [[2, 0], [4, 0], 'steel'], [[0, -2], [2, 0], 'steel'], [[2, 0], [4, 3], 'steel'], [[0, 0], [2, 3], 'steel'], [[2, 3], [4, 3], 'steel'], [[2, 0], [2, 3], 'steel'],
    [[0, 0], [1, 2], 'wood'], [[1, 2], [2, 4], 'wood'], [[2, 3], [2, 4], 'wood'], [[2, 4], [4, 4], 'wood'], [[4, 3], [4, 4], 'wood'], [[2, 3], [4, 4], 'wood']];
  const cannons = [[[2, 4], [4, 4], 30]];
  const run1 = (list) => { const r = duel({ beams: list, cannons }, { beams: list, cannons }, { seed: 7 }); return JSON.stringify([r.winner, r.reason, r.fightSeconds, r.A.coreHp, r.B.coreHp, r.A.membersLost, r.B.membersLost]); };
  assert.equal(run1(beams), run1([...beams].reverse()));
});
