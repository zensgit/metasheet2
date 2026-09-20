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

**候选列口径**:「候选(2026-09-19,待 owner 确认)」一列标记 Erratum 3 CANDIDATE(`lock-errata-proposed-grouping-v2.13-20260919.md` 勘误 3 / 锁文自己的「勘误 3」抬头条目)对该行的影响——PROPOSED,未 ratify,不是「已授权」;门审通过只证明技术验证通过,不构成 ratify、合并或迁移应用的许可。未点名的行按 v2.13 ratify 原样,不受本候选影响。

**勘误 3 候选已进入 REDRAFT v2(2026-09-20)**:第 8 轮门审 P2-1 证伪了第一版候选谓词 `btrim(name) <> ''`(`btrim/2` 默认裁剪集只有 ASCII 空格,全 U+200B 的名字照样 201 入库);owner 同日原话「我之前建议的简单 `btrim(name)` 也不够覆盖纯不可见字符,应以修订后的名称规则验收,不能直接沿用旧建议」。本表下面凡标「勘误 3 候选」的句子,谓词一律以重拟选项 (i) 为准。**第 2 轮修复(2026-09-20,`impl-gate-A-slice1-name-rule-candidate-round1-20260920.md` 之后)**:成员集**逐字未扩**(仍是十个码位),但四个控制/空格成员的**拼写**改成 `chr()`,避免约束定义里出现真实 CR/LF 字节(门审 P3-6):`btrim(name, ' ' || chr(9) || chr(13) || chr(10) || chr(12288) || chr(8203) || chr(8204) || chr(8205) || chr(8288) || chr(65279)) <> ''`。**更重要的一点**:这条 CHECK **不再被描述为「非空白保证」**——它是**枚举集 + 明示残留**的防线,「名字必须含至少一个可见字符」的**主规则搬到了应用层**(`requireName`);门审 P2-1 实测 U+00AD / U+180E / U+2800 / U+3164 / U+034F / U+FE0F / U+115F 两层皆不拦、经真实 HTTP 端点 201 入库,镜像式的应用层补不上这个洞。详见验证 MD §29。仍是 PROPOSED,仍未 ratify。

| 约束/列 | 迁移文件行 | 锁文 §2 出处 | 候选(2026-09-19,待 owner 确认) |
|---|---|---|---|
| `id text PRIMARY KEY`,`'atg_' + randomUUID()` 由服务层生成 | `:38`(DDL);`ApprovalTemplateGroupService.ts:120-122` `newGroupId()` | §2「`approval_template_groups(id text PK 'atg_…' …)`」 | — 不受影响 |
| `org_id text NOT NULL CONSTRAINT atg_org_nonblank CHECK (org_id ~ '[!-~]')` | `:39-40` | §2 约束清单「`atg_org_nonblank`」 | — 候选**未改**此行(单列请示明确保持 `org_id` 两处 CHECK 不变) |
| `name text NOT NULL CONSTRAINT atg_name_nonblank CHECK (btrim(name, ' ' \|\| chr(9) \|\| chr(13) \|\| chr(10) \|\| chr(12288) \|\| chr(8203) \|\| chr(8204) \|\| chr(8205) \|\| chr(8288) \|\| chr(65279)) <> '')`(**勘误 3 候选 REDRAFT v2**;ratified 原文是 `CHECK (name ~ '[!-~]')`,第一版候选 `CHECK (btrim(name) <> '')` 已被第 8 轮门审 P2-1 证伪) | 候选分支现状,符号定位:迁移文件内 `CONSTRAINT atg_name_nonblank`(原 ratified 行号 `:41-42`) | §2 约束清单「`atg_name_nonblank`」——**候选改写此行的谓词**,ratify 对象本身未变 | **是**——候选把该 CHECK 从「可打印 ASCII」改为「去掉显式不可见字符集后非空」;单列请示等 owner 亲自确认。**第 2 轮修复后**:应用层 `requireName` 不再只是镜像 —— 它是**主规则**(名字必须含至少一个可见字符:在 `\p{L}\p{N}\p{P}\p{S}` 且不在 `\p{Default_Ignorable_Code_Point}`、不是 U+2800),并新增 255 码点上限(400 `GROUP_NAME_TOO_LONG`);裁剪集仍是 DB 集的严格超集,所以 `GROUP_NAME_UNSUPPORTED` 的 `name` 分支经生产路由不可达(见服务层 `mapGroupConstraintError` 文档注释)。**已披露残留(两族,直连 SQL 仍可入库)**:(a) 空白族 U+00A0 / U+000B / U+000C / U+1680 / U+2000–U+200A / U+202F / U+205F / U+2028/9;(b) 不可见族 U+00AD / U+180E / U+2800 / U+3164 / U+034F / U+FE0F / U+115F(门审 P2-1)。两族都由应用层 400,真库用例以 `RESIDUE` 命名正向断言 DB 侧确实放行 |
| `sort_order int`(可空) | `:45`→候选分支下约 `:66` | §2「序号可空 + 与 archived_at 配对 CHECK」 | — 不受影响 |
| `CONSTRAINT atg_org_id_uni UNIQUE (org_id, id)`(复合 FK 被引用侧) | `:52`→候选分支下约 `:73` | §2「`atg_org_id_uni`……否则 42830」 | — 不受影响 |
| `CONSTRAINT atg_sort_unique UNIQUE (org_id, sort_order) DEFERRABLE INITIALLY DEFERRED` | `:58`→候选分支下约 `:79` | §2「`atg_sort_unique`……DEFERRABLE 的三条副作用」 | — 不受影响 |
| `CONSTRAINT atg_sort_archived_pair CHECK ((archived_at IS NULL) = (sort_order IS NOT NULL))` | `:62`→候选分支下约 `:83` | §2「`atg_sort_archived_pair`」 | — 不受影响 |
| `CREATE UNIQUE INDEX uq_atg_org_name_active ON … WHERE archived_at IS NULL`(部分唯一,只能是索引) | `:71-75`→候选分支下约 `:92-96` | §2「部分唯一只能是索引……」 | — 不受影响 |
| **不另建** `idx_atg_org_sort`(`atg_sort_unique` 隐式索引已覆盖) | 迁移中确实无此索引 | §2「不另建 idx_atg_org_sort」 | — 不受影响 |
| `down()` 镜像(先删 links 表,再删索引,再删 groups 表) | `:109-113`→候选分支下约 `:130-133` | §2「`down()` 镜像」 | — 不受影响 |

