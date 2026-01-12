import type { Kysely } from 'kysely'

import type { Database } from '../types'

export async function up(_db: Kysely<Database>): Promise<void> {
  // No-op placeholder to satisfy existing migration history.
}

export async function down(_db: Kysely<Database>): Promise<void> {
  // No-op placeholder to satisfy existing migration history.
}
