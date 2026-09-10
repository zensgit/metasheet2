# 备料错误码人话目录 — 补 SOURCE_UNAVAILABLE(2026-09-09)

## 为什么

main 上 #5586(`e89f3e15e`)把 `DataSourceManager.connectDataSource`（所有按需连接的唯一咽喉：
`/schema`、`/tables/:table`、`POST /:id/connect`、`/query`、`/select` 等）改成:源库连不上时不再
回显驱动原文(会带 host:port / 库名 / 登录名),而是统一翻成固定文案,答 **503**
`SOURCE_UNAVAILABLE`。

备料工作台的源预检、一线 dry-run、拉取都经数据源读,链路上会碰到这个码。工作台已有一份"人话目录"
(`plainLanguage.ts` 的若干 `Record<string, StockPrepPlainEntry>` 表 + 错误码对照抽屉
`StockPreparationCodeHelpPanel.vue`),但没有 `SOURCE_UNAVAILABLE` 这一行 —— 一线看到这个码会落进
通用兜底句(「这一步没有保存成功」),既不说是 503,也不说是源库的事,更容易被当成权限问题去找管理员
改角色,而实际上改权限毫无用处。

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

- **发生了什么(zh/en)**:点名 HTTP 503,点名"源库"这个类别(举例 PLM、K3 用的 SQL Server),给出
  常见原因(网络、端口、账号被禁、维护),并明说**不是权限问题**、重试不会自己好 —— 呼应
  `plainLanguage.ts` 文件头「TRANSLATE MEANING, NEVER MECHANISM-BY-NAME」的规则:说清楚这是"源库连
  不上"这一类事,而不是复述 `SOURCE_UNAVAILABLE` 这个标识符本身。
- **该怎么办(zhNext/enNext)**:指向实施去源库那边查连通性(网络/端口/账号/维护状态),明确提醒不要
  把驱动报错原文抄给一线看 —— 这与 #5586 后端侧"不回显驱动原文"的设计意图一致:即使将来哪个调用方
  不小心把 `error.message` 带上来,人话层这句话也不该鼓励把它转述出去。
- **values-free**:不出现主机名、端口号、账号名、示例连接串;"SQL Server""PLM""K3" 是类别名,不是
  客户具体配置。