### 2.2 `approval_template_group_links`

| 约束/列 | 迁移文件行 | 锁文 §2 出处 | 候选(2026-09-19,待 owner 确认) |
|---|---|---|---|
| `org_id text NOT NULL CONSTRAINT atgl_org_nonblank CHECK (org_id ~ '[!-~]')` | `:79-80`→候选分支下约 `:100-101` | §2「关联表约束清单」 | — 候选**未改**此行(单列请示明确保持两处 `org_id` CHECK 不变) |
| `template_id uuid NOT NULL REFERENCES approval_templates(id) ON DELETE CASCADE` | `:81-82`→候选分支下约 `:102-103` | §2「`FOREIGN KEY (template_id) … ON DELETE CASCADE`」 | — 不受影响 |
| `group_id text`(**可空**,与 I2′ 一致) | `:87`→候选分支下约 `:108` | §2「`group_id` 可空」 | — 不受影响 |
| `PRIMARY KEY (org_id, template_id)` | `:91`→候选分支下约 `:112` | §2「`PRIMARY KEY (org_id, template_id)`」 | — 不受影响 |
| `CONSTRAINT atgl_group_fk FOREIGN KEY (org_id, group_id) REFERENCES approval_template_groups (org_id, id) ON DELETE NO ACTION ON UPDATE NO ACTION` | `:98-100`→候选分支下约 `:119-121` | §2「**不得**改成 `SET NULL`/`CASCADE`」 | — 不受影响 |
| `CONSTRAINT atgl_state_check CHECK ((group_id IS NULL) = (unlinked_at IS NOT NULL))` | `:104`→候选分支下约 `:125` | §2「三种状态……`CHECK`」 | — 不受影响 |

### 2.3 现场核对(不是照抄迁移文件,是对 `metasheet2_lock_a` 里已应用的真实 schema 核对)

见验证 MD §1——`\d approval_template_groups` / `\d approval_template_group_links` 的现场输出与上表逐条比对,索引名、约束名、DEFERRABLE 标记、复合 FK 全部字节一致。

## 3. 接口与错误码(全部专用码;标注 ratified vs 实现者新增)

### 3.1 七个端点(`packages/core-backend/src/routes/approvals.ts`)——锚点改用「符号 + 近似行号」(impl-gate-A-slice1-round4-20260918.md P3-1 收口)

