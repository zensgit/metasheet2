# Staging Deploy SOP — Manual image-pull mode

This SOP applies to **manual deploys** on shared hosts (e.g.
`<staging-host>` running `docker-compose.app.staging.yml`) where you
update the running stack by editing `.env` and running
`docker-compose pull && up -d`. For the **bootstrap script** that
clones + builds + auto-migrates, see [`deploy-ghcr.md`](./deploy-ghcr.md)
— that script runs migrations automatically; this SOP exists because
manual `pull && up -d` does **not**.

The codebase has no auto-migrate-on-startup. If the new image's code
expects schema the env doesn't have, authenticated routes will fail
silently (DB query inside the auth middleware → 401, not a clear
schema error to the client). This SOP catches that before it bites.

## Pre-deploy (read-only checks — do NOT skip)

### 1. Identify the new image's full SHA

GHCR uses the **40-char full commit SHA** as the image tag. The 7- or
9-char prefix that may appear in `.env` will not pull cleanly.

```bash
COMMIT=<short-sha>  # e.g. d88ad587b
gh api "/users/zensgit/packages/container/metasheet2-backend/versions" \
  --paginate \
  --jq '.[] | select(.metadata.container.tags[]? | startswith($prefix)) | .metadata.container.tags[]' \
  --arg prefix "$COMMIT" | head -3
```

Confirm an image tag matches `<COMMIT_FULL_SHA>` exactly. Save that as
`IMAGE_SHA_FULL`.

### 2. Diff pending migrations vs target env

Find what migrations the new image requires that the target env hasn't
applied. Two ways:

**A. Quick local check** — list migrations newer than the previous
deployed commit:

```bash
PREV=<previous deployed full SHA>  # from .env IMAGE_TAG before this deploy
NEW=$IMAGE_SHA_FULL
git log --oneline "$PREV..$NEW" -- packages/core-backend/src/db/migrations/
```

If the output is non-empty, the deploy will require migrations.

**B. Authoritative check** — compare the target env's `kysely_migration`
table against the latest migrations in the new image:

```bash
# On the host
PG=$(sudo docker ps --format '{{.Names}}' | grep postgres | head -1)
sudo docker exec "$PG" psql -U metasheet -d metasheet -c \
  "SELECT name FROM kysely_migration ORDER BY name DESC LIMIT 5;"
```

Compare the latest applied name to the most recent file in
`packages/core-backend/src/db/migrations/` for the target image's
commit. If the env is behind, you have pending work.

### 3. Confirm the target env is on the expected schema track

Multi-tenant hosts may run multiple stacks (e.g. `metasheet-*` AND
`metasheet-staging-*` — they share a host but have separate postgres
containers on separate networks). Resolve which postgres the backend
ACTUALLY connects to:

```bash
sudo docker inspect <backend-container> -f \
  '{{range $net, $cfg := .NetworkSettings.Networks}}{{$net}}{{end}}' \
  | xargs -I {} sudo docker network inspect {} \
  -f '{{range .Containers}}{{.Name}}: {{.IPv4Address}}{{"\n"}}{{end}}'
```

The postgres on the **same network** as the backend is the one to
probe. Probing the wrong postgres will produce false-clean results.

### 4. Backup `.env`

```bash
sudo cp /path/to/.env /path/to/.env.bak.before-${IMAGE_SHA_FULL:0:9}-$(date -u +%Y%m%d)
```

Rollback path: restoring this file lets a future `pull && up -d` revert
to the previous image (assuming the previous image is still cached
locally, which is usually true for recent deploys).

## Deploy

### 5. Apply migrations FIRST (if any are pending from step 2)

Migrations must precede the new image — old image still works against
the migrated schema (since migrations are typically additive), but new
image will fail against the un-migrated schema.

```bash
# From inside the CURRENT (not new) backend container
sudo docker exec -w /app/packages/core-backend <backend-container> \
  node dist/src/db/migrate.js --list
```

`--list` shows pending migrations without applying them. Review the
list, then:

```bash
sudo docker exec -w /app/packages/core-backend <backend-container> \
  node dist/src/db/migrate.js
```

If the env has a tracking-state divergence (legacy SQL migrations not
recorded in `kysely_migration`), this fails. See
[`staging-migration-alignment-runbook.md`](./staging-migration-alignment-runbook.md)
for the recovery path. **Do NOT proceed with the image swap until
migrations succeed**.

### 6. Update `.env IMAGE_TAG`

```bash
sudo sed -i.bak2 "s|^IMAGE_TAG=.*|IMAGE_TAG=$IMAGE_SHA_FULL|" /path/to/.env
sudo grep '^IMAGE_TAG' /path/to/.env  # verify
```

Use full SHA, not prefix.

### 7. Pull the new image

```bash
sudo docker-compose -f /path/to/docker-compose.app.staging.yml pull backend web
```

Should succeed; if "manifest unknown", the SHA is wrong (re-check step 1).

### 8. Bring up backend + web (workaround B)

