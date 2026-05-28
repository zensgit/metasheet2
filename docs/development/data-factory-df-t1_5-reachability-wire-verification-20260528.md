# DF-T1.5 reachability wire — payload template preview wiring (verification, 2026-05-28)

Follow-up to #1968. #1968 rendered `targetPayloadPreview.fieldProvenance` but the UI only sent the
legacy preview request shape, so the panel was display-capable but **not live-triggerable** — a
wire-vs-fixture gap (the render test mocked a response the real request never produced). This wires
the request so the panel is reachable, and locks the missing request-body assertion.

## Change

- `apps/web/src/services/integration/workbench.ts`: `IntegrationTemplatePreviewRequest` gains
  optional `payloadTemplate` + `fieldRules` (legacy callers unchanged); new pure helper
  `deriveFieldRulesFromMappings` — each field mapping → a `from_staging` scalar rule **keyed by the
  TARGET field** (`sourceField = targetField`), carrying `required` when the mapping has a required
  validation.
- `plugins/plugin-integration-core/lib/http-routes.cjs` (**review P2 — transform alignment**): in the
  DF-T1 branch, when `fieldMappings` are supplied (the UI path) the preview now runs the SAME
  `transformRecord` the legacy pipeline runs and composes from the TRANSFORMED record (keyed by target
  field), surfacing `transformErrors`. So `from_staging` reads the transformed value and the DF-T1
  preview predicts the real Save body — not raw staging. It also runs `validateRecord` (non-required
  validations — min/max/regex — surfaced as `validationErrors`), with `required` stripped from those
  mappings because `required` is owned by the fieldRules (`missingRequiredFields`) — so both transform
  AND validation match the pipeline with no duplicate error entries. Callers that omit `fieldMappings`
  (operator runbook, target-shaped `sourceRecord`) keep reading raw and both error arrays stay []
  (shape B unchanged).
- `apps/web/src/views/IntegrationWorkbenchView.vue`: an optional `目标模板 JSON` textarea
  (`payloadTemplateText`); `previewPayload()` sends `payloadTemplate` + derived `fieldRules` **only**
  when the textarea parses to an object. Empty → byte-compatible legacy request. Invalid JSON →
  throws before the call (no backend request), error surfaced. The #1968 provenance display logic is
  unchanged.

## Tests

- `plugins/plugin-integration-core/__tests__/k3-df-t1-target-payload-preview.test.cjs` — **transform
  alignment (review P2)**: with `fieldMappings`, DF-T1 applies trim+upper / dictMap / toNumber so the
  payload carries the TRANSFORMED values (`MAT-001` / `Pcs` / `2`), not raw; a required staging field
  blank after transform → `valid: false` (`missingRequiredFields`); and a failing **non-required**
  validation (`min`) → `valid: false` (`validationErrors`), proving the full pipeline validation runs.
  Existing no-`fieldMappings` DF-T1 tests are unchanged (raw reads, `transformErrors`/`validationErrors`
  `[]`).
- `apps/web/tests/integrationWorkbench.spec.ts` — `deriveFieldRulesFromMappings` unit tests: maps to
  `from_staging` scalar **keyed by target field**; preserves `required` from the mapping validation;
  skips entries missing a source/target; tolerates an empty list.
- `apps/web/tests/IntegrationWorkbenchView.spec.ts` — the preview mock is **request-aware** (returns
  `targetPayloadPreview` only when the request carries `payloadTemplate`, mirroring the backend); the
  preview test covers: (1) legacy request unchanged — no `payloadTemplate`/`fieldRules`, panel absent;
  (2) DF-T1 wired — POST carries `payloadTemplate` + `fieldRules`, panel renders names + stats;
  (3) invalid JSON — no POST, error shown; (4) no raw payload values in the panel.
- Negative controls (run locally 2026-05-28): (a) removing the frontend request wiring fails the
  `previewBodies[1]` `payloadTemplate` assertion; (b) reverting the backend to read raw `sourceRecord`
  fails the transformed-value assertions (`FNumber === 'MAT-001'`). Both restored → green. `vue-tsc
  --noEmit`: 0 errors.

## Excluded

No template authoring UI, connector metadata, persistence, JSONB provenance runtime, K3
write (Save/Submit/Audit/BOM), multi-record, or DF-T2.

## Acceptance

DF-T1.5 panel is now reachable through the real UI request path; the legacy preview stays
byte-compatible when `payloadTemplate` is empty; the suite locks the request-body wire assertion
#1968 lacked. No backend/runtime/persistence/K3-write changes.
