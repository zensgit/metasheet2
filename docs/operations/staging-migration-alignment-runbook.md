# Staging Migration Alignment Runbook

This runbook handles the case where a target env's `kysely_migration`
table is **out of sync with the actual schema state** — typically
manifests as `pnpm migrate` failing on an old migration that
"shouldn't" need to run because the schema is already in place.

The 2026-04-26 staging diagnosis surfaced this: staging postgres had
86 entries in `kysely_migration` (latest 2026-04-09) while prod-track
had 152 (including legacy numerics 008-057+ and modern Apr-10+). The
legacy numerics had been applied to staging via the old SQL runner but
never recorded in the kysely tracking table. Naive `pnpm migrate`
fails on the first such "phantom-pending" migration.

This is a **planned maintenance task**, not a hot-deploy fix. Schedule
it during a window where staging can be unavailable for ~15 minutes
and a real human is at the keyboard.

## Pre-flight

### Required access

- SSH to the host (e.g. `tempadmin142@142.171.239.56`)
- `sudo` for `docker exec` against postgres + backend
- A reachable, healthy prod-track stack with a known-good
  `kysely_migration` table to use as the canonical reference

### Preserve the rollback path

```bash
# Pin the current backend image SHA so we can roll back if the
# alignment goes sideways
CURRENT_IMAGE=$(sudo docker inspect <staging-backend> -f '{{.Config.Image}}')
echo "rollback target: $CURRENT_IMAGE"
```

Save `$CURRENT_IMAGE` somewhere persistent (paste into a memo / chat).

### pg_dump first — this is non-negotiable

```bash
PG=<staging-postgres-container>  # may be hash-prefixed if compose v1 renamed it
TS=$(date -u +%Y%m%dT%H%M%SZ)
sudo docker exec "$PG" pg_dump -U metasheet -d metasheet -Fc \
  > /tmp/metasheet-staging-pgdump-$TS.dump
ls -la /tmp/metasheet-staging-pgdump-$TS.dump  # confirm size > 0
```

`-Fc` = custom format = compressed, restorable via `pg_restore`. If
this dump fails or is empty, **stop**. Do not proceed without a
working backup.

## Alignment options

Pick exactly one. Do not mix.

### Option A: Synthetic catch-up (RECOMMENDED for the 2026-04-26 case)

Copy the missing entries from prod-track's `kysely_migration` into
staging's, marking them as applied without re-running. Assumes
staging's actual schema matches what those migrations would have
produced (true in the 2026-04-26 case for the legacy numerics — the
SQL was applied long ago via the old runner).

#### A.1 Snapshot prod-track's tracking table

```bash
PROD_PG=<prod-track-postgres-container>
sudo docker exec "$PROD_PG" psql -U metasheet -d metasheet -tA -c \
  "SELECT name, timestamp FROM kysely_migration ORDER BY name;" \
  > /tmp/prod-kysely_migration.tsv
wc -l /tmp/prod-kysely_migration.tsv  # expect ~152 lines (Apr 2026 baseline)
```

#### A.2 Compute the diff (entries in prod, not in staging)

```bash
sudo docker exec "$STAGING_PG" psql -U metasheet -d metasheet -tA -c \
  "SELECT name FROM kysely_migration ORDER BY name;" \
  > /tmp/stg-kysely_migration.tsv

# Lines in prod, not in staging — the candidate insert set
diff /tmp/prod-kysely_migration.tsv /tmp/stg-kysely_migration.tsv \
  | grep '^<' | sed 's/^< //' > /tmp/missing-from-staging.tsv
wc -l /tmp/missing-from-staging.tsv
```

#### A.3 Audit the diff before inserting

For each entry in `/tmp/missing-from-staging.tsv`:

- **Legacy numeric migrations** (e.g. `008_plugin_infrastructure`,
  `032-057_*`, `20250925_create_view_tables`,
  `20250926_create_audit_tables`): these created schema via the old
  `migrations/*.sql` runner. Check `\d <relevant table>` on staging
  to confirm the schema actually exists. If yes, mark-as-applied is
  safe.
- **Modern migrations from before staging's last applied date**: same
  audit — if the schema effects are visible on staging, they were
  applied via some other path. Mark as applied.
- **Modern migrations from AFTER staging's last applied date**: these
  are GENUINELY pending. Do **NOT** include them in the synthetic
  insert. They need to run for real via `pnpm migrate` after the
  synthetic catch-up completes.

Split `/tmp/missing-from-staging.tsv` into two files:

- `/tmp/synthetic-mark-applied.tsv` — schema is already in place
  (legacy + early-modern)
- `/tmp/genuinely-pending.tsv` — must actually run

For the 2026-04-26 baseline this is roughly:
- ~28 entries → synthetic (legacy 008-057, 20250925, 20250926)
- ~38 entries → genuinely-pending (everything dated `zzzz20260410+`)

#### A.4 Insert synthetic-applied entries

```bash
# Build the SQL file
{
  echo "BEGIN;"
  while IFS=$'\t' read -r name ts; do
    # Use prod's timestamp if available, otherwise epoch zero (any non-null is fine)
    [ -z "$ts" ] && ts=0
    echo "INSERT INTO kysely_migration (name, timestamp) VALUES ('$name', $ts);"
  done < /tmp/synthetic-mark-applied.tsv
  echo "COMMIT;"
} > /tmp/synthetic-mark-applied.sql

# Apply
sudo docker exec -i "$STAGING_PG" psql -U metasheet -d metasheet \
  < /tmp/synthetic-mark-applied.sql
```

