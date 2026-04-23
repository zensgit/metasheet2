# DingTalk P4 Smoke Preflight And Readiness Verification

- Date: 2026-04-22
- Scope: local ops scripts and evidence readiness gates

## Commands Run

```bash
node --check scripts/ops/dingtalk-p4-smoke-preflight.mjs
node --check scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs
node --check scripts/ops/dingtalk-p4-remote-smoke.mjs
node --test scripts/ops/dingtalk-p4-smoke-preflight.test.mjs scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs scripts/ops/dingtalk-p4-remote-smoke.test.mjs scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs
git diff --cached --check
```

## Results

- `node --check scripts/ops/dingtalk-p4-smoke-preflight.mjs`: passed.
- `node --check scripts/ops/compile-dingtalk-p4-smoke-evidence.mjs`: passed.
- `node --check scripts/ops/dingtalk-p4-remote-smoke.mjs`: passed.
- `node --test scripts/ops/dingtalk-p4-smoke-preflight.test.mjs scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs scripts/ops/dingtalk-p4-remote-smoke.test.mjs scripts/ops/export-dingtalk-staging-evidence-packet.test.mjs`: passed, 17 tests.
- `git diff --cached --check`: passed.

## Coverage Notes

- Preflight success path covers env/CLI inputs, `/health`, no Authorization header on health, output file generation, and secret redaction.
- Preflight failure paths cover missing allowlist, malformed webhook, and invalid `SEC...` secret.
- Compiler strict-mode hardening covers API-only pass evidence being rejected when real manual evidence metadata is absent.
- API runner coverage verifies it no longer marks real DingTalk group-message visibility as complete from API delivery rows alone.
- Evidence packet coverage verifies the new preflight script is included in handoff bundles.

## Remaining Remote Validation

- Run the preflight and API runner against the deployed 142/staging backend with real operator inputs.
- Add manual evidence for real DingTalk group message visibility, authorized submit, unauthorized denial, and no-email admin create/bind.
- Compile final evidence with `--strict`.
