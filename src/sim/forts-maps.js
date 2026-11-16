// 「旷野」和「山梁」两张图的预设堡垒：守军（默认对手）和起手堡垒。
// 坐标式写法（和 AI 用的堡垒文件一样），forts/ 目录里的同名 JSON 是它们的导出。
// 设计目标和「海峡」的敌方 / 起手堡垒一样：守军造价 85~100% 预算、自重零断杆、撑得住自己的后坐；
// 起手堡垒 30~45% 预算，打守军会输但能撑十几秒以上。两座守军的炮都在屋顶上，没有遮盖，这是留给玩家的破绽。

import { Blueprint } from './blueprint.js';
import { getMap } from '../map.js';

const DEG = Math.PI / 180;

const SPECS = {
  plain: {
    garrison: {
      core: [0, 2],
      beams: [
        [[-3,0],[-3,2],'steel'], [[-3,2],[-3,4],'steel'], [[-3,4],[-3,6],'steel'], [[0,0],[0,2],'steel'],
        [[0,2],[0,4],'steel'], [[0,4],[0,6],'steel'], [[3,0],[3,2],'steel'], [[3,2],[3,4],'steel'],
        [[3,4],[3,6],'steel'], [[-3,2],[0,2],'steel'], [[0,2],[3,2],'steel'], [[-3,4],[0,4],'steel'],
        [[0,4],[3,4],'steel'], [[-3,6],[0,6],'steel'], [[0,6],[3,6],'steel'], [[-3,0],[0,2],'steel'],
        [[0,0],[3,2],'steel'], [[-3,2],[0,4],'steel'], [[0,2],[3,4],'steel'], [[-3,4],[0,6],'steel'],
        [[0,4],[3,6],'steel'],
      ],
      cannons: [[[-3,6],[0,6],63.915], [[0,6],[3,6],67.114]],
    },
    starter: {
      core: [2, 4],
      beams: [
        [[0,0],[0,2],'steel'], [[0,2],[0,4],'steel'], [[3,0],[3,2],'steel'], [[3,2],[3,4],'steel'],
        [[0,2],[3,2],'steel'], [[0,0],[3,2],'wood'], [[0,2],[3,4],'wood'], [[0,4],[2,4],'steel'],
        [[2,4],[3,4],'steel'], [[0,2],[2,4],'wood'], [[3,2],[2,4],'wood'], [[0,4],[0,5],'wood'],
        [[3,4],[3,5],'wood'], [[0,5],[3,5],'steel'], [[0,4],[3,5],'wood'],
      ],
      cannons: [[[0,4],[2,4],65.744]],
    },
  },
  ridge: {
    garrison: {
      core: [0, 2],
      beams: [
        [[-3,0],[-3,2],'steel'], [[-3,2],[-3,4],'steel'], [[-3,4],[-3,6],'steel'], [[0,0],[0,2],'steel'],
        [[0,2],[0,4],'steel'], [[0,4],[0,6],'steel'], [[3,0],[3,2],'steel'], [[3,2],[3,4],'steel'],
        [[3,4],[3,6],'steel'], [[-3,2],[0,2],'steel'], [[0,2],[3,2],'steel'], [[-3,4],[0,4],'steel'],
        [[0,4],[3,4],'steel'], [[-3,6],[0,6],'steel'], [[0,6],[3,6],'steel'], [[-3,0],[0,2],'steel'],
        [[0,0],[3,2],'steel'], [[-3,2],[0,4],'steel'], [[0,2],[3,4],'steel'], [[-3,4],[0,6],'steel'],
        [[0,4],[3,6],'steel'],
      ],
      cannons: [[[-3,6],[0,6],60.241], [[0,6],[3,6],63.915]],
    },
    starter: {
      core: [1, 4],
      beams: [
        [[0,0],[0,2],'steel'], [[0,2],[0,4],'steel'], [[3,0],[3,2],'steel'], [[3,2],[3,4],'steel'],
        [[0,2],[3,2],'steel'], [[0,0],[3,2],'wood'], [[0,2],[3,4],'wood'], [[0,4],[1,4],'steel'],
        [[1,4],[3,4],'steel'], [[0,2],[1,4],'wood'], [[3,2],[1,4],'wood'], [[0,4],[0,5],'wood'],
        [[3,4],[3,5],'wood'], [[0,5],[3,5],'steel'], [[0,4],[3,5],'wood'],
      ],
      cannons: [[[1,4],[3,4],63.44]],
    },
  },
};

function build(spec, side, map) {
  const bp = new Blueprint(side, undefined, map);
  const must = (r, what) => { if (!r.ok) throw new Error(`预设堡垒 ${what}: ${r.reason}`); return r; };
  must(bp.setCore(spec.core[0], spec.core[1]), '核心');
  const node = ([x, y]) => must(bp.addNode(x, y), `节点 (${x},${y})`).id;
  for (const [a, b, mat] of spec.beams) must(bp.addBeam(node(a), node(b), mat), `杆件 (${a})-(${b})`);
  for (const [a, b, deg] of spec.cannons) must(bp.addCannon(bp.beamBetween(node(a), node(b)).id, deg * DEG), `火炮 (${a})-(${b})`);
  return bp;
}

/** 这张图有没有某种预设堡垒。kind: 'garrison' | 'starter' */
export function hasMapPreset(mapId, kind) { return !!(SPECS[mapId] && SPECS[mapId][kind]); }
/** 取预设堡垒；这张图没有就返回 null */
export function mapPreset(mapId, kind, side = 'player') {
  return hasMapPreset(mapId, kind) ? build(SPECS[mapId][kind], side, getMap(mapId)) : null;
}