**为什么改格式**:上一版本表用裸 `:NNNN` 钉行号,连续三轮(修复轮 1/§22/本轮)的门审各发现过一次全表数字漂移——每次任何一处更早的函数插入/删除代码,后面全部端点的行号就整体位移,而没有机械前置动作会去重算它。本表现在把**路径字符串本身**当主锚点(它不随行号漂移,`grep -n` 永远能定位到),行号只作为写文档当下的近似值,标注 `~`,并给出可现场重跑的定位命令,不再承诺精确:

```
$ grep -n "r\.\(get\|post\|patch\|delete\)('/api/approval-template-groups\|r\.\(get\|post\|patch\|delete\)('/api/approval-templates/:id/group" packages/core-backend/src/routes/approvals.ts
```

| 方法 + 路径 | 行(~,现场核对以上方命令为准) | Guard | 服务函数 |
|---|---|---|---|
| `GET /api/approval-template-groups` | `~1152` | `rbacGuard('approvals:read')` | `listApprovalTemplateGroups` |
| `POST /api/approval-template-groups` | `~1163` | `approvalTemplateAdminGuard` | `createApprovalTemplateGroup` |
| `PATCH /api/approval-template-groups/:id` | `~1179` | `approvalTemplateAdminGuard` | `renameApprovalTemplateGroup` |
| `POST /api/approval-template-groups/:id/archive` | `~1191` | `approvalTemplateAdminGuard` | `archiveApprovalTemplateGroup` |
| `POST /api/approval-template-groups/:id/unarchive` | `~1202` | `approvalTemplateAdminGuard` | `unarchiveApprovalTemplateGroup` |
| `POST /api/approval-templates/:id/group` | `~1214` | `approvalTemplateAdminGuard` | `linkApprovalTemplateToGroup`(**+ 一处新增的可见性前置检查,见 §3.5**) |
| `DELETE /api/approval-templates/:id/group` | `~1241` | `approvalTemplateAdminGuard` | `unlinkApprovalTemplateFromGroup` |

上表的 `~` 数字是 `routes/approvals.ts` 在 P2-1 提交(retract falsified wildcard-permission guard claim)落地之后、本 P3-1 提交现场 `grep -n` 的结果,写下的那一刻就可能已经不是最新——任何后续提交在这七行**之前**插入/删除代码都会使它们整体位移。**不要**依赖这些数字做精确跳转或计算位移量;需要时按上方命令或路径字符串重新 `grep -n` 现场定位。本节不再维护「相对某个历史 head 位移了几行」的脚注(此前三版都错在这里)。

`approvalTemplateAdminGuard`(符号定义,`grep -n "const approvalTemplateAdminGuard" routes/approvals.ts` 现场核对,~199)= `rbacGuardAny(['approval-templates:manage', 'approvals:admin-templates'])`,与模板写端点同一常量,非本切片新建。所有七个端点先 `authenticate` 中间件,再各自的 guard,再 handler 内部第一行调用 `resolveApprovalTemplateGroupOrgId`(符号定位,`grep -n "function resolveApprovalTemplateGroupOrgId" routes/approvals.ts`,~352)。

### 3.2 org 来源解析(A‴)

`resolveApprovalTemplateGroupOrgId(req, res)`(`routes/approvals.ts:352-370` —— **行号在修复轮 1 后 +1**,该函数早于新增的可见性辅助函数,只吃了顶部新增 import 那一行的位移;下方 §3.1/§3.3 引到链接端点内部的行号位移更大,见各自脚注):
1. `isOrgIdValuePresent`(`:345-350`)检测 body/query 的 `orgId`——**任何形态**(字符串、数组、其他类型)只要非空/非全空数组即算「出现」,不仅是 `typeof === 'string'`(注释 `:338-344` 解释了为何要挡 `?orgId=a&orgId=b` 这类数组穿透);命中 ⇒ 400 `ORG_ID_NOT_ACCEPTED`(`:356-361`),直接 `return undefined`,handler 不再往下走。
2. 否则读 `req.authenticatedTenantId`(`:362`;`jwt-middleware.ts:101-104`,只从已验签 token 的 `tenantId` 铸造);为空/非字符串 ⇒ 403 `SESSION_ORG_REQUIRED`(`:363-368`)。
3. 否则返回 trim 后的值(`:369`)。

