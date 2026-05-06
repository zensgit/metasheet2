# Multitable Feishu RC API Smoke Verification - 2026-05-06

## Status

- Branch: `codex/multitable-rc-staging-api-smoke-20260506`
- Real staging run: not run in this development session because no staging URL/token was injected into the worktree.
- Verification level: parser/renderer/unit coverage plus mocked HTTP end-to-end runner coverage.

## Commands

```bash
node --test scripts/ops/multitable-feishu-rc-api-smoke.test.mjs
```

Result:

```text
3 tests pass
```

```bash
node --check scripts/ops/multitable-feishu-rc-api-smoke.mjs
node --check scripts/ops/multitable-feishu-rc-api-smoke.test.mjs
git diff --check
```

Result:

```text
no syntax or whitespace errors
```

Also verified through the package script:

```bash
pnpm verify:multitable-feishu-rc:api-smoke:test
```

Result:

```text
3 tests pass
```

## Test Coverage

`scripts/ops/multitable-feishu-rc-api-smoke.test.mjs` covers:

- Required config validation for token, write confirmation, and writable target.
- Markdown renderer behavior for failing and skipped checks.
- Redaction safety: reports do not include bearer token strings or public form tokens.
- Mocked HTTP end-to-end run through:
  - health
  - auth
  - optional integration descriptors skip
  - template list
  - template install
  - batch field creation
  - record create
  - record patch with expected version
  - conditional-formatting view create
  - public form share/context/submit
  - report artifact writes

## Real Staging Follow-up

Run after staging deploy:

```bash
API_BASE="http://142.171.239.56:8081" \
AUTH_TOKEN="$(cat /path/to/admin.jwt)" \
CONFIRM_WRITE=1 \
ALLOW_INSTALL=1 \
EXPECTED_COMMIT="<deployed-main-sha>" \
OUTPUT_DIR="output/multitable-feishu-rc-api-smoke/142-$(date +%Y%m%d-%H%M%S)" \
pnpm verify:multitable-feishu-rc:api-smoke
```

Pass criteria:

- Runner exits `0`.
- `report.md` has `Overall: PASS`.
- Any skipped `api.integration-staging.descriptors` is acceptable only if integration-core staging plugin is intentionally disabled.
- Browser checklist remains required after this API smoke passes.