```bash
sudo docker-compose -f /path/to/docker-compose.app.staging.yml stop backend web
sudo docker-compose -f /path/to/docker-compose.app.staging.yml rm -f backend web
sudo docker-compose -f /path/to/docker-compose.app.staging.yml up -d --no-deps backend web
```

**Why workaround B** (instead of plain `up -d`): docker-compose v1.29.2
has a `KeyError: 'ContainerConfig'` bug against Docker Engine 27+ that
crashes during volume migration on existing containers. `stop + rm + up`
removes the old container first so the volume-migration code path is
skipped. `--no-deps` prevents v1's reconciler from silently touching
postgres/redis (which it does even when only `backend web` are listed).

## Post-deploy verification (within 60 seconds)

### 9. Watch backend logs for schema errors

```bash
sleep 30  # let the container bootstrap
sudo docker logs --tail 100 <backend-container> 2>&1 | \
  grep -iE 'warn|error' | head -20
```

If you see:

- `column "X" does not exist`, `relation "X" does not exist` →
  migration was missed or failed. **Roll back** before users notice.
- `Database query failed` repeatedly → DB connectivity or schema gap.
- `JWT` or signature errors → genuine JWT_SECRET issue (rare).

### 10. Authenticated round-trip — at least one route must return 200

`/api/health` returning 200 is **not enough** — it doesn't verify auth
or DB hydration. Probe at least:

```bash
TOKEN=$(cat /path/to/admin-token.jwt)
curl -s -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  http://localhost:<port>/api/auth/me
curl -s -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  http://localhost:<port>/api/multitable/bases
```

Both should return **200** with valid JSON. If either returns 401, do
NOT default to "JWT_SECRET changed" — check backend logs first (step 9);
the most common cause is a schema gap surfaced as auth rejection
(see post-mortem `staging-deploy-d88ad587b-postmortem-20260426.md` in
docs/development for the full case study).

### 11. New-route smoke (optional, only if the deploy adds new routes)

For routes the new image adds, expect **401 with code:UNAUTHORIZED**
(route mounted, auth rejected because no token) or **200** (with token).
Pre-deploy these would have been **404 "Cannot GET"**. The 404→401 (or
404→200) transition is the proof the new code is loaded.

### 12. Plugin count sanity check

```bash
curl -s http://localhost:<port>/api/health | jq '.plugins, .pluginsSummary'
```

Compare to the previous deploy's count. A drop is a yellow flag — most
likely a plugin failed to register due to a missing dependency or env
var, not a real plugin loss. Investigate before declaring success.

## Rollback (if any verification fails)

```bash
# 1. Restore .env IMAGE_TAG to previous full SHA (or the cached image tag)
sudo sed -i.bakR "s|^IMAGE_TAG=.*|IMAGE_TAG=<previous-full-sha-or-tag>|" /path/to/.env

# 2. Workaround B again
sudo docker-compose -f /path/to/docker-compose.app.staging.yml stop backend web
sudo docker-compose -f /path/to/docker-compose.app.staging.yml rm -f backend web
sudo docker-compose -f /path/to/docker-compose.app.staging.yml up -d --no-deps backend web
```

Postgres + redis are NOT touched by rollback. Schema state remains as
of the migration step (un-rolled-back, since migrations are additive
and the previous image works against the new schema). If the new
image's migrations included BREAKING schema changes (column drops,
type narrowings), rollback requires also rolling back the schema —
out of scope for this SOP, file an incident ticket.

## What this SOP does NOT cover

- **Bootstrap deploys** (fresh host) — see
  [`deploy-ghcr.md`](./deploy-ghcr.md).
- **Migration tracking-state misalignment recovery** — see
  [`staging-migration-alignment-runbook.md`](./staging-migration-alignment-runbook.md).
- **Schema-breaking migrations** (drops, type narrowings) — needs an
  incident-grade rollback plan; not the routine forward-deploy path.
- **CI-driven deploys** — out of scope; this is the manual operator path.

## Quick checklist (printable)

- [ ] 1. Resolve full 40-char `IMAGE_SHA_FULL`
- [ ] 2. Diff pending migrations (`git log` + `kysely_migration` query)
- [ ] 3. Confirm correct postgres on backend's network
- [ ] 4. Backup `.env`
- [ ] 5. **Apply migrations** (`migrate.js --list` then run) — block on success
- [ ] 6. Update `.env IMAGE_TAG=$IMAGE_SHA_FULL`
- [ ] 7. `docker-compose pull backend web`
- [ ] 8. Workaround B: `stop + rm -f + up -d --no-deps backend web`
- [ ] 9. `docker logs --tail 100 ... | grep -iE 'warn|error'` — clean?
- [ ] 10. Authenticated round-trip 200 on `/api/auth/me` + `/api/multitable/bases`
- [ ] 11. New-route smoke: 404→401 (or 404→200) transition confirmed
- [ ] 12. Plugin count matches expectation
- [ ] 13. Declare success OR roll back per §"Rollback"

## Provenance

This SOP captures lessons from the 2026-04-26 staging deploy of
`d88ad587b` which broke auth on staging due to skipped migrations.
Full case study: `docs/development/staging-deploy-d88ad587b-postmortem-20260426.md`.
