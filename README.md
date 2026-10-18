# dsh-approval-latency

把「这次工具调用在等人类点审批」这件事**回传给模型**：

> 一次调用卡在审批上等了 6 分 42 秒才被放行时，模型在下一轮会收到一条上下文消息，
> 说明那段空档是**人的响应延迟**，不是工具报错、不是超时、也不是它上一轮的代码有问题——
> 因此不必因为「时间过了很久」去重新排查已经正确的东西。

[English](README.en.md) · MIT · 纯 host 侧，无网络、无文件访问、不改任何审批结果 ·
仓库 <https://github.com/UPxianyu/dsh-approval-latency>

---

## 1. 它解决什么问题

DSH 的运行时上下文里有一行：

```markdown
Elapsed since the preceding model-visible message: 6m 42s
```

（来自 `@deepseek-ai/dsh-time-context`。）它算的是**墙上时间**，但模型看到的只有两个数字：
「上一条消息」和「现在」。审批是唯一会让这个数字突然变大的日常路径——你去开会、去倒水、
去回别人消息，回来才点了「允许一次」。

于是模型面对的是这样的推理岔路：

| 模型看到的 | 常见的错误结论 |
|---|---|
| 工具结果正常返回，但中间空了 7 分钟 | 「刚才那条命令是不是卡住了 / 环境不稳定」 |
| 工具被拒绝，而拒绝出现在 9 分钟后 | 「我的改法不对，用户否掉了，我重写一版」 |
| 两个文件都改完，但两步之间各空了几分钟 | 「前面那些改动可能没生效，重新验证一遍」 |

这三条都会烧掉注意力，而且都建立在**一个并不存在的因果**上：时间 ≠ 结果。
审批的等待时间属于「人」这一侧，跟工具、代码、参数、沙箱都没有关系。

本插件把那句话补上：等待超过阈值时，在**该步骤的工具结果之后**追加一条上下文消息，
明确说清「这段空档是审批等待」。模型不需要猜，也不需要再从时间戳反推。

## 2. 行为

「太长」不是常量，是**先量出来的**：门槛默认由本机最近回答过的审批耗时决定（见第 4 节）。
下表的「门槛」指生效的那个数，不是写死的 30 秒。

| 情形 | 结果 |
|---|---|
| 调用需要审批，等待 ≥ **通过门槛**，最终**通过** | 追加一条提示：等了多久、是人的响应时间、不要因此重开前面的工作 |
| 等待 ≥ **拒绝门槛**（默认是通过门槛的一半），最终**被拒绝** | 追加一条提示：等了多久、这么久之后的「否」可能是过期/误触，若与用户要求不符应先问再改 |
| 等待 ≥ 通过门槛，最终**取消 / 无人应答** | 追加一条提示：这一枪没打响，空档不代表调用或代码有问题 |
| 等待 < 对应门槛 | 什么都不加（正常人点审批的速度不该产生噪音） |
| 该调用**没有**经过审批 | 什么都不加 |
| `reportDenials: false` | 只回报「通过」的等待，拒绝/取消的不回报 |

提示不会改写工具结果本身（审计里 `tool/result` 仍是工具自己的输出），而是作为一条
`notice` 形式的用户消息，紧随本步骤的工具结果进入下一轮请求。

### 模型实际读到的文本（三种变体）

通过：

```markdown
Approval latency: "bash" waited 6m 42s for the user to answer its approval prompt before it
could run. That gap is human response time — not a tool failure, a timeout, or evidence that
this call, its arguments, or your earlier findings were wrong. Judge this result on its own
content, and do not reopen earlier work merely because time passed.
```

拒绝：

```markdown
Approval latency: the user answered the approval prompt for "write" after 4m 10s and rejected
the call. A "no" this late can be a stale or accidental answer rather than a verdict on the
call: if the rejection contradicts what the user asked for, ask them before reworking the
approach, and do not conclude that the call itself was wrong.
```

取消 / 无人应答：

