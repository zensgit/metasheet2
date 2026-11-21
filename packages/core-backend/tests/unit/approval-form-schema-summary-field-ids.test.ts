import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FormField } from '../../src/types/approval-product'

// 列表摘要字段（formSchema.summaryFieldIds）：模板设置列表 / 审批中心行摘要显示哪些字段。
// 随 form_schema 保存与读回，不加列。本文件覆盖：
//   - 保存（createTemplate / updateTemplate）时的严格校验与往返
//   - 未设置 / 空数组时不写这个键（既有模板读回不变）
//   - 读回已存数据时的宽松处理（只丢掉不合法条目，不抛错）
//   - 发布时按保存规则再查一遍

const pgState = vi.hoisted(() => ({
  client: { query: vi.fn(), release: vi.fn() },
  pool: { query: vi.fn(), connect: vi.fn() },
}))

vi.mock('../../src/db/pg', () => ({
  pool: pgState.pool,
}))

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

function buildRuntimeGraph() {
  return {
    nodes: [
      { key: 'start', type: 'start', config: {} },
      { key: 'approval_1', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['manager-1'] } },
      { key: 'end', type: 'end', config: {} },
    ],
    edges: [
      { key: 'edge-start-approval', source: 'start', target: 'approval_1' },
      { key: 'edge-approval-end', source: 'approval_1', target: 'end' },
    ],
    policy: { allowRevoke: true },
  }
}

const FIELDS: Array<Record<string, unknown>> = [
  { id: 'leave_type', type: 'select', label: '请假类型', options: [{ label: '年假', value: 'annual' }] },
  { id: 'duration', type: 'number', label: '时长' },
  { id: 'reason', type: 'textarea', label: '事由' },
  { id: 'note', type: 'text', label: '备注' },
  { id: 'extra', type: 'text', label: '补充' },
  { id: 'extra2', type: 'text', label: '补充二' },
  { id: 'tip', type: 'explanation', label: '说明', props: { text: '请如实填写' } },
  { id: 'items', type: 'detail', label: '明细', columns: [{ id: 'x', type: 'text', label: 'X' }] },
  { id: 'file', type: 'attachment', label: '附件' },
]

/** Minimal INSERT-only DB mock a successful `createTemplate` call needs. */
function mockSuccessfulCreate(tplId: string, verId: string) {
  pgState.client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    const s = normalize(sql)
    if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [], rowCount: 0 }
    if (s.startsWith('INSERT INTO approval_templates')) {
      return {
        rows: [{
          id: tplId, key: String(params?.[0]), name: String(params?.[1]), description: null, category: null,
          visibility_scope: JSON.parse(String(params?.[4])), sla_hours: null, status: 'draft',
          active_version_id: null, latest_version_id: null,
          created_at: new Date('2026-10-27T00:00:00.000Z'), updated_at: new Date('2026-10-27T00:00:00.000Z'),
        }],
        rowCount: 1,
      }
    }
    if (s.startsWith('INSERT INTO approval_template_versions')) {
      return {
        rows: [{
          id: verId, template_id: tplId, version: 1, status: 'draft',
          form_schema: JSON.parse(String(params?.[1])),
          approval_graph: JSON.parse(String(params?.[2])),
          created_at: new Date('2026-10-27T00:00:00.000Z'), updated_at: new Date('2026-10-27T00:00:00.000Z'),
        }],
        rowCount: 1,
      }
    }
    if (s.startsWith('UPDATE approval_templates')) {
      return {
        rows: [{
          id: tplId, key: `key-${tplId}`, name: 'Summary Tpl', description: null, category: null,
          visibility_scope: { type: 'all', ids: [] }, sla_hours: null, status: 'draft',
          active_version_id: null, latest_version_id: verId,
          created_at: new Date('2026-10-27T00:00:00.000Z'), updated_at: new Date('2026-10-27T00:00:00.000Z'),
        }],
        rowCount: 1,
      }
    }
    throw new Error(`Unhandled query: ${s}`)
  })
}

