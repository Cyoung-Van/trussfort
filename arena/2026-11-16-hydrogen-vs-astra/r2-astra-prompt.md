You are a delegate of Claude. Do the task yourself; do not call pi, codex, grok, agy or other agent CLIs.

第 2 轮。本轮限时 480 秒，请留出余量。
目前总分：你 4，对手 0。
你上一轮的提交：合规，已采纳。
## 上一轮 4 局结果
种子 20261115，你在右：你胜（coreDestroyed，14.583 秒），核心 你 500 / 对手 0
种子 20261115，你在左：你胜（coreDestroyed，12.383 秒），核心 你 500 / 对手 0
种子 20261116，你在右：你胜（coreDestroyed，12.783 秒），核心 你 500 / 对手 0
种子 20261116，你在左：你胜（coreDestroyed，13.367 秒），核心 你 500 / 对手 0
## 你当前堡垒的体检（裁判用引擎算的；shots 是蓝图姿态下的理想弹道，已把对手上一轮的结构算进去）
{"cost":19798,"budget":20000,"breakdown":{"wood":1165,"steel":14133,"rope":0,"spring":0,"cannon":4500},"static":{"membersLostUnderOwnWeight":0,"coreHeld":true,"coreSagMeters":0.01,"peakStressRatio":0.282}}
{"mount":[[-6,0],[-3,0]],"angleDeg":62.104,"lands":"enemyBeam","at":[23.191,7.584],"flightSeconds":3.036}
{"mount":[[-3,0],[0,0]],"angleDeg":65.935,"lands":"enemyBeam","at":[23.495,7.875],"flightSeconds":3.147}
{"mount":[[-3,0],[-1,1]],"angleDeg":65.327,"lands":"enemyBeam","at":[23.474,7.864],"flightSeconds":3.161}
## 种子 20261115、你在右的那一局：你这一方（坐标是你的本地坐标）
核心 500/500（alive），开火 11 命中 8，损失杆件 1/25，损失火炮 0/3
火炮：
{"mount":[[-6,0],[-3,0]],"angleDeg":62.104,"shots":4,"maxTiltDeg":0,"landed":{"enemy_member":3},"lost":null}
{"mount":[[-3,0],[-1,1]],"angleDeg":65.327,"shots":4,"maxTiltDeg":0.028,"landed":{"enemy_core":2,"own_member":1},"lost":null}
{"mount":[[-3,0],[0,0]],"angleDeg":65.935,"shots":3,"maxTiltDeg":0,"landed":{"enemy_core":3},"lost":null}
折断的杆件（按先后，最多列 16 根）：
{"a":[8,6],"b":[6,9],"mat":"steel","t":9.267,"cause":"blast"}
没断但受力峰值不低于 0.7 的杆件：
{"a":[-3,0],"b":[-1,1],"mat":"wood","peak":0.777}
## 同一局：对手一方（坐标是对手的本地坐标）
核心 0/500（destroyed），损失杆件 21/31，损失火炮 1/3
火炮：
{"mount":[[-6,0],[-3,0]],"angleDeg":62.104,"shots":4,"landed":{"enemy_member":3},"lost":null}
{"mount":[[-3,0],[0,0]],"angleDeg":65.935,"shots":4,"landed":{"enemy_member":3},"lost":null}
{"mount":[[4,0],[6,0]],"angleDeg":22.278,"shots":1,"landed":{"enemy_member":1},"lost":{"t":5.6,"cause":"fell"}}
## 种子 20261115、你在左的那一局：你这一方
核心 500/500（alive），开火 9 命中 7，损失杆件 1/25，损失火炮 0/3
火炮：
{"mount":[[-6,0],[-3,0]],"angleDeg":62.104,"shots":3,"maxTiltDeg":0,"landed":{"enemy_member":2,"enemy_core":1},"lost":null}
{"mount":[[-3,0],[-1,1]],"angleDeg":65.327,"shots":3,"maxTiltDeg":0.028,"landed":{"enemy_member":1,"enemy_core":1},"lost":null}
{"mount":[[-3,0],[0,0]],"angleDeg":65.935,"shots":3,"maxTiltDeg":0,"landed":{"enemy_core":2,"own_member":1},"lost":null}
折断的杆件（按先后，最多列 16 根）：
{"a":[8,6],"b":[6,9],"mat":"steel","t":9.633,"cause":"blast"}
没断但受力峰值不低于 0.7 的杆件：
{"a":[-3,0],"b":[-1,1],"mat":"wood","peak":0.778}
## 同一局：对手一方
核心 0/500（destroyed），损失杆件 21/31，损失火炮 1/3
火炮：
{"mount":[[-6,0],[-3,0]],"angleDeg":62.104,"shots":3,"landed":{"enemy_member":3},"lost":null}
{"mount":[[-3,0],[0,0]],"angleDeg":65.935,"shots":3,"landed":{"enemy_member":2},"lost":null}
{"mount":[[4,0],[6,0]],"angleDeg":22.278,"shots":1,"landed":{"enemy_member":1},"lost":{"t":6,"cause":"fell"}}
## 对手上一轮的堡垒（对手的本地坐标，和你的写法相同）
{
  "name": "hydrogen",
  "beams": [
    [[-6,0],[-3,0],"wood"],
    [[-3,0],[0,0],"wood"],
    [[0,0],[2,0],"steel"],
    [[2,0],[4,0],"steel"],
    [[4,0],[6,0],"steel"],
    [[0,-2],[2,-2],"steel"],
    [[2,-2],[4,-2],"steel"],
    [[0,-4],[2,-2],"wood"],
    [[0,-2],[2,0],"wood"],
    [[2,0],[2,-2],"wood"],
    [[2,-2],[4,0],"wood"],
    [[4,0],[4,-2],"wood"],
    [[4,-2],[6,0],"steel"],
    [[0,0],[2,3],"steel"],
    [[2,0],[2,3],"wood"],
    [[2,3],[4,3],"steel"],
    [[2,0],[4,3],"steel"],
    [[4,0],[4,3],"steel"],
    [[4,3],[6,3],"steel"],
    [[2,3],[4,6],"wood"],
    [[4,3],[4,6],"wood"],
    [[4,6],[6,6],"steel"],
    [[4,6],[6,3],"steel"],
    [[6,3],[6,6],"steel"],
    [[6,3],[8,3],"steel"],
    [[6,6],[8,3],"steel"],
    [[8,3],[8,6],"steel"],
    [[6,6],[8,6],"steel"],
    [[6,6],[6,8],"wood"],
    [[6,8],[8,6],"steel"],
    [[4,6],[6,8],"steel"]
  ],
  "cannons": [
    [[-6,0],[-3,0],62.104],
    [[-3,0],[0,0],65.935],
    [[4,0],[6,0],22.278]
  ]
}

