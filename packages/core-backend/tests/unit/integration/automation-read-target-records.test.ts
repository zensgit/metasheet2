import { describe, expect, it } from 'vitest'
import {
  AutomationTargetRecordsError,
  loadAutomationReadTargetRecords,
  type AutomationReadTargetRecordsInput,
  type AutomationReadTargetRecordsQuery,
} from '../../../src/integration/automation-read-target-records'
import type { Queryable } from '../../../src/multitable/automation-durable-dispatcher'
import { injectSystemFieldValues, toIsoString } from '../../../src/multitable/record-system-fields'

type Row = Record<string, unknown>
const secret = 'synthetic-private-value'
const scope = {
  actorId: 'synthetic-owner', baseId: 'synthetic-base', sheetId: 'synthetic-sheet',
  fieldIds: ['active', 'projectNo', 'payload'], projectNo: '42', projectFieldId: 'projectNo',
  activeFieldId: 'active', maxRows: 100, maxQueries: 200,
}
function input(overrides: Partial<AutomationReadTargetRecordsInput> = {}): AutomationReadTargetRecordsInput {
  return { ...scope, fieldIds: [...scope.fieldIds], signal: new AbortController().signal, ...overrides }
}
function request(overrides: Partial<AutomationReadTargetRecordsQuery> = {}): AutomationReadTargetRecordsQuery {
  return { sheetId: scope.sheetId, filters: {}, limit: 100, offset: 0, ...overrides }
}
function record(overrides: Row = {}): Row {
  return { id: 'synthetic-row-1', data_type: 'object', matches_project: true,
    projected_data: { active: true, projectNo: '42', payload: { nested: [1, { value: secret }] } },
    created_at: null, updated_at: null, created_by: 'actual-record-creator', modified_by: null, ...overrides }
}
function fixture() {
  return {
    isolation: 'read committed', xids: ['111', '111'],
    bases: [{ id: scope.baseId, deleted_at: null }] as Row[],
    sheets: [{ id: scope.sheetId, base_id: scope.baseId, deleted_at: null, row_level_read_permissions_enabled: false }] as Row[],
    fields: scope.fieldIds.map(id => ({ id, sheet_id: scope.sheetId, type: id === 'active' ? 'boolean' : 'string', property: {} })) as Row[],
    users: [{ role: 'user', permissions: [], is_active: true, rbac_admin: false }] as Row[],
    permissions: [{ code: 'multitable:read' }] as Row[],
    sheetScopes: [] as Row[], fieldScopes: [] as Row[],
    records: [record(), record({ id: 'synthetic-row-2', matches_project: false,
      projected_data: { active: 'false', projectNo: 'other-project' }, created_by: null })] as Row[],
    metadata: null as Row[] | null,
  }
}
function harness(data = fixture(), options: { failure?: string; after?: (sql: string) => void } = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  let probes = 0
  const trx: Queryable = { async query(sql, params = []) {
    calls.push({ sql, params })
    if (options.failure && sql.includes(options.failure)) throw new Error(secret)
    const rows = sql.includes('current_setting') ? [{ isolation: data.isolation }]
      : sql.includes('pg_current_xact_id') ? [{ xid: data.xids[probes++] }]
        : sql.startsWith('LOCK TABLE') ? []
          : sql.includes('FROM meta_bases') ? data.bases
            : sql.includes('row_level_read_permissions_enabled') ? data.sheets
              : sql.startsWith('SELECT id, type FROM meta_fields') ? data.metadata ?? data.fields.map(({ id, type }) => ({ id, type }))
                : sql.includes('FROM meta_fields') ? data.fields
                  : sql.includes('SELECT role, permissions') ? data.users
                    : sql.includes('AS effective_permissions') ? data.permissions
                      : sql.includes('FROM spreadsheet_permissions') ? data.sheetScopes
                        : sql.includes('FROM field_permissions') ? data.fieldScopes
                          : sql.startsWith('SELECT deleted_at FROM meta_sheets') ? data.sheets
                            : sql.includes('FROM meta_sheets') && sql.includes('base_id =') ? []
                              : sql.includes('FROM meta_records') ? data.records : null
    if (!rows) throw new Error('Unexpected SQL fixture')
    options.after?.(sql)
    return { rows, rowCount: rows.length }
  } }
  return { trx, calls }
}

