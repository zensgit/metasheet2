# admin 安全开关与 bulk 写/删补 `requireAdminRole` —— 设计说明（2026-09-12，issue #5655 复核）

分支：`fix/admin-safety-toggle-and-bulk-require-admin`
基线：`origin/main` @ `1e98d9d3f`

---

## 1. 问题：确认层被当成了授权门

`packages/core-backend/src/routes/admin-routes.ts` 里有一批写/破坏性端点，**唯一**的前置中间件是
`requireSafetyCheck(...)`。但 `requireSafetyCheck` 是确认流程，不是授权门。

### 1.1 调用链（实读，行号为修前 `origin/main` 的行号）

1. **挂载处没有角色门。**
   `packages/core-backend/src/index.ts:1939`
   ```
   this.app.use('/api/admin', initAdminRoutes({ ... }))
   ```
   `app.use` 与这一行之间没有任何 admin 中间件；能过全局认证的**任何**用户都能打到 `/api/admin/*`。

2. **router 级也没有角色门。**
   `admin-routes.ts` 全文只有两处 `router.use`（修前 `:2021`、`:2022`；修后（2026-09-20 rebase 后）`:2388`、`:2389`），都是挂子路由
   （`/snapshots` → `snapshot-labels`，`/safety/rules` → `protection-rules`），不是中间件。

3. **`requireSafetyCheck` 内零角色判断。**
   `packages/core-backend/src/guards/middleware.ts:65-123`：它只读 `req.user?.id` 当
   **initiator 字符串**（`:70-74`），然后 `await safetyGuard.checkOperation(context)`；
   `result.allowed` 为真就 `next()`，为假就答 403 `SAFETY_CHECK_REQUIRED` 外加一枚确认令牌。
   全函数没有一次 `isAdmin` / 角色查询。

4. **风险级决定「要不要确认」，而 LOW 根本不要。**
   `guards/SafetyGuard.ts` 的 `RISK_MAP`（`:48-72`）里 `RESET_METRICS = LOW`；
   `assessRisk`（`:384` 起；下面这一句在 `:473`）里
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
   - `PUT /data/bulk`（修前 `:1259`）→ `:1457`（`db.updateTable` 那一行在 `:1539`）
     `let query = (db.updateTable(table as any) as any).set(updates)`
   - `DELETE /data/bulk`（修前 `:1174`）→ `:1338`（`db.deleteFrom` 那一行在 `:1405`）
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
- **`allowBypass` 是死配置。** `initAdminRoutes` 在 `:2409` 传
  `allowBypass: process.env.NODE_ENV === 'test'`，但 `checkOperation` 全程从不读它
  （全仓仅 `types.ts:126` 声明、`SafetyGuard.ts:35` 默认值、README、这一处赋值）。
  它既没有放大风险，也**不能**被指望为任何保护。

真正的授权门是 `requireAdminRole()`（`guards/audit-integration.ts:113-199`）：
无 `req.user.id` → 403 `ADMIN_REQUIRED`；`await isAdmin(user.id)` 为假 → 403 `ADMIN_REQUIRED`；
`isAdmin` 抛错 → **fail-closed** 503 `RBAC_CHECK_FAILED`。
`isAdmin`（`rbac/service.ts:19-34`）直查 `user_roles`：
`SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = 'admin' LIMIT 1`，无连接池时返回 `false`。
`protectAdminOperation(op)`（`audit-integration.ts:260-262`）= `[requireAdminRole(), auditSafetyOperation(op)]`。

---

## 2. 修了什么

在 `admin-routes.ts` 里，给下列端点在 `requireSafetyCheck` **之前**插入 `requireAdminRole()`
（沿用文件已有的 `import { ..., requireAdminRole, ... } from '../guards'`，与 `:114`、`:413` 等
既有用法同一写法）。只加一层中间件，不重构、不改处理器、不动 `SafetyGuard` 语义。

