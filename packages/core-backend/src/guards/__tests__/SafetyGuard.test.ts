import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SafetyGuard, initSafetyGuard } from '../SafetyGuard';
import {
  OperationType,
  RiskLevel,
  type OperationContext
} from '../types';

describe('SafetyGuard', () => {
  let guard: SafetyGuard;

  beforeEach(() => {
    guard = initSafetyGuard({
      enabled: true,
      tokenExpirationSeconds: 300
    });
  });

  afterEach(() => {
    guard.destroy();
  });

  describe('Risk Assessment', () => {
    it('should classify DROP_TABLE as CRITICAL', () => {
      const context: OperationContext = {
        operation: OperationType.DROP_TABLE,
        initiator: 'test@example.com'
      };

      const result = guard.checkOperation(context);
      expect(result.assessment.riskLevel).toBe(RiskLevel.CRITICAL);
      expect(result.assessment.requiresDoubleConfirm).toBe(true);
    });

    it('should classify DELETE_DATA as HIGH', () => {
      const context: OperationContext = {
        operation: OperationType.DELETE_DATA,
        initiator: 'test@example.com'
      };

      const result = guard.checkOperation(context);
      expect(result.assessment.riskLevel).toBe(RiskLevel.HIGH);
      expect(result.assessment.requiresConfirmation).toBe(true);
    });

    it('should classify RESET_METRICS as LOW', () => {
      const context: OperationContext = {
        operation: OperationType.RESET_METRICS,
        initiator: 'test@example.com'
      };

      const result = guard.checkOperation(context);
      expect(result.assessment.riskLevel).toBe(RiskLevel.LOW);
      expect(result.assessment.requiresConfirmation).toBe(false);
    });
  });

  describe('Confirmation Flow', () => {
    it('should block HIGH risk operations without token', () => {
      const context: OperationContext = {
        operation: OperationType.DELETE_DATA,
        initiator: 'test@example.com'
      };

      const result = guard.checkOperation(context);
      expect(result.allowed).toBe(false);
      expect(result.confirmationToken).toBeDefined();
      expect(result.tokenExpiry).toBeDefined();
    });

    it('should allow LOW risk operations immediately', () => {
      const context: OperationContext = {
        operation: OperationType.RESET_METRICS,
        initiator: 'test@example.com'
      };

      const result = guard.checkOperation(context);
      expect(result.allowed).toBe(true);
    });

    it('should allow operation with valid token after acknowledgment', () => {
      const context: OperationContext = {
        operation: OperationType.DELETE_DATA,
        initiator: 'test@example.com'
      };

      // First check - gets token
      const firstResult = guard.checkOperation(context);
      expect(firstResult.allowed).toBe(false);
      const token = firstResult.confirmationToken!;

      // Verify confirmation with acknowledgment
      const verification = guard.verifyConfirmation({
        token,
        acknowledged: true
      });
      expect(verification.valid).toBe(true);

      // Second check with token - should allow
      const secondContext: OperationContext = {
        ...context,
        confirmationToken: token
      };
      const secondResult = guard.checkOperation(secondContext);
      expect(secondResult.allowed).toBe(true);
    });

    it('should require double-confirm for CRITICAL operations', () => {
      const context: OperationContext = {
        operation: OperationType.DROP_TABLE,
        initiator: 'test@example.com'
      };

      const result = guard.checkOperation(context);
      expect(result.allowed).toBe(false);
      expect(result.assessment.requiresDoubleConfirm).toBe(true);

      const token = result.confirmationToken!;

      // Without typed confirmation - should fail
      const failVerification = guard.verifyConfirmation({
        token,
        acknowledged: true
      });
      expect(failVerification.valid).toBe(false);
      expect(failVerification.reason).toContain('Double confirmation required');

      // With typed confirmation - should pass
      const passVerification = guard.verifyConfirmation({
        token,
        typedConfirmation: 'droptable', // normalized
        acknowledged: true
      });
      expect(passVerification.valid).toBe(true);
    });

    it('should reject wrong typed confirmation', () => {
      const context: OperationContext = {
        operation: OperationType.DROP_TABLE,
        initiator: 'test@example.com'
      };

      const result = guard.checkOperation(context);
      const token = result.confirmationToken!;

      const verification = guard.verifyConfirmation({
        token,
        typedConfirmation: 'wrong_input',
        acknowledged: true
      });
      expect(verification.valid).toBe(false);
      expect(verification.reason).toContain('does not match');
    });
  });

  describe('Token Management', () => {
    it('should reject expired tokens', async () => {
      // Create guard with short expiration
      guard.destroy();
      guard = initSafetyGuard({
        enabled: true,
        tokenExpirationSeconds: 1 // 1 second
      });

      const context: OperationContext = {
        operation: OperationType.DELETE_DATA,
        initiator: 'test@example.com'
      };

      const result = guard.checkOperation(context);
      const token = result.confirmationToken!;

      // Wait for token to expire
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const verification = guard.verifyConfirmation({
        token,
        acknowledged: true
      });
      expect(verification.valid).toBe(false);
      expect(verification.reason).toContain('expired');
    });

    it('should reject invalid tokens', () => {
      const verification = guard.verifyConfirmation({
        token: 'invalid_token',
        acknowledged: true
      });
      expect(verification.valid).toBe(false);
      expect(verification.reason).toContain('Invalid');
    });

    it('should track pending confirmations', () => {
      const context: OperationContext = {
        operation: OperationType.DELETE_DATA,
        initiator: 'test@example.com'
      };

      expect(guard.getPendingCount()).toBe(0);

      guard.checkOperation(context);
      expect(guard.getPendingCount()).toBe(1);

      guard.checkOperation({ ...context, initiator: 'other@example.com' });
      expect(guard.getPendingCount()).toBe(2);
    });
  });

  describe('Configuration', () => {
    it('should allow all operations when disabled', () => {
      guard.updateConfig({ enabled: false });

      const context: OperationContext = {
        operation: OperationType.DROP_TABLE,
        initiator: 'test@example.com'
      };

      const result = guard.checkOperation(context);
      expect(result.allowed).toBe(true);
    });

    it('should block operations in blockedOperations list', () => {
      guard.updateConfig({
        blockedOperations: [OperationType.SHUTDOWN_SERVICE]
      });

      const context: OperationContext = {
        operation: OperationType.SHUTDOWN_SERVICE,
        initiator: 'test@example.com'
      };

      const result = guard.checkOperation(context);
      expect(result.allowed).toBe(false);
      expect(result.blockedReason).toContain('blocked by security policy');
      expect(result.confirmationToken).toBeUndefined();
    });
  });

  describe('Risk Description and Safeguards', () => {
    it('should provide risk description', () => {
      const context: OperationContext = {
        operation: OperationType.DROP_TABLE,
        initiator: 'test@example.com'
      };

      const result = guard.checkOperation(context);
      expect(result.assessment.riskDescription).toContain(
        'permanently delete the table'
      );
    });

    it('should provide safeguards', () => {
      const context: OperationContext = {
        operation: OperationType.DELETE_DATA,
        initiator: 'test@example.com'
      };

      const result = guard.checkOperation(context);
      expect(result.assessment.safeguards).toContain(
        'Create a snapshot before proceeding'
      );
    });

    it('should estimate impact correctly', () => {
      const systemWideOp: OperationContext = {
        operation: OperationType.SHUTDOWN_SERVICE,
        initiator: 'test@example.com'
      };

      const result = guard.checkOperation(systemWideOp);
      expect(result.assessment.impact.scope).toBe('system-wide');
      expect(result.assessment.impact.reversible).toBe(true);

      const irreversibleOp: OperationContext = {
        operation: OperationType.DROP_TABLE,
        initiator: 'test@example.com'
      };

      const result2 = guard.checkOperation(irreversibleOp);
      expect(result2.assessment.impact.reversible).toBe(false);
    });
  });
});
