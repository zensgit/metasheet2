# Multitable AI bulk / whole-column fill + review-before-write — design lock — 2026-06-21

> **Status: 待评审 / NOT implemented.** This is a design-lock to ratify, not the impl. Decisions D1–D6 below
> each need an answer before any code. Build ON the shipped per-record AI-shortcut infrastructure; do not fork it.
>
> **Staleness guard (the lesson from 8 traps):** as of `97e55e76f`, the AI route surface is exactly
> `/ai/readiness`, `/ai/usage-summary`, `/ai/shortcut/preview`, `/ai/shortcut/run` (both single-record),
> `/ai/suggest-formula`. **No bulk/batch/whole-column route exists.** Re-grep the routes at impl time before
> writing code — the parallel session moves faster than docs.

## 0. Scope (one line)

Apply an **already-persisted** `field.property.aiShortcut` (kinds `summarize | classify | extract | translate`)
across **many records at once**, behind a **review-before-write** step: generate proposed values → show a diff →
the actor confirms → values are written. The novelty is the **batch dimension only** — cost, permission, and
partial-success *at scale*. Everything else is the existing primitive.

## 1. What already exists (build on, do not duplicate)

The per-record pair `POST /sheets/:id/ai/shortcut/preview` → `…/shortcut/run` **already is review-before-write
for a single cell**. The run pipeline (multitable-ai.ts ~478–660) is the unit to extend, gate-for-gate:

1. persisted-config-only (inline config rejected) → 2. record-read gate → 3. sheet `canEditRecord` →
4. target field type ∈ {string,longText} + **layer-3 field-permission** (visible/readOnly) → 5. `readRecordOnce`
(captures `version` as anti-TOCTOU `expectedVersion`) → 6. row-policy `ensureRecordWriteAllowed` (own-write scope)
→ 7. `assembleMaskedPrompt` (masked source fields **never** enter the prompt) → 8. `executeShortcut`
(**reserve-then-settle** quota + provider call; `finalize` re-settles status keeping usage — provider spend is
real regardless of write outcome) → 9. authoritative `RecordWriteService.patchRecords` (never raw SQL) with the
same post-commit Yjs invalidation as `POST /patch`.

Reused verbatim by the bulk path: the four kinds + server-side per-kind prompt templates, `ai-provider-client`
(cost table, `AiCompletionResult`, reserve-then-settle), `ai-provider-readiness` (env contract + per-tenant
daily/weekly token caps), the per-record gate sequence, and `patchRecords`. **Bulk adds orchestration, not a
second AI subsystem.**

## 2. Decisions to ratify (D1 is the crux — please answer each)

### D1 — Preview ↔ write ↔ charge-once (the architecture-defining fork)
"Preview diff," "cost caps," and "confirm write" are one mechanism, not three. Choose:

- **D1-A (recommended): preview generates real values per row, charged once, cached.** Preview calls the provider
  for every in-scope row, persists the proposed outputs server-side (keyed by run-id + recordId + the row
  `version` they were generated against), and the diff shows the **true** proposed value per row. Confirm-write
  **persists the cached outputs — no second provider call.** Reservations for rows the actor does **not** confirm,
  or that failed to generate, are **released back** to the per-tenant quota. Cost is incurred exactly once, at
  preview. Trade-off: previewing a 5k-row column is expensive and may be abandoned → mitigated by D3 row-cap + D4
  pre-check.
- **D1-B: preview is a sample + token estimate** (cheap), generation happens at confirm-write. Weaker review (the
  diff is illustrative, not the actual values); confirm-write is where the real spend + real outputs land.

The whole cost-cap and double-charge story hinges on D1. Recommend **D1-A** (true review is the point of the
feature; charge-once + release makes the cap math honest). A stale row (its `version` changed between preview and
confirm) is **dropped from the write** with a per-row "stale — re-preview" outcome (never write a value generated
against different source data).

### D2 — Batch scope
- **D2-A (recommended): the view's filtered + visible set** — consistent with the #3010 export semantic just
  shipped (the reviewer cared about exactly this distinction). "Fill this column" means the rows the view shows.
- **D2-B: whole sheet** (ignores the view filter). Available, but must be labeled as such, not the default.

### D3 — Execution model + how 429 composes
A whole column of slow, rate-limited provider calls cannot be a naïve synchronous request.
- **D3-A (recommended for v1): synchronous with a hard row cap** (`MULTITABLE_AI_BULK_MAX_ROWS`, default small,
  e.g. 200) — bounded concurrency, and a per-call `429 + Retry-After` **pauses the batch** (respects the existing
  per-call rate-limit semantics) up to a deadline, then returns partial results with a "rate-limited, N remaining"
  outcome. Over the cap → `400 BULK_SCOPE_TOO_LARGE` (no silent truncation).
- **D3-B: async job with progress** (job row + poll/stream). More scalable, materially more surface (job table,
  progress endpoint, cancellation). Recommend deferring to a later ring; v1 = D3-A.

