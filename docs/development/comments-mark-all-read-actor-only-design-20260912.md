# mark-all-read 只以认证主体为准（W4-G）

- 日期：2026-09-12
- 分支：`fix/comments-mark-all-read-actor-only`（基线 `origin/main` @ `9fb29831c`）
- 来源：W4-F（`x-user-id` 死回退核查）顺带发现的真洞
- 验证件：`docs/development/comments-mark-all-read-actor-only-verification-20260912.md`

## 1. 问题

`POST /api/multitable/:spreadsheetId/comments/mark-all-read` 把**写回执的主体**交给请求体决定：

`packages/core-backend/src/routes/comments.ts:670-671`（origin/main `9fb29831c` 上的行号；修后同文件 :689-690）

```ts
// Prefer body userId; fall back to authenticated user
const userId = parsed.data.userId?.trim() || context.userId
const count = await commentService.markAllCommentsRead(spreadsheetId, userId, deniedRows(context))
```

任何**已认证**、拿着 `comments:write` 且对该 sheet 有读权（下面 G-8 门放行）的调用方，发
`{"userId":"<受害者>"}` 就能让服务以受害者身份批量写读回执。

## 2. 调用链（谁生产输入、谁消费输出、守卫在哪）

1. 入口：`packages/core-backend/src/routes/comments.ts:670`
   `router.post('/api/multitable/:spreadsheetId/comments/mark-all-read', rbacGuard('comments','write'), …)`
   - `rbacGuard`：`packages/core-backend/src/rbac/rbac.ts:54-114`。`req.user?.id` 为空 → **401**（:60-66）；
     否则要求 `comments:write`（resolved 权限/admin/表查询，:69-108）。**它只管粗粒度权限码，不认 sheet，
     更不认"你要替谁写"**。
2. body 解析：`comments.ts:676-684`（zod，`userId` 可选字符串）。
3. sheet 可见性门：`comments.ts:687` → `resolveCommentReadContext`（`comments.ts:138-154`）
   → `resolveSheetReadableCapabilities`（`packages/core-backend/src/multitable/permission-service.ts:1811-1830`）
   → `resolveRequestAccess`（`packages/core-backend/src/multitable/access.ts:53-91`）。
   - `access.userId` 只来自 `req.user.id / sub / userId`（access.ts:56-60），即**认证主体**。
   - `context.userId = access.userId || getUserId(req)`（comments.ts:153）。
   - 该门只回答"这个**认证主体**能不能读这张表"，对 body 里的 `userId` 一无所知——所以它挡不住冒名。
4. 消费：`CommentService.markAllCommentsRead`（`packages/core-backend/src/services/CommentService.ts:944-981`）
   以传入 userId 为准：`.on('r.user_id','=',normalizedUserId)`、`.where('c.author_id','!=',normalizedUserId)`，
   再 `insertInto('meta_comment_reads').values({comment_id, user_id: normalizedUserId, …})
   .onConflict(… doUpdateSet({read_at}))`。服务层没有、也不该有"这是不是你自己"的判断——它是被调用方，
   身份是入参。
5. 调用方现状：`apps/web/src` 里**没有**任何调用方（`grep -rn "mark-all-read" apps/web/src` 命中的是
   `/api/approvals/mark-all-read`、`/api/multitable/record-subscription-notifications/mark-all-read`
   两个无关端点）。仓库里唯一的调用者是
   `packages/core-backend/tests/unit/comment-routes-row-deny.test.ts:213`，发的是 `{}`。

## 3. 为什么这是真洞，而同文件的 `x-user-id` 回退不是

- **真洞**：这条路径上没有任何一环校验"body 里的 userId == 认证主体"。`rbacGuard` 只看权限码，
  G-8 门只看认证主体对 sheet 的读权，服务层把 userId 当入参。攻击者只需要一个正常账号 + 一张双方都能读的
  表，就能把受害者的未读/@提醒在该表上清空（`meta_comment_reads` upsert 不可逆地把 `read_at` 写上去）。
  影响面是"静默抹掉他人未读态"（可用性/完整性），不是读取泄漏——服务只写回执表，不回吐内容。
- **`comments.ts:77-85` 的 `getUserId` 里 `x-user-id` 请求头回退不是洞（W4-F 已证不可达）**：
  该函数只被挂了 `rbacGuard` 的 handler 调用，而 `rbacGuard` 在 `req.user?.id` 为空时先 401
  （rbac.ts:60-66）。也就是说到达 `getUserId` 时 `user.id` 必非空，`??` 链在命中 header 之前就短路了。
  它是**死回退**，本单按任务口径不清理，见 §6 残余。
