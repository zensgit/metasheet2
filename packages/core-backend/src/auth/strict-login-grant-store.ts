import { createHash } from 'node:crypto'
import { adminGrantCommandKey } from './admin-grant-proof-storage'
import {
  STRICT_LOGIN_GRANT_CONTEXT_KEYS,
  STRICT_LOGIN_GRANT_DOWN_BLOCKED_CODE,
  STRICT_LOGIN_GRANT_DOWN_REQUIRES_READ_COMMITTED_CODE,
  STRICT_LOGIN_GRANT_DOWN_REQUIRES_TRANSACTION_CODE,
  STRICT_LOGIN_GRANT_FUNCTIONS,
  STRICT_LOGIN_GRANT_GRANT_ORDINAL_UNIQUE,
  STRICT_LOGIN_GRANT_GRANT_TABLE,
  STRICT_LOGIN_GRANT_GRANT_USER_UNIQUE,
  STRICT_LOGIN_GRANT_LIVE_SLOT_INDEX,
  STRICT_LOGIN_GRANT_MIGRATION_NAME,
  STRICT_LOGIN_GRANT_RECEIPT_PRIMARY_KEY,
  STRICT_LOGIN_GRANT_RECEIPT_PROOF_UNIQUE,
  STRICT_LOGIN_GRANT_SCOPE_TABLE,
  STRICT_LOGIN_GRANT_SESSION_CHECKS,
  STRICT_LOGIN_GRANT_SESSION_CONTEXT_COLUMN,
  STRICT_LOGIN_GRANT_TABLES,
  STRICT_LOGIN_GRANT_TRIGGERS,
} from '../db/migrations/zzzz20261118120000_strict_login_grant_scope'

export {
  STRICT_LOGIN_GRANT_CONTEXT_KEYS,
  STRICT_LOGIN_GRANT_DOWN_BLOCKED_CODE,
  STRICT_LOGIN_GRANT_DOWN_REQUIRES_READ_COMMITTED_CODE,
  STRICT_LOGIN_GRANT_DOWN_REQUIRES_TRANSACTION_CODE,
  STRICT_LOGIN_GRANT_GRANT_ORDINAL_UNIQUE,
  STRICT_LOGIN_GRANT_GRANT_USER_UNIQUE,
  STRICT_LOGIN_GRANT_LIVE_SLOT_INDEX,
  STRICT_LOGIN_GRANT_MIGRATION_NAME,
  STRICT_LOGIN_GRANT_RECEIPT_PRIMARY_KEY,
  STRICT_LOGIN_GRANT_RECEIPT_PROOF_UNIQUE,
}

export const STRICT_LOGIN_GRANT_ID_DOMAIN = 'metasheet:strict-login-grant-id:v1|'
export const STRICT_LOGIN_GRANT_WATERMARK_EPOCH = '1970-01-01 00:00:00+00'
export const STRICT_GRANT_SESSION_REVOCATION_REASON = 'strict_grant_revoked'

export const STRICT_LOGIN_GRANT_REVOKE_REASONS = [
  'deprovision',
  'admin_unbind',
  'admin_disable',
  'recycle_purge',
  'privilege_elevation',
  'binding_replaced',
] as const

export type StrictLoginGrantRevokeReason = (typeof STRICT_LOGIN_GRANT_REVOKE_REASONS)[number]

export const STRICT_LOGIN_GRANT_REPLAY_CONSTRAINTS = [
  STRICT_LOGIN_GRANT_RECEIPT_PRIMARY_KEY,
  STRICT_LOGIN_GRANT_RECEIPT_PROOF_UNIQUE,
  STRICT_LOGIN_GRANT_GRANT_ORDINAL_UNIQUE,
  STRICT_LOGIN_GRANT_GRANT_USER_UNIQUE,
] as const

const STRICT_LOGIN_GRANT_CODES = [
  'STRICT_LOGIN_GRANT_INSTALLATION_REFUSED',
  'STRICT_LOGIN_GRANT_INPUT_REFUSED',
  'STRICT_LOGIN_GRANT_SCOPE_PRESENT',
  'STRICT_LOGIN_GRANT_GRANT_OCCUPIED',
  'STRICT_LOGIN_GRANT_UNIQUE_CONFLICT',
  'STRICT_LOGIN_GRANT_REVOKE_REFUSED',
  'STRICT_LOGIN_GRANT_DETACH_REFUSED',
  'STRICT_LOGIN_GRANT_WATERMARK_SET_UNSTABLE',
  'STRICT_LOGIN_GRANT_SESSION_LOCK_REFUSED',
] as const

export type StrictLoginGrantCode = (typeof STRICT_LOGIN_GRANT_CODES)[number]

