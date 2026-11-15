// 纯视觉的刚体碎块：断杆的两半、炮的残骸。
// 只在 xy 平面里平动 + 绕 z 转动（外加绕自身长轴的翻滚，纯装饰）。
// 粗糙的世界碰撞：崖顶 y=0（x<0 或 x>fieldW）弹一次后停住，约 4 秒后缩小消失；落水溅一朵水花后下沉消失。

import * as THREE from 'three';

const G = 9.81;

function sstep(u) { return u * u * (3 - 2 * u); }

export function makeBody() {
  return {
    active: false,
    x: 0, y: 0, z: 0, vx: 0, vy: 0,
    ang: 0, w: 0, roll: 0, wroll: 0,
    hx: 0.5, hy: 0.1,          // 碰撞用半长、半厚
    state: 0,                  // 0 空中 / 着地，2 水中下沉
    bounces: 0, landT: -1, age: 0, fade: 1, splashed: false,
    splashPower: 0.3,
    trail: false, trailT: 0,   // 残骸冒烟
    // 断杆碎块的外观
    len: 1, thick: 0.2, depth: 0.2, r: 1, g: 1, b: 1,
  };
}

/**
 * 推进一个刚体。返回 false 表示它已经消失。
 * env: { fieldW, waterAt(x), splash(x, y, power) }
 */
export function stepBody(b, dt, env) {
  if (dt <= 0) return true;
  b.age += dt;
  if (b.state === 2) {
    // 水中：慢慢下沉、转动渐止、缩小
    b.vy -= G * 0.12 * dt;
    const k = Math.exp(-2.6 * dt);
    b.vx *= k; b.vy *= k; b.w *= k; b.wroll *= k;
    b.x += b.vx * dt; b.y += b.vy * dt; b.ang += b.w * dt; b.roll += b.wroll * dt;
    b.fade -= dt / 1.6;
    return b.fade > 0;
  }
  const ext0 = Math.abs(Math.sin(b.ang)) * b.hx + Math.abs(Math.cos(b.ang)) * b.hy;
  const prevLow = b.y - ext0;
  b.vy -= G * dt;
  b.x += b.vx * dt; b.y += b.vy * dt;
  b.ang += b.w * dt; b.roll += b.wroll * dt;

  const ext = Math.abs(Math.sin(b.ang)) * b.hx + Math.abs(Math.cos(b.ang)) * b.hy;
  const overGround = b.x < 0 || b.x > env.fieldW;
  if (overGround && b.y - ext < 0 && prevLow >= -0.08) {
    b.y = ext;
    if (b.landT < 0) b.landT = b.age;
    if (b.bounces === 0 && b.vy < -1.5) {
      // 一次带阻尼的弹跳
      b.vy = -b.vy * 0.28; b.vx *= 0.55;
      b.w = -b.w * 0.35 + (Math.random() - 0.5) * 2.5;
      b.bounces = 1;
    } else {
      // 停住：滑动、转动衰减，慢慢放平
      b.vy = 0;
      const f = Math.exp(-6 * dt);
      b.vx *= f; b.w *= f; b.wroll *= f;
      const flat = Math.round(b.ang / Math.PI) * Math.PI;
      b.ang += (flat - b.ang) * Math.min(1, 5 * dt);
      const fr = Math.round(b.roll / (Math.PI / 2)) * (Math.PI / 2);
      b.roll += (fr - b.roll) * Math.min(1, 5 * dt);
    }
  }

  const wl = env.waterAt(b.x);
  if (b.y < wl) {
    b.state = 2;
    if (!b.splashed) { b.splashed = true; env.splash(b.x, wl, b.splashPower); }
    b.vx *= 0.4; b.vy *= 0.25; b.w *= 0.5;
  }

  if (b.landT >= 0 && b.age - b.landT > 4) b.fade -= dt / 0.5;
  else if (b.age > 14) b.fade -= dt / 0.5;
  if (b.y < -40) return false;
  return b.fade > 0;
}

export function bodyScale(b) { return b.fade < 1 ? sstep(b.fade > 0 ? b.fade : 0) : 1; }

