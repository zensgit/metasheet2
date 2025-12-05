/**
 * Table-level RBAC permission checks
 *
 * Provides high-level permission check functions for table read/write access.
 * Integrates with the core RBAC service for permission evaluation.
 */

import { Logger } from '../core/logger'
import { metrics } from '../metrics/metrics'
import { userHasPermission, isAdmin, listUserPermissions } from './service'

const logger = new Logger('TablePerms')

// Permission code patterns for table access
const TABLE_READ_PERMISSION = 'table.read'
const TABLE_WRITE_PERMISSION = 'table.write'
const TABLE_ADMIN_PERMISSION = 'table.admin'

// Environment flag for strict RBAC enforcement
const STRICT_RBAC = process.env.STRICT_RBAC === '1' || process.env.NODE_ENV === 'production'

export interface User {
  id: string
  roles?: string[]
  permissions?: string[]
}

/**
 * Check if user can read from a table
 * @param user User object with id, roles, and permissions
 * @param tableId Table ID to check access for
 * @returns Promise<boolean> true if user has read access
 */
export async function canReadTable(user: User, tableId: string): Promise<boolean> {
  const start = process.hrtime.bigint()
  try {
    // Must have a valid user ID
    if (!user?.id) {
      logger.warn(`Read access denied: no user ID provided for table ${tableId}`)
      try {
        metrics.rbacPermissionChecksTotal.labels('read', 'deny').inc()
      } catch { /* metrics unavailable */ }
      return false
    }

    // Check if user is admin (admins can access all tables)
    const userIsAdmin = await isAdmin(user.id)
    if (userIsAdmin) {
      logger.debug(`Read access granted: user ${user.id} is admin for table ${tableId}`)
      try {
        metrics.rbacPermissionChecksTotal.labels('read', 'allow').inc()
      } catch { /* metrics unavailable */ }
      return true
    }

    // Check for table-specific read permission: table.read.{tableId}
    const specificPermission = `${TABLE_READ_PERMISSION}.${tableId}`
    const hasSpecificPerm = await userHasPermission(user.id, specificPermission)
    if (hasSpecificPerm) {
      logger.debug(`Read access granted: user ${user.id} has ${specificPermission}`)
      try {
        metrics.rbacPermissionChecksTotal.labels('read', 'allow').inc()
      } catch { /* metrics unavailable */ }
      return true
    }

    // Check for wildcard read permission: table.read.*
    const wildcardPermission = `${TABLE_READ_PERMISSION}.*`
    const hasWildcardPerm = await userHasPermission(user.id, wildcardPermission)
    if (hasWildcardPerm) {
      logger.debug(`Read access granted: user ${user.id} has ${wildcardPermission}`)
      try {
        metrics.rbacPermissionChecksTotal.labels('read', 'allow').inc()
      } catch { /* metrics unavailable */ }
      return true
    }

    // Check for general table read permission: table.read
    const hasGeneralPerm = await userHasPermission(user.id, TABLE_READ_PERMISSION)
    if (hasGeneralPerm) {
      logger.debug(`Read access granted: user ${user.id} has ${TABLE_READ_PERMISSION}`)
      try {
        metrics.rbacPermissionChecksTotal.labels('read', 'allow').inc()
      } catch { /* metrics unavailable */ }
      return true
    }

    // In non-strict mode, allow authenticated users if no RBAC tables exist
    if (!STRICT_RBAC) {
      // Check if user has any permissions cached
      const userPerms = await listUserPermissions(user.id)
      if (userPerms.length === 0) {
        // RBAC tables may not be set up - allow access in non-strict mode
        logger.warn(`Read access granted in non-strict mode: no RBAC permissions found for user ${user.id}`)
        try {
          metrics.rbacPermissionChecksTotal.labels('read', 'allow').inc()
        } catch { /* metrics unavailable */ }
        return true
      }
    }

    // Deny access by default (fail closed)
    logger.info(`Read access denied: user ${user.id} lacks permission for table ${tableId}`)
    try {
      metrics.rbacPermissionChecksTotal.labels('read', 'deny').inc()
    } catch { /* metrics unavailable */ }
    return false
  } catch (error: unknown) {
    logger.error(`Error checking read permission for table ${tableId}:`, error as Error)
    try {
      metrics.rbacPermissionChecksTotal.labels('read', 'error').inc()
    } catch { /* metrics unavailable */ }
    // Fail closed: deny access on error
    return false
  } finally {
    try {
      const dur = Number((process.hrtime.bigint() - start)) / 1e9
      metrics.rbacCheckLatencySeconds.labels('read').observe(dur)
    } catch { /* metrics unavailable */ }
  }
}

