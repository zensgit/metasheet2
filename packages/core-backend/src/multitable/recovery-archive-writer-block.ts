import {
  canonicalSheetFenceKey,
  type FenceQuery,
} from './canonical-sheet-fence'
import { isMultitableRecoveryArchiveEnabled } from './recovery-archive-contract'

export const ARCHIVE_WRITER_BLOCK_OWNER_KINDS = ['archive_generation', 'restore_job'] as const
export type ArchiveWriterBlockOwnerKind = (typeof ARCHIVE_WRITER_BLOCK_OWNER_KINDS)[number]

export type ArchiveWriterBlockTransactionRunner = <T>(
  work: (query: FenceQuery) => Promise<T>,
) => Promise<T>

export type ArchiveWriterBlockSnapshot = {
  state: 'archiving'
  ownerKind: ArchiveWriterBlockOwnerKind
  ownerId: string
  fence: string
  leaseUntil: string
  updatedAt: string
}

export type ArchiveWriterBlockClaimInput = {
  ownerKind: ArchiveWriterBlockOwnerKind
  ownerId: string
  leaseUntil: Date | string
  previous?: ArchiveWriterBlockSnapshot
}

export type ArchiveWriterBlockCurrentInput = ArchiveWriterBlockSnapshot

export type ArchiveWriterBlockErrorCode =
  | 'ARCHIVE_WRITER_BLOCK_DISABLED'
  | 'ARCHIVE_WRITER_BLOCK_INVALID_INPUT'
  | 'ARCHIVE_WRITER_BLOCK_ISOLATION_INVALID'
  | 'ARCHIVE_WRITER_BLOCK_NOT_IN_TRANSACTION'
  | 'ARCHIVE_WRITER_BLOCK_SCHEMA_DRIFT'
  | 'ARCHIVE_WRITER_BLOCK_CLAIM_CONFLICT'
  | 'ARCHIVE_WRITER_BLOCK_OWNERSHIP_LOST'

export class ArchiveWriterBlockError extends Error {
  readonly code: ArchiveWriterBlockErrorCode

  constructor(code: ArchiveWriterBlockErrorCode) {
    super(code)
    this.name = 'ArchiveWriterBlockError'
    this.code = code
  }
}

type SchemaColumn = {
  column_name: string
  type_name: string
  is_not_null: boolean
}

type SchemaConstraint = {
  constraint_name: string
  contype: string
  convalidated: boolean
  definition: string
}

export const ARCHIVE_WRITER_BLOCK_EXPECTED_COLUMNS: readonly SchemaColumn[] = [
  { column_name: 'recovery_writer_lease_until', type_name: 'timestamp with time zone', is_not_null: false },
  { column_name: 'recovery_writer_owner_fence', type_name: 'bigint', is_not_null: false },
  { column_name: 'recovery_writer_owner_id', type_name: 'text', is_not_null: false },
  { column_name: 'recovery_writer_owner_kind', type_name: 'text', is_not_null: false },
  { column_name: 'recovery_writer_state', type_name: 'text', is_not_null: false },
  { column_name: 'recovery_writer_updated_at', type_name: 'timestamp with time zone', is_not_null: false },
]

export const ARCHIVE_WRITER_BLOCK_EXPECTED_CONSTRAINTS: readonly SchemaConstraint[] = [
  {
    constraint_name: 'chk_meta_sheets_recovery_writer_fence',
    contype: 'c',
    convalidated: true,
    definition: 'CHECK (recovery_writer_owner_fence IS NULL OR recovery_writer_owner_fence >= 1)',
  },
  {
    constraint_name: 'chk_meta_sheets_recovery_writer_owner_kind',
    contype: 'c',
    convalidated: true,
    definition:
      "CHECK (recovery_writer_owner_kind IS NULL OR (recovery_writer_owner_kind = ANY (ARRAY['archive_generation'::text, 'restore_job'::text])))",
  },
  {
    constraint_name: 'chk_meta_sheets_recovery_writer_owner_tuple',
    contype: 'c',
    convalidated: true,
    definition:
      "CHECK (recovery_writer_state IS DISTINCT FROM 'archiving'::text AND recovery_writer_owner_kind IS NULL AND recovery_writer_owner_id IS NULL AND recovery_writer_lease_until IS NULL AND recovery_writer_updated_at IS NULL OR NOT recovery_writer_state IS DISTINCT FROM 'archiving'::text AND recovery_writer_owner_kind IS NOT NULL AND recovery_writer_owner_id IS NOT NULL AND length(btrim(recovery_writer_owner_id)) > 0 AND recovery_writer_owner_fence IS NOT NULL AND recovery_writer_owner_fence >= 1 AND recovery_writer_lease_until IS NOT NULL AND recovery_writer_updated_at IS NOT NULL)",
  },
  {
    constraint_name: 'chk_meta_sheets_recovery_writer_state',
    contype: 'c',
    convalidated: true,
    definition:
      "CHECK (recovery_writer_state IS NULL OR (recovery_writer_state = ANY (ARRAY['fencing'::text, 'applying'::text, 'paused_retryable'::text, 'archiving'::text])))",
  },
]

