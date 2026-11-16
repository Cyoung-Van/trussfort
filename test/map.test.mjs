// 地图的无头回归：校验、地形边界、蓝图限制，以及地图贯穿 AI 接口和实战。
import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from '../src/config.js';
import { MAPS, getMap, validateMap } from '../src/map.js';
import { RULESETS } from '../src/rules.js';
import { Blueprint } from '../src/sim/blueprint.js';
import { Sim } from '../src/sim/sim.js';
import { predictShot } from '../src/sim/ballistics.js';
import * as api from '../src/ai/api.js';

const point = (node) => [node.x, node.y];
const refused = (result) => {
  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0, '拒绝时应给出原因');
};

function runToEnd(sim, inspect = () => {}) {
  const limit = Math.ceil((CFG.settleTime + sim.R.battleTime + CFG.stalemateTime + 5) / CFG.dt);
  for (let frame = 0; frame < limit && sim.phase !== 'ended'; frame++) {
    sim.step();
    inspect(sim);
    sim.events.length = 0;
  }
  assert.equal(sim.phase, 'ended', '必须跑完一整场，不能用尚未结束的状态代替结果');
  return sim;
}

// 核心和炮台各自有三角支撑；炮座离地 2 米，炮耳轴在 2.5 米，符合 v2。
function lowFort(angle = 0) {
  return {
    core: [0, 2],
    beams: [
      [[-3, 0], [0, 2], 'steel'], [[0, 0], [0, 2], 'steel'],
      [[3, 0], [3, 2], 'steel'], [[6, 0], [6, 2], 'steel'],
      [[6, 0], [3, 2], 'steel'], [[3, 2], [6, 2], 'steel'],
    ],
    cannons: [[[3, 2], [6, 2], angle]],
  };
}

// 保持旷野默认核心 (2,4) 不动，供 v1/v2 使用完全相同的对手结构。
function heldPlainCore(side, rules) {
  return api.loadFort({ beams: [
    [[0, 0], [1, 2], 'steel'], [[3, 0], [1, 2], 'steel'],
    [[3, 0], [3, 2], 'steel'], [[1, 2], [3, 2], 'steel'],
    [[1, 2], [2, 4], 'steel'], [[3, 2], [2, 4], 'steel'],
  ] }, side, rules, 'plain');
}

// 不复用内置地图的宽度、预算和炮数：验证调用链实际采用传入的数据。
const CUSTOM_MAP = {
  id: 'dry-valley', name: '测试旱谷', fieldW: 38,
  ground: [[-60, 0], [8, 0], [12, -4]], water: null,
  build: { xMin: -8, xMax: 12, yMin: -4, yMax: 12 },
  anchors: [[-6, 0], [-3, 0], [0, 0], [3, 0], [6, 0], [10, -2]],
  coreZone: { xMin: -5, xMax: 7, yMin: 0, yMax: 9 },
  core: [0, 2], budget: 6000, maxCannons: 1,
};

for (const [id, raw] of Object.entries(MAPS)) {
  test(`地图校验：内置 ${id} 合法`, () => {
    assert.equal(validateMap(raw), null);
    assert.equal(getMap(id).id, id);
  });
}

const invalidMaps = [
  ['场宽不是整数', (m) => { m.fieldW = 30.5; }, /场地宽度/],
  ['场宽低于下限', (m) => { m.fieldW = 15; }, /场地宽度/],
  ['场宽超过上限', (m) => { m.fieldW = 61; }, /场地宽度/],
  ['地形横坐标倒退', (m) => { m.ground.push([-1, -13]); }, /x 不能往回走/],
  ['地形越过中线', (m) => { m.ground.push([15.5, -13]); }, /不能越过中线/],
  ['锚点离开地表', (m) => { m.anchors[0] = [-6, 1]; }, /没有贴在地面上/],
  ['锚点在建造区外', (m) => { m.anchors[0] = [-9, 0]; }, /建造范围之外/],
  ['核心范围在建造区外', (m) => { m.coreZone.xMax = 9; }, /核心范围要在建造范围以内/],
  ['默认核心在地里', (m) => {
    // 扩大合法的核心范围，确保拒绝原因确实是入地，而非越界。
    m.coreZone.xMin = -1; m.coreZone.yMin = -2; m.core = [-1, -1];
  }, /核心默认位置不能在地里/],
  ['建造区越过中线', (m) => { m.build.xMax = 16; }, /建造范围太大|越过了中线/],
  ['预算低于下限', (m) => { m.budget = 999; }, /预算/],
  ['预算超过上限', (m) => { m.budget = 200001; }, /预算/],
];
for (const [name, change, reason] of invalidMaps) {
  test(`地图校验：拒绝${name}`, () => {
    const raw = structuredClone(MAPS.strait);
    change(raw);
    const why = validateMap(raw);
    assert.notEqual(why, null);
    assert.match(why, reason);
  });
}

