// 无头对战 / 体检工具。
//   node test/battle.mjs                 起手堡垒 vs 敌方堡垒，打印时间线
//   node test/battle.mjs --check enemy   只做静载体检（造价、受力比、下沉量、残余速度）
//   node test/battle.mjs --mirror        敌方堡垒 vs 敌方堡垒
//   node test/battle.mjs --seed 5        换随机种子
import { CFG, CANNON } from '../src/config.js';
import { Blueprint } from '../src/sim/blueprint.js';
import { Sim } from '../src/sim/sim.js';
import { makeEnemyFort, makeStarterFort } from '../src/sim/forts.js';
import { predictShot } from '../src/sim/ballistics.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

export function checkFort(bp, label = '') {
  const self = bp.clone('player');
  const sim = new Sim(self, new Blueprint('enemy'), { peace: true });
  const y0 = Float64Array.from(sim.y);
  for (let i = 0; i < 60 * 6; i++) { sim.step(); sim.events.length = 0; }
  let vmax = 0, sag = 0;
  for (let i = 0; i < sim.n; i++) {
    if (!sim.alive[i] || sim.side[i] !== 0) continue;
    vmax = Math.max(vmax, Math.hypot(sim.vx[i], sim.vy[i]));
    sag = Math.max(sag, y0[i] - sim.y[i]);
  }
  const beams = sim.beams.filter(b => b.side === 0);
  const top = beams.filter(b => b.alive).sort((a, b) => b.stress - a.stress).slice(0, 5);
  const name = (b) => { const A = self.nodes.get(sim.nodeBpId[b.a]), B = self.nodes.get(sim.nodeBpId[b.b]); return `(${A.x},${A.y})-(${B.x},${B.y}) ${b.matId}`; };
  const core = sim.cores[0];
  console.log(`== 体检 ${label} ==`);
  console.log(`造价 ${self.cost()} / ${CFG.budget}   杆件 ${self.beams.size}   火炮 ${self.cannons.size}`);
  console.log(`自重下断杆 ${sim.stats[0].beamsLost}   最大受力比 ${sim.maxStress(0).toFixed(3)}   最大下沉 ${(sag * 1000).toFixed(1)}mm   残余速度 ${vmax.toExponential(2)} m/s`);
  console.log(`核心 ${core.alive ? '稳' : '丢失'} y=${sim.y[core.node].toFixed(3)}`);
  for (const b of top) console.log(`   ${b.stress.toFixed(3)}  ${(b.f / 1000).toFixed(1)}kN  ${name(b)}`);
  for (const c of self.cannons.values()) {
    const p = predictShot(self, c, null);
    console.log(`   炮 ${((c.angle * 180) / Math.PI).toFixed(1)}° → ${p.end.kind} @ (${p.end.x.toFixed(1)}, ${p.end.y.toFixed(1)}) t=${p.t.toFixed(2)}s`);
  }
  return { sim, vmax, sag, maxStress: sim.maxStress(0), lost: sim.stats[0].beamsLost };
}

export function battle(bpP, bpE, { seed = 20261115, log = true } = {}) {
  const sim = new Sim(bpP, bpE, { seed });
  const tl = [];
  let frames = 0;
  while (frames < 60 * 140) {
    sim.step(); frames++;
    for (const e of sim.events) {
      const t = sim.time.toFixed(2);
      const who = e.side === 0 ? '玩家' : '敌方';
      if (e.type === 'coreHit') tl.push(`${t}s ${who}核心受损 -${e.dmg.toFixed(0)} → ${e.hp.toFixed(0)}`);
      else if (e.type === 'cannonLost') tl.push(`${t}s ${who}火炮失去 (${e.cause})`);
      else if (e.type === 'coreDestroyed') tl.push(`${t}s ${who}核心被毁`);
      else if (e.type === 'coreSunk') tl.push(`${t}s ${who}核心落水`);
      else if (e.type === 'end') tl.push(`${t}s 结束：${e.winner} (${e.reason})`);
    }
    sim.events.length = 0;
    if (sim.phase === 'ended' && sim.time - sim.endTime > 1) break;
  }
  if (log) {
    for (const l of tl) console.log(l);
    const s = sim.stats;
    console.log(`玩家：开火 ${s[0].shots} 命中 ${s[0].hits} 断杆 ${s[0].beamsLost} 失炮 ${s[0].cannonsLost} 核心 ${Math.max(0, sim.cores[0].hp).toFixed(0)}`);
    console.log(`敌方：开火 ${s[1].shots} 命中 ${s[1].hits} 断杆 ${s[1].beamsLost} 失炮 ${s[1].cannonsLost} 核心 ${Math.max(0, sim.cores[1].hp).toFixed(0)}`);
    console.log(`胜者 ${sim.winner}（${sim.endReason}）用时 ${sim.fightTime.toFixed(1)}s`);
  }
  return sim;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seed = +opt('--seed', 20261115);
  if (flag('--check')) {
    const which = opt('--check', 'enemy');
    checkFort(which === 'starter' ? makeStarterFort() : makeEnemyFort(), which);
  } else if (flag('--mirror')) {
    battle(makeEnemyFort().clone('player'), makeEnemyFort(), { seed });
  } else {
    checkFort(makeStarterFort(), 'starter');
    checkFort(makeEnemyFort(), 'enemy');
    battle(makeStarterFort(), makeEnemyFort(), { seed });
  }
}