const EXPECTED_CONSTRAINT_NAMES = ARCHIVE_WRITER_BLOCK_EXPECTED_CONSTRAINTS.map(
  (row) => row.constraint_name,
)

function normalizeConstraintDefinition(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function columnProjection(row: SchemaColumn): string {
  return `${row.column_name}:${row.type_name}:${row.is_not_null ? '1' : '0'}`
}

function constraintProjection(row: SchemaConstraint): string {
  return [
    row.constraint_name,
    row.contype,
    row.convalidated ? '1' : '0',
    normalizeConstraintDefinition(row.definition),
  ].join('=')
}

export function composeArchiveWriterBlockSchemaFingerprint(
  columns: readonly SchemaColumn[],
  constraints: readonly SchemaConstraint[],
): string | null {
  if (columns.length !== ARCHIVE_WRITER_BLOCK_EXPECTED_COLUMNS.length) return null
  if (constraints.length !== ARCHIVE_WRITER_BLOCK_EXPECTED_CONSTRAINTS.length) return null
  const live = [
    ...columns.map(columnProjection),
    ...constraints.map(constraintProjection),
  ].join('|')
  const expected = [
    ...ARCHIVE_WRITER_BLOCK_EXPECTED_COLUMNS.map(columnProjection),
    ...ARCHIVE_WRITER_BLOCK_EXPECTED_CONSTRAINTS.map(constraintProjection),
  ].join('|')
  return live === expected ? live : null
}

export const ARCHIVE_WRITER_BLOCK_SCHEMA_FINGERPRINT = composeArchiveWriterBlockSchemaFingerprint(
  ARCHIVE_WRITER_BLOCK_EXPECTED_COLUMNS,
  ARCHIVE_WRITER_BLOCK_EXPECTED_CONSTRAINTS,
) as string

export const ARCHIVE_WRITER_BLOCK_TRANSACTION_PRELUDE_SQL = `SELECT
  pg_advisory_xact_lock(hashtext($1)) AS locked,
  pg_current_xact_id()::text AS xid,
  current_setting('transaction_isolation') AS isolation`

const ARCHIVE_WRITER_BLOCK_SAME_XID_SQL = 'SELECT pg_current_xact_id()::text AS xid'

export const ARCHIVE_WRITER_BLOCK_CLEAN_CLAIM_SQL = `UPDATE public.meta_sheets
   SET recovery_writer_state = 'archiving',
       recovery_writer_owner_kind = $2,
       recovery_writer_owner_id = $3,
       recovery_writer_owner_fence = COALESCE(recovery_writer_owner_fence, 0) + 1,
       recovery_writer_lease_until = $4::timestamptz,
       recovery_writer_updated_at = clock_timestamp()
 WHERE id = $1
   AND recovery_writer_state IS NULL
   AND recovery_writer_owner_kind IS NULL
   AND recovery_writer_owner_id IS NULL
   AND recovery_writer_lease_until IS NULL
   AND recovery_writer_updated_at IS NULL
   AND (recovery_writer_owner_fence IS NULL OR recovery_writer_owner_fence >= 1)
   AND $4::timestamptz > clock_timestamp()
 RETURNING recovery_writer_state AS state,
           recovery_writer_owner_kind AS owner_kind,
           recovery_writer_owner_id AS owner_id,
           recovery_writer_owner_fence::text AS fence,
           recovery_writer_lease_until::text AS lease_until,
           recovery_writer_updated_at::text AS updated_at`

export const ARCHIVE_WRITER_BLOCK_TAKEOVER_SQL = `UPDATE public.meta_sheets
   SET recovery_writer_state = 'archiving',
       recovery_writer_owner_kind = $2,
       recovery_writer_owner_id = $3,
       recovery_writer_owner_fence = recovery_writer_owner_fence + 1,
       recovery_writer_lease_until = $4::timestamptz,
       recovery_writer_updated_at = clock_timestamp()
 WHERE id = $1
   AND recovery_writer_state = 'archiving'
   AND recovery_writer_owner_kind = $5
   AND recovery_writer_owner_id = $6
   AND recovery_writer_owner_fence = $7::bigint
   AND recovery_writer_lease_until = $8::timestamptz
   AND recovery_writer_updated_at = $9::timestamptz
   AND recovery_writer_lease_until <= clock_timestamp()
   AND $4::timestamptz > clock_timestamp()
 RETURNING recovery_writer_state AS state,
           recovery_writer_owner_kind AS owner_kind,
           recovery_writer_owner_id AS owner_id,
           recovery_writer_owner_fence::text AS fence,
           recovery_writer_lease_until::text AS lease_until,
           recovery_writer_updated_at::text AS updated_at`

function assertArchiveWriterBlockEnabled(): void {
  if (
    !isMultitableRecoveryArchiveEnabled()
    || process.env.MULTITABLE_ENABLE_WRITER_FENCE !== 'true'
  ) {
    throw new ArchiveWriterBlockError('ARCHIVE_WRITER_BLOCK_DISABLED')
  }
}

function invalidInput(): never {
  throw new ArchiveWriterBlockError('ARCHIVE_WRITER_BLOCK_INVALID_INPUT')
}

function requireOpaque(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) invalidInput()
  return value
}