describe('Closed automation target records snapshot: real target gate with SQL query fixtures', () => {
  it('loads one finite SQL projection and replays only the two declared query shapes', async () => {
    const { trx, calls } = harness()
    const snapshot = await loadAutomationReadTargetRecords(trx, input())
    expect(Object.keys(snapshot).sort()).toEqual(['close', 'queryRecords'])
    expect(Object.isFrozen(snapshot)).toBe(true)
    const beforeReplay = calls.length
    const all = await snapshot.queryRecords(request())
    expect(all).toEqual([
      { id: 'synthetic-row-1', sheetId: scope.sheetId, data: { active: true, projectNo: '42' } },
      { id: 'synthetic-row-2', sheetId: scope.sheetId, data: { active: 'false', projectNo: 'other-project' } },
    ])
    const project = await snapshot.queryRecords(request({ filters: { projectNo: '42' } }))
    expect(project).toEqual([{ id: 'synthetic-row-1', sheetId: scope.sheetId,
      data: record().projected_data, createdBy: 'actual-record-creator' }])
    expect(calls).toHaveLength(beforeReplay)
    const records = calls.filter(call => call.sql.includes('FROM meta_records'))
    expect(records).toHaveLength(1)
    expect(records[0].params).toEqual([scope.sheetId, 'projectNo', '42', ['active', 'payload', 'projectNo'], ['active', 'projectNo'], 101, [], []])
    expect(records[0].sql).toContain('pg_catalog.jsonb_typeof(r.data) AS data_type')
    expect(records[0].sql).toContain('r.data ->> $2::text = $3::text')
    expect(records[0].sql).toContain('CASE WHEN project_match.matches_project THEN $4::text[] ELSE $5::text[] END')
    expect(records[0].sql).toContain('WHERE r.sheet_id = $1 ORDER BY r.id LIMIT $6')
    expect(records[0].sql).not.toContain('SELECT *')
    expect(calls.every(call => !/\b(?:INSERT|UPDATE|DELETE|BEGIN|COMMIT|ROLLBACK)\b/.test(call.sql))).toBe(true)
  })

  it('copies and freezes nested data, exposing no mutable driver-owned references or live rereads', async () => {
    const data = fixture()
    const { trx, calls } = harness(data)
    const snapshot = await loadAutomationReadTargetRecords(trx, input())
    const rows = await snapshot.queryRecords(request({ filters: { projectNo: '42' } }))
    const frozen = (value: unknown): void => {
      if (!value || typeof value !== 'object') return
      expect(Object.isFrozen(value)).toBe(true)
      Object.values(value).forEach(frozen)
    }
    frozen(rows)
    expect(rows[0].data).not.toBe(data.records[0].projected_data)
    expect(Reflect.set(rows[0].data, 'payload', 'caller-mutation')).toBe(false)
    const raw = data.records[0].projected_data as Row
    raw.payload = 'driver-reference-mutated'
    data.records = []
    const callCount = calls.length
    expect(await snapshot.queryRecords(request({ filters: { projectNo: '42' } }))).toEqual(rows)
    expect(calls).toHaveLength(callCount)
  })

  it('uses the SQL project match marker, preserving PostgreSQL numeric/string equality rather than JS equality', async () => {
    const data = fixture()
    data.records = [record({ projected_data: { projectNo: 42, active: true, payload: 'numeric' } }),
      record({ id: 'synthetic-row-2', matches_project: false, projected_data: { projectNo: 42, active: true }, created_by: null })]
    const snapshot = await loadAutomationReadTargetRecords(harness(data).trx, input())
    // Both parsed JSON numbers can be 42 even if PostgreSQL textual numerics
    // differed (42 versus 42.0). Only the raw SQL predicate decides membership.
    const rows = await snapshot.queryRecords(request({ filters: { projectNo: '42' } }))
    expect(rows).toHaveLength(1)
    expect(rows[0].data.projectNo).toBe(42)
    expect((await snapshot.queryRecords(request())).map(row => row.data.projectNo)).toEqual([42, 42])
  })

  it('never derives envelope createdBy from a same-named projected data cell', async () => {
    const data = fixture()
    data.fields.push({ id: 'createdBy', sheet_id: scope.sheetId, type: 'string', property: {} })
    data.records = [record({ projected_data: { projectNo: '42', active: true, createdBy: 'spoofed-data-creator' } }),
      record({ id: 'synthetic-row-2', projected_data: { projectNo: '42', active: true, createdBy: 'spoofed-data-creator' }, created_by: null })]
    const snapshot = await loadAutomationReadTargetRecords(harness(data).trx, input({ fieldIds: [...scope.fieldIds, 'createdBy'] }))
    const rows = await snapshot.queryRecords(request({ filters: { projectNo: '42' } }))
    expect(rows[0]).toMatchObject({ createdBy: 'actual-record-creator', data: { createdBy: 'spoofed-data-creator' } })
    expect(rows[1]).not.toHaveProperty('createdBy')
    expect((await snapshot.queryRecords(request())).every(row => !Object.hasOwn(row, 'createdBy'))).toBe(true)
  })

  it('injects system cells with unchanged mapper semantics and does not add them to foreign rows', async () => {
    const data = fixture()
    const types = ['createdTime', 'modifiedTime', 'createdBy', 'modifiedBy']
    data.fields.push(...types.map(type => ({ id: `system-${type}`, sheet_id: scope.sheetId, type, property: {} })))
    const current = record({ created_at: new Date('2026-10-01T00:00:00Z'), updated_at: '2026-10-01 01:02:03+00',
      modified_by: 'actual-modifier', projected_data: { active: true, projectNo: '42', 'system-createdBy': 'spoofed' } })
    data.records[0] = current
    const { trx, calls } = harness(data)
    const snapshot = await loadAutomationReadTargetRecords(trx, input({ fieldIds: data.fields.map(field => String(field.id)) }))
    const rows = await snapshot.queryRecords(request({ filters: { projectNo: '42' } }))
    expect(rows[0].data).toEqual({ active: true, projectNo: '42',
      'system-createdTime': '2026-10-01T00:00:00.000Z', 'system-modifiedTime': '2026-10-01 01:02:03+00',
      'system-createdBy': 'actual-record-creator', 'system-modifiedBy': 'actual-modifier' })
    const all = await snapshot.queryRecords(request())
    expect(Object.keys(all[1].data).sort()).toEqual(['active', 'projectNo'])
    expect(all[1]).not.toHaveProperty('createdBy')
    const sql = calls.find(call => call.sql.includes('FROM meta_records'))!
    expect(sql.params[6]).toEqual(types)
    expect(sql.params[7]).toEqual([])
    expect(sql.sql).toContain("CASE WHEN project_match.matches_project OR 'createdBy' = ANY($8::text[])")
  })

  it('keeps raw project matching separate from injected system project cells in both current and foreign scans', async () => {
    const data = fixture()
    data.fields.find(field => field.id === 'projectNo')!.type = 'createdBy'
    data.records[0].created_by = 'injected-current-project-cell'
    data.records[1].created_by = 'injected-foreign-project-cell'
    const snapshot = await loadAutomationReadTargetRecords(harness(data).trx, input())
    const current = await snapshot.queryRecords(request({ filters: { projectNo: '42' } }))
    expect(current).toHaveLength(1)
    expect(current[0].data.projectNo).toBe('injected-current-project-cell')
    expect((await snapshot.queryRecords(request())).map(row => row.data.projectNo))
      .toEqual(['injected-current-project-cell', 'injected-foreign-project-cell'])
    expect((await snapshot.queryRecords(request())).every(row => !Object.hasOwn(row, 'createdBy'))).toBe(true)
  })

  it('preserves missing cells versus explicit nulls and active values without truthy filtering', async () => {
    const data = fixture()
    data.records = [record({ projected_data: { projectNo: '42', active: null } }),
      record({ id: 'synthetic-row-2', matches_project: false, projected_data: { active: false }, created_by: null })]
    const snapshot = await loadAutomationReadTargetRecords(harness(data).trx, input())
    expect((await snapshot.queryRecords(request())).map(row => row.data)).toEqual([
      { projectNo: '42', active: null }, { active: false },
    ])
  })

  it('applies offset/limit in stable snapshot order independently to each allowed projection', async () => {
    const snapshot = await loadAutomationReadTargetRecords(harness().trx, input())
    expect((await snapshot.queryRecords(request({ limit: 1, offset: 1 })))[0].id).toBe('synthetic-row-2')
    expect(await snapshot.queryRecords(request({ filters: { projectNo: '42' }, limit: 1, offset: 1 }))).toEqual([])
    expect(await snapshot.queryRecords(request({ offset: 100000 }))).toEqual([])
  })

  it('rejects overflow before exposing a partial snapshot and accepts the exact bound', async () => {
    await expect(loadAutomationReadTargetRecords(harness().trx, input({ maxRows: 1 })))
      .rejects.toMatchObject({ code: 'AUTOMATION_TARGET_RECORDS_ROW_LIMIT_EXCEEDED' })
    await expect(loadAutomationReadTargetRecords(harness().trx, input({ maxRows: 2 }))).resolves.toHaveProperty('queryRecords')
  })

  it.each([
    null, {}, [], { ...input(), extra: secret }, { ...input(), actorId: '' }, { ...input(), sheetId: ' padded' },
    { ...input(), projectNo: 42 }, { ...input(), projectNo: '' }, { ...input(), projectNo: 'bad\u0000' },
    { ...input(), projectFieldId: 'unknown' }, { ...input(), activeFieldId: 'projectNo' },
    { ...input(), fieldIds: ['active'] }, { ...input(), fieldIds: ['active', 'active', 'projectNo'] },
    { ...input(), fieldIds: ['active', 'projectNo', ''] }, { ...input(), fieldIds: new Array(257).fill('field') },
    { ...input(), maxRows: 0 }, { ...input(), maxRows: 100001 }, { ...input(), maxRows: '2' }, { ...input(), maxRows: 1.5 },
    { ...input(), maxQueries: 0 }, { ...input(), maxQueries: 201 }, { ...input(), maxQueries: NaN },
    { ...input(), signal: null }, { ...input(), signal: { aborted: false } },
  ])('rejects invalid closed load input without querying (%#)', async bad => {
    const { trx, calls } = harness()
    await expect(loadAutomationReadTargetRecords(trx, bad as AutomationReadTargetRecordsInput))
      .rejects.toMatchObject({ code: 'AUTOMATION_TARGET_RECORDS_INPUT_INVALID' })
    expect(calls).toHaveLength(0)
  })

  it.each([
    null, {}, [], { ...request(), query: secret }, { ...request(), sheetId: 'foreign' },
    { ...request(), filters: { projectNo: 'other-project' } }, { ...request(), filters: { projectNo: 42 } },
    { ...request(), filters: { active: 'true' } }, { ...request(), filters: { projectNo: '42', active: 'true' } },
    { ...request(), filters: { projectNo: ['42'] } }, { ...request(), filters: null },
    { ...request(), limit: 0 }, { ...request(), limit: 1001 }, { ...request(), limit: '1' },
    { ...request(), limit: 0.5 }, { ...request(), offset: -1 }, { ...request(), offset: 100001 },
    { ...request(), offset: '0' }, { ...request(), offset: NaN },
  ])('rejects unsupported replay parameters with no more SQL (%#)', async bad => {
    const { trx, calls } = harness()
    const snapshot = await loadAutomationReadTargetRecords(trx, input())
    const count = calls.length
    await expect(snapshot.queryRecords(bad as AutomationReadTargetRecordsQuery))
      .rejects.toMatchObject({ code: 'AUTOMATION_TARGET_RECORDS_INPUT_INVALID' })
    expect(calls).toHaveLength(count)
  })

  it.each([
    ['unknown envelope key', { raw_data: { secret } }],
    ['unknown projected key', { projected_data: { active: true, projectNo: '42', unapproved: secret } }],
    ['array raw data', { data_type: 'array' }], ['null raw data', { data_type: 'null' }],
    ['SQL null raw data', { data_type: null }], ['scalar raw data', { data_type: 'string' }],
    ['malformed projection', { projected_data: [] }], ['untyped project match', { matches_project: 'true' }],
    ['unexpected timestamp', { created_at: secret }], ['unexpected modifier', { modified_by: secret }],
    ['foreign projection leak', { matches_project: false, projected_data: { active: true, projectNo: 'other', payload: secret }, created_by: null }],
    ['foreign creator leak', { matches_project: false, projected_data: { active: true, projectNo: 'other' }, created_by: secret }],
    ['invalid nested JSON', { projected_data: { active: true, projectNo: '42', payload: undefined } }],
  ] satisfies Array<[string, Row]> )('rejects %s before creating a replay capability', async (_label, patch) => {
    const data = fixture(); data.records = [record(patch)]
    await expect(loadAutomationReadTargetRecords(harness(data).trx, input()))
      .rejects.toMatchObject({ code: 'AUTOMATION_TARGET_RECORDS_PROJECTION_INVALID' })
  })

  it('rejects missing return columns, duplicate identities and unexpected metadata columns', async () => {
    const missing = fixture(); delete missing.records[0].data_type
    const duplicate = fixture(); duplicate.records[1].id = duplicate.records[0].id
    const metadata = fixture(); metadata.metadata = metadata.fields.map(({ id, type }) => ({ id, type, unexpected: secret }))
    for (const data of [missing, duplicate, metadata]) {
      await expect(loadAutomationReadTargetRecords(harness(data).trx, input()))
        .rejects.toMatchObject({ code: 'AUTOMATION_TARGET_RECORDS_PROJECTION_INVALID' })
    }
  })

  it('calls the real current target gate and refuses hidden/row-limited/no-read targets before any records SQL', async () => {
    for (const denial of ['hidden', 'row-policy', 'no-read']) {
      const data = fixture()
      if (denial === 'hidden') data.fields[0].property = { hidden: true }
      else if (denial === 'row-policy') data.sheets[0].row_level_read_permissions_enabled = true
      else data.permissions = []
      const { trx, calls } = harness(data)
      await expect(loadAutomationReadTargetRecords(trx, input())).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_AUTHORITY_DENIED' })
      expect(calls.some(call => call.sql.includes('FROM meta_records'))).toBe(false)
    }
  })

  it('rejects an autocommit-shaped handle through the actual prerequisite', async () => {
    const data = fixture(); data.xids = ['111', '112']
    const { trx, calls } = harness(data)
    await expect(loadAutomationReadTargetRecords(trx, input())).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_TRANSACTION_REQUIRED' })
    expect(calls.some(call => call.sql.includes('FROM meta_records'))).toBe(false)
  })

  it('copies the caller scope/field list before awaits and never adopts later mutations', async () => {
    const supplied = input()
    const { trx, calls } = harness(fixture(), { after: () => { supplied.fieldIds.length = 0; supplied.projectNo = 'switched'; supplied.sheetId = 'switched' } })
    const snapshot = await loadAutomationReadTargetRecords(trx, supplied)
    expect((await snapshot.queryRecords(request({ filters: { projectNo: '42' } }))).length).toBe(1)
    expect(calls.find(call => call.sql.includes('FROM meta_records'))?.params.slice(0, 3)).toEqual([scope.sheetId, 'projectNo', '42'])
  })

  it('rejects before the first query if already aborted, without exposing the arbitrary reason', async () => {
    const controller = new AbortController(); controller.abort(secret)
    const { trx, calls } = harness()
    await expect(loadAutomationReadTargetRecords(trx, input({ signal: controller.signal })))
      .rejects.toMatchObject({ code: 'AUTOMATION_TARGET_RECORDS_ABORTED', message: 'AUTOMATION_TARGET_RECORDS_ABORTED' })
    expect(calls).toHaveLength(0)
  })

  it.each(['current_setting', 'FROM spreadsheet_permissions', 'SELECT id, type FROM meta_fields', 'FROM meta_records'])(
    'checks cancellation immediately after actual query %s and performs no later query', async stopAt => {
    const controller = new AbortController()
    const { trx, calls } = harness(fixture(), { after: sql => { if (sql.includes(stopAt)) controller.abort(secret) } })
    await expect(loadAutomationReadTargetRecords(trx, input({ signal: controller.signal })))
      .rejects.toMatchObject({ code: 'AUTOMATION_TARGET_RECORDS_ABORTED' })
    expect(calls.at(-1)?.sql).toContain(stopAt)
  })

  it('bounds every replay attempt and invalidates all future queries after close or abort', async () => {
    const snapshot = await loadAutomationReadTargetRecords(harness().trx, input({ maxQueries: 1 }))
    await expect(snapshot.queryRecords(request({ sheetId: 'foreign' })))
      .rejects.toMatchObject({ code: 'AUTOMATION_TARGET_RECORDS_INPUT_INVALID' })
    await expect(snapshot.queryRecords(request())).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_RECORDS_QUERY_LIMIT_EXCEEDED' })
    snapshot.close(); snapshot.close()
    await expect(snapshot.queryRecords(request())).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_RECORDS_CLOSED' })
    const controller = new AbortController()
    const cancellable = await loadAutomationReadTargetRecords(harness().trx, input({ signal: controller.signal }))
    controller.abort(secret)
    await expect(cancellable.queryRecords(request())).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_RECORDS_ABORTED' })
  })

  it.each(['SELECT id, type FROM meta_fields', 'FROM meta_records'])('sanitizes query failure at %s without a raw cause', async failure => {
    let caught: unknown
    try { await loadAutomationReadTargetRecords(harness(fixture(), { failure }).trx, input()) } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(AutomationTargetRecordsError)
    expect(caught).toMatchObject({ code: 'AUTOMATION_TARGET_RECORDS_UNAVAILABLE', message: 'AUTOMATION_TARGET_RECORDS_UNAVAILABLE' })
    expect(caught).not.toHaveProperty('cause')
    expect(String(caught)).not.toContain(secret)
  })

  it('preserves legacy shared system mapper coercion and no-system identity behavior', () => {
    const data = { raw: secret }
    expect(injectSystemFieldValues(data, {}, [{ id: 'raw', type: 'string' }])).toBe(data)
    expect(toIsoString(new Date('2026-10-01T00:00:00Z'))).toBe('2026-10-01T00:00:00.000Z')
    expect(toIsoString(' raw timestamp ')).toBe(' raw timestamp ')
    expect(toIsoString(' ')).toBeNull()
    expect(toIsoString(42)).toBeNull()
    expect(injectSystemFieldValues({ creator: 'spoofed' }, { created_by: 42 }, [{ id: 'creator', type: 'createdBy' }]))
      .toEqual({ creator: null })
  })
})