`jwt-middleware.ts:101-104` 现场核对:`authenticatedTenantId` **只**在 `user.tenantId` 是非空字符串时被设置到 `req.authenticatedTenantId`(`:101-104`);紧接着的 `:106-109`(`extractTenantFromHeaders` 回填)只在 `!user.tenantId` 时把请求头值写回 **`user.tenantId`**,从不触碰 `req.authenticatedTenantId`——这正是 A‴(ii)「有效 token + 伪造头 ⇒ 头被忽略」成立的机制证据,不是靠约定。

### 3.3 错误码全表(锚点改用「符号 + 近似行号」,impl-gate-A-slice1-round4-20260918.md P3-1 收口;§3.1 同理由)

**锁文 §2 ratified 的七个专用码**(`ApprovalTemplateGroupService.ts` 文件头,`grep -n "GROUP_NOT_FOUND (404)"` 定位,~27,逐字列出):

| 码 | HTTP | 触发点(符号,行号 ~ 近似,`grep -n "'<message>'" ApprovalTemplateGroupService.ts` 现场核对) | 锁文出处 |
|---|---|---|---|
| `GROUP_NOT_FOUND` | 404 | `renameApprovalTemplateGroup` ~263、`archiveApprovalTemplateGroup` ~294、`unarchiveApprovalTemplateGroup` ~347、`linkApprovalTemplateToGroup` ~405(经各自函数直接抛出,link 的经 `mapGroupConstraintError` 透传) | §2「行锁 SELECT……0 行 ⇒ 404」 |
| `GROUP_ARCHIVED` | 409 | `archiveApprovalTemplateGroup`(重复归档,实现者选择复用同码,见 §3.4)~297、`linkApprovalTemplateToGroup` ~408 | §2「archived_at IS NOT NULL ⇒ 409」 |
| `GROUP_NAME_TAKEN` | 409 | 建组/改名/解档撞 `uq_atg_org_name_active`(`mapGroupConstraintError` 内的 23505 分支,~167,由 `createApprovalTemplateGroup`/`renameApprovalTemplateGroup`/`unarchiveApprovalTemplateGroup` 各自的 `throw mapGroupConstraintError(error)` catch 触发,分别 ~243/~274/~377)、解档显式复核(`unarchiveApprovalTemplateGroup` 内,~359) | §2/I8「409 GROUP_NAME_TAKEN」 |
| `GROUP_NOT_ARCHIVED` | 409 | `unarchiveApprovalTemplateGroup` ~351 | I8「否则 409 GROUP_NOT_ARCHIVED」 |
| `GROUP_SORT_CONFLICT` | 500 | 建组/解档撞 `atg_sort_unique`(COMMIT 时,`mapGroupConstraintError` 内的 23505 第二分支,~170) | §2 DEFERRABLE 副作用③;验收 E |
| `ORG_ID_NOT_ACCEPTED` | 400 | `resolveApprovalTemplateGroupOrgId`(`routes/approvals.ts`)~358 | §2「org 从哪来」 |
| `SESSION_ORG_REQUIRED` | 403 | `resolveApprovalTemplateGroupOrgId` ~365 | §2「多 org 成员」;验收 J |

**实现者新增的请求形状校验码**(锁文未点名,不算第八个 ratified 结果——`ApprovalTemplateGroupService.ts` 文件头自述这一区分):

