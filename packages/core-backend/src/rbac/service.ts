import { pool, query } from '../db/pg'
import { metrics } from '../metrics/metrics'
import { Logger } from '../core/logger'
import { isDatabaseSchemaError } from '../utils/database-errors'
import {
  filterPermissionCodesByNamespaceAdmission,
  inspectPermissionCodesByNamespaceAdmission,
  isPermissionAllowedByNamespaceAdmission,
} from './namespace-admission'

const logger = new Logger('RBACService')

const cache = new Map<string, { codes: string[]; exp: number; generation: number }>()
const permCacheGeneration = new Map<string, number>()
const TTL_MS = parseInt(process.env.RBAC_CACHE_TTL_MS || '60000', 10)

// Graceful degradation for missing RBAC tables (Phase B)
let rbacDegraded = false

function rbacOptionalEnabled(): boolean {
  return process.env.RBAC_OPTIONAL === '1'
}

function currentPermCacheGeneration(userId: string): number {
  return permCacheGeneration.get(userId) ?? 0
}

export async function isAdmin(userId: string, runQuery: typeof query = query): Promise<boolean> {
  if (runQuery === query && !pool) return false
  try {
    const { rows } = await runQuery('SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2 LIMIT 1', [userId, 'admin'])
    return rows.length > 0
  } catch (error) {
    if (isDatabaseSchemaError(error) && rbacOptionalEnabled()) {
      if (!rbacDegraded) {
        logger.warn('RBAC service degraded - user_roles table not found')
        rbacDegraded = true
      }
      return false
    }
    throw error
  }
}

export async function userHasPermission(userId: string, code: string): Promise<boolean> {
  if (!pool) return false
  try {
    if (!await isPermissionAllowedByNamespaceAdmission(userId, code)) {
      return false
    }

    // direct user permission
    const direct = await pool.query('SELECT 1 FROM user_permissions WHERE user_id = $1 AND permission_code = $2 LIMIT 1', [userId, code])
    if (direct.rows.length > 0) return true
    // via roles
    const viaRole = await pool.query(
      `SELECT 1
       FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       WHERE ur.user_id = $1 AND rp.permission_code = $2
       LIMIT 1`,
      [userId, code]
    )
    if (viaRole.rows.length > 0) return true

    const legacy = await pool.query('SELECT permissions FROM users WHERE id = $1', [userId])
    const perms = Array.isArray(legacy.rows[0]?.permissions) ? legacy.rows[0].permissions : []
    if (perms.includes(code)) return true
    const resource = code.split(':')[0]
    return perms.includes(`${resource}:*`) || perms.includes('*:*')
  } catch (error) {
    if (isDatabaseSchemaError(error) && rbacOptionalEnabled()) {
      if (!rbacDegraded) {
        logger.warn('RBAC service degraded - permission tables not found')
        rbacDegraded = true
      }
      return false
    }
    throw error
  }
}

/**
 * A caller-supplied executor for the permission read — the caller's TRANSACTION client. With it,
 * every statement of the read (codes, the legacy column, the namespace-admission filter) runs on
 * that one connection, so a caller holding row locks inside a transaction decides on what those
 * locks protect instead of on a second pool connection.
 */
export type RbacPermissionQueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>

/**
 * The CURRENT codes on `runQuery`, never through the memo in either direction: nothing cached is
 * returned, and the result is not cached (it may include the caller's own uncommitted writes, which
 * must not leak to other requests if the transaction rolls back).
 */
async function readUserPermissionsOn(userId: string, runQuery: RbacPermissionQueryFn): Promise<string[]> {
  try {
    const { rows } = await runQuery(
      `SELECT DISTINCT permission_code AS code FROM (
         SELECT up.permission_code FROM user_permissions up WHERE up.user_id = $1
         UNION ALL
         SELECT rp.permission_code FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = $1
       ) t`,
      [userId],
    )
    const codes = (rows as Array<{ code: string }>).map((r) => r.code)
    const legacy = await runQuery('SELECT permissions FROM users WHERE id = $1', [userId])
    const legacyRow = (legacy.rows as Array<{ permissions?: unknown }>)[0]
    const legacyPerms = Array.isArray(legacyRow?.permissions) ? (legacyRow.permissions as string[]) : []
    const merged = Array.from(new Set([...codes, ...legacyPerms]))
    return await filterPermissionCodesByNamespaceAdmission(userId, merged, runQuery)
  } catch (error) {
    if (isDatabaseSchemaError(error) && rbacOptionalEnabled()) {
      if (!rbacDegraded) {
        logger.warn('RBAC service degraded - permission tables not found')
        rbacDegraded = true
      }
      return []
    }
    throw error
  }
}

async function readUserPermissionsFromPool(userId: string): Promise<string[]> {
  const { rows } = await pool!.query(
    `SELECT DISTINCT permission_code AS code FROM (
       SELECT up.permission_code FROM user_permissions up WHERE up.user_id = $1
       UNION ALL
       SELECT rp.permission_code FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = $1
     ) t`,
    [userId],
  )
  const codes = rows.map((r: { code: string }) => r.code)
  const legacy = await pool!.query('SELECT permissions FROM users WHERE id = $1', [userId])
  const legacyPerms = Array.isArray(legacy.rows[0]?.permissions) ? legacy.rows[0].permissions : []
  const merged = Array.from(new Set([...codes, ...legacyPerms]))
  return filterPermissionCodesByNamespaceAdmission(userId, merged)
}

