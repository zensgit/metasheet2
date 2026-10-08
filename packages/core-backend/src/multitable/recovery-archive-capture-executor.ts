import { performance } from 'node:perf_hooks'
import type { Pool, PoolClient } from 'pg'

import {
  readRecoveryArchiveBoundedCaptureSource,
  RecoveryArchiveBoundedSourceError,
  snapshotRecoveryArchiveCaptureLimits,
  type RecoveryArchiveCaptureLimits,
} from './recovery-archive-bounded-source'
import type {
  RecoveryArchiveCaptureSource,
  RecoveryArchiveSourceQuery,
  RecoveryArchiveSourceScope,
} from './recovery-archive-relational-source'

/**
 * Own one fresh read-only RR connection through acquisition, capture and confirmed COMMIT.
 * This internal metadata prerequisite neither issues claim authority nor authorizes an archive.
 * The full owned coordinator must still verify committed block/generation/reservations/pins in
 * this same snapshot before it can use this lifecycle for an authenticated archive capture.
 * Native acquisition must have an explicit finite timeout within the capture budget: its queue
 * and in-flight handshake are bounded by that policy even before an acquired client is available.
 */
export async function captureRecoveryArchiveBoundedDatabaseSource(
  pool: Pick<Pool, 'connect' | 'options'>,
  scopeInput: RecoveryArchiveSourceScope,
  limitsInput: RecoveryArchiveCaptureLimits,
): Promise<RecoveryArchiveCaptureSource> {
  const limits = snapshotRecoveryArchiveCaptureLimits(limitsInput)
  const acquisitionTimeout = pool?.options?.connectionTimeoutMillis
  if (typeof acquisitionTimeout !== 'number' || !Number.isSafeInteger(acquisitionTimeout)
    || acquisitionTimeout <= 0 || acquisitionTimeout > limits.timeoutMs) {
    throw new RecoveryArchiveBoundedSourceError('RECOVERY_ARCHIVE_CAPTURE_POLICY_INVALID')
  }
  const scope = Object.freeze({ ...scopeInput })
  if ([scope.sheetId, scope.baseId, scope.workspaceId].some((value) =>
    typeof value !== 'string' || !value || value.trim() !== value)) {
    throw new RecoveryArchiveBoundedSourceError('RECOVERY_ARCHIVE_CAPTURE_UNAVAILABLE')
  }
  const deadline = performance.now() + limits.timeoutMs
  let client: PoolClient | undefined
  let released = false
  let poisoned = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = () => new RecoveryArchiveBoundedSourceError('RECOVERY_ARCHIVE_CAPTURE_TIME_EXCEEDED')
  const discard = () => {
    if (client && !released) {
      released = true
      client.release(true)
    }
  }
  const assertLive = () => {
    if (poisoned || performance.now() >= deadline) throw timeout()
  }
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      poisoned = true
      try { discard() } finally { reject(timeout()) }
    }, limits.timeoutMs)
  })
  // Promise.race observes this continuation even after expiry. Its exclusive query wrapper
  // refuses later SQL, and a connection acquired after expiry is immediately discarded.
  const execution = (async () => {
    client = await pool.connect()
    assertLive()
    const query: RecoveryArchiveSourceQuery = async (sql, params) => {
      assertLive()
      const result = await client!.query(sql, params)
      assertLive()
      return result
    }
    await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', [])
    const source = await readRecoveryArchiveBoundedCaptureSource(query, scope, {
      maxBytes: limits.maxBytes,
      timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())),
    })
    await query('COMMIT', [])
    assertLive()
    released = true
    client.release()
    assertLive()
    return source
  })()
  try {
    return await Promise.race([execution, expiry])
  } catch (error) {
    poisoned = true
    discard()
    if (error instanceof RecoveryArchiveBoundedSourceError) throw error
    throw new RecoveryArchiveBoundedSourceError('RECOVERY_ARCHIVE_CAPTURE_UNAVAILABLE')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    // Acquisition can finish after the public deadline. This attached rejection handler also
    // discards that late connection before any SQL is sent.
    void execution.catch(() => { discard() })
  }
}
