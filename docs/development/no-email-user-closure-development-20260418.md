# 无邮箱用户闭环开发说明 2026-04-18

## 目标

补齐“没有邮箱的本地用户”闭环，覆盖以下链路：

- 管理员手动创建用户
- 钉钉目录手动准入创建用户并绑定
- 登录页使用统一账号标识登录
- 无邮箱用户依赖临时密码登录，并在首次交互后强制改密

本轮不改变自动准入的默认策略。自动准入仍然要求邮箱，因为当前没有安全、自动的临时密码分发通道。

## 方案

### 账号标识

- `users.email` 改为可空
- 新增 `users.username`
- 登录支持统一 `identifier`
  - 邮箱
  - 用户名
  - 手机号

### 创建与准入

- `/api/admin/users`
  - `email` 改为可选
  - 新增 `username`
  - 保持 `mobile` 可选
  - 约束改为：`name` 必填，且 `email / username / mobile` 至少一项存在
- `/api/admin/directory/accounts/:accountId/admit-user`
  - 同样支持无邮箱准入
  - 创建用户后仍会绑定 DingTalk identity / directory link
  - 无邮箱时不生成 invite token，不写 invite ledger

### Onboarding

- onboarding packet 新增 `accountLabel`
- 邀请文案不再强依赖邮箱
- 无邮箱用户场景下：
  - 有临时密码
  - 无邀请链接
  - 由管理员线下分发初始凭据

## 核心改动

### 后端

- `packages/core-backend/src/db/types.ts`
  - `users.email` 变为 `string | null`
  - 新增 `users.username`
- `packages/core-backend/src/db/migrations/zzzz20260418170000_allow_no_email_users_and_add_username.ts`
  - 放开 `users.email` 的非空约束
  - 新增 `username`
  - 新增 `lower(username)` 唯一索引
- `packages/core-backend/src/auth/AuthService.ts`
  - 登录改为 `getUserByIdentifier()`
  - 支持邮箱 / 用户名 / 手机号
- `packages/core-backend/src/routes/auth.ts`
  - `/login` 接收 `identifier`
  - 登录限流也按 `identifier` 计数
- `packages/core-backend/src/routes/admin-users.ts`
  - 手动创建用户支持无邮箱
  - 新增用户名校验与唯一性校验
  - 无邮箱用户跳过 invite token / invite ledger
- `packages/core-backend/src/routes/admin-directory.ts`
  - 目录手动准入路由透传 `username`
- `packages/core-backend/src/directory/directory-sync.ts`
  - 目录手动准入服务支持无邮箱创建
  - 本地用户匹配支持用户名 / 手机号
  - 目录账户摘要、推荐绑定、已链接用户摘要补齐 `username`
- `packages/core-backend/src/auth/access-presets.ts`
  - onboarding packet 新增 `accountLabel`

### 前端

- `apps/web/src/views/LoginView.vue`
  - 登录页输入改为统一账号标识
- `apps/web/src/views/UserManagementView.vue`
  - 创建用户表单新增 `username`
  - `email` 改为可选
  - 列表与详情优先显示 `email -> username -> mobile -> id`
- `apps/web/src/views/DirectoryManagementView.vue`
  - 手动准入表单新增 `username`
  - 校验改为“姓名必填 + 至少一个账号标识”
  - 结果面板支持显示无邮箱用户的登录账号

## 范围外

- 自动准入的“无邮箱自动建人”
- 邀请链接之外的新通知通道
- 手机号验证码登录
- 工号单独登录策略

## 部署影响

- 需要执行数据库迁移：
  - `zzzz20260418170000_allow_no_email_users_and_add_username.ts`
- 本轮未做远端部署

## Rebase 收口 - 2026-04-21

- 将 PR #916 分支 rebase 到 `origin/main`，基线为 `d0b5883b4`。
- 解决 `packages/core-backend/src/directory/directory-sync.ts` 与后续 DingTalk hardening 的重叠冲突。
- 保留的合并语义：
  - 无邮箱自动准入继续生成稳定 `dt_*` username。
  - 手机号匹配继续使用 `normalizeMobileIdentifier()` 去空白后比较。
  - 自动准入创建用户时传入 `generatedUsername`，避免无邮箱账号落成无登录标识。
  - onboarding packet 保留 `accountLabel` 和临时密码信息。
- `feat(directory): return no-email auto-admission onboarding packets` 在 rebase 时被 Git 判定为 patch contents already upstream，未重复应用。
