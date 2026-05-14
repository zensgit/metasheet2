# Attendance Locale zh Smoke Auth Resolver Verification - 2026-05-14

## Result

Status: `PASS - source verified and merged; live prod rerun is blocked by missing/invalid credentials`

The workflow now uses the shared attendance auth resolver before running the zh-locale smoke. The latest observed production failure was caused by stale token configuration plus missing login fallback fields. This change makes that failure path deterministic and redacted, while allowing valid token, refresh, or login fallback to proceed to the real smoke.

Post-merge update: PR `#1531` was squash-merged to `main` at `6ebd91e65fc06c24d90fe2b184450f716bd30362`. A later `main` commit (`c4e026efbcc741fa8764587dad33171dbd494c87`) was present when the live workflow was rerun; the auth resolver change remains included in that head.

## Baseline Failure Evidence

- Workflow: `Attendance Locale zh Smoke (Prod)`
- Latest failed run inspected: `25839971449`
- Head SHA: `94c4694599f91819539a4ee2f4dd1fc07fbf87fa`
- Branch: `main`
- Failure lines:
  - `AUTH_TOKEN is not usable (http_401), trying refresh/login fallback`
  - `refresh fallback failed: API /auth/refresh-token failed: HTTP 401`
  - `FAIL: AUTH_TOKEN is invalid and LOGIN_EMAIL/LOGIN_PASSWORD are missing`

## Verification Commands

```bash
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/attendance-locale-zh-smoke-prod.yml"); puts "yaml-parse-ok"'
bash -n scripts/ops/attendance-resolve-auth.sh
bash -n scripts/ops/attendance-write-auth-error.sh
node --test scripts/ops/attendance-auth-scripts.test.mjs scripts/ops/attendance-locale-zh-workflow-contract.test.mjs
python3 - <<'PY'
import pathlib
import re
import subprocess
import sys

patterns = [
    'access_' + 'token=',
    'SEC' + r'[0-9a-fA-F]{20,}',
    'eyJ' + r'[0-9A-Za-z_-]{20,}\.[0-9A-Za-z_-]{20,}',
    'Bearer' + r'\s+[A-Za-z0-9._-]{20,}',
    'ATTENDANCE_ADMIN_' + 'PASSWORD=',
]
regex = re.compile('|'.join(patterns))
files = subprocess.check_output(['git', 'diff', '--name-only', '--', '.github', 'docs', 'scripts'], text=True).splitlines()
hits = []
for name in files:
    path = pathlib.Path(name)
    if not path.is_file():
        continue
    for index, line in enumerate(path.read_text(errors='ignore').splitlines(), 1):
        if regex.search(line):
            hits.append(f'{name}:{index}')
if hits:
    print('\n'.join(hits))
    sys.exit(1)
print('secret-scan-ok')
PY
git diff --check -- .github/workflows/attendance-locale-zh-smoke-prod.yml scripts/ops/attendance-locale-zh-workflow-contract.test.mjs docs/development/attendance-locale-zh-smoke-auth-resolver-development-20260514.md docs/development/attendance-locale-zh-smoke-auth-resolver-verification-20260514.md
```

## Expected Workflow Checks

- The workflow YAML parses successfully.
- Shell syntax checks pass for the shared auth resolver and auth-error writer.
- `attendance-auth-scripts.test.mjs` and `attendance-locale-zh-workflow-contract.test.mjs` pass with `node --test`.
- Secret scan has zero real-value matches.
- Drill mode still skips real production API calls.
- On missing or invalid credentials, the workflow writes `output/playwright/attendance-locale-zh-smoke/auth-error.txt`.
- On valid credentials, the workflow exports `AUTH_TOKEN_EFFECTIVE` and runs `pnpm verify:attendance-locale-zh`.

## 142 DingTalk Directory Page Boundary

Direct public HTTP access from this workstation to `142.171.239.56:8081` still returns `curl: (52) Empty reply from server` for both `/admin/directory` and `/api/admin/directory/integrations`.

SSH from this workstation also failed with `Permission denied (publickey,password)`.

This means page-level `/admin/directory` and authenticated directory API verification must be completed through one of these paths:

- SSH tunnel from a machine with the correct 142 key.
- Server-side curl on 142.
- Existing GitHub deploy/smoke runner access if it exposes a redacted artifact.

This is a verification-access boundary, not evidence of a DingTalk directory runtime regression. The previous DingTalk directory deployment evidence remains the source of truth until page-level tunnel verification is rerun.

## Command Correction

The originally requested `pnpm exec vitest run scripts/ops/attendance-auth-scripts.test.mjs --runInBand` is not valid for this repository snapshot:

- Before dependency install, `pnpm exec vitest` failed because the clean worktree had no `node_modules`.
- After `pnpm install --frozen-lockfile`, Vitest rejected `--runInBand`.
- Without `--runInBand`, Vitest reported no suite because `attendance-auth-scripts.test.mjs` uses Node's built-in `node:test` runner.

The supported command is therefore `node --test scripts/ops/attendance-auth-scripts.test.mjs scripts/ops/attendance-locale-zh-workflow-contract.test.mjs`, which passed with 6 tests.

## Pending Live Acceptance

After this branch is merged:

- Rerun `Attendance Locale zh Smoke (Prod)` on `main`.
- If it fails, inspect `auth-error.txt` first.
- If `auth-error.txt` reports missing login fields and invalid token, rotate or configure `ATTENDANCE_ADMIN_JWT` or `ATTENDANCE_ADMIN_EMAIL` plus `ATTENDANCE_ADMIN_PASSWORD` in GitHub Secrets or Variables.
- Run `/admin/directory` page verification through SSH tunnel or server-side curl and append the redacted result to the DingTalk directory verification record.

## Post-Merge Live Workflow Rerun

- Workflow: `Attendance Locale zh Smoke (Prod)`
- Run: `25843193505`
- Trigger: `workflow_dispatch`
- Head branch: `main`
- Head SHA: `c4e026efbcc741fa8764587dad33171dbd494c87`
- Result: `failure`
- Failed step: `Resolve valid auth token`
- Smoke step: skipped, because no valid attendance admin token was resolved.
- Artifact downloaded: `attendance-locale-zh-smoke-prod-25843193505-1/auth-error.txt`

Redacted diagnostic:

```text
auth_me_last_http=401
refresh_last_http=401
login_last_http=unknown
login_email_present=false
login_password_present=false
API_BASE=http://142.171.239.56:8081/api
```

Interpretation:

- The workflow now fails in the intended resolver step instead of entering Playwright with a stale token.
- The configured token is still invalid for `/api/auth/me`.
- Refresh also returns `401`.
- GitHub Secrets/Variables do not currently expose login fallback values to this workflow.
- This is an ops credential blocker. Configure or rotate `ATTENDANCE_ADMIN_JWT`, or configure `ATTENDANCE_ADMIN_EMAIL` and `ATTENDANCE_ADMIN_PASSWORD`, then rerun the workflow.

## Conclusion

The workflow implementation is merged and behaving as designed. Full operational closure still needs valid production attendance credentials and one `/admin/directory` page/API check from an environment with working 142 access.
