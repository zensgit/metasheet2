import { canonicalSheetFenceKey, type FenceQuery } from './canonical-sheet-fence'

/**
 * Bounded D3 D-L storage authority only. There is no route, auth adapter, production caller,
 * deletion intent, provider call, or object-deletion worker in this slice. Consequently this module
 * does not claim to close the future legal-hold-versus-`deleting` race.
 */

export type RecoveryArchiveLegalHoldQuery = FenceQuery

export type RecoveryArchiveLegalHoldErrorCode =
  | 'RECOVERY_ARCHIVE_LEGAL_HOLD_INVALID_INPUT'
  | 'RECOVERY_ARCHIVE_LEGAL_HOLD_NOT_IN_TRANSACTION'
  | 'RECOVERY_ARCHIVE_LEGAL_HOLD_BINDING_REFUSED'
  | 'RECOVERY_ARCHIVE_LEGAL_HOLD_KEY_UNAVAILABLE'
  | 'RECOVERY_ARCHIVE_LEGAL_HOLD_PLACE_CONFLICT'
  | 'RECOVERY_ARCHIVE_LEGAL_HOLD_RELEASE_STALE'
  | 'RECOVERY_ARCHIVE_LEGAL_HOLD_RELEASE_REFUSED'
  | 'RECOVERY_ARCHIVE_LEGAL_HOLD_EXPIRY_REFUSED'
  | 'RECOVERY_ARCHIVE_LEGAL_HOLD_EXPIRY_RESULT_INVALID'
  | 'RECOVERY_ARCHIVE_LEGAL_HOLD_RESULT_INVALID'

export class RecoveryArchiveLegalHoldError extends Error {
  readonly code: RecoveryArchiveLegalHoldErrorCode

  constructor(code: RecoveryArchiveLegalHoldErrorCode) {
    super(code)
    this.name = 'RecoveryArchiveLegalHoldError'
    this.code = code
  }
}

export interface RecoveryArchiveLegalHoldBindingInput {
  workspaceId: string
  baseId: string
  sheetId: string
  generationId: string
}

export interface PlaceRecoveryArchiveLegalHoldInput extends RecoveryArchiveLegalHoldBindingInput {
  holdId: string
  reasonCode: string
  placedByActorId: string
}

export interface ReleaseRecoveryArchiveLegalHoldInput extends RecoveryArchiveLegalHoldBindingInput {
  holdId: string
  expectedRowVersion: string
  releasedByActorId: string
}

export interface RecoveryArchiveLegalHoldSnapshot extends RecoveryArchiveLegalHoldBindingInput {
  holdId: string
  state: 'active' | 'released'
  reasonCode: string
  placedByActorId: string
  placedAt: string
  releasedByActorId: string | null
  releasedAt: string | null
  rowVersion: string
}

export interface RecoveryArchiveExpirySnapshot extends RecoveryArchiveLegalHoldBindingInput {
  state: 'expired'
  expiresAt: string
}

type NormalizedBinding = RecoveryArchiveLegalHoldBindingInput

type BoundArchive = NormalizedBinding & {
  keyId: string
  state: 'verified' | 'expired'
  expiresAt: string | null
}

type QueryResult = Awaited<ReturnType<RecoveryArchiveLegalHoldQuery>>

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const OPAQUE_PATTERN = /^[\x21-\x7e]{1,512}$/
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/

export const RECOVERY_ARCHIVE_LEGAL_HOLD_FENCE_SQL = `SELECT
  pg_advisory_xact_lock(hashtext($1)) AS locked,
  pg_current_xact_id()::text AS xid`

export const RECOVERY_ARCHIVE_LEGAL_HOLD_KEY_LOCK_SQL = `SELECT
  key_row.key_id,
  key_row.state,
  pg_current_xact_id()::text AS xid
FROM public.meta_recovery_archive_keys key_row
WHERE key_row.key_id = $1
  AND key_row.state = 'active'
FOR UPDATE`

export const RECOVERY_ARCHIVE_LEGAL_HOLD_GENERATION_LOCK_SQL = `SELECT
  archive.generation_id::text AS generation_id,
  archive.workspace_id,
  archive.base_id,
  archive.sheet_id,
  archive.key_id,
  archive.state,
  archive.expires_at::text AS expires_at,
  pg_current_xact_id()::text AS xid
FROM public.meta_recovery_archives archive
WHERE archive.generation_id = $1::uuid
FOR UPDATE`

