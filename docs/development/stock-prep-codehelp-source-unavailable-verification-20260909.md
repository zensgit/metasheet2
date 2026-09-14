# 备料错误码人话目录补 SOURCE_UNAVAILABLE — 验证记录(2026-09-09)

## 审前人改动(逐文件核对,未发现需要修改之处)

- `plainLanguage.ts` 新增的 `SOURCE_UNAVAILABLE` 条目:形状(`zh`/`en`/`zhNext`/`enNext` +
  `Object.freeze`)与 `STOCK_PREP_ERROR_PLAIN` 表内其余十余条一致;文案点名 HTTP 503、点名"源库"这一
  类别(举例 PLM、K3 用的 SQL Server)、给出常见原因(网络/端口/账号被禁/维护)、明说"不是权限问题"
  且"重试也不会自己好"、`zhNext` 指向"找实施查源库连通性"并提醒不贴驱动原文——逐条齐全,未作改动。
- `StockPreparationPosturePlainLanguage.spec.ts` 新增用例:断言 503、"源库"出现在 zh/en,`zhNext`
  非空且不含"权限",lookup 函数结果与表直读一致且不等于通用兜底——覆盖到位,import 已齐,未作改动。
- 交付指南新增行 ⑪:紧跟 §7 表格 ⑩(源预检 500/#5570)之后,同属"源"相关已知问题,位置与表格结构
  一致;内容与设计文档、代码互相印证。未找到成文的"验收脚本第 6 步"直谈 `SOURCE_UNAVAILABLE`;比对
  过 `stock-prep-acceptance-bootstrap.mjs` 步骤 6(`acceptance-apply`)与 runbook "Step 6 — 首次真实
  拉取"的失败处理段落,均不涉及这个 503,新增行与两者无冲突。未作改动。
- 设计文档 values-free 核对通过(无主机名/端口/账号/连接串);引用的行号(`codeHelp.ts:48/85` 挂
  `STOCK_PREP_ERROR_PLAIN`、`StockPreparationConfirmationQueueView.vue:906/918` 的
  `DIRECTORY_NOT_FOR_THIS_PRINCIPAL` 两码集合)逐一核实与现状一致。未作改动。

**结论**:前人改动已达标,本轮未修改任何文件内容,只补这份验证记录并提交。

## 命令、退出码与数字

1. `pnpm --filter web exec vitest run tests/StockPreparationPosturePlainLanguage.spec.ts` — exit 0,
   Test Files 1 passed (1) / Tests 12 passed (12)。
2. `pnpm --filter web test`(全量) — exit 1,Test Files 56 failed | 748 passed (804) / Tests 76
   failed | 10690 passed (10766) / Errors 11。抽查全部失败文件名(`approvalNewView`、
   `approval-e2e-lifecycle`、`k3WiseSetup`、`AttendanceSchedulingAdminSection`、`multitable-*`、
   `featureFlags`、`attendance-*` 等 40+ 支),**零一支属于 stock-prep 或 plainLanguage**;失败集中在
   审批计时类断言、考勤时区探针、`WebSocket server error: Port is already in use` 等既有本机噪音,与
   《本机测试环境真相》备忘一致(store 已修好;若干套件只在 Windows 上红,CI 才是裁判)。
3. `pnpm --filter web run type-check`(`vue-tsc -b` + 两个 verification 子项目)— exit 0,无类型错误。

## 归因

全量套件的失败与本次改动(新增一条错误码翻译 + 一条断言 + 一行交付说明)无关:目标 spec 单独跑与全量
跑结果一致(12/12 通过),失败全部落在审批/考勤/multitable 等既有套件,是本机 Windows 环境已知噪音,
不是本次改动引入的回归。

## 风险

这是一处"目录条目 + 文档"改动:新增一条静态错误码翻译(无逻辑分支、无 I/O、无权限/租户代码)、一条
断言、一行交付说明,零运行时行为改变,低风险。

## 审阅返修(2026-09-10)

PR #5588 review 指出前一版有两处过度承诺,已改。

### 1. 排障文案过度承诺

前一版 `zh`/`en` 直接断言"不是权限问题"、"重试也不会自己好"——一份裸 503 证不了这两件事:源库账号
本身的登录/权限拒绝、以及一次性瞬时故障,都会落在同一个码上,断言范围超出证据。改为可证明的更窄一句:
不是直接给 **MetaSheet 账号**加权限就能解决(这个动作作用的账号在源库那一侧,不在我方),请实施检查
具体原因(网络、端口、源库账号或其权限、瞬时故障都有可能);短时间重试无效再升级。`zh`/`en`/`zhNext`/
`enNext` 四段均改,新文案(`apps/web/src/services/integration/stockPreparation/plainLanguage.ts:730-735`):

```
zh: '源库(比如 PLM、K3 用的那台 SQL Server)现在连不上,服务器答的是 503。不是直接给 MetaSheet 账号加
权限就能解决,请实施检查具体原因(网络、端口、源库账号或其权限、瞬时故障都有可能);短时间内重试还是
不行,再把这条报错升级给实施处理。'
en: 'The source database (for example the SQL Server behind PLM or K3) cannot be reached right now —
the server answered 503. This is not fixed by adding a permission to the MetaSheet account; ask an
implementer to check the actual cause (the network, a port, the source account or its permissions, or
a transient fault). If a short retry still fails, escalate this to an implementer.'
zhNext: '不是给账号加权限就能解决的;先短时间重试一次,如果还是不行,把这条报错交给实施,去查源库那
边的网络、端口、账号或权限,或者是不是瞬时故障。'
enNext: 'This is not fixed by adding a permission — retry briefly first; if it still fails, hand this
error to an implementer to check the source database's network, port, account or permissions, or
whether it was a transient fault.'
```

条目上方的注释(`plainLanguage.ts:707-728`)同步改写,记下这次收窄的理由与审阅人的注入实验。

### 2. 覆盖声明过度

前一版设计文档、验证记录、交付指南 §7 ⑪ 都说"源预检 / 一线 dry-run / 拉取都经数据源读,会碰到这个
码"。核实后不成立:`stockPreparationSourcePreflight`(`plugins/plugin-integration-core/lib/http-routes.cjs:6621`
`adapterRegistry.createAdapter` + `readObject: (request) => adapter.read(request)`,同文件
`6636-6643`)自己建 adapter 直接读,从未调用 `DataSourceManager.connectDataSource`
(`packages/core-backend/src/data-adapters/DataSourceManager.ts`)——只有 `/api/data-sources/*` 那一组
路由(结构 / 表 / `POST /:id/connect` / `/query` / `/select`,即数据工厂连接管理页)经过这个咽喉。审
阅人把 `SOURCE_UNAVAILABLE` 的原样错误注入真实的源预检模块做了验证(不用复现):结果是
`verdict: 'no-go'`、blocker `source_unreachable` 原因 `unknown_error`——预检自己的
`classifyReadError`(`plugins/plugin-integration-core/lib/stock-preparation-source-preflight.cjs:576-594`)
按驱动文本/`code` 做模式匹配,不认这句固定文案(其英文半句里的 "unreachable" 也不会命中
`ehostunreach`/`enetunreach` 等子串规则),落进 UNKNOWN,从未出现这条 zh/en 文案本身。

