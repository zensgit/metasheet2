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

export const META_CONFIG_REVISION_RETENTION_TABLE = 'meta_config_revisions'

/**
 * T9 D4 — prune old CONFIG/schema-change history (`meta_config_revisions`) by the SAME policy as record revisions
 * (one knob set ages both; disabled by default). The latest revision per (sheet_id, entity_type, entity_id) is ALWAYS
 * retained (row_number=1 over created_at DESC, id DESC), so the current config is always inspectable and the most
 * recent change stays revertible (T9-W). Bounded per pass by batchSize.
 */
export async function sweepConfigRevisionRetention(
  query: RetentionQueryFn,
  config: MetaRevisionRetentionConfig,
): Promise<number> {
  if (!config.enabled) return 0
  const batchSize = Math.max(1, Math.floor(config.batchSize))

  if (config.policy === 'keep-days') {
    const days = Math.max(META_REVISION_RETENTION_MIN_DAYS, Math.floor(config.retentionDays))
    const result = await query(
      `DELETE FROM ${META_CONFIG_REVISION_RETENTION_TABLE}
        WHERE id IN (
          SELECT id FROM (
            SELECT id, created_at,
                   row_number() OVER (PARTITION BY sheet_id, entity_type, entity_id ORDER BY created_at DESC, id DESC) AS rn
            FROM ${META_CONFIG_REVISION_RETENTION_TABLE}
          ) ranked
          WHERE ranked.rn > 1
            AND ranked.created_at < now() - ($1::int * interval '1 day')
          LIMIT $2
        )`,
      [days, batchSize],
    )
    return result.rowCount ?? 0
  }

  const keepN = Math.max(META_REVISION_RETENTION_MIN_KEEP_N, Math.floor(config.keepN))
  const result = await query(
    `DELETE FROM ${META_CONFIG_REVISION_RETENTION_TABLE}
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
                 row_number() OVER (PARTITION BY sheet_id, entity_type, entity_id ORDER BY created_at DESC, id DESC) AS rn
          FROM ${META_CONFIG_REVISION_RETENTION_TABLE}
        ) ranked
        WHERE ranked.rn > $1
        LIMIT $2
      )`,
    [keepN, batchSize],
  )
  return result.rowCount ?? 0
}

export const META_FIELD_VALUE_TOMBSTONE_RETENTION_TABLE = 'meta_field_value_tombstones'
export const META_LINK_TOMBSTONE_RETENTION_TABLE = 'meta_link_tombstones'

function isUndefinedTableError(err: unknown, tableName: string): boolean {
  const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : null
  const message = typeof (err as { message?: unknown })?.message === 'string' ? (err as { message: string }).message : ''
  if (code === '42P01') return message.includes(tableName)
  return message.includes(`relation "${tableName}" does not exist`)
}

/**
 * 4c-2 C6 — prune old tombstone rows (`meta_field_value_tombstones` / `meta_link_tombstones`) under the
 * SAME knob/schedule as the record/config revision sweeps above (one enable flag, one batch size, one
 * interval; disabled by default). UNLIKE those two sweeps, this ALWAYS uses keep-days age-based pruning
 * regardless of `config.policy` — "keep-last-n" has no meaning for a tombstone (there is no per-entity
 * "latest row that must survive" invariant: a tombstone is an independent historical capture, not a
 * superseded-by-newer-version log). There is deliberately no "never delete the latest" floor either — once
 * a tombstone ages out, R1 rehydration for that specific delete cycle correctly degrades to the honest
 * no-tombstone / definition-only path (C1 forward-only), which is the INTENDED behavior of retention, not
 * a bug. Guarded for a pre-migration DB missing the table (degrades to 0 — this is a background janitor,
 * not the fail-closed capture path, so it must never crash the scheduler over a deploy-ordering race).
 */
