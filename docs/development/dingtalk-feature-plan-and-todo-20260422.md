# DingTalk Feature Plan And TODO

- Date: 2026-04-22
- Goal: table trigger -> DingTalk group/person message -> form fill or internal processing -> permission-safe completion
- Delivery mode: small stacked PRs; each implementation PR must include development and verification notes
- Current base: continue after the DingTalk validation, directory admission, and person delivery history stack through PR #1073

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

- [x] Backend: verify table-scoped DingTalk group destinations support multiple groups per table.
- [x] Backend: add organization-scoped DingTalk group destination catalog v1 with org membership read/use and admin-only mutation.
- [x] Backend: verify create, update, delete, list, test-send, and delivery history routes enforce automation/write permissions.
- [x] Backend: verify webhook URLs and robot secrets are redacted in responses, logs, and delivery diagnostics.
- [x] Frontend: expose DingTalk group binding in the table integration or existing API token manager surface.
- [x] Frontend: let users add, edit, delete, and test-send DingTalk group robot destinations.
- [x] Frontend: show that group binding does not import DingTalk group members and does not grant form fill permission by itself.
- [x] Automation UI: let users choose a bound DingTalk group for `send_dingtalk_group_message`.
- [x] Automation UI: show organization catalog DingTalk groups in selectors with read-only catalog labeling.
- [x] Automation UI: let users include public form and internal processing links in group messages.
- [x] Runtime: confirm a group message link opens the form and permission checks still gate access.

## P2: Form Access And Assigned Fillers

- [x] Form share UI: support `public`, `dingtalk`, and `dingtalk_granted` access modes.
- [x] Form share UI: allow table owners to choose allowed local users and member groups for DingTalk-protected modes.
- [x] Form share UI: explain that only selected local users/member groups can fill when allowlists are configured.
- [x] Backend: keep `dingtalk_granted` submit guard before record insert.
- [x] Backend: reject inactive allowed users and invalid member groups when saving form access settings.
- [x] Automation UI: display the selected form access level before saving a DingTalk action.
- [x] Runtime copy: show clear errors for auth required, DingTalk binding required, grant required, and not in allowlist.

## P3: DingTalk Person Messaging And User Sync

- [x] Backend: keep `send_dingtalk_person_message` support for static `userIds`.
- [x] Backend: keep `send_dingtalk_person_message` support for `memberGroupIds`.
- [x] Backend: keep dynamic recipient field paths for local users and member groups.
- [x] Frontend: expose person recipient picker for local users and member groups.
- [x] Frontend: warn when selected recipients are not bound to DingTalk.
- [x] Directory sync: show synced DingTalk accounts without matched local users.
- [x] Directory sync: support admin-triggered local user creation without email.
- [x] Directory sync: bind newly created local users to the DingTalk external identity.
- [x] Delivery history: record person send success, failure, and skipped-unbound reasons.

## P4: Documentation And Remote Smoke

- [x] Add an administrator guide for DingTalk app credentials, group robot binding, directory sync, and no-email user creation.
- [x] Add a user guide for table group binding, automation messages, public form links, and form access levels.
- [x] Add troubleshooting notes for webhook signature failures, unbound users, missing grants, no-email users, and links that cannot be opened.
- [x] Add a P4 remote-smoke evidence compiler that validates required checks and writes redacted `summary.json` / `summary.md` artifacts.
- [x] Add a P4 API-only remote-smoke runner for table/form creation, group binding, `dingtalk_granted` setup, automation test-run, and delivery evidence bootstrap.
- [x] Add a P4 remote-smoke preflight gate for local tooling, env input, webhook format, and backend health readiness.
- [x] Harden P4 evidence strict mode so real DingTalk-client/admin checks require per-check manual evidence metadata.
- [x] Add a P4 manual evidence kit generator with required manual evidence fields and artifact folders.
- [x] Add a P4 strict artifact gate so manual pass evidence must reference self-contained non-empty files under `artifacts/<check-id>/`.
- [x] Make the P4 API-only runner output a complete smoke workspace with `evidence.json`, `manual-evidence-checklist.md`, and manual artifact folders.
- [x] Add a P4 smoke session orchestrator that runs preflight, API workspace bootstrap, non-strict compile, and a redacted session summary.
- [x] Add a P4 smoke session env template initializer for secure one-command staging setup.
- [x] Add P4 smoke session finalization so completed manual evidence reruns strict compile and refreshes the session summary.
- [x] Add a P4 final-pass packet gate so release evidence export rejects unfinished, failed, stale-schema, or partially compiled sessions.
- [x] Clear generated packet markers before gated export validation so failed reruns cannot leave a stale passing `manifest.json` or `README.md`.
- [x] Add a P4 packet publish validator for final gated packet shape and common raw secret leakage checks.
- [x] Add a one-command P4 final handoff wrapper that exports, validates, and summarizes a finalized session packet.
- [x] Add a P4 smoke status reporter that summarizes remaining evidence gaps, finalization state, and release handoff readiness.
- [x] Add an offline P4 session-to-handoff chain test so the local tooling contract stays verified without real DingTalk credentials.
- [x] Add a P4 evidence recorder CLI so operators can safely update manual checks without hand-editing `evidence.json`.
- [x] Add a P4 strict artifact secret scan so finalization catches raw secret-like text artifacts before packet handoff.
- [x] Add a P4 unauthorized denial evidence contract so pass evidence must prove submit blocking and zero record insert.
- [x] Add a P4 remote-smoke TODO exporter so status runs generate an executable checklist for remaining evidence.
- [x] Auto-refresh P4 smoke status and remote TODO reports from the session bootstrap/finalize commands.
- [x] Add a P4 no-email admin evidence helper so manual-admin proof uses concrete artifact names and structured result fields.
- [x] Add a final DingTalk development plan and TODO so remote smoke execution can be followed step-by-step.
- [x] Add a P4 final remote-smoke docs generator so release-ready sessions produce final development and verification notes.
- [x] Add a P4 manual target readiness gate so authorized, unauthorized, and no-email DingTalk validation targets are recorded before final smoke.
- [x] Add a P4 local regression gate runner so ops/product verification commands produce JSON/MD evidence before final remote smoke.
- [ ] Remote smoke: create a table and form view.
- [ ] Remote smoke: bind at least two DingTalk groups to the table.
- [ ] Remote smoke: set the form to `dingtalk_granted`.
- [ ] Remote smoke: send a group message with a form link.
- [ ] Remote smoke: verify an authorized user can open and submit.
- [ ] Remote smoke: verify an unauthorized user cannot submit and no record is inserted.
- [ ] Remote smoke: verify delivery history records group and person sends.

Remote smoke checklist:

- `docs/dingtalk-remote-smoke-checklist-20260422.md`

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
