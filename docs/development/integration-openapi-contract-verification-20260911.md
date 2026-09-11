# G44 — 数据工厂对外契约的第一刀（只读面）· 验证

- 日期：2026-09-11
- 分支：`feat/integration-openapi-contract`，基于 `5f4b32122`
- 设计文档：`docs/development/integration-openapi-contract-design-20260911.md`

---

## 1. 测试清单与实际数字

### 1.1 新增测试

| 文件 | 用例数 | 内容 |
| --- | --- | --- |
| `packages/core-backend/tests/unit/integration-oapi-read-allowlist.test.ts` | 59 | 24 条正例、凭据/方法拒绝例、32 条路径绕过负例、三组 lockstep 对拍、防绕过性质测试 |
| `packages/core-backend/tests/unit/integration-api-token-gate.test.ts` | 38 | 穿透、允许表前置拒绝（16 条）、门 1、门 2、身份形状、租户来源 |

### 1.2 改动的既有测试

`packages/core-backend/tests/unit/api-path-policy.guard.test.ts` — 加一条具名豁免。见 §2，这是**我的改动先把它跑红了**，不是顺手加的。

### 1.3 实跑结果（原样）

新增两支 + 受影响守卫 + 相邻既有 token 测试，最终状态（4 + 59 + 38 + 14 + 46 = 161）：

```
 ✓ tests/unit/api-path-policy.guard.test.ts  (4 tests)
 ✓ tests/unit/integration-oapi-read-allowlist.test.ts  (59 tests)
 ✓ tests/unit/integration-api-token-gate.test.ts  (38 tests)
 ✓ tests/unit/multitable-oapi-read-allowlist.test.ts  (14 tests)
 ✓ tests/unit/api-token-webhook.test.ts  (46 tests) 919ms

 Test Files  5 passed (5)
      Tests  161 passed (161)
   Duration  3.45s
```

过程记录：gate 测试最初是 36 条，第一轮变异（§4.2）显示 M3/M4 各只红 1 条，于是补了两条正交断言，变成 38 条；上面的 161 是补完之后的数字。

### 1.4 type-check

```
cd packages/core-backend && npx tsc --noEmit
EXIT=0
```

### 1.5 lint —— 没跑，并说明为什么

`packages/core-backend` **没有** `lint` 脚本，也**没有**安装 eslint（`ls node_modules/eslint` 无命中，`package.json` 的 scripts 里没有 lint）。仓库根 `package.json:117` 的 `"lint": "pnpm -r lint"` 在本仓库只会命中 `apps/web`，而本 PR 不改前端。`packages/core-backend/.eslintrc.json` 存在但没有可执行的 runner。

**结论：后端 lint 无从跑起，我没跑。** 不谎称跑过。

### 1.6 OpenAPI 构建与校验

```
cd packages/openapi && pnpm run build
  ... 'integration.yml' ... （parts 列表含新文件）

pnpm run validate
> tsx tools/validate.ts dist/openapi.yaml
OpenAPI security validation passed
```

路径计数：

```
total paths: 322
integration paths: 24
```

`dist/` 在本仓库是**被 git 跟踪**的产物，所以重建后的三个文件一并提交。diff 是纯新增：

```
 packages/openapi/dist/combined.openapi.yml | 1092 +++++++++++++
 packages/openapi/dist/openapi.json         | 1632 ++++++++++++++++++++
 packages/openapi/dist/openapi.yaml         | 1092 +++++++++++++
 3 files changed, 3816 insertions(+)
```

无重排、无删除。

---

## 2. 测试抓到的一个真实缺陷（我自己的）

`tests/unit/api-path-policy.guard.test.ts` 在我加完代码后变红，报了 25 处：

```
AssertionError: These compare request paths against /api literals instead of using the shared policy
in auth/api-path-policy.ts. ...: expected [ …(25) ] to deeply equal []

+   "integration/oapi-integration-read-allowlist.ts:92 — regexp anchored on /api (/^\\/api)",
+   ... （共 25 条）
```

这条守卫是对的，而且它逼出了一个**真的洞**。我原本给子树判断写的是自己的正则：

```ts
const INTEGRATION_PATH_PATTERN = /^\/api\/integration(?:\/|$)/    // 大小写敏感
```

