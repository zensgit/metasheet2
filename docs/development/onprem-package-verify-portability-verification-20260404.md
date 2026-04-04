# On-Prem Package Verify Portability Verification

Date: 2026-04-04

## Commands

```bash
bash -n scripts/ops/attendance-onprem-package-verify.sh
git diff --check
PATH='/usr/bin:/bin' VERIFY_SHA=0 scripts/ops/attendance-onprem-package-verify.sh <synthetic-package.tgz>
```

## Results

- shell syntax check passed
- `git diff --check` passed
- a synthetic on-prem package verified successfully with `PATH` reduced to `/usr/bin:/bin`, proving the `grep` fallback works without `rg`
