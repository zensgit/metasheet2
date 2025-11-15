/**
 * Permission Metrics Middleware
 * Issue #35: Integrates permission checking with metrics collection
 */

import { Request, Response, NextFunction } from 'express'
import { permissionMetrics } from '../metrics/permission-metrics'

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string
    role: string
    department?: string
    permissions?: string[]
  }
  startTime?: number
}

/**
 * Middleware to track permission metrics
 */
export class PermissionMetricsMiddleware {
  /**
   * Track request timing
   */
  static startTimer(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
    req.startTime = Date.now()
    next()
  }

  /**
   * Track authentication failures
   */
  static trackAuthFailure(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): void {
    // Hook into response to track 401/403 responses
    const originalSend = res.send

    res.send = function(data: any): Response {
      const statusCode = res.statusCode

      if (statusCode === 401) {
        const reason = req.headers.authorization ? 'invalid_token' : 'no_token'
        permissionMetrics.incrementAuthFailure(reason, req.path, req.method)
        permissionMetrics.incrementApiRequest(req.path, req.method, 401)
      } else if (statusCode === 403) {
        const reason = data?.reason || 'permission_denied'
        permissionMetrics.incrementAuthFailure(reason, req.path, req.method)
        permissionMetrics.incrementApiRequest(req.path, req.method, 403)

        // If we have user info, track RBAC denial
        if (req.user) {
          const resourceType = extractResourceType(req.path)
          const action = mapMethodToAction(req.method)
          permissionMetrics.incrementRbacDenial(
            resourceType,
            action,
            req.user.role,
            reason
          )
        }
      }

      // Track successful requests
      if (statusCode >= 200 && statusCode < 300) {
        permissionMetrics.incrementApiRequest(req.path, req.method, statusCode)
      }

      // Track permission check duration
      if (req.startTime) {
        const duration = Date.now() - req.startTime
        const resourceType = extractResourceType(req.path)
        const action = mapMethodToAction(req.method)
        permissionMetrics.recordPermissionCheckDuration(resourceType, action, duration)
      }

      return originalSend.call(this, data)
    }

    next()
  }

  /**
   * Track token validation
   */
  static async validateToken(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const authHeader = req.headers.authorization

    if (!authHeader) {
      permissionMetrics.incrementTokenValidation(false, 'missing_header')
      res.status(401).json({ error: 'No authorization header' })
      return
    }

    const token = authHeader.replace('Bearer ', '')

    try {
      // Simulated token validation
      const decoded = await validateJWT(token)

      if (isTokenExpired(decoded)) {
        permissionMetrics.incrementTokenValidation(false, 'token_expired')
        permissionMetrics.incrementAuthFailure('token_expired', req.path, req.method)
        res.status(401).json({ error: 'Token expired' })
        return
      }

      if (isTokenRevoked(token)) {
        permissionMetrics.incrementTokenValidation(false, 'token_revoked')
        permissionMetrics.incrementAuthFailure('token_revoked', req.path, req.method)
        res.status(401).json({ error: 'Token revoked' })
        return
      }

      // Token is valid
      permissionMetrics.incrementTokenValidation(true)
      req.user = decoded.user
      next()
    } catch (error) {
      permissionMetrics.incrementTokenValidation(false, 'invalid_token')
      permissionMetrics.incrementAuthFailure('invalid_token', req.path, req.method)
      res.status(401).json({ error: 'Invalid token' })
      return
    }
  }

