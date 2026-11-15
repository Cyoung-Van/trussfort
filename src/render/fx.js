// 实景里所有一闪而过的东西：炮口焰、爆炸（闪光、火团、烟、冲击波环、火星、碎屑）、
// 断杆的两半、炮的残骸、水花、气泡。
// 低多边形风格：有棱角的烟团和碎片靠「缩到 0」消失，不用半透明贴片。
// 只读 sim，从不改 sim。update() 不分配内存。

import * as THREE from 'three';
import { CFG, CANNON } from '../config.js';
import { THEME } from '../theme.js';
import { F, ParticlePool, RingPool, makeSpec, resetSpec } from './fx-pool.js';
import { PieceSet, WreckSet } from './fx-body.js';

const TAU = Math.PI * 2;
function R(a, b) { return a + Math.random() * (b - a); }
function RI(a, b) { return Math.floor(a + Math.random() * (b - a + 1)); }
function sgn() { return Math.random() < 0.5 ? -1 : 1; }
function fin(v, lim) { return v > lim ? lim : v < -lim ? -lim : v === v ? v : 0; } // 夹紧并挡掉 NaN

// 杆件碎块的截面（与结构视图的杆件尺寸一致：面内高 × z 向宽）
const PIECE_DIMS = {
  wood: [0.24, 0.3],
  steel: [0.2, 0.26],
  rope: [0.09, 0.09],
  spring: [0.26, 0.26],
};

