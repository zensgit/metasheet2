import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

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

  it('preserves raw legacy references while refusing unknown opaque ids as W4 targets', async () => {
    const opaqueId = 'worker-1'
    const db = { query: vi.fn(async () => []) }
    expect(helpers.resolveRowUserId({ row: { userId: opaqueId } })).toBe(opaqueId)
    const index = await helpers.loadAttendanceImportUserIdentifierIndex(db, 'default', [opaqueId])
    expect(helpers.adoptCanonicalImportUserId(opaqueId, index)).toEqual({
      userId: null,
      warning: 'Unresolved user identifier; use a user id, or an email, username, or mobile that matches one user in this organization',
    })
    expect(db.query).toHaveBeenCalledTimes(1)
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
    expect(resolved.warning).not.toContain(email)
  })

  it.each(['username', 'mobile', 'both'])('keeps authorization filters when optional %s aliases are absent', async (missing) => {
    const userId = '22222222-2222-4222-8222-222222222222'
    const email = 'Fallback.User@Example.TEST'
    const db = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        expect(sql).toContain("to_jsonb(u)->>'username'")
        expect(sql).toContain("to_jsonb(u)->>'mobile'")
        expect(sql).not.toContain('u.username')
        expect(sql).not.toContain('u.mobile')
        expect(sql).toContain('uo.org_id = $1')
        expect(sql).toContain('uo.is_active = true')
        expect(sql).toContain('u.is_active = true')
        expect(params[0]).toBe('default')
        return [{ id: userId, email: email.toLowerCase(), username: missing === 'mobile' ? 'fallback-login' : null, mobile: missing === 'username' ? '13800000000' : null }]
      }),
    }
    const index = await helpers.loadAttendanceImportUserIdentifierIndex(db, 'default', [email, 'fallback-login', '13800000000'])
    expect(helpers.adoptCanonicalImportUserId(email, index)).toEqual({ userId, warning: null })
    expect(helpers.adoptCanonicalImportUserId('fallback-login', index).userId).toBe(missing === 'mobile' ? userId : null)
    expect(helpers.adoptCanonicalImportUserId('13800000000', index).userId).toBe(missing === 'username' ? userId : null)
    expect(db.query).toHaveBeenCalledTimes(1)
  })

  it.each(['u.is_active', 'uo.is_active', 'user_orgs'])('fails closed when required %s schema is absent', async (column) => {
    const code = column === 'user_orgs' ? '42P01' : '42703'
    const db = { query: vi.fn(async () => { throw Object.assign(new Error(`private database detail: ${column}`), { code }) }) }
    await expect(helpers.loadAttendanceImportUserIdentifierIndex(db, 'default', ['worker@example.test']))
      .rejects.toMatchObject({ code, message: 'ATTENDANCE_IMPORT_IDENTITY_SCHEMA_NOT_READY' })
    expect(db.query).toHaveBeenCalledTimes(1)
  })

  it('keeps the canonical UUID fast path without an alias lookup', async () => {
    const userId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
    const db = { query: vi.fn() }
    const index = await helpers.loadAttendanceImportUserIdentifierIndex(db, 'default', [userId])
    expect(helpers.adoptCanonicalImportUserId(userId, index)).toEqual({ userId: userId.toLowerCase(), warning: null })
    expect(db.query).not.toHaveBeenCalled()
  })

  it('uses fixed lookup errors without retaining database details', async () => {
    const db = { query: async () => { throw Object.assign(new Error('private SQL and endpoint'), { code: '08006', detail: 'private detail' }) } }
    await expect(helpers.loadAttendanceImportUserIdentifierIndex(db, 'default', ['worker@example.test']))
      .rejects.toMatchObject({ message: 'ATTENDANCE_IMPORT_IDENTITY_LOOKUP_FAILED' })
  })

  it.each(['ｓｈａｒｅｄ＠ｅｘａｍｐｌｅ．ｔｅｓｔ', 'shared@example.test\t\r\n', 'Δ@example.test'])('rejects a normalized historical cross-field owner collision (%s)', async (username) => {
    const identifier = username.startsWith('Δ') ? 'δ@example.test' : 'shared@example.test'
    const db = { query: async (sql: string, params: unknown[]) => {
      expect(sql).toContain('octet_length(')
      expect(sql).toContain('COLLATE "C"')
      expect(params[4]).toEqual(expect.stringContaining('\t'))
      expect(params[4]).toEqual(expect.stringContaining('\r'))
      expect(params[4]).toEqual(expect.stringContaining('\n'))
      return [
        { id: '11111111-1111-4111-8111-111111111111', email: identifier, username: null, mobile: null },
        { id: '22222222-2222-4222-8222-222222222222', email: null, username, mobile: null },
      ]
    } }
    const index = await helpers.loadAttendanceImportUserIdentifierIndex(db, 'default', [identifier])
    expect(index.get(helpers.importUserIdentifierLookupKey(identifier))).toEqual({ ambiguous: true })
  })

  it('collects distinct owners across email, username, and mobile before resolving', async () => {
    const first = '11111111-1111-4111-8111-111111111111'
    const second = '22222222-2222-4222-8222-222222222222'
    for (const [email, username, mobile] of [
      ['shared@example.test', 'shared@example.test', null],
      ['13800000000', null, '+86 138-0000-0000'],
      ['13800000000', null, '１３８００００００００'],
      [null, '13800000000', '13800000000'],
    ]) {
      const identifier = email ?? username
      const db = { query: async () => [
        { id: first, email, username: email ? null : username, mobile: null },
        { id: second, email: null, username: email ? username : null, mobile },
      ] }
      const index = await helpers.loadAttendanceImportUserIdentifierIndex(db, 'default', [identifier])
      expect(index.get(helpers.importUserIdentifierLookupKey(identifier))).toEqual({ ambiguous: true })
      expect(helpers.adoptCanonicalImportUserId(identifier, index).userId).toBeNull()
    }
    const db = { query: async () => [
      { id: first, email: '13800000000', username: '13800000000', mobile: '+86 (138) 0000-0000' },
      { id: first, email: '13800000000', username: null, mobile: '13800000000' },
    ] }
    const index = await helpers.loadAttendanceImportUserIdentifierIndex(db, 'default', ['13800000000'])
    expect(helpers.adoptCanonicalImportUserId('13800000000', index)).toEqual({ userId: first, warning: null })
  })

  it('builds field indexes once as the number of unique employees doubles', async () => {
    async function accessesFor(size: number) {
      let accesses = 0
      const identifiers = Array.from({ length: size }, (_, i) => `worker-${i}@example.test`)
      const users = identifiers.map((email, i) => {
        const values = { id: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000001`, email, username: `worker-${i}`, mobile: null }
        return new Proxy(values, { get(target, key) { accesses += 1; return target[key as keyof typeof target] } })
      })
      const index = await helpers.loadAttendanceImportUserIdentifierIndex({ query: async () => users }, 'default', identifiers)
      expect(index.size).toBe(size)
      return accesses
    }
    const small = await accessesFor(100)
    const large = await accessesFor(200)
    expect(small).toBeGreaterThan(0)
    expect(large).toBeLessThanOrEqual(small * 2.1)
    expect(large).toBeLessThanOrEqual(200 * 5)
  })

  it('bounds collision-owner iteration as distinct formatted identifiers double', async () => {
    async function iterationsFor(size: number) {
      let iterations = 0
      const original = Set.prototype[Symbol.iterator]
      const iteratorSpy = vi.spyOn(Set.prototype, Symbol.iterator).mockImplementation(function () {
        const iterator = original.call(this)
        return {
          next() { iterations += 1; return iterator.next() },
          [Symbol.iterator]() { return this },
        }
      })
      let index: Map<string, unknown>
      try {
        const identifiers = Array.from({ length: size }, (_, i) => '13800000000'.split('').map((digit, position) => `${digit}${((i + 1) >> position) & 1 ? '-' : ''}`).join(''))
        const users = identifiers.map((_, i) => ({ id: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000001`, email: null, username: null, mobile: '13800000000' }))
        index = await helpers.loadAttendanceImportUserIdentifierIndex({ query: async () => users }, 'default', identifiers)
      } finally {
        iteratorSpy.mockRestore()
      }
      expect(index!.size).toBe(size)
      for (const entry of index!.values()) expect(entry).toEqual({ ambiguous: true })
      return iterations
    }
    const small = await iterationsFor(100)
    const large = await iterationsFor(200)
    expect(large).toBeLessThanOrEqual(small * 2.1)
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
