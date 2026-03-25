# PLM Workbench Selector Draft Cleanup Design

Date: 2026-03-25

## Problem

[PlmTeamViewsBlock.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmTeamViewsBlock.vue) 的 `Team views` 下拉直接绑定：

- `v-model="teamViewKey.value"`

而 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts) 里的：

- `selectedTeamView`
- `canRenameTeamView`
- `canTransferTeamView`
- 其他 management action

又都是直接基于当前 `teamViewKey` 计算。

这意味着用户只要在 selector 里把目标从 A 切到 B，management target 就已经切过去了，即使还没有点 `Apply`。

在上一轮之前，这里只清了 owner draft，没有清 name draft；而且 cleanup 还是异步触发。结果会出现两类残留：

- 给 A 输入的 rename 草稿会直接变成 B 的 rename 输入值
- transfer-owner 草稿也会短暂挂在新 selector target 上

## Design

### 1. selector 变化时同步清 local drafts

在 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts) 里，对 `teamViewKey` 增加同步 watcher：

- 只要 `next !== previous`
- 就立即清掉：
  - `teamViewName.value`
  - `teamViewOwnerUserId.value`

实现上使用：

- `watch(teamViewKey, ..., { flush: 'sync' })`

### 2. 为什么要 `flush: 'sync'`

如果沿用默认异步 flush，会出现下面的顺序问题：

1. 用户切换 selector
2. 代码立刻给新 target 输入新的 rename/owner draft
3. 旧 watcher 在后一个更新周期才执行
4. 新输入反而被晚到的 cleanup 清掉

同步 flush 可以保证：

- selector 一改，旧 draft 当场清空
- 后续用户针对新 target 的输入不会再被旧 cleanup 回头覆盖

### 3. 不改变 create-mode draft 合同

这轮只处理：

- selector target 变化时的 local draft residue

不改变：

- refresh 不带 selector 变化时的 create-mode name draft 保留
- save/duplicate/apply 成功后的现有 cleanup

## Regression coverage

[usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts) 这轮新增 focused regression：

- 先选中 `workbench-view-a`
- 写入 `teamViewName` 和 `teamViewOwnerUserId`
- 再把 selector 改到 `workbench-view-b`
- 断言两个 draft 都会被清空

同时保留并继续通过：

- `saveTeamView()` 后 owner draft cleanup
- `duplicateTeamView()` 切到新 id 后 owner draft cleanup

## Files

- [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts)
- [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts)
- [PlmTeamViewsBlock.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/components/plm/PlmTeamViewsBlock.vue)

## Non-goals

- 不改变 `Apply` 的 route/canonical target 语义
- 不改 batch selection 行为
- 不新增 selector 级 notice 或提示条
