# DF-T1.5 reachability wire — payload template preview wiring (verification, 2026-05-28)

Follow-up to #1968. #1968 rendered `targetPayloadPreview.fieldProvenance` but the UI only sent the
legacy preview request shape, so the panel was display-capable but **not live-triggerable** — a
wire-vs-fixture gap (the render test mocked a response the real request never produced). This wires
the request so the panel is reachable, and locks the missing request-body assertion.

## Change

- `apps/web/src/services/integration/workbench.ts`: `IntegrationTemplatePreviewRequest` gains
  optional `payloadTemplate` + `fieldRules` (legacy callers unchanged); new pure helper
  `deriveFieldRulesFromMappings` (each field mapping → a `from_staging` scalar rule).
- `apps/web/src/views/IntegrationWorkbenchView.vue`: an optional `目标模板 JSON` textarea
  (`payloadTemplateText`); `previewPayload()` sends `payloadTemplate` + derived `fieldRules` **only**
  when the textarea parses to an object. Empty → byte-compatible legacy request. Invalid JSON →
  throws before the call (no backend request), error surfaced. The #1968 provenance display logic is
  unchanged.

## Tests

- `apps/web/tests/integrationWorkbench.spec.ts` — `deriveFieldRulesFromMappings` unit tests (maps to
  `from_staging` scalar; skips entries missing a source/target; tolerates an empty list).
- `apps/web/tests/IntegrationWorkbenchView.spec.ts` — the preview mock is now **request-aware**
  (returns `targetPayloadPreview` only when the request carries `payloadTemplate`, mirroring the
  backend) and the preview test covers:
  1. **Legacy request unchanged** — POST has no `payloadTemplate`/`fieldRules`; provenance panel absent.
  2. **DF-T1 request wired** — POST carries `payloadTemplate` + `fieldRules` (`from_staging` scalar);
     panel renders field names + stats.
  3. **Invalid JSON blocks the request** — no POST is made; an error is shown.
  4. **No raw values** — the panel shows field names/sources only, never payload values
     (`MAT-001`/`Bolt`/`Pcs`).
- Negative control (run locally 2026-05-28): removing the request wiring fails the
  `previewBodies[1]` `payloadTemplate` assertion; restored → 46/46 green. `vue-tsc --noEmit`: 0 errors.

## Excluded

No template authoring UI, connector metadata, persistence, JSONB provenance runtime, K3
write (Save/Submit/Audit/BOM), multi-record, or DF-T2.

## Acceptance

DF-T1.5 panel is now reachable through the real UI request path; the legacy preview stays
byte-compatible when `payloadTemplate` is empty; the suite locks the request-body wire assertion
#1968 lacked. No backend/runtime/persistence/K3-write changes.
