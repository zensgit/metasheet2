# Attendance Remote Storage Workflow Checkout

## Background

`#558` moved the storage health workflow to execute the current repository copy of `scripts/ops/attendance-check-storage.sh` on the remote host. The first post-merge validation run then failed earlier on the GitHub runner:

```text
scripts/ops/attendance-check-storage.sh: No such file or directory
```

## Root Cause

`attendance-remote-storage-prod.yml` did not check out the repository before trying to read:

```sh
base64 < scripts/ops/attendance-check-storage.sh
```

That path only exists on the runner after `actions/checkout`.

## Design

Keep the fix minimal and storage-only:

1. Add `actions/checkout@v4` to the `storage` job.
2. Leave remote execution, summary logic, and host-sync behavior unchanged.
3. Keep the workflow self-sufficient on the runner before it packages the latest storage check script.
