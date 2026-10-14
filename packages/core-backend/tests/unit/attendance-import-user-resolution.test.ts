import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceImportForTests

describe('attendance import row user resolution', () => {
  it('maps template employee numbers through userMap before falling back', () => {
    const row = {
      fields: {
        '工号': 'A001',
        '姓名': 'Alice',
      },
    }

    expect(helpers.resolveRowUserId({
      row,
      fallbackUserId: 'requester-admin',
      userMap: {
        A001: 'employee-a001',
      },
      userMapKeyField: '工号',
      userMapSourceFields: ['工号', '姓名'],
    })).toBe('employee-a001')
  })

  it('does not silently fall back to requester when a row has an unmapped user identifier', () => {
    const row = {
      fields: {
        '工号': 'A001',
        '姓名': 'Alice',
      },
    }

    expect(helpers.resolveRowUserId({
      row,
      fallbackUserId: 'requester-admin',
      userMap: {},
      userMapKeyField: '工号',
      userMapSourceFields: ['工号', '姓名'],
    })).toBeNull()

    expect(helpers.buildUnresolvedRowUserWarning({
      row,
      userMapKeyField: '工号',
      userMapSourceFields: ['工号', '姓名'],
    })).toContain('工号')
  })

  it('keeps single-user fallback when no row-level user identity is present', () => {
    const row = {
      fields: {
        status: '正常',
      },
    }

    expect(helpers.resolveRowUserId({
      row,
      fallbackUserId: 'requester-admin',
      userMap: {},
      userMapKeyField: '工号',
      userMapSourceFields: ['工号', '姓名'],
    })).toBe('requester-admin')
  })

  it('resolves an email UserId to the org member uuid for preview and commit', async () => {
    const userId = '11111111-1111-4111-8111-111111111111'
    const email = 'qa-pr5869-admin@metasheet.test'
    const db = {
      async query() {
        return [{ id: userId, email, username: 'qa-admin', mobile: null }]
      },
    }
    const row = {
      userId: email,
      workDate: '2026-03-23',
      fields: {
        UserId: email,
        '日期': '2026-03-23',
        ClockIn: '2026-03-23 09:00',
        ClockOut: '2026-03-23 18:00',
      },
    }
    const index = await helpers.loadAttendanceImportUserIdentifierIndex(db, 'default', [email])
    const resolved = helpers.adoptCanonicalImportUserId(email, index)

    expect(resolved).toEqual({ userId, warning: null })
    expect(helpers.isCanonicalImportUserId(resolved.userId)).toBe(true)
    expect(helpers.isCanonicalImportUserId(email)).toBe(false)

    const mapped = helpers.applyFieldMappings(row.fields, helpers.IMPORT_MAPPING_COLUMNS)
    expect(mapped.firstInAt?.value).toBe('2026-03-23 09:00')
    expect(mapped.lastOutAt?.value).toBe('2026-03-23 18:00')
    expect(mapped.userId?.value).toBe(email)
    expect(helpers.resolveRequiredFieldValue({ fields: row.fields }, '日期')).toBe('2026-03-23')
    expect(helpers.resolveRequiredFieldValue({ fields: row.fields }, '上班1打卡时间')).toBe('2026-03-23 09:00')
    expect(helpers.resolveRequiredFieldValue({ fields: row.fields }, '下班1打卡时间')).toBe('2026-03-23 18:00')
  })

  it('leaves opaque legacy user ids untouched and does not query the directory', async () => {
    let queries = 0
    const db = {
      async query() {
        queries += 1
        return []
      },
    }
    const index = await helpers.loadAttendanceImportUserIdentifierIndex(db, 'default', ['worker-1'])
    expect(queries).toBe(0)
    expect(helpers.adoptCanonicalImportUserId('worker-1', index)).toEqual({ userId: 'worker-1', warning: null })
  })

  it('flags an unknown email instead of treating it as a resolved user id', async () => {
    const email = 'nobody@metasheet.test'
    const db = {
      async query() {
        return []
      },
    }
    const index = await helpers.loadAttendanceImportUserIdentifierIndex(db, 'default', [email])
    const resolved = helpers.adoptCanonicalImportUserId(email, index)
    expect(resolved.userId).toBeNull()
    expect(resolved.warning).toContain('Unresolved user identifier')
    expect(resolved.warning).toContain(email)
  })

  it('falls back to email lookup when username or mobile columns are absent', async () => {
    const userId = '22222222-2222-4222-8222-222222222222'
    const email = 'Fallback.User@Example.TEST'
    let calls = 0
    const db = {
      async query(sql) {
        calls += 1
        if (calls === 1) {
        const error = new Error('column u.username does not exist') as Error & { code?: string }
        error.code = '42703'
        throw error
        }
        expect(String(sql)).toContain('lower(COALESCE(u.email')
        return [{ id: userId, email: email.toLowerCase(), username: null, mobile: null }]
      },
    }
    const index = await helpers.loadAttendanceImportUserIdentifierIndex(db, 'default', [email])
    expect(helpers.adoptCanonicalImportUserId(email, index)).toEqual({ userId, warning: null })
    expect(calls).toBe(2)
  })

  it('ships a default CSV template whose headers the importer auto-maps', () => {
    const profile = helpers.getDefaultImportTemplateProfile()
    const csv = helpers.buildImportTemplateCsv(profile)
    const [header, sample] = csv.trim().split('\n')
    expect(header.startsWith('UserId,日期,')).toBe(true)
    expect(header).toContain('上班1打卡时间')
    expect(header).toContain('下班1打卡时间')
    expect(sample).toContain('user@example.com')
    const columns = header.split(',')
    for (const column of ['UserId', '日期', '上班1打卡时间', '下班1打卡时间']) {
      expect(columns).toContain(column)
    }
    const clockIn = helpers.IMPORT_MAPPING_COLUMNS.find((column) => column.sourceField === 'ClockIn')
    const clockOut = helpers.IMPORT_MAPPING_COLUMNS.find((column) => column.sourceField === 'ClockOut')
    const date = helpers.IMPORT_MAPPING_COLUMNS.find((column) => column.sourceField === 'Date')
    expect(clockIn?.targetField).toBe('firstInAt')
    expect(clockOut?.targetField).toBe('lastOutAt')
    expect(date?.targetField).toBe('workDate')
  })

  it('honors direct userId columns without requiring userMap', () => {
    const row = {
      fields: {
        userId: 'employee-direct',
        '工号': 'A001',
      },
    }

    expect(helpers.resolveRowUserId({
      row,
      fallbackUserId: 'requester-admin',
      userMap: {},
      userMapKeyField: '工号',
      userMapSourceFields: ['工号', '姓名'],
    })).toBe('employee-direct')
  })
})
