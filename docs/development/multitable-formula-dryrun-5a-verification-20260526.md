# Multitable Formula Dry-Run #5a — Backend Verification (2026-05-26)

Implements the locked design `docs/development/multitable-formula-dryrun-design-20260526.md` (#1860).
benchmark v2 §9 **#5a** (backend). Backend-only; frontend is #5b (separate opt-in). **Additive-only — the shared `formula/engine.ts` is untouched.**

> K3: multitable kernel-polish; no shared formula core / attendance / rbac / integration-core change. K3 yields.

---

## 1. What shipped

**`packages/core-backend/src/multitable/formula-engine.ts`** (the EDITABLE wrapper; shared core untouched):
- `dryRun(expression, sampleValues, fields) → DryRunResult` — pre-eval gates → eval → classify.
- `detectUnsupportedReferences(expression)` — best-effort A1/cell + `A1:B3` range detector (masks `{fld}` refs and string literals; ignores function calls like `LOG10(`).
- Exported types `DryRunResult` / `DryRunDiagnostic`.

**`packages/core-backend/src/routes/univer-meta.ts`**:
- `POST /sheets/:sheetId/formula/dry-run` — `400` (missing expr) → structural caps (`413`/`422`) → sheet 404 → **`canManageFields` 403** → ref-count cap → load fields → `dryRunFormulaEngine.dryRun(...)` → `{ ok, data }`.
- `dryRunFormulaEngine` = `new MultitableFormulaEngine(new FormulaEngine({ db: <throwing no-DB stub> }))` — the **hard backstop**.

**`.github/workflows/plugin-tests.yml`**: added `multitable-formula-dryrun.test.ts` to the dedicated real-DB step (else it would silently skip — the general integration step has no `DATABASE_URL`).

## 2. Locked constraints honored (design #1860)

| constraint | done |
|---|---|
| additive-only; shared `formula/engine.ts` untouched | only the multitable wrapper + a route changed |
| classify on what core exposes | Excel sentinels (`EXCEL_ERROR_SENTINELS`) + defensive `try/catch` → `runtime` diagnostic; no core codes added |
| **no DB access — enforced + proven** | A1/range pre-eval reject **+** no-DB engine backstop; **unit test asserts DB-query-spy = 0** for a `{fld}`-only dry-run |
| pre-eval gate (a) reference existence | unknown `{fld}` → `unknown_field` error, **not evaluated** (no `undefined→0` false-green) |
| pre-eval gate (b) A1/range unsupported | `detectUnsupportedReferences` → `unsupported` error, not evaluated; **not** a blanket block of VLOOKUP/HLOOKUP/INDEX/MATCH |
| no silent coercion | type-mismatch → `warning`; missing sample → `info` |
| capability gate = `canManageFields` | mirrors the field-create route |
| structural caps, no hard timeout | expression length (`413`), referenced-field count + paren/bracket depth (`422`); no in-process timeout |
| ad-hoc POST, nothing persisted; `200` on success:false | body carries unsaved expr; runtime error is a successful dry-run that found a problem |

## 3. Verification

- **Unit (no DB, default `test` step): `tests/unit/formula-dryrun.test.ts` 9/9** (run locally, green) — valid `{fld}` eval, string passthrough, `#DIV/0!` sentinel→runtime error, unknown-field gate (not evaluated), A1/range gate (not evaluated), type-mismatch warning, missing-sample info, **NO-DB spy = 0**, plus `detectUnsupportedReferences` cases.
- **Integration (CI real-DB step): `tests/integration/multitable-formula-dryrun.test.ts` 8/8** (CI-confirmed ran, not skipped) — happy path (`={a}+{b}`→5), unknown-field 200/success:false, **`canManageFields` 403**, missing-expr 400, over-long-expr **413** `DRYRUN_EXPRESSION_TOO_LONG`, nesting>32 **422** `DRYRUN_TOO_DEEP`, ref-count>64 **422** `DRYRUN_TOO_MANY_REFS`. Added to `plugin-tests.yml` real-DB step.
- Backend `tsc` clean. No frontend touched (that's #5b).
- **Note:** the `dryRun` `THROWN` runtime-diagnostic branch is **defensive-only** — `engine.calculate()` wraps all parse/eval throws into `'#ERROR!'` (engine.ts:250-252), so `evaluateField` never throws today; the catch guards against future engine changes (commented as such).

## 4. Deferred

- **#5b** frontend "Test with sample data" panel in `MetaFieldManager` (separate opt-in).
- **#5c** evaluate against a real record (demand-gated — D3c surface).
- A1/range/cross-table evaluation; hard wall-clock timeout (needs worker isolation).
