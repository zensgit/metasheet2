import { createHash } from 'node:crypto'

import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'

import * as tombstones from '../../src/db/migrations/zzzz20260708090000_create_meta_tombstone_tables'
import * as trashDeleteRevision from '../../src/db/migrations/zzzz20260709100000_add_delete_revision_id_to_meta_records_trash'
import * as restoredFromVersion from '../../src/db/migrations/zzzz20260711000000_add_meta_record_revisions_restored_from_version'
import * as versionMarkers from '../../src/db/migrations/zzzz20260713150000_create_meta_record_version_markers'
import * as chainSeq from '../../src/db/migrations/zzzz20260715160000_add_meta_record_chain_seq'
import * as writerState from '../../src/db/migrations/zzzz20260715170000_add_meta_sheet_recovery_writer_state'
import * as trustCheckpoints from '../../src/db/migrations/zzzz20260715180000_create_meta_history_trust_checkpoints'
import * as historyOperations from '../../src/db/migrations/zzzz20260715210000_create_meta_record_history_operations'
import * as tokenBurns from '../../src/db/migrations/zzzz20260719120000_create_meta_recovery_token_burns'
import * as authorityLocks from '../../src/db/migrations/zzzz20260721121000_add_recovery_authority_locks'
import * as authorityCorrection from '../../src/db/migrations/zzzz20260728120000_correct_recovery_authority_locks'
import * as authoritySearchPath from '../../src/db/migrations/zzzz20260821120000_recovery_authority_functions_fix_search_path'
import * as recoveryArchiveCatalog from '../../src/db/migrations/zzzz20260826120000_create_meta_recovery_archive_catalog'
import * as recoveryArchiveStagingCleanup from '../../src/db/migrations/zzzz20260826121000_add_recovery_archive_staging_cleanup_protocol'
import * as sectionCausality from '../../src/db/migrations/zzzz20260826122000_add_section_causality_substrate'
import * as operationBinding from '../../src/db/migrations/zzzz20260826122500_add_operation_binding_to_nonrecord_history'
import * as archiveWriterBlock from '../../src/db/migrations/zzzz20260826123000_add_archive_writer_block_ownership'
import * as coverageBinding from '../../src/db/migrations/zzzz20260827120000_add_recovery_archive_coverage_binding'
import * as snapshotReservations from '../../src/db/migrations/zzzz20260828120000_add_recovery_archive_snapshot_reservations'
import * as archiveKeyRegistry from '../../src/db/migrations/zzzz20260828121000_add_recovery_archive_key_registry'
import * as sourcePinAuthority from '../../src/db/migrations/zzzz20260828124000_add_recovery_archive_source_pin_authority'
import * as objectReceiptAuthority from '../../src/db/migrations/zzzz20260828125000_add_recovery_archive_object_receipt_authority'
import * as legalHoldAuthority from '../../src/db/migrations/zzzz20260828130000_add_recovery_archive_legal_hold_authority'

type MigrationModule = {
  up(db: Kysely<unknown>): Promise<void>
  down(db: Kysely<unknown>): Promise<void>
}

type NamedMigration = {
  name: string
  module: MigrationModule
}

type CatalogRow = {
  kind: string
  object_name: string
  member_name: string
  definition: string
}

type ReplayPhase = 'precondition' | 'down' | 'absence' | 'up' | 'fingerprint' | 'cleanup'
type ReplayObjectCategory =
  | 'catalog'
  | 'catalog-key'
  | 'column'
  | 'configuration'
  | 'constraint'
  | 'database'
  | 'function'
  | 'index'
  | 'migration'
  | 'relation'
  | 'trigger'

class ReplayFailure extends Error {
  constructor(
    readonly phase: ReplayPhase,
    readonly code: string,
    readonly category: ReplayObjectCategory,
    readonly count: number,
    readonly changedCatalogKeys: string[] = [],
  ) {
    super(code)
  }
}