| `requireAdminRole()` 所在行（2026-09-20 rebase 后）| 方法 | 路径 | OperationType | 风险级 | 修前把关 | 修前非 admin 实际结果 |
|---|---|---|---|---|---|---|
| `:163` | POST | `/safety/enable` | —（无） | — | **零中间件** | 200 直接开 |
| `:186` | POST | `/safety/disable` | `RESET_METRICS` | LOW | 仅确认层 | **200 直接关掉整层** |
| `:1114` | POST | `/cache/clear` | `CLEAR_CACHE` | MEDIUM | 仅确认层 | 403 + 令牌（一次重试即可过） |
| `:1170` | POST | `/metrics/reset` | `RESET_METRICS` | LOW | 仅确认层 | **200 直接执行** |
| `:1343` | DELETE | `/data/bulk` | `DELETE_DATA` | HIGH | 仅确认层 | 403 + 令牌 |
| `:1462` | PUT | `/data/bulk` | `BULK_UPDATE` | HIGH | 仅确认层 | 403 + 令牌 |
| `:1683` | POST | `/dlq/:id/retry` | `BULK_UPDATE` | HIGH | 仅确认层 | 403 + 令牌 |
| `:1715` | DELETE | `/dlq/:id` | `DELETE_DATA` | HIGH | 仅确认层 | 403 + 令牌 |
| `:1919` | POST | `/dlq/retry-all` | `BULK_UPDATE` | HIGH | 仅确认层 | 403 + 令牌 |
| `:1971` | POST | `/dlq/cleanup` | `DELETE_DATA` | HIGH | 仅确认层 | 403 + 令牌 |
| `:2142` | POST | `/ratelimits/:key/reset` | `RESET_METRICS` | LOW | 仅确认层 | **200 直接执行** |
| `:2181` | POST | `/ratelimits/reset-all` | `RESET_METRICS` | LOW | 仅确认层 | **200 直接执行** |

共 12 处。任务点名的是前两条 + 两条 bulk；其余 8 条是按盘点要求「凡是写/破坏性端点一并加门」补的
——它们同属「只靠 `requireSafetyCheck` 把关」这一族，其中 `RESET_METRICS` 那三条（`/metrics/reset`、
`/ratelimits/:key/reset`、`/ratelimits/reset-all`）和 `/safety/disable` 一样是 LOW、**修前彻底敞开**。

### 2.1 没加门的端点及理由

- **读端点，一律不动**：`GET /safety/status`(`:101`)、`GET /slo/status`(`:1602`)、`GET /dlq`(`:1652`)、
  `GET /shards`(`:1757`)、`GET /shards/:name`(`:1811`)、`GET /queues`(`:1867`)、`GET /ratelimits`(`:2020`)、
  `GET /ratelimits/:key`(`:2094`)、`GET /health/detailed|summary|subsystem/:name`(`:2228` / `:2271` / `:2313`)。
  任务限定「读端点不动」，本次不改变任何读可见面。
  **2026-09-20 复核**：这一族读端点如今**全部**已由别的 PR（#5710 / #5897 / #5914）补上 `requireAdminRole()` ——
  `/api/admin` 根 GET 的无门数已经归零；本 PR 依然一个读端点都没碰。
- **`POST /health/check`（`:2349`）**：不带 `requireSafetyCheck`、也不带 admin 门。它只调用
  `healthAggregator.checkHealth()` 取一次健康快照并返回摘要，不写任何状态——按「写/破坏性」判定
  不属于本次范围，**未加门**。（它仍是一个**任意已认证用户**可触发的探测面——全局 JWT 门挡匿名、不鉴角色，归入残余。）
- **`POST /plugins/reload-all-unsafe`(`:790`)、`POST /plugins/:id/reload-unsafe`(`:841`)**：
  未加 `requireAdminRole()`。它们**已有**自己的双重门：先要 `ALLOW_UNSAFE_ADMIN === 'true'`
  （否则 403 `UNSAFE_DISABLED`），再要 `req.user.roles` 含 `'admin'`（否则 403 `ADMIN_REQUIRED`）。
  这条角色判断是读 token 上的 `roles` 数组而非查 `user_roles`，与 `requireAdminRole()` 的口径不同，
  但它**不是**「只靠确认层」的那一族，改它属于另一件事（口径统一），本次不动，列入残余。
- **同挂载面的子路由 `/safety/rules`（`admin-routes.ts:2389` 挂 `protection-rules.ts`）**：**本段的「零授权门」判断已于 2026-09-20 rebase 时作废，见 §5.3**。
  09-12 基线上这四条写端点确实零授权门、身份取自可伪造的 `x-user-id` 请求头（`protection-rules.ts:21`、`:113`）；
  2026-09-20 实读，它们首位都是 `requireAdminRole()`（`protection-rules.ts:236 POST /`、`:328 PATCH /:id`、
  `:369 DELETE /:id`、`:392 POST /evaluate`，#5667 / PR #5677 已合）。当时的判断是「先存洞、不是本次回归」；也**不能**用它重开上面 12 条（`SafetyGuard.ts:394`
  只在 `entityType && entityId` 都在时评规则，bulk 的 `getDetails` 不给）。本次不动，另开 issue。