function requireOwnerKind(value: unknown): ArchiveWriterBlockOwnerKind {
  if (!(ARCHIVE_WRITER_BLOCK_OWNER_KINDS as readonly unknown[]).includes(value)) invalidInput()
  return value as ArchiveWriterBlockOwnerKind
}

function requireFence(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) invalidInput()
  return value
}

function requireTimestamp(value: unknown): string {
  if (!(typeof value === 'string' || value instanceof Date)) invalidInput()
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) invalidInput()
  // Preserve PostgreSQL's text rendering for a returned ownership tuple. Converting that value
  // through JS Date would truncate microseconds and make an otherwise exact CAS miss its own row.
  return value instanceof Date ? value.toISOString() : value
}

function validateSnapshot(input: ArchiveWriterBlockSnapshot): ArchiveWriterBlockSnapshot {
  if (input?.state !== 'archiving') invalidInput()
  return {
    state: 'archiving',
    ownerKind: requireOwnerKind(input.ownerKind),
    ownerId: requireOpaque(input.ownerId),
    fence: requireFence(input.fence),
    leaseUntil: requireTimestamp(input.leaseUntil),
    updatedAt: requireTimestamp(input.updatedAt),
  }
}

function snapshotFromRow(row: unknown): ArchiveWriterBlockSnapshot | null {
  if (!row || typeof row !== 'object') return null
  const value = row as Record<string, unknown>
  if (value.state !== 'archiving') return null
  if (!(ARCHIVE_WRITER_BLOCK_OWNER_KINDS as readonly unknown[]).includes(value.owner_kind)) return null
  if (typeof value.owner_id !== 'string' || value.owner_id.length === 0) return null
  if (typeof value.fence !== 'string' || !/^[1-9][0-9]*$/.test(value.fence)) return null
  if (typeof value.lease_until !== 'string' || typeof value.updated_at !== 'string') return null
  return {
    state: 'archiving',
    ownerKind: value.owner_kind as ArchiveWriterBlockOwnerKind,
    ownerId: value.owner_id,
    fence: value.fence,
    leaseUntil: value.lease_until,
    updatedAt: value.updated_at,
  }
}

export async function readArchiveWriterBlockSchemaFingerprint(
  query: FenceQuery,
): Promise<string | null> {
  const columnsResult = await query(
    `SELECT attribute.attname AS column_name,
            pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS type_name,
            attribute.attnotnull AS is_not_null
       FROM pg_catalog.pg_class relation
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid = relation.oid
      WHERE namespace.nspname = 'public'
        AND relation.relname = 'meta_sheets'
        AND relation.relkind = 'r'
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND attribute.attname = ANY($1::text[])
      ORDER BY attribute.attname`,
    [ARCHIVE_WRITER_BLOCK_EXPECTED_COLUMNS.map((row) => row.column_name)],
  )
  const constraintsResult = await query(
    `SELECT constraint_row.conname AS constraint_name,
            constraint_row.contype::text AS contype,
            constraint_row.convalidated AS convalidated,
            pg_catalog.pg_get_constraintdef(constraint_row.oid, true) AS definition
       FROM pg_catalog.pg_constraint constraint_row
       JOIN pg_catalog.pg_class relation ON relation.oid = constraint_row.conrelid
       JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = 'meta_sheets'
        AND constraint_row.conname = ANY($1::text[])
      ORDER BY constraint_row.conname`,
    [EXPECTED_CONSTRAINT_NAMES],
  )
  return composeArchiveWriterBlockSchemaFingerprint(
    columnsResult.rows as SchemaColumn[],
    constraintsResult.rows as SchemaConstraint[],
  )
}

