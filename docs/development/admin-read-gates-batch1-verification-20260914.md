# admin 读端点补管理员门（批次 1）验证记录 — 2026-09-14

分支 `fix/admin-read-gates-batch1`，基线 `origin/fix/protection-rules-require-admin-and-identity`（PR #5677，HEAD `5b52fa34a`）。
设计见 `docs/development/admin-read-gates-batch1-design-20260914.md`。

跑法：`packages/core-backend` 下 `npx vitest run <file> --reporter=dot`；类型检查 `npx tsc --noEmit`。
本机 Windows 11 + node 20 + pnpm 9.15.9 + vitest 1.6.1（`pnpm install --frozen-lockfile` 已跑）。

## 1. 先红

先写断言、不改产品代码，跑一次：

| 套件 | 结果 |
| --- | --- |
| `tests/unit/admin-dlq-read-authz.test.ts`（新增） | **5 failed / 1 passed（6）** |
| `tests/unit/protection-rules-authz.test.ts`（扩展） | **3 failed / 9 passed（12）** |

红的样子（摘自 dot reporter）：

```
FAIL  tests/unit/admin-dlq-read-authz.test.ts > ... > RBAC lookup throwing -> 503 fail-closed, DLQ never queried
Error: expected 503 "Service Unavailable", got 200 "OK"

FAIL  tests/unit/admin-dlq-read-authz.test.ts > ... > the gate is the FIRST handler on the route, not something after the query
AssertionError: expected 1 to be greater than or equal to 2

FAIL  tests/unit/protection-rules-authz.test.ts > ... > non-admin -> 403 ADMIN_REQUIRED on GET / and GET /:id, NO read service call
Error: expected 403 "Forbidden", got 200 "OK"
FAIL  tests/unit/protection-rules-authz.test.ts > ... > unauthenticated (no req.user) -> 403 on both reads, no read service call
Error: expected 403 "Forbidden", got 200 "OK"
FAIL  tests/unit/protection-rules-authz.test.ts > ... > RBAC check failure on a read -> 503 fail-closed, no read service call
Error: expected 503 "Service Unavailable", got 200 "OK"
```

`admin-dlq-read-authz.test.ts` 里唯一先绿的那条是"管理员 -> 200"——没有门的时候人人都是 200，正好说明它单独不构成证据，真正的证据是另外 5 条。
`protection-rules-authz.test.ts` 里先绿的 9 条是 #5677 的写端点用例（本 PR 没有削弱它们）。

`GET /dlq` 与两条 rules 读**只在无门时是 200**，这一步同时实证了盘点结论：改动前它们对非管理员、乃至对无 `req.user` 的请求都返回 200。

## 2. 后绿

加上三处 `requireAdminRole()` 之后（含后补的限流顺序用例）：

```
Test Files  2 passed (2)
     Tests  19 passed (19)
```

拆分：`admin-dlq-read-authz.test.ts` 6/6，`protection-rules-authz.test.ts` 13/13。

覆盖到的语义：
- 非管理员 → 403 `ADMIN_REQUIRED`，且 `dlqService.list` / `listRules` / `getRule` **一次都没被调用**（403 之后才查库就意味着门挂错了位置）
- 无 `req.user` → 403
- `isAdmin` 抛 → 503 `RBAC_CHECK_FAILED`，同样不查库
- 管理员 → 200，响应体与查询参数透传（`{status, limit}`、`{target_type, is_active}`）逐字段断言，防"把查询拆了冒充加门"
- `GET /dlq` 的守卫位于路由 handler 栈的第 0 位（结构性兜底）
- 限流器仍在门之前：非管理员连打 11 次，状态码序列里同时出现 403 与 429

## 3. 变异（内存级，不落盘改源码）

探针不改任何源码文件：先构造真实 router，再把某一条路由 express layer 的 `handle[0]`（也就是那个门）从内存栈里 `splice` 掉，然后断言"那条端点的拒绝行为消失了"。探针文件跑完即删，不入库。

| 变异 | 断言 | 结果 |
| --- | --- | --- |
| MUTANT 1：摘掉 `GET /dlq` 的门 | 非管理员拿到 200 且 `dlqService.list` 被调用 1 次 | ✓ 复现泄漏 |
| MUTANT 2：摘掉 `safety/rules GET /` 的门 | 非管理员拿到 200 且 `listRules` 被调用；**同文件的 `GET /:id` 仍然 403 且 `getRule` 未被调用** | ✓ 复现泄漏，且证明是"逐个门"而非"一摘全塌" |
| MUTANT 3：再摘掉 `GET /:id` 的门 | 非管理员拿到 200 且 `getRule` 被调用 1 次 | ✓ 复现泄漏 |

