import { describe, expect, it } from 'vitest'
import {
  buildLinearStepSpine,
  isStepSourceResolvable,
  REQUESTER_SPINE_KEY,
  type LinearStepSpineChip,
} from '../src/approvals/linearStepSpine'
import {
  createEmptyStepDraft,
  insertStepAt,
  isDefaultStepName,
  type ApprovalStepDraft,
} from '../src/approvals/templateAuthoring'

// G-B2-06 — 线性模板流程脊柱 + 步骤间插入. PURE-LOGIC tests only (no .vue mount, no Element Plus),
// mirroring every other approvals/*.ts helper spec in this suite. Covers:
//   1. buildLinearStepSpine: one human-readable summary per sourceKind, an honest placeholder for
//      an unconfigured source, a blank-name step falling back to its positional default label, and
//      the requester chip always leading regardless of step count.
//   2. insertStepAt: middle insertion renumbers only STILL-DEFAULT-named trailing steps, leaves
//      author-renamed steps untouched, and end/empty-array edges behave like append.

function makeStep(overrides: Partial<ApprovalStepDraft> = {}, index = 1): ApprovalStepDraft {
  return { ...createEmptyStepDraft(index), ...overrides }
}

describe('linearStepSpine — buildLinearStepSpine', () => {
  it('leads with the requester chip even when there are no steps', () => {
    const spine = buildLinearStepSpine([])
    expect(spine).toHaveLength(1)
    expect(spine[0]).toMatchObject({
      key: REQUESTER_SPINE_KEY,
      role: 'requester',
      label: '发起人',
      sourceSummary: '',
      resolvable: true,
      stepIndex: null,
    })
  })

  it('leads with the requester chip regardless of how many steps follow', () => {
    const steps = [makeStep({}, 1), makeStep({}, 2), makeStep({}, 3)]
    const spine = buildLinearStepSpine(steps)
    expect(spine[0].role).toBe('requester')
    expect(spine).toHaveLength(4)
    expect(spine.slice(1).every((chip) => chip.role === 'step')).toBe(true)
  })

  it('gives every sourceKind its human-readable summary, matching assigneeSourceSummary wording', () => {
    const cases: Array<{ step: Partial<ApprovalStepDraft>; expected: string }> = [
      { step: { sourceKind: 'static_user', idsText: 'u1, u2' }, expected: '指定用户：u1、u2' },
      { step: { sourceKind: 'static_role', idsText: 'mgr' }, expected: '指定角色：mgr' },
      { step: { sourceKind: 'requester' }, expected: '发起人' },
      { step: { sourceKind: 'direct_manager' }, expected: '直属上级' },
      { step: { sourceKind: 'dept_head' }, expected: '部门主管' },
      { step: { sourceKind: 'continuous_managers', levels: 3 }, expected: '连续多级上级（3 级）' },
      { step: { sourceKind: 'manager_at_level', level: 2 }, expected: '指定层级上级（第 2 级）' },
      { step: { sourceKind: 'form_field_user', fieldId: 'applicant' }, expected: '表单用户字段：applicant' },
    ]
    for (const { step, expected } of cases) {
      const [, chip] = buildLinearStepSpine([makeStep(step)])
      expect(chip.sourceSummary).toBe(expected)
      expect(chip.resolvable).toBe(true)
    }
  })

  it('marks an unconfigured static_user/static_role source unresolvable with the shared （无） placeholder', () => {
    const [, userChip] = buildLinearStepSpine([makeStep({ sourceKind: 'static_user', idsText: '' })])
    expect(userChip.resolvable).toBe(false)
    expect(userChip.sourceSummary).toBe('指定用户：（无）')

    const [, roleChip] = buildLinearStepSpine([makeStep({ sourceKind: 'static_role', idsText: '   ' })])
    expect(roleChip.resolvable).toBe(false)
    expect(roleChip.sourceSummary).toBe('指定角色：（无）')
  })

  it('gives form_field_user an honest placeholder when no field is chosen (assigneeSourceSummary itself has none)', () => {
    const [, chip] = buildLinearStepSpine([makeStep({ sourceKind: 'form_field_user', fieldId: '' })])
    expect(chip.resolvable).toBe(false)
    expect(chip.sourceSummary).toBe('表单用户字段：（未选择）')
  })

  it('falls back to the positional default label for a blank step name (空步骤)', () => {
    const steps = [makeStep({ name: '   ' }, 1), makeStep({ name: '' }, 2)]
    const spine = buildLinearStepSpine(steps)
    expect(spine[1].label).toBe('审批人 1')
    expect(spine[2].label).toBe('审批人 2')
  })

  it('uses the author-given name verbatim when present', () => {
    const [, chip] = buildLinearStepSpine([makeStep({ name: '部门经理审批' })])
    expect(chip.label).toBe('部门经理审批')
  })

  it('keys step chips by localId so a caller can scroll/highlight the matching card', () => {
    const step = makeStep({})
    const [, chip] = buildLinearStepSpine([step])
    expect(chip.key).toBe(step.localId)
    expect(chip.stepIndex).toBe(1)
  })
})

