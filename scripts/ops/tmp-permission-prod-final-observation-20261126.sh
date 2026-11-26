#!/usr/bin/env bash
set -euo pipefail
umask 077
rev=135a04df0bcc2c3f2d60a05f7de0b721b5b5e10f
work="$HOME/metasheet2-deploy-window/permission-recovery-20261126-v2"
[[ "$(<"$work/cutover-resume.rc")" == 0 ]]
for service in postgres redis backend web; do
  [[ "$(timeout 10s docker inspect -f '{{.State.Status}}' "metasheet-$service")" == running ]]
  if [[ "$service" == postgres || "$service" == redis ]]; then
    [[ "$(timeout 10s docker inspect -f '{{.State.Health.Status}}' "metasheet-$service")" == healthy ]]
  fi
  printf 'final_container_%s=healthy\n' "$service"
done
mapfile -t identity < "$work/identity"
pg_user=${identity[2]}
pg_db=${identity[3]}
docker exec metasheet-postgres psql -X -qAt -v ON_ERROR_STOP=1 -U "$pg_user" -d "$pg_db" \
  -c "$(<"$work/legacy-scopes.sql")" </dev/null > "$work/legacy-scopes.final"
cmp -s "$work/legacy-scopes.before" "$work/legacy-scopes.final"
IFS='|' read -r department _ group _ < "$work/legacy-scopes.final"
printf 'final_legacy_departments=%s final_legacy_member_groups=%s exact_archive_snapshot_match=true\n' "$department" "$group"
docker exec metasheet-web wget -T 5 -qO- http://127.0.0.1/api/health \
  | python3 -c 'import json,sys; b=json.load(sys.stdin); assert b["status"]=="ok" and b["build"]["commit"]==sys.argv[1]' "$rev"
docker exec metasheet-web wget -T 5 -qO- http://127.0.0.1/build-info.json \
  | python3 -c 'import json,sys; assert json.load(sys.stdin)["commit"]==sys.argv[1]' "$rev"
echo final_web_and_api_build=verified
docker exec -i metasheet-backend node - 2>>"$work/final-recovery.log" <<'JS'
const { createRequire } = require('node:module')
const { readFileSync } = require('node:fs')
const app = createRequire('/app/packages/core-backend/package.json')
async function run() {
  const vars = readFileSync('/proc/1/environ', 'utf8').split('\0')
  const bothOff = vars.includes('DELEGATED_SCOPE_ACTIVATION_ENABLED=false') && vars.includes('DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED=false')
  if (!bothOff) throw new Error('Unexpected live range flags')
  console.log('final_range_flags=both_off')
  const { poolManager } = app('./dist/src/integration/db/connection-pool.js')
  const guard = app('./dist/src/admin/authorization-operation-fence.js')
  const client = await poolManager.get().getInternalPool().connect()
  try {
    await client.query('BEGIN READ ONLY')
    await client.query('SET LOCAL search_path TO pg_catalog, public, pg_temp')
    try {
      await guard.assertAuthorizationOperationSchema(client.query.bind(client))
      console.log('final_authorization_guard=ready')
    } catch (error) {
      if (error.code !== 'AUTHORIZATION_OPERATION_FENCE_UNAVAILABLE') throw error
      console.log('final_authorization_guard=refuses_unsupported_catalog')
    }
    await client.query('ROLLBACK')
  } finally {
    client.release()
    await poolManager.close()
  }
}
run().catch(() => { process.exitCode=1 })
JS
echo FINAL_PRODUCTION_OBSERVATION_COMPLETE
