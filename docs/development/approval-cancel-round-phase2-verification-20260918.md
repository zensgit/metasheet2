# Cancel round — phase 2 (C-2 兑现与收口) verification

Branch `feat/approval-cancel-round-phase2`, stacked on `feat/approval-cancel-round-phase1`
**at `7ef8e610e`** — pinned, because `feat/approval-cancel-round-phase1` has since moved on to
`dce9e16df` (six further commits: five docs + `a166f5ca0`, whose code half touches
`ApprovalBridgeService.ts` and `apps/web/src/approvals/api.ts`, neither of which this slice edits).
The branch name alone no longer resolves to this slice's base, so the SHA is the citation.
Lock: `approval-change-request-design-lock-draft-20260915.md` (v5.9, RATIFIED).
Private database: **`metasheet2_lock_c2`**, PostgreSQL **15.17 (Homebrew)**, created for this slice
and migrated from empty including the phase-1 migrations. No shared, staging or production
database was touched.

This file is **incremental**: it records each unit as it lands, with commands run verbatim and the
result lines they printed. Units not yet done are listed as not done, not as passing.

---

## 本切片验收总表(2026-09-18 定稿;先读 §0 — 下表是导航,不是对 §0 撤回的替代或降级)

Rows track the lock criteria this slice's own goal document names for C-2. Status is adjudicated
from §4 ("What this slice has NOT proven yet"), not re-argued here. 部分 means the row's own listed
gap is real and still open, not that the test is flaky or absent. lane: `base` = the original
sequential C-2 work (pre-`u1`/`u2`/`u3` split, everything up to `a02930896`); `u2`/`u3` = the split
lanes folded back by merge commit `1c98ff937`.

| 验收行 | 测试文件 | 用例名(节选) | lane | Status | 未闭合的部分(引 §) |
|---|---|---|---|---|---|
| 判据 II(C-2 挂点先于 `:11070`,W4 外部事务入口 C-1) | `approval-cancel-round-redemption.db.test.ts` | "判据 II (§14.2, outlet #5): an attendance-backed cancel round whose window is OPEN redeems …"; "判据 II END-TO-END (no double): the redemption runs the REAL W4 external-transaction entry …"; "判据 II fail-closed …"; "判据 II scope fail-closed …" | base | **部分** | §3.11.6 的四个双件用例是**测试替身**背书,只证明审批侧半边;posture resolution / authorization 在真边界上会跑但**没有专门断言钉住其结果**(§3.12.3);§3.11.3 的 org-key 匹配对双件用例只是构造论证,§3.12 才是真跑(见 §4 第 1 条) |
| 判据 IV,`expired` 半边(C-3 收口) | `approval-cancel-round-redemption.db.test.ts` | "判据 IV (§14.2, outlet #5′): the in-lock final evaluation finds the §2-G2 window closed ⇒ … `expired` …" | base | **PASS** | 卡片失效(C-3 row 3 第三列)未扫(§3.8,pre-existing);R1 的 9 处计数未把 #5′ 本身算进去,是否该到 10 是 owner 待裁(§7.1) |
| 判据 IV,`blocked` 半边(C-3 收口,C-1 `business_refused` 承接) | `approval-cancel-round-redemption.db.test.ts` | "判据 IV `blocked` 半边 + C-3 row 4(业务不可逆):C-1 RETURNS a business refusal …" | base | **PASS** | 同上;这一半边同样是双件背书 |
| W4 入口(C-1 通过 W4 外部事务入口调用,C-1 port) | `approval-cancel-round-redemption.db.test.ts` | "判据 II END-TO-END (no double): the redemption runs the REAL W4 external-transaction entry — its isolation and rollout-lock preconditions pass by MEASUREMENT …"；判据 II fail-closed 的 `CANCEL_ROUND_EXECUTION_PORT_UNAVAILABLE` 用例 | base | **部分** | E2E 用例走的是 **legacy 写入姿态**,P14 已批休假取消计算被跳过(断言过,§3.12.3);未 seed 请假余额批次,`reverseLeaveBalanceDeduction` 未写任何东西 |
| §3.3b 锁序(rollout advisory lock 排在行锁之前,阻塞项的解法) | `approval-cancel-round-lock-order-census.db.test.ts` | census Q-F(6 legs,17→23 passed);M-11 至 M-15(§3.9.5,原编号未动) | base | **部分** | leg 3 只是**源码顺序**证明,不是真并发死锁构造(需要 Q-A/Q-D 的双连接技术,§3.9.4 自陈);新 503 面的路由层处理未验证(§3.9.3) |
| §8 期 1 账侧字节等价 | `approval-cancel-round-redemption.db.test.ts` | "账侧 (lock §8 期 1): the redeemed cancel round leaves the SAME rows as the existing `POST /api/attendance/requests/:id/cancel` path on a twin fixture …" | u2 前身(§3.15)+ u2 补测(§3.21/§3.22) | **部分** | 七步里 ②④⑤ 已比对、③⑦ 等值但走的是**已跳过的生产分支**(需 non-legacy 双胞胎)、⑥ 是**声明式背离**(无可比行对)、①② 无终态可比;另 request provenance(`ip_address`/`user_agent`)是实质性背离,owner 待裁(§3.15's headline,§7.2) |
| §5 I3「终结即释放」(两个终态写入方) | `approval-cancel-round-redemption.db.test.ts` | "§5 I3 「终结即释放」 (the C-3 half): … `createCancelRoundInstance` call is the first post-close statement …"(M-21);"§5 I3 「终结即释放」 (the C-2 half, outlet #5): …"(M-30,§3.20) | base(C-3 半边)+ u2(C-2 半边,§3.20) | **PASS**(两个写入方都已探) | 两条用例都用测试替身 port,原单据在生产中会被 C-1 真取消——真实边界下第二轮是否会因单据状态被拒,未答(§3.20 自陈的夹具前提) |
| §9-9 允许集含 `approve` 成员钉 | `approval-cancel-round-redemption.db.test.ts` | "§9-9 允许集 MEMBER pin (approve) — gate round-5 P3-1: on ONE cancel-round instance the action-judgment gate refuses a non-member … and LETS `approve` THROUGH …"(M-29,§3.19) | u2 | **PASS** | 只钉了 `approve` 一格;`reject`/`revoke`/`comment` 三格仍是 C-1 R5-M8/M9/M10 的证据,绑定 C-1 自己的 head,本单元不继承不重跑(§3.19.4 自陈) |

**Everything below this table (§0 onward) is the full, incremental record** — commands, mutation
ledgers per unit, retractions, the merge record, and (added by this 定稿 pass) a fresh independent
rerun on a brand-new private DB, an aggregated mutation ledger, wiring/census evidence, the
supplementary gate checklist answered item-by-item, and the owner-pending items, at the very end of
the file.

---

## 0. Corrections and retractions (retraction-first)

| # | Where the wrong claim is | The claim | Status |
|---|---|---|---|
| R-1 | commit `042d92e02` message, 2nd bullet | "typecheck then acts as the census over every `result.response` / `.lifecycleEvents` / `.resolvedRequestId` access **(13 sites, all narrowed)**" | **RETRACTED — the number is wrong.** I wrote 13 without counting. Mechanical count below: **7** sites for exactly those three properties. The substantive half (typecheck is clean, so every one of them is narrowed) stands; only the count was invented. The commit message cannot be edited without a force-push, so the correction lives here. |
| R-3 | commit `56d517127` message, 2nd paragraph, and §3.10.3's first draft | "that inversion is a cycle on the same (request, instance) pair today" … the reorder "closes" the live defect | **RETRACTED IN PART — the reorder closes it for the CANCEL path only.** My own census leg contradicts the word "closes": Q-G LEG 4 shows the DECISION adapter (`index.cjs:37596`/`:37617`) is also `attendance_requests → approval_instances` and is also gated on `requestRow.status === 'pending'` — exactly the population `bulkReassignApprovals` reaches `classifyAndLockAttendanceRequestForInstance` on with the instance row held. So the same cycle, same shape, is **still live** after this commit via the decision adapter. Leaving that adapter to the attendance line is the right scope call; calling the defect closed was not. The commit message cannot be edited without a force-push, so the correction lives here. |
| R-4 | `ApprovalProductService.redeemCancelRoundInTxn`'s own comment (commit `08b7cbec3`), and §4's 「it is CHEAP」 bullet | 「`operationId` … must be a UUID … The round row's own id **is exactly the right identity**」, and 「the end-to-end case … is a handful of lines」 | **BOTH RETRACTED — see §3.12.** The round id is `text`, minted `apr_${crypto.randomUUID()}`, so the boundary refused EVERY real redemption with `W4C3B_REQUEST_BOUNDARY_INPUT_INVALID` (500). Four double-backed acceptance cases were green over a code path that could not work. And the end-to-end case was not cheap: it took a production fix plus two fixture facts that no reading of the source would have produced. |
| R-2 | my own working notes for this step | "the `w7-w6r5-guard` classification test ran and passed" | **RETRACTED — it never ran.** A combined run of three targets printed `Test Files 2 passed (2)` and I inferred which two. Checked directly: `npx vitest run tests/unit/w7-w6r5-guard` prints **`No test files found, exiting with code 1`** — that path holds `classification.ts` and `walk.ts`, which are corpora, not suites. Their real consumers are named in §2.5 and were run there. A directory that collects zero files is not a green. |
| R-5 | commit `5dbbf5f6b` message, 3rd paragraph, and §3.13.2's first draft | "under M-20 **ALL THREE** of R2's literal clauses stayed GREEN (**measured** — the `ivexp` case … passed)" | **RETRACTED IN PART — clause 1 was NOT measured by that run.** `ivexp` has no attendance target, so it asserts nothing about 零业务取消; the only case that does is R2 itself, and in that run R2 died at the `approve_rows` assertion, which the first draft ordered BEFORE the 零业务取消 rows — so those rows were never evaluated. Clauses 2 and 3 were genuinely measured; clause 1 was an argument labelled as a measurement, in a file whose whole discipline is the opposite. FIXED by the follow-up commit: the case now orders the three literal clauses first and the implementer addition last, and M-20 re-run puts the red on the file's last line (`:1433:49`) with all three evaluated and green. The original commit message cannot be edited without a force-push, so the correction lives here. |
| R-6 | §3.4, §3.11.6 and the redemption suite's own header (phase 2, all three units) | a new `.db.test.ts` would owe 「the **hard-coded `FILES` array** in `scripts/ops/ci-realdb-step-contract.mjs:99-102` — a closed world that stays green for a file it does not list」 | **RETRACTED — that is not what lives at `:99-102`, and the script holds no file list at all.** Read this session: `:99-102` is `REAL_DB_STEP_IDS = Object.freeze({ approval: 'approval-real-db-integration', multitable: 'multitable-real-db-integration' })` — a frozen map of two **step ids**, not test files. The file population is DERIVED from the workflow at check time (`wholeFileVitestArgs`, `:521-525`, reads the parsed step's own vitest invocations), so it cannot go stale against `plugin-tests.yml` the way a hard-coded list would. `grep -c 'db.test.ts'` over the whole script ⇒ **1** (a doc-comment example at `:513`), `grep -c cancel-round` ⇒ **0**. Consequence for this line: a new `.db.test.ts` under the existing `approval` step owes `plugin-tests.yml` + the s6a re-pin, and owes this script **nothing**. The three places carrying the wrong description are corrected in place; the two commit messages that repeated it cannot be, so this row is their correction. |
| R-7 | §4's 「§5 I3 『终结即释放』 mutation」 bullet (previous revision) | the mutation's red would be 「the next create is **refused by the partial unique index** with 23505/409」 | **RETRACTED — the index is never reached in the sequential shape.** Measured in §3.14.2: `createCancelRoundInstance` has an application pre-check at `ApprovalProductService.ts:8558-8568` that runs before the `INSERT`, and M-21's stack frame is `ApprovalProductService.ts:8563:15` — `CANCEL_ROUND_ALREADY_PENDING` (409). The 23505 backstop at `:8697-8705` is the CONCURRENT-race path and this case does not construct one. The half that stands: C-3's outcome write is what releases the slot. The half that does not: any claim about `uq_approval_rounds_pending_document` itself. |
| R-8 | §3.15.6 (previous revision), and the 账侧 case's own doc comment | 「`redeemCancelRoundInTxn` **DISCARDS** the entry's `{ kind: 'executed', response }` payload, so the approval side **has no channel to present it on at all**」 | **RETRACTED IN PART — the 「at all」 is false, and §3.16 measures the channel.** The discard is real and stands. What does not stand is the conclusion drawn from it: the redemption path supplies a non-null `operationId`, so it takes the boundary's identity+preflight+**seal** branch, and `sealAttendanceResultOperationV1` writes `attendance_result_operations.response_snapshot` with the adapter's WHOLE response object on the CALLER's transaction client (`w4c3b-request-operation-boundary.ts:918-921` → `w4c0-operation-registry.ts:756-790`). The counter is therefore computed, persisted and queryable per operation, and commits with the approve. §3.16 measures it at **120**, not at 0. The item that remains open is narrower than the one that was written: which USER-FACING surface renders it. Registered as an owner decision, not as a contract gap in the persistence. |
| R-9 | commit `ab36b38f0`'s message, last paragraph | 「§4's bullet **is updated** from 'no probe' to CLOSED with its scope limits」 | **RETRACTED — at that SHA it was not.** The commit applied §3.18 and then attempted a second edit to §4's I3 bullet and §3.14.5's writer row; that edit threw `AssertionError` (the target string did not match), and because the `git add && git commit` was newline-separated rather than `&&`-chained, the commit landed anyway — with §3.18 present and both older 「no probe exists」 statements still standing. So `ab36b38f0` briefly contained a file that asserted a probe exists (§3.18) and that none exists (§3.14.5 row `:9108`, §4's bullet) at the same time. FIXED one commit later by `79f3d3ce2`, which is where the §4 and §3.14.5 updates actually live, and which discloses the mechanism. The original message cannot be edited without a force-push, so this row is its correction. **Consequence for a gate reader**: verify the §4 bullet against `79f3d3ce2` or later, never against `ab36b38f0`. |
| R-10 | §3.16.7 / §3.17.6 / §3.18.5 的 `$ npx tsc --noEmit -p tsconfig.json` → 「[exited with code 0]」,以及据此说的「tsc clean」 | 读起来像「新加的测试代码过了类型门」 | **NARROWED(不是撤回:命令真跑过、真的 0)。** 两点限制,本单元实测:(1) `packages/core-backend/tsconfig.json` 的 `exclude` 含 `**/*.test.ts`,`--listFiles \| grep -c` 本文件 ⇒ **0**,即这些单元所改的测试文件**不在 tsc 的 program 内**,那个 0 与改动无关;(2) 旧写法 `npx tsc … \| tail -N && echo $?` 取的是 `tail` 的退出码,恒 0。⇒ 这些行只能支撑「生产源码仍可编译」(而这三个单元生产代码零改动,故恒真),**不能**支撑「新加的测试代码类型正确」。真正的门是 vitest 运行本身;本单元的语法错正是被它抓到、被 tsc 漏掉的(§3.20.8)。**Consequence for a gate reader**: 不要把这三节的 tsc 行读作测试代码的类型证据;要证据就看该节的 vitest 计数。 |
| R-11 | §3.10.5's own mutation ledger table | mutation IDs `M-11` and `M-12`, assigned to the Q-G pre-fix-restore and Q-G-LEG-2 probes | **RETRACTED — collision, not a merge artefact this time.** §3.9.5 (an earlier, independent unit) had already claimed `M-11` (delete the shared `ORDER BY`'s business-key preference) and `M-12` (resolver takes the org from the instance instead of the request) for ITS OWN two mutations. §3.10.5 reused the same two bare numbers for two DIFFERENT probes without checking the file's own prior sections — unlike the u2/u3 merge-time collision (§0 has no row for that one because it was caught and fixed IN THE SAME COMMIT that created it, `1c98ff937`'s own merge-resolution notes at the end of this file), this one shipped and stood until this 定稿 pass found it by building the mutation-ledger summary table below and finding two rows claiming the same ID with different mutations. **FIXED here**: §3.10.5's two entries are renumbered `M-33` and `M-34` (the next free IDs after the existing `M-1`–`M-32`), at every occurrence in this file (§3.10.5's table and its own follow-up paragraph) and in the design MD's one cross-reference (`§4.3`, "M-12 is what caught it" → "M-34"). §3.9.5's `M-11`/`M-12` are UNCHANGED — they are the ones already cited elsewhere (design MD §4.2) and were first in document order. No test file changed; this is a documentation-only renumbering of a citation, not a re-run. |
| R-12 | this file's own closing paragraph, "`it()` count reconciled" section (added by commit `d462677bd`) | "not re-run against the final merged **20**-test-plus-sentinel file" | **RETRACTED — arithmetic slip in the very paragraph that was reconciling arithmetic.** The same paragraph's own preceding lines establish base(16) + u3(+0) + u2(+2) = 18 `it()` blocks, plus the one sentinel = **19**, and this 定稿 pass's fresh rerun (below, private DB `metasheet2_lock_c2_docs`) reports the identical `19 passed (19)`. "20" was never derived from anything in the paragraph — it is corrected to 19 in place. |

```
$ git grep -nE "result\.(response|lifecycleEvents|resolvedRequestId)" -- packages/core-backend/src/attendance/w4c3b-request-operation-boundary.ts
811:            return { kind: 'legacy' as const, response: result.response }
836:              return { kind: 'legacy' as const, response: result.response }
883:            return { kind: 'legacy' as const, response: result.response }
889:          const [event] = result.lifecycleEvents
904:            responseSnapshot: jsonValue(result.response),
905:            resolvedRequestId: result.resolvedRequestId,
909:            response: result.response,
$ git grep -cE "result\.(response|lifecycleEvents|resolvedRequestId)" -- packages/core-backend/src/attendance/w4c3b-request-operation-boundary.ts
7
```

(The 14 hits of the wider pattern `result\.(response|lifecycleEvents|resolvedRequestId|kind|code|
detail|httpError)` include the refusal's own fields inside `takeBusinessRefusal` and the two
`result.kind` entry checks, which are not what that sentence named.)

---

## 1. Database setup

```
$ createdb metasheet2_lock_c2
$ DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c2 npx tsx src/db/migrate.ts
… migration "zzzz20260918090000_create_approval_rounds" was executed successfully
… migration "zzzz20260918100000_seed_approval_cancel_round_published_definition" was executed successfully
… migration "zzzz20260918110000_add_attendance_requests_approval_workflow_key" was executed successfully
[exited with code 0]

$ psql -d metasheet2_lock_c2 -tAc "select count(*) from information_schema.tables where table_schema='public'"
423
$ psql -d metasheet2_lock_c2 -tAc "select to_regclass('public.approval_rounds')"
approval_rounds
$ psql -d metasheet2_lock_c2 -tAc "select version()"
PostgreSQL 15.17 (Homebrew) on aarch64-apple-darwin25.2.0 …
```

---

## 2. WI-11 — the `review_required` return contract (commit `042d92e02`)

Lock §3 C-3 / §11-④ (lock:126-130). The adapter's `ATTENDANCE_CANCELLATION_REVIEW_REQUIRED` 409
throw becomes a returned business outcome; the boundary decides throw-vs-return per entry.

**判据 IV pin, decided in this unit so it cannot drift later.** C-3's engine-record reason is
`business_blocked:<code>` with `<code>` = the refusal's `code` — a bounded, queryable token. The
finer business cause travels in the refusal's `detail` (`record_missing`,
`frozen_request_snapshot_missing`), and the two collapse into the same reason string. That is a
deliberate trade: the reason column stays enumerable, and the distinguishing cause must therefore
be **persisted alongside** — WI-12 writes `detail` into the closure record's metadata, and the
判据 IV test asserts it there. If a gate reviewer reads the C-3 table's per-cause list
(已消费/已结算/不支持套件) as requiring per-cause *reason strings*, this pin is the thing to
challenge; it is flagged rather than buried.

### 2.1 「唯一生产消费点」 — the absolute, with its command

The lock says the only production consumer of the `review_required` business outcome is the cancel
adapter in `plugins/plugin-attendance/index.cjs`. Checked on this working tree before changing it,
because "照先例" claims about a typed business outcome have to be grounded in every consumer:

```
$ git grep -nE "kind *(===|==|:) *'review_required'" -- . ':!docs'
packages/core-backend/src/attendance/__tests__/w4c3b-approved-leave-cancellation.test.ts:50
packages/core-backend/src/attendance/w4c3b-approved-leave-cancellation.ts:76          <- producer
packages/core-backend/src/attendance/w4c3b-approved-leave-cancellation.ts:165         <- producer
packages/core-backend/tests/integration/attendance-w4c3b-approved-leave-cancellation.db.test.ts:336
packages/core-backend/tests/integration/attendance-w4c3b-approved-leave-cancellation.db.test.ts:412
plugins/plugin-attendance/index.cjs:35173                                             <- consumer
```

6 hits: 2 producer, 3 its own tests, **1 consumer**. The lock's claim holds at this baseline; the
line number has drifted from the lock's `:35132-35138` to `:35173`, which is why the site was
located by grep and not by line.

The bare token `review_required` has many more hits, none of them this outcome:
`manual_review_required` (attendance setup readiness), `outcome: 'review_required'` (w4c1 segment
calculator), `shadowDiffCode: 'review_required'` (w4c2), `attendance.work_date.review_required`
(an event kind). Recording that here so the narrow grep above is not mistaken for the whole search.

### 2.2 Savepoint semantics — measured, not recalled

The external entry rolls a refused attempt back to a boundary-owned savepoint. Three things had to
be true for that to be sound, and subtransaction-abort semantics for xact-level advisory locks is
exactly the kind of fact worth measuring. Run on `metasheet2_lock_c2`:

```
$ psql -d metasheet2_lock_c2
BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT pg_advisory_xact_lock_shared(4294967296::bigint + 7);   -- caller's lock, BEFORE the savepoint
SELECT id FROM probe_rows WHERE id = 1 FOR UPDATE;             -- caller's row lock
  advisory | ShareLock | t | classid 1 | objid 7 | objsubid 1
SAVEPOINT w4_probe;
  SELECT pg_advisory_xact_lock_shared(4294967296::bigint + 7); -- inner re-take
  SELECT id FROM probe_rows WHERE id = 2 FOR UPDATE;           -- inner row lock
  INSERT INTO probe_written (tag) VALUES ('inner-registry-row');
  UPDATE probe_rows SET v = 99 WHERE id = 2;
  -> written = 1
ROLLBACK TO SAVEPOINT w4_probe;  RELEASE SAVEPOINT w4_probe;
  advisory | ShareLock | t | classid 1 | objid 7 | objsubid 1  <- caller's lock SURVIVES
  written_after = 0                                            <- inner rows GONE
  probe_rows: (1,0) (2,0)                                      <- inner UPDATE GONE
INSERT INTO probe_written (tag) VALUES ('closure-row');
UPDATE probe_rows SET v = 7 WHERE id = 1;
COMMIT;                                                        <- transaction still usable
  probe_written: (2,'closure-row')   probe_rows: (1,7) (2,0)
```

**Discriminating pair.** "Both locks still present after the rollback" is also consistent with
*nothing* being released, so the inner-only case was run separately:

```
BEGIN ISOLATION LEVEL SERIALIZABLE;
SAVEPOINT w4_probe2;
  SELECT pg_advisory_xact_lock_shared(4294967296::bigint + 9);
  -> inside = 1
ROLLBACK TO SAVEPOINT w4_probe2;  RELEASE SAVEPOINT w4_probe2;
  -> after_rollback = 0                                        <- inner-only lock IS released
ROLLBACK;
```

So: a lock taken **inside** the savepoint is released by the rollback, a lock taken **before** it is
not. That is what makes `assertExternalTransactionRolloutLockHeldV1` still pass for a caller that
makes a second entry call in the same transaction after a refusal.

The first transcript is also the evidence that `ROLLBACK TO` **followed by** `RELEASE` is legal and
leaves the transaction committable — the exact sequence the refusal path issues. `ROLLBACK TO`
alone leaves the savepoint DEFINED, so the RELEASE is not optional: without it the caller would be
left inside a subtransaction the boundary created and every C-3 closure write would land at the
wrong nesting level.

### 2.3 Commands and results

```
$ (packages/core-backend) npx tsc --noEmit -p tsconfig.json
  (no output, exit 0)

$ (packages/core-backend) npx vitest run tests/unit/attendance-w4c3b-external-transaction-entry.test.ts
  Test Files  1 passed (1)
        Tests  14 passed (14)         (8 before this slice's first commit, 11 after it)
```

Real-DB oracle for the **unchanged** HTTP path. Note the config: this file is in
`vitest.config.ts`'s exclude list and is run in CI from an explicit list with
`vitest.integration.config.ts`. Run with the default config it reports
`No test files found, exiting with code 1` — a run that would have looked like nothing was wrong
while asserting nothing at all, so the config is part of the evidence:

```
$ (packages/core-backend) EXPECT_DB=1 \
  DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c2 \
  ATTENDANCE_TEST_DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c2 \
  npx vitest --config vitest.integration.config.ts run \
    tests/integration/attendance-w4c3b-request-operation-routes.db.test.ts
  Test Files  1 passed (1)
        Tests  24 passed (24)
  ✓ … > rolls back approved-leave cancellation when P14 has no frozen parent calculation
```

That case is the 账侧字节等价 oracle for this change: it asserts status `409`, code
`ATTENDANCE_CANCELLATION_REVIEW_REQUIRED`, `details: [{ field: 'calculation', message:
'record_missing' }]`, unchanged row counts, and the request row still `approved` with
`resolved_by`/`resolved_at` null.

### 2.4 Mutation ledger

Every probe: `cp` backup → edit → run → `cp` restore → `cmp` (all three restores verified identical).

| # | Mutation | Expected | Observed |
|---|---|---|---|
| M-1 | `takeBusinessRefusal`: make the HTTP-entry branch unreachable (`if (false)`) so a refusal is returned instead of thrown | the two HTTP-entry unit cases red, nothing else | **exactly 2 red**, "HTTP entry: throws the adapter's OWN error object" + "HTTP entry: a malformed refusal fails closed"; other 9 green |
| M-2 | delete `await client.query('SAVEPOINT w4c3b_external_txn_attempt', [])` | the savepoint unit case red | **exactly 1 red**, "external entry: the attempt runs inside a boundary-owned savepoint"; 10 green |
| M-3 | `throw result.httpError` → `fail('W4C3B_REQUEST_BUSINESS_REFUSAL_INVALID', 500)` | the **real-DB** oracle red — proving it discriminates the byte claim, not just that some 4xx happens | **red**: `AssertionError: {"ok":false,"error":{"code":"W4C3B_REQUEST_BUSINESS_REFUSAL_INVALID",…}}: expected 500 to be 409` |
| M-4 | `runExternalTransactionAttemptInSavepointV1`: drop the `if (result.kind === 'business_refused')` guard so the rollback is UNCONDITIONAL — i.e. a *successful* cancellation would be silently discarded | the success case red, the refusal case still green | **exactly 1 red**, "a successful execution releases the savepoint but does NOT roll back"; 13 green |

M-3 is the one that matters for 账侧字节等价: without it, "the db test passes" would only show the
test runs, not that it can tell a correct response from a wrong one.

### 2.5 Two-point wiring / census

No new file and no `plugin-tests.yml` change, so no s6a re-pin:

```
$ git show --name-only --format= 042d92e02
packages/core-backend/src/attendance/w4c3b-request-operation-boundary.ts
packages/core-backend/tests/unit/attendance-w4c3b-external-transaction-entry.test.ts
plugins/plugin-attendance/index.cjs
```

⚠️ **CORRECTED, and the correction came from running the check rather than restating it.** This
line used to read 「the new unit cases were **appended to a file already collected**」.
`attendance-w4c3b-external-transaction-entry.test.ts` is a **NEW** file (`A` in
`git diff --name-status feat/approval-cancel-round-phase1..HEAD`), 477 lines, with **zero** hits
across `*.yml *.mjs *.sh *.json *.cjs` — i.e. no token anywhere names it. Under this repo's
「考勤新文件四道 census 钉」 rule that is exactly the shape that owes pins, so 「already collected」
was an assumption doing the work of a measurement.

**Measured, with a positive control for the method** (`packages/core-backend`, default config —
which is what `npm test` → the required `test (20.x)` lane runs, since `"test": "vitest"`):

```
# the file under test
$ npx vitest run tests/unit/attendance-w4c3b-external-transaction-entry.test.ts --reporter=dot
  Test Files  1 passed (1)
        Tests  14 passed (14)

# POSITIVE CONTROL — a file that IS on vitest.config.ts's exclude list, passed the same way
$ npx vitest run tests/integration/admin-users.api.test.ts --reporter=dot
  No test files found, exiting with code 1
```

The control is what makes the first run mean something: a path filter does **not** override
`exclude`, so an excluded file collects zero. The new file collects and runs ⇒ it is not excluded.
And the config sets **no `include` override** (`grep -cE '^\s*include\s*:' vitest.config.ts` ⇒ `0`),
so collection falls to vitest's default glob, which is discovery-based over `tests/unit/**` — a
population no token list can go stale against. **Conclusion: this file needs no pin**, and the
four-pin rule it looked like it triggered applies to new `.db.test.ts` files and to
`plugin-tests.yml` edits, neither of which this is.

The real-DB oracle is an existing file already wired into the attendance real-DB step at
`.github/workflows/plugin-tests.yml:1838`.

**"No census entry needs widening" is not assumed — the corpora were grepped.** Both changed source
files are enumerated by existing classification corpora, so this had to be checked rather than
inferred from the file count:

```
$ git grep -n "w4c3b-request-operation-boundary" -- scripts tests packages/core-backend/tests .github
.github/workflows/approval-realdb-org-writer-w4-s1.yml:44      <- path filter (this change TRIGGERS it)
.github/workflows/approval-realdb-org-writer-w4-s1.yml:64      <- path filter
packages/core-backend/tests/unit/attendance-w4c3b-external-transaction-entry.test.ts:23  <- the import
packages/core-backend/tests/unit/w7-w6r5-guard/classification.ts:111                     <- classified
```

`plugins/plugin-attendance/index.cjs` appears in ~110 files including five
`scripts/attendance/w4c0-dml-inventory/*` classifiers. Those classify by **enclosing function
name**, not by line, and this change adds no DML and no new SQL statement to `index.cjs` (it
replaces a `throw` with a `return` inside `executeRequestCancel`), so no inventory entry moves.
The boundary file's new statements are `SAVEPOINT` / `ROLLBACK TO` / `RELEASE`, which are
transaction control, not DML.

The corpora's actual consumers were run (the corpus files themselves are not suites — see §0 R-2):

```
$ (packages/core-backend) npx vitest run \
    tests/unit/attendance-w7-w6r5-preservation-guard.test.ts \
    tests/unit/attendance-w6-fser-single-source-caller-inventory.test.ts \
    src/attendance/__tests__/w7-w6r5-guard-root-set.test.ts \
    tests/unit/source-files-no-raw-control-bytes.test.ts \
    tests/unit/approval-cancel-round-plugin-mirror-constant.test.ts
  Test Files  5 passed (5)
        Tests  46 passed (46)
```

---

## 3. 判据 IV — the C-3 system close, `expired` half (this unit)

Lock §3 C-3 row 3 (「最终评估:窗口/策略已关」) + §14.2 判据 IV. Wired at census outlet **#5′**, the
new anchor this unit registers: `ApprovalProductService.dispatchAction`, immediately before the
terminal `UPDATE approval_instances SET status = $2 …` — the lock's 「先于任何终态状态写」, not
「先于完成事件入队」 (a hook on the enqueue misses the `return` branch, §11-③).

### 3.1 What landed

| Piece | Where | Lock clause |
|---|---|---|
| `deriveCancelRoundRoundPolicy` | `ApprovalProductService.ts` (module scope) | §4 `roundPolicy = { windowDays, suite }` — ONE derivation, now shared by `createCancelRoundInstance` and the final evaluation, so §5 I4's two snapshots cannot drift |
| `APPROVAL_CANCEL_ROUND_SYSTEM_ACTOR = 'system:approval-cancel-round'` | same | §3 C-3 「actor = 系统终结身份」; same `system:` prefix as the timeout/departure sentinels, so `isSystemSentinelActor` covers it by construction |
| `evaluateCancelRoundFinalInLock` | `ApprovalProductService.ts` | §3 C-2 step ③ 「锁内最终评估」; locks ② the round row and ③ the ORIGINAL document instance, in the lock's order |
| `closeCancelRoundSystemTerminalInTxn` | same | §3 C-3 「持久化收口」: seats, engine `rejected`, the audit row, round `expired`/`blocked` + `ended_at` + `block_reason` + `policy_snapshot_at_decision` |
| the branch + early `return` | same, at outlet #5′ | §14.2 判据 IV 「收口分支写完必须提前返回」 |

**Decisions taken here, each traced to a lock clause rather than to taste:**
- **Action verb is the EXISTING `reject`,** not a new one. §3 C-3 says the engine state 「复用现有
  `rejected`」 and that the system identity + reason are 「区分『审批人驳回』的唯一依据」. A new verb
  would also land on the repo's pinned action-union copies (attendance P26 among them).
- **The reason is queryable data, not prose.** `approval_records.metadata.cancelRoundCloseReason`
  = `round_expired` (or `business_blocked:<code>`), with `cancelRoundOutcome` and — on the
  `blocked` half — `cancelRoundBlockDetail` beside it. 「历史记录必须能查出来」 is a query
  requirement, so it is a key, not a sentence in `comment` (which stays null).
- **`policy_snapshot_at_decision` is written on the closure branch too.** §4 says 「在最终评估时同形
  写入」 — that is both branches, not only `applied`. The acceptance asserts the decision snapshot's
  key set equals the creation snapshot's.
- **The return copies `dispatchAction`'s own bottom return** (`getApproval` → 404 on null → return),
  which is what the lock's `:11227-11231` names — deliberately NOT the `(await …)!` non-null
  assertion the in-function branches above use.

### 3.2 The §2-G2 time anchor (the checklist's item 17)

The supplementary checklist flags 「§2-G2 时间锚,任务书均零映射」. The **lock does** define it —
§2-G2: 「时间锚固定为首次对应时间(撤销:初始轮 `approved_at`)…不随修订滚动」. `approval_instances`
has no `approved_at` column (`approval-bridge-types.ts:255-282` lists every column), so the anchor is
read off the document's own audit trail as `MIN(created_at)` of its `to_status = 'approved'` records
— `MIN` is 「首次」 and is what makes it 「不随修订滚动」. The comparison runs on the database clock
(`now()`), the same one every write on this path uses, so the fixture moves the **anchor**, not the
clock.

**Implementer choice, FLAGGED for owner registration** (the lock names the anchor but not its
absence): an `approved` document with no such record — a legacy/bridge row — makes the window
un-evaluable. This refuses to decide (`CANCEL_ROUND_WINDOW_ANCHOR_MISSING`, 409 ⇒ rollback ⇒ the
round stays `pending` with its seats, retryable) rather than closing the round as `expired`, which
would be irreversible on the strength of missing evidence. Same flag class as the redemption
suite's existing `erratum (not a lock quote — implementer choice…)` case.

### 3.3 ⛔ DEFECT SHIPPED AND FIXED IN-BRANCH: the #5′ hook deadlocked against round creation

**This is a defect commit `78d41fb4c` introduced and the follow-up commit fixes.** It is recorded
here rather than rewritten out of history, because the lock's own rule is 「census 未做前不实现」 and
I implemented a new lock pair before opening the census — the exact failure mode the lock names.

