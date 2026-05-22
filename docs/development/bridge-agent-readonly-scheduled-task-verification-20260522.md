# Bridge Agent Readonly Scheduled Task Verification

Date: 2026-05-22

## Local Commands

Commands run from repo root:

```bash
node --test \
  scripts/ops/bridge-agent-readonly-contract.test.mjs \
  scripts/ops/bridge-agent-readonly-task-contract.test.mjs

bash -n \
  scripts/ops/multitable-onprem-package-build.sh \
  scripts/ops/multitable-onprem-package-verify.sh

git diff --check origin/main...HEAD
```

Package build and verify:

```bash
OUTPUT_DIR=/tmp/ms2-bridge-agent-task-package \
PACKAGE_TAG=bridge-task-local \
BUILD_WEB=1 \
BUILD_BACKEND=1 \
  scripts/ops/multitable-onprem-package-build.sh

VERIFY_REPORT_JSON=/tmp/ms2-bridge-agent-task-package/verify-zip.json \
VERIFY_REPORT_MD=/tmp/ms2-bridge-agent-task-package/verify-zip.md \
  scripts/ops/multitable-onprem-package-verify.sh \
  /tmp/ms2-bridge-agent-task-package/metasheet-multitable-onprem-v2.5.0-bridge-task-local.zip

VERIFY_REPORT_JSON=/tmp/ms2-bridge-agent-task-package/verify-tgz.json \
VERIFY_REPORT_MD=/tmp/ms2-bridge-agent-task-package/verify-tgz.md \
  scripts/ops/multitable-onprem-package-verify.sh \
  /tmp/ms2-bridge-agent-task-package/metasheet-multitable-onprem-v2.5.0-bridge-task-local.tgz

zipinfo -1 /tmp/ms2-bridge-agent-task-package/metasheet-multitable-onprem-v2.5.0-bridge-task-local.zip |
  rg 'bridge-agent-readonly-scheduled-task.ps1|bridge-agent-readonly-runbook-20260521.md'

tar -tzf /tmp/ms2-bridge-agent-task-package/metasheet-multitable-onprem-v2.5.0-bridge-task-local.tgz |
  rg 'bridge-agent-readonly-scheduled-task.ps1|bridge-agent-readonly-runbook-20260521.md'
```

Secret-shape scan over the changed files:

```bash
node <<'NODE'
const fs = require('node:fs');
const files = [
  'scripts/ops/bridge-agent-readonly-scheduled-task.ps1',
  'scripts/ops/bridge-agent-readonly-task-contract.test.mjs',
  'scripts/ops/multitable-onprem-package-build.sh',
  'scripts/ops/multitable-onprem-package-verify.sh',
  'docs/operations/bridge-agent-readonly-runbook-20260521.md',
  'docs/development/bridge-agent-readonly-scheduled-task-design-20260522.md',
  'docs/development/bridge-agent-readonly-scheduled-task-verification-20260522.md',
];
const patterns = [
  new RegExp('Bearer ' + '[A-Za-z0-9]'),
  new RegExp('ey' + 'J[A-Za-z0-9_-]{6,}\\.'),
  new RegExp('postgres' + '://[^<\\s]+'),
  new RegExp('METASHEET_BRIDGE_SQL_' + 'PASSWORD=.'),
  new RegExp('Pass' + 'word=.*;'),
];
let hits = 0;
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      console.error(`${file}: ${pattern}`);
      hits++;
    }
  }
}
process.exit(hits === 0 ? 0 : 1);
NODE
```

## Contract Matrix

| Check | Evidence |
| --- | --- |
| Persistent startup helper exists | Package build `REQUIRED_PATHS` includes `bridge-agent-readonly-scheduled-task.ps1`. |
| Runs existing agent, not a fork | Contract test asserts `bridge-agent-readonly.ps1` and `-ConfigPath` markers. |
| Windows Scheduled Task | Contract test and package verify assert `Register-ScheduledTask` and startup trigger markers. |
| Runs as SYSTEM | Contract test and package verify assert `New-ScheduledTaskPrincipal -UserId 'SYSTEM'`. |
| Secret-free status | Contract test asserts `Get-ScheduledTaskInfo`, `LastTaskResult`, and `TcpClient`; no `/health` secret header call. |
| Package regression guard | Package verify asserts helper markers, runbook section, and `INSTALL.txt` mention. |
| Operator docs | Runbook adds `Persistent Scheduled Task Start` and `Machine-level environment variables`. |

## Local Result

| Command | Result |
| --- | --- |
| `node --test scripts/ops/bridge-agent-readonly-contract.test.mjs scripts/ops/bridge-agent-readonly-task-contract.test.mjs` | PASS, 7/7 |
| `bash -n scripts/ops/multitable-onprem-package-build.sh scripts/ops/multitable-onprem-package-verify.sh` | PASS, rc=0 |
| `git diff --check origin/main...HEAD` | PASS, rc=0 |
| secret-shape scan | PASS, 0 hits |
| local package build with `BUILD_WEB=1 BUILD_BACKEND=1` | PASS, zip/tgz generated under `/tmp/ms2-bridge-agent-task-package` |
| package verify on generated zip | PASS, `Package verify OK` |
| package verify on generated tgz | PASS, `Package verify OK` |
| zip/tgz content probe | PASS, both contain `bridge-agent-readonly-scheduled-task.ps1` and updated readonly runbook |

Note: `pnpm install --frozen-lockfile` was run in the isolated worktree to
restore missing local dependencies before the package build. It changed tracked
plugin/tool `node_modules` shim files as a local install side effect; those
generated dependency changes were restored and are not part of this PR.

## Windows Host Validation

This PR is verified statically on macOS. The behavioral validation must happen
on the Windows bridge host after a package containing this helper is deployed:

```powershell
powershell -ExecutionPolicy Bypass -File C:\metasheet\scripts\ops\bridge-agent-readonly-scheduled-task.ps1 `
  -Action Install `
  -RootDir C:\metasheet `
  -ConfigPath C:\ProgramData\MetaSheet\BridgeAgent\config.json `
  -StartAfterInstall
```

Expected operator evidence:

- `State: Running`;
- `LastTaskResult: 0` after successful start;
- `Local TCP listener: 127.0.0.1:19091 reachable`;
- authenticated `/health` returns `ok=true` and `databaseReachable=true`;
- Data Factory `bridge:legacy-sql-readonly` test connection passes;
- dry-run still reads capped rows from allowlisted objects only.

## Stage Boundaries

This slice does not change Data Factory runtime behavior, SQL read semantics, or
K3 write behavior. Customer GATE and K3 Save / Submit / Audit remain blocked.
