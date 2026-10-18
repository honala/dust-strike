# DUST STRIKE（网页版 CSGO）— 团队接口契约 v1

> 所有成员开工前必须完整阅读本文件。本文件是唯一权威接口定义；与代码冲突时以本文件为准，发现契约问题立刻用 send_message 通知 Lead，不要自行改公共接口。

## 0. 项目目标

`C:\Users\XXPxx\Desktop\csgo-web` 下的纯前端 WebGL 第一人称射击游戏，模仿 CSGO 的核心体验：
- 双击 `index.html` 直接可玩（file:// 协议），零外部依赖、零构建、零网络资源（不加载 three.js / 图片 / 音频 / 字体，全部程序化生成）。
- 5v5：玩家（CT，名字"你"）+ 4 个 CT 机器人 vs 5 个 T 机器人。
- 武器、后坐力、命中判定（爆头）、回合制、购买经济、HUD、音效、机器人 AI 全部要有。
- 视觉风格：dust2 风格的沙漠地图（沙色墙面、木箱、混凝土、沙地），低多边形盒子风格但要协调好看。

## 1. 文件归属（写入范围，严禁越界）

| 文件 | 负责人 | 内容 |
|---|---|---|
| `CONTRACT.md`, `index.html`, `js/math.js`, `js/main.js`, `js/rules.js` | **Lead** | 契约、页面、数学库、主循环、回合经济 |
| `js/glcore.js`, `js/fx.js` | **renderer** | WebGL 渲染器、程序化纹理、特效 |
| `js/world.js` | **world** | 地图几何/碰撞/导航网格/出生点/区域 |
| `js/weapons.js`, `js/player.js` | **combat** | 武器数据/命中/伤害、玩家控制/枪械模型 |
| `js/bots.js` | **bots** | 机器人 AI、寻路、模型动画 |
| `js/hud.js`, `js/audio.js` | **hudaudio** | DOM HUD/菜单/准星、WebAudio 音效 |

其他人只读。需要改动别人文件 → 发消息给 Lead 或对应成员协调。Lead 负责最终集成和修 bug。

## 2. 通用规范

- 纯 classic JS（无 ES module、无 import/export/require）。每个文件用 IIFE 包裹：
  ```js
  (function () {
    'use strict';
    var CS = window.CS = window.CS || {};
    // ...
  })();
  ```
- 允许 ES2017+ 语法（let/const、箭头函数、模板字符串、class）。**不允许**任何网络请求、外部库、构建步骤。
- 单位：米，+Y 向上。玩家半径 0.32，站立高 1.8（眼高 1.62），蹲下高 1.2（眼高 1.1）。
- 角度：`yaw` 弧度，**0 = 朝 -Z**，**yaw 正 = 向右转（朝 +X）**；`pitch` 正 = 抬头。
  - `forward = [sin(yaw)*cos(pitch), sin(pitch), -cos(yaw)*cos(pitch)]`
  - `right = [cos(yaw), 0, sin(yaw)]`，水平前向 `[sin(yaw),0,-cos(yaw)]`
  - 让 bot 朝向目标：`yaw = Math.atan2(dx, -dz)`（dx = target.x-pos.x, dz = target.z-pos.z）。
  - 鼠标：dx>0（右移）→ yaw += dx*sens；dy>0（下移）→ pitch -= dy*sens。
- 矩阵：列主序 `Float32Array(16)`，与 WebGL 一致；由 `CS.math.M4` 提供。
- 代码注释用英文；玩家可见文案用简体中文。
- 每份文件完成后必须通过 `node --check <file>`（node 路径见下）。
- 性能目标：1600×900 下 60fps，draw call < 400，纹理 ≤ 256×256，DPR 上限 1.5。
- 稳定性：任何 `init` 失败不能让页面黑屏；控制台不允许出现未捕获异常。
- 玩家永远是 CT；敌方是 T。玩家名 `"你"`。

Node 可执行文件：`C:\Users\XXPxx\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`（直接 `node` 也在 PATH 里）。

## 3. 全局对象与加载顺序

`index.html` 按以下顺序加载脚本（全部 classic script）：

