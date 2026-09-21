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
- 无库 lane 跑的是 `pnpm --filter @metasheet/core-backend test`（`.github/workflows/plugin-tests.yml`
  「Run core-backend tests」步骤）= `vitest`（`packages/core-backend/package.json:26`）：无 include 限制、
  exclude 不含 `tests/unit`，新 spec 必然被收集。`test:unit`（`package.json:28`）存在但没有任何工作流调用它。
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

---

## 8. 2026-09-20 / 09-21：追平 main 后的复跑与复核

- worktree：`metasheet-wt-w8k`（本轮），不是 09-12 那个 `metasheet-wt-w3g`。
- 起点 `3c79b2059` → `git rebase origin/main`（当时 `36d659c8a`）**无冲突**，三个 commit 原样重放；
  `admin-routes.ts` 的 diff 与 rebase 前逐字相同（`83 ++-`，无一行被 rebase 改写）。
- 复核期间 main 又并入 #5914 / #5916，于是**再 rebase 一次**到 `ce9ac29cb`，同样无冲突，
  代码 diff 仍是逐字相同的 `83 ++-`。
- 2026-09-21 会话续跑：main 已走到 `5edf4c3e1`，其间只有 #5903 动过 `admin-routes.ts`
  （读侧 GET 的 500 分支改调新的 `sendAdminReadFailure`，并在 `:73` 上方新增一段模块级辅助函数）。
  分支此时已推过远端，改用 `git merge origin/main` 追平，**无冲突**；`git diff --stat origin/main HEAD`
  仍是 `admin-routes.ts | 83 ++-`，12 处门一行未动。
  **本节以下全部证据都是在追平 `5edf4c3e1` 之后的合并结果上重跑的**，行号也按它订正
  （#5903 让 `:73` 以下整体 +58，又在若干 `catch` 体里各减几行，所以不是一个统一偏移）。
- 本节新增的东西只有一个：spec 里补了一条**闭世界**用例（设计文档 §5.5）。

### 8.1 spec 复跑 —— 全绿（18 → 25）

```
$ npx vitest run tests/unit/admin-safety-toggle-and-bulk-authz.test.ts --reporter=dot
 Test Files  1 passed (1)
      Tests  25 passed (25)
```

原有 18 条一条不改、全部仍绿；新增 7 条来自闭世界那一节（4 条识别器正反自证 + 1 条防空转绿 +
1 条闭世界主张 + 1 条「豁免表里没有已不存在的路由」）。

spec 仍然用 `usePinnedServer()` + `request(pinned.url())`，**没有**任何 `request(app)`
（`tests/unit` 里 `request(app)` 会让 CI test 泳道整条红）。

### 8.2 闭世界用例的两条独立口径互相印证

**口径 A（运行时，spec 内）**：从 `initAdminRoutes({})` 返回的 module-singleton router 上取
`router.stack`，收根路由的写方法，比对首位 handler 的 `toString()` 与 `requireAdminRole()` 的。
结果：violations = `[]`。

**口径 B（静态，一次性脚本，跑完即删）**：直接扫 `admin-routes.ts` 的
`router.<method>(` 注册文本，看紧跟路径的第一个 token。结果：

```
== root writes: 25 ==   (GATED 22 / OPEN 3)
OPEN   :834  POST /plugins/reload-all-unsafe
OPEN   :885  POST /plugins/:id/reload-unsafe
OPEN   :2347 POST /health/check

== root reads ungated ==
(read total=16, ungated=0)
```

两条口径给出的「无门写路由」集合完全一致，且恰等于豁免表那三条。口径 B 同时给出读侧的
当前状态：16 条根 GET **全部有门**，无门数 = 0（`GET /slo/status` 最后一条由 #5914 补上，
见设计文档 §5.4）。

