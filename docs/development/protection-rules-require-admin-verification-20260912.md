# 验证记录：/safety/rules 写端点管理员门与身份（issue #5667）

日期：2026-09-12
分支：`fix/protection-rules-require-admin-and-identity`（基线 `origin/main` @ `9fb29831c`）
测试文件：`packages/core-backend/tests/unit/protection-rules-authz.test.ts`（新增，8 用例）
设计文档：`docs/development/protection-rules-require-admin-design-20260912.md`

测试走**真实路由**：把 `src/routes/protection-rules.ts` 这个真 router 挂在
`/api/admin/safety/rules`（和 `admin-routes.ts:2022` 同一个挂载基底），用 supertest 打真 HTTP。
mock 的只有边界：`rbac/service` 的 `isAdmin`、`db/pg` 的 `pool`、`ProtectionRuleService`。
守卫本体、路由匹配、中间件顺序都是真的。传输走 `tests/utils/pinned-server`（#4154 约定）。

## 1. 修前基线（红，原样）

### 1.1 探针：非管理员打四条写端点，记录原始状态码与真正落到 service 的 created_by

探针只在内存里跑过一次，**没有提交**（它是一次性取证用的，不是回归测试）。
`isAdmin` 固定 mock 成 `false`，`req.user.id` 是 `u-lowly-nonadmin`，
同时带一个自己手打的 `x-user-id: i-typed-this-myself` 头。原样输出：

```
{
  "note": "isAdmin mocked FALSE, req.user.id = u-lowly-nonadmin",
  "POST   /api/admin/safety/rules": 201,
  "PATCH  /api/admin/safety/rules/r1": 200,
  "DELETE /api/admin/safety/rules/r1": 200,
  "POST   /api/admin/safety/rules/evaluate": 200,
  "createRule_called": 1,
  "updateRule_called": 1,
  "deleteRule_called": 1,
  "evaluateRules_called": 1,
  "created_by_recorded_in_db": "i-typed-this-myself",
  "req_user_id_was": "u-lowly-nonadmin"
}
```

四条写端点对一个**明确不是管理员**的调用方全部 2xx（201/200/200/200），
四个 service 方法各被真实调用一次，落库的创建者是请求头里那个字符串，
而不是真实主体 `u-lowly-nonadmin`。两个洞都在这一段里。

### 1.2 新增 spec 在修前的红（原样）

```
 × tests/unit/protection-rules-authz.test.ts > protection-rules router — platform-admin gate + identity (issue #5667) > non-admin -> 403 ADMIN_REQUIRED on all four write endpoints, NO service write called
   → expected 403 "Forbidden", got 201 "Created"
 × tests/unit/protection-rules-authz.test.ts > protection-rules router — platform-admin gate + identity (issue #5667) > a forged `x-user-id: admin-looking` header does NOT buy a non-admin any write
   → expected 403 "Forbidden", got 201 "Created"
 × tests/unit/protection-rules-authz.test.ts > protection-rules router — platform-admin gate + identity (issue #5667) > unauthenticated (no req.user) -> 403, no service write
   → expected 403 "Forbidden", got 201 "Created"
 × tests/unit/protection-rules-authz.test.ts > protection-rules router — platform-admin gate + identity (issue #5667) > RBAC check failure (isAdmin throws) -> 503 fail-closed, no service write
   → expected 503 "Service Unavailable", got 201 "Created"
 × tests/unit/protection-rules-authz.test.ts > protection-rules router — platform-admin gate + identity (issue #5667) > platform-admin -> POST / creates, and created_by is req.user.id, NOT the x-user-id header
   → expected 'u-spoofed' to be 'u-realadmin' // Object.is equality

 Test Files  1 failed (1)
      Tests  5 failed | 2 passed (7)
```

说明：这一轮是限流用例加进去之前跑的，所以总数是 7 不是 8。
`supertest` 的 `.expect(403)` 在第一条就抛，所以第一个用例只报了 POST 那条；
"四条全是 2xx"的证据在 §1.1 的探针里，那里每条都单独记了状态码。

## 2. 修后（绿）

```
 ✓ non-admin -> 403 ADMIN_REQUIRED on all four write endpoints, NO service write called
 ✓ a forged `x-user-id: admin-looking` header does NOT buy a non-admin any write
 ✓ unauthenticated (no req.user) -> 403, no service write
 ✓ RBAC check failure (isAdmin throws) -> 503 fail-closed, no service write
 ✓ platform-admin -> POST / creates, and created_by is req.user.id, NOT the x-user-id header
 ✓ platform-admin -> patch / delete / evaluate reach the service
 ✓ the rate-limit bucket keys on the principal — flipping x-user-id cannot mint fresh quota
 ✓ reads are deliberately UNCHANGED — a non-admin can still GET / and GET /:id

 Test Files  1 passed (1)
      Tests  8 passed (8)
```

八条覆盖的断言口径：

- 403 的**形状**逐条核对 `body.code === 'ADMIN_REQUIRED'`，不是只看状态码。
- 拒绝路径同时断言 `createRule + updateRule + deleteRule + evaluateRules` 的
  spy 调用数合计为 **0**——证明拦在处理器之前，不是"执行完再返回 403"。
- 身份用例故意同时带 `x-user-id: u-spoofed`，断言 `created_by` 是 `u-realadmin`，
  且**不是** `u-spoofed`、**不是** `system`。