const MIGRATIONS: NamedMigration[] = [
  {
    name: 'zzzz20260708090000_create_meta_tombstone_tables',
    module: tombstones,
  },
  {
    name: 'zzzz20260709100000_add_delete_revision_id_to_meta_records_trash',
    module: trashDeleteRevision,
  },
  {
    name: 'zzzz20260711000000_add_meta_record_revisions_restored_from_version',
    module: restoredFromVersion,
  },
  {
    name: 'zzzz20260713150000_create_meta_record_version_markers',
    module: versionMarkers,
  },
  { name: 'zzzz20260715160000_add_meta_record_chain_seq', module: chainSeq },
  {
    name: 'zzzz20260715170000_add_meta_sheet_recovery_writer_state',
    module: writerState,
  },
  {
    name: 'zzzz20260715180000_create_meta_history_trust_checkpoints',
    module: trustCheckpoints,
  },
  {
    name: 'zzzz20260715210000_create_meta_record_history_operations',
    module: historyOperations,
  },
  {
    name: 'zzzz20260719120000_create_meta_recovery_token_burns',
    module: tokenBurns,
  },
  {
    name: 'zzzz20260721121000_add_recovery_authority_locks',
    module: authorityLocks,
  },
  {
    name: 'zzzz20260728120000_correct_recovery_authority_locks',
    module: authorityCorrection,
  },
  {
    name: 'zzzz20260821120000_recovery_authority_functions_fix_search_path',
    module: authoritySearchPath,
  },
  {
    name: 'zzzz20260826120000_create_meta_recovery_archive_catalog',
    module: recoveryArchiveCatalog,
  },
  {
    name: 'zzzz20260826121000_add_recovery_archive_staging_cleanup_protocol',
    module: recoveryArchiveStagingCleanup,
  },
  {
    name: 'zzzz20260826122000_add_section_causality_substrate',
    module: sectionCausality,
  },
  {
    name: 'zzzz20260826122500_add_operation_binding_to_nonrecord_history',
    module: operationBinding,
  },
  {
    name: 'zzzz20260826123000_add_archive_writer_block_ownership',
    module: archiveWriterBlock,
  },
  {
    name: 'zzzz20260827120000_add_recovery_archive_coverage_binding',
    module: coverageBinding,
  },
  {
    name: 'zzzz20260828120000_add_recovery_archive_snapshot_reservations',
    module: snapshotReservations,
  },
  {
    name: 'zzzz20260828121000_add_recovery_archive_key_registry',
    module: archiveKeyRegistry,
  },
  {
    name: 'zzzz20260828124000_add_recovery_archive_source_pin_authority',
    module: sourcePinAuthority,
  },
  {
    name: 'zzzz20260828125000_add_recovery_archive_object_receipt_authority',
    module: objectReceiptAuthority,
  },
  {
    name: 'zzzz20260828130000_add_recovery_archive_legal_hold_authority',
    module: legalHoldAuthority,
  },
]

const TOUCHED_RELATIONS = [
  'meta_field_value_tombstones',
  'meta_link_tombstones',
  'meta_config_revisions',
  'meta_records_trash',
  'meta_record_revisions',
  'meta_record_version_markers',
  'meta_sheets',
  'meta_history_trust_checkpoints',
  'meta_history_baselines',
  'meta_record_history_operations',
  'meta_recovery_token_burns',
  'record_permissions',
  'field_permissions',
  'spreadsheet_permissions',
  'role_permissions',
  'platform_member_group_members',
  'user_roles',
  'user_permissions',
  'users',
  'meta_recovery_archives',
  'meta_recovery_archive_coverage_items',
  'meta_recovery_archive_attachment_refs',
  'meta_recovery_archive_staging_objects',
  'meta_sheet_section_revisions',
  'meta_record_history_snapshot_members',
  'meta_record_history_operation_members',
  'meta_recovery_archive_snapshot_reservations',
  'meta_recovery_archive_section_bootstrap_markers',
  'meta_recovery_archive_keys',
  'meta_recovery_archive_objects',
  'meta_recovery_archive_legal_holds',
]

const OWNED_RELATIONS = [
  'meta_field_value_tombstones',
  'meta_link_tombstones',
  'meta_record_version_markers',
  'meta_history_trust_checkpoints',
  'meta_history_baselines',
  'meta_record_history_operations',
  'meta_recovery_token_burns',
  'meta_record_chain_seq',
  'meta_recovery_archives',
  'meta_recovery_archive_coverage_items',
  'meta_recovery_archive_attachment_refs',
  'meta_recovery_archive_staging_objects',
  'meta_sheet_section_revisions',
  'meta_record_history_snapshot_members',
  'meta_record_history_operation_members',
  'meta_recovery_archive_snapshot_reservations',
  'meta_recovery_archive_section_bootstrap_markers',
  'meta_recovery_archive_keys',
  'meta_recovery_archive_objects',
  'meta_recovery_archive_legal_holds',
]