同一个静态脚本对着 `origin/main`（`5edf4c3e1`）的 `admin-routes.ts` 跑一遍作为**修前对照**：
`root writes: 25 (GATED 10 / OPEN 15)` —— 15 条无门写路由 = 豁免那 3 条 + 本 PR 补门的 12 条，
其中 12 条的首位实测都是 `requireSafetyCheck({`（`/safety/enable` 是裸 handler）。
本 PR 把无门写路由从 15 降到 3，且降下去的那 12 条与设计 §2 的表逐条对得上。

### 8.3 变异自证 —— 12 条门逐条，内存级

做法：在 spec 之外跑一份一次性探针（`tests/unit/w8k-mutation-probe.test.ts`，跑完即删、未提交）。
它 **不改任何源文件**：import 回 router 对象后，把某一条路由 `route.stack` 里那个 handler 的
`.handle` 就地换成 passthrough，断言完在 `finally` 里还原。落盘变异一次都没有做过。

每条断言两件事：①闭世界审计把这条路由点名为 violation（⇒ 闭世界用例会红）；
②该端点不再答 `403 ADMIN_REQUIRED`（⇒ 对应的行为用例会红）。下面是变异后实际拿到的响应：

| 被换掉门的路由 | 变异后响应 | 闭世界点名 |
|---|---|---|
| POST `/safety/enable` | **200** `success:true` | ✓ |
| POST `/safety/disable` | **200** `success:true` | ✓ |
| POST `/cache/clear` | 403 `SAFETY_CHECK_REQUIRED` | ✓ |
| POST `/metrics/reset` | **200** `success:true` | ✓ |
| PUT `/data/bulk` | 403 `SAFETY_CHECK_REQUIRED` | ✓ |
| DELETE `/data/bulk` | 403 `SAFETY_CHECK_REQUIRED` | ✓ |
| POST `/dlq/:id/retry` | 403 `SAFETY_CHECK_REQUIRED` | ✓ |
| DELETE `/dlq/:id` | 403 `SAFETY_CHECK_REQUIRED` | ✓ |
| POST `/dlq/retry-all` | 403 `SAFETY_CHECK_REQUIRED` | ✓ |
| POST `/dlq/cleanup` | 403 `SAFETY_CHECK_REQUIRED` | ✓ |
| POST `/ratelimits/:key/reset` | **200** `success:true` | ✓ |
| POST `/ratelimits/reset-all` | **200** `success:true` | ✓ |

```
 Test Files  1 passed (1)
      Tests  14 passed (14)
```

（14 = 基线「零 violation」1 条 + 12 条变异 + 还原后「重新归零」1 条。）

那 **4 条变异后直接 200** 的（`/safety/enable`、`/safety/disable`、`/metrics/reset`、两条
`/ratelimits/*` 里的 reset）正是设计文档 §1.2 那个论点的实测形态：`RESET_METRICS` 是 LOW，
`requiresConfirmation` 对 LOW 为假，确认层**一个令牌都不要**就放行 —— 确认层在这些端点上
根本不构成任何阻挡，去掉 admin 门就等于完全敞开。其余 8 条降级成 403 `SAFETY_CHECK_REQUIRED`
并附一枚可用令牌，也不是授权。

上表是 2026-09-21 在追平 `5edf4c3e1` 之后的合并结果上**重跑**的，12 行与 09-20 那一轮逐行相同，
`14 passed (14)` 也一样（#5903 只动读侧 `catch` 体，对写面响应零影响）。

#### 8.3.1 升级：12 条逐条对**真 spec** 变异（不再只对探针里的复制品）

上表的「闭世界点名」列量的是探针里那份同款审计函数 —— 这仍然是自证。09-20 那一轮只把
`POST /safety/enable` 一条拿去变异真 spec；09-21 这一轮把 **12 条全部**做了一遍：对
`admin-safety-toggle-and-bulk-authz.test.ts` 的**原样复制品**（`w8k-mutated-spec.test.ts`，
跑完即删、未提交）在 import 之后插一段内存级变异，把目标路由 `route.stack` 里首位 handler 的
`.handle` 换成 passthrough（源文件零改动；命中数不等于 1 就直接抛错，杜绝「变异没落上却全绿」），
其余一字不改，每条各跑一次 `vitest run`。结果：

