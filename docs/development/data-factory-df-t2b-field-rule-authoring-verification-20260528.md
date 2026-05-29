# DF-T2b — per-field replace/preserve authoring UI (verification, 2026-05-28)

Second DF-T2 implementation slice (design #2017; builds on DF-T2a derive #2023). A **frontend
authoring component** that edits a DF-T2a draft `fieldRules` set and **emits** the result. No K3
write, **no preview wire** (that is DF-T2c), no backend call at all. Leave for review.

## What shipped

- `apps/web/src/components/integration/MetaIntegrationFieldRuleAuthoring.vue` — per-field row with
  a **replace / preserve** control; `v-model:modelValue` in/out (`IntegrationFieldRule[]`),
  optional `gatedFields`. Emits `update:modelValue` on each edit. **No backend call.**
- `apps/web/src/services/integration/workbench.ts` — typed `IntegrationFieldRule` +
  `fieldRuleEditability(rule, gatedFields)` + pure `setFieldRuleReplace` / `setFieldRulePreserve`.

## Behaviour (owner-locked scope)

- **scalar** field → editable: toggle **replace** (`from_staging` + a `sourceField` staging-column
  input) ↔ **preserve** (`preserve_template`); shape stays `scalar`.
- **reference** field → **locked to `preserve_template`**, rendered as a locked label + hint, with
  **no editable control** — there is no UI path to downgrade it to a scalar replace in v1.
- **gated** field (e.g. `FBaseUnitID`) → **locked everywhere**: the dedicated gated section lists it,
  and (P2 review fix) a gated rule that appears in `modelValue` renders as a **locked label row**, not
  an editable-looking `<select>`; **emits no rule** either way.

## Key decisions

- **Lock predicate = `shape !== 'scalar'`, NOT `sourceType`.** DF-T2a encodes a reference as *both*
  `sourceType: 'preserve_template'` *and* `shape: 'object-passthrough'`. `sourceType` is the
  editable **mode** (a *scalar* may also be `preserve_template` once the operator preserves it), so
  it cannot be the lock signal; the durable **reference identity is the shape** (which T2a sets to
  `object-passthrough`/`by-*` for object values). Keying on shape keeps a preserved-scalar editable
  and a reference locked — and agrees with T2a's reference encoding. (Cross-file-predicate-drift
  guard, per the T1A lesson.)
- **No `payloadTemplate` prop / no customer values in the DOM.** The component works only from the
  rules (`targetField` + `sourceType` + `shape`) + `gatedFields`; it never holds the live customer
  object, so no operator-local reference values reach the DOM/screenshots (the DF-T2 redaction
  boundary, upheld at the UI layer).
- **No wire.** The component imports only the pure helpers; it makes no `apiFetch`/preview/K3 call.
  Feeding it a real derived draft + wiring the DF-T1 preview is **DF-T2c** (with a wire-vs-fixture
  reachability test, per the #1968 lesson).

## Tests (`apps/web/tests/MetaIntegrationFieldRuleAuthoring.spec.ts`, 6/6 green; vue-tsc clean)

- **Helper**: scalar editable · non-scalar (reference) shape locked (`reason: 'reference'`) ·
  gated locked · a preserved-scalar stays editable (lock keys on shape) · setters keep `shape:'scalar'`
  and flip only the mode.
- **Component**: renders a row per rule + a locked gated section (no customer values) · scalar
  toggles preserve→replace and edits `sourceField` (emits each time) · **a REFERENCE field is locked
  to preserve — its mode element is a locked span, not a `<select>`, and there is no `sourceField`
  input** (the v1 no-downgrade rule) · **a GATED field present in `modelValue`** (scalar-shaped +
  `gatedFields=['FBaseUnitID']`) renders a locked label — no `<select>`, no `sourceField` input, no
  emit (P2 review fix). **Negative-controlled (both)**: disabling the reference lock fails the
  reference assertions; reverting the gated-render fix (`reason==='reference'`-only `v-if`) fails the
  gated assertion. 7/7 green.

## Boundaries (held)

Frontend-only authoring component; no K3 write; no preview/backend wire (DF-T2c); reference fields
preserve-only (#1824); gated fields locked; no Submit/Audit/BOM/multi-record. Not yet mounted into
`IntegrationWorkbenchView` — wiring + a real derived-draft source + the preview round-trip are DF-T2c.

## Files

- `apps/web/src/components/integration/MetaIntegrationFieldRuleAuthoring.vue` (new)
- `apps/web/src/services/integration/workbench.ts` (+ `IntegrationFieldRule`, `fieldRuleEditability`,
  `setFieldRuleReplace`, `setFieldRulePreserve`)
- `apps/web/tests/MetaIntegrationFieldRuleAuthoring.spec.ts` (new)
