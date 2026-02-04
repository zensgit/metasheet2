# 管理员登录修复 - 开发记录

日期：2026-02-04

## 目标
- 恢复 `admin@metasheet.app` 账号登录能力，确保 `/api/auth/login` 可用。

## 处理内容
- 通过数据库更新 `users.password_hash` 为新的 bcrypt hash。
- 保持现有用户 ID 与权限不变，仅修复凭据字段。

## 影响范围
- 仅影响管理员账号登录凭据。
- 不影响其他业务数据与 API 行为。

## 相关操作
- DB 容器：`metasheet-postgres`
- 表：`users`
- 字段：`password_hash`
