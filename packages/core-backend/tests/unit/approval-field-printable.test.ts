import { beforeEach, describe, expect, it, vi } from 'vitest'

// 参与打印（字段属性 `printable`）：表单字段可以设为不参与打印。缺省即参与，旧模板不变。
// 这里只测模板保存时的规范化与校验：
//   - 只接受布尔值；其他类型拒绝
//   - 只对顶层字段有效；明细子字段带了就拒绝（不静默丢弃）
//   - 只保存 `false`；`true` 与缺省同义，不落库
//   - 旧模板（没有这个键）保存后字段对象不变
//   - 任意顶层类型都可以设（含说明、明细本身）
// 打印页怎么取舍由前端按实例冻结的 formSchema 决定，不在这里测。

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

/** Minimal INSERT-only DB mock for a successful `createTemplate`; returns the stored form_schema. */
function mockSuccessfulCreate(tplId: string, verId: string) {
  const stored: { formSchema?: unknown } = {}
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
      stored.formSchema = JSON.parse(String(params?.[1]))
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
          id: tplId, key: `key-${tplId}`, name: 'Printable Tpl', description: null, category: null,
          visibility_scope: { type: 'all', ids: [] }, sla_hours: null, status: 'draft',
          active_version_id: null, latest_version_id: verId,
          created_at: new Date('2026-10-27T00:00:00.000Z'), updated_at: new Date('2026-10-27T00:00:00.000Z'),
        }],
        rowCount: 1,
      }
    }
    throw new Error(`Unhandled query: ${s}`)
  })
  return stored
}

describe('approval form field 参与打印 (printable)', () => {
  beforeEach(() => {
    pgState.pool.connect.mockReset()
    pgState.pool.query.mockReset()
    pgState.client.query.mockReset()
    pgState.client.release.mockReset()
    pgState.pool.connect.mockResolvedValue(pgState.client)
  })

  const wrap = (fields: Record<string, unknown>[]) => ({
    key: `printable-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: 'Printable Tpl',
    formSchema: { fields },
    approvalGraph: buildRuntimeGraph(),
  })
  const create = async (request: unknown) => {
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    return new ApprovalProductService().createTemplate(request as never)
  }

  describe('type check: boolean only', () => {
    it.each([
      ['string "false"', 'false'],
      ['number 0', 0],
      ['null', null],
      ['object', {}],
    ])('rejects printable as %s', async (_label, printable) => {
      await expect(create(wrap([{ id: 'reason', type: 'text', label: '事由', printable }])))
        .rejects.toThrow(/formSchema\.fields\[0\]\.printable must be a boolean/)
      expect(pgState.client.query).not.toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO approval_template_versions'),
        expect.anything(),
      )
    })
  })

  describe('top-level only', () => {
    it('rejects printable: false on a detail column', async () => {
      await expect(create(wrap([{
        id: 'items', type: 'detail', label: '明细',
        columns: [{ id: 'qty', type: 'number', label: '数量', printable: false }],
      }]))).rejects.toThrow(/formSchema\.fields\[0\]\.printable is only valid on a top-level field/)
    })

    it('rejects printable: true on a detail column too (fail closed, never silently dropped)', async () => {
      await expect(create(wrap([{
        id: 'items', type: 'detail', label: '明细',
        columns: [{ id: 'qty', type: 'number', label: '数量' }, { id: 'note', type: 'text', label: '备注', printable: true }],
      }]))).rejects.toThrow(/formSchema\.fields\[1\]\.printable is only valid on a top-level field/)
    })

    it('a malformed printable on a detail column reports the type error first', async () => {
      await expect(create(wrap([{
        id: 'items', type: 'detail', label: '明细',
        columns: [{ id: 'qty', type: 'number', label: '数量', printable: 'no' }],
      }]))).rejects.toThrow(/formSchema\.fields\[0\]\.printable must be a boolean/)
    })

    it('positive control: printable: false on the detail field itself is accepted and kept', async () => {
      mockSuccessfulCreate('tpl-print-detail', 'ver-print-detail')
      const result = await create(wrap([{
        id: 'items', type: 'detail', label: '明细', printable: false,
        columns: [{ id: 'qty', type: 'number', label: '数量' }],
      }]))
      expect(result.formSchema.fields[0].printable).toBe(false)
      expect(result.formSchema.fields[0].columns).toEqual([{ id: 'qty', type: 'number', label: '数量' }])
    })
  })

  describe('canonical storage: only false is stored', () => {
    it('stores printable: false exactly', async () => {
      const stored = mockSuccessfulCreate('tpl-print-false', 'ver-print-false')
      const result = await create(wrap([
        { id: 'reason', type: 'text', label: '事由', required: true },
        { id: 'amount', type: 'number', label: '金额', printable: false },
      ]))
      expect(result.formSchema.fields).toEqual([
        { id: 'reason', type: 'text', label: '事由', required: true },
        { id: 'amount', type: 'number', label: '金额', printable: false },
      ])
      expect(stored.formSchema).toEqual({ fields: result.formSchema.fields })
    })

    it('drops printable: true (same as absent)', async () => {
      const stored = mockSuccessfulCreate('tpl-print-true', 'ver-print-true')
      const result = await create(wrap([{ id: 'reason', type: 'text', label: '事由', printable: true }]))
      expect(result.formSchema.fields[0]).toEqual({ id: 'reason', type: 'text', label: '事由' })
      expect(Object.prototype.hasOwnProperty.call(result.formSchema.fields[0], 'printable')).toBe(false)
      expect(stored.formSchema).toEqual({ fields: [{ id: 'reason', type: 'text', label: '事由' }] })
    })

    it('an old template without the key is stored unchanged (no new key appears)', async () => {
      const stored = mockSuccessfulCreate('tpl-print-old', 'ver-print-old')
      const fields = [
        { id: 'reason', type: 'text', label: '事由', required: true, placeholder: '请输入' },
        { id: 'kind', type: 'select', label: '类型', options: [{ label: '差旅', value: 'trip' }] },
      ]
      const result = await create(wrap(fields))
      expect(result.formSchema.fields).toEqual(fields)
      expect(stored.formSchema).toEqual({ fields })
    })

    it('works on an explanation field without disturbing its props allowlist', async () => {
      mockSuccessfulCreate('tpl-print-exp', 'ver-print-exp')
      const result = await create(wrap([
        { id: 'note', type: 'explanation', label: '说明', props: { text: '仅供参考' }, printable: false },
      ]))
      expect(result.formSchema.fields[0]).toEqual({
        id: 'note', type: 'explanation', label: '说明', props: { text: '仅供参考' }, printable: false,
      })
    })

    it('printable inside props is still an unknown props key where props are allowlisted', async () => {
      await expect(create(wrap([
        { id: 'note', type: 'explanation', label: '说明', props: { text: '仅供参考', printable: false } },
      ]))).rejects.toThrow(/explanation props may only contain/)
    })
  })
})