三处文档收窄为:该码只出现在直接经 `/api/data-sources/*` 读的界面(数据工厂连接管理的结构 / 预览 /
测连接);备料源预检把它折叠成 `no-go`(原因 `unknown_error`);本条目**对预检页面不生效**,预检页
自己的 no-go/unknown_error 改口留作后续待办。一线 dry-run 与拉取是否也经这个咽喉未经同等验证,本轮
文档不再对它们下断言。改动文件:
- `docs/development/stock-prep-codehelp-source-unavailable-design-20260909.md`(「为什么」段 + 新增
  「审阅澄清(2026-09-10)」段 + 「文案原则」段)
- `docs/development/takeover-beiliao-20260821/customer-delivery-guide-20260904.md`(§7 ⑪ 行)

### 3. 测试断言按新文案调整

`apps/web/tests/StockPreparationPosturePlainLanguage.spec.ts` 的 `SOURCE_UNAVAILABLE` 用例
(`:224-242`)删掉了 `expect(plain.zhNext).not.toContain('权限')`(新文案的 `zhNext` 本就含"权限"二字,
这条反向断言不再成立),改为正向断言 `zh`/`en`/`zhNext`/`enNext` 都含新的窄化措辞("不是直接给
MetaSheet 账号加权限" / "This is not fixed by adding a permission"),503 与"源库"两条断言保留不变。

### 命令、退出码

1. `pnpm --filter web exec vitest run tests/StockPreparationPosturePlainLanguage.spec.ts` — exit 0,
   Test Files 1 passed (1) / Tests 12 passed (12)。
2. `pnpm --filter web run type-check` — exit 0,`vue-tsc -b` + 两个 verification 子项目均无类型错误。

### 归因与风险(本轮)

改动范围仍是"目录条目文案 + 断言 + 三份文档",无逻辑分支、无 I/O、无权限/租户代码改变;`SOURCE_UNAVAILABLE`
这一条目本身从未在生产被任何真实请求触达过(#5586 刚合入、backend 尚未挂到 stock-prep 任一路由),所以
这次改文案零运行时行为影响,低风险。未跑全量 `pnpm --filter web test`——上一轮已确认全量套件的既有
失败与 stock-prep/plainLanguage 无关(《本机测试环境真相》),本轮只改了文案与断言字面值,不影响那份
归因。
