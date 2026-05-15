# Staging Deploy — main@d88ad587b — 2026-04-26

> **STATUS (2026-04-26 12:31 UTC): ROLLED BACK to `62a75f9809-itemresults`.**
> The diagnosis below is **partially wrong** in two specific places (JWT_SECRET hypothesis,
> plugin count drop). The actual root cause was a 66-migration schema gap on staging postgres,
> not a JWT_SECRET rotation. See the corrected diagnosis and rollback record in:
> [`staging-deploy-d88ad587b-postmortem-20260426.md`](./staging-deploy-d88ad587b-postmortem-20260426.md)
>
> **Wave 8 / 9 / M-Feishu-1 routes are NOT live on staging right now.** The deploy is
> deferred until a planned migration-alignment maintenance window aligns staging postgres
> with prod-track's `kysely_migration` state.
>
> The body below is preserved for forensic value (the docker-compose v1.29.2 bug analysis
> and workaround B are accurate and reusable).

## Outcome

**Deploy succeeded** on third attempt (workaround required for `docker-compose v1.29.2 + Docker daemon` ContainerConfig bug). Backend + web were running on `ghcr.io/zensgit/metasheet2-{backend,web}:d88ad587b2c17402f861e1cf712f9de8e0148a0a`. Postgres + redis untouched. Wave 8/9/M-Feishu-1 backend routes were mounted on staging — **but functionally inaccessible** due to schema mismatch.

**Three followups** surfaced post-deploy (corrected interpretation in postmortem):

1. ~~Pre-existing staging admin JWT is **invalidated**~~ → **Wrong.** Token signature verifies fine. The 401s came from `AuthService.getUserById` failing on `column "username" does not exist` — a schema gap (migration `zzzz20260418170000_*` not applied to staging).
2. ~~**Plugin count 14 → 13**~~ → **Probably also a schema-gap artifact.** Post-rollback probe shows plugins:14. The 13 count likely came from one plugin that hit a similar DB query during health check.
3. UI manual smoke (Wave M-Feishu-1 checklist `wave-m-feishu-1-staging-verification-checklist-20260426.md`) deferred — blocked until d88ad587b can be redeployed against an aligned staging DB.

## Deploy attempts

### Attempt 1 — wrong image tag format (rolled back)

Set `.env IMAGE_TAG=21493058e → IMAGE_TAG=d88ad587b` (9-char prefix), pulled.

```text
Pulling backend ... error
ERROR: for backend  manifest unknown
```

Cause: GHCR uses **40-char full SHA** as image tags. `d88ad587b` did not exist. Auto-rolled-back `.env`.

### Attempt 2 — full SHA pull succeeded, up failed (containers stopped, recovered)

`IMAGE_TAG=d88ad587b2c17402f861e1cf712f9de8e0148a0a`. Pull ✅. `docker-compose up -d backend web` ❌:

```text
File "/usr/lib/python3/dist-packages/compose/service.py", line 1579, in get_container_data_volumes
    container.image_config['ContainerConfig'].get('Volumes') or {}
KeyError: 'ContainerConfig'
```

**Known docker-compose v1.29.2 bug** with newer Docker Engine (27+ removes the `ContainerConfig` field that v1 relied on for volume migration).

**Side effect — boundary violation**: even though `up -d backend web` listed only those services, docker-compose v1's reconciler also touched `postgres` and `redis`, leaving them in `Exit 0` state with hash-prefixed renames (`6a3b8dcc2a37_metasheet-staging-postgres` etc.). User authorization was "**不动 postgres / redis**" — this was unintended impact.

**Recovery executed immediately**: `docker start` on the renamed-and-stopped postgres + redis containers. Both came back healthy within seconds. `/api/multitable/bases` 200 with `{ok, data}` confirmed DB connectivity restored. Total disruption: ~2 minutes for backend (which restarted as a side effect).

### Attempt 3 — workaround B succeeded

