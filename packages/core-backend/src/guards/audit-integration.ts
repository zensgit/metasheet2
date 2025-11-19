/**
 * SafetyGuard Audit & RBAC Integration
 *
 * Provides audit logging and RBAC enforcement for protected operations.
 */

import type { Request, Response, NextFunction } from 'express';
import { pool } from '../db/pg';
import { isAdmin } from '../rbac/service';
import { Logger } from '../core/logger';
import { OperationType } from './types';
import * as metrics from './safety-metrics';

const logger = new Logger('SafetyGuardAudit');

interface AuditEntry {
  operationType: OperationType;
  userId: string;
  userEmail?: string;
  userIp: string;
  riskLevel: string;
  action: 'blocked' | 'confirmed' | 'executed' | 'denied';
  details?: Record<string, unknown>;
  safetyToken?: string;
  timestamp: Date;
}

/**
 * Log operation to audit table
 * Uses existing operation_audit_logs schema with metadata JSONB
 */
export async function logSafetyOperation(entry: AuditEntry): Promise<void> {
  if (!pool) {
    logger.warn('Audit logging skipped: no database pool', {
      context: 'SafetyGuardAudit',
      operation: entry.operationType
    });
    return;
  }

  try {
    // Build metadata object for JSONB storage
    const metadata = {
      operation_type: entry.operationType,
      user_email: entry.userEmail,
      risk_level: entry.riskLevel,
      safety_action: entry.action,
      safety_token_prefix: entry.safetyToken
        ? entry.safetyToken.substring(0, 20)
        : null,
      ...entry.details
    };

    await pool.query(
      `INSERT INTO operation_audit_logs (
        actor_id,
        actor_type,
        action,
        resource_type,
        resource_id,
        metadata,
        created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.userId,
        'user',
        `safety_guard:${entry.action}`,
        'admin_operation',
        entry.operationType,
        JSON.stringify({ ...metadata, ip: entry.userIp }),
        entry.timestamp
      ]
    );

    logger.info('Operation audited', {
      context: 'SafetyGuardAudit',
      operation: entry.operationType,
      action: entry.action,
      userId: entry.userId
    });
  } catch (error) {
    // Don't fail the operation if audit logging fails
    logger.error('Failed to log audit entry', error as Error);
  }
}

/**
 * Middleware to enforce admin role for protected endpoints
 */
export function requireAdminRole() {
  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const user = (req as Request & { user?: { id?: string; email?: string } })
      .user;

    if (!user?.id) {
      logger.warn('Admin access denied: no user in request', {
        context: 'SafetyGuardAudit',
        path: req.path,
        ip: req.ip
      });

      // Log denial
      await logSafetyOperation({
        operationType: 'unknown' as OperationType,
        userId: 'anonymous',
        userIp: req.ip || 'unknown',
        riskLevel: 'denied',
        action: 'denied',
        details: { path: req.path, reason: 'no_user' },
        timestamp: new Date()
      });

      res.status(403).json({
        error: 'AccessDenied',
        code: 'ADMIN_REQUIRED',
        message: 'This operation requires admin privileges'
      });
      return;
    }

    try {
      const hasAdminRole = await isAdmin(user.id);

      if (!hasAdminRole) {
        logger.warn('Admin access denied: user is not admin', {
          context: 'SafetyGuardAudit',
          userId: user.id,
          path: req.path,
          ip: req.ip
        });

        // Log denial
        await logSafetyOperation({
          operationType: 'unknown' as OperationType,
          userId: user.id,
          userEmail: user.email,
          userIp: req.ip || 'unknown',
          riskLevel: 'denied',
          action: 'denied',
          details: { path: req.path, reason: 'not_admin' },
          timestamp: new Date()
        });

        metrics.recordBlockedOperation('admin_access', 'insufficient_privileges');

        res.status(403).json({
          error: 'AccessDenied',
          code: 'ADMIN_REQUIRED',
          message: 'This operation requires admin privileges'
        });
        return;
      }

      logger.debug('Admin access granted', {
        context: 'SafetyGuardAudit',
        userId: user.id,
        path: req.path
      });

      next();
    } catch (error) {
      const err = error as Error;
      logger.error('RBAC check failed', err);

      // In case of RBAC service failure, deny by default (fail-safe)
      res.status(503).json({
        error: 'ServiceUnavailable',
        code: 'RBAC_CHECK_FAILED',
        message: 'Unable to verify admin privileges'
      });
    }
  };
}

/**
 * Middleware to audit SafetyGuard operations after execution
 */
export function auditSafetyOperation(operationType: OperationType) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const user = (req as Request & { user?: { id?: string; email?: string } })
      .user;
    const safetyContext = (req as any).safetyContext;

    // Capture original JSON response
    const originalJson = res.json.bind(res);
    res.json = (body: any) => {
      // Log after response is sent
      setImmediate(async () => {
        try {
          const action =
            res.statusCode >= 200 && res.statusCode < 300
              ? 'executed'
              : res.statusCode === 403
                ? 'blocked'
                : 'denied';

          await logSafetyOperation({
            operationType,
            userId: user?.id || 'anonymous',
            userEmail: user?.email,
            userIp: req.ip || 'unknown',
            riskLevel: safetyContext?.checkResult?.assessment?.riskLevel || 'unknown',
            action,
            details: {
              statusCode: res.statusCode,
              path: req.path,
              method: req.method,
              params: req.params,
              bodyKeys: Object.keys(req.body || {})
            },
            safetyToken: req.headers['x-safety-token'] as string,
            timestamp: new Date()
          });
        } catch (error) {
          logger.error('Post-response audit failed', error as Error);
        }
      });

      return originalJson(body);
    };

    next();
  };
}

/**
 * Combined middleware: RBAC + Audit
 * Use before requireSafetyCheck for complete protection
 */
export function protectAdminOperation(operationType: OperationType) {
  return [requireAdminRole(), auditSafetyOperation(operationType)];
}
