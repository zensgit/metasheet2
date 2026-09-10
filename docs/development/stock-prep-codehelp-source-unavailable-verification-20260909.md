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
