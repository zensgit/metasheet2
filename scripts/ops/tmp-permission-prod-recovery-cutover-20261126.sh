#!/usr/bin/env bash
set -euo pipefail
umask 077
export LC_ALL=C
revision=135a04df0bcc2c3f2d60a05f7de0b721b5b5e10f
backup_sha=8de8859655e253bda775d51407475822466c7e48a7e28f77589d3052763daffd
before_sha=36b6ee5ce823ba53585147a5fea3a4bc0befd5387d19fd278e6946fbedb0312e
after_sha=805db6b3b459e016c0f95a4659a9530896c6eeafd3c6e9bc28c159d2bdd566b4
exclude=zzzz20260919090000_create_approval_template_group_backfill_batches
base="$HOME/metasheet2-deploy-window"
origin="$base/runs/45001991740-1"
work="$base/permission-recovery-20261126-v2"
d() { docker "$@"; }
echo RECOVERY_CUTOVER_STARTED
[[ -f "$base/lock" && ! -L "$base/lock" ]]
exec 9< "$base/lock"
flock -n 9
[[ "$(<"$work/restore.rc")" == 0 && "$(<"$work/backup.sha256")" == "$backup_sha" && "$(<"$work/restore.sealed")" == "$backup_sha" ]]
[[ ! -e "$work/cutover.rc" ]]
stage=inputs
app_started=false
health_passed=false
finish() {
  local rc=$?
  trap - EXIT
  if ((rc)); then
    if [[ "$app_started" == true && "$health_passed" != true ]]; then
      d stop -t 20 metasheet-web metasheet-backend >> "$work/cutover.log" 2>&1 || true
    fi
    printf 'recovery_cutover_failed=%s\n' "$stage"
  fi
  printf '%s\n' "$rc" > "$work/cutover.rc"
  exit "$rc"
}
trap finish EXIT
exec 2>>"$work/cutover.log"
mapfile -t identity < "$work/identity"
[[ "${#identity[@]}" == 7 ]]
project=${identity[0]}
volume=${identity[1]}
pg_user=${identity[2]}
pg_db=${identity[3]}
pg_image=${identity[4]}
directory=${identity[5]}
file=${identity[6]}
[[ "$(d volume inspect -f '{{index .Labels "metasheet.recovery.archive"}}' "$volume")" == 45001991740-1 ]]
[[ "$(d volume inspect -f '{{index .Labels "com.docker.compose.project"}}' "$volume")" == "$project" ]]
for service in postgres redis backend web; do
  ! d inspect --type container "metasheet-$service" >/dev/null 2>&1
done
[[ -z "$(d ps --filter name=metasheet-window-migrate- --format '{{.ID}}')" ]]
for service in backend web; do
  image="ghcr.io/zensgit/metasheet2-$service:$revision"
  [[ "$(d image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" == "$revision" ]]
  expected=$(sed -n "s/^new_${service}_digest=//p" "$origin/meta.txt")
  [[ "$expected" =~ ^ghcr\.io/zensgit/metasheet2-(backend|web)@sha256:[0-9a-f]{64}$ ]]
  d image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image" | grep -Fxq "$expected"
done
cd -- "$directory"
export IMAGE_OWNER=zensgit IMAGE_TAG="$revision"
compose() { d compose -p "$project" --project-directory "$directory" -f "$file" "$@"; }

stage=pin_configuration
[[ -f "$directory/.env" && ! -L "$directory/.env" &&
   -f "$directory/docker/app.env" && ! -L "$directory/docker/app.env" ]]
install -m 600 -- "$directory/.env" "$work/dotenv.before"
install -m 600 -- "$directory/docker/app.env" "$work/app-env.before"
python3 - "$directory" "$revision" <<'PY'
from pathlib import Path
import os, re, sys, tempfile
directory, revision = sys.argv[1:]
root = Path(directory)

def update(path, settings):
    source = path.read_bytes()
    updated = source
    for key, value in settings.items():
        pattern = re.compile(rb'(?m)^[ \t]*(?:export[ \t]+)?'+key+rb'[ \t]*=[^\r\n]*')
        assert len(pattern.findall(updated)) <= 1
        replacement = key+b'='+value
        if pattern.search(updated):
            updated = pattern.sub(replacement, updated)
        else:
            updated += (b'' if not updated or updated.endswith(b'\n') else b'\n') + replacement + b'\n'
    if source != updated:
        descriptor, name = tempfile.mkstemp(dir=path.parent, prefix='.permission-recovery-')
        try:
            with os.fdopen(descriptor, 'wb') as output:
                output.write(updated)
                output.flush()
                os.fsync(output.fileno())
            os.chmod(name, path.stat().st_mode & 0o777)
            os.replace(name, path)
        finally:
            if os.path.exists(name):
                os.unlink(name)

