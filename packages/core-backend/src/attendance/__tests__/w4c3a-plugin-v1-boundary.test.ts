/**
 * Static discriminating guard: plugin V1 path never hydrates payload before
 * classification, and the host call is exactly { jobId }.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../..',
)
const PLUGIN = path.join(ROOT, 'plugins/plugin-attendance/index.cjs')
const require = createRequire(import.meta.url)
const attendancePlugin = require(PLUGIN) as {
  __attendanceW4C3aSyncCompatibilityForTests: {
    normalizeAttendanceSyncImportLockWitness(value: unknown): {
      rolloutKey: string
      legacyIdempotencyKey: string
      helperWaitMs: number
      transactionLockTimeoutMs: number
    } | null
    projectAttendanceImportExecutionReasonCode(row: unknown): Record<string, string>
    classifyAttendanceV1ImportReservationForSync(status: unknown): 'in_progress' | 'conflict'
    acquireAttendanceSyncImportReservationLocks(
      client: { query(text: string, values?: unknown[]): Promise<unknown> },
      input: {
        orgId: string
        idempotencyKey: string
        witness: unknown
        monotonicNow?: () => number
      },
    ): Promise<void>
    loadAttendanceV1ImportReservationForSync(
      client: { query(text: string, values?: unknown[]): Promise<unknown> },
      orgId: string,
      idempotencyKey: string,
    ): Promise<{ kind: 'in_progress' | 'conflict' } | null>
    assertAttendanceV1ImportReservationAllowsSync(
      reservation: { kind: 'in_progress' | 'conflict' } | null,
    ): void
    isAttendanceSyncImportRetryableTransactionError(error: unknown): boolean
    runAttendanceSyncImportSerializableTransaction<T>(
      db: {
        transaction(
          run: (trx: {
            query(text: string, values?: unknown[]): Promise<unknown>
          }) => Promise<T>,
        ): Promise<T>
      },
      runAttempt: (
        trx: { query(text: string, values?: unknown[]): Promise<unknown> },
        attempt: number,
      ) => Promise<T>,
    ): Promise<T>
  }
}
const syncCompatibility =
  attendancePlugin.__attendanceW4C3aSyncCompatibilityForTests

describe('plugin V1 jobId-only boundary (static)', () => {
  const source = fs.readFileSync(PLUGIN, 'utf8')

  it('classifies with a narrow SELECT before any payload hydration', () => {
    expect(source).toMatch(
      /SELECT id, status, w4_contract_version[\s\S]*FROM attendance_import_jobs/,
    )
    const fn = source.slice(
      source.indexOf('const processAsyncImportCommitJob'),
      source.indexOf('const commitAttendanceImportPayload'),
    )
    const classifyEnd = fn.indexOf('if (isV1)')
    expect(classifyEnd).toBeGreaterThan(0)
    const before = fn.slice(0, classifyEnd)
    // Executable classification SQL only — comments may mention payload.
    const executable = before.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(executable).not.toMatch(/SELECT\s+\*/i)
    expect(executable).not.toMatch(/\.payload\b/)
    expect(executable).not.toMatch(/normalizeMetadata\s*\(/)
  })

  it('V1 host call and missing-port posture are fail-closed without a second writer', () => {
    expect(source).toMatch(
      /processLegacyImportPlan\(\s*\{\s*jobId\s*\}\s*\)/,
    )
    expect(source).toMatch(/ATTENDANCE_IMPORT_LEGACY_PLAN_HOST_PORT_MISSING/)
    // V1 success/fail paths must not call updateImportJobProgress (comments ok).
    const processJob = source.slice(
      source.indexOf('const processAsyncImportCommitJob'),
      source.indexOf('const commitAttendanceImportPayload'),
    )
    const v1Start = processJob.indexOf('if (isV1)')
    const legacyGuard = processJob.indexOf('if (!isLegacy)', v1Start)
    expect(v1Start).toBeGreaterThan(-1)
    expect(legacyGuard).toBeGreaterThan(v1Start)
    const withoutComments = processJob
      .slice(v1Start, legacyGuard)
      .replace(/\/\/[^\n]*/g, '')
    expect(withoutComments).not.toMatch(/updateImportJobProgress\s*\(/)
  })

  it('rejects unknown non-null contract versions before legacy hydration', () => {
    const processJob = source.slice(
      source.indexOf('const processAsyncImportCommitJob'),
      source.indexOf('const commitAttendanceImportPayload'),
    )
    const guard = processJob.indexOf('if (!isLegacy)')
    const legacyHydration = processJob.indexOf('const jobRows = await db.query')
    expect(guard).toBeGreaterThan(-1)
    expect(legacyHydration).toBeGreaterThan(guard)
    expect(processJob.slice(guard, legacyHydration)).toMatch(
      /unsupported contract version[\s\S]*return/,
    )
  })

  it('queue and startup recovery both reach processAsyncImportCommitJob', () => {
    expect(source).toMatch(/importQueue\.process\([\s\S]{0,400}processAsyncImportCommitJob/)
    expect(source).toMatch(
      /const enqueueImportJob = async \(jobId\)[\s\S]{0,800}processAsyncImportCommitJob\(\{\s*jobId\s*\}\)/,
    )
    expect(source).toMatch(/Re-enqueue queued\/running jobs on startup[\s\S]{0,600}enqueueImportJob\(row\.id\)/)
  })

  it('projects completed V1 jobs only from the immutable terminal response', () => {
    expect(source).toMatch(
      /terminal\.response AS w4_terminal_response[\s\S]*LEFT JOIN attendance_import_legacy_terminal_responses AS terminal/,
    )
    const mapper = source.slice(
      source.indexOf('const mapImportJobRow'),
      source.indexOf('const estimateCsvRowCount'),
    )
    expect(mapper).toMatch(/isV1\s*&&\s*status === 'completed'/)
    expect(mapper).toContain('row.w4_terminal_response')
    expect(mapper).toContain('ATTENDANCE_IMPORT_LEGACY_TERMINAL_RESPONSE_MISSING')
    expect(mapper).toMatch(
      /isV1 && status === 'completed'[\s\S]*\? row\.w4_terminal_response[\s\S]*: row\.payload/,
    )
  })

  it('projects the values-free V1 execution reason while keeping public error separate', () => {
    const projection = source.slice(
      source.indexOf('const buildImportJobProjectionSql'),
      source.indexOf('const loadImportJob ='),
    )
    expect(projection).toContain('job.w4_execution_reason_code')
    const mapper = source.slice(
      source.indexOf('const mapImportJobRow'),
      source.indexOf('const estimateCsvRowCount'),
    )
    expect(mapper).toContain('...projectAttendanceImportExecutionReasonCode(row)')
    expect(mapper).toContain('error: row.error ?? null')
  })

  it('projects new failed reasons while preserving the existing suspended V1 pair', () => {
    expect(
      syncCompatibility.projectAttendanceImportExecutionReasonCode({
        w4_contract_version: 1,
        status: 'failed',
        w4_execution_reason_code: 'ATTENDANCE_IMPORT_LEGACY_PLAN_DIGEST_MISMATCH',
      }),
    ).toEqual({
      executionReasonCode: 'ATTENDANCE_IMPORT_LEGACY_PLAN_DIGEST_MISMATCH',
    })
    expect(
      syncCompatibility.projectAttendanceImportExecutionReasonCode({
        w4_contract_version: 1,
        status: 'queued',
        w4_execution_reason_code: 'SEGMENT_CALCULATION_SUSPENDED',
      }),
    ).toEqual({
      executionReasonCode: 'SEGMENT_CALCULATION_SUSPENDED',
    })
    for (const row of [
      {
        w4_contract_version: null,
        status: 'failed',
        w4_execution_reason_code: 'ATTENDANCE_IMPORT_LEGACY_PLAN_DIGEST_MISMATCH',
      },
      {
        w4_contract_version: 1,
        status: 'completed',
        w4_execution_reason_code: 'ATTENDANCE_IMPORT_LEGACY_PLAN_DIGEST_MISMATCH',
      },
      {
        w4_contract_version: 1,
        status: 'queued',
        w4_execution_reason_code: 'ATTENDANCE_IMPORT_LEGACY_PLAN_DIGEST_MISMATCH',
      },
      {
        w4_contract_version: 1,
        status: 'failed',
        w4_execution_reason_code: null,
      },
    ]) {
      expect(
        Object.keys(
          syncCompatibility.projectAttendanceImportExecutionReasonCode(row),
        ),
      ).toEqual([])
    }
  })

  it('takes shared rollout, shipped two-int, and canonical class-10 locks under one deadline', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = []
    let tick = 0
    await syncCompatibility.acquireAttendanceSyncImportReservationLocks(
      {
        query: async (text, values = []) => {
          calls.push({ text, values })
          return []
        },
      },
      {
        orgId: 'default',
        idempotencyKey: 'sync-key',
        witness: {
          rolloutKey: '1',
          legacyIdempotencyKey: '-2',
          helperWaitMs: 5000,
          transactionLockTimeoutMs: 5000,
        },
        monotonicNow: () => tick++,
      },
    )
    expect(calls.map((call) => call.text)).toEqual([
      "SELECT set_config('lock_timeout', $1, true)",
      'SELECT pg_advisory_xact_lock_shared($1::bigint)',
      "SELECT set_config('lock_timeout', $1, true)",
      'SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))',
      "SELECT set_config('lock_timeout', $1, true)",
      'SELECT pg_advisory_xact_lock($1::bigint)',
      "SELECT set_config('lock_timeout', $1, true)",
    ])
    expect(calls[1]?.values).toEqual(['1'])
    expect(calls[3]?.values).toEqual(['default', 'sync-key'])
    expect(calls[5]?.values).toEqual(['-2'])
    expect(calls[6]?.values).toEqual(['5000'])
  })

  it('maps only helper lock timeout to values-free busy postures', async () => {
    const sharedBusy = { code: '55P03', message: 'raw-shared-lock-detail' }
    await expect(
      syncCompatibility.acquireAttendanceSyncImportReservationLocks(
        {
          query: async (text) => {
            if (text.includes('pg_advisory_xact_lock_shared')) throw sharedBusy
            return []
          },
        },
        {
          orgId: 'default',
          idempotencyKey: 'sync-key',
          witness: {
            rolloutKey: '1',
            legacyIdempotencyKey: '-2',
            helperWaitMs: 5000,
            transactionLockTimeoutMs: 5000,
          },
        },
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: 'ATTENDANCE_CALCULATION_ROLLOUT_BUSY',
      message: 'ATTENDANCE_CALCULATION_ROLLOUT_BUSY',
    })

    const databaseError = { code: 'XX000', message: 'database failure' }
    await expect(
      syncCompatibility.acquireAttendanceSyncImportReservationLocks(
        {
          query: async (text) => {
            if (text.includes('pg_advisory_xact_lock_shared')) {
              throw databaseError
            }
            return []
          },
        },
        {
          orgId: 'default',
          idempotencyKey: 'sync-key',
          witness: {
            rolloutKey: '1',
            legacyIdempotencyKey: '-2',
            helperWaitMs: 5000,
            transactionLockTimeoutMs: 5000,
          },
        },
      ),
    ).rejects.toBe(databaseError)
  })

  it('runs the sync source/effect body under SERIALIZABLE and retries only whole transactions', async () => {
    const transactionQueries: string[][] = []
    const seenAttempts: number[] = []
    let currentQueries: string[] = []
    const sharedTransactionClient = {
      query: async (text: string) => {
        currentQueries.push(text)
        return []
      },
    }
    const transientErrors = [
      Object.assign(new Error('serialization detail'), { code: '40001' }),
      Object.assign(new Error('deadlock detail'), { code: '40P01' }),
    ]
    const result =
      await syncCompatibility.runAttendanceSyncImportSerializableTransaction(
        {
          transaction: async (run) => {
            const queries: string[] = []
            currentQueries = queries
            transactionQueries.push(queries)
            return run(sharedTransactionClient)
          },
        },
        async (_trx, attempt) => {
          seenAttempts.push(attempt)
          if (attempt < transientErrors.length) throw transientErrors[attempt]
          return 'committed'
        },
      )

    expect(result).toBe('committed')
    expect(seenAttempts).toEqual([0, 1, 2])
    expect(transactionQueries).toHaveLength(3)
    for (const queries of transactionQueries) {
      expect(queries[0]).toBe('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')
      expect(queries[1]).toMatch(/^SET LOCAL statement_timeout = /)
    }
  })

  it('propagates non-retryable SQL errors without replaying the transaction body', async () => {
    const constraintError = Object.assign(new Error('unique detail'), {
      code: '23505',
    })
    let transactionCalls = 0
    let bodyCalls = 0
    await expect(
      syncCompatibility.runAttendanceSyncImportSerializableTransaction(
        {
          transaction: async (run) => {
            transactionCalls += 1
            return run({ query: async () => [] })
          },
        },
        async () => {
          bodyCalls += 1
          throw constraintError
        },
      ),
    ).rejects.toBe(constraintError)
    expect(transactionCalls).toBe(1)
    expect(bodyCalls).toBe(1)
    expect(
      syncCompatibility.isAttendanceSyncImportRetryableTransactionError(
        constraintError,
      ),
    ).toBe(false)
  })

  it('bounds retryable SQL failures at three attempts and preserves the final error', async () => {
    const errors = Array.from({ length: 3 }, (_, index) =>
      Object.assign(new Error(`serialization-${index}`), { code: '40001' }),
    )
    let bodyCalls = 0
    await expect(
      syncCompatibility.runAttendanceSyncImportSerializableTransaction(
        {
          transaction: async (run) =>
            run({ query: async () => [] }),
        },
        async () => {
          const error = errors[bodyCalls]
          bodyCalls += 1
          throw error
        },
      ),
    ).rejects.toBe(errors[2])
    expect(bodyCalls).toBe(3)
  })

  it('discards a failed attempt effect and returns only fresh successful-attempt state', async () => {
    const persistedEffects: string[] = []
    let stagedEffects: string[] = []
    const result =
      await syncCompatibility.runAttendanceSyncImportSerializableTransaction(
        {
          transaction: async (run) => {
            stagedEffects = []
            try {
              const value = await run({ query: async () => [] })
              persistedEffects.push(...stagedEffects)
              return value
            } catch (error) {
              stagedEffects = []
              throw error
            }
          },
        },
        async (_trx, attempt) => {
          const results = [`result-${attempt}`]
          stagedEffects.push(`effect-${attempt}`)
          if (attempt === 0) {
            throw Object.assign(new Error('retry'), { code: '40001' })
          }
          return results
        },
      )

    expect(result).toEqual(['result-1'])
    expect(persistedEffects).toEqual(['effect-1'])
  })

  it('rechecks V1 reservations under row lock and returns closed sync postures', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = []
    const queued = await syncCompatibility.loadAttendanceV1ImportReservationForSync(
      {
        query: async (text, values = []) => {
          calls.push({ text, values })
          return [{ id: 'job-1', status: 'queued' }]
        },
      },
      'org-1',
      'sync-key',
    )
    expect(queued).toEqual({ kind: 'in_progress' })
    expect(calls[0]?.text).toMatch(/w4_contract_version = 1[\s\S]*FOR UPDATE/)
    expect(calls[0]?.values).toEqual(['org-1', 'sync-key'])
    expect(() =>
      syncCompatibility.assertAttendanceV1ImportReservationAllowsSync(queued),
    ).toThrow(
      expect.objectContaining({
        status: 409,
        code: 'ATTENDANCE_OPERATION_IN_PROGRESS',
      }),
    )

    const failed = await syncCompatibility.loadAttendanceV1ImportReservationForSync(
      {
        query: async () => [{ id: 'job-2', status: 'failed' }],
      },
      'org-1',
      'sync-key',
    )
    expect(failed).toEqual({ kind: 'conflict' })
    expect(() =>
      syncCompatibility.assertAttendanceV1ImportReservationAllowsSync(failed),
    ).toThrow(
      expect.objectContaining({
        status: 409,
        code: 'ATTENDANCE_OPERATION_BATCH_CONFLICT',
      }),
    )
  })

  it('wires the sync route recheck before effect DML', () => {
    const syncRouteStart = source.indexOf(
      "'/api/attendance/import/commit'",
    )
    const syncRoute = source.slice(
      syncRouteStart,
      source.indexOf("'/api/attendance/import/preview-async'", syncRouteStart),
    )
    const lock = syncRoute.indexOf(
      'acquireAttendanceSyncImportReservationLocks',
    )
    const batchRecheck = syncRoute.indexOf('loadIdempotentImportBatch', lock)
    const reservationRecheck = syncRoute.indexOf(
      'loadAttendanceV1ImportReservationForSync',
      batchRecheck,
    )
    const firstEffect = syncRoute.indexOf(
      'INSERT INTO attendance_import_batches',
      reservationRecheck,
    )
    expect(lock).toBeGreaterThan(-1)
    expect(batchRecheck).toBeGreaterThan(lock)
    expect(reservationRecheck).toBeGreaterThan(batchRecheck)
    expect(firstEffect).toBeGreaterThan(reservationRecheck)
  })

  it('keeps sync retry state attempt-local and releases source rows only after commit', () => {
    const syncRouteStart = source.indexOf(
      "'/api/attendance/import/commit'",
    )
    const syncRoute = source.slice(
      syncRouteStart,
      source.indexOf("'/api/attendance/import/preview-async'", syncRouteStart),
    )
    const transactionStart = syncRoute.indexOf(
      'runAttendanceSyncImportSerializableTransaction',
    )
    const firstEffect = syncRoute.indexOf(
      'INSERT INTO attendance_import_batches',
      transactionStart,
    )
    const transactionResult = syncRoute.indexOf(
      '} = transactionResult',
      firstEffect,
    )
    expect(transactionStart).toBeGreaterThan(-1)
    expect(firstEffect).toBeGreaterThan(transactionStart)
    expect(transactionResult).toBeGreaterThan(firstEffect)

    const attemptSetup = syncRoute.slice(transactionStart, firstEffect)
    for (const declaration of [
      'const results = []',
      'let importedCount = 0',
      'const skipped = []',
      'const batchId = randomUUID()',
      'const groupWarnings = []',
      'const ruleSetConfigCache = new Map()',
      'const engineCache = new Map()',
    ]) {
      expect(attemptSetup).toContain(declaration)
    }
    expect(attemptSetup).toMatch(
      /loadAttendanceV1ImportReservationForSync[\s\S]*loadDefaultRule\(trx, orgId\)/,
    )
    expect(attemptSetup).toContain(
      'loadSettings(trx, { failClosed: true })',
    )
    expect(syncRoute).toContain(
      'loadRuleSetConfigById(trx, orgId, activeRuleSetId)',
    )

    const releaseCalls = Array.from(
      syncRoute.matchAll(/releaseImportRowMemory\(row\)/g),
      (match) => match.index,
    )
    expect(releaseCalls).toHaveLength(1)
    expect(releaseCalls[0]).toBeGreaterThan(transactionResult)
  })

  it('drains durable upload cleanup immediately and during startup recovery', () => {
    expect(source).toMatch(/attendance_claim_import_upload_cleanup_command/)
    expect(source).toMatch(/attendance_finish_import_upload_cleanup_command/)
    const processJob = source.slice(
      source.indexOf('const processAsyncImportCommitJob'),
      source.indexOf('const commitAttendanceImportPayload'),
    )
    const completedOutcome = processJob.slice(
      processJob.indexOf('const outcome ='),
      processJob.indexOf('// not_found or unexpected'),
    )
    expect(completedOutcome).toMatch(
      /outcome\.kind === 'completed'[\s\S]*await drainImportUploadCleanupCommand\(rowId\)/,
    )
    const startupRecovery = source.slice(
      source.indexOf('const attendanceImportAsyncStartupCutoff'),
      source.indexOf('const integrationCreateSchema'),
    )
    expect(startupRecovery).toMatch(
      /attendance_import_upload_cleanup_commands AS cleanup[\s\S]*failed_retryable[\s\S]*drainImportUploadCleanupCommand\(row\.job_id\)/,
    )
    expect(source).toMatch(/reason\.code === 'ENOENT'/)
    expect(source).toMatch(/'failed_retryable', 'UPLOAD_DELETE_FAILED'/)
  })
})
