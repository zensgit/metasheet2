# DingTalk Ops Hardening Verification

日期：2026-03-30（repair slice 更新）

## 范围

验证 DingTalk 运营硬化 repair slice 是否修复了以下阻塞：

1. 运行时代码、部署 DDL、文档 schema 统一到同一套
2. 后端 JSON shape、前端读取 shape、OpenAPI shape 统一到同一套
3. DingTalk callback 前后端闭环（已回退为暂缓占位）
4. 写边界显式且无越界

## 计划命令

```bash
# 后端单测
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-directory-routes.test.ts tests/unit/admin-users-routes.test.ts tests/unit/directory-sync.test.ts tests/unit/auth-login-routes.test.ts

# 前端单测
pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts tests/dingtalkAuthCallbackView.spec.ts tests/sessionCenterView.spec.ts tests/userManagementView.spec.ts

# 前端类型检查
pnpm --filter @metasheet/web exec vue-tsc --noEmit

# 后端构建
pnpm --filter @metasheet/core-backend build

# 前端构建
pnpm --filter @metasheet/web build

# OpenAPI 校验
node scripts/openapi-check.mjs

# Smoke 脚本帮助
node scripts/dingtalk-directory-smoke.mjs --help
```

## Canonical Schema 决策

运行时代码为唯一事实源，DDL 和文档统一到代码实际读写的列名。

### directory_sync_status

| 列 | 类型 | 说明 |
|----|------|------|
| id | TEXT PK | 默认 'singleton' |
| last_sync_at | TIMESTAMPTZ | 最近同步时间 |
| next_sync_at | TIMESTAMPTZ | 下次同步时间 |
| status | TEXT | idle / running / failed / completed |
| has_alert | BOOLEAN | 是否有未确认告警 |
| alert_message | TEXT | 告警消息 |
| alert_acknowledged_at | TIMESTAMPTZ | 确认时间 |
| alert_acknowledged_by | TEXT | 确认人 |

### directory_sync_history

| 列 | 类型 | 说明 |
|----|------|------|
| id | SERIAL PK | 自增 |
| status | TEXT | idle / running / failed / completed |
| message | TEXT | 消息/错误原因 |
| synced_count | INTEGER | 同步成功数 |
| failed_count | INTEGER | 同步失败数 |
| created_at | TIMESTAMPTZ | 创建时间 |

### deprovision_ledger

| 列 | 类型 | 说明 |
|----|------|------|
| id | TEXT PK | UUID |
| target_user_id | TEXT | 被脱管用户 |
| performed_by | TEXT | 操作人 |
| reason | TEXT | 原因 |
| user_snapshot | JSONB | 操作前快照 |
| status | TEXT | executed / rolled-back |
| rolled_back_by | TEXT | 回滚人 |
| rolled_back_at | TIMESTAMPTZ | 回滚时间 |
| created_at | TIMESTAMPTZ | 创建时间 |
| updated_at | TIMESTAMPTZ | 更新时间 |

## Canonical JSON Shape 决策

与 admin-users.ts 的既有列表模式一致：

- 列表端点：`{ ok: true, data: { items: [...], page, pageSize, total } }`
- 单项端点：`{ ok: true, data: { ...camelCase fields } }`
- 状态端点：`{ ok: true, data: { lastSyncAt, nextSyncAt, status, hasAlert, alertMessage, ... } }`

字段全部使用 camelCase。后端 service 层 `mapStatusRow` / `mapHistoryRow` / `mapRow` 负责 snake_case → camelCase 转换。

## DingTalk Callback 处理方式

**回退**。前端 `DingTalkAuthCallbackView.vue` 不再调用 `POST /api/auth/dingtalk/callback`，改为静态展示"钉钉登录功能尚未开放"并提供"返回登录"按钮。路由保留，后端接口待后续 slice 补齐。

## 实际结果

