# 审批表单分组 Phase 2(切片 A-3:按现有 category 建组并挂接)— 设计提案(DRAFT,未过独立门审)

- 锁文(唯一 ratify 对象):`approval-form-group-entity-design-lock-draft-20260916.md`,**v2.13 RATIFIED 2026-09-18**。锁文 §6「期 2」原文只有三个词的约束:「管理员『按现有 category 建组并挂接』的显式操作,预览 → 执行 → 可回滚」+ 门 =「1 落地」。**本切片的全部交互形状、DDL、错误码、并发/回滚精确性都是本文档新提出的设计,不是锁文逐条对照的实现**——这一点与 A-1(锁文 §2/§3 逐条落地)性质不同。
- 目标文档:`goal-three-locks-full-implementation-20260918.md`(切片 `A-3 分期 2`,门 = 「待 A-1 Draft PR 过门(『1 落地』按此求值,已请示 owner)」——**该前置门已满足**:`#5852` 第 3 轮 DRAFT-READY(0 P1/0 P2/6 P3)@`0144932ac`,现场 `gh pr view 5852` 核对 body 确认。
- 补充清单:`impl-supplementary-gate-checklist-20260918.md` #1–#4(三线共用)
- **门控前提(taskbook 原文,未被任何后续文档撤销)**:`impl-taskbook-A-grouping-20260918.md:72`「W7(预览端点)……视设计提案而定 | 先出设计提案,过独立门审后才可标 S/M/L」;`:227`「分期 2 的交互设计未锁……W7/W8/W9 在没有独立设计提案通过门审之前不进入实现队列」。**本文档就是这份设计提案本身**,尚未经过独立门审——本步(worktree 建立后的第一个可提交单元)只交付这份提案,不写任何 `.ts` 实现代码。
- 本文档所在分支:`feat/approval-template-groups-phase2-backfill`(基于 `origin/feat/approval-template-groups-phase1`)
- 本文档写作时 worktree HEAD:`0144932ac`(与 A-1 的 Draft PR #5852 门审通过时的 head 相同——本分支尚无自己的提交)
- `origin/main` 与本分支的 merge-base:`89f1ecdee2`(**相同**,即 `feat/approval-template-groups-phase1` 是 `origin/main` 的直接后代,本分支进一步在其上直接展开,无 rebase 漂移)
- 下文所有 `file:line` 都是**对本 HEAD 现场 `grep -n` 的结果**。

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

```
BEGIN
SET TRANSACTION ISOLATION LEVEL READ COMMITTED          -- 必须是第一条语句,同 A-1 §2
SELECT pg_advisory_xact_lock(hashtext('atg:' || org))    -- 与手工建组/归档/改名/解档竞争同一把锁

eligible ← SELECT id, category FROM approval_templates t
             WHERE btrim(category) ~ '[!-~]'              -- 【§13 changesRequired #3,已求值,取代下一行】
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
  RETURN { batchId: null, groups: [] }                    -- 幂等的"第二次零变化"由这里保证

batchId ← newBatchId()
INSERT INTO approval_template_group_backfill_batches (id, org_id, created_by) VALUES (...)

FOR EACH category IN GROUP BY eligible.category:
  existing ← SELECT id FROM approval_template_groups
              WHERE org_id = $org AND name = $category AND archived_at IS NULL
  IF existing 存在:
    groupId ← existing.id; createdNew ← false
  ELSE:
    -- 内联 createApprovalTemplateGroupWithClient 的语句体(MAX+1 → INSERT)
    groupId ← 新建组; createdNew ← true
  INSERT INTO approval_template_group_backfill_batch_groups (batch_id, org_id, group_id, created_new)
    VALUES ($batchId, $org, $groupId, $createdNew)

  FOR EACH template IN eligible WHERE category = 该 category:
    -- 内联 linkApprovalTemplateToGroupWithClient 的语句体(FOR UPDATE → upsert),RETURNING linked_at
    INSERT INTO approval_template_group_backfill_batch_links
      (batch_id, org_id, template_id, group_id, linked_at)
      VALUES ($batchId, $org, $template.id, $groupId, $返回的linked_at)

COMMIT
RETURN { batchId, groups: [...] }
```

**catch 分支**:任何一步抛错(包括 `mapGroupConstraintError` 映射出的 `GROUP_NAME_TAKEN`/`GROUP_SORT_CONFLICT`)⇒ 整个 `transaction()` 自动 ROLLBACK(`connection-pool.ts:199-203`),零行写入——这与"重名走 GROUP_NAME_TAKEN 语义"的字面矛盾需要澄清:**正常路径下不会撞见 `GROUP_NAME_TAKEN`**,因为"先查后建"发生在同一把 L0 锁之内,不存在竞态窗口(见下条);它只在 L0 本身失守(实现 bug)时才会被 `mapGroupConstraintError` 兜底,而不是设计出的正常分支。

**【§13 changesRequired #1,已求值,实测 M2】上面 §3.1 的逐类目循环(L1→L2→L1,在取过某组的 L2 之后回头对下一个组取 L1)与 A-1 挂接路径(L1→L2,不取 L0)确定性死锁,牺牲者是同时段任何普通挂接请求且拿到未映射的通用 500——不是纸面推理,是本会话真库实测(`reviews/a3-probe/execute-lockorder-probe.cjs`)。落地(execute 与 rollback 必须写成同一条要求,详见 §13 changesRequired #1 与 §11 附录的完整伪代码):在 L0 之后、任何 L2 写之前,用一条语句按确定性行序预锁本次要触达的全部既有组行(`SELECT id FROM approval_template_groups WHERE org_id=$1 AND id=ANY($2) ORDER BY id FOR UPDATE`),取代逐类目循环里"回头取 L1"的写法;预锁之后 `linkApprovalTemplateToGroupWithClient` 内部的 `FOR UPDATE` 退化为对本事务已持有行锁的再取,不新增取锁顺序。`mapGroupConstraintError` 的 catch 须套在整个 `transaction()` 调用之外(§13 changesRequired #11),因为 `atg_sort_unique` 是 `DEFERRABLE INITIALLY DEFERRED`,真重复在 COMMIT 时才报 23505——逐原语套 catch 看不到它。此条为 W8 实现单元的落地对象,本步不改写 pseudocode 本体,只记入求值。**

### 3.2 并发语义(E 的姊妹判据,复用同一 L0)

两个并发 execute(同一 org)⇒ 后到者在 `pg_advisory_xact_lock` 上停车(与 A-1 验收 E 用的 `waitUntilBackendBlockedByHolder` 同一停车点、同一 helper);先提交者已经把所有符合条件的模板挂接完毕,后到者拿到锁后重新执行 `eligible` 查询,此时符合条件的模板已经清零(每个都命中了 `NOT EXISTS` 的反面)⇒ 后到者是空事务、返回 `batchId: null`——**并发 execute 与"两次顺序 execute 幂等"是同一段代码路径产生的同一个观察结果**,不需要额外的并发专用分支。

手工建组请求与 execute 并发:也在同一把 L0 上互斥;谁先提交谁的效果先生效,不存在需要额外处理的交叉状态。

## 4. rollback:精确到批次的算法与前提条件

### 4.1 为什么不能直接调用 `unlinkApprovalTemplateFromGroup` / `archiveApprovalTemplateGroup`

- `unlinkApprovalTemplateFromGroup(orgId, templateId)`(A-1,`:391-400`)是**无条件**解除——只要当前 `group_id IS NOT NULL` 就清空。如果这个模板在 execute 之后被**另一次操作**(手工挂接、另一个后续批次)改挂到了别的组,rollback 若无条件调用它,会把"批次外发生的新挂接"也解除掉——**这正是任务书要求的 mutation 判据「rollback 影响批次外行 ⇒ 红」的靶子**。
- `archiveApprovalTemplateGroup(orgId, groupId)`(A-1,`:241-278`)在归档时会**无条件解除该组当前的全部成员**(`UPDATE … SET group_id = NULL … WHERE org_id = $1 AND group_id = $2`,不区分是不是本批次挂上去的)。如果这个批次新建的组,在 execute 之后被**另一个人**手工挂了一个不相关的模板进来,rollback 若直接调用这个函数归档该组,会把那个不相关模板也解除——同一个 mutation 判据的另一半。

**决策**:rollback 不调用这两个导出函数,而是内联同样的语句,但**加两层精确性前置条件**(见 §4.2/§4.3)。这仍然是「解除是独立 UPDATE」「归档是事务」这两条既有原语的**语句**复用,只是补上了"只对本批次仍然原样成立的那部分状态生效"这个额外 WHERE 谓词/前置检查——不是发明新的写路径形状。

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

```
FOR EACH (groupId, createdNew) IN batch_groups WHERE batch_id = $batchId:
  IF NOT createdNew: CONTINUE                      -- 挂到已有组的,从不归档
  locked ← SELECT archived_at FROM approval_template_groups
             WHERE org_id = $org AND id = $groupId FOR UPDATE
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
  "buckets": [
    {
      "category": "HR",
      "action": "attach",          // "create" | "attach"
      "existingGroupId": "atg_...",// action="attach" 时非空;action="create" 时为 null
      "templateIds": ["...", "..."],
      "templateCount": 2
    }
  ]
}
```

`action` 由"§org 内是否已存在同名活跃组"预先判定——与 execute 内部的判定逻辑必须是**同一条 SQL**(否则 preview 展示的结果可能与 execute 实际发生的不一致);因此建议把"给定 org + category 列表,判定 create/attach"抽成一个只读小函数,preview 和 execute 都调用它,唯一区别是 execute 在 L0 锁内调用、preview 在锁外调用(preview 本身不修改状态,不需要锁;但这意味着 **preview 展示的"将建/将挂接"是快照,不是承诺**——如果 preview 之后、execute 之前发生了并发的手工建组,execute 时看到的"是否已存在同名组"可能与 preview 展示的不同。这是"预览"语义的正常边界,不是缺陷,写清楚防止门审误判为竞态漏洞)。

## 6. 端点、guard 与一处需要门审/owner 裁决的授权面冲突

### 6.1 端点(实现者命名提案)

| 方法 + 路径 | 语义 | guard(任务书原文指定) |
|---|---|---|
| `GET /api/approval-template-groups/backfill/preview` | §3.1 的只读候选查询 | `approvalTemplateAdminGuard`(任务书原文) |
| `POST /api/approval-template-groups/backfill/execute` | §3 execute | `approvalTemplateAdminGuard` |
| `POST /api/approval-template-groups/backfill/batches/:batchId/rollback` | §4 rollback | `approvalTemplateAdminGuard` |

### 6.2 授权面冲突(必须在实现前解决,列为本提案的第一个待裁决项)

任务书原文三个端点全部点名 `approvalTemplateAdminGuard`,**包括只读的 preview**。但 A-1 已落地的 I7 原文(锁文 §3,ratified)是:

> **I7 授权面与挂载点**:……读端点挂 `rbacGuard('approvals:read')`(同 `:531`)。**不由实现者现场裁量。**

I7 是锁文 §3 不变量、属于抬头 RATIFY 记录里"已 ratify"的第 2 项(§2/§3 逐条),preview 是一个新增的只读端点——字面落在 I7 的"读端点"定义里。这与任务书原文对 A-3 preview 指定 `approvalTemplateAdminGuard` 直接冲突:

- **若按 I7 字面执行**:preview 应挂 `rbacGuard('approvals:read')`,execute/rollback(写端点)挂 `approvalTemplateAdminGuard`——这与 A-1 已落地的七个端点的 guard 分配规则完全一致(读 `approvals:read`,写 `approvalTemplateAdminGuard`)。
- **若按任务书原文执行**:preview 也挂 `approvalTemplateAdminGuard`——比 I7 字面要求的更严格(把"谁能看候选清单"限缩到"谁能执行写"的同一批人),**不违反"零信任放宽"的方向**(不是把写权限的守卫削弱成读权限,而是反过来,读端点被收紧到写权限的门槛),但仍然是对 I7"不由实现者现场裁量"这句话的字面偏离——I7 定义的是**这个端点属于哪一类(读/写)对应哪个 guard**,backfill 预览在语义上是"regular 读"还是"因为暴露的是尚未发生的写计划,值得按写权限收紧"是一个需要裁决的问题,不是实现者可以自行决定的。

**本提案倾向**:preview 挂 `approvalTemplateAdminGuard`(遵任务书原文,收紧不放宽,风险方向安全),但在 Draft PR 里逐字披露这条偏离 I7 字面表述的理由,供门审/owner 核实是否需要改回 `rbacGuard('approvals:read')`。**不会**采用"两者都不占"的第三种做法。

**【§13 changesRequired #8 / Q2,已裁,ownerLevel = true(默认值已给,Draft 不必等)】裁定 `approvalTemplateAdminGuard`,但门审不采纳上一段"更严格所以安全"这个理由(记忆 `feedback_second_narrower_artifact_is_contract_narrowing`:另造更窄同类物本身就是合同变更)——采纳的是三条实证理由:① 锁 §6 分期 2 抬头原文是「管理员」的显式操作,「预览」是该操作第一段而非独立浏览端点,I7 的读/写二分没有预料到这种形状;② 仓内在地先例`POST /api/approval-templates/:id/route-preview`(同 router)同样是只读 preview 却挂 `approvalTemplateAdminGuard`;③ 正确性判据(非口味):§5.2 已论证 preview 与 execute 必须共用同一条 SQL 否则展示与实际不一致,若挂 `approvals:read` 则非 manager 读者拿到的是被 `applyTemplateVisibilityFilter` 收窄过的另一个集合——一份任何 execute 都不会照做的"预览",与§5.2 自己的论证矛盾。但第③条门审自己攻破了"guard 人口=manager 人口"这个隐含前提(见 §13 changesRequired #16):`hasPermissionCode` 对权限码做通配展开而 `isTemplateManager` 是精确 `.includes()`,持 `approval-templates:*` 或走 DB 侧 `isAdmin(userId)` 的主体过 guard 但非 manager——parity 只在 manager 人口内成立,不是恒等。要求:Draft PR body 逐字披露这条对 I7 字面二分的偏离 + 上述三条理由 + 这条更窄的 parity 表述,请 owner 一句话确认(记忆 `feedback_ratified_text_may_live_only_in_an_owner_comment`)。**

### 6.3 org 来源

三个端点全部复用 A-1 的 `resolveApprovalTemplateGroupOrgId(req, res)`(`routes/approvals.ts:352-370`)——body/query 的 `orgId` ⇒ 400 `ORG_ID_NOT_ACCEPTED`;`req.authenticatedTenantId` 缺失 ⇒ 403 `SESSION_ORG_REQUIRED`。不新造 org 解析逻辑(A‴ 的机制原样复用)。

## 7. 错误码(全部实现者新增,均非锁文 ratified 码——§7 的框架语言照抄 A-1 §3.3 的区分方式)

| 码 | HTTP | 触发 |
|---|---|---|
| `APPROVAL_TEMPLATE_GROUP_BACKFILL_BATCH_NOT_FOUND` | 404 | rollback 指向不存在于该 org 的批次 id |
| `APPROVAL_ACTOR_REQUIRED` | 401 | 沿用 A-1 既有码(execute/rollback 都需要 actor id) |

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

| # | 门审要求(摘) | 本文档落地位置 | 状态 |
|---|---|---|---|
| 1 | execute 与 rollback 改成"L0 → 一条 `ORDER BY id FOR UPDATE` 预锁全部目标既有组 → 所有 L2 写 → 归档"(实测 M2/M3) | §3.1 pseudocode 后现场标注(execute)+ §4.3 `remaining` 段后现场标注(rollback);完整语句见下方 13.2 | 设计已落地(pseudocode 本体待 W8/W9 改写) |
| 2 | `linked_at` 令牌全程不经 JS:写入用数据修改 CTE,回滚用集合式 join(实测 M4) | §4.2「已知残留」段已重写 + 成品 SQL 已贴入该节 | **已落地(含成品 SQL)** |
| 3 | preview/execute 共用同一条可入库谓词 `btrim(category) ~ '[!-~]'`,必须在 `eligible` 查询内部而非循环 `continue`(实测 M5) | §3.1 eligible 谓词已替换 + 注释说明机制 | **已落地** |
| 4 | `atgbbl_link_fk` 改 `ON DELETE CASCADE`;另两条 FK 维持原值(实测 M6) | §2.3 CREATE TABLE 后现场标注 + §4.4 point 2 现场标注(区分两条不同的 FK,不得混淆) | **已落地** |
| 5 | 新增 `GET /api/approval-template-groups/backfill/batches`(admin guard,分页,含 `rolledBackAt`)+ 索引 | §2.1 段现场标注引用本条;§6.1 端点表本身未加这一行 | **未落地(见 §13.3)** |
| 6 | 分桶键/组名一律 `btrim(category)`,不折大小写,不回写 `category` 列 | §8 item 2 现场标注 | **已落地** |
| 7 | rollback 对已回滚批次返回 409 + 专用码 + `rolledBackAt` | §4.4 point 1 现场标注 | **已落地** |
| 8 | preview 挂 `approvalTemplateAdminGuard`,PR body 逐字披露对 I7 的偏离 | §6.2「本提案倾向」段后现场标注 | 设计已落地;PR body 义务见 §13.4 |
| 9 | execute 调用 `...WithClient` 原语,不得抄语句;rollback 共用语句须提炼命名常量/附加谓词形参 | §1 表三行现场标注 | 设计已落地(代码化待 W8/W9) |
| 10 | SET 义务变成 typecheck 门:唯一 `beginApprovalTemplateGroupTxn(client)` 返回品牌类型 `AtgTxClient`;明确不采用运行时 `current_setting` 断言 | 本节 §13.2 逐字保留门审给出的成品设计;§11 附录原文的"SET 由薄封装发出"承诺在此升级为机械约束 | 设计已落地(品牌类型待 W8 实现) |
| 11 | `mapGroupConstraintError` 套在整个 `transaction()` 之外;§7 错误码表补 `GROUP_SORT_CONFLICT` | §3.1 lock-order 现场标注已提及 catch 套法(前半);§7 错误码表本身未加 `GROUP_SORT_CONFLICT` 这一行(后半) | **前半已求值/后半未落地(见 §13.3)** |
| 12 | execute 加规模上界(默认 500,超出 400 `…_BACKFILL_TOO_LARGE`)或给出规模-耗时曲线,二选一 | 未在正文现场标注(§3 pseudocode 未涉及规模上界);记入 §13.3 待补小节 | **未落地,记入 remaining** |
| 13 | W8 同 PR 补三条组合调用判别力测试(组合正例+反向正控停车/超时;SET 义务格落在 RR 池文件;锁序格断言停车点非终态) | §9 验证计划纲要目前只有粗粒度描述;本条细化待 §9 改写(下一实现单元) | 设计已知悉,§9 待补三条具体用例名 |
| 14 | §1 表逐格改调用级复用;§2.1"无可观测中间态"收窄为"无 DB 行级中间态" | §1 表三行 + §2.1 段,均已现场标注 | **已落地** |
| 15 | Q1(b) 普查改写:把"四 token 零命中"换成更宽普查记录,`attendance_import_rollback_*` 作为正面先例引用 | 未加现场标注,原因见 §13.3 | **未落地(见 §13.3)** |
| 16 | preview/execute 响应带 `scope: 'org-complete' \| 'visible-to-you'`;不得假设"所有管理员都是 manager";`routes/approvals.ts:396-399` 过强注释回流 #5852 | §6.2 现场标注已引用 guard⊋manager 的事实(前半道理已求值);`scope` 字段本身未写入 §5.2 响应形状(中段未落地);回流 #5852 是跨 lane 动作,本分支无权限做(后半见 §13.5) | **中段未落地(见 §13.3),后半记入 remaining(见 §13.5)** |

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

- §7 错误码表补一行 `GROUP_SORT_CONFLICT`(500,判 `error.constraint === 'atg_sort_unique'`)。
- §2.1 段引用的批次列表端点(changesRequired #5)未加入 §6.1 端点表,`GET /api/approval-template-groups/backfill/batches` 待补。
- §5.2 响应形状未加 `scope: 'org-complete' | 'visible-to-you'` 字段(changesRequired #16)。
- §3 execute pseudocode 本体未按 13.2 的统一锁序改写(仍是旧的逐类目循环文本,现场标注已指出但未替换整段——整段替换是 W8 的代码化前奏,留给下一实现单元一并做,避免本步在"设计门审裁定落地"与"重写算法"两件事之间来回横跳)。
- §3 execute 未加规模上界或规模-耗时曲线(changesRequired #12)。
- §9 验证计划纲要未细化 changesRequired #13 的三条组合调用判别力测试用例名。
- Q1(b) 的普查改写(changesRequired #15)——本文档"批次机制选择"段仍是原始四 token 表述,未加现场标注;本步选择不动它,因为该段是"决策已做出、证据不够宽"性质的问题,不影响后续 DDL/算法落地,留给下一实现单元或 PR body 一并披露。

以上六项在下一实现单元(W7 preview 或 §3/§9 算法重写)开始前必须先补,否则会重复门审已经点名的 P2-4 同类"标记贴在附录、正文未回写"问题。

### 13.4 owner 待裁,按默认值(ownerLevel = true,Draft 按此推进,不等 owner)

- **O1**:三张批次表(header + batch_groups + batch_links)是锁 §2 之外的新表(锁文外 DDL)。**owner 待裁,按默认值**:采纳提案的 header+detail 三表形状(含 changesRequired #4 的 FK 修正);Draft only,不应用不合并。
- **O2**:`atg_name_nonblank CHECK (name ~ '[!-~]')` 拒绝纯中文组名——这是 A-1/#5852 上的**活缺陷**(`POST /api/approval-template-groups {name:'人事'}` 今天就是 500,产品 UI 明确指导用户填纯中文分类,见 `TemplateAuthoringView.vue:221` placeholder),需要**锁 §2 约束清单勘误**。**owner 待裁,按默认值**:建议改成 `CHECK (btrim(name) <> '')`;在 owner 裁决前,A-3 按 §13.1 #3(changesRequired #3)的谓词跳过纯中文 category 并在 preview 标 `skipped`,诚实披露"owner ratify 勘误前,本功能对纯中文分类惰性"。**这是继目标文档 §"不在目标内"列出的两条锁文勘误请示之外的第三条**,须一并记入 owner brief,不能只活在本文档里(见 remaining)。
- **O3**:preview 的 guard——已在 §13.1 #8 / §6.2 现场标注给出默认值 `approvalTemplateAdminGuard`;**owner 待裁,按默认值**是因为 I7 原文明写"不由实现者现场裁量",需要 owner 一句话确认,Draft 不必等。

### 13.5 跨 lane / 超出本分支权限的项(记入 remaining,不在本步处理)

1. **P1-3 对 #5852 的溢出影响**:`createApprovalTemplateGroup(org,'人事',actor)` 抛裸 `DatabaseError`(`code=23514`),意味着 A-1 Draft PR #5852 第 3 轮"0 P1 / 0 P2 @`0144932ac`"的门审 verdict 是 **head-scoped** 的,该发现是本次 A-3 门审的溢出,**需要回流 #5852 重新求值其"0 P1"结论**——这不是 A-3 分支能做的事(#5852 是另一个 Draft PR,改它不在本 lane 权限内)。
2. **changesRequired #16 后半**:`routes/approvals.ts:396-399` 的注释"`approvalTemplateAdminGuard` makes every actor that can reach the link endpoint today `isTemplateManager`"是过强声明(guard 人口 ⊋ manager 人口),**应随 P1-3 一并回流 #5852**——同上,不在本分支权限内现场改写 A-1 已落地代码的注释。
3. **O2 的锁文勘误请示**是第三条尚未记入目标文档"不在目标内"清单的勘误项(该清单目前只列了分组锁 J/C「section 400」挪分期 3、"1 落地"求值两条)——需要在下一次向 owner 汇报时补齐这第三条,本文档在此记录以防遗漏。

### 13.6 Draft PR body 必写清单(为一个当前禁止开出的 PR 预先收集,防止到时遗漏)

- changesRequired #3:纯中文 category 在 owner ratify `atg_name_nonblank` 勘误前功能惰性的诚实披露。
- changesRequired #8:preview guard 偏离 I7 字面读/写二分的三条理由 + 请 owner 一句话确认。
- changesRequired #15:Q1(b) 更宽普查记录(`operation_audit_logs` 自述占位且 schema 漂移两次;`attendance_import_rollback_*` 是正面先例而非仅驳回对象)。
- changesRequired #16:`scope` 字段的存在理由(guard 人口 ⊋ manager 人口,两类主体过 guard 但非 manager)。
- P3-2:A-1 两文件不被任何 `*-ci-wiring.test.mjs` 覆盖的闭世界残留披露,本切片新文件继承同样残留。
- P3-3:`action` 判定函数抽取为只读小函数供 preview/execute 共用,且同时返回 `skipped` 判定。
- Q6(a) 三条件:PR 必须堆叠在 A-1 之上(base=`feat/approval-template-groups-phase1`);mutation 台账位移声明(#5852 台账是对重构前函数体写的,需逐条说明目标已搬进 `...WithClient` 体内);A-1 若再有修复轮,A-3 必须 rebase 不得 cherry-pick。

### 13.7 验证 MD 状态

本切片的验证 MD(`docs/development/approval-template-groups-phase2-verification-*.md`)**尚不存在**——按目标文档 §"每个切片的交付物"的要求,验证 MD 随 Draft PR 一并提交,本步只交付设计文档的门审裁定落地,不构成验证 MD 的替代,记入 remaining。
