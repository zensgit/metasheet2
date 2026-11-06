import path from 'node:path'
import { MetaSheetServer } from '../../src/index'

type QueueData = { jobId: string }
type Callback = (job: { data: QueueData }) => Promise<void>
type Message = { action: 'start' | 'attempt' | 'stop'; jobId?: string }
const send = (value: object) => process.send?.(value)
let server: MetaSheetServer | undefined
let processor: Callback | undefined
let target = ''
let started = false
let offered: { queue: string; name: string; data: QueueData; options: unknown } | undefined
let announced = false
let startupJobsDrained = false
const announce = () => {
  if (started && startupJobsDrained && processor && !announced) {
    announced = true
    send({ kind: 'ready', pid: process.pid, offered, startupJobsDrained })
  }
}
process.on('message', async (message: Message) => {
  try {
    if (message.action === 'start') {
      target = message.jobId ?? ''
      if (!/^[0-9a-f-]{36}$/.test(target)) throw new Error('PUNCH_QUEUE_TARGET_REQUIRED')
      server = new MetaSheetServer({ port: 0, host: '127.0.0.1',
        pluginDirs: [path.resolve(process.cwd(), '../../plugins/plugin-attendance')] })
      const runtime = server as unknown as {
        createPluginContext(input: unknown): { services: Record<string, unknown>;
          api: { database: { query(sql: string, params?: unknown[]): Promise<unknown> } } }
      }
      const original = runtime.createPluginContext.bind(runtime)
      runtime.createPluginContext = input => {
        const context = original(input)
        const database = context.api.database
        const query = database.query.bind(database)
        database.query = async (sql, params) => {
          const result = await query(sql, params)
          // This real query follows the awaited job-enqueue loop in startup recovery.
          // Observe completion only; never alter the query, parameters or result.
          if (sql.includes('SELECT cleanup.job_id, cleanup.created_at')
            && sql.includes('FROM attendance_import_upload_cleanup_commands AS cleanup')) {
            startupJobsDrained = true
            announce()
          }
          return result
        }
        context.services.queue = {
          process(queue: string, name: string, callback: Callback) {
            if (queue !== 'attendance-import' || name !== 'attendance-import-commit-async') {
              throw new Error('PUNCH_QUEUE_PROCESSOR_BINDING')
            }
            processor = callback
            announce()
          },
          async add(queue: string, name: string, data: QueueData, options: unknown) {
            // Hold all startup offers. Only the named owned job is explicitly delivered.
            if (data.jobId === target) {
              offered = { queue, name, data, options }
              announce()
            }
          },
        }
        return context
      }
      await server.start()
      started = true
      announce()
    } else if (message.action === 'attempt') {
      if (!announced || !processor || !offered) throw new Error('PUNCH_QUEUE_NOT_STARTUP_OFFERED')
      try {
        await processor({ data: offered.data })
        send({ kind: 'attempt', outcome: 'returned' })
      } catch (error) {
        const code = error instanceof Error ? error.message : 'UNKNOWN'
        send({ kind: 'attempt', outcome: 'rejected',
          code: /^[A-Z0-9_]+$/.test(code) ? code : 'NON_CODE_ERROR' })
      }
    } else if (message.action === 'stop') {
      await server?.stop()
      process.exit(0)
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : 'UNKNOWN'
    send({ kind: 'error', code: /^[A-Z0-9_]+$/.test(code) ? code : 'PUNCH_QUEUE_CHILD_START_FAILED' })
  }
})

send({ kind: 'boot' })
