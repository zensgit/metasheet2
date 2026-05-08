# K3 PoC On-Prem Preflight Runbook

Operator guide for `scripts/ops/integration-k3wise-onprem-preflight.mjs` —
how to read its output, fix each failure mode, and run it against a
Docker-deployed metasheet without leaking secrets.

The preflight is **read-only**: no DB writes, no migration runs, no K3 API calls.

## When to run

- Before installing or starting a metasheet on-prem deployment for the first time.
- After re-pulling images on an existing box (verify env still aligns with code).
- Before any customer K3 PoC test (gate-blocked surfaces will tell you what's still missing).
- After a migration drift incident, to confirm the box is back in alignment.

## TL;DR — canonical command

```bash
cd <metasheet repo root>
node scripts/ops/integration-k3wise-onprem-preflight.mjs --mock \
  --out-dir artifacts/integration-k3wise-onprem-preflight/<runId>
```

Two artifacts are written: `preflight.json` (machine-readable) and
`preflight.md` (human-readable, attachable to PR evidence).

Add `--live` only after the customer GATE has supplied K3 connection answers.
Add `--gate-file <path>` to point at the GATE answer JSON. See
[`integration-k3wise-live-poc-preflight.mjs --print-sample`](../../scripts/ops/integration-k3wise-live-poc-preflight.mjs)
for the GATE schema.

## Exit codes

| code | meaning | action |
|---|---|---|
| `0` | PASS | Proceed with on-prem test |
| `1` | FAIL — mandatory env defect | Fix the failed checks, re-run |
| `2` | GATE_BLOCKED — customer GATE config still required | Wait for customer answers (only happens with `--live`) |

`warn` checks (currently only migration drift) do not affect exit code — they
are informational. Drift is expected if the next thing you intend to do is
apply migrations.

`fail` always wins over `gate-blocked`: an env defect cannot be hidden behind
a GATE-config gap.

## Per-check failure recipes

### `env.database-url` → `fail`

The check is `fail` when `DATABASE_URL` is missing, unparseable, or uses a
scheme other than `postgres://` / `postgresql://`.

Recipe:

1. If you ran the preflight from an SSH session that didn't load the deployed
   env, see [Running against a Docker-deployed metasheet](#running-against-a-docker-deployed-metasheet).
2. Confirm value parses: `node -e 'new URL(process.env.DATABASE_URL)'`.
3. Confirm scheme is `postgres://` or `postgresql://`.

### `env.jwt-secret` → `fail`

The check is `fail` when `JWT_SECRET` is missing or shorter than 32 chars.
Only the length is recorded in the artifact, never the value.

Recipe:

1. Generate a fresh secret: `openssl rand -hex 32` → 64-char hex.
2. Update the deployment's env source (compose `environment:` / env file /
   secrets manager).
3. Restart the backend so it picks up the new value.
4. Re-run the preflight.

### `pg.tcp-reachable` → `fail`

`details.code` is the Node `net` error code; map it to a fix:

| `details.code` | Meaning | Recipe |
|---|---|---|
| `ECONNREFUSED` | Nothing listens on host:port | Confirm Postgres is running. If Docker-deployed, the host shell may not see the container's port — see [the bridge-IP recipe](#3-recipe--host-shell-with-docker-bridge-ip). |
| `ENOTFOUND` | DNS can't resolve the hostname | Most common when the URL contains a docker-compose service name (e.g., `postgres`) and you are running outside the compose network. Use the bridge-IP recipe below. |
| `EHOSTUNREACH` | Network route absent | VPN, route table, or security group issue. |
| `ETIMEDOUT` | Firewall silently dropping packets | Open the port in the firewall, or check VPC/security-group egress. |

### `pg.migrations-aligned` → `warn` (drift)

`applied < total`. `details.pendingMigrations` lists what's missing (capped at 50).

Recipe:

1. Decide if applying is safe: mid-deploy, or trailing an older release?
2. To apply (NOT via this preflight; the preflight is read-only):
   ```bash
   pnpm --filter @metasheet/core-backend exec tsx src/db/migrate.ts
   ```
   (`--filter` makes pnpm cd into `packages/core-backend`, so `src/db/...`
   resolves there. This is the same command the preflight spawns with
   `--list` for the alignment query.)
3. Re-run the preflight to confirm `pending: 0`.

### `pg.migrations-aligned` → `skip` (various reasons)

| `details.reason` | Why | Action |
|---|---|---|
| `--skip-migrations` | You passed the flag | (no action) |
| `DATABASE_URL not set; cannot query kysely_migration` | env defect upstream | Fix `env.database-url` |
| `Postgres unreachable; skipping migration query` | TCP probe failed upstream | Fix `pg.tcp-reachable` |
| `pnpm/tsx not on PATH; …` | Stripped-down box (e.g., the slim prod image) | Re-run from a workstation / CI host with full repo + `pnpm install`, OR pass `--skip-migrations` deliberately |

### `fixtures.k3wise-mock` → `fail`

One or more of these files is missing under `scripts/ops/fixtures/integration-k3wise/`:

- `gate-sample.json`
- `mock-k3-webapi-server.mjs`
- `mock-sqlserver-executor.mjs`
- `run-mock-poc-demo.mjs`

Recipe:

1. `git status` — confirm clean checkout on a known commit.
2. `git checkout -- scripts/ops/fixtures/integration-k3wise/` to restore from index.
3. If genuinely deleted, restore from git history.

### `k3.live-config` → `gate-blocked` (only `--live`)

Customer GATE has not supplied one of: `K3_API_URL`, `K3_ACCT_ID`,
`K3_USERNAME`, `K3_PASSWORD`. `details.missing` lists which.

Recipe:

- Wait for customer GATE answers. Do **not** fabricate values to silence the
  check — `gate-blocked` exit code 2 is the correct signal to upstream
  "we can't proceed yet".
- See the GATE schema:
  `node scripts/ops/integration-k3wise-live-poc-preflight.mjs --print-sample`

### `k3.live-reachable` → `fail` (only `--live`)

TCP probe to the customer K3 endpoint failed. Same `details.code` semantics as
`pg.tcp-reachable`.

Common causes (rough order of likelihood):

1. VPN / routing to the customer LAN not yet established.
2. Customer's K3 firewall hasn't allowlisted your egress IP.
3. Wrong port — many K3 WISE WebAPI deployments listen on `:8080` or `:8088`,
   so a URL ending in just `host/K3API/` (port 80 by default) is the wrong
   target. Confirm the explicit port with the customer.

### `gate.file-present` → `gate-blocked` or `fail`

| status | reason | recipe |
|---|---|---|
| `gate-blocked` | `--live` and `--gate-file` not passed | Generate a template; fill it; pass `--gate-file <path>` |
| `fail` | path passed but doesn't exist | Fix the path; the runId in the artifact lists what was tried |

Generating a starter template:

```bash
node scripts/ops/integration-k3wise-live-poc-preflight.mjs --print-sample \
  > /tmp/gate-template.json
```

Fill in customer answers locally (do not commit secrets). Pass via
`--gate-file /tmp/<filled>.json`.

## Running against a Docker-deployed metasheet

The metasheet on-prem deployment we ship today is Docker-compose-based. The
backend container holds the runtime env, and the Postgres container is on a
docker bridge network — neither is directly visible to a plain host shell.
Three facts to know:

### 1. The compose service hostname does not resolve from the host

Inside the backend container `DATABASE_URL` typically points at a compose
service hostname like `postgres://metasheet:…@postgres:5432/metasheet`. From
the host shell that hostname is unresolvable, and the preflight's TCP probe
returns `ENOTFOUND`.

### 2. The slim prod image does not carry the preflight script

The production backend image (`ghcr.io/zensgit/metasheet2-backend:<tag>`) ships
only `dist/`, `node_modules`, and `package.json` — no `scripts/` directory.
You cannot run the preflight inside the prod container without first copying
the script in.

### 3. Recipe — host shell with docker bridge IP

This is the recipe used when first piloting the preflight against a real prod
env. It returned `PASS` with `applied: 159 / pending: 0`.

```bash
# Look up the postgres container's bridge IP. NOT a secret — just a routable
# address on this host's docker0 bridge.
PG_IP=$(docker network inspect metasheet2_default \
  --format '{{range .Containers}}{{if eq .Name "metasheet-postgres"}}{{.IPv4Address}}{{end}}{{end}}' \
  | sed 's:/.*::')

# Inherit DATABASE_URL from the running backend; swap the compose service
# hostname for the bridge IP. The substitution only touches HOST in
# postgres(ql)://USER:PASS@HOST — userinfo, port, database stay unchanged.
# Do NOT echo the raw value.
RAW=$(docker exec metasheet-backend printenv DATABASE_URL)
export DATABASE_URL=$(printf '%s' "$RAW" \
  | sed -E "s#^(postgres(ql)?://[^@]+@)[^:/]+#\1$PG_IP#")
unset RAW

# Inherit JWT_SECRET as-is.
export JWT_SECRET=$(docker exec metasheet-backend printenv JWT_SECRET)

# Run from the host's full repo checkout (pnpm + tsx + source all available,
# so pg.migrations-aligned can actually query kysely_migration).
cd <metasheet repo root>
node scripts/ops/integration-k3wise-onprem-preflight.mjs --mock \
  --out-dir artifacts/integration-k3wise-onprem-preflight/<runId>
EXIT=$?

unset DATABASE_URL JWT_SECRET
echo "exit=$EXIT"
```

The compose network name (`metasheet2_default` above) and the postgres
container name (`metasheet-postgres`) are deployment-specific. Verify with:

```bash
docker inspect metasheet-backend --format \
  '{{range $net,$_ := .NetworkSettings.Networks}}{{$net}}{{end}}'
docker ps --format '{{.Names}}' | grep postgres
```

### Alternatives, and when to prefer them

- **`docker cp` + `docker exec` into the running prod backend.** Possible
  but each run has to copy `scripts/ops/integration-k3wise-onprem-preflight.mjs`
  in, run, copy artifacts out, and clean up. The host-shell recipe above is
  faster on a box where the repo is checked out.
- **Transient `docker run --rm` joining the compose network.** Useful if the
  host shell is unreliable or you want to test from a clean Node version.
  Pattern:
  ```bash
  docker run --rm --network metasheet2_default \
    -v <repo>:/repo -w /repo \
    -e DATABASE_URL -e JWT_SECRET \
    node:20 \
    node scripts/ops/integration-k3wise-onprem-preflight.mjs --mock --skip-migrations \
        --out-dir /repo/artifacts/integration-k3wise-onprem-preflight/<runId>
  ```
  `--skip-migrations` is needed because a stock `node:20` image lacks `pnpm`
  and the workspace install. Without it the migration check would skip with
  the "pnpm/tsx not on PATH" reason anyway.

## Sharing the artifact safely

`preflight.json` and `preflight.md` are designed to be safe to attach to PRs
or paste into chat:

- DATABASE_URL is stored as a sanitized URL (password → `<redacted>`, secret
  query params → `<redacted>`).
- `JWT_SECRET` is recorded as length only.
- K3 credentials are recorded as `passwordPresent: true` /
  `usernamePresent: true` only.
- `K3_API_URL` is sanitized at storage time — secret-keyed query params
  (`access_token` / `token` / `password` / `secret` / `sign[ature]` /
  `api_key` / `session_id` / `auth`) are replaced with `<redacted>` before
  being placed in the JSON.

Pre-share self-check:

```bash
ART=artifacts/integration-k3wise-onprem-preflight/<runId>
grep -cE '"password":\s*"[^<]' "$ART"/preflight.json
grep -cE 'eyJ[A-Za-z0-9_-]{20,}' "$ART"/preflight.json "$ART"/preflight.md
```

All three counts should be `0`. If any is `>0`, the artifact has been edited
after the script wrote it — do not share until you confirm what was added.

The `artifacts/integration-k3wise-onprem-preflight/` directory is gitignored
so accidental `git add` won't surface artifacts containing host topology
information into the repo history.

## What this preflight does NOT do

- Does NOT call any K3 WebAPI endpoint. `--live` does only a TCP probe.
- Does NOT validate that K3 credentials work — only that the four env vars
  are populated.
- Does NOT exercise the metasheet backend boot path. Application-level smoke
  is a separate tool.
- Does NOT apply migrations. It only reports drift.
- Does NOT write to the database under any flag combination.

## Footgun summary

| Symptom | Cause | Fix |
|---|---|---|
| `pg.tcp-reachable: fail` with `ENOTFOUND` for a hostname like `postgres` | Host shell can't resolve docker compose DNS | Use the [bridge-IP recipe](#3-recipe--host-shell-with-docker-bridge-ip) |
| `pg.migrations-aligned: skip` with "pnpm/tsx not on PATH" on what should be a dev box | Running inside the slim prod container | Re-run from host repo checkout, or accept and pass `--skip-migrations` |
| `k3.live-reachable: fail` with `ECONNREFUSED` against a known-good K3 | Wrong port — URL implies 80, K3 listens on `8080` / `8088` | Confirm port with customer; update GATE answer |
| Decision is `PASS` (exit 0) but operators see app failures | Preflight only checks env / DB reachability / config presence; not boot | Run the application's own smoke after the preflight |
| `preflight.json` contains a value that looks like a token | Storage-time sanitizer regression (no real case observed yet) | Re-run `pnpm verify:integration-k3wise:onprem-preflight` to catch via the unit test; file a bug |

## See also

- Script: `scripts/ops/integration-k3wise-onprem-preflight.mjs`
- Script test suite: `pnpm verify:integration-k3wise:onprem-preflight`
- Mock chain end-to-end: `pnpm verify:integration-k3wise:poc`
- GATE schema sample: `node scripts/ops/integration-k3wise-live-poc-preflight.mjs --print-sample`
- After the backend is up and you want to sign off internal trial readiness
  (post-deploy authenticated smoke, complementary to this preflight):
  `docs/operations/integration-k3wise-internal-trial-runbook.md`
