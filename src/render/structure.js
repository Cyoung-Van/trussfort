// 结构视图：每帧直接从 Sim 读状态，画出两座堡垒（杆件、节点、核心、火炮）和飞行中的炮弹。
// 「每根杆件随受力大小实时从绿变黄再变红，超载直接崩断」
//
// 约定：只读 sim，绝不写；sync() 稳态不分配内存。
// 木 / 钢杆画两层（z = ±0.45 的前后两片桁架），节点处用贯穿的销钉连起来；绳和弹簧只画一层（z = 0）。

import * as THREE from 'three';
import { CFG, CANNON, CORE } from '../config.js';
import { THEME, stressRGB } from '../theme.js';
import {
  woodGeom, steelGeom, ropeGeom, springGeom, pinGeom, anchorGeom,
  carriageWoodGeom, carriageIronGeom, barrelGeom, muzzleRingGeom, bandGeom, cageGeom,
} from './structure-geom.js';

const KINDS = ['wood', 'steel', 'rope', 'spring'];
const KIND_INDEX = { wood: 0, steel: 1, rope: 2, spring: 3 };
const FRAME_Z = 0.45;
const DOUBLE = [true, true, false, false];           // 木、钢画前后两层
const STRESS_MUL = [1, 0.82, 0.92, 1];              // 受力色里钢、绳略压暗，保留材质区分
const CHAR = 0x30343a;                              // 炮击焦黑
const CORE_TRIM = CORE.radius + 0.02;               // 接到核心上的杆件在笼圈处截断，不挡住宝石
const SHELL_POOL = 16;
const PUFF_POOL = 256;
const PUFF_LIFE = 0.5;
const PUFF_STEP = 0.3;                               // 每飞多少米留一团烟
const TWO_PI = Math.PI * 2;