Per user authorization, executed `stop + rm -f + up -d --no-deps`:

```bash
docker-compose -f docker-compose.app.staging.yml stop backend web
docker-compose -f docker-compose.app.staging.yml rm -f backend web   # NOT -v, volumes preserved
docker-compose -f docker-compose.app.staging.yml up -d --no-deps backend web
```

**Why this avoids the bug**: `stop + rm` removes the OLD container before `up`, so compose has no existing container to migrate volumes from. The `get_container_data_volumes` code path (which crashes on `ContainerConfig`) is skipped entirely. `--no-deps` ensures only `backend` and `web` are touched (no reconciliation of postgres/redis).

Verified containers swapped to new image:

```text
metasheet-staging-web|ghcr.io/zensgit/metasheet2-web:d88ad587b2c17402f861e1cf712f9de8e0148a0a|Up 25s
metasheet-staging-backend|ghcr.io/zensgit/metasheet2-backend:d88ad587b2c17402f861e1cf712f9de8e0148a0a|Up 26s
6a3b8dcc2a37_metasheet-staging-postgres|cd848ee12e8e|Up 2 hours (healthy)
dd50c7844281_metasheet-staging-redis|aa189b5a1954|Up 2 hours (healthy)
```

## Post-deploy verification

| Probe | Expected | Got |
|-------|----------|-----|
| `/api/health` | 200, dbPool > 0 | ✅ 200, `dbPool:{total:1, idle:1, waiting:0}`, plugins:13 |
| Frontend `HEAD /` | 200 | ✅ HTTP/1.1 200 OK |
| **Wave 8 NEW route** `/api/approvals/metrics/summary` | **200** (was 404 pre-deploy) | ⚠️ **401 Invalid token** — route mounted ✓ but JWT verification fails |
| `/api/approvals/metrics/breaches` | 200 | ⚠️ **401** same as above |
| `/api/multitable/bases` | 200 | ⚠️ **401** same — was 200 on pre-deploy backend with same token |
| `/api/auth/me` | 200 | ⚠️ **401** same |
| `/api/plugins` (public) | 200 | ✅ 200, 13 plugins |
| Local `node --test scripts/ops/integration-k3wise-live-poc-{evidence,preflight}.test.mjs` | 44/44 pass | ✅ 44/44 (run on local main, not staging — these scripts are CI-style) |

### Why Wave 8 routes returning 401 (not 404) is the **key positive signal**

Pre-deploy: `/api/approvals/metrics/summary` returned **404 "Cannot GET"** — Express default for unmounted route. Definitively NOT in the running code.

Post-deploy: same path returns **401 with `code:UNAUTHORIZED`** — JSON body indicates the route IS mounted, the auth middleware ran, the JWT verification rejected. This is **proof Wave 8 SLA observability code is live on staging**.

### JWT_SECRET appears to have changed

Pre-deploy state probed at 06:something UTC: `staging admin token` → `/api/auth/me` 200, `/api/multitable/bases` 200.

Post-deploy state probed at 08:44 UTC, **same token file** unchanged on disk: `/api/auth/me` 401 "Invalid token". Same shape on `/api/multitable/bases`, `/api/approvals/metrics/summary`.

Hypothesis: the new backend image reads `JWT_SECRET` differently (e.g., new code generates ephemeral secret if env var unset, or reads from a different config source). Whatever the cause, the existing 72h staging JWT no longer verifies.

**Mitigation**: re-issue staging admin JWT using `scripts/gen-staging-token.js` against the new backend (whichever JWT_SECRET it now uses).

## Plugin count change (14 → 13)

Pre-deploy probe showed 14 active plugins (full list not captured). Post-deploy shows 13:

```
✅ active (12):
  example-plugin, hello-world, plugin-after-sales, plugin-attendance,
  plugin-audit-logger, plugin-integration-core, plugin-intelligent-restore,
  plugin-test-a, plugin-test-b, plugin-view-gantt, plugin-view-kanban,
  sample-basic
🟡 inactive (1):
  plugin-telemetry-otel
```