```
js/math.js → js/glcore.js → js/fx.js → js/audio.js → js/world.js → js/weapons.js
→ js/player.js → js/bots.js → js/hud.js → js/rules.js → js/main.js
```

全局命名空间：`window.CS`，子模块：`CS.math, CS.gl, CS.fx, CS.audio, CS.world, CS.weapons, CS.player, CS.bots, CS.hud, CS.rules, CS.game`。

## 4. CS.math API（Lead 已实现，直接用）

Vec3 用普通数组 `[x,y,z]`（或带索引对象均可，函数只读）；矩阵用 `Float32Array(16)` 列主序。

```js
CS.math.clamp(x,a,b); CS.math.lerp(a,b,t); CS.math.deg(r); CS.math.rad(d);
CS.math.rand(a,b) // [a,b) 浮点；randInt(a,b) 整数含 a 不含 b；choice(arr)
CS.math.dist(a,b); CS.math.dist2D(ax,az,bx,bz);
CS.math.normalizeAngle(a) // -> (-PI,PI]
CS.math.angleDiff(a,b)    // 从 a 到 b 的最短角差
CS.math.moveAngle(a,b,maxStep) // 朝 b 转最多 maxStep
CS.math.approach(cur,tgt,rate,dt)

V3.add(a,b); V3.sub(a,b); V3.scale(a,s); V3.mul(a,b); V3.dot(a,b); V3.cross(a,b);
V3.len(a); V3.norm(a); V3.lerp(a,b,t); V3.clone(a); V3.dist(a,b);
V3.transformMat4(v,m); V3.of(x,y,z);

M4.identity(); M4.clone(m); M4.multiply(a,b); M4.translation(x,y,z); M4.scaling(x,y,z);
M4.rotationX(rad); M4.rotationY(rad); M4.rotationZ(rad);
M4.perspective(fovyRad, aspect, near, far); M4.lookAt(eye, target, up); M4.invert(m);
M4.cameraWorld(eye, yaw, pitch) // = T(eye) * Ry(-yaw) * Rx(pitch)
M4.cameraView(eye, yaw, pitch)  // = invert(cameraWorld)
cameraForward(yaw,pitch); cameraRight(yaw); cameraUp(yaw,pitch)
```

`CS.math.M4.cameraWorld(eye,yaw,pitch)` 是给枪械 viewmodel 用的：将相机局部坐标（x 右、y 上、z 后）变换到世界。相机局部坐标中"前方"是 **-Z**。

## 5. CS.gl 渲染器 API（renderer）

```js
CS.gl.init(canvas) -> renderer
renderer.gl
renderer.resize()                       // 读 canvas.clientWidth/Height * dpr(<=1.5)
renderer.setCamera(eye, yaw, pitch, fovDeg)
renderer.camera                         // {eye,yaw,pitch,fov,aspect,view,proj,viewProj,invView,forward,right,up}
renderer.beginFrame({skyTop, skyBottom, fogColor, fogNear, fogFar}) // 参数可选，有默认沙色天空/热雾
renderer.drawMesh(mesh)                 // 静态合并网格
renderer.drawBox(texName, matrix, tint, uvScale) // 单位立方体 [-0.5,0.5]^3，matrix 将其变换到世界；tint=[r,g,b] 默认白；uvScale 默认 1
renderer.drawBeam(a, b, width, color)   // 弹道 tracer，加色混合，面向相机的长条
renderer.drawSprite(texName, pos, size, color, additive) // 面向相机方片，size=米
renderer.drawShadow(pos, radius, alpha) // 贴地暗圆，中心 pos，y+0.01
renderer.drawGroundDecal(pos, radius, color) // 可选：贴地标记（包点圆环可用）
renderer.endFrame()                     // 内部排序透明物，提交绘制
CS.gl.createMesh(verticesFloat32, indicesUint16, textureName) -> mesh
// 顶点 stride=8: [x,y,z, nx,ny,nz, u,v]
```

