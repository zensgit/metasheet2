# 多维表评论 Emoji 反应 B6-a — 开发 & 校验 — 2026-06-15

> Status: **DONE + VERIFIED（autonomous 后端半）**。B6 弧的 autonomous 半 = 反应存储 + API，本文记录其开发与校验。emoji picker UI + 实时广播 = B6-b（browser-gated，待具名 opt-in）。
>
> 设计锁：`multitable-comment-reactions-b6s0-designlock-20260615.md`（三处关键分叉经 advisor 复核为有意决策）。grounded：评论子系统逐文件核验 + dynamic workflow `wf_c8626e35-f6f` 五路并行 map。

## 1. 开发（做了什么）

| 层 | 文件 | 改动 |
|---|---|---|
| 迁移 | `db/migrations/zzzz20260615190000_create_meta_comment_reactions.ts`（新） | `meta_comment_reactions(comment_id, user_id, emoji, created_at, PRIMARY KEY(comment_id,user_id,emoji))` + `idx ON (comment_id)`；镜像 `meta_comment_reads`；无 FK（评论子域约定）；自动发现，无注册 |
| kysely 类型 | `db/types.ts` | `MetaCommentReactionsTable` + 在 `Database` 注册 `meta_comment_reactions` |
| 契约 | `di/identifiers.ts` | `CommentReactionSummary {emoji,count,reactedByMe}`；`CommentRecord.reactions?`；`CommentQueryOptions.viewerId?`；`ICommentService` 加 `addReaction`/`removeReaction` |
| 服务 | `services/CommentService.ts` | `COMMENT_REACTION_EMOJIS` 白名单常量 + 导出的 `normalizeCommentReactionEmoji`（NFC+白名单）；`addReaction`（insert + `onConflict.doNothing` 幂等，先校验 emoji 再 `getRequiredCommentRow` 404）；`removeReaction`（按 user_id 自作用域删，幂等）；`listReactionsForComments`（空 ids 短路、`group by comment_id,emoji`、`count`、`bool_or(user_id=viewer)`）；`getComments` 末尾挂 `reactions`（新增 `viewerId` 入 options）；`deleteComment` 事务内级联删反应 |
| 路由 | `routes/comments.ts` | `POST /api/comments/:commentId/reactions {emoji}` + `DELETE …/reactions {emoji}`（emoji 入 body）；`rbacGuard('comments','write')`；`getComments` 传 `viewerId=getUserId(req)`；错误经 `respondCommentError` 映射 |

## 2. 三处关键决策（advisor 复核，详见设计锁 §3）

1. **权限闸 = `comments:write`**（非 `read`）。反应是署名、持久、对他人可见的产物 = 创建桶，与 `createComment` 同闸。可逆性不对称（write→read 放宽兼容；read→write 收紧是破坏性变更 + 期间已让只读用户写数据）。自作用域：行以 actor `user_id` 为键，删按 `user_id=actor` 过滤，用户只能动自己的反应。最初我按 mark-read 类比误选 `read`，被 advisor + workflow 权限路双双纠正。
2. **emoji 白名单 = 代码常量，非 DB CHECK**。emoji 是展示 token（非法值仅"长得怪"，无正确性/安全影响），调色板 UX 驱动会变；DB CHECK 会让每次微调变迁移+sync-test（本会话刚在 action-type 上付过此成本）。
3. **DELETE 的 emoji 入 body + NFC 归一 + 删除测试走真实 HTTP wire**。`❤️`=❤+U+FE0F；emoji 入 path 会因编码/NFC 漂移让删除匹配零行。对策：body 传参绕开 path 编码 + 加删共用 `normalizeCommentReactionEmoji`(NFC) 使存储字节一致 + 真实路由删除测试。

## 3. 校验（怎么证的）

