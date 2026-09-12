# admin-routes 结构性守卫 —— 验证记录（2026-09-12）

分支：`test/admin-routes-write-endpoints-structural-gate`
基线：`origin/fix/admin-safety-toggle-and-bulk-require-admin` @ `3c79b2059`
设计说明：`docs/development/admin-routes-structural-gate-design-20260912.md`

本文件所有输出均为本机原样粘贴（去掉了 ANSI 颜色码与无关的启动日志行）。

---

## 0. 实读盘点：admin 路由树今天的写面

从真实 router 对象（`initAdminRoutes({})` 返回的模块单例）上取栈，逐层 dump 得到的写方法清单
（`gate` 列 = 该方法的首个 handler 是否被识别为 `requireAdminRole()`）：

| # | 方法 + 路径 | gate | 来源 |
|---|---|---|---|
| 1 | `POST /safety/confirm` | ✅ | `admin-routes.ts:92` 直挂 `requireAdminRole()` |
| 2 | `POST /safety/enable` | ✅ | `:141`（#5665 新增） |
| 3 | `POST /safety/disable` | ✅ | `:164`（#5665 新增） |
| 4 | `POST /plugins/:id/enable` | ✅ | `:526` |
| 5 | `POST /plugins/:id/disable` | ✅ | `:560` |
| 6 | `PUT /plugins/:id/config` | ✅ | `:613` |
| 7 | `POST /plugins/:id/reload` | ✅ | `:661` `...protectAdminOperation` |
| 8 | `POST /plugins/reload-all` | ✅ | `:709` `...protectAdminOperation` |
| 9 | `POST /plugins/reload-all-unsafe` | ❌ | `:768` —— **豁免**（in-handler 双门） |
| 10 | `POST /plugins/:id/reload-unsafe` | ❌ | `:819` —— **豁免**（in-handler 双门） |
| 11 | `DELETE /plugins/:id` | ✅ | `:857` |
| 12 | `POST /snapshots/:id/restore` | ✅ | `:907` |
| 13 | `DELETE /snapshots/:id` | ✅ | `:966`（GHSA-h8mf） |
| 14 | `POST /snapshots/cleanup` | ✅ | `:1027` |
| 15 | `POST /cache/clear` | ✅ | #5665 新增 |
| 16 | `POST /metrics/reset` | ✅ | #5665 新增 |
| 17 | `DELETE /data/bulk` | ✅ | #5665 新增 |
| 18 | `PUT /data/bulk` | ✅ | #5665 新增 |
| 19 | `POST /dlq/:id/retry` | ✅ | #5665 新增 |
| 20 | `DELETE /dlq/:id` | ✅ | #5665 新增 |
| 21 | `POST /dlq/retry-all` | ✅ | #5665 新增 |
| 22 | `POST /dlq/cleanup` | ✅ | #5665 新增 |
| 23 | `POST /ratelimits/:key/reset` | ✅ | #5665 新增 |
| 24 | `POST /ratelimits/reset-all` | ✅ | #5665 新增 |
| 25 | `POST /health/check` | ❌ | `:2047` —— **豁免**（只读探针） |
| 26 | `PUT /snapshots/:id/tags` | ✅ | 子路由 `snapshot-labels.ts:40` |
| 27 | `PATCH /snapshots/:id/protection` | ✅ | 子路由 `snapshot-labels.ts:74` |
| 28 | `PATCH /snapshots/:id/release-channel` | ✅ | 子路由 `snapshot-labels.ts:109` |
| 29 | `POST /safety/rules` | ❌ | 子路由 `protection-rules.ts:111` —— **临时豁免 `todo:#5667`** |
| 30 | `PATCH /safety/rules/:id` | ❌ | 子路由 `protection-rules.ts:203` —— **临时豁免 `todo:#5667`** |
| 31 | `DELETE /safety/rules/:id` | ❌ | 子路由 `protection-rules.ts:244` —— **临时豁免 `todo:#5667`** |
| 32 | `POST /safety/rules/evaluate` | ❌ | 子路由 `protection-rules.ts:267` —— **临时豁免 `todo:#5667`** |

（第 9/10/25 行是**永久**豁免，第 29-32 行是**临时**豁免。两类的区别与理由见设计说明 §4.0。）

