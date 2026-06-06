import { describe, expect, it } from 'vitest'
import {
  buildConditionBranchConfig,
  conditionBranchUnsupportedReason,
  parseConditionBranchDraft,
  validateConditionBranchKeys,
} from '../src/multitable/utils/conditionBranchAuthoring'

// A supported (v1-editable) condition_branch config: flat conditions, simple-subset actions.
const SUPPORTED = {
  branches: [
    {
      key: 'vip',
      label: 'VIP tier',
      conditions: { conjunction: 'AND', conditions: [{ fieldId: 'tier', operator: 'equals', value: 'vip' }] },
      actions: [{ type: 'update_record', config: { fields: { status: 'done', note: 'vip' } } }],
    },
    {
      key: 'bulk',
      conditions: {
        conjunction: 'OR',
        conditions: [
          { fieldId: 'qty', operator: 'gt', value: '100' },
          { fieldId: 'flag', operator: 'is_empty' },
        ],
      },
      actions: [{ type: 'send_notification', config: { userIds: ['u1', 'u2'], message: 'bulk' } }],
    },
  ],
  defaultBranch: {
    key: 'fallback',
    actions: [{ type: 'update_record', config: { fields: { status: 'review' } } }],
  },
}

describe('conditionBranchAuthoring — round-trip invariant (build∘parse = identity for supported)', () => {
  it('round-trips a multi-branch + defaultBranch config losslessly', () => {
    const draft = parseConditionBranchDraft(SUPPORTED)
    expect(buildConditionBranchConfig(draft)).toEqual(SUPPORTED)
  })

  it('round-trips a minimal single-branch config', () => {
    const cfg = {
      branches: [{ key: 'a', conditions: { conjunction: 'AND', conditions: [] }, actions: [] }],
    }
    expect(buildConditionBranchConfig(parseConditionBranchDraft(cfg))).toEqual(cfg)
  })

  it('parses logic-form conjunction (semantic) and canonicalizes to conjunction on build', () => {
    const cfg = {
      branches: [{ key: 'a', conditions: { logic: 'or', conditions: [{ fieldId: 'x', operator: 'equals', value: '1' }] }, actions: [] }],
    }
    expect(conditionBranchUnsupportedReason(cfg)).toBeNull() // semantically representable
    const built = buildConditionBranchConfig(parseConditionBranchDraft(cfg)) as any
    expect(built.branches[0].conditions.conjunction).toBe('OR') // canonical form, meaning preserved
  })
})

describe('conditionBranchUnsupportedReason — read-only guard (point #3: never flatten)', () => {
  it('returns null for a supported config', () => {
    expect(conditionBranchUnsupportedReason(SUPPORTED)).toBeNull()
  })
  it('returns null for an empty / brand-new action config', () => {
    expect(conditionBranchUnsupportedReason({})).toBeNull()
    expect(conditionBranchUnsupportedReason(undefined)).toBeNull()
  })

  const unsupported: Array<[string, unknown]> = [
    ['nested condition group', {
      branches: [{ key: 'a', conditions: { conjunction: 'AND', conditions: [{ conjunction: 'OR', conditions: [{ fieldId: 'x', operator: 'equals', value: '1' }] }] }, actions: [] }],
    }],
    ['non-string update_record value (number)', {
      branches: [{ key: 'a', conditions: { conjunction: 'AND', conditions: [] }, actions: [{ type: 'update_record', config: { fields: { amount: 5 } } }] }],
    }],
    ['update_record extra config key', {
      branches: [{ key: 'a', conditions: { conjunction: 'AND', conditions: [] }, actions: [{ type: 'update_record', config: { fields: {}, sheetId: 's' } }] }],
    }],
    ['comma-bearing userId', {
      branches: [{ key: 'a', conditions: { conjunction: 'AND', conditions: [] }, actions: [{ type: 'send_notification', config: { userIds: ['a,b'], message: 'm' } }] }],
    }],
    ['action type outside subset (create_record)', {
      branches: [{ key: 'a', conditions: { conjunction: 'AND', conditions: [] }, actions: [{ type: 'create_record', config: { sheetId: 's', data: {} } }] }],
    }],
    ['wait_for_callback inside a branch', {
      branches: [{ key: 'a', conditions: { conjunction: 'AND', conditions: [] }, actions: [{ type: 'wait_for_callback', config: {} }] }],
    }],
    ['nested condition_branch inside a branch', {
      branches: [{ key: 'a', conditions: { conjunction: 'AND', conditions: [] }, actions: [{ type: 'condition_branch', config: { branches: [] } }] }],
    }],
    ['defaultBranch action outside subset', {
      branches: [{ key: 'a', conditions: { conjunction: 'AND', conditions: [] }, actions: [] }],
      defaultBranch: { key: 'd', actions: [{ type: 'send_email', config: {} }] },
    }],
    ['branches not an array', { branches: 'nope' }],
  ]
  it.each(unsupported)('flags %s as read-only', (_label, config) => {
    expect(conditionBranchUnsupportedReason(config)).not.toBeNull()
  })
})

describe('validateConditionBranchKeys — frontend mirror of backend (point #1)', () => {
  const make = (branches: Array<{ key: string }>, def?: { key: string }) =>
    ({
      branches: branches.map((b) => ({ key: b.key, label: '', conjunction: 'AND' as const, conditions: [], actions: [] })),
      defaultBranch: def ? { key: def.key, label: '', actions: [] } : null,
    })

  it('accepts safe, non-empty, unique keys', () => {
    expect(validateConditionBranchKeys(make([{ key: 'a' }, { key: 'b' }], { key: 'def' }))).toBeNull()
  })
  it('rejects empty branch list', () => {
    expect(validateConditionBranchKeys(make([]))).toContain('at least one')
  })
  it('rejects an unsafe key (whitespace)', () => {
    expect(validateConditionBranchKeys(make([{ key: 'bad key' }]))).toContain('A-Za-z0-9_-')
  })
  it('rejects an empty key', () => {
    expect(validateConditionBranchKeys(make([{ key: '' }]))).not.toBeNull()
  })
  it('rejects a >64-char key', () => {
    expect(validateConditionBranchKeys(make([{ key: 'x'.repeat(65) }]))).not.toBeNull()
  })
  it('rejects duplicate branch keys', () => {
    expect(validateConditionBranchKeys(make([{ key: 'a' }, { key: 'a' }]))).toContain('unique')
  })
  it('rejects a defaultBranch key colliding with a branch key', () => {
    expect(validateConditionBranchKeys(make([{ key: 'a' }], { key: 'a' }))).toContain('unique')
  })
})