const OWNED_COLUMNS = [
  ['meta_records_trash', 'delete_revision_id'],
  ['meta_record_revisions', 'restored_from_version'],
  ['meta_record_revisions', 'seq'],
  ['meta_record_revisions', 'operation_id'],
  ['meta_sheets', 'recovery_writer_state'],
  ['meta_sheets', 'recovery_writer_owner_kind'],
  ['meta_sheets', 'recovery_writer_owner_id'],
  ['meta_sheets', 'recovery_writer_owner_fence'],
  ['meta_sheets', 'recovery_writer_lease_until'],
  ['meta_sheets', 'recovery_writer_updated_at'],
  ['meta_sheets', 'system_kind'],
  ['meta_recovery_archive_attachment_refs', 'cleanup_owner_kind'],
  ['meta_recovery_archive_attachment_refs', 'cleanup_owner_id'],
  ['meta_recovery_archive_attachment_refs', 'cleanup_owner_fence'],
  ['meta_record_history_operations', 'operation_kind'],
  ['meta_record_history_operations', 'event_contract_version'],
  ['meta_record_history_operations', 'component_count'],
  ['meta_config_revisions', 'operation_id'],
  ['meta_field_value_tombstones', 'operation_id'],
  ['meta_link_tombstones', 'operation_id'],
] as const

// These indexes are created on relations that predate at least one migration in this replay set.
// New-table indexes disappear with their relation, but these must be checked independently.
const OWNED_INDEXES = [
  ['meta_records_trash', 'uq_meta_records_trash_delete_revision'],
  ['meta_record_version_markers', 'idx_meta_record_version_markers_sheet_record'],
  ['meta_record_revisions', 'idx_meta_record_revisions_sheet_record_seq'],
  ['meta_record_version_markers', 'idx_meta_record_version_markers_sheet_record_seq'],
  ['meta_record_revisions', 'idx_meta_record_revisions_operation'],
  ['meta_record_version_markers', 'idx_meta_record_version_markers_operation'],
  ['meta_config_revisions', 'idx_meta_config_revisions_operation'],
  ['meta_field_value_tombstones', 'idx_meta_field_value_tombstones_operation'],
  ['meta_link_tombstones', 'idx_meta_link_tombstones_operation'],
] as const

const OWNED_CONSTRAINTS = [
  ['meta_sheets', 'chk_meta_sheets_recovery_writer_state'],
  ['meta_sheets', 'chk_meta_sheets_recovery_writer_owner_kind'],
  ['meta_sheets', 'chk_meta_sheets_recovery_writer_owner_tuple'],
  ['meta_sheets', 'chk_meta_sheets_recovery_writer_fence'],
  ['meta_record_version_markers', 'uq_meta_record_version_markers_sheet_record_version'],
  ['meta_record_revisions', 'fk_mrr_operation'],
  ['meta_record_version_markers', 'fk_mrvm_operation'],
  ['meta_record_history_operations', 'chk_mrho_event_contract'],
  ['meta_sheet_section_revisions', 'fk_mssr_operation'],
  ['meta_record_history_snapshot_members', 'fk_mrhsm_parent'],
  ['meta_record_history_operation_members', 'fk_mrhom_parent'],
  ['meta_config_revisions', 'fk_mcr_operation'],
  ['meta_field_value_tombstones', 'fk_mfvt_operation'],
  ['meta_link_tombstones', 'fk_mlt_operation'],
  ['meta_recovery_archive_coverage_items', 'chk_meta_recovery_archive_coverage_kind_binding'],
  ['meta_recovery_archive_snapshot_reservations', 'fk_mrasr_generation'],
  ['meta_recovery_archive_snapshot_reservations', 'chk_mrasr_shape'],
  ['meta_recovery_archive_section_bootstrap_markers', 'pk_mrasbm_sheet'],
  ['meta_recovery_archive_section_bootstrap_markers', 'uq_mrasbm_generation'],
  ['meta_recovery_archive_section_bootstrap_markers', 'uq_mrasbm_snapshot_operation'],
  ['meta_recovery_archive_section_bootstrap_markers', 'chk_mrasbm_source_vector_hash'],
  ['meta_recovery_archives', 'fk_meta_recovery_archives_key'],
] as const

