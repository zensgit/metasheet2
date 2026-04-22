# On-Prem Bootstrap Hardening

- **Branch**: `codex/harden-onprem-bootstrap-20260422`
- **Date**: 2026-04-22
- **Closes**: #517, #518

## Scope

Two operator-friction bugs surfaced during Pilot R1 on-prem validation
(2026-03-20). Both are purely operational: no schema changes, no new
dependencies, no behavior change when the bootstrap scripts are used as
intended.

### #517 — `DATABASE_URL` `sslmode=disable` not documented

Local PostgreSQL typically does not enable SSL. When an operator copies
one of the `docker/app.env.*.template` files verbatim and runs
`migrate.js`, pg throws:

```
The server does not support SSL connections
```

None of the four templates mentioned the `?sslmode=disable` workaround.

### #518 — `pm2 start ecosystem.config.cjs` loses `DATABASE_URL`

The on-prem bootstrap scripts (`attendance-onprem-bootstrap.sh` etc.)
`source docker/app.env` before invoking PM2. An operator running
`pm2 start ecosystem.config.cjs` directly — e.g. via a Windows scheduled
task or a fresh shell — skipped that step and the backend crash-looped:

```
Error: Secret not found for key: DATABASE_URL
```

The previous `ecosystem.config.cjs` only set `NODE_ENV`; every other
variable was expected to already be in `process.env`.

## Fixes

### ecosystem.config.cjs — inline env loader (closes #518)

`ecosystem.config.cjs` now reads `docker/app.env` at config-parse time
and populates `process.env` (without overriding anything already set
by the shell). PM2 forks the backend with those vars inherited, so
both the bootstrap path and the direct `pm2 start` path produce the
same runtime env.

Why inline instead of `dotenv`:
- Zero new dependencies — on-prem images stay lean.
- The templates use a simple `KEY=value` shape that doesn't need `${var}`
  expansion. A 30-line parser is enough and keeps the contract honest
  (operators can still `source` the file from bash and get identical
  results).

Semantics (covered by tests):
- Comments (`#`) and blank lines skipped.
- `=` inside values preserved.
- Single/double quotes around values stripped (bash-like).
- Shell env wins over file values — a `DATABASE_URL=...` exported before
  `pm2 start` is not overridden.
- Missing file = silent no-op. Dev machines and CI (which never write
  `docker/app.env`) are unaffected.

### docker/app.env.*.template — sslmode note (closes #517)

All four operator-facing env templates now explain the
`?sslmode=disable` suffix on the `DATABASE_URL` line:

```env
# If the target PostgreSQL does not have SSL enabled (typical for local /
# on-prem dev), append `?sslmode=disable` to DATABASE_URL to avoid
# migrate.js failing with "The server does not support SSL connections".
DATABASE_URL=postgres://metasheet:change-me@127.0.0.1:5432/metasheet
```

Touched templates:
- `docker/app.env.example`
- `docker/app.env.attendance-onprem.template`
- `docker/app.env.multitable-onprem.template`
- `docker/app.staging.env.example`

## Tests

New: `scripts/ops/ecosystem-env-loader.test.mjs` (Node built-in test
runner). Spawns a fresh `node` child in a temp dir to exercise the
exact code path PM2 takes when it `require`s the config. 7 cases:

- populates `process.env` from `docker/app.env`
- skips comments and blank lines
- strips single/double quotes (bash-like)
- preserves `=` inside values
- preserves empty values
- does NOT override shell env values
- is a silent no-op when `docker/app.env` is missing

Run:

```bash
node --test scripts/ops/ecosystem-env-loader.test.mjs
```

## Risk

- **Bootstrap scripts path** — unchanged. `attendance-onprem-bootstrap.sh`
  still `source`s the env file; the inline loader then finds every key
  already in `process.env` and skips the assignment (shell wins).
- **Missing env file** — in dev and CI there is no `docker/app.env`.
  The `fs.existsSync` guard makes the loader a no-op, behavior unchanged.
- **Format drift** — if someone starts using `${VAR}` expansion in the
  templates, the inline parser will NOT expand it. Current templates do
  not rely on expansion. If that need appears, switch to `dotenv-expand`
  in a follow-up.
- **PM2 config semantics** — the `env: { NODE_ENV: 'development' }` block
  is unchanged. PM2 merges it on top of the inherited `process.env`,
  so `NODE_ENV` still wins when you run with `--env production`.
