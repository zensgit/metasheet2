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
- The shipped bulk-fill: `bulk-preview` (generate+charge+cache), `bulk-commit` (write cached), the run cache, the
  usage ledger — B-4 runs these **inside a job**, it does not re-implement them.

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
Branches: provider/quota limit mid-generate → `suspended` (quota-paused, the partial is reviewable);
user cancels → `rejected`; crash → `errored` (the cached partial stays committable).

## 3. Decisions to ratify (BJ-locks — the recommended lock for each)

### BJ-1 — Job model: reuse the workflow-job + a `multitable_ai_bulk_job` table
**Lock:** persist the job in a new `multitable_ai_bulk_job` table mirroring `multitable_automation_jobs`, using
the **workflow-job-contract status vocabulary** (no new enum). Worker via `QueueService`. The job owns the
*generate* phase; `suspended(manual_task)` is the review wait; the *commit* phase resumes it. **Rejected:** a
bespoke job/status model (would fork the converged vocabulary).

### BJ-2 — Charge accounting at scale: per-row settle + quota-pause-suspend (NOT whole-run pre-check)
**Lock:** per-row reserve-then-settle into `multitable_ai_usage_ledger`, identical to v1 (charge-on-generation,
**never released**). The whole-run pre-check (D4) does NOT apply at job scale (a 5000-row estimate would always
refuse); instead the job generates until the per-tenant daily/weekly quota is hit, then **suspends** with a
`quota_paused` marker — the generated+charged rows are cached and reviewable; the remainder is `pending`.
Carries the abandon-no-release invariant: paused / cancelled / crashed generated rows stay charged.

### BJ-3 — Progress transport: poll (SSE deferred)
**Lock:** `GET /sheets/:id/ai/shortcut/bulk-job/:jobId` → `{ state, total, generated, skippedCount,
failuresCount, settledCost, quotaPaused }`. FE polls every N s. **Deferred:** SSE/streaming (poll is enough for
a bounded job; revisit only if progress latency is a real complaint).

### BJ-4 — Cancellation: stop generating, keep charged+cached
**Lock:** `POST …/bulk-job/:jobId/cancel` → the worker stops at the next row; rows already generated stay
**charged + cached + committable**; job → `rejected`. No release (charge-on-generation). The actor may still
commit what was generated.

### BJ-5 — Crash-safety: cached partial is committable; no auto-resume in v1
**Lock:** each generated output is persisted to the run cache as it is produced (durable), so a crashed/restarted
job loses no work — its cached rows remain reviewable + committable; the job row is marked `errored`. **Deferred:**
auto-resuming *generation* after a crash (the model supports it, but v1 leaves the partial committable instead).

### BJ-6 — Async cap (higher than the inline 200)
**Lock:** `MULTITABLE_AI_BULK_JOB_MAX_ROWS` (default 5000, aligned to the server view-load clamp). Over it →
`400 BULK_SCOPE_TOO_LARGE`. The inline 200 cap stays for the synchronous path; > inline-cap routes to a job.

### BJ-7 — Concurrency: one active job per (actor, sheet, field)
**Lock:** at most one non-terminal bulk-job per `(actor, sheet, field)`. A new start while one is active returns
the **existing** `jobId` (the FE resumes polling it) — never a duplicate generating run (which would double-charge).

### BJ-8 — Entry/routing: `bulk-preview` returns a `jobId` when scope > inline cap
**Lock:** keep ONE entry. `bulk-preview` resolves the gated provider-bound set; if it is ≤ `MULTITABLE_AI_BULK_MAX_ROWS`
it stays **inline** (v1 unchanged); if larger (and ≤ the job cap) it starts a job and returns `{ jobId }`. The FE
branches on the response shape. **Rejected:** a separate `/bulk-job/start` entry (two entries to keep in sync).

### BJ-9 — Review at scale: paginated, still truthful
**Lock:** the review reads the cached run **by page** (`GET …/bulk-job/:jobId/rows?cursor=…`) and the diff table
is paginated/virtualized (reuse the A1 windowing posture). Each row's `currentValue` is the **server-cached**
value (truthful per row, never grid-page dependent — the B-3 invariant holds at scale). Bulk select-all /
deselect operate over the full cached set, not just the loaded page (and say so).

### BJ-10 — Commit at scale: chunked over bulk-commit
**Lock:** the confirmed subset commits via the existing `bulk-commit` in **chunks** (≤ the inline cap per call),
driven by the job's commit phase (or the FE). Per-row outcomes aggregate across chunks into the final summary.
Re-gate + `expectedVersion` stale-drop + per-actor owner gate apply per chunk, unchanged.

## 4. Invariants carried from v1 (unchanged at scale)

charge-on-generation / never-release · per-actor cache ownership · `expectedVersion` stale-drop · re-gate at
commit · truthful per-row status (server `currentValue`, masked/skipped/failures/stale distinct) ·
gate-before-cap/quota · computed-filter → 422 · cache stores the exact value.

## 5. Implementation slices (each a separate opt-in, in order)

- ⬜ **Slice 1 — backend job.** `multitable_ai_bulk_job` migration + the QueueService worker (generate→suspend→
  commit-on-resume) + poll/cancel routes + `bulk-preview` routing (>inline-cap → jobId) + chunked commit phase.
  Real-DB goldens: job lifecycle (queued→running→suspended→running→resolved); charge-on-generation at scale +
  ledger delta == provider calls; **quota-pause → suspended, partial charged+cached**; cancel keeps charged+
  committable; crash leaves the partial committable; per-actor concurrency (one job); async cap → 400; the
  carried invariants (owner gate / stale-drop / re-gate) per chunk.
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
