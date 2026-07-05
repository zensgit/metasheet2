# Multitable AI-fields governance arc — S1 write provenance + commit-action batch grouping — dev & verification (2026-07-05)

> **Design-lock**: ratified and merged to `main` — PR #3569, squash commit `6b0e27bf2`.
> **Runtime**: code-complete, CI green, **awaiting owner merge** — PR #3584, branch
> `claude/multitable-ai-provenance-s1-runtime-20260705`, head `b44a375e5`, 3 commits, +691/−11 across 12 files.
> Per the lock's own change-surface statement: no new tables, no migrations, no new env flags, no
> restore-surface change.

## 1. Line summary & motivation

Every AI write path (`patchRecords`) currently omits `source`, which defaults to `'rest'` — so in Global
History an AI shortcut fill is indistinguishable from a manual edit. Separately, `patchRecords` mints a fresh
`bulkBatchId` **per call**, but AI bulk/job commit writes one row at a time via `commitOneRecord` — so N
confirmed rows from a single "confirm this bulk-fill" action land as N unrelated single-row batches. History
Center then shows one AI commit action as N scattered rows, and any future batch-scoped revert would have no
grouping key to scope over.

S1 is the first slice of the AI-fields governance arc: it (a) attributes every AI write with a new
`'ai-shortcut'` `RecordWriteSource` value, and (b) adds an optional `batchId` seam to the write spine so that
one **commit action** — which may internally span multiple `patchRecords` calls (e.g. BJ-10 job-commit
chunking) — shares one server-minted batch id. It is explicitly **not** a rollback feature: it is the
attribution + grouping foundation a future batch-scoped revert (S1b) would need. That boundary was sharpened
mid-review — see §3.

## 2. Design

**Lock doc**: `docs/development/multitable-ai-write-provenance-batch-grouping-s1-designlock-20260705.md`,
ratified via PR #3569, squash-merged to `main` at `6b0e27bf25aa2a70f26a6474da5f9665ba909a35` (`6b0e27bf2`).

Eleven locked clauses — LOCK-A (source attribution) A1–A5, LOCK-B (commit-action batch semantics) B1–B6:

| Lock | Statement |
|---|---|
| **A1** | `RecordWriteSource` (`post-commit-hooks.ts`) gains `'ai-shortcut'`. `RecordRevisionSource` needed no change — it was already an open `… \| string` union. |
| **A2** | All three AI write paths tag `source: 'ai-shortcut'` — the inline shortcut-run call site, and the shared `commitOneRecord` helper (covers bulk-commit **and** job-commit at once) — two code sites for three routes. |
| **A3** | Revisions are written **only** by the write spine (`record-write-service`); the AI routes never insert revisions directly. |
| **A4** | Restoring a record an AI batch touched writes `source: 'restore'` — attribution never bleeds through restore. |
| **A5** | History Center's `sourceLabel` map (an **inline** zh/en map in `HistoryCenterModal.vue`, not a shared module) gets an `ai-shortcut` entry. Explicitly **not** extracted into a shared helper until a second consumer needs one. |
| **B1** | New **optional** write-spine seam `RecordPatchInput.batchId?: string`. Absent → behavior byte-identical to today (per-call `randomUUID()`). Present → used as the shared batch id for every row the call writes. |
| **B2** | LOCK-12 semantic extension: **"one COMMIT ACTION = one batch"** — a commit action may span multiple per-row `patchRecords` calls sharing one server-minted `batchId`; the per-call default stays the base case for every other caller. |
| **B3** | AI bulk-commit and job-commit **routes** (not `commitOneRecord` itself) mint ONE `randomUUID()` per **commit request**, threaded into every `commitOneRecord` call of that request — including across BJ-10's internal chunk boundaries. The inline single-cell run passes no `batchId` (a single-row action stays its own batch). |
| **B4** | `batchId` is **server-minted only** — a client-supplied value in a request body has no effect (never an API field). |
| **B5** | Batch sharing is **attribution-only grouping**: per-row commit discipline — commit-time re-gate, cached `previewVersion` as `expectedVersion` (anti-TOCTOU), the existing per-row outcome vocabulary, actor-bound preview cache — is unchanged. No single-transaction merge. |
| **B6** | **No `runId` persistence in v1** — `meta_record_revisions` stays frozen (no new column). Commit responses gain `batchId` so callers can map run→batch ephemerally; audit-grade run↔batch persistence is a separate gated slice (its own migration + redaction/retention treatment). |

## 3. Review history

### Design-lock (#3569) — two rounds before ratification

