# approval-template-groups-phase2-backfill — 验证 MD(2026-09-18)

分支 `feat/approval-template-groups-phase2-backfill`,worktree `/private/tmp/claude-501/-Users-chouhua-Downloads-Github-metasheet2/6f6639a7-0412-43de-bd8b-0b416d18ae6b/scratchpad/wt-groups-p2`。本文档配对 `docs/development/approval-template-groups-phase2-backfill-design-20260918.md`(设计 MD),按 `goal-three-locks-full-implementation-20260918.md` §「每个切片的交付物」的要求交付:锁文验收行 → 测试文件 + 用例名 + lane;命令逐字 + 结果关键行;mutation 台账;两点接线/哨兵/触发集/s6a 证据;未做/未验项如实列出。

**不改代码、不改锁文**:本次会话对源码做过的唯一改动是下方 §3.1 的一次 mutation 探针(`cp` 备份 → 编辑 → 跑 → `cp` 还原 → `cmp` 逐字节核对),`git status --short` 在本文档写作前后均为空。未新增/未删除任何 `.ts`/`.mjs`/迁移文件。

起点 HEAD(本文档与设计 MD 提交前):`185572a708cb5f79f93e12c943f4c83f2333924d`(已 rebase 到 `feat/approval-template-groups-phase1` 的新 head,rebase 证据见 `approval-template-groups-phase2-backfill-rebase-note-20260918.md`)。私有验证库:**`metasheet2_lock_a3_docs`**(本次会话新建的处女库,`dropdb --if-exists && createdb` 起手,证据见 §2.1;与设计门审用的 `metasheet2_design_gate_a3`、续做步骤 18 用的 `metasheet2_lock_a3`、rebase 用的 `metasheet2_lock_a3_rb` 均为不同的私有库,互不复用)。

---

## 0. RATIFY 记录(原样引用,来自 `approval-form-group-entity-design-lock-draft-20260916.md` 抬头)

