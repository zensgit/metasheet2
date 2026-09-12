# admin 安全开关与 bulk 写/删补 `requireAdminRole` —— 验证记录（2026-09-12）

设计说明见 `docs/development/admin-safety-toggle-require-admin-design-20260912.md`。

- 分支：`fix/admin-safety-toggle-and-bulk-require-admin`（基线 `origin/main` @ `1e98d9d3f`）
- 被测面：真实 express app，`app.use('/api/admin', initAdminRoutes({}))`，
  前置中间件把 `req.user` 设成**已认证但非 admin**（`{ id: 'u-non-admin' }`）。
- 替身：`rbac/service` 的 `isAdmin` mock（非 admin 用例恒 false）；`db/pg` 的 `pool: null`；
  `db/kysely` 的 `db` 用 Proxy 包住，`updateTable` / `deleteFrom` 是 spy，其余方法降级成惰性链。
  `SnapshotService` / `audit/audit` mock 掉，避免 import 期 `new AuditRepository(pool!)` 直接抛。
- 每个用例 `initSafetyGuard({ enabled: true })` 重建单例（`initSafetyGuard` 会
  `destroy()` 旧实例再 new，否则 `/safety/disable` 的用例会跨用例污染）。
- spec：`packages/core-backend/tests/unit/admin-safety-toggle-and-bulk-authz.test.ts`

---

## 1. 修前基线（原样输出）

用一次性探针（跑完即删，未提交）打在**未修改的** `origin/main` 代码上，全部以非 admin 身份发起：

```
### POST /api/admin/safety/enable  [非 admin]
HTTP 200
{
  "success": true,
  "message": "SafetyGuard enabled"
}

### POST /api/admin/safety/disable [非 admin]
HTTP 200
{
  "success": true,
  "message": "SafetyGuard disabled",
  "warning": "Safety checks are now bypassed"
}

>>> disable 之后 getSafetyGuard().isEnabled() = false

### PUT /api/admin/data/bulk       [非 admin, guard enabled]
HTTP 403
{
  "error": "SafetyCheck",
  "code": "SAFETY_CHECK_REQUIRED",
  "message": "Operation requires confirmation",
  "assessment": {
    "riskLevel": "high",
    "requiresConfirmation": true,
    "requiresDoubleConfirm": false,
    "riskDescription": "This will modify multiple records at once",
    "safeguards": [
      "Create a snapshot before proceeding",
      "Verify the affected records"
    ],
    "impact": {
      "scope": "batch",
      "reversible": true,
      "estimatedDuration": "Varies based on record count"
    }
  },
  "confirmation": {
    "token": "sfg_<redacted>",
    "expiresAt": "2026-09-12T02:47:46.828Z",
    "instructions": "First POST /api/admin/safety/confirm with { token, acknowledged: true }, then retry this operation with the same token in the X-Safety-Token header."
  }
}

### DELETE /api/admin/data/bulk    [非 admin, guard enabled]
HTTP 403
{
  "error": "SafetyCheck",
  "code": "SAFETY_CHECK_REQUIRED",
  "message": "Operation requires confirmation",
  "assessment": {
    "riskLevel": "high",
    "requiresConfirmation": true,
    "requiresDoubleConfirm": false,
    "riskDescription": "This will permanently delete selected data",
    "safeguards": [
      "Create a snapshot before proceeding",
      "Verify the affected records"
    ],
    "impact": {
      "scope": "single",
      "reversible": false
    }
  },
  "confirmation": {
    "token": "sfg_<redacted>",
    "expiresAt": "2026-09-12T02:47:46.831Z",
    "instructions": "First POST /api/admin/safety/confirm with { token, acknowledged: true }, then retry this operation with the same token in the X-Safety-Token header."
  }
}
```

（两枚 `sfg_...` 令牌在原始输出里是完整的 64 位十六进制串，此处按「日志/文档里不留可复用凭据」的
要求打码；令牌本身仅 300 秒有效且绑定 initiator/operation/resource。）

### 1.1 整链复现（**核心证据**）：非 admin 关掉确认层 → bulk 写/删直达数据库

```
### 整链 step1: POST /safety/disable
HTTP 200
{
  "success": true,
  "message": "SafetyGuard disabled",
  "warning": "Safety checks are now bypassed"
}

### 整链 step2: PUT /data/bulk
HTTP 200
{
  "success": true,
  "message": "Bulk update completed on table data_sources",
  "table": "data_sources",
  "updatedCount": 0,
  "estimatedCount": 1
}

### 整链 step3: DELETE /data/bulk
HTTP 200
{
  "success": true,
  "message": "Bulk deletion completed on table data_sources",
  "table": "data_sources",
  "deletedCount": 0,
  "estimatedCount": 1
}

>>> db.updateTable 调用次数 = 1, 参数 = [["data_sources"]]

>>> db.deleteFrom  调用次数 = 1, 参数 = [["data_sources"]]
```

