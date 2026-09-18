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
| 预览(只读,不写) | `tests/integration/approval-template-groups-backfill-preview.db.test.ts`(14 例) | `preview writes ZERO rows: approval_template_groups/links row counts for the org are byte-identical before and after, across a run that produces both a "create" and a "skip" bucket` | `test (20.x)` → `approval-real-db-integration` 步骤(真库,白名单第 81 行,见 §2.3) |
| 执行(写,幂等) | `tests/integration/approval-template-groups-backfill-execute.db.test.ts`(12 例) | `happy path: creates one group per distinct btrim(category), links every eligible template, and records the batch header + both detail tables`;`idempotency: a second sequential execute call on the same eligible population returns batchId: null and writes zero additional rows across every table` | 同上,白名单第 82 行 |
| 可回滚(精确到批次,不影响批次外) | `tests/integration/approval-template-groups-backfill-rollback.db.test.ts`(11 例) | `happy path: rollback archives the batch-created group, unlinks the batch-linked templates, and stamps rolled_back_at`;`batch-external addition to a batch-created group survives rollback: the group stays active because it is not empty`;`a batch-linked template moved to a different group by a batch-external action is left exactly where the external action put it` | 同上,白名单第 83 行 |
| DDL(批次头 + 两张明细表) | `tests/integration/approval-template-groups-backfill-schema.db.test.ts`(8 例) | `the three FK delete-actions match the design-gate Q5 ruling exactly (a=NO ACTION, c=CASCADE)`;`M6 positive control: hard-deleting a linked template cascades through group_links into the batch_links row (no FK violation)` | 同上,白名单第 80 行 |
| 批次可查(changesRequired #5) | `tests/integration/approval-template-groups-backfill-batches-list.db.test.ts`(8 例) | `orders by created_at DESC and paginates with limit/offset, with an accurate total independent of the page size`;`rolledBackAt is null for a not-yet-rolled-back batch and an ISO string for a rolled-back one, and org scoping excludes a foreign org entirely` | 同上,白名单第 84 行(最后一个 file 参数) |
| 授权面(写=admin guard,非字面 I7 二分,已披露) | 上述五文件各自的 `route wiring` 嵌套 `describe` | 五文件均含 `an actor holding ONLY approvals:read (no approval-templates:manage) gets 403` + `an unauthenticated request gets 401, not a silent 200` | 同上 |

白名单位置(`lifecycle`=78、`serialization`=79、`backfill-schema`=80、`backfill-preview`=81、`backfill-execute`=82、`backfill-rollback`=83、`backfill-batches-list`=84,是 84 个 file 参数里的最后 7 个)由 `nl -ba /tmp/a3docs-realdb-step-body.txt | grep -E "lifecycle|serialization|backfill-"` 现场核对——本节初稿曾把这五个位置错写成 78–82(整体少算了 2),已订正;承重的是「五文件均在 `approval-real-db-integration` 步骤的白名单参数列表里」这件事本身(§2.4 的五个 ci-wiring 守卫逐文件断言过这一点),具体序号只是佐证,不独立承重。

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

### 1.4 锁 §4 验收 E「序号不变量」——**A-3 execute 路径,拆两条腿讲(隔离级别腿已覆盖,终态腿未覆盖)**

锁 §4 的 E 行原文判据是「分期 1 的 DDL + 建组;分期 3 的重排:并发两次建组 ⇒ 序号 n+1、n+2 各一,无 23505 泄露」+「隔离级别格:主判据(行为)……mutation:去掉显式 SET ⇒ B 的 RR 快照在停车前已取,读到陈旧 MAX,COMMIT 撞 23505」——**E 本身就是两条腿**:隔离级别腿(生产代码必须显式 `SET … READ COMMITTED`,否则在 RR 默认池上读到陈旧快照)与终态腿(两个真正并发的写者各自落到 n+1/n+2、零 23505 泄露)。这是**分期 1/3** 的判据原文,A-3(分期 2)execute 只是**复用同一条 `MAX+1 → INSERT` 语句**(设计 MD §1「建组语句形状」行)进组合调用,因此设计 MD §3.2 称其为「E 的姊妹判据」而非 E 本身。逐条核对本切片测试后,两条腿的覆盖情况不同,不能笼统合并成一句"未验":

- **隔离级别腿——已覆盖(commit `45e5c8a21`,落在 A-1 的 RR-default-pool 文件 `approval-template-groups-serialization.db.test.ts`,不在本切片自己的五个文件里,但覆盖的正是 A-3 execute 这个组合调用者)**。读该 commit 引入的用例本体确认(不是只读 commit message 转述):`A-3 execute (composed caller): under the RR-default pool, execute still reads a concurrently-committed holder row at MAX(sort_order) — proving the SET this composed transaction issues is not a single-primitive-only obligation`——这是一个**真实构造的并发场景**:一条裸连接持 L0 并提交一个 `sort_order=1` 的组(占住 MAX),与此同时发出一次真实 `POST …/backfill/execute`(完整 guard 链),该请求停在同一把 L0 上,裸连接提交后放行,断言 = HTTP `201` 且新建的组 `sort_order > 1`(读到了并发提交后的新鲜 MAX,不是陈旧快照 ⇒ 不会在 COMMIT 撞 `23505`)。commit message 自陈的 mutation 证据:把 `beginApprovalTemplateGroupTxn(client)` 换成裸 `client as AtgTxClient` 类型转换(跳过实际发 SET),**恰好**这一条用例变红,该文件其余 10 条与 `backfill-execute.db.test.ts` 自己的 12 条均不受影响——判别力落在"组合调用者是否真的发了 SET"这一点上,与 E 隔离级别腿的机制完全一致,只是被测调用者从单原语换成了 A-3 的组合调用者。**这一腿在 A-3 execute 路径上已验证。**
- **终态腿——未覆盖**。逐条读 `approval-template-groups-backfill-execute.db.test.ts`(12 例)与 `-rollback.db.test.ts`(11 例)的全部用例名(见 §1.1 表),没有一条构造「两个并发 `POST …/execute`」或「一个 execute 并发一个手工建组」、**双方都真正跑到提交**、断言各自落到 `sort_order` 的 n+1/n+2、零 `23505` 泄露的终态测试。设计 MD §3.2 对这条腿只给出**论证**(两个并发 execute 在同一把 `atg:${orgId}` 顾问锁上排队,先提交者清空 `eligible`,后到者重新查询后发现候选已清零 ⇒ 退化为空事务 `{batchId: null}`,**不需要**真的走到"两次同时 INSERT 争抢同一个 `MAX+1`"的分支)——论证成立与否本身没有问题,问题是**没有真库测试验证这个论证描述的退化路径确实发生**(例如:两个并发 execute,断言后到者确实拿到 `batchId: null` 而不是也创建了一个重复/冲突的组)。
- **另外两条容易与上面混淆但仍不能替代终态腿的测试**(§13 changesRequired #13 剩余两项,commit `117e248cb`/`f3b3cc5d3`,同样落在 `serialization.db.test.ts`):`REVERSE positive control …: awaiting a non-WithClient exported function from inside an already-open transaction() self-deadlocks at the L0 lock wait …` 与 `execute lock-order (design-gate M2, §13.2 fix): stalls on the batched deterministic pre-lock statement, not a per-category one`——这两条断言的是**锁序自死锁陷阱**与**停车点**(`waitUntilBackendBlockedByHolder`),既不是隔离级别腿也不是终态腿,判别力再次不同,不能互相替代。
- **结论**:E 在 A-3 execute 路径上,隔离级别腿**已验**(`45e5c8a21`),终态腿(两个并发 execute 都跑完、序号各得 n+1/n+2 或"第二个退化为空批次"这一具体断言)**未验**。这不是本步能补的缺口(补测试属于代码/测试改动,超出本任务「不改代码」边界),如实记入 remaining(§5)——remaining 条目已按此收窄,不再写成"E 的姊妹判据整体未验"。

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

### 2.4 五个 ci-wiring 守卫 + 哨兵普查 + 闭世界普查

```
$ node --test scripts/ops/approval-template-groups-backfill-{batches-list,execute,preview,rollback,schema}-ci-wiring.test.mjs
ℹ tests 15
ℹ pass 15
ℹ fail 0
```
每文件 3 断言(exclude 名单 / plugin-tests.yml 白名单 / 文件存在),5×3=15,全绿。

**哨兵普查(五个 backfill 文件各自的 anti-skip-green 哨兵,本步现场 grep,非转抄)**:
```
$ grep -c "sentinel: EXPECT_DB lane must have DATABASE_URL" \
    tests/integration/approval-template-groups-backfill-schema.db.test.ts \
    tests/integration/approval-template-groups-backfill-preview.db.test.ts \
    tests/integration/approval-template-groups-backfill-execute.db.test.ts \
    tests/integration/approval-template-groups-backfill-rollback.db.test.ts \
    tests/integration/approval-template-groups-backfill-batches-list.db.test.ts
…-schema.db.test.ts:1
…-preview.db.test.ts:1
…-execute.db.test.ts:1
…-rollback.db.test.ts:1
…-batches-list.db.test.ts:1
```
五文件各恰一条,均已在 §2.2 的真库回归里跑绿(`itIfExpectDb`,`EXPECT_DB=1` 时才不跳过)——`EXPECT_DB=1` 且 `DATABASE_URL` 缺失时该哨兵自身也会被 `describeIfDatabase` 跳过而不是变红,这是设计 MD §19.4「新披露 1」已记录的继承残留,本步未修复(不改代码边界),原样结转。

**`ci-realdb-step-contract.mjs` 闭世界census(本步现场重跑,非转抄 §19.2 的旧记录)**:
```
$ grep -n "^export const FILES\|const FILES =" scripts/ops/ci-realdb-step-contract.mjs
(no output, exit 1)
$ sed -n '99,102p' scripts/ops/ci-realdb-step-contract.mjs
export const REAL_DB_STEP_IDS = Object.freeze({
  approval: 'approval-real-db-integration',
  multitable: 'multitable-real-db-integration',
})
```
零命中确认:该文件导出的是 `REAL_DB_STEP_IDS`(id 字符串映射,补充清单 #1 点名的"稳定 id")而非某个硬编码的逐文件 `FILES` 数组——五个 backfill 文件各自的独立 `*-ci-wiring.test.mjs` 才是"闭世界普查"的实际承重点(§2.4 上方 15/15),不是靠往这个共享文件的某个数组里追加条目。

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

1. **验收 E 姊妹判据的终态腿未验**(§1.4;隔离级别腿已由 `45e5c8a21` 覆盖,不是整体未验):两个真正并发的 execute(或 execute 并发手工建组)都跑到提交、各自落到 n+1/n+2 或"后到者退化为空批次"这一具体终态,只有设计论证(§3.2),无构造并发的真库测试。补测试需要改测试代码,超出本任务范围,记入下一实现步骤。
2. **Draft PR 尚未开出**:锁 §6「门 = 1 落地」按「Draft PR 过门审」求值(补充清单 #6),本切片目前只有分支 + 两份 MD,门未满足。开 PR、过 Opus refute-first 门审、PR body 写齐设计 MD §13.6 清单,均是下一步。
3. **12 处代码注释未随文件改名更新**(设计 MD §0′ 之前的抬头块已列全):不改代码边界内的已知残留,留给下一次触碰这些文件的提交顺手改。
4. **门审报告"被审对象"路径失效**:`reviews/design-gate-A3-phase2-20260918.md` 引用的旧文件名(`approval-template-groups-phase2-design-20260918.md`)在本仓当前树里已不存在(rename 到本文档配对的设计 MD 路径),门审报告本身不属本 git 仓、无权限修改,如实披露。
5. **`impl-supplementary-gate-checklist-20260918.md` #1 的文件数分歧**:清单写「45 个」,现场数得「43 个」(§2.4 尾注),未深挖原因,不强行对齐。
6. **owner 待裁三项**(设计 MD §13.4,均已给默认值,Draft 按默认推进不等 owner,但真正"要不要生效"仍待 owner 一句话):
   - **O1**:三张批次表是锁 §2 之外的新表(锁文外 DDL)——建议采纳提案形状,Draft only。
   - **O2**:`atg_name_nonblank CHECK` 拒绝纯中文组名,是 A-1/#5852 上的活缺陷——A-3 在 owner ratify 该勘误前,对纯中文 category **功能性惰性**(诚实披露,见设计 MD 抬头块第 2 条)。
   - **O3**:preview/批次列表端点挂 `approvalTemplateAdminGuard`(偏离 I7 字面读/写二分)——建议按默认值,需 owner 一句话确认。
7. **跨 lane 项,部分已随修复轮 1 解决**(设计 MD §13.5):A-1 Draft PR #5852 的"0 P1"结论需要因 P1-3(CJK 组名裸 `DatabaseError`,O2)重新求值——**这一半仍然开放**,是对另一个 Draft PR 的回流,本分支无权改 A-1 已落地代码。changesRequired #16 后半(guard⊋manager 的过强注释,`routes/approvals.ts:396-399`)**这一半已在修复轮 1 解决**——不是本分支现场改写 A-1 代码,而是 A-1 自己的第 4/5 轮门审已把这条注释真库证伪并重写(`f7b929700`),本分支第二次 `git rebase origin/feat/approval-template-groups-phase1`(2026-09-18)把该修复原样带入本树;详见 §7。
8. **A-1 两个既有真库文件(`lifecycle`/`serialization`)未被任何 `*-ci-wiring.test.mjs` 覆盖**(P3-2 残留,本切片新增的五个文件继承同样的闭世界残留形态,不是本切片引入的新缺口,但也未被本切片修复)。
9. **一个非 manager 管理员执行 backfill 时,批次头不记录"只覆盖了部分模板"**(设计 MD §19.4 新披露 2):修法需要给批次头加列,超出本步范围(且需要新 DDL,不在本步动)。

---

## 6. 收尾(本文档定稿时,2026-09-18)

- `git status --short`(本文档与配对设计 MD 写作前后,`packages/core-backend/src/services/ApprovalTemplateGroupService.ts` 之外的任何文件均未改动):写作前空;§3.1 mutation 探针跑完并 `cmp` 确认字节相同后再次核验为空。
- 本文档与配对设计 MD 是本次提交的全部改动(两个新增/改名的 `.md` 文件),提交信息见 git log,含 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。
- Push 目标:`origin feat/approval-template-groups-phase2-backfill`(普通 push,非 force——截至本文档初版定稿这一刻,本分支只完成过一次 rebase,用过 force-with-lease,见 rebase note §7;本次定稿动作本身不涉及 rebase。**这句话只描述到此刻为止的状态,不是对全篇历史的断言**——本分支后续确有第二次 rebase,记录在 rebase note §8 与本文档 §7,那次 push 同样用了 force-with-lease)。

---

## 7. 修复轮 1 处置(`impl-gate-A3-round1-20260918.md`,裁定 0 P1 / 1 P2 / 7 P3)——本节处置该报告点名的唯一 P2

**范围声明**:本轮只处置该门审报告的 P2(§5)。门审自建的 detached worktree `wt-A3-gate1` 未改本 lane 树;本轮之前 `git status --short` 为空,HEAD = `9bda1dbccd8ce7145e2ed88a789f43128ad2de75`(该门审 verdict 绑定的 head,逐字匹配)。

### 7.1 P2 —— head 不是 `origin/feat/approval-template-groups-phase1` 的后代

**修法**(按门审 §5「修法」逐字执行):

1. **rebase**:`git rebase origin/feat/approval-template-groups-phase1`。26 个本 lane 提交全部重放,**零冲突**(门审 §5 预判「最早的 hunk 从 `@@ -437,6 +447,338 @@` 起,不落在 phase1 `@@ -395,28 +395,42 @@` 的改动范围内」成立,实测确认)。新 HEAD:`ff1e40686659a4ec3c66d3a717643b16e1af50fa`(本文档与配对设计 MD 的两处订正之前;含订正后的最终 HEAD 见 StructuredOutput/git log,本节其余证据均在订正后的树上重跑)。
   ```
   $ git merge-base --is-ancestor origin/feat/approval-template-groups-phase1 HEAD && echo YES
   YES
   $ git rev-list --count origin/feat/approval-template-groups-phase1 ^HEAD
   0
   ```
   门审 §8 复核清单第 1 条(必须 YES)已满足。
2. rebase 把 A-1 第 4/5 轮门审对 `routes/approvals.ts:396-` 块注释的重写(commit `f7b929700`,"retract falsified wildcard-permission guard claim")原样带入本树——这正是门审"后果 (a)"预判的自愈:该注释现在只主张 DB 侧 `isAdmin(userId)` 一条腿是端到端实测成立的「过 guard 但非 manager」反例,通配权限码那条腿被明确记为"第 2 轮与第 4 轮各真库证伪一次"。
3. **后果 (b)——rebase 修不掉的两处 lane 自有文档**,现场机械扫描(不是逐条枚举,按门审 §5 修法用 phase1 自己的 `scripts/dev/atg-retraction-sweep.sh` 而非手数,因为该脚本的扫描范围是 `git diff --name-only origin/main..HEAD`,rebase 之后天然覆盖本 lane 的全部文件):
   ```
   $ bash scripts/dev/atg-retraction-sweep.sh > /tmp/atg-sweep-full.txt 2>&1; echo exit=$?
   exit=0
   $ grep -c "^=== pattern" /tmp/atg-sweep-full.txt
   11
   ```
   11 个模式全部跑过。逐条读过命中的完整句子(不是只看 grep 片段)后分类:
   - **本 lane 文件里唯二的「present-tense 现在时事实」命中**(门审判定规则的类别 2,活缺陷):`approval-template-groups-phase2-backfill-design-20260918.md:440`(§13 changesRequired #8/Q2 现场标注段,原文"持 `approval-templates:*` 或走 DB 侧 `isAdmin(userId)` 的主体过 guard 但非 manager"把已证伪的通配腿当成第二条成立的反例)与 `:586`(§13.6 Draft PR body 必写清单,changesRequired #16 一行,原文"两类主体过 guard 但非 manager")——逐字匹配门审 §5 后果 (b) 点名的两处。
   - 已重写为:guard ⊋ manager 结论不变,但**只标注一条被端到端实测支撑的腿**(DB 侧 `isAdmin`),通配腿改写成"该腿在 phase1 第 2/4 轮门审各端到端真库证伪一次,全仓真实授予计数 0,今天不存在可达形式"。
   - 重写后重跑同一脚本确认这两处不再落入类别 2(现摘录,完整命中见 `/tmp/atg-sweep-after.txt`):
     ```
     $ bash scripts/dev/atg-retraction-sweep.sh > /tmp/atg-sweep-after.txt 2>&1
     $ grep -n "phase2-backfill-design-20260918.md:440\|phase2-backfill-design-20260918.md:586" /tmp/atg-sweep-after.txt | wc -l
     4
     ```
     （4 = 两行各命中 2 个模式:`guard population`、`guard *人口`,均已人工逐条核对——两处现在只 narrate「通配腿已被 phase1 证伪」,不再断言它成立,归类 3,合法保留。第 440 行不再命中 `⊆`/`sees everything`/`通配权限码.*过 *guard` 三个模式,因为改写后不再含"通配腿单独过 guard"这句主张本身。）
   - 本 lane 文件里其余命中(如 `backfill-preview.db.test.ts:305` 的 "scope is a property of the ACTOR's guard population" 一句)与 guard⊆manager 的撤回声明是**不同主题**的假阳性(门审判定规则类别 4),核对后确认不是同一个claim,不动。
   - `approval-template-groups-phase2-backfill-design-20260918.md:578`(§13.5 项 2)与 `:871/:935/:987/:1041` 的"changesRequired #16 后半……应随 P1-3 一并回流 #5852"仅仅是**narrating**"这条注释是过强声明"这一事实(类别 3,不是断言通配腿成立),不需要按本 P2 重写;但其"回流 #5852"这个跨 lane 升级计划,内容上已被 §7.1 步骤 1-2 的 rebase 越过(A-1 自己已经修了,不必再回流)——见 §5 项 7 的订正。
4. **改动范围核实**(本轮 gate-fix 的全部代码/文档改动):
   ```
   $ git diff --stat 9bda1dbccd8ce7145e2ed88a789f43128ad2de75.. -- docs/development/approval-template-groups-phase2-backfill-design-20260918.md docs/development/approval-template-groups-phase2-backfill-verification-20260918.md docs/development/approval-template-groups-phase2-backfill-rebase-note-20260918.md
   ```
   （提交后以 commit 里的实际 diffstat 为准;三份文档均为 doc-only 编辑,`packages/core-backend/src`、迁移目录、`.github/workflows/plugin-tests.yml` 均未在本轮改动——rebase 带入的 9 个 phase1 提交才碰了 `routes/approvals.ts`/`lifecycle.db.test.ts`/两个新 `scripts/dev/*.sh`,不是本轮 lane 自己写的。）

### 7.2 重跑门审 §8 复核清单 2–4(rebase 后的完整回归)

| # | 门审 §8 要求 | 命令 | 结果 |
|---|---|---|---|
| 1 | ancestor 判据 | 见 §7.1 步骤 1 | YES / 0 |
| 2 | `grep -n "approval-templates:\*"` 两文件 + 跑 `atg-retraction-sweep.sh` | 见 §7.1 步骤 3 | 两处活命中已订正为叙述式;脚本 exit 0 |
| 3a | E1 七套件真库(私有库 `metasheet2_lock_a3`,`db:migrate` 确认 `Applied: 408 / Pending: 0`) | `DATABASE_URL=postgres://…/metasheet2_lock_a3 EXPECT_DB=1 npx vitest --config vitest.integration.config.ts run <7 files> --reporter=dot` | `Test Files 7 passed (7)` / `Tests 85 passed (85)`,与门审报告 E1 计数逐字相同(rebase 未新增/删除本切片用例) |
| 3b | E2 无库全量 lane | `env -u DATABASE_URL CI=true pnpm --filter @metasheet/core-backend test` | `Test Files 931 passed \| 175 skipped (1106)` / `Tests 14718 passed \| 1604 skipped (16322)`,exit 0——与门审报告逐字相同(注:同一命令的第一次尝试因共享 `/private/tmp` worktree 里一个与本切片无关的瞬时未跟踪文件 `src/attendance/zz-nit3-untracked-scratch.ts` 消失导致 `role-assignment-boundary.test.ts` 的文件系统扫描 ENOENT,单独重跑该文件绿 40/40,判定为 TOCTOU 竞态而非本轮改动引入;本行的 931/14718 数字取自随后干净重跑的第二次结果) |
| 3c | E2′ 六个全仓 census 守卫 | 从 E2 日志逐条 grep | `approval-field-access-enum-mirror.test.ts`、`multitable-o2-census-closed-world.test.ts`、`approval-lock8-field-type-census.test.ts`、`automation-test-run-error-codes-web-parity.test.ts`、`ai-provider-call-site-census.test.ts` 均 ✓(recovery-conflict-census.test.ts 见上方摘录,同样全绿) |
| 3d | E2″ 五个 `.db.test.ts` 在无库 lane 零收集 | `grep -a "tests/integration/approval-template-groups" <E2 日志> \| grep -v approval-ci-coverage-enumeration \| wc -l` | `0`(注:裸 `grep -a "approval-template-groups"` 命中 7 行,均是 `approval-ci-coverage-enumeration.test.ts` 自己"is wired: …"的断言输出,不是这些文件被收集执行——加限定词排除后为 0,与门审 E2″ 结论一致) |
| 3e | E3 两条 tsc | `npx tsc --noEmit`;`npx tsc -p scripts/tsconfig.recovery-archive-acceptance.json` | 均零输出,exit 0 |
| 4a | E4 五个 ci-wiring 守卫 | `node --test scripts/ops/approval-template-groups-backfill-{schema,preview,execute,rollback,batches-list}-ci-wiring.test.mjs` | 各 `fail 0` |
| 4b | E4 s6a provenance | `node --test plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs` | `pass 1 / fail 0` |
| 4c | E4 census enumeration | `npx vitest run tests/unit/approval-ci-coverage-enumeration.test.ts --reporter=dot` | `349 passed (349)` |
| 5 | E5 s6a 钉字节核对 | `shasum -a 256 .github/workflows/plugin-tests.yml` vs `pins.json` | `099904601c47c078fa5c81bf4387a26cc0678174de5a24f54b5edc86ae5bece1`,逐字相同(`git diff --stat origin/main -- .github/workflows/plugin-tests.yml` 显示本分支对该文件仅有 42 行**新增**、无删改,rebase 未触碰它,pin 天然仍然有效) |

M1/M2/M14 三条 mutation 的复核(门审 §8 复核清单第 4 条,原文建议抽打两条,本轮抽打了 M3,详见下方):留待下一轮或 Draft PR 前。**订正一处推论**:此前草稿曾写"E1 的 7/85 计数与门审报告一致 ⇒ 断言集合不变 ⇒ 四条 mutation 打的靶子仍在原处",这是一条不成立的推论——用例计数不变不能推出用例内容不变(phase1 对 `lifecycle.db.test.ts` 改了 50 行,计数照样可能不变),已删除该推论;M1/M2/M14 未重打,是**未验**,不是"计数担保过的已验"。

**M3 已重打**(本轮唯一重新亲跑的一条,理由:它打击的正是本轮 rebase 触碰最深的文件 `routes/approvals.ts`——phase1 改了其中 52 行):`cp packages/core-backend/src/routes/approvals.ts /tmp/approvals.ts.orig` 备份 → 把 execute 批次明细的 `linked_at` 写入源从"服务端相关子查询"改回"原语返回的 JS `linkedAt`"(门审 M3 的失效形态,`const linked = await linkApprovalTemplateToGroupWithClient(...)` 后改用 `linked.linkedAt` 作为 `VALUES` 参数而非原来的相关 `SELECT`)→ 单独跑 `approval-template-groups-backfill-execute.db.test.ts` + `approval-template-groups-backfill-rollback.db.test.ts` → `cp /tmp/approvals.ts.orig packages/core-backend/src/routes/approvals.ts` 还原 → `cmp` 确认字节相同,再重跑同两个套件确认恢复绿。
```
$ cmp packages/core-backend/src/routes/approvals.ts /tmp/approvals.ts.orig && echo IDENTICAL
IDENTICAL
```
结果:execute 套件 1 例红,rollback 套件 4 例红(依赖同一批 `linked_at` 令牌做集合式匹配/精确性断言的用例,如 `expect(linkRow.rows).toHaveLength(0)`、`expect(batchLinkRow.rows[0].group_id).toBeNull()`、`expect(Number(groupRow.rows[0].n)).toBe(1)` 三处具体断言变红)——与门审报告 M3"红 5 条(execute 1 + rollback 4)"逐字吻合,判别力在 rebase 后的树上依然成立;还原后重跑同两个套件回到 `2 passed (2)` / `23 passed (23)`。M1/M2/M14 未重打,记入 remaining。

### 7.3 SHA 引用漂移声明

本次 rebase 重写了本 lane 全部 26 个提交的 SHA。本文档、配对设计 MD、`rebase-note` 三份文档里此前记录的 lane 自有提交 SHA(如设计 MD §1"`68aead6db` 之后"、§13 附近的 lane commit 引用)**指向 rebase 前的旧历史线**,rebase 后已不在 `git log` 可达范围内(悬空,直到 `git gc` 前仍可用 `git show <sha>` 单独查到,但不在分支历史上)。本节及 §7.1/§7.2 之外的既有正文**不逐条重算**这些历史 SHA 引用——门审 §8 复核清单没有要求这么做,且这些引用的作用是"指向当时落地这件事的那个提交"这一叙事锚点,不是本轮门审判据读取的对象;唯一被门审判据直接读取的锚点(head SHA、phase1 ancestor 关系、E1–E5 计数)均已在 §7.1/§7.2 用**新 SHA / 现场重跑**重新钉过。若后续轮次需要引用某条历史内容,应先用 `git log --all --oneline | grep <关键词>` 或直接读本文档记录的旧 SHA(仍可 `git show` 到)重新定位,而不是假设旧 SHA 还在当前分支的 `git log` 里。

### 7.4 未处置的门审发现(如实列出,不算已满足)

门审报告 §6 的 7 条 P3 与 §8 复核清单第 4 条(mutation 抽打)不在本轮范围内,按任务书"选尚未处理的一到三条"只处置了这唯一的 P2(rebase + 两处文档订正 + 全套回归属于同一条 P2 的处置动作,不是三条独立条目)。P3 逐条状态:
1. 三处"接线还不存在"的过期断言注释——未动。
2. 12 处指向改名前文档路径的注释——未动(与本 P2 无关的独立残留)。
3. `atgbb_org_nonblank` 未进 `NONBLANK_CHECK_CONSTRAINTS`——未动(需要服务层测试才能安全改,今天不可达,见门审原文)。
4. 验证 MD §5 第 8 条与 §2.4 自相矛盾——**本轮顺带核实但未改**:§2.4 与 §5.8 的矛盾在 rebase 前后没有变化,仍然是"§5.8 低估了自己",留给下一轮。
5. 验收 E 终态腿未测——未动,已在 §5 项 1 记录为 remaining。
6. `~ '[!-~]'` SQL/JS 等价未钉 collation 限定测试——未动。
7. 补充清单 #1 的"`ci-realdb-step-contract.mjs` 硬编码 `FILES` 数组"前提在本 head 上为假——未动(本文档 §4 第 1 行已经写了"零命中确认",未单独点出"清单前提本身过期"这句话,门审 §6 第 7 条建议在 PR body 里点名,留给开 PR 那一步)。
