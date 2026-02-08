import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { addColumnIfNotExists, createIndexIfNotExists, dropColumnIfExists, dropIndexIfExists } from './_patterns'

// Adds a stable idempotency key for attendance import batches so that repeated commits
// (e.g. client retries) can be safely de-duplicated.

export async function up(db: Kysely<unknown>): Promise<void> {
  await addColumnIfNotExists(db, 'attendance_import_batches', 'idempotency_key', 'text')

  // Allow NULL/empty keys without uniqueness constraints; enforce uniqueness per org for non-empty keys.
  await createIndexIfNotExists(
    db,
    'uq_attendance_import_batches_idempotency_key',
    'attendance_import_batches',
    ['org_id', 'idempotency_key'],
    {
      unique: true,
      where: sql`idempotency_key IS NOT NULL AND idempotency_key <> ''`,
    }
  )
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await dropIndexIfExists(db, 'uq_attendance_import_batches_idempotency_key')
  await dropColumnIfExists(db, 'attendance_import_batches', 'idempotency_key')
}

