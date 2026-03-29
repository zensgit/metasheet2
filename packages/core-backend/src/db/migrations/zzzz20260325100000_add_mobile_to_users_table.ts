import type { Kysely } from 'kysely'
import { addColumnIfNotExists, dropColumnIfExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  await addColumnIfNotExists(db, 'users', 'mobile', 'text')
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await dropColumnIfExists(db, 'users', 'mobile')
}
