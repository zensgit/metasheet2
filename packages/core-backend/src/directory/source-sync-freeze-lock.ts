/**
 * Transfer MVP T2 (§12.2) — cross-process linearization for source-sync freeze.
 *
 * The cheap entry check in `syncDirectoryIntegration` (before the run lease) is necessary but
 * not sufficient: a transfer create / freeze=true refreeze can commit after that check and
 * before the sync's local apply transaction. Without a shared write-point lock, the sync would
 * still perform the destructive absence sweep (and other local directory mutations) against a
 * source that is already frozen.
 *
 * All freeze writers (create, freeze=true/refreeze mutation) and the sync local-apply
 * transaction acquire the same transaction-scoped PostgreSQL advisory lock keyed by
 * source integration id. Under that lock the sync re-checks for an active frozen transfer
 * before ANY local directory mutation. If freeze linearized first, the apply rolls back and
 * throws `DirectorySyncFrozenByTransferError`. If the apply owns the lock first, it may
 * commit before freeze becomes active.
 *
 * Key shape mirrors the PB4-3 reparent serialization key (`directory:reparent:${id}`).
 * `pg_advisory_xact_lock` releases on COMMIT/ROLLBACK — never session-leaked.
 */

export type SourceSyncFreezeLockClient = {
  query: (sql: string, params?: unknown[]) => Promise<unknown>
}

/** Stable advisory-lock key for a source integration's freeze/apply linearization. */
export function sourceSyncFreezeLockKey(sourceIntegrationId: string): string {
  return `directory:source-sync-freeze:${sourceIntegrationId}`
}

/**
 * Acquire the source freeze lock for the CURRENT transaction. Must be the first operation of
 * the sync local-apply transaction (before any directory upsert / absence sweep / membership
 * rewrite / identity-link write / local-user admission / group projection / deprovision /
 * integration completion / run completion write). Create and freeze mutations take the same
 * key before their INSERT/UPDATE of freeze-affecting state.
 */
export async function acquireSourceSyncFreezeLock(
  client: SourceSyncFreezeLockClient,
  sourceIntegrationId: string,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    sourceSyncFreezeLockKey(sourceIntegrationId),
  ])
}
