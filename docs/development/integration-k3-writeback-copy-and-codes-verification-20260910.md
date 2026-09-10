# 数据工厂 K3 写回文案改口 + 三个 DISABLED 码进码表（G10）· 验证

- 日期：2026-09-10
- 分支：`fix/integration-k3-writeback-copy-and-codes`（基于 origin/main `a22955f83`）
- 设计：`docs/development/integration-k3-writeback-copy-and-codes-design-20260910.md`

## 1. 改动文件

| 文件 | +/- |
| --- | --- |
| `apps/web/src/services/integration/writeFence.ts`（新增） | +83 |
| `apps/web/src/services/integration/errorCodeLabels.ts` | +58 / -1 |
| `apps/web/src/services/integration/workbench.ts` | +28 / -1 |
| `apps/web/src/views/IntegrationWorkbenchView.vue` | +46 / -12 |
| `apps/web/src/components/integration/IntegrationPipelineRunSection.vue` | +24 / -3 |
| `apps/web/src/views/IntegrationK3WiseSetupView.vue` | +3 / -3 |
| `apps/web/tests/integrationErrorCodeLabels.spec.ts` | +67 |
| `apps/web/tests/IntegrationPipelineRunSection.spec.ts` | +33 |
| `apps/web/tests/IntegrationWorkbenchView.spec.ts` | +105 / -18 |

`plugins/`、`packages/` 零改动。全部文件保持 CRLF 工作树行尾（`core.autocrlf=true`，blob 仍是 LF），`git diff --numstat` 无整文件行尾漂移。

## 2. 源侧核对结果（逐项）

### 2.1 kind 列表

| 来源 | 值 |
| --- | --- |
| `k3-external-write-permanent-fence.cjs` `K3_EXTERNAL_WRITE_TARGET_KINDS` | `['erp:k3-wise-webapi', 'erp:k3-wise-sqlserver']`（frozen） |
| `writeFence.ts` `K3_EXTERNAL_WRITE_TARGET_KINDS`（新增镜像） | 同上，同序 |
| `outbound-http-write-gate.cjs` `GENERIC_HTTP_WRITE_KINDS` | `['http']` — 本次**未**作为「不渲染按钮」的依据（见设计 §4） |

一致。由 `integrationErrorCodeLabels.spec.ts` 的 `toEqual` 断言持续看守。

**顺带发现**：改动前 `IntegrationWorkbenchView.vue:1156` 与 `:1167` 两处只判 `'erp:k3-wise-webapi'` 字面量，`erp:k3-wise-sqlserver` 从这两个分支漏过。`:1167`（`targetSelectorExplanation`）已换成栅栏谓词；`:1156`（`k3WebApiReadGateNotice`）**有意保留** WebAPI 字面量——那句话说的是「WebAPI 的 read/list runtime 还在等客户 GATE 样例」，是关于该 transport 读能力的事实，不是写禁令，扩到 sqlserver 反而是错的（sqlserver 恰恰是能读的那条通道）。

### 2.2 码名

| 码 | 服务端出处 | 取得方式 |
| --- | --- | --- |
| `K3_WISE_EXTERNAL_WRITE_DISABLED` | `k3-external-write-permanent-fence.cjs`（导出常量） | `require` |
| `OUTBOUND_HTTP_WRITE_DISABLED` | `outbound-http-write-gate.cjs`（导出常量） | `require` |
| `K3_WISE_PIPELINE_RUN_DISABLED` | `pipeline-runner.cjs:448` **内联字面量，未导出** | 定向源码扫描（见设计 §6.1） |

`grep` 全仓确认这三个是运行时实际抛出的全部写禁类码名；`OUTBOUND_HTTP_WRITE_TARGET_NOT_AUTHORIZED` / `OUTBOUND_HTTP_WRITE_ALLOWLIST_INVALID` 存在但按设计 §3.2 有意不登记。

## 3. 命令与退出码

| 命令 | 退出码 |
| --- | --- |
| `pnpm install --frozen-lockfile --offline` | 0 |
| `pnpm --filter web run type-check`（`vue-tsc -b` + 两个 verification tsconfig） | 0 |
| `pnpm --filter web run lint` | 0 |
| `npx vitest run tests/IntegrationWorkbenchView.spec.ts` | 0（53 passed） |
| `npx vitest run`（下列 8 个 spec 一并） | 0（91 passed） |

第 5 行的 8 个 spec：`integrationErrorCodeLabels`、`IntegrationPipelineRunSection`、`IntegrationHelpView`、`IntegrationK3WiseSetupView`、`IntegrationObjectTemplateSection`、`integrationWorkbench`、`IntegrationHubOverviewSection`、`IntegrationExternalWritePanel`。

**lint 覆盖面说明**：`apps/web` 的 `lint` script 是一份显式文件清单（26 个 glob，只含 plm / workflow / auth 相关），本次改动的 9 个文件与 1 个新文件**均不在其中**。仍整跑一次确认无回归，退出码 0。

