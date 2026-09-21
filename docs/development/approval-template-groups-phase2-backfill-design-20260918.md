# 审批表单分组 Phase 2(切片 A-3:按现有 category 建组并挂接)— 已过独立设计门审 `design-gate-A3-phase2-20260918.md`(APPROVED-WITH-CHANGES:5 P1 / 4 P2 / 3 P3,其中 4 条 P1 为真库实测非纸面推理;16 条 changesRequired 已按 §13.1→§19.1→§22.1 三层现场核对全部落地,**三表若有冲突以 §22.1 为准**)

> **本步(文档定稿 + 改名,2026-09-18,任务「approval-template-groups-phase2-backfill 交付物」)新增的抬头信息;下方原标题行以下、本块以外的第 2–11 行(2026-09-18 初稿时所写)整段保留、一字未删,按记忆 `feedback_supersession_marker_must_evaluate_not_void` 原样存档——它记录的是**初稿时**的状态(DRAFT,未过门审,HEAD `0144932ac`),不再是当前状态的唯一来源,当前状态见本块 + §13.1/§19.1/§22.1/§22.5。**
>
> - **门审 provenance 与改名对象**:`reviews/design-gate-A3-phase2-20260918.md`(独立 Opus 门审,refute-first,非 A-3 实现 lane),被审对象 = 本文件在**旧文件名** `docs/development/approval-template-groups-phase2-design-20260918.md` 下、`@4b546fb13` 的那个版本。本次提交把该文件 `git mv` 到当前路径(对齐切片/分支名 `approval-template-groups-phase2-backfill`),**内容起点与门审对象逐字相同**,此后 §14–§22(续做步骤 8/9/11/12/17/18/19/20/21)都是在旧文件名下继续追加的历史——门审报告"被审对象"那一行引用的旧路径,rename 后不再是本仓当前文件树的有效路径,这是本次 rename 的已知后果,如实记录在此,不回改门审报告本身(该报告存于 `~/.claude/projects/…/reviews/`,不属本 git 仓,本任务也未获授权改动独立门审记录)。
> - **诚实形状(门审报告 §0 原文,不得只留"APPROVED-WITH-CHANGES"五个字概括)**:「按本报告给的默认值落地后,A-3 在**本产品实际的中文 category 语料上仍然是惰性的**……要真正可用必须 owner 先 ratify `atg_name_nonblank` 勘误。默认值只保证 Draft 能推进且不会静默写坏数据,不保证功能对中文分类生效。」§13.4 O2 与 §13.6 首行已经记了这条待裁;这里在抬头重申,防止只读抬头一段的读者漏看。
> - **7 个仓内代码/测试文件的 12 处注释仍按旧文件名引用本文档**(rename 后均已失效;任务边界"不改代码"故未一并修正,留给下一次触碰这些文件的提交顺手改,已如实列入 remaining):`packages/core-backend/src/routes/approvals.ts:451,588`;`packages/core-backend/src/services/ApprovalTemplateGroupService.ts:47,615,687,851`;`packages/core-backend/src/db/migrations/zzzz20260919090000_create_approval_template_group_backfill_batches.ts:8`;`packages/core-backend/vitest.config.ts:1838`;`packages/core-backend/tests/integration/approval-template-groups-backfill-preview.db.test.ts:11`、`-execute.db.test.ts:12`、`-rollback.db.test.ts:13`、`-batches-list.db.test.ts:18`。
> - **§13 裁定落地对照表指针(不在此重复整张表)**:§13.1(设计门审当天,续做步骤 4)= 初版逐条落地表(16 条 changesRequired);§19.1(续做步骤 18)= **第一次对着当前分支代码 `grep`/`git log` 现场核对**的对账表,勘误了 §13.1 三处过期文字(见 §19.3,#1/#5/#9 三格);§22.1(续做步骤 21)= **按门审报告自己的 Q1–Q7 + 额外 P1×2/P2×2 编号**(与 changesRequired 1–16 编号非一一对应)重新核的第二张对账表,每格都附 `git log -S "<独有文本>"` 核实过的 commit SHA,并纠正了草拟时一次凭 commit 主题行猜错的 SHA(§22.1 引言自陈)。**三张表冲突时以 §22.1 为准**——这是本次文档定稿新加的裁决规则,不是原提案自带的内容。
> - **本步(文档定稿)新核对、需要拆两半讲的一项(如实披露,不笼统算作"未测")**:锁 §4 验收 E「序号不变量」在 A-3 execute(组合调用者)路径上分两条腿——**隔离级别腿:已覆盖**。commit `45e5c8a21` 在 RR-default 池文件(`approval-template-groups-serialization.db.test.ts`)新增的用例(`A-3 execute (composed caller): under the RR-default pool, execute still reads a concurrently-committed holder row at MAX(sort_order) …`)构造的是**真实并发**——一条裸连接持 L0 并提交一个 `sort_order=1` 的组,同时一次真实 `POST …/backfill/execute` 停在同一把 L0 上、放行后继续,断言 = 201 且新组 `sort_order > 1`(读到了并发提交后的新鲜 MAX,不是陈旧快照撞 `23505`)——这正是 E 的 SET 义务/隔离级别机制,应用到了组合调用者本身,不是单原语调用者的旁证。**终态腿:未覆盖**——没有一条测试构造"两个并发 `POST …/execute`"或"execute 并发手工建组"、双方都跑完、断言各自拿到 n+1/n+2 且零 `23505` 泄露的终态(§3.2 只给出这半的设计论证:后到者重新查询 `eligible` 已清零,退化为空事务,不必真的竞争同一个 `MAX+1`)。§13 changesRequired #13 另外两条(`117e248cb`/`f3b3cc5d3`)断言的是**锁序停车点**,与终态腿也是两回事。记入 remaining 的只有终态腿这一半,不在本步补测试(不改代码边界)。

> **RATIFY 记录(原样引用,来自 `approval-form-group-entity-design-lock-draft-20260916.md` 抬头,与验证 MD §0 同一段落,双份存放以满足交付物清单"设计 MD 原样引用抬头 RATIFY 记录"的字面要求——两份内容须保持逐字一致,任何一份被编辑必须同步另一份)**:
>
> > **RATIFY 记录(2026-09-18)**
> > - **授权来源(owner 亲写,本会话消息原文)**:「按 你建议执行1」——指向我前一条消息的建议 1:「ratify 三把锁:分组锁 v2.13、待办中心锁 v2.14、撤销锁 v5.9;待裁项按锁文里标的建议值」。owner 未点名的项(合并 PR、#5805 收口、#5698 处置)**不在本授权内**。
> > - **ratify 当刻 head**:`origin/main @ 00781e68b`(2026-09-18);**验证基线** `85ddd2926`(第 4–13 轮门审全部在此 head 上核实),两 head 之间相差 228 提交(timemachine/recovery 合并列车)。
> > - **漂移核对(85ddd2926 → 00781e68b)**:本锁引用的核心文件(`routes/approvals.ts`、`ApprovalProductService.ts`、`approval-seat-authorization.ts`、`AuthService.ts`、`rbac/*`、`plugin-attendance/index.cjs`、迁移目录既有文件、`plugin-tests.yml`)**字节相同**;唯二有位移的是 `packages/core-backend/src/index.ts`(整体 +8 行:jwt 中间件/correlation 增强/`app.use(approvalsRouter(`/correlationErrorHandler/插件 `addRoute` 的 catch 行号平移)与 `multitable/automation-service.ts`(import 行不变,布尔消费方区块行号平移);`run-required-web-tests.sh` 的 exec 行只多了 stock-prep 令牌;新增迁移 `…create_recovery_archive_derived_effects.ts` 与本锁无关。锁文正文保留基线行号,以本条为准换算。
> > - **裁决结果(按建议值)**:Q3 分组按 org 作用域,`org_id` 只取 `req.authenticatedTenantId` = **是**;Q4 归档不保留成员、解档得空组 = **是**;Q5 `?category=` 与 `/categories` 首期不动、分期 3 再裁;**分期 2(按现有 category 建组并挂接)= 要,做成预览→执行→可回滚的管理员操作**;`key` 全局唯一 = **另立锁**,不顺带。§7 第 2 项(§2 两表形状 + 锁序表 + I1–I8)按 v2.13 ratify。
> > - **不变的约束**:含 DDL 的切片只能以 Draft PR 交付、**不应用、不合并**;任何合并仍需 owner 逐 PR 一句话;实现按分期走「Sonnet 实现 → Opus 门审 → 修复重跑闸 → Draft PR」。

- 锁文(唯一 ratify 对象):`approval-form-group-entity-design-lock-draft-20260916.md`,**v2.13 RATIFIED 2026-09-18**。锁文 §6「期 2」原文只有三个词的约束:「管理员『按现有 category 建组并挂接』的显式操作,预览 → 执行 → 可回滚」+ 门 =「1 落地」。**本切片的全部交互形状、DDL、错误码、并发/回滚精确性都是本文档新提出的设计,不是锁文逐条对照的实现**——这一点与 A-1(锁文 §2/§3 逐条落地)性质不同。
- 目标文档:`goal-three-locks-full-implementation-20260918.md`(切片 `A-3 分期 2`,门 = 「待 A-1 Draft PR 过门(『1 落地』按此求值,已请示 owner)」——**该前置门已满足**:`#5852` 第 3 轮 DRAFT-READY(0 P1/0 P2/6 P3)@`0144932ac`,现场 `gh pr view 5852` 核对 body 确认。
- 补充清单:`impl-supplementary-gate-checklist-20260918.md` #1–#4(三线共用)
- **门控前提(taskbook 原文,未被任何后续文档撤销)**:`impl-taskbook-A-grouping-20260918.md:72`「W7(预览端点)……视设计提案而定 | 先出设计提案,过独立门审后才可标 S/M/L」;`:227`「分期 2 的交互设计未锁……W7/W8/W9 在没有独立设计提案通过门审之前不进入实现队列」。**本文档就是这份设计提案本身**,~~尚未经过独立门审~~【本行"尚未经过独立门审"与"本步只交付这份提案不写代码"两句是**初稿当时**(HEAD `0144932ac`)的状态,已被 §13 起的门审裁定与 §14–§22 的 `.ts`/迁移/真库测试落地整体推翻,不是本次改名/文档定稿这一步造成的变化——本行不删,标注在此,避免读者读到这句当作当前状态】——本步(worktree 建立后的第一个可提交单元)只交付这份提案,不写任何 `.ts` 实现代码。
- 本文档所在分支:`feat/approval-template-groups-phase2-backfill`(基于 `origin/feat/approval-template-groups-phase1`)
- 本文档写作时 worktree HEAD:`0144932ac`(与 A-1 的 Draft PR #5852 门审通过时的 head 相同——本分支尚无自己的提交)
- `origin/main` 与本分支的 merge-base:`89f1ecdee2`(**相同**,即 `feat/approval-template-groups-phase1` 是 `origin/main` 的直接后代,本分支进一步在其上直接展开,~~无 rebase 漂移~~【**已不成立,本次文档定稿现场核对后勘误**:本分支此后经历过一次真实 rebase——`git rebase origin/feat/approval-template-groups-phase1`,把本分支已有的 26 个提交重放到 phase1 新落地的 `03ee9f4bb`(CJK-name 400 映射修复)之上,merge-base 因此推进,证据 = `docs/development/approval-template-groups-phase2-backfill-rebase-note-20260918.md` 全文(含一处 JSDoc 段落冲突的解决记录、`--force-with-lease` push)。本行原文只对**初稿写作那一刻**成立,不是本文档当前状态的描述】
- 下文所有 `file:line` 都是**对本 HEAD 现场 `grep -n` 的结果**(§0–§13 初稿写作时的 HEAD;§14 起各续做步骤自带各自的 HEAD/commit;rebase 后的当前 HEAD 见文档最顶部抬头块与验证 MD,不重述)。

## 0′. 交付物对照 index(目标文档「每个切片的交付物」要求 → 本文档对应位置;本步新增,不改下文任何一节)

| 交付物要求(`goal-three-locks-full-implementation-20260918.md` 原文) | 本文档位置 |
|---|---|
| 范围 / 不在范围 | §0(范围重述,任务书原文逐条核可行性);不在范围见锁 §5「明确不做」(未在本文档转抄,验证 MD 已引用原文)+ §13.3/§22.5(留给后续的项即"本切片不做") |
| 数据模型与约束,逐条对锁文 § | §2(数据模型,DDL);§13.1/§19.1/§22.1 三层表把每条约束/DDL 决策对回锁文 §2 或门审报告的 Q/changesRequired 编号 |
| 接口与错误码 | §6(端点、guard、I7 授权面冲突);§7(错误码表) |
| 事务与锁序,file:line | §3(execute 算法 + §3.0 嵌套事务死锁决策)、§4(rollback 算法);§13.2(逐字保留的门审成品:统一锁序 + 品牌类型方案);落地 file:line 见 §14/§17/§18/§19.1/§22.1(`routes/approvals.ts`/`ApprovalTemplateGroupService.ts` 具体行号) |
| 与既有代码的接缝,file:line | §1(现有原语盘点,A-1 落地函数的 file:line);§11/§12(附录:`WithClient` 抽取的先行落地与独立复核) |
| 留给后续切片的项 | §13.3(设计阶段的未落地项)→ §19.4 → §20.6/§21.6(如有)→ **§22.5(最新一版 remaining,冲突以此为准)**;本步新增两条见上方抬头块最后一条(验收 E 姊妹判据的**终态腿**未测,隔离级别腿已由 `45e5c8a21` 覆盖,两腿不可合并成一句)与"12 处代码注释未随改名更新" |
| owner 待裁项 | §13.4(O1/O2/O3,均已给默认值);§13.6(Draft PR body 必写清单,含待 owner 一句话确认的两项);§7 待 owner 裁决(锁文原表,分期 2 本身的"要/不要"已由抬头 RATIFY 记录裁定为"要") |
| RATIFY 记录(锁文抬头,原样引用) | 抬头块(本文档最顶部,标题行之后)已整段引用;验证 MD §0 存有逐字相同的第二份(交付物清单对两份 MD 都点了名)——**两份必须保持逐字一致**,编辑一份务必同步另一份,不靠"只留一份、互相指针"规避分叉风险 |

## 0. 范围重述(任务书原文,逐条核对是否可行)

> preview = 对该 org 可见模板按 category 分桶给出「将建的组 + 将挂接的模板」清单(不写);execute = 在 L0 顾问锁 + READ COMMITTED 事务内建组(名 = category,重名走 GROUP_NAME_TAKEN 语义:已有同名活跃组则挂接到它)并 upsert 挂接,记录一条可回滚的操作批次(新表或复用既有审计/批次机制——若需新表,DDL 照 §2 惯例、迁移 zzzz 命名、Draft only);rollback = 按批次把本次建的组归档 + 本次挂接的关联解除(不动批次外的数据);全部走 §2/§3 的既有原语,不另造第二套写路径。

三段逐条可行性核对见 §2(数据模型)、§3(execute 算法)、§4(rollback 精确性)——**execute 与 rollback 都不能对既有原语做「调用」级复用,只能做「语句」级复用**,原因见 §3.0(嵌套事务死锁)。

## 1. 现有原语盘点(A-1 已落地,本切片必须复用其语句形状,不得另造)

`packages/core-backend/src/services/ApprovalTemplateGroupService.ts`(A-1 落地,本切片视为只读依赖,除 §3.0 的必要重构外不改其对外行为):

| 原语 | 现场行号 | 本切片如何复用 |
|---|---|---|
| `mapGroupConstraintError`(23505 → `GROUP_NAME_TAKEN`/`GROUP_SORT_CONFLICT`) | `:133-145` | execute 直接调用(纯函数,无连接,可安全跨事务复用) |
| 建组语句形状(MAX+1 → INSERT) | `createApprovalTemplateGroup:175-202` | ~~execute 内联同样的两条语句(见 §3.0 为何不能直接调用这个导出函数)~~ **【§13 changesRequired #9,已求值,68aead6db 之后】execute 改为调用级复用 `createApprovalTemplateGroupWithClient`,不得抄语句。** |
| 挂接语句形状(FOR UPDATE → upsert) | `linkApprovalTemplateToGroup:349-384` | ~~同上,execute 内联~~ **【同上,#9】execute 改为调用级复用 `linkApprovalTemplateToGroupWithClient`,不得抄语句。** |
| 归档语句形状(FOR UPDATE → 批量解除 → archived_at/sort_order UPDATE) | `archiveApprovalTemplateGroup:241-278` | rollback 内联(带精确性前置条件,见 §4)。**【§13 changesRequired #9,已求值】rollback 确实不调用 `archiveApprovalTemplateGroupWithClient`(§4.1 论证维持成立),但共用语句不得抄成第二份文本——须提成命名导出 SQL 常量或给该函数加「附加谓词」形参,做到全仓该语句只有一处文本。** |
| `newGroupId()`(`atg_` 前缀 + `randomUUID()`) | `:120-122` | 沿用同一 id 前缀惯例;批次表 id 用平行的 `atgbb_` 前缀,同一生成器函数签名 |
| L0 顾问锁语句 | 各函数内 `SELECT pg_advisory_xact_lock(hashtext($1))`,key = `` `atg:${orgId}` `` | execute / rollback 用**同一个 key**——backfill 与手工建组/归档竞争同一把 org 级锁,这正是"并发 execute 在 L0 上停车"与"execute 与手工建组互斥"的机制来源,不是分开的锁 |
| 模板可见性谓词 | `applyTemplateVisibilityFilter`,`ApprovalProductService.ts:4383-4419`;路由层封装 `resolveApprovalTemplateVisibilityActor`,`routes/approvals.ts:375`(A-1 修复轮后行号) | preview/execute 的候选模板查询复用同一谓词,同一 actor 构造函数——不新造可见性判定 |

## 2. 数据模型(新增,DDL,Draft only)

**批次机制选择:新表,不复用既有审计/批次机制**——现场核对:全仓无「可回滚批次」的通用机制(`grep -rl "operation_batch\|bulk_operation\|rollback_batch\|undo_batch" packages/core-backend/src/db/migrations/` 零命中;唯一形态相近的先例 `zzzz20260731120000_w4c3a_import_rollback_foundation.ts` 是考勤导入子系统的「header 表 + 逐行 witness 表」模式,表结构与本场景语义完全不同,不能跨子系统直接挂接——所以按锁文自己给出的另一个选项「新表」,DDL 照 §2 的惯例(Kysely `sql` 模板、组织级 CHECK、复合 FK 钉 org 一致性)。

**【§13 changesRequired #15,本步(续做步骤 5)落地——更宽普查,取代上一段的四 token 表述】** 门审 Q1(b) 指出四 token grep 本身是记忆 `finding_o2_census_token_list_enumeration_trap` 点名的陷阱(token 列表决定分母),要求换成对 approval 域候选表逐个读定义的更宽普查。复核结果(`ls packages/core-backend/src/db/migrations | grep -iE "audit|event|batch|rollback|import"`,逐个读表定义):`operation_audit_logs`(`20250926_create_operation_audit_logs.ts:5` 注释原文 `minimal placeholder to satisfy startup writes`;`zzzz20260209100000_fix_operation_audit_logs_schema.ts` 又一次列名对齐)——无 org 列、无任何 FK,是自述占位且 schema 已漂移两次的表,不能把 rollback 的真值挂在它上面;`oapi_write_audit` / `automation_action_applied` / `approval_form_field_revisions` 各自域内,均无 org 列、无 FK。上一段引用的 `zzzz20260731120000_w4c3a_import_rollback_foundation.ts`(header + 逐行 witness)不只是「表结构不同不能跨子系统挂接」的驳回对象——它同时是**本仓已有的 header+detail 回滚模式正面先例**,本提案 §2 的三表形状与它同族,该点上一段没写出来,这里补上。

迁移文件(拟):`packages/core-backend/src/db/migrations/zzzz20260919090000_create_approval_template_group_backfill_batches.ts`(**含 DDL,Draft only,不应用不合并**)。

### 2.1 `approval_template_group_backfill_batches`(批次头,一次 execute 一行)

```sql
CREATE TABLE approval_template_group_backfill_batches (
  id             text PRIMARY KEY,                          -- 'atgbb_' + randomUUID()
  org_id         text NOT NULL
                   CONSTRAINT atgbb_org_nonblank CHECK (org_id ~ '[!-~]'),
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  rolled_back_at timestamptz,                                -- NULL = 未回滚
  -- 复合唯一,专供下方两张子表的复合 FK 引用——确保子表的 org_id 与其所属批次的
  -- org_id 恒等(同 §2 atg_org_id_uni 的用途:被引用侧必须有它,42830)。
  CONSTRAINT atgbb_org_id_uni UNIQUE (id, org_id)
);
```

```sql
CREATE INDEX approval_template_group_backfill_batches_org_created_idx
  ON approval_template_group_backfill_batches (org_id, created_at DESC);
```

**【§13 changesRequired #5,本步(续做步骤 5)落地】** changesRequired #5 原文「新增 `GET …/backfill/batches` + 索引」——上面 `CREATE TABLE` 原文没有索引,补一条 `(org_id, created_at DESC)` 支持"按 org 取最近批次,分页"这个访问形状;端点本身见 §6.1 新增行。`rolled_back_at` 不需要单独索引(列表端点返回全部批次,`rolledBackAt` 是否为空由客户端渲染,不是过滤谓词)。

- 与 `approval_template_groups`/`_links` 同款「组织内容非空」CHECK,复用同一字符类正则 `'[!-~]'`(先例 `zzzz20260715210000_create_approval_attachments.ts:24`,A-1 已引用)。
- **不设**「执行中」状态列——execute 是单事务,要么全成功要么全回滚(见 §3),不存在"进行中"的可观测中间态。**【§13 changesRequired #14 / P2-3,已求值】收窄:上一句只对 DB 行成立,改读「无 DB 行级中间态」——对操作者(请求超时/连接断开后无法区分「已提交」与「已回滚」)不成立,该缺口由 §13 changesRequired #5 的批次列表端点(`GET …/backfill/batches`)接住,不在这里现场改写批次头 DDL。**
- `rolled_back_at` 只由 rollback 写一次;是否允许对已回滚批次再次 rollback(幂等 vs 409)见 §4.4(实现者裁量,列入门审核对项)。

### 2.2 `approval_template_group_backfill_batch_groups`(本批次触达的每个分组,标注是新建还是挂到已有组)

```sql
CREATE TABLE approval_template_group_backfill_batch_groups (
  batch_id     text NOT NULL,
  org_id       text NOT NULL,
  group_id     text NOT NULL,
  created_new  boolean NOT NULL,   -- true = 本批次新建该组;false = 挂到了已存在的同名活跃组
  PRIMARY KEY (batch_id, group_id),
  CONSTRAINT atgbbg_batch_fk FOREIGN KEY (batch_id, org_id)
    REFERENCES approval_template_group_backfill_batches (id, org_id)
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT atgbbg_group_fk FOREIGN KEY (org_id, group_id)
    REFERENCES approval_template_groups (org_id, id)
    ON DELETE NO ACTION ON UPDATE NO ACTION   -- 与 A-1 的 atgl_group_fk 同款:归档不是删除,不需要 CASCADE/SET NULL
);
```

- `created_new = false` 的行是 rollback 精确性的**关键读**:§4 的规则是「rollback 只归档 `created_new = true` 的组,且仅当归档后该组零剩余成员」——挂到已有组的行永远不归档(那个组本就不是这个批次的产物)。

### 2.3 `approval_template_group_backfill_batch_links`(本批次写过的每个模板挂接,带乐观回滚令牌)

```sql
CREATE TABLE approval_template_group_backfill_batch_links (
  batch_id    text NOT NULL,
  org_id      text NOT NULL,
  template_id uuid NOT NULL,
  group_id    text NOT NULL,        -- 本批次把它挂到的目标组(与 batch_groups 的 group_id 对应)
  linked_at   timestamptz NOT NULL, -- upsert RETURNING 的 linked_at——rollback 的乐观并发令牌,见 §4
  PRIMARY KEY (batch_id, template_id),
  CONSTRAINT atgbbl_batch_fk FOREIGN KEY (batch_id, org_id)
    REFERENCES approval_template_group_backfill_batches (id, org_id)
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT atgbbl_link_fk FOREIGN KEY (org_id, template_id)
    REFERENCES approval_template_group_links (org_id, template_id)
    ON DELETE NO ACTION ON UPDATE NO ACTION
  -- FK 引用的是 links 表的 PK;该行此后被解除/重新挂接只更新 group_id/unlinked_at,
  -- (org_id, template_id) 这两个 PK 列永不变,所以此 FK 在 links 行状态变化后依然有效——
  -- 不会出现「rollback 记录指向一行已被删除的 link」的悬空引用(links 表从不硬删,I2′)。
);
```

**【§13 changesRequired #4,方向翻转,门审实测 M6,不是精修】上面 `atgbbl_link_fk` 的 `ON DELETE NO ACTION` 与其注释均已被证伪:锁 `:111` 明写 `approval_templates → approval_template_group_links` 的 `ON DELETE CASCADE` 是必需的(「10+ 个集成测试 teardown 会硬删模板」),链路是 `approval_templates --CASCADE--> approval_template_group_links --?--> approval_template_group_backfill_batch_links`。「links 表从不硬删」这句注释说的是 links 表*自身*的行不会被 `DELETE FROM approval_template_group_links` 硬删,但它没有回答「引用 links 的模板被硬删时,CASCADE 链传到 links 之后,batch_links 这层 NO ACTION 会不会把整条链卡死」——实测卡死(`ERROR: … violates foreign key constraint "atgbbl_link_fk"`,复现 SQL 见门审报告 §2 Q5)。落地:`atgbbl_link_fk` 改为 `ON DELETE CASCADE`;`atgbbl_batch_fk`(本表→批次头)维持提案原值 `CASCADE`,`atgbbg_group_fk`(batch_groups→groups)维持提案原值 `NO ACTION`,均不变(见 §13 Q5 表)。**

`down()` 镜像:先删两张子表,再删批次头表(子表持有指向头表的 FK)。

## 3. execute:算法与 §3.0 的关键设计决策(嵌套事务死锁)

### 3.0 为什么不能直接「调用」`createApprovalTemplateGroup` / `linkApprovalTemplateToGroup`

`ApprovalTemplateGroupService.ts` 的每个导出写函数都各自开一次 `transaction(handler)`(`db/pg.ts:22-25`),而 `transaction()` 的实现(`integration/db/connection-pool.ts:174-175`)是 `const rawClient = await this.pool.connect()`——**每次调用都从连接池另拿一条全新连接**。如果 execute 自己也开一个 `transaction(...)`,在其回调里再去 `await createApprovalTemplateGroup(...)`,内层函数会在**另一条连接**上重新 `BEGIN` 并尝试获取同一把 `pg_advisory_xact_lock('atg:' + orgId)`——但外层事务的连接已经持有这把锁且尚未提交(它在等内层调用的 Promise resolve),内层在等外层释放锁,外层在等内层完成:**同一会话内跨连接的确定性死锁**,不是理论风险,是这个具体调用形状必然发生的结果(参见记忆 `feedback_lock_taking_port_needs_lock_order_census`,#4899 的同类死锁)。

**决策**:把 `createApprovalTemplateGroup`/`linkApprovalTemplateToGroup`/`archiveApprovalTemplateGroup` 的函数体各自拆成一个「吃 `client` 参数」的内部版本(`createApprovalTemplateGroupWithClient(client, orgId, name, createdBy)` 等),现有的导出函数改成薄封装:`transaction(client => createApprovalTemplateGroupWithClient(client, orgId, name, createdBy))`——**语句、顺序、错误映射逐字不变**,只是把"开事务"这一层从函数体里提出去。execute/rollback 直接调用 `...WithClient` 版本,在**同一个** `transaction(...)` 回调、同一条连接上组合多次调用。这仍然是「§2/§3 的既有原语」——SQL 语句一字不改——不是「第二套写路径」;变的只是「谁负责开事务」这一层,和"改名"函数今天已经把 SET/L0/L1/UPDATE 四个语句内联在同一个 `transaction` 回调里是同一种粒度。

**回归验证义务(写入验证 MD,不是本步工作但必须记入 §6)**:这个重构改的是 A-1 已经过门审、已进 `#5852` 的文件——即使 SQL 逐字不变,门审报告 `#5852` 的 mutation 台账是针对**改重构前**的函数体写的,重构后必须把 A-1 两个 `.db.test.ts`(`approval-template-groups-lifecycle.db.test.ts`/`approval-template-groups-serialization.db.test.ts`)在 `metasheet2_lock_a3` 上原样重跑一遍,证明零行为变化,而不是假定"只是把代码挪了个位置"就自动安全。

### 3.1 execute 算法(单个 `transaction(...)` 回调,`client` 全程同一条连接)

**【§13 changesRequired #1,本步(续做步骤 5)按 §13.2 统一锁序整段改写;下方代码块取代改写前的"逐类目循环回头取 L1"版本,旧版本见本文件 git 历史(commit 027a1f9cd 及以前)】**

```
BEGIN
SET TRANSACTION ISOLATION LEVEL READ COMMITTED          -- 必须是第一条语句,同 A-1 §2;W8 落地为
                                                          -- beginApprovalTemplateGroupTxn(client) 返回
                                                          -- 品牌类型 AtgTxClient(§13.2 changesRequired #10)
SELECT pg_advisory_xact_lock(hashtext('atg:' || org))    -- L0,与手工建组/归档/改名/解档竞争同一把锁

eligible ← SELECT id, category FROM approval_templates t
             WHERE btrim(category) ~ '[!-~]'              -- 【§13 changesRequired #3,已求值,取代原谓词】
               AND NOT EXISTS (
                 SELECT 1 FROM approval_template_group_links l
                  WHERE l.org_id = $org AND l.template_id = t.id
               )                                          -- 与 I2′ 判定谓词逐字相同(见 §5.1)
               AND <applyTemplateVisibilityFilter 的析取条件>
-- 【§13 changesRequired #3,已求值】原谓词 `category IS NOT NULL AND category <> ''` 已被单条谓词
-- `btrim(category) ~ '[!-~]'` 取代(不并列 `<> ''`——后者被前者蕴含,并列会让实现者分不清哪条承重)。
-- 该谓词必须留在 `eligible` 查询内部,不得实现成循环体内的 `continue`:门审机制原文——「不合格模板
-- 永远满足 NOT EXISTS(...)、eligible 恒不为空,IF eligible 为空 ⇒ batchId: null 永不命中,纯中文
-- org 每调一次 execute 就多一行空批次头,「两次顺序 execute 四张表零变化」的幂等验收直接红」。
-- 不满足该谓词的行进 preview 的 skipped 桶(带 reason),execute 跳过而非抛错炸整事务(见 §13 O2)。

IF eligible 为空:
  COMMIT                                                  -- 空事务,零行写入,不建批次头
  RETURN { batchId: null, groups: [], scope }             -- 幂等的"第二次零变化"由这里保证;
                                                           -- scope 见 §5.2(changesRequired #16,本步落地)

-- 【§13 changesRequired #12,本步落地】规模上界:默认 500(硬编码常量,非配置项——本切片不提供规模-
-- 耗时曲线,门审给的是"二选一",本文档选前者)。超出即中止,零行写入,不建批次头,不做部分执行。
IF count(eligible) > 500:
  ROLLBACK
  抛 APPROVAL_TEMPLATE_GROUP_BACKFILL_TOO_LARGE (400)     -- §7 已补码

categories ← eligible.category 去重,按字典序排序               -- 决定性排序,便于测试断言;
                                                                -- 不是锁序承重来源(锁序由下面的
                                                                -- ORDER BY id 承担,与遍历顺序无关)
existingByCategory ← SELECT id, name FROM approval_template_groups
                       WHERE org_id = $org AND name = ANY($categories)
                         AND archived_at IS NULL
                       -- 只读,不取锁;在 L0 之内该读稳定——任何会修改这些行的其它事务此刻都在
                       -- pg_advisory_xact_lock 上等同一把 org 级锁,不存在读后失效的窗口
existingIds ← existingByCategory 的全部 id

IF existingIds 非空:
  SELECT id FROM approval_template_groups                  -- 【§13.2 逐字保留的统一锁序,原文见该节,
   WHERE org_id = $org AND id = ANY($existingIds)           -- 本处是其落地,不是转述】L0 之后、任何
   ORDER BY id FOR UPDATE                                   -- L2 写之前,一条语句按确定性行序预锁
                                                             -- 本次要触达的全部既有组行

batchId ← newBatchId()
INSERT INTO approval_template_group_backfill_batches (id, org_id, created_by) VALUES (...)

FOR EACH category IN categories:                            -- 顺序不再是锁序承重来源:既有组已在
                                                              -- 上一步预锁完毕,这里不存在"取过某组
                                                              -- 的 L2 后回头对下一个组取 L1"的旧路径
  IF category IN existingByCategory:
    groupId ← existingByCategory[category].id; createdNew ← false   -- 行锁已在预锁步骤持有
  ELSE:
    -- 内联 createApprovalTemplateGroupWithClient 的语句体(MAX+1 → INSERT)——新行,无 L1 争用
    groupId ← 新建组; createdNew ← true
  INSERT INTO approval_template_group_backfill_batch_groups (batch_id, org_id, group_id, created_new)
    VALUES ($batchId, $org, $groupId, $createdNew)

  FOR EACH template IN eligible WHERE category = 该 category:
    -- 内联 linkApprovalTemplateToGroupWithClient 的语句体,写入改用数据修改 CTE(§4.2 changesRequired #2
    -- 落地 SQL 的写入侧对偶——令牌全程不经 JS,回滚时才不会在 §4.2 撞上精度损失):
    -- WITH upserted AS (
    --   INSERT INTO approval_template_group_links (org_id, template_id, group_id, linked_at, unlinked_at)
    --     VALUES ($org, $template.id, $groupId, now(), NULL)
    --   ON CONFLICT (org_id, template_id) DO UPDATE
    --     SET group_id = EXCLUDED.group_id, linked_at = now(), unlinked_at = NULL
    --   RETURNING template_id, group_id, linked_at
    -- )
    -- INSERT INTO approval_template_group_backfill_batch_links (batch_id, org_id, template_id, group_id, linked_at)
    --   SELECT $batchId, $org, template_id, group_id, linked_at FROM upserted

COMMIT
RETURN { batchId, groups: [...], scope }                   -- scope 见 §5.2
```

**catch 分支**:任何一步抛错(包括 `mapGroupConstraintError` 映射出的 `GROUP_NAME_TAKEN`/`GROUP_SORT_CONFLICT`)⇒ 整个 `transaction()` 自动 ROLLBACK(`connection-pool.ts:199-203`),零行写入——这与"重名走 GROUP_NAME_TAKEN 语义"的字面矛盾需要澄清:**正常路径下不会撞见 `GROUP_NAME_TAKEN`**,因为"先查后建"发生在同一把 L0 锁之内,不存在竞态窗口(见下条);它只在 L0 本身失守(实现 bug)时才会被 `mapGroupConstraintError` 兜底,而不是设计出的正常分支。**【§13 changesRequired #11 前半,已求值】** 这句"整个 `transaction()` 自动 ROLLBACK"描述的正是要求的代码形状——`mapGroupConstraintError` 的 catch 写在 `await transaction(cb)` 这次调用**外面**(`try { const r = await transaction(cb) } catch (e) { throw mapGroupConstraintError(e) }`),不是在回调内部逐条语句套 catch:`atg_sort_unique` 是 `DEFERRABLE INITIALLY DEFERRED`,真重复要等 COMMIT 才报 23505,回调内部任何一条语句上的 try/catch 都看不到它,只有包在整次 `transaction()` 调用外面的 catch 能接住 COMMIT 阶段抛出的错误。后半(§7 错误码表补 `GROUP_SORT_CONFLICT` 行)已在 §7 落地。

**【§13 changesRequired #1,已求值,实测 M2 —— 本步(续做步骤 5)已按此改写上方代码块,不再是"待 W8 落地对象"】** 旧版本的逐类目循环(L1→L2→L1,在取过某组的 L2 之后回头对下一个组取 L1)与 A-1 挂接路径(L1→L2,不取 L0)确定性死锁,牺牲者是同时段任何普通挂接请求且拿到未映射的通用 500——不是纸面推理,是门审会话真库实测(`reviews/a3-probe/execute-lockorder-probe.cjs`)。上方代码块已经是落地后的版本:L0 之后、任何 L2 写之前,一条语句按确定性行序预锁本次要触达的全部既有组行;预锁之后 `linkApprovalTemplateToGroupWithClient` 内部的 `FOR UPDATE`(若组合调用时仍保留该语句)退化为对本事务已持有行锁的再取,不新增取锁顺序。**代码化仍待 W8**——本节交付的是 pseudocode 级别的落地,不是 `.ts` 实现;W8 的真库测试须覆盖组合调用路径(见 §9 changesRequired #13 三条判别力测试)。

### 3.2 并发语义(E 的姊妹判据,复用同一 L0)

两个并发 execute(同一 org)⇒ 后到者在 `pg_advisory_xact_lock` 上停车(与 A-1 验收 E 用的 `waitUntilBackendBlockedByHolder` 同一停车点、同一 helper);先提交者已经把所有符合条件的模板挂接完毕,后到者拿到锁后重新执行 `eligible` 查询,此时符合条件的模板已经清零(每个都命中了 `NOT EXISTS` 的反面)⇒ 后到者是空事务、返回 `batchId: null`——**并发 execute 与"两次顺序 execute 幂等"是同一段代码路径产生的同一个观察结果**,不需要额外的并发专用分支。

手工建组请求与 execute 并发:也在同一把 L0 上互斥;谁先提交谁的效果先生效,不存在需要额外处理的交叉状态。

## 4. rollback:精确到批次的算法与前提条件

### 4.1 为什么不能直接调用 `unlinkApprovalTemplateFromGroup` / `archiveApprovalTemplateGroup`

- `unlinkApprovalTemplateFromGroup(orgId, templateId)`(A-1,`:391-400`)是**无条件**解除——只要当前 `group_id IS NOT NULL` 就清空。如果这个模板在 execute 之后被**另一次操作**(手工挂接、另一个后续批次)改挂到了别的组,rollback 若无条件调用它,会把"批次外发生的新挂接"也解除掉——**这正是任务书要求的 mutation 判据「rollback 影响批次外行 ⇒ 红」的靶子**。
- `archiveApprovalTemplateGroup(orgId, groupId)`(A-1,`:241-278`)在归档时会**无条件解除该组当前的全部成员**(`UPDATE … SET group_id = NULL … WHERE org_id = $1 AND group_id = $2`,不区分是不是本批次挂上去的)。如果这个批次新建的组,在 execute 之后被**另一个人**手工挂了一个不相关的模板进来,rollback 若直接调用这个函数归档该组,会把那个不相关模板也解除——同一个 mutation 判据的另一半。

**决策**:rollback 不调用这两个导出函数,而是内联同样的语句,但**加两层精确性前置条件**(见 §4.2/§4.3)。这仍然是「解除是独立 UPDATE」「归档是事务」这两条既有原语的**语句**复用,只是补上了"只对本批次仍然原样成立的那部分状态生效"这个额外 WHERE 谓词/前置检查——不是发明新的写路径形状。

**【§13 changesRequired #1,本步(续做步骤 5)补齐——rollback 的整体事务骨架】** 原文只分别给了 §4.2(链接回滚)与 §4.3(分组归档)两段独立代码块,没有写出把它们装进同一个事务、同一把锁序里的骨架,这正是 M3 死锁实测打中的缺口。骨架:

```
BEGIN
SET TRANSACTION ISOLATION LEVEL READ COMMITTED    -- 同 §3.1;W9 落地为 beginApprovalTemplateGroupTxn(client)
SELECT pg_advisory_xact_lock(hashtext('atg:' || org))   -- L0,与手工建组/归档/execute 竞争同一把锁

batch ← SELECT rolled_back_at FROM approval_template_group_backfill_batches
          WHERE id = $batchId AND org_id = $org FOR UPDATE
IF batch 不存在: ROLLBACK; 抛 APPROVAL_TEMPLATE_GROUP_BACKFILL_BATCH_NOT_FOUND (404)
IF batch.rolled_back_at IS NOT NULL: ROLLBACK; 抛 APPROVAL_TEMPLATE_GROUP_BACKFILL_BATCH_ALREADY_ROLLED_BACK (409,带 rolledBackAt——changesRequired #7)

targetGroupIds ← (SELECT DISTINCT group_id FROM approval_template_group_backfill_batch_links WHERE batch_id = $batchId)
                  UNION
                  (SELECT group_id FROM approval_template_group_backfill_batch_groups WHERE batch_id = $batchId)
                  -- 只读,不取锁;§13.2 定义的 rollback 锁序里的"$2"

IF targetGroupIds 非空:
  SELECT id, archived_at FROM approval_template_groups   -- 【§13.2 逐字保留的统一锁序,本处落地,不是转述】
   WHERE org_id = $org AND id = ANY($targetGroupIds)      -- L0 之后、任何 L2 写之前,一条语句按
   ORDER BY id FOR UPDATE                                 -- 确定性行序预锁全部既有组行,结果集保留供
                                                           -- §4.3 复用(不再对单行发第二次 FOR UPDATE)

-- 此刻执行 §4.2 的集合式 UPDATE(L2 写,见下方该节代码块)
-- 然后执行 §4.3 的 remaining 计算与归档(见下方该节代码块;顺序要求见 §4.3 落地段——
-- remaining 必须在 §4.2 之后算,与本骨架的先后关系不冲突:两者都排在"预锁"之后)

UPDATE approval_template_group_backfill_batches SET rolled_back_at = now()
  WHERE id = $batchId AND org_id = $org
COMMIT
RETURN { rolledBackAt: <刚写入的时间戳> }
```

批次头的 `FOR UPDATE`(锁 `approval_template_group_backfill_batches` 一行)与预锁既有组的 `ORDER BY id FOR UPDATE`(锁 `approval_template_groups` 多行)是两张不同表上的行锁,不构成同一张表内的锁序问题;`approval_template_group_backfill_batches` 只有 rollback 会 `FOR UPDATE` 它(execute 只 INSERT 新批次头行,不碰已有行),不参与 §13.2 针对 `approval_template_groups` 的 L1 竞争分析。

### 4.2 链接回滚:乐观令牌精确匹配

```sql
UPDATE approval_template_group_links
   SET group_id = NULL, unlinked_at = now()
 WHERE org_id = $org AND template_id = $templateId
   AND group_id = $recordedGroupId       -- 批次记录的目标组
   AND linked_at = $recordedLinkedAt     -- 批次记录的 upsert RETURNING 值(乐观并发令牌)
```

对 `approval_template_group_backfill_batch_links` 里的每一行执行上述 UPDATE。`rowCount = 0` 表示这一行自 execute 之后已经被别的操作改动过(重新挂接到别的组、或又被解除又被再挂接——任何一种都会让 `linked_at` 更新)——**这不是错误,是"跳过,不动它"**,精确对应"不动批次外的数据"。`rowCount = 1` 表示状态自 execute 起未变,安全解除。

**已知残留(披露,非漏判)——【§13 changesRequired #2,已求值,实测 M4,本段第一句"需要构造罕见序列才触发"是错标】**:上一版把这条残留描述成"需要构造同一事务内解除又挂接的罕见序列才触发"——**实测证伪**:`approval_template_group_links.linked_at` 是 `timestamptz`(微秒精度),node-postgres 把它解析成 JS `Date`(毫秒精度,`mapLinkRow` 的 `toIso()` 更是 `toISOString()` 截到毫秒);§3.1 把"upsert RETURNING 的 `linked_at`"经 JS 写进批次表、本节再拿它做 `AND linked_at = $recordedLinkedAt`,精度损失**每一次都发生,不需要任何并发或罕见调用序列**——实测带 JS 令牌的 UPDATE `rowCount: 0`,带精确文本的对照 UPDATE `rowCount: 1`。而本节把 `rowCount = 0` 定义成「跳过,不是错误」⇒ **rollback 在本修法前 100% 静默空转**:返回 200、空结果集,长得和"确实没有可撤销的行"一模一样。

**落地(令牌全程不得经过 JS,详见 §13 changesRequired #2 的成品 SQL)**:写入改用数据修改 CTE(`WITH upserted AS (INSERT … ON CONFLICT … RETURNING template_id, group_id, linked_at) INSERT INTO …_batch_links SELECT $batch, $org, template_id, group_id, linked_at FROM upserted`),回滚改用集合式服务端 join(见下方 §4.2 落地 SQL),两者都不让 `linked_at` 经过一次 JS 往返。**修法后仍然保留的残留**(不在本切片修复范围,时间戳不是版本号,彻底修法需要给 links 表加版本列,是改锁 §2 ratify 形状的范围变更):同一事务内"解除又重新挂接回同一个组"导致新旧 `linked_at` 巧合相等的窗口。

```sql
-- §4.2 落地:集合式服务端 join,取代逐行 N+1(§13 changesRequired #2)
UPDATE approval_template_group_links l
   SET group_id = NULL, unlinked_at = now()
  FROM approval_template_group_backfill_batch_links b
 WHERE b.batch_id = $1 AND b.org_id = l.org_id AND b.template_id = l.template_id
   AND l.group_id = b.group_id AND l.linked_at = b.linked_at
```

### 4.3 分组回滚:仅归档"批次新建 且 回滚后零剩余成员"的组

**【§13 changesRequired #1,本步(续做步骤 5)按 §13.2 统一锁序改写:下方 `locked` 不再对单行发第二次 `FOR UPDATE`,而是复用上方骨架预锁步骤已经读回的快照】**

```
FOR EACH (groupId, createdNew) IN batch_groups WHERE batch_id = $batchId:
  IF NOT createdNew: CONTINUE                      -- 挂到已有组的,从不归档
  locked ← 上方骨架"预锁既有组"步骤已经读回的该 groupId 行(archived_at)——行锁已在那一步
           取得,这里不再发第二次 `FOR UPDATE`,避免"先做链接回滚(L2)再对组取 FOR UPDATE(L1)"
           这个 M3 实测出的 L2→L1 死锁写法
  IF locked 为空 OR locked.archived_at IS NOT NULL: CONTINUE   -- 组已不存在或已被归档(如被手工归档过),跳过不报错
  remaining ← SELECT count(*) FROM approval_template_group_links
                WHERE org_id = $org AND group_id = $groupId AND unlinked_at IS NULL
  IF remaining = 0:
    -- 与 archiveApprovalTemplateGroup 逐字相同的两条语句。第一条此时必然影响 0 行——不是因为它的
    -- WHERE 谓词恰好只匹配 remaining 数出的那个集合,而是因为 atgl_state_check(A-1 DDL:
    -- `CHECK ((group_id IS NULL) = (unlinked_at IS NOT NULL))`)保证「group_id = $groupId」与
    -- 「group_id = $groupId AND unlinked_at IS NULL」这两个集合恒等——任何 group_id 非空的行,
    -- 这条 CHECK 就已经把它的 unlinked_at 钉成 NULL,不存在「group_id = $groupId 但 unlinked_at
    -- 非空」的行。remaining=0 因此意味着「group_id = $groupId」这个更宽的谓词也是 0 行,两个谓词
    -- 字面不同但外延相同,不是巧合,是这条 CHECK 承重。仍然执行这条语句是为了与既有归档路径的语句
    -- 形状保持逐字一致,不是可省略的多余步骤。
    UPDATE approval_template_group_links SET group_id = NULL, unlinked_at = now()
      WHERE org_id = $org AND group_id = $groupId
    UPDATE approval_template_groups SET archived_at = now(), sort_order = NULL, updated_at = now()
      WHERE org_id = $org AND id = $groupId
  -- ELSE: remaining > 0 ⇒ 该组在 execute 之后被别人加了新成员,保留该组不归档
```

`remaining` 的计算必须在 §4.2 的链接回滚**之后**执行(本批次自己的链接已经被解除,不会污染这个计数)——算法顺序是"先把本批次的链接回滚完,再看每个本批次新建的组是否还有剩余成员"。

**【§13 changesRequired #1,已求值,实测 M3】上面「先做链接回滚(L2)再对组取 FOR UPDATE(L1)」字面就是 L2→L1,与同一条挂接路径(L1→L2)确定性死锁**(`reviews/a3-probe/rollback-lockorder-probe.cjs`,牺牲者同样是普通挂接请求,不是 rollback 自己)。落地(与 §3.1 execute 同一条要求,不得只修一边):在 L0 之后、任何 L2 写之前,先用一条语句按 `id` 升序预锁本批次触达的全部既有组行(`$2 = SELECT DISTINCT group_id FROM batch_links WHERE batch_id=$1 UNION SELECT group_id FROM batch_groups WHERE batch_id=$1`),再做 §4.2 的 L2 写与本节的归档,恢复 L0→L1→L2 非降序。此条为 W9 实现单元的落地对象,本步不改写 pseudocode 本体,只记入求值。

### 4.4 待门审裁量的两点(实现者初步倾向,非最终)——**【§13 §2 Q4/Q5,已裁,不再是"待门审"】**

1. ~~对已回滚批次再次调用 rollback:倾向做成幂等 200~~ **【§13 changesRequired #7,已裁】改为 409 + 专用码(`APPROVAL_TEMPLATE_GROUP_BACKFILL_BATCH_ALREADY_ROLLED_BACK`),响应体带 `rolledBackAt`。理由(门审 Q4):H 的幂等成立是因为两条腿目标终态相同("模板未分组"),而 rollback #1 与 #2 之间管理员可能已重新建组/挂接,"什么都没撤销"不是"已经撤销过了"的同义词;200 空体会让"批次早已回滚"与"精确性前置条件恰好对每一行都不成立"逐字节同形(记忆 `finding_attendance_denied_renders_as_all_clear` 同形)。409 的反论(重试分不清成功与否)已被响应体的 `rolledBackAt` 化解。**
2. ~~外键选择 ON DELETE CASCADE 让子表跟随批次头删除~~ **【§13 changesRequired #4 / Q5,已裁】维持 CASCADE**(`atgbbg_batch_fk`/`atgbbl_batch_fk`,子表→批次头):批次头今天没有硬删路径,CASCADE 是防御性的死代码路径但零行为影响,改 `NO ACTION` 没有收益。**注意本条只覆盖"子表→批次头"这一对 FK**,与 §2.3 `atgbbl_link_fk`(batch_links→links)是另一条 FK、已按 §13 changesRequired #4 反向裁定为必须改 `CASCADE`(实测 M6,见 §2.3 现场标注),两条 FK 不要混为一谈。

## 5. preview:候选人口与响应形状

### 5.1 候选人口谓词(与 I2′ 判定谓词逐字相同,不是重新发明)

> `NOT EXISTS (SELECT 1 FROM approval_template_group_links WHERE org_id = $org AND template_id = $tpl)`

这正是锁文 I2′ 定义"该组织从未建立过关联"的谓词(`approval-form-group-entity-design-lock-draft-20260916.md:141-142`),也是验收 D 判定 category 后备是否生效的同一个谓词。选它作为 backfill 的候选人口边界,直接继承了 I2′/D 已经锁定的语义:**只处理"从未被这个 org 关联过"的模板**——已经被手工挂接过、或已经被显式解除过(`group_id IS NULL` 但曾经存在关联行)的模板,都不会被 backfill 碰到,这正是锁文 §5「明确不做:自动回填(只给显式管理员操作)」与本切片"仍然不做静默的自动回填,只在管理员主动点击 execute 时才写"两者的边界重合点——backfill 本身是显式操作,但它的候选范围被 I2′ 的既有语义天然限定为"真正从未处理过的模板",不会覆盖任何人已经做过的归组决定(不论是通过分组还是通过显式解除)。

### 5.2 响应形状(实现者提案,未 ratify)

```jsonc
GET /api/approval-template-groups/backfill/preview →
{
  "scope": "org-complete",        // "org-complete" | "visible-to-you" —— 【§13 changesRequired #16,
                                   // 本步落地】见 §6.2 现场标注:过 approvalTemplateAdminGuard 的主体
                                   // 与 isTemplateManager 人口互不包含,不是前者包含后者(唯一端到端
                                   // 实测成立的「过 guard 但非 manager」反例是 DB 侧 isAdmin(userId)
                                   // 一条腿——通配权限码单独过 guard 已被 phase1 第 2/4 轮各真库证伪,
                                   // 不是第二条成立的腿,2026-09-18 rebase 后订正)——eligible 查询仍然套用
                                   // applyTemplateVisibilityFilter,对非 manager 主体这会**收窄**候选
                                   // 模板集合。该字段如实标注:actor 的可见性判定若等价于"org 全量可见"
                                   // (即 applyTemplateVisibilityFilter 对该 actor 是恒真析取项)则为
                                   // "org-complete";否则为"visible-to-you",提醒调用方这份 buckets
                                   // 不是 org 的完整候选清单。计算不新造判定——直接复用
                                   // resolveApprovalTemplateVisibilityActor 已经解析出的 actor 种类。
  "candidateCount": 3,             // 【§13 changesRequired #12(P2-2 cap 分支),续做步骤 21 落地】
                                   // 每个非 skip 桶 templateCount 之和——execute 的 eligible 查询会
                                   // 用同一条谓词(changesRequired #3)处理的确切数量,不是第二条独立
                                   // 查询,不会与 buckets 各自的 templateCount 相加结果分岔;调用方
                                   // 用它对照 APPROVAL_TEMPLATE_GROUP_BACKFILL_MAX_CANDIDATES(500)
                                   // 判断是否要先收窄再点 execute。
  "buckets": [
    {
      "category": "HR",
      "action": "attach",          // "create" | "attach"
      "existingGroupId": "atg_...",// action="attach" 时非空;action="create" 时为 null
      "templateIds": ["...", "..."],
      "templateCount": 2
    }
  ],
  "skipped": [                     // 【§13 changesRequired #3 后半,本步(续做步骤 5)补齐——见 advisor
                                    // 复核:§3.1 pseudocode 注释、§8 item 2、O2 三处已经承诺"进 preview
                                    // 的 skipped 桶(带 reason)",本响应形状此前未把这个承诺写成字段】
    {
      "category": "请假",          // 原始 category 值(未 trim,便于管理员核对哪一行没被处理)
      "reason": "CATEGORY_NOT_STORABLE_AS_GROUP_NAME", // 枚举 reason 码,不是自由文本(记忆
                                    // feedback_exemption_reasons_rot_make_them_data:豁免理由要是数据,
                                    // 不是散文)——两个已知值:
                                    // "CATEGORY_BLANK_AFTER_TRIM"(btrim(category) = ''——锁 §4 D
                                    //   谓词本身漏掉的纯空白遗留形态,§8 item 2 已裁);
                                    // "CATEGORY_NOT_STORABLE_AS_GROUP_NAME"(btrim(category) 非空但不
                                    //   匹配 '[!-~]'——今天等价于"纯非 ASCII 可打印字符",例如纯中文
                                    //   category;O2 待 owner ratify `atg_name_nonblank` 勘误前的诚实
                                    //   披露落在这里,勘误后此原因值集合会变窄但字段本身不变)
      "templateIds": ["...", "..."],
      "templateCount": 3
    }
  ]
}
```

`skipped` 与 `buckets` 的并集加上"已挂接、被 `NOT EXISTS` 排除"的模板,才等于该 actor 可见的全部模板——`skipped` 存在的意义是让管理员能回答"这条 category 是没有模板还是被排除了",呼应记忆 `finding_attendance_denied_renders_as_all_clear`(空态必须能区分"零条"与"没查成"/这里是"被排除")。execute 侧对同一批 `skipped` category **跳过而非抛错**(§3.1 已落地),两侧共用同一条谓词与同一个只读判定函数(见下段)。

`action` 由"§org 内是否已存在同名活跃组"预先判定——与 execute 内部的判定逻辑必须是**同一条 SQL**(否则 preview 展示的结果可能与 execute 实际发生的不一致);因此建议把"给定 org + category 列表,判定 create/attach"抽成一个只读小函数,preview 和 execute 都调用它,唯一区别是 execute 在 L0 锁内调用、preview 在锁外调用(preview 本身不修改状态,不需要锁;但这意味着 **preview 展示的"将建/将挂接"是快照,不是承诺**——如果 preview 之后、execute 之前发生了并发的手工建组,execute 时看到的"是否已存在同名组"可能与 preview 展示的不同。这是"预览"语义的正常边界,不是缺陷,写清楚防止门审误判为竞态漏洞)。**【§13 P3-3,本步(续做步骤 5)落地】** 门审采纳这个抽取建议并追加一条:该函数必须**同时**返回 `skipped` 判定(即上方 `skipped` 桶的成员资格 + `reason`),不能只返回 create/attach 二选一——否则 preview 与 execute 对"哪些 category 被跳过"仍会各自判断一次而分叉,重蹈 §5.2 一开始就要避免的"两者不是同一条 SQL"问题。函数签名建议:`classifyBackfillCategory(org, category, existingGroupsByName) → { action: 'create'|'attach'|'skip', existingGroupId?, reason? }`。

## 6. 端点、guard 与一处需要门审/owner 裁决的授权面冲突

### 6.1 端点(实现者命名提案)

| 方法 + 路径 | 语义 | guard(任务书原文指定) |
|---|---|---|
| `GET /api/approval-template-groups/backfill/preview` | §3.1 的只读候选查询 | `approvalTemplateAdminGuard`(任务书原文) |
| `POST /api/approval-template-groups/backfill/execute` | §3 execute | `approvalTemplateAdminGuard` |
| `POST /api/approval-template-groups/backfill/batches/:batchId/rollback` | §4 rollback | `approvalTemplateAdminGuard` |
| `GET /api/approval-template-groups/backfill/batches` | 批次列表(分页,含 `rolledBackAt`)——**【§13 changesRequired #5,本步落地】** 供管理员核对"哪些批次已回滚"而不必逐个猜 batchId;分页参数与响应形状照 A-1 既有列表端点惯例(游标或 limit/offset,待实现阶段与 A-1 对齐,不在本提案新造分页协议) | `approvalTemplateAdminGuard`(与其余三个端点同一 guard,同 §6.2 现场标注的三条实证理由——它暴露的是"哪些写计划已生效/已撤销",与 preview 同属"写操作的伴随读") |

### 6.2 授权面冲突(必须在实现前解决,列为本提案的第一个待裁决项)

任务书原文三个端点全部点名 `approvalTemplateAdminGuard`,**包括只读的 preview**。但 A-1 已落地的 I7 原文(锁文 §3,ratified)是:

> **I7 授权面与挂载点**:……读端点挂 `rbacGuard('approvals:read')`(同 `:531`)。**不由实现者现场裁量。**

I7 是锁文 §3 不变量、属于抬头 RATIFY 记录里"已 ratify"的第 2 项(§2/§3 逐条),preview 是一个新增的只读端点——字面落在 I7 的"读端点"定义里。这与任务书原文对 A-3 preview 指定 `approvalTemplateAdminGuard` 直接冲突:

- **若按 I7 字面执行**:preview 应挂 `rbacGuard('approvals:read')`,execute/rollback(写端点)挂 `approvalTemplateAdminGuard`——这与 A-1 已落地的七个端点的 guard 分配规则完全一致(读 `approvals:read`,写 `approvalTemplateAdminGuard`)。
- **若按任务书原文执行**:preview 也挂 `approvalTemplateAdminGuard`——比 I7 字面要求的更严格(把"谁能看候选清单"限缩到"谁能执行写"的同一批人),**不违反"零信任放宽"的方向**(不是把写权限的守卫削弱成读权限,而是反过来,读端点被收紧到写权限的门槛),但仍然是对 I7"不由实现者现场裁量"这句话的字面偏离——I7 定义的是**这个端点属于哪一类(读/写)对应哪个 guard**,backfill 预览在语义上是"regular 读"还是"因为暴露的是尚未发生的写计划,值得按写权限收紧"是一个需要裁决的问题,不是实现者可以自行决定的。

**本提案倾向**:preview 挂 `approvalTemplateAdminGuard`(遵任务书原文,收紧不放宽,风险方向安全),但在 Draft PR 里逐字披露这条偏离 I7 字面表述的理由,供门审/owner 核实是否需要改回 `rbacGuard('approvals:read')`。**不会**采用"两者都不占"的第三种做法。

**【§13 changesRequired #8 / Q2,已裁,ownerLevel = true(默认值已给,Draft 不必等)】裁定 `approvalTemplateAdminGuard`,但门审不采纳上一段"更严格所以安全"这个理由(记忆 `feedback_second_narrower_artifact_is_contract_narrowing`:另造更窄同类物本身就是合同变更)——采纳的是三条实证理由:① 锁 §6 分期 2 抬头原文是「管理员」的显式操作,「预览」是该操作第一段而非独立浏览端点,I7 的读/写二分没有预料到这种形状;② 仓内在地先例`POST /api/approval-templates/:id/route-preview`(同 router)同样是只读 preview 却挂 `approvalTemplateAdminGuard`;③ 正确性判据(非口味):§5.2 已论证 preview 与 execute 必须共用同一条 SQL 否则展示与实际不一致,若挂 `approvals:read` 则非 manager 读者拿到的是被 `applyTemplateVisibilityFilter` 收窄过的另一个集合——一份任何 execute 都不会照做的"预览",与§5.2 自己的论证矛盾。但第③条门审自己攻破了"guard 人口=manager 人口"这个隐含前提(见 §13 changesRequired #16):`hasPermissionCode` 对权限码做通配展开而 `isTemplateManager` 是精确 `.includes()`,但通配权限码 `approval-templates:*` 单独**不足以**过 guard——`rbacGuardAny` 的权限腿是合取(`requestUserHasResolvedPermission && isPermissionAllowedByNamespaceAdmission`),`approval-templates` 是 namespace-admission 受控资源,该腿在 phase1 第 2 轮与第 4 轮门审各端到端真库证伪过一次(均 403,全仓真实授予计数 0)。**唯一端到端实测成立的「过 guard 但非 manager」反例是 DB 侧 `isAdmin(userId)`**(独立于 JWT 的 `role`/`roles`/`permissions`)——parity 只在 manager 人口内成立,不是恒等,但支撑这条结论的是这一条腿,不是两条(2026-09-18 rebase 到 `feat/approval-template-groups-phase1` 新 tip 后订正,见 impl-gate-A3-round1-20260918.md §5 P2 后果 (b);上一版误写"持 approval-templates:* 或走 DB 侧 isAdmin(userId) 的主体"把已证伪的通配腿当成第二条成立的反例)。要求:Draft PR body 逐字披露这条对 I7 字面二分的偏离 + 上述三条理由 + 这条更窄的 parity 表述(仅 DB 侧 `isAdmin` 一条腿),请 owner 一句话确认(记忆 `feedback_ratified_text_may_live_only_in_an_owner_comment`)。**

### 6.3 org 来源

三个端点全部复用 A-1 的 `resolveApprovalTemplateGroupOrgId(req, res)`(`routes/approvals.ts:352-370`)——body/query 的 `orgId` ⇒ 400 `ORG_ID_NOT_ACCEPTED`;`req.authenticatedTenantId` 缺失 ⇒ 403 `SESSION_ORG_REQUIRED`。不新造 org 解析逻辑(A‴ 的机制原样复用)。

## 7. 错误码(全部实现者新增,均非锁文 ratified 码——§7 的框架语言照抄 A-1 §3.3 的区分方式)

| 码 | HTTP | 触发 |
|---|---|---|
| `APPROVAL_TEMPLATE_GROUP_BACKFILL_BATCH_NOT_FOUND` | 404 | rollback 指向不存在于该 org 的批次 id |
| `APPROVAL_ACTOR_REQUIRED` | 401 | 沿用 A-1 既有码(execute/rollback 都需要 actor id) |
| `GROUP_SORT_CONFLICT` | 500 | **【§13 changesRequired #11 后半,本步落地】** execute 建组撞 `atg_sort_unique`(`DEFERRABLE INITIALLY DEFERRED`,COMMIT 时才报 23505)经 `mapGroupConstraintError` 映射;前半(catch 须套在整个 `transaction()` 调用之外)已在 §3.1 现场标注 |
| `APPROVAL_TEMPLATE_GROUP_BACKFILL_TOO_LARGE` | 400 | **【§13 changesRequired #12,本步落地】** execute 的 `eligible` 候选人口超过规模上界(默认 500,见 §3.1 现场标注)——ROLLBACK,零行写入,不建批次头 |
| `APPROVAL_TEMPLATE_GROUP_BACKFILL_BATCH_ALREADY_ROLLED_BACK` | 409 | rollback 对 `rolled_back_at IS NOT NULL` 的批次再次调用(响应体带 `rolledBackAt`)——已在 §4.4 point 1 提出(changesRequired #7),本步顺带同步进本表,非本轮新增裁决 |

`handleApprovalsError` 兜底码(名字含端点动作,同 A-1 惯例):`APPROVAL_TEMPLATE_GROUP_BACKFILL_PREVIEW_FAILED` / `_EXECUTE_FAILED` / `_ROLLBACK_FAILED`。

## 8. 待确认/请示(本提案主动列出,非"发现问题却假装没看见")—— **全部四项已过门审裁定,见 §13;本节保留原文只为存档,不再是"待"**

1. ~~§6.2 的 guard 冲突~~ **【§13 changesRequired #8 / Q2,已裁,ownerLevel=true,默认值已给】`approvalTemplateAdminGuard`,理由与 owner 确认要求见 §6.2 现场标注。**
2. ~~legacy category 值的空白/大小写不做归一化~~ **【§13 changesRequired #6 / Q3,已裁,ownerLevel=false】拆成两件事:必须不做值级归一化(回写 `approval_templates.category` 是静默数据迁移,锁 §5/§2 两条都挡);必须做——分桶键与组名一律取 `btrim(category)`(不折大小写,不回写)。理由:A-1 写路径 `normalizeTemplateCategory`/`requireName` 均已 trim,不 trim 的 backfill 会建出手工路径产生不出的 `'HR '` 名字,与"不另造第二套写路径"原则矛盾;`btrim(category)=''` 的纯空白遗留行必须排除并在 preview 标 `skipped`(锁 §4 D 谓词本身的既有瑕疵,A-3 只需不被绊倒,不得顺手改 D);不折大小写因为 `uq_atg_org_name_active` 大小写敏感,折叠等于替用户做归组决定。**
3. ~~rollback 幂等 vs 409、批次头 FK CASCADE 还是 NO ACTION~~ **【§13 changesRequired #7/#4,已裁,ownerLevel=false】见 §4.4 现场标注:rollback 409(非幂等 200);FK 三条分别裁,`atgbbl_link_fk` 方向翻转为 CASCADE(实测 M6),另两条维持原值。**
4. ~~§3.0 的重构影响面~~ **【§13 §2 Q6(a),已裁,ownerLevel=false】认可留在 A-3 分支,附三条件:(1) Draft PR 必须堆叠在 A-1 之上(base=`feat/approval-template-groups-phase1`);(2) PR body 必须写出 mutation 台账位移声明(#5852 的门审台账是对重构前函数体写的,需逐条说明目标已搬进 `...WithClient` 体内,该 PR 自身 head 与 verdict 不变,记忆 `feedback_gate_verdict_is_head_scoped`);(3) A-1 若再有修复轮,A-3 必须 rebase,不得 cherry-pick。**

## 9. 验证计划纲要(供下一步实现时对照,不是本步交付物)

- preview 不写:mutation——preview handler 里若误用 execute 的写路径 ⇒ 断言候选查询后 `approval_template_group_links`/`approval_template_groups`/两张新批次子表全部行数不变,mutant 应该让这条断言变红。
- execute 幂等:同一 org 连续调用两次,断言第二次 `batchId === null` 且四张表(groups/links/batches/batch_groups/batch_links)行数变化量为零。
- rollback 精确到批次:构造"execute 产生的组/链接" + "execute 之后、rollback 之前,另一个连接对同一组/同一模板做批次外变更"两类夹具,rollback 后断言批次外变更原样保留、只有批次自身仍处于原状态的部分被撤销——mutation:去掉 §4.2 的 `linked_at` 匹配条件或去掉 §4.3 的 `remaining = 0` 检查,分别应该让对应断言变红。
- 并发 execute 停车:`waitUntilBackendBlockedByHolder`,与 A-1 验收 E 同一 helper、同一 L0 key,复用其屏障连接配方(第三连接持 L0,不取生产路径本身的锁)。
- 两点 CI 接线 + s6a 重钉:新增的 `.db.test.ts` 文件名待定于实现阶段;`plugin-tests.yml` 显式清单 + `vitest.config.ts` exclude 两处都要加,同 A-1 的两点接线;**闭世界残留披露**(补充清单 #1):现场核对(`grep -rl "approval-template-groups" scripts/ops/*-ci-wiring.test.mjs` 零命中)A-1 的两个文件今天**没有**被任何 `*-ci-wiring.test.mjs` 覆盖,该 lane 的实际保护是 `plugin-tests.yml:1578` 的 bash `:?`(A-1 PR body 已披露此 P3 残留)——本切片的新文件会有**同样的**残留,不是本切片引入的新缺口;是否现在补一个专用 `*-ci-wiring.test.mjs`(增加 45 个同族守卫之一)留给实现步骤或 owner 决定,不在本提案范围内新造。

## 10. 本步交付物与下一步

本步(worktree/私有库建立后的第一个可提交单元)只交付本文档,不写任何实现代码——taskbook `:72`/`:227` 明确 W7/W8/W9(preview/execute/rollback)在"设计提案过独立门审"之前不进入实现队列。**下一步是把本文档送独立门审**(§6.2 的 guard 冲突、§8.4 的 `WithClient` 重构落点都是需要门审/owner 表态的输入项,不是已定案——门审通过或给出修法意见之后,才按 §9 的验证计划纲要开始写 DDL + 服务层 + 端点)。

## 11. 附录(2026-09-18,续做步骤 2):§3.0 `WithClient` 抽取已先行落地,W7/W8/W9 仍未解禁

咨询了独立复核(advisor,非本文档所称的"独立门审"——见下方澄清)后确认:§3.0 描述的 `...WithClient` 抽取是 W7/W8/W9 存在的**硬前提**(没有它,execute/rollback 一旦组合调用现有导出函数就会在同一会话跨连接死锁,§3.0 已论证),而这个抽取本身**不提交**任何 §6.2/§8.4/批次表 DDL 的裁决——所以它被单独实现并提交,而**预览/执行/回滚三个端点、三张批次表 DDL、新增 `.db.test.ts`、CI 两点接线与 s6a 重钉仍然在门之外**,taskbook `:72`/`:227` 的门未变。

**已实现**(`packages/core-backend/src/services/ApprovalTemplateGroupService.ts`):`createApprovalTemplateGroup`/`linkApprovalTemplateToGroup`/`archiveApprovalTemplateGroup` 各自拆成 `...WithClient(client, …)`(内部原语)+ 原导出名薄封装(`transaction(client => …)`),与本文档 §3.0 的决策一致。

**对 §3.0 原文的一处修正(不是静默偏离)**:§3.0 原文承诺"语句、顺序、错误映射逐字不变"——这句对**组合调用**(execute 在同一个 `transaction` 里连续调用两个 `...WithClient`)不成立,原因是 `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` 必须是 `BEGIN` 后的第一条语句(§2);若把 SET 留在 `createApprovalTemplateGroupWithClient`/`archiveApprovalTemplateGroupWithClient` 的函数体里,execute 组合调用两次时第二次 SET 会晚于第一次调用已经跑过的查询语句,在 RR 默认池下报 `25001` 并中止整个事务,在 RC 服务器上又会静默成功从而验证空转——两种后果都不可接受。**改正**:SET 从这两个 `...WithClient` 函数体中**移出**,只由目前仍是单操作路径的薄封装在 `transaction(...)` 回调的第一条语句里发出(与重构前的物理位置完全相同,§3.0 的"下一步"部分因此改写)——`linkApprovalTemplateToGroupWithClient` 本来就不发 SET(link 不取 L0),不受影响。`pg_advisory_xact_lock` 在同一会话内可重入,`...WithClient` 内部保留自己的 L0 获取语句不会因组合调用而阻塞或出错。这意味着**未来** execute/rollback 组合这些 `...WithClient` 原语时,必须自己在其唯一的 `transaction(...)` 回调顶部发一次 SET,而不是指望被组合的原语各自带一份——这条义务记入本条附录,供门审核实,门审通过前不假设为已解决。**【§13 changesRequired #10 / Q6(b),已裁】机制本身成立(门审逐条核对:SET 在薄封装里仍是回调第一条语句,`pg_advisory_xact_lock` 同事务内可重入),但"记入附录供人工核实"这个执行方式被驳回——义务必须升级成 typecheck 门:唯一的 `beginApprovalTemplateGroupTxn(client)` 发 SET 并返回品牌类型 `AtgTxClient`,三个 `...WithClient` 只接受该类型,"忘了发 SET"因此变成编译期错误;明确驳回运行时 `current_setting('transaction_isolation')` 断言(在 RC 默认服务器上恒真,零判别力,见 §13.2 逐字保留的门审原文)。此条为 W8 实现单元的落地对象,本步只记入求值,不新增品牌类型代码。**

**验证**(零行为变化,两条证据,均见 commit 的验证记录):
1. **行为对照**:A-1 已落地的两个真库测试文件 `approval-template-groups-lifecycle.db.test.ts`(16 用例)与 `approval-template-groups-serialization.db.test.ts`(10 用例,RR 默认池,含 E/K 的顺序/停车敏感断言)在私有库 `metasheet2_lock_a3` 上**原样重跑**(`DATABASE_URL=postgresql://localhost:5432/metasheet2_lock_a3 EXPECT_DB=1 npx vitest --config vitest.integration.config.ts run <file> --reporter=dot`),重构前后**均 26/26 全绿**——这条覆盖了运行时语句顺序(E/K 两个用例专门断言 L0 停车与 COMMIT 阶段异常映射,若 SET/L0 顺序被打乱会直接观察到红)。
2. **机械 SQL 抽取对照**:对重构前后的文件各自用正则抽取全部 `client.query(<字符串字面量>)` 的 SQL 文本(21 条),排序后逐条 `JSON.stringify` 比较——**排序后的多重集合逐字相同**(21 = 21,零增删)。**已知局限,如实披露**:抽取脚本按源码文本定义顺序读取,不是按运行时调用顺序——由于 `...WithClient` 函数在源码中定义于其薄封装**之前**,原始"SET 紧跟在 L0 锁语句前"的相邻关系在**文本order**里看起来被拆开了(SET 现在文本上出现在其消费者之后);这不代表运行时顺序变化,运行时顺序仍由第 1 条的真库测试兜底证明,不由这条机械抽取兜底——两条证据分别覆盖"语句集合未变"与"语句顺序未变"两件不同的事,不能互相替代。

**澄清"独立门审"未被满足**:上一句的 advisor 咨询**不是**记忆库 `feedback_authorization_source_must_be_owner_authored` 意义上的独立门审——advisor 看到的是本会话自己的记录,不是外部裁量;把它当成门审通过会构成自证循环。本文档第 8 节列出的全部待裁决项(§6.2 guard 冲突、§8.2 归一化、§4.4 两处倾向)与 W7/W8/W9 三个端点仍然**原样待裁**,本条附录不改变这一点。

## 12. 附录二(2026-09-18,续做步骤 3):对 §11 的独立复核 + 三处未覆盖点(不写任何 W7/W8/W9 代码)

本步在同一个 worktree/私有库上,**独立于 §11 的原始记录**重新执行了两条验证(不是重述 §11 的文字,是本会话自己重新跑出的结果,逐行标 provenance):

- **私有库状态**(本会话现场核对):`DATABASE_URL=postgresql://localhost:5432/metasheet2_lock_a3 npx tsx src/db/migrate.ts --list` → `Applied: 407 / Pending: 0`(含分期 1 迁移,与其它并行 lane 共用同一私有库、迁移基线一致)。
- **typecheck**:`npx tsc --noEmit -p .`(`packages/core-backend`)零输出,干净。
- **26/26 真库回归,本会话重跑**(HEAD = `68aead6db`):`DATABASE_URL=postgresql://localhost:5432/metasheet2_lock_a3 EXPECT_DB=1 npx vitest --config vitest.integration.config.ts run tests/integration/approval-template-groups-lifecycle.db.test.ts tests/integration/approval-template-groups-serialization.db.test.ts --reporter=dot` → `Test Files 2 passed (2)` / `Tests 26 passed (26)`。这条独立复现了 §11 第 1 条证据,不是转述上一步 commit message 的说法。
- **SQL 多重集合比对,本会话重新实现并重跑**(不是重述 §11 第 2 条的"21=21",是用一个新写的、独立的正则状态机脚本对 `git show 417320f08:.../ApprovalTemplateGroupService.ts`(重构前)与当前 HEAD 的同文件分别提取全部 `client.query(...)` 首参数、归一化空白后排序比较):`before count: 21` / `after count: 21` / `multiset equal: True`。与 §11 报告的结论一致,但这次是两条独立方法各自得出同一结论,不是同一次计算被复述两次。

**三处 §11 未覆盖、本步核实后需要如实记入的残留(供门审输入,不现场修复——修复会触碰门外代码)**:

1. **26/26 只证明了"三个导出函数单独调用时零行为变化",没有证明"组合调用安全"**——A-1 的两个 `.db.test.ts` 测的是**薄封装**(每次一个独立 `transaction()`),这正是重构前就存在、重构后仍然存在的调用形状;§3.0 论证的死锁风险和这条修复,针对的是**execute/rollback 在同一个 `transaction(...)` 回调里连续调用多个 `...WithClient`**这个全新的调用形状——今天仓库里没有任何调用点走这条路径,所以 26/26 对"组合调用是否真的不再死锁、SET 顺序是否真的正确"是**零判别力**的(同族问题见记忆 `feedback_verified_one_link_generalised_to_the_chain`:验证了一环不能推广到整条链)。这条证据只能等 W8/W9 自己的真库测试(在组合调用路径上真正跑一次)来补,不是本步能补的——本步没有调用点可以测。**【§13 changesRequired #13 / Q6(c),已裁】门审给出三条补测,必须与第一个组合调用方(W8)同 PR 落地:①组合正例 + 反向正控(同一 `transaction()` 内 `await` 导出函数应停车/超时,不能只断言"不是错误 X");②SET 义务格必须落在 RR 默认池文件(锁 §6 文件 1);③锁序格断言停车点(`waitUntilBackendBlockedByHolder`)而非终态,正控用本报告 M2/M3 的修复前语句顺序。详见 §13.1 #13。**
2. **§11 移出 SET 的义务目前无人强制,失败模式是静默通过而不是报错**:§11 自己论证过"忘记在组合调用顶部发 SET"这个错误在 RR 默认池下会 `25001`(响亮的红),但在 READ COMMITTED 服务器配置下会**静默成功**——即以后 W8/W9 的作者如果漏发这条 SET,本地开发库(如果不是显式配了默认 RR)可能测试全绿却带着错误的隔离级别上线。今天没有任何代码或 lint 检查这条义务(纯文档承诺)。这不是本步能修的(修复方案——比如给 `...WithClient` 加一个"调用者必须已在本次事务发过 SET"的运行时断言——本身就是 W8/W9 范围内的实现决策,门审未过不能写),但必须显式记入,不能让它只活在 §11 的散文里等下一个实现者重新发现。**【§13 changesRequired #10,已裁】这个残留本身已被门审吸收并升级为强制要求(品牌类型 `AtgTxClient`,非运行时断言),不再是"等下一个实现者重新发现"的开放问题,见 §11 现场标注与 §13.2。**
3. **provenance 澄清**:§11 的"21=21"结论本身没有错(本步用独立脚本复现了同一结论),但 §11 原文把它写成"均见 commit 的验证记录"——那条记录是**上一步**做出的判断,本文档直到本步之前从未被**另一个**独立方法验证过。现在两条独立方法(不同脚本、不同会话)都得到同一结果,置信度比 §11 单独成立时更高,但这个提升本身是本步才发生的事实,不应该被合并写成"一直都验证充分"。

**本步交付物**:仅本节文字(§12),**不新增/不修改任何 `.ts`/迁移文件**——W7/W8/W9(预览/执行/回滚端点、三张批次表 DDL、新增 `.db.test.ts`、CI 两点接线、s6a 重钉)按 taskbook `impl-taskbook-A-grouping-20260918.md:72,:227` 仍在门外,本步不解禁、不视图绕过。下一步仍然是:把本文档(含本节)整体送独立(非本 lane 自己的)门审,门审需要对以下四点给出裁决,实现队列才能开始:§6.2(preview 挂 `approvalTemplateAdminGuard` 还是 I7 字面的 `rbacGuard('approvals:read')`)、§8 第 2 条(legacy category 归一化范围)、§4.4-1(rollback 幂等 200 vs 409)、§4.4-2(批次头 FK `CASCADE` vs `NO ACTION`);以及是否认可 `WithClient` 重构已经提交在本分支(而不是应该重新排到别处)。

**【本段"下一步"已完成,见 §13,2026-09-18 续做步骤 4】独立 Opus 设计门审已对本段点名的全部四点(及门审自己实测发现的另外 12 条)给出裁定——`reviews/design-gate-A3-phase2-20260918.md`,APPROVED-WITH-CHANGES(5 P1/4 P2/3 P3)。四点结论:§6.2 → `approvalTemplateAdminGuard`(ownerLevel=true,默认值已给);§8 第 2 条 → 分桶键 `btrim(category)` 不折大小写不回写;§4.4-1 → 409 非幂等 200;§4.4-2 → 三条 FK 分别裁,其中 `atgbbl_link_fk` 与提案原判断方向相反(实测证伪);`WithClient` 重构认可留在本分支,附三条件(见 §8 item 4 现场标注)。本节(§12)记录的三处残留(26/26 组合调用判别力缺口、SET 义务无机械强制、provenance 澄清)已被 changesRequired #13/#10 分别吸收为强制要求,不再是开放问题。详见 §13 全节。**

## 13. 设计门审裁定与落地(2026-09-18,续做步骤 4)

**门审 provenance**:`reviews/design-gate-A3-phase2-20260918.md`,独立 Opus 门审(refute-first,非 A-3 实现 lane),被审对象为本文档 @ `4b546fb13`。**裁定:APPROVED-WITH-CHANGES**(5 P1 / 4 P2 / 3 P3;其中 4 条 P1 为该会话私有真库 `metasheet2_design_gate_a3` 实测,非纸面推理)。本节把该报告的 16 条 `changesRequired`、Q1–Q7 七问、O1–O3 三条 owner 级项逐一落进本文档;§1/§2.1/§2.3/§3.1/§4.2/§4.3/§4.4/§6.2/§8 的原文**未删除**,均已按记忆 `feedback_supersession_marker_must_evaluate_not_void` 在原句旁加了求值标记(见上文各节现场标注,不在本节重复整段引用)。本节不写任何 `.ts`/迁移代码——changesRequired 的代码化是下一步(W7/W8/W9)的工作。

### 13.1 changesRequired 逐条落地表

**本表状态已由 §19.1(续做步骤 18,对着当前分支实际代码逐条 `grep` 核对,不是重读本表旧文本)复核过一轮;三格(#1/#5/#9)曾经落后于代码,已在下方现场勘误——冲突以 §19.1 为准,不要只信这张表自己的历史文本。**

| # | 门审要求(摘) | 本文档落地位置 | 状态 |
|---|---|---|---|
| 1 | execute 与 rollback 改成"L0 → 一条 `ORDER BY id FOR UPDATE` 预锁全部目标既有组 → 所有 L2 写 → 归档"(实测 M2/M3) | §3.1 pseudocode 本体已整段改写(取代旧的逐类目循环)+ §4 新增 rollback 事务骨架(BEGIN…COMMIT,含批次头 FOR UPDATE + 预锁既有组)+ §4.3 `locked` 已改为复用骨架读回的快照 | **已落地(execute 半续做步骤 17`executeApprovalTemplateGroupBackfillWithClient`;rollback 半续做步骤 12`rollbackApprovalTemplateGroupBackfillWithClient`,见 §18)——本行"rollback 半仍待"的旧文本是本步(续做步骤 18)核对代码后发现的过期状态,已勘误** |
| 2 | `linked_at` 令牌全程不经 JS:写入用数据修改 CTE,回滚用集合式 join(实测 M4) | §4.2「已知残留」段已重写 + 成品 SQL 已贴入该节 | **已落地(含成品 SQL)** |
| 3 | preview/execute 共用同一条可入库谓词 `btrim(category) ~ '[!-~]'`,必须在 `eligible` 查询内部而非循环 `continue`(实测 M5) | §3.1 eligible 谓词已替换 + 注释说明机制 | **已落地** |
| 4 | `atgbbl_link_fk` 改 `ON DELETE CASCADE`;另两条 FK 维持原值(实测 M6) | §2.3 CREATE TABLE 后现场标注 + §4.4 point 2 现场标注(区分两条不同的 FK,不得混淆) | **已落地** |
| 5 | 新增 `GET /api/approval-template-groups/backfill/batches`(admin guard,分页,含 `rolledBackAt`)+ 索引 | §2.1 段已加 `..._backfill_batches_org_created_idx` 索引 DDL(续做步骤 5/8);服务函数 `listApprovalTemplateGroupBackfillBatches` + 路由本体见 §19(续做步骤 18) | **勘误(本步,续做步骤 18):上一版本行文写"已落地(续做步骤 5)"是不准确的——续做步骤 5/8 只落地了索引 DDL 与§6.1/§2.1 的文档行,GET 路由与服务函数当时并不存在(`grep -n "backfill/batches" src/routes/approvals.ts` 在续做步骤 17 时只命中 rollback 的 `:batchId/rollback` 一行,§18 自己的 remaining 列表也如实记了这条未落地——是本表这一格没有跟着回写)。`.ts` 代码+真库测试现已落地,见 §19** |
| 6 | 分桶键/组名一律 `btrim(category)`,不折大小写,不回写 `category` 列 | §8 item 2 现场标注 | **已落地** |
| 7 | rollback 对已回滚批次返回 409 + 专用码 + `rolledBackAt` | §4.4 point 1 现场标注 | **已落地** |
| 8 | preview 挂 `approvalTemplateAdminGuard`,PR body 逐字披露对 I7 的偏离 | §6.2「本提案倾向」段后现场标注 | 设计已落地;PR body 义务见 §13.4 |
| 9 | execute 调用 `...WithClient` 原语,不得抄语句;rollback 共用语句须提炼命名常量/附加谓词形参 | §1 表三行现场标注 | **已落地。execute 半(续做步骤 17):调用 `createApprovalTemplateGroupWithClient` / `linkApprovalTemplateToGroupWithClient`,未抄语句;#9 与 #2 的张力(调用 link 原语会拿到其 JS 映射后的 `linkedAt`,直接回填批次表会重犯 M4)按本步 §17 的现场注释解决——批次明细行的 `linked_at` 改由一条独立的服务端相关子查询从刚提交的链接行读回,而不是使用原语返回值,§17 有 mutation 证据。rollback 半(续做步骤 12,见 §18):不调用归档/解除原语(§4.1 论证维持),但把共用语句提成 `ATG_UNLINK_ALL_GROUP_MEMBERS_SQL` / `ATG_ARCHIVE_GROUP_ROW_SQL` 两个命名导出常量,`archiveApprovalTemplateGroupWithClient` 自身也改调这两个常量而非内联——全仓该语句只有一处文本。本行"rollback 半仍待 W9"的旧文本是本步(续做步骤 18)核对代码后发现的过期状态,已勘误。** |
| 10 | SET 义务变成 typecheck 门:唯一 `beginApprovalTemplateGroupTxn(client)` 返回品牌类型 `AtgTxClient`;明确不采用运行时 `current_setting` 断言 | 本节 §13.2 逐字保留门审给出的成品设计;§11 附录原文的"SET 由薄封装发出"承诺在此升级为机械约束 | **已落地(续做步骤 16 品牌类型本体;续做步骤 17 在 execute 侧的调用点验证——`beginApprovalTemplateGroupTxn` 在 `executeApprovalTemplateGroupBackfill` 薄封装里调用恰好一次)** |
| 11 | `mapGroupConstraintError` 套在整个 `transaction()` 之外;§7 错误码表补 `GROUP_SORT_CONFLICT` | §3.1 catch 分支段已现场标注 try/catch 包裹形状(前半);§7 错误码表已补 `GROUP_SORT_CONFLICT` 行(后半) | **已落地(续做步骤 5,含前后两半)** |
| 12 | execute 加规模上界(默认 500,超出 400 `…_BACKFILL_TOO_LARGE`)或给出规模-耗时曲线,二选一;**cap 分支额外要求"preview 提前给出 `candidateCount`"**(报告 §3 P2-2 原文) | §3.1 pseudocode 已加 `IF count(eligible) > 500` 中止分支(选"上界"一侧,非规模-耗时曲线);§7 错误码表已补 `APPROVAL_TEMPLATE_GROUP_BACKFILL_TOO_LARGE` 行;`candidateCount` 见 §5.2 响应形状 | **execute 半 + 上界真库测试(超过 500 触发 400、零行写入)已落地(续做步骤 17/19,`1786c0566`)。preview 半(`candidateCount`)在本表上一版本长期缺格——`grep -rn "candidateCount" packages/core-backend/src packages/core-backend/tests`(改动前)0 命中,§19.1/§20.5/§21.6 三轮 remaining 都只点了"规模上界真库测试"这一半,从未点过 preview 半——**本步(续做步骤 21)补齐**:`ApprovalTemplateGroupBackfillPreview.candidateCount`(routes/approvals.ts)= 同一个 `bucketsByCategory` 累加器求和,不是第二条独立查询;同预测 `.db.test.ts` 三例(单元值断言、HTTP 序列化断言、与 execute 实际处理数的跨调用耦合断言)+ mutation 正控(cp/改/跑/还原/cmp,三例全部由绿转红,还原 `cmp` 逐字节一致)** |
| 13 | W8 同 PR 补三条组合调用判别力测试(组合正例+反向正控停车/超时;SET 义务格落在 RR 池文件;锁序格断言停车点非终态) | §9 验证计划纲要目前只有粗粒度描述;本条细化待 §9 改写(下一实现单元) | **勘误(本步,续做步骤 21):本行"设计已知悉,§9 待补"这句字面是本表从 §13 首次写出起就没跟上代码的过期状态——三个子项其实早就全部落地,只是三次落地(§21 自己那次除外)都没有回写这一格:① 组合正例 + 反向正控(`transaction()` 内部再 `await` 一个 `...WithClient` 导出函数会在 L0 停车/超时,不是别的原因)—— `117e248cb`;② SET 义务格落在 RR 默认池文件——`45e5c8a21`(§21 自己落地并回写过);③ 锁序格断言**停车点**(`waitUntilBackendBlockedByHolder`,报告字面要求,不是完整两方 40P01 构造)——`f3b3cc5d3`。`git log --oneline origin/feat/approval-template-groups-phase1..HEAD` 核对:三个 SHA 均在当前分支历史内。** |
| 14 | §1 表逐格改调用级复用;§2.1"无可观测中间态"收窄为"无 DB 行级中间态" | §1 表三行 + §2.1 段,均已现场标注 | **已落地** |
| 15 | Q1(b) 普查改写:把"四 token 零命中"换成更宽普查记录,`attendance_import_rollback_*` 作为正面先例引用 | §"批次机制选择"段(原§1 前)已加现场标注,补更宽普查(`operation_audit_logs` 自述占位且 schema 漂移两次、无 org 无 FK;`oapi_write_audit`/`automation_action_applied`/`approval_form_field_revisions` 各自域内无 FK;`attendance_import_rollback_*` 改列为正面先例而非仅驳回对象) | **已落地(续做步骤 5)** |
| 16 | preview/execute 响应带 `scope: 'org-complete' \| 'visible-to-you'`;不得假设"所有管理员都是 manager";`routes/approvals.ts:396-399` 过强注释回流 #5852 | §6.2 现场标注已引用 guard 人口与 manager 人口互不包含的事实(两方向各有一个实测反例——DB 侧 `isAdmin` 主体过 guard 但非 manager;持 `approval-templates:manage` 但未过 namespace admission 的主体被 guard 403 却被 `isTemplateManager` 判成 manager,phase1 第 6/7 轮已证伪原先"guard ⊋ manager"的严格超集说法,2026-09-18 rebase 后订正;前半道理已求值);`scope` 字段已写入 §5.2 响应形状(jsonc 示例)与 §3.1 execute 的两处 `RETURN`(中段已落地);回流 #5852 是跨 lane 动作,本分支无权限做(后半见 §13.5) | **前半+中段已落地(续做步骤 5),后半记入 remaining(见 §13.5)** |

### 13.2 逐字保留的门审成品(供 W7/W8/W9 直接抄用,不得转述)

**execute/rollback 统一锁序**(门审 Q7(a) 原文):

```
L0(顾问锁)
→ 一条语句预锁本次要触达的全部既有组行,带确定性行序:
     SELECT id FROM approval_template_groups
      WHERE org_id = $1 AND id = ANY($2) ORDER BY id FOR UPDATE
   (execute:$2 = 各 category 解析出的既有组 id;
    rollback:$2 = SELECT DISTINCT group_id FROM batch_links WHERE batch_id=$1
                  UNION SELECT group_id FROM batch_groups WHERE batch_id=$1)
→ (execute) 新建组:纯 INSERT,新行只有本事务可见,不存在 L1 争用
→ 所有 L2 写(execute 的逐模板 upsert / rollback 的集合式 UPDATE)
→ (rollback) 计 remaining、写归档
```

`ORDER BY id` 不可省——分期 3 的重排会对该 org 全部活跃行取 L1,把 L1 层内序钉成 `id` 升序应留给分期 3 沿用。

**SET 义务的品牌类型方案**(门审 Q6(b) 原文,明确驳回运行时断言):

> 要求的修法:品牌类型(branded type)。导出唯一一个 `beginApprovalTemplateGroupTxn(client)`(或等价物),它发出 `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` 并返回一个带品牌的 `AtgTxClient`;三个 `...WithClient` 只接受 `AtgTxClient`。"忘了发 SET"于是变成 typecheck 红,与服务器默认隔离级别无关。
> 明确驳回运行时断言方案:在 `...WithClient` 顶部 `SELECT current_setting('transaction_isolation')` 并校验,在 RC 默认的服务器上恒为 `read committed`,恰好在失败静默的那一侧零判别力(锁 v2.6 P2-C 已实测过同型空转)。这条断言会给人"已经守住了"的错觉,比没有更糟。

### 13.3 尚未落地 / 待下一实现单元补的项(不在本步现场改写,如实列出)

**【本节自 2026-09-18 续做步骤 5 起大部分已关闭】** 上一版本(commit `027a1f9cd` 及以前)列了六项;本步(续做步骤 5)已把其中五项现场改写进正文——changesRequired #5(§2.1 索引 + §6.1 端点行)、#11(§3.1 catch 段 + §7 错误码表行)、#12(§3.1 规模上界 + §7 错误码表行)、#15(§"批次机制选择"段更宽普查)、#16 中段(§5.2 `scope` 字段 + §3.1 execute 两处 `RETURN`),以及 §3/§4 execute+rollback pseudocode 本体按 §13.2 统一锁序的整段重写(changesRequired #1)。逐条状态见上方 §13.1 表(均已改为**已落地**)。剩下唯一未关闭的一项:

- §9 验证计划纲要未细化 changesRequired #13 的三条组合调用判别力测试用例名(组合正例+反向正控停车/超时;SET 义务格落在 RR 默认池文件;锁序格断言停车点非终态)——这一项本质上是下一实现单元(W8 真库测试文件)的用例命名前奏,留给写 `.db.test.ts` 时一并定名,不在本步单独为一段散文预先杜撰用例名(先例:记忆 `feedback_audit_surface_must_not_fabricate` 禁止编造值)。

以上这一项在下一实现单元(§3 execute/rollback 的 `.ts` 代码化 + 首批 `.db.test.ts`)落地时一并补齐,不再重复门审已经点名的 P2-4 同类"标记贴在附录、正文未回写"问题。

### 13.4 owner 待裁,按默认值(ownerLevel = true,Draft 按此推进,不等 owner)

- **O1**:三张批次表(header + batch_groups + batch_links)是锁 §2 之外的新表(锁文外 DDL)。**owner 待裁,按默认值**:采纳提案的 header+detail 三表形状(含 changesRequired #4 的 FK 修正);Draft only,不应用不合并。
- **O2**:`atg_name_nonblank CHECK (name ~ '[!-~]')` 拒绝纯中文组名——这是 A-1/#5852 上的**活缺陷**(`POST /api/approval-template-groups {name:'人事'}` 今天就是 500,产品 UI 明确指导用户填纯中文分类,见 `TemplateAuthoringView.vue:221` placeholder),需要**锁 §2 约束清单勘误**。**owner 待裁,按默认值**:建议改成 `CHECK (btrim(name) <> '')`;在 owner 裁决前,A-3 按 §13.1 #3(changesRequired #3)的谓词跳过纯中文 category 并在 preview 标 `skipped`,诚实披露"owner ratify 勘误前,本功能对纯中文分类惰性"。**这是继目标文档 §"不在目标内"列出的两条锁文勘误请示之外的第三条**,须一并记入 owner brief,不能只活在本文档里(见 remaining)。
- **O3**:preview 的 guard——已在 §13.1 #8 / §6.2 现场标注给出默认值 `approvalTemplateAdminGuard`;**owner 待裁,按默认值**是因为 I7 原文明写"不由实现者现场裁量",需要 owner 一句话确认,Draft 不必等。

### 13.5 跨 lane / 超出本分支权限的项(记入 remaining,不在本步处理)

1. **P1-3 对 #5852 的溢出影响**:`createApprovalTemplateGroup(org,'人事',actor)` 抛裸 `DatabaseError`(`code=23514`),意味着 A-1 Draft PR #5852 第 3 轮"0 P1 / 0 P2 @`0144932ac`"的门审 verdict 是 **head-scoped** 的,该发现是本次 A-3 门审的溢出,**需要回流 #5852 重新求值其"0 P1"结论**——这不是 A-3 分支能做的事(#5852 是另一个 Draft PR,改它不在本 lane 权限内)。
2. **changesRequired #16 后半**:`routes/approvals.ts:396-399` 的注释"`approvalTemplateAdminGuard` makes every actor that can reach the link endpoint today `isTemplateManager`"是过强声明——两个人口互不包含,不是 guard 人口 ⊋ manager 人口这个严格超集关系(phase1 第 6/7 轮已各端到端真库证伪一次:DB 侧 `isAdmin` 主体过 guard 但非 manager;持 `approval-templates:manage` 但未过 namespace admission 的主体被 guard 403 却被 `isTemplateManager` 判成 manager,2026-09-18 rebase 后订正,原文的 ⊋ 是 `design-gate-A3-phase2-20260918.md` changesRequired #16 自己的绑定文本),**应随 P1-3 一并回流 #5852**——同上,不在本分支权限内现场改写 A-1 已落地代码的注释。
3. **O2 的锁文勘误请示**是第三条尚未记入目标文档"不在目标内"清单的勘误项(该清单目前只列了分组锁 J/C「section 400」挪分期 3、"1 落地"求值两条)——需要在下一次向 owner 汇报时补齐这第三条,本文档在此记录以防遗漏。

### 13.6 Draft PR body 必写清单(为一个当前禁止开出的 PR 预先收集,防止到时遗漏)

- changesRequired #3:纯中文 category 在 owner ratify `atg_name_nonblank` 勘误前功能惰性的诚实披露。
- changesRequired #8:preview guard 偏离 I7 字面读/写二分的三条理由 + 请 owner 一句话确认。
- changesRequired #15:Q1(b) 更宽普查记录(`operation_audit_logs` 自述占位且 schema 漂移两次;`attendance_import_rollback_*` 是正面先例而非仅驳回对象)。
- changesRequired #16:`scope` 字段的存在理由——guard 人口与 manager 人口**互不包含**,不是 changesRequired #16 原文(`design-gate-A3-phase2-20260918.md`,上游绑定文本)所写的「guard 人口 ⊋ manager 人口」这个严格超集关系。两个方向各有一个端到端实测反例:①「过 guard 但非 manager」——DB 侧 `isAdmin(userId)` 一条腿(通配权限码 `approval-templates:*` 单独过 guard 已被 phase1 第 2/4 轮各真库证伪一次,不是第二条成立的腿,2026-09-18 rebase 后订正,见 impl-gate-A3-round1-20260918.md §5 P2 后果 (b));②「过 manager 但非 guard」——持 `approval-templates:manage` 权限码但未过 namespace admission 合取项的主体,被 `isTemplateManager` 精确 `.includes()` 判成 manager,却被 `rbacGuardAny` 拒绝(403),这是 phase1 第 6/7 轮门审新增的实测证伪(`3e53c52fe`),晚于本文档上一次写下 ⊋ 这句话。PR body 必须逐字写「互不包含,两方向各一条反例」,不得抄 changesRequired #16 原文的 ⊋ 措辞而不加订正标注。
- P3-2:A-1 两个既有文件(`lifecycle`/`serialization`)不被任何 `*-ci-wiring.test.mjs` 覆盖的闭世界残留披露——**本切片新增的五个 backfill 文件不继承这个残留**,各自有专属的 `*-ci-wiring.test.mjs` 守卫(5×3=15 条断言,验证 MD §2.4),PR body 只需披露 A-1 两文件的残留,不得写成"本切片新文件继承同样残留"。
- P3-3:`action` 判定函数抽取为只读小函数供 preview/execute 共用,且同时返回 `skipped` 判定。
- Q6(a) 三条件:PR 必须堆叠在 A-1 之上(base=`feat/approval-template-groups-phase1`);mutation 台账位移声明(#5852 台账是对重构前函数体写的,需逐条说明目标已搬进 `...WithClient` 体内);A-1 若再有修复轮,A-3 必须 rebase 不得 cherry-pick。
- changesRequired #5(续做步骤 18 新增):`GET …/backfill/batches` 是继 preview 之后**第二个**挂 `approvalTemplateAdminGuard` 而非 I7 字面 `rbacGuard('approvals:read')` 的只读端点——gate 本身已在 changesRequired #5 原文里点名这个 guard,不是本步现场裁量,但 O3 的 owner 一句话确认原文只提名了 preview 一个端点。PR body 需要把这条偏离扩写成"两个端点",不能让 owner 以为只有 preview 一处需要确认。
- 本步(续做步骤 18)commit message 有过度声明:写了"changesRequired #5 是 16 条里唯一未落地的一条",但准确表述(见 §19.1/§19.4)是"#5 的**代码**是唯一缺口,#12 的实测规模-耗时曲线/上界真库测试、#13 的三条组合调用判别力测试、#16 后半的 #5852 回流仍然开放"——按 commit 不可 amend 的硬规矩,这条勘误只能在文档里补,PR body 必须用 §19.1/§19.4 的措辞,不能沿用 commit message 的说法。

### 13.7 验证 MD 状态

本切片的验证 MD(`docs/development/approval-template-groups-phase2-verification-*.md`)**尚不存在**——按目标文档 §"每个切片的交付物"的要求,验证 MD 随 Draft PR 一并提交,本步只交付设计文档的门审裁定落地,不构成验证 MD 的替代,记入 remaining。

## 14. 续做步骤 8:批次表 DDL 代码化 + 真库回归(2026-09-18)

本步只做§2 的 DDL 代码化这一个最小单元,不写 W7/W8/W9 的 `.ts` 服务/路由代码(仍在 remaining)。

- **迁移文件**:`packages/core-backend/src/db/migrations/zzzz20260919090000_create_approval_template_group_backfill_batches.ts`——三张表(`approval_template_group_backfill_batches` / `_batch_groups` / `_batch_links`)+ `..._org_created_idx` 索引,逐字落地 §2.1–2.3 现场标注后的最终形状(含 changesRequired #4 的 `atgbbl_link_fk` CASCADE 修正、#5 的索引)。`up`/`down` 均为 additive-only、`IF NOT EXISTS`/`IF EXISTS` 幂等。
- **已在私有库 `metasheet2_lock_a3` 应用**(`DATABASE_URL=postgresql://localhost:5432/metasheet2_lock_a3 npx tsx src/db/migrate.ts`,`packages/core-backend` 内)——**未**应用到任何共享/CI/生产库。
- **真库测试(新文件)**:`packages/core-backend/tests/integration/approval-template-groups-backfill-schema.db.test.ts`,8 例,全部针对 DDL 本身(尚无路由/服务层,W7/W8/W9 未写):
  1. changesRequired #5 索引存在;
  2. 四条 FK 的 `confdeltype` 逐一核对(`atgbbg_batch_fk`=c、`atgbbg_group_fk`=a、`atgbbl_batch_fk`=c、`atgbbl_link_fk`=c)——机核 Q5 裁定,不是散文;
  3. **M6 正控**:硬删一个已挂接模板,断言级联穿过 `..._links` 直达 `..._batch_links`(零行残留、无 FK 报错);
  4. **M6 反控(mutation)**:同一条事务内把 `atgbbl_link_fk` 现场改回提案原始的 `NO ACTION`(`DROP CONSTRAINT` + `ADD CONSTRAINT`),对同一条删除断言必炸(`atgbbl_link_fk`),再断言事务 ROLLBACK 后目录里的 `confdeltype` 确已还原为 `c`——DDL 的 mutation 是事务性的,不需要 `cp` 文件级备份/还原;
  5/6. `atgbbg_group_fk`/`atgbbl_link_fk` 的跨 org 复合 FK 拒绝(两个独立反例);
  7. 批次头删除级联到两张子表,但不牵动它们各自指向的 groups/links 行。
- **对迁移文件本身的 mutation 探针**(遵守硬规矩:`cp` 备份 → 改 → 单独跑 → 还原 → `cmp`):把 `.ts` 源文件里的 `atgbbl_link_fk` 现场改回 `NO ACTION`,`DROP TABLE`+重新 `migrate` 使其在私有库生效,重跑同一文件——3/8 例转红(FK 形状断言、M6 正控、M6 反控的"已还原"断言),其余 5 例仍绿;`cp` 还原源文件后 `cmp` 确认字节级一致,再次 `DROP TABLE`+`migrate`+重跑,8/8 转绿。这证明这 3 例是本 DDL 修正的真实回归证据,不是空转断言。
- **CI 两点接线 + 第三点(执行性)+ s6a 重钉**(新文件,之前不存在):
  - `packages/core-backend/vitest.config.ts` 的 `exclude` 数组新增该文件路径(见现场行,`grep -n "approval-template-groups-backfill-schema" packages/core-backend/vitest.config.ts` 命中 2 处:exclude 条目 + 注释引用);
  - `.github/workflows/plugin-tests.yml` 的 `approval-real-db-integration` 步骤整文件参数列表末尾追加该文件(`grep -n "approval-template-groups-backfill-schema.db.test.ts" .github/workflows/plugin-tests.yml` 命中 1 处,即该 vitest 参数行本身;独立 wiring 守卫步骤引用的是另一个文件名 `approval-template-groups-backfill-schema-ci-wiring.test.mjs`,见下一条);
  - 新增 `scripts/ops/approval-template-groups-backfill-schema-ci-wiring.test.mjs`(仿 `b4-department-bindings-ci-wiring.test.mjs` 形状:两点接线 + 文件存在性 + "不得误连到 multitable 真库步骤"反例),并在 `plugin-tests.yml` 的无 DB `test` job 里新增一步 `A3 backfill-schema CI wiring contract` 去 `node --test` 它——否则这个新 wiring 守卫本身不会被任何 CI job 执行(纯本地存在,CI 里空转)。
  - 由于改了 `plugin-tests.yml`,按硬规矩同一提交重算 s6a `pluginTestsWorkflow` 钉:`shasum -a 256 .github/workflows/plugin-tests.yml` 从 `f08ea1a…` 变为 `33befe4…`,已写回 `plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json`;改前 `node --test plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs` 亲跑转红(`SEALED_EXPORT_INTERNAL_ERROR`),改后重跑转绿(`sealed-export-package-provenance.test.cjs OK`)。
  - **本条不适用于 A-1 的两个既有文件**(`approval-template-groups-lifecycle.db.test.ts` / `approval-template-groups-serialization.db.test.ts`)——它们仍只受步骤脚本的 bash `:?` 保护、没有专属 `*-ci-wiring.test.mjs`,这是 §9/P3-2 已披露的既有残留,本步没有现场回填(不在本单元范围内,记入 remaining,补写时机=写 W7/W8/W9 真库测试文件时一并处理更合理,因为那时才会真正调用这两个文件里定义的原语)。
- **回归证据(A-1 两个既有真库文件,未改动,亲跑)**:`DATABASE_URL=postgresql://localhost:5432/metasheet2_lock_a3 EXPECT_DB=1 npx vitest --config vitest.integration.config.ts run tests/integration/approval-template-groups-lifecycle.db.test.ts tests/integration/approval-template-groups-serialization.db.test.ts tests/integration/approval-template-groups-backfill-schema.db.test.ts --reporter=dot`(`packages/core-backend` 内)→ `Test Files 3 passed (3)` / `Tests 34 passed (34)`(16 + 10 + 8)。
- `npx tsc --noEmit -p tsconfig.json`(`packages/core-backend`)对迁移文件与新测试文件均**零错误**。
- **未做**(remaining,交后续单元):W7 preview / W8 execute / W9 rollback 的路由与服务层 `.ts` 代码(含 `beginApprovalTemplateGroupTxn` 品牌类型、`GET …/backfill/batches` 端点、changesRequired #13 的三条组合调用判别力测试);A-1 两个既有真库文件补 `*-ci-wiring.test.mjs`(见上一条);验证 MD(§13.7,仍不存在)。

### 14.1 同一单元内自纠三处(advisor 复核)

§14 正文对应的提交(`02775e95f`)push 后过 advisor 复核,发现三处需要当场修复的问题;三处均已修正、重新亲跑验证,作为**同一续做步骤内的第二个提交**(见 git log,不 amend 已推送的提交):

1. **wiring 守卫用了两个可用检查里较弱的一个**:`approval-template-groups-backfill-schema-ci-wiring.test.mjs` 最初照抄 B4 先例的 `cfg.includes(`'${FILE}'`)`——纯文本匹配,把 exclude 那一行注释掉(`// 'tests/...',`)子串仍在,守卫照样绿,而真实排除已经消失,no-DB job 会重新收集这个 DB-gated 套件并 skip-green。**已亲测该弱点**:手工注释掉 exclude 行,弱检查(3/3 绿,含被攻击的那一条)。改用同一个 `ci-realdb-step-contract.mjs` 模块里更强的 `isQuotedInTestExclude`(结构化解析 `test.exclude` 数组,先去行内注释)后,同一变异下该条目断言**转红**;`cp` 备份的 `vitest.config.ts` 还原后 `cmp` 字节级一致,重跑转绿。这是记忆 `feedback_copy_precedent_whole_block_not_item_by_item` 的又一实例——抄了先例里较窄的写法,而更宽的检查就在同一个已 import 的模块里。
2. **硬编码 group/batch id 跨轮碰撞面**:测试文件里除 org/template key 外,`approval_template_groups.id`(全局 `text PRIMARY KEY`,非 org 域内唯一)与批次头 `id` 最初是裸字面量(如 `'atgbb_m6_pos_g'`),不像 org 一样带 `${TS}` 后缀。若某次运行在 `afterAll` 之前异常退出(取消/OOM/超时),会留下一行任何后续运行都清不掉的孤儿行,之后每次重跑都在 `INSERT` 处 23505、常驻转红,直到手工清库——对私有库 `metasheet2_lock_a3`(非一次性 CI 容器)是真实风险。已给全部 10 个 id 字面量补 `_${TS}` 后缀(改为模板字符串),`tsc --noEmit` 与全部 8 例真库测试重新亲跑绿。A-1 的 `lifecycle.db.test.ts` 没有这个面,因为它通过 API 建组(服务端铸 `atg_`+`randomUUID()`),本文件绕过路由直连 DB 才引入了这个手工分配 id 的责任。
3. **M6 反控里的 `/atgbbl_link_fk/` 消息匹配无判别力**:该断言在 CASCADE(已修复)与 NO ACTION(mutation)两种情况下都会通过——只要这次会话对该约束触发过任何一次违反,DROP/ADD 语句与报错文本里都会带这个名字,不区分两种方向。真正承重的是其后 `confdeltype` 恢复检查(mutation 探针实测:正是这一条在 3/8 转红里reddened,消息匹配那条没有)。已在文件里加注释指出这一点,防止后来者把它当"冗余"删掉从而悄悄拆掉这个反控的判别力。

## 15. 续做步骤 9:W7 preview 落地(2026-09-18)

本步只做 §9 验证计划纲要里的 **W7 preview** 这一个最小单元——DDL(§14)已落地;W8 execute / W9 rollback 仍是 remaining,未动。

- **服务层纯函数**(`packages/core-backend/src/services/ApprovalTemplateGroupService.ts`):`classifyBackfillCategory(rawCategory, existingGroupIdByTrimmedName) → { action: 'skip'|'create'|'attach', reason?, trimmedCategory, existingGroupId? }`——§5.2 P3-3(门审 changesRequired)要求的"同一函数返回 skip/create/attach 三态"的落地,纯函数、无 DB 访问。preview 单独看是正确的:preview 没有第二条实现——`classifyBackfillCategory` 就是它唯一的判定点。**但 P3-3 与 changesRequired #3 在 W8 落地时会互相拉扯,本步不去假装这个张力已经解决**:#3 要求 execute 的 storability 判定必须活在 `eligible` SQL 查询内部(`btrim(category) ~ '[!-~]'`),不得是 JS 里的 `continue`;而 P3-3 要求 preview 与 execute "都调用"同一个判定函数。若 W8 按 #3 字面把谓词写进 SQL,execute 端就不会调用 `classifyBackfillCategory`——变成 SQL 里一条谓词 + 本文件一个 JS 判定,两处独立实现(内部的 `pgBtrim`/`STORABLE_GROUP_NAME_PATTERN` 确实是与 SQL 谓词语义对齐但物理独立的两段代码,已用真库验证过 tab/空格等边界一致,§9 测试证据见下)。**这不是"两个独立实现互相校验"的既定设计优点(上一版本这样写是对 P3-3 的过强改写,记忆 `feedback_second_narrower_artifact_is_contract_narrowing` 点名的同类问题)**,而是一个 W8 必须处理的开放义务:要么 W8 的真库测试对同一夹具表同时跑 SQL 谓词与 `classifyBackfillCategory`,断言逐行结果一致(把"独立实现"真正变成"交叉验证"而不只是巧合一致);要么 W8 发现两者在某个边界值上无法调和,升级给门审/owner 裁决 #3 与 P3-3 谁让步。本步只把这个张力显式记录下来,不在此处下结论。
- **路由层**(`packages/core-backend/src/routes/approvals.ts`):新增 `previewApprovalTemplateGroupBackfill(orgId, actor)`(与 `isApprovalTemplateVisibleForGroupLink` 同一惯例,放在路由文件而非服务文件——因为要用这个文件已导入的 `applyTemplateVisibilityFilter`,避免服务文件反向依赖 `ApprovalProductService.ts`)+ 新端点 `GET /api/approval-template-groups/backfill/preview`(`approvalTemplateAdminGuard`,§13.1 #8/§6.2 已裁的默认值)。算法:①候选查询 = §5.1 的 `NOT EXISTS` I2′ 谓词 + `applyTemplateVisibilityFilter`(与 execute 未来要用的候选谓词逐字相同的那一半,视觉可比对);②两遍分类——第一遍用空 map 只求 skip/eligible 与 `trimmedCategory`(§5.2:skip 判定不依赖已存在组);第二遍用真实的 `{trimmedName→existingGroupId}` map(只查询 `archived_at IS NULL` 的活跃组)求最终 create/attach;③按 `trimmedCategory`(buckets)/原始 `category` 文本(skipped,§5.2"未 trim 便于核对")分桶累计 `templateIds`/`templateCount`,排序用**纯代码点比较**(`<`/`>`),不用 `localeCompare`——后者是 locale/ICU 相关的排序,与 SQL `ORDER BY` 在 C 排序规则下的字节序可能不一致(本仓 `finding_prod_pg15_never_tested` 已记录 15-alpine 的 glibc/musl 排序规则活缺口,不能再加一处 JS 侧的隐性排序分歧);④`scope` = `!actor || actor.isTemplateManager ? 'org-complete' : 'visible-to-you'`——这就是 `applyTemplateVisibilityFilter` 自己短路的同一个条件,不是"猜"出来的近似值(§13.1 #16 已裁的语义)。**preview 本身不开事务、不取任何锁**(§5.2:候选查询是快照,不是承诺)。
- **真库测试(新文件)**:`packages/core-backend/tests/integration/approval-template-groups-backfill-preview.db.test.ts`,13 例。多数直接调用导出函数(同 A-3 schema 文件的风格);三例走真实 HTTP(`MetaSheetServer`/`tok`/`httpReq`,同 A-1 lifecycle 套件的配方)——独立 Opus 复核指出路径字符串本身证明不了可达性(记忆 `finding_text_linkage_cannot_prove_src_reachability`),而 §13.1 changesRequired #8 是一条 `ownerLevel=true` 的**已裁默认值**(preview 挂 `approvalTemplateAdminGuard`,偏离 I7 字面读/写二分),本单元的职责正是让这个默认值真实生效,不能只停在源码里的一行注释:
  1. `action='create'`(无同名活跃组)+ 同 category 多模板的 `templateCount`/`templateIds` 汇总正确;
  2. `action='attach'`(btrim 匹配到活跃组)+ `existingGroupId` 正确;
  3. **已归档的同名组不算"存在"**——`action` 仍是 `create`(命中 §4 changesRequired 之外一条隐含要求:`existingGroupIdByTrimmedName` 只收 `archived_at IS NULL` 的组,已在查询谓词里但没有专门测过);
  4. `skipped`:`null` category 与纯空白 category 都落进 `CATEGORY_BLANK_AFTER_TRIM`(各自按原始值单独分桶,§5.2"原始值,未 trim");纯中文 category 落进 `CATEGORY_NOT_STORABLE_AS_GROUP_NAME`(O2 的活缺陷在这里的诚实披露,§13.4 已裁的默认值);
  5. I2′ 人口:已挂接的模板(即使目标组名与另一个候选模板的 category 相同)绝不出现在 `buckets`/`skipped`,只有同 org 内从未挂接过的那个模板出现;
  6. `scope`:manager actor 与 `undefined` actor 都是 `org-complete`;non-manager actor 恒为 `visible-to-you`,**即使这次候选人口里恰好没有一条被藏起来**(断言明确写在测试里:scope 是 actor 的 guard 人口性质,不是"这次数据是否有隐藏行"的事后归纳——记忆 `finding_attendance_denied_renders_as_all_clear` 同型陷阱的反向:silent 完整看起来和 silent 收窄同形,这里反过来防"看起来一样但字段该分叉却没分叉");
  7. **preview 零写**:构造一次同时产出 `buckets` 与 `skipped` 的调用前后,`approval_template_groups`/`approval_template_group_links` 两张表按 org 过滤的行数逐位对比不变;再调一次(等幂,因为它本来就不写)行数仍不变;
  8. **pgBtrim 与 Postgres 单参 `btrim(text)` 的真库现场校验**(独立复核指出这一点此前只是源码注释里的断言,记忆 `feedback_asserted_invariant_is_a_bug`):`psql … -c "SELECT btrim(E'\t HR \t') = E'\t HR \t'"` → `t`(现场核对,不是转述文档),证实制表符不被单参 `btrim` 裁掉;夹具用一个纯 tab category(落 `CATEGORY_NOT_STORABLE_AS_GROUP_NAME`,不是 `CATEGORY_BLANK_AFTER_TRIM`——若用 `.trim()` 会误判成后者)和一个 tab 包住 `HR` 的 category(自成一桶,不与纯 `'HR'` 的桶合并)——这是本文件其余夹具(全部用 ASCII 空格或非 ASCII 内容)唯一一个 `.trim()` 与 `pgBtrim` 会给出不同答案的边界,此前零覆盖;
  9. **排序断言(续做步骤 10 修正)**:首版夹具 `'zebra'/'Apple'/'100'` 被独立复核指出无判别力——`'Apple'.localeCompare('zebra')` 在本机 Node/ICU 下与代码点序**结果相同**(现场核对:`node -e "console.log(['Zebra','apple'].sort((a,b)=>a.localeCompare(b)), ['Zebra','apple'].sort((a,b)=>a<b?-1:a>b?1:0))"` 先对旧版 `'zebra'/'Apple'` 求值确认两者一致,再换 `'Zebra'/'apple'` 求值得到 `['apple','Zebra']` vs `['Zebra','apple']`——**两者不同**),命中记忆 `feedback_ineffective_mutation_looks_like_a_useless_test`。已换成 `'Zebra'/'apple'/'100'`(大小写互换)这一组能实测分辨的夹具,断言 `['100','Zebra','apple']`;**已现场 mutation**:把 `byCategoryCodePoint` 现场改回 `localeCompare`,该断言转红(`['100','apple','Zebra']` vs 期望 `['100','Zebra','apple']`),`cp` 备份/`cmp` 还原后重新亲跑全绿;
  10–12. **路由接线(真实 HTTP)**:admin 角色 200 且响应体含 `{scope,buckets,skipped}`;仅持 `approvals:read`(无 `approval-templates:manage`)的非管理员 403——**这是判别力所在的一条**:若端点被误接成 `rbacGuard('approvals:read')`,这条会转绿(已现场 mutation 验证,见下一条);未认证请求 401。
- **mutation 探针(遵守硬规矩,两轮)**:①`cp` 备份 `routes/approvals.ts` → 在 `previewApprovalTemplateGroupBackfill` 里现场插入两条真实写语句(一条空对象更新 + 一条真实 `INSERT INTO approval_template_groups`)→ 单独重跑"preview 零写"这一条 → **转红**(`{groups:1,links:0}` vs 期望 `{groups:0,links:0}`)→ 清理探针留下的孤儿行 → `cp` 还原源文件 → `cmp` 字节级一致 → 全量重新亲跑绿,证明"preview 从不写"的断言承重。②`cp` 备份 → 把该端点的 guard 现场改成 `rbacGuard('approvals:read')` → 单独重跑"route wiring"这组 → 仅持 `approvals:read` 的非管理员测试**转红**(200 而非期望的 403,manager 与未认证两条不受影响)→ `cp` 还原 → `cmp` 字节级一致 → 重新亲跑全绿,证明 guard 断言本身在真实误接线下会现形,不是只验证了"代码里写了这个 guard 名字"。
- **CI 两点接线 + 第三点 + s6a 重钉**(同 §14 的既有模式,新文件独立一份、不复用 A-1 两个既有文件"仅靠 bash `:?`"的已披露残留):
  - `vitest.config.ts` 的 `exclude` 数组新增 `tests/integration/approval-template-groups-backfill-preview.db.test.ts`;
  - `.github/workflows/plugin-tests.yml` 的 `approval-real-db-integration` 步骤整文件参数列表末尾追加同一文件;
  - 新增 `scripts/ops/approval-template-groups-backfill-preview-ci-wiring.test.mjs`(与 `approval-template-groups-backfill-schema-ci-wiring.test.mjs` 同形状:两点接线 + 文件存在性 + "不得误连到 multitable 真库步骤"反例),并在 `plugin-tests.yml` 的无 DB `test` job 新增一步 `A3 backfill-preview CI wiring contract` 去 `node --test` 它;**已现场 mutation**:临时注释掉 `vitest.config.ts` 的该 exclude 行,新守卫的第一条断言转红,`cp` 备份/`cmp` 还原后重跑转绿。
  - **`scripts/ops/ci-realdb-step-contract.mjs` 无"FILES 闭世界"这样一个具名导出**(现场核对:`grep -n "^export const FILES\|const FILES =" scripts/ops/ci-realdb-step-contract.mjs` 零命中)——该模块的真实机制是本仓这条 lane 已经建立的"每个新 `.db.test.ts` 各自一份独立 `*-ci-wiring.test.mjs`"惯例(§14 的 schema 文件即先例),不是一个需要同步的集中清单;按此惯例本步新增了一份,而不是编造一个不存在的 FILES 数组去改。
  - 由于改了 `plugin-tests.yml`,同一提交重算 s6a `pluginTestsWorkflow` 钉:`shasum -a 256 .github/workflows/plugin-tests.yml` 从 `33befe4d…` 变为 `4c32b7ef…`,已写回 `s6a-package-provenance-pins.json`;改前 `node --test plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs` 亲跑转红(`SEALED_EXPORT_INTERNAL_ERROR`),改后重跑转绿。
  - **回归扫掠**:`node --test scripts/ops/*-ci-wiring.test.mjs` 全量 482 例(含 T2-Gate collision-mechanism 的合成变异套件)亲跑,0 失败——确认本步对 `plugin-tests.yml`/`vitest.config.ts` 的编辑没有撞坏任何兄弟 lane 的接线守卫。
- **回归证据(A-1 两个既有真库文件 + 本切片 schema 文件,未改动,亲跑)**:`DATABASE_URL=postgresql://localhost:5432/metasheet2_lock_a3 EXPECT_DB=1 npx vitest --config vitest.integration.config.ts run tests/integration/approval-template-groups-lifecycle.db.test.ts tests/integration/approval-template-groups-serialization.db.test.ts tests/integration/approval-template-groups-backfill-schema.db.test.ts tests/integration/approval-template-groups-backfill-preview.db.test.ts --reporter=dot`(`packages/core-backend` 内)→ `Test Files 4 passed (4)` / `Tests 47 passed (47)`(16+10+8+13)。
- `npx tsc --noEmit -p tsconfig.json`(`packages/core-backend`)对本步全部改动文件零错误。
- **未做**(remaining):W8 execute(含 `beginApprovalTemplateGroupTxn` 品牌类型、批次头 `GET …/backfill/batches` 列表端点、changesRequired #13 的三条组合调用判别力测试、上文"W8 义务"段点名的 SQL-谓词 vs `classifyBackfillCategory` 交叉验证)、W9 rollback;A-1 两个既有真库文件补 `*-ci-wiring.test.mjs`(§9/P3-2 已披露残留,不在本步范围);验证 MD(§13.7,仍不存在)。**以下两点是本步(续做步骤 10,独立复核指出)新增的披露,均不在本步现场改代码,只记录**:
  1. **preview/execute 在规模上界上会分道**:changesRequired #12 只给 execute 定了 500 条候选的硬上界(`APPROVAL_TEMPLATE_GROUP_BACKFILL_TOO_LARGE`,400,零行写入);preview 没有这个上界,也不在响应里标"候选数是否已过线"。一个有 600 条 eligible 模板的 org,preview 会照常展示全部 600 条"将建/将挂"的清单,而随后调用 execute 会 400——这正是 §5.2"preview 与 execute 必须共用同一条 SQL,否则展示与实际不一致"这个论证本身要防的失配,只是这次是从"规模上界"这条路绕过去的,不是从"分类谓词不同"绕过去的。是否要给 preview 也加同一条 500 上界的提示(比如响应体加 `candidateCount`/`overLimit` 字段),还是接受"preview 可能展示一个 execute 不会真的执行的计划"作为已知边界,留给 W8 一并裁决——不在本步现场改。
  2. **`skipped` 桶把 `null` category 与字面量空串 `''` 合并成一个条目**:两者的 `row.category ?? ''` 都映射到同一个桶键 `''`,导致响应里"这个模板从没设过 category"与"这个模板的 category 显式存了一个空字符串"分不出来——§5.2"原始值,未 trim,便于管理员核对哪一行没被处理"这条理由原本就是为了保留这种区分度,这里丢了一部分。没有夹具覆盖这一点。是否需要用一个哨兵值(如 `category: null` 单独返回,而非折成 `''`)区分两者,留给下一实现单元或门审裁决。
- **对上一次续做步骤(9)的一处措辞更正**:该步提交说明(commit `d15dbe362`)描述 guard mutation 探针时写"observing it turn green"——这是误写,实测方向是**转红**(把 guard 现场改成 `rbacGuard('approvals:read')` 后,`approvals:read`-only 非管理员那条断言从期望的 403 变成收到 200,断言本身转红;`cp` 还原后重新亲跑才转绿)。本文档正文(见上一条 mutation 探针段)一直是对的;仅那条提交说明的英文转述有误,记此更正,不改已推送的提交(硬规矩:不 amend 已推送提交)。

## 16. 续做步骤 11:`AtgTxClient` 品牌类型落地(§13.2 changesRequired #10,W8 编译期前提)

本步只做**这一个**最小单元:落地 §13.2 逐字给出的 SET 义务品牌类型方案,把 `beginApprovalTemplateGroupTxn(client) → AtgTxClient` 变成 W8 execute/rollback 唯一合法的取事务方式;**不写 execute/rollback 本身**(算法、路由、`.db.test.ts`、CI 两点接线均仍是 remaining,见下)。

- **落地**(`packages/core-backend/src/services/ApprovalTemplateGroupService.ts`):
  - `declare const ATG_TX_BRAND: unique symbol` + `export type AtgTxClient = TxClient & { readonly [ATG_TX_BRAND]: true }`(`:109-110`)——纯类型层面的品牌,不存在任何运行时对象真的带这个 symbol 属性键,所以任何非经 `beginApprovalTemplateGroupTxn` 产出的值结构性地缺这个必需属性,赋值处直接编译期报错(见下方 mutation 证据),这正是门审驳回 `current_setting('transaction_isolation')` 运行时断言、要求"忘发 SET 变成 typecheck 红"这句话的字面落地。
  - `export async function beginApprovalTemplateGroupTxn(client: TxClient): Promise<AtgTxClient>`(`:126`)——唯一生产者,发 `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` 后把同一个 `client` 断言成 `AtgTxClient` 返回。
  - 三个 `...WithClient` 原语签名的 `client` 参数类型从 `TxClient` 改为 `AtgTxClient`:`createApprovalTemplateGroupWithClient`(`:265`)、`archiveApprovalTemplateGroupWithClient`(`:342`)、`linkApprovalTemplateToGroupWithClient`(`:462`)——§13.2 原文是"三个 `...WithClient` 只接受该类型",不是"需要 SET 的那两个",本步按字面全落,不做"link 本来不需要 SET 所以只改两个"这种收窄(记忆 `feedback_second_narrower_artifact_is_contract_narrowing`:另造更窄同类物是合同变更,不是实现者裁量)。
  - 三个薄封装(`createApprovalTemplateGroup:288`、`archiveApprovalTemplateGroup:379`、`linkApprovalTemplateToGroup:516`)的 `transaction(async (client) => { await client.query('SET ...'); return xWithClient(client, ...) })` 改写成 `transaction(async (client) => { const txClient = await beginApprovalTemplateGroupTxn(client); return xWithClient(txClient, ...) })`——`create`/`archive` 只是把内联的 SET 语句换成同一条语句的函数封装,行为不变;`link` 是唯一有实质变化的一个,见下条披露。

- **已披露偏离(不是静默的,现场标注在 `:516` 上方注释)——link 薄封装新增一条它此前从不发的 SET**:重构前 `linkApprovalTemplateToGroup` 是 `transaction((client) => linkApprovalTemplateToGroupWithClient(client, ...))`,全程不发 SET(link 不取 L0,§2 锁序表本就不要求它对隔离级别敏感)。§13.2 "三个都只接受 `AtgTxClient`"没有给 link 开口子,而 `AtgTxClient` 只能经 `beginApprovalTemplateGroupTxn` 产出——所以 link 薄封装现在每次调用都会多发一条 `SET TRANSACTION ISOLATION LEVEL READ COMMITTED`。这是一条真实的、非零的协议变化(多一次网络往返的语句),不是"重构等价"的例外;§3.0 file-header 原文"语句、顺序、错误映射逐字不变"的承诺对 link 这条路径不再字面成立,本节与 `:516` 上方注释都现场记这条偏离,不藏进 diff 里。**理由**:门审 changesRequired #10 是 ownerLevel=false(已裁,非待裁),字面"三个都要"没有给 link 一个排除条款;把它读成"只有两个需要"是本实现者自行narrow 掉门审已经拍板的范围,属于越权收窄,不属于本步可以自主决定的空间。若 owner/下一轮门审认为这条新增 SET 不可接受(比如认为 link 高频调用、多一次往返有性能考量),修法是回去改门审裁定本身(把"三个"改成"两个" + 给 `linkApprovalTemplateToGroupWithClient` 单独定义一个不需要品牌的签名),不是本实现者绕开裁定自己决定——留给 owner。

- **正控 mutation(证明品牌真的有判别力,不是"结构上凑巧总能满足")**:`cp` 备份 → 把 `createApprovalTemplateGroup` 薄封装里 `createApprovalTemplateGroupWithClient(txClient, ...)` 的实参从 `txClient` 改回裸 `client` → `npx tsc --noEmit -p tsconfig.json`:

  ```
  src/services/ApprovalTemplateGroupService.ts(297,52): error TS2345: Argument of type '{ query: (sql: string, params?: unknown[]) => Promise<QueryResult<any>>; }' is not assignable to parameter of type 'AtgTxClient'.
    Property '[ATG_TX_BRAND]' is missing in type '{ query: (sql: string, params?: unknown[]) => Promise<QueryResult<any>>; }' but required in type '{ readonly [ATG_TX_BRAND]: true; }'.
  ```

  `cp` 还原 → `cmp` 逐字节比对与备份一致(`IDENTICAL restore OK`)→ 还原后 `tsc --noEmit` 重新零错误。品牌对"跳过 `beginApprovalTemplateGroupTxn` 直接传裸连接"这个具体错误有判别力,不是零判别力的装饰。

- **外部调用面普查(签名收紧前必须确认没有第三方直接传裸 `TxClient` 进来)**:`grep -rln "createApprovalTemplateGroupWithClient\|archiveApprovalTemplateGroupWithClient\|linkApprovalTemplateToGroupWithClient" packages apps plugins --include="*.ts" 2>/dev/null | grep -v node_modules` → 唯一命中 `packages/core-backend/src/services/ApprovalTemplateGroupService.ts` 自身(1 个文件)——三个原语今天只被本文件内的三个薄封装调用,签名收紧不破坏任何调用点。A-1/W7 的四个真库测试文件(`approval-template-groups-lifecycle.db.test.ts`/`-serialization.db.test.ts`/`-backfill-preview.db.test.ts`/`-backfill-schema.db.test.ts`)全部经 `MetaSheetServer` HTTP 路由调用,不直接 import 这三个原语,同一次普查已确认(`grep -n "^import" <四文件>`,均无 `ApprovalTemplateGroupService` 直接导入)。

- **回归验证(§3.0 登记的义务,本步兑现)**:私有库 `metasheet2_lock_a3`(`DATABASE_URL=postgresql://localhost:5432/metasheet2_lock_a3 npx tsx src/db/migrate.ts --list` → `Applied: 408 / Pending: 0`,含 §14 的批次表迁移)上原样重跑 A-1 两个既有真库文件:

  ```
  DATABASE_URL=postgresql://localhost:5432/metasheet2_lock_a3 EXPECT_DB=1 \
    npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-lifecycle.db.test.ts \
    tests/integration/approval-template-groups-serialization.db.test.ts --reporter=dot
  ```

  → `Test Files 2 passed (2)` / `Tests 26 passed (26)`——与 §11/§12 此前重跑的结果一致,link 新增的 SET 没有让 E/K 两个顺序/停车敏感断言变红。顺带重跑 W7 的两个真库文件(`approval-template-groups-backfill-preview.db.test.ts` 13 例 + `-backfill-schema.db.test.ts` 8 例)确认它们同样不受影响 → `Test Files 2 passed (2)` / `Tests 21 passed (21)`(这两个文件不是 §3.0 登记的回归义务对象,重跑只是本步顺手的完整性检查,不算作"新增判别力证据")。

- **本步不新增/不触碰**:任何 `.db.test.ts` 文件、`plugin-tests.yml`、`vitest.config.ts` 的 exclude、s6a 钉(`s6a-package-provenance-pins.json`)、`scripts/ops/ci-realdb-step-contract.mjs` 的 FILES 数组——本步是纯 `.ts` 内部重构 + 复用既有真库文件做回归证据,没有新的真库测试入口需要两点接线,所以补充清单 #1/#2/#3(共用三条)在本步不适用,不是遗漏。

- **未做,原样结转的 remaining(不因本步而缩小)**:W8 execute 的服务函数(§3.1 pseudocode → `.ts`)、`POST …/backfill/execute` 路由、`GET …/backfill/batches` 列表端点(changesRequired #5)、changesRequired #13 的三条组合调用判别力测试(组合正例+反向正控停车/超时;SET 义务格落在 RR 默认池文件;锁序格断言停车点非终态)、§15 记的"SQL 谓词 vs `classifyBackfillCategory` 交叉验证"义务;W9 rollback 全部(§4 pseudocode → `.ts`、事务骨架、rollback 路由);A-1 两个既有真库文件补 `*-ci-wiring.test.mjs`(§9/P3-2 已披露残留);验证 MD(§13.7,仍不存在);step 10 记的两条披露(preview/execute 规模上界分道、`skipped` 桶 `null`/`''` 合并)仍未处理,原样结转给 W8。**本步新增的一条 remaining**:link 薄封装新增 SET 这条偏离是否可接受,留给 owner/下一轮门审(见上文披露段)。

## 17. 续做步骤 17:W8 execute 服务函数 + 路由 + 首批真库验收(2026-09-18)

本步实现 `POST /api/approval-template-groups/backfill/execute`(§3.1、§13.2 统一锁序、changesRequired #2/#3/#9/#11/#12 的 `.ts` 代码化)。**不做**:`GET …/backfill/batches` 列表端点(changesRequired #5)、changesRequired #13 的三条组合调用判别力测试(并发 execute 在 L0 停车 + 反向正控、RR 池 SET 义务格、锁序停车点断言)、规模上界(500)的真库测试、W9 rollback。这些原样结转,见下方 remaining。

**放置位置**:`executeApprovalTemplateGroupBackfillWithClient` / `executeApprovalTemplateGroupBackfill` 落在 `routes/approvals.ts`(不在 `ApprovalTemplateGroupService.ts`)——与 `previewApprovalTemplateGroupBackfill` / `isApprovalTemplateVisibleForGroupLink` 同一理由:`eligible` 查询需要 `applyTemplateVisibilityFilter`,而该 service 文件刻意不 import 它(见该文件已有的同类注释)。

**算法落地要点**(逐条对应 §13.1 changesRequired):
- L0 → `eligible` 查询(I2′ NOT EXISTS + `btrim(category) ~ '[!-~]'` 在 SQL 内部,非循环 `continue` — changesRequired #3)→ 空则 `{batchId:null}` 提交空事务(§3.2 与"两次顺序 execute 幂等"同一代码路径)→ 规模上界(500,超出抛 400 `..._BACKFILL_TOO_LARGE` — changesRequired #12)→ 按 `existingByCategory` 一条 `ORDER BY id FOR UPDATE` 预锁全部既有组(§13.2 统一锁序,changesRequired #1)→ 插批次头 → 逐类目建组/挂接 + 写两张明细表。
- **changesRequired #9 与 #2 的张力,本步现场解决(设计 pseudocode 原文未遇到,因为它内联了 CTE)**:execute 调用 `createApprovalTemplateGroupWithClient` / `linkApprovalTemplateToGroupWithClient`(不抄语句),但 `linkApprovalTemplateToGroupWithClient` 的 JS 返回值 `linkedAt` 已经过 `toIso()`/`toISOString()`(毫秒精度)——直接拿它写批次明细表会重犯 M4 那个 bug。落地做法:仍然调用原语完成挂接本身(L1 `FOR UPDATE` + `archived_at` 校验 + upsert 复用),批次明细表的 `linked_at` 改由**另一条**语句、通过对刚提交行的相关子查询(`SELECT l.linked_at FROM approval_template_group_links l WHERE …`)服务端复制——比 pseudocode 的单条 CTE 多一次往返,换来原语不被抄写。这条决策是本步现场做的,不是门审报告或 pseudocode 原文写明的,**已用一条 mutation 探针验证判别力**(见下方证据段)。
- `mapGroupConstraintError` 现在从 service 文件导出(此前是模块私有函数),包在 `await transaction(...)` 整体调用外面,不在回调内部——changesRequired #11 前半。

**真库测试**(新文件,11 例,`tests/integration/approval-template-groups-backfill-execute.db.test.ts`):happy path(create)、attach path(`created_new=false`)、混合 skip+eligible 同一次调用(CJK 类目被跳过但不阻塞 HR 类目提交——changesRequired #3 的机制主张)、全 skip 的 org 零写入 `batchId:null`、changesRequired #2 的 `linked_at` 字节级相等(原始 SQL `=`,非 JS 相等)、§15 记的 SQL/JS 交叉验证义务(`classifyBackfillCategory` 的 skip 判定逐行对照真实调用后该模板是否被挂接)、幂等(第二次调用五张表零增量)、三条路由级 HTTP 真实请求(admin 201/`approvals:read`-only 403/未认证 401)。

**正控 mutation(cp/mutate/run/cmp-restore,三个,全部按预期变红后按原样还原,md5 一致)**:
1. 把批次明细写入换回 `linkApprovalTemplateToGroupWithClient` 的 JS 返回值 `linked.linkedAt` → changesRequired #2 那条"字节级相等"用例变红(`expected false to be true`)。
2. 把 `eligible` 查询的 `btrim(t.category) ~ '[!-~]'` 谓词整条删除(模拟"循环 continue"式的错误修法)→ 三条用例变红,且失败形状正是门审 M5 实测的原始 bug:`error: new row for relation "approval_template_groups" violates check constraint "atg_name_nonblank"`(`code: '23514'`)——证明这条谓词是防止"CJK 类目让整个 execute 100% 抛错"的机制承重点,不是装饰。
3. 把"`eligible.length === 0` 提前返回"这个分支短路(`if (false && …)`)→ 幂等用例变红:`{batchId: null, ...}` 期望值 vs 实际拿到一个非空 `batchId` 的新建空批次头——这正是 changesRequired #3/#12 附注描述的"每次调用多一行空批次头"失败形状的姊妹版本(这里是"任何一次调用都不检测幂等",不是 CJK 专属)。

每次探针都是 `cp` 备份 → 编辑 → 跑对应用例(`-t` 过滤)→ `cp` 还原 → `cmp` 逐字节核对与备份一致,md5 复核(`0697ab815d6ae81427a564ca7562e603`,还原前后一致)。

**回归证据**(`metasheet2_lock_a3`):
```
DATABASE_URL=postgresql://localhost:5432/metasheet2_lock_a3 EXPECT_DB=1 \
  npx vitest --config vitest.integration.config.ts run \
  tests/integration/approval-template-groups-lifecycle.db.test.ts \
  tests/integration/approval-template-groups-serialization.db.test.ts \
  tests/integration/approval-template-groups-backfill-schema.db.test.ts \
  tests/integration/approval-template-groups-backfill-preview.db.test.ts \
  tests/integration/approval-template-groups-backfill-execute.db.test.ts \
  --reporter=dot
```
→ `Test Files 5 passed (5)` / `Tests 58 passed (58)`(16 + 10 + 8 + 13 + 11)。

**CI 两点接线**(同一提交):`vitest.config.ts` exclude 新增一行;`.github/workflows/plugin-tests.yml` 的 `approval-real-db-integration` 步骤白名单新增一行 + 新增一个独立 `A3 backfill-execute CI wiring contract` 步骤;新文件 `scripts/ops/approval-template-groups-backfill-execute-ci-wiring.test.mjs`(复制自 preview 的同款守卫,换 `FILE` 常量)——已用同款 mutation 验证判别力(注释掉 `vitest.config.ts` 的 exclude 行 → 该守卫的第一条用例变红;还原后再次全绿)。`scripts/ops/*-ci-wiring.test.mjs` 全量重跑:**485 passed(482 + 本文件新增 3 条)**,零红,证明没有扰动任何兄弟 lane 的接线守卫。`scripts/ops/ci-realdb-step-contract.mjs` 再次确认无 `FILES` 闭世界导出(`grep -n "^export const FILES\|const FILES =" scripts/ops/ci-realdb-step-contract.mjs` → 零命中),与 W7 记录一致,本步沿用同一机制(每文件一个独立 `*-ci-wiring.test.mjs`)而非该数组。

s6a `pluginTestsWorkflow` 钉重算(`.github/workflows/plugin-tests.yml` 两处编辑之后):`shasum -a 256 .github/workflows/plugin-tests.yml` → `fb1f5901f256927b723144dc5164f42be1ad3b41eb996f5dae1728fc9100f6d6`(替换旧值 `4c32b7ef...`)。红/绿证据:`node --test plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs` 在改 workflow 文件之后、重算钉之前先跑一次 → `SEALED_EXPORT_INTERNAL_ERROR`(红,drift 被正确检出);写入新钉之后重跑同一条命令 → `sealed-export-package-provenance.test.cjs OK`(绿)。

**本步不新增/不触碰**:`scripts/ops/ci-realdb-step-contract.mjs` 的任何导出(继续沿用逐文件 guard 惯例,不是遗漏);W9 相关任何文件;`GET …/backfill/batches` 端点。

**未做,原样结转的 remaining**:
- changesRequired #13 的三条组合调用判别力测试(并发 execute 在 L0 停车 + 反向正控 `await` 导出函数会停车/超时;SET 义务格落在 RR 默认池文件,mutation=删 `beginApprovalTemplateGroupTxn` 内的 SET 语句;锁序格用 `waitUntilBackendBlockedByHolder` 断言停车点而非终态)——门审原文"同 PR"指的是这条分支未来会开出的 Draft PR,不是这一个提交,但仍是本分支必须在合入前补齐的义务,不因本步而消失。
- `GET /api/approval-template-groups/backfill/batches` 列表端点(changesRequired #5)。
- 规模上界(500)的真库测试(超出触发 400、零写入)——本步只在 `.ts` 里落地了这条分支,未写对应的真库夹具(构造 501 行代价较高,留给后续步骤连同 changesRequired #13 一起补)。
- ~~W9 rollback 全部(§4 pseudocode → `.ts`、事务骨架、rollback 路由、真库测试、CI 两点接线)。~~ **【已求值,续做步骤 12,见 §18】** 落地:`rollbackApprovalTemplateGroupBackfillWithClient` / `rollbackApprovalTemplateGroupBackfillBatch`(`ApprovalTemplateGroupService.ts`)+ 路由 + 11 例真库测试 + 两点 CI 接线 + s6a 重钉。
- A-1 两个既有真库文件补 `*-ci-wiring.test.mjs`(§9/P3-2 已披露残留,未因本步而变化)。
- 验证 MD(§13.7,仍不存在)。
- link 薄封装新增 SET 这条偏离是否可接受(§16 记的 remaining,未因本步而变化,仍待 owner/下一轮门审)。

## 18. 续做步骤 12:W9 rollback 落地(2026-09-18)

本步实现 §4 的 rollback 算法(§13.1 changesRequired #1/#2/#4/#7 已求值的落地对象)+ 路由 + 首批真库验收。**不做**(原样结转,未因本步而变化):changesRequired #13 的三条组合调用判别力测试(§17 已记,现在同样适用于"execute 与 rollback 并发竞争同一把 L0"这个新变体)、`GET …/backfill/batches` 列表端点(changesRequired #5)、规模上界(500)真库测试、A-1 两个既有真库文件补 `*-ci-wiring.test.mjs`、验证 MD(§13.7)。

**放置位置,与 preview/execute 不同**:`rollbackApprovalTemplateGroupBackfillWithClient` / `rollbackApprovalTemplateGroupBackfillBatch` 落在 `ApprovalTemplateGroupService.ts`(不在 `routes/approvals.ts`)——rollback 不需要 `ApprovalTemplateVisibilityActor` / `applyTemplateVisibilityFilter`(它撤销的是批次记录下来的精确状态,与调用者当下的模板可见性范围无关),因此没有preview/execute 被推去 `routes/approvals.ts` 的那条理由。路由处理函数仍然照例注册在 `routes/approvals.ts`(所有端点都在那注册),只是导入的服务函数来自 `ApprovalTemplateGroupService.ts` 而非本文件自己定义。

**算法落地要点(逐条对应 §13.1 changesRequired,§4 pseudocode → 代码)**:
- §13 changesRequired #1(事务骨架):L0 → 批次头 `FOR UPDATE`(不存在→404;`rolled_back_at IS NOT NULL`→409)→ 只读取本批次触达的全部 group id(`UNION` 两张子表)→ §13.2 统一锁序的"一条 `ORDER BY id FOR UPDATE`"预锁全部既有组 → §4.2 的 L2 写 → §4.3 的归档判定(复用上一步的预锁快照,不第二次 `FOR UPDATE`)→ 批次头 `rolled_back_at = now()` → COMMIT。
- §4.1(不调用 `unlinkApprovalTemplateFromGroup` / `archiveApprovalTemplateGroupWithClient`,因为两者都是无条件的,会撤销批次外状态)与"仍要求全仓只有一份语句文本"之间的张力,本步的落地做法:把 `archiveApprovalTemplateGroupWithClient` 内联的两条语句(unlink-all-members / archive-group-row)提成两个**命名导出的 SQL 文本常量**(`ATG_UNLINK_ALL_GROUP_MEMBERS_SQL` / `ATG_ARCHIVE_GROUP_ROW_SQL`),而不是一个共享函数——原因是两个调用点需要在**不同的锁前提**下执行同一段文本:`archiveApprovalTemplateGroupWithClient` 自己的调用点在紧邻语句里持有 `FOR UPDATE`;rollback 的调用点复用的是骨架预锁步骤已经拿到的行锁,不能再发第二次 `FOR UPDATE`(见下一条)。`archiveApprovalTemplateGroupWithClient` 本身也改为调用这两个常量(不是复制文本两份),因此这一步顺带是一次无行为变化的重构。
- §13 changesRequired #2(§4.2 落地,令牌全程不经 JS):`UPDATE approval_template_group_links l SET group_id = NULL, unlinked_at = now() FROM approval_template_group_backfill_batch_links b WHERE b.batch_id = $1 AND b.org_id = l.org_id AND b.template_id = l.template_id AND l.group_id = b.group_id AND l.linked_at = b.linked_at` —— 一条集合式服务端 join,`group_id` 与 `linked_at` 两列都在 SQL 内部比较,从未经过 JS。
- §4.3 落地:对每个 `created_new = true` 的 `(group_id)`,从骨架预锁步骤的快照里读 `archived_at`(不存在或非 NULL 则跳过,不报错)→ `SELECT count(*) … WHERE unlinked_at IS NULL` 算 `remaining` → `remaining = 0` 才执行 `ATG_UNLINK_ALL_GROUP_MEMBERS_SQL` + `ATG_ARCHIVE_GROUP_ROW_SQL`(顺序上 §4.2 已经先跑完,所以 `remaining` 不会把本批次自己刚解除的成员算进去)。
- §13 changesRequired #7(已裁,ownerLevel=false):已回滚批次再次调用 → 409 `APPROVAL_TEMPLATE_GROUP_BACKFILL_BATCH_ALREADY_ROLLED_BACK`,`ServiceError` 的 `details.rolledBackAt` 带上第一次回滚的时间戳(经 `sendServiceError` 落进响应体 `error.details.rolledBackAt`)——不是幂等 200。
- 404 `APPROVAL_TEMPLATE_GROUP_BACKFILL_BATCH_NOT_FOUND`:批次头查询的 `WHERE` 本身带 `org_id = $2`,不存在与"存在但属于别的 org"两种情况走同一条路径(同文件其余每个 org 域查询的惯例)。

**真库测试**(新文件,11 例,`tests/integration/approval-template-groups-backfill-rollback.db.test.ts`):sentinel、happy path(创建路径的组归档 + 链接解除 + `rolled_back_at` 落地且与响应体逐字节一致)、attach 路径(`created_new=false` 的组即使回滚后零成员也不归档)、§4/§9 精确性的两种正面形态各一例——批次外**新增**成员使批次创建的组在回滚后存活(`remaining>0`)、批次外**移动**(挂到另一个组)让该链接的令牌不再匹配从而被跳过(且原组因此确实清空而被合法归档,不是 rollback 误伤)——以及新增的第三种精确性例:批次外**原地解除再重新挂回同一个组**(group_id 不变、linked_at 是新的)必须被跳过,这是 §4.2 令牌里 `linked_at` 那一半单独的判别力证据(前一个"移动"例的 `group_id` 本身就已经不同,不能证明 `linked_at` 有没有在起作用)、changesRequired #7 的 409 + `details.rolledBackAt`、跨 org batchId 与不存在 batchId 同归 404、三条路由级 HTTP 真实请求(admin 200/`approvals:read`-only 403/未认证 401)。

**正控 mutation(cp/mutate/run/cmp-restore,两个,全部按预期变红后按原样还原,md5 一致 `8b8767516d49c4bd31bde05dd007cfe8`)**:
1. 把 §4.2 UPDATE 的 `AND l.linked_at = b.linked_at` 删除(只留 `group_id` 匹配)→ **恰好 1 条**用例变红("detached and re-linked to the SAME group"那一条,`expected null to be 'atg_...'`)——证明 `linked_at` 半个谓词是这条用例唯一的判别力来源,不是装饰;"moved to a different group"那条**不会**因为这个 mutation 变红(`group_id` 本身已经不同),这是本节第一段特意把两种精确性测试分开写的原因。
2. 把 §4.3 的 `remaining === 0` 判断改成 `if (true)`(始终归档)→ **恰好 2 条**用例变红:批次外新增成员那条(组被误归档,`archived_at` 从 `null` 变成时间戳)与"原地解除再挂回"那条(归档语句里的 `ATG_UNLINK_ALL_GROUP_MEMBERS_SQL` 把外部重新挂回的成员也强制解除,级联误伤)——happy path 与 attach 路径两条不受影响(前者本来就该归档,后者 `created_new=false` 从不进入这个分支)。
每次探针都是 `cp` 备份 → 编辑 → 跑对应用例 → `cp` 还原 → `cmp` 逐字节核对与备份一致。

**回归证据**(`metasheet2_lock_a3`,A-1 两个既有真库文件 + 本切片全部四个 W7/W8/W9/schema 文件一起跑作回归):
```
DATABASE_URL=postgresql://localhost:5432/metasheet2_lock_a3 EXPECT_DB=1 \
  npx vitest --config vitest.integration.config.ts run \
  tests/integration/approval-template-groups-lifecycle.db.test.ts \
  tests/integration/approval-template-groups-serialization.db.test.ts \
  tests/integration/approval-template-groups-backfill-schema.db.test.ts \
  tests/integration/approval-template-groups-backfill-preview.db.test.ts \
  tests/integration/approval-template-groups-backfill-execute.db.test.ts \
  tests/integration/approval-template-groups-backfill-rollback.db.test.ts \
  --reporter=dot
```
→ `Test Files 6 passed (6)` / `Tests 69 passed (69)`(16 + 10 + 8 + 13 + 11 + 11)。

**CI 两点接线**(同一提交):`vitest.config.ts` exclude 新增一行;`.github/workflows/plugin-tests.yml` 的 `approval-real-db-integration` 步骤白名单新增一行 + 新增一个独立 `A3 backfill-rollback CI wiring contract` 步骤;新文件 `scripts/ops/approval-template-groups-backfill-rollback-ci-wiring.test.mjs`(复制自 execute 的同款守卫,换 `FILE` 常量)——已用同款 mutation 验证判别力(注释掉 `vitest.config.ts` 的 exclude 行 → 该守卫的第一条用例变红;还原后再次全绿)。`scripts/ops/*-ci-wiring.test.mjs` 全量重跑:**488 passed(485 + 本文件新增 3 条)**,零红。`scripts/ops/ci-realdb-step-contract.mjs` 再次确认无 `FILES` 闭世界导出(`grep -n "^export const FILES\|const FILES =" scripts/ops/ci-realdb-step-contract.mjs` → 零命中),与 W7/W8 记录一致,本步沿用同一机制。

s6a `pluginTestsWorkflow` 钉重算(`.github/workflows/plugin-tests.yml` 两处编辑之后):`shasum -a 256 .github/workflows/plugin-tests.yml` → `b25d5b95a94633daa4873b7c20db65e0e5641fcd2297edc1c7798ea4205dac19`(替换旧值 `fb1f5901...`)。红/绿证据:`node --test plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs` 在改 workflow 文件之后、重算钉之前先跑一次 → `SEALED_EXPORT_INTERNAL_ERROR`(红,drift 被正确检出);写入新钉之后重跑同一条命令 → `sealed-export-package-provenance.test.cjs OK`(绿)。

`npx tsc --noEmit`(`packages/core-backend`)全量重跑:零错误。

**本步不新增/不触碰**:`scripts/ops/ci-realdb-step-contract.mjs` 的任何导出;`GET …/backfill/batches` 端点;changesRequired #13 的三条组合调用判别力测试;规模上界(500)真库测试;apps/web(本切片全程无前端改动,没有需要接进 `run-required-web-tests.sh` 的新 spec)。

**两点自查(独立复核追加,未改代码)**:
1. `ATG_UNLINK_ALL_GROUP_MEMBERS_SQL` 是从 `archiveApprovalTemplateGroupWithClient` 原地内联的同一段文本剪切出来的,单行,与原文本逐字节相同(`git show HEAD -- .../ApprovalTemplateGroupService.ts` 核对,removed/added 两行字符完全一致,只是从模板字符串换成了普通字符串)。`ATG_ARCHIVE_GROUP_ROW_SQL` 是多行模板字符串,提成顶层常量后其内部缩进从原来的 7 空格变成 3 空格——**这两处缩进空白本身也会进 SQL 文本**(多出/少了几个空格字符),所以这条常量与原文本不是逐字节相同,只是在 SQL 语义上等价(WHERE/RETURNING 前的空白对 Postgres 解析无意义)。上一段"顺带是一次无行为变化的重构"这句话说的是行为(执行结果)不变,不是文本字节不变——本条把两者分开写清楚,避免读成"两处提取都是纯剪切"。该行为不变的证据是 §17/本步共用的回归套件里 `approval-template-groups-lifecycle.db.test.ts`(16 例)与 `serialization.db.test.ts`(10 例)两个文件本身就覆盖 `archiveApprovalTemplateGroupWithClient` 的行为,本步重跑两者全绿(见上方回归证据的 69/69),不是一句未经检验的断言。
2. 本函数文件头注释与 §4.3 循环内注释引用的"design-gate M3"是门审阶段对**修法前**伪代码顺序(§4.2 先做、再对组发第二次 `FOR UPDATE`)的真实复现(`reviews/a3-probe/rollback-lockorder-probe.cjs`,已记入 §4.3 正文)——这是已验证的历史事实,不是本步凭空断言。但"§13.2 统一锁序让**本步落地的这段新代码**在真实并发下确实不会重蹈同一个死锁"这句推论,本步**没有**用一个并发探针去逐字重新验证(标准"排序取锁避免死锁"论证,不是可疑推断,但仍然是"论证",不是"实测")——这正是下方 remaining 第一条 changesRequired #13 尚未做完的部分,该义务覆盖的范围比 §17 记录时更宽(见下方)。

**未做,原样结转的 remaining(按次序:前两条是本步遗留的义务,后四条是继承自更早步骤、未因本步变化)**:
- changesRequired #13 的三条组合调用判别力测试——现在覆盖面比 §17 记录时更宽:除了"并发 execute"变体,还需要"execute 与 rollback 并发竞争同一把 L0"、"rollback 与手工建组/归档并发竞争同一把 L0"两个新变体,三者共用同一把 `atg:${orgId}` advisory lock,判别力测试的 fixture 需要覆盖这三种两两组合,不只是本切片三个函数各自独立起一次。门审报告把这条列为合入前必须补齐的义务(见上方"两点自查"第 2 条),不是可选项。
- ~~`GET /api/approval-template-groups/backfill/batches` 列表端点(changesRequired #5)——第三次原样结转……建议列为下一步的第一候选。~~ **求值(续做步骤 18,§19):已落地。** `listApprovalTemplateGroupBackfillBatches`(`ApprovalTemplateGroupService.ts`)+ 路由(`routes/approvals.ts`)+ 8 例真库测试(`approval-template-groups-backfill-batches-list.db.test.ts`)+ CI 两点接线 + s6a 重钉,详见 §19。这条 remaining 的判断本身是对的——"已可达但没有出口"确实是本切片自己制造的缺口,不是测试覆盖缺口——本步按建议把它接住了。
- 规模上界(500)真库测试(execute 侧,未因本步而变化)。
- A-1 两个既有真库文件补 `*-ci-wiring.test.mjs`(§9/P3-2 已披露残留,继承自 A-1,未因本步而变化)。
- 验证 MD(§13.7,仍不存在)——现在 W7/W8/W9 三个单元都已落地,补这份 MD 的紧迫性比 §17 时更高,留给下一步或 owner 决定是否现在补。
- link 薄封装新增 SET 这条偏离是否可接受(§16 记的 remaining,继承自更早步骤,未因本步而变化,仍待 owner/下一轮门审)。

## 19. 续做步骤 18:changesRequired 对账表(核代码,非重读文档)+ 批次列表端点落地(2026-09-18)

本步先按任务书要求,把 §13.1/Q1–Q7/额外 P1-P2 逐条**对着当前分支的实际代码**(`grep`/`sed` 现场核对,而不是重读 §13.1 自己的旧文本)复核一遍,再落地发现的唯一真实缺口。方法论:上一次 §13.1 表是在续做步骤 4(设计落地当天)写的,此后 W7/W8/W9 三个实现步骤(续做步骤 17/5/12)各自零散更新过其中几格,没有一次从头核对全表——这正是记忆 `feedback_acceptance_criteria_set_must_be_self_consistent` 点名的形状:表格自己内部会累积没有跟着代码走的陈述。

### 19.1 对账表(逐条核代码,`@commit` 为落地时的提交,`HEAD` 指本步核对时的 `e116dced1`)

| 项 | 判据 | 落地证据(本步现场 grep/读码) | 状态 |
|---|---|---|---|
| Q1 三表 FK(含 `batch_links→links` CASCADE) | `atgbbl_link_fk … ON DELETE CASCADE` | `zzzz20260919090000_create_approval_template_group_backfill_batches.ts`:`atgbbl_link_fk FOREIGN KEY (org_id, template_id) REFERENCES approval_template_group_links (org_id, template_id) ON DELETE CASCADE` | **已落地 @`02775e95f`** |
| Q2 preview 挂 `approvalTemplateAdminGuard` | 非 `rbacGuard('approvals:read')` | `routes/approvals.ts:1547`:`r.get('/api/approval-template-groups/backfill/preview', authenticate, approvalTemplateAdminGuard, …)` | **已落地 @`d15dbe362`** |
| Q3 分桶键 `btrim`、不折大小写 | `pgBtrim` 精确复刻 SQL 单参 `btrim`,`STORABLE_GROUP_NAME_PATTERN` 不含大小写归一 | `ApprovalTemplateGroupService.ts:598-613`(`pgBtrim` / `STORABLE_GROUP_NAME_PATTERN`) | **已落地 @`d15dbe362`** |
| Q4 重复 rollback 409+专用码+`rolledBackAt` | 抛 `ServiceError(409, 'APPROVAL_TEMPLATE_GROUP_BACKFILL_BATCH_ALREADY_ROLLED_BACK', {rolledBackAt})` | `ApprovalTemplateGroupService.ts:708-713` | **已落地 @`d2e96e833`** |
| Q5(三条 FK 逐条裁定) | 同 Q1,另两条维持 NO ACTION | 同上迁移文件,`atgbbg_group_fk … ON DELETE NO ACTION` | **已落地 @`02775e95f`** |
| Q6 品牌类型 typecheck 门 | `AtgTxClient` unique-symbol 品牌 + `beginApprovalTemplateGroupTxn` 唯一发 SET | `ApprovalTemplateGroupService.ts:110`(`export type AtgTxClient = TxClient & { readonly [ATG_TX_BRAND]: true }`)+`:126`(`beginApprovalTemplateGroupTxn`) | **已落地 @`06ac4927e`** |
| Q7 execute/rollback 锁序 L0→L1→L2 且 40P01 有映射 | 一条 `ORDER BY id … FOR UPDATE` 预锁 + `mapGroupConstraintError` 套在整个 `transaction()` 外 | `routes/approvals.ts:661`(execute 预锁)+`ApprovalTemplateGroupService.ts:732`(rollback 预锁)+`routes/approvals.ts:724,739`(catch 包裹范围的文件头注释与实际 `throw mapGroupConstraintError(error)`) | **已落地 @`f96411589`/`d2e96e833`** |
| 额外 P1 `linked_at` 令牌全程不经 JS | 写入侧服务端相关子查询,回滚侧集合式 join,两端都不读原语的 JS 映射返回值 | `routes/approvals.ts:704-710`(execute 写入侧,`SELECT … FROM approval_template_group_links l WHERE …` 相关子查询,不是原语返回值)+`ApprovalTemplateGroupService.ts:746-753`(rollback 侧 `UPDATE … FROM … WHERE l.linked_at = b.linked_at`) | **已落地 @`f96411589`/`d2e96e833`**(写入侧用相关子查询而非门审建议原文的数据修改 CTE,语义等价——都不经过 JS `Date`往返,§17 已有 mutation 证据,本步未重新验证 mutation,只核对了语句形状) |
| 额外 P1 批次列表端点 `GET …/backfill/batches` + 索引 | 索引已在 §2.1 DDL;端点此前**不存在**(`grep -n "backfill/batches" src/routes/approvals.ts` 在本步开始时只命中 `:batchId/rollback` 一行) | 本步新增,见 §19.2 | **本步(续做步骤 18)落地,此前是 §13.1 表的一处错误"已落地"记录,见 §19.3 的勘误说明** |
| 额外 P2 COMMIT 阶段 23505 映射在 transaction 之外 + §7 补 `GROUP_SORT_CONFLICT` | `mapGroupConstraintError` 包裹整个 `await transaction(...)`,不逐语句 catch | `routes/approvals.ts:724`(文件头注释明写"wraps this ENTIRE `await transaction(...)` call, not any individual statement inside it")+`:739` | **已落地 @`f96411589`** |
| 额外 P2 execute 规模上界 | `APPROVAL_TEMPLATE_GROUP_BACKFILL_MAX_CANDIDATES = 500` + 400 抛错 | `routes/approvals.ts:554,626-631` | **pseudocode+`.ts` 已落地 @`f96411589`;真库测试见 §20(续做步骤 19)——本表这一格此前"仍未覆盖"的记录已过期,不再回改本行文字,按 §19.3 的勘误惯例只在此追加指针** |
| 额外 P1 CJK category 炸整批 | `classifyBackfillCategory` 对不可入库 category 返回 `skip`,execute 的 `eligible` 谓词层面排除,不是循环 `continue`/抛错 | `ApprovalTemplateGroupService.ts:613,634-636`(`STORABLE_GROUP_NAME_PATTERN` / `CATEGORY_NOT_STORABLE_AS_GROUP_NAME`) | **已落地 @`d15dbe362`(preview)/`f96411589`(execute 复用同一函数)** |

**对账结论**:16 条 changesRequired 里,15 条在本步核对前就已经在代码里落地(散布在续做步骤 5/8/9/11/12/16/17,只是 §13.1 表的几处文字没跟上——已在 §13.1 现场勘误,见上方 changesRequired #1/#9 的表格编辑),唯一**代码层面真实未落地**的是 changesRequired #5 的 `GET …/backfill/batches` 路由本体(索引早就有了)。changesRequired #16(A-1 回流)、#13(组合调用判别力测试三件套)、跨 lane 项(P1-3/#5852 回流)不在本步权限/范围内,维持 remaining,见下方。

### 19.2 本步新增代码:批次列表端点(changesRequired #5 / P1-5)

- **服务函数** `listApprovalTemplateGroupBackfillBatches(orgId, limit, offset)`(`ApprovalTemplateGroupService.ts`,追加在文件末尾,W9 rollback 之后):只读、不取锁(§2 锁序表"只读路径不取 L0"惯例,同 `listApprovalTemplateGroups`),`ORDER BY created_at DESC, id DESC`(`id DESC` 是确定性并列断线,`..._backfill_batches_org_created_idx` 覆盖 `(org_id, created_at DESC)` 这半);`total` 来自独立的 `count(*)` 查询,与分页页大小无关。
- **路由** `GET /api/approval-template-groups/backfill/batches`(`routes/approvals.ts`,注册在 rollback 路由之后):与其余三个 backfill 端点同一个 `approvalTemplateAdminGuard`(§6.1/§6.2 现场标注的裁定原样适用——它和 preview 同属"写操作的伴随读",不是 `rbacGuard('approvals:read')` 的浏览端点),`limit`/`offset` 走本文件既有的 `parsePaging` helper(与 `record-link-options` 端点同款,`limit` 上界 100)。
- **真库测试**(新文件,8 例,`tests/integration/approval-template-groups-backfill-batches-list.db.test.ts`):sentinel;`created_at DESC`排序+limit/offset 分页(对**直接插入、时间戳可控**的三行断言,不依赖两次 `execute` 调用之间的真实时钟间隔——`now()` 在两个独立事务里相隔微秒不是可靠的排序 oracle);`rolledBackAt` null↔ISO 字符串往返(一行手工置 `rolled_back_at`,断言 `toISOString()` 逐字节匹配);org 域隔离(外域批次不计入 `total` 也不出现在 `batches`);三条路由级 HTTP 测试(admin 200 且 rollback 前后 `rolledBackAt` 真实翻转、跨 org HTTP 隔离、`approvals:read`-only 403、未认证 401)。
- **正控 mutation(cp/mutate/run/cmp-restore,两个)**:
  1. `ORDER BY created_at DESC, id DESC` → `ORDER BY created_at ASC, id ASC`:**恰好 1 条**("orders by created_at DESC…")变红,其余 7 条不受影响。
  2. 第二条 `SELECT … WHERE org_id = $1` → `WHERE org_id = $1 OR $1 = $1`(等价于去掉 org 过滤,但 `count(*)` 查询保持不变作为对照):**恰好 2 条**变红("org 域隔离"单元测试 + "跨 org HTTP 隔离"路由测试),其余 6 条不受影响——两次 mutation 合计验证了排序与 org 过滤各自的判别力,不是装饰性断言。
  两次探针均 `cp` 备份 → 编辑 → 跑 → `cp` 还原 → `cmp` 逐字节核对与备份一致(两次均确认 `RESTORE BYTE-IDENTICAL`)。
- **回归证据**(`metasheet2_lock_a3`,A-1 两个既有真库文件 + 本切片全部五个 W7/W8/W9/schema/list 文件一起跑):

```
DATABASE_URL=postgresql://localhost:5432/metasheet2_lock_a3 EXPECT_DB=1 \
  npx vitest --config vitest.integration.config.ts run \
  tests/integration/approval-template-groups-lifecycle.db.test.ts \
  tests/integration/approval-template-groups-serialization.db.test.ts \
  tests/integration/approval-template-groups-backfill-schema.db.test.ts \
  tests/integration/approval-template-groups-backfill-preview.db.test.ts \
  tests/integration/approval-template-groups-backfill-execute.db.test.ts \
  tests/integration/approval-template-groups-backfill-rollback.db.test.ts \
  tests/integration/approval-template-groups-backfill-batches-list.db.test.ts \
  --reporter=dot
```
→ `Test Files 7 passed (7)` / `Tests 77 passed (77)`(16+10+8+13+11+11+8)。

- **CI 两点接线**(同一提交):`vitest.config.ts` exclude 新增一行;`.github/workflows/plugin-tests.yml` 的 `approval-real-db-integration` 步骤白名单新增一行 + 新增一个独立 `A3 backfill-batches-list CI wiring contract` 步骤;新文件 `scripts/ops/approval-template-groups-backfill-batches-list-ci-wiring.test.mjs`(复制自姊妹四个文件的同款守卫,换 `FILE` 常量)。`scripts/ops/ci-realdb-step-contract.mjs` 核对:`grep -n "^export const FILES\|const FILES =" scripts/ops/ci-realdb-step-contract.mjs` → 零命中(与 W7/W8/W9 记录一致,继续沿用逐文件 guard 惯例,没有 FILES 闭世界导出)。`scripts/ops/*-ci-wiring.test.mjs` 全量重跑:**491 passed**(488 + 本文件新增 3 条),零红。新守卫本身也过 mutation:注释掉 `vitest.config.ts` 的 exclude 行 → 守卫第一条用例变红(`AssertionError: vitest.config.ts must exclude …`);`cp` 还原后 `cmp` 逐字节核对一致,再次全绿。
- s6a `pluginTestsWorkflow` 钉重算(`.github/workflows/plugin-tests.yml` 两处编辑之后):`shasum -a 256 .github/workflows/plugin-tests.yml` → `099904601c47c078fa5c81bf4387a26cc0678174de5a24f54b5edc86ae5bece1`(替换旧值 `b25d5b95…`)。红/绿证据:改 workflow 文件之后、重算钉之前先跑 `node --test plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs` → `SEALED_EXPORT_INTERNAL_ERROR`(红,drift 被正确检出);写入新钉之后重跑同一条命令 → `sealed-export-package-provenance.test.cjs OK`(绿)。
- `npx tsc --noEmit`(`packages/core-backend`)全量重跑:零错误。

**本步不新增/不触碰**:`scripts/ops/ci-realdb-step-contract.mjs` 的任何导出;changesRequired #13 的三条组合调用判别力测试;规模上界(500)真库测试;apps/web(本切片全程无前端改动)。

### 19.3 §13.1 表的三处勘误说明(记忆 `feedback_acceptance_criteria_set_must_be_self_consistent`)

本步核对代码时发现 §13.1 表三处文字落后于实际提交历史,均已在上方现场改写(不是删除旧文本,是在原格追加勘误,保留可追溯性):

1. **#1 行**曾写"rollback(W9)半的 `.ts` 仍待"——但 §18(续做步骤 12)早就落地了 W9 的事务骨架。这句话在 §18 落地时就应该回写,没有回写。
2. **#9 行**曾写"rollback 半(命名常量/附加谓词形参)仍待 W9"——同上,§18 落地时 `ATG_UNLINK_ALL_GROUP_MEMBERS_SQL`/`ATG_ARCHIVE_GROUP_ROW_SQL` 两个命名常量已经是 W9 提交的一部分,这句话是重复的过期状态。
3. **#5 行**曾写"已落地(续做步骤 5)"——这是三处里唯一**实质性**的错误,不是"没跟上"而是**从一开始就写错了范围**:续做步骤 5 只落地了索引 DDL 与文档表格行(§2.1/§6.1),GET 路由与服务函数直到本步之前都不存在。§18 自己的 remaining 列表(见上方 §18 小节,续做步骤 12)如实记了这条未落地,与 §13.1 表的这一格自相矛盾——这正是本次任务书要求"先做对账表"要抓的那类缺陷:同一份文档里,live 的状态表与最新一次实现步骤的 remaining 列表说法不一致,只有后者是对的。

### 19.4 remaining(原样结转,按本步核对结果更新)

- changesRequired #13 的三条组合调用判别力测试——未变化,范围同 §18 记录(并发 execute / execute-vs-rollback / rollback-vs 手工操作三种两两组合共用 `atg:${orgId}` advisory lock)。
- ~~规模上界(500)真库测试(execute 侧)~~——**本步(续做步骤 19)已落地,见 §20**。
- A-1 两个既有真库文件补 `*-ci-wiring.test.mjs`(§9/P3-2 已披露残留)——未变化。
- 验证 MD(§13.7,仍不存在)——W7/W8/W9/list 四个单元均已落地,紧迫性进一步提高,留给下一步或 owner。
- link 薄封装新增 SET 这条偏离是否可接受(§16 记的 remaining)——未变化,仍待 owner/下一轮门审。
- changesRequired #16 后半(A-1 `routes/approvals.ts:396-399` 过强注释回流 #5852)、P1-3 对 #5852 的溢出影响——跨 lane,不在本分支权限内,维持 §13.5 记录。
- **新披露 1(继承自 A-1/W7/W8/W9,本步实测确认,不在本步修复)**:`EXPECT_DB` 哨兵在 `describeIfDatabase`(`process.env.DATABASE_URL ? describe : describe.skip`)之外时是空转的——`EXPECT_DB=1` 且 `DATABASE_URL` 缺失会把哨兵自己也跳过(实测:`unset DATABASE_URL; EXPECT_DB=1 npx vitest … approval-template-groups-backfill-batches-list.db.test.ts` → `8 skipped`,零失败),而这正是哨兵存在的目的要抓的那一种配置错误。四个姊妹 backfill 套件(schema/preview/execute/rollback)与本文件共享同一形状——本文件**故意**没有单方面改成不同结构(会造出第五种不一致的哨兵写法),按现状记为继承残留,和 P3-2 的 CI 闭世界残留同一批披露,交后续统一修法。
- **新披露 2(P2-5 的新增可达面)**:一个非 manager 的管理员执行 backfill 时,批次只记录了他"看得见"的那部分模板(`scope: 'visible-to-you'`),但批次头没有任何列记住这一点。本步新增的列表端点是第一个让**另一个**操作者看到该批次、却无法判断它是否只覆盖了部分模板的界面——修法需要给批次头加列(锁 §2 之外但仍是新增 DDL,超出本步范围),记入 remaining,不在本步动 DDL。

## 20. 续做步骤 19:额外 P2 execute 规模上界的真库测试(2026-09-18)

任务书要求先对账(§19)再逐条落地未落地的项;§19.1/§19.4 核对后剩下的、且不跨 lane / 不需要新 CI 接线（成本最低）的一项是"额外 P2 execute 规模上界"的真库半——`.ts` 分支本身早在 `f96411589`（续做步骤 17）就已落地，缺的只是证明它在真实数据库上会触发。本步只做这一项，不动 changesRequired #13（需要构造并发，见 remaining）。

### 20.1 新增测试

`packages/core-backend/tests/integration/approval-template-groups-backfill-execute.db.test.ts` 新增一例（原有 11 例不变，文件现有 12 例），插在 W8 execute 的最后一个业务用例（SQL/JS 交叉验证）与"route wiring"描述块之间：

- **人口构造**：一条 `INSERT … SELECT … FROM generate_series(1, 550)` 批量插入 550 行（不是 550 次 `createTemplate()`/API 调用），`category='CapProbe'`，`key` 用 `atge-cap-tpl-${TS}-` 前缀 + 序号,保证与文件内其余用例的 key 不冲突。550 而非 501 的余量理由:`approval_templates` 全表无 `org_id` 列（本文件 `afterEach` 注释已指出),"eligible" 是跨全表的计数,不按本测试的 `org` 限定——550 的余量确保即使此前某条用例意外遗留了少量未清理的 eligible 行,本测试仍能稳定触发上界,不依赖"这次真库状态恰好是零残留"这个假设。
- **不进共享 `templateIds`/`afterEach`**:该数组每条都会被文件级 `afterEach` 逐行 `DELETE`,550 行会拖慢文件里其余全部用例;改为 `try/finally` 内一条 `DELETE … WHERE key LIKE $1` 前缀匹配,断言失败也照样清理(mutation 探针验证见下)。
- **断言两个方向**:①`executeApprovalTemplateGroupBackfill(...)` 必须 reject 且 `toMatchObject({statusCode: 400, code: 'APPROVAL_TEMPLATE_GROUP_BACKFILL_TOO_LARGE', message: expect.stringContaining('exceeds the 500 limit')})`——先读源码确认了这三个字面量(`routes/approvals.ts:626-631`,抛错信息模板 `` `…exceeds the ${MAX} limit` ``)才写断言,不是照错误信息猜的;`message` 这一半是 advisor 复核后补的(见 §20.3.1):`APPROVAL_TEMPLATE_GROUP_BACKFILL_MAX_CANDIDATES` 未导出,只有 `statusCode`/`code` 时,若常量本身改小(仍小于本测试的种子行数),测试会继续绿,却已经不再验证"500"这个具体数字——`message` 是模块外唯一能看到真实阈值的通道;②`tableCounts(org)` 五张表(`groups/links/batches/batchGroups/batchLinks`)在该 org 上全部为 0——证明"零行写入"是"抛错发生在任何 INSERT 之前",不是"事务回滚抹掉了已写的行"这个弱得多的命题(这条 org 从未被其他用例碰过,不需要"调用前后差值"这种更复杂的判据)。
- **隔离边界(披露,非本测试防御范围)**:550 行种子在整个用例执行期间对**全部** org 都是"全局 eligible"(§20.1 上一条已述原因)。`finally` 块的即时清理只在本文件的用例**顺序**执行时成立(本文件未用 `it.concurrent`,vitest 默认按此文件的声明顺序跑)——若未来改成并发跑同一文件内的用例,某个恰好在这 550 行窗口期间执行的兄弟用例会看到自己那次调用的 `eligible > 500`,或多出一个不在预期内的 `CapProbe` 分组。这不是本测试要解决的问题,只如实记录这个前提。

### 20.2 命令与结果

```
DATABASE_URL=postgresql://localhost:5432/metasheet2_lock_a3 EXPECT_DB=1 \
  npx vitest --config vitest.integration.config.ts run \
  tests/integration/approval-template-groups-backfill-execute.db.test.ts --reporter=verbose
```
→ `Test Files 1 passed (1)` / `Tests 12 passed (12)`（含新增的规模上界用例）。

全套件回归（A-1 两个既有文件 + 本切片全部五个 W7/W8/W9/schema/list 文件）：
```
DATABASE_URL=postgresql://localhost:5432/metasheet2_lock_a3 EXPECT_DB=1 \
  npx vitest --config vitest.integration.config.ts run \
  tests/integration/approval-template-groups-lifecycle.db.test.ts \
  tests/integration/approval-template-groups-serialization.db.test.ts \
  tests/integration/approval-template-groups-backfill-schema.db.test.ts \
  tests/integration/approval-template-groups-backfill-preview.db.test.ts \
  tests/integration/approval-template-groups-backfill-execute.db.test.ts \
  tests/integration/approval-template-groups-backfill-rollback.db.test.ts \
  tests/integration/approval-template-groups-backfill-batches-list.db.test.ts \
  --reporter=dot
```
→ `Test Files 7 passed (7)` / `Tests 78 passed (78)`(77 + 本步新增 1)。

`npx tsc --noEmit`(`packages/core-backend`)：零错误。

### 20.3 mutation 正控(cp/改/跑/还原/cmp)

`cp src/routes/approvals.ts /tmp/approvals.ts.bak` → 把守卫条件 `eligible.length > APPROVAL_TEMPLATE_GROUP_BACKFILL_MAX_CANDIDATES` 改成 `eligible.length > APPROVAL_TEMPLATE_GROUP_BACKFILL_MAX_CANDIDATES * 100`（550 行不再触发上界）→ 单独重跑本文件：**恰好 1 条**变红（本步新增的规模上界用例,`AssertionError` 打印出完整的 550 条 `groups[0].templateIds` 而不是抛错——判别力证据本身），其余 11 条不受影响 → `cp /tmp/approvals.ts.bak src/routes/approvals.ts` → `cmp src/routes/approvals.ts /tmp/approvals.ts.bak` → `RESTORE BYTE-IDENTICAL`。还原后重跑整份文件确认 12/12 恢复绿。

### 20.3.1 advisor 复核后补一条断言 + 第二次 mutation（2026-09-18,同一续做步骤内）

advisor 指出:`APPROVAL_TEMPLATE_GROUP_BACKFILL_MAX_CANDIDATES` 未导出,§20.1 最初的断言只查 `statusCode`/`code`,若这个常量本身被改小（例如改成 300,但仍小于测试种子的 550 行）,抛错分支依然会触发、`statusCode`/`code` 依然匹配,测试会继续绿——但这时测试已经不再验证"500"这个具体数字,变成了一个只验证"抛不抛"的空转判据（记忆 `feedback_source_text_assertions_are_not_behaviour`/`feedback_count_guard_and_fake_switch_test` 点名的形状）。修法:`toMatchObject` 加第三个字段 `message: expect.stringContaining('exceeds the 500 limit')`（抛错信息模板本身就把阈值数字插值进去,不是另起一行拼字符串）,把"500"这个字面量的校验责任交给唯一能从模块外看到真实阈值的通道。

**mutation 验证这一步确实补上了盲区**（不是重复 §20.3 的"整体变红"探针,而是专门证明"只查 statusCode/code" vs "加了 message" 两种写法在同一次 mutation 下的差别）:`cp src/routes/approvals.ts /tmp/approvals.ts.bak2` → 把常量本身从 `500` 改成 `300`（不是像 §20.3 那样调大到不触发,而是调小——550 仍然 > 300,守卫仍会触发,`statusCode`/`code` 依然匹配）→ 单独重跑本文件:**恰好本条**变红,报错逐字打印 `Expected: "message": StringContaining "exceeds the 500 limit"` vs `Received` 里没有这个字段匹配(实际信息是 "exceeds the 300 limit"),其余 11 条不受影响 → `cp /tmp/approvals.ts.bak2 src/routes/approvals.ts` → `cmp` → `RESTORE BYTE-IDENTICAL`(`git diff --stat src/routes/approvals.ts` 确认无残留改动)。这证明了 advisor 的判断:改前的写法（仅 `statusCode`/`code`)对着这个特定 mutation（阈值改小但仍被种子行数越过)没有判别力,加了 `message` 之后才有。

### 20.4 本步不新增/不触碰

`.github/workflows/plugin-tests.yml`、`vitest.config.ts`、`s6a` 钉——本步只在既有的、已双点接线的 `approval-template-groups-backfill-execute.db.test.ts` 内加一个 `it()`,该文件本身的两点接线（`vitest.config.ts` exclude + `plugin-tests.yml` 白名单）在 W8 落地时（`f96411589`）就已完成，未发生新增文件/新增 CI 步骤，故无需重算 s6a、无需新 `*-ci-wiring.test.mjs`、无需碰 `ci-realdb-step-contract.mjs`。apps/web 未改动。changesRequired #13 的三条组合调用判别力测试、A-1 两个既有真库文件的 `*-ci-wiring.test.mjs` 补齐、验证 MD（§13.7）——均未因本步而变化,见下方 remaining。

### 20.5 remaining(在 §19.4 基础上更新)

- changesRequired #13 的三条组合调用判别力测试——未变化。
- ~~规模上界(500)真库测试(execute 侧)~~——**本步已落地**,不再是 remaining 项。
- A-1 两个既有真库文件补 `*-ci-wiring.test.mjs`(§9/P3-2 已披露残留)——未变化。
- 验证 MD(§13.7,仍不存在)——未变化,紧迫性同 §19.4。
- link 薄封装新增 SET 这条偏离是否可接受(§16 记的 remaining)——未变化。
- changesRequired #16 后半(A-1 回流 #5852)、P1-3 溢出影响——跨 lane,未变化。
- §19.4 的"新披露 1"(`EXPECT_DB` 哨兵在 `DATABASE_URL` 缺失时空转)、"新披露 2"(P2-5 批次头缺 scope 列)——均未变化,原样结转。

## 21. 续做步骤 20:changesRequired #13 第 2 项——RR 默认池文件的 SET 义务格(2026-09-18)

`approval-template-groups-backfill-execute.db.test.ts` 自己的文件头(续做步骤 18 之前就写在那里)已经明写:changesRequired #13 的三条组合调用判别力测试"是这条同 PR 义务点名的对象,本文件不做,推迟到同分支的后续提交"。本步做其中第 2 条——SET 义务必须落在 RR 默认池文件(锁 §6 的文件 1,即 `approval-template-groups-serialization.db.test.ts`),不是随便哪个文件都行。§20.5 remaining 的"changesRequired #13 三条"缩成两条(第 3 条锁序格留给下一步,见下方 remaining)。

### 21.1 为什么现有的 4 条文件头 mutation 记录不覆盖这一格

该文件（`approval-template-groups-serialization.db.test.ts`)文件头已经记录了 4 条手工 mutation,但全部只探了**单原语**调用者(`createApprovalTemplateGroup`/`renameApprovalTemplateGroup`,各自开自己的 `transaction()` 且各自调用一次 `beginApprovalTemplateGroupTxn`)。W8 execute 是本切片**唯一**的组合调用者:它在**一个** `transaction()` 回调里调用 `beginApprovalTemplateGroupTxn` **一次**,再把返回的 `AtgTxClient` 传给两个 `...WithClient`(`createApprovalTemplateGroupWithClient` / `linkApprovalTemplateToGroupWithClient`)。一个只删掉组合调用者自己那一次 `beginApprovalTemplateGroupTxn` 调用、不动任何单原语调用者的回归,不会被这 4 条记录动到——它们的判别力全部绑定在单原语路径上。

### 21.2 新增测试

`approval-template-groups-serialization.db.test.ts` 追加一例(原有 10 例不变,现有 11 例),紧跟 K 组三例之后:

- **人口**:一个新 org;一条真实 `approval_templates` 行,`category = 'ExecCat-<TS>'`(带时间戳后缀,不与本文件任何其它测试或跨会话残留冲突,不可信任裸字面量"HR"这类跨文件共享类目)。
- **持锁方(raw client,同 E 的 `beginArchiveHold`/`beginLinkHold` 手法)**:`BEGIN; SET READ COMMITTED; pg_advisory_xact_lock('atg:'||org); INSERT` 一个**不同名**的组(`HolderCat <TS>`,`sort_order=1`)——用不同类目名是为了让 execute 走"create"分支而不是"attach"分支,不搅乱要测的那条 `MAX(sort_order)+1` 路径。
- **并发腿**:`POST /api/approval-template-groups/backfill/execute`(真实 HTTP,走完整 guard + `executeApprovalTemplateGroupBackfill`)。`waitUntilBackendBlockedByHolder(holderPid)` 确认 execute 真的停在 L0(不是没跑到那一步就意外过了),持锁方再 `COMMIT`。
- **断言(双保险,状态码断言是主判据)**:①`res.status` 必须是 `201`(执行成功、新建了组)——这是主判据。**mutant 下的失败机制已现场核实,不是推断**:临时在测试里加一行 `console.log` 打印 mutant 跑时的响应体,重跑一次,输出是 `500 {"error":{"code":"GROUP_SORT_CONFLICT","message":"Group sort order conflict"}}`——证实了"整个 execute 事务在 COMMIT 时因 `atg_sort_unique` 冲突回滚,`mapGroupConstraintError` 把它映射成 500 GROUP_SORT_CONFLICT"这条机制描述,不是"观测到 500,原因待查"式的空判据;调试行验证完立即删除,`cmp` 确认测试文件与 §21.4 mutation 之前的版本逐字节一致(两个文件——`routes/approvals.ts` 与本测试文件——都做过 cp 备份 → 改 → 跑 → 还原 → `cmp`,证据链完整)。②响应体里能找到 `category === 'ExecCat-<TS>'` 的那一组,`action === 'create'`,`templateIds` 精确等于本用例自己建的模板 id(不假设 `groups.length === 1`——`approval_templates` 全表无 org 列,理论上其它文件的残留候选也会被同一次 execute 一并处理,断言只认自己关心的那一格,不认整个数组形状);③DB 层再核一次该组的 `sort_order` 严格大于持锁方的 `1`(锦上添花,不是替代①)。
- **清理**:`try/finally` 里删自己插入的模板行(与本文件其它测试一致的 org 级清理由已有的 `orgTags`/`afterAll` 负责,但 execute 会写 `approval_template_group_backfill_batches`/`batch_groups`/`batch_links` 三张表,本文件之前的 `afterAll` 没有清它们——已一并把批次头的删除加进 `afterAll`(先删批次头,级联清两张子表,`atgbbg_group_fk` 是 `NO ACTION`,必须先于组行删除;对本文件其它没写过这三张表的 org 是零行 no-op)。

### 21.3 命令与结果

```
DATABASE_URL=postgresql://localhost:5432/metasheet2_lock_a3 EXPECT_DB=1 \
  npx vitest --config vitest.integration.config.ts run \
  tests/integration/approval-template-groups-serialization.db.test.ts --reporter=verbose
```
→ `Test Files 1 passed (1)` / `Tests 11 passed (11)`(含新增例)。

全套件回归(同 §20.2 的七文件命令):`Test Files 7 passed (7)` / `Tests 79 passed (79)`(78 + 本步新增 1)。`npx tsc --noEmit`(`packages/core-backend`):零错误。

**CI 可达性现场核对(不是假设)**:`grep -n "approval-template-groups-serialization" .github/workflows/plugin-tests.yml` → 命中 `:1693`,在 `approval-real-db-integration` 步骤的白名单里——本文件确实会被 CI 跑到,新增的这一条不是"绿但从未真正执行"。

### 21.4 mutation 正控(cp/改/跑/还原/cmp,两个文件一起验证"只在 RR 池文件里有判别力")

`cp src/routes/approvals.ts /tmp/approvals.ts.set-mutation.bak` → 把 `executeApprovalTemplateGroupBackfill` 里 `const txClient = await beginApprovalTemplateGroupTxn(client)` 改成 `const txClient = client as AtgTxClient`(跳过组合调用者自己那次 SET,不动任何单原语调用者)：

- 单独重跑 **RR 池文件**(`approval-template-groups-serialization.db.test.ts`):`Tests 1 failed | 10 passed (11)`——**恰好**本步新增的那一条变红(`expected 500 to be 201`),文件里其余 10 条(含 K 组三条自己的 L0 停车断言、E 组自己的 COMMIT-mapping 断言)不受影响。
- 单独重跑**普通池文件**(`approval-template-groups-backfill-execute.db.test.ts`,W8 12 例):`Test Files 1 passed (1)` / `Tests 12 passed (12)`——**同一个 mutation** 在 RC 默认池下完全空转,两边都绿,证实"这条判别力专属于 RR 池文件"不是断言,是实测。
- `cp /tmp/approvals.ts.set-mutation.bak src/routes/approvals.ts` → `cmp` → `RESTORE BYTE-IDENTICAL`;还原后的 `git status --short` 只剩测试文件的合法编辑,`routes/approvals.ts` 零残留。

### 21.5 本步不新增/不触碰

`.github/workflows/plugin-tests.yml`、`vitest.config.ts`、s6a 钉——本步只在既有的、已双点接线的 `approval-template-groups-serialization.db.test.ts` 内加一个 `it()` 并顺手补全其 `afterAll` 的批次表清理,未新增文件、未新增 CI 步骤,无需重算 s6a、无需新 `*-ci-wiring.test.mjs`。apps/web 未改动。changesRequired #13 剩余两条(组合调用正例+反向正控停车/超时;execute/rollback 与 A-1 挂接端点真并发的锁序格,断言停车点而非终态,正控=修复前语句顺序)、A-1 两个既有真库文件的 `*-ci-wiring.test.mjs`、验证 MD(§13.7)——均未因本步而变化。

### 21.6 remaining(在 §20.5 基础上更新)

- changesRequired #13 剩余两条(① 组合调用正例 + 从已开事务内部 `await` 导出函数会停车/超时的反向正控;② execute/rollback 与 A-1 挂接端点真并发的锁序格,`waitUntilBackendBlockedByHolder` 断言停车点而非终态,正控=设计门审 M2/M3 修复前的语句顺序,探针已在 `reviews/a3-probe/execute-lockorder-probe.cjs`/`rollback-lockorder-probe.cjs`,可改写成夹具)——**本步只落地了 SET 义务格(原三条的第 2 条),这两条未变化**。
- A-1 两个既有真库文件补 `*-ci-wiring.test.mjs`(§9/P3-2 已披露残留)——未变化。
- 验证 MD(§13.7,仍不存在)——未变化。
- link 薄封装新增 SET 这条偏离是否可接受(§16 记的 remaining)——未变化。
- changesRequired #16 后半(A-1 回流 #5852)、P1-3 溢出影响——跨 lane,未变化。
- §19.4 的"新披露 1"、"新披露 2"——均未变化,原样结转。

**勘误(续做步骤 21,§22 有完整版本):这条"changesRequired #13 剩余两条"是本步核对代码后发现的过期状态——① 与 ③ 早就在 `117e248cb` / `f3b3cc5d3` 落地,只是没有回写到这里。不要只信这一格的历史文本,以 §22.1 为准。**

## 22. 续做步骤 21:任务书指定对账表(Q1–Q7 + 四条"额外 P1/P2")+ changesRequired #12 预览半补齐(2026-09-18)

任务书原文点名"逐条(Q1…Q7、额外 P1×2、额外 P2×2)在设计 MD §13 写「已落地 @commit / 未落地」,再逐条落未落地的"。§13.1/§19.1 两张表已经按 changesRequired 编号(1–16)逐条核过,但任务书是按门审报告(`reviews/design-gate-A3-phase2-20260918.md`)自己的 Q1–Q7 + P1/P2 编号点名的,两套编号不是一一对应(一个 Q 可能拆成好几条 changesRequired,一个 changesRequired 也可能回答好几个 Q)——本节按任务书自己的编号重新核一遍,而不是假设"changesRequired 表核过了所以 Q 编号也一定核过"。

### 22.1 逐条核对(本步现场 grep/git log,不是重读 §13.1 旧文本)

**落地 commit 的核实方法**:表里每个"@ SHA"引用都用 `git log --oneline -S "<该改动引入的一段独有文本>" -- <文件>` 核过,不是从 commit 主题行推断的——本节起草过程中曾先按主题行猜出一个 SHA(Q3 行的 preview 落地提交)写进表里,`-S` 核实时发现那个 SHA 根本不是仓内有效对象(`git cat-file -t <SHA>` 报错),已改正为 `-S` 核出的真实提交。Q2/Q4/Q6 三格随后补做同一验证:`git log --oneline -S "backfill/preview',"` → `d15dbe362`;`git log --oneline -S "BACKFILL_BATCH_ALREADY_ROLLED_BACK"` → `d2e96e833`;`git log --oneline -S "ATG_TX_BRAND"` → `06ac4927e`——三者与表中原有引用一致,无需改写。

| 任务书条目 | 对应 changesRequired / Q | 状态 @ commit | 核对命令 |
|---|---|---|---|
| Q1 三表 FK 修正(含 `batch_links→links` CASCADE) | #4 | **已落地 @ `02775e95f`**(该文件唯一一次改动就是这次提交,`atgbbl_link_fk … ON DELETE CASCADE` 从落地起就是这个值,非后补勘误) | `git log --oneline --follow -- packages/core-backend/src/db/migrations/zzzz20260919090000_create_approval_template_group_backfill_batches.ts` → 单一提交 `02775e95f`;`approval-template-groups-backfill-schema.db.test.ts` 的 M6 正/负控两例(均绿) |
| Q2 preview 挂 `approvalTemplateAdminGuard` | #8 | **已落地 @ `d15dbe362`(W7 preview 路由注册)** | `grep -n "backfill/preview'," packages/core-backend/src/routes/approvals.ts` → 命中一行,紧跟 `approvalTemplateAdminGuard` |
| Q3 分桶键 `btrim(category)`,不折大小写,不回写 `approval_templates.category` | #6 | **已落地 @ `d15dbe362`(preview 侧 `classifyBackfillCategory`/`pgBtrim` 本体)+ `f96411589`(execute `eligible` 查询套用同一条 `btrim(t.category) ~ '[!-~]'` 谓词)** | `grep -n "toLowerCase\|toUpperCase" packages/core-backend/src/services/ApprovalTemplateGroupService.ts packages/core-backend/src/routes/approvals.ts` → 0 命中(本步现场跑,`packages/core-backend/src` 两文件范围);`grep -n "UPDATE approval_templates" packages/core-backend/src/services/ApprovalTemplateGroupService.ts packages/core-backend/src/routes/approvals.ts` → 0 命中,证实不回写 |
| Q4 重复 rollback 409 + 专用码 + `rolledBackAt` | #7 | **已落地 @ `d2e96e833`(W9 rollback)**,专用码 `APPROVAL_TEMPLATE_GROUP_BACKFILL_BATCH_ALREADY_ROLLED_BACK` | `approval-template-groups-backfill-rollback.db.test.ts` 例"changesRequired #7: rolling back an already-rolled-back batch is a 409 …"(绿,见 §14 命令回归的 82/83 例之一) |
| Q5 三条 FK 分别裁(Q1 的展开) | #4(同上) | **已落地**,与 Q1 同一行证据 | 同上 |
| Q6 品牌类型 `AtgTxClient` 变成 typecheck 门 | #10 | **已落地 @ `06ac4927e`**(品牌类型本体);三个 `...WithClient` 签名参数类型均为 `AtgTxClient` | `grep -n "client: AtgTxClient" packages/core-backend/src/services/ApprovalTemplateGroupService.ts` → 4 命中(`createApprovalTemplateGroupWithClient`/`archiveApprovalTemplateGroupWithClient`/`linkApprovalTemplateToGroupWithClient`/`rollbackApprovalTemplateGroupBackfillWithClient`,execute 半在 `routes/approvals.ts` 另有 1 处);`npx tsc --noEmit`(本步现场跑)0 错误 |
| Q7 execute/rollback 锁序 L0→L1→L2 且"40P01 有映射" | #1 + #13 | **锁序重写已落地(execute 半 `f96411589`,rollback 半 `d2e96e833`)。"40P01 有映射"这半——核对后判定 MOOT BY CONSTRUCTION,不是遗漏,理由见下方独立小节。** | `grep -n "40P01" packages/core-backend/src/routes/approvals.ts packages/core-backend/src/services/ApprovalTemplateGroupService.ts` → 0 命中(本步现场跑) |
| 额外 P1:`linked_at` 令牌往返恒不匹配 ⇒ rollback 空转 | #2 | **已落地 @ `f96411589`(execute 写入侧 CTE-free)+ `d2e96e833`(rollback 读侧集合式 join)** | 两处 SQL 见本文档 §13.1 行 2 的现场标注;`approval-template-groups-backfill-rollback.db.test.ts` 有回归例覆盖真回滚成功路径(非空转) |
| 额外 P1:批次列表端点 `GET …/backfill/batches` + 索引 | #5 | **已落地 @ `7eb3f481d`**(§13.1 行 5 本身记录过这条从"误标已落地"到"真落地"的勘误过程,本节不重复) | `grep -n "r.get('/api/approval-template-groups/backfill/batches'" packages/core-backend/src/routes/approvals.ts` → 1 命中 |
| 额外 P2:COMMIT 阶段 23505 映射在 `transaction()` 之外 + §7 错误码表补 `GROUP_SORT_CONFLICT` | #11 | **已落地 @ `f96411589`(execute 半)/`d2e96e833`(rollback 半)——两个组合调用者的 `mapGroupConstraintError` catch 都套在各自 `transaction(...)` 调用外层,不是回调内** | `grep -n "mapGroupConstraintError(error)" packages/core-backend/src/routes/approvals.ts packages/core-backend/src/services/ApprovalTemplateGroupService.ts` → `routes/approvals.ts:755`(execute 组合调用者)与 `ApprovalTemplateGroupService.ts:803`(rollback 组合调用者),人工读两处上下文确认都在 `await transaction(...)` 外层的 `try{}catch`,不在传给 `transaction()` 的回调体内 |
| 额外 P2:execute 规模上界 `BACKFILL_TOO_LARGE` 或实测曲线 | #12 | **cap 分支已选定并落地(execute 半 `f96411589`,真库测试 `1786c0566`);preview 半(`candidateCount`)本步(续做步骤 21)补齐——见 §13.1 行 12 现场勘误** | 本步 `grep -rn "candidateCount" packages/core-backend/src/routes/approvals.ts packages/core-backend/tests/integration/approval-template-groups-backfill-preview.db.test.ts` 从 0 命中(改动前,已在本节引言处确认)变为 6 处源码命中(接口字段/累加计算/返回值,含注释)+ 15 处测试文件命中(3 个 `expect` 断言 + 相关注释与用例标题),`npx tsc --noEmit` 0 错误,`.db.test.ts` 里新增/被改动的 3 处 `expect(...candidateCount...)` 断言做过 mutation 正控(cp/改/跑/还原/cmp):把计算改成恒 0 后,单独重跑该文件 → 3 例由绿转红(另 11 例不受影响),`cp` 还原后 `cmp` 逐字节一致,`git status --short` 只剩本步的合法编辑 |

### 22.2 "Q7:40P01 有映射"为什么判 MOOT,不是 UNLANDED

任务书原文把 Q7 写成"execute/rollback 锁序 L0→L1→L2 **且** 40P01 有映射"——字面读像是要求两件事都做。核对门审报告原文(§2 Q7a):"无人映射 `40P01`:`mapGroupConstraintError`(`:182-194`)只处理 23505 ⇒ 无辜的挂接请求拿到通用 500"——这句话出现在**修法之前**的问题描述段,是诊断当前 bug 的症状,不是 changesRequired 清单(报告 §4)里的独立条目;changesRequired #1 的字面要求只有"改成 L0→L1→L2 非降序",没有第二句"并且映射 40P01"。

更关键的是,§13.2(逐字保留的门审成品)自己给出过一次**穷举式无环性证明**("建组 L0;改名 L0→L1;归档 L0→L1→L2;解档 L0→L1;重排 L0→L1;挂接 L1→L2;解除 L2;preview 不取锁;execute/rollback(修法后)L0→L1→L2。每条路径的取锁序列都是 L0≤L1≤L2 的非降序……⇒ 无环。")——锁序图无环是 Postgres 40P01(`deadlock_detected`)**发生的必要条件的否定**:两个事务只有在互相等待对方持有的锁(锁请求图成环)时才会被死锁检测器判定为死锁。修法后的锁序图已经证明不存在环,也就是说 **execute/rollback 之间、以及它们与挂接/解除/改名/归档/解档/重排之间,不再有 40P01 可以发生的路径**——不是"发生了但没人接住",是"结构上不会再发生"。给一个证明不可达的分支写运行时映射是死代码(记忆 `feedback_dead_code_defect_is_not_a_live_vulnerability` 的反向情形:这次不是"死代码里藏着活漏洞",而是"活修法让原来的症状变成了不可达分支"),而且会违反本仓"先证可达性再写"的验证纪律——加一行 `if (pgErr.code === '40P01') return new ServiceError(...)` 没有任何真库测试能触发它(触发需要先把 §13.2 的无环性证明打破,等于重新引入 M2/M3 的 bug),那样的分支本身就是本仓已经点名过的"注释断言不测=藏 bug"反面例子的镜像:一条**永远拿不到 mutation 正控的 catch 分支**。

**结论**:Q7 的"40P01 有映射"半句按门审报告 §13.2 自身的证明判 **MOOT BY CONSTRUCTION**,不计入 unlanded,也不补代码。若 owner/下一轮门审认为"防御性映射"仍然值得加(例如未来分期 3 的重排逻辑改变了锁序、无环性证明需要重新过一遍),那是对 §13.2 证明范围的重新挑战,应作为独立 changesRequired 提出,不是本步能替 owner 决定的事。

**证明的出处标注**:本节的"无环"结论**引用 §13.2 门审报告原文的枚举**(建组/改名/归档/解档/重排/挂接/解除/preview/execute/rollback 逐条路径),本步未重新独立枚举一遍全部取锁路径去验证该枚举本身是否穷尽——如果分期 3 或其它并行 lane 之后新增了一条本枚举没列出的、会取 L1 或 L2 的路径,MOOT 结论的前提就需要重新核对,不会自动继续成立。

### 22.3 任务书原文"execute 对其跳过并计数"与门审 #3 字面的分歧(如实披露,不悄悄改窄或改宽)

任务书本步原文对额外 P1(CJK category)的要求写的是"execute 对其跳过**并计数**"。门审报告 changesRequired #3 的字面要求只有"不合格 category 进 preview 的 `skipped` 桶(带 reason),execute **跳过**而非抛错炸整事务"——没有"execute 也要计数"这半句。核对当前实现(`executeApprovalTemplateGroupBackfillWithClient` 的 `eligible` 查询,`routes/approvals.ts`):`btrim(t.category) ~ '[!-~]'` 这个谓词在 SQL `WHERE` 子句里,不合格行**从未进入** `eligible` 结果集——execute 这一层结构上看不到被跳过的行,也就没有"计数"这个动作的落脚点(计数需要先看见,execute 的实现选择是让 SQL 直接把它们过滤掉,不是"看见了但不算数")。

这不是实现的缺口,是**任务书这句转述比门审原文更宽**——门审 #3 的"跳过"由 execute 侧的谓词过滤实现,"计数"这个能力只在 **preview** 侧存在(`skipped` 桶自己的 `templateCount` 字段,`ApprovalTemplateGroupBackfillSkip.templateCount`,§13.1 行 3 已确认落地)。管理员如果想知道某次 execute 会跳过多少条纯中文分类的模板,答案是**先看 preview 的 `skipped` 桶**,execute 本身不重复给一份计数——两份计数如果都做,反而会引入"execute 自己数的" vs "preview 数的"两条独立计数分岔的新风险(与 changesRequired #12 这次修的"candidateCount 不能是第二条独立查询"是同一类问题)。按门审 #3 字面(governs)不额外给 execute 加计数,本节记录这条分歧,供 owner/下一轮门审核对任务书转述与门审原文是否需要对齐。

### 22.4 本步不新增/不触碰

`.github/workflows/plugin-tests.yml`、`vitest.config.ts`、s6a 钉——本步只在既有的、已双点接线的 `approval-template-groups-backfill-preview.db.test.ts` 内加一个 `it()` + 两处既有 `it()` 内追加断言 + `afterAll` 补批次表清理,未新增文件、未新增 CI 步骤。`approval_template_group_backfill_batches` 等三张表的 DDL/迁移未改动。apps/web 未改动。

### 22.5 remaining(在 §21.6 基础上更新)

- ~~changesRequired #13 剩余两条~~ ——**已勘误(见 §22.1):三个子项全部落地,不再是 remaining。**
- changesRequired #12 的"规模-耗时曲线"备选分支——未做(设计已二选一走"上界"分支,报告允许二选一,不是缺口)。
- A-1 两个既有真库文件补 `*-ci-wiring.test.mjs`(§9/P3-2 已披露残留)——未变化,跨 lane。
- 验证 MD(§13.7,仍不存在)——未变化,按任务书本步说明属下一阶段。
- link 薄封装新增 SET 这条偏离是否可接受(§16 记的 remaining)——未变化,待 owner。
- changesRequired #16 后半(A-1 回流 #5852)——跨 lane,未变化。
- §22.3 记录的"任务书转述 vs 门审 #3 原文"分歧——待 owner/下一轮门审核对是否需要对齐任务书措辞,不是代码缺口。
- §19.4 的"新披露 1"、"新披露 2"——均未变化,原样结转。

---

## 23. 续做步骤 22:down() 数据保留守卫(候选,回应审阅意见 C-1/A-3 附条件,2026-09-21)

> **本节的性质**:这是对 `reviews/approval-template-groups-phase2-backfill-ddl-declaration-20260920.md`(下称"声明")§1.6(b)/R2/Q4b 的**候选**回应——声明本身是"给 owner 做 DDL 授权判断用的声明,不构成任何形式的批准"(声明 §0),本节改动同样**不是 ratify、不是合并、不是应用**,只是把审阅意见里"有批次数据时拒绝普通 down;代码回退后保留休眠表和台账"这条建议做成一份可审的候选实现,供下一轮门审/owner 核对。**不改锁文正文**;三张表本身仍是锁外表(§0/§1.7/§2.7/§3.7),Q1–Q7(§6)一律未裁。

### 23.1 要回应的缺口(声明原文,不转述成别的意思)

- 声明 §1.6(b)(原文,逐字):「`down()` **不撤销任何业务效果**。执行过 execute 之后跑 `down()`,`approval_template_groups` 里新建的组、`approval_template_group_links` 里写入的挂接行**原样留存**,而记录"哪些组是本批次建的 / 哪些挂接是本批次写的"的三张台账表被 `DROP`——**该次 backfill 从此永久不可经端点回滚**,只能人工逐行补偿。」
- 声明 §5.1 R2(原文,逐字):「`down()` 不撤销业务效果,却删掉唯一能撤销它的台账:执行过 execute 后跑 `down()` ⇒ 该次 backfill 永久不可经端点回滚。」
- 声明 §6 Q4b(原文,逐字):「是否接受 R2:`down()` 不撤销业务效果,且会删掉唯一能撤销它的台账——即『应用过、execute 过、再 down()』是一条不可逆路径,其后的补偿是逐 org 逐行人工操作,需 owner 逐单授权?」——**这条是非题本节不代 owner 答**;本节只是把「拒绝这条不可逆路径的默认发生」做成候选代码。
- **审阅意见原文(本次任务的来源,不是本节自己的判断)**:「不建议接受『业务效果留下、台账删掉』……建议:有批次数据时拒绝普通 down;代码回退后保留休眠表和台账。真正删除另走明确的数据保留与清理决策。」

### 23.2 改动本体(逐字 file:line,唯一改动的文件)

`packages/core-backend/src/db/migrations/zzzz20260919090000_create_approval_template_group_backfill_batches.ts`(`up()` :30–115 未改一字;`down()` 由原来的 4 行 :117–123 扩为 :117–172,新增一个环境变量常量 + 一个辅助函数 + 一段前置守卫,原有 4 条 `DROP` 语句逐字保留、位置不变):

```ts
// :138  常量名 = 它授权的动作,不是迁移动词
const ATG_BACKFILL_DOWN_FORCE_ENV = 'ALLOW_APPROVAL_TEMPLATE_GROUP_BACKFILL_DROP'

// :140-147  逐表计数,to_regclass 前置守卫(半应用的 up() 下某表缺失时按 0 算,不炸 42P01)
async function atgBackfillTableRowCount(db: Kysely<unknown>, table: string): Promise<number> {
  const result = await sql.raw(
    `SELECT CASE WHEN to_regclass('public.${table}') IS NULL THEN 0 ` +
      `ELSE (SELECT count(*)::int FROM ${table}) END AS n`,
  ).execute(db)
  const row = (result.rows[0] ?? {}) as { n?: number | string }
  return Number(row.n ?? 0)
}

// :149-165  down() 新增的前置守卫段(在任何 DROP 之前;:167 起的 4 条 DROP 逐字未改)
export async function down(db: Kysely<unknown>): Promise<void> {
  const batches = await atgBackfillTableRowCount(db, 'approval_template_group_backfill_batches')
  const groups = await atgBackfillTableRowCount(db, 'approval_template_group_backfill_batch_groups')
  const links = await atgBackfillTableRowCount(db, 'approval_template_group_backfill_batch_links')
  const total = batches + groups + links

  if (total > 0 && process.env[ATG_BACKFILL_DOWN_FORCE_ENV] !== 'true') {
    throw new Error(/* 见 :157-163,点名三个计数 + 数据保留/清理决策 + force 变量名 */)
  }
  // …原有 4 条 DROP,位置/语句逐字未变…
}
```

**设计取舍(逐条对齐审阅意见,不新造别的形状)**:
1. **"在任一表有数据时拒绝"**:三张表各自计数后求和(:153 `total`),不是只看批次头——`_batch_groups`/`_batch_links` 理论上不该在批次头为空时有孤儿行(FK `ON DELETE CASCADE`,mig:73/mig:99),但守卫按"任一表"字面逐表计数,不依赖这条 FK 推导成立。
2. **"抛出带说明的错误,指向数据保留/清理决策"**:错误信息(:156-164)点名三个具体计数、"不撤销业务效果只删台账"这句机制描述、以及"这是数据保留/清理决策,不是机械回滚步骤"这句定性——不是一句裸 `throw new Error('blocked')`。这条信息是**运维事实**(计数、变量名、决策性质),不是"该函数可能被哪些请求以何种方式滥用"这类缺陷细节,写进公开迁移文件是安全的(与仓内先例 `zzzz20260731120000_w4c3a_import_rollback_foundation.ts:756-758` 的 `W4C3A_DOWN_BLOCKED` 错误信息同一性质)。
3. **"提供显式 force 环境变量或参数才允许,默认拒绝"**:Kysely 的 `down(db: Kysely<unknown>)` 签名由框架的 `Migrator.#migrateDown`(`node_modules/kysely@0.28.8/.../migrator.js:519` 附近,`await migration.down(db)`)钉死,调用方不传第二个参数——**没有"参数"这个选项**,只能走环境变量。命名沿用仓内既有先例 `migrate.ts` 的 `ALLOW_DB_RESET`(命令 `--reset` 专用,见该文件 :113-120)同一形状:`=== 'true'` 严格比较(`=false`/`=0`/空串都不解锁),变量名按它**授权的动作**命名(`…_DROP`,不是按迁移动词 `…_DOWN`)——避免与"允许运行 down 命令"这个更宽的误读混淆:它只放行"数据非空时仍然丢弃这三张表"这一个具体决定,不放行别的。
4. **"代码回退后保留休眠表与台账"**:这条本节**不写代码**——它描述的是"回退 `routes/approvals.ts`/`ApprovalTemplateGroupService.ts` 里读写这三张表的代码"这个动作(revert 应用代码,不跑 `--rollback`),迁移/表本身不受代码回退触碰,天然保留、天然休眠。这条不需要新代码去"保证"——只需要**不**把它跟"跑 down() 清表"这个另一个独立动作混在一起做。本守卫的存在恰恰是防止后者被误当成前者的默认动作。

**订正(2026-09-21,回应独立门审 `impl-gate-A3-guarded-down-round1-20260921.md` P2-2,记忆 `feedback_asserted_invariant_is_a_bug`/`feedback_source_text_assertions_are_not_behaviour`)**——上面 :1068 那条注释("`to_regclass` 前置守卫……不炸 42P01")与它引用的 :1070-1073 代码块**曾经是假的,不是转述失真,是该轮实测证伪的一条断言**:该门审用 `psql` 直接对缺表执行这句 CASE 语句,得到 `ERROR: relation "…" does not exist`(42P01)——Postgres 在 parse/analyze 阶段解析语句里出现的**每一个**关系名,`CASE … WHEN … THEN 0 ELSE (SELECT count(*) FROM t) END` 的 `ELSE` 分支表名会在这一步就被解析,不等 `WHEN` 分支的运行期判断生效,所以缺表(三表全缺,或本节 §23.6 场景描述的"半应用 up()")时这句 SQL 本身就抛 42P01,不是"读作 0 行"。已改为该门审 §3"修法"逐字给出的两语句结构(先 `SELECT to_regclass('public.${table}') IS NOT NULL AS e`,只有这一步返回真才发第二条 `SELECT count(*) FROM ${table}`),与本节 §23.2 开头就点名的先例 `...w4c3a_import_rollback_foundation.ts:740-767` 实际使用的形状一致(该先例本就是两条独立语句,不是 CASE)——代码现状(file:line 见迁移文件 `down()` 前的注释块与 `atgBackfillTableRowCount` 本体):

```ts
async function atgBackfillTableRowCount(db: Kysely<unknown>, table: string): Promise<number> {
  const reg = await sql.raw(`SELECT to_regclass('public.${table}') IS NOT NULL AS e`).execute(db)
  if (!Boolean((reg.rows[0] as { e?: boolean } | undefined)?.e)) return 0
  const result = await sql.raw(`SELECT count(*)::int AS n FROM ${table}`).execute(db)
  const row = (result.rows[0] ?? {}) as { n?: number | string }
  return Number(row.n ?? 0)
}
```
"不炸 42P01"这句结论**现在是真的**(该门审报告 §3 P2-2 的两个真库用例 + 本轮新增 `approval-template-groups-backfill-down-guard.db.test.ts` 的两条 42P01 回归用例均已验证:三表全缺、半应用〔只剩批次头且有数据〕两种形状,down() 均不抛 42P01),但上面 :1064-1090 的代码块本身是**改动前**的历史快照,保留不改(house style:记录修复轮不手写改历史引文),此订正是它的求值层。同一门审 P3-1 另指出 force 变量(`ALLOW_APPROVAL_TEMPLATE_GROUP_BACKFILL_DROP`)相对 :1095 点名的 `ALLOW_DB_RESET` 先例是一处**加宽**——`ALLOW_DB_RESET` 在 `migrate.ts` 的 CLI 边界读取且登记在其 `--help`;这个变量在迁移文件内部读取,`--help` 原先零提及。已处理:登记进 `migrate.ts --help` 的 Notes 段,并在 force 分支生效时新增一行 `console.warn`(点名变量名与三个计数),迁移文件 down() 前的注释块新增一段"Scope note"记录这处加宽,不是把它悄悄改窄成 CLI 级读取(改变读取位置属于另一层改动,超出本轮门审点名的范围)。

### 23.3 三张表整体性质不变(§4.1 的延伸,不重复其论证)

守卫按"三表分别计数、任一非零即拒绝"实现,但§4.1 已确立的结论(「这三张表不能分开授权……批准其中一两张而不批第三张,会得到一个不可编译/不可用的形状」)在这里同样成立:down() 守卫是**一个**函数、**一次** owner 授权对象,不因为它按表分别计数就意味着三张表可以分别决定是否受此守卫保护——守卫要么覆盖全部三张(本节现状),要么整体去掉,不存在"只守批次头、子表不守"这种中间形态(子表的行数本来就该随批次头级联清零,分开守卫没有独立意义)。

### 23.4 交付物登记:设计批准 / 代码合并 / 指定环境应用(三栏分别登记,不互相代表)

> **审阅意见原文**:「设计批准、代码合并、指定环境应用分别记录。」——本表就是那份记录本体。**三栏互不蕴含**:左栏打勾不代表中栏可以推进,中栏打勾不代表右栏可以推进;任何一栏在 owner 亲自写下之前一律是"未登记",不得由本节、门审或下一轮实现自行填成"隐含同意"。

| 表 | 设计批准(owner 是否认可 §2 DDL 形状 + 本节 down() 守卫形状,§6 Q1–Q4 逐题) | 代码合并(该形状对应的代码/迁移是否已合入 `origin/main`) | 指定环境应用(该迁移是否已在某个具体命名的共享/staging/prod 库上 `migrate --latest` 应用) |
|---|---|---|---|
| `approval_template_group_backfill_batches`(批次头) | **未登记**——待 owner 答 Q1/Q1a/Q1b(声明 §6) | **未登记**——本分支仍是 Draft PR #5866,未合并(lock:8 现行有效) | **未登记**——声明 §5.2 U1:"未应用于任何共享/staging/prod 库"这一条本身是 [转述],需要有权限的人独立核验,本节不代为核验 |
| `approval_template_group_backfill_batch_groups` | **未登记**——待 owner 答 Q2/Q2a/Q2b | **未登记**——同上 | **未登记**——同上 |
| `approval_template_group_backfill_batch_links` | **未登记**——待 owner 答 Q3/Q3a/Q3b/Q3c | **未登记**——同上 | **未登记**——同上 |
| 本节新增的 `down()` 守卫(23.2) | **未登记**——本身是候选,未过独立门审,遑论 owner 裁决 | **未登记**——同上,本次会话只 push 到 Draft 分支,不开/改/合并 PR | **不适用**(守卫是代码逻辑,不是可单独"应用"的 DDL 对象;它随迁移文件一起进入"代码合并"这一栏的评估范围,不再单列一行应用状态) |

**登记规则(供后续实现/门审沿用,不是一次性的)**:任何一格从"未登记"改成别的状态,必须**点名 owner 的原话或 comment ID**(与记忆 `feedback_ratified_text_may_live_only_in_an_owner_comment`/`feedback_authorization_source_must_be_owner_authored` 同一纪律)——门审报告的"建议接受"、实现者的"已按建议落地"均不能填这张表的任何一格。

### 23.5 授权范围重申:本节只登记三张表,phase-1 两表另记(声明 §0/§6 Q4f,未裁)

- 声明 §0(原文,逐字):「本文只声明**三张锁外表**。但同一条分支……相对 `origin/main` **新增两个迁移文件**……**本分支一旦被应用,落地的是 5 张 `CREATE TABLE`**:phase-1 两张(形状已由锁 §2 ratify)+ 本文的三张(锁外)。phase-1 两张的**形状**有 ratify,但其**应用**同样受 lock:8『不应用』约束,本文不代它请示——见 §6 Q4f。」
- 声明 §6 Q4f(原文,逐字):「本轮 DDL 授权的**范围**是『**仅三张锁外表**』,还是『**本分支落地时一并创建的 5 张表**(含 phase-1 的 `approval_template_groups` / `approval_template_group_links`)』?若是前者,phase-1 两表的**应用**授权需在 #5852 单列;若是后者,请一并确认 phase-1 两表的应用也在本次授权内。」
- **本节的立场(不是代 owner 答 Q4f,是明确本节讨论的对象边界)**:本改动的对象边界 = **三张批次表**(23.4 表格四行的前三行);phase-1 的 `approval_template_groups` / `approval_template_group_links` 两张表**不在本节改动范围内**,其 DDL 形状与迁移文件本节零改动(`up()`/`down()` 均未碰 `zzzz20260918090000_create_approval_template_groups.ts`),其"应用"授权状态**另行登记**,按声明 §6 Q4f 的两个分支——**该题本身仍未裁**,本节不假设答案是"前者"还是"后者",只是**如实描述本次改动没有触碰 phase-1 两表**这一件事实,不构成对 Q4f 的回答或预判。
- **一致性检查**:23.4 表格只列了三张批次表 + 守卫本身共 4 行,没有 phase-1 两表的行——这是刻意的,不是遗漏:把 phase-1 两表也塞进同一张表会造成"这份候选文档在替 Q4f 做主张"的误读,按 §0 的边界声明,那两表的登记应该在它们自己的迁移文件/声明里独立进行(声明原文指向 #5852)。

### 23.6 一并求值的两条运维后果(标 [推导],部分已实测)

- **对 `--reset` 的影响(声明 §4.2 R6 的延伸,[推导],2026-09-21 已实测——见下方订正)**:`migrate.ts --reset` 走 `migrator.migrateTo(NO_MIGRATIONS)`,会从最新迁移逐条往回走。本守卫生效后,任何持有批次数据的库跑 `ALLOW_DB_RESET=true --reset` 会在走到本迁移这一步时**停下**(除非同时也设置了 `ALLOW_APPROVAL_TEMPLATE_GROUP_BACKFILL_DROP=true`)——这是**新增的一个停止点**,`--reset` 原来不会因为这张表有数据而中止。方向是有意的(fail-closed,与本节 23.1 的目标一致),但如实记录:这是一个此前不存在的行为变化,影响面是"任何调用 `--reset` 的调用方",不只是单步 `--rollback`。~~**本节未新增任何 `--reset` 场景的真库测试**……这条推导未经真库验证~~——**该半句已被下方订正取代,不再成立**。

  **订正(2026-09-21,回应独立门审 `impl-gate-A3-guarded-down-round1-20260921.md` P3-3,记忆 `feedback_supersession_marker_must_evaluate_not_void`——只让"未测/推导"这个状态断言失效,上面"新增停止点"这句结论仍 OPERATIVE,不整节作废)**:该门审 E7 已实测,本轮在独立的一次性库(`metasheet2_a3r2_20260921`)上复现同一构造(手工编辑 `kysely_migration` 让本迁移成为 Migrator 视角下的"最新",批次头插入一行,`ALLOW_DB_RESET=true npx tsx src/db/migrate.ts --reset`,不设 force):**exit 1**,错误就是本迁移的 `ATG_BACKFILL_DOWN_BLOCKED`;`--list` 复核 `Applied` 计数**在这次 --reset 前后不变**(本轮实测为 411,门审 E7 原始环境为 411——两次独立复现数字一致)。这比上面那句"在走到本迁移这一步时停下"的措辞更强,容易被读成"前面的都退了、停在这一步":**实际是整次 `--reset` 被包在 Kysely `Migrator` 的一个事务里(`node_modules/kysely@0.28.8/.../migrator.js:427-431`),一旦任何一步 `down()` 抛错,整个事务回滚——真实结果是「一条迁移都没退」,不是「已经退到这一步的都生效、停在这一步」**。方向仍是有意的(fail-closed 的一个自然推论,不是新缺陷),但下一个读"停下"两个字的人不应该以为前面的迁移已经退掉;后续任何文档/工具如果要描述这个行为,应使用"整次 `--reset` 事务性中止,零迁移回退"而不是"停在这一步"。
- **force 之后仍然不可逆(残留,重申不是新发现)**:即使设置 force 变量成功丢弃三张表,§1.6(b)/R2 描述的不可逆性**原样成立**——force 只是把"意外丢弃"变成"蓄意丢弃",不会让已丢弃的台账指向的业务效果重新变得可回滚。本守卫解决的是"默认发生 vs 需要一个显式动作才发生"这一层,不解决"发生之后能不能撤销"这一层——后者没有解法,只能靠不发生(即前一层的默认拒绝)来避免,这也是为什么默认值必须是拒绝而不是放行。
- **意外发现,记录不修复([推导] + 部分实测,详见验证 MD §14.4)**:本次会话在尝试用 CLI `--rollback` 链式回退本迁移之前的两条无关迁移时,发现 `zzzz20260919120000_add_attachment_blob_purge_claim.ts` 的 `down()` 自己在 `migrator.#migrateDown` 已经开起的事务连接上再调用一次 `.transaction()`,被 Kysely 拒绝(`Error: calling the transaction method for a Transaction is not supported`)——这是该文件已有的、与本节改动**完全无关**的既存缺陷(本节零字节改动过该文件),声明 §4.2 R6 描述的"回退这三张表必须先回退两条无关迁移"这条运维耦合,在当前 head 上因为这另一个 bug 而**更严重**:通过 `--rollback` CLI 链式回退目前**走不通**(卡在 `add_attachment_blob_purge_claim` 这一步),只能通过其它手段(如直接 `import { down }` 调用,或先修复那个文件)绕过。这**超出本次派工范围**(派工只点名 A-3 的 down() 守卫),本节如实记录发现、不在这里修复;是否需要单独排期修 `add_attachment_blob_purge_claim.ts` 的这个 bug,留给 owner/下一轮门审判断。

### 23.7 本步不新增/不触碰

生产代码除 §23.2 点名的一个文件外零改动;未新增/未删除任何 `.ts`/`.mjs`/测试文件;`.github/workflows/plugin-tests.yml`、`vitest.config.ts`、s6a 钉——零改动,未新增 CI 步骤,无需重算 pin。锁文正文——零改动。`up()`——零字节改动。phase-1 迁移文件(`zzzz20260918090000_create_approval_template_groups.ts`)——零改动。真库验证证据见验证 MD §14。

**求值(2026-09-21,记忆 `feedback_asserted_invariant_is_a_bug`——这句只对它描述的那个 commit 仍然为真,不能读成对当前树的断言)**:以上一整段是对**本节改动本身那一步**(commit `59b5cd7ee1`)的如实记录,对那个 commit 逐字仍然成立。修复轮 1(验证 MD §14.6,2026-09-21)在其**之上**又提交了改动,这句话不再描述当前树:`packages/core-backend/src/db/migrate.ts`(新增 --help Notes 段)、`scripts/dev-bootstrap.sh`(两处提示文案)、新文件 `packages/core-backend/tests/integration/approval-template-groups-backfill-down-guard.db.test.ts`、`packages/core-backend/tests/unit/approval-ci-coverage-allowlist.ts`(新增一条登记)均有改动。`.github/workflows/plugin-tests.yml`/`vitest.config.ts`/s6a 钉这半句——**仍然成立**,修复轮 1 逐文件核对三者字节不变(验证 MD §14.6.9)。`up()`/phase-1 迁移文件——仍然零改动。

**求值(2026-09-21,修复轮 2,回应 `impl-gate-A3-guarded-down-round2-20260921.md` P3-b/P2-B)**:上一段的行数括注(原写"254 行")是手写且错误的数字,与验证 MD §14.6.1/§14.6.9 记录的 259 行不一致(门审报告 P3-b 已判定)。已删除该括注,**不写回任何新数字**——包括不重新验证并写回 259:本轮又给这份测试文件新增了两条用例(P2-A 的严格性用例、P3-c 的正控用例),此刻测出的任何行数在本轮自己的改动落地后就已经过期,写下去只是把"手写数字会漂"这个问题原地重犯一次(记忆 `feedback_record_fix_rounds_only_delete_never_handwrite_numbers`)。另外,上一段"`.github/workflows/plugin-tests.yml`/`vitest.config.ts`/s6a 钉…仍然成立"这半句,从修复轮 2 起**不再描述当前树**:两点接线(`vitest.config.ts` exclude + `plugin-tests.yml` 白名单)、该文件自己的 `approval-template-groups-backfill-down-guard-ci-wiring.test.mjs` 守卫、s6a `pluginTestsWorkflow` 钉重算,均由修复轮 2 一次性落地(详见验证 MD §14.7)。这不是把修复轮 1 的记录改错——修复轮 1 当时的字节不变断言,对修复轮 1 那一步本身逐字仍然成立;只是它描述的"当前树"状态已被修复轮 2 的下一步改变。


