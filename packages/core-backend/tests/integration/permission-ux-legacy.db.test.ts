import { restorePermissionUxLegacyEnv } from '../utils/permission-ux-legacy-setup'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { Client } from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authService } from '../../src/auth/AuthService'
import { query, transaction } from '../../src/db/pg'
import { permissionsRouter } from '../../src/routes/permissions'

if (process.env.RBAC_BYPASS !== 'false' || process.env.RBAC_TOKEN_TRUST !== 'false') {
  throw new Error('permission ux legacy suite requires RBAC_BYPASS=false and RBAC_TOKEN_TRUST=false')
}
if (process.env.PRODUCT_MODE !== 'plm-workbench') {
  throw new Error('permission ux legacy suite requires PRODUCT_MODE=plm-workbench')
}
if (process.env.EXPECT_DB !== '1' || !process.env.DATABASE_URL) {
  throw new Error('EXPECT_DB=1 and DATABASE_URL are required; refusing a skip-shaped green')
}

const runHex = randomBytes(6).toString('hex')
const namedRoleId = `puxn${runHex}`
const orphanRoleId = `puxo${runHex}`
const catalogCode = 'workflow:read'
const obsoleteCode = 'historical:obsolete'
const keptCode = 'kept:note'
const adminId = randomUUID()
const flagId = randomUUID()
const targetId = randomUUID()
const missingCodeId = randomUUID()
const inactiveId = randomUUID()
const recycleId = randomUUID()
const rollbackId = randomUUID()
const demoteActorId = randomUUID()
const demoteTargetId = randomUUID()
const inspectId = randomUUID()
const rawRoleId = randomUUID()
const tokenOnlyId = randomUUID()
const pendingActorId = randomUUID()
const inactiveActorId = randomUUID()
const rbacOnlyId = randomUUID()
const rbacTargetId = randomUUID()
const barrierActorId = randomUUID()
const barrierTargetId = randomUUID()
const sentinelTargetId = randomUUID()
const ownedUserIds = [
  adminId,
  flagId,
  targetId,
  missingCodeId,
  inactiveId,
  recycleId,
  rollbackId,
  demoteActorId,
  demoteTargetId,
  inspectId,
  rawRoleId,
  tokenOnlyId,
  pendingActorId,
  inactiveActorId,
  rbacOnlyId,
  rbacTargetId,
  barrierActorId,
  barrierTargetId,
  sentinelTargetId,
]
const ownedRoleIds = [namedRoleId, orphanRoleId]
const namespace = `pux${runHex}`

let columnKind: 'jsonb' | 'text[]' = 'jsonb'
let insertedCatalogCode = false
let evidenceIds: { integrationId: string; accountId: string; eventId: string } | null = null
let rollbackEvidenceIds: { integrationId: string; accountId: string; eventId: string } | null = null

const app = express()
app.use(express.json())
app.use(permissionsRouter())

function assertUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('permission ux legacy fixture id must be a uuid')
  }
}

function mintToken(id: string, role = 'user'): string {
  return authService.createToken({
    id,
    email: `${id}@example.test`,
    name: 'synthetic',
    role,
    tenantId: `pux-${runHex}`,
    permissions: [],
    created_at: new Date(),
    updated_at: new Date(),
  })
}

async function postLegacy(token: string, userId: string, permission: unknown) {
  const response = await request(app)
    .post('/api/permissions/legacy/revoke')
    .auth(token, { type: 'bearer' })
    .send({ userId, permission })
  return { status: response.status, body: response.body as Record<string, unknown> }
}

async function insertUser(id: string, options: {
  role?: string
  isAdmin?: boolean
  active?: boolean
  adminRole?: boolean
  activationStatus?: string
}): Promise<void> {
  await query(
    `INSERT INTO users (
       id, username, email, name, password_hash, role, is_admin, is_active,
       activation_status, must_change_password, local_password_set
     ) VALUES ($1, $1, $2, 'synthetic', 'synthetic', $3, $4, $5, $6, false, true)`,
    [
      id,
      `${id}@example.test`,
      options.role ?? 'user',
      options.isAdmin === true,
      options.active !== false,
      options.activationStatus ?? 'activated',
    ],
  )
  if (options.adminRole) {
    await query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [id, 'admin'])
  }
}

