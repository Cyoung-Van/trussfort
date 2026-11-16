// 地图：场地是一份数据，不是写死的常量。
//
// 一张地图只描述「己方半场」，用己方本地坐标（朝 +x 开火）；对方半场是它关于中线 x = fieldW / 2 的镜像，
// 所以两边永远对称，同一份堡垒放在左边或右边都能用。
//
//   {
//     id, name,
//     fieldW,                  // 双方本地原点之间的距离（米）。对方的点 (x, y) 在世界里是 (fieldW - x, y)
//     ground: [[x, y], ...],   // 地面轮廓，从己方后方画到中线，x 不能往回走（可以有竖直的崖壁）。
//                              // 第一个点往左、最后一个点到中线都按水平延伸。轮廓下方是实心的地
//     water: 数字 | null,      // 水面高度；null 表示这张图没有水
//     build: { xMin, xMax, yMin, yMax },     // 可建造范围
//     anchors: [[x, y], ...],  // 锚点，必须贴在地面上
//     coreZone: { xMin, xMax, yMin, yMax },  // 核心可以放的范围
//     core: [x, y],            // 核心的默认位置
//     budget, maxCannons,
//   }
//
// 这个文件不依赖浏览器。模拟、蓝图校验、弹道预览和画面都从这里取地形。

const EPS = 1e-6;
const FAR = 1000;   // 轮廓两头往外延伸多远

export const MAPS = {
  // 海峡：两座悬崖隔水相望，核心悬在水面上方。2026-11 的比赛记录都打在这张图上，地形和锚点不能再动
  strait: {
    id: 'strait', name: '海峡',
    fieldW: 30,
    ground: [[-60, 0], [0, 0], [0, -13]],
    water: -6,
    build: { xMin: -8, xMax: 8, yMin: -4, yMax: 11 },
    anchors: [[-6, 0], [-3, 0], [0, 0], [0, -2], [0, -4]],
    coreZone: { xMin: 1, xMax: 7, yMin: 0, yMax: 7 },
    core: [4, 3],
    budget: 20000, maxCannons: 3,
  },
  // 旷野：一马平川，没有水。平射毫无遮挡，核心离地两米以上
  plain: {
    id: 'plain', name: '旷野',
    fieldW: 32,
    ground: [[-60, 0]],
    water: null,
    build: { xMin: -8, xMax: 8, yMin: 0, yMax: 12 },
    anchors: [[-6, 0], [-3, 0], [0, 0], [3, 0], [6, 0]],
    coreZone: { xMin: -4, xMax: 6, yMin: 2, yMax: 8 },
    core: [2, 4],
    budget: 20000, maxCannons: 3,
  },
  // 山梁：中间横着一道七米高的土梁，没有水。低处的平射全被挡住，要么造高塔，要么吊射
  ridge: {
    id: 'ridge', name: '山梁',
    fieldW: 34,
    ground: [[-60, 0], [9, 0], [14, 7]],
    water: null,
    build: { xMin: -8, xMax: 8, yMin: 0, yMax: 13 },
    anchors: [[-6, 0], [-3, 0], [0, 0], [3, 0], [6, 0]],
    coreZone: { xMin: -5, xMax: 6, yMin: 2, yMax: 9 },
    core: [1, 4],
    budget: 20000, maxCannons: 3,
  },
};
export const MAP_ORDER = ['strait', 'plain', 'ridge'];
export const DEFAULT_MAP = 'strait';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => isNum(v) && Math.abs(v - Math.round(v)) < 1e-9;
const isRect = (r) => r && isInt(r.xMin) && isInt(r.xMax) && isInt(r.yMin) && isInt(r.yMax) && r.xMin < r.xMax && r.yMin < r.yMax;
const inRect = (r, x, y) => x >= r.xMin - EPS && x <= r.xMax + EPS && y >= r.yMin - EPS && y <= r.yMax + EPS;