async function prepareTransaction(query: FenceQuery, sheetId: string): Promise<void> {
  const prelude = await query(ARCHIVE_WRITER_BLOCK_TRANSACTION_PRELUDE_SQL, [
    canonicalSheetFenceKey(sheetId),
  ])
  const row = prelude.rows[0] as { xid?: unknown; isolation?: unknown } | undefined
  if (row?.isolation !== 'read committed') {
    throw new ArchiveWriterBlockError('ARCHIVE_WRITER_BLOCK_ISOLATION_INVALID')
  }
  if (typeof row.xid !== 'string' || row.xid.length === 0) {
    throw new ArchiveWriterBlockError('ARCHIVE_WRITER_BLOCK_NOT_IN_TRANSACTION')
  }
  const sameXid = await query(ARCHIVE_WRITER_BLOCK_SAME_XID_SQL)
  if ((sameXid.rows[0] as { xid?: unknown } | undefined)?.xid !== row.xid) {
    throw new ArchiveWriterBlockError('ARCHIVE_WRITER_BLOCK_NOT_IN_TRANSACTION')
  }
  if ((await readArchiveWriterBlockSchemaFingerprint(query)) !== ARCHIVE_WRITER_BLOCK_SCHEMA_FINGERPRINT) {
    throw new ArchiveWriterBlockError('ARCHIVE_WRITER_BLOCK_SCHEMA_DRIFT')
  }
}

async function runPrepared<T>(
  runner: ArchiveWriterBlockTransactionRunner,
  sheetId: string,
  work: (query: FenceQuery) => Promise<T>,
): Promise<T> {
  return runner(async (query) => {
    await prepareTransaction(query, sheetId)
    return work(query)
  })
}

function rowCount(result: { rows: unknown[]; rowCount?: number | null }): number {
  return typeof result.rowCount === 'number' ? result.rowCount : result.rows.length
}

export async function claimArchiveWriterBlock(
  runner: ArchiveWriterBlockTransactionRunner,
  sheetIdInput: string,
  input: ArchiveWriterBlockClaimInput,
): Promise<ArchiveWriterBlockSnapshot> {
  assertArchiveWriterBlockEnabled()
  const sheetId = requireOpaque(sheetIdInput)
  const ownerKind = requireOwnerKind(input?.ownerKind)
  const ownerId = requireOpaque(input?.ownerId)
  const leaseUntil = requireTimestamp(input?.leaseUntil)
  const previous = input.previous ? validateSnapshot(input.previous) : undefined

  return runPrepared(runner, sheetId, async (query) => {
    const result = previous
      ? await query(ARCHIVE_WRITER_BLOCK_TAKEOVER_SQL, [
          sheetId,
          ownerKind,
          ownerId,
          leaseUntil,
          previous.ownerKind,
          previous.ownerId,
          previous.fence,
          previous.leaseUntil,
          previous.updatedAt,
        ])
      : await query(ARCHIVE_WRITER_BLOCK_CLEAN_CLAIM_SQL, [sheetId, ownerKind, ownerId, leaseUntil])
    const snapshot = snapshotFromRow(result.rows[0])
    if (!snapshot) throw new ArchiveWriterBlockError('ARCHIVE_WRITER_BLOCK_CLAIM_CONFLICT')
    return snapshot
  })
}

