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

## 0. Corrections and retractions (retraction-first)

| # | Where the wrong claim is | The claim | Status |
|---|---|---|---|
| R-1 | commit `042d92e02` message, 2nd bullet | "typecheck then acts as the census over every `result.response` / `.lifecycleEvents` / `.resolvedRequestId` access **(13 sites, all narrowed)**" | **RETRACTED — the number is wrong.** I wrote 13 without counting. Mechanical count below: **7** sites for exactly those three properties. The substantive half (typecheck is clean, so every one of them is narrowed) stands; only the count was invented. The commit message cannot be edited without a force-push, so the correction lives here. |
| R-3 | commit `56d517127` message, 2nd paragraph, and §3.10.3's first draft | "that inversion is a cycle on the same (request, instance) pair today" … the reorder "closes" the live defect | **RETRACTED IN PART — the reorder closes it for the CANCEL path only.** My own census leg contradicts the word "closes": Q-G LEG 4 shows the DECISION adapter (`index.cjs:37596`/`:37617`) is also `attendance_requests → approval_instances` and is also gated on `requestRow.status === 'pending'` — exactly the population `bulkReassignApprovals` reaches `classifyAndLockAttendanceRequestForInstance` on with the instance row held. So the same cycle, same shape, is **still live** after this commit via the decision adapter. Leaving that adapter to the attendance line is the right scope call; calling the defect closed was not. The commit message cannot be edited without a force-push, so the correction lives here. |
| R-4 | `ApprovalProductService.redeemCancelRoundInTxn`'s own comment (commit `08b7cbec3`), and §4's 「it is CHEAP」 bullet | 「`operationId` … must be a UUID … The round row's own id **is exactly the right identity**」, and 「the end-to-end case … is a handful of lines」 | **BOTH RETRACTED — see §3.12.** The round id is `text`, minted `apr_${crypto.randomUUID()}`, so the boundary refused EVERY real redemption with `W4C3B_REQUEST_BOUNDARY_INPUT_INVALID` (500). Four double-backed acceptance cases were green over a code path that could not work. And the end-to-end case was not cheap: it took a production fix plus two fixture facts that no reading of the source would have produced. |
| R-2 | my own working notes for this step | "the `w7-w6r5-guard` classification test ran and passed" | **RETRACTED — it never ran.** A combined run of three targets printed `Test Files 2 passed (2)` and I inferred which two. Checked directly: `npx vitest run tests/unit/w7-w6r5-guard` prints **`No test files found, exiting with code 1`** — that path holds `classification.ts` and `walk.ts`, which are corpora, not suites. Their real consumers are named in §2.5 and were run there. A directory that collects zero files is not a green. |

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

The new unit cases were appended to a file already collected by the default vitest project; the
real-DB oracle is an existing file already wired into the attendance real-DB step at
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
workflow list, the **hard-coded `FILES` array** in `scripts/ops/ci-realdb-step-contract.mjs:99-102`
(a closed world that stays green for a file it does not list — supplementary checklist item 1), and
an s6a provenance re-pin (items 3 / 14). None of that buys coverage this fixture already gives.
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

| # | Mutation | Expected | Observed |
|---|---|---|---|
| M-11 | restore the PRE-FIX `executeRequestCancel` (the whole file, `cp` from the pre-edit backup) and re-run Q-G | LEG 3 red; LEGs 1/2/4 still green | **RED exactly as predicted**: `AssertionError: 原单据实例 must be locked BEFORE attendance_requests: expected 1563 to be less than 238`, `Tests 1 failed | 3 passed | 23 skipped (27)`. Restored with `cp` and `cmp` proved byte-identical (`RESTORED-IDENTICAL`). |

