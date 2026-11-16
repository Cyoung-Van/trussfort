// 规则版本。比赛记录要能原样回放，所以规则一旦用于正式比赛就不再改动：
// 要改规则就加一个新版本，旧版本留着，旧记录带着自己的版本号继续按旧规则算。
//
// 这里只放「改了会让同一对堡垒打出不同结果」的开关和数值；
// 材料、火炮的基础数值仍在 config.js（以后它们也要随版本变时再搬进来）。
// 场地（地形、锚点、建造范围、核心范围、预算）不在这里，在地图里（见 map.js）：规则管怎么打，地图管在哪打。

export const RULESETS = {
  // v1：2026-11-15、16 两场模型对抗赛用的规则
  v1: {
    id: 'v1',
    anchorMounts: true,     // 火炮可以架在锚点上
    groundMounts: true,     // 炮座贴着地面也能开火
    pierce: false,          // 炮弹碰到第一根杆就完整引爆
    blastOcclusion: false,  // 溅射只看距离
    assemblyFee: 0,         // 每根杆的装配费
    mergeCollinear: false,  // 同材质共线的杆不合并
    noOverlap: false,       // 允许两根杆叠在同一条线上
    battleTime: 90,         // 交火时限（秒）
    drawMargin: 0,          // 超时判定：核心耐久相差不超过「上限 × 这个比例」算平局
    needCannon: false,      // 参赛堡垒必须至少有一门能开火的炮
    coreZone: false,        // 核心固定在地图给的默认位置
    coreGroundKill: false,  // 核心碰到地面没事
  },
  // v2：2026-11-16 起。把「材料、结构、火力」连起来的第一批修正
  v2: {
    id: 'v2',
    anchorMounts: false,    // 炮座两端都不能是锚点：后坐力必须由自己搭的结构承担
    groundMounts: false,    // 炮座不能贴地：建造时不许放在地面上，战斗中炮座节点触地的炮不能开火
    pierce: true,           // 炮弹带着一份伤害预算：打断一根杆后，剩下的伤害和动量继续往前飞
    blastOcclusion: true,   // 溅射会被中间的杆件挡住（绳索太细，不算）
    assemblyFee: 20,
    mergeCollinear: true,   // 把一根直杆切成几段不再白得耐久：同材质、共线、中间节点没有别的连接的，按一根算
    noOverlap: true,        // 两根杆不能有一段叠在同一条线上（否则同一个位置能叠出好几份耐久和强度）
    battleTime: 120,
    drawMargin: 0.02,
    needCannon: true,
    // 2026-11-16 追加（v2 还没有用于正式比赛，所以直接加在这里）：场地改成可换的地图
    coreZone: true,         // 核心可以放在地图给的核心范围里的任意网格点
    coreGroundKill: true,   // 核心碰到地面就毁：没有水的地图上，核心也得靠结构托在半空
  },
};

export const CURRENT_RULES = 'v2';

/** 取规则：可以传版本号、规则对象，或者不传（当前版本） */
export function getRules(r) {
  if (r && typeof r === 'object') return r;
  return RULESETS[r] || RULESETS[CURRENT_RULES];
}
