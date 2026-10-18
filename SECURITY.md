# Security

## 插件做什么

- 在 `approval/request` 上注册**一个**监听器（`prepend`，随 `ctx.on` 一并释放），
  只为这次审批计时，**永远**调用 `next()` 把决定交回真正的应答者。
- 在 `tools/post-execute` 上注册**一个**监听器，先 `next()` 拿到最终决策，
  再往 `additionalContexts` 里追加一条 `notice` 形式的消息。
- 导出一个 `Config` 声明（字段 `volatile`）与 `settings.configure({ auto: false })`，
  让宿主为本行提供设置命名空间、并知道本插件自带设置页。
- 浏览器半侧注册**一个**设置页（`plugins.row.config`，key `dsh-approval-latency#approval-latency`），
  只通过 `ctx.configForms` 的 `getSnapshot` / `subscribe` / `set` / `unset` 读写本行字段。
- 在内存里按 agent + tool call id 记账（`WeakMap`），最多 64 条 / agent，6 小时后丢弃。
- 在内存里保留最近 20 次「真实回答」的耗时中位数（只用于算门槛，不落盘、不发送）。
- 自身出错时写一条 `warn` 日志；每次回传写一条 `debug` 日志，内容只有
  `mode` / 两个门槛 / 基线中位数 / 样本数 / 工具名 / 等待毫秒数 / 结果字符串。

## 插件不做什么

- 不发起任何网络请求（fetch / WebSocket / XHR 都没有）。
- 不读写文件、不启动进程、不读环境变量。
- 不读取或写入凭据、token、cookie、localStorage、sessionStorage。
- 设置页**不自己做持久化**：不写 profile、不写 `cordis.patch.yml`、不碰 settings 文档，
  只把字段读写交给宿主的 settings 服务（校验、落盘、revision 冲突检测都在那边）。
- 设置页不注入 DOM、不改宿主样式表，只渲染自己的 React 组件。
- **不参与审批决策**：不返回 `allowed-once` / `rejected` / `cancelled` / `unavailable`，
  不点按钮，不改按钮状态，不重试被拒绝的调用。
- 不改写工具结果（`content` / `value`）、不改写审计事件、不改写审批策略。
- 不注册工具或 HTTP 路由。

## 记录里有什么

一条等待记录只包含：工具名、模型给出的 tool call id、开始/结束时刻、审批结果字符串。
用于学习的样本只有毫秒数。不包含工具参数、不包含文件内容、不包含用户输入文本。
记录在内存中，进程结束即消失，不写入会话日志，也不写磁盘。

## 失败模式

最坏情况是「提示不出现」或「多出一条提示」，不会是「审批被绕过」「结果被篡改」或数据外泄。
上游改接口时插件静默退化为无提示，而不是猜测性地接管审批。

## 报告问题

发现安全问题请在仓库的 Issues 中说明复现步骤；涉及未被披露的利用方式时，请先私下联系维护者。
