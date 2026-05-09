# DingTalk Agent ID Mainline Integration Verification

Date: 2026-05-08

## Branch

```text
codex/dingtalk-agent-id-mainline-20260508
```

Initial base:

```text
origin/main
```

Final release base:

```text
61605888739e731cedbc6dc377c93893106e338a
```

Final release image tag:

```text
245701aeb5afc57ae5a5932cc4f58ef3aef3a973
```

## 142 Pre-Integration Evidence

142 main settled on:

```text
IMAGE_TAG=2e038c36b009698f654b7c5b38806058d5dfa5e8
```

Health:

```json
{"ok":true,"status":"ok","success":true,"plugins":13}
```

Frontend:

```text
HTTP/1.1 200 OK
```

Unauthenticated Agent ID route probe:

```text
401
```

Authenticated helper probe against current main image:

```json
{
  "status": "blocked",
  "failures": [
    { "code": "STATUS_API_FAILED", "httpStatus": 404 }
  ],
  "agentIdLength": 0,
  "agentIdValuePrinted": false
}
```

Conclusion:

- 142 main is healthy.
- Current main image does not contain the Agent ID admin API.
- The fix must land on main and be rebuilt/deployed, not hot-patched.

## Local Verification

Dependency install in clean worktree:

```bash
pnpm install --frozen-lockfile --ignore-scripts
```

Script/helper checks:

```bash
node --check scripts/ops/dingtalk-work-notification-admin-agent-id.mjs
node --test scripts/ops/dingtalk-work-notification-admin-agent-id.test.mjs
node --test scripts/ops/dingtalk-work-notification-release-gate.test.mjs
```

Result:

- Admin helper tests: 4 passed.
- Release gate tests: 5 passed.

Backend targeted tests:

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/dingtalk-work-notification-settings.test.ts \
  tests/unit/admin-directory-routes.test.ts \
  tests/unit/directory-sync-work-notification-agent-id.test.ts \
  --run
```

Result:

- 3 files passed.
- 33 tests passed.

Frontend targeted tests:

```bash
pnpm --filter @metasheet/web exec vitest run tests/directoryManagementView.spec.ts --run
```

Result:

- 1 file passed.
- 38 tests passed.
- Note: Vitest printed `WebSocket server error: Port is already in use`; tests still completed successfully.

Backend build:

```bash
pnpm --filter @metasheet/core-backend build
```

Result:

- Pass.

Frontend build:

```bash
pnpm --filter @metasheet/web build
```

Result:

- Pass.
- Vite reported existing chunk-size warnings only.

Diff whitespace:

```bash
git diff --check origin/main..HEAD
```

Result:

- Pass.

Secret scan:

```bash
git diff --name-only origin/main..HEAD | xargs rg -n --no-heading -S \
  'oapi\.dingtalk\.com/robot/send|access_token=|\bSEC[a-zA-Z0-9]{20,}\b|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'
```

Result:

- No real DingTalk webhook, robot `SEC...`, admin JWT, or Agent ID value found.
- Matches were limited to redactor code, generated URL construction, docs scan
  commands, and dummy test fixtures.

## GHCR Verification

Workflow:

```text
Build and Push Docker Images
```

Run:

```text
https://github.com/zensgit/metasheet2/actions/runs/25535973036
```

Result:

- Build job passed.
- Backend image pushed for `245701aeb5afc57ae5a5932cc4f58ef3aef3a973`.
- Web image pushed for `245701aeb5afc57ae5a5932cc4f58ef3aef3a973`.
- Deploy job skipped because the branch is not `main`, which is expected for
  this manual 142 acceptance release.

## 142 Deployment Verification

Before the first manual switch, 142 had advanced to latest main:

```text
IMAGE_TAG=06f71465ac55843431f7d5de7eea00fd7eb1a5d2
```

The branch was then rebased again onto:

```text
61605888739e731cedbc6dc377c93893106e338a
```

The final manual switch changed only `metasheet-backend` and `metasheet-web`
from the interim Agent ID tag to the latest rebased Agent ID tag:

```text
IMAGE_TAG=245701aeb5afc57ae5a5932cc4f58ef3aef3a973
```

Container state:

```text
metasheet-web     ghcr.io/zensgit/metasheet2-web:245701aeb5afc57ae5a5932cc4f58ef3aef3a973
metasheet-backend ghcr.io/zensgit/metasheet2-backend:245701aeb5afc57ae5a5932cc4f58ef3aef3a973
metasheet-postgres postgres:15-alpine healthy
metasheet-redis    redis:7-alpine healthy
```

Health:

```text
GET http://127.0.0.1:8900/api/health -> 200
GET http://127.0.0.1:8081/ -> 200
```

Disk:

```text
Before cleanup: / use=100%, avail=0
After cleanup:  / use=44%-46%, avail=40G+
```

Cleanup scope:

- Removed only unused `ghcr.io/zensgit/metasheet2-backend` and
  `ghcr.io/zensgit/metasheet2-web` image tags.
- Preserved running images and rollback/current baselines.
- Did not remove Docker volumes, Postgres data, Redis data, uploads, or secrets.

## 142 Agent ID Acceptance

Unauthenticated route:

```text
GET /api/admin/directory/dingtalk/work-notification -> 401
```

Authenticated status helper:

```json
{
  "status": "pass",
  "statusBefore": {
    "configured": false,
    "available": false,
    "unavailableReason": "missing_agent_id",
    "source": "mixed"
  }
}
```

Authenticated save helper with the private Agent ID file:

```json
{
  "saveExitCode": 1,
  "saveStatus": "blocked",
  "saveFailureCodes": ["AGENT_ID_FILE_EMPTY"],
  "agentFileEmpty": true
}
```

Conclusion:

- The Agent ID admin route is present and authenticated.
- Empty Agent ID is rejected before save.
- The private Agent ID file currently exists but is intentionally empty.
- The next real-send acceptance step requires filling the Agent ID through the
  frontend page or the private file, then optionally providing a recipient user
  id file for a real DingTalk work-notification send test.

## PR Status

PR:

```text
https://github.com/zensgit/metasheet2/pull/1430
```

Status after the final runtime rebase and 142 acceptance:

- Runtime image verified on 142: `245701aeb5afc57ae5a5932cc4f58ef3aef3a973`.
- Base included in that runtime image: `61605888739e731cedbc6dc377c93893106e338a`.
- The PR may contain later docs-only commits after the runtime image tag; those
  commits do not change backend/frontend runtime behavior.
- Automated checks observed in the PR rollup passed, except the configured
  strict E2E job that was skipped by workflow policy.
- Merge state was still `BLOCKED` because repository review/merge policy had
  not yet been satisfied.

## Security

No real DingTalk webhook, `SEC...` robot secret, Agent ID value, or admin JWT is written in this document.

The helper output intentionally keeps:

- `agentIdValuePrinted=false`
- token file paths redacted to basenames
- Agent ID represented only by configured state and length

## Remaining Non-Blocking Items

1. Fill/save the real DingTalk work-notification Agent ID.
2. Run helper with `--agent-id-file ... --save`.
3. Optionally add `--recipient-user-id-file` for a real DingTalk work-notification delivery test.
4. Merge this branch to `main` so future automatic 142 deployments stop
   overwriting the manual Agent ID acceptance image.
