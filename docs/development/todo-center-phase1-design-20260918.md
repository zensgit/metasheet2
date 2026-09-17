# 待办中心 Phase-1(切片 B-1,后端)—— 设计 MD

派生自 `todo-center-design-lock-draft-20260915.md` v2.14(**RATIFIED 2026-09-18**,授权来源见该文件抬头
RATIFY 记录)。本文档只覆盖目标文档
`goal-three-locks-full-implementation-20260918.md` 切片表的 **B-1 后端** 切片;B-2(前端中心页、徽标
接线、判据 E 代数守卫)是独立切片,不在本文档范围。

工作树:`/private/tmp/claude-501/-Users-chouhua-Downloads-Github-metasheet2/6f6639a7-0412-43de-bd8b-0b416d18ae6b/scratchpad/wt-todo`
(分支 `feat/todo-center-shared-pending-query`,合并基点 `git merge-base origin/main HEAD` =
`89f1ecdee2c3b70205a318074824c834bc6a5c7e`——不是锁文引用行号所锚定的 `85ddd2926`)。本文档除 §2「数据
模型与约束」表的「迁移文件:行」一列外,所有 file:line 引用均由本次会话在该工作树上重新 `grep -n`/
`sed -n` 得到,不是从 diff hunk 直接转抄。§2 那一列的行号**转录自锁文**(锁文基线 `85ddd2926`),已在
本次会话用 `sed -n`/`grep -n` 在当前工作树(合并基点 `89f1ecdee`)上逐条重新核对,五条全部字节一致
(见 §2 表下方的核对记录)——这五条迁移文件本身不在本切片的改动范围内,分支未修改它们,故基线差异
不影响其行号。

## 1. 范围 / 不在范围

### 1.1 范围(逐条引用锁文 §)

| # | 内容 | 锁文依据 |
|---|---|---|
| 1 | 提取一份共享「待处理」查询 `buildApprovalPendingConditions` + 取行版本 `listApprovalPendingRowsForViewer` + 计数版本 `countApprovalPendingForViewer`,复刻 §1.5① 整条语句(WHERE 四条件 + `source_system` 可选合取项 + `count`/`unreadCount` 两输出) | 锁 §3.0(首行:「首期第一项工作」)+ §5 判据 A0 的复刻范围描述 |
| 2 | `GET /api/approvals/pending-count` 零行为改接:内部调共享查询,响应形状不变 | 锁 §4「先做 §3.0 的共享『待处理』查询提取(含把 `/pending-count` 改为调它,零行为变化)」 |
| 3 | `PendingSourceRegistry`(注册表)+ `GET /api/todo/items`(聚合列表)+ `GET /api/todo/count`(聚合计数),**只注册审批源** | 锁 §4「再做 `PendingSourceRegistry` + `GET /api/todo/items`(聚合)+ `GET /api/todo/count`,**只注册审批源**」 |
| 4 | 响应含每源状态(`ok`/`unavailable`);fail-closed 且可判别 | 锁 §3 硬约束「fail-closed 且可判别」+ 锁 §4「响应含每源状态」 |
| 5 | 列表项带 `actionable`,复用 `resolveCanDecideCurrentNode` | 锁 §3.0「列表项必须带 `actionable`」段 |
| 6 | 列表按实例去重,与计数口径对齐(同一份共享谓词) | 锁 §3 硬约束「列表按实例去重」+ 判据 C |
| 7 | 实时:复用按用户 room,追加 `todo:counts-updated` 广播 | 锁 §4「实时:复用按用户 room,发 `todo:counts-updated`」 |
| 8 | 独立 vitest project(反 skip-green 三件 + RBAC posture)+ 十四类 viewer 夹具 + 判据 A0/A/B(API 层半边)/C/C′/D/F | 锁 §3.0「测试约束」段 + §6「交付形态」 |
| 9 | 两点 CI 接线 + 触发集(`on.push.paths`/`pull_request.paths`) | 锁 §6 |

### 1.2 不在范围(逐条引用锁文 § 与分期,以及目标文档的切片切分)

