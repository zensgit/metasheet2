import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { TaskFieldDefinition } from '../../src/tasks/task-fields'
import { parseTaskProjectionRecordId } from '../../src/tasks/task-ids'
import {
  TASK_PROJECTION_BUILTIN_KEYS,
  TASK_PROJECTION_DENIED_CAPABILITY_KEYS,
  TASK_PROJECTION_SYSTEM_KIND,
  TASK_PROJECTION_SYSTEM_OWNER,
  TASK_PROJECTION_VIEW_KINDS,
  TASK_PROJECTION_VIEW_MARKER,
  buildTaskProjectionViewSpecs,
  deriveTaskProjectionBaseId,
  deriveTaskProjectionFieldId,
  deriveTaskProjectionRecordId,
  deriveTaskProjectionSheetId,
  isTaskProjectionBaseIdCandidate,
  isTaskProjectionRowReadable,
  isTaskProjectionSheetIdCandidate,
  projectTaskRow,
  resolveTaskProjectionDateColumnType,
  restrictTaskProjectionCapabilities,
  taskProjectionColumns,
  taskProjectionInteractionCanEdit,
  taskProjectionNoopDigest,
  type TaskProjectionTaskInput,
} from '../../src/tasks/task-projection'

const sha256 = (input: string) => createHash('sha256').update(input, 'utf8').digest('hex')
const SHEET = 'sht_tsk_proj_tlst_L1'
const f = (key: string) => `${SHEET}__${key}`

const PRIORITY: TaskFieldDefinition = {
  id: 'tfld_prio',
  type: 'select',
  name: '优先级',
  config: { options: [{ id: 'opt_h', label: 'High', color: '#ff0000' }, { id: 'opt_l', label: 'Low' }] },
}
const TAGS: TaskFieldDefinition = { id: 'tfld_tags', type: 'multiSelect', name: 'Tags', config: { options: [{ id: 'opt_a', label: 'A' }, { id: 'opt_b', label: 'B' }] } }
const OWNERS: TaskFieldDefinition = { id: 'tfld_owners', type: 'member', name: 'Owners', config: { single: true } }
const COST: TaskFieldDefinition = { id: 'tfld_cost', type: 'number', name: 'Cost', config: { decimals: 2, format: 'percent' } }
const NOTE: TaskFieldDefinition = { id: 'tfld_note', type: 'text', name: 'Note', config: {} }
const ON: TaskFieldDefinition = { id: 'tfld_on', type: 'date', name: 'On', config: {} }

function task(overrides: Partial<TaskProjectionTaskInput> = {}): TaskProjectionTaskInput {
  return {
    id: 'tsk_T1',
    title: 'Ship it',
    status: 'open',
    createdBy: 'creator',
    timeZone: 'Asia/Shanghai',
    startDate: '2026-10-06',
    startTime: null,
    dueDate: '2026-10-08',
    dueTime: null,
    completedAt: null,
    isMilestone: false,
    version: 3,
    ...overrides,
  }
}

const project = (overrides: Partial<Parameters<typeof projectTaskRow>[0]> = {}) =>
  projectTaskRow({
    listId: 'tlst_L1',
    task: task(),
    assigneeIds: ['u2', 'u1', 'u2'],
    dateColumnType: 'date',
    predecessorIdsInList: ['tsk_P2', 'tsk_P1'],
    groupName: 'Backlog',
    boundFields: [],
    fieldValues: [],
    sha256Hex: sha256,
    ...overrides,
  })

