/**
 * SafetyGuard Service
 *
 * Provides safety checks and confirmation flows for dangerous operations.
 * Implements double-confirm pattern for high-risk actions.
 * Sprint 2: Integrated with Protection Rule Engine
 */

import crypto from 'crypto';
import {
  type OperationContext,
  type RiskAssessment,
  type SafetyCheckResult,
  type SafetyGuardConfig,
  type ConfirmationRequest,
  RiskLevel,
  OperationType
} from './types';
import * as metrics from './safety-metrics';
import { Logger } from '../core/logger';
import { protectionRuleService } from '../services/ProtectionRuleService';

const logger = new Logger('SafetyGuard');

interface PendingConfirmation {
  context: OperationContext;
  assessment: RiskAssessment;
  createdAt: Date;
  expiresAt: Date;
  confirmed?: boolean; // Set to true after user confirms
}

const DEFAULT_CONFIG: SafetyGuardConfig = {
  enabled: true,
  allowBypass: false,
  tokenExpirationSeconds: 300, // 5 minutes
  doubleConfirmOperations: [
    OperationType.DROP_TABLE,
    OperationType.TRUNCATE_TABLE,
    OperationType.SHUTDOWN_SERVICE,
    OperationType.RESTORE_SNAPSHOT,
    OperationType.RELOAD_ALL_PLUGINS
  ],
  blockedOperations: []
};

// Risk classification map
const RISK_MAP: Record<OperationType, RiskLevel> = {
  // Critical operations
  [OperationType.DROP_TABLE]: RiskLevel.CRITICAL,
  [OperationType.TRUNCATE_TABLE]: RiskLevel.CRITICAL,
  [OperationType.SHUTDOWN_SERVICE]: RiskLevel.CRITICAL,
  [OperationType.RESTORE_SNAPSHOT]: RiskLevel.CRITICAL,

  // High risk operations
  [OperationType.DELETE_DATA]: RiskLevel.HIGH,
  [OperationType.BULK_UPDATE]: RiskLevel.HIGH,
  [OperationType.RELOAD_ALL_PLUGINS]: RiskLevel.HIGH,
  [OperationType.CLEANUP_SNAPSHOTS]: RiskLevel.HIGH,
  [OperationType.ALTER_SCHEMA]: RiskLevel.HIGH,
  [OperationType.DROP_COLUMN]: RiskLevel.HIGH,

  // Medium risk operations
  [OperationType.UNLOAD_PLUGIN]: RiskLevel.MEDIUM,
  [OperationType.FORCE_RELOAD]: RiskLevel.MEDIUM,
  [OperationType.DELETE_SNAPSHOT]: RiskLevel.MEDIUM,
  [OperationType.RENAME_COLUMN]: RiskLevel.MEDIUM,
  [OperationType.CLEAR_CACHE]: RiskLevel.MEDIUM,

  // Low risk operations
  [OperationType.RESET_METRICS]: RiskLevel.LOW
};

export class SafetyGuard {
  private config: SafetyGuardConfig;
  private pendingConfirmations: Map<string, PendingConfirmation>;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: Partial<SafetyGuardConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.pendingConfirmations = new Map();

    // Start cleanup interval for expired tokens
    this.startCleanupInterval();

