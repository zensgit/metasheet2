# DingTalk V1 Person Link Reject Development

- Date: 2026-04-22
- Branch: `codex/dingtalk-v1-person-link-reject-20260422`
- Scope: backend route-level integration coverage

## Context

The DingTalk automation route already had coverage for:

- top-level person message success with valid public-form and internal links
- V1 `actions[]` person message success with valid public-form and internal links
- V1 person message rejection when no effective recipient exists
- V1 group message rejection when a public-form link is invalid

The missing route-level gap was V1 `actions[]` with `send_dingtalk_person_message` carrying invalid links.

## Changes

Updated `packages/core-backend/tests/integration/dingtalk-automation-link-routes.api.test.ts` with two route-level rejection cases:

- Invalid public form link in a V1 DingTalk person action.
- Invalid internal processing link in a V1 DingTalk person action.

Both tests assert:

- the API returns HTTP 400
- the response uses `VALIDATION_ERROR`
- the expected link-validation message is returned
- `automationService.createRule` is not called

## Non-Goals

- No runtime behavior changes.
- No API contract changes.
- No frontend changes.
- No database migration changes.

## Expected Product Effect

When users configure a table automation that sends a DingTalk person message from V1 `actions[]`, invalid form/internal links are rejected before the automation rule can be persisted.