```markdown
Approval latency: the approval prompt for "pwsh" stayed open for 1m 0s and ended without an
answer, so the call never ran. That gap is human or scheduling latency — not evidence about
the call or the code it touches.
```

## 3. 安装

在 DSH 里（profile 名换成你自己的，桌面版默认 `desktop`）：

```sh
dsh plugin --profile desktop add /path/to/dsh-approval-latency
```

或从仓库：

```sh
dsh plugin --profile desktop add github:UPxianyu/dsh-approval-latency
```

装完重启 `dsh web`（或桌面版），插件随 profile 的 `cordis.patch.yml` 插入
`approval-latency` 这一行即可生效。

卸载：

```sh
dsh plugin --profile desktop remove dsh-approval-latency
```

### 3.1 在插件页里改（推荐）

插件管理**不在设置对话框里**，它是主界面左侧「全局面板图标」里的一个面板（图标是风车，tooltip「插件」；
设置里的「内置插件」是只读清单）。路径：

**左侧风车图标「插件」→「已安装」→ `dsh-approval-latency` 卡片 → 点带 `›` 的那一行标题
（显示为 `审批等待回传（Approval Wait Notice） ›`，它的无障碍名就是「配置 审批等待回传（Approval Wait Notice）」）**

那一行标题之所以是可点的按钮（带 `›`），正是因为本插件为这一行注册了配置页；
没有注册页的行只是纯文本、没有箭头。

| 控件 | 作用 |
|---|---|
| **自适应** 开关 | 开（默认）：门槛跟着你回答审批的速度走（见 4.2）。关：用下面的固定时长。 |
| **固定时长** 输入框 | 秒数，默认 **30**。回车或失焦才写入；填 0 / 非数字会被拦下并提示，不会写进配置。 |
| **恢复默认** | 清掉本页写入的覆盖，回落到本 bundle 的默认值（30 秒 / 自适应）。 |

写进去的值由 Host 落到 profile 的 Cordis patch（与手改 YAML 同一层），**不需要重启**：
这些字段是 `volatile` 的，改完从下一次审批开始生效。页面上的「已覆盖」徽标表示这一项有页面写入。

页面上看不到「当前学到的基线是多少」——那是宿主内存里的数，只写进 debug 日志；
页面只负责改配置（延迟、体积、侵入性都最小的那一半）。

## 4. 阈值怎么配

这一节是同一份配置的 **YAML 写法**（适合脚本化、团队统一、CI）。两种模式都能在设置页里切换（见 3.1），
定义与算法完全相同。

改配置就在 **profile** 的 `cordis.patch.yml` 里用同 id 覆盖（同 id 覆盖会**整块替换**
`config`，所以只写你要改的字段，其余回落到默认值）：

| 你写的 | 生效 |
|---|---|
| 什么都不写 | `mode: auto`（自适应） |
| `mode: auto` | 自适应，用本机速度；`fixedMs` 不参与 |
| `mode: fixed` | 固定 `fixedMs`，默认 **30000（30 秒）** |
| 只写 `fixedMs: 45000` | 自动当成 `mode: fixed`（填了数，数字就该生效） |
| 只写 `thresholdMs: 45000`（0.2.0 的旧写法） | 同上，按别名处理，仍然可用 |

`mode` 显式写了就听它的：`mode: auto` 同时给 `fixedMs` 不算冲突，只是那个数用不上
（和 `mode: fixed` 下 `floorMs` 用不上是一个道理）。

### 4.1 固定时长（最省事的两种写法）

```yaml
# profile/cordis.patch.yml
- id: approval-latency
  name: dsh-approval-latency
  config:
    mode: fixed          # 不写 fixedMs 就用默认 30000 = 30 秒
```

```yaml
- id: approval-latency
  name: dsh-approval-latency
  config:
    mode: fixed
    fixedMs: 45000       # 45 秒
```

