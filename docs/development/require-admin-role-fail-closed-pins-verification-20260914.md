# requireAdminRole() fail-closed pins — verification (2026-09-14)

Base:`origin/main` @ `ce9da32ae69f12db082b6d3164b0634486e91172`(worktree
`C:/Users/zhou/Downloads/dev/metasheet-wt-w5d`,分支
`test/require-admin-role-fail-closed-pins`)。

## 用例清单(6 条,均通过)

文件:`packages/core-backend/tests/unit/require-admin-role-fail-closed.test.ts`

1. `① user_roles has no admin row -> 403 ADMIN_REQUIRED, handler not called` —
   钉 rbac/service.ts:22-23 `rows.length===0` → audit-integration.ts:150-177。
2. `② pool is null -> 403 ADMIN_REQUIRED, handler not called, query never reached` —
   钉 rbac/service.ts:20 早退,并断言 `dbState.query` 一次都没被调用。
3. `③ RBAC_OPTIONAL=1 + missing user_roles table -> 403 ADMIN_REQUIRED, handler not called` —
   钉 rbac/service.ts:25-31 降级分支(`vi.resetModules()` + 动态 import 让
   `allowDegradation` 在设置 `RBAC_OPTIONAL=1` 之后重新求值)。
4. `positive control: user_roles has an admin row -> 200, handler called` —
   钉 rbac/service.ts:22-23 `rows.length>0` → audit-integration.ts:180-186。
5. `query throws a non-schema error -> 503 RBAC_CHECK_FAILED, handler not called` —
   钉 rbac/service.ts:32 原样 rethrow → audit-integration.ts:187-196。
6. `no req.user -> 403 ADMIN_REQUIRED without calling isAdmin/query` —
   钉 audit-integration.ts:121-145(既有分支,不在三种情形之列,作边界对照)。

## 三情形各自实际走的分支(结论)

- ① user_roles 无匹配行 → `isAdmin` 返回 `false` → **403**(fail-closed)。
- ② pool 为 null → `isAdmin` 早退返回 `false`,不发查询 → **403**(fail-closed)。
- ③ `RBAC_OPTIONAL=1` 且表缺(SQLSTATE 42P01)→ `isAdmin` 内部捕获后返回
  `false` → **403**(fail-closed)。

**没有发现 fail-open。** 三种情形与终审登记一致,均 403 `ADMIN_REQUIRED`,没有
用例需要 `it.fails`/`it.todo` 标注。

## 变异验证(内存级,不落盘改源码)

临时在测试文件末尾追加了一条用例(未提交,运行后手工删除,已用 `git status`
确认恢复干净):用 `vi.spyOn` 把动态 import 到的 `rbac/service.isAdmin` 强制
替换成 `async () => true`,同时把 `dbState.pool` 设为 `null`(模拟②),复用同一套
`expect(res.status).toBe(403)` 断言。

- 变异前(用真实 isAdmin):用例②真实通过(403)。
- 打了变异之后单独跑该临时用例:**红**——
  `AssertionError: expected 200 to be 403`(handler 被调用、guard 放行)。
  证明如果 `isAdmin` 在 pool 为 null 时被改成 fail-open(返回 true),
  这条钉桩确实会炸。
- 删除临时用例、还原文件后重跑整份 spec:**绿**(6/6)。

命令与结果(原样节选):

```
$ pnpm exec vitest run tests/unit/require-admin-role-fail-closed.test.ts -t "MUTATION PROOF"
 × ... MUTATION PROOF (temporary): pool null forced to return true -> ② assertion must fail
   → expected 200 to be 403 // Object.is equality
 Test Files  1 failed (1)
      Tests  1 failed | 6 skipped (7)
```

```
$ pnpm exec vitest run tests/unit/require-admin-role-fail-closed.test.ts   # 变异已还原
 ✓ ① user_roles has no admin row -> 403 ADMIN_REQUIRED, handler not called ...
 ✓ ② pool is null -> 403 ADMIN_REQUIRED, handler not called, query never reached ...
 ✓ ③ RBAC_OPTIONAL=1 + missing user_roles table -> 403 ADMIN_REQUIRED, handler not called ...
 ✓ positive control: user_roles has an admin row -> 200, handler called ...
 ✓ query throws a non-schema error -> 503 RBAC_CHECK_FAILED, handler not called ...
 ✓ no req.user -> 403 ADMIN_REQUIRED without calling isAdmin/query ...
 Test Files  1 passed (1)
      Tests  6 passed (6)
```

## CI 红→绿:tripwire(PR #5716 返修,追加于 2026-09-14)

**症状**:PR #5716 CI 两条 test 泳道红,不是本 spec 的断言失败,而是仓库的零容忍
tripwire `tests/unit/supertest-app-mode-tripwire.test.ts:74` 报错:
`require-admin-role-fail-closed.test.ts: 6 app-mode supertest site(s)`。