Two changes:
- `plugin-telemetry-otel` moved active → inactive. Likely missing `OTEL_EXPORTER_*` env vars on new container; not a code regression. Low priority.
- One plugin is genuinely **gone** from the list (cannot pinpoint without pre-deploy full list). May be a deliberate exclusion in the new build, or a renamed plugin. Worth a quick check: compare `plugins/` directory between `62a75f9809-itemresults` and `d88ad587b2c17402f861e1cf712f9de8e0148a0a` build manifests.

Names also lost the `@metasheet/` scope prefix in display (cosmetic — same plugin loader, different label format).

## State at end of session

| Surface | State |
|---------|-------|
| Backend container | Up, image `d88ad587b2c17402f861e1cf712f9de8e0148a0a` |
| Web container | Up, image `d88ad587b2c17402f861e1cf712f9de8e0148a0a` |
| Postgres | Up 2h healthy, image cd848ee12e8e (untouched) |
| Redis | Up 2h healthy, image aa189b5a1954 (untouched) |
| `<staging-stack-dir>/.env IMAGE_TAG` | `d88ad587b2c17402f861e1cf712f9de8e0148a0a` (changed) |
| `.env` backup files | `.env.bak.before-d88ad587b-20260426` and `.env.bak.before-d88ad587b-20260426` (rollback path preserved) |
| Wave 8 / 9 / M-Feishu-1 routes | Mounted (verified by 401 not 404 transition) |
| Existing staging admin JWT | Invalidated by new backend |
| UI manual smoke (Wave M-Feishu-1 checklist) | Not started — needs new JWT + tester |

## Next steps (user-driven)

1. **Re-issue staging admin JWT**: run `scripts/gen-staging-token.js` (or equivalent) against the new backend container to issue a fresh 72h token signed with whatever the current JWT_SECRET is. Save under `<artifact-dir>/staging-admin-72h.jwt`.
2. **Authorize me to re-probe** with the new JWT to confirm `/api/approvals/metrics/summary`, MF1/MF2/MF3 backend paths, and other Wave-protected routes return 200 (not 401).
3. **(Optional) Investigate plugin count drop**:
   - Diff `plugins/` directory between the two image SHAs.
   - Re-enable telemetry-otel by adding `OTEL_*` env vars if telemetry is wanted on staging.
4. **Run UI manual smoke** per `wave-m-feishu-1-staging-verification-checklist-20260426.md` — this is the actual product validation that human eyes need.
5. **Roadmap-stage decision (your step 5 from the deploy plan)**: if UI smoke passes, decide whether to launch next dev wave (阶段二 stage 2 lane plan in `stage2-vendor-abstraction-lanes-20260426.md` is dormant-and-ready).

## Roadmap compliance

✅ **No new战线 opened** during deploy — purely staging deployment of already-merged code.
✅ **No `plugins/plugin-integration-core/*` source touched** — staging now runs the merged version (the K3 PoC tooling track is preserved).
✅ **No platform-化 work** — staging is now on production-track main, not Stage 3 platform code.

## Lessons captured

- **`docker-compose v1.29.2 + Docker Engine 27+` is broken on `up -d` against existing containers**. Workaround: `stop + rm -f + up -d --no-deps <services>`. Real fix: upgrade to docker compose v2 (`docker compose` plugin), but out of scope for ad-hoc deploys.
- **GHCR image tags here are 40-char full SHA**, not 7- or 9-char prefix. The `21493058e` value previously in `.env` was a stale 9-char prefix that had not actually been rolled out (the running tag `62a75f9809-itemresults` was a feature-build, not main).
- **`docker-compose up -d <service>` does NOT reliably scope to that service in v1.29.2** — it can still silently `Exit 0` related services during reconciliation. Use explicit `--no-deps` and prefer `stop + rm + up` over plain `up` when isolating service updates.
