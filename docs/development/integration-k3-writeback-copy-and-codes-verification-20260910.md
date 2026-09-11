# 数据工厂 K3 写回文案改口 + 三个 DISABLED 码进码表（G10）· 验证

- 日期：2026-09-10
- 分支：`fix/integration-k3-writeback-copy-and-codes`（基于 origin/main `a22955f83`）
- 设计：`docs/development/integration-k3-writeback-copy-and-codes-design-20260910.md`

## 1. 改动文件

（相对基线 `a22955f83`，含 2026-09-10 终审修复；数字取自 `git diff a22955f83 --numstat`。）

| 文件 | +/- |
| --- | --- |
| `apps/web/src/services/integration/writeFence.ts`（新增） | +70 |
| `apps/web/src/services/integration/errorCodeLabels.ts` | +99 / -1 |
| `apps/web/src/services/integration/workbench.ts` | +61 / -1 |
| `apps/web/src/services/integration/k3WiseSetup.ts` | +11 / -16 |
| `apps/web/src/views/IntegrationWorkbenchView.vue` | +46 / -13 |
| `apps/web/src/components/integration/IntegrationPipelineRunSection.vue` | +24 / -3 |
| `apps/web/src/views/IntegrationK3WiseSetupView.vue` | +54 / -11 |
| `apps/web/tests/integrationErrorCodeLabels.spec.ts` | +145 |
| `apps/web/tests/IntegrationPipelineRunSection.spec.ts` | +33 |
| `apps/web/tests/IntegrationWorkbenchView.spec.ts` | +113 / -18 |
| `apps/web/tests/IntegrationK3WiseSetupView.spec.ts` | +104 |

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
| `K3_WISE_PIPELINE_RUN_DISABLED` | `pipeline-runner.cjs` **内联字面量，未导出** | 定向源码扫描（见设计 §6.1） |
| `K3_WISE_REPLAY_DISABLED` | `pipeline-runner.cjs` **内联字面量，未导出** | 定向源码扫描 |

**（F12 更正，2026-09-10 终审）** 本节初稿写的是「`grep` 全仓确认这三个是运行时实际抛出的全部写禁类码名」。
这是一句被证伪的绝对断言，撤回。运行时还有下列写禁/写拒类码，初稿没查到：

| 码 | 出处 | 本次处置 |
| --- | --- | --- |
| `K3_WISE_REPLAY_DISABLED` | `pipeline-runner.cjs` 死信重放闸门（`PipelineRunnerError.details.code`） | **已登记**（终审补） |
| `C6_WRITE_APPLY_DISABLED` | `http-routes.cjs`，`HttpRouteError`，由部署级 env `INTEGRATION_C6_WRITE_APPLY_DISABLED` 触发 | **有意不登记**：它是部署可改的开关，不是永久栅栏，用本 family「设计如此、永久」的口吻描述它会误导；退化为通用未知标签对它是诚实的 |
| `OUTBOUND_HTTP_WRITE_TARGET_NOT_AUTHORIZED` / `OUTBOUND_HTTP_WRITE_ALLOWLIST_INVALID` | `outbound-http-write-gate.cjs` | **有意不登记**：部署侧 allowlist 事实，面向运维日志而非数据工厂操作员 |

正确的表述是：**已登记的 4 条 = 数据工厂操作员在本 PR 接线的路径上会撞到的写禁码**，不是运行时写禁码的全集。

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
4. 与在飞 PR #5587 的冲突面：本次在 `IntegrationWorkbenchView.vue` 只触及页头副标题、四步流程条、运行与推送面板标题、来源/目标选择器说明这三组 computed、import 区，以及 `executePipeline` / 两个外部写 / 死信重放这四个 catch。均不在 #5587 声明的落点/刷新与「/data-sources」文案区域内。（行号在两边都在漂，这里按**函数与区块**描述，不按行号。）

## 7. 终审修复（2026-09-10）

#5597 对抗复核（29 代理）判「修完再转正式」。以下逐条对应。

### F01（blocker）——写禁码在 `error.details.code`，前端读不到

**证实**。`PipelineRunnerError`（`pipeline-runner.cjs`）只设 `this.name` 与 `this.details`，没有自己的 `.code`；
`http-routes.cjs` 的 `inferErrorCode` 是 ``error.code || error.name || 'INTERNAL_ERROR'``，于是 `/run` 拒绝的信封是

```
422 { ok:false, error:{ code:'PipelineRunnerError',
                        message:'K3 WISE live writes are C6-only: use external-write dry-run + apply',
                        details:{ code:'K3_WISE_PIPELINE_RUN_DISABLED', pipelineId } } }
```

（`inferHttpStatus` 用 `/PipelineRunner/` 映射 422；服务端由
`plugins/plugin-integration-core/__tests__/http-routes-plm-k3wise-poc.test.cjs` 钉住这三项。）
初稿只读顶层 `error.code`，所以 `K3_WISE_PIPELINE_RUN_DISABLED` **永远查不到表**，标签是死代码；
并且初稿新加的用例 mock 了一个「403 + 顶层写禁码」的形状 —— 服务端从不发出，属于自证。

修法：`workbench.ts` 新增 `integrationEnvelopeErrorCode(payload)`。details.code 只在顶层 code 缺失、或顶层 code 是
**类名形状**（`/Error$/`，大小写敏感）时才顶上；自带 `.code` 的 `HttpRouteError` / `ExternalWriteDryRunError` 不受影响。
注册码一律 SCREAMING_SNAKE，`UNKNOWN_ERROR` 结尾是 `ERROR` 不是 `Error`，不会被误判 —— 并有用例钉住这一点。

### F05（major）——K3 预设页只改口没改控件

