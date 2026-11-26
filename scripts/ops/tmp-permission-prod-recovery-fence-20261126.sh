#!/usr/bin/env bash
set -euo pipefail
umask 077
work="$HOME/metasheet2-deploy-window/permission-recovery-20261126-v2"
[[ "$(<"$work/cutover-resume.rc")" == 0 ]]
[[ "$(docker inspect -f '{{.State.Status}}' metasheet-backend)" == running ]]
file="$work/fence-structural-inspection.log"
docker exec -i metasheet-backend node - > "$file" 2>&1 <<'JS'
const { createRequire } = require('node:module')
const app = createRequire('/app/packages/core-backend/package.json')
const { poolManager } = app('./dist/src/integration/db/connection-pool.js')
const {
  AUTHORIZATION_OPERATION_FENCE_TABLES: tables,
  inspectAuthorizationOperationSchema: inspect,
  isSupportedAuthorizationOperationSchema: supported,
} = app('./dist/src/admin/authorization-operation-fence.js')

async function run() {
  const client = await poolManager.get().getInternalPool().connect()
  try {
    await client.query('BEGIN READ ONLY')
    await client.query('SET LOCAL search_path TO pg_catalog,public,pg_temp')
    const query = client.query.bind(client)
    const tableCounts = await query(
      "SELECT count(*) FILTER(WHERE c.relowner<>d.datdba AND c.relowner<>n.nspowner)::int AS other_owner, count(*) FILTER(WHERE c.relowner=to_regrole('permission_recovery_bootstrap_20261126')::oid)::int AS recovery_owner, count(*) FILTER(WHERE c.relkind<>'r' OR c.relpersistence<>'p' OR c.relispartition OR c.relhassubclass OR c.relrowsecurity OR c.relforcerowsecurity)::int AS shape FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_database d ON d.datname=current_database() WHERE n.nspname='public' AND c.relname=ANY($1)",
      [tables],
    )
    const fnCounts = await query(
      "SELECT count(*) FILTER (WHERE p.proowner<>d.datdba AND p.proowner<>n.nspowner)::int AS other_owner, count(*) FILTER(WHERE p.proowner=to_regrole('permission_recovery_bootstrap_20261126')::oid)::int AS recovery_owner, count(*) FILTER(WHERE p.proowner=to_regrole('permission_recovery_bootstrap_20261126')::oid AND EXISTS (SELECT 1 FROM pg_depend x WHERE x.classid='pg_catalog.pg_proc'::regclass AND x.objid=p.oid AND x.deptype='e'))::int AS recovery_extension FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_database d ON d.datname=current_database() WHERE n.nspname='public' AND p.prokind='f'",
    )
    const schemaCounts = await query(
      "SELECT count(*) FILTER(WHERE a.grantee=0 AND a.privilege_type='CREATE')::int AS public_create, count(*) FILTER(WHERE a.privilege_type='CREATE' AND a.grantee<>0 AND a.grantee<>n.nspowner AND a.grantee<>d.datdba)::int AS other_create FROM pg_namespace n JOIN pg_database d ON d.datname=current_database() CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='public'",
    )
    const env = await query("SELECT datcollate='C' AS locale_c, datctype='C' AS encoding_ctype_c FROM pg_database WHERE datname=current_database()")
    const observed = await inspect(query)
    const output = {
      table_other_owner: tableCounts.rows[0].other_owner,
      table_recovery_owner: tableCounts.rows[0].recovery_owner,
      table_shape_mismatch: tableCounts.rows[0].shape,
      function_other_owner: fnCounts.rows[0].other_owner,
      function_recovery_owner: fnCounts.rows[0].recovery_owner,
      function_recovery_extension_member: fnCounts.rows[0].recovery_extension,
      schema_public_create: schemaCounts.rows[0].public_create,
      schema_other_create: schemaCounts.rows[0].other_create,
      locale_c: env.rows[0].locale_c,
      ctype_c: env.rows[0].encoding_ctype_c,
      guard_supported: supported(observed),
    }
    for (const [key, value] of Object.entries(output)) console.log('catalog_' + key + '=' + value)
    await client.query('ROLLBACK')
  } finally {
    client.release()
    await poolManager.close()
  }
}
run().catch(error => {
  const code = /^[a-zA-Z0-9_]{1,30}$/.test(error.code ?? '') ? error.code : 'unknown'
  console.log('catalog_probe_error=' + code)
  process.exitCode=1
})
JS
grep -E '^catalog_[a-z_]+=(true|false|[0-9]+)$' "$file"