// ------------------------------------------------------------------ 断杆碎块（InstancedMesh）
export class PieceSet {
  constructor(parent, cap) {
    this.cap = cap;
    this.bodies = [];
    for (let i = 0; i < cap; i++) this.bodies.push(makeBody());
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.78, metalness: 0.05 });
    const mesh = new THREE.InstancedMesh(geo, mat, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0; mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.castShadow = true; mesh.receiveShadow = true;
    parent.add(mesh);
    this.mesh = mesh;
  }

  /** 取一个空闲碎块；满了就回收最老的 */
  alloc() {
    let best = null, oldest = -1;
    for (let i = 0; i < this.cap; i++) {
      const b = this.bodies[i];
      if (!b.active) { best = b; break; }
      if (b.age > oldest) { oldest = b.age; best = b; }
    }
    const b = best;
    b.active = true; b.state = 0; b.bounces = 0; b.landT = -1; b.age = 0; b.fade = 1;
    b.splashed = false; b.trail = false; b.roll = 0; b.wroll = 0;
    return b;
  }

  update(dt, env) {
    const te = this.mesh.instanceMatrix.array, col = this.mesh.instanceColor.array;
    let n = 0;
    for (let i = 0; i < this.cap; i++) {
      const b = this.bodies[i];
      if (!b.active) continue;
      if (!stepBody(b, dt, env)) { b.active = false; continue; }
      const s = bodyScale(b);
      // R = Rz(ang) * Rx(roll)，再按 (len, thick, depth) 缩放
      const c = Math.cos(b.ang), sn = Math.sin(b.ang), cr = Math.cos(b.roll), sr = Math.sin(b.roll);
      const sx = b.len * s, sy = b.thick * s, sz = b.depth * s;
      const o = n * 16;
      te[o] = c * sx; te[o + 1] = sn * sx; te[o + 2] = 0; te[o + 3] = 0;
      te[o + 4] = -sn * cr * sy; te[o + 5] = c * cr * sy; te[o + 6] = sr * sy; te[o + 7] = 0;
      te[o + 8] = sn * sr * sz; te[o + 9] = -c * sr * sz; te[o + 10] = cr * sz; te[o + 11] = 0;
      te[o + 12] = b.x; te[o + 13] = b.y; te[o + 14] = b.z; te[o + 15] = 1;
      col[n * 3] = b.r; col[n * 3 + 1] = b.g; col[n * 3 + 2] = b.b;
      n++;
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (n > 0) { this.mesh.instanceMatrix.needsUpdate = true; this.mesh.instanceColor.needsUpdate = true; }
    this.live = n;
  }

  clear() {
    for (const b of this.bodies) b.active = false;
    this.mesh.count = 0; this.mesh.visible = false; this.live = 0;
  }
}

// ------------------------------------------------------------------ 火炮残骸（每个一组普通 Mesh）
export class WreckSet {
  /**
   * @param {THREE.Group} parent
   * @param {number} cap
   * @param {{barrel:number, carriage:number, band:number}} colors
   * @param {{barrelLen:number, pivotH:number}} dims
   */
  constructor(parent, cap, colors, dims) {
    const L = dims.barrelLen, H = dims.pivotH;
    const barrelMat = new THREE.MeshStandardMaterial({ color: colors.barrel, flatShading: true, roughness: 0.45, metalness: 0.35 });
    const carMat = new THREE.MeshStandardMaterial({ color: colors.carriage, flatShading: true, roughness: 0.8 });
    const bandMat = new THREE.MeshStandardMaterial({ color: colors.band, flatShading: true, roughness: 0.4, metalness: 0.4 });
    // 炮管：原点在炮耳轴，沿 +x
    const barrelGeo = new THREE.CylinderGeometry(0.12, 0.17, L + 0.25, 8);
    barrelGeo.rotateZ(-Math.PI / 2); barrelGeo.translate((L - 0.25) / 2, 0, 0);
    const bandGeo = new THREE.CylinderGeometry(0.185, 0.185, 0.12, 8);
    bandGeo.rotateZ(-Math.PI / 2); bandGeo.translate(0.14, 0, 0);
    const muzzleGeo = new THREE.CylinderGeometry(0.155, 0.155, 0.12, 8);
    muzzleGeo.rotateZ(-Math.PI / 2); muzzleGeo.translate(L - 0.07, 0, 0);
    // 炮架：挂在炮耳轴下方的木块（局部 y 朝上，原点在炮耳轴）
    const carGeo = new THREE.BoxGeometry(0.95, H * 0.9, 0.62);
    carGeo.translate(0, -H * 0.45 - 0.05, 0);
    this.bodies = [];
    for (let i = 0; i < cap; i++) {
      const g = new THREE.Group();
      g.visible = false;
      g.rotation.order = 'ZYX';
      const parts = [
        new THREE.Mesh(barrelGeo, barrelMat),
        new THREE.Mesh(bandGeo, bandMat),
        new THREE.Mesh(muzzleGeo, bandMat),
      ];
      const car = new THREE.Mesh(carGeo, carMat);
      for (const m of [...parts, car]) { m.castShadow = true; m.receiveShadow = true; }
      parts.forEach((m) => g.add(m));
      g.add(car);
      parent.add(g);
      const b = makeBody();
      b.group = g; b.carriage = car;
      b.hx = L * 0.5 + 0.2; b.hy = 0.45;
      b.splashPower = 0.7;
      this.bodies.push(b);
    }
  }

  alloc() {
    let best = null, oldest = -1;
    for (const b of this.bodies) {
      if (!b.active) { best = b; break; }
      if (b.age > oldest) { oldest = b.age; best = b; }
    }
    const b = best;
    b.active = true; b.state = 0; b.bounces = 0; b.landT = -1; b.age = 0; b.fade = 1;
    b.splashed = false; b.trail = false; b.trailT = 0; b.roll = 0; b.wroll = 0;
    return b;
  }

  update(dt, env, onTrail) {
    let n = 0;
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      if (!b.active) continue;
      if (!stepBody(b, dt, env)) { b.active = false; b.group.visible = false; continue; }
      if (b.trail && b.state === 0 && b.landT < 0 && dt > 0) {
        b.trailT -= dt;
        if (b.trailT <= 0) { b.trailT = 0.07; onTrail(b.x, b.y); }
      }
      const s = bodyScale(b);
      const g = b.group;
      g.visible = true;
      g.position.set(b.x, b.y, b.z);
      g.rotation.set(b.roll, 0, b.ang); // 顺序 ZYX：先绕自身长轴翻滚，再在平面内转
      g.scale.setScalar(s);
      n++;
    }
    this.live = n;
  }

  clear() {
    for (const b of this.bodies) { b.active = false; b.group.visible = false; }
    this.live = 0;
  }
}
