# DingTalk P4 Smoke Workspace Verification

- Date: 2026-04-23
- Scope: API-only runner workspace output

## Commands Run

```bash
node --check scripts/ops/dingtalk-p4-remote-smoke.mjs
node --test scripts/ops/dingtalk-p4-remote-smoke.test.mjs
git diff --cached --check
```

## Results

- `node --check scripts/ops/dingtalk-p4-remote-smoke.mjs`: passed.
- `node --test scripts/ops/dingtalk-p4-remote-smoke.test.mjs`: passed, 4 tests.
- `git diff --cached --check`: passed after staging the smoke-workspace changes.

## Coverage Notes

- The fake API chain still covers table/form creation, DingTalk group binding, `dingtalk_granted`, automation test-run, delivery history, and secret redaction.
- The primary runner test now verifies `manual-evidence-checklist.md` and all four manual artifact folders are generated.
- The primary runner test verifies manual checks use `manual-client` or `manual-admin` skeletons and preserve API bootstrap details separately.

## Remaining Remote Validation

- Run the updated workspace flow on 142/staging.
- Fill the generated evidence bundle with real DingTalk-client/admin proof.
- Compile final evidence with `--strict`.
