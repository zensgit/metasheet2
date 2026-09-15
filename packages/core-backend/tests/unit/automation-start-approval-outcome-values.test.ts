/**
 * #5742 — `start_approval.resultWriteback.outcomeValues`: the OPTIONAL declared outcome → written-value
 * mapping for the status field.
 *
 * Before this, a backwrite wrote the raw outcome literal ('approved' / 'rejected' / …) into the status
 * field, so a Chinese single-select had to grow an option literally named `approved` or both the save gate
 * and the fire-time gate rejected it. These cases pin the three seams of the mapping:
 *   1. `resolveWritebackStatusValue` — the pure resolver (mapping wins when non-empty, else the raw outcome,
 *      i.e. byte-identical behaviour for every rule saved before #5742).
 *   2. `resultWritebackFieldTypeError` — the select-option check now validates the RESOLVED value, and the
 *      message names BOTH the outcome and the resolved value.
 *   3. `validateStartApprovalConfig` + `assertResultWritebackFieldsAtSave` — the save gate: mapping shape,
 *      and which outcomes are strict at save time (approved always; rejected when onNonApproved).
 *
 * Pure/mocked: no DB, no HTTP, no supertest. The only outbound seam is a stubbed `queryFn`.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  AutomationService,
  buildResultWritebackPatch,
  resolveWritebackStatusValue,
  resultWritebackFieldTypeError,
  validateStartApprovalConfig,
} from '../../src/multitable/automation-service'
import { EventBus } from '../../src/integration/events/event-bus'

const ZH_APPROVED = '已通过'
const ZH_REJECTED = '已拒绝'

const selectTarget = (options: string[]) => ({
  id: 'fld_status',
  type: 'select',
  property: { options: options.map((value) => ({ value, label: value })) },
})

describe('#5742 resolveWritebackStatusValue', () => {
  it('returns the RAW outcome when no mapping is declared (pre-#5742 behaviour is unchanged)', () => {
    expect(resolveWritebackStatusValue({}, 'approved')).toBe('approved')
    expect(resolveWritebackStatusValue({ statusField: 'fld_status' }, 'rejected')).toBe('rejected')
    // a non-object outcomeValues is ignored, never crashed on (runtime reads persisted JSON)
    expect(resolveWritebackStatusValue({ outcomeValues: 'nope' }, 'approved')).toBe('approved')
    expect(resolveWritebackStatusValue({ outcomeValues: ['approved'] }, 'approved')).toBe('approved')
  })

  it('returns the mapped value (trimmed) for a declared outcome, and the raw outcome for the others', () => {
    const writeback = { statusField: 'fld_status', outcomeValues: { approved: `  ${ZH_APPROVED}  ` } }
    expect(resolveWritebackStatusValue(writeback, 'approved')).toBe(ZH_APPROVED)
    expect(resolveWritebackStatusValue(writeback, 'rejected')).toBe('rejected')
    expect(resolveWritebackStatusValue(writeback, 'revoked')).toBe('revoked')
    expect(resolveWritebackStatusValue(writeback, 'cancelled')).toBe('cancelled')
  })

  it('falls back to the raw outcome for an empty / blank / non-string mapped value', () => {
    expect(resolveWritebackStatusValue({ outcomeValues: { approved: '' } }, 'approved')).toBe('approved')
    expect(resolveWritebackStatusValue({ outcomeValues: { approved: '   ' } }, 'approved')).toBe('approved')
    expect(resolveWritebackStatusValue({ outcomeValues: { approved: 7 } }, 'approved')).toBe('approved')
  })
})

describe('#5742 resultWritebackFieldTypeError select-option check', () => {
  it('accepts a select that contains the MAPPED value (no option named after the raw outcome needed)', () => {
    const writeback = { statusField: 'fld_status', outcomeValues: { approved: ZH_APPROVED } }
    expect(resultWritebackFieldTypeError('statusField', selectTarget(['待审批', ZH_APPROVED, ZH_REJECTED]), 'approved', writeback))
      .toBeNull()
  })

  it('rejects a select missing the RESOLVED value and names both the outcome and the value', () => {
    const writeback = { statusField: 'fld_status', outcomeValues: { approved: ZH_APPROVED } }
    const error = resultWritebackFieldTypeError('statusField', selectTarget(['待审批', 'approved']), 'approved', writeback)
    expect(error).toContain(ZH_APPROVED)
    expect(error).toContain('for outcome approved')
    // the raw-outcome option being present is NOT enough once a mapping is declared
    expect(error).toContain('fld_status')
  })

  it('still checks the RAW outcome when no mapping is declared (unchanged legacy contract)', () => {
    expect(resultWritebackFieldTypeError('statusField', selectTarget(['approved']), 'approved', {})).toBeNull()
    expect(resultWritebackFieldTypeError('statusField', selectTarget(['待审批']), 'approved', {}))
      .toContain('for outcome approved')
    // and with the writeback argument omitted entirely (default = empty mapping)
    expect(resultWritebackFieldTypeError('statusField', selectTarget(['approved']), 'approved')).toBeNull()
  })

  it('ignores the mapping for a text status field (only select carries an option set)', () => {
    const writeback = { statusField: 'fld_status', outcomeValues: { approved: ZH_APPROVED } }
    expect(resultWritebackFieldTypeError('statusField', { id: 'fld_status', type: 'string' }, 'approved', writeback)).toBeNull()
    expect(resultWritebackFieldTypeError('statusField', { id: 'fld_status', type: 'longText' }, 'rejected', writeback)).toBeNull()
    // …and a type that was never allowed is still rejected for its TYPE, not its options
    expect(resultWritebackFieldTypeError('statusField', { id: 'fld_status', type: 'number' }, 'approved', writeback))
      .toContain('must be string/longText/select')
  })
})

/**
 * The PATCH itself. `buildResultWritebackPatch` is the single line where the mapping becomes user-visible
 * (the value actually written onto the record), so it gets its own cases: covering only the shared resolver
 * would let the write and the option check drift apart with the suite still green.
 */