而 Express 以 `caseSensitive: false` 路由，`/API/INTEGRATION/PIPELINES` 实测确实会被派到 pipelines handler（§3 探针第 3 行）。于是带 `mst_` 的大写路径**穿过**了我的门（走 `next()`），把拒绝完全丢给上面全局闸门的执行顺序——这正好抵消了我加那条兜底 401 的意义。

`integration-api-token-gate.test.ts` 的用例 `REFUSES 401 and never validates the token: GET /API/INTEGRATION/PIPELINES` 当场把它照出来。

修法（两处，方向相反且各有理由）：

- 子树判断改调共享策略 `apiPathHasPrefix`（`oapi-integration-read-allowlist.ts:168-170`）——大小写不敏感、容忍尾斜杠、segment 锚定，和路由器一致。放宽它只能产生更多**拒绝**。
- 24 条路由身份正则保持锚定 + 大小写敏感，并在守卫里补具名豁免，理由写清"只覆盖路由身份，子树那问已经走共享策略"。

---

## 3. 用真实 Express 实测的派发对照（不是推断）

用 `packages/core-backend/node_modules/express` 起探针，实测 `req.path` 与派发落点：

```
GET /api/integration/pipelines            -> status=200 reqPath="/api/integration/pipelines"            {"hit":"pipelinesList","params":{}}
GET /api/integration/pipelines/           -> status=200 reqPath="/api/integration/pipelines/"           {"hit":"pipelinesList","params":{}}
GET /API/INTEGRATION/PIPELINES            -> status=200 reqPath="/API/INTEGRATION/PIPELINES"            {"hit":"pipelinesList","params":{}}
GET /api/Integration/pipelines            -> status=200 reqPath="/api/Integration/pipelines"            {"hit":"pipelinesList","params":{}}
GET /api/integration/pipelines/p1         -> status=200 reqPath="/api/integration/pipelines/p1"         {"hit":"pipelinesGet","params":{"id":"p1"}}
GET /api/integration/pipelines/p1%2frun   -> status=200 reqPath="/api/integration/pipelines/p1%2frun"   {"hit":"pipelinesGet","params":{"id":"p1/run"}}
GET /api/integration/pipelines/p1%2Frun   -> status=200 reqPath="/api/integration/pipelines/p1%2Frun"   {"hit":"pipelinesGet","params":{"id":"p1/run"}}
GET /api/integration/pipelines/%2E%2E     -> status=200 reqPath="/api/integration/pipelines/%2E%2E"     {"hit":"pipelinesGet","params":{"id":".."}}
GET /api/integration/pipelines/%2e%2e     -> status=200 reqPath="/api/integration/pipelines/%2e%2e"     {"hit":"pipelinesGet","params":{"id":".."}}
GET /api/integration/pipelines/../table-actions       -> status=404 {"hit":null}
GET /api/integration/pipelines/%2e%2e/table-actions   -> status=404 {"hit":null}
GET /api/integration//pipelines           -> status=404 {"hit":null}
GET /api/integration/pipelines;a=b        -> status=404 {"hit":null}
GET /api/integration/pipelines?x=1        -> status=200 reqPath="/api/integration/pipelines"            {"hit":"pipelinesList","params":{}}
HEAD /api/integration/pipelines           -> status=200 reqPath="/api/integration/pipelines"
POST /api/integration/pipelines/p1/run    -> status=200 reqPath="/api/integration/pipelines/p1/run"     {"hit":"pipelinesRun","params":{"id":"p1"}}
```

**两条被实测推翻的预期（诚实记录）**：`p1%2frun` 和 `%2E%2E` 我原本写成"必须拒绝"，实测表明匹配器与路由器**一致**地把它们当作一个 segment，落点是已声明的 `pipelinesGet`，`POST .../run` 依然不可达。于是把这两条从"拒绝battery"移到一条具名的"放行且可证明安全"用例里，并把防绕过改写成性质断言。

性质断言（`integration-oapi-read-allowlist.test.ts`）：按插件 ROUTES 表建 122 条真实注册，对 700+ 组 (method, path) 探针断言

> 匹配器放行 ⟹ Express 派给**已声明的 GET handler**