const MESSAGES: Readonly<Record<StrictLoginGrantCode, string>> = {
  STRICT_LOGIN_GRANT_INSTALLATION_REFUSED: 'Strict login grant installation refused',
  STRICT_LOGIN_GRANT_INPUT_REFUSED: 'Strict login grant input refused',
  STRICT_LOGIN_GRANT_SCOPE_PRESENT: 'Strict login grant scope already exists',
  STRICT_LOGIN_GRANT_GRANT_OCCUPIED: 'Strict login grant live slot is occupied',
  STRICT_LOGIN_GRANT_UNIQUE_CONFLICT: 'Strict login grant unique conflict',
  STRICT_LOGIN_GRANT_REVOKE_REFUSED: 'Strict login grant revoke refused',
  STRICT_LOGIN_GRANT_DETACH_REFUSED: 'Strict login grant evidence detach refused',
  STRICT_LOGIN_GRANT_WATERMARK_SET_UNSTABLE: 'Strict login grant watermark set changed before session locks',
  STRICT_LOGIN_GRANT_SESSION_LOCK_REFUSED: 'Strict login grant session lock refused',
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/
const HEX_64 = /^[0-9a-f]{64}$/
const GRANT_ID = /^slg\.[0-9a-f]{64}$/
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DECIMAL = /^(0|[1-9][0-9]*)$/
const INTEGER = /^(0|[1-9][0-9]*)$/

export class StrictLoginGrantError extends Error {
  readonly code: StrictLoginGrantCode
  readonly sqlState?: string
  readonly constraint?: string

  constructor(code: StrictLoginGrantCode, detail?: { readonly sqlState?: string; readonly constraint?: string }) {
    super(MESSAGES[code])
    this.name = 'StrictLoginGrantError'
    this.code = code
    if (detail?.sqlState) this.sqlState = detail.sqlState
    if (detail?.constraint) this.constraint = detail.constraint
  }
}

export type StrictLoginGrantCaller = {
  query: (sql: string, params?: unknown[]) => Promise<{
    rows: readonly Record<string, unknown>[]
    rowCount?: number | null
  }>
}

export type StrictLoginInstallation =
  | { readonly installation: 'never-installed' }
  | { readonly installation: 'installed' }

export type StrictLoginScopeRow = {
  readonly connectionId: string
  readonly commandId: string
  readonly transitionedAt: string
}

export type StrictLoginScopeRead =
  | { readonly installation: 'never-installed'; readonly scope: null }
  | { readonly installation: 'installed'; readonly scope: StrictLoginScopeRow | null }

export type StrictLoginGrantRevokeInput = {
  readonly reason: StrictLoginGrantRevokeReason
  readonly revokedBy: string
  readonly revokedEventId?: string | null
  readonly revokedRunId?: string | null
  readonly revokedAccountId?: string | null
  readonly revokedOrgId?: string | null
}

export type StrictLoginGrantRevokeResult = {
  readonly grantIds: readonly string[]
}

export type StrictSessionContext = {
  readonly v: 1
  readonly provider: 'dingtalk'
  readonly connectionId: string
  readonly identityId: string
  readonly grantId: string
  readonly evidenceId: string
  readonly orgId: string
  readonly subjectAppScope: string
  readonly subjectKey: string
  readonly bindingRevision: string
  readonly applicationRevision: string
  readonly accessGeneration: string
  readonly capRev: string
  readonly assurance: 'self_authenticated'
  readonly policyRevision: number
  readonly scopeAsserted: false
}

export type StrictLoginGrantBundleGrant = {
  readonly ordinal: number
  readonly userId: string
  readonly grantId: string
}

export type StrictLoginGrantBundle = {
  readonly commandKey: string
  readonly proofId: string
  readonly commandId: string
  readonly targetCount: number
  readonly grants: readonly StrictLoginGrantBundleGrant[]
}

export type StrictLoginGrantSessionRevocation = {
  readonly userIds: readonly string[]
  readonly sessionIds: readonly string[]
}

function refuse(code: StrictLoginGrantCode): never {
  throw new StrictLoginGrantError(code)
}

function pgDetail(error: unknown): { sqlState?: string; constraint?: string } {
  if (!error || typeof error !== 'object') return {}
  const sqlState = (error as { code?: unknown }).code
  const constraint = (error as { constraint?: unknown }).constraint
  return {
    sqlState: typeof sqlState === 'string' && /^[0-9A-Z]{5}$/.test(sqlState) ? sqlState : undefined,
    constraint: typeof constraint === 'string' && constraint.length > 0 ? constraint : undefined,
  }
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

function opaque(value: string): string {
  if (value.length === 0 || value.trim() !== value || value.includes('\u0000') || hasUnpairedSurrogate(value)) {
    refuse('STRICT_LOGIN_GRANT_INPUT_REFUSED')
  }
  return value
}

function uuidText(value: string): string {
  if (!UUID_TEXT.test(value)) refuse('STRICT_LOGIN_GRANT_INPUT_REFUSED')
  return value
}

function byCodeUnit(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function extendsPrefix(prefix: readonly string[], next: readonly string[]): boolean {
  return prefix.length <= next.length && prefix.every((value, index) => value === next[index])
}

function uniqueSorted(values: readonly string[], code: StrictLoginGrantCode): string[] {
  const sorted = [...values].sort(byCodeUnit)
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === sorted[index - 1]) throw new StrictLoginGrantError(code)
  }
  return sorted
}

function rowsOf(result: unknown): readonly Record<string, unknown>[] {
  if (!result || typeof result !== 'object' || !Array.isArray((result as { rows?: unknown }).rows)) {
    refuse('STRICT_LOGIN_GRANT_INPUT_REFUSED')
  }
  return (result as { rows: readonly Record<string, unknown>[] }).rows
}

async function queryRows(
  caller: StrictLoginGrantCaller,
  text: string,
  params: readonly unknown[] = [],
): Promise<readonly Record<string, unknown>[]> {
  return rowsOf(await caller.query(text, [...params]))
}

function quoteIdent(identifier: string): string {
  if (!IDENTIFIER.test(identifier)) refuse('STRICT_LOGIN_GRANT_INSTALLATION_REFUSED')
  return `"${identifier}"`
}

function qualified(schemaName: string, identifier: string): string {
  return `${quoteIdent(schemaName)}.${quoteIdent(identifier)}`
}

async function installSchema(caller: StrictLoginGrantCaller): Promise<string> {
  let result: unknown
  try {
    result = await caller.query(
      `SELECT candidate.nspname AS schema_name
         FROM pg_catalog.unnest(pg_catalog.current_schemas(false)) WITH ORDINALITY AS candidate(nspname, ord)
        ORDER BY candidate.ord`,
    )
  } catch (error) {
    throw new StrictLoginGrantError('STRICT_LOGIN_GRANT_INSTALLATION_REFUSED', pgDetail(error))
  }
  for (const row of rowsOf(result)) {
    const name = row.schema_name
    if (typeof name !== 'string' || name.startsWith('pg_') || name === 'information_schema') continue
    if (!IDENTIFIER.test(name)) break
    return name
  }
  refuse('STRICT_LOGIN_GRANT_INSTALLATION_REFUSED')
}

function textAt(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') refuse('STRICT_LOGIN_GRANT_INSTALLATION_REFUSED')
  return value
}

async function installationCensus(
  caller: StrictLoginGrantCaller,
  schemaName: string,
): Promise<{ present: number; named: number }> {
  // One statement keeps all seven existing checks on one catalog snapshot.
  const rows = await queryRows(caller,
    `SELECT 'table'::text AS kind, c.relname::text AS name
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relkind = 'r'
        AND c.relpersistence = 'p'
        AND c.relname = ANY($2::text[])
      UNION ALL
     SELECT 'function'::text AS kind, p.proname::text AS name
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1
        AND p.proname = ANY($3::text[])
      UNION ALL
     SELECT 'trigger'::text AS kind, t.tgname::text AS name
       FROM pg_catalog.pg_trigger t
       JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND NOT t.tgisinternal
        AND t.tgname = ANY($4::text[])
      UNION ALL
     SELECT 'check'::text AS kind, con.conname::text AS name
       FROM pg_catalog.pg_constraint con
       JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relname = 'user_sessions'
        AND con.contype = 'c'
        AND con.conname = ANY($5::text[])
      UNION ALL
     SELECT 'index'::text AS kind, c.relname::text AS name
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relkind = 'i'
        AND c.relname = $6::text
      UNION ALL
     SELECT 'column'::text AS kind, a.attname::text AS name
       FROM pg_catalog.pg_attribute a
       JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relname = 'user_sessions'
        AND a.attname = $7::text
        AND a.attnum > 0
        AND NOT a.attisdropped
      UNION ALL
     SELECT 'named'::text AS kind, c.relname::text AS name
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relname = ANY($2::text[])`,
    [schemaName, [...STRICT_LOGIN_GRANT_TABLES], [...STRICT_LOGIN_GRANT_FUNCTIONS],
      [...STRICT_LOGIN_GRANT_TRIGGERS], [...STRICT_LOGIN_GRANT_SESSION_CHECKS],
      STRICT_LOGIN_GRANT_LIVE_SLOT_INDEX, STRICT_LOGIN_GRANT_SESSION_CONTEXT_COLUMN],
  )
  const found = new Map<string, Set<string>>()
  for (const row of rows) {
    const kind = textAt(row, 'kind')
    const names = found.get(kind) ?? new Set<string>()
    names.add(textAt(row, 'name'))
    found.set(kind, names)
  }
  const count = (kind: string, names: readonly string[]): number => names.filter((name) => found.get(kind)?.has(name)).length
  return {
    present: count('table', STRICT_LOGIN_GRANT_TABLES)
      + count('function', STRICT_LOGIN_GRANT_FUNCTIONS)
      + count('trigger', STRICT_LOGIN_GRANT_TRIGGERS)
      + count('check', STRICT_LOGIN_GRANT_SESSION_CHECKS)
      + count('index', [STRICT_LOGIN_GRANT_LIVE_SLOT_INDEX])
      + count('column', [STRICT_LOGIN_GRANT_SESSION_CONTEXT_COLUMN]),
    named: found.get('named')?.size ?? 0,
  }
}

const CENSUS_EXPECTED = STRICT_LOGIN_GRANT_TABLES.length
  + STRICT_LOGIN_GRANT_FUNCTIONS.length
  + STRICT_LOGIN_GRANT_TRIGGERS.length
  + STRICT_LOGIN_GRANT_SESSION_CHECKS.length
  + 2

async function readInstallationWithSchema(
  caller: StrictLoginGrantCaller,
): Promise<{ installation: StrictLoginInstallation['installation']; schemaName: string }> {
  const schemaName = await installSchema(caller)
  let ledger: unknown
  try {
    ledger = await caller.query(
      `SELECT 1 AS present FROM ${qualified(schemaName, 'kysely_migration')} WHERE name = $1 LIMIT 1`,
      [STRICT_LOGIN_GRANT_MIGRATION_NAME],
    )
  } catch (error) {
    throw new StrictLoginGrantError('STRICT_LOGIN_GRANT_INSTALLATION_REFUSED', pgDetail(error))
  }
  let present = 0
  let named = 0
  try {
    const census = await installationCensus(caller, schemaName)
    present = census.present
    named = census.named
  } catch (error) {
    if (error instanceof StrictLoginGrantError) throw error
    throw new StrictLoginGrantError('STRICT_LOGIN_GRANT_INSTALLATION_REFUSED', pgDetail(error))
  }
  const recorded = rowsOf(ledger).length > 0
  if (!recorded && present === 0 && named === 0) return { installation: 'never-installed', schemaName }
  if (recorded && present === CENSUS_EXPECTED && named === STRICT_LOGIN_GRANT_TABLES.length) return { installation: 'installed', schemaName }
  refuse('STRICT_LOGIN_GRANT_INSTALLATION_REFUSED')
}

export async function readStrictLoginInstallation(caller: StrictLoginGrantCaller): Promise<StrictLoginInstallation> {
  const { installation } = await readInstallationWithSchema(caller)
  return { installation }
}

async function requireInstalled(caller: StrictLoginGrantCaller): Promise<string> {
  const installation = await readInstallationWithSchema(caller)
  if (installation.installation !== 'installed') refuse('STRICT_LOGIN_GRANT_INSTALLATION_REFUSED')
  return installation.schemaName
}

function scopeRow(row: Record<string, unknown>): StrictLoginScopeRow {
  const connectionId = textAt(row, 'connection_id')
  const commandId = textAt(row, 'command_id')
  const transitionedAt = textAt(row, 'transitioned_at')
  if (!UUID_TEXT.test(connectionId) || commandId.trim() !== commandId || commandId.length === 0) {
    refuse('STRICT_LOGIN_GRANT_INSTALLATION_REFUSED')
  }
  return { connectionId, commandId, transitionedAt }
}

export async function readConnectionLoginScope(
  caller: StrictLoginGrantCaller,
  connectionId: string,
): Promise<StrictLoginScopeRead> {
  const installation = await readInstallationWithSchema(caller)
  if (installation.installation === 'never-installed') return { installation: 'never-installed', scope: null }
  const schemaName = installation.schemaName
  const id = uuidText(connectionId)
  const locked = await queryRows(
    caller,
    `SELECT id::text AS id FROM ${qualified(schemaName, 'directory_integrations')} WHERE id = $1::uuid FOR SHARE`,
    [id],
  )
  if (locked.length !== 1) refuse('STRICT_LOGIN_GRANT_INPUT_REFUSED')
  const scope = await queryRows(
    caller,
    `SELECT connection_id::text AS connection_id, command_id,
            pg_catalog.to_char(transitioned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS transitioned_at
       FROM ${qualified(schemaName, STRICT_LOGIN_GRANT_SCOPE_TABLE)}
      WHERE connection_id = $1::uuid`,
    [id],
  )
  if (scope.length === 0) return { installation: 'installed', scope: null }
  if (scope.length !== 1) refuse('STRICT_LOGIN_GRANT_INSTALLATION_REFUSED')
  return { installation: 'installed', scope: scopeRow(scope[0]) }
}

/** Current-method eligibility only; this read does not fence a new grant or session. */
export async function readCurrentConnectionLoginScope(
  caller: StrictLoginGrantCaller,
  connectionId: string,
): Promise<StrictLoginScopeRead> {
  const installation = await readInstallationWithSchema(caller)
  if (installation.installation === 'never-installed') return { installation: 'never-installed', scope: null }
  const schemaName = installation.schemaName
  const rows = await queryRows(
    caller,
    `SELECT integration.id::text AS id, scope.connection_id::text AS connection_id, scope.command_id,
            pg_catalog.to_char(scope.transitioned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS transitioned_at
       FROM ${qualified(schemaName, 'directory_integrations')} integration
       LEFT JOIN ${qualified(schemaName, STRICT_LOGIN_GRANT_SCOPE_TABLE)} scope ON scope.connection_id = integration.id
      WHERE integration.id = $1::uuid`,
    [uuidText(connectionId)],
  )
  if (rows.length !== 1) refuse('STRICT_LOGIN_GRANT_INPUT_REFUSED')
  return { installation: 'installed', scope: rows[0].connection_id === null ? null : scopeRow(rows[0]) }
}

export async function insertConnectionLoginScope(
  caller: StrictLoginGrantCaller,
  input: { readonly connectionId: string; readonly commandId: string },
): Promise<StrictLoginScopeRow> {
  const schemaName = await requireInstalled(caller)
  const connectionId = uuidText(input.connectionId)
  const commandId = opaque(input.commandId)
  const locked = await queryRows(
    caller,
    `SELECT id::text AS id FROM ${qualified(schemaName, 'directory_integrations')} WHERE id = $1::uuid FOR UPDATE`,
    [connectionId],
  )
  if (locked.length !== 1) refuse('STRICT_LOGIN_GRANT_INPUT_REFUSED')
  const existing = await queryRows(
    caller,
    `SELECT 1 AS present FROM ${qualified(schemaName, STRICT_LOGIN_GRANT_SCOPE_TABLE)} WHERE connection_id = $1::uuid`,
    [connectionId],
  )
  if (existing.length > 0) refuse('STRICT_LOGIN_GRANT_SCOPE_PRESENT')
  const inserted = await queryRows(
    caller,
    `INSERT INTO ${qualified(schemaName, STRICT_LOGIN_GRANT_SCOPE_TABLE)} (connection_id, command_id)
     VALUES ($1::uuid, $2)
     RETURNING connection_id::text AS connection_id, command_id,
               pg_catalog.to_char(transitioned_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS transitioned_at`,
    [connectionId, commandId],
  )
  if (inserted.length !== 1) refuse('STRICT_LOGIN_GRANT_INPUT_REFUSED')
  return scopeRow(inserted[0])
}

function revokeFields(input: StrictLoginGrantRevokeInput): {
  reason: StrictLoginGrantRevokeReason
  revokedBy: string
  revokedEventId: string | null
  revokedRunId: string | null
  revokedAccountId: string | null
  revokedOrgId: string | null
} {
  if (!STRICT_LOGIN_GRANT_REVOKE_REASONS.includes(input.reason)) refuse('STRICT_LOGIN_GRANT_INPUT_REFUSED')
  const revokedEventId = input.revokedEventId == null ? null : uuidText(input.revokedEventId)
  const revokedRunId = input.revokedRunId == null ? null : uuidText(input.revokedRunId)
  if (input.reason === 'deprovision' && revokedEventId === null && revokedRunId === null) {
    refuse('STRICT_LOGIN_GRANT_INPUT_REFUSED')
  }
  return {
    reason: input.reason,
    revokedBy: opaque(input.revokedBy),
    revokedEventId,
    revokedRunId,
    revokedAccountId: input.revokedAccountId == null ? null : opaque(input.revokedAccountId),
    revokedOrgId: input.revokedOrgId == null ? null : opaque(input.revokedOrgId),
  }
}

async function selectGrantIds(caller: StrictLoginGrantCaller, schemaName: string, whereSql: string, params: readonly unknown[]): Promise<string[]> {
  const rows = await queryRows(
    caller,
    `SELECT id FROM ${qualified(schemaName, STRICT_LOGIN_GRANT_GRANT_TABLE)} WHERE revoked_at IS NULL AND (${whereSql})`,
    params,
  )
  return rows.map((row) => textAt(row, 'id')).sort(byCodeUnit)
}

async function lockIds(
  caller: StrictLoginGrantCaller,
  schemaName: string,
  table: string,
  ids: readonly string[],
  code: StrictLoginGrantCode,
): Promise<void> {
  for (const id of ids) {
    const locked = await queryRows(
      caller,
      `SELECT id FROM ${qualified(schemaName, table)} WHERE id = $1 FOR UPDATE`,
      [id],
    )
    if (locked.length !== 1 || textAt(locked[0], 'id') !== id) throw new StrictLoginGrantError(code)
  }
}

async function revokeLocked(
  caller: StrictLoginGrantCaller,
  schemaName: string,
  ids: readonly string[],
  fields: ReturnType<typeof revokeFields>,
): Promise<readonly string[]> {
  const grants = qualified(schemaName, STRICT_LOGIN_GRANT_GRANT_TABLE)
  for (const id of ids) {
    const updated = await queryRows(
      caller,
      `UPDATE ${grants}
          SET enabled = FALSE,
              revocation_generation = revocation_generation + 1,
              live_identity_id = NULL,
              revoked_at = pg_catalog.clock_timestamp(),
              revoked_reason = $2,
              revoked_by = $3,
              revoked_event_id = $4::uuid,
              revoked_run_id = $5::uuid,
              revoked_account_id = $6,
              revoked_org_id = $7
        WHERE id = $1
          AND revoked_at IS NULL
        RETURNING id`,
      [id, fields.reason, fields.revokedBy, fields.revokedEventId, fields.revokedRunId, fields.revokedAccountId, fields.revokedOrgId],
    )
    if (updated.length !== 1) refuse('STRICT_LOGIN_GRANT_REVOKE_REFUSED')
  }
  return ids
}

async function revokeWhere(
  caller: StrictLoginGrantCaller,
  whereSql: string,
  params: readonly unknown[],
  input: StrictLoginGrantRevokeInput,
): Promise<StrictLoginGrantRevokeResult> {
  const schemaName = await requireInstalled(caller)
  const fields = revokeFields(input)
  const ids = await selectGrantIds(caller, schemaName, whereSql, params)
  await lockIds(caller, schemaName, STRICT_LOGIN_GRANT_GRANT_TABLE, ids, 'STRICT_LOGIN_GRANT_REVOKE_REFUSED')
  const again = await selectGrantIds(caller, schemaName, whereSql, params)
  if (!sameList(ids, again)) refuse('STRICT_LOGIN_GRANT_REVOKE_REFUSED')
  return { grantIds: await revokeLocked(caller, schemaName, ids, fields) }
}

export async function revokeForScope(
  caller: StrictLoginGrantCaller,
  connectionId: string,
  input: StrictLoginGrantRevokeInput,
): Promise<StrictLoginGrantRevokeResult> {
  const id = uuidText(connectionId)
  return revokeWhere(caller, 'connection_id = $1::uuid', [id], input)
}

/** Revoke only the already locked user's grants on the departed connection. */
export async function revokeForUserInScope(
  caller: StrictLoginGrantCaller,
  connectionId: string,
  userId: string,
  input: StrictLoginGrantRevokeInput,
): Promise<StrictLoginGrantRevokeResult> {
  return revokeWhere(
    caller,
    'connection_id = $1::uuid AND local_user_id = $2::text',
    [uuidText(connectionId), opaque(userId)],
    input,
  )
}

export async function revokeForIdentity(
  caller: StrictLoginGrantCaller,
  identityIds: readonly string[],
  input: StrictLoginGrantRevokeInput,
): Promise<StrictLoginGrantRevokeResult> {
  const ids = uniqueSorted(identityIds.map((identityId) => uuidText(identityId)), 'STRICT_LOGIN_GRANT_INPUT_REFUSED')
  if (ids.length === 0) {
    await requireInstalled(caller)
    return { grantIds: [] }
  }
  return revokeWhere(
    caller,
    'identity_id = ANY($1::text[]) OR live_identity_id::text = ANY($1::text[])',
    [ids],
    input,
  )
}

export async function detachEvidenceForIdentities(
  caller: StrictLoginGrantCaller,
  identityIds: readonly string[],
): Promise<{ readonly evidenceIds: readonly string[] }> {
  const schemaName = await requireInstalled(caller)
  const ids = uniqueSorted(identityIds.map((identityId) => uuidText(identityId)), 'STRICT_LOGIN_GRANT_INPUT_REFUSED')
  if (ids.length === 0) return { evidenceIds: [] }
  const evidence = qualified(schemaName, 'user_external_identity_evidence')
  const selectIds = async (): Promise<string[]> => {
    const rows = await queryRows(
      caller,
      `SELECT id
         FROM ${evidence}
        WHERE revoked_at IS NULL
          AND (identity_id = ANY($1::text[]) OR live_identity_id::text = ANY($1::text[]))`,
      [ids],
    )
    return rows.map((row) => textAt(row, 'id')).sort(byCodeUnit)
  }
  const evidenceIds = await selectIds()
  await lockIds(caller, schemaName, 'user_external_identity_evidence', evidenceIds, 'STRICT_LOGIN_GRANT_DETACH_REFUSED')
  const again = await selectIds()
  if (!sameList(evidenceIds, again)) refuse('STRICT_LOGIN_GRANT_DETACH_REFUSED')
  for (const evidenceId of evidenceIds) {
    const updated = await queryRows(
      caller,
      `UPDATE ${evidence}
          SET revocation_generation = revocation_generation + 1,
              live_identity_id = NULL
        WHERE id = $1
          AND revoked_at IS NULL
        RETURNING id`,
      [evidenceId],
    )
    if (updated.length !== 1) refuse('STRICT_LOGIN_GRANT_DETACH_REFUSED')
  }
  return { evidenceIds }
}

export function commandKeyFor(actorId: string, orgId: string, commandId: string): string {
  return adminGrantCommandKey(actorId, orgId, commandId)
}

export function grantIdFor(commandKey: string, ordinal: number, userId: string): string {
  if (!HEX_64.test(commandKey) || !Number.isInteger(ordinal) || ordinal < 1 || opaque(userId) !== userId) {
    refuse('STRICT_LOGIN_GRANT_INPUT_REFUSED')
  }
  const digest = createHash('sha256')
    .update(STRICT_LOGIN_GRANT_ID_DOMAIN, 'utf8')
    .update(JSON.stringify([commandKey, ordinal, userId]), 'utf8')
    .digest('hex')
  return `slg.${digest}`
}

export function grantIdsFor(commandKey: string, userIds: readonly string[]): readonly StrictLoginGrantBundleGrant[] {
  const sorted = uniqueSorted(userIds.map((userId) => opaque(userId)), 'STRICT_LOGIN_GRANT_INPUT_REFUSED')
  if (!sameList(sorted, userIds) || sorted.length === 0) refuse('STRICT_LOGIN_GRANT_INPUT_REFUSED')
  return sorted.map((userId, index) => ({
    ordinal: index + 1,
    userId,
    grantId: grantIdFor(commandKey, index + 1, userId),
  }))
}

function contextString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.includes('\u0000') || hasUnpairedSurrogate(value)) {
    refuse('STRICT_LOGIN_GRANT_INPUT_REFUSED')
  }
  return value
}

