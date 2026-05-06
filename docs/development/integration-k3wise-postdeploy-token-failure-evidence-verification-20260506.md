# K3 WISE Postdeploy Token Failure Evidence Verification - 2026-05-06

## Scope

This verification covers the deploy-time evidence path when K3 WISE smoke token
resolution fails or the smoke CLI receives a missing `--token-file`.

## Commands

### Smoke CLI regression suite

```bash
node --test scripts/ops/integration-k3wise-postdeploy-smoke.test.mjs
```

Result: pass, 13/13 tests.

Covered the new case where a missing token file still writes structured JSON and
Markdown evidence with:

- `auth-token-read`: fail
- `authenticated-integration-contract`: fail

### Deploy workflow contract suite

```bash
node --test scripts/ops/integration-k3wise-postdeploy-workflow-contract.test.mjs
```

Result: pass, 2/2 tests.

Covered the deploy workflow contract:

- token resolver has an explicit step id
- token resolver is `continue-on-error`
- resolver return code is captured as `token_resolve_rc`
- smoke step is `continue-on-error`
- smoke stdout/stderr are preserved as artifacts
- final deploy gate fails on token resolver or smoke failure after summary and
  artifact upload can run

### Deploy summary regression suite

```bash
node --test scripts/ops/integration-k3wise-postdeploy-summary.test.mjs
```

Result: pass, 9/9 tests.

Covered that the deploy summary reader still understands K3 WISE smoke evidence.

### Token resolver regression suite

```bash
node --test scripts/ops/resolve-k3wise-smoke-token.test.mjs
```

Result: pass, 7/7 tests.

Covered that the token resolver behavior itself was not changed by this slice.

### Whitespace check

```bash
git diff --check
```

Result: pass, no whitespace errors.

## Manual Reproduction

Before this change:

```bash
node scripts/ops/integration-k3wise-postdeploy-smoke.mjs \
  --base-url http://127.0.0.1:1 \
  --token-file /tmp/metasheet-missing-token-file-for-test \
  --require-auth \
  --out-dir /private/tmp/ms2-tokenfile-evidence-probe
```

The command exited before writing structured K3 WISE smoke evidence.

After this change, the missing token file is represented as an
`auth-token-read` failed check, and the CLI still writes the JSON and Markdown
evidence files before exiting non-zero.
