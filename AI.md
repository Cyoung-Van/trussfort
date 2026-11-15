# 桁垒 · AI 对战接口

两个 AI 各交一份堡垒描述（JSON），引擎自动打一场，返回胜负和逐杆、逐炮的反馈。战斗全自动，同样的输入结果完全相同，所以 AI 可以"设计 → 对战 → 看反馈 → 改设计"反复迭代。

## 三步上手

```bash
node tools/duel.mjs --rules
```

```bash
node tools/duel.mjs --check forts/reference.json --versus forts/enemy.json
```

```bash
node tools/duel.mjs forts/reference.json forts/enemy.json --json
```

第一条打印完整规则（数值直接取自游戏配置）。第二条检查一座堡垒是否合规、站不站得住、每门炮的理想弹道落在哪。第三条打一场并输出完整结果。`forts/` 里有三座可以当范例的堡垒：`starter`（弱）、`reference`（能赢默认敌人）、`enemy`（默认敌人）。

## 堡垒描述格式

```json
{
  "name": "example",
  "beams": [
    [[0,0],[2,0],"steel"],
    [[0,-2],[2,0],"wood"],
    [[2,0],[4,3],"wood"]
  ],
  "cannons": [
    [[0,0],[2,0], 35],
    [[-6,0],[-3,0], {"core": true, "high": true}]
  ]
}
```

- `beams`：每项是 `[端点A, 端点B, 材料]`。端点直接写坐标，引擎自动建节点。材料是 `wood`、`steel`、`rope`、`spring`。
- `cannons`：每项是 `[端点A, 端点B, 射角]`，两个端点必须是一根已有杆件的两端，火炮架在这根杆的中点上方。
- 射角可以是数字（度，0 是水平朝敌方，向上为正），也可以让引擎解算：`{"core": true, "high": false}` 瞄准对方核心（`high` 为 `true` 用高抛弹道，可加 `dx`、`dy` 偏移），或 `{"at": [x, y], "high": false}` 瞄准任意点。
- 游戏里按 Ctrl/Cmd+S 导出的文件就是这个格式；编辑器的存档格式也能直接用。

## 坐标和规则

坐标单位是米，y 向上。**每座堡垒都用自己的本地坐标书写**：己方崖顶是 y=0、x≤0 的部分，崖壁在 x=0，永远朝 +x 开火。同一份描述放在左边或右边都能用，右边由引擎镜像。

| 项目 | 值 |
|---|---|
| 网格 | 所有节点必须在 1 米网格上 |
| 可建造范围 | x 从 -8 到 8，y 从 -4 到 11；不能在山体里（x<0 且 y<0），杆件不能穿过山体 |
| 固定锚点 | (-6,0) (-3,0) (0,0) (0,-2) (0,-4)，不会动，也不会被摧毁 |
| 己方核心 | 固定在 (4,3)，悬在水面上方，是一个 380 kg 的节点，必须用杆件托住 |
| 对方核心 | 本地坐标 (26,3) |
| 水面 | y = -6 |
| 预算 | 20,000 |
| 火炮 | 每门 1,500，最多 3 门，重 480 kg，耐久 200，每 4 秒一发 |
| 炮座 | 只能是木杆或钢梁，长度至少 1.4 米，倾角不超过 50° |
| 射角范围 | -15° 到 88° |
| 炮弹 | 初速 19 m/s，重力 9.81，散布 ±0.35° |
| 伤害 | 直击 110，溅射最多 60（半径 2.4 米内递减） |
| 时限 | 交火 90 秒，到时核心剩余耐久多者胜 |

| 材料 | 每米造价 | 每米质量 | 最长 | 抗拉 / 抗压极限 | 耐久 | 说明 |
|---|---|---|---|---|---|---|
| wood | 100 | 10 kg | 4 m | 40 kN / 40 kN | 100 | 一发直击就断 |
| steel | 240 | 26 kg | 4 m | 130 kN / 130 kN | 300 | 能扛三发左右 |
| rope | 40 | 1.5 kg | 8 m | 45 kN / 不受压 | 40 | 只受拉 |
| spring | 160 | 8 kg | 3 m | 22 kN / 22 kN | 80 | 很软，能缓冲后坐力但会晃 |

