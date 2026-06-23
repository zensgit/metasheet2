# Multitable AI bulk / whole-column fill + review-before-write — development & verification — 2026-06-22

> Closure record for the **B-0 → B-3 arc**. All four rings are merged on `main`; the feature is end-to-end
> usable (preview → review → confirm → commit). B-4 (async at scale) is the design-lock's deferred ring — see §7.

## 1. The arc (all merged)

| Ring | PR | Squash commit | Delivered |
|---|---|---|---|
| **B-0** design-lock | #3019 | `85891cd60` | Ratified design D1–D6 (decisions below). |
| **B-1** bulk-preview backend | #3029 | `96763a0bd` | Generate **+ charge + exact persistent cache** per provider-bound row. |
| **B-2** bulk-commit backend | #3041 | `ba01dd774` | **Actor-owned** cache commit + re-gate + stale-drop + per-row partial outcomes. |
| **B-3** review-before-write UI | #3053 | `659952381` | Trigger → **truthful** diff table → confirm → outcome summary. |

## 2. What it does (data flow)

1. **Trigger** — on a field carrying a persisted `aiShortcut` config (kind ∈ summarize/classify/extract/translate),
   the user starts an "AI fill" over the current **view** (server-resolved full filtered set) or a selection.
2. **Preview** (`POST /sheets/:id/ai/shortcut/bulk-preview`) — for each provider-bound row, generates the proposed
   value, **charges** the per-tenant usage ledger, and writes the output to a **persistent run cache**
   (`ai_bulk_preview_cache`). Returns the per-row diff (current → proposed) + the non-writable groups.
3. **Review** — the dialog shows the truthful per-row diff and the distinct states; the user confirms which rows.
4. **Commit** (`POST /sheets/:id/ai/shortcut/bulk-commit`) — writes the **cached** values for the confirmed rows
   through the authoritative `patchRecords` path (Yjs-invalidating). **No provider call, no ledger write** at
   commit — the charge already settled at preview.

Built ON the shipped per-record `aiShortcut` pipeline (same gates, prompt templates, `ai-provider-client`
reserve-then-settle, usage ledger, `patchRecords`) — bulk added orchestration, not a second AI subsystem.

## 3. Locked invariants (D1–D6 + review hardening)

- **Charge-on-generation, never released** — a provider-*called* row is charged once at preview and stays
  charged (un-confirm / stale / write-conflict do NOT release it; closes the preview-abandon quota bypass). Only
  provider-*never-reached* rows are uncharged: `skipped_no_perm` / over-cap / rate-limited-before-call /
  `generation_failed_before_usage`.
- **Per-row gates BEFORE cap/quota** — read+write gates build the provider-bound set first; read-denied rows are
  omitted (no hidden-row oracle via `error.total`/400/429), not-writable rows are `skipped_no_perm` (uncounted).
  D3 cap (`MULTITABLE_AI_BULK_MAX_ROWS`, default 200 → `400 BULK_SCOPE_TOO_LARGE`) and D4 quota run on that set.
- **Scope = server-resolved view filter** — full filtered+sorted set, not the loaded page (the #3010 export
  semantic). A selectable **computed** (lookup/rollup/formula) filter → `422 AI_BULK_VIEW_FILTER_UNSUPPORTED`
  (never match-all → never generates for rows outside the view).
- **Cache stores the EXACT previewed value** — no redaction; preview == cache == committed value == the per-record
  write path. "Confirm what you see is what's written."
- **Per-actor cache ownership** — only the actor who previewed (whose source-read perms generated the output) may
  commit it; a different actor → `not_in_cache` (no cross-actor read leak via a committed value).
- **Anti-TOCTOU stale-drop** — commit rides the **cached** `previewVersion` as `expectedVersion`; a row changed
  since preview → `stale_reprev`, dropped, never written over shifted data.
- **Re-gate at commit** — perms can change after preview; each row re-passes record-read + sheet-write +
  field-permission + row-policy; a now-unwritable row → `skipped_no_perm`; a locked record → `write_conflict`.
- **Charged-but-not-confirmable is explicit** — `failures[]` (provider errored *with* usage, or cache-write
  failed) is charged, never cached, never a writable row, distinct from uncharged `skipped[]`.
- **Truthful per-row status (UI)** — the diff "current value" is the **server-returned** `currentValue` (real per
  row, never grid-page dependent); only confirmable rows are selectable; masked / skipped / failures(charged) /
  `stale_reprev`(re-preview) / partial outcomes are each shown distinctly; cost honesty ("preview consumes quota").

## 4. Verification — adversarial review rounds (the findings caught & fixed)

The arc was hardened through owner review; every finding became a regression golden:

- **B-1:** (a) `charged && !result.ok` and swallowed cache-insert failure were returned as writable rows →
  fixed to charged-failure outcomes (`provider_error_charged`, `cache_failed_after_generation`), fail-closed;
  (b) cap/quota computed on the **raw** candidate count (hidden-row oracle + false-block) → moved gates BEFORE
  cap/quota; (c) computed filter treated as match-all (out-of-view generation) → `422`; (d) cache stored a
  **redacted** value while the preview showed raw (overwrite-mismatch) → store exact.
- **B-2:** cache filter checked only sheet+TTL, not `actorId` → a same-sheet user with `canEditRecord` + the
  runId could commit another actor's output (cross-actor read leak) → **owner gate** (fail-closed `not_in_cache`).
- **B-3:** full-view preview resolved the "current value" from the loaded grid page → off-page rows showed a
  **false "(empty)"** (approve-overwrite-under-a-false-diff) → the preview API now returns the real per-row
  `currentValue`; the grid-page resolution removed.

## 5. Test evidence (all CI-green)

- **B-1 preview** — real-DB golden suite (`multitable-ai-bulk-preview.test.ts`, registered in `plugin-tests.yml`):
  mixed-permission leak gate · charge-on-generation (provider-called booked; skipped/over-cap/no-usage book
  nothing; ledger delta == calls) · over-cap 400 · quota-insufficient refuse-zero · run-cache shape · view-scope ·
  computed-filter 422 · read-denied-over-cap no-400 · unwritable-not-counted-in-quota · cache-exact (sk-token
  survives verbatim) · currentValue truthful (real target value; empty → null) · `DATABASE_URL` sentinel
  (prevents silent skip). Zero real provider calls (fetch-spy).
- **B-2 commit** — real-DB golden suite (`multitable-ai-bulk-commit.test.ts`): commit-only-cached ·
  never-commit-`failures[]` (not_in_cache) · `expectedVersion` stale-drop · abandon-no-release (token-sum
  unchanged) · partial-success · re-gate (no-perm / read-deny / field-readonly / locked→write_conflict) · TTL →
  not_in_cache · **cross-actor owner gate** (ACTOR_B → not_in_cache, field unchanged).
- **B-3 UI** — 33 FE specs (`meta-ai-bulk-labels` + `multitable-ai-bulk-fill-composable` + `…-dialog`):
  state-machine (only confirmable rows selectable) · mixed preview rendering (masked/skipped/failures distinct) ·
  mixed commit outcomes + counts · wire-shape pins (incl. `currentValue`) · 429/quota/blocked surfaced.
- **Structural guards** green throughout (egress-coverage / stored-data-taint-chokepoint / record-lock /
  raw-record-data-projection); no GOLDEN regressions — bulk delegates to `patchRecords` and adds no raw-write
  or new egress sink.
- **i18n** strict-zero: UI strings via `meta-ai-bulk-labels.ts` + `aiBulkErrorMessage` in the error-labels module,
  no helper redeclaration.

## 6. Process note (merge mechanics, worth keeping)

Against a hyperactive `main` with strict require-up-to-date branch protection, **`gh pr update-branch` +
native auto-merge** is the reliable path: it merges `main` in via a *normal* push (which reliably re-triggers the
check-suite **and** makes the branch up-to-date), then auto-merge lands it on green. Repeated rebases force-push,
which here did **not** reliably re-trigger CI (the suite went un-created → "N of N required checks expected"), and
`--admin` does **not** bypass require-up-to-date when behind. A single normal append-commit re-triggers a stuck
suite. (Several cycles were lost to this before switching strategy.)

## 7. Deferred / next

- **B-4 — async job + progress (design-lock D3-B, 🔒 deferred).** v1 is synchronous with a hard `MAX_ROWS=200`
  cap, so a true whole-column fill on a large table (>200 rows) currently returns `BULK_SCOPE_TOO_LARGE`. B-4
  (a job table + progress endpoint + cancellation + a FE progress surface) lifts that. It is a new subsystem with
  real lifecycle/charge-accounting/cancellation decisions, so the disciplined next step is a **B-4 design-lock**
  before code (per design-lock-first), then a separate opt-in.
- Minor follow-ups (non-blocking): a column-header trigger for greater discoverability; a distinct-values picker
  for non-option classify targets; surfacing partial-batch resume after `stale_reprev`.

## 8. Status

**v1 AI bulk / whole-column fill + review-before-write is COMPLETE, end-to-end, and verified** (B-0 → B-3 on
`main`). Within the 200-row cap it is the usable feature: generate-with-cost-visibility → truthful review →
confirm → safe commit, with per-actor isolation, anti-TOCTOU stale-drop, and no data-loss-under-false-diff path.
Scale beyond 200 rows is B-4 (deferred, design-lock-first).