- **Round 1 — two nails**, already folded into the lock's first pushed commit (`6b0e27bf2`'s own message
  states it is "incorporating both review nails"): (a) `batchId` must be an explicit write-spine seam
  (`RecordPatchInput.batchId?: string`), not an assumption baked into a call site; (b) no `runId` persistence
  in v1 — the revisions surface stays frozen (→ B6).
- **Round 2 — High + Low**, addressed in a follow-up commit on the same PR ("address S1 lock review —
  downgrade to grouping FOUNDATION, gate S1b true batch rollback, fix label claim"):
  - **High**: the original draft overclaimed "batch rollback." Verified at line level that today's restore
    surface cannot revert a history batch — single-record restore-execute takes one explicit
    `targetVersion`, and scoped/batch restore (BS-2/BS-4) takes `recordIds[]` + **one shared** `targetVersion`
    with no `batchId` input and no per-record predecessor targeting; History Center is read-only. The lock
    was **downgraded and retitled** to "commit-action batch grouping (rollback FOUNDATION)", the file renamed
    from `…batch-rollback…` to `…batch-grouping…`, §4 rewritten to state exactly what S1 guarantees toward a
    *future* revert (shared `batch_id` + per-revision version chain + source attribution, nothing more), the
    golden matrix's G5 turned into a read-side projection-grouping golden with a new G5b (existing-route
    restore keeps `source='restore'`), and true batch-scoped rollback split out as a separate gated **S1b**
    design-lock.
  - **Low**: source labels were documented as a shared label module; corrected to "an inline zh/en map in
    `HistoryCenterModal.vue:133`" (`batch-restore-labels.ts` is unrelated record-title capture) — A5 updated
    to lock the inline-map-first discipline explicitly.

### Runtime (#3584) — two rounds, plus one CI catch

- **Initial implementation** — `24a785e89`. Full LOCK-A/LOCK-B surface + the G1–G8 golden matrix, plus a
  self-reported mutate/confirm-RED/revert-to-GREEN check on the `batchId ?? randomUUID()` line (see §5).
- **Round-1 review fixes** — `a01687f80`:
  - *Medium*: bulk-commit and job-commit **responses** were missing `batchId`, contradicting LOCK-B6
    ("commit responses gain batchId so callers can map run→batch ephemerally"). Fixed in both routes as
    `written`/`committed` `> 0 ? commitBatchId : null` (see §4); added the FE `AiBulkCommitData` /
    `AiBulkJobCommitData` type fields, updated 4 FE fixture files, and added response-equals-revision
    `batch_id` assertions to **G2/G3/G4a/G4b/G5/G7**.
  - *Low*: G3's mixed-outcome batch was missing a `skipped_no_perm` row; added (a record owned by a different
    actor, re-gated at commit).
- **CI-caught sibling gap** — `b44a375e5`: CI turned up a real miss in the previous fix. The **pre-existing**
  (pre-S1) integration test in `packages/core-backend/tests/integration/multitable-ai-bulk-commit.test.ts` has
  its own "response shape is pinned (fixture-drift discipline)" test asserting an exact
  `Object.keys(res.body).sort()` on the bulk-commit response — a sibling lock to the FE fixture lock already
  fixed, but on the backend integration-test side, in a file the round-1 sweep hadn't touched (that sweep
  covered FE fixtures + `tests/unit`, not `tests/integration`). Fixed by adding `batchId` to the pinned key
  set and asserting it is a string.

Honest note: two independent verification passes (the implementing session, and a separate review pass)
each missed a different completeness gap on the same clause (LOCK-B6) before CI or a subsequent pass caught
it — round 1 caught the response-field omission itself; the CI-caught commit caught that the fix's own
regression sweep hadn't covered the integration-test tree. Both are now closed and the underlying rule
(any response-shape change needs a full-repo sweep for `Object.keys(...).sort()`-style exact-shape locks, not
just the newest fixtures) is recorded here for future response-shape changes.

## 4. Implementation surface

Four implementation files, no schema change:

- **`packages/core-backend/src/multitable/post-commit-hooks.ts`** — `RecordWriteSource` union gains
  `'ai-shortcut'` (line 4: `'rest' | 'yjs-bridge' | 'restore' | 'crossbase-mirror-write' | 'ai-shortcut'`).
- **`packages/core-backend/src/multitable/record-write-service.ts`** — `RecordPatchInput.batchId?: string`
  (optional seam, ~line 270); the mint point is `const bulkBatchId = batchId ?? randomUUID()` (line 769),
  preserving byte-identical behavior for every caller that doesn't pass one.