| M-12 | in LEG 2 only, point the adapter at a **different** seeded `(request, instance)` pair, so the two sides contend with nothing | LEG 2 red — a "no deadlock" leg that never contended has proved nothing | **RED**: `Error: backend 55248 never blocked on a lock within 5000ms — the two sides did not contend, so this leg proved nothing`, `Tests 1 failed | 26 skipped (27)`. Restored with `cp`, `cmp` identical, full file back to 27 passed. |

LEG 1's own discriminating power needs no separate mutation: it is a constructed race that produces
a real `40P01`, and LEG 2 is its paired negative — the same harness, the shipped order, no deadlock.

⚠️ **M-12 caught a vacuous assertion of mine before it shipped, and that is worth recording.** LEG 2's
first contention proof was a JS-side `settled` flag flipped in `adapterRun.then(...)` and asserted
still `false` before the core side committed. M-12 left it **green**: with the adapter pointed at an
unrelated pair it finished immediately, yet the flag was still `false`, because the `.then` callback
had not been scheduled by the time the assertion ran. A first mutation attempt was also invalid —
dropping the core side's instance lock did not remove contention, it only moved it to the request
row (memory: `feedback_ineffective_mutation_looks_like_a_useless_test.md`). The shipped version asks
**PostgreSQL** instead: `expectBackendBlockedOnLock` polls `pg_stat_activity.wait_event_type = 'Lock'`
for the adapter's own backend pid and throws on timeout, which is what M-12 now reddens.

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
`.db.test.ts` would need `plugin-tests.yml`, the `ci-realdb-step-contract.mjs` `FILES` array and an
s6a re-pin, for no coverage this fixture cannot give).

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

## 4. What this slice has NOT proven yet

Updated from §3 of the previous revision. Listed so no reader takes the greens above for more than
they are.

- **判据 II** (C-2 兑现挂点) — **IMPLEMENTED in §3.11**, with the C-1 port, the `blocked`
  hand-off and four acceptance cases. What is still NOT established about it: every one of those
  cases binds a TEST DOUBLE through the production registry, so they prove the approval side's half
  of the contract and nothing about the real W4 protocol (prepare/prepareIdentity, the isolation
  assert, the rollout-lock `pg_locks` assert, posture resolution, authorization, replay preflight,
  seal/outbox). The org-key match (§3.11.3) is argued from a query predicate, which is a
  construction argument, not a live run.
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
  mutation (move the evaluation after the enqueue ⇒ must go red) — **not built**, and it is the
  next unit. §3.12 makes it STRONGER as well as cheaper: over a double, 「零业务取消」 could only be
  `calls.length === 0`; with the real boundary bound and an attendance-backed fixture it becomes a
  row assertion (原单 still `approved`, `attendance_requests` still `approved`, zero `revoke`
  records) that a double cannot fake. M-5 is 判据 IV's
  own negative control and is NOT a substitute: it proves the `return` is load-bearing, not that a
  *business* evaluation failure leaves zero business cancellation behind (there is no business
  cancellation on this path yet).
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
- **账侧完整取消结果逐字节等价 + `unrecoverableExpired` 呈现** (lock §8 期 1) — STILL OPEN, and
  §3.12 narrows rather than closes it. That case establishes DB END-STATE parity for the success
  branch (原单 `cancelled` + its `revoke` audit row + `attendance_requests.status='cancelled'`);
  byte equivalence needs the HTTP `POST /api/attendance/requests/:id/cancel` path run on a TWIN
  fixture and a field-by-field compare of both results. `unrecoverableExpired` needs
  leave-balance lots, which no fixture here seeds.
- **`attendance-parity.db.test.ts`** — not yet filled in. The redemption suite's 判据 II and 判据 IV
  halves are both filled in now (§3.4, §3.11.6), against a double.
- **§5 I3 「终结即释放」 mutation** — the `expired` case asserts a new round can start immediately
  after the close, but the lock's named mutation (drop the `outcome` write ⇒ the next create is
  refused by the partial unique index with 23505/409) is not built. M-7 mutates the outcome's
  *value*, not its presence.
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
