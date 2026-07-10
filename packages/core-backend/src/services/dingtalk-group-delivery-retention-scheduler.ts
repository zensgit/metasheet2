/**
 * DingTalk group-delivery retention scheduler (R1, DT-HARDEN-08 follow-up).
 *
 * Boot-wiring glue around the generic `LedgerRetentionScheduler` class (it
 * already depends only on an injected `{ sweep(): Promise<number> }`
 * service, so no changes were needed there) bound to
 * `PgDingTalkGroupDeliveryRetentionService` — the sweep function itself lives
 * in ./dingtalk-group-delivery-retention.ts.
 *
 * Enabled by default; disable with DINGTALK_GROUP_DELIVERY_RETENTION_DISABLED=1
 * (the same opt-out the sweep honors — a disabled config makes every tick a
 * no-op). Interval defaults to the same daily-ish 6h cadence as the ledger
 * sweep (DINGTALK_GROUP_DELIVERY_RETENTION_SCHEDULER_INTERVAL_MS), clamped to
 * a 60s floor. A multi-instance fleet can opt into a Redis leader lock via
 * ENABLE_DINGTALK_GROUP_DELIVERY_RETENTION_LEADER_LOCK=true, mirroring the
 * ledger scheduler's opt-in — the sweep is idempotent and convergent
 * (a later tick deletes whatever a missed/duplicate tick left), so the lock
 * is a load optimisation only, never load-bearing for correctness.
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
import { PgDingTalkGroupDeliveryRetentionService } from './dingtalk-group-delivery-retention'

const DEFAULT_LOCK_TTL_MS = 30_000

let sharedScheduler: LedgerRetentionScheduler | null = null

/**
 * Enabled by default; opt OUT with DINGTALK_GROUP_DELIVERY_RETENTION_DISABLED=1.
 * Returns null when disabled or already started.
 */
export function startDingTalkGroupDeliveryRetentionScheduler(
  options: LedgerRetentionSchedulerOptions = {},
): LedgerRetentionScheduler | null {
  if (process.env.DINGTALK_GROUP_DELIVERY_RETENTION_DISABLED === '1') return null
  if (sharedScheduler) return sharedScheduler
  sharedScheduler = new LedgerRetentionScheduler({
    ...options,
    service: options.service ?? new PgDingTalkGroupDeliveryRetentionService(),
    logger: options.logger ?? new Logger('DingTalkGroupDeliveryRetentionScheduler'),
    sweptEntityLabel: options.sweptEntityLabel ?? 'DingTalk group-delivery rows',
  })
  sharedScheduler.start()
  return sharedScheduler
}

export function getSharedDingTalkGroupDeliveryRetentionScheduler(): LedgerRetentionScheduler | null {
  return sharedScheduler
}

export function stopDingTalkGroupDeliveryRetentionScheduler(): void {
  if (sharedScheduler) {
    sharedScheduler.stop()
    sharedScheduler = null
  }
}

export function resolveDingTalkGroupDeliveryRetentionSchedulerIntervalMs(): number | undefined {
  const raw = Number(process.env.DINGTALK_GROUP_DELIVERY_RETENTION_SCHEDULER_INTERVAL_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : undefined
}

export async function resolveDingTalkGroupDeliveryRetentionSchedulerLeaderOptions(): Promise<LedgerRetentionSchedulerLeaderOptions | null> {
  if (process.env.ENABLE_DINGTALK_GROUP_DELIVERY_RETENTION_LEADER_LOCK !== 'true') return null
  const redis = await getRedisClient()
  if (!redis) return null
  const ttlMs = Number(process.env.DINGTALK_GROUP_DELIVERY_RETENTION_LEADER_LOCK_TTL_MS) > 0
    ? Number(process.env.DINGTALK_GROUP_DELIVERY_RETENTION_LEADER_LOCK_TTL_MS)
    : DEFAULT_LOCK_TTL_MS
  const retryIntervalMs = Number(process.env.DINGTALK_GROUP_DELIVERY_RETENTION_LEADER_LOCK_RETRY_MS) > 0
    ? Number(process.env.DINGTALK_GROUP_DELIVERY_RETENTION_LEADER_LOCK_RETRY_MS)
    : undefined
  return {
    leaderLock: new RedisLeaderLock({ client: redis as unknown as RedisLeaderLockClient }),
    ownerId: `dingtalk-group-delivery-retention:${process.pid}:${randomBytes(4).toString('hex')}`,
    ttlMs,
    retryIntervalMs,
  }
}
