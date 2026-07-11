import { describe, expect, it } from 'vitest'

import {
  computeSaveBlockReasons,
  type SaveBlockActionSnapshot,
  type SaveBlockReasonsInput,
} from '../src/multitable/automationSaveBlockReasons'

// ---------------------------------------------------------------------------
// Independent oracle — a second, hand-transcribed copy of the ORIGINAL
// MetaAutomationRuleEditor.vue `canSave` boolean chain (as it read before G-B2-22),
// re-expressed over the same snapshot type. This is deliberately NOT derived from
// computeSaveBlockReasons: its only job is to catch a transcription bug that the
// aggregator and the "reasons" list could otherwise share silently. Every test below
// asserts `computeSaveBlockReasons(input).length === 0` agrees with `originalCanSave(input)`.
// ---------------------------------------------------------------------------
function originalCanSave(input: SaveBlockReasonsInput): boolean {
  if (!input.name.trim()) return false
  if (input.actionsCount < 1) return false
  if (input.triggerType === 'approval.completed' && input.approvalCompletedBlockReason) return false
  if (input.triggerType === 'approval.task_created' && input.approvalTaskCreatedBlockReason) return false
  if (input.triggerType === 'webhook.received') {
    if (!input.webhookSecretPresent && !(input.ruleHasId && input.savedWebhookSecretConfigured)) return false
  }
  if (input.conditionBranchReadOnlyReason) return false
  if (input.conditionBranchKeyError) return false
  if (input.parallelBranchReadOnlyReason) return false
  if (input.parallelBranchKeyError) return false
  if (input.parallelBranchActionError) return false
  if (!input.conditionsComplete) return false
  for (const action of input.actions) {
    if (action.groupMessage) {
      const m = action.groupMessage
      if ((m.destinationIdCount === 0 && m.destinationFieldPathCount === 0) || !m.titleTemplate.trim() || !m.bodyTemplate.trim()) return false
      if (m.publicFormBlockingErrorCount > 0) return false
      if (m.internalViewBlockingErrorCount > 0) return false
    }
    if (action.personMessage) {
      const m = action.personMessage
      if (
        (m.userIdCount === 0 && m.memberGroupIdCount === 0 && m.recipientFieldPathCount === 0 && m.memberGroupRecipientFieldPathCount === 0)
        || !m.titleTemplate.trim()
        || !m.bodyTemplate.trim()
      ) return false
      if (m.publicFormBlockingErrorCount > 0) return false
      if (m.internalViewBlockingErrorCount > 0) return false
    }
    if (action.email) {
      const m = action.email
      if (m.recipientCount === 0 || !m.subjectTemplate.trim() || !m.bodyTemplate.trim()) return false
    }
    if (action.deleteRecord && !action.deleteRecord.acknowledged) return false
  }
  return true
}

function baseInput(): SaveBlockReasonsInput {
  return {
    isZh: false,
    name: 'My rule',
    actionsCount: 1,
    triggerType: 'record.created',
    approvalCompletedBlockReason: '',
    approvalTaskCreatedBlockReason: '',
    webhookSecretPresent: false,
    ruleHasId: false,
    savedWebhookSecretConfigured: false,
    conditionBranchReadOnlyReason: null,
    conditionBranchKeyError: null,
    parallelBranchReadOnlyReason: null,
    parallelBranchKeyError: null,
    parallelBranchActionError: null,
    conditionsComplete: true,
    firstIncompleteConditionAnchor: undefined,
    actions: [{ index: 0, type: 'update_record' }],
  }
}

function validGroupMessageAction(index = 0): SaveBlockActionSnapshot {
  return {
    index,
    type: 'send_dingtalk_group_message',
    groupMessage: {
      destinationIdCount: 1,
      destinationFieldPathCount: 0,
      titleTemplate: 'Title',
      bodyTemplate: 'Body',
      publicFormBlockingErrorCount: 0,
      internalViewBlockingErrorCount: 0,
    },
  }
}

function validPersonMessageAction(index = 0): SaveBlockActionSnapshot {
  return {
    index,
    type: 'send_dingtalk_person_message',
    personMessage: {
      userIdCount: 1,
      memberGroupIdCount: 0,
      recipientFieldPathCount: 0,
      memberGroupRecipientFieldPathCount: 0,
      titleTemplate: 'Title',
      bodyTemplate: 'Body',
      publicFormBlockingErrorCount: 0,
      internalViewBlockingErrorCount: 0,
    },
  }
}