const OPERATION_FUNCTIONS = [
  'meta_record_reject_append_to_sealed_operation',
  'meta_record_history_operations_validate_endpoint',
  'meta_record_history_operations_reject_update',
  'meta_record_history_operations_reject_delete',
  'meta_record_history_operations_prune',
]

const AUTHORITY_FUNCTIONS = [
  authorityLocks.AUTHORITY_LOCK_FUNCTION,
  authorityLocks.AUTHORITY_ROLE_LOCK_FUNCTION,
  authorityLocks.AUTHORITY_GROUP_LOCK_FUNCTION,
  authorityLocks.AUTHORITY_USER_TRIGGER_FUNCTION,
  authorityLocks.AUTHORITY_ROLE_PERMISSION_TRIGGER_FUNCTION,
  authorityLocks.AUTHORITY_SUBJECT_TRIGGER_FUNCTION,
]

const RECOVERY_ARCHIVE_FUNCTIONS = [
  'meta_recovery_archives_guard_row',
  'meta_recovery_archive_coverage_guard_row',
  'meta_recovery_archive_attachment_ref_guard_row',
  'meta_recovery_archive_attachment_finalize_guard_row',
  'meta_recovery_archive_abandoned_cleanup_claim_guard_row',
  'meta_recovery_archive_claim_abandoned_cleanup',
  'meta_recovery_archive_staging_object_guard_row',
  'meta_recovery_archive_staging_object_finalize_guard_row',
  'meta_recovery_archive_attachment_ref_cleanup_guard_row',
  'meta_recovery_archive_attachment_cleanup_finalize_guard_row',
  'meta_recovery_archive_release_abandoned_source_pin',
]

const SECTION_CAUSALITY_FUNCTIONS = [
  'meta_sheet_section_revisions_guard_row',
  'meta_record_history_membership_guard_row',
]
const OPERATION_BINDING_FUNCTIONS = ['meta_nonrecord_history_operation_binding_guard_row']
const SNAPSHOT_RESERVATION_FUNCTIONS = [
  'meta_recovery_archive_snapshot_reservation_guard_row',
  'meta_recovery_archive_snapshot_reservation_guard_set',
  'meta_recovery_archive_snapshot_reservation_guard_truncate',
  'meta_recovery_archive_section_bootstrap_marker_guard_row',
  'meta_recovery_archive_section_bootstrap_marker_guard_truncate',
]
const ARCHIVE_KEY_REGISTRY_FUNCTIONS = [
  'meta_recovery_archive_key_guard_row',
  'meta_recovery_archive_key_guard_truncate',
  'meta_recovery_archive_key_reference_guard_row',
]
const ARCHIVE_OBJECT_RECEIPT_FUNCTIONS = [
  'meta_recovery_archive_object_guard_row',
  'meta_recovery_archive_object_finalize_guard_row',
  'meta_recovery_archive_object_parent_guard_row',
]
const ARCHIVE_LEGAL_HOLD_FUNCTIONS = [
  'meta_recovery_archive_legal_hold_guard_row',
  'meta_recovery_archive_legal_hold_guard_truncate',
  'meta_recovery_archive_legal_hold_expiry_guard_row',
  'meta_recovery_archive_expiry_authorize',
  'meta_recovery_archive_legal_hold_release_authorize',
]