计数不是手算的，是从守卫自己的审计函数里打出来的（一次性计数探针，跑完即删）：

```
TOTAL_WRITE= 32 GATED= 25 UNGATED= 7 VIOLATIONS= 0
UNGATED_LIST= POST /api/admin/plugins/reload-all-unsafe | POST /api/admin/plugins/:id/reload-unsafe |
              POST /api/admin/health/check | POST /api/admin/safety/rules |
              PATCH /api/admin/safety/rules/:id | DELETE /api/admin/safety/rules/:id |
              POST /api/admin/safety/rules/evaluate
```

合计 **32** 条写方法，**25** 条有门，**7** 条无门且**恰好**就是豁免表那 7 条（`VIOLATIONS=0`）。
**本次没有发现「无门、又不属于已知登记项」的写路由** —— 也就是说 #5665 那 12 条之外没有新洞，
本次也就没有需要「回报不修」的新发现。

### 0.1 `requireAdminRole()` 返回值的实读（决定识别机制的那一步）

```
GATE name="" length=3 ownProps=["length","name"]
GATE src(0,90)="async (req, res, next) => {\n    const user = req.user;\n    if (!user?.id) {\n      logger.w"
toString stable across calls: true
protectAdminOperation isArray=true len=2 [0] matches gate src=true [1] matches=false
requireSafetyCheck matches gate src: false
```

结论：**没有**可识别的 `name`/属性（`name` 是空串，自有属性只有 `length`/`name`），所以「按名字认门」不可行；
`toString()` 跨调用稳定且能把审计中间件、确认层区分开来，所以采用源文本同一性，**不需要 `vi.mock` 任何守卫**。
（上面这段是一次性探针输出；探针文件已删除，未进提交。）

---

## 1. 新 spec 全绿（21 个用例）

```
$ npx vitest run tests/unit/admin-routes-write-endpoints-structural-gate.test.ts --reporter=verbose

 ✓ ... > 识别机制的正反自证 > 正：requireAdminRole() 的不同调用互相匹配（闭包环境不影响 toString 同一性）
 ✓ ... > 识别机制的正反自证 > 正：protectAdminOperation(...) 是 [admin 门, 审计]，首位就是门；反：第二位不是门
 ✓ ... > 识别机制的正反自证 > 反：requireSafetyCheck(...) 不是 admin 门（确认层 ≠ 授权门，#5665 的要害）
 ✓ ... > 识别机制的正反自证 > 反：裸中间件 / 非函数都不是 admin 门
 ✓ ... > 识别机制的正反自证 > 正：已知有门的 POST /safety/enable（admin-routes.ts:141）首位被认出来
 ✓ ... > 识别机制的正反自证 > 反：已知无门的读路由 GET /slo/status（admin-routes.ts:1392）首位不被认出来
 ✓ ... > 结构性保证：每条写路由的首位都是 admin 门 > 写路由确实被收集到了（防止「零条写路由」式的空转绿）
 ✓ ... > 结构性保证：每条写路由的首位都是 admin 门 > 没有「既无 admin 门、又不在豁免表里」的写路由
 ✓ ... > 结构性保证：每条写路由的首位都是 admin 门 > #5665 补门的那一族逐条仍然有门（回归钉）
 ✓ ... > 豁免表 > 每条豁免都对应一条真实存在的写路由（禁止残留过期豁免）
 ✓ ... > 豁免表 > 永久豁免不得覆盖已经有门的路由（门补上了 = 设计变了，必须删豁免）
 ✓ ... > 豁免表 > 临时豁免：已可删除的条目只点名提示、不挡合并
 ✓ ... > 豁免表 > 每条豁免都写了理由；临时豁免的 todo 必须是 issue/PR 号
 ✓ ... > 豁免表 > 无门写路由 ⊆ 豁免表（核心不变量）
 ✓ ... > 子路由挂载面 > router.use 挂的子路由恰好是固定集合，且没有挂载级中间件
 ✓ ... > 子路由挂载面 > /snapshots 子路由（snapshot-labels.ts）的三条写路由都有门
 ✓ ... > 子路由挂载面 > /safety/rules 子路由（protection-rules.ts）的四条写路由：路径集合固定，门的有无只记录
 ✓ ... > 变异自证 > 摘掉 PUT /data/bulk 的首个 handler（= 去掉 #5665 补的门）→ 红并点名该路由
 ✓ ... > 变异自证 > 新加一条无门写路由（= §4 残余第 1 条描述的开洞方式）→ 红并点名该路由
 ✓ ... > 变异自证 > 把门换成 requireSafetyCheck（= #5665 修前的形状）→ 仍然红
 ✓ ... > 变异自证 > 把豁免表清空 → 今天全部无门写路由都会变成违规（证明豁免表是真的在生效、不是空转）

 Test Files  1 passed (1)
      Tests  21 passed (21)
```

