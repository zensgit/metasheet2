# K3 WISE Internal Trial Runbook

## Purpose

Use this runbook to sign off an internal K3 WISE integration trial environment
before customer GATE answers arrive or before a customer live PoC starts.

Public-only smoke is useful for reachability diagnostics, but it is not an
internal-trial signoff.

## Required Signoff Evidence

A signoff-ready K3 WISE postdeploy smoke must satisfy all of the following:

- `integration-k3wise-postdeploy-smoke.json` exists.
- `ok=true`.
- `authenticated=true`.
- `signoff.internalTrial=pass`.
- `summary.fail=0`.
- `auth-me` passed.
- `integration-route-contract` passed.
- all four control-plane list probes passed:
  - `integration-list-external-systems`
  - `integration-list-pipelines`
  - `integration-list-runs`
  - `integration-list-dead-letters`
- `staging-descriptor-contract` passed.

If the evidence says `signoff.internalTrial=blocked`, the environment is not
ready for internal trial signoff even when the diagnostic result is otherwise
green.

## Operator UI Flow

Use the K3 WISE setup page as the quick-start preset:

```text
/integrations/k3-wise
```

Use Data Factory when the integration needs cross-system mapping beyond the K3
Material/BOM preset:

```text
/integrations/workbench
```

Current operator contract:

- The K3 WISE setup page is the guided preset for WebAPI credentials, SQL
  channel gating, staging table install, Material/BOM template preview, and
  draft pipeline creation.
- Data Factory is the configurable surface for source/target dataset
  selection, multitable cleansing, whitelisted transforms, dictionary maps,
  validation rules, payload preview, dry-run, Save-only run, and run/dead-letter
  observation.
- Blank tenant scope resolves to `default`. Only override Tenant ID in the
  advanced context when testing a different tenant.
- Workspace ID is optional and belongs to advanced context. Leave it blank for
  single-workspace on-prem PoC unless the deployment explicitly uses workspace
  isolation.
- WebAPI Base URL should stop at protocol, host, and port, for example
  `http://k3-server:port`. Keep `/K3API/...` in endpoint paths. A Base URL that
  also contains `/K3API` can produce duplicate request paths.
- SQL Server is an advanced channel. Reads must use allowlisted tables or
  views; writes must target middle tables or controlled stored procedures. Do
  not expose direct K3 core-table writes to ordinary operators.
- Material and BOM preview cards must remain secret-free. The preview is JSON
  shape verification only; it must not call K3 or write MetaSheet records.

## GitHub Actions Path

For manual signoff, run `K3 WISE Postdeploy Smoke` with:

- `base_url`: deployed MetaSheet base URL.
- `require_auth`: `true` (default).
- `tenant_id`: target tenant, unless singleton tenant auto-discovery is
  explicitly safe.
- `auto_discover_tenant`: `true` only when the deployment has exactly one
  integration tenant scope.
- `issue1542_install_staging`: `true` only for the Data Factory issue #1542
  retest after a K3 WebAPI target already exists; it runs the staging install
  + workbench smoke path and requires auth + tenant scope.

For the current 142 internal trial deployment, use tenant scope `default`.
`METASHEET_TENANT_ID=default` is configured as a GitHub repository variable, so
the manual workflow can be run without filling `tenant_id`; use the input only
when intentionally testing another tenant.

Token resolution order:

1. `METASHEET_K3WISE_SMOKE_TOKEN` secret.
2. deploy-host fallback minting a temporary masked admin token inside the
   running backend container.

The manual workflow fails when `require_auth=true` and token resolution or
authenticated checks fail.

When `issue1542_install_staging=true`, the workflow appends both
`--issue1542-workbench-smoke` and `--issue1542-install-staging` during the input
check and the real smoke. The input check fails early if auth or tenant scope is
missing, so the workflow does not produce a misleading partial issue #1542
smoke artifact.

When token resolution fails, the workflow still runs the smoke script without a
bearer token so it can upload a failure evidence artifact. Treat that artifact
as a blocked signoff record, not as a passed smoke. The final workflow gate
still fails on the token resolver return code.

## CLI Path

```bash
node scripts/ops/integration-k3wise-postdeploy-smoke.mjs \
  --base-url "$METASHEET_BASE_URL" \
  --token-file "$METASHEET_AUTH_TOKEN_FILE" \
  --tenant-id "$METASHEET_TENANT_ID" \
  --require-auth \
  --out-dir artifacts/integration-k3wise/internal-trial/postdeploy-smoke
```

For the Data Factory issue #1542 deployment retest, add the opt-in workbench
smoke flags. `--issue1542-install-staging` first calls
`/api/integration/staging/install`, then upserts a `metasheet:staging` source
from the returned sheet/open-link metadata. This verifies the same one-click
staging setup path that the UI uses. It does not run dry-run, Save-only,
Submit, or Audit.

This path assumes the K3 WISE WebAPI target has already been saved through the
K3 preset page or Data Factory target-system form. It creates the MetaSheet
staging source only. If you need a metadata-only target for an isolated smoke
where no K3 target has been configured, run
`scripts/ops/integration-issue1542-seed-workbench-systems.mjs` first and then
run the smoke below.