`evaluateCancelRoundFinalInLock` is the **first site in the tree that takes `FOR UPDATE` on an
`approval_rounds` row at all** (every other read of that table is unlocked; 判据 III's terminations
are bare `UPDATE`s). It takes that lock in the same transaction as a `FOR UPDATE` on the ORIGINAL
document instance — a **{row lock, row lock}** pair across two tables that no census leg had a
denominator for (Q-A/Q-B/Q-C are all {row lock, advisory lock}).

The counterparty is `createCancelRoundInstance`, which locks the original document **first** and only
then INSERTs into `approval_rounds`. That INSERT is the hidden second edge: the partial unique index
`uq_approval_rounds_pending_document … WHERE outcome = 'pending'` makes it **wait on any uncommitted
change to that document's pending round**. `78d41fb4c` had the closer take the round row first ⇒ a
cycle.

Constructed on `metasheet2_lock_c2` against the shipped code, two connections, real rows:

```
REVERSED  (closer: round -> doc, AS SHIPPED IN 78d41fb4c)  = { a: 'A:23505', b: 'B:40P01 deadlock detected' }
SHIPPED   (closer: doc -> round, after the fix)            = { a: 'A:23505', b: 'B:closed' }
```

`40P01 deadlock detected`, deterministic. Not a timing curiosity: A's 23505 is the *correct*
outcome in both runs (it is what `createCancelRoundInstance` already translates into
`CANCEL_ROUND_ALREADY_PENDING`); only B differs.

**Fix**: the evaluator now reads `document_id` from the round row **without a lock**, locks the
**ORIGINAL DOCUMENT INSTANCE first**, then takes the round row `FOR UPDATE` as the authority, and
cross-checks `round.document_id === original.id` so the unlocked probe cannot mislead the locked
read.

The unlocked probe is only sound if `document_id` is immutable, and that is **load-bearing**: a
writer that could change it would send the lock to the wrong document row, and the cross-check
would then turn a live cancel round into a 409 instead of closing it. So it is measured, not
asserted — the first version of this comment cited a grep it had never run:

```
$ git grep -nE "UPDATE approval_rounds" -- packages plugins scripts
…/ApprovalProductService.ts:8632    <- this very comment, not a statement
…/ApprovalProductService.ts:8808    <- the C-3 closure (outcome, ended_at, block_reason, policy_snapshot_at_decision)
…/ApprovalProductService.ts:10929   <- 判据 III revoke   (outcome, ended_at)
…/ApprovalProductService.ts:11416   <- 判据 III reject   (outcome, ended_at)
…/approval-cancel-round-lock-order-census.db.test.ts:773, :811   <- tests
…/approval-cancel-round-redemption.db.test.ts:489                <- test

$ git grep -nE "SET .*document_id|document_id *=" -- packages/core-backend/src plugins | grep -v WHERE
(no output)
```

**THREE** production writers, all setting only `outcome`/`ended_at` (+ the closure's two extra
columns); **ZERO** assignments to `document_id` anywhere in `src` or `plugins`.

**Census**: the pair is now a real leg — **Q-D** in
`tests/integration/approval-cancel-round-lock-order-census.db.test.ts`, three cases in the same
technique as Q-A/Q-B: the reversed order proven to deadlock (`40P01`, the standing proof), the
shipped order proven not to *and* both sides asserted to reach a defined outcome, and a both-ends-
anchored source scan of `evaluateCancelRoundFinalInLock` asserting the document lock precedes the
round lock in production code. Suite: **13 passed (13)**, up from 10.

### 3.3b ⚠️ Open blocker for 判据 II: the rollout advisory lock cannot be ordered at this hook

Recorded now because it is a property of **this** wiring site, not of the next unit's code.

