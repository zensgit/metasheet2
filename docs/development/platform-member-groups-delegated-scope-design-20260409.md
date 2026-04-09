# 平台用户组与委派范围设计

日期：2026-04-09  
分支：`codex/dingtalk-pr3-attendance-notify-20260408`

## 目标

在现有“插件管理员按命名空间委派角色 + 按钉钉部门树限范围”的基础上，再补一层可复用的人群治理能力：

1. 平台管理员可维护平台级用户组。
2. 插件管理员范围可由“部门树”扩展成“部门树 ∪ 平台用户组”。
3. 组织范围模板可同时复用部门和平台用户组。
4. 先把用户组作为统一授权底座，不直接耦合某个插件。

## 设计原则

1. 身份准入、组织同步、插件授权继续分层，不把“用户同步”直接等同于“插件可用”。
2. 用户组是平台治理实体，由平台管理员维护，不下放给插件管理员创建。
3. 运行时仍然按“copy-on-apply”工作，不做 live-linked 模板，降低联动复杂度。
4. 插件管理员越权边界不变：只能分配自己命名空间下的角色，且目标成员必须命中已授权部门或用户组。

## 数据模型

新增 4 张表：

1. `platform_member_groups`
   - 平台用户组主表
   - 唯一名称、描述、创建人、更新时间

2. `platform_member_group_members`
   - 用户组成员表
   - `group_id + user_id` 复合主键

3. `delegated_role_admin_member_groups`
   - 插件管理员的成员组范围
   - `admin_user_id + namespace + group_id` 唯一

4. `delegated_role_scope_template_member_groups`
   - 组织范围模板绑定的成员组
   - `template_id + group_id` 复合主键

## 运行时判定

插件管理员可管理的成员范围改成并集：

- 部门树命中
- 平台用户组命中

对应影响 3 个读写面：

1. `GET /api/admin/role-delegation/users`
   - 插件管理员看到的可操作成员列表

2. `GET /api/admin/role-delegation/users/:userId/access`
   - 目标成员是否在当前管理员可操作范围内

3. `POST /api/admin/role-delegation/users/:userId/roles/:action`
   - 真正分配或撤销插件角色时的越权校验

## 管理面

平台管理员新增 3 组动作：

1. 用户组治理
   - 创建平台用户组
   - 维护某个成员属于哪些平台用户组
   - 查看某个平台用户组的成员

2. 插件管理员范围治理
   - 给某个 `xxx_admin` 成员分配部门范围
   - 给某个 `xxx_admin` 成员分配平台用户组范围

3. 模板治理
   - 模板内既可挂部门，也可挂平台用户组
   - 覆盖应用时同时写入部门范围和成员组范围

## 前端入口

继续复用 [RoleDelegationView.vue](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/apps/web/src/views/RoleDelegationView.vue)，原因：

1. 角色委派、范围限制、模板复用本来就在同一管理心智里。
2. 用户组选中成员后即可直接加入/移出当前平台用户组，不需要新开一个管理页打断流程。
3. 平台管理员能在同一页同时看到：
   - 当前成员的插件角色
   - 当前成员所属平台用户组
   - 当前插件管理员的部门/成员组范围
   - 当前模板中的部门/成员组

## 非目标

这轮不做：

1. 插件管理员自己创建平台用户组
2. 基于用户组的数据权限过滤
3. 用户组模板再嵌套用户组
4. live-linked 模板变更自动刷新到所有已应用管理员

## 后续建议

下一层最值得继续补的是：

1. 用户组来源治理
   - 手工用户组
   - 按目录组织同步出来的动态组

2. 数据范围授权
   - 让插件不仅判定“能不能进”
   - 还能判定“能看哪些数据”
