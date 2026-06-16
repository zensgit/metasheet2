# 多维表评论 Emoji 反应 — B6-S0 设计锁 — 2026-06-15

> Status: **DESIGN-LOCK**（新弧 B6，owner 已 opt-in 2026-06-15「按建议执行」）。本弧的 autonomous 半 = **反应存储 + API**（后端，单测/真实 DB 可闭环）；emoji picker UI = B6-b（browser-gated，本弧不做）。realtime 广播随 picker 落（本弧推迟）。
>
> 方法：grounded against `origin/main`（评论子系统逐文件核验 + dynamic workflow `wf_c8626e35-f6f` 五路并行 map）；三处关键分叉经 advisor 复核后**作为有意决策**记录于 §3。

## 1. 范围（切片）

- **B6-a（本弧 autonomous）**：`meta_comment_reactions` 存储 + `addReaction/removeReaction` service + 聚合读 + 两个路由 + 删评论级联 + 单测/集成测。
- **B6-b（browser-gated，推迟）**：emoji picker UI + 实时广播 + i18n 标签。
- **非目标**：反应通知/收件箱集成、反应权限细分、自定义 emoji、跨表反应。

## 2. 存储（镜像 `meta_comment_reads` 先例）

迁移 `zzzz20260615190000_create_meta_comment_reactions.ts`（自动发现，无需注册；命名排在既有评论迁移之后）：

```sql
CREATE TABLE IF NOT EXISTS meta_comment_reactions (
  comment_id text NOT NULL,
  user_id    text NOT NULL,
  emoji      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (comment_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_meta_comment_reactions_comment
  ON meta_comment_reactions(comment_id);
```

- 三元组主键 = 同一用户对同一评论同一 emoji 只一行 → **加 = 幂等**（`ON CONFLICT (comment_id,user_id,emoji) DO NOTHING`）；一个用户可对同一评论加多个不同 emoji。
- **无 FK**（遵从评论子域全程无 FK 的既有约定；级联在应用层做，见 §4）。
- kysely 类型：`db/types.ts` 加 `MetaCommentReactionsTable { comment_id: string; user_id: string; emoji: string; created_at: CreatedAt }` + 在 `Database` 接口注册 `meta_comment_reactions`。
- 迁移**不**需 lockfile / sync-test 改动（仅依赖既有 kysely；无 DB 枚举约束，见 §3.2）。

## 3. 三处关键决策（advisor 复核，有意而非沿袭类比）

### 3.1 权限闸 = `comments:write`（非 `read`）

反应是**署名、持久、对他人可见的产物** → 属"创建评论"桶，非"已读回执"桶。可逆性不对称：以 `write` 上线后放宽到 `read` 向后兼容；以 `read` 上线后收紧到 `write` 是破坏性变更、且期间已让只读用户写了不该写的数据。故 `rbacGuard('comments', 'write')`，与 `createComment` 一致（workflow 权限路也指明 `comments:write`）。

自作用域安全：反应行以 actor 的 `user_id` 为键，`removeReaction` 按 `user_id = actor` 过滤 → 用户只能加/删**自己**的反应，无法动他人的。`addReaction` 经 `getRequiredCommentRow` 校验评论存在（不存在 → 404），与 `createComment`/`deleteComment` 同款（评论子系统的授权模型是粗粒度 capability，本弧不引入也不回退 per-sheet ACL）。

### 3.2 emoji 白名单 = 代码常量，**不用 DB CHECK 约束**

存在 `chk_automation_action_type` 这一 DB-CHECK + drift-guard sync-test 先例，但那适用于 action-type（executor 据以派发的**协议枚举**，非法值=bug/安全洞）。emoji 是**展示 token**：非法值仅"长得怪"，无正确性/安全影响，且调色板是 UX 驱动、会变。DB CHECK 会让每次调色板微调都变成迁移 + sync-test（本会话刚在 action-type 上付过这笔记账成本）。故白名单放服务端常量 `COMMENT_REACTION_EMOJIS`，未知 emoji → `CommentValidationError`(400)；将来若要放开自定义 emoji，删一处校验即可、零迁移。无 DB 枚举 → 无 drift-test 需求，仅单测「服务端拒非白名单 emoji」。

