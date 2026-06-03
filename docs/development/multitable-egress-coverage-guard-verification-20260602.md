# Egress-coverage guard — verification (field-read-gate §3 forward-defense)

**What:** `packages/core-backend/tests/unit/multitable-egress-coverage-guard.test.ts` — the §3 Layer-3 forward-defense of the multitable field-read-gate arc (tracker `multitable-field-read-gate-tracker-20260602.md`). **Date:** 2026-06-02 · **Type:** optional hardening (no open leak). **Decision:** snapshot **change gate** now; compile-time `AllowedFieldIds` branded type **deferred** to its own PR.

## Why a change gate (and not the branded type, yet)
The arc is 12/12 closed — this is preventive hardening, so the bar for touching the security-critical files is high. The compile-time **`AllowedFieldIds` branded type** is the stronger design (it makes passing a layer-2-only set a *compile error* — it **verifies** gating, which a snapshot cannot), but it threads through ~30 mask call-sites in `univer-meta.ts` + `record-write-service.ts` + the `RecordWriteHelpers` interface — a large review/regression surface in the exact files the arc has been carefully editing. **Decision (owner):** land the low-risk change gate now; defer the branded type to its own design-lock + `tsc`-guided refactor PR (tracker §4 item 3), to be done only on a future large egress/mask refactor or if the change gate catches repeated same-class risk — never folded into other egress work.

## What the guard does
A plain unit test (no DB, always-on in the core-backend `test` step — the `exclude`-based `vitest.config.ts` picks up any new `tests/unit/*.test.ts`). It walks `src/` and counts call-sites of the record-data egress/mask helpers — `filterRecordDataByFieldIds`, `loadRecordSummaries`, `buildLinkSummaries`, `serializeLinkSummaryMap`, `filterRecordFieldSummaryMap`, `filterSingleRecordFieldSummaryMap` — as `{ file → { helper → count } }`, and compares to a checked-in **GOLDEN**. A new/removed call-site changes the count → **RED**, with the file:line of the changed sites + the directive:

> route the new egress through the layer-2 ∧ layer-3 `allowedFieldIds` composite, add a real-DB locking test in `plugin-tests.yml`, update tracker §2, THEN update GOLDEN.

So a new ungated egress cannot land silently — it trips review by construction (the GOLDEN-update is the review gate). Per the advisor's must-gets: **count per (file × helper)** (catches a new site even if it reuses an existing arg-name — the hole a pure arg-name set would have), **whole-`src` scan** (catches egress in a *new* file), **plain always-on unit test** (not the real-DB step), **failure prints sites + directive**.

## Documented gaps (a green here is NOT "egress is gated")
Stated loudly in the test header AND tracker §3:
1. **It does not verify gating.** The masks take a `Set<string>`; whether it's actually layer-2∧3 (vs a layer-2-only leak) is a by-VALUE property no static scan can check — proven only by each channel's **real-DB locking test** (tracker §2). (The branded type would close this; deferred.)
2. **It only tracks the known helpers.** A handler shipping raw `record.data` without one of them (e.g. `res.json({ data: row.data })`) is invisible here — that residual stays on the §3 manual re-scan trigger. (A noisy raw-`.data` scan was deliberately not built.)

## Evidence
- **GREEN** with the registered GOLDEN (the egress surface as of `origin/main`): `record-write-service.ts` {filterRecordDataByFieldIds 3, buildLinkSummaries 1, serializeLinkSummaryMap 1, filterRecordFieldSummaryMap 2}; `routes/univer-meta.ts` {filterRecordDataByFieldIds 13, loadRecordSummaries 3, buildLinkSummaries 4, serializeLinkSummaryMap 1, filterRecordFieldSummaryMap 2, filterSingleRecordFieldSummaryMap 5}.
- **Prove-trip:** adding a new file `src/_egress_guard_probe.ts` with a single `filterRecordDataByFieldIds(...)` call → **RED** (`_egress_guard_probe.ts → filterRecordDataByFieldIds: registered 0, found 1 (now at _egress_guard_probe.ts:1)`) — confirms the whole-`src` scan catches a new egress in a *new* file. Removing it → **GREEN**.
- `tsc` (core-backend) — exit 0. No production code touched (test-only).

## Scope
Test-only; zero change to `univer-meta.ts` / `record-write-service.ts` / any mask. The field-read-gate arc remains 12/12; this adds the §3 change gate on top.