**默认为什么是 30 秒**：低于 30 秒基本还是正常点击速度，提醒只会变成噪音；到 30 秒以上，
模型那行 `Elapsed since the preceding model-visible message` 已经大到足以让它怀疑自己，
这时一条「这是审批延迟」最值钱。宁可少提醒，也别让提醒变成背景音。

### 4.2 自适应（默认）怎么算

```
通过门槛 = clamp( multiplier × median(最近 20 次真实回答的耗时), floorMs, ceilingMs )
```

- **样本**：只收「真的回答了」的审批——`allowed-once` 与 `rejected`。取消、无人应答不算，
  因为它们不代表你回答得慢。
- **每条样本先夹到 `ceilingMs`**：一次出门三小时不会把基线拽走。
- **用中位数而不是均值**：偶发的长等待不会移动它。
- **样本不足 `minSamples`（默认 3）时用 30 秒冷启动值**——`30s` 只是「还没有数据时」的占位，
  不是永恒的门槛。
- **正在被判断的这次等待不进样本**：先用历史算门槛、再记账，所以一次超长等待不能自己给自己发通行证。
- `floorMs`（默认 10s）保证再灵敏也不会为「点得挺快」打扰；`ceilingMs`（默认 5min）
  保证基线不会漂到永远不触发。

举例：你平时 4 秒点掉审批 → 门槛 12 秒；某天你一直 90 秒才点 → 门槛自动抬到 5 分钟（上限）。
换台机器、换个人，就是另一套数——因为这个数字本来就该是「对谁而言」。

### 4.3 按结果分流（两种模式都生效）

```
拒绝门槛 = clamp( 通过门槛 × rejectionScale, min(floorMs, 通过门槛), 通过门槛 )
```

迟到的「否」是最贵的误解（模型会去重写代码），所以默认用一半的门槛先提醒一次；
设 `rejectionScale: 1` 就与通过同门槛。取消 / 无人应答仍用通过门槛，因为那本来就不是一次判断。

### 4.4 开关

`reportDenials: false` 只回传通过的等待。

### 4.5 全部字段

本 bundle 的 patch 已写入全部默认值：