| # | 内容 | 依据(锁文 § / 目标文档分期) |
|---|---|---|
| 1 | 待办中心前端页(按来源分组、导航) | 锁 §4「前端:待办中心页...」;目标文档 B-2 |
| 2 | 徽标改读 `todo/count` + 承接判据 B 的**徽标层**半边(stub `degraded`) | 锁 §4「顶部徽标改读 `todo/count`...」;目标文档 B-2;本切片只交付判据 B 的 **API 层**半边(见 §3 判据 B 说明) |
| 3 | 判据 E(代数守卫:登出/换 org 作废在飞请求) | 锁 §3 硬约束「不缓存跨越鉴权变化」;目标文档 B-2「判据 E 代数守卫」——补充清单条目 11 同样把 E 划给前端切片 |
| 4 | 评论源(v1.1)、云课堂「待处理」定义、任务源(等任务线) | 锁 §4「不做」段;锁 §7-3/§7-4/§7-5 |
| 5 | 角色来源 (b)(`viewerRoles` 加宽)与决策门同步加宽 | 锁 §7-2′ ——独立裁决,需与门同步加宽一起裁,本锁不承担 |
| 6 | AuthService 层静默收窄(`isRbacAdmin`/`listUserPermissions` 抛错吞 `logger.warn`)的修复 | 锁 §7-6——登记为平台授权线独立发现,本锁验收不以它为前提 |
| 7 | `routes/todo.ts` 的 `approvals:read` 单一权限门槛在第二个源注册后收窄为按源判权限 | 本切片自身代码的已知局限(见 §6「留给后续切片的项」),锁文未点名,由实现记录 |

## 2. 数据模型与约束(只读;无新表)

本切片**不新增任何表或列**(判据 F,见 §7 验收摘要)。下表是共享查询依赖的既有 schema 约束,每条对应
锁文 §3.0 行号(基线 `85ddd2926`,即锁文第 90 行「十四个 viewer 的 seed 可执行顺序」段落内嵌的迁移引
用):

| 约束 | 迁移文件:行 | 锁文 § 行 |
|---|---|---|
| `approval_assignments.assignment_type` CHECK 含 `'source_queue'` | `zzzz20260404100000:88` | 锁 §3.0 行 90(S8 段) |
| `approval_assignments.assignee_id` NOT NULL | `zzzz20260404100000:89` | 同上 |
| `approval_instances.id` (text) NOT NULL 无默认 | `20250924105000_create_approval_tables.ts:10-11` | 锁 §3.0 行 90(S7 段) |
| `approval_reads` 主键 `(user_id, instance_id)` | `zzzz20260423140000:12` | 锁 §3.0 行 90(S9 段)+ 判据 A0 类 ⑫⑬ |
| `approval_published_definitions` `UNIQUE (template_id) WHERE is_active = TRUE` | `zzzz20260411120100:100-102` | 锁 §3.0 行 90(S6 段) |

**上表五行在当前工作树上逐条重新核对**(合并基点 `89f1ecdee`,这五份迁移文件均未被本分支改动):

