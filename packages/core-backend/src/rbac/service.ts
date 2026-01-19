import { pool } from '../db/pg'
import { metrics } from '../metrics/metrics'
import { Logger } from '../core/logger'
import { isDatabaseSchemaError } from '../utils/database-errors'

const logger = new Logger('RBACService')

const cache = new Map<string, { codes: string[]; exp: number }>()
const TTL_MS = parseInt(process.env.RBAC_CACHE_TTL_MS || '60000', 10)

// Graceful degradation for missing RBAC tables (Phase B)
let rbacDegraded = false
const allowDegradation = process.env.RBAC_OPTIONAL === '1'

export async function isAdmin(userId: string): Promise<boolean> {
  if (!pool) return false
  try {
    const { rows } = await pool.query('SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2 LIMIT 1', [userId, 'admin'])
    return rows.length > 0
  } catch (error) {
    if (isDatabaseSchemaError(error) && allowDegradation) {
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
    if (isDatabaseSchemaError(error) && allowDegradation) {
      if (!rbacDegraded) {
        logger.warn('RBAC service degraded - permission tables not found')
        rbacDegraded = true
      }
      return false
    }
    throw error
  }
}

export async function listUserPermissions(userId: string): Promise<string[]> {
  const now = Date.now()
  const key = `perms:${userId}`
  const hit = cache.get(key)
  if (hit && hit.exp > now) {
    metrics.rbacPermCacheHits.inc()
    return hit.codes
  }
  metrics.rbacPermCacheMiss.inc()
  if (!pool) return []
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT permission_code AS code FROM (
         SELECT up.permission_code FROM user_permissions up WHERE up.user_id = $1
         UNION ALL
         SELECT rp.permission_code FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = $1
       ) t`,
      [userId]
    )
    const codes = rows.map((r: { code: string }) => r.code)
    const legacy = await pool.query('SELECT permissions FROM users WHERE id = $1', [userId])
    const legacyPerms = Array.isArray(legacy.rows[0]?.permissions) ? legacy.rows[0].permissions : []
    const merged = Array.from(new Set([...codes, ...legacyPerms]))
    cache.set(key, { codes: merged, exp: now + TTL_MS })
    return merged
  } catch (error) {
    if (isDatabaseSchemaError(error) && allowDegradation) {
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

export function invalidateUserPerms(userId: string) {
  cache.delete(`perms:${userId}`)
}

export function getPermCacheStatus() {
  return {
    cacheSize: cache.size,
    ttlMs: TTL_MS,
    keys: Array.from(cache.keys())
  }
}