> **RATIFY 记录(2026-09-18)**
> - **授权来源(owner 亲写,本会话消息原文)**:「按 你建议执行1」——指向我前一条消息的建议 1:「ratify 三把锁:分组锁 v2.13、待办中心锁 v2.14、撤销锁 v5.9;待裁项按锁文里标的建议值」。owner 未点名的项(合并 PR、#5805 收口、#5698 处置)**不在本授权内**。
> - **ratify 当刻 head**:`origin/main @ 00781e68b`(2026-09-18);**验证基线** `85ddd2926`(第 4–13 轮门审全部在此 head 上核实),两 head 之间相差 228 提交(timemachine/recovery 合并列车)。
> - **漂移核对(85ddd2926 → 00781e68b)**:本锁引用的核心文件(`routes/approvals.ts`、`ApprovalProductService.ts`、`approval-seat-authorization.ts`、`AuthService.ts`、`rbac/*`、`plugin-attendance/index.cjs`、迁移目录既有文件、`plugin-tests.yml`)**字节相同**;唯二有位移的是 `packages/core-backend/src/index.ts` 与 `multitable/automation-service.ts`;`run-required-web-tests.sh` 的 exec 行只多了 stock-prep 令牌;新增迁移 `…create_recovery_archive_derived_effects.ts` 与本锁无关。
> - **裁决结果(按建议值)**:Q3 分组按 org 作用域,`org_id` 只取 `req.authenticatedTenantId` = **是**;Q4 归档不保留成员、解档得空组 = **是**;Q5 `?category=` 与 `/categories` 首期不动、分期 3 再裁;**分期 2(按现有 category 建组并挂接)= 要,做成预览→执行→可回滚的管理员操作**;`key` 全局唯一 = **另立锁**,不顺带。§7 第 2 项(§2 两表形状 + 锁序表 + I1–I8)按 v2.13 ratify。
> - **不变的约束**:含 DDL 的切片只能以 Draft PR 交付、**不应用、不合并**;任何合并仍需 owner 逐 PR 一句话;实现按分期走「Sonnet 实现 → Opus 门审 → 修复重跑闸 → Draft PR」。

粗体标注的一句(「分期 2……= 要,做成预览→执行→可回滚的管理员操作」)就是本切片 A-3 的存在依据——下表把它、锁 §6 表第 2 行、锁 §5「不自动回填」、锁 §4 验收 E 逐一映射到测试文件。

---

## 1. 判据 → 测试文件 + 用例名 + lane 映射

### 1.1 RATIFY「分期 2 = 要,预览 → 执行 → 可回滚」

| 子判据 | 测试文件 | 用例名(节选) | lane |
|---|---|---|---|
| 预览(只读,不写) | `tests/integration/approval-template-groups-backfill-preview.db.test.ts`(14 例) | `preview writes ZERO rows: approval_template_groups/links row counts for the org are byte-identical before and after, across a run that produces both a "create" and a "skip" bucket` | `test (20.x)` → `approval-real-db-integration` 步骤(真库,白名单第 79 行,见 §2.3) |
| 执行(写,幂等) | `tests/integration/approval-template-groups-backfill-execute.db.test.ts`(12 例) | `happy path: creates one group per distinct btrim(category), links every eligible template, and records the batch header + both detail tables`;`idempotency: a second sequential execute call on the same eligible population returns batchId: null and writes zero additional rows across every table` | 同上,白名单第 80 行 |
| 可回滚(精确到批次,不影响批次外) | `tests/integration/approval-template-groups-backfill-rollback.db.test.ts`(11 例) | `happy path: rollback archives the batch-created group, unlinks the batch-linked templates, and stamps rolled_back_at`;`batch-external addition to a batch-created group survives rollback: the group stays active because it is not empty`;`a batch-linked template moved to a different group by a batch-external action is left exactly where the external action put it` | 同上,白名单第 81 行 |
| DDL(批次头 + 两张明细表) | `tests/integration/approval-template-groups-backfill-schema.db.test.ts`(8 例) | `the three FK delete-actions match the design-gate Q5 ruling exactly (a=NO ACTION, c=CASCADE)`;`M6 positive control: hard-deleting a linked template cascades through group_links into the batch_links row (no FK violation)` | 同上,白名单第 78 行 |
| 批次可查(changesRequired #5) | `tests/integration/approval-template-groups-backfill-batches-list.db.test.ts`(8 例) | `orders by created_at DESC and paginates with limit/offset, with an accurate total independent of the page size`;`rolledBackAt is null for a not-yet-rolled-back batch and an ISO string for a rolled-back one, and org scoping excludes a foreign org entirely` | 同上,白名单第 82 行 |
| 授权面(写=admin guard,非字面 I7 二分,已披露) | 上述五文件各自的 `route wiring` 嵌套 `describe` | 五文件均含 `an actor holding ONLY approvals:read (no approval-templates:manage) gets 403` + `an unauthenticated request gets 401, not a silent 200` | 同上 |

### 1.2 锁 §6 表第 2 行(「期 2:管理员『按现有 category 建组并挂接』的显式操作,预览→执行→可回滚」,门 =「1 落地」)

- 内容三段(预览/执行/回滚)映射见上表 §1.1,不重复。
- **门「1 落地」的求值**:`impl-supplementary-gate-checklist-20260918.md` #6 已把这句请示为「Draft PR 过门审」(DDL Draft-only 是永久约束,字面「落地」= 合并,永不发生)。**本切片尚未开出 Draft PR**——本文档与配对设计 MD 是开 PR 前的最后一步交付物,门本身仍是 owner 待裁项,不因本文档存在而自动满足;设计 MD §13.6 已列出 Draft PR body 必写清单。

### 1.3 锁 §5「明确不做」——「自动回填(只给显式管理员操作)」

这是一条**否定式**判据,不能靠"没搜到"证明,按机械普查法:枚举 `executeApprovalTemplateGroupBackfill`/`executeApprovalTemplateGroupBackfillWithClient` 的**全部**生产调用点,证明只有一个显式的、需要管理员 guard 的 HTTP 路由。

```
$ grep -rn "executeApprovalTemplateGroupBackfill\b" packages/core-backend/src | grep -v WithClient
src/routes/approvals.ts:767:export async function executeApprovalTemplateGroupBackfill(
src/routes/approvals.ts:1616:      const result = await executeApprovalTemplateGroupBackfill(orgId, actor, actorId)

$ grep -rn "executeApprovalTemplateGroupBackfillWithClient" packages/core-backend/src
src/routes/approvals.ts:635:export async function executeApprovalTemplateGroupBackfillWithClient(
src/routes/approvals.ts:775:      return executeApprovalTemplateGroupBackfillWithClient(txClient, orgId, actor, createdBy)
```

即:导出定义各 1 处、生产调用各 1 处,且调用链是「HTTP 路由 → 薄封装 → WithClient」的**单一直线**,不存在第二条调用路径。路由本体(`routes/approvals.ts:1606-1620`):

```
r.post('/api/approval-template-groups/backfill/execute', authenticate, approvalTemplateAdminGuard, async (req, res) => {
  ...
  const result = await executeApprovalTemplateGroupBackfill(orgId, actor, actorId)
  ...
})
```

未见任何 `cron`/`setInterval`/`node-cron`/scheduler/启动钩子调用该函数:

```
$ grep -rn "cron\|setInterval\|node-cron\|scheduler" packages/core-backend/src/routes/approvals.ts packages/core-backend/src/services/ApprovalTemplateGroupService.ts
(no output)
$ grep -n "backfill" packages/core-backend/src/index.ts
2246:              // (flipped per-deployment after registry backfill).
2263:              // whether the registry backfill is complete enough to flip this mode to `enforce`.
```
`src/index.ts` 的两处命中是另一个不相关特性(「registry backfill」,访问控制注册表迁移进度),不是本分组功能——**零**生产路径能不经这条显式 `POST … /execute` 触发批量建组。判据满足。

### 1.4 锁 §4 验收 E「序号不变量」——**A-3 execute 路径上,如实标未验**

锁 §4 的 E 行原文判据是「分期 1 的 DDL + 建组;分期 3 的重排:并发两次建组 ⇒ 序号 n+1、n+2 各一,无 23505 泄露」——这是**分期 1/3** 的判据,A-3(分期 2)execute 只是**复用同一条 `MAX+1 → INSERT` 语句**(设计 MD §1「建组语句形状」行),因此设计 MD §3.2 称其为「E 的姊妹判据」而非 E 本身。核对结果:

- **设计论证存在**(设计 MD §3.2):两个并发 execute 在同一把 `atg:${orgId}` 顾问锁上排队,先提交者清空 `eligible`,后到者重新查询后发现候选已清零 ⇒ 退化为空事务 `{batchId: null}`——**不需要**真正走到"两次同时 INSERT 争抢同一个 `MAX+1`"的分支,因为 L0 本身就把 execute 序列化了。
- **构造并发的真库测试:不存在。** 逐条读 `approval-template-groups-backfill-execute.db.test.ts`(12 例)与 `-rollback.db.test.ts`(11 例)的全部用例名(见 §1.1 表与设计 MD §0′ 附近的清单),没有一条构造「两个并发 `POST …/execute`」或「一个 execute 并发一个手工建组」并断言 `sort_order` 终态为 n+1/n+2、零 `23505` 泄露的测试。
- **容易混淆但不能替代的三条测试**(§13 changesRequired #13,commit `117e248cb`/`45e5c8a21`/`f3b3cc5d3`,均落在 `approval-template-groups-serialization.db.test.ts`,即 A-1 的 RR-default-pool 文件,不在本切片自己的五个文件里):
  - `REVERSE positive control (§3.0, changesRequired #13 item 1): awaiting a non-WithClient exported function from inside an already-open transaction() self-deadlocks at the L0 lock wait, not at connection-pool acquisition`
  - `A-3 execute (composed caller): under the RR-default pool, execute still reads a concurrently-committed holder row at MAX(sort_order) — proving the SET this composed transaction issues is not a single-primitive-only obligation`
  - `execute lock-order (design-gate M2, §13.2 fix): stalls on the batched deterministic pre-lock statement, not a per-category one`
  这三条断言的是**锁序自死锁陷阱**与**停车点**(`waitUntilBackendBlockedByHolder`),不是「两个 execute 并发跑完、序号各得 n+1/n+2」的终态断言——判别力不同,不能互相替代。
- **结论**:E 在 A-3 execute 路径上的姊妹判据**未验**,原因 = 只有设计论证、无构造并发的真库测试。这不是本步能补的缺口(补测试属于代码/测试改动,超出本任务「不改代码」边界),如实记入 remaining(§5)。

---

## 2. 私有库重跑证据(`metasheet2_lock_a3_docs`,处女库,本次会话新建)

### 2.1 建库 + migrate(0 pending)

```
$ dropdb --if-exists metasheet2_lock_a3_docs && createdb metasheet2_lock_a3_docs
NOTICE:  database "metasheet2_lock_a3_docs" does not exist, skipping
$ DATABASE_URL="postgres://localhost/metasheet2_lock_a3_docs" pnpm exec tsx src/db/migrate.ts
... (全部 migration 顺序执行,末尾)
migration "zzzz20260918090000_create_approval_template_groups" was executed successfully
migration "zzzz20260919090000_create_approval_template_group_backfill_batches" was executed successfully
$ DATABASE_URL="postgres://localhost/metasheet2_lock_a3_docs" pnpm exec tsx src/db/migrate.ts
(no output — 0 pending)
```
以 A-3 自己的批次表迁移收尾,第二次运行零输出,证明幂等/无遗留待跑迁移。

### 2.2 7-file lane(A-1 两文件 + 本切片五文件)

```
$ DATABASE_URL="postgres://localhost/metasheet2_lock_a3_docs" EXPECT_DB=1 pnpm exec vitest \
    --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-lifecycle.db.test.ts \
    tests/integration/approval-template-groups-serialization.db.test.ts \
    tests/integration/approval-template-groups-backfill-schema.db.test.ts \
    tests/integration/approval-template-groups-backfill-preview.db.test.ts \
    tests/integration/approval-template-groups-backfill-execute.db.test.ts \
    tests/integration/approval-template-groups-backfill-rollback.db.test.ts \
    tests/integration/approval-template-groups-backfill-batches-list.db.test.ts \
    --reporter=dot

 ✓ tests/integration/approval-template-groups-lifecycle.db.test.ts  (18 tests) 701ms
 ✓ tests/integration/approval-template-groups-serialization.db.test.ts  (14 tests) 5735ms
 ✓ tests/integration/approval-template-groups-backfill-preview.db.test.ts  (14 tests) 273ms
 ✓ tests/integration/approval-template-groups-backfill-execute.db.test.ts  (12 tests) 301ms
 ✓ tests/integration/approval-template-groups-backfill-rollback.db.test.ts  (11 tests) 289ms
 ✓ tests/integration/approval-template-groups-backfill-schema.db.test.ts  (8 tests) 61ms
 ✓ tests/integration/approval-template-groups-backfill-batches-list.db.test.ts  (8 tests) 277ms

 Test Files  7 passed (7)
      Tests  85 passed (85)
 Duration    22.79s
```
18+14+14+12+11+8+8 = 85,与本次 `Tests 85 passed` 逐位相加一致。**与 rebase note §4 的既有记录(`metasheet2_lock_a3_rb` 上跑的同一批文件,`7 passed (7)` / `85 passed (85)`)数字相同**——本次是在另一个全新处女库上独立重跑得到的相同结果,不是复用/转抄该记录。

### 2.3 required check `test (20.x)` 的两半(本次在当前 HEAD 现场重新抽取,不沿用 rebase note 的旧计数)

**抽取方法**:`awk` 定位 `approval-real-db-integration` 步骤边界——

```
$ awk '/id: approval-real-db-integration/{print NR} /--reporter=dot/{print NR; exit}' .github/workflows/plugin-tests.yml
1604
1699
```
与 rebase note 记录的「lines 1614–1699」同一步骤(锚点行号相差因取的是 `id:` 行而非 `run:` 首行,范围一致);提取 run 体、只替换 `DATABASE_URL`,文件个数核对:

```
$ grep -c "tests/integration" <extracted run body>
84
```
84,与 rebase note、§19/§22 记录的数字一致——本次是当前 HEAD 现场重新数的,不是沿用旧文档。

**真库半(84 文件)**:

```
$ DATABASE_URL="postgres://localhost/metasheet2_lock_a3_docs" \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-directory-endpoints.api.test.ts \
    ... (84 whole-file args,逐字取自 plugin-tests.yml:1615-1699) ... \
    tests/integration/approval-template-groups-backfill-batches-list.db.test.ts \
    --reporter=dot

 Test Files  84 passed (84)
      Tests  932 passed | 10 skipped (942)
 Duration    136.77s
```
Exit 0。数字(`932 passed | 10 skipped (942)`)与 rebase note 记录的同一批文件在 `metasheet2_lock_a3_rb` 上的结果**完全一致**;耗时 136.77s vs 139.88s(同一量级,机器负载正常波动)。

**无库半(`test (20.x)` 同一 job 里的「Run core-backend tests」步骤)**:

```
$ env -u DATABASE_URL CI=true pnpm --filter @metasheet/core-backend test

 Test Files  931 passed | 175 skipped (1106)
      Tests  14718 passed | 1604 skipped (16322)
 Duration    86.56s
```
Exit 0,与 rebase note 记录一致(该记录耗时 59.53s,本次 86.56s,同为一次性本机测量,量级相近)。交叉核对:
```
$ grep -c "tests/unit/approval-template-routes.test.ts" <run log>
30
$ grep -cE "^\s*✗|FAIL " <run log>
4
```
均与 rebase note 逐位相同(30、4,且那 4 行全部是断言"fail closed 行为"本身的绿色用例名,不是真失败,已在 rebase note 里论证过,这里不重复整段论证)。

### 2.4 五个 ci-wiring 守卫 + 闭世界普查

```
$ node --test scripts/ops/approval-template-groups-backfill-{batches-list,execute,preview,rollback,schema}-ci-wiring.test.mjs
ℹ tests 15
ℹ pass 15
ℹ fail 0
```
每文件 3 断言(exclude 名单 / plugin-tests.yml 白名单 / 文件存在),5×3=15,全绿。

```
$ pnpm exec vitest run tests/unit/approval-ci-coverage-enumeration.test.ts
 Test Files  1 passed (1)
      Tests  349 passed (349)
```
与 rebase note 记录一致——闭世界人口/触发集普查未发现新的未接线 approval 真库文件。

**全量 `*-ci-wiring.test.mjs`(不止本切片五个,仓内全部)**:
```
$ node --test scripts/ops/*-ci-wiring.test.mjs
ℹ tests 491
ℹ pass 491
```
与 §19.2(续做步骤 18)记录的「491 passed(488+3)」一致。**披露一处数字分歧**:`impl-supplementary-gate-checklist-20260918.md` #1 原文写「同族 *-ci-wiring 共 45 个」(文件数),本次现场 `find . -iname '*-ci-wiring.test.mjs' -not -path '*/node_modules/*' | wc -l` = **43**(不是 45)。测试用例总数(491)与设计 MD §19.2 记录一致,文件数的「45」与现状「43」不一致——不确定该数字在清单起草时是否算了两个后来被删除/合并的文件,本次未深挖差异原因,如实记录这处不一致,不强行对齐。

### 2.5 s6a 钉 + provenance 测试

```
$ shasum -a 256 .github/workflows/plugin-tests.yml
099904601c47c078fa5c81bf4387a26cc0678174de5a24f54b5edc86ae5bece1
$ grep -n pluginTestsWorkflow plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json
90:    "pluginTestsWorkflow": "099904601c47c078fa5c81bf4387a26cc0678174de5a24f54b5edc86ae5bece1"
$ node --test plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs
sealed-export-package-provenance.test.cjs OK
ℹ pass 1
```
字节相同、provenance 测试绿——**本切片当前 HEAD 不需要重算 s6a 钉**(五个 backfill 文件的白名单行早已在此 sha256 之内,rebase 亦未改动该 workflow 文件,见 rebase note §3)。

---

## 3. Mutation 台账

### 3.1 本次会话现场重跑(唯一亲跑;`cp` 备份 → 编辑 → 跑 → `cp` 还原 → `cmp`)

**目标**:`listApprovalTemplateGroupBackfillBatches` 第二条查询(`ApprovalTemplateGroupService.ts:912-918`)的 org 过滤,复现设计 MD §19.2 记录的第 2 号 mutation。

```
$ cp src/services/ApprovalTemplateGroupService.ts /tmp/ApprovalTemplateGroupService.ts.bak
$ git status --short src/services/ApprovalTemplateGroupService.ts
(空)
```
编辑(Python 脚本做精确字符串替换,仅动一行):`WHERE org_id = $1` → `WHERE org_id = $1 OR $1 = $1`(等价于去掉 org 过滤;`count(*)` 那条查询保持原样作为对照,不动)。

```
$ git diff src/services/ApprovalTemplateGroupService.ts
-      WHERE org_id = $1
+      WHERE org_id = $1 OR $1 = $1
```

```
$ DATABASE_URL="postgres://localhost/metasheet2_lock_a3_docs" EXPECT_DB=1 pnpm exec vitest \
    --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-backfill-batches-list.db.test.ts --reporter=verbose

 ✓ sentinel: EXPECT_DB lane must have DATABASE_URL …
 ✓ orders by created_at DESC and paginates with limit/offset …
 ✗ rolledBackAt is null for a not-yet-rolled-back batch … and org scoping excludes a foreign org entirely
 ✓ an admin actor gets 200 with the batch it just executed …
 ✗ a foreign org never sees another org's batches over HTTP
 ✓ an actor holding ONLY approvals:read … gets 403
 ✓ an unauthenticated request gets 401 …
 ✓ smoke: executeApprovalTemplateGroupBackfill + rollback … both surface through the list unit function

 Test Files  1 failed (1)
      Tests  2 failed | 6 passed (8)
```
**恰好 2 条**变红(单元测试的「org 域隔离」格 + 路由测试的「跨 org HTTP 隔离」格),其余 6 条不受影响——与设计 MD §19.2 记录的判别力描述逐字一致。还原:

```
$ cp /tmp/ApprovalTemplateGroupService.ts.bak src/services/ApprovalTemplateGroupService.ts
$ cmp /tmp/ApprovalTemplateGroupService.ts.bak src/services/ApprovalTemplateGroupService.ts
RESTORE BYTE-IDENTICAL(cmp 零输出即字节相同)
$ git status --short src/services/ApprovalTemplateGroupService.ts
(空)
```
还原后重跑同一文件确认回到全绿:
```
 Test Files  1 passed (1)
      Tests  8 passed (8)
```

### 3.2 转抄既有记录(**采信记录**,均在更早的 head/commit 上亲跑,本步未重新独立复现——按记忆 `feedback_prove_a_fix_by_running_the_old_implementation` 的 provenance 纪律逐条标注,不冒充"今天亲跑")

| # | 目标 | 落地 commit | 判别力(转抄自设计 MD) |
|---|---|---|---|
| M6(schema) | `atgbbl_link_fk` 改回原提案 `NO ACTION` | 该 mutation **不是**改源码 `.ts` 后重跑,而是**测试自身**在一次注定回滚的事务里用 `ALTER TABLE … DROP/ADD CONSTRAINT` 现场复现原提案形状(见 `approval-template-groups-backfill-schema.db.test.ts:152-201`)——这条测试**每次真库 CI 跑都会自动重新验证**这个 mutation,不是一次性历史记录,§2.2 已跑绿,不需要额外转抄 | 两个断言变红(`confdeltype` 检查 + 事后真删除断言);见 §2.2 |
| §19.2 mutation 1 | 批次列表 `ORDER BY created_at DESC, id DESC` → `ASC, ASC` | 续做步骤 18,`02775e95f` 附近 | 恰 1 条("orders by created_at DESC…")变红,其余 7 条不受影响 |
| §19.2 mutation 2 | 同上文件 org 过滤 | 同上 | 恰 2 条变红——**本步 §3.1 已独立重跑同一 mutation,今天的结果与这条历史记录吻合** |
| §19.2 ci-wiring 正控 | 注释掉 `vitest.config.ts` 的 backfill-batches-list exclude 行 | 续做步骤 18 | 新守卫第一条用例变红(`AssertionError: vitest.config.ts must exclude …`) |
| §19.2 s6a 正控 | 改 `plugin-tests.yml` 两处后、重算钉前 | 续做步骤 18 | `sealed-export-package-provenance.test.cjs` → `SEALED_EXPORT_INTERNAL_ERROR`(红);重算后 → OK(绿) |
| §20(续做步骤 19) | execute 规模上界(500)真库测试 | commit `1786c0566` | 超过 500 触发 400、零行写入(正控);本步未重新独立复现,转抄 |
| §21(续做步骤 20) | RR 默认池文件的 SET 义务格(组合调用) | commit `45e5c8a21` | 见 §1.4 已引用该测试名;判别力=去掉 SET 后 composed caller 读到陈旧 MAX |
| §22.1(续做步骤 21) | preview `candidateCount` 计算改成恒 0 | 续做步骤 21 现场 | 3 例由绿转红(另 11 例不受影响),`cp`/`cmp` 还原确认字节一致 |

**结论**:本次会话对 A-3 唯一亲手做的 mutation(§3.1)与既有记录(§19.2 mutation 2)结果一致;M6 是一条自带正反控的常驻真库测试,已在 §2.2 的常规回归里重新验证;其余六条按 provenance 纪律转抄,标明各自的落地 commit,不冒充今天独立复现。

---

## 4. 补充清单 17 条逐条(`impl-supplementary-gate-checklist-20260918.md`)

### 三条 lane 共用

| # | 项 | 本切片评估 |
|---|---|---|
| 1 | `*-ci-wiring.test.mjs` 闭世界,新文件须逐个普查 | **已核**:五个 backfill 文件各自有独立 `*-ci-wiring.test.mjs`(非"闭世界数组"式,是"逐文件 guard"式,`ci-realdb-step-contract.mjs` 本身无硬编码 `FILES` 数组——`grep -n "^export const FILES\|const FILES ="` 零命中,§19.2 已核过),§2.4 全量重跑 491 passed。**披露文件数分歧**:清单原文「共 45 个」,现场 `find` 得 43 个,数字不一致,见 §2.4 尾注 |
| 2 | `vitest.config.ts` exclude 惯例与 `plugin-tests.yml` 钉 | **已核**:五个 backfill 文件均在 `vitest.config.ts` exclude 名单里(ci-wiring 守卫 (a) 分支断言),且都进了 `plugin-tests.yml` 的 `approval-real-db-integration` 白名单(守卫 (b) 分支断言),与锁 §6 裁定一致 |
| 3 | 改 `plugin-tests.yml` 的 s6a 重钉 | **不适用于本步**:本步(文档定稿)未改 `plugin-tests.yml`;上一次实际改动(续做步骤 18 新增批次列表端点的 CI 接线)已重钉,§2.5 核对字节相同,当前钉是最新值 |
| 4 | 错误码不得降级成裸 HTTP 状态 | **已核**:§7 错误码表(设计 MD)七个专用码(`GROUP_NAME_TAKEN`/`GROUP_SORT_CONFLICT`/`APPROVAL_TEMPLATE_GROUP_BACKFILL_TOO_LARGE`/`…_BATCH_NOT_FOUND`/`…_BATCH_ALREADY_ROLLED_BACK` 等)均在测试断言里按码名而非裸状态码判定(如 rollback 文件的 `changesRequired #7` 用例名直接点名码) |

### lane A(分组,与本切片相关)

| # | 项 | 本切片评估 |
|---|---|---|
| 5 | J/C 行「section=」400 → 请示挪到分期 3 | **不适用于本切片**:`section=` 令牌是分期 3(A-4)的范围,A-3 execute/preview 端点不接受也不解析 `section=` 参数,本切片没有这半句需要挪 |
| 6 | 分期门「1 落地」求值 | **已引用**:见 §1.2,本切片按「Draft PR 过门审」求值,尚未开 PR,门未满足 |
| 7 | 前端 spec 位置(`apps/web/tests/`) | **不适用**:本切片全程无 `apps/web` 改动(设计 MD §22.4/§19.2 均确认),无前端 spec 需要放置 |

### lane B(待办中心)—— 与本切片无关,标 N/A

| # | 项 | 评估 |
|---|---|---|
| 8 | 独立 vitest project 断言 `NODE_ENV` | N/A——本切片不新增独立 vitest project |
| 9 | `MIGRATION_EXCLUDE`/触发集/命名避坑 | N/A——本切片未新增独立 lane,沿用既有 `approval-real-db-integration` 步骤 |
| 10 | `validate-migration-exclude.sh` WARN-ONLY 不能当门 | N/A——本切片未涉及该脚本 |
| 11 | 判据 E(代数守卫)+ §3 第 5 条硬约束属前端切片 2 | N/A——本切片(A-3)无前端 |
| 12 | A0 前两行复用 `approval-wp3-pending-count.api.test.ts` | N/A——B 待办中心专属 |

### lane C(撤销)—— 与本切片无关,标 N/A

| # | 项 | 评估 |
|---|---|---|
| 13 | W7-R10 分类钉(目录 root 清单) | N/A——本切片不改考勤/撤销代码,未落在三个 root 之下 |
| 14 | 考勤四道普查钉 | N/A——本切片未改 `plugin-attendance/index.cjs` 或考勤迁移 |
| 15 | FE 同步钉(`approvalBatchTransferView.spec.ts`) | N/A——C 撤销专属前端文件,本切片未碰 |
| 16 | 锁 §5 I6「撤销不限次」验收 | N/A——I6 是分组锁自己的不变量(改名/挂接不进共享 actor),与撤销锁的"撤销不限次"是两个不同的 I6,本切片不涉及撤销功能 |
| 17 | 锁 §14.1/§14.3/§2-G2 三项(CJS 镜像常量/legacy 两 catch/时间锚) | N/A——均为撤销锁章节号,分组锁没有 §14,本切片不适用 |

---

## 5. 未做 / 未验 / owner 待裁(如实列出,不算作已满足)

1. **验收 E 姊妹判据未验**(§1.4):execute 并发/execute-vs-手工建组的序号不变量,只有设计论证,无构造并发的真库测试。补测试需要改测试代码,超出本任务范围,记入下一实现步骤。
2. **Draft PR 尚未开出**:锁 §6「门 = 1 落地」按「Draft PR 过门审」求值(补充清单 #6),本切片目前只有分支 + 两份 MD,门未满足。开 PR、过 Opus refute-first 门审、PR body 写齐设计 MD §13.6 清单,均是下一步。
3. **12 处代码注释未随文件改名更新**(设计 MD §0′ 之前的抬头块已列全):不改代码边界内的已知残留,留给下一次触碰这些文件的提交顺手改。
4. **门审报告"被审对象"路径失效**:`reviews/design-gate-A3-phase2-20260918.md` 引用的旧文件名(`approval-template-groups-phase2-design-20260918.md`)在本仓当前树里已不存在(rename 到本文档配对的设计 MD 路径),门审报告本身不属本 git 仓、无权限修改,如实披露。
5. **`impl-supplementary-gate-checklist-20260918.md` #1 的文件数分歧**:清单写「45 个」,现场数得「43 个」(§2.4 尾注),未深挖原因,不强行对齐。
6. **owner 待裁三项**(设计 MD §13.4,均已给默认值,Draft 按默认推进不等 owner,但真正"要不要生效"仍待 owner 一句话):
   - **O1**:三张批次表是锁 §2 之外的新表(锁文外 DDL)——建议采纳提案形状,Draft only。
   - **O2**:`atg_name_nonblank CHECK` 拒绝纯中文组名,是 A-1/#5852 上的活缺陷——A-3 在 owner ratify 该勘误前,对纯中文 category **功能性惰性**(诚实披露,见设计 MD 抬头块第 2 条)。
   - **O3**:preview/批次列表端点挂 `approvalTemplateAdminGuard`(偏离 I7 字面读/写二分)——建议按默认值,需 owner 一句话确认。
7. **跨 lane 项,不在本分支权限内**(设计 MD §13.5):A-1 Draft PR #5852 的"0 P1"结论需要因 P1-3(CJK 组名裸 `DatabaseError`)与 changesRequired #16 后半(guard⊋manager 的过强注释)重新求值——这是对另一个 Draft PR 的回流,本分支无权改 A-1 已落地代码/注释。
8. **A-1 两个既有真库文件(`lifecycle`/`serialization`)未被任何 `*-ci-wiring.test.mjs` 覆盖**(P3-2 残留,本切片新增的五个文件继承同样的闭世界残留形态,不是本切片引入的新缺口,但也未被本切片修复)。
9. **一个非 manager 管理员执行 backfill 时,批次头不记录"只覆盖了部分模板"**(设计 MD §19.4 新披露 2):修法需要给批次头加列,超出本步范围(且需要新 DDL,不在本步动)。

---

## 6. 收尾

- `git status --short`(本文档与配对设计 MD 写作前后,`packages/core-backend/src/services/ApprovalTemplateGroupService.ts` 之外的任何文件均未改动):写作前空;§3.1 mutation 探针跑完并 `cmp` 确认字节相同后再次核验为空。
- 本文档与配对设计 MD 是本次提交的全部改动(两个新增/改名的 `.md` 文件),提交信息见 git log,含 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。
- Push 目标:`origin feat/approval-template-groups-phase2-backfill`(普通 push,非 force——本分支已完成的唯一一次 rebase 用过 force-with-lease,见 rebase note §7,本次不涉及 rebase)。
