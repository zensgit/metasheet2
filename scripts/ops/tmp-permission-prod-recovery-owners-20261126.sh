#!/usr/bin/env bash
set -euo pipefail
umask 077
root="$HOME/metasheet2-deploy-window"
origin="$root/runs/45001991740-1"
work="$root/permission-recovery-20261126-v2"
[[ "$(<"$work/cutover-resume.rc")" == 0 ]]
[[ "$(<"$work/restore.sealed")" == 8de8859655e253bda775d51407475822466c7e48a7e28f77589d3052763daffd ]]
exec 9< "$root/lock"
flock -n 9
echo RECOVERY_OWNERSHIP_STARTED
exec 2>>"$work/ownership-recovery.log"
mapfile -t identity < "$work/identity"
pg_user=${identity[2]}
pg_db=${identity[3]}
[[ "$pg_user" =~ ^[a-z_][a-z0-9_]{0,62}$ && "$pg_db" =~ ^[a-z_][a-z0-9_]{0,62}$ ]]
python3 - "$origin/env-snapshot.app.env" "$pg_user" <<'PY'
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit
config = {}
for line in Path(sys.argv[1]).read_text().splitlines():
    key, sep, value = line.partition('=')
    if sep and key in {'POSTGRES_USER', 'DATABASE_URL'}:
        assert key not in config
        config[key] = value.strip().strip('\'"')
assert config['POSTGRES_USER'] == sys.argv[2]
assert unquote(urlsplit(config['DATABASE_URL']).username or '') == sys.argv[2]
PY
sql() { docker exec -i metasheet-postgres psql -X -qAt -v ON_ERROR_STOP=1 -U "$pg_user" -d "$pg_db" "$@"; }
[[ "$(sql -c "SELECT pg_get_userbyid(datdba)=current_user FROM pg_database WHERE datname=current_database()" </dev/null)" == t ]]
sql -c "SELECT DISTINCT e.extname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_depend d ON d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e' AND d.refclassid='pg_extension'::regclass JOIN pg_extension e ON e.oid=d.refobjid WHERE p.proowner='permission_recovery_bootstrap_20261126'::regrole AND n.nspname='public' AND p.prokind='f' ORDER BY e.extname" </dev/null > "$work/ownership-extension.list"
python3 - "$origin/db.toc" "$work/ownership-extension.list" <<'PY'
import re, sys
from pathlib import Path
toc = Path(sys.argv[1]).read_text()
archived = set(re.findall(r'(?m)^\d+;\s+\d+\s+\d+\s+EXTENSION\s+-\s+([A-Za-z0-9_-]+)\s*$', toc))
observed = set(Path(sys.argv[2]).read_text().splitlines())
assert observed and observed <= archived
PY
echo recovery_owner_provenance=verified

sql --single-transaction -f - > "$work/ownership-transaction.log" <<'SQL'
SET LOCAL search_path TO pg_catalog, public, pg_temp;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';
DO $verify$
DECLARE
  bootstrap record;
  total int;
  safe int;
BEGIN
  SELECT oid, rolcanlogin INTO STRICT bootstrap FROM pg_roles WHERE rolname='permission_recovery_bootstrap_20261126';
  IF bootstrap.rolcanlogin OR (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database())<>current_user THEN
    RAISE EXCEPTION 'restoration owner provenance changed';
  END IF;
  SELECT count(*), count(*) FILTER(WHERE NOT p.prosecdef
    AND EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e' AND d.refclassid='pg_extension'::regclass))
  INTO total, safe
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.prokind='f' AND p.proowner=bootstrap.oid;
  IF total<>224 OR safe<>total THEN
    RAISE EXCEPTION 'restoration owner scope changed';
  END IF;
END
$verify$;
SELECT format('ALTER FUNCTION %I.%I(%s) OWNER TO %I',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),current_user)
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.prokind='f' AND NOT p.prosecdef AND p.proowner='permission_recovery_bootstrap_20261126'::regrole
  AND EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e' AND d.refclassid='pg_extension'::regclass)
ORDER BY p.oid
\gexec
DO $verify$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.prokind='f' AND p.proowner='permission_recovery_bootstrap_20261126'::regrole) THEN
    RAISE EXCEPTION 'temporary owner remained';
  END IF;
END
$verify$;
SQL
echo restore_extension_function_ownership=224_reassigned
sql -c "$(<"$work/legacy-scopes.sql")" </dev/null > "$work/legacy-scopes.after-ownership"
cmp -s "$work/legacy-scopes.before" "$work/legacy-scopes.after-ownership"
echo legacy_scopes_after_ownership=verified
docker exec -i metasheet-backend node - 2>>"$work/ownership-recovery.log" <<'JS'
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
run().catch(() => { process.exitCode = 1 })
JS
echo RECOVERY_OWNERSHIP_COMPLETE
