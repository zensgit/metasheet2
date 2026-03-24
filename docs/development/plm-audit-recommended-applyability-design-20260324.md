# PLM Audit Recommended Applyability Design

Date: 2026-03-24

## Problem

`recommended team views` 这一层之前只有页面点击时的局部守卫，没有把 `canApply` 合同收进推荐模型本身。

具体有两层缺口：

- 推荐卡主按钮只按 “目标 id 是否存在” 启用，没按 `permissions.canApply` 启用。
- `applyRecommendedAuditTeamView(...)` 只检查 `!isArchived`，没有复用现有 `canApplyPlmAuditTeamView(...)`。

这会留下两个不一致：

- UI 能看到一个看似可执行的 `apply-view` 主操作，但它对只读 team view 并不真正适用。
- 推荐 catalog 的消费者无法只靠 `PlmRecommendedAuditTeamView` 判断主操作是否可执行，必须额外回查原始 team view 列表。

这轮我还用已登录的 `Claude Code` 做了并行只读校验，它确认了这条推荐卡 applyability 漏口。

## Design

### 1. 把推荐 applyability 收进 catalog 合同

[plmAuditTeamViewCatalog.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewCatalog.ts) 现在新增：

- `resolveApplicableRecommendedAuditTeamView(...)`
- `primaryActionDisabled`

其中：

- `resolveApplicableRecommendedAuditTeamView(...)` 统一按 `canApplyPlmAuditTeamView(...)` 解析推荐卡实际可应用目标。
- `primaryActionDisabled` 让推荐模型自己表达 “这张卡的主操作当前不可执行”。

这样推荐卡 UI 不再需要只靠“id 是否存在”做粗粒度启停。

### 2. 让页面入口和底层 apply 都复用同一个 gate

[PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue) 这轮做了两层收口：

- 推荐卡主按钮直接读取 `view.primaryActionDisabled`
- `applyRecommendedAuditTeamView(...)` 改走 `resolveApplicableRecommendedAuditTeamView(...)`
- `applyAuditTeamViewEntry(...)` 自身补了 defensive `canApplyPlmAuditTeamView(...)` 守卫

这样即使后面再接新的 `apply` 入口，也不容易重新绕过 `canApply`。

### 3. 保留推荐内容，但不再谎报主操作可执行

这轮没有把不可 apply 的推荐卡直接从 catalog 里删掉，也没有改动 secondary / management action 合同。

目标是：

- 继续保留推荐上下文、复制链接、管理入口
- 但主操作的可执行性必须和真实权限一致

## Files

- [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue)
- [plmAuditTeamViewCatalog.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewCatalog.ts)
- [plmAuditTeamViewManagement.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewManagement.ts)
- [plmAuditTeamViewCatalog.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditTeamViewCatalog.spec.ts)

## Non-goals

- 不改后端权限模型
- 不改变推荐排序、推荐分桶或 secondary action 文案
- 不把不可 apply 的推荐卡从列表中直接移除