**证实**。页头已写「K3 目标永久只读、不写回」，同页仍有「执行物料」「执行 BOM」按钮与「允许真实执行 Pipeline」勾选。
现按 `isK3ExternalWriteTargetKind(K3_WISE_WEBAPI_KIND)` 门掉这三个控件，替换为一行 `K3_WRITE_FENCE_EXPLANATION.zh`；
面板摘要改「仅 dry-run」，Pipeline 参数摘要改「K3 目标只能 dry-run」，部署闸门条目文案同步。
`isPipelineRunDisabled` 与 `executePipeline` 各加一道**只会拒绝**的纵深守卫。

**dry-run 保留**。这是冻结裁决保留的合法只读动作（`external-write-dry-run.cjs`），也是这页唯一还能做的事；
顺手藏掉它就是 §15.2 E4-05 的失败模式，不是更安全。用例正面断言 `Dry-run 物料` / `Dry-run BOM` 仍在。

### 无人看的路径——K3 预设页的私有解析器

**证实**。`k3WiseSetup.ts` 曾有一份与 `workbench.ts` 逐字相同、但抛裸 `Error` 的 `parseIntegrationResponse`。
本 PR 的 `IntegrationApiError` 根本不流经它，所以那页的 catch 接上人话化会是 no-op。
已删除该副本，改为 import `workbench.ts` 的同名导出（无环：该模块本来就 import `./workbench`）；
`:1731` 的裸 `catch` 改为绑定 error 并走共享 `integrationFailureMessage`。

该页的 fallback **强制由调用方给固定文案**（函数签名要求 `fallback: string`），不默认 `error.message`：
这是 values-free 面，lane F 用例断言服务端自由文本永不渲染，退回服务端散文会破坏它。新用例正反两面都钉住了。

### F12 / F13 / F09 / F08

- F12：见上文 §2.2 的更正段，绝对句已撤回并明列两条未登记码及理由；`K3_WISE_REPLAY_DISABLED` 已登记，死信重放 catch 已接线。
- F13：§6.4 改为按函数/区块描述，不再引用会漂的行号。
- F09：`integration_run_log` 说明改「查看 dry-run 预览与导出记录。」
- F08：删掉真正没人用的 `WRITE_TARGET_POSTURE_COPY`；`K3_WRITE_FENCE_NOTICE` 保留，并加断言 `require` 后端
  `integration-hub-overview.cjs` 的 `K3_FENCE_NOTICE` 比对 zh/en —— 「与总览同一句话」从注释变成被检查的性质。

### 终审后的测试

| spec | 用例 |
| --- | --- |
| `integrationErrorCodeLabels.spec.ts` | `parseIntegrationResponse recovers the product code from details.code for the /run refusal shape` |
| | `a real top-level product code still wins over a details.code` |
| | `the fenced-kind badge is byte-identical to the server notice the same screen renders` |
| | `mirrors the exact server tokens for the fence codes`（4 条，含 replay） |
| `IntegrationK3WiseSetupView.spec.ts` | `G10: the K3 preset page offers no live-run control, only dry-run plus the read-only notice` |
| | `G10: a dry-run failure carrying a registered code renders its label; an unregistered one keeps values-free copy` |
| `IntegrationWorkbenchView.spec.ts` | 既有 `G10: a run refused by the K3 fence…` 的 mock 改为服务端真实形状（422 + `PipelineRunnerError` + `details.code`） |

### 终审后的变异探针（内存，不落盘）

| # | 变异 | 用例 | 结果 |
| --- | --- | --- | --- |
| 1 | 四条码表条目改名 | labels spec | **红** 2 failed |
| 2 | 共享人话化 `label = null` | K3 setup spec / view G10 | **红** / **红** |
| 3 | 镜像谓词改前缀匹配 | labels spec kind 用例 | **红** |
| 4 | **F01 守卫**：`integrationEnvelopeErrorCode` 不再回落 details.code | labels spec | **红** `expected 'PipelineRunnerError' to be 'K3_WISE_PIPELINE_RUN_DISABLED'` |
| 4b | 同上 | K3 setup spec / view G10 | **红** / **红** |
| 5 | `parseIntegrationResponse` 完全不带 code | labels spec | **红** 2 failed |
| 6 | **F05 守卫**：去掉 K3 预设页的 `v-if` 门 | K3 setup spec | **红** `to not include '执行物料'` |
| 7 | K3 预设页 catch 不再人话化 | K3 setup spec | **红** |
| 8 | 去掉工作台 Save-only 门 | run-section spec / view 主链路 | **红** / **红** |
| 9 | 流程条第 4 步回滚旧文案 | view 主链路 | **红** |

基线（同 harness、无变异）：labels + run-section + K3 setup 37 passed，退出码 0。

### 终审后的命令与退出码

| 命令 | 退出码 |
| --- | --- |
| `pnpm --filter web run type-check` | 0 |
| `pnpm --filter web run lint` | 0 |
| `vitest run integrationErrorCodeLabels.spec.ts` | 0（20 passed） |
| `vitest run IntegrationK3WiseSetupView.spec.ts` | 0（12 passed） |
| `vitest run IntegrationWorkbenchView.spec.ts` | 0（53 passed） |

**一条与本 PR 无关的既有红**：`k3WiseSetup.spec.ts > keeps the K3 WISE setup route behind integration write permission`
断言 `src/main.ts` 源码含 `to.meta?.permissions`，而该文件里已经没有这串（路由守卫在更早的重构里搬走了）。
`apps/web/src/main.ts` 与基线 `a22955f83` **逐字节相同**（`git diff a22955f83 -- apps/web/src/main.ts` 为空），
所以它在未改动的基线上同样红。本 PR 不碰它 —— 改 `main.ts` 去迎合断言等于动路由权限守卫，超出范围。