| 码 | HTTP | 触发点(符号 + 近似行号) | 性质 |
|---|---|---|---|
| `GROUP_NAME_REQUIRED` | 400 | `requireName`(`ApprovalTemplateGroupService.ts`,函数 ~198,抛出 ~200),建组/改名 name 为空、纯空白,或(**第 2 轮修复新增**)不含任何可见字符 | 输入形状校验,与本路由已有的 `APPROVAL_GROUP_ID_REQUIRED`/`APPROVAL_ACTOR_REQUIRED` 同级 |
| `GROUP_NAME_TOO_LONG`(**勘误 3 候选第 2 轮修复新增,2026-09-20;锁 §2 无长度条款 ⇒ 这是新增,待 owner 裁**) | 400 | `requireName`(符号定位),裁剪后码点数 > `GROUP_NAME_MAX_LENGTH`(255);`details` 带 `maxLength` / `actualLength` | 输入形状校验。**为什么是 255**:该列是 `text`(无长度上限可读),所以上限是应用层的候选决定,由两条可核事实推导 —— 仓内人工显示名的 `varchar(255)` 先例,以及 255 码点 ≤ 1020 UTF-8 字节、远低于 `uq_atg_org_name_active` 的 btree 索引元组 2704 字节上限。闭的是门审 P3-1(超长名撞 btree `54000`、映射面不含它 ⇒ 不透明 500)。**残留**:直连 SQL 仍可撞 54000(真库用例正向断言) |
| `APPROVAL_GROUP_ID_REQUIRED` | 400 | link 端点(`routes/approvals.ts` ~1224),`groupId` 缺失/空白 | 同上 |
| `APPROVAL_ACTOR_REQUIRED` | 401 | 建组端点 ~1169、link 端点 ~1220,`resolveApprovalActorId` 返回 null | 沿用本路由既有惯例 |
| `GROUP_NAME_UNSUPPORTED`(**本轮/回流修复新增,impl-gate-A-slice1-round4-20260918.md P3-1 补录——此前本表漏列**;**勘误 3 候选(第 2 轮修复后)**下,`name` 这一半**未见经生产路由可达**——`requireName` 的裁剪集是 DB 集的严格超集,且它要求名字含至少一个可见字符,所以这些名字在任何 DB 往返之前就 400 `GROUP_NAME_REQUIRED`。**这是受限表述,不是闭合断言**:门审第 1 轮曾把它写成全称并被实测证伪,现在的判据带自己的残留(U+2800 是谓词里唯一的显式例外),见验证 MD §29.1。`org_id` 两个成员不受影响,仍是生效的 defense-in-depth。**message 已在第 2 轮改写**——原文案只对两个 `org_id` 臂准确,且「被 `toContain` 冻结」的免修理由经门审核为假(全仓无任何测试断言该字符串);错误码本身**未动**) | 400 | `mapGroupConstraintError` 内的 23514 分支(`atg_name_nonblank` CHECK 违例,符号定位 `mapGroupConstraintError`),由 `createApprovalTemplateGroup`/`renameApprovalTemplateGroup` 的 catch 触发;`details.constraint` 携带约束名 | **非 ratified 码**——请求形状映射(纯 CJK/不可打印字符名 ⇒ 400 而非裸 500),owner 勘误项见 §3.4(`atg_name_nonblank` CHECK 本身是否改写为**勘误 3 候选 REDRAFT v2** 的显式裁剪集 `btrim`——**不是**已被第 8 轮门审 P2-1 证伪的 `btrim(name) <> ''`——待 owner 裁决,与本条错误码映射是两件事:后者今天已落地,前者仍是候选) |

**七个 `handleApprovalsError` 兜底码**(数据库故障/未预期异常时的 500 fallback,不是业务语义码,而是「这条请求处理失败」的通用标签,7 个端点各一个、名字含端点动作;`grep -n "handleApprovalsError(res, error, 'APPROVAL_TEMPLATE_GROUP" routes/approvals.ts` 现场核对):

`APPROVAL_TEMPLATE_GROUP_LIST_FAILED`(~1159)、`_CREATE_FAILED`(~1175)、`_RENAME_FAILED`(~1187)、`_ARCHIVE_FAILED`(~1198)、`_UNARCHIVE_FAILED`(~1209)、`_LINK_FAILED`(~1235)、`_UNLINK_FAILED`(~1248)。这七个只在 `ServiceError` 之外的异常(如连接失败)时出现——正常路径下的所有已知失败都会先命中上表的专用码。

**行号免责声明(与 §3.1 相同):以上全部 `~NNN` 是本 P3-1 提交现场 `grep -n` 的近似值,不是精确锚点**——`ApprovalTemplateGroupService.ts` 与 `routes/approvals.ts` 任何一处更早的代码插入/删除都会使后面的数字整体位移。需要时用每行给出的符号名(函数名/抛出的 message 字符串/错误码字符串本身)重新 `grep -n` 现场定位,不要对着这些数字做算术或跳转。

### 3.4 两处实现者裁量(未获锁文文本背书,写明供门审核实;第二处为本轮/回流修复新增,impl-gate-A-slice1-round4-20260918.md P3-1 并入)

**(1)** `unarchiveApprovalTemplateGroup`(符号定位,~337-391)对「归档一个已经归档的组」没有单独处理——它走的是「找不到该 id 的活跃组行」还是复用 `GROUP_ARCHIVED`?现场读代码:`archiveApprovalTemplateGroup`(~284-336)在锁到组行后检查 `archived_at !== null` ⇒ 抛 `GROUP_ARCHIVED`(~297,409)。锁文 §2/I2 只定义了「归档一个活跃组」的路径,未定义「归档一个已归档组」应返回什么;`ApprovalTemplateGroupService.ts` 文件头注释(`grep -n "this implementer's choice" ApprovalTemplateGroupService.ts`,~34)自陈这是实现者选择复用链接态判到的同名码,而非新码,且验收表没有任何一行练到这个分支。属于**未获锁文文本背书的实现决定**,不是缺陷,列入门审核对项。