- **`packages/core-backend/src/routes/multitable-ai.ts`** — three write call sites tagged via two code
  sites: the inline run (`source: 'ai-shortcut'`, line 539) and the shared `commitOneRecord` helper (line
  1648) that both bulk-commit and job-commit route through. The bulk-commit route mints
  `const commitBatchId = randomUUID()` once per request (line 1150) and derives the response field as
  `const batchId = counts.written > 0 ? commitBatchId : null` (line 1197); job-commit does the analogous mint
  (line 1417) and `const batchId = counts.committed > 0 ? commitBatchId : null` (line 1450).
- **`apps/web/src/multitable/components/HistoryCenterModal.vue`** — the inline `sourceLabel` map (function at
  line 133) gets one added entry: `'ai-shortcut': ['AI 填充', 'AI fill']`.

Plus FE wire-type additions (`AiBulkCommitData.batchId`, `AiBulkJobCommitData.batchId`, both
`string | null`) in `apps/web/src/multitable/api/client.ts`, and test-only changes to 4 existing FE fixture
files and 1 pre-existing backend integration test (the CI-caught shape-lock update, §3).

## 5. Verification matrix

Real-DB suite `packages/core-backend/tests/integration/multitable-ai-write-provenance-batch-grouping-realdb.test.ts`
(registered behind `describeIfDatabase`, sentinel fails-not-skips without `DATABASE_URL`) — **10/10**
(sentinel + 9 scenarios); FE render suite
`apps/web/tests/multitable-history-center-ai-shortcut-label.spec.ts` — **2/2**.

| Golden | What it proves |
|---|---|
| *sentinel* | `DATABASE_URL` is actually set — this suite fails, not silently skips, without a real DB. |
| **G1** | Inline shortcut run writes `source='ai-shortcut'`; a single-row action is its own batch (exactly one revision shares that `batch_id`). |
| **G2** | Bulk-commit of N confirmed rows in **one** request → N revisions share **one** `batch_id`; both read paths (history events list **and** batch detail) show one batch with N changes. Response `batchId` matches. |
| **G3** | A **mixed-outcome** bulk-commit batch (`written` / `stale_reprev` / `not_in_cache` / `skipped_no_perm`) — only the WRITTEN rows ever get a revision, and only those join the batch; a non-written row contributes nothing (no phantom membership). Response `batchId` matches the batch of the 2 written rows. |
| **G4a** | Two **separate** bulk-commit requests → two distinct batches, each response carrying its own matching `batchId`. |
| **G4b** | Two **separate jobs**, each committed once, → two distinct batches (each response's `batchId` matches its own revisions); a third commit attempt on either job 409s `BULK_JOB_NOT_COMMITTABLE`, confirming job-commit is architecturally single-shot (the premise behind the G4 judgment call, §6). |
| **G5** | READ-side grouping across BJ-10 **chunking**: a job-commit request whose confirmed set spans multiple internal `patchRecords` calls (chunk cap forces 3 rows into 2 chunks) still shares **one** `batch_id`, and both read paths show one batch with all 3 changes. Response `batchId` matches. |
| **G5b** | Restoring a record an AI batch touched, via the **existing** single-record restore route, writes `source='restore'`, never `'ai-shortcut'` — attribution never bleeds through restore (A4). |
| **G6** | A plain (non-AI) `patch` caller is unaffected: no `batchId` supplied → each call still mints its own fresh id, `source` stays `'rest'` — byte-identical to pre-S1 behavior. |
| **G7** | A client-supplied `batchId` in a bulk-commit request body has no effect — silently dropped by the zod schema (not a 400); both the revision's `batch_id` and the response's `batchId` are the real server-minted value, never the client-supplied one (B4/B6). |
| **G8** (FE, 2 tests) | History Center's inline `sourceLabel` map renders the `ai-shortcut` entry ("AI fill", not the raw string) for an attributed batch; an unrecognized source still falls back to its own raw string, unchanged. |

**Non-vacuousness proof.** The suite's load-bearingness on the B1 mint line was checked twice, independently:
once by the implementing session and once by a separate review pass, each reverting
`record-write-service.ts`'s `const bulkBatchId = batchId ?? randomUUID()` to a bare `randomUUID()` (i.e.
discarding the caller-supplied `batchId` entirely) and re-running the suite. Both runs observed the same
result: **exactly G2, G3, G4b, and G5 go red** — the four goldens whose assertions depend on multiple rows
written by one commit request sharing a batch id — while every other golden (G1, G4a, G6, G7, G5b, G8) stays
green, because none of them assert **cross-row** batch-sharing within a single call. (G4a commits its two
records in two *separate* requests, so distinct ids arise either way; G7's assertion is only that the
client-supplied id is rejected, true regardless of the seam.) Reverting the mutation returns the suite to
green. This is consistent with which goldens assert `expect(revX?.batch_id).toBe(revY?.batch_id)` across
rows written by one request in the current test file.