反方向不断言（匹配器本就更窄；三类欠匹配——大小写、尾斜杠、HEAD——单列一条用例钉为 fail-closed）。

---

## 4. 变异自证：11 项，全部致红

### 4.1 方法

变异**只作用于 scratchpad 里的一份基线树副本**（`git archive 5f4b32122` 展开 + junction 复用 node_modules），把我的改动文件复制进去后再改坏。**工作树全程未被改动一个字节**——变异跑完后 `git status --short` 与跑前逐行一致（见 §4.3）。

基线（未变异的副本）：`Test Files 3 passed (3) / Tests 101 passed (101)`。

三支 spec：`integration-oapi-read-allowlist.test.ts` + `integration-api-token-gate.test.ts` + `api-path-policy.guard.test.ts`。

### 4.2 结果表

| 探针 | 改坏了什么 | 红掉的用例数 | 代表性红用例 |
| --- | --- | --- | --- |
| **M1** | 删掉匹配器的 `if (method !== 'GET') return false`（`oapi-integration-read-allowlist.ts:174`） | **11 / 101** | `DENIES every non-GET method on every declared route`；`the write surface is specifically unreachable`；`EVERY admitted … dispatches to a DECLARED GET handler`；`the mst_ token cannot reach POST run or any dry-run by name`；`REFUSES 401 …: DELETE /api/integration/external-systems/s1`、`HEAD …`、`PUT …/conflict-policies` |
| **M2** | 把 `/pipelines/:id` 的锚定 `$` 去掉（改成前缀匹配） | **9 / 101** | `REFUSES literal dot-dot climb into a write route`；`REFUSES deeper segment under a param route: /api/integration/pipelines/p1/run`；`REFUSES trailing slash on param route`；`REFUSES percent-encoded dot-dot`；`EVERY admitted … dispatches to a DECLARED GET handler` |
| **M3** | 删掉门 2（creator 的 RBAC 校验，`integration-api-token-gate.ts:169-171`） | **2 / 101** | `scope present but creator lacks the integration:read permission code → 403 FORBIDDEN`；`an RBAC-denied request leaves the identity UNHYDRATED` |
| **M4** | 删掉门 1b（token scope 校验，`:156-159`） | **2 / 101** | `scopes WITHOUT integration:read → 403 INSUFFICIENT_SCOPE, and RBAC is never consulted`；`a scope-denied request leaves the identity UNHYDRATED and never reaches the tenant resolver` |
| **M5** | 无服务端租户时**回落**到 `x-tenant-id` 请求头 | **1 / 101** | `the x-tenant-id header cannot supply a tenant when the creator has none` |
| **M6** | 给装配出的身份加 `role: 'admin'` | **4 / 101** | `admits, and carries EXACTLY one permission code — no role, no roles`；`the identity cannot satisfy the plugin's admin or tenantless-platform-admin branches`；`a pre-set req.user is fully replaced, not merged`；`an ambiguous/absent creator membership yields NO tenant` |
| **M7** | 删掉门里自己的允许表前置检查（`:137-145`），只靠全局闸门顺序 | **16 / 101** | 整个 `REFUSES 401 and never validates the token:` 系列全红：`POST …/run`、`POST …/dry-run`、`POST …/apply`、`DELETE …/external-systems/s1`、`GET …/health`、`GET …/source-preflight`、`GET …/source-binding`、`GET …/audit`、`GET /API/INTEGRATION/PIPELINES`、`HEAD …` 等 |
| **M8** | 删掉子树判断（`:134`），让门也拦 multitable token 流量 | **2 / 101** | `an mst_ token on a MULTITABLE path passes through untouched`；`a lookalike prefix is not the integration subtree` |
| **M9** | 从 `isOapiAllowlistRequest` 的 OR 里摘掉 integration 项（`oapi-read-allowlist.ts:129`） | **1 / 101** | `the global OAPI switch admits them too (index.ts consults only that one)` |
| **M10** | 只从 `integration.yml` 删一条已声明路径（契约/允许表漂移） | **3 / 101** | `contract path set === allowlist path set`；`every contract operation is a GET and carries the integration:read token-scope marker`；`the contract scan is not vacuous` |
| **M11** | 让 `x-tenant-id` 请求头**优先于**服务端推导的租户 | **2 / 101** | `the x-tenant-id REQUEST HEADER is ignored — it never becomes the token's tenant`；`the x-tenant-id header cannot supply a tenant when the creator has none` |