```yaml
- id: approval-latency
  name: dsh-approval-latency
  config:
    mode: auto             # auto = 自适应；fixed = 固定 fixedMs
    fixedMs: 30000         # fixed 模式的固定时长（毫秒）；不写 mode 时填了它即按 fixed
    floorMs: 10000         # auto：门槛下限
    ceilingMs: 300000      # auto：门槛上限，也是单条样本的截断值
    multiplier: 3          # auto：几倍本机中位数算「异常长」
    minSamples: 3          # auto：攒够几条真实回答才从冷启动切到学习值
    rejectionScale: 0.5    # 拒绝门槛 = 通过门槛 × 该系数，范围 (0, 1]
    reportDenials: true    # 是否也回传拒绝 / 取消 / 无人应答
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `mode` | `auto` | `auto` 学习本机速度；`fixed` 永远用 `fixedMs`。 |
| `fixedMs` | `30000` | 固定模式的门槛（毫秒）。`0` 表示每次审批都回传（调试用）。 |
| `floorMs` | `10000` | 自适应门槛下限：低于它的等待永不打扰。 |
| `ceilingMs` | `300000` | 自适应门槛上限，同时截断单条样本。 |
| `multiplier` | `3` | 「异常长」= 多少倍本机中位数。越小越敏感。 |
| `minSamples` | `3` | 攒够多少条真实回答才从冷启动切到学习值。 |
| `rejectionScale` | `0.5` | 拒绝门槛 = 通过门槛 × 该系数，范围 (0, 1]。 |
| `reportDenials` | `true` | 是否也回传「等到最后被拒绝 / 取消 / 无人应答」。 |
| `thresholdMs` | — | **已弃用**：`fixedMs` 的别名，写了即等于 `mode: fixed`。 |

### 4.6 常见调法

| 想要 | 改什么 |
|---|---|
| 稳定可预测，不看历史 | `mode: fixed`（默认 30 秒）或 `mode: fixed` + `fixedMs` |
| 更敏感（离开 10 秒就提醒） | `floorMs: 5000`、`multiplier: 2` |
| 更安静（只在明显离开时提醒） | `multiplier: 5`、`ceilingMs: 600000` |
| 拒绝别那么吵 | `rejectionScale: 1` 或 `reportDenials: false` |
| 刚装上看效果 | `mode: fixed`、`fixedMs: 0`（每条审批都回传） |

生效中的门槛不用猜：每次回传都会写一行 debug 日志，含 `mode`（`cold`/`learned`/`fixed`）、
两个门槛、基线中位数与样本数。

非法值（未知 `mode`、负数、`NaN`、`minSamples` 不是整数、`ceilingMs < floorMs`、
`rejectionScale` 越界等）会让插件在**激活时**直接报错，而不是悄悄退回默认值——
避免「我明明配了固定 45 秒，怎么没反应」这种静默差异。

### 4.7 为什么不用别的信号

| 备选 | 为什么不用 |
|---|---|
| 工具自己跑了多久 | 与「人在不在」无关；一次 10 分钟的构建不该被当成审批延迟。 |
| 运行时上下文里的 elapsed | 那正是要解释的东西，不能拿它当判据（否则会自我强化）。 |
| 时间戳 / 几点钟 | 需要日历或历史，等于把作息画像塞进插件；收益也更低。 |
| 键鼠空闲、窗口是否失焦 | host 侧拿不到，且属于隐私面；用「回答速度」已经等价地表达了同一件事。 |
| 按工具设不同门槛 | 同一个人回答审批的速度与点的是哪个工具无关，只会增加配置面。 |
| 让模型自报「我刚才好像卡住了」 | 不可靠，而且提示必须在模型开始推理**之前**到达。 |

## 5. 刻意不做的事（守卫）

- **不替你回答审批**：`approval/request` 上的监听器永远 `next()` 委托，绝不返回结果。
  批准/拒绝仍由部署里真正的应答者（Web 面板、ACP、无头策略）决定。
- **不改审批结果、不改工具输出**：只往 `additionalContexts` 里追加一条消息；
  `tool/result` 审计事件与工具自己的 `content` 原样保留，后续监听器的 `block` 反馈也照旧生效。
- **不推断因果**：提示只陈述「等了多久」和「这不是关于代码的证据」，不替模型判断结果对不对。
- **不发网络请求、不读写文件、不碰凭据**。
- **设置页不碰存储**：页面只通过 `ctx.configForms` 提交字段读写，落盘、校验、冲突检测都在 Host
  的 settings 服务里；页面本身没有 fetch、没有 localStorage、没有文件访问。
- **不泄漏内部失败**：计时或用例出错时只写一条 warn 日志，工具调用照常继续。
- **不无限记账**：每个 agent 最多保留 64 条待领取的等待记录，超过 6 小时的一律丢弃；
  记录只按模型给出的 tool call id 匹配，无法确定归属时宁可**不回报**。

## 6. 实现原理

```
approval/request  ──(prepend 包装)──▶  真正的应答者（Web 面板 / ACP / 策略）
        │  记录 startedAt / endedAt / outcome，按 agent + callId 记账
        ▼
tools/post-execute  ──(先 next() 拿到最终决策)──▶  追加 additionalContexts
        │
        ▼
agent loop 在本步骤工具结果之后，将它作为 user/message 注入 → 下一轮请求里模型可见
```

宿主半侧还多一层：`index.js` 导出 `Config`，字段全部 `.volatile()`。这带来两件事——
Host 会为这一行开一个名为 `approval-latency` 的 settings 命名空间（只暴露 volatile 字段），
并且 volatile 的改动会被**原地提交**进正在运行的 fiber（每个字段在运行期是个 `.get()` ref）。

```
设置页 ──ctx.configForms.set('fixedMs', 45000)──▶ Host settings 校验 + 写入 profile 的 Cordis patch
                                                        │
                                        volatile-only 变更 → 运行时 ref 原地更新
                                                        ▼
                                   下一次审批：config.fixedMs.get() 就是 45000
