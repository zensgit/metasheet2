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

  const orderIndex = Number.isFinite(input.orderIndex) ? Math.trunc(input.orderIndex as number) : 0
  // App-generated, immutable key — design lock §5.2: "the value should be immutable and
  // generated by the app, for example local:<uuid>".
  const externalDepartmentId = `local:${crypto.randomUUID()}`

  // PB4-2 (owner design lock, WRITE-POINT enforcement): the parent's archived/missing status is
  // classified inside the SAME transaction as the INSERT, under a `SELECT ... FOR UPDATE` row lock
  // on the parent — so a parent that is archived concurrently between check and insert cannot
  // slip a child under a read-only parent. A plain check-then-insert would be TOCTOU-vulnerable.
  return await transaction(async (client) => {
    let parentExternalDepartmentId: string | null = null
    if (input.parentDepartmentId) {
      const parentRes = await client.query(
        `SELECT external_department_id, is_active FROM directory_departments
          WHERE id = $1 AND integration_id = $2 AND provider = 'local'
          FOR UPDATE`,
        [input.parentDepartmentId, integration.id],
      )
      const parent = parentRes.rows[0] as { external_department_id: string; is_active: boolean } | undefined
      if (!parent) throw new LocalDirectoryNotFoundError('parent department not found')
      if (!parent.is_active) throw new LocalDirectoryConflictError('parent department is archived (read-only)')
      parentExternalDepartmentId = parent.external_department_id
    }

    const inserted = await client.query(
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

    const reloaded = await client.query(
      `${LOCAL_DEPARTMENT_SELECT} WHERE d.id = $1 AND d.integration_id = $2 AND d.provider = 'local'`,
      [(inserted.rows[0] as { id: string }).id, integration.id],
    )
    const created = reloaded.rows[0] as LocalDepartmentRow | undefined
    if (!created) throw new Error('local department created but reload failed')
    return summarizeLocalDepartment(created)
  })
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
  // Pure input validation (no DB read needed) stays before the transaction: name-required /
  // name-length when a name is supplied, and the self-parent 400 (preserved from PB4-1).
  if (input.name !== undefined) {
    const candidate = normalizeText(input.name)
    if (!candidate) throw new LocalDirectoryValidationError('name is required')
    if (candidate.length > MAX_NAME_LENGTH) throw new LocalDirectoryValidationError(`name must be at most ${MAX_NAME_LENGTH} characters`)
  }
  if (input.parentDepartmentId !== undefined && input.parentDepartmentId !== null && input.parentDepartmentId === departmentId) {
    throw new LocalDirectoryValidationError('a department cannot be its own parent')
  }

  const integration = await getOrCreateLocalIntegration(orgId)
  const reparenting = input.parentDepartmentId !== undefined && input.parentDepartmentId !== null

  // PB4-2 (owner design lock, WRITE-POINT enforcement): the target department is locked
  // `FOR UPDATE` and classified active/archived/missing INSIDE the same transaction as the UPDATE,
  // so a concurrent archive cannot land between check and write. On a reparent we lock BOTH the
  // child and the new parent in one `WHERE id IN (...) ORDER BY id FOR UPDATE` statement — the
  // fixed `ORDER BY id` lock order (design lock §2) guarantees two concurrent department-locking
  // transactions never grab the same pair in opposite orders.
  // Precise shape of the locked SELECT below — exactly the columns it projects (gemini review:
  // casting a partial SELECT to the full LocalDepartmentRow would let a future access of an omitted
  // column, e.g. integration_id/created_at/parent_id, be a silent runtime undefined that still compiles).
  type LockedDepartmentRow = Pick<
    LocalDepartmentRow,
    'id' | 'external_department_id' | 'external_parent_department_id' | 'name' | 'order_index' | 'is_active'
  >
  const LOCKED_DEPARTMENT_COLUMNS = 'id, external_department_id, external_parent_department_id, name, order_index, is_active'

  return await transaction(async (client) => {
    const parentId = reparenting ? (input.parentDepartmentId as string) : null
    let childRow: LockedDepartmentRow | undefined
    let parentRow: LockedDepartmentRow | undefined

    if (reparenting) {
      const locked = await client.query(
        `SELECT ${LOCKED_DEPARTMENT_COLUMNS}
           FROM directory_departments
          WHERE id IN ($1, $2) AND integration_id = $3 AND provider = 'local'
          ORDER BY id
          FOR UPDATE`,
        [departmentId, parentId, integration.id],
      )
      const rows = locked.rows as LockedDepartmentRow[]
      childRow = rows.find((r) => r.id === departmentId)
      parentRow = rows.find((r) => r.id === parentId)
    } else {
      const locked = await client.query(
        `SELECT ${LOCKED_DEPARTMENT_COLUMNS}
           FROM directory_departments
          WHERE id = $1 AND integration_id = $2 AND provider = 'local'
          FOR UPDATE`,
        [departmentId, integration.id],
      )
      childRow = locked.rows[0] as LockedDepartmentRow | undefined
    }

    if (!childRow) return null
    if (!childRow.is_active) throw new LocalDirectoryConflictError('department is archived (read-only)')

    let nextParentExternalId: string | null = childRow.external_parent_department_id
    if (input.parentDepartmentId !== undefined) {
      if (input.parentDepartmentId === null) {
        nextParentExternalId = null
      } else {
        if (!parentRow) throw new LocalDirectoryNotFoundError('parent department not found')
        if (!parentRow.is_active) throw new LocalDirectoryConflictError('parent department is archived (read-only)')
        nextParentExternalId = parentRow.external_department_id
      }
    }

    const nextName = input.name !== undefined ? normalizeText(input.name) : childRow.name
    const nextOrderIndex = Number.isFinite(input.orderIndex) ? Math.trunc(input.orderIndex as number) : childRow.order_index

    await client.query(
      `UPDATE directory_departments
          SET name = $1, external_parent_department_id = $2, order_index = $3, updated_at = NOW()
        WHERE id = $4`,
      [nextName, nextParentExternalId, nextOrderIndex, departmentId],
    )

    const reloaded = await client.query(
      `${LOCAL_DEPARTMENT_SELECT} WHERE d.id = $1 AND d.integration_id = $2 AND d.provider = 'local'`,
      [departmentId, integration.id],
    )
    const updated = reloaded.rows[0] as LocalDepartmentRow | undefined
    if (!updated) throw new Error('local department updated but reload failed')
    return summarizeLocalDepartment(updated)
  })
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
  // Pure input validation (name-required / name-length when a name is supplied) stays before the
  // transaction — it needs no DB read.
  if (input.name !== undefined) {
    const candidate = normalizeText(input.name)
    if (!candidate) throw new LocalDirectoryValidationError('name is required')
    if (candidate.length > MAX_NAME_LENGTH) throw new LocalDirectoryValidationError(`name must be at most ${MAX_NAME_LENGTH} characters`)
  }

  const integration = await getOrCreateLocalIntegration(orgId)

  // PB4-2 (owner design lock, WRITE-POINT enforcement): lock the account row `FOR UPDATE` and
  // classify active/archived/missing in the SAME transaction as the UPDATE, so a concurrent
  // archive cannot land between check and write (TOCTOU-safe).
  return await transaction(async (client) => {
    const locked = await client.query(
      `SELECT id, name, email, mobile, title, is_active FROM directory_accounts
        WHERE id = $1 AND integration_id = $2 AND provider = 'local'
        FOR UPDATE`,
      [accountId, integration.id],
    )
    const current = locked.rows[0] as
      | { id: string; name: string; email: string | null; mobile: string | null; title: string | null; is_active: boolean }
      | undefined
    if (!current) return null
    if (!current.is_active) throw new LocalDirectoryConflictError('account is archived (read-only)')

    const nextName = input.name !== undefined ? normalizeText(input.name) : current.name
    const nextEmail = input.email !== undefined ? normalizeText(input.email) || null : current.email
    const nextMobile = input.mobile !== undefined ? normalizeText(input.mobile) || null : current.mobile
    const nextTitle = input.title !== undefined ? normalizeText(input.title) || null : current.title

    await client.query(
      `UPDATE directory_accounts SET name = $1, email = $2, mobile = $3, title = $4, updated_at = NOW() WHERE id = $5`,
      [nextName, nextEmail, nextMobile, nextTitle, accountId],
    )

    const reloaded = await client.query(
      `${LOCAL_ACCOUNT_SELECT} WHERE a.id = $1 AND a.integration_id = $2 AND a.provider = 'local'`,
      [accountId, integration.id],
    )
    const updated = reloaded.rows[0] as LocalAccountRow | undefined
    if (!updated) throw new Error('local account updated but reload failed')
    return summarizeLocalAccount(updated)
  })
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
  const integration = await getOrCreateLocalIntegration(input.orgId)

  // PB4-2 (owner design lock, WRITE-POINT enforcement): lock the account row THEN the department
  // row `FOR UPDATE` (fixed order — account before department, design lock §2 — so no two
  // membership-writing transactions ever grab the same account/department pair in opposite orders
  // and deadlock), classify missing/archived, and add the membership all in ONE transaction. An
  // archive of either target concurrent with this add is serialized by these row locks: it either
  // commits first (we see is_active=false → 409) or waits behind us (the add wins, archive after).
  return await transaction(async (client) => {
    const accountRes = await client.query(
      `SELECT id, is_active FROM directory_accounts
        WHERE id = $1 AND integration_id = $2 AND provider = 'local'
        FOR UPDATE`,
      [input.accountId, integration.id],
    )
    const account = accountRes.rows[0] as { id: string; is_active: boolean } | undefined
    if (!account) throw new LocalDirectoryNotFoundError('local account not found')
    if (!account.is_active) throw new LocalDirectoryConflictError('account is archived (read-only)')

    const departmentRes = await client.query(
      `SELECT id, is_active FROM directory_departments
        WHERE id = $1 AND integration_id = $2 AND provider = 'local'
        FOR UPDATE`,
      [input.departmentId, integration.id],
    )
    const department = departmentRes.rows[0] as { id: string; is_active: boolean } | undefined
    if (!department) throw new LocalDirectoryNotFoundError('local department not found')
    if (!department.is_active) throw new LocalDirectoryConflictError('department is archived (read-only)')

    const inserted = await client.query(
      `INSERT INTO directory_account_departments (directory_account_id, directory_department_id, is_primary, created_at)
       VALUES ($1, $2, false, NOW())
       ON CONFLICT (directory_account_id, directory_department_id) DO NOTHING
       RETURNING directory_account_id, directory_department_id, is_primary, created_at`,
      [input.accountId, input.departmentId],
    )

    if (inserted.rows[0]) return summarizeLocalMembership(inserted.rows[0] as LocalMembershipRow)

    // Already existed — idempotent re-add reads back the existing row unchanged.
    const existing = await client.query(
      `SELECT directory_account_id, directory_department_id, is_primary, created_at
         FROM directory_account_departments
        WHERE directory_account_id = $1 AND directory_department_id = $2`,
      [input.accountId, input.departmentId],
    )
    const existingRow = existing.rows[0] as LocalMembershipRow | undefined
    if (!existingRow) throw new Error('membership add: row neither inserted nor found')
    return summarizeLocalMembership(existingRow)
  })
}

