# Attendance Remote Storage Script Sync Verification

## Scope

Changed file:

- `.github/workflows/attendance-remote-storage-prod.yml`

Design reference:

- [`attendance-remote-storage-script-sync-20260327.md`](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/attendance-remote-followup-20260327/docs/development/attendance-remote-storage-script-sync-20260327.md)

## Failure Baseline

Validated against manual run `23653446366`:

- `Attendance Remote Preflight (Prod)`: success
- `Attendance Remote Metrics (Prod)`: success
- `Attendance Remote Storage Health (Prod)`: failure

Storage failure evidence:

- host sync fell back with `DEPLOY_PATH is not a git repo`
- storage executed a stale remote script copy
- log still contained the pre-`#556` compose exec bug:

```text
unknown shorthand flag: 'f' in -f
[attendance-storage] ERROR: Failed to compute storage metrics via backend exec (rc=125).
```

## Commands Run

```sh
git diff --check
rg -n "storage_script_b64|storage_script_path|attendance-check-storage" .github/workflows/attendance-remote-storage-prod.yml
claude -p "Review this minimal unblock..."
```

## Results

- `git diff --check`: passed
- workflow now embeds the current repo copy of `attendance-check-storage.sh` and executes it via a remote temp file
- Claude Code: used to confirm this is a storage-only minimal unblock for stale non-git hosts

## Validation Conclusion

This patch closes the remaining known gap between repository fixes and non-git remote hosts for the storage health workflow without broadening host-sync behavior.
