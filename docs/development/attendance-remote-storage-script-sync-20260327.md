# Attendance Remote Storage Script Sync

## Background

After `#556` fixed `attendance-check-storage.sh` in the repository and `#557` fixed summary false negatives, a manual validation run of `Attendance Remote Storage Health (Prod)` still failed on `main`.

Observed evidence from run `23653446366`:

- host sync reported `DEPLOY_PATH is not a git repo`
- the remote job continued with existing files
- storage then failed with:

```text
unknown shorthand flag: 'f' in -f
[attendance-storage] ERROR: Failed to compute storage metrics via backend exec (rc=125).
```

This means the workflow was still executing an old copy of `scripts/ops/attendance-check-storage.sh` on the remote host.

## Root Cause

The workflow already tolerates non-git deploy roots:

- if `DEPLOY_PATH` is not a git repo, host sync is skipped and the workflow continues

That fallback is safe for checks whose remote script has not changed, but it becomes stale as soon as the repository script is fixed and the remote host keeps an older copy.

## Design

Keep the fix storage-only and workflow-local:

1. Do not change global host-sync policy.
2. Do not require the deploy host to become a git repo.
3. Before building `remote_cmds`, base64-encode the current repository copy of `scripts/ops/attendance-check-storage.sh`.
4. On the remote host, write that payload to a temporary executable file in `/tmp`.
5. Execute the temporary script instead of `scripts/ops/attendance-check-storage.sh`.
6. Remove the temporary file after the check finishes.

## Why This Scope

This is the smallest unblock for the only remaining known failing attendance prod check:

- `Preflight`: already green
- `Metrics`: already green
- `Storage`: blocked specifically by stale remote script execution

## Expected Outcome

- remote storage checks always run the current repository implementation
- non-git deploy roots stop masking repository-side storage fixes
- no behavior change for preflight or metrics workflows
