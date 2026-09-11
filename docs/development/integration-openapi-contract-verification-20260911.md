# G44 — 数据工厂对外契约的第一刀（只读面）· 验证

- 日期：2026-09-11（第二版：对抗复核终审返修后）
- 分支：`feat/integration-openapi-contract`，基于 `5f4b32122`
- 设计文档：`docs/development/integration-openapi-contract-design-20260911.md`

**本版相对第一版的变化**：终审判定"修完 3 项再合"。X1（重新生成 `packages/openapi/dist-sdk/index.d.ts`）已由派活方在 `128f552bc` 完成，本轮**没有再动任何 openapi 产物**，也没有重跑 `generate:sdk`（见 §7）。X2（base/sheet 受限 token fail-closed）、X3（门体 try/catch 答 503 + 删掉假件背书的测试名）以及四条建议在本轮落地，新增变异 11 项（§4.4）。

---

## 1. 测试清单与实际数字

### 1.1 新增测试

| 文件 | 用例数 | 内容 |
| --- | --- | --- |
| `packages/core-backend/tests/unit/integration-oapi-read-allowlist.test.ts` | **65**（第一版 59） | 24 条正例、凭据/方法拒绝例、32 条路径绕过负例、三组 lockstep 对拍、防绕过性质测试；**新增 6 条**：子树 AND 约束（注入一条 pattern 逃出子树的坏行、断言仍拒、再还原），含探针非空性与表完整性两条兜底 |
| `packages/core-backend/tests/unit/integration-api-token-gate.test.ts` | **59**（第一版 38） | 穿透、允许表前置拒绝（16 条）、门 1、门 2、身份形状、租户来源；**新增 21 条**：门 1c base/sheet 围栏（7）、授权后端抛错答 503（4，替换掉原先那条名字写错的）、挂载序守卫（3 运行时 + 6 源码接线）、默认 seam 是真实实现（2） |

### 1.2 改动的既有测试

`packages/core-backend/tests/unit/api-path-policy.guard.test.ts` — 加一条具名豁免。见 §2，这是**我的改动先把它跑红了**，不是顺手加的。

### 1.3 实跑结果（原样）

新增两支 + 受影响守卫 + 相邻既有 token 测试，返修后状态（4 + 65 + 59 + 14 + 46 = 188）：

```
 Test Files  5 passed (5)
      Tests  188 passed (188)
   Duration  2.16s (transform 564ms, setup 705ms, collect 2.02s, tests 1.40s, environment 1ms, prepare 1.03s)
```

只跑两支新增 spec 时：`Test Files 2 passed (2) / Tests 124 passed (124)`（65 + 59）。第一版是 97（59 + 38）。

过程记录：gate 测试最初是 36 条，第一轮变异显示 M3/M4 各只红 1 条，于是补了两条正交断言，变成 38 条；本轮返修再补到 59 条。

### 1.4 type-check

```
cd packages/core-backend && npx tsc --noEmit
exit=0
```

仓库的 `tsconfig.json` 把 `**/*.test.ts` 排除在外，所以上面那条**不覆盖本 PR 的两支测试**。为了不留死角，另用一份临时 config（只在 include 里加这两个测试文件、其余排除项保持原样）再跑一次，跑完即删：

```
npx tsc --noEmit -p tsconfig.g44check.json
exit=0
```

这一步抓到并修掉了一条**既有**的类型错：`beforeEach(() => vi.clearAllMocks())` 的简写体返回 `VitestUtils`，不是 `Awaitable<HookCleanupCallback>`（`TS2322`）。已改成带花括号的形式。临时 config 未提交，跑完 `git status` 只剩本 PR 自己的改动。

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

**X1 补记（终审的阻断项）**：第一版漏了 SDK 那一条腿。`.github/workflows/plugin-tests.yml:800-802` 在 job `test` 里跑 `pnpm --filter @metasheet/openapi generate:sdk` 然后 `git diff --exit-code -- packages/openapi/dist packages/openapi/dist-sdk/index.d.ts`，而 `generate:sdk` = `build && pnpm --dir dist-sdk build`（`packages/openapi/package.json:10`），`dist-sdk/scripts/build.mjs:9,18-28` 会用 openapi-typescript 从 `dist/openapi.yaml` 重生成 `index.d.ts`。第一版只提交了 `dist/` 三个产物，`dist-sdk/index.d.ts` 仍是 PR 前镜像（298 条路径键 vs dist 的 322），CI 必红。

这一条**由派活方在 commit `128f552bc` 补齐**（`packages/openapi/dist-sdk/index.d.ts` +1179 行、24 个新路径键）。**本轮返修没有再动任何 openapi 产物，也没有重跑 `generate:sdk`**——本地没装 openapi-typescript，且磁盘余量不允许 `pnpm install`。所以"重跑 generate:sdk 后 diff 为空"这件事**我没有实测**，只能靠 CI 判定（记在 §7）。

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

## 4. 变异自证：两轮共 22 项

