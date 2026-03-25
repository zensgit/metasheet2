# PLM Workbench Deep Link Scope Hydration Design

## 背景

[PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue) 在引入 authoritative route hydration 后，会在每次 query 变化时重新执行 `applyQueryState()`。

## 问题

`deepLinkScope` 其实是本地 deep-link builder UI 状态，不是 canonical route owner。

如果在 hydration 开头无条件把它清成空数组，那么：

1. 用户在 deep-link builder 里手动勾选了 panel scope
2. 页面任意 query（如 `searchQuery`）发生同步
3. route watcher 重新跑 `applyQueryState()`
4. 本地 deep-link scope 被错误清空

这会让 route hydration 反过来侵蚀本地 builder 草稿。

## 设计

把 `deepLinkScope` 从 hydration reset 集合里移除：

- `panel` query 显式存在时，仍按 route 覆盖 `deepLinkScope`
- `panel` query 不存在时，保留当前本地 builder scope，不再被 route watcher 清空

## 结果

- authoritative route hydration 继续只作用于真正的 route-owned state
- deep-link builder 的本地 panel 选择不会再被普通 query sync 冲掉
