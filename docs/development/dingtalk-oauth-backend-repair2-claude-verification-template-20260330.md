# DingTalk OAuth Backend Repair-2 Claude Verification Template

日期：2026-03-30

## 用法

这份文档给 Codex 在 Claude Code 执行完成后做最后一轮独立验收时使用。

## 必核项

### 1. 写边界

- 是否只改了：
  - [auth.yml](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/src/paths/auth.yml)
  - [dingtalk-oauth-backend-verification-20260330.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/dingtalk-oauth-backend-verification-20260330.md)
  - [verification-index.md](/Users/huazhou/Downloads/Github/metasheet2/docs/verification-index.md)

### 2. OpenAPI 契约

- `/api/auth/dingtalk/callback` 是否改成 `required: [code, state]`
- `400` 是否不再只写 missing code
- `400` 是否覆盖：
  - missing code
  - missing state
  - invalid / unknown state
  - expired state

### 3. 文档回填

- 验证文档是否写清本轮 repair-2 修了什么
- 是否写清当前 blocker 已关闭

### 4. 独立复跑命令

```bash
node scripts/openapi-check.mjs
```
