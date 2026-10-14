import { createRequire } from 'node:module'
import type { Pool, PoolClient } from 'pg'
import { vi } from 'vitest'
import * as liveModule from '../../src/attendance/w4c2-live-scheduled-boundary'

type RecordTarget = { orgId: string; userId: string; workDate: string; timezone: string }

const requireCjs = createRequire(import.meta.url)

/** Seed a current record-only fixture through the real timezone prepare/assert/bind protocol. */
export function captureAttendanceRecordTimezoneFixture() {
  type Adapters = Parameters<typeof liveModule.createAttendanceLiveScheduledBoundaryV1>[0]['legacyAdapters']
  let adapters: Adapters | undefined
  const original = liveModule.createAttendanceLiveScheduledBoundaryV1
  const spy = vi.spyOn(liveModule, 'createAttendanceLiveScheduledBoundaryV1').mockImplementation(config => {
    adapters = config.legacyAdapters
    return original(config)
  })
  return {
    restore: () => spy.mockRestore(),
    async seed<T>(pool: Pool, target: RecordTarget,
      insert: (client: PoolClient) => Promise<T>): Promise<T> {
      if (!adapters?.prepareLiveTimezoneContext || !adapters.assertLiveTimezoneTarget || !adapters.bindLiveTimezoneContext) {
        throw new Error('RECORD_FIXTURE_TIMEZONE_ADAPTERS_REQUIRED')
      }
      const plugin = requireCjs('../../../../plugins/plugin-attendance/index.cjs') as {
        readTargetTimezoneContext: (trx: unknown, target: RecordTarget) => Promise<{
          timezone: string; contextFingerprint: string; isWorkingDay: boolean;
          window: { startAt: Date | string }; frozen: boolean;
        }>
      }
      const client = await pool.connect()
      const trx = {
        __rawClient: client,
        query: async (text: string, values?: unknown[]) => (await client.query(text, values)).rows,
      }
      try {
        await client.query('BEGIN')
        const context = await plugin.readTargetTimezoneContext(trx, target)
        if (context.frozen || context.timezone !== target.timezone) throw new Error('RECORD_FIXTURE_FRESH_CONTEXT_REQUIRED')
        const input: liveModule.AttendanceLivePunchBoundaryInputV1 = {
          ...target, operationId: null, eventType: 'check_in', occurredAtRaw: null,
          occurredAtResolved: new Date(context.window.startAt).toISOString(),
          requestTimezone: target.timezone, clientTimezone: target.timezone,
          source: 'manual', location: null, meta: null, photoFileRef: null,
          shiftId: null, outerSourceDefinitionFingerprint: null,
          timezoneContextFingerprint: context.contextFingerprint,
          isWorkday: context.isWorkingDay, holidayKind: null,
        }
        await adapters.prepareLiveTimezoneContext(trx, input, 'exclusive')
        await adapters.assertLiveTimezoneTarget(trx, input)
        const result = await insert(client)
        await adapters.bindLiveTimezoneContext(trx, input, { calculationId: null })
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    },
  }
}
