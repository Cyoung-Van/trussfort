// 预设堡垒。都用己方本地坐标书写（朝 +x 开火），敌方进入世界时自动镜像。
// 锚点：(-6,0) (-3,0) (0,0) (0,-2) (0,-4)；核心固定在 (4,3)。对方核心在本地坐标 (fieldW-4, 3)。

import { CFG } from '../config.js';
import { Blueprint } from './blueprint.js';
import { solveAngle } from './ballistics.js';

const DEG = Math.PI / 180;
// 对方核心在本地坐标里的位置
const FOE_CORE = [CFG.fieldW - CFG.corePos[0], CFG.corePos[1]];

/**
 * 搭好堡垒后给火炮定射角。cannons 的第三项可以是：
 *   数字                      —— 直接指定射角（度）
 *   { at: [x, y], high: bool } —— 瞄准本地坐标里的某一点；high=true 用高抛弹道
 *   { core: true, high, dx, dy } —— 瞄准对方核心（可带偏移）
 */
export function buildFort(spec, side) {
  const plain = { ...spec, cannons: (spec.cannons || []).map(([a, b, aim]) => [a, b, typeof aim === 'number' ? aim : 45]) };
  const bp = Blueprint.build(plain, side);
  const cannons = [...bp.cannons.values()];
  (spec.cannons || []).forEach(([, , aim], i) => {
    if (typeof aim === 'number') return;
    const t = aim.at || [FOE_CORE[0] + (aim.dx || 0), FOE_CORE[1] + (aim.dy || 0)];
    const pose = bp.cannonPose(cannons[i]);
    const ang = solveAngle(pose.px, pose.py, t[0], t[1], !!aim.high);
    if (ang == null) throw new Error(`火炮 ${i}: 打不到目标 (${t})`);
    bp.setCannonAngle(cannons[i].id, ang);
  });
  return bp;
}

// 平衡目标（test/balance.test.mjs 逐条检查）：
//   敌方堡垒：造价 85~100% 预算，自重零断杆、静载受力比 ≤ 0.55，无人还击时连开完整时限（v2 为 120 秒）不被自己的后坐震断。
//   起手堡垒：造价 30~45% 预算，打敌方会输，但要撑 15~45 秒。
//   参考堡垒：会玩的玩家在预算内能搭出的样子，25~75 秒内赢下敌方，换种子也赢。

