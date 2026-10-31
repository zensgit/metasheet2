import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { CSV_FORMULA_INJECTION_LEAD_CHARS, CSV_LINE_TERMINATOR } from '../../src/services/csv-cell'
import {
  TASK_EXPORT_CSV_BOM,
  TASK_EXPORT_FORMATS,
  buildTaskExportCsv,
  formatTaskExportCell,
  parseTaskExportFormat,
  taskExportFileName,
} from '../../src/tasks/task-export'
import type { TaskFieldDefinition } from '../../src/tasks/task-fields'
import { projectTaskRow, taskProjectionColumns, type TaskProjectionTaskInput } from '../../src/tasks/task-projection'

const sha256 = (input: string) => createHash('sha256').update(input, 'utf8').digest('hex')
const NOTE: TaskFieldDefinition = { id: 'tfld_note', type: 'text', name: 'Note', config: {} }
const COST: TaskFieldDefinition = { id: 'tfld_cost', type: 'number', name: 'Cost', config: { decimals: 2, format: 'plain' } }

function row(id: string, title: string, overrides: Partial<Parameters<typeof projectTaskRow>[0]> = {}, taskOverrides: Partial<TaskProjectionTaskInput> = {}) {
  return projectTaskRow({
    listId: 'tlst_L1',
    task: {
      id,
      title,
      status: 'open',
      createdBy: 'u1',
      timeZone: 'Asia/Shanghai',
      startDate: null,
      startTime: null,
      dueDate: '2026-10-08',
      dueTime: null,
      completedAt: null,
      isMilestone: false,
      version: 1,
      ...taskOverrides,
    },
    assigneeIds: ['u1', 'u2'],
    dateColumnType: 'date',
    predecessorIdsInList: [],
    groupName: null,
    boundFields: [],
    fieldValues: [],
    sha256Hex: sha256,
    ...overrides,
  })
}

const exportOf = (rows: ReturnType<typeof row>[], extra: Partial<Parameters<typeof buildTaskExportCsv>[0]> = {}) =>
  buildTaskExportCsv({ listId: 'tlst_L1', dateColumnType: 'date', groupNames: [], boundFields: [], rows, ...extra })

/** Lines of the body without the BOM and without the final terminator. */
function lines(csv: string): string[] {
  expect(csv.startsWith(TASK_EXPORT_CSV_BOM)).toBe(true)
  expect(csv.endsWith(CSV_LINE_TERMINATOR)).toBe(true)
  return csv.slice(TASK_EXPORT_CSV_BOM.length, -CSV_LINE_TERMINATOR.length).split(CSV_LINE_TERMINATOR)
}

