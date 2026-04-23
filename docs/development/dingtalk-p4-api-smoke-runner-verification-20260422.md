# DingTalk P4 API Smoke Runner Verification

- Date: 2026-04-22
- Scope: local script tests and documentation packet coverage

## Commands Run

```bash
node --check scripts/ops/dingtalk-p4-remote-smoke.mjs
node --check scripts/ops/dingtalk-p4-remote-smoke.test.mjs
node --check scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs
node --test scripts/ops/dingtalk-p4-remote-smoke.test.mjs
node --test scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs
node --test scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs
git diff --cached --check
```

## Results

- `dingtalk-p4-remote-smoke.test.mjs`: passed.
- `compile-dingtalk-p4-smoke-evidence.test.mjs`: passed.
- `export-dingtalk-staging-evidence-packet.test.mjs`: passed.
- Syntax checks: passed.
- `git diff --cached --check`: passed.

## Coverage Notes

- The fake API test covers base, sheet, field, form view, form-share, two group destinations, group test-send, group automation test-run, optional person automation test-run, and delivery history queries.
- The runner output test asserts secrets are not printed or persisted, including bearer token, DingTalk `access_token`, `sign`, `timestamp`, `SEC...`, and public form token.
- Missing admin token and malformed robot secret fail before any network request.
- A no-person-recipient run keeps `delivery-history-group-person` as `pending`, matching the remote-smoke boundary.

## Remaining Remote Validation

- Run the API-only runner against the deployed 142/staging backend with real robot webhooks.
- Complete manual DingTalk-client evidence for authorized submit, unauthorized denial, and no-email local user creation/binding.
- Compile the final evidence with `--strict`.
