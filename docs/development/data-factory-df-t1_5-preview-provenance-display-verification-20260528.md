# Data Factory DF-T1.5 — preview provenance display (verification, 2026-05-28)

Part of 阶段二 (Data Factory). DF-T1.5 is a **read-only frontend** slice over data DF-T1 already
emits — the first 阶段二 opt-in taken after the K3 PoC GATE PASS (#1792).

## Scope (narrow, by design)

Show, in the Data Factory payload-preview panel (`IntegrationWorkbenchView.vue`), the **source of
each composed field** from `targetPayloadPreview.fieldProvenance`:

- sources: `staging` / `template` / `constant` / `reference_table`;
- rendered as **field name + source badge + per-source stats**;
- shown **only when** the response carries `targetPayloadPreview.fieldProvenance` — the legacy
  fieldMappings preview is unaffected (panel absent);
- **field names + sources + counts only — never raw payload values** (preserves the secret hygiene
  established for the K3 preview/Save evidence).

## Explicitly NOT in this slice

provenance persistence · JSONB migration · by-rowId route · K3 Save/Submit/Audit/BOM · multi-record
gate · connector action metadata. No new runtime, no backend, no route.

## Change

- `apps/web/src/services/integration/workbench.ts`: type the DF-T1 evidence
  (`IntegrationTargetPayloadPreview`, optional on `IntegrationTemplatePreviewResult`) + a **pure
  helper** `summarizeFieldProvenance(preview) → { entries, stats } | null` (returns null when there
  is no fieldProvenance, so the UI shows nothing; canonical source order; never reads values).
- `apps/web/src/views/IntegrationWorkbenchView.vue`: a `previewProvenance` ref set from the helper
  on preview (cleared on error) and a `v-if`-gated panel in the preview section rendering the
  badges + stats + a "仅显示字段名与来源，不含字段值" note.

## Verification

- `apps/web/tests/integrationWorkbench.spec.ts` — `summarizeFieldProvenance` unit tests: null on
  no/empty fieldProvenance; entries sorted by field with their source; canonical stats order +
  counts; forward-compat unknown source appended after the known ones.
- `apps/web/tests/IntegrationWorkbenchView.spec.ts` — the preview test now returns
  `targetPayloadPreview.fieldProvenance`; asserts the panel renders field names + stats
  (`暂存源: 2 · 模板: 1 · 引用表: 1`) and contains **none** of the payload values
  (`MAT-001` / `Bolt` / `Pcs`).
- Negative control (run locally 2026-05-28): reverting the `previewProvenance` wiring (so the panel
  never renders) fails the view spec's panel assertion; restoring → green.
- `vitest run` (both specs): 44 passed. `vue-tsc --noEmit`: 0 errors.

## Next (one opt-in at a time)

DF-T1.5 done → the next 阶段二 step is **DF-N2-2 (provenance runtime)** or **DF-T1A (connector
action metadata)**, each a separate explicit opt-in. K3 write (Submit / Audit / BOM / multi-record)
stays gated.