/** 把地面轮廓补齐：左边延伸到很远，右边延伸到中线 */
function fullGround(raw) {
  const pts = raw.ground.map(([x, y]) => [x, y]);
  if (pts[0][0] > -FAR) pts.unshift([-FAR, pts[0][1]]);
  const half = raw.fieldW / 2;
  if (pts[pts.length - 1][0] < half - EPS) pts.push([half, pts[pts.length - 1][1]]);
  return pts;
}

/**
 * 检查一份地图数据。返回 null 表示可用，否则返回第一条问题（给人看的中文短语）。
 * 自定义地图进游戏之前都要过这一关。
 */
export function validateMap(raw) {
  // 数据的形状千奇百怪（导入的文件、手写的 JSON）：任何没料到的形状都按「格式不对」处理，而不是抛错
  try { return validateMapInner(raw); } catch { return '地图数据的格式不对'; }
}
function validateMapInner(raw) {
  if (!raw || typeof raw !== 'object') return '地图必须是一个对象';
  if (!isInt(raw.fieldW) || raw.fieldW < 16 || raw.fieldW > 60) return '场地宽度要是 16 到 60 之间的整数';
  const half = raw.fieldW / 2;
  if (!Array.isArray(raw.ground) || raw.ground.length < 1 || raw.ground.length > 40) return '地面轮廓要有 1 到 40 个点';
  let px = -Infinity, py = null;
  for (const p of raw.ground) {
    if (!Array.isArray(p) || !isNum(p[0]) || !isNum(p[1])) return '地面轮廓的点应为 [x, y]';
    if (Math.abs(p[0] * 2 - Math.round(p[0] * 2)) > 1e-9 || Math.abs(p[1] * 2 - Math.round(p[1] * 2)) > 1e-9) return '地面轮廓的点要落在半米网格上';
    if (p[0] < -FAR || p[0] > half + EPS) return '地面轮廓不能越过中线';
    if (p[1] < -40 || p[1] > 40) return '地面高度要在 -40 到 40 之间';
    if (p[0] < px - EPS) return '地面轮廓的 x 不能往回走';
    if (Math.abs(p[0] - px) < EPS && Math.abs(p[1] - py) < EPS) return '地面轮廓有重复的点';
    px = p[0]; py = p[1];
  }
  // 同一个 x 上最多两个点（一道崖壁）。三个以上就是先下后上的缝或者刺，没有宽度，物理碰不到它
  for (let i = 2; i < raw.ground.length; i++) {
    if (Math.abs(raw.ground[i][0] - raw.ground[i - 2][0]) < EPS) return '同一个位置最多放两个点（一道崖壁），不能折回去';
  }
  // 中线上不能有崖壁：镜像之后它会变成一道没有宽度的墙
  const gl = raw.ground.length;
  if (gl >= 2 && raw.ground[gl - 1][0] > half - EPS && raw.ground[gl - 2][0] > half - EPS) return '中线上不能有竖直的崖壁';
  if (!(raw.water === null || raw.water === undefined || (isNum(raw.water) && raw.water >= -40 && raw.water <= 40))) return '水面高度无效';
  if (!isRect(raw.build)) return '建造范围无效';
  const B = raw.build;
  if (B.xMin < -30 || B.xMax > half - 1 || B.yMin < -30 || B.yMax > 40) return '建造范围太大，或者越过了中线（离中线至少留 1 米）';
  if (B.xMax - B.xMin > 30 || B.yMax - B.yMin > 30) return '建造范围最多 30 米见方';
  if (!Array.isArray(raw.anchors) || raw.anchors.length < 1 || raw.anchors.length > 12) return '锚点要有 1 到 12 个';
  for (const a of raw.anchors) if (!Array.isArray(a) || !isInt(a[0]) || !isInt(a[1])) return '锚点应为整数坐标 [x, y]';
  if (!isRect(raw.coreZone)) return '核心范围无效';
  if (!Array.isArray(raw.core) || !isInt(raw.core[0]) || !isInt(raw.core[1])) return '核心默认位置应为整数坐标 [x, y]';
  const M = compileUnchecked(raw);
  const seen = new Set();
  for (const a of raw.anchors) {
    if (!inRect(B, a[0], a[1])) return `锚点 (${a}) 在建造范围之外`;
    if (!M.onSurface(a[0], a[1])) return `锚点 (${a}) 没有贴在地面上`;
    const k = a[0] + ',' + a[1];
    if (seen.has(k)) return '锚点重复';
    seen.add(k);
  }
  const Z = raw.coreZone;
  if (Z.xMin < B.xMin || Z.xMax > B.xMax || Z.yMin < B.yMin || Z.yMax > B.yMax) return '核心范围要在建造范围以内';
  if (!inRect(Z, raw.core[0], raw.core[1])) return '核心默认位置要在核心范围以内';
  if (M.inside(raw.core[0], raw.core[1]) || M.onSurface(raw.core[0], raw.core[1])) return '核心默认位置不能在地里或贴着地面';
  if (seen.has(raw.core[0] + ',' + raw.core[1])) return '核心默认位置和锚点重叠';
  if (M.hasWater && raw.core[1] <= M.waterY) return '核心默认位置不能在水面以下';
  if (!isInt(raw.budget) || raw.budget < 1000 || raw.budget > 200000) return '预算要是 1000 到 200000 之间的整数';
  if (!isInt(raw.maxCannons) || raw.maxCannons < 1 || raw.maxCannons > 8) return '火炮上限要是 1 到 8';
  return null;
}

