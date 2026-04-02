# PLM Workbench Team Preset Share Parity Design

## Context

`team view share` 已经能区分两类 denial：

- readonly target：`仅创建者可分享...`
- owner 但显式 `canShare = false`：`当前...不可分享。`

但 `team preset share` 仍把这两类情况统一折叠成 `当前...不可分享。`

## Problem

这会带来两类行为不一致：

- 用户在 readonly `team preset` 上直接触发 handler 时，看不到真实的 owner denial
- `team views` 与 `team presets` 在同一权限模型下给出不同反馈

这属于 collaborative management parity 的一条剩余边角。

## Design

在 `shareTeamPreset()` 里沿用已经存在的 target/actionability 结构：

1. 先保留 archived restore-first 分支
2. 对非 archived denial：
   - `canManageSelectedTeamPreset.value === false` -> `仅创建者可分享...`
   - `canManageSelectedTeamPreset.value === true` 且 `canShareTeamPreset.value === false` -> `当前...不可分享。`

这样能和 `shareTeamView()` 的判定路径完全一致。

## Scope

- `apps/web/src/views/plm/usePlmTeamFilterPresets.ts`
- `apps/web/tests/usePlmTeamFilterPresets.spec.ts`

## Expected Outcome

`team preset share` 的 denial message 将与 `team view share` 完全对齐，readonly 与 explicit action denial 不再被混成同一条反馈。
