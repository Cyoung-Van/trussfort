// 视觉规范：所有模块的颜色都从这里取，不要在别处另起一套。
// 基调：干净、明快、低多边形。蓝图界面是亮钴蓝底白线；实景是晴空、青绿水面、暖色岩壁。

export const THEME = {
  // ---------- 蓝图界面（2D 画布） ----------
  bp: {
    paper: '#2466b8',          // 图纸底色
    paperEdge: '#1b4f96',      // 四角压暗
    gridMinor: 'rgba(255,255,255,0.075)', // 1 米网格
    gridMajor: 'rgba(255,255,255,0.17)',  // 5 米网格
    ink: '#ffffff',            // 主线条
    inkSoft: 'rgba(255,255,255,0.62)',    // 次要线条、标注
    inkFaint: 'rgba(255,255,255,0.28)',
    terrainFill: 'rgba(255,255,255,0.055)', // 山体剖面填充
    terrainHatch: 'rgba(255,255,255,0.20)', // 山体剖面斜线
    water: 'rgba(160,220,255,0.16)',
    waterLine: 'rgba(190,232,255,0.75)',
    zone: 'rgba(255,255,255,0.34)',        // 建造区虚线框
    highlight: '#ffd447',      // 选中 / 悬停 / 价签
    valid: '#8ff0a8',          // 可放置
    invalid: '#ff7a6b',        // 不可放置
    anchor: '#ff8a4c',         // 锚点
    player: '#7fe3ff',         // 我方核心 / 火炮点缀
    enemy: '#ffb19f',          // 敌方堡垒线条（整体偏暖，和我方白线区分）
    enemyDim: 'rgba(255,177,159,0.55)',
    trajectory: '#ffe58a',     // 弹道预览
    trajectoryBlocked: '#ff7a6b',
    mat: {                     // 蓝图里四种杆件的线色
      wood: '#f6dcae',
      steel: '#dcecff',
      rope: '#ffe9b5',
      spring: '#a6f3d6',
    },
    matWidth: { wood: 0.20, steel: 0.15, rope: 0.06, spring: 0.16 }, // 线宽（米，随缩放）
  },

  // ---------- 实景（3D） ----------
  world: {
    skyTop: 0x6ec3ff,
    skyHorizon: 0xdff3ff,
    sun: 0xfff3dc,
    ambientSky: 0xbfe4ff,
    ambientGround: 0x8a7a66,
    fog: 0xd3ecfb,
    water: 0x35b6d6,
    waterDeep: 0x1f8fb8,
    foam: 0xf4fdff,
    rock: 0xb7a48d,
    rockDark: 0x92806c,
    rockWet: 0x6f6a66,
    grass: 0x8fd05a,
    grassDark: 0x6fb244,
    tree: 0x4fa85a,
    trunk: 0x8a6748,
    cloud: 0xffffff,
  },
  // 受力比 → 颜色（0 绿、0.5 黄、0.85 橙、1 红）
  stress: [
    [0.00, 0x3fd06f],
    [0.50, 0xffd43b],
    [0.85, 0xff7b2e],
    [1.00, 0xff2d2d],
  ],
  // 关闭受力显示时的材料本色
  material: {
    wood: 0xd9a066,
    steel: 0x8fa3b8,
    rope: 0xe8d7a8,
    spring: 0x7fd6b4,
    joint: 0x3b4656,
    anchor: 0xff8a4c,
  },
  team: {
    player: 0x24b6ff,
    playerGlow: 0x9be6ff,
    enemy: 0xff6a3d,
    enemyGlow: 0xffc09f,
  },
  cannon: { barrel: 0x2f3a48, carriage: 0x8a6748, band: 0xd9dee5 },
  fx: {
    flash: 0xfff6c8,
    fire: 0xffa23a,
    fireDeep: 0xff5a2a,
    smoke: 0x8e949c,
    smokeDark: 0x5c6168,
    spark: 0xffe27a,
    splash: 0xeaf9ff,
    shock: 0xffffff,
  },
};

// 颜色对受力比略作提亮（<1 的指数）：三四成的受力就能看出偏黄，承重路径一眼可见；
// 两端不变 —— 0 仍是绿，1 仍是红，红了就是要断。
export const STRESS_GAMMA = 0.8;

/** 受力比 → [r, g, b]（0..1，线性插值，sRGB 值）。蓝图和实景共用 */
export function stressRGB(s, out = [0, 0, 0]) {
  const st = THEME.stress;
  if (!(s > 0)) s = 0; else if (s > 1) s = 1;
  s = Math.pow(s, STRESS_GAMMA);
  let i = 1;
  while (i < st.length - 1 && s > st[i][0]) i++;
  const [s0, c0] = st[i - 1], [s1, c1] = st[i];
  const t = (s - s0) / (s1 - s0);
  out[0] = (((c0 >> 16) & 255) + (((c1 >> 16) & 255) - ((c0 >> 16) & 255)) * t) / 255;
  out[1] = (((c0 >> 8) & 255) + (((c1 >> 8) & 255) - ((c0 >> 8) & 255)) * t) / 255;
  out[2] = ((c0 & 255) + ((c1 & 255) - (c0 & 255)) * t) / 255;
  return out;
}
