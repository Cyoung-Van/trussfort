#!/usr/bin/env node
// 裁判脚本：让两个外部模型各设计一座堡垒，按轮次对战、反馈、再改，限时结束后给出比分。
//
//   node arena/referee.mjs --out arena/某次比赛 --work 临时目录 [--minutes 20] [--rounds 3] [--round-cap 360]
//        [--agy-model gemini-4-hydrogen-high] [--codex-model gpt-6.1-terra] [--codex-effort high] [--mock]
//
// 模型只负责输出堡垒 JSON；合规检查和对战都在这里用引擎完成。模型的回答只当数据用：
// 解析成 JSON → loadFort 规范化 → 进引擎，其它文字一律不执行、不转发给对手。
// --mock 不调用任何模型，用内置堡垒走一遍流程（检查脚本本身用）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rules, loadFort, exportFort, formatFort, checkFort, duel, match } from '../src/ai/api.js';
import { CFG, MATERIALS, CANNON } from '../src/config.js';
import { makeEnemyFort, makeReferenceFort } from '../src/sim/forts.js';
import { CURRENT_RULES } from '../src/rules.js';
import { buildIndex } from './index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const MOCK = argv.includes('--mock');
const MINUTES = Number(opt('--minutes', 20));
const ROUNDS = Number(opt('--rounds', 3));
const OUT = path.resolve(opt('--out', path.join(HERE, 'run')));
const WORK = path.resolve(opt('--work', path.join(os.tmpdir(), 'trussfort-arena')));
const REPAIR_SEC = 85;
const ROUND_CAP = Number(opt('--round-cap', 360));          // 每轮设计时限的上限（秒）
const AGY_MODEL = opt('--agy-model', 'gemini-4-hydrogen-high');
const CODEX_MODEL = opt('--codex-model', 'gpt-6.1-terra');
const CODEX_EFFORT = opt('--codex-effort', 'high');
const nameOf = (model, drop) => model.split('-').filter((w) => !drop.includes(w) && !/^[\d.]+$/.test(w)).pop();
const titleOf = (model) => model.split('-').map((w) => (w === 'gpt' ? 'GPT' : w[0].toUpperCase() + w.slice(1))).join(' ');

const DELEGATE = 'You are a delegate of Claude. Do the task yourself; do not call pi, codex, grok, agy or other agent CLIs.';
const players = [
  { id: nameOf(AGY_MODEL, ['low', 'medium', 'high', 'xhigh']), label: titleOf(AGY_MODEL.replace(/-(low|medium|high|xhigh)$/, '')) + ` (${/-(low|medium|high|xhigh)$/.exec(AGY_MODEL)?.[1] || 'default'})`, via: 'agy', model: AGY_MODEL, mem: null, halted: null, fort: null, check: null, note: '', score: 0 },
  { id: nameOf(CODEX_MODEL, []), label: `${titleOf(CODEX_MODEL)} (${CODEX_EFFORT})`, via: 'codex', model: CODEX_MODEL, mem: null, halted: null, fort: null, check: null, note: '', score: 0 },
];

fs.mkdirSync(OUT, { recursive: true });
for (const p of players) fs.mkdirSync(path.join(WORK, p.id), { recursive: true });
const save = (name, text) => fs.writeFileSync(path.join(OUT, name), text);
const events = [];
let t0 = 0;
const now = () => Date.now();
const elapsed = () => (t0 ? (now() - t0) / 1000 : 0);
const left = () => MINUTES * 60 - elapsed();
const clock = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function log(msg, data) {
  const line = `[${clock(elapsed())}] ${msg}`;
  console.log(line);
  events.push({ t: Math.round(elapsed() * 10) / 10, msg, ...(data || {}) });
  fs.writeFileSync(path.join(OUT, 'log.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

// ---------- 调用外部模型 ----------
function run(cmd, args, cwd, timeoutSec) {
  return new Promise((resolve) => {
    const t = now();
    let out = '', err = '', timedOut = false, done = false;
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out, err, timedOut, seconds: (now() - t) / 1000 }); };
    let child;
    try { child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true }); } catch (e) { resolve({ code: -1, out, err: String(e), timedOut, seconds: 0 }); return; }
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ } }, timeoutSec * 1000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { err += String(e); finish(-1); });
    child.on('close', (code) => finish(code));
  });
}

