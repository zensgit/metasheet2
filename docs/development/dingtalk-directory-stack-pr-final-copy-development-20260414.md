# DingTalk Directory Stack PR Final Copy

## Target Scope

This combined PR package covers:

- `591e915b2` `feat(dingtalk): add directory review workflow`
- `1e0f52248` `feat(dingtalk): add directory schedule observation`
- supporting docs commits prepared afterward

Suggested title:

```text
feat(dingtalk): add directory review and schedule observation
```

## Final PR Body

```md
## What Changed

This PR upgrades DingTalk directory administration from one-by-one remediation to a review-driven workflow with explicit schedule observation.

Backend changes:

- add directory sync alert listing and acknowledgement
- add review-queue listing with counts and queue filters
- add batch bind and batch unbind routes for directory accounts
- restore optional `disableDingTalkGrant` behavior on unbind
- add bulk DingTalk grant and bulk namespace admission routes in admin users
- include linked-directory status in the DingTalk access snapshot
- add a schedule snapshot route for directory integrations
- derive schedule observation states such as `manual_only` and `auto_observed`

Frontend changes:

- add a recent alerts panel to Directory Management
- add a review queue with inline bind/search actions
- add batch bind and batch deprovision controls
- add linked-directory visibility and bulk controls in User Management
- add an auto-sync observation card that separates:
  - configured cron
  - cron validity
  - next expected run
  - latest manual execution
  - latest automatic execution actually observed

## Why

The previous DingTalk directory admin flow required operators to inspect and repair account drift manually in the main table. This PR adds an explicit review queue, recent-alert handling, bulk remediation paths, and an observation layer that shows whether automatic sync is merely configured or has actually been observed in run history.

## Verification

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/admin-directory-routes.test.ts tests/unit/admin-users-routes.test.ts tests/unit/directory-sync-bind-account.test.ts --reporter=dot`
- `pnpm --filter @metasheet/web exec vitest run --watch=false tests/directoryManagementView.spec.ts tests/userManagementView.spec.ts --reporter=dot`
- `pnpm --filter @metasheet/web exec vue-tsc --noEmit`

## Notes

- Backend workspace `tsc --noEmit` is still blocked by pre-existing issues in `api-token-auth.ts`, `automation-service.ts`, `comments.ts`, and `univer-meta.ts`.
- The new schedule card is observational. It does not claim that runtime scheduler registration is already wired unless automatic runs are actually present in recorded history.
- This PR does not modify the DingTalk OAuth callback flow.
```

## Reviewer Focus

- review-item classification and batch remediation semantics
- alert acknowledgement and audit behavior
- DingTalk grant side effects during unbind
- bulk namespace admission and bulk DingTalk grant routes
- schedule snapshot semantics, especially `manual_only` vs `auto_observed`
- frontend separation between review queue, alerts, account list, and schedule observation