/**
 * The explicit primary-department switch (design lock §5.4). Requires the membership to already
 * exist (`addLocalMembership` first) — this function only ever moves the primary flag, it does
 * not create memberships. A SINGLE atomic UPDATE sets `is_primary = (this dept)` across every
 * membership of the account (demote-others + promote-this in one statement), so at most one row
 * is ever `is_primary=true` for the account at any point another reader can observe — see the
 * inline comment below for the lock order, the 404 (missing membership) and the PB4-2 full
 * read-only 409 (archived account or any archived membership department) semantics.
 */
export async function switchLocalPrimaryDepartment(
  orgId: string,
  accountId: string,
  departmentId: string,
): Promise<LocalMembershipSummary> {
  const integration = await getOrCreateLocalIntegration(orgId)

  // PB4-2 (owner design lock, WRITE-POINT enforcement + FULL read-only): inside ONE transaction we
  // lock the account row, then EVERY department the account is a member of `FOR UPDATE` ordered by
  // department id (the fixed §2 lock order — account first, then departments ascending — so this
  // never deadlocks against add/reparent, which lock in the same order). We then classify:
  //   - the target (account, departmentId) membership must be among the locked set, else 404;
  //   - if the account is archived OR ANY of the account's membership departments is archived, the
  //     WHOLE switch is rejected 409 (full read-only, design lock §4 — no exception for migrating
  //     out of an archived primary; that path goes through PB4-4 reactivation first).
  // Only then the existing single atomic demote-others+promote-this UPDATE runs, still holding the
  // locks so no archive can slip in between the classification and the write.
  return await transaction(async (client) => {
    const accountRes = await client.query(
      `SELECT id, is_active FROM directory_accounts
        WHERE id = $1 AND integration_id = $2 AND provider = 'local'
        FOR UPDATE`,
      [accountId, integration.id],
    )
    const account = accountRes.rows[0] as { id: string; is_active: boolean } | undefined
    if (!account) throw new LocalDirectoryNotFoundError('local account not found')

    // Owner P1: lock EVERY department the account is a member of — NOT pre-filtered by
    // provider/integration. The batch UPDATE below touches ALL of the account's membership rows, so
    // classifying only the local subset would let a cross-integration / provider-mislabeled /
    // archived FOREIGN membership (which the schema does not yet forbid, and which a provider sync
    // could seed) be SILENTLY demoted — a cross-scope write and a full-read-only bypass. We collect
    // the whole set, reject the WHOLE switch if any row is foreign or archived, then update ONLY the
    // verified id set.
    const membershipDepts = await client.query(
      `SELECT d.id, d.is_active, d.provider, d.integration_id
         FROM directory_account_departments ad
         JOIN directory_departments d ON d.id = ad.directory_department_id
        WHERE ad.directory_account_id = $1
        ORDER BY d.id
        FOR UPDATE OF d`,
      [accountId],
    )
    const deptRows = membershipDepts.rows as Array<{ id: string; is_active: boolean; provider: string; integration_id: string }>

    // Owner P2: resolve the TARGET first, and treat a missing OR out-of-scope target as 404 — NOT
    // 409. A target membership that does not exist, or whose department is itself cross-integration
    // or non-local, is simply "not a valid local membership to make primary" (the pre-PB4-2
    // scope-hidden semantics), so it stays a 404. Only a legal local target with a MALFORMED SIBLING
    // membership becomes a 409 below. (Lumping the target's own foreign status into the wholesale
    // 409 regressed the documented cross-integration → 404 behaviour.)
    const targetRow = deptRows.find((r) => r.id === departmentId)
    if (!targetRow || targetRow.integration_id !== integration.id || targetRow.provider !== 'local') {
      throw new LocalDirectoryNotFoundError('membership not found; add the membership before setting it primary')
    }

    // Full read-only + scope: with a legal local target established, the account being archived, or
    // ANY of the account's membership departments (target or SIBLING) being archived, or any SIBLING
    // being cross-integration / non-local, rejects the WHOLE switch with zero write (design lock §4 +
    // owner P1). The batch UPDATE would otherwise silently demote those foreign/archived rows. No
    // exception for migrating out of an archived/foreign old-primary. (A foreign TARGET was already
    // 404'd above, so `anyForeign` here can only be a foreign SIBLING.)
    if (!account.is_active) throw new LocalDirectoryConflictError('account is archived (read-only)')
    const anyForeign = deptRows.some((r) => r.integration_id !== integration.id || r.provider !== 'local')
    if (anyForeign) {
      throw new LocalDirectoryConflictError('account has a cross-integration or non-local department membership (read-only)')
    }
    if (deptRows.some((r) => !r.is_active)) {
      throw new LocalDirectoryConflictError('account has an archived department membership (read-only)')
    }

    // Every membership department is now verified local + this-integration + active. Scope the
    // UPDATE to exactly that verified id set — belt-and-suspenders against a foreign membership
    // inserted concurrently after the lock (only a provider sync could, never the local writers).
    const verifiedDeptIds = deptRows.map((r) => r.id)
    await client.query(
      `UPDATE directory_account_departments AS ad
          SET is_primary = (ad.directory_department_id = $2)
        WHERE ad.directory_account_id = $1
          AND ad.directory_department_id = ANY($3::uuid[])`,
      [accountId, departmentId, verifiedDeptIds],
    )

    const result = await client.query(
      `SELECT directory_account_id, directory_department_id, is_primary, created_at
         FROM directory_account_departments
        WHERE directory_account_id = $1 AND directory_department_id = $2`,
      [accountId, departmentId],
    )
    const row = result.rows[0] as LocalMembershipRow | undefined
    if (!row) throw new Error('membership primary switch: row not found after update')
    return summarizeLocalMembership(row)
  })
}
