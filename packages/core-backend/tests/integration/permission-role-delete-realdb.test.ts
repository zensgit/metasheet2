/**
 * Role DELETE must wait on the same per-user admission lock a scope assign already holds.
 * Real HTTP only: admin scope assign and DELETE /api/roles/:id. Terra recorded the old
 * route separately (DELETE 200 while the insert was paused, then scope 1 after release).
 */
import { restorePermissionLifecycleEnv } from '../utils/permission-lifecycle-setup'
import {
  holdScopeInsertLock,
  scopeInsertLockKey,
  waitForAdvisoryLockWaiterPid,
  writerHoldsAdvisoryLockBesides,
} from '../utils/permission-lifecycle-fault'
import {
  createPermissionLifecycleDirectory,
  deletePermissionLifecycleDirectory,
  type PermissionLifecycleDirectory,
} from '../utils/permission-lifecycle-directory'
import { randomBytes, randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authService } from '../../src/auth/AuthService'
import { jwtAuthMiddleware } from '../../src/auth/jwt-middleware'
import { query, transaction } from '../../src/db/pg'
import { adminUsersRouter } from '../../src/routes/admin-users'
import { rolesRouter } from '../../src/routes/roles'

if (process.env.RBAC_BYPASS !== 'false' || process.env.RBAC_TOKEN_TRUST !== 'false') {
  throw new Error('role-delete suite requires RBAC_BYPASS=false and RBAC_TOKEN_TRUST=false')
}
if (process.env.PRODUCT_MODE !== 'plm-workbench') {
  throw new Error('role-delete suite requires PRODUCT_MODE=plm-workbench')
}

const RUN_HEX = /^[0-9a-f]{12}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const runHex = randomBytes(6).toString('hex')
const namespace = `prd${runHex}`
const roleId = `${namespace}_admin`
const adminId = randomUUID()
const holderId = randomUUID()
const ownedUserIds = [adminId, holderId]
let directory: PermissionLifecycleDirectory | null = null
let adminToken = ''

if (!RUN_HEX.test(runHex) || !UUID.test(adminId) || !UUID.test(holderId)) {
  throw new Error('role-delete fixture ids failed validation')
}
if (roleId === 'admin' || roleId.startsWith('stock-prep')) {
  throw new Error('role-delete fixture must not use a built-in role')
}

interface HttpResult {
  status: number
  body: unknown
}

const app = express()
app.use(express.json())
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) return jwtAuthMiddleware(req, res, next)
  return next()
})
app.use(adminUsersRouter())
app.use(rolesRouter())

function mintToken(id: string): string {
  return authService.createToken({
    id,
    email: `${id}@example.test`,
    name: 'synthetic',
    role: 'user',
    tenantId: `prd-${runHex}`,
    permissions: [],
    created_at: new Date(),
    updated_at: new Date(),
  })
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const result = await query<{ n: number }>(sql, params)
  return Number(result.rows[0]?.n ?? 0)
}

function gateNames(): { fn: string; trigger: string } {
  return { fn: `prd_scope_${runHex}`, trigger: `prd_scope_${runHex}_trg` }
}