// ---- 敌方堡垒（玩家第一眼看到的样板）----
// 三层护甲都压在对手两条来袭弹道（平射 ≈ -30° 下坠、高抛 ≈ -65° 落下）穿过的右上象限：
//   外层 O1-O2 / O2-O3 钢板先挨打，中层 E2-E3 钢梁，内层 R4-N6 钢梁贴着核心。
// 两门炮：塔顶平射炮从 9.5 米高处越过自家屋顶直打核心；崖顶臼炮高抛砸屋顶。
// 留给玩家发现的弱点：
//   1. 塔顶炮没有任何顶盖，高抛弹两发就能把它敲掉；
//   2. 炮塔是「刚好够」的静定桁架，没有一根多余的杆：塔身任何一根木杆被打掉，
//      塔顶炮就会歪倒、打偏甚至整座塔塌下来（test/sim.test.mjs 里有这条回归测试）；
//   3. 核心悬在甲板上，甲板下弦（U2-U4、D4-D6 和崖边斜撑）多是木杆，低平射打甲板下方，核心会连笼带塔落水。
export const ENEMY_SPEC = {
  nodes: {
    A6: [-6, 0], A3: [-3, 0], A0: [0, 0], F2: [0, -2], F4: [0, -4], K: [4, 3],
    D2: [2, 0], D4: [4, 0], D6: [6, 0], U2: [2, -2], U4: [4, -2],
    M2: [2, 3], N6: [6, 3], R4: [4, 5],
    E2: [7, 4], E3: [5, 7],
    O1: [8, 2], O2: [8, 6], O3: [6, 8],
    T1: [-1, 3], T3: [1, 6], T4: [3, 6], G1: [2, 9], G2: [4, 9],
    P1: [-5, 2], P2: [-2, 2],
  },
  beams: [
    // 悬臂甲板：上下弦用木，前端钢立杆 D4-U4 和钢斜撑 U4-D6 托住核心正下方。
    // v2 加收装配费后，把三根弦杆和低位臼炮座改木，保留三层钢甲与塔顶钢炮座，总价 19932。
    ['A0', 'D2', 'wood'], ['D2', 'D4', 'wood'], ['D4', 'D6', 'wood'],
    ['F2', 'U2', 'wood'], ['U2', 'U4', 'wood'], ['F4', 'U2', 'wood'],
    ['A0', 'U2', 'wood'], ['F2', 'D2', 'wood'], ['D2', 'U2', 'wood'], ['U2', 'D4', 'wood'],
    ['D4', 'U4', 'steel'], ['U4', 'D6', 'steel'],
    // 核心笼（内层）：钢立柱 + 朝外的钢斜梁 R4-N6
    ['D4', 'K', 'steel'], ['M2', 'K', 'wood'], ['K', 'N6', 'wood'], ['K', 'R4', 'wood'],
    ['D2', 'M2', 'wood'], ['D6', 'N6', 'wood'], ['M2', 'R4', 'wood'], ['R4', 'N6', 'steel'],
    ['N6', 'D4', 'wood'],
    // 中层：E2-E3 钢梁同时横在平射线和高抛线上
    ['N6', 'E2', 'wood'], ['E2', 'E3', 'steel'], ['E3', 'R4', 'wood'],
    // 外层：正面钢墙 O1-O2、斜屋面 O2-O3
    ['D6', 'O1', 'wood'], ['O1', 'N6', 'wood'], ['O1', 'E2', 'wood'], ['O1', 'O2', 'steel'],
    ['O2', 'E2', 'wood'], ['O2', 'O3', 'steel'], ['O3', 'E3', 'wood'],
    // 炮塔：两条腿分别落在崖顶 A0/A3 和核心笼 M2 上，三层三角形，每个节点恰好两根杆托着（静定）
    ['A3', 'T1', 'wood'], ['A0', 'T1', 'wood'], ['T1', 'M2', 'wood'], ['A0', 'M2', 'wood'],
    ['T1', 'T3', 'wood'], ['M2', 'T3', 'wood'], ['M2', 'T4', 'wood'], ['T3', 'T4', 'wood'],
    ['T3', 'G1', 'wood'], ['T4', 'G1', 'wood'], ['T4', 'G2', 'wood'], ['G1', 'G2', 'steel'],
    // 崖顶臼炮台：炮座不能接锚点、不能贴地，所以用两个三角架把炮座 P1-P2 抬到 2 米高，后坐力经四条腿进锚点
    ['A6', 'P1', 'wood'], ['A3', 'P1', 'wood'], ['A3', 'P2', 'wood'], ['A0', 'P2', 'wood'], ['P1', 'P2', 'wood'],
  ],
  cannons: [
    ['G1', 'G2', { core: true, high: false }],
    ['P1', 'P2', { core: true, high: true }],
  ],
};

// ---- 玩家的起手堡垒：能站住、能开火，但明显护不住核心 ----
// 只有一层木壳和两根木挡板（N6-P、X-P），v2 下挨一发会被贯穿，不能挡住整发炮弹；屋顶完全敞开。
// 保留抬高的木臼炮台，总价 8669（43.3% 预算），能开火，但护不住悬空核心。
export const STARTER_SPEC = {
  nodes: {
    A6: [-6, 0], A3: [-3, 0], A0: [0, 0], F2: [0, -2], F4: [0, -4], K: [4, 3],
    D2: [2, 0], D4: [4, 0], U2: [2, -2],
    M2: [2, 3], N6: [6, 3], R4: [4, 5], P: [6, 7], X: [7, 4],
    P1: [-5, 2], P2: [-2, 2],
  },
  beams: [
    ['A0', 'D2', 'wood'], ['D2', 'D4', 'wood'],
    ['F2', 'U2', 'wood'], ['F2', 'D2', 'wood'], ['D2', 'U2', 'wood'], ['U2', 'D4', 'wood'],
    ['D4', 'K', 'wood'], ['D2', 'K', 'wood'],
    ['A0', 'M2', 'wood'], ['M2', 'K', 'wood'], ['M2', 'D2', 'wood'],
    ['D4', 'N6', 'wood'], ['K', 'N6', 'wood'], ['N6', 'R4', 'wood'], ['K', 'R4', 'wood'], ['M2', 'R4', 'wood'],
    ['N6', 'P', 'wood'], ['R4', 'P', 'wood'], ['N6', 'X', 'wood'], ['X', 'P', 'wood'],
    ['A6', 'P1', 'wood'], ['A3', 'P1', 'wood'], ['A3', 'P2', 'wood'], ['A0', 'P2', 'wood'], ['P1', 'P2', 'wood'],
  ],
  cannons: [
    ['P1', 'P2', { core: true, high: true }],
  ],
};

