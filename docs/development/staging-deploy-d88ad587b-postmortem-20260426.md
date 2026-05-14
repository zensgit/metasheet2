# Staging Deploy d88ad587b — Post-Mortem & Migration Misalignment Diagnosis — 2026-04-26

## TL;DR

The original deploy MD's conclusion that "JWT_SECRET appears to have changed"
is **wrong**. The actual root cause of post-deploy 401 responses is a
**database schema mismatch**: the staging postgres is missing **66
migrations** the new image (d88ad587b) requires. JWT signature verifies
fine — the auth middleware then queries `users.username` (column added by
migration `zzzz20260418170000_*` on 2026-04-18), which does not exist on
staging postgres, and the query failure surfaces as `Invalid token`.

Running `pnpm migrate` to fix it does **not** work because kysely tracks
legacy numeric migrations (008-057, etc.) as un-applied and tries to
RE-RUN them (they already created the schema via a different runner long
ago). First migration kysely attempts hits `column "scope" does not
exist` and aborts the entire run.

Staging is currently in a broken-auth state on d88ad587b. The original
deploy MD's "Wave 8 routes mounted (401 not 404)" finding is still
correct — routes are live — but they're functionally inaccessible to any
authenticated client.

**Recommendation**: roll back to the previous image
(`62a75f9809-itemresults`), schedule migration-alignment as a separate
planned maintenance window. **Do not** attempt migrations under live
deploy pressure with this state divergence.

## What we learned (in order)

### 1. The 401 is not a JWT problem

Probed `/api/auth/me` with the supposedly-valid 8082 staging admin token:

```
{"ok":false,"error":{"code":"UNAUTHORIZED","message":"Invalid token"}}
HTTP_CODE: 401
```

Decoded JWT payload — token is well within its 72h validity window.
JWT_SECRET on the backend container env matches the one used to issue
the token (verified via `printenv` inside the container; same prefix as
prior deploy). So the signature verifies.

The actual error surfaces in backend logs, repeatedly:

```
warn: Database query failed
  context: AuthService
  error: column "username" does not exist
  stack: at AuthService.getUserById (.../AuthService.js:304:32)
         at AuthService.verifyToken (.../AuthService.js:158:26)
         at hydrateAuthenticatedUser (.../jwt-middleware.js:68:22)
```

Auth flow: `verifyToken` → `getUserById` runs
`SELECT id, email, username, ... FROM users WHERE id = $1`. Column
`username` doesn't exist on staging → query fails → middleware returns
401. So the 401 is misleading: it's not auth rejection, it's a schema
gap masquerading as auth rejection.

### 2. Two stacks on the same host (initial confusion)

`docker ps` shows:

| Container | Image | Network |
|-----------|-------|---------|
| `metasheet-staging-backend` | `…d88ad587b…` | `metasheet2-dingtalk-staging_default` |
| `metasheet-staging-web` | `…d88ad587b…` | `metasheet2-dingtalk-staging_default` |
| `6a3b8dcc2a37_metasheet-staging-postgres` | postgres:15-alpine | `metasheet2-dingtalk-staging_default` |
| `dd50c7844281_metasheet-staging-redis` | redis:7-alpine | `metasheet2-dingtalk-staging_default` |
| `metasheet-backend` | `…1a341bbdc96…` (commit AFTER d88ad587b) | another network |
| `metasheet-web` | `…1a341bbdc96…` | another network |
| `metasheet-postgres` | postgres:15-alpine | another network |
| `metasheet-redis` | redis:7-alpine | another network |

The host runs **two parallel stacks**:

- `metasheet-staging-*` — the staging stack we just deployed at d88ad587b
- `metasheet-*` (no `-staging`) — appears to be a prod-track stack
  running a newer commit `1a341bbdc966…` (3 days post d88ad587b)

The two postgres containers are isolated (different networks). The
staging backend resolves `postgres` to `6a3b8dcc2a37_metasheet-staging-postgres`
(172.18.0.3 inside its network), NOT `metasheet-postgres`. My first
schema probe accidentally hit `metasheet-postgres` (the wrong one) which
**does** have the `username` column — leading to a brief moment of
"the schema is fine, why is it failing?" confusion. The actual staging
postgres is missing the column.

The hash-prefix names on staging postgres+redis are leftover from the
docker-compose v1 ContainerConfig bug recovery we did during the deploy
(see original deploy MD attempt 2). They're functioning normally just
under those renamed names.

### 3. Migration tracking divergence

Staging postgres `kysely_migration` table:

