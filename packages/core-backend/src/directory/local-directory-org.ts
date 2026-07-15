/**
 * Canonical Org MVP — B2 (local departments/accounts/memberships CRUD), MVP sequencing plan §1
 * row B2, design lock §5.2-5.4 (`local-directory-provider-canonical-org-anchor-development-plan-
 * 20260709.md`).
 *
 * CRUD for `directory_departments` / `directory_accounts` / `directory_account_departments` rows
 * under the ONE `provider='local'` integration a B1 `getOrCreateLocalIntegration(orgId)` call
 * anchors (imported, not reimplemented — `directory-sync.ts` is edited nowhere by this file).
 *
 * Owner design fixes this module honors (do NOT reintroduce what they ruled out):
 *   - a local department's manager/head is NEVER written into `raw` here — `raw` on a local
 *     department/account carries provenance only (`{source:'local', ...}`); the normalized
 *     manager relation is B3's scope, not this file's.
 *   - archive-not-delete: departments and accounts are deactivated (`is_active=false`), never
 *     `DELETE`d, so history is preserved. Archiving an already-archived row is a no-op success.
 *   - `is_primary` on a membership is always an EXPLICIT write (`addLocalMembership` /
 *     `switchLocalPrimaryDepartment`), never inferred from array order.
 *   - a local account is linked to its platform user via `directory_account_links` only — no
 *     `user_external_identities` row is ever written for `provider='local'` (local users
 *     authenticate through the normal local login/session path).
 *
 * Every exported function takes `orgId` as an explicit, required parameter supplied by the
 * caller (the route layer resolves it from server-side context, never from a request body) —
 * this module does not default it, so a caller cannot accidentally fall through to some
 * ambient org.
 */

import * as crypto from 'crypto'
import { query, transaction } from '../db/pg'
import { getOrCreateLocalIntegration } from './directory-sync'

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim()
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
}

export class LocalDirectoryValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocalDirectoryValidationError'
  }
}

export class LocalDirectoryNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocalDirectoryNotFoundError'
  }
}

export class LocalDirectoryConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocalDirectoryConflictError'
  }
}

const MAX_NAME_LENGTH = 200

// ---------------------------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------------------------

export interface LocalDepartmentSummary {
  id: string
  integrationId: string
  externalDepartmentId: string
  /** The PARENT department's `directory_departments.id` (resolved from its external key), or null for a root department. */
  parentDepartmentId: string | null
  name: string
  orderIndex: number
  isActive: boolean
  createdAt: string
  updatedAt: string
}

interface LocalDepartmentRow {
  id: string
  integration_id: string
  external_department_id: string
  external_parent_department_id: string | null
  name: string
  order_index: number
  is_active: boolean
  created_at: string
  updated_at: string
  parent_id: string | null
}

// Resolves the parent's `id` (not just its key) via a self-join on the department's own key
// space — `directory_departments` stores `external_parent_department_id` as the PARENT's
// `external_department_id`, matching the DingTalk-sync convention (see directory-sync.ts /
// admin-users.ts department-tree queries), not the parent row's uuid PK.
const LOCAL_DEPARTMENT_SELECT = `
  SELECT d.id, d.integration_id, d.external_department_id, d.external_parent_department_id,
         d.name, d.order_index, d.is_active, d.created_at, d.updated_at, p.id AS parent_id
    FROM directory_departments d
    LEFT JOIN directory_departments p
      ON p.integration_id = d.integration_id AND p.external_department_id = d.external_parent_department_id
`

async function loadLocalDepartmentForOrg(orgId: string, departmentId: string): Promise<LocalDepartmentRow | null> {
  const integration = await getOrCreateLocalIntegration(orgId)
  const result = await query<LocalDepartmentRow>(
    `${LOCAL_DEPARTMENT_SELECT} WHERE d.id = $1 AND d.integration_id = $2 AND d.provider = 'local'`,
    [departmentId, integration.id],
  )
  return result.rows[0] ?? null
}