describe('linearStepSpine — isStepSourceResolvable', () => {
  it('is false only for the three ids/field-dependent kinds when unset', () => {
    expect(isStepSourceResolvable(makeStep({ sourceKind: 'static_user', idsText: '' }))).toBe(false)
    expect(isStepSourceResolvable(makeStep({ sourceKind: 'static_role', idsText: '' }))).toBe(false)
    expect(isStepSourceResolvable(makeStep({ sourceKind: 'form_field_user', fieldId: '' }))).toBe(false)
    expect(isStepSourceResolvable(makeStep({ sourceKind: 'requester' }))).toBe(true)
    expect(isStepSourceResolvable(makeStep({ sourceKind: 'direct_manager' }))).toBe(true)
    expect(isStepSourceResolvable(makeStep({ sourceKind: 'dept_head' }))).toBe(true)
    expect(isStepSourceResolvable(makeStep({ sourceKind: 'continuous_managers' }))).toBe(true)
    expect(isStepSourceResolvable(makeStep({ sourceKind: 'manager_at_level' }))).toBe(true)
  })
})

describe('templateAuthoring — insertStepAt', () => {
  it('inserts a fresh step right after the given index', () => {
    const steps = [makeStep({ name: '审批人 1' }, 1), makeStep({ name: '审批人 2' }, 2)]
    const next = insertStepAt(steps, 0)
    expect(next).toHaveLength(3)
    expect(next[0].localId).toBe(steps[0].localId)
    expect(next[1].localId).not.toBe(steps[0].localId)
    expect(next[1].localId).not.toBe(steps[1].localId)
    expect(next[2].localId).toBe(steps[1].localId)
  })

  it('renumbers the still-default name of a trailing step so numbering stays self-consistent', () => {
    const steps = [makeStep({ name: '审批人 1' }, 1), makeStep({ name: '审批人 2' }, 2)]
    const next = insertStepAt(steps, 0)
    expect(next.map((s) => s.name)).toEqual(['审批人 1', '审批人 2', '审批人 3'])
  })

  it('never overwrites a step the author has renamed away from the default', () => {
    const steps = [
      makeStep({ name: '审批人 1' }, 1),
      makeStep({ name: '财务复核' }, 2),
      makeStep({ name: '审批人 3' }, 3),
    ]
    const next = insertStepAt(steps, 0)
    // '财务复核' is untouched; '审批人 3' (still-default for its OLD position 3) becomes '审批人 4'.
    expect(next.map((s) => s.name)).toEqual(['审批人 1', '审批人 2', '财务复核', '审批人 4'])
  })

  it('inserting at the last index behaves like an append', () => {
    const steps = [makeStep({ name: '审批人 1' }, 1)]
    const next = insertStepAt(steps, 0)
    expect(next).toHaveLength(2)
    expect(next[1].name).toBe('审批人 2')
  })

  it('inserting into an empty array yields a single fresh step', () => {
    const next = insertStepAt([], 0)
    expect(next).toHaveLength(1)
    expect(next[0].name).toBe('审批人 1')
  })

  it('leaves the config of unrenamed later steps otherwise untouched (only .name may change)', () => {
    const steps = [
      makeStep({ name: '审批人 1' }, 1),
      makeStep({ name: '审批人 2', sourceKind: 'static_role', idsText: 'mgr' }, 2),
    ]
    const next = insertStepAt(steps, 0)
    const renamed = next[2]
    expect(renamed.sourceKind).toBe('static_role')
    expect(renamed.idsText).toBe('mgr')
    expect(renamed.localId).toBe(steps[1].localId)
  })
})

describe('templateAuthoring — isDefaultStepName', () => {
  it('matches only the exact positional default', () => {
    expect(isDefaultStepName('审批人 2', 2)).toBe(true)
    expect(isDefaultStepName(' 审批人 2 ', 2)).toBe(true)
    expect(isDefaultStepName('审批人 2', 3)).toBe(false)
    expect(isDefaultStepName('财务复核', 2)).toBe(false)
    expect(isDefaultStepName('', 2)).toBe(false)
  })
})

// Type-only sanity: LinearStepSpineChip is importable/usable as a value type by view code.
const _typeCheck: LinearStepSpineChip[] = []
void _typeCheck