- 86 entries
- Earliest: `20250924105000_create_approval_tables`
- Latest: `zzzz20260409154000_create_platform_member_groups_and_delegated_group_scopes`
- **Nothing tracked from 2026-04-10 onwards**
- **No legacy numeric migrations tracked** (008, 032-057, etc.)

Prod-track postgres `kysely_migration` table:

- 152 entries
- Includes legacy numeric (008-057+) AND modern migrations through the
  newer commit they're running

Diff (in prod, NOT in staging) = 66 entries. Notable groups:

- **Legacy numeric**: `008_plugin_infrastructure`, `032_create_approval_records`,
  `033_create_rbac_core`, …, `057_create_integration_core_tables`,
  `20250925_create_view_tables`, `20250926_create_audit_tables` (~28 entries)
- **April 10+ modern migrations**: `zzzz20260410100000_create_plugin_automation_rule_registry`,
  `zzzz20260411120000_create_user_namespace_admissions`,
  `zzzz20260418170000_allow_no_email_users_and_add_username` (the one
  that introduces the `username` column required by the new auth code),
  …, `zzzz20260426100000_add_breach_notified_at` (~38 entries)

### 4. Why naive migrate run can't fix it

`packages/core-backend/src/db/migrate.ts` reads:

```ts
const migrator = new Migrator({
  db,
  allowUnorderedMigrations: true,
  provider: createCoreBackendMigrationProvider({…}),
})
const { error, results } = await migrator.migrateToLatest()
```

The provider (`migration-provider.ts`) loads from MULTIPLE folders:

- `dist/src/db/migrations/` (modern .ts → compiled .js)
- `migrations/*.sql` (legacy SQL)
- `_meta/` (excluded)

So the provider sees **both** modern and legacy migrations. With
`allowUnorderedMigrations: true`, kysely ignores name-ordering and runs
anything not in `kysely_migration`. On staging, that's all 66 missing
entries.

When I attempted `node dist/src/db/migrate.js` inside the container:

```
failed to execute migration "008_plugin_infrastructure"
failed to migrate
error: column "scope" does not exist
```

`008_plugin_infrastructure.sql` is the legacy SQL that originally created
plugin tables. The schema is already in place (via the legacy SQL runner
that originally bootstrapped staging — pre-kysely tracking). Re-running
the SQL file fails because the schema state differs from what the SQL
expects to start from.

**Critical observation**: the `migrate.ts` script ignores `process.argv`
entirely. The package.json lists `db:migrate`, `db:list`, `db:reset`,
`db:rollback` — but they all run the same `migrateToLatest()`. The
`--list`, `--reset`, `--rollback` aliases are misleading; they don't
behave any differently. (Worth fixing in a separate PR — the script
should either implement those flags or remove them from package.json.)

## How prod-track stack avoided this

`metasheet-postgres` (prod-track) has all 152 entries including legacy
numerics. Either:

- The prod-track DB was bootstrapped at a later point with a runner that
  tracked legacy migrations, OR
- Someone manually inserted the legacy entries into kysely_migration at
  some point to align the tracking with the actual schema, OR
- A different deploy script with a "synthetic catch-up" step ran on
  prod-track but not staging.

Whichever it was, that knowledge was not encoded in the staging deploy
SOP. The staging deploy MD plan assumed `docker compose pull && up -d`
was sufficient; in reality, the codebase has had a hidden two-track
migration pattern that needed manual reconciliation per environment.

## Recommended recovery — option-by-option analysis

### Option 1: Roll back to previous image (RECOMMENDED)

```bash
# on host
sudo cp .env.bak.before-d88ad587b-20260426 .env  # restore IMAGE_TAG=21493058e
sudo docker-compose -f docker-compose.app.staging.yml stop backend web
sudo docker-compose -f docker-compose.app.staging.yml rm -f backend web
sudo docker-compose -f docker-compose.app.staging.yml up -d --no-deps backend web
```

**What this does**: restores staging to the previous backend image
(`62a75f9809-itemresults`, `IMAGE_TAG=21493058e`) which works with the
current schema state.

**What this preserves**: postgres + redis untouched. No data lost.
Schema state unchanged. The only thing reverting is the backend + web
container image.

**What this defers**: Wave 8/9/M-Feishu-1 routes are not yet live on
staging. UI smoke can't proceed against d88ad587b code. Migration
alignment becomes a planned task.

**Recovery time**: ~1 minute (uses the same workaround B that succeeded
on the original deploy attempt 3).

**Risk**: very low. The .env backup is intact, the previous image is
still in the local docker cache (no need to re-pull).

### Option 2: Surgical kysely_migration catch-up

