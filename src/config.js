// 桁垒 TRUSSFORT — 全局常量。
// 坐标系：米，y 向上。地形、锚点、建造范围、核心范围、预算由地图给出（map.js）。
// 蓝图一律用「己方本地坐标」（像玩家一样朝 +x 开火），敌方在进入世界时做镜像 x' = fieldW - x。

export const CFG = {
  // ---- 场地 ----
  // 场地现在由地图决定（见 map.js）。下面这几项是「海峡」这张图的数值，只剩海峡的手调悬崖画面
  // （render/world-terrain.js）和几处默认值还在读；模拟、蓝图校验、AI 接口都不再用它们。
  fieldW: 30,            // 两座悬崖崖边之间的水面宽度
  waterY: -6,            // 水面高度
  seabedY: -13,
  killY: -11.5,          // 沉到这里以下的节点直接移除
  grid: 1,               // 蓝图网格间距（米）
  build: { xMin: -8, xMax: 8, yMin: -4, yMax: 11 }, // 可建造区域（本地坐标）
  anchors: [[-6, 0], [-3, 0], [0, 0], [0, -2], [0, -4]], // 固定锚点（本地坐标）
  corePos: [4, 3],       // 核心位置（本地坐标，悬在水面上方，必须靠结构托住）
  budget: 20000,         // 敌方样板堡垒约占 97%，起手堡垒约 36%
  maxCannons: 3,
  seed: 20261115,        // 对战随机种子（固定，所以同一张蓝图的结果可复现）

  // ---- 物理 ----
  gravity: 9.81,
  dt: 1 / 60,            // 固定帧步长
  substeps: 24,          // 每帧子步数（XPBD small-steps）
  nodeMass: 4,           // 每个节点的连接件自重 kg
  stressTau: 0.008,      // 杆件受力低通滤波时间常数（秒）：滤掉数值噪声，保留真实冲击
  damagedStrength: 0.3,  // 被打伤的杆件承载力按剩余耐久线性折减，这是耐久见底时还剩的比例
  settleTime: 1.6,       // 开战前的沉降阶段时长（秒）
  gravityRamp: 1.1,      // 重力从 0 平滑加到 1 所用时间（秒），避免突加载荷的 2 倍动力放大
  settleDamping: 5.0,    // 沉降阶段的全局速度阻尼 (1/s)
  airDamping: 0.04,      // 战斗阶段的空气阻尼 (1/s)
  groundFriction: 9.0,   // 节点贴地时的切向速度衰减 (1/s)
  waterGravity: 0.3,     // 水下的等效重力比例（残骸缓慢下沉）
  waterDrag: 2.4,        // 水下速度衰减 (1/s)

  // ---- 对战 ----
  battleTime: 90,        // 交火阶段限时（秒），到时按核心剩余血量判定
  endLinger: 4.0,        // 分出胜负后物理继续跑多久（给坍塌留镜头）
  stalemateTime: 6.0,    // 双方都没炮、场上也没炮弹后多久判定

  // ---- 炮弹 / 爆炸 ----
  shell: {
    speed: 19,           // 炮口初速 m/s
    mass: 22,            // kg，决定后坐力和命中动量
    radius: 0.2,
    grace: 0.22,         // 出膛后这段时间不与自家炮座碰撞
    dispersion: 0.35,    // 射角随机散布（度，种子固定所以可复现）
    directDamage: 110,   // 直接命中的杆件 / 装置受到的伤害
    blastDamage: 60,     // 爆心处的溅射伤害
    blastRadius: 2.4,    // 溅射伤害半径
    impulse: 170,        // 冲击波冲量 N·s（除以节点质量得到速度增量）
    impulseRadius: 3.0,
    maxKick: 14,         // 单次冲击给节点的最大速度增量 m/s
  },
};

// 每种杆件的参数。cost: 每米造价；density: kg/m；EA: 轴向刚度 N；
// strT / strC: 抗拉 / 抗压极限 N；hp: 抗炮击耐久；hitR: 被炮弹命中的半厚度；
// beta: 刚度比例阻尼（秒）。只阻尼杆件的伸缩速率，不阻碍整体下落和转动，
//       所以结构开炮后一两下就稳住（硬），而残骸照样按真实重力坠落。
export const MATERIALS = {
  wood: {
    id: 'wood', name: '木杆', cost: 100, density: 10, EA: 1.6e7,
    strT: 40e3, strC: 40e3, hp: 100, maxLen: 4, hitR: 0.11, beta: 0.025, tensionOnly: false,
  },
  steel: {
    id: 'steel', name: '钢梁', cost: 240, density: 26, EA: 4.8e7,
    strT: 130e3, strC: 130e3, hp: 300, maxLen: 4, hitR: 0.09, beta: 0.025, tensionOnly: false,
  },
  rope: {
    id: 'rope', name: '绳索', cost: 40, density: 1.5, EA: 6e6,
    strT: 45e3, strC: Infinity, hp: 40, maxLen: 8, hitR: 0.05, beta: 0.012, tensionOnly: true,
  },
  spring: {
    id: 'spring', name: '弹簧', cost: 160, density: 8, EA: 1.5e5,
    strT: 22e3, strC: 22e3, hp: 80, maxLen: 3, hitR: 0.12, beta: 0.035, tensionOnly: false,
  },
};
export const MATERIAL_ORDER = ['wood', 'steel', 'rope', 'spring'];

export const CANNON = {
  cost: 1500,
  mass: 480,             // kg，平分到炮座杆件的两个端点上（够重，炮座下面的杆件看得出在受力）
  hp: 200,
  radius: 0.55,          // 被命中的判定半径（以炮耳轴为圆心）
  pivotH: 0.5,           // 炮耳轴离炮座杆件的高度
  barrelLen: 1.5,        // 炮耳轴到炮口的长度
  interval: 4.0,         // 射击间隔（秒）：每一炮的落点都看得清，交火节奏 20~50 秒
  firstDelay: 0.6,       // 开战后第一发的延迟
  stagger: 0.85,         // 同一方多门炮之间的错开时间
  enemyOffset: 0.4,      // 敌方整体再错开一点，避免双方同帧开火
  recoil: 2.0,           // 后坐冲量系数（1 = 炮弹动量；>1 计入火药燃气的附加后坐）
  minBeamLen: 1.4,       // 炮座杆件最短长度
  maxSlopeDeg: 50,       // 炮座杆件最大倾角
  angleMin: -15, angleMax: 88, // 可调射角范围（度，本地坐标，0 = 水平朝向敌方）
  mountMats: ['wood', 'steel'],
};

export const CORE = {
  mass: 380,
  hp: 500,
  radius: 0.7,
};

export const SIDE = { player: 0, enemy: 1 };
export const SIDE_NAME = ['player', 'enemy'];

