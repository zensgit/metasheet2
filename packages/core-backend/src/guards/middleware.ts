/**
 * SafetyGuard Express Middleware
 *
 * Provides middleware for protecting dangerous API endpoints
 */

import type { Request, Response, NextFunction } from 'express';
import { getSafetyGuard } from './SafetyGuard';
import type { OperationType, RiskAssessment } from './types';
import { type OperationContext, RiskLevel } from './types';

/**
 * Build accurate client instructions for completing a blocked operation.
 *
 * The confirmation flow is TWO steps for anything needing a typed phrase or an acknowledgment: first
 * POST /api/admin/safety/confirm with the token (plus the typed phrase for double-confirm ops and/or
 * `acknowledged: true` for HIGH/CRITICAL ops), THEN retry the ORIGINAL operation with the same token in
 * the X-Safety-Token header — the retry never carries the typed phrase/acknowledgment. A MEDIUM op needs
 * neither, so a single retry with the token suffices.
 */
function buildConfirmInstructions(operation: OperationType, assessment: RiskAssessment): string {
  const needsConfirmStep =
    assessment.requiresDoubleConfirm ||
    assessment.riskLevel === RiskLevel.HIGH ||
    assessment.riskLevel === RiskLevel.CRITICAL;

  if (!needsConfirmStep) {
    return 'Retry this operation with the same token in the X-Safety-Token header.';
  }

  const confirmBody = assessment.requiresDoubleConfirm
    ? `{ token, typedConfirmation: "${operation}", acknowledged: true }`
    : '{ token, acknowledged: true }';
  return (
    `First POST /api/admin/safety/confirm with ${confirmBody}, then retry this operation with the same ` +
    'token in the X-Safety-Token header.'
  );
}

// Extend Express Request type
interface SafetyRequest extends Request {
  safetyContext?: {
    operation: OperationType;
    checkResult?: unknown;
  };
  user?: { id?: string; email?: string };
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
    const safetyReq = req as SafetyRequest;

    // Extract initiator from request
    const initiator =
      safetyReq.user?.id ||
      safetyReq.user?.email ||
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
    safetyReq.safetyContext = {
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
              instructions: buildConfirmInstructions(options.operation, result.assessment)
            }
          : undefined
      });
    }
  };
}

/**
 * API endpoint for confirming dangerous operations. This is step ONE of the two-step flow: it validates
 * the typed phrase / acknowledgment and marks the token confirmed, but does NOT execute the operation —
 * the caller then retries the original operation with the same token in the X-Safety-Token header.
 *
 * POST /api/admin/safety/confirm
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

    // BINDING (GHSA): confirm on behalf of the AUTHENTICATED principal only. verifyConfirmation rejects
    // the token if this initiator does not match the one that minted it, so an admin cannot confirm
    // another admin's pending operation. The route mounting this handler is platform-admin gated, so
    // req.user.id is present.
    const initiator =
      (req as SafetyRequest).user?.id || (req as SafetyRequest).user?.email;

    const verification = safetyGuard.verifyConfirmation({
      token,
      typedConfirmation,
      acknowledged,
      initiator
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