`updatedCount` / `deletedCount` 是 0 只是因为替身链的 `execute()` 返回空数组；
关键是 **`db.updateTable('data_sources')` 与 `db.deleteFrom('data_sources')` 确实被调用了** ——
请求穿透了整条中间件链抵达真实的 kysely 写入口。

### 1.2 同文件其余「只靠确认层」的写端点（修前，非 admin）

```
--- POST /api/admin/cache/clear -> HTTP 403 code=SAFETY_CHECK_REQUIRED
--- POST /api/admin/metrics/reset -> HTTP 200 code=(none)
--- POST /api/admin/dlq/m-1/retry -> HTTP 403 code=SAFETY_CHECK_REQUIRED
--- DELETE /api/admin/dlq/m-1 -> HTTP 403 code=SAFETY_CHECK_REQUIRED
--- POST /api/admin/dlq/retry-all -> HTTP 403 code=SAFETY_CHECK_REQUIRED
--- POST /api/admin/dlq/cleanup -> HTTP 403 code=SAFETY_CHECK_REQUIRED
--- POST /api/admin/ratelimits/tenant-a/reset -> HTTP 200 code=(none)
--- POST /api/admin/ratelimits/reset-all -> HTTP 200 code=(none)
```

三条 `RESET_METRICS`（LOW）端点修前是 **200 直接执行**，与 `/safety/disable` 同构；
`403 SAFETY_CHECK_REQUIRED` 的那几条也只是「要一枚令牌」，不是「要 admin 身份」。

### 1.3 新 spec 打在未修改代码上 —— 先红

```
 Test Files  1 failed (1)
      Tests  14 failed | 4 passed (18)
```

任务点名的四条的实际断言失败原样：

```
FAIL … > 非 admin > POST /safety/disable → 403 ADMIN_REQUIRED，且确认层仍然开着
AssertionError: expected 200 to be 403 // Object.is equality
- Expected   - 403
+ Received   + 200

FAIL … > 非 admin > POST /safety/enable → 403 ADMIN_REQUIRED
AssertionError: expected 200 to be 403 // Object.is equality
- Expected   - 403
+ Received   + 200

FAIL … > 非 admin > PUT /data/bulk (data_sources) → 403 ADMIN_REQUIRED 且 updateTable 零调用
AssertionError: expected 'SAFETY_CHECK_REQUIRED' to be 'ADMIN_REQUIRED' // Object.is equality
- Expected   - ADMIN_REQUIRED
+ Received   + SAFETY_CHECK_REQUIRED

FAIL … > 非 admin > DELETE /data/bulk (data_sources) → 403 ADMIN_REQUIRED 且 deleteFrom 零调用
AssertionError: expected 'SAFETY_CHECK_REQUIRED' to be 'ADMIN_REQUIRED' // Object.is equality
- Expected   - ADMIN_REQUIRED
+ Received   + SAFETY_CHECK_REQUIRED
```

整链基线用例（保留，但断言已改成「修后必须两步都被挡」）修前也红：

```
FAIL … > 非 admin > 整链：先关确认层再 bulk 写 —— 两步都被授权门挡住，updateTable 零调用
AssertionError: expected 200 to be 403 // Object.is equality
```

fail-closed 用例修前红：

```
FAIL … > fail-closed > RBAC 抛错时 PUT /data/bulk 答 503 而不是放行
AssertionError: expected 403 to be 503 // Object.is equality
- Expected   - 503
+ Received   + 403
```

---

## 2. 修后 —— 全绿