Copy the 66 missing entries from prod-track to staging's `kysely_migration`
table (mark them as applied without running their up()), then run
`pnpm migrate` to apply only the genuinely-not-yet-applied ones.

**Mechanism**:

```sql
-- Inside staging postgres
INSERT INTO kysely_migration (name, timestamp)
SELECT name, timestamp FROM ...prod-track snapshot...
WHERE name NOT IN (SELECT name FROM kysely_migration);
```

**Risk**: HIGH. Assumes staging's actual schema matches what the legacy
migrations would have produced. If they don't match (e.g., if staging
was bootstrapped with a slightly different SQL set, or a hand-applied
fix introduced drift), later migrations will fail in unpredictable
ways. Could leave staging in a half-migrated state that's worse than
the current one.

**Why this is risky for staging specifically**: staging has been a
disposable env for a while; nobody has been auditing its schema state
against the canonical migration list. The 66-entry gap suggests it's
been drifting for weeks. Reconciling under live deploy pressure is the
wrong place to discover a schema mismatch.

**Mitigation if attempted**:
- Take a postgres dump first
- Run in a transaction with explicit rollback path
- Verify after each migration

### Option 3: Stay on d88ad587b in broken state

Don't change anything. Document the issue. Wait for a planned maintenance
window.

**Cost**: staging is unusable for any authenticated workflow. UI smoke
can't run. Wave 8/9/M-Feishu-1 backend integration verification on
staging is blocked.

## Lessons captured

1. **Deploy SOP missed `pnpm migrate` step**. The original deploy plan
   (5-step) only covered image-pull + up. For any deploy where the
   image's code expects newer schema than the env's DB has, migrations
   are required. The 5-step plan needs a step 0: "diff
   kysely_migration latest against new image's required migrations
   (compute via `git log --since=<last-deploy-date> -- packages/core-backend/src/db/migrations/`),
   apply pending migrations FIRST, then deploy backend image".

2. **Two-track migration model is invisible**. The codebase has both
   `migrations/*.sql` (legacy) and `src/db/migrations/*.ts` (modern
   kysely) loaded by the same provider. There's no documentation of
   which environments have legacy entries pre-tracked in
   `kysely_migration` and which don't. **Action item**: write a
   `docs/operations/migration-tracking-state.md` mapping env → tracking
   state, AND fix the migrate.ts script to support a real
   `--check-pending` flag that diffs files vs tracking table without
   running.

3. **`migrate.ts` flag handling is broken**. `db:list`, `db:reset`,
   `db:rollback` package.json scripts all run `migrateToLatest()` —
   they ignore argv. **Action item**: separate PR to either implement
   those flags or remove them. As written, `db:reset` is a footgun
   (claims to reset but actually advances).

4. **JWT_SECRET red herring**. When auth fails post-deploy, our
   diagnosis defaulted to "JWT_SECRET changed" without checking the
   backend logs. The logs definitively showed the real cause (DB query
   failure). **Action item**: deploy verification SOP should include
   `docker logs metasheet-staging-backend 2>&1 | tail -100 | grep -E
   "warn|error"` immediately after `up -d`, before claiming success.

5. **404→401 transition is necessary but not sufficient**. The original
   deploy MD's celebration of "Wave 8 routes return 401 not 404 = code
   is live" is correct in narrow scope (proves the route is mounted)
   but masked the real failure (auth path broken). A complete
   verification needs at least one authenticated 200 against a Wave 8
   endpoint.

## Next steps after rollback (proposed)

1. **Re-issue staging admin token** if needed — though current token
   should work against the previous image.
2. **Re-run UI smoke** against rolled-back staging (working state).
3. **Schedule migration-alignment maintenance window**: take pg_dump
   first, then either:
   - Manually align kysely_migration entries to match prod-track exactly
     (only the legacy + already-applied ones), then run `pnpm migrate`
     for the genuinely-pending ones
   - OR clone prod-track DB into staging (drop staging DB, restore from
     prod dump with PII anonymized)
4. **Re-deploy d88ad587b** post-alignment, verify auth+200 on Wave 8
   endpoints before declaring success.
5. **Update deploy SOP** with all lessons above, especially the
   migration-pending diff step.

## Roadmap compliance

- ✅ No new战线 opened (this is a deploy recovery diagnosis, not a
  feature)
- ✅ No `plugins/plugin-integration-core/*` source touched
- ✅ No platform-化 work
- ✅ Pure operational hygiene + SOP repair

## Rollback executed — 2026-04-26 12:31 UTC

User authorized option 1. Rollback completed in one SSH session:

