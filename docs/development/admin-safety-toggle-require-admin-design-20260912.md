# admin 安全开关与 bulk 写/删补 `requireAdminRole` —— 设计说明（2026-09-12，issue #5655 复核）

分支：`fix/admin-safety-toggle-and-bulk-require-admin`
基线：`origin/main` @ `1e98d9d3f`

---

## 1. 问题：确认层被当成了授权门

`packages/core-backend/src/routes/admin-routes.ts` 里有一批写/破坏性端点，**唯一**的前置中间件是
`requireSafetyCheck(...)`。但 `requireSafetyCheck` 是确认流程，不是授权门。

### 1.1 调用链（实读，行号为修前 `origin/main` 的行号）

1. **挂载处没有角色门。**
   `packages/core-backend/src/index.ts:1884`
   ```
   this.app.use('/api/admin', initAdminRoutes({ ... }))
   ```
   `app.use` 与这一行之间没有任何 admin 中间件；能过全局认证的**任何**用户都能打到 `/api/admin/*`。

2. **router 级也没有角色门。**
   `admin-routes.ts` 全文只有两处 `router.use`（修前 `:2021`、`:2022`；修后 `:2086`、`:2087`），都是挂子路由
   （`/snapshots` → `snapshot-labels`，`/safety/rules` → `protection-rules`），不是中间件。

3. **`requireSafetyCheck` 内零角色判断。**
   `packages/core-backend/src/guards/middleware.ts:65-123`：它只读 `req.user?.id` 当
   **initiator 字符串**（`:74-78`），然后 `await safetyGuard.checkOperation(context)`；
   `result.allowed` 为真就 `next()`，为假就答 403 `SAFETY_CHECK_REQUIRED` 外加一枚确认令牌。
   全函数没有一次 `isAdmin` / 角色查询。

4. **风险级决定「要不要确认」，而 LOW 根本不要。**
   `guards/SafetyGuard.ts` 的 `RISK_MAP`（`:50-71`）里 `RESET_METRICS = LOW`；
   `assessRisk`（`:471-477`）里
   ```
   requiresConfirmation: riskLevel === MEDIUM || riskLevel === HIGH || riskLevel === CRITICAL
   ```
   —— LOW 不需要确认，`checkOperation` 直接 `allowed: true`。

5. **于是 `POST /safety/disable` 是一次请求就能关掉整个确认层。**
   修前 `admin-routes.ts:148-166`：
   ```
   router.post(
     '/safety/disable',
     requireSafetyCheck({ operation: OperationType.RESET_METRICS, ... }),   // LOW → 免确认
     (req, res) => {
       const guard = getSafetyGuard();
       guard.updateConfig({ enabled: false });                              // :156 改进程单例
       ...
     }
   );
   ```
   `RESET_METRICS` 是 LOW，所以任何已认证的非 admin 直接拿到 200。

6. **关掉之后 `SafetyGuard` 对一切放行。**
   `guards/SafetyGuard.ts:97-105`：
   ```
   async checkOperation(context) {
     if (!this.config.enabled) { return { allowed: true, assessment: await this.assessRisk(context) } }
     ...
   ```

7. **下游的 bulk 写/删随之对任意已认证用户开放。**
   - `PUT /data/bulk`（修前 `:1259`）→ `:1315`
     `let query = (db.updateTable(table as any) as any).set(updates)`
   - `DELETE /data/bulk`（修前 `:1174`）→ `:1221`
     `let query = db.deleteFrom(table as any) as any`

   表名白名单（两处各一份，内容相同）含
   `users / cells / formulas / tables / data_sources / snapshots / snapshot_items /
   protection_rules / views / view_states / table_rows / event_subscriptions`；
   过滤条件**完全**来自 `req.body.filters`，逐条 `query.where(key, '=', value)`，
   **没有任何租户注入、没有字段白名单**。

8. **`POST /safety/enable`（修前 `:134-142`）连 `requireSafetyCheck` 都没有** —— 零中间件。

整链已用真实路由复现（见验证文档）：非 admin → `POST /safety/disable` 得 200 →
`PUT /data/bulk {table:'data_sources'}` 得 200，且 `db.updateTable` 被以 `'data_sources'` 调用 1 次；
`DELETE /data/bulk` 同理命中 `db.deleteFrom('data_sources')`。

### 1.2 为什么确认层不是授权门

- **它回答的是「你确定吗」，不是「你是谁」。** `requireSafetyCheck` 的输入里 `req.user` 只用来拼
  initiator 字符串和绑定令牌，从不用于判权。
- **它的强度由风险级决定，而风险级是操作属性、不是主体属性。** LOW 免确认、MEDIUM 一次带令牌重试即可
  （`middleware.ts:20-26` 的 `buildConfirmInstructions`：`needsConfirmStep` 只对 double-confirm /
  HIGH / CRITICAL 为真）。也就是说 LOW / MEDIUM 的端点在只有确认层时对任何已认证用户完全敞开。
