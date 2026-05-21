# Bridge Agent Package Verify Verification

Date: 2026-05-21

## Commands

```bash
bash -n scripts/ops/multitable-onprem-package-build.sh
bash -n scripts/ops/multitable-onprem-package-verify.sh
git diff --check origin/main...HEAD
```

Static marker checks:

```bash
rg -n "bridge-agent-driver-smoke.ps1|bridge-agent-readonly.ps1|bridge-agent-readonly-runbook-20260521.md" \
  scripts/ops/multitable-onprem-package-build.sh \
  scripts/ops/multitable-onprem-package-verify.sh

rg -n "verify_bridge_agent_tooling_contract|RAW_SQL_REJECTED|SELECT TOP \\$Limit|System.Data.SqlClient.SqlConnection|v_MetaSheet_MaterialRead" \
  scripts/ops/multitable-onprem-package-verify.sh
```

## Local Result

| Command | Result |
| --- | --- |
| `bash -n scripts/ops/multitable-onprem-package-build.sh` | PASS |
| `bash -n scripts/ops/multitable-onprem-package-verify.sh` | PASS |
| `git diff --check origin/main...HEAD` | PASS, rc=0 |
| static marker check for Bridge Agent required paths | PASS, build + verify scripts both reference the BA-M0.5/BA-M1 files |
| static marker check for `verify_bridge_agent_tooling_contract` | PASS, verifier checks provider, localhost, raw-SQL rejection, bounded SELECT, and readonly-view config markers |
| secret-shape scan over changed files | PASS, 0 hits |

## Packaging Note

The isolated worktree used for this PR does not have `node_modules`,
`apps/web/dist`, or `packages/core-backend/dist`, so a full local on-prem package
build was not executed here. The real zip/tgz inclusion is covered by the
official GitHub "Multitable On-Prem Package Build" workflow after merge.

This PR still adds deterministic package verifier assertions, so a future
official package missing the Bridge Agent files or contract markers will fail
`multitable-onprem-package-verify.sh`.