---

## 2. 变异自证 —— 「去掉守卫/开一个洞，测试就红」

### 2.1 文件内自证（随 spec 一起常跑，内存级，不落盘、不改源码）

`describe('变异自证')` 里的四条用例直接改**模块单例** router 再复检，每条都在 `finally` 里还原，
并且有一个 `afterEach` 复查「router 还原干净了」。它们证明的是：主断言在被变异的输入上**确实会变红**，
而不是恒绿。四条见上面 §1 的后四行。

### 2.2 外部变异探针（一次性，跑完即删，不进提交）

为了给出「主断言真的会红」的原样输出，生成了四份 spec 变体（改变体、不改被测源码），跑完删除。
M1/M2/M3 证明「开洞会红」，**M4 证明「修洞不会红」** —— 后者是豁免表改成两类之后新增的关键证据。

汇总：

| 变体 | 内容 | 结果 |
|---|---|---|
| M1 | 摘掉 `PUT /data/bulk` 的 admin 门 | **7 failed / 21** |
| M2 | 新加一条无门写路由 | **6 failed / 21** |
| M3 | 把匹配器放宽成「是函数就算门」 | **8 failed / 21** |
| M4 | 模拟 #5677 已合并（给 `/safety/rules` 四条注入真门） | **21 passed / 21**（只多 warn） |

#### M1 —— 摘掉 `PUT /data/bulk` 的 admin 门（= 撤销 #5665 对这条的修复）

```
 ❯ tests/unit/w4b-mut1-drop-gate.test.ts  (21 tests | 7 failed)
   ❯ 结构性保证：每条写路由的首位都是 admin 门 > 没有「既无 admin 门、又不在豁免表里」的写路由
     → 以下写路由的中间件链首位不是 requireAdminRole()/protectAdminOperation(...)，也不在本文件的豁免表里：
  - PUT /api/admin/data/bulk
要么给它加门（首位 requireAdminRole() 或 ...protectAdminOperation(OperationType.X)），要么在 EXEMPTIONS 里显式登记并写清理由。确认层 requireSafetyCheck 不算门。: expected [ { method: 'put', …(4) } ] to deeply equal []
   ❯ 结构性保证：每条写路由的首位都是 admin 门 > #5665 补门的那一族逐条仍然有门（回归钉）
     → 以下 #5665 已补门的路由丢了门或丢了路由：
PUT /api/admin/data/bulk: expected [ 'PUT /api/admin/data/bulk' ] to deeply equal []
```

红，并**点名 `PUT /api/admin/data/bulk`**。

#### M2 —— 新加一条无门写路由（= §4 残余第 1 条描述的开洞方式）

```
 ❯ tests/unit/w4b-mut2-new-ungated-route.test.ts  (21 tests | 6 failed)
AssertionError: 以下写路由的中间件链首位不是 requireAdminRole()/protectAdminOperation(...)，也不在本文件的豁免表里：
  - POST /api/admin/w4b-leaked-write/:id

要么给它加门（首位 requireAdminRole() 或 ...protectAdminOperation(OperationType.X)），要么在 EXEMPTIONS 里显式登记并写清理由。确认层 requireSafetyCheck 不算门。: expected [ { method: 'post', …(4) } ] to deeply equal []
```

红，并**点名那条新加的路由**。这正是本守卫要挡的失效模式。

#### M3 —— 把识别机制放宽成「是函数就算门」（= 假件化匹配器）