export async function heartbeatArchiveWriterBlock(
  runner: ArchiveWriterBlockTransactionRunner,
  sheetIdInput: string,
  currentInput: ArchiveWriterBlockCurrentInput,
  nextLeaseInput: Date | string,
): Promise<ArchiveWriterBlockSnapshot> {
  assertArchiveWriterBlockEnabled()
  const sheetId = requireOpaque(sheetIdInput)
  const current = validateSnapshot(currentInput)
  const nextLease = requireTimestamp(nextLeaseInput)

  return runPrepared(runner, sheetId, async (query) => {
    const result = await query(
      `UPDATE public.meta_sheets
          SET recovery_writer_lease_until = $7::timestamptz,
              recovery_writer_updated_at = clock_timestamp()
        WHERE id = $1
          AND recovery_writer_state = 'archiving'
          AND recovery_writer_owner_kind = $2
          AND recovery_writer_owner_id = $3
          AND recovery_writer_owner_fence = $4::bigint
          AND recovery_writer_lease_until = $5::timestamptz
          AND recovery_writer_updated_at = $6::timestamptz
          AND recovery_writer_lease_until > clock_timestamp()
          AND $7::timestamptz > clock_timestamp()
        RETURNING recovery_writer_state AS state,
                  recovery_writer_owner_kind AS owner_kind,
                  recovery_writer_owner_id AS owner_id,
                  recovery_writer_owner_fence::text AS fence,
                  recovery_writer_lease_until::text AS lease_until,
                  recovery_writer_updated_at::text AS updated_at`,
      [
        sheetId,
        current.ownerKind,
        current.ownerId,
        current.fence,
        current.leaseUntil,
        current.updatedAt,
        nextLease,
      ],
    )
    const snapshot = snapshotFromRow(result.rows[0])
    if (!snapshot) throw new ArchiveWriterBlockError('ARCHIVE_WRITER_BLOCK_OWNERSHIP_LOST')
    return snapshot
  })
}

export async function releaseArchiveWriterBlock(
  runner: ArchiveWriterBlockTransactionRunner,
  sheetIdInput: string,
  currentInput: ArchiveWriterBlockCurrentInput,
): Promise<void> {
  assertArchiveWriterBlockEnabled()
  const sheetId = requireOpaque(sheetIdInput)
  const current = validateSnapshot(currentInput)

  await runPrepared(runner, sheetId, async (query) => {
    const result = await query(
      `UPDATE public.meta_sheets
          SET recovery_writer_state = NULL,
              recovery_writer_owner_kind = NULL,
              recovery_writer_owner_id = NULL,
              recovery_writer_lease_until = NULL,
              recovery_writer_updated_at = NULL
        WHERE id = $1
          AND recovery_writer_state = 'archiving'
          AND recovery_writer_owner_kind = $2
          AND recovery_writer_owner_id = $3
          AND recovery_writer_owner_fence = $4::bigint
          AND recovery_writer_lease_until = $5::timestamptz
          AND recovery_writer_updated_at = $6::timestamptz`,
      [
        sheetId,
        current.ownerKind,
        current.ownerId,
        current.fence,
        current.leaseUntil,
        current.updatedAt,
      ],
    )
    if (rowCount(result) !== 1) {
      throw new ArchiveWriterBlockError('ARCHIVE_WRITER_BLOCK_OWNERSHIP_LOST')
    }
  })
}

/**
 * Low-level exact-owner check for future capture/job code.
 *
 * This function deliberately does not claim to enforce D-H2 ordering: the caller owns the
 * transaction boundary and must invoke it before the source read or live write required by that
 * protocol. It performs no fence acquisition and no mutation. The transaction-runner APIs above
 * are the only exported claim/heartbeat/release entries.
 */
export async function checkArchiveWriterBlockOwnerExact(
  query: FenceQuery,
  sheetIdInput: string,
  expectedInput: ArchiveWriterBlockCurrentInput,
): Promise<ArchiveWriterBlockSnapshot> {
  const sheetId = requireOpaque(sheetIdInput)
  const expected = validateSnapshot(expectedInput)
  const result = await query(
    `SELECT recovery_writer_state AS state,
            recovery_writer_owner_kind AS owner_kind,
            recovery_writer_owner_id AS owner_id,
            recovery_writer_owner_fence::text AS fence,
            recovery_writer_lease_until::text AS lease_until,
            recovery_writer_updated_at::text AS updated_at
       FROM public.meta_sheets
      WHERE id = $1
        AND recovery_writer_state = 'archiving'
        AND recovery_writer_owner_kind = $2
        AND recovery_writer_owner_id = $3
        AND recovery_writer_owner_fence = $4::bigint
        AND recovery_writer_lease_until = $5::timestamptz
        AND recovery_writer_updated_at = $6::timestamptz
        AND recovery_writer_lease_until > clock_timestamp()`,
    [
      sheetId,
      expected.ownerKind,
      expected.ownerId,
      expected.fence,
      expected.leaseUntil,
      expected.updatedAt,
    ],
  )
  const snapshot = snapshotFromRow(result.rows[0])
  if (!snapshot) throw new ArchiveWriterBlockError('ARCHIVE_WRITER_BLOCK_OWNERSHIP_LOST')
  return snapshot
}
