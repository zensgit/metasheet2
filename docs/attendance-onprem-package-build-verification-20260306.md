# Attendance On-Prem Package Build Verification (2026-03-06)

## Scope

- Add package build/verify flow for on-prem delivery without `git pull`.
- Verify package archive generation and checksum/content validation.

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2
chmod +x \
  scripts/ops/attendance-onprem-package-build.sh \
  scripts/ops/attendance-onprem-package-verify.sh \
  scripts/ops/attendance-onprem-package-install.sh \
  scripts/ops/attendance-onprem-package-upgrade.sh

bash -n scripts/ops/attendance-onprem-package-build.sh
bash -n scripts/ops/attendance-onprem-package-verify.sh
bash -n scripts/ops/attendance-onprem-package-install.sh
bash -n scripts/ops/attendance-onprem-package-upgrade.sh

PACKAGE_TAG=20260306-r1 scripts/ops/attendance-onprem-package-build.sh
scripts/ops/attendance-onprem-package-verify.sh \
  output/releases/attendance-onprem/metasheet-attendance-onprem-v2.5.0-20260306-r1.tgz
```

## Result

- Syntax checks: PASS
- Package build: PASS
- Package verify (sha + required file set): PASS

## Evidence

- `output/releases/attendance-onprem/metasheet-attendance-onprem-v2.5.0-20260306-r1.tgz`
- `output/releases/attendance-onprem/metasheet-attendance-onprem-v2.5.0-20260306-r1.tgz.sha256`
- `output/releases/attendance-onprem/SHA256SUMS`
- `output/releases/attendance-onprem/metasheet-attendance-onprem-v2.5.0-20260306-r1.json`

## Notes

- Database instance creation is still external (`CREATE DATABASE` by DBA/installer).
- Install/upgrade scripts run migrations and create/upgrade all schema objects in an existing database.