- 纹理名固定集合（renderer 程序化生成，256×256 左右，repeat 包裹）：
  `'white'`（纯白，用于 tint 色块）、`'sandfloor'`（沙地地面）、`'wall'`（沙色灰泥墙）、`'wall2'`（浅色石墙）、`'brick'`（土砖墙）、`'crate'`（木箱）、`'metal'`（金属）、`'concrete'`（混凝土）、`'wood'`（木板）、`'shadow'`（径向渐变黑圆）、`'spark'`、`'smoke'`、`'muzzle'`（枪口闪光）、`'blood'`。
  未知名 → 洋红棋盘格（便于发现错别字）。
- 光照：一个方向光（暖色太阳，从左上前方）+ 环境光/半球光，fog 混入沙色，不要求阴影贴图。
- 静态网格深度测试开启；`beginFrame` 清屏并绘制天空渐变（顶部偏蓝灰、地平线沙黄），可选太阳光晕。
- 透明/加色物体（beam/sprite）排队在 endFrame 按距离从远到近绘制。
- 必须实际渲染：`renderer.beginFrame()` 后才能 draw；同一帧内重复调用 beginFrame 会重置队列。
- 调试：`renderer.stats = {draws:0, tris:0}` 可选。

## 6. CS.fx 特效 API（renderer）

```js
CS.fx.init(renderer)                    // 可空实现；渲染器通过 renderer 传入 render()
CS.fx.tracer(from, to, color)           // 弹道：0.08s 渐隐亮线
CS.fx.impact(point, normal, material)   // 命中墙：火星/尘土粒子 + 弹孔（最多保留 80 个，8s 淡出）
CS.fx.muzzle(pos, dir, scale)           // 枪口闪光 + 少量烟，寿命 0.05s
CS.fx.blood(point, dir)                 // 血液粒子（红/暗红），0.5s
CS.fx.shell(pos, dir)                   // 抛壳（小黄块/精灵，重力），0.8s
CS.fx.update(dt)
CS.fx.render(renderer)
CS.fx.clear()                           // 回合切换清空
```

不使用外部资源；粒子总数上限 300，超了复用最旧。

## 7. CS.audio API（hudaudio）

```js
CS.audio.init()                 // 首次用户手势时调用；创建 AudioContext；重复调用安全
CS.audio.play(name, opts)       // opts: {pos:[x,y,z], volume=1, rate=1}
CS.audio.onEvent(event)         // main 每帧分发 game 事件
CS.audio.setListener(pos, yaw)  // 每帧更新听者
CS.audio.setVolume(0..1)
CS.audio.suspend(); CS.audio.resume();
```

必须合成的音效名：`ak47, m4a1, awp, glock, usp, knife_swing, knife_hit, reload_start, reload_end, switch, empty, step, hit, headshot, hurt, kill_confirm, round_start, win, lose, buy, beep, tick`。
- 用 OscillatorNode + AudioBuffer 白噪声 + 滤波器 + 包络合成；枪声要有低频"砰"+ 噪声爆裂，不同枪音色区分（AK 低沉、M4 清脆、AWP 巨响、手枪短促）。
- 空间：根据音源 pos 与听者的相对位置算左右声道 pan（StereoPannerNode）和距离衰减（8m 内清晰，40m 外很小）。
- 事件消费：`shot`（按 weapon 播放）、`step`（脚步）、`damage`/`kill`（命中/击杀确认，仅当 attacker/victim 涉及玩家时播放对应音）、`roundStart`（beep 两声）、`roundEnd`（win/lose）、`buy`、`empty`（空仓 click）。
- 若 AudioContext 不可用/被拒绝，全部静默降级，不抛异常。

## 8. CS.world API（world）

