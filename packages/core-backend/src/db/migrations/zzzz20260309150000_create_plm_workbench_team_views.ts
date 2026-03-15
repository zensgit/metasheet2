import type { Kysely } from 'kysely'

// Compatibility no-op migration.
// This timestamp was already executed in the local dev database during parallel development.
// Keep the file in history so migration discovery remains stable across environments.
export async function up(_db: Kysely<unknown>): Promise<void> {}

export async function down(_db: Kysely<unknown>): Promise<void> {}
