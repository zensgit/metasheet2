/**
 * Identity of the database a connection is attached to, for detecting that the serving database
 * changed underneath a running process.
 *
 * The identity is the cluster system identifier, the database oid, the timeline of the last
 * checkpoint and whether the server is in recovery. Two connections of one process must agree on
 * the first two, and neither may be attached to a server in recovery. A process pins the identity it
 * first accepted; any later connection, or any later read on the listening session, that does not
 * match the pin is evidence that the database was replaced, restored or switched.
 *
 * What this module can and cannot establish: it detects a change and reports it so the process
 * stops serving protected realtime traffic. It does not prove that a database holds every committed
 * fact; an identity that matches is not such a proof, and re-admitting a changed database is not
 * something a serving process decides for itself.
 */

export interface DatabaseIdentity {
  readonly systemIdentifier: string
  readonly databaseOid: string
  readonly timelineId: string
  readonly inRecovery: boolean
}

export const DATABASE_IDENTITY_SQL = `
SELECT (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS system_identifier,
       (SELECT d.oid::text FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()) AS database_oid,
       (SELECT timeline_id::text FROM pg_catalog.pg_control_checkpoint()) AS timeline_id,
       pg_catalog.pg_is_in_recovery() AS in_recovery`

export type IdentityQuery = (sql: string) => Promise<{ rows: ReadonlyArray<Record<string, unknown>> }>

/** Rejects when the identity cannot be read completely. */
export async function readDatabaseIdentity(query: IdentityQuery): Promise<DatabaseIdentity> {
  const result = await query(DATABASE_IDENTITY_SQL)
  const row = result.rows[0]
  const systemIdentifier = row?.system_identifier
  const databaseOid = row?.database_oid
  const timelineId = row?.timeline_id
  const inRecovery = row?.in_recovery
  if (
    result.rows.length !== 1
    || typeof systemIdentifier !== 'string' || systemIdentifier.length === 0
    || typeof databaseOid !== 'string' || databaseOid.length === 0
    || typeof timelineId !== 'string' || timelineId.length === 0
    || typeof inRecovery !== 'boolean'
  ) {
    throw new Error('database identity not readable')
  }
  return Object.freeze({ systemIdentifier, databaseOid, timelineId, inRecovery })
}

export type IdentityMismatch =
  | 'in-recovery'
  | 'system-identifier-changed'
  | 'database-changed'
  | 'timeline-changed'

/** Null when `seen` is the pinned database on the pinned timeline and is not in recovery. */
export function compareDatabaseIdentity(pinned: DatabaseIdentity, seen: DatabaseIdentity): IdentityMismatch | null {
  if (seen.inRecovery) return 'in-recovery'
  if (seen.systemIdentifier !== pinned.systemIdentifier) return 'system-identifier-changed'
  if (seen.databaseOid !== pinned.databaseOid) return 'database-changed'
  if (seen.timelineId !== pinned.timelineId) return 'timeline-changed'
  return null
}