// sRGB 分量 → 线性（实例颜色要线性值）
function s2l(c) { return c <= 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4); }
function hexRGB(hex) { return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255]; }
function wrapPi(a) { while (a > Math.PI) a -= TWO_PI; while (a < -Math.PI) a += TWO_PI; return a; }
/** 由已有色值按比例提亮（t>0）或压暗（t<0），用于派生 THEME 里没有的颜色 */
function shade(hex, t) {
  const c = hexRGB(hex);
  for (let i = 0; i < 3; i++) c[i] = t >= 0 ? c[i] + (1 - c[i]) * t : c[i] * (1 + t);
  return (Math.round(c[0] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[2] * 255);
}

const MAT_SRGB = KINDS.map((k) => hexRGB(THEME.material[k]));
const CHAR_SRGB = hexRGB(CHAR);

export class StructureView {
  constructor(world) {
    this.world = world;
    this.root = new THREE.Group();
    this.root.name = 'structure';
    world.groups.structure.add(this.root);

    this.stressOn = true;
    this.sim = null;
    this._rgb = [0, 0, 0];
    this._built = false;

    // ---- 共享几何体与材质（跨战斗复用，避免每次开战重编着色器） ----
    this.geo = {
      member: [woodGeom(), steelGeom(), ropeGeom(), springGeom()],
      pin: pinGeom(),
      anchor: anchorGeom(),
      carWood: carriageWoodGeom(CANNON.pivotH),
      carIron: carriageIronGeom(CANNON.pivotH),
      barrel: barrelGeom(CANNON.barrelLen),
      muzzle: muzzleRingGeom(CANNON.barrelLen),
      band: bandGeom(),
      gem: new THREE.IcosahedronGeometry(0.5, 0),
      cage: cageGeom(CORE.radius),
      shell: new THREE.IcosahedronGeometry(CFG.shell.radius, 1),
      puff: new THREE.IcosahedronGeometry(1, 0),
    };
    const std = (o) => new THREE.MeshStandardMaterial({ flatShading: true, ...o });
    this.mat = {
      member: [
        std({ color: 0xffffff, roughness: 0.8, metalness: 0 }),     // 木
        std({ color: 0xffffff, roughness: 0.42, metalness: 0.28 }), // 钢
        std({ color: 0xffffff, roughness: 0.9, metalness: 0 }),     // 绳
        std({ color: 0xffffff, roughness: 0.35, metalness: 0.3 }),  // 弹簧
      ],
      pin: std({ color: THEME.material.joint, roughness: 0.45, metalness: 0.35 }),
      anchor: std({ color: THEME.material.anchor, roughness: 0.6, metalness: 0.1 }),
      carriage: std({ color: THEME.cannon.carriage, roughness: 0.85 }),
      iron: std({ color: THEME.cannon.barrel, roughness: 0.4, metalness: 0.45 }),
      ring: std({ color: THEME.cannon.band, roughness: 0.35, metalness: 0.5 }),
      band: [std({ color: THEME.team.player, roughness: 0.5 }), std({ color: THEME.team.enemy, roughness: 0.5 })],
      // 炮弹：由炮管色压暗派生
      shell: std({ color: shade(THEME.cannon.barrel, -0.45), roughness: 0.35, metalness: 0.4 }),
      // 烟团：fx.smoke 略提亮，免得在天空前发灰
      puff: std({ color: shade(THEME.fx.smoke, 0.25), roughness: 1, metalness: 0 }),
    };

    // ---- 核心（两侧各一，常驻；点光源常驻场景、只调强度，光源数量不变就不会触发重编译） ----
    this.cores = [0, 1].map((side) => this._makeCore(side));

    // ---- 炮弹池 ----
    this.shells = [];
    for (let i = 0; i < SHELL_POOL; i++) {
      const m = new THREE.Mesh(this.geo.shell, this.mat.shell);
      m.castShadow = true; m.visible = false;
      this.root.add(m);
      this.shells.push({ mesh: m, id: 0, seen: false, lx: 0, ly: 0 });
    }

    // ---- 尾烟池（一个 InstancedMesh，轮转覆盖最旧的） ----
    this.puffs = new THREE.InstancedMesh(this.geo.puff, this.mat.puff, PUFF_POOL);
    this.puffs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.puffs.frustumCulled = false;
    this.puffs.visible = false;
    this.root.add(this.puffs);
    this.puffData = new Float32Array(PUFF_POOL * 6); // x, y, z, born, size, alive
    this.puffNext = 0;
    this._clearPuffs();

    // ---- 每场战斗重建的对象 ----
    this.members = [];   // 每种材料一个 InstancedMesh（数量为 0 时为 null）
    this.pins = null;
    this.anchors = null;
    this.cannons = [];
  }

  // ================================================================ 构建 / 清除
  build(sim) {
    if (this._built) this.clear();
    this.sim = sim;
    const n = sim.n;
    this.ix = new Float32Array(n);
    this.iy = new Float32Array(n);
    this.coreNode = new Int32Array([-1, -1]);
    for (let s = 0; s < 2; s++) if (sim.cores[s]) this.coreNode[s] = sim.cores[s].node;

    // ---- 杆件 ----
    const beams = sim.beams;
    const counts = [0, 0, 0, 0];
    this.beamKind = new Uint8Array(beams.length);
    this.beamSlot = new Int32Array(beams.length);
    this.beamHidden = new Uint8Array(beams.length);
    for (let k = 0; k < beams.length; k++) {
      const ki = KIND_INDEX[beams[k].matId] ?? 0;
      this.beamKind[k] = ki;
      this.beamSlot[k] = counts[ki];
      counts[ki] += DOUBLE[ki] ? 2 : 1;
    }
    this.members = counts.map((c, ki) => {
      if (c === 0) return null;
      const m = new THREE.InstancedMesh(this.geo.member[ki], this.mat.member[ki], c);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(c * 3), 3);
      m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      m.castShadow = true; m.receiveShadow = true;
      m.frustumCulled = false;
      m.name = 'members-' + KINDS[ki];
      this.root.add(m);
      return m;
    });
    this._mats = this.members.map((m) => (m ? m.instanceMatrix.array : null));
    this._cols = this.members.map((m) => (m ? m.instanceColor.array : null));

    // ---- 节点销 / 锚座 ----
    let nAnchor = 0;
    this.pinSlot = new Int32Array(n).fill(-1);
    let nPin = 0;
    for (let i = 0; i < n; i++) {
      if (sim.fixed[i]) nAnchor++;
      else if (i !== this.coreNode[0] && i !== this.coreNode[1]) this.pinSlot[i] = nPin++;
    }
    if (nPin > 0) {
      this.pins = new THREE.InstancedMesh(this.geo.pin, this.mat.pin, nPin);
      this.pins.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.pins.castShadow = true; this.pins.receiveShadow = true;
      this.pins.frustumCulled = false;
      this.root.add(this.pins);
    }
    if (nAnchor > 0) {
      // 锚点不动：矩阵只在这里写一次
      this.anchors = new THREE.InstancedMesh(this.geo.anchor, this.mat.anchor, nAnchor);
      this.anchors.castShadow = true; this.anchors.receiveShadow = true;
      const a = this.anchors.instanceMatrix.array;
      let j = 0;
      for (let i = 0; i < n; i++) {
        if (!sim.fixed[i]) continue;
        // 崖顶上的锚座底板朝下；崖壁上的朝向崖壁（左崖 -x，右崖 +x）
        let rot = 0;
        if (sim.y[i] < -0.01) rot = sim.x[i] < CFG.fieldW * 0.5 ? -Math.PI / 2 : Math.PI / 2;
        writeRotZ(a, j * 16, sim.x[i], sim.y[i], 0, Math.cos(rot), Math.sin(rot), 1);
        j++;
      }
      this.anchors.instanceMatrix.needsUpdate = true;
      this.anchors.computeBoundingSphere();
      this.root.add(this.anchors);
    }

    // ---- 火炮 ----
    this.cannons = sim.cannons.map((c) => this._makeCannon(c));

    // ---- 核心 ----
    for (let s = 0; s < 2; s++) {
      const cv = this.cores[s];
      const core = sim.cores[s];
      cv.dead = false; cv.sinkT = -1; cv.active = !!core;
      cv.group.visible = !!core;
      cv.gem.visible = true;
      cv.cageMat.color.setHex(THEME.material.joint);
      cv.light.intensity = 0;
    }

    // ---- 炮弹 ----
    for (const s of this.shells) { s.id = 0; s.mesh.visible = false; }
    this._clearPuffs();
    this.puffs.visible = true;

    this._built = true;
    this.sync(sim, 1);
  }

  clear() {
    for (const m of this.members) if (m) { this.root.remove(m); m.dispose(); }
    this.members = [];
    if (this.pins) { this.root.remove(this.pins); this.pins.dispose(); this.pins = null; }
    if (this.anchors) { this.root.remove(this.anchors); this.anchors.dispose(); this.anchors = null; }
    for (const cv of this.cannons) { this.root.remove(cv.root); this.root.remove(cv.pivot); }
    this.cannons = [];
    for (const cv of this.cores) { cv.group.visible = false; cv.light.intensity = 0; cv.active = false; }
    for (const s of this.shells) { s.id = 0; s.mesh.visible = false; }
    this._clearPuffs();
    this.puffs.visible = false;
    this.sim = null;
    this._built = false;
  }

  /** 彻底释放（含共享几何体、材质、光源）。游戏内不需要调用 */
  dispose() {
    this.clear();
    for (const k in this.geo) {
      const g = this.geo[k];
      if (Array.isArray(g)) g.forEach((x) => x.dispose()); else g.dispose();
    }
    for (const k in this.mat) {
      const m = this.mat[k];
      if (Array.isArray(m)) m.forEach((x) => x.dispose()); else m.dispose();
    }
    for (const cv of this.cores) { cv.gemMat.dispose(); cv.cageMat.dispose(); this.root.remove(cv.light); cv.light.dispose(); }
    this.puffs.dispose();
    this.world.groups.structure.remove(this.root);
  }

  setStressView(on) { this.stressOn = !!on; }

  // ================================================================ 事件
  onEvent(e, sim) {
    if (!this._built) return;
    switch (e.type) {
      case 'break': {
        const k = e.beam;
        if (k >= 0 && k < this.beamHidden.length && !this.beamHidden[k]) {
          this.beamHidden[k] = 1;
          const ki = this.beamKind[k], m = this.members[ki];
          if (m) {
            const a = m.instanceMatrix.array, s = this.beamSlot[k];
            zeroMat(a, s * 16);
            if (DOUBLE[ki]) zeroMat(a, (s + 1) * 16);
            m.instanceMatrix.needsUpdate = true;
          }
        }
        break;
      }
      case 'cannonLost': {
        const cv = this.cannons[e.cannon];
        if (cv) { cv.lost = true; cv.root.visible = false; cv.pivot.visible = false; }
        break;
      }
      case 'coreDestroyed': {
        const cv = this.cores[e.side];
        if (cv) { cv.dead = true; cv.gem.visible = false; cv.light.intensity = 0; cv.cageMat.color.setHex(shade(CHAR, -0.25)); }
        break;
      }
      case 'coreSunk': {
        const cv = this.cores[e.side];
        if (cv && cv.sinkT < 0) cv.sinkT = sim ? sim.time : 0;
        break;
      }
      default: break;
    }
  }

  // ================================================================ 每帧
  sync(sim, alpha) {
    if (!this._built || sim !== this.sim) return;
    if (!(alpha >= 0)) alpha = 0; else if (alpha > 1) alpha = 1;
    const n = sim.n, ix = this.ix, iy = this.iy;
    const X = sim.x, Y = sim.y, OX = sim.ox, OY = sim.oy;
    for (let i = 0; i < n; i++) {
      ix[i] = OX[i] + (X[i] - OX[i]) * alpha;
      iy[i] = OY[i] + (Y[i] - OY[i]) * alpha;
    }
    this._syncMembers(sim);
    this._syncPins(sim);
    this._syncCannons(sim, alpha);
    this._syncCores(sim);
    this._syncShells(sim, alpha);
  }

  _syncMembers(sim) {
    const beams = sim.beams, ix = this.ix, iy = this.iy;
    const rgb = this._rgb, stressOn = this.stressOn;
    const c0 = this.coreNode[0], c1 = this.coreNode[1];
    const mats = this._mats, cols = this._cols;
    for (let k = 0; k < beams.length; k++) {
      const b = beams[k];
      const ki = this.beamKind[k];
      const A = mats[ki], C = cols[ki];
      if (!A) continue;
      const slot = this.beamSlot[k], dbl = DOUBLE[ki];
      if (!b.alive || this.beamHidden[k]) {
        if (!this.beamHidden[k]) { this.beamHidden[k] = 1; zeroMat(A, slot * 16); if (dbl) zeroMat(A, (slot + 1) * 16); }
        continue;
      }
      let x1 = ix[b.a], y1 = iy[b.a], x2 = ix[b.b], y2 = iy[b.b];
      let dx = x2 - x1, dy = y2 - y1;
      let len = Math.sqrt(dx * dx + dy * dy);
      let c = 1, s = 0;
      if (len > 1e-6) { c = dx / len; s = dy / len; }
      // 核心节点处截短，露出宝石
      if (b.a === c0 || b.a === c1) {
        const t = Math.min(CORE_TRIM, len * 0.45);
        x1 += c * t; y1 += s * t; len -= t;
      }
      if (b.b === c0 || b.b === c1) {
        const t = Math.min(CORE_TRIM, len * 0.45);
        x2 -= c * t; y2 -= s * t; len -= t;
      }
      const mx = (x1 + x2) * 0.5, my = (y1 + y2) * 0.5;
      if (len < 1e-4) len = 1e-4;
      if (dbl) {
        writeRotZ(A, slot * 16, mx, my, FRAME_Z, c, s, len);
        writeRotZ(A, (slot + 1) * 16, mx, my, -FRAME_Z, c, s, len);
      } else {
        writeRotZ(A, slot * 16, mx, my, 0, c, s, len);
      }

      // ---- 颜色 ----
      let r, g, bl;
      if (stressOn) {
        stressRGB(b.stressVis, rgb);
        const mul = STRESS_MUL[ki];
        r = rgb[0] * mul; g = rgb[1] * mul; bl = rgb[2] * mul;
      } else {
        const mc = MAT_SRGB[ki];
        r = mc[0]; g = mc[1]; bl = mc[2];
      }
      const hpf = b.hpMax > 0 ? b.hp / b.hpMax : 1;
      const burn = 0.55 * (1 - (hpf < 0 ? 0 : hpf > 1 ? 1 : hpf));
      if (burn > 0) {
        r += (CHAR_SRGB[0] - r) * burn; g += (CHAR_SRGB[1] - g) * burn; bl += (CHAR_SRGB[2] - bl) * burn;
      }
      r = s2l(r); g = s2l(g); bl = s2l(bl);
      let o = slot * 3;
      C[o] = r; C[o + 1] = g; C[o + 2] = bl;
      if (dbl) { o += 3; C[o] = r; C[o + 1] = g; C[o + 2] = bl; }
    }
    for (let ki = 0; ki < 4; ki++) {
      const m = this.members[ki];
      if (m) { m.instanceMatrix.needsUpdate = true; m.instanceColor.needsUpdate = true; }
    }
  }

  _syncPins(sim) {
    if (!this.pins) return;
    const A = this.pins.instanceMatrix.array, slots = this.pinSlot, alive = sim.alive;
    const ix = this.ix, iy = this.iy;
    for (let i = 0; i < sim.n; i++) {
      const s = slots[i];
      if (s < 0) continue;
      if (alive[i]) writeRotZ(A, s * 16, ix[i], iy[i], 0, 1, 0, 1);
      else zeroMat(A, s * 16);
    }
    this.pins.instanceMatrix.needsUpdate = true;
  }

  _syncCannons(sim, alpha) {
    const ix = this.ix, iy = this.iy;
    for (let k = 0; k < this.cannons.length; k++) {
      const cv = this.cannons[k];
      if (cv.lost) continue;
      const c = sim.cannons[k];
      if (!c.alive) { cv.lost = true; cv.root.visible = false; cv.pivot.visible = false; continue; }
      const b = sim.beams[c.beam];
      const ax = ix[b.a], ay = iy[b.a], bx = ix[b.b], by = iy[b.b];
      let phi = Math.atan2(by - ay, bx - ax);
      if (c.up < 0) phi += Math.PI;
      cv.root.position.set((ax + bx) * 0.5, (ay + by) * 0.5, 0);
      cv.root.rotation.z = phi;
      const opx = c.opx ?? c.px, opy = c.opy ?? c.py, oang = c.oangle ?? c.angle;
      cv.pivot.position.set(opx + (c.px - opx) * alpha, opy + (c.py - opy) * alpha, 0);
      cv.pivot.rotation.z = oang + wrapPi(c.angle - oang) * alpha;
      cv.slide.position.x = -(c.recoil > 0 ? c.recoil : 0) * 0.4;
    }
  }

  _syncCores(sim) {
    const t = typeof this.world.time === 'number' ? this.world.time : sim.time;
    for (let s = 0; s < 2; s++) {
      const cv = this.cores[s], core = sim.cores[s];
      if (!cv.active || !core) continue;
      const node = core.node;
      if (!sim.alive[node]) { cv.group.visible = false; cv.light.intensity = 0; continue; }
      const x = this.ix[node], y = this.iy[node];
      cv.group.position.set(x, y, 0);
      cv.light.position.set(x, y, 1.1);
      if (cv.dead) continue;

      const hpf = Math.max(0, Math.min(1, core.hp / core.hpMax));
      const danger = 1 - hpf;
      // 血越少闪得越快越深
      const freq = 2.2 + 15 * danger;
      const depth = 0.06 + 0.62 * danger * danger;
      const wob = 0.5 + 0.5 * Math.sin(t * freq + s * 1.7) * Math.sin(t * freq * 0.37 + 0.9);
      let flick = 1 - depth * wob;
      const since = sim.time - core.lastHit;
      const flash = since >= 0 && since < 0.2 ? 1 - since / 0.2 : 0;

      cv.gem.rotation.set(t * 0.31, t * (0.7 + 1.2 * danger), 0);
      cv.gem.visible = true;
      cv.gemMat.emissive.copy(cv.glow).lerp(cv.white, flash);
      cv.gemMat.emissiveIntensity = (0.75 + 0.5 * flash) * flick;

      let li = (1.2 + 5.5 * hpf) * flick + 10 * flash;
      if (core.sunk || cv.sinkT >= 0) {
        const k = cv.sinkT >= 0 ? Math.max(0, 1 - (sim.time - cv.sinkT) / 1.2) : 0;
        li *= k;
        cv.gemMat.emissiveIntensity *= 0.3 + 0.7 * k;
      }
      cv.light.intensity = li;
    }
  }

  _syncShells(sim, alpha) {
    const pool = this.shells;
    for (let j = 0; j < SHELL_POOL; j++) pool[j].seen = false;
    const T = sim.time - CFG.dt * (1 - alpha); // 与插值后的画面对齐的时间
    const list = sim.shells;
    for (let i = 0; i < list.length; i++) {
      const sh = list[i];
      if (!sh.alive) continue;
      let slot = null;
      for (let j = 0; j < SHELL_POOL; j++) if (pool[j].id === sh.id) { slot = pool[j]; break; }
      const x = sh.ox + (sh.x - sh.ox) * alpha, y = sh.oy + (sh.y - sh.oy) * alpha;
      if (!slot) {
        for (let j = 0; j < SHELL_POOL; j++) if (pool[j].id === 0) { slot = pool[j]; break; }
        if (!slot) continue; // 池满（不会发生：同时在天上的炮弹远少于 16）
        slot.id = sh.id; slot.lx = sh.ox; slot.ly = sh.oy;
        slot.mesh.visible = true;
      }
      slot.seen = true;
      slot.mesh.position.set(x, y, 0);
      slot.mesh.rotation.z = T * 9;
      // 沿飞过的路径每隔 PUFF_STEP 留一团烟
      let dx = x - slot.lx, dy = y - slot.ly;
      let d = Math.sqrt(dx * dx + dy * dy);
      if (d > 6) { slot.lx = x; slot.ly = y; d = 0; }
      if (d >= PUFF_STEP) {
        const ux = dx / d, uy = dy / d;
        let guard = 0;
        while (d >= PUFF_STEP && guard++ < 24) {
          slot.lx += ux * PUFF_STEP; slot.ly += uy * PUFF_STEP; d -= PUFF_STEP;
          this._emitPuff(slot.lx, slot.ly, T - d / 19);
        }
      }
    }
    for (let j = 0; j < SHELL_POOL; j++) {
      const p = pool[j];
      if (!p.seen && p.id !== 0) { p.id = 0; p.mesh.visible = false; }
    }
    this._syncPuffs(T);
  }

  _emitPuff(x, y, born) {
    const d = this.puffData, o = this.puffNext * 6;
    this.puffNext = (this.puffNext + 1) % PUFF_POOL;
    d[o] = x + (Math.random() - 0.5) * 0.06;
    d[o + 1] = y + (Math.random() - 0.5) * 0.06;
    d[o + 2] = (Math.random() - 0.5) * 0.1;
    d[o + 3] = born;
    d[o + 4] = 0.085 + Math.random() * 0.05;
    d[o + 5] = 1;
  }

  _syncPuffs(T) {
    const d = this.puffData, A = this.puffs.instanceMatrix.array;
    for (let i = 0; i < PUFF_POOL; i++) {
      const o = i * 6;
      if (!d[o + 5]) { zeroMat(A, i * 16); continue; }
      let age = T - d[o + 3];
      if (age < 0) age = 0;
      const k = age / PUFF_LIFE;
      if (k >= 1) { d[o + 5] = 0; zeroMat(A, i * 16); continue; }
      const sc = d[o + 4] * (1 - k) * (1 + 0.9 * k);
      // 慢慢上飘，顺手转一下让低多边形的面闪一闪
      const rot = d[o + 4] * 40 + k * 1.5;
      writeRotZScaled(A, i * 16, d[o], d[o + 1] + age * 0.35, d[o + 2], Math.cos(rot), Math.sin(rot), sc);
    }
    this.puffs.instanceMatrix.needsUpdate = true;
  }

  _clearPuffs() {
    this.puffData.fill(0);
    this.puffNext = 0;
    const A = this.puffs.instanceMatrix.array;
    for (let i = 0; i < PUFF_POOL; i++) zeroMat(A, i * 16);
    this.puffs.instanceMatrix.needsUpdate = true;
  }

  // ================================================================ 构件工厂
  _makeCore(side) {
    const team = side === 0 ? THEME.team.player : THEME.team.enemy;
    const glowHex = side === 0 ? THEME.team.playerGlow : THEME.team.enemyGlow;
    const group = new THREE.Group();
    group.visible = false;
    const gemMat = new THREE.MeshStandardMaterial({
      color: team, emissive: glowHex, emissiveIntensity: 0.8, flatShading: true, roughness: 0.25, metalness: 0.05,
    });
    const gem = new THREE.Mesh(this.geo.gem, gemMat);
    const cageMat = new THREE.MeshStandardMaterial({ color: THEME.material.joint, flatShading: true, roughness: 0.4, metalness: 0.5 });
    const cage = new THREE.Mesh(this.geo.cage, cageMat);
    cage.castShadow = true; cage.receiveShadow = true;
    group.add(gem, cage);
    this.root.add(group);
    const light = new THREE.PointLight(team, 0, 9, 2);
    light.castShadow = false;
    this.root.add(light); // 不放进 group：group 隐藏时光源数量不变
    return {
      side, group, gem, gemMat, cage, cageMat, light,
      glow: new THREE.Color(glowHex), white: new THREE.Color(0xffffff),
      dead: false, sinkT: -1, active: false,
    };
  }

  _makeCannon(c) {
    const root = new THREE.Group();
    const wood = new THREE.Mesh(this.geo.carWood, this.mat.carriage);
    const iron = new THREE.Mesh(this.geo.carIron, this.mat.iron);
    for (const m of [wood, iron]) { m.castShadow = true; m.receiveShadow = true; root.add(m); }
    const pivot = new THREE.Group();
    const slide = new THREE.Group();
    const barrel = new THREE.Mesh(this.geo.barrel, this.mat.iron);
    const muzzle = new THREE.Mesh(this.geo.muzzle, this.mat.ring);
    const band = new THREE.Mesh(this.geo.band, this.mat.band[c.side === 1 ? 1 : 0]);
    for (const m of [barrel, muzzle, band]) { m.castShadow = true; m.receiveShadow = true; slide.add(m); }
    pivot.add(slide);
    this.root.add(root, pivot);
    const lost = !c.alive;
    root.visible = !lost; pivot.visible = !lost;
    return { root, pivot, slide, lost };
  }
}