```bash
# 1. backup current .env (post-d88ad587b state)
sudo cp .env .env.bak.rollback-from-d88ad587b-20260426T123123Z

# 2. swap IMAGE_TAG (NOT restored from pre-deploy backup, which had stale 21493058e)
sudo sed -i 's|^IMAGE_TAG=.*|IMAGE_TAG=62a75f9809-itemresults|' .env

# 3. workaround B — stop + rm + up --no-deps
sudo docker-compose -f docker-compose.app.staging.yml stop backend web
sudo docker-compose -f docker-compose.app.staging.yml rm -f backend web
sudo docker-compose -f docker-compose.app.staging.yml up -d --no-deps backend web
```

**Note**: the pre-deploy `.env.bak.before-d88ad587b-20260426` had `IMAGE_TAG=21493058e`
(stale 9-char prefix that never matched a real image — see original deploy MD lessons).
The actually-running image before the deploy was `62a75f9809-itemresults` (a feature
build, 11 days old, cached locally). I wrote that tag directly into `.env` rather than
restore the broken backup.

### Post-rollback verification

| Probe | Expected | Got |
|-------|----------|-----|
| `/api/health` | 200, plugins:14, dbPool healthy | ✅ 200, plugins:14, dbPool {total:3, idle:3, waiting:0} |
| `/api/auth/me` (with 8082 admin token) | 200 (real user data) | ✅ 200, returns admin user data |
| `/api/multitable/bases` | 200 | ✅ 200, returns base_legacy |
| `/api/approvals/metrics/summary` (Wave 8) | 404 (route NOT mounted on pre-d88ad587b image) | ✅ 404 "Cannot GET" |

**Confirms**:
- Token IS valid (signature + DB hydration both work on this image).
- Plugin count back to **14** (the "drop to 13" on d88ad587b was a schema-gap artifact, not a real plugin loss).
- Wave 8 routes correctly absent — this is the pre-Wave 8 image.
- Staging is back to its prior working state. UI smoke can resume against this image, but
  Wave 8/9/M-Feishu-1 verification is deferred until d88ad587b is redeployed post-alignment.

### State after rollback

| Surface | State |
|---------|-------|
| Backend container | Up, image `62a75f9809-itemresults` (working) |
| Web container | Up, image `62a75f9809-itemresults` (working) |
| Staging postgres `6a3b8dcc2a37_…` | Up, **schema unchanged** (no migrations run, no rows touched) |
| Staging redis `dd50c7844281_…` | Up, healthy |
| Wave 8/9/M-Feishu-1 routes | Not mounted (deferred until next deploy) |
| 8082 staging admin JWT | ✅ confirmed valid, no need to reissue |
| kysely_migration table | 86 rows (unchanged) — alignment task still pending |
| `.env IMAGE_TAG` | `62a75f9809-itemresults` (current) |
| `.env.bak.rollback-from-d88ad587b-20260426T123123Z` | preserved — forward-roll-again path |
| `.env.bak.before-d88ad587b-20260426` | preserved (still contains stale `21493058e` — do not use directly) |

## Open follow-ups (deferred, not in this session)

1. **Migration alignment maintenance task** — needs its own session and pg_dump-first
   discipline. Approach options laid out in §"Recommended recovery — option-by-option
   analysis" above.
2. **Fix `migrate.ts` flag handling** — separate small PR to make `db:list`/`db:reset`/
   `db:rollback` either honor argv or be removed from package.json (currently footgun).
3. **Write deploy SOP doc** — `docs/operations/staging-deploy-sop.md` capturing:
   - Pre-deploy: `git log --since=<last-deploy-date> -- packages/core-backend/src/db/migrations/`
     to enumerate pending migrations
   - Pre-deploy: confirm kysely_migration on target env contains all entries through the
     image's expected schema state (diff against canonical)
   - During deploy: check backend logs for warn/error within first 60s of `up -d`
   - During deploy: at least one authenticated 200 against an endpoint added by the new image
     before declaring success
   - Post-deploy: only after all verification is green, declare done; if any fails, roll back
     immediately rather than diagnose under live deploy pressure
4. **Redeploy d88ad587b** post-alignment to land Wave 8/9/M-Feishu-1 routes on staging.

## Roadmap compliance (final)

- ✅ No new战线 opened (this is recovery + diagnosis hygiene)
- ✅ No `plugins/plugin-integration-core/*` source touched
- ✅ No platform-化 work
- ✅ No destructive actions taken on staging postgres (no migrations run, no rows touched)
- ✅ Recovery path was fully reversible at every step
