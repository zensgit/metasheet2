# DingTalk Agent ID Mainline Integration Verification

Date: 2026-05-08

## Branch

```text
codex/dingtalk-agent-id-mainline-20260508
```

Base:

```text
origin/main
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

Diff whitespace:

```bash
git diff --check origin/main..HEAD
```

Result:

- Pass.

## Security

No real DingTalk webhook, `SEC...` robot secret, Agent ID value, or admin JWT is written in this document.

The helper output intentionally keeps:

- `agentIdValuePrinted=false`
- token file paths redacted to basenames
- Agent ID represented only by configured state and length

## Remaining Production Acceptance

After GHCR builds this integration branch or after merge to main:

1. Deploy 142 main to the new SHA.
2. Verify `/api/health` and `/`.
3. Run admin helper `--status-only`; route should no longer be 404.
4. Fill `/home/mainuser/metasheet2/.secrets/dingtalk-agent-id.txt` or save Agent ID through the frontend directory-management page.
5. Run helper with `--agent-id-file ... --save`.
6. Optional: add `--recipient-user-id-file` for real DingTalk work-notification delivery verification.
