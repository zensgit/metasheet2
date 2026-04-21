# Verification - Yjs Staging Invalidation Smoke Tool

- Branch: `codex/yjs-staging-invalidation-smoke-20260421`
- Date: 2026-04-21
- Linked development MD:
  `docs/development/yjs-staging-invalidation-smoke-tool-development-20260421.md`

## Static Syntax Check

Command:

```bash
node --check scripts/ops/yjs-invalidation-smoke.mjs
node --check scripts/ops/yjs-invalidation-smoke.test.mjs
```

Result:

```text
EXIT=0
```

## Unit Tests

Command:

```bash
node --test scripts/ops/yjs-invalidation-smoke.test.mjs
```

Result:

```text
tests 5
pass  5
fail  0
```

Coverage:

- `normalizeBaseUrl()` trims trailing slashes and whitespace.
- `buildDefaultPatchUrl()` targets
  `/api/multitable/records/:recordId`.
- `parseConfig()` accepts token aliases, explicit `PATCH_URL`, `SHEET_ID`,
  `PATCH_VALUE`, `OUTPUT_DIR`, and timeout.
- `validateConfig()` requires `CONFIRM_WRITE=1` and auth by default.
- Markdown rendering includes failing checks, error text, and invalidation
  payload.

## Safety Failure Path

Command:

```bash
OUTPUT_DIR=tmp/yjs-invalidation-smoke-missing-env \
node scripts/ops/yjs-invalidation-smoke.mjs
```

Result:

```text
Overall: FAIL
Failing checks: config.required-env
Error: Missing required configuration: API_BASE or BASE_URL, RECORD_ID, FIELD_ID, PATCH_URL, AUTH_TOKEN or TOKEN, CONFIRM_WRITE=1
```

Artifacts written:

```text
tmp/yjs-invalidation-smoke-missing-env/report.json
tmp/yjs-invalidation-smoke-missing-env/report.md
```

This verifies missing configuration fails before any socket connection or REST
write attempt.

## Real Staging Smoke

Not executed in this local run because no real staging JWT / target
`RECORD_ID` / target `FIELD_ID` was available in the environment.

Run this after deploying `origin/main` containing PR `#979`:

```bash
BASE_URL="http://142.171.239.56:<api-port>" \
AUTH_TOKEN="<jwt-with-multitable-write>" \
RECORD_ID="<test-record-id>" \
FIELD_ID="<test-string-field-id>" \
CONFIRM_WRITE=1 \
OUTPUT_DIR="output/yjs-invalidation-smoke/$(date -u +%Y%m%d-%H%M%S)" \
node scripts/ops/yjs-invalidation-smoke.mjs
```

Expected result:

```text
Overall: PASS
config.required-env: PASS
auth.token-present: PASS
api.health: PASS
api.record.get: PASS
socket.connect: PASS
socket.subscribe-sync: PASS
api.record.patch: PASS
socket.invalidated: PASS
```

## Decision

Tool-level verification is green. The remaining gate is an environment-backed
staging run with a disposable text field on a Yjs-enabled deployment.