| 被换掉门的路由 | 该 spec 变红的用例 | 合计 |
|---|---|---|
| POST `/safety/enable` | 点名用例 + 闭世界用例 | 2 failed / 23 passed |
| POST `/safety/disable` | 点名用例 + 越权整链用例 + 闭世界用例 | 3 failed / 22 passed |
| POST `/cache/clear` | 点名用例 + 闭世界用例 | 2 failed / 23 passed |
| POST `/metrics/reset` | 点名用例 + 闭世界用例 | 2 failed / 23 passed |
| DELETE `/data/bulk` | 点名用例 + 闭世界用例 | 2 failed / 23 passed |
| PUT `/data/bulk` | 点名用例 + 越权整链用例 + fail-closed 用例 + 闭世界用例 | 4 failed / 21 passed |
| POST `/dlq/:id/retry` | 点名用例 + 闭世界用例 | 2 failed / 23 passed |
| DELETE `/dlq/:id` | 点名用例 + 闭世界用例 | 2 failed / 23 passed |
| POST `/dlq/retry-all` | 点名用例 + 闭世界用例 | 2 failed / 23 passed |
| POST `/dlq/cleanup` | 点名用例 + 闭世界用例 | 2 failed / 23 passed |
| POST `/ratelimits/:key/reset` | 点名用例 + 闭世界用例 | 2 failed / 23 passed |
| POST `/ratelimits/reset-all` | 点名用例 + 闭世界用例 | 2 failed / 23 passed |

12 条**全部**同时满足两件事：①对应的点名用例红；②**真正要合进仓库的那条闭世界用例本身**红。
多出来的那几条（`/safety/disable` 的越权整链、`PUT /data/bulk` 的整链与 fail-closed）是这两个
端点本来就被多条用例覆盖，红得应该。没有一次变异静默全绿，也没有一次把无关用例带红
（每轮剩下的 21–23 条全绿）—— 说明闭世界用例既有载荷、又不过度耦合。

### 8.4 相邻 spec 不回归

```
$ npx vitest run \
    tests/unit/admin-safety-toggle-and-bulk-authz.test.ts \
    tests/unit/admin-read-gates-batch2-authz.test.ts \
    tests/unit/admin-read-gates-batch3-authz.test.ts \
    tests/unit/admin-safety-confirm-authz.test.ts \
    tests/unit/safety-guard-confirm-flow.test.ts \
    tests/unit/require-admin-role-fail-closed.test.ts \
    tests/unit/admin-snapshot-delete-authz.test.ts \
    tests/unit/admin-dlq-read-authz.test.ts \
    tests/unit/admin-read-error-echo-redaction.test.ts --reporter=dot

 Test Files  9 passed (9)
      Tests  141 passed (141)
```

（09-21 这一轮把 #5903 新带进来的 `admin-read-error-echo-redaction.test.ts` 也拉进了邻接集 ——
它和本 PR 改的是同一个文件的不同面，正好互为回归面。）

（输出里的 `error: RBAC check failed` 是 fail-closed 用例**期望内**的日志，不是失败。）

### 8.5 类型检查 —— 并且确认不是假绿

`packages/core-backend/tsconfig.json` 的 `exclude` 含 `**/*.test.ts`，所以
**`npx tsc --noEmit` 根本不会检查本 spec**，拿它当「spec 类型没问题」的证据是假绿。
两步都做了：

