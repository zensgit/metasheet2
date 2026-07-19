# Stock-preparation P4 closeout — design and verification record (2026-07-19)

> **Status: LOCAL CLOSEOUT RECORD (implementation worktree).** This document freezes the
> consolidated A+C implementation after rebase onto current `origin/main`, records exact pre-rebase
> PR heads, rebased head, verification commands, and honest residual boundaries.
>
> Design authority remains
> `docs/development/stock-preparation-p4-persist-atomicity-design-lock-20260717.md` (RATIFIED
> 2026-07-19: Option A host unit-of-work + bounded one-shot Option C).
>
> This closeout does **not** authorize production always-on autopersist. Entity-machine preserved
> capture diagnostics (issue 4437, flag OFF) stay operational and out of scope for runtime change.
> `externalWrite` remains false. Snapshot batch/line/run rows remain immutable. Repair remains
> one-shot, owner-operated, and retirement-bound.

## 1. Scope and non-scope

### In scope (this closeout)

1. Rebase the stacked A+C commits onto current `origin/main` and resolve hot-main CI wiring conflicts.
2. Design-lock conformance review of the resulting tree (transaction closure, lock order/scope,
   rollback, replay, writer-block checks, latest-history proof, repair allowlist, audit vocabulary,
   CLI stdout/stderr contract, migration 067, CI two-point wiring).
3. Implement only verified missing functionality or correctness fixes (none required after review).
4. Focused unit/plugin/type-check/CI-wiring runs, plus real-PostgreSQL A/C suites when local DB exists.
5. This verification record and conventional commits on the local worktree branch only.

### Explicit non-scope

| Item | Posture |
|---|---|
| Production always-on T3b autopersist authorization | Still barred by OD-4 until independent owner acceptance; A/C completion is necessary but not that authorization. |
| Entity-machine issue 4437 preserved-capture package / exact SHA | Untouched. Flag remains OFF. Not a reason to change runtime code. |
| Release artifacts, RC packaging, smoke golden SHA pins outside A/C surface | Untouched. |
| Push, merge, auto-merge arming, PR retarget on remotes | Out of this worker's authority. Local branch only. |
| T3a ERP material-sync atomicity | Separate adjudication (design lock §10 decision 5). Module still non-UOW. |
| Auto-delete / auto-dedupe / rewrite of immutable snapshots | Forbidden forever under C bounds. |
| Mounting repair as an HTTP route or always-on admin surface | Forbidden; CLI/operator path only. |
| External write / K3 / PLM write paths | `externalWrite=false` preserved end-to-end. |

## 2. Option A — atomic unit-of-work design (as landed)

### Shape

Host-owned, stock-preparation-specific unit-of-work (not a generic bulk-create API):

- API: `MultitableRecordsAPI.runStockPreparationPersistUnitOfWork(input, operation)`
- Input: `tenantId`, exactly four distinct `sheetIds`, `project.{sheetId,projectId}`,
  `batch.{sheetId,snapshotBatchId}`
- Host (`packages/core-backend/src/index.ts`) opens **one** `poolManager.get().transaction`
- Inside that transaction the host:
  1. Asserts plugin ownership of every declared sheet
  2. Acquires locks via `acquireStockPreparationPersistUnitOfWorkLocks`
  3. Invokes the plugin callback with a transaction-scoped records API limited to
     `queryRecords` / `createRecord` / `patchRecord` (all bound to the same `txQuery`)
- Plugin scope (`plugin-scope.ts`) re-asserts the declared four-sheet allowlist on every call and
  fails closed when the host hook is missing (`MultitableUnitOfWorkUnavailableError`)

### Lock order and scope (fixed)

1. Canonical sheet fences via `acquireCanonicalSheetFencesInOrder` (dedupe + **sheet-id sort** —
   same discipline as W0 multi-sheet writers)
2. When `MULTITABLE_ENABLE_WRITER_FENCE` is ON: `assertNoActiveWriterBlock` per ordered sheet
   **before** key locks (recovery writer-block honor)
