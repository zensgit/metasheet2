# 无邮箱用户闭环总包开发说明 2026-04-19

## 目标

将“无邮箱用户闭环”收口成一个可合并切片，覆盖：

- 平台管理员手动创建无邮箱用户
- 钉钉目录手动准入创建无邮箱用户并绑定
- 登录页支持统一账号标识登录
- 无邮箱用户走临时密码 + 首登强制改密
- 钉钉目录自动准入命中的无邮箱成员返回临时凭据包

## 包含能力

### 账号标识与登录

- 登录页从 `email` 改为统一 `identifier`
- 支持：
  - 邮箱
  - 用户名
  - 手机号
- 后端登录匹配新增 `getUserByIdentifier()`
- 手机号冲突匹配保持保守：歧义时不自动登录

### 用户创建

- `users.email` 改为可空
- 新增 `users.username`
- 管理员创建用户时：
  - `name` 必填
  - `email / username / mobile` 至少一项存在
- 无邮箱用户不再强依赖邀请链接

### 钉钉手动准入

- 目录治理页手动准入表单新增 `username`
- 可创建无邮箱本地用户并立即绑定目录成员
- 结果卡片显示：
  - 登录账号
  - 临时密码
  - onboarding 文案

### 钉钉自动准入

- 白名单部门自动准入命中的无邮箱成员，不再直接跳过
- 后端会：
  - 自动生成稳定用户名
  - 生成临时密码
  - 创建本地用户
  - 强制首登改密
  - 返回 `autoAdmissionOnboardingPackets`
- 前端同步完成后会展示“本次自动准入临时凭据”

## 关键实现

### 数据模型

- `packages/core-backend/src/db/types.ts`
- `packages/core-backend/src/db/migrations/zzzz20260418170000_allow_no_email_users_and_add_username.ts`

### 登录与认证

- `packages/core-backend/src/auth/AuthService.ts`
- `packages/core-backend/src/routes/auth.ts`
- `apps/web/src/views/LoginView.vue`

### 用户管理

- `packages/core-backend/src/routes/admin-users.ts`
- `apps/web/src/views/UserManagementView.vue`

### 钉钉目录治理

- `packages/core-backend/src/routes/admin-directory.ts`
- `packages/core-backend/src/directory/directory-sync.ts`
- `apps/web/src/views/DirectoryManagementView.vue`

## 风险控制

- 有邮箱场景仍然走既有 invite token / invite ledger
- 无邮箱场景只返回临时密码和 onboarding 文案，不伪造邀请链接
- 自动准入用户名生成可重复、可预测，但仍经过用户名规则校验
- 本轮不引入新通知通道，不自动发送短信/钉钉消息

## 范围外

- 手机验证码登录
- 工号单独认证策略
- 自动短信/钉钉消息下发初始凭据
- 更细的账号恢复流程

## 部署影响

- 需要执行数据库迁移：
  - `zzzz20260418170000_allow_no_email_users_and_add_username.ts`
- 本轮未做远端部署
