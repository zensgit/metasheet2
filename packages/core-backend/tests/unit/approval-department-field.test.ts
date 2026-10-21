import { describe, expect, it, vi } from 'vitest'
import {
  ApprovalDepartmentUnavailableError,
  canonicalizeApprovalDepartmentFormData,
} from '../../src/services/approval-department-field'
import type { FormSchema } from '../../src/types/approval-product'

const schema: FormSchema = {
  fields: [{
    id: 'department',
    type: 'department',
    label: '部门',
    props: { selection: 'multi', display: 'full_path', maxSelections: 2 },
  }],
}

describe('canonicalizeApprovalDepartmentFormData (Lock-2 L2-A)', () => {
  it('binds the canonical integration and freezes server names while dropping client extras', async () => {
    const formData: Record<string, unknown> = {
      department: [{ id: 'd-1', name: 'spoof' }, { id: 'd-2', fullPath: 'spoof' }],
    }
    const query = vi.fn(async (_text: string, params?: unknown[]) => ({
      rows: [
        { id: 'd-1', name: '研发', full_path: '总部 / 研发' },
        { id: 'd-2', name: '财务', full_path: null },
      ],
    }))

    await canonicalizeApprovalDepartmentFormData(schema, formData, 'integration-a', query)

    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]?.[1]).toEqual(['integration-a', ['d-1', 'd-2']])
    expect(query.mock.calls[0]?.[0]).toContain('WHERE integration_id = $1::uuid')
    expect(query.mock.calls[0]?.[0]).toContain('AND is_active = true')
    expect(formData.department).toEqual([
      { id: 'd-1', name: '研发', fullPath: '总部 / 研发' },
      { id: 'd-2', name: '财务', fullPath: '财务' },
    ])
  })

  it('rejects a missing, inactive, or foreign department without partially mutating the payload', async () => {
    const original = [{ id: 'd-1' }, { id: 'd-foreign' }]
    const formData: Record<string, unknown> = { department: original.map((entry) => ({ ...entry })) }
    const query = vi.fn(async () => ({
      rows: [{ id: 'd-1', name: '研发', full_path: '总部 / 研发' }],
    }))

    await expect(
      canonicalizeApprovalDepartmentFormData(schema, formData, 'integration-a', query),
    ).rejects.toBeInstanceOf(ApprovalDepartmentUnavailableError)
    expect(formData.department).toEqual(original)
  })

  it('performs no directory read when every department value is absent', async () => {
    const query = vi.fn()
    await canonicalizeApprovalDepartmentFormData(schema, {}, 'integration-a', query)
    expect(query).not.toHaveBeenCalled()
  })
})

describe('Lock-2 L2-A handler write boundary', () => {
  const runtimeGraph = {
    nodes: [{ key: 'h1', type: 'handler', config: {} }],
  } as never
  const formSchema: FormSchema = {
    fields: [
      { id: 'department', type: 'department', label: '部门', props: { selection: 'single', display: 'full_path' } },
      { id: 'reason', type: 'text', label: '事由' },
    ],
  }

  async function callApplyHandlerFieldWrites(fieldWrites: Record<string, unknown>) {
    const { ApprovalProductService } = await import('../../src/services/ApprovalProductService')
    const service = new ApprovalProductService()
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }
    const result = (service as unknown as {
      applyHandlerFieldWrites(
        client: { query: typeof client.query },
        instanceId: string,
        nodeKey: string,
        rawWrites: unknown,
        context: { runtimeGraph: unknown; formSchema: FormSchema; frozenSnapshot: Record<string, unknown> },
      ): Promise<{ changedFieldIds: string[]; revisions: unknown[] }>
    }).applyHandlerFieldWrites(client, 'inst_1', 'h1', fieldWrites, {
      runtimeGraph,
      formSchema,
      frozenSnapshot: {},
    })
    return { result, client }
  }

  it('refuses department writes before an id-only value can bypass canonical snapshot freezing', async () => {
    const { result, client } = await callApplyHandlerFieldWrites({ department: [{ id: 'd-1' }] })
    await expect(result).rejects.toMatchObject({
      statusCode: 400,
      code: 'APPROVAL_FIELD_WRITE_UNSUPPORTED_TYPE',
    })
    expect(client.query).not.toHaveBeenCalled()
  })

  it('keeps an ordinary sibling field writable in the same handler fixture', async () => {
    const { result, client } = await callApplyHandlerFieldWrites({ reason: '出差申请' })
    await expect(result).resolves.toMatchObject({ changedFieldIds: ['reason'] })
    expect(client.query).toHaveBeenCalledTimes(1)
  })
})
