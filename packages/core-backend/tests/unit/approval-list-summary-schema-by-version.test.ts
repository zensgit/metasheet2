import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FormSchema } from '../../src/types/approval-product'

// 列表摘要按单据绑定的模板版本解释：listApprovals 给每行带上 summarySchema，取自该行的
// template_version_id，而不是最新模板。本文件覆盖：
//   - buildListSummarySchema：只留快照里有值的可用字段；每个字段只带显示摘要用到的键；按版本配置取字段、
//     不补位；与前端同样的整理规则
//   - listApprovals：整页只查一次版本表（按去重后的版本 id），每行用自己的版本；没有版本的行不带这个键；
//     当前节点隐藏的字段不会出现在 summarySchema 里

const pgState = vi.hoisted(() => ({
  pool: { query: vi.fn() },
}))

vi.mock('../../src/db/pg', () => ({
  pool: pgState.pool,
}))

import { ApprovalBridgeService, buildListSummarySchema } from '../../src/services/ApprovalBridgeService'

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

// v1：旧版本。字段名「请假类型」，摘要配置为「事由」。
const V1_SCHEMA = {
  fields: [
    { id: 'leave_type', type: 'select', label: '请假类型', options: [{ label: '年假', value: 'annual' }] },
    { id: 'days', type: 'number', label: '天数' },
    { id: 'reason', type: 'textarea', label: '事由' },
    { id: 'file', type: 'attachment', label: '附件' },
  ],
  summaryFieldIds: ['reason'],
} as unknown as FormSchema

// v2：模板改名、改摘要配置之后的新版本。
const V2_SCHEMA = {
  fields: [
    { id: 'leave_type', type: 'select', label: '假期类型', options: [{ label: '带薪年假', value: 'annual' }] },
    { id: 'days', type: 'number', label: '请假天数' },
    { id: 'reason', type: 'textarea', label: '原因' },
  ],
  summaryFieldIds: ['leave_type', 'days'],
} as unknown as FormSchema