### D4 — Cost caps
Before generating, estimate `rows × per-row-est-tokens` and **pre-check against the per-tenant daily/weekly token
cap** (reuse `ai-provider-readiness`); refuse the whole run with `AI_BULK_QUOTA_INSUFFICIENT` if it can't fit
(no partial pre-charge surprise). Then reserve-then-settle **per row** (the existing primitive) during preview;
**release** reservations for unconfirmed/failed/stale rows (D1-A). One bulk run never exceeds the standing
per-tenant cap.

### D5 — Permission scoping covers the DIFF, not just the write (fail-first leak gate)
Every row independently passes the **same gates** the single-record run applies: record-read, sheet
`canEditRecord`, target field-type + layer-3 field-permission (visible/readOnly), row-policy own-write. A row the
actor cannot write is **excluded from the writable set** (shown as skipped/forbidden, never silently written).
Crucially, **the review diff itself is masked to the viewer's read perms** — a proposed value derived from source
fields the viewer can't read is never shown (the masked-prompt discipline already covers generation; the diff
display must match). Locked under a fail-first integration test over a **mixed-permission batch** (some rows
writable, some denied, one field-readonly) — same discipline as the button/export leak gates.

### D6 — Confirm-write + failure / partial-success semantics
Explicit confirm step (the actor sees the diff, then confirms). The write is **per-row independent** through
`patchRecords` with each row's captured `expectedVersion`: some rows commit, some fail (version_conflict / lock /
field-forbidden / validation). The response is a **per-row outcome list** (`written | skipped_no_perm |
stale_reprev | write_conflict | provider_error`), counts, and total settled cost. **Charge-once invariant
(§2.5 of the per-record lock): a row whose value was generated is charged even if its write later fails** — the
provider spend is real; `finalize` re-settles status keeping usage. No all-or-nothing rollback (a 200-row write
is not one transaction); the outcome list is the contract.

## 3. Proposed surface (illustrative — ratify the shape, not the code)

- `POST /sheets/:id/ai/shortcut/bulk-preview` → body `{ fieldId, scope: 'view'|'sheet', viewId?, recordIds? }`
  → resolves the in-scope readable+writable rows (D5), pre-checks cap (D4), generates per row (D1-A), returns
  `{ runId, rows: [{ recordId, version, proposed, masked?, writable }], skipped: [...], estCost, settledCost }`.
- `POST /sheets/:id/ai/shortcut/bulk-commit` → body `{ runId, recordIds: [confirmed], expectedVersions }`
  → persists cached outputs for confirmed+non-stale rows via `patchRecords`, releases the rest, returns the
  per-row outcome list (D6). `runId` is short-lived (cached outputs expire; a TTL line in the impl).

## 4. Invariants (locks)

- **Build-on:** reuse kinds, per-kind prompt templates, `ai-provider-client`, readiness/quota, the per-record gate
  sequence, and `patchRecords`. No raw-SQL write. No second AI subsystem.
- **Charge-once:** generated → charged once at preview; confirm persists cached outputs (no re-call); unconfirmed/
  failed/stale reservations released. Generated-but-write-failed rows stay charged (provider spend is real).
- **Masked diff:** the review never shows a value derived from source fields the viewer can't read.
- **Per-row gates + per-row outcomes:** every row passes the single-record gates; partial success is the contract,
  not a failure; no all-or-nothing rollback.
- **Bounded:** hard row cap (no silent truncation — over-cap is a 400); per-tenant quota pre-checked; 429 pauses.
- **Anti-TOCTOU:** each row's preview `version` rides into commit as `expectedVersion`; a changed row is dropped
  as stale, never written against shifted source data.

## 5. Staged TODO (each ring a separate explicit opt-in)

- 🔒 **B-0 — ratify D1–D6** (this doc). Gate: owner answers each decision. No code until then.
- ⬜ **B-1 — bulk-preview backend** (D1-A generate-cached + D4 cap pre-check + D5 per-row gates + masked diff) +
  real-DB leak gate over a mixed-permission batch + charge-once/release goldens.
- ⬜ **B-2 — bulk-commit backend** (cached-output persist via `patchRecords`, per-row outcomes, stale-drop,
  release-unconfirmed) + partial-success + version-conflict goldens.
- ⬜ **B-3 — frontend review-before-write UI** (column/selection trigger → diff table → confirm → outcome
  summary), reusing the `useAiShortcut` 429/quota/blocked handling + the i18n module extension points.
- 🔒 **B-4 — async job + progress (D3-B)** — deferred ring; only if v1 row-cap proves insufficient.

## 6. Explicitly NOT in scope

Async job/progress (B-4, deferred) · new AI kinds (the four shipped kinds only) · AI automation actions (the
staged plan already excludes these) · select-target classify (a later ring of the per-record lock) · any change
to the shipped aiShortcut/M4 infrastructure beyond additive orchestration.