第一轮 11 项（§4.1-4.3，第一版）全部一次致红。第二轮 11 项（§4.4，本次返修）10 项一次致红，1 项**先出负结果**——而且那条负结果暴露的是我自己新写的守卫的漏洞，已修好后重跑致红。

### 4.1 第一轮的方法

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

### 4.4 第二轮变异（终审返修的三项 + 两条硬化），11 项，10 项一次致红、1 项**先出负结果再修好守卫**

方法与第一轮不同，原因是磁盘只剩 2.2G，不能再复制一份基线树：本轮**在工作树里原地改坏 → 跑 spec → 从内存里的原始字节还原 → sha256 比对**。跑完 11 项后 `git status --short` 仍只有本 PR 的 5 个文件，`git diff --stat -- packages/core-backend/src/index.ts` 为空（`index.ts` 全程只被读、被临时改坏、再还原，最终未进入本 PR 的改动集）。

| 探针 | 改坏了什么 | 红掉 | 红掉的用例（名） |
| --- | --- | --- | --- |
| **M-X2a** | 门 1c 整条失效（`if (false && (baseScoped \|\| sheetScoped))`） | **5 / 57** | DOOR 1c 的 sheet-scoped / base-scoped / both 三条 + `the refusal leaves the identity UNHYDRATED` + `the fence is refused on EVERY declared read path` |
| **M-X2b** | 门 1c 的 `\|\|` 改成 `&&`（只有同时带 base 和 sheet 才拒） | **4 / 57** | 上面五条里除 `both` 之外的四条 |
| **M-X2c** | 门 1c 照拒，但不写 `req.oapiAuditReason` | **1 / 57** | `the refusal leaves the identity UNHYDRATED — no read authority is ever assembled` |
| **M-X2d** | 门 1b（capability scope）失效，于是围栏抢先应答 | **3 / 57** | `scopes WITHOUT integration:read → 403 INSUFFICIENT_SCOPE`；`a scope-denied request leaves the identity UNHYDRATED`；`the capability-scope refusal still wins when BOTH are wrong (no reordering of DOOR 1b)` |
| **M-X3a** | catch 里改回 `throw error`（修复前的行为） | **3 / 57** | `授权后端抛错` 三条（DOOR 1a / DOOR 2 / TENANT）全红 |
| **M-X3b** | 503 的文案改成回显 `error.message` | **3 / 57** | 同上三条（`expect(JSON.stringify(body)).not.toContain('db down')` 命中） |
| **M-SUB** | 删掉 `isIntegrationOapiReadPath` 里的子树 AND 约束 | **4 / 65** | 四条注入用例：sibling subtree / admin route / lookalike prefix / 吞一切的通配 |
| **M-ORD-a** | 把 `this.app.use(createIntegrationApiTokenGate())` 注释掉 | **2 / 57** | `the gate is mounted app-level EXACTLY once, and inside setupMiddleware()`；`setupMiddleware() registers no /api/integration route ahead of the gate either` |
| **M-ORD-b** | 构造函数不再调 `setupMiddleware()` | **1 / 57** | `setupMiddleware() runs from the CONSTRUCTOR, so the mount happens at construction time` |
| **M-ORD-c** | 把 `loadPlugins()` 拉进构造函数 | **2 / 57** | `nothing can register a route before that: the constructor loads no plugin and mounts no route`；`plugin loading lives in start(), which cannot run before the constructor has finished` |
| **M-ORD-d** | 在 `start()` 里再挂一次门（挂载点不再唯一） | **1 / 57** | `the gate is mounted app-level EXACTLY once, and inside setupMiddleware()` |

**一条负结果，如实记录并已修好**：M-ORD-a / M-ORD-b 第一次跑是**全绿 57/57**。原因是守卫用 `line.includes(...)` 做纯文本匹配，而"把一行注释掉"之后那行**仍然包含**被匹配的文本——守卫读不出"这行不再执行"。这正是变异探针存在的意义：它抓到的是我自己新写的守卫的漏洞，不是产品代码的。修法是给源码扫描加一个 `isCode(line)`（排除 `//`、`*`、`/*` 开头的行）并用在四处断言上，重跑后 M-ORD-a 红 2 条、M-ORD-b 红 1 条。

**两条诚实标注**：

- M-X2c 只红 1 条，是因为审计理由只在一条用例里被断言。没有为了抬数字去拆用例。
- 运行时那半边的挂载序守卫（A：`app._router.stack` 索引 + 真实派发）**没有**对应的产品代码变异——它证明的是 Express 的语义，不是本仓某一行。它的非空性由同文件的 CONTROL 用例保证：把同样两层反序注册，handler 确实被执行、返回 200、`reached` 非空。

### 4.5 Express 4 的行为是实测的，不是推断的

终审要求删掉 `tests/unit/integration-api-token-gate.test.ts` 里那条名为 "…surfaced to the error handler" 的用例名，因为它把 Express 5 的行为当成本仓行为钉住了。我用 core-backend 自己的依赖（`packages/core-backend/node_modules/express` = **4.21.2**，node **v25.9.0**）跑了三种中间件形状，原样结果：

