# PLM Workbench Approval Comment Locality Design

## Problem

`approvalComment` is a local action draft used by the approvals panel when the current actor approves or rejects an
entry.

Before this change, the approvals team-view integration treated that draft as collaborative state:

- team-view save/apply serialized `comment`
- route-owner drift matching compared `comment`
- shared approvals URLs carried `approvalComment`

That made a transient approve/reject note behave like a canonical approvals view filter. Typing into the local comment
box could clear an otherwise matching `approvalsTeamView`, and shared or saved views could persist a one-off action
draft.

## Decision

1. Keep `approvalComment` as local page state and local deep-link state.
2. Remove `comment` from `PlmApprovalsTeamViewState`.
3. Stop serializing or restoring `approvalComment` through approvals collaborative team views.
4. Stop comparing `approvalComment` when matching the live approvals panel against a route-owned team view.
5. Stop emitting `approvalComment` in approvals team-view share URLs.

## Expected Behavior

- typing an approval note no longer clears a matching approvals team view
- saving or sharing an approvals team view only preserves filter/sort/column state
- backend approvals team-view payloads silently drop legacy `comment` data
- local deep links can still carry `approvalComment` for the current browser session
