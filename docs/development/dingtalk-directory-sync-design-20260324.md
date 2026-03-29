# DingTalk Directory Sync Design

## Goal

在保持当前方案 B 不变的前提下，补一条独立的“钉钉组织账户同步”能力：

- 从钉钉组织读取部门与成员目录
- 在 MetaSheet 内形成“可审核、可授权、可开通”的账号候选池
- 允许管理员把钉钉目录成员映射到现有 MetaSheet 账号，或创建本地账号后再授权钉钉登录
- 不把“组织同步”和“登录绑定”混成一条黑盒流程

这条能力的目标不是替代当前钉钉登录，而是给方案 B 补上一个更高效的“管理员批量授权与开通”入口。

## Current Gap

当前仓库里已经具备两块基础能力，但还没有“整组织目录同步”：

- 钉钉登录/绑定只读取“当前授权用户”的资料，见 [dingtalk-auth.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/auth/dingtalk-auth.ts)
- 绑定列表只展示本地用户已经绑定的钉钉身份，见 [auth.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/auth.ts#L1006)
- 考勤插件可以按预先给定的 `userIds` 拉考勤数据，但不会先发现整组织成员，见 [index.cjs](/Users/huazhou/Downloads/Github/metasheet2/plugins/plugin-attendance/index.cjs#L13156)

另外，当前本地账号模型仍然是：

- `users` 强依赖 `email` 和 `password_hash`，见 [zzzz20260119100000_create_users_table.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260119100000_create_users_table.ts)
- `user_orgs` 负责组织归属，见 [zzzz20260114110000_create_user_orgs_table.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260114110000_create_user_orgs_table.ts)
- `user_external_identities` 负责钉钉身份绑定
- `user_external_auth_grants` 负责“是否允许该本地账号使用钉钉登录”

这意味着：要读取钉钉组织成员没有问题，但要安全落到 MetaSheet，必须走“目录同步 -> 管理审核 -> 本地授权/开通”这条链路。

## Product Decision

默认继续采用方案 B：

- 同步钉钉组织成员，不等于自动允许钉钉登录
- 新同步进来的钉钉成员，默认只是“目录记录”
- 只有管理员明确执行“关联已有账号”或“开通本地账号并授权钉钉登录”后，才允许该成员用钉钉直登

这样既满足“拿到钉钉组织账户”，又不破坏当前已经跑通的授权边界。

本次实现还锁定了 3 个产品决策：

- 首版包含手动同步、定时同步、目录审核、开通本地账号、授权钉钉登录
- 没有企业邮箱的钉钉成员，开户时必须由管理员补填邮箱
- 离职处理支持三种策略，采用“集成默认 + 成员覆盖”的配置模式

## Implementation Status

截至 2026-03-25，本设计已经落到代码，主要实现如下：

- 新增目录同步数据表与 migration：
  - [zzzz20260324150000_create_directory_sync_tables.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260324150000_create_directory_sync_tables.ts)
- 新增目录同步服务：
  - [directory-sync.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/directory/directory-sync.ts)
- 新增管理员目录路由：
  - [admin-directory.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/admin-directory.ts)
- 服务启动/停止时接入目录定时调度：
  - [index.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/index.ts)
- 新增 OpenAPI 契约：
  - [admin-directory.yml](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/src/paths/admin-directory.yml)
  - [base.yml](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/src/base.yml)
- 新增后台目录管理页：
  - [DirectoryManagementView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/DirectoryManagementView.vue)
- 新增后台路由入口：
  - [main.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/main.ts)
  - [router/types.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/router/types.ts)
- 新增目录单测：
  - [directory-sync.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/directory-sync.test.ts)
  - [admin-directory-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/admin-directory-routes.test.ts)
  - [directoryManagementView.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/directoryManagementView.spec.ts)

当前实现已经包含：

- 目录集成配置新增、编辑、列表
- 手动同步
- 定时同步
- 同步运行记录
- 部门目录与成员目录列表
- 目录成员详情
- 关联已有 MetaSheet 账号
- 从目录成员开通本地账号
- 授权钉钉登录
- 忽略、解绑目录审核关系
- 集成默认离职策略与成员级覆盖
- 同步时对离职成员执行策略

本轮还完成了现网部署验证：

- 已部署到 `142.171.239.56:8081`
- 现网 `GET /api/admin/directory/integrations` 返回 `200`
- 现网已能创建 integration、执行 `test`、执行 `sync`、读取 run 记录
- 当前真实阻塞是 DingTalk 应用未开通通讯录 scope，而不是 MetaSheet 代码未接通

当前实现与 v1 边界已更新：

- `mobile_exact` 已接入自动匹配（手机号归一化后唯一命中即自动 `linked`）
- 仍保留 `external_identity` 优先级高于邮箱与手机号

## Scope

本阶段纳入：

- 钉钉组织目录连接配置
- 手动同步与定时同步
- 部门树、成员目录、部门成员关系落库
- 成员与本地账号的匹配状态
- 管理员审核与授权操作
- 审计日志、同步运行记录、失败可见性

本阶段不纳入：

- 自动开户后立即放开钉钉直登
- 钉钉组织变更实时 webhook 双向联动
- 考勤规则或审批流同步
- 自动以钉钉离职状态直接禁用 MetaSheet 账号

## Required DingTalk Permissions

要读取整组织目录，不能只靠当前登录链路里的 `Contact.User.Read`。

至少需要补企业通讯录相关权限，类型上应覆盖：

- 部门读取
- 成员读取
- 部门成员读取
- 应用级 token 获取

这里不在文档里硬编码控制台里的精确中文权限名，因为不同应用类型和控制台版本命名会有差异；实施时应以“企业通讯录部门/成员读取类权限”为准，并在预检脚本里显式校验。

## Architecture

推荐把它做成独立的“目录同步”能力，而不是继续复用 `attendance_integrations`。

原因：

- [zzzz20260202093000_create_attendance_integrations.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260202093000_create_attendance_integrations.ts) 明显偏考勤业务
- 目录同步的对象是“部门、成员、匹配、授权”，不是“考勤列值”
- 后续如果接企业微信、飞书，也更适合走统一的目录同步抽象

建议新增 6 张表。

## Data Model

### `directory_integrations`

用途：保存一个组织目录连接配置。

核心字段：

- `id`
- `org_id`
- `provider`，当前仅 `dingtalk`
- `name`
- `status`，`active | paused | error`
- `corp_id`
- `config`
- `last_sync_at`
- `last_success_at`
- `last_cursor`
- `default_deprovision_policy`
- `created_at`
- `updated_at`

`config` 建议包含：

- `appKey`
- `appSecret`
- `agentId` 或其他应用标识
- `rootDepartmentId`
- `syncMode`，`manual | scheduled`
- `scheduleCron`
- `syncEnabled`

注意：

- 长期建议把密钥迁到 secret manager 或单独加密列，不建议一直裸放 `jsonb`
- `org_id + name` 应唯一

`default_deprovision_policy` 固定枚举：

- `mark_inactive`
- `disable_dingtalk_auth`
- `disable_local_user`

### `directory_departments`

用途：保存同步到 MetaSheet 的钉钉部门树快照。

核心字段：

- `id`
- `integration_id`
- `provider`
- `external_department_id`
- `external_parent_department_id`
- `name`
- `full_path`
- `order_index`
- `is_active`
- `raw`
- `last_seen_at`
- `created_at`
- `updated_at`

关键约束：

- 唯一键：`(integration_id, external_department_id)`

### `directory_accounts`

用途：保存钉钉目录成员，不等于本地账号。

核心字段：

- `id`
- `integration_id`
- `provider`
- `corp_id`
- `external_user_id`
- `union_id`
- `open_id`
- `external_key`
- `name`
- `nick`
- `email`
- `mobile`
- `job_number`
- `title`
- `avatar_url`
- `is_active`
- `deprovision_policy_override`
- `raw`
- `last_seen_at`
- `created_at`
- `updated_at`

关键约束：

- 唯一键：`(provider, external_key)`
- 唯一键：`(integration_id, external_user_id)`

`deprovision_policy_override` 可空，枚举与 integration 默认策略一致。

`external_key` 应复用当前绑定模型的构造方式，保持一致：

- 优先 `dingtalk:${corpId}:${userId}`
- 其次 `dingtalk-union:${unionId}`
- 再次 `dingtalk-open:${openId}`

这样后续“目录成员”和“已绑定身份”可以天然对齐，见 [external-identities.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/auth/external-identities.ts)

### `directory_account_departments`

用途：保存成员和部门的多对多关系。

核心字段：

- `directory_account_id`
- `directory_department_id`
- `is_primary`
- `created_at`

关键约束：

- 主键：`(directory_account_id, directory_department_id)`

### `directory_account_links`

用途：保存目录成员与本地账号的审核/匹配结果。

核心字段：

- `id`
- `directory_account_id`
- `local_user_id`
- `link_status`
- `match_strategy`
- `reviewed_by`
- `review_note`
- `created_at`
- `updated_at`

状态建议：

- `pending`
- `linked`
- `conflict`
- `ignored`

匹配策略建议：

- `external_identity`
- `email_exact`
- `mobile_exact`
- `manual`

说明：

- 当前已实现并启用的是 `external_identity`、`email_exact`、`mobile_exact`、`manual`

这里不要直接复用 `user_external_identities`。

原因：

- `user_external_identities` 表示“该本地账号已经绑定该钉钉身份”
- `directory_account_links` 表示“目录审核结果”
- 两者生命周期不同

### `directory_sync_runs`

用途：记录每次同步的运行和统计。

核心字段：

- `id`
- `integration_id`
- `status`
- `started_at`
- `finished_at`
- `cursor_before`
- `cursor_after`
- `stats`
- `error_message`
- `meta`

`stats` 建议记录：

- `departmentsFetched`
- `accountsFetched`
- `accountsInserted`
- `accountsUpdated`
- `linksMatched`
- `linksConflicted`
- `accountsDisabled`

## Matching Policy

目录同步不应直接修改本地账号，只应先匹配、再由管理员确认。

匹配优先级建议：

1. 若已存在 `user_external_identities` 同 `external_key`，则直接判定为 `linked`
2. 若目录成员邮箱与本地 `users.email` 唯一精确命中，则直接 `linked`，策略标记为 `email_exact`
3. 若手机号与唯一用户命中，则直接 `linked`，策略标记为 `mobile_exact`
4. 若命中多个用户，则标记为 `conflict`
5. 完全无命中则标记为 `pending`

只有管理员显式确认后，才允许：

- 创建或更新 `user_external_identities`
- 写入 `user_external_auth_grants.enabled=true`

## Backend API

建议新增以下接口。

### Integration Management

- `GET /api/admin/directory/integrations`
- `POST /api/admin/directory/integrations`
- `PATCH /api/admin/directory/integrations/:id`
- `POST /api/admin/directory/integrations/:id/test`
- `POST /api/admin/directory/integrations/:id/sync`
- `GET /api/admin/directory/integrations/:id/runs`

### Directory Browsing

- `GET /api/admin/directory/integrations/:id/departments`
- `GET /api/admin/directory/integrations/:id/accounts`
- `GET /api/admin/directory/integrations/:id/accounts/:accountId`

列表查询建议支持：

- `departmentId`
- `keyword`
- `linkStatus`
- `active`
- `page`
- `pageSize`

### Review Actions

- `POST /api/admin/directory/accounts/:accountId/link-existing`
- `POST /api/admin/directory/accounts/:accountId/provision-user`
- `POST /api/admin/directory/accounts/:accountId/authorize-dingtalk`
- `POST /api/admin/directory/accounts/:accountId/ignore`
- `POST /api/admin/directory/accounts/:accountId/unlink`
- `POST /api/admin/directory/accounts/:accountId/deprovision-policy`

动作含义：

- `link-existing`
  仅建立目录成员与本地用户的审核关系，可选同时补绑定
- `provision-user`
  创建本地 `users + user_orgs`，然后建立 link
- `authorize-dingtalk`
  对已 link 的用户写入 `user_external_auth_grants`

## Sync Flow

### Manual Sync

1. 管理员创建 `directory_integrations`
2. 点击“立即同步”
3. 后端创建 `directory_sync_runs`
4. 获取钉钉应用级 token
5. 拉取部门树
6. 按部门拉取成员
7. upsert `directory_departments`
8. upsert `directory_accounts`
9. 重建 `directory_account_departments`
10. 执行匹配逻辑，生成或更新 `directory_account_links`
11. 汇总统计，写回 run

### Scheduled Sync

首版直接包含定时同步，但实现保持保守：

- integration 保存 `scheduleCron` 和 `syncEnabled`
- 后端启动后注册目录同步调度器
- 调度器只负责按 cron 检查和触发同步任务
- 同一 integration 只允许一个运行中的同步
- 若上一次仍未完成，则本次记为 skipped run

首版不做：

- webhook 实时目录变更接入
- 复杂的分页断点 cursor 恢复
- 多 worker 并行拆分部门同步

## Admin UX

推荐在 [UserManagementView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/UserManagementView.vue) 旁边增加一个独立页，例如：

- `/admin/directory`

页面结构建议：

1. 连接配置区
2. 同步运行区
3. 部门树
4. 成员列表
5. 成员详情抽屉
6. 审核动作区

成员列表重点展示：

- 钉钉姓名
- 邮箱
- 手机号
- 部门
- 在职状态
- 匹配状态
- 本地账号
- 钉钉登录授权状态

状态标签建议：

- `已绑定`
- `已匹配未授权`
- `未匹配`
- `冲突待处理`
- `已忽略`

成员详情页还应支持：

- 查看生效中的离职策略
- 选择成员级覆盖策略
- 恢复为集成默认策略

## Authorization Policy

这条能力和当前方案 B 的关系应保持明确：

- 目录同步只负责“发现”
- 管理员审核只负责“决定”
- `user_external_auth_grants` 才决定“能不能用钉钉登录”

因此：

- 同步成员不自动获得钉钉直登权限
- 目录里的人即使已 link 到本地账号，也可以保持 `dingtalkAuthEnabled=false`
- 只有管理员明确授权后，才允许该账号绑定或钉钉直登

## Deprovision Policy

离职或从可见范围消失的成员，首版支持 3 个策略：

### `mark_inactive`

- 仅将目录成员标记为失活
- 不自动禁用本地用户
- 不自动关闭钉钉登录
- 不自动解绑历史身份

### `disable_dingtalk_auth`

- 将目录成员标记为失活
- 若已 link 到本地用户，则把 `user_external_auth_grants.enabled=false`
- 不停用本地账号
- 不解绑历史外部身份

### `disable_local_user`

- 将目录成员标记为失活
- 若已 link 到本地用户，则把本地 `users.is_active=false`
- 同时关闭 `user_external_auth_grants.enabled`
- 不删除本地账号
- 不解绑历史外部身份

配置模式固定为：

- integration 上配置默认策略
- 成员详情页允许单独覆盖
- 覆盖优先于 integration 默认值

## Security and Audit

必须补这几项：

- 每次同步、授权、开通、忽略、解绑都记审计日志
- 目录接口只允许平台管理员访问
- 每个 integration 严格受 `org_id` 约束
- 同步失败信息要结构化入库，不只写日志
- 敏感配置不在前端回显明文

## Rollout Plan

推荐三阶段。

### Phase 1

- 后端目录表与运行表
- 手动同步
- 只读成员列表
- 匹配状态计算
- integration 默认离职策略

### Phase 2

- 管理员审核动作
- 关联已有账号
- 创建本地账号
- 授权钉钉登录
- 成员级离职策略覆盖

### Phase 3

- 定时同步
- 离职/停用策略
- 差异提醒
- 批量授权与批量开通

## Why This Is Better

比“直接首次钉钉登录自动开户”更稳的点在于：

- 权限边界更清楚
- 组织目录可见但不自动放权
- 冲突用户不会被误绑
- 支持先导入、后审核、再授权
- 与当前方案 B 完全兼容，不需要推翻已上线链路

比“手工一个个建用户再授权”更强的点在于：

- 可以批量发现目录成员
- 可以自动做邮箱/手机号初步匹配
- 可以沉淀同步运行记录和差异
- 后续扩展飞书/企业微信时可以复用同一抽象

## Recommendation

建议下一步不是直接开做“自动开户”，而是先做目录同步的 Phase 1 + Phase 2：

- 先把钉钉组织账户拉进来
- 再让管理员批量决定谁能开通 MetaSheet
- 最后再评估是否需要在受控范围内放开更自动化的流程
