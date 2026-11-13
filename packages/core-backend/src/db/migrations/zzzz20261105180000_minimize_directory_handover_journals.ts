import { CompiledQuery, sql, type Kysely } from 'kysely'
import {
  compactHandoverJournal,
  digest,
} from '../../directory/handover-journal-v2'

import {
  readHandoverSnapshot,
  type Row,
} from '../../directory/handover-snapshot-v1'

type LegacyJournal = {
  accounts: Record<string, unknown>[]
  departments: Record<string, unknown>[]
  [key: string]: unknown
}

// jsonpath checks inside arrays prevent a v2 marker from concealing a legacy
// account row, contact fields or provider payloads in an otherwise valid envelope.
const uuidPattern = '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
const timestampPattern = '^([0-9]{4,}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}(:[0-9]{2}){0,2})( BC)?|-?infinity)$'
const invalidAccount = `strict $.accounts[*] ? (@.type() != "object" || !exists(@.id) || !exists(@.updated_at)
  || @.id.type() != "string" || !(@.id like_regex "${uuidPattern}")
  || @.updated_at.type() != "string" || !(@.updated_at like_regex "${timestampPattern}"))`
const invalidTarget = `strict $.targetDepartmentIds[*] ? (@.type() != "string" || !(@ like_regex "${uuidPattern}"))`

export async function up(db: Kysely<unknown>): Promise<void> {
  // The migrator holds a transaction. Freeze old apply/finish writers across
  // conversion and the constraint that fences the retired write format.
  await sql`SET LOCAL lock_timeout='5s'`.execute(db)
  await sql`LOCK TABLE directory_handovers IN ACCESS EXCLUSIVE MODE`.execute(db)
  await sql`UPDATE directory_handovers SET before_state='{}'::jsonb
    WHERE state IN ('finalized','rolled_back') AND before_state <> '{}'::jsonb`.execute(
    db,
  )
  // Read one potentially large legacy snapshot at a time, never its live replacement.
  let cursor: string | null = null
  for (;;) {
    const result = await sql<{
      id: string
      source_integration_id: string
      target_integration_id: string
      after_digest: string
      before_state: LegacyJournal
    }>`SELECT id,source_integration_id,target_integration_id,after_digest,before_state FROM directory_handovers
       WHERE state='applied' AND (${cursor}::uuid IS NULL OR id > ${cursor}::uuid)
       ORDER BY id LIMIT 1`.execute(db)
    const row = result.rows[0]
    if (!row) break
    const before = row.before_state
    const current = await readHandoverSnapshot(
      {
        query: (query, params) =>
          db.executeQuery<Row>(CompiledQuery.raw(query, params)),
      },
      {
        sourceIntegrationId: row.source_integration_id,
        targetIntegrationId: row.target_integration_id,
      },
    )
    if (digest(current) !== row.after_digest) {
      throw new Error(
        'Applied directory handover has drifted; retain the legacy journal',
      )
    }
    cursor = row.id
    // A newer binary can have written a compact row while a schema upgrade was
    // pending. Its original after-digest still needs the same compatibility check.
    if (before?.version === 2) continue
    if (
      !before ||
      ![
        'integrations',
        'accounts',
        'departments',
        'memberships',
        'links',
        'authority',
        'cards',
        'departmentBindings',
        'dependencies',
      ].every((key) => Array.isArray(before[key]))
    ) {
      throw new Error('Unsupported applied directory handover journal')
    }
    const compact = compactHandoverJournal(
      before,
      row.source_integration_id,
      row.target_integration_id,
    )
    await sql`UPDATE directory_handovers SET before_state=${JSON.stringify(compact)}::jsonb WHERE id=${row.id}`.execute(
      db,
    )
  }
  await sql`ALTER TABLE directory_handovers DROP CONSTRAINT IF EXISTS directory_handover_private_journal`.execute(
    db,
  )
  await sql`ALTER TABLE directory_handovers ADD CONSTRAINT directory_handover_private_journal CHECK (
    CASE WHEN state='applied' THEN (before_state @> '{"version":2}'::jsonb
      AND jsonb_typeof(before_state->'accounts')='array'
      AND jsonb_typeof(before_state->'targetDepartmentIds')='array'
      AND jsonb_array_length(before_state->'accounts') > 0
      AND NOT jsonb_path_exists(before_state, ${sql.lit(invalidAccount)}::jsonpath)
      AND NOT jsonb_path_exists(before_state, 'strict $.accounts[*].keyvalue() ? (@.key != "id" && @.key != "updated_at")')
      AND NOT jsonb_path_exists(before_state, ${sql.lit(invalidTarget)}::jsonpath)
      AND jsonb_typeof(before_state->'beforeDigest')='string'
      AND before_state->>'beforeDigest' ~ '^[0-9a-f]{64}$'
      AND before_state - ARRAY['version','beforeDigest','accounts','targetDepartmentIds']='{}'::jsonb) IS TRUE
    ELSE before_state='{}'::jsonb END
  )`.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`SET LOCAL lock_timeout='5s'`.execute(db)
  await sql`LOCK TABLE directory_handovers IN ACCESS EXCLUSIVE MODE`.execute(db)
  const pending =
    await sql`SELECT 1 FROM directory_handovers WHERE state='applied' LIMIT 1`.execute(
      db,
    )
  if (pending.rows.length)
    throw new Error('Resolve applied directory handovers before downgrade')
  // Historical terminal payloads are intentionally unrecoverable from the journal.
  await sql`ALTER TABLE directory_handovers DROP CONSTRAINT IF EXISTS directory_handover_private_journal`.execute(
    db,
  )
}
