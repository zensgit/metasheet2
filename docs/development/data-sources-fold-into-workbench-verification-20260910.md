# 外接数据源并入数据工厂「连接管理」分区 — 验证记录(2026-09-10)

> 对应 PR #5587,分支 `feat/data-sources-fold-into-workbench`,HEAD `afcf9e374`。数字来源:PR 描述(`gh pr view 5587 --json body`)、三个提交(`ee5557408`/`7eff1e8d2`/`afcf9e374`)正文、CI 状态(`gh pr view 5587 --json statusCheckRollup`)。材料未逐条给出的数字一律标"未记录",不臆补。

## 命令与结果

| 阶段 | 内容(按 PR 描述/commit 正文复述,未给出完整 CLI 调用形式) | 结果 |
|---|---|---|
| `ee5557408` 抽组件 | `data-sources-ui.spec.ts` 原样重跑 | 通过("原样通过",具体退出码/用例数未记录) |
| `7eff1e8d2` 并入+重定向+落点 | 16 个直接相关 spec 文件 | 全绿,403/403 例通过 |
| `7eff1e8d2` | `type-check` | 退出码 0 |
| `7eff1e8d2` | `lint` | 退出码 0 |
| `afcf9e374` 终审修复 | 相关 10 个 spec 文件复跑(vitest) | 退出码 0,全部通过 |
| `afcf9e374` | `type-check` | 退出码 0 |
| `afcf9e374` | `lint` | 退出码 0 |
| PR #5587 CI(`statusCheckRollup`) | 25 项检查 | 24 项 `SUCCESS` + 1 项 `SKIPPED`(`Strict E2E with Enhanced Gates`) |
| 全量本机 | `pnpm --filter web test` | 55 个文件本机红;逐条归因为本机超时(34 例 5s timeout)/`tsx ENOENT`/CRLF 读 YAML/与本改动无关的源文本 pin;引用了改动模块的 5 个失败文件单跑复核全绿。**以 CI `web-tests` 为准** |

涉及的直接相关 spec 文件(按代码 diff 实读确认存在于本分支):`dataSourcesPanelEmbedded.spec.ts`、`dataSourcesRouteRedirect.spec.ts`、`integrationWorkbenchSectionLanding.spec.ts`、`IntegrationConnectionSection.spec.ts`、`IntegrationWorkbenchView.spec.ts`、`IntegrationWorkbenchRail.spec.ts`、`App.spec.ts`、`StockPreparationGettingStarted.spec.ts`(commit 正文只点名"工作台/rail 两个 spec 补 pinia",本文档据 diff 补上 `IntegrationWorkbenchRail.spec.ts` 这一具体文件名)。16/10 这两个计数具体覆盖哪些文件名材料未逐一对应,不做猜测拼接。

## 16 项变异探针

PR 描述给出的是聚合结果:"16 个变异探针(内存改写、不落盘)全部让对应测试变红",并单独点名一条:

| 编号 | 目标 / 描述 | 首轮结果 | 备注 |
|---|---|---|---|
| P1–P9、P11–P16(共 15 项) | 未记录(材料只给聚合数字,未逐条列出每个探针改的语义) | 红(全部按预期使对应测试失败) | 材料未区分这 15 项各自"首轮即红"还是"需要额外测试才红";除 P10 外一律按聚合口径处理,不臆造细分描述 |
| P10 | 工作台 → 分区刷新接线(即 `refreshBridgeDataSourcesAfterPanelChange` 一类的接线路径) | **首轮绿**(未被当时的测试捕获) | 补了端到端用例(`IntegrationWorkbenchView.spec.ts` 新增"在嵌入面板里登记的源,不重载就出现在绑定编辑器的 connectionId 下拉里"用例)后重跑,变异变红,证明新用例确实覆盖了这条接线;随后修复/巩固该接线 |

P10 是本轮变异测试唯一记录在案的"漏网"信号,对应的加固就是 `refreshBridgeDataSourcesAfterPanelChange` 清空 `bridgeDataSourcesLoaded` 这条逻辑本身,以及新增的端到端断言。

## 对抗复核形态

`7eff1e8d2` 落地后、`afcf9e374` 之前,走了一轮独立于变异测试的对抗复核:

1. **3 个查找视角**:正确性 / 权限安全 / 产品可用性。
2. **每条发现 2 个反驳者**。
3. **终审**裁定:必修 4 条 + 后续 3 条,全部在 `afcf9e374` 落地(详见设计稿"对抗复核后的修复"节)——注释诚实性、向导①链接门(`canOpenDataFactory`)、标题接缝(embedded 不渲染自身标题)、同页删源→草稿悬挂(`pruneConnectionDraftDataSourceReference`)、F01 落点补偿、F04 request ticket、F09/F14 文案改口。

裁决摘要:必修项全部已修;`afcf9e374` 的验证段落(相关 10 spec / type-check / lint 全绿)是终审通过后的复跑证据,不是对 `afcf9e374` 本身再跑一轮三视角复核的产物 —— 材料中没有记录对终审提交再来一轮独立对抗复核。

## 未覆盖项

- **真实浏览器未走查**:材料里没有出现针对本功能的 Playwright/浏览器级 e2e 记录;PR CI 里的 "Stock-prep browser verify (chromium)" / "Approval browser verify (chromium)" 是既有的、跨功能的浏览器验收项,不专属本次改动。本 PR 的验证证据全部来自 vitest 单测 + type-check/lint + CI 汇总状态。
- **全量本机 `pnpm --filter web test` 的 55 个红文件**未在本文档逐一归因,只按 PR 描述给出四类原因桶(本机超时/`tsx ENOENT`/CRLF 读 YAML/无关源文本 pin);裁决口径是"以 CI `web-tests` 为准"。
- **变异探针 P1–P9、P11–P16 的具体断言内容材料未记录**,只有聚合结果("全部变红");如需精确复核,需回到落地这轮变异测试的实现会话(`7eff1e8d2` 尾部 `Claude-Session: session_019KTwTs444CU2AKfVVbwQ5q`)。
- **16 个相关 spec / 10 个复跑 spec 的具体文件名单未逐一列出**(commit 正文只给计数);本文档上节按 diff 补了一份推断文件清单,但未与"16"/"10"这两个数字做逐一勾稽,不作为权威对应关系。
