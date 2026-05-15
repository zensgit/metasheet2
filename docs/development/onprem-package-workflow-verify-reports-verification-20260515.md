# On-Prem Package Workflow Verify Reports Verification - 2026-05-15

## Verification Date

2026-05-15T09:18:46Z

## Commands

```bash
ruby -e "require 'yaml'; YAML.load_file('.github/workflows/multitable-onprem-package-build.yml')"
rg -n "VERIFY_REPORT_JSON|PACKAGE_VERIFY_TGZ_JSON|PACKAGE_VERIFY_ZIP_JSON|output/releases/multitable-onprem/verify" \
  .github/workflows/multitable-onprem-package-build.yml
git diff --check origin/main...HEAD
```

## Expected Assertions

| Area | Assertion |
| --- | --- |
| Workflow syntax | GitHub Actions YAML parses successfully. |
| Verifier command | Both `.tgz` and `.zip` verifier runs set `VERIFY_REPORT_JSON` and `VERIFY_REPORT_MD`. |
| Artifact upload | Workflow artifact includes `output/releases/multitable-onprem/verify/*.json` and `*.md`. |
| Release publish | `publish_release=true` includes all four verifier reports in release assets. |
| Step summary | Summary prints the tgz/zip verifier JSON paths. |

## Local Results

| Command | Result |
| --- | --- |
| `ruby -e "require 'yaml'; YAML.load_file(...)"` | PASS |
| `rg ... workflow contract scan` | PASS |
| `git diff --check origin/main...HEAD` | PASS |
| secret-pattern scan over workflow and docs | PASS, 0 matches |

## Deployment Impact

- No runtime change.
- No package-content change.
- No migration.
- Next official package workflow artifact gains four verifier report files.
- Release publishing gains four verifier report assets when enabled.

## Secret Hygiene

The verifier reports are structural package evidence. They contain package
names, archive type, check names, and paths; they do not contain K3 credentials,
MetaSheet bearer tokens, SQL connection strings, or passwords.