const OWNED_FUNCTIONS = [
  ...OPERATION_FUNCTIONS,
  ...AUTHORITY_FUNCTIONS,
  ...RECOVERY_ARCHIVE_FUNCTIONS,
  ...SECTION_CAUSALITY_FUNCTIONS,
  ...OPERATION_BINDING_FUNCTIONS,
  ...SNAPSHOT_RESERVATION_FUNCTIONS,
  ...ARCHIVE_KEY_REGISTRY_FUNCTIONS,
  ...ARCHIVE_OBJECT_RECEIPT_FUNCTIONS,
  ...ARCHIVE_LEGAL_HOLD_FUNCTIONS,
]
const OPERATION_TRIGGERS = [
  'trg_mrr_reject_append_sealed',
  'trg_mrvm_reject_append_sealed',
  'trg_mrho_validate_endpoint',
  'trg_mrho_reject_update',
  'trg_mrho_reject_delete',
]
const AUTHORITY_TRIGGERS = authorityLocks.RECOVERY_AUTHORITY_TRIGGERS.map(([, trigger]) => trigger)
const RECOVERY_ARCHIVE_TRIGGERS = [
  'trg_meta_recovery_archives_guard_row',
  'trg_meta_recovery_archive_coverage_guard_row',
  'trg_meta_recovery_archive_attachment_ref_guard_row',
  'trg_meta_recovery_archive_attachment_finalize_guard_row',
  'trg_meta_recovery_archive_abandoned_cleanup_claim_guard_row',
  'trg_meta_recovery_archive_staging_object_guard_row',
  'trg_meta_recovery_archive_staging_object_finalize_guard_row',
  'trg_meta_recovery_archive_attachment_cleanup_finalize_guard_row',
]
const SECTION_CAUSALITY_TRIGGERS = [
  'trg_mssr_reject_append_sealed',
  'trg_mssr_guard_row',
  'trg_mrhsm_guard_row',
  'trg_mrhom_guard_row',
]
const OPERATION_BINDING_TRIGGERS = [
  'trg_mcr_operation_binding_immutable',
  'trg_mfvt_operation_binding_immutable',
  'trg_mlt_operation_binding_immutable',
  'trg_mcr_reject_append_sealed',
  'trg_mfvt_reject_append_sealed',
  'trg_mlt_reject_append_sealed',
]
const SNAPSHOT_RESERVATION_TRIGGERS = [
  'trg_mrasr_guard_row',
  'trg_mrasr_guard_set',
  'trg_mrasr_guard_truncate',
  'trg_mrasbm_guard_row',
  'trg_mrasbm_guard_truncate',
]
const ARCHIVE_KEY_REGISTRY_TRIGGERS = [
  'trg_meta_recovery_archive_key_guard_row',
  'trg_meta_recovery_archive_key_guard_truncate',
  'trg_meta_recovery_archive_key_reference_guard_row',
]
const ARCHIVE_OBJECT_RECEIPT_TRIGGERS = [
  'trg_meta_recovery_archive_object_guard_row',
  'trg_meta_recovery_archive_object_finalize_guard_row',
  'trg_meta_recovery_archives_object_parent_guard_row',
]
const ARCHIVE_LEGAL_HOLD_TRIGGERS = [
  'trg_meta_recovery_archive_legal_hold_guard_row',
  'trg_meta_recovery_archive_legal_hold_guard_truncate',
  'trg_meta_recovery_archives_legal_hold_expiry_guard_row',
]
const OWNED_TRIGGERS = [
  ...OPERATION_TRIGGERS,
  ...AUTHORITY_TRIGGERS,
  ...RECOVERY_ARCHIVE_TRIGGERS,
  ...SECTION_CAUSALITY_TRIGGERS,
  ...OPERATION_BINDING_TRIGGERS,
  ...SNAPSHOT_RESERVATION_TRIGGERS,
  ...ARCHIVE_KEY_REGISTRY_TRIGGERS,
  ...ARCHIVE_OBJECT_RECEIPT_TRIGGERS,
  ...ARCHIVE_LEGAL_HOLD_TRIGGERS,
]
const TIME_MACHINE_REPLAY_FAILURE_ENV = 'TIME_MACHINE_REPLAY_INJECT_DOWN_FAILURE_AFTER'
let activePhase: ReplayPhase = 'precondition'

function requireCondition(condition: unknown, failure: ReplayFailure): asserts condition {
  if (!condition) throw failure
}

