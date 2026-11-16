// 比赛记录必须能原样回放：arena/ 里每一局用记录的规则版本、种子和左右站位重打，结果要和记录一致。
// 规则以后怎么改，这条测试都得过——改规则要加新版本，不能动旧版本。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { duel } from '../src/ai/api.js';

const ARENA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'arena');
const index = JSON.parse(fs.readFileSync(path.join(ARENA, 'index.json'), 'utf8'));

for (const m of index.matches) {
  test(`回放一致：${m.id}（规则 ${m.rules || 'v1'}）`, () => {
    let n = 0;
    for (const r of m.rounds) {
      for (const g of r.games) {
        const fort = (i) => JSON.parse(fs.readFileSync(path.join(ARENA, m.id, r.forts[i]), 'utf8'));
        const res = duel(fort(g.left), fort(1 - g.left), { seed: g.seed, rules: m.rules || 'v1', map: m.map || 'strait' });
        const winner = res.winner === 'draw' ? null : res.winner === 'A' ? g.left : 1 - g.left;
        assert.equal(winner, g.winner, `第 ${r.round} 轮种子 ${g.seed} 左 ${g.left}：胜者`);
        assert.equal(res.reason, g.reason, `第 ${r.round} 轮种子 ${g.seed} 左 ${g.left}：原因`);
        assert.ok(Math.abs(res.fightSeconds - g.seconds) < 0.06, `第 ${r.round} 轮种子 ${g.seed} 左 ${g.left}：时长 ${res.fightSeconds} vs ${g.seconds}`);
        n++;
      }
    }
    assert.ok(n > 0, '这场比赛至少有一局可回放');
  });
}
