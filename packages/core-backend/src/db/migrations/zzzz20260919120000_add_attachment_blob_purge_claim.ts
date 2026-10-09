import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE public.multitable_attachments
    ADD COLUMN IF NOT EXISTS blob_purge_claimed_at timestamptz`.execute(db)
  const result = await sql<{ valid: boolean }>`SELECT
    format_type(a.atttypid,a.atttypmod)='timestamp with time zone'
    AND NOT a.attnotnull AND NOT a.atthasdef AND a.attgenerated='' AS valid
    FROM pg_attribute a WHERE a.attrelid='public.multitable_attachments'::regclass
      AND a.attname='blob_purge_claimed_at' AND NOT a.attisdropped`.execute(db)
  if (result.rows.length !== 1 || result.rows[0]?.valid !== true) {
    throw new Error('ATTACHMENT_PURGE_CLAIM_SCHEMA_DRIFT')
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await sql`LOCK TABLE public.multitable_attachments IN ACCESS EXCLUSIVE MODE`.execute(tx)
    const column = await sql`SELECT 1 FROM pg_attribute
      WHERE attrelid='public.multitable_attachments'::regclass
        AND attname='blob_purge_claimed_at' AND NOT attisdropped`.execute(tx)
    if (!column.rows.length) return
    const used = await sql`SELECT 1 FROM public.multitable_attachments
      WHERE blob_purge_claimed_at IS NOT NULL LIMIT 1`.execute(tx)
    if (used.rows.length) throw new Error('ATTACHMENT_PURGE_CLAIM_DOWN_IN_USE')
    await sql`ALTER TABLE public.multitable_attachments DROP COLUMN blob_purge_claimed_at`.execute(tx)
  })
}
