# PLM Workbench Audit Return Owner Roundtrip Design

## 背景

`PLM Workbench` 从当前页面跳到 `PLM Audit` 时，会通过 `returnToPlmPath` 保留返回链接。现有实现复用了 collaborative snapshot 归一化，因此会剥掉 `workbenchTeamView`，导致从 audit 返回后丢失显式的 workbench team view owner。

## 问题

- `buildPlmWorkbenchRoutePath(...)` 直接遍历 `normalizePlmWorkbenchCollaborativeQuerySnapshot(...)`
- 该归一化会刻意删除 `workbenchTeamView`
- 结果是：
  - `share URL / saved snapshot` 语义是对的
  - 但 `returnToPlmPath` 这种“返回当前页面”语义不对

## 设计决策

- 保持 collaborative snapshot 合同不变：
  - 继续剥离 `bomFilterPreset`
  - 继续剥离 `whereUsedFilterPreset`
  - 继续剥离 `approvalComment`
  - 继续 canonicalize `panel`
- 只在 `buildPlmWorkbenchRoutePath(...)` 里显式补回 trimmed `workbenchTeamView`
- 这样 `returnToPlmPath` 会保留 canonical owner，但不会把本地-only state 带进 URL

## 实现

- 在 `buildPlmWorkbenchRoutePath(...)` 中先读取并 trim `snapshot.workbenchTeamView`
- 如果存在，则先写入 `URLSearchParams`
- 其余字段继续走 `normalizePlmWorkbenchCollaborativeQuerySnapshot(...)`

## 预期结果

- `openWorkbenchSceneAudit()` / `openRecommendedWorkbenchSceneAudit()` 生成的 `returnToPlmPath` 保留显式 `workbenchTeamView`
- 从 audit 返回 workbench 时，不会丢失当前 collaborative owner
- 现有 share/snapshot/filter canonicalization 行为不变