```

浏览器半侧（`client.js`）注册进「插件」页的 `plugins.row.config` 键控 slot，
key 为 `<包名>#<行 id>` = `dsh-approval-latency#approval-latency`——这是 DSH 给
**bundle 自己的配置**指定的位置（`plugins.item` 是官方分组的位置，不占）。

五处关键接口都不是猜的，是按 0.2.1-rc.2 的 `app.asar` 逐个核对过的：

1. `ctx.on('approval/request', fn, { prepend: true })` 一定排在应答者**外层**——
   Cordis 的瀑布式派发按注册顺序链接 `next()`，`prepend` 就是 `unshift`；
   反过来（排在内层）会根本收不到请求，因为应答者不会调用 `next()`。
2. `tools/post-execute` 的决策里 `additionalContexts` 会被 `@deepseek-ai/dsh-agent-loop`
   收进 `next-step` 收件箱，并在**本步骤工具结果之后**作为 `user/message` 追加。
3. 消息的 `source.kind` 用本插件自己的 `approval-latency`（`form: 'notice'`）：
   会话格式 v4 明确要求「producer-owned source kind」，不用 `plugin` 这类已退休的包装。
4. settings 命名空间 = **Loader 行 id**（`dsh-settings` 按 `entry.id` 建命名空间，且只收
   volatile 字段）；`ui-theme` 的命名空间常量就是它的行 id，可直接对照。
5. `plugins.row.config` 的 key 由宿主按 `` `${包名}#${行 id}` `` 派发
   （`ui-plugin-manager` 的 `rowConfigKey`），slot 的 ownerProps 是 `{view: 'summary'|'page'}`。

时间用 `performance.now()` 取，避免系统改时间造成负数或异常大的时长。

门槛的记账也在同一条链上：

```
approval/request 计时 → tools/post-execute 取回 → 先用历史算门槛 → 判断 → 再把这次回答并入历史
```

「先判断、后并入」是刻意的：本次等待不能参与决定自己要不要被回报，否则越长的等待越容易
把基线抬高、把自己洗成「正常」。

## 7. 兼容范围

- 已在 **DSH 0.2.1-rc.2**（Windows 桌面版）的打包源码上核对上述五处接口与派发顺序，
  并对 `lib/latency.js` + `lib/plugin.js` + `index.js` + `client.js` 写了 52 项测试
  （`npm run test:inprocess`；其中 2 项 schema 断言需要 `@deepseek-ai/schemastery`，
  在裸仓库里会自动跳过）。
- 另外把同一个构建里的 `@deepseek-ai/cordis` 4.0.5 与 `@deepseek-ai/schemastery` 3.18.5 抽出来
  做了真实运行验证：`prepend` 的监听器确实排在应答者外层、`next()` 确实到达应答者并原样返回结果、
  30ms 的等待被如实测到、低于阈值不追加、`fiber.dispose()` 后监听器被移除；
  `index.js` 用真实 `Config` 挂载后四种配置（自适应冷启动 / 固定 0 / 固定 30s / 学到基线）行为一致。
- 浏览器半侧用**假 loader + 假 React hooks + 假 ctx** 做了接线验证：注册 key、中英词条齐全、
  摘要视图只出一行、自适应态开关点亮且时长框禁用、点开关写入 `mode: fixed`、
  填 90 秒失焦写入 `fixedMs: 90000`、填 0 被本地拦下不发请求、恢复默认走 `unset`、
  只读 / 未服务两种状态控件禁用。**真实浏览器里的渲染没有验证过**（需要装进 profile 后刷新页面）。
- `package.json` 顶层的 `engines.dsh` 声明为 `>=0.2.1-rc.2 <0.3.0-0`：0.2.1-rc.2 的
  `@deepseek-ai/dsh-app-boot`（`evaluatePluginCompatibility`）只读**顶层** `engines.dsh`，
  满足即准入、不满足则整个 bundle 在启动时被跳过（而不是带着未知接口跑起来）。
  注意不是 `dsh.engines.dsh`，也不是 `dsh.compatibility`——那两个位置启动时没人读。
