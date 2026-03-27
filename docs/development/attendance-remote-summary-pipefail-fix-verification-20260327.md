# Attendance Remote Summary Pipefail Fix Verification

## Scope

Changed files:

- `.github/workflows/attendance-remote-preflight-prod.yml`
- `.github/workflows/attendance-remote-metrics-prod.yml`
- `.github/workflows/attendance-remote-storage-prod.yml`

Design reference:

- [`attendance-remote-summary-pipefail-fix-20260327.md`](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-remote-followup-20260327/docs/development/attendance-remote-summary-pipefail-fix-20260327.md)

## Evidence

Historical failure evidence that motivated this fix:

- preflight log showed `PREFLIGHT_RC: 0` while the `Write step summary` step failed with `exit code 141`
- metrics log showed `METRICS_RC: 0` while the `Write step summary` step failed with `exit code 141`
- the failure came from `awk ... | head -n ...` under `set -euo pipefail`

This patch removes that pipeline shape from all three affected summary steps.

## Commands Run

```sh
git diff --check
rg -n "head -n" .github/workflows/attendance-remote-preflight-prod.yml .github/workflows/attendance-remote-metrics-prod.yml .github/workflows/attendance-remote-storage-prod.yml
claude -p "You are reviewing a minimal GitHub Actions fix in metasheet2..."
```

## Results

- `git diff --check`: passed
- `rg -n "head -n" ...`: no matches in the three updated workflows
- Claude Code: `safe, minimal fix that eliminates the SIGPIPE/exit-141 under set -euo pipefail`

## Validation Conclusion

This is a safe summary-only unblock:

- no remote command behavior changed
- no threshold or probe contract changed
- only the local log-snippet extraction path was hardened against `pipefail` false negatives
