import { createRequire } from 'node:module'
import { Client } from 'pg'
import { acquireAttendanceTimezoneRuntimeLocksV1 } from '../../src/attendance/attendance-timezone-runtime-locks'

// IPC only: never print connection input, fixture values or SQL on child failure.
const requireModule = createRequire(import.meta.url)
const { createAttendanceTimezoneContextLoader } = requireModule('../../../../plugins/plugin-attendance/lib/attendance-timezone-context-loader.cjs')
const { createAttendanceTimezonePolicyStore } = requireModule('../../../../plugins/plugin-attendance/lib/attendance-timezone-policy-store.cjs')
const { readApprovedTrips } = requireModule('../../../../plugins/plugin-attendance/lib/attendance-business-trip.cjs')
const client = new Client({ connectionString: process.env.ATTENDANCE_TEST_DATABASE_URL })
const statements: string[] = []
const query = (sql: string, values?: unknown[]) => {
  statements.push(sql)
  return client.query(sql, values)
}
const noWrites = async () => { throw new Error('MT12_READ_ONLY_ADAPTER_WRITE_FORBIDDEN') }
// Exactly one production store/loader per persistent OS process.
const store = createAttendanceTimezonePolicyStore({ query, transaction: noWrites, authorizeManage: noWrites })
const load = createAttendanceTimezoneContextLoader({ query, policyStore: store, readApprovedTrips })
type Input = { orgId: string; userId: string; occurredAt: string; workDate: string }
let input: Input | undefined
let chain = Promise.resolve()
let closing = false
async function close() {
  if (closing) return
  closing = true
  await client.end()
}
process.on('disconnect', () => { void close() })
process.on('message', (message: { type: 'init' | 'read' | 'stop'; input?: Input }) => {
  chain = chain.then(async () => {
    if (message.type === 'init') {
      if (input || !message.input || !process.env.ATTENDANCE_TEST_DATABASE_URL) throw new Error('MT12_CHILD_INVALID_INIT')
      input = message.input
      await client.connect()
      const backend = await client.query('SELECT pg_backend_pid() AS pid')
      process.send?.({ type: 'ready', nodePid: process.pid, backendPid: backend.rows[0].pid, loaderInstances: 1 })
    } else if (message.type === 'read') {
      if (!input) throw new Error('MT12_CHILD_NOT_INITIALIZED')
      statements.length = 0
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      try {
        await acquireAttendanceTimezoneRuntimeLocksV1(client, input)
        const result = await load({ ...input, occurredAt: new Date(input.occurredAt) })
        await client.query('COMMIT')
        process.send?.({ type: 'result', nodePid: process.pid, context: {
          timezone: result.timezone, source: result.source, mode: result.mode, policyVersion: result.policyVersion,
          employeeReads: statements.filter(sql => sql.includes('FROM attendance_employee_timezone_overrides')).length,
        } })
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    } else if (message.type === 'stop') {
      await close()
      process.send?.({ type: 'stopped' }, () => process.disconnect())
    } else {
      throw new Error('MT12_CHILD_INVALID_COMMAND')
    }
  }).catch(async () => {
    await close().catch(() => undefined)
    process.send?.({ type: 'error', code: 'MT12_CHILD_FAILED' }, () => process.disconnect())
    process.exitCode = 1
  })
})
