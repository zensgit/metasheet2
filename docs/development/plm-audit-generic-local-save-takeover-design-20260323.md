# PLM Audit Generic Local-Save Takeover Design

## Background

`PLM Audit` 已经把下面几类本地 saved-view 写入路径接到了统一的 collaboration takeover 合同：

- `shared-entry -> Save as local view`
- `scene-context -> Save current view`
- source-aware local save followup

这些路径都会在安装新的 saved-view owner 之前，先清掉旧的 collaboration draft / followup 和 draft 自动装出来的单行 selection。

## Problem

generic `Save current view` 在不属于 `shared-entry` 或 `scene-context` 的情况下，仍然保留独立路径：

1. 直接保存本地 saved view
2. 只更新 saved-view attention
3. 不清 collaboration draft / followup

这会在下面这类路径里留下真实残留：

1. recommendation 或 team-view management 先创建 collaboration draft / followup
2. 用户不走 notice CTA，而是直接点 generic `Save current view`
3. 页面成功保存本地视图，并把注意力切到 saved views
4. 旧 collaboration notice 和 draft 自动装出的单行 selection 仍然留着

结果就是新 saved-view takeover 已经生效，但页面上同时还挂着上一条 collaboration owner。

## Decision

把 generic `Save current view` 也并入现有的 saved-view takeover collaboration 合同：

- 保存成功后清 draft
- 清 followup
- 只消费 draft 自动装出来的单行 selection
- 不改 source-aware local save 的专用 followup 语义

## Implementation

Files:

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`

Key changes:

- generic `Save current view` 保存成功后，复用已有 `applyCollaborationTakeoverCleanup()`
- source-aware local save 路径保持不变，仍由 `saveCurrentLocalViewWithFollowup(...)` 单独处理
- collaboration helper regression 新增一条 generic local-save takeover 用例

## Expected Behavior

- generic `Save current view` 成功后，不再残留旧 collaboration draft / followup
- draft 自动装出来的单行 selection 会和旧 owner 一起被回收
- source-aware local save 和 generic local save 现在共享同一层 collaboration takeover 合同
