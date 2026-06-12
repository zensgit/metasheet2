import { describe, expect, it } from 'vitest'
import {
  buildParallelBranchConfig,
  parallelBranchUnsupportedReason,
  parseParallelBranchDraft,
  validateParallelBranchActions,
  validateParallelBranchKeys,
} from '../src/multitable/utils/parallelBranchAuthoring'

const SUPPORTED = {
  joinMode: 'all',
  branches: [
    {
      key: 'ops',
      label: 'Ops',
      actions: [{ type: 'update_record', config: { fields: { status: 'ops' } } }],
    },
    {
      key: 'notify',
      actions: [{ type: 'send_notification', config: { userIds: ['u1', 'u2'], message: 'ready' } }],
    },
  ],
}

describe('parallelBranchAuthoring — round-trip invariant', () => {
  it('round-trips a supported join_all parallel_branch config losslessly', () => {
    expect(buildParallelBranchConfig(parseParallelBranchDraft(SUPPORTED))).toEqual(SUPPORTED)
  })

  it('always builds joinMode all from the editable draft', () => {
    const built = buildParallelBranchConfig(parseParallelBranchDraft({ branches: SUPPORTED.branches }))
    expect(built.joinMode).toBe('all')
  })
})

describe('parallelBranchUnsupportedReason — read-only guard', () => {
  it('returns null for supported and empty fresh configs', () => {
    expect(parallelBranchUnsupportedReason(SUPPORTED)).toBeNull()
    expect(parallelBranchUnsupportedReason({})).toBeNull()
    expect(parallelBranchUnsupportedReason(undefined)).toBeNull()
  })

  const unsupported: Array<[string, unknown]> = [
    ['joinMode any', { joinMode: 'any', branches: SUPPORTED.branches }],
    ['top-level extra key', { ...SUPPORTED, mode: 'future' }],
    ['branch extra key', { joinMode: 'all', branches: [{ ...SUPPORTED.branches[0], condition: {} }] }],
    ['action extra key', { joinMode: 'all', branches: [{ key: 'a', actions: [{ type: 'update_record', config: { fields: { status: 'done' } }, metadata: { future: true } }] }] }],
    ['empty branch actions', { joinMode: 'all', branches: [{ key: 'a', actions: [] }] }],
    ['non-string update value', { joinMode: 'all', branches: [{ key: 'a', actions: [{ type: 'update_record', config: { fields: { qty: 5 } } }] }] }],
    ['comma-bearing user id', { joinMode: 'all', branches: [{ key: 'a', actions: [{ type: 'send_notification', config: { userIds: ['a,b'], message: 'm' } }] }] }],
    ['nested wait', { joinMode: 'all', branches: [{ key: 'a', actions: [{ type: 'wait_for_callback', config: {} }] }] }],
    ['nested parallel', { joinMode: 'all', branches: [{ key: 'a', actions: [{ type: 'parallel_branch', config: { joinMode: 'all', branches: [] } }] }] }],
  ]

  it.each(unsupported)('flags %s as read-only', (_label, config) => {
    expect(parallelBranchUnsupportedReason(config)).not.toBeNull()
  })
})

describe('validateParallelBranchActions — executable nested actions', () => {
  it('rejects update_record branches without a field update', () => {
    expect(validateParallelBranchActions({
      branches: [{ key: 'a', label: '', actions: [{ type: 'update_record', fieldUpdates: [] }] }],
    })).toContain('at least one field')
    expect(validateParallelBranchActions({
      branches: [{ key: 'a', label: '', actions: [{ type: 'update_record', fieldUpdates: [{ fieldId: '', value: 'done' }] }] }],
    })).toContain('at least one field')
  })

  it('rejects send_notification branches without recipients or message', () => {
    expect(validateParallelBranchActions({
      branches: [{ key: 'notify', label: '', actions: [{ type: 'send_notification', userId: '', message: 'ready' }] }],
    })).toContain('at least one user')
    expect(validateParallelBranchActions({
      branches: [{ key: 'notify', label: '', actions: [{ type: 'send_notification', userId: 'u1', message: ' ' }] }],
    })).toContain('message')
  })

  it('accepts executable update_record and send_notification branch actions', () => {
    expect(validateParallelBranchActions({
      branches: [
        { key: 'a', label: '', actions: [{ type: 'update_record', fieldUpdates: [{ fieldId: 'status', value: 'done' }] }] },
        { key: 'notify', label: '', actions: [{ type: 'send_notification', userId: 'u1, u2', message: 'ready' }] },
      ],
    })).toBeNull()
  })
})

describe('validateParallelBranchKeys — frontend mirror of backend bounds', () => {
  const make = (branches: Array<{ key: string; actions?: unknown[] }>) => ({
    branches: branches.map((branch) => ({
      key: branch.key,
      label: '',
      actions: (branch.actions ?? [{}]) as never[],
    })),
  })

  it('accepts safe, non-empty, unique keys', () => {
    expect(validateParallelBranchKeys(make([{ key: 'a' }, { key: 'b' }]))).toBeNull()
  })

  it('rejects empty branch list', () => {
    expect(validateParallelBranchKeys(make([]))).toContain('at least one')
  })

  it('rejects unsafe and duplicate keys', () => {
    expect(validateParallelBranchKeys(make([{ key: 'bad key' }]))).toContain('A-Za-z0-9_-')
    expect(validateParallelBranchKeys(make([{ key: 'a' }, { key: 'a' }]))).toContain('unique')
  })

  it('rejects a branch without actions and a config with too many actions', () => {
    expect(validateParallelBranchKeys(make([{ key: 'a', actions: [] }]))).toContain('at least one action')
    expect(validateParallelBranchKeys(make([{ key: 'a', actions: Array.from({ length: 21 }, () => ({})) }]))).toContain('at most 20')
  })
})
