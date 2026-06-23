# Multitable AI bulk-fill B-4 — async job + progress — design lock — 2026-06-22

> **Status: 待评审 / NOT implemented.** This locks the decisions (BJ-1…BJ-10) and the 3-slice implementation
> plan. No code until D-locks are ratified. Then build in order: **backend job → FE progress → browser/real-DB
> verify**, each a separate opt-in.
>
> **Staleness guard:** as of `4a8005fc3`, the inline bulk path is `/ai/shortcut/bulk-preview` +
> `/ai/shortcut/bulk-commit` with `MULTITABLE_AI_BULK_MAX_ROWS=200`; the run cache is
> `multitable_ai_bulk_preview_cache`; charges book the `multitable_ai_usage_ledger`. Re-grep at impl time.

## 0. Why B-4

v1 (B-0→B-3) is synchronous with a hard 200-row cap, so a true *whole-column* fill on a large table returns
`BULK_SCOPE_TOO_LARGE`. B-4 lifts that with an **async job** (generate the column in the background, with
progress), keeping the v1 review-before-write contract intact.

## 1. Reuse, do not reinvent (the spine)

The codebase already has a **resumable job model** — reuse it; do not build a second job/status vocabulary:
- `workflow-job-contract.ts` — status enum `queued | running | suspended | resolved | failed | skipped |
  rejected | errored`, with `suspended` + `WORKFLOW_JOB_SUSPEND_REASONS` (`manual_task` / `delay` /
  `external_event`) — the A6-2 resumable primitive.
- `QueueService.ts` — the in-process queue/worker (`process` / delayed timer / `processNext`).
- `automation-job-service.ts` + `multitable_automation_jobs` — the persisted-job pattern (one status vocabulary).
- The shipped bulk-fill: `bulk-preview` (generate+charge), `bulk-commit` (write via `patchRecords`), the usage
  ledger — B-4 reuses this **generation + charge + write discipline inside a job**. It does NOT reuse the inline
  `…_preview_cache` for the job path (that store holds only confirmable outputs and cannot back review-at-scale);
  the job persists full per-row state to a new `multitable_ai_bulk_job_rows` table (BJ-1) so review / progress /
  commit survive crash, cancel, and quota-pause.

## 2. The lifecycle (the key insight — it IS a resumable workflow job)

The bulk-fill maps onto the resumable model exactly, so `suspended` carries the review wait:

```
queued
  → running        (generate + charge + cache per provider-bound row; emit progress)
  → suspended      (suspend_reason = manual_task: AWAITING REVIEW — the column is generated & cached)
  → [user reviews the cached diff, confirms a subset]
  → running        (commit the confirmed cached rows via bulk-commit, chunked)
  → resolved       (per-row outcome summary)
```
Branches: quota limit mid-generate → `suspended(manual_task)` + `quota_paused` (partial reviewable; ungenerated
rows = `pending_not_generated`, uncharged); user cancels → `rejected`; crash → `errored` (the job-rows partial
stays committable).

## 3. Decisions to ratify (BJ-locks — the recommended lock for each)

### BJ-1 — Job model: reuse the workflow-job + a job header AND a durable per-row state table
**Lock:** persist the job in **two** new tables, with the **workflow-job-contract status vocabulary** (no new
enum); worker via `QueueService`. The job owns the *generate* phase; `suspended(manual_task)` is the review wait;
the *commit* phase resumes it. **Rejected:** a bespoke job/status model (forks the converged vocabulary).
- **`multitable_ai_bulk_job`** — the job header (mirrors `multitable_automation_jobs`): `job_id, actor_id,
  sheet_id, field_id, scope_fingerprint` (BJ-7), `status` (workflow-job vocab), `total, generated, settled_cost,
  quota_paused, created/updated/expires_at`.