async function installScopeInsertGate(): Promise<void> {
  const { fn, trigger } = gateNames()
  const lockKey = scopeInsertLockKey(runHex)
  await dropScopeInsertGate()
  await query(
    `CREATE FUNCTION ${fn}() RETURNS trigger
     LANGUAGE plpgsql AS $fn$
     BEGIN
       IF NEW.admin_user_id::text = '${holderId}' AND NEW.namespace = '${namespace}' THEN
         PERFORM pg_advisory_xact_lock(hashtextextended('${lockKey}', 0));
       END IF;
       RETURN NEW;
     END
     $fn$`,
  )
  await query(
    `CREATE TRIGGER ${trigger}
     BEFORE INSERT ON delegated_role_admin_scopes
     FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
  )
}

async function dropScopeInsertGate(): Promise<void> {
  const { fn, trigger } = gateNames()
  await query(`DROP TRIGGER IF EXISTS ${trigger} ON delegated_role_admin_scopes`)
  await query(`DROP FUNCTION IF EXISTS ${fn}()`)
}

async function cleanupOwnedRows(): Promise<void> {
  await transaction(async (client) => {
    await client.query(
      'DELETE FROM delegated_role_admin_scopes WHERE admin_user_id::text = ANY($1::text[])',
      [ownedUserIds],
    )
    await client.query(
      'DELETE FROM delegated_role_admin_member_groups WHERE admin_user_id::text = ANY($1::text[])',
      [ownedUserIds],
    )
    await client.query(
      `DELETE FROM user_roles
        WHERE user_id::text = ANY($1::text[])
           OR role_id = $2`,
      [ownedUserIds, roleId],
    )
    await client.query('DELETE FROM role_permissions WHERE role_id = $1', [roleId])
    await client.query(
      'DELETE FROM roles WHERE id = $1 AND id <> \'admin\' AND id NOT LIKE \'stock-prep%\'',
      [roleId],
    )
    if (directory) await deletePermissionLifecycleDirectory(client, directory.integrationId)
    await client.query(
      `DELETE FROM audit_logs
        WHERE resource_id = $1
           OR resource_id = $2
           OR action_details->>'userId' = ANY($3::text[])
           OR action_details->>'roleId' = $1`,
      [roleId, `${holderId}:${namespace}`, ownedUserIds],
    )
    await client.query('DELETE FROM users WHERE id::text = ANY($1::text[])', [ownedUserIds])
  })
}

describe('permission role delete real database', () => {
  beforeAll(async () => {
    expect(process.env.EXPECT_DB).toBe('1')
    const adminRole = await query('SELECT id FROM roles WHERE id = $1', ['admin'])
    if (adminRole.rows.length !== 1) throw new Error('built-in role admin is absent')

    for (const id of ownedUserIds) {
      const isPlatformAdmin = id === adminId
      await query(
        `INSERT INTO users (
           id, username, email, name, password_hash, role, is_admin, is_active,
           activation_status, must_change_password, local_password_set
         ) VALUES ($1, $1, $2, 'synthetic', 'synthetic', $3, $4, true, 'activated', false, true)`,
        [id, `${id}@example.test`, isPlatformAdmin ? 'admin' : 'user', isPlatformAdmin],
      )
    }
    await query(
      'INSERT INTO roles (id, name) VALUES ($1, $2)',
      [roleId, `role delete ${runHex}`],
    )
    await query(
      'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2), ($3, $4)',
      [adminId, 'admin', holderId, roleId],
    )
    directory = await createPermissionLifecycleDirectory(runHex)
    adminToken = mintToken(adminId)
  })

  afterAll(async () => {
    try {
      await dropScopeInsertGate()
      await cleanupOwnedRows()
    } finally {
      restorePermissionLifecycleEnv()
    }
  })

  it('waits for a paused custom-namespace scope assign and leaves no audience row', async () => {
    if (!directory) throw new Error('directory fixture is absent')
    await installScopeInsertGate()
    const gate = await holdScopeInsertLock(runHex)
    const pendingAssign = request(app)
      .post(`/api/admin/role-delegation/users/${holderId}/scopes/assign`)
      .auth(adminToken, { type: 'bearer' })
      .send({ namespace, directoryDepartmentId: directory.parentDepartmentId })
    void pendingAssign.catch(() => undefined)
    let pendingDelete: Promise<HttpResult> | undefined
    let writerPid: number | null = null
    let writerHeldLock = false
    let revokerPid: number | null = null
    let assignStatus = 0
    let deleteStatus = 0
    try {
      writerPid = await waitForAdvisoryLockWaiterPid(gate.pid)
      if (writerPid) {
        writerHeldLock = await writerHoldsAdvisoryLockBesides(writerPid, gate.pid)
        const started = request(app)
          .delete(`/api/roles/${roleId}`)
          .auth(adminToken, { type: 'bearer' })
        const deletion = Promise.resolve(started).then((response: HttpResult) => ({ status: response.status, body: response.body }))
        pendingDelete = deletion
        void deletion.catch(() => undefined)
        revokerPid = await waitForAdvisoryLockWaiterPid(writerPid)
      }
    } finally {
      await gate.release()
      const assigned = await pendingAssign
      assignStatus = assigned.status
      if (pendingDelete) deleteStatus = (await pendingDelete).status
      await dropScopeInsertGate()
    }

    expect(writerPid, 'scope assign did not block on the insert gate').not.toBeNull()
    expect(writerHeldLock, 'scope assign did not hold the user admission lock').toBe(true)
    expect(revokerPid, 'role DELETE did not block on the scope writer').not.toBeNull()
    expect(assignStatus).toBe(200)
    expect(deleteStatus).toBe(200)
    expect(await count(
      'SELECT count(*)::int AS n FROM user_roles WHERE user_id = $1 AND role_id = $2',
      [holderId, roleId],
    )).toBe(0)
    expect(await count(
      'SELECT count(*)::int AS n FROM delegated_role_admin_scopes WHERE admin_user_id = $1 AND namespace = $2',
      [holderId, namespace],
    )).toBe(0)
    expect(await count('SELECT count(*)::int AS n FROM roles WHERE id = $1', [roleId])).toBe(0)
  })
})