const ARCHIVE_REBIND_SQL = `SELECT
  archive.generation_id::text AS generation_id,
  archive.workspace_id,
  archive.base_id,
  archive.sheet_id,
  archive.key_id,
  archive.state,
  archive.expires_at::text AS expires_at,
  pg_current_xact_id()::text AS xid
FROM public.meta_recovery_archives archive
WHERE archive.generation_id = $1::uuid`

const ACTIVE_HOLD_LOCK_SQL = `SELECT
  hold_row.id::text AS id,
  pg_current_xact_id()::text AS xid
FROM public.meta_recovery_archive_legal_holds hold_row
WHERE hold_row.generation_id = $1::uuid
  AND hold_row.state = 'active'
ORDER BY hold_row.id
FOR UPDATE`

export const RECOVERY_ARCHIVE_LEGAL_HOLD_EXPIRY_LOCK_SQL = `WITH active_holds AS (
  SELECT hold_row.id
  FROM public.meta_recovery_archive_legal_holds hold_row
  WHERE hold_row.generation_id = $1::uuid
    AND hold_row.state = 'active'
  ORDER BY hold_row.id
  FOR UPDATE
)
SELECT count(*)::int AS active_hold_count,
       pg_current_xact_id()::text AS xid
FROM active_holds`

const RELEASE_HOLD_LOCK_SQL = `SELECT
  hold_row.id::text AS id,
  hold_row.workspace_id,
  hold_row.base_id,
  hold_row.sheet_id,
  hold_row.generation_id::text AS generation_id,
  hold_row.state,
  hold_row.row_version::text AS row_version,
  pg_current_xact_id()::text AS xid
FROM public.meta_recovery_archive_legal_holds hold_row
WHERE hold_row.id = $1::uuid
  AND hold_row.generation_id = $2::uuid
  AND hold_row.state = 'active'
FOR UPDATE`

export const AUTHORIZE_RECOVERY_ARCHIVE_LEGAL_HOLD_RELEASE_SQL = `SELECT
  public.meta_recovery_archive_legal_hold_release_authorize($1::uuid, $2::uuid, $3, $4, $5, $6::bigint),
  pg_current_xact_id()::text AS xid`

export const RESET_RECOVERY_ARCHIVE_LEGAL_HOLD_RELEASE_AUTHORIZATION_SQL = `SELECT
  set_config('metasheet.recovery_archive_legal_hold_release_hold', '', true) AS reset_hold,
  set_config('metasheet.recovery_archive_legal_hold_release_generation', '', true) AS reset_generation,
  pg_current_xact_id()::text AS xid`

export const AUTHORIZE_RECOVERY_ARCHIVE_EXPIRY_SQL = `SELECT
  public.meta_recovery_archive_expiry_authorize($1::uuid, $2, $3, $4),
  pg_current_xact_id()::text AS xid`

export const EXPIRE_RECOVERY_ARCHIVE_SQL = `UPDATE public.meta_recovery_archives
SET state = 'expired'
WHERE generation_id = $1::uuid
  AND workspace_id = $2
  AND base_id = $3
  AND sheet_id = $4
  AND key_id = $5
  AND state = 'verified'
  AND expires_at IS NOT NULL
  AND expires_at <= clock_timestamp()
RETURNING generation_id::text AS generation_id,
          workspace_id,
          base_id,
          sheet_id,
          state,
          expires_at::text AS expires_at,
          pg_current_xact_id()::text AS xid`

export const RESET_RECOVERY_ARCHIVE_EXPIRY_AUTHORIZATION_SQL = `SELECT
  set_config('metasheet.recovery_archive_expiry_generation', '', true) AS reset,
  pg_current_xact_id()::text AS xid`

const PLACE_HOLD_SQL = `INSERT INTO public.meta_recovery_archive_legal_holds (
  id, workspace_id, base_id, sheet_id, generation_id,
  state, reason_code, placed_by_actor_id, row_version
) VALUES (
  $1::uuid, $2, $3, $4, $5::uuid,
  'active', $6, $7, 1
)
ON CONFLICT (generation_id) WHERE state = 'active' DO NOTHING
RETURNING id::text AS id,
          workspace_id,
          base_id,
          sheet_id,
          generation_id::text AS generation_id,
          state,
          reason_code,
          placed_by_actor_id,
          placed_at::text AS placed_at,
          released_by_actor_id,
          released_at::text AS released_at,
          row_version::text AS row_version,
          pg_current_xact_id()::text AS xid`