    logger.info('SafetyGuard initialized', {
      context: 'SafetyGuard',
      enabled: this.config.enabled,
      doubleConfirmOps: this.config.doubleConfirmOperations.length
    });
  }

  /**
   * Check if an operation is safe to proceed
   * Sprint 2: Now async to support protection rule evaluation
   */
  async checkOperation(context: OperationContext): Promise<SafetyCheckResult> {
    // If disabled, allow everything
    if (!this.config.enabled) {
      return {
        allowed: true,
        assessment: await this.assessRisk(context)
      };
    }

    // Check if operation is blocked by config
    if (this.config.blockedOperations.includes(context.operation)) {
      const assessment = await this.assessRisk(context);
      metrics.recordDangerousOperation(
        context.operation,
        assessment.riskLevel,
        'blocked'
      );
      metrics.recordBlockedOperation(context.operation, 'blocked_by_policy');

      return {
        allowed: false,
        assessment,
        blockedReason: `Operation ${context.operation} is blocked by security policy`
      };
    }

    // Assess the risk (includes protection rule evaluation)
    const assessment = await this.assessRisk(context);

    // Sprint 2: Check if blocked by protection rule
    if (context.details?.ruleBlocked) {
      metrics.recordDangerousOperation(
        context.operation,
        assessment.riskLevel,
        'blocked'
      );
      metrics.recordBlockedOperation(context.operation, 'blocked_by_rule');

      return {
        allowed: false,
        assessment,
        blockedReason: (context.details.ruleBlockReason as string) || 'Operation blocked by protection rule'
      };
    }

    // If has confirmation token, verify it
    if (context.confirmationToken) {
      const verification = this.verifyConfirmation({
        token: context.confirmationToken
      });

      if (verification.valid) {
        metrics.recordDangerousOperation(
          context.operation,
          assessment.riskLevel,
          'allowed'
        );
        metrics.recordConfirmedOperation(context.operation);

        // Calculate and record delay
        const pending = this.pendingConfirmations.get(
          context.confirmationToken
        );
        if (pending) {
          const delaySeconds =
            (Date.now() - pending.createdAt.getTime()) / 1000;
          metrics.recordConfirmationDelay(context.operation, delaySeconds);
          this.pendingConfirmations.delete(context.confirmationToken);
          metrics.updatePendingConfirmations(this.pendingConfirmations.size);
        }

        return {
          allowed: true,
          assessment
        };
      }

      return {
        allowed: false,
        assessment,
        blockedReason: verification.reason
      };
    }

    // Check if confirmation is required
    if (assessment.requiresConfirmation) {
      const token = this.generateConfirmationToken();
      const expiresAt = new Date(
        Date.now() + this.config.tokenExpirationSeconds * 1000
      );

      // Store pending confirmation
      this.pendingConfirmations.set(token, {
        context,
        assessment,
        createdAt: new Date(),
        expiresAt
      });

      metrics.updatePendingConfirmations(this.pendingConfirmations.size);
      metrics.recordDangerousOperation(
        context.operation,
        assessment.riskLevel,
        'pending_confirmation'
      );
      metrics.recordConfirmationRequest(
        context.operation,
        assessment.requiresDoubleConfirm
      );

      logger.warn('Dangerous operation requires confirmation', {
        context: 'SafetyGuard',
        operation: context.operation,
        riskLevel: assessment.riskLevel,
        initiator: context.initiator,
        requiresDoubleConfirm: assessment.requiresDoubleConfirm
      });

      return {
        allowed: false,
        assessment,
        blockedReason: 'Operation requires confirmation',
        confirmationToken: token,
        tokenExpiry: expiresAt
      };
    }

    // Low risk operation, allow immediately
    metrics.recordDangerousOperation(
      context.operation,
      assessment.riskLevel,
      'allowed'
    );

    return {
      allowed: true,
      assessment
    };
  }

  /**
   * Verify a confirmation request
   */
  verifyConfirmation(request: ConfirmationRequest): {
    valid: boolean;
    reason?: string;
  } {
    const pending = this.pendingConfirmations.get(request.token);

    if (!pending) {
      return { valid: false, reason: 'Invalid or expired confirmation token' };
    }

    // Check expiration
    if (new Date() > pending.expiresAt) {
      this.pendingConfirmations.delete(request.token);
      metrics.updatePendingConfirmations(this.pendingConfirmations.size);
      return { valid: false, reason: 'Confirmation token has expired' };
    }

    // Check double-confirm requirement
    if (pending.assessment.requiresDoubleConfirm) {
      if (!request.typedConfirmation) {
        return {
          valid: false,
          reason: `Double confirmation required. Please type "${pending.context.operation}" to confirm`
        };
      }

      // Normalize and compare
      const expected = pending.context.operation.toLowerCase().replace(/_/g, '');
      const provided = request.typedConfirmation.toLowerCase().replace(/_/g, '').replace(/ /g, '');

      if (provided !== expected) {
        return {
          valid: false,
          reason: `Typed confirmation does not match. Expected: "${pending.context.operation}"`
        };
      }
    }

    // Check acknowledgment for high-risk operations (only if not already confirmed)
    if (
      !pending.confirmed &&
      (pending.assessment.riskLevel === RiskLevel.HIGH ||
        pending.assessment.riskLevel === RiskLevel.CRITICAL)
    ) {
      if (!request.acknowledged) {
        return {
          valid: false,
          reason: 'You must acknowledge the risks before proceeding'
        };
      }
    }

    // Mark as confirmed after successful verification
    if (!pending.confirmed) {
      pending.confirmed = true;
      logger.info('Operation confirmed by user', {
        context: 'SafetyGuard',
        operation: pending.context.operation,
        token: request.token.substring(0, 20) + '...'
      });
    }

    return { valid: true };
  }

  /**
   * Assess the risk of an operation
   * Sprint 2: Integrated with Protection Rule Engine
   */
  private async assessRisk(context: OperationContext): Promise<RiskAssessment> {
    // Base risk level from static map
    let riskLevel = RISK_MAP[context.operation] || RiskLevel.LOW;
    let requiresDoubleConfirm = this.config.doubleConfirmOperations.includes(
      context.operation
    );
    let ruleApplied = false;
    let ruleInfo: string | undefined;

    // Sprint 2: Evaluate protection rules if entityType and entityId provided
    if (context.details?.entityType && context.details?.entityId) {
      try {
        const ruleResult = await protectionRuleService.evaluateRules({
          entity_type: context.details.entityType as 'plugin' | 'snapshot' | 'schema' | 'workflow',
          entity_id: context.details.entityId as string,
          operation: context.operation,
          properties: context.details,
          user_id: context.initiator
        });

        if (ruleResult.matched && ruleResult.effects) {
          ruleApplied = true;
          ruleInfo = `Rule: ${ruleResult.rule_name} (${ruleResult.rule_id})`;

          // Apply rule effects
          switch (ruleResult.effects.action) {
            case 'block':
              // Store blocking information in context.details
              context.details = {
                ...context.details,
                ruleBlocked: true,
                ruleBlockReason:
                  ruleResult.effects.message ||
                  `Operation blocked by protection rule: ${ruleResult.rule_name}`
              };
              logger.warn(`Operation blocked by rule: ${ruleResult.rule_name}`, {
                context: 'SafetyGuard',
                operation: context.operation,
                ruleId: ruleResult.rule_id
              });
              break;

            case 'elevate_risk':
              // Elevate risk level if specified
              if (ruleResult.effects.risk_level) {
                const riskLevelMap: Record<string, RiskLevel> = {
                  'LOW': RiskLevel.LOW,
                  'MEDIUM': RiskLevel.MEDIUM,
                  'HIGH': RiskLevel.HIGH,
                  'CRITICAL': RiskLevel.CRITICAL
                };
                const elevatedLevel = riskLevelMap[ruleResult.effects.risk_level];
                if (
                  elevatedLevel &&
                  this.getRiskLevelOrder(elevatedLevel) >
                  this.getRiskLevelOrder(riskLevel)
                ) {
                  riskLevel = elevatedLevel;
                  logger.info(
                    `Risk elevated by rule: ${ruleResult.rule_name} to ${elevatedLevel}`,
                    {
                      context: 'SafetyGuard',
                      operation: context.operation,
                      ruleId: ruleResult.rule_id
                    }
                  );
                }
              }
              break;

            case 'require_approval':
              // Add double-confirm requirement
              requiresDoubleConfirm = true;
              logger.info(`Double-confirm required by rule: ${ruleResult.rule_name}`, {
                context: 'SafetyGuard',
                operation: context.operation,
                ruleId: ruleResult.rule_id
              });
              break;
          }
        }
      } catch (error) {
        logger.error('Failed to evaluate protection rules', error as Error);
        // Continue with base risk assessment on rule evaluation failure
      }
    }

    const assessment: RiskAssessment = {
      riskLevel,
      requiresConfirmation:
        riskLevel === RiskLevel.MEDIUM ||
        riskLevel === RiskLevel.HIGH ||
        riskLevel === RiskLevel.CRITICAL,
      requiresDoubleConfirm,
      riskDescription: this.getRiskDescription(context.operation, riskLevel),
      safeguards: this.getSafeguards(context.operation, riskLevel),
      impact: this.estimateImpact(context)
    };

    // Store rule information in context.details for reference
    if (ruleApplied && ruleInfo) {
      context.details = {
        ...context.details,
        ruleApplied,
        ruleInfo
      };
    }

    return assessment;
  }

  /**
   * Helper to get numeric order of risk levels for comparison
   */
  private getRiskLevelOrder(level: string): number {
    const order: Record<string, number> = {
      [RiskLevel.LOW]: 1,
      [RiskLevel.MEDIUM]: 2,
      [RiskLevel.HIGH]: 3,
      [RiskLevel.CRITICAL]: 4
    };
    return order[level] || 0;
  }

  /**
   * Get human-readable risk description
   */
  private getRiskDescription(
    operation: OperationType,
    riskLevel: RiskLevel
  ): string {
    const descriptions: Partial<Record<OperationType, string>> = {
      [OperationType.DROP_TABLE]:
        'This will permanently delete the table and all its data',
      [OperationType.TRUNCATE_TABLE]:
        'This will remove all data from the table',
      [OperationType.DELETE_DATA]: 'This will permanently delete selected data',
      [OperationType.BULK_UPDATE]:
        'This will modify multiple records at once',
      [OperationType.RESTORE_SNAPSHOT]:
        'This will overwrite current state with snapshot data',
      [OperationType.RELOAD_ALL_PLUGINS]:
        'This will restart all plugins, causing temporary unavailability',
      [OperationType.SHUTDOWN_SERVICE]:
        'This will shut down the service completely',
      [OperationType.CLEANUP_SNAPSHOTS]:
        'This will remove old snapshots permanently',
      [OperationType.ALTER_SCHEMA]:
        'This will modify the database schema structure',
      [OperationType.DROP_COLUMN]:
        'This will permanently remove a column and its data'
    };

    return (
      descriptions[operation] ||
      `${riskLevel.toUpperCase()} risk operation: ${operation}`
    );
  }

  /**
   * Get recommended safeguards
   */
  private getSafeguards(
    operation: OperationType,
    _riskLevel: RiskLevel
  ): string[] {
    const safeguards: string[] = [];

    // Common safeguards
    if (
      operation === OperationType.DELETE_DATA ||
      operation === OperationType.BULK_UPDATE ||
      operation === OperationType.DROP_TABLE
    ) {
      safeguards.push('Create a snapshot before proceeding');
      safeguards.push('Verify the affected records');
    }

    if (operation === OperationType.RESTORE_SNAPSHOT) {
      safeguards.push('Create a snapshot of current state first');
      safeguards.push('Verify the snapshot version and contents');
    }

    if (
      operation === OperationType.RELOAD_ALL_PLUGINS ||
      operation === OperationType.FORCE_RELOAD
    ) {
      safeguards.push('Ensure no active requests are being processed');
      safeguards.push('Notify users of potential brief unavailability');
    }

    if (operation === OperationType.SHUTDOWN_SERVICE) {
      safeguards.push('Ensure all data has been saved');
      safeguards.push('Notify all connected clients');
      safeguards.push('Verify service restart plan');
    }

    if (
      operation === OperationType.ALTER_SCHEMA ||
      operation === OperationType.DROP_COLUMN
    ) {
      safeguards.push('Backup the database first');
      safeguards.push('Test migration on staging environment');
      safeguards.push('Prepare rollback script');
    }

    return safeguards;
  }

  /**
   * Estimate the impact of an operation
   */
  private estimateImpact(context: OperationContext): RiskAssessment['impact'] {
    const systemWideOps = [
      OperationType.SHUTDOWN_SERVICE,
      OperationType.RELOAD_ALL_PLUGINS,
      OperationType.CLEAR_CACHE,
      OperationType.RESET_METRICS
    ];

    const batchOps = [
      OperationType.BULK_UPDATE,
      OperationType.CLEANUP_SNAPSHOTS,
      OperationType.TRUNCATE_TABLE
    ];

    const irreversibleOps = [
      OperationType.DROP_TABLE,
      OperationType.TRUNCATE_TABLE,
      OperationType.DROP_COLUMN,
      OperationType.DELETE_DATA
    ];

    let scope: 'single' | 'batch' | 'system-wide' = 'single';
    if (systemWideOps.includes(context.operation)) {
      scope = 'system-wide';
    } else if (batchOps.includes(context.operation)) {
      scope = 'batch';
    }

    const reversible = !irreversibleOps.includes(context.operation);

    // Estimate duration based on operation
    let estimatedDuration: string | undefined;
    if (context.operation === OperationType.RELOAD_ALL_PLUGINS) {
      estimatedDuration = '10-30 seconds';
    } else if (context.operation === OperationType.RESTORE_SNAPSHOT) {
      estimatedDuration = '1-5 minutes depending on data size';
    } else if (context.operation === OperationType.BULK_UPDATE) {
      estimatedDuration = 'Varies based on record count';
    }

    return {
      scope,
      reversible,
      estimatedDuration
    };
  }

  /**
   * Generate a secure confirmation token
   */
  private generateConfirmationToken(): string {
    return `sfg_${crypto.randomBytes(32).toString('hex')}`;
  }

  /**
   * Start cleanup interval for expired tokens
   */
  private startCleanupInterval(): void {
    // Cleanup every minute
    this.cleanupInterval = setInterval(() => {
      const now = new Date();
      let cleaned = 0;

      for (const [token, pending] of this.pendingConfirmations) {
        if (now > pending.expiresAt) {
          this.pendingConfirmations.delete(token);
          cleaned++;
        }
      }

      if (cleaned > 0) {
        metrics.updatePendingConfirmations(this.pendingConfirmations.size);
        logger.info('Cleaned up expired confirmation tokens', {
          context: 'SafetyGuard',
          cleaned,
          remaining: this.pendingConfirmations.size
        });
      }
    }, 60000);
  }

  /**
   * Stop the service
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.pendingConfirmations.clear();
    logger.info('SafetyGuard destroyed', { context: 'SafetyGuard' });
  }

  /**
   * Get current pending confirmations count
   */
  getPendingCount(): number {
    return this.pendingConfirmations.size;
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<SafetyGuardConfig>): void {
    this.config = { ...this.config, ...newConfig };
    logger.info('SafetyGuard config updated', {
      context: 'SafetyGuard',
      config: this.config
    });
  }

  /**
   * Check if SafetyGuard is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }
}

// Singleton instance
let safetyGuardInstance: SafetyGuard | null = null;

export function getSafetyGuard(): SafetyGuard {
  if (!safetyGuardInstance) {
    safetyGuardInstance = new SafetyGuard();
  }
  return safetyGuardInstance;
}

export function initSafetyGuard(
  config: Partial<SafetyGuardConfig> = {}
): SafetyGuard {
  if (safetyGuardInstance) {
    safetyGuardInstance.destroy();
  }
  safetyGuardInstance = new SafetyGuard(config);
  return safetyGuardInstance;
}
