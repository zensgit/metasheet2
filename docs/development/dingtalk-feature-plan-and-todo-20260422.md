# DingTalk Feature Plan And TODO

- Date: 2026-04-22
- Goal: table trigger -> DingTalk group/person message -> form fill or internal processing -> permission-safe completion
- Delivery mode: small stacked PRs; each implementation PR must include development and verification notes
- Current base: continue after the DingTalk validation and granted-form guard stack through PR #1062

## Guiding Decisions

- Build the DingTalk group workflow first, then complete direct DingTalk person messaging.
- Treat DingTalk as the sign-in and delivery channel; the source of fill permission remains local users and member groups.
- Allow one table to associate with multiple DingTalk groups.
- Allow DingTalk-synced users without email to be manually created as local users by an administrator.
- Keep row, column, and cell-level assigned filling out of this phase; handle that as a later permission design after form-level authorization is stable.
- Use Claude Code CLI for read-only review only; do not let it mutate repository files.

## P0: Stabilize Current PR Stack

- [ ] Confirm PR #1055 through #1062 have green CI.
- [ ] Merge or promote the stack in order, keeping the already verified semantics unchanged.
- [ ] Resolve stack conflicts without reverting unrelated user or dependency changes.
- [ ] After every promotion, run the targeted backend gates:
  - `pnpm --filter @metasheet/core-backend exec vitest run tests/integration/dingtalk-automation-link-routes.api.test.ts --watch=false`
  - `pnpm --filter @metasheet/core-backend exec vitest run tests/integration/public-form-flow.test.ts --watch=false`
  - `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/dingtalk-automation-link-validation.test.ts --watch=false`
  - `pnpm --filter @metasheet/core-backend build`
  - `git diff --check`

## P1: DingTalk Group Standard Workflow

- [ ] Backend: verify table-scoped DingTalk group destinations support multiple groups per table.
- [ ] Backend: verify create, update, delete, list, test-send, and delivery history routes enforce automation/write permissions.
- [ ] Backend: verify webhook URLs and robot secrets are redacted in responses, logs, and delivery diagnostics.
- [ ] Frontend: expose DingTalk group binding in the table integration or existing API token manager surface.
- [ ] Frontend: let users add, edit, delete, and test-send DingTalk group robot destinations.
- [ ] Frontend: show that group binding does not import DingTalk group members and does not grant form fill permission by itself.
- [ ] Automation UI: let users choose a bound DingTalk group for `send_dingtalk_group_message`.
- [ ] Automation UI: let users include public form and internal processing links in group messages.
- [ ] Runtime: confirm a group message link opens the form and permission checks still gate access.

## P2: Form Access And Assigned Fillers

- [ ] Form share UI: support `public`, `dingtalk`, and `dingtalk_granted` access modes.
- [ ] Form share UI: allow table owners to choose allowed local users and member groups for DingTalk-protected modes.
- [ ] Form share UI: explain that only selected local users/member groups can fill when allowlists are configured.
- [ ] Backend: keep `dingtalk_granted` submit guard before record insert.
- [ ] Backend: reject inactive allowed users and invalid member groups when saving form access settings.
- [ ] Automation UI: display the selected form access level before saving a DingTalk action.
- [ ] Runtime copy: show clear errors for auth required, DingTalk binding required, grant required, and not in allowlist.

## P3: DingTalk Person Messaging And User Sync

- [ ] Backend: keep `send_dingtalk_person_message` support for static `userIds`.
- [ ] Backend: keep `send_dingtalk_person_message` support for `memberGroupIds`.
- [ ] Backend: keep dynamic recipient field paths for local users and member groups.
- [ ] Frontend: expose person recipient picker for local users and member groups.
- [ ] Frontend: warn when selected recipients are not bound to DingTalk.
- [ ] Directory sync: show synced DingTalk accounts without matched local users.
- [ ] Directory sync: support admin-triggered local user creation without email.
- [ ] Directory sync: bind newly created local users to the DingTalk external identity.
- [ ] Delivery history: record person send success, failure, and skipped-unbound reasons.

## P4: Documentation And Remote Smoke

- [ ] Add an administrator guide for DingTalk app credentials, group robot binding, directory sync, and no-email user creation.
- [ ] Add a user guide for table group binding, automation messages, public form links, and form access levels.
- [ ] Add troubleshooting notes for webhook signature failures, unbound users, missing grants, no-email users, and links that cannot be opened.
- [ ] Remote smoke: create a table and form view.
- [ ] Remote smoke: bind at least two DingTalk groups to the table.
- [ ] Remote smoke: set the form to `dingtalk_granted`.
- [ ] Remote smoke: send a group message with a form link.
- [ ] Remote smoke: verify an authorized user can open and submit.
- [ ] Remote smoke: verify an unauthorized user cannot submit and no record is inserted.
- [ ] Remote smoke: verify delivery history records group and person sends.

## Suggested Parallel Lanes

- Lane A: backend group destination, automation action, delivery history, and route tests.
- Lane B: frontend group binding, automation editor, form link selection, and UI tests.
- Lane C: form access UI, allowlist guidance, forbidden copy, and submit guard tests.
- Lane D: directory sync, no-email local user creation, quick bind, person recipient UI, and person delivery history.
- Lane E: docs, smoke checklist, PR stack tracking, and read-only Claude CLI review.

## Acceptance Criteria

- A table owner can bind multiple DingTalk groups to one table.
- A table owner can create an automation that sends a DingTalk group message containing a form link.
- A user can click the DingTalk message and open the form when local permission allows it.
- A user without required binding, grant, or allowlist membership cannot submit the form.
- An administrator can create and bind a no-email local user from a synced DingTalk account.
- A table owner can select local users or member groups for direct DingTalk person messages.
- Delivery history exposes success, failure, and skipped recipient states without leaking secrets.

## Standard Verification Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/integration/dingtalk-automation-link-routes.api.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec vitest run tests/integration/public-form-flow.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec vitest run tests/integration/dingtalk-delivery-routes.api.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/dingtalk-group-destination-service.test.ts tests/unit/dingtalk-person-delivery-service.test.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/multitable-api-token-manager.spec.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/multitable-form-share-manager.spec.ts --watch=false
pnpm --filter @metasheet/web exec vitest run tests/multitable-client.spec.ts --watch=false
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
pnpm lint
pnpm type-check
git diff --check
```