describe('task-projection', () => {
  it('kind and system owner (RULED(2026-10-09): [S03])', () => {
    expect(TASK_PROJECTION_SYSTEM_KIND).toBe('task_projection')
    expect(TASK_PROJECTION_SYSTEM_OWNER).toBe('system:task-projection')
  })

  describe('deriveTaskProjectionBaseId (RULED(2026-10-09): [S03])', () => {
    it('base_tsk_proj_ + the first 32 hex of sha256(orgId), a valid candidate', () => {
      const id = deriveTaskProjectionBaseId('org1', sha256)
      expect(id).toBe(`base_tsk_proj_${sha256('org1').slice(0, 32)}`)
      expect(isTaskProjectionBaseIdCandidate(id)).toBe(true)
    })
    it('one base per org: stable for an org, different across orgs', () => {
      expect(deriveTaskProjectionBaseId('org1', sha256)).toBe(deriveTaskProjectionBaseId('org1', sha256))
      expect(deriveTaskProjectionBaseId('org1', sha256)).not.toBe(deriveTaskProjectionBaseId('org2', sha256))
    })
    it('the org id must be a printable id and is not trimmed', () => {
      expect(() => deriveTaskProjectionBaseId('', sha256)).toThrow(TypeError)
      expect(() => deriveTaskProjectionBaseId(' org1', sha256)).toThrow(TypeError)
      expect(() => deriveTaskProjectionBaseId('org 1', sha256)).toThrow(TypeError)
    })
    it('the supplied hash must be a function returning 64 lower-case hex characters', () => {
      expect(() => deriveTaskProjectionBaseId('org1', 'x' as never)).toThrow(TypeError)
      expect(() => deriveTaskProjectionBaseId('org1', (s) => sha256(s).toUpperCase())).toThrow(TypeError)
      expect(() => deriveTaskProjectionBaseId('org1', (s) => sha256(s).slice(0, 32))).toThrow(TypeError)
      expect(() => deriveTaskProjectionBaseId('org1', (s) => `${sha256(s)}\n`)).toThrow(TypeError)
    })
  })

  describe('deriveTaskProjectionSheetId (RULED(2026-10-09): [S03])', () => {
    it('sht_tsk_proj_<listId>', () => {
      expect(deriveTaskProjectionSheetId('tlst_L1')).toBe(SHEET)
    })
    it('every derived sheet id matches the sheet candidate pattern', () => {
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
      let seed = 7
      for (let i = 0; i < 200; i += 1) {
        let suffix = ''
        const length = 1 + (i % 24)
        for (let j = 0; j < length; j += 1) {
          seed = (seed * 1103515245 + 12345) % 2147483648
          suffix += alphabet[seed % alphabet.length]
        }
        expect(isTaskProjectionSheetIdCandidate(deriveTaskProjectionSheetId(`tlst_${suffix}`))).toBe(true)
      }
    })
    it('only a generated list id is accepted', () => {
      for (const listId of ['tsk_abc', 'tlst_', 'tlst_a_b', 'tlst__a', '_tlst_a', 'tlst_a-b', 'TLST_a', '']) {
        expect(() => deriveTaskProjectionSheetId(listId), listId).toThrow(TypeError)
      }
    })
  })

  describe('deriveTaskProjectionRecordId pairs with parseTaskProjectionRecordId', () => {
    const pairs: Array<[string, string]> = [
      ['tlst_L1', 'tsk_T1'],
      ['tlst_a_b', 'tsk_c_d'],
      ['x', 'y'],
      ['tlst_9', 'tsk_Z'],
    ]
    it('parse(derive(l, t)) = { l, t }', () => {
      for (const [listId, taskId] of pairs) {
        expect(parseTaskProjectionRecordId(deriveTaskProjectionRecordId(listId, taskId))).toEqual({ listId, taskId })
      }
    })
    it('derive(parse(r)) = r for every id the parser accepts, and derive refuses the halves of every id it rejects', () => {
      const ids = [
        'rec_tsk_tlst_L1__tsk_T1',
        'rec_tsk_tlst_a_b__tsk_c',
        'rec_tsk_tlst_a__b__tsk_1',
        'rec_tsk__tlst_a__tsk_1',
        'rec_tsk_tlst_a___tsk_1',
        'rec_tsk_tlst_a__tsk_1_',
        'rec_tsk_tlst_a',
      ]
      for (const id of ids) {
        const parsed = parseTaskProjectionRecordId(id)
        if (parsed !== null) {
          expect(deriveTaskProjectionRecordId(parsed.listId, parsed.taskId), id).toBe(id)
        } else {
          const rest = id.slice('rec_tsk_'.length)
          const at = rest.indexOf('__')
          const halves = at === -1 ? [rest, ''] : [rest.slice(0, at), rest.slice(at + 2)]
          expect(() => deriveTaskProjectionRecordId(halves[0], halves[1]), id).toThrow(TypeError)
        }
      }
    })
    it('refuses halves that are not valid task-domain ids', () => {
      for (const [listId, taskId] of [['tlst_a__b', 'tsk_1'], ['_x', 'tsk_1'], ['tlst_1', 'tsk_1_'], ['', 'tsk_1'], ['tlst 1', 'tsk_1']]) {
        expect(() => deriveTaskProjectionRecordId(listId, taskId), `${listId}/${taskId}`).toThrow(TypeError)
      }
    })
  })

  describe('candidate patterns (RULED(2026-10-09): [S03])', () => {
    const hex32 = 'a'.repeat(16) + '0123456789abcdef'
    it('base: exactly 32 lower-case hex characters', () => {
      expect(isTaskProjectionBaseIdCandidate(`base_tsk_proj_${hex32}`)).toBe(true)
      expect(isTaskProjectionBaseIdCandidate(`base_tsk_proj_${hex32.toUpperCase()}`)).toBe(false)
      expect(isTaskProjectionBaseIdCandidate(`base_tsk_proj_${hex32.slice(1)}`)).toBe(false)
      expect(isTaskProjectionBaseIdCandidate(`base_tsk_proj_${hex32}0`)).toBe(false)
      expect(isTaskProjectionBaseIdCandidate(`base_tsk_proj_${hex32}\n`)).toBe(false)
      expect(isTaskProjectionBaseIdCandidate(` base_tsk_proj_${hex32}`)).toBe(false)
      expect(isTaskProjectionBaseIdCandidate('base_tsk_projection')).toBe(false)
      expect(isTaskProjectionBaseIdCandidate(42)).toBe(false)
    })
    it('sheet: sht_tsk_proj_tlst_ + alphanumerics', () => {
      expect(isTaskProjectionSheetIdCandidate('sht_tsk_proj_tlst_abc')).toBe(true)
      expect(isTaskProjectionSheetIdCandidate('sht_tsk_proj_tlst_')).toBe(false)
      expect(isTaskProjectionSheetIdCandidate('sht_tsk_proj_tsk_abc')).toBe(false)
      expect(isTaskProjectionSheetIdCandidate('sht_tsk_proj_tlst_a_b')).toBe(false)
      expect(isTaskProjectionSheetIdCandidate('sht_tsk_proj_tlst_abc\n')).toBe(false)
      expect(isTaskProjectionSheetIdCandidate('sht_tsk_proj_tlst_abc__title')).toBe(false)
      expect(isTaskProjectionSheetIdCandidate('x_sht_tsk_proj_tlst_abc')).toBe(false)
      expect(isTaskProjectionSheetIdCandidate(' sht_tsk_proj_tlst_abc')).toBe(false)
      expect(isTaskProjectionSheetIdCandidate(null)).toBe(false)
    })
  })

  describe('deriveTaskProjectionFieldId', () => {
    it('<sheetId>__<key> for built-in keys and custom field ids', () => {
      expect(deriveTaskProjectionFieldId(SHEET, 'title')).toBe(f('title'))
      expect(deriveTaskProjectionFieldId(SHEET, 'tfld_x1')).toBe(f('tfld_x1'))
    })
    it('refuses other keys and other sheets', () => {
      for (const key of ['unknown', 'tfld_', 'tfld_a_b', 'Title', '']) {
        expect(() => deriveTaskProjectionFieldId(SHEET, key), key).toThrow(TypeError)
      }
      expect(() => deriveTaskProjectionFieldId('sht_other', 'title')).toThrow(TypeError)
    })
  })

  describe('columns and views (RULED(2026-10-09): [S05]; ASSUMPTION(task-e): [D7])', () => {
    it('date column type: date unless some task has a time of day', () => {
      expect(resolveTaskProjectionDateColumnType([])).toBe('date')
      expect(resolveTaskProjectionDateColumnType([{ dueTime: null, startTime: null }])).toBe('date')
      expect(resolveTaskProjectionDateColumnType([{ dueTime: null, startTime: null }, { dueTime: '09:00', startTime: null }])).toBe('dateTime')
      expect(resolveTaskProjectionDateColumnType([{ dueTime: null, startTime: '08:00' }])).toBe('dateTime')
    })
    it('the built-in catalog, in order', () => {
      const columns = taskProjectionColumns({ listId: 'tlst_L1', dateColumnType: 'date', groupNames: ['Backlog', 'Doing', 'Backlog'], boundFields: [] })
      expect(columns.map((c) => c.key)).toEqual([...TASK_PROJECTION_BUILTIN_KEYS])
      expect(columns).toEqual([
        { key: 'title', fieldId: f('title'), label: '标题', type: 'string', property: {}, readOnly: false },
        { key: 'status', fieldId: f('status'), label: '状态', type: 'select', property: { options: [{ value: 'open' }, { value: 'done' }] }, readOnly: false },
        { key: 'assignees', fieldId: f('assignees'), label: '负责人', type: 'person', property: { limitSingleRecord: false }, readOnly: false },
        { key: 'creator', fieldId: f('creator'), label: '创建人', type: 'person', property: { limitSingleRecord: true }, readOnly: false },
        { key: 'startDate', fieldId: f('startDate'), label: '开始时间', type: 'date', property: {}, readOnly: false },
        { key: 'dueDate', fieldId: f('dueDate'), label: '截止时间', type: 'date', property: {}, readOnly: false },
        { key: 'completedAt', fieldId: f('completedAt'), label: '完成时间', type: 'dateTime', property: {}, readOnly: false },
        { key: 'isMilestone', fieldId: f('isMilestone'), label: '里程碑', type: 'boolean', property: {}, readOnly: false },
        { key: 'taskVersion', fieldId: f('taskVersion'), label: '版本', type: 'number', property: { decimals: 0 }, readOnly: true },
        { key: 'dependencies', fieldId: f('dependencies'), label: '前置任务', type: 'link', property: { foreignSheetId: SHEET }, readOnly: false },
        { key: 'listGroup', fieldId: f('listGroup'), label: '分组', type: 'select', property: { options: [{ value: 'Backlog' }, { value: 'Doing' }] }, readOnly: false },
      ])
    })
    it('dateTime applies to start and due only', () => {
      const columns = taskProjectionColumns({ listId: 'tlst_L1', dateColumnType: 'dateTime', groupNames: [], boundFields: [] })
      expect(columns.filter((c) => c.type === 'dateTime').map((c) => c.key)).toEqual(['startDate', 'dueDate', 'completedAt'])
    })
    it('custom fields follow, mapped onto multitable types (RULED(2026-10-09): [S25])', () => {
      const columns = taskProjectionColumns({ listId: 'tlst_L1', dateColumnType: 'date', groupNames: [], boundFields: [PRIORITY, TAGS, OWNERS, COST, NOTE, ON] })
      expect(columns.slice(TASK_PROJECTION_BUILTIN_KEYS.length)).toEqual([
        { key: 'tfld_prio', fieldId: f('tfld_prio'), label: '优先级', type: 'select', property: { options: [{ value: 'High', color: '#ff0000' }, { value: 'Low' }] }, readOnly: false },
        { key: 'tfld_tags', fieldId: f('tfld_tags'), label: 'Tags', type: 'multiSelect', property: { options: [{ value: 'A' }, { value: 'B' }] }, readOnly: false },
        { key: 'tfld_owners', fieldId: f('tfld_owners'), label: 'Owners', type: 'person', property: { limitSingleRecord: true }, readOnly: false },
        { key: 'tfld_cost', fieldId: f('tfld_cost'), label: 'Cost', type: 'number', property: { decimals: 2 }, readOnly: false },
        { key: 'tfld_note', fieldId: f('tfld_note'), label: 'Note', type: 'string', property: {}, readOnly: false },
        { key: 'tfld_on', fieldId: f('tfld_on'), label: 'On', type: 'date', property: {}, readOnly: false },
      ])
    })
    it('rejects malformed input', () => {
      expect(() => taskProjectionColumns({ listId: 'tlst_L1', dateColumnType: 'time' as never, groupNames: [], boundFields: [] })).toThrow(TypeError)
      expect(() => taskProjectionColumns({ listId: 'tlst_L1', dateColumnType: 'date', groupNames: [], boundFields: [{ ...NOTE, id: 'fld_1' }] })).toThrow(TypeError)
    })
    it('view specs: grid, kanban by status, gantt start → due with dependencies, each carrying the marker', () => {
      expect(TASK_PROJECTION_VIEW_MARKER).toBe('taskProjectionView')
      expect(TASK_PROJECTION_VIEW_KINDS).toEqual(['grid', 'kanban', 'gantt'])
      expect(buildTaskProjectionViewSpecs('tlst_L1')).toEqual([
        { kind: 'grid', type: 'grid', name: '表格', config: { taskProjectionView: 'grid' } },
        { kind: 'kanban', type: 'kanban', name: '看板', config: { taskProjectionView: 'kanban', groupFieldId: f('status') } },
        {
          kind: 'gantt',
          type: 'gantt',
          name: '甘特图',
          config: {
            taskProjectionView: 'gantt',
            startFieldId: f('startDate'),
            endFieldId: f('dueDate'),
            titleFieldId: f('title'),
            dependencyFieldId: f('dependencies'),
          },
        },
      ])
    })
  })

  describe('projectTaskRow', () => {
    it('projects one task into one row (date columns)', () => {
      const row = project()
      expect(row.recordId).toBe('rec_tsk_tlst_L1__tsk_T1')
      expect(row.data).toEqual({
        [f('title')]: 'Ship it',
        [f('status')]: 'open',
        [f('assignees')]: ['u1', 'u2'],
        [f('creator')]: ['creator'],
        [f('startDate')]: '2026-10-06',
        [f('dueDate')]: '2026-10-08',
        [f('completedAt')]: null,
        [f('isMilestone')]: false,
        [f('taskVersion')]: 3,
        [f('dependencies')]: ['rec_tsk_tlst_L1__tsk_P1', 'rec_tsk_tlst_L1__tsk_P2'],
        [f('listGroup')]: 'Backlog',
      })
      expect(row.links).toEqual([
        { fieldId: f('dependencies'), fromRecordId: 'rec_tsk_tlst_L1__tsk_T1', toRecordId: 'rec_tsk_tlst_L1__tsk_P1' },
        { fieldId: f('dependencies'), fromRecordId: 'rec_tsk_tlst_L1__tsk_T1', toRecordId: 'rec_tsk_tlst_L1__tsk_P2' },
      ])
    })
    it('dateTime columns: a timed value at its instant in the task zone (RULED(2026-10-09): [S05])', () => {
      const row = project({
        dateColumnType: 'dateTime',
        task: task({ startDate: '2026-10-06', startTime: '08:15', dueDate: '2026-10-08', dueTime: '09:30', completedAt: new Date('2026-10-07T01:02:03.000Z') }),
      })
      expect(row.data[f('startDate')]).toBe('2026-10-06T00:15:00.000Z')
      expect(row.data[f('dueDate')]).toBe('2026-10-08T01:30:00.000Z')
      expect(row.data[f('completedAt')]).toBe('2026-10-07T01:02:03.000Z')
    })
    it('dateTime columns: an untimed due is 23:59:59.999 (= due_at); an untimed start is 00:00 of its day (own choice)', () => {
      const allDay = project({ dateColumnType: 'dateTime', task: task({ startDate: '2026-10-06', dueDate: '2026-10-08' }) })
      expect(allDay.data[f('startDate')]).toBe('2026-10-05T16:00:00.000Z')
      expect(allDay.data[f('dueDate')]).toBe('2026-10-08T15:59:59.999Z')
      // An untimed start with a timed due on the same day is not after the due.
      const sameDay = project({ dateColumnType: 'dateTime', task: task({ startDate: '2026-10-08', dueDate: '2026-10-08', dueTime: '09:00' }) })
      expect(sameDay.data[f('startDate')]).toBe('2026-10-07T16:00:00.000Z')
      expect(sameDay.data[f('dueDate')]).toBe('2026-10-08T01:00:00.000Z')
      // A one-day all-day task west of UTC spans its whole day instead of a zero-length bar.
      const oneDay = project({ dateColumnType: 'dateTime', task: task({ timeZone: 'America/New_York', startDate: '2026-10-08', dueDate: '2026-10-08' }) })
      expect(oneDay.data[f('startDate')]).toBe('2026-10-08T04:00:00.000Z')
      expect(oneDay.data[f('dueDate')]).toBe('2026-10-09T03:59:59.999Z')
    })
    it('custom values: select ids become labels, unknown ids project as nothing, missing values are null', () => {
      const row = project({
        boundFields: [PRIORITY, TAGS, OWNERS, COST, NOTE, ON],
        fieldValues: [
          { fieldId: 'tfld_prio', value: 'opt_h' },
          { fieldId: 'tfld_tags', value: ['opt_b', 'opt_gone', 'opt_a'] },
          { fieldId: 'tfld_owners', value: ['u9'] },
          { fieldId: 'tfld_cost', value: 12.5 },
          { fieldId: 'tfld_unbound', value: 'ignored' },
        ],
      })
      expect(row.data[f('tfld_prio')]).toBe('High')
      expect(row.data[f('tfld_tags')]).toEqual(['B', 'A'])
      expect(row.data[f('tfld_owners')]).toEqual(['u9'])
      expect(row.data[f('tfld_cost')]).toBe(12.5)
      expect(row.data[f('tfld_note')]).toBeNull()
      expect(row.data[f('tfld_on')]).toBeNull()
      expect(Object.keys(row.data)).not.toContain(f('tfld_unbound'))
      expect(project({ boundFields: [PRIORITY], fieldValues: [{ fieldId: 'tfld_prio', value: 'opt_gone' }] }).data[f('tfld_prio')]).toBeNull()
      expect(project({ boundFields: [TAGS], fieldValues: [{ fieldId: 'tfld_tags', value: ['opt_gone'] }] }).data[f('tfld_tags')]).toBeNull()
    })
    it('taskVersion is tasks.version (RULED(2026-10-09): [S06])', () => {
      expect(project({ task: task({ version: 41 }) }).data[f('taskVersion')]).toBe(41)
    })
    it('a bound field outside the six-type closed set is refused, as by the column catalog', () => {
      const url = { id: 'tfld_u', type: 'url', name: 'U', config: {} } as unknown as TaskFieldDefinition
      expect(() => project({ boundFields: [url], fieldValues: [{ fieldId: 'tfld_u', value: 'http://example.invalid/' }] })).toThrow(TypeError)
      expect(() => taskProjectionColumns({ listId: 'tlst_L1', dateColumnType: 'date', groupNames: [], boundFields: [url] })).toThrow(TypeError)
    })
    it('rejects malformed input with TypeError', () => {
      expect(() => project({ task: task({ status: 'closed' as never }) })).toThrow(TypeError)
      expect(() => project({ task: task({ version: -1 }) })).toThrow(TypeError)
      expect(() => project({ listId: 'tlst_' })).toThrow(TypeError)
      expect(() => project({ assigneeIds: [''] })).toThrow(TypeError)
      expect(() => project({ sha256Hex: undefined as never })).toThrow(TypeError)
    })
  })

  describe('no-op digest (RULED(2026-10-09): [S08]; ASSUMPTION(task-e): [D9])', () => {
    it('is sha256 over canonical JSON: keys sorted, arrays as given', () => {
      expect(taskProjectionNoopDigest({ data: { b: 1, a: [2, 1] }, links: [] }, sha256)).toBe(sha256('{"data":{"a":[2,1],"b":1},"links":[]}'))
    })
    it('does not depend on key insertion order', () => {
      expect(taskProjectionNoopDigest({ data: { x: 1, y: { q: 1, p: 2 } }, links: [] }, sha256)).toBe(
        taskProjectionNoopDigest({ data: { y: { p: 2, q: 1 }, x: 1 }, links: [] }, sha256),
      )
    })
    it('the same task state gives the same digest, whatever order the assignees and predecessors arrive in', () => {
      expect(project().digest).toBe(project({ assigneeIds: ['u1', 'u2'], predecessorIdsInList: ['tsk_P1', 'tsk_P2'] }).digest)
    })
    it('any projected change moves the digest — including the task version', () => {
      const base = project().digest
      expect(project({ task: task({ title: 'Ship it!' }) }).digest).not.toBe(base)
      expect(project({ task: task({ version: 4 }) }).digest).not.toBe(base)
      expect(project({ predecessorIdsInList: ['tsk_P1'] }).digest).not.toBe(base)
      expect(project({ groupName: null }).digest).not.toBe(base)
    })
    it('refuses values that are not JSON', () => {
      expect(() => taskProjectionNoopDigest({ data: { a: Number.NaN }, links: [] }, sha256)).toThrow(TypeError)
      expect(() => taskProjectionNoopDigest({ data: { a: undefined }, links: [] }, sha256)).toThrow(TypeError)
      expect(() => taskProjectionNoopDigest({ data: { a: new Date(0) }, links: [] }, sha256)).toThrow(TypeError)
    })
  })

  describe('restrictTaskProjectionCapabilities (RULED(2026-10-09): [S01][S36])', () => {
    const FULL = {
      canRead: true,
      canExport: true,
      canManageViews: true,
      canCreateRecord: true,
      canEditRecord: true,
      canDeleteRecord: true,
      canManageFields: true,
      canManageSheetAccess: true,
      canComment: true,
      canManageAutomation: true,
      canSendNotification: true,
      canSubmitApproval: true,
      canSomethingElse: true,
    }
    it('the deny table is the nine write keys', () => {
      expect(TASK_PROJECTION_DENIED_CAPABILITY_KEYS).toEqual([
        'canCreateRecord',
        'canEditRecord',
        'canDeleteRecord',
        'canManageFields',
        'canManageSheetAccess',
        'canComment',
        'canManageAutomation',
        'canSendNotification',
        'canSubmitApproval',
      ])
    })
    it('a non-projection sheet is returned untouched (same object)', () => {
      expect(restrictTaskProjectionCapabilities(FULL, false, null, false)).toBe(FULL)
    })
    it('every deny key is false on a projection sheet, for every role — full (admin-shaped) input included', () => {
      for (const role of ['editor', 'reader', null] as const) {
        const out = restrictTaskProjectionCapabilities(FULL, true, role, false) as Record<string, unknown>
        for (const key of TASK_PROJECTION_DENIED_CAPABILITY_KEYS) {
          expect(out[key], `${String(role)} ${key}`).toBe(false)
        }
        expect(out.canSomethingElse).toBe(true)
        expect(out.canExport).toBe(false)
      }
    })
    it('read = member, views = editor of a list that is not archived', () => {
      const cases: Array<[('editor' | 'reader' | null), boolean, boolean, boolean]> = [
        ['editor', false, true, true],
        ['editor', true, true, false],
        ['reader', false, true, false],
        ['reader', true, true, false],
        [null, false, false, false],
        [null, true, false, false],
      ]
      for (const [role, archived, canRead, canManageViews] of cases) {
        const out = restrictTaskProjectionCapabilities(FULL, true, role, archived)
        expect([out.canRead, out.canManageViews], `${String(role)} archived=${archived}`).toEqual([canRead, canManageViews])
      }
    })
    it('a deny key that the input lacks is not added', () => {
      const out = restrictTaskProjectionCapabilities({ canRead: true, canExport: true, canManageViews: true }, true, 'reader', false)
      expect(out).toEqual({ canRead: true, canExport: false, canManageViews: false })
    })
    it('rejects malformed input with TypeError', () => {
      expect(() => restrictTaskProjectionCapabilities('x' as never, true, null, false)).toThrow(TypeError)
      expect(() => restrictTaskProjectionCapabilities(FULL, 'yes' as never, null, false)).toThrow(TypeError)
      expect(() => restrictTaskProjectionCapabilities(FULL, true, 'owner' as never, false)).toThrow(TypeError)
      expect(() => restrictTaskProjectionCapabilities(FULL, true, null, 'no' as never)).toThrow(TypeError)
    })
  })

  describe('interaction canEdit and row readability', () => {
    it('taskProjectionInteractionCanEdit: editor of a list that is not archived (RULED(2026-10-09): [S06][S36])', () => {
      expect(taskProjectionInteractionCanEdit('editor', false)).toBe(true)
      expect(taskProjectionInteractionCanEdit('editor', true)).toBe(false)
      expect(taskProjectionInteractionCanEdit('reader', false)).toBe(false)
      expect(taskProjectionInteractionCanEdit(null, false)).toBe(false)
    })
    it('isTaskProjectionRowReadable: member, task not deleted, task still in the list (RULED(2026-10-09): [S02])', () => {
      const read = (viewerListRole: 'editor' | 'reader' | null, taskDeleted: boolean, taskListed: boolean) =>
        isTaskProjectionRowReadable({ viewerListRole, taskDeleted, taskListed })
      expect(read('reader', false, true)).toBe(true)
      expect(read('editor', false, true)).toBe(true)
      expect(read(null, false, true)).toBe(false)
      expect(read('editor', true, true)).toBe(false)
      expect(read('editor', false, false)).toBe(false)
      expect(() => isTaskProjectionRowReadable({ viewerListRole: 'reader', taskDeleted: 0 as never, taskListed: true })).toThrow(TypeError)
    })
  })
})