test('地图读取：非法对象抛出带 mapError 的错误', () => {
  assert.throws(() => getMap({ ...structuredClone(MAPS.plain), fieldW: 32.5 }), { mapError: true });
});

test('地图读取：未知名字抛出带 mapError 的错误', () => {
  assert.throws(() => getMap('不存在的测试地图'), { mapError: true });
});

test('海峡地形：崖壁按低侧判入地，按高侧取崖顶', () => {
  const map = getMap('strait');
  assert.equal(map.groundIn(-1), 0);
  assert.equal(map.groundIn(0), -13);
  assert.equal(map.groundTop(0), 0);
  assert.equal(map.groundIn(15), -13);
  assert.equal(map.inside(-1, -1), true);
  assert.equal(map.inside(1, -1), false);
  assert.equal(map.inside(0, -1), false);
});

test('海峡地形：就近推出到崖壁或崖顶，等距优先崖顶，右侧镜像一致', () => {
  const map = getMap('strait');
  assert.deepEqual(map.pushOut(-0.2, -1, {}), { x: 0, y: -1, c: 2 });
  assert.deepEqual(map.pushOut(-1, -0.2, {}), { x: -1, y: 0, c: 1 });
  assert.deepEqual(map.pushOut(-0.5, -0.5, {}), { x: -0.5, y: 0, c: 1 });
  assert.deepEqual(map.pushOut(30.2, -1, {}), { x: 30, y: -1, c: 2 });
});

test('海峡地形：穿山算相交，贴地、贴壁和崖外线段不算', () => {
  const map = getMap('strait');
  for (const [segment, expected] of [
    [[-3, 0, 0, -2], true], [[-3, 0, 0, 0], false],
    [[0, 0, 0, -2], false], [[0, -2, 2, 0], false], [[-1, 1, 1, -2], true],
  ]) assert.equal(map.segCrosses(...segment), expected, `线段 ${segment}`);
});

test('山梁地形：斜坡线性插值、坡顶延伸以及左右镜像', () => {
  const map = getMap('ridge');
  assert.deepEqual(map.ground, [[-60, 0], [9, 0], [14, 7]]);
  assert.equal(map.fieldW, 34);
  assert.equal(map.groundIn(11.5), 3.5);
  assert.equal(map.groundIn(17), 7);
  assert.equal(map.groundIn(34 - 11.5), 3.5);
});

test('山梁地形：坡下的点推出后落在斜坡直线上', () => {
  const map = getMap('ridge');
  assert.equal(map.inside(11.5, 3.4), true);
  const out = map.pushOut(11.5, 3.4, {});
  assert.ok(out.c >= 3, '应该是斜坡接触');
  assert.ok(out.x > 9 && out.x < 14, '投影应在坡段内部');
  assert.ok(Math.abs(out.y - (out.x - 9) * 7 / 5) < 1e-9);
});

test('山梁地形：穿过山梁的线段被挡住，上方线段不被挡住', () => {
  const map = getMap('ridge');
  assert.equal(map.inside(8, 3), false);
  assert.equal(map.inside(26, 3), false);
  assert.equal(map.segCrosses(8, 3, 26, 3), true, '两端在山外，中间仍会穿山');
  assert.equal(map.segCrosses(8, 8, 26, 8), false);
});

