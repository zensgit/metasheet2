# DingTalk Directory Stack CI Blockers Verification

Date: `2026-04-15`
Branch: `codex/feishu-gap-rc-integration-202605`
PR: `#873`

## GitHub Failure Evidence

Reviewed failed job logs:

- `gh run view 24412667734 --job 71313395542 --log-failed`
- `gh run view 24412667707 --job 71313395641 --log-failed`

Observed failures:

- `contracts (openapi)`: `openapi dist drift detected`
- `test (18.x)`: DB access from `rc-regression.test.ts` and `multitable-automation-service.test.ts`

## Local Verification

### 1. Targeted CI blocker reproduction and fix validation

Command:

```bash
cd /tmp/metasheet2-dingtalk-stack/packages/core-backend
pnpm exec vitest run \
  tests/unit/multitable-automation-service.test.ts \
  tests/integration/rc-regression.test.ts \
  --reporter=dot
```

Result:

- `2` files passed
- `64/64` tests passed

### 2. Full core-backend suite

Command:

```bash
cd /tmp/metasheet2-dingtalk-stack/packages/core-backend
pnpm test
```

Result:

- `148/148` files passed
- `2062/2062` tests passed

Notes:

- local logs still include expected degraded-mode warnings about missing local Postgres database `chouhua`
- the suite still completed successfully, matching the CI intent of no hard DB dependency for these paths

### 3. OpenAPI artifact regeneration

Command:

```bash
cd /tmp/metasheet2-dingtalk-stack
pnpm exec tsx packages/openapi/tools/build.ts
```

Result:

- regenerated `3` files under `packages/openapi/dist`
- local diff confirmed the branch had stale generated outputs before the rebuild

### 4. Claude Code CLI availability

Commands:

```bash
claude auth status
claude -p "Return exactly: CLAUDE_CLI_OK"
```

Result:

- CLI logged in successfully
- prompt returned `CLAUDE_CLI_OK`
