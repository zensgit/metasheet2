/**
 * DingTalk approval-card + person delivery retention scheduler (DT-HARDEN-08 follow-up).
 *
 * Boot-wiring glue around the generic `LedgerRetentionScheduler` class (unchanged — it already
 * depends only on an injected `{ sweep(): Promise<number> }` service) bound to
 * `PgDingTalkCardPersonDeliveryRetentionService` — the sweep logic itself lives in
 * ./dingtalk-card-person-delivery-retention.ts.
 *
 * The scheduler ALWAYS starts at boot (same as the group-delivery scheduler) — only
 * DINGTALK_DELIVERY_RETENTION_DISABLED=1 stops it from starting at all. This is intentional: the
 * underlying sweep is disabled-by-default via its OWN config (no DINGTALK_DELIVERY_RETENTION_DAYS
 * set → every tick sweeps 0 rows), so an unconfigured deployment gets a harmless no-op timer, not
 * a code path that behaves differently depending on whether the env is set — the boot wiring
 * itself never depends on the retention-days env var, only the runtime row count does.
 *
 * Interval defaults to the same daily-ish 6h cadence as the group-delivery / AI-usage-ledger
 * sweeps (DINGTALK_DELIVERY_RETENTION_SCHEDULER_INTERVAL_MS), clamped to a 60s floor. A
 * multi-instance fleet can opt into a Redis leader lock via
 * ENABLE_DINGTALK_DELIVERY_RETENTION_LEADER_LOCK=true, mirroring the group scheduler's opt-in — the
 * sweep is idempotent and convergent, so the lock is a load optimisation only, never load-bearing
 * for correctness.
 */

import { randomBytes } from 'crypto'
import { Logger } from '../core/logger'
import { getRedisClient } from '../db/redis'
import { RedisLeaderLock, type RedisLeaderLockClient } from '../multitable/redis-leader-lock'
import {
  LedgerRetentionScheduler,
  type LedgerRetentionSchedulerLeaderOptions,
  type LedgerRetentionSchedulerOptions,
} from './LedgerRetentionScheduler'
import { PgDingTalkCardPersonDeliveryRetentionService } from './dingtalk-card-person-delivery-retention'

const DEFAULT_LOCK_TTL_MS = 30_000

let sharedScheduler: LedgerRetentionScheduler | null = null

/**
 * Starts the scheduler unless DINGTALK_DELIVERY_RETENTION_DISABLED=1 (operator kill switch — the
 * same flag the sweep's own config honors). Returns null when disabled or already started. Note
 * this does NOT gate on whether DINGTALK_DELIVERY_RETENTION_DAYS is set — the scheduler always
 * runs; it is the sweep's own config resolution that decides whether a given tick does anything
 * (see module docstring).
 */
export function startDingTalkCardPersonDeliveryRetentionScheduler(
  options: LedgerRetentionSchedulerOptions = {},
): LedgerRetentionScheduler | null {
  if (process.env.DINGTALK_DELIVERY_RETENTION_DISABLED === '1') return null
  if (sharedScheduler) return sharedScheduler
  sharedScheduler = new LedgerRetentionScheduler({
    ...options,
    service: options.service ?? new PgDingTalkCardPersonDeliveryRetentionService(),
    logger: options.logger ?? new Logger('DingTalkCardPersonDeliveryRetentionScheduler'),
    sweptEntityLabel: options.sweptEntityLabel ?? 'DingTalk approval-card/person delivery rows',
  })
  sharedScheduler.start()
  return sharedScheduler
}

export function stopDingTalkCardPersonDeliveryRetentionScheduler(): void {
  if (sharedScheduler) {
    sharedScheduler.stop()
    sharedScheduler = null
  }
}

export function resolveDingTalkCardPersonDeliveryRetentionSchedulerIntervalMs(): number | undefined {
  const raw = Number(process.env.DINGTALK_DELIVERY_RETENTION_SCHEDULER_INTERVAL_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : undefined
}

export async function resolveDingTalkCardPersonDeliveryRetentionSchedulerLeaderOptions(): Promise<LedgerRetentionSchedulerLeaderOptions | null> {
  if (process.env.ENABLE_DINGTALK_DELIVERY_RETENTION_LEADER_LOCK !== 'true') return null
  const redis = await getRedisClient()
  if (!redis) return null
  const ttlMs = Number(process.env.DINGTALK_DELIVERY_RETENTION_LEADER_LOCK_TTL_MS) > 0
    ? Number(process.env.DINGTALK_DELIVERY_RETENTION_LEADER_LOCK_TTL_MS)
    : DEFAULT_LOCK_TTL_MS
  const retryIntervalMs = Number(process.env.DINGTALK_DELIVERY_RETENTION_LEADER_LOCK_RETRY_MS) > 0
    ? Number(process.env.DINGTALK_DELIVERY_RETENTION_LEADER_LOCK_RETRY_MS)
    : undefined
  return {
    leaderLock: new RedisLeaderLock({ client: redis as unknown as RedisLeaderLockClient }),
    // Owner review P2: UNIQUE per sweep. Previously this shared the generic default key with the group
    // sweep, so whichever booted first won and THIS sweep never ran at all.
    lockKey: 'ledger-retention:dingtalk-card-person-deliveries:leader',
    ownerId: `dingtalk-card-person-delivery-retention:${process.pid}:${randomBytes(4).toString('hex')}`,
    ttlMs,
    retryIntervalMs,
  }
}