export function parseStrictSessionContext(value: unknown): StrictSessionContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) refuse('STRICT_LOGIN_GRANT_INPUT_REFUSED')
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort(byCodeUnit)
  if (!sameList(keys, STRICT_LOGIN_GRANT_CONTEXT_KEYS)) refuse('STRICT_LOGIN_GRANT_INPUT_REFUSED')
  if (record.v !== 1 || record.provider !== 'dingtalk' || record.assurance !== 'self_authenticated' || record.scopeAsserted !== false) {
    refuse('STRICT_LOGIN_GRANT_INPUT_REFUSED')
  }
  if (typeof record.policyRevision !== 'number' || !Number.isInteger(record.policyRevision) || record.policyRevision < 0 || !INTEGER.test(String(record.policyRevision))) {
    refuse('STRICT_LOGIN_GRANT_INPUT_REFUSED')
  }
  const bindingRevision = contextString(record, 'bindingRevision')
  const applicationRevision = contextString(record, 'applicationRevision')
  const accessGeneration = contextString(record, 'accessGeneration')
  if (!DECIMAL.test(bindingRevision) || !DECIMAL.test(applicationRevision) || !DECIMAL.test(accessGeneration)) {
    refuse('STRICT_LOGIN_GRANT_INPUT_REFUSED')
  }
  const grantId = contextString(record, 'grantId')
  if (!GRANT_ID.test(grantId)) refuse('STRICT_LOGIN_GRANT_INPUT_REFUSED')
  const parsed: StrictSessionContext = {
    v: 1,
    provider: 'dingtalk',
    connectionId: uuidText(contextString(record, 'connectionId')),
    identityId: uuidText(contextString(record, 'identityId')),
    grantId,
    evidenceId: contextString(record, 'evidenceId'),
    orgId: contextString(record, 'orgId'),
    subjectAppScope: contextString(record, 'subjectAppScope'),
    subjectKey: contextString(record, 'subjectKey'),
    bindingRevision,
    applicationRevision,
    accessGeneration,
    capRev: contextString(record, 'capRev'),
    assurance: 'self_authenticated',
    policyRevision: record.policyRevision,
    scopeAsserted: false,
  }
  return Object.freeze(parsed)
}

