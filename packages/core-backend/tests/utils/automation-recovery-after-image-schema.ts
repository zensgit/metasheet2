import type { Kysely } from 'kysely'
import { up as addSubscriptions } from '../../src/db/migrations/zzzz20260505103000_create_meta_record_subscriptions'
import { up as addTrash } from '../../src/db/migrations/zzzz20260617120000_create_meta_records_trash'
import { up as addTrashRevision } from '../../src/db/migrations/zzzz20260709100000_add_delete_revision_id_to_meta_records_trash'
import { up as addMarkers } from '../../src/db/migrations/zzzz20260713150000_create_meta_record_version_markers'
import { up as addChainSeq } from '../../src/db/migrations/zzzz20260715160000_add_meta_record_chain_seq'
import { up as addWriterState } from '../../src/db/migrations/zzzz20260715170000_add_meta_sheet_recovery_writer_state'
import { up as addCheckpoints } from '../../src/db/migrations/zzzz20260715180000_create_meta_history_trust_checkpoints'
import { up as addBurns } from '../../src/db/migrations/zzzz20260719120000_create_meta_recovery_token_burns'
import { up as addOperations } from '../../src/db/migrations/zzzz20260715210000_create_meta_record_history_operations'
import { RECOVERY_AUTHORITY_TRIGGERS } from '../../src/db/migrations/zzzz20260721121000_add_recovery_authority_locks'