**(2)**(owner 裁量桶,与 §23.5 的 `atg_name_nonblank` 勘误请示是**同一枚硬币的两面,但不是同一件事**——见下方区分)`GROUP_NAME_UNSUPPORTED`(§3.3 新表)本身是否应该存在,取决于 owner 对 `atg_name_nonblank CHECK (name ~ '[!-~]')` 的最终裁决(**勘误 3 候选**下三条分支的求值见每条句末):
- 若 owner **维持**该 CHECK 拒绝非 ASCII/CJK 名字的现状(即认定「组名只能是可打印 ASCII」是有意为之),那么 `GROUP_NAME_UNSUPPORTED` 就是一个**长期存在**的、面向最终用户的合法错误码,§3.3 的分类("请求形状校验码"、非 ratified)成立,不需要改动。
- 若 owner **采纳**§23.5 的勘误请示(**勘误 3 候选**;请示文本已按 REDRAFT v2 重拟,谓词为显式裁剪集的 `btrim`,**不是**已被证伪的 `CHECK (btrim(name) <> '')`),那么这条 CHECK 将不再对纯 CJK/非 ASCII 名字触发 23514,`GROUP_NAME_UNSUPPORTED` 这整条错误码路径会变成**死代码**(`mapGroupConstraintError` 里的这个分支永远不会被触发,因为 `NONBLANK_CHECK_CONSTRAINTS` 里的约束语义已改变),需要在那次(独立的、含 DDL 的)Draft PR 里一并决定是删除这个分支/错误码,还是保留作为「防御性映射,万一将来 CHECK 又被改回去」。
- **两件事的关系**:§23.5 问的是「CHECK 该不该改」(DDL 层面,本切片不做);本条问的是「如果不改 CHECK,`GROUP_NAME_UNSUPPORTED` 这个应对措施本身算不算一个需要 owner 背书的新公开合同」(错误码/API 契约层面,本切片已经落地,行为已经生效)。owner 只需回答 §23.5 一次,本条的答案由那次回答**派生**,不需要单独再问一遍。

### 3.5 另一处实现者裁量(修复轮补齐,gate P2-1)——挂接可见性的失败形状

锁文 §2 原文「模板可见性仍走原权限谓词……一个组织只能给自己**能看到**的模板归组(挂接时按原谓词校验可见)」只 ratify 了**要校验**这件事,没有点名校验失败时的 HTTP 状态码或错误码——这两点是实现者选择,写明供门审核实:

