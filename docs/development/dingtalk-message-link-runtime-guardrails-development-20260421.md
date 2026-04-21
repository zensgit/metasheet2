# DingTalk Message Link Runtime Guardrails Development - 2026-04-21

- Date: 2026-04-21
- Branch: `codex/dingtalk-message-link-runtime-guardrails-20260421`
- Scope: backend runtime validation for DingTalk group/person message links
- Status: implemented and verified locally

## Background

DingTalk automation messages can append two app links to the rendered message body:

- a public form fill link from `publicFormViewId`
- an internal processing link from `internalViewId`

Frontend authoring warnings help users avoid bad selections, but they are not a security or consistency boundary. Automation rule configs can become stale after view changes, can be imported from older versions, or can be edited through backend paths. The backend `AutomationExecutor` therefore needs to validate every configured link at execution time before sending DingTalk group or person messages.

The hardening goal is to prevent automations from emitting links that point to a stale view, a cross-sheet view, a non-form public entry, or a public form that is no longer actually public.

## Design Goals

Runtime validation should apply equally to:

- `send_dingtalk_group_message`
- `send_dingtalk_person_message`

Public form link requirements:

- the selected `publicFormViewId` must resolve from `meta_views`
- the view must belong to the executing rule sheet
- the view type must be `form`
- `config.publicForm.enabled` must be `true`
- `config.publicForm.publicToken` must be a non-empty string after trimming
- `config.publicForm.expiresAt` or `config.publicForm.expiresOn`, when present, must not be expired at execution time

Internal link requirements:

- the selected `internalViewId` must resolve from `meta_views`
- the view must belong to the executing rule sheet

Failure behavior:

- fail the automation action with a specific error before sending any DingTalk message
- do not append a partially validated link to the message body
- do not call DingTalk group webhook delivery when link validation fails
- do not resolve or send DingTalk person notifications when link validation fails
- keep existing error text stable where practical for already-covered cases

## Implemented Changes

This branch applies the smallest runtime hardening needed for the current link execution path.

Implemented in `packages/core-backend/src/multitable/automation-executor.ts`:

- added `parsePublicFormExpiryMs()` with the same accepted input shapes as the public form route: finite number, `Date`, numeric string, or parseable datetime string
- tightened group-message public-form lookup to `WHERE id = $1 AND sheet_id = $2 AND type = 'form'`
- tightened person-message public-form lookup to `WHERE id = $1 AND sheet_id = $2 AND type = 'form'`
- reject expired public form sharing before appending the fill link
- keep existing disabled/missing-token failure behavior as `Selected public form view is not shared`
- keep existing missing/non-form lookup failure behavior as `Public form view not found`

Failure result stays action-specific:

- `send_dingtalk_group_message`
- `send_dingtalk_person_message`

Expected link output remains unchanged after validation:

- public form: `/multitable/public-form/{sheetId}/{publicFormViewId}?publicToken=...`
- internal view: `/multitable/{sheetId}/{internalViewId}?recordId=...`

## Non-Goals

This change should not:

- alter public form submission authorization semantics
- change DingTalk access-mode or allowlist behavior
- change frontend authoring warnings
- add database migrations
- modify OpenAPI contracts
- change message template rendering
- change group destination scoping beyond the existing destination lookup rules

## Regression Coverage

Focused backend unit coverage was added in `packages/core-backend/tests/unit/automation-v1.test.ts`.

Group message path:

- sends a message with a valid same-sheet shared public form view
- sends a message with a valid same-sheet internal view
- asserts public-form lookup includes `type = 'form'`
- fails when `expiresAt` is expired
- does not call the DingTalk webhook on validation failure

Person message path:

- sends a message with a valid same-sheet shared public form view
- sends a message with a valid same-sheet internal view
- asserts public-form lookup includes `type = 'form'`
- fails when a selected public-form ID resolves as a non-form view because the query filters `type = 'form'`
- does not emit person delivery requests on validation failure

Shared assertions:

- action status is `failed`
- failure error identifies the invalid link category
- no schema or migration diff is required

## Rollout Notes

This is a runtime guardrail. Existing automations that reference stale, cross-sheet, disabled, tokenless, expired, or non-form public links may start failing at execution time instead of sending a bad DingTalk message. That is the intended behavior.

Operationally, failed runs should surface through the existing automation execution logs and step results. No separate migration is expected; owners can fix affected rules by selecting an in-sheet form view with public sharing enabled or by selecting an in-sheet internal view.
