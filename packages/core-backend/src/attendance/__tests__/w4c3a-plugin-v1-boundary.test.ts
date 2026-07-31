/**
 * Static discriminating guard: plugin V1 path never hydrates payload before
 * classification, and the host call is exactly { jobId }.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildAttendanceImportPolicySourceProofV1 } from '../w4c3a-import-proof'

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../..',
)
const PLUGIN = path.join(ROOT, 'plugins/plugin-attendance/index.cjs')
const require = createRequire(import.meta.url)
const attendancePlugin = require(PLUGIN) as {
  __attendanceImportForTests: {
    buildImportCanonicalFreezeSourceV1(
      input: Record<string, unknown>,
    ): Record<string, unknown>
  }
  __attendanceW4C3aSyncCompatibilityForTests: {
    foldAttendanceImportPreparedTargets(input: {
      items: readonly Record<string, unknown>[]
      existingMap: Map<string, Record<string, unknown>>
      orgId: string
      sourceBatchId: string
    }): {
      recordWrites: readonly Record<string, unknown>[]
      targetRefBySourceOrdinal: Map<number, string>
    }
    prepareAttendanceImportRecordRows(
      rows: readonly Record<string, unknown>[],
    ): readonly Readonly<Record<string, unknown>>[]
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

  it('cuts only commit-async over to the V1 reservation host', () => {
    const previewStart = source.indexOf("'/api/attendance/import/preview'")
    const preview = source.slice(
      previewStart,
      source.indexOf("'/api/attendance/import/commit'", previewStart),
    )
    expect(preview).not.toContain('reserveLegacyImportPlan')
    expect(preview).not.toContain('Full attendance import permission required')
    expect(preview.match(/const importAccess =/g)).toHaveLength(1)

    const asyncRouteMarker = [
      'context.api.http.addRoute(',
      "      'POST',",
      "      '/api/attendance/import/commit-async',",
    ].join('\n')
    const jobsRouteMarker = [
      'context.api.http.addRoute(',
      "      'GET',",
      "      '/api/attendance/import/jobs/:id',",
    ].join('\n')
    const asyncStart = source.indexOf(asyncRouteMarker)
    const asyncRoute = source.slice(
      asyncStart,
      source.indexOf(jobsRouteMarker, asyncStart),
    )
    const fullImport = asyncRoute.indexOf('if (!importAccess.fullImport)')
    const portCheck = asyncRoute.indexOf(
      "typeof legacyPlanPort.reserveLegacyImportPlan !== 'function'",
    )
    const prepare = asyncRoute.indexOf('prepareOnly: true')
    const reserve = asyncRoute.indexOf(
      'legacyPlanPort.reserveLegacyImportPlan',
      prepare,
    )
    const enqueue = asyncRoute.indexOf('enqueueImportJob(jobId)', reserve)
    expect(fullImport).toBeGreaterThan(-1)
    expect(portCheck).toBeGreaterThan(fullImport)
    expect(prepare).toBeGreaterThan(portCheck)
    expect(reserve).toBeGreaterThan(prepare)
    expect(enqueue).toBeGreaterThan(reserve)
    expect(asyncRoute).not.toMatch(/INSERT INTO attendance_import_jobs/)
    expect(asyncRoute).not.toContain('sanitizeImportJobPayload')
  })

  it('cuts P09 legacy import over to prepare/apply without retaining its private writer', () => {
    const routeStart = source.indexOf("'/api/attendance/import',")
    const routeEnd = source.indexOf("'/api/attendance/integrations',", routeStart)
    const route = source.slice(routeStart, routeEnd)
    const prepareAccess = route.indexOf('assertAttendanceImportPrepareAllowed')
    const scopedAccess = route.indexOf('assertAttendanceImportCommitAllowed')
    const token = route.indexOf('consumeImportCommitToken')
    const prepare = route.indexOf('prepareOnly: true')
    const apply = route.indexOf('await syncImportPort.commitSyncImportPlan')
    expect(routeStart).toBeGreaterThan(-1)
    expect(routeEnd).toBeGreaterThan(routeStart)
    expect(prepareAccess).toBeGreaterThan(-1)
    expect(scopedAccess).toBeGreaterThan(prepareAccess)
    expect(token).toBeGreaterThan(scopedAccess)
    expect(prepare).toBeGreaterThan(token)
    expect(apply).toBeGreaterThan(prepare)
    expect(route).not.toContain('await db.transaction')
    expect(route).not.toContain('upsertAttendanceRecord')
    expect(route).not.toContain('resolveWorkContext({')
  })

  it('keeps preparation-only calculation free of compatibility DML', () => {
    const calculator = source.slice(
      source.indexOf('const commitAttendanceImportPayload = async'),
      source.indexOf('// Register queue processor'),
    )
    expect(calculator).toContain('prepareOnly = false')
    expect(calculator).toContain('if (!prepareOnly) await trx.query(batchInsert.sql')
    expect(calculator).toContain('if (prepareOnly) return')
    expect(calculator).toMatch(
      /if \(prepareOnly\) \{[\s\S]*preparedPlanRecordWrites\.push[\s\S]*preparedPlanItems\.push/,
    )
    expect(calculator).toMatch(
      /if \(!prepareOnly && groupSync\?\.autoAssignMembers[\s\S]*insertAttendanceGroupMembers/,
    )
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
    // W4C-3a P06: route keeps early auth/idempotency/token ordering, then
    // prepareOnly + core commitSyncImportPlan. Class-10 recheck and effect DML
    // live in the least-privilege host (not inline plugin SQL).
    const routeMarker = [
      'context.api.http.addRoute(',
      "      'POST',",
      "      '/api/attendance/import/commit',",
    ].join('\n')
    const nextMarker = [
      'context.api.http.addRoute(',
      "      'POST',",
      "      '/api/attendance/import/preview-async',",
    ].join('\n')
    const syncRouteStart = source.indexOf(routeMarker)
    const syncRoute = source.slice(
      syncRouteStart,
      source.indexOf(nextMarker, syncRouteStart),
    )
    const earlyReplay = syncRoute.indexOf('loadIdempotentImportBatch')
    const tokenConsume = syncRoute.indexOf('consumeImportCommitToken')
    const prepare = syncRoute.indexOf('prepareOnly: true')
    const portCall = syncRoute.indexOf('commitSyncImportPlan', prepare)
    expect(earlyReplay).toBeGreaterThan(-1)
    expect(tokenConsume).toBeGreaterThan(earlyReplay)
    expect(prepare).toBeGreaterThan(tokenConsume)
    expect(portCall).toBeGreaterThan(prepare)
    expect(syncRoute).not.toMatch(/INSERT INTO attendance_import_batches/)
    expect(syncRoute).not.toMatch(/processLegacyImportPlan\s*\(/)

    const host = fs.readFileSync(
      path.join(ROOT, 'packages/core-backend/src/attendance/w4c3a-sync-import-host.ts'),
      'utf8',
    )
    expect(host).toContain('acquireAttendanceImportReservationLocksV1')
    expect(host).toContain('INSERT INTO attendance_import_batches')
    const lock = host.indexOf('acquireAttendanceImportReservationLocksV1')
    const batchEffect = host.indexOf('INSERT INTO attendance_import_batches', lock)
    expect(batchEffect).toBeGreaterThan(lock)
  })

  it('dispatches values, unnest, and staging from one immutable prepared-row boundary', () => {
    const input = {
      userId: 'user-1',
      orgId: 'org-1',
      workDate: '2026-07-31',
      timezone: 'Asia/Taipei',
      firstInAt: '2026-07-31T01:00:00.000Z',
      lastOutAt: '2026-07-31T09:00:00.000Z',
      workMinutes: 480,
      lateMinutes: 0,
      earlyLeaveMinutes: 0,
      status: 'normal',
      isWorkday: true,
      metaJson: '{}',
      sourceBatchId: '10000000-0000-4000-8000-000000000001',
      ignoredTransportHint: 'must-not-cross',
    }
    const prepared = syncCompatibility.prepareAttendanceImportRecordRows([
      input,
    ])
    expect(Object.isFrozen(prepared)).toBe(true)
    expect(Object.isFrozen(prepared[0])).toBe(true)
    expect(prepared[0]).toEqual({
      userId: input.userId,
      orgId: input.orgId,
      workDate: input.workDate,
      timezone: input.timezone,
      firstInAt: input.firstInAt,
      lastOutAt: input.lastOutAt,
      workMinutes: input.workMinutes,
      lateMinutes: input.lateMinutes,
      earlyLeaveMinutes: input.earlyLeaveMinutes,
      status: input.status,
      isWorkday: input.isWorkday,
      metaJson: input.metaJson,
      sourceBatchId: input.sourceBatchId,
    })

    const dispatcher = source.slice(
      source.indexOf('async function batchUpsertAttendanceRecords(client'),
      source.indexOf('async function batchInsertAttendanceImportItemsValues'),
    )
    expect(dispatcher.match(/prepareAttendanceImportRecordRows\(rows\)/g)).toHaveLength(1)
    for (const adapter of [
      'batchUpsertAttendanceRecordsValues(client, preparedRows)',
      'batchUpsertAttendanceRecordsUnnest(client, preparedRows)',
      'batchUpsertAttendanceRecordsStaging(client, preparedRows, { totalRows })',
    ]) {
      expect(dispatcher).toContain(adapter)
    }
    expect(dispatcher).not.toMatch(/batchUpsertAttendanceRecords(?:Values|Unnest|Staging)\(client, rows/)
  })

  it('folds duplicate targets in source order and binds both source ordinals', () => {
    const target = ['org-1', 'user-1', '2026-07-31']
    const common = {
      userId: 'user-1',
      workDate: '2026-07-31',
      timezone: 'Asia/Taipei',
      mode: 'override',
      updateLastOutAt: new Date('2026-07-31T09:00:00.000Z'),
      overrideMetrics: {
        workMinutes: 480,
        lateMinutes: 0,
        earlyLeaveMinutes: 0,
      },
      isWorkday: true,
      meta: {},
      sourceBatchId: '10000000-0000-4000-8000-000000000001',
      rule: {
        timezone: 'Asia/Taipei',
        workStartTime: '09:00',
        workEndTime: '18:00',
        lateGraceMinutes: 0,
        earlyGraceMinutes: 0,
        roundingMinutes: 1,
      },
      leaveMinutes: 0,
      overtimeMinutes: 0,
    }
    const policySourceProof = buildAttendanceImportPolicySourceProofV1({
      ruleVersion: 'org-default-rule',
      engineVersion: null,
      rule: {
        timezone: 'Asia/Taipei',
        workStartTime: '09:00',
        workEndTime: '18:00',
        lateGraceMinutes: 0,
        earlyGraceMinutes: 0,
        roundingMinutes: 1,
        severeLateThresholdMinutes: 30,
        absenceLateThresholdMinutes: 60,
        workingDays: [1, 2, 3, 4, 5],
      },
      policy: { appliedRules: [], userGroups: [] },
      engine: null,
    })
    const freezeSource = (sourceOrdinal: number, status: string) =>
      attendancePlugin.__attendanceImportForTests.buildImportCanonicalFreezeSourceV1({
        sourceOrdinal,
        attribution: {
          posture: 'unsupported',
          sourceSchemaVersion: null,
          reason: 'unresolved',
          sourceFingerprint: null,
        },
        importAttributionReconstruction: null,
        context: null,
        policySourceProof,
        output: {
          status,
          workMinutes: 480,
          lateMinutes: status === 'late' ? 15 : 0,
          earlyLeaveMinutes: 0,
          leaveMinutes: 0,
          overtimeMinutes: 0,
        },
      })
    const folded = syncCompatibility.foldAttendanceImportPreparedTargets({
      items: [
        {
          ...common,
          sourceOrdinal: 3,
          updateFirstInAt: new Date('2026-07-31T01:30:00.000Z'),
          statusOverride: 'late',
          previewSnapshot: { policy: { source: 'first' } },
          canonicalFreezeSource: freezeSource(3, 'late'),
        },
        {
          ...common,
          sourceOrdinal: 4,
          updateFirstInAt: new Date('2026-07-31T01:00:00.000Z'),
          statusOverride: 'normal',
          previewSnapshot: { policy: { source: 'second' } },
          canonicalFreezeSource: freezeSource(4, 'normal'),
        },
      ],
      existingMap: new Map(),
      orgId: 'org-1',
      sourceBatchId: common.sourceBatchId,
    })

    expect(folded.recordWrites).toHaveLength(1)
    expect(folded.recordWrites[0]).toMatchObject({
      sourceOrdinals: [3, 4],
      status: 'normal',
      firstInAt: '2026-07-31T01:00:00.000Z',
      sourceBatchId: common.sourceBatchId,
      attributionSnapshot: { schemaVersion: 2 },
      policySnapshot: { schemaVersion: 2 },
    })
    const write = folded.recordWrites[0] as {
      attributionSnapshot: { sources: Array<{ sourceOrdinal: number; attribution: unknown; context: unknown }> }
      policySnapshot: {
        sources: Array<{
          sourceOrdinal: number
          sourceFingerprint: string
          sourceDefinition: Record<string, unknown>
          output: Record<string, unknown>
        }>
      }
    }
    expect(write.attributionSnapshot.sources.map((row) => row.sourceOrdinal)).toEqual([3, 4])
    expect(write.policySnapshot.sources.map((row) => row.sourceOrdinal)).toEqual([3, 4])
    expect(Object.keys(write.attributionSnapshot.sources[0]).sort()).toEqual([
      'attribution',
      'context',
      'importAttributionReconstruction',
      'sourceOrdinal',
    ])
    expect(Object.keys(write.policySnapshot.sources[0]).sort()).toEqual([
      'output',
      'sourceDefinition',
      'sourceFingerprint',
      'sourceOrdinal',
    ])
    expect(write.policySnapshot.sources[0].sourceFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(folded.targetRefBySourceOrdinal.get(3)).toBe(JSON.stringify(target))
    expect(folded.targetRefBySourceOrdinal.get(4)).toBe(JSON.stringify(target))
  })

  it('keeps sync retry state attempt-local and releases source rows only after commit', () => {
    // W4C-3a P06: SERIALIZABLE retries are owned by
    // runAttendanceResultOperationTransactionV1 inside the core host. The
    // plugin route only prepares then calls the least-privilege port.
    const routeMarker = [
      'context.api.http.addRoute(',
      "      'POST',",
      "      '/api/attendance/import/commit',",
    ].join('\n')
    const nextMarker = [
      'context.api.http.addRoute(',
      "      'POST',",
      "      '/api/attendance/import/preview-async',",
    ].join('\n')
    const syncRouteStart = source.indexOf(routeMarker)
    const syncRoute = source.slice(
      syncRouteStart,
      source.indexOf(nextMarker, syncRouteStart),
    )
    expect(syncRoute).toContain('prepareOnly: true')
    expect(syncRoute).toContain('commitSyncImportPlan')
    expect(syncRoute).not.toContain(
      'runAttendanceSyncImportSerializableTransaction',
    )

    const host = fs.readFileSync(
      path.join(ROOT, 'packages/core-backend/src/attendance/w4c3a-sync-import-host.ts'),
      'utf8',
    )
    expect(host).toContain('runAttendanceResultOperationTransactionV1')
    const trx = host.indexOf('runAttendanceResultOperationTransactionV1')
    const batchInsert = host.indexOf(
      'INSERT INTO attendance_import_batches',
      trx,
    )
    expect(trx).toBeGreaterThan(-1)
    expect(batchInsert).toBeGreaterThan(trx)
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
