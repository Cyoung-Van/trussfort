// 特效的底层：InstancedMesh 粒子池、环形冲击波池、矩阵写入工具。
// 所有状态存在预分配的 Float32Array 里，update() 不分配内存。
// 粒子消失靠缩到 0（没有逐实例透明度）。

import * as THREE from 'three';

// ---- 粒子标志位 ----
export const F = {
  GROUND: 1,      // 落到地面（高度由 env.groundAt(x) 给）上会弹一下然后停住
  DIE_WATER: 2,   // 下落入水即消失（水滴）
  SINK: 4,        // 入水后减速下沉并缩小消失（碎屑）
  SPLASH: 8,      // 入水时溅一朵小水花（配合 SINK）
  KILL_ABOVE: 16, // 升出水面即消失并冒一个泡沫（气泡）
  ALIGN: 32,      // 长轴朝速度方向（能量碎片、拖尾火星）
};

// ---- 每个粒子在数组里的字段偏移 ----
const PX = 0, PY = 1, PZ = 2, VX = 3, VY = 4, VZ = 5;
const RX = 6, RY = 7, RZ = 8, WX = 9, WY = 10, WZ = 11;
const DX = 12, DY = 13, DZ = 14;
const AGE = 15, LIFE = 16, DELAY = 17, GRAV = 18, DRAG = 19;
const S0 = 20, S1 = 21, S2 = 22, PEAK = 23, HOLD = 24;
const C0 = 25, C1 = 28, C2 = 31, CMID = 34, FLAGS = 35, STATE = 36, FADE = 37;
export const STRIDE = 38;

const G = 9.81;

/** 把 R(XYZ 欧拉) * S 加平移写进列主序 4x4 */
export function writeMatrix(te, o, px, py, pz, rx, ry, rz, sx, sy, sz) {
  const a = Math.cos(rx), b = Math.sin(rx);
  const c = Math.cos(ry), d = Math.sin(ry);
  const e = Math.cos(rz), f = Math.sin(rz);
  const ae = a * e, af = a * f, be = b * e, bf = b * f;
  te[o] = c * e * sx; te[o + 1] = (af + be * d) * sx; te[o + 2] = (bf - ae * d) * sx; te[o + 3] = 0;
  te[o + 4] = -c * f * sy; te[o + 5] = (ae - bf * d) * sy; te[o + 6] = (be + af * d) * sy; te[o + 7] = 0;
  te[o + 8] = d * sz; te[o + 9] = -b * c * sz; te[o + 10] = a * c * sz; te[o + 11] = 0;
  te[o + 12] = px; te[o + 13] = py; te[o + 14] = pz; te[o + 15] = 1;
}

function zeroMatrix(te, o) {
  for (let k = 0; k < 16; k++) te[o + k] = 0;
  te[o + 15] = 1;
}

function sstep(u) { return u * u * (3 - 2 * u); }

/** 发射参数的草稿对象：调用方改字段后交给 pool.emit()，然后 resetSpec() 复原 */
export function makeSpec() {
  const white = new THREE.Color(1, 1, 1);
  return {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
    rx: 0, ry: 0, rz: 0, wx: 0, wy: 0, wz: 0,
    dx: 1, dy: 1, dz: 1,
    life: 1, delay: 0, grav: 0, drag: 0,
    s0: 1, s1: 1, s2: 0, peak: 0.2, hold: 0.7,
    c0: white, c1: white, c2: white, cmid: 0.5, flags: 0,
  };
}
export function resetSpec(P) {
  P.x = P.y = P.z = P.vx = P.vy = P.vz = 0;
  P.rx = P.ry = P.rz = P.wx = P.wy = P.wz = 0;
  P.dx = P.dy = P.dz = 1;
  P.life = 1; P.delay = 0; P.grav = 0; P.drag = 0;
  P.s0 = 1; P.s1 = 1; P.s2 = 0; P.peak = 0.2; P.hold = 0.7;
  P.cmid = 0.5; P.flags = 0;
  return P;
}

