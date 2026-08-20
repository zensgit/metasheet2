import { describe, expect, it } from 'vitest'
import {
  collectActiveNodeKeys,
  collectHiddenFieldIds,
  fieldAccessAtNodes,
  redactHiddenFormFields,
  resolveFieldAccessAtNodes,
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

// ── Lock-7 L7-A — the single derivation resolveFieldAccessAtNodes ─────────────────────────────────
function graphWithMatrix(perNode: Record<string, Array<{ fieldId: string; access: 'editable' | 'readonly' | 'hidden' }>>): RedactableRuntimeGraph {
  return {
    nodes: Object.entries(perNode).map(([key, fieldPermissions]) => ({ key, type: 'approval', config: { fieldPermissions } })),
  }
}

describe('resolveFieldAccessAtNodes (Lock-7 L7-A)', () => {
  // ── G-1a — the derivation is DERIVED, not three copies ──────────────────────────────────────────
  it('G-1a: an ABSENT field is editable by default; the write consumer (single node) reads readonly/hidden/editable directly', () => {
    const graph = graphWithMatrix({ n1: [{ fieldId: 'ro', access: 'readonly' }, { fieldId: 'hid', access: 'hidden' }, { fieldId: 'ed', access: 'editable' }] })
    // absent-key default is editable — this is the mutation-sensitive fact the write mask depends on.
    expect(fieldAccessAtNodes(graph, ['n1'], 'never_configured')).toBe('editable')
    expect(fieldAccessAtNodes(graph, ['n1'], 'ro')).toBe('readonly')
    expect(fieldAccessAtNodes(graph, ['n1'], 'hid')).toBe('hidden')
    expect(fieldAccessAtNodes(graph, ['n1'], 'ed')).toBe('editable')
  })

  it('G-1a: the hidden consumer (collectHiddenFieldIds) is DERIVED over resolveFieldAccessAtNodes — set-equal to the map\'s hidden keys', () => {
    const graph = graphWithMatrix({
      n1: [{ fieldId: 'a', access: 'hidden' }, { fieldId: 'b', access: 'readonly' }],
      n2: [{ fieldId: 'c', access: 'hidden' }, { fieldId: 'd', access: 'editable' }],
    })
    const map = resolveFieldAccessAtNodes(graph, ['n1', 'n2'])
    const derivedHidden = new Set([...map].filter(([, access]) => access === 'hidden').map(([fieldId]) => fieldId))
    // collectHiddenFieldIds (snapshot echo + attachment byte gate consumer) must equal the derived set.
    expect(collectHiddenFieldIds(graph, ['n1', 'n2'])).toEqual(derivedHidden)
    expect([...derivedHidden].sort()).toEqual(['a', 'c'])
  })

  // ── G-1b — precedence, scoped to the MULTI-node read path only ──────────────────────────────────
  it('G-1b: most-restrictive-wins across multiple nodes (hidden ≻ readonly ≻ editable)', () => {
    const graph = graphWithMatrix({
      n1: [{ fieldId: 'f_hr', access: 'hidden' }, { fieldId: 'f_re', access: 'readonly' }],
      n2: [{ fieldId: 'f_hr', access: 'readonly' }, { fieldId: 'f_re', access: 'editable' }],
    })
    // hidden vs readonly ⇒ hidden; readonly vs editable ⇒ readonly.
    expect(fieldAccessAtNodes(graph, ['n1', 'n2'], 'f_hr')).toBe('hidden')
    expect(fieldAccessAtNodes(graph, ['n1', 'n2'], 'f_re')).toBe('readonly')
  })

  it('G-1b: precedence is UNOBSERVABLE on a single-node set — the write consumer sees only its node', () => {
    const graph = graphWithMatrix({
      n1: [{ fieldId: 'f', access: 'readonly' }],
      n2: [{ fieldId: 'f', access: 'hidden' }],
    })
    // The write mask is given exactly [nodeKey]; each single-node answer is that node's own value,
    // never a cross-node precedence result (this is what makes G-1a's precedence-flip exclusion valid).
    expect(fieldAccessAtNodes(graph, ['n1'], 'f')).toBe('readonly')
    expect(fieldAccessAtNodes(graph, ['n2'], 'f')).toBe('hidden')
  })

  // ── G-2 — read behavior byte-identical: degenerate inputs never throw, empty map ────────────────
  it('G-2: null graph / empty node set / node without permissions all yield an empty access map', () => {
    expect(resolveFieldAccessAtNodes(null, ['n1']).size).toBe(0)
    expect(resolveFieldAccessAtNodes(graphWithMatrix({ n1: [] }), []).size).toBe(0)
    expect(resolveFieldAccessAtNodes({ nodes: [{ key: 'n1', config: {} }] }, ['n1']).size).toBe(0)
    // absent from map ⇒ editable default holds on every degenerate input.
    expect(fieldAccessAtNodes(null, ['n1'], 'x')).toBe('editable')
  })
})

// ── Lock-7B OD-L7B-10 — resolveFieldAccessAtNodes resolves the FOURTH member mechanically ─────────
function graphWithFourStateMatrix(perNode: Record<string, Array<{ fieldId: string; access: 'editable' | 'readonly' | 'hidden' | 'required' }>>): RedactableRuntimeGraph {
  return {
    nodes: Object.entries(perNode).map(([key, fieldPermissions]) => ({ key, type: 'handler', config: { fieldPermissions } })),
  }
}

describe('resolveFieldAccessAtNodes — Lock-7B `required` (OD-L7B-1/OD-L7B-10, G-2/G-3/G-4)', () => {
  // ── G-2/G-3 — `required` resolves to EXACTLY `'required'`, by MAP-VALUE equality (never
  // `!== 'editable'`, which cannot discriminate `required` from `readonly`/`hidden`) ───────────────
  it('G-2/G-3: a stored graph carrying access:\'required\' resolves to exactly \'required\' via resolveFieldAccessAtNodes', () => {
    const graph = graphWithFourStateMatrix({ n1: [{ fieldId: 'f', access: 'required' }] })
    const map = resolveFieldAccessAtNodes(graph, ['n1'])
    expect(map.get('f')).toBe('required')
    expect(fieldAccessAtNodes(graph, ['n1'], 'f')).toBe('required')
  })

  it('G-3 discriminating negative: the SAME fixture with NO entry for the field resolves to \'editable\' (the absent-key default) — proving the positive fixture exercises the RESOLUTION path, not a vacuous pass', () => {
    const graph = graphWithFourStateMatrix({ n1: [] })
    expect(fieldAccessAtNodes(graph, ['n1'], 'f')).toBe('editable')
  })

  // ── G-1 — `required` × `hidden` is unrepresentable: this module never sees the combination (the
  // dedup guard at publish is the actual gate; this asserts the READ side has no special-case for it
  // because there is nothing to special-case) ────────────────────────────────────────────────────
  it('`required` at one node and `hidden` at a DIFFERENT node are both preserved (OD-L7B-2 — per-node masks, independent)', () => {
    const graph = graphWithFourStateMatrix({
      n1: [{ fieldId: 'f', access: 'required' }],
      n2: [{ fieldId: 'f', access: 'hidden' }],
    })
    expect(fieldAccessAtNodes(graph, ['n1'], 'f')).toBe('required')
    expect(fieldAccessAtNodes(graph, ['n2'], 'f')).toBe('hidden')
  })

  // ── G-4 — rank ordering: hidden ≻ readonly ≻ required ≻ editable; multi-node byte-identity ──────
  it('G-4: rank ordering — hidden beats required beats editable across nodes; required beats editable', () => {
    const hiddenVsRequired = graphWithFourStateMatrix({
      n1: [{ fieldId: 'f', access: 'hidden' }],
      n2: [{ fieldId: 'f', access: 'required' }],
    })
    expect(fieldAccessAtNodes(hiddenVsRequired, ['n1', 'n2'], 'f')).toBe('hidden')

    const requiredVsEditable = graphWithFourStateMatrix({
      n1: [{ fieldId: 'f', access: 'required' }],
      n2: [{ fieldId: 'f', access: 'editable' }],
    })
    expect(fieldAccessAtNodes(requiredVsEditable, ['n1', 'n2'], 'f')).toBe('required')

    const readonlyVsRequired = graphWithFourStateMatrix({
      n1: [{ fieldId: 'f', access: 'readonly' }],
      n2: [{ fieldId: 'f', access: 'required' }],
    })
    expect(fieldAccessAtNodes(readonlyVsRequired, ['n1', 'n2'], 'f')).toBe('readonly')
  })

  it('G-4: `collectHiddenFieldIds` is unaffected by `required` entries — a `required`-only node hides nothing', () => {
    const graph = graphWithFourStateMatrix({ n1: [{ fieldId: 'f', access: 'required' }] })
    expect(collectHiddenFieldIds(graph, ['n1'])).toEqual(new Set())
  })
})
