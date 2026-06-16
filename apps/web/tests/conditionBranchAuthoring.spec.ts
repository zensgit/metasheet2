import { describe, expect, it } from 'vitest'
import {
  CONDITION_BRANCH_AUTHORABLE_ACTION_TYPES,
  buildConditionBranchConfig,
  conditionBranchUnsupportedReason,
  isConditionBranchAuthorableActionType,
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
    // A6-3-3b never-flatten guard: an EMPTY-config wait is now authorable (see the supported block
    // below), but a wait carrying ANY config key cannot be represented by the zero-param UI and must
    // stay read-only — re-emitted verbatim, NEVER flattened to `config: {}`.
    ['wait_for_callback carrying config keys (reason)', {
      branches: [{ key: 'a', conditions: { conjunction: 'AND', conditions: [] }, actions: [{ type: 'wait_for_callback', config: { reason: 'high-risk' } }] }],
    }],
    ['nested condition_branch inside a branch', {
      branches: [{ key: 'a', conditions: { conjunction: 'AND', conditions: [] }, actions: [{ type: 'condition_branch', config: { branches: [] } }] }],
    }],
    // A6-3-3b keeps these other nested primitives NON-authorable (mirrors the backend validator).
    ['parallel_branch inside a branch', {
      branches: [{ key: 'a', conditions: { conjunction: 'AND', conditions: [] }, actions: [{ type: 'parallel_branch', config: { joinMode: 'all', branches: [] } }] }],
    }],
    ['start_approval inside a branch', {
      branches: [{ key: 'a', conditions: { conjunction: 'AND', conditions: [] }, actions: [{ type: 'start_approval', config: { templateId: 't', formDataMapping: { a: 'b' } } }] }],
    }],
    ['defaultBranch action outside subset', {
      branches: [{ key: 'a', conditions: { conjunction: 'AND', conditions: [] }, actions: [] }],
      defaultBranch: { key: 'd', actions: [{ type: 'send_email', config: {} }] },
    }],
    ['defaultBranch wait_for_callback carrying config keys', {
      branches: [{ key: 'a', conditions: { conjunction: 'AND', conditions: [] }, actions: [] }],
      defaultBranch: { key: 'd', actions: [{ type: 'wait_for_callback', config: { reason: 'x' } }] },
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

// A6-3-3b — the FE half of branch-local wait_for_callback. The seam must author EXACTLY the
// backend-accepted shape (`{ type: 'wait_for_callback', config: {} }`) inside a selected branch,
// keep the other nested primitives non-authorable, and never flatten a richer/unknown wait.
describe('A6-3-3b — branch-local wait_for_callback authoring', () => {
  // The acceptance scenario's high-risk branch: notify → wait_for_callback → update_record, with the
  // wait sitting MID-branch so order preservation (notify, wait, update) is exercised, not assumed.
  const HIGH_RISK = {
    branches: [
      {
        key: 'high',
        conditions: { conjunction: 'AND', conditions: [{ fieldId: 'amount', operator: 'gt', value: '100000' }] },
        actions: [
          { type: 'send_notification', config: { userIds: ['owner1'], message: 'review' } },
          { type: 'wait_for_callback', config: {} },
          { type: 'update_record', config: { fields: { status: 'approved_after_review' } } },
        ],
      },
    ],
    defaultBranch: {
      key: 'low',
      actions: [{ type: 'update_record', config: { fields: { status: 'auto_approved' } } }],
    },
  }

  it('treats an empty-config branch-local wait as supported (editable, not read-only)', () => {
    expect(conditionBranchUnsupportedReason(HIGH_RISK)).toBeNull()
  })

  it('round-trips a mid-branch wait losslessly (build∘parse = identity, order preserved)', () => {
    const built = buildConditionBranchConfig(parseConditionBranchDraft(HIGH_RISK))
    // Exact equality proves the backend-accepted wait shape AND that notify/wait/update order survives.
    expect(built).toEqual(HIGH_RISK)
    const actions = (built as any).branches[0].actions
    expect(actions.map((a: any) => a.type)).toEqual(['send_notification', 'wait_for_callback', 'update_record'])
    // The emitted wait is the zero-param shape the backend validator + executor accept.
    expect(actions[1]).toEqual({ type: 'wait_for_callback', config: {} })
  })

  it('emits the exact backend-accepted wait config from a freshly drafted wait action', () => {
    // A wait draft authored fresh in the UI carries no fields → serializes to `config: {}` (not undefined).
    const draft = { branches: [{ key: 'b', label: '', conjunction: 'AND' as const, conditions: [], actions: [{ type: 'wait_for_callback' as const }] }], defaultBranch: null }
    const built = buildConditionBranchConfig(draft) as any
    expect(built.branches[0].actions).toEqual([{ type: 'wait_for_callback', config: {} }])
  })

  it('allows a branch-local wait in the defaultBranch too (validator accepts it there)', () => {
    const cfg = {
      branches: [{ key: 'a', conditions: { conjunction: 'AND', conditions: [] }, actions: [] }],
      defaultBranch: { key: 'd', actions: [{ type: 'wait_for_callback', config: {} }] },
    }
    expect(conditionBranchUnsupportedReason(cfg)).toBeNull()
    expect(buildConditionBranchConfig(parseConditionBranchDraft(cfg))).toEqual(cfg)
  })

  it('NEVER flattens a wait carrying config keys — it stays read-only (anti-drift keystone)', () => {
    const rich = {
      branches: [{ key: 'a', conditions: { conjunction: 'AND', conditions: [] }, actions: [{ type: 'wait_for_callback', config: { reason: 'high-risk', resumeToken: 'tok' } }] }],
    }
    // The richer wait is flagged read-only (so the editor preserves the original verbatim, never
    // round-trips it through parse→build, which WOULD drop `reason`/`resumeToken`).
    expect(conditionBranchUnsupportedReason(rich)).not.toBeNull()
  })

  it('keeps nested condition_branch / parallel_branch / start_approval NON-authorable inside a branch', () => {
    for (const type of ['condition_branch', 'parallel_branch', 'start_approval'] as const) {
      const cfg = { branches: [{ key: 'a', conditions: { conjunction: 'AND', conditions: [] }, actions: [{ type, config: {} }] }] }
      expect(conditionBranchUnsupportedReason(cfg)).not.toBeNull()
    }
  })

  it('exposes wait_for_callback in the condition-branch action set but excludes the nested primitives', () => {
    expect(CONDITION_BRANCH_AUTHORABLE_ACTION_TYPES).toContain('wait_for_callback')
    expect(CONDITION_BRANCH_AUTHORABLE_ACTION_TYPES).toContain('update_record')
    expect(CONDITION_BRANCH_AUTHORABLE_ACTION_TYPES).toContain('send_notification')
    expect(CONDITION_BRANCH_AUTHORABLE_ACTION_TYPES as readonly string[]).not.toContain('condition_branch')
    expect(CONDITION_BRANCH_AUTHORABLE_ACTION_TYPES as readonly string[]).not.toContain('parallel_branch')
    expect(CONDITION_BRANCH_AUTHORABLE_ACTION_TYPES as readonly string[]).not.toContain('start_approval')
    expect(isConditionBranchAuthorableActionType('wait_for_callback')).toBe(true)
    expect(isConditionBranchAuthorableActionType('condition_branch')).toBe(false)
    expect(isConditionBranchAuthorableActionType('parallel_branch')).toBe(false)
  })
})
