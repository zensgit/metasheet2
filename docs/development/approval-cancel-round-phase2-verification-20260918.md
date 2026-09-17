# Cancel round — phase 2 (C-2 兑现与收口) verification

Branch `feat/approval-cancel-round-phase2`, stacked on `feat/approval-cancel-round-phase1`.
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

### 3.3 ⚠️ Open blocker for 判据 II: the rollout advisory lock cannot be ordered at this hook

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

### 3.4 Acceptance — where it lives, and why not in a new file

Appended to the already-wired `tests/integration/approval-cancel-round-redemption.db.test.ts`
(6 → 8 cases) rather than a new `.db.test.ts`. A new file would owe: the `plugin-tests.yml`
workflow list, the **hard-coded `FILES` array** in `scripts/ops/ci-realdb-step-contract.mjs:99-102`
(a closed world that stays green for a file it does not list — supplementary checklist item 1), and
an s6a provenance re-pin (items 3 / 14). None of that buys coverage this fixture already gives.
**Zero new files and zero workflow edits in this commit**, so the four attendance census pins and
the s6a pin are untouched:

```
$ git show --name-only --format= <this commit>
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

Every probe: `cp` backup → edit → run → `cp` restore → `cmp` (all three restores verified identical
— `RESTORED-IDENTICAL` printed each time).

| # | Mutation | Expected | Observed |
|---|---|---|---|
| M-5 | **the lock's own 判据 IV negative control** — delete the closure branch's early `return` (`return closedApproval` → `void closedApproval`), keeping every write | the status is overwritten back to `approved` **and** a completion event appears ⇒ the 判据 IV case red, nothing else | **exactly 1 red**, and on the named symptom: `AssertionError: expected [ 'approval.approved' ] to deeply equal []`; 7 green |
| M-6 | delete `deactivateAllActiveAssignments` from the closure | the seat assertion red | **GREEN — the mutation is INEFFECTIVE.** See below; the assertion is reclassified, not kept as if it had passed a probe |
| M-7 | round write `outcome = evaluation.decision` → hard-coded `'rejected'` (collapse `expired` into 判据 III's outcome) | the round-outcome assertion red, and only it | **exactly 1 red**: `AssertionError: expected 'rejected' to be 'expired'`; 7 green |

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
| 最终评估:业务不可逆 | `blocked` | **NOT covered.** It is produced by C-1's `business_refused` return, so it lands with 判据 II. The writer (`closeCancelRoundSystemTerminalInTxn`) already takes it and is shared by both causes; nothing exercises it yet |
| 基础设施异常 | stays `pending` | **partially** — the two `CANCEL_ROUND_INVARIANT_VIOLATION` throws and `CANCEL_ROUND_WINDOW_ANCHOR_MISSING` take this path by construction (throw ⇒ the caller's transaction rolls back), and phase 1's `erratum` case asserts the rollback shape on the revoke branch; no case drives it through **#5′** |

---

## 4. What this slice has NOT proven yet

Updated from §3 of the previous revision. Listed so no reader takes the greens above for more than
they are.

- **判据 II** (C-2 兑现挂点) — **not implemented.** The `redeem` branch falls through to today's
  approve path, so a redeemed round's row is left `pending` after its engine instance reaches
  `approved` — an §5 I3 gap inherited from phase 1. It is **asserted as-is** in the paired open-
  window case, so the change is forced to be noticed when 判据 II flips it to `'applied'`, rather
  than being silently satisfied.
- **判据 II's prerequisite** — the rollout advisory lock ordering blocker in §3.3. Unresolved.
- **判据 IV's `blocked` half** and C-3 row 4 — see §3.7.
- **R2** (锁内最终评估失败 ⇒ 零业务取消、零 `approved` 完成事件、C-3 收口已持久化) and its named
  mutation (move the evaluation after the enqueue ⇒ must go red) — **not built.** M-5 is 判据 IV's
  own negative control and is NOT a substitute: it proves the `return` is load-bearing, not that a
  *business* evaluation failure leaves zero business cancellation behind (there is no business
  cancellation on this path yet).
- **The external refusal end-to-end** — unchanged from the previous revision: the savepoint's
  SQL-level semantics (§2.2) and the boundary's statement sequence (§2.4) are proven separately and
  have still not been run against each other, because no caller exists yet.
- **账侧完整取消结果逐字节等价 + `unrecoverableExpired` 呈现** (lock §8 期 1) — only the refusal
  branch's bytes are covered (§2.3); the success branch's full-cancellation result is not.
- **`attendance-parity.db.test.ts`** — not yet filled in. The redemption suite's 判据 IV half is now
  filled in (§3.4); its 判据 II half is not.
- **§5 I3 「终结即释放」 mutation** — the `expired` case asserts a new round can start immediately
  after the close, but the lock's named mutation (drop the `outcome` write ⇒ the next create is
  refused by the partial unique index with 23505/409) is not built. M-7 mutates the outcome's
  *value*, not its presence.
- **R1 for the new guard point** — #5′ is an outlet anchor, not a chokepoint guard, so it takes no
  `CANCEL_ROUND_OUTLET_FORBIDDEN` negative control; whether §8 期 1's R1 count (9 sites) should grow
  to include it is an owner registration question, raised with the #5′ registration itself.
- **FE / notification side** — C-3's 「卡片失效、端点返回一致」 column is untouched.
