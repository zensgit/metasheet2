# Design: K3 PoC On-Prem Deployment Preflight

**Date**: 2026-05-07
**Files**:
- `scripts/ops/integration-k3wise-onprem-preflight.mjs`
- `scripts/ops/integration-k3wise-onprem-preflight.test.mjs`
- `package.json` (`verify:integration-k3wise:onprem-preflight` npm script)

---

## Problem

The K3 WISE PoC is at the "ship to customer hardware" stage. Before each on-prem
test we need a fast, read-only check that the host is actually ready: env vars
are set with non-trivial values, Postgres is reachable, the in-repo migrations
are aligned with the DB on the box, the offline mock fixtures still resolve, and
— if we are about to talk to a real K3 endpoint — that the customer GATE has
supplied the K3 connection data.

Today we discover these gaps the slow way: backend boots, hits a 401 / migration
error / DNS failure during the smoke, and we lose 20–60 minutes per round.
`staging-deploy-d88ad587b-postmortem-20260426.md` and the deferred
`staging-migration-alignment` debt are both downstream symptoms of "we tried to
run before the box was ready".

## Goal

A single command — runnable before any backend service starts — that returns a
stable exit code summarising on-prem readiness:

| exit | meaning | typical cause |
|---|---|---|
| `0` | PASS | proceed with PoC test |
| `1` | FAIL | mandatory env defect (DATABASE_URL / JWT_SECRET / Postgres / fixtures) — fix first |
| `2` | GATE_BLOCKED | customer GATE answers / config still missing (live mode only) |

The PR is intentionally narrow: read-only, no new business behaviour, no touch
to `plugin-integration-core` runtime code. It complements the existing GATE-time
preflight (`integration-k3wise-live-poc-preflight.mjs`, which builds a packet
from gate answers) and the existing post-deploy smoke
(`integration-k3wise-postdeploy-smoke.mjs`, which exercises a deployed surface).
This new preflight sits between the two: "I have the box and the env, before I
start anything is the host wired up correctly?"

## Non-goals

- Running migrations, writing to any DB, calling any K3 write endpoint.
- Changing `plugin-integration-core` runtime, ERP/PLM adapters, or pipeline
  semantics.
- Replacing the existing GATE preflight or post-deploy smoke.
- Any feature that would lift the customer GATE block on Stage 1.

## Design

### Modes

- **Mock (default).** No K3 endpoint, no GATE file required. The script
  validates env, probes Postgres TCP, queries migration alignment, and confirms
  the K3 mock fixtures resolve so `run-mock-poc-demo.mjs` is runnable offline.
  Designed to be the routine "did I lay the box out right" command.
- **Live (`--live`).** Adds K3 endpoint config validation
  (`K3_API_URL` / `K3_ACCT_ID` / `K3_USERNAME` / `K3_PASSWORD`), TCP-probes the
  K3 host:port, and requires `--gate-file` pointing at the GATE answer JSON.
  Live mode never sends an HTTP request to K3 — it only confirms the host is
  reachable on the wire.

### Checks

| ID | Severity model | What it checks |
|---|---|---|
| `env.database-url` | `fail` if missing/unparseable/non-postgres | DATABASE_URL is set and uses `postgres://` or `postgresql://`. Records masked URL only. |
| `env.jwt-secret` | `fail` if missing or `< 32` chars | JWT_SECRET length only — never the value. |
| `pg.tcp-reachable` | `fail` if TCP probe errors | TCP connect to host:port from DATABASE_URL. Translates `ECONNREFUSED` / `ENOTFOUND` / `EHOSTUNREACH` / `ETIMEDOUT` into operator-readable hints. Skipped on `--skip-tcp` or when DATABASE_URL is absent. |
| `pg.migrations-aligned` | `pass` / `warn` (drift) / `fail` (tool error) / `skip` | Spawns the project's own `pnpm --filter @metasheet/core-backend exec tsx src/db/migrate.ts --list` (read-only — see below) and parses `Applied:`/`Pending:`. Reports drift (pending > 0) as `warn` with the pending migration names — drift is informational, not blocking, because the operator may legitimately be about to run migrations next. Cascades to `skip` if `pg.tcp-reachable` failed, DATABASE_URL is missing, or `pnpm`/`tsx` is not on PATH (typical on a stripped-down on-prem box that only has the built artifact). The script never blames migrations when the real problem is the box or tool layout. |
| `fixtures.k3wise-mock` | `fail` if any missing | Confirms the four mock fixture files exist so the offline smoke can run. Matches the existing `verify:integration-k3wise:poc` chain. |
| `k3.live-config` | `gate-blocked` (missing) / `pass` / `skip` (mock) | In `--live`, requires `K3_API_URL` (must be http/https), `K3_ACCT_ID`, `K3_USERNAME`, `K3_PASSWORD`. Persists only `apiUrl`, `acctId`, `usernamePresent`, `passwordPresent`. |
| `k3.live-reachable` | `fail` if TCP probe errors / `skip` | TCP probe of K3 endpoint host:port. Never an HTTP request. Skipped in mock mode. |
| `gate.file-present` | `gate-blocked` (live, no flag) / `fail` (path missing) / `pass` / `skip` (mock) | Confirms `--gate-file` exists; never reads or parses the GATE JSON to avoid loading customer secrets into our summary. |

