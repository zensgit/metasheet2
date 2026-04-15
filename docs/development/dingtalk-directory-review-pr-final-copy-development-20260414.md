# DingTalk Directory Review PR Final Copy

## Final PR Title

```text
feat(dingtalk): add directory review workflow
```

## Final PR Body

```md
## What Changed

This PR upgrades DingTalk admin operations from one-by-one account fixes to a review-driven workflow.

Backend changes:

- add directory sync alert listing and acknowledgement
- add review-queue listing with queue counts and filters
- add batch bind and batch unbind routes for directory accounts
- restore optional `disableDingTalkGrant` behavior on unbind
- add bulk DingTalk grant and bulk namespace admission routes in admin users
- include linked-directory status in the DingTalk access snapshot

Frontend changes:

- add a recent alerts panel to Directory Management
- add a review queue with inline bind/search actions
- add batch bind and batch deprovision controls
- add linked-directory visibility and bulk controls in User Management

## Why

The previous DingTalk directory admin flow required operators to handle drift one account at a time in the main table. This PR introduces an explicit review queue, recent-alert visibility, and bulk actions for the common remediation paths.

## Verification

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-directory-routes.test.ts tests/unit/admin-users-routes.test.ts tests/unit/directory-sync-bind-account.test.ts --reporter=dot`
- `pnpm --filter @metasheet/web exec vitest run --watch=false tests/directoryManagementView.spec.ts tests/userManagementView.spec.ts --reporter=dot`
- `pnpm --filter @metasheet/web exec vue-tsc --noEmit`

## Notes

- Backend workspace `tsc --noEmit` is still blocked by pre-existing issues in `api-token-auth.ts`, `automation-service.ts`, `comments.ts`, and `univer-meta.ts`.
- This PR does not modify the DingTalk OAuth callback flow.
```

## Reviewer Focus

- Review queue classification for `needs_binding`, `inactive_linked`, and `missing_identity`
- Alert acknowledgement route and audit behavior
- Batch bind and batch unbind semantics, especially grant side effects
- Bulk namespace admission and bulk DingTalk grant handling in user management
- Frontend state coordination between alerts, review queue, and account table