function normalizeRows(rows: CatalogRow[]): CatalogRow[] {
  return rows
    .map((row) => ({
      kind: row.kind,
      object_name: row.object_name,
      member_name: row.member_name,
      definition: row.definition,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}

async function catalogSnapshot(db: Kysely<unknown>): Promise<CatalogRow[]> {
  const columns = await sql<CatalogRow>`
    SELECT 'column'::text AS kind,
           table_name::text AS object_name,
           column_name::text AS member_name,
           -- DROP/ADD necessarily moves an owned column after unrelated later columns. Ordinal
           -- position is not part of the column's semantic contract; type/null/default/collation are.
           concat_ws('|', data_type, udt_name, is_nullable,
                     coalesce(column_default, ''), coalesce(collation_name, ''))::text AS definition
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = ANY(${TOUCHED_RELATIONS}::text[])
  `.execute(db)

  const constraints = await sql<CatalogRow>`
    SELECT 'constraint'::text AS kind,
           relation.relname::text AS object_name,
           constraint_row.conname::text AS member_name,
           concat_ws('|', constraint_row.contype::text,
                     constraint_row.condeferrable::text,
                     constraint_row.condeferred::text,
                     pg_get_constraintdef(constraint_row.oid, true))::text AS definition
      FROM pg_constraint constraint_row
      JOIN pg_class relation ON relation.oid = constraint_row.conrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relname = ANY(${TOUCHED_RELATIONS}::text[])
  `.execute(db)

  const indexes = await sql<CatalogRow>`
    SELECT 'index'::text AS kind,
           tablename::text AS object_name,
           indexname::text AS member_name,
           indexdef::text AS definition
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = ANY(${TOUCHED_RELATIONS}::text[])
  `.execute(db)

  const triggers = await sql<CatalogRow>`
    SELECT 'trigger'::text AS kind,
           relation.relname::text AS object_name,
           trigger_row.tgname::text AS member_name,
           concat_ws('|', trigger_row.tgenabled::text,
                     pg_get_triggerdef(trigger_row.oid, true))::text AS definition
      FROM pg_trigger trigger_row
      JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND NOT trigger_row.tgisinternal
       AND relation.relname = ANY(${TOUCHED_RELATIONS}::text[])
  `.execute(db)

  const functions = await sql<CatalogRow>`
    SELECT 'function'::text AS kind,
           procedure_row.proname::text AS object_name,
           pg_get_function_identity_arguments(procedure_row.oid)::text AS member_name,
           concat_ws('|', coalesce(array_to_string(procedure_row.proconfig, ','), ''),
                     pg_get_functiondef(procedure_row.oid))::text AS definition
      FROM pg_proc procedure_row
      JOIN pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
     WHERE namespace.nspname = 'public'
       AND procedure_row.proname = ANY(${OWNED_FUNCTIONS}::text[])
  `.execute(db)

  const sequences = await sql<CatalogRow>`
    SELECT 'sequence'::text AS kind,
           relation.relname::text AS object_name,
           ''::text AS member_name,
           concat_ws('|', format_type(sequence_row.seqtypid, NULL), sequence_row.seqstart::text,
                     sequence_row.seqmin::text, sequence_row.seqmax::text,
                     sequence_row.seqincrement::text, sequence_row.seqcycle::text,
                     sequence_row.seqcache::text)::text AS definition
      FROM pg_sequence sequence_row
      JOIN pg_class relation ON relation.oid = sequence_row.seqrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relname = 'meta_record_chain_seq'
  `.execute(db)

  return normalizeRows([
    ...columns.rows,
    ...constraints.rows,
    ...indexes.rows,
    ...triggers.rows,
    ...functions.rows,
    ...sequences.rows,
  ])
}

async function assertPreD2cEndpointFunctionsUnconfigured(db: Kysely<unknown>): Promise<void> {
  const functions = await sql<{
    proname: string
    proconfig: string | null
  }>`
    SELECT procedure_row.proname::text AS proname,
           array_to_string(procedure_row.proconfig, ',') AS proconfig
      FROM pg_proc procedure_row
      JOIN pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
     WHERE namespace.nspname = 'public'
       AND procedure_row.proname IN (
         'meta_record_history_operations_validate_endpoint',
         'meta_record_history_operations_prune'
       )
     ORDER BY procedure_row.proname
  `.execute(db)
  requireCondition(
    functions.rows.length === 2,
    new ReplayFailure('down', 'pre_d2c_endpoint_function_missing', 'function', functions.rows.length),
  )
  for (const row of functions.rows) {
    requireCondition(
      row.proconfig === null || row.proconfig === '',
      new ReplayFailure('down', 'pre_d2c_endpoint_function_configured', 'function', 1),
    )
  }
}

async function assertOwnedSurfaceAbsent(db: Kysely<unknown>): Promise<void> {
  const relations = await sql<{ count: number }>`
    SELECT count(*)::int AS count
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relname = ANY(${OWNED_RELATIONS}::text[])
  `.execute(db)
  requireCondition(
    relations.rows[0]?.count === 0,
    new ReplayFailure('absence', 'owned_relation_remains', 'relation', relations.rows[0]?.count ?? 0),
  )

  const columns = await sql<{ count: number }>`
    SELECT count(*)::int AS count
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (table_name, column_name) IN (
         ${sql.join(OWNED_COLUMNS.map(([table, column]) => sql`(${table}, ${column})`))}
       )
  `.execute(db)
  requireCondition(
    columns.rows[0]?.count === 0,
    new ReplayFailure('absence', 'owned_column_remains', 'column', columns.rows[0]?.count ?? 0),
  )

  const constraints = await sql<{ count: number }>`
    SELECT count(*)::int AS count
      FROM pg_constraint constraint_row
      JOIN pg_class relation ON relation.oid = constraint_row.conrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND (relation.relname, constraint_row.conname) IN (
         ${sql.join(OWNED_CONSTRAINTS.map(([table, constraint]) => sql`(${table}, ${constraint})`))}
       )
  `.execute(db)
  requireCondition(
    constraints.rows[0]?.count === 0,
    new ReplayFailure(
      'absence',
      'owned_constraint_remains',
      'constraint',
      constraints.rows[0]?.count ?? 0,
    ),
  )

  const indexes = await sql<{ count: number }>`
    SELECT count(*)::int AS count
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND (tablename, indexname) IN (
         ${sql.join(OWNED_INDEXES.map(([table, index]) => sql`(${table}, ${index})`))}
       )
  `.execute(db)
  requireCondition(
    indexes.rows[0]?.count === 0,
    new ReplayFailure('absence', 'owned_index_remains', 'index', indexes.rows[0]?.count ?? 0),
  )

  const functions = await sql<{ count: number }>`
    SELECT count(*)::int AS count
      FROM pg_proc procedure_row
      JOIN pg_namespace namespace ON namespace.oid = procedure_row.pronamespace
     WHERE namespace.nspname = 'public'
       AND procedure_row.proname = ANY(${OWNED_FUNCTIONS}::text[])
  `.execute(db)
  requireCondition(
    functions.rows[0]?.count === 0,
    new ReplayFailure('absence', 'owned_function_remains', 'function', functions.rows[0]?.count ?? 0),
  )

  const triggers = await sql<{ count: number }>`
    SELECT count(*)::int AS count
      FROM pg_trigger trigger_row
      JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND NOT trigger_row.tgisinternal
       AND trigger_row.tgname = ANY(${OWNED_TRIGGERS}::text[])
  `.execute(db)
  requireCondition(
    triggers.rows[0]?.count === 0,
    new ReplayFailure('absence', 'owned_trigger_remains', 'trigger', triggers.rows[0]?.count ?? 0),
  )
}

function snapshotDigest(snapshot: CatalogRow[]): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
}

function changedCatalogKeys(before: CatalogRow[], after: CatalogRow[]): string[] {
  const keyOf = (row: CatalogRow) => `${row.kind}:${row.object_name}:${row.member_name}`
  const beforeByKey = new Map(before.map((row) => [keyOf(row), row.definition]))
  const afterByKey = new Map(after.map((row) => [keyOf(row), row.definition]))
  return [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])]
    .filter((key) => beforeByKey.get(key) !== afterByKey.get(key))
    .sort()
}