// ---- 参考堡垒：会玩的玩家的答卷 ----
// 不造塔，省下的钱换成三门炮和整套钢甲：
//   抬高的崖顶臼炮 P1-P2 砸对方屋顶；臼炮 P2-P3 高抛敲掉对方没有顶盖的塔顶炮；
//   甲板斜撑上的低平射炮专打对方甲板下方，让对方核心落水。
// 护甲布局和敌方同理（外层钢、中层钢、内层钢），但甲板下弦也换成了钢。
// v2 下保留这套结构和射角，总价 19858；靠先拆炮塔、再打断甲板引发连锁坍塌取胜。
export const REFERENCE_SPEC = {
  nodes: {
    A6: [-6, 0], A3: [-3, 0], A0: [0, 0], F2: [0, -2], F4: [0, -4], K: [4, 3],
    D2: [2, 0], D4: [4, 0], D6: [6, 0], U2: [2, -2], U4: [4, -2],
    M2: [2, 3], N6: [6, 3], R4: [4, 5],
    E2: [7, 4], E3: [5, 7],
    O1: [8, 2], O2: [8, 6], O3: [6, 8],
    P1: [-5, 2], P2: [-2, 2], P3: [1, 2],
  },
  beams: [
    ['A0', 'D2', 'steel'], ['D2', 'D4', 'steel'], ['D4', 'D6', 'wood'],
    ['F2', 'U2', 'steel'], ['U2', 'U4', 'steel'], ['F4', 'U2', 'wood'],
    ['A0', 'U2', 'wood'], ['F2', 'D2', 'wood'], ['D2', 'U2', 'wood'], ['U2', 'D4', 'wood'],
    ['D4', 'U4', 'wood'], ['U4', 'D6', 'steel'],
    ['D4', 'K', 'steel'], ['M2', 'K', 'wood'], ['K', 'N6', 'wood'], ['K', 'R4', 'wood'],
    ['D2', 'M2', 'wood'], ['D6', 'N6', 'wood'], ['M2', 'R4', 'wood'], ['R4', 'N6', 'steel'],
    ['N6', 'D4', 'wood'], ['A0', 'M2', 'wood'],
    ['N6', 'E2', 'wood'], ['E2', 'E3', 'steel'], ['E3', 'R4', 'wood'],
    ['D6', 'O1', 'wood'], ['O1', 'N6', 'wood'], ['O1', 'E2', 'wood'], ['O1', 'O2', 'steel'],
    ['O2', 'E2', 'wood'], ['O2', 'O3', 'steel'], ['O3', 'E3', 'wood'],
    ['A6', 'P1', 'wood'], ['A3', 'P1', 'wood'], ['A3', 'P2', 'wood'], ['A0', 'P2', 'wood'], ['A0', 'P3', 'wood'],
    ['P1', 'P2', 'steel'], ['P2', 'P3', 'steel'],
  ],
  cannons: [
    ['P1', 'P2', { core: true, high: true }],
    // 对方塔顶炮的炮耳轴在对方本地 (3, 9.5)，镜像到己方本地是 (fieldW - 3, 9.5)
    ['P2', 'P3', { at: [CFG.fieldW - 3, 9.5], high: true }],
    // 对方甲板前端斜撑 U4-D6 的中点在对方本地 (5, -1)
    ['U4', 'D6', { at: [CFG.fieldW - 5, -1], high: false }],
  ],
};

export function makeEnemyFort() { return buildFort(ENEMY_SPEC, 'enemy'); }
export function makeStarterFort() { return buildFort(STARTER_SPEC, 'player'); }
export function makeReferenceFort(side = 'player') { return buildFort(REFERENCE_SPEC, side); }