```bash
node scripts/ops/integration-k3wise-postdeploy-smoke.mjs \
  --base-url "$METASHEET_BASE_URL" \
  --token-file "$METASHEET_AUTH_TOKEN_FILE" \
  --tenant-id "$METASHEET_TENANT_ID" \
  --require-auth \
  --issue1542-workbench-smoke \
  --issue1542-install-staging \
  --out-dir artifacts/integration-k3wise/internal-trial/postdeploy-smoke-issue1542
```

This extra smoke verifies that staging installation returns
`standard_materials` sheet metadata, a `metasheet:staging` source exposes
non-empty `standard_materials` schema, the K3 target exposes the `material`
template schema, and a fixed draft pipeline ID can be saved without PostgreSQL
JSONB `22P02`. It writes staging/source/pipeline metadata only and never runs
dry-run, Save-only, Submit, or Audit.

### SQL Server executor diagnostic

The postdeploy smoke reports configured K3 WISE SQL Server sources through the
non-blocking `sqlserver-executor-availability` check:

- `pass` means a configured `erp:k3-wise-sqlserver` source is not currently
  marked unavailable by the backend.
- `skipped` with `code=SQLSERVER_EXECUTOR_MISSING` means the SQL source exists,
  but the deployment has not injected the allowlisted `queryExecutor`.

`SQLSERVER_EXECUTOR_MISSING` does not invalidate the #1542 staging-to-K3
metadata signoff. It means direct SQL Server source execution is still blocked.
Use `metasheet:staging` as the source for Data Factory retests until the bridge
deployment wires a query executor with the expected `testConnection`, `select`,
and `insertMany` methods. After wiring the executor, retest the SQL source from
the workbench and rerun this smoke; the diagnostic should move from `skipped`
to `pass`. See
`docs/operations/integration-k3wise-sql-executor-bridge-handoff.md` for the
bridge-machine implementation contract.

Then render the summary:

```bash
node scripts/ops/integration-k3wise-postdeploy-summary.mjs \
  --input artifacts/integration-k3wise/internal-trial/postdeploy-smoke/integration-k3wise-postdeploy-smoke.json \
  --require-auth-signoff
```

## Host-Shell Mint and Smoke (deploy host, no GHA)

When you have shell access to the deploy host and need a one-off internal-trial
smoke without firing a GHA workflow, you can mint a temporary admin token
directly inside the running backend container. This bypasses
`scripts/ops/resolve-k3wise-smoke-token.sh`, which is GHA-shaped (it wants
`DEPLOY_HOST` / `DEPLOY_USER` / `DEPLOY_SSH_KEY_B64` and is meant to run from a
control plane SSHing in).

The container-internal mint script below uses the same admin-selection and
token-mint logic as the resolver's deploy-host fallback, simplified for the
explicit-tenant case (no `auto_discover_tenant`, no multi-tenant ambiguity
guard). Treat it as a tested simplified extract, not a maintained mirror;
re-derive from the resolver when it changes upstream.

```bash
# 1. Mint a 2-hour admin token via the running backend container.
TS=$(date -u +%Y%m%dT%H%M%SZ)
TOKEN_FILE=/tmp/metasheet-host-admin-fresh-${TS}.jwt
umask 077

RAW=$(docker exec -i \
  -e K3_WISE_SMOKE_TENANT_ID=default \
  -e K3_WISE_SMOKE_TENANT_AUTO_DISCOVER=false \
  -e JWT_EXPIRY=2h \
  metasheet-backend \
  node --input-type=module - 2>&1 <<'NODE_END'
import pg from 'pg'
import { authService } from '/app/packages/core-backend/dist/src/auth/AuthService.js'
const tenantId = String(process.env.K3_WISE_SMOKE_TENANT_ID || '').trim()
const { Client } = pg
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
})
try {
  await client.connect()
  if (!tenantId) { console.error('tenant_id required'); process.exit(2) }
  const r = await client.query(
    "SELECT u.id, u.email, u.username, u.name, u.mobile, u.role, u.permissions, u.is_active, u.must_change_password, (ur.user_id IS NOT NULL) AS has_rbac_admin FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.role_id = 'admin' WHERE COALESCE(u.is_active,true)=true AND COALESCE(u.must_change_password,false)=false AND (u.role='admin' OR ur.user_id IS NOT NULL) ORDER BY CASE WHEN ur.user_id IS NOT NULL THEN 0 ELSE 1 END, CASE WHEN u.id='admin' THEN 0 ELSE 1 END, u.created_at ASC LIMIT 1"
  )
  const row = r.rows[0]
  if (!row) { console.error('no admin'); process.exit(4) }
  const token = authService.createToken({
    id: String(row.id),
    email: typeof row.email === 'string' ? row.email : '',
    username: row.username ?? null,
    name: typeof row.name === 'string' && row.name.trim() ? row.name : 'K3 WISE Smoke Admin',
    mobile: row.mobile ?? null,
    role: row.has_rbac_admin ? 'admin' : (typeof row.role === 'string' && row.role.trim() ? row.role : 'admin'),
    permissions: Array.isArray(row.permissions) ? row.permissions : [],
    tenantId,
    is_active: row.is_active,
    must_change_password: row.must_change_password,
    created_at: new Date(),
    updated_at: new Date(),
  })
  console.log(token)
} finally { await client.end().catch(()=>{}) }
NODE_END
)
RC=$?
TOKEN=$(printf '%s\n' "$RAW" | awk '/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/ {f=$0} END {if(f) print f}')
unset RAW
[ -n "$TOKEN" ] || { echo "MINT FAILED rc=$RC"; exit 1; }
printf '%s' "$TOKEN" > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
unset TOKEN

# 2. Run the smoke against the host-internal public URL.
node scripts/ops/integration-k3wise-postdeploy-smoke.mjs \
  --base-url http://<deploy-host-public-url>:8081 \
  --token-file "$TOKEN_FILE" \
  --tenant-id default \
  --require-auth \
  --out-dir artifacts/integration-k3wise/internal-trial/postdeploy-smoke

# 3. Render the summary.
node scripts/ops/integration-k3wise-postdeploy-summary.mjs \
  --input artifacts/integration-k3wise/internal-trial/postdeploy-smoke/integration-k3wise-postdeploy-smoke.json \
  --require-auth-signoff

# 4. Optional: shred the token file when done.
shred -u "$TOKEN_FILE" 2>/dev/null || rm -f "$TOKEN_FILE"
```