- **它是可被自己关掉的。** 确认层的开关本身若只由确认层把守，就构成自引用：一个 LOW 操作能把整层拆掉。
  授权门必须在确认层**之外、之前**。
- **`allowBypass` 是死配置。** `initAdminRoutes` 在 `:2107` 传
  `allowBypass: process.env.NODE_ENV === 'test'`，但 `checkOperation` 全程从不读它
  （全仓仅 `types.ts:126` 声明、`SafetyGuard.ts:35` 默认值、README、这一处赋值）。
  它既没有放大风险，也**不能**被指望为任何保护。

真正的授权门是 `requireAdminRole()`（`guards/audit-integration.ts:113-196`）：
无 `req.user.id` → 403 `ADMIN_REQUIRED`；`await isAdmin(user.id)` 为假 → 403 `ADMIN_REQUIRED`；
`isAdmin` 抛错 → **fail-closed** 503 `RBAC_CHECK_FAILED`。
`isAdmin`（`rbac/service.ts:19-35`）直查 `user_roles`：
`SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = 'admin' LIMIT 1`，无连接池时返回 `false`。
`protectAdminOperation(op)`（`audit-integration.ts:260-261`）= `[requireAdminRole(), auditSafetyOperation(op)]`。

---

## 2. 修了什么

在 `admin-routes.ts` 里，给下列端点在 `requireSafetyCheck` **之前**插入 `requireAdminRole()`
（沿用文件已有的 `import { ..., requireAdminRole, ... } from '../guards'`，与 `:92`、`:391` 等
既有用法同一写法）。只加一层中间件，不重构、不改处理器、不动 `SafetyGuard` 语义。

| 修后行 | 方法 | 路径 | OperationType | 风险级 | 修前把关 | 修前非 admin 实际结果 |
|---|---|---|---|---|---|---|
| `:141` | POST | `/safety/enable` | —（无） | — | **零中间件** | 200 直接开 |
| `:164` | POST | `/safety/disable` | `RESET_METRICS` | LOW | 仅确认层 | **200 直接关掉整层** |
| `:1092` | POST | `/cache/clear` | `CLEAR_CACHE` | MEDIUM | 仅确认层 | 403 + 令牌（一次重试即可过） |
| `:1148` | POST | `/metrics/reset` | `RESET_METRICS` | LOW | 仅确认层 | **200 直接执行** |
| `:1205` | DELETE | `/data/bulk` | `DELETE_DATA` | HIGH | 仅确认层 | 403 + 令牌 |
| `:1295` | PUT | `/data/bulk` | `BULK_UPDATE` | HIGH | 仅确认层 | 403 + 令牌 |
| `:1466` | POST | `/dlq/:id/retry` | `BULK_UPDATE` | HIGH | 仅确认层 | 403 + 令牌 |
| `:1498` | DELETE | `/dlq/:id` | `DELETE_DATA` | HIGH | 仅确认层 | 403 + 令牌 |
| `:1674` | POST | `/dlq/retry-all` | `BULK_UPDATE` | HIGH | 仅确认层 | 403 + 令牌 |
| `:1726` | POST | `/dlq/cleanup` | `DELETE_DATA` | HIGH | 仅确认层 | 403 + 令牌 |
| `:1873` | POST | `/ratelimits/:key/reset` | `RESET_METRICS` | LOW | 仅确认层 | **200 直接执行** |
| `:1912` | POST | `/ratelimits/reset-all` | `RESET_METRICS` | LOW | 仅确认层 | **200 直接执行** |

共 12 处。任务点名的是前两条 + 两条 bulk；其余 8 条是按盘点要求「凡是写/破坏性端点一并加门」补的
——它们同属「只靠 `requireSafetyCheck` 把关」这一族，其中 `RESET_METRICS` 那三条（`/metrics/reset`、
`/ratelimits/:key/reset`、`/ratelimits/reset-all`）和 `/safety/disable` 一样是 LOW、**修前彻底敞开**。

### 2.1 没加门的端点及理由

- **读端点，一律不动**：`GET /safety/status`(`:79`)、`GET /slo/status`(`:1392`)、`GET /dlq`(`:1435`)、
  `GET /shards`、`GET /shards/:name`、`GET /queues`、`GET /ratelimits`、`GET /ratelimits/:key`、
  `GET /health/detailed|summary|subsystem/:name`。任务限定「读端点不动」，本次不改变任何读可见面。
- **`POST /health/check`（`:2047`）**：不带 `requireSafetyCheck`、也不带 admin 门。它只调用
  `healthAggregator.checkHealth()` 取一次健康快照并返回摘要，不写任何状态——按「写/破坏性」判定
  不属于本次范围，**未加门**。（它仍是一个无鉴权的探测面，归入残余。）