- **已经有门的**：`/safety/confirm`(`:114`)、`/plugins/*`(`:413 :426 :500 :548 :582 :616 :635`)、
  `/yjs/status`(`:1622`)，以及走 `protectAdminOperation` 的 `/plugins/:id/reload`、
  `/plugins/reload-all`、`DELETE /plugins/:id`、`/snapshots/:id/restore`、`DELETE /snapshots/:id`、
  `/snapshots/cleanup`。

**非 admin 合法调用方核查**：对上述 12 条路径在 `apps/web/src` 全量搜索（`*.ts/*.tsx/*.vue`）
以及全仓（排除 `node_modules`、`.git`）搜索 `admin/safety/disable|admin/safety/enable|admin/data/bulk|
admin/cache/clear|admin/metrics/reset|admin/ratelimits|admin/dlq`，命中全部是**文档**
（`ROADMAP_V2.md`、`TODO_SPRINT4.md`、`TODO_SPRINT7.md`、`SPRINT4_COMPLETION_REPORT.md`、
`claudedocs/PHASE10_ADVANCED_MESSAGING_PLAN.md`）与 `admin-routes.ts` 自身的注释行，外加**唯一一个程序化调用方**
`scripts/test-safety-guard-e2e.sh:294`（拼接路径打 `/metrics/reset`，以 `safety-guard-e2e.yml:103-111` 播种进 `user_roles`
的 admin 身份跑，CI 在本头上绿）。**零前端调用点**；「非 admin 合法调用方」在代码/脚本形态里不存在——
`.http`/Postman/运维 runbook 之类非代码形态未覆盖，静态搜索看不见用非 admin 服务令牌的外部监控代理。

---

## 3. 对 admin 的行为不变

- **「admin」的口径 = `user_roles` 里有 `admin` 行**（§1.2，`rbac/service.ts:19-23`）。`users.role='admin'`、`is_admin`
  或 token 里声明的 admin **不算**：这类主体在 `/safety/enable|disable`、`/metrics/reset`、`/ratelimits/:key/reset`、
  `/ratelimits/reset-all` 五条上由修前 200 变 403 `ADMIN_REQUIRED`，`/cache/clear` 由「一次重试即过」变 403；
  另 6 条修前就被 `/safety/confirm`(`:114`) 的同一口径挡住，无变化。目标部署若存在只有 `users.role`
  没有 `user_roles` 行的运维账号，上线前需回填（仓内无回填迁移，待用户定）。
- 没有给 admin 新增任何放行路径：`requireAdminRole()` 只在原有中间件链**最前面**加了一层，
  admin 通过后进入的仍是**原封不动**的 `requireSafetyCheck(...)` + 原处理器。
- `PUT /data/bulk`、`DELETE /data/bulk` 对 admin 仍然是 403 `SAFETY_CHECK_REQUIRED` 并回确认令牌
  （HIGH，须走 `/safety/confirm` 再带 `X-Safety-Token` 重试）——已用测试钉死。
- `POST /safety/disable` 对 admin 仍然是 200（LOW，免确认），`POST /safety/enable` 对 admin 仍然 200。
- `POST /safety/confirm` 那条链一个字没动（它在 `:114` 早就有 `requireAdminRole()`）。
- `SafetyGuard` 的任何语义（风险表、令牌绑定、确认阶段/重试阶段、过期、一次性）零改动。
- `validTables` 两份白名单内容零改动。

---

## 4. 残余风险（本次**没有**解决，明确记账）

1. **`/api/admin` 挂载处仍没有统一角色门。** `index.ts:1939` 之后的 `/api/admin/*` 依旧靠
   「逐条路由自己挂门」。本次把 `admin-routes.ts` 里「只靠确认层」的一族补齐了，但这是逐条加固，
   不是面上的保证：今后任何人在这个 router 里新加一条写路由而忘了加门，就会重新开洞。
   根治要么在挂载处套一层 admin 门（需先核对 `/safety/status` 等读端点与既有前端的可见性契约），
   要么加一条「本文件所有写方法必须首位是 admin 门」的结构性测试。
2. **bulk 写/删仍然没有租户注入，也没有字段白名单。** `req.body.filters` 原样进
   `query.where(key, '=', value)`，`req.body.updates` 原样进 `.set(updates)`。
   现在只有 admin 能打到，但「平台 admin 能跨租户改任意列」这个语义没有收紧。
   本次**刻意不动**：加租户注入属于改写语义，不在「最小、不重构」范围内。
