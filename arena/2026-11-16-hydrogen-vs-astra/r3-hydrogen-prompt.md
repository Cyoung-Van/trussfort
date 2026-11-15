You are a delegate of Claude. Do the task yourself; do not call pi, codex, grok, agy or other agent CLIs.

第 3 轮。本轮限时 480 秒，请留出余量。
目前总分：你 3，对手 5。
你上一轮的提交：合规，已采纳。
## 上一轮 4 局结果
种子 20261115，你在左：你胜（coreDestroyed，31.9 秒），核心 你 492.881 / 对手 0
种子 20261115，你在右：对手胜（coreDestroyed，51.9 秒），核心 你 0 / 对手 102.606
种子 20261116，你在左：你胜（coreDestroyed，35.9 秒），核心 你 500 / 对手 0
种子 20261116，你在右：你胜（coreDestroyed，36.317 秒），核心 你 161.642 / 对手 0
## 你当前堡垒的体检（裁判用引擎算的；shots 是蓝图姿态下的理想弹道，已把对手上一轮的结构算进去）
{"cost":19872,"budget":20000,"breakdown":{"wood":2122,"steel":13250,"rope":0,"spring":0,"cannon":4500},"static":{"membersLostUnderOwnWeight":0,"coreHeld":true,"coreSagMeters":0.014,"peakStressRatio":0.362}}
{"mount":[[-6,0],[-3,0]],"angleDeg":62.104,"lands":"enemyBeam","at":[22.969,7.906],"flightSeconds":3.011}
{"mount":[[-3,0],[0,0]],"angleDeg":65.935,"lands":"enemyBeam","at":[23.237,8.32],"flightSeconds":3.114}
{"mount":[[4,8],[6,8]],"angleDeg":74.593,"lands":"enemyBeam","at":[24.608,8.605],"flightSeconds":3.806}
## 种子 20261115、你在左的那一局：你这一方（坐标是你的本地坐标）
核心 492.881/500（alive），开火 18 命中 16，损失杆件 10/28，损失火炮 2/3
火炮：
{"mount":[[-6,0],[-3,0]],"angleDeg":62.104,"shots":8,"maxTiltDeg":0,"landed":{"enemy_member":5,"enemy_core":3},"lost":null}
{"mount":[[-3,0],[0,0]],"angleDeg":65.935,"shots":2,"maxTiltDeg":0,"landed":{"enemy_member":2},"lost":{"t":10.917,"cause":"destroyed"}}
{"mount":[[4,8],[6,8]],"angleDeg":74.593,"shots":8,"maxTiltDeg":179.839,"landed":{"enemy_member":4,"enemy_core":2,"ground":1,"water":1},"lost":{"t":33.25,"cause":"sunk"}}
折断的杆件（按先后，最多列 16 根）：
{"a":[7,10],"b":[8,8],"mat":"steel","t":9.533,"cause":"blast"}
{"a":[6,8],"b":[8,8],"mat":"steel","t":17.617,"cause":"blast"}
{"a":[-3,0],"b":[0,0],"mat":"wood","t":18.95,"cause":"blast"}
{"a":[6,8],"b":[7,10],"mat":"steel","t":19.483,"cause":"blast"}
{"a":[6,8],"b":[8,6],"mat":"steel","t":23.5,"cause":"blast"}
{"a":[4,6],"b":[8,6],"mat":"steel","t":29.783,"cause":"blast"}
{"a":[4,6],"b":[6,8],"mat":"steel","t":30.517,"cause":"blast"}
{"a":[4,6],"b":[6,3],"mat":"wood","t":31.683,"cause":"blast"}
{"a":[4,3],"b":[4,6],"mat":"wood","t":32.1,"cause":"stress"}
{"a":[2,3],"b":[4,6],"mat":"wood","t":32.667,"cause":"stress"}
没断但受力峰值不低于 0.7 的杆件：
{"a":[0,0],"b":[2,0],"mat":"steel","peak":0.796}
## 同一局：对手一方（坐标是对手的本地坐标）
核心 0/500（destroyed），损失杆件 9/25，损失火炮 0/3
火炮：
{"mount":[[-6,0],[-3,0]],"angleDeg":62.104,"shots":8,"landed":{"enemy_member":7},"lost":null}
{"mount":[[-3,0],[-1,1]],"angleDeg":59.818,"shots":8,"landed":{"enemy_cannon":2,"own_member":1,"enemy_member":3,"ground":1},"lost":null}
{"mount":[[-3,0],[0,0]],"angleDeg":65.935,"shots":8,"landed":{"enemy_member":7},"lost":null}
## 种子 20261115、你在右的那一局：你这一方
核心 0/500（destroyed），开火 19 命中 16，损失杆件 17/28，损失火炮 3/3
火炮：
{"mount":[[-6,0],[-3,0]],"angleDeg":62.104,"shots":10,"maxTiltDeg":0,"landed":{"enemy_member":7,"enemy_core":3},"lost":{"t":42.567,"cause":"fell"}}
{"mount":[[-3,0],[0,0]],"angleDeg":65.935,"shots":2,"maxTiltDeg":0,"landed":{"enemy_member":2},"lost":{"t":10.517,"cause":"destroyed"}}
{"mount":[[4,8],[6,8]],"angleDeg":74.593,"shots":7,"maxTiltDeg":179.684,"landed":{"enemy_member":4,"own_member":1,"ground":2},"lost":{"t":31.1,"cause":"destroyed"}}
折断的杆件（按先后，最多列 16 根）：
{"a":[7,10],"b":[8,8],"mat":"steel","t":9.183,"cause":"blast"}
{"a":[6,8],"b":[7,10],"mat":"steel","t":13.883,"cause":"blast"}
{"a":[6,8],"b":[8,8],"mat":"steel","t":15.067,"cause":"blast"}
{"a":[-3,0],"b":[0,0],"mat":"wood","t":18.55,"cause":"blast"}
{"a":[6,8],"b":[8,6],"mat":"steel","t":21.25,"cause":"blast"}
{"a":[4,6],"b":[8,6],"mat":"steel","t":33.367,"cause":"blast"}
{"a":[4,8],"b":[6,8],"mat":"steel","t":35.133,"cause":"blast"}
{"a":[4,6],"b":[6,3],"mat":"wood","t":37.5,"cause":"blast"}
{"a":[-6,0],"b":[-3,0],"mat":"wood","t":42.567,"cause":"blast"}
{"a":[4,6],"b":[4,8],"mat":"steel","t":43.217,"cause":"blast"}
{"a":[4,6],"b":[6,8],"mat":"steel","t":45.5,"cause":"blast"}
{"a":[4,3],"b":[4,6],"mat":"wood","t":47.367,"cause":"blast"}
{"a":[2,3],"b":[4,6],"mat":"wood","t":50.3,"cause":"blast"}
{"a":[4,3],"b":[6,3],"mat":"wood","t":51.367,"cause":"blast"}
{"a":[2,0],"b":[4,3],"mat":"steel","t":53.533,"cause":"blast"}
{"a":[2,3],"b":[4,3],"mat":"steel","t":53.533,"cause":"blast"}
没断但受力峰值不低于 0.7 的杆件：
{"a":[0,0],"b":[2,0],"mat":"steel","peak":0.775}
## 同一局：对手一方
核心 102.606/500（alive），损失杆件 6/25，损失火炮 0/3
火炮：
{"mount":[[-6,0],[-3,0]],"angleDeg":62.104,"shots":13,"landed":{"enemy_member":10,"enemy_core":3},"lost":null}
{"mount":[[-3,0],[-1,1]],"angleDeg":59.818,"shots":13,"landed":{"enemy_cannon":2,"enemy_member":3,"ground":7},"lost":null}
{"mount":[[-3,0],[0,0]],"angleDeg":65.935,"shots":13,"landed":{"enemy_member":9,"enemy_cannon":1,"enemy_core":2},"lost":null}
## 对手上一轮的堡垒（对手的本地坐标，和你的写法相同）
{
  "name": "astra",
  "beams": [
    [[-6,0],[-3,0],"wood"],
    [[-3,0],[0,0],"wood"],
    [[-3,0],[-1,1],"steel"],
    [[-1,1],[0,0],"wood"],
    [[0,0],[2,0],"steel"],
    [[0,-2],[2,0],"steel"],
    [[2,0],[4,0],"steel"],
    [[0,-2],[2,-2],"steel"],
    [[2,0],[2,-2],"wood"],
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
    [[-3,0],[-1,1],59.818]
  ]
}

