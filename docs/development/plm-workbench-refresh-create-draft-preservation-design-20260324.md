# PLM Workbench Refresh Create Draft Preservation Design

Date: 2026-03-24

## Problem

上一轮 `refresh name-draft cleanup` 在 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts) 里补了：

- refresh deselect 时清 `teamViewName`

但第一版少了 `teamViewKey.value` guard，导致一个新的回归：

- 用户当前并没有选中任何 team view
- 只是处于 create-mode，手里有一份 `teamViewName` 草稿
- 一次普通 `refreshTeamViews()` 也会把这份草稿误清掉

这不是目标行为。refresh cleanup 只应该在“真的发生 deselect”时触发。

这轮我继续并行用了 `Claude Code` 做只读校验，它直接指出了这一 token-level guard 缺口。

## Design

### 1. 只在存在 active selection 时才做 missing-view cleanup

`refreshTeamViews()` 的第一条 deselect 分支现在改成：

- `if (teamViewKey.value && !items.some(...))`

这样只有在当前真的存在 active selection 时，refresh 才会把 `teamViewKey` 和 `teamViewName` 一起清掉。

### 2. create-mode draft 保持独立

当 `teamViewKey.value === ''` 时，refresh 不再碰 `teamViewName`。这让 create-mode 的命名草稿继续保留。

### 3. 回归覆盖 create-mode 场景

[usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts) 新增 focused regression：

- 没有 active selection
- `teamViewName` 已填写
- refresh 后这份草稿仍然保留

## Files

- [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmTeamViews.ts)
- [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts)

## Non-goals

- 不改变真正 deselect 时的 name cleanup
- 不改变 auto-apply/default takeover
- 不改变 owner draft 合同