function knownSafeChangedCatalogKeys(changedKeys: string[]): string[] {
  const ownedColumns = new Set(OWNED_COLUMNS.map(([table, column]) => `${table}:${column}`))
  const ownedConstraints = new Set(OWNED_CONSTRAINTS.map(([table, constraint]) => `${table}:${constraint}`))
  const ownedIndexes = new Set(OWNED_INDEXES.map(([table, index]) => `${table}:${index}`))

  return changedKeys.filter((key) => {
    const [kind, objectName, memberName] = key.split(':', 3)
    if (kind === 'column') return ownedColumns.has(`${objectName}:${memberName}`)
    if (kind === 'constraint') return ownedConstraints.has(`${objectName}:${memberName}`)
    if (kind === 'index') return ownedIndexes.has(`${objectName}:${memberName}`)
    if (kind === 'trigger') return OWNED_TRIGGERS.includes(memberName)
    if (kind === 'function') return OWNED_FUNCTIONS.includes(objectName)
    return kind === 'sequence' && objectName === 'meta_record_chain_seq'
  })
}

function requestedFailureInjection(): string | undefined {
  const migrationName = process.env[TIME_MACHINE_REPLAY_FAILURE_ENV]
  if (!migrationName) return undefined

  requireCondition(
    MIGRATIONS.some((migration) => migration.name === migrationName),
    new ReplayFailure('precondition', 'invalid_failure_injection', 'migration', 0),
  )
  return migrationName
}

