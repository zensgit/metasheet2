# Attendance Remote Storage Compose Exec Fix Verification

## Source evidence

Failing run:

- `Attendance Remote Storage Health (Prod) #23629425244`

Artifact used:

- `output/playwright/ga/23629425244/attendance-remote-storage-prod-23629425244-1/storage.log`

Observed failure:

- `unknown shorthand flag: 'f' in -f`
- `[attendance-storage] ERROR: Failed to compute storage metrics via backend exec (rc=125).`

## Commands run

### Passed

```bash
git diff --check
```

```bash
bash -n scripts/ops/attendance-check-storage.sh
```

```bash
rg -n "docker compose -f|docker-compose -f|unsupported compose command" \
  scripts/ops/attendance-check-storage.sh
```

### Evidence inspected

```bash
sed -n '1,220p' output/playwright/ga/23629425244/attendance-remote-storage-prod-23629425244-1/storage.log
```

## Conclusion

The failing path was not storage pressure. It was the backend exec wrapper.

The patch removes the string-`eval` compose execution path and replaces it with explicit command branches for:

- `docker compose`
- `docker-compose`

This is the minimal fix needed to move the workflow back to real storage-health evaluation.
