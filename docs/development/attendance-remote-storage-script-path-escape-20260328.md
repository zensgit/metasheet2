# Attendance Remote Storage Script Path Escape

## Background

After `#559` added repository checkout, the next validation run of `Attendance Remote Storage Health (Prod)` still failed before the remote storage script executed.

Observed runner-side error from run `23672540066`:

```text
line 88: storage_script_path: unbound variable
```

## Root Cause

The workflow builds `remote_cmds` under `set -u`. One command entry used:

```sh
" ... \"${storage_script_path}\""
```

Because that array entry is double-quoted on the runner, `${storage_script_path}` was expanded locally while the variable only exists later on the remote host.

## Design

Keep the fix to a single interpolation boundary:

1. Preserve all current storage-script-sync behavior.
2. Escape the reference as `\"\${storage_script_path}\"` so it survives local interpolation.
3. Let the variable expand only on the remote host, after the temp file has been created.