**根因**:`tests/utils/supertest-app-mode-scan.ts` 用 AST 扫描 `tests/unit/**/*.test.ts`,
把 `request(<express app 表达式>)` 这类调用判为 "app-mode"(supertest 会对每个请求
起一个新的 `app.listen(0)` 临时端口监听器,是 #4154 记录的跨用例串号根因);唯一豁免
的安全写法是 `request('http://…')`(字符串/模板字面量)或 `request(x.url())`(属性名
为 `url` 的零参调用,对应 `usePinnedServer().url()`)。本 spec 原来 6 处都是
`request(app)`(直接把 express app 传给 supertest),全部命中 app-mode,被
`tests/unit/supertest-app-mode-tripwire.test.ts` 的 `totalSites === 0` 零容忍断言拦下。

**改法**:读了 `packages/core-backend/tests/utils/pinned-server.ts`(`usePinnedServer()`
起一个 `beforeAll`/`afterAll` 生命周期内的单一 http server,测试里用 `setApp()` 换装、
`url()` 拿基址)与已经这么用的现成 spec `tests/unit/snapshot-labels-authz.test.ts`
(同款"每个用例现造一个 app、pinned.setApp(app)、request(pinned.url())"写法)。照抄:
- 模块顶层加 `import { usePinnedServer } from '../utils/pinned-server'` 和
  `const pinned = usePinnedServer()`(与 `describe` 同级,复用整份 spec 一个端口)。
- 6 处调用点全部从 `request(app)` 改成 `pinned.setApp(app); ... request(pinned.url())`,
  断言与用例内容(状态码、`code` 字段、`handlerCalled`、`dbState.query` 调用次数)
  一字未动。

**验证**(HEAD `ad4a304b3` 基础上,同一 worktree):

```
$ pnpm exec vitest run tests/unit/require-admin-role-fail-closed.test.ts tests/unit/supertest-app-mode-tripwire.test.ts
 ✓ tests/unit/require-admin-role-fail-closed.test.ts (6 tests)
 ✓ tests/unit/supertest-app-mode-tripwire.test.ts > the app-mode debt IS zero and stays zero — no regeneration channel exists
 Test Files  2 passed (2)
      Tests  9 passed (9)
```

**变异复核**(改传输层后重新验证钉桩仍然有效,不是形式主义换壳):用同样的临时
`vi.spyOn` 手法(动态 import `rbac/service`,把 `isAdmin` 在 pool===null 时强制
`mockImplementation(async () => true)`),对改造后使用 `pinned.setApp` +
`request(pinned.url())` 的用例②重跑:

```
$ pnpm exec vitest run tests/unit/require-admin-role-fail-closed.test.ts -t "MUTATION PROOF"
 × MUTATION PROOF (temporary): pool null forced to return true -> ② assertion must fail
   → expected 200 to be 403 // Object.is equality
 Test Files  1 failed (1)
      Tests  1 failed | 6 skipped (7)
```

红,与切换传输层前的结果一致。删除临时用例、还原文件后重跑两份 spec:9/9 绿(同上）。
`git status --porcelain` 确认还原后除 6 处 `pinned.url()` 改动外无残留。

## 相邻 spec(文件名含 admin/rbac 的 tests/unit/*)

```
$ pnpm exec vitest run <24 个 tests/unit/*admin*.test.ts 和 *rbac*.test.ts 文件>
 Test Files  1 failed | 23 passed (24)
      Tests  1 failed | 467 passed (468)
```

唯一失败:`tests/unit/attendance-admin-plugin-lib-dist-layout-boot.test.ts` ——

```
AssertionError: tsc did not emit .../dist/src/routes/attendance-admin.js. tsc output:
Error: spawnSync C:\...\core-backend\node_modules\.bin\tsc ENOENT: expected false to be true
```

单独重跑(隔离掉并行干扰的可能性)结果相同,稳定复现,与本次改动无关:
- 该用例本身 `spawnSync` 直接调用 `node_modules/.bin/tsc`(一个带 shebang 的
  shell 脚本),在 Windows 上非 shell 方式起子进程解析 shebang 会 `ENOENT`;
  这是环境/平台问题,不是新测试引入的回归——`require-admin-role-fail-closed.test.ts`
  没有 spawn 任何子进程,也没有改 `attendance-admin.ts` 或任何被该用例依赖的
  文件。CI(Linux)不会有这个 shebang 问题,以 CI 结果为准。

## 包级 tsc

未改任何 `.ts` 源文件,包 `tsconfig.json` 本来就 `exclude` 了 `**/*.test.ts`,
所以按任务要求单独起了一个临时 tsconfig 只查新 spec(`packages/core-backend/
tsconfig.tmp-w5d.json`,继承 `tsconfig.json`,`include` 加了新 spec 路径,
`exclude` 保留 `src/**/*.test.ts`/`__tests__` 避免拖入其它本来就跳过类型检查
的测试文件)。检查后已删除该临时文件,不入库。

```
$ pnpm exec tsc -p tsconfig.tmp-w5d.json --noEmit
(no output — 0 errors)
```

## pnpm install

```
$ pnpm install --frozen-lockfile
Done in 58s using pnpm v9.15.9
```

## 未做事项

- 未 push、未开 PR(按任务要求)。
- 未触碰任何 `src/` 文件。
- 未处理 `attendance-admin-plugin-lib-dist-layout-boot.test.ts` 的 Windows
  `tsc` 路径问题(与本任务无关,超出"纯新测试"范围,如实报告)。
