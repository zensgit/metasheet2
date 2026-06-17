import { describe, expect, it } from 'vitest'
import {
  collectActiveNodeKeys,
  redactHiddenFormFields,
  type RedactableRuntimeGraph,
} from '../../src/services/approval-form-redaction'

function graphHiding(nodeKey: string, fieldIds: string[]): RedactableRuntimeGraph {
  return {
    nodes: [
      { key: 'start', config: {} },
      {
        key: nodeKey,
        config: { fieldPermissions: fieldIds.map((fieldId) => ({ fieldId, access: 'hidden' })) },
      },
      { key: 'end', config: {} },
    ],
  }
}

describe('redactHiddenFormFields', () => {
  const snapshot = { fld_reason: 'trip', fld_amount: 5000, fld_secret: 'ssn' }

  it('removes a hidden field when the instance is AT the hiding node', () => {
    const result = redactHiddenFormFields(snapshot, graphHiding('approval_1', ['fld_secret']), ['approval_1'])
    expect(result).toEqual({ fld_reason: 'trip', fld_amount: 5000 })
    expect(result).not.toBe(snapshot)
  })

  it('retains non-hidden fields', () => {
    const result = redactHiddenFormFields(snapshot, graphHiding('approval_1', ['fld_secret']), ['approval_1'])
    expect(result).toHaveProperty('fld_reason')
    expect(result).toHaveProperty('fld_amount')
    expect(result).not.toHaveProperty('fld_secret')
  })

  it('leaves the snapshot byte-identical (same reference) when nothing is hidden', () => {
    const result = redactHiddenFormFields(snapshot, graphHiding('approval_1', []), ['approval_1'])
    expect(result).toBe(snapshot)
  })

  it('does not redact when the instance is at a non-hiding node', () => {
    const result = redactHiddenFormFields(snapshot, graphHiding('approval_1', ['fld_secret']), ['approval_2'])
    expect(result).toBe(snapshot)
    expect(result).toHaveProperty('fld_secret')
  })

  it('only redacts editable/readonly entries do not hide anything', () => {
    const graph: RedactableRuntimeGraph = {
      nodes: [
        {
          key: 'approval_1',
          config: {
            fieldPermissions: [
              { fieldId: 'fld_reason', access: 'readonly' },
              { fieldId: 'fld_amount', access: 'editable' },
            ],
          },
        },
      ],
    }
    const result = redactHiddenFormFields(snapshot, graph, ['approval_1'])
    expect(result).toBe(snapshot)
  })

  it('unions hidden fields across all active nodes in a parallel region', () => {
    const graph: RedactableRuntimeGraph = {
      nodes: [
        { key: 'branch_a', config: { fieldPermissions: [{ fieldId: 'fld_reason', access: 'hidden' }] } },
        { key: 'branch_b', config: { fieldPermissions: [{ fieldId: 'fld_amount', access: 'hidden' }] } },
      ],
    }
    const result = redactHiddenFormFields(snapshot, graph, ['branch_a', 'branch_b'])
    expect(result).toEqual({ fld_secret: 'ssn' })
  })

  it('is safe with a null snapshot', () => {
    expect(redactHiddenFormFields(null, graphHiding('approval_1', ['fld_secret']), ['approval_1'])).toBeNull()
  })

  it('is safe with a null runtime graph (bridged/external instance)', () => {
    expect(redactHiddenFormFields(snapshot, null, ['approval_1'])).toBe(snapshot)
  })

  it('is safe with empty active node keys', () => {
    expect(redactHiddenFormFields(snapshot, graphHiding('approval_1', ['fld_secret']), [])).toBe(snapshot)
  })

  it('is safe with null/undefined active node keys mixed in', () => {
    const result = redactHiddenFormFields(snapshot, graphHiding('approval_1', ['fld_secret']), [null, undefined, 'approval_1'])
    expect(result).not.toHaveProperty('fld_secret')
  })

  it('does not throw when a hidden field is absent from the snapshot', () => {
    const result = redactHiddenFormFields(snapshot, graphHiding('approval_1', ['fld_not_present']), ['approval_1'])
    expect(result).toBe(snapshot)
  })

  it('is safe with an empty-nodes runtime graph', () => {
    expect(redactHiddenFormFields(snapshot, { nodes: [] }, ['approval_1'])).toBe(snapshot)
  })
})

describe('collectActiveNodeKeys', () => {
  it('returns the single current node key when there is no parallel state', () => {
    expect(collectActiveNodeKeys('approval_1', null)).toEqual(['approval_1'])
  })

  it('returns empty when current node key is null and no parallel state', () => {
    expect(collectActiveNodeKeys(null, {})).toEqual([])
  })

  it('unions current node key with non-complete parallel branch node keys', () => {
    const metadata = {
      parallelBranchStates: {
        parallelNodeKey: 'p',
        joinNodeKey: 'j',
        joinMode: 'all',
        branches: {
          a: { edgeKey: 'a', currentNodeKey: 'branch_a', complete: false },
          b: { edgeKey: 'b', currentNodeKey: 'branch_b', complete: false },
        },
      },
    }
    const result = collectActiveNodeKeys('p', metadata)
    expect(result.sort()).toEqual(['branch_a', 'branch_b', 'p'])
  })

  it('skips completed branches', () => {
    const metadata = {
      parallelBranchStates: {
        branches: {
          a: { edgeKey: 'a', currentNodeKey: 'branch_a', complete: true },
          b: { edgeKey: 'b', currentNodeKey: 'branch_b', complete: false },
        },
      },
    }
    expect(collectActiveNodeKeys(null, metadata).sort()).toEqual(['branch_b'])
  })

  it('degrades to current node key on malformed metadata', () => {
    expect(collectActiveNodeKeys('approval_1', { parallelBranchStates: 'bad' } as never)).toEqual(['approval_1'])
  })
})