- **`POST /plugins/reload-all-unsafe`(`:768`)、`POST /plugins/:id/reload-unsafe`(`:819`)**：
  未加 `requireAdminRole()`。它们**已有**自己的双重门：先要 `ALLOW_UNSAFE_ADMIN === 'true'`
  （否则 403 `UNSAFE_DISABLED`），再要 `req.user.roles` 含 `'admin'`（否则 403 `ADMIN_REQUIRED`）。
  这条角色判断是读 token 上的 `roles` 数组而非查 `user_roles`，与 `requireAdminRole()` 的口径不同，
  但它**不是**「只靠确认层」的那一族，改它属于另一件事（口径统一），本次不动，列入残余。
- **已经有门的**：`/safety/confirm`(`:92`)、`/plugins/*`(`:391 :404 :478 :526 :560 :594 :613`)、
  `/yjs/status`(`:1412`)，以及走 `protectAdminOperation` 的 `/plugins/:id/reload`、
  `/plugins/reload-all`、`DELETE /plugins/:id`、`/snapshots/:id/restore`、`DELETE /snapshots/:id`、
  `/snapshots/cleanup`。

**非 admin 合法调用方核查**：对上述 12 条路径在 `apps/web/src` 全量搜索（`*.ts/*.tsx/*.vue`）
以及全仓（排除 `node_modules`、`.git`）搜索 `admin/safety/disable|admin/safety/enable|admin/data/bulk|
admin/cache/clear|admin/metrics/reset|admin/ratelimits|admin/dlq`，命中全部是**文档**
（`ROADMAP_V2.md`、`TODO_SPRINT4.md`、`TODO_SPRINT7.md`、`SPRINT4_COMPLETION_REPORT.md`、
`claudedocs/PHASE10_ADVANCED_MESSAGING_PLAN.md`）与 `admin-routes.ts` 自身的注释行，
**零前端调用点、零程序化调用点**。因此不存在「非 admin 合法调用方」被误伤。

---

## 3. 对 admin 的行为不变

- 没有给 admin 新增任何放行路径：`requireAdminRole()` 只在原有中间件链**最前面**加了一层，
  admin 通过后进入的仍是**原封不动**的 `requireSafetyCheck(...)` + 原处理器。
- `PUT /data/bulk`、`DELETE /data/bulk` 对 admin 仍然是 403 `SAFETY_CHECK_REQUIRED` 并回确认令牌
  （HIGH，须走 `/safety/confirm` 再带 `X-Safety-Token` 重试）——已用测试钉死。
- `POST /safety/disable` 对 admin 仍然是 200（LOW，免确认），`POST /safety/enable` 对 admin 仍然 200。
- `POST /safety/confirm` 那条链一个字没动（它在 `:92` 早就有 `requireAdminRole()`）。
- `SafetyGuard` 的任何语义（风险表、令牌绑定、确认阶段/重试阶段、过期、一次性）零改动。
- `validTables` 两份白名单内容零改动。

---

## 4. 残余风险（本次**没有**解决，明确记账）

1. **`/api/admin` 挂载处仍没有统一角色门。** `index.ts:1884` 之后的 `/api/admin/*` 依旧靠
   「逐条路由自己挂门」。本次把 `admin-routes.ts` 里「只靠确认层」的一族补齐了，但这是逐条加固，
   不是面上的保证：今后任何人在这个 router 里新加一条写路由而忘了加门，就会重新开洞。
   根治要么在挂载处套一层 admin 门（需先核对 `/safety/status` 等读端点与既有前端的可见性契约），
   要么加一条「本文件所有写方法必须首位是 admin 门」的结构性测试。
2. **bulk 写/删仍然没有租户注入，也没有字段白名单。** `req.body.filters` 原样进
   `query.where(key, '=', value)`，`req.body.updates` 原样进 `.set(updates)`。
   现在只有 admin 能打到，但「平台 admin 能跨租户改任意列」这个语义没有收紧。
   本次**刻意不动**：加租户注入属于改写语义，不在「最小、不重构」范围内。
3. **`data_sources` 仍留在 `validTables` 里**（`:1227` / `:1318` 两份）。是否把它（以及
   `users` / `protection_rules` 等）摘出白名单是 issue **#5655 待用户裁决**的另一个问题，本次不动。
4. **`POST /health/check`（`:2047`）无任何鉴权**，是一个匿名可触发的健康探测/放大面（读，不写）。
5. **`*-unsafe` 两条路由的 admin 判定口径与 `requireAdminRole()` 不一致**（读 token 的 `roles`
   数组 vs 查 `user_roles` 表）。两套口径共存本身是隐患，但需要先确定哪一套是权威，本次不动。
6. **`allowBypass` 仍是死配置**，留在 `types.ts` / `SafetyGuard.ts` / `initAdminRoutes` 里没人读。
   它今天无害，但是一个会误导读者（以为测试环境会绕过）的悬挂旋钮。
