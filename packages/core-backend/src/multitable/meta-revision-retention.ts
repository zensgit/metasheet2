/**
 * Retention sweep for `meta_record_revisions` (the append-only per-record version log that
 * Layer 1 restore reads from). Without aging the log grows unbounded.
 *
 * Design-lock §3 (retention coupling): the guarantee shape is "restore is guaranteed for the most
 * recent N versions / D days; older points are restorable only if captured by a Layer-2 base
 * snapshot." This module is the prune MECHANISM; the policy VALUES (N / D / enable) are an owner
 * decision exposed via env. It is **disabled by default** so the restore guarantee is preserved
 * until the owner opts in — turning it on is the explicit decision.
 *
 * INVARIANT (foot-gun shut): the sweep NEVER deletes the latest revision of a record (row_number=1
 * over version DESC). A record always keeps its current after-image, so restore-to-current and the
 * version-resolution rule cannot be orphaned by retention. `VERSION_EXPIRED` (wired in the restore
 * route) is data-driven off the surviving MIN(version) — it does not depend on this sweep running.
 *
 * Mirrors the bounded-DELETE discipline of `sweepAiUsageLedgerRetention` (ctid/id sub-select + LIMIT
 * so one pass drains a backlog over ticks rather than one long statement).
 */

import { Logger } from '../core/logger'
import { query as dbQuery } from '../db/pg'

export type RetentionQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export const META_REVISION_RETENTION_TABLE = 'meta_record_revisions'

export type MetaRevisionRetentionPolicy = 'keep-last-n' | 'keep-days'

/** keep-last-N defaults: keep the 200 most recent versions/record; floor at 10 so a mis-set can't gut history. */
export const META_REVISION_RETENTION_DEFAULT_KEEP_N = 200
export const META_REVISION_RETENTION_MIN_KEEP_N = 10
/** keep-days defaults: keep 365 days; floor at 30 days. */
export const META_REVISION_RETENTION_DEFAULT_DAYS = 365
export const META_REVISION_RETENTION_MIN_DAYS = 30
/** Per-pass DELETE bound — drains a backlog over ticks, never one huge statement. */
export const META_REVISION_RETENTION_DEFAULT_BATCH = 5000

export interface MetaRevisionRetentionConfig {
  /** Opt-in: when false (the default) the sweep is a no-op (deletes 0). */
  enabled: boolean
  policy: MetaRevisionRetentionPolicy
  /** keep-last-n: versions retained per record (already floored). */
  keepN: number
  /** keep-days: retention window in days (already floored). */
  retentionDays: number
  /** Per-pass row cap. */
  batchSize: number
}

/**
 * Resolve from env. DISABLED BY DEFAULT (`...RETENTION_ENABLED` must be exactly '1' to enable),
 * so shipping this module changes nothing until the owner turns it on and picks a policy.
 */
export function resolveMetaRevisionRetentionConfig(
  env: NodeJS.ProcessEnv = process.env,
): MetaRevisionRetentionConfig {
  const enabled = env.MULTITABLE_META_REVISION_RETENTION_ENABLED === '1'
  const policy: MetaRevisionRetentionPolicy =
    env.MULTITABLE_META_REVISION_RETENTION_POLICY === 'keep-days' ? 'keep-days' : 'keep-last-n'

  const rawKeep = Number(env.MULTITABLE_META_REVISION_RETENTION_KEEP_N)
  const keepN = Math.max(
    META_REVISION_RETENTION_MIN_KEEP_N,
    Math.floor(Number.isFinite(rawKeep) && rawKeep > 0 ? rawKeep : META_REVISION_RETENTION_DEFAULT_KEEP_N),
  )

  const rawDays = Number(env.MULTITABLE_META_REVISION_RETENTION_DAYS)
  const retentionDays = Math.max(
    META_REVISION_RETENTION_MIN_DAYS,
    Math.floor(Number.isFinite(rawDays) && rawDays > 0 ? rawDays : META_REVISION_RETENTION_DEFAULT_DAYS),
  )

  const rawBatch = Number(env.MULTITABLE_META_REVISION_RETENTION_BATCH)
  const batchSize = Math.max(1, Math.floor(Number.isFinite(rawBatch) && rawBatch > 0 ? rawBatch : META_REVISION_RETENTION_DEFAULT_BATCH))

  return { enabled, policy, keepN, retentionDays, batchSize }
}

