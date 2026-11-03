import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { Pool } from 'pg'
import type { PoolClient } from 'pg'
import { acquireAttendanceTimezoneRuntimeLocksV1 } from '../../src/attendance/attendance-timezone-runtime-locks'
import {
  buildAttendanceW7MembershipTimelineLockKeyV1,
  buildAttendanceW7ScheduleFactsLockKeyV1,
} from '../../src/attendance/w7-resolver/w7-composite-lock-order'

if (!process.env.ATTENDANCE_TEST_DATABASE_URL) throw new Error('ATTENDANCE_TIMEZONE_LOCKS_REAL_DATABASE_REQUIRED')
const pool = new Pool({ connectionString: process.env.ATTENDANCE_TEST_DATABASE_URL, max: 4 })
const { attendanceTimezoneOrgLockKey, lockAttendanceTimezoneOrg } = createRequire(import.meta.url)(
  '../../../../plugins/plugin-attendance/lib/attendance-timezone-policy-store.cjs',
)

async function withClients(body: (writer: PoolClient, reader: PoolClient, probe: PoolClient) => Promise<void>) {
  const clients = await Promise.all([pool.connect(), pool.connect(), pool.connect()])
  try {
    for (const client of clients) {
      await client.query('BEGIN')
      await client.query("SET LOCAL lock_timeout='3s'")
    }
    await body(clients[0], clients[1], clients[2])
  } finally {
    for (const client of clients) {
      try { await client.query('ROLLBACK') } finally { client.release() }
    }
  }
}
async function waitForBlock(probe: PoolClient, readerPid: number, writerPid: number) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const actual = await probe.query('SELECT pg_blocking_pids($1) AS blockers', [readerPid])
    if (actual.rows[0].blockers.includes(writerPid)) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('ATTENDANCE_TIMEZONE_EXPECTED_ADVISORY_CONTENTION')
}

describe('attendance timezone prefix (real PostgreSQL conflicting production keyspaces)', () => {
  beforeAll(async () => {
    expect((await pool.query('SELECT 1::int AS ready')).rows).toEqual([{ ready: 1 }])
  })
  afterAll(async () => { await pool.end() })

  it('serializes the runtime shared policy prefix with the actual D1 exclusive writer', async () => {
    await withClients(async (writer, reader, probe) => {
      const orgId = randomUUID()
      const userId = randomUUID()
      await lockAttendanceTimezoneOrg((sql: string, values: unknown[]) => writer.query(sql, values), orgId)
      const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const readerPid = (await reader.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      let failure: unknown
      const pending = acquireAttendanceTimezoneRuntimeLocksV1(reader, { orgId, userId })
        .catch(error => { failure = error })
      await waitForBlock(probe, readerPid, writerPid)
      await writer.query('COMMIT')
      await pending
      expect(failure).toBeUndefined()
    })
  })

  it('already holds the policy prefix while waiting for a membership timeline writer', async () => {
    await withClients(async (writer, reader, probe) => {
      const orgId = randomUUID()
      const userId = randomUUID()
      await writer.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        buildAttendanceW7MembershipTimelineLockKeyV1(orgId, userId),
      ])
      const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const readerPid = (await reader.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      let failure: unknown
      const pending = acquireAttendanceTimezoneRuntimeLocksV1(reader, { orgId, userId })
        .catch(error => { failure = error })
      await waitForBlock(probe, readerPid, writerPid)
      expect((await probe.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired',
        [attendanceTimezoneOrgLockKey(orgId)])).rows).toEqual([{ acquired: false }])
      await writer.query('COMMIT')
      await pending
      expect(failure).toBeUndefined()
    })
  })

  it('already holds timeline before waiting for the original schedule writer keyspace', async () => {
    await withClients(async (writer, reader, probe) => {
      const orgId = randomUUID()
      const userId = randomUUID()
      await writer.query('SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))', [
        buildAttendanceW7ScheduleFactsLockKeyV1(orgId), userId,
      ])
      const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const readerPid = (await reader.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      let failure: unknown
      const pending = acquireAttendanceTimezoneRuntimeLocksV1(reader, { orgId, userId })
        .catch(error => { failure = error })
      await waitForBlock(probe, readerPid, writerPid)
      expect((await probe.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired',
        [buildAttendanceW7MembershipTimelineLockKeyV1(orgId, userId)])).rows).toEqual([{ acquired: false }])
      await writer.query('COMMIT')
      await pending
      expect(failure).toBeUndefined()
    })
  })

  it('exclusive configuration/approval prefix blocks a different employee in the same org', async () => {
    await withClients(async (writer, reader, probe) => {
      const orgId = randomUUID()
      await acquireAttendanceTimezoneRuntimeLocksV1(writer, { orgId, userId: randomUUID(), mode: 'exclusive' })
      const writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const readerPid = (await reader.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      let failure: unknown
      const pending = acquireAttendanceTimezoneRuntimeLocksV1(reader, { orgId, userId: randomUUID() })
        .catch(error => { failure = error })
      await waitForBlock(probe, readerPid, writerPid)
      await writer.query('COMMIT')
      await pending
      expect(failure).toBeUndefined()
    })
  })
})