```
 Test Files  1 failed (1)
      Tests  8 failed | 13 passed (21)

 FAIL  ... > 识别机制的正反自证 > 反：requireSafetyCheck(...) 不是 admin 门（确认层 ≠ 授权门，#5665 的要害）
 FAIL  ... > 识别机制的正反自证 > 反：已知无门的读路由 GET /slo/status（admin-routes.ts:1392）首位不被认出来
 FAIL  ... > 识别机制的正反自证 > 反：裸中间件 / 非函数都不是 admin 门
 FAIL  ... > 识别机制的正反自证 > 正：protectAdminOperation(...) 是 [admin 门, 审计]，首位就是门；反：第二位不是门
 FAIL  ... > 豁免表 > 永久豁免不得覆盖已经有门的路由（门补上了 = 设计变了，必须删豁免）
 FAIL  ... > 变异自证 > 摘掉 PUT /data/bulk 的首个 handler（= 去掉 #5665 补的门）→ 红并点名该路由
 FAIL  ... > 变异自证 > 新加一条无门写路由（= §4 残余第 1 条描述的开洞方式）→ 红并点名该路由
 FAIL  ... > 变异自证 > 把门换成 requireSafetyCheck（= #5665 修前的形状）→ 仍然红
```

**这是本文件最重要的一条证据**：把匹配器偷偷放宽（最危险的假件化方向 —— 「谁都认」会让整片静悄悄转绿），
反向控制组**立刻全红**。也就是说识别机制的正反自证不是装饰，它真的在把关。

对比豁免表改成两类**之前**（等式 + 临时豁免硬红）的那一版，M3 从 11 failed 变成 8 failed ——
少掉的三条正是被刻意改掉的那三条（「豁免表 == 无门集合」的等式、「临时豁免覆盖已有门路由」的硬红、
「/safety/rules 四条必须无门」的硬判）。这是**预期内的**：那三条红信号的来源是「断言了当前快照」，
而快照断言正是造成 PR 耦合的东西。**抗假件的核心没丢** —— 四条负向控制组仍然全红，
并且「**永久**豁免不得覆盖已有门路由」这条硬红仍然抓得住 M3（因为假件匹配器会让
`/health/check` 与两条 `*-unsafe` 看起来「有门了」）。

#### M4 —— 模拟 #5667 / PR #5677 已合并（给 `/safety/rules` 四条写路由首位注入真实 `requireAdminRole()`）

这是豁免表改成「永久 / 临时」两类之后新增的关键变异：它验证的不是「开洞会红」，而是
**「洞被别人修好了，本 spec 不会红」** —— 也就是两支 PR 没有被耦合成固定合并顺序。

```
stderr | ... > 豁免表 > 临时豁免：已可删除的条目只点名提示、不挡合并
[结构性守卫] 4 条临时豁免已可删除 —— 对应路由已经补上 admin 门：
  - POST /api/admin/safety/rules  (todo: #5667)
  - PATCH /api/admin/safety/rules/:id  (todo: #5667)
  - DELETE /api/admin/safety/rules/:id  (todo: #5667)
  - POST /api/admin/safety/rules/evaluate  (todo: #5667)
请在对应 issue 收口时从本 spec 的 EXEMPTIONS 里删掉这些条目。（这里只提示不失败：修洞的 PR 不该因为本 spec 而被挡住。）

stderr | ... > 子路由挂载面 > /safety/rules 子路由（protection-rules.ts）的四条写路由：路径集合固定，门的有无只记录
[结构性守卫] /safety/rules 已有 4/4 条写路由补上了 admin 门（#5667 / PR #5677 生效中）：
  - POST /api/admin/safety/rules
  - PATCH /api/admin/safety/rules/:id
  - DELETE /api/admin/safety/rules/:id
  - POST /api/admin/safety/rules/evaluate
四条都补齐后，请把本 spec EXEMPTIONS 里那四条 todo:#5667 的临时豁免删掉。

 ✓ tests/unit/w4b-mut4-5677-merged.test.ts  (21 tests) 12ms
 Test Files  1 passed (1)
      Tests  21 passed (21)
```