## 你当前的堡垒
{
  "name": "astra",
  "beams": [
    [[-6,0],[-3,0],"wood"],
    [[-3,0],[0,0],"wood"],
    [[-3,0],[-1,1],"wood"],
    [[-1,1],[0,0],"wood"],
    [[0,0],[2,0],"steel"],
    [[0,-2],[2,0],"steel"],
    [[2,0],[4,0],"steel"],
    [[0,-2],[2,-2],"steel"],
    [[2,0],[2,-2],"steel"],
    [[2,-2],[4,0],"steel"],
    [[4,0],[4,3],"steel"],
    [[2,0],[4,3],"steel"],
    [[0,0],[2,3],"steel"],
    [[2,0],[2,3],"steel"],
    [[2,3],[4,3],"steel"],
    [[4,3],[6,3],"wood"],
    [[4,0],[6,3],"steel"],
    [[6,3],[8,3],"steel"],
    [[4,3],[4,6],"steel"],
    [[6,3],[4,6],"steel"],
    [[6,3],[8,6],"steel"],
    [[8,3],[8,6],"steel"],
    [[4,6],[8,6],"steel"],
    [[8,6],[6,9],"steel"],
    [[4,6],[6,9],"steel"]
  ],
  "cannons": [
    [[-6,0],[-3,0],62.104],
    [[-3,0],[0,0],65.935],
    [[-3,0],[-1,1],65.327]
  ]
}

现在提交第 2 轮的堡垒 JSON（可以原样重交、修改或重做）。只输出一个 JSON 对象，不要代码块，不要解释。