- 两者的差别就是一句话：**死回退需要"没有认证主体"才生效，而 body 里的 `userId` 在有认证主体时照样生效。**

## 4. 修了什么

`packages/core-backend/src/routes/comments.ts:689-690`：

```ts
// Actor only. `parsed.data.userId` is deliberately NOT consulted (W4-G).
const count = await commentService.markAllCommentsRead(spreadsheetId, context.userId, deniedRows(context))
```

- 身份只取 `context.userId`（=`resolveRequestAccess` 读到的认证主体），与本文件其它每一处"替本人写"的
  调用完全一致（`markMentionsRead` :577、reactions :557、`viewerId` :234）。
- **`userId` 字段保留在 zod schema 里，但永不被读**（`comments.ts:676-680` 带注释，JSDoc :647-669 写明
  "ACCEPTED AND IGNORED"）。二选一的理由：
  - 若把字段从 schema 删掉，zod 默认 strip 未知键，well-formed 请求行为相同，**但** `{"userId":""}`
    会从现在的 400 变成 200 —— 那是安全修复之外的行为变化；
  - 保留字段则**所有输入的状态码与 main 逐字一致**，只有 actor 变了；
  - 同时在代码里留下显式注释标记，避免后来人把这条分支当成"丢了的功能"再加回来（新增的变异探针会红）。
- 不 400 拒绝该字段：老客户端（如果存在）继续可用，只是只能标自己的已读。

## 5. 没修什么（本单边界）

- 不动 `CommentService`（`markAllCommentsRead` 的签名/语义不变；身份是入参，收紧点在路由）。
- 不动其它路由；不动 `apps/web`、`plugins/`、`.github/workflows/*`、任何 provenance pin。
- 不清理 `comments.ts:77-85` 的 `x-user-id` 死回退（任务明确排除，登记为残余）。
- 没有放宽任何读/写作用域：本改动只把写主体从"body 可控"收紧为"认证主体"，G-8 sheet 门与 row-deny
  排除列表（`deniedRows(context)`）原样保留。

## 6. 残余（登记，不在本单做）

1. **`comments.ts:77-85` `getUserId` 的 `x-user-id` 死回退**：W4-F 已证不可达（每条 handler 前都有
   `rbacGuard`，`req.user.id` 必非空）。清理是纯减法，但会碰到 `getUserId` 的 8 个调用点，且需要给
   "user.id 缺失时返回什么"定个口径（抛 500 还是继续 `'anonymous'`）；单独一单做。
2. **`kanban.ts:23-33` 的 `parseInt` 串状态**：
   ```ts
   const raw = user?.id ?? req.headers['x-user-id']
   if (typeof raw === 'string') { const parsed = parseInt(raw, 10); return Number.isFinite(parsed) ? parsed : 0 }
   return 0
   ```
   `getUserId` 返回 **number**，用于 `view_states`（`user_id` 列是 `integer`，见
   `packages/core-backend/src/db/migrations/20250924120000_create_views_view_states.ts:90`，并带
   `UNIQUE(view_id, user_id)`）。现网用户 id 是 UUID/字符串时 `parseInt` → `NaN` → **0**，于是所有此类
   用户共享 `user_id=0` 这一行看板个人状态（互相覆盖）；形如 `123abc` 的 id 还会被截成 `123`，撞进别人的
   桶。这需要**列类型裁决**（`view_states.user_id` integer → text/uuid 的迁移 + 现有行怎么办），
   不是路由层能单独修的，按任务要求只登记。注意 kanban 路由**没有** `rbacGuard`（全局 `/api/**`
   中间件之外无路由级守卫），所以它的 `x-user-id` 回退是否可达要单独核查，不能套用 W4-F 的结论。
3. **`KANBAN_AUTH_REQUIRED` 过时文档**：`docs/api/kanban.md:7`、`apps/web/docs/KANBAN_UI.md:40`、
   `docs/quickstart.md:31` 仍在教用户"默认接受 `x-user-id` 回退，设 `KANBAN_AUTH_REQUIRED=true` 才强制
   JWT"；代码侧该开关只剩 `src/config.ts:71,77` / `src/config/index.ts:67` 的配置读取。文档与实际链路是否
   还一致要连同残余 2 一起核，改文档前先定结论。

## 7. 不确定项

- 是否存在仓库外的老客户端（移动端/脚本）真的在发 `userId`：无法证伪；本修法对它们只是"改成标自己的已读"，
  不会 400。
- 本单只证了 HTTP 路由层的主体收紧；`meta_comment_reads` 的历史脏数据（若曾被冒名写入）不在本单范围，
  也没有可靠特征可回溯区分。