- **`multitable_ai_bulk_job_rows`** — the **durable per-row state store**, one row per in-scope record. The
  existing inline `multitable_ai_bulk_preview_cache` holds only confirmable *outputs* (proposed/version/cost) and
  CANNOT back BJ-9, so the job path uses this superset instead: `job_id, record_id, ordinal` (stable review
  cursor), `state` (`pending` | `generated` | `skipped` | `failure` | `committed` | `pending_not_generated`),
  `current_value` (the truthful diff "before"), `preview_version`, `proposed_value` (generated rows only),
  `masked`, `reason` (skip/failure reason), `usage_tokens, cost_usd, created/updated_at`; PK `(job_id, record_id)`,
  index `(job_id, ordinal)`. Written **as each row resolves** (durable) — the single source of truth for review
  (BJ-9), progress (BJ-3), commit (BJ-10), and crash/cancel/quota-pause survival. The inline ≤200 path is
  unchanged (still `…_preview_cache`).

### BJ-2 — Charge accounting at scale: per-row settle + quota-pause = stop-and-review (v1)
**Lock:** per-row reserve-then-settle into `multitable_ai_usage_ledger`, identical to v1 (charge-on-generation,
**never released**). The whole-run pre-check (D4) does NOT apply at job scale (a 5000-row estimate would always
refuse). The job generates until the per-tenant daily/weekly quota is hit, then **stops generating** and
**suspends for review** (`suspend_reason = manual_task`) with `quota_paused = true` on the header.
**v1 quota semantics (LOCKED):** generated+charged rows are reviewable + committable; the ungenerated remainder
rows are set to `pending_not_generated` in job-rows — **UNCHARGED, no proposed value, NOT committable**; to fill
them the actor **re-runs** later when quota is available. **Deferred:** auto-resume of generation after a
quota-window reset (a future `suspend_reason = delay` variant) — v1 does NOT auto-resume; it stops-and-reviews.
Abandon-no-release holds: generated rows (paused / cancelled / crashed) stay charged; never-generated rows are
uncharged.

### BJ-3 — Progress transport: poll (SSE deferred)
**Lock:** `GET /sheets/:id/ai/shortcut/bulk-job/:jobId` → `{ state, total, generated, skippedCount,
failuresCount, settledCost, quotaPaused }`. FE polls every N s. **Deferred:** SSE/streaming (poll is enough for
a bounded job; revisit only if progress latency is a real complaint).

### BJ-4 — Cancellation: stop generating, keep generated rows charged + committable
**Lock:** `POST …/bulk-job/:jobId/cancel` → the worker stops at the next row; rows already `generated` in job-rows
stay **charged + committable**; ungenerated rows → `pending_not_generated` (uncharged); job → `rejected`. No
release (charge-on-generation). The actor may still review + commit what was generated.

### BJ-5 — Crash-safety: persisted partial is committable; no auto-resume in v1
**Lock:** each row's resolution is written to **`multitable_ai_bulk_job_rows` as it is produced** (durable), so a
crashed/restarted job loses no work — its `generated` rows stay reviewable + committable, its `pending` rows are
visibly un-generated; the job header is marked `errored`. **Deferred:** auto-resuming *generation* after a crash
(the workflow model supports resume, but v1 leaves the partial reviewable/committable instead).

### BJ-6 — Async cap (higher than the inline 200)
**Lock:** `MULTITABLE_AI_BULK_JOB_MAX_ROWS` (default 5000, aligned to the server view-load clamp). Over it →
`400 BULK_SCOPE_TOO_LARGE`. The inline 200 cap stays for the synchronous path; > inline-cap routes to a job.

### BJ-7 — Concurrency: one active job per (actor, sheet, field, scopeFingerprint)
**Lock:** the active-job key is `(actor, sheet, field, scope_fingerprint)` — `scope_fingerprint` = a stable hash
of the resolved scope (view id + filter/sort signature for `scope:view`; the sorted record-id set for
`scope:selection`). A new start whose fingerprint **matches** an active job returns that job's `jobId`
(idempotent resume — never a duplicate generating run / double-charge). A new start whose fingerprint **differs**
from an active job for the same (actor, sheet, field) → **`409 ACTIVE_JOB_EXISTS`** with the existing job's
metadata (id, scope summary, progress) — it is **never silently attached to the old batch** (different intent).

### BJ-8 — Entry/routing: `bulk-preview` returns a `jobId` when scope > inline cap
**Lock:** keep ONE entry. `bulk-preview` resolves the gated provider-bound set; if it is ≤ `MULTITABLE_AI_BULK_MAX_ROWS`
it stays **inline** (v1 unchanged); if larger (and ≤ the job cap) it starts a job and returns `{ jobId }`. The FE
branches on the response shape. **Rejected:** a separate `/bulk-job/start` entry (two entries to keep in sync).

