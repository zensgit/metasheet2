import { Logger } from '../core/logger';
import { AuditRepository } from './AuditRepository';

export type AuditPartitionEnsureMode = 'off' | 'startup' | 'daily';

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Parses AUDIT_LOG_PARTITION_ENSURE. Any value other than the two opt-in modes
 * (including unset/empty/typo'd) resolves to 'off' — today's behavior, unchanged.
 */
export function resolveAuditPartitionEnsureMode(raw: string | undefined): AuditPartitionEnsureMode {
  if (raw === 'startup' || raw === 'daily') return raw;
  return 'off';
}

export interface AuditPartitionEnsureRepository {
  ensurePartitionsForCurrentAndNextMonth(): Promise<boolean>;
}

export interface StartAuditLogPartitionEnsureOptions {
  mode?: AuditPartitionEnsureMode;
  repository?: AuditPartitionEnsureRepository;
  logger?: Logger;
  intervalMs?: number;
}

/**
 * Env-gated startup hook for AuditRepository#ensurePartitionsForCurrentAndNextMonth.
 * See docs/development/takeover-beiliao-20260821/customer-delivery-guide-20260904.md
 * §9.2 for the operational rationale (222's missing-September-partition incident).
 *
 * AUDIT_LOG_PARTITION_ENSURE:
 *  - 'off' (default): no-op — this function issues zero queries, so behavior is
 *    byte-for-byte identical to before this change existed.
 *  - 'startup': ensure the current+next month partitions once, right away.
 *  - 'daily': same as 'startup', plus a recurring ensure every 24h. The interval
 *    timer is unref'd so it never keeps the process alive on its own.
 *
 * Never throws and never rejects the caller's startup sequence: the underlying
 * repository call already swallows and logs its own errors.
 */
export function startAuditLogPartitionEnsure(options: StartAuditLogPartitionEnsureOptions = {}): () => void {
  const mode = options.mode ?? resolveAuditPartitionEnsureMode(process.env.AUDIT_LOG_PARTITION_ENSURE);

  if (mode === 'off') {
    return () => {};
  }

  const logger = options.logger ?? new Logger('AuditLogPartitionEnsure');
  const repository = options.repository ?? new AuditRepository();

  void repository.ensurePartitionsForCurrentAndNextMonth();

  if (mode !== 'daily') {
    return () => {};
  }

  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timer = setInterval(() => {
    void repository.ensurePartitionsForCurrentAndNextMonth();
  }, intervalMs);
  timer.unref?.();

  logger.info(`Audit log partition ensure scheduled (mode=daily, intervalMs=${intervalMs})`);

  return () => clearInterval(timer);
}
