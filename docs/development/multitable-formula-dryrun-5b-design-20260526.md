# Multitable Formula Dry-Run #5b — Frontend Panel Scout + Design (2026-05-26)

**Status: docs-only scout/design. No implementation in this slice.**
benchmark v2 §9 **#5b** — the UI that calls the #5a backend (`POST /sheets/:sheetId/formula/dry-run`, merged #1865) so a user can evaluate an unsaved formula against test data inside the field editor. Successor to design #1860 / backend #1865. Mirrors the #1860 template.

> K3: multitable kernel-polish (frontend `apps/web/src/multitable` + label modules). Shared formula core untouched. K3 yields.

The panel is small; its **contract surface is not**. This doc locks the 4 interaction contracts so the clean #5a backend doesn't become frontend noise.

---

## 1. Scout findings (ground truth, 2026-05-26)

| # | finding | source |
|---|---|---|
| Entry point | Formula field editor lives in `MetaFieldManager.vue`, the `configTargetType === 'formula'` block: expression `<textarea v-model="formulaDraft.expression">`, a static-diagnostics list, field-token chips, function catalog. | `MetaFieldManager.vue:161-231` |
| Static diagnostics (existing) | `formulaDiagnostics = computed(() => validateFormulaExpression(expr, formulaSourceFields, isZh))` — **per-keystroke, client-side, no eval**; rendered with `--{severity}` classes. | `MetaFieldManager.vue:638-640,166-174` |
| Save gate (existing) | Save button `:disabled="Boolean(fieldConfigBlockingReason)"`; blocking reason set from the first **error-severity static diagnostic** (`MetaFieldManager.vue:1048-1050`). | `MetaFieldManager.vue:342,1048` |
| Referenced fields | `formulaSourceFields` (available fields) drives the insert-chips; client has the field list + names + types already. | `MetaFieldManager.vue:631` |
| Label modules (both EXISTING — extend, don't create) | UI chrome via `ml(key)` = `managerLabel` (**meta-manager-labels**, `field.*`); diagnostic text via **meta-formula-labels** (`FormulaDiagnosticLabelKey`, `diagnostic.*`). | `MetaFieldManager.vue:552`; `meta-formula-labels.ts:16-25,119-128` |
| Backend response shape (#5a) | `{ ok, data: { success, result?, resultType?, referencedFields, diagnostics: [{ severity, kind, code?, message }] } }`; `200` even on `success:false`; `403`/`413`/`422` are transport errors. `kind ∈ unknown_field|unsupported|runtime|type_mismatch|missing_sample`; `code` = Excel sentinel for runtime. | `formula-engine.ts dryRun`; `univer-meta.ts` route |
| Client pattern to mirror | `client.aggregateView(...)` + `MultitableApiError` (`.status`/`.code`) for non-2xx; workbench used a monotonic `reqSeq` guard. | `api/client.ts aggregateView` |

**Consequence:** #5a returns *structured* diagnostics with an English `message`. Under the multitable **strict-zero i18n** discipline, the UI must render **localized** text (by `kind`/`code`), not the server's English — which forces a decision about how localized templates get their context (§3).

---

## 2. The four interaction contracts (the core of #5b)

### C1 — Sample-value defaults + payload serialization (LOCKED)
- Referenced fields come from **the existing `extractFormulaFieldRefs(expression)`** (`formula-docs.ts:612`, already used by `validateFormulaExpression`), intersected with `formulaSourceFields` for names/types. **Reuse it — do not write a mirror helper**, so the sample-input field list can't drift from what the static diagnostics consider referenced.
- Render **one type-appropriate input per referenced field** (number input for number/currency/…, text otherwise).
- **Default = empty, with a type-hint placeholder.** Do **not** auto-fill fabricated data — a fake `0`/`""` would produce a confident-looking but meaningless result. An empty input → the server's `missing_sample` info ("treated as empty"), which is the honest signal.
- **Payload serialization (LOCKED — HTML inputs yield strings):** when building `sampleValues`, **omit empty inputs** (so they become `missing_sample`, not a coerced value); for a numeric-typed field, send `Number(value)` for a valid number and **block Evaluate with a local hint** for an unparseable numeric input (don't ship a string `"3"` to a number field and rely on the server's `type_mismatch`); boolean → `boolean`; date/text → `string`. This keeps the sample payload typed, so `type_mismatch` only fires for genuine cross-type mistakes, not input-element artifacts.
- Sample values are **ephemeral** (not persisted; see §6 deferred).

### C2 — When dry-run is called (LOCKED: explicit button only)
- A single **"Evaluate / 试算" button**, never auto-run.
  - **Why (write it down — reviewers will want to relax it):** dry-run is the *eval-time truth*, not a typing aid. Auto-running on blur/keystroke turns it into per-mutation **server traffic** and re-creates exactly the per-keystroke noise the static layer already handles client-side.
- Button **enabled iff** expression is non-empty **AND** there is no `error`-severity **static** diagnostic (no point eval-ing a syntactically broken expression).
- **One in-flight request** via a monotonic `reqSeq` guard (mirror the agg-footer workbench); a stale response never overwrites a newer one.
- The result **resets** when the expression changes or the editor closes (it described a now-stale expression).

### C3 — Diagnostic presentation priority (LOCKED: two separate zones)
- **Zone A — static diagnostics** (existing, above the panel): unchanged, per-keystroke, drives the save gate.
- **Zone B — dry-run result** (new, appears after Evaluate):
  - success → the **result value + `resultType`** prominently; then any `warning`/`info` diagnostics.
  - failure → the **runtime error** (with the `code` sentinel shown as a tag, e.g. `#DIV/0!`) in place of a value.
  - diagnostics within Zone B sorted **error > warning > info**; deduped by `(kind, code)`.
- The two zones are **visually distinct and never merged** — static = "is it well-formed?", dry-run = "what does it actually produce?".

### C4 — Layering with static validation / the save gate (LOCKED: dry-run is purely informational)
- Dry-run **never affects the save gate.** `fieldConfigBlockingReason` stays **static-error-only**.
- A dry-run `runtime` error or `type_mismatch` warning does **NOT** block save — the formula can be perfectly valid; the *sample* was illustrative. (Coupling save to dry-run is the single most tempting wrong turn here; it's closed off by contract.)
- Dry-run adds no new save-blocking state of any kind.

---

## 3. i18n: localize by `kind`/`code` (the contextual-message decision)

The server diagnostics carry context inside the English `message` (`unknown_field` → the `{fld}` token; `type_mismatch` → field + types; `missing_sample` → field). Strict-zero i18n forbids rendering that English in the UI, but a `kind`-only label can't reproduce the context. Two ways to resolve it:

- **(a) Structured context (LOCKED — recommended).** #5a's `DryRunDiagnostic` gains optional structured fields (`fieldId?`, `expectedType?`, `actualType?`); the client renders **fully-localized templates** keyed by `kind` (+ `code` passthrough for the language-neutral Excel sentinels), interpolating the structured context. This is strict-zero-clean.
  - **The client NEVER renders the server `message` in the localized UI.** An unrecognized future `kind` falls back to a **localized generic diagnostic label** (at most showing the raw `kind`/`code` token, which is language-neutral) — never the English `message`. The server `message` is for **logs / debug / an EN-only context** only, so a new backend `kind` can never leak English into the zh UI.
  - Cost: a **small additive backend tweak** (structured fields on the diagnostic) as the first step of #5b — multitable-internal, shared core still untouched.
- **(b) Localized prefix + server message as detail (no backend change).** Client localizes the `kind` to a label and appends the server English `message` as context. Ships without touching #5a, but **renders English in a localized UI → violates strict-zero.**

This doc locks **(a)**: with 3 context-carrying kinds (`unknown_field`/`type_mismatch`/`missing_sample`), structured templating is justified and keeps the i18n bar. (Surfaced in §6 because it adds a backend step — the advisor leaned (b) to avoid that; strict-zero tips it to (a).)

- New label keys: diagnostic templates → **meta-formula-labels** (`diagnostic.dryRun.<kind>`); panel chrome (button, sample-values heading, result/error headings, sentinel tag) → **meta-manager-labels** (`field.formulaDryRun.*`). Both modules already exist (no new module — i18n discipline). EN + ZH, with interpolation for the structured context.

---

## 4. Client method + UI state machine

- **`client.dryRunFormula({ sheetId, expression, sampleValues })`** → `DryRunResult` (mirror `aggregateView`); non-2xx → `MultitableApiError` with `.status`/`.code` (`403` → localized "you can't manage fields here"; `413`/`422` cap codes → localized "expression too large/complex"). The `200`/`success:false` body is the normal diagnostic path.
- **State machine:** `idle` → (Evaluate) `running` → `result(success|failure)`; any expression edit → back to `idle` (clear result). `running` disables the button; `reqSeq` drops stale responses.

## 5. PR scope

- **#5b (this slice, on opt-in):** the dry-run panel in `MetaFieldManager` (C1–C4), `client.dryRunFormula`, label additions in the two existing modules, frontend tests. **Plus** the small additive backend diagnostic-context fields (§3a) as step 0.
  - **Backend tests for step 0 are mandatory (mechanize the i18n contract):** the #5a unit/route tests MUST assert the structured fields are populated — `unknown_field.fieldId`, `missing_sample.fieldId`, and `type_mismatch.fieldId`/`.expectedType`/`.actualType`. Without these assertions the client's localized templating has no machine-checked guarantee its inputs exist.
- **Out of scope:** real-record sampling (**#5c**, demand-gated — D3c surface); any save-gate coupling (C4); persisting sample values (§6); touching the shared formula core / attendance / rbac / integration-core.

## 6. Open questions for reviewer (decide before #5b impl opt-in)
1. **i18n approach — the key decision.** This doc locks **(a) structured context** (strict-zero-clean, + a small #5a-adjacent backend step). Confirm, or accept **(b)** (no backend change, but English in the localized UI). *(Advisor leaned (b); I lean (a) on the strict-zero rule — your call.)*
2. **Sample defaults** — empty inputs with type-hint placeholders (locked) vs pre-filling type defaults (`0`/`""`). Confirm empty-honest.
3. **Deferred (flagged, not planned):** persisting last-used sample values per field so reopening pre-fills — UX-tempting, but raises a data-shape question (view config? field property? localStorage?) not worth settling without a user signal. Defer until asked.
