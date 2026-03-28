# Attendance Remote Storage Script Path Escape Verification

## Scope

Changed files:

- `.github/workflows/attendance-remote-storage-prod.yml`
- `docs/development/attendance-remote-storage-script-path-escape-20260328.md`

## Failure Baseline

Manual run `23672540066` failed on the GitHub runner with:

```text
line 88: storage_script_path: unbound variable
```

This happened before the remote command block could finish and therefore `storage_rc` never reached `$GITHUB_OUTPUT`.

## Commands Run

```sh
git diff --check
rg -n '\\$\\{storage_script_path\\}|storage_script_path' .github/workflows/attendance-remote-storage-prod.yml
```

## Results

- `git diff --check`: passed
- the execution line now preserves `${storage_script_path}` for remote expansion instead of local runner expansion

## Validation Conclusion

This is the minimal interpolation fix required to make the remote temp-script execution path actually runnable under `set -u`.