### Severity → exit code

```
fail            → exit 1
gate-blocked    → exit 2 (only if no fail present)
pass/skip/warn  → exit 0
```

`fail` always wins over `gate-blocked` so an env defect cannot be hidden behind
a GATE-config gap.

`warn` (currently used only by `pg.migrations-aligned` when the DB is behind
code) is **informational only** and does not affect exit code. Drift is
expected when the operator is about to apply migrations next; the check exists
to surface the count and pending names so the operator chooses
deliberately, not to block the preflight.

### Read-only safety

- No DB writes. The migration check spawns the project's existing migrator with
  `--list`, which calls Kysely `getMigrations()` and prints counts; it never
  applies, never rolls back. We rely on the upstream tool's read-only contract.
- No K3 writes. The K3 reachability probe is a TCP `connect` only.
- No filesystem mutations outside `--out-dir` (default
  `artifacts/integration-k3wise-onprem-preflight/<runId>/`).

### Secret handling

- DATABASE_URL: stored only as a masked URL (password → `<redacted>`); host /
  port / database recorded for diagnostic value.
- JWT_SECRET: only the length is recorded.
- K3 credentials: only `usernamePresent: true` / `passwordPresent: true` are
  recorded — never the raw values.
- All console / Markdown output passes through `redactString`, which catches
  `?access_token=` / `?token=` / `?password=` / `?sign=` query parts, `Bearer
  …` headers, JWT-shaped tokens (`eyJ…`), and `postgres://user:pass@` URLs.

### Output

- `<out-dir>/preflight.json` — full structured summary (machine-readable).
- `<out-dir>/preflight.md` — human-readable report with checks table, per-check
  details, and a Safety Notes section (operator-friendly, attachable to PR
  evidence).
- Console writes a one-line decision plus per-check status — secrets pass
  through `redactString` before printing.

### Style alignment

- ESM `.mjs`, single file, no new runtime deps. Follows
  `scripts/ops/dingtalk-p4-smoke-preflight.mjs` for argv parsing, `addCheck`
  pattern, redaction utility, and JSON+MD pair output.
- Test file uses `node --test` with `spawnSync` invocation, mirroring
  `dingtalk-p4-smoke-preflight.test.mjs`.

## Affected files

| File | Change |
|---|---|
| `scripts/ops/integration-k3wise-onprem-preflight.mjs` | New script (~470 lines) |
| `scripts/ops/integration-k3wise-onprem-preflight.test.mjs` | New test (12 cases) |
| `package.json` | New script `verify:integration-k3wise:onprem-preflight` |

No changes to `plugins/plugin-integration-core/`, runtime code, runtime config,
or any deployment surface. CI gates are not modified.

## Deployment impact

None. This is a developer/operator tool. The migration-alignment check requires
the full monorepo checkout (`pnpm`/`tsx` on PATH) and is therefore intended to
run from a workstation or CI host with a `pnpm install` already completed. On a
stripped-down on-prem box that only has the built artifact, the check
self-skips with an actionable hint — the rest of the preflight (env validation,
Postgres TCP probe, fixture and live-config checks) is fully usable. No image
change, no DB change, no service rewire.

## Customer GATE status

PR is **outside** the GATE block. It does not add real ERP business behaviour,
does not touch integration-core, does not lift Stage 1 Lock. It only makes the
existing PoC easier to deploy correctly. Stage 1 Lock memory remains in force.