describe('buildListSummarySchema', () => {
  const schema = {
    fields: [
      { id: 'a', type: 'text', label: 'A' },
      { id: 'b', type: 'number', label: 'B' },
      { id: 'c', type: 'text', label: 'C' },
      { id: 'd', type: 'text', label: 'D' },
      { id: 'e', type: 'text', label: 'E' },
      { id: 'f', type: 'text', label: 'F' },
      { id: 'file', type: 'attachment', label: '附件' },
      { id: 'items', type: 'detail', label: '明细', columns: [{ id: 'x', type: 'text', label: 'X' }] },
      { id: 'tip', type: 'explanation', label: '说明', props: { text: '请如实填写' } },
    ],
  } as unknown as FormSchema
  const snapshot = { a: 'a', b: 1, c: 'c', d: 'd', e: 'e', f: 'f', file: ['f1'], items: [{ x: '1' }] }

  it('without a configured list: every eligible field present in the snapshot, in schema order', () => {
    const result = buildListSummarySchema(schema, { b: 1, a: 'a', file: ['f1'], items: [], unknown: 'x' })
    expect(result).toEqual({ fields: [schema.fields[0], schema.fields[1]] })
    expect('summaryFieldIds' in result!).toBe(false)
  })

  it('labels / options come from this version', () => {
    const result = buildListSummarySchema({ fields: V1_SCHEMA.fields } as FormSchema, { leave_type: 'annual' })
    expect(result!.fields).toEqual([
      { id: 'leave_type', type: 'select', label: '请假类型', options: [{ label: '年假', value: 'annual' }] },
    ])
  })

  it('each field carries only the keys the summary line renders with', () => {
    const rich = {
      fields: [
        {
          id: 'linked',
          type: 'record-link',
          label: '关联记录',
          required: true,
          props: { baseId: 'base_1', sheetId: 'sheet_1' },
        },
        {
          id: 'kind',
          type: 'select',
          label: '类型',
          placeholder: '请选择',
          options: [{ label: '甲', value: 'a' }],
          visibilityRule: { fieldId: 'linked', operator: 'notEmpty' },
        },
        { id: 'dept', type: 'department', label: '部门', props: { display: 'full_path', other: 'x' } },
        { id: 'span', type: 'date_range', label: '起止', props: { dateType: 'date' } },
      ],
    } as unknown as FormSchema
    const result = buildListSummarySchema(rich, {
      linked: { recordId: 'rec_1' },
      kind: 'a',
      dept: [{ name: '研发' }],
      span: { start: '2026-10-01', end: '2026-10-02' },
    })
    expect(result).toEqual({
      fields: [
        { id: 'linked', type: 'record-link', label: '关联记录' },
        { id: 'kind', type: 'select', label: '类型', options: [{ label: '甲', value: 'a' }] },
        { id: 'dept', type: 'department', label: '部门', props: { display: 'full_path' } },
        { id: 'span', type: 'date_range', label: '起止', props: { dateType: 'date' } },
      ],
    })
    const text = JSON.stringify(result)
    for (const absent of ['base_1', 'sheet_1', 'visibilityRule', 'required', 'placeholder', 'other']) {
      expect(text).not.toContain(absent)
    }
  })

  it('without a configured list: at most FORM_SCHEMA_SUMMARY_FIELD_MAX fields (the web client shows the first 3)', () => {
    const result = buildListSummarySchema(schema, snapshot)
    expect(result!.fields.map((field) => field.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect('summaryFieldIds' in result!).toBe(false)
  })

  it('with a configured list: only configured fields present in the snapshot, in configured order', () => {
    const configured = { ...schema, summaryFieldIds: ['c', 'a'] } as FormSchema
    const result = buildListSummarySchema(configured, snapshot)
    expect(result!.fields.map((field) => field.id)).toEqual(['c', 'a'])
    expect(result!.summaryFieldIds).toEqual(['c', 'a'])
  })

  it('a configured field missing from the snapshot (hidden at the current node) is dropped, never backfilled', () => {
    const configured = { ...schema, summaryFieldIds: ['b', 'c'] } as FormSchema
    const withoutB: Record<string, unknown> = { ...snapshot }
    delete withoutB.b
    expect(buildListSummarySchema(configured, withoutB)!.summaryFieldIds).toEqual(['c'])

    const onlyHidden = { ...schema, summaryFieldIds: ['b'] } as FormSchema
    // 一个都没有：空字段列表（这一行不显示摘要），不会退回默认的前 3 个字段。
    expect(buildListSummarySchema(onlyHidden, withoutB)).toEqual({ fields: [] })
  })

  it('ineligible / unknown configured ids are ignored', () => {
    const configured = { ...schema, summaryFieldIds: ['file', 'items', 'tip', 'legacy', 'd'] } as FormSchema
    expect(buildListSummarySchema(configured, { ...snapshot, legacy: 'x' })!.summaryFieldIds).toEqual(['d'])
  })

  it('normalizes the configured list like the web client: strings only, de-duplicated, capped before filtering', () => {
    const withoutA: Record<string, unknown> = { ...snapshot }
    delete withoutA.a
    // 先截到 5 个（a b c d e），再去掉快照里没有的 a：f 不会被补进来。
    const configured = { ...schema, summaryFieldIds: ['a', 'b', 'b', 7, '', 'c', 'd', 'e', 'f'] } as unknown as FormSchema
    expect(buildListSummarySchema(configured, withoutA)!.summaryFieldIds).toEqual(['b', 'c', 'd', 'e'])
  })

  it('returns null when the version schema is missing or malformed', () => {
    expect(buildListSummarySchema(null, snapshot)).toBeNull()
    expect(buildListSummarySchema(undefined, snapshot)).toBeNull()
    expect(buildListSummarySchema({ fields: 'x' } as unknown as FormSchema, snapshot)).toBeNull()
  })

  it('a null snapshot yields no fields', () => {
    expect(buildListSummarySchema(V2_SCHEMA, null)).toEqual({ fields: [] })
    expect(buildListSummarySchema({ fields: V2_SCHEMA.fields } as FormSchema, null)).toEqual({ fields: [] })
  })
})

describe('listApprovals attaches summarySchema from each row\'s own template version', () => {
  const at = new Date('2026-10-01T00:00:00Z')
  function instance(overrides: Record<string, unknown>) {
    return {
      id: 'apv_x',
      status: 'pending',
      version: 1,
      source_system: 'platform',
      external_approval_id: null,
      workflow_key: null,
      business_key: null,
      title: '请假',
      requester_snapshot: {},
      subject_snapshot: {},
      policy_snapshot: {},
      metadata: {},
      current_step: 1,
      total_steps: 1,
      source_updated_at: null,
      last_synced_at: null,
      sync_status: 'ok',
      sync_error: null,
      template_id: 'tpl_leave',
      template_version_id: null,
      published_definition_id: null,
      request_no: null,
      form_snapshot: { leave_type: 'annual', days: 2, reason: '出差', file: ['f1'] },
      current_node_key: 'approval_1',
      created_at: at,
      updated_at: at,
      ...overrides,
    }
  }

  const ROWS = [
    // 旧单：v1，模板改名、改摘要配置之前发起。
    instance({ id: 'apv_old', template_version_id: 'v1' }),
    // 新单：v2。
    instance({ id: 'apv_new', template_version_id: 'v2' }),
    // 旧单，且当前节点隐藏了「事由」（v1 唯一的摘要字段）。
    instance({ id: 'apv_old_hidden', template_version_id: 'v1', published_definition_id: 'pd_hide' }),
    // 没有绑定版本（外部来源 / 旧数据）。
    instance({ id: 'apv_bridged', template_id: null, template_version_id: null, source_system: 'plm' }),
  ]

  const versionQueries: unknown[][] = []

  beforeEach(() => {
    versionQueries.length = 0
    pgState.pool.query.mockReset()
    pgState.pool.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = normalize(sql)
      if (text.startsWith('SELECT COUNT(*)::text AS count FROM approval_instances')) {
        return { rows: [{ count: String(ROWS.length) }] }
      }
      if (text.startsWith('SELECT * FROM approval_instances')) return { rows: ROWS }
      if (text.startsWith('SELECT * FROM approval_assignments')) return { rows: [] }
      if (text.startsWith('SELECT id, runtime_graph FROM approval_published_definitions')) {
        return {
          rows: [{
            id: 'pd_hide',
            runtime_graph: {
              nodes: [{ key: 'approval_1', type: 'approval', config: { fieldPermissions: [{ fieldId: 'reason', access: 'hidden' }] } }],
              edges: [],
            },
          }],
        }
      }
      if (text.startsWith('SELECT id, form_schema FROM approval_template_versions')) {
        versionQueries.push(params ?? [])
        return {
          rows: [
            { id: 'v1', form_schema: V1_SCHEMA },
            { id: 'v2', form_schema: V2_SCHEMA },
          ],
        }
      }
      return { rows: [] }
    })
  })

  it('reads the version schemas once per page and resolves each row against its own version', async () => {
    const result = await new ApprovalBridgeService().listApprovals({})
    const byId = new Map(result.data.map((dto) => [dto.id, dto]))

    // 整页一次查询，参数是去重后的版本 id（不按行查，也不按模板查最新版本）。
    expect(versionQueries).toHaveLength(1)
    expect((versionQueries[0]![0] as string[]).slice().sort()).toEqual(['v1', 'v2'])
    const sqls = pgState.pool.query.mock.calls.map((call) => normalize(String(call[0])))
    expect(sqls.some((sql) => sql.includes('FROM approval_templates'))).toBe(false)

    // 旧单：仍按 v1 的配置（事由）和 v1 的字段名显示。
    expect(byId.get('apv_old')!.summarySchema).toEqual({
      fields: [V1_SCHEMA.fields[2]],
      summaryFieldIds: ['reason'],
    })
    expect(byId.get('apv_old')!.summarySchema!.fields[0]!.label).toBe('事由')

    // 新单：按 v2 的配置（假期类型、请假天数）和 v2 的字段名、选项名。
    const newer = byId.get('apv_new')!.summarySchema!
    expect(newer.summaryFieldIds).toEqual(['leave_type', 'days'])
    expect(newer.fields.map((field) => field.label)).toEqual(['假期类型', '请假天数'])

    // 当前节点隐藏了 v1 唯一的摘要字段：快照里没有它，summarySchema 也没有，且不补位。
    expect(byId.get('apv_old_hidden')!.formSnapshot).not.toHaveProperty('reason')
    expect(byId.get('apv_old_hidden')!.summarySchema).toEqual({ fields: [] })

    // 没有绑定版本的行不带这个键（前端对这类行沿用原来的做法）。
    expect('summarySchema' in byId.get('apv_bridged')!).toBe(false)
  })

  it('no row carries field definitions beyond the values it already returns', async () => {
    const result = await new ApprovalBridgeService().listApprovals({})
    for (const dto of result.data) {
      if (!dto.summarySchema) continue
      for (const field of dto.summarySchema.fields) {
        expect(dto.formSnapshot ?? {}).toHaveProperty(field.id)
        expect(['attachment', 'detail', 'explanation']).not.toContain(field.type)
      }
    }
  })
})
