# Multitable Formula Dry-Run #5b — Frontend Panel Verification (2026-05-26)

Implements the locked design `docs/development/multitable-formula-dryrun-5b-design-20260526.md` (#1869), i18n decision **(a) structured context** (user-confirmed). benchmark v2 §9 #5b. Backend step-0 (structured context) → frontend panel.

> K3: multitable kernel-polish (the multitable wrapper + `apps/web/multitable` + 2 existing label modules). Shared formula core untouched. K3 yields.

---

## 1. What shipped

**Backend step-0** (`multitable/formula-engine.ts`, additive — shared core untouched):
- `DryRunDiagnostic` gains structured context: `fieldId?`, `expectedType?`, `actualType?`. Populated for `unknown_field` (fieldId), `missing_sample` (fieldId), `type_mismatch` (fieldId/expectedType/actualType). `message` is now explicitly English-for-logs-only.

**Frontend** (`apps/web/src/multitable`):
- `client.dryRunFormula({ sheetId, expression, sampleValues })` → `DryRunResult` (mirrors `aggregateView`; `DryRunResult`/`DryRunDiagnostic` types).
- `meta-formula-labels.ts` — `localizeDryRunDiagnostic(diagnostic, isZh)`: localized templates per `kind` (+ `code` sentinel passthrough), interpolating structured context; **NEVER renders `message`**; unknown `kind` → localized generic fallback (raw `kind` token).
- `meta-manager-labels.ts` — `field.formulaDryRun.*` panel chrome (button/headings/error labels), EN+ZH.
- `MetaFieldManager.vue` — the dry-run panel in the formula config block (gated on a `dryRunFn` prop, wired by the workbench to `client.dryRunFormula`).

## 2. The 4 contracts (design #1869) — as built

| contract | implementation |
|---|---|
| **C1** sample defaults + serialization | inputs from the **existing `extractFormulaFieldRefs`, INTERSECTED with `formulaSourceFields`** (unknown refs are owned by the static diagnostics, no confusing sample rows); one type-appropriate input per ref, empty + type-hint placeholder; payload **omits empty** (→ `missing_sample`), `Number(value)` for numeric (string-coercion-safe; `type="number"` v-model can yield a number), **`boolean`→true/false**, else string; **invalid numeric input disables Evaluate** with a local hint. **Ephemeral:** `resetDryRunState()` (in `resetDrafts`) clears samples + result on close/reopen, so a reopened field never pre-fills last time's values. |
| **C2** trigger | explicit **Evaluate button only**; enabled iff non-empty + no static error + no invalid-numeric + not running + fn wired; `dryRunSeq` monotonic guard; **expression edit clears the result, invalidates in-flight, AND clears `running`** (so a superseded request can't leave the button stuck disabled). |
| **C3** diagnostic priority | **separate dry-run result zone** (distinct from the static-diagnostics list); success → value + diagnostics, failure → error heading + sentinel `code` tag; Zone B sorted **error > warning > info**. |
| **C4** layering | dry-run is **purely informational**; `fieldConfigBlockingReason` / save untouched — a `runtime`/`type_mismatch` does **not** block save. |
| i18n | localize by `kind`/`code`; client **never** renders the server `message` (strict-zero). |

## 3. Verification

- **Backend unit (no DB): `tests/unit/formula-dryrun.test.ts` 9/9** — incl. **structured-field assertions** (`unknown_field.fieldId`, `missing_sample.fieldId`, `type_mismatch.fieldId/.expectedType/.actualType`) + the no-DB spy = 0.
- **Backend integration (CI real-DB): `multitable-formula-dryrun.test.ts`** — +1 case asserting `type_mismatch` carries `fieldId/expectedType/actualType` over the wire; unknown-field asserts `fieldId`. (Mechanizes the i18n contract per design §5.)
- **Frontend: `tests/multitable-formula-dryrun-panel.spec.ts` 7/7** — (1) localized diagnostics, **never the raw server message**; (2) **both serialization branches** — numeric `3.5`→Number, text `'hello'`→string; (3) **stale response dropped AND the button recovers** (re-enabled + second Evaluate fires); (4) **dry-run error does NOT disable Save**; (5) **boolean sample → `true`/`false`, not `"true"`**; (6) **sample values cleared on reopen** (ephemeral, C1); (7) localizer unknown-kind fallback never returns `message`.
- Backend `tsc` + frontend `vue-tsc` clean; existing formula-editor + field-manager specs green (no regression).

## 4. Deferred (unchanged)
- **#5c** evaluate against a real record — demand-gated (D3c surface).
- Sample-value persistence — deferred (data-shape question, no signal).
