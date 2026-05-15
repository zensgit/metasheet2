# On-Prem Package Workflow Verify Reports Development - 2026-05-15

## Purpose

The K3/Data Factory delivery-readiness compiler now consumes the JSON report
from `scripts/ops/multitable-onprem-package-verify.sh` through
`--package-verify`.

Before this change, the manual `Multitable On-Prem Package Build` workflow ran
the verifier against both `.tgz` and `.zip`, but it did not persist the verifier
JSON/Markdown reports. Operators could download the package artifact and still
need to rerun the verifier locally just to get the JSON evidence required by
the readiness compiler.

This slice makes the official package workflow produce those reports as first
class artifacts.

## Changed Files

- `.github/workflows/multitable-onprem-package-build.yml`
- `docs/development/onprem-package-workflow-verify-reports-development-20260515.md`
- `docs/development/onprem-package-workflow-verify-reports-verification-20260515.md`

## Behavior

The workflow now writes:

```text
output/releases/multitable-onprem/verify/<PACKAGE_NAME>.tgz.verify.json
output/releases/multitable-onprem/verify/<PACKAGE_NAME>.tgz.verify.md
output/releases/multitable-onprem/verify/<PACKAGE_NAME>.zip.verify.json
output/releases/multitable-onprem/verify/<PACKAGE_NAME>.zip.verify.md
```

It exports those paths through `GITHUB_ENV` so later workflow steps can:

- upload them in the workflow artifact;
- publish them to GitHub Releases when `publish_release=true`;
- show the JSON paths in the step summary.

## Operator Impact

After the next official package workflow run, the downloaded artifact contains
the package and its verifier evidence together. A deployment operator can feed
the JSON directly into:

```bash
node scripts/ops/integration-k3wise-delivery-readiness.mjs \
  --package-verify output/releases/multitable-onprem/verify/<PACKAGE_NAME>.zip.verify.json \
  ...
```

No local rerun is needed unless the operator wants to re-verify a copied or
modified archive.

## Scope Boundary

This does not change package contents, package verification rules, backend
runtime behavior, migrations, frontend code, or K3/Data Factory business logic.
It only persists verifier reports that the workflow already has enough evidence
to generate.

## Claude Code

Claude Code is not required. This is a GitHub Actions packaging workflow
change, plus documentation and static validation.