/**
 * Check if user can write to a table
 * @param user User object with id, roles, and permissions
 * @param tableId Table ID to check access for
 * @returns Promise<boolean> true if user has write access
 */
export async function canWriteTable(user: User, tableId: string): Promise<boolean> {
  const start = process.hrtime.bigint()
  try {
    // Must have a valid user ID
    if (!user?.id) {
      logger.warn(`Write access denied: no user ID provided for table ${tableId}`)
      try {
        metrics.rbacPermissionChecksTotal.labels('write', 'deny').inc()
      } catch { /* metrics unavailable */ }
      return false
    }

    // Check if user is admin (admins can access all tables)
    const userIsAdmin = await isAdmin(user.id)
    if (userIsAdmin) {
      logger.debug(`Write access granted: user ${user.id} is admin for table ${tableId}`)
      try {
        metrics.rbacPermissionChecksTotal.labels('write', 'allow').inc()
      } catch { /* metrics unavailable */ }
      return true
    }

    // Check for table admin permission: table.admin.{tableId}
    const adminPermission = `${TABLE_ADMIN_PERMISSION}.${tableId}`
    const hasAdminPerm = await userHasPermission(user.id, adminPermission)
    if (hasAdminPerm) {
      logger.debug(`Write access granted: user ${user.id} has ${adminPermission}`)
      try {
        metrics.rbacPermissionChecksTotal.labels('write', 'allow').inc()
      } catch { /* metrics unavailable */ }
      return true
    }

    // Check for table-specific write permission: table.write.{tableId}
    const specificPermission = `${TABLE_WRITE_PERMISSION}.${tableId}`
    const hasSpecificPerm = await userHasPermission(user.id, specificPermission)
    if (hasSpecificPerm) {
      logger.debug(`Write access granted: user ${user.id} has ${specificPermission}`)
      try {
        metrics.rbacPermissionChecksTotal.labels('write', 'allow').inc()
      } catch { /* metrics unavailable */ }
      return true
    }

    // Check for wildcard write permission: table.write.*
    const wildcardPermission = `${TABLE_WRITE_PERMISSION}.*`
    const hasWildcardPerm = await userHasPermission(user.id, wildcardPermission)
    if (hasWildcardPerm) {
      logger.debug(`Write access granted: user ${user.id} has ${wildcardPermission}`)
      try {
        metrics.rbacPermissionChecksTotal.labels('write', 'allow').inc()
      } catch { /* metrics unavailable */ }
      return true
    }

    // Check for general table write permission: table.write
    const hasGeneralPerm = await userHasPermission(user.id, TABLE_WRITE_PERMISSION)
    if (hasGeneralPerm) {
      logger.debug(`Write access granted: user ${user.id} has ${TABLE_WRITE_PERMISSION}`)
      try {
        metrics.rbacPermissionChecksTotal.labels('write', 'allow').inc()
      } catch { /* metrics unavailable */ }
      return true
    }

    // In non-strict mode, allow authenticated users if no RBAC tables exist
    if (!STRICT_RBAC) {
      const userPerms = await listUserPermissions(user.id)
      if (userPerms.length === 0) {
        // RBAC tables may not be set up - allow access in non-strict mode
        logger.warn(`Write access granted in non-strict mode: no RBAC permissions found for user ${user.id}`)
        try {
          metrics.rbacPermissionChecksTotal.labels('write', 'allow').inc()
        } catch { /* metrics unavailable */ }
        return true
      }
    }

    // Deny access by default (fail closed)
    logger.info(`Write access denied: user ${user.id} lacks permission for table ${tableId}`)
    try {
      metrics.rbacPermissionChecksTotal.labels('write', 'deny').inc()
    } catch { /* metrics unavailable */ }
    return false
  } catch (error: unknown) {
    logger.error(`Error checking write permission for table ${tableId}:`, error as Error)
    try {
      metrics.rbacPermissionChecksTotal.labels('write', 'error').inc()
    } catch { /* metrics unavailable */ }
    // Fail closed: deny access on error
    return false
  } finally {
    try {
      const dur = Number((process.hrtime.bigint() - start)) / 1e9
      metrics.rbacCheckLatencySeconds.labels('write').observe(dur)
    } catch { /* metrics unavailable */ }
  }
}