Lock §3 C-2 fixes the global order **rollout/advisory 锁 → 轮次引擎实例 → 原单据实例 → …**, and the
W4 external entry states the same obligation ("the caller already holds this org's class-`00`
rollout SHARED advisory lock, **taken BEFORE any row lock it holds**").

`dispatchAction` opens `BEGIN` and *immediately* takes `approval_instances … FOR UPDATE` with no
prior read:

```
$ (packages/core-backend) awk '/^  async dispatchAction\(/,/FOR UPDATE`,/' src/services/ApprovalProductService.ts \
    | grep -nE "BEGIN|pool.connect|FOR UPDATE"
10:      client = await pool.connect()
11:      await client.query('BEGIN')
14:        `SELECT * FROM approval_instances WHERE id = $1 AND COALESCE(source_system, 'platform') = 'platform' FOR UPDATE`,
```

Three statements: connect, `BEGIN`, row lock. Nothing between `BEGIN` and the `FOR UPDATE`.

So any advisory lock taken at the #5′ hook is taken **after** a row lock. That violation is
**invisible to the entry's own check**: `assertExternalTransactionRolloutLockHeldV1`
(`w4c3b-request-operation-boundary.ts:558-578`) queries `pg_locks` for *held-ness* only —
`granted`, `objsubid = 1`, `mode IN ('ShareLock','ExclusiveLock')` — and has no notion of
acquisition order. It would **PASS** while the global order is broken. This is exactly the shape the
repo has a deterministic-deadlock precedent for (#4899), so it is not a theoretical tidiness point.

The `expired` / `blocked` closures never call W4, so nothing in **this** unit needs the advisory
lock. 判据 II does, and the fix is a restructure of `dispatchAction`'s entry, not a line at the
hook: a cheap **non-locking** pre-read to detect a cancel round → take the org's rollout shared lock
→ only then `FOR UPDATE` → and a fail-closed re-assert after the row lock (the pre-read is advisory,
so a stale one must not be able to skip the lock silently). Deriving the org id at that point is its
own hazard — this repo has a live attendance `org` fall-through to `'default'`. **Not attempted
here; 判据 II must start from it.** The in-code note lives on `evaluateCancelRoundFinalInLock`.

### 3.3c 判据 II's org question, answered with rows — census Q-E (this unit)

§3.3b named the rollout-lock ordering as 判据 II's prerequisite and said 「判据 II must start from
it」. Starting from it turned up a question §3.3b had not asked, and whose answer decides what the
`dispatchAction` pre-read must SELECT: **which org is the rollout lock keyed by?** The lock's own
rule is 「census 未做前不实现」 — §3.3 is the in-branch scar from breaking it — so it is settled here,
with rows, before the restructure.

**The intuitive answer is wrong.** `approval_instances.org_id` is the column the approval side
thinks in: `createCancelRoundInstance` copies `original.org_id` into the round
(`ApprovalProductService.ts:8514`), and it is one hop from the instance `dispatchAction` already
loads. But the demand does not come from the approval side. It comes from

```
w4c3b-request-operation-boundary.ts:814
  await assertExternalTransactionRolloutLockHeldV1(trx, identityPrepared.orgId)
```

— the org the **adapter** resolved in `prepareIdentity`, whose interface contract restricts it to
「durable route identity (for example request org/subject)」, i.e. the `attendance_requests` row.
The entry's own input type carries no `orgId` field at all, so the caller cannot declare one.

**Q-E**, four legs appended to the already-wired
`tests/integration/approval-cancel-round-lock-order-census.db.test.ts` (13 → **17 passed (17)**):

| Leg | What it establishes |
|---|---|
| 1 | On the exact row shape a cancel round runs on, `approval_instances.org_id` and `attendance_requests.org_id` **can hold different values**, and they derive **different class-`00` keys** through the real production builder. A pre-read on the instance column would take key(A) while the entry demands key(B) ⇒ `W4C3B_REQUEST_EXTERNAL_TRANSACTION_ROLLOUT_LOCK_NOT_HELD` (500) |
| 2 | POSITIVE CONTROL for leg 1's inequality — the same org derives the same key, so leg 1 is a real divergence and not a builder that never repeats |
| 3 | The repo's **two** existing instance→request joins **disagree**. Calls the REAL `classifyAndLockAttendanceRequestForInstance` (not a transcription of its SQL) against the LEFT JOIN in `filterBulkReassignDiscoveryForAttendance` (`w4c3b-central-approval-hooks.ts:452-463`) on a two-candidate fixture: the classifier pins row B by an explicit `ORDER BY … LIMIT 1`; the LEFT JOIN returns **both** rows and its consumer folds them into a Map keyed by instance id, so whichever row Postgres hands back last silently wins |
| 4 | Source scan, both ends anchored: the assert is fed `identityPrepared.orgId`, the `prepareIdentity` call **precedes** it, and the entry's input type contains no `orgId` |

Leg 3 is why 「reuse the existing helper」 was not an executable instruction: there are two helpers
and they answer differently. Per
`feedback_single_definition_does_not_make_a_narrow_predicate_correct.md`, picking one by name would
have inherited its predicate silently.

**Mutation ledger (this unit).** Both probes `cp`-backed up, applied to PRODUCTION source, run
alone, restored, `cmp`-verified clean.

| # | Mutation | Expected | Observed |
|---|---|---|---|
| M-9 | boundary: `assertExternalTransactionRolloutLockHeldV1(trx, identityPrepared.orgId)` → `(trx, input.correlationId)` | leg 4 red, and only it | **exactly 1 red**, leg 4: `AssertionError: expected 'async function runRequestOperationPro…' to contain 'await assertExternalTransactionRollou…'`; 16 green |
| M-10 | classifier: delete the business-key preference from its `ORDER BY` (keep `created_at ASC`) | leg 3 red, and only it — proving it binds to the REAL production ordering, not a copy | **exactly 1 red**, leg 3, on the named symptom: `AssertionError: expected 'b492baab-…' to be 'ebd946e5-…'`; 16 green |

M-10 is the one that matters: an earlier draft of leg 3 re-typed the classifier's SQL into the test,
which would have gone on passing while production drifted. It now calls the function.

**Immutability censuses** (the pre-read will sit OUTSIDE the transaction, so its soundness rests on
these — commands and counts, not recollection):

```
$ git grep -nE "UPDATE approval_instances" -- packages plugins scripts | wc -l
97
$ git grep -nE "SET [^;]*workflow_key|workflow_key *=" -- packages/core-backend/src plugins \
    | grep -v WHERE | grep -v "\.test\." | wc -l
9
$ git grep -nE "SET [^;]*org_id|org_id *= *EXCLUDED" -- packages/core-backend/src plugins \
    | grep -v "/migrations/" | grep -v "\.test\." | grep -v WHERE | wc -l
4
```

- **`workflow_key`** — of the 9 hits, exactly **two** are real writers, both `ON CONFLICT DO UPDATE`
  upserts, and **neither can address a cancel-round row**: `ApprovalBridgeService.ts:1404` conflicts
  on `(source_system, external_approval_id) WHERE external_approval_id IS NOT NULL` and a cancel
  round is inserted with `external_approval_id = NULL`; `plugins/plugin-attendance/index.cjs:24336`
  conflicts on `(id)` with an id the attendance plugin mints for its own request instance. The
  remaining 7, enumerated rather than summarised (I miscounted them once — the first draft of this
  sentence called one of them a `SELECT`): a predicate (`hooks:37`), a join condition
  (`hooks:457`), two comments (`migration…110000:244`, `ApprovalProductService.ts:8331`), a
  `WHERE`-clause builder (`ApprovalBridgeService.ts:466`), and **two writes to a DIFFERENT column**
  — `attendance_requests.approval_workflow_key` (`migration…110000:285`,
  `plugins/plugin-attendance/index.cjs:34819`), which is the FK mirror, not
  `approval_instances.workflow_key`. ⇒ for the cancel-round pre-read, `workflow_key` is
  **effectively immutable**, and the post-lock re-assert on it is belt-and-braces.
- **`attendance_requests.org_id`** — **4** `org_id = EXCLUDED.org_id` writers in the attendance
  plugin's upserts. Nothing pins them to the approval instance's stamp. ⇒ the org half is **NOT**
  immutable, so the post-lock re-assert on the org is **LOAD-BEARING**, not cosmetic. This is the
  distinction §3.3's `document_id` census got to answer the other way; it does not carry over.

**What 判据 II must therefore do** (revises §3.3b's last paragraph, which said only 「a cheap
non-locking pre-read to detect a cancel round」):

1. The pre-read must run **before `BEGIN`** — PostgreSQL fixes the isolation level at the
   transaction's first statement, and the entry requires SERIALIZABLE
   (`assertExternalTransactionIsolationV1`), so a pre-read inside the transaction would foreclose
   `BEGIN ISOLATION LEVEL SERIALIZABLE`.
2. It must resolve the org through **`attendance_requests`**, three hops (round instance →
   `business_key` → original document instance → request row), not from either instance's
   `org_id`.
3. It must reuse ONE predicate for that last hop rather than minting a third — and leg 3 says the
   two candidates are not interchangeable. **Naming the default now, rather than leaving a slot the
   next unit fills by convenience**: `classifyAndLockAttendanceRequestForInstance` is the predicate
   the LOCKING path already uses, so the pre-read adopts **it**. Leg 3 shows the other one ADMITS an
   org the classifier REJECTS, so adopting it would widen what the pre-read accepts — a
   contract-shaped change under
   `feedback_second_narrower_artifact_is_contract_narrowing.md` (same rule, opposite direction), and
   therefore an owner escalation, not an implementation choice.
4. The re-assert after the row lock must fail **closed** on an org mismatch (load-bearing, per the
   census above), with a named values-free code.

None of that is implemented in this unit. Q-E is the census; the restructure is the next one.

**What leg 1 does and does NOT establish.** It stamps the two orgs differently by hand, so it proves
divergence is REPRESENTABLE and that the key builder discriminates it — enough to reject
`approval_instances.org_id` as the pre-read source. It does **not** exhibit a real cancel round that
has diverged. Chasing that one hop further (this was going to be the next unit's first grep; it is
cheap enough to have done here) makes the answer sharper than "nothing pins them":

```
$ grep -n "deriveAttendanceApprovalOrgStampV1" plugins/plugin-attendance/index.cjs
14405:  async function deriveAttendanceApprovalOrgStampV1(client, orgDerivation)
24322:  const stampOrgId = await deriveAttendanceApprovalOrgStampV1(client, payload.orgDerivation)
```

`approval_instances.org_id` is stamped by
`port.deriveApprovalInstanceOrgIdForAttendanceSubjectV1({ subjectUserId, requestNamedOrgId })` — a
**SUBJECT-based** derivation (which org the user belongs to, plus a permitted named selector). It
does not read the `attendance_requests` row's `org_id`. So the two columns are **two independent
derivations that happen to agree**, not one copied from the other with a drift window afterwards.

That is a strictly stronger reason to use the request row: agreement is not structurally guaranteed
at creation either, so the re-assert is load-bearing against a routine mismatch and not only against
the 4 `EXCLUDED` writers. **Not claimed**: that production rows actually diverge today — that would
need a query over real data, which this private DB does not have.

### 3.3d ⚠️ Registered, not buried: a live nondeterminism found by leg 3

Leg 3 uses `filterBulkReassignDiscoveryForAttendance` as the second of two disagreeing predicates.
On its own terms it is also a **defect in a production path unrelated to this lock**, and it is
recorded here explicitly so it is not discovered-and-buried inside a cancel-round census table.

`w4c3b-central-approval-hooks.ts:452-463` LEFT JOINs `attendance_requests` with no
`approval_instance_id IS NULL OR = i.id` safety clause, **no `ORDER BY` and no `LIMIT`**. When one
approval instance has more than one candidate request row, the query returns them all, and the
consumer folds them into a `Map` keyed by instance id — so **whichever row Postgres hands back last
silently wins the org**. Leg 3 demonstrates it with rows: two candidates, two different orgs, both
returned.

Why it is worth someone's time: the org it resolves is what gates the bulk-reassign authorization
decision downstream, and this repo already has a registered finding for the shape 「two
authorization sources diverging」
(`finding_attendance_two_authorization_sources_diverge.md`). A nondeterministic org resolution on an
authorization path is the same family.

**Scope**: OUT of this lock. The cancel-round pre-read adopts the classifier (§3.3c point 3), so
nothing on this branch depends on the buggy predicate, and changing it would be an
attendance-line behaviour change with its own census. **Owed**: a one-line finding handed to the
attendance line — not a fix on this branch. Flagged here as an open handoff, not as work done.

**Not claimed here**: that `dispatchAction`'s restructure is safe. It changes the isolation level
for cancel-round dispatches, which admits `40001` serialization failures on a path that has never
seen them — whether `dispatchAction`'s catch maps `40001` to a named code or lets it surface as a
bare 500 is **unchecked** and is the next unit's first question.

### 3.4 Acceptance — where it lives, and why not in a new file

Appended to the already-wired `tests/integration/approval-cancel-round-redemption.db.test.ts`
(6 → 8 cases) rather than a new `.db.test.ts`. A new file would owe: the `plugin-tests.yml`
workflow list and an s6a provenance re-pin (items 3 / 14). (⚠️ CORRECTED, §0 R-6: earlier revisions
of this sentence also named a 「hard-coded `FILES` array」 in `scripts/ops/ci-realdb-step-contract.mjs`
— there is none. `:99-102` is a frozen map of two STEP IDS, and the file population is derived from
the workflow at check time. That script owes nothing for a new file.) None of that buys coverage this fixture already gives.
**Zero new files and zero workflow edits in either of this unit's two commits** — the follow-up
commit modifies the existing `approval-cancel-round-lock-order-census.db.test.ts` (Q-D, §3.3) and
the same two files again — so the four attendance census pins and the s6a pin are untouched:

```
$ git show --name-only --format= 78d41fb4c   # 3 files, 0 *.yml / *.json
docs/development/approval-cancel-round-phase2-verification-20260918.md
packages/core-backend/src/services/ApprovalProductService.ts
packages/core-backend/tests/integration/approval-cancel-round-redemption.db.test.ts
```

**The two cases are an isolated pair** — identical fixture, identical action, identical route, with
exactly ONE field different (the original document's `windowDays`: the `leave` default 90 vs. an
explicit 365), both with the §2-G2 anchor moved 200 days into the past. A difference in outcome can
therefore only be the window predicate. Without the second case, "the round closed as `expired`"
would be equally satisfied by an implementation that closes *every* cancel-round approve.

```
$ (packages/core-backend) npx tsc --noEmit -p tsconfig.json
  (no output, exit 0)

$ (packages/core-backend) EXPECT_DB=1 \
  DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c2 \
  ATTENDANCE_TEST_DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c2 \
  npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-cancel-round-{creation,outlet-guards,seat-guards,redemption,node-timeout-effect}.db.test.ts
  Test Files  5 passed (5)
        Tests  28 passed (28)          (redemption: 6 -> 8)

$ (packages/core-backend) npx vitest run tests/unit
  Test Files  796 passed (796)
        Tests  12742 passed (12742)
```

### 3.5 「零完成事件」 is measured on a channel proven live, not on an inert one

The durable outbox is flag-gated and **empty either way** in this lane, so an outbox count would
have had zero discriminating power for 判据 IV's 「零完成事件」. The assertion therefore counts the
channel that is ACTIVE with the flag off — `emitApprovalCompletionEvent` →
`eventBus` (`ApprovalCompletionEvent.ts:124-138`: `if (isDurableDeliveryEnabled()) return`, else
`eventBus.emit`) — subscribing to all four `approval.{approved,rejected,revoked,cancelled}` types
and filtering on this instance id. The paired open-window case observes **exactly one**
`approval.approved` through the same subscription, which is the positive control that makes the
closure case's `[]` a measurement rather than a dead listener.

### 3.6 Mutation ledger (this unit)

Every probe: `cp` backup → edit → run → `cp` restore → `cmp`. **Four** probes in this unit
(M-5…M-8); all four restores verified identical — `RESTORED-IDENTICAL` printed each time. (The
「three」 in §2.4's ledger refers to that unit's own three probes, not to these.)

| # | Mutation | Expected | Observed |
|---|---|---|---|
| M-5 | **the lock's own 判据 IV negative control** — delete the closure branch's early `return` (`return closedApproval` → `void closedApproval`), keeping every write | the status is overwritten back to `approved` **and** a completion event appears ⇒ the 判据 IV case red, nothing else | **exactly 1 red**, and on the named symptom: `AssertionError: expected [ 'approval.approved' ] to deeply equal []`; 7 green |
| M-6 | delete `deactivateAllActiveAssignments` from the closure | the seat assertion red | **GREEN — the mutation is INEFFECTIVE.** See below; the assertion is reclassified, not kept as if it had passed a probe |
| M-7 | round write `outcome = evaluation.decision` → hard-coded `'rejected'` (collapse `expired` into 判据 III's outcome) | the round-outcome assertion red, and only it | **exactly 1 red**: `AssertionError: expected 'rejected' to be 'expired'`; 7 green |
| M-8 | reverse the evaluator's lock order back to round-row-first (the shape `78d41fb4c` shipped) | the Q-D source-scan leg red, and only it | **exactly 1 red**: `AssertionError: expected 1841 to be less than 1650`; 12 green |

**M-6 is a finding, not a footnote.** Removing the closure's own seat release leaves the acceptance
GREEN, because every approve mode already deactivates the acting seat before the terminal advance
is reached (`ApprovalProductService.ts:11470` for `'all'`, the mode §14.1 gives the cancel-round
definition) and a terminal resolution has no later node's seats yet. So on the paths reachable
today that call is **defence in depth, not the cause of the released seat**. Consequences, both
taken: the acceptance's 席位失效 line is documented **in the test** as an end-state check with no
discriminating power for that statement, and the call is **kept** (a mode that left a seat active
would otherwise close a round with a live assignment, and dropping it would make this closure differ
from the approver-reject terminal it mirrors). Recorded rather than quietly deleted, because
"the seat assertion passed" would otherwise read as evidence the closure releases the seat.

### 3.7 C-3's five rows — what is and is not covered

Stated per-row so 「五种情形逐行落测试」 is not inflated by this commit.

| C-3 row | Outcome | Status |
|---|---|---|
| 审批人驳回 | `rejected` | **covered — phase 1**, 判据 III (this file's `chain` case) |
| 发起人撤回本轮 | `withdrawn` | **covered — phase 1**, 判据 III (same case) |
| 最终评估:窗口/策略已关 | `expired` | **covered — this unit** |
| 最终评估:业务不可逆 | `blocked` | **covered — §3.11.6** (updated; this row read 「NOT covered」 before the redemption hook landed). Produced by C-1's `business_refused` return and written by the SAME `closeCancelRoundSystemTerminalInTxn` the `expired` cause uses. Caveat: driven through a test double, not the real boundary — §4 |
| 基础设施异常 | stays `pending` | **covered through #5′** — the `CANCEL_ROUND_WINDOW_ANCHOR_MISSING` case drives the throw from inside the evaluator and asserts the full rollback shape: 409 with the NAMED code, round still `pending` with `ended_at` null, instance still `pending`, the seat still active (count 1), zero completion events. The two `CANCEL_ROUND_INVARIANT_VIOLATION` throws take the same path by construction but are not separately driven through #5′ |

---

### 3.8 卡片失效 (C-3 row 3's third column) — grepped, not assumed

C-3 情形 3 requires 「席位失效、**卡片失效**、端点返回一致」, and the lock's stated reason for
rejecting 可恢复阻塞 is 「避免旧卡仍可提交」. The closure does **not** call
`supersedeCardDeliveriesPostCommit`, so this had to be settled rather than waved past:

```
$ git grep -nE "INSERT INTO [a-z_]*card_deliver" -- 'packages/**' 'plugins/**' | grep -v tests/
packages/core-backend/src/integrations/dingtalk/approval-card-deliveries.ts:112

$ git grep -n "insertDingTalkApprovalCardDelivery" -- packages/core-backend/src plugins | grep -v approval-card-deliveries.ts
packages/core-backend/src/multitable/automation-executor.ts:104   <- the import
packages/core-backend/src/multitable/automation-executor.ts:4849  <- the ONE call site

$ git grep -n "supersedeCardDeliveriesPostCommit" -- packages/core-backend/src
…ApprovalProductService.ts:11993   <- the ONE production call (the approve fall-through)
…ApprovalProductService.ts:12640   <- its definition
```

So: cards are DingTalk-only, written by exactly one production writer, reached through exactly one
call site — the **multitable automation executor**. Nothing in the cancel-round path creates one;
a cancel round gets a card only if an org configured an automation that fires on its
`task_created`. **Not vacuous, therefore, but not automatic either**, and the gap is **pre-existing
rather than introduced here**: the approver-reject terminal this closure mirrors does not sweep
cards either (the sweep has exactly one caller, on the approve fall-through). Registered as an
open item for the #5′ registration, not silently inherited — if an org's automation cards a cancel
round, an `expired` close leaves a still-`sent` card, which is the thing 「避免旧卡仍可提交」 names.

---

---

## 3.9 判据 II's prerequisite, IMPLEMENTED: the `dispatchAction` entry restructure (this unit)

§3.3b registered this as 判据 II's blocker and §3.3c answered its org question with rows. This unit
builds the restructure those two describe. **判据 II itself is still not implemented** — no W4 call,
no `outcome = 'applied'`, no `blocked` half. What lands here is only the thing that made them
impossible: the global lock order at the hook.

### 3.9.1 What landed

| Piece | Where | Lock clause |
|---|---|---|
| `classifyAttendanceRequestForInstanceV1(client, instance, { lock })` | `w4c3b-central-approval-hooks.ts` | §3 C-2 — the ONE instance→request predicate, now with the lock mode as a parameter |
| `classifyAndLockAttendanceRequestForInstance` → a thin wrapper pinning `lock: 'for_update'` | same | pure extraction: every existing caller keeps its behaviour with no call-site edit |
| `resolveCancelRoundRolloutLockRequirementV1` | `ApprovalProductService.ts` | §3 C-2 — 「does this dispatch take the rollout lock, and on WHICH org key?」, three hops per §3.3c |
| pre-read before `BEGIN` + conditional `BEGIN ISOLATION LEVEL SERIALIZABLE` + the rollout lock as the transaction's FIRST lock | `dispatchAction` | §3 C-2 全局锁序 `rollout/advisory → 轮次引擎实例 → 原单据实例` |
| fail-closed re-assert after the instance row lock (`CANCEL_ROUND_ROLLOUT_LOCK_SCOPE_CHANGED`, 409) | same | §3.3c point 4 — load-bearing, because `attendance_requests.org_id` is NOT immutable |
| `CANCEL_ROUND_DISPATCH_CONTENDED` (503) for 40001/40P01, scoped to the `required` branch | same | the new error surface this restructure opens |

### 3.9.2 TWO axes, not one — and the second was nearly missed

⚠️ **RETRACTION of this section's first draft.** It framed the resolver's narrowness as ONE axis
(attendance-owned or not) and said so in the commit message of `a81c28d97`. That is **wrong, and it
shipped**: the resolver as first written took only the instance id, so for a cancel round over an
attendance-owned original **every** action resolved `required` — `approve`, but also `reject`,
`revoke`, `comment`, and the five verbs `assertCancelRoundActionAllowed` refuses.

The consequences, none of which 判据 II is entitled to change, because they are phase-1-delivered
判据 III behaviour:

- 判据 III's revoke/reject terminate the round row with a bare `UPDATE approval_rounds` — no W4
  call, no attendance write. They would have moved to SERIALIZABLE and acquired an org-wide
  advisory lock they have never needed.
- They would have gained a `40001` failure mode, surfacing as the new 503 below, on a path that
  previously either succeeded or failed deterministically.
- A **forbidden verb** would take an org-wide advisory lock and open SERIALIZABLE *before*
  `assertCancelRoundActionAllowed` rejects it — the cheapest possible refusal made to contend with
  the attendance rollout exclusive lock.
- The re-assert's 409 `CANCEL_ROUND_ROLLOUT_LOCK_SCOPE_CHANGED` would have been sequenced *before*
  `assertCancelRoundActionAllowed`, so on org drift a forbidden verb would answer with the scope
  code instead of §14.3 #4/#6's lock-anchored outlet-guard code.

§3.9.6's 「零行为变化」 argument covered only NON-cancel-round dispatches. The
cancel-round-but-not-approve population is precisely what it missed, and precisely where the
widening landed. **Fixed in this branch** (follow-up commit): `action` is a parameter, checked
FIRST — before any query — and only `approve` can resolve `required`. `action === 'approve'` is the
tightest predicate available before `BEGIN`: terminality is not knowable until the executor runs
inside the transaction, and over-locking a non-terminal approve is harmless. **Q-F leg 5** is the
control, and it carries its own positive control on the same fixture so a green `none` cannot mean
「this fixture never demanded a lock」.

### 3.9.2b ONE predicate, evaluated twice — the asymmetric trap, named

The pre-read and the re-assert are **the same function called twice**, never two hand-written
conditions. The failure mode if they diverge is silent and one-directional: a re-assert that asked
the WIDER question 「is this a cancel round?」 would fail closed on a **non-attendance** cancel round
— a legitimate round that can never be decided again. **Q-F leg 2 is that control**: a cancel round
whose ORIGINAL is not attendance-owned, built by the same seeder as leg 1, must resolve
`{ kind: 'none' }`.

That fixture also turned up a schema fact worth recording rather than widening past:
`attendance_requests` carries a COMPOSITE FK `(approval_instance_id, approval_workflow_key) →
approval_instances (id, workflow_key)` (`attendance_requests_instance_workflow_fkey`). The first
draft of leg 2 moved only the instance's column and was refused with `23503`, so 「一个字段之差」 is
not literally available on this table; the seeder feeds both columns and the test's own comment
says so.

### 3.9.3 The 40001 question §3.3d left open, ANSWERED

§3.3d said whether `dispatchAction` maps `40001` 「is unchecked and is the next unit's first
question」. Checked, mechanically, on this tree:

```
$ (packages/core-backend) grep -rn "40001\|serialization_failure\|SERIALIZABLE" src/services/ApprovalProductService.ts
(no output — ZERO hits before this unit)
```

Nothing mapped it, and `dispatchAction`'s catch is a bare `await rollbackQuietly(client); throw
error`. So a 40001 would have surfaced as an unmapped 500 on a path that had never produced one.

**Decision, and its scope.** The mapping is added, and **gated on `rolloutLock.kind === 'required'`**
— only the branch this restructure newly puts under SERIALIZABLE (and newly gives an advisory lock
edge) can raise either code because of it. A non-cancel-round dispatch keeps the bare rethrow it
had, byte for byte. That gate is deliberate: `40P01` was already reachable on the ordinary path,
and mapping it repo-wide would be a retry-semantics change to the hottest approval endpoint
smuggled in under a cancel-round commit (`feedback_retry_semantics_not_verbs.md`). The predicate is
the repo's single one, `isRetryableSqlState` — exported by `w4c0-operation-registry.ts` precisely so
two layers cannot drift.

**Second new surface, disclosed not fixed:** `acquireAttendanceCalculationRolloutLock` runs through
`acquireKeysWithDeadline`, which raises `AttendanceW4OperationError` /
`503 ATTENDANCE_CALCULATION_ROLLOUT_BUSY` on budget exhaustion. A cancel-round dispatch can
therefore now return a 503 it never could. That is the correct semantics (the org's calculation
rollout is genuinely busy), but whether the approval route surfaces that error object's status or
flattens it to 500 is **NOT verified here** — it is a route-layer question with its own fixture.
Registered as an open item, not claimed as working.

**`CANCEL_ROUND_DISPATCH_CONTENDED` is UNEXERCISED.** No test in this repo drives a real `40001`
into it; Q-F leg 6 is a SOURCE scan whose only job is to make deleting the mapping redden something
(M-15), which is the `finding_o2_x2_fix_site_has_zero_test_coverage.md` shape. The 「what landed」
table above must be read with that: the mapping is present and gated, not demonstrated at runtime.

### 3.9.4 Census Q-F — four legs, appended to the already-wired file

`tests/integration/approval-cancel-round-lock-order-census.db.test.ts`, **17 → 23 passed (23)**.
Still zero new `.db.test.ts`, so no `plugin-tests.yml` entry, no `ci-realdb-step-contract.mjs`
`FILES` edit, no s6a re-pin (§3.4's discipline, unchanged).

| Leg | What it establishes | How |
|---|---|---|
| 1 | The production resolver returns the **REQUEST row's** org, not the round's own `org_id` | drives the real exported `resolveCancelRoundRolloutLockRequirementV1` over the full three-hop fixture |
| 2 | A cancel round over a NON-attendance original demands **no lock at all** | the fail-closed-in-the-wrong-direction control (§3.9.2) |
| 3 | In `dispatchAction`'s source: pre-read **before both `BEGIN` forms**, rollout acquire **before** the instance `FOR UPDATE`, re-assert **after** it | source scan, slice anchored at BOTH ends (`async dispatchAction(` … its own `rollbackQuietly`) |
| 4 | The pre-read's `lock: 'none'` and the LOCKING wrapper resolve the **same row** on a two-candidate fixture | calls both real functions, not a transcription |
| 5 | On a fixture leg 1 resolves `required` for, **reject / revoke / comment / a forbidden verb demand no lock** — the ACTION axis (§3.9.2) | drives the resolver five times plus an `approve` positive control on the same fixture |
| 6 | The 40001/40P01 mapping exists, is **gated** on the `required` branch, and uses `isRetryableSqlState` | source scan of the catch block, both ends anchored |

Leg 3 is a **source-order** proof, and that is all it is: it does not show that a live concurrent
dispatch cannot deadlock against a counterparty. That needs Q-A/Q-D's two-connection technique
over a driveable cancel-round dispatch on an attendance-owned original — 判据 II's own fixture.
Stated here so the leg is not read as more than it is.

### 3.9.5 Mutation ledger (this unit)

Every probe: `cp` backup → edit PRODUCTION source → run alone → `cp` restore → `cmp`. All three
printed `RESTORED-IDENTICAL`.

| # | Mutation | Expected | Observed |
|---|---|---|---|
| M-11 | delete the business-key preference from the SHARED `ORDER BY` in `classifyAttendanceRequestForInstanceV1` | **TWO** legs red — Q-E leg 3 (the pre-existing binding) **and** Q-F leg 4 — which is the proof the pre-read binds to the same production predicate rather than a copy | **exactly 2 red**, exactly those two; 19 green |
| M-12 | resolver takes the org from the ORIGINAL INSTANCE's `org_id` instead of the request row's | Q-F leg 1 red, and only it | **exactly 1 red**, leg 1, on the named symptom: `AssertionError: expected 'e11508d7-…' to be '6ad22b46-…'`; 20 green |
| M-13 | move `acquireAttendanceCalculationRolloutLock` to AFTER the instance `FOR UPDATE` (the pre-restructure order) | Q-F leg 3 red, and only it | **exactly 1 red**, leg 3: `AssertionError: expected 2772 to be less than 1933`; 20 green |
| M-14 | delete the resolver's `if (action !== 'approve') return { kind: 'none' }` — i.e. restore the widened shape `a81c28d97` shipped | Q-F leg 5 red, and only it | **exactly 1 red**, leg 5, on the named symptom: `action reject must demand no rollout lock: expected { kind: 'required', …(3) } to deeply equal { kind: 'none' }`; 22 green |
| M-15 | delete the `CANCEL_ROUND_DISPATCH_CONTENDED` mapping from the catch | Q-F leg 6 red, and only it | **exactly 1 red**, leg 6; 22 green |

M-11 is the one that matters here, for the same reason M-10 mattered in §3.3c: it is the probe that
distinguishes 「the pre-read reuses the production predicate」 from 「the pre-read has a second copy
that agrees today」.

### 3.9.6 「零行为变化 for every other dispatch」 — what it cost, and what it does NOT claim

The pre-read runs on EVERY `dispatchAction`, so the claim needed measuring rather than asserting.
It cost **two unit-test mock edits**, and they are disclosed rather than buried:

- `tests/unit/approval-product-service.test.ts` — the shared `commonApprovalClientMockResult`
  whitelist raised `Unhandled query` on the new pre-read; **8 tests were red** before the mock knew
  about it.
- `tests/unit/approval-admin-jump-service.test.ts` — `mockDispatchQueriesForOldAssignee`, same
  cause, 1 test.

Both now return a real row carrying a NON-cancel-round `workflow_key`, which short-circuits the
resolver on its first query — exactly what production does for those fixtures. The three further
reads a cancel round would make are **deliberately left unmocked**, so a fixture that ever reached
them fails loudly instead of silently taking the `none` branch.

**This is a mock, not the contract** (`feedback_mock_is_not_the_contract.md`). Nothing about the
resolver's real behaviour is established by those files; Q-F legs 1/2 are where it is measured.

**NOT claimed**: that the extra round trip is free. Every dispatch now does one additional
primary-key lookup before `BEGIN` and one after the row lock (the re-assert). No latency
measurement was taken, and none is asserted.

### 3.9.7 Absolutes, each with its command

```
$ git grep -n "resolveCancelRoundRolloutLockRequirementV1" -- packages plugins scripts | grep -v tests/
…/ApprovalProductService.ts:899    <- the definition
…/ApprovalProductService.ts:10326  <- the pre-read
…/ApprovalProductService.ts:10354  <- the re-assert
```
⇒ **TWO** production call sites, both in `dispatchAction`, which is the 「one function called twice」
claim of §3.9.2 stated mechanically.

```
$ git grep -n "classifyAndLockAttendanceRequestForInstance" -- packages plugins scripts \
    | grep -v tests/ | grep -vE ":[0-9]+: *[*/]" | grep -v "^.*:16[23]:"
…/w4c3b-central-approval-hooks.ts:224  <- the wrapper's own definition
…/w4c3b-central-approval-hooks.ts:247  <- production call site 1
…/ApprovalProductService.ts:9329       <- production call site 2
```
⇒ **TWO** production call sites of the locking wrapper, **both unedited by this unit**.

```
$ git grep -c "CASE WHEN \$1::text IS NOT NULL AND id::text = \$1::text THEN 0 ELSE 1 END" \
    -- packages/core-backend/src plugins
packages/core-backend/src/attendance/w4c3b-central-approval-hooks.ts:1
```
⇒ **ONE** copy of the row-selection predicate in `src`/`plugins`. The parameterisation added a lock
mode, not a second query.

### 3.9.7b Two things checked rather than assumed

```
$ (packages/core-backend) grep -rn "function rollbackQuietly" -A 7 src/services/ApprovalProductService.ts
1535:async function rollbackQuietly(client: ApprovalDbClient | null): Promise<void> {
1536-  if (!client) return
1537-  try { await client.query('ROLLBACK') } catch { /* Ignore rollback errors … */ }
```
⇒ the pre-read now runs BEFORE any `BEGIN`, so a throw there reaches the catch with **no open
transaction**. `rollbackQuietly` swallows the resulting `no transaction in progress` and preserves
the original error. Clean, and it is why the pre-read needs no separate guard.

```
$ grep -n "id: 'pluginTestsWorkflow'" -A 2 plugins/plugin-integration-core/lib/sealed-export/sealed-export-package-provenance.cjs
298:    id: 'pluginTestsWorkflow',
300:      '.github/workflows/plugin-tests.yml',
$ shasum -a 256 .github/workflows/plugin-tests.yml
b048a17f3ef9687073587fc9fe6486377f5a5f9d11abad1119b9e4e788d7b0c0
$ grep pluginTestsWorkflow plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json
    "pluginTestsWorkflow": "b048a17f3ef9687073587fc9fe6486377f5a5f9d11abad1119b9e4e788d7b0c0"
```
⇒ the s6a pin hashes the **workflow file's own bytes**, not attendance source contents. This slice
changed zero `.yml`, the live hash equals the pinned one, so **no re-pin is owed** — the
`feedback_attendance_new_file_census_trio.md` trigger this slice could have tripped
(`src/attendance/w4c3b-central-approval-hooks.ts` was edited) does not reach this pin.

### 3.9.8 Commands and results

```
$ (packages/core-backend) npx tsc --noEmit -p tsconfig.json
  (no output, exit 0)

$ (packages/core-backend) EXPECT_DB=1 \
  DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c2 \
  ATTENDANCE_TEST_DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c2 \
  npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-cancel-round-lock-order-census.db.test.ts
  Test Files  1 passed (1)
        Tests  23 passed (23)          (17 -> 23)

$ … run tests/integration/approval-cancel-round-{creation,outlet-guards,seat-guards,redemption,\
      node-timeout-effect}.db.test.ts tests/integration/attendance-w4c3b-approved-leave-cancellation.db.test.ts
  Test Files  6 passed (6)
        Tests  34 passed (34)

$ (packages/core-backend) npx vitest run tests/unit
  Test Files  796 passed (796)
        Tests  12742 passed (12742)
```

---

## 3.10 判据 II's SECOND prerequisite, IMPLEMENTED: the cancel adapter's lock order (this unit)

§4's residual list said: 「§3 C-2 的全局序把 `attendance_requests` 排在原单据实例**之后**，而现有适配器
取 `attendance_requests → approval_instances(原单)` —— **相反** —— 锁说「现有适配器改为同序」。Q-D 的三腿
技术是模板；这些腿没有建。」 This unit builds them, and the reorder they were the prerequisite for.

Lock authority, quoted rather than paraphrased:
- lock:110 「建议全局顺序 **rollout/advisory 锁 → 轮次引擎实例 → 原单据实例 → `attendance_requests` →
  余额批次**，现有适配器改为同序」
- lock:227 the same as the row-lock class order: 「行锁(轮次实例 → 原单据实例 → `attendance_requests`
  → 计算/段 → 余额批次)」

### 3.10.1 What landed

| Piece | Where | Lock clause |
|---|---|---|
| the `approval_instances` (原单) `FOR UPDATE` + its prepare-snapshot comparison moved ABOVE the `attendance_requests` `FOR UPDATE` | `plugins/plugin-attendance/index.cjs`, `execute: async function executeRequestCancel` | lock:110 「现有适配器改为同序」, lock:227 |
| census **Q-G**, four legs | `packages/core-backend/tests/integration/approval-cancel-round-lock-order-census.db.test.ts` (appended) | §3 C-2 lock:111 「census not done before implementation」 |

Nothing else moved. The two `{ forUpdate: true }` helpers that sit between the two row locks —
`assertScheduleDispatchRequestScopeAllowed` → `loadScheduleDispatchDetail` (locks
`attendance_schedule_dispatch_requests`) and `loadLatestRequestSnapshotToken` (locks
`attendance_request_calculation_snapshots`) — stay where they are, i.e. after `attendance_requests`.
**FLAGGED for owner registration, not silently reordered around:** lock:227's class list names
「计算/段」 (which is where the calculation-snapshot relation plausibly belongs, and it is already
after `attendance_requests`) but names **no** schedule-dispatch relation at all, and Q-B's answer is
explicit that 「首期没有 class-11 就不要虚构它」 (lock:304). So this unit places only the pair the lock
names, and records the unclassified third relation as an open question rather than inventing a rank
for it.

### 3.10.2 The population, enumerated BEFORE the edit

Reordering one of N paths does not fix an order — it inverts one edge and can close a different
cycle. So the both-row population was counted first, mechanically:

```
$ git grep -n "attendance_requests[^;]*FOR UPDATE" -- plugins/plugin-attendance/index.cjs
plugins/plugin-attendance/index.cjs:8538:   (a comment, not a statement)
plugins/plugin-attendance/index.cjs:34751:  'SELECT * FROM attendance_requests WHERE id = $1 FOR UPDATE',
plugins/plugin-attendance/index.cjs:35110:  'SELECT * FROM attendance_requests WHERE id = $1::uuid FOR UPDATE',   <- cancel adapter
plugins/plugin-attendance/index.cjs:37596:  'SELECT * FROM attendance_requests WHERE id = $1 FOR UPDATE',        <- decision adapter
$ git grep -n "approval_instances[^;]*FOR UPDATE" -- plugins/plugin-attendance/index.cjs
plugins/plugin-attendance/index.cjs:35141:  <- cancel adapter
plugins/plugin-attendance/index.cjs:35578:  <- shift-swap consent rejection
plugins/plugin-attendance/index.cjs:37617:  <- decision adapter
$ git grep -n "attendance_requests[^;]*FOR UPDATE" -- packages/core-backend/src
(no output — the core side never writes this statement inline; it goes through
 `classifyAttendanceRequestForInstanceV1`, which is why the census calls that function
 rather than transcribing its SQL)
```

Three plugin sites take an explicit `attendance_requests … FOR UPDATE` (`executeRequestPendingEdit`
at `:34751`, the cancel adapter, the decision adapter) and three take an explicit
`approval_instances … FOR UPDATE`; **two** functions take BOTH (`executeRequestCancel`, the decision
adapter), and the shift-swap consent path takes `attendance_shift_swap_requests` +
`approval_instances`, not `attendance_requests`. Q-G LEG 4 pins those two counts (3 and 3) so a
fourth `FOR UPDATE` site cannot appear without reddening this census.

⚠️ **Scope of that enumeration, stated rather than left to be assumed** (memory:
`feedback_writer_audit_both_query_syntaxes.md`): it covers the **`FOR UPDATE` read syntax only**. A
bare `UPDATE` takes a row lock just as surely, and the plugin has more of those:

```
$ git grep -cn "UPDATE approval_instances" -- plugins/plugin-attendance/index.cjs
plugins/plugin-attendance/index.cjs:3
$ git grep -cn "UPDATE attendance_requests" -- plugins/plugin-attendance/index.cjs
plugins/plugin-attendance/index.cjs:5
```

Those 3 + 5 writer statements are **NOT** enumerated, **NOT** ordered by this commit, and are a
**residual**, not a cleared population. This unit implements lock:110's named pair on the named
adapter; a writer-syntax lock-order census over the whole attendance plugin is a separate piece of
work and is listed in §4.

**Only the cancel adapter was reordered.** The decision adapter is the approve/reject path and runs
only while the request is `pending` (`if (requestRow.status !== 'pending') throw INVALID_STATUS`),
so it is not on 判据 II's approved-document path; reordering it is an attendance-line change with its
own blast radius, and this slice does not take it. LEG 4 asserts it is **still** request-first, so
this block cannot be read as 「全仓已同序」 and a future reorder there is forced to update this file.

### 3.10.3 The cycle is LIVE, not a future one — and that is what LEG 1 constructs

Unlike Q-D (whose cancel-round side does not exist until 判据 II lands), **both** sides of this pair
are production code today:

- **core**: `classifyAndLockAttendanceRequestForInstance` locks `attendance_requests`, and every one
  of its call sites is reached with the `approval_instances` row already `FOR UPDATE`-held —
  `dispatchAction`'s entry read, `bulkReassignApprovals` (`ApprovalProductService.ts:9346`),
  `assertAttendanceCentralMutationFailClosed` (`w4c3b-central-approval-hooks.ts:247`). So core runs
  原单据实例 → `attendance_requests`.
- **plugin**: `executeRequestCancel` ran `attendance_requests` → 原单据实例.

Both are reachable on a **pending** request (a user cancelling it vs. a bulk reassign / admin jump
on its pending instance), i.e. on the same `(request, instance)` pair at the same time. LEG 1
constructs exactly that and it deadlocks **deterministically** with `40P01`. So this is a
pre-existing **live** defect, not only a 判据 II prerequisite.

⚠️ **What this commit does NOT do — and my own LEG 4 is the evidence against the stronger claim.**
The reorder closes that cycle **for the cancel path only**. The DECISION adapter
(`index.cjs:37596`/`:37617`) is *also* `attendance_requests → approval_instances`, and it is gated on
`requestRow.status === 'pending'` — which is precisely the population `bulkReassignApprovals`
reaches `classifyAndLockAttendanceRequestForInstance` on with the instance row already held. The
same cycle, same shape, therefore **remains live** via that adapter after this commit. Reordering it
is an attendance-line change with its own blast radius and is deliberately not taken here; LEG 4 is
what keeps it from being silently closed or silently forgotten. See §0 R-3 for the retraction of the
stronger wording that shipped in the commit message.

### 3.10.4 The four legs

| Leg | What it does | Kind |
|---|---|---|
| LEG 1 | core order vs. the PRE-FIX adapter order on one seeded `(request, instance)` pair ⇒ exactly one `40P01` | constructed race (standing proof) |
| LEG 2 | POSITIVE CONTROL — both sides in the SHIPPED order ⇒ no deadlock, **and** both sides reach a defined outcome (the core classification resolves; the adapter's request lock returns `rowCount === 1`), so 「no deadlock」 is not 「nothing happened」 | constructed race |
| LEG 3 | production source scan, anchored at both ends (`execute: async function executeRequestCancel(` … the adapter's own `SET status = 'cancelled', resolved_by = $2` write): the instance `FOR UPDATE` index is LESS than the request `FOR UPDATE` index | source scan |
| LEG 4 | the two site counts (3 and 3) + the decision adapter is still request-first | mechanical enumeration |

LEG 1 writes the pre-fix statement out by hand and **says so in the test**: the fix removed that
order from production source, so it cannot be driven through live code any more. That is a
disclosure, not a claim that the leg exercises production.

### 3.10.5 Mutation ledger (this unit)

⚠️ **Renumbered in the 2026-09-18 定稿 pass (§0 R-11): this section originally reused `M-11`/`M-12`,
already claimed by §3.9.5 for two different mutations. Now `M-33`/`M-34` — the underlying probes,
commands and results are unchanged; only the bare IDs moved.**

| # | Mutation | Expected | Observed |
|---|---|---|---|
| M-33 | restore the PRE-FIX `executeRequestCancel` (the whole file, `cp` from the pre-edit backup) and re-run Q-G | LEG 3 red; LEGs 1/2/4 still green | **RED exactly as predicted**: `AssertionError: 原单据实例 must be locked BEFORE attendance_requests: expected 1563 to be less than 238`, `Tests 1 failed | 3 passed | 23 skipped (27)`. Restored with `cp` and `cmp` proved byte-identical (`RESTORED-IDENTICAL`). |

| M-34 | in LEG 2 only, point the adapter at a **different** seeded `(request, instance)` pair, so the two sides contend with nothing | LEG 2 red — a "no deadlock" leg that never contended has proved nothing | **RED**: `Error: backend 55248 never blocked on a lock within 5000ms — the two sides did not contend, so this leg proved nothing`, `Tests 1 failed | 26 skipped (27)`. Restored with `cp`, `cmp` identical, full file back to 27 passed. |

LEG 1's own discriminating power needs no separate mutation: it is a constructed race that produces
a real `40P01`, and LEG 2 is its paired negative — the same harness, the shipped order, no deadlock.

⚠️ **M-34 caught a vacuous assertion of mine before it shipped, and that is worth recording.** LEG 2's
first contention proof was a JS-side `settled` flag flipped in `adapterRun.then(...)` and asserted
still `false` before the core side committed. M-34 left it **green**: with the adapter pointed at an
unrelated pair it finished immediately, yet the flag was still `false`, because the `.then` callback
had not been scheduled by the time the assertion ran. A first mutation attempt was also invalid —
dropping the core side's instance lock did not remove contention, it only moved it to the request
row (memory: `feedback_ineffective_mutation_looks_like_a_useless_test.md`). The shipped version asks
**PostgreSQL** instead: `expectBackendBlockedOnLock` polls `pg_stat_activity.wait_event_type = 'Lock'`
for the adapter's own backend pid and throws on timeout, which is what M-34 now reddens.

### 3.10.6 The one behaviour change, disclosed

When BOTH rows are mutated concurrently between `prepare` and `execute`, the 409 that surfaces is
now `'Approval changed during cancellation preparation'` where it used to be
`'Request changed during cancellation preparation'`. Same status (409) and same code
(`REQUEST_STATE_CONFLICT`); only the message differs, and only in a race. **No test asserts that
precedence** — checked before the edit rather than after a green:

```
$ git grep -rn "Request changed during cancellation preparation\|Approval changed during cancellation preparation" -- . ':!docs'
plugins/plugin-attendance/index.cjs:35117   (the throw itself)
plugins/plugin-attendance/index.cjs:35146   (the throw itself)
```

2 hits, both the production `throw`s; zero assertions. Secondary note, also disclosed rather than
argued away: the adapter now takes one row lock (the named request's own approval instance) before
`resolveRequestCancellationActorPosture` authorizes the actor. That is the same blast radius as the
`attendance_requests` row lock the adapter **already** took before that authorization call — this
unit did not create the pattern, and moving authorization above both locks is a larger restructure
than 「改为同序」 authorizes.

### 3.10.7 Two-point wiring / census

No new file and no `plugin-tests.yml` change ⇒ **no s6a re-pin**:

```
$ git status --short
 M docs/development/approval-cancel-round-phase2-verification-20260918.md
 M packages/core-backend/tests/integration/approval-cancel-round-lock-order-census.db.test.ts
 M plugins/plugin-attendance/index.cjs
```

The census file is already wired into CI (it carries the top-level `EXPECT_DB` sentinel and is in
the attendance real-DB step); Q-G is appended to it. The `index.cjs` change adds **no DML and no new
SQL statement** — it moves one existing `SELECT … FOR UPDATE` within the same enclosing function,
and the `w4c0-dml-inventory` classifiers key on the enclosing function name, not on line numbers:

```
$ grep -rln "35109\|35110\|35141\|35142" scripts/ packages/core-backend/tests/ .github/
(no output — no corpus pins a line number in index.cjs)
$ node --test scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs
  tests 60 | pass 60 | fail 0
```

### 3.10.8 Commands and results

```
$ node --check plugins/plugin-attendance/index.cjs
  (no output, exit 0)

$ (packages/core-backend) npx tsc --noEmit -p tsconfig.json
  (no output, exit 0)

$ (packages/core-backend) EXPECT_DB=1 \
  DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c2 \
  ATTENDANCE_TEST_DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c2 \
  npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-cancel-round-lock-order-census.db.test.ts
  Test Files  1 passed (1)
        Tests  27 passed (27)          (23 -> 27)

$ … run tests/integration/attendance-w4c3b-request-operation-routes.db.test.ts \
      tests/integration/attendance-w4c3b-approved-leave-cancellation.db.test.ts \
      tests/integration/attendance-w4c3b-central-approval.db.test.ts
  Test Files  3 passed (3)
        Tests  45 passed (45)

$ … run tests/integration/approval-cancel-round-{creation,outlet-guards,seat-guards,redemption,\
      node-timeout-effect}.db.test.ts tests/integration/attendance-schedule-dispatch.test.ts
  Test Files  6 passed (6)
        Tests  46 passed (46)

$ (packages/core-backend) npx vitest run tests/unit/attendance-w7-w6r5-preservation-guard.test.ts \
    tests/unit/attendance-w6-fser-single-source-caller-inventory.test.ts \
    src/attendance/__tests__/w7-w6r5-guard-root-set.test.ts \
    tests/unit/source-files-no-raw-control-bytes.test.ts \
    tests/unit/approval-cancel-round-plugin-mirror-constant.test.ts
  Test Files  5 passed (5)
        Tests  46 passed (46)
```

**One RED that is NOT this unit's, established by running the pre-fix file:**
`tests/integration/attendance-shift-swap.test.ts` fails 2 of 12 on this machine —
`AssertionError: expected '2049-06-13' to be '2049-06-14'` and
`expected '2049-06-14' to be '2049-06-15'`. Re-run with `plugins/plugin-attendance/index.cjs`
restored byte-identical to its pre-edit state: **the same two failures, same messages**. A
one-day date shift is a wall-clock/timezone artifact of this local testbed, not a lock-order
effect; the file is reported here rather than omitted from the run list.

---

## 3.11 判据 II, IMPLEMENTED: the redemption hook and its C-1 port (this unit)

Commit `08b7cbec3`. This is the unit §3.3b flagged as blocked and §3.9/§3.10 unblocked: both
prerequisites (the rollout advisory lock ordered at `dispatchAction`'s entry, the cancel adapter's
two row locks reordered) had landed, so the hook itself could finally be built.

### 3.11.1 The channel did not exist — and the repo's own shape for it did

There was no core←plugin direction at all. The forward one is well established
(`attendanceW4SegmentCalculationPort`: core exposes, plugin pulls — that is how the plugin builds
`w4RequestOperationBoundary` at `index.cjs:35767`), but approval calling INTO attendance had no
precedent in the attendance modules. Rather than invent one, the search was widened first:

```
$ git grep -n "register\|provide\|setPlugin" -- packages/core-backend/src/types/plugin.ts
  … packages/core-backend/src/types/plugin.ts:1201-1207
    T3-2 — host→plugin surface for binding the process-wide working-day calendar provider that the
    approval SLA path consults through the WorkdayCalendarPort.
```

That is exactly this direction, for exactly this consumer (the approval path), and it already has a
module: `core/workday-calendar-port.ts`. The new port is modelled on it line for line — a
single-provider singleton registry with `register` / `unregister` / `get` / `has` / `clear`, a
warning on replacement, and a convenience register/unregister pair.

| Piece | Where | Lock clause |
|---|---|---|
| `AttendanceCancellationExecutionPort` + its registry | `packages/core-backend/src/core/attendance-cancellation-execution-port.ts` (new) | §3 C-1 — 「审批侧只调用」 |
| `registerCancelRoundExecutionBoundary` on the W4 port | `types/plugin.ts`, wired in `index.ts` | the one-line host surface |
| the plugin's bind, right where the boundary is built | `plugins/plugin-attendance/index.cjs` (after `w4RequestOperationBoundary = …`) | — |
| `redeemCancelRoundInTxn` | `ApprovalProductService.ts` | §3 C-2 steps ④–⑤ |
| the `redeem` branch + the `blocked` hand-off | same, at outlet #5 | §14.2 判据 II, 判据 IV `blocked` half |

**The registered surface is the WHOLE boundary, not a cancel-only entry.** Lock §3 C-1 「接口形态」
says 「**外部事务入口复用同一套 W4 操作协议** … **仅移交连接与事务生命周期的所有权**——不是把
`requestCancelAdapter.execute` 搬出来单独调」, and review P1-A rejected precisely that shape. A
`cancelForApproval(...)` port would have re-introduced it under a new name, so the port TYPE is
`AttendanceRequestOperationBoundaryV1` itself and is deliberately not even narrowed to a `Pick<>`.

### 3.11.2 It fails CLOSED when unbound — the one deliberate divergence from the precedent

`workday-calendar-port.ts` fails OPEN (no calendar ⇒ natural elapsed arithmetic). Copying that here
would have been the worst defect in this slice: with no provider bound, the redemption would write
`approval_rounds.outcome = 'applied'` and take the engine instance to `approved` having performed
**zero business cancellation** — a round that says the leave was cancelled when it was not. Unbound
⇒ `ServiceError(409, 'CANCEL_ROUND_EXECUTION_PORT_UNAVAILABLE')` ⇒ the caller's transaction rolls
back ⇒ the round keeps `pending` and its seat: lock §3 C-3 row 5, the same shape
`CANCEL_ROUND_WINDOW_ANCHOR_MISSING` already takes. This is asserted, and the assertion is probed
(M-16 below), not merely written.

### 3.11.3 The org-key hazard, closed by CONSTRUCTION rather than by agreement

The entry asserts the rollout advisory lock on `identityPrepared.orgId` — resolved INSIDE the
boundary, by the cancel adapter's `prepareIdentity` → `loadRequestOperationIdentityRow`.
`dispatchAction` took that lock on `rolloutLock.orgId`, resolved by
`resolveCancelRoundRolloutLockRequirementV1` → `classifyAttendanceRequestForInstanceV1`. Census Q-E
leg 1 (§3.3c) already proved `approval_instances.org_id` and `attendance_requests.org_id` can hold
different values and derive different class-`00` keys, so "both read the request row's org" is NOT
by itself enough — it would still depend on both resolving the SAME request row, and Q-E leg 3
proved the repo already has two joins that disagree about which row that is.

So the call passes **both** `requestId` and `orgId`. `loadRequestOperationIdentityRow`
(`index.cjs:34602-34617`) branches on `route.orgId` and, when present, looks up
`WHERE id = $1::uuid AND org_id = $2`. Its returned `org_id` therefore cannot be anything but
`rolloutLock.orgId`; a request whose org moved in between 404s inside the entry instead of silently
asserting a different advisory key. (`dispatchAction`'s own `CANCEL_ROUND_ROLLOUT_LOCK_SCOPE_CHANGED`
re-assert, §3.9.1, already covers a move that happens before the row lock.)

⚠️ This is a **construction** argument about a query predicate, not a live end-to-end measurement.
It is strong precisely because it does not rest on two derivations agreeing — but the real boundary
has still never been run from this call site. See §4.

### 3.11.4 Two inputs pinned, one decision flagged

- **`operationId` = the round row's own id.** It must be a UUID (`normalizeInput` → `uuidOrNull`,
  `w4c3b-request-operation-boundary.ts:459`) and it is the W4 REPLAY key. A round passes outlet #5
  at most once (the `WHERE outcome='pending'` partial unique index, plus this method's `applied`
  write), so the round id makes a retry after a rolled-back attempt replay under the same key
  instead of minting a second operation.
- **`tokenSubjectUserId` = `actorId`.** Not a choice: `resolveRequestCancellationActorPosture`
  (`index.cjs:34878-34880`) 403s unless they are equal.
- **⚠️ FLAGGED FOR OWNER REGISTRATION — the acting identity.** Lock §3 C-1 fixes the audit row's
  shape (`action='revoke', from_status='approved', to_status='cancelled'`) but never says whose
  actor id it carries. This unit passes the **cancel round's requester**, for two reasons that are
  arguments rather than the lock's own words: (1) lock §8 期 1 demands the result be 逐字节等价 with
  the existing W4 path, whose actor is the person whose request it is; (2) the approver would be
  cross-user, and `prepareRequestCancelIdentity` would then demand `attendance_admin`
  (`resolveStableCrossUserPosture`), which an ordinary approver does not have — the branch would be
  dead for exactly the population it exists for. WI-16 guarantees the cancel round's
  `requester_snapshot.id` IS the original requester. An owner who wants the approver or a system
  sentinel there must say so.

### 3.11.5 What this unit does NOT write, on purpose

The redemption writes the round row and nothing else. 原单 `approved → cancelled`, its
`approval_records('revoke'/'cancelled')`, `reverseLeaveBalanceDeduction` and
`attendance.request.cancelled` all belong to C-1 — lock §3 C-1's 「`status` 只允许 `approved →
cancelled` 且只能经 C-1」 makes writing any of them on the approval side a contract violation.

And unlike the C-3 branch, the `redeem` branch **falls through**: the cancel round's OWN instance
gets its `approved` status write, its approve audit row and the 恰一个 completion event from
`dispatchAction`'s ordinary path (lock §3 C-2 step ⑥). The early `return` is C-3-only.

### 3.11.6 Acceptance — four cases, in the already-wired file

Appended to `approval-cancel-round-redemption.db.test.ts` (same reasoning as §3.4: a new
`.db.test.ts` would need `plugin-tests.yml` and an s6a re-pin, for no coverage this fixture cannot
give; the `ci-realdb-step-contract.mjs` clause this sentence used to carry is retracted, §0 R-6).

| Case | What it establishes |
|---|---|
| 判据 II redeems | round `applied` + `ended_at`; instance `approved`; **exactly one** completion event; and the C-1 call's `kind` / `operationId === roundId` / `routeVariant === null` / `routeInput.{requestId,orgId,actorId,tokenSubjectUserId}` each asserted — so 「C-1 was called」 is not 「something was called」 |
| 判据 IV `blocked` half (C-3 row 4) | a `business_refused` return persists the close in the SAME transaction: engine `rejected`, system sentinel with `business_blocked:<code>`, `cancelRoundBlockDetail` BESIDE the bounded token (never concatenated into it), round `blocked` + `block_reason`, **zero** completion events |
| unbound port | 409 `CANCEL_ROUND_EXECUTION_PORT_UNAVAILABLE`, round still `pending` with `ended_at` null, instance still `pending`, seat count still 1, zero events |
| non-attendance original | 409 `CANCEL_ROUND_BUSINESS_TARGET_MISSING`, **C-1 never called** (`calls.length === 0`), round untouched — the isolated variant of the redeeming case, differing only in the attendance backing |

**The phase-1 case that asserted the round left `pending` is REPLACED, not deleted.** §4 of the
previous revision said it was written that way so 判据 II 「is FORCED to be noticed rather than
being silently satisfied」. It was: the fixture had to gain an attendance request and a bound
provider, and the expectation flipped to `'applied'`.

**Two harness facts found rather than assumed.** (1) The composite FK
`attendance_requests_instance_workflow_fkey` `(approval_instance_id, approval_workflow_key)` →
`approval_instances (id, workflow_key)` means the instance must be re-keyed BEFORE the request row
is inserted — the first draft failed `23503` and the ordering is now commented at the helper.
(2) This harness **already has a provider bound** when these cases run — discovered from the
console warning `AttendanceCancellationExecutionPort provider is being replaced`, not reasoned
about. The helper therefore SAVES and RESTORES the previous provider rather than unbinding, and the
unbound-port case restores it in `finally`; otherwise every later case would have run against a
registry this suite emptied, a state no production process is ever in.

### 3.11.7 Mutation ledger (this unit)

Both probes: `cp` backup → edit → run alone → `cp` restore → `cmp` (`RESTORED-IDENTICAL`, and
`git status` clean against HEAD afterwards).

| # | Mutation | Expected | Observed |
|---|---|---|---|
| M-16 | the fail-closed guard treats an unbound provider as 「nothing to cancel」 (`return { kind: 'applied' }` instead of the throw) — i.e. the fail-OPEN shape the precedent would have given | the unbound-port case red, and only it | **exactly 1 red**, that case, on the named symptom: `AssertionError: expected 200 to be 409`; 11 green |
| M-17 | drop the `redemption.kind === 'blocked'` hand-off, so a business refusal falls through to the ordinary approve path as if C-1 had succeeded | the `blocked` case red, and only it | **exactly 1 red**, that case: `AssertionError: expected [ 'approval.approved' ] to deeply equal []`; 11 green |

M-17's symptom is worth naming: the mutation's visible effect is a completion event appearing where
判据 IV requires none — which is also the proof that this case's 「零完成事件」 is measured on the
channel the sibling 判据 II case shows firing exactly once, not on an inert one.

### 3.11.8 Commands and results

```
$ node --check plugins/plugin-attendance/index.cjs
  node --check OK

$ (packages/core-backend) npx tsc --noEmit -p tsconfig.json
  (no output, exit 0)

$ (packages/core-backend) EXPECT_DB=1 \
  DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c2 \
  ATTENDANCE_TEST_DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c2 \
  npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-cancel-round-{redemption,creation,outlet-guards,seat-guards,\
      node-timeout-effect,lock-order-census}.db.test.ts
  Test Files  6 passed (6)
        Tests  59 passed (59)          (redemption: 8 -> 12)

$ … run tests/integration/attendance-w4c3b-request-operation-routes.db.test.ts \
      tests/integration/attendance-w4c3b-approved-leave-cancellation.db.test.ts \
      tests/integration/attendance-w4c3b-central-approval.db.test.ts
  Test Files  3 passed (3)
        Tests  45 passed (45)
```

### 3.11.9 Census for the new file and the two new error codes

Two burns in this repo's ledger are 「a token list is the population, so a token it does not name
stays outside the denominator while the guard goes green」 (the O2 trap) and 「a new source file
needs its census pins」. Both checked mechanically rather than assumed:

```
$ git grep -rn "CANCEL_ROUND_WINDOW_ANCHOR_MISSING" -- scripts packages/core-backend/tests .github
  packages/core-backend/tests/integration/approval-cancel-round-redemption.db.test.ts:780  (prose)
  packages/core-backend/tests/integration/approval-cancel-round-redemption.db.test.ts:810  (the assertion)
  2 lines
```
The only consumer of an existing sibling cancel-round code is the acceptance assertion itself:
there is **no** enumerating guard whose denominator would need
`CANCEL_ROUND_EXECUTION_PORT_UNAVAILABLE` / `CANCEL_ROUND_BUSINESS_TARGET_MISSING` added.

```
$ git grep -n "src/core/" scripts/ops/ci-realdb-step-contract.mjs .github/workflows/plugin-tests.yml
  0 lines

$ git diff --name-only 0225a1aa4..HEAD -- .github/workflows/plugin-tests.yml
  0 lines
```
Neither CI contract enumerates `src/core/`, and `plugin-tests.yml` is untouched — so **no s6a
provenance re-pin** is owed by this unit (the s6a hash is a function of that workflow file).

The one guard that DOES enumerate source files was run rather than reasoned about:
`tests/unit/source-files-no-raw-control-bytes.test.ts`, together with the plugin-mirror constant
guard and both boundary suites — `Test Files 4 passed (4) / Tests 39 passed (39)`.

---

⚠️ The suite is EXCLUDED from the default vitest config and reports `No test files found, exiting
with code 1` when run without `--config vitest.integration.config.ts` — an exit-1 that is easy to
misread as an infrastructure problem rather than the wrong runner. Recorded because it cost a run.

---

## 3.12 判据 II END-TO-END against the REAL boundary — and the P1 it found (this unit)

The four cases in §3.11.6 bind a test double. This unit removes it and runs the redemption against
the attendance plugin's actual `AttendanceRequestOperationBoundaryV1`. It found, on its FIRST run,
a defect that made 判据 II **completely non-functional in production** while every double-backed
case stayed green.

### 3.12.1 ⛔ DEFECT SHIPPED AND FIXED IN-BRANCH: the replay key was not a UUID

Commit `08b7cbec3` passed `roundId` straight through as the W4 `operationId` under this comment:

> 「`operationId` is the W4 replay key and must be a UUID (`normalizeInput` → `uuidOrNull`). The
> round row's own id is exactly the right identity」

The first clause is true. The second is **false**, and nothing in the branch checked it:

```
$ psql -d metasheet2_lock_c2 -c "\d approval_rounds" | head -5
           Column            |  Type  | ... |
 id                          | text   |     |   ← not uuid; only CHECK is chk_approval_rounds_id_nonblank
$ git grep -n "const roundId = " -- packages/core-backend/src/services/ApprovalProductService.ts
8495:    const roundId = `apr_${crypto.randomUUID()}`      ← 40 chars, `apr_` prefix
```

`normalizeExternalTransactionInput` → `normalizeInput` → `uuidOrNull` refuses a 40-character string
(`value.length !== 36`), so the entry threw `W4C3B_REQUEST_BOUNDARY_INPUT_INVALID` and the route
answered **500 `APPROVAL_ACTION_DISPATCH_FAILED`** — measured, first run:

```
AttendanceW4RequestBoundaryError: W4C3B_REQUEST_BOUNDARY_INPUT_INVALID
    at uuidOrNull (…/w4c3b-request-operation-boundary.ts:109:85)
    at normalizeExternalTransactionInput (…:486:22)
    at Object.executeInExternalTransaction (…:687:33)
    at ApprovalProductService.redeemCancelRoundInTxn (…/ApprovalProductService.ts:9051:31)
```

**Why four green cases did not catch it.** A test double never normalizes its input — it takes the
object as given. So the entire input-validation half of the entry's contract (the half the lock
spends §3 C-1 on) was outside every one of those cases' reach. This is the exact failure mode the
phase-1 ledger already names as 「Mock is not the contract」, and it cost a shipped P1.

**The fix, and why not prefix-stripping.** `deriveCancelRoundW4OperationIdV1(roundId)` in
`src/core/attendance-cancellation-execution-port.ts` derives a UUIDv5 over the round id under a
frozen namespace, using the same construction as `w4c0-identity.ts:281-291` (copied, not imported —
that module's derivations belong to the source-matrix `idRule` families and their TS/SQL
golden-parity gate, and this key has no SQL twin and is minted by the approval side). Stripping
`apr_` would depend on a shape only today's generator produces and no constraint enforces. The
derivation is **total** (any non-blank id maps), **deterministic** (a retry of the same round
replays under the same key — the only property lock §3 C-2 step ④ needs) and **distinct** per
round. The namespace UUID is an implementer choice, ⚠️ **FLAGGED FOR OWNER REGISTRATION** and
frozen from here on: changing it would make an already-redeemed round replay under a new key.

### 3.12.2 What the end-to-end case MEASURES that a double cannot

All of these were established by the run, not by reading:

| Measured | Evidence |
|---|---|
| `assertExternalTransactionIsolationV1` passes | the protocol proceeds past it; its `SAVEPOINT` probe on `dispatchAction`'s `BEGIN ISOLATION LEVEL SERIALIZABLE` client neither 25P01/25P02s nor leaves the caller in a subtransaction (the transaction goes on to COMMIT) |
| `assertExternalTransactionRolloutLockHeldV1` passes | the `pg_locks` probe for the key built from the org `prepareIdentity` read finds it HELD by this backend — **§3.11.3's org-key CONSTRUCTION argument is now a measurement** |
| the client handed over is the one that issued `BEGIN` | `dispatchAction` uses `pool.connect()`; had it handed over the pool, the savepoint and the `pg_backend_pid()` predicate would have landed on arbitrary backends and both asserts above would have failed |
| replay preflight accepts a never-registered `operationId` (§4 risk (a)) | the derived id is new every round; the preflight returns non-`replay` and the protocol continues |
| `requestBody: {}` is tolerated (§4 risk (b)) | `loadLatestRequestSnapshotToken` runs in both prepare and execute with the `expectedSnapshotVersion = 0` / `'0'*64` defaults and does not refuse |
| the ORIGINAL document is really cancelled inside the approver's transaction | `approval_instances.status = 'cancelled'` + exactly one `approval_records(action='revoke', from_status='approved', to_status='cancelled')` whose `actor_id` is the round's requester and whose `metadata.w4ActorPosture = 'self'` |
| the attendance request is really cancelled | `attendance_requests.status='cancelled'`, `resolved_by` = the requester, `resolved_at` non-null |

**Positive control that this is the real boundary.** Every double in that file returns
`{ kind: 'executed' }` and writes nothing; the rows in the last two table rows can only have been
written by the plugin's adapter. Stated as an artifact assertion rather than as 「the redeem
returned 200」, so a future edit that leaves a double bound turns these red instead of staying green
while silently ceasing to be end-to-end.

⚠️ **The positive control is POSTURE-DEPENDENT, and this is the disclosure.** Those rows exist
because the adapter reached its write block, which the legacy write posture is what permits (the
same fact §3.12.3 item 2 states about the calculation count). Under a shadow/authoritative posture
the P14 branch runs first and could refuse, in which case the control's rows would be absent for a
reason unrelated to which provider is bound. Read it as 「the real adapter wrote these rows ON THIS
POSTURE」, not as a posture-independent proof of provenance.

**How the plugin is loaded at all, established rather than assumed.** The server is built with
`pluginDirs: []`, which is NOT 「no plugins」: `PluginLoader`'s constructor adopts
`options.pluginDirs` only when `length` is truthy, so an empty array leaves `basePath='./plugins'`,
which sets `allowFallback = true`, which makes `discover()` scan `cwd/plugins`, `cwd/../plugins`
and `cwd/../../plugins` — and vitest's cwd is `packages/core-backend`, so the third root is the
repo's `plugins/`. That is also the source of the 'provider is being replaced' warning §3.11.6
reported.

### 3.12.3 Two fixture facts found by running, not by reading

1. **The acting identity must be a real directory row.** `attendanceResultOperationPreflightV1`
   calls `recheckAttendanceActorLivenessInTransactionV1`, which requires an active `users` row AND
   an active `user_orgs` membership for the actor (`ATTENDANCE_WRITE_NOT_AUTHORIZED` otherwise). A
   dev token is not a directory row. `seedDirectoryIdentity` now creates both, and `afterAll`
   deletes them — this file shares the CI lane with the attendance suites, so it leaves the DB as
   it found it.
2. **The P14 calculation branch is NOT exercised on this fixture.** The org resolves to a legacy
   write posture, and the adapter's branch is `approvedLeave && acceptedWritePosture !==
   'legacy_projection_only'`, so `appendApprovedLeaveCancellationCalculation` is skipped. Asserted
   explicitly (zero `approval_reversal` calculations for the derived operation id) rather than left
   ambiguous, so a later posture change that starts exercising P14 here cannot pass unnoticed.

### 3.12.4 Mutation ledger (this unit)

`cp` backup → edit → run alone → `cp` restore → `cmp` (`RESTORED-IDENTICAL`, `git status` clean).

| # | Mutation | Expected | Observed |
|---|---|---|---|
| M-19 | change the namespace constant's last hex digit (`…a7c4` → `…a7c5`) | the derivation's GOLDEN assertion red, and only it | **exactly 1 red**: `expected 'b1d0cb10-9eba-549a-957d-21c355dd9394' to be '46c05da2-ae5a-53c4-ac85-61190e0571ff'`; 184 green. The three self-consistency assertions above it (shape, determinism, distinctness) stayed GREEN under this mutation — which is precisely why the golden value had to be added: without it, 「the namespace is frozen」 was an asserted invariant with no test |
| M-18 | revert the fix: pass `roundId` raw as `operationId` | the end-to-end case red; the double-backed 判据 II case red only on its new derivation assertion | **exactly 2 red, both predicted**: e2e `expected 500 to be 200`; double-backed `expected 'apr_ed58e25d-…' to be '2b919f37-61e8-574f-…'`. 11 green — so the fix is load-bearing AND the shape assertion in the double-backed case now has discriminating power it did not have before |

### 3.12.5 Commands and results

```
$ (packages/core-backend) npx tsc --noEmit -p tsconfig.json          (no output, exit 0)

$ (packages/core-backend) EXPECT_DB=1 \
  DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c2 \
  ATTENDANCE_TEST_DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c2 \
  npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-cancel-round-{redemption,creation,outlet-guards,seat-guards,\
      node-timeout-effect,lock-order-census}.db.test.ts
  Test Files  6 passed (6)
        Tests  60 passed (60)          (redemption: 12 -> 13)

$ … run tests/integration/attendance-w4c3b-{request-operation-routes,\
      approved-leave-cancellation,central-approval}.db.test.ts
  Test Files  3 passed (3)
        Tests  45 passed (45)

$ (packages/core-backend) npx vitest run tests/unit/approval-product-service.test.ts
  Test Files  1 passed (1)
        Tests  185 passed (185)        (+1: the derivation's four properties)
```

No new source file and no `plugin-tests.yml` edit, so **no s6a provenance re-pin is owed** by this
unit (the derivation went into the existing `src/core/attendance-cancellation-execution-port.ts`,
and §3.11.9 already showed neither CI contract enumerates `src/core/`):

```
$ git diff --name-only 0225a1aa4..HEAD -- .github/workflows/plugin-tests.yml
  0 lines
$ git status --short                       (4 modified files, 0 untracked)
```

## 3.13 R2, IMPLEMENTED — and the lock's three literal clauses have NO discriminating power (this unit)

Lock:169, 期 1's second 承重反例: 「最终业务评估失败 ⇒ **零业务取消、零 `approved` 完成事件**,但 C-3
关闭结果已持久化(mutation:把评估挪到入队之后 ⇒ R2 必红)」.

One case, appended to the already-wired redemption suite (13 → 14 cases in this file; 60 → 61 in the
six-file cancel-round set).

### 3.13.1 The 入队 mapping, NAMED — not inferred

§4 of the previous revision flagged this: the statement after `evaluateCancelRoundFinalInLock` on the
shipped code is the C-1 call, not an enqueue, so 「把评估挪到入队之后」 needs a stated mapping.

The lock supplies it directly. C-2's ordered step list (lock:105-107) is:

> ① 锁轮次行 → ② 锁原单据实例 → ③ **锁内最终评估** → 分支决定 → 通过:④ 经 C-1 的 W4 外部事务入口
> 执行完整取消 → ⑤ 写轮次 `applied` → ⑥ **才写 `approved` 审计与入队完成事件** → `COMMIT`

入队 is **step ⑥**. So the mutation is: move the whole
`resolution.status === 'approved' && isCancelRoundInstance(instance)` hook block from its anchor
(immediately before `UPDATE approval_instances SET status = $2`) to immediately after
`await enqueueApprovalEventIfDurable(approvalTxnHandle(client), completionEvent)` — past the terminal
status write, past the `approve` audit row, past the enqueue. Registered as **M-20**, and the probe
was run at exactly that site (the `if (completionEvent) { … }` block's closing brace in
`dispatchAction`, NOT one of the six sibling `enqueueApprovalEventIfDurable` call sites — the first
attempt landed on the wrong one and was caught by `tsc` (`Cannot find name 'rolloutLock'`), restored,
and redone).

### 3.13.2 ⚠️ WHICH assertion carries the mutation — and it is an implementer addition

**Measured — after a correction.** The first version of this case asserted the implementer addition
SECOND, so when M-20 turned it red the three literal clauses below it were never evaluated and
「they stayed green」 was an argument wearing a measurement's label (retracted in §0, R-4). The case
now orders the three literal clauses FIRST and the implementer addition LAST, and M-20 was re-run:
the red lands on the file's LAST assertion (`…redemption.db.test.ts:1433` at mutant-run time, `:1435` after the §0 R-6 header correction,
`expect(roundRecords.rows[0].approve_rows).toBe('0')`), so **every clause in the table below was
evaluated in that same run and passed**.

That is §11-③'s trap recurring at this branch, and it is worth stating in full because it means
**R2's three literal clauses cannot detect the mutation the lock names for R2**:

| R2 clause | Under M-20 | Why |
|---|---|---|
| 零业务取消 (原单 `approved`, zero `revoke`, request `approved` + NULL `resolved_*`) | GREEN — evaluated, line-ordered before the red | the evaluation still answers `expired` and still skips C-1 — just later |
| 零 `approved` 完成事件 (in-process channel) | GREEN — evaluated | the C-3 branch's own `return` sits before the post-commit `emitApprovalCompletionEvent`, so the built event is never emitted wherever the hook sits |
| C-3 收口已持久化 (round `expired` + `ended_at`, engine `rejected`, system actor, `dto.status`) | GREEN — evaluated | the closure still runs and still overwrites `approved` back to `rejected` |

**How narrow the anchor's detection surface actually is.** Across the whole six-file cancel-round
corpus (61 cases) M-20 is detected by **exactly one assertion on exactly one path**. `ivexp` (§3.4,
the `not_required` expired close) stays green; §3.12's end-to-end REDEEM case stays green too (status
write → approve record → enqueue → hook → C-1 → fall-through → one post-commit event still holds
when the hook is late). 「exactly 1 red」 undersells that: it is 1 red out of 61 because 60 cases
genuinely cannot see the reordering, not because the corpus is thin.

The discriminating assertion is the **persisted `approved` half of step ⑥** — the `approve` audit row
on the cancel round's own instance, which the mutant writes and the shipped order does not:

```ts
count(*) FILTER (WHERE action = 'approve')     => '0'
count(*) FILTER (WHERE to_status = 'approved') => '0'
```

This is an **IMPLEMENTER ADDITION to R2's clause set**, recorded as such in the case's own doc
comment. No reader should take 「R2 built, its mutation red」 to mean the lock's literal clauses were
gated — they were not, and on this code shape they cannot be.

### 3.13.3 Mutation ledger (this unit)

`cp` backup → edit → run alone → `cp` restore → `cmp` (`RESTORED-IDENTICAL`, `git status` shows only
the test file modified).

| # | Mutation | Expected | Observed |
|---|---|---|---|
| M-20 | move the outlet-#5′ hook block past step ⑥ (after `enqueueApprovalEventIfDurable`) | R2 red, and only R2 | **exactly 1 red**: `R2 … expected '1' to be '0'` (the `approve` audit row the mutant writes). 60 green — including `ivexp`, which proves the hook still EXECUTED in its new position and still closed the round, so the red is the reordering and not an unreachable hook |
| M-20 (re-run, after the assertion reorder) | same mutation, against the reordered case | the red should move to the file's LAST assertion, with all three literal clauses evaluated and green | **red at `…redemption.db.test.ts:1433:49`** — the last assertion of the case (the §0 R-6 header correction landed afterwards and shifted that line to `:1435`; `grep -n 'expect(roundRecords.rows\[0\].approve_rows)'` ⇒ 1435). 13 of 14 green in that file. This is what makes the §3.13.2 table a measurement instead of an argument |

Two hygiene checks the ledger line depends on, run rather than assumed:
- the mutant **typechecks** (`npx tsc --noEmit`, exit 0) and its diffstat is `82 insertions(+), 80 deletions(-)` on one file — the block moved, it was not duplicated or dropped;
- `ivexp` GREEN under the mutant is the proof the hook ran at its new site (a hook made unreachable
  would leave the round `pending` and the instance `approved`, and `ivexp` asserts both the other
  way).

### 3.13.4 Why the REAL port and an attendance-backed fixture

Over a test double 「零业务取消」 could only be `calls.length === 0` — a statement about a stub. This
case binds nothing: the attendance plugin's REAL `executeInExternalTransaction` is live (asserted
`getAttendanceCancellationExecutionPort()` is defined before the action), and the zeros are rows:
原单 still `approved`, zero `revoke` records on it, `attendance_requests.status` still `approved` with
`resolved_by`/`resolved_at` still NULL. The positive control that this same fixture shape DOES get
cancelled when the evaluation passes is §3.12's end-to-end case.

**「零业务取消」 is fail-open-shaped**, so the preconditions are asserted as rows BEFORE the action —
otherwise the zero is also green for a fixture that never had a target (unattached document,
unparseable `business_key`, a `rolloutLock.kind !== 'required'` pre-read):

```ts
approval_instances: status='approved', workflow_key='attendance.request',
                    business_key='attendance-request:<uuid>'
attendance_requests: exactly 1 row, status='approved'
getAttendanceCancellationExecutionPort(): defined
```

Two deliberate choices, written down so a later reader does not "fix" them:
1. **`seedDirectoryIdentity` is NOT called.** C-1 never runs here, so the directory rows are not
   needed; and if the evaluation ever accidentally answered `redeem`, the real adapter's
   actor-liveness recheck would fail the transaction, the round would stay `pending`, and 「C-3 收口
   已持久化」 would go RED. The omission makes an accidental redeem fail loudly.
2. **This is the FIRST case to drive the C-3 `expired` close under the `required` posture.** With an
   attendance request attached, `resolveCancelRoundRolloutLockRequirementV1` answers
   `{ kind: 'required' }`, so the dispatch runs under `BEGIN ISOLATION LEVEL SERIALIZABLE` holding the
   rollout advisory lock (§3.9); `ivexp` runs the `not_required` one. ⚠️ That posture claim is a
   CONSTRUCTION argument from the pre-read's predicate plus the fixture rows asserted above — it is
   not a `pg_locks` measurement here (census Q-F, §3.9.4, is where the lock itself is measured).

### 3.13.5 Commands and results

```
$ (packages/core-backend) npx tsc --noEmit -p tsconfig.json          (no output, exit 0)

$ (packages/core-backend) EXPECT_DB=1 \
  DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c2 \
  ATTENDANCE_TEST_DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c2 \
  npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-cancel-round-{redemption,creation,outlet-guards,seat-guards,\
      node-timeout-effect,lock-order-census}.db.test.ts --reporter=dot
  Test Files  6 passed (6)
        Tests  61 passed (61)          (redemption: 13 -> 14)

  … same command with M-20 applied:
  Test Files  1 failed | 5 passed (6)
        Tests  1 failed | 60 passed (61)
  FAIL … R2 … AssertionError: expected '1' to be '0'

  … M-20 re-run after the assertion reorder (redemption file alone):
  Test Files  1 failed (1)
        Tests  1 failed | 13 passed (14)
  FAIL … R2 … at …/approval-cancel-round-redemption.db.test.ts:1433:49
```

⚠️ WHICH RUN PRODUCED WHICH NUMBER, since both sit in this section. 「60 green / 1 assertion out of
61」 comes from the SIX-FILE mutant run, which used the PRE-reorder case; 「red at `:1433:49`, 13 of
14 green」 comes from the single-file mutant run against the POST-reorder case. The cross-inference is
safe only because the other 60 cases' source is byte-identical between the two runs (the reorder
touched one case body in one file) — said out loud rather than left for a reviewer to reconstruct.

No new file and no `plugin-tests.yml` edit — the case went into a suite already enumerated by `plugin-tests.yml`, so
**no s6a provenance re-pin is owed** by this unit. ⚠️ The earlier units in this file ran that absence
grep from `0225a1aa4`, a MID-BRANCH baseline; for an absence claim about the BRANCH it has to run
from the branch point, which is what is done here:

```
$ git diff --name-only feat/approval-cancel-round-phase1..HEAD \
    -- .github/workflows/plugin-tests.yml scripts/ops/ci-realdb-step-contract.mjs
  0 lines
$ git diff --name-status feat/approval-cancel-round-phase1..HEAD -- '*.db.test.ts'
  M  …/approval-cancel-round-lock-order-census.db.test.ts
  M  …/approval-cancel-round-outlet-guards.db.test.ts
  M  …/approval-cancel-round-redemption.db.test.ts        (3 modified, 0 added)
$ grep -n lock-order-census .github/workflows/plugin-tests.yml
  1666:            tests/integration/approval-cancel-round-lock-order-census.db.test.ts \
```

So the 1006-line census file phase 1 added IS in the CI lane (it is not new on this branch —
`git cat-file -e feat/approval-cancel-round-phase1:…lock-order-census.db.test.ts` succeeds), and this
branch adds **no `.db.test.ts` at all** — which is what 「nothing owed」 rests on, independently of any
script's shape.

And `scripts/ops/ci-realdb-step-contract.mjs` owes nothing either — but the reason this file gave for
that, in three places, was **wrong**, so it was read rather than grepped (§0 R-6). Two token counts
(`grep -c 'db.test.ts'` ⇒ 1, `grep -c cancel-round` ⇒ 0) were the first evidence, and stopping there
would have been 「a token grep standing in for reading the enumeration」 — this repo's own O2 census
trap. Reading it: `:99-102` is `REAL_DB_STEP_IDS`, a frozen map of two STEP IDS, and the file
population comes from `wholeFileVitestArgs` (`:521-525`), which derives it from the parsed workflow
step's own vitest invocations. It is not a closed world over files; there is no file list to fall out
of. Recorded because 「a closed world that stays green for a file it does not list」 is this branch's
own named hazard, and the hazard turned out to be in the DESCRIPTION, not the script.


---

## 3.14 §5 I3 「终结即释放」, WITH its own mutation — and the door that fires is NOT the index (this unit)

### 3.14.1 Why this needed a separate case, not one more assertion

The 判据 IV `expired` case (§3.4) already ended with 「a new cancel round starts immediately」. That
line was an **end-state check with no mutation behind it**, and §4 has listed it as owed since the
unit landed. The lock's I3 mutation is 「the C-3 closure does not write the round's terminal
`outcome`」 — instance `rejected` while the round stays `pending`, which is exactly the shape
lock:368's outlet-7′ row spells out (「实例 `rejected` 而轮次仍 `pending`、同单据再发起被唯一索引拒,
红」).

Run that mutation against the 判据 IV case and it **never reaches the I3 line**: the case dies 23
lines earlier, at `expect(round.rows[0].outcome).toBe('expired')` (`:780`), while its
`createCancelRoundInstance` call sits at `:804-806`. That is §0 R-5's trap — an argument presented
as a measurement — recurring two units later in the same file. So the I3 clause gets its own case
(`:817-894`), in which the create is the **first statement after the close**, and the 判据 IV case
keeps its line as the cheap end-state check it always was.

### 3.14.2 The door that actually refuses the second round — measured, and it is not the one §4 predicted

Lock:149 says I3 is 「由索引 + C-3 共同保证」, and this file's own §4 predicted the mutant's red would
be 「refused by the partial unique index with 23505」. **That is wrong for the sequential shape**, and
the probe says so with a stack frame:

```
ServiceError: This document already has a cancel round in progress
 ❯ ApprovalProductService.createCancelRoundInstance src/services/ApprovalProductService.ts:8563:15
 ❯ tests/integration/approval-cancel-round-redemption.db.test.ts:863:20
Serialized Error: { statusCode: 409, code: 'CANCEL_ROUND_ALREADY_PENDING', details: undefined }
```

`:8563` is the **application pre-check**'s throw (`:8558-8568`,
`SELECT id FROM approval_rounds WHERE document_id = $1 AND outcome = 'pending'`), which runs before
the `INSERT` ever reaches the constraint. The 23505 backstop at `:8697-8705` maps the raw unique
violation onto the SAME named 409 and belongs to the **concurrent-insert race only**.

Consequence for what this case may be said to prove, stated narrowly:

- **PROVEN** — C-3's terminal `outcome` write is what releases the document's pending slot: remove
  it and the next create is refused; keep it and the next create succeeds.
- **PROVEN** — the named 409 `CANCEL_ROUND_ALREADY_PENDING` is what an **in-process** caller sees
  when the slot is still held. Narrowed deliberately: there is no HTTP route for
  `createCancelRoundInstance` (this file's own header says so), so 「a caller sees」 unqualified
  would have read as an API-surface claim this case does not make.
- **NOT proven** — anything about `uq_approval_rounds_pending_document` itself. Reaching the index
  needs a constructed race (two concurrent `createCancelRoundInstance` calls), which this case does
  not build. §4's 「23505」 sentence is corrected accordingly (§0 R-7).

### 3.14.3 What the case asserts, in order

`:817-894`, `§5 I3 「终结即释放」 (the C-3 half)`. Same closure cause as 判据 IV (200-day-aged
`approved_at` anchor > the `leave` suite's 90-day window), driven through the real
`POST /api/approvals/:id/actions` approve.

| # | Assertion | Why it is here |
|---|---|---|
| 1 | `createCancelRoundInstance(documentId)` **succeeds** | the I3 clause itself; **carries M-21** |
| 2 | exactly one `pending` round for the NEW engine instance | the create actually opened a round, not just returned a DTO |
| 3 | the closed round is still exactly one row, `outcome = 'expired'` | it was released by reaching a terminal outcome, not deleted |
| 4 | the closed round's id ≠ the new round's id | a **different** row — not the same row re-opened |
| 5 | exactly one `pending` round **for the document** (`WHERE document_id = $1`), and its `engine_instance_id` is the new instance | 「同一单据至多一轮在途」 read off the column the partial unique index is declared on |

Assertion 5 is deliberately keyed on `document_id` rather than on the instance: that is the index's
own predicate, so it is the read that would catch a second pending row the pre-check happened to
miss.

### 3.14.4 Mutation ledger (this unit)

`cp` backup → edit → run → `cp` restore → `cmp`. One probe. `RESTORED-IDENTICAL` printed;
`git status` after restore shows the test file as the only modification.

| # | Mutation | Expected | Observed |
|---|---|---|---|
| M-21 | **the lock's I3 mutation** — in `closeCancelRoundSystemTerminalInTxn`, delete BOTH the `UPDATE approval_rounds … SET outcome = $2, ended_at = now(), …` (`:8946-8959`) AND its `if (roundResult.rowCount !== 1) throw` guard (`:8960-8966`) — 21 lines, replaced by a one-line marker | the I3 case red **at its create line**, i.e. the clause is evaluated and fails | **4 red, 11 green**, and the I3 case's red is on the named site: `redemption.db.test.ts:863:20`, `ServiceError … CANCEL_ROUND_ALREADY_PENDING` (409). The other three reds are 判据 IV `expired` (`:780`), 判据 IV `blocked` (`:1092`) and R2 (`:1482`), each on its own round-outcome assertion — which is the direct confirmation of §3.14.1: **all three die before their own I3/round lines**, so none of them could have carried this mutation |

Both lines were removed **together** on purpose: deleting only the `UPDATE` leaves `roundResult`
undefined and the probe would have produced a `TypeError`, which is a different red than the one
claimed here.

M-21's 4/15 detection rate is reported rather than trimmed. The alternative — deleting the 判据 IV
case's I3 line to make the row read 「exactly 1 red」 — would have removed a working assertion to
tidy a count, which is the move this file's §0 keeps retracting.

### 3.14.5 Scope — ONE of the two terminal outcome writers

The population is **repo-wide and both-syntax**, not a single-file single-syntax grep — kysely
builders and the attendance plugin are inside the window:

```
$ git grep -nE "UPDATE approval_rounds|approval_rounds['\"]?\)?[[:space:]]*\.set|updateTable\(['\"]approval_rounds" \
    -- packages plugins | grep -v '\.test\.' | wc -l
6
```

All **6** hits are in `ApprovalProductService.ts`; **2 are prose comments** (`:899`, `:8768`),
leaving **4 statements**, and zero hits under `plugins/` or in builder syntax:

| Site | Outcome written | I3 mutation built? |
|---|---|---|
| `:8947` — `closeCancelRoundSystemTerminalInTxn` (C-3 system close) | `expired` / `blocked` | **YES — M-21, this unit** |
| `:9108` — `redeemCancelRoundInTxn` (C-2 success) | `applied` | **YES — M-26, §3.18** (this row is UPDATED: when §3.14 was written the answer was 「NO, no probe exists」, and it was registered in §4 rather than smuggled in here). The probe needs the attendance target plus the double, which is why it landed as its own unit. §3.18.1 re-derives this whole population at the current head instead of inheriting it |
| `:11263` — 判据 III, 发起人撤回 | `withdrawn` | out of this slice (phase 1) |
| `:11750` — 判据 III, 审批人驳回 | `rejected` | out of this slice (phase 1) |

### 3.14.6 Commands and results

```
$ npx tsc --noEmit -p tsconfig.json
[exited with code 0]

$ DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c2 EXPECT_DB=1 \
    npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-cancel-round-redemption.db.test.ts --reporter=dot
 ✓ tests/integration/approval-cancel-round-redemption.db.test.ts  (15 tests) 955ms
 Test Files  1 passed (1)
      Tests  15 passed (15)

# M-21 applied
      Tests  4 failed | 11 passed (15)
 ❯ …redemption.db.test.ts:863:20   ServiceError … CANCEL_ROUND_ALREADY_PENDING   ← the I3 clause
 ❯ …redemption.db.test.ts:780:37   expected 'pending' to be 'expired'
 ❯ …redemption.db.test.ts:1092:37  expected 'pending' to be 'blocked'
 ❯ …redemption.db.test.ts:1482:38  expected 'pending' to be 'expired'

# restored
$ cmp /tmp/APS-m21-backup.ts packages/core-backend/src/services/ApprovalProductService.ts
RESTORED-IDENTICAL
$ …/vitest … redemption.db.test.ts --reporter=dot
      Tests  15 passed (15)
```

**Wiring: none owed.** No new `.db.test.ts` file — the case is appended to
`approval-cancel-round-redemption.db.test.ts`, which `plugin-tests.yml:1668` already runs in the
`approval-real-db-integration` step. So no workflow edit and no s6a provenance re-pin (§0 R-6
settled that a new file under this step owes `ci-realdb-step-contract.mjs` nothing either). The
top-level `EXPECT_DB` sentinel and the two-point wiring were already in place for this file.


## 3.15 账侧验收, ROW-LEVEL HALF IMPLEMENTED — and the twin compare found a real divergence (this unit)

Lock §8 期 1's second acceptance line: 「账侧(完整取消结果**逐字节等价于现有 W4 路径** +
`unrecoverableExpired` 呈现)」(lock:169). This unit builds the twin-fixture comparison.

**SCOPE, stated as a count rather than as 「the row-level half」** (an earlier draft of this section
and the commit message for `d22d6c624` both said 「ROW-LEVEL HALF CLOSED」, which reads as 「the rows
are equal」 and is an overclaim — retracted here). Lock:86 lists C-1's execution as **seven** steps.
This unit's compares cover **two** of them, and measures two more:

| C-1 step (lock:86) | This unit |
|---|---|
| ① 锁两行 `FOR UPDATE` | not observable as an end state — covered by census Q-G (§3.10) |
| ② 状态复核 | not observable as an end state |
| ③ 按运行模式追加取消计算 | **MEASURED equal (0/0)** — but skipped on BOTH under the org's legacy posture, §3.15.11 |
| ④ 原实例 `approved → cancelled` + `approval_records` | **COMPARED column-for-column** |
| ⑤ 请求 `cancelled` | **COMPARED column-for-column** |
| ⑥ `reverseLeaveBalanceDeduction` → `unrecoverableExpired` | **UPDATED (was 「NOT closed」).** 呈现 half still owner's (§3.15.6). 账侧 half is now **MEASURED as a DECLARED DIVERGENCE**, not open: A seals it, B has no sealed row at all — §3.20, M-28 |
| ⑦ 发 `attendance.request.cancelled` | **MEASURED equal (0/0)** — skipped on BOTH, §3.15.11 |

### 3.15.0 ⛔ PROVENANCE CORRECTION: `attendance-parity.db.test.ts` is NOT named by the lock

The phase-1 design MD says, at `:61-62`, that `attendance-parity.db.test.ts` is 「named in the
lock's phase-1 door, lock:169」. **That attribution is false.** lock:169 names 账侧, 逐字节等价,
现有 W4 路径 and `unrecoverableExpired` — it names no filename at all:

```
grep -c "attendance-parity" \
  ~/.claude/projects/-Users-chouhua-Downloads-Github-metasheet2/reviews/approval-change-request-design-lock-draft-20260915.md
# → 0
```

The filename is an IMPLEMENTER INVENTION mis-attributed to the lock, and the phase-1 verification
MD then carried it forward as a blocked-with-reason deliverable (`:518`, `:679-715`). Consequences,
both acted on here:

1. **The acceptance goes in the already-wired file**, `approval-cancel-round-redemption.db.test.ts`
   — the same call §3.4 made for the 判据 IV half, and now made for the same reason: the lock
   names a REQUIREMENT, not an artefact, and satisfying it in a file that is already in the
   required lane costs no new census pins and no s6a re-pin. Creating a second file to match an
   invented name would be 另造同类物 in the literal sense — a new artefact whose only justification
   was a misquote.
2. **Phase-1's blocked-with-reason item is discharged, not deferred again.** The requirement it
   stood for is implemented below; the FILENAME it named is retired.

### 3.15.1 Base drift, closed FIRST — this branch was building on a stale phase 1

Found at this unit's inventory, before any code was written: phase 2 branched at `7ef8e610e`, and
phase 1 had since moved to `74a387dad` — 8 commits, and **not** docs-only. The intersection with
phase 2's own touched paths was real:

```
git log --oneline --name-only 7ef8e610e..feat/approval-cancel-round-phase1 | sort -u
# apps/web/src/approvals/api.ts
# packages/core-backend/src/services/ApprovalBridgeService.ts
# packages/core-backend/src/db/seeds/approval-cancel-round-published-definition.ts
# packages/core-backend/tests/integration/approval-cancel-round-redemption.db.test.ts   ← this unit's file
# packages/core-backend/tests/integration/approval-cancel-round-outlet-guards.db.test.ts
```

`a166f5ca0 fix(approval): close cancel-round gate round-2 P2-1 and P3-A` is a CODE fix, and it
touches the very file this unit appends to. Writing the parity case first would have meant writing
it against superseded code and resolving a conflict afterwards. Phase 1 was therefore MERGED into
phase 2 (`git merge`, not rebase — the branch is pushed and force-push is out of scope) as the
first commit of this unit; the merge was clean (`ort`, no conflicts) and `tsc --noEmit` passed on
the result.

⚠️ **Consequence for every absolute in this file above §3.15**: those counts were measured at
`7ef8e610e`-based heads and are head-scoped to them. They are NOT re-measured by this unit. Before
LANE-DONE they must be re-run against the merged head.

### 3.15.2 What 「现有 W4 路径」 is, as a running thing — and why the comparison needs TWO fixtures

The existing path is `POST /api/attendance/requests/:id/cancel` (route registered at
`plugins/plugin-attendance/index.cjs:38634`), which runs the W4 operation protocol over a
boundary-owned connection. The redemption path runs the SAME protocol over the approver's
transaction. There is exactly ONE production caller of the external-transaction entry:

```
grep -rn "executeInExternalTransaction(" packages/core-backend/src | grep -v tests
# w4c3b-request-operation-boundary.ts:361   ← interface declaration
# w4c3b-request-operation-boundary.ts:686   ← implementation
# ApprovalProductService.ts:9054            ← the ONLY call site
```

A request can be cancelled only once, so parity cannot be a before/after on one row; it needs two
structurally identical fixtures differing only in which channel cancels them. Fixture B is built
from the SAME helpers in the SAME order (`publishOneNodeTemplate` → `createApprovedOriginal` →
`attachAttendanceRequest` → `seedDirectoryIdentity`). **The one deliberate difference is
disclosed in the case**: B has no cancel round, because 「现有 W4 路径」 means the path as a user
walks it today, and that user has no round.

### 3.15.3 How 「逐字节」 was made measurable — normalise, don't exclude

Byte equality cannot hold literally: different primary keys, different users, different clocks. The
comparison therefore NORMALISES wherever it honestly can and excludes only what it cannot, with
every exclusion carried as DATA (`DECLARED_DIVERGENCES`, 13 entries, each with `table`, `column`
and a written `reason`) rather than as a comment that rots.

**The integrity rule, stated because it is the whole method**: a substitution pair may only be
sourced from a FIXTURE-CONSTRUCTION fact — an identifier this test chose, or one minted by the
template publication it drove, looked up from the TEMPLATE tables. A pair read off the rows being
compared would not normalise a column, it would silently EXCLUDE it, and could mask a real
divergence anywhere else that value appears. The first draft violated this (it read `template_id`
off `approval_instances`); it was corrected by making `seedPendingCancelRound` RETURN its
`templateId`, so A's template identity is a fixture input exactly as B's is.

Eight substitution pairs: `documentId`, `requestId`, `requesterId`, `approverId`, `templateId`,
template `key`, `template_version_id`, `published_definition_id`. Each is asserted non-empty and
DISTINCT before use — an empty map would normalise nothing and the compare would pass by doing no
work.

### 3.15.4 What the compare found, measured rather than assumed

Three rows compared: `attendance_requests`, the ORIGINAL `approval_instances`, and the
`approval_records(action='revoke')` audit row. Each pass narrowed the declared table by MEASURING
the residual divergence and then deciding — the values were printed, not guessed:

| Column | A (redemption) | B (W4 HTTP) | Disposition |
|---|---|---|---|
| `approval_instances.metadata` | `templateKey: …parity-a-…` | `…parity-b-…` | **normalised** (template key is a fixture fact) |
| `approval_instances.subject_snapshot` | `templateKey: …parity-a-…` | `…parity-b-…` | **normalised** |
| `approval_instances.published_definition_id` | `5dd80580-…` | `fd86fc6c-…` | **normalised** |
| `approval_instances.template_version_id` | `3c44b6c7-…` | `1d86b25d-…` | **normalised** |
| `approval_instances.request_no` | `AP-101319` | `AP-101321` | **declared** — global counter, no fixture-side source |
| `approval_records.id` | `2529` | `2531` | **declared** — global sequence |
| `approval_records.ip_address` | `null` | `127.0.0.1` | ⚠️ **SUBSTANTIVE** — see §3.15.5 |
| `approval_records.user_agent` | `null` | `node` | ⚠️ **SUBSTANTIVE** — see §3.15.5 |

Everything else is byte-equal after normalisation, including `status`, `business_key`,
`requester_snapshot`, `resolved_by`, `approval_instance_id`, `from_status`/`to_status` and
`metadata.w4ActorPosture` (`'self'` on BOTH paths — the posture the boundary resolved in-lock, lock
§3 C-1 「运行模式与授权凭据由边界在锁内解析」).

### 3.15.5 ⚠️ THE DIVERGENCE THIS CASE FOUND: 「逐字节等价」 does NOT hold for request provenance

`approval_records.ip_address` / `user_agent` are `null` on the redemption path and populated on the
W4 HTTP path. This is not a clock or key artefact and it is not swallowed by the exclusion table —
the values are asserted EXACTLY (`recA.ip_address` is null, `recB.ip_address` is not), so they
cannot change quietly.

**Why `null` is the honest value and not a gap to fill.** The redemption carries no HTTP request of
its own to attribute. The only HTTP request in play is the APPROVER's, against a DIFFERENT instance;
carrying its address onto the requester's cancellation audit row would attribute one person's
action to another person's browser — an invented audit value.

**FLAGGED FOR OWNER REGISTRATION**: whether 账侧 parity is satisfied by this, or whether the audit
row must instead carry a synthetic provenance marker (e.g. an `approval-cancel-round` sentinel) so
the two paths are distinguishable by INTENT rather than by an absence. Nothing on this branch
depends on which way it is settled; the case pins today's behaviour either way.

### 3.15.6 ⚠️ HEADLINE: `unrecoverableExpired` 呈现 IS NOT CLOSED, for two independent reasons

Lock:86 says C-1's execution includes `reverseLeaveBalanceDeduction`(返回 `unrecoverableExpired`,
**必须呈现**). Neither half is closed by this unit, and both are MEASURED rather than argued:

- **(a) No leave-balance lots are seeded.** `reverseLeaveBalanceDeduction`
  (`plugins/plugin-attendance/index.cjs:19392-19445`) has nothing to reverse, so both paths produce
  zero counters. Parity of a zero is parity; it is not the `unrecoverableExpired > 0` presentation
  the lock demands. Closing it needs a fixture that seeds an EXPIRED lot **and** a paired control
  where the value is absent — asserting presence on one fixture proves nothing about the
  presentation path.
- **(b) The approval side has no channel to present it on.** `redeemCancelRoundInTxn`
  (`ApprovalProductService.ts:9054`) special-cases only `business_refused` and returns
  `{ kind: 'applied' }` for every success kind — **the entry's `response` payload, `reversal` and
  all, is DISCARDED**. The redeemed round's DTO is an ordinary `UnifiedApprovalDTO` with no field
  carrying it.
  > ⛔ **ERRATUM (same unit, caught by the §3.15.11 probe).** An earlier draft of this bullet said
  > the hook receives 「`{ kind: 'executed', response }`」. That names only one of the entry's
  > success kinds. `w4c3b-request-operation-boundary.ts:903-924` returns `legacy` (preflight
  > `legacy_no_operation`), `legacy_compat` (posture `legacy_projection_only`) **or** `executed`,
  > and these fixtures take the **`legacy_compat`** branch, not `executed`. The payload is dropped
  > on all of them, so the finding stands — but the specific kind named was wrong.

(b) is asserted as a NEGATIVE in the case (the DTO has no `reversal` / `cancellationResult` key and
its JSON does not contain `unrecoverableExpired`), so the day a channel IS added, the line goes red
and this OPEN item must be revisited rather than quietly staying open. The B-side payload shape is
pinned in the same case so the target shape is on record.

**This is a contract gap, not a test gap**, and it is NOT fixed here on purpose: where the payload
should surface (the DTO, the round row, the `approve` audit row's metadata) is a design decision the
lock does not make, and inventing one would be 另造合同. Registered for owner decision.

### 3.15.7 ⚠️ This case's green is CONDITIONAL on an open owner decision

§3.11.4 flagged the C-1 audit row's acting identity as an implementer choice: the hook acts as the
cancel round's REQUESTER, not the approver. Parity with the W4 path is precisely the argument that
choice was made on, so this case is that argument's MEASUREMENT — and if the owner rules that the
audit row must carry the approver or a system sentinel, `approval_records.actor_id` stops
normalising onto B's and **this case goes RED BY DESIGN**. That is stated in the case itself so
nobody later "fixes" the red by adding `actor_id` to the exclusion table. It is not swallowing the
dispute; it is the dispute's oracle.

### 3.15.8 Mutation ledger (this unit)

| id | mutation | site | expected | measured |
|---|---|---|---|---|
| M-22 | `ipAddress: null, userAgent: null` → `'10.0.0.1'` / `'mutant'` in the redemption's `routeInput` | `ApprovalProductService.ts` (the sole production caller, `:9054`) | the parity case red on the provenance assertion, everything else green | **1 red / 15 green**, red at `approval-cancel-round-redemption.db.test.ts:1809:31`, `AssertionError: expected '10.0.0.1' to be null` |

M-22 is the right probe for a parity case and the reason is worth stating: a mutation to code SHARED
by both paths changes both fixtures and the compare stays green — that is what parity means. The
discriminating power of this case is exactly against things the APPROVAL path does DIFFERENTLY, and
M-22 is such a change. Detected by 1 assertion of 16 cases in this corpus.

Restored with `cp` and verified byte-identical (`cmp` → identical; `git diff --stat` after restore
shows the test file only, zero production lines).

The case also carries its OWN positive control, because the assertions above it are
absence-shaped and would pass vacuously if the comparator compared nothing: a deliberately
perturbed COPY of row A must be reported as divergent (`status`), and the identity columns must NOT
be reported — which is what proves normalisation RAN rather than that the rows happened to match.

### 3.15.9 Commands and results

```
# merge the stale base first
git merge feat/approval-cancel-round-phase1 --no-edit        # clean, ort strategy
npx tsc --noEmit -p tsconfig.json                            # clean

# the new case
DATABASE_URL=…/metasheet2_lock_c2 EXPECT_DB=1 \
  npx vitest --config vitest.integration.config.ts run \
  tests/integration/approval-cancel-round-redemption.db.test.ts -t '账侧' --reporter=dot
# → 1 passed | 15 skipped (16)

# the whole file (the `seedPendingCancelRound` signature change touches every case)
DATABASE_URL=…/metasheet2_lock_c2 EXPECT_DB=1 \
  npx vitest --config vitest.integration.config.ts run \
  tests/integration/approval-cancel-round-redemption.db.test.ts --reporter=dot
# → 16 passed (16)
```

⚠️ The file is run with `--config vitest.integration.config.ts`. The DEFAULT vitest config EXCLUDES
every `tests/integration/*` file in the required lane's run-list, so a bare
`npx vitest run tests/integration/…` prints `No test files found, exiting with code 1` — a
skip-green shape. Recorded because it cost this unit a run: an operator who checks these cases with
the bare command sees a non-zero exit and no tests, not a green.

### 3.15.11 ⚠️ THE POSTURE PROBE — why two of C-1's steps are parity-trivial here, not covered

The three row compares cannot see `attendance_record_calculations` (C-1 step ③) or
`attendance_result_event_outbox` (step ⑦). Both are gated on the ORG's accepted **write** posture —
which is NOT the `w4ActorPosture` the compares assert:

- `metadata.w4ActorPosture = 'self'` is the **actor** posture (who is cancelling). Equal on both
  twins, and asserted.
- `acceptedWritePosture` is the **write** posture, resolved per-ORG from the rollout registry
  (`w4c0-operation-registry.ts:640`, `:877`). Under `legacy_projection_only` the adapter skips the
  P14 calculation (`plugins/plugin-attendance/index.cjs:35169`:
  `if (approvedLeave && operation.acceptedWritePosture !== 'legacy_projection_only')`) and the
  boundary skips the outbox enqueue (`w4c3b-request-operation-boundary.ts:903-916`:
  `if (!isLegacyCompat) await enqueueAttendanceResultEventOutboxV1(...)`).

**Had the twins resolved different write postures, one would append a cancellation calculation and
the other would not, and the three compares would have stayed green over it** — a green whose blind
spot contains a lock-named step. That is why the case now asserts both counts, symmetrically
attributed (calculations joined through `attendance_records.user_id`; outbox rows keyed on
`payload->>'requestId'`), and pins them as VALUES rather than as equality alone — `0 === 0` is also
what a broken attribution predicate returns.

Measured: `calcA = calcB = '0'`, `outboxA = outboxB = '0'`.

> ⚠️ **措辞更正,见 §3.19.2** — 本节标题的 「parity-trivial … not covered」 与下一段的 「skipped on
> BOTH」 容易被读成 「这两步的断言被 `test.skip` 掉了」。**没有任何 `test.skip`**:③/⑦ 是按值断言的
> (就是上面这一行)。被跳过的是**生产分支**(org 处于 `legacy_projection_only`)。开放项因此是**分支
> 覆盖**,不是缺断言。这条更正只针对措辞;下面 「OPEN: a twin pair in a non-legacy org」 的**要求本身
> 仍然 OPERATIVE**。

⚠️ **What that green is and is not.** Posture is an ORG property and the twins are asserted to share
an org, so they take the SAME branch by construction; these fixtures sit in
`legacy_projection_only` (the same posture §3.12.3 records for the end-to-end case). So steps ③ and
⑦ are confirmed **non-divergent**, and are confirmed **non-divergent because both are SKIPPED** —
the `authoritative` and `shadow` branches are UNEXERCISED on both sides. Parity of two skips is
parity; it is not coverage. **OPEN**: a twin pair in a non-legacy org, which needs rollout-registry
fixture work no case in this file does today.

This probe is also what caught the `kind: 'executed'` erratum in §3.15.6.

### 3.15.10 Wiring — nothing new to pin

The acceptance lives in `approval-cancel-round-redemption.db.test.ts`, already wired into the
required lane at `.github/workflows/plugin-tests.yml:1668`. **No new file, no new lib, no new table
⇒ none of the four attendance census pins and no s6a re-pin are triggered by this unit.** This is
the saving §3.15.0's provenance correction bought.

---

## 3.16 `unrecoverableExpired` 呈现 — the persistence half, MEASURED; the surface half, still owner's (this unit)

The task names 账侧验收 as 「完整取消结果逐字节等价于现有 W4 路径 **+ `unrecoverableExpired` 呈现**」
(lock §8 期 1, lock:169), and lock:86 states the requirement inside C-1's step list:
「`reverseLeaveBalanceDeduction`(返回 `unrecoverableExpired`,**必须呈现**)」.

The previous revision's §3.15.6 called this item CLOSED-BLOCKED for two reasons. **One of them was
wrong**, and the correction is what this unit is.

### 3.16.1 The two reasons, re-evaluated one at a time

| §3.15.6's reason | Verdict now |
|---|---|
| (a) 「no fixture seeds leave-balance lots, so both paths produce zero counters」 | **STOOD, and CLOSED by this unit.** It was a real TEST gap: `0 === 0` cannot distinguish 「computed and zero」 from 「never computed」. §3.16.2's fixture makes the expected value **120**. |
| (b) 「`redeemCancelRoundInTxn` DISCARDS the entry's `{ kind: 'executed', response }` payload, so the approval side has **no channel to present it on at all**」 | **RETRACTED IN PART (§0 R-8).** The discard is real. The 「at all」 is not — the payload is persisted by the W4 seal, in the caller's transaction, before `redeemCancelRoundInTxn` ever sees it. |

The mechanism for (b), read rather than recalled:

```
$ git grep -n "sealAttendanceResultOperationV1" -- packages/core-backend/src/attendance/w4c3b-request-operation-boundary.ts
…:32     <- the import
…:918    <- the ONE call in this boundary
$ git grep -c "sealAttendanceResultOperationV1" -- packages/core-backend/src/attendance/w4c3b-request-operation-boundary.ts
2
```

⚠️ The 「ONE call」 is scoped **to this file**, and the scope is load-bearing: repo-wide the seal has
**9 call sites across 4 boundaries** (`git grep -c "await sealAttendanceResultOperationV1(" --
packages/core-backend/src` ⇒ `w4c2-live-scheduled-boundary.ts:6`,
`w4c3a-canonical-import-kernel.ts:1`, `w4c3b-request-operation-boundary.ts:1`,
`w4c3c-record-operation-boundary.ts:1`), and its definition is
`w4c0-operation-registry.ts:756`. A first draft of this block printed the three-line narrow list as
though it were the repo-wide grep's whole output; it is not, and the corrected commands are above.
The claim this section needs is only the file-scoped one — `request_cancel` runs through the `w4c3b`
boundary — but an unscoped 「the ONE call」 would have been false.

`w4c3b-request-operation-boundary.ts:918-921`:

```ts
await sealAttendanceResultOperationV1(trx, identity, {
  responseSnapshot: jsonValue(result.response),
  resolvedRequestId: result.resolvedRequestId,
})
```

and `w4c0-operation-registry.ts:764-778` writes it as
`UPDATE attendance_result_operations SET state = 'completed', response_snapshot = $4::jsonb …`
on `trx` — which, on this path, **is the approval side's own transaction client** (lock §3 C-1
「仅移交连接与事务生命周期的所有权」). Three consequences, and each is what makes the 「at all」
false:

1. the seal is **not** conditional on `isLegacyCompat` (only the outbox enqueue above it is), so it
   runs on the legacy posture this fixture resolves to.
   ⚠️ Two halves, two provenances, because this bullet mixes them: the unconditionality is READ
   from `w4c3b-request-operation-boundary.ts:905-921` (the `if (!isLegacyCompat)` wraps only the
   enqueue; the `await sealAttendanceResultOperationV1(...)` sits outside it) — that half is source,
   and it is also what M-23 exercises. **「this fixture resolves to the legacy posture」 is
   INHERITED**, from §3.12.3's assertion on the END-TO-END case's fixture, not pinned by §3.16's
   own case: the new case asserts nothing about `acceptedWritePosture` and adds no
   zero-`approval_reversal` line of its own. The two fixtures are built by the same helpers, which
   is why the inheritance is reasonable — but it is an inheritance, and if the posture ever changes
   §3.12.3 is the line that goes red, not this one;
2. `result.response` is the adapter's **whole** response object — `{ ok, data: { requestId, status,
   orgId, userId, reversal, … } }` (`index.cjs:35275-35285`) — so `data.reversal` and its
   `unrecoverableExpired` go in verbatim;
3. it commits with the approve, atomically, because it is the caller's transaction.

So the honest statement of what is open is **narrower** than the one that was written: the payload
is computed, persisted and queryable per operation id; what nobody has decided is **which
user-facing surface renders it**. That is an owner decision (the DTO? the round's detail view? a
notification?), and inventing one here would be 另造 a presentation contract the lock does not name.

### 3.16.2 The fixture — why an EXPIRED lot, and why that makes the measurement two-sided

`reverseLeaveBalanceDeduction` (`index.cjs:19392-19446`) has two branches per deduct row. The
expired one (`index.cjs:19417-19425`, its own comment calls it §3a) is:

- `unrecoverableExpired += deducted`
- **no** `reverse` event written
- **no** `remaining_minutes` touched

That asymmetry is what makes a single fixture check the claim from both directions: the counter must
be 120, **and** the writes a non-expired lot would have made must be absent. A live lot would have
given `reversed: 120, lots: 1` and a `reverse` event instead, so the two halves cannot both be green
by accident.

Seeded before the approve (`approval-cancel-round-redemption.db.test.ts`, the file's last case):

| Row | Values that matter |
|---|---|
| `attendance_leave_balances` | `user_id = fixture.requesterId` (the id `attachAttendanceRequest` writes as `attendance_requests.user_id`, which is what the helper reverses on), `amount_minutes 480 / remaining_minutes 360`, `expires_at = now() - 1 day`, `status 'expired'` |
| `attendance_leave_balance_events` | `event_type 'deduct'`, `delta_minutes -120`, `source_id = attached.requestId` — the helper's scan predicate is `source_id = $3 AND event_type = 'deduct'` |

**NON-VACUITY is asserted, not argued.** Before the action the case reads the lot back through
**production's own predicate** (`(expires_at IS NOT NULL AND expires_at <= now()) AS expired`) and
counts the deduct rows: `expired = true`, `remaining_minutes = 360`, `deducts = '1'`. Without those
two rows the counter assertion would be `unrecoverableExpired === 0` and would pass against a path
that never called the helper at all — which is exactly the shape §3.15.6 reason (a) named.

`approvedLeave` — the gate on the reversal call (`index.cjs:35066`, `:35268`) — is
`requestRow.status === 'approved' && requestRow.request_type === 'leave'`, and
`attachAttendanceRequest` inserts exactly that pair. Note this branch is **not** posture-gated,
unlike the P14 cancellation calculation at `:35169`, which is why the reversal runs on this fixture
while §3.12.3's P14 assertion stays a zero.

### 3.16.3 What the case asserts, in order

1. the REAL port is bound (`getAttendanceCancellationExecutionPort()` defined) — a double seals
   nothing, so every assertion below would be red against one;
2. non-vacuity of the fixture (above);
3. the approve returns 200, the round is `applied`, and `attendance_requests.status = 'cancelled'`
   — so an absent seal below cannot be the boring absence of a redemption;
4. **the channel**: exactly one `attendance_result_operations` row for
   `deriveCancelRoundW4OperationIdV1(roundId)`, `state = 'completed'`, and its
   `response_snapshot.data.reversal` deep-equals
   `{ reversed: 0, lots: 0, unrecoverableExpired: 120, alreadyReversed: false }` — pinned as the
   WHOLE object rather than the one counter, because `unrecoverableExpired: 120` next to
   `reversed: 0` is what says the portion was **counted instead of restored**;
5. §3a's absences: the lot's events are exactly `[{deduct, 1}]` (zero `reverse`), and
   `remaining_minutes` is still 360 with `status` still `expired`;
6. **the surface is still open**, as a negative: the approve's `UnifiedApprovalDTO` contains
   neither `unrecoverableExpired` nor `reversal` anywhere in its JSON. Same shape as the 账侧 case's
   own negative — the day a channel is added, both go red and this section's OPEN item must be
   revisited rather than quietly staying open.

### 3.16.4 Mutation ledger (this unit)

Both probes are on PRODUCTION code, not on the fixture — a fixture mutation would die on the
non-vacuity pre-check (that is the pre-check's job) and would prove nothing about the assertion.
`cp` backup → mutate → run the WHOLE file → `cp` restore → `cmp`.

| ID | Mutation | Expected | Measured |
|---|---|---|---|
| M-23 | `w4c3b-request-operation-boundary.ts:919` — `responseSnapshot: jsonValue(result.response)` ⇒ `jsonValue({ mutated: true })` (the seal still runs, still completes, still writes a snapshot — only the payload is gone) | the new case red at the `response_snapshot.data.reversal` assertion; every other case green | **exactly 1 red / 16 green.** `AssertionError: expected undefined to deeply equal { reversed: +0, lots: +0, …(2) }` at `approval-cancel-round-redemption.db.test.ts:2013:39` — the named site |
| M-24 | `plugins/plugin-attendance/index.cjs:19423` — `unrecoverableExpired += deducted` ⇒ `unrecoverableExpired += 0` (the §3a branch still skips the restore; only the counter stops counting) | same case red, same site, with a PRESENT object whose counter is 0 | **exactly 1 red / 16 green.** `AssertionError: expected { lots: +0, reversed: +0, …(2) } to deeply equal { reversed: +0, lots: +0, …(2) }` at `:2013:39` |

⚠️ **LINE-NUMBER DRIFT, converted rather than left to rot.** Both mutant runs happened BEFORE the
three stale in-file claims were reconciled in the same commit (the suite header, the END-TO-END
case's 呈现 bullet, and the 账侧 case's finding (b) — see §3.16.1), which added **9 lines** above the
assertion. The frame both runs printed is `:2013:39`; the same assertion now sits at **`:2022`**
(`git grep -n "expect(snapshot.data?.reversal)"` ⇒ one hit, `:2022`). The mutants were not re-run
after the comment edits — comments cannot change a result — so the frames are recorded as MEASURED
(`:2013`) with the conversion stated, not silently rewritten to today's number.

The pair is the point: M-23 says the assertion is bound to **the seal's payload** (not to some
other row that happens to be there), and M-24 says it is bound to **the counter's own computation**
(not merely to an object being sealed). Either alone would leave the other unproven. Both restored
byte-identically (`cmp` silent) and the file re-run clean at **17 passed (17)**.

⚠️ What the ledger does NOT contain, stated so it is not read as absent-because-unnecessary: no
mutation of `redeemCancelRoundInTxn`'s discard. There is nothing to mutate — this unit deliberately
does **not** change the discard, because threading the payload out of it would need a destination,
and the destination is the owner decision in §3.16.1. The discard is documented, not repaired.

### 3.16.5 Scope — the live-lot half is NOT here, and that is deliberate

`reversed > 0` / a `reverse` event / `remaining_minutes` restored is the OTHER branch of the same
helper. It is not what lock:86's 「必须呈现」 names (the named return value is
`unrecoverableExpired`), and it is already covered by the attendance line's own unit suite:

```
$ git grep -c "unrecoverableExpired" -- packages/core-backend/tests/unit/attendance-leave-cancellation-reversal.test.ts
6
```

Six matching LINES, of which **four are assertions**: `:52` reversed 60 / unrecoverable 0, `:76` the
pure-expired case, `:87` the mixed lot, `:103` the empty case. The other two are `:16` (the helper's
type declaration) and `:73` (a test NAME). Recorded that way because a first draft of this block
wrote `4` — the assertion count — next to a `grep -c`, which counts lines; the two are different
quantities and the command is the one that has to be true. Duplicating that branch through the
approval path would add a second, slower copy of covered behaviour and no new predicate.

### 3.16.6 Wiring — nothing new to pin

The case is appended to `approval-cancel-round-redemption.db.test.ts`, already wired at
`plugin-tests.yml:1668` and already carrying the top-level `EXPECT_DB` sentinel. No new file, no new
error code, no `plugin-tests.yml` edit ⇒ **no s6a re-pin**. Confirmed mechanically:

```
$ git diff --name-only feat/approval-cancel-round-phase1..HEAD -- .github/workflows/plugin-tests.yml
(no output)
```

The two tables the fixture writes (`attendance_leave_balances`, `attendance_leave_balance_events`)
are seeded and torn down inside the suite's existing `afterAll` (the events cascade off the lot's
`ON DELETE CASCADE` FK), so a shared DB is left as it was found.

### 3.16.7 Commands and results

```
$ (packages/core-backend) npx tsc --noEmit -p tsconfig.json
# → clean

$ (packages/core-backend) DATABASE_URL=…/metasheet2_lock_c2 EXPECT_DB=1 \
    npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-cancel-round-redemption.db.test.ts -t 'unrecoverableExpired' --reporter=dot
# → 1 passed | 16 skipped (17)

$ (packages/core-backend) DATABASE_URL=…/metasheet2_lock_c2 EXPECT_DB=1 \
    npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-cancel-round-redemption.db.test.ts --reporter=dot
# → 17 passed (17)     [after M-23 and M-24 were restored; each mutant run gave 1 failed | 16 passed]
```

⚠️ The case went green on its FIRST run. §3.12's did not, and found a shipped P1 — so a first-run
green is recorded here as what it is (the fixture worked), not as evidence the case is strong. The
strength claim rests on M-23/M-24, not on the green.

## 3.17 `attendance-parity.db.test.ts` 退役对账 — the provenance census WIDENED, and the four pins measured (this unit)

§3.15.0 retired the filename on a two-source check (the lock, and phase-1's design MD). The task
that commissioned this unit asked for the census to be run over **four** sources and for the CI pins
to be proven aligned to the final file set. Both were done, and the census found **one source
§3.15.0 did not check**.

### 3.17.1 The four-source census, each with its command and count

| # | source | provenance class | names `attendance-parity`? |
|---|---|---|---|
| 1 | the ratified lock | **OWNER-RATIFIED** | **0** |
| 2 | phase-1 design MD | implementer-authored | 4 (`:80`, `:81`, `:83`, `:486`) |
| 3 | phase-1 verification MD | implementer-authored | 8 |
| 4 | **PR #5851 body** | implementer-authored | **1 — NOT previously checked** |

```
$ grep -c "attendance-parity" \
    ~/.claude/projects/-Users-chouhua-Downloads-Github-metasheet2/reviews/approval-change-request-design-lock-draft-20260915.md
0

$ grep -c "attendance-parity" docs/development/approval-cancel-round-phase1-design-20260918.md
4
$ grep -c "attendance-parity" docs/development/approval-cancel-round-phase1-verification-20260918.md
8

$ gh pr view 5851 --json body -q .body | grep -c "attendance-parity"
1
$ gh pr view 5851 --json body -q .body | grep -n "attendance-parity"
27:判据 II(C-2 兑现挂点先于 `:11070`,W4 外部事务入口 C-1)、判据 IV(C-3 收口 `expired`/`blocked`)、attendance-parity;修改期与加班撤销不在本锁首期。
```

⚠️ **The PR body naming it does NOT flip the verdict, and the reason is the provenance class, not
the count.** The task's restore condition is 「若**锁文**或**已 ratify 的记录**点名了该文件」. PR
#5851 is a **Draft PR opened by this implementation lane** — its body is implementer-authored prose
of exactly the same class as sources 2 and 3, not an owner ratification. The repo's own rule is
that a RATIFY source is an owner-authored artefact
(`feedback_authorization_source_must_be_owner_authored`); an implementer quoting a filename into a
PR body they wrote themselves and then citing that body back is the self-certifying loop that rule
names. So the corrected statement of the finding is **narrower than 「只有任务书文本点名」 and
wider than §3.15.0's two sources**:

> The filename is named in **four** implementer-authored places (task text, phase-1 design MD,
> phase-1 verification MD, PR #5851 body) and in **zero** owner-ratified ones.

### 3.17.2 There is no file to restore — the artefact never existed

The task's restore branch presupposes `d22d6c624` deleted something. It did not:

```
$ find . -iname "*attendance-parity*" -not -path "*/node_modules/*" | wc -l
0
$ git log --all --oneline --diff-filter=A -- '*attendance-parity*'
(empty)
$ git show --stat --format="" d22d6c624
 ...approval-cancel-round-phase1-design-20260918.md |   9 +-
 ...al-cancel-round-phase2-verification-20260918.md | 256 ++++++++++++++++-
 .../approval-cancel-round-redemption.db.test.ts    | 302 ++++++++++++++++++++-
 3 files changed, 556 insertions(+), 11 deletions(-)
```

`--diff-filter=A` over `--all` returns empty: the path was never added on **any** ref, so it was
never deleted on any either. `d22d6c624` touched three files, none of them a deletion. What was
retired is a **planned deliverable NAME** carried forward through three documents; the thin-wrapper
option the task offers ("可作薄包装指向新 parity 用例") would therefore be a NEW file created to
match a name whose only authority is the documents that mis-quoted it — 另造同类物 in the literal
sense, and it would cost an s6a re-pin (§3.17.3) for zero coverage.

**DEVIATION FROM THE TASK'S LITERAL WORDING, declared.** The task's two branches are "restore it" or
"only the task text named it". Neither is exactly true, so this unit takes the second branch with
the correction above. 依据, in order: (1) the lock — the only ratified source — names a REQUIREMENT
(账侧, 逐字节等价, 现有 W4 路径, `unrecoverableExpired`) and no artefact, `grep -c` → 0; (2) the
requirement is implemented and green in `approval-cancel-round-redemption.db.test.ts` (§3.15 for the
row-level compare, §3.16 for `unrecoverableExpired`, §3.18 for its presentation); (3) the three
other sources are the same provenance class as each other and none is owner-authored; (4) creating
the file would add a required-lane suite and force an s6a recompute + `plugin-tests.yml` edit, which
is the merge-serialisation bottleneck `feedback_s6a_pin_is_a_merge_bottleneck` names, for no
coverage that the already-wired file does not already carry.

### 3.17.3 The four pins, measured against the final file set

The final real-DB file set for this lane is **seven** files — unchanged by `d22d6c624`, which added
no suite file and removed none.

| pin | where it lives | population | measured |
|---|---|---|---|
| ci-wiring 守卫人口 | `packages/core-backend/tests/unit/approval-cancel-round-ci-wiring.test.ts:60-68` (`CANCEL_ROUND_REALDB_FILES`) | 7 | 7 ✅ |
| `plugin-tests.yml` 清单 | step `id: approval-real-db-integration` run-list | 7 | 7 ✅ |
| `ci-realdb-step-contract` FILES | see the ⚠️ below | n/a — no `FILES` export | ✅ by construction |
| s6a 钉 | `pluginTestsWorkflow` digest | recomputed only when `plugin-tests.yml` changes | not perturbed ✅ |

```
$ ls packages/core-backend/tests/integration/approval-cancel-round-*.db.test.ts | wc -l
7
$ grep -c "tests/integration/approval-cancel-round-.*\.db\.test\.ts" .github/workflows/plugin-tests.yml
7
$ grep -c "'tests/integration/approval-cancel-round-.*\.db\.test\.ts'," packages/core-backend/vitest.config.ts
7
$ git log --oneline a02930896 -1 --name-only -- .github/workflows/plugin-tests.yml
e394c9e9c ci(approval): promote cancel-round real-DB suites into required test (20.x)
.github/workflows/plugin-tests.yml
```

⚠️ **The task's third pin, 「`ci-realdb-step-contract` FILES」, does not exist in the shape the name
suggests, and saying so is the point of this row.** `scripts/ops/ci-realdb-step-contract.mjs` is a
shared **helper**: `grep -n "FILES" scripts/ops/ci-realdb-step-contract.mjs` → **0 hits**. It
exports `REAL_DB_STEP_IDS` (`:99-102`, a frozen two-entry allowlist `approval` / `multitable`) plus
the predicates `isQuotedInTestExclude` / `isSuiteWiredInRealDbStep` / `realDbStepWholeFileArgs`. The
closed world of FILES for this lane lives in the **consumer** — the `CANCEL_ROUND_REALDB_FILES`
constant in row 1, which imports those four symbols. Rows 1 and 3 are therefore **the same
population read once**, not two independent pins; reporting them as two would have been the
count-guard failure `feedback_count_guard_and_fake_switch_test` names. The lane's guard is a
`tests/unit/*.test.ts` (collected by Vitest's default include, run in both required `test` legs),
not a `scripts/ops/*-ci-wiring.test.mjs` — which is why it appears in neither `scripts/ops` listing.

`e394c9e9c` is the promotion commit and the most recent touch of `plugin-tests.yml` at this base:
`d22d6c624` is not in that list, so it perturbed no workflow bytes and the s6a `pluginTestsWorkflow`
digest is untouched by the retirement. **Alignment therefore holds by construction rather than by
edit** — the retired name was never in any of the four populations, because it was never a file.

## 3.18 `unrecoverableExpired` 呈现 — the SURFACE half, CLOSED with a default (⚠️ owner 待裁, 按默认值) (this unit)

§3.16 closed the persistence half and left exactly one thing open: **which surface renders it.**
This unit implements a DEFAULT presentation contract so lock:86's 「必须呈现」 is satisfied by running
code rather than by a registered gap. The default is flagged everywhere it lands; an owner who wants
a different shape replaces it.

### 3.18.1 What the lock does and does not fix

`grep -n -i "unrecoverable\|expired\|过期"` over the lock returns 10 lines. Two bear on 呈现:

- `lock:86` — C-1 step ⑥: 「`reverseLeaveBalanceDeduction`(返回 `unrecoverableExpired`,**必须呈现**)」
- `lock:169` — 期 1 的账侧验收: 「完整取消结果逐字节等价于现有 W4 路径 + `unrecoverableExpired` 呈现」

Both say **必须呈现**. Neither names a field, a payload shape, an endpoint or a screen. So the
requirement is ratified and the contract is not — which is why this is implemented as a **named
default carrying its own 待裁 marker**, not as a silent invention.

### 3.18.2 The default contract

`core/attendance-cancellation-execution-port.ts` (appended; no new file, no new census pin):

```ts
export type CancelRoundCancellationOutcomeV1 =
  | { readonly status: 'cancelled'; readonly reversal: CancelRoundReversalSummaryV1 }
  | { readonly status: 'cancelled_with_unrecoverable_expired'; readonly reversal: CancelRoundReversalSummaryV1 }
  | { readonly status: 'cancelled_reversal_unreported'; readonly reversal: null }
```

**THREE statuses, not two,** and the third is §3.16.1's own lesson applied to the wire shape. If the
summary were simply ABSENT when nothing was reversed, 「nothing to reverse」 and 「the channel is not
wired」 would be byte-identical — the same `0 === 0` that could not tell 「computed」 from 「never
computed」. A status token is therefore carried on EVERY redemption.

**「不得与「成功」或「一般失败」同形」, satisfied by construction and asserted:**

| neighbour | why `cancelled_with_unrecoverable_expired` is not 同形 with it |
|---|---|
| 「成功」 | a distinct token: a caller that only asks 「did it cancel」 still learns the balance is short. Asserted directly — `expect(outcome?.status).not.toBe('cancelled')` |
| 「一般失败」 | it is NOT a failure shape, and making it one would be a **lie about a committed cancellation**: the cancel succeeded, the transaction committed, only some expired lots could not be refilled. Representing that as failure would invite a caller to retry or to tell the user the 撤销 did not happen |

⚠️ **This is where the task's literal wording and the domain disagree, and the deviation is
declared.** The task names the mutation 「把该状态折叠成一般失败 ⇒ 红」. There is no 一般失败 state on
this path to fold into — the redemption either commits (all four success kinds) or becomes a C-3
`blocked` closure, which is a different branch entirely and never reaches the classifier. The
mutation is therefore run in the two directions that DO exist here (M-25 folds it into 成功, M-26
folds it into the undifferentiated bucket) and both are red. Folding a committed cancellation into a
failure shape is not implemented because it would be wrong, not because it was skipped.

### 3.18.3 Two channels, and why both

| channel | where | durable? | populated |
|---|---|---|---|
| **immediate** | `UnifiedApprovalDTO.cancellationOutcome` (`services/approval-bridge-types.ts`) | ✗ action response only | the approve call that redeemed the round |
| **durable** | `approval_records.metadata.cancellationOutcome` (the `approve` audit row) | ✓ same transaction as the cancellation | read back via the existing history endpoint (`UnifiedApprovalHistoryDTO.metadata`) |

The durable half exists because an in-memory field on the action response **fails the moment anyone
reloads** — and a presentation requirement that evaporates on refresh has not been met. The audit
row is written in the SAME transaction as the business cancellation and the round's `applied`, so
it commits atomically with them. The precedent is the lock's own: `lock:94` already puts
`metadata.w4ActorPosture` on this exact audit-row family, so metadata-carrying is precedented, not
invented.

⚠️ **REGISTERED FOR OWNER, stated as a limitation rather than left to be discovered:**
`getApproval` does NOT project the field, so a later `GET /approvals/:id` omits it — the durable
read goes through the history endpoint. Making 呈现 survive a reload **on the DTO itself** means
joining the audit rows in `getApproval`, which is a hot read path; that is the owner's call, and it
is written into the field's own doc comment so a reader of the type meets it there too.

Two mechanics worth recording because both were nearly wrong:

1. **Read from `result.response`, not from a read-back of the sealed row.** The `legacy` kind
   returns BEFORE `sealAttendanceResultOperationV1` runs
   (`w4c3b-request-operation-boundary.ts:897-899` vs `:918`), so a seal-based read would be absent
   on that kind while the payload is right there in hand.
2. **`business_refused` is narrowed out first** — its type comment says it carries no `response` at
   all, and it is a `blocked` closure, not a cancellation.

The classifier is **total and non-throwing** on purpose: it runs inside the caller's SERIALIZABLE
transaction *after* the cancellation has been performed and sealed, so a presentation classifier
must not be able to roll back a committed cancellation. An unreadable payload degrades to
`cancelled_reversal_unreported`. And `unrecoverableExpired` — the field lock:86 names — is never
defaulted to `0` when unreadable: defaulting would manufacture the reassuring answer out of missing
data.

### 3.18.4 The FE half: there is no 对应面 — measured, not assumed

The task says 「前端**若有**对应面则渲染可判别文案」. The conditional does not fire:

```
$ grep -rn "cancellationOutcome\|unrecoverableExpired" apps/web/src | wc -l
0
$ grep -rln "cancelRound\|cancel-round\|CancelRound" apps/web/src
apps/web/src/approvals/api.ts        ← the `cancel_round` batch-transfer SKIP-REASON literal only (:1646-1665)
apps/web/src/approvals/batchTransfer.ts
```

There is no 撤销轮次 detail surface in `apps/web` to render onto — the only FE occurrence of the
concept is a skip-reason token for batch transfer. Inventing a screen here would be far past 「若有
对应面」. ⚠️ Consistent with §4's standing 「**FE / notification side** — C-3's 「卡片失效、端点返回
一致」 column is untouched」: the FE half of this lock is unbuilt as a whole, not skipped for this
item specifically.

### 3.18.5 Mutation ledger (this unit)

| id | mutation | site | expected | measured |
|---|---|---|---|---|
| M-25 | the expired branch folded into plain success (`return { status: 'cancelled', … }` unconditionally) | `attendance-cancellation-execution-port.ts`, `classifyCancelRoundCancellationOutcomeV1`'s final ternary | the expired case red on the status token | **1 red / 16 green** — `expected 'cancelled' to be 'cancelled_with_unrecoverable_expired'` |
| M-26 | the whole classifier folded into the undifferentiated bucket (early `return { status: 'cancelled_reversal_unreported', reversal: null }`) | same function, first statement | **BOTH** cases red — the control too | **2 red / 15 green** — `expected 'cancelled_reversal_unreported' to be 'cancelled'` AND `… to be 'cancelled_with_unrecoverable_expired'` |
| M-27 | the DURABLE write deleted (`approveRecordMetadata.cancellationOutcome = …` → `void`) | `ApprovalProductService.ts`, the approve-metadata block | the audit-row assertion red, the DTO assertion still green | **1 red / 16 green** — `expected undefined to be 'cancelled_with_unrecoverable_expired'` |

**M-26 is the one that proves the CONTROL has discriminating power**, and it is the reason the 账侧
parity case was rewritten rather than left alone: that fixture seeds NO leave-balance lots, so the
same production path yields `unrecoverableExpired: 0` there and `120` in §3.16's. A positive-only
assertion on ONE fixture would pass against an implementation that hardcodes
`cancelled_with_unrecoverable_expired` for every redemption; M-26 red on BOTH is what rules that out.

**M-27 separates the two channels.** It leaves the DTO half untouched and only the durable
assertion falls — so the two are independently load-bearing rather than one assertion read twice.

All three restored with `cp` and verified byte-identical (`cmp` → identical on both files;
`grep -c "M-25\|M-26\|M-27"` over both production files → `0` and `0`).

### 3.18.6 ⛔ THE TRIPWIRE FIRED, AS DESIGNED — and the lines were rewritten, not deleted

§3.15.6 registered its OPEN item with a live tripwire: the two cases asserted, as NEGATIVES, that no
such channel existed, 「so the day a channel IS added, the line goes red and this OPEN item must be
revisited rather than quietly staying open」. A channel was added by this unit. Both went red:

- `approval-cancel-round-redemption.db.test.ts:1887` (账侧 parity) — `not.toContain('reversal')` etc.
- `:2047` (§3.16's case) — `not.toContain('unrecoverableExpired')` / `not.toContain('reversal')`

They are **rewritten as positive assertions of the new contract**, never deleted and never excluded.
Deleting them is precisely the move §3.15.7 warns about ("nobody later 'fixes' the red by adding
`actor_id` to the exclusion table"). The mechanism worked exactly as it was designed to: the OPEN
item came back to a human instead of ageing out.

### 3.18.7 What this does NOT claim

- **It is not an owner ratification.** The lock fixes 必须呈现 and nothing else; the status tokens,
  the two channels and the action-response scope are all implementer defaults, marked 待裁 in the
  type, in the DTO field's doc comment, and here.
- **「零行为变化 for every other dispatch」 is narrow and true by construction, not by sweep**:
  `dispatchCancellationOutcome` stays `null` unless a cancel round was actually redeemed, so the
  field is `undefined` and the JSON is byte-identical on every other action. No sweep over all
  dispatch verbs was run for this unit.
- **No FE was written** (§3.18.4) and the notification side is untouched.
- **The counters themselves are §3.16's**, not this unit's — this unit moves them onto a surface.

### 3.18.7b Blast radius of the two NEW tokens — an absence claim, with its commands

This unit adds one `approval_records.metadata` key (`cancellationOutcome`) and one DTO field. The
repo has a standing finding that new tokens on the approval audit-row family hit pinned copies
across lines (`finding_approval_action_verb_pinned_copy_blast_radius`), so 「the suites I ran passed」
is not the claim — **no closed-world guard over either shape exists** is, and it is measured:

```
$ grep -rn "approveRecordMetadata\|w4ActorPosture" --include='*.ts' --include='*.cjs' --include='*.mjs' \
    packages plugins scripts | grep -v node_modules | grep -v ApprovalProductService.ts | wc -l
18        # all ADDITIVE reads/writes of individual keys — no key allowlist, no closed world

$ grep -rln "toMatchSnapshot\|toMatchInlineSnapshot" --include='*.ts' packages/core-backend/tests | wc -l
0         # no snapshot can go stale on a widened metadata blob or DTO

$ grep -rn "Object.keys(.*[Dd]to" --include='*.ts' packages/core-backend/tests
packages/core-backend/tests/unit/elearning-title-policy.test.ts:202  # a DIFFERENT, unrelated DTO
```

The 18 hits read or write NAMED keys (`metadata.w4ActorPosture` etc.); none enumerates the metadata
object's key set, so an added key breaks none of them. ⚠️ SCOPE: the greps cover `packages`,
`plugins` and `scripts`; `apps/web` was counted separately in §3.18.4 (→ 0). Corroborating runs:
sibling cancel-round suites 21 passed (21), approval unit corpus 191 passed (191).

### 3.18.8 Commands and results

```
$ (packages/core-backend) npx tsc --noEmit -p tsconfig.json
# → clean

$ (packages/core-backend) DATABASE_URL=…/metasheet2_lock_c2_u3 EXPECT_DB=1 \
    npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-cancel-round-redemption.db.test.ts --reporter=dot
# → 17 passed (17)     [and again after all three mutants were restored]

$ (packages/core-backend) npx vitest run tests/unit/approval-cancel-round-ci-wiring.test.ts
# → 6 passed (6)       [the file set is unchanged — no new suite file, so no pin moves]
```

### 3.18.9 Wiring — nothing new to pin

No new `.db.test.ts`, no new suite file, no `plugin-tests.yml` edit, no s6a recompute. The
acceptance lands in `approval-cancel-round-redemption.db.test.ts`, already in all four populations
(§3.17.3), for the same reason §3.4 and §3.15.0 made that call. The production change is two
existing `src/` files plus an append to a third; none is a gated artefact.
---

## 3.19 §9-9 允许集的 `approve` 成员半边 — C-1 门审 P3-1 / R5-M7 的承接 (this unit)

C-1 第 5 轮门审(`impl-gate-C-slice1-round5-20260918.md` §3 P3-1、§4 表 R5-M7)的裁定:ratify 的
§9-9 允许集 `{approve, reject, revoke, comment}` 有**补集半边**与**成员半边**,C-1 只钉住了补集。
门审逐格亲跑的成员半边结果是 `reject` ⇒ 2 红、`revoke` ⇒ 4 红、`comment` ⇒ 1 红、**`approve` ⇒
48/48 全绿**。锁文自己把这一格划给 C-2:`approve` 就是 §14.3 出口 #5,出口 #5 就是判据 II。

### 3.19.1 先测量,再写用例 — 这一格在 C-2 上**已经不空了**

在写任何用例之前,先把门审的 R5-M7 在本分支 head 上原样重跑一遍(`'approve'` 从
`CANCEL_ROUND_ALLOWED_ACTIONS`(`ApprovalProductService.ts:4432-4437`)移除,其余一字不改):

```
$ 基线 DATABASE_URL=…/metasheet2_lock_c2_u2 EXPECT_DB=1 \
    npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-cancel-round-redemption.db.test.ts --reporter=dot
      Tests  17 passed (17)

$ (R5-M7 重放,本 head,新用例尚未写)
      Tests  11 failed | 6 passed (17)
```

**11/17 红。** 所以「零判别力」这个状态描述在 C-2 上已经失效——它是被判据 II/IV、R2、账侧、
§3.16 这些**兑现路径上的用例**顺带钉住的。这一节如实记下这个数,而不是先写一个新用例再宣称
是它闭合了这一格。

### 3.19.2 那为什么还要一个专门的用例 —— 11 条红全是**后果红**

逐条看那 11 条红的断言文本,没有一条是在断言「成员身份」:

| 红的形状 | 例子 |
|---|---|
| `expected 409 to be 200` | 判据 IV、I3(C-3 半)、判据 II、判据 IV `blocked`、账侧、§3.16 等 8 条 |
| `expected 'CANCEL_ROUND_OUTLET_FORBIDDEN' to be '<本用例自己的码>'` | `CANCEL_ROUND_WINDOW_ANCHOR_MISSING`、`CANCEL_ROUND_EXECUTION_PORT_UNAVAILABLE`、`CANCEL_ROUND_BUSINESS_TARGET_MISSING` 各 1 条 |

两种都是**后果**:它们说「兑现没发生」,不说「是动作判定闸拒的」。后果红分不清「闸把它拒了」
与「兑现在下游坏了」,并且这些断言一旦被重构(换码、换状态码、换成别的出口),这一格就**悄悄空回去**
——这正是 `feedback_digest_pin_is_not_a_behavioural_gate` 那一族。

所以本单元补的是一条让**成员身份本身承重**的用例,做法是在**同一个实例、同一次运行**里测量同一道闸的两侧:

1. **非成员对照(in-case positive control)**:`handle`(出口 #4)经 `dispatchAction` ⇒ 409
   `CANCEL_ROUND_OUTLET_FORBIDDEN`,且 `approval_instances` 的 `(version, status)` 逐列不变、轮次仍
   `pending`。这一半证明**闸在这个实例上是活的**,否则第 2 步的成功可以被读成「这里根本没有闸」
   (`feedback_positive_control_not_failclosed`)。
2. **成员本身**:同一实例上 `approve` 经真实 `POST /api/approvals/:id/actions` ⇒ 200,并且
   **正向**断言兑现真的发生了(port 被调 1 次、实例 `approved`、轮次 `applied` + `ended_at` 非空),
   而不是断言「不是 `CANCEL_ROUND_OUTLET_FORBIDDEN`」——`notEqual` 族分不清成功与因别的原因失败
   (`feedback_not_this_error_is_not_an_outcome_assertion`)。

允许集字面量是**本地独立副本**,不 import 生产的 `CANCEL_ROUND_ALLOWED_ACTIONS`——import 会让这条
用例对它要抓的收窄回归**同义反复**;这与补集半边
(`approval-cancel-round-outlet-guards.db.test.ts:401`)的理由逐字相同。用例自带两条空转防护
(`has('approve') === true`、`has('handle') === false`),否则两个半边就不再是「成员」与「非成员」。

### 3.19.3 Mutation 台账(this unit)

`cp` 备份 → 改 → 单独跑 → `cp` 还原 → `cmp`。

| # | Mutation | site | expected | measured |
|---|---|---|---|---|
| M-25 | 门审 R5-M7 同一条:从 `CANCEL_ROUND_ALLOWED_ACTIONS` 删掉 `'approve'`(1 行),其余一字不改 | `ApprovalProductService.ts:4433` | 新用例红,且红在**成员判定**那一行、错误码逐字是 `CANCEL_ROUND_OUTLET_FORBIDDEN` | **单跑新用例:1 failed / 17 skipped**,红在 `approval-cancel-round-redemption.db.test.ts:1146:62`,`AssertionError: {"error":{"code":"CANCEL_ROUND_OUTLET_FORBIDDEN","message":"Cancel-round instances do not accept action \"approve\""}}: expected 409 to be 200`。**全文件:12 failed / 6 passed (18)**——即 §3.17.1 的 11 条后果红 + 本用例这 1 条成员红 |

红落在 `:1146` 而不是更早的对照行,这一点本身是判据:对照半边(`handle` ⇒ 409、行不变)在
mutation 下**仍然通过并被求值**,所以本用例的红确实是「`approve` 不再是成员」而不是「闸整个没了」
——§3.14.1 那条「用例死在更早的断言上 ⇒ 该子句没有承载 mutation」的陷阱在这里被显式避开了。

还原后 `cmp` 与两份备份**都**逐字节相同,`git status` 只剩测试文件一项修改:

```
$ cmp /tmp/u2-APS-m25.ts src/services/ApprovalProductService.ts   → RESTORED-IDENTICAL
$ cmp /tmp/u2-APS-backup.ts src/services/ApprovalProductService.ts → ALSO-IDENTICAL-TO-PRE-M7
$ git status --short
 M packages/core-backend/tests/integration/approval-cancel-round-redemption.db.test.ts
```

### 3.19.4 这条用例**不**证明什么

- **不**是允许集四个成员的机械遍历。它只钉 `approve` 一格;`reject`/`revoke`/`comment` 三格的钉由
  门审第 5 轮 R5-M8/M9/M10 在 C-1 上逐格测量过(分别 1/4/2 红),本单元**不继承也不重跑**它们,
  它们仍是 C-1 的证据、绑 C-1 的 head。
- **不**证明 `handle` 之外的补集成员——那是补集半边的事,在 `outlet-guards.db.test.ts:401` 用
  `APPROVAL_ACTION_TYPES` 机械遍历,本用例只借 `handle` 当**本例对照**,不重复那次遍历。
- 兑现半边绑的是**测试替身** port(`bindCancellationPort`),与 §3.11.6 四例同一层级:它证审批侧
  的半个合同,不证真实 W4 协议(那是 §3.12 的端到端用例)。

### 3.19.5 Wiring — 无新增钉

用例追加进 `approval-cancel-round-redemption.db.test.ts`,该文件已在
`.github/workflows/plugin-tests.yml:1668` 的 `approval-real-db-integration` 步骤里。**无新
`.db.test.ts`、无新 lib、无新表 ⇒ 不触发 s6a 重钉、不触发考勤四道普查钉、不触发 W7-R10 分类、
`scripts/ops/ci-realdb-step-contract.mjs` 无欠账**(§0 R-6 已裁定后者对新文件也零欠账)。顶层
`EXPECT_DB` 哨兵与两点接线对该文件早已就位。

```
$ grep -n "approval-cancel-round-redemption" .github/workflows/plugin-tests.yml
1668:            tests/integration/approval-cancel-round-redemption.db.test.ts
$ git status --short   # 本提交touch 的文件
 M packages/core-backend/tests/integration/approval-cancel-round-redemption.db.test.ts
 M docs/development/approval-cancel-round-phase2-verification-20260918.md
```

### 3.19.6 Commands and results

```
$ npx tsc --noEmit -p tsconfig.json
[exited with code 0]

$ DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c2_u2 EXPECT_DB=1 \
    npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-cancel-round-redemption.db.test.ts --reporter=dot
      Tests  18 passed (18)          ← 新用例落地后
```

私有库 `metasheet2_lock_c2_u2`(本子 lane 自建:`createdb` + `npx tsx src/db/migrate.ts`,409 条迁移
全绿,`to_regclass('public.approval_rounds')` → `approval_rounds`,421 张表)。未触碰任何共享 /
staging / 生产库。

---

## 3.18 §5 I3 「终结即释放」 的 **C-2 半边** — 两个终态写入方里的第二个,现在也有了探针 (this unit)

§3.14.5 把 `approval_rounds.outcome` 的终态写入方做了**全仓、双语法**普查,并在 §3.14 给其中一个
建了 M-21。另一个——C-2 成功路径的 `applied` 写——当时**没有探针**,§3.14.5 自己的表里写着
「**NO.** The test file comments it as I3 at `:1027`, but no probe exists」。本单元把它补上。

### 3.18.1 普查在**本 head 上重新导出**,不继承 §3.14.5 的数

§3.15.1 警告过:§3.15 以上的每个绝对数都是在 `7ef8e610e` 基点上量的、绑那个 head。本单元在
`a02930896` 基点的工作树上原样重跑那条普查命令:

```
$ git grep -nE "UPDATE approval_rounds|approval_rounds['\"]?\)?[[:space:]]*\.set|updateTable\(['\"]approval_rounds" \
    -- packages plugins | grep -v '\.test\.'
ApprovalProductService.ts:899    ← 散文注释
ApprovalProductService.ts:8768   ← 散文注释
ApprovalProductService.ts:8947   ← C-3 system close(`expired`/`blocked`)   M-21(§3.14)
ApprovalProductService.ts:9108   ← C-2 success(`applied`)                  M-26(本单元)
ApprovalProductService.ts:11263  ← 判据 III 发起人撤回(`withdrawn`)        phase 1
ApprovalProductService.ts:11750  ← 判据 III 审批人驳回(`rejected`)          phase 1
$ … | wc -l
6
```

**6 条命中、2 条是散文注释、4 条是语句、`plugins/` 下 0 条、builder 语法 0 条**——与 §3.14.5 在旧
head 上的结论逐项一致,但这是**本 head 自己的测量**,不是继承。本切片范围内的两个写入方现在**各有
一个探针**。

### 3.18.2 为什么又是一条独立用例,而不是往判据 II 上再加一行

§3.14.1 的教训,在同一个文件里第二次适用:判据 II 那条用例的最后一行已经是
`expect(round.outcome).toBe('applied')`,但那是**末态检查**——把 M-26 打上去,它就死在那一行,
**永远走不到任何「释放」子句**。所以释放子句要有自己的用例,并且 `createCancelRoundInstance`
必须是兑现返回后的**第一条语句**。实测证实了这个排序的必要性:M-26 下判据 II 那条确实红在它自己的
`applied` 断言上。

### 3.18.3 ⚠️ 夹具前提是**测量出来的**,不是默认的

这是本用例与 M-21 那条最不一样的地方,必须写清楚:

生产上,一次成功的兑现会经 C-1 把**原单据**写成 `approved → cancelled`,而
`createCancelRoundInstance` 的前提正是单据处于 `approved`。**若原单真被取消了,第二轮会因为「单据
状态」这个与轮次槽位无关的理由被拒**——那样这条用例的红就不再是 I3 的红。

本用例用的是**测试替身** port(`bindCancellationPort`,与 §3.11.6 四例同层级),它什么都不写,所以
原单仍是 `approved`,横在兑现与第二轮之间的**只剩轮次行自己的 outcome**——这正是这条探针需要的隔离。
用例把这个前提**写成断言**(最后一行读原单 `status` 必须仍是 `approved`),而不是默默依赖它。

**代价,如实写在这里**:这条用例量的是**槽位释放**,不是「同一单据连取消两次」的端到端产品行为——
后者锁文并未要求(§5 I6 「撤销不限次」讲的是**轮次**不限次,phase 1 的 chain 用例已覆盖)。真实
边界下的兑现会不会让第二轮因单据状态被拒,**本用例不回答**,登记在 §4。

### 3.18.4 Mutation 台账(this unit)

`cp` 备份 → 改 → 跑 → `cp` 还原 → `cmp`。

| # | Mutation | site | expected | measured |
|---|---|---|---|---|
| M-26 | 与 M-21 **同形**:在 `redeemCancelRoundInTxn` 里把 `UPDATE approval_rounds … SET outcome = 'applied', ended_at = now(), policy_snapshot_at_decision = $2`(`:9107-9114`)**与**它的 `if (roundResult.rowCount !== 1) throw`(`:9115-9121`)**一起**删掉,15 行换成 1 行标记 | `ApprovalProductService.ts:9108`(C-2 成功写入方) | 本用例红,且红在它的 **create 行**(即子句被求值后失败),而不是更早 | **单跑本用例:1 failed / 18 skipped**,红在 `redemption.db.test.ts:1217:20`,栈帧 `ApprovalProductService.createCancelRoundInstance src/services/ApprovalProductService.ts:8563:15`,`ServiceError: This document already has a cancel round in progress`,`{ statusCode: 409, code: 'CANCEL_ROUND_ALREADY_PENDING' }`。**全文件:5 failed / 14 passed (19)** |

两行**一起**删是刻意的,理由与 M-21 逐字相同:只删 `UPDATE` 会让 `roundResult` 变成 undefined,
探针产出的是 `TypeError`,那是**另一种红**,不是这里要主张的那一种。

全文件 5 条红是:判据 II、§9-9 成员钉(§3.17)、**本用例**、判据 II 端到端、§3.16 —— 前两条与后两条
都死在**它们自己的 `applied` 断言**上,这正是 §3.18.2 的直接确认:**没有一条能承载这条 mutation**,
只有把 create 排在第一位的本用例能。

**门是预检,不是索引**——与 §0 R-7 对 M-21 的更正逐字同一条:红的栈帧是 `:8563:15`,即
`createCancelRoundInstance` 自己的应用层预检(`SELECT id FROM approval_rounds WHERE document_id = $1
AND outcome = 'pending'`),`INSERT` 从未到达约束。所以本用例**证**:C-2 的终态 `outcome` 写是释放
单据 pending 槽位的那一步;**不证**任何关于 `uq_approval_rounds_pending_document` 本身的事——要碰到
索引需要构造并发,本用例不构造。

还原后:

```
$ cmp /tmp/u2-APS-m26.ts src/services/ApprovalProductService.ts     → RESTORED-IDENTICAL
$ cmp /tmp/u2-APS-backup.ts src/services/ApprovalProductService.ts  → ALSO-IDENTICAL-TO-SESSION-BASELINE
$ git status --short
 M packages/core-backend/tests/integration/approval-cancel-round-redemption.db.test.ts
```

### 3.18.5 Commands and results

```
$ npx tsc --noEmit -p tsconfig.json
[exited with code 0]

$ DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c2_u2 EXPECT_DB=1 \
    npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-cancel-round-redemption.db.test.ts --reporter=dot
      Tests  19 passed (19)        ← 新用例落地后(§3.17 的 18 + 本条)
```

### 3.18.6 Wiring — 无新增钉

同 §3.17.5:用例追加进已在 `plugin-tests.yml:1668` 的
`approval-cancel-round-redemption.db.test.ts`,无新文件 / 新 lib / 新表 ⇒ s6a、考勤四钉、W7-R10、
`ci-realdb-step-contract.mjs` 全部零欠账。

---

## 3.19 账侧七步的**逐步处置**,写成依据而不是表格单元 (this unit)

§3.15 用一张表给 C-1 七步各标了一个状态。本节把其中三类**写成依据**:①/② 为什么不是「跳过」而是
**没有可比的终态**,③/⑦ 的开放项**究竟是什么**(不是它看起来的那样),⑥ 的平价半边**能不能构造**。

### 3.19.1 ①「锁两行 `FOR UPDATE`」与 ②「状态复核」——依据,引锁文行号

锁文对这两步的原文在 **lock:84**:

> 锁 `attendance_requests` 与原 `approval_instances` `FOR UPDATE` → 状态复核 → 按运行模式追加取消计算 →

它们在 §8 期 1 的**账侧**验收里(lock:169「完整取消结果**逐字节等价于现有 W4 路径**」)**没有可比对象**,
理由是逐字节等价是一条**行级**判据,而这两步都不落行:

- **①**:`FOR UPDATE` 是事务内持有的**行锁**。事务 `COMMIT` 之后,没有任何一行记录曾经取过它——
  `pg_locks` 在提交后就不再有这条目。twin 比对读的是提交后的三张表,所以 ① 在这条判据下**不可观测**,
  而不是「测了但跳过了」。
- **②**:状态复核是**读侧**判定。复核**通过**时它什么都不写,通过与否的差别只体现在后续步骤发生与否上
  ——而后续步骤(④⑤)已经各自被逐列比对。所以复核成功这一事实同样没有独立的终态可比。

**①并不是没有被覆盖,只是不归账侧管。** 锁文对 ① 的实质约束是**锁顺序**(lock:227 的
`行锁(轮次实例 → 原单据实例 → attendance_requests → 计算/段 → 余额批次)`),而那条约束由 §3.10 的
census Q-G 四条腿覆盖——含一条用真实 `40P01` 证明**修复前的顺序确实死锁**的反例。把 ① 记成「账侧未覆盖」
会读成一个并不存在的缺口;它的门在别处,且那道门是建过的。

**②的负例方向,本分支确实没有。** 「复核**失败**时必须拒绝」是一条**行为**断言,不是平价断言;本分支
没有任何用例构造「考勤请求已不在可取消状态」的夹具。登记在 §4,不含糊成「①/② 不适用」。

这条「零」附它的命令与计数(`feedback_absolute_claim_sweep_must_be_mechanical`),并且**限定在本切片
的两个 cancel-round 套件内**——我没有扫全仓,所以断言的人口就写成这两个文件:

```
$ git grep -nE "attendance_requests[^\n]*SET status|UPDATE attendance_requests" \
    -- packages/core-backend/tests/integration/approval-cancel-round-*.db.test.ts
(无输出)
$ … | wc -l
0
```

⇒ 这两个套件里**零**处把 `attendance_requests.status` 改成不可取消态。范围之外(别的套件、考勤线自己的
套件)**我没有扫**,所以这条不是全仓断言。

### 3.19.2 ⚠️ ③/⑦ 的开放项**不是**「把断言写出来」——它们已经是断言了

这一条是对一种**误读**的更正,而且这个误读容易发生,所以写在这里:§3.15.11 的标题是「why two of
C-1's steps are **parity-trivial** here, not covered」,正文说 ③(取消计算)与 ⑦(事件)
「**MEASURED equal (0/0)** — but skipped on BOTH」。读快了会理解成「这两步的断言被 skip 掉了」。

**不是。** 用例里没有任何 `test.skip`;③ 与 ⑦ 是**实打实的断言**,而且是按值断言的
(`calcA = calcB = '0'`、`outboxA = outboxB = '0'`,并且**两侧都按值钉**而不只断言相等——§3.15.11
自己解释了为什么:`0 === 0` 也是归因谓词写错时的返回值)。**被跳过的是生产分支**:twin 所在的 org 处于
`legacy_projection_only` 写姿态,适配器因此跳过 P14 取消计算
(`plugins/plugin-attendance/index.cjs:35169`),边界因此跳过 outbox 入队
(`w4c3b-request-operation-boundary.ts:903-916`)。

所以这两步的真实开放项是**分支覆盖**,不是断言缺失,它需要的东西也完全不同:一对**非 legacy org** 的
twin,即 rollout registry 夹具(`w4c0-operation-registry.ts:640`、`:877` 解析 `acceptedWritePosture`)
——本文件今天没有任何用例做这件事,这条「零」同样附命令与计数:

```
$ grep -n "acceptedWritePosture\|w4c0-operation-registry" \
    packages/core-backend/tests/integration/approval-cancel-round-redemption.db.test.ts
1461:   *     posture here, and the adapter's P14 branch is `approvedLeave && acceptedWritePosture !==
2051:      // registry (`w4c0-operation-registry.ts:640`, `:877`): under `legacy_projection_only` the
2115:   * `data.reversal` included (`w4c0-operation-registry.ts:756-790`). That write is issued on the
$ … | wc -l
3
```

**3 处命中,逐条读过,全部在文档注释里**(行首分别是 `*`、`//`、`*`)——**零处可执行的 registry 夹具
代码**。命中非零却是注释,这正是为什么这条要贴命令而不是只写 `wc -l`:一个只看计数的读者会把 3 当成
「已经有夹具了」。而且那还只是入场券:`authoritative`/`shadow` 分支一旦真的跑起来,
新出现的 calculation / outbox 行**各自需要自己的归一化对**(它们带各自的 id 与时间戳),否则 twin 比对
会立刻因身份列不同而红。这是一个**独立单元**,不是本单元能顺手收的一行断言。

⚠️ 因此:本单元**不**把 ③/⑦ 标成已闭合,也**不**假装它们只差一个断言。§3.15.11 的
「**OPEN**: a twin pair in a non-legacy org」保持 OPEN,措辞按本节澄清。

### 3.19.3 ⑥ 的平价半边能不能构造 —— 取决于 B 侧封不封存 ⛔ **(标题原作「尚未测量」;§3.20 已测量:B 不封存,结论 OPERATIVE,机制两句有误)**

⑥(`reverseLeaveBalanceDeduction` 返回 `unrecoverableExpired`,lock:86「必须呈现」)现在是**两半**:

- **持久化半边:已闭合**(§3.16)。兑现路径供非 null `operationId` ⇒ 走封存分支,
  `attendance_result_operations.response_snapshot` 里 `unrecoverableExpired = 120`,非零,M-23/M-24
  各 1 红。
- **呈现半边:owner 裁决**(§3.15.6/§3.16)。哪个用户可见面渲染它,锁文没定;本分支把「DTO 上没有这个
  字段」断言成**负例**,所以真加了通道就会红。

**账侧平价的那一半(twin 比对两条路径的 `unrecoverableExpired`)今天不可构造,原因是可测量的、但我没测**:
B 侧走的是 HTTP `POST /api/attendance/requests/:id/cancel`,它的 `operationId` 来自
`resolveRequestOperationId(parsed.data)`(`plugins/plugin-attendance/index.cjs:38484`、`:38570`;
定义在 `:33304`)——即**从请求体解析**。§3.15.6 记过它「often returns null」,而 null ⇒ 走
`adapter.prepare`、**不封存** ⇒ B 侧根本没有 `response_snapshot` 行可比。

**我没有对本文件 twin 夹具的那个请求体实测过这个返回值**,所以这里写的是判据而不是结论:

> ⑥ 的账侧平价能否构造 = 「twin 夹具 B 的取消请求体是否让 `resolveRequestOperationId` 返回非 null」。
> 若返回 null,⑥ 不是一条断言,而是一条**带理由的 declared divergence**(A 封存、B 不封存,因为两条
> 路径的 operation 身份来源不同);若返回非 null,则它是一条可以写的比对。

> ⛔ **SUPERSEDED BY §3.20 —— 这条判据本身的机制写错了两处,求值而不是作废。**
> **求值结果:被选中的是 null 分支,所以本节的结论(「A 封存、B 不封存」⇒ declared divergence)
> OPERATIVE 且现已被实测证实**(`sealA='1'` / `sealB='0'`,M-28)。**但支撑它的两句机制是错的:**
> (1) 「null ⇒ 走 `adapter.prepare`」**方向反了** —— `w4c3b-request-operation-boundary.ts:878-880`
> 是 `input.operationId === null ? identityPrepared : await adapter.prepare(...)`,即 null ⇒ **不**走
> `adapter.prepare`。(2) 封存**根本不由 `operationId` 把关** —— `sealAttendanceResultOperationV1`
> 在 `:918` 无条件执行,唯一能在非拒绝路径上跳过它的提前返回是 `preflight.kind ===
> 'legacy_no_operation'`(`:897`),而那要求 posture 为 `legacy_projection_only` **且** 命令无稳定身份
> (`w4c0-operation-registry.ts:641-648`)。⇒ 「非 null ⇒ 一条可以写的比对」作为**双向判据是错的**:
> 见 §3.20 的 2×2。更要紧的是,把 B 改成非 null **需要发一个合同里不存在的字段**
> (`attendance.yml:758-765` 只有 `comment`/`metadata`),那会**让 B 不再是生产的孪生**。

登记在 §4,附这条可机核的判据,而不是含糊的「⑥ 开放」。

### 3.19.4 两点接线,在**本 head** 上重新核过(不继承 §3.15.9)

§3.15.1 声明过:§3.15 以上的每个绝对数都绑 `7ef8e610e` 基点。两点接线的 exclude 半边本单元此前是
**继承**的,这里在 `a02930896` 基点上重新量:

```
$ grep -n "approval-cancel-round-redemption" packages/core-backend/vitest.config.ts
1846:      'tests/integration/approval-cancel-round-redemption.db.test.ts',
$ grep -n "approval-cancel-round-redemption" .github/workflows/plugin-tests.yml
1668:            tests/integration/approval-cancel-round-redemption.db.test.ts \
```

⇒ 两点都在:默认 lane **exclude** 它(`vitest.config.ts:1846`),required lane 的
`approval-real-db-integration` 步骤**显式列出**它(`plugin-tests.yml:1668`)。顶层 `EXPECT_DB` 哨兵在
本文件头部 `itIfExpectDb`——本单元直接读过,不是转述:

```
$ grep -n "itIfExpectDb\|EXPECT_DB" \
    packages/core-backend/tests/integration/approval-cancel-round-redemption.db.test.ts
70:const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
71:itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
```

(⚠️ 本节初稿把这个哨兵写成 `:63-66`,那是文件头 doc comment 的行,**写错了**;改成贴 grep 输出而不是
再钉一个会腐烂的行号区间。)

### 3.19.5 本节没有改动任何代码或测试

纯文档单元:把已有的测量换个说法、把误读挡掉、把三个开放项写成**可执行的下一步**而不是形容词。
本节不产生任何新的绿。

## 3.20 ⑥ 的账侧半边 —— 实测,结论是**声明式背离**而不是开放项 (this unit)

§3.19.3 把 ⑥ 登记成「判据已写、但没人去测」。本单元去测了。**它也推翻了那条判据的两句机制**,
所以这里既是结论也是勘误。

### 3.20.1 机制:闸不在 `operationId` 上,而是一个 2×2

封存语句 `UPDATE attendance_result_operations … SET state = 'completed', response_snapshot = …`
在 `w4c0-operation-registry.ts:764-789`,由边界在事务末尾 `w4c3b-request-operation-boundary.ts:918`
**无条件**调用。非拒绝路径上唯一能跳过它的提前返回是 `:897` 的
`preflight.kind === 'legacy_no_operation'`;而注册表只在 **posture 为 `legacy_projection_only`
且命令无稳定身份**时返回该 kind(`w4c0-operation-registry.ts:641-648`,注释原文
「Null-ID legacy commands create no operation row」)。所以真正的闸是 (posture × operationId) 的 2×2:

| posture | operationId | 结果 | 证据类别 |
|---|---|---|---|
| `legacy_projection_only` | null | `legacy_no_operation` ⇒ **不封存** | **MEASURED**(本单元,B 侧 `sealB='0'`) |
| `legacy_projection_only` | 非 null | 封存,返回 `legacy_compat` | **MEASURED**(本单元,A 侧 `sealA='1'`) |
| 非 legacy | null | `fail('W4C0_OPERATION_ID_REQUIRED')`(`:650-653`) | ⚠️ **NOT MEASURED** —— 纯源码文本 |
| 非 legacy | 非 null | 封存,返回 `executed` | ⚠️ **NOT MEASURED** —— 纯源码文本 |

⚠️ 第三格还多依赖一条**我没有读过**的链:「`operationId === null` ⇒ `plan.legacyNullIdCount > 0`」。
`plan` 的构造本单元没有读,所以第三格是**源码断言,不是行为断言**(本线 `源码文本断言≠行为断言`)。

### 3.20.2 B 侧无身份是**生产的代表**,不是夹具图省事

`resolveRequestOperationId`(`index.cjs:33304-33311`)只从**请求体**取 `operationId`/`operation_id`。

- **合同里没有这个字段**:`packages/openapi/src/paths/attendance.yml:758-765` 的 requestBody 只声明
  `comment` 与 `metadata`。客户端**没有地方**放 operation id。
- **唯一的生产客户端发空体**:`apps/web/src/views/AttendanceView.vue:23128-23131`,
  `body: JSON.stringify({})`。用例里的 `body: {}` 是它的抄本。

普查(排除 node_modules / docs / 测试):

```
$ grep -rn "attendance/requests/" . | grep -v node_modules | grep -i cancel | grep -v "\.md:" | wc -l
21
```

21 行**逐行归位**(不是「其余全是测试」那种含糊收尾):

| # | 归类 | 位置 |
|---|---|---|
| 1 | **生产客户端(唯一)** | `apps/web/src/views/AttendanceView.vue:23128`,`body: JSON.stringify({})` |
| 1 | 路由注册 | `plugins/plugin-attendance/index.cjs:38634` |
| 1 | 合同 | `packages/openapi/src/paths/attendance.yml:748` |
| 1 | 生成的 SDK 类型 | `packages/openapi/dist-sdk/index.d.ts:1835` |
| 1 | entrypoint 常量 | `w4c3b-request-operation-boundary.ts:386` |
| 1 | 散文注释 | `ApprovalProductService.ts:9076` |
| 15 | 测试文件 | redemption ×4、w4c3b-routes ×4、attendance-plugin ×5、uuid-validation ×1、schedule-dispatch ×1 |

⇒ 非测试、非生成物的**调用方恰好 1 个**,且它发空体。

⚠️ **DELETE 别名不在上面这条命令的产出里**——它的路径不含 `/cancel`,要单独一条:

```
$ grep -n "'/api/attendance/requests/:id'" -A 2 plugins/plugin-attendance/index.cjs | grep -B 1 cancelRequest
38640:      '/api/attendance/requests/:id',
38641-      withPermission('attendance:write', async (req, res) => cancelRequest(req, res))
```

⇒ `DELETE /api/attendance/requests/:id` 复用**同一个** `cancelRequest` 处理器,所以同样从请求体取
operation id,同样没有字段可填。

⇒ **把 B 改成会封存,等于发一个合同里不存在、任何客户端都不发的字段** —— 那是用「让 B 不再是孪生」
换一行可比的数据。所以 ⑥ 的账侧平价**不是还没写,而是在代表性夹具上不可构造**。

### 3.20.3 测量:一条谓词,两个输入

两半用**同一条 SQL、同一列**,只换 request id —— 这样 B 的 0 才有判别力(否则 B 的零可能只是谓词写错):

```sql
SELECT count(*)::text FROM attendance_result_operations WHERE resolved_request_id = $1::uuid
```

⚠️ 这条 count **只按 `resolved_request_id` 收窄,不按 org/entrypoint**,所以 `sealA='1'` 隐含一条前提:
本文件 19 条用例里没有第二条会对 A 的 request id 封存。今天成立,因为 request id 由夹具逐条新建、
互不重用。写在这里是因为断言是 `toEqual({sealA:'1'})`——将来若有夹具重用了 id,它会**因为错误的
原因**变红,读到这行的人才知道先去查前提而不是查封存逻辑。

实测 `sealA = '1'`、`sealB = '0'`。**A 的 1 就是 B 的 0 的 in-case 正控**:证明表在、谓词命中、列有值。
A 的那一行:`entrypoint='request_cancel'`、`state='completed'`、
`response_snapshot.data.reversal = {lots:0, reversed:0, alreadyReversed:false, unrecoverableExpired:0}`
—— 锁:86 要的 `unrecoverableExpired` **持久化在这里**。用例断言的是**键存在**而不是 0,所以将来
值变了不红、载体被摘掉才红(本夹具不种假期额度;§3.16 那条种了过期额度的夹具把它驱到 120)。

⚠️ **A 也可能是 0** 是进场前就准备好的结果 —— 若两侧都不封存,该写的是「两条路都不封存」而不是背离。
实测不是那样,所以这里写的是背离。

### 3.20.4 结论:⑥ 的两个载体不同,所以没有行可比

| | A(兑现路径) | B(生产 HTTP 路径) |
|---|---|---|
| `attendance_result_operations` 封存行 | **1**(带 `reversal.unrecoverableExpired`) | **0** |
| HTTP 响应体 `data.reversal` | —(DTO 丢弃,已断言为负例) | **有,且内层 `unrecoverableExpired` 键也已断言**(原先只断言外层 `reversal` 键存在,那样 B 半边比 A 半边弱,本单元补齐) |

`unrecoverableExpired` **两条路都「呈现」了,但呈现在不同的工件上**:A 在封存快照里,B 在响应体里。
逐字节比对需要一对同类行,而这里一侧根本没有行 ⇒ **declared divergence with a mechanism**,
登记在 §4,不再是 TODO。

### 3.20.5 Mutation 台账(this unit)

| id | mutation | 预期 | 实测 |
|---|---|---|---|
| M-27 | 删掉 `w4c3b-request-operation-boundary.ts:918-921` 整个 `sealAttendanceResultOperationV1` 调用 | 新断言红 | ⚠️ **混淆红,不采信为本断言的探针**:3 failed / 16 passed,全部是 `APPROVAL_ACTION_DISPATCH_FAILED` / `expected 500 to be 200` —— 变异触发了另一条真实规则(操作行停在 `claimed`),死在我的断言**之前**。按本线 `混淆的mutation要换成隔离2×2格` 换成 M-28 |
| M-28 | **隔离变异**:封存照做,只把 `resolvedRequestId: result.resolvedRequestId` 改成 `resolvedRequestId: null`(1 行) | 只有 `sealA` 半边红 | ✅ **恰好 1 red / 18 passed (19)**,红在 `redemption.db.test.ts:2144`,`sealA` `'1'`→`'0'` 而 `sealB` **保持 `'0'` 不动** —— 变异只推动了它应该推动的那一半,断言承重且有判别力 |

两次都 `cp` 备份 → 改 → 单独跑 → `cp` 还原 → `cmp` 逐字节一致;还原后 `git status` 仅显示测试文件,
**生产代码零行改动**;还原后重跑 19 passed (19),`tsc --noEmit` 退出 0。

### 3.20.6 这一节**不**证明什么

- 不证明 2×2 的两个**非 legacy** 格(见 §3.20.1 的 NOT MEASURED 标注)。
- 不证明「呈现」的**用户可见面** —— 那仍是 §3.15.6/§3.16 登记的 owner 裁决,本节只动持久化侧。
- 不证明 B 的响应体载体是**对的设计**;只记录今天它在那里,而 A 的 DTO 把它丢了(已断言为负例)。
- ⚠️ 顺带的推论,**只登记不追**:§3.15.11 给 ③/⑦ 开的下一步是「非 legacy org 的孪生对」,而按本节
  的 2×2,非 legacy + null 会直接 `fail('W4C0_OPERATION_ID_REQUIRED')` —— 若 B 仍要忠实地发 `body: {}`,
  那个孪生对**可能根本构造不出来**,和 ⑥ 撞的是同一个陷阱。NOT MEASURED;交下一单元先验这一点
  再决定要不要建。

### 3.20.7 Wiring — 无新增钉

断言追加进已在 `plugin-tests.yml:1668` 的 `approval-cancel-round-redemption.db.test.ts`,
无新文件 / 新 lib / 新表 ⇒ s6a、考勤四钉、W7-R10、`ci-realdb-step-contract.mjs` 全部零欠账。
两点接线同 §3.19.4(`vitest.config.ts:1846` exclude + `plugin-tests.yml:1668` 显式列出),
顶层 `EXPECT_DB` 哨兵在本文件 `:70-71`。

### 3.20.8 Commands and results

```
$ npx tsc --noEmit -p tsconfig.json > /tmp/u2-tsc.log 2>&1; echo $?
0                     # 0 行输出

$ DATABASE_URL=postgresql://chouhua@localhost:5432/metasheet2_lock_c2_u2 EXPECT_DB=1 \
    npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-cancel-round-redemption.db.test.ts --reporter=dot
      Tests  19 passed (19)
```

⚠️ **`tsc` 对本单元的改动是空转的,别把它当门。** 本包 `tsconfig.json` 的 `exclude` 含
`**/*.test.ts`,`include` 只有 `src`/`core`/`types` 加两个脚本:

```
$ npx tsc --noEmit -p tsconfig.json --listFiles | grep -c "approval-cancel-round-redemption.db.test.ts"
0
```

⇒ 测试文件**根本不在 tsc 的 program 里**。`tsc` 退出 0 只说明生产源码仍编译得过(本单元生产代码零
改动,所以它必然是 0),对我改的那个文件**一个字都没检查**。真正的类型/语法门是 vitest 跑本身
(esbuild transform + 执行)——本单元就是靠它抓到一次真实语法错:B 侧断言第一版把原句尾巴
「That asymmetry IS the finding…」留在了代码行后面,`tsc` 照样 0,vitest 直接
`Transform failed … Expected ";" but found "That"` 且 `no tests` 零执行。修好后才是 19 passed。

⚠️ 另:`npx tsc … | tail -N && echo $?` 取的是 `tail` 的退出码,**不是 `tsc` 的**,恒为 0。上面已改成
先重定向再单独 `echo $?`。§3.16.7/§3.17.6/§3.18.5 的「tsc clean」行用的是旧写法,**同样只覆盖生产
源码、不覆盖测试文件**——见 §0 R-10。

---

## 4. What this slice has NOT proven yet

Updated from §3 of the previous revision. Listed so no reader takes the greens above for more than
they are.

- **判据 II** (C-2 兑现挂点) — **IMPLEMENTED in §3.11**, with the C-1 port, the `blocked`
  hand-off and four acceptance cases. ⚠️ **This bullet is CORRECTED, not merely updated**: its
  previous revision scoped the double caveat to 「every one of those cases」 while §3.12 had already
  landed an END-TO-END case against the real boundary, and §3.16 has since added a second
  real-boundary case. Stated precisely now — the caveat scopes to **§3.11.6's four cases only**,
  which bind a TEST DOUBLE through the production registry and so prove the approval side's half of
  the contract and nothing about the real W4 protocol (prepare/prepareIdentity, the isolation
  assert, the rollout-lock `pg_locks` assert, posture resolution, authorization, replay preflight,
  seal/outbox). Several of those ARE exercised elsewhere: §3.12's case measures the isolation and
  rollout-lock asserts, and §3.16's measures the seal as a persisted row. Still unexercised by any
  case on this branch: posture resolution and authorization as assertions in their own right (they
  run, but nothing pins their outcome) — see §3.12.3's legacy-posture note. §3.11.3's org-key match
  remains a construction argument from a query predicate for the four double-backed cases; §3.12 is
  what turns it into a live run.
- **`filterBulkReassignDiscoveryForAttendance`'s nondeterministic org** (§3.3d) — a real defect
  found by this census, deliberately OUT of scope here, owed to the attendance line as a finding.
  Nothing on this branch depends on it.
- **判据 II's prerequisite** — the rollout advisory lock ordering blocker in §3.3b. **RESOLVED in
  §3.9**: the `dispatchAction` restructure (pre-read before `BEGIN`, conditional
  `BEGIN ISOLATION LEVEL SERIALIZABLE`, the rollout lock as the transaction's first lock, the
  fail-closed re-assert, and the `40001` mapping) is implemented and covered by census Q-F.
  What is still NOT established about it: leg 3 is a **source-order** proof, not a live concurrent
  deadlock construction (§3.9.4), and the new `503 ATTENDANCE_CALCULATION_ROLLOUT_BUSY` surface's
  route-layer handling is unverified (§3.9.3).
- **判据 IV's `blocked` half** and C-3 row 4 — **COVERED in §3.11.6**, driven by C-1's
  `business_refused` return through the same closure writer as `expired`. §3.7's table row 4 is
  updated by this; the caveat in the bullet above (a double, not the real protocol) applies to it
  too.
- **R2** (锁内最终评估失败 ⇒ 零业务取消、零 `approved` 完成事件、C-3 收口已持久化) and its named
  mutation — **BUILT in §3.13**, against the REAL W4 boundary with a live attendance target, so
  「零业务取消」 is rows (原单 still `approved`, zero `revoke`, `attendance_requests` still
  `approved`) rather than `calls.length === 0`. The 入队 mapping §4 asked for is stated from the
  lock's own step ⑥ (lock:105-107) and the probe was run at that exact site (M-20: exactly 1 red,
  60 green). ⚠️ What is NOT established, and it is the headline: **R2's three literal clauses have
  no discriminating power against the mutation the lock names for R2** — all three stayed GREEN
  under M-20 — measured by ONE run of the reordered case, whose red lands on its last line
  (`:1433:49` at mutant-run time; the later header correction shifted it to `:1435`) so all three were evaluated first (§0 R-5 retracts the first draft's weaker
  evidence) — and the assertion that carries it is an IMPLEMENTER ADDITION (the persisted
  `approve` audit row). M-20 is detected by 1 assertion out of 61 cases in this corpus. §11-③'s trap, recurring at this branch. Also still
  open from this case: the `required` posture claim (SERIALIZABLE + rollout advisory lock) is a
  construction argument here, not a `pg_locks` measurement.
- **The external end-to-end — DONE in §3.12, and it was NOT cheap.** The case is green against the
  real boundary and it found a shipped P1 (the non-UUID replay key) on its first run. Both of the
  two risks this bullet named — (a) replay preflight with a never-registered `operationId`, (b) the
  `requestBody: {}` snapshot defaults — are ANSWERED (tolerated). What is still NOT established
  from it: it exercises the LEGACY write posture, so the P14 approved-leave cancellation
  calculation is skipped (asserted, §3.12.3), and it seeds no leave-balance lots, so
  `reverseLeaveBalanceDeduction` writes nothing.
- **Two inputs the double cannot refuse, and the real boundary might** — named here so the
  end-to-end case knows what to look for:
  (a) **replay preflight with a never-seen `operationId`.** The HTTP path's
  `resolveRequestOperationId` often returns `null`, which routes into `adapter.prepare` and skips
  the seal; this call ALWAYS supplies a non-null id and so takes the `prepareIdentity` +
  preflight + seal path. What the operation registry does with an id it has never registered was
  NOT read.
  (b) **the snapshot expectations.** `requestBody: {}` yields `expectedSnapshotVersion = 0` and
  `expectedSnapshotHash = '0'.repeat(64)`, and `loadLatestRequestSnapshotToken` runs in both
  prepare and execute. If anything compares those defaults against the loaded token, every redeem
  of a request that HAS a snapshot fails. That HTTP clients may omit the same fields is weak
  evidence it is tolerated, not proof.
- **账侧完整取消结果逐字节等价** (lock §8 期 1) — **TWO of C-1's SEVEN steps COMPARED in §3.15**
  (④ 原实例+审计行, ⑤ 请求 `cancelled`), two more MEASURED equal-but-skipped (③ 取消计算, ⑦ 事件
  — §3.15.11), ⑥ **measured as a declared divergence** (§3.20, was 「open」), ①/② not end-state-observable. NOT 「the rows are equal」: a twin-fixture
  compare against the real `POST /api/attendance/requests/:id/cancel` path, with eight identity
  substitutions sourced from fixture facts and 13 declared divergences carried as data. Every other
  column is byte-equal after normalisation. M-22 red at the named site, 1 of 16.
  ⚠️ **Step-by-step disposition, written as 依据 rather than as table cells: §3.19.** ①/② have no
  twin-comparable end state (a `FOR UPDATE` held inside a committed transaction leaves no row; a
  PASSING status recheck writes nothing — lock:84), and ① is covered where the lock actually
  constrains it, as lock ORDER by census Q-G (lock:227), not by the 账侧 door. ③/⑦ are **already
  assertions** — §3.19.2 corrects the easy misreading of §3.15.11: nothing is `test.skip`ped, the
  counts are pinned as VALUES on both sides; what is skipped is the PRODUCTION branch under
  `legacy_projection_only`, so the open item is BRANCH coverage needing a non-legacy-org twin
  (rollout registry, `w4c0-operation-registry.ts:640`/`:877`) plus normalisation pairs for the rows
  that would then appear — a unit of its own. ⑥'s 账侧 parity half is **no longer open — it is MEASURED,
  and the answer is a DECLARED DIVERGENCE** (§3.20, supersedes the criterion §3.19.3 stated): one
  SQL predicate run against both twins' request ids gives `sealA='1'` / `sealB='0'` — the redemption
  seals `unrecoverableExpired` into `attendance_result_operations.response_snapshot`, the HTTP path
  writes no sealed row at all, so there is no row pair to compare byte-for-byte. A's `1` is the
  IN-CASE POSITIVE CONTROL for B's `0` (same SQL, same column, only the id differs). M-28
  (`resolvedRequestId: null`, seal itself intact) ⇒ exactly 1 red at `:2144`, `sealA` `1`→`0` while
  `sealB` holds. ⚠️ Two of §3.19.3's supporting mechanism claims were WRONG and are corrected there.
  B's null identity is **representative, not a fixture shortcut**: the published contract
  (`attendance.yml:758-765`) offers only `comment`/`metadata`, and the sole production client sends
  `JSON.stringify({})` (`AttendanceView.vue:23128-23131`) — making B seal would require a field that
  does not exist in the contract. NOT MEASURED: the two non-legacy cells of §3.20's 2×2.
  ⚠️ Also NOT built anywhere on this branch: ②'s NEGATIVE direction — a fixture whose attendance
  request is no longer in a cancellable state, so the status recheck REFUSES. That is a behaviour
  assertion, not a parity one, and no case constructs it.
  ⚠️ What is NOT closed by it, and both are measured rather than argued: (a) **request provenance
  is a SUBSTANTIVE divergence** — `approval_records.ip_address`/`user_agent` are `null` on the
  redemption path and populated on the HTTP path (§3.15.5), flagged for owner registration rather
  than excluded; (b) the case's green is **CONDITIONAL** on §3.11.4's open acting-identity decision
  and goes red by design if the owner rules the other way (§3.15.7).
- **`unrecoverableExpired` 呈现** (lock:86 「必须呈现」) — **HALF CLOSED in §3.16, and the other
  half is NARROWER than the previous revision claimed** (§0 R-8 retracts it). The persistence half
  is now MEASURED: the redemption path supplies a non-null `operationId`, so it takes the seal
  branch, and `sealAttendanceResultOperationV1` writes the adapter's whole response —
  `data.reversal` included — into `attendance_result_operations.response_snapshot` **on the
  approval side's own transaction client**, committing atomically with the approve. §3.16's case
  seeds an EXPIRED lot plus its `deduct` event and pins the sealed object at
  `{ reversed: 0, lots: 0, unrecoverableExpired: 120, alreadyReversed: false }` — a NON-ZERO
  counter, so it is no longer the `0 === 0` that cannot tell 「computed」 from 「never computed」.
  Two production mutations carry it (M-23 the seal's payload, M-24 the counter's computation),
  1 red / 16 green each, both at the same named site.
  ⚠️ **SUPERSEDED BY §3.18** (this revision) — and the tripwire this paragraph describes FIRED.
  The sentence above said the surface half was open and that the two negative assertions would go
  red 「the day a channel is added」. §3.18 adds that channel, both lines went red, and both were
  rewritten as positives rather than deleted. What remains open is narrower again, and is now a
  flagged DEFAULT rather than a gap: the status tokens and the two channels
  (`UnifiedApprovalDTO.cancellationOutcome` for the action response, the approve audit row's
  `metadata.cancellationOutcome` for the durable read) are implementer choices marked 「owner 待裁,
  按默认值」, and `getApproval` does not project the field, so a reload reads it from the history
  endpoint rather than the DTO. See §3.18.3 and §3.18.7.
- **`attendance-parity.db.test.ts`** — **RETIRED as a deliverable, and the reason is a provenance
  correction** (§3.15.0): the filename appears **zero** times in the lock
  (`grep -c "attendance-parity" <lock>` → 0); phase-1's design MD `:61-62` mis-attributed it to
  lock:169, which names a REQUIREMENT and no artefact. The requirement is implemented in the
  already-wired `approval-cancel-round-redemption.db.test.ts` (§3.15), which is why this unit
  triggers no new census pins and no s6a re-pin. Phase-1's blocked-with-reason item is discharged,
  not deferred again.
  ⚠️ **WIDENED in §3.17** (this revision). The two-source check behind this bullet missed a third
  and fourth implementer-authored naming — phase-1's VERIFICATION MD (8 occurrences) and **PR
  #5851's own body** (1). The verdict is unchanged, because all four are the same provenance class
  and none is owner-ratified, but 「只有任务书文本点名」 would have been false. §3.17 also measures
  the four CI pins against the final 7-file set and records that the artefact **never existed on any
  ref**, so nothing was deleted and nothing can be restored.
- **§5 I3 「终结即释放」 mutation** — **BUILT in §3.14** for the C-3 closure, as its own case
  (`:817-894`) whose `createCancelRoundInstance` call is the first statement after the close, so the
  clause carries the mutation instead of dying behind an earlier assertion. M-21 (delete the round
  `outcome` write AND its rowCount guard) ⇒ 4 red / 11 green, the I3 case's red on the named site.
  ⚠️ Two things this does NOT establish, both corrected from the sentence that used to be here
  (§0 R-7): (a) **the partial unique index is never reached** — the refusal comes from
  `createCancelRoundInstance`'s own pre-check (`:8558-8568`, measured frame `:8563:15`,
  `CANCEL_ROUND_ALREADY_PENDING` 409), and reaching `uq_approval_rounds_pending_document` needs a
  constructed race this case does not build; (b) **only ONE of the two terminal outcome writers is
  probed** — ⚠️ **THIS HALF IS NOW CLOSED; see §3.18.** The C-2 success writer at `:9108`
  (`outcome = 'applied'`) had no probe when §3.14 landed. M-26 deletes the `applied` write and its
  `rowCount` guard together (same shape and same reason as M-21), and the new C-2 I3 case — whose
  `createCancelRoundInstance` is the FIRST post-redeem statement — goes red at
  `redemption.db.test.ts:1217:20`, frame `ApprovalProductService.ts:8563:15`,
  `CANCEL_ROUND_ALREADY_PENDING` (409). Whole file: **5 red / 14 green (19)**, and the other four
  reds all die on their own `applied` assertions — the direct confirmation that none of them could
  have carried it. §3.14.5's population was **re-derived at this head** (6 hits, 2 prose, 4
  statements, zero under `plugins/`, zero in builder syntax), not inherited from the `7ef8e610e`
  measurement. The door is again the application pre-check, NOT
  `uq_approval_rounds_pending_document` — §0 R-7's correction applies verbatim to M-26.
  ⚠️ What §3.18 does NOT establish, stated as the fixture premise it is: the case measures the
  SLOT release using a test-double port that writes nothing, so the ORIGINAL document is still
  `approved` (**asserted** on the case's last line, not assumed). In production C-1 writes the
  original `approved → cancelled`, and `createCancelRoundInstance` is premised on an `approved`
  document — so whether a REAL-boundary redemption's second round would instead be refused for a
  document-status reason is **not answered** by this case. M-7 remains a mutation of the outcome's
  *value*, not its presence.
- **§9-9 允许集的 `approve` 成员半边** (C-1 门审第 5 轮 P3-1 / R5-M7) — **承接并闭合在 §3.17**,
  但闭合的方式与门审建议的不同,且这一点是本节的要点:门审当时写的是「零判别力」,而在本分支
  head 上重放 R5-M7 已经是 **11 failed / 6 passed (17)** ——这一格早就被判据 II/IV、R2、账侧、
  §3.16 顺带钉住了。补的用例(`:1101-1163`)因此不是「从空到有」,而是把**后果红**换成**成员红**:
  11 条红全是 `expected 409 to be 200` 或「错误码不是我要的那个」,分不清「闸拒了」与「兑现在下游
  坏了」,且会随那些断言的重构悄悄空回去。新用例在同一实例上同时测量闸的两侧(非成员 `handle` ⇒
  409 + 行逐列不变;成员 `approve` ⇒ 200 + 轮次 `applied` 正向断言),M-25 红在 `:1146:62` 且错误码
  逐字是 `CANCEL_ROUND_OUTLET_FORBIDDEN`,对照半边在 mutation 下仍被求值并通过。
  ⚠️ 不建立的:四成员的机械遍历(只钉 `approve` 一格,另三格仍是 C-1 R5-M8/M9/M10 的证据、绑 C-1 的
  head,本单元不继承不重跑);兑现半边用的是测试替身 port,与 §3.11.6 同层级。
- **卡片失效 for a carded cancel round** — see §3.8: possible, pre-existing, unswept.
- **判据 II's remaining census legs** — **RESOLVED in §3.10** for the {原单据实例,
  `attendance_requests`} pair: the adapter is reordered and census Q-G's four legs are built (the
  pre-fix order proven to deadlock with a real `40P01`, the shipped order as the positive control,
  the source anchored, the population counted). The rollout advisory lock's leg was already built as
  Q-F (§3.9). What is still NOT established here: the **decision** adapter remains request-first
  (deliberately — it is a pending-request path, out of 判据 II's scope, and LEG 4 pins it so a later
  reorder must update this file), and the two relations the cancel adapter locks BETWEEN the pair
  (`attendance_schedule_dispatch_requests`, `attendance_request_calculation_snapshots`) have no rank
  in lock:227's class list — flagged for owner registration in §3.10.1, not silently ordered.
- **The acting identity for C-1's audit row** (§3.11.4) — an implementer choice the lock does not
  name, FLAGGED for owner registration with its reasoning. Nothing else on this branch depends on
  which way it is settled, but the C-1 audit row's `actor_id` does.
- **R1 for the new guard point** — #5′ is an outlet anchor, not a chokepoint guard, so it takes no
  `CANCEL_ROUND_OUTLET_FORBIDDEN` negative control; whether §8 期 1's R1 count (9 sites) should grow
  to include it is an owner registration question, raised with the #5′ registration itself.
- **The same cycle via the DECISION adapter** (§3.10.3, §0 R-3) — still live after this commit,
  deliberately out of scope, pinned by Q-G LEG 4 and owed to the attendance line as a finding.
- **A writer-syntax (`UPDATE …`) lock-order census over the attendance plugin** (§3.10.2) — 3
  `UPDATE approval_instances` + 5 `UPDATE attendance_requests` statements are unenumerated; Q-G's
  counts cover `FOR UPDATE` reads only.
- **The two relations the cancel adapter locks BETWEEN the ratified pair** —
  `attendance_schedule_dispatch_requests` and `attendance_request_calculation_snapshots` have no
  rank in lock:227's class list (§3.10.1); flagged for owner registration, not ordered.
- **FE / notification side** — C-3's 「卡片失效、端点返回一致」 column is untouched.

## 合流记录 (u1 → u3 → u2 onto `feat/approval-cancel-round-phase2`, 20260918)

Worktree: `/private/tmp/claude-501/-Users-chouhua-Downloads-Github-metasheet2/6f6639a7-0412-43de-bd8b-0b416d18ae6b/scratchpad/wt-cancel-round-p2`.
Pre-merge HEAD `a02930896` (31 commits, tree clean, matched `origin/feat/approval-cancel-round-phase2`).
Lane SHAs confirmed against origin before merging:

```
$ git fetch origin && git rev-parse origin/feat/approval-cancel-round-phase2-u1 \
    origin/feat/approval-cancel-round-phase2-u3 origin/feat/approval-cancel-round-phase2-u2
de8fcbbe2a8205c674288ae437d1fc2d135acecf   # u1
5af6e348fa350f0975bdb199b8975b34b267b8fc   # u3
028c57fbcb1e55ada1e97a27a5dec2d21455a27f   # u2
```

### Merge sequence

```
$ git merge --no-ff origin/feat/approval-cancel-round-phase2-u1
Merge made by the 'ort' strategy.
 ...approval-cancel-round-phase2-design-20260918.md | 511 +++++++++++++++++++++
 1 file changed, 511 insertions(+)
 create mode 100644 docs/development/approval-cancel-round-phase2-design-20260918.md
# NO CONFLICT.

$ git merge --no-ff origin/feat/approval-cancel-round-phase2-u3
Merge made by the 'ort' strategy.
 ...al-cancel-round-phase2-verification-20260918.md | 336 ++++++++++++++++++++-
 .../core/attendance-cancellation-execution-port.ts |  94 ++++++
 .../src/services/ApprovalProductService.ts         |  41 ++-
 .../src/services/approval-bridge-types.ts          |  17 ++
 .../approval-cancel-round-redemption.db.test.ts    |  72 ++++-
 5 files changed, 540 insertions(+), 20 deletions(-)
# NO CONFLICT.

$ git merge --no-ff origin/feat/approval-cancel-round-phase2-u2
Auto-merging docs/development/approval-cancel-round-phase2-verification-20260918.md
CONFLICT (content): Merge conflict in docs/development/approval-cancel-round-phase2-verification-20260918.md
Auto-merging packages/core-backend/tests/integration/approval-cancel-round-redemption.db.test.ts
CONFLICT (content): Merge conflict in packages/core-backend/tests/integration/approval-cancel-round-redemption.db.test.ts
Automatic merge failed; fix conflicts and then commit the result.
```

### Conflict 1 — verification MD: BOTH lanes independently added sections numbered `3.17`–`3.20`

u3 (merged first) claimed `## 3.17` (`attendance-parity.db.test.ts` 退役对账) and `## 3.18`
(`unrecoverableExpired` 呈现, surface half) from the shared base's last section, `3.16`. u2,
branched from the SAME base, independently numbered its own four new sections `3.17`–`3.20` too
(§9-9 成员半边 / §5 I3 C-2 半边 / 账侧七步处置 / ⑥ 的账侧半边). Resolution: kept BOTH lanes' full
prose and evidence — no line dropped from either side — and renumbered every one of u2's own
headers, subsection numbers, and forward/backward cross-references to `3.19`–`3.22`:

```
$ grep -n "^## " docs/development/approval-cancel-round-phase2-verification-20260918.md | tail -8
2351:## 3.17 `attendance-parity.db.test.ts` 退役对账 ...                (u3, unchanged)
2471:## 3.18 `unrecoverableExpired` 呈现 — the SURFACE half ...          (u3, unchanged)
2667:## 3.19 §9-9 允许集的 `approve` 成员半边 ...                        (u2, was 3.17)
2787:## 3.20 §5 I3 「终结即释放」 的 C-2 半边 ...                        (u2, was 3.18)
2889:## 3.21 账侧七步的逐步处置 ...                                      (u2, was 3.19)
3034:## 3.22 ⑥ 的账侧半边 ...                                            (u2, was 3.20)
3194:## 4. What this slice has NOT proven yet
```

A second, independent collision was found and fixed the same way: u2 also assigned mutation IDs
`M-25`–`M-28` to its own four mutations, colliding with u3's own `M-25`/`M-26`/`M-27` (§3.18.5's
ledger). u3's IDs were kept; u2's were remapped `M-25→M-29`, `M-26→M-30`, `M-27→M-31` (the
discarded/confounded probe), `M-28→M-32`, across every occurrence — including TWO forward-reference
table cells (lines 1818, 1873, inside the pre-existing §3.14/§3.15 tables) and SEVEN occurrences
inside the running §4 summary that were outside the git-conflicted hunks entirely (git auto-merged
them because u3 never touched those exact lines, so they carried u2's stale numbering silently):

```
$ grep -c "M-2[5-9]\|M-3[0-2]" docs/development/approval-cancel-round-phase2-verification-20260918.md
# manually inspected each hit (28 total) and classified by section context — see the two tables
# below for the resulting, collision-free ledger.
```

u3's ledger (unchanged, `§3.16`–`§3.18`): `M-25` (expired branch folded into plain success),
`M-26` (whole classifier folded into undifferentiated bucket), `M-27` (durable write deleted).

u2's ledger (renumbered, now `§3.19`–`§3.22`): `M-29` (was M-25: `'approve'` deleted from
`CANCEL_ROUND_ALLOWED_ACTIONS`), `M-30` (was M-26: the C-2 success write + its rowCount guard
deleted together), `M-31` (was M-27, discarded as a confounded mutant — triggered a different rule
first), `M-32` (was M-28, M-31's isolated replacement: `resolvedRequestId → null` only).

One stale prose comment in the test file was corrected rather than kept: u2's trailing comment
("Measured as a negative so that the day a channel IS added, this line goes red…") described code
that u3's own rewrite (kept via git's automatic, non-conflicting merge of the lines immediately
below) had already turned from a negative into a positive assertion — keeping u2's sentence verbatim
would have asserted something false about the very next lines, so it was dropped and u3's own
comment (which correctly describes the current code) was kept in its place. No assertion, evidence
line, or mutation result was removed — only this one now-contradicted narrative sentence.

### Conflict 2 — redemption test file: both lanes extended the SAME 账侧-parity `it()` block

u3 added a comment-only block (no new statements) introducing the DTO/`cancellationOutcome` checks
that immediately follow (unconflicted, shared tail). u2 added real measurement code (`sealCount`,
`sealA`/`sealB`, `sealRowA`, `reversalA` assertions) for a DIFFERENT sub-claim (the C-1 step ⑥
seal-vs-response-body divergence). Resolution: kept u2's functional code first, then u3's comment
immediately before the shared tail it introduces — both lanes' code and both lanes' load-bearing
prose survive; only u2's one stale trailing paragraph (identified above) was dropped. Two
cross-reference fixes applied inside u2's own kept code: `§3.20.4` → `§3.22.4` (inline), and (outside
the git-conflicted hunk, in the earlier "§9-9 允许集" `it()` block at `:1143-1144` and `:1193/:1216`)
`§3.17, M-25` → `§3.19, M-29` and `M-26` → `M-30`.

### Resolution verification

```
$ git ls-files -u | wc -l
0
$ grep -c "^<<<<<<<\|^=======$\|^>>>>>>>" \
    docs/development/approval-cancel-round-phase2-verification-20260918.md \
    packages/core-backend/tests/integration/approval-cancel-round-redemption.db.test.ts
docs/development/approval-cancel-round-phase2-verification-20260918.md:0
packages/core-backend/tests/integration/approval-cancel-round-redemption.db.test.ts:0
$ grep -o "M-[0-9]\+" docs/development/approval-cancel-round-phase2-verification-20260918.md \
    | sort -t- -k2 -n | uniq -c
# M-1..M-24 (base, unperturbed), M-25/M-26/M-27 = u3 (3 each, all inside §3.16), M-29(2)/M-30(7)/
# M-31(1)/M-32(5) = u2 (renumbered) — no ID appears in both a u3-section context and a u2-section
# context.
```

Committed `1c98ff937` ("merge(approval): fold u2 lane into phase2 stack") and pushed
(`git push -u origin feat/approval-cancel-round-phase2` — accepted, no force).

### CI-wiring census, re-run mechanically post-merge (not read off the diff)

`plugin-tests.yml` is BYTE-IDENTICAL to `a02930896` (`git diff a02930896 HEAD -- .github/workflows/plugin-tests.yml` → 0 lines), so the s6a `pluginTestsWorkflow` digest is untouched by construction — verified by running the guard, not merely inferred:

```
$ node plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs
sealed-export-package-provenance.test.cjs OK
```

Five wiring points, all still 7-file (no new `.db.test.ts` landed on this branch — the only test file
either lane touched is the pre-existing `approval-cancel-round-redemption.db.test.ts`):

```
$ ls packages/core-backend/tests/integration/approval-cancel-round-*.db.test.ts | wc -l
7
$ grep -c "approval-cancel-round-.*\.db\.test\.ts" packages/core-backend/vitest.config.ts
7
$ sed -n '/CANCEL_ROUND_REALDB_FILES = \[/,/\]/p' packages/core-backend/tests/unit/approval-cancel-round-ci-wiring.test.ts | grep -c "\.db\.test\.ts"
7
$ grep -n "approval-cancel-round-.*\.db\.test\.ts" .github/workflows/plugin-tests.yml
1575:        # The seven `approval-cancel-round-*.db.test.ts` files at the tail of this run-list were   ← comment, not a run-list entry
1666-1672: seven `tests/integration/approval-cancel-round-*.db.test.ts \` lines               ← the actual 7 run-list entries
```

`scripts/ops/ci-realdb-step-contract.mjs` exports no `FILES` list (verification §3.17.3 already
established this — it is a shared predicate module the `CANCEL_ROUND_REALDB_FILES` constant above
consumes, not a second independent population); `grep -n "FILES" scripts/ops/ci-realdb-step-contract.mjs` → 0 hits, unchanged post-merge.

### Full verification run, private DB `metasheet2_lock_c2_merge`

```
$ dropdb -h localhost -p 5432 -U metasheet metasheet2_lock_c2_merge   # error: does not exist (confirms virgin)
$ createdb -h localhost -p 5432 -U metasheet metasheet2_lock_c2_merge
$ (packages/core-backend) DATABASE_URL=postgresql://metasheet:metasheet123@localhost:5432/metasheet2_lock_c2_merge \
    npx tsx src/db/migrate.ts
# → all migrations executed successfully, ends at zzzz20260918110000_add_attendance_requests_approval_workflow_key

$ (packages/core-backend) npx tsc --noEmit -p tsconfig.json
# → clean (exit 0)

$ (packages/core-backend) npx vitest run tests/unit/approval-cancel-round-ci-wiring.test.ts --reporter=dot
 Test Files  1 passed (1)
      Tests  6 passed (6)

$ (packages/core-backend) npx vitest run tests/unit/approval-product-service.test.ts tests/unit/approval-admin-jump-service.test.ts --reporter=dot
 ✓ tests/unit/approval-admin-jump-service.test.ts (9 tests)
 ✓ tests/unit/approval-product-service.test.ts (185 tests)
 Test Files  2 passed (2)
      Tests  194 passed (194)

$ (packages/core-backend) DATABASE_URL=postgresql://metasheet:metasheet123@localhost:5432/metasheet2_lock_c2_merge EXPECT_DB=1 \
    npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-cancel-round-attendance-fk-migration.db.test.ts \
    tests/integration/approval-cancel-round-creation.db.test.ts \
    tests/integration/approval-cancel-round-lock-order-census.db.test.ts \
    tests/integration/approval-cancel-round-node-timeout-effect.db.test.ts \
    tests/integration/approval-cancel-round-outlet-guards.db.test.ts \
    tests/integration/approval-cancel-round-redemption.db.test.ts \
    tests/integration/approval-cancel-round-seat-guards.db.test.ts \
    --reporter=dot
 Test Files  7 passed (7)
      Tests  78 passed (78)

$ (packages/core-backend) DATABASE_URL=postgresql://metasheet:metasheet123@localhost:5432/metasheet2_lock_c2_merge EXPECT_DB=1 \
    npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-cancel-round-redemption.db.test.ts --reporter=dot
 ✓ tests/integration/approval-cancel-round-redemption.db.test.ts (19 tests)
 Test Files  1 passed (1)
      Tests  19 passed (19)
```

No new `.db.test.ts` file was added by this slice (u2 and u3 both extended the existing
`approval-cancel-round-redemption.db.test.ts`), so no additional file needed adding to any of the
four wiring populations or to the ci-wiring guard's own population — all already carried it before
this merge (verification §3.17.3).

**All green: typecheck, both named units (194/194), the ci-wiring guard (6/6), the s6a provenance
guard, and all seven `approval-cancel-round-*.db.test.ts` files (78/78, including the merged
redemption file's own 19/19).**

Design MD's u1-authored "§9 合流后待更新" section updated in place against this merged tree (not
re-guessed): §2.2's `pending → applied` citation, §7.1's "only one terminal writer" bullet (flipped
to closed), §8's first two bullets (呈现 surface: half-closed with a default; parity retirement:
verdict unchanged, census widened), §1.1's two matching bullets, and six new rows in §1's main
scope table for u2/u3's landed units — see that document's own §9 for the full account.

### `it()` count reconciled — 19 was checked, not assumed

The redemption file's own 19-passed count above was cross-checked against a static `it()`-call
census on all three inputs, because a static count and a green run can diverge in exactly one
direction (a dropped case still passes — it just stops existing):

```
$ git show a02930896:…/approval-cancel-round-redemption.db.test.ts | grep -c "^  it("
16
$ git show origin/…-u3:…/approval-cancel-round-redemption.db.test.ts | grep -c "^  it("
16   # u3 adds ZERO new it() blocks — it REWRITES two existing ones (账侧 parity's tail, and
     # `unrecoverableExpired 呈现`'s own body) from negative assertions to positive ones; confirmed
     # by diffing base vs u3 directly, not inferred from the count alone
$ git show origin/…-u2:…/approval-cancel-round-redemption.db.test.ts | grep -c "^  it("
18   # u2 adds exactly two NEW it() blocks: §9-9 member-pin, §5 I3 C-2 half
$ grep -c "^  it(" packages/core-backend/tests/integration/approval-cancel-round-redemption.db.test.ts
18   # merged: base(16) + u3(+0) + u2(+2) = 18 — arithmetic holds
```

The vitest-reported **19** is this 18 plus ONE top-level sentinel `itIfExpectDb(...)` at `:71`
("EXPECT_DB lane must have DATABASE_URL"), which sits OUTSIDE `describeIfDatabase(...)` at 0-indent
and so is invisible to the `^  it(` (2-space) pattern above — confirmed by name against the
`--reporter=verbose` output, which lists exactly these 19 titles and no others. No case was lost in
the splice.

One accounting note, not a defect: §3.19's M-29 row ("全文件:12 failed / 6 passed (18)") and §3.20's
M-30 row ("5 failed / 14 passed (19)") are u2's OWN lane-local mutant-run measurements, taken against
u2's file before this merge (18 and 19 `it()`-plus-sentinel tests respectively, on u2's branch) — they
are historical records of what u2 measured, not re-run against the final merged **19**-test-plus-sentinel
file (⚠️ §0 R-12: this said "20" until the 2026-09-18 定稿 pass — arithmetic slip, corrected; the
paragraph's own 18+1 derivation above always said 19, and the fresh rerun below confirms it), and are
left as u2 wrote them for that reason.

---

## 定稿重跑记录(2026-09-18,independent private DB `metasheet2_lock_c2_docs`)

Purpose: this 定稿 pass does not trust the merge-record's own `metasheet2_lock_c2_merge` run (§ above)
by citation alone — it creates a THIRD, brand-new database and reruns the same command sequence from
virgin, on the current branch tip. `git diff --stat 1c98ff937..HEAD` (below) shows only the two docs
files changed since the merge commit, so this rerun exercises byte-identical source to the
merge-record's own run; it is confirmation, not a different code path.

```
$ dropdb -h localhost -p 5432 -U metasheet metasheet2_lock_c2_docs
dropdb: error: database removal failed: ERROR:  database "metasheet2_lock_c2_docs" does not exist
$ createdb -h localhost -p 5432 -U metasheet metasheet2_lock_c2_docs

$ (packages/core-backend) DATABASE_URL=postgresql://metasheet:metasheet123@localhost:5432/metasheet2_lock_c2_docs \
    npx tsx src/db/migrate.ts
… migration "zzzz20260918090000_create_approval_rounds" was executed successfully
… migration "zzzz20260918100000_seed_approval_cancel_round_published_definition" was executed successfully
… migration "zzzz20260918110000_add_attendance_requests_approval_workflow_key" was executed successfully
[exited with code 0]

$ (packages/core-backend) npx tsc --noEmit -p tsconfig.json
[exited with code 0]

$ (packages/core-backend) npx vitest run tests/unit/approval-cancel-round-ci-wiring.test.ts --reporter=dot
 Test Files  1 passed (1)
      Tests  6 passed (6)

$ (packages/core-backend) npx vitest run tests/unit/approval-product-service.test.ts tests/unit/approval-admin-jump-service.test.ts --reporter=dot
 ✓ tests/unit/approval-admin-jump-service.test.ts (9 tests)
 ✓ tests/unit/approval-product-service.test.ts (185 tests)
 Test Files  2 passed (2)
      Tests  194 passed (194)

$ (packages/core-backend) DATABASE_URL=postgresql://metasheet:metasheet123@localhost:5432/metasheet2_lock_c2_docs EXPECT_DB=1 \
    npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-cancel-round-attendance-fk-migration.db.test.ts \
    tests/integration/approval-cancel-round-creation.db.test.ts \
    tests/integration/approval-cancel-round-lock-order-census.db.test.ts \
    tests/integration/approval-cancel-round-node-timeout-effect.db.test.ts \
    tests/integration/approval-cancel-round-outlet-guards.db.test.ts \
    tests/integration/approval-cancel-round-redemption.db.test.ts \
    tests/integration/approval-cancel-round-seat-guards.db.test.ts \
    --reporter=dot
 Test Files  7 passed (7)
      Tests  78 passed (78)

$ (packages/core-backend) DATABASE_URL=postgresql://metasheet:metasheet123@localhost:5432/metasheet2_lock_c2_docs EXPECT_DB=1 \
    npx vitest --config vitest.integration.config.ts run \
    tests/integration/approval-cancel-round-redemption.db.test.ts --reporter=verbose
 ✓ … sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)
 ✓ … chain (§5 I6, 撤销不限次): revoke terminates round 1 (withdrawn) -> a fresh round can start immediately -> reject terminates round 2 (rejected) -> a third round can start immediately
 ✓ … 判据 III 正控 2 (§14.2, §6 "仅原 requester"): a non-original-requester actor cannot revoke …
 ✓ … §14.1 seed evidence: reject without a comment is rejected with the named error code …
 ✓ … DISCRIMINATING CONTROL: revoking one document's round does not touch a DIFFERENT document's own pending round …
 ✓ … erratum (…): a broken one-round-per-instance invariant fails closed with CANCEL_ROUND_INVARIANT_VIOLATION (409) …
 ✓ … 判据 IV (§14.2, outlet #5′): the in-lock final evaluation finds the §2-G2 window closed ⇒ … `expired` …
 ✓ … §5 I3 「终结即释放」 (the C-3 half): after the #5′ system close the document has NO pending round …
 ✓ … 判据 IV fail-closed (…): a document with no §2-G2 anchor is NOT closed as `expired` …
 ✓ … 判据 II (§14.2, outlet #5): an attendance-backed cancel round whose window is OPEN redeems …
 ✓ … §9-9 允许集 MEMBER pin (approve) — gate round-5 P3-1: …
 ✓ … §5 I3 「终结即释放」 (the C-2 half, outlet #5): …
 ✓ … 判据 IV `blocked` half + C-3 row 4 (业务不可逆): …
 ✓ … 判据 II fail-closed (C-3 row 5): with NO cancellation provider bound …
 ✓ … 判据 II scope fail-closed (lock §8 期 1 = 请假撤销): …
 ✓ … 判据 II END-TO-END (no double): the redemption runs the REAL W4 external-transaction entry …
 ✓ … R2 (lock §8 期 1 反例二): the in-lock final evaluation fails with the REAL W4 boundary bound …
 ✓ … 账侧 (lock §8 期 1): the redeemed cancel round leaves the SAME rows as the existing `POST /api/attendance/requests/:id/cancel` path on a twin fixture …
 ✓ … unrecoverableExpired 呈现 (lock:86): an EXPIRED lot makes the counter NON-ZERO …
 Test Files  1 passed (1)
      Tests  19 passed (19)
```

**All green, from a virgin database, on the current branch tip: migration (ends at the same
`zzzz20260918110000` file as every prior run), `tsc --noEmit`, the ci-wiring guard (6/6), both named
unit suites (194/194), all seven `approval-cancel-round-*.db.test.ts` files (78/78 including the
redemption file's own 19/19), and the redemption file's 19 `it()`-plus-sentinel titles printed by
name — matching the static census in the "`it()` count reconciled" section above exactly, with no
title missing and none renamed since that census was taken.**

---

## Mutation 台账汇总表(全 34 条;`(this unit)` 台账逐条汇总,不重新求值)

Every row below restates a result already established in its own §-numbered section above; this
table adds no new mutation and re-runs none of them (see the 定稿重跑记录 above for what WAS actually
re-run — the plain suites, not the mutants). Two columns matter for reading this table honestly:
**measured at** (which head the `cp`-backup/edit/run/restore cycle was actually performed against —
a mutation ledger row is not automatically re-validated by a later merge just because the surrounding
suite still passes green) and **verdict** (all 34 are load-bearing/discriminating except the one
explicitly marked otherwise).

| # | § | Measured at | Mutation (one line) | Result | Verdict |
|---|---|---|---|---|---|
| M-1 | §2.4 | base | `takeBusinessRefusal`: HTTP-entry branch made unreachable | exactly 2 red (the two HTTP-entry cases), 9 green | discriminating |
| M-2 | §2.4 | base | delete the `SAVEPOINT` query | exactly 1 red, 10 green | discriminating |
| M-3 | §2.4 | base | `throw result.httpError` → wrong error code/500 | red on the real-DB oracle | discriminating |
| M-4 | §2.4 | base | drop the `business_refused` guard (unconditional rollback) | exactly 1 red, 13 green | discriminating |
| M-5 | §3.6 | base | delete the closure's early `return` | exactly 1 red, 7 green | discriminating |
| M-6 | §3.6 | base | delete `deactivateAllActiveAssignments` | **GREEN — ineffective**, reclassified in §3.6, not counted as a pass | non-discriminating (disclosed) |
| M-7 | §3.6 | base | hard-code round outcome to `'rejected'` | exactly 1 red, 7 green | discriminating |
| M-8 | §3.6 | base | reverse Q-D's lock order back to round-first | exactly 1 red, 12 green | discriminating |
| M-9 | §3.3c (Q-E) | base | boundary assert uses `correlationId` instead of `orgId` | leg 4 red only, 16 green | discriminating |
| M-10 | §3.3c (Q-E) | base | delete the classifier's business-key `ORDER BY` preference | leg 3 red only, 16 green | discriminating |
| M-11 | §3.9.5 (Q-F) | base | delete the SAME shared `ORDER BY` preference | 2 red (Q-E leg 3 + Q-F leg 4), 19 green | discriminating |
| M-12 | §3.9.5 (Q-F) | base | resolver takes org from instance, not request | leg 1 red only, 20 green | discriminating |
| M-13 | §3.9.5 (Q-F) | base | move rollout-lock acquire to AFTER the row lock | leg 3 red only, 20 green | discriminating |
| M-14 | §3.9.5 (Q-F) | base | delete the `action !== 'approve'` early-out | leg 5 red only, 22 green | discriminating |
| M-15 | §3.9.5 (Q-F) | base | delete the `503 CANCEL_ROUND_DISPATCH_CONTENDED` mapping | leg 6 red only, 22 green | discriminating |
| M-16 | §3.11.7 | base | unbound-port guard fails OPEN instead of closed | exactly 1 red, 11 green | discriminating |
| M-17 | §3.11.7 | base | drop the `blocked` hand-off | exactly 1 red, 11 green | discriminating |
| M-18 | §3.12.4 | base | revert the P1 fix (raw `roundId` as `operationId`) | 2 red exactly as predicted, 11 green | discriminating |
| M-19 | §3.12.4 | base | change the namespace constant's last hex digit | exactly 1 red (the golden value), 184 green | discriminating |
| M-20 | §3.13.3 | base | move the #5′ hook past step ⑥ | exactly 1 red (R2 only), 60 green | discriminating |
| M-21 | §3.14.4 | base | delete the C-3 outcome write + its `rowCount` guard together | 4 red (I3 + the three other round-outcome assertions), 11 green | discriminating |
| M-22 | §3.15.8 | base | populate `ipAddress`/`userAgent` instead of `null` | 1 red / 15 green | discriminating |
| M-23 | §3.16.4 | base | seal payload replaced with a fixed stub | 1 red / 16 green | discriminating |
| M-24 | §3.16.4 | base | `unrecoverableExpired` counter zeroed, branch kept | 1 red / 16 green | discriminating |
| M-25 | §3.18.5 | u3 branch, pre-merge (`origin/…-u3@5af6e348f`) | fold the expired branch into plain success | 1 red / 16 green | discriminating |
| M-26 | §3.18.5 | u3 branch, pre-merge | fold the whole classifier into one bucket | 2 red (both cases) / 15 green | discriminating |
| M-27 | §3.18.5 | u3 branch, pre-merge | delete the durable audit-row write | 1 red / 16 green | discriminating |
| M-29 | §3.19.3 | ⚠️ u2 branch, pre-merge (`origin/…-u2@028c57fbc`) — **not re-run against the merged/current file** | delete `'approve'` from the allow-set | isolated: 1 failed/17 skipped; full u2-branch file (pre-merge, 18 tests): 12 failed/6 passed | discriminating (membership-level red, not consequence-level) |
| M-30 | §3.20.4 | ⚠️ u2 branch, pre-merge — **not re-run against the merged/current file** | delete the C-2 success write + its `rowCount` guard together (same shape as M-21) | isolated: 1 failed/18 skipped, red at its own `create` line; full u2-branch file (pre-merge, 19 tests): 5 failed/14 passed | discriminating |
| M-31 | §3.22.5 | u2 branch, pre-merge | delete the whole `sealAttendanceResultOperationV1` call | 3 failed/16 passed — **confounded**, triggers a different rule first; **discarded**, superseded by M-32 | non-discriminating for its own claim (disclosed, superseded) |
| M-32 | §3.22.5 | u2 branch, pre-merge | isolated replacement of M-31: `resolvedRequestId → null` only | exactly 1 red (`sealA` half only), 18 green (19) | discriminating |
| M-33 | §3.10.5 (renumbered from `M-11`, §0 R-11) | base | restore the PRE-FIX `executeRequestCancel` and re-run Q-G | LEG 3 red, LEGs 1/2/4 green (1 failed/3 passed/23 skipped) | discriminating |
| M-34 | §3.10.5 (renumbered from `M-12`, §0 R-11) | base | Q-G LEG 2 pointed at an unrelated `(request, instance)` pair | LEG 2 red, no contention (1 failed/26 skipped) | discriminating (also caught a vacuous JS-side assertion before shipping, §3.10.5) |

**Caveat this table exists to make impossible to miss**: M-29–M-32's counts are exactly what u2
measured on its OWN pre-merge branch. Nothing on this branch has re-run those four mutations against
the post-merge / current file — the merge record and this 定稿 pass's own rerun above both confirm the
FINAL file's plain (unperturbed) suite is still green (19/19), which is necessary but not sufficient
evidence that the same four mutations would still redden the same way after the merge's renumbering
and the two other lanes' insertions. Nothing in the merge (§0's own resolution notes) touched the
production code paths those four mutations target, so there is no known reason to expect a different
result — but "no known reason to expect otherwise" is not the same claim as "measured," and this row
is why the distinction is not swept into a single "34/34 green" headline.

---

## 接线 / 哨兵 / s6a / `ci-realdb-step-contract` 证据(2026-09-18 定稿复核)

`git diff --stat 1c98ff937..HEAD` (the merge commit through the current tip) touches only the two
docs files this 定稿 pass is editing — so every command below runs against byte-identical source to
what the merge record already measured; re-run here rather than merely cited, for the record:

```
$ git diff --stat 1c98ff937..HEAD
 …approval-cancel-round-phase2-design-20260918.md       | 137 +++++++-----
 …approval-cancel-round-phase2-verification-20260918.md | 241 +++++++++++++++++++++
 2 files changed, 325 insertions(+), 53 deletions(-)
```

**Four independent populations, all still 7** (no new `.db.test.ts` landed on this branch since the
merge, so none of these needed an edit for this slice):

```
$ ls packages/core-backend/tests/integration/approval-cancel-round-*.db.test.ts | wc -l
7
$ grep -c "approval-cancel-round-.*\.db\.test\.ts" packages/core-backend/vitest.config.ts
7
$ sed -n '/CANCEL_ROUND_REALDB_FILES = \[/,/\]/p' packages/core-backend/tests/unit/approval-cancel-round-ci-wiring.test.ts \
    | grep -c "\.db\.test\.ts"
7
$ grep -c "tests/integration/approval-cancel-round-.*\.db\.test\.ts \\\\" .github/workflows/plugin-tests.yml
7
```

**`ci-realdb-step-contract.mjs` carries no `FILES` list of its own** (§3.17.3 already established
this; re-confirmed, unchanged):

```
$ grep -n "FILES" scripts/ops/ci-realdb-step-contract.mjs | wc -l
0
```

**s6a provenance pin — the workflow file's own bytes, re-hashed**:

```
$ shasum -a 256 .github/workflows/plugin-tests.yml
b048a17f3ef9687073587fc9fe6486377f5a5f9d11abad1119b9e4e788d7b0c0
$ grep pluginTestsWorkflow plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json
    "pluginTestsWorkflow": "b048a17f3ef9687073587fc9fe6486377f5a5f9d11abad1119b9e4e788d7b0c0"
$ node plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs
sealed-export-package-provenance.test.cjs OK
```

Hash equal, guard OK — no re-pin owed (this slice changed zero `.yml` bytes since `a02930896`).

**DML table-classification census — the migration this slice added is already claimed by name,
not by symbol** (checklist item 14; `finding_p26_census_nearest_symbol_collision.md`'s trap named and
avoided in the census's own comment):

```
$ grep -n "zzzz20260918110000_add_attendance_requests_approval_workflow_key" \
    scripts/attendance/w4c0-dml-inventory/curated-debt-entries.cjs
699:      'packages/core-backend/src/db/migrations/zzzz20260918110000_add_attendance_requests_approval_workflow_key.ts',
$ (packages/core-backend) npx vitest run tests/unit/attendance-w7-1a-inertness-sweep.test.ts --reporter=dot
 ✓ tests/unit/attendance-w7-1a-inertness-sweep.test.ts (20 tests)
 Test Files  1 passed (1)
      Tests  20 passed (20)
```

**W7-R10 directory-root membership, checked by ROOT, not by basename grep** (checklist item 13's own
warning: a basename grep against `w7-w6r5-guard-root-set.ts` returns 0 by construction, since the
file holds directory globs, not filenames — that 0 is not evidence of anything):

The three roots are `plugins/plugin-attendance/**`, `packages/core-backend/src/attendance/**`, and
`packages/core-backend/src/attendance/w7-resolver/**`. This slice's own files, sorted by root
membership rather than grepped by name:

| File this slice touched or added | Falls under a W7-R10 root? | Which |
|---|---|---|
| `plugins/plugin-attendance/index.cjs` (modified) | yes | root 1 |
| `packages/core-backend/src/attendance/w4c3b-central-approval-hooks.ts` (modified) | yes | root 2 |
| `packages/core-backend/src/attendance/w4c3b-request-operation-boundary.ts` (modified) | yes | root 2 |
| `packages/core-backend/src/core/attendance-cancellation-execution-port.ts` (**new file**) | **no** | lives under `src/core/`, a plugin-agnostic host location — deliberately, per §5's own seam note ("modelled line-for-line on the existing `workday-calendar-port.ts` host↔plugin pattern"), not under any attendance-specific root |
| `packages/core-backend/src/services/ApprovalProductService.ts` (modified) | no | not an attendance-domain file; approval-side dispatch |
| `packages/core-backend/src/services/approval-bridge-types.ts` (modified) | no | approval-side types |

No file this slice added falls into the guard's blind spot: the two attendance-domain edits are
correctly IN the walked domain by directory (not verified by grepping their basenames against the
root list, which would have told a reader nothing), and the one wholly new file is correctly OUTSIDE
the attendance roots because it is not attendance-domain logic — it is a generic core-side port,
same shape as the existing `workday-calendar-port.ts` precedent, which also lives outside these roots.
This census is about a currently-inert FUTURE guard (the file's own header: "the future, W7-1 guard");
nothing here is live-blocking today, and nothing this slice did widens or narrows that guard's future
domain.

---

## 实现列车补充门审清单 — 逐条核(2026-09-18 定稿;`impl-supplementary-gate-checklist-20260918.md` 全 17 条)

| # | 条款(节选) | 适用? | 核verdict | 证据 |
|---|---|---|---|---|
| 1 | `t2-source-freeze-ci-wiring.test.mjs` 闭世界;新 `.db.test.ts` 必须逐个进 45 个同族 `*-ci-wiring` 的硬编码数组 | 适用(共用) | **N/A for this slice — no new `.db.test.ts` file.** u2/u3 both extended the EXISTING `approval-cancel-round-redemption.db.test.ts`; the file population stayed at 7 in all four independent counts above. Nothing to add to any `*-ci-wiring` array. | 见上「接线证据」四计数 |
| 2 | 在地惯例「NOT plugin-tests.yml」与锁 §6 的裁定相反,PR body 要写覆盖理由并重算 s6a | 适用(共用) | **CLOSED, pre-existing.** Phase-1's own PR (#5851) already carries this override and its s6a recount; this slice adds no new file to `plugin-tests.yml`, so the override is inherited, not re-decided. | phase-1 verification MD;s6a 哈希本节已重核,未变 |
| 3 | 改 `plugin-tests.yml` 的 s6a 重钉需安静窗口 | 适用(共用) | **N/A — this slice changed zero bytes of `plugin-tests.yml`.** Byte-identical hash confirmed twice (merge record, this 定稿 pass). | 本节「s6a provenance pin」 |
| 4 | 错误码不得降级成裸 HTTP 状态 | 适用(共用) | **PASS.** Every new code this slice throws (`CANCEL_ROUND_WINDOW_ANCHOR_MISSING`, `CANCEL_ROUND_ROLLOUT_LOCK_SCOPE_CHANGED`, `CANCEL_ROUND_DISPATCH_CONTENDED`, `CANCEL_ROUND_EXECUTION_PORT_UNAVAILABLE`, `CANCEL_ROUND_BUSINESS_TARGET_MISSING`) goes through `ServiceError` with a named code — design MD §3.2's table traces each to its throw site. | 设计 MD §3.2;`handleApprovalsError` 判别式未改 |
| 5 | J 行「未知 `section=` 令牌」/ C 行「`?category=` 与 `section` 同现」的分期勘误 | lane A only | **N/A — lane A(分组),非本切片。** | — |
| 6 | 「1 落地」= 门审通过 vs 已合并 的求值 | lane A only | **N/A — lane A。** | — |
| 7 | 前端 spec 位置基线 746/746 | lane A only | **N/A — lane A;本切片零前端改动。** | — |
| 8 | 独立 vitest project 的 gate 必须断言 `NODE_ENV` | lane B only | **N/A — lane B(待办中心)。** | — |
| 9 | `MIGRATION_EXCLUDE` 显式复制 / 触发集含所用 helper | lane B only | **N/A — lane B;本切片未新增独立 vitest project。** | — |
| 10 | `validate-migration-exclude.sh` 是 WARN-ONLY,不能当门 | lane B only | **N/A — lane B。** | — |
| 11 | 判据 E(代数守卫)属前端切片 2 | lane B only | **N/A — lane B。** | — |
| 12 | A0 前两行复用现有 API 测试 | lane B only | **N/A — lane B。** | — |
| 13 | W7-R10 是目录 root 清单,不是文件清单;新文件按 root 归属判断,不能按基名 grep | lane C(本切片) | **CLOSED, measured this pass — see the dedicated table above.** Two attendance-domain edits correctly inside the walked domain by root; the one new file correctly outside it (generic core-side port, not attendance logic). | 本节「W7-R10 directory-root membership」 |
| 14 | 考勤四道普查钉(s6a hash / W7-R10 分类 / CI corpus / DML table-classification) | lane C(本切片) | **CLOSED, measured this pass.** s6a: hash equal, guard OK. W7-R10: see #13. CI corpus: the seven-file population is unchanged (no new corpus entry owed). DML table-classification: the new migration is already claimed BY RELPATH in `curated-debt-entries.cjs` (entry `X08`, avoiding the nearest-symbol trap by construction), and the classification test (`attendance-w7-1a-inertness-sweep.test.ts`) is green (20/20) on this tree. | 本节「DML table-classification census」;`curated-debt-entries.cjs:658-699` |
| 15 | FE 同步钉:既有 spec 是手抄字面量数组,按锁 §14.3 #12 应改成 `readFileSync` 源码钉 | lane C(本切片) | **UNCHANGED, not touched by this slice — and correctly so.** `apps/web/tests/approvalBatchTransferView.spec.ts:284-298`'s transcribed-array pattern is a phase-1 finding, not something this slice's own scope (backend-only: no `apps/web` file appears in `git diff --stat feat/approval-cancel-round-phase1..HEAD`). §3.18.7b's blast-radius check (the two new tokens `cancellationOutcome`/`unrecoverableExpired`, `grep -rn` over `apps/web/src` → 0 hits) is the relevant input for THIS slice and is already measured: **zero FE surface renders either new token**, so there is nothing for a transcribed-array spec to have drifted against. Item 15's own fix (spec → `readFileSync`) remains open, owed to whichever slice next touches that spec, not manufactured here as a false "done." | §3.18.4/§3.18.7b;`git diff --stat feat/approval-cancel-round-phase1..HEAD` has no `apps/web/**` entries |
| 16 | 锁 §5 I6「撤销不限次」要有一行验收 | lane C(本切片) | **CLOSED, pre-existing on this branch.** The redemption suite's own first case (`"chain (§5 I6, 撤销不限次): revoke terminates round 1 …"`) drives revoke→new round→reject→new round in sequence on one document, asserting no count-based refusal. | `approval-cancel-round-redemption.db.test.ts`, case name above, green in every rerun this document records |
| 17 | §14.1 CJS 镜像常量 / §14.3 legacy-catch-500 mutation / §2-G2 时间锚,任务书零映射 | lane C(跨 C-1/C-2) | **CLOSED, split across both phases — not invented as one slice's work.** CJS mirror constant: closed in **phase 1** (`approval-cancel-round-plugin-mirror-constant.test.ts`, 9 cases, phase-1 verification MD line 444). legacy-catch-500 mutation: closed and re-verified live in **phase 1** (its §A3 Mutation 1). §2-G2 time anchor: phase-1's own answer was N/A for the AMEND-round field it was checking (out of scope for phase 1's schema); **this slice (§3.2) builds the DIFFERENT, in-scope §2-G2 anchor for the CANCEL round's own window** — `MIN(created_at)` of the document's `to_status='approved'` audit rows — and titles that section "(the checklist's item 17)" itself. All three sub-clauses are now accounted for; none was silently dropped between phases. | phase-1 verification MD:444;this file §3.2 |

---

## Owner 待裁项 + 「留给 C-3」的项(2026-09-18 定稿汇总;不裁决,只如实列)

The computed task asked for "C-1 三项" among the owner-pending items. **That count does not bind**:
enumerating every item actually open below (from design MD §7/§8 and this file's own §4) gives more
than three, and forcing a triple would mean either inventing a false grouping or silently dropping a
real item to make the arithmetic work. Each row below is tagged by which contract it traces to.

| 项 | 溯源 | 现状(不裁决) |
|---|---|---|
| `unrecoverableExpired` 的用户面呈现:三 token 默认值(`cancelled` / `cancelled_with_unrecoverable_expired` / `cancelled_reversal_unreported`),`getApproval` 不投影该字段 | **新增于 C-2**(u3, §3.18) | 持久化半边已闭合并测量(§3.16,值 120);呈现半边是实现者按默认值关的,不是 owner 已批的形状;无 FE 面渲染(0 命中) |
| `attendance-parity.db.test.ts` 退役,四来源溯源(锁 0 次点名 / phase-1 design MD 4 次 / phase-1 verification MD 8 次 / PR #5851 body 1 次) | **跨 C-1/C-2**(C-1 命名的伪影,C-2 的 §3.17 把普查扩到四源) | 结论未变:无 owner-ratified 来源点名此文件名;无引用可复原(从未存在于任何 ref) |
| C-1 审计行(`revoke`)的 acting identity —— 本轮次的请求人 vs 审批人 vs 系统哨兵,锁未点名 | **C-1 遗留,C-2 的账侧比对依赖此裁决**(§3.11.4) | 账侧比对(§3.15)是**条件性**的:owner 若裁定审计行应携带审批人或系统哨兵而非请求人,该用例按设计变红,不是要悄悄放宽排除表来消红 |
| 账侧 provenance 背离:`approval_records.ip_address`/`user_agent` 兑现路径为 `null`、W4 HTTP 路径有值 | **新增于 C-2**(§3.15.5) | 是否算「逐字节等价」满足(诚实缺席)或需要合成 provenance 标记,owner 未裁;本分支零依赖 |
| rollout-lock 预读的 org 来源:采用 `classifyAndLockAttendanceRequestForInstance` 而非 `filterBulkReassignDiscoveryForAttendance`(两者在 Q-E leg 3 上分歧,被拒的谓词承认了被采纳的谓词拒绝的 org) | **新增于 C-2**(§4.2,verification §3.3c) | 按 `feedback_second_narrower_artifact_is_contract_narrowing.md` 的方向标为合同形状选择,非例行复用决定;本分支零依赖另一谓词 |
| §8 期 1 R1 计数(现 9 处)是否要把新增的 #5′ 出口锚点算进去,变成 10 | **新增于 C-2**(design MD §7.1) | #5′ 是判据 IV 的出口锚点,不是拦截点守卫,按构造不带 `CANCEL_ROUND_OUTLET_FORBIDDEN` 负控;是否要登记为第 10 处,owner 未裁 |
| `CANCEL_ROUND_WINDOW_ANCHOR_MISSING` 的「拒绝裁决」设计选择 | **新增于 C-2**(§3.2) | 锁点名了锚点本身,没点名锚点缺失时的处置;本分支選擇 409 回滚而非直接判 `expired`,已标记待登记 |

**「留给 C-3」——如实说:没有独立的 C-3 切片。** 目标文档(`goal-three-locks-full-implementation-
20260918.md:9`)的切片清单在「线 C 撤销」下只列 C-1 合同层与 C-2 兑现与收口两项;锁文自己的三合同命名
(C-1/C-2/C-3)里,**C-3(轮次终结契约)已经由本切片的判据 IV 工作整体交付**(design MD §7 的原话)。
下面是 C-3 契约交付后仍然打开的真实残留项,不是伪造出来凑「留给下一切片」这句话:

| 残留项 | 状态 |
|---|---|
| 卡片失效(C-3 row 3 第三列,已挂起的取消轮的卡片) | 可能存在,pre-existing,未扫(§3.8) |
| R1 计数是否纳入 #5′ | 见上表,owner 待裁 |
| §5 I3 的两个终态写入方 | **两个都已探测**(§3.14 + §3.20),不是残留 |
| FE / 通知面:C-3「卡片失效、端点返回一致」列 | 完全未动(§4 最后一条) |
| 决策适配器(非取消适配器)的同一死锁形状 | 仍活跃,故意留给考勤线(§1.1,§0 R-3) |
| `filterBulkReassignDiscoveryForAttendance` 的非确定性 org 解析 | 考勤线发现,本分支零依赖(§3.3d) |
| lock:227 未排级的两个关系(`attendance_schedule_dispatch_requests`、`attendance_request_calculation_snapshots`) | owner 登记项,未擅自排序(§3.10.1) |
| 账侧比对的 non-legacy(authoritative/shadow)双胞胎 | 需要 rollout-registry 夹具工作,本分支未做(§3.15.11) |

---

## 设计 MD 逐 file:line 复核(2026-09-18 定稿;方法与结果表见设计 MD 自己的新增小节)

This 定稿 pass re-checked every `file:line` citation in the companion design document
(`approval-cancel-round-phase2-design-20260918.md`) against the current tree, because that document's
own header states its citations were checked against `a02930896` — a commit BEFORE the u1→u3→u2
merge, and the merge's own diff stat shows `ApprovalProductService.ts` changed by 41 net lines. Full
methodology, the corrected numbers, and which files were confirmed UNCHANGED live in the design MD's
own new §10 (added by this pass) — not duplicated here to avoid two documents disagreeing on which
one is authoritative for a design-side citation.
