# DingTalk Secure Admission Design

日期: 2026-04-11

## 目标

本次改动同时解决两类问题：

1. 钉钉集成安全基线不足
   - 目录同步与考勤集成的 `appSecret` 以明文 JSON 保存。
   - 钉钉机器人通知日志会打印完整 webhook URL。
   - `DINGTALK_ALLOWED_CORP_IDS` 仅在文档中存在，运行时未真正生效。

2. 插件权限缺少“开通”层
   - 现有模型只有账号启用、角色、权限。
   - 平台管理员与插件管理员无法对“某个成员是否允许使用某个插件命名空间”做独立开关。
   - 角色被撤销后，原开通状态不会自动收敛。

## 设计原则

### 钉钉集成安全

- 持久化永远写入 `enc:<base64>` 格式。
- 读取兼容老数据：
  - 明文可读。
  - `enc:` 前缀自动解密。
- 不在服务启动时偷偷改库。
- 提供一次性运维脚本做历史数据加密迁移。
- 运行时 Corp allowlist 统一在服务端判定，不靠前端兜底。

### 命名空间准入

- 生效权限 = 账号启用 + 至少一个命名空间角色 + admission enabled。
- `admin` 仍然是平台全局管理员，直接绕过 namespace admission。
- admission 不会因为分配角色而自动开启。
- 当用户失去某命名空间最后一个角色时，系统自动关闭该 namespace admission。
- 平台管理员和委派插件管理员都能操作 admission，但委派管理员只能处理自己命名空间且在授权组织范围内的成员。

## 数据模型

新增表：`user_namespace_admissions`

- `id uuid primary key`
- `user_id text not null references users(id) on delete cascade`
- `namespace text not null`
- `enabled boolean not null default false`
- `source text not null default 'platform_admin'`
- `granted_by text`
- `updated_by text`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`
- unique: `(user_id, namespace)`

迁移回填：

- 从 `user_roles + role_permissions` 推导受控命名空间。
- 为已有角色成员插入 `enabled = true, source = 'seed_backfill'`。
- 这样历史已在使用中的插件成员不会被一次升级直接锁死。

## 运行时规则

### 命名空间识别

- 角色命名空间：
  - `role_id === namespace`
  - 或 `role_id` 以 `${namespace}_` 开头
  - 或该角色的 `role_permissions` 包含 `${namespace}:*`
- 权限命名空间：
  - 取 `permission_code` 的资源前缀，即 `resource:action` 中的 `resource`

### 不受 admission 控制的共享资源

当前明确排除：

- `spreadsheet`
- `spreadsheets`
- `multitable`
- `workflow`
- `approvals`
- `comments`
- `permissions`
- `roles`
- `admin`
- 以及一批平台基础资源如 `auth`、`audit`、`health`、`notifications`

因此：

- `attendance:*`、`crm:*`、`plm:*`、`after_sales:*` 这类插件/业务命名空间受 admission 控制。
- 多维表、流程、评论等平台共享能力不受这套 admission 影响。

## 后端改动

### 钉钉与目录

- `packages/core-backend/src/integrations/dingtalk/client.ts`
  - `DINGTALK_ALLOWED_CORP_IDS` 运行时生效。
  - `DINGTALK_CORP_ID` 不在 allowlist 中时，OAuth 配置视为不可用。

- `packages/core-backend/src/directory/directory-sync.ts`
  - 目录集成 `appSecret` 改为加密存储。
  - 读老数据兼容明文。
  - 创建、更新、测试前校验 `corpId` 是否在 allowlist。

- `plugins/plugin-attendance/index.cjs`
  - 考勤集成 `appSecret` 改为加密存储。
  - 列表响应不再回传明文 secret，只暴露 `appSecretConfigured`。
  - 创建、更新、同步时校验 `corpId` allowlist。
  - DingTalk 请求失败日志中的敏感 query 参数被脱敏。

- `packages/core-backend/src/services/NotificationService.ts`
  - DingTalk 机器人 webhook 日志改为脱敏 URL，隐藏 `access_token/sign/timestamp`。

### RBAC 与 admission

- 新增共享模块：
  - `packages/core-backend/src/rbac/namespace-admission.ts`
  - `packages/core-backend/src/security/encrypted-secrets.ts`
  - `packages/core-backend/src/integrations/dingtalk/runtime-policy.ts`

- `packages/core-backend/src/rbac/service.ts`
  - `listUserPermissions()` 会过滤掉未通过 namespace admission 的权限。
  - `userHasPermission()` 直接变成 admission-aware。

- `packages/core-backend/src/rbac/rbac.ts`
  - 即使走 `req.user.permissions` 或 trusted token claims，也会再做 namespace admission 判定。
  - 避免绕过 `listUserPermissions()` 的短路路径漏掉 admission。

### 管理后台 API

- 平台管理员：
  - `PATCH /api/admin/users/:userId/namespaces/:namespace/admission`

- 委派插件管理员：
  - `PATCH /api/admin/role-delegation/users/:userId/namespaces/:namespace/admission`

- 快照返回增强：
  - `GET /api/admin/users/:userId/member-admission`
  - `GET /api/admin/role-delegation/users/:userId/access`

返回的 `namespaceAdmissions` 结构：

- `namespace`
- `enabled`
- `effective`
- `hasRole`
- `updatedAt`
- 以及内部可追踪字段 `source/grantedBy/updatedBy/createdAt`

- 自动收敛：
  - 平台管理员角色撤销接口
  - 委派角色撤销接口
  - 都会在撤销最后一个命名空间角色后自动关闭该 namespace admission

## 前端改动

- `apps/web/src/views/UserManagementView.vue`
  - 平台管理员可看到“钉钉登录”和“插件使用”两个独立层次。
  - 展示 namespace admission，并直接开关。

- `apps/web/src/views/RoleDelegationView.vue`
  - 插件管理员在委派视图中可查看并修改自己命名空间下成员的 admission。

## 运维与迁移

### 数据库迁移

执行常规迁移即可：

```bash
pnpm --filter @metasheet/core-backend migrate
```

### 历史 secret 加密脚本

对已经存在的目录/考勤集成明文 `appSecret` 做一次性重写：

```bash
pnpm --filter @metasheet/core-backend exec tsx scripts/encrypt-dingtalk-integration-secrets.ts
```

### 关键环境变量

- `ENCRYPTION_KEY`
- `ENCRYPTION_SALT`
- `DINGTALK_ALLOWED_CORP_IDS`
- `DINGTALK_CLIENT_ID`
- `DINGTALK_CLIENT_SECRET`
- `DINGTALK_REDIRECT_URI`
- `DINGTALK_CORP_ID`

## 风险与边界

- 如果历史环境没有 `role_permissions`，命名空间识别会退化，需先保证 RBAC 元数据完整。
- 钉钉 OAuth 当前用户接口不返回 corpId，因此 OAuth 登录阶段只能校验服务端配置的 corpId，而不能对回调用户逐人比对 corpId。
- 考勤集成要想启用 allowlist，配置里需要带 `corpId`，否则在启用 allowlist 时会被拒绝。
