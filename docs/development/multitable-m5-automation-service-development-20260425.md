# Multitable M5 automation-service extraction development

Date: 2026-04-25
Branch: `codex/multitable-m5-automation-service-20260425`
Base: `origin/main@fa559458b`

## Scope

M5 closes the long-running monolith decomposition theme started with M0 by
consolidating the remaining automation route-handler logic in
`packages/core-backend/src/routes/univer-meta.ts` into the existing
`packages/core-backend/src/multitable/automation-service.ts` seam.

The extraction is mechanical: identifiers, validation order, error codes,
log strings, and response payloads are preserved.

## What moved and where

`automation-service.ts` already owned the core CRUD / scheduler / event
handling for automation rules (added in earlier waves). M5 lifts the
remaining route-handler residue out of `univer-meta.ts`:

### New route helpers in `automation-service.ts`

- `serializeAutomationRule(rule)` — emits the legacy camelCase JSON shape
  (incl. nested `trigger: { type, config }`). Verbatim move from the inline
  `serializeAutomationRule` in `univer-meta.ts`.
- `parseDingTalkAutomationDeliveryLimit(value)` — clamps the delivery
  `limit` query param to `[1, 200]`, default 50. Verbatim move.
- `parseCreateRuleInput(body, createdBy)` — pure body → `CreateRuleInput`
  parser; throws `AutomationRuleValidationError` for unknown
  trigger / action types.
- `parseUpdateRuleInput(body)` — pure body → `UpdateRuleInput` parser;
  returns `null` when no recognised fields are present (route maps that to
  `400 VALIDATION_ERROR: No fields to update`); throws
  `AutomationRuleValidationError` for unknown trigger / action types.
- `preflightDingTalkAutomationCreate(queryFn, sheetId, input)` — runs
  `normalizeDingTalkAutomationActionInputs` → `validateDingTalkAutomationActionConfigs`
  → `validateDingTalkAutomationLinks`. Returns the input with normalized
  `actionConfig` / `actions`. Preserves the route-as-link-validation-boundary
  contract that the integration tests rely on (the persistence layer must
  not see a request that references a cross-sheet view).
- `preflightDingTalkAutomationUpdate(queryFn, sheetId, ruleId, input, service)`
  — only runs when the update touches `actionType` / `actionConfig` /
  `actions`; otherwise passes through. Falls back to the existing rule's
  values for fields the request did not provide. Returns `null` when the
  existing rule is missing or belongs to a different sheet (route maps
  that to `404 NOT_FOUND`).

### Constants promoted inside `automation-service.ts`

- `VALID_TRIGGER_TYPES` already existed but was unused; it now backs the
  new `parseCreateRuleInput` / `parseUpdateRuleInput` validation, plus the
  defensive trigger-type check inside `createRule` / `updateRule`.
- `VALID_ACTION_TYPES` is new (the legacy `notify` / `update_field` types
  remain in the allow-list to preserve backward compatibility with the
  existing route's set).

### Defensive validation inside `createRule` / `updateRule`

Trigger-type and action-type validation now also runs inside
`AutomationService.createRule` and `AutomationService.updateRule` so the
service is self-validating regardless of caller. The route-side
`parseCreateRuleInput` / `parseUpdateRuleInput` produce identical error
messages, so external behavior is unchanged.

### `univer-meta.ts` — replaced with thin handlers

- POST `/sheets/:sheetId/automations` — body parsing → preflight →
  `createRule` → `serializeAutomationRule`.
- PATCH `/sheets/:sheetId/automations/:ruleId` — body parsing → preflight
  → `updateRule` → `serializeAutomationRule`.
- GET `/sheets/:sheetId/automations` and GET `…/dingtalk-{person,group}-deliveries`
  now use the imported `serializeAutomationRule` /
  `parseDingTalkAutomationDeliveryLimit` directly.
- DELETE `/sheets/:sheetId/automations/:ruleId` is unchanged (already
  thin).

The `serializeAutomationRule` function declared inside `univerMetaRouter()`
and the file-level `parseDingTalkAutomationDeliveryLimit` helper have been
removed. The `normalizeDingTalkAutomationActionInputs`,
`validateDingTalkAutomationActionConfigs`, and
`validateDingTalkAutomationLinks` imports from
`../multitable/dingtalk-automation-link-validation` are no longer
referenced from `univer-meta.ts` (they now live behind the preflight
helpers in `automation-service.ts`).

## Composition, not replacement

- `automation-executor.ts`, `automation-scheduler.ts`,
  `automation-actions.ts`, `automation-triggers.ts`,
  `automation-conditions.ts`, `automation-log-service.ts`, and
  `dingtalk-automation-link-validation.ts` are untouched. M5 only adds
  to `automation-service.ts` and removes from `routes/univer-meta.ts`.
- The pre-existing `AutomationService` class (CRUD / event subscribe /
  scheduler bridge) is unchanged in shape; its `createRule` /
  `updateRule` gain a defensive trigger-type / action-type check that
  produces the same `Invalid trigger_type: X` / `Invalid action_type: X`
  error message the route was already returning.
- `multitable/automation-service.ts` is the only multitable file that
  this PR modifies; no plugin contract changes.

## Behavior-preservation promise

- All five automation routes serve identical JSON envelopes, status codes,
  and error messages.
- Route-side ordering preserved: capability check → service-availability
  503 → body parsing → preflight (DingTalk normalize + link validation)
  → service call.
- DingTalk link validation still runs against `pool.query.bind(pool)` at
  the route boundary, with the same normalized payload that the legacy
  inline block produced. The integration test
  `dingtalk-automation-link-routes.api.test.ts` (which spies on
  `validateDingTalkAutomationLinks` to assert the normalized payload
  shape) passes unchanged — the spy still sees `bodyTemplate` /
  `titleTemplate` rather than the raw `content` / `title`.

## Non-goals

- No route surface change.
- No frontend (`apps/web/*`) change.
- No new tables / migrations.
- No edits to `automation-executor.ts` / `automation-scheduler.ts` —
  those services are stable from earlier waves.

## Files

- `packages/core-backend/src/multitable/automation-service.ts` (edited;
  +290 LoC).
- `packages/core-backend/src/routes/univer-meta.ts` (edited; −175 / +21).
- `packages/core-backend/tests/unit/multitable-automation-service.test.ts`
  (edited; new M5 helper coverage).
- `docs/development/multitable-m5-automation-service-development-20260425.md`
  (this file).
- `docs/development/multitable-m5-automation-service-verification-20260425.md`.
