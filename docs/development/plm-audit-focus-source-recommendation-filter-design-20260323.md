# PLM Audit Focus-Source Recommendation Filter Design

## Background

`PLM Audit` 的 collaboration followup 支持 `focus-source`，把用户带回：

- recommendations
- saved views
- scene context
- team-view controls

这条路径已经会切换 source focus id，但 recommendation filter 仍由页面单独维护。

## Problem

在本次修改前，`buildPlmAuditTeamViewCollaborationSourceFocusIntent(...)` 对非 recommendation 来源返回 `recommendationFilter: null`。

页面层因此只会在 recommendation 来源时覆盖 `auditTeamViewRecommendationFilter`，而：

- `Back to saved views`
- `Back to scene context`
- `Back to team view controls`

都不会清掉之前残留的 recommendation filter。

结果是 source 已经切回别的区域，但 recommendation 区仍可能保持旧的筛选芯片。

## Decision

把 recommendation filter 也纳入 source-focus intent 合同：

- recommendation 来源显式返回对应 filter
- 非 recommendation 来源显式返回空 filter `''`
- 页面层无条件同步 `auditTeamViewRecommendationFilter`

## Implementation

Files:

- `apps/web/src/views/plmAuditTeamViewCollaboration.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`

Key changes:

- `PlmAuditTeamViewCollaborationSourceFocusIntent.recommendationFilter` 改为总是返回 `PlmRecommendedAuditTeamViewFilter`
- saved-view / scene-context / controls 来源改为返回 `''`
- `focus-source` 页面编排无条件回写 recommendation filter

## Expected Behavior

- `Back to recommendations` 仍会恢复对应 recommendation filter
- `Back to saved views` 会清掉旧 recommendation filter
- `Back to scene context` 会清掉旧 recommendation filter
- `Back to team view controls` 会清掉旧 recommendation filter
