/**
 * DingTalk approval-card + person delivery retention sweep (DT-HARDEN-08 follow-up, sibling of
 * services/dingtalk-group-delivery-retention.ts).
 *
 * `dingtalk_person_deliveries` persists full message `content` plus raw `response_body` TEXT for
 * every automation person-notify send (and rule-creator test sends) with zero DELETE anywhere in
 * the codebase — same unbounded-growth-of-sensitive-payload shape as the group-delivery ledger
 * this mirrors. `dingtalk_approval_card_deliveries` carries no message content (see its migration:
 * id/instance_id/node_key/recipient ids/delivery_kind/task_id/integration_id/card_state/
 * acted_* / send_status / send_error only), but it DOES carry a security-relevant state machine — a
 * `card_state='sent'` row plus a valid deep-link token is independently actionable
 * (ApprovalCardDeliveryAction.ts) — and a lingering `sent` card that nothing ever advances (the
 * instance moved on some other way, or the recipient never opened it) stays claimable forever.
 * Retention here means two independently-testable sub-sweeps sharing one config:
 *
 *  - dingtalk_person_deliveries: mirrors the group sweep exactly — a bounded batch DELETE (ctid
 *    sub-select, same shape as sweepDingTalkGroupDeliveryRetention) of rows older than the window.
 *    This table has no downstream reader keyed by delivery id (listAutomationDingTalkPersonDeliveries
 *    is a rule-history display query only), so a straight delete is safe and closes the actual
 *    unexpired-content gap.
 *
 *  - dingtalk_approval_card_deliveries: NEVER deleted by this sweep (its acted_action/acted_by/
 *    acted_at columns are the only record of who approved/rejected via which card — deleting them
 *    would erase delivery-channel provenance the group-delivery precedent doesn't have to protect).
 *    Instead, rows still `card_state='sent'` past the window are moved to the already-existing
 *    `expired` terminal state (allowed by the original CHECK constraint — no migration needed).
 *    This can only ever move a row AWAY from `sent`: the WHERE clause requires `card_state='sent'`.
 *    `task_id` and the idx_dacd_task_id trace index are never touched.
 *
 *    WHY A SWEPT ROW CANNOT APPROVE — cite the LIVE guard, not a dead one. An earlier revision of this
 *    comment proved the invariant by pointing at `claimDingTalkApprovalCardDeliveryActed`'s
 *    `WHERE card_state='sent'`. That helper is no longer on the production path at all, and — worse —
 *    the wrapper's `card_state` pre-read that this comment leaned on ran OUTSIDE the engine's
 *    transaction, so this sweep could and DID race it: the owner reproduced an `expired` card
 *    completing an approval (P1, 2026-07-12). Reasoning from a comment is what let that ship.
 *
 *    The invariant is now enforced where it is actually decided: `ApprovalProductService.dispatchAction`
 *    takes a ROW LOCK on the delivery inside its own transaction, gates on
 *    (binding AND card_state='sent' AND send_status delivered), and claims the card `acted` ATOMICALLY
 *    in that same transaction. So the two orderings are both safe — this sweep either wins the row lock
 *    (dispatch then reads `expired` and refuses) or loses it (the card is already `acted`, and our
 *    `WHERE card_state='sent'` no longer matches). Pinned by a real-DB interleaving golden, not by prose.
 *
 * GATING DEVIATION FROM THE GROUP-DELIVERY PRECEDENT (read this before changing the default):
 * the group sweep is enabled BY DEFAULT (opt OUT via DINGTALK_GROUP_DELIVERY_RETENTION_DISABLED=1),
 * with an out-of-range/invalid DINGTALK_GROUP_DELIVERY_RETENTION_DAYS falling back to its 90-day
 * default while STAYING enabled. This sweep inverts that: it is a no-op until an operator sets a
 * valid, positive DINGTALK_DELIVERY_RETENTION_DAYS — an unset OR invalid value means "not
 * configured" and the sweep stays disabled (fail closed), it does NOT fall back to a default
 * window and start deleting/expiring anyway. This is a deliberate owner-facing judgment call (not
 * a copy-paste divergence): these two ledgers sit closer to the approval security boundary
 * (card_state machine, deep-link actionability) and to raw message content than the group-robot
 * telemetry table does, so shipping this capability OFF until explicitly turned on is the safer
 * default. Flipping the default to match the group sweep's opt-out posture is a one-line change
 * (swap the `disabled` polarity below) — call this out explicitly if that flip is ever requested.
 *
 * OPERATOR FOOT-GUN — PICK A WINDOW LONGER THAN YOUR APPROVAL SLA. The card sub-sweep expires any
 * card still `sent` past the window, and it does NOT ask whether that card's approval instance is
 * still legitimately PENDING. An approval that sits awaiting a decision for longer than the window
 * therefore loses its one-tap card button (`expired` is not actionable) and its approver must fall
 * back to the web page — the decision is never lost, but the convenience path is. That is the
 * intended hygiene trade-off (an indefinitely-`sent` card plus a valid deep-link token is otherwise
 * actionable FOREVER, which is exactly the unbounded-claimability window this sweep closes), but it
 * means the window must exceed the longest approval turnaround you actually expect. The MIN floor
 * (7 days) is a foot-gun guard, not a recommendation — most orgs should set considerably more.
 *
 * Scheduling reuses the generic `LedgerRetentionScheduler` class unchanged, exactly like the group
 * sweep — see dingtalk-card-person-delivery-retention-scheduler.ts.
 *
 * KNOWN GAP (documented, not fixed here, mirrors the group sweep's own documented gap): neither
 * table's `created_at` predicate has a dedicated index. Acceptable at current table sizes; kept
 * out per YAGNI (adding one is a migration, which this change deliberately avoids since neither
 * table needs a new column).
 */