describe('formSchema.summaryFieldIds（列表摘要字段）', () => {
  beforeEach(() => {
    pgState.pool.connect.mockReset()
    pgState.pool.query.mockReset()
    pgState.client.query.mockReset()
    pgState.client.release.mockReset()
    pgState.pool.connect.mockResolvedValue(pgState.client)
  })

  const wrap = (summaryFieldIds: unknown, withKey = true) => ({
    key: `summary-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: 'Summary Tpl',
    formSchema: withKey ? { fields: FIELDS, summaryFieldIds } : { fields: FIELDS },
    approvalGraph: buildRuntimeGraph(),
  })
  const create = async (request: unknown) => {
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    return new ApprovalProductService().createTemplate(request as never)
  }

  it('上限常量为 5', async () => {
    const { FORM_SCHEMA_SUMMARY_FIELD_MAX } = await import('../../src/types/approval-product')
    expect(FORM_SCHEMA_SUMMARY_FIELD_MAX).toBe(5)
  })

  describe('保存时（请求校验）', () => {
    it('round-trips the configured ids in the configured order', async () => {
      mockSuccessfulCreate('tpl-sum-ok', 'ver-sum-ok')
      const result = await create(wrap(['reason', 'leave_type']))
      expect(result.formSchema.summaryFieldIds).toEqual(['reason', 'leave_type'])
    })

    it('accepts exactly 5 ids', async () => {
      mockSuccessfulCreate('tpl-sum-five', 'ver-sum-five')
      const five = ['extra2', 'extra', 'note', 'reason', 'duration']
      const result = await create(wrap(five))
      expect(result.formSchema.summaryFieldIds).toEqual(five)
    })

    it('an absent key stays absent (existing templates read back unchanged)', async () => {
      mockSuccessfulCreate('tpl-sum-none', 'ver-sum-none')
      const result = await create(wrap(undefined, false))
      expect('summaryFieldIds' in result.formSchema).toBe(false)
    })

    it('an empty array or null is the same as unset: the key is not written', async () => {
      mockSuccessfulCreate('tpl-sum-empty', 'ver-sum-empty')
      const empty = await create(wrap([]))
      expect('summaryFieldIds' in empty.formSchema).toBe(false)

      mockSuccessfulCreate('tpl-sum-null', 'ver-sum-null')
      const nulled = await create(wrap(null))
      expect('summaryFieldIds' in nulled.formSchema).toBe(false)
    })

    it('rejects a non-array value', async () => {
      await expect(create(wrap('reason'))).rejects.toThrow(/summaryFieldIds must be an array/)
      expect(pgState.pool.connect).not.toHaveBeenCalled()
    })

    it('rejects a non-string entry', async () => {
      await expect(create(wrap([42]))).rejects.toThrow(/summaryFieldIds must reference top-level fields/)
    })

    it('rejects an id that is not a top-level field (including a detail column id)', async () => {
      await expect(create(wrap(['missing']))).rejects.toThrow(/summaryFieldIds must reference top-level fields/)
      await expect(create(wrap(['x']))).rejects.toThrow(/summaryFieldIds must reference top-level fields/)
    })

    it('rejects detail and explanation fields', async () => {
      await expect(create(wrap(['items']))).rejects.toThrow(/summaryFieldIds must reference top-level fields/)
      await expect(create(wrap(['tip']))).rejects.toThrow(/summaryFieldIds must reference top-level fields/)
    })

    it('a top-level attachment field passes the save check on its own, but cannot be a summary field', async () => {
      // 对照：附件字段本身能通过保存校验（不选摘要时保存成功），失败只来自 summaryFieldIds。
      mockSuccessfulCreate('tpl-sum-att-ok', 'ver-sum-att-ok')
      const saved = await create(wrap(undefined, false))
      expect(saved.formSchema.fields.some((field) => field.id === 'file' && field.type === 'attachment')).toBe(true)

      pgState.pool.connect.mockClear()
      await expect(create(wrap(['file']))).rejects.toThrow(/summaryFieldIds must reference top-level fields/)
      await expect(create(wrap(['reason', 'file']))).rejects.toThrow(/summaryFieldIds must reference top-level fields/)
      expect(pgState.pool.connect).not.toHaveBeenCalled()
    })

    it('rejects a repeated id', async () => {
      await expect(create(wrap(['reason', 'reason']))).rejects.toThrow(/must not repeat a field id/)
    })

    it('rejects more than 5 ids', async () => {
      await expect(create(wrap(['leave_type', 'duration', 'reason', 'note', 'extra', 'extra2'])))
        .rejects.toThrow(/allows at most 5 fields/)
    })

    it('rejects on updateTemplate too, before any write', async () => {
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      await expect(new ApprovalProductService().updateTemplate('tpl-any', {
        formSchema: { fields: FIELDS, summaryFieldIds: ['missing'] },
        approvalGraph: buildRuntimeGraph(),
      } as never)).rejects.toThrow(/summaryFieldIds must reference top-level fields/)
      expect(pgState.pool.connect).not.toHaveBeenCalled()
    })
  })

  describe('读回已存数据时（宽松）', () => {
    const fields = FIELDS as unknown as FormField[]

    it('drops invalid / duplicate entries and caps at 5, never throws', async () => {
      const { normalizeFormSchemaSummaryFieldIds, STORED_FORM_SCHEMA_CONTEXT } = await import(
        '../../src/services/ApprovalProductService'
      )
      expect(normalizeFormSchemaSummaryFieldIds(
        ['reason', 'missing', 42, 'items', 'tip', 'file', 'reason', 'duration'],
        fields,
        STORED_FORM_SCHEMA_CONTEXT,
      )).toEqual(['reason', 'duration'])
      // 附件字段单独出现时也被丢掉
      expect(normalizeFormSchemaSummaryFieldIds(['file', 'note'], fields, STORED_FORM_SCHEMA_CONTEXT)).toEqual(['note'])
      expect(normalizeFormSchemaSummaryFieldIds(
        ['leave_type', 'duration', 'reason', 'note', 'extra', 'extra2'],
        fields,
        STORED_FORM_SCHEMA_CONTEXT,
      )).toEqual(['leave_type', 'duration', 'reason', 'note', 'extra'])
    })

    it('a malformed or fully-invalid value reads back as unset', async () => {
      const { normalizeFormSchemaSummaryFieldIds, STORED_FORM_SCHEMA_CONTEXT } = await import(
        '../../src/services/ApprovalProductService'
      )
      expect(normalizeFormSchemaSummaryFieldIds('reason', fields, STORED_FORM_SCHEMA_CONTEXT)).toBeUndefined()
      expect(normalizeFormSchemaSummaryFieldIds(['missing'], fields, STORED_FORM_SCHEMA_CONTEXT)).toBeUndefined()
      expect(normalizeFormSchemaSummaryFieldIds([], fields, STORED_FORM_SCHEMA_CONTEXT)).toBeUndefined()
      expect(normalizeFormSchemaSummaryFieldIds(undefined, fields, STORED_FORM_SCHEMA_CONTEXT)).toBeUndefined()
    })

    it('the same input throws under the request context (control)', async () => {
      const { normalizeFormSchemaSummaryFieldIds, REQUEST_VALIDATION_CONTEXT } = await import(
        '../../src/services/ApprovalProductService'
      )
      expect(() => normalizeFormSchemaSummaryFieldIds(['missing'], fields, REQUEST_VALIDATION_CONTEXT))
        .toThrow(/summaryFieldIds must reference top-level fields/)
    })
  })

  describe('发布时', () => {
    it('re-checks the stored config with the save-time rules and rejects an invalid one', async () => {
      const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
      const templateRow = {
        id: 'tpl-sum-pub', key: 'sum-pub', name: 'Summary', description: null, category: null,
        visibility_scope: { type: 'all', ids: [] }, sla_hours: null, status: 'draft',
        active_version_id: null, latest_version_id: 'ver-sum-pub',
        created_at: new Date('2026-10-27T00:00:00.000Z'), updated_at: new Date('2026-10-27T00:00:00.000Z'),
      }
      const versionRow = {
        id: 'ver-sum-pub', template_id: 'tpl-sum-pub', version: 1, status: 'draft',
        form_schema: { fields: FIELDS, summaryFieldIds: ['reason', 'missing'] },
        approval_graph: buildRuntimeGraph(),
        created_at: new Date('2026-10-27T00:00:00.000Z'), updated_at: new Date('2026-10-27T00:00:00.000Z'),
      }
      pgState.client.query.mockImplementation(async (sql: string) => {
        const s = normalize(sql)
        if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [], rowCount: 0 }
        if (s.includes('FROM approval_templates') && s.includes('FOR UPDATE')) {
          return { rows: [templateRow], rowCount: 1 }
        }
        if (s.includes('FROM approval_template_versions')) {
          return { rows: [versionRow], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      })

      await expect(new ApprovalProductService().publishTemplate('tpl-sum-pub', {
        policy: { allowRevoke: true },
        actorUserId: 'admin-1',
      } as never)).rejects.toThrow(/summaryFieldIds must reference top-level fields/)
      const sqls = pgState.client.query.mock.calls.map(([sql]) => normalize(String(sql)))
      expect(sqls).toContain('ROLLBACK')
      expect(sqls.some((s) => s.startsWith('INSERT INTO approval_published_definitions'))).toBe(false)
    })
  })
})