async function collectUsers(caller: StrictLoginGrantCaller, schemaName: string, grantIds: readonly string[]): Promise<string[]> {
  const rows = await queryRows(
    caller,
    `SELECT DISTINCT user_id
       FROM ${qualified(schemaName, 'user_sessions')}
      WHERE id LIKE 'xs.%'
        AND ${STRICT_LOGIN_GRANT_SESSION_CONTEXT_COLUMN}->>'grantId' = ANY($1::text[])`,
    [grantIds],
  )
  return uniqueSorted(rows.map((row) => opaque(textAt(row, 'user_id'))), 'STRICT_LOGIN_GRANT_WATERMARK_SET_UNSTABLE')
}

async function prelockUsers(caller: StrictLoginGrantCaller, schemaName: string, userIds: readonly string[]): Promise<void> {
  const watermarks = qualified(schemaName, 'user_session_revocations')
  for (const userId of userIds) {
    await caller.query(
      `INSERT INTO ${watermarks} (user_id, revoked_after, updated_at, updated_by, reason)
       VALUES ($1, TIMESTAMPTZ '${STRICT_LOGIN_GRANT_WATERMARK_EPOCH}', pg_catalog.clock_timestamp(), NULL, NULL)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    )
    const locked = await queryRows(
      caller,
      `SELECT user_id FROM ${watermarks} WHERE user_id = $1 FOR UPDATE`,
      [userId],
    )
    if (locked.length !== 1) refuse('STRICT_LOGIN_GRANT_WATERMARK_SET_UNSTABLE')
  }
}

export async function collectStrictGrantSessionUsers(
  caller: StrictLoginGrantCaller,
  grantIds: readonly string[],
): Promise<readonly string[]> {
  const schemaName = await requireInstalled(caller)
  const ids = uniqueSorted(grantIds.map((grantId) => {
    if (!GRANT_ID.test(grantId)) refuse('STRICT_LOGIN_GRANT_INPUT_REFUSED')
    return grantId
  }), 'STRICT_LOGIN_GRANT_INPUT_REFUSED')
  if (ids.length === 0) return []
  return collectUsers(caller, schemaName, ids)
}

export async function prelockUserSessionWatermarks(
  caller: StrictLoginGrantCaller,
  userIds: readonly string[],
): Promise<void> {
  const schemaName = await requireInstalled(caller)
  const ids = uniqueSorted(userIds.map((userId) => opaque(userId)), 'STRICT_LOGIN_GRANT_INPUT_REFUSED')
  if (ids.length === 0) return
  await prelockUsers(caller, schemaName, ids)
}

async function sessionRows(
  caller: StrictLoginGrantCaller,
  schemaName: string,
  grantIds: readonly string[],
): Promise<Array<{ id: string; userId: string }>> {
  const rows = await queryRows(
    caller,
    `SELECT id, user_id
       FROM ${qualified(schemaName, 'user_sessions')}
      WHERE id LIKE 'xs.%'
        AND ${STRICT_LOGIN_GRANT_SESSION_CONTEXT_COLUMN}->>'grantId' = ANY($1::text[])`,
    [grantIds],
  )
  return rows.map((row) => ({ id: opaque(textAt(row, 'id')), userId: opaque(textAt(row, 'user_id')) }))
    .sort((left, right) => byCodeUnit(left.id, right.id))
}

async function advanceWatermarks(
  caller: StrictLoginGrantCaller,
  schemaName: string,
  userIds: readonly string[],
  updatedBy: string,
): Promise<void> {
  const watermarks = qualified(schemaName, 'user_session_revocations')
  for (const userId of userIds) {
    const updated = await queryRows(
      caller,
      `UPDATE ${watermarks}
          SET revoked_after = GREATEST(revoked_after, pg_catalog.clock_timestamp()),
              updated_at = pg_catalog.clock_timestamp(),
              updated_by = $2,
              reason = $3
        WHERE user_id = $1
        RETURNING user_id`,
      [userId, updatedBy, STRICT_GRANT_SESSION_REVOCATION_REASON],
    )
    if (updated.length !== 1) refuse('STRICT_LOGIN_GRANT_WATERMARK_SET_UNSTABLE')
  }
}

async function lockSessionIds(caller: StrictLoginGrantCaller, schemaName: string, sessionIds: readonly string[]): Promise<void> {
  const sessions = qualified(schemaName, 'user_sessions')
  for (const sessionId of sessionIds) {
    const locked = await queryRows(
      caller,
      `SELECT id FROM ${sessions} WHERE id = $1 FOR UPDATE`,
      [sessionId],
    )
    if (locked.length !== 1) refuse('STRICT_LOGIN_GRANT_SESSION_LOCK_REFUSED')
  }
}

export async function revokeSessionsForExactGrants(
  caller: StrictLoginGrantCaller,
  input: { readonly grantIds: readonly string[]; readonly updatedBy: string },
): Promise<StrictLoginGrantSessionRevocation> {
  const schemaName = await requireInstalled(caller)
  const grantIds = uniqueSorted(input.grantIds.map((grantId) => {
    if (!GRANT_ID.test(grantId)) refuse('STRICT_LOGIN_GRANT_INPUT_REFUSED')
    return grantId
  }), 'STRICT_LOGIN_GRANT_INPUT_REFUSED')
  const updatedBy = opaque(input.updatedBy)
  if (grantIds.length === 0) return { userIds: [], sessionIds: [] }
  let lockedUsers = await collectUsers(caller, schemaName, grantIds)
  await prelockUsers(caller, schemaName, lockedUsers)
  let seen = await collectUsers(caller, schemaName, grantIds)
  if (!extendsPrefix(lockedUsers, seen)) refuse('STRICT_LOGIN_GRANT_WATERMARK_SET_UNSTABLE')
  if (seen.length !== lockedUsers.length) {
    await prelockUsers(caller, schemaName, seen.slice(lockedUsers.length))
    lockedUsers = seen
    seen = await collectUsers(caller, schemaName, grantIds)
    if (!sameList(lockedUsers, seen)) refuse('STRICT_LOGIN_GRANT_WATERMARK_SET_UNSTABLE')
  }
  await advanceWatermarks(caller, schemaName, lockedUsers, updatedBy)
  const userSet = new Set(lockedUsers)
  const first = await sessionRows(caller, schemaName, grantIds)
  if (first.some((session) => !userSet.has(session.userId))) refuse('STRICT_LOGIN_GRANT_SESSION_LOCK_REFUSED')
  const firstIds = first.map((session) => session.id)
  await lockSessionIds(caller, schemaName, firstIds)
  const second = await sessionRows(caller, schemaName, grantIds)
  const secondIds = second.map((session) => session.id)
  if (second.some((session) => !userSet.has(session.userId)) || !extendsPrefix(firstIds, secondIds)) {
    refuse('STRICT_LOGIN_GRANT_SESSION_LOCK_REFUSED')
  }
  if (secondIds.length !== firstIds.length) {
    await lockSessionIds(caller, schemaName, secondIds.slice(firstIds.length))
    const third = await sessionRows(caller, schemaName, grantIds)
    if (!sameList(secondIds, third.map((session) => session.id))) refuse('STRICT_LOGIN_GRANT_SESSION_LOCK_REFUSED')
  }
  const sessions = qualified(schemaName, 'user_sessions')
  for (const sessionId of secondIds) {
    const updated = await queryRows(
      caller,
      `UPDATE ${sessions}
          SET revoked_at = pg_catalog.clock_timestamp(),
              revoked_by = $2,
              revoke_reason = $3,
              updated_at = pg_catalog.clock_timestamp()
        WHERE id = $1
          AND revoked_at IS NULL
        RETURNING id`,
      [sessionId, updatedBy, STRICT_GRANT_SESSION_REVOCATION_REASON],
    )
    if (updated.length === 1) continue
    const still = await queryRows(
      caller,
      `SELECT id FROM ${sessions} WHERE id = $1 AND revoked_at IS NOT NULL`,
      [sessionId],
    )
    if (still.length !== 1) refuse('STRICT_LOGIN_GRANT_SESSION_LOCK_REFUSED')
  }
  return { userIds: lockedUsers, sessionIds: secondIds }
}

// Read-only installation and pure SQL/value support for the cold bundle writer.
// The proof service and the receipt/grant write entry remain outside this hot store.
export {
  opaque as strictLoginGrantOpaque,
  pgDetail as strictLoginGrantPgDetail,
  qualified as strictLoginGrantQualified,
  rowsOf as strictLoginGrantRows,
  textAt as strictLoginGrantText,
  requireInstalled as requireStrictLoginGrantInstallation,
}
