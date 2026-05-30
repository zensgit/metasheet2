import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceReportFieldCatalogForTests

describe('attendance import COPY stream safeguards', () => {
  it('unwraps nested transaction adapters to the real pg client before COPY', () => {
    const poolClient = {
      query() {},
    }
    const transactionClient = {
      query: async () => undefined,
      __rawClient: poolClient,
    }
    const pluginTransaction = {
      query: async () => undefined,
      __rawClient: transactionClient,
    }

    expect(helpers.resolveAttendanceImportRawClient(pluginTransaction)).toBe(poolClient)
  })

  it('uses the attendance heavy-query timeout for COPY FROM STDIN query objects', () => {
    const query = helpers.buildAttendanceImportCopyQuery(
      (sql: string) => ({
        text: sql,
        callback() {},
        submit() {},
      }),
      'COPY attendance_import_records_stage FROM STDIN',
    )

    expect(query.text).toBe('COPY attendance_import_records_stage FROM STDIN')
    expect(query.query_timeout).toBe(180000)
    expect(query.statement_timeout).toBe(180000)
  })

  it('attaches an immediate error sink for late pg-copy-streams errors', () => {
    const copyStream = new EventEmitter()
    const error = new Error('Query read timeout')

    const returned = helpers.attachAttendanceImportCopyStreamErrorSink(copyStream)

    expect(returned).toBe(copyStream)
    expect(copyStream.listenerCount('error')).toBeGreaterThan(0)
    expect(() => copyStream.emit('error', error)).not.toThrow()
    expect((copyStream as any).__attendanceImportCopyLastError).toBe(error)
  })
})