**已知环境噪声**：`IntegrationWorkbenchView.spec.ts` 的主链路用例在本机冷跑一次曾撞 vitest 默认 5s `testTimeout`（该文件 53 个用例整体 33s）。用 `--testTimeout=60000` 复跑，该用例自报 3093ms，全绿；随后按默认超时复跑亦全绿。判为 Windows 本机负载抖动，非本次改动引入——CI 是裁判。

## 4. 新增 / 改动的测试

**`tests/integrationErrorCodeLabels.spec.ts`** — 新 describe `external-write fence codes (G10)`：

1. `mirrors the exact server tokens for all three fence codes`
2. `every fence code renders a humanized label plus a 只读 hint, never the unknown fallback`
3. `the client fence-kind mirror equals the server fence subject set, exact-match only`

**`tests/IntegrationPipelineRunSection.spec.ts`**：

4. `G10: a fenced K3 target replaces the Save-only checkbox and button with the permanent read-only notice`（并断言 dry-run 按钮仍在且可用 —— E4-05）
5. `G10: a non-fenced target keeps the Save-only checkbox and button exactly as before`

**`tests/IntegrationWorkbenchView.spec.ts`**：

6. `G10: a run refused by the K3 fence renders the humanized label, never the English refusal prose`（新增；模拟 403 + `K3_WISE_PIPELINE_RUN_DISABLED`，断言状态条出标签+提示、且 `C6-only` 原文不出现在页面任何位置）
7. 主链路用例 `loads systems, object schemas, and previews a template payload` 改写：目标是 `k3_1`（`erp:k3-wise-webapi`），改为断言 Save-only 勾选与按钮**都不存在**、只读说明在场、dry-run 仍可用、且 `runBodies` 里不存在任何 `/run` 请求；流程条断言改为 `Dry-run / 交付` 并新增 `not.toContain('导出或 Save-only 写回')`
8. 同文件连接分栏用例：来源/目标选择器说明的断言改到新口径，并各加一条 `not.toContain` 钉住旧文案不会回潮

**`tests/IntegrationHelpView.spec.ts` 未改**：其行数断言是 `rows.length === integrationErrorCodeEntries().length`（单一来源），三条新码自动进表。实测码表 50 -> 53 条，该 spec 仍绿。

## 5. 变异探针

全部为**内存变异**：一个 scratchpad 里的 vitest config 在 Vite `transform`（`enforce: 'pre'`）里改写模块源码，**不落盘**。探针的查找串若不命中会抛错，杜绝「陈旧探针静默通过」。每轮跑完 `git status` 与跑前逐条一致。

| # | 变异 | 目标文件 | 用例 | 结果 |
| --- | --- | --- | --- | --- |
| 1 | 三条码表条目改名（等同删除） | `errorCodeLabels.ts` | labels spec | **红** 1 failed / 16 passed |
| 1b | 同上 | 同上 | view `G10: a run refused…` | **红** 期望标签、实得 `K3 WISE live writes are C6-only…` |
| 1c | 同上 | 同上 | view 主链路用例 | 绿（预期：该用例不经码表） |
| 2 | 去掉 Save-only 栅栏门（`v-if` 恒真/恒假） | `IntegrationPipelineRunSection.vue` | run-section spec | **红** `expected <button …> to be null` |
| 2b | 同上 | 同上 | view 主链路用例 | **红** `expected <input …> to be null` |
| 3 | `parseIntegrationResponse` 不再带出 code | `workbench.ts` | view `G10: a run refused…` | **红** 回落英文原文 |
| 4 | 视图不再按 code 查表（`label = null`） | `IntegrationWorkbenchView.vue` | view `G10: a run refused…` | **红** 回落英文原文 |
| 5 | 镜像谓词改成前缀匹配 `startsWith('erp:k3')` | `writeFence.ts` | labels spec kind 用例 | **红** |
| 6 | 流程条第 4 步文案回滚成「导出或 Save-only 写回」 | `IntegrationWorkbenchView.vue` | view 主链路用例 | **红** |

基线（同一 config、无变异）：labels + run-section 22 passed，退出码 0 —— 证明红是变异造成的，不是 harness 造成的。

## 6. 残留风险

1. 客户端隐藏按钮**不是保证**，是止损。可证明的保证仍然只有 `plugins/plugin-integration-core` 里的四层栅栏；本次未在客户端新增任何「代替」它的守卫，也未削弱它。
2. 「粘贴已有 pipeline ID」场景下前端看不见目标 kind，Save-only 按钮照常渲染 —— 这正是新增的 code 人话化所覆盖的那条路（用例 6 就是这个场景）。两个机制互补，缺一不可。
3. `K3_WISE_PIPELINE_RUN_DISABLED` 的守卫是源码扫描而非 `require`，强度弱于其他两条（见设计 §6.1）。
4. 与在飞 PR #5587 的冲突面：本次在 `IntegrationWorkbenchView.vue` 触及 `:5`、`:642` 一带、`:222`、`:1155-1172`、`:441-445`、`:3420` 一带，均避开 #5587 声明的 `:700-1000` 与 `:2014-2049`。
