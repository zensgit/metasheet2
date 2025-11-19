/**
 * SafetyGuard Metrics
 *
 * Prometheus metrics for tracking dangerous operations
 */

import client from 'prom-client';
import { registry } from '../metrics/metrics';

// Counter for dangerous operations attempted
export const dangerousOperationsTotal = new client.Counter({
  name: 'metasheet_dangerous_operations_total',
  help: 'Total dangerous operations attempted',
  labelNames: ['operation', 'risk_level', 'result'] as const,
  registers: [registry]
});

// Counter for blocked operations
export const blockedOperationsTotal = new client.Counter({
  name: 'metasheet_blocked_operations_total',
  help: 'Total operations blocked by SafetyGuard',
  labelNames: ['operation', 'reason'] as const,
  registers: [registry]
});

// Counter for confirmation requests
export const confirmationRequestsTotal = new client.Counter({
  name: 'metasheet_confirmation_requests_total',
  help: 'Total confirmation requests generated',
  labelNames: ['operation', 'type'] as const, // type: single, double
  registers: [registry]
});

// Counter for confirmed operations
export const confirmedOperationsTotal = new client.Counter({
  name: 'metasheet_confirmed_operations_total',
  help: 'Total operations confirmed and executed',
  labelNames: ['operation'] as const,
  registers: [registry]
});

// Gauge for pending confirmations
export const pendingConfirmationsGauge = new client.Gauge({
  name: 'metasheet_pending_confirmations',
  help: 'Number of pending confirmation tokens',
  labelNames: [] as const,
  registers: [registry]
});

// Histogram for time between request and confirmation
export const confirmationDelayHistogram = new client.Histogram({
  name: 'metasheet_confirmation_delay_seconds',
  help: 'Time between safety check and confirmation',
  labelNames: ['operation'] as const,
  buckets: [1, 5, 10, 30, 60, 120, 300],
  registers: [registry]
});

// Counter for idempotency key cache hits
export const idempotencyHitsTotal = new client.Counter({
  name: 'metasheet_idempotency_hits_total',
  help: 'Total idempotency key cache hits (duplicate requests prevented)',
  labelNames: [] as const,
  registers: [registry]
});

// Counter for idempotency key cache misses
export const idempotencyMissesTotal = new client.Counter({
  name: 'metasheet_idempotency_misses_total',
  help: 'Total idempotency key cache misses (new requests processed)',
  labelNames: [] as const,
  registers: [registry]
});

// Counter for rate limit exceeded events
export const rateLimitExceededTotal = new client.Counter({
  name: 'metasheet_rate_limit_exceeded_total',
  help: 'Total rate limit exceeded events',
  labelNames: [] as const,
  registers: [registry]
});

// Helper functions
export function recordDangerousOperation(
  operation: string,
  riskLevel: string,
  result: 'allowed' | 'blocked' | 'pending_confirmation'
): void {
  dangerousOperationsTotal.inc({ operation, risk_level: riskLevel, result });
}

export function recordBlockedOperation(
  operation: string,
  reason: string
): void {
  blockedOperationsTotal.inc({ operation, reason });
}

export function recordConfirmationRequest(
  operation: string,
  isDoubleConfirm: boolean
): void {
  confirmationRequestsTotal.inc({
    operation,
    type: isDoubleConfirm ? 'double' : 'single'
  });
}

export function recordConfirmedOperation(operation: string): void {
  confirmedOperationsTotal.inc({ operation });
}

export function updatePendingConfirmations(count: number): void {
  pendingConfirmationsGauge.set(count);
}

export function recordConfirmationDelay(
  operation: string,
  delaySeconds: number
): void {
  confirmationDelayHistogram.observe({ operation }, delaySeconds);
}

export function recordIdempotencyHit(): void {
  idempotencyHitsTotal.inc();
}

export function recordIdempotencyMiss(): void {
  idempotencyMissesTotal.inc();
}

export function recordRateLimitExceeded(): void {
  rateLimitExceededTotal.inc();
}