1. `npx tsc --noEmit` → 退出码 0（证明 `src` 侧没被本改动破坏）。
2. 一次性 `tsconfig`（跑完即删）把 `src/**` / `core/**` / `types/**` 加上本 spec 与
   `tests/utils/pinned-server.ts` 一起编译，`src` 下的既有测试文件仍按仓库原 `exclude` 口径排除
   （仓里既有的测试类型债与本 PR 无关）：`npx tsc --noEmit -p <临时配置>` → **0 个 error**。
   这份临时配置自己也做了**反证**：往本 spec 末尾临时塞一行
   `const __w8k_probe: number = "not a number"`，同一条命令立刻报
   `admin-safety-toggle-and-bulk-authz.test.ts(452,7): error TS2322`，退出码 2 —— 证明它确实在
   编译本 spec，那个 0 error 不是「根本没看这个文件」的假绿。探针行随即删除，`git diff` 复核过。
   （09-21 重跑同样是 0 error / 反证 TS2322。临时配置用 `files: [本 spec, tests/utils/pinned-server.ts]`
   点名这两个文件，`include` 仍是仓库原来的 `src` / `core` / `types`、`exclude` 仍排除
   `**/*.test.ts` 与 `**/__tests__/**` —— `files` 不受 `exclude` 影响，所以既看得到本 spec，
   又不会把 `core/__tests__/cache-registry.test.ts` 那种既有类型债算到本 PR 头上。）

### 8.6 09-12 以来事实变化的复核（否定性结论都给了 path:line）

- `protection-rules.ts` 四条写端点**不再**零授权门：`:236` / `:328` / `:369` / `:392` 首位都是
  `requireAdminRole()`。设计文档 §2.1 与 §4 第 7 条已就地标注作废并指向 §5.3。
- `x-user-id` 在 `protection-rules.ts` 里只剩 `:20` 一条历史注释，不再是任何路由的身份来源。
- `GET /dlq`（`:1693`）等一族读端点已由 #5710 / #5897 补门；最后一条 `GET /slo/status`（`:1646`）
  由 #5914 补门。根 GET 的无门数**现在是 0**（16/16 有门），这是 2026-09-20 二次 rebase 时才成立的
  新事实 —— 一次 rebase 时它还是 1。
- 设计文档正文里所有指向 `admin-routes.ts` / `index.ts` / `guards/*` / `rbac/service.ts` 的行号
  已按 `5edf4c3e1` 追平后的合并结果重新实读订正；标「修前」的历史行号保留。逐条复核过的锚点：
  `admin-routes.ts` 12 处 `requireAdminRole(),` 实测落在 `:221 :244 :1158 :1214 :1387 :1506 :1721
  :1753 :1942 :1994 :2155 :2194`（另有 `:172` 是本 PR 之前就有的 `/safety/confirm`），与设计 §2
  的表逐行一致；`router.use` 两处 `:2386` / `:2387`、`export default router` `:2389`、
  `allowBypass` 赋值 `:2407`、`validTables` 两份 `:1408` / `:1528`、
  `protection-rules.ts` 四条写端点 `:236` / `:328` / `:369` / `:392`、
  `audit-integration.ts:113` `requireAdminRole` 与 `:260` `protectAdminOperation`、
  `rbac/service.ts:19` `isAdmin`、`guards/types.ts:126` 与 `guards/SafetyGuard.ts:35` 的
  `allowBypass`、`SafetyGuard.ts:394` 的 `entityType && entityId`。

### 8.7 边界自检

- 只在 worktree `metasheet-wt-w8k` 内改动；主检出与其他 `metasheet-*` 目录只读，未触碰。
- 未合任何 PR、未碰 `main`、未改 `.github/`、未改 `plugins/` 与任何 pin 文件。
- 一次性探针（`w8k-mutation-probe.test.ts`、`w8k-mutated-spec.test.ts` 跑了 12 轮、
  临时 `tsconfig.w8k-spec.json`）跑完即删，未进入任何提交；静态扫描脚本与变异驱动脚本落在
  会话 scratchpad，不在仓库内。删后 `git status` 只剩本 PR 自己的三个文件。
- 变异全部内存级，源文件零改动。
- 未连接任何真实数据库；文档与输出里不含主机 / 账号 / 口令 / 令牌值。