| 校验项 | 结果 |
|---|---|
| 后端 `tsc --noEmit` | exit 0 |
| 后端**全量** unit 套件 `tests/unit` | **3320 passed / 262 files**（di/types 广引用，零回归；日志中的 error 均为故意负路径探针） |
| 新增 `comment-reactions.test.ts`（mock DB + 纯函数） | **16 passed** |
| 既有 5 个评论套件（mock） | 118 passed（getComments/deleteComment/Comment 改动无回归） |
| **真实 PG + 真实 HTTP** 反应流（`comments.api.test.ts` 新测，本地 metasheet_test 实跑） | **PASS** |
| 其余 comments.api 既有用例本地失败 | **环境性**（本地 metasheet_test 未全量迁移）；stash 我的改动后同样失败 → 证非我引入；CI 绿 main 上它们通过 |

### 3.1 真实 wire 反应测试覆盖（advisor 反漂移要点）

`adds, aggregates, idempotently re-adds, and removes comment reactions (real wire, multi-codepoint emoji)`：userA 加 `❤️`(多码点) → 幂等重加（仍 1 行）→ userB 加 → 列出聚合 `{emoji:'❤️',count:2,reactedByMe:true}` → 非白名单 `💩` → **400** → **userA 经真实 DELETE wire 删 `❤️` → 204 → 直接查 DB 确认该行已删**（仅剩 userB）→ 聚合变 `count:1,reactedByMe:false`。这是"in-process service 调用会 false-green、真实 HTTP 路才暴露"的反漂移关键覆盖。

### 3.2 纯函数 NFC 守卫直测

`normalizeCommentReactionEmoji`：白名单各 emoji round-trip 为 NFC 形；trim 空白；`❤️` 多码点归一幂等；非白名单/裸 `❤`/空/非串 → `CommentValidationError`。加与删共用此函数 → 存储字节天然一致（结构性消除漂移，非靠测试绕过）。

### 3.3 幂等与级联

幂等：PK `(comment_id,user_id,emoji)` + `ON CONFLICT DO NOTHING`（真实 wire 测重加证 count 不变）。级联：`deleteComment` 事务内追加 `deleteFrom('meta_comment_reactions')`（无 DB FK，应用层级联，与既有 reads 级联同款）。

### 3.4 残余（诚实记录，均不阻塞）

- **`comments:write` 闸无独测**：唯一的真实-wire 套件以 `RBAC_BYPASS='true'` 运行，故无用例直接验证 write 闸、也无回归守卫防它被改回 `read`。代码中此闸正确（与 `createComment` 同款、显见无误），且不劣于既有规范（`createComment` 的闸本身也无单独 gate 测）。记此为本切片最高风险行无测试守卫——B6-b 接真客户端时可补一条 reader-only token → 403 的用例。
- **迁移文件本身未在测试中执行**：真实-wire 集成测经 `ensureCommentsTables` 用自带 DDL 建表，非走迁移文件。迁移与 reads 迁移近乎逐字相同（风险低），由 CI `migration-replay` 在 fresh PG 实跑验证（落地前已确认 `migration-replay` 绿、非 skipped）。
- **B6-b 部署路提示**：DELETE 走 body 在本系统正确（Express 解析、测试已证），但部分 API 网关/CDN 会剥离 DELETE 请求体——B6-b 接真客户端时需确认部署链路无此行为，否则 `removeReaction` 会静默 no-op。属部署路问题、非代码问题。

## 4. Goal 边界（诚实）

- ✅ **B6-a（反应存储 + API）= autonomous 后端半，done + verified。**
- ⏸ **B6-b（emoji picker UI + 实时广播 + i18n）= browser-gated，本弧不做**：picker 的 configure→render→click 真路径 + 视觉/交互目检需真浏览器，jsdom 证不了；实时广播随 picker 落（后端已把持久化/聚合做正确，事件层不留半成品）。
- B6-b 待具名 opt-in（staged-opt-in lineage 纪律）。

## 5. 落地

B6-S0 设计锁 + B6-a（迁移 + types + di + service + 路由 + 单测 + 真实-wire 集成测）+ 本开发&校验记录，单 PR。CI `migration-replay` 在 fresh PG 验迁移；`test (18.x/20.x)` 验单测 + tsc。
