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
[[ "$(<"$work/cutover.rc")" != 0 && ! -e "$work/cutover-resume.rc" ]]
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
  printf '%s\n' "$rc" > "$work/cutover-resume.rc"
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
[[ "$(d inspect --format '{{.State.Health.Status}}' metasheet-postgres)" == healthy ]]
[[ "$(d inspect --format '{{.State.Health.Status}}' metasheet-redis)" == healthy ]]
backend_image=$(d inspect --format '{{.Image}}' metasheet-backend)
[[ "$(d image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$backend_image")" == "$revision" ]]
[[ "$(d inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' metasheet-postgres)" == "$volume" ]]
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

stage=prior_migration_evidence
[[ "$(d image inspect --format '{{.Id}}' "ghcr.io/zensgit/metasheet2-backend:$revision")" == "$backend_image" ]]
sql() { d exec -i metasheet-postgres psql -X -qAt -v ON_ERROR_STOP=1 -U "$pg_user" -d "$pg_db" "$@"; }
ledger=$(sql -c 'SELECT name FROM public.kysely_migration ORDER BY name COLLATE "C"')
ledger_hash=$(printf '%s' "$ledger" | sha256sum)
[[ "$(grep -c . <<< "$ledger")" == 492 && "${ledger_hash%% *}" == "$after_sha" ]]
echo after_ledger=492_verified
attendance_volume=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["volumes"]["metasheet-attendance-import-data"]["name"])' "$work/cutover-compose.json")
scopes() {
  sql -c "$(<"$work/legacy-scopes.sql")" > "$work/legacy-scopes.after"
  cmp -s "$work/legacy-scopes.before" "$work/legacy-scopes.after"
  [[ "$(sql -c 'SELECT count(*) FROM public.delegated_role_admin_scopes WHERE include_children IS DISTINCT FROM true')" == 0 ]]
}
scopes
echo legacy_scopes=verified
stage=backend
app_started=true
d start metasheet-backend >> "$work/cutover.log" 2>&1
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
echo production_flags=both_off
stage=fence_readonly
d exec -i metasheet-backend node - 2>>"$work/fence-resume.log" <<'JS'
const { createRequire } = require('node:module')
const app = createRequire('/app/packages/core-backend/package.json')
async function run() {
  const { poolManager } = app('./dist/src/integration/db/connection-pool.js')
  const { inspectAuthorizationOperationSchema, isSupportedAuthorizationOperationSchema } = app('./dist/src/admin/authorization-operation-fence.js')
  const client = await poolManager.get().getInternalPool().connect()
  try {
    await client.query('BEGIN READ ONLY')
    const initial = await client.query("SELECT current_schema() = 'public' AS is_public")
    await client.query('SET LOCAL search_path TO pg_catalog, public, pg_temp')
    const schema = await inspectAuthorizationOperationSchema(client.query.bind(client))
    const ready = initial.rows[0]?.is_public === true && isSupportedAuthorizationOperationSchema(schema)
    console.log('production_fence=' + (ready ? 'ready' : 'unsupported'))
    console.log('fence_structural_profile=' + schema.digest + ' ordinary=' + schema.ordinary + ' tables=' + schema.tableCount)
    if (schema.baseDigest) console.log('fence_base_profile=' + schema.baseDigest)
    await client.query('ROLLBACK')
  } finally {
    client.release()
    await poolManager.close()
  }
}
run().catch((error) => {
  const code = /^[a-zA-Z0-9_]{1,30}$/.test(error.code ?? '') ? error.code : 'unknown'
  console.log('production_fence=probe_error error_category=' + code)
})
JS
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