```js
CS.world.init(game) -> world          // 需在 CS.gl.init 之后调用；内部用 CS.gl.createMesh
world.boxes    // 碰撞盒数组：{min:[x,y,z], max:[x,y,z], kind:'wall'|'wall2'|'brick'|'crate'|'metal'|'concrete'|'wood'|'floor'}
world.spawns = { ct:[{pos:[x,0,z], yaw}, ...5个], t:[...5个] }
world.zones = { tSpawn, ctSpawn, mid, siteA, siteB, longA, longB, tunnels } // 每项 {points:[[x,z],...]}
world.sites = { A:{center:[x,z], radius:5}, B:{center:[x,z], radius:5} }
world.raycast(origin, dir, maxDist) -> null | {dist, point:[x,y,z], normal:[x,y,z], box}
world.los(from, to) -> boolean        // 两点之间无遮挡（子弹级线段测试）
world.moveEntity(pos, delta, radius, height) -> {pos:[x,y,z], onGround, hitWall, hitCeil}
CS.world.nav = {
  cell: 0.75,
  isWalkable(x,z),                    // 可站人
  findPath(fromX, fromZ, toX, toZ),   // A* 8向；返回 [[x,z],...]（含终点）或 null；路径长度合理
  nearestWalkable(x,z) -> [x,z],
  randomPointInZone(zoneName) -> [x,z] | null,
  randomPoint() -> [x,z]
}
world.render(renderer)
```

### 地图要求（world 成员执行）
- 整体矩形约 `x∈[-32,32], z∈[-34,34]`，外围高墙（高 ≥6m）封闭，地面 y=0 全覆盖。**全图平坦无楼梯斜坡**（bot 导航只支持平面），可放可跳上的矮箱但不要依赖。
- CT 出生区在 z≈-27 附近；T 出生区在 z≈+27 附近；中间是 dust2 风格布局：中路（mid）直通南北，A 包点在 `(-17,-6)` 附近，B 包点在 `(17,-4)` 附近，T 侧有左右两条长通道绕向 A/B（longA/longB），CT 侧左右两翼连接 A/B。
- 大量木箱、混凝土矮墙、拱门/门洞做掩体；视线不能一眼看穿全图；避免死胡同和卡人缝隙。
- 出生点 5 个/队，位置错开且 yaw 朝向地图中心；`zones` 的 points 必须可站立（用 nav 验证）。
- 静态几何按材质合并成若干 mesh（每种纹理一个 buffer），总三角形 < 20k。
- 用 `world.moveEntity` 保证玩家/bot 不穿墙、能贴墙滑动、落地 onGround。
- `raycast` 要忽略 floor? 不，floor 也是实体；墙体法线要正确（子弹命中特效方向）。
- 包点区域画地面标记（可用带 tint 的薄盒子/地面 decal），A 用橙红、B 用蓝。
- 地图要有名称：`world.name = 'Dust Strike'`。

## 9. CS.weapons API（combat）

```js
CS.weapons.defs = { ... }  // 见下表
CS.weapons.hitscan(game, origin, dir, maxDist, shooter) -> null | {target, point, zone, dist}
  // 同时检测 world.raycast 与所有存活敌人；返回最近命中；starter 自己/同队跳过；无命中 wall 时返回 {target:null, point, dist, normal}? 
  // 约定：命中敌方返回 target；只命中墙时返回 {target:null, point, normal, dist}；超程返回 null。
CS.weapons.hit(game, target, baseDamage, attacker, weaponId, zone, point)
  // 统一伤害入口：护甲/爆头/腿倍率、扣血、emit 事件、死亡处理
CS.weapons.currentDef(player) // 可选辅助
```

武器表（价格/数值可微调但要接近，HUD 直接读）：

| id | 名称 | 槽位 | 价格 | 伤害 | 爆头倍率 | RPM | 弹匣/备弹 | 射程 | 自动 | 换弹s |
|---|---|---|---|---|---|---|---|---|---|---|
| knife | 匕首 | knife | 0 | 55 | 1.6 | 120 | -/- | 2.0 | 否 | - |
| usp | USP-S | secondary | 200 | 30 | 3.2 | 350 | 12/100 | 55 | 否 | 2.2 |
| glock | Glock-18 | secondary | 200 | 26 | 3.0 | 400 | 20/120 | 60 | 否 | 2.0 |
| m4a1 | M4A1-S | primary | 2900 | 33 | 3.8 | 600 | 30/90 | 80 | 是 | 3.1 |
| ak47 | AK-47 | primary | 2700 | 36 | 3.9 | 600 | 30/90 | 80 | 是 | 2.9 |
| awp | AWP | primary | 4750 | 115 | 1.5 | 41 | 10/30 | 120 | 否 | 3.7 |

