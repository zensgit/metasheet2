# 验证：mark-all-read 只以认证主体为准（W4-G）

- 日期：2026-09-12
- worktree：`metasheet-wt-w4g`，分支 `fix/comments-mark-all-read-actor-only`，基线 `origin/main` @ `9fb29831c`
- 设计件：`docs/development/comments-mark-all-read-actor-only-design-20260912.md`
- 新增 spec：`packages/core-backend/tests/unit/comment-mark-all-read-actor.test.ts`（3 例）

## 0. 新 spec 的挂法

照 `tests/unit/comment-routes-row-deny.test.ts`：`usePinnedServer` + supertest，mock 掉触库依赖
（connection-pool / permission-service / api-token-auth / rate-limiter / oapi-write-audit / CommentService）。
**唯一区别**：不 mock `src/rbac/rbac`，改为 mock 它的两个触库依赖（`src/rbac/service`、
`src/rbac/namespace-admission`），让 **真的 `rbacGuard`** 参与——"未认证被挡"那条才是真门的证据，
而不是在断言一个假门。

## 1. 修前红（原样）

命令：`pnpm exec vitest run tests/unit/comment-mark-all-read-actor.test.ts --reporter=verbose`
（源码仍是 main 的 `parsed.data.userId?.trim() || context.userId`）

```
 × tests/unit/comment-mark-all-read-actor.test.ts > mark-all-read 只认认证主体 > 请求体里的 userId 被忽略：服务收到的仍是认证主体，绝不是受害者
   → expected "spy" to be called with arguments: [ 'sheet-1', 'user-actor-a', [] ]

Received:

  1st spy call:

  Array [
    "sheet-1",
-   "user-actor-a",
+   "user-victim-b",
    Array [],
  ]

Number of calls: 1

 ✓ tests/unit/comment-mark-all-read-actor.test.ts > mark-all-read 只认认证主体 > 空 body：服务收到认证主体
 ✓ tests/unit/comment-mark-all-read-actor.test.ts > mark-all-read 只认认证主体 > 未认证：真 rbacGuard 401，服务不被调用

 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
```

读法：已认证用户 A（`user-actor-a`，持 `comments:read/write`、对该 sheet 有读权）发
`{"userId":"user-victim-b"}`，`CommentService.markAllCommentsRead` 收到的 actor 是 **B**——冒名成立。
另两条修前就绿，符合预期（空 body 本来就走 `context.userId`；401 由 rbacGuard 先挡，与本洞无关）。

## 2. 修后绿

命令：`pnpm exec vitest run tests/unit/comment-mark-all-read-actor.test.ts tests/unit/comment-routes-row-deny.test.ts tests/unit/comment-service.test.ts --reporter=verbose`

```
 ✓ tests/unit/comment-mark-all-read-actor.test.ts > mark-all-read 只认认证主体 > 请求体里的 userId 被忽略：服务收到的仍是认证主体，绝不是受害者
 ✓ tests/unit/comment-mark-all-read-actor.test.ts > mark-all-read 只认认证主体 > 空 body：服务收到认证主体
 ✓ tests/unit/comment-mark-all-read-actor.test.ts > mark-all-read 只认认证主体 > 未认证：真 rbacGuard 401，服务不被调用

 Test Files  3 passed (3)
      Tests  57 passed (57)
```

三条断言分别钉：`{"userId":"<受害者>"}` → service 收到 A 且**从不**以 B 为 actor 被调用（点名负控
`not.toHaveBeenCalledWith(anything, VICTIM, anything)`）；`{}` → 收到 A；无 `req.user` → **401**
且 `markAllCommentsRead` 与 `resolveSheetReadableCapabilities` 都未被调用（挡在服务与 sheet 门之前）。

## 3. 变异（内存级，不落盘）

探针：`<scratchpad>/wt-w4g/w4g-mutate.config.mjs` —— 一个 vite `enforce:'pre'` 插件，在 transform 管道里
把 `src/routes/comments.ts` 的
`commentService.markAllCommentsRead(spreadsheetId, context.userId, deniedRows(context))`
替换回有洞的 `(parsed.data.userId?.trim() || context.userId)`；**磁盘上的源码一个字节都没改**
（锚点找不到就 throw，防止探针空跑）。

命令：`pnpm exec vitest run --config <scratchpad>/wt-w4g/w4g-mutate.config.mjs tests/unit/comment-mark-all-read-actor.test.ts tests/unit/comment-routes-row-deny.test.ts`

```
 FAIL  tests/unit/comment-mark-all-read-actor.test.ts > mark-all-read 只认认证主体 > 请求体里的 userId 被忽略：服务收到的仍是认证主体，绝不是受害者
AssertionError: expected "spy" to be called with arguments: [ 'sheet-1', 'user-actor-a', [] ]

Received:

  1st spy call:

  Array [
    "sheet-1",
-   "user-actor-a",
+   "user-victim-b",
    Array [],
  ]

 ✓ tests/unit/comment-routes-row-deny.test.ts  (5 tests) 105ms

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 7 passed (8)
```

