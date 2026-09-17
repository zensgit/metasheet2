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

## 3. What this slice has NOT proven yet

Listed so no reader takes the greens above for more than they are.

- **判据 II** (C-2 兑现挂点) — not implemented. No hook exists at `ApprovalProductService` yet.
- **判据 IV** (C-3 system closure `expired`/`blocked`, §14.3 `#5′`) — not implemented.
- **R2** (锁内最终评估失败 ⇒ 零业务取消、零 approved 完成事件、C-3 收口已持久化), and its mutation
  (move the evaluation after the enqueue ⇒ must go red) — not built.
- **The external refusal end-to-end**: that a real refusal inside a real caller transaction leaves
  zero rows behind. Two halves are proven separately — the savepoint's SQL-level semantics are
  measured on PG 15.17 (§2.2), and the boundary's statement sequence is asserted in all three
  outcomes with positive controls (§2.4 M-2/M-4: refusal ⇒ SAVEPOINT→ROLLBACK TO→RELEASE, success
  ⇒ SAVEPOINT→RELEASE, exception ⇒ SAVEPOINT only). They have NOT been run against each other:
  no caller exists yet, and the three protocol call sites that can produce a refusal need a real
  database, so the wrapper is driven directly with a supplied outcome.
- **账侧完整取消结果逐字节等价 + `unrecoverableExpired` 呈现** (lock §8 期 1) — only the refusal
  branch's bytes are covered so far (§2.3); the success branch's full-cancellation result is not.
- **`attendance-parity.db.test.ts`** and the redemption suite's II/IV halves (phase 1 left them
  marked blocked-with-reason) — not yet filled in.
- **§5 I3 「终结即释放」** mutation, and R1 for any new guard point — not built.