```
$ npx vitest run tests/unit/admin-safety-toggle-and-bulk-authz.test.ts

 ✓ … > 非 admin > POST /safety/disable → 403 ADMIN_REQUIRED，且确认层仍然开着
 ✓ … > 非 admin > POST /safety/enable → 403 ADMIN_REQUIRED
 ✓ … > 非 admin > PUT /data/bulk (data_sources) → 403 ADMIN_REQUIRED 且 updateTable 零调用
 ✓ … > 非 admin > DELETE /data/bulk (data_sources) → 403 ADMIN_REQUIRED 且 deleteFrom 零调用
 ✓ … > 非 admin > 整链：先关确认层再 bulk 写 —— 两步都被授权门挡住，updateTable 零调用
 ✓ … > 非 admin > POST /cache/clear → 403 ADMIN_REQUIRED
 ✓ … > 非 admin > POST /metrics/reset → 403 ADMIN_REQUIRED
 ✓ … > 非 admin > POST /dlq/:id/retry → 403 ADMIN_REQUIRED
 ✓ … > 非 admin > DELETE /dlq/:id → 403 ADMIN_REQUIRED
 ✓ … > 非 admin > POST /dlq/retry-all → 403 ADMIN_REQUIRED
 ✓ … > 非 admin > POST /dlq/cleanup → 403 ADMIN_REQUIRED
 ✓ … > 非 admin > POST /ratelimits/:key/reset → 403 ADMIN_REQUIRED
 ✓ … > 非 admin > POST /ratelimits/reset-all → 403 ADMIN_REQUIRED
 ✓ … > admin —— 行为不变 > PUT /data/bulk 仍然是 403 SAFETY_CHECK_REQUIRED 并回确认令牌
 ✓ … > admin —— 行为不变 > DELETE /data/bulk 仍然是 403 SAFETY_CHECK_REQUIRED 并回确认令牌
 ✓ … > admin —— 行为不变 > POST /safety/disable 对 admin 仍然放行（LOW 风险、无需确认）
 ✓ … > admin —— 行为不变 > POST /safety/enable 对 admin 仍然放行
 ✓ … > fail-closed > RBAC 抛错时 PUT /data/bulk 答 503 而不是放行

 Test Files  1 passed (1)
      Tests  18 passed (18)
```

其中 **admin 行为不变** 的四条是关键的「没有顺手放宽」证据：admin 打 bulk 依旧
403 `SAFETY_CHECK_REQUIRED` + `assessment.riskLevel === 'high'` + 一枚令牌，
`updateTable` / `deleteFrom` 仍是零调用；`/safety/disable`、`/safety/enable` 对 admin 仍 200。

---

## 3. 变异自证（去掉守卫就红）

变异是**内存级**的：`admin-routes.ts` 源文件全程没有被改动过。做法是生成一份 spec 的一次性副本，
在 `beforeAll` 里从 express 的 **module-singleton router** 上把某一条路由的
**第一个** handler（也就是刚加的 `requireAdminRole()` 层）`splice(0, 1)` 掉，
跑完即删。测试名与真实 spec 完全一致，所以下面的红名单点的是真实用例。

```
================ MUTATION: disable ================
@@@W3G_MUTATION@@@ POST /safety/disable: handlers 3 -> 2
 × #5655 admin 安全开关与 bulk 写/删的授权门 > 非 admin > POST /safety/disable → 403 ADMIN_REQUIRED，且确认层仍然开着
 × #5655 admin 安全开关与 bulk 写/删的授权门 > 非 admin > 整链：先关确认层再 bulk 写 —— 两步都被授权门挡住，updateTable 零调用
 Test Files  1 failed (1)
      Tests  2 failed | 16 passed (18)

================ MUTATION: bulkput ================
@@@W3G_MUTATION@@@ PUT /data/bulk: handlers 3 -> 2
 × #5655 admin 安全开关与 bulk 写/删的授权门 > 非 admin > PUT /data/bulk (data_sources) → 403 ADMIN_REQUIRED 且 updateTable 零调用
 × #5655 admin 安全开关与 bulk 写/删的授权门 > 非 admin > 整链：先关确认层再 bulk 写 —— 两步都被授权门挡住，updateTable 零调用
 × #5655 admin 安全开关与 bulk 写/删的授权门 > fail-closed > RBAC 抛错时 PUT /data/bulk 答 503 而不是放行
 Test Files  1 failed (1)
      Tests  3 failed | 15 passed (18)

================ MUTATION: bulkdel ================
@@@W3G_MUTATION@@@ DELETE /data/bulk: handlers 3 -> 2
 × #5655 admin 安全开关与 bulk 写/删的授权门 > 非 admin > DELETE /data/bulk (data_sources) → 403 ADMIN_REQUIRED 且 deleteFrom 零调用
 Test Files  1 failed (1)
      Tests  1 failed | 17 passed (18)

================ MUTATION: enable ================
@@@W3G_MUTATION@@@ POST /safety/enable: handlers 2 -> 1
 × #5655 admin 安全开关与 bulk 写/删的授权门 > 非 admin > POST /safety/enable → 403 ADMIN_REQUIRED
 Test Files  1 failed (1)
      Tests  1 failed | 17 passed (18)
```