- **落点**:`routes/approvals.ts`(新增导出函数 `isApprovalTemplateVisibleForGroupLink`,紧邻 `resolveApprovalTemplateVisibilityActor` 之后),不是 `ApprovalTemplateGroupService.ts`——后者的文件头注释(`:5-8`)自陈「never reads `req` and never defaults the org」,这个不变量延伸到「不做可见性判定」:可见性判定需要 actor(依赖 `req.user`),放进这个刻意不碰 `req` 的服务模块会违反它自己的边界,所以校验点选在路由层,链接前置检查,链接本身的服务函数不变。
- **谓词复用,非新逻辑**:直接调用锁文/§1.6(I5/I6)已经点名不得新造的 `applyTemplateVisibilityFilter`(`ApprovalProductService.ts:4383-4419`,与列表/详情端点同一个函数),对 `approval_templates` 的 `id = $1` 加同样的析取条件——**不是**又发明一条独立的可见性判定。
- **失败形状(实现者选择,非 ratified 码)**:不可见 ⇒ 404 `APPROVAL_TEMPLATE_NOT_FOUND`(零行写入,链接服务函数完全不被调用)——复用本路由既有的同名码(`:921`,模板详情端点在 actor 看不到时的同一 404),不是发明第 11 个专用码。选择 404 而非 403 的理由:与仓内其它 actor 门控的模板查找同构——「存在但看不见」与「不存在」对调用方呈现相同响应,不额外暴露「有一个你看不到的模板」这一事实。
- **范围仅限挂接**(锁文原文点名的动作是「挂接」,不含解除关联)——`unlinkApprovalTemplateFromGroup` 未加此校验,解除关联对可见性的语义锁文未定义,不在本条修复范围内。
- **可达性披露(第 6 轮门审 P2-1 收口,第二次按实测重写——第 5 轮「按实测重写」换上的「guard ⊋ manager(严格超集)」结论本身也被证伪,失效评估见验证 MD §25,这是对断言本身第二次求值,不是行号漂移)**:`approvalTemplateAdminGuard`(`rbacGuardAny(['approval-templates:manage', 'approvals:admin-templates'])`)的人口与 `isTemplateManager` 判定人口**互不包含**——两个方向各有一个实测反例(方向一端到端实测;方向二的 guard 拒绝端到端实测,manager 判定由对导出解析器的直调实测,附负控——第 7 轮门审 P3-3 指出「两个方向都端到端」对方向二过强),谁都不是谁的子集。机制:`resolveApprovalTemplateVisibilityActor` 的权限腿(`permissions.includes('approval-templates:manage')` 等六条判定之一)不带任何 namespace-admission 合取项;`rbacGuardAny` 的同名权限腿则与 `isPermissionAllowedByNamespaceAdmission` 合取(`approval-templates` 是 admission-controlled resource,`approvals` 才在 `NON_NAMESPACED_PERMISSION_RESOURCES` 豁免名单里)。**方向一(guard 过、非 manager)**:`rbacGuardAny` 的最终兜底 `isAdmin(userId)` 直接查 DB(`user_roles WHERE role_id='admin'`),与 `isTemplateManager` 读的 JWT 字段完全独立——验证 MD §2(c) 用例(纯 HTTP、真库)用一个只在 `user_roles` 持有 `admin` 角色、JWT 里无任何 admin/manager 声明的主体打挂接端点,对该主体看不见的模板拿到 **404 `APPROVAL_TEMPLATE_NOT_FOUND`**——`applyTemplateVisibilityFilter` 在这类主体上仍然生效,今天并没有退化成「模板是否存在」的检查(不存在的模板 id 同样 404,顺带堵上了 `mapGroupConstraintError` 未映射 `template_id` 上 `atgl_template_fk` 23503 的既有空白——那种情况下之前会 500)。**方向二(manager、guard 不过)**:一个仅持 guard 自己字面点名的权限码 `approval-templates:manage`(不含任何 namespace-admission 授予)的主体,满足 `isTemplateManager` 的这一条判定腿,但打 guard 守卫的建组端点拿到 **403**——验证 MD §2(d) 用例(纯 HTTP + 对导出解析器的直调,同一权限声明形状,附负控)端到端实测这一点,与 §23.6 记录的 `ZZR4-EXACT-RESULT status=403`(perms 恰为该码)一致。另一条曾被怀疑成立的腿——通配权限码 `approval-templates:*` 单独过 guard——**不成立**:`hasPermissionCode` 确实把它展开匹配到 guard 字面点名的 `approval-templates:manage`,但这只是 `rbacGuardAny` 权限腿的一个合取项,第二个合取项要求该主体另外持有 `approval-templates` 的 namespace-admission 授予;端到端实测该通配码与 guard 自己字面点名的码一样拿 403(第 2 轮与第 4 轮门审各独立证伪一次),全仓真实授予计数为 0,这条腿今天不存在可达形式。**生产 provisioning 路径上是否恒有「授予 `approval-templates:manage` 必同时授予对应 namespace admission」(`grantNamespaceAdmissions` 的存在使这是一条可争辩的命题)未经实测,本节不作断言**——方向二的反例是在本测试 harness 的 `RBAC_TOKEN_TRUST` 配置下实测的,不是对生产配置的断言。真正的判别力由三条腿共同验证:**§2(a)**(谓词直调,手写 `isTemplateManager: false` 的 actor,验证判定本身的正确性)+ **§2(c)**(纯 HTTP、真库,方向一反例)+ **§2(d)**(纯 HTTP + 直调,方向二反例,附负控)——见验证 MD §2 新增 mutation 台账。**运行时行为本轮零变化——这段改写的是这段披露文字对既有行为的描述,不是行为本身。**

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
| `approvalTemplateAdminGuard` 复用 | `routes/approvals.ts:199`(定义,修复轮 1 后 +1)、`:887` 等既有模板写端点共用同一常量(+24) | I7 |
| `rbacGuard('approvals:read')` 复用 | 既有读端点 `routes/approvals.ts:573`(`GET /api/approval-templates`,修复轮 1 后 +24)同一 guard 工厂——本切片源码注释 `:1111`(+24)写的「`:531`」是该注释自身相对旧行号基线的漂移,现场行号以 `:573` 为准 | I7 |
| `ServiceError` / `sendServiceError` 复用 | `ApprovalBridgeService.ts:1559`(类定义,本轮未改)、`routes/approvals.ts:446`(`sendServiceError`,修复轮 1 后 +24)、`:509`(`handleApprovalsError`,+24) | 专用码经既有错误管道输出,未新建平行错误体系 |
| I6 零改动的两文件 | `packages/core-backend/src/multitable/automation-service.ts`、`packages/core-backend/src/multitable/automation-approval-template-access.ts` | 验收 I(本地 diff 取证,见验证 MD) |
| I′(b) 三个 actor 构造器现场行号 | `routes/approvals.ts:375`(`resolveApprovalTemplateVisibilityActor`,修复轮 1 后 +1;锁文基线写 `:314-330`,现场已核对函数仍在)、`approval-record-link-txn-auth.ts:588`(与锁文引用行号**一致**,本轮未改该文件)、`automation-approval-template-access.ts:91`(构造字面量起始行,锁文基线写 `:91-102`,本轮未改该文件) | 三处均未被本切片触碰,I′(b) 断言其 `Object.keys` 集合运行时不变 |
| `ApprovalTemplateVisibilityActor` 接口 + manager 短路 | `ApprovalProductService.ts:237-242`(接口字段)、`:4389`(`applyTemplateVisibilityFilter` 的 `isTemplateManager` 短路) | 与锁文引用行号一致;I′(a) 夹具设计围绕这条短路展开 |

