import { Logger } from '../core/logger'
import { query } from '../db/pg'
import { isDatabaseSchemaError } from '../utils/database-errors'

export type OperationAuditRetentionOptions = {
  retentionDays?: number
  intervalMs?: number
  logger?: Logger
}

function parseRetentionDays(raw: string | undefined): number {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return 90
  return Math.min(Math.max(Math.floor(parsed), 1), 3650)
}

function parseIntervalMs(raw: string | undefined): number {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return 24 * 60 * 60 * 1000
  return Math.min(Math.max(Math.floor(parsed), 10_000), 7 * 24 * 60 * 60 * 1000)
}

function isEnabled(): boolean {
  if (process.env.OPERATION_AUDIT_RETENTION_ENABLED) {
    return process.env.OPERATION_AUDIT_RETENTION_ENABLED === 'true'
  }
  return process.env.NODE_ENV === 'production'
}

export function startOperationAuditRetention(options: OperationAuditRetentionOptions = {}): () => void {
  if (!isEnabled()) return () => {}

  const logger = options.logger ?? new Logger('OperationAuditRetention')
  const retentionDays = options.retentionDays ?? parseRetentionDays(process.env.OPERATION_AUDIT_LOG_RETENTION_DAYS)
  const intervalMs = options.intervalMs ?? parseIntervalMs(process.env.OPERATION_AUDIT_RETENTION_INTERVAL_MS)

  let stopped = false

  async function runOnce(): Promise<void> {
    if (stopped) return

    try {
      const result = await query(
        `DELETE FROM operation_audit_logs
         WHERE occurred_at < now() - make_interval(days => $1)`,
        [retentionDays],
      )

      if (typeof result.rowCount === 'number' && result.rowCount > 0) {
        logger.info(`Operation audit retention deleted ${result.rowCount} row(s) (retentionDays=${retentionDays})`)
      }
    } catch (error) {
      if (isDatabaseSchemaError(error)) {
        logger.warn('Operation audit retention skipped: operation_audit_logs not ready', error as Error)
        return
      }
      logger.warn('Operation audit retention failed', error as Error)
    }
  }

  // Fire-and-forget initial cleanup.
  void runOnce()

  const timer = setInterval(() => {
    void runOnce()
  }, intervalMs)

  // Avoid holding the event loop open in CLI/tests.
  timer.unref?.()

  logger.info(`Operation audit retention started (retentionDays=${retentionDays}, intervalMs=${intervalMs})`)

  return () => {
    stopped = true
    clearInterval(timer)
    logger.info('Operation audit retention stopped')
  }
}

