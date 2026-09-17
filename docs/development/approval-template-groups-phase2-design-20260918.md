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
| 建组语句形状(MAX+1 → INSERT) | `createApprovalTemplateGroup:175-202` | execute 内联同样的两条语句(见 §3.0 为何不能直接调用这个导出函数) |
| 挂接语句形状(FOR UPDATE → upsert) | `linkApprovalTemplateToGroup:349-384` | 同上,execute 内联 |
| 归档语句形状(FOR UPDATE → 批量解除 → archived_at/sort_order UPDATE) | `archiveApprovalTemplateGroup:241-278` | rollback 内联(带精确性前置条件,见 §4) |
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
- **不设**「执行中」状态列——execute 是单事务,要么全成功要么全回滚(见 §3),不存在"进行中"的可观测中间态。
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
             WHERE category IS NOT NULL AND category <> ''
               AND NOT EXISTS (
                 SELECT 1 FROM approval_template_group_links l
                  WHERE l.org_id = $org AND l.template_id = t.id
               )                                          -- 与 I2′ 判定谓词逐字相同(见 §5.1)
               AND <applyTemplateVisibilityFilter 的析取条件>

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

**已知残留(披露,非漏判)**:`linked_at` 取自 `now()`(事务开始时刻),是同一事务内的常量。如果在 execute 提交之后、rollback 开始之前,发生了"解除该模板 → 立刻重新挂接回同一个组"且两次操作发生在同一个事务里(因而共享同一个 `now()` 值),巧合下新的 `linked_at` 可能与批次记录的旧值相等,rollback 会把这次"批次外的重新挂接"误判为"批次自身状态未变"而解除它。这个反例需要构造"同一事务内解除又挂接"这个不常见的调用序列才能触发,列为已知边界,不在本切片修复范围(修复需要一个不依赖时间戳的版本号列,是范围变更)。

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

### 4.4 待门审裁量的两点(实现者初步倾向,非最终)

1. **对已回滚批次再次调用 rollback**:倾向做成幂等 200(返回 `{ archivedGroupIds: [], unlinkedTemplateIds: [] }`,不报错)——同 A-1 验收 H「解除幂等」的语言,但这不是锁文钉死的行为,是本切片自己的选择,写清楚供门审核实是否要改成 409。
2. **外键选择 `ON DELETE CASCADE` 让子表跟随批次头删除**:今天没有任何路径会硬删批次头行,这个选择是防御性的,不影响当前行为;若门审认为不必要(批次头永不删除,CASCADE 是死代码路径)可以改成 `NO ACTION`,不影响其它设计。

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

### 6.3 org 来源

三个端点全部复用 A-1 的 `resolveApprovalTemplateGroupOrgId(req, res)`(`routes/approvals.ts:352-370`)——body/query 的 `orgId` ⇒ 400 `ORG_ID_NOT_ACCEPTED`;`req.authenticatedTenantId` 缺失 ⇒ 403 `SESSION_ORG_REQUIRED`。不新造 org 解析逻辑(A‴ 的机制原样复用)。

## 7. 错误码(全部实现者新增,均非锁文 ratified 码——§7 的框架语言照抄 A-1 §3.3 的区分方式)

| 码 | HTTP | 触发 |
|---|---|---|
| `APPROVAL_TEMPLATE_GROUP_BACKFILL_BATCH_NOT_FOUND` | 404 | rollback 指向不存在于该 org 的批次 id |
| `APPROVAL_ACTOR_REQUIRED` | 401 | 沿用 A-1 既有码(execute/rollback 都需要 actor id) |

`handleApprovalsError` 兜底码(名字含端点动作,同 A-1 惯例):`APPROVAL_TEMPLATE_GROUP_BACKFILL_PREVIEW_FAILED` / `_EXECUTE_FAILED` / `_ROLLBACK_FAILED`。

## 8. 待确认/请示(本提案主动列出,非"发现问题却假装没看见")