type Query = (statement: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
const ownTables = ['meta_records_trash', 'meta_record_version_markers', 'meta_history_trust_checkpoints',
  'meta_history_baselines', 'meta_recovery_token_burns', 'meta_record_history_operations', 'meta_links',
  'meta_record_subscriptions', 'meta_record_subscription_notifications'] as const
const historyFunctions = ['meta_record_reject_append_to_sealed_operation', 'meta_record_history_operations_validate_endpoint',
  'meta_record_history_operations_reject_update', 'meta_record_history_operations_reject_delete'] as const
const lockFunctions = ['metasheet_try_recovery_authority_user', 'metasheet_try_recovery_authority_role',
  'metasheet_try_recovery_authority_group'] as const
const triggerFunctions = ['metasheet_recovery_authority_user_trigger', 'metasheet_recovery_role_permission_trigger',
  'metasheet_recovery_authority_subject_trigger'] as const
const identifier = (value: string) => {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error('SA06AR_UNSAFE_IDENTIFIER')
  return '"' + value + '"'
}

/**
 * Only the final hot HTTP case installs this substrate in its already-owned
 * random schema. The public schema MUST be freshly migrated by the harness;
 * missing canonical functions/triggers are an error, never a skipped test.
 * Owned forwarding functions are DB transport to the actual canonical advisory
 * lock functions, not token/auth mocks. The runtime still checks all six public
 * executable fingerprints and all nine trigger shapes. No public row is seeded.
 */
export async function bootstrapOwnedRecoveryAfterImageSchema(input: {
  db: Kysely<unknown>; query: Query; schema: string
}): Promise<{ cleanup(): Promise<void> }> {
  if (!/^automation_authority_[a-f0-9]{16}$/u.test(input.schema)) throw new Error('SA06AR_UNOWNED_SCHEMA')
  const { query, schema } = input
  const namespace = (await query(`SELECT n.oid::text AS oid,n.nspowner=current_user::regrole AS owned,
    current_schema()=$1 AS selected FROM pg_namespace n WHERE n.nspname=$1`, [schema])).rows[0]
  if (namespace?.owned !== true || namespace.selected !== true) throw new Error('SA06AR_UNOWNED_SCHEMA')
  const owned = (table: string) => identifier(schema) + '.' + identifier(table)
  for (const table of ['meta_bases', 'meta_sheets', 'meta_fields', 'meta_records', 'meta_record_revisions',
    ...new Set(RECOVERY_AUTHORITY_TRIGGERS.map(([table]) => table))]) {
    const row = (await query(`SELECT to_regclass($1)::oid=to_regclass($2)::oid AS same,
      c.relnamespace=$3::oid AS owned FROM pg_class c WHERE c.oid=to_regclass($1)`,
    [table, schema + '.' + table, namespace.oid])).rows[0]
    if (row?.same !== true || row.owned !== true) throw new Error('SA06AR_RELATION_NOT_OWNED')
  }
  for (const table of ownTables) {
    if ((await query('SELECT to_regclass($1) IS NULL AS absent', [schema + '.' + table])).rows[0]?.absent !== true) {
      throw new Error('SA06AR_BOOTSTRAP_ALREADY_PRESENT')
    }
  }
  if ((await query('SELECT to_regclass($1) IS NULL AS absent', [schema + '.meta_record_chain_seq'])).rows[0]?.absent !== true) {
    throw new Error('SA06AR_BOOTSTRAP_ALREADY_PRESENT')
  }
  for (const fn of [...historyFunctions.map(name => name + '()'), 'meta_record_history_operations_prune(text,uuid)',
    ...lockFunctions.map(name => name + '(text,boolean)')]) {
    if ((await query('SELECT to_regprocedure($1) IS NULL AS absent', [schema + '.' + fn])).rows[0]?.absent !== true) {
      throw new Error('SA06AR_BOOTSTRAP_ALREADY_PRESENT')
    }
  }
  for (const [table, column] of [['meta_record_revisions', 'seq'], ['meta_record_revisions', 'operation_id'],
    ['meta_sheets', 'recovery_writer_state'], ['meta_sheets', 'system_kind']]) {
    if ((await query(`SELECT count(*)::int AS n FROM pg_attribute WHERE attrelid=$1::regclass
      AND attname=$2 AND NOT attisdropped`, [schema + '.' + table, column])).rows[0]?.n !== 0) {
      throw new Error('SA06AR_BOOTSTRAP_ALREADY_PRESENT')
    }
  }
  for (const [table, trigger] of RECOVERY_AUTHORITY_TRIGGERS) {
    if ((await query('SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid=$1::regclass AND tgname=$2', [schema + '.' + table, trigger])).rows[0]?.n !== 0) {
      throw new Error('SA06AR_BOOTSTRAP_ALREADY_PRESENT')
    }
  }
  if ((await query('SELECT count(*)::int AS n FROM meta_record_revisions')).rows[0]?.n !== 0) {
    throw new Error('SA06AR_BOOTSTRAP_REQUIRES_EMPTY_HISTORY')
  }
  for (const fn of [...lockFunctions.map(name => name + '(text,boolean)'), ...triggerFunctions.map(name => name + '()')]) {
    if ((await query('SELECT to_regprocedure($1) IS NOT NULL AS present', ['public.' + fn])).rows[0]?.present !== true) {
      throw new Error('SA06AR_CANONICAL_MIGRATION_PREREQUISITE_MISSING')
    }
  }
  // The real post-commit sweep explicitly reads public archive tables. In this
  // fresh synthetic harness there must be no eligible work belonging elsewhere.
  if ((await query(`SELECT count(*)::int AS n FROM public.meta_recovery_token_burns b
    JOIN public.meta_recovery_archives a ON a.generation_id=b.archive_generation_id
    WHERE b.burn_kind IN ('sync','async') AND b.terminal_at IS NOT NULL
      AND b.retain_until<=clock_timestamp()`)).rows[0]?.n !== 0) throw new Error('SA06AR_NONEMPTY_PRUNE_SUBSTRATE')

  const postures: Array<{ table: string; trigger: string; restore: string; enabled: string; relationOid: string }> = []
  const ownTriggers: Array<{ table: string; trigger: string }> = []
  let installed = false, cleaned = false
  const cleanup = async () => {
    if (cleaned) return
    cleaned = true
    const errors: unknown[] = []
    const finish = async (work: () => Promise<unknown>) => { try { await work() } catch (error) { errors.push(error) } }
    let identity: Record<string, unknown> | undefined
    await finish(async () => { identity = (await query('SELECT oid::text AS oid,nspowner=current_user::regrole AS owned FROM pg_namespace WHERE nspname=$1', [schema])).rows[0] })
    if (identity?.oid !== namespace.oid || identity.owned !== true) errors.push(new Error('SA06AR_CLEANUP_SCHEMA_CHANGED'))
    else {
      for (const { table, trigger } of ownTriggers.reverse()) await finish(() => query(`DROP TRIGGER IF EXISTS ${identifier(trigger)} ON ${owned(table)}`))
      if (installed) {
        // All targets were proven absent before our transaction. CASCADE removes
        // only their new FK children; the original authority schema stays intact.
        for (const table of [...ownTables].reverse()) await finish(() => query(`DROP TABLE IF EXISTS ${owned(table)} CASCADE`))
        for (const fn of historyFunctions) await finish(() => query(`DROP FUNCTION IF EXISTS ${owned(fn)}() CASCADE`))
        await finish(() => query(`DROP FUNCTION IF EXISTS ${owned('meta_record_history_operations_prune')}(text,uuid)`))
        for (const fn of lockFunctions) await finish(() => query(`DROP FUNCTION IF EXISTS ${owned(fn)}(text,boolean)`))
        await finish(() => query(`ALTER TABLE ${owned('meta_record_revisions')} DROP COLUMN IF EXISTS seq,DROP COLUMN IF EXISTS operation_id`))
        await finish(() => query(`DROP SEQUENCE IF EXISTS ${owned('meta_record_chain_seq')}`))
        await finish(() => query(`ALTER TABLE ${owned('meta_sheets')} DROP COLUMN IF EXISTS recovery_writer_state,DROP COLUMN IF EXISTS system_kind`))
      }
    }
    // Restore exact O/D/R/A posture even when owned cleanup failed.
    for (const { table, trigger, restore, enabled, relationOid } of postures.reverse()) await finish(async () => {
      const current = (await query('SELECT c.oid::text AS oid,c.relowner=current_user::regrole AS owned FROM pg_class c WHERE c.oid=to_regclass($1)', ['public.' + table])).rows[0]
      if (current?.oid !== relationOid || current.owned !== true) throw new Error('SA06AR_PUBLIC_CLEANUP_IDENTITY_CHANGED')
      await query(`ALTER TABLE public.${identifier(table)} ${restore} TRIGGER ${identifier(trigger)}`)
      if ((await query('SELECT tgenabled FROM pg_trigger WHERE tgrelid=$1::oid AND tgname=$2', [relationOid, trigger])).rows[0]?.tgenabled !== enabled) {
        throw new Error('SA06AR_PUBLIC_POSTURE_NOT_RESTORED')
      }
    })
    if (errors.length) throw new AggregateError(errors, 'SA06AR_RECOVERY_SCHEMA_CLEANUP_FAILED')
  }
  try {
    for (const [table, trigger] of RECOVERY_AUTHORITY_TRIGGERS) {
      const row = (await query(`SELECT t.tgenabled,c.oid::text AS relation_oid,c.relowner=current_user::regrole AS owned
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname=$1 AND t.tgname=$2 AND NOT t.tgisinternal`, [table, trigger])).rows[0]
      const restore = ({ O: 'ENABLE', D: 'DISABLE', R: 'ENABLE REPLICA', A: 'ENABLE ALWAYS' } as Record<string, string>)[String(row?.tgenabled)]
      if (!restore || row?.owned !== true) throw new Error('SA06AR_CANONICAL_TRIGGER_PREREQUISITE_MISSING')
      postures.push({ table, trigger, restore, enabled: String(row.tgenabled), relationOid: String(row.relation_oid) })
      await query(`ALTER TABLE public.${identifier(table)} ENABLE TRIGGER ${identifier(trigger)}`)
    }
    await input.db.transaction().execute(async trx => {
      for (const migration of [addTrash, addTrashRevision, addMarkers, addChainSeq, addWriterState,
        addCheckpoints, addBurns, addOperations, addSubscriptions]) await migration(trx)
    })
    installed = true
    // Older migrations check global constraint names. Public already owns those
    // names, so enforce the identical constraints on these exact owned tables.
    for (const [table, constraint] of [['meta_record_revisions', 'fk_mrr_operation'], ['meta_record_version_markers', 'fk_mrvm_operation']]) {
      if ((await query('SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid=$1::regclass AND conname=$2', [schema + '.' + table, constraint])).rows[0]?.n === 0) {
        await query(`ALTER TABLE ${owned(table)} ADD CONSTRAINT ${identifier(constraint)} FOREIGN KEY(sheet_id,operation_id)
          REFERENCES ${owned('meta_record_history_operations')}(sheet_id,operation_id) DEFERRABLE INITIALLY DEFERRED`)
      }
    }
    await query(`ALTER TABLE ${owned('meta_sheets')} ADD CONSTRAINT sa06ar_writer_state
      CHECK(recovery_writer_state IS NULL OR recovery_writer_state IN ('fencing','applying','paused_retryable'))`)
    await query(`CREATE TABLE ${owned('meta_links')}(id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
      field_id text NOT NULL REFERENCES ${owned('meta_fields')}(id) ON DELETE CASCADE,
      record_id text NOT NULL REFERENCES ${owned('meta_records')}(id) ON DELETE CASCADE,
      foreign_record_id text NOT NULL,created_at timestamptz DEFAULT now())`)
    for (const fn of lockFunctions) await query(`CREATE FUNCTION ${owned(fn)}(text,boolean) RETURNS boolean
      LANGUAGE sql VOLATILE AS 'SELECT public.${fn}($1,$2)'`)
    for (const [table, trigger] of RECOVERY_AUTHORITY_TRIGGERS) {
      const user = ['user_permissions', 'user_roles', 'platform_member_group_members', 'users'].includes(table)
      const fn = table === 'role_permissions' ? triggerFunctions[1] : user ? triggerFunctions[0] : triggerFunctions[2]
      const events = trigger.endsWith('_update') ? 'UPDATE OF role,permissions,is_active'
        : trigger.endsWith('_lifecycle') ? 'INSERT OR DELETE' : 'INSERT OR UPDATE OR DELETE'
      const args = table === 'role_permissions' ? '' : user ? "'" + (table === 'users' ? 'id' : 'user_id') + "'" : "'subject_type','subject_id'"
      await query(`CREATE TRIGGER ${identifier(trigger)} BEFORE ${events} ON ${owned(table)}
        FOR EACH ROW EXECUTE FUNCTION public.${identifier(fn)}(${args})`)
      ownTriggers.push({ table, trigger })
    }
    return { cleanup }
  } catch (error) {
    try { await cleanup() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'SA06AR_BOOTSTRAP_AND_CLEANUP_FAILED') }
    throw error
  }
}
