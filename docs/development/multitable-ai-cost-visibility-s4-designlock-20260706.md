# Multitable AI cost visibility — pre-run estimate surface + per-field cost dimension — S4 DESIGN LOCK (PROPOSED)

- **Status**: PROPOSED — awaiting owner ratification. Docs-only; no runtime ships here.
- **Slice**: S4 of the AI-fields governance arc (`docs/development/multitable-ai-write-provenance-batch-grouping-s1-designlock-20260705.md` §8: "cost visibility polish — estimate UI + per-field/per-run usage dimensions"). Grounded on origin/main.
- **What S4 is NOT**: not new accounting (reserve-then-settle charge machinery is untouched); not a new billing system; not a ledger-schema change; not the DARK→GA lighting decision (owner's); not S3/S5. **Per-RUN cost is explicitly SPLIT OUT to a gated S4b — see §4 — because the ledger has no run key today** (a migration, not a visibility slice).

## §1 Problem (verified at line level)

The AI cost MACHINERY is already built; the gap is purely on the READ/SURFACE side.

1. **The ledger already records the dimensions S4 needs (except run).** `multitable_ai_usage_ledger` rows carry `subject_key, user_id, sheet_id, field_id, record_id, action, provider, model, prompt_tokens, completion_tokens, estimated_cost_usd, status, duration_ms, error` (`ai-usage-ledger.ts:120-121`). `field_id` is **populated** on every shortcut/bulk write (`ai-bulk-shared.ts:105` threads `ctx.fieldId` into the settle), and `estimated_cost_usd` is per-row. So **"how much did THIS field's AI shortcut cost" is answerable today by `GROUP BY field_id` — no schema change.**
2. **A pre-run estimate is already COMPUTED but not SURFACED.** `conservativePromptTokenEstimate` / the `n()` token estimator exist and are already used server-side for the quota pre-check (`multitable-ai.ts`: `perRowEstTokens = n('') + pre.caps.maxOutputTokens`). The user never sees "this bulk run will cost ≈ N tokens / $X" **before** spending.
3. **The read surface is thin and unbuilt on the FE.** `GET /ai/usage-summary` (`multitable-ai.ts:237`, `requireAdminRole`-gated, per-caller subject-keyed) returns only aggregate windows `{callerDayTokens, callerWeekTokens, instanceDayUsd, caps}` — no per-field breakdown, no estimate. The FE `AiUsageSummary` type (`apps/web/src/multitable/api/client.ts:1309`) mirrors exactly those four; **grep finds zero FE consumers of usage-summary** — the cost surface is genuinely unbuilt.
4. **The ledger has NO run key.** No `run_id`/`jobId` column; ledger rows are not tagged with the bulk operation's runId (that key lives only in `multitable_ai_bulk_preview_cache` / the job tables, not joined to the ledger). So "how much did THIS run cost" is **not** answerable without a schema add → out of a pure-visibility slice (§4).

## §2 LOCK-C — what gets surfaced

- **C1 (pre-run estimate)**: the bulk-preview response gains a values-free `estimate: { estTokens, estCostUsd, rowCount }` block, derived from the SAME `n()`/caps math the quota pre-check already runs (no new estimator). The FE shows it before the confirm-to-run step so an admin sees the projected bill before spending. Estimate only — never billed from; the settle path is unchanged.
- **C2 (per-field cost dimension)**: `GET /ai/usage-summary` gains an optional `byField?: Array<{ fieldId, tokens, costUsd, count }>` derived by `GROUP BY field_id` over the caller's ledger rows (or admin scope, C3). No new table, no new column — a new aggregate query over existing columns. The FE renders it as a per-field cost list in the (new) usage surface.
- **C3 (values-free)**: every number is an aggregate (token counts, USD, row counts); NO prompt text, NO field values, NO record data on any surface. `fieldId` is a config identifier (not record data) and only its aggregate cost is shown; the field's own NAME resolves client-side via the label cache the config-history surface already uses (raw id fallback), no new resolution.
- **C4 (unchanged accounting)**: reserve-then-settle, the caps, the double-confirm gate (`MULTITABLE_AI_CONFIRM_LIVE_REQUESTS`) — all untouched. S4 reads the ledger and surfaces the estimator; it writes nothing and decides no policy.

## §3 Permission posture

`/ai/usage-summary` is `requireAdminRole`-gated today; C2's `byField` rides that SAME gate (aggregate cost is an admin/ops view, consistent with the existing summary). **Decision: keep the admin gate — do NOT split per-field cost onto `canManageFields`.** Rationale: the route already aggregates the caller's spend admin-only; per-field is a finer cut of the same admin-scoped data, and inventing a second gate would fragment a coherent admin cost view for no security gain (the numbers are values-free aggregates, not field config or record data). The pre-run estimate (C1) rides whatever gate the bulk-preview route already enforces (unchanged).

## §4 Non-goals / explicit split

- **Per-RUN cost → gated S4b (needs a migration, NOT this slice).** Surfacing "cost of THIS run/job" requires tagging ledger rows with the bulk op's `run_id`/`jobId` (a new nullable column + populating it at settle) so cost can be `GROUP BY run_id`. That is a schema change, not a visibility slice — it gets its own gated design-lock (S4b) with its migration + backfill posture. S4 deliberately ships per-FIELD (no-schema) and the pre-run estimate only; a golden (GS6) pins that S4 surfaces only ledger-recorded dimensions and invents no per-run split.
- No charge-accounting change; no new billing; no cap-policy change; not DARK→GA; not S3/S5.

## §5 Golden matrix (read/render; real-DB where it touches the ledger)

| # | Scenario | Locked outcome |
| --- | --- | --- |
| GS1 | bulk-preview of N rows | response carries `estimate {estTokens, estCostUsd, rowCount}` matching the `n()`/caps math; values-free (no prompt/field text) |
| GS2 | ledger has settled rows across 3 fields | `usage-summary.byField` returns exactly 3 entries with per-field token/cost/count = `GROUP BY field_id` truth |
| GS3 | a sheet-scoped (field_id NULL) suggest-formula row exists | it is NOT attributed to any field's per-field bucket (NULL field_id excluded from `byField`, surfaced only in the aggregate windows) |
| GS4 | non-admin calls `/ai/usage-summary` | 403 (admin gate holds for `byField` too) |
| GS5 (values-free) | any cost surface | rendered DOM/response contains only numbers + fieldId; never prompt text, field values, or record data |
| GS6 (scope guard) | per-run cost is requested/implied | NOT provided by S4 — the response has no run dimension; documents S4b as the gated owner of it (proves S4 invents no per-run split over a runless ledger) |

## §6 Rollout

No new env flag, no migration, no schema change, no charge-path change. Runtime touch points when implemented (separate PR after ratification): the bulk-preview response (add `estimate`), the `/ai/usage-summary` route (add `byField` aggregate), the FE `AiUsageSummary` type + a usage/cost render surface + its render tests. Admin-gated, values-free, read-only over existing data.

## §7 Arc placement

- ✅ **S1** write provenance + batch grouping — merged
- ✅ **S2** prompt-config-history UI — merged
- 🔒 **S1b** true history-batch rollback
- 🔒 **S3** staleness lineage (design-first)
- ⬜ **S4** cost visibility — pre-run estimate + per-field dimension (no-schema) — **this lock**
- 🔒 **S4b** per-run cost dimension (needs a `run_id` ledger column — migration; split out of S4)
- 🔒 **S5** normalize kind (+ classify→select rider)