test('山梁地形：坡顶折点处的竖直线段也应检测出穿地', () => {
  const map = getMap('ridge');
  assert.equal(map.inside(14, 6), true);
  assert.equal(map.segCrosses(14 - 0.001, 6, 14 - 0.001, 8), true);
  assert.equal(map.segCrosses(14 + 0.001, 6, 14 + 0.001, 8), true);
  assert.deepEqual([map.segCrosses(14, 6, 14, 8), map.segCrosses(20, 6, 20, 8)], [true, true]);
});

for (const id of Object.keys(MAPS)) {
  test(`蓝图 ${id}：锚点和默认核心来自地图，初始校验通过`, () => {
    const bp = new Blueprint('player', 'v2', id), map = getMap(id);
    const anchors = [...bp.nodes.values()].filter((n) => n.kind === 'anchor');
    assert.deepEqual(anchors.map(point), map.anchors);
    assert.equal(bp.nodes.size, map.anchors.length + 1);
    assert.deepEqual(point(bp.coreNode()), map.core);
    assert.equal(bp.validate(), null);
  });

  test(`蓝图 ${id}：不允许在地里添加节点`, () => {
    const bp = new Blueprint('player', 'v2', id);
    const before = bp.nodes.size;
    assert.equal(bp.map.inside(-1, -1), true);
    refused(bp.addNode(-1, -1));
    assert.equal(bp.nodes.size, before);
  });

  test(`蓝图 ${id}：不允许杆件穿过地形`, () => {
    const bp = new Blueprint('player', 'v2', id);
    // 旷野和山梁的建造区下沿就是地面，非法端点无法先建出来；直接检验跨度规则。
    assert.match(bp.checkSpan('steel', -1, 1, -1, -1), /不能穿过山体/);
    if (id === 'strait') {
      // 海峡还可用两个合法锚点构造穿山杆，覆盖 addBeam 的实际拒绝路径。
      const result = bp.addBeam(bp.nodeAt(-3, 0).id, bp.nodeAt(0, -2).id, 'steel');
      refused(result);
      assert.match(result.reason, /不能穿过山体/);
      assert.equal(bp.beams.size, 0);
    }
  });

  test(`蓝图 ${id}：建造区四个方向的越界节点都被拒绝`, () => {
    const bp = new Blueprint('player', 'v2', id), b = bp.map.build;
    const before = bp.nodes.size;
    for (const p of [[b.xMin - 1, 1], [b.xMax + 1, 1], [0, b.yMin - 1], [0, b.yMax + 1]]) {
      const result = bp.addNode(...p);
      refused(result);
      assert.match(result.reason, /超出建造区/);
    }
    assert.equal(bp.nodes.size, before);
  });

  test(`核心 ${id}：v2 可移到范围内的另一个网格点`, () => {
    const bp = new Blueprint('player', 'v2', id);
    const [x, y] = bp.map.core;
    const result = bp.setCore(x + 1, y);
    assert.ok(result.ok, result.reason);
    assert.deepEqual(point(bp.coreNode()), [x + 1, y]);
    assert.equal(bp.validate(), null);
  });

  test(`核心 ${id}：越界和非网格点被拒绝，原位置保留`, () => {
    const bp = new Blueprint('player', 'v2', id);
    const [x, y] = bp.map.core;
    refused(bp.setCore(bp.map.coreZone.xMax + 1, y));
    refused(bp.setCore(x + 0.5, y));
    assert.deepEqual(point(bp.coreNode()), [x, y]);
    assert.equal(bp.validate(), null);
  });

  test(`核心 ${id}：v1 拒绝移动`, () => {
    const bp = new Blueprint('player', 'v1', id);
    const [x, y] = bp.map.core;
    for (const p of [[x + 1, y], [x, y + 1], [x + 0.5, y], [bp.map.coreZone.xMax + 1, y]]) {
      refused(bp.setCore(...p));
    }
    assert.deepEqual(point(bp.coreNode()), [x, y]);
    assert.equal(bp.validate(), null);
  });

  test(`核心 ${id}：loadFort 放置核心，exportFort 往返保留位置和杆件`, () => {
    const [x, y] = getMap(id).core;
    const fort = { core: [x + 1, y], beams: [[[x + 1, y], [x + 1, y + 1], 'steel']] };
    const bp = api.loadFort(fort, 'player', 'v2', id);
    assert.deepEqual(point(bp.coreNode()), fort.core);
    assert.equal(bp.validate(), null);
    const exported = api.exportFort(bp);
    assert.deepEqual(exported.core, fort.core);
    assert.deepEqual(exported.beams, fort.beams);
    const again = api.loadFort(exported, 'player', 'v2', id);
    assert.equal(again.validate(), null);
    assert.deepEqual(api.exportFort(again), exported);
  });
}