describe('task-export', () => {
  describe('format and file name (RULED(2026-10-09): [S10]; ASSUMPTION(task-e): [D11])', () => {
    it('csv only; absent means csv', () => {
      expect(TASK_EXPORT_FORMATS).toEqual(['csv'])
      expect(parseTaskExportFormat(undefined)).toEqual({ ok: true, format: 'csv' })
      expect(parseTaskExportFormat('csv')).toEqual({ ok: true, format: 'csv' })
      for (const raw of ['xlsx', 'CSV', '', null, 1]) {
        expect(parseTaskExportFormat(raw), String(raw)).toEqual({ ok: false, reason: 'unsupported_format' })
      }
    })
    it('task-list-<listId>.csv for a generated list id only', () => {
      expect(taskExportFileName('tlst_L1')).toBe('task-list-tlst_L1.csv')
      for (const listId of ['tlst_', 'tlst_a"b', 'tlst_a;b', '../x', 'tsk_1']) {
        expect(() => taskExportFileName(listId), listId).toThrow(TypeError)
      }
    })
    it('the body starts with a UTF-8 BOM (own choice)', () => {
      expect(TASK_EXPORT_CSV_BOM).toBe('\uFEFF')
    })
  })

  describe('formatTaskExportCell', () => {
    const columns = taskProjectionColumns({ listId: 'tlst_L1', dateColumnType: 'date', groupNames: [], boundFields: [] })
    const col = (key: string) => columns.find((c) => c.key === key)!
    it('empty for null and undefined', () => {
      expect(formatTaskExportCell(null, col('title'))).toBe('')
      expect(formatTaskExportCell(undefined, col('dueDate'))).toBe('')
    })
    it('person ids by display name (falling back to the id), joined with ", "', () => {
      expect(formatTaskExportCell(['u1', 'u9'], col('assignees'), { userLabels: new Map([['u1', '张三']]) })).toBe('张三, u9')
    })
    it('dependency record ids by task title', () => {
      expect(formatTaskExportCell(['rec_tsk_tlst_L1__tsk_A', 'rec_tsk_tlst_L1__tsk_Z'], col('dependencies'), { recordTitles: new Map([['rec_tsk_tlst_L1__tsk_A', 'Design']]) })).toBe(
        'Design, rec_tsk_tlst_L1__tsk_Z',
      )
    })
    it('scalars as text; the cell is NOT neutralized here (buildTaskExportCsv does that)', () => {
      expect(formatTaskExportCell(true, col('isMilestone'))).toBe('true')
      expect(formatTaskExportCell(7, col('taskVersion'))).toBe('7')
      expect(formatTaskExportCell('=x', col('title'))).toBe('=x')
    })
    it('rejects a malformed column', () => {
      expect(() => formatTaskExportCell('a', 'x' as never)).toThrow(TypeError)
    })
  })

  describe('buildTaskExportCsv', () => {
    it('BOM, header of column labels, one CRLF line per task, trailing CRLF', () => {
      const a = row('tsk_A', 'Design')
      const b = row('tsk_B', 'Build', { predecessorIdsInList: ['tsk_A'] }, { isMilestone: true, dueDate: null })
      const csv = exportOf([a, b], { userLabels: new Map([['u1', 'Ann'], ['u2', 'Bo']]) })
      expect(lines(csv)).toEqual([
        '标题,状态,负责人,创建人,开始时间,截止时间,完成时间 (UTC),里程碑,版本,前置任务,分组',
        'Design,open,"Ann, Bo",Ann,,2026-10-08,,false,1,,',
        'Build,open,"Ann, Bo",Ann,,,,true,1,Design,',
      ])
    })
    it('custom field columns follow the built-in ones', () => {
      const r = row('tsk_A', 'Design', { boundFields: [NOTE], fieldValues: [{ fieldId: 'tfld_note', value: 'remember, twice' }] })
      const out = lines(exportOf([r], { boundFields: [NOTE] }))
      expect(out[0].endsWith(',Note')).toBe(true)
      expect(out[1].endsWith(',"remember, twice"')).toBe(true)
    })
    it('dateTime columns: the header names UTC and the cell is the projected UTC instant (own choice)', () => {
      const r = row('tsk_A', 'Design', { dateColumnType: 'dateTime' }, { dueTime: '09:30', completedAt: new Date('2026-10-07T01:02:03.000Z') })
      const [header, line] = lines(exportOf([r], { dateColumnType: 'dateTime' }))
      expect(header).toBe('标题,状态,负责人,创建人,开始时间 (UTC),截止时间 (UTC),完成时间 (UTC),里程碑,版本,前置任务,分组')
      expect(line).toContain(',,2026-10-08T01:30:00.000Z,2026-10-07T01:02:03.000Z,false,')
    })
    describe('number columns: a codec number is written as a number (own choice)', () => {
      const cost = (value: unknown, field: TaskFieldDefinition = COST) => {
        const r = row('tsk_A', 'ok', { boundFields: [field], fieldValues: [{ fieldId: field.id, value }] })
        return lines(exportOf([r], { boundFields: [field] }))[1].split(',').pop()
      }
      it('negative, fractional and small numbers keep their sign and are not prefixed', () => {
        expect(cost(-5)).toBe('-5')
        expect(cost(-0.25)).toBe('-0.25')
        expect(cost(12.5)).toBe('12.5')
        expect(cost(-1e-7)).toBe('-1e-7')
      })
      it('anything else in a number column is neutralized like any other cell', () => {
        expect(cost('-5')).toBe("'-5")
        expect(cost(-1e15)).toBe("'-1000000000000000")
        expect(cost('=1+1')).toBe("'=1+1")
      })
      it('a number in a column that is not a number column is neutralized', () => {
        expect(cost(-5, NOTE)).toBe("'-5")
      })
    })
    describe('every other cell, the header included, goes through the shared CSV cell helper', () => {
      for (const lead of CSV_FORMULA_INJECTION_LEAD_CHARS) {
        it(`a title starting with ${JSON.stringify(lead)} is neutralized`, () => {
          const [, line] = lines(exportOf([row('tsk_A', `${lead}cmd`)]))
          expect(line.startsWith(`'${lead}cmd`) || line.startsWith(`"'${lead}cmd`), JSON.stringify(line)).toBe(true)
        })
      }
      it('a lead character behind leading blanks is neutralized too', () => {
        const [, line] = lines(exportOf([row('tsk_A', '  =cmd')]))
        expect(line.startsWith("'  =cmd")).toBe(true)
      })
      it('header cells: a custom field name with a lead character', () => {
        const field: TaskFieldDefinition = { ...NOTE, name: '=SUM(A1)' }
        const [header] = lines(exportOf([], { boundFields: [field] }))
        expect(header.endsWith(",'=SUM(A1)")).toBe(true)
      })
      it('custom text values, group names and display names are neutralized', () => {
        const r = row('tsk_A', 'ok', { boundFields: [NOTE], fieldValues: [{ fieldId: 'tfld_note', value: '+1' }], groupName: '-g' })
        const [, line] = lines(exportOf([r], { boundFields: [NOTE], groupNames: ['-g'], userLabels: new Map([['u1', '@ann']]) }))
        expect(line).toContain(",'+1")
        expect(line).toContain(",'-g,")
        expect(line).toContain(`"'@ann, u2",'@ann,`)
      })
    })
    it('rejects malformed rows and label maps', () => {
      expect(() => exportOf([{ recordId: 1, data: {} } as never])).toThrow(TypeError)
      expect(() => exportOf([], { userLabels: {} as never })).toThrow(TypeError)
      expect(() => buildTaskExportCsv('x' as never)).toThrow(TypeError)
    })
  })
})
