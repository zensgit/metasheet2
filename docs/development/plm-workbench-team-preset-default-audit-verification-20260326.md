# PLM Workbench Team Preset Default Audit Parity Verification

## Scope

验证 `team preset default audit parity` 是否完整闭环：

- 后端 `set-default / clear-default` 是否落审计
- `plm-team-preset-default` 是否能通过前端 client / route / saved views
- `lastDefaultSetAt` 是否能从默认审计回灌到 preset 响应

## Focused Verification

### Frontend

命令：

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmWorkbenchClient.spec.ts tests/plmAuditQueryState.spec.ts tests/plmAuditSavedViews.spec.ts
```

结果：

- `3` 个文件
- `42` 个测试通过
- 覆盖了：
  - audit log client 接受 `plm-team-preset-default`
  - audit summary buckets 保留该资源类型
  - route query 解析接受该资源类型
  - audit saved views round-trip 该资源类型

### Backend

命令：

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend
pnpm exec vitest run tests/unit/plm-workbench-routes.test.ts
```

结果：

- `1` 个文件
- `36` 个测试通过
- 新增锁定：
  - `team preset set-default` 写入 `operation_audit_logs`
  - `team preset clear-default` 写入 `operation_audit_logs`
  - preset 默认路由响应带 `lastDefaultSetAt`
  - archived preset `set-default` 返回 `409`

### Type-check

命令：

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

结果：

- 通过

## Full Verification

### Frontend full suite

命令：

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

预期：

- `plm-team-preset-default` 新资源类型不会破坏既有 collaborative audit 解析
- 现有 audit / workbench / preset / team-view 流程继续全绿

### Backend build

命令：

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/packages/core-backend
pnpm build
```

预期：

- 新增 audit helper、resource type、signal hydration 不引入类型或构建回归

## Outcome

本次修复后：

- `team preset` 默认切换终于进入独立审计链
- `PLM Audit` 能按资源类型筛出这类变更
- preset 默认响应具备与 team view default 一致的默认时间信号