test('核心：范围内的锚点和普通地表点都不能放核心', () => {
  const bp = new Blueprint('player', 'v2', CUSTOM_MAP);
  // 两个位置都在 coreZone 内，避免只是因为越界而拒绝。
  assert.equal(bp.nodeAt(3, 0).kind, 'anchor');
  assert.equal(bp.nodeAt(2, 0), null);
  for (const p of [[3, 0], [2, 0]]) {
    assert.equal(bp.map.onSurface(...p), true);
    const result = bp.setCore(...p);
    refused(result);
    assert.match(result.reason, /核心不能贴着地面/);
  }
  assert.deepEqual(point(bp.coreNode()), CUSTOM_MAP.core);
  assert.equal(bp.validate(), null);
});

test('核心：loadFort 拒绝范围外的核心并标记 fortError', () => {
  for (const id of Object.keys(MAPS)) {
    const map = getMap(id);
    assert.throws(() => api.loadFort({ core: [map.coreZone.xMax + 1, map.core[1]], beams: [] }, 'player', 'v2', id), {
      fortError: true, message: /超出核心范围/,
    });
  }
});

test('核心载入：v1 导出的默认核心应能原样载回', () => {
  const bp = new Blueprint('player', 'v1', 'plain');
  const exported = api.exportFort(bp);
  assert.deepEqual(exported.core, getMap('plain').core);
  const restored = api.loadFort(exported, 'player', 'v1', 'plain');
  assert.equal(restored.validate(), null);
  assert.deepEqual(api.exportFort(restored), exported);
});

test('核心触地：旷野 v2 中无支撑的核心落地判负', () => {
  const sim = new Sim(new Blueprint('player', 'v2', 'plain'), heldPlainCore('enemy', 'v2'), {
    seed: 7, rules: 'v2', map: 'plain',
  });
  runToEnd(sim);
  assert.equal(sim.endReason, 'coreGrounded');
  assert.equal(sim.winner, 'enemy');
  assert.equal(sim.cores[0].grounded, true);
  assert.equal(sim.cores[0].alive, false);
  assert.equal(sim.cores[1].alive, true);
  assert.equal(sim.cores[1].grounded, false);
});

test('核心触地：同一张旷野图的 v1 核心可以躺在地上，不因此结束对局', () => {
  const sim = new Sim(new Blueprint('player', 'v1', 'plain'), heldPlainCore('enemy', 'v1'), {
    seed: 7, rules: 'v1', map: 'plain',
  });
  for (let i = 0; i < Math.ceil(4 / CFG.dt); i++) { sim.step(); sim.events.length = 0; }
  const core = sim.cores[0];
  assert.equal(sim.contact[core.node], 1);
  assert.equal(sim.y[core.node], 0);
  assert.equal(core.alive, true);
  assert.equal(core.grounded, false);
  assert.equal(sim.phase, 'fight');
  assert.equal(sim.endReason, null);
  runToEnd(sim);
  assert.equal(sim.endReason, 'stalemate', '最终因双方无炮而结束，并非核心触地');
});