3. Project key: `pg_advisory_xact_lock(STOCK_PREPARATION_PROJECT_LOCK_NS, hashtext(key))`
   with `key = JSON.stringify([tenantId, projectSheetId, projectId])`
4. Batch key: `pg_advisory_xact_lock(STOCK_PREPARATION_BATCH_LOCK_NS, hashtext(key))`
   with `key = JSON.stringify([tenantId, batchSheetId, snapshotBatchId])`

Namespaces (`0x73700101` project, `0x73700102` batch) are fixed, disjoint from each other and from
the one-argument canonical sheet fence space. Callers never choose lock order.

### Transaction closure (what is inside the single COMMIT)

For `persistStockPreparationSyncRun` hard cut:

1. Batch existence recheck (limit 2)
2. Project existence/uniqueness recheck
3. Exact-replay decision (skip / 409 / create) — **inside** locks
4. H-2 monotonic version history scan on create path
5. Batch create → line creates → run create → project create-or-patch (closed three-key pointer patch)
6. Per-create/patch revision emission (records path uses the injected `txQuery`, so revisions roll
   back with the UOW)

Any failure rolls the entire UOW back → zero residual batch/line/run/project rows and zero residual
revisions for that attempt (proven by real-DB crash matrix).

### Hard cut (no dual path)

`ensurePersistUnitOfWork` rejects hosts without `runStockPreparationPersistUnitOfWork` with 503
`PERSIST_UNIT_OF_WORK_UNAVAILABLE` **before** provisioning I/O or writes. There is no sequential
per-record fallback.

Production callers both pass `lockTenantId` from the authenticated tenant
(`http-routes.cjs` persist route and T3b source-run bridge). `lockTenantId` is never request-body
sourced.

### Replay / immutability posture (unchanged doctrine)

- Snapshot batch/line/run: create-only; never patched by persist
- Exact replay (`assertExactReplay`) remains the skip gate, including H-2 stale pointer / advanced
  history refusal
- Project row remains the only live pointer (lastSyncRunId / lastSyncedAt / projectStatus)

## 3. Option C — bounded one-shot repair design (as landed)

### Shape

- Module: `plugins/plugin-integration-core/lib/stock-preparation-sync-run-repair-once.cjs`
- **Not** mounted as HTTP
- Operator CLI: `pnpm ops:stock-prep-persist-repair-once` →
  `packages/core-backend/scripts/stock-preparation-persist-repair-once.ts`
- Default **dry-run**; apply requires `--apply` **and** exact typed confirmation
  `APPLY_STOCK_PREPARATION_REPAIR_ONCE`
- Reuses the same host UOW (repair writes share A’s lock order and single COMMIT)
- Manifest cannot inject `apply`, `permission`, `recordsApi`, `provisioning`, `auditStore`,
  `lockTenantId`, or `targetProjectId` (forbidden-key refuse)

### Allowlist of repair actions

Only:

1. Append proven missing **line suffix** (contiguous prefix of plan line keys present and matching)
2. Create missing **run** (only when line set is complete; non-suffix gaps refuse)
3. Create missing **project** row, or **patch** project pointer when pointer version is strictly
   older than the repaired batch and the repaired batch is the unique latest history tip

Refuse (409 `PERSIST_REPAIR_REFUSED`, values-free `{target, reason}`) for: missing batch prefix,
ambiguous keys, content mismatch, unexpected line keys, non-suffix gaps, pointer without run,
unresolvable/ambiguous pointer, unprovable/advanced/ambiguous history. Never delete, dedupe, or
rewrite immutable snapshot rows. Advanced pointers are preserved, not pulled backward.

### Audit vocabulary

Migration `067_extend_stock_prep_audit_repair_action.sql` extends
`integration_stock_prep_audit_action_check` with `persist_repair_once` (ninth action). Runtime
allowlist in `stock-preparation-audit-store.cjs` matches. Audit rows are values-free (mode, counts,
refusal codes/targets/reasons only). Apply path writes an `apply_requested` intent row before the
UOW and a completion/refusal row after. Dry-run writes a single outcome row and zero snapshot writes.