export async function listUserPermissions(userId: string, runQuery?: RbacPermissionQueryFn): Promise<string[]> {
  if (typeof runQuery === 'function') return readUserPermissionsOn(userId, runQuery)
  const now = Date.now()
  const key = `perms:${userId}`
  const generation = currentPermCacheGeneration(userId)
  const hit = cache.get(key)
  if (hit && hit.exp > now && hit.generation === generation) {
    metrics.rbacPermCacheHits.inc()
    return hit.codes
  }
  metrics.rbacPermCacheMiss.inc()
  if (!pool) return []
  try {
    const filtered = await readUserPermissionsFromPool(userId)
    if (currentPermCacheGeneration(userId) !== generation) {
      // One bounded retry. If that retry's generation also moves, the codes it
      // read are not a witness for this caller: do not cache them and do not
      // return them. Empty fails closed the current profile; the next caller
      // misses and reads again. Optional-schema errors still use the catch below.
      const retryGeneration = currentPermCacheGeneration(userId)
      const retried = await readUserPermissionsFromPool(userId)
      if (currentPermCacheGeneration(userId) !== retryGeneration) {
        return []
      }
      cache.set(key, { codes: retried, exp: Date.now() + TTL_MS, generation: retryGeneration })
      return retried
    }
    cache.set(key, { codes: filtered, exp: now + TTL_MS, generation })
    return filtered
  } catch (error) {
    if (isDatabaseSchemaError(error) && rbacOptionalEnabled()) {
      if (!rbacDegraded) {
        logger.warn('RBAC service degraded - permission tables not found')
        logger.warn('RBAC queries will return empty results')
        logger.warn('Set RBAC_OPTIONAL=1 environment variable is active')
        rbacDegraded = true
      }
      return []
    }
    throw error
  }
}

export type UserPermissionGrantInspection = {
  direct: string[]
  inherited: string[]
  legacy: string[]
  effective: string[]
  blockedByNamespaceAdmission: string[]
  unavailable?: boolean
}

function uniqueSortedCodes(values: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(values).filter(Boolean))).sort()
}

function codesFromNamedRows(rows: unknown[]): string[] {
  const codes: string[] = []
  for (const row of rows as Array<{ code?: unknown }>) {
    if (typeof row?.code === 'string' && row.code.trim()) codes.push(row.code.trim())
  }
  return uniqueSortedCodes(codes)
}

const EMPTY_PERMISSION_GRANT_INSPECTION: UserPermissionGrantInspection = {
  direct: [],
  inherited: [],
  legacy: [],
  effective: [],
  blockedByNamespaceAdmission: [],
}

/**
 * Admin-console source breakdown for a user's permission codes.
 *
 * `listUserPermissions` stays the authorization aggregator (direct ∪ role ∪ legacy, then
 * namespace-admission filter). This inspector reads the same three sources separately so a
 * grant that is persisted but not effective can be displayed without bypassing or enabling
 * namespace admission.
 */
export async function inspectUserPermissionGrants(
  userId: string,
  runQuery?: RbacPermissionQueryFn,
): Promise<UserPermissionGrantInspection> {
  const exec: RbacPermissionQueryFn = typeof runQuery === 'function'
    ? runQuery
    : async (sql, params) => {
      if (!pool) return { rows: [] }
      return pool.query(sql, params)
    }

  if (typeof runQuery !== 'function' && !pool) {
    return { ...EMPTY_PERMISSION_GRANT_INSPECTION, unavailable: true }
  }

  try {
    const directResult = await exec(
      'SELECT up.permission_code AS code FROM user_permissions up WHERE up.user_id = $1',
      [userId],
    )
    const inheritedResult = await exec(
      `SELECT DISTINCT rp.permission_code AS code
       FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       WHERE ur.user_id = $1`,
      [userId],
    )
    const legacyResult = await exec('SELECT permissions FROM users WHERE id = $1', [userId])
    const direct = codesFromNamedRows(directResult.rows)
    const inherited = codesFromNamedRows(inheritedResult.rows)
    const legacyRow = (legacyResult.rows as Array<{ permissions?: unknown }>)[0]
    const legacy = Array.isArray(legacyRow?.permissions)
      ? uniqueSortedCodes((legacyRow.permissions as unknown[]).map((item) => typeof item === 'string' ? item.trim() : ''))
      : []
    const merged = uniqueSortedCodes([...direct, ...inherited, ...legacy])
    const admission = await inspectPermissionCodesByNamespaceAdmission(userId, merged, runQuery)
    if (admission.unavailable) {
      return { ...EMPTY_PERMISSION_GRANT_INSPECTION, unavailable: true }
    }
    const effective = uniqueSortedCodes(admission.codes)
    const effectiveSet = new Set(effective)
    return {
      direct,
      inherited,
      legacy,
      effective,
      blockedByNamespaceAdmission: merged.filter((code) => !effectiveSet.has(code)),
    }
  } catch (error) {
    if (isDatabaseSchemaError(error) && rbacOptionalEnabled()) {
      if (!rbacDegraded) {
        logger.warn('RBAC service degraded - permission tables not found')
        rbacDegraded = true
      }
      return { ...EMPTY_PERMISSION_GRANT_INSPECTION, unavailable: true }
    }
    throw error
  }
}

export function invalidateUserPerms(userId: string) {
  cache.delete(`perms:${userId}`)
  permCacheGeneration.set(userId, currentPermCacheGeneration(userId) + 1)
}

export function getPermCacheStatus() {
  return {
    cacheSize: cache.size,
    ttlMs: TTL_MS,
    keys: Array.from(cache.keys())
  }
}
