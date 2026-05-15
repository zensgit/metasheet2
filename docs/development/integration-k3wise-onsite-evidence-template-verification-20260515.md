# K3 WISE On-Site Evidence Template Verification - 2026-05-15

## Summary

This verification proves the new C4-C9 worksheet is safe before completion,
can reach PASS after completion, keeps the K3 WISE PoC chain green, and is
enforced by the on-prem package verifier.

## Commands

### Fixture Contract

```bash
node --test scripts/ops/fixtures/integration-k3wise/fixture-contract.test.mjs
```

Result:

```text
tests 4
pass 4
fail 0
```

The new fixture test asserts the worksheet:

- equals `sampleOnsiteEvidenceTemplate()`;
- contains C4 and C9 section hints;
- compiles to `decision=PARTIAL`;
- emits zero issues before completion;
- has `materialSaveOnly` and `bomPoC` in `todo` state initially;
- reaches `decision=PASS` after it is filled with canonical sample evidence.

### Evidence CLI

```bash
node --test scripts/ops/integration-k3wise-live-poc-evidence.test.mjs
```

Result:

```text
tests 51
pass 51
fail 0
```

The new CLI test covers `--print-onsite-evidence-template`, parses the printed
JSON, compiles it to `PARTIAL`, and verifies no bearer or URL-token strings are
present.

### Direct Template Smoke

```bash
node scripts/ops/integration-k3wise-live-poc-preflight.mjs \
  --input scripts/ops/fixtures/integration-k3wise/gate-sample.json \
  --out-dir /tmp/ms2-live-evidence-template-packet

node scripts/ops/integration-k3wise-live-poc-evidence.mjs \
  --packet /tmp/ms2-live-evidence-template-packet/integration-k3wise-live-poc-packet.json \
  --evidence scripts/ops/fixtures/integration-k3wise/evidence-onsite-c4-c9-template.json \
  --out-dir /tmp/ms2-live-evidence-template-report
```

Result:

```json
{
  "decision": "PARTIAL",
  "issues": 0,
  "phases": [
    "gate:todo",
    "plmConnection:todo",
    "k3Connection:todo",
    "sqlConnection:todo",
    "materialDryRun:todo",
    "materialSaveOnly:todo",
    "erpFeedback:todo",
    "deadLetterReplay:todo",
    "bomPoC:todo",
    "rollback:todo",
    "customerConfirmation:todo"
  ]
}
```

### K3 WISE Offline PoC Regression

```bash
pnpm verify:integration-k3wise:poc
```

Result:

```text
live-poc-preflight.test.mjs: 21/21 pass
live-poc-evidence.test.mjs: 51/51 pass
fixture-contract.test.mjs: 4/4 pass
mock-k3-webapi-server.test.mjs: 4/4 pass
mock-sqlserver-executor.test.mjs: 12/12 pass
run-mock-poc-demo.mjs: PASS
```

### Package Verifier Smoke

Baseline official package used for the package-layout smoke:

```text
Workflow: Multitable On-Prem Package Build
Run: 25911967962
Head SHA: 4af57059d26d159a0cc6836c834066a04e26e921
Conclusion: success
Artifact: multitable-onprem-package-25911967962-1
```

The official zip was extracted, this PR's worksheet/runbook/verifier files
were overlaid into the package root, and the updated verifier was run against
the resulting smoke archive.

Result:

```json
{
  "ok": true,
  "archiveType": "zip",
  "requiredCount": 73,
  "checks": [
    { "name": "checksum", "status": "PASS" },
    { "name": "required-content", "status": "PASS" },
    { "name": "no-github-links", "status": "PASS" }
  ]
}
```

### Hygiene

```bash
git diff --check
bash -n scripts/ops/multitable-onprem-package-build.sh scripts/ops/multitable-onprem-package-verify.sh
```

Result: both pass.

Template secret scan:

```json
{
  "rawUrlSecret": false,
  "rawJwt": false,
  "rawPg": false,
  "bearer": false,
  "forbiddenSecretValue": false
}
```
