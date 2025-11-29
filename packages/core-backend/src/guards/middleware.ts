// @ts-nocheck
/**
 * SafetyGuard Express Middleware
 *
 * Provides middleware for protecting dangerous API endpoints
 */

import type { Request, Response, NextFunction } from 'express';
import { getSafetyGuard } from './SafetyGuard';
import { OperationType, type OperationContext } from './types';

declare module 'express-serve-static-core' {
  interface Request {
    safetyContext?: {
      operation: OperationType;
      checkResult?: ReturnType<typeof getSafetyGuard>['checkOperation'];
    };
  }
}

export interface SafetyMiddlewareOptions {
  operation: OperationType;
  getDetails?: (req: Request) => Record<string, unknown>;
}

/**
 * Middleware factory for protecting dangerous operations
 *
 * Usage:
 * ```
 * app.delete('/api/tables/:id',
 *   requireSafetyCheck({ operation: OperationType.DROP_TABLE }),
 *   (req, res) => { ... }
 * )
 * ```
 */
export function requireSafetyCheck(options: SafetyMiddlewareOptions) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const safetyGuard = getSafetyGuard();

    // Extract initiator from request
    const initiator =
      (req as Request & { user?: { id?: string; email?: string } }).user
        ?.id ||
      (req as Request & { user?: { id?: string; email?: string } }).user
        ?.email ||
      req.ip ||
      'unknown';

    // Build operation context
    const context: OperationContext = {
      operation: options.operation,
      initiator,
      details: options.getDetails ? options.getDetails(req) : undefined,
      timestamp: new Date(),
      confirmationToken:
        (req.headers['x-safety-token'] as string) ||
        (req.body && req.body._safetyToken)
    };

    // Check operation
    const result = await safetyGuard.checkOperation(context);

    // Store in request for downstream handlers
    req.safetyContext = {
      operation: options.operation,
      checkResult: result
    };

    if (result.allowed) {
      next();
    } else {
      // Return safety check result to client
      res.status(403).json({
        error: 'SafetyCheck',
        code: 'SAFETY_CHECK_REQUIRED',
        message: result.blockedReason || 'Operation requires confirmation',
        assessment: {
          riskLevel: result.assessment.riskLevel,
          requiresConfirmation: result.assessment.requiresConfirmation,
          requiresDoubleConfirm: result.assessment.requiresDoubleConfirm,
          riskDescription: result.assessment.riskDescription,
          safeguards: result.assessment.safeguards,
          impact: result.assessment.impact
        },
        confirmation: result.confirmationToken
          ? {
              token: result.confirmationToken,
              expiresAt: result.tokenExpiry,
              instructions: result.assessment.requiresDoubleConfirm
                ? `To confirm, send another request with the token and type "${options.operation}" as confirmation`
                : 'To confirm, send another request with the token and acknowledged: true'
            }
          : undefined
      });
    }
  };
}

/**
 * API endpoint for confirming dangerous operations
 *
 * POST /api/safety/confirm
 * Body: { token: string, typedConfirmation?: string, acknowledged?: boolean }
 */
export function createSafetyConfirmEndpoint() {
  return (req: Request, res: Response): void => {
    const safetyGuard = getSafetyGuard();

    const { token, typedConfirmation, acknowledged } = req.body;

    if (!token) {
      res.status(400).json({
        error: 'ValidationError',
        message: 'Confirmation token is required'
      });
      return;
    }

    const verification = safetyGuard.verifyConfirmation({
      token,
      typedConfirmation,
      acknowledged
    });

    if (verification.valid) {
      res.json({
        success: true,
        message: 'Confirmation accepted. You can now retry the operation with the same token.'
      });
    } else {
      res.status(400).json({
        error: 'ConfirmationFailed',
        message: verification.reason
      });
    }
  };
}

/**
 * Get safety guard status endpoint
 *
 * GET /api/safety/status
 */
export function createSafetyStatusEndpoint() {
  return (_req: Request, res: Response): void => {
    const safetyGuard = getSafetyGuard();

    res.json({
      enabled: safetyGuard.isEnabled(),
      pendingConfirmations: safetyGuard.getPendingCount()
    });
  };
}