function validEmailAction(index = 0): SaveBlockActionSnapshot {
  return {
    index,
    type: 'send_email',
    email: { recipientCount: 1, subjectTemplate: 'Subject', bodyTemplate: 'Body' },
  }
}

function validDeleteRecordAction(index = 0): SaveBlockActionSnapshot {
  return { index, type: 'delete_record', deleteRecord: { acknowledged: true } }
}

/** Asserts a single input against both implementations and returns the reasons for further checks. */
function expectBlocked(input: SaveBlockReasonsInput, expectedKey: string) {
  const reasons = computeSaveBlockReasons(input)
  expect(reasons.some((r) => r.key === expectedKey), JSON.stringify(reasons)).toBe(true)
  expect(originalCanSave(input)).toBe(false)
  expect(reasons.length === 0).toBe(originalCanSave(input))
  return reasons
}

function expectSaveable(input: SaveBlockReasonsInput) {
  const reasons = computeSaveBlockReasons(input)
  expect(reasons, JSON.stringify(reasons)).toEqual([])
  expect(originalCanSave(input)).toBe(true)
  expect(reasons.length === 0).toBe(originalCanSave(input))
}

describe('automationSaveBlockReasons', () => {
  it('reports no reasons (and canSave true) when every guard is satisfied', () => {
    expectSaveable(baseInput())
  })

  it('blocks on an empty rule name', () => {
    const input = { ...baseInput(), name: '   ' }
    const reasons = expectBlocked(input, 'name')
    expect(reasons.find((r) => r.key === 'name')?.anchor).toBe('[data-field="name"]')
  })

  it('blocks when there are no actions', () => {
    const input = { ...baseInput(), actionsCount: 0, actions: [] }
    const reasons = expectBlocked(input, 'actionsEmpty')
    expect(reasons.find((r) => r.key === 'actionsEmpty')?.anchor).toBe('[data-action="add-action"]')
  })

  it('blocks approval.completed triggers with an unmet trigger-level requirement', () => {
    const input: SaveBlockReasonsInput = {
      ...baseInput(),
      triggerType: 'approval.completed',
      approvalCompletedBlockReason: 'Select an approval template.',
    }
    const reasons = expectBlocked(input, 'approvalCompletedBlockReason')
    expect(reasons.find((r) => r.key === 'approvalCompletedBlockReason')?.message).toBe('Select an approval template.')
  })

  it('ignores a stale approvalCompletedBlockReason when the trigger type has moved on', () => {
    // Guards against a regression where the reason-string guard alone (without the triggerType
    // re-check) would wrongly re-block a rule that switched away from approval.completed.
    const input: SaveBlockReasonsInput = {
      ...baseInput(),
      triggerType: 'record.created',
      approvalCompletedBlockReason: 'Select an approval template.',
    }
    expectSaveable(input)
  })

  it('blocks approval.task_created triggers with an unmet trigger-level requirement', () => {
    const input: SaveBlockReasonsInput = {
      ...baseInput(),
      triggerType: 'approval.task_created',
      approvalTaskCreatedBlockReason: 'Remove all conditions.',
    }
    expectBlocked(input, 'approvalTaskCreatedBlockReason')
  })

  it('blocks a webhook trigger with no secret typed and no stored secret to keep', () => {
    const input: SaveBlockReasonsInput = {
      ...baseInput(),
      triggerType: 'webhook.received',
      webhookSecretPresent: false,
      ruleHasId: false,
      savedWebhookSecretConfigured: false,
    }
    expectBlocked(input, 'webhookSecret')
  })

  it('allows a webhook trigger with a blank secret when an existing rule keeps its stored secret', () => {
    const input: SaveBlockReasonsInput = {
      ...baseInput(),
      triggerType: 'webhook.received',
      webhookSecretPresent: false,
      ruleHasId: true,
      savedWebhookSecretConfigured: true,
    }
    expectSaveable(input)
  })

  it('blocks a non-round-trippable loaded condition_branch', () => {
    const input: SaveBlockReasonsInput = { ...baseInput(), conditionBranchReadOnlyReason: 'Unsupported branch shape.' }
    expectBlocked(input, 'conditionBranchReadOnly')
  })

  it('blocks an unsafe/duplicate condition_branch key', () => {
    const input: SaveBlockReasonsInput = { ...baseInput(), conditionBranchKeyError: 'Duplicate branch key.' }
    expectBlocked(input, 'conditionBranchKeyError')
  })

  it('blocks a non-round-trippable loaded parallel_branch', () => {
    const input: SaveBlockReasonsInput = { ...baseInput(), parallelBranchReadOnlyReason: 'Unsupported join shape.' }
    expectBlocked(input, 'parallelBranchReadOnly')
  })

  it('blocks an unsafe/duplicate parallel_branch key', () => {
    const input: SaveBlockReasonsInput = { ...baseInput(), parallelBranchKeyError: 'Duplicate branch key.' }
    expectBlocked(input, 'parallelBranchKeyError')
  })

  it('blocks a parallel_branch with a non-executable nested action', () => {
    const input: SaveBlockReasonsInput = { ...baseInput(), parallelBranchActionError: 'Nested action cannot run.' }
    expectBlocked(input, 'parallelBranchActionError')
  })

  it('blocks incomplete filter conditions and passes through the first-incomplete anchor', () => {
    const input: SaveBlockReasonsInput = {
      ...baseInput(),
      conditionsComplete: false,
      firstIncompleteConditionAnchor: '[data-condition-path="0"]',
    }
    const reasons = expectBlocked(input, 'conditionsIncomplete')
    expect(reasons.find((r) => r.key === 'conditionsIncomplete')?.anchor).toBe('[data-condition-path="0"]')
  })

  it('never fabricates an anchor for incomplete conditions when one cannot be identified', () => {
    const input: SaveBlockReasonsInput = {
      ...baseInput(),
      conditionsComplete: false,
      firstIncompleteConditionAnchor: undefined,
    }
    const reasons = expectBlocked(input, 'conditionsIncomplete')
    expect(reasons.find((r) => r.key === 'conditionsIncomplete')?.anchor).toBeUndefined()
  })

  it('passes with a fully-configured group-message action', () => {
    expectSaveable({ ...baseInput(), actionsCount: 1, actions: [validGroupMessageAction()] })
  })

  it('blocks a group-message action with no destination', () => {
    const action = validGroupMessageAction()
    action.groupMessage!.destinationIdCount = 0
    action.groupMessage!.destinationFieldPathCount = 0
    const reasons = expectBlocked({ ...baseInput(), actions: [action] }, 'action-0-destination')
    expect(reasons.find((r) => r.key === 'action-0-destination')?.anchor).toBe('[data-action-index="0"] [data-field="dingtalkDestinationPickerId"]')
  })

  it('blocks a group-message action with a blank title template', () => {
    const action = validGroupMessageAction()
    action.groupMessage!.titleTemplate = '   '
    expectBlocked({ ...baseInput(), actions: [action] }, 'action-0-title')
  })

  it('blocks a group-message action with a blank body template', () => {
    const action = validGroupMessageAction()
    action.groupMessage!.bodyTemplate = ''
    expectBlocked({ ...baseInput(), actions: [action] }, 'action-0-body')
  })

  it('blocks a group-message action whose public-form link has blocking errors', () => {
    const action = validGroupMessageAction()
    action.groupMessage!.publicFormBlockingErrorCount = 2
    expectBlocked({ ...baseInput(), actions: [action] }, 'action-0-publicFormLink')
  })

  it('blocks a group-message action whose internal-view link has blocking errors', () => {
    const action = validGroupMessageAction()
    action.groupMessage!.internalViewBlockingErrorCount = 1
    expectBlocked({ ...baseInput(), actions: [action] }, 'action-0-internalViewLink')
  })

  it('passes with a fully-configured person-message action', () => {
    expectSaveable({ ...baseInput(), actions: [validPersonMessageAction()] })
  })

  it('blocks a person-message action with no recipient of any kind', () => {
    const action = validPersonMessageAction()
    action.personMessage!.userIdCount = 0
    const reasons = expectBlocked({ ...baseInput(), actions: [action] }, 'action-0-destination')
    expect(reasons.find((r) => r.key === 'action-0-destination')?.anchor).toBe('[data-action-index="0"] [data-field="dingtalkPersonUserIds"]')
  })

  it('blocks a person-message action with a blank title template', () => {
    const action = validPersonMessageAction()
    action.personMessage!.titleTemplate = ''
    expectBlocked({ ...baseInput(), actions: [action] }, 'action-0-title')
  })

  it('blocks a person-message action with a blank body template', () => {
    const action = validPersonMessageAction()
    action.personMessage!.bodyTemplate = '  '
    expectBlocked({ ...baseInput(), actions: [action] }, 'action-0-body')
  })

  it('blocks a person-message action whose public-form link has blocking errors', () => {
    const action = validPersonMessageAction()
    action.personMessage!.publicFormBlockingErrorCount = 1
    expectBlocked({ ...baseInput(), actions: [action] }, 'action-0-publicFormLink')
  })

  it('blocks a person-message action whose internal-view link has blocking errors', () => {
    const action = validPersonMessageAction()
    action.personMessage!.internalViewBlockingErrorCount = 1
    expectBlocked({ ...baseInput(), actions: [action] }, 'action-0-internalViewLink')
  })

  it('passes with a fully-configured email action', () => {
    expectSaveable({ ...baseInput(), actions: [validEmailAction()] })
  })

  it('blocks an email action with no recipients', () => {
    const action = validEmailAction()
    action.email!.recipientCount = 0
    const reasons = expectBlocked({ ...baseInput(), actions: [action] }, 'action-0-recipients')
    expect(reasons.find((r) => r.key === 'action-0-recipients')?.anchor).toBe('[data-action-index="0"] [data-field="emailRecipients"]')
  })

  it('blocks an email action with a blank subject template', () => {
    const action = validEmailAction()
    action.email!.subjectTemplate = ''
    expectBlocked({ ...baseInput(), actions: [action] }, 'action-0-subject')
  })

  it('blocks an email action with a blank body template', () => {
    const action = validEmailAction()
    action.email!.bodyTemplate = '   '
    expectBlocked({ ...baseInput(), actions: [action] }, 'action-0-body')
  })

  it('passes with an acknowledged delete_record action', () => {
    expectSaveable({ ...baseInput(), actions: [validDeleteRecordAction()] })
  })

  it('blocks an unacknowledged delete_record action', () => {
    const action = validDeleteRecordAction()
    action.deleteRecord!.acknowledged = false
    const reasons = expectBlocked({ ...baseInput(), actions: [action] }, 'action-0-deleteAck')
    expect(reasons.find((r) => r.key === 'action-0-deleteAck')?.anchor).toBe('[data-action-index="0"] [data-field="deleteRecordAck"]')
  })

  it('scopes per-action anchors to the failing action index among several actions', () => {
    const good = validEmailAction(0)
    const bad = validGroupMessageAction(1)
    bad.groupMessage!.titleTemplate = ''
    const reasons = computeSaveBlockReasons({ ...baseInput(), actionsCount: 2, actions: [good, bad] })
    expect(reasons).toHaveLength(1)
    expect(reasons[0].key).toBe('action-1-title')
    expect(reasons[0].anchor).toBe('[data-action-index="1"] [data-field="dingtalkTitleTemplate"]')
  })

  it('aggregates multiple simultaneous failures without losing any of them', () => {
    const input: SaveBlockReasonsInput = {
      ...baseInput(),
      name: '',
      conditionBranchKeyError: 'Duplicate key.',
      actions: [],
      actionsCount: 0,
    }
    const reasons = computeSaveBlockReasons(input)
    const keys = reasons.map((r) => r.key)
    expect(keys).toEqual(expect.arrayContaining(['name', 'actionsEmpty', 'conditionBranchKeyError']))
    expect(originalCanSave(input)).toBe(false)
    expect(reasons.length === 0).toBe(originalCanSave(input))
  })

  it('produces localized (zh) messages when isZh is true', () => {
    const input = { ...baseInput(), name: '' , isZh: true }
    const reasons = computeSaveBlockReasons(input)
    expect(reasons[0].message).toBe('请填写规则名称。')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Exhaustive top-level guard harness (added on adversarial review).
//
// The hand-written cases above left FOUR top-level guards neuterable: you could
// delete a conjunct and every one of them stayed green. One of those was reachable
// in production — dropping `savedWebhookSecretConfigured` from the webhook guard
// would let "edit an existing non-webhook rule → switch trigger to webhook.received
// → leave the secret blank → save" through, persisting a webhook rule with no secret.
//
// Rather than bolt on five more fixtures (which only pins the holes we happened to
// notice), this walks the full cartesian product of every top-level guard input and
// asserts the exact reason-key SET for each of the 32,768 combinations. Any guard
// that is removed, or has a conjunct dropped, changes some combination's key set and
// turns this red. `expectedKeys` is transcribed independently from the guard
// semantics, so it does not move when the implementation does.
// ─────────────────────────────────────────────────────────────────────────────
describe('computeSaveBlockReasons — exhaustive top-level guard coverage', () => {
  const BLOCK_MSG = 'blocked'

  function expectedTopLevelKeys(i: SaveBlockReasonsInput): string[] {
    const keys: string[] = []
    if (!i.name.trim()) keys.push('name')
    if (i.actionsCount < 1) keys.push('actionsEmpty')
    if (i.triggerType === 'approval.completed' && i.approvalCompletedBlockReason) keys.push('approvalCompletedBlockReason')
    if (i.triggerType === 'approval.task_created' && i.approvalTaskCreatedBlockReason) keys.push('approvalTaskCreatedBlockReason')
    if (i.triggerType === 'webhook.received' && !i.webhookSecretPresent && !(i.ruleHasId && i.savedWebhookSecretConfigured)) keys.push('webhookSecret')
    if (i.conditionBranchReadOnlyReason) keys.push('conditionBranchReadOnly')
    if (i.conditionBranchKeyError) keys.push('conditionBranchKeyError')
    if (i.parallelBranchReadOnlyReason) keys.push('parallelBranchReadOnly')
    if (i.parallelBranchKeyError) keys.push('parallelBranchKeyError')
    if (i.parallelBranchActionError) keys.push('parallelBranchActionError')
    if (!i.conditionsComplete) keys.push('conditionsIncomplete')
    return keys
  }

  it('pins the reason-key set across the full cartesian product of top-level guards', () => {
    const names = ['', 'My rule']
    const actionCounts = [0, 1]
    const triggers = ['record.created', 'approval.completed', 'approval.task_created', 'webhook.received']
    const bools = [false, true]
    const strs = ['', BLOCK_MSG]
    const nulls = [null, BLOCK_MSG]

    let checked = 0
    let mismatches = 0
    for (const name of names)
    for (const actionsCount of actionCounts)
    for (const triggerType of triggers)
    for (const approvalCompletedBlockReason of strs)
    for (const approvalTaskCreatedBlockReason of strs)
    for (const webhookSecretPresent of bools)
    for (const ruleHasId of bools)
    for (const savedWebhookSecretConfigured of bools)
    for (const conditionBranchReadOnlyReason of nulls)
    for (const conditionBranchKeyError of nulls)
    for (const parallelBranchReadOnlyReason of nulls)
    for (const parallelBranchKeyError of nulls)
    for (const parallelBranchActionError of nulls)
    for (const conditionsComplete of bools) {
      const input: SaveBlockReasonsInput = {
        ...baseInput(),
        name,
        actionsCount,
        triggerType,
        approvalCompletedBlockReason,
        approvalTaskCreatedBlockReason,
        webhookSecretPresent,
        ruleHasId,
        savedWebhookSecretConfigured,
        conditionBranchReadOnlyReason,
        conditionBranchKeyError,
        parallelBranchReadOnlyReason,
        parallelBranchKeyError,
        parallelBranchActionError,
        conditionsComplete,
        actions: [],
      }
      const actual = computeSaveBlockReasons(input).map((r) => r.key)
      const expected = expectedTopLevelKeys(input)
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches += 1
        if (mismatches === 1) {
          expect({ input, actual, expected }).toEqual({ input, actual: expected, expected })
        }
      }
      // canSave is derived from the reason list — the two can never disagree.
      expect(computeSaveBlockReasons(input).length === 0).toBe(originalCanSave({ ...input, actions: [] }))
      checked += 1
    }
    expect(mismatches).toBe(0)
    expect(checked).toBe(32768)
  })

  it('REACHABLE HOLE: an existing rule switched to webhook trigger with no stored secret still blocks', () => {
    // ruleHasId=true but savedWebhookSecretConfigured=false → the `&& savedWebhookSecretConfigured`
    // conjunct is the only thing standing between the user and a secretless webhook rule.
    const input: SaveBlockReasonsInput = {
      ...baseInput(),
      triggerType: 'webhook.received',
      webhookSecretPresent: false,
      ruleHasId: true,
      savedWebhookSecretConfigured: false,
      actions: [],
      actionsCount: 1,
    }
    expect(computeSaveBlockReasons(input).map((r) => r.key)).toContain('webhookSecret')
  })
})