describe('#5742 buildResultWritebackPatch status value', () => {
  const completionEvent = (toStatus: string) => ({
    version: 1,
    eventId: 'evt_1',
    eventType: 'approval.completed',
    occurredAt: '2026-09-15T02:00:00.000Z',
    source: 'approval-product',
    approval: {
      instanceId: 'ai_1', requestNo: null, templateId: 'tpl_1', templateVersionId: null,
      publishedDefinitionId: null, businessKey: null, workflowKey: null,
    },
    transition: { toStatus },
    actor: { id: 'usr_1', name: null },
    requester: { id: 'usr_2' },
  }) as never

  it('writes the MAPPED value into the status field', () => {
    const patch = buildResultWritebackPatch(
      { statusField: 'fld_status', outcomeValues: { approved: ZH_APPROVED } },
      completionEvent('approved'),
    )
    expect(patch).toEqual({ fld_status: ZH_APPROVED })
  })

  it('writes the RAW outcome when the mapping is absent or does not cover this outcome', () => {
    expect(buildResultWritebackPatch({ statusField: 'fld_status' }, completionEvent('approved')))
      .toEqual({ fld_status: 'approved' })
    expect(buildResultWritebackPatch(
      { statusField: 'fld_status', outcomeValues: { approved: ZH_APPROVED } },
      completionEvent('rejected'),
    )).toEqual({ fld_status: 'rejected' })
  })

  it('leaves the approver / completedAt values sourced from the EVENT (the mapping is status-only)', () => {
    const patch = buildResultWritebackPatch(
      {
        statusField: 'fld_status',
        approverField: 'fld_approver',
        completedAtField: 'fld_done',
        outcomeValues: { rejected: ZH_REJECTED },
      },
      completionEvent('rejected'),
    )
    expect(patch).toEqual({
      fld_status: ZH_REJECTED,
      fld_approver: 'usr_1',
      fld_done: '2026-09-15T02:00:00.000Z',
    })
  })
})

