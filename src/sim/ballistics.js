// 弹道工具：蓝图界面的弹道预览、预设堡垒的瞄准解算。
// 这里算的是「蓝图姿态下的理想弹道」；实战中结构下沉、歪斜后的偏差正是玩法的一部分。

import { CFG, MATERIALS, CANNON, CORE } from '../config.js';

const DEG = Math.PI / 180;

/**
 * 预测某一方蓝图里一门炮的弹道。坐标是该蓝图的本地坐标（对方蓝图做镜像）。
 * @returns {{pts:number[][], end:{kind:string,x:number,y:number}, t:number}}
 *   end.kind: 'own' 被自家结构挡住 | 'enemyBeam' | 'enemyCore' | 'enemyCannon' | 'ground' | 'water' | 'far'
 */
export function predictShot(bpSelf, cannon, bpOther, opts = {}) {
  const S = CFG.shell, W = CFG.fieldW, g = CFG.gravity;
  const pose = bpSelf.cannonPose(cannon);
  const angle = opts.angle ?? cannon.angle;
  const x0 = pose.px + Math.cos(angle) * CANNON.barrelLen;
  const y0 = pose.py + Math.sin(angle) * CANNON.barrelLen;
  const vx = Math.cos(angle) * S.speed, vy0 = Math.sin(angle) * S.speed;
  // 模拟里炮弹用半隐式欧拉、步长 h = dt / substeps。它的离散轨迹有闭式解：
  //   x_n = x0 + vx·t,  y_n = y0 + vy0·t - g·t²/2 - g·h·t/2   (t = n·h)
  // 这里直接在同一条离散轨迹上隔几步取样，所以预览和实战走的是同一条线。
  const h = CFG.dt / CFG.substeps;
  const STRIDE = 4;
  let x = x0, y = y0;
  const pts = [[x, y]];
  const own = segsOf(bpSelf, false, cannon.beam);
  const other = bpOther ? segsOf(bpOther, true, -1) : [];
  const ownCore = bpSelf.coreNode();
  const otherCore = bpOther ? bpOther.coreNode() : null;
  const otherCannons = bpOther ? [...bpOther.cannons.values()].map(c => { const p = bpOther.cannonPose(c); return [W - p.px, p.py]; }) : [];
  const ownCannons = [...bpSelf.cannons.values()].filter(c => c.id !== cannon.id).map(c => { const p = bpSelf.cannonPose(c); return [p.px, p.py]; });
  const rCore = CORE.radius + S.radius, rCannon = CANNON.radius + S.radius;
  let t = 0;
  const done = (kind) => { pts.push([x, y]); return { pts, end: { kind, x, y }, t }; };
  for (let n = STRIDE, k = 1; t < 12; n += STRIDE, k++) {
    t = n * h;
    x = x0 + vx * t;
    y = y0 + vy0 * t - 0.5 * g * t * t - 0.5 * g * h * t;
    // 判定顺序与模拟一致：水面 → 地面 → 核心 → 火炮 → 杆件
    if (y < CFG.waterY) return done('water');
    if (y < 0 && (x < 0 || x > W)) return done('ground');
    if (x < -40 || x > W + 40) return done('far');
    if (ownCore && Math.hypot(x - ownCore.x, y - ownCore.y) < rCore) return done('own');
    if (otherCore && Math.hypot(x - (W - otherCore.x), y - otherCore.y) < rCore) return done('enemyCore');
    for (const c of ownCannons) if (Math.hypot(x - c[0], y - c[1]) < rCannon) return done('own');
    for (const c of otherCannons) if (Math.hypot(x - c[0], y - c[1]) < rCannon) return done('enemyCannon');
    for (const s of own) {
      if (s.mount && t < S.grace) continue;
      if (hitSeg(x, y, s)) return done('own');
    }
    for (const s of other) if (hitSeg(x, y, s)) return done('enemyBeam');
    if (k % 9 === 0) pts.push([x, y]);
  }
  return done('far');
}

function segsOf(bp, mirror, mountBeamId) {
  const W = CFG.fieldW;
  const out = [];
  for (const bm of bp.beams.values()) {
    const a = bp.nodes.get(bm.a), b = bp.nodes.get(bm.b);
    out.push({
      ax: mirror ? W - a.x : a.x, ay: a.y, bx: mirror ? W - b.x : b.x, by: b.y,
      r: CFG.shell.radius + MATERIALS[bm.mat].hitR, mount: bm.id === mountBeamId,
    });
  }
  return out;
}

function hitSeg(x, y, s) {
  const ex = s.bx - s.ax, ey = s.by - s.ay;
  const l2 = ex * ex + ey * ey;
  let t = l2 > 0 ? ((x - s.ax) * ex + (y - s.ay) * ey) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = x - (s.ax + ex * t), dy = y - (s.ay + ey * t);
  return dx * dx + dy * dy < s.r * s.r;
}

/**
 * 解算让炮弹经过目标点 (tx, ty) 的射角（弧度）。high=true 取高抛弹道，否则取平射弹道。
 * (px, py) 是炮耳轴位置；炮口在炮耳轴前方 barrelLen 处，这里用迭代把这段偏移算进去。
 * 打不到时返回 null。
 */
export function solveAngle(px, py, tx, ty, high = false) {
  const v = CFG.shell.speed, g = CFG.gravity, L = CANNON.barrelLen;
  // f(a) = 弹道在 x = tx 处的高度 - ty。炮口位置随射角变，所以直接对 f 做有界求根，
  // 而不是用某个中间炮口位置的判别式去断言「打不到」。
  const f = (a) => {
    const c = Math.cos(a), s = Math.sin(a);
    const dx = tx - (px + c * L);
    if (dx <= 0 || c <= 1e-6) return NaN;
    const t = dx / (v * c);
    return py + s * L + v * s * t - 0.5 * g * t * t - ty;
  };
  const lo = -30 * DEG, hi = 89.5 * DEG, N = 480;
  const roots = [];
  let pa = lo, pf = f(lo);
  for (let i = 1; i <= N; i++) {
    const a = lo + (hi - lo) * i / N, fa = f(a);
    if (Number.isFinite(pf) && Number.isFinite(fa) && (pf === 0 || pf * fa < 0)) {
      let l = pa, r = a, fl = pf;
      for (let it = 0; it < 50; it++) {
        const m = (l + r) / 2, fm = f(m);
        if (fl * fm <= 0) r = m; else { l = m; fl = fm; }
      }
      roots.push((l + r) / 2);
    }
    pa = a; pf = fa;
  }
  if (!roots.length) return null;
  return high ? roots[roots.length - 1] : roots[0];
}
