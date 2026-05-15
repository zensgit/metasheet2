# K3 WISE GATE Intake Template Verification - 2026-05-15

## Summary

This verification proves the new customer-facing GATE intake template compiles
into a live preflight packet, does not weaken the K3 WISE mock PoC chain, and
is enforced by the on-prem package verifier.

## Commands

### Fixture Contract

```bash
node --test scripts/ops/fixtures/integration-k3wise/fixture-contract.test.mjs
```

Result:

```text
tests 3
pass 3
fail 0
```

The new test asserts:

- `_instructions.secretPlaceholder` is `<fill-outside-git>`.
- A.1 and A.6 customer sections are present.
- `buildPacket(template)` returns `status=preflight-ready`.
- Save-only remains enforced.
- SQL Server mode is `disabled`.
- material and BOM pipelines are generated.
- the generated packet does not contain `<fill-outside-git>`.

### Live Preflight CLI

```bash
node scripts/ops/integration-k3wise-live-poc-preflight.mjs \
  --input scripts/ops/fixtures/integration-k3wise/gate-intake-template.json \
  --out-dir /tmp/ms2-gate-intake-template-packet
```

Result:

```json
{
  "status": "preflight-ready",
  "sqlServerMode": "disabled",
  "externalSystems": 2,
  "pipelines": 2,
  "secretPlaceholderPresent": false
}
```

### K3 WISE Offline PoC Regression

```bash
pnpm verify:integration-k3wise:poc
```

Result:

```text
live-poc-preflight.test.mjs: 21/21 pass
live-poc-evidence.test.mjs: 50/50 pass
fixture-contract.test.mjs: 3/3 pass
mock-k3-webapi-server.test.mjs: 4/4 pass
mock-sqlserver-executor.test.mjs: 12/12 pass
run-mock-poc-demo.mjs: PASS
```

### Package Verifier Smoke

Baseline official package used for the package-layout smoke:

```text
Workflow: Multitable On-Prem Package Build
Run: 25911075364
URL: https://github.com/zensgit/metasheet2/actions/runs/25911075364
Head SHA: 48a71dd2d4c9f4c2400003448eeaf39bd2b9dd23
Conclusion: success
Artifact: multitable-onprem-package-25911075364-1
```

The official zip was extracted, this PR's template/runbook/verifier files were
overlaid into the package root, and the updated verifier was run against the
resulting smoke archive:

```bash
VERIFY_REPORT_JSON=/tmp/ms2-gate-intake-package-smoke/gate-intake-smoke.verify.json \
VERIFY_REPORT_MD=/tmp/ms2-gate-intake-package-smoke/gate-intake-smoke.verify.md \
  scripts/ops/multitable-onprem-package-verify.sh \
  /tmp/ms2-gate-intake-package-smoke/metasheet-multitable-onprem-v2.5.0-gate-intake-smoke.zip
```

Result:

```json
{
  "ok": true,
  "archiveType": "zip",
  "requiredCount": 72,
  "checks": [
    { "name": "checksum", "status": "PASS" },
    { "name": "required-content", "status": "PASS" },
    { "name": "no-github-links", "status": "PASS" }
  ]
}
```

This smoke verifies the package verifier contract. A fresh official package
build after merge remains the authoritative full-build artifact.

### Hygiene

```bash
git diff --check
```

Result: exit 0.

Template secret scan:

```json
{
  "rawUrlSecret": false,
  "rawJwt": false,
  "rawPg": false,
  "forbiddenSecretValue": false
}
```
