# DingTalk Action Validation Stack Promotion - 2026-04-21

## Scope

Promote the DingTalk automation validation stack onto the current `origin/main`.

The active stack heads were:

- PR #1002: `fix(dingtalk): validate automation action configs`
- PR #1003: `fix(dingtalk): validate automation configs in service`

The PR bases were stack branches, not `main`, so closing those PRs alone would not land the functional code on the mainline.

## Development Notes

Created a clean promotion worktree from `origin/main`:

```bash
git worktree add -b codex/dingtalk-action-validation-stack-promotion-20260421 \
  /private/tmp/metasheet2-dingtalk-action-validation-promotion origin/main
git merge --squash origin/codex/dingtalk-action-service-validation-20260421
```

The squash merge conflicted in DingTalk automation files and related tests. Conflict resolution policy:

- Preserve `main` runtime changes, especially the Yjs REST invalidator wiring in `packages/core-backend/src/routes/univer-meta.ts`.
- Keep DingTalk validation stack behavior for route/service action-config validation.
- Keep the standard persisted backend field contract:
  - group dynamic destinations: `destinationIdFieldPath(s)`
  - person dynamic recipients: `userIdFieldPath(s)`
  - member-group dynamic recipients: `memberGroupIdFieldPath(s)`
- Keep frontend draft-only names internal to Vue components and preserve save-time conversion to backend contract fields.

Resolved conflict groups:

- `apps/web/src/multitable/components/MetaAutomationManager.vue`
- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/src/multitable/utils/dingtalkRecipientFieldWarnings.ts`
- `apps/web/tests/dingtalk-recipient-field-warnings.spec.ts`
- `apps/web/tests/multitable-automation-manager.spec.ts`
- `apps/web/tests/multitable-automation-rule-editor.spec.ts`
- `packages/core-backend/src/multitable/dingtalk-automation-link-validation.ts`
- `packages/core-backend/src/routes/univer-meta.ts`
- `packages/core-backend/tests/integration/dingtalk-automation-link-routes.api.test.ts`
- `packages/core-backend/tests/unit/dingtalk-automation-link-validation.test.ts`

## Verification

Installed dependencies in the promotion worktree:

```bash
pnpm install --frozen-lockfile
```

Backend focused regression:

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/dingtalk-automation-link-validation.test.ts \
  tests/integration/dingtalk-automation-link-routes.api.test.ts \
  tests/integration/dingtalk-delivery-routes.api.test.ts \
  tests/unit/automation-v1.test.ts \
  --watch=false
```

Result:

```text
Test Files  4 passed (4)
Tests       142 passed (142)
```

Frontend focused regression:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/dingtalk-recipient-field-warnings.spec.ts \
  tests/multitable-automation-rule-editor.spec.ts \
  tests/multitable-automation-manager.spec.ts \
  --watch=false
```

Result:

```text
Test Files  3 passed (3)
Tests       122 passed (122)
```

Build and type gates:

```bash
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web exec vue-tsc -b --noEmit
git diff --check
```

Result:

```text
All passed.
```

Notes:

- Frontend test run emitted the existing `WebSocket server error: Port is already in use` warning; tests passed.
- `pnpm install` produced local workspace `node_modules` link noise, which was removed before commit.