**21/21 全绿**，只多出两段 `console.warn`。所以：#5677 先合、本支先合、或两支一起进组合树，
本 spec 都不会红，也不会假红。清理这四条临时豁免是一件「看得见但不挡路」的收尾工作。

探针清理：四份变体与探针文件已删除，`git status` 只剩本次要提交的三个文件（见 §6）。

---

## 3. 相邻 spec 未被打断

`grep -rl "admin-routes\|initAdminRoutes" packages/core-backend/tests` 命中 8 个文件，其中
`tests/integration/directory-binding-sync-hook.db.test.ts` 在 `vitest.config.ts` 的 exclude 里（realdb lane），
无库 lane 里可跑的 7 个 + 新 spec 一起跑：

```
$ npx vitest run tests/unit/admin-routes-write-endpoints-structural-gate.test.ts \
    tests/unit/admin-safety-toggle-and-bulk-authz.test.ts \
    tests/unit/admin-safety-confirm-authz.test.ts \
    tests/unit/admin-snapshot-delete-authz.test.ts \
    tests/unit/admin-yjs-status-routes.test.ts \
    tests/unit/safety-guard-confirm-flow.test.ts \
    tests/unit/snapshot-labels-authz.test.ts \
    tests/unit/snapshots-safety-guard.test.ts

 ✓ tests/unit/snapshot-labels-authz.test.ts  (5 tests) 78ms
 ✓ tests/unit/snapshots-safety-guard.test.ts  (5 tests) 57ms
 ✓ tests/unit/safety-guard-confirm-flow.test.ts  (15 tests) 162ms
 ✓ tests/unit/admin-yjs-status-routes.test.ts  (2 tests) 7ms
 ✓ tests/unit/admin-snapshot-delete-authz.test.ts  (3 tests) 11ms
 ✓ tests/unit/admin-routes-write-endpoints-structural-gate.test.ts  (21 tests) 14ms
 ✓ tests/unit/admin-safety-confirm-authz.test.ts  (3 tests) 16ms
 ✓ tests/unit/admin-safety-toggle-and-bulk-authz.test.ts  (18 tests) 140ms

 Test Files  8 passed (8)
      Tests  72 passed (72)
```

（输出里穿插的 `error: RBAC check failed` 日志来自那几个 spec 自己的 fail-closed 用例 —— 它们**故意**
让 `isAdmin` 抛错来断言 503，不是本次引入的噪声。）

### 3.1 单例污染不会外溢

新 spec 会改模块单例 router（变异自证），所以确认了隔离：`packages/core-backend/vitest.config.ts` 里
**没有** `isolate` / `fileParallelism` / `poolOptions` 键，走 vitest 默认 `isolate: true` —— 每个 spec
文件拿到独立模块注册表。加上文件内每条变异都有 `finally` 还原 + `afterEach` 复查，两道保险。

---

## 4. 类型检查

```
$ npx tsc --noEmit        # packages/core-backend
=== tsc exit: 0 ===
```

但要如实说明：`packages/core-backend/tsconfig.json:30` 的 `exclude` 含 `"**/*.test.ts"`，
**包级 `tsc --noEmit` 根本没把任何 spec 收进程序**（`--listFilesOnly | grep admin-routes-write-endpoints`
无命中）。所以上面那个 0 并不等于「新 spec 类型没问题」。

为此另跑了一次显式把新 spec 与相邻 spec 拉进程序的 tsc（临时 `tsconfig.w4b-check.json`，跑完已删除，
未进提交；`strict: true` 继承自包级配置）：

```
include: src/**/*, types/**/*,
         tests/unit/admin-routes-write-endpoints-structural-gate.test.ts,
         tests/unit/admin-safety-toggle-and-bulk-authz.test.ts
exclude: node_modules, dist, src/**/*.test.ts, src/**/__tests__/**

$ npx tsc --noEmit -p tsconfig.w4b-check.json
=== ad-hoc tsc exit: 0 ===
```

**0 错误。** （`src/**/__tests__/**` 被排掉是因为那批 in-src spec 在仓库里本来就带存量类型错误，与本次
无关 —— 第一次跑没排它们时，报错文件清单里 20 个全部来自 `src/**/__tests__/`、`src/__tests__/`，
新 spec 与相邻 spec **一条都没有**。）

