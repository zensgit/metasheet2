# Bridge Agent Package Verify Runbook Gate Hotfix - verification - 2026-05-21

## Workflow failure reproduced from GitHub logs

Run:

```text
Multitable On-Prem Package Build / 26214139593
```

Head:

```text
8775769611da2b48ac0d42bd571bd3593049e361
```

Failure:

```text
metasheet-multitable-onprem-v2.5.0-bridge-agent-877576961.tgz: OK
[multitable-onprem-package-verify] ERROR: Bridge Agent driver smoke runbook must preserve the BA-M1 gate
```

This proves the archive was produced and checksum verification passed before
the Bridge Agent verifier failed.

## Marker verification

The packaged source runbook contains the BA-M1 gate, but the wording spans a
line break:

```text
Until this smoke returns `decision=PASS`, **BA-M1 (Bridge Agent MVP
implementation) does not start**.
```

Static checks against the source tree:

| Check | Expected |
| --- | --- |
| `docs/operations/bridge-agent-driver-smoke-runbook-20260520.md` contains `does not start` | PASS |
| `scripts/ops/multitable-onprem-package-verify.sh` checks `does not start` | PASS |
| `docs/operations/bridge-agent-driver-smoke-runbook-20260520.md` contains `Secret hygiene` | PASS |
| `scripts/ops/multitable-onprem-package-verify.sh` checks `Secret hygiene` | PASS |
| `scripts/ops/fixtures/bridge-agent-driver-smoke/evidence.template.md` contains `BA-M0.5 Driver Smoke Evidence` | PASS |
| `scripts/ops/multitable-onprem-package-verify.sh` checks `BA-M0.5 Driver Smoke Evidence` | PASS |
| old contiguous marker is no longer required by the verifier | PASS |

The `Secret hygiene` check replaces the stale phrase `Do not paste raw evidence
into GitHub`, which is not present in the operator runbook. The runbook's real
hygiene section is stricter and covers Git, issue comments, PR bodies, and
evidence files.

The `BA-M0.5 Driver Smoke Evidence` check replaces the stale phrase
`Driver Smoke Evidence Template`, which is not present in the Markdown fixture.

## Local checks

Run from the hotfix worktree:

```bash
bash -n scripts/ops/multitable-onprem-package-verify.sh
git diff --check origin/main...HEAD
```

Expected:

```text
PASS
PASS
```

## Local package verify

The isolated worktree did not have local `node_modules`, so a direct
`BUILD_WEB=1 BUILD_BACKEND=1` build failed before package verification with
`vue-tsc: command not found`. To keep this hotfix focused on package verifier
behavior, the existing local `apps/web/dist` and `packages/core-backend/dist`
artifacts from the main checkout were copied into the isolated worktree and
the same packaging path was run with `BUILD_WEB=0 BUILD_BACKEND=0`.

Command shape:

```bash
INSTALL_DEPS=0 BUILD_WEB=0 BUILD_BACKEND=0 \
  PACKAGE_TAG=bridge-agent-hotfix2-local \
  scripts/ops/multitable-onprem-package-build.sh

VERIFY_REPORT_JSON=/tmp/ms2-bridge-agent-package-hotfix2-tgz.verify.json \
VERIFY_REPORT_MD=/tmp/ms2-bridge-agent-package-hotfix2-tgz.verify.md \
  scripts/ops/multitable-onprem-package-verify.sh \
  output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-bridge-agent-hotfix2-local.tgz

VERIFY_REPORT_JSON=/tmp/ms2-bridge-agent-package-hotfix2-zip.verify.json \
VERIFY_REPORT_MD=/tmp/ms2-bridge-agent-package-hotfix2-zip.verify.md \
  scripts/ops/multitable-onprem-package-verify.sh \
  output/releases/multitable-onprem/metasheet-multitable-onprem-v2.5.0-bridge-agent-hotfix2-local.zip
```

Result:

```text
metasheet-multitable-onprem-v2.5.0-bridge-agent-hotfix2-local.tgz: OK
[multitable-onprem-package-verify] Package verify OK
metasheet-multitable-onprem-v2.5.0-bridge-agent-hotfix2-local.zip: OK
[multitable-onprem-package-verify] Package verify OK
```

## Package workflow expectation

After this hotfix merges, rerun:

```bash
gh workflow run "Multitable On-Prem Package Build" \
  --repo zensgit/metasheet2 \
  --ref main \
  -f package_tag=bridge-agent-<short-sha> \
  -f publish_release=true \
  -f release_tag=multitable-onprem-bridge-agent-20260521-<short-sha> \
  -f release_name="Multitable On-Prem Bridge Agent 2026-05-21 (<short-sha>)"
```

The expected result is:

- package archives are built;
- package verifier passes for `.tgz`;
- package verifier passes for `.zip`;
- GitHub Release assets are uploaded;
- downloaded zip/tgz pass `multitable-onprem-package-verify.sh` locally.

## Secret hygiene

This verification contains only workflow IDs, commit IDs, path names, and
static marker text. It contains no SQL host, SQL database name, username,
password, token, K3 credential, or connection string.

## Out of scope

- No Bridge Agent BA-M1 runtime change.
- No SQL driver behavior change.
- No customer database connection test.
- No K3 Save / Submit / Audit.
- No customer GATE status change.