### BJ-9 — Review at scale: paginated from job-rows, still truthful
**Lock:** the review reads **`multitable_ai_bulk_job_rows` by page** (`GET …/bulk-job/:jobId/rows?cursor=…`,
ordered by `ordinal`); the diff table is paginated/virtualized (reuse the A1 windowing posture). Each row carries
its durable `current_value` (the truthful diff "before", server-stored at generation — never grid-page dependent;
the B-3 invariant holds at scale), `state`, `proposed_value`, `masked`, `reason`. Confirmable = `state =
generated`; `skipped` / `failure` / `pending_not_generated` render distinctly and are NOT selectable. Bulk
select-all / deselect operate over the full `generated` set (server-side count), not just the loaded page (and
say so).

### BJ-10 — Commit at scale: backend-owned, chunked, durable
**Lock:** the FE submits the confirmed `recordIds` **once**; the **backend** (the job's commit phase) chunks them
(≤ the inline cap per chunk) through the existing `bulk-commit` write discipline sourced from job-rows, writes
each row's outcome back to job-rows (`committed` / `stale_reprev` / `write_conflict` / `skipped_no_perm`), and
exposes the **aggregate outcome durably** on the job header (poll-readable). Re-gate + `expectedVersion`
stale-drop + per-actor owner gate apply per chunk, unchanged. **Rejected:** FE-driven chunk loops (progress would
not survive a reload — the backend owns chunking + the durable aggregate).

## 4. Invariants carried from v1 (unchanged at scale)

charge-on-generation / never-release · per-actor cache ownership · `expectedVersion` stale-drop · re-gate at
commit · truthful per-row status (server `currentValue`, masked/skipped/failures/stale distinct) ·
gate-before-cap/quota · computed-filter → 422 · cache stores the exact value.

## 5. Implementation slices (each a separate opt-in, in order)

- ⬜ **Slice 1 — backend job.** `multitable_ai_bulk_job` + **`multitable_ai_bulk_job_rows`** migrations + the
  QueueService worker (generate→suspend→commit-on-resume, writing each row to job-rows **as it resolves**) +
  poll/cancel routes + a paginated `…/rows` read + `bulk-preview` routing (>inline-cap → jobId, keyed by the BJ-7
  scope-fingerprint) + the backend chunked commit phase. Real-DB goldens: job lifecycle
  (queued→running→suspended→running→resolved); charge-on-generation at scale + ledger delta == provider calls;
  **quota-pause → `suspended(manual_task)` + `quota_paused`, generated rows charged & committable, remainder
  `pending_not_generated` & uncharged**; cancel keeps generated charged+committable; **per-row job-rows survive a
  simulated restart / cancel / quota-pause with `state` / `skipped` / `failure` / `current_value` intact**
  (BJ-9 durability — the keystone); the paginated `…/rows` returns truthful per-row state ordered by `ordinal`;
  a different-scope start → `409 ACTIVE_JOB_EXISTS` (BJ-7); per-actor one-job concurrency; async cap → 400; the
  carried invariants (owner gate / stale-drop / re-gate) per commit chunk + the durable aggregate outcome.
- ⬜ **Slice 2 — FE progress.** start-job → progress UI (poll) → on `suspended(manual_task)` open the
  paginated/virtualized review (reuse `useAiBulkFill` + the B-3 dialog, extended) → confirm subset → chunked
  commit with running progress → outcome summary. Cancel control. FE specs: the job state machine, paginated
  truthful diff, quota-paused messaging, cancel.
- ⬜ **Slice 3 — browser/real-DB verification.** Playwright e2e of the full async flow (start → progress →
  review → confirm → commit → summary) against a seeded sheet, plus the Slice-1 real-DB goldens in CI. This is
  the "browser/real-DB 验证" slice — prove the end-to-end UX, not just the unit contracts.

## 6. Explicitly NOT in scope

SSE/streaming progress (poll only) · auto-resume of interrupted *generation* · new AI kinds · cross-base ·
scheduling/recurring fills · any change to the v1 inline path beyond the >cap→job routing.