1. **§6.2 的 guard 冲突**(preview 挂 `approvalTemplateAdminGuard` 还是 `rbacGuard('approvals:read')`)——本提案倾向前者,需门审/owner 拍板。
2. **legacy category 值的空白/大小写不做归一化**(§5 附注)——两个模板 `category` 分别是 `'HR'`/`'HR '` 会分进两个桶、建两个组;这是遗留数据形态问题,`normalizeTemplateCategory` 只在写路径生效、不回溯清洗旧行。本切片按"原始字符串精确匹配"分桶,不做额外归一化;若 owner 认为 backfill 时应该顺带做值级归一化,是范围变更,需要重新过设计门审(不在本提案范围内,不会现场加做)。
3. **rollback 幂等 vs 409**(§4.4-1)、**批次头 FK 用 CASCADE 还是 NO ACTION**(§4.4-2)——实现者已给出倾向,供门审核实。
4. **§3.0 的重构影响面**:`ApprovalTemplateGroupService.ts` 的三个导出函数体会被拆成 `...WithClient` 内部版本——这触及 A-1 已经过门审、已进 Draft PR #5852 的文件。若门审认为这个重构不应该在 A-3 分支里做(例如应该先合并回 A-1 或单独走一个"重构,零行为变化"的切片),需要重新安排提交顺序;本提案目前的默认假设是"在 A-3 分支里做,重跑 A-1 的两个 `.db.test.ts` 作回归证据"。

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

**对 §3.0 原文的一处修正(不是静默偏离)**:§3.0 原文承诺"语句、顺序、错误映射逐字不变"——这句对**组合调用**(execute 在同一个 `transaction` 里连续调用两个 `...WithClient`)不成立,原因是 `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` 必须是 `BEGIN` 后的第一条语句(§2);若把 SET 留在 `createApprovalTemplateGroupWithClient`/`archiveApprovalTemplateGroupWithClient` 的函数体里,execute 组合调用两次时第二次 SET 会晚于第一次调用已经跑过的查询语句,在 RR 默认池下报 `25001` 并中止整个事务,在 RC 服务器上又会静默成功从而验证空转——两种后果都不可接受。**改正**:SET 从这两个 `...WithClient` 函数体中**移出**,只由目前仍是单操作路径的薄封装在 `transaction(...)` 回调的第一条语句里发出(与重构前的物理位置完全相同,§3.0 的"下一步"部分因此改写)——`linkApprovalTemplateToGroupWithClient` 本来就不发 SET(link 不取 L0),不受影响。`pg_advisory_xact_lock` 在同一会话内可重入,`...WithClient` 内部保留自己的 L0 获取语句不会因组合调用而阻塞或出错。这意味着**未来** execute/rollback 组合这些 `...WithClient` 原语时,必须自己在其唯一的 `transaction(...)` 回调顶部发一次 SET,而不是指望被组合的原语各自带一份——这条义务记入本条附录,供门审核实,门审通过前不假设为已解决。

**验证**(零行为变化,两条证据,均见 commit 的验证记录):
1. **行为对照**:A-1 已落地的两个真库测试文件 `approval-template-groups-lifecycle.db.test.ts`(16 用例)与 `approval-template-groups-serialization.db.test.ts`(10 用例,RR 默认池,含 E/K 的顺序/停车敏感断言)在私有库 `metasheet2_lock_a3` 上**原样重跑**(`DATABASE_URL=postgresql://localhost:5432/metasheet2_lock_a3 EXPECT_DB=1 npx vitest --config vitest.integration.config.ts run <file> --reporter=dot`),重构前后**均 26/26 全绿**——这条覆盖了运行时语句顺序(E/K 两个用例专门断言 L0 停车与 COMMIT 阶段异常映射,若 SET/L0 顺序被打乱会直接观察到红)。
2. **机械 SQL 抽取对照**:对重构前后的文件各自用正则抽取全部 `client.query(<字符串字面量>)` 的 SQL 文本(21 条),排序后逐条 `JSON.stringify` 比较——**排序后的多重集合逐字相同**(21 = 21,零增删)。**已知局限,如实披露**:抽取脚本按源码文本定义顺序读取,不是按运行时调用顺序——由于 `...WithClient` 函数在源码中定义于其薄封装**之前**,原始"SET 紧跟在 L0 锁语句前"的相邻关系在**文本order**里看起来被拆开了(SET 现在文本上出现在其消费者之后);这不代表运行时顺序变化,运行时顺序仍由第 1 条的真库测试兜底证明,不由这条机械抽取兜底——两条证据分别覆盖"语句集合未变"与"语句顺序未变"两件不同的事,不能互相替代。

**澄清"独立门审"未被满足**:上一句的 advisor 咨询**不是**记忆库 `feedback_authorization_source_must_be_owner_authored` 意义上的独立门审——advisor 看到的是本会话自己的记录,不是外部裁量;把它当成门审通过会构成自证循环。本文档第 8 节列出的全部待裁决项(§6.2 guard 冲突、§8.2 归一化、§4.4 两处倾向)与 W7/W8/W9 三个端点仍然**原样待裁**,本条附录不改变这一点。