### 3.3 DELETE 的 emoji 走**请求体**，不走 path 参数；删除测试走真实 HTTP wire

`❤️` = ❤ + U+FE0F（变体选择符）。emoji 入 URL path 参数时，客户端编码与服务端解码间任何 NFC/NFD 或变体符差异会让 `DELETE … WHERE emoji = $1` 匹配零行 → 反应删不掉（典型 wire-vs-fixture 漂移：in-process 调 `removeReaction` 的单测过、真实 HTTP 路却丢行）。对策三重：(a) DELETE 的 emoji 入 **请求体**（Express 允许 DELETE-with-body），与 POST 对称、绕开 path 编码；(b) service 在加/删/校验前对 emoji 做 `.normalize('NFC')`，存储规范化；(c) 删除有一条**经真实路由**的集成测（编码→路由→断言行已删）。

## 4. Service / 路由契约

Service（`CommentService.ts`，kysely）：
- `addReaction(commentId, userId, emoji)`: normalizeUserId → NFC-normalize emoji → 白名单校验(否则 `CommentValidationError`) → `getRequiredCommentRow`(否则 `CommentNotFoundError`) → `insertInto('meta_comment_reactions').values({...,created_at: now}).onConflict(oc => oc.columns(['comment_id','user_id','emoji']).doNothing())`。
- `removeReaction(commentId, userId, emoji)`: normalizeUserId → NFC-normalize → 白名单校验 → `deleteFrom('meta_comment_reactions').where(all three)`（删不存在 = no-op，幂等）。
- `listReactionsForComments(commentIds, viewerId?)`: **空 ids → 立即返回空 Map**（避免 `IN ()` 语法错 500）；否则 `select comment_id, emoji, count(*) as count, bool_or(user_id = viewer) as reacted_by_me ... group by comment_id, emoji order by emoji`，返回 `Map<commentId, {emoji,count,reactedByMe}[]>`。
- `getComments` 末尾按返回的评论 id 调上者并把 `reactions` 挂到每条（镜像 inbox 挂 reads 的方式）；新增可选 `viewerId` 入 `CommentQueryOptions`，路由传 `getUserId(req)`。
- `deleteComment` 事务内追加 `trx.deleteFrom('meta_comment_reactions').where('comment_id','=',commentId)`（应用层级联，§2 无 FK）。

DTO：`Comment`（service）+ `CommentRecord`（di）加 `reactions?: CommentReactionSummary[]`；新增 `CommentReactionSummary { emoji: string; count: number; reactedByMe: boolean }`。`ICommentService` 加 `addReaction`/`removeReaction` 签名。

路由（`routes/comments.ts`，信封 `{ok,data,error}`，错误经 `respondCommentError` 映射）：
- `POST /api/comments/:commentId/reactions`，`rbacGuard('comments','write')`，body `{ emoji: string }` → `addReaction(commentId, getUserId(req), emoji)` → `201 {ok:true,data:{}}`。
- `DELETE /api/comments/:commentId/reactions`，`rbacGuard('comments','write')`，body `{ emoji: string }` → `removeReaction(...)` → `204`。

## 5. 验证计划

- 单测（`comment-service.test.ts` 或新 `comment-reactions.test.ts`，真实 PG）：加→持久；幂等（加两次=1 行）；删；删不存在=no-op；非白名单 emoji→`CommentValidationError`；缺评论→`CommentNotFoundError`；`getComments` 返回聚合 `{emoji,count,reactedByMe}`，count 正确、reactedByMe 随 viewer 变；`deleteComment` 后反应行清零；空 ids 聚合不炸。
- 集成（`comments.api.test.ts`，真实 HTTP）：POST 加（write 闸：无 write 能力→403）；**DELETE 经真实路由删 `❤️`（多码点）后断言行已删**（§3.3 反漂移）；envelope/status 契约。
- `tsc` 干净；CI `test (18.x/20.x)`（含 migration-replay 在真实 PG 跑新迁移）。

## 6. 落地

B6-S0（本设计锁，docs）→ B6-a（迁移 + types + service + 路由 + di + 测）。B6-b（picker + realtime + i18n）browser-gated，待具名 opt-in。