async function auditCount(userId: string): Promise<number> {
  const result = await query(
    `SELECT COUNT(*)::text AS count
       FROM audit_logs
      WHERE resource_id = ANY($1::text[])
         OR action_details->>'userId' = $2
         OR action_details->>'adminUserId' = $2`,
    [[`${userId}:${obsoleteCode}`, `${userId}:${catalogCode}`], userId],
  )
  return Number(result.rows[0]?.count ?? 0)
}

async function generationOf(userId: string): Promise<string> {
  const result = await query('SELECT access_generation::text AS generation FROM users WHERE id = $1', [userId])
  return String(result.rows[0]?.generation ?? '')
}

async function writeLegacy(userId: string, values: unknown[]): Promise<void> {
  if (columnKind === 'jsonb') {
    await query('UPDATE users SET permissions = $2::jsonb WHERE id = $1', [userId, JSON.stringify(values)])
    return
  }
  await query('UPDATE users SET permissions = $2::text[] WHERE id = $1', [userId, values])
}

async function readLegacy(userId: string): Promise<unknown> {
  const result = await query('SELECT permissions FROM users WHERE id = $1', [userId])
  return result.rows[0]?.permissions
}

async function seedEvidence(userId: string): Promise<{ integrationId: string; accountId: string; eventId: string }> {
  const integrationId = randomUUID()
  const accountId = randomUUID()
  const eventId = randomUUID()
  await query(
    `INSERT INTO directory_integrations(id, org_id, provider, name, corp_id, sync_enabled)
     VALUES ($1::uuid, 'default', 'dingtalk', $1::text, $1::text, FALSE)`,
    [integrationId],
  )
  await query(
    `INSERT INTO directory_accounts(id, integration_id, provider, corp_id, external_user_id, external_key, name, is_active)
     VALUES ($1::uuid, $2::uuid, 'dingtalk', $2::text, $1::text, $1::text, 'Synthetic', FALSE)`,
    [accountId, integrationId],
  )
  await query(
    `INSERT INTO directory_account_links(directory_account_id, local_user_id, link_status)
     VALUES ($1, $2, 'linked')`,
    [accountId, userId],
  )
  await query(
    `INSERT INTO directory_deprovision_events(
       id, org_id, integration_id, directory_account_id, local_user_id, triggered_by, event_origin,
       link_witness_account_id, link_witness_local_user_id, policy, globally_clear, access_generation_at_apply, status
     ) VALUES ($1, 'default', $2, $3, $4, 'synthetic-operator', 'admin_manual', $3, $4, 'mark_inactive', TRUE, 0, 'applied')`,
    [eventId, integrationId, accountId, userId],
  )
  await query(
    `INSERT INTO directory_deprovision_effects(
       event_id, local_user_id, effect_type, before_active, after_active, access_generation_at_apply, status
     ) VALUES ($1, $2, 'user_changed', TRUE, FALSE, 0, 'applied')`,
    [eventId, userId],
  )
  return { integrationId, accountId, eventId }
}

async function evidenceStatus(eventId: string): Promise<{ event: string; effect: string; generation: string }> {
  const event = await query('SELECT status FROM directory_deprovision_events WHERE id = $1', [eventId])
  const effect = await query('SELECT status FROM directory_deprovision_effects WHERE event_id = $1', [eventId])
  const userId = (await query('SELECT local_user_id FROM directory_deprovision_events WHERE id = $1', [eventId])).rows[0]?.local_user_id
  const generation = await query('SELECT access_generation::text AS generation FROM users WHERE id = $1', [userId])
  return {
    event: String(event.rows[0]?.status ?? ''),
    effect: String(effect.rows[0]?.status ?? ''),
    generation: String(generation.rows[0]?.generation ?? ''),
  }
}

function triggerNames(): { fn: string; trigger: string } {
  return { fn: `pux_fail_${runHex}`, trigger: `pux_fail_${runHex}_trg` }
}

