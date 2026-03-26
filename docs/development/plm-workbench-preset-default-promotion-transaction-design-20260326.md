# PLM Workbench Preset Default Promotion Transaction Design

## Date
- 2026-03-26

## Problem
- `promoteFilterPresetToTeamDefault(...)` 是两步操作：
  1. 先创建新的 team preset
  2. 再把这个新 preset 设为默认
- 现有实现会在第一步成功后立刻 `applyPresetToTarget(created)`，但如果第二步 `setPlmTeamFilterPresetDefault(created.id)` 失败，就会整体返回失败。
- 页面 wrapper 只会在返回 truthy 时清本地 preset owner，所以会留下这类半提交状态：
  - 新 team preset 已经被创建并应用
  - 本地 preset owner 仍保留
  - 用户只看到“提升默认团队预设失败”

## Design
- 保持“创建成功即把新 team preset 作为当前 target”这一行为不变。
- 把“设默认”视为第二阶段事务：
  - 如果成功，继续返回默认化后的 preset，并保持现有成功文案。
  - 如果失败，保留新建并已应用的 team preset 作为 authoritative target，清空本地 drafts，并返回 `created` 让上层继续消费本地 preset owner。
- 第二阶段失败时要显式暴露 partial-success 语义：
  - `teamPresetsError` 记录真实错误
  - UI message 改成“已提升为团队预设，但设为默认失败”

## Intended Result
- 不再出现本地 preset owner 和 team preset owner 双持。
- 用户看到的提示与实际状态一致：
  - team preset 已创建并已应用
  - 仅“设为默认”这一步失败

## Touched Files
- `apps/web/src/views/plm/usePlmTeamFilterPresets.ts`
- `apps/web/tests/usePlmTeamFilterPresets.spec.ts`