---

## 5. 新 spec 会被无库 CI 收

- `packages/core-backend/vitest.config.ts` **没有** `include` 键（`grep -n "^\s*include:"` 无命中），
  走 vitest 默认 `**/*.{test,spec}.?(c|m)[jt]s?(x)`。
- `exclude` 共 394 条，只有三条是 glob（`**/node_modules/**`、`**/dist/**`、`tests/e2e/**`），
  其余全是逐个枚举的 `tests/integration/...` 文件名。文件里出现 `tests/unit` 的三处（`:95`、`:102`、`:112`）
  全是注释，不是 exclude 项。
- 无库 lane 跑 `pnpm --filter @metasheet/core-backend test` = `vitest`（`.github/workflows/plugin-tests.yml`
  的「Run core-backend tests」步骤，与 #5665 用的是同一条）。
- **正向证据**：只给子串过滤（不给路径），让配置的 include/exclude 自己去解析 ——
  ```
  $ npx vitest run admin-routes-write-endpoints
   ✓ tests/unit/admin-routes-write-endpoints-structural-gate.test.ts  (21 tests)
   Test Files  1 passed (1)
        Tests  21 passed (21)
  ```
- **反证控制组**（证明 exclude 在显式传路径之后仍然生效，所以上一条不是「传了路径就一定跑」）：
  ```
  $ npx vitest run tests/integration/approval-directory-resolve.api.test.ts
  filter:  tests/integration/approval-directory-resolve.api.test.ts
  exclude:  **/node_modules/**, ..., tests/integration/approval-directory-resolve.api.test.ts, ...
  No test files found, exiting with code 1
  ```
- 没有碰 `.github/workflows/*`、`vitest.config.ts`、任何 realdb 配置、任何 pin 文件、任何 `plugins/`。

---

## 6. 本次改了什么

```
packages/core-backend/tests/unit/admin-routes-write-endpoints-structural-gate.test.ts   （新增）
docs/development/admin-routes-structural-gate-design-20260912.md                        （新增）
docs/development/admin-routes-structural-gate-verification-20260912.md                  （新增）
```

**零行路由代码改动**：`src/routes/admin-routes.ts`、`src/routes/protection-rules.ts`、
`src/routes/snapshot-labels.ts`、`src/guards/**` 全部未动。

---

## 7. 不确定项 / 留给复核的问题

1. **`POST /safety/rules/evaluate` 是否真属写面** —— 它触发规则求值、不落库。本次按「POST + 吃 body」的
   保守口径进临时豁免表；若 #5677 判定它只需读权限，豁免与理由要一起改。
2. **issue 号 vs PR 号** —— 代码里 `todo` 统一写 `'#5667'`（issue），文案里同时提 PR **#5677**
   （`fix/protection-rules-require-admin-and-identity`）。若这两个号其实指同一个对象、或号记反了，
   请以 issue 号为准改 `todo` 字段（改字符串即可，「`todo` 必须是 `#<号>`」那条用例不挑具体数字）。
3. **临时豁免的清理只有可见性、没有强制力** —— 这是为了不把独立 PR 耦合成固定合并顺序而付出的代价：
   一条临时豁免可以在洞修好之后长期留着不删（无害但是噪声），只会持续 `console.warn`。
   要收紧就得引入「到期」概念 + 定期巡检，而不是改回硬红。见设计说明 §7 残余第 7 条。
3. **`toString()` 同一性的适用边界** —— 它在同一个进程/同一份模块实例内是可靠的。如果将来构建链引入
   对同一模块的重复实例化（两份 `guards/audit-integration`），生产代码挂的门可能来自另一份实例、源文本
   仍相同 → 依然匹配（因为比的是文本不是引用），所以这个方向是安全的。反方向（源文本相同但其实是另一个
   函数）在理论上可能，实际上意味着有人复制粘贴了一份一模一样的门实现 —— 那仍是一个门。
4. **守卫只覆盖 `admin-routes.ts` 这棵树**，`index.ts:1899-1912` 上另外挂载的
   `/api/admin/directory*`、`/api/admin/canary` 等不在覆盖范围内（设计说明 §7 残余第 3 条）。
