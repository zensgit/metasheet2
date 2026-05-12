# DingTalk No-Email Target Guard Verification - 2026-05-12

## Summary

The no-email target guard was verified with focused unit tests, formatting checks, and a diff secret scan.

Result: PASS locally. This is a tooling hardening change; it does not alter 142 runtime behavior until merged and deployed through the normal pipeline.

## Verification Matrix

| Gate | Result | Evidence |
| --- | --- | --- |
| Evidence recorder mismatch rejection | PASS | New test rejects a bound DingTalk external id different from the smoke target |
| Strict compiler mismatch rejection | PASS | New test emits `bound_dingtalk_external_id_mismatch` |
| Existing evidence recorder behavior | PASS | Existing manual-client, unauthorized-denial, no-email structured, artifact, redaction, finalize tests still pass |
| Existing compiler behavior | PASS | Existing template, strict artifact, freshness, secret, unauthorized-denial, and no-email evidence tests still pass |
| P4 ops regression gate | PASS | `node scripts/ops/dingtalk-p4-regression-gate.mjs --profile ops` |
| Formatting | PASS | `git diff --check` |
| Secret scan | PASS | Diff scan found no secret value pattern |

## Commands Run

```bash
git diff --check
```

```bash
node --test \
  scripts/ops/dingtalk-p4-evidence-record.test.mjs \
  scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs \
  scripts/ops/dingtalk-p4-remote-smoke.test.mjs \
  scripts/ops/dingtalk-p4-smoke-session.test.mjs
```

```bash
node scripts/ops/dingtalk-p4-regression-gate.mjs --profile ops
```

```bash
git diff -- . \
  | rg '^+' \
  | rg -n '<strict secret value pattern>' \
  || true
```

## Observed Results

```text
node --test scripts/ops/dingtalk-p4-evidence-record.test.mjs scripts/ops/compile-dingtalk-p4-smoke-evidence.test.mjs scripts/ops/dingtalk-p4-remote-smoke.test.mjs scripts/ops/dingtalk-p4-smoke-session.test.mjs
tests 66
pass 66
fail 0
```

```text
dingtalk-p4-regression-gate --profile ops: pass
```

```text
git diff --check: pass
secret value pattern scan: 0 matches
```

## Regression Coverage Added

- `dingtalk-p4-evidence-record rejects no-email admin evidence for a different target account`
- `compile-dingtalk-p4-smoke-evidence strict mode rejects no-email admin evidence for a different target account`

## Current Closeout Status

The current DingTalk live acceptance remains `manual_pending`.

This change reduces closeout risk but does not replace the remaining manual evidence:

- Current-session DingTalk group message evidence.
- Current-session authorized-user submit evidence.
- Current-session unauthorized-user denial plus zero record insert proof.
- Strict no-email create/bind evidence for the same target emitted by the smoke session.