Notes:

- `metasheet-backend` is the backend container name in the default
  `docker-compose.app.yml`.
- `JWT_EXPIRY=2h` matches the resolver default.
- The token value never enters the shell prompt; the heredoc captures
  container stdout, an `awk` extracts the 3-segment JWT shape, and the value
  is `unset` from the shell as soon as it is on disk at `0600`.
- The smoke script's pre-share self-check pattern from
  `docs/operations/k3-poc-onprem-preflight-runbook.md` (URL query secret
  check + raw `Bearer` / `eyJ` / token field) applies to this artifact too.

## Deployment Workflow

The automatic deploy workflow can be made a hard authenticated smoke gate by
setting:

```text
K3_WISE_DEPLOY_SMOKE_REQUIRE_AUTH=true
```

Keep it unset or `false` only when the deployment is still in diagnostic mode.
Diagnostic mode can prove the web/API surface is reachable, but cannot sign off
the internal K3 WISE trial.

## Public Surface Access Posture

The `metasheet-web` container's published HTTP port (e.g., `:8081` on 142) is
**not openly accessible from arbitrary external networks**. As of 2026-05-08
142 has been observed with the following posture:

- TCP `connect` to `:8081` succeeds from any source.
- HTTP requests from sources outside the configured allowlist receive an
  empty reply at the application layer (`curl: (52) Empty reply from
  server`). The TCP connection is closed without a status line.

Observed reachable paths:

- `K3 WISE Postdeploy Smoke` GHA workflow — succeeds. GitHub Actions egress IP
  ranges appear to be allowlisted.
- The deploy host's own shell (loopback via the host's public IP, or via the
  docker network) — succeeds.

Observed non-reachable path:

- Ad-hoc workstation `curl` from outside the allowlist — TCP succeeds, HTTP
  returns empty reply.

Implication for operators: if you want to run an ad-hoc smoke without going
through GHA, prefer the host-shell pattern (SSH into the deploy host and run
the smoke locally). Do **not** assume `--base-url http://<deploy-host>:8081`
works from an unprivileged workstation.

Loosening this posture (e.g., adding additional source networks to the
`:8081` HTTP allowlist) happens in the `metasheet-web` container's nginx
config or in any front-door reverse proxy, not in this repo, and is out of
scope for this runbook.

## 142 Internal Trial Evidence

Latest confirmed signoff runs (newest first):

### 2026-05-08, deploy-host shell

- Path: "Host-Shell Mint and Smoke" section above.
- Tenant source: `--tenant-id default` (explicit).
- Token: minted via host-local `docker exec metasheet-backend node` against the
  running prod container; written to `/tmp/...` at `0600`; never printed in
  console, logs, or artifact.
- Result: `signoff.internalTrial=pass`.
- Summary: `10 pass / 0 skipped / 0 fail`.
- Artifact: `artifacts/integration-k3wise/internal-trial/postdeploy-smoke/`
  on the deploy host (gitignored).

### Earlier, GHA

- Workflow: `K3 WISE Postdeploy Smoke`.
- Run: `https://github.com/zensgit/metasheet2/actions/runs/25157307393`.
- Tenant source: repository variable `METASHEET_TENANT_ID=default`.
- Result: `signoff.internalTrial=pass`.
- Summary: `10 pass / 0 skipped / 0 fail`.
- Artifact: `integration-k3wise-postdeploy-smoke-25157307393-1`.

Both runs proved the deployed 142 environment can mint a temporary masked
admin token, reach the K3 setup frontend route, validate the integration
plugin route contract, list the four tenant-scoped control-plane collections,
and validate staging descriptors.
