# PLM Audit Datetime Transport Verification

## 变更范围
- 代码
  - [`plmAuditDateTimeTransport.ts`](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditDateTimeTransport.ts)
  - [`plmAuditQueryState.ts`](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditQueryState.ts)
  - [`PlmAuditView.vue`](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue)
  - [`plmWorkbenchClient.ts`](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/services/plm/plmWorkbenchClient.ts)
- 测试
  - [`plmAuditDateTimeTransport.spec.ts`](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditDateTimeTransport.spec.ts)
  - [`plmAuditQueryState.spec.ts`](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditQueryState.spec.ts)
  - [`plmWorkbenchClient.spec.ts`](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmWorkbenchClient.spec.ts)

## 验证点
- `datetime-local` 输入可以继续接受本地分钟粒度字符串。
- route parse/build 会把 `auditFrom/auditTo` 统一成 canonical ISO transport。
- team-view snapshot -> route state 的时间字段不再保留本地浮动字符串。
- client `savePlmWorkbenchTeamView('audit', ...)` 不会把本地输入串原样发出去。
- share URL 和已有 ISO route fixtures 不回归。

## Focused 回归
- `pnpm --filter @metasheet/web exec vitest run tests/plmAuditDateTimeTransport.spec.ts tests/plmAuditQueryState.spec.ts tests/plmWorkbenchClient.spec.ts tests/plmWorkbenchViewState.spec.ts tests/plmAuditTeamViewRouteState.spec.ts`
- 结果：`5` 文件 / `52` 测试通过

## 类型检查
- `pnpm --filter @metasheet/web type-check`
- 结果：通过

## 全量相关回归
- `cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
- 结果：`53` 文件 / `382` 测试通过

## 结论
- `PLM Audit` 的时间过滤现在已经形成单一 transport 合同：
  - UI 输入走本地 `datetime-local`
  - route/team-view/client 一律走 canonical ISO transport
- 这条链已经不再依赖提交前临时 `toISOString()` 修补，也不会再在 share URL、team view 和 browser replay 之间混用两套时间编码。