export class Fx {
  constructor(world) {
    this.world = world;
    const root = world.groups.fx;
    this.root = root;

    // ---- 颜色（线性空间，new THREE.Color(hex) 自动从 sRGB 转换） ----
    const c = (hex) => new THREE.Color(hex);
    const T = THEME;
    const white = new THREE.Color(1, 1, 1);
    this.C = {
      flash: c(T.fx.flash), fire: c(T.fx.fire), fireDeep: c(T.fx.fireDeep),
      smoke: c(T.fx.smoke), smokeDark: c(T.fx.smokeDark),
      smokeLight: c(T.fx.smoke).lerp(white, 0.35),      // 派生：炮口白烟
      spark: c(T.fx.spark), splash: c(T.fx.splash), shock: c(T.fx.shock),
      foam: c(T.world.foam),
      wood: c(T.material.wood), woodDark: c(T.material.wood).multiplyScalar(0.72), // 派生：木屑暗面
      steel: c(T.material.steel), steelDark: c(T.material.steel).multiplyScalar(0.6), // 派生
      rope: c(T.material.rope), spring: c(T.material.spring), joint: c(T.material.joint),
      rock: c(T.world.rock), rockDark: c(T.world.rockDark), grass: c(T.world.grass), grassDark: c(T.world.grassDark),
      team: [
        { main: c(T.team.player), glow: c(T.team.playerGlow) },
        { main: c(T.team.enemy), glow: c(T.team.enemyGlow) },
      ],
    };
    this.matColor = {
      wood: this.C.wood, steel: this.C.steel, rope: this.C.rope, spring: this.C.spring,
    };

    // ---- 材质与几何 ----
    // 发光类（闪光、火、火星）不受光照、不做色调映射，保证够亮
    const glowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const litMat = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.92, metalness: 0 });
    const shardMat = new THREE.MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.7, metalness: 0.08 });
    const puffGeo = new THREE.IcosahedronGeometry(0.5, 0);
    const bitLitGeo = new THREE.OctahedronGeometry(0.5, 0);
    const bitGlowGeo = new THREE.TetrahedronGeometry(0.5, 0);
    const boxGeo = new THREE.BoxGeometry(1, 1, 1);

    // ---- 粒子池（合计 1500） ----
    this.puffE = new ParticlePool(puffGeo, glowMat, 300);                        // 闪光、火团
    this.puffL = new ParticlePool(puffGeo, litMat, 380, { receiveShadow: true }); // 烟、泡沫、气泡、水柱
    this.bitE = new ParticlePool(bitGlowGeo, glowMat, 320);                      // 火星
    this.bitL = new ParticlePool(bitLitGeo, litMat, 260, { castShadow: true });  // 水滴、泥土、石屑
    this.shardL = new ParticlePool(boxGeo, shardMat, 160, { castShadow: true, receiveShadow: true }); // 木屑、钢片、草叶
    this.streakE = new ParticlePool(boxGeo, glowMat, 80);                        // 炮口星芒、断裂标记、能量碎片
    this.pools = [this.puffE, this.puffL, this.bitE, this.bitL, this.shardL, this.streakE];
    for (const p of this.pools) root.add(p.mesh);
    this.particleCap = this.pools.reduce((s, p) => s + p.cap, 0);

    // ---- 冲击波环：外缘白、内缘火色的渐变，亮天和深色结构前都看得清 ----
    const ringGeo = new THREE.RingGeometry(0.84, 1, 48, 1);
    {
      const pos = ringGeo.attributes.position;
      const cols = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const r = Math.hypot(pos.getX(i), pos.getY(i));
        const t = Math.min(1, Math.max(0, (r - 0.84) / 0.16));
        cols[i * 3] = this.C.fire.r + (this.C.shock.r - this.C.fire.r) * t;
        cols[i * 3 + 1] = this.C.fire.g + (this.C.shock.g - this.C.fire.g) * t;
        cols[i * 3 + 2] = this.C.fire.b + (this.C.shock.b - this.C.fire.b) * t;
      }
      ringGeo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    }
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, vertexColors: true, transparent: true, opacity: 1,
      depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    });
    this.shockRings = new RingPool(root, ringGeo, ringMat, 8, false);

    const waterRingGeo = new THREE.RingGeometry(0.78, 1, 40, 1);
    waterRingGeo.rotateX(-Math.PI / 2);
    const waterRingMat = new THREE.MeshBasicMaterial({
      color: T.fx.splash, transparent: true, opacity: 1, depthWrite: false, side: THREE.DoubleSide,
    });
    this.waterRings = new RingPool(root, waterRingGeo, waterRingMat, 12, true);

    // ---- 刚体碎块 ----
    this.pieces = new PieceSet(root, 60);
    this.wrecks = new WreckSet(root, 6, THEME.cannon, { barrelLen: CANNON.barrelLen, pivotH: CANNON.pivotH });

    // ---- 爆炸点光源（4 盏常驻，强度 0 时不亮，避免着色器重编译） ----
    this.lights = [];
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(T.fx.fire, 0, 16, 2);
      l.castShadow = false;
      root.add(l);
      this.lights.push({ light: l, t: 0, dur: 1, peak: 0 });
    }

    // ---- 气泡发射器（核心落水） ----
    this.emitters = [];
    for (let i = 0; i < 4; i++) this.emitters.push({ active: false, x: 0, t: 0, acc: 0, foamAcc: 0 });

    this.P = makeSpec();
    this._miniBudget = 8;

    // 传给池子的环境回调（构造时建一次，update 里不分配）
    const waterAt = typeof world.waterLevelAt === 'function'
      ? (x) => world.waterLevelAt(x, 0)
      : () => CFG.waterY;
    this.waterAt = waterAt;
    this.env = {
      fieldW: CFG.fieldW,
      waterY: CFG.waterY,
      waterAt,
      miniSplash: (x, y) => this._miniSplash(x, y),
      pop: (x, y) => this._bubblePop(x, y),
      splash: (x, y, power) => this._splash(x, power, y, true),
    };
    this._trail = (x, y) => this._wreckSmoke(x, y);
  }

  // ================================================================ 事件
  onEvent(e, sim) {
    switch (e.type) {
      case 'explode': this._onExplode(e); break;
      case 'fire': this._onFire(e); break;
      case 'break': if (e.cause !== 'sunk') this._onBreak(e); break;  // 沉没的杆件已经在水下，不再出残骸
      case 'cannonLost': this._onCannonLost(e, sim); break;
      case 'splash': this._splash(e.x, e.power, this.waterAt(e.x), false); break;
      case 'coreHit': this._onCoreHit(e, sim); break;
      case 'coreDestroyed': this._onCoreDestroyed(e); break;
      case 'coreSunk': this._onCoreSunk(e); break;
      default: break;
    }
  }

  _shake(s) { if (typeof this.world.addShake === 'function') this.world.addShake(s); }

  // ---------------------------------------------------------------- 爆炸
  _onExplode(e) {
    const x = e.x, y = e.y, C = this.C;
    const kind = e.kind;
    this._blast(x, y, 1);

    // 按命中物的碎屑
    if (kind === 'wood') {
      this._splinters(x, y, RI(6, 10), C.wood, C.woodDark, 4, 9, 1);
    } else if (kind === 'steel') {
      this._plates(x, y, RI(4, 6));
      this._sparks(x, y, 0.4, RI(8, 12), 6, 13, C.spark, C.fire, 0.13);
    } else if (kind === 'rope') {
      this._fibres(x, y, RI(4, 6), C.rope);
    } else if (kind === 'spring') {
      this._fibres(x, y, RI(4, 6), C.spring);
      this._sparks(x, y, 0.4, 5, 5, 10, C.spark, C.fire, 0.11);
    } else if (kind === 'ground') {
      this._groundBurst(x, y);
    } else if (kind === 'core' || kind === 'cannon') {
      const tm = this.C.team[e.hitSide === 1 ? 1 : 0];
      this._sparks(x, y, 0.5, kind === 'core' ? 16 : 10, 5, 12, tm.glow, tm.main, 0.15);
      if (kind === 'cannon') this._plates(x, y, 3, C.steelDark);
    }
    this._shake(kind === 'core' ? 0.5 : 0.35);
  }

  /** 爆炸主体：闪光 + 光源 + 火团 + 烟 + 冲击波 + 火星。scale 缩放整个爆炸 */
  _blast(x, y, scale) {
    const C = this.C;
    this._flash(x, y, 0.35, 0.3 * scale, 1.6 * scale, 0.1, 0);
    this._light(x, y, 90 * scale, 0.18);
    this._fireChunks(x, y, Math.round(R(8, 12) * scale), 3, 7, scale);
    this._smoke(x, y, Math.round(R(6, 10) * scale), 0.6 * scale, scale, 1.2, 2.2, 0.08);
    this.shockRings.spawn(x, y, 0.6, 0.3, CFG.shell.blastRadius * 1.15 * scale, 0.28, 0.95);
    this._sparks(x, y, 0.4, Math.round(R(10, 16) * scale), 5, 12, C.spark, C.fire, 0.12);
  }

  _flash(x, y, z, s0, s1, life, delay, color) {
    const P = resetSpec(this.P), C = this.C;
    P.x = x; P.y = y; P.z = z;
    P.rx = R(0, TAU); P.ry = R(0, TAU); P.rz = R(0, TAU);
    P.life = life; P.delay = delay;
    P.s0 = s0; P.s1 = s1; P.s2 = 0; P.peak = 0.7; P.hold = 0.8;
    P.c0 = color || C.flash; P.c1 = color || C.flash; P.c2 = C.fire; P.cmid = 0.6;
    this.puffE.emit(P);
  }

  _light(x, y, peak, dur) {
    let best = this.lights[0], bestLeft = Infinity;
    for (const L of this.lights) {
      const left = L.t >= L.dur ? 0 : L.peak * (1 - L.t / L.dur);
      if (left < bestLeft) { bestLeft = left; best = L; }
    }
    best.t = 0; best.dur = dur; best.peak = peak;
    best.light.position.set(x, y, 1.6);
    best.light.intensity = peak;
  }

  _fireChunks(x, y, n, spMin, spMax, scale, lifeMul = 1) {
    const P = this.P, C = this.C;
    for (let i = 0; i < n; i++) {
      resetSpec(P);
      const a = R(0, TAU), sp = R(spMin, spMax);
      P.x = x + R(-0.15, 0.15); P.y = y + R(-0.15, 0.15); P.z = R(-0.1, 0.4);
      P.vx = Math.cos(a) * sp; P.vy = Math.sin(a) * sp + 1.2; P.vz = R(-0.5, 0.5) * sp;
      P.rx = R(0, TAU); P.ry = R(0, TAU); P.wx = R(-6, 6); P.wz = R(-6, 6);
      P.drag = 5.5; P.grav = -0.15;
      P.life = R(0.35, 0.6) * lifeMul;
      P.s0 = 0.3 * scale; P.s1 = R(0.55, 0.9) * scale; P.s2 = 0; P.peak = 0.22; P.hold = 0.45;
      P.c0 = C.fire; P.c1 = C.fireDeep; P.c2 = C.smokeDark; P.cmid = 0.45;
      this.puffE.emit(P);
    }
  }

  _smoke(x, y, n, spread, scale, lifeMin, lifeMax, delayMax) {
    const P = this.P, C = this.C;
    for (let i = 0; i < n; i++) {
      resetSpec(P);
      P.x = x + R(-spread, spread); P.y = y + R(-spread * 0.5, spread * 0.8); P.z = R(-0.5, 0.7);
      P.vx = R(-0.9, 0.9); P.vy = R(0.4, 1.2); P.vz = R(-0.3, 0.3);
      P.rx = R(0, TAU); P.ry = R(0, TAU); P.rz = R(0, TAU);
      P.wx = R(-0.8, 0.8); P.wy = R(-0.8, 0.8);
      P.grav = -0.07; P.drag = 1.3;
      P.life = R(lifeMin, lifeMax); P.delay = R(0, delayMax);
      P.s0 = 0.4 * scale; P.s1 = R(1.0, 1.5) * scale; P.s2 = 0; P.peak = 0.35; P.hold = 0.67;
      P.c0 = Math.random() < 0.5 ? C.smokeDark : C.smoke; P.c1 = C.smoke; P.c2 = C.smokeLight; P.cmid = 0.5;
      this.puffL.emit(P);
    }
  }

  _sparks(x, y, z, n, spMin, spMax, cA, cB, size) {
    const P = this.P;
    for (let i = 0; i < n; i++) {
      resetSpec(P);
      const a = R(0, TAU), sp = R(spMin, spMax);
      P.x = x; P.y = y; P.z = z + R(-0.2, 0.2);
      P.vx = Math.cos(a) * sp; P.vy = Math.sin(a) * sp + 2; P.vz = R(-0.4, 0.4) * sp;
      P.rx = R(0, TAU); P.ry = R(0, TAU); P.wx = R(-15, 15); P.wy = R(-15, 15);
      P.grav = 1; P.drag = 0.8;
      P.life = R(0.35, 0.7);
      P.s0 = size; P.s1 = size * R(0.8, 1.3); P.s2 = 0; P.peak = 0.05; P.hold = 0.55;
      P.c0 = cA; P.c1 = cA; P.c2 = cB; P.cmid = 0.4;
      P.flags = F.GROUND | F.DIE_WATER;
      this.bitE.emit(P);
    }
  }

  /** 木屑（细长条） */
  _splinters(x, y, n, cA, cB, spMin, spMax, sizeMul) {
    const P = this.P;
    for (let i = 0; i < n; i++) {
      resetSpec(P);
      const a = R(0, TAU), sp = R(spMin, spMax);
      P.x = x + R(-0.1, 0.1); P.y = y + R(-0.1, 0.1); P.z = R(-0.2, 0.3);
      P.vx = Math.cos(a) * sp; P.vy = Math.sin(a) * sp + 2.5; P.vz = R(-0.3, 0.3) * sp;
      P.rx = R(0, TAU); P.ry = R(0, TAU); P.rz = R(0, TAU);
      P.wx = R(-12, 12); P.wy = R(-8, 8); P.wz = R(-14, 14);
      P.dx = R(0.45, 0.8) * sizeMul; P.dy = 0.07 * sizeMul; P.dz = 0.09 * sizeMul;
      P.grav = 1; P.drag = 0.3;
      P.life = R(2.2, 3.2);
      P.s0 = 1; P.s1 = 1; P.s2 = 0; P.peak = 0.01; P.hold = 0.8;
      P.c0 = Math.random() < 0.6 ? cA : cB; P.c1 = P.c0; P.c2 = P.c0;
      P.flags = F.GROUND | F.SINK | F.SPLASH;
      this.shardL.emit(P);
    }
  }

  /** 钢片（扁平小板） */
  _plates(x, y, n, color) {
    const P = this.P, C = this.C;
    for (let i = 0; i < n; i++) {
      resetSpec(P);
      const a = R(0, TAU), sp = R(4, 9);
      P.x = x; P.y = y; P.z = R(-0.2, 0.3);
      P.vx = Math.cos(a) * sp; P.vy = Math.sin(a) * sp + 2.5; P.vz = R(-0.3, 0.3) * sp;
      P.rx = R(0, TAU); P.ry = R(0, TAU); P.rz = R(0, TAU);
      P.wx = R(-14, 14); P.wy = R(-10, 10); P.wz = R(-14, 14);
      P.dx = R(0.24, 0.4); P.dy = 0.05; P.dz = R(0.16, 0.26);
      P.grav = 1; P.drag = 0.25;
      P.life = R(2.2, 3.2);
      P.s0 = 1; P.s1 = 1; P.s2 = 0; P.peak = 0.01; P.hold = 0.8;
      P.c0 = color || (Math.random() < 0.6 ? C.steel : C.steelDark); P.c1 = P.c0; P.c2 = P.c0;
      P.flags = F.GROUND | F.SINK | F.SPLASH;
      this.shardL.emit(P);
    }
  }

  /** 绳头 / 弹簧丝（很细的短条） */
  _fibres(x, y, n, color) {
    const P = this.P;
    for (let i = 0; i < n; i++) {
      resetSpec(P);
      const a = R(0, TAU), sp = R(3, 7);
      P.x = x; P.y = y; P.z = R(-0.2, 0.3);
      P.vx = Math.cos(a) * sp; P.vy = Math.sin(a) * sp + 2; P.vz = R(-0.3, 0.3) * sp;
      P.rx = R(0, TAU); P.rz = R(0, TAU); P.wx = R(-10, 10); P.wz = R(-16, 16);
      P.dx = R(0.3, 0.5); P.dy = 0.035; P.dz = 0.035;
      P.grav = 0.8; P.drag = 1.2;
      P.life = R(1.4, 2.2);
      P.s0 = 1; P.s1 = 1; P.s2 = 0; P.peak = 0.01; P.hold = 0.7;
      P.c0 = color; P.c1 = color; P.c2 = color;
      P.flags = F.GROUND | F.SINK;
      this.shardL.emit(P);
    }
  }

  /** 打在崖顶：泥土、石屑、草叶、土黄色烟尘 */
  _groundBurst(x, y) {
    const P = this.P, C = this.C;
    const n = RI(10, 14);
    for (let i = 0; i < n; i++) {
      resetSpec(P);
      const a = R(0.25, Math.PI - 0.25), sp = R(3, 8);
      const chip = i < 5;
      P.x = x + R(-0.2, 0.2); P.y = y + 0.05; P.z = R(-0.3, 0.4);
      P.vx = Math.cos(a) * sp; P.vy = Math.sin(a) * sp; P.vz = R(-0.3, 0.3) * sp;
      P.rx = R(0, TAU); P.ry = R(0, TAU); P.wx = R(-10, 10); P.wz = R(-10, 10);
      const s = chip ? R(0.18, 0.3) : R(0.1, 0.18);
      P.grav = 1; P.drag = 0.3;
      P.life = R(1.6, 2.6);
      P.s0 = s; P.s1 = s; P.s2 = 0; P.peak = 0.01; P.hold = 0.75;
      P.c0 = chip ? C.rockDark : C.rock; P.c1 = P.c0; P.c2 = P.c0;
      P.flags = F.GROUND | F.SINK | F.SPLASH;
      this.bitL.emit(P);
    }
    for (let i = 0; i < 5; i++) {
      resetSpec(P);
      const a = R(0.3, Math.PI - 0.3), sp = R(2, 6);
      P.x = x; P.y = y + 0.05; P.z = R(-0.3, 0.4);
      P.vx = Math.cos(a) * sp; P.vy = Math.sin(a) * sp; P.vz = R(-0.3, 0.3) * sp;
      P.rx = R(0, TAU); P.rz = R(0, TAU); P.wx = R(-9, 9); P.wz = R(-9, 9);
      P.dx = 0.22; P.dy = 0.03; P.dz = 0.09;
      P.grav = 0.7; P.drag = 1.5;
      P.life = R(1.4, 2.2);
      P.s0 = 1; P.s1 = 1; P.s2 = 0; P.peak = 0.01; P.hold = 0.7;
      P.c0 = Math.random() < 0.5 ? C.grass : C.grassDark; P.c1 = P.c0; P.c2 = P.c0;
      P.flags = F.GROUND;
      this.shardL.emit(P);
    }
    // 一圈贴地的土色烟尘
    for (let i = 0; i < 4; i++) {
      resetSpec(P);
      P.x = x + R(-0.6, 0.6); P.y = y + R(0.1, 0.4); P.z = R(-0.4, 0.6);
      P.vx = R(-1.4, 1.4); P.vy = R(0.3, 0.9);
      P.rx = R(0, TAU); P.ry = R(0, TAU); P.wy = R(-0.6, 0.6);
      P.grav = -0.03; P.drag = 1.6;
      P.life = R(1.0, 1.6);
      P.s0 = 0.4; P.s1 = R(0.9, 1.2); P.s2 = 0; P.peak = 0.3; P.hold = 0.65;
      P.c0 = C.rock; P.c1 = C.rock; P.c2 = C.smoke; P.cmid = 0.6;
      this.puffL.emit(P);
    }
  }

  // ---------------------------------------------------------------- 开炮
  _onFire(e) {
    const P = this.P, C = this.C;
    const ca = Math.cos(e.angle), sa = Math.sin(e.angle);
    const x = e.x, y = e.y;
    // 炮口闪光球
    this._flash(x + ca * 0.2, y + sa * 0.2, 0.05, 0.25, 0.8, 0.07, 0);
    // 星芒：一道沿炮管，两道斜开
    for (let i = 0; i < 3; i++) {
      resetSpec(P);
      const a = e.angle + (i === 0 ? 0 : i === 1 ? 0.62 : -0.62);
      const len = i === 0 ? 1.4 : 0.7;
      P.x = x + Math.cos(a) * len * 0.45; P.y = y + Math.sin(a) * len * 0.45; P.z = 0.05;
      P.rz = a; P.rx = R(0, TAU);
      P.dx = len; P.dy = i === 0 ? 0.16 : 0.1; P.dz = P.dy;
      P.life = 0.065;
      P.s0 = 0.45; P.s1 = 1; P.s2 = 0; P.peak = 0.3; P.hold = 0.55;
      P.c0 = C.flash; P.c1 = C.flash; P.c2 = C.fire; P.cmid = 0.5;
      this.streakE.emit(P);
    }
    // 顺着炮管喷出的烟，随后减速上飘
    const n = RI(5, 7);
    for (let i = 0; i < n; i++) {
      resetSpec(P);
      const sp = R(3, 7), off = R(0, 0.5), a = e.angle + R(-0.25, 0.25);
      P.x = x + ca * off; P.y = y + sa * off; P.z = R(-0.25, 0.35);
      P.vx = Math.cos(a) * sp; P.vy = Math.sin(a) * sp; P.vz = R(-0.4, 0.4);
      P.rx = R(0, TAU); P.ry = R(0, TAU); P.wx = R(-1, 1); P.wy = R(-1, 1);
      P.drag = 3.2; P.grav = -0.1;
      P.life = R(1.0, 1.8);
      P.s0 = 0.22; P.s1 = R(0.6, 0.95); P.s2 = 0; P.peak = 0.3; P.hold = 0.62;
      P.c0 = C.smokeLight; P.c1 = C.smokeLight; P.c2 = C.smoke; P.cmid = 0.5;
      this.puffL.emit(P);
    }
    this._sparks(x, y, 0.05, RI(3, 5), 2, 6, C.spark, C.fire, 0.09);
    this._light(x, y, 35, 0.1);
    this._shake(0.12);
  }

  // ---------------------------------------------------------------- 断杆
  _onBreak(e) {
    const C = this.C;
    const x1 = e.x1, y1 = e.y1, x2 = e.x2, y2 = e.y2;
    const dx = x2 - x1, dy = y2 - y1;
    const L = Math.hypot(dx, dy);
    if (!(L > 0.05)) return;
    const mx = (x1 + x2) * 0.5, my = (y1 + y2) * 0.5;
    const mat = e.mat;
    const col = this.matColor[mat] || C.wood;
    const dims = PIECE_DIMS[mat] || PIECE_DIMS.wood;

    this._half(x1, y1, dx / L, dy / L, L * 0.5, fin(e.vx1, 40), fin(e.vy1, 40), mat, col, dims);
    this._half(x2, y2, -dx / L, -dy / L, L * 0.5, fin(e.vx2, 40), fin(e.vy2, 40), mat, col, dims);

    // 断口碎屑
    const n = RI(4, 8);
    if (mat === 'steel') this._sparks(mx, my, 0.3, n + 2, 3, 8, C.spark, C.fire, 0.1);
    else if (mat === 'wood') this._splinters(mx, my, n, C.wood, C.woodDark, 2, 5, 0.7);
    else this._fibres(mx, my, n, col);

    // 超载断裂：白色「×」形断裂标记，一眼看出是被压断 / 拉断的
    if (e.cause === 'stress') {
      const P = this.P;
      const base = Math.atan2(dy, dx) + Math.PI / 2;
      for (let k = -1; k <= 1; k += 2) {
        resetSpec(P);
        P.x = mx; P.y = my; P.z = 0.55;
        P.rz = base + k * 0.55;
        P.dx = 0.95; P.dy = 0.085; P.dz = 0.085;
        P.life = 0.13;
        P.s0 = 0.35; P.s1 = 1; P.s2 = 0; P.peak = 0.22; P.hold = 0.55;
        P.c0 = C.shock; P.c1 = C.shock; P.c2 = C.shock;
        this.streakE.emit(P);
      }
      this._flash(mx, my, 0.5, 0.12, 0.5, 0.09, 0, C.shock);
    }
  }

  /** 断杆的一半：从自己的端点 (ex, ey) 指向断口 (ux, uy)，以端点为轴往下甩 */
  _half(ex, ey, ux, uy, h, vx, vy, mat, col, dims) {
    const thick = dims[0], depth = dims[1];
    if (mat === 'rope') {
      // 绳子没有刚性：切成几段各自乱翻
      const segs = Math.max(1, Math.ceil(h / 1.0));
      const sl = h / segs;
      for (let k = 0; k < segs; k++) {
        const b = this.pieces.alloc();
        const d = sl * (k + 0.5);
        b.x = ex + ux * d; b.y = ey + uy * d; b.z = R(-0.05, 0.05);
        b.vx = vx * (1 - 0.3 * k / segs) + R(-0.8, 0.8); b.vy = vy + R(-0.5, 1);
        b.ang = Math.atan2(uy, ux) + R(-0.3, 0.3); b.w = R(-7, 7); b.wroll = R(-2, 2);
        this._dress(b, sl * 0.94, thick, depth, col, 0.15);
      }
      return;
    }
    const len = h * 0.96;
    const b = this.pieces.alloc();
    const cx = ex + ux * len * 0.5, cy = ey + uy * len * 0.5;
    // 让断口那头往下掉：ω 的符号由断口在端点哪一侧决定
    let w = R(1.5, 3.2) * (Math.abs(ux) < 0.15 ? sgn() : -Math.sign(ux));
    if (mat === 'spring') w *= 1.4;
    const rx = cx - ex, ry = cy - ey;
    b.x = cx; b.y = cy; b.z = R(-0.04, 0.04);
    // 质心速度 = 端点速度 + ω × (质心 - 端点)，端点刚开始就是转轴
    b.vx = vx - w * ry + R(-0.3, 0.3);
    b.vy = vy + w * rx + R(-0.2, 0.4);
    b.ang = Math.atan2(uy, ux); b.w = w; b.wroll = R(-1, 1);
    this._dress(b, len, thick, depth, col, Math.min(0.45, Math.max(0.15, 0.12 + 0.08 * len)));
  }

  _dress(b, len, thick, depth, col, splashPower) {
    b.len = len; b.thick = thick; b.depth = depth;
    b.hx = len * 0.5; b.hy = thick * 0.5;
    b.r = col.r; b.g = col.g; b.b = col.b;
    b.splashPower = splashPower;
    // 出生就在水下的（沉没的节点）不再溅水花
    if (b.y < this.waterAt(b.x)) b.splashed = true;
  }

  // ---------------------------------------------------------------- 火炮损失
  _onCannonLost(e, sim) {
    const destroyed = e.cause === 'destroyed';
    if (destroyed) this._blast(e.x, e.y, 0.6);
    const b = this.wrecks.alloc();
    b.x = e.x; b.y = e.y; b.z = 0;
    b.vx = fin(e.vx, 30) + (destroyed ? R(-1.5, 1.5) : 0);
    b.vy = fin(e.vy, 30) + (destroyed ? R(2.5, 4.5) : 0);
    b.ang = e.angle; b.w = R(-1, 1) * (destroyed ? 4 : 1.5);
    b.wroll = R(-1, 1) * (destroyed ? 2 : 0.6);
    b.trail = destroyed; b.trailT = 0;
    // 炮架相对炮管的角度：取炮座杆件当前的方向
    let rel = 0;
    const c = sim && sim.cannons ? sim.cannons[e.cannon] : null;
    const beam = c && sim.beams ? sim.beams[c.beam] : null;
    if (beam) {
      let ba = Math.atan2(sim.y[beam.b] - sim.y[beam.a], sim.x[beam.b] - sim.x[beam.a]);
      if (ba > Math.PI / 2) ba -= Math.PI; else if (ba < -Math.PI / 2) ba += Math.PI;
      rel = ba - e.angle;
    }
    b.carriage.rotation.z = rel === rel ? rel : 0;
    if (b.y < this.waterAt(b.x)) b.splashed = true;
  }

  _wreckSmoke(x, y) {
    const P = resetSpec(this.P), C = this.C;
    P.x = x + R(-0.2, 0.2); P.y = y + R(-0.1, 0.2); P.z = R(-0.2, 0.3);
    P.vx = R(-0.3, 0.3); P.vy = R(0.3, 0.8);
    P.rx = R(0, TAU); P.ry = R(0, TAU); P.wy = R(-1, 1);
    P.grav = -0.06; P.drag = 1.2;
    P.life = R(0.9, 1.4);
    P.s0 = 0.25; P.s1 = R(0.6, 0.85); P.s2 = 0; P.peak = 0.3; P.hold = 0.6;
    P.c0 = C.smokeDark; P.c1 = C.smokeDark; P.c2 = C.smoke;
    this.puffL.emit(P);
  }

  // ---------------------------------------------------------------- 核心
  _corePos(sim, side) {
    const core = sim && sim.cores ? sim.cores[side] : null;
    if (!core) return null;
    return core.node;
  }

  _onCoreHit(e, sim) {
    const i = this._corePos(sim, e.side);
    if (i == null) return;
    const x = sim.x[i], y = sim.y[i];
    const tm = this.C.team[e.side === 1 ? 1 : 0];
    this._sparks(x, y, 0.6, 14, 4, 10, tm.glow, tm.main, 0.14);
    this._energyShards(x, y, 4, 5, 9, tm, 0.5);
  }

  _energyShards(x, y, n, spMin, spMax, tm, len) {
    const P = this.P;
    for (let i = 0; i < n; i++) {
      resetSpec(P);
      const a = R(0, TAU), sp = R(spMin, spMax);
      P.x = x; P.y = y; P.z = R(0.2, 0.8);
      P.vx = Math.cos(a) * sp; P.vy = Math.sin(a) * sp + 1.5; P.vz = R(-0.2, 0.2) * sp;
      P.wx = R(-10, 10);
      P.dx = len; P.dy = 0.09; P.dz = 0.09;
      P.grav = 0.6; P.drag = 1.2;
      P.life = R(0.6, 1.1);
      P.s0 = 1; P.s1 = 1; P.s2 = 0; P.peak = 0.01; P.hold = 0.5;
      P.c0 = tm.glow; P.c1 = tm.main; P.c2 = tm.main; P.cmid = 0.4;
      P.flags = F.ALIGN | F.DIE_WATER;
      this.streakE.emit(P);
    }
  }

  _onCoreDestroyed(e) {
    const x = e.x, y = e.y, C = this.C;
    const tm = C.team[e.side === 1 ? 1 : 0];
    // 两次闪光
    this._flash(x, y, 0.5, 0.5, 2.6, 0.12, 0);
    this._flash(x, y, 0.6, 0.8, 3.6, 0.16, 0.09);
    this._flash(x, y, 0.7, 0.4, 1.8, 0.12, 0.09, tm.glow);
    this._light(x, y, 220, 0.4);
    this._light(x, y + 1, 160, 0.55);
    // 火团、烟
    this._fireChunks(x, y, 34, 4, 11, 1.35, 1.5);
    this._smoke(x, y, 20, 2.2, 1.5, 2.0, 3.2, 0.35);
    // 两道错开的冲击波，第二道更大
    this.shockRings.spawn(x, y, 0.7, 0.4, 4.6, 0.32, 1);
    this.shockRings.spawn(x, y, 0.8, 0.6, 6.8, 0.45, 0.9, 0.15);
    // 能量碎片、火星、外壳碎片
    this._energyShards(x, y, 18, 8, 16, tm, 0.75);
    this._sparks(x, y, 0.5, 24, 6, 14, tm.glow, tm.main, 0.16);
    this._sparks(x, y, 0.5, 12, 5, 12, C.spark, C.fire, 0.14);
    this._plates(x, y, 10, C.joint);
    this._shake(1.0);
  }

  _onCoreSunk(e) {
    this._splash(e.x, 1, this.waterAt(e.x), false);
    let em = this.emitters[0];
    for (const m of this.emitters) if (!m.active) { em = m; break; }
    em.active = true; em.x = e.x; em.t = 2; em.acc = 0; em.foamAcc = 0;
  }

  // ---------------------------------------------------------------- 水
  /**
   * 水花。wl 是水面高度；small=true 时是碎块落水的小水花（不震屏）
   */
  _splash(x, power, wl, small) {
    const P = this.P, C = this.C;
    if (!(power > 0)) power = 0.15;
    if (power > 1) power = 1;
    if (!(wl === wl)) wl = CFG.waterY;
    const sp = Math.sqrt(power);
    // 扇形水滴
    const n = small ? Math.round(5 + 8 * power) : Math.round(8 + 16 * power);
    for (let i = 0; i < n; i++) {
      resetSpec(P);
      const a = Math.PI / 2 + R(-0.62, 0.62), v = R(3, 9) * sp;
      P.x = x + R(-0.2, 0.2); P.y = wl + 0.05; P.z = R(-0.35, 0.45);
      P.vx = Math.cos(a) * v; P.vy = Math.sin(a) * v; P.vz = R(-0.25, 0.25) * v;
      P.rx = R(0, TAU); P.ry = R(0, TAU); P.wx = R(-8, 8); P.wz = R(-8, 8);
      P.grav = 1; P.drag = 0.35;
      P.life = 2.5;
      const s = R(0.1, 0.2) * (0.7 + 0.5 * sp);
      P.s0 = s * 0.6; P.s1 = s; P.s2 = s * 0.5; P.peak = 0.04; P.hold = 0.5;
      P.c0 = C.splash; P.c1 = C.splash; P.c2 = C.splash;
      P.flags = F.DIE_WATER;
      this.bitL.emit(P);
    }
    // 中间的水柱：几颗顺着速度拉长的大水团
    if (power > 0.4) {
      const m = power > 0.8 ? 4 : 2;
      for (let i = 0; i < m; i++) {
        resetSpec(P);
        const v = R(6, 9.5) * sp;
        P.x = x + R(-0.15, 0.15); P.y = wl + 0.1; P.z = R(-0.15, 0.25);
        P.vx = R(-0.6, 0.6); P.vy = v; P.vz = R(-0.2, 0.2);
        P.rx = R(0, TAU);
        P.dx = 1.7; P.dy = 0.75; P.dz = 0.75;
        P.grav = 1; P.drag = 0.4;
        P.life = 2.5;
        const s = R(0.3, 0.45) * sp;
        P.s0 = s * 0.5; P.s1 = s; P.s2 = s * 0.4; P.peak = 0.08; P.hold = 0.4;
        P.c0 = C.foam; P.c1 = C.splash; P.c2 = C.splash;
        P.flags = F.DIE_WATER | F.ALIGN;
        this.puffL.emit(P);
      }
    }
    // 水面泡沫
    const nf = small ? 1 : power > 0.5 ? 3 : 2;
    for (let i = 0; i < nf; i++) {
      resetSpec(P);
      P.x = x + R(-0.4, 0.4) * (0.5 + power); P.y = wl + 0.04; P.z = R(-0.3, 0.4);
      P.vx = R(-0.4, 0.4); P.vz = R(-0.2, 0.2);
      P.ry = R(0, TAU);
      P.dx = 1; P.dy = 0.45; P.dz = 1;
      P.drag = 1.5;
      P.life = R(0.9, 1.3);
      P.s0 = 0.3; P.s1 = (0.55 + 0.75 * power) * (small ? 0.7 : 1); P.s2 = 0; P.peak = 0.3; P.hold = 0.6;
      P.c0 = C.foam; P.c1 = C.foam; P.c2 = C.splash;
      this.puffL.emit(P);
    }
    // 水面上扩散的平环
    this.waterRings.spawn(x, wl, 0, 0.3, (1.5 + 2.5 * power) * (small ? 0.6 : 1), 0.9, small ? 0.6 : 0.85);
    if (!small && power > 0.6) this._shake(0.18 * power);
  }

  /** 碎屑入水的小水花（每帧限量） */
  _miniSplash(x, y) {
    if (this._miniBudget <= 0) return;
    this._miniBudget--;
    const P = this.P, C = this.C;
    for (let i = 0; i < 3; i++) {
      resetSpec(P);
      P.x = x; P.y = y + 0.04; P.z = R(-0.2, 0.3);
      P.vx = R(-1, 1); P.vy = R(1.5, 3); P.vz = R(-0.3, 0.3);
      P.rx = R(0, TAU);
      P.grav = 1; P.drag = 0.3; P.life = 1.2;
      P.s0 = 0.08; P.s1 = 0.11; P.s2 = 0.05; P.peak = 0.1; P.hold = 0.6;
      P.c0 = C.splash; P.c1 = C.splash; P.c2 = C.splash;
      P.flags = F.DIE_WATER;
      this.bitL.emit(P);
    }
  }

  /** 气泡冒出水面：一个小泡沫 */
  _bubblePop(x, y) {
    if (this._miniBudget <= 0) return;
    this._miniBudget--;
    const P = resetSpec(this.P), C = this.C;
    P.x = x; P.y = y + 0.03; P.z = R(-0.3, 0.3);
    P.ry = R(0, TAU);
    P.dx = 1; P.dy = 0.4; P.dz = 1;
    P.life = R(0.4, 0.7);
    P.s0 = 0.15; P.s1 = R(0.3, 0.45); P.s2 = 0; P.peak = 0.3; P.hold = 0.5;
    P.c0 = C.foam; P.c1 = C.foam; P.c2 = C.splash;
    this.puffL.emit(P);
  }

  _emitBubbles(dt) {
    const P = this.P, C = this.C;
    for (let k = 0; k < this.emitters.length; k++) {
      const em = this.emitters[k];
      if (!em.active) continue;
      em.t -= dt;
      if (em.t <= 0) { em.active = false; continue; }
      em.acc += dt;
      while (em.acc >= 0.04) {
        em.acc -= 0.04;
        resetSpec(P);
        const wl = this.waterAt(em.x);
        P.x = em.x + R(-0.9, 0.9); P.y = wl - R(0.2, 1.0); P.z = R(-0.4, 0.5);
        P.vx = R(-0.2, 0.2); P.vy = R(1.2, 2.2);
        P.rx = R(0, TAU); P.ry = R(0, TAU);
        P.grav = -0.1; P.drag = 0.5;
        P.life = 2;
        const s = R(0.12, 0.28);
        P.s0 = s * 0.5; P.s1 = s; P.s2 = s; P.peak = 0.15; P.hold = 0.95;
        P.c0 = C.splash; P.c1 = C.foam; P.c2 = C.foam;
        P.flags = F.KILL_ABOVE;
        this.puffL.emit(P);
      }
    }
  }

  // ================================================================ 每帧
  update(dt) {
    if (!(dt > 0)) dt = 0; // 暂停时冻结，不消失
    this._miniBudget = 8;

    for (let i = 0; i < this.lights.length; i++) {
      const L = this.lights[i];
      if (L.peak <= 0) continue;
      L.t += dt;
      if (L.t >= L.dur) { L.peak = 0; L.light.intensity = 0; continue; }
      const u = 1 - L.t / L.dur;
      L.light.intensity = L.peak * u * u;
    }
    if (dt > 0) this._emitBubbles(dt);

    // 刚体先走（可能往粒子池里加水花、残骸烟），再统一更新粒子
    this.pieces.update(dt, this.env);
    this.wrecks.update(dt, this.env, this._trail);
    for (let i = 0; i < this.pools.length; i++) this.pools[i].update(dt, this.env);
    this.shockRings.update(dt, this.env);
    this.waterRings.update(dt, this.env);
  }

  clear() {
    for (const p of this.pools) p.clear();
    this.pieces.clear();
    this.wrecks.clear();
    this.shockRings.clear();
    this.waterRings.clear();
    for (const L of this.lights) { L.peak = 0; L.t = 0; L.light.intensity = 0; }
    for (const em of this.emitters) em.active = false;
  }

  /** 调试 / 测试用：当前存活的东西 */
  stats() {
    let particles = 0, peak = 0, dropped = 0;
    for (const p of this.pools) { particles += p.live; peak += p.peakLive; dropped += p.dropped; }
    let lights = 0;
    for (const L of this.lights) if (L.peak > 0) lights++;
    let emitters = 0;
    for (const em of this.emitters) if (em.active) emitters++;
    const pieces = this.pieces.bodies.reduce((s, b) => s + (b.active ? 1 : 0), 0);
    const wrecks = this.wrecks.bodies.reduce((s, b) => s + (b.active ? 1 : 0), 0);
    const rings = this.shockRings.activeCount() + this.waterRings.activeCount();
    return {
      particles, particleCap: this.particleCap, peakSum: peak, dropped,
      pieces, wrecks, rings, lights, emitters,
      alive: particles + pieces + wrecks + rings + lights + emitters,
    };
  }
}