## 你当前的堡垒
{
  "name": "hydrogen",
  "beams": [
    [[-6,0],[-3,0],"wood"],
    [[-3,0],[0,0],"wood"],
    [[0,0],[2,0],"steel"],
    [[2,0],[4,0],"steel"],
    [[0,-2],[2,-2],"steel"],
    [[0,-2],[2,0],"steel"],
    [[2,0],[2,-2],"steel"],
    [[2,-2],[4,0],"steel"],
    [[0,0],[2,3],"steel"],
    [[2,0],[2,3],"wood"],
    [[2,3],[4,3],"steel"],
    [[2,0],[4,3],"steel"],
    [[4,0],[4,3],"steel"],
    [[4,3],[6,3],"wood"],
    [[4,0],[6,3],"steel"],
    [[2,3],[4,6],"wood"],
    [[4,3],[4,6],"wood"],
    [[4,6],[6,3],"wood"],
    [[4,6],[8,6],"steel"],
    [[6,3],[8,6],"steel"],
    [[4,6],[4,8],"steel"],
    [[4,8],[6,8],"steel"],
    [[4,6],[6,8],"steel"],
    [[6,8],[8,6],"steel"],
    [[6,8],[8,8],"steel"],
    [[8,6],[8,8],"steel"],
    [[6,8],[7,10],"steel"],
    [[7,10],[8,8],"steel"]
  ],
  "cannons": [
    [[-6,0],[-3,0],62.104],
    [[-3,0],[0,0],65.935],
    [[4,8],[6,8],74.593]
  ]
}

现在提交第 3 轮的堡垒 JSON（可以原样重交、修改或重做）。只输出一个 JSON 对象，不要代码块，不要解释。