import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resolveVisibilityFieldReference,
  validateApprovalFormData,
} from '../../src/services/ApprovalGraphExecutor'
import type { FormSchema } from '../../src/types/approval-product'

// Lock-8 L8-A (docs/development/approval-lock8-field-vocabulary-20260817.md §1.1) — explanation
// (说明): a DISPLAY-ONLY field. Renders authored `props.text` to the requester/approver; collects
// NO value. This file covers:
//   - N-1 style census: the props allowlist is EXACTLY { text }
//   - A-1 valuelessness: required/defaultValue/options/placeholder each fail publish, with a
//     textarea positive control proving the rejection is TYPE-selected, not a generic bug
//   - props.text round-trip + strict allowlist (unknown key fails publish)
//   - MS-3 submit-time value validation: an explicit "no value permitted" arm (not the fail-open
//     `default: return null`), with a textarea positive control proving a REAL value DOES reach
//     validation and succeed on this same schema
//   - MS-4: detail-column exclusion (positive edit), with a number positive control
//   - MS-8: visibility whole-value denylist, with a text positive control
//   - MS-10: condition-branch exclusion, with a text positive control
//   - the BE `resolveVisibilityFieldReference` runtime mirror

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

function buildRuntimeGraph(policyOverrides?: Record<string, unknown>) {
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
    policy: { allowRevoke: true, ...policyOverrides },
  }
}

/** Wires the minimal INSERT-only DB mock a successful `createTemplate` call needs. */
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
          created_at: new Date('2026-08-17T00:00:00.000Z'), updated_at: new Date('2026-08-17T00:00:00.000Z'),
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
          created_at: new Date('2026-08-17T00:00:00.000Z'), updated_at: new Date('2026-08-17T00:00:00.000Z'),
        }],
        rowCount: 1,
      }
    }
    if (s.startsWith('UPDATE approval_templates')) {
      return {
        rows: [{
          id: tplId, key: `key-${tplId}`, name: 'Explanation Tpl', description: null, category: null,
          visibility_scope: { type: 'all', ids: [] }, sla_hours: null, status: 'draft',
          active_version_id: null, latest_version_id: verId,
          created_at: new Date('2026-08-17T00:00:00.000Z'), updated_at: new Date('2026-08-17T00:00:00.000Z'),
        }],
        rowCount: 1,
      }
    }
    throw new Error(`Unhandled query: ${s}`)
  })
}

