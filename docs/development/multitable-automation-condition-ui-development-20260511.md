# Multitable Automation Condition UI Development - 2026-05-11

## Context

PR #1466 fixed backend condition evaluation for both `logic` and `conjunction`.
PR #1467 then added route-boundary validation so malformed automation `conditions` no longer persist as JSONB.

This follow-up aligns the frontend rule editor with that validated schema.

## Scope

Implemented:

- Extended frontend automation condition types to include:
  - `in`
  - `not_in`
  - nested `ConditionGroup` nodes
  - backend-style `logic`
  - frontend-style `conjunction`
- Added `In list` and `Not in list` operators to `MetaAutomationRuleEditor`.
- Serialized `in` / `not_in` UI text as arrays before save.
- Kept save disabled when a condition row is incomplete.
- Preserved existing nested condition groups when editing other rule fields.
- Added a readonly notice when nested groups exist, because the editor still only edits top-level leaf conditions.

Not implemented:

- Full nested-condition builder UX.
- Drag/drop condition group authoring.
- Field-type-aware operator filtering.
- Backend changes.

## Design Decisions

### Preserve Nested Groups Rather Than Flattening

The backend now supports nested condition groups, but the current editor is a single-level builder.
Flattening nested payloads would silently change automation semantics.

The editor now preserves nested groups on save and shows a notice that only top-level conditions are editable.

### Convert List Operators At Save Boundary

The route validator requires arrays for `in` and `not_in`.
The UI keeps a simple comma-separated text field and converts it to an array in `buildPayload()`.

### Keep This Slice Compatibility-Oriented

This slice intentionally avoids a broader nested builder. The goal is to prevent schema drift and data loss after #1467, not to introduce a new complex authoring workflow.

## Files Changed

- `apps/web/src/multitable/types.ts`
- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/tests/multitable-automation-rule-editor.spec.ts`

## Follow-Ups

- Build a full nested-condition editor after UX is confirmed.
- Add field-aware operator filtering if product wants type-specific condition authoring.