export class ParticlePool {
  constructor(geometry, material, cap, { castShadow = false, receiveShadow = false } = {}) {
    this.cap = cap;
    this.live = 0;
    this.peakLive = 0;
    this.dropped = 0;
    this.d = new Float32Array(cap * STRIDE);
    const mesh = new THREE.InstancedMesh(geometry, material, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    this.mesh = mesh;
  }

  emit(P) {
    if (this.live >= this.cap) { this.dropped++; return -1; }
    const d = this.d, o = this.live * STRIDE;
    this.live++;
    if (this.live > this.peakLive) this.peakLive = this.live;
    d[o + PX] = P.x; d[o + PY] = P.y; d[o + PZ] = P.z;
    d[o + VX] = P.vx; d[o + VY] = P.vy; d[o + VZ] = P.vz;
    d[o + RX] = P.rx; d[o + RY] = P.ry; d[o + RZ] = P.rz;
    d[o + WX] = P.wx; d[o + WY] = P.wy; d[o + WZ] = P.wz;
    d[o + DX] = P.dx; d[o + DY] = P.dy; d[o + DZ] = P.dz;
    d[o + AGE] = 0; d[o + LIFE] = P.life > 0.001 ? P.life : 0.001; d[o + DELAY] = P.delay;
    d[o + GRAV] = P.grav; d[o + DRAG] = P.drag;
    d[o + S0] = P.s0; d[o + S1] = P.s1; d[o + S2] = P.s2;
    d[o + PEAK] = P.peak > 0.001 ? P.peak : 0.001;
    d[o + HOLD] = P.hold < P.peak ? P.peak : P.hold > 0.999 ? 0.999 : P.hold;
    d[o + C0] = P.c0.r; d[o + C0 + 1] = P.c0.g; d[o + C0 + 2] = P.c0.b;
    d[o + C1] = P.c1.r; d[o + C1 + 1] = P.c1.g; d[o + C1 + 2] = P.c1.b;
    d[o + C2] = P.c2.r; d[o + C2 + 1] = P.c2.g; d[o + C2 + 2] = P.c2.b;
    d[o + CMID] = P.cmid > 0.001 ? (P.cmid < 0.999 ? P.cmid : 0.999) : 0.001;
    d[o + FLAGS] = P.flags; d[o + STATE] = 0; d[o + FADE] = 1;
    return o;
  }

  clear() {
    this.live = 0;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  /**
   * env: { fieldW, waterY, waterAt(x), groundAt(x), miniSplash(x, y), pop(x, y) }
   */
  update(dt, env) {
    const d = this.d;
    const te = this.mesh.instanceMatrix.array;
    const col = this.mesh.instanceColor.array;
    const fieldW = env.fieldW, waterY = env.waterY;
    let i = 0;
    while (i < this.live) {
      const o = i * STRIDE;
      // 延迟出生：先占位但不显示
      if (d[o + DELAY] > 0) {
        d[o + DELAY] -= dt;
        if (d[o + DELAY] > 0) { zeroMatrix(te, i * 16); i++; continue; }
      }
      const life = d[o + LIFE];
      let age = d[o + AGE] + dt;
      // 刚生出来的粒子至少要被画到一次：高倍速下一步的 dt 可能比炮口火光的寿命还长
      if (d[o + AGE] === 0 && age > life * 0.5) age = life * 0.5;
      d[o + AGE] = age;
      let dead = age >= life;
      const flags = d[o + FLAGS];

      if (!dead && dt > 0) {
        let vx = d[o + VX], vy = d[o + VY], vz = d[o + VZ];
        const k = Math.exp(-d[o + DRAG] * dt);
        vy -= G * d[o + GRAV] * dt;
        vx *= k; vy *= k; vz *= k;
        const prevY = d[o + PY];
        let px = d[o + PX] + vx * dt, py = prevY + vy * dt, pz = d[o + PZ] + vz * dt;
        d[o + RX] += d[o + WX] * dt; d[o + RY] += d[o + WY] * dt; d[o + RZ] += d[o + WZ] * dt;

        // 落在崖顶
        if ((flags & F.GROUND) && d[o + STATE] === 0) {
          const rad = 0.03, gy = env.groundAt(px);
          if (py < gy + rad && prevY >= gy - 0.05) {
            py = gy + rad;
            if (vy < -1.4) {
              vy = -vy * 0.32; vx *= 0.55; vz *= 0.55;
              d[o + WX] *= 0.5; d[o + WY] *= 0.5; d[o + WZ] *= 0.5;
            } else {
              vy = 0;
              const f = Math.exp(-9 * dt);
              vx *= f; vz *= f;
              d[o + WX] *= f; d[o + WY] *= f; d[o + WZ] *= f;
            }
          }
        }

        // 水面
        if (flags & (F.DIE_WATER | F.SINK | F.KILL_ABOVE)) {
          const wl = py < waterY + 1.2 ? env.waterAt(px) : waterY;
          if (flags & F.KILL_ABOVE) {
            if (py > wl) { dead = true; env.pop(px, wl); }
          } else if (py < wl) {
            if ((flags & F.DIE_WATER) && vy < 0) dead = true;
            else if ((flags & F.SINK) && d[o + STATE] === 0) {
              d[o + STATE] = 1;
              if (flags & F.SPLASH) env.miniSplash(px, wl);
              vx *= 0.3; vy *= 0.2; vz *= 0.3;
              d[o + GRAV] = 0.12; d[o + DRAG] = 3;
            }
          }
        }
        if (d[o + STATE] === 1) {
          d[o + FADE] -= dt * 2.2;
          if (d[o + FADE] <= 0) dead = true;
        }
        if (flags & F.ALIGN) {
          d[o + RZ] = Math.atan2(vy, vx);
          d[o + RY] = 0;
        }
        d[o + VX] = vx; d[o + VY] = vy; d[o + VZ] = vz;
        d[o + PX] = px; d[o + PY] = py; d[o + PZ] = pz;
      }

      if (dead) {
        const last = (this.live - 1) * STRIDE;
        if (o !== last) d.copyWithin(o, last, last + STRIDE);
        this.live--;
        continue; // 搬过来的那个在同一个 i 上处理
      }

      // 尺寸曲线：s0 → s1（缓出）→ 保持 → s2（平滑）
      const t = age / life;
      const peak = d[o + PEAK], hold = d[o + HOLD];
      const s0 = d[o + S0], s1 = d[o + S1], s2 = d[o + S2];
      let s;
      if (t < peak) { const u = 1 - t / peak; s = s0 + (s1 - s0) * (1 - u * u); }
      else if (t < hold) s = s1;
      else s = s1 + (s2 - s1) * sstep((t - hold) / (1 - hold));
      const fade = d[o + FADE];
      s *= fade < 1 ? sstep(fade > 0 ? fade : 0) : 1;
      if (!(s > 0)) s = 0;

      writeMatrix(te, i * 16, d[o + PX], d[o + PY], d[o + PZ], d[o + RX], d[o + RY], d[o + RZ],
        s * d[o + DX], s * d[o + DY], s * d[o + DZ]);

      // 颜色：c0 → c1 → c2（线性空间）
      const cm = d[o + CMID];
      let a, b, u;
      if (t < cm) { a = C0; b = C1; u = t / cm; } else { a = C1; b = C2; u = (t - cm) / (1 - cm); }
      if (u > 1) u = 1;
      const ci = i * 3;
      col[ci] = d[o + a] + (d[o + b] - d[o + a]) * u;
      col[ci + 1] = d[o + a + 1] + (d[o + b + 1] - d[o + a + 1]) * u;
      col[ci + 2] = d[o + a + 2] + (d[o + b + 2] - d[o + a + 2]) * u;
      i++;
    }
    const mesh = this.mesh;
    mesh.count = this.live;
    mesh.visible = this.live > 0;
    if (this.live > 0) {
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, this.live * 16);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.clearUpdateRanges();
      mesh.instanceColor.addUpdateRange(0, this.live * 3);
      mesh.instanceColor.needsUpdate = true;
    }
  }
}

// ------------------------------------------------------------------ 环
// 环用独立 Mesh（各自一份材质，才能单独淡出）。数量很少。
export class RingPool {
  /**
   * @param {THREE.Group} parent
   * @param {THREE.BufferGeometry} geometry 单位半径的环
   * @param {THREE.Material} material 每个环会 clone 一份
   * @param {number} cap
   * @param {boolean} flat true = 平躺在水面（跟随波浪高度）
   */
  constructor(parent, geometry, material, cap, flat) {
    this.flat = flat;
    this.items = [];
    for (let i = 0; i < cap; i++) {
      const m = new THREE.Mesh(geometry, material.clone());
      m.visible = false;
      m.frustumCulled = false;
      m.renderOrder = 10;
      parent.add(m);
      this.items.push({ mesh: m, active: false, age: 0, life: 1, delay: 0, r0: 0, r1: 1, op: 1, x: 0, y: 0, z: 0 });
    }
  }