describe('Lock-8 L8-A explanation field contract (approval-lock8-field-vocabulary-20260817.md §1.1)', () => {
  beforeEach(() => {
    pgState.pool.connect.mockReset()
    pgState.pool.query.mockReset()
    pgState.client.query.mockReset()
    pgState.client.release.mockReset()
    pgState.pool.connect.mockResolvedValue(pgState.client)
  })

  const wrap = (field: Record<string, unknown>, extra: Record<string, unknown>[] = []) => ({
    key: `exp-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: 'Explanation Tpl',
    formSchema: { fields: [field, ...extra] },
    approvalGraph: buildRuntimeGraph(),
  })
  const create = async (request: unknown) => {
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    return new ApprovalProductService().createTemplate(request as never)
  }

  it('N-1 style census: the props allowlist is EXACTLY { text }', async () => {
    const { EXPLANATION_FIELD_ALLOWED_PROP_KEYS } = await import('../../src/services/ApprovalProductService')
    // Mutation-provable: adding/removing a member here reds this exact-equality assertion
    // directly — the census IS the test, not a claim about it (mirrors L8-B/L8-C's own pattern).
    expect([...EXPLANATION_FIELD_ALLOWED_PROP_KEYS].sort()).toEqual(['text'])
  })

  describe('A-1: valuelessness — required/defaultValue/options/placeholder each fail publish', () => {
    it('required: true fails publish', async () => {
      await expect(create(wrap({
        id: 'note', type: 'explanation', label: '说明', required: true, props: { text: '仅供参考' },
      }))).rejects.toThrow(/explanation cannot be required/)
    })

    it('positive control: required: true on a textarea publishes normally (rejection is type-selected)', async () => {
      mockSuccessfulCreate('tpl-req-ctrl', 'ver-req-ctrl')
      const result = await create(wrap({ id: 'note', type: 'textarea', label: '备注', required: true }))
      expect(result.formSchema.fields[0].required).toBe(true)
    })

    it('a defaultValue fails publish', async () => {
      await expect(create(wrap({
        id: 'note', type: 'explanation', label: '说明', defaultValue: '仅供参考', props: { text: '仅供参考' },
      }))).rejects.toThrow(/explanation cannot carry a defaultValue/)
    })

    it('positive control: a defaultValue on a textarea publishes normally', async () => {
      mockSuccessfulCreate('tpl-dv-ctrl', 'ver-dv-ctrl')
      const result = await create(wrap({ id: 'note', type: 'textarea', label: '备注', defaultValue: '默认值' }))
      expect(result.formSchema.fields[0].defaultValue).toBe('默认值')
    })

    it('a placeholder fails publish', async () => {
      await expect(create(wrap({
        id: 'note', type: 'explanation', label: '说明', placeholder: '请输入', props: { text: '仅供参考' },
      }))).rejects.toThrow(/explanation cannot carry a placeholder/)
    })

    it('positive control: a placeholder on a textarea publishes normally', async () => {
      mockSuccessfulCreate('tpl-ph-ctrl', 'ver-ph-ctrl')
      const result = await create(wrap({ id: 'note', type: 'textarea', label: '备注', placeholder: '请输入' }))
      expect(result.formSchema.fields[0].placeholder).toBe('请输入')
    })

    it('options fails publish', async () => {
      await expect(create(wrap({
        id: 'note', type: 'explanation', label: '说明',
        options: [{ label: 'A', value: 'a' }], props: { text: '仅供参考' },
      }))).rejects.toThrow(/explanation cannot carry options/)
    })

    it('positive control: options on a select publishes normally', async () => {
      mockSuccessfulCreate('tpl-opt-ctrl', 'ver-opt-ctrl')
      const result = await create(wrap({
        id: 'pick', type: 'select', label: '选择', options: [{ label: 'A', value: 'a' }],
      }))
      expect(result.formSchema.fields[0].options).toEqual([{ label: 'A', value: 'a' }])
    })
  })

  describe('props.text: required + strict allowlist', () => {
    it('a missing props.text fails publish', async () => {
      await expect(create(wrap({ id: 'note', type: 'explanation', label: '说明' })))
        .rejects.toThrow(/explanation props\.text is required/)
    })

    it('a blank props.text fails publish (whitespace-only is not "written")', async () => {
      await expect(create(wrap({ id: 'note', type: 'explanation', label: '说明', props: { text: '   ' } })))
        .rejects.toThrow(/explanation props\.text is required/)
    })

    it('rejects an unknown props key (fail-closed, mirrors record-link/date_range shape)', async () => {
      await expect(create(wrap({
        id: 'note', type: 'explanation', label: '说明', props: { text: '仅供参考', printable: true },
      }))).rejects.toThrow(/explanation props may only contain/)
    })

    it('accepts and canonicalizes { text } — trimmed, no residual spread of an unknown key', async () => {
      mockSuccessfulCreate('tpl-exp', 'ver-exp')
      const result = await create(wrap({
        id: 'note', type: 'explanation', label: '说明', props: { text: '  仅供参考，请如实填写  ' },
      }))
      const field = result.formSchema.fields[0]
      expect(field.type).toBe('explanation')
      expect(field.props).toEqual({ text: '仅供参考，请如实填写' })
    })

    it('a non-blank label is still required for explanation (BE requires it for EVERY field)', async () => {
      await expect(create(wrap({ id: 'note', type: 'explanation', label: '', props: { text: '仅供参考' } })))
        .rejects.toThrow(/label is required/)
    })
  })

  describe('MS-4: detail-column eligibility — explanation EXCLUDED', () => {
    it('explanation as a detail column FAILS publish', async () => {
      await expect(create(wrap({
        id: 'items', type: 'detail', label: '明细',
        columns: [{ id: 'note', type: 'explanation', label: '说明', props: { text: '仅供参考' } }],
      }))).rejects.toThrow(/type is not a valid leaf sub-field/)
    })

    it('positive control: number STAYS admitted as a detail column throughout', async () => {
      mockSuccessfulCreate('tpl-dc-exp', 'ver-dc-exp')
      const result = await create(wrap({
        id: 'items', type: 'detail', label: '明细',
        columns: [{ id: 'qty', type: 'number', label: '数量' }],
      }))
      expect(result.formSchema.fields[0].columns?.[0].type).toBe('number')
    })
  })

  describe('MS-8: visibility whole-value denylist — explanation EXCLUDED', () => {
    it('a visibilityRule referencing an explanation field is refused', async () => {
      await expect(create(wrap(
        { id: 'note', type: 'explanation', label: '说明', props: { text: '仅供参考' } },
        [{ id: 'reason', type: 'text', label: '事由', visibilityRule: { fieldId: 'note', operator: 'notEmpty' } }],
      ))).rejects.toThrow(/cannot reference an explanation field/)
    })

    it('positive control: a visibilityRule referencing a text field is admitted and round-trips', async () => {
      mockSuccessfulCreate('tpl-vis-exp', 'ver-vis-exp')
      const result = await create(wrap(
        { id: 'kind', type: 'text', label: '类型' },
        [{ id: 'reason', type: 'text', label: '事由', visibilityRule: { fieldId: 'kind', operator: 'notEmpty' } }],
      ))
      expect(result.formSchema.fields[1].visibilityRule).toEqual({ fieldId: 'kind', operator: 'notEmpty' })
    })
  })

  describe('MS-10: condition-branch exclusion — explanation EXCLUDED', () => {
    it('rejects a simple condition rule comparing an explanation field', async () => {
      const request = {
        key: `exp-cond-${Date.now()}`,
        name: 'Explanation Cond',
        formSchema: {
          fields: [{ id: 'note', type: 'explanation', label: '说明', props: { text: '仅供参考' } }],
        },
        approvalGraph: {
          nodes: [
            { key: 'start', type: 'start', config: {} },
            {
              key: 'route',
              type: 'condition',
              config: {
                branches: [{ edgeKey: 'edge-yes', rules: [{ fieldId: 'note', operator: 'eq', value: 'anything' }] }],
                defaultEdgeKey: 'edge-no',
              },
            },
            { key: 'yes', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['u1'] } },
            { key: 'no', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['u1'] } },
            { key: 'end', type: 'end', config: {} },
          ],
          edges: [
            { key: 'edge-start-route', source: 'start', target: 'route' },
            { key: 'edge-yes', source: 'route', target: 'yes' },
            { key: 'edge-no', source: 'route', target: 'no' },
            { key: 'edge-yes-end', source: 'yes', target: 'end' },
            { key: 'edge-no-end', source: 'no', target: 'end' },
          ],
          policy: { allowRevoke: true },
        },
      }
      await expect(create(request)).rejects.toThrow(/cannot reference explanation field/)
    })

    it('positive control: a simple condition rule comparing a text field is admitted', async () => {
      mockSuccessfulCreate('tpl-cond-exp', 'ver-cond-exp')
      const request = {
        key: `exp-cond-ctrl-${Date.now()}`,
        name: 'Explanation Cond Control',
        formSchema: {
          fields: [{ id: 'kind', type: 'text', label: '类型' }],
        },
        approvalGraph: {
          nodes: [
            { key: 'start', type: 'start', config: {} },
            {
              key: 'route',
              type: 'condition',
              config: {
                branches: [{ edgeKey: 'edge-yes', rules: [{ fieldId: 'kind', operator: 'eq', value: 'urgent' }] }],
                defaultEdgeKey: 'edge-no',
              },
            },
            { key: 'yes', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['u1'] } },
            { key: 'no', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['u1'] } },
            { key: 'end', type: 'end', config: {} },
          ],
          edges: [
            { key: 'edge-start-route', source: 'start', target: 'route' },
            { key: 'edge-yes', source: 'route', target: 'yes' },
            { key: 'edge-no', source: 'route', target: 'no' },
            { key: 'edge-yes-end', source: 'yes', target: 'end' },
            { key: 'edge-no-end', source: 'no', target: 'end' },
          ],
          policy: { allowRevoke: true },
        },
      }
      const result = await create(request)
      expect(result.formSchema.fields[0].type).toBe('text')
    })
  })
})

describe('Lock-8 L8-A submit-time value validation (MS-3, ApprovalGraphExecutor)', () => {
  it('no submitted value (absent key) is accepted — the field collects nothing', () => {
    const schema: FormSchema = {
      fields: [{ id: 'note', type: 'explanation', label: '说明', props: { text: '仅供参考' } }],
    }
    expect(validateApprovalFormData(schema, {})).toEqual([])
  })

  it('ANY submitted value is rejected — an explicit "no value permitted" arm, not fail-open', () => {
    const schema: FormSchema = {
      fields: [{ id: 'note', type: 'explanation', label: '说明', props: { text: '仅供参考' } }],
    }
    expect(validateApprovalFormData(schema, { note: '我自己填的' }))
      .toEqual(['note does not accept a submitted value'])
    // Non-string values are rejected too — this is not a string-shape check, it is total.
    expect(validateApprovalFormData(schema, { note: 42 }))
      .toEqual(['note does not accept a submitted value'])
    expect(validateApprovalFormData(schema, { note: { anything: true } }))
      .toEqual(['note does not accept a submitted value'])
  })

  it('positive control: a textarea field in the SAME schema DOES accept and validate its value', () => {
    const schema: FormSchema = {
      fields: [
        { id: 'note', type: 'explanation', label: '说明', props: { text: '仅供参考' } },
        { id: 'reason', type: 'textarea', label: '事由' },
      ],
    }
    expect(validateApprovalFormData(schema, { reason: '出差申请' })).toEqual([])
    // A wrong-typed textarea value DOES fail — proving the positive control is a real validator,
    // not a vacuous "always passes" path.
    expect(validateApprovalFormData(schema, { reason: 42 as unknown as string })).toEqual(['reason must be a string'])
  })
})

describe('Lock-8 L8-A resolveVisibilityFieldReference (BE runtime mirror)', () => {
  const fields = [
    { id: 'note', type: 'explanation', label: '说明', props: { text: '仅供参考' } },
    { id: 'kind', type: 'text', label: '类型' },
  ] as FormSchema['fields']

  it('refuses a bare reference to an explanation field (null, no endpoint fallback)', () => {
    expect(resolveVisibilityFieldReference('note', fields)).toBeNull()
  })

  it('positive control: resolves a bare reference to an ordinary text field', () => {
    expect(resolveVisibilityFieldReference('kind', fields)).toEqual({ field: fields[1] })
  })
})