/**
 * Prune old revisions per the config. Returns rows deleted (0 when disabled). The latest revision
 * of every record (row_number=1 over version DESC, created_at DESC) is ALWAYS retained.
 * - keep-last-n: delete rows whose per-record recency rank exceeds keepN.
 * - keep-days:   delete non-latest rows older than the retention window.
 * Bounded per pass by batchSize.
 */
export async function sweepMetaRevisionRetention(
  query: RetentionQueryFn,
  config: MetaRevisionRetentionConfig,
): Promise<number> {
  if (!config.enabled) return 0
  const batchSize = Math.max(1, Math.floor(config.batchSize))

  if (config.policy === 'keep-days') {
    const days = Math.max(META_REVISION_RETENTION_MIN_DAYS, Math.floor(config.retentionDays))
    const result = await query(
      `DELETE FROM ${META_REVISION_RETENTION_TABLE}
        WHERE id IN (
          SELECT id FROM (
            SELECT id, created_at,
                   row_number() OVER (PARTITION BY sheet_id, record_id ORDER BY version DESC, created_at DESC) AS rn
            FROM ${META_REVISION_RETENTION_TABLE}
          ) ranked
          WHERE ranked.rn > 1
            AND ranked.created_at < now() - ($1::int * interval '1 day')
          LIMIT $2
        )`,
      [days, batchSize],
    )
    return result.rowCount ?? 0
  }

  // keep-last-n (default)
  const keepN = Math.max(META_REVISION_RETENTION_MIN_KEEP_N, Math.floor(config.keepN))
  const result = await query(
    `DELETE FROM ${META_REVISION_RETENTION_TABLE}
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
                 row_number() OVER (PARTITION BY sheet_id, record_id ORDER BY version DESC, created_at DESC) AS rn
          FROM ${META_REVISION_RETENTION_TABLE}
        ) ranked
        WHERE ranked.rn > $1
        LIMIT $2
      )`,
    [keepN, batchSize],
  )
  return result.rowCount ?? 0
}

/** Default sweep cadence (24h), env-overridable, clamped to [1m, 24h]. */
export const META_REVISION_RETENTION_DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000

function resolveIntervalMs(raw: string | undefined): number {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return META_REVISION_RETENTION_DEFAULT_INTERVAL_MS
  return Math.min(Math.max(Math.floor(parsed), 60_000), META_REVISION_RETENTION_DEFAULT_INTERVAL_MS)
}

export interface MetaRevisionRetentionSchedulerOptions {
  logger?: Logger
  query?: RetentionQueryFn
  intervalMs?: number
  env?: NodeJS.ProcessEnv
}

/**
 * Runtime entry: start the periodic retention sweep. **No-op (returns immediately) when retention is
 * disabled** — which is the default — so wiring this into bootstrap changes nothing until the owner
 * sets `MULTITABLE_META_REVISION_RETENTION_ENABLED=1`. Mirrors `startMultitableAttachmentCleanup`
 * (setInterval + returned stop fn; errors are logged, never crash the process). Returns a stop fn.
 */
export function startMetaRevisionRetention(options: MetaRevisionRetentionSchedulerOptions = {}): () => void {
  const env = options.env ?? process.env
  const config = resolveMetaRevisionRetentionConfig(env)
  const logger = options.logger ?? new Logger('MetaRevisionRetention')
  if (!config.enabled) {
    logger.info('Meta-revision retention disabled (set MULTITABLE_META_REVISION_RETENTION_ENABLED=1 to enable)')
    return () => {}
  }
  const queryFn = options.query ?? (dbQuery as unknown as RetentionQueryFn)
  const intervalMs = options.intervalMs ?? resolveIntervalMs(env.MULTITABLE_META_REVISION_RETENTION_INTERVAL_MS)
  const runSweep = () => {
    void Promise.resolve()
      .then(() => sweepMetaRevisionRetention(queryFn, config))
      .then((deleted) => { if (deleted > 0) logger.info(`Meta-revision retention pruned ${deleted} revision(s)`) })
      .catch((error) => logger.warn('Meta-revision retention sweep failed', error as Error))
  }
  const timer = setInterval(runSweep, intervalMs)
  if (typeof timer === 'object' && 'unref' in timer) (timer as { unref: () => void }).unref()
  logger.info(`Meta-revision retention started (policy=${config.policy}, keepN=${config.keepN}, days=${config.retentionDays}, intervalMs=${intervalMs})`)
  return () => clearInterval(timer)
}
