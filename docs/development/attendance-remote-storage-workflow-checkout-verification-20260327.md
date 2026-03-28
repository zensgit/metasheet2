# Attendance Remote Storage Workflow Checkout Verification

## Scope

Changed files:

- `.github/workflows/attendance-remote-storage-prod.yml`
- `docs/development/attendance-remote-storage-workflow-checkout-20260327.md`

## Failure Baseline

Manual workflow_dispatch run `23653849775` failed before SSH execution reached the remote host logic:

```text
/home/runner/work/_temp/...sh: line 18: scripts/ops/attendance-check-storage.sh: No such file or directory
```

This proved the previous storage-script-sync change needed a repository checkout on the GitHub runner.

## Commands Run

```sh
git diff --check
rg -n "Check out repository|actions/checkout@v4|storage_script_b64" .github/workflows/attendance-remote-storage-prod.yml
```

## Results

- `git diff --check`: passed
- workflow now checks out the repository before reading `scripts/ops/attendance-check-storage.sh`

## Validation Conclusion

This is the minimal runner-side fix needed to make the storage-script-sync path executable.
