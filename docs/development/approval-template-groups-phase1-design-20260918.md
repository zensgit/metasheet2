# 审批表单分组 Phase 1(切片 A-1 后端)— 设计 MD

- 锁文(唯一 ratify 对象):`approval-form-group-entity-design-lock-draft-20260916.md`,**v2.13 RATIFIED 2026-09-18**
- 目标文档:`goal-three-locks-full-implementation-20260918.md`(切片 `A-1 后端`)
- 补充清单:`impl-supplementary-gate-checklist-20260918.md` #1–#7(#1–#4 三线共用,#5–#7 lane A 专属)
- 本文档所在分支:`feat/approval-template-groups-phase1`
- 本文档写作时 worktree HEAD:`21c3b0512d7dd0af386d1dfefc7d8d131004b453`
- `origin/main`:`89f1ecdee2c3b70205a318074824c834bc6a5c7e`(与本分支的 merge-base **相同**——本分支是 `origin/main` 的直接后代,无 rebase 漂移)
- 下文所有 `file:line` 都是**对本 HEAD 现场 `grep -n` 的结果**,不是照抄锁文基线 `85ddd2926` 的行号(锁文行号仅在直接引用锁文条款时保留,并注明「锁文行号」)。

## 0. RATIFY 记录(原样引用锁文抬头,不改写)

