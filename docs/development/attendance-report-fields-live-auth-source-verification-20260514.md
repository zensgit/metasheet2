# Attendance Report Fields Live Auth Source Verification

Date: 2026-05-14

## Result

Status: `PASS`

The attendance report fields live harness now supports explicit auth-source selection and validates local token-file configuration before touching the network in live mode. The 142 live run passed with `AUTH_SOURCE=AUTH_TOKEN_FILE` plus `API_HOST_HEADER=localhost`.

## Local Verification

```bash
node --check scripts/ops/attendance-report-fields-live-acceptance.mjs
node --check scripts/ops/attendance-report-fields-live-acceptance.test.mjs
pnpm run verify:attendance-report-fields:live:test
node --test scripts/multitable-auth.test.mjs
```

Observed result:

```text
attendance-report-fields-live-acceptance.test.mjs: 17/17 pass
scripts/multitable-auth.test.mjs: 4/4 pass
```

## 142 Live Verification

Command shape:

```bash
AUTH_SOURCE=AUTH_TOKEN_FILE \
AUTH_TOKEN_FILE=/tmp/metasheet-142-main-admin-72h.jwt \
CONFIRM_SYNC=1 \
API_BASE=http://142.171.239.56:8081 \
API_HOST_HEADER=localhost \
ORG_ID=default \
OUTPUT_DIR=/tmp/metasheet-attendance-report-fields-auth-source-142-20260514 \
TIMEOUT_MS=15000 \
pnpm run verify:attendance-report-fields:live
```

Observed result:

```json
{
  "ok": true,
  "hostHeader": "localhost",
  "authSource": "AUTH_TOKEN_FILE",
  "projectId": "default:attendance",
  "sheetId": "sheet_75b4c963aa445cf3f96d29fe",
  "viewId": "view_d1d034d6227e8cfee00460c1",
  "catalogFieldCount": 34,
  "csvFieldCount": 34
}
```

Selected checks:

```text
config.auth-source: selected=AUTH_TOKEN_FILE, present=AUTH_TOKEN_FILE, ignored=none, requested=AUTH_TOKEN_FILE
api.health: 200
api.auth.me: 200
api.report-fields.sync: 200
runner.completed: pass
```

Artifacts:

```text
/tmp/metasheet-attendance-report-fields-auth-source-142-20260514/report.json
/tmp/metasheet-attendance-report-fields-auth-source-142-20260514/report.md
```

## Local Fail-Fast Verification

Command shape:

```bash
AUTH_TOKEN_FILE=/tmp/metasheet-attendance-missing-admin.jwt \
CONFIRM_SYNC=1 \
API_BASE=http://142.171.239.56:8081 \
API_HOST_HEADER=localhost \
OUTPUT_DIR=/tmp/metasheet-attendance-report-fields-local-auth-precheck-20260514 \
TIMEOUT_MS=3000 \
pnpm run verify:attendance-report-fields:live
```

Observed result:

```text
exit=1
blocker=AUTH_TOKEN_FILE_INVALID
checks=config.required, config.auth-source, config.auth-token-file, runner.completed
```

No `api.health` check was recorded. This confirms the missing local token file is rejected before the harness calls the remote API.

Artifacts:

```text
/tmp/metasheet-attendance-report-fields-local-auth-precheck-20260514/report.json
/tmp/metasheet-attendance-report-fields-local-auth-precheck-20260514/report.md
```

## Final Gates

```bash
git diff --check
python3 - <<'PY'
import pathlib
import re
import sys

files = [
    'scripts/ops/attendance-report-fields-live-acceptance.mjs',
    'scripts/ops/attendance-report-fields-live-acceptance.test.mjs',
    'docs/development/attendance-report-fields-live-auth-source-development-20260514.md',
    'docs/development/attendance-report-fields-live-auth-source-verification-20260514.md',
]
patterns = [
    'eyJ' + r'[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}',
    'Bearer' + r'\s+[A-Za-z0-9._-]{20,}',
    'AUTH_TOKEN=' + 'eyJ',
    'TOKEN=' + 'eyJ',
    'gh' + r'[opsu]_[A-Za-z0-9_]{20,}',
]
regex = re.compile('|'.join(patterns))
hits = []
for name in files:
    path = pathlib.Path(name)
    for index, line in enumerate(path.read_text(errors='ignore').splitlines(), 1):
        if regex.search(line):
            hits.append(f'{name}:{index}')
if hits:
    print('\n'.join(hits))
    sys.exit(1)
print('secret-scan-ok')
PY
```

Expected result: no diff whitespace errors and no secret matches.

## Not Covered

- This slice does not rotate or mint attendance admin credentials.
- This slice does not change the production GitHub Actions attendance locale workflow.
- This slice does not add browser UI coverage; it only hardens the live API acceptance harness.