3. **`data_sources` 仍留在 `validTables` 里**（`:1364` / `:1484` 两份）。是否把它（以及
   `users` / `protection_rules` 等）摘出白名单是 issue **#5655 待用户裁决**的另一个问题，本次不动。
4. **`POST /health/check`（`:2349`）无角色门**，任意已认证用户可触发的健康探测/放大面（读，不写；匿名被全局 JWT 门挡住）。
5. **`*-unsafe` 两条路由的 admin 判定口径与 `requireAdminRole()` 不一致**（读 token 的 `roles`
   数组 vs 查 `user_roles` 表）。两套口径共存本身是隐患，但需要先确定哪一套是权威，本次不动。
7. ~~**`/safety/rules` 子路由四条写端点零授权门、身份取自请求头**~~ —— **2026-09-20 作废**：#5667 / PR #5677 已合，
   四条首位都是 `requireAdminRole()`（见 §5.3）。同段的「12 条无门 GET」也已**全部**收口：`GET /dlq`（`:1652`）与
   protection-rules 的两条 GET 由 #5710 补门，`GET /slo/status`（`:1602`）由 #5914 补门，`/safety/status`（`:101`）、
   `/yjs/status`（`:1622`）本就有门。2026-09-20 实读：根 GET 无门数 = 0，详见 §5.4。
6. **`allowBypass` 仍是死配置**，留在 `types.ts` / `SafetyGuard.ts` / `initAdminRoutes` 里没人读。
   它今天无害，但是一个会误导读者（以为测试环境会绕过）的悬挂旋钮。

---

## 5. 2026-09-20：rebase 到 main 与复核

本 PR（#5665）自 2026-09-12 起挂在 `main` 上未合，其间 `admin-routes.ts` 被 #5710 / #5884 / #5886 /
#5897 等若干 PR 改动，行号整体下移；复核当天 main 又并入了 #5914 / #5916。本节记录 rebase 事实、行号订正口径，以及**自 09-12 以来事实发生
变化、导致上文某些判断作废**的地方。上文 §1–§4 的正文行号已就地订正为 rebase 后（`ce9ac29cb`）的行号；
显式标着「修前」的行号是 09-12 基线（`1e98d9d3f`）上的历史值，刻意保留不动。

### 5.1 rebase 事实

- 起点：`fix/admin-safety-toggle-and-bulk-require-admin` @ `3c79b2059`（09-12 的 PR head）。
- 目标：`origin/main` @ `ce9ac29cb`（本节写作期间 main 连着并入 #5914 / #5916，已再 rebase 一次并重跑全部证据）。
- `git rebase origin/main` **无冲突**，三个 commit（代码 / 文档 / 文档收口）原样重放。
- 代码 diff 与 `3c79b2059` 逐字相同：`git diff --stat` 在 rebase 前后都是
  `admin-routes.ts | 83 ++-`，没有任何一行因 rebase 被改写。

### 5.2 12 处门逐条复核：都在，且都是**首位**

复核不是靠读 diff，而是靠从真实 express router 对象上取中间件栈（见验证文档 §8）。
结论：`admin-routes.ts` 根 router 上共 **25** 条写路由（POST/PUT/PATCH/DELETE），其中
**22** 条首位是 `requireAdminRole()` 或 `...protectAdminOperation(...)`（后者展开后首位也是
`requireAdminRole()`），**3** 条无门 —— 正是 §2.1 已登记的那三条（见 §5.4）。
本 PR 新增的 12 处门在 §2 的表里逐条列出了 rebase 后的行号。

同一口径对着 `origin/main`（`ce9ac29cb`）自己跑一遍作为**修前对照**：25 条写路由里只有
**10** 条有门、**15** 条无门。15 − 3（永久豁免）= 12，与本 PR 补门的 12 条逐条重合；
那 12 条在 main 上的首位实测是 `requireSafetyCheck({`（`/safety/enable` 连它都没有，是裸 handler）。
这条对照同时钉死了「确认层不是授权门」这个判断的**量**：修前根写面无门率 15/25，修后 3/25。

### 5.3 §2.1 / §4 第 7 条的「`/safety/rules` 零授权门」已作废

09-12 写下这两处时，`protection-rules.ts` 的四条写端点确实零授权门、身份取自可伪造的
`x-user-id` 请求头。**2026-09-20 实读，这个洞已经补上了**：

| `protection-rules.ts` | 方法 | 路径 | 首位中间件 |
|---|---|---|---|
| `:236` | POST | `/` | `requireAdminRole()` |
| `:328` | PATCH | `/:id` | `requireAdminRole()` |
| `:369` | DELETE | `/:id` | `requireAdminRole()` |
| `:392` | POST | `/evaluate` | `requireAdminRole()` |