// ---------------------------------------------------------------- 矩阵写入（列主序，直接写 instanceMatrix.array）
/** 绕 z 旋转（cos c, sin s），沿局部 x 缩放 sx，平移 (px, py, pz) */
function writeRotZ(a, o, px, py, pz, c, s, sx) {
  a[o] = c * sx; a[o + 1] = s * sx; a[o + 2] = 0; a[o + 3] = 0;
  a[o + 4] = -s; a[o + 5] = c; a[o + 6] = 0; a[o + 7] = 0;
  a[o + 8] = 0; a[o + 9] = 0; a[o + 10] = 1; a[o + 11] = 0;
  a[o + 12] = px; a[o + 13] = py; a[o + 14] = pz; a[o + 15] = 1;
}
/** 绕 z 旋转 + 均匀缩放 */
function writeRotZScaled(a, o, px, py, pz, c, s, k) {
  a[o] = c * k; a[o + 1] = s * k; a[o + 2] = 0; a[o + 3] = 0;
  a[o + 4] = -s * k; a[o + 5] = c * k; a[o + 6] = 0; a[o + 7] = 0;
  a[o + 8] = 0; a[o + 9] = 0; a[o + 10] = k; a[o + 11] = 0;
  a[o + 12] = px; a[o + 13] = py; a[o + 14] = pz; a[o + 15] = 1;
}
function zeroMat(a, o) {
  for (let i = 0; i < 15; i++) a[o + i] = 0;
  a[o + 15] = 1;
}