describe('#5742 validateStartApprovalConfig outcomeValues shape', () => {
  const base = { templateId: 'tpl_1', formDataMapping: { amount: '{{record.amount}}' } }
  const withWriteback = (writeback: unknown) => ({ ...base, resultWriteback: writeback })

  it('accepts a mapping over the four outcomes', () => {
    expect(validateStartApprovalConfig(withWriteback({
      statusField: 'fld_status',
      outcomeValues: { approved: ZH_APPROVED, rejected: ZH_REJECTED, revoked: '已撤销', cancelled: '已取消' },
    }), 'actionConfig')).toBeNull()
  })

  it('accepts an EMPTY mapping (treated as absent) and an absent one', () => {
    expect(validateStartApprovalConfig(withWriteback({ statusField: 'fld_status', outcomeValues: {} }), 'actionConfig')).toBeNull()
    expect(validateStartApprovalConfig(withWriteback({ statusField: 'fld_status' }), 'actionConfig')).toBeNull()
  })

  it('rejects an unknown outcome key', () => {
    expect(validateStartApprovalConfig(withWriteback({
      statusField: 'fld_status',
      outcomeValues: { approved: ZH_APPROVED, pending: '待审批' },
    }), 'actionConfig')).toMatch(/outcomeValues key pending is not one of/)
  })

  it('rejects an empty / blank / non-string mapped value', () => {
    expect(validateStartApprovalConfig(withWriteback({ statusField: 'fld_status', outcomeValues: { approved: '' } }), 'actionConfig'))
      .toBe('actionConfig.resultWriteback.outcomeValues.approved must be a non-empty string')
    expect(validateStartApprovalConfig(withWriteback({ statusField: 'fld_status', outcomeValues: { rejected: '  ' } }), 'actionConfig'))
      .toMatch(/outcomeValues\.rejected must be a non-empty string/)
    expect(validateStartApprovalConfig(withWriteback({ statusField: 'fld_status', outcomeValues: { approved: 1 } }), 'actionConfig'))
      .toMatch(/outcomeValues\.approved must be a non-empty string/)
  })

  it('rejects a non-object outcomeValues', () => {
    expect(validateStartApprovalConfig(withWriteback({ statusField: 'fld_status', outcomeValues: 'approved' }), 'actionConfig'))
      .toBe('actionConfig.resultWriteback.outcomeValues must be an object')
    expect(validateStartApprovalConfig(withWriteback({ statusField: 'fld_status', outcomeValues: ['a'] }), 'actionConfig'))
      .toBe('actionConfig.resultWriteback.outcomeValues must be an object')
  })

  it('still requires at least one mapped FIELD — outcomeValues alone is not a mapping', () => {
    expect(validateStartApprovalConfig(withWriteback({ outcomeValues: { approved: ZH_APPROVED } }), 'actionConfig'))
      .toMatch(/must map at least one of statusField\/approverField\/completedAtField/)
  })

  it('rejects a non-empty outcomeValues with NO statusField (dead config: the mapping is status-only)', () => {
    expect(validateStartApprovalConfig(withWriteback({
      approverField: 'fld_approver',
      outcomeValues: { approved: ZH_APPROVED },
    }), 'actionConfig')).toBe(
      'actionConfig.resultWriteback.outcomeValues requires actionConfig.resultWriteback.statusField '
      + '(the mapping only applies to the status field)',
    )
    // …while an EMPTY mapping (= absent) and a bare onNonApproved stay legal without a statusField:
    // onNonApproved gates the WHOLE backwrite, approver/completedAt included.
    expect(validateStartApprovalConfig(withWriteback({ approverField: 'fld_approver', outcomeValues: {} }), 'actionConfig'))
      .toBeNull()
    expect(validateStartApprovalConfig(withWriteback({ approverField: 'fld_approver', onNonApproved: true }), 'actionConfig'))
      .toBeNull()
  })
})

/**
 * Save-time gate. `assertResultWritebackFieldsAtSave` is private; it is exercised through a cast because
 * its whole contract is the message it returns for a given (sheet schema × writeback) pair, and driving it
 * via createRule would add a dozen unrelated stubs without testing anything more.
 */
type SaveGate = {
  assertResultWritebackFieldsAtSave: (
    sheetId: string,
    actions: Array<{ type: string; config: Record<string, unknown> }>,
  ) => Promise<string | null>
}