  spawn(x, y, z, r0, r1, life, op, delay = 0) {
    let it = null, oldest = -1;
    for (let i = 0; i < this.items.length; i++) {
      const c = this.items[i];
      if (!c.active) { it = c; break; }
      const prog = c.age / c.life;
      if (prog > oldest) { oldest = prog; it = c; }
    }
    it.active = true; it.age = 0; it.life = life; it.delay = delay;
    it.r0 = r0; it.r1 = r1; it.op = op; it.x = x; it.y = y; it.z = z;
    it.mesh.visible = false;
    return it;
  }

  update(dt, env) {
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (!it.active) continue;
      if (it.delay > 0) { it.delay -= dt; if (it.delay > 0) continue; }
      it.age += dt;
      const t = it.age / it.life;
      if (t >= 1) { it.active = false; it.mesh.visible = false; continue; }
      const e = 1 - (1 - t) * (1 - t) * (1 - t); // 缓出
      const r = it.r0 + (it.r1 - it.r0) * e;
      const m = it.mesh;
      m.visible = true;
      m.scale.set(r, r, r);
      const y = this.flat ? env.waterAt(it.x) + 0.04 : it.y;
      m.position.set(it.x, y, it.z);
      // 前段保持亮，后段迅速淡掉
      m.material.opacity = it.op * (t < 0.35 ? 1 : 1 - sstep((t - 0.35) / 0.65));
    }
  }

  clear() {
    for (const it of this.items) { it.active = false; it.mesh.visible = false; }
  }

  activeCount() {
    let n = 0;
    for (const it of this.items) if (it.active) n++;
    return n;
  }
}
