# DingTalk P4 Env Template Permission Verification

- Date: 2026-04-23
- Branch: `codex/dingtalk-p4-next-20260423`
- Base: `origin/main` at `4e2c60ae1`
- Result: local script and ops readiness checks pass except intentionally missing private remote-smoke inputs

## Commands Run

```bash
node --test scripts/ops/dingtalk-p4-smoke-session.test.mjs
```

- Result: pass, 6 tests.

```bash
node --test \
  scripts/ops/dingtalk-p4-release-readiness.test.mjs \
  scripts/ops/dingtalk-p4-env-bootstrap.test.mjs \
  scripts/ops/dingtalk-p4-regression-gate.test.mjs
```

- Result: pass, 13 tests.

```bash
node scripts/ops/dingtalk-p4-smoke-session.mjs \
  --init-env-template output/dingtalk-p4-remote-smoke-session/dingtalk-p4.env
```

- Result: env template generated.
- Permission: `0600`.

```bash
node scripts/ops/dingtalk-p4-release-readiness.mjs \
  --p4-env-file output/dingtalk-p4-remote-smoke-session/dingtalk-p4.env \
  --regression-profile ops \
  --output-dir output/dingtalk-p4-release-readiness/142-local \
  --allow-failures
```

- Result: report generated with `overallStatus: "fail"` because private values are blank.
- Fixed condition: `env-file-private-mode` is no longer a failed check.
- Remaining failed env checks: `dingtalk_p4_auth_token`, `dingtalk_p4_group_a_webhook`, `group-a-webhook-shape`, `dingtalk_p4_group_b_webhook`, `group-b-webhook-shape`, `allowlist-present`, `manual-targets-declared`.
- Local regression gate inside readiness: `pass`.

```bash
node scripts/ops/dingtalk-p4-regression-gate.mjs \
  --profile ops \
  --output-dir output/dingtalk-p4-regression-gate/142-ops \
  --fail-fast
```

- Result: pass.
- Summary: 10 passed, 0 failed, 0 skipped.

## Evidence Paths

- `output/dingtalk-p4-regression-gate/142-ops/summary.json`
- `output/dingtalk-p4-regression-gate/142-ops/summary.md`
- `output/dingtalk-p4-release-readiness/142-local/release-readiness-summary.json`
- `output/dingtalk-p4-release-readiness/142-local/release-readiness-summary.md`

## Residual Risks

- No real admin token, DingTalk webhook, or manual target identity was used in this verification.
- Final remote smoke remains blocked until private env values are supplied outside git.
- Product profile was not run because this slice only changed Node ops tooling and no workspace dependencies were installed in the fresh worktree.
