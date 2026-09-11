# 备料错误码人话目录 — 补 SOURCE_UNAVAILABLE(2026-09-09)

## 为什么

main 上 #5586(`e89f3e15e`)把 `DataSourceManager.connectDataSource`（所有按需连接的唯一咽喉：
`/schema`、`/tables/:table`、`POST /:id/connect`、`/query`、`/select` 等）改成:源库连不上时不再
回显驱动原文(会带 host:port / 库名 / 登录名),而是统一翻成固定文案,答 **503**
`SOURCE_UNAVAILABLE`。

这个码出现在**直接经 `/api/data-sources/*` 读的界面**——数据工厂的连接管理里的结构 / 预览 / 测连接
(即 `DataSourceManager.connectDataSource` 那一条唯一咽喉:`/schema`、`/tables/:table`、
`POST /:id/connect`、`/query`、`/select` 等)。工作台已有一份"人话目录"(`plainLanguage.ts` 的若干
`Record<string, StockPrepPlainEntry>` 表 + 错误码对照抽屉 `StockPreparationCodeHelpPanel.vue`),但没有
`SOURCE_UNAVAILABLE` 这一行 —— 一线在数据工厂界面看到这个码会落进通用兜底句(「这一步没有保存成功」),
既不说是 503,也不说是源库的事,更容易被当成权限问题去找管理员改角色,而实际上改权限毫无用处。

**审阅澄清(2026-09-10)**:本条目**不覆盖备料源预检**。`stockPreparationSourcePreflight` 自己
`adapterRegistry.createAdapter` 建 adapter 直接读,从不经 `DataSourceManager.connectDataSource`,所以
永远不会收到这个固定 503/码。审阅人把 `SOURCE_UNAVAILABLE` 的原样错误注入真实的预检模块做过验证:
结果是 `verdict: 'no-go'`、blocker `source_unreachable` 原因 `unknown_error`(`classifyReadError` 按驱动
文本/code 做模式匹配,不认这句固定文案,落进 UNKNOWN)——从未出现这条 zh/en 文案本身。一线 dry-run 与
拉取是否也经这个咽喉未经同等验证,不在此文档断言之列。预检页面自己的 no-go/unknown_error 改口是另一件
待办,不在本次改动范围。

## 改哪

- `apps/web/src/services/integration/stockPreparation/plainLanguage.ts`:在
  `STOCK_PREP_ERROR_PLAIN`(`OPERATOR_SCOPE_TENANT_REQUIRED` 等既有码所在的同一张表)里新增
  `SOURCE_UNAVAILABLE` 一条,形状照抄既有条目(`zh`/`en`/`zhNext`/`enNext`)。
- 没有改 `codeHelp.ts` 或 `StockPreparationCodeHelpPanel.vue`:抽屉的七张来源表里已经包含
  `STOCK_PREP_ERROR_PLAIN`(分组 id `error`),`stockPrepCodeHelpEntries()` 按 `Object.keys` 动态
  枚举,新增一条会自动出现在抽屉里,不需要额外注册。
- 没有改 `StockPreparationConfirmationQueueView.vue:906-909` 那份 `DIRECTORY_NOT_FOR_THIS_PRINCIPAL`
  数组:核实过那是"目录读的调用者不是当前实现服务对象"的**封闭两码集合**
  (`OPERATOR_SCOPE_TENANT_REQUIRED` / `OPERATOR_SCOPE_DIRECTORY_UNAVAILABLE`),用途是"这两个码不算
  错误、不上错误行";`SOURCE_UNAVAILABLE` 是一次真实的读失败,语义不同,不属于这个集合。
- `docs/development/takeover-beiliao-20260821/customer-delivery-guide-20260904.md` §7 已知问题表新增
  一行 ⑪,紧跟 ⑩(源预检 500,#5570)之后,同样是"源"相关的已知码。

## 文案原则

- **发生了什么(zh/en)**:点名 HTTP 503,点名"源库"这个类别(举例 PLM、K3 用的 SQL Server)。
  **不**声称"不是权限问题"或"重试不会自己好"——一份裸 503 证不了这两件事:源库账号本身的登录/权限
  拒绝、以及一次性的瞬时故障,都会落在这同一个码上。文案改为可证明的更窄的一句:不是直接给
  **MetaSheet 账号**加权限就能解决(这个动作作用的账号在源库那一侧,不在我方),请实施检查具体原因
  (网络、端口、源库账号或其权限、瞬时故障都有可能)—— 呼应 `plainLanguage.ts` 文件头「TRANSLATE
  MEANING, NEVER MECHANISM-BY-NAME」的规则:说清楚这是"源库连不上"这一类事,而不是复述
  `SOURCE_UNAVAILABLE` 这个标识符本身。
- **该怎么办(zhNext/enNext)**:先建议短时间内重试一次(瞬时故障是真实可能之一),仍不行再把这条报
  错升级给实施去查源库那边的网络、端口、账号或权限,并明确提醒不要把驱动报错原文抄给一线看 ——
  这与 #5586 后端侧"不回显驱动原文"的设计意图一致:即使将来哪个调用方不小心把 `error.message` 带
  上来,人话层这句话也不该鼓励把它转述出去。
- **values-free**:不出现主机名、端口号、账号名、示例连接串;"SQL Server""PLM""K3" 是类别名,不是
  客户具体配置。
