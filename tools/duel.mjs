#!/usr/bin/env node
// AI 对战命令行。说明见 AI.md。
//
//   node tools/duel.mjs A.json B.json            打一场（A 在左），打印摘要
//   node tools/duel.mjs A.json B.json --json     输出完整结果 JSON（逐杆、逐炮反馈）
//   node tools/duel.mjs A.json B.json --timeline 结果里附带事件时间线（配合 --json）
//   node tools/duel.mjs A.json B.json --match 4  公平对局：主客场各打，共 4 场，按胜场判定
//   node tools/duel.mjs --check A.json           只检查一座堡垒（规则、预算、静载、理想弹道）
//   node tools/duel.mjs --check A.json --versus B.json   弹道判定时把对方结构也算进去
//   node tools/duel.mjs --rules                  打印规则 JSON（场地、锚点、材料、火炮、炮弹……）
//   node tools/duel.mjs --export enemy|starter|reference   把内置堡垒导出成堡垒描述 JSON
//   通用选项：--seed N   --ignore-budget   --ruleset v1|v2（规则版本，默认是当前版本；旧比赛的堡垒要用它们当时的版本）
//   堡垒文件名可以写成 enemy / starter / reference，表示内置堡垒。
//
// 退出码：0 正常；2 堡垒不合法或参数有误。

import fs from 'node:fs';
import { rules, exportFort, formatFort, checkFort, duel, match } from '../src/ai/api.js';
import { makeEnemyFort, makeStarterFort, makeReferenceFort } from '../src/sim/forts.js';
import { RULESETS } from '../src/rules.js';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const VALUE_FLAGS = new Set(['--seed', '--match', '--check', '--versus', '--export', '--ruleset']);
const files = argv.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1]));
const BUILTIN = { enemy: makeEnemyFort, starter: makeStarterFort, reference: makeReferenceFort };
const print = (o) => console.log(JSON.stringify(o, null, 2));

function read(name) {
  if (BUILTIN[name]) return exportFort(BUILTIN[name]().clone('player'), name);
  let text;
  try { text = fs.readFileSync(name, 'utf8'); } catch { die(`读不到文件：${name}`); }
  try { return JSON.parse(text); } catch (e) { die(`${name} 不是合法的 JSON：${e.message}`); }
}
function die(msg) { console.error('错误：' + msg); process.exit(2); }

try {
  const seed = val('--seed') !== undefined ? Number(val('--seed')) : undefined;
  const ignoreBudget = has('--ignore-budget');
  const ruleset = val('--ruleset');
  if (ruleset !== undefined && !RULESETS[ruleset]) die(`没有规则版本 ${ruleset}，可用的有：${Object.keys(RULESETS).join('、')}`);

  if (has('--rules')) { print(rules(ruleset)); process.exit(0); }

  if (has('--export')) {
    const k = val('--export');
    if (!BUILTIN[k]) die('--export 后面跟 enemy、starter 或 reference');
    process.stdout.write(formatFort(exportFort(BUILTIN[k](), k)));
    process.exit(0);
  }

  if (has('--check')) {
    const r = checkFort(read(val('--check')), { ignoreBudget, rules: ruleset, versus: val('--versus') ? read(val('--versus')) : undefined });
    print(r);
    process.exit(r.ok ? 0 : 2);
  }

  if (files.length !== 2) die('需要两座堡垒的文件名。用法见本文件开头的注释，或看 AI.md');
  const A = read(files[0]), B = read(files[1]);

  if (has('--match')) {
    const games = Math.max(2, Number(val('--match')) || 4);
    const r = match(A, B, { games, ignoreBudget, rules: ruleset });
    if (has('--json')) print(r);
    else {
      for (const g of r.games) console.log(`种子 ${g.seed}  左边是 ${g.left}  →  ${g.winner === 'draw' ? '平局' : g.winner + ' 胜'}（${g.reason}，${g.fightSeconds.toFixed(1)}s，核心 A ${g.coreHpA} / B ${g.coreHpB}）`);
      console.log(`总计：A ${r.aWins} 胜，B ${r.bWins} 胜，平 ${r.draws}  →  ${r.winner === 'draw' ? '平局' : r.winner + ' 胜出'}`);
    }
    process.exit(0);
  }

  const r = duel(A, B, { seed, ignoreBudget, rules: ruleset, timeline: has('--timeline') });
  if (has('--json')) print(r);
  else {
    const line = (k, s) => {
      const ff = s.firstFailure;
      console.log(`${k}：造价 ${s.cost}  核心 ${s.coreHp}/${s.coreHpMax}（${s.coreFate}）  开火 ${s.shots} 命中 ${s.hits}  损失杆件 ${s.membersLost}/${s.members.length}  损失火炮 ${s.cannonsLost}/${s.cannons.length}`);
      if (ff) console.log(`   最先失守：(${ff.a})-(${ff.b}) ${ff.mat}，${ff.broke.t}s，${ff.broke.cause === 'stress' ? '被压断' : ff.broke.cause === 'blast' ? '被炸断' : '沉没'}`);
      for (const c of s.cannons) console.log(`   炮 (${c.mount[0]})-(${c.mount[1]}) ${c.angleDeg}°：开火 ${c.shots}，落点 ${JSON.stringify(c.landed)}，最大偏角 ${c.maxTiltDeg}°${c.lost ? `，${c.lost.t}s 失去（${c.lost.cause}）` : ''}${c.grounded ? '，炮座贴地开不了火' : ''}`);
    };
    console.log(`${r.winner === 'draw' ? '平局' : r.winner + ' 胜'}（${r.reason}），交火 ${r.fightSeconds.toFixed(1)}s，种子 ${r.seed}，规则 ${r.rules}`);
    line('A', r.A); line('B', r.B);
    console.log('（加 --json 看逐杆受力峰值和折断顺序，加 --match 4 打主客场）');
  }
} catch (e) {
  if (e && e.fortError) die(e.message);
  throw e;
}