**11 / 11 致红，没有负结果。**

两点诚实标注：

- M3、M4、M5 的红用例数偏少（2/2/1）。M4 的那条"scopes WITHOUT integration:read"内部遍历 4 种 scope 形状（空、`records:read`、三项组合、`integration:write`），是 1 个用例 4 组断言，不是只测了一种。第一轮跑 M3/M4 各只红 1 条，我因此**补了两条正交断言**（RBAC 拒绝后身份未被装配；scope 拒绝后身份未被装配且租户解析器根本没被调用），把各自提到 2 条。我没有为了凑数字再拆用例。
- M5 与 M11 是同一处的两种改坏方式，故意都跑：M5（回落）只红"请求头不能在 creator 无租户时供租户"，M11（优先）额外红"请求头被忽略"。两条断言各自承重，缺一条就会有一种改坏方式漏网。

### 4.3 工作树未被污染的证据

变异跑完后：

```
 M packages/core-backend/src/index.ts
 M packages/core-backend/src/multitable/api-tokens.ts
 M packages/core-backend/src/multitable/oapi-read-allowlist.ts
 M packages/core-backend/tests/unit/api-path-policy.guard.test.ts
 M packages/openapi/dist/combined.openapi.yml
 M packages/openapi/dist/openapi.json
 M packages/openapi/dist/openapi.yaml
?? packages/core-backend/src/integration/oapi-integration-read-allowlist.ts
?? packages/core-backend/src/middleware/integration-api-token-gate.ts
?? packages/core-backend/tests/unit/integration-api-token-gate.test.ts
?? packages/core-backend/tests/unit/integration-oapi-read-allowlist.test.ts
?? packages/openapi/src/paths/integration.yml
```

与变异前完全一致，且随后重跑三支 spec 仍为全绿。

---

## 5. 全量 unit 套件：与基线对拍，零回归

Windows 本机全量跑必有既有噪音，所以**先和基线对拍再下结论**。

方法：`git archive 5f4b32122 packages/core-backend packages/openapi plugins` 展开到 scratchpad（74MB），用 junction 复用同一份 node_modules，在**未被我改动的基线树**上跑同一套 `tests/unit`。这全程只读仓库，没有 `git stash`、没有切分支、没有 `worktree` 操作。

| | 我的树 | 基线树（部分展开） |
| --- | --- | --- |
| Test Files | **26 failed** / 713 passed (739) | 42 failed / 695 passed (737) |
| Tests | **51 failed** / 10874 passed (10925) | 66 failed / 10672 passed (10738) |

集合差：

```
=== failing in MINE but NOT in BASE (would be regressions) ===
（空）
```

**我的树里失败的 26 个文件，全部在未改动的基线树上也失败。零回归。**

基线树多出的 16 个失败是部分展开的产物（那些测试引用 `apps/web` / `.github/workflows` / `docs/` / `scripts/`，我没有展开这些目录），不是基线真实基线。所以此处用**集合包含关系**下结论，而不是用计数差。

### 5.1 既有噪音的机理（抽查三条，全部定位到根因）

**`multitable-oapi-allowlist-guard-tripwire.test.ts`** — `expected 0 to be greater than 50`，即源码扫描读到 **0 条路由**。根因是 CRLF：该测试用 `src.split('\n')` 切行，行尾留下 `\r`；它的正则 `^\s*router\.(…)\(\s*'([^']+)'\s*,(.*)$` 里 JS 的 `.` **不匹配 `\r`**，而无 `m` 标志的 `$` 只在字符串末尾成立，于是每行都匹配失败。实测：

```
has CRLF: true
matched: 0 []
lines starting with router.: 102 ["  router.get('/bases', async (req: Request, res: Response) => {\r", ...]
```

在 LF 检出的 CI 上正常。与本 PR 无关（该测试只扫 `routes/univer-meta.ts` / `routes/comments.ts`，我没动这两个文件）。