  /**
   * Check RBAC permissions
   */
  static checkPermission(requiredPermission: string) {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
      if (!req.user) {
        permissionMetrics.incrementAuthFailure('no_user', req.path, req.method)
        res.status(401).json({ error: 'Not authenticated' })
        return
      }

      const hasPermission = checkUserPermission(req.user, requiredPermission)

      if (!hasPermission) {
        const [resource, action] = requiredPermission.split(':')
        permissionMetrics.incrementRbacDenial(
          resource,
          action,
          req.user.role,
          'insufficient_permission'
        )
        res.status(403).json({
          error: 'Insufficient permissions',
          reason: 'insufficient_permission',
          required: requiredPermission
        })
        return
      }

      // Check cache performance
      const cacheHit = Math.random() > 0.3 // Simulate 70% cache hit rate
      permissionMetrics.incrementPermissionCache(cacheHit)

      next()
    }
  }

  /**
   * Check department-based access
   */
  static checkDepartmentAccess(allowedDepartments: string[]) {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
      if (!req.user?.department) {
        permissionMetrics.incrementAuthFailure('no_department', req.path, req.method)
        res.status(403).json({ error: 'Department information missing' })
        return
      }

      if (!allowedDepartments.includes(req.user.department)) {
        const resourceType = extractResourceType(req.path)
        const action = mapMethodToAction(req.method)

        permissionMetrics.incrementDepartmentDenial(
          req.user.department,
          resourceType,
          action
        )
        permissionMetrics.incrementRbacDenial(
          resourceType,
          action,
          req.user.role,
          'department_restricted'
        )

        res.status(403).json({
          error: 'Department not authorized',
          reason: 'department_restricted'
        })
        return
      }

      next()
    }
  }

  /**
   * Export metrics endpoint
   */
  static metricsEndpoint(req: Request, res: Response): void {
    const metrics = permissionMetrics.toPrometheusFormat()
    res.set('Content-Type', 'text/plain; version=0.0.4')
    res.send(metrics)
  }

  /**
   * Session tracking
   */
  static trackSession(action: 'login' | 'logout'): void {
    // In production, this would track actual session count
    const currentSessions = Math.floor(Math.random() * 100) + 1
    permissionMetrics.setActiveSessions(currentSessions)
  }
}

// Helper functions
function extractResourceType(path: string): string {
  const segments = path.split('/').filter(Boolean)
  if (segments.length > 1) {
    return segments[1] // e.g., /api/spreadsheets -> spreadsheets
  }
  return 'unknown'
}

function mapMethodToAction(method: string): string {
  const mapping: Record<string, string> = {
    GET: 'read',
    POST: 'create',
    PUT: 'update',
    PATCH: 'update',
    DELETE: 'delete'
  }
  return mapping[method.toUpperCase()] || 'unknown'
}

async function validateJWT(token: string): Promise<any> {
  // Simulated JWT validation
  if (token === 'expired-token') {
    return { exp: Date.now() / 1000 - 3600, user: { id: 'test', role: 'viewer' } }
  }
  if (token === 'invalid-token' || token.startsWith('malformed')) {
    throw new Error('Invalid token')
  }
  return {
    exp: Date.now() / 1000 + 3600,
    user: {
      id: 'user123',
      role: 'editor',
      department: 'engineering',
      permissions: ['spreadsheet:read', 'spreadsheet:write']
    }
  }
}

function isTokenExpired(decoded: any): boolean {
  if (!decoded.exp) return false
  return decoded.exp < Date.now() / 1000
}

function isTokenRevoked(token: string): boolean {
  // Simulated revocation check
  const revokedTokens = ['revoked-token-123', 'blacklisted-token-456']
  return revokedTokens.includes(token)
}

function checkUserPermission(user: any, requiredPermission: string): boolean {
  // Role-based permission mapping
  const rolePermissions: Record<string, string[]> = {
    admin: ['admin:read', 'admin:write', 'spreadsheet:all', 'workflow:all'],
    editor: ['spreadsheet:read', 'spreadsheet:write', 'workflow:read'],
    viewer: ['spreadsheet:read', 'workflow:read']
  }

  const userPermissions = [
    ...(rolePermissions[user.role] || []),
    ...(user.permissions || [])
  ]

  // Check if user has the required permission
  if (userPermissions.includes(requiredPermission)) {
    return true
  }

  // Check wildcard permissions
  const [resource, action] = requiredPermission.split(':')
  return userPermissions.includes(`${resource}:all`) || userPermissions.includes('*:*')
}

export default PermissionMetricsMiddleware