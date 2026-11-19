import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'

const requireCondition = (condition) => { if (!condition) throw new Error('SEAM_DATABASE_REFUSED') }

// This fixture accepts only local transports. A database name is not ownership evidence;
// the bootstrap separately verifies the fresh parent-created schema and its random nonce.
function localDatabaseUrl(value, options) {
  const database = new URL(value)
  requireCondition(['postgres:', 'postgresql:'].includes(database.protocol)
    && ['localhost', '127.0.0.1', '[::1]'].includes(database.hostname)
    && /^[0-9]+$/.test(database.port) && Number(database.port) >= 1 && Number(database.port) <= 65535
    && /^\/[^/]+$/.test(database.pathname) && !database.hash
    && [...database.searchParams.keys()].every((key) => key === 'host' || key === 'options')
    && database.searchParams.getAll('host').length <= 1
    && database.searchParams.getAll('options').length === (options === null ? 0 : 1)
    && database.searchParams.get('options') === options)
  if (database.searchParams.has('host')) {
    const socketDirectory = database.searchParams.get('host')
    requireCondition(isAbsolute(socketDirectory))
    const stat = lstatSync(socketDirectory)
    requireCondition(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0
      && stat.uid === process.getuid?.() && realpathSync(socketDirectory) === socketDirectory)
  }
  if (database.hostname === 'localhost') database.hostname = '127.0.0.1'
  return database
}

export function validateSeamBaseDatabaseUrl(value) {
  return localDatabaseUrl(value, null)
}

export function validateSeamDatabaseUrl(value, schema, role) {
  requireCondition(/^sa_wpc_admit_[a-f0-9]{16}$/.test(schema) && ['owner', 'peer', 'smoke'].includes(role))
  return localDatabaseUrl(value, `-c search_path=${schema} -c application_name=sa_wpc_seam_${role}`)
}

export async function assertSeamDatabaseOwner(query, schema, owner) {
  requireCondition(/^sa_wpc_admit_[a-f0-9]{16}$/.test(schema)
    && owner && typeof owner === 'object'
    && Object.keys(owner).sort().join(',') === 'databaseOid,nonce,ownerOid,schemaOid'
    && /^[a-f0-9]{64}$/.test(owner.nonce)
    && ['databaseOid', 'schemaOid', 'ownerOid'].every((key) => typeof owner[key] === 'string' && /^[1-9][0-9]*$/.test(owner[key])))
  const result = await query(
    `SELECT d.oid::text AS database_oid, n.oid::text AS schema_oid,
            n.nspowner::text AS owner_oid,
            pg_catalog.obj_description(n.oid, 'pg_namespace') AS nonce,
            n.nspowner = r.oid AS owned
       FROM pg_catalog.pg_database d
       JOIN pg_catalog.pg_namespace n ON n.nspname = $1
       JOIN pg_catalog.pg_roles r ON r.rolname = current_user
      WHERE d.datname = pg_catalog.current_database()`,
    [schema],
  )
  const row = result.rows[0]
  requireCondition(result.rows.length === 1 && row.owned === true
    && row.database_oid === owner.databaseOid && row.schema_oid === owner.schemaOid
    && row.owner_oid === owner.ownerOid && row.nonce === owner.nonce)
}
