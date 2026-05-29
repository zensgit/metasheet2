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
