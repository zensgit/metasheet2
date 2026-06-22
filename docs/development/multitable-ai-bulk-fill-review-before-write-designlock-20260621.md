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

- **D1-A (recommended): preview generates the real value per row AND charges at generation; confirm only writes.**
  Preview calls the provider for every in-scope row, **settles usage against the per-tenant quota for each
  provider-called row** (the existing per-record discipline — provider spend is real), persists the proposed
  outputs server-side (the **run cache**, keyed by run-id + recordId + the row `version` generated against), and
  the diff shows the **true** proposed value. Confirm-write **persists the cached outputs — no second provider
  call, no second charge.** **A provider-called row is NEVER released** — not on un-confirm, not on stale, not on
  write-conflict. A user who previews, reads the outputs, then abandons confirm has *still* consumed the provider
  and the quota — this **closes the preview-abandon quota-bypass**. **Only rows the provider never reached are
  uncharged:** pre-gate skipped (no perm / wrong type), scope over-cap rejected, rate-limited *before* the call,
  and `generation_failed_before_usage` (no usage returned). The two failure words are distinct:
  `generation_failed_before_usage` = uncharged; `write_failed_after_generation` = **charged** (the output was
  produced). UI copy: *"Preview consumes quota; confirm only writes the cached outputs."* Trade-off: previewing a
  5k-row column really spends → bounded by the D3 row-cap + D4 pre-check, so a preview can't quietly burn a
  column's worth of quota.
- **D1-B: preview is a sample + token estimate** (cheap), generation happens at confirm-write. Weaker review (the
  diff is illustrative, not the actual values); confirm-write is where the real spend + real outputs land.

The whole cost-cap story hinges on D1. Recommend **D1-A**: charge at generation, never release a provider-called
row — total charged usage then equals the provider calls actually made, with **no abandon-to-evade path**. A stale
row (its `version` changed between preview and confirm) is **dropped from the write** with a per-row "stale —
re-preview" outcome (never write a value generated against shifted source data) — but it **stays charged**, since
the provider was already called for it at preview.

### D2 — Batch scope
- **D2-A (recommended): the view's filtered + visible set, server-resolved** — the FULL record set the view's
  filter/sort resolves to **server-side, NOT the currently-loaded grid page** (exactly the #3010 export semantic).
  "Fill this column" means every row in the filtered view, on-page or not.
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
cap** (reuse `ai-provider-readiness`); refuse the whole run with `AI_BULK_QUOTA_INSUFFICIENT` if it can't fit.
Then reserve-then-settle **per row** during preview (the existing primitive). **A settled (provider-called) row
stays charged** — the only reservations released are for rows the provider never reached (pre-gate skipped,
over-cap, rate-limited-before-call, `generation_failed_before_usage`). Confirm vs abandon does **not** change the
charge. One bulk run never exceeds the standing per-tenant cap, and **total charged usage == provider calls made**
(no abandon-to-evade).

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
stale_reprev | write_conflict | write_failed_after_generation | generation_failed_before_usage`), counts, and
total settled cost. **Charge invariant (per-record §2.5): any row the provider was called for is charged — full
stop — whether it is written, write-conflicted, abandoned (un-confirmed), or dropped as stale.** The only
uncharged outcomes are `skipped_no_perm` / over-cap / rate-limited-before-call / `generation_failed_before_usage`
(no usage returned). `finalize` re-settles status keeping usage. No all-or-nothing rollback (a 200-row write is
not one transaction); the outcome list is the contract.

## 3. Proposed surface (illustrative — ratify the shape, not the code)

- `POST /sheets/:id/ai/shortcut/bulk-preview` → body `{ fieldId, scope: 'view'|'sheet', viewId?, recordIds? }`
  → resolves the in-scope readable+writable rows (D5; server-side full filtered set per D2), pre-checks cap (D4),
  generates + **charges** per provider-called row (D1-A), writes the run cache, returns
  `{ runId, rows: [{ recordId, version, proposed, masked?, writable }], skipped: [...], settledCost }`.
- `POST /sheets/:id/ai/shortcut/bulk-commit` → body `{ runId, recordIds: [confirmed] }`
  → persists the **cached** outputs for confirmed + non-stale rows via `patchRecords` (no provider call, no new
  charge), returns the per-row outcome list (D6). Abandoned / stale rows are simply not written — **already
  charged at preview, never released.**
- **Run cache — persistent, NOT in-memory** (so a confirm survives a restart and is always explainable): one row
  per `(runId, recordId)` = `{ runId, actorId, sheetId, fieldId, recordId, previewVersion, proposedValue,
  usageTokens, costUsd, createdAt, expiresAt }`. `bulk-commit` reads it; a short `expiresAt` TTL garbage-collects
  abandoned runs. The **charge is booked in the existing usage ledger at preview**, independent of cache expiry —
  GC'ing an abandoned run never un-charges it.

## 4. Invariants (locks)

- **Build-on:** reuse kinds, per-kind prompt templates, `ai-provider-client`, readiness/quota, the per-record gate
  sequence, and `patchRecords`. No raw-SQL write. No second AI subsystem.
- **Charge-on-generation, never released:** any provider-called row is charged once at preview and **stays
  charged** — un-confirm, stale, and write-conflict do NOT release it (this closes the preview-abandon quota
  bypass). Confirm persists the cached outputs with no second call/charge. Only provider-never-reached rows
  (`skipped_no_perm` / over-cap / rate-limited-before-call / `generation_failed_before_usage`) are uncharged.
- **Masked diff:** the review never shows a value derived from source fields the viewer can't read.
- **Per-row gates + per-row outcomes:** every row passes the single-record gates; partial success is the contract,
  not a failure; no all-or-nothing rollback.
- **Bounded:** hard row cap (no silent truncation — over-cap is a 400); per-tenant quota pre-checked; 429 pauses.
- **Anti-TOCTOU:** each row's preview `version` rides into commit as `expectedVersion`; a changed row is dropped
  as stale, never written against shifted source data.

## 5. Staged TODO (each ring a separate explicit opt-in)

- 🔒 **B-0 — ratify D1–D6** (this doc). Gate: owner answers each decision. No code until then.
- ⬜ **B-1 — bulk-preview backend** (D1-A generate-cached-and-charge + D4 cap pre-check + D5 per-row gates +
  masked diff + persistent run cache) + real-DB leak gate over a mixed-permission batch + **charge-on-generation
  goldens** (provider-called stays charged; only provider-never-reached uncharged).
- ⬜ **B-2 — bulk-commit backend** (cached-output persist via `patchRecords`, per-row outcomes, stale-drop;
  abandoned/stale rows stay charged — **NOT released**) + partial-success + version-conflict goldens + a
  **preview-abandon-does-not-release-quota** golden (the bypass test).
- ⬜ **B-3 — frontend review-before-write UI** (column/selection trigger → diff table → confirm → outcome
  summary), reusing the `useAiShortcut` 429/quota/blocked handling + the i18n module extension points.
- 🔒 **B-4 — async job + progress (D3-B)** — deferred ring; only if v1 row-cap proves insufficient.

## 6. Explicitly NOT in scope

Async job/progress (B-4, deferred) · new AI kinds (the four shipped kinds only) · AI automation actions (the
staged plan already excludes these) · select-target classify (a later ring of the per-record lock) · any change
to the shipped aiShortcut/M4 infrastructure beyond additive orchestration.