test('无水地图：旷野完整对战中残骸落地，无水花也没有节点沉没', () => {
  assert.equal(getMap('plain').waterY, -Infinity);
  const fort = lowFort();
  // 一根与堡垒完全断开的钢杆，确保测试确实有下落的残骸，而非空查事件。
  fort.beams.push([[-6, 5], [-4, 5], 'steel']);
  const left = api.loadFort(fort, 'player', 'v2', 'plain');
  const sim = new Sim(left, api.loadFort(lowFort(), 'enemy', 'v2', 'plain'), { seed: 7, rules: 'v2', map: 'plain' });
  const ids = [left.nodeAt(-6, 5).id, left.nodeAt(-4, 5).id];
  const debris = [...sim.nodeBpId.keys()].filter((i) => sim.side[i] === 0 && ids.includes(sim.nodeBpId[i]));
  assert.equal(debris.length, 2);
  const initialAlive = [...sim.alive];
  let landed = false, splashes = 0, sinking = 0;
  runToEnd(sim, () => {
    for (const e of sim.events) {
      if (e.type === 'splash') splashes++;
      if (e.cause === 'sunk' || e.type === 'coreSunk') sinking++;
    }
    if (debris.every((i) => sim.contact[i] === 1)) landed = true;
    assert.deepEqual([...sim.alive], initialAlive, '这场对战的节点不应被移除');
  });
  assert.ok(landed, '残骸确实接触过地面');
  assert.equal(splashes, 0);
  assert.equal(sinking, 0);
  assert.ok(sim.wet.every((wet) => wet === 0));
  assert.ok(sim.cores.every((core) => !core.sunk));
  assert.ok(debris.every((i) => sim.alive[i] && Math.abs(sim.y[i]) < 1e-9));
  assert.ok(sim.stats.every((s) => s.shots > 0), '双方确实开过火');
});

test('确定性：山梁上相同堡垒和种子跑完两次，状态指纹相同', () => {
  const a = lowFort(0), b = lowFort(10);
  const fight = () => runToEnd(new Sim(api.loadFort(a, 'player', 'v2', 'ridge'), api.loadFort(b, 'enemy', 'v2', 'ridge'), {
    seed: 19, rules: 'v2', map: 'ridge',
  }));
  const first = fight(), second = fight();
  assert.ok(first.stats.every((s) => s.shots > 0), '指纹要覆盖开火和弹道随机散布');
  assert.ok(Number.isFinite(first.hash()));
  assert.equal(first.hash(), second.hash());
  assert.equal(first.winner, second.winner);
  assert.equal(first.endReason, second.endReason);
  assert.equal(first.frame, second.frame);
  assert.deepEqual(first.stats, second.stats);
});

test('自定义地图：旱谷对象贯穿 checkFort 和 duel，能通过静载并完成实战', () => {
  assert.equal(validateMap(CUSTOM_MAP), null);
  const fort = lowFort();
  const check = api.checkFort(fort, { map: CUSTOM_MAP });
  assert.equal(check.ok, true, check.errors.join('；'));
  assert.equal(check.map, CUSTOM_MAP.id);
  assert.equal(check.budget, CUSTOM_MAP.budget);
  assert.equal(check.static.coreHeld, true);
  assert.equal(check.static.cannonsReady, 1);
  const result = api.duel(fort, fort, { map: CUSTOM_MAP, seed: 7 });
  assert.equal(result.map, CUSTOM_MAP.id);
  assert.equal(result.rules, 'v2');
  assert.notEqual(result.reason, 'unfinished');
  assert.ok(['A', 'B', 'draw'].includes(result.winner));
  assert.ok(result.A.shots > 0 && result.B.shots > 0);
});

test('自定义地图：采用地图预算，超支堡垒不能进入对战', () => {
  const over = lowFort();
  over.beams.push([[-6, 8], [-3, 8], 'steel']);
  const bp = api.loadFort(over, 'player', 'v2', CUSTOM_MAP);
  assert.equal(bp.validate(), null);
  assert.ok(bp.cost() > CUSTOM_MAP.budget && bp.cost() < MAPS.plain.budget, '只超过自定义预算，未超过旧默认预算');
  assert.throws(() => api.duel(over, lowFort(), { map: CUSTOM_MAP }), { fortError: true, message: /A 超出预算/ });
  assert.throws(() => api.duel(lowFort(), over, { map: CUSTOM_MAP }), { fortError: true, message: /B 超出预算/ });
  const check = api.checkFort(over, { map: CUSTOM_MAP });
  assert.equal(check.ok, false);
  assert.ok(check.errors.some((e) => e.includes('超出预算')));
});