import type { AiUsageQueryFn } from './ai-usage-ledger'
import type { LedgerRetentionService } from './LedgerRetentionScheduler'
import { poolManager } from '../integration/db/connection-pool'

export const DINGTALK_PERSON_DELIVERY_TABLE = 'dingtalk_person_deliveries'
export const DINGTALK_APPROVAL_CARD_DELIVERY_TABLE = 'dingtalk_approval_card_deliveries'

/** Reference default retention window in days — only takes effect once DAYS is explicitly set. */
export const DINGTALK_DELIVERY_RETENTION_DEFAULT_DAYS = 90

/** Floor on the retention window (foot-gun guard) — never below 7 days. */
export const DINGTALK_DELIVERY_RETENTION_MIN_DAYS = 7

/** Per-pass row cap — drains a backlog over ticks, never one huge statement. */
export const DINGTALK_DELIVERY_RETENTION_DEFAULT_BATCH = 5000

export interface DingTalkDeliveryRetentionConfig {
  /** Resolved retention window in days (already floored). Meaningful only when !disabled. */
  retentionDays: number
  /** True unless an operator has explicitly opted in (see module docstring — default-OFF). */
  disabled: boolean
  /** Per-pass row cap (defaults to DINGTALK_DELIVERY_RETENTION_DEFAULT_BATCH). */
  batchSize?: number
}

/**
 * Resolve the retention config from the environment. DISABLED BY DEFAULT — the inverse gate of
 * the sibling group-delivery sweep (see module docstring). Enabled only when
 * DINGTALK_DELIVERY_RETENTION_DAYS parses to a finite positive number (then floored at
 * DINGTALK_DELIVERY_RETENTION_MIN_DAYS); any other value (unset, non-numeric, zero, negative)
 * leaves the sweep disabled rather than silently falling back to a default window.
 * DINGTALK_DELIVERY_RETENTION_DISABLED=1 forces disabled regardless of DAYS (operator kill switch,
 * also honored by the scheduler's own start gate).
 */
export function resolveDingTalkDeliveryRetentionConfig(
  env: NodeJS.ProcessEnv = process.env,
): DingTalkDeliveryRetentionConfig {
  const forceDisabled = env.DINGTALK_DELIVERY_RETENTION_DISABLED === '1'
  const rawDays = Number(env.DINGTALK_DELIVERY_RETENTION_DAYS)
  const explicitlyConfigured = Number.isFinite(rawDays) && rawDays > 0
  const disabled = forceDisabled || !explicitlyConfigured
  const retentionDays = Math.max(
    DINGTALK_DELIVERY_RETENTION_MIN_DAYS,
    Math.floor(explicitlyConfigured ? rawDays : DINGTALK_DELIVERY_RETENTION_DEFAULT_DAYS),
  )
  return { retentionDays, disabled }
}

/**
 * Delete dingtalk_person_deliveries rows older than the retention window. Returns rows deleted (0
 * when disabled, or when nothing is past the window). Bounded by `batchSize` via a ctid sub-select
 * — same shape as sweepDingTalkGroupDeliveryRetention — so one pass never blocks the table during
 * a backlog drain. No source_type carve-out (automation sends and rule-creator test sends alike):
 * nothing downstream references a delivery row by id once written.
 */