顺带说明：我新增的两支测试的所有源码扫描都用 `/\r?\n/` 切行，并且每处都有"扫描结果非空"的兜底断言（`PLUGIN_ROUTES.length > 100`、`HANDLER_GATES.size > 80`、`contractPaths.length === 24`、探针语料 `> 700`），所以 CRLF 或风格变更**不会**把这些 tripwire 变成空过。

**`runtime-dependency-classification.test.ts`** — 报 `@opentelemetry/api (eager import at src\core\logger.ts)`、`js-yaml (… src\services\ConfigService.ts)`，反斜杠路径分隔符导致豁免表比对不上。Windows 路径规范化问题，涉及的是既有文件，与本 PR 无关。

**`multitable-recovery-archive-object-store.test.ts`** — `EPERM: operation not permitted, symlink`，Windows 建符号链接需要管理员权限。环境问题。

其余（approval-*/attendance-*/elearning-* 等）同属这三类形态。CI 才是裁判。

---

## 6. 覆盖矩阵（派活要求的四类，逐条对位）

| 要求 | 落在哪 | 条数 |
| --- | --- | --- |
| 每条允许的 GET 正例 | `every declared route is admitted for an mst_ GET`（24 条集合断言）+ `the global OAPI switch admits them too` + gate 测试 `every declared read path is admitted through the gate`（24 条逐条走完整门） | 24 × 3 |
| 每条未允许方法/路径的拒绝例 | `DENIES every non-GET method on every declared route`（24 路径 × 9 方法）+ `every OTHER registered (method, path) in the plugin is REJECTED`（122 条路由全量对拍）+ `the write surface is specifically unreachable`（60+ 条写路由）+ `the mst_ token cannot reach POST run or any dry-run by name`（13 条具名）+ gate 的 `REFUSES 401 and never validates the token`（16 条） | 全量 + 29 条具名 |
| 无 `integration:read` 权限时的拒绝例 | `scope present but creator lacks the integration:read permission code → 403 FORBIDDEN`（门 2）+ `an RBAC-denied request leaves the identity UNHYDRATED` + `scopes WITHOUT integration:read → 403`（门 1，4 种 scope 形状）+ `a scope-denied request leaves the identity UNHYDRATED` | 4 |
| 路径匹配的绕过负例 | `path bypass battery` 32 条具名（大小写 3 种、尾斜杠 2 种、双斜杠 2 种、`..` 3 种、百分号编码 3 种、query/fragment/matrix/null-byte/空白 6 种、lookalike 前缀 3 种、越界 segment 5 种、子树根 2 种）+ 防绕过性质测试 700+ 组探针对真实路由器 | 32 + 700+ |

---

## 7. 没跑的、和不确定的

1. **后端 lint 没跑** —— 无 runner，见 §1.5。
2. **集成 / e2e 没跑** —— 只跑 unit 层。真实 `apiTokenAuth` → 真库 `userHasPermission` → `resolveSessionTenantId` → 插件 handler 的整链没有端到端跑过。门里三个依赖都做成可注入 seam，unit 层注入了替身。
3. **插件自己的测试套件（`plugins/plugin-integration-core/__tests__`）没跑** —— 本 PR 一个字节都没改该插件，判断为不受影响，但没有实跑证据。
4. **222 / 任何真实部署没验证** —— 不知道目标部署的 `integration` 命名空间准入是否已启用、`integration:read` 权限码是否已种。两者缺失的结果都是 403（fail-closed）。
5. **前端选不出这个作用域** —— `MetaApiTokenManager.vue:491` 硬编码六项。后端 API 可以创建（`routes/api-tokens.ts:42` 走 `ALL_API_TOKEN_SCOPES`），UI 暂时不行。刻意不做。
6. **`%2f` / `%2E%2E` 的放行** —— 已用真实路由器证明落点是已声明的 GET（§3），但这依赖 Express 4 的当前解码时机（路由用未解码 pathname，`req.params` 事后 `decodeURIComponent`）。若将来换路由器或加一层会规范化路径的反代，这个结论需要重测。性质测试会抓到，前提是有人在那次变更时跑它。
7. **读侧无 per-token 限流** —— 见设计文档 §6.7。