function compileUnchecked(raw) {
  const W = raw.fieldW;
  const local = fullGround(raw);
  // 世界轮廓：己方半场 + 镜像的对方半场，从左到右
  const pts = local.map(([x, y]) => [x, y]);
  for (let i = local.length - 1; i >= 0; i--) pts.push([W - local[i][0], local[i][1]]);
  // 去掉重复的点，合并共线的相邻段（中线两侧的水平段会并成一段）
  const clean = [];
  for (const p of pts) {
    const q = clean[clean.length - 1];
    if (q && Math.abs(q[0] - p[0]) < EPS && Math.abs(q[1] - p[1]) < EPS) continue;
    const o = clean[clean.length - 2];
    if (o && Math.abs((q[0] - o[0]) * (p[1] - o[1]) - (q[1] - o[1]) * (p[0] - o[0])) < 1e-9
      && (q[0] - o[0]) * (p[0] - q[0]) + (q[1] - o[1]) * (p[1] - q[1]) > 0) clean.pop();
    clean.push(p);
  }
  const segs = [];
  let gMax = -Infinity, gMin = Infinity;
  for (let i = 0; i < clean.length - 1; i++) {
    const [ax, ay] = clean[i], [bx, by] = clean[i + 1];
    const ex = bx - ax, ey = by - ay, len = Math.hypot(ex, ey);
    const kind = ay === by ? 'h' : ax === bx ? 'v' : 's';
    segs.push({
      i, ax, ay, bx, by, ex, ey, len2: ex * ex + ey * ey, kind,
      yLo: Math.min(ay, by), yHi: Math.max(ay, by),
      tx: ex / len, ty: ey / len,          // 沿地面的切向
      walk: Math.abs(ex / len) > 0.5,      // 坡度不到 60 度：按地面处理摩擦；更陡的按崖壁
      slope: kind === 's' ? ey / ex : 0,
    });
    gMax = Math.max(gMax, ay, by); gMin = Math.min(gMin, ay, by);
  }
  const flat = segs.filter((s) => s.kind !== 'v');   // 能回答「x 处地面多高」的段
  const hasWater = isNum(raw.water);
  const waterY = hasWater ? raw.water : -Infinity;

  const yAt = (s, x) => (s.kind === 'h' ? s.ay : s.ay + (x - s.ax) * s.slope);
  /** x 处的地面高度。正好在崖壁上时取低的那一侧（崖壁本身不算在地里） */
  const groundIn = (x) => {
    let g = Infinity;
    for (let k = 0; k < flat.length; k++) {
      const s = flat[k];
      if (x >= s.ax && x <= s.bx) { const v = yAt(s, x); if (v < g) g = v; }
    }
    return g === Infinity ? (x < flat[0].ax ? flat[0].ay : flat[flat.length - 1].by) : g;
  };
  /** x 处的地面高度。正好在崖壁上时取高的那一侧（画面和取景用） */
  const groundTop = (x) => {
    let g = -Infinity;
    for (let k = 0; k < flat.length; k++) {
      const s = flat[k];
      if (x >= s.ax && x <= s.bx) { const v = yAt(s, x); if (v > g) g = v; }
    }
    return g === -Infinity ? (x < flat[0].ax ? flat[0].ay : flat[flat.length - 1].by) : g;
  };
  const inside = (x, y) => y < groundIn(x) - EPS;

  /**
   * 把陷进地里的点推到最近的地表。结果写进 out：{ x, y, c }。
   * c 是接触类型：1 = 水平地面，2 = 竖直崖壁，3 + 段号 = 斜坡。
   * 水平段只改 y、竖直段只改 x，另一个坐标原样返回（不经过任何运算），这样旧地图上的结果和以前逐位相同。
   */
  const pushOut = (x, y, out) => {
    let best = Infinity, bx = x, by = y, bc = 0, bh = false;
    for (let k = 0; k < segs.length; k++) {
      const s = segs[k];
      let cx, cy, d, c;
      if (s.kind === 'h') {
        cy = s.ay; c = 1;
        if (x < s.ax) { cx = s.ax; d = Math.hypot(x - cx, y - cy); }
        else if (x > s.bx) { cx = s.bx; d = Math.hypot(x - cx, y - cy); }
        else { cx = x; d = Math.abs(y - cy); }
      } else if (s.kind === 'v') {
        cx = s.ax; c = 2;
        if (y < s.yLo) { cy = s.yLo; d = Math.hypot(x - cx, y - cy); }
        else if (y > s.yHi) { cy = s.yHi; d = Math.hypot(x - cx, y - cy); }
        else { cy = y; d = Math.abs(x - cx); }
      } else {
        let t = ((x - s.ax) * s.ex + (y - s.ay) * s.ey) / s.len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        cx = s.ax + s.ex * t; cy = s.ay + s.ey * t; c = 3 + k;
        d = Math.hypot(x - cx, y - cy);
      }
      // 一样近时优先落到水平面上（和旧规则「崖顶优先于崖壁」一致）
      if (d < best || (d === best && s.kind === 'h' && !bh)) { best = d; bx = cx; by = cy; bc = c; bh = s.kind === 'h'; }
    }
    out.x = bx; out.y = by; out.c = bc;
    return out;
  };

  /** 点是不是贴在地表上 */
  const onSurface = (x, y, tol = 1e-4) => {
    for (let k = 0; k < segs.length; k++) {
      const s = segs[k];
      let t = ((x - s.ax) * s.ex + (y - s.ay) * s.ey) / s.len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      if (Math.hypot(x - (s.ax + s.ex * t), y - (s.ay + s.ey * t)) < tol) return true;
    }
    return false;
  };

  /** 线段有没有一截穿过地里（贴着地表走、端点落在地表上都不算） */
  const segCrosses = (x1, y1, x2, y2) => {
    const dx = x2 - x1, dy = y2 - y1;
    // 竖直的线段：只看它所在的那个 x。正好贴着崖壁时地面取低的一侧，所以贴壁的杆不算穿
    if (Math.abs(dx) < 1e-12) return Math.min(y1, y2) < groundIn(x1) - EPS;
    const xl = Math.min(x1, x2), xr = Math.max(x1, x2);
    for (let k = 0; k < flat.length; k++) {
      const s = flat[k];
      const lo = Math.max(xl, s.ax), hi = Math.min(xr, s.bx);
      if (hi - lo <= EPS) continue;
      const ya = y1 + dy * (lo - x1) / dx, yb = y1 + dy * (hi - x1) / dx;
      if (ya < yAt(s, lo) - EPS || yb < yAt(s, hi) - EPS) return true;
    }
    return false;
  };

  // 水面盖住的区间（世界坐标）：地面低于水面的那些 x 段，画水和泡沫用
  const waterSpans = [];
  if (hasWater) {
    const add = (a, b) => {
      if (b - a < 1e-6) return;
      const last = waterSpans[waterSpans.length - 1];
      if (last && a - last[1] < 1e-6) last[1] = b; else waterSpans.push([a, b]);
    };
    for (const s of flat) {
      const da = s.ay - waterY, db = s.by - waterY;
      if (da < 0 && db < 0) add(s.ax, s.bx);
      else if (da < 0 || db < 0) {
        const xc = s.ax + (s.bx - s.ax) * (da / (da - db));
        if (da < 0) add(s.ax, xc); else add(xc, s.bx);
      }
    }
  }

  return {
    waterSpans,
    /** 这个点所在的地表朝哪：'down' 平地（或坡面），'wall' 竖直的崖壁（锚点画法用） */
    surfaceKind: (x, y) => (y < groundTop(x) - 1e-6 ? 'wall' : 'down'),
    id: raw.id || 'custom', name: raw.name || '自定义地图',
    fieldW: W, half: W / 2,
    hasWater, water: hasWater ? raw.water : null, waterY,
    killY: hasWater ? raw.water - 5.5 : -Infinity,   // 沉到这里以下的节点直接移除
    build: { ...raw.build },
    anchors: (raw.anchors || []).map(([x, y]) => [x, y]),
    coreZone: raw.coreZone ? { ...raw.coreZone } : null,
    core: raw.core ? [raw.core[0], raw.core[1]] : null,
    budget: raw.budget, maxCannons: raw.maxCannons,
    ground: raw.ground.map(([x, y]) => [x, y]),
    localGround: local, worldGround: clean, segs, flat,
    gMax, gMin,
    groundIn, groundTop, inside, pushOut, onSurface, segCrosses,
    /** 本地坐标 → 世界坐标 */
    worldX: (side, x) => (side === 1 || side === 'enemy' ? W - x : x),
    /** 对方核心默认位置在己方本地坐标里的位置 */
    foeCore: raw.core ? [W - raw.core[0], raw.core[1]] : null,
    raw,
  };
}