每个 def 至少包含字段：`{id, name, slot, price, damage, headshot, rpm, mag, reserve, range, auto, reloadTime, drawTime, kick, spread:[base,move,air], recoil:{v,h}, sound, armorPen?}`。
- 玩家 CT 默认副武器 usp；T 默认 glock；双方刀。
- 价格供购买菜单（HUD 从 defs 读）。

伤害规则（统一在 `CS.weapons.hit`）：
- 同队/死亡目标直接忽略（无友伤）。
- `dmg = baseDamage * (zone==='head' ? def.headshot : zone==='legs' ? 0.75 : 1)`。
- 若 `target.armor > 0`：`dmg *= 0.5`，`target.armor = max(0, target.armor - baseDamage*0.5)`（护甲吸收到 0 后不再减伤）。
- `target.health -= dmg`；emit `{type:'damage', target, attacker, amount:dmg, zone, point, weapon:weaponId}`。
- 血量 ≤0：`health=0; alive=false`；emit `{type:'kill', killer:attacker, victim:target, weapon:weaponId, headshot:zone==='head'}`；调用 `target.onKilled(attacker, weaponId, zone)`（若存在）。
- `target` 可以是 `game.player` 或 bot 对象，必须有 `.team/.health/.armor/.alive`。
- 后坐力/散布由射击方（player）实现；bot 用自己的误差。音效/特效由射击方调用 `game.emit`、`CS.fx`。

## 10. CS.player API（combat）

```js
CS.player.init(game) -> player
// 字段：pos(feet), vel, yaw, pitch, health, armor, alive, onGround, crouching, walking,
//      team:'ct', name:'你', loadout:{primary,secondary:'usp',knife:'knife'}, current:'secondary',
//      ammo:{usp:{mag,reserve}, ...}, def, reloading, reloadT, drawT, viewKick, bobT, stepT,
//      kills, deaths, crosshairSpread(0..1), scoped(bool)
player.update(game, dt)
player.renderViewmodel(renderer)   // 绘制第一人称枪模 + 手
player.rayTest(origin, dir, maxDist) -> {dist, point, zone:'head'|'body'|'legs'} | null  // 供 bot 子弹命中玩家
player.eye() -> [x,y,z]
player.currentDef() -> def
player.equip(game, weaponId)       // 购买后装备：设置 loadout 槽位 + 满弹
player.resetForRound(game, opts)   // rules 调用：opts={pos, yaw, keepWeapons:bool}
player.onKilled(attacker, weaponId, zone)
player.crosshairPixels(game) -> number // HUD 准星扩散像素(4..30)，可选；否则 HUD 用 crosshairSpread
```

玩家控制要求：
- 读取 `game.input`（见 §14）：`keys`（KeyboardEvent.code → bool）、`mouseDown`、`mouseDX/mouseDY`（main 每帧末清零）、`pressed`（Set 或对象，本帧新按下动作名）、`locked`。
- 鼠标视角只在 `game.input.locked` 时更新（headless/auto 模式除外）。
- 速度：跑 5.2 m/s，Shift 静步 2.6，蹲 2.0；地面加速/摩擦接近 CS 手感；跳跃初速 5.2，重力 16；蹲下降低视高与碰撞高。碰撞调用 `CS.world.moveEntity`。
- 开火：左键；auto 武器按住连发，否则单击一发（用 `pressed.fire` 或 mouseDown 边沿）。射速按 RPM。弹匣打完 → `empty` 事件 + 自动播放空仓声；R 换弹（有备弹时），换弹动画/时间；数字 1/2/3 切枪（无该槽则忽略），切枪 drawTime 期间不能开火。
- 射击流程：从眼睛位置沿相机 forward 方向（带当前散布偏移）→ `CS.weapons.hitscan` → 命中则 `CS.weapons.hit`；同时 `CS.fx.tracer/muzzle/impact/blood`、`game.emit({type:'shot', weapon, pos, byPlayer:true})`；命中玩家自身视角有后坐力（pitch/yaw kick）。
- 后坐力：垂直上抬 + 轻微水平摆动，按武器 recoil 累计，停火后恢复；镜头 kick；`crosshairSpread` 随移动/连发/空中增大，停火恢复。AWP 右键开镜（`scoped=true`，fov 35，`game.settings.fov` 恢复；开镜时移速减半、准星隐藏由 HUD 处理）；开镜为 stretch，若来不及可先不做，但优先做。
- `player.fov` 字段由 main 读取用于相机（默认 game.settings.fov=90，开镜 35）。
- 需要暴露 `player.spread` 或让 HUD 通过 `player.crosshairSpread` 画准星。
- 死亡：`onKilled` 设置 alive=false，掉落/隐藏枪模；相机倒地（main 处理死亡镜头）；下回合 `resetForRound` 复活。
- 枪模：用 `renderer.drawBox('white', matrix, tint, 1)` 组合 8~14 个盒子（枪管、护木、机匣、弹匣、枪托、握把、瞄具、双手），位置在相机右下方，带呼吸/走动晃动、开火后坐、换弹下沉动画。不同武器外观有区分（步枪长、手枪短、刀）。muzzle 位置用 `M4.cameraWorld` 变换得到世界坐标，用于 fx 和 tracer 起点（tracer 起点可用枪口，hitscan 用眼睛）。
- 准星命中反馈通过事件：命中活体时 emit `{type:'hitmarker', headshot, kill}`。