async function sweepTombstoneTableRetention(
  query: RetentionQueryFn,
  config: MetaRevisionRetentionConfig,
  table: string,
): Promise<number> {
  if (!config.enabled) return 0
  const batchSize = Math.max(1, Math.floor(config.batchSize))
  const days = Math.max(META_REVISION_RETENTION_MIN_DAYS, Math.floor(config.retentionDays))
  const anchorColumn = table === META_LINK_TOMBSTONE_RETENTION_TABLE ? 'source_revision_id' : 'config_revision_id'
  try {
    // 4c-3 §6 — WHOLE-GROUP pruning (fixes 4c-2's torn-set defect): the old shape
    // (`SELECT id … WHERE created_at < cutoff LIMIT batch`, no ORDER BY, no grouping) could slice a
    // single capture (all rows share one created_at) into half a set. Prune by ANCHOR GROUP instead:
    // a group is eligible only when its newest row has aged out, and it is deleted whole. LIMIT now
    // bounds GROUPS per pass, not rows — a group is at most one capture set, which the capture cap
    // already bounds (fail-closed at write time), so a pass stays bounded.
    //
    // 4c-3 §6 — RETENTION FLOOR (link tombstones only): meta_records_trash is immortal (its only
    // DELETE is on successful restore) while tombstones age out — without a floor, an old record
    // stays restorable but its inbound edges silently vanish. A group whose anchor is still
    // referenced by a LIVE trash row (meta_records_trash.delete_revision_id) is NEVER pruned; it
    // becomes prunable the moment the trash row is restored (trash row deleted) or the anchor was
    // never trash-referenced (e.g. field_delete captures — their anchors never appear in trash).
    const floorPredicate =
      table === META_LINK_TOMBSTONE_RETENTION_TABLE
        ? `AND NOT EXISTS (
             SELECT 1 FROM meta_records_trash tr
              WHERE tr.delete_revision_id = g.anchor::text
           )`
        : ''
    let grouped = 0
    try {
      const groupedRes = await query(
        `DELETE FROM ${table}
          WHERE ${anchorColumn} IN (
            SELECT g.anchor FROM (
              SELECT ${anchorColumn} AS anchor, max(created_at) AS newest
                FROM ${table}
               WHERE ${anchorColumn} IS NOT NULL
               GROUP BY ${anchorColumn}
            ) g
            WHERE g.newest < now() - ($1::int * interval '1 day')
            ${floorPredicate}
            LIMIT $2
          )`,
        [days, batchSize],
      )
      grouped = groupedRes.rowCount ?? 0
    } catch (err) {
      // Deploy window: meta_records_trash.delete_revision_id not yet migrated (42703) — degrade to
      // the floorless group prune rather than wedging the janitor. Old-schema trash rows have no
      // anchor to protect anyway (their delete_revision_id would be NULL ⇒ no replay ⇒ no floor).
      const msg = err instanceof Error ? err.message : String(err)
      const code = (err as { code?: string } | null)?.code
      if (!(code === '42703' && msg.includes('delete_revision_id'))) throw err
      const fallbackRes = await query(
        `DELETE FROM ${table}
          WHERE ${anchorColumn} IN (
            SELECT g.anchor FROM (
              SELECT ${anchorColumn} AS anchor, max(created_at) AS newest
                FROM ${table}
               WHERE ${anchorColumn} IS NOT NULL
               GROUP BY ${anchorColumn}
            ) g
            WHERE g.newest < now() - ($1::int * interval '1 day')
            LIMIT $2
          )`,
        [days, batchSize],
      )
      grouped = fallbackRes.rowCount ?? 0
    }
    // Anchor-less rows (nullable anchor columns) have no group to tear and no trash reference —
    // prune them individually, exactly as before.
    const looseRes = await query(
      `DELETE FROM ${table}
        WHERE id IN (
          SELECT id FROM ${table}
          WHERE ${anchorColumn} IS NULL
            AND created_at < now() - ($1::int * interval '1 day')
          LIMIT $2
        )`,
      [days, batchSize],
    )
    return grouped + (looseRes.rowCount ?? 0)
  } catch (err) {
    if (isUndefinedTableError(err, table)) return 0
    throw err
  }
}

export async function sweepFieldValueTombstoneRetention(
  query: RetentionQueryFn,
  config: MetaRevisionRetentionConfig,
): Promise<number> {
  return sweepTombstoneTableRetention(query, config, META_FIELD_VALUE_TOMBSTONE_RETENTION_TABLE)
}

export async function sweepLinkTombstoneRetention(
  query: RetentionQueryFn,
  config: MetaRevisionRetentionConfig,
): Promise<number> {
  return sweepTombstoneTableRetention(query, config, META_LINK_TOMBSTONE_RETENTION_TABLE)
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
 * Runtime entry: start the periodic retention sweep of BOTH `meta_record_revisions` and
 * `meta_config_revisions` (T9 D4 — one knob ages both). **No-op (returns immediately) when retention is
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
    // T9 D4: one knob ages BOTH append-only logs. Sweep record revisions AND config/schema
    // revisions each tick, under the same policy/flag/interval (#3168 "same policy as records").
    // The two are isolated: a failure of one never blocks the other, and each keeps the
    // never-delete-latest floor inside its own sweep fn.
    void Promise.resolve()
      .then(() => sweepMetaRevisionRetention(queryFn, config))
      .then((deleted) => { if (deleted > 0) logger.info(`Meta-revision retention pruned ${deleted} record revision(s)`) })
      .catch((error) => logger.warn('Meta-revision retention sweep failed', error as Error))
    void Promise.resolve()
      .then(() => sweepConfigRevisionRetention(queryFn, config))
      .then((deleted) => { if (deleted > 0) logger.info(`Meta-revision retention pruned ${deleted} config revision(s)`) })
      .catch((error) => logger.warn('Config-revision retention sweep failed', error as Error))
    // 4c-2 C6: the two tombstone tables age under the SAME knob (always keep-days — see sweepTombstoneTableRetention
    // doc-comment), isolated from the two sweeps above and from each other.
    void Promise.resolve()
      .then(() => sweepFieldValueTombstoneRetention(queryFn, config))
      .then((deleted) => { if (deleted > 0) logger.info(`Meta-revision retention pruned ${deleted} field-value tombstone(s)`) })
      .catch((error) => logger.warn('Field-value tombstone retention sweep failed', error as Error))
    void Promise.resolve()
      .then(() => sweepLinkTombstoneRetention(queryFn, config))
      .then((deleted) => { if (deleted > 0) logger.info(`Meta-revision retention pruned ${deleted} link tombstone(s)`) })
      .catch((error) => logger.warn('Link tombstone retention sweep failed', error as Error))
  }
  const timer = setInterval(runSweep, intervalMs)
  if (typeof timer === 'object' && 'unref' in timer) (timer as { unref: () => void }).unref()
  logger.info(`Meta-revision retention started (policy=${config.policy}, keepN=${config.keepN}, days=${config.retentionDays}, intervalMs=${intervalMs})`)
  return () => clearInterval(timer)
}