> **RATIFY 记录(2026-09-18)**
> - **授权来源(owner 亲写,本会话消息原文)**:「按 你建议执行1」——指向我前一条消息的建议 1:「ratify 三把锁:分组锁 v2.13、待办中心锁 v2.14、撤销锁 v5.9;待裁项按锁文里标的建议值」。owner 未点名的项(合并 PR、#5805 收口、#5698 处置)**不在本授权内**。
> - **ratify 当刻 head**:`origin/main @ 00781e68b`(2026-09-18);**验证基线** `85ddd2926`(第 4–13 轮门审全部在此 head 上核实),两 head 之间相差 228 提交(timemachine/recovery 合并列车)。
> - **裁决结果(按建议值)**:Q3 分组按 org 作用域,`org_id` 只取 `req.authenticatedTenantId` = **是**;Q4 归档不保留成员、解档得空组 = **是**;Q5 `?category=` 与 `/categories` 首期不动、分期 3 再裁;分期 2(按现有 category 建组并挂接)= **要**,做成预览→执行→可回滚的管理员操作;`key` 全局唯一 = **另立锁**,不顺带。§7 第 2 项(§2 两表形状 + 锁序表 + I1–I8)按 v2.13 ratify。
> - **不变的约束**:含 DDL 的切片只能以 Draft PR 交付、**不应用、不合并**;任何合并仍需 owner 逐 PR 一句话;实现按分期走「Sonnet 实现 → Opus 门审 → 修复重跑闸 → Draft PR」。

本切片(A-1)是锁文 §6 分期表「期 1」的**后端**部分。前端部分(session-org 选择入口的共享组件)按目标文档的切片清单已拆给 **A-2**(见 §1.3)。

## 1. 范围 / 不在范围

### 1.1 本切片(A-1)包含 —— 逐条对锁文 §

| 内容 | 锁文出处 |
|---|---|
| 两张表 DDL(`approval_template_groups` / `approval_template_group_links`)含全部约束 | §2(全节) |
| 列表端点(只读,不取 L0) | §2 锁序表「只读路径不取 L0」 |
| 建组端点(L0) | §2「序号分配」+ 锁序表「建组 L0」 |
| 改名端点(L0→L1) | §2 锁序表「改名 L0→L1」;v2.5 P1(RACE-C/RACE-D) |
| 归档端点(事务:L0→L1→L2,批量解除关联) | I2;锁序表「归档 L0→L1→L2(批量)」 |
| 解档端点(L0→L1) | I8;锁序表「解档 L0→L1」 |
| 挂接端点(原子 upsert,L1→L2,不取 L0) | §2「挂接是同一条原子 upsert」;锁序表「挂接 L1→L2」 |
| 挂接时按原谓词校验模板可见(不可见 ⇒ 404 `APPROVAL_TEMPLATE_NOT_FOUND`,零行写入;见 §3.5) | §2「模板可见性仍走原权限谓词……挂接时按原谓词校验可见」(ratified) |
| 解除关联端点(独立 UPDATE,L2 only) | §2「解除关联…是一条独立 UPDATE」;锁序表「解除 L2」 |
| org 来源钉死 `req.authenticatedTenantId`(A‴) | §2「org 从哪来」 |
| 授权面(I7):写端点 `approvalTemplateAdminGuard`,读端点 `rbacGuard('approvals:read')` | I7 |
| I6 爆炸半径为零(自动化面两文件字节不变) | I6 |
| 多 org 成员 403 `SESSION_ORG_REQUIRED`(**后端行为**,J 的一部分) | §2「多 org 成员」;验收 J |
| 两个新 `.db.test.ts` + 两点接线(`vitest.config.ts` exclude + `plugin-tests.yml` 显式清单)+ s6a 重钉 | §6「期 1」门 |

### 1.2 本切片明确不做(逐条引用锁文 § 与分期)

| 项 | 锁文出处 | 去处 |
|---|---|---|
| 中心页 `section=` 分节 + 节内分页 + 拖拽归组 + 重排端点(验收 E 后半)+ 两个写入面换分组选择器(I4 生效)+ `?category=`/`section` 互斥的 400 | §6「期 3」;验收 C、D、E 后半 | A-4(分期 3) |
| 管理员「按现有 category 建组并挂接」预览→执行→可回滚 | §6「期 2」 | A-3(分期 2) |
| 共享 `SessionOrgSwitcher.vue`(复制泛化 `AttendanceSessionOrgSwitcher.vue`,考勤原文件不动)+ `useSessionOrg` 前端接线 + 403 后前端展示选择器 + `run-required-web-tests.sh` 令牌 | §2「多 org 成员」;验收 J 前端半 | A-2(目标文档切片清单;锁文 §6 把 J 整行记在「期 1」门下,目标文档把前端半独立拆给 A-2 —— 两处出处并列写明,以目标文档的切片拆分为准,详见 §6) |
| 硬删分组端点 | §5「明确不做」 | 不排期(首期无端点;DB 层归档后可删属已知残留) |
| 多级分组 / 按分组授权 / 跨组织共享分组 / 分组按 category 自动回填 / `approval_templates.key` 全局唯一范围 | §5「明确不做」 | 不排期 / 另立锁(Q6) |

### 1.3 切片拆分口径的双重出处(供门审核对)

锁文 §6「期 1」门原文列出的验收范围是「A~B″/E 前半/F/G/H/I/I′/J/K」——**J 整行**在锁文里记在期 1 门下。但 J 本身是一个复合判据(见 §3 验收表 J 行拆解):后端 403 `SESSION_ORG_REQUIRED` 是本切片新增端点自身必然产生的行为(不需要额外代码,`resolveApprovalTemplateGroupOrgId` 本就 fail-closed);前端选择器与 `run-required-web-tests.sh` 令牌需要一个新组件文件。目标文档(`goal-three-locks-full-implementation-20260918.md` 切片清单)把后者独立列为 **A-2**,已由主会话(Fable)在实现前拍板(见 `impl-supplementary-gate-checklist-20260918.md` #6:「分期门『1 落地』的求值……已请示 owner 定义为『Draft PR 过门审』」同一批次的切片拆分决策)。本设计 MD 按此口径把 J 拆成「本切片验证的后端半」与「A-2 验证的前端半」,不在 A-1 名下虚报整条 J 已完成。

## 2. 数据模型与约束(每条对锁文 §2 逐行)

DDL 文件:`packages/core-backend/src/db/migrations/zzzz20260918090000_create_approval_template_groups.ts`(**含 DDL,本 PR 只能 Draft,不应用不合并**)。

### 2.1 `approval_template_groups`

| 约束/列 | 迁移文件行 | 锁文 §2 出处 |
|---|---|---|
| `id text PRIMARY KEY`,`'atg_' + randomUUID()` 由服务层生成 | `:38`(DDL);`ApprovalTemplateGroupService.ts:120-122` `newGroupId()` | §2「`approval_template_groups(id text PK 'atg_…' …)`」 |
| `org_id text NOT NULL CONSTRAINT atg_org_nonblank CHECK (org_id ~ '[!-~]')` | `:39-40` | §2 约束清单「`atg_org_nonblank`」 |
| `name text NOT NULL CONSTRAINT atg_name_nonblank CHECK (name ~ '[!-~]')` | `:41-42` | §2 约束清单「`atg_name_nonblank`」 |
| `sort_order int`(可空) | `:45` | §2「序号可空 + 与 archived_at 配对 CHECK」 |
| `CONSTRAINT atg_org_id_uni UNIQUE (org_id, id)`(复合 FK 被引用侧) | `:52` | §2「`atg_org_id_uni`……否则 42830」 |
| `CONSTRAINT atg_sort_unique UNIQUE (org_id, sort_order) DEFERRABLE INITIALLY DEFERRED` | `:58` | §2「`atg_sort_unique`……DEFERRABLE 的三条副作用」 |
| `CONSTRAINT atg_sort_archived_pair CHECK ((archived_at IS NULL) = (sort_order IS NOT NULL))` | `:62` | §2「`atg_sort_archived_pair`」 |
| `CREATE UNIQUE INDEX uq_atg_org_name_active ON … WHERE archived_at IS NULL`(部分唯一,只能是索引) | `:71-75` | §2「部分唯一只能是索引……」 |
| **不另建** `idx_atg_org_sort`(`atg_sort_unique` 隐式索引已覆盖) | 迁移中确实无此索引(`:37-64` 只有上述三个约束 + 一个部分索引) | §2「不另建 idx_atg_org_sort」 |
| `down()` 镜像(先删 links 表,再删索引,再删 groups 表) | `:109-113` | §2「`down()` 镜像」 |

### 2.2 `approval_template_group_links`

| 约束/列 | 迁移文件行 | 锁文 §2 出处 |
|---|---|---|
| `org_id text NOT NULL CONSTRAINT atgl_org_nonblank CHECK (org_id ~ '[!-~]')` | `:79-80` | §2「关联表约束清单」 |
| `template_id uuid NOT NULL REFERENCES approval_templates(id) ON DELETE CASCADE` | `:81-82` | §2「`FOREIGN KEY (template_id) … ON DELETE CASCADE`」 |
| `group_id text`(**可空**,与 I2′ 一致) | `:87` | §2「`group_id` 可空」 |
| `PRIMARY KEY (org_id, template_id)` | `:91` | §2「`PRIMARY KEY (org_id, template_id)`」 |
| `CONSTRAINT atgl_group_fk FOREIGN KEY (org_id, group_id) REFERENCES approval_template_groups (org_id, id) ON DELETE NO ACTION ON UPDATE NO ACTION` | `:98-100` | §2「**不得**改成 `SET NULL`/`CASCADE`」 |
| `CONSTRAINT atgl_state_check CHECK ((group_id IS NULL) = (unlinked_at IS NOT NULL))` | `:104` | §2「三种状态……`CHECK`」 |

### 2.3 现场核对(不是照抄迁移文件,是对 `metasheet2_lock_a` 里已应用的真实 schema 核对)

见验证 MD §1——`\d approval_template_groups` / `\d approval_template_group_links` 的现场输出与上表逐条比对,索引名、约束名、DEFERRABLE 标记、复合 FK 全部字节一致。

## 3. 接口与错误码(全部专用码;标注 ratified vs 实现者新增)

### 3.1 七个端点(`packages/core-backend/src/routes/approvals.ts`,当前 HEAD 行号)

| 方法 + 路径 | 行 | Guard | 服务函数 |
|---|---|---|---|
| `GET /api/approval-template-groups` | `:1091` | `rbacGuard('approvals:read')` | `listApprovalTemplateGroups` |
| `POST /api/approval-template-groups` | `:1102` | `approvalTemplateAdminGuard` | `createApprovalTemplateGroup` |
| `PATCH /api/approval-template-groups/:id` | `:1118` | `approvalTemplateAdminGuard` | `renameApprovalTemplateGroup` |
| `POST /api/approval-template-groups/:id/archive` | `:1130` | `approvalTemplateAdminGuard` | `archiveApprovalTemplateGroup` |
| `POST /api/approval-template-groups/:id/unarchive` | `:1141` | `approvalTemplateAdminGuard` | `unarchiveApprovalTemplateGroup` |
| `POST /api/approval-templates/:id/group` | `:1153` | `approvalTemplateAdminGuard` | `linkApprovalTemplateToGroup` |
| `DELETE /api/approval-templates/:id/group` | `:1174` | `approvalTemplateAdminGuard` | `unlinkApprovalTemplateFromGroup` |

`approvalTemplateAdminGuard`(`routes/approvals.ts:198`)= `rbacGuardAny(['approval-templates:manage', 'approvals:admin-templates'])`,与模板写端点(`:863` 等)同一常量,非本切片新建。所有七个端点先 `authenticate` 中间件,再各自的 guard,再 handler 内部第一行调用 `resolveApprovalTemplateGroupOrgId`(`routes/approvals.ts:351`)。

### 3.2 org 来源解析(A‴)

`resolveApprovalTemplateGroupOrgId(req, res)`(`routes/approvals.ts:351-369`):
1. `isOrgIdValuePresent`(`:344-349`)检测 body/query 的 `orgId`——**任何形态**(字符串、数组、其他类型)只要非空/非全空数组即算「出现」,不仅是 `typeof === 'string'`(注释 `:337-343` 解释了为何要挡 `?orgId=a&orgId=b` 这类数组穿透);命中 ⇒ 400 `ORG_ID_NOT_ACCEPTED`(`:355-358`),直接 `return undefined`,handler 不再往下走。
2. 否则读 `req.authenticatedTenantId`(`:361`;`jwt-middleware.ts:101-104`,只从已验签 token 的 `tenantId` 铸造);为空/非字符串 ⇒ 403 `SESSION_ORG_REQUIRED`(`:362-366`)。
3. 否则返回 trim 后的值(`:368`)。

`jwt-middleware.ts:101-104` 现场核对:`authenticatedTenantId` **只**在 `user.tenantId` 是非空字符串时被设置到 `req.authenticatedTenantId`(`:101-104`);紧接着的 `:106-109`(`extractTenantFromHeaders` 回填)只在 `!user.tenantId` 时把请求头值写回 **`user.tenantId`**,从不触碰 `req.authenticatedTenantId`——这正是 A‴(ii)「有效 token + 伪造头 ⇒ 头被忽略」成立的机制证据,不是靠约定。

### 3.3 错误码全表

**锁文 §2 ratified 的七个专用码**(`ApprovalTemplateGroupService.ts:23-32` 文件头逐字列出):

| 码 | HTTP | 触发点(file:line) | 锁文出处 |
|---|---|---|---|
| `GROUP_NOT_FOUND` | 404 | rename `:220`、archive `:251`、unarchive `:304`、link `:362`(经各自函数直接抛出,link 的经 `mapGroupConstraintError` 透传) | §2「行锁 SELECT……0 行 ⇒ 404」 |
| `GROUP_ARCHIVED` | 409 | archive(重复归档,实现者选择复用同码,见 §3.4)`:254`、link `:365` | §2「archived_at IS NOT NULL ⇒ 409」 |
| `GROUP_NAME_TAKEN` | 409 | 建组/改名/解档撞 `uq_atg_org_name_active`(`mapGroupConstraintError:137-138`,由 `:199-201`/`:230-232`/`:333-335` 的 catch 触发)、解档显式复核(`:311-316`) | §2/I8「409 GROUP_NAME_TAKEN」 |
| `GROUP_NOT_ARCHIVED` | 409 | unarchive `:308` | I8「否则 409 GROUP_NOT_ARCHIVED」 |
| `GROUP_SORT_CONFLICT` | 500 | 建组/解档撞 `atg_sort_unique`(COMMIT 时,`mapGroupConstraintError:140-141`) | §2 DEFERRABLE 副作用③;验收 E |
| `ORG_ID_NOT_ACCEPTED` | 400 | `resolveApprovalTemplateGroupOrgId` `:355-358`(`routes/approvals.ts`) | §2「org 从哪来」 |
| `SESSION_ORG_REQUIRED` | 403 | `resolveApprovalTemplateGroupOrgId` `:362-366` | §2「多 org 成员」;验收 J |

**实现者新增的请求形状校验码**(锁文未点名,不算第八个 ratified 结果——`ApprovalTemplateGroupService.ts:26-32` 文件头自述这一区分):

| 码 | HTTP | 触发点 | 性质 |
|---|---|---|---|
| `GROUP_NAME_REQUIRED` | 400 | `requireName`(`ApprovalTemplateGroupService.ts:155-161`,抛出于 `:158`),建组/改名 name 为空/纯空白 | 输入形状校验,与本路由已有的 `APPROVAL_GROUP_ID_REQUIRED`/`APPROVAL_ACTOR_REQUIRED` 同级 |
| `APPROVAL_GROUP_ID_REQUIRED` | 400 | link 端点 `routes/approvals.ts:1161-1164`,`groupId` 缺失/空白 | 同上 |
| `APPROVAL_ACTOR_REQUIRED` | 401 | 建组 `:1106-1109`、link `:1157-1160`,`resolveApprovalActorId` 返回 null | 沿用本路由既有惯例 |

**七个 `handleApprovalsError` 兜底码**(数据库故障/未预期异常时的 500 fallback,不是业务语义码,而是「这条请求处理失败」的通用标签,7 个端点各一个、名字含端点动作):

`APPROVAL_TEMPLATE_GROUP_LIST_FAILED`(`:1098`)、`_CREATE_FAILED`(`:1114`)、`_RENAME_FAILED`(`:1126`)、`_ARCHIVE_FAILED`(`:1137`)、`_UNARCHIVE_FAILED`(`:1148`)、`_LINK_FAILED`(`:1168`)、`_UNLINK_FAILED`(`:1181`)。这七个只在 `ServiceError` 之外的异常(如连接失败)时出现——正常路径下的所有已知失败都会先命中上表的专用码。

### 3.4 一处实现者裁量(未获锁文文本背书,写明供门审核实)

`unarchiveApprovalTemplateGroup`(`ApprovalTemplateGroupService.ts:294-336`)对「归档一个已经归档的组」没有单独处理——它走的是「找不到该 id 的活跃组行」还是复用 `GROUP_ARCHIVED`?现场读代码:`archiveApprovalTemplateGroup`(`:241-278`)在锁到组行后检查 `archived_at !== null` ⇒ 抛 `GROUP_ARCHIVED`(`:253-255`,409)。锁文 §2/I2 只定义了「归档一个活跃组」的路径,未定义「归档一个已归档组」应返回什么;`ApprovalTemplateGroupService.ts:34-38` 的文件头注释自陈这是实现者选择复用链接态判到的同名码,而非新码,且验收表没有任何一行练到这个分支。属于**未获锁文文本背书的实现决定**,不是缺陷,列入门审核对项。

### 3.5 另一处实现者裁量(修复轮补齐,gate P2-1)——挂接可见性的失败形状

锁文 §2 原文「模板可见性仍走原权限谓词……一个组织只能给自己**能看到**的模板归组(挂接时按原谓词校验可见)」只 ratify 了**要校验**这件事,没有点名校验失败时的 HTTP 状态码或错误码——这两点是实现者选择,写明供门审核实:

- **落点**:`routes/approvals.ts`(新增导出函数 `isApprovalTemplateVisibleForGroupLink`,紧邻 `resolveApprovalTemplateVisibilityActor` 之后),不是 `ApprovalTemplateGroupService.ts`——后者的文件头注释(`:5-8`)自陈「never reads `req` and never defaults the org」,这个不变量延伸到「不做可见性判定」:可见性判定需要 actor(依赖 `req.user`),放进这个刻意不碰 `req` 的服务模块会违反它自己的边界,所以校验点选在路由层,链接前置检查,链接本身的服务函数不变。
- **谓词复用,非新逻辑**:直接调用锁文/§1.6(I5/I6)已经点名不得新造的 `applyTemplateVisibilityFilter`(`ApprovalProductService.ts:4383-4419`,与列表/详情端点同一个函数),对 `approval_templates` 的 `id = $1` 加同样的析取条件——**不是**又发明一条独立的可见性判定。
- **失败形状(实现者选择,非 ratified 码)**:不可见 ⇒ 404 `APPROVAL_TEMPLATE_NOT_FOUND`(零行写入,链接服务函数完全不被调用)——复用本路由既有的同名码(`:897`,模板详情端点在 actor 看不到时的同一 404),不是发明第 11 个专用码。选择 404 而非 403 的理由:与仓内其它 actor 门控的模板查找同构——「存在但看不见」与「不存在」对调用方呈现相同响应,不额外暴露「有一个你看不到的模板」这一事实。
- **范围仅限挂接**(锁文原文点名的动作是「挂接」,不含解除关联)——`unlinkApprovalTemplateFromGroup` 未加此校验,解除关联对可见性的语义锁文未定义,不在本条修复范围内。
- **可达性披露(如实,不夸大)**:`approvalTemplateAdminGuard`(`rbacGuardAny(['approval-templates:manage', 'approvals:admin-templates'])`)能通过守卫的每个 actor,`resolveApprovalTemplateVisibilityActor` 都会把它判成 `isTemplateManager = true`(两个 guard 码都在 `isTemplateManager` 的判定并集里),而 `applyTemplateVisibilityFilter` 对 manager 直接短路、不加任何条件——所以今天**没有**任何 HTTP 可达路径能让这条校验因「看不见该模板」而 404;它今天在生产流量下只等价于「模板是否存在」的检查(对不存在的模板 id 同样 404,顺带堵上了 `mapGroupConstraintError` 未映射 `template_id` 上 `atgl_template_fk` 23503 的既有空白——那种情况下之前会 500)。真正的判别力(非 manager actor 命中 dept/role 作用域外的模板)只在直接调用导出的 `isApprovalTemplateVisibleForGroupLink` 时被验证——见验证 MD §2 新增 mutation 台账两条(§2(a) 谓词直调、§2(b) 端点调用点)。

## 4. 事务与锁序

### 4.1 锁序表(锁文 §2 原样)

> L0 = `pg_advisory_xact_lock(hashtext('atg:' || org))`;L1 = `approval_template_groups` 行 `FOR UPDATE`;L2 = `approval_template_group_links` 行(upsert / UPDATE 隐式)。
> 建组 L0;改名 L0→L1;归档 L0→L1→L2(批量);解档 L0→L1;重排 L0→L1(该 org 全部活跃行,**分期 3**);挂接 L1→L2;解除 L2。
> 七条路径没有任何一条先 L1/L2 再 L0,也没有路径先 L2 再 L1 ⇒ 无环。

### 4.2 本切片实际取锁点(file:line,`ApprovalTemplateGroupService.ts`,当前 HEAD)

| 路径 | 语句顺序 | 行号 |
|---|---|---|
| 建组(L0) | `transaction(...)`(`:182`)→ `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` → `SELECT pg_advisory_xact_lock(hashtext($1))` → `SELECT COALESCE(MAX...)` → `INSERT` | `:175-202`(SET `:183`、L0 `:184`、MAX `:185-188`、INSERT `:191-196`) |
| 改名(L0→L1) | `transaction(...)`(`:212`)→ SET → L0 → `SELECT … FOR UPDATE`(L1)→ `UPDATE name` | `:205-233`(SET `:213`、L0 `:214`、L1 `:215-218`、`GROUP_NOT_FOUND` `:220`、UPDATE `:222-227`) |
| 归档(L0→L1→L2 批量) | `transaction(...)`(`:243`)→ SET → L0 → `SELECT … FOR UPDATE`(L1)→ `archived_at` 复核 → `UPDATE …_links SET group_id=NULL`(L2,批量,无显式行锁,靠 L1 已持有的组行序列化并发挂接)→ `UPDATE archived_at/sort_order` | `:241-278`(SET `:244`、L0 `:245`、L1 `:246-249`、`GROUP_NOT_FOUND` `:251`、`GROUP_ARCHIVED` `:253-255`、L2 批量 UPDATE `:262-265`、archive UPDATE `:267-272`) |
| 解档(L0→L1) | `transaction(...)`(`:296`)→ SET → L0 → `SELECT … FOR UPDATE`(L1)→ `archived_at`/同名复核 → `SELECT MAX+1` → `UPDATE` | `:294-336`(SET `:297`、L0 `:298`、L1 `:299-302`、`GROUP_NOT_FOUND` `:304`、`GROUP_NOT_ARCHIVED` `:307-309`、同名复核 `:311-317`、MAX `:319-322`、UPDATE `:325-330`) |
| 挂接(L1→L2,**无 L0**) | `transaction(...)`(`:356`)→ `SELECT archived_at … FOR UPDATE`(L1)→ `INSERT … ON CONFLICT DO UPDATE`(L2) | `:349-384`(L1 `:357-360`、`GROUP_NOT_FOUND` `:362`、`GROUP_ARCHIVED` `:364-366`、upsert `:368-378`) —— **不取 L0**:此路径既不写 `name` 也不分配 `sort_order`,与锁序表不变量一致(§2「只读路径不取 L0」的姊妹条款——挂接虽是写,但写的是 links 表,不是 groups 表的 name/sort_order,故豁免 L0) |
| 解除(L2 only) | 单条 `UPDATE … WHERE … AND group_id IS NOT NULL`(主键行锁隐式,无显式 `FOR UPDATE`、无 L0、无 `transaction(...)` 包裹——单条 `query()`) | `:391-400`(UPDATE `:395-398`) |
| **重排(L0→L1,分期 3)** | 本切片不实现 | 不适用 |

### 4.3 无环性对本切片的六条路径复核

建组(L0 单跳)、改名(L0→L1)、归档(L0→L1→L2)、解档(L0→L1)、挂接(L1→L2)、解除(L2 单跳)—— 六条路径里,取两把及以上锁的四条(改名/归档/解档/挂接)全部严格递增(L0<L1<L2 的顺序,挂接从 L1 起步不违反此序),没有一条反向获取,与锁文「七条路径没有任何一条先 L1/L2 再 L0」的断言一致(第七条「重排」不在本切片)。

### 4.4 `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` 位置

四条 L0 路径(建组/改名/归档/解档)的 `SET` 语句都是各自 `transaction(...)` 回调里的**第一条**语句,先于 `pg_advisory_xact_lock` 调用——与锁文「`BEGIN` 之后第一条语句」的要求逐条核对一致(见 §4.2 行号列;验证 MD 用 `grep -A1` 现场核对语句顺序,而非仅确认字符串存在)。

## 5. 与既有代码的接缝(file:line,以工作树真实代码为准)

| 接缝 | file:line | 说明 |
|---|---|---|
| 挂载点 | `packages/core-backend/src/index.ts:1791` `this.app.use(approvalsRouter({...}))` | I7「全部新端点落在 `routes/approvals.ts`,经 `app.use` 挂载,不走插件 `http.addRoute`」——验收 E 的「无响应/超时」mutation 形态以此为前提 |
| org 铸造 | `packages/core-backend/src/auth/jwt-middleware.ts:101-103` | `authenticatedTenantId` 唯一写入点(§3.2 已核对) |
| 多 org 脱困入口(后端) | `packages/core-backend/src/auth/AuthService.ts:387`(`resolveSessionTenantId` 起始行,与锁文引用一致) | J 的机制来源;前端接线属 A-2 |
| `approvalTemplateAdminGuard` 复用 | `routes/approvals.ts:198`(定义)、`:863` 等既有模板写端点共用同一常量 | I7 |
| `rbacGuard('approvals:read')` 复用 | 既有读端点 `routes/approvals.ts:549`(`GET /api/approval-templates`)同一 guard 工厂——本切片源码注释 `:1087` 写的「`:531`」是该注释自身相对旧行号基线的漂移,现场行号以 `:549` 为准 | I7 |
| `ServiceError` / `sendServiceError` 复用 | `ApprovalBridgeService.ts:1559`(类定义)、`routes/approvals.ts:422`(`sendServiceError`)、`:485`(`handleApprovalsError`) | 专用码经既有错误管道输出,未新建平行错误体系 |
| I6 零改动的两文件 | `packages/core-backend/src/multitable/automation-service.ts`、`packages/core-backend/src/multitable/automation-approval-template-access.ts` | 验收 I(本地 diff 取证,见验证 MD) |
| I′(b) 三个 actor 构造器现场行号 | `routes/approvals.ts:374`(`resolveApprovalTemplateVisibilityActor`,锁文基线写 `:314-330`,现场已核对函数仍在、行号因中间提交平移到 `:374` 起)、`approval-record-link-txn-auth.ts:588`(与锁文引用行号**一致**)、`automation-approval-template-access.ts:91`(构造字面量起始行,锁文基线写 `:91-102`) | 三处均未被本切片触碰,I′(b) 断言其 `Object.keys` 集合运行时不变 |
| `ApprovalTemplateVisibilityActor` 接口 + manager 短路 | `ApprovalProductService.ts:237-242`(接口字段)、`:4389`(`applyTemplateVisibilityFilter` 的 `isTemplateManager` 短路) | 与锁文引用行号一致;I′(a) 夹具设计围绕这条短路展开 |

## 6. 留给后续切片的项

| 项 | 去处 |
|---|---|
| session-org 前端选择器组件、`useSessionOrg` 接线、`run-required-web-tests.sh` 令牌、J 的前端半验收 | A-2 |
| J 行「未知 `section=` 令牌 ⇒ 400」 | 补充清单 #5:锁文勘误请示 owner,挪到 A-4(分期 3)门,`section=` 到分期 3 才存在 |
| C 行「`?category=` 与 `section` 同现 ⇒ 400」 | 同上,挪到 A-4 |
| 验收 C(中心页分节 `section=`)、D(category 后备显示/筛选)、E 后半(重排端点 + 并发重排终态) | A-4(分期 3),见 §1.2 |
| 管理员「按现有 category 建组并挂接」预览→执行→可回滚 | A-3(分期 2) |
| 补充清单 #1 的闭世界缺口(`scripts/ops/approval-template-groups-ci-wiring.test.mjs` 新守卫文件) | 未排期,留给后续单元或 owner 裁决是否现在做(见验证 MD) |
| §3.4 提到的「重复归档复用 `GROUP_ARCHIVED`」裁量 | 门审核对项,若 owner/门审要求新码或不同状态码,需改动服务层一行 + 补一条验收 |

## 7. Owner 待裁项(锁文 §7/§9;已 ratify 的裁决原样引用抬头 RATIFY 记录,不改写)

锁文 §7 原文:

> 1. **Q3:分组是否 org 作用域**(建议是;`org_id` **只**取 `req.authenticatedTenantId`;可见性不受分组影响);
> 2. (**已 ratify**,见抬头记录)v2.13 的 §2 两表形状(组织级关联 + 复合外键 + 序号约束)、锁序表与 §3 不变量 I1–I8(尤其 I2 事务归档、I2′ 解除关联后不回落 category、I6 不进共享 actor);
> 2′. **Q4:归档是否保留成员**(建议不保留,解档得到空组;若要保留则形状重做);
> 2″. **Q5:分期 3 时 `?category=` 过滤与 `/categories` 端点的去留**(首期不动);
>    **v1 的单列 `group_id` 形状已撤回,不再是选项**;
> 3. 分期 2 是否需要,还是让管理员手工挂接;
> 4. 是否顺带处理 `key` 的全局唯一(建议**不**顺带,另立锁)。

按 §0 抬头 RATIFY 记录:Q3=是、Q4=不保留(建议值)、Q5=首期不动(建议值)、分期 2=要、`key` 顺带=不顺带。**第 2 项(本切片实际实现的形状依据)已 ratify**,本切片按 v2.13 §2/§3 原样实现,未对已 ratify 的形状做任何偏离——偏离仅限于 §3.4 与 §6 列出的、锁文文本本就未覆盖的实现空隙,不是对已裁决条款的改写。

本切片没有新引入需要 owner 裁决的问题;§6「留给后续切片的项」里的两条锁文勘误请示(J/C 的 400 挪分期)已在补充清单 #5 里向 owner 披露,尚待回应,不阻塞本切片的 Draft PR。
