import { vi } from 'vitest'
import { createRequire } from 'node:module'
import type { AttendanceLivePunchBoundaryInputV1, AttendanceW4LiveScheduledBoundaryV1 } from '../../src/attendance/w4c2-live-scheduled-boundary'

// Observe activation exactly as the existing record-timezone fixture does.
// Delegate to the unmodified public boundary with its actual timezone adapters.
export async function captureCorrectionTimezoneProducer() {
  const live = await import('../../src/attendance/w4c2-live-scheduled-boundary')
  const original = live.createAttendanceLiveScheduledBoundaryV1
  let boundary: AttendanceW4LiveScheduledBoundaryV1 | undefined
  let acquireConnection: Parameters<typeof original>[0]['acquireConnection'] | undefined
  const spy = vi.spyOn(live, 'createAttendanceLiveScheduledBoundaryV1').mockImplementation(config => {
    const created = original(config)
    if (config.legacyAdapters.prepareLiveTimezoneContext
      && config.legacyAdapters.assertLiveTimezoneTarget && config.legacyAdapters.bindLiveTimezoneContext) {
      boundary = created
      acquireConnection = config.acquireConnection
    }
    return created
  })
  return {
    restore: () => spy.mockRestore(),
    executeLivePunch: async (input: AttendanceLivePunchBoundaryInputV1) => {
      if (!boundary || !acquireConnection) throw new Error('CORRECTION_A_ACTIVATED_TIMEZONE_PRODUCER_REQUIRED')
      const plugin = createRequire(import.meta.url)('../../../../plugins/plugin-attendance/index.cjs') as {
        readTargetTimezoneContext(trx: unknown, target: { orgId: string; userId: string; workDate: string }): Promise<{
          timezone: string; contextFingerprint: string;
        }>
      }
      // Existing public outer target read, followed by the boundary's own fresh
      // prepare/assert/bind transaction. Never forge a fingerprint or backfill.
      const connection = await acquireConnection()
      const { client } = connection
      let fingerprint: string
      try {
        await client.query('BEGIN')
        const target = await plugin.readTargetTimezoneContext({ __rawClient: client,
          query: async (sql: string, values?: unknown[]) => (await client.query(sql, values)).rows,
        }, { orgId: input.orgId, userId: input.userId, workDate: input.workDate })
        if (target.timezone !== input.timezone) throw new Error('CORRECTION_A_TIMEZONE_FIXTURE_MISMATCH')
        fingerprint = target.contextFingerprint
        await client.query('COMMIT')
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { connection.release() }
      return boundary.executeLivePunch({ ...input, timezoneContextFingerprint: fingerprint, clientTimezone: input.timezone })
    },
  }
}

// Use a real current local day whose 09:00-18:00 shift has already elapsed.
// No fake Date.now, online-clock advance, policy toggle or future-guard exception.
export function correctionPastSameDayTiming() {
  const now = new Date()
  const offsetHours = ((20 - now.getUTCHours() + 12) % 24) - 12
  const timezone = offsetHours === 0 ? 'UTC' : `Etc/GMT${offsetHours > 0 ? '-' : '+'}${Math.abs(offsetHours)}`
  const workDate = new Date(now.getTime() + offsetHours * 3_600_000).toISOString().slice(0, 10)
  const instant = (time: string) => new Date(Date.parse(workDate + 'T' + time + ':00.000Z') - offsetHours * 3_600_000).toISOString()
  return { timezone, workDate, instant, startAt: instant('00:00'),
    endAt: new Date(Date.parse(instant('00:00')) + 86_400_000).toISOString() }
}
