# 任务 C:M3 纯函数设计(2026-09-28)

- 分支:`claude/tasks-c-pure`,基于 `main`。只推分支,开 Draft PR,不合并。
- 授权:owner 2026-09-28 原话「M3 纯函数」,针对闸方建议「起 M3 纯函数」。M3 后端(DDL、路由、服务)与前端要等 M2 合并授权,本件不做。
- 规格来源:任务功能线设计锁 `docs/development/task-feature-design-lock-20260917.md`(PR #5845 head `24f179e61c`)§3、§4、§6.2、§6.3、§6.4,§12 门 3 与门 6,§13-9、§13-23、§13-27、§13-28。
- 先例:任务 B(`docs/development/task-b-pure-functions-design-20260926.md`),同样只做 `packages/core-backend/src/tasks/` 下的无 I/O 模块与单测。

## 1. 范围

四个新模块,全部无 I/O,由门 20 的 harness(`tests/unit/task-pure-no-io.test.ts`)自动发现并校验:

| 模块 | 内容 | 锁依据 |
|---|---|---|
| `task-tree.ts` | 子任务树:深度、子孙、设父、转独立、父候选 | §6.3、门 6、§13-25 |
| `task-membership.ts` | 增删执行人、切换完成模式、增删关注人、退出 | §6.2、§13-9(按计划 §5-4)、§13-23、§13-28、门 3 |
| `task-comments.ts` | 评论正文规范化与长度上限、评论权限、墓碑形状 | §4 P0-B、§13-23 |
| `task-deletion.ts` | 删除任务的前置判定 | §13-27、§6.3 |

不做:DDL、迁移、路由、服务、前端、flag、通知扇出(§13-19 在 M4)、附件(P2)。

所有转换函数都遵守任务 B 已确立的两条规则:
- 显式传入 `now`,从不隐式读时钟;
- **没有变化就没有事件**:输入与输出等价时,返回空事件数组。

事件名全部取自锁 §4 的 `task_events.event_type` 闭集,不新增。

## 2. `task-tree.ts`

- `TASK_MAX_DEPTH = 4`(含根五层,§13-25 已定)。
- 输入是一张节点表 `ReadonlyMap<string, { parentId: string | null }>`,代表同一 org 内未删除的任务。服务层负责只传同 org、未软删的行。
- `depthOf(id, nodes)`:根为 0。沿父链走;遇到环或父不存在时抛 `TaskTreeCorruptError`(数据损坏,不是用户错误)。
- `descendantsOf(id, nodes)`:所有子孙(不含自身)。
- `subtreeHeight(id, nodes)`:自身到最深子孙的层数差,叶子为 0。
- `validateSetParent({ taskId, newParentId, nodes })`,依次判定:
  1. `taskId` 或 `newParentId` 不在表中 ⇒ `{ ok: false, reason: 'not_found' }`;
  2. `newParentId === taskId` ⇒ `'self'`;
  3. `newParentId` 是 `taskId` 的子孙 ⇒ `'descendant'`(会成环);
  4. `depthOf(newParentId) + 1 + subtreeHeight(taskId) > TASK_MAX_DEPTH` ⇒ `'depth_exceeded'`;
  5. 已经是这个父 ⇒ `{ ok: true, noop: true, depthChanges: [], events: [] }`;
  6. 否则 `{ ok: true, depthChanges: [{ id, depth }...], events: [{ type: 'parent_set' }] }`。`depthChanges` 覆盖被移动的任务及其全部子孙。
- `validateClearParent({ taskId, nodes })`(转独立):已是根 ⇒ noop;否则子树整体上移,事件 `parent_cleared`。
- `parentCandidates({ taskId, nodes })`:排除自身、全部子孙(锁 §2 第 4 条的「自有加强」),以及挂上去会超深的节点。返回排序后的 id 列表。未知任务返回空列表;表中其他行损坏仍会抛 `TaskTreeCorruptError`。
- 树与删除的事件只带 `type`;执行人由 M3 服务层在写 `task_events` 时补上(`actor_id` 列)。
- 权限:`canReparent({ childRoles, parentRoles, sameOrg })` = 两端都有 `can(roles, 'edit')` 且同 org。失败由路由统一返回 404(§6.3),本模块只给布尔值。
- **父完成不级联子**(§6.3):本模块不导出任何修改完成状态的函数;单测断言设父、转独立不触碰完成状态。

## 3. `task-membership.ts`

§13-9 已裁:「any 模式其余人 `completed_at` 置同一时刻并记 `completed_by_any`;any 重启 = 全部;增删人/切模式按计划 §5-4」。计划 §5-4 的内容已抄在锁 §6.2 的「候选」段,随 §13-9 落槌成为定案。

输入统一为 `{ mode, status, rows: TaskAssigneeRow[], now, actorId }`,输出 `{ rows, status, events }`。事件与 `task-completion.ts` 一致:带 `userId`(执行动作的人);增删执行人与关注人的事件另带 `targetUserId`;`completed_by_any` 另带 `occurredAt`。

| 函数 | 规则 |
|---|---|
| `applyAddAssignee(input & { userId })` | 已在列 ⇒ noop。新行 `completedAt: null`。**all 模式且任务已 done ⇒ 回到 open**(§5-4)。any 模式任务状态不变。事件 `assignee_added` |
| `applyRemoveAssignee(input & { userId })` | 不在列 ⇒ noop。删掉该行(§5-4「删人删行」)。然后按 `computeTaskDone` 重算,见下方「假设 A2」。事件 `assignee_removed` |
| `applySwitchCompletionMode(input & { to })` | 同模式 ⇒ noop。**all→any**:已有任一行完成 ⇒ 任务 done,其余未完成行置同一 `now`,事件 `completion_mode_changed` 与 `completed_by_any`;一行都没完成 ⇒ 仍 open。**any→all**:保留各人记录,已 done 的维持 done(§5-4)。切换后 §6.2 的 any 不变量必须成立 |
| `applyAddFollower({ followers, userId, actorId })` | 已在列 ⇒ noop;事件 `follower_added` |
| `applyRemoveFollower({ followers, userId, actorId })` | 不在列 ⇒ noop。actor 就是本人 ⇒ 事件 `left`;否则 `follower_removed` |

- 退出(`left`)只对关注人开放:`can(roles, 'leave')`,沿用任务 B 的能力矩阵(follower 可退出,creator/assignee 不可)。
- 软上限 `TASK_ASSIGNEE_SOFT_LIMIT = 50`、`TASK_FOLLOWER_SOFT_LIMIT = 50`(§13-28 建议值,**未裁**,常量单点,后续可改)。超限时 add 函数返回 `{ ok: false, reason: 'limit' }`。
- 每个转换结束后,单测都断言 §6.2 不变量:`status='open' AND mode='any'` ⇒ 不存在非空 `completedAt`。

## 4. `task-comments.ts`

- `TASK_COMMENT_BODY_MAX_CHARS = 5000`,与审批评论 `APPROVAL_COMMENT_BODY_MAX_CHARS` 同值(锁 §4:照审批评论表的形)。按 Unicode 码点计数,不按 UTF-16 单元。
- `normalizeCommentBody(raw)`:复用任务 B 的 `normalizeUserText`(NFC、去首尾空白、拒绝纯空白与纯零宽)。返回 `{ ok: true, body }`,或 `{ ok: false, reason: 'blank' | 'too_long' }`。
- `canComment(roles)` = `can(roles, 'comment')`。关注人可以评论(§13-23 建议值,已在任务 B 的能力矩阵里)。
- `canEditComment` 与 `canDeleteComment({ authorId, actorId, deleted })`:只有作者本人可以,已删除的评论不可再改。
- `toCommentView(row)`:已删除的评论返回 `body: null`(墓碑形状,与审批评论一致)。
- 事件 `commented`(仅新建时;编辑与删除不产生 `task_events`,事件闭集里没有对应词)。

## 5. `task-deletion.ts`

- 只做软删(§13-27 建议值:P0 只软删)。
- `planDeleteTask({ taskId, nodes, roles })`:
  0. 任务不在未删除节点表中(不存在或已删除) ⇒ `{ ok: false, reason: 'not_found' }`,避免重复发 `deleted`;
  1. 没有 `can(roles, 'delete')` ⇒ `{ ok: false, reason: 'forbidden' }`(路由统一按 404 处理);
  2. 还有未删除的子任务 ⇒ `{ ok: false, reason: 'has_children' }`,见「假设 A4」;
  3. 否则 `{ ok: true, events: [{ type: 'deleted' }] }`。

## 6. 假设(A1–A7 已于 2026-09-28 接受)

锁在以下几点没有写死。本件按保守、可逆的方向实现,每处在源码里以 `ASSUMPTION(task-c)` 标注。**A1–A7 已由 owner 于 2026-09-28 接受**(「按建议执行:A1–A7 接受」,见 `docs/development/task-c-m3-pure-functions-verification-20260928.md` §0/末段)。其中 A6、A7 修改了 main 上的 `task-completion.ts`:

| 编号 | 问题 | 本件的选择 | 理由 |
|---|---|---|---|
| A1 | 向**已完成的 any 模式**任务加执行人 | 新行 `completedAt: null`,任务仍 done | §5-4 只写了 all 模式回 open;any 不变量只约束 open 状态 |
| A2 | 删人后是否重算完成 | all 模式:剩余至少一行且全部完成 ⇒ done;删到零行 ⇒ 维持原状态(零行不判 done,也不回退)。any 模式:状态不变 | 与完成公式一致;不因删人把 done 任务悄悄改回 open |
| A3 | 评论编辑、删除的权限 | 仅作者本人 | 与审批评论一致;最保守 |
| A4 | 删除有子任务的父任务 | 拒绝,`has_children` | 锁未定级联;拒绝可逆,级联删除不可逆 |
| A5 | 软上限 50 | 常量,超限拒绝 | §13-28 是建议值,未裁 |
| A6 | 已完成任务的完成与重开以什么为准 | 以任务行状态为准:`task-completion.ts` 的 `wasDone` 在所有模式下生效。已完成的任务再完成是空操作;已完成的 any 任务、以及 all 模式下 scope 为 `all` 的重开,即使没有任何已完成行也能重开 | 第 1 轮审阅发现 A1 会让任务卡在已完成(穷举 1291 个卡死态);any 任务完成后加人再切到 all,也会得到全空行的已完成任务。改后穷举卡死态为 0 |
| A7 | 已完成的 all 任务,有人以 `scope: 'self'` 重开,自己的行没有变化,但重算后任务不再算已完成(例如从 any 带过来的空行) | 事件记 `reopened`(owner 2026-09-28 接受);若重算后仍算已完成,则不发事件 | 第 2 轮审阅按 #6062 服务层的真实行为(按行重算状态、重开默认 `self`)建模,发现这种翻转原本不写事件 |

**A6 对 #6062 的影响**:#6062 的服务层已从加锁后读到的任务行传入 `wasDone`(`task.status === 'done'`),不需要改代码;行为变化是「对已完成任务再次完成」从可能重发事件变为空操作。此改动修改的是 main 上 #6086、#6102 引入的 `task-completion.ts`,需要 owner 确认。

## 7. 验证计划

- 每个模块一个单测文件 `tests/unit/task-<module>.test.ts`。
- 门 6 的纯函数部分:深度 0..4 的每一层、刚好到 4 层可以、超过 4 层拒绝、自身、直接子、深层子孙、父不存在、已损坏的树(环、悬空父)。
- 门 3 的 M3 格:all/any × 加人/删人/切模式,在已完成和未完成两种状态下各跑一遍,每格之后断言 §6.2 不变量。
- 无变化无事件:每个 noop 路径都断言空事件数组。
- 关键守卫逐一做 mutant(备份 → 改 → 跑 → 还原),记录进验证文档。
- 门 20:新文件被 harness 自动发现,调用每个导出不触发 I/O。
- core-backend 全量单测与 `tsc --noEmit`。