- POST 请求体每个字段都填了合法值，避免 400 冒充成门（`VALID_CREATE_BODY`）。

## 3. 变异（每条守卫都有"去掉它就红"的证据）

变异在**内存里**做：用一个只存在于 scratchpad 的 vitest 配置，在 transform 阶段改
`protection-rules.ts` 的源码字符串再交给 vite。磁盘上的源文件全程未被修改，
也不存在需要回滚的残留。锚点字符串找不到时探针**直接抛错**，
所以不可能出现"变异没打上却报绿"的假阳性。

| 变异 | 改动 | 结果 | 点名 |
| --- | --- | --- | --- |
| M1 | 只摘掉 `POST /` 的 `requireAdminRole()`（其余三条保留） | **4 failed \| 4 passed (8)** | 见下 |
| M2 | 创建者改回 `req.headers['x-user-id'] \|\| 'system'` | **1 failed \| 7 passed (8)** | 身份用例 |
| M3 | 限流 key 改回 `req.headers['x-user-id'] \|\| 'anon'` | **1 failed \| 7 passed (8)** | 限流用例 |

M1 原样：

```
[w4a-mutation M1] APPLIED IN MEMORY: remove requireAdminRole() from POST /
   → expected 403 "Forbidden", got 201 "Created"
   → expected 403 "Forbidden", got 201 "Created"
   → expected 403 "Forbidden", got 500 "Internal Server Error"
   → expected 503 "Service Unavailable", got 201 "Created"
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 4 ⎯⎯⎯⎯⎯⎯⎯
 Test Files  1 failed (1)
      Tests  4 failed | 4 passed (8)
```

第三条那个 `got 500` 值得单独说：未认证场景下门被摘掉后，请求走到处理器，
`getUserId` 抛"unauthenticated"，于是 500。这正是设计文档 §2.2 讲的第二道防线——
门没了也不会拿 `'system'` 顶上去把规则写进库，而是炸掉。500 不是正确答案（403 才是），
但它证明了兜底没有悄悄放行。

M2 原样：

```
[w4a-mutation M2] APPLIED IN MEMORY: creator identity back to the x-user-id header
   → expected 'u-spoofed' to be 'u-realadmin' // Object.is equality
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
 Test Files  1 failed (1)
      Tests  1 failed | 7 passed (8)
```

M3 原样：

```
[w4a-mutation M3] APPLIED IN MEMORY: rate-limit key back to the x-user-id header
   → expected [ 200, 200, 200, 200, 200, 200, …(5) ] to include 429
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯
 Test Files  1 failed (1)
      Tests  1 failed | 7 passed (8)
```

M3 把洞展示得最直白：同一个主体发 11 次请求、每次换一个 `x-user-id` 值，
11 次全是 200——10 次/60 秒的限制被整个绕过。key 换成主体之后第 11 次是 429。
（该用例断言的是"11 个状态码里出现过 429"而不是"第 11 个是 429"，
这样在 CI 的 `retry` 重跑、桶已经是满的时候也不会假红。）

## 4. 相邻 spec

`grep -rl "protection-rules\|protectionRuleService\|snapshot-protection" packages/core-backend/tests` 命中 5 个，
其中 1 个是本次新增的。另外用 `grep -rl "safety/rules"` 补搜了一遍，多出
`change-management-authz.test.ts`（同一个守卫的邻居），也一并跑。实跑 7 个文件：

```
 Test Files  7 passed (7)
      Tests  57 passed (57)
```

清单：`protection-rules-authz`（新增）、`IntegrationSimulation`、`SnapshotService.labels`、
`SnapshotService`、`snapshot-labels-authz`、`snapshots-authz`、`change-management-authz`。

**本机跳过、CI 真库实跑**：`tests/integration/snapshot-protection.test.ts` 命中了 grep，本机无 PG 没跑。
它在无库 `vitest.config.ts:1533` 的排除表里，但**不是**「任何 CI 作业都不跑」（复核订正）：
`.github/workflows/plugin-tests.yml:1285-1294` 的「Run snapshot-protection E2E (GHSA-h8mf authz)」在 `test (20.x)` 上
用真 PG 跑它，演员由该文件 `:51-56` 种进 `user_roles` 成 admin。本 PR 的 plugin-tests 运行 34689744663 该步骤 **success**——
这是四条写端点「admin 行为不变」在真库整链上的证据。它带的 `x-user-id` 头在修复后被忽略，身份取自 `req.user`（admin），故仍绿。

## 5. 类型检查

`npx tsc --noEmit`（在 `packages/core-backend` 下）：

```
TSC_EXIT=0
```

零输出、零错误。

## 6. 新 spec 会不会被无库 CI 收

会。`packages/core-backend/vitest.config.ts` **没有设置 `include`**，
走 vitest 默认的 `**/*.{test,spec}.?(c|m)[jt]s?(x)`；
`exclude` 数组（:31–:1761）里逐条列的是具体的 integration 文件路径，
没有任何一条覆盖 `tests/unit/**`。新文件落在 `tests/unit/protection-rules-authz.test.ts`，
默认被收。它也不需要数据库——`db/pg` 的 `pool` 被 mock 成 `null`，
`isAdmin` 整个模块被 mock，跑起来不碰任何外部依赖（上面 §2 的 8 passed 就是无库跑出来的）。