update(root/'.env', {b'IMAGE_OWNER':b'zensgit', b'IMAGE_TAG':revision.encode()})
update(root/'docker/app.env', {b'DELEGATED_SCOPE_ACTIVATION_ENABLED':b'false',
                              b'DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED':b'false'})
PY
compose config --format json > "$work/cutover-compose.json"
python3 - "$work/cutover-compose.json" "$pg_image" "$volume" <<'PY'
import json, sys
from pathlib import Path
path, pg_image, volume = sys.argv[1:]
cfg = json.loads(Path(path).read_text())
assert cfg['services']['postgres']['image'] == pg_image
assert cfg['volumes']['metasheet-postgres-data']['name'] == volume
backend = cfg['services']['backend']['environment']
assert backend['DELEGATED_SCOPE_ACTIVATION_ENABLED'] == 'false'
assert backend['DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED'] == 'false'
PY
attendance_volume=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["volumes"]["metasheet-attendance-import-data"]["name"])' "$work/cutover-compose.json")
[[ "$attendance_volume" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]]
d volume inspect "$attendance_volume" >/dev/null
echo production_flags=both_off

stage=database_and_cache
compose up -d --no-deps --pull never postgres redis >> "$work/cutover.log" 2>&1
[[ "$(d inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' metasheet-postgres)" == "$volume" ]]
for _ in $(seq 1 60); do
  if [[ "$(d inspect --format '{{.State.Health.Status}}' metasheet-postgres)" == healthy &&
        "$(d inspect --format '{{.State.Health.Status}}' metasheet-redis)" == healthy ]]; then break; fi
  sleep 2
done
[[ "$(d inspect --format '{{.State.Health.Status}}' metasheet-postgres)" == healthy ]]
[[ "$(d inspect --format '{{.State.Health.Status}}' metasheet-redis)" == healthy ]]
sql() { d exec -i metasheet-postgres psql -X -qAt -v ON_ERROR_STOP=1 -U "$pg_user" -d "$pg_db" "$@"; }
lsql='SELECT name FROM public.kysely_migration ORDER BY name COLLATE "C"'
ledger=$(sql -c "$lsql")
ledger_hash=$(printf '%s' "$ledger" | sha256sum)
[[ "$(grep -c . <<< "$ledger")" == 335 && "${ledger_hash%% *}" == "$before_sha" ]]
echo production_data_services=healthy

stage=migration
compose run --rm --no-deps -T --name metasheet-permission-recovery-migrate \
  -e "MIGRATION_EXCLUDE=$exclude" -e MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL=false \
  -e ALLOW_DB_RESET=false -e DB_QUERY_TIMEOUT=30000 -e DB_STATEMENT_TIMEOUT=30000 \
  backend node packages/core-backend/dist/src/db/migrate.js --latest \
  </dev/null > "$work/migrate.log" 2>&1
ledger=$(sql -c "$lsql")
ledger_hash=$(printf '%s' "$ledger" | sha256sum)
[[ "$(grep -c . <<< "$ledger")" == 492 && "${ledger_hash%% *}" == "$after_sha" ]]
echo after_ledger=492_verified
scopes() {
  sql -c "$(<"$work/legacy-scopes.sql")" > "$work/legacy-scopes.after"
  cmp -s "$work/legacy-scopes.before" "$work/legacy-scopes.after"
  [[ "$(sql -c 'SELECT count(*) FROM public.delegated_role_admin_scopes WHERE include_children IS DISTINCT FROM true')" == 0 ]]
}
scopes
echo legacy_scopes=verified
stage=backend
app_started=true
compose up -d --no-deps --pull never backend >> "$work/cutover.log" 2>&1
[[ "$(d inspect --format '{{range .Mounts}}{{if eq .Destination "/app/uploads/attendance-import"}}{{.Name}}{{end}}{{end}}' metasheet-backend)" == "$attendance_volume" ]]
health() {
  d exec metasheet-backend node -e '
  const fs = require("node:fs")
  const values = fs.readFileSync("/proc/1/environ","utf8").split("\u0000")
  const get = key => values.find(value => value.startsWith(key + "="))?.slice(key.length+1)
  const port = get("PORT") || "8900"
  if (get("DELEGATED_SCOPE_ACTIVATION_ENABLED") !== "false" || get("DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED") !== "false" || !/^\d{1,5}$/.test(port)) process.exit(1)
  fetch("http://127.0.0.1:" + port + "/health",{redirect:"error",signal:AbortSignal.timeout(3000)})
    .then(async response => {
      const data = await response.json()
      if (!response.ok || data.status !== "ok" || data.build.commit !== process.argv[1]) process.exit(1)
    }).catch(() => process.exit(1))' "$revision"
}
for _ in $(seq 1 60); do
  if health >/dev/null 2>&1; then break; fi
  sleep 2