async function installGenerationFault(userId: string): Promise<void> {
  assertUuid(userId)
  const { fn, trigger } = triggerNames()
  await dropGenerationFault()
  await query(
    `CREATE FUNCTION ${fn}() RETURNS trigger
     LANGUAGE plpgsql AS $fn$
     BEGIN
       IF NEW.id::text = '${userId}' AND NEW.access_generation IS DISTINCT FROM OLD.access_generation THEN
         RAISE EXCEPTION 'permission ux legacy injected failure' USING ERRCODE = 'P0001';
       END IF;
       RETURN NEW;
     END
     $fn$`,
  )
  await query(
    `CREATE TRIGGER ${trigger}
     BEFORE UPDATE ON users
     FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
  )
}

async function dropGenerationFault(): Promise<void> {
  const { fn, trigger } = triggerNames()
  await query(`DROP TRIGGER IF EXISTS ${trigger} ON users`)
  await query(`DROP FUNCTION IF EXISTS ${fn}()`)
}

async function cleanupOwned(): Promise<void> {
  await dropGenerationFault()
  const eventIds = [evidenceIds?.eventId, rollbackEvidenceIds?.eventId].filter((id): id is string => Boolean(id))
  const accountIds = [evidenceIds?.accountId, rollbackEvidenceIds?.accountId].filter((id): id is string => Boolean(id))
  const integrationIds = [evidenceIds?.integrationId, rollbackEvidenceIds?.integrationId].filter((id): id is string => Boolean(id))
  if (eventIds.length > 0) {
    await query('DELETE FROM directory_deprovision_effects WHERE event_id = ANY($1::uuid[])', [eventIds])
    await query('DELETE FROM directory_deprovision_events WHERE id = ANY($1::uuid[])', [eventIds])
  }
  if (accountIds.length > 0) {
    await query('DELETE FROM directory_account_links WHERE directory_account_id = ANY($1::uuid[])', [accountIds])
    await query('DELETE FROM directory_accounts WHERE id = ANY($1::uuid[])', [accountIds])
  }
  if (integrationIds.length > 0) {
    await query('DELETE FROM directory_integrations WHERE id = ANY($1::uuid[])', [integrationIds])
  }
  await query('DELETE FROM user_namespace_admissions WHERE user_id = ANY($1::text[])', [ownedUserIds])
  await query('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [ownedUserIds])
  await query('DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [ownedUserIds])
  await query('DELETE FROM role_permissions WHERE role_id = ANY($1::text[])', [ownedRoleIds])
  await query('DELETE FROM roles WHERE id = ANY($1::text[])', [ownedRoleIds])
  await query(
    `DELETE FROM audit_logs
      WHERE resource_id = ANY($1::text[])
         OR action_details->>'userId' = ANY($2::text[])
         OR action_details->>'adminUserId' = ANY($2::text[])`,
    [
      ownedUserIds.flatMap((id) => [`${id}:${obsoleteCode}`, `${id}:${catalogCode}`]),
      ownedUserIds,
    ],
  )
  await query('DELETE FROM users WHERE id = ANY($1::text[])', [ownedUserIds])
  if (insertedCatalogCode) {
    await query('DELETE FROM permissions WHERE code = $1', [catalogCode])
  }
}

function resolveTsxCli(): string {
  const require = createRequire(import.meta.url)
  for (const specifier of ['tsx/dist/cli.mjs', 'tsx/cli']) {
    try {
      return require.resolve(specifier)
    } catch {
      // Try the next published entry.
    }
  }
  throw new Error('tsx cli is unavailable for the permission ux legacy reader')
}

function redact(value: string): string {
  return value.replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://redacted')
}

type LegacyProcessRead = {
  phase: 'warm' | 'after'
  listed: string[]
  legacy: string[]
  direct: string[]
  inherited: string[]
}

function startPersistentLegacyReader(userId: string): {
  nextRead: () => Promise<LegacyProcessRead>
  reread: () => void
  stop: () => Promise<void>
} {
  const childScript = fileURLToPath(new URL('../utils/permission-ux-legacy-read-child.ts', import.meta.url))
  const packageRoot = fileURLToPath(new URL('../..', import.meta.url))
  const child = spawn(process.execPath, [resolveTsxCli(), childScript, userId], {
    cwd: packageRoot,
    env: {
      ...process.env,
      RBAC_BYPASS: 'false',
      RBAC_TOKEN_TRUST: 'false',
      PRODUCT_MODE: 'plm-workbench',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines: string[] = []
  let stderr = ''
  let pending: ((line: string) => void) | null = null
  let failPending: ((error: Error) => void) | null = null
  let buffered = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk
    let newline = buffered.indexOf('\n')
    while (newline >= 0) {
      const line = buffered.slice(0, newline).replace(/\r$/, '')
      buffered = buffered.slice(newline + 1)
      newline = buffered.indexOf('\n')
      if (!line) continue
      if (pending) {
        const deliver = pending
        pending = null
        failPending = null
        deliver(line)
      } else {
        lines.push(line)
      }
    }
  })
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  child.once('exit', (code) => {
    if (!failPending) return
    const reject = failPending
    failPending = null
    pending = null
    reject(new Error(`permission ux legacy reader exited ${code ?? 'null'}: ${redact(stderr).slice(-500)}`))
  })

  return {
    nextRead() {
      const queued = lines.shift()
      if (queued) return Promise.resolve(JSON.parse(queued) as LegacyProcessRead)
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending = null
          failPending = null
          reject(new Error(`permission ux legacy reader timed out: ${redact(stderr).slice(-500)}`))
        }, 25000)
        pending = (line) => {
          clearTimeout(timer)
          resolve(JSON.parse(line) as LegacyProcessRead)
        }
        failPending = (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
    },
    reread() {
      child.stdin.write('reread\n')
    },
    stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      return new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve()
          return
        }
        const timer = setTimeout(() => resolve(), 2000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
  }
}

async function releaseLockHolder(holder: Client, committed: boolean): Promise<void> {
  if (!committed) {
    try {
      await holder.query('ROLLBACK')
    } catch {
      // The connection never opened, or the transaction already ended.
    }
  }
  try {
    await holder.end()
  } catch {
    // Already closed.
  }
}

describe('permission ux legacy real database', () => {
  beforeAll(async () => {
    expect(process.env.EXPECT_DB).toBe('1')
    const typed = await query(
      `SELECT data_type, udt_name
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'users'
         AND column_name = 'permissions'`,
    )
    const dataType = String(typed.rows[0]?.data_type ?? '')
    const udtName = String(typed.rows[0]?.udt_name ?? '')
    if (dataType === 'jsonb' && udtName === 'jsonb') columnKind = 'jsonb'
    else if (dataType === 'ARRAY' && udtName === '_text') columnKind = 'text[]'
    else throw new Error('users.permissions is not jsonb or text[]')

    const existing = await query('SELECT 1 FROM permissions WHERE code = $1', [catalogCode])
    if (existing.rows.length === 0) {
      await query(
        `INSERT INTO permissions (code, name, description) VALUES ($1, 'Workflow read', 'permission ux legacy fixture')`,
        [catalogCode],
      )
      insertedCatalogCode = true
    }
    await query('SELECT id FROM roles WHERE id = $1', ['admin'])
    for (const id of [adminId, demoteActorId, barrierActorId]) {
      await insertUser(id, { role: 'admin', isAdmin: false, adminRole: true })
    }
    await insertUser(flagId, { role: 'user', isAdmin: true, adminRole: false })
    await insertUser(rawRoleId, { role: 'admin', isAdmin: false, adminRole: false })
    await insertUser(tokenOnlyId, { role: 'user', isAdmin: false, adminRole: false })
    await insertUser(pendingActorId, {
      role: 'admin',
      isAdmin: false,
      adminRole: true,
      activationStatus: 'pending_activation',
    })
    await insertUser(inactiveActorId, { role: 'admin', isAdmin: false, active: false, adminRole: true })
    await insertUser(rbacOnlyId, { role: 'user', isAdmin: false, adminRole: true })
    await insertUser(targetId, { role: 'user', isAdmin: false, active: true })
    await insertUser(missingCodeId, { role: 'user', isAdmin: false })
    await insertUser(inactiveId, { role: 'user', isAdmin: false, active: false })
    await insertUser(recycleId, { role: 'user', isAdmin: false })
    await insertUser(rollbackId, { role: 'user', isAdmin: false })
    await insertUser(demoteTargetId, { role: 'user', isAdmin: false })
    await insertUser(inspectId, { role: 'user', isAdmin: false })
    await insertUser(sentinelTargetId, { role: 'user', isAdmin: false })
    await insertUser(rbacTargetId, { role: 'user', isAdmin: false })
    await insertUser(barrierTargetId, { role: 'user', isAdmin: false })
    await query('UPDATE users SET deleted_at = NOW() WHERE id = $1', [recycleId])
    await query(
      'INSERT INTO roles (id, name) VALUES ($1, $2)',
      [namedRoleId, `Pux ${runHex}`],
    )
    await query(
      'INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2), ($3, $2)',
      [namedRoleId, catalogCode, orphanRoleId],
    )
    await query(
      'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2), ($3, $2), ($3, $4)',
      [targetId, namedRoleId, inspectId, orphanRoleId],
    )
    await query(
      'INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, $2)',
      [targetId, catalogCode],
    )
    await query(
      `INSERT INTO user_namespace_admissions (user_id, namespace, enabled, source)
       VALUES ($1, $2, false, 'platform_admin')`,
      [targetId, namespace],
    )
    const legacyValues = [`  ${catalogCode} `, catalogCode, ` ${keptCode} `, obsoleteCode]
    await writeLegacy(targetId, legacyValues)
    await writeLegacy(missingCodeId, [keptCode])
    await writeLegacy(inactiveId, [obsoleteCode])
    await writeLegacy(rollbackId, [obsoleteCode, keptCode])
    await writeLegacy(demoteTargetId, [obsoleteCode])
    await writeLegacy(sentinelTargetId, [obsoleteCode])
    await writeLegacy(rbacTargetId, [obsoleteCode])
    await writeLegacy(barrierTargetId, [obsoleteCode])
    evidenceIds = await seedEvidence(targetId)
    rollbackEvidenceIds = await seedEvidence(rollbackId)
  })

  afterAll(async () => {
    try {
      await cleanupOwned()
    } finally {
      restorePermissionUxLegacyEnv()
    }
  })

  it('removes padded legacy copies of a code that direct and role grants still hold', async () => {
    const reader = startPersistentLegacyReader(targetId)
    try {
      const warm = await reader.nextRead()
      expect(warm.phase).toBe('warm')
      expect(warm.legacy).toContain(catalogCode)

      const beforeRole = await query('SELECT role, is_admin FROM users WHERE id = $1', [targetId])
      const beforeAdmission = await query(
        'SELECT enabled FROM user_namespace_admissions WHERE user_id = $1 AND namespace = $2',
        [targetId, namespace],
      )
      const beforeGeneration = await query('SELECT access_generation::text AS generation FROM users WHERE id = $1', [targetId])
      const response = await postLegacy(mintToken(adminId), targetId, `  ${catalogCode}  `)

      expect(response.status).toBe(200)
      expect(response.body).toEqual({
        success: true,
        userId: targetId,
        permission: catalogCode,
        changed: true,
      })
      const legacy = await readLegacy(targetId)
      expect(legacy).toEqual([` ${keptCode} `, obsoleteCode])
      expect(legacy).not.toContain(catalogCode)
      expect(legacy).not.toContain(`  ${catalogCode} `)
      const direct = await query(
        'SELECT permission_code FROM user_permissions WHERE user_id = $1 ORDER BY permission_code',
        [targetId],
      )
      expect(direct.rows.map((row) => row.permission_code)).toEqual([catalogCode])
      const inherited = await query(
        `SELECT rp.permission_code
         FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id
         WHERE ur.user_id = $1`,
        [targetId],
      )
      expect(inherited.rows.map((row) => row.permission_code)).toEqual([catalogCode])
      const afterRole = await query('SELECT role, is_admin FROM users WHERE id = $1', [targetId])
      expect(afterRole.rows[0]).toEqual(beforeRole.rows[0])
      const afterAdmission = await query(
        'SELECT enabled FROM user_namespace_admissions WHERE user_id = $1 AND namespace = $2',
        [targetId, namespace],
      )
      expect(afterAdmission.rows).toEqual(beforeAdmission.rows)
      const afterEvidence = await evidenceStatus(evidenceIds!.eventId)
      expect(afterEvidence.event).toBe('superseded')
      expect(afterEvidence.effect).toBe('superseded')
      expect(Number(afterEvidence.generation)).toBe(Number(beforeGeneration.rows[0]?.generation) + 1)

      const check = await request(app)
        .post('/api/permissions/check')
        .auth(mintToken(adminId), { type: 'bearer' })
        .send({ userId: targetId, permission: catalogCode })
      expect(check.status).toBe(200)
      expect(check.body).toEqual({
        userId: targetId,
        permission: catalogCode,
        allowed: true,
      })

      reader.reread()
      const seen = await reader.nextRead()
      expect(seen.phase).toBe('after')
      expect(seen.legacy).not.toContain(catalogCode)
      expect(seen.legacy).toContain(keptCode)
      expect(seen.legacy).toContain(obsoleteCode)
      expect(seen.direct).toContain(catalogCode)
      expect(seen.inherited).toContain(catalogCode)
      expect(seen.listed).toContain(catalogCode)
    } finally {
      await reader.stop()
    }
  })

  it('returns 404 when the locked legacy column has no match', async () => {
    const before = await readLegacy(missingCodeId)
    const response = await postLegacy(mintToken(adminId), missingCodeId, obsoleteCode)
    expect(response.status).toBe(404)
    expect(response.body).toEqual({ error: 'Legacy permission not found for user' })
    expect(response.body.changed).toBeUndefined()
    expect(await readLegacy(missingCodeId)).toEqual(before)
  })

  it('refuses a token whose only authority is the is_admin flag', async () => {
    const before = await readLegacy(inactiveId)
    const response = await postLegacy(mintToken(flagId), inactiveId, obsoleteCode)
    expect(response.status).toBe(403)
    expect(response.body.code).toBe('FORBIDDEN')
    expect(await readLegacy(inactiveId)).toEqual(before)
  })

  it('refuses an actor demoted while the request waits on the admission lock', async () => {
    const sorted = [demoteActorId, demoteTargetId].sort()
    const holder = new Client({
      connectionString: process.env.DATABASE_URL,
      application_name: `pux-hold-${runHex}`,
    })
    let committed = false
    let pending: ReturnType<typeof postLegacy> | null = null
    let waiting = false
    let failure: unknown
    try {
      await holder.connect()
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`namespace-admission:${sorted[0]}`])
      pending = postLegacy(mintToken(demoteActorId), demoteTargetId, obsoleteCode)
      const deadline = Date.now() + 8000
      while (Date.now() < deadline && !waiting) {
        const status = await query(
          `SELECT 1
           FROM pg_stat_activity
           WHERE state = 'active'
             AND wait_event_type = 'Lock'
             AND query ILIKE '%pg_advisory_xact_lock%'
             AND pid <> pg_backend_pid()
           LIMIT 1`,
        )
        waiting = status.rows.length > 0
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25))
      }
      await holder.query(`UPDATE users SET role = 'user' WHERE id = $1`, [demoteActorId])
      await holder.query(`DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'admin'`, [demoteActorId])
      await holder.query('COMMIT')
      committed = true
    } catch (error) {
      failure = error
    } finally {
      await releaseLockHolder(holder, committed)
    }
    const response = pending ? await pending : null
    if (failure) throw failure
    expect(waiting).toBe(true)
    expect(response?.status).toBe(403)
    expect(response?.body.code).toBe('FORBIDDEN')
    expect(await readLegacy(demoteTargetId)).toEqual([obsoleteCode])
  })

  it('rolls back the legacy column and deprovision evidence when the transaction fails', async () => {
    const beforeLegacy = await readLegacy(rollbackId)
    const before = await evidenceStatus(rollbackEvidenceIds!.eventId)
    await installGenerationFault(rollbackId)
    try {
      const response = await postLegacy(mintToken(adminId), rollbackId, obsoleteCode)
      expect(response.status).toBe(500)
      expect(await readLegacy(rollbackId)).toEqual(beforeLegacy)
      expect(await evidenceStatus(rollbackEvidenceIds!.eventId)).toEqual(before)
    } finally {
      await dropGenerationFault()
    }
  })

  it('clears a legacy code on an inactive account', async () => {
    const response = await postLegacy(mintToken(adminId), inactiveId, obsoleteCode)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      success: true,
      userId: inactiveId,
      permission: obsoleteCode,
      changed: true,
    })
    expect(await readLegacy(inactiveId)).toEqual([])
    const profile = await query('SELECT role, is_admin, is_active FROM users WHERE id = $1', [inactiveId])
    expect(profile.rows[0]).toMatchObject({ role: 'user', is_admin: false, is_active: false })
  })

  it('lists a named role and an orphan membership from the same inspection', async () => {
    const response = await request(app)
      .get(`/api/permissions/user/${inspectId}`)
      .auth(mintToken(adminId), { type: 'bearer' })
    expect(response.status).toBe(200)
    const roles = response.body.inheritedRoles as Array<{ roleId: string; roleName: string | null; permissions: string[] }>
    expect(roles).toEqual([
      { roleId: namedRoleId, roleName: `Pux ${runHex}`, permissions: [catalogCode] },
      { roleId: orphanRoleId, roleName: null, permissions: [catalogCode] },
    ])
  })

  it('refuses a recycled target', async () => {
    const response = await postLegacy(mintToken(adminId), recycleId, obsoleteCode)
    expect(response.status).toBe(409)
    expect(response.body.code).toBe('USER_IN_RECYCLE_BIN')
  })

  it('refuses a raw users.role admin with no live user_roles admin membership', async () => {
    const before = await readLegacy(sentinelTargetId)
    const beforeGeneration = await generationOf(sentinelTargetId)
    const beforeAudit = await auditCount(sentinelTargetId)
    const response = await postLegacy(mintToken(rawRoleId), sentinelTargetId, obsoleteCode)
    expect(response.status).toBe(403)
    expect(response.body.code).toBe('FORBIDDEN')
    expect(await readLegacy(sentinelTargetId)).toEqual(before)
    expect(await generationOf(sentinelTargetId)).toBe(beforeGeneration)
    expect(await auditCount(sentinelTargetId)).toBe(beforeAudit)
    const actor = await query('SELECT role, is_admin FROM users WHERE id = $1', [rawRoleId])
    expect(actor.rows[0]).toMatchObject({ role: 'admin', is_admin: false })
    const membership = await query(
      `SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = 'admin'`,
      [rawRoleId],
    )
    expect(membership.rows).toHaveLength(0)
  })

  it('refuses a token admin claim with no live user_roles admin membership', async () => {
    const before = await readLegacy(sentinelTargetId)
    const response = await postLegacy(mintToken(tokenOnlyId, 'admin'), sentinelTargetId, obsoleteCode)
    expect(response.status).toBe(403)
    expect(response.body.code).toBe('FORBIDDEN')
    expect(await readLegacy(sentinelTargetId)).toEqual(before)
    const actor = await query(
      'SELECT role, is_admin FROM users WHERE id = $1',
      [tokenOnlyId],
    )
    expect(actor.rows[0]).toMatchObject({ role: 'user', is_admin: false })
  })

  it('refuses a pending actor and an inactive actor who still hold user_roles admin', async () => {
    const before = await readLegacy(sentinelTargetId)
    const beforeSentinelGeneration = await generationOf(sentinelTargetId)
    const beforePendingGeneration = await generationOf(pendingActorId)
    const beforeInactiveGeneration = await generationOf(inactiveActorId)
    const beforeAudit = await auditCount(sentinelTargetId) + await auditCount(pendingActorId) + await auditCount(inactiveActorId)
    const evidenceCount = async (userId: string) => {
      const result = await query(
        'SELECT COUNT(*)::text AS count FROM directory_deprovision_events WHERE local_user_id = $1',
        [userId],
      )
      return String(result.rows[0]?.count ?? '0')
    }
    const beforeEvidence = [
      await evidenceCount(sentinelTargetId),
      await evidenceCount(pendingActorId),
      await evidenceCount(inactiveActorId),
    ]
    const unauthorized = {
      ok: false,
      error: { code: 'UNAUTHORIZED', message: 'Invalid token' },
    }
    const pending = await postLegacy(mintToken(pendingActorId), sentinelTargetId, obsoleteCode)
    expect(pending.status).toBe(401)
    expect(pending.body).toEqual(unauthorized)
    const inactive = await postLegacy(mintToken(inactiveActorId), sentinelTargetId, obsoleteCode)
    expect(inactive.status).toBe(401)
    expect(inactive.body).toEqual(unauthorized)
    expect(await readLegacy(sentinelTargetId)).toEqual(before)
    expect(await generationOf(sentinelTargetId)).toBe(beforeSentinelGeneration)
    expect(await generationOf(pendingActorId)).toBe(beforePendingGeneration)
    expect(await generationOf(inactiveActorId)).toBe(beforeInactiveGeneration)
    expect(await auditCount(sentinelTargetId) + await auditCount(pendingActorId) + await auditCount(inactiveActorId)).toBe(beforeAudit)
    expect([
      await evidenceCount(sentinelTargetId),
      await evidenceCount(pendingActorId),
      await evidenceCount(inactiveActorId),
    ]).toEqual(beforeEvidence)
    const pendingRow = await query(
      'SELECT activation_status, is_active FROM users WHERE id = $1',
      [pendingActorId],
    )
    expect(pendingRow.rows[0]).toMatchObject({ activation_status: 'pending_activation', is_active: true })
    const inactiveRow = await query('SELECT activation_status, is_active FROM users WHERE id = $1', [inactiveActorId])
    expect(inactiveRow.rows[0]).toMatchObject({ activation_status: 'activated', is_active: false })
    const pendingMembership = await query(
      `SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = 'admin'`,
      [pendingActorId],
    )
    const inactiveMembership = await query(
      `SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = 'admin'`,
      [inactiveActorId],
    )
    expect(pendingMembership.rows).toHaveLength(1)
    expect(inactiveMembership.rows).toHaveLength(1)
  })

  it('allows a live user_roles admin whose users.role stays user', async () => {
    const response = await postLegacy(mintToken(rbacOnlyId), rbacTargetId, obsoleteCode)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      success: true,
      userId: rbacTargetId,
      permission: obsoleteCode,
      changed: true,
    })
    expect(await readLegacy(rbacTargetId)).toEqual([])
    const actor = await query('SELECT role FROM users WHERE id = $1', [rbacOnlyId])
    expect(actor.rows[0]?.role).toBe('user')
    const membership = await query(
      `SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = 'admin'`,
      [rbacOnlyId],
    )
    expect(membership.rows).toHaveLength(1)
    expect(await readLegacy(sentinelTargetId)).toEqual([obsoleteCode])
  })

  it('refuses when a waiting lock deletes only user_roles admin and users.role stays admin', async () => {
    const sorted = [barrierActorId, barrierTargetId].sort()
    const beforeLegacy = await readLegacy(barrierTargetId)
    const beforeTargetGeneration = await generationOf(barrierTargetId)
    const beforeActorGeneration = await generationOf(barrierActorId)
    const beforeAudit = await auditCount(barrierTargetId) + await auditCount(barrierActorId)
    const beforeEvidence = await query(
      'SELECT COUNT(*)::text AS count FROM directory_deprovision_events WHERE local_user_id = $1',
      [barrierTargetId],
    )
    const holder = new Client({
      connectionString: process.env.DATABASE_URL,
      application_name: `pux-role-${runHex}`,
    })
    let committed = false
    let pending: ReturnType<typeof postLegacy> | null = null
    let waiting = false
    let failure: unknown
    try {
      await holder.connect()
      await holder.query('BEGIN')
      await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`namespace-admission:${sorted[0]}`])
      pending = postLegacy(mintToken(barrierActorId), barrierTargetId, obsoleteCode)
      const deadline = Date.now() + 8000
      while (Date.now() < deadline && !waiting) {
        const status = await query(
          `SELECT 1
           FROM pg_stat_activity
           WHERE state = 'active'
             AND wait_event_type = 'Lock'
             AND query ILIKE '%pg_advisory_xact_lock%'
             AND pid <> pg_backend_pid()
           LIMIT 1`,
        )
        waiting = status.rows.length > 0
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25))
      }
      await holder.query(`DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'admin'`, [barrierActorId])
      await holder.query('COMMIT')
      committed = true
    } catch (error) {
      failure = error
    } finally {
      await releaseLockHolder(holder, committed)
    }
    const response = pending ? await pending : null
    if (failure) throw failure
    expect(waiting).toBe(true)
    expect(response?.status).toBe(403)
    expect(response?.body.code).toBe('FORBIDDEN')
    expect(await readLegacy(barrierTargetId)).toEqual(beforeLegacy)
    expect(await generationOf(barrierTargetId)).toBe(beforeTargetGeneration)
    expect(await generationOf(barrierActorId)).toBe(beforeActorGeneration)
    expect(await auditCount(barrierTargetId) + await auditCount(barrierActorId)).toBe(beforeAudit)
    const actor = await query('SELECT role FROM users WHERE id = $1', [barrierActorId])
    expect(actor.rows[0]?.role).toBe('admin')
    const membership = await query(
      `SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = 'admin'`,
      [barrierActorId],
    )
    expect(membership.rows).toHaveLength(0)
    const afterEvidence = await query(
      'SELECT COUNT(*)::text AS count FROM directory_deprovision_events WHERE local_user_id = $1',
      [barrierTargetId],
    )
    expect(afterEvidence.rows).toEqual(beforeEvidence.rows)
  })

  it('rejects a non-string permission', async () => {
    const response = await request(app)
      .post('/api/permissions/legacy/revoke')
      .auth(mintToken(adminId), { type: 'bearer' })
      .send({ userId: targetId, permission: 7 })
    expect(response.status).toBe(400)
    expect(response.body).toEqual({ error: 'userId and permission must be strings' })
  })
})