### CLI stdout / stderr contract

- **Stdout**: exactly one JSON line; closed PASS/FAIL shape; `externalWrite: false`; `valuesFree: true`
- **Stderr**: diagnostic channel only; fixed marker
  `STOCK_PREPARATION_REPAIR_ONCE_STDERR_DIAGNOSTICS_ENABLED`; not part of the values-free result
  and must not leave the controlled host
- Failure codes are closed-set mapped; unknown errors collapse to `REPAIR_FAILED`

### Retirement posture

Runbook requires: dry-run → owner approval → apply → post dry-run `repairable:false` → secure
manifest delete → follow-up PR removes the root package command and executable module. Migrations
066/067 and append-only audit rows remain as history. Tool is not a permanent repair surface.

## 4. Invariants (cross-cutting)

| Invariant | Evidence surface |
|---|---|
| `externalWrite=false` | Repair result evidence, CLI summary/failure, module header, no external adapter calls |
| Values-free public outputs | CLI closed shapes; audit detail builders; refusal codes without identities/business values |
| Snapshot immutability | Persist create-only for batch/line/run; repair append/pointer-only |
| One-shot repair boundary | No HTTP route; default dry-run; typed apply confirmation; retirement runbook |
| No production always-on authorization | Design lock §10 / this closeout; T3b flag remains independent |
| Writer-block honor | UOW acquires `assertNoActiveWriterBlock` when fence flag ON before key locks |
| Latest-history proof on repair | `readProjectBatchVersionSummary` + unique latest batch id check before create/patch project |

## 5. Error and audit contracts (closed vocabulary highlights)

**Persist (A path, existing + UOW):**
`PERSIST_UNIT_OF_WORK_UNAVAILABLE`, `PERSIST_PLAN_TOO_LARGE`, idempotency/incomplete/read-unprovable
family, `PERSIST_PROJECT_POINTER_STALE`, `PERSIST_VERSION_NOT_MONOTONIC`, permission/provisioning
gates — all values-free details.

**Repair (C path):**
`PERSIST_REPAIR_REFUSED` + closed `{target, reason}`;
`PERSIST_REPAIR_CONFIG_INVALID`; `PERSIST_REPAIR_AUDIT_UNAVAILABLE`; CLI argument/manifest codes
(`REPAIR_ARGUMENT_INVALID`, `REPAIR_CONFIRMATION_INVALID`, `REPAIR_MANIFEST_FORBIDDEN_KEY`, …).

**Audit action:** `persist_repair_once` only (migration CHECK + store allowlist).

## 6. Migration / rollback / retirement

| Artifact | Role |
|---|---|
| `066_create_integration_stock_prep_audit.sql` | Base audit table (already on main lineage) |
| `067_extend_stock_prep_audit_repair_action.sql` | Additive CHECK expand for `persist_repair_once` |
| Rollback of 067 | Drop/recreate CHECK without the ninth action **only if** no rows use it; otherwise leave vocabulary and stop writing the action |
| A host API | Additive optional method; hard cut means undeploy of host without plugin rollback is a deliberate outage of persist (by design) |
| C retirement | Remove CLI script + package script + repair module after window; keep migrations + audit history |

Fresh migrate on a dedicated local database applied 067 successfully; live CHECK includes
`persist_repair_once`.

## 7. Exact heads and rebase record

