# DingTalk Ops Hardening Repair-2 Claude Verification Template

日期：2026-03-30

## 用法

这份文档给 Codex 在 Claude Code 完成 `dingtalk-ops-hardening-repair2` 后做独立验收时使用。

真相源：

- `docs/development/dingtalk-ops-hardening-verification-20260330.md`
- `docs/development/dingtalk-ops-hardening-repair2-claude-task-pack-20260330.md`

## 必核项

### 1. 写边界

- 是否只改了以下路径：
  - `packages/openapi/src/admin-directory.yml`
  - `docs/development/dingtalk-ops-hardening-design-20260330.md`
  - `docs/development/dingtalk-ops-hardening-verification-20260330.md`
  - `docs/verification-index.md`
- 是否完全未改运行时代码

### 2. `/api/admin/users/batch` 契约一致性

必须直接对照：

- 运行时代码：
  - `packages/core-backend/src/routes/admin-users.ts`
- OpenAPI：
  - `packages/openapi/src/admin-directory.yml`

验收点：

- OpenAPI 不再声明 `data.action`
- OpenAPI 不再声明 `data.total`
- OpenAPI 不再声明 `data.results[].success`
- OpenAPI 与真实返回的 `processed / failed / results[].status` 一致

### 3. 设计文档残留清理

必须确认下列旧描述已被修掉：

- `rolled_back = TRUE`
- `保持现有回调处理逻辑`

### 4. 验证文档真实回填

必须明确写出：

- 本轮为 micro repair
- 本轮未修改运行时代码
- 本轮只修了 OpenAPI / 设计文档 / 验证文档
- 本轮通过或不通过

### 5. 命令

独立复跑：

```bash
node scripts/openapi-check.mjs
```

## 通过标准

只有同时满足以下条件才可判通过：

1. 完全未改运行时代码
2. `/api/admin/users/batch` OpenAPI 与真实后端一致
3. 设计文档不再残留旧逻辑
4. 验证文档已真实回填
5. `node scripts/openapi-check.mjs` 通过