- 去掉 `/safety/disable` 的门 → **2 条红**（≥2，达标），且点名了整链用例。
- 去掉 `PUT /data/bulk` 的门 → **3 条红**（≥1，达标）。
- 去掉 `DELETE /data/bulk` / `POST /safety/enable` 的门 → 各 **1 条红**。
- `handlers N -> N-1` 这行证明确实摘掉了一层，且摘掉后剩下的仍是原来的
  `requireSafetyCheck` + 处理器（`/safety/enable` 本来就没有确认层，所以是 `2 -> 1`）。
- 还原：变异从不落盘，源文件无需还原；变异副本跑完即删，`ls tests/unit/w3g-mut-*` 为空。
  还原后的全绿即第 2 节的 18/18。

---

## 4. 相邻既有 spec

`grep -rl "admin-routes\|initAdminRoutes\|requireSafetyCheck" packages/core-backend/tests` 命中 9 个文件
（含本次新增的 spec 自身）：

| 文件 | 结果 |
|---|---|
| `tests/unit/admin-safety-confirm-authz.test.ts` | 绿 |
| `tests/unit/admin-safety-toggle-and-bulk-authz.test.ts`（新增） | 绿 |
| `tests/unit/admin-snapshot-delete-authz.test.ts` | 绿 |
| `tests/unit/admin-yjs-status-routes.test.ts` | 绿 |
| `tests/unit/safety-guard-confirm-flow.test.ts` | 绿 |
| `tests/unit/snapshot-labels-authz.test.ts` | 绿 |
| `tests/unit/snapshots-authz.test.ts` | 绿 |
| `tests/unit/snapshots-safety-guard.test.ts` | 绿 |
| `tests/integration/directory-binding-sync-hook.db.test.ts` | 不适用，见下 |

八个 unit spec 一次跑：

```
 Test Files  8 passed (8)
      Tests  65 passed (65)
   Duration  2.66s
```

`directory-binding-sync-hook.db.test.ts` 只是**注释里**提到了另一个文件名
（`directory-binding-admin-routes.db.test.ts`），与 `src/routes/admin-routes.ts` 无关；
且它被 `vitest.config.ts` 的 exclude 列表排除，在默认（无库）配置下显式指定也是
`No test files found, exiting with code 1`。

---

## 5. 类型检查

```
$ cd packages/core-backend && npx tsc --noEmit
=== tsc exit: 0 / error count: 0 ===
```

---

## 6. 新 spec 会被无库 CI 跑到

- `packages/core-backend/vitest.config.ts` **没有** `include` 键，走 vitest 默认
  （`**/*.{test,spec}.?(c|m)[jt]s?(x)`）。
- `exclude` 共 **395** 条字符串项，其中只有三条是 glob：`**/node_modules/**`、`**/dist/**`、
  `tests/e2e/**`；其余全部是逐个枚举的 `tests/integration/...` 文件名。
  **没有任何一条能匹配 `tests/unit/**`。**
- 无库 lane 跑的是 `pnpm --filter @metasheet/core-backend test:unit`
  = `vitest run tests/unit --reporter=dot`（`packages/core-backend/package.json:28`），
  新 spec 在 `tests/unit/` 下，必然被收集。
- **反证控制组**：vitest 的 exclude 在显式传入路径之后仍然生效 —— 拿一个确实被排除的文件验证：
  ```
  $ npx vitest run tests/integration/approval-directory-resolve.api.test.ts
  No test files found, exiting with code 1
  ```
  而新 spec 用同一份默认配置显式跑出了 18 个用例，因此它**不在** exclude 覆盖范围内。
- 没有碰 `vitest.integration.config.ts` / 任何 realdb 配置 / 任何 `.github/workflows/*`。

---

## 7. 边界自检

- 只在 worktree `metasheet-wt-w3g` 内改动；主检出与其他 `metasheet-*` 目录未触碰。
- 未执行 `git worktree remove/prune`、未 push、未 `git add -A`（只显式路径）。
- 未改 `.github/workflows/*`、未改任何 `*provenance-pins*`、未改 `plugins/`。
- 改动的两个代码文件都不在 `s6a-package-provenance-pins.json` 的 pin 清单里（已程序化核对），
  因此不需要重打 pin。
- 临时探针（`w3g-prefix-baseline.probe.test.ts`、`w3g-mut-*.test.ts`）跑完即删，未进入任何提交。
- 文档/日志/测试里不含真实主机、账号、口令；确认令牌已打码。