| Ref | Full SHA |
|---|---|
| Pre-rebase PR #4470 Option A head | `4e725aa46556835f12d283ab76705943b125002b` |
| Pre-rebase PR #4473 Option C head | `333f297ce2ef0fb138b14e983d6908f91ea79620` |
| Old base = `merge-base(origin/main, #4470 head)` | `761bf3597f1cc25fbf0c77791f8132613ff46122` |
| Rebase onto (`origin/main` at closeout) | `622f095446a85e6c34a69170d6d08848cae890e1` |
| Independently reviewed integrated reference tip | `a5e5db3204054e949535d8ec43989a16191c827e` |
| Local Option A candidate head (5 rebased A + P2 scope fix) | `9a0aee721081e2cb346b8e14ed370bf677f0b791` |
| Local Option C tip before this verification document | `f03ff1637642420e3e7cfbaca05222b9d4ad813d` |
| Local Option C candidate branch tip (this verification document commit) | `git rev-parse HEAD` on `codex/stock-prep-p4-repair-once-20260719` (docs commit on `f03ff1637642420e3e7cfbaca05222b9d4ad813d`) |

### Replay (dual clean worktrees)

```text
# Option A worktree
git rebase --onto origin/main 761bf3597f1cc25fbf0c77791f8132613ff46122 HEAD
# then apply only P2 runtime/test from baf5ae95d (plugin-scope.ts + multitable-plugin-scope.test.ts)

# Option C worktree
git rebase --onto <local-A-head> 4e725aa46556835f12d283ab76705943b125002b HEAD
```

Five A commits replayed onto `origin/main` (no conflicts), then P2 scope-normalization committed on A.
Four C commits replayed onto the local A head (one conflict — see below).

### Conflict report (conservative resolution)

| Commit | File | Resolution |
|---|---|---|
| `0ee494262` → rebased local C first commit (`feat(stock-prep): add bounded one-shot persist repair`) | `.github/workflows/plugin-tests.yml` | **Kept all hot-main CI wiring contracts** introduced after the old base (B5-b / B5-b fail-close / B5-c / B6 / B7 / B7 round-2 / T1 / T2 / T2-Gate) **and** retained the P4 repair CI wiring step from Option C. Real-DB whole-file invocation of `tests/integration/stock-preparation-p4-repair-once-realdb.test.ts` auto-merged cleanly into the multitable real-DB step. Blank-line fidelity matched integrated reference `a5e5db320`. |

No other conflicts. No silent deletion of main or A/C wiring.

### Rebased commit map (old → local candidates)

| Pre-rebase | Local rebased | Subject |
|---|---|---|
| `504668c2c` | `b1b84981d` | fix(stock-prep): make snapshot persist atomic |
| `003d26691` | `401a935a9` | test(ops): classify multitable uow error codes |
| `f91ebaf94` | `59f542f05` | fix(stock-prep): harden persist lock inputs |
| `7f730c4c6` | `29015bec2` | test(multitable): classify atomic persist write seam |
| `4e725aa46` | `a928a58a6` | fix(stock-prep): honor recovery writer blocks |
| (post-review P2) | `9a0aee721` | fix(stock-prep): normalize UOW sheet allowlist in plugin scope |
| `0ee494262` | `b337bd6ec` | feat(stock-prep): add bounded one-shot persist repair |
| `53228d76b` | `a0ed98755` | fix(stock-prep): close repair failure vocabularies |
| `419ba0ee3` | `4dd9972fc` | fix(stock-prep): refuse stale repair pointers |
| `333f297ce` | `f03ff1637` | test(stock-prep): pin latest repair history |

