# DingTalk Ops Hardening Repair Claude Verification Template

日期：2026-03-30

## 用法

这份文档给 Codex 在 Claude Code 完成 `dingtalk-ops-hardening-repair` 后做独立验收时使用。

真相源文档：

- `docs/development/dingtalk-ops-hardening-verification-20260330.md`
- `docs/development/dingtalk-ops-hardening-repair-claude-task-pack-20260330.md`

## 必核项

### 1. 写边界

- 是否只改了 repair task pack 允许路径
- 是否误碰 `scripts/ops/git-*`
- 是否误碰 attendance / workflow / kanban / snapshot 业务线
- 若改了入口文件，是否仅限：
  - `apps/web/src/main.ts`
  - `packages/core-backend/src/index.ts`

### 2. schema 对齐

- `directory_sync_status` 代码读写列、部署文档 DDL、测试假设是否一致
- `directory_sync_history` 代码读写列、部署文档 DDL、测试假设是否一致
- `deprovision_ledger` 代码读写列、部署文档 DDL、测试假设是否一致
- 是否仍依赖“schema error -> graceful fallback”掩盖断层

### 3. JSON shape 对齐

- 后端 `admin-directory` 路由真实返回 shape 是什么
- 前端 `DirectoryManagementView.vue` 是否读取同一 shape
- OpenAPI 是否描述同一 shape
- 单测 mock 是否覆盖真实 shape，而不是继续 mock 假 payload

### 4. DingTalk callback 闭环

- 若已实现后端 `POST /api/auth/dingtalk/callback`：
  - 路由是否真实存在
  - 前端是否命中它
  - 单测是否覆盖成功 / 失败路径
- 若未实现：
  - 前端是否已回退占位接线
  - 文档是否明确记录暂缓原因

禁止出现“前端调用一个不存在的后端接口”。

### 5. 构建与命令

独立复跑：

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-directory-routes.test.ts tests/unit/admin-users-routes.test.ts tests/unit/directory-sync.test.ts tests/unit/auth-login-routes.test.ts
pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts tests/dingtalkAuthCallbackView.spec.ts tests/sessionCenterView.spec.ts tests/userManagementView.spec.ts
pnpm --filter @metasheet/web exec vue-tsc --noEmit
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
node scripts/openapi-check.mjs
node scripts/dingtalk-directory-smoke.mjs --help
```

### 6. Web build 特判

只有在仍然出现这个原始错误时，才允许把 `web build` 记为预存失败：

```text
src/views/AttendanceView.vue(3394,59): error TS2307: Cannot find module '../utils/timezones'
```

如果错误文本变化，或叠加了新错误，本轮应判不通过。

## 通过标准

只有同时满足以下条件才可判通过：

1. repair 范围内无新的越界改动
2. 三张表 schema 在代码、DDL、测试中统一
3. 后端 / 前端 / OpenAPI 使用同一份返回 shape
4. DingTalk callback 已实现或已明确回退，不存在半接线
5. 独立复跑命令通过，或仅保留原始 AttendanceView 预存错误
6. 设计 / 验证 / 部署文档已真实回填，不再保留“待执行”

## 输出建议

Codex 最终验收建议包含：

- Findings first
- 每条 findings 带绝对文件路径
- 明确结论：通过 / 不通过
- 若不通过，下一轮只允许 repair，不允许扩功能