修它的是 #5667 / PR #5677（已合；#5710 的标题「叠 #5677」是旁证）。`x-user-id` 今天只在
`protection-rules.ts:20` 的一条历史注释里出现，不再是任何一条路由的身份来源。
相应地，§4 第 7 条提到的「同 router 还有 12 条无门 GET」也已**全部**收口（见 §5.4）。

### 5.4 2026-09-20 实读：仍然无门的端点（本 PR 依然不碰）

**写侧 —— 3 条，全部是 §2.1 已登记的永久豁免**（闭世界用例的豁免表就是这三条，逐条带理由）：

| 行 | 方法 | 路径 | 为什么不加中间件门 |
|---|---|---|---|
| `:2349` | POST | `/health/check` | 只读探针，不写任何状态（§2.1）；「任意已认证用户可触发的探测面」记在 §4 第 4 条 |
| `:790` | POST | `/plugins/reload-all-unsafe` | 自带 in-handler 双门（`ALLOW_UNSAFE_ADMIN` + token 上的 `roles`）；口径不一致记在 §4 第 5 条 |
| `:841` | POST | `/plugins/:id/reload-unsafe` | 同上 |

**读侧 —— 归零**。§2.1 当时列的那一族无门 GET（`/dlq`、`/shards*`、`/queues`、`/ratelimits*`、
`/health/*`、`/safety/status`）已由 #5710 / #5897 补门；最后一条 `GET /slo/status` 由 #5914 补上
（`:1602`），同一个 PR 还给子路由 `/snapshots` 补了门。实测 16 条根 GET 全部有门，无门数 = 0。
本 PR 一个读端点都没碰。

### 5.5 新增：一条闭世界用例（补 §4 第 1 条残余的一半）

§4 第 1 条说得很清楚：逐条加固**不是面上的保证**，「今后任何人在这个 router 里新加一条写路由而
忘了加门，就会重新开洞」，并给了两条根治路径，其一是「加一条『本文件所有写方法必须首位是
admin 门』的结构性测试」。rebase 时补上了这条，落在同一个 spec 里：

- 枚举 `admin-routes.ts` **根 router** 上全部 POST/PUT/PATCH/DELETE 路由，要求每条首位是
  `requireAdminRole()`，否则必须在显式豁免表（§5.4 那三条，逐条带理由）里。没登记的洞 = 红。
- 识别器是 `requireAdminRole()` 闭包的 `toString()` 比对，并带**正反自证**：
  `protectAdminOperation(...)` 展开后首位被认出、`requireSafetyCheck(...)` 与裸中间件不被认出。
- 另有一条「防空转绿」断言（收集到的写路由数量下界），免得取栈方式失效后静默全绿。
- **载荷性实测**（验证文档 §8.3 末）：把 `POST /safety/enable` 的门在内存里换成 passthrough 后，
  这条闭世界用例**本身**会红（不是只有探针里的复制品会红），且只红它与对应的点名用例，
  其余 23 条不动。

**范围仍然只到根路由**，不含 `router.use('/snapshots', ...)` / `router.use('/safety/rules', ...)`
（`:2388`、`:2389`）两个子路由挂载点。整棵树（含子路由、含「临时豁免只提示不拦」机制）的结构性
守卫是 PR #5680 的活，本用例与它口径一致（同一个识别器、同三条永久豁免）、范围更窄。
收窄的理由是边界清晰，**不是**因为子路由今天有洞 —— §5.3 已证它没有。

### 5.6 §4 残余的当前状态

| # | 残余 | 2026-09-20 状态 |
|---|---|---|
| 1 | `/api/admin` 挂载处无统一角色门 | 仍在。两条根治路径中的「结构性测试」已做一半（根路由，见 §5.5）；挂载处套门仍未做 |
| 2 | bulk 写/删无租户注入、无字段白名单 | 仍在，本次仍不动 |
| 3 | `data_sources` 仍在 `validTables`（`:1364` / `:1484`） | 仍在，待裁决 |
| 4 | `POST /health/check` 无角色门 | 仍在（`:2349`） |
| 5 | 两条 `*-unsafe` 的 admin 口径与 `requireAdminRole()` 不一致 | 仍在（`:790` / `:841`） |
| 6 | `allowBypass` 是死配置（`:2409` 赋值，无人读） | 仍在 |
| 7 | `/safety/rules` 四条写端点零授权门 | **已作废**：#5667 / PR #5677 已合，见 §5.3 |