Verify count:

```bash
sudo docker exec "$STAGING_PG" psql -U metasheet -d metasheet -c \
  "SELECT count(*) FROM kysely_migration;"
# Should be old-count + len(synthetic-mark-applied.tsv)
```

#### A.5 Run pnpm migrate to apply the genuinely-pending ones

```bash
sudo docker exec -w /app/packages/core-backend <staging-backend> \
  node dist/src/db/migrate.js --list
# Confirms the only pending entries match /tmp/genuinely-pending.tsv

sudo docker exec -w /app/packages/core-backend <staging-backend> \
  node dist/src/db/migrate.js
# Apply them
```

Each migration prints "executed successfully" or "failed". If any
fails, **stop** and investigate before retrying — the schema is now
mid-flight.

### Option B: Full restore from prod-track snapshot

Drop staging's DB, restore from a sanitized prod-track dump. Use this
if option A's audit (§A.3) reveals significant schema drift between
staging and what the missing migrations would have produced.

```bash
# 1. Take a fresh prod-track dump
sudo docker exec "$PROD_PG" pg_dump -U metasheet -d metasheet -Fc \
  > /tmp/prod-source.dump

# 2. (If needed) sanitize PII — out of scope for this runbook;
#    likely not required if staging is already non-prod data

# 3. Drop and re-create staging DB
sudo docker exec "$STAGING_PG" psql -U metasheet -d postgres -c \
  "DROP DATABASE metasheet;"
sudo docker exec "$STAGING_PG" psql -U metasheet -d postgres -c \
  "CREATE DATABASE metasheet;"

# 4. Restore
sudo docker exec -i "$STAGING_PG" pg_restore -U metasheet -d metasheet -c \
  < /tmp/prod-source.dump
```

After this, staging's schema + `kysely_migration` table both match
prod-track's. Subsequent deploys work normally.

**Cost**: staging loses its current data (which is typically fine for
a non-prod env — but confirm with the team before doing this).

## Post-alignment verification

```bash
# 1. kysely_migration matches expectation
sudo docker exec "$STAGING_PG" psql -U metasheet -d metasheet -c \
  "SELECT count(*) FROM kysely_migration;"
# Should match the new image's expected baseline

# 2. Critical schema checks (case-by-case based on the deploy that triggered alignment)
sudo docker exec "$STAGING_PG" psql -U metasheet -d metasheet -c \
  "\d users"
# Look for columns the new image's auth code expects (e.g. username,
# dingtalk_open_id, must_change_password)

# 3. Authenticated round-trip
TOKEN=$(cat /path/to/admin-token.jwt)
curl -s -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  http://localhost:<port>/api/auth/me
# Expect 200

# 4. (Optional) re-deploy the failed image
# Follow staging-deploy-sop.md from step 6 onwards now that the
# tracking table aligns with what the new image expects.
```

## Failure modes & recovery

### "Insert failed: duplicate key"

You're trying to insert a name that's already present. Adjust
`/tmp/synthetic-mark-applied.tsv` to exclude already-tracked entries:

```bash
sudo docker exec "$STAGING_PG" psql -U metasheet -d metasheet -tA -c \
  "SELECT name FROM kysely_migration ORDER BY name;" \
  > /tmp/stg-current.tsv
comm -23 \
  <(sort /tmp/synthetic-mark-applied.tsv | cut -f1) \
  <(sort /tmp/stg-current.tsv) \
  > /tmp/synthetic-mark-applied-clean.tsv
```

### "Migration failed: column already exists" mid-`pnpm migrate`

A migration in `/tmp/genuinely-pending.tsv` overlaps with schema that
was already applied via a non-tracked path. Move that name from
`/tmp/genuinely-pending.tsv` to `/tmp/synthetic-mark-applied-extra.tsv`,
insert it as synthetic-applied, then resume `pnpm migrate`.

### "I changed something I shouldn't have"

Restore from `/tmp/metasheet-staging-pgdump-$TS.dump`:

```bash
sudo docker exec "$STAGING_PG" psql -U metasheet -d postgres -c \
  "DROP DATABASE metasheet;"
sudo docker exec "$STAGING_PG" psql -U metasheet -d postgres -c \
  "CREATE DATABASE metasheet;"
sudo docker exec -i "$STAGING_PG" pg_restore -U metasheet -d metasheet \
  < /tmp/metasheet-staging-pgdump-$TS.dump
```

This is why the §Pre-flight pg_dump is non-negotiable.

## Provenance

- Diagnosis: `docs/development/staging-deploy-d88ad587b-postmortem-20260426.md`
- Original deploy MD: `docs/development/staging-deploy-d88ad587b-20260426.md`
- Triggering staging gap: 86 → 152 in `kysely_migration` between
  staging and prod-track stacks on host `142.171.239.56`
- Memory entry tracking the deferred task:
  `~/.claude/.../memory/project_staging_migration_alignment.md`

## What this runbook does NOT cover

- **Rolling back already-applied modern migrations** (the down() path)
  — kysely supports `migrateDown()` per-migration, exposed by
  `migrate.js --rollback` after [PR #1190](https://github.com/zensgit/metasheet2/pull/1190)
  lands. But rolling back applied schema changes risks data loss; do
  it as part of an incident-grade plan, not this routine alignment.
- **Cross-vendor migration tooling** (Sequelize/Prisma/etc) — kysely
  is the only tracking system in this codebase right now.
- **Multi-tenant database scope-isolation issues** — different problem,
  see Stage 3 roadmap.