function summarizeLocalDepartment(row: LocalDepartmentRow): LocalDepartmentSummary {
  return {
    id: row.id,
    integrationId: row.integration_id,
    externalDepartmentId: row.external_department_id,
    parentDepartmentId: row.parent_id ?? null,
    name: row.name,
    orderIndex: row.order_index,
    isActive: row.is_active,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

export interface CreateLocalDepartmentInput {
  orgId: string
  name: string
  parentDepartmentId?: string | null
  orderIndex?: number
}

export async function createLocalDepartment(input: CreateLocalDepartmentInput): Promise<LocalDepartmentSummary> {
  const name = normalizeText(input.name)
  if (!name) throw new LocalDirectoryValidationError('name is required')
  if (name.length > MAX_NAME_LENGTH) throw new LocalDirectoryValidationError(`name must be at most ${MAX_NAME_LENGTH} characters`)

  const integration = await getOrCreateLocalIntegration(input.orgId)

  let parentExternalDepartmentId: string | null = null
  if (input.parentDepartmentId) {
    const parent = await loadLocalDepartmentForOrg(input.orgId, input.parentDepartmentId)
    if (!parent) throw new LocalDirectoryNotFoundError('parent department not found')
    parentExternalDepartmentId = parent.external_department_id
  }

  const orderIndex = Number.isFinite(input.orderIndex) ? Math.trunc(input.orderIndex as number) : 0
  // App-generated, immutable key — design lock §5.2: "the value should be immutable and
  // generated by the app, for example local:<uuid>".
  const externalDepartmentId = `local:${crypto.randomUUID()}`

  const inserted = await query<{ id: string }>(
    `INSERT INTO directory_departments (
       integration_id, provider, external_department_id, external_parent_department_id,
       name, order_index, is_active, raw, last_seen_at, created_at, updated_at
     )
     VALUES ($1, 'local', $2, $3, $4, $5, true, $6::jsonb, NOW(), NOW(), NOW())
     RETURNING id`,
    [
      integration.id,
      externalDepartmentId,
      parentExternalDepartmentId,
      name,
      orderIndex,
      // Provenance ONLY — manager is NEVER stored here (design lock §5.2 owner fix).
      JSON.stringify({ source: 'local', metadata: {} }),
    ],
  )

  const created = await loadLocalDepartmentForOrg(input.orgId, inserted.rows[0].id)
  if (!created) throw new Error('local department created but reload failed')
  return summarizeLocalDepartment(created)
}

export interface UpdateLocalDepartmentInput {
  name?: string
  /** `undefined` = leave unchanged; `null` = clear (make root); a string = reparent. */
  parentDepartmentId?: string | null
  orderIndex?: number
}

export async function updateLocalDepartment(
  orgId: string,
  departmentId: string,
  input: UpdateLocalDepartmentInput,
): Promise<LocalDepartmentSummary | null> {
  const current = await loadLocalDepartmentForOrg(orgId, departmentId)
  if (!current) return null

  const nextName = input.name !== undefined ? normalizeText(input.name) : current.name
  if (input.name !== undefined && !nextName) throw new LocalDirectoryValidationError('name is required')
  if (nextName.length > MAX_NAME_LENGTH) throw new LocalDirectoryValidationError(`name must be at most ${MAX_NAME_LENGTH} characters`)

  let nextParentExternalId = current.external_parent_department_id
  if (input.parentDepartmentId !== undefined) {
    if (input.parentDepartmentId === null) {
      nextParentExternalId = null
    } else {
      if (input.parentDepartmentId === departmentId) {
        throw new LocalDirectoryValidationError('a department cannot be its own parent')
      }
      const parent = await loadLocalDepartmentForOrg(orgId, input.parentDepartmentId)
      if (!parent) throw new LocalDirectoryNotFoundError('parent department not found')
      nextParentExternalId = parent.external_department_id
    }
  }

  const nextOrderIndex = Number.isFinite(input.orderIndex) ? Math.trunc(input.orderIndex as number) : current.order_index

  await query(
    `UPDATE directory_departments
        SET name = $1, external_parent_department_id = $2, order_index = $3, updated_at = NOW()
      WHERE id = $4`,
    [nextName, nextParentExternalId, nextOrderIndex, departmentId],
  )

  const updated = await loadLocalDepartmentForOrg(orgId, departmentId)
  if (!updated) throw new Error('local department updated but reload failed')
  return summarizeLocalDepartment(updated)
}

/**
 * Archive-not-delete (design lock §12 safety invariant / this plan's SCOPE): flips `is_active`
 * to false and returns the row unchanged otherwise. Never issues a `DELETE`. Idempotent — an
 * already-archived department archives again as a no-op success (there is no "already deleted"
 * failure mode to guard against).
 */
export async function archiveLocalDepartment(orgId: string, departmentId: string): Promise<LocalDepartmentSummary | null> {
  const current = await loadLocalDepartmentForOrg(orgId, departmentId)
  if (!current) return null

  if (current.is_active) {
    await query(`UPDATE directory_departments SET is_active = false, updated_at = NOW() WHERE id = $1`, [departmentId])
  }

  const updated = await loadLocalDepartmentForOrg(orgId, departmentId)
  if (!updated) throw new Error('local department archived but reload failed')
  return summarizeLocalDepartment(updated)
}

// ---------------------------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------------------------

export interface LocalAccountSummary {
  id: string
  integrationId: string
  externalUserId: string
  externalKey: string
  name: string
  email: string | null
  mobile: string | null
  title: string | null
  isActive: boolean
  localUserId: string | null
  createdAt: string
  updatedAt: string
}

interface LocalAccountRow {
  id: string
  integration_id: string
  external_user_id: string
  external_key: string
  name: string
  email: string | null
  mobile: string | null
  title: string | null
  is_active: boolean
  created_at: string
  updated_at: string
  local_user_id: string | null
}

const LOCAL_ACCOUNT_SELECT = `
  SELECT a.id, a.integration_id, a.external_user_id, a.external_key, a.name, a.email, a.mobile,
         a.title, a.is_active, a.created_at, a.updated_at, l.local_user_id
    FROM directory_accounts a
    LEFT JOIN directory_account_links l ON l.directory_account_id = a.id
`

async function loadLocalAccountForOrg(orgId: string, accountId: string): Promise<LocalAccountRow | null> {
  const integration = await getOrCreateLocalIntegration(orgId)
  const result = await query<LocalAccountRow>(
    `${LOCAL_ACCOUNT_SELECT} WHERE a.id = $1 AND a.integration_id = $2 AND a.provider = 'local'`,
    [accountId, integration.id],
  )
  return result.rows[0] ?? null
}

function summarizeLocalAccount(row: LocalAccountRow): LocalAccountSummary {
  return {
    id: row.id,
    integrationId: row.integration_id,
    externalUserId: row.external_user_id,
    externalKey: row.external_key,
    name: row.name,
    email: row.email,
    mobile: row.mobile,
    title: row.title,
    isActive: row.is_active,
    localUserId: row.local_user_id ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

export interface CreateLocalAccountInput {
  orgId: string
  /** An EXISTING platform `users.id` — a local account always links to a real platform user. */
  localUserId: string
  name?: string
  email?: string | null
  mobile?: string | null
  title?: string | null
}

/**
 * Creates a `provider='local'` account row bound to an existing platform user, and links it via
 * `directory_account_links` — never `user_external_identities` (design lock §5.3: local users
 * authenticate through the normal local login/session path, not an external-identity bind).
 *
 * `external_key = '<org_id>:<local_user_id>'` (design lock §5.3), so the same platform user can
 * hold one local directory account per org without colliding on the `(provider, external_key)`
 * unique index.
 */
export async function createLocalAccount(input: CreateLocalAccountInput): Promise<LocalAccountSummary> {
  const localUserId = normalizeText(input.localUserId)
  if (!localUserId) throw new LocalDirectoryValidationError('localUserId is required')

  const integration = await getOrCreateLocalIntegration(input.orgId)

  const userRow = await query<{ id: string; name: string | null; email: string | null }>(
    `SELECT id, name, email FROM users WHERE id = $1`,
    [localUserId],
  )
  const user = userRow.rows[0]
  if (!user) throw new LocalDirectoryNotFoundError('local user not found')

  const name = normalizeText(input.name) || normalizeText(user.name) || normalizeText(user.email) || localUserId
  if (name.length > MAX_NAME_LENGTH) throw new LocalDirectoryValidationError(`name must be at most ${MAX_NAME_LENGTH} characters`)
  const email = input.email !== undefined ? normalizeText(input.email) || null : user.email ?? null
  const mobile = input.mobile !== undefined ? normalizeText(input.mobile) || null : null
  const title = input.title !== undefined ? normalizeText(input.title) || null : null

  const externalUserId = localUserId
  const externalKey = `${input.orgId}:${localUserId}`

  let accountId = ''
  try {
    await transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO directory_accounts (
           integration_id, provider, corp_id, external_user_id, external_key, name, email, mobile,
           title, is_active, raw, last_seen_at, created_at, updated_at
         )
         VALUES ($1, 'local', NULL, $2, $3, $4, $5, $6, $7, true, $8::jsonb, NOW(), NOW(), NOW())
         RETURNING id`,
        [
          integration.id,
          externalUserId,
          externalKey,
          name,
          email,
          mobile,
          title,
          // Provenance ONLY — NO leader_in_dept here (design lock §5.3 owner fix).
          JSON.stringify({ source: 'local', localUserId }),
        ],
      )
      accountId = (inserted.rows[0] as { id: string }).id

      // Same ON CONFLICT (directory_account_id) DO UPDATE shape directory-sync.ts's own
      // admission/link paths use (see e.g. syncDirectoryIntegration's link upsert).
      await client.query(
        `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status, match_strategy, created_at, updated_at)
         VALUES ($1, $2, 'linked', 'local_explicit', NOW(), NOW())
         ON CONFLICT (directory_account_id) DO UPDATE SET
           local_user_id = EXCLUDED.local_user_id,
           link_status = EXCLUDED.link_status,
           match_strategy = EXCLUDED.match_strategy,
           updated_at = NOW()`,
        [accountId, localUserId],
      )
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new LocalDirectoryConflictError('a local directory account already exists for this user in this org')
    }
    throw error
  }

  const created = await loadLocalAccountForOrg(input.orgId, accountId)
  if (!created) throw new Error('local account created but reload failed')
  return summarizeLocalAccount(created)
}

export interface UpdateLocalAccountInput {
  name?: string
  email?: string | null
  mobile?: string | null
  title?: string | null
}

export async function updateLocalAccount(
  orgId: string,
  accountId: string,
  input: UpdateLocalAccountInput,
): Promise<LocalAccountSummary | null> {
  const current = await loadLocalAccountForOrg(orgId, accountId)
  if (!current) return null

  const nextName = input.name !== undefined ? normalizeText(input.name) : current.name
  if (input.name !== undefined && !nextName) throw new LocalDirectoryValidationError('name is required')
  if (nextName.length > MAX_NAME_LENGTH) throw new LocalDirectoryValidationError(`name must be at most ${MAX_NAME_LENGTH} characters`)
  const nextEmail = input.email !== undefined ? normalizeText(input.email) || null : current.email
  const nextMobile = input.mobile !== undefined ? normalizeText(input.mobile) || null : current.mobile
  const nextTitle = input.title !== undefined ? normalizeText(input.title) || null : current.title

  await query(
    `UPDATE directory_accounts SET name = $1, email = $2, mobile = $3, title = $4, updated_at = NOW() WHERE id = $5`,
    [nextName, nextEmail, nextMobile, nextTitle, accountId],
  )

  const updated = await loadLocalAccountForOrg(orgId, accountId)
  if (!updated) throw new Error('local account updated but reload failed')
  return summarizeLocalAccount(updated)
}

/** Archive-not-delete, same semantics as `archiveLocalDepartment`. Keeps `directory_account_links` intact. */
export async function archiveLocalAccount(orgId: string, accountId: string): Promise<LocalAccountSummary | null> {
  const current = await loadLocalAccountForOrg(orgId, accountId)
  if (!current) return null

  if (current.is_active) {
    await query(`UPDATE directory_accounts SET is_active = false, updated_at = NOW() WHERE id = $1`, [accountId])
  }

  const updated = await loadLocalAccountForOrg(orgId, accountId)
  if (!updated) throw new Error('local account archived but reload failed')
  return summarizeLocalAccount(updated)
}

// ---------------------------------------------------------------------------------------------
// Memberships
// ---------------------------------------------------------------------------------------------

export interface LocalMembershipSummary {
  accountId: string
  departmentId: string
  isPrimary: boolean
  createdAt: string
}

interface LocalMembershipRow {
  directory_account_id: string
  directory_department_id: string
  is_primary: boolean
  created_at: string
}

function summarizeLocalMembership(row: LocalMembershipRow): LocalMembershipSummary {
  return {
    accountId: row.directory_account_id,
    departmentId: row.directory_department_id,
    isPrimary: row.is_primary,
    createdAt: new Date(row.created_at).toISOString(),
  }
}

/** Both the account and the department must belong to THIS org's local integration — no cross-org or cross-provider membership can be created. */
async function assertLocalMembershipTargets(orgId: string, accountId: string, departmentId: string): Promise<void> {
  const integration = await getOrCreateLocalIntegration(orgId)
  const check = await query<{ account_ok: boolean; department_ok: boolean }>(
    `SELECT
       EXISTS(SELECT 1 FROM directory_accounts WHERE id = $1 AND integration_id = $2 AND provider = 'local') AS account_ok,
       EXISTS(SELECT 1 FROM directory_departments WHERE id = $3 AND integration_id = $2 AND provider = 'local') AS department_ok`,
    [accountId, integration.id, departmentId],
  )
  const row = check.rows[0]
  if (!row?.account_ok) throw new LocalDirectoryNotFoundError('local account not found')
  if (!row?.department_ok) throw new LocalDirectoryNotFoundError('local department not found')
}

export interface AddLocalMembershipInput {
  orgId: string
  accountId: string
  departmentId: string
}

/**
 * Idempotent add: the SAME (account, department) pair inserted twice yields exactly one row
 * (`ON CONFLICT (directory_account_id, directory_department_id) DO NOTHING` — the table's
 * existing composite PK). A new row starts `is_primary=false`; use
 * `switchLocalPrimaryDepartment` to make a membership primary — that is a SEPARATE, explicit
 * operation on purpose (design lock §5.4: "primary department must be explicit, not inferred").
 */
export async function addLocalMembership(input: AddLocalMembershipInput): Promise<LocalMembershipSummary> {
  await assertLocalMembershipTargets(input.orgId, input.accountId, input.departmentId)

  const inserted = await query<LocalMembershipRow>(
    `INSERT INTO directory_account_departments (directory_account_id, directory_department_id, is_primary, created_at)
     VALUES ($1, $2, false, NOW())
     ON CONFLICT (directory_account_id, directory_department_id) DO NOTHING
     RETURNING directory_account_id, directory_department_id, is_primary, created_at`,
    [input.accountId, input.departmentId],
  )

  if (inserted.rows[0]) return summarizeLocalMembership(inserted.rows[0])

  // Already existed — idempotent re-add reads back the existing row unchanged.
  const existing = await query<LocalMembershipRow>(
    `SELECT directory_account_id, directory_department_id, is_primary, created_at
       FROM directory_account_departments
      WHERE directory_account_id = $1 AND directory_department_id = $2`,
    [input.accountId, input.departmentId],
  )
  if (!existing.rows[0]) throw new Error('membership add: row neither inserted nor found')
  return summarizeLocalMembership(existing.rows[0])
}

/**
 * The explicit primary-department switch (design lock §5.4). Requires the membership to already
 * exist (`addLocalMembership` first) — this function only ever moves the primary flag, it does
 * not create memberships. Demotes every OTHER membership for the account, then promotes this
 * one, inside one transaction, so at most one row is ever `is_primary=true` for a given account
 * at any point another reader can observe.
 */
export async function switchLocalPrimaryDepartment(
  orgId: string,
  accountId: string,
  departmentId: string,
): Promise<LocalMembershipSummary> {
  await assertLocalMembershipTargets(orgId, accountId, departmentId)

  const membershipExists = await query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM directory_account_departments
        WHERE directory_account_id = $1 AND directory_department_id = $2
     ) AS exists`,
    [accountId, departmentId],
  )
  if (!membershipExists.rows[0]?.exists) {
    throw new LocalDirectoryNotFoundError('membership not found; add the membership before setting it primary')
  }

  await transaction(async (client) => {
    await client.query(`UPDATE directory_account_departments SET is_primary = false WHERE directory_account_id = $1`, [accountId])
    await client.query(
      `UPDATE directory_account_departments SET is_primary = true WHERE directory_account_id = $1 AND directory_department_id = $2`,
      [accountId, departmentId],
    )
  })

  const result = await query<LocalMembershipRow>(
    `SELECT directory_account_id, directory_department_id, is_primary, created_at
       FROM directory_account_departments
      WHERE directory_account_id = $1 AND directory_department_id = $2`,
    [accountId, departmentId],
  )
  if (!result.rows[0]) throw new Error('membership primary switch: row not found after update')
  return summarizeLocalMembership(result.rows[0])
}