function formatFailure(error: unknown, phase: ReplayPhase): string {
  if (error instanceof ReplayFailure) {
    const changedKeys = error.changedCatalogKeys.length
      ? ` changed_catalog_keys=${error.changedCatalogKeys.join(',')}`
      : ''
    return `Time Machine migration replay FAIL phase=${error.phase} code=${error.code} category=${error.category} count=${error.count}${changedKeys}`
  }

  return `Time Machine migration replay FAIL phase=${phase} code=unexpected_database_error category=database count=0`
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  requireCondition(
    databaseUrl,
    new ReplayFailure('precondition', 'database_url_required', 'configuration', 0),
  )

  const pool = new Pool({ connectionString: databaseUrl, max: 1 })
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
  const downed = new Set<string>()
  const failureInjectionMigration = requestedFailureInjection()
  let before: CatalogRow[] | undefined

  try {
    before = await catalogSnapshot(db)
    requireCondition(
      before.length > 0,
      new ReplayFailure('precondition', 'catalog_surface_absent', 'catalog', 0),
    )

    activePhase = 'down'
    for (const migration of [...MIGRATIONS].reverse()) {
      downed.add(migration.name)
      await migration.module.down(db)
      if (migration.name === 'zzzz20260826122000_add_section_causality_substrate') {
        await assertPreD2cEndpointFunctionsUnconfigured(db)
      }
      if (failureInjectionMigration === migration.name) {
        throw new ReplayFailure('down', 'injected_down_failure', 'migration', 1)
      }
    }
    activePhase = 'absence'
    await assertOwnedSurfaceAbsent(db)

    activePhase = 'up'
    for (const migration of MIGRATIONS) {
      await migration.module.up(db)
      downed.delete(migration.name)
    }

    activePhase = 'fingerprint'
    const after = await catalogSnapshot(db)
    const changedKeys = changedCatalogKeys(before, after)
    requireCondition(
      changedKeys.length === 0,
      new ReplayFailure(
        'fingerprint',
        'catalog_changed',
        'catalog-key',
        changedKeys.length,
        knownSafeChangedCatalogKeys(changedKeys),
      ),
    )

    console.log(
      `Time Machine migration replay PASS: migrations=${MIGRATIONS.length} catalog_objects=${after.length} fingerprint=${snapshotDigest(after)}`,
    )
  } finally {
    try {
      if (downed.size > 0) {
        const phaseBeforeCleanup = activePhase
        activePhase = 'cleanup'
        for (const migration of MIGRATIONS) {
          if (!downed.has(migration.name)) continue
          try {
            await migration.module.up(db)
            downed.delete(migration.name)
          } catch {
            // Continue in causal order so the final count describes every migration still unrecovered.
          }
        }

        requireCondition(
          downed.size === 0,
          new ReplayFailure('cleanup', 'recovery_incomplete', 'migration', downed.size),
        )

        if (before) {
          const recovered = await catalogSnapshot(db)
          const changedKeys = changedCatalogKeys(before, recovered)
          requireCondition(
            changedKeys.length === 0,
            new ReplayFailure(
              'cleanup',
              'cleanup_catalog_changed',
              'catalog-key',
              changedKeys.length,
              knownSafeChangedCatalogKeys(changedKeys),
            ),
          )
        }

        activePhase = phaseBeforeCleanup
      }
    } finally {
      await db.destroy()
    }
  }
}

main().catch((error: unknown) => {
  console.error(formatFailure(error, activePhase))
  process.exitCode = 1
})
