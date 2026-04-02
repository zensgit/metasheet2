# PLM Panel Team View Share Owner Boundary 设计记录

日期: 2026-03-11

## 目标

收紧 `Documents / CAD / Approvals team view` 的 `share` 角色边界，明确：

1. `share` 是管理动作，不是只读动作
2. 当前 view 转移 owner 之后，旧 owner 不应继续复制 canonical team-view deep link
3. 显式 deep link identity 仍然保留，但管理能力必须立即失效

## 基线判断

当前 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts) 的 `shareTeamView()` 只校验：

1. 已选择 view
2. 非 archived
3. 存在 `buildShareUrl / copyShareUrl`

这意味着只要当前用户还能在列表里看到该 team view，就可以继续复制带显式 identity 的分享链接，即使该 view 已经被转移给别人。

这和现有 lifecycle 不一致。因为：

1. `rename / delete / archive / restore / set default / clear default / transfer`
   已经是 owner-only
2. `share` 仍然像“普通读操作”一样开放

## 方案

### 1. 把 share 收为 owner-only

在 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts) 统一改成：

1. `canShareTeamView = selected.canManage && !selected.isArchived`
2. `shareTeamView()` 运行时先校验 `view.canManage`

提示语义改为：

- `仅创建者可分享文档团队视角。`

这样即使 stale UI 或程序化调用 `shareTeamView()`，也不会继续复制链接。

### 2. 不改变 deep link identity 的可读性

这轮不把 share 收成“只有 owner 能打开”。

原因：

1. 既有 deep link 已被大量用作工作台协作入口
2. 本轮只细化“谁能再次复制官方 team-view 链接”
3. 非 owner 仍可通过显式 `documentTeamView / cadTeamView / approvalsTeamView` 打开 view

也就是说：

- `apply/read` 仍允许
- `share/manage` 收为 owner-only

### 3. 用 owner transfer 验证角色边界

最直接的验证路径是：

1. `dev-user` 创建 documents team view
2. 转移给 `plm-transfer-user`
3. 再用 `dev-user` 打开显式 deep link
4. 验证：
   - 视图 identity 仍存在
   - `分享` 按钮禁用
   - `转移所有者` 按钮禁用

## 对标与超越目标

对标基线是上一轮已经做完的：

- panel team view `set default / clear default` URL 一致性
- archived lifecycle 权限护栏

这轮超越点在于：

1. 把 owner transfer 之后的权限收口到真正一致
2. 不再出现“旧 owner 丢了管理权，但还能继续分享显式 team-view 链接”的缝隙
3. read/apply 与 manage/share 的边界变得更清楚

## 非目标

本轮不做：

1. share token / public link
2. 服务端 share 审计表
3. BOM / Where-Used team preset 的 share owner-only
4. owner transfer 的审批流

## 验证计划

代码级：

- [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

live/browser：

1. 创建 documents team view
2. 转移 owner 给 `plm-transfer-user`
3. `dev-user` 重新打开显式 deep link
4. 验证：
   - `documentTeamView` identity 仍恢复
   - `分享` 按钮禁用
   - `转移所有者` 按钮禁用
5. cleanup 删除临时 view