let mockN = 0;
async function ask(p, body, timeoutSec, tag) {
  const prompt = `${DELEGATE}\n\n${p.mem ? '' : briefing(p) + '\n\n'}${body}`;
  save(`${tag}-${p.id}-prompt.md`, prompt);
  if (p.halted) return { text: null, seconds: 0, timedOut: false, error: `已停用：${p.halted}` };
  let res;
  if (MOCK) {
    await new Promise((r) => setTimeout(r, 300));
    const n = mockN++;
    const text = n === 1 ? '这是一段不合规的回答 {"beams": [[[0,0],[9,9],"wood"]]}' : formatFort(exportFort((p.via === 'agy' ? makeReferenceFort : makeEnemyFort)().clone('player')));
    p.mem = 'mock';
    res = { text: '好的，方案如下：\n```json\n' + text + '\n```', seconds: 0.3, timedOut: false };
  } else if (p.via === 'agy') {
    const args = ['-p', prompt, '--model', p.model, '--output-format', 'json', '--sandbox', '--print-timeout', `${Math.floor(timeoutSec)}s`];
    if (p.mem) args.push('--conversation', p.mem);
    const r = await run(path.join(os.homedir(), '.local/bin/agy'), args, path.join(WORK, p.id), timeoutSec + 8);
    fs.writeFileSync(path.join(WORK, p.id, `${tag}.out`), r.out); fs.writeFileSync(path.join(WORK, p.id, `${tag}.err`), r.err);
    let j = null;
    try { j = JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch { /* 不是 JSON */ }
    if (j && j.conversation_id) p.mem = j.conversation_id;
    const bad = /suspend|policy|terms of service|violat|abuse|unsupported client/i;
    if (bad.test(r.err) || (j && j.status !== 'SUCCESS' && bad.test(JSON.stringify(j)))) p.halted = 'agy 报告了账号或政策类错误，已停止调用';
    res = { text: j && j.status === 'SUCCESS' && j.response ? String(j.response) : null, seconds: r.seconds, timedOut: r.timedOut, error: j ? (j.status !== 'SUCCESS' ? `agy 状态 ${j.status}` : '') : (r.err.trim().split('\n').pop() || '没有输出') };
  } else {
    const dir = path.join(WORK, p.id), outFile = path.join(dir, `${tag}.txt`);
    fs.rmSync(outFile, { force: true });
    const common = ['--skip-git-repo-check', '-m', p.model, '-c', `model_reasoning_effort="${CODEX_EFFORT}"`, '-o', outFile];
    const args = p.mem ? ['exec', 'resume', p.mem, ...common, prompt] : ['exec', '-s', 'read-only', '-C', dir, ...common, prompt];
    const r = await run('codex', args, dir, timeoutSec);
    fs.writeFileSync(path.join(dir, `${tag}.log`), r.out + '\n--- stderr ---\n' + r.err);
    const sid = /session id: ([0-9a-f-]{20,})/i.exec(r.out + r.err);
    if (sid) p.mem = sid[1];
    const text = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
    res = { text: text.trim() ? text : null, seconds: r.seconds, timedOut: r.timedOut, error: text.trim() ? '' : (r.err.trim().split('\n').pop() || '没有输出') };
  }
  save(`${tag}-${p.id}-reply.txt`, res.text || `（没有回答：${res.timedOut ? '超时' : res.error}）\n`);
  return res;
}

// ---------- 解析与检查 ----------
function parseFort(text) {
  const t = String(text).replace(/```[a-zA-Z]*\n?/g, '');
  const tries = [];
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) tries.push(t.slice(a, b + 1));
  // 回答里夹了别的花括号时，找包含 "beams" 的那一个配平的对象
  const k = t.indexOf('"beams"');
  if (k >= 0) {
    const s = t.lastIndexOf('{', k);
    let depth = 0;
    for (let i = s; i >= 0 && i < t.length; i++) {
      if (t[i] === '{') depth++;
      else if (t[i] === '}' && --depth === 0) { tries.push(t.slice(s, i + 1)); break; }
    }
  }
  for (const s of tries) { try { const o = JSON.parse(s); if (o && typeof o === 'object') return o; } catch { /* 试下一个 */ } }
  return null;
}
function tryFort(text, name) {
  const o = parseFort(text);
  if (!o) return { error: '回答里找不到可解析的 JSON 对象' };
  const c = checkFort(o);
  if (!c.ok) return { error: c.errors.join('；') };
  // 只保留引擎认得的内容：规范化后的杆件和火炮
  return { fort: exportFort(loadFort(o, 'player'), name), check: c };
}

// ---------- 给模型的文字 ----------
const aiDoc = fs.readFileSync(path.join(ROOT, 'AI.md'), 'utf8');
const section = (title) => { const m = new RegExp(`## ${title}\\n([\\s\\S]*?)(?=\\n## |$)`).exec(aiDoc); return m ? `## ${title}\n${m[1].trim()}` : ''; };
// 赛前材料里不放完整的堡垒：给过完整样板之后，所有参赛方都从它改起，结构趋同（前两场比赛的教训）。
// 只给几个「局部原理」的小例子，每个例子后面的事实都是裁判当场用引擎算出来的。
const PRINCIPLES = (() => {
  const base = (mat) => [[[0, 0], [2, 0], mat], [[0, -2], [2, 0], mat], [[2, 0], [4, 3], mat], [[0, 0], [2, 3], mat], [[2, 3], [4, 3], mat], [[2, 0], [2, 3], mat]];
  const stat = (f) => checkFort(f, { ignoreBudget: true }).static;
  // 1. 三角形才站得住：只用两根杆把核心「挂」出去，和用三角形托住
  const chain = [[[0, 0], [2, 3], 'wood'], [[2, 3], [4, 3], 'wood']];
  const s1a = stat({ beams: chain, cannons: [] }), s1b = stat({ beams: base('wood'), cannons: [] });
  // 2. 后坐力：同一门平射炮，架在 2 米高的矮台上、6 米高的木塔上、6 米高的钢塔上
  const low = (leg) => ({ beams: [...base('steel'), [[-6, 0], [-5, 2], leg], [[-3, 0], [-5, 2], leg], [[-3, 0], [-2, 2], leg], [[0, 0], [-2, 2], leg], [[-5, 2], [-2, 2], leg]], cannons: [[[-5, 2], [-2, 2], 15]] });
  const tower = (leg) => ({ beams: [...base('steel'), [[-3, 0], [-2, 3], leg], [[0, 0], [0, 3], leg], [[0, 0], [-2, 3], leg], [[-2, 3], [0, 3], leg], [[-2, 3], [-2, 6], leg], [[0, 3], [0, 6], leg], [[-2, 3], [0, 6], leg], [[-2, 6], [0, 6], leg]], cannons: [[[-2, 6], [0, 6], 15]] });
  const target = { beams: base('steel'), cannons: [] };
  const fire = (f) => {
    try {
      const d = duel(f, target, { ignoreBudget: true, allowUnarmed: true });
      const c = d.A.cannons[0];
      return `开火 ${c.shots} 发，炮座最大偏角 ${c.maxTiltDeg}°，自家被后坐力震断 ${d.A.members.filter((m) => m.broke && m.broke.cause === 'stress').length} 根杆${c.lost ? `，${c.lost.t} 秒时火炮${c.lost.cause === 'fell' ? '随炮座掉落' : '失去'}` : ''}`;
    } catch (e) { return '（算不出：' + e.message + '）'; }
  };
  return { chain, braced: base('wood'), s1a, s1b, low: low('wood'), tower: tower('wood'), fireLow: fire(low('wood')), fireWood: fire(tower('wood')), fireSteel: fire(tower('steel')) };
})();
const rows = (arr) => arr.map((x) => JSON.stringify(x)).join('\n');

function briefing(p) {
  return `你正在参加一场「桁垒 TRUSSFORT」堡垒设计对抗赛。你是参赛方「${p.label}」，对手是另一家的 AI 模型，裁判是 Claude。

# 比赛规则
1. 你设计一座堡垒，以一份 JSON 提交。战斗由引擎全自动进行（射角在设计里定死），开战后谁都不能干预。同样的两座堡垒加同样的种子，结果完全相同。
2. 全场限时 ${MINUTES} 分钟，最多 ${ROUNDS} 轮，时间不够会提前结束。第 1 轮双方盲设计；之后每轮你会收到上一轮的战报、你自己堡垒的逐杆逐炮数据，以及对手上一轮的堡垒，然后可以原样重交、修改或重做。双方同时提交，看不到对方本轮的稿子。
3. 每轮用双方当时有效的堡垒打 4 局（2 个种子，每个种子左右互换各一局），每赢一局得 1 分，平局不得分。各轮得分相加，总分高者胜；同分看最后一轮的胜局数，再同分看最后一轮 4 局里核心剩余耐久的总和。
4. 不许运行任何命令、读写任何文件或使用任何工具，只靠推理作答。合规检查和对战都由裁判用引擎完成，双方条件相同。
5. 提交不合规则（JSON 解析不了、超预算、违反建造限制）时，你有一次修正机会；仍不合规就沿用你上一轮的堡垒；如果你还没有任何合规堡垒，该轮 4 局全负。
6. 每轮有时限，写在每轮消息里，从你收到消息算起。超时未交按没有提交处理。

# 输出格式
你的最终回答必须只有一个 JSON 对象（堡垒描述），不要 Markdown 代码块，不要任何解释文字。

${section('堡垒描述格式')}

${section('坐标和规则')}

${section('设计时要知道的物理')}

## 规则数值（引擎导出，以此为准）
${JSON.stringify(rules())}

## 几个局部原理（不是完整的堡垒，只说明规则怎么起作用；后面的数字都是裁判用引擎算的）
1. 没有三角形支撑的结构是机构，会折叠。只用两根木杆把核心「挂」出去：
${formatFort({ beams: PRINCIPLES.chain, cannons: [] })}静载结果：核心${PRINCIPLES.s1a.coreHeld ? '托住了' : `没托住，下沉 ${PRINCIPLES.s1a.coreSagMeters} 米`}。改成三角形托住：
${formatFort({ beams: PRINCIPLES.braced, cannons: [] })}静载结果：核心${PRINCIPLES.s1b.coreHeld ? '托住了' : '没托住'}，自重下断了 ${PRINCIPLES.s1b.membersLostUnderOwnWeight} 根，受力峰值 ${PRINCIPLES.s1b.peakStressRatio}（1 就是到极限）。
2. 炮座必须由你自己搭的结构托着：炮座杆件的两端都不能是锚点，也不能贴地。火炮重 ${CANNON.mass} kg，后坐力是真实载荷，架得越高越难扛。同一门 15° 平射的炮，对着一座不还手的靶子打完一场：
   架在 2 米高的木头矮台上（下面的 cannons 所在的那根杆）：${PRINCIPLES.fireLow}。
${formatFort(PRINCIPLES.low)}   架在 6 米高的木塔顶上：${PRINCIPLES.fireWood}。
${formatFort(PRINCIPLES.tower)}   同一座塔全部换成钢杆：${PRINCIPLES.fireSteel}。
3. 绳索只受拉，松了就不传力；它很细，挡不住一整发炮弹，也挡不住溅射。
4. 一发炮弹有 ${CFG.shell.directDamage} 点直击伤害：剩余耐久小于这个数的杆件会被打穿，炮弹减速后带着剩下的伤害继续飞。一层木杆（耐久 ${MATERIALS.wood.hp}）挡不住一发，钢杆（耐久 ${MATERIALS.steel.hp}）可以。
5. 溅射伤害会被爆点和目标之间的杆件挡住，所以顶盖和外墙能护住后面的东西。
战报字段：landed 是这门炮的炮弹都落在了哪（enemy_member / enemy_core / enemy_cannon / own_member / own_core / own_cannon / ground / water），出现 own_ 说明在打自己；maxTiltDeg 是炮座最大偏角；peak 是杆件受力峰值（1 就是到极限）；broke.cause 中 stress 是被压断或拉断，blast 是被炸断，sunk 是沉没。reason 中 coreDestroyed 是核心被打爆，coreSunk 是核心落水，timeout 是到时按核心耐久判定。`;
}

function sideDetail(s) {
  const broken = s.members.filter((m) => m.broke).sort((x, y) => x.broke.order - y.broke.order);
  return [
    `核心 ${s.coreHp}/${s.coreHpMax}（${s.coreFate}），开火 ${s.shots} 命中 ${s.hits}，损失杆件 ${s.membersLost}/${s.members.length}，损失火炮 ${s.cannonsLost}/${s.cannons.length}`,
    '火炮：', rows(s.cannons) || '（没有火炮）',
    `折断的杆件（按先后，最多列 16 根）：`, rows(broken.slice(0, 16).map((m) => ({ a: m.a, b: m.b, mat: m.mat, t: m.broke.t, cause: m.broke.cause }))) || '（没有）',
    '没断但受力峰值不低于 0.7 的杆件：', rows(s.members.filter((m) => !m.broke && m.peak >= 0.7).map((m) => ({ a: m.a, b: m.b, mat: m.mat, peak: m.peak }))) || '（没有）',
  ].join('\n');
}
const sideBrief = (s) => `核心 ${s.coreHp}/${s.coreHpMax}（${s.coreFate}），损失杆件 ${s.membersLost}/${s.members.length}，损失火炮 ${s.cannonsLost}/${s.cannons.length}\n火炮：\n${rows(s.cannons.map((c) => ({ mount: c.mount, angleDeg: c.angleDeg, shots: c.shots, landed: c.landed, lost: c.lost }))) || '（没有火炮）'}`;

function roundPrompt(r, i, sec, last) {
  const me = players[i], foe = players[1 - i];
  const head = `第 ${r} 轮。本轮限时 ${sec} 秒，请留出余量。`;
  if (r === 1 || !last) return `${head}\n这是盲设计：你看不到对手的堡垒。现在提交你的堡垒 JSON，只输出一个 JSON 对象。`;
  const out = [head, `目前总分：你 ${me.score}，对手 ${foe.score}。`];
  if (me.note) out.push(`你上一轮的提交：${me.note}`);
  if (last.m.games.length) {
    out.push('## 上一轮 4 局结果');
    out.push(last.m.games.map((g) => {
      const mine = i === 0 ? g.coreHpA : g.coreHpB, theirs = i === 0 ? g.coreHpB : g.coreHpA;
      const w = g.winner === 'draw' ? '平局' : (g.winner === 'A') === (i === 0) ? '你胜' : '对手胜';
      return `种子 ${g.seed}，你在${(g.left === 'A') === (i === 0) ? '左' : '右'}：${w}（${g.reason}，${g.fightSeconds} 秒），核心 你 ${mine} / 对手 ${theirs}`;
    }).join('\n'));
  } else out.push(`## 上一轮没有开打：${last.why}`);
  if (me.fort) {
    const c = checkFort(me.fort, { versus: foe.fort || undefined });
    out.push('## 你当前堡垒的体检（裁判用引擎算的；shots 是蓝图姿态下的理想弹道，已把对手上一轮的结构算进去）');
    out.push(JSON.stringify({ cost: c.cost, budget: c.budget, breakdown: c.breakdown, static: c.static }) + '\n' + rows(c.shots));
  } else out.push('## 你目前还没有合规的堡垒');
  if (me.fort && foe.fort) {
    const home = i === 0 ? duel(me.fort, foe.fort) : duel(foe.fort, me.fort);   // 第 1 局：种子相同，hydrogen 在左
    const away = i === 0 ? duel(foe.fort, me.fort) : duel(me.fort, foe.fort);
    const [g1mine, g1foe] = i === 0 ? [home.A, home.B] : [home.B, home.A];
    const [g2mine, g2foe] = i === 0 ? [away.B, away.A] : [away.A, away.B];
    out.push(`## 种子 ${home.seed}、你在${i === 0 ? '左' : '右'}的那一局：你这一方（坐标是你的本地坐标）`, sideDetail(g1mine));
    out.push('## 同一局：对手一方（坐标是对手的本地坐标）', sideBrief(g1foe));
    out.push(`## 种子 ${away.seed}、你在${i === 0 ? '右' : '左'}的那一局：你这一方`, sideDetail(g2mine));
    out.push('## 同一局：对手一方', sideBrief(g2foe));
  }
  out.push('## 对手上一轮的堡垒（对手的本地坐标，和你的写法相同）', foe.fort ? formatFort(foe.fort) : '对手还没有合规的堡垒。');
  if (me.fort) out.push('## 你当前的堡垒', formatFort(me.fort));
  out.push(`现在提交第 ${r} 轮的堡垒 JSON（可以原样重交、修改或重做）。只输出一个 JSON 对象，不要代码块，不要解释。`);
  return out.join('\n');
}

// ---------- 一轮 ----------
async function design(r, i, sec, last) {
  const p = players[i];
  const a = await ask(p, roundPrompt(r, i, sec, last), sec, `r${r}`);
  log(`第 ${r} 轮 ${p.id}：${a.text ? `已回答（${a.seconds.toFixed(0)} 秒）` : a.timedOut ? `超时（${a.seconds.toFixed(0)} 秒）` : `没有回答：${a.error}`}`, { round: r, player: p.id, seconds: a.seconds, timedOut: a.timedOut });
  let v = a.text ? tryFort(a.text, p.id) : { error: a.timedOut ? '超时未提交' : (a.error || '没有回答') };
  let fixed = false;
  if (v.error && a.text && !p.halted) {
    const sec2 = Math.floor(Math.min(REPAIR_SEC, left() - 10));
    log(`第 ${r} 轮 ${p.id}：提交不合规（${v.error}）${sec2 >= 30 ? '，给一次修正机会' : '，剩余时间不够修正'}`, { round: r, player: p.id });
    if (sec2 >= 30) {
      const b = await ask(p, `你刚才的提交不合规则，引擎给出的原因：${v.error}\n这是唯一一次修正机会，限时 ${sec2} 秒。请重新输出完整的堡垒 JSON，只输出一个 JSON 对象。`, sec2, `r${r}-fix`);
      const v2 = b.text ? tryFort(b.text, p.id) : { error: b.timedOut ? '修正超时' : '修正没有回答' };
      if (v2.fort) { v = v2; fixed = true; } else v = { error: `${v.error} → ${v2.error}` };
      log(`第 ${r} 轮 ${p.id}：修正${v2.fort ? '后合规' : '失败（' + v2.error + '）'}（${b.seconds.toFixed(0)} 秒）`, { round: r, player: p.id, seconds: b.seconds });
    }
  }
  if (v.fort) { p.fort = v.fort; p.check = v.check; p.note = fixed ? '第一次不合规，修正后被采纳。' : '合规，已采纳。'; }
  else p.note = `未被采纳（${v.error}）。${p.fort ? '本轮沿用了你之前的堡垒。' : '你目前没有合规堡垒。'}`;
  return { player: p.id, accepted: !!v.fort, fixed, error: v.error || null, seconds: a.seconds, timedOut: a.timedOut };
}

const history = [];
async function main() {
  save('briefing.md', briefing(players[0]).replace(players[0].label, '（参赛方名称）'));
  t0 = now();
  log(`开赛：${players[0].label}（${players[0].via}）对 ${players[1].label}（${players[1].via}），限时 ${MINUTES} 分钟，最多 ${ROUNDS} 轮${MOCK ? '（模拟模式，不调用模型）' : ''}`);
  for (let r = 1; r <= ROUNDS; r++) {
    if (left() < 150) { log(`剩余 ${left().toFixed(0)} 秒，不够再打一轮，比赛结束`); break; }
    const sec = Math.min(ROUND_CAP, Math.max(60, Math.floor((left() - 15) / (ROUNDS - r + 1) - REPAIR_SEC - 5)));
    log(`第 ${r} 轮开始，设计限时 ${sec} 秒`);
    const last = history[history.length - 1];
    const subs = await Promise.all([design(r, 0, sec, last), design(r, 1, sec, last)]);
    const [A, B] = players;
    let m, why = '';
    if (A.fort && B.fort) m = match(A.fort, B.fort, { games: 4 });
    else {
      why = !A.fort && !B.fort ? '双方都没有合规堡垒' : `${(A.fort ? B : A).id} 没有合规堡垒，判 4 局全负`;
      m = { winner: A.fort ? 'A' : B.fort ? 'B' : 'draw', aWins: A.fort ? 4 : 0, bWins: B.fort ? 4 : 0, draws: 0, games: [] };
    }
    A.score += m.aWins; B.score += m.bWins;
    for (const p of players) if (p.fort) save(`r${r}-${p.id}.json`, formatFort(p.fort));
    const rec = { round: r, m, why, subs, cost: players.map((p) => (p.check ? p.check.cost : null)), cannons: players.map((p) => (p.fort ? p.fort.cannons.length : null)), score: [A.score, B.score], endedAt: Math.round(elapsed()) };
    history.push(rec);
    save(`r${r}-match.json`, JSON.stringify(rec, null, 2));
    log(`第 ${r} 轮比分 ${A.id} ${m.aWins} : ${m.bWins} ${B.id}${m.draws ? `（平 ${m.draws}）` : ''}${why ? '，' + why : ''}；总分 ${A.score} : ${B.score}`, { round: r, score: [A.score, B.score] });
    for (const g of m.games) log(`    种子 ${g.seed}，${g.left === 'A' ? A.id : B.id} 在左：${g.winner === 'draw' ? '平局' : (g.winner === 'A' ? A.id : B.id) + ' 胜'}（${g.reason}，${g.fightSeconds} 秒），核心 ${g.coreHpA} / ${g.coreHpB}`);
  }
  const [A, B] = players;
  const lastR = history[history.length - 1];
  let winner = A.score > B.score ? A.id : B.score > A.score ? B.id : null, by = '总分';
  if (!winner && lastR) {
    by = '最后一轮胜局';
    winner = lastR.m.aWins > lastR.m.bWins ? A.id : lastR.m.bWins > lastR.m.aWins ? B.id : null;
    if (!winner) {
      by = '最后一轮核心剩余耐久';
      const ha = lastR.m.games.reduce((s, g) => s + g.coreHpA, 0), hb = lastR.m.games.reduce((s, g) => s + g.coreHpB, 0);
      winner = ha > hb ? A.id : hb > ha ? B.id : null;
    }
  }
  const result = {
    players: players.map((p) => ({ id: p.id, label: p.label, via: p.via, model: p.model, score: p.score, halted: p.halted })),
    rules: CURRENT_RULES,   // 这场比赛用的规则版本，回放时按它来
    winner: winner || 'draw', decidedBy: winner ? by : '全部相同',
    rounds: history, totalSeconds: Math.round(elapsed()), limitSeconds: MINUTES * 60, mock: MOCK,
  };
  save('result.json', JSON.stringify(result, null, 2));
  // 记录放在 arena/ 下的正式比赛：更新回放列表用的清单
  if (!MOCK && path.dirname(OUT) === HERE) { try { buildIndex(HERE); } catch (e) { log('更新 arena/index.json 失败：' + e.message); } }
  log(`比赛结束，用时 ${clock(elapsed())}。总分 ${A.id} ${A.score} : ${B.score} ${B.id}，${winner ? winner + ' 胜（按' + by + '）' : '平局'}`);
}

main().catch((e) => { log('裁判脚本出错：' + (e && e.stack || e)); process.exit(1); });
