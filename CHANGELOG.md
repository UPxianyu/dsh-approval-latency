# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.4.1] - 2026-10-18

### Changed

- 插件页显示名带上英文名：`审批等待回传（Approval Wait Notice）`（en 侧仍为 `Approval Wait Notice`）。
- 简介改成先说明「**模式可改：自适应 / 固定时长，点开本行即可设置**」，再讲它做什么——
  之前要进到行详情页才知道能改，入口没有任何提示。
- 恢复 `whileServed` 门禁（排查期间曾临时去掉，用于区分「客户端没注册」与「宿主没服务命名空间」）。
## [0.4.0] - 2026-10-18

### Added —— 设置页（Web / 桌面端）

- **自适应开关 + 固定时长输入框**，入口是**主界面左侧「插件」面板 → 已安装 → `dsh-approval-latency` 卡片 → 行标题（带 `›`）**。开关切换 `mode`，输入框以**秒**为单位写 `fixedMs`（回车或失焦才提交），
  「恢复默认」清掉覆盖。控件立即生效，不需要重启。
- 新增 `client.js`（浏览器半侧）：注册进 `plugins.row.config` 键控 slot（key
  `dsh-approval-latency#approval-latency`，这是 DSH 给 bundle 自己配置指定的位置），
  通过 `ctx.configForms` 读写；页面含中英词条、只读 / 未服务 / 保存失败 / 非法输入的提示。
- `index.js` 现在导出 `Config`（全部字段 `.volatile()`），并调用 `settings.configure({ auto: false })`
  声明「本插件自带设置页，不要自动生成表单」。宿主据此为这一行开 `approval-latency` 命名空间。
- 配置改为**按需读取**：`lib/plugin.js` 每次决策都会重新读一次 volatile 配置（`config.x.get()`），
  因此设置页的改动从下一次审批起就生效，无需重挂。

### Changed

- 拆分模块：`lib/latency.js`（纯逻辑 + `configSchema(z)`）、`lib/plugin.js`（事件接线，不依赖
  schemastery，可在裸 Node 里测）、`index.js`（Loader 行入口 + `Config`）、`client.js`（设置页）。
- 把 `@deepseek-ai/schemastery` 写进 `peerDependencies`：`link:` 安装时 DSH 的解析路由只把
  已声明 peer 的 bare specifier 拦截到安装内那份；`autoInstallPeers: false`，不会因此下载任何东西。
- 非法配置不再让插件激活失败：`Config` schema 在组合期就会拒绝（错误信息点名 `$.mode` 等），
  运行期遇到坏值只写一条 warn 并沿用上一份好配置——坏值不能打断工具调用。
- `createSampler.record()` 支持按次传入 `ceilingMs`，跟随设置页里改动的上限。
- 测试从 37 项增加到 **52 项**，新增 `test/client.test.mjs`：用假 `window.__ModuleLoader__`、
  假 React hooks 与假 ctx 渲染设置页，断言注册 key、词条完整、开关写入 `mode: fixed`、
  时长写入毫秒、0 被本地拦下、恢复默认走 `unset`、只读与未服务状态。

## [0.3.0] - 2026-10-18

### Added —— 阈值改为「显式模式 + 可填固定时长」

- 新增 `mode`：`auto`（自适应，默认）/ `fixed`（固定时长）。
- 新增 `fixedMs`：固定模式的门槛，**默认 30000（30 秒）**——低于它是正常点击速度，
  高于它模型看到的 elapsed 已足以引起误判。
- 最小改法：只写 `mode: fixed` 就用 30 秒；只写 `fixedMs: 45000` 则自动按 `fixed` 处理
  （填了数，数字就该生效）；显式 `mode` 总是优先，`mode: auto` 下的 `fixedMs` 不参与计算。
- 旧字段 `thresholdMs` 保留为 `fixedMs` 的**别名**（写数字即等于 `mode: fixed`，
  写 `null` 仍表示自适应），0.2.0 写法的配置继续可用。
- 未知 `mode`、非数值 `fixedMs` 等在激活时报错，并指出字段名。

### Changed

- `resolveThresholds` 依据 `mode` 分流：`fixed` 直接用 `fixedMs`；`auto` 走
  冷启动 / 学习值。两种模式下拒绝门槛仍为通过门槛 × `rejectionScale`。
- 单元测试增至 37 项：新增模式优先级、字段别名、固定模式默认值，以及「固定阈值忽略学习」的接线测试。

## [0.2.0] - 2026-10-18

### Added —— 阈值从「写死的 30 秒」改成「先量再判」

- **自适应基线**：通过门槛 = `clamp(multiplier × median(最近 20 次真实回答), floorMs, ceilingMs)`；
  样本不足 `minSamples`（默认 3）时用 30 秒冷启动值。
- **只采样真实回答**（`allowed-once` / `rejected`），取消与无人应答不算；每条样本先夹到 `ceilingMs`。
- **判断先于记账**：正在被判断的这次等待不进入它自己的基线，避免「越长的等待越容易被洗成正常」。
- **按结果分流**：拒绝门槛 = 通过门槛 × `rejectionScale`（默认 0.5，不低于 `floorMs`）；
  取消 / 无人应答仍用通过门槛。
- **新增配置**：`floorMs`（10000）、`ceilingMs`（300000）、`multiplier`（3）、`minSamples`（3）、
  `rejectionScale`（0.5）。
- **可解释**：每次回传写一行 debug 日志，含 `mode`（`cold`/`learned`/`fixed`）、两个门槛、
  基线中位数与样本数。
- 非法配置（`ceilingMs < floorMs`、`minSamples` 非整数、`rejectionScale` 越界等）改为在激活时报错。
- `createSampler`（滑动窗口 + 中位数 + 单条截断）与 `resolveThresholds`（四种覆盖层级）。

## [0.1.0] - 2026-10-18

### Added

- `approval/request` 计时包装器（`prepend`，永远 `next()` 委托），按 agent + tool call id 记录等待时长与结果。
- `tools/post-execute` 在等待超过阈值时追加一条 `approval-latency` 通知，
  说明这段空档是人类响应延迟，不是工具失败或代码问题；拒绝情形额外提示「这么久之后的否可能是过期/误触」。
- 记账上限（每 agent 64 条、6 小时过期）与无法确定归属时宁可不回报的策略。
- 在 0.2.1-rc.2 自带的 `@deepseek-ai/cordis` 4.0.5 上做真实派发验证（顺序、委托、计时、阈值、释放）。

## 已知限制（所有版本）

- 只解释「审批」造成的耗时，其它原因（打断、休眠、模型排队）不在语义内。
- 只覆盖本进程内、带 tool call id 的审批；无 call id 且同名调用并发时不回报。
- 自适应基线只在内存里，重启后从冷启动重新学（几次审批即收敛）。
- 提示进入会话历史后不会被收回（追加式，不破坏可复用前缀）。