```
$ grep -n "assignment_type TEXT NOT NULL CHECK" packages/core-backend/src/db/migrations/zzzz20260404100000_extend_approval_tables_for_bridge.ts
88:    assignment_type TEXT NOT NULL CHECK (assignment_type IN ('user', 'role', 'source_queue')),
$ grep -n "assignee_id TEXT NOT NULL" packages/core-backend/src/db/migrations/zzzz20260404100000_extend_approval_tables_for_bridge.ts
89:    assignee_id TEXT NOT NULL,
$ sed -n '9,11p' packages/core-backend/src/db/migrations/20250924105000_create_approval_tables.ts
  await sql`CREATE TABLE IF NOT EXISTS approval_instances (
    id text PRIMARY KEY,
    status text NOT NULL,
$ sed -n '12,16p' packages/core-backend/src/db/migrations/zzzz20260423140000_create_approval_reads.ts
    CREATE TABLE IF NOT EXISTS approval_reads (
      user_id TEXT NOT NULL,
      instance_id TEXT NOT NULL REFERENCES approval_instances(id) ON DELETE CASCADE,
      read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, instance_id)
$ sed -n '100,102p' packages/core-backend/src/db/migrations/zzzz20260411120100_approval_templates_and_instance_extensions.ts
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_published_definitions_active_template
    ON approval_published_definitions(template_id)
    WHERE is_active = TRUE`.execute(db)
```
五条全部与锁文引用的行号一致;`approval_reads` 的 PK 语句本身落在 `:16`(`CREATE TABLE` 语句起于
`:12`,锁文引用 `:12` 是表声明起始行,不是 PK 子句本身所在行——两个行号都标在上表备注里,不是矛盾)。

DTO / 内存契约(本切片新增,均为纯投影,不落表):

| 类型 | 字段 | 定义处 |
|---|---|---|
| `ApprovalPendingViewer` | `{ actorId, roles, permissions }` | `services/approval-pending-query.ts:50-54` |
| `PendingViewer`(注册表层的同形契约) | `{ actorId, roles, permissions }` | `services/pending-source-registry.ts:33-37` |
| `ApprovalPendingRow` | 实例列 + `assignments: SeatedAssignment[]` | `services/approval-pending-query.ts:150-164` |
| `PendingItem` | `{ source, id, title, dueAt?, href, updatedAt, actionable? }` | `services/pending-source-registry.ts:16-27` |
| `PendingItemsResult` / `PendingCountResult` | `{ items/count, sources: Record<string, 'ok'\|'unavailable'> }` | `services/pending-source-registry.ts:49-57` |

约束来源(逐条对应锁文 §3.0 正文,不改写):
- viewer 三路输入契约(`actorId`/`roles`/`permissions`)——锁 §3.0「viewer 契约 = `{ actorId, roles,
  permissions }` 三路输入…缺任一路都不是复刻」。
- WHERE 四条件与可选 `source_system` 合取项、SELECT 两输出的逐字复刻要求——锁 §3.0「以 §1.5 的 ① 为
  基准复刻整条语句」整段。
- 角色来源恒为 (a)——锁 §3.0「角色来源(v2.6 改…)」段 + §7-2′。
- `actionable` 复用 `resolveCanDecideCurrentNode`,输入随行(一次查询把六列 + 四字段带回,不 N+1)——
  锁 §3.0「列表项必须带 `actionable`」段 + 「输入随行」段。
- fail-closed 且可判别——锁 §3 硬约束段。
- 列表按实例去重、与计数同一份谓词——锁 §3 硬约束段 + 判据 C。

## 3. 接口与错误码(全部专用码)

### 3.1 新增路由(`routes/todo.ts`)

| 路由 | 认证/权限门 | 成功 | 失败(专用码) |
|---|---|---|---|
| `GET /api/todo/items` | `authenticate` + `rbacGuard('approvals','read')`(`todo.ts:50`) | `200 { items: PendingItem[], sources }` | 401 `TODO_USER_REQUIRED`(`todo.ts:40-45`,viewer 解析不到 actorId);500 `TODO_ITEMS_FAILED`(`todo.ts:57-63`,聚合层自身抛错,区别于单源失败——单源失败在注册表层被吞并标 `unavailable`,不到这里) |
| `GET /api/todo/count` | 同上(`todo.ts:66`) | `200 { count: number, sources }` | 401 `TODO_USER_REQUIRED`;500 `TODO_COUNT_FAILED`(`todo.ts:73-76`) |

两个错误码都是本切片新增的专用码,不降级为裸 HTTP 状态(补充清单条目 4 的要求)。

**已知局限,记录不修**(`routes/todo.ts:11-17` 文件顶部注释原文如此,不是事后补记):两个路由用
`rbacGuard('approvals','read')` 单一权限门槛。今天只注册了审批源,门槛与数据暴露面重合;一旦注册第二
个源(评论/任务/…),这个门槛会**错误地**对不持 `approvals:read` 的 viewer 隐藏非审批的待办项——必须
在那之前改为按源判权限或 `rbacGuardAny`。见 §6。

`rbacGuard` 本身对 401/403 的响应不带专用码(`res.status(401).json({ error: 'Authentication required'
})` / `res.status(403).json({ error: 'Insufficient permissions' })`,`packages/core-backend/src/rbac/
rbac.ts:64,108`)——这是仓库既有共享中间件的既定形状,被全仓所有 `rbacGuard` 消费方共用,不是本切片
引入的降级,也不在本切片改动范围内(改共享中间件影响面覆盖全仓,超出本切片授权)。

### 3.2 被本切片零行为改接的既有路由

`GET /api/approvals/pending-count`(`routes/approvals.ts:1996`)——响应形状、查询参数处理、错误码均不
变,只是内部实现改为调用共享查询:
- `sourceSystem` 白名单校验**留在路由层**,未挪进共享查询(`routes/approvals.ts:2011-2022`)——这是
  刻意的:锁 §5 判据 A0 明确警告「把白名单挪进共享查询会让它静默变 200 `{count:0}`」,故
  `buildApprovalPendingConditions` 只接受一个已校验过的 `ApprovalPendingSourceSystemFilter`
  (`'platform' | 'plm' | null`,`services/approval-pending-query.ts:56`),白名单/400 逻辑保留在
  `approvals.ts`。
- 400 `APPROVAL_SOURCE_SYSTEM_INVALID`(`routes/approvals.ts:2012-2018`,响应体经
  `approvalErrorResponse`,`routes/approvals.ts:350`)——既有专用码,未改。
- 改接调用点:`routes/approvals.ts:2027-2034`(`countApprovalPendingForViewer(pool, { actorId, roles,
  permissions }, sourceSystem)`,`sed -n '2027,2034p'` 核对过起止行)。

### 3.3 实时事件(不新增路由,追加广播)

`services/approval-realtime.ts:118-124`——`publishApprovalCountsUpdate` 在既有的
`approval:counts-updated` 广播之后,对同一 room(`buildAuthenticatedUserRoom`)追加广播
`todo:counts-updated`,payload 相同,不新开频道、不重新计算(锁 §4「实时:复用按用户 room,发
`todo:counts-updated`」)。

## 4. 事务与锁序

**本锁文没有锁序表,本切片零事务、零取锁。** 逐条证据:

```
$ grep -n "锁序" /Users/chouhua/.claude/projects/-Users-chouhua-Downloads-Github-metasheet2/reviews/todo-center-design-lock-draft-20260915.md
(no output, exit 1)
```
锁文全文没有「锁序」字样,不像撤销线(C)的锁文那样定义锁序表——本切片不套用 C 线的四对锁序 census。

```
$ grep -inE "BEGIN|COMMIT|ROLLBACK|transaction|FOR UPDATE|pg_advisory|advisory" \
    packages/core-backend/src/services/approval-pending-query.ts \
    packages/core-backend/src/services/approval-pending-source.ts \
    packages/core-backend/src/services/pending-source-registry.ts \
    packages/core-backend/src/routes/todo.ts
(no output, exit 1)
```
三个新模块 + 新路由文件里没有任何事务边界或锁获取语句——`countApprovalPendingForViewer` /
`listApprovalPendingRowsForViewer` 各自是单条 `pool.query(...)`(`services/approval-pending-query.ts:
134-142`,`:194-231`),`PendingSourceRegistry` 的两个聚合方法只是顺序 `await` 各源、无共享可变状态跨
请求(`services/pending-source-registry.ts:74-108`)。本切片是纯读投影,不持有、不等待任何数据库锁,
也不参与任何应用层互斥。

## 5. 与既有代码的接缝(file:line)

**锚点最后一次机械核对(门审 P3-3 修复,2026-09-18):** 下表七个 file:line 锚点最初写于工作树
`HEAD=63fc3d699550e5d39cb95536c7e99d99314d4346`,此后分支又前进了若干轮修复提交,钉死单个数字会
在下一次提交时立刻过期(正是门审 P3-3 指出的问题)。改为可自证的形式:锚点所在的四个源文件
(`routes/approvals.ts`、`src/index.ts`、`services/approval-realtime.ts`、`vitest.config.ts`)
自 `63fc3d699` 起在本分支上字节未变,核对命令与结果如下——**任何编辑此表的人,先跑同一条命令确认
仍为空 diff 再改数字,空 diff 就不用改**:

```
$ git diff --stat 63fc3d699 HEAD -- packages/core-backend/src/routes/approvals.ts \
    packages/core-backend/src/index.ts \
    packages/core-backend/src/services/approval-realtime.ts \
    packages/core-backend/vitest.config.ts
(空,exit 0 diff --stat 无输出)
```
（本次核对时 `HEAD=d2009f9b47f0008ae0ea5ffc18a28f1bd475ef9b`;`63fc3d699..HEAD` 之间的六条提交
只碰了两个 workflow 文件、一个 docblock 注释块和两份验证/设计 MD,均不在上面四个文件之列。）

| 接缝 | 位置 |
|---|---|
| 共享查询导入进审批路由 | `packages/core-backend/src/routes/approvals.ts:49`(`import { countApprovalPendingForViewer } from '../services/approval-pending-query'`) |
| `resolveApprovalActorId` 导出(供 `routes/todo.ts` 复用,不是新写一份身份解析) | `packages/core-backend/src/routes/approvals.ts:267` |
| `resolveApprovalActorPermissions` 导出(同上) | `packages/core-backend/src/routes/approvals.ts:282` |
| `/pending-count` 改接调用点 | `packages/core-backend/src/routes/approvals.ts:2027-2034` |
| 服务器启动时注册审批源 + 挂载 `todoRouter` | `packages/core-backend/src/index.ts:242-244`(import)、`:1799-1800`(`pendingSourceRegistry.register(approvalPendingSource); this.app.use(todoRouter())`) |
| 实时广播追加 `todo:counts-updated` | `packages/core-backend/src/services/approval-realtime.ts:118,124` |
| 默认 no-DB vitest 配置排除本切片的独立 project 文件(双重保险,见 §7) | `packages/core-backend/vitest.config.ts:87-94` |

## 6. 留给后续切片的项

1. **B-2(前端)**:待办中心页、徽标改读 `todo/count`、判据 B 徽标层半边(stub 今天
   `ApprovalTodoBadge.vue:82-86` 的 `applyCount(0)` catch 分支)、判据 E 代数守卫、`todo:
   counts-updated` 的前端订阅——本文档 §1.2 已逐条列出对应锁文依据。
2. **`routes/todo.ts` 的权限门槛**:第二个源注册前必须从 `rbacGuard('approvals','read')` 改为按源判
   权限或 `rbacGuardAny`(文件自身文档已提示,见 §3.1)。
3. **角色来源 (b)**:锁 §7-2′ 的独立裁决,须与决策门同步加宽一起裁,不由本切片单方面推进。
4. **`source_queue` 席位去留**:锁 §7-2″ 建议首期计入 + `actionable=false`,长期去留交审批引擎线。
5. **AuthService 层静默收窄**(`isRbacAdmin`/`listUserPermissions` 抛错吞 `logger.warn`):锁
   §7-6 登记为平台授权线独立发现,不是本切片的验收前提。
6. **评论源(v1.1)/云课堂「待处理」定义/任务源**:锁 §4「不做」段,分别等 owner 裁决(§7-3/§7-4)
   与任务线落地(§7-5)。
7. **`approval-realtime.ts` 的第二份 pending 谓词(P1-1,门审 `impl-gate-B-slice1-round1-20260918.md`
   点名,锁 §3 硬约束「只准一份」)**:`services/approval-realtime.ts` 的 `computeApprovalPendingCounts`
   是审批域一份**独立于本切片提取的共享查询**的手抄三臂谓词,**缺办理节点排除**——本切片新增的
   `todo:counts-updated` 广播(commit `6fba6e01e`)复用的正是这份分叉 payload,把先存分叉扩张到了待办
   中心自己的事件表面。**同库实测**(`metasheet2_lock_b`,事务内 seed 一个 class ⑧ 形状后 `ROLLBACK`,
   同一 viewer/instance,两条查询并排跑):REST 共享查询(4 条件,含排除)⇒ `count=0`;
   `computeApprovalPendingCounts`(3 条件,无排除)⇒ `count=1`。按已 ratify 的 §1.5 ①(RATIFY 记录
   §7-2「基准口径 = §1.5 的 ①」)基准,**实时推送这条路是 known-wrong**,不是"两条路各说各话、择一即可"。
   **未在本切片折入**(折入会改变持办理节点席位者收到的实时推送数字,是公开合同变更,需 owner 一句 ——
   门审报告三选一里的 (a) 项;本切片未获该授权,故不做行为改动)。**处置(按门审报告 (b) 项如实登记,
   不代 owner 裁定 (a)/(c))**:`services/approval-pending-query.ts` 的
   `approvalPendingAssigneeMatchCondition` docblock 已加"KNOWN EXCEPTION"段指名这份分叉(不内嵌其
   SQL 片段,避免撞判据 C 的 drift-string mutation 探针);验证 MD 的判据 D 证据范围收窄为
   "仅 REST 路径"(锁 §5 行 D 字面范围更宽,差额 = 实时推送路径,登记为未验 + known-wrong)。
   **(a) 折入 / (c) BLOCKED 两项终裁仍待 owner**,本条目不构成该终裁。B-2 的既定内容含"徽标改读
   `todo/count`"与"`todo:counts-updated` 的前端订阅"(本节第 1 条)——落地前必须先看到 (a)/(b)/(c) 的
   owner 终裁,否则徽标会消费这份 known-wrong 的数字。

## 7. owner 待裁项(锁文 §7/§9 已 ratify 的裁决——原样引用抬头 RATIFY 记录,不改写)

> **RATIFY 记录(2026-09-18,原文摘录)**
> - **授权来源(owner 亲写,本会话消息原文)**:「按 你建议执行1」——指向前一条消息的建议 1:「ratify
>   三把锁:分组锁 v2.13、待办中心锁 v2.14、撤销锁 v5.9;待裁项按锁文里标的建议值」。owner 未点名的
>   项(合并 PR、#5805 收口、#5698 处置)**不在本授权内**。
> - **ratify 当刻 head**:`origin/main @ 00781e68b`(2026-09-18);**验证基线** `85ddd2926`(第
>   4–13 轮门审全部在此 head 上核实),两 head 之间相差 228 提交(timemachine/recovery 合并列车)。
> - **裁决结果(按建议值)**:§7-2 基准口径 = §1.5 的 ①(活动席位)= **确认**;§7-2′ 角色来源首期 =
>   **(a)**(与决策门同源),(b) 加宽须与门同步加宽、另立票;§7-2″ `source_queue` 席位首期**计入 +
>   `actionable=false`**;§7-3 评论收件箱 v1.1 再议;§7-4 云课堂「待处理」交该域;§7-5 任务线接口以
>   §3 为准;§7-6 AuthService 静默收窄登记为平台授权线独立发现,不作本锁前置。
> - **不变的约束**:含 DDL 的切片只能以 Draft PR 交付、**不应用、不合并**;任何合并仍需 owner 逐 PR
>   一句话;实现按分期走「Sonnet 实现 → Opus 门审 → 修复重跑闸 → Draft PR」。

**「含 DDL」条款对本切片不适用**:本切片零 DDL、零迁移改动(§4/§7 判据 F 已用 `git diff --quiet`
证实),抬头「不变的约束」里「含 DDL 的切片只能以 Draft PR 交付、不应用、不合并」这句对 B-1 不触发——
不在 PR body 里贴一句与事实不符的「含 DDL」免责声明。

以下 owner 待裁项**仍未裁**,原样列出(不是本切片的验收前提,只是完整摘录锁文 §7 供门审核对):
- §7-3:v1.1 是否直接把评论收件箱作为第二源;
- §7-4:云课堂「待处理」的定义交该域;
- §7-5:任务线的来源接口以 §3 为准(§3.0 的提取属审批线工作,不进任务线);
- §7-6:AuthService 层静默收窄是否修,由平台授权线裁。

## 8. 绝对断言自扫(本文档)

| 断言 | 命令 | 结果 |
|---|---|---|
| 锁文无「锁序」字样 | `grep -n "锁序" <锁文路径>` | exit 1,无输出 |
| 三个新模块 + 路由文件零事务/锁关键字 | `grep -inE "BEGIN\|COMMIT\|ROLLBACK\|transaction\|FOR UPDATE\|pg_advisory\|advisory" <四个文件>` | exit 1,无输出 |
| 判据 F:两个迁移根零变化(merge-base 三点 diff) | `git diff --quiet origin/main...HEAD -- packages/core-backend/migrations packages/core-backend/src/db/migrations` | exit 0 |
| `/pending-count` 的白名单校验仍在路由层,未挪进共享查询 | `grep -n "APPROVAL_SOURCE_SYSTEM_INVALID" packages/core-backend/src/routes/approvals.ts` | 命中 `:1249`/`:2015`/`:2139`(pending-count 用 `:2011-2022`) |
| 本切片新增/改动的四个模块内均无该码(白名单确实没有被复制进共享查询层) | `grep -c "APPROVAL_SOURCE_SYSTEM_INVALID" packages/core-backend/src/services/approval-pending-query.ts packages/core-backend/src/services/approval-pending-source.ts packages/core-backend/src/services/pending-source-registry.ts packages/core-backend/src/routes/todo.ts` | 四个文件均为 `0`,`grep -c` 对零匹配的文件各自 exit 1 |