function makeService(selectOptions: string[]) {
  const queryFn = vi.fn(async (sql: string) => {
    if (/FROM meta_fields/i.test(sql)) {
      return {
        rows: [{
          id: 'fld_status',
          type: 'select',
          property: { options: selectOptions.map((value) => ({ value, label: value })) },
        }],
        rowCount: 1,
      }
    }
    return { rows: [], rowCount: 0 }
  })
  const chain: Record<string, unknown> = {}
  const chainFn = (..._args: unknown[]) => chain
  for (const m of [
    'selectFrom', 'selectAll', 'select', 'where', 'orderBy', 'limit', 'offset', 'groupBy',
    'insertInto', 'values', 'onConflict', 'columns', 'doUpdateSet', 'updateTable', 'set',
    'deleteFrom', 'returningAll', 'leftJoin',
  ]) {
    chain[m] = vi.fn(chainFn)
  }
  chain.execute = vi.fn(async () => [])
  chain.executeTakeFirst = vi.fn(async () => undefined)
  const service = new AutomationService(new EventBus(), chain as never, queryFn as never)
  return { gate: service as unknown as SaveGate, queryFn }
}

const approvalAction = (writeback: Record<string, unknown>) => ([{
  type: 'start_approval',
  config: { templateId: 'tpl_1', formDataMapping: { amount: 'fld_amount' }, resultWriteback: writeback },
}])

describe('#5742 assertResultWritebackFieldsAtSave outcome coverage', () => {
  it('passes a zh select when the approved mapping names one of its options', async () => {
    const { gate } = makeService(['待审批', ZH_APPROVED, ZH_REJECTED])
    await expect(gate.assertResultWritebackFieldsAtSave('sheet_1', approvalAction({
      statusField: 'fld_status',
      outcomeValues: { approved: ZH_APPROVED },
    }))).resolves.toBeNull()
  })

  it('fails the save when the approved mapping is not an option of the select', async () => {
    const { gate } = makeService(['待审批', 'approved'])
    await expect(gate.assertResultWritebackFieldsAtSave('sheet_1', approvalAction({
      statusField: 'fld_status',
      outcomeValues: { approved: ZH_APPROVED },
    }))).resolves.toContain('for outcome approved')
  })

  it('ALSO checks rejected when onNonApproved is on (and reports the rejected value)', async () => {
    const { gate } = makeService(['待审批', ZH_APPROVED])
    const error = await gate.assertResultWritebackFieldsAtSave('sheet_1', approvalAction({
      statusField: 'fld_status',
      onNonApproved: true,
      outcomeValues: { approved: ZH_APPROVED, rejected: ZH_REJECTED },
    }))
    expect(error).toContain('for outcome rejected')
    expect(error).toContain(ZH_REJECTED)
  })

  it('does NOT check rejected when onNonApproved is off', async () => {
    const { gate } = makeService(['待审批', ZH_APPROVED])
    await expect(gate.assertResultWritebackFieldsAtSave('sheet_1', approvalAction({
      statusField: 'fld_status',
      outcomeValues: { approved: ZH_APPROVED, rejected: ZH_REJECTED },
    }))).resolves.toBeNull()
  })

  it('leaves revoked / cancelled to the fire-time check (a save is not blocked on them)', async () => {
    const { gate } = makeService(['待审批', ZH_APPROVED, ZH_REJECTED])
    await expect(gate.assertResultWritebackFieldsAtSave('sheet_1', approvalAction({
      statusField: 'fld_status',
      onNonApproved: true,
      outcomeValues: { approved: ZH_APPROVED, rejected: ZH_REJECTED, revoked: '已撤销', cancelled: '已取消' },
    }))).resolves.toBeNull()
  })

  it('keeps the legacy raw-outcome contract for a rule with no mapping', async () => {
    const { gate } = makeService(['approved'])
    await expect(gate.assertResultWritebackFieldsAtSave('sheet_1', approvalAction({ statusField: 'fld_status' })))
      .resolves.toBeNull()
    const { gate: zhOnly } = makeService(['待审批', ZH_APPROVED])
    await expect(zhOnly.assertResultWritebackFieldsAtSave('sheet_1', approvalAction({ statusField: 'fld_status' })))
      .resolves.toContain('for outcome approved')
  })
})