export async function sweepDingTalkPersonDeliveryRetention(
  query: AiUsageQueryFn,
  config: DingTalkDeliveryRetentionConfig,
): Promise<number> {
  if (config.disabled) return 0
  const retentionDays = Math.max(DINGTALK_DELIVERY_RETENTION_MIN_DAYS, Math.floor(config.retentionDays))
  const batchSize = Math.max(1, Math.floor(config.batchSize ?? DINGTALK_DELIVERY_RETENTION_DEFAULT_BATCH))
  const result = await query(
    `DELETE FROM ${DINGTALK_PERSON_DELIVERY_TABLE}
      WHERE ctid IN (
        SELECT ctid FROM ${DINGTALK_PERSON_DELIVERY_TABLE}
         WHERE created_at < now() - ($1::int * interval '1 day')
         LIMIT $2
      )`,
    [retentionDays, batchSize],
  )
  return result.rowCount ?? 0
}

/**
 * Expire stale dingtalk_approval_card_deliveries rows: `card_state='sent'` AND older than the
 * retention window transitions to `card_state='expired'` — never deleted (see module docstring).
 * Bounded by `batchSize` via the same ctid sub-select pattern. The WHERE clause requires
 * card_state='sent', so this can only ever move a row AWAY from `sent` — it is structurally
 * incapable of reviving a card back to an actionable state. `task_id`, `send_status`,
 * `acted_*`, and `integration_id` are left untouched.
 */
export async function sweepDingTalkApprovalCardDeliveryRetention(
  query: AiUsageQueryFn,
  config: DingTalkDeliveryRetentionConfig,
): Promise<number> {
  if (config.disabled) return 0
  const retentionDays = Math.max(DINGTALK_DELIVERY_RETENTION_MIN_DAYS, Math.floor(config.retentionDays))
  const batchSize = Math.max(1, Math.floor(config.batchSize ?? DINGTALK_DELIVERY_RETENTION_DEFAULT_BATCH))
  const result = await query(
    `UPDATE ${DINGTALK_APPROVAL_CARD_DELIVERY_TABLE}
        SET card_state = 'expired', updated_at = NOW()
      WHERE ctid IN (
        SELECT ctid FROM ${DINGTALK_APPROVAL_CARD_DELIVERY_TABLE}
         WHERE card_state = 'sent' AND created_at < now() - ($1::int * interval '1 day')
         LIMIT $2
      )`,
    [retentionDays, batchSize],
  )
  return result.rowCount ?? 0
}

export interface DingTalkCardPersonDeliveryRetentionResult {
  /** dingtalk_person_deliveries rows physically deleted. */
  personDeleted: number
  /** dingtalk_approval_card_deliveries rows moved sent → expired. */
  cardExpired: number
}

/**
 * Runs both sub-sweeps under one shared config (one retention window governs both ledgers — the
 * operator sets one "how long to keep DingTalk delivery ledger data" knob, not two). Disabled
 * short-circuits before touching either table.
 */
export async function sweepDingTalkCardPersonDeliveryRetention(
  query: AiUsageQueryFn,
  config: DingTalkDeliveryRetentionConfig,
): Promise<DingTalkCardPersonDeliveryRetentionResult> {
  if (config.disabled) return { personDeleted: 0, cardExpired: 0 }
  const personDeleted = await sweepDingTalkPersonDeliveryRetention(query, config)
  const cardExpired = await sweepDingTalkApprovalCardDeliveryRetention(query, config)
  return { personDeleted, cardExpired }
}

/**
 * Default service: binds the composed sweep to the shared pg pool + the env-resolved retention
 * config. Re-reads the config each pass so an env change (enabling/disabling, or a new DAYS value)
 * takes effect on the next tick without a restart. Returns the combined row count (person deletes +
 * card expires) to satisfy the generic LedgerRetentionService's `Promise<number>` contract; the
 * two counts are independently available via the exported sub-sweep functions for callers that
 * need the breakdown (e.g. tests, or a future richer log line).
 */
export class PgDingTalkCardPersonDeliveryRetentionService implements LedgerRetentionService {
  private readonly config?: DingTalkDeliveryRetentionConfig

  constructor(config?: DingTalkDeliveryRetentionConfig) {
    this.config = config
  }

  async sweep(): Promise<number> {
    const config = this.config ?? resolveDingTalkDeliveryRetentionConfig()
    if (config.disabled) return 0
    const pool = poolManager.get() as unknown as { query: AiUsageQueryFn }
    const query = pool.query.bind(pool) as AiUsageQueryFn
    const { personDeleted, cardExpired } = await sweepDingTalkCardPersonDeliveryRetention(query, config)
    return personDeleted + cardExpired
  }
}