done
health > /dev/null
echo production_backend=healthy

stage=fence
d exec -i metasheet-backend node - > "$work/fence.log" 2>&1 <<'JS'
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')
const app = createRequire('/app/packages/core-backend/package.json')
const { poolManager } = app('./dist/src/integration/db/connection-pool.js')
const { inspectAuthorizationOperationSchema, isSupportedAuthorizationOperationSchema } = app('./dist/src/admin/authorization-operation-fence.js')
async function run() {
  const client = await poolManager.get().getInternalPool().connect()
  try {
    await client.query('BEGIN READ ONLY')
    await client.query('SET LOCAL search_path TO pg_catalog, public, pg_temp')
    assert(isSupportedAuthorizationOperationSchema(await inspectAuthorizationOperationSchema(client.query.bind(client))))
    await client.query('ROLLBACK')
  } finally {
    client.release()
    await poolManager.close()
  }
}
run().catch(() => { process.exitCode = 1 })
JS
echo production_fence=ready

stage=web
compose up -d --no-deps --pull never web >> "$work/cutover.log" 2>&1
for _ in $(seq 1 40); do
  if d exec metasheet-web wget -T 5 -qO- http://127.0.0.1/build-info.json > "$work/web-build.json"; then break; fi
  sleep 2
done
python3 -c 'import json,sys; assert json.load(sys.stdin)["commit"]==sys.argv[1]' "$revision" < "$work/web-build.json"
d exec metasheet-web wget -T 5 -qO- http://127.0.0.1/api/health \
  | python3 -c 'import json,sys; b=json.load(sys.stdin); assert b["status"]=="ok" and b["build"]["commit"]==sys.argv[1]' "$revision"
d exec metasheet-web wget -T 5 -qO /dev/null http://127.0.0.1/admin/users
binding=$(compose port web 80 | head -n1)
host_port=${binding##*:}
[[ "$host_port" =~ ^[0-9]{2,5}$ ]]
curl -fsS --max-time 8 "http://127.0.0.1:$host_port/api/health" \
  | python3 -c 'import json,sys; b=json.load(sys.stdin); assert b["status"]=="ok" and b["build"]["commit"]==sys.argv[1]' "$revision"
scopes
health_passed=true
echo production_web=healthy
echo production_legacy_scopes_after_start=verified
stage=fixture_inventory
sql <<'SQL'
SELECT 'marked_synthetic_admins=' || count(*) FROM public.users u
 WHERE is_active IS TRUE AND activation_status='activated' AND deleted_at IS NULL AND purged_at IS NULL
   AND email ~* '@example\.(invalid|test)$' AND name ~* '(synthetic|合成|production.smoke|生产冒烟)'
   AND EXISTS(SELECT 1 FROM public.user_roles r WHERE r.user_id=u.id AND r.role_id='admin');
SELECT 'marked_synthetic_members=' || count(*) FROM public.users u
 WHERE is_active IS TRUE AND activation_status='activated' AND deleted_at IS NULL AND purged_at IS NULL
   AND email ~* '@example\.(invalid|test)$' AND name ~* '(synthetic|合成|production.smoke|生产冒烟)'
   AND is_admin IS NOT TRUE AND role IS DISTINCT FROM 'admin'
   AND NOT EXISTS(SELECT 1 FROM public.user_roles r WHERE r.user_id=u.id AND r.role_id='admin');
SQL
echo RECOVERY_CUTOVER_COMPLETE
