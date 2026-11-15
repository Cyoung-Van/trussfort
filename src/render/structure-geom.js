// 结构视图用到的低多边形几何体。全部在代码里生成，单位米。
// 杆件类几何体一律「沿 x 轴、长度 1、居中」，实例矩阵只需旋转 + x 向缩放。

import * as THREE from 'three';

/** 合并若干几何体（只保留 position / normal，平面着色够用） */
export function mergeGeoms(list) {
  let total = 0;
  const flat = list.map((g) => {
    const ng = g.index ? g.toNonIndexed() : g;
    if (!ng.attributes.normal) ng.computeVertexNormals();
    total += ng.attributes.position.count;
    return ng;
  });
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3);
  let o = 0;
  for (const g of flat) {
    pos.set(g.attributes.position.array, o);
    nor.set(g.attributes.normal.array, o);
    o += g.attributes.position.count * 3;
  }
  for (let i = 0; i < list.length; i++) {
    if (flat[i] !== list[i]) flat[i].dispose();
    list[i].dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.computeBoundingSphere();
  return out;
}

/** 凸多边形截面（(y, z) 点，逆时针）沿 x 拉伸成长度 1 的棱柱，x ∈ [-0.5, 0.5] */
export function prismX(profile) {
  const pos = [];
  const m = profile.length;
  const push = (x, p) => pos.push(x, p[0], p[1]);
  for (let i = 0; i < m; i++) {
    const p = profile[i], q = profile[(i + 1) % m];
    // 侧面
    push(-0.5, p); push(-0.5, q); push(0.5, q);
    push(-0.5, p); push(0.5, q); push(0.5, p);
  }
  for (let i = 1; i < m - 1; i++) {
    // 端面（扇形三角化）
    push(0.5, profile[0]); push(0.5, profile[i]); push(0.5, profile[i + 1]);
    push(-0.5, profile[0]); push(-0.5, profile[i + 1]); push(-0.5, profile[i]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  // 朝向自检：侧面法线应朝外，否则整体翻转
  const n = g.attributes.normal.array, p0 = g.attributes.position.array;
  let gy = 0, gz = 0;
  for (const p of profile) { gy += p[0] / m; gz += p[1] / m; }
  const cy = (p0[1] + p0[4]) / 2 - gy, cz = (p0[2] + p0[5]) / 2 - gz;
  if (n[1] * cy + n[2] * cz < 0) {
    const a = g.attributes.position.array;
    for (let i = 0; i < a.length; i += 9) {
      for (let k = 0; k < 3; k++) { const t = a[i + 3 + k]; a[i + 3 + k] = a[i + 6 + k]; a[i + 6 + k] = t; }
    }
    g.computeVertexNormals();
  }
  return g;
}

function rect(h, w) { // 截面矩形：y 方向高 h，z 方向宽 w
  return [[-h / 2, -w / 2], [h / 2, -w / 2], [h / 2, w / 2], [-h / 2, w / 2]];
}
function shift(profile, dy, dz) { return profile.map(([y, z]) => [y + dy, z + dz]); }

/** 木杆：0.24（面内）× 0.3（z）的倒角方木 */
export function woodGeom() {
  const h = 0.24, w = 0.3, c = 0.035;
  const prof = [
    [-h / 2 + c, -w / 2], [h / 2 - c, -w / 2], [h / 2, -w / 2 + c], [h / 2, w / 2 - c],
    [h / 2 - c, w / 2], [-h / 2 + c, w / 2], [-h / 2, w / 2 - c], [-h / 2, -w / 2 + c],
  ];
  return prismX(prof);
}

/** 钢梁：工字截面，上下翼缘 + 腹板。正面看是翼缘夹着一道凹槽 */
export function steelGeom() {
  const H = 0.2, W = 0.26, tf = 0.045, tw = 0.06;
  return mergeGeoms([
    prismX(shift(rect(tf, W), H / 2 - tf / 2, 0)),
    prismX(shift(rect(tf, W), -H / 2 + tf / 2, 0)),
    prismX(rect(H - 2 * tf + 0.002, tw)),
  ]);
}

/** 绳索：细圆柱，6 棱 */
export function ropeGeom() {
  const g = new THREE.CylinderGeometry(0.045, 0.045, 1, 6, 1);
  g.rotateZ(-Math.PI / 2);
  return mergeGeoms([g]);
}

class Helix extends THREE.Curve {
  constructor(turns, r) { super(); this.turns = turns; this.r = r; }
  getPoint(t, target = new THREE.Vector3()) {
    const a = t * this.turns * Math.PI * 2;
    return target.set(t - 0.5, this.r * Math.cos(a), this.r * Math.sin(a));
  }
}

/** 弹簧：单位长度的螺旋管，x 向缩放即拉伸 / 压缩 */
export function springGeom() {
  const turns = 7;
  const tube = new THREE.TubeGeometry(new Helix(turns, 0.13), turns * 12, 0.03, 5, false);
  // 两端的小端板，让弹簧和节点之间有个交代
  const cap1 = new THREE.CylinderGeometry(0.15, 0.15, 0.03, 8); cap1.rotateZ(-Math.PI / 2); cap1.translate(-0.5, 0, 0);
  const cap2 = new THREE.CylinderGeometry(0.15, 0.15, 0.03, 8); cap2.rotateZ(-Math.PI / 2); cap2.translate(0.5, 0, 0);
  return mergeGeoms([tube, cap1, cap2]);
}

/** 节点销：沿 z 的圆柱 + 两端螺栓头 */
export function pinGeom() {
  const pin = new THREE.CylinderGeometry(0.09, 0.09, 1.15, 8); pin.rotateX(Math.PI / 2);
  const h1 = new THREE.CylinderGeometry(0.16, 0.16, 0.06, 6); h1.rotateX(Math.PI / 2); h1.translate(0, 0, 0.6);
  const h2 = new THREE.CylinderGeometry(0.16, 0.16, 0.06, 6); h2.rotateX(Math.PI / 2); h2.translate(0, 0, -0.6);
  return mergeGeoms([pin, h1, h2]);
}

/** 锚座：粗销 + 朝 -y 的底板（实例旋转后可朝向崖壁） */
export function anchorGeom() {
  const boss = new THREE.CylinderGeometry(0.2, 0.2, 1.35, 6); boss.rotateX(Math.PI / 2);
  const plate = new THREE.BoxGeometry(0.75, 0.16, 1.45); plate.translate(0, -0.2, 0);
  const rib1 = new THREE.BoxGeometry(0.1, 0.24, 1.35); rib1.translate(-0.22, -0.08, 0);
  const rib2 = new THREE.BoxGeometry(0.1, 0.24, 1.35); rib2.translate(0.22, -0.08, 0);
  return mergeGeoms([boss, plate, rib1, rib2]);
}

// ---------------------------------------------------------------- 火炮
// 炮架局部坐标：x 沿炮座杆件，y 为杆件法向（炮在上方），原点在杆件中线上，炮耳轴在 y = pivotH。

export function carriageWoodGeom(pivotH) {
  const bed = new THREE.BoxGeometry(0.95, 0.12, 0.56); bed.translate(0, 0.26, 0);
  const shape = new THREE.Shape();
  shape.moveTo(-0.34, 0.3); shape.lineTo(0.3, 0.3); shape.lineTo(0.14, pivotH + 0.12); shape.lineTo(-0.18, pivotH + 0.12); shape.closePath();
  const mk = (z) => {
    const g = new THREE.ExtrudeGeometry(shape, { depth: 0.08, bevelEnabled: false });
    g.deleteAttribute('uv');
    g.translate(0, 0, z - 0.04);
    return g;
  };
  return mergeGeoms([bed, mk(0.24), mk(-0.24)]);
}

export function carriageIronGeom(pivotH) {
  const parts = [];
  for (const x of [-0.3, 0.3]) {
    for (const z of [-0.36, 0.36]) {
      const w = new THREE.CylinderGeometry(0.12, 0.12, 0.07, 8); w.rotateX(Math.PI / 2); w.translate(x, 0.24, z);
      parts.push(w);
    }
    const ax = new THREE.CylinderGeometry(0.035, 0.035, 0.8, 6); ax.rotateX(Math.PI / 2); ax.translate(x, 0.24, 0);
    parts.push(ax);
  }
  const tr = new THREE.CylinderGeometry(0.06, 0.06, 0.62, 6); tr.rotateX(Math.PI / 2); tr.translate(0, pivotH, 0);
  parts.push(tr);
  return mergeGeoms(parts);
}

/** 炮管：原点为炮耳轴，沿 +x 指向炮口 */
export function barrelGeom(len) {
  const body = new THREE.CylinderGeometry(0.12, 0.17, len + 0.25, 8); body.rotateZ(-Math.PI / 2); body.translate((len - 0.25) / 2, 0, 0);
  const knob = new THREE.SphereGeometry(0.1, 8, 4); knob.translate(-0.32, 0, 0);
  const neck = new THREE.CylinderGeometry(0.06, 0.13, 0.1, 8); neck.rotateZ(-Math.PI / 2); neck.translate(-0.27, 0, 0);
  return mergeGeoms([body, knob, neck]);
}
export function muzzleRingGeom(len) {
  const g = new THREE.CylinderGeometry(0.155, 0.155, 0.12, 8); g.rotateZ(-Math.PI / 2); g.translate(len - 0.07, 0, 0);
  return mergeGeoms([g]);
}
export function bandGeom() {
  const g = new THREE.CylinderGeometry(0.182, 0.182, 0.12, 8); g.rotateZ(-Math.PI / 2); g.translate(0.14, 0, 0);
  return mergeGeoms([g]);
}

// ---------------------------------------------------------------- 核心
export function cageGeom(R) {
  const rings = [];
  const a = new THREE.TorusGeometry(R, 0.045, 4, 14);                 // 正对镜头
  const b = new THREE.TorusGeometry(R, 0.045, 4, 14); b.rotateX(Math.PI / 2); // 水平
  const c = new THREE.TorusGeometry(R, 0.045, 4, 14); c.rotateY(Math.PI / 2); // 侧向，穿过前后两层桁架
  rings.push(a, b, c);
  for (const z of [-R, R]) {
    const boss = new THREE.CylinderGeometry(0.09, 0.09, 0.14, 6); boss.rotateX(Math.PI / 2); boss.translate(0, 0, z);
    rings.push(boss);
  }
  return mergeGeoms(rings);
}