### 1. 后端单测

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-directory-routes.test.ts tests/unit/admin-users-routes.test.ts tests/unit/directory-sync.test.ts tests/unit/auth-login-routes.test.ts`
  - 结果：通过
  - 实际结果：`4 files / 114 tests passed`

### 2. 前端单测

- `pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts tests/dingtalkAuthCallbackView.spec.ts tests/sessionCenterView.spec.ts tests/userManagementView.spec.ts`
  - 结果：通过
  - 实际结果：`4 files / 35 tests passed`

### 3. 类型检查与构建

- `pnpm --filter @metasheet/web exec vue-tsc --noEmit`
  - 结果：通过
- `pnpm --filter @metasheet/core-backend build`
  - 结果：通过
- `pnpm --filter @metasheet/web build`
  - 结果：失败
  - 实际错误：`src/views/AttendanceView.vue(3394,59): error TS2307: Cannot find module '../utils/timezones' or its corresponding type declarations.`
  - 结论：仍然是同一条预存错误，本轮未引入新增 build 错误

### 4. OpenAPI 与 smoke

- `node scripts/openapi-check.mjs`
  - 结果：通过
  - 实际输出：`Files checked: 3 / Total paths: 32 / Issues found: 0 / PASSED`
- `node scripts/dingtalk-directory-smoke.mjs --help`
  - 结果：通过
  - 实际输出：帮助信息正常打印，覆盖 `sync/status`、`sync/history`、`deprovisions`

## 写边界检查

本轮修改文件：

- `packages/core-backend/src/routes/admin-directory.ts` — 在允许范围
- `apps/web/src/views/DirectoryManagementView.vue` — 在允许范围
- `apps/web/src/views/DingTalkAuthCallbackView.vue` — 在允许范围
- `apps/web/tests/directoryManagementView.spec.ts` — 在允许范围
- `apps/web/tests/dingtalkAuthCallbackView.spec.ts` — 在允许范围
- `packages/core-backend/tests/unit/admin-directory-routes.test.ts` — 在允许范围
- `packages/openapi/src/admin-directory.yml` — 在允许范围
- `docs/deployment/dingtalk-ops-hardening-deploy-20260330.md` — 在允许范围
- `docs/development/dingtalk-ops-hardening-design-20260330.md` — 在允许范围
- `docs/development/dingtalk-ops-hardening-verification-20260330.md` — 在允许范围

未修改禁止列表中的任何文件。

## 独立验收发现

### 1. 仍未通过：`/api/admin/users/batch` 的 OpenAPI 契约与真实后端返回值仍不一致

- OpenAPI 描述：
  - [`packages/openapi/src/admin-directory.yml`](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/src/admin-directory.yml#L394)
  - 当前写的是：
    - `data.action`
    - `data.total`
    - `data.results[].success`
- 真实后端路由：
  - [`packages/core-backend/src/routes/admin-users.ts`](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/admin-users.ts#L1317)
  - 当前真实返回的是：
    - `data.processed`
    - `data.failed`
    - `data.results[].status`
    - 没有 `data.action`
    - 没有 `data.total`
    - 没有 `data.results[].success`

结论：repair slice 虽然修正了 admin directory 这组接口的 shape，但被同一份 OpenAPI 文件里的 `/api/admin/users/batch` 再次拉回了“契约未完全统一”的状态。按 repair task pack 的通过标准，这一项不能算通过。

### 2. 仍未通过：设计文档没有完全跟随 repair 实现更新

- 设计文档仍写：
  - `deprovision_ledger` 标记 `rolled_back = TRUE`
  - `DingTalkAuthCallbackView` 保持现有回调处理逻辑
- 证据：
  - [`docs/development/dingtalk-ops-hardening-design-20260330.md`](/Users/huazhou/Downloads/Github/metasheet2/docs/development/dingtalk-ops-hardening-design-20260330.md#L138)
  - [`docs/development/dingtalk-ops-hardening-design-20260330.md`](/Users/huazhou/Downloads/Github/metasheet2/docs/development/dingtalk-ops-hardening-design-20260330.md#L167)

结论：设计文档仍残留上一轮逻辑，未完全反映 repair slice 的真实决策。

### 3. 仍未通过：验证文档交付时没有真实回填

- repair 交付时本文件仍保留：
  - `（待执行后回填）`
- 证据：
  - [`docs/development/dingtalk-ops-hardening-verification-20260330.md`](/Users/huazhou/Downloads/Github/metasheet2/docs/development/dingtalk-ops-hardening-verification-20260330.md#L96)

结论：这份 verification 是在 Codex 独立验收时才补成真实结果，因此不能把 Claude 原始交付视为“文档已真实回填”。

## 本轮结论

结论：不通过。

已修复项：

- admin directory 核心接口的 schema / DDL 已基本统一
- `DirectoryManagementView.vue` 已切换到 camelCase + `data.items`
- `DingTalkAuthCallbackView.vue` 已回退为暂缓占位，不再调用不存在的后端接口
- 既定定向测试、`vue-tsc`、backend build、OpenAPI check、smoke help 全部通过

阻塞项：

1. `/api/admin/users/batch` 的 OpenAPI 仍与真实后端路由不一致
2. 设计文档未完整反映 repair 实现
3. 验证文档在 Claude 交付时未真实回填

建议：

- 下一轮仍然只做 repair，不扩功能
- 只修：
  1. `admin-directory.yml` 中 `/api/admin/users/batch` 与 `admin-users.ts` 的契约一致性
  2. `dingtalk-ops-hardening-design-20260330.md` 的残留旧描述
  3. 交付时必须真实回填 verification，不允许保留占位文本

---

## Repair-2 Micro Slice

日期：2026-03-30

### 范围

本轮为 micro repair，不改运行时代码，只对齐 OpenAPI 和文档。

### 修复内容

#### 1. `/api/admin/users/batch` OpenAPI 对齐

运行时真实返回值（`admin-users.ts:1371`）：

```json
{
  "ok": true,
  "data": {
    "processed": 3,
    "failed": 0,
    "results": [
      { "userId": "u-1", "status": "ok" },
      { "userId": "u-2", "status": "ok" },
      { "userId": "u-3", "status": "ok" }
    ]
  }
}
```

OpenAPI 修复：

- 删除 `data.action`（运行时不返回）
- 删除 `data.total`（运行时不返回）
- `data.results[].success` → `data.results[].status`（枚举 `ok | error`）

#### 2. 设计文档残留清理

| 原文 | 修正 |
|------|------|
| `deprovision_ledger` 标记 `rolled_back = TRUE` | `status` 从 `'executed'` 更新为 `'rolled-back'` |
| `DingTalkAuthCallbackView` 保持现有回调处理逻辑 | 已回退为暂缓占位，不调用后端 API |
| `audit_log` 记录 `action: deprovision_rollback` | `action: directory.deprovision.rollback` |
| `metadata: { batchSize, reason, batchId }` + 共享 batchId | `metadata: { action, reason, batchSize }` |
| 显示告警等级（黄色 warning、红色 critical） | 显示 `hasAlert` boolean |
| `action: sync_alert_acknowledge` / `metadata: { alertLevel, note }` | `action: directory.sync.acknowledge` / `metadata: { acknowledgedBy }` |

#### 3. 验证文档回填

本节即为 repair-2 回填。

### 实际结果

- `node scripts/openapi-check.mjs`：通过（Files checked: 3 / Total paths: 32 / Issues found: 0 / PASSED）
- 本轮未改运行时代码：是
- OpenAPI 已与 `/api/admin/users/batch` 真实返回值对齐：是
- 设计文档残留已清理：是

### Codex 独立验收

- `node scripts/openapi-check.mjs`：通过
- 运行时代码未新增改动：确认
- `/api/admin/users/batch` OpenAPI 与 `packages/core-backend/src/routes/admin-users.ts` 当前真实返回值一致：确认
- 设计文档残留旧描述已清理：确认
- 验证文档 repair-2 段落已真实回填：确认

### Repair-2 结论

结论：通过。

剩余风险不属于本轮 micro repair 范围：

1. `pnpm --filter @metasheet/web build` 仍有预存 `AttendanceView.vue -> ../utils/timezones` 错误
2. DingTalk OAuth 后端回调接口仍未实现，当前仍是占位回退状态
3. 目标环境数据库仍需按部署文档执行 DDL
