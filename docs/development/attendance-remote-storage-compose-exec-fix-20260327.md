# Attendance Remote Storage Compose Exec Fix

## Context

After the deploy chain was fully recovered, a separate production workflow still failed:

- `Attendance Remote Storage Health (Prod)`

The remote storage log shows the actual storage check reaches the fallback path that execs into the backend container, then fails with:

- `unknown shorthand flag: 'f' in -f`

That means the script is no longer failing on storage capacity itself. It is failing while composing the Docker CLI invocation for backend exec.

## Root cause

`scripts/ops/attendance-check-storage.sh` resolves the compose command as either:

- `docker compose`
- `docker-compose`

but later feeds that string through a single `eval ... "${COMPOSE_CMD} -f ... exec ..."` path.

In the failing production run, that string-based execution degraded into a plain `docker -f ...` parse path, which Docker rejects.

## Goal

Keep the storage check behavior the same, but make backend exec deterministic across both compose variants.

## Design

Replace the string-based `eval` execution path with explicit command branches:

- if `COMPOSE_CMD == "docker compose"`:
  - run `docker compose -f "$COMPOSE_FILE" exec -T backend sh -lc "$cmd"`
- if `COMPOSE_CMD == "docker-compose"`:
  - run `docker-compose -f "$COMPOSE_FILE" exec -T backend sh -lc "$cmd"`

If neither variant matches, fail fast with an explicit unsupported-compose error.

## Why this is the right slice

- It only changes the backend-exec transport in the storage workflow helper.
- It does not change thresholds, parsing, metrics, or storage policy.
- It removes the same class of string-wrapper ambiguity that already caused earlier deploy issues.
