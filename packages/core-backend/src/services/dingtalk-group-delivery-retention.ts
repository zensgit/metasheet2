/**
 * DingTalk group-delivery retention sweep (R1, DT-HARDEN-08 follow-up).
 *
 * `dingtalk_group_deliveries` is write-once: every automation-rule firing of
 * `send_dingtalk_group_message` inserts one row per matched destination
 * (success AND failure), plus manual test-sends
 * (dingtalk-group-destination-service.ts). Each row carries full message
 * `content` plus raw `response_body` TEXT, so a record-change-triggered rule
 * on an active sheet writes thousands of multi-KB rows/day with zero DELETE
 * anywhere in the codebase — the table grows unbounded. Reads are shallow
 * (listDeliveries LIMIT 50 per destination), so a retention window well past
 * that UI need is safe.
 *
 * Mirrors services/ai-usage-ledger.ts's retention pair byte-for-byte in shape:
 * bounded batch DELETE (default 5000 rows/pass via a ctid sub-select so one
 * pass never blocks the table), default 90-day window, floored at 7 days,
 * enabled by default with an opt-out env var. This is a hygiene sweep (not a
 * notify side-effect channel), so the "register only when configured"
 * convention does not apply — the ledger sweep is the in-repo precedent for
 * that judgment (see docs/development/dingtalk-sync-hardening-design-and-verification-20260708.md).
 *
 * Scheduling reuses the generic `LedgerRetentionScheduler` class directly
 * (it already only depends on an injected `{ sweep(): Promise<number> }`
 * service, so it needed no changes) — one scheduler implementation serving
 * two independent interval loops, wired at boot in index.ts right after the
 * ledger retention block.
 *
 * KNOWN GAP (documented, not fixed here): the DELETE's `created_at < cutoff`
 * predicate has no dedicated index — the existing composite index is
 * `(destination_id, created_at DESC)`, which does not serve a bare
 * `created_at` predicate, so each batch pass is a sequential scan. Acceptable
 * at current table sizes; an optional `(created_at)` index is a follow-up if
 * the table grows large enough for this to matter (kept out of this change
 * per YAGNI — adding it would require a migration).
 */

import type { AiUsageQueryFn } from './ai-usage-ledger'
import type { LedgerRetentionService } from './LedgerRetentionScheduler'
import { poolManager } from '../integration/db/connection-pool'

export const DINGTALK_GROUP_DELIVERY_TABLE = 'dingtalk_group_deliveries'

/** Default retention window in days when no env override is set. */
export const DINGTALK_GROUP_DELIVERY_RETENTION_DEFAULT_DAYS = 90

/** Floor on the retention window (foot-gun guard) — never below 7 days. */
export const DINGTALK_GROUP_DELIVERY_RETENTION_MIN_DAYS = 7

/** Per-pass DELETE bound — drains a backlog over ticks, never one huge statement. */
export const DINGTALK_GROUP_DELIVERY_RETENTION_DEFAULT_BATCH = 5000

export interface DingTalkGroupDeliveryRetentionConfig {
  /** Resolved retention window in days (already floored). */
  retentionDays: number
  /** Opt-out: when true the sweep is a no-op (deletes 0). */
  disabled: boolean
  /** Per-pass row cap (defaults to DINGTALK_GROUP_DELIVERY_RETENTION_DEFAULT_BATCH). */
  batchSize?: number
}

/**
 * Resolve the retention config from the environment. Enabled by default;
 * opt out with DINGTALK_GROUP_DELIVERY_RETENTION_DISABLED=1. The window is
 * floored at DINGTALK_GROUP_DELIVERY_RETENTION_MIN_DAYS (7) so a misconfigured
 * low value can never turn into an aggressive audit-trail-eating sweep.
 */
export function resolveDingTalkGroupDeliveryRetentionConfig(
  env: NodeJS.ProcessEnv = process.env,
): DingTalkGroupDeliveryRetentionConfig {
  const disabled = env.DINGTALK_GROUP_DELIVERY_RETENTION_DISABLED === '1'
  const rawDays = Number(env.DINGTALK_GROUP_DELIVERY_RETENTION_DAYS)
  const requestedDays =
    Number.isFinite(rawDays) && rawDays > 0 ? rawDays : DINGTALK_GROUP_DELIVERY_RETENTION_DEFAULT_DAYS
  const retentionDays = Math.max(DINGTALK_GROUP_DELIVERY_RETENTION_MIN_DAYS, Math.floor(requestedDays))
  return { retentionDays, disabled }
}

/**
 * Delete dingtalk_group_deliveries rows older than the retention window.
 * Returns the number of rows deleted (0 when disabled, or when nothing is
 * past the window). The DELETE is bounded by `batchSize` via a ctid
 * sub-select so one pass never blocks the table during a backlog drain.
 *
 * Applies to both source_types (automation-rule sends and manual_test) —
 * there is no per-source-type carve-out, since neither is referenced by
 * anything downstream once written (deliveries only reference destinations/
 * rules via FK, nothing references deliveries).
 */
export async function sweepDingTalkGroupDeliveryRetention(
  query: AiUsageQueryFn,
  config: DingTalkGroupDeliveryRetentionConfig,
): Promise<number> {
  if (config.disabled) return 0
  const retentionDays = Math.max(DINGTALK_GROUP_DELIVERY_RETENTION_MIN_DAYS, Math.floor(config.retentionDays))
  const batchSize = Math.max(1, Math.floor(config.batchSize ?? DINGTALK_GROUP_DELIVERY_RETENTION_DEFAULT_BATCH))
  const result = await query(
    `DELETE FROM ${DINGTALK_GROUP_DELIVERY_TABLE}
      WHERE ctid IN (
        SELECT ctid FROM ${DINGTALK_GROUP_DELIVERY_TABLE}
         WHERE created_at < now() - ($1::int * interval '1 day')
         LIMIT $2
      )`,
    [retentionDays, batchSize],
  )
  return result.rowCount ?? 0
}

/**
 * Default service: binds the sweep to the shared pg pool + the env-resolved
 * retention config. Re-reads the config each pass so an env change (or the
 * disabled opt-out) takes effect on the next tick without a restart.
 */
export class PgDingTalkGroupDeliveryRetentionService implements LedgerRetentionService {
  private readonly config?: DingTalkGroupDeliveryRetentionConfig

  constructor(config?: DingTalkGroupDeliveryRetentionConfig) {
    this.config = config
  }

  async sweep(): Promise<number> {
    const config = this.config ?? resolveDingTalkGroupDeliveryRetentionConfig()
    if (config.disabled) return 0
    const pool = poolManager.get() as unknown as { query: AiUsageQueryFn }
    const query = pool.query.bind(pool) as AiUsageQueryFn
    return sweepDingTalkGroupDeliveryRetention(query, config)
  }
}
