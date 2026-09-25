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
| 1 | `*-ci-wiring.test.mjs` 闭世界,新文件须逐个普查 | **已核**:五个 backfill 文件各自有独立 `*-ci-wiring.test.mjs`(非"闭世界数组"式,是"逐文件 guard"式,`ci-realdb-step-contract.mjs` 本身无硬编码 `FILES` 数组——`grep -n "^export const FILES\|const FILES ="` 零命中,§19.2 已核过),§2.4 全量重跑 491 passed。**独立勘误(不是未深挖的分歧,是本清单条目的前提在本 head 上不成立)**:清单 #1 原文的隐含陷阱是"存在一个硬编码的逐文件 `FILES` 数组,新文件必须手工塞进去,否则漏接线"——这个前提对本切片不适用,因为 `ci-realdb-step-contract.mjs` 根本不存在这样的数组(只导出 `REAL_DB_STEP_IDS` 这个 id 字符串映射 + 一组解析函数),五个新文件的两点接线(`vitest.config.ts` exclude + `plugin-tests.yml` 白名单)靠的是各自独立的 `*-ci-wiring.test.mjs` 守卫,不是往共享数组里追加条目。清单原文另写「同族 *-ci-wiring 共 45 个」,现场 `find . -iname '*-ci-wiring.test.mjs' -not -path '*/node_modules/*' | wc -l` = **43**,不是 45——这处文件计数分歧本身不改变上一句结论(陷阱不适用),两条各自独立记录,不合并成一句"未深挖" |
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
7. **跨 lane 项,部分已随修复轮 1 解决,一处状态断言已被后续 rebase 更新**(设计 MD §13.5):A-1 Draft PR #5852 的"0 P1"结论需要因 P1-3(CJK 组名裸 `DatabaseError`,O2)重新求值——**这一半仍然开放**,是对另一个 Draft PR 的回流,本分支无权改 A-1 已落地代码。changesRequired #16 后半(`routes/approvals.ts:396-399` 的过强注释)——不是本分支现场改写 A-1 代码,而是 A-1 自己陆续多轮门审在真库证伪并重写这条注释:第 4/5 轮(`f7b929700`)先把"通配权限码单独过 guard"这条腿证伪,本分支第二次 rebase 时原样带入本树;第 6/7 轮(`3e53c52fe`)又进一步证伪了"guard ⊋ manager(严格超集)"这个结论本身,发现两个人口是**互不包含**(反方向反例:持 `approval-templates:manage` 但未过 namespace admission 的主体被 guard 403 却被 `isTemplateManager` 判成 manager),本分支**第三次** rebase(2026-09-18,到 `a728ed655`)已把这条修复原样带入本树。**这一半不是"已解决后维持不变",而是"随 A-1 的证伪推进被反复重写,当前树已是最新版本"**——本文档 §9 记录第三次 rebase 的 git 力学,§7.3 本节及 §13.6(设计 MD)已按互不包含改写措辞。
8. **A-1 两个既有真库文件(`lifecycle`/`serialization`)未被任何 `*-ci-wiring.test.mjs` 覆盖**(P3-2 残留,不是本切片引入的新缺口,也未被本切片修复)。**订正(与 §2.4 对齐,原文字"本切片新增的五个文件继承同样的闭世界残留形态"与 §2.4 自相矛盾,现已删除该半句)**:本切片新增的五个 backfill 文件**不继承**这个残留——`node --test scripts/ops/approval-template-groups-backfill-{batches-list,execute,preview,rollback,schema}-ci-wiring.test.mjs` 显示每个新文件各有专属守卫,5×3=15 条断言全绿(见 §2.4),M6 已证该守卫承重。残留范围仅限 A-1 的两个既有文件。
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
   - 已重写为:guard ⊋ manager 结论不变,但**只标注一条被端到端实测支撑的腿**(DB 侧 `isAdmin`),通配腿改写成"该腿在 phase1 第 2/4 轮门审各端到端真库证伪一次,全仓真实授予计数 0,今天不存在可达形式"。**求值(2026-09-18,第三次 rebase 后,记忆 `feedback_supersession_marker_must_evaluate_not_void`)**:这句"guard ⊋ manager 结论不变"本身已被 phase1 第 6/7 轮门审(`3e53c52fe`)进一步证伪——两个人口是**互不包含**,不是严格超集:反方向的实测反例是持 `approval-templates:manage` 权限码但未过 namespace admission 合取项的主体,被 `isTemplateManager` 精确 `.includes()` 判成 manager,却被 `rbacGuardAny` 拒绝(403)。本条目下面记录的"只标注一条腿"这个动作本身仍然如实(那是当时唯一已知的实测反例),但它的结论句已经过期,不得再引用"guard ⊋ manager 结论不变"这半句作为今天成立的事实;当前状态见 §13.4/§13.6(设计 MD)与本文档 §9。
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

门审报告 §6 的 7 条 P3 与 §8 复核清单第 4 条(mutation 抽打)不在本轮范围内,按任务书"选尚未处理的一到三条"只处置了这唯一的 P2(rebase + 两处文档订正 + 全套回归属于同一条 P2 的处置动作,不是三条独立条目)。P3 逐条状态(**本轮 = 修复轮 2,处置 1/2/3 三条,详见 §8**):
1. 三处"接线还不存在"的过期断言注释——**修复轮 2 已修,见 §8.1**。
2. 12 处指向改名前文档路径的注释——**修复轮 2 已修,见 §8.2**。
3. `atgbb_org_nonblank` 未进 `NONBLANK_CHECK_CONSTRAINTS`——**修复轮 2 已修 + 新增判别力测试,见 §8.3**(门审原文"需要服务层测试才能安全改,今天不可达"这句话本身有一处可拆分:端到端不可达是真的,但 `mapGroupConstraintError` 是纯函数,不需要真库/路由即可直接单元测试它对一个合成 `{code,constraint}` 对象的映射——见 §8.3 的判别力证据)。
4. 验证 MD §5 第 8 条与 §2.4 自相矛盾——**修复轮 3 已修,见 §5 项 8 与 §10.2**(`impl-gate-A3-round2-20260918.md` §7 P3-2)。
5. 验收 E 终态腿未测——未动,已在 §5 项 1 记录为 remaining。**下一轮建议不选此条**:结果式竞态判据在 mutation 下也可能良性通过(记忆 `feedback_race_acceptance_assert_blocking_not_outcome`),一个弱化版本比不写更糟,需要认真设计而不是本轮体量的顺手修。
6. `~ '[!-~]'` SQL/JS 等价未钉 collation 限定测试——**修复轮 3 已修,见 §10.3**(`impl-gate-A3-round2-20260918.md` §7 P3-4):按本条上面已经选定的更便宜的选项,把"已在 glibc/en_US.UTF-8 上机械对拍,musl 轴未验"这句限定语写全,写进 `ApprovalTemplateGroupService.ts` 的 `STORABLE_GROUP_NAME_PATTERN` doc-comment(主锚点)+ `routes/approvals.ts` 的 SQL 谓词旁 + `-execute.db.test.ts` 交叉验证用例旁(各一句指回主锚点的注释),不是新增测试。
7. 补充清单 #1 的"`ci-realdb-step-contract.mjs` 硬编码 `FILES` 数组"前提在本 head 上为假——**修复轮 3 已改写成独立勘误句,见 §4 第 1 行与 §10.4**(`impl-gate-A3-round2-20260918.md` §7 P3-5):不再是"披露一处数字分歧,不深挖",而是明确写出"该数组不存在,清单#1描述的陷阱对本切片不适用"这句结论,与「45 vs 43」的文件计数分歧分开各自成句。

---

## 8. 修复轮 2 处置(本轮,`impl-gate-A3-round1-20260918.md` §6 P3-1 / P3-2 / P3-3)

**范围声明**:任务书"选尚未处理的一到三条",本轮处置 §7.4 列出的第 1/2/3 条(三处过期断言注释、12 处改名前路径、`atgbb_org_nonblank` 映射缺口)。**行为变化的准确范围**(不能笼统写"零行为变化",`mapGroupConstraintError` 本身就在 execute 事务的错误处理路径上,§8.3 确实改了它的一个分支):P3-1/P3-2 是纯注释/文档路径改写,零行为变化;P3-3 对**任何今天可达的输入**零行为变化(§8.3 已论证 `org_id` 在到达这段代码前已被路由层 403 拦掉空白值,且库内既有 org id 全是 ASCII,所以 `atgbb_org_nonblank` 这条 CHECK 今天造不成任何一次真实的 23514),行为变化只发生在**假设**有一个非可打印-ASCII 的 org id 撞上这条 CHECK 的那个不可达分支——从"未映射的裸 500"变成"映射后的 400",这正是 P3-3 要修的那件事,不是意外副作用。preview/execute/rollback 的请求处理逻辑本身(SQL 语句、锁序、事务边界、guard)一行未动,§8.4 的回归重跑证明这一点。未选 §7.4 第 4/5/6/7 条:第 4 条是纯文字自检、体量不到独立一条;第 5/6 条门审自己的 remaining 备注已建议下一轮暂缓或换更便宜的做法(见 §7.4 原文);第 7 条要点名的对象是将来开 PR 时的 PR body,不是本仓代码/文档。

### 8.1 P3-1 —— 三处"接线还不存在"的过期断言注释,在本 head 上为假

门审原文点名的三处、逐处订正后现场读码:

1. `packages/core-backend/src/db/migrations/zzzz20260919090000_create_approval_template_group_backfill_batches.ts:24-27`(原:「nothing reads or writes these tables until the W7/W8/W9 route layer lands in a later PR」)→现:
   ```
   Additive only, Draft-only migration. The W7 (preview) / W8 (execute) / W9 (rollback) route
   layer that reads and writes these tables has since landed (`src/routes/approvals.ts`,
   `src/services/ApprovalTemplateGroupService.ts`) — see each function's own doc comment and the
   `approval-template-groups-backfill-{preview,execute,rollback}-ci-wiring.test.mjs` guards; this
   migration remains Draft-only (unapplied to any shared/staging/prod database) regardless.
   ```
   （末句刻意保留「仍是 Draft-only、未应用到任何共享库」——这半句在本 head 上仍是真的,不属过期断言,不能一并删掉。）