- Host 侧**只声明 peer、不声明依赖**：`@deepseek-ai/schemastery` 写在 `peerDependencies` 里。
  这不是装饰——DSH 的解析路由（`dsh-app-boot` 的 `ResolutionRouter`）对 `link:` 安装的插件
  只把**清单里声明为 peer** 的 bare specifier 拦截到安装内的那一份（读的就是 `peerDependencies`）；
  没声明就会走原生解析并找不到。profile 的 `pnpm-workspace.yaml` 里 `autoInstallPeers: false`，
  所以声明 peer 不会触发任何下载。`dsh-context` 等已装插件正是同样写法。
- 上游若改掉 `approval/request` 或 `tools/post-execute` 的形状，插件最坏的结果是
  **不再回传**（静默退回现状），不会误批、也不会改变任何审批结果；若改掉 settings 的 slot 契约，
  最坏结果是**设置页不出现**（配置仍可用 YAML），不影响审批行为。

## 8. 自测步骤

**先看插件页**：

1. 重启后在主界面左侧点**风车图标「插件」**，在「已安装」里打开 `dsh-approval-latency` 卡片；
   点带 `›` 的行标题（`审批等待回传（Approval Wait Notice） ›`）进入配置页，
   里面有「自适应」开关与「固定时长（秒）」输入框。
2. 关掉开关 → 显示「已保存」，徽标出现「已覆盖」；改成 `120` 并回车 → 保存。
3. 回到会话，让模型触发一次需要审批的操作并立刻通过 → **不应**有提示（远低于 120 秒）。
   把时长改成 `1`（秒）再重复 → 应当出现提示。
4. 点「恢复默认」→ 徽标消失，回到自动模式。

**再看提示本身**：

5. 触发一次需要审批的操作，把 DSH 窗口切到后台，**等 40 秒以上**，再回来点「允许一次」。
6. 看这一步之后（工具结果之后）是否多出一条 `Approval latency: ...` 消息，时长与你实际等待相符。
7. 再触发一次，等够时间后点「拒绝」→ 应出现「可能是过期/误触」的变体（拒绝门槛更低）。
8. 连续快速点掉 3 次审批，再等 40 秒点一次 → 仍应回传，但 debug 日志里的 `mode` 已从 `cold`
   变成 `learned`，`baseline` 接近你秒回的速度。
9. 触发一次不需要审批的调用 → 不应出现任何提示。
10. 让一次审批在等待期间被中断（例如取消该轮）→ 提示应是「从未运行」，且工具调用本身不被影响。

## 9. 已知限制

- **只覆盖「审批」**：其它让墙上时间变大的原因（你打断后去处理别的事、机器休眠、模型排队）
  不在本插件的语义里，也不会被解释。
- **只看得到自己进程里的审批**：如果某个子进程/子代理在别处等待，父调用没有 `callId` 关联，就不会回报。
- **基线是本进程内的**：不落盘。重启 DSH 后从冷启动 30 秒重新学，通常几次审批就回到准数。
  刻意如此——不为一个提示去写文件，也不把「作息画像」持久化。
- **基线会跟着你走样**：如果你连着几天都回答得很慢，门槛也会变高（直到 `ceilingMs`）。
  想锁死就设 `mode: fixed`（必要时再填 `fixedMs`）。
- **提示进入历史后不会被收回**：它和其它上下文消息一样留在会话里（追加式，不影响 KV cache 复用前缀）。
- 走 `never` 策略（审批被确定性拒绝）时没有等待，因此不会有提示。

## 10. 安全

见 [SECURITY.md](SECURITY.md)：两个事件监听器、一条日志、零网络、零文件、零凭据，
且不参与任何审批决策。

## 11. 许可

[MIT](LICENSE)