```
✓ MUTANT 1: drop the gate on GET /dlq -> non-admin 200 and dead_letter_queue IS read
✓ MUTANT 2: drop the gate on protection-rules GET / -> non-admin 200 and listRules IS called
✓ MUTANT 3: drop the gate on protection-rules GET /:id -> non-admin 200 and getRule IS called
Test Files  1 passed (1)
     Tests  3 passed (3)
```

MUTANT 2 里那条"兄弟端点仍然 403"的附加断言是关键：它排除了"三条用例其实靠同一个门过"的可能，每个门单独可证伪。

## 4. 相邻套件

```
npx vitest run tests/unit/admin-dlq-read-authz.test.ts tests/unit/protection-rules-authz.test.ts \
  tests/unit/admin-yjs-status-routes.test.ts tests/unit/admin-snapshot-delete-authz.test.ts \
  tests/unit/admin-safety-confirm-authz.test.ts tests/unit/snapshot-labels-authz.test.ts \
  tests/unit/safety-guard-confirm-flow.test.ts tests/unit/snapshots-safety-guard.test.ts \
  tests/unit/change-management-authz.test.ts --reporter=dot

Test Files  9 passed (9)
     Tests  61 passed (61)
```

（61 = 本 PR 两条套件的 19 + 其余 7 条套件的 42；两条被改套件单独复跑同样是 19/19。）
其中 `admin-snapshot-delete-authz.test.ts` / `snapshot-labels-authz.test.ts` / `admin-safety-confirm-authz.test.ts` 是同一批 admin 授权守卫，`safety-guard-confirm-flow` / `snapshots-safety-guard` 覆盖确认令牌链路——加 GET 门没有回归它们。

## 5. 类型检查

- `npx tsc --noEmit`（包自带 `tsconfig.json`，`exclude` 含 `**/*.test.ts`）：**exit 0**。
- 包 tsconfig 排除了测试文件，所以两个 spec 用一份**临时** tsconfig 单独查（`include` = `src/**/*` + `types/**/*` + 本 PR 的两个 spec + `tests/utils/pinned-server.ts`，`exclude` 追加 `src/**/*.test.ts`、`src/**/__tests__/**` 以避开与本 PR 无关的既有 `src/__tests__` 类型错误）：**exit 0**。临时文件跑完即删，**未入库**（`git status` 已确认工作区只剩本 PR 的 4 个文件）。

## 6. 未做 / 无法在本机验证

- 未跑 core-backend 全量单测（只跑了被改套件与 9 个相邻套件）；CI 是裁判。
- `.github/workflows/safety-guard-e2e.yml` 会被本 PR 触发（`paths:` 含 `admin-routes.ts`），但需要 Postgres service，本机没跑；已静态查证 `scripts/test-safety-guard-e2e.sh` 对 `dlq` / `safety/rules` 的匹配数为 0，即它不碰这三条端点。
- `scripts/verify-sprint2-staging.sh` 需要 staging 环境与 API token，本机未实跑；对它的影响判断（非管理员 token 下前 10 次 200→403、第 11 次仍 429、脚本断言仍 PASS）由单测里的限流顺序用例支撑，不是纯推理，但不等于 staging 实跑。
- 仓库外的调用方（自建看板、人工 curl）无法证伪；仓库内已查证为零调用方。

## 复核补充（查找者第二轮）

- **真库 E2E 经过新门**：`tests/integration/snapshot-protection.test.ts:332/366/378` 直接打 `GET /api/admin/safety/rules` 与 `GET /:id` 并断言 200——不红是因为 `:47-56` 的 `beforeAll` 显式 `INSERT INTO user_roles (…,'admin')` 把测试用户提成平台管理员（GHSA-h8mf 时为写端点加的），限流桶也远未触顶。这是**顺带覆盖而非本 PR 设计的验证**；base 改 main 后该泳道（`plugin-tests.yml:1285-1292`，20.x 真 PG）会在本 PR 上实跑，成为三条门的真库证据。
- **CI 影响面订正**：改 base 前，跑新单测的泳道（`:842-844`）与跑这套 E2E 的泳道同属 `plugin-tests.yml`，都被 `pull_request: branches: [main, develop]` 排除——即三条门在合并前**两条证据链同时缺席**；改 base 后 26 项检查、2 条 test 泳道 + E2E 泳道齐全。
- **脚本第二份**：`verify-sprint2-staging.sh` 有两份（根 `scripts/` 与 `packages/core-backend/scripts/`），后者 `:332` 也 `GET /api/admin/safety/rules`，同样只在非管理员 token 下由 200 变 403、脚本结果不变。