## 11. CS.bots API（bots）

```js
CS.bots.init(game) -> bots[]        // 创建 9 个 bot 并加入 game.bots
CS.bots.spawnRound(game)            // 每回合开始重置（规则调用）
CS.bots.update(game, dt)
CS.bots.render(game)
// bot 字段：id, name, team:'t'|'ct', pos, vel, yaw, pitch, health, armor, alive, def, ammo:{mag,reserve},
//           reloading, state, path, target, kills, deaths, skill
bot.rayTest(origin, dir, maxDist) -> {dist, point, zone} | null
bot.onKilled(attacker, weaponId, zone)
```

- 名单：CT 队友 `Rex, Nova, Falcon, Echo`；T 敌人 `Viper, Boris, Kane, Yuri, Stitch`。玩家是 CT 第 5 人。
- 难度 `game.settings.difficulty`：`easy | normal | hard`，影响反应时间（0.4/0.26/0.16s）、瞄准误差（0.07/0.04/0.02 rad 基准）、点射长度与移动预判。**normal 要能打赢但不是送**：玩家站着对枪应该略占优，被 2-3 个 bot 集火会死。
- AI：状态机 `spawn → rotate → engage → hunt → (death)`。
  - `rotate`：按阵营目标移动。T 每回合随机主攻 A 或 B（用 world.sites / zones），部分走 mid；CT 分守 A/B/mid（4 人分配 2/1/1 或 1/2/1）。
  - 视野：视距 45m，水平 FOV ±65°，`world.los` 视线检查；发现敌人 → engage。
  - `engage`：面向目标（yaw 平滑转向），保持距离/小范围横移，按反应时间后开火，点射 3-6 发后短暂停；低血/弹匣空 → 后退换弹/找掩体（简单即可）。
  - `hunt`：未发现敌人时向回合目标区域推进；听到枪声（本回合内其他 bot/玩家的 shot 事件）可转向调查最近枪声位置。
  - 路径：`world.nav.findPath`；沿 waypoint 移动（到达阈值 0.6m 切下一点）；卡住 1s 重新寻路；每 2-4s 或状态切换时重算；不要每帧 A*。
  - bot 之间用 `world.moveEntity` 移动并轻微互相推开，避免叠在一起。
- 射击：与玩家共用 `CS.weapons.hitscan/hit`；按瞄准误差偏移方向；枪口/弹道用 `CS.fx`；emit `{type:'shot', weapon, pos, byPlayer:false}`。射速/弹匣/换弹遵循 defs。T 侧 bot 武器按回合随机：AK-47 为主，偶尔 AWP/手枪；CT 侧 M4A1-S 为主，偶尔 AWP。bot 无经济系统。
- 渲染：盒子人形模型（头、躯干、双腿、双臂、手中枪），腿/臂按移动摆动，站立轻微呼吸；CT 深蓝灰制服，T 土黄/棕色；头上有极小队伍色标记（可选）。死亡后倒地（整体旋转躺下，逐渐变灰/淡出 8s 后消失）。
- 性能：9 个 bot，每帧更新要便宜；A* 限流。