**Broader regression posture** (as reported across the PR's 3 commits, consistent at each): full backend unit
suite **4186/4186** unaffected; backend `tsc --noEmit` and `apps/web` `vue-tsc -b` both clean; all 7
`multitable-ai-*.test.ts` integration files green (85/85) on a fresh DB + fresh migrations after the final
commit. PR #3584's CI is green across all required checks at head `b44a375e5`, including `test (20.x)`
(10m27s) and `test (18.x)` (4m17s); the one non-passing entry, `Strict E2E with Enhanced Gates`, shows
`skipping` — that job is gated repo-wide behind manual dispatch or a `v2-strict` PR label
(`.github/workflows/observability-strict.yml`), unrelated to this change and not a required check.

## 6. Judgment calls

- **G3's outcome vocabulary** follows bulk-commit's `RecordCommitOutcome`
  (`written | stale_reprev | not_in_cache | skipped_no_perm | write_conflict`) rather than job-commit's
  `JobCommitOutcome`, because job-commit genuinely has no `not_in_cache` concept (a job row is either
  generated-and-confirmed or `pending_not_generated`). G3 therefore drives bulk-commit, and G5 covers the
  job-commit-specific claim (BJ-10 chunking) instead — where a job-commit-specific proof adds unique value
  over G2/G3.
- **G4's "two commit requests on the same job"** is proven via **two independent commit actions** — two
  bulk-commit calls, and two separate jobs each committed once (G4a/G4b) — rather than two commits on one
  job, because a job's commit is architecturally single-shot: every commit call unconditionally transitions
  the job to `resolved`, and `resolved` is never committable again. This was confirmed both by reading
  `ai-bulk-job-service.ts` / `routes/multitable-ai.ts` and by a live assertion in G4b itself (a third commit
  attempt on an already-resolved job 409s `BULK_JOB_NOT_COMMITTABLE`).

## 7. Residuals & arc ledger

**Residuals (non-blocking):**

1. No real-DB golden covers the "zero rows written → response `batchId === null`" branch specifically (the
   branch logic — `counts.written > 0 ? commitBatchId : null` — is a trivial ternary, and the shape-lock
   already pins the field's existence). The FE-side `allExpired` fixture (an all-`not_in_cache` commit) does
   exercise `batchId: null`, but only against a mocked response, not a real DB round-trip. A natural pickup
   for whichever slice next touches this route.
2. FE types (`AiBulkCommitData.batchId`, `AiBulkJobCommitData.batchId`) exist, but no UI currently reads
   them — the lock only required that callers *can* map run→batch, not that one does yet. A commit-success
   toast that deep-links to the corresponding History Center batch is a natural S2+ rider, not a gap in this
   lock's own scope.
3. The line's audit value fully materializes only once AI writes happen for real: the AI write paths still
   sit behind the existing `MULTITABLE_AI_CONFIRM_LIVE_REQUESTS` double-confirm gate, and the DARK→GA
   enablement decision for that gate is a separate owner call, out of S1's scope.

**Arc ledger** (per the design-lock's §8, updated for this line's status):

- **S1** (this line) — write provenance + commit-action batch grouping (rollback foundation): design ✅
  merged (#3569, `6b0e27bf2`); runtime ✅ code-complete + CI green, merge pending (#3584, `b44a375e5`).
- 🔒 **S1b** — true history-batch rollback (restore-surface extension: batch-scoped revert + per-record
  predecessor targeting + a History Center write entry). Separate gated design-lock; explicitly not promised
  by S1.
- ⬜ **S2** — prompt-as-audited-config UI (renders the existing `aiShortcut` field-property diff already
  recorded into `meta_config_revisions` human-readably). Not yet built; a design-lock draft for this slice is
  understood to be queued separately from this line.
- 🔒 **S3** — staleness lineage (design-first: state storage + no-auto-recompute UX).
- 🔒 **S4** — cost-visibility polish (estimate UI + per-field/per-run usage dimensions).
- 🔒 **S5** — normalize kind (cleaning-arc first cut) · 🔒 rider: classify→select.