export const RELEASE_RECOVERY_ARCHIVE_LEGAL_HOLD_SQL = `UPDATE public.meta_recovery_archive_legal_holds
SET state = 'released',
    released_by_actor_id = $6,
    released_at = clock_timestamp(),
    row_version = row_version + 1
WHERE id = $1::uuid
  AND workspace_id = $2
  AND base_id = $3
  AND sheet_id = $4
  AND generation_id = $5::uuid
  AND state = 'active'
  AND row_version = $7::bigint
RETURNING id::text AS id,
          workspace_id,
          base_id,
          sheet_id,
          generation_id::text AS generation_id,
          state,
          reason_code,
          placed_by_actor_id,
          placed_at::text AS placed_at,
          released_by_actor_id,
          released_at::text AS released_at,
          row_version::text AS row_version,
          pg_current_xact_id()::text AS xid`

function fail(code: RecoveryArchiveLegalHoldErrorCode): never {
  throw new RecoveryArchiveLegalHoldError(code)
}

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    fail('RECOVERY_ARCHIVE_LEGAL_HOLD_INVALID_INPUT')
  }
  return value
}

function requireOpaque(value: unknown): string {
  if (typeof value !== 'string' || !OPAQUE_PATTERN.test(value)) {
    fail('RECOVERY_ARCHIVE_LEGAL_HOLD_INVALID_INPUT')
  }
  return value
}

function requireReasonCode(value: unknown): string {
  if (typeof value !== 'string' || !REASON_CODE_PATTERN.test(value)) {
    fail('RECOVERY_ARCHIVE_LEGAL_HOLD_INVALID_INPUT')
  }
  return value
}

function requireRowVersion(value: unknown): string {
  if (typeof value !== 'string' || !POSITIVE_DECIMAL_PATTERN.test(value)) {
    fail('RECOVERY_ARCHIVE_LEGAL_HOLD_INVALID_INPUT')
  }
  return value
}

function normalizeBinding(input: RecoveryArchiveLegalHoldBindingInput): NormalizedBinding {
  try {
    return {
      workspaceId: requireOpaque(input.workspaceId),
      baseId: requireOpaque(input.baseId),
      sheetId: requireOpaque(input.sheetId),
      generationId: requireUuid(input.generationId),
    }
  } catch {
    fail('RECOVERY_ARCHIVE_LEGAL_HOLD_INVALID_INPUT')
  }
}

function normalizePlace(input: PlaceRecoveryArchiveLegalHoldInput): PlaceRecoveryArchiveLegalHoldInput {
  try {
    return {
      ...normalizeBinding(input),
      holdId: requireUuid(input.holdId),
      reasonCode: requireReasonCode(input.reasonCode),
      placedByActorId: requireOpaque(input.placedByActorId),
    }
  } catch {
    fail('RECOVERY_ARCHIVE_LEGAL_HOLD_INVALID_INPUT')
  }
}

function normalizeRelease(
  input: ReleaseRecoveryArchiveLegalHoldInput,
): ReleaseRecoveryArchiveLegalHoldInput {
  try {
    return {
      ...normalizeBinding(input),
      holdId: requireUuid(input.holdId),
      expectedRowVersion: requireRowVersion(input.expectedRowVersion),
      releasedByActorId: requireOpaque(input.releasedByActorId),
    }
  } catch {
    fail('RECOVERY_ARCHIVE_LEGAL_HOLD_INVALID_INPUT')
  }
}

async function safeQuery(
  query: RecoveryArchiveLegalHoldQuery,
  sqlText: string,
  params: unknown[] = [],
  errorCode: RecoveryArchiveLegalHoldErrorCode,
): Promise<QueryResult> {
  try {
    return await query(sqlText, params)
  } catch {
    fail(errorCode)
  }
}