## 12. CS.rules API（Lead）

```js
CS.rules.init(game) -> rules
rules.state = {phase:'buy'|'live'|'roundEnd'|'matchEnd', phaseTime, round, score:{ct,t},
               money, buyTimeLeft, roundTimeLeft, winner, matchWinner, reason}
CS.rules.update(game, dt)
CS.rules.onEvent(event)
CS.rules.buy(game, itemId) -> {ok, msg}
CS.rules.startMatch(game)
```

- 流程：`buy` 8s（玩家与 bot 冻结、可购买）→ `live` 115s（前 20s 可购买，且玩家在出生区 10m 内）→ 全灭或超时 → `roundEnd` 5s → 下一回合/比赛结束。先赢 8 回合者获胜。
- 淘汰：T 全灭 → CT 胜；CT 全灭 → T 胜；超时 → CT 胜（无炸弹）。
- 经济：初始 $800；击杀 +$300；回合胜 +$3250；回合败 +$1400（上限 $16000）。购买：ak47 $2700 / m4a1 $2900 / awp $4750 / armor $650（护甲 100 + 头盔）。只能买 primary 与护甲（手枪默认已有）。死亡后下回合默认 USP+刀；存活保留武器与剩余弹药（不补满，备弹保留）。
- 事件：发出 `roundStart`、`roundEnd`、`matchEnd`、`buy`；接收 `kill` 更新 K/D（玩家和 bot）与玩家金钱；接收 `damage` 可选。
- 重置：回合开始调用 `CS.player.resetForRound`、`CS.bots.spawnRound`、`CS.fx.clear()`，玩家回 CT spawn[0]、bots 回各自 spawn。
- HUD 只读 rules.state 显示。

## 13. CS.hud API（hudaudio）

```js
CS.hud.init(game)
CS.hud.update(game, dt)
CS.hud.onEvent(event)
CS.hud.showStart(); CS.hud.hideStart();
CS.hud.reset()                     // 新比赛：清空击杀信息、比分由 rules 读
CS.hud.showPause(bool)
CS.hud.isBuyMenuOpen()
CS.hud.isBlockingInput() -> bool   // 开始界面/暂停/购买菜单/比赛结束任一打开
CS.hud.banner(title, sub, seconds) // 回合横幅
CS.hud.toast(msg)                  // 购买失败等提示
CS.hud.showMatchEnd(winner)        // 比赛结束画面（含"再来一局"按钮）
```

- HUD 自建 DOM：index.html 只提供 `<canvas id="game-canvas">` 和 `<div id="hud-root"></div>`；`hud.js` 注入自己的 `<style>` 与 DOM，所有视觉自己负责。
- 开始界面：标题 **"DUST STRIKE"**，副标题 "网页版 CS · 5v5 爆破模式"，操作说明、难度选择（简单/普通/困难，写入 `game.settings.difficulty`）、灵敏度滑块（写入 `game.settings.sensitivity`，0.5–3.0 倍）、音量滑块（`CS.audio.setVolume`），"进入游戏" 按钮 → 调 `game.callbacks.start()`。
- 对局 HUD：左下生命值/护甲、右下弹药（当前弹匣/备弹 + 武器名）、金钱、顶部比分+回合计时、右上击杀信息流（含爆头图标）、中央动态准星（随 `player.crosshairSpread` 扩大；命中时缩放/变色动画；开镜时隐藏）、受击红色边缘+方向指示、低血量红晕、死亡遮罩（"你已阵亡" + 击杀者 + 等待下回合）、回合横幅、购买菜单（B 打开，卡片式，显示价格/余额，点击或按 1-4 购买，Esc/B 关闭）、记分板（按住 Tab 显示双方名字 K/D）、暂停菜单（继续/重新开始）、比赛结束（胜利/失败 + 比分 + 再来一局）。
- pointer lock 协调：购买菜单/暂停/结束时 HUD 调 `game.callbacks.requestPause()` 释放指针并暂停；关闭购买菜单后 HUD 调 `game.callbacks.lockPointer()` 重新锁定（按钮点击内的用户手势才行，注意浏览器限制——购买菜单用按钮点击关闭即可）。
- 准星用 CSS 十字 + 4 条线实现即可；命中标记 X 形动画。不要用外部图片/字体。
- 所有 HUD 元素 pointer-events 默认 none，只有菜单/按钮可交互。