Integrated-reference map (provenance only; same patch content for the nine A+C commits): `504668c2c→f78334591` … `333f297ce→a57b145c1`, plus `baf5ae95d` (P2) and `a5e5db320` (this document's prior integrated tip).

## 8. Design-lock review findings

Reviewed the full A+C tree against the ratified lock after rebase onto hot main. Surfaces checked:

- Transaction closure and hard cut
- Lock order (sheet fences → writer-block → project key → batch key)
- In-lock recheck / replay / create-or-patch
- Revision emission on shared `txQuery`
- H-2 / H-3 / writer-block
- Repair allowlist, history tip proof, advanced pointer preservation
- Audit migration + store allowlist parity
- CLI stdout single-line / stderr marker / forbidden manifest keys
- CI two-point wiring (vitest exclude + plugin-tests whole-file)
- Integration regressions from main (plugin API construction in `index.ts`, directory CI pins in
  `plugin-tests.yml` / `vitest.config.ts`)

**Initial closeout-worker result:** no worker-discovered runtime gap; only the verification document
was added in the first closeout commit.

### 8.1 Codex independent review — P2 scope-normalization gap (addressed)

Independent Codex review of the rebased worktree found a real P2 fail-closed gap:

- **Where:** `packages/core-backend/src/multitable/plugin-scope.ts`
  `runStockPreparationPersistUnitOfWork`
- **Bug:** the callback allowlist was built from **raw** `input.sheetIds` before host
  validation/trim. The host then ran `validateStockPreparationPersistUnitOfWorkInput` and owned/locked
  the **trimmed** sheet ids. A raw value such as `" sheet-A "` could therefore be allowed by the
  wrapper while the host locked `"sheet-A"`, breaking the declared-four-sheet boundary (and the
  dual: the trimmed id the host locked was not present in the raw allowlist).
- **Fix (smallest fail-closed correction):** plugin-scope now calls the **same**
  `validateStockPreparationPersistUnitOfWorkInput` used by the host, builds `allowedSheetIds` from
  `normalized.sheetIds`, and hands `{ ...normalized, pluginName }` to the host hook. No second
  parser.
- **Load-bearing unit test:** `multitable-plugin-scope.test.ts` — whitespace-normalized input;
  host receives trimmed shape; query/create/patch with the padded raw id throw
  `MultitableUnitOfWorkScopeError`. Mutation: allowlist from raw `input.sheetIds` makes the test
  red (trimmed declared id fails the raw set / padded variant would otherwise leak).
- **Codex re-review:** exact fix commit `baf5ae95d` was reviewed after landing in the worktree. The
  canonical validator, normalized host handoff, and callback allowlist now share one input object;
  no residual P1/P2 was found in this boundary. Codex independently killed the raw-allowlist mutant,
  restored the tree, and re-ran the focused and real-DB suites below.

## 9. Commands and results

Environment: dual local clean worktrees (Option A atomicity-uow; Option C repair-once stacked on
local A); PostgreSQL accepting connections on the local test host; dedicated migrated DB
`stock_prep_p4_closeout_20260719` (067 present, `persist_repair_once` in CHECK). Connection
coordinates stay local-operator facts and are not recorded here.

### Dual-worktree local verification (this closeout pass — executed, none skipped)

#### Option A worktree (`9a0aee721`)

| Command | Result |
|---|---|
| `pnpm exec vitest run` on `stock-preparation-persist-unit-of-work.test.ts`, `multitable-plugin-scope.test.ts`, `multitable-w13-write-path-layer3-gate.guard.test.ts` | **3 files / 18 passed / 0 failed / 0 skipped** (includes P2 whitespace-scope case) |
| `pnpm --filter @metasheet/core-backend type-check` | **passed** (`tsc --noEmit`) |
| `node __tests__/stock-preparation-sync-run-persist.test.cjs` | **44 passed / 0 failed** |
| `node --test scripts/ops/global-history-flag-manifest.test.mjs` | **24 passed / 0 failed / 0 skipped** |
| Real-DB `stock-preparation-t3b-replay-hardening-realdb.test.ts` (`DATABASE_URL` set, `METASHEET_REAL_DB_TEST_STEP=1`) | **1 file / 4 passed / 0 failed / 0 skipped** (exact replay; CW1–CW4 zero residual + clean retry; same-batch converge; project non-dupe) |

#### Option C worktree (pre-doc tip `f03ff1637`; final tip = this verification document commit on that tip)

| Command | Result |
|---|---|
| `pnpm exec vitest run` on UOW, plugin-scope, repair CLI, W1-3 write-path guard | **4 files / 22 passed / 0 failed / 0 skipped** |
| `pnpm --filter @metasheet/core-backend type-check` | **passed** (`tsc --noEmit`) |
| `node __tests__/stock-preparation-sync-run-persist.test.cjs` | **44 passed / 0 failed** |
| `node __tests__/stock-preparation-sync-run-repair-once.test.cjs` | **16 passed / 0 failed** |
| `node __tests__/stock-preparation-audit-store.test.cjs` | **5/5 passed** |
| `node __tests__/stock-preparation-audit-migration.test.cjs` | **passed** |
| `node __tests__/stock-preparation-erp-material-sync-persist.test.cjs` | **17 passed / 0 failed** |
| `node --test scripts/ops/stock-preparation-p4-repair-ci-wiring.test.mjs` | **2 passed / 0 failed / 0 skipped** |
| `node --test scripts/ops/global-history-flag-manifest.test.mjs` | **24 passed / 0 failed / 0 skipped** |
| Real-DB three-suite run (replay + repair + PLM autopersist) | **3 files / 13 passed / 0 failed / 0 skipped** |

Real-DB command used on C:

```bash
export DATABASE_URL='…'   # local dedicated migrated DB; coordinates not published here
export METASHEET_REAL_DB_TEST_STEP=1
pnpm exec vitest run --config vitest.integration.config.ts \
  tests/integration/stock-preparation-t3b-replay-hardening-realdb.test.ts \
  tests/integration/stock-preparation-p4-repair-once-realdb.test.ts \
  tests/integration/stock-preparation-t3b-plm-autopersist-realdb.test.ts
```

| Suite | Result |
|---|---|
| T3b replay hardening / A crash+concurrency | **4 passed** (exact replay; CW1–CW4 zero residual + clean retry; same-batch converge; project non-dupe) |
| P4 repair-once real-DB | **5 passed** (CW1–CW4-first repair+idempotent; CW4-existing pointer-only; mismatch refuse+audit; real CLI dry-run one-line values-free; templates present) |
| T3b PLM autopersist real-DB (regression on shared persist) | **4 passed** (flag ON persist+replay; flag OFF zero writes; lifecycle 422; forbidden fieldMap) |
| **C real-DB total** | **3 files / 13 tests passed**, 0 failed, 0 skipped |

### Prior integrated-reference verification (provenance; not re-claimed here)

The independently reviewed integrated branch `a5e5db320` previously recorded initial closeout,
post-P2, and Codex re-review passes with the same suite inventory (focused Vitest **4 files / 22**,
plugin CJS **60**, real-DB **3 files / 13**, type-check pass). Those results remain provenance for
the design/review trail; the dual-worktree numbers above are the authoritative local re-run for
this closeout packaging.

### Codex exact-candidate re-review

Codex independently reviewed the local A head `9a0aee721` and the C candidate at
`e54229533` before this note. The result is **APPROVE, 0 P1 / 0 P2**:

- A `range-diff` proves the five original Option A commits are patch-identical after rebase; the
  sixth commit is only the reviewed normalized-sheet allowlist fix.
- C `range-diff` proves all four Option C commits are patch-identical after rebase.
- `git diff a5e5db320..e54229533` is empty outside this verification document, so the runtime tree
  is byte-identical to the previously reviewed integrated reference.
- Codex re-ran A and C focused Vitest suites, both backend type-checks, persist/repair/audit/ERP CJS
  suites, CI wiring, and the manifest contract with the same green counts recorded above.
- Codex temporarily reverted `allowedSheetIds` to raw `input.sheetIds`; the exact whitespace-scope
  test reported **1 failed / 9 skipped**. Restoring the normalized input reported **1 passed / 9
  skipped**, and the A worktree returned clean.
- The first Codex real-DB invocation omitted the two required environment variables and reported
  **3 files / 13 skipped**. That run was explicitly rejected as skip-green evidence. The corrected
  command with explicit `DATABASE_URL` and `METASHEET_REAL_DB_TEST_STEP=1` then executed and passed
  **3 files / 13 tests**, 0 failed, 0 skipped.

**Honest statement:** dual-worktree real-DB suites ran with `DATABASE_URL` set and were not
skip-green. W6/T4 full postdeploy smokes and live multi-tenant staging were **not** re-run in these
worktrees.

## 10. Mutation / real-DB evidence already present in tests

| Gate (design lock §8) | Where proven |
|---|---|
| Crash-injection CW1/CW2/CW3/CW4-first/CW4-existing → zero residual + clean retry | `stock-preparation-t3b-replay-hardening-realdb.test.ts` (facade `injectCrashAfterMutation`) |
| Concurrent same-batch → one create + one exact replay | same suite (barrier inside UOW) |
| Concurrent different batches → single project row | same suite |
| Repair CW1–CW4-first → exact replay + second repair noop | `stock-preparation-p4-repair-once-realdb.test.ts` |
| Repair CW4-existing → pointer patch only; immutable rows preserved | same suite |
| Prefix mismatch refuse + audit, zero added rows | same suite |
| Real CLI dry-run one stdout line, stderr marker, no snapshot writes | same suite |
| Lock order / writer-block / invalid input unit pins | `stock-preparation-persist-unit-of-work.test.ts` |
| Plugin scope four-sheet bind + missing-hook fail-closed | `multitable-plugin-scope.test.ts` |
| Plugin scope UOW allowlist uses validated/trimmed sheet ids (whitespace fail-closed) | `multitable-plugin-scope.test.ts` (raw-allowlist mutant goes red) |
| CLI confirmation / forbidden keys / values-free shapes | `stock-preparation-persist-repair-once-cli.test.ts` |
| CI two-point wiring (exclude + whole-file) | `scripts/ops/stock-preparation-p4-repair-ci-wiring.test.mjs` |

Mutation-style RED proofs that delete in-tx locks or drop prefix equality are expressed as unit /
facade constructions in the above suites rather than permanent production sabotages. The
scope-normalization mutant (raw `input.sheetIds` allowlist) is recorded in §9 post-fix verification.

## 11. Honest unverified boundaries

1. **Production always-on authorization** is still not granted. A+C closeout ≠ OD-4 unlock.
2. **W6/T4 postdeploy smoke** and on-prem PowerShell acceptance were not re-executed here.
3. **Multi-tenant staging / load at PERSIST_MAX_PLAN_LINES (24,999)** long-hold timing was not
   re-benchmarked on this host.
4. **Cross-plugin consumers** of the new optional UOW method: only stock-prep persist/repair call
   it; no other plugin adoption was attempted or required.
5. **Remote PR merge order and CI on GitHub** after push are outside this worktree; see §12.
6. **Issue 4437** operator diagnostics remain a separate gate; this closeout did not open that
   package or flip its flag.

## 12. Recommended merge order (human operator)

1. Land / merge **#4470 (Option A)** onto main first (atomic UOW hard cut).
2. Retarget / rebase **#4473 (Option C)** onto the merged A tip (or use this consolidated rebased
   branch as the single closeout vehicle if owner chooses one PR).
3. Keep **issue 4437** as a **separate operator gate** (preserved-capture diagnostic, flag OFF). Do
   not couple its package SHA or flag to A/C merge.
4. After C window completes: retirement PR removes CLI + repair module only; migrations and audit
   history stay.

Do not use bare GitHub auto-close keywords adjacent to issue numbers in PR bodies for umbrellas that
must outlive a single merge.

## 13. Issue 4437 (operator gate, separate)

Entity-machine preserved-capture work tracked under issue 4437 remains an **operational diagnostic
with flag OFF**. It is not part of P4 A/C runtime scope, not a reason to change persist/repair code,
and not unblocked or re-packaged by this closeout. Operator decisions about that capture package stay
independent of the A then C merge sequence above.

## 14. Closeout worker constraints honored

- Work confined to this isolated worktree
- No push, no merge, no auto-merge arming
- No edits to issue 4437 entity-machine surfaces or release artifacts
- `externalWrite=false`, values-free outputs, one-shot repair, immutable snapshots, and no
  production always-on authorization preserved

---

*End of P4 closeout design and verification record (2026-07-19).*
