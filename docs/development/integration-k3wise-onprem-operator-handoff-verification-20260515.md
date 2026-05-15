# K3 WISE On-Prem Operator Handoff Verification - 2026-05-15

## Summary

The checklist slice is documentation and packaging-only. Verification focused
on syntax, package required-content behavior, delivery bundle inclusion, and
secret-safety.

## Local Checks

### Diff Hygiene

Command:

```bash
git diff --check
```

Result:

```text
PASS - no whitespace or conflict-marker issues.
```

### Script Syntax

Commands:

```bash
bash -n scripts/ops/multitable-onprem-package-build.sh scripts/ops/multitable-onprem-package-verify.sh
node --check scripts/ops/multitable-onprem-delivery-bundle.mjs
```

Result:

```text
PASS - shell and Node syntax checks returned exit code 0.
```

### Legacy Filename Guard

Command:

```bash
rg -n "integration-k3wise-operator-handoff-checklist" docs/operations docs/deployment scripts || true
```

Result:

```text
PASS - no stale pre-rename path remained.
```

## Package Verifier Overlay Smoke

Used the latest successful official package artifact available locally:

```text
/tmp/ms2-onprem-package-25912550419/metasheet-multitable-onprem-v2.5.0-k3wise-onsite-evidence-d64d5697.zip
```

The verification smoke unpacked that package, overlaid the changed package
build / verify / delivery-bundle scripts plus the new checklist and updated
easy-start guide, rebuilt a zip, regenerated `SHA256SUMS`, and ran the updated
verifier.

Command shape:

```bash
VERIFY_REPORT_JSON=/tmp/ms2-operator-handoff-package-smoke/reports/package-verify-rerun.json \
VERIFY_REPORT_MD=/tmp/ms2-operator-handoff-package-smoke/reports/package-verify-rerun.md \
  scripts/ops/multitable-onprem-package-verify.sh \
  /tmp/ms2-operator-handoff-package-smoke/metasheet-multitable-onprem-v2.5.0-k3wise-onsite-evidence-d64d5697-operator-handoff-overlay.zip
```

Result:

```json
{
  "ok": true,
  "checksum": "PASS",
  "requiredContent": "PASS",
  "requiredCount": 74,
  "noGithubLinks": "PASS"
}
```

This proves the new required path and verifier guardrails can pass against the
current package layout when the checklist is included.

## Secret Scan

Scanned the new checklist for common artifact leak patterns:

- JWT-shaped values;
- raw bearer token values;
- raw `postgres://user:password@` userinfo;
- unredacted secret query parameters such as `access_token`, `token`,
  `password`, `secret`, `sign`, `signature`, `api_key`, `session_id`, and
  `auth`.

Result:

```text
jwt-shape: 0
bearer-header: 0
raw-postgres-userinfo: 0
url-query-secret-value: 0
```

## Expected CI / Package Impact

Expected CI impact is limited to docs and ops packaging checks.

Expected package impact:

- generated packages include the new handoff checklist;
- package verifier reports `required-content` count as 74;
- the Windows easy-start guide points operators to the checklist;
- delivery bundle copies the checklist with the rest of the K3 WISE runbooks.

## Not Verified Here

This workstation did not connect to a customer K3 WISE host, SQL Server, or
Windows bridge machine. Those are deployment-network checks and should be run
from the bridge machine after a package is built and installed.