/** 不做检查直接编译（地图编辑器画半成品用）。地面轮廓至少得是合法的折线，否则结果没有意义 */
export function compileMapLoose(raw) { return compileUnchecked(raw); }

const compiled = new WeakMap();
const builtin = new Map();

/**
 * 取一张可用的地图。可以传：内置地图的名字、地图数据对象、已经编译好的地图，或者不传（默认地图）。
 * 数据不合法时抛错（带 mapError 标记）。
 */
export function getMap(m) {
  if (m && m.segs) return m;                       // 已经编译过
  if (m === undefined || m === null) m = DEFAULT_MAP;
  if (typeof m === 'string') {
    if (!MAPS[m]) { const e = new Error(`没有名叫 ${m} 的地图`); e.mapError = true; throw e; }
    if (!builtin.has(m)) builtin.set(m, compileUnchecked(MAPS[m]));
    return builtin.get(m);
  }
  let M = compiled.get(m);
  if (!M) {
    const why = validateMap(m);
    if (why) { const e = new Error('地图不可用：' + why); e.mapError = true; throw e; }
    M = compileUnchecked(m);
    compiled.set(m, M);
  }
  return M;
}

/** 地图数据的干净副本（存盘、导出、给 AI 看） */
export function mapData(m) {
  const M = getMap(m);
  return {
    id: M.id, name: M.name, fieldW: M.fieldW,
    ground: M.ground.map(([x, y]) => [x, y]),
    water: M.water,
    build: { ...M.build }, anchors: M.anchors.map(([x, y]) => [x, y]),
    coreZone: { ...M.coreZone }, core: [...M.core],
    budget: M.budget, maxCannons: M.maxCannons,
  };
}
