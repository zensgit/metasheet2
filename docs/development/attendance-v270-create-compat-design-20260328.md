# Attendance v2.7.0 Create Compatibility Design

## Goal

Tighten the remaining `v2.7.0` admin create-path rough edges without reopening the larger Attendance admin refactor:

- keep the current admin UI contract explicit for approval-flow creation
- make backend create routes more tolerant of common legacy or external-client payload shapes
- avoid changing the primary OpenAPI contract or broadening unrelated route behavior

## Problem Statement

Two reported failures remained after the main admin regression hotfix:

- approval-flow creation returning `400`
- rule-set creation returning `400` even after callers attempted to pass `version` as a number

Backend integration coverage already proved the canonical routes work for the intended contract, so the likely gap was not "missing route" but "payload compatibility mismatch":

- approval flows only normalized `requestType` and `request_type`
- rule sets expected `version` as a numeric JSON value and `config` as an object
- some direct callers are more likely to send:
  - `type` instead of `requestType`
  - `steps` as a JSON string
  - `version` as a string
  - `config` as a serialized JSON object string

## Design

### Approval-flow compatibility layer

`normalizeApprovalFlowPayload()` now accepts these compatibility shapes before schema validation:

- `type` as an alias of `requestType`
- `steps` as a JSON string that parses into an array

The canonical contract remains unchanged:

- `requestType` is still the primary field
- `steps` is still validated as an array of normalized approval-step objects

This keeps the admin UI contract stable while unblocking direct callers that still speak an older or looser payload dialect.

### Rule-set compatibility layer

`normalizeRuleSetPayload()` now pre-normalizes:

- numeric `version` strings into numbers
- JSON-string `config` values into objects

This happens before the existing Zod validation and before `ruleSetConfigSchema`/engine validation, so the backend still rejects malformed content. The change only widens input acceptance for payloads that are semantically valid but serialized loosely.

### Frontend contract guard

The admin-side approval-flow unit coverage now explicitly locks that the page/composable sends:

- `requestType`
- parsed `steps`
- `isActive`
- `orgId`

This addresses the specific regression suspicion from test feedback: the current admin UI is not dropping `requestType`.

## Non-goals

This slice does not:

- redesign approval-flow editing
- redefine the official OpenAPI request body
- change `400` vs `404` semantics across unrelated Attendance routes
- loosen engine/rule-set schema validation for actually invalid config
