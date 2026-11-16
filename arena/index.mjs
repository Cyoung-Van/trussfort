#!/usr/bin/env node
// 把 arena/ 下每场比赛的 result.json 汇总成 arena/index.json，供网页里的「回放」面板读取。
//   node arena/index.mjs
// 裁判脚本打完一场会自动调用；手工增删比赛目录后可以单独运行。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const r1 = (v) => Math.round(v * 10) / 10;

export function buildIndex(dir = HERE) {
  const matches = [];
  for (const id of fs.readdirSync(dir).sort().reverse()) {
    const file = path.join(dir, id, 'result.json');
    if (!fs.existsSync(file)) continue;
    let res;
    try { res = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (res.mock || !Array.isArray(res.players) || res.players.length !== 2) continue;
    const ids = res.players.map((p) => p.id);
    const rounds = (res.rounds || []).map((r) => {
      // 每轮生效的堡垒：有就列出文件名，没有（超时、不合规）就是 null
      const forts = ids.map((pid) => (fs.existsSync(path.join(dir, id, `r${r.round}-${pid}.json`)) ? `r${r.round}-${pid}.json` : null));
      const notes = [];
      (r.subs || []).forEach((s, i) => {
        if (s.accepted) return;
        const what = s.timedOut ? '超时未交' : '提交不合规';
        notes.push(`${res.players[i].label} ${what}${forts[i] ? '，沿用上一轮的堡垒' : ''}`);
      });
      const playable = forts[0] && forts[1];
      if (!playable && (forts[0] || forts[1])) notes.push('一方没有合规堡垒，判 4 局全负，本轮没有开打');
      return {
        round: r.round,
        score: [r.m.aWins, r.m.bWins],
        forts,
        note: notes.join('；'),
        games: playable ? (r.m.games || []).map((g) => ({
          seed: g.seed,
          left: g.left === 'A' ? 0 : 1,
          winner: g.winner === 'A' ? 0 : g.winner === 'B' ? 1 : null,
          reason: g.reason,
          seconds: r1(g.fightSeconds),
          coreHp: [Math.round(g.coreHpA), Math.round(g.coreHpB)],
        })) : [],
      };
    });
    matches.push({
      id,
      rules: res.rules || 'v1',   // 这场比赛用的规则版本；回放必须按它来（没有这个字段的是最早的 v1）
      map: res.map || 'strait',   // 在哪张地图上打的（名字或整份地图数据）；没有这个字段的老比赛都打在「海峡」上
      date: (/^\d{4}-\d{2}-\d{2}/.exec(id) || [''])[0],
      players: res.players.map((p) => ({ id: p.id, label: p.label, via: p.via })),
      score: res.players.map((p) => p.score),
      winner: res.winner === 'draw' ? null : ids.indexOf(res.winner),
      decidedBy: res.decidedBy,
      rounds,
    });
  }
  const out = { version: 1, matches };
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(out, null, 1) + '\n');
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = buildIndex();
  for (const m of out.matches) console.log(`${m.id}：${m.players[0].label} ${m.score[0]} : ${m.score[1]} ${m.players[1].label}，可回放 ${m.rounds.reduce((n, r) => n + r.games.length, 0)} 局`);
}