以上数值以 `node tools/duel.mjs --rules` 的输出为准。

## 设计时要知道的物理

- 桁架是铰接的：每根杆只受轴向拉压，没有三角形支撑的方框是机构，会折叠。
- 核心耐久 500；核心耐久归零或落水即判负。把托着核心的结构打塌让它落水，和直接打核心一样算赢。
- 所有杆件都挡炮弹，包括自家的：炮口前面有自家杆件就会打到自己。
- 被打伤的杆件承载力下降（最低降到三成），可能被它正扛着的力压断，引发连锁坍塌。
- 火炮自重和后坐力都是真实载荷。架在木头高塔顶上的炮，第一发就可能把塔震塌；炮座歪了，炮口跟着歪。
- 炮架在两个锚点之间的杆件上最稳（不会塌、不会歪），但位置低，只能高抛，炮本身仍然能被打掉。
- 开战前有 1.6 秒沉降：结构在自重下先稳定下来，承不住自重的设计在这一步就垮了。

## 结果里有什么

`duel` 的 JSON 输出：

| 字段 | 含义 |
|---|---|
| `winner` | `"A"`、`"B"` 或 `"draw"`（A 是第一个参数，在左边） |
| `reason` | `coreDestroyed`、`coreSunk`、`timeout`、`stalemate` |
| `fightSeconds` | 交火时长 |
| `A.coreHp`、`A.coreFate` | 核心剩余耐久，以及 `alive`、`destroyed`、`sunk` |
| `A.firstFailure` | 最先失守的那根杆，这通常就是该加固的地方 |
| `A.members[]` | 每根杆：端点 `a`、`b`，材料，全程受力峰值 `peak`（1 就是到极限），剩余耐久比例 `hpLeft`，以及 `broke`（时间、原因 `stress` 被压断 / `blast` 被炸断 / `sunk` 沉没、折断顺序） |
| `A.cannons[]` | 每门炮：炮座、射角、开火数、最大偏角 `maxTiltDeg`、炮弹落点统计 `landed`、是否失去 |
| `timeline` | 加 `--timeline` 才有：开火、命中、折断、核心受损等事件 |

`landed` 的键是 `enemy_member`、`enemy_core`、`enemy_cannon`、`own_member`、`own_core`、`own_cannon`、`ground`、`water`。出现 `own_` 说明这门炮在打自己。所有坐标都是该方的本地坐标，可以直接对回自己的设计。

## 公平性

左边一方的第一炮早 0.4 秒。正式比较两座堡垒时用主客场：

```bash
node tools/duel.mjs A.json B.json --match 4
```

`--match 4` 会用两个种子、每个种子左右各打一场，按胜场判定。单场可以用 `--seed N` 换种子。

## 在浏览器里观战

通过本地服务器打开时可以用网址直接载入并开战：

```bash
node tools/serve.mjs 5173
```

然后访问 `http://127.0.0.1:5173/?a=forts/reference.json&b=forts/enemy.json&autostart=1`。`a` 是左边，`b` 是右边。

双击 `index.html` 打开时，把 JSON 文件拖进窗口：拖到左半边载入为我方，右半边载入为敌方。

页面上还有一个脚本接口 `window.trussfort`：

| 方法 | 作用 |
|---|---|
| `rules()` | 规则对象 |
| `loadFort('player' 或 'enemy', 描述)` | 载入一座堡垒，返回是否成功 |
| `exportFort('player' 或 'enemy')` | 导出当前蓝图为堡垒描述 |
| `resetEnemy()` | 恢复默认敌人 |
| `start()`、`back()` | 开战、返回蓝图 |
| `result()` | 当前这场的阶段、胜者、核心耐久和统计 |

## 在自己的程序里调用

```js
import { rules, checkFort, duel, match, loadFort, exportFort } from './src/ai/api.js';

const report = checkFort(myFort, { versus: theirFort });
const result = duel(myFort, theirFort, { seed: 1, timeline: true });
```

这些函数不依赖浏览器。描述不合规则时 `duel` 和 `loadFort` 会抛出带原因的错误（`error.fortError` 为 `true`），`checkFort` 则把原因放进 `errors`。在这台机器上实测，一场 30 多秒的对战约 0.4 秒算完，`checkFort` 约 0.1 秒。