test('自定义地图：采用地图火炮上限，第二门炮让 loadFort 抛出 fortError', () => {
  const fort = lowFort();
  fort.beams.push([[-6, 2], [-3, 2], 'steel']);
  fort.cannons.push([[-6, 2], [-3, 2], 0]);
  assert.equal(api.loadFort(fort, 'player', 'v2', 'plain').cannons.size, 2, '炮座本身符合 v2');
  assert.throws(() => api.loadFort(fort, 'player', 'v2', CUSTOM_MAP), { fortError: true, message: /最多 1 门火炮/ });
});

test('炮弹与地形：山梁挡住低位平射，实战命中与弹道预览都报 ground', () => {
  const fort = lowFort();
  const bp = api.loadFort(fort, 'player', 'v2', 'ridge');
  const cannon = [...bp.cannons.values()][0];
  assert.equal(cannon.angle, 0);
  assert.equal(bp.cannonPose(cannon).py, 2.5);
  const shot = predictShot(bp, cannon, api.loadFort(fort, 'enemy', 'v2', 'ridge'));
  assert.equal(shot.end.kind, 'ground');
  assert.ok(shot.end.x >= 9 && shot.end.x <= 25);
  const result = api.duel(fort, fort, { map: 'ridge', seed: 7, timeline: true });
  const hits = result.timeline.filter((e) => e.type === 'hit' && e.what === 'ground');
  assert.ok(hits.some((e) => e.by === 'A' && e.x >= 9 && e.x <= 25), '左侧平射应打在山梁上');
  assert.ok(hits.some((e) => e.by === 'B' && e.x >= 9 && e.x <= 25), '右侧镜像平射也应打在山梁上');
});

test('规则接口：指定旷野时返回无水、可移动核心以及镜像的敌方核心范围', () => {
  const info = api.rules(undefined, 'plain');
  assert.equal(info.version, RULESETS.v2.id);
  assert.equal(info.map.id, 'plain');
  assert.equal(info.map.water, null);
  assert.equal(info.core.movable, true);
  assert.deepEqual(info.core.zone, MAPS.plain.coreZone);
  const zone = MAPS.plain.coreZone, width = MAPS.plain.fieldW;
  assert.deepEqual(info.core.foeZone, {
    xMin: width - zone.xMax, xMax: width - zone.xMin, yMin: zone.yMin, yMax: zone.yMax,
  });
});

// ---- 复核时发现的问题（2026-11-16），各留一条回归测试 ----
test('地图校验：形状不对的数据返回原因，不抛错', () => {
  for (const bad of [{ anchors: [null] }, { anchors: {} }, { core: null }, { coreZone: 5 }, { ground: [null] }, { build: null }]) {
    const why = validateMap({ ...structuredClone(MAPS.plain), ...bad });
    assert.equal(typeof why, 'string', JSON.stringify(bad));
  }
});

test('地图校验：中线上的崖壁、先下后上的缝都不接受（镜像后没有宽度，物理碰不到）', () => {
  assert.match(validateMap({ ...structuredClone(MAPS.plain), ground: [[-60, 0], [16, 0], [16, 10]] }), /中线/);
  assert.match(validateMap({ ...structuredClone(MAPS.plain), ground: [[-60, 0], [10, 0], [10, -5], [10, 3]] }), /两个点/);
});

test('核心触地：一帧中间擦到崖壁又弹开，也算碰到地面', () => {
  // 只用一根杆把核心挂在崖边：它会荡下去撞上崖壁
  const fort = { core: [1, 0], beams: [[[0, 0], [1, 0], 'steel']], cannons: [] };
  const check = api.checkFort(fort, { map: 'strait' });
  assert.equal(check.static.coreHeld, false);
  assert.ok(check.errors.some((e) => /核心没有托住/.test(e)), check.errors.join('；'));
  const r = api.duel(fort, fort, { map: 'strait', allowUnarmed: true });
  assert.equal(r.reason, 'coreGrounded');
});