## 14. main.js 的 game 对象（Lead 提供；所有模块依赖）

```js
CS.game = game = {
  canvas, renderer, world, player, bots:[], hud, audio, rules, fx,
  time, dt, frame, running, started, paused,
  settings:{ sensitivity:1.0, difficulty:'normal', volume:0.8, fov:90 },
  input:{ keys:{}, mouseDown:false, mouseDX:0, mouseDY:0, pressed:{}, locked:false,
          rightDown:false, rightPressed:false },
  events:[], emit(e){this.events.push(e);},
  callbacks:{ start, resume, restart, lockPointer, requestPause },
  player: 见 §10
}
```

- `input.pressed` 每帧末清空，值为 true 表示本帧新按下；动作名：`reload, slot1, slot2, slot3, buy, scoreboard, pause, jump, interact, fire`。
- `game.input.mouseDX/mouseDY` 只在 pointerlock 时累积，每帧末清零。
- 主循环顺序（Lead 实现）：输入 → player.update → bots.update → rules.update → fx.update → 相机设置 → world.render → bots.render → player.renderViewmodel → fx.render → endFrame → hud.update → 事件分发（rules.onEvent, hud.onEvent, audio.onEvent）→ audio.setListener。
- 事件由模块 `game.emit`，main 每帧分发；事件对象至少带 `type`。
- headless 截图：URL `?auto=1` 会自动开局（不请求 pointer lock、不显示开始界面），并暴露 `window.__DSH_GAME__ = game`。`?auto=1&hideui=1` 隐藏 HUD 便于检查 3D 画面。

## 15. 事件目录（统一）

| type | 字段 | 发出方 | 消费方 |
|---|---|---|---|
| `shot` | weapon, pos, byPlayer, attacker? | player, bots | audio |
| `step` | pos, byPlayer | player, bots | audio |
| `damage` | target, attacker, amount, zone, point, weapon | weapons.hit | hud(受击/命中), audio |
| `hitmarker` | headshot, kill | player | hud |
| `kill` | killer, victim, weapon, headshot | weapons.hit | rules, hud, audio |
| `roundStart` | round | rules | hud, bots, audio |
| `roundEnd` | winner, reason | rules | hud, audio |
| `matchEnd` | winner | rules | hud |
| `buy` | itemId, ok | rules | hud, audio |
| `empty` | — | player | audio |

## 16. 验收标准（Lead 最终检查）

1. 双击 `index.html` 打开 → 开始界面 → 进入游戏 → 能自由移动、瞄准、射击、换弹、切枪、购买、死亡、回合流转。
2. 无外部网络请求；file:// 下无 CORS 错误。
3. 1600×900 下画面完整（无黑屏/无洋红占位纹理）；地图有掩体、天空、雾、包点标记。
4. 5v5，bot 会寻路、交火、倒地；回合能正常结束并进入下一回合；先到 8 分出现比赛结束。
5. HUD 数据全部正确（生命/弹药/金钱/比分/计时/击杀信息/准星/记分板）。
6. 控制台无未捕获异常；60fps 量级流畅。
7. 所有 js 文件 `node --check` 通过。

## 17. 协作规则

- 开始工作先读本文件 + 检查仓库现状；**只写自己 scope 的文件**。
- 代码质量优先保证"能跑、接口一致"；不要追求完美后再提交，先让 Lead 能集成，再迭代打磨。
- 遇到契约空白或矛盾：按常识实现并在文件顶部注释 `// CONTRACT-GAP:`，同时发消息给 Lead 说明。不要擅自改公共接口。
- 完成后用 send_message 向 Lead 报告：文件、行数、`node --check` 结果、已知问题、需要 Lead 注意的接口细节。
- Lead 集成期间可能发 bug 修复请求；收到后先修再报告。