```
{
  "express": "4.21.2",
  "node": "v25.9.0",
  "results": [
    { "kind": "bare",     "response": "NO RESPONSE within 1200ms (socket still open)", "errorHandlerReached": false },
    { "kind": "trycatch", "response": "503 {\"ok\":false,\"error\":{\"code\":\"AUTHZ_UNAVAILABLE\"}}", "errorHandlerReached": false },
    { "kind": "nexterr",  "response": "500 {\"viaErrorHandler\":true,\"msg\":\"db down\"}", "errorHandlerReached": true }
  ],
  "unhandledRejections": ["db down"],
  "mountOrder": {
    "useThenGet": { "gate": 2, "route": 3, "gateFirst": true },
    "getThenUse": { "gate": 3, "route": 2, "gateFirst": false }
  }
}
```

三条结论：(1) 裸 async 中间件的 rejection **不**进 error handler、客户端**无任何应答**、进程收到 `unhandledRejection` —— 旧用例名是错的；(2) try/catch 答 503 是真的有应答；(3) `next(err)` **确实**能进 error handler ——所以终审/发现里"Express 4 不会把错误交给 error handler"这句要限定成"**async 中间件的 rejection** 不会"，显式 `next(err)` 会。本门选 `deny` 而不是 `next(err)`，理由是自证：不依赖末端确实挂了 error handler。

`mountOrder` 那两行是同一个探针顺手测的 Express 层序语义，和 §3.6 的守卫 A 同源。

脚本跑在 scratchpad、跑完即弃，仓库无落盘。

### 4.6 拒绝码是跑出来的

`§3.1`（设计文档）里那两支 `resolveTenantId` 结果，是直接 require 插件的 `http-routes.cjs` 调 `__internals.resolveTenantId` 跑出来的，输入就是本门装配的身份：

```
no tenantId anywhere         => 400 TENANT_REQUIRED "tenantId is required"
caller supplies ?tenantId=t9 => 403 TENANT_CONTEXT_REQUIRED "tenant context is required"
```

所以门注释与设计文档里原先只写 403 `TENANT_CONTEXT_REQUIRED` 是不全的，已改成两支并列。

---


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
5. **前端选不出这个作用域** —— `MetaApiTokenManager.vue:498` 的 `availableScopes` 硬编码六项（本轮只改了它上方那段已过期的注释，逻辑未动）。后端 API 可以创建（`routes/api-tokens.ts:42` 走 `ALL_API_TOKEN_SCOPES`），UI 暂时不行。刻意不做。
6. **`%2f` / `%2E%2E` 的放行** —— 已用真实路由器证明落点是已声明的 GET（§3），但这依赖 Express 4 的当前解码时机（路由用未解码 pathname，`req.params` 事后 `decodeURIComponent`）。若将来换路由器或加一层会规范化路径的反代，这个结论需要重测。性质测试会抓到，前提是有人在那次变更时跑它。
7. **读侧无 per-token 限流** —— 见设计文档 §6.7。
8. **`generate:sdk` 没有本地重跑** —— X1 的产物由派活方在 `128f552bc` 提交，我没有在本地跑 `pnpm --filter @metasheet/openapi generate:sdk` 复验"重跑后 diff 为空"（本地无 openapi-typescript，磁盘余量不允许安装）。CI 的 `git diff --exit-code` 是唯一的判定者。
9. **挂载序守卫只证到接线层，没证到进程层** —— A 半边证的是 Express 的层序语义（真实 express + 真实派发 + 反序对照），B 半边证的是 `src/index.ts` 的接线文本。两者合起来覆盖了"门被挪走 / 插件加载提前 / 挂载点不唯一"这三类改坏，但**不覆盖**"有人在 `setupMiddleware` 之外、用某种本守卫扫不出的形式把 `/api/integration` 挂到更早的子 router 上"。真正根治要走后续单第 1 条（per-route 前置门）。启动一个真实的 `MetaSheetServer` 实例来断言 `app._router.stack` 的做法本轮没做：构造函数会拉起注入器与一串服务，unit 层跑不动。
10. **门 1c 的实际影响面没有在真库上核过** —— 逻辑上受影响的只有"既带 base/sheet 围栏又带 `integration:read`"的 token，而 `integration:read` 本 PR 才诞生，所以我判断今天为零；但我没有查询任何真实部署的 `multitable_api_tokens` 来证实。
11. **`resolveCreatorTenantId` 在生产默认实现里其实不会抛** —— `AuthService.resolveSessionTenantId` 自带 try/catch 返回 `undefined`（`AuthService.ts:422-425`）。所以 §4.4 的 M-X3a/M-X3b 里那条 TENANT 用例走的是注入的替身，测的是门的 catch 语义而不是一条今天真会发生的生产路径。真正会抛的是 DOOR 1a（`validateToken` 的三次裸 DB 调用）和 DOOR 2（`userHasPermission` 对非 schema 错误 rethrow，`rbac/service.ts:70`）。终审里"三处 await 都可能 reject"的说法应当限定为**两处**。