两点：
1. 把分支加回来 → 新 spec 立刻红并点名 `user-victim-b`，守卫非装饰。
2. 同一次变异下 **`comment-routes-row-deny.test.ts` 5 例全绿**——它对该路由只发 `{}`，
   这正是这个洞能一直活着的原因；新 spec 补的就是这块盲区。

## 4. 相邻套件

`grep -rl "comments.ts\|commentsRouter\|markAllCommentsRead" packages/core-backend/tests` → 8 个文件，逐个跑：

| 文件 | 结果 |
| --- | --- |
| tests/unit/comment-routes-row-deny.test.ts | 5 passed |
| tests/unit/comment-service.test.ts | 49 passed |
| tests/unit/comment-mark-all-read-actor.test.ts（新增） | 3 passed |
| tests/unit/approval-admin-jump-migration.test.ts | 12 passed |
| tests/integration/rc-regression.test.ts | 53 passed |
| tests/integration/approval-comments.db.test.ts | 被 `vitest.config.ts:1323` exclude（真库 lane），本机不执行 |
| tests/integration/multitable-permmatrix-b4-g8-comments-visibility-realdb.test.ts | 无 DATABASE_URL → skipped |
| tests/helpers/approval-schema-bootstrap.ts | 非 spec（helper） |
| tests/unit/multitable-oapi-allowlist-guard-tripwire.test.ts | **1 failed（本机 CRLF 假红，见下）** |

### 4.1 tripwire 假红判定（与本改动无关）

`#3365 OAPI allowlist⟺guard tripwire` 的 sanity 例失败：`expected 0 to be greater than 50`
（`tests/unit/multitable-oapi-allowlist-guard-tripwire.test.ts:149`，`ALL_ROUTES.length === 0`）。

根因是本机 `git config core.autocrlf=true`，工作树是 CRLF；该测试用
`src.split('\n')` 后配 `/^\s*router\.(get|…)\(\s*'([^']+)'\s*,(.*)$/`，而 JS 里 `.` 不匹配 `\r`、
非 multiline 的 `$` 只认字符串末尾，于是每行尾的 `\r` 让**所有**匹配落空。实测：

```
src/routes/comments.ts     crlf= true raw= 0 strippedCR= 18  guarded= 4
src/routes/univer-meta.ts  crlf= true raw= 0 strippedCR= 104 guarded= 10
```

`univer-meta.ts` 本单一个字节没碰，同样 raw=0 —— 证明是环境级（Windows CRLF），不是我的改动；
去掉 `\r` 后总计 122 条注册（>50），CI（Linux/LF）走的是这条。与既有结论一致：这类套件只在 Windows 上红，
CI 才是裁判。我的 diff 没有增删任何 `router.<verb>('…', …)` 注册行，guarded/unguarded 集合不变。

## 5. 类型检查

```
$ pnpm exec tsc --noEmit   (packages/core-backend)
TSC_EXIT=0
```

## 6. 新 spec 会被无库 CI 收下

- CI 无库 job 跑 `pnpm --filter @metasheet/core-backend test`（`.github/workflows/plugin-tests.yml:842-844`），
  package 脚本 `test: vitest` → 用仓库默认 `packages/core-backend/vitest.config.ts`。
- 该 config **没有 `include` 键**（`grep -c "include:" vitest.config.ts` → 0，只有 `exclude` 与 coverage 的
  `exclude`），走 vitest 默认 include（`**/*.{test,spec}.?(c|m)[jt]s?(x)`）；`exclude` 数组里
  **没有任何 `tests/unit/...` 条目**（`grep -n "'tests/unit" vitest.config.ts` 无命中）。
- 正/负对照（CLI 文件名过滤与 config 的 include/exclude 取交集，被 exclude 的文件即使点名也不会跑）：

```
$ pnpm exec vitest run tests/unit/comment-mark-all-read-actor.test.ts tests/integration/approval-comments.db.test.ts --reporter=dot
 ✓ tests/unit/comment-mark-all-read-actor.test.ts  (3 tests) 50ms
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

同时点名两个文件：被 exclude 的 `approval-comments.db.test.ts` 一例都没跑（负控），
新 spec 跑满 3 例（正控）→ 新 spec 在默认收集集合内。

## 7. 边界自查

- 只改了 `packages/core-backend/src/routes/comments.ts`（+23/-5）与新增 1 个 spec、2 个 docs；
  `git status --short` 无其它改动。
- `CommentService`、其它路由、`apps/web`、`plugins/`、`.github/workflows/*`、任何 pin 文件均未触碰
  （本单未改动被 pin 的文件，无需重打 pin）。
- 没有为了让读取更宽而放宽任何回退/作用域：G-8 sheet 门与 row-deny 排除列表原样；本改动是纯收紧
  （写主体从"body 可控"→"认证主体"）。
- 变异探针落在 scratchpad，不在仓库内；worktree 无残留（无 `w4g-*` 文件）。

## 8. 不确定项

- 本机 `vitest list`（全量收集）跑 >10 分钟未出结果，遂改用上面的正/负对照证明收集范围；
  全量单测套件本机未跑完（既有 Windows 假红面较大），以 CI 为准。
- 仓库外是否有仍在发 `userId` 的老客户端无法证伪；该修法对其不返 400，只把它的写入改回"标自己的"。
