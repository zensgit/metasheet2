# Bridge Agent Package Verify Hotfix Verification

Date: 2026-05-21

## Failing Evidence

Official workflow run:

- `Multitable On-Prem Package Build`
- run id: `26213425043`
- main SHA: `663e7646e`
- failure step: `Build on-prem package`
- exact verifier error:

```text
[multitable-onprem-package-verify] ERROR: Bridge Agent driver smoke JSON evidence template must be packaged
```

The run log shows the package archives were created before the verifier failed,
which confirms this was a verification marker problem rather than a package
builder crash.

## Local Verification

Commands:

```bash
bash -n scripts/ops/multitable-onprem-package-verify.sh
git diff --check origin/main...HEAD
rg -n '"spec": "ba-m0.5-driver-smoke"|"<PASS \\| FAIL>"|"sqlServerVersionRedacted"' \
  scripts/ops/fixtures/bridge-agent-driver-smoke/evidence.template.json \
  scripts/ops/multitable-onprem-package-verify.sh
```

## Result

| Command | Result |
| --- | --- |
| `bash -n scripts/ops/multitable-onprem-package-verify.sh` | PASS |
| `git diff --check origin/main...HEAD` | PASS, rc=0 |
| `rg -n '"spec": "ba-m0.5-driver-smoke"\|"<PASS \\| FAIL>"\|"sqlServerVersionRedacted"' ...` | PASS, template + verifier markers found |
| secret-shape scan over changed files | PASS, 0 hits |