function oneRow(result: QueryResult): Record<string, unknown> | null {
  try {
    if (result.rowCount !== 1 || !Array.isArray(result.rows) || result.rows.length !== 1) return null
    const row = result.rows[0]
    return typeof row === 'object' && row !== null && !Array.isArray(row)
      ? row as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function xidOf(result: QueryResult): string | null {
  const row = oneRow(result)
  return typeof row?.xid === 'string' && row.xid.length > 0 ? row.xid : null
}

async function requireStableTransaction(query: RecoveryArchiveLegalHoldQuery): Promise<string> {
  const first = await safeQuery(
    query,
    'SELECT pg_current_xact_id()::text AS xid',
    [],
    'RECOVERY_ARCHIVE_LEGAL_HOLD_NOT_IN_TRANSACTION',
  )
  const second = await safeQuery(
    query,
    'SELECT pg_current_xact_id()::text AS xid',
    [],
    'RECOVERY_ARCHIVE_LEGAL_HOLD_NOT_IN_TRANSACTION',
  )
  const firstXid = xidOf(first)
  if (firstXid === null || xidOf(second) !== firstXid) {
    fail('RECOVERY_ARCHIVE_LEGAL_HOLD_NOT_IN_TRANSACTION')
  }
  return firstXid
}

function requireXid(result: QueryResult, xid: string): Record<string, unknown> {
  const row = oneRow(result)
  if (row === null || row.xid !== xid) {
    fail('RECOVERY_ARCHIVE_LEGAL_HOLD_NOT_IN_TRANSACTION')
  }
  return row
}

function boundArchiveFromRow(row: Record<string, unknown>): BoundArchive | null {
  let expiresAt: string | null
  if (row.expires_at === null) expiresAt = null
  else if (typeof row.expires_at === 'string') expiresAt = row.expires_at
  else return null
  if (
    typeof row.workspace_id !== 'string'
    || typeof row.base_id !== 'string'
    || typeof row.sheet_id !== 'string'
    || typeof row.generation_id !== 'string'
    || typeof row.key_id !== 'string'
    || (row.state !== 'verified' && row.state !== 'expired')
  ) {
    return null
  }
  return {
    workspaceId: row.workspace_id,
    baseId: row.base_id,
    sheetId: row.sheet_id,
    generationId: row.generation_id,
    keyId: row.key_id,
    state: row.state,
    expiresAt,
  }
}

function exactBinding(left: NormalizedBinding, right: BoundArchive): boolean {
  return left.workspaceId === right.workspaceId
    && left.baseId === right.baseId
    && left.sheetId === right.sheetId
    && left.generationId === right.generationId
}

async function rebindArchive(
  query: RecoveryArchiveLegalHoldQuery,
  input: NormalizedBinding,
  xid: string,
): Promise<BoundArchive> {
  const result = await safeQuery(
    query,
    ARCHIVE_REBIND_SQL,
    [input.generationId],
    'RECOVERY_ARCHIVE_LEGAL_HOLD_BINDING_REFUSED',
  )
  const row = oneRow(result)
  if (row === null) fail('RECOVERY_ARCHIVE_LEGAL_HOLD_BINDING_REFUSED')
  if (row.xid !== xid) fail('RECOVERY_ARCHIVE_LEGAL_HOLD_NOT_IN_TRANSACTION')
  const archive = boundArchiveFromRow(row)
  if (archive === null || !exactBinding(input, archive)) {
    fail('RECOVERY_ARCHIVE_LEGAL_HOLD_BINDING_REFUSED')
  }
  return archive
}

async function acquireFence(
  query: RecoveryArchiveLegalHoldQuery,
  archive: BoundArchive,
  xid: string,
): Promise<void> {
  const result = await safeQuery(
    query,
    RECOVERY_ARCHIVE_LEGAL_HOLD_FENCE_SQL,
    [canonicalSheetFenceKey(archive.sheetId)],
    'RECOVERY_ARCHIVE_LEGAL_HOLD_BINDING_REFUSED',
  )
  requireXid(result, xid)
}

async function lockActiveKey(
  query: RecoveryArchiveLegalHoldQuery,
  archive: BoundArchive,
  xid: string,
): Promise<void> {
  const result = await safeQuery(
    query,
    RECOVERY_ARCHIVE_LEGAL_HOLD_KEY_LOCK_SQL,
    [archive.keyId],
    'RECOVERY_ARCHIVE_LEGAL_HOLD_KEY_UNAVAILABLE',
  )
  const row = oneRow(result)
  if (row === null) fail('RECOVERY_ARCHIVE_LEGAL_HOLD_KEY_UNAVAILABLE')
  if (row.xid !== xid) fail('RECOVERY_ARCHIVE_LEGAL_HOLD_NOT_IN_TRANSACTION')
  if (row.key_id !== archive.keyId || row.state !== 'active') {
    fail('RECOVERY_ARCHIVE_LEGAL_HOLD_KEY_UNAVAILABLE')
  }
}

async function lockGeneration(
  query: RecoveryArchiveLegalHoldQuery,
  archive: BoundArchive,
  xid: string,
): Promise<void> {
  const result = await safeQuery(
    query,
    RECOVERY_ARCHIVE_LEGAL_HOLD_GENERATION_LOCK_SQL,
    [archive.generationId],
    'RECOVERY_ARCHIVE_LEGAL_HOLD_BINDING_REFUSED',
  )
  const row = oneRow(result)
  if (row === null) fail('RECOVERY_ARCHIVE_LEGAL_HOLD_BINDING_REFUSED')
  if (row.xid !== xid) fail('RECOVERY_ARCHIVE_LEGAL_HOLD_NOT_IN_TRANSACTION')
  const rebound = boundArchiveFromRow(row)
  if (rebound === null || rebound.keyId !== archive.keyId || !exactBinding(archive, rebound)) {
    fail('RECOVERY_ARCHIVE_LEGAL_HOLD_BINDING_REFUSED')
  }
}

async function prepareAuthority(
  query: RecoveryArchiveLegalHoldQuery,
  input: NormalizedBinding,
): Promise<{ archive: BoundArchive; xid: string }> {
  const xid = await requireStableTransaction(query)
  const archive = await rebindArchive(query, input, xid)
  await acquireFence(query, archive, xid)
  await lockActiveKey(query, archive, xid)
  await lockGeneration(query, archive, xid)
  return { archive, xid }
}

async function authorizeExpiry(
  query: RecoveryArchiveLegalHoldQuery,
  archive: BoundArchive,
  xid: string,
): Promise<void> {
  const result = await safeQuery(
    query,
    AUTHORIZE_RECOVERY_ARCHIVE_EXPIRY_SQL,
    [archive.generationId, archive.workspaceId, archive.baseId, archive.sheetId],
    'RECOVERY_ARCHIVE_LEGAL_HOLD_EXPIRY_REFUSED',
  )
  requireXid(result, xid)
}

async function resetExpiryAuthorization(
  query: RecoveryArchiveLegalHoldQuery,
  xid: string,
): Promise<void> {
  const result = await safeQuery(
    query,
    RESET_RECOVERY_ARCHIVE_EXPIRY_AUTHORIZATION_SQL,
    [],
    'RECOVERY_ARCHIVE_LEGAL_HOLD_NOT_IN_TRANSACTION',
  )
  requireXid(result, xid)
}

async function authorizeRelease(
  query: RecoveryArchiveLegalHoldQuery,
  archive: BoundArchive,
  input: ReleaseRecoveryArchiveLegalHoldInput,
  xid: string,
): Promise<void> {
  const result = await safeQuery(
    query,
    AUTHORIZE_RECOVERY_ARCHIVE_LEGAL_HOLD_RELEASE_SQL,
    [
      input.holdId,
      archive.generationId,
      archive.workspaceId,
      archive.baseId,
      archive.sheetId,
      input.expectedRowVersion,
    ],
    'RECOVERY_ARCHIVE_LEGAL_HOLD_RELEASE_REFUSED',
  )
  requireXid(result, xid)
}

async function resetReleaseAuthorization(
  query: RecoveryArchiveLegalHoldQuery,
  xid: string,
): Promise<void> {
  const result = await safeQuery(
    query,
    RESET_RECOVERY_ARCHIVE_LEGAL_HOLD_RELEASE_AUTHORIZATION_SQL,
    [],
    'RECOVERY_ARCHIVE_LEGAL_HOLD_NOT_IN_TRANSACTION',
  )
  requireXid(result, xid)
}

async function lockNoActiveHoldForExpiry(
  query: RecoveryArchiveLegalHoldQuery,
  archive: BoundArchive,
  xid: string,
): Promise<void> {
  const result = await safeQuery(
    query,
    RECOVERY_ARCHIVE_LEGAL_HOLD_EXPIRY_LOCK_SQL,
    [archive.generationId],
    'RECOVERY_ARCHIVE_LEGAL_HOLD_EXPIRY_REFUSED',
  )
  const row = requireXid(result, xid)
  if (row.active_hold_count !== 0) fail('RECOVERY_ARCHIVE_LEGAL_HOLD_EXPIRY_REFUSED')
}

function expirySnapshotFromRow(
  row: Record<string, unknown>,
  archive: BoundArchive,
  xid: string,
): RecoveryArchiveExpirySnapshot | null {
  if (
    row.xid !== xid
    || row.generation_id !== archive.generationId
    || row.workspace_id !== archive.workspaceId
    || row.base_id !== archive.baseId
    || row.sheet_id !== archive.sheetId
    || row.state !== 'expired'
    || typeof row.expires_at !== 'string'
  ) {
    return null
  }
  return {
    workspaceId: archive.workspaceId,
    baseId: archive.baseId,
    sheetId: archive.sheetId,
    generationId: archive.generationId,
    state: 'expired',
    expiresAt: row.expires_at,
  }
}

function snapshotFromRow(
  row: Record<string, unknown>,
  xid: string,
): RecoveryArchiveLegalHoldSnapshot | null {
  if (
    row.xid !== xid
    || typeof row.id !== 'string'
    || typeof row.workspace_id !== 'string'
    || typeof row.base_id !== 'string'
    || typeof row.sheet_id !== 'string'
    || typeof row.generation_id !== 'string'
    || (row.state !== 'active' && row.state !== 'released')
    || typeof row.reason_code !== 'string'
    || typeof row.placed_by_actor_id !== 'string'
    || typeof row.placed_at !== 'string'
    || (row.released_by_actor_id !== null && typeof row.released_by_actor_id !== 'string')
    || (row.released_at !== null && typeof row.released_at !== 'string')
    || typeof row.row_version !== 'string'
  ) {
    return null
  }
  return {
    holdId: row.id,
    workspaceId: row.workspace_id,
    baseId: row.base_id,
    sheetId: row.sheet_id,
    generationId: row.generation_id,
    state: row.state,
    reasonCode: row.reason_code,
    placedByActorId: row.placed_by_actor_id,
    placedAt: row.placed_at,
    releasedByActorId: row.released_by_actor_id as string | null,
    releasedAt: row.released_at as string | null,
    rowVersion: row.row_version,
  }
}

/** Place one active hold. The caller owns and retains the surrounding transaction. */
export async function placeRecoveryArchiveLegalHold(
  query: RecoveryArchiveLegalHoldQuery,
  input: PlaceRecoveryArchiveLegalHoldInput,
): Promise<RecoveryArchiveLegalHoldSnapshot> {
  const normalized = normalizePlace(input)
  const { archive, xid } = await prepareAuthority(query, normalized)
  const existing = await safeQuery(
    query,
    ACTIVE_HOLD_LOCK_SQL,
    [archive.generationId],
    'RECOVERY_ARCHIVE_LEGAL_HOLD_PLACE_CONFLICT',
  )
  let existingCount: number
  try {
    existingCount = existing.rows.length
  } catch {
    fail('RECOVERY_ARCHIVE_LEGAL_HOLD_RESULT_INVALID')
  }
  if (existingCount !== 0) fail('RECOVERY_ARCHIVE_LEGAL_HOLD_PLACE_CONFLICT')

  const result = await safeQuery(
    query,
    PLACE_HOLD_SQL,
    [
      normalized.holdId,
      archive.workspaceId,
      archive.baseId,
      archive.sheetId,
      archive.generationId,
      normalized.reasonCode,
      normalized.placedByActorId,
    ],
    'RECOVERY_ARCHIVE_LEGAL_HOLD_PLACE_CONFLICT',
  )
  const row = oneRow(result)
  const snapshot = row === null ? null : snapshotFromRow(row, xid)
  if (snapshot === null) fail('RECOVERY_ARCHIVE_LEGAL_HOLD_PLACE_CONFLICT')
  return snapshot
}

/** Release holds the D-L prefix through one exact active-row-version CAS. */
export async function releaseRecoveryArchiveLegalHold(
  query: RecoveryArchiveLegalHoldQuery,
  input: ReleaseRecoveryArchiveLegalHoldInput,
): Promise<RecoveryArchiveLegalHoldSnapshot> {
  const normalized = normalizeRelease(input)
  const { archive, xid } = await prepareAuthority(query, normalized)
  const locked = await safeQuery(
    query,
    RELEASE_HOLD_LOCK_SQL,
    [normalized.holdId, archive.generationId],
    'RECOVERY_ARCHIVE_LEGAL_HOLD_RELEASE_STALE',
  )
  const lockedRow = oneRow(locked)
  if (
    lockedRow === null
    || lockedRow.xid !== xid
    || lockedRow.id !== normalized.holdId
    || lockedRow.workspace_id !== archive.workspaceId
    || lockedRow.base_id !== archive.baseId
    || lockedRow.sheet_id !== archive.sheetId
    || lockedRow.generation_id !== archive.generationId
    || lockedRow.state !== 'active'
    || lockedRow.row_version !== normalized.expectedRowVersion
  ) {
    fail('RECOVERY_ARCHIVE_LEGAL_HOLD_RELEASE_STALE')
  }

  let authorizationAttempted = false
  let operationFailed = false
  try {
    authorizationAttempted = true
    await authorizeRelease(query, archive, normalized, xid)
    const result = await safeQuery(
      query,
      RELEASE_RECOVERY_ARCHIVE_LEGAL_HOLD_SQL,
      [
        normalized.holdId,
        archive.workspaceId,
        archive.baseId,
        archive.sheetId,
        archive.generationId,
        normalized.releasedByActorId,
        normalized.expectedRowVersion,
      ],
      'RECOVERY_ARCHIVE_LEGAL_HOLD_RELEASE_STALE',
    )
    const row = oneRow(result)
    const snapshot = row === null ? null : snapshotFromRow(row, xid)
    if (snapshot === null) fail('RECOVERY_ARCHIVE_LEGAL_HOLD_RELEASE_STALE')
    return snapshot
  } catch (error) {
    operationFailed = true
    throw error
  } finally {
    if (authorizationAttempted) {
      try {
        await resetReleaseAuthorization(query, xid)
      } catch (resetError) {
        if (!operationFailed) throw resetError
      }
    }
  }
}

/**
 * Expires exactly one due generation under the D-L fence -> key -> generation -> hold prefix.
 *
 * The database authority opens a transaction-local, generation-bound guard only after it repeats
 * that prefix and validates database time. This helper clears the guard before returning while the
 * transaction remains usable; an aborted transaction rolls back its transaction-local guard.
 */
export async function expireRecoveryArchiveAfterLegalHoldCheck(
  query: RecoveryArchiveLegalHoldQuery,
  input: RecoveryArchiveLegalHoldBindingInput,
): Promise<RecoveryArchiveExpirySnapshot> {
  const normalized = normalizeBinding(input)
  const { archive, xid } = await prepareAuthority(query, normalized)
  if (archive.state !== 'verified') fail('RECOVERY_ARCHIVE_LEGAL_HOLD_EXPIRY_REFUSED')
  await lockNoActiveHoldForExpiry(query, archive, xid)

  let authorizationAttempted = false
  let operationFailed = false
  try {
    authorizationAttempted = true
    await authorizeExpiry(query, archive, xid)
    const result = await safeQuery(
      query,
      EXPIRE_RECOVERY_ARCHIVE_SQL,
      [
        archive.generationId,
        archive.workspaceId,
        archive.baseId,
        archive.sheetId,
        archive.keyId,
      ],
      'RECOVERY_ARCHIVE_LEGAL_HOLD_EXPIRY_REFUSED',
    )
    const row = oneRow(result)
    const snapshot = row === null ? null : expirySnapshotFromRow(row, archive, xid)
    if (snapshot === null) fail('RECOVERY_ARCHIVE_LEGAL_HOLD_EXPIRY_RESULT_INVALID')
    return snapshot
  } catch (error) {
    operationFailed = true
    throw error
  } finally {
    if (authorizationAttempted) {
      try {
        await resetExpiryAuthorization(query, xid)
      } catch (resetError) {
        if (!operationFailed) throw resetError
      }
    }
  }
}