2. `packages/core-backend/vitest.config.ts:1839`(原:「Schema-only — no W7/W8/W9 route/service code exists yet」)→现:「Schema-only (exercises the DDL, not the W7/W8/W9 route/service layer, which has since landed — see the sibling `backfill-{preview,execute,rollback}.db.test.ts` suites)」。
3. `packages/core-backend/src/services/ApprovalTemplateGroupService.ts:49-52`(原:「A-3's preview/execute/rollback endpoints, batch tables, and CI wiring remain OUT of scope pending independent gate review of that design proposal」)→现(`:50-54`):
   ```
   A-3's preview/execute/rollback endpoints, batch tables, and CI wiring have since
   landed (`routes/approvals.ts`, the backfill batch DDL migration, this file's own
   `classifyBackfillCategory` / `rollbackApprovalTemplateGroupBackfillBatch`) and passed an
   independent gate review round (`reviews/impl-gate-A3-round1-20260918.md`, 0 P1 / 1 P2 / 7 P3 —
   disposition tracked in the paired verification MD's §7):
   ```
   顺手订正了这一句自己的交叉引用:P3 处置从本轮起落在 §8,不再只在 §7,已改写成「§7/§8」（下方 diff）。

证据——三处旧字符串在本 head 上零命中,新字符串各一处:
```
$ grep -rn "nothing reads or writes these tables until the W7" packages/core-backend/src
$ grep -rn "no W7/W8/W9 route/service code exists yet" packages/core-backend
$ grep -rn "remain OUT of scope pending independent gate review" packages/core-backend/src
```
三条命令均零命中(本会话现场跑,`$?`=1 各三次)。

### 8.2 P3-2 —— 12 处指向改名前文档路径的注释

设计 MD 在更早的一轮已从 `approval-template-groups-phase2-design-20260918.md` 改名为 `approval-template-groups-phase2-backfill-design-20260918.md`,但 12 处 `.ts` doc-comment 引用当时未同步。本轮逐处改写,分布(与 diff 逐一核对):迁移文件 1 处、`routes/approvals.ts` 2 处、`ApprovalTemplateGroupService.ts` 4 处、四个 `*.db.test.ts` 各 1 处(共 4 处)、`vitest.config.ts` 1 处 —— 合计 12。

```
$ git diff -- '*.ts' | grep -c '^-.*phase2-design-20260918'
12
$ git diff -- '*.ts' | grep -c '^+.*phase2-backfill-design-20260918'
12
```

全仓复核(不只 `packages/core-backend`,含所有 `.ts`/`.md`/`.mjs`/`.cjs`):

```
$ grep -rn "phase2-design-20260918" . --include='*.ts' --include='*.md' --include='*.mjs' --include='*.cjs' 2>/dev/null \
    | grep -v "phase2-backfill-design-20260918" | grep -v "phase2-backfill-verification-20260918.md:367"
(零命中)
```
唯一被过滤掉的一行是本文档 §5 项 4 自己那句「门审报告引用的旧文件名……在本仓当前树里已不存在(rename 到本文档配对的设计 MD 路径)」——这是在如实记录改名这件事本身发生过,不是一处还没订正的过期断言,而且门审报告 `impl-gate-A3-round1-20260918.md` 本身不属本 git 仓、我方无权限也不应该去改它引用的旧文件名。

### 8.3 P3-3 —— `atgbb_org_nonblank` 补进 `NONBLANK_CHECK_CONSTRAINTS` + 新增判别力测试

**代码**(`packages/core-backend/src/services/ApprovalTemplateGroupService.ts`):
```
-const NONBLANK_CHECK_CONSTRAINTS = new Set(['atg_name_nonblank', 'atg_org_nonblank', 'atgl_org_nonblank'])
+const NONBLANK_CHECK_CONSTRAINTS = new Set([
+  'atg_name_nonblank',
+  'atg_org_nonblank',
+  'atgl_org_nonblank',
+  'atgbb_org_nonblank',
+])
```
函数上方的 doc-comment 同批追加一段,把「为什么加」「为什么今天仍不可达」「为什么复用 `GROUP_NAME_UNSUPPORTED` 这个不精确的码名」三件事各写一句,并明确这个不精确不是本改动新引入的(两个既有 `*_org_nonblank` 条目同样复用它)。

**门审原文的一处可拆分,已在 §7.4 第 3 条写明**:门审说「需要服务层测试才能安全改,今天不可达」——不可达(端到端)是真的,但 `mapGroupConstraintError` 本身是一个不碰真库/不碰路由的纯函数(输入一个 `{code, constraint}` 形状的对象,输出映射后的 `ServiceError` 或原样透传),可以直接单元测试,不需要等到有服务层/真库测试才能验证这条映射的判别力。

**新文件**:`packages/core-backend/tests/unit/approval-template-group-backfill-batch-org-nonblank.test.ts`,3 例:
1. 正例:`{code:'23514', constraint:'atgbb_org_nonblank'}` → `ServiceError`,`statusCode=400`,`code='GROUP_NAME_UNSUPPORTED'`,`details={constraint:'atgbb_org_nonblank'}`。
2. 负控:一个不在集合里的 23514 约束名 → 原样透传(`mapped === pgErr`,`not.toBeInstanceOf(ServiceError)`)——证明这个映射器不是「见 23514 就吞」的兜底,新增条目确实是靠名字命中的。
3. 回归控:既有的 `atg_org_nonblank` 仍然被映射——证明这次改动是扩表,不是替换表。

```
$ npx vitest run tests/unit/approval-template-group-backfill-batch-org-nonblank.test.ts --reporter=dot
 ✓ tests/unit/approval-template-group-backfill-batch-org-nonblank.test.ts (3 tests) 2ms
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

### 8.4 三条同批回归(本会话现场重跑,私有库 `metasheet2_lock_a3`)

本轮三条改动(注释文字、一个 `Set` 字面量追加一个元素、一个新的纯单元测试文件)都不触碰 preview/execute/rollback 的请求处理逻辑,以下回归是为了把这句话从断言变成实测:

1. **迁移干净**:
   ```
   $ DATABASE_URL="postgres://localhost/metasheet2_lock_a3" npm run migrate
   ```
   exit 0,无 pending。
2. **7 个 ATG 真库套件**(与门审 E1 同一批文件):
   ```
   $ DATABASE_URL="postgres://localhost/metasheet2_lock_a3" EXPECT_DB=1 \
     npx vitest --config vitest.integration.config.ts run \
       tests/integration/approval-template-groups-lifecycle.db.test.ts \
       tests/integration/approval-template-groups-backfill-schema.db.test.ts \
       tests/integration/approval-template-groups-backfill-preview.db.test.ts \
       tests/integration/approval-template-groups-backfill-execute.db.test.ts \
       tests/integration/approval-template-groups-backfill-rollback.db.test.ts \
       tests/integration/approval-template-groups-backfill-batches-list.db.test.ts \
       tests/integration/approval-template-groups-serialization.db.test.ts \
       --reporter=dot
    Test Files  7 passed (7)
         Tests  85 passed (85)
   ```
   `85 passed (85)`,与门审 E1 记录的数字逐字相同。
3. **新单元测试**:见 §8.3,`3 passed (3)`。
4. **5 个 ci-wiring 守卫**(`node --test scripts/ops/approval-template-groups-backfill-{schema,preview,execute,rollback,batches-list}-ci-wiring.test.mjs`):各 `fail 0`,exit 0。
5. **s6a provenance**:`node --test plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs` → `pass 1 / fail 0`。`.github/workflows/plugin-tests.yml` 本轮未改动(`git status --short` 对该文件为空),`shasum -a 256` 现场值 `099904601c47c078fa5c81bf4387a26cc0678174de5a24f54b5edc86ae5bece1` 与 pins.json 逐字相同,**不需要重算 s6a 钉**(硬规矩里的「改 plugin-tests.yml 必须重算」这一条件不成立)。
6. **typecheck**:`npx tsc --noEmit`,exit 0,零输出。
7. **无库全量 lane**(`CI=true pnpm --filter @metasheet/core-backend test --reporter=dot`):
   ```
   Test Files  932 passed | 175 skipped (1107)
        Tests  14722 passed | 1604 skipped (16326)
   Duration    65.38s
   ```
   exit 0,零失败。**与门审 E2 记录的 `931 passed | 175 skipped (1106)` / `14718 passed | 1604 skipped (16322)` 相比**:文件数 +1(与本轮新增的唯一一个测试文件逐一对应),测试数 +4——比新文件自己的 3 个用例多 1 条。**追查结果(不留作未核实差异)**:
   ```
   $ grep -aE "approval-ci-coverage-enumeration|approval-field-access-enum-mirror|multitable-o2-census-closed-world|approval-lock8-field-type-census|recovery-conflict-census|ai-provider-call-site-census" /tmp/e2-fixround2-full.log
    ✓ tests/unit/approval-ci-coverage-enumeration.test.ts (350 tests)
    ✓ tests/unit/approval-field-access-enum-mirror.test.ts (50 tests)
    ✓ tests/unit/multitable-o2-census-closed-world.test.ts (7 tests)
    ✓ tests/unit/approval-lock8-field-type-census.test.ts (36 tests)
    ✓ tests/unit/recovery-conflict-census.test.ts (40 tests)
    ✓ tests/unit/ai-provider-call-site-census.test.ts (4 tests)
   ```
   门审 E4 记录 `approval-ci-coverage-enumeration.test.ts` 是 `349 passed`;本次 `350`——**逐一对上那 +1**,其余五个普查/镜像守卫的用例数(50/7/36/40/4)与门审记录一致,零漂移。读该文件自己的 doc-comment(`tests/unit/approval-ci-coverage-enumeration.test.ts:1-27`)证实这不是巧合:它对 `packages/core-backend/tests/**` 做活的 `fs.readdirSync` 枚举,每发现一个 approval 相关的测试文件就生成一条 `it(...)`,断言该文件"要么被某个具名、不可跳过的 CI lane 收集,要么在 allowlist 里"——本轮新增的 `tests/unit/approval-template-group-backfill-batch-org-nonblank.test.ts` 落在 `packages/core-backend/tests/unit/`,被 Vitest **默认 include glob**(`vitest.config.ts` 未覆盖)收集,该 doc-comment 原文写明"a brand-new file in `tests/unit/` needs NO workflow edit to be collected — that is what makes this home un-skippable"——枚举守卫发现了新文件、判定它已被无条件收集、生成并跑绿了对应的一条 `it`,是 **350 = 349 + 1** 这条判别力证据自己在起作用,不是巧合也不需要另外登记(记忆 `feedback_generation_guard_must_be_applied_to_every_sibling_surface` 的反向确认:本轮不需要手工"补登记",因为 `tests/unit/` 这一层本身就是该守卫的默认收集面)。skip 数(175 文件 / 1604 用例)两次完全相同,与"枚举到了 1 个新文件、生成了 1 条新绿用例"这个解释一致,排除"某条原本 skip 的用例变绿"的另一种可能。
8. **retraction sweep**(gate §8 复核清单第 2 条建议、本轮改了 `routes/approvals.ts` 的注释故顺手跑一遍):`bash scripts/dev/atg-retraction-sweep.sh`,exit 0,两处命中均落在该脚本自己定义的"类别 3——叙述一件已经被撤回的事实,不是把它当今天成立的事实来断言"(命中原文都在讲"通配腿已被 phase1 证伪",不是在断言通配腿今天成立),脚本自己的判据要求类别 2(仍在断言为今天事实)命中数必须为 0——本次为 0。

**结论**:P3-1/P3-2/P3-3 三条均已修复并有判别力证据;既有 85 条真库用例、5 个 wiring 守卫、s6a 钉、typecheck、14700+ 条无库用例(含 350 条枚举守卫用例,+1 逐一对应本轮新文件,零未解释漂移)、retraction sweep 全部保持绿,零失败。

## 9. rebase 到 A-1 a728ed655(2026-09-18)

A-1(`origin/feat/approval-template-groups-phase1`)在 §8 处置完成之后又推进到 `a728ed65532918e3726171d0c42f44d6be7e0ba9`(23514→400 映射、注释改写、新用例、`scripts/dev/atg-retraction-sweep.sh` 与 `atg-verification-recount.sh`,DDL 零改动)。本节记录本 lane 第三次 rebase 的 git 力学 + 全量真库/required 复现,不重复 §1–8 已经定案的判据文字。

### 9.1 rebase 前后

- **rebase 前 HEAD**:`6495bfe70fb0102a44936eb5b15f9ca74aad7710`(§8 定稿时的 head)。
- **rebase 前 worktree**:`git status --porcelain` 为空,与 `origin/feat/approval-template-groups-phase2-backfill` 一致。
- **rebase 前基点形状**(`git diff --stat 03ee9f4bb..HEAD`):26 个文件,`6411 insertions(+), 186 deletions(-)`。
- **新 phase1 tip**:`a728ed65532918e3726171d0c42f44d6be7e0ba9`(`git fetch origin feat/approval-template-groups-phase1` 现取)。
- **操作**:`git rebase origin/feat/approval-template-groups-phase1`,回放本 lane 全部 35 个提交。**零冲突**(`Successfully rebased and updated refs/heads/feat/approval-template-groups-phase2-backfill.`,`Rebasing (1/35)` … `(35/35)`)。
- **rebase 后 HEAD**:`64b1261da20fc3f9632eac6a567d882f38377723`。
- **冲突标记扫描**:`grep -rn '<<<<<<<\|>>>>>>>' packages apps .github` 命中 12 处,全部落在 `packages/claudedocs/BATCH2_MERGE_SUMMARY.md`(一份记录历史合并的文档,文件内容本身逐字包含 `<<<<<<<`/`>>>>>>>` 字面文本)。`git diff origin/feat/approval-template-groups-phase1 HEAD -- packages/claudedocs/BATCH2_MERGE_SUMMARY.md` 输出为空——该文件在两侧字节相同,本 lane 与本次 rebase 均未触碰,不是未消解冲突。判据要求的"零处真实冲突标记"成立。
- **祖先关系**:`git merge-base --is-ancestor origin/feat/approval-template-groups-phase1 HEAD` → `YES`;`git rev-list --count origin/feat/approval-template-groups-phase1 ^HEAD` → `0`。
- **rebase 后 diff 形状**(`git diff --stat origin/feat/approval-template-groups-phase1..HEAD`):21 个文件,`5784 insertions(+), 81 deletions(-)`(§1 的 5 个 backfill ci-wiring `.test.mjs` 与 lifecycle/serialization 两个真库测试文件均在列,归属 phase1 侧新增/改动的文件不再出现在这个 diff 里,符合预期)。

### 9.2 range-diff(证明本 lane 自己的 diff 未变,只是 rebase 换了父提交)

```
$ git range-diff 03ee9f4bb..6495bfe70fb0102a44936eb5b15f9ca74aad7710 a728ed65532918e3726171d0c42f44d6be7e0ba9..HEAD
```
输出 44 行比较项:前 9 行(`f7b929700`…`a789422b5`)在新区间侧标 `-: ---------`——这 9 个提交是 A-1 自己的历史(phase1 在 `03ee9f4bb` 之后、`a789422b5` 之前落的提交),本来就已经整体包含在 `origin/feat/approval-template-groups-phase1` 的当前谱系里,不是本 lane 的内容,rebase 后自然不再出现在"本 lane 对 phase1 tip 的差集"里,不算内容丢失。后 35 行(`f5b57b9b1`…`6495bfe70` 对 `323d10bec`…`64b1261da`)**逐一标记为 `=`**——git 判定两侧提交内容(diff)完全相同,只有提交 SHA 因为父提交换了而不同。**本 lane 自己的 35 个提交,rebase 前后 diff 内容零差异**,没有"顺手改了冲突解法之外的东西"。

### 9.3 私有库 `metasheet2_lock_a3_rb` 全量真库复现

```
$ dropdb -U postgres -h localhost metasheet2_lock_a3_rb 2>/dev/null; createdb -U postgres -h localhost metasheet2_lock_a3_rb
$ DATABASE_URL=postgresql://postgres@localhost:5432/metasheet2_lock_a3_rb \
  MIGRATION_EXCLUDE=008_plugin_infrastructure.sql,048_create_event_bus_tables.sql,049_create_bpmn_workflow_tables.sql,042a_core_model_views.sql,20250924140000_create_gantt_tables.ts,20250925_create_view_tables.sql \
  pnpm --filter @metasheet/core-backend db:migrate
```
全部迁移成功执行,含本 lane 自己的 `zzzz20260919090000_create_approval_template_group_backfill_batches`。事后 `db:list`:`Applied: 402` / `Pending: 6`(pending 的 6 个恰好是 `MIGRATION_EXCLUDE` 列出的 6 个,与 CI 同款排除集合逐一对应)。

```
$ DATABASE_URL=postgresql://postgres@localhost:5432/metasheet2_lock_a3_rb \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-lifecycle.db.test.ts \
    tests/integration/approval-template-groups-serialization.db.test.ts \
    tests/integration/approval-template-groups-backfill-schema.db.test.ts \
    tests/integration/approval-template-groups-backfill-preview.db.test.ts \
    tests/integration/approval-template-groups-backfill-execute.db.test.ts \
    tests/integration/approval-template-groups-backfill-rollback.db.test.ts \
    tests/integration/approval-template-groups-backfill-batches-list.db.test.ts \
    --reporter=dot
 Test Files  7 passed (7)
      Tests  79 passed | 7 skipped (86)
```
（lifecycle/serialization 为 A-1 侧改动过的两个文件,backfill-5 为本 lane 自有文件,与门审 E1 同一批文件清单。）

```
$ npx tsc --noEmit
```
exit 0,零输出。

### 9.4 三条 required 逐字复现

1. **仓根 `pnpm type-check`**:
   ```
   $ pnpm type-check
   Scope: 13 of 14 workspace projects
   packages/core-backend type-check$ tsc --noEmit && tsc -p scripts/tsconfig.recovery-archive-acceptance.json
   packages/core-backend type-check: Done
   apps/web type-check$ vue-tsc -b && pnpm run type-check:verification-approval && pnpm run type-check:verification-stock-prep
   apps/web type-check: Done
   ```
   13/13 workspace 项目 `Done`,零 TS 错误。

2. **`CI=true pnpm --filter @metasheet/core-backend test`(全量,无库+真库混合套件)**:
   ```
   Test Files  932 passed | 175 skipped (1107)
        Tests  14722 passed | 1604 skipped (16326)
     Duration  133.85s
   ```
   exit 0,零失败。

3. **`bash -e apps/web/scripts/run-required-web-tests.sh`**(本 lane 不碰 `apps/web`,仍全量跑一遍以证明未破坏):脚本内含约 30 次独立 `npx vitest run` 调用(`set -euo pipefail`,任一调用非零退出即整脚本失败),全程无一次非零退出,跑到脚本最后一个调用并打出干净的收尾统计:
   ```
   Test Files  465 passed (465)
        Tests  7164 passed (7164)
     Duration  77.83s
   ```
   对全量日志(`/tmp/web-required-tests.log`,14435 行)做过三项交叉检查:`grep -n "FAIL\b"` 零命中;`grep -c "failed"` 命中 12 处,逐一核对后全部是测试用例描述文字(例如"a failed ensure says so…"、"surfaces failed branch status…")或被测代码里模拟网络失败的 `console.error`,不是任何一条 `Test Files … failed` 汇总行;逐个 `Test Files` 汇总行本身也无一处出现 `failed` 计数。三者共同确认零真实失败。

### 9.5 结论

rebase 零冲突、range-diff 证明本 lane 35 个提交内容逐一不变、私有库 `metasheet2_lock_a3_rb` 上本 lane 7 个真库文件与 tsc 均绿、三条 required 逐字复现全绿(仓根 type-check 13/13、core-backend 全量 932 文件/14722 用例、apps/web required 网关 465 文件/7164 用例,零失败)。rebase 后 HEAD:`64b1261da20fc3f9632eac6a567d882f38377723`。

## 10. 修复轮 3 处置(`impl-gate-A3-round2-20260918.md` §7 点名"开 PR 前必修"的记录级项,2026-09-18)

**范围声明**:本轮只改 MD 散文与代码注释,**零代码行为改动**(不改任何可执行语句、SQL、正则、类型)。处置该门审报告 §7 的四条(编号按该报告原文):第 1 条(P3-1,最高优先级)、第 2 条(P3-2)、第 4 条(P3-4)、第 5 条(P3-5)。第 3 条(P3-3,验收 E 终态腿)与第 6 条(新发现,`atgbb_org_nonblank` 声明未测)本轮不处理,如实留在 §5 项 1 / §7(round1 disposition)。

### 10.1 P3-1(最高优先级)——lane 自有 MD 的"guard ⊋ manager"过强断言,改写为"互不包含,两方向各一条反例"

**背景**:门审报告 §3 发现,A-1 phase1 第 6/7 轮门审(commit `3e53c52fe`)在本 lane 上一次 rebase(第二次,到 `a789422b5`)之后,进一步证伪了"guard ⊋ manager(严格超集)"这个结论本身——两个人口是**互不包含**,新增的反方向反例是:持 `approval-templates:manage` 权限码但未过 namespace admission 合取项的主体,被 `isTemplateManager` 精确 `.includes()` 判成 manager,却被 `rbacGuardAny` 拒绝(403,即 A-1 §23.6 记录的 `ZZR4-EXACT-RESULT status=403`)。门审逐 hunk 核对后确认:**代码侧零命中**(A-1 自己的 `routes/approvals.ts` 注释已经历"CORRECTED A THIRD TIME"改写,与本 lane 无关),唯一的活缺陷是本 lane 自有 MD 里四句仍以"guard ⊋ manager"或等价措辞断言严格超集,外加一处"已解决"状态断言已过期。

**改动清单(均为逐句改写,不改代码)**:
1. 设计 MD §13.1 表第 16 行(原第 535 行区域):把"guard⊋manager 的事实(前半道理已求值)"改写为"guard 人口与 manager 人口互不包含的事实(两方向各有一个实测反例……)"。
2. 设计 MD §13.5 项 2(原第 578 行区域):把"是过强声明(guard 人口 ⊋ manager 人口)"改写为"是过强声明——两个人口互不包含,不是……严格超集关系(……)"。
3. 设计 MD §13.6 Draft PR body 必写清单的 changesRequired #16 一行(原第 586 行区域,**这是最高优先级项,原文会被逐字抄进 world-readable 的 PR 正文**):整句改写为"guard 人口与 manager 人口**互不包含**……两个方向各有一个端到端实测反例:①……②……PR body 必须逐字写「互不包含,两方向各一条反例」,不得抄 changesRequired #16 原文的 ⊋ 措辞而不加订正标注"。
4. 设计 MD §5.2 响应形状 jsonc 注释(原第 368 行区域,门审未点名但本轮机械复核 `通配权限码` 模式命中后发现的同族活缺陷):原文"通配权限码展开 / isAdmin(userId) 两类主体都能过 guard 但可能不是 manager"仍在断言"通配权限码单独过 guard"这条**已被证伪**的腿为真,改写为"唯一端到端实测成立的『过 guard 但非 manager』反例是 DB 侧 isAdmin(userId)一条腿——通配权限码单独过 guard 已被 phase1 第 2/4 轮各真库证伪,不是第二条成立的腿"。
5. 验证 MD §7.2(原第 413 行区域):对已过期的"guard ⊋ manager 结论不变"这句历史记录,按记忆 `feedback_supersession_marker_must_evaluate_not_void` 的要求**贴到那句话上求值**(不删除历史记录本身,只在其后补一段"求值(2026-09-18,第三次 rebase 后)……结论句已经过期,不得再引用……作为今天成立的事实")。
6. 验证 MD §5 项 7(原第 373 行区域):把"这一半已在修复轮 1 解决"这句现已过期的状态断言改写为如实记录多轮证伪链(第 4/5 轮→第 6/7 轮→本 lane 第三次 rebase 各自带入什么),不再用"已解决后维持不变"这个隐含"从此没再变过"的措辞。

**PR body 必写清单本身**:设计 MD §13.6 的 changesRequired #16 一行已经改写(见上第 3 点),避免这条被证伪的措辞原样抄进未来的 Draft PR 正文。

**机械验证(sweep 输出)**:重跑 A-1 带来的 22 模式版 `scripts/dev/atg-retraction-sweep.sh`(相对 `origin/feat/approval-template-groups-phase1`,即本 lane 自己的 21 个文件差集):

```
$ bash scripts/dev/atg-retraction-sweep.sh origin/feat/approval-template-groups-phase1
```
22 个模式里 **11 个有命中**(`⊆`/`⊋`/`guard population`/`guard *人口`/`sees everything`/`wildcard permission`/`通配权限码`/`超集`/`严格超集`/`subset`/`superset`),其余 11 个零命中;有命中的 11 个模式合计 **48 条命中行**(跨 21 个文件、去重后落在 4 个文件:`routes/approvals.ts`、`ApprovalTemplateGroupService.ts`【本次 0 命中,STORABLE_GROUP_NAME_PATTERN 一带的新注释未撞中任何一个 22 模式】、设计 MD、验证 MD,以及 `plugin-tests.yml`/`vitest.config.ts` 里与本主题完全无关的 `subset`/`⊆` 假阳性)。逐条读过完整句子后分类:
- **类别 2(活命中,以「成立」口吻断言任一方向包含关系)= 0 条**。本轮改写的 5 处(design MD 三处+verification MD 两处)全部不再以现在时断言 ⊋/⊆/严格超集;唯一含 ⊋/严格超集/超集/`guard 人口`/`通配权限码` 字样的命中,句子本身要么在**叙述**"这曾经被断言又被证伪"(类别 3,如验证 MD §7.2/§7 项 7 的改写句、design MD §13.1/§13.5/§13.6 改写句本身——它们提到"⊋"是为了说"这不成立",不是在断言它成立),要么是**不同主题**的假阳性(类别 4,如 `export⊆read`、`list⊋detail`、`multitable-permmatrix-b4-g7-export-subset-read`,与 `approvalTemplateAdminGuard`/`isTemplateManager` 完全无关)。
- `routes/approvals.ts` 的命中(4 处,均在 A-1 自己的注释块内,本 lane 未碰这些行)本身已经历"CORRECTED A THIRD TIME"的自我改写,现读结论是"the two populations are mutually non-inclusive — neither contains the other",与本 lane 的改写口径一致;不属于本 lane 需要处理的对象,如实记录不动。

**要求达成**:零处以「成立」口吻断言任一方向包含关系(类别 2 = 0),符合任务书判据。

### 10.2 P3-2——验证 MD §5 项 8 与 §2.4 自相矛盾

原文"本切片新增的五个文件继承同样的闭世界残留形态"与 §2.4 记录的事实(五个新 backfill 文件各自有专属 `*-ci-wiring.test.mjs`,5×3=15 条断言全绿,M6 已证承重)直接矛盾。改写为:残留仅限 A-1 的两个既有文件(`lifecycle`/`serialization`),明确排除"本切片新文件继承"这句错误推论。设计 MD §13.6 PR body 必写清单里的同一句(P3-2 一行)同批改写,避免抄进 PR body。

### 10.3 P3-4——`btrim(...) ~ '[!-~]'` SQL/JS 等价的 collation 限定语,写进注释

按验证 MD §7.4 项 6 早先已选定的更便宜方案(不新增只能在错误 collation 轴上通过的测试,而是把限定语写全),在三处代码注释追加 collation caveat,互相用一句话指回同一个主锚点,不重复整段:
- **主锚点**:`packages/core-backend/src/services/ApprovalTemplateGroupService.ts`,`STORABLE_GROUP_NAME_PATTERN` 的 doc-comment——新增一段说明该 JS/SQL 等价只在 glibc/`en_US.utf8` collation 上测过,production 的 `15-alpine`(musl、无 `en_US.utf8`)轴未验(记忆 `finding_prod_pg15_never_tested`)。
- `packages/core-backend/src/routes/approvals.ts`,execute 的 `eligible` 查询 `btrim(t.category) ~ '[!-~]'` 谓词旁,加一句指回主锚点。
- `packages/core-backend/tests/integration/approval-template-groups-backfill-execute.db.test.ts`,SQL/JS 交叉验证用例(`SQL/JS cross-verification: …`)上方,加一句说明该测试只在 glibc/`en_US.utf8` 上跑过,绿不代表 musl 轴已覆盖。

### 10.4 P3-5——补充清单 #1 的前提在本 head 为假,改写成独立勘误句

原文把"清单 #1 描述的陷阱(硬编码 `FILES` 数组)对本切片不适用"与"文件计数 45 vs 43 的分歧"混写成一句"如实记录不一致,不强行对齐"——按门审要求拆成两句独立结论:第一句明确断言"该数组不存在,清单 #1 的陷阱不适用"(不是留待判断的分歧),第二句单独记录文件计数分歧(45 vs 43),两者不互相稀释。改动位置:验证 MD §4 补充清单表第 1 行 + §7.4 项 7。

### 10.5 回归验证(证明零行为改动)

```
$ npx tsc --noEmit
```
exit 0,零输出(commit 3/4 各自单独验证过一次)。

```
$ DATABASE_URL=postgresql://postgres@localhost:5432/metasheet2_lock_a3_rb \
  pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-lifecycle.db.test.ts \
    tests/integration/approval-template-groups-serialization.db.test.ts \
    tests/integration/approval-template-groups-backfill-schema.db.test.ts \
    tests/integration/approval-template-groups-backfill-preview.db.test.ts \
    tests/integration/approval-template-groups-backfill-execute.db.test.ts \
    tests/integration/approval-template-groups-backfill-rollback.db.test.ts \
    tests/integration/approval-template-groups-backfill-batches-list.db.test.ts \
    --reporter=dot
 Test Files  7 passed (7)
      Tests  79 passed | 7 skipped (86)
```
与 §9.3 rebase 后首次重跑的计数逐字相同(79/7/86)——本轮四个提交(comment/MD-only)未改变任何一条断言的红绿结果。

```
$ git diff --stat a4bf9f742..HEAD
 docs/development/approval-template-groups-phase2-backfill-design-20260918.md               | 14 ++--
 docs/development/approval-template-groups-phase2-backfill-verification-20260918.md         | 92 ++++++++++++++++++++--
 packages/core-backend/src/routes/approvals.ts                                              |  4 +
 packages/core-backend/src/services/ApprovalTemplateGroupService.ts                         | 13 +++
 packages/core-backend/tests/integration/approval-template-groups-backfill-execute.db.test.ts | 6 ++
 5 files changed, 116 insertions(+), 13 deletions(-)
```
（`a4bf9f742` = §9 rebase-note 提交,是本轮四个修复提交的起点。)只 5 个文件,四个提交(35a5e2ddd/a0ff59eeb/bf1d75d14/本提交)各自负责其中一部分;`git diff` 逐行核对:两份 MD 全是散文改写,三个源码文件的改动全在 `//` 或 `/** */` 注释块内,零一行可执行代码/SQL/正则/类型改动。

## 11. CI 修复:required check `test (20.x)` 的「approval real-DB integration」步骤红(2026-09-18)

**触发**:PR #5866(`feat/approval-template-groups-phase2-backfill`,head `f581004ae`)的 required check `test (20.x)` 在其「Run approval real-DB integration」步骤上红,单一失败:

```
FAIL tests/integration/approval-template-groups-backfill-preview.db.test.ts > … >
  skipped: blank-after-trim (null category and a whitespace-only category) land in one
  CATEGORY_BLANK_AFTER_TRIM bucket … — AssertionError: expected [ …(13) ] to deeply equal [ Array(1) ]
  at :229 `expect(nullBucket!.templateIds).toEqual([nullCat])`
```

即该 org 的 `''`(blank-after-trim)桶收到 13 个模板 id,其中 12 个不是本用例 seed 的。

### 11.0 任务书诊断的勘误——不是「org 碰撞」,是「模板表全局共享 + 候选谓词只按 org 过滤 link」

派工任务书把这条失败归因为「本测试用的 org id 与其他套件共用」,并把修法定为「A-3 五个真库文件的夹具一律用本文件唯一的 org id」。逐行读产线代码后,这个归因是**假的**,对应的修法也**修不好**这条失败,理由是三条独立证据:

1. `approval_templates` 的 DDL(`packages/core-backend/src/db/migrations/zzzz20260411120100_approval_templates_and_instance_extensions.ts:16-25`)**没有 `org_id` 列**——模板本来就是跨 org 全局共享的一张表,只有「哪个 org 把它挂进了哪个组」这件事(`approval_template_group_links`)才是 org 级的。
2. `previewApprovalTemplateGroupBackfill` 的候选查询(`packages/core-backend/src/routes/approvals.ts:519-528`)WHERE 子句只有两段:`NOT EXISTS(... l.org_id = $1 ...)`(这个 org 从未关联过)+ `applyTemplateVisibilityFilter`。而 `applyTemplateVisibilityFilter`(`packages/core-backend/src/services/ApprovalProductService.ts:4383-4389`)在 `actor.isTemplateManager === true` 时**直接 `return index`,不追加任何条件**——本切片三个真库文件的 `managerActor` 全部是 `isTemplateManager: true`。折叠下来,候选谓词就是唯一一条:「这个模板从未被『这个 org』关联过」。
3. `approval-template-groups-backfill-batches-list.db.test.ts` 自己的既有注释(本切片改动前就写在那里,`afterEach` 上方)原话就是:「`approval_templates` carries no org column, so a template left linked-nowhere by one case stays an eligible candidate for a later case」——五个文件的作者早就知道这件事,只是三个文件(preview/execute/rollback)在写 CI 前没有把它推广到「84 文件共享一个库」这个尺度。

结论:一个「从未被本文件的 org 关联过」的全局模板行,是**任何** org 字符串的候选——把 org 换成 per-file 唯一值不改变这件事分毫。这不是 bug,是产线设计本身(模板池跨 org 共享,分组是 org 级的挂接);任务书要求的「零生产代码改动」在这个前提下是对的——要修的是测试夹具怎么在这个真实产线行为下让自己的候选人口保持干净,不是去改产线谓词。因此步骤②按**任务书原定方案作废**,改用下面 §11.2 的机制。

### 11.1 复现:私有库 `metasheet2_lock_a3_ci`

```
$ dropdb -U postgres metasheet2_lock_a3_ci 2>&1   # (does not exist yet)
$ createdb -U postgres metasheet2_lock_a3_ci
$ DATABASE_URL=postgresql://postgres@localhost:5432/metasheet2_lock_a3_ci \
    pnpm --filter @metasheet/core-backend db:migrate
```
0 pending(第二次原样重跑 `db:migrate` 无任何新迁移输出)。

污染集——模拟「其他文件在同一次 CI 运行里留下的、从未被任何 org 关联过的模板行」,**两种形状都要**(只放 NULL/blank 只会让 preview 的 blank-after-trim 桶变红,execute/rollback 完全绿,判别力覆盖不到本切片改的另外两个文件):

```sql
INSERT INTO approval_templates (key, name, status, category, visibility_scope) VALUES
  ('a3-ci-repro-foreign-null-1',  'a3-ci-repro-foreign-null-1',  'draft', NULL,  '{"type":"all","ids":[]}'::jsonb),
  ('a3-ci-repro-foreign-blank-1', 'a3-ci-repro-foreign-blank-1', 'draft', '   ', '{"type":"all","ids":[]}'::jsonb),
  ('a3-ci-repro-foreign-aaa-1',   'a3-ci-repro-foreign-aaa-1',   'draft', 'AAA', '{"type":"all","ids":[]}'::jsonb);
```

**用 HEAD(修复前)的三个文件对这个污染库跑一遍**(`cp` 备份修复后的文件 → `git show HEAD:<path>` 写回旧内容 → 跑 → `cp` 还原 → `cmp` 确认字节级复原,全程未用 `git checkout --`/`stash`):

```
$ DATABASE_URL=postgresql://postgres@localhost:5432/metasheet2_lock_a3_ci \
    pnpm exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-backfill-preview.db.test.ts --reporter=dot
 ❯ … skipped: blank-after-trim … — AssertionError: expected [ …(2) ] to deeply equal [ Array(1) ]
     229| expect(nullBucket!.templateIds).toEqual([nullCat])
 ❯ … candidateCount … — AssertionError: expected 4 to be 3
 ❯ … buckets/skipped are ordered by plain code-point order … —
     expected [ '100', 'AAA', 'Zebra', 'apple' ] to deeply equal [ '100', 'Zebra', 'apple' ]
 ❯ … route wiring … an admin actor gets 200 … — expected 2 to be 1
 Test Files  1 failed (1)
      Tests  5 failed | 8 passed | 1 skipped (14)
```
第一条与生产 CI 日志的失败逐字一致(同一断言、同一行号 `:229`)——复现成立。另外三条是 `AAA` 污染物(而非 NULL/blank)单独触发的,证明污染集需要两种形状才对本切片的判别力做到位。

```
$ DATABASE_URL=postgresql://postgres@localhost:5432/metasheet2_lock_a3_ci \
    pnpm exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-backfill-execute.db.test.ts \
    tests/integration/approval-template-groups-backfill-rollback.db.test.ts --reporter=dot
 Test Files  2 failed (2)
      Tests  7 failed | 14 passed | 2 skipped (23)
```
`AAA`(一个可存储、排序在 `'HR'` 之前的 category)让 execute 的 `groups`/`links` 增量计数、`result.groups[0]` 下标假设、rollback 的 delta 计数全部现出原形——`execute`/`rollback` 两个文件此前**从未**被这个反例覆盖过(生产 CI 之所以只报 preview 一条红,是因为当时的污染集恰好只有 NULL category,没有 AAA 这种「可存储且排序靠前」的形状;这不代表 execute/rollback 没有同一类暴露面)。

修复文件(preview/execute/rollback 三个)已在还原后重新用 `cmp` 确认与本次会话开始时的工作树状态字节相同,详见 §11.2 之后的复跑记录。

### 11.2 修法(测试侧,零生产代码改动):`sinkForeignTemplates`

三个真库文件(preview/execute/rollback)各自新增一个**同名同构、独立复制**(不建共享 import,遵循本切片既有的 `tok`/`httpReq` 复制惯例)的 helper:

```ts
const FOREIGN_SINK_GROUP_NAME = '__a3_ci_foreign_template_sink__'
const FOREIGN_SINK_SORT_ORDER = 999999

async function sinkForeignTemplates(org: string, ownTemplateIds: readonly string[]): Promise<string> {
  const sinkGroupId = `atg_sink_${org}`
  await query(
    `INSERT INTO approval_template_groups (id, org_id, name, sort_order, created_by)
     VALUES ($1, $2, $3, $4, 'sink')`,
    [sinkGroupId, org, FOREIGN_SINK_GROUP_NAME, FOREIGN_SINK_SORT_ORDER],
  )
  await query(
    `INSERT INTO approval_template_group_links (org_id, template_id, group_id, linked_by, linked_at)
     SELECT $1, t.id, $2, 'sink', now()
       FROM approval_templates t
      WHERE NOT EXISTS (SELECT 1 FROM approval_template_group_links l WHERE l.org_id = $1 AND l.template_id = t.id)
        AND NOT (t.id = ANY($3::uuid[]))`,
    [org, sinkGroupId, ownTemplateIds],
  )
  return sinkGroupId
}
```

机制:对**产线用的同一条谓词**(`NOT EXISTS` 链接排除)反过来用一次——在本用例真正调用 `preview`/`execute` 之前,把「当前对这个 org 而言仍是候选、但不属于本用例自己 seed 的」每一个模板,抢先挂进一个本 org 专属、名字与 sort_order 都刻意避开这个文件里任何一个真实分类/排序值的「sink 组」。挂完之后,产线的 `NOT EXISTS` 检查会把这些外来行**合法地**排除掉——不是绕过产线逻辑,是让测试环境补上「一个真正隔离的 org 本来就会看到的样子」。之后每个用例原有的精确断言(`toEqual`,不退化成 `toContain`)才重新有意义。

**披露(写进三个文件各自的 helper 注释)**:sink 查询没有跑 `applyTemplateVisibilityFilter`,只按 §11.0 folded 出来的 manager-only 谓词扫;这只在「本文件里每一处调用 `sinkForeignTemplates` 的用例都在 `managerActor`(`isTemplateManager:true`)下跑——此时该 filter 本身就是 no-op」这个前提下才是稳妥的。本文件唯一的非 manager 用例(preview 的 §5.2 scope 测试)不调用这个 helper,且只断言 `.find(...).toBeDefined()`,不是精确集合——不受影响。一个未来的「非 manager + 精确集合」断言需要一个感知可见性的 sink,不是这一个;如实记录,不在本轮处理。

**关于 `id` 格式**:`atg_sink_${org}` 会把 org 标签里的连字符原样带进 group id(其余本文件的 group id 全部只用下划线)。核对 DDL(`packages/core-backend/src/db/migrations/zzzz20260918090000_create_approval_template_groups.ts:37-62`):`id` 是裸 `text PRIMARY KEY`,没有格式 CHECK;只有 `org_id`/`name` 有 `[!-~]` 非空 CHECK,连字符满足。三次真库重跑(§11.1/§11.3)里没有一次因为 id 格式失败——不是理论推断,是实测确认。

**清理**:preview/execute/rollback 三个文件的 `afterAll` 均按「batch(cascade)→ links → groups → 按 org」的顺序把 `orgTags` 里追踪到的每一个 org(含 sink 组/link)整段删掉;`sinkForeignTemplates` 的每一次调用现场核对——三个文件里传进去的 `org` 全部来自各自的 `trackOrg(...)`,没有一处绕过 tracking 直接手写 org 字符串。

### 11.3 用污染库重跑五文件全绿,再在处女库重跑一遍

污染库(§11.1 的 `metasheet2_lock_a3_ci`,污染物原样留在库里,preview 从不删模板行,只把它们挂进各用例自己 org 的 sink 组):

```
$ DATABASE_URL=postgresql://postgres@localhost:5432/metasheet2_lock_a3_ci \
    pnpm exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-backfill-preview.db.test.ts \
    tests/integration/approval-template-groups-backfill-execute.db.test.ts \
    tests/integration/approval-template-groups-backfill-rollback.db.test.ts \
    tests/integration/approval-template-groups-backfill-schema.db.test.ts \
    tests/integration/approval-template-groups-backfill-batches-list.db.test.ts --reporter=dot
 Test Files  5 passed (5)
      Tests  48 passed | 5 skipped (53)
```

处女库(`metasheet2_lock_a3_ci_virgin`,本次会话新建 + `db:migrate`,零污染):

```
$ DATABASE_URL=postgresql://postgres@localhost:5432/metasheet2_lock_a3_ci_virgin \
    pnpm exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-backfill-preview.db.test.ts \
    tests/integration/approval-template-groups-backfill-execute.db.test.ts \
    tests/integration/approval-template-groups-backfill-rollback.db.test.ts \
    tests/integration/approval-template-groups-backfill-schema.db.test.ts \
    tests/integration/approval-template-groups-backfill-batches-list.db.test.ts --reporter=dot
 Test Files  5 passed (5)
      Tests  48 passed | 5 skipped (53)
```

两边计数逐字相同(48/5/53)——修法在污染库与处女库上行为一致,不是「恰好在这一批污染物上蒙对了」。schema/batches-list 两个未改动的文件在两边都保持全绿(它们的断言全部按具体 id/batchId 定位,或已有 org 级清理,天然不暴露在这个共享表的问题面上——本轮据此判定这两个文件**不需要** `sinkForeignTemplates`)。

> **§12.1 求值(不是作废本句,而是给这句话本身钉一个求值)**:上面这句对 `batches-list` 的「不需要」判断,在 34 行小体量污染集下成立,但对「候选数超过 500 上限」这条轴不成立——`impl-gate-A3-round3-20260918.md` P2-1(E14)测到 `batches-list` 的 route-wiring admin 与 smoke 两个用例正是未 sink 的 `execute` 调用点,在 634 行外来污染下会抛 `Backfill candidate count … exceeds the 500 limit`。§12.1 已经给这两个用例加了 `sinkForeignTemplates`——`batches-list` 的「不需要」判断到此**作废**,以 §12.1 为准。`schema` 一侧的判断(该文件零 `execute`/`rollback` 调用,只做 DDL/约束断言)不受影响,仍然成立。

**步骤④的机械核查(而不是只看「两个库都绿」)**:按记忆 `feedback_absolute_claim_sweep_must_be_mechanical`,「绿」本身不是证据——§11.1 自己就演示过「NULL-only 污染物让 execute/rollback 保持绿,换成 AAA 形状才现出原形」,同一个陷阱可能同样发生在这里。逐文件机械核查(`grep -n "org_id = \$1\|WHERE org_id\|count(\*)"` 打底,再读命中行上下文判断是不是「org 级全集/计数」还是「按具体 id 定位」):

- `approval-template-groups-backfill-schema.db.test.ts` / `approval-template-groups-backfill-batches-list.db.test.ts`(A-3 本身另外两个真库文件):已在 §11.3 上文核实——全部命中要么是 DDL/约束层面的具体 conname 断言,要么按 batchId/templateId 精确定位,零一处对 `approval_templates` 的全局候选做全集/计数断言。
- `approval-template-groups-lifecycle.db.test.ts`(A-1 既有文件,同一条 required lane):全文 `grep` 零次出现 `previewApprovalTemplateGroupBackfill`/`executeApprovalTemplateGroupBackfill`/`backfill`——这个文件测的是分组的直接 CRUD(create/archive/link/unlink 组的路由/服务函数),从未调用会扫描全局 `approval_templates` 候选池的那两个函数,因此结构上就不在本条缺陷的暴露面上,不是「跑一次污染集正好没触发」。文件里唯一的 `count(*)`/`WHERE org_id` 命中(`:391`/`:404`/`:417`/`:539`)全部读的是 `approval_template_groups`(这张表本身就有 `org_id` 列,原生按 org 隔离,不依赖候选查询)。
- `approval-template-groups-serialization.db.test.ts`(A-1 既有文件):`grep` 命中 4 处真的调用了 HTTP `execute`/`rollback`(`:487`/`:646`/`:685`/`:707`,RR-pool 序列化/锁序探针)——**这个文件结构上确实在暴露面上**,逐处读完调用之后的断言:
  - 每一处对 `execBody.groups`/`body.groups` 的读取都是 `.find((g) => g.category === category)`(`category` 由本用例自己用 `${TS}` 拼出的独一无二字符串,如 `` `ExecCat-${TS}` ``、`` `LOExec-${TS}` ``——与本轮污染集的 `NULL`/`'   '`/`'AAA'` 三个字面量不可能撞上),从未对整个 `groups` 数组做 `toEqual`/`toHaveLength`(`grep -n "\.groups\b|toHaveLength|candidateCount|\.buckets\b"` 全文件只命中这两处 `.find`,零一处数组级断言)。
  - 之后所有 SQL 复核(`:504`/`:585`/`:659`/`:662`/`:722`/`:729`)全部按 `org_id = $1 AND name = $2` / `template_id = $2` / `id = $2` 精确定位,唯一的数值比较是 `expect(Number(ownGroup.rows[0].sort_order)).toBeGreaterThan(1)`——`toBeGreaterThan`,不是精确相等,多一个外来 category 触发的额外建组只会把 sort_order 推得更高,不会让这条断言变红。
  - 唯一读 `approval_template_groups` 全集数组的用例(`:315` "E: 两个并发 create … `[1, 2]`")走的是 `POST /api/approval-template-groups` 这条**直接建组**路由,不经过 backfill/候选查询,`approval_templates`/污染物与它无关。
  - **实测确证**(不是只靠代码走查):这四处 backfill 调用点在 §11.5 的 84 文件复现里,就是在含 `NULL`/`'   '`/`'AAA'` 三种形状污染物的同一个 `metasheet2_lock_a3_ci` 库上原样跑过的——`✓ approval-template-groups-lifecycle.db.test.ts (19 tests | 1 skipped) 887ms`、`✓ approval-template-groups-serialization.db.test.ts (14 tests | 1 skipped) 6743ms`,两个文件零红。

结论:步骤④要求的「同类共享 org 假设」普查,在 A-3 自己的另外两个文件、以及同一条 lane 里唯一两个会调用受影响函数的 A-1 文件(`serialization`)上都做了——零命中需要隔离;`lifecycle` 结构上不在暴露面上。不新增改动。

> **§12.7 求值(不是作废本句,而是给这句话本身钉一个求值)**:「零命中需要隔离」对 `serialization` 的判断,是在 §11.1 那批 34 行、含 `NULL`/`'   '`/`'AAA'` 三种形状但**体量不超过 500 上限**的污染集下测得的,在那个体量下**成立**。它在「候选数超过 500 上限」这条轴上**不成立**——§12.7 用同一份 634 行注入亲测 `serialization` 在这条轴上 3 个用例红(`:493`/`:647`/`:686`)。这是本轮**没有修**的一个已知暴露面(不在 P2-1 点名的 10 个调用点之内,修改 `serialization` 会超出本轮授权范围),如实记录,不据此撤回上面「零命中需要隔离」这句话在其原始测量体量下的正确性——两个体量、两个结论,不是同一个结论自相矛盾。

### 11.4 Mutation(唯一亲跑;`cp` 备份 → 编辑 → 单独跑 → `cp` 还原 → `cmp`)

对 `classifyBackfillCategory`(`packages/core-backend/src/services/ApprovalTemplateGroupService.ts:705-718`)做探针:去掉 blank-after-trim 单独分支,让空字符串落进「不可存储」分支(与 CJK 类共用 `CATEGORY_NOT_STORABLE_AS_GROUP_NAME` 这一个 reason):

```diff
   const trimmedCategory = pgBtrim(rawCategory ?? '')
-  if (trimmedCategory === '') {
-    return { action: 'skip', reason: 'CATEGORY_BLANK_AFTER_TRIM', trimmedCategory }
-  }
   if (!STORABLE_GROUP_NAME_PATTERN.test(trimmedCategory)) {
     return { action: 'skip', reason: 'CATEGORY_NOT_STORABLE_AS_GROUP_NAME', trimmedCategory }
   }
```

处女库上单独跑 preview 文件:

```
❯ … skipped: blank-after-trim … —
    AssertionError: expected 'CATEGORY_NOT_STORABLE_AS_GROUP_NAME' to be 'CATEGORY_BLANK_AFTER_TRIM'
    295| expect(nullBucket!.reason).toBe('CATEGORY_BLANK_AFTER_TRIM')
 Test Files  1 failed (1)
      Tests  1 failed | 12 passed | 1 skipped (14)
```
唯一变红的正是目标用例,其余 13 条(含本轮新增的全部 `sinkForeignTemplates` 断言)保持绿——判别力精确落在被测分支上,不是整份文件的连坐。`cp` 还原 + `cmp` 确认 `ApprovalTemplateGroupService.ts` 与探针前字节相同后,重跑 preview 文件确认恢复绿(13 passed | 1 skipped)。

### 11.5 required 步骤逐字复现(84 文件)+ core-backend 全量 vitest

`.github/workflows/plugin-tests.yml` 的 `approval-real-db-integration` 步骤(:1604-1699)原样抄出 84 个文件,唯一改动是把 `DATABASE_URL` 换成本次的污染库(`metasheet_test` 是其他 lane 共用的库,依硬规矩绝不写):

```
$ DATABASE_URL=postgresql://postgres@localhost:5432/metasheet2_lock_a3_ci \
    pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
    <84 个文件,与 workflow 步骤原文逐字同序> --reporter=dot
 Test Files  1 failed | 83 passed (84)
      Tests  1 failed | 932 passed | 10 skipped (943)
```

唯一失败:`directory-binding-admin-routes.db.test.ts`(`B. GET /suggestions is the §9 read-only surface` — expected 401 to be 200)。**与本切片无关**,如实记录不算已满足绿:
- 该文件在 84 文件列表里排第 69 位,本切片改动的五个文件排第 76/80/81/82/83/84 位——按 `fileParallelism:false` 的严格串行顺序,它先于本切片任何文件运行,不可能是下游被本次改动影响的结果。
- 断言与 `approval_templates`/分组/回填毫无关系(`grep` 该文件全文,零次出现这几个词)。
- 单独隔离重跑(处女库)全绿:
  ```
  $ DATABASE_URL=postgresql://postgres@localhost:5432/metasheet2_lock_a3_ci_virgin \
      pnpm exec vitest --config vitest.integration.config.ts run \
      tests/integration/directory-binding-admin-routes.db.test.ts --reporter=dot
   Test Files  1 passed (1)
        Tests  6 passed (6)
  ```
  确认是 84 文件共享一次 server/DB 进程时才出现的跨文件状态污染(某个更早文件残留的 RBAC/JWT 设置行影响到了这条 401/200 判定),不是本次改动引入的新缺陷,也不是本次污染 INSERT(直接对 `approval_templates` 表插的 3 行)能触达的表面——按记忆 `feedback_flake_attribution_last_active_suite` 的要求,如实点名「未定位根因的跨文件既有 flake」,不归为本切片修复范围,不据此宣称「required 步骤已全绿」。

**P3-3 更正(`impl-gate-A3-round3-20260918.md`)**:上一版本节把下面这条 lane 称作「`core-backend` 全量无 DB 单测(`pnpm test:unit`)」——这个说法窄于 required 的真实 lane。`test:unit`(`package.json`)是 `vitest run tests/unit`,只跑 `tests/unit` 一个目录;required check `test (20.x)` 真正跑的「Run core-backend tests」步(`.github/workflows/plugin-tests.yml:877-879`,无 `if:`/无 `env:`)命令是 `pnpm --filter @metasheet/core-backend test`,收集面是前者的真超集。以下是用**正确命令**跑的结果(与门审 E11 逐字相同,本轮独立复跑确认非偶然):
```
$ env -u DATABASE_URL -u EXPECT_DB CI=true pnpm --filter @metasheet/core-backend test --reporter=dot
 Test Files  932 passed | 175 skipped (1107)
      Tests  14722 passed | 1604 skipped (16326)
```
EXIT=0,与本切片 5 个真库文件完全不相交的另一条 lane,用来确认三处测试文件改动没有波及其它任何单测——`grep -c "tests/integration/approval-template-groups-backfill" <该次日志>` = 0(五个新文件在这条无库 lane 里零收集,不是 skip-green)。

### 11.6 收尾:`git diff --stat`(证明只动测试与本 MD)

```
$ git diff --stat
 .../approval-template-groups-backfill-execute.db.test.ts  |  85 +++++++++++++--
 .../approval-template-groups-backfill-preview.db.test.ts  | 115 ++++++++++++++++++---
 .../approval-template-groups-backfill-rollback.db.test.ts |  63 ++++++++++-
 docs/development/approval-template-groups-phase2-backfill-verification-20260918.md | <本节自身>
 4 files changed
```
零生产代码改动(§11.4 的 mutation 探针已 `cmp` 确认字节级复原,不计入本次提交);`approval-template-groups-backfill-schema.db.test.ts`/`approval-template-groups-backfill-batches-list.db.test.ts`/`approval-template-groups-lifecycle.db.test.ts`/`approval-template-groups-serialization.db.test.ts` 按 §11.3「步骤④机械核查」小节的 `grep` + 逐命中行走查 + 84 文件污染库实测三重证据保持不动,不是仅凭「两个库都绿」。**求值(2026-09-19,round-4 gate P3-2,`impl-gate-A3-round4-20260918.md` §4):这句「保持不动」名单里的 `approval-template-groups-backfill-batches-list.db.test.ts` 已在 §12.1(修复轮 4)被改动——新增了本文件自己独立的第四份 `sinkForeignTemplates` 副本 + 2 处调用,详见 §12.6 的 `git diff --stat`。此处原句按记忆 `feedback_supersession_marker_must_evaluate_not_void` 的要求不删除,只贴求值:`schema`/`lifecycle`/`serialization` 三个文件对本句仍然成立,只有 `batches-list` 一项从这份名单里移出,不得单读本段就以为它至今未被触碰。**§10 是既有编号(修复轮 3),本节按既有编号序延续为 §11——三个文件里的代码注释本身已经这样自称(「§11 CI fix」),本节把编号落回 MD 正文,不是新起一套编号。

**遗留(如实记录,不算已满足)**:`directory-binding-admin-routes.db.test.ts` 的跨文件 flake 未定位根因,只确认与本切片无关且不可能是本切片下游;是否需要单独立项排查,交 owner/后续 lane 裁决。

---

## 12. 修复轮 4 处置(`impl-gate-A3-round3-20260918.md`,裁定 0 P1 / **1 P2** / 3 P3,2026-09-18)

本节处置该报告点名的 P2-1 与三条 P3。私有库 `metasheet2_lock_a3_r4`(本次会话新建,`dropdb --if-exists` + `createdb` + 全量 `src/db/migrate.ts`,末条迁移与门审报告一致,`zzzz20260919090000_create_approval_template_group_backfill_batches`)。

### 12.1 P2-1(唯一阻断项)—— `sinkForeignTemplates` 只关「精确集合/计数」轴,未关「500 上限」轴

**发现原文**(门审 E14,亲跑):往同一 org 池注入 634 行外来未链接模板后,`executeApprovalTemplateGroupBackfillWithClient` 在分桶前对 `eligible.length`(617)做的上限检查(`routes/approvals.ts:694-701`,`APPROVAL_TEMPLATE_GROUP_BACKFILL_MAX_CANDIDATES = 500`)先于任何 sink 生效,导致 10 个未 sink 的 `execute` 调用点全部抛 `ServiceError`——execute 文件的 idempotency(:335 起,现已随本轮改动移位)/cross-verification/route-wiring admin,rollback 文件的 attach/extadd/double/notfound/route-wiring admin,batches-list 文件的 route-wiring admin/smoke。execute 文件里 idempotency(原 `:328-333`)与 cross-verification(原 `:386-389`)两处豁免注释的 `regardless of how many foreign rows` / `never changes` 是被这条反例证伪的绝对断言。

**求值(2026-09-19,round-4 gate P3-3,`impl-gate-A3-round4-20260918.md` §4/§0):「634 行」本身不是承重的量,承重的是通过上限检查(`eligible.length`,即 §3.1 候选谓词——`NOT EXISTS` 链接排除 + `btrim(category) ~ '[!-~]'`)的行数,这里记 `storable_unlinked`。上面这次注入恰好 `storable_unlinked = 617`(> 500,越限),是因为这批插入全部使用非 NULL 分类(`'Pollute' || (g % 7)`),全部通过 `btrim(...) ~ '[!-~]'`;门审第 4 轮独立复核过一个**不越限**的反例——同样插入 634 行,但按「NULL/非 NULL 各半」配比,`storable_unlinked` 只有 317(< 500),5 个文件全绿但根本没碰到上限分支。所以「634 行」这个数字不能脱离分类配比单独当复现口径读;下面 §12.5 回归表与本节其余「634」引用记的都是**这一批全非 NULL 的注入**(`storable_unlinked = 617`),读者若照抄「634 行」去构造别的验证集,必须先确认自己的分类配比也全部落在 `btrim(...) ~ '[!-~]'` 之内,否则可能像门审第 4 轮 E5 那样测不到这条轴。**

**修法(两条都做,按门审措辞对应)**:

1. **10 个调用点全部加 `sinkForeignTemplates`**(execute 文件的 idempotency/cross-verification/route-wiring admin;rollback 文件的 attach/extadd/double/notfound/route-wiring admin;batches-list 文件的 route-wiring admin/smoke——后者此前完全没有这个 helper,本轮按三个既有文件的复制惯例新增了一份独立副本)。每处都改成「先 `createTemplate` 拿到自己的模板 id → `sinkForeignTemplates(org, [自己的 ids])` → 再调用 `execute`」,与本文件其余用例的既有写法一致。
2. **两句被证伪的绝对断言,改写为有条件、可机核的陈述,并落成运行期断言**:execute 文件新增 `assertEligibleCandidateCountWithinCap(org, ownCandidateCount)`——对 org 跑与产线 `eligible` 同形的 SQL(`NOT EXISTS` 链接排除 + `btrim(...) ~ '[!-~]'`,同样披露省略 `applyTemplateVisibilityFilter`、理由与 `sinkForeignTemplates` 相同),断言结果**等于**这条用例自己算出来的候选数、且**不超过** `MAX_CANDIDATES_UNDER_TEST`(与 §13 changesRequired #12 用例共享同一个常量,不再有第二个硬编码 "500")。idempotency/cross-verification 两处调用点各调一次这个断言,把原注释里的散文条件——「`regardless`/`never` 只在『外来行 ≤ 上限 − 本文件候选数』这个前提下成立」——落成会真的跑、会真的红的代码,不是继续留成注释里的承诺。rollback attach 处原有一段类似但措辞不同的豁免注释(`:219-223`,「holds either way」),同样因为没考虑 `execute` 会先整体抛错而站不住,一并改写(不新增 candidateCount 断言,因为这条不是门审引用的两句「原话」之一,只是加 sink 让它不再假)。

**复现门审 E14(本轮亲跑,4 个文件、45 个用例——与门审报告"10 failed | 35 passed (45)"同一分母)**:

```
$ psql -d metasheet2_lock_a3_r4 -c "INSERT INTO approval_templates (key, name, status, category, visibility_scope)
    SELECT 'p2r4-pollute-' || g, 'p2r4-pollute-' || g, 'draft', 'Pollute' || (g % 7), '{\"type\":\"all\",\"ids\":[]}'::jsonb
    FROM generate_series(1, 634) AS g;"
INSERT 0 634

$ DATABASE_URL=postgresql://localhost:5432/metasheet2_lock_a3_r4 EXPECT_DB=1 pnpm exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-backfill-preview.db.test.ts \
    tests/integration/approval-template-groups-backfill-execute.db.test.ts \
    tests/integration/approval-template-groups-backfill-rollback.db.test.ts \
    tests/integration/approval-template-groups-backfill-batches-list.db.test.ts --reporter=dot
 Test Files  4 passed (4)
      Tests  45 passed (45)
```

修复前是「10 failed | 35 passed (45)」,修复后同一份 45 个用例、同一 634 行污染物全绿——不是换了更宽松的污染集蒙对。

**清理**:

```
$ psql -d metasheet2_lock_a3_r4 -c "DELETE FROM approval_templates WHERE key LIKE 'p2r4-pollute-%';"
DELETE 634
```

**Mutation(唯一亲跑;`cp` 备份 → 编辑 → 单独跑 → `cp` 还原 → `cmp`)**:去掉 rollback 文件 `changesRequired #7`("double" rollback)用例里新加的 `sinkForeignTemplates(org, [doubleTpl])` 一行,换成一句 `// MUTANT-P2-1-R4` 注释;重新注入 634 行污染物;单独跑 rollback 文件:

```
$ DATABASE_URL=postgresql://localhost:5432/metasheet2_lock_a3_r4 EXPECT_DB=1 pnpm exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-backfill-rollback.db.test.ts --reporter=dot
 ❯ … changesRequired #7: rolling back an already-rolled-back batch is a 409 … —
     ServiceError: Backfill candidate count 635 exceeds the 500 limit
 Test Files  1 failed (1)
      Tests  1 failed | 10 passed (11)
```

唯一变红的正是被去掉 sink 的那条用例,错误逐字是门审 E14 同一个 `ServiceError`;其余 10 条(含本轮新加的其余 4 个 rollback 调用点的 sink)保持绿——判别力精确落在被测调用点,不是整份文件连坐。`cp` 还原 + `cmp`:

```
$ cmp <备份> <还原后的文件> && echo CMP-IDENTICAL
CMP-IDENTICAL
```

还原后 `git status --porcelain` 只剩本轮三个真实改动的文件,无 mutation 残留。清理污染物(`DELETE … WHERE key LIKE 'p2r4-pollute-%'` → `DELETE 634`,库回到 0 行)。

**Mutation 补充——证明 `assertEligibleCandidateCountWithinCap` 这个断言本身有判别力,不是「跟着产线 `ServiceError` 顺路绿」**:上面这次 mutation 去掉的是 rollback `double` 用例的 `sinkForeignTemplates` 调用,那条用例本身不调用 `assertEligibleCandidateCountWithinCap`——证明的是「sink 承重」,不是「新加的断言承重」。这两件事是分开的,补做一次只针对断言的 mutation:`cp` 备份 execute 文件,只去掉 idempotency 用例里的 `await sinkForeignTemplates(org, [idemHr1, idemHr2])` 一行(换成 `// MUTANT-P2-1-ASSERT` 注释),**保留**同一用例后面的 `await assertEligibleCandidateCountWithinCap(org, 2)` 调用;重新注入 634 行污染物;单独跑 execute 文件:

```
$ DATABASE_URL=postgresql://localhost:5432/metasheet2_lock_a3_r4 EXPECT_DB=1 pnpm exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-backfill-execute.db.test.ts --reporter=verbose
 × … idempotency: a second sequential execute call … — expected 636 to be 2
 FAIL … idempotency …
 AssertionError: expected 636 to be 2 // Object.is equality
   ❯ assertEligibleCandidateCountWithinCap tests/integration/approval-template-groups-backfill-execute.db.test.ts:203:27
       203|     expect(eligibleCount).toBe(ownCandidateCount)
   ❯ tests/integration/approval-template-groups-backfill-execute.db.test.ts:388:5
 Test Files  1 failed (1)
      Tests  1 failed | 11 passed (12)
```

失败发生在 `assertEligibleCandidateCountWithinCap` 内部(`636` = 634 行外来污染 + 本用例自己的 2 个候选,`toBe(ownCandidateCount=2)` 断言先红),在这条用例走到 `executeApprovalTemplateGroupBackfill` 之前——不是产线 `ServiceError` 冒出来顺带带红这条用例,是断言自己先侦测到「候选人口不干净」这件事。其余 11 条(含未受影响的其余 execute 文件用例)保持绿。`cp` 还原 + `cmp`:

```
$ cmp <备份> <还原后的文件> && echo CMP-IDENTICAL
CMP-IDENTICAL
```

还原后 `git status --porcelain` 空(与提交后的工作树字节相同)。清理污染物,`dropdb`。

### 12.2 P3-1 —— MD 里一处标「原话」的引用含 3 个西里尔同形字

机械扫描(python,`unicodedata` 逐字符核 Cyrillic/Greek/组合符/NUL/格式控制字符区段)命中本文件(本 MD)`:789` 三个字符:U+043A(CYRILLIC SMALL LETTER KA)、U+0430(CYRILLIC SMALL LETTER A)、U+0440(CYRILLIC SMALL LETTER ER)——英文单词 "carries" 的前三个字母被换成了这三个西里尔同形字(此处刻意不重复排印被替换前的确切字节序列,避免同一份「零同形字」文档里再留一处需要被下一轮同形字扫描重新命中的样本)。改用 python 精确字符串替换(先断言命中次数为 1,再替换成 ASCII 原文)修正,重新扫描确认**零残留**,并与源文件 `approval-template-groups-backfill-batches-list.db.test.ts:108` 的真实原话逐字比对一致(该文件本轮也被 P2-1 修改,但这一行本身未变)。

同一次机械扫描也命中了门审报告 `impl-gate-A3-round3-20260918.md:116/:118`(该报告自己在转述这条发现时也复制了两次这份带同形字的引文)——这是**门审自己的报告文件**,不在「测试 + 本 MD」的授权修改范围内,本轮未触碰,如实记录不算已修。

### 12.3 P3-2 —— 三个文件里写死的「污染来源」机制,改写为「来源未定位、体量未测量、暴露已确证」

`preview.db.test.ts`(execute/rollback 转引同一段)原来的 `afterEach` 上方注释断言污染物来自「同一次 84 文件 run 里的某个 OTHER、更早的文件(它自己的 teardown 从不删 `approval_templates` 行,因为模板删除从来不是它的合同)」。这条机制声明与实测不符:门审 E2/E3(本次会话在 §11.1 已复核过)测到,处女库上把这一个步骤自身的 84 个文件跑完,`approval_templates` 残留是 **0 行**;机械核查 84 个文件里 33 个有带 `WHERE` 的 `DELETE FROM approval_templates`、零个无 `WHERE` 的整表删除、零个 `TRUNCATE`;又因 `fileParallelism:false` 严格串行,每个文件的 `afterAll` 都在下一个文件的 `beforeAll` 之前跑完——这一个步骤内部没有任何一个文件会把模板行留到别的文件眼前。

本轮改写为诚实表述:三个文件(preview 的完整机制段,execute/rollback 指向它的引用句)一律改成——**真实来源几乎必然是同一个 CI job 里更早的、共用 `metasheet_test` 库的某个 real-DB 步骤(候选:`multitable-real-db-integration`/elearning/sealed-export/after-sales/BPMN 等),但这一点未经测量**;诚实的说法是**来源未定位、体量未测量、暴露已确证**(生产 CI 确实撞过这条——原始 bug 报告的「13 vs 1」blank 桶失败——所以「某个更早步骤」确实留下过行,只是哪一个、留了多少行都没测过)。`sinkForeignTemplates` 本身不依赖定位来源(它扫的是「当前对这个 org 而言仍是候选」的全集,不管是哪个步骤或哪个文件放进去的),这条归因错误只影响注释里的说法,不影响修法本身是否承重(§11.3/12.1 的实测已经覆盖了「不管来源是什么,sink 都能把它扫掉」这件事)。

### 12.4 P3-3 —— MD §11.5 把 `test:unit` 称作「core-backend 全量无 DB 单测」,窄于 required lane

`test:unit`(`package.json`)是 `vitest run tests/unit`,只跑 `tests/unit` 一个目录;required check `test (20.x)` 真正跑的「Run core-backend tests」步(`.github/workflows/plugin-tests.yml:877-879`,无 `if:`/无 `env:`)命令是 `pnpm --filter @metasheet/core-backend test`,收集面是前者的真超集。§11.5 原文按窄命令记录(`794 passed (794)` / `12715 passed (12715)`),本轮改成按正确命令、本次会话独立重跑的结果记录(见 §11.5 内联更正,与本节共用同一次亲跑):

```
$ env -u DATABASE_URL -u EXPECT_DB CI=true pnpm --filter @metasheet/core-backend test --reporter=dot
 Test Files  932 passed | 175 skipped (1107)
      Tests  14722 passed | 1604 skipped (16326)
```

EXIT=0,与门审 E11 的计数逐字相同(`1107`/`16326`),不是巧合——收集面没有因为版本或时间漂移。

### 12.5 全量回归(本轮,私有库 `metasheet2_lock_a3_r4`)

| 步骤 | 命令 / 要点 | 结果 |
|---|---|---|
| tsc | `cd packages/core-backend && npx tsc --noEmit` | EXIT=0,零错误(含 §12.1 新增的 `assertEligibleCandidateCountWithinCap`/常量重排) |
| 建库 + 迁移 | `dropdb --if-exists metasheet2_lock_a3_r4 && createdb metasheet2_lock_a3_r4` + `DATABASE_URL=… pnpm run db:migrate` | 全量迁移,末条 `zzzz20260919090000_create_approval_template_group_backfill_batches`,与门审报告一致 |
| A-3 五文件 + A-1 两文件,处女库,污染前 | `vitest --config vitest.integration.config.ts run <7 个文件> --reporter=dot` | `Test Files 7 passed (7)` / `Tests 86 passed (86)` |
| E14 复现(§12.1) | 634 行污染(全非 NULL 分类 ⇒ `storable_unlinked = 617` > 500,承重量见 §12.1 求值)→ 4 文件 45 用例 | 全绿(此前 10 failed) |
| Mutation(§12.1) | 去掉 double 用例的 sink,635 超限 | 1 failed(仅该用例)/ 10 passed;`cmp` 复原 |
| 84 文件 required real-DB 步骤逐字复现(按 `.github/workflows/plugin-tests.yml:1613-1699` 原样抄出,唯一改动是 `DATABASE_URL` 指向本次私有库) | `DATABASE_URL=… EXPECT_DB=1 bash -e /tmp/a3r4-realdb-step.sh` | `Test Files 84 passed (84)` / `Tests 943 passed (943)` / EXIT=0——**本轮零失败**,门审 E2 记录的那条跨文件既有 flake(`directory-binding-admin-routes.db.test.ts`)本次未复现,与 §11.5 遗留段"未定位根因的跨文件 flake"记录一致(间歇性,不是每次都触发) |
| 84 文件跑完后 `approval_templates`/`approval_template_groups`/`approval_template_group_links` 残留 | `psql` 计数 | `0 \| 0 \| 0`——与 §12.3 的「本步骤自身残留为 0」结论一致,再次实测确认 |
| A-3 五文件 + A-1 两文件,84 文件全量跑完后再跑一遍 | 同上 7 个文件 | `Test Files 7 passed (7)` / `Tests 86 passed (86)` |
| core-backend 全量无 DB lane(§12.4 用的同一次亲跑) | `env -u DATABASE_URL -u EXPECT_DB CI=true pnpm --filter @metasheet/core-backend test --reporter=dot` | `Test Files 932 passed \| 175 skipped (1107)` / `Tests 14722 passed \| 1604 skipped (16326)` / EXIT=0;`grep -c "tests/integration/approval-template-groups-backfill" <日志>` = 0(五个真库文件零收集) |
| 清库 | `dropdb metasheet2_lock_a3_r4` | 用完即删,不留存 |

### 12.6 `git diff --stat 4f5fd00c3..HEAD`(证明只动测试与本 MD)

```
$ git diff --stat 4f5fd00c3157e807b8e28b01c98dca07619bc289
 .../approval-template-groups-phase2-backfill-verification-20260918.md | 129 ++++-
 .../approval-template-groups-backfill-batches-list.db.test.ts         |  46 ++-
 .../approval-template-groups-backfill-execute.db.test.ts              | 114 +++--
 .../approval-template-groups-backfill-preview.db.test.ts              |  31 +-
 .../approval-template-groups-backfill-rollback.db.test.ts             |  56 ++-
 5 files changed, 326 insertions(+), 50 deletions(-)
```
(以此提交前的工作树为准测得,提交后的最终行数以实际 commit 为准,但文件集合与「零生产代码改动」结论不变——`git diff --name-only 4f5fd00c3..HEAD | grep -v -E "\.md$|tests/integration/.*\.db\.test\.ts$" | wc -l` = 0,亲测。)

零生产代码改动——`packages/core-backend/src/` 与 `.github/workflows/` 下零文件命中(与 §2/E1 的既有核查方法一致,本轮同样跑过 `git diff --name-only 4f5fd00c3..HEAD | grep -v -E "\.md$|tests/integration/.*\.db\.test\.ts$" | wc -l` = 0)。`approval-template-groups-backfill-batches-list.db.test.ts` 本轮**从 §11.6 记录的「保持不动」名单里移出**——它是本轮 P2-1 唯一新增 `sinkForeignTemplates` 副本的文件(此前三个文件独立复制,本轮加了第四份);`approval-template-groups-backfill-schema.db.test.ts`/`approval-template-groups-lifecycle.db.test.ts`/`approval-template-groups-serialization.db.test.ts` 三个文件本轮仍未改动。

### 12.7 如实记录:本轮跑到但没修的暴露面(不在 P2-1 点名的 10 个调用点之内,未被授权修改)

派工书只点名了 execute/rollback/batches-list 三个文件的 10 个调用点;§11.3 曾用一批 34 行、体量不超过 500 上限的污染集测过 `serialization`(A-1 既有文件)零命中,认为不需要隔离。§12.1 修完 10 个点之后,本会话用同一份 634 行 E14 污染集把 `serialization` 单独跑了一遍(私有库 `metasheet2_lock_a3_r4`,与 §12.1 同一次会话),证明这条判断在超过 500 上限这条轴上**不成立**:

```
$ psql -d metasheet2_lock_a3_r4 -c "INSERT INTO approval_templates … FROM generate_series(1, 634) AS g;"
INSERT 0 634
$ DATABASE_URL=postgresql://localhost:5432/metasheet2_lock_a3_r4 EXPECT_DB=1 pnpm exec vitest --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-serialization.db.test.ts --reporter=verbose
 Test Files  1 failed (1)
      Tests  3 failed | 11 passed (14)
```

三条失败逐字:

1. `:493`「A-3 execute (composed caller): under the RR-default pool, execute still reads a concurrently-committed holder row at MAX(sort_order) — proving the SET this composed transaction issues is not a single-primitive-only obligation」—— `AssertionError: expected 400 to be 201`。
2. `:647`(经 `waitUntilBackendBlockedByHolder`,抛出点在 `:175`)「execute lock-order (design-gate M2, §13.2 fix): stalls on the batched deterministic pre-lock statement, not a per-category one」—— `Error: timed out waiting for backend blocked by holder pid … on query ~id = ANY($2) ORDER BY id FOR UPDATE (never engaged the production lock — race golden would be vacuous)`。**这一条比另外两条更值得点名**:它不是简单地变红,而是「从未真正打到产线锁」——这条用例本来是用来证明「悲观锁在正确的语句上生效」的判别力探针,在候选数超限、`execute` 一开始就因 `ServiceError` 短路的情况下,连锁都没上,探针本身失去判别力,不只是失败。
3. `:686`「rollback lock-order (design-gate M3, §13.2 fix): stalls on the batched deterministic pre-lock statement, not a per-group one」—— `AssertionError: expected 400 to be 201`。

清理:`DELETE FROM approval_templates WHERE key LIKE 'p2r4b-pollute-%'` → `DELETE 634`,库回到 0 行。

**归类,不修**:`git diff --name-only 4f5fd00c3..HEAD` 不包含 `approval-template-groups-serialization.db.test.ts`——本轮零字节改动过这个文件,它在超限体量下的行为是**改动前就存在的暴露面**,不是本次提交引入的回归。修它需要给 `serialization` 自己的 4 个 backfill 调用点(`:487`/`:646`/`:685`/`:707`)加 sink,这是产线锁序/RR-pool 探针文件,改动面超出 P2-1 点名的 10 个调用点和本次派工授权的范围,留给 owner/后续 lane 裁决是否要在同一个机制下修。

**同一份普查也带出另一条不对称,一并点名(§12.1 的 sinkForeignTemplates 助手注释里已留了一句,这里搬进 MD 让它可见)**:`batches-list` 里第三个调用 `execute` 的用例——`` `a foreign org never sees another org's batches over HTTP` ``(现行号 `:267` 起——本轮改动前是 `:229`,因本文件同轮加了 `sinkForeignTemplates` 助手与两处调用而下移)——本轮**没有**加 sink,是刻意的:它从未对 `execRes.status`/`execBody` 做任何断言,只检查 org B 的列表里找不到 `execBody.batchId`;在候选数超限、`execute` 抛 400 而不是返回 `{batchId}` 的场景下,`execBody.batchId` 是 `undefined`,而「org B 的列表里找不到 batchId===undefined 的一条」这句断言**依然为真**——这条用例在超限体量下会**假绿**(不是因为它被保护了,是因为它从来没有真的验证过 `execute` 成功)。这是本轮**发现但未修**的第三类问题(与「未 sink 导致真红」不同类):修法是让它对 `execRes.status` 做真断言,同样超出本轮授权范围,一并交 owner/后续 lane。

**本轮 required real-DB 步骤(§12.5)全绿,不代表以上三类问题已经被覆盖到**——§12.5 的 84 文件复现全程是**处女库**(见 §12.5 表格),从未叠加 634 行这种超限体量;这三类问题只在体量超过 500 上限时才会现出原形,required lane today 不会撞到它们,不代表它们不存在。

**机械普查:real-DB lane 里每一个还会调用受影响函数(`executeApprovalTemplateGroupBackfill`/`previewApprovalTemplateGroupBackfill`/rollback)的调用点,以及它在「候选数超过 500 上限」这条轴上的状态**(§12.1 的 10 个点已修,不重复列):

| 文件 | 调用点 | 本轮状态 |
|---|---|---|
| `approval-template-groups-backfill-{preview,execute,rollback,batches-list}.db.test.ts` | 门审 E14 点名的 10 个(见 §12.1) | **已修**——加 sink + 两处新增断言;E14 复现 45/45 绿 |
| `approval-template-groups-backfill-batches-list.db.test.ts` | `:267` 起(本轮改动前 `:229`),cross-org HTTP isolation 用例 | **未修,假绿**——不断言 `execRes.status`,超限时 `execBody.batchId` 为 `undefined` 仍能通过断言(见上文) |
| `approval-template-groups-serialization.db.test.ts` | `:487`/`:646`/`:685`/`:707` | **未修,超限时真红**——3/4 处已亲测(见上文);`:487`(其余 3 处共享的辅助调用点之一,已在 3 条失败里覆盖)不再单独复测 |
| `approval-template-groups-lifecycle.db.test.ts` | 无 | 结构上不在暴露面——`grep -ci "backfill\|previewApprovalTemplateGroupBackfill\|executeApprovalTemplateGroupBackfill"` = 0 |
| `approval-template-groups-backfill-schema.db.test.ts` | 无 | 结构上不在暴露面——DDL/约束级断言,零 `execute`/`preview`/`rollback` 调用 |

关闭以上「未修」两行是**独立于本轮**的决定,不在本次派工范围内;本轮的职责边界是 P2-1 点名的 10 个调用点,已经全部关闭并复核(§12.1)。

**未做、也未被授权做**:合并、undraft、开/改 PR、把迁移应用到任何共享/staging/prod 库、改锁文、改任何产线代码;`serialization` 与 `batches-list` cross-org 用例的这两类已知暴露面本轮**同样未修**(见 §12.7),留给 owner/后续 lane。

---

## 14. down() 数据保留守卫 —— 候选验证(2026-09-21,回应审阅意见 C-1/A-3 附条件)

配对设计 MD §23。**起点**:`origin/feat/approval-template-groups-phase2-backfill @ 866b0d63e542a6fbefae2b659902f5007fd1a1a9`(worktree,detached HEAD,本节记账时尚未提交本节改动)。**私有库**:`metasheet2_a3down_20260921`,owner `ms2testbed`(非超级用户,`Create DB` 权限,无 Superuser),本次会话用 `dropdb --if-exists && createdb` 起手的处女库,用完 `dropdb`(见收尾)。**产线代码改动范围**:仅 `packages/core-backend/src/db/migrations/zzzz20260919090000_create_approval_template_group_backfill_batches.ts` 一个文件(`up()` 零字节改动,`down()` 由 4 行扩为 56 行,见设计 MD §23.2)。

**方法论(为什么不只用 CLI `--rollback`)**:Kysely 的 `Migrator.#runMigrations` 在 Postgres 适配器上默认把整次 `migrateDown()` 包进**一个事务**(`node_modules/kysely@0.28.8/.../migrator.js:427-431`:`if (adapter.supportsTransactionalDdl && !this.#props.disableTransactions) return this.#props.db.transaction().execute(run)`)——只观察"CLI 退出码 + 最终库状态",分不清"守卫在任何 DROP 之前就抛错"与"DROP 先跑了、随后事务被回滚撤销"这两种机制是否同一件事。四个用例因此**直接 `import { up, down }` 调用**该迁移文件的导出函数(绕过 Migrator 与它的事务包裹),在每一步之前/之后都现场 `SELECT to_regclass(...)` + `count(*)` 取快照,这样"守卫先于任何写语句执行"是被断言直接观测到的,不是推断的。CLI 级路径作为**补充证据**在 §14.4 单独记录,层级更弱,已如实标注。

### 14.1 建库 + 迁移到最新(含本迁移原样应用一次,确认候选改动不破坏 up())

```
$ psql -U ms2testbed -d postgres -c "DROP DATABASE IF EXISTS metasheet2_a3down_20260921"
$ psql -U ms2testbed -d postgres -c "CREATE DATABASE metasheet2_a3down_20260921"
$ DATABASE_URL=postgresql://ms2testbed@localhost:5432/metasheet2_a3down_20260921 \
    npx tsx src/db/migrate.ts --latest
...
migration "zzzz20260919090000_create_approval_template_group_backfill_batches" was executed successfully
migration "zzzz20260919120000_add_attachment_blob_purge_claim" was executed successfully
migration "zzzz20260919130000_extend_archive_nonce_object_identity" was executed successfully
$ echo $?
0
```

413 个迁移全部成功,末尾三条与声明 §0"排序位置"一节描述的顺序逐字一致(本迁移之后还有两条无关迁移,这是设计 MD §23.6 第一条求值的前提)。

### 14.2 四个用例(直接 `import { up, down }` 调用,`.probe-scratch/a3down-probe.ts`,**运行后已删除,不提交**)

脚本结构:每一步之后对三张表各做一次 `to_regclass('public.<table>') IS NOT NULL`(存在性)+ 存在时 `count(*)`(行数),打印 JSON 快照;每条断言显式核对"这一步之前/之后该核对什么",不是只看最终态。

```
$ DATABASE_URL=postgresql://ms2testbed@localhost:5432/metasheet2_a3down_20260921 \
    npx tsx .probe-scratch/a3down-probe.ts
```

| 用例 | 前置条件(现场快照) | 动作 | 断言 | 结果 |
|---|---|---|---|---|
| **用例 0 —— up 幂等** | 三张表已存在(§14.1 的 `--latest`),全部 0 行 | 直接调用 `up(db)` 第二次 | 不抛错;三张表调用后仍存在 | **PASS**(`IF NOT EXISTS` 生效,无副作用) |
| **用例 1 —— 空表 down 通过** | 三张表存在,`{batches:0, groups:0, links:0}` | 直接调用 `down(db)` | 不抛错;调用后三张表 `to_regclass` 均为 `NULL`(真的被 DROP,不是"没抛错但也没做事") | **PASS** |
| (重建,供用例 2/3 使用) | — | 直接调用 `up(db)`(`down()` 之后的第二次 up,兼验证"down 之后 up 仍能干净重建"这条附加的幂等角度) | 三张表存在,0 行 | **PASS** |
| **用例 2 —— 有数据 down 拒绝(负控)** | `INSERT INTO approval_template_group_backfill_batches (id, org_id, created_by) VALUES ('atgbb_probe_1','probe-org','probe-actor')` 之后,`{batches:1, groups:0, links:0}` | 直接调用 `down(db)`,**不设** force 环境变量 | ①抛错;②错误信息同时包含 `ATG_BACKFILL_DOWN_BLOCKED` 与 `ALLOW_APPROVAL_TEMPLATE_GROUP_BACKFILL_DROP`(点名代码 + 变量名,不是裸信息);③调用后三张表 `to_regclass` 均非空(表**没有**被 DROP);④调用后三张表行数与调用前逐字节相同(`batches=1, groups=0, links=0`,前后一致) | **PASS ×4**(见下方原始输出) |
| **用例 3 —— force 后通过(正控)** | 与用例 2 **同一份**未清理的数据夹具(`batches=1` 仍在) | `process.env.ALLOW_APPROVAL_TEMPLATE_GROUP_BACKFILL_DROP='true'` 后再次调用 `down(db)` | ①不抛错;②三张表 `to_regclass` 均变为 `NULL`(真的被 DROP) | **PASS ×2**——**这是正控,不是第四个负面用例**:它证明用例 2 的拒绝是**这个守卫**造成的,不是别的原因(比如连接权限、表被外部锁住)恰好也会让 down 失败;同一份数据、同一次调用,只翻一个环境变量,结果从"拒绝且三表原样保留"变成"通过且三表被丢弃",两次之间除了这个变量没有变化任何前提 |

原始输出(节选,`PASS`/`FAIL` 由脚本内 `assert()` 打印,全部 12 条断言输出 `PASS`,0 条 `FAIL`):

```
=== Case 2: down() with DATA PRESENT must REJECT (and leave tables/rows untouched) ===
[snapshot before data-present down()] {"approval_template_group_backfill_batches":{"exists":true,"count":1},"approval_template_group_backfill_batch_groups":{"exists":true,"count":0},"approval_template_group_backfill_batch_links":{"exists":true,"count":0}}
PASS: Case 2 precondition: exactly one row in batches, zero in the two detail tables
[snapshot after rejected down()] {"approval_template_group_backfill_batches":{"exists":true,"count":1},"approval_template_group_backfill_batch_groups":{"exists":true,"count":0},"approval_template_group_backfill_batch_links":{"exists":true,"count":0}}
PASS: Case 2: down() threw when data was present
PASS: Case 2: error message names the block code and the force env var
PASS: Case 2: all three tables SURVIVE the rejected down() (not dropped)
PASS: Case 2: row counts are byte-identical before vs after the rejected down() (batches=1, groups=0, links=0 both times)

=== Case 3 (positive control): same fixture, FORCE env set -> down() must PASS and actually drop ===
[snapshot after forced down()] {"approval_template_group_backfill_batches":{"exists":false,"count":-1},"approval_template_group_backfill_batch_groups":{"exists":false,"count":-1},"approval_template_group_backfill_batch_links":{"exists":false,"count":-1}}
PASS: Case 3 (positive control): down() did NOT throw once the force env var was set, same data fixture as Case 2
PASS: Case 3 (positive control): all three tables ARE dropped under force -- proves the guard (not something else) blocked Case 2

ALL ASSERTIONS PASSED
```

（`count:-1` 是脚本自己的哨兵值,表示"表不存在,不去 `count(*)`",不是真实行数。）

脚本收尾又调用一次 `up(db)` 把三张表重建为空表,使库回到"迁移已应用、表为空"的常规形状,供 §14.3 的回归套件直接复用同一个库。

### 14.3 回归:`tsc` + 既有 7 文件套件(证明 up() 与其余端点零行为变化)

```
$ cd packages/core-backend && npx tsc --noEmit
$ echo $?
0
```

```
$ DATABASE_URL=postgresql://ms2testbed@localhost:5432/metasheet2_a3down_20260921 EXPECT_DB=1 \
  npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-lifecycle.db.test.ts \
    tests/integration/approval-template-groups-serialization.db.test.ts \
    tests/integration/approval-template-groups-backfill-schema.db.test.ts \
    tests/integration/approval-template-groups-backfill-preview.db.test.ts \
    tests/integration/approval-template-groups-backfill-execute.db.test.ts \
    tests/integration/approval-template-groups-backfill-rollback.db.test.ts \
    tests/integration/approval-template-groups-backfill-batches-list.db.test.ts \
    --reporter=dot
...
 Test Files  7 passed (7)
      Tests  86 passed (86)
```

`Test Files 7 passed (7)` / `Tests 86 passed (86)` —— 与 §10.5/§12.5/§13.4 三处记录的既有基线数字**逐字相同**,证明本次改动(仅 `down()`)对 `up()`、preview/execute/rollback/batches-list 四个端点、lifecycle/serialization 两个 A-1 既有文件**零行为变化**。

**本轮未做、如实说明为什么**:未重跑 84 文件 required real-DB 步骤整份——本次改动范围是一个此前**从未被任何生产路径调用过**的函数(`down()` 在声明 §1.5/§1.7/`migrate.ts --rollback`/`--reset` 之外没有生产调用点,84 文件 required 套件本身也不调用它),84 文件全量回归对`down()`这条改动没有增量判别力,§12.5/§13.4 已经在更早的步骤里把它跑过。全量无库套件(`pnpm --filter @metasheet/core-backend test`)同理未重跑。

### 14.4 补充证据(较弱,标注清楚):CLI `--rollback` 路径 + 一个意外发现

在 §14.2 之外,本节额外尝试了"像运维一样,用 CLI 把这三张表连着后面两条无关迁移一起回退"这条路径,对照声明 §4.2 R6("一旦应用,要回退这三张表,必须先回退两条与分组功能完全无关的迁移")。结果:

```
$ npx tsx src/db/migrate.ts --rollback   # 回退 zzzz20260919130000_extend_archive_nonce_object_identity
migration "zzzz20260919130000_extend_archive_nonce_object_identity" was executed successfully
$ npx tsx src/db/migrate.ts --rollback   # 尝试回退 zzzz20260919120000_add_attachment_blob_purge_claim
failed to execute migration "zzzz20260919120000_add_attachment_blob_purge_claim"
failed to roll back
Error: calling the transaction method for a Transaction is not supported
    at Object.down (.../src/db/migrations/zzzz20260919120000_add_attachment_blob_purge_claim.ts:17:12)
```

**这不是本节引入的缺陷**:`zzzz20260919120000_add_attachment_blob_purge_claim.ts` 本次会话零字节改动,`git diff` 不含这个文件。它的 `down()` 自己在 Migrator 已经开起的事务连接上又调用一次 `.transaction()`,被 Kysely 拒绝——一个与本节 A-3 守卫完全无关的既有 bug,**恰好**挡在"CLI 链式回退到本迁移"这条路径的中间一步,使得声明 §4.2 R6 描述的运维耦合在当前 head 上**比原文更严重**:不仅要先回退两条无关迁移,其中一条现在**回退不了**(通过 CLI)。已如实记入设计 MD §23.6 第三条,**本节不修复它**——超出本次派工范围(只点名 A-3 的 `down()` 守卫),修复该文件需要独立评估。

**恢复**:`npx tsx src/db/migrate.ts --latest` 把两条无关迁移重新应用回去,`--list` 确认 `Applied: 413 / Pending: 0`,`psql` 确认三张批次表回到 0 行——库恢复到 §14.1 结束时的形状,供后续步骤(如果有)继续使用,或直接进入收尾。

**层级声明**:这条补充证据只走到"CLI 链式回退卡在无关迁移"这一步,**没有**走到"CLI 层面亲测本节守卫拒绝/放行"——§14.2 的直接调用已经在更强的判别力下(绕开事务包裹、逐步快照)覆盖了这一点,§14.4 不重复也不能替代 §14.2 的结论,只作为运维路径现实性的独立佐证登记。

### 14.5 收尾

```
$ dropdb -U ms2testbed metasheet2_a3down_20260921
$ psql -U ms2testbed -d postgres -lqt | cut -d'|' -f1 | grep -c metasheet2_a3down_20260921
0
```

`.probe-scratch/a3down-probe.ts` 已在写作本节前删除(`git status --short` 只剩 3 个文件的合法编辑:本迁移 + 设计 MD §23 + 本节)。**未做**:合并、undraft、开/改 PR、把迁移应用到任何共享/staging/prod 库、改锁文正文、改 `plugin-tests.yml`/`vitest.config.ts`/s6a 钉。

---

## 14.6 修复轮 1(2026-09-21,回应独立门审 `impl-gate-A3-guarded-down-round1-20260921.md`,裁定 0 P1 / 2 P2 / 5 P3 / 2 NIT)

**范围声明**:本轮只处置该门审报告点名的 2 P2 + 5 P3 + 2 NIT,均为**候选**改动,不构成 ratify/合并/应用。一次性 worktree(detached @ `59b5cd7ee18ad8adb6b34e65af1c77e6dd204144`,该门审 verdict 绑定的 head,逐字匹配),node_modules 软链;私有处女库 `metasheet2_a3r2_20260921`,owner `ms2testbed`(非超级,仅 `Create DB`),`psql -Atc "select current_database(), current_user"` 逐次核过;收尾 `dropdb`。未合并、未 undraft、未开/改 PR、未改锁文正文。

### 14.6.1 P2-1 —— 新增真库用例(守卫此前零测试覆盖)

新文件 `packages/core-backend/tests/integration/approval-template-groups-backfill-down-guard.db.test.ts`(259 行,8 例),形状照兄弟先例 `attendance-w4c0-durable-storage-smoke.db.test.ts:6,22-23`(直接 `import { up, down }`,不经 Migrator 事务包裹):

| 用例 | 覆盖点 |
|---|---|
| `up() is idempotent before this file touches anything` | 基线 |
| `down() fail-closes BEFORE DDL while all three tables hold a row each…` | 三表各一行 → 拒绝;`Promise.all` 快照 `toEqual` 逐字节核对拒绝前后三表 exists+count 完全相同 |
| `down() with the force env set passes and ACTUALLY drops all three tables` | 同一夹具,force 正控 |
| `down() on fully-missing tables does not crash with 42P01` | **P2-2 回归**:三表全缺 |
| `down() on empty (present, zero-row) tables passes and drops them` | 空表通过 |
| `half-applied state (only the head table exists) WITH a row still fail-closes…` | **P2-2 回归第二种形状**:手工 `DROP` 掉两张子表模拟半应用,头表 1 行 → 仍拒绝,`ATG_BACKFILL_DOWN_BLOCKED`,断言消息**不**含 `42P01` |
| `up() remains idempotent after this file's DDL churn…` | 收尾重建,二次 `up()` |

```
$ DATABASE_URL=postgresql://ms2testbed@localhost:5432/metasheet2_a3r2_20260921 EXPECT_DB=1 \
  npx vitest --config vitest.integration.config.ts run tests/integration/approval-template-groups-backfill-down-guard.db.test.ts --reporter=dot
 Test Files  1 passed (1)
      Tests  8 passed (8)
```

**Mutation(整段删除 `down()` 里 :170-191 的 `if (total > 0) { … }` 守卫块,`cp` 备份 → 编辑 → 跑 → `cp` 还原 → `cmp` 逐字节核)**:

```
$ cp <migration> /tmp/a3r2-mig.ts.bak   # 备份
# 删除守卫块后重跑同一文件:
 × down() fail-closes BEFORE DDL while all three tables hold a row each…   → promise resolved "undefined" instead of rejecting
 × down() with the force env set passes and ACTUALLY drops all three tables → expected -1 to be greater than 0
 × half-applied state … still fail-closes …                                → expected undefined to be an instance of Error
 × up() remains idempotent after this file's DDL churn…                    → relation "…backfill_batches" does not exist (级联:前面用例把表丢了)
 Test Files  1 failed (1)
      Tests  4 failed | 4 passed (8)
$ cp /tmp/a3r2-mig.ts.bak <migration>
$ cmp /tmp/a3r2-mig.ts.bak <migration>   # 零输出,字节相同
```
4/8 变红(其中 1 条是前序失败留下脏状态的级联,不是独立判别点;直接判别的是前 3 条),证明该守卫此前"零测试覆盖"的缺口已被这份新文件堵上。还原后重跑(先 `--latest` 重建被前一次探针丢弃的表)回到 `8 passed (8)`。

**第二次 mutation(只还原 P2-2 那段——`atgBackfillTableRowCount` 改回单语句 CASE 形式,守卫 if 块本身不动,`cp`/`cmp` 同法),专门核两条 42P01 回归用例是否 load-bearing(不是自证)**:
```
# 把 helper 体换回:
#   SELECT CASE WHEN to_regclass(...) IS NULL THEN 0 ELSE (SELECT count(*) FROM t) END AS n
$ npx tsx src/db/migrate.ts --latest   # 先重建三表,拿到干净基线
$ DATABASE_URL=… EXPECT_DB=1 npx vitest --config vitest.integration.config.ts run tests/integration/approval-template-groups-backfill-down-guard.db.test.ts --reporter=verbose
 ✓ up() is idempotent before this file touches anything
 ✓ down() fail-closes BEFORE DDL while all three tables hold a row each…
 ✓ down() with the force env set passes and ACTUALLY drops all three tables
 × down() on fully-missing tables does not crash with 42P01 …           → promise rejected "error: relation … does not exist" instead of resolving
 ✓ down() on empty (present, zero-row) tables passes and drops them
 × half-applied state … still fail-closes … not 42P01 …                 → expected 'relation "…batch_groups" does not exist' to match /ATG_BACKFILL_DOWN_BLOCKED/
 Test Files  1 failed (1)
      Tests  2 failed | 6 passed (8)
$ cp /tmp/a3r2-mig-p2.ts.bak <migration>
$ cmp /tmp/a3r2-mig-p2.ts.bak <migration>   # 零输出,字节相同
```
**恰好、只有**这两条 P2-2 回归用例变红,且红的原因逐字就是"relation … does not exist"(42P01 的具体表现),其余 6 条(含守卫本身的拒绝/force/空表/up 幂等)完全不受影响——证明这两条用例的判别力落在 P2-2 这个具体修复点上,不是vacuous(记忆 `feedback_prove_a_fix_by_running_the_old_implementation`/`feedback_ineffective_mutation_looks_like_a_useless_test`)。还原后重跑(先 `--latest` 重建)回到 `8 passed (8)`。

**收尾修复(自查发现,非门审报告点名项)**:`down() with the force env set …` 用例最初把 `orgTags.length = 0` 也清空了,但该用例只 DROP 了三张**批次**表,fixture 建在 phase-1 的 `approval_template_groups`/`approval_template_group_links`(独立的表,未被 DROP)上的行仍然存在——清空 `orgTags` 会让 `afterAll` 找不到这两行去删,造成每次跑这条用例都在共享库里泄漏一个组。已改为只清 `batchIds`(该表已不存在,没有行可删),保留 `orgTags`/`templateIds` 交给 `afterAll` 正常清理;`psql` 核对修复后再跑一次不再新增 `approval_template_groups` 残留行(修复前的历史残留行——本会话早前几次手工探针/测试迭代留下的——随处女库整体 `dropdb` 一并清除,不需要单独回收)。

**部署范围(与硬约束"s6a/plugin-tests 字节不变"对齐,候选阶段刻意延后)**:本文件**未**加入 `vitest.config.ts` 的 no-DB exclude 名单,**未**加入 `.github/workflows/plugin-tests.yml` 的 `approval-real-db-integration` 白名单,**未**新增 `*-ci-wiring.test.mjs` 守卫,**未**重算 s6a 钉——`shasum -a 256 .github/workflows/plugin-tests.yml` 与 `git diff --quiet` 核对该三个文件本轮字节不变。该文件靠自身的 `describeIfDatabase`/`itIfExpectDb` 哨兵在无 `DATABASE_URL` 时整体跳过,不影响无库 `pnpm test` 的结果(与仓内其余 `.db.test.ts` 文件同一行为)。两点接线 + census 三件套的正式落地,按门审报告 P2-1"修法"段自己的建议,留给真正提议合并这条守卫的那一轮一次性做完,避免本轮与合并轮各钉一次 s6a。

### 14.6.2 P2-2 —— `to_regclass` 守卫改为两语句结构

`packages/core-backend/src/db/migrations/zzzz20260919090000_create_approval_template_group_backfill_batches.ts:156-162`(`atgBackfillTableRowCount`)由单条 `CASE WHEN to_regclass(...) IS NULL THEN 0 ELSE (SELECT count(*) …) END` 改为两条独立语句(先 `SELECT to_regclass(...) IS NOT NULL AS e`,只有为真才发第二条 `count(*)`),逐字采用门审报告 §3 P2-2"修法"段给出的实现;`:117-153` 的注释同步改写(不再声称 CASE 形式"不炸 42P01",改为解释 Postgres parse-time 解析问题与两语句修法)。设计 MD 同步:`docs/development/approval-template-groups-phase2-backfill-design-20260918.md` §23.2 追加一段"订正"(2026-09-21),不改写原历史代码块引文,只对 :1068 那句已被证伪的断言求值 + 给出订正后的代码。

真库回归(本轮独立复现,`.probe-scratch` 探针,写作前已删除):

```
=== Case A: all three tables MISSING -> down() must NOT throw 42P01 ===
PASS: Case A: down() on fully-missing tables did not throw
=== Case B: half-applied (only head table present, WITH a row) -> down() must reject with ATG_BACKFILL_DOWN_BLOCKED, not 42P01 ===
PASS: Case B: down() threw
PASS: Case B: error is ATG_BACKFILL_DOWN_BLOCKED, not 42P01
PASS: Case B: error message does NOT mention 42P01
PASS: Case B: head table SURVIVES the rejected down()
```
与门审报告 E12/E13 的复现方法一致(对缺表直接执行该 helper 发出的原句 SQL / 端到端调用 `down()`),结论相反——门审 E12/E13 复现的是**改动前**的 CASE 形式(证伪);上面是**改动后**的两语句形式(证实)。同一场景在永久测试文件里以 `down() on fully-missing tables does not crash with 42P01` 与 `half-applied state … not 42P01` 两条用例常驻(§14.6.1),不再依赖一次性探针。

### 14.6.3 P3-1 —— force 变量:登记 `--help` + 加宽范围书面化 + `console.warn`

- `packages/core-backend/src/db/migrate.ts` 的 `printHelp()`(Notes 段)新增一条,点名 `ALLOW_APPROVAL_TEMPLATE_GROUP_BACKFILL_DROP` 这个具体例子,说明它在迁移文件内部读取(不是 CLI 边界),`--rollback`/`--reset` 本身不读它。`npx tsx src/db/migrate.ts --help` 现场核对输出逐字包含新增段落(见上方终端记录)。
- 迁移文件 `down()` 前的注释块新增"Scope note"(:135-140),书面记录这个变量相对 `ALLOW_DB_RESET` 先例是一处加宽(CLI 边界 vs 迁移文件内部),不假装对齐。
- `down()` 新增 `console.warn`(:185-190),force 分支生效时打印变量名 + 三个计数。真库验证(§14.6.4 的 Migrator 正控)现场核对该行确实打印到 stderr。

### 14.6.4 P3-2 —— 通过唯一生产调用方(Migrator/`--rollback`)实测,而非只靠直接 `import` 调用

方法:在处女库上手工从 `kysely_migration` 删除本迁移之后的两条迁移行(`zzzz20260919120000_add_attachment_blob_purge_claim`、`zzzz20260919130000_extend_archive_nonce_object_identity`),让本迁移成为 Migrator 视角下的"最新",与门审报告 E5/E6 使用的方法相同(§14.4 已如实记录这个必要性)。

**负控(不设 force)**:
```
$ psql … INSERT INTO approval_template_group_backfill_batches (id, org_id, created_by) VALUES ('atgbb_cli_probe_1', …)
$ npx tsx src/db/migrate.ts --rollback
failed to execute migration "zzzz20260919090000_create_approval_template_group_backfill_batches"
Error: ATG_BACKFILL_DOWN_BLOCKED: …
EXIT=1
```
之后 `to_regclass` 非空、`count=1`、`kysely_migration` 该行仍在 —— 与门审 E5 一致。

**正控(force=true)**:
```
$ ALLOW_APPROVAL_TEMPLATE_GROUP_BACKFILL_DROP=true npx tsx src/db/migrate.ts --rollback
ALLOW_APPROVAL_TEMPLATE_GROUP_BACKFILL_DROP=true — forcing the drop of … (batches=1, batch_groups=0, batch_links=0). …
migration "zzzz20260919090000_create_approval_template_group_backfill_batches" was executed successfully
EXIT=0
```
之后 `to_regclass` 为空、`kysely_migration` 该行计数 0、`--list` 显示 `Applied: 410`——与门审 E6 一致,并额外验证了 P3-1 新增的 `console.warn` 确实在 Migrator 调用路径下打印。随后 `npx tsx src/db/migrate.ts --latest` 把三条迁移重新应用,库回到 413/0。

**披露(与门审 P3-5 同一发现,只登记不改该文件)**:上面两步都依赖手工编辑 `kysely_migration` 让本迁移"可达"——真实的、未经手工干预的 `--rollback` CLI 链路会先撞上 `zzzz20260919120000_add_attachment_blob_purge_claim.ts:17`(在 Migrator 已开启的事务连接上又调用 `.transaction()`,被 Kysely 拒绝)。本轮独立复现:
```
$ npx tsx src/db/migrate.ts --rollback   # 撤 extend_archive_nonce_object_identity,成功
$ npx tsx src/db/migrate.ts --rollback   # 尝试撤 add_attachment_blob_purge_claim
Error: calling the transaction method for a Transaction is not supported
    at Object.down (…/add_attachment_blob_purge_claim.ts:17:12)
```
本轮**零字节改动**该文件,按派工"只登记,不改该文件"处置;修复留给 owner 排期。

### 14.6.5 P3-3 —— `--reset` 实际后果按实测改写

复现门审 E7 的构造(本迁移经手工编辑 `kysely_migration` 成为"最新",批次头 1 行,不设 force):
```
$ ALLOW_DB_RESET=true npx tsx src/db/migrate.ts --reset
Error: ATG_BACKFILL_DOWN_BLOCKED: …
EXIT=1
$ npx tsx src/db/migrate.ts --list
Applied: 411    # --reset 前后不变(本轮独立复现的库上,前置状态是 411 applied / 2 pending)
```
`Applied` 计数在这次 `--reset` 前后**逐字不变**,与门审 E7(该门审环境里同样是 411)独立吻合——确认"整次 `--reset` 事务性中止,零迁移回退",不是"退到这一步停下"。设计 MD §23.6 已追加订正段(不改写原句,标记它被证伪的那一半失效,结论句本身仍 OPERATIVE),把这条实测结果写成书面记录。

### 14.6.6 P3-4 —— 修正迁移 `:117` 的悬空路径引用

原文引用 `reviews/approval-template-groups-phase2-backfill-ddl-declaration-20260920.md`,仓内无 `reviews/` 目录(该文件在私有 `~/.claude/projects/…/reviews/`)。已改为"private review record …(not in this repo; it lives in the reviewer's private review-notes tree, not under a repo `reviews/` directory)",不再给出一个仓内解析不到的相对路径。

### 14.6.7 P3-5 —— 既有缺陷,登记不修

`zzzz20260919120000_add_attachment_blob_purge_claim.ts:17` 的既有 bug(见 §14.6.4 复现)——本轮零字节改动该文件,按派工原文"只登记,不改该文件"处置,与门审报告的处置意见(独立复现、判定同意、建议单独排期)一致。

### 14.6.8 NIT-1 / NIT-2

- **NIT-1**(`count(*)` 全表扫描 vs `EXISTS`):按门审报告原话"不改也行"——本轮**未改**,接受现状(错误信息里的精确计数对运维有价值)。
- **NIT-2**(`scripts/dev-bootstrap.sh:283/372`"重置数据库: pnpm db:reset"文案):两处各追加一行,提示本地库若跑过 backfill 真库用例,`db:reset` 可能撞上 `ATG_BACKFILL_DOWN_BLOCKED`。

### 14.6.9 回归证据(处女库 `metasheet2_a3r2_20260921`)

```
$ cd packages/core-backend && npx tsc --noEmit
exit 0
$ DATABASE_URL=postgresql://ms2testbed@localhost:5432/metasheet2_a3r2_20260921 EXPECT_DB=1 \
  npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-template-groups-lifecycle.db.test.ts \
    tests/integration/approval-template-groups-serialization.db.test.ts \
    tests/integration/approval-template-groups-backfill-schema.db.test.ts \
    tests/integration/approval-template-groups-backfill-preview.db.test.ts \
    tests/integration/approval-template-groups-backfill-execute.db.test.ts \
    tests/integration/approval-template-groups-backfill-rollback.db.test.ts \
    tests/integration/approval-template-groups-backfill-batches-list.db.test.ts \
    tests/integration/approval-template-groups-backfill-down-guard.db.test.ts \
    --reporter=dot
 Test Files  8 passed (8)
      Tests  94 passed (94)
```
86(既有 7 文件)+ 8(新文件)= 94,逐位相加一致——既有 7 文件套件在新守卫代码 + 新测试文件并存下**零回归**。`shasum -a 256 .github/workflows/plugin-tests.yml`、`git diff --quiet` 对 `plugin-tests.yml`/`vitest.config.ts`/`vitest.integration.config.ts` 三文件核对**字节不变**;`node --test plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs` 绿(s6a provenance 未失配)。

**无库三件套(闭世界普查 + 全量真库 CI-wiring + 全量无库套件,证明新文件加入后这三条 required 通道不变红)**——本轮加新文件前**未**过一遍这三条,advisor 复核时点出;当场补跑,发现第一条确实红,已处置(见下一段):
```
$ unset DATABASE_URL && npx vitest run tests/unit/approval-ci-coverage-enumeration.test.ts
 × T3 — …: is wired: …/approval-template-groups-backfill-down-guard.db.test.ts
   Error: … UNCOVERED — NOT excluded from the no-DB job, but describeIfDatabase-gated with no
   real-DB lane wiring — it will skip-green forever in the required test job and never run for real
 Test Files  1 failed (1)
      Tests  1 failed | 350 passed (351)
```
新文件确实撞上了这条闭世界普查(它要求每个 `tests/integration/approval-*` 文件要么被 no-DB exclude 名单排除且接进某条真库 lane,要么明确豁免——单纯"不排除 + DB-gated + 零 lane 接线"判 UNCOVERED)。**没有**通过改 `vitest.config.ts`/`plugin-tests.yml`(会违反本轮硬约束"s6a/plugin-tests 字节不变")解决,而是用该守卫自带的、专为"刻意暂不接线"场景设计的显式登记机制——`packages/core-backend/tests/unit/approval-ci-coverage-allowlist.ts`(一个 typed const 数组,不是 JSON/YAML,不被 s6a 或 `plugin-tests.yml` 引用)——新增一条 `{file, why, date}` 登记,`why` 点名本轮的硬约束与"两点接线随合并轮一次做完"的既定安排。补登记后三件套全绿:
```
$ unset DATABASE_URL && npx vitest run tests/unit/approval-ci-coverage-enumeration.test.ts
 Test Files  1 passed (1)
      Tests  353 passed (353)
$ node --test scripts/ops/*-ci-wiring.test.mjs        # 仓根运行(不是 core-backend 内)
 tests 492
 pass 492
$ env -u DATABASE_URL CI=true pnpm --filter @metasheet/core-backend test
 Test Files  948 passed | 176 skipped (1124)
      Tests  15103 passed | 1617 skipped (16720)
```
第二、三条数字与门审报告 §2.4/§2.3 记录的历史基线(491/491、931 passed|175 skipped)不逐字相同——head 在这两点之间已前进了大量与本轮无关的提交(新增测试文件/套件),0 fail 才是承重的判据,不是绝对数字对齐。

**本轮代码侧 diff 范围**(`git diff --stat`,不含本文档与配对设计 MD 自身的追加——两份 MD 的插入行数在本节撰写期间持续变动,不适合钉一个数字):
```
 packages/core-backend/src/db/migrate.ts                                    |  11 +-
 …zzzz20260919090000_create_approval_template_group_backfill_batches.ts     |  60 +++--
 packages/core-backend/tests/unit/approval-ci-coverage-allowlist.ts         |  17 ++
 scripts/dev-bootstrap.sh                                                   |   4 +
 4 files changed, 74 insertions(+), 18 deletions(-)
 + 1 new file: packages/core-backend/tests/integration/approval-template-groups-backfill-down-guard.db.test.ts(259 行,8 例,含 orgTags 清理修复)
```
两份 `.md`(本文档 + 配对设计 MD)按 §14.6.1–§14.6.8、§23.2/§23.6/§23.7 各节的追加内容单独计入,不重复列在这张代码侧表里。

### 14.6.10 收尾

```
$ dropdb -U ms2testbed metasheet2_a3r2_20260921
```
未合并、未 undraft、未开/改 PR、未把迁移应用到任何共享/staging/prod 库、未改锁文正文。一切仍是候选,供下一轮门审核对。

## 14.7 修复轮 2(2026-09-21,回应独立门审 `impl-gate-A3-guarded-down-round2-20260921.md`,裁定 0 P1 / 2 P2 / 3 P3 / 3 NIT)

处女库 `metasheet2_a3r3_20260921`,owner `ms2testbed`(非超级),本机 **PostgreSQL 15.17**(与门审报告的生产轴一致)。连接串普查(本轮亲跑,不沿用上一轮数字):`grep -ohE "[A-Z0-9_]+_URL" .github/workflows/*.yml` + 根/`packages/core-backend` 两个 `package.json` + `process.env.*_URL`(`packages/core-backend/{src,tests}`)合并去重后同为 **8 个** PG 连接串族名——`DATABASE_URL` / `ATTENDANCE_TEST_DATABASE_URL` / `E2E_S6A_PROVISIONING_DB_URL` / `E2E_S6A_RUNTIME_DB_URL` / `SMOKE_DATABASE_URL` / `PG_SUPERUSER_URL` / `SHARD_0_URL` / `SHARD_1_URL`;本轮只 export 了 `DATABASE_URL`,`env | grep -iE "DATABASE|PGHOST|PGDATABASE|PGUSER|PGPASSWORD|_DB_URL"` 在每次命令前核对为空(其余 7 个全程未设置)。每条命令前 `psql -Atc "select current_database(), current_user"` ⇒ `metasheet2_a3r3_20260921|ms2testbed`。

### 14.7.1 P2-A —— 补严格性用例(强制解锁只认字面 `"true"`)

在 case 2(数据齐全拒绝)与 force 正控之间插入一条新用例,循环 `['false', '0', '1', 'TRUE', 'yes', '']`,每个值都断言 `down()` 仍 reject 且头表仍在(不是"抛了就行",是"抛了且没丢数据")。**没有**放在 force 正控之后——那样会读到 force 用例已 DROP 掉的表,`toBeTruthy`/`rejects` 两端都会假红(advisor 复核指出的下线陷阱,采纳)。`""` 保留用于完整性,但不作为判别力证据——G11b(round-2 报告)已证明 `!''` 在 M3 下仍为真值,不解锁;真正判别的是 `'false'`/`'0'`/`'1'`/`'TRUE'`/`'yes'` 五个值。

Mutation(单 token,与门审报告 G11 相同的构造):
```diff
-    if (process.env[ATG_BACKFILL_DOWN_FORCE_ENV] !== 'true') {
+    if (!process.env[ATG_BACKFILL_DOWN_FORCE_ENV]) {
```
`cp` 备份 → 编辑 → 跑 → `cp` 还原 → `cmp` 逐字节核(全程未用 `git checkout --`)。红,原文逐字:
```
 ✗ only the exact string "true" unlocks the force path — "false"/"0"/"1"/"TRUE"/"yes"/"" all
   stay rejected (strictness axis; round-2 implementation-gate finding P2-A)
   AssertionError: promise resolved "undefined" instead of rejecting
   - Expected: [Error: rejected promise]
   + Received: undefined
     at tests/integration/approval-template-groups-backfill-down-guard.db.test.ts:213:44
 ✗ down() with the force env set passes and ACTUALLY drops all three tables (positive control for the case above)
   AssertionError: expected -1 to be greater than 0
 Test Files  1 failed (1)
      Tests  2 failed | 7 passed | 1 skipped (10)
```
第一条红就在循环的第一个值(`'false'`)上——具判别力的值确实触发了红,不是靠 `''` 兜底。还原后重跑同一文件:`9 passed | 1 skipped (10)`,与 mutation 前一致。

### 14.7.2 P2-B —— 两点接线 + 自身 CI-wiring 守卫 + allowlist 登记删除 + s6a 重钉(同一提交)

**vitest.config.ts**(no-DB exclude,追加在 batches-list 条目之后、`tests/e2e/**` 之前):新增 `'tests/integration/approval-template-groups-backfill-down-guard.db.test.ts'`,注释点名 P2-B 与其专属 CI-wiring 守卫。

**`.github/workflows/plugin-tests.yml`**——两处、非相邻:
1. `approval-real-db-integration` 步骤(id 不变)的 whole-file 参数列表,`…batches-list.db.test.ts \` 之后追加 `…down-guard.db.test.ts \`(diff 见下)。
2. no-DB `test` 作业里追加一条新 step——`A3 backfill-down-guard CI wiring contract`,紧跟在既有 `A3 backfill-batches-list CI wiring contract` 之后,`run: node --test scripts/ops/approval-template-groups-backfill-down-guard-ci-wiring.test.mjs`。

```diff
@@ 约 :423(no-DB test 作业,新增一条 step)
       - name: A3 backfill-batches-list CI wiring contract
         run: node --test scripts/ops/approval-template-groups-backfill-batches-list-ci-wiring.test.mjs
+
+      - name: A3 backfill-down-guard CI wiring contract
+        run: node --test scripts/ops/approval-template-groups-backfill-down-guard-ci-wiring.test.mjs
@@ 约 :1702(approval-real-db-integration 步骤,whole-file 参数列表)
             tests/integration/approval-template-groups-backfill-batches-list.db.test.ts \
+            tests/integration/approval-template-groups-backfill-down-guard.db.test.ts \
```
`git diff --stat -- .github/workflows/plugin-tests.yml` ⇒ `1 file changed, 11 insertions(+)`。

**新文件** `scripts/ops/approval-template-groups-backfill-down-guard-ci-wiring.test.mjs`——整段复制五个同族守卫里最新的一个(`…batches-list-ci-wiring.test.mjs`)再改名/改字符串(记忆 `feedback_copy_precedent_whole_block_not_item_by_item`:round-1 就是逐条转抄丢了 P2-A 那一条,这次改成整段复制),共用 `ci-realdb-step-contract.mjs` 的 `REAL_DB_STEP_IDS` / `isSuiteWiredInRealDbStep` / `isQuotedInTestExclude` / `realDbStepWholeFileArgs`,三条断言(exclude 存在、real-DB 步骤命中且不在 multitable 步骤下、文件存在于磁盘)。

**allowlist 登记删除**:`packages/core-backend/tests/unit/approval-ci-coverage-allowlist.ts` 里 2026-09-21 那条(`file: '…backfill-down-guard.db.test.ts'`)整条删除——两点接线落地后闭世界普查判它 `covered: true`,登记不再是"刻意豁免",留着会被普查自己的 `console.warn` 点名"不再需要"。

**vitest.integration.config.ts 核实**(advisor 提醒:先核实,不要假设):该文件只有一条 `include: ['tests/integration/**/*.{test,spec}.?(c|m)[jt]s?(x)']` 通配符,**没有**逐文件 include 白名单——`down-guard.db.test.ts` 早已被这条通配符匹配,不需要第三处接线;与五个同族兄弟文件的接线形状一致。

**s6a 重钉**——`node -e` 调 `computePackageProvenancePinSet(repoRoot)` 后 `JSON.stringify(…, null, 2) + '\n'` 整体写回(未手改任何十六进制值),diff:
```
$ git diff --stat -- plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json
 1 file changed, 1 insertion(+), 1 deletion(-)
```
```diff
-    "pluginTestsWorkflow": "3eff631ff2f7b69aaad12b814bb47c65fd73d6b9d9d9269e2ba9b4cbcc61f52a"
+    "pluginTestsWorkflow": "c5ec4ba6c5ad483e9d7094e9c85ad3e42eafa64ccb51fb5315188f5a1078c48b"
```
只有 `runtimeFiles.pluginTestsWorkflow` 这一个值变化——`plugin-tests.yml` 是本轮唯一改动、且被 s6a 钉住的文件;`vitest.config.ts`/allowlist/测试文件均**不在** s6a 钉集合内(核对 `PINNED_RUNTIME_FILES`/`PINNED_EVIDENCE_FILES`/`PINNED_S1..S6_MODULES`/`PINNED_MIGRATIONS`/`PINNED_EXTERNAL_MODULES` 六张表,均无这些路径)。`node --test plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs` 与 `…sealed-export-s5-public-export-surface.test.cjs` 重钉后两个都绿。

**两条反向 mutation**(advisor 指出 round-1 的 G20 只证明了"接线前"状态,round-2 必须补"接线后仍会红"的证据,证明两点接线不是装饰):
```
$ # M5: 从 plugin-tests.yml 删掉刚加的 whole-file 参数那一行,cp 备份 → 删 → 跑 → cp 还原 → cmp 核
$ node --test scripts/ops/approval-template-groups-backfill-down-guard-ci-wiring.test.mjs
 ✗ plugin-tests.yml runs the A3 backfill-down-guard suite as a whole file in the directory
   real-DB step (id: approval-real-db-integration)
   AssertionError: plugin-tests.yml real-DB step id "approval-real-db-integration" … must run
   tests/integration/approval-template-groups-backfill-down-guard.db.test.ts as a whole-file vitest arg
$ unset DATABASE_URL && npx vitest run tests/unit/approval-ci-coverage-enumeration.test.ts
 ✗ T3 … is wired: …/approval-template-groups-backfill-down-guard.db.test.ts
   Error: … UNCOVERED — excluded from the no-DB job … but NOT wired as a whole-file arg … this
   suite runs NOWHERE
# 还原(cmp 核对逐字节相同),两条守卫回绿

$ # M6: 从 vitest.config.ts 删掉刚加的 exclude 条目,cp 备份 → 删 → 跑 → cp 还原 → cmp 核
$ node --test scripts/ops/approval-template-groups-backfill-down-guard-ci-wiring.test.mjs
 ✗ vitest.config.ts excludes the A3 backfill-down-guard suite from the no-DB job
   AssertionError: vitest.config.ts must exclude … as a live (non-commented) entry
# 还原(cmp 核对逐字节相同),守卫回绿
```
两条都在**接线落地之后**的树上跑(不是 round-1 的"接线前"状态),证明这不是装饰性改动。

**给接线轮的实操提醒 1(§3 P2-B 原文:"复核相邻文件不依赖这三张表的行")——按枚举关闭,不是按推断关闭**:
```
$ git grep -l "approval_template_group_backfill" -- packages/core-backend/tests/integration/
approval-template-groups-backfill-batches-list.db.test.ts
approval-template-groups-backfill-down-guard.db.test.ts
approval-template-groups-backfill-execute.db.test.ts
approval-template-groups-backfill-preview.db.test.ts
approval-template-groups-backfill-rollback.db.test.ts
approval-template-groups-backfill-schema.db.test.ts
approval-template-groups-serialization.db.test.ts
```
`approval-real-db-integration` 步骤里跑 84+ 个文件、共享同一个 `metasheet_test`;down-guard 文件在跑的过程中会 DROP 并重建这三张表。这条 grep 枚举了**全部**引用这三张表名字面量的真库文件——结果是 7 个,**全部**是 A-3 backfill 同族兄弟(含 down-guard 自己),**没有**任何一个是这条 grep 之外的文件。7 个里的 6 个(除 down-guard 自身)已在 §14.7.7 的 8 文件回归里与 down-guard 同批次跑过并核对零残留(§14.7.7 的 `psql` 计数);第 8 个文件(`approval-template-groups-lifecycle.db.test.ts`)不在这份 grep 命中里,说明它不消费这三张表,只是延续既有约定同批次一起跑。故这条实操提醒按**枚举**(不是按抽样或推断)关闭:该步骤里不存在其它依赖这三张表却未被共同验证过的文件。

### 14.7.3 P3-a —— 10 处悬空 `reviews/` 引用改写 + 新增全分支机械扫描守卫

10 处(迁移文件 :9、`ApprovalTemplateGroupService.ts` ×3、`backfill-batches-list.db.test.ts` :20、`backfill-schema.db.test.ts` :13、`serialization.db.test.ts` ×2、`vitest.config.ts` :1837〔本轮之前冻结,现随两点接线一并解冻处理〕、`…batches-list-ci-wiring.test.mjs` :16)与迁移文件里 round-1 已修的那一行(:118,含 disclaimer 措辞本身仍带 `reviews/` 字面量)——共 11 处——全部改写为不含字面子串 `reviews/` 的措辞(形如"`<文件名>`,a private review record, not tracked in this repository"),而不是沿用 round-1 :118 的旧措辞(那句本身含 `reviews/` 三个字,advisor 指出照抄会让"零命中"守卫永远不可能通过)。改写完成、新增守卫文件之前:

```
$ git grep -n "reviews/" -- 'packages/**' 'apps/**' 'plugins/**' 'scripts/**' | grep -v '\.md:'
(空,exit 1)
```

新增守卫 `packages/core-backend/tests/unit/approval-a3-dangling-reviews-path-sweep.test.ts`(`approval-*.test.ts` 命名,进入 T4 census 人口,不进 exclude 名单,常驻 required no-DB 作业):`git ls-files -z --cached -- packages apps plugins scripts` 派生域(排除 `.md`),逐文件逐行扫描字面子串 `reviews/`(源码里拆成 `['review','s','/'].join('')` 三段拼接,避免这份守卫自己的常量声明也带着连续字面量);decoy 树正控——`withDecoyTree` 同款手法,仿 `source-files-no-raw-control-bytes.test.ts` 的既有约定,不是新发明一套机制。

**自指陷阱,现场发现现场修**:该守卫文件本身是 `.ts`、在 `packages/**` 之下,且其文档注释/常量/两条用例标题/decoy fixture 内容都**必须**把这个词当数据写出来——提交入库后它自己就落进被扫描的域,第一次跑 `git add` 之后重新执行 §14.7.7 的静态三件套时,该守卫的"全零命中"用例**真的红了**(命中自己文件里 4 行),不是假设性风险。修法**不是**把这条腿改弱(比如豁免整个文件),而是仿本仓 census 自身 §6"self-exemption closure"与 NUL 守卫`KNOWN_0X01_CARRIERS`的既有约定:显式排除**这一个**文件(`SELF_PATH`,由 `path.relative(REPO_ROOT, __filename)` 派生,不是手写字符串——文件改名不会留下失效的硬编码路径),并新增一条用例证明该排除**存在必要性**(未排除时这份文件真的会命中 >0 次)且**范围恰好是这一个文件**(排除后确实从扫描域消失)——不是"加一个豁免就完事",是把"豁免是否承重"变成可执行断言。

```
$ unset DATABASE_URL && npx vitest run tests/unit/approval-a3-dangling-reviews-path-sweep.test.ts --reporter=verbose
 ✓ the scanned domain is non-vacuous (scan negative control)
 ✓ self-exemption is exactly this one file, and is load-bearing (not vestigial)
 ✓ zero tracked non-Markdown file (other than this guard itself) under packages/**, apps/**, plugins/**, scripts/** contains the literal substring "review" + "s" + "/"
 ✓ POSITIVE CONTROL: a planted dangling-reviews-path reference reds the leg
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

**如实标注一处"表面矛盾"**:自本文件提交入库那一刻起,一条不带自指豁免的裸 `git grep -n "reviews/" -- … | grep -v '\.md:'` 会在这份守卫自己的文件里命中 4 行(文档注释里逐字讨论这个缺陷类、引用 round-1 已修那行的原文、复述门审报告用过的那条 grep 命令本身)——这**不是**回归,是这份守卫存在的前提(它必须能把这个词当数据讨论)。真正承重的判据是守卫自己的、带自指豁免的扫描逻辑(上面 4/4 绿),不是一条不知道自指豁免存在的裸 grep;下一轮如果只跑裸 grep 复核这条 P3-a,应预期在这一个文件里看到 4 行命中,那是设计如此,不是本轮遗留的缺陷。

### 14.7.4 P3-b —— 设计 MD 的手写行数括注(254 行)删除,未替换成另一个手写数字

设计 MD `:1147` 原写的"254 行"与验证 MD §14.6.1/§14.6.9 记录的 259 行不一致,门审报告 P3-b 判定前者是手写且错误的数字。本轮**不再手写任何行数**替换它——即便当场跑 `wc -l` 核对出某个数字,该数字在本轮自己的改动(P2-A/P3-c 又给这份文件新增了两条用例)落地后就已经过期,写下去只是制造下一次"手写数字漂移"。按 `feedback_record_fix_rounds_only_delete_never_handwrite_numbers`:**删除**括注,不写任何新数字(包括不重新验证并写回 259 或任何其它值)。设计 MD 同一处追加一段"求值"记录这一删除动作本身(见 §14.7 引言前的设计 MD 改动——本文档不重复设计 MD 原文,只记入本轮 diff 范围)。

### 14.7.5 P3-c —— `not.toMatch(/42P01/)` 空转断言改为对 `err.code` 的正面否定,配同客户端正控;如实标注非独立承重

半应用用例(`:213` 起)把
```diff
-        expect((caught as Error).message).not.toMatch(/42P01/)
+        expect((caught as { code?: string } | undefined)?.code).not.toBe('42P01')
```
并在其后新增一条独立用例(POSITIVE CONTROL),用**同一个** `migrationDb` Kysely 客户端(不是 `src/db/pg` 的 `query()`——advisor 指出用不同客户端做正控会留一个可被下一轮门审点名的缺口)对一张确实不存在的表跑 `sql\`SELECT count(*) FROM …\`.execute(migrationDb!)`,断言 `.code === '42P01'` 且 `.message` 不含 `42P01`:
```
$ DATABASE_URL=… npx vitest --config vitest.integration.config.ts run …down-guard.db.test.ts --reporter=verbose
 ✓ POSITIVE CONTROL for the .code assertion above: a genuinely-missing relation really does
   surface SQLSTATE 42P01 in err.code (same Kysely client), never in err.message
```
**如实标注,不过度声称**:半应用用例里 `.code` 断言在**当前**代码路径下不是独立承重——`:238` 的 `toMatch(/ATG_BACKFILL_DOWN_BLOCKED/)` 先于它断言,M2 mutation(CASE 单语句形式还原)下 `:238` 先抛错误消息不含该 token 而红,`.code` 那一行根本执行不到。本轮的修法只解决"这条断言曾经永远不可能失败(空转)"这一半问题(P3-c 原始点名的缺陷),把它换成一条**能够**失败的断言,并用正控证明其字段选择正确;它是否会在某个尚未构造出的 mutation 下独立提供判别力,本轮未证明,不作此声称。

### 14.7.6 NIT

- **NIT-a**(用例间状态链,`migrationDb!` 非空断言脆弱):`migrationDb` 的赋值移入 `beforeAll`,消除"必须先跑到某条用例才被赋值"这一源码序依赖。**部分处置,余项披露**:未按报告"可选修法"进一步做到每条用例自行 `up()` 复原到所需形状——报告原话"判别力今天够用",本轮未改变这一点,仍是同一条状态链,只是链的起点不再脆弱。
- **NIT-b**(每表分列计数从未被断言):case 2(数据齐全)追加 `rejects.toThrow(/batches=1, batch_groups=1, batch_links=1/)`(down() 天然幂等只读,追加第三次调用不产生副作用);半应用用例追加 `toMatch(/batches=1, batch_groups=0, batch_links=0/)`——后者对"`total` 窄化成只算 `batches`"这类 mutation 有独立判别力(前者三个数都是 1,窄化后 `total` 仍 >0,不会被这条轴单独抓到;半应用这条两个子表都是 0,窄化后 `total` 仍是 `batches=1`,判别力来自"消息里报告的具体数字"而不是"是否 reject")。
- **NIT-c**(措辞:"discover it" 的实际路径是错误信息,不是 `--help`):迁移文件 :139 附近改写,明确"`--help` 供提前阅读的操作者,真正的发现路径是 `ATG_BACKFILL_DOWN_BLOCKED` 错误信息本身(直接点名变量)+ force 分支的 `console.warn`"。行为零改动,纯措辞。

### 14.7.7 回归证据(全部本轮亲跑,处女库 `metasheet2_a3r3_20260921`)

```
$ npx tsc --noEmit                                                            # exit 0,零输出
$ npx tsx src/db/migrate.ts --latest && npx tsx src/db/migrate.ts --list      # Applied: 413 / Pending: 0
$ DATABASE_URL=… npx vitest --config vitest.integration.config.ts run …down-guard.db.test.ts --reporter=dot
 Test Files  1 passed (1)
      Tests  9 passed | 1 skipped (10)                                        # 原 8 例(7+1 skip)→ 10 例(9+1 skip),+2 为 P2-A/P3-c 两条新用例
$ DATABASE_URL=… npx vitest --config vitest.integration.config.ts run <8 文件> --reporter=dot
 Test Files  8 passed (8)
      Tests  88 passed | 8 skipped (96)                                       # 原 94(86+8 skip)→ 96(88+8 skip),差值 +2 与上一行一致
$ DATABASE_URL=… npx vitest --config vitest.integration.config.ts run \
    tests/integration/attendance-w4c0-durable-storage-smoke.db.test.ts \
    tests/integration/approval-attachment-scan-purge-upgrade-migration.db.test.ts --reporter=dot
 Test Files  2 passed (2)
      Tests  8 passed (8)                                                     # 邻居健康,与 round-2 报告 G8 逐字相同
$ psql … -Atc "select count(*) from approval_templates where key like 'atgbb%' …"   # 三张 phase-2 批次表 + phase-1 组/链接残留全 0
$ unset DATABASE_URL && npx vitest run tests/unit/approval-ci-coverage-enumeration.test.ts --reporter=dot
 Test Files  1 passed (1)
      Tests  352 passed (352)                                                 # 353 → 352:允许清单删 1 条 = -2 条(§5 每条 2 个 it),T4 新增 1 个扫描文件 = +1 条,净 -1,已核对非偶然(见下)
$ unset DATABASE_URL && npx vitest run tests/unit/approval-a3-dangling-reviews-path-sweep.test.ts --reporter=dot
 Test Files  1 passed (1)
      Tests  4 passed (4)                                                     # 自指陷阱修复后(见 §14.7.3)四条用例,不是最初写的三条
$ node --test scripts/ops/*-ci-wiring.test.mjs                                 # 仓根
 tests 495 / pass 495 / fail 0                                                 # 492 → 495,+3 为新守卫文件自身的三条用例(不含上面的 sweep 守卫,它不在 scripts/ops/ 下)
$ node --test plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs
 pass 1 / fail 0
$ node --test plugins/plugin-integration-core/__tests__/sealed-export-s5-public-export-surface.test.cjs
 pass 1 / fail 0
$ env -u DATABASE_URL -u EXPECT_DB CI=true npx vitest run --reporter=dot        # core-backend 全量无库
 Test Files  949 passed | 175 skipped (1124)
      Tests  15106 passed | 1609 skipped (16715)
```
**353 → 352 的算术**(不是猜测,逐条核对):`APPROVAL_CI_COVERAGE_ALLOWLIST` 数组从 4 条降到 3 条,§5"allowlist integrity"每条登记发两个 `it()`(存在性 + why/date 格式),删 1 条 = **-2**;T4 loop 用 `readdirSync` 派生 `tests/unit` 下 `approval-*.test.ts` 文件名,新增的 `approval-a3-dangling-reviews-path-sweep.test.ts` 匹配该模式,自动进入 T4 population,+1 条"is wired: …"= **+1**(T4 只按文件计一条,与该文件内部有 3 条还是 4 条自己的 `it()` 无关)。净 **-1**(353-2+1=352),与实测的 352 完全吻合,不是巧合也不是回归。

**无库全量套件的六个数字,逐一对账到本轮 diff,零残留未解释项**(round-2 门审报告 G22 基线:`948 passed | 176 skipped (1124)` / `15103 passed | 1617 skipped (16720)`)。第一版曾把 skip 数的下降记成"未追查的环境噪声"——那是漏算了一步:**把 down-guard 文件加进 `vitest.config.ts` 的 no-DB exclude 名单后,无库 job 不再收集它**,而 G18 实测它在 baseline 是被收集且整体 skip 的(`1 skipped (1)` / `8 skipped (8)`)。把这一步计入,六个数字全部对账(sweep 守卫自指陷阱修复后从 3 例变成 4 例,下表用的是修复后的最终数字):

| | 计算 | 期望值 | 实测值 |
|---|---|---|---|
| Test Files passed | 948 + 1(新 sweep 守卫文件) | 949 | 949 ✓ |
| Test Files skipped | 176 − 1(down-guard 文件不再被收集) | 175 | 175 ✓ |
| Test Files 合计 | | 1124 | 1124 ✓ |
| Tests passed | 15103 + 4(sweep 守卫最终 4 例)− 2(allowlist 删 1 条 ×2 个 it)+ 1(T4 新增 1 条"is wired") | 15106 | 15106 ✓ |
| Tests skipped | 1617 − 8(down-guard 原 8 例不再被收集,不再计入 skip) | 1609 | 1609 ✓ |
| Tests 合计 | | 16715 | 16715 ✓ |

六项全部吻合。**如实记录第三次重跑**:在最终树(含自指陷阱修复后的 sweep 守卫)上共跑了三次这条全量无库套件——第一次与第三次干净,均为上表的最终数字(`0 failed`);**第二次 `1 failed | 948 passed`**,失败用例本轮**未定位、未归因**(`packages/core-backend` 全量套件规模大,单次重跑耗时约 100 秒,本仓已有记录在案的间歇性失败族——见 `finding_vitest_ontaskupdate_timeout_silently_drops_assertions`,约 9% 间歇率——本次失败的具体用例未被抓取输出保存,无法回溯核对是否属于该已知族)。三次里出现的那次红**记为未裁定,不记为"环境噪声"**(那需要归因证据,本轮没有),也不因为另外两次干净就把它从记录里去掉。

### 14.7.8 收尾

```
$ dropdb -U ms2testbed metasheet2_a3r3_20260921
```
`git worktree remove --force` 只删本轮自建的一次性 detached 工作树(绝对路径点名);未触碰实现者的 `wt-groups-p2`(@ `866b0d63e5`,落后于本轮基线,未同步)或 `git worktree list` 里的任何其它条目。mutation 还原(M3/M5/M6)全部 `cp` 备份 → 改 → 跑 → `cp` 还原 → `cmp` 逐字节核;全程未使用 `git checkout --` / `git reset --hard` / `git stash drop`。未合并、未 undraft、未开/改 PR、未把迁移应用到任何共享/staging/prod 库、未改锁文正文。资源登记见 `~/.claude/projects/-Users-chouhua-Downloads-Github-metasheet2/soak-working/resource-inventory-20260920.md`。一切仍是候选,供下一轮门审核对。

---

## 13. P3 卫生轮(2026-09-19)

范围:`impl-gate-A3-round4-20260918.md` 与 `impl-gate-A3-round2-20260918.md` 两份门审报告里**全部**仍开放的 P3(round-3 的 3 条 P3 已在 §12.2–§12.4 全部闭合,round-2 的 6 条 P3 里已有 4 条在 §10.1–§10.4 闭合——见下表,均在本轮之前;本轮新处理的是这两份报告余下未闭合的项)。硬规矩:本轮**生产代码零行为改动**,只允许测试、注释、MD、`scripts/dev`;含 DDL/需要新并发测试/owner 裁决的项只登记不做。

### 13.1 处置表

| # | 原文一句 | 处置 | commit |
|---|---|---|---|
| R2-P3-1 | round-2 §7 item 1(最高优先级):lane 自有 MD 四处把「guard 人口 ⊋ manager 人口」当今天的事实断言,另一处「已解决」状态断言过期 | **PRE-CLOSED**(本轮之前;§10.1,改写为「互不包含,两方向各一条反例」+ 22 模式 sweep 复核类别 2 命中为 0) | `0af172a94`(rebase 后 SHA;本轮未新增改动) |
| R2-P3-2 | round-2 §7 item 2:验证 MD §5 项 8「本切片新增五个文件继承同样闭世界残留形态」与 §2.4 自相矛盾 | **PRE-CLOSED**(本轮之前;§10.2,改写为残留仅限 A-1 两个既有文件) | `81d296f10` |
| R2-P3-3 | round-2 §7 item 3:验收 E 姊妹判据的终态腿(两个真并发 execute 都提交,后到者退化 `{batchId:null}`)未测,只有设计论证 | **DEFERRED-需行为改动** —— 需要构造真并发的真库测试(两个连接、真实竞态,不是顺序论证),属新增测试工作量而非本轮定义的机械闭合(改注释/改断言格式/补正控);MD §5 项 1 已如实记录为「未做/未验」,本轮未新增证据,不虚报为已闭合 | — |
| R2-P3-4 | round-2 §7 item 4:`btrim(...) ~ '[!-~]'` 的 SQL/JS 等价缺少 collation 限定语 | **PRE-CLOSED**(本轮之前;§10.3,三处代码/测试注释加 collation caveat,指回同一主锚点) | `463f42986` |
| R2-P3-5 | round-2 §7 item 5:补充清单 #1 的前提在本 head 为假,仍未写成独立勘误句 | **PRE-CLOSED**(本轮之前;§10.4,拆成两句独立结论) | `b7737152b` |
| R2-P3-6 | round-2 §7 item 6(新发现):`atgbb_org_nonblank` 的「今天不可达」是声明,不是检查——`resolveApprovalTemplateGroupOrgId` 只保证非空,不保证 ASCII | **CLOSED-注释**(本轮) | `55eea3a47` |
| R3-P3-1 | round-3 §3:验证 MD `:789` 一处标「原话」的引用,`carries` 的前三个字母被换成了西里尔同形字 | **PRE-CLOSED**(本轮之前;§12.2,python 精确替换 + 复扫零残留;门审报告自身两处副本不在授权范围内,如实记录未改) | `c6f700fe1` |
| R3-P3-2 | round-3 §3:三个文件写死的「污染来源」机制(「同一次 run 里某个 OTHER 更早文件」)与实测不符(该步骤自身残留实测为 0) | **PRE-CLOSED**(本轮之前;§12.3,改写为「来源未定位、体量未测量、暴露已确证」) | `c6f700fe1` |
| R3-P3-3 | round-3 §3:MD §11.5 把 `test:unit` 称作「core-backend 全量无 DB 单测」,窄于 required lane 真正跑的 `pnpm --filter @metasheet/core-backend test` | **PRE-CLOSED**(本轮之前;§12.4,按正确命令改记数字) | `c6f700fe1` |
| R4-P3-1 | round-4 §4:`batches-list` 新 helper 注释把 cross-org 用例的假绿写成「unaffected either way」,与同一提交 §12.7 的自我指控「假绿」不同调 | **CLOSED-注释**(本轮;与 §12.7 同调改写为「vacuous above the cap」,并注明这是发现但未修的暴露面,不是「无需动作」) | `b9f00f9d0` |
| R4-P3-2 | round-4 §4:MD §11.6「保持不动」名单在原地已过期(`batches-list` 已在 §12.1 被改动),失效标记只活在 §12.6 | **CLOSED-MD**(本轮;按 `feedback_supersession_marker_must_evaluate_not_void` 贴到 §11.6 原句求值,不删除原句) | `e4cf5e107` |
| R4-P3-3 | round-4 §4:「634 行」被当成 E14 复现口径记录,但承重的量是通过上限检查的 `eligible.length`(`storable_unlinked`),不是插入行数;门审第 4 轮已用「NULL/非 NULL 各半」配比测出反例(634 行仅 317 可归组,不越限) | **CLOSED-MD**(本轮;§12.1 补求值段落 + §12.5 表格行注明实测承重量 617) | `e4cf5e107` |

### 13.2 撤回类改动的全分支 grep 扫描(零命中要求)

| 撤回的措辞 | 扫描范围 | 结果 |
|---|---|---|
| `unaffected either way`(round-4 P3-1 的原句,限定在被改写的那个语境) | `packages/core-backend/tests/integration/approval-template-groups-backfill-batches-list.db.test.ts` | `grep -c` = **0**(该文件内)。全仓 `grep -rn` 命中 2 处,均是与本主题无关的既有短语(`src/types/plugin.ts:513` 讲插件覆盖安装、`src/routes/approvals.ts:3419` 讲 G-12(b) 的另一条正控),不是被撤回的那句 |
| 「every org id already IN the database is ASCII」(round-2 P3-6 的原句) | `packages/core-backend/src` 全目录 | **0** |
| 本轮三处新增文字自身的绝对词族普查(`regardless`/`never`/`always`/`impossible`/`guarantee`/`cannot` 等 13 词族,沿用 round-4 门审 §3 的扩展词表) | `git diff 623a0447f..e4cf5e107` 的全部新增行(`+` 行,三个修复提交,不含本节自身的记账文字) | 4 处命中,逐条求值:两处是描述**代码实际保证边界**的事实陈述(`only GUARANTEES .trim().length > 0` / `does NOT guarantee ASCII`,可读源码验证),一处是「无论假设是否成立,这个映射都安全」的条件安全性陈述(`regardless of whether the observation holds`,承重于映射函数是纯函数 + 有单元测试),一处是「这条单测测不到可达性」的能力否定陈述(`it cannot exercise reachability itself`,描述测试设计本身,可读测试源码验证)。四处均非「不看条件、宣称任意场景恒真」的过强断言,PASS |

### 13.3 同形字 / 隐藏字符机械复扫(本轮三处编辑)

python `unicodedata` 逐字符扫描本轮编辑的 3 个文件(Cyrillic/Greek/组合符/NUL/零宽/NBSP 区段):**全 0 命中**。

### 13.4 回归证据(本轮,私有库 `ms2_p3hygiene_r1`,处女库,用完 `dropdb`)

| 步骤 | 命令 / 要点 | 结果 |
|---|---|---|
| tsc | `cd packages/core-backend && npx tsc --noEmit` | EXIT=0,零输出(R2-P3-6 提交前后各跑一次,均 0) |
| 建库 + 迁移 | `dropdb --if-exists ms2_p3hygiene_r1 && createdb ms2_p3hygiene_r1` + `DATABASE_URL=… pnpm run db:migrate` | 全量迁移,末条 `zzzz20260919090000_create_approval_template_group_backfill_batches` |
| A-1 两文件 + A-3 五文件,处女库 | `EXPECT_DB=1 npx vitest --config vitest.integration.config.ts run <7 个文件> --reporter=dot` | `Test Files 7 passed (7)` / `Tests 86 passed (86)`——与 §10.5/§12.5 记录的基线数字逐字相同 |
| `atgbb_org_nonblank` 单元测试(R2-P3-6 触碰的注释所在文件的判别力测试) | `EXPECT_DB=1 npx vitest run tests/unit/approval-template-group-backfill-batch-org-nonblank.test.ts --reporter=dot` | `Test Files 1 passed (1)` / `Tests 3 passed (3)` |
| required real-DB 步骤整份 84 文件逐字复现(`plugin-tests.yml:1613-1699` 原样抄出,唯一改动是 `DATABASE_URL`) | `EXPECT_DB=1 bash -e /tmp/p3hygiene-realdb-step.sh` | `Test Files 84 passed (84)` / `Tests 943 passed (943)` / **EXIT=0**——与 §11.5/§12.5 记录的基线数字逐字相同 |
| core-backend 全量无库 lane(required `test (20.x)` 的另一半) | `env -u DATABASE_URL -u EXPECT_DB CI=true pnpm --filter @metasheet/core-backend test --reporter=dot` | `Test Files 932 passed \| 175 skipped (1107)` / `Tests 14722 passed \| 1604 skipped (16326)` / EXIT=0——与 §12.4/门审 E11/E15 记录的数字逐字相同;`grep -c "tests/integration/approval-template-groups"` = 0(零收集),正控 `grep -c "tests/integration/"` = 209(非空转) |
| 清库 | `dropdb ms2_p3hygiene_r1` → `psql -lqt \| cut -d'\|' -f1 \| grep -c ms2_p3hygiene_r1` | **0** |

### 13.5 `git diff --stat`(证明只动测试/注释/MD/scripts;起点 = rebase 后本轮开始处)

```
$ git diff --stat 623a0447f32ad80b02cfd61cb70787f3df04179d..e4cf5e107 (R2-P3-6 + R4-P3-1 + R4-P3-2/3 三个修复提交,不含本节自身)
 .../approval-template-groups-phase2-backfill-verification-20260918.md |  6 ++++--
 .../src/services/ApprovalTemplateGroupService.ts                      | 19 ++++++++++++++++---
 .../approval-template-groups-backfill-batches-list.db.test.ts         | 14 +++++++++++---
 3 files changed, 31 insertions(+), 8 deletions(-)
```

文件集合核验:`git diff --name-only 623a0447f..e4cf5e107 | grep -v -E "\.md$|tests/integration/.*\.db\.test\.ts$"` 命中 1 个文件——`packages/core-backend/src/services/ApprovalTemplateGroupService.ts`(R2-P3-6);已在本节 §13.2 上方逐 hunk 核过:该文件的改动**全部落在 `/** ... */` doc-comment 块内**(`git diff` 的每一行 `+`/`-` 都在注释符号之间),零一行可执行语句/声明/类型改动,`const NONBLANK_CHECK_CONSTRAINTS = new Set([...])` 本身未变。本节自身(§13)是对同一份验证 MD 的第 4 次追加编辑,不引入新文件,不改变以上文件集合结论。

### 13.6 未闭合项与下一步(如实登记,不算已满足)

- **R2-P3-3(验收 E 终态腿)**:需要一个真正构造并发(两个连接、两次真并发 `POST …/execute`)的真库测试,证明后到者退化为 `{batchId:null}` 而不是重复归组。这不是本轮「改注释/改断言/补正控」的机械范围,记入下一实现步骤(与 §5 项 1 保持一致的记账,不重复计一次新发现)。
- 本轮**没有**触碰 `serialization.db.test.ts`/`batches-list.db.test.ts` 的产线暴露面本身(§12.7 已知的两类超限行为问题)——那两类需要给测试新增真实的 sink/断言,超出「注释/MD 措辞收口」的边界,继续留给 owner/后续 lane,如实不算作本轮已处置。