## 6. 留给后续切片的项

| 项 | 去处 |
|---|---|
| session-org 前端选择器组件、`useSessionOrg` 接线、`run-required-web-tests.sh` 令牌、J 的前端半验收 | A-2 |
| J 行「未知 `section=` 令牌 ⇒ 400」 | 补充清单 #5:锁文勘误请示 owner,挪到 A-4(分期 3)门,`section=` 到分期 3 才存在 |
| C 行「`?category=` 与 `section` 同现 ⇒ 400」 | 同上,挪到 A-4 |
| B′ 行「无案例的后备判定 mutation 台账」(实现门审 P2-3,修复轮 3) | 同上,并入 #5 同一个 owner 勘误桶——I2′ 判定唯一消费方(`section=` 列表端点)也在 A-4 才存在;本切片测试(`lifecycle.db.test.ts:442-`)已改为纯 DB 级说明性断言,不冒充可 mutation 的应用代码门,A-4 落地端点时须对该端点重做台账 |
| 验收 C(中心页分节 `section=`)、D(category 后备显示/筛选)、E 后半(重排端点 + 并发重排终态) | A-4(分期 3),见 §1.2 |
| 管理员「按现有 category 建组并挂接」预览→执行→可回滚 | A-3(分期 2) |
| 补充清单 #1 的闭世界缺口(`scripts/ops/approval-template-groups-ci-wiring.test.mjs` 新守卫文件) | 未排期,留给后续单元或 owner 裁决是否现在做(见验证 MD) |
| §3.4 提到的「重复归档复用 `GROUP_ARCHIVED`」裁量 | 门审核对项,若 owner/门审要求新码或不同状态码,需改动服务层一行 + 补一条验收 |
| §3.5 挂接可见性校验(P2-1)引入的响应形状副作用:非法(非 uuid)`templateId` + 格式合法但**不存在**的 `groupId` 这一格,修复前是 404 `GROUP_NOT_FOUND`,本切片起是 500 `APPROVAL_TEMPLATE_GROUP_LINK_FAILED`(第 3 轮门审 P3-6 现场实测确认,机制见验证 MD §22.5;`groupId` 存在时该格修复前后均为 500,不受影响) | 已披露,不阻塞;下一切片建议给 `mapGroupConstraintError` 补 22P02 → 400 映射,统一这一格与既有「组存在」格的响应形状 |

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

本切片没有新引入需要 owner 裁决的问题;§6「留给后续切片的项」里的三条锁文勘误请示(J/C 的 400 挪分期,以及修复轮 3 归并进同一桶的 B′ mutation 台账无案例)已在补充清单 #5 里向 owner 披露,尚待回应,不阻塞本切片的 Draft PR。
