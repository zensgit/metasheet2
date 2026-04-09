# 平台用户组与委派范围开发说明

日期：2026-04-09  
分支：`codex/dingtalk-pr3-attendance-notify-20260408`

## 变更范围

### 后端

1. 新增 migration：
   - [zzzz20260409154000_create_platform_member_groups_and_delegated_group_scopes.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/src/db/migrations/zzzz20260409154000_create_platform_member_groups_and_delegated_group_scopes.ts)

2. 扩展管理路由：
   - [admin-users.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/src/routes/admin-users.ts)

3. 扩展单测：
   - [admin-users-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/packages/core-backend/tests/unit/admin-users-routes.test.ts)

### 前端

1. 扩展角色委派页：
   - [RoleDelegationView.vue](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/apps/web/src/views/RoleDelegationView.vue)
2. 新增前端视图测试：
   - [roleDelegationView.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/apps/web/tests/roleDelegationView.spec.ts)

## 新增接口

### 平台用户组

1. `GET /api/admin/role-delegation/member-groups`
2. `POST /api/admin/role-delegation/member-groups`
3. `GET /api/admin/role-delegation/member-groups/:groupId`
4. `POST /api/admin/role-delegation/users/:userId/member-groups/:action(assign|unassign)`

### 插件管理员成员组范围

1. `POST /api/admin/role-delegation/users/:userId/scope-groups/:action(assign|unassign)`

### 模板成员组

1. `POST /api/admin/role-delegation/scope-templates/:templateId/member-groups/:action(assign|unassign)`

## 已有接口扩展

以下接口现在都带上“平台用户组/成员组范围”：

1. `GET /api/admin/role-delegation/summary`
2. `GET /api/admin/role-delegation/users/:userId/access`
3. `GET /api/admin/role-delegation/users/:userId/scopes`
4. `POST /api/admin/role-delegation/users/:userId/scope-templates/apply`
5. `GET /api/admin/users/:userId/member-admission`

## 关键实现点

### 1. 平台用户组基础层

新增 `platform_member_groups` 和 `platform_member_group_members`，作为跨插件复用的人群治理层。  
成员组只绑定本地 `users`，不直接绑定外部账号，避免身份映射层与授权层纠缠。

### 2. 插件管理员范围从单一部门树扩到并集

在 `fetchScopedDelegationUsers()` 和 `isUserWithinDelegatedScope()` 中，把可管理范围改成：

- 来自 `delegated_role_admin_scopes` 的部门树
- 来自 `delegated_role_admin_member_groups` 的平台用户组

只要命中其一，就视为在当前插件管理员的可操作范围内。

### 3. 模板可同时复制部门和成员组

`fetchDelegatedScopeTemplateDetail()` 现在返回：

- `departments`
- `memberGroups`

模板应用时：

1. `replace` 模式先清掉目标命名空间下的部门范围和成员组范围
2. 再把模板中的部门和成员组一并复制到运行态表

### 4. 管理页集中化

`RoleDelegationView.vue` 里集中展示 4 类信息：

1. 目标成员已有插件角色
2. 目标成员所属平台用户组
3. 目标插件管理员的部门/成员组范围
4. 模板内的部门/成员组内容

## 兼容性与风险控制

1. 原有部门树范围逻辑保留，旧数据无需迁移转换。
2. 模板仍是 copy-on-apply，避免 live-linked 影响已发放管理员。
3. 没有用户组范围时，原有部门树逻辑继续生效。
4. 没有部门范围但有用户组范围时，也允许插件管理员在该固定人群内委派。
5. 平台成员组和范围模板创建时，唯一约束冲突会显式映射为 `409`，避免前端把重名误判成系统故障。
6. 角色委派页在搜索成员组后若当前选中项已不在结果集中，会清空失效选择并禁用“将当前成员加入成员集”按钮，避免提交隐藏的旧 `groupId`。
7. 非平台管理员查看成员委派详情时，只返回自己已被授权的成员组范围，不暴露目标成员的全部平台用户组归属。
