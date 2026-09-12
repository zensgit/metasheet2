/**
 * F9c — SAVE-TIME `send_notification` recipient roster check (createRule / updateRule).
 *
 * GAP this pins: F9b hard-rejects an out-of-roster recipient at EXECUTION time (whole step fails, zero
 * writes, zero emit), but the editor's recipient box is free text and the test run is contractually
 * zero-DB, so a typo used to pass both surfaces — dry run green, first LIVE fire fails, every later
 * action skipped. The preflight belongs where the rule is WRITTEN.
 *
 * Every assertion here is on the service's only two outbound seams: the Kysely mock (did a row get
 * written?) and `queryFn` (which roster, for which sheet, how many times?).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AutomationRuleValidationError,
  AutomationService,
  AUTOMATION_SAVE_ROSTER_UNAVAILABLE_ERROR,
  collectNotificationRecipientGroupsAtSave,
} from '../../src/multitable/automation-service'
import { AUTOMATION_NO_RECIPIENTS_ERROR } from '../../src/multitable/automation-executor'
import { EventBus } from '../../src/integration/events/event-bus'
import { Logger } from '../../src/core/logger'

const SHEET_ID = 'sheet_f9c'
const ROSTER_SQL = /WITH user_candidates AS/i
const ELIGIBILITY_SQL = /FROM user_permissions up/i

type QueryCall = { sql: string; params?: unknown[] }

interface Harness {
  service: AutomationService
  queryFn: ReturnType<typeof vi.fn>
  calls: QueryCall[]
  rosterCalls: () => QueryCall[]
  insertedRows: () => Record<string, unknown>[]
  updateSets: () => Record<string, unknown>[]
  pushSelect: (row: unknown) => void
  pushExecute: (rows: unknown) => void
}

/**
 * The roster stub models the REAL resolver's two reads and its KEYING: a roster asked for another
 * sheet comes back empty, so a gate that read the wrong sheet cannot stay green by accident.
 */
function makeHarness(options: { members?: string[]; rosterError?: Error; withQueryFn?: boolean } = {}): Harness {
  const members = options.members ?? ['u1', 'u2']
  const calls: QueryCall[] = []
  const insertRows: Record<string, unknown>[] = []
  const setCalls: Record<string, unknown>[] = []
  const selectResults: unknown[] = []
  const executeResults: unknown[] = []
  let lastVerb = ''

  const queryFn = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params })
    if (ROSTER_SQL.test(sql)) {
      if (options.rosterError) throw options.rosterError
      if ((params ?? [])[0] !== SHEET_ID) return { rows: [], rowCount: 0 }
      return {
        rows: members.map((id) => ({
          subject_type: 'user',
          subject_id: id,
          user_name: id,
          user_email: `${id}@members.test`,
          user_is_active: true,
          permission_codes: ['multitable:read'],
        })),
        rowCount: members.length,
      }
    }
    if (ELIGIBILITY_SQL.test(sql)) {
      return {
        rows: members.map((id) => ({ user_id: id, permission_code: 'multitable:read' })),
        rowCount: members.length,
      }
    }
    return { rows: [], rowCount: 0 }
  })

  const chain: Record<string, unknown> = {}
  const chainFn = (..._args: unknown[]) => chain
  for (const m of [
    'selectFrom', 'selectAll', 'select', 'where', 'orderBy', 'limit', 'offset',
    'groupBy', 'onConflict', 'columns', 'doUpdateSet', 'deleteFrom', 'returningAll', 'leftJoin',
  ]) {
    chain[m] = vi.fn(chainFn)
  }
  chain.insertInto = vi.fn((table: unknown) => { lastVerb = `insert:${String(table)}`; return chain })
  chain.updateTable = vi.fn((table: unknown) => { lastVerb = `update:${String(table)}`; return chain })
  chain.values = vi.fn((row: unknown) => { insertRows.push(row as Record<string, unknown>); return chain })
  chain.set = vi.fn((row: unknown) => { setCalls.push(row as Record<string, unknown>); return chain })
  chain.execute = vi.fn(async () => {
    if (lastVerb.startsWith('insert')) return []
    return executeResults.shift() ?? []
  })
  chain.executeTakeFirst = vi.fn(async () => selectResults.shift())

  const service = new AutomationService(
    new EventBus(),
    chain as never,
    (options.withQueryFn === false ? undefined : queryFn) as never,
  )

  return {
    service,
    queryFn,
    calls,
    rosterCalls: () => calls.filter((call) => ROSTER_SQL.test(call.sql)),
    insertedRows: () => insertRows,
    updateSets: () => setCalls,
    pushSelect: (row) => { selectResults.push(row) },
    pushExecute: (rows) => { executeResults.push(rows) },
  }
}

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'atr_f9c',
    sheet_id: SHEET_ID,
    name: 'Rule',
    trigger_type: 'record.created',
    trigger_config: {},
    action_type: 'update_record',
    action_config: {},
    enabled: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: 'u1',
    conditions: null,
    actions: null,
    execution_mode: null,
    ...overrides,
  }
}

function notifyCreateInput(config: Record<string, unknown>) {
  return {
    name: 'F9c notify',
    triggerType: 'record.created',
    triggerConfig: {},
    actionType: 'send_notification',
    actionConfig: config,
    createdBy: 'u1',
  }
}

async function rejection(promise: Promise<unknown>): Promise<AutomationRuleValidationError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(AutomationRuleValidationError)
    return err as AutomationRuleValidationError
  }
  throw new Error('expected the save to be refused, but it resolved')
}

describe('F9c — createRule recipient roster gate', () => {
  let h: Harness

  beforeEach(() => { h = makeHarness() })

  it('refuses a recipient outside the roster, NAMES it, and writes no row', async () => {
    const err = await rejection(h.service.createRule(SHEET_ID, notifyCreateInput({
      message: 'ping',
      userIds: ['u1', 'u_ghost'],
    })))

    expect(err.code).toBe('RECIPIENT_NOT_AUTHORIZED')
    // The author typed these ids and cannot fix the rule without knowing WHICH one is wrong.
    expect(err.message).toContain('u_ghost')
    expect(err.message).toContain('RECIPIENT_NOT_AUTHORIZED')
    expect(h.insertedRows()).toHaveLength(0)
  })

  it('names ONLY the rejected id, never the accepted co-recipient', async () => {
    const err = await rejection(h.service.createRule(SHEET_ID, notifyCreateInput({
      message: 'ping',
      userIds: ['u2', 'u_ghost'],
    })))

    const listed = err.message.split('：')[1] ?? ''
    expect(listed).toContain('u_ghost')
    expect(listed).not.toContain('u2')
  })

  it('refuses an out-of-roster recipient nested in a condition_branch sub-action (M1)', async () => {
    const action = {
      type: 'condition_branch',
      config: {
        branches: [{
          key: 'vip',
          conditions: { logic: 'and', conditions: [{ fieldId: 'tier', operator: 'equals', value: 'vip' }] },
          actions: [{ type: 'send_notification', config: { userIds: ['u_branch_ghost'], message: 'vip' } }],
        }],
        defaultBranch: {
          key: 'fallback',
          actions: [{ type: 'send_notification', config: { userIds: ['u1'], message: 'fallback' } }],
        },
      },
    }

    const err = await rejection(h.service.createRule(SHEET_ID, {
      name: 'F9c branch',
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'condition_branch',
      actionConfig: action.config,
      actions: [action] as never,
      executionMode: 'workflow_job_v1',
      createdBy: 'u1',
    }))

    expect(err.code).toBe('RECIPIENT_NOT_AUTHORIZED')
    expect(err.message).toContain('u_branch_ghost')
    expect(h.insertedRows()).toHaveLength(0)
  })

  it('refuses an out-of-roster recipient in a defaultBranch sub-action (M1)', async () => {
    const action = {
      type: 'condition_branch',
      config: {
        branches: [{
          key: 'vip',
          conditions: { logic: 'and', conditions: [{ fieldId: 'tier', operator: 'equals', value: 'vip' }] },
          actions: [{ type: 'send_notification', config: { userIds: ['u1'], message: 'vip' } }],
        }],
        defaultBranch: {
          key: 'fallback',
          actions: [{ type: 'send_notification', config: { userIds: ['u_default_ghost'], message: 'fallback' } }],
        },
      },
    }

    const err = await rejection(h.service.createRule(SHEET_ID, {
      name: 'F9c default branch',
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'condition_branch',
      actionConfig: action.config,
      actions: [action] as never,
      executionMode: 'workflow_job_v1',
      createdBy: 'u1',
    }))

    expect(err.code).toBe('RECIPIENT_NOT_AUTHORIZED')
    expect(err.message).toContain('u_default_ghost')
    expect(h.insertedRows()).toHaveLength(0)
  })

  it('persists unchanged when every recipient is in the roster (same columns, same JSON)', async () => {
    const rule = await h.service.createRule(SHEET_ID, notifyCreateInput({ message: 'ping', userIds: ['u1', 'u2'] }))

    expect(rule.action_type).toBe('send_notification')
    const rows = h.insertedRows()
    expect(rows).toHaveLength(1)
    // Write SHAPE is untouched by this slice: same column set, same serialization.
    expect(Object.keys(rows[0]).sort()).toEqual([
      'action_config', 'action_type', 'actions', 'conditions', 'created_by', 'enabled',
      'execution_mode', 'id', 'name', 'sheet_id', 'trigger_config', 'trigger_type',
    ])
    expect(JSON.parse(String(rows[0].action_config))).toEqual({ message: 'ping', userIds: ['u1', 'u2'] })
    // The roster is resolved for THE RULE'S SHEET (a wrong key would answer an empty roster here).
    expect(h.rosterCalls()).toHaveLength(1)
    expect(h.rosterCalls()[0].params?.[0]).toBe(SHEET_ID)
  })

  it('normalizes with the executor function: padding and duplicates are accepted, not rejected (M3)', async () => {
    await h.service.createRule(SHEET_ID, notifyCreateInput({ message: 'ping', userIds: [' u1 ', 'u1', 'u2'] }))

    expect(h.insertedRows()).toHaveLength(1)
  })

  it('refuses an empty recipient list with NO_RECIPIENTS, before any roster read', async () => {
    const err = await rejection(h.service.createRule(SHEET_ID, notifyCreateInput({ message: 'ping', userIds: [] })))

    expect(err.code).toBe('NO_RECIPIENTS')
    expect(err.message).toBe(AUTOMATION_NO_RECIPIENTS_ERROR)
    expect(h.insertedRows()).toHaveLength(0)
    expect(h.rosterCalls()).toHaveLength(0)
  })

  it('refuses a whitespace-only recipient with NO_RECIPIENTS (normalization, not length)', async () => {
    const err = await rejection(h.service.createRule(SHEET_ID, notifyCreateInput({ message: 'ping', userIds: ['   '] })))

    expect(err.code).toBe('NO_RECIPIENTS')
    expect(h.insertedRows()).toHaveLength(0)
  })

  /**
   * PER-ACTION, not a union: an EMPTY send_notification must be refused on its own even when a SIBLING
   * send_notification in the same rule names a valid recipient. Without this spec the gate's
   * `groups.some((recipients) => recipients.length === 0)` (automation-service.ts:2213) can be weakened
   * to `groups.every(...)` and every other spec here stays green — the empty branch would then be
   * persisted and skipped at run time, which is exactly the "dry run green, live fire fails" gap F9c
   * exists to close.
   */
  it('refuses an EMPTY send_notification even when a sibling one has a valid recipient (no union masking)', async () => {
    const action = {
      type: 'condition_branch',
      config: {
        branches: [{
          key: 'vip',
          conditions: { logic: 'and', conditions: [{ fieldId: 'tier', operator: 'equals', value: 'vip' }] },
          actions: [{ type: 'send_notification', config: { userIds: ['u1'], message: 'vip' } }],
        }],
        defaultBranch: {
          key: 'fallback',
          actions: [{ type: 'send_notification', config: { userIds: [], message: 'fallback' } }],
        },
      },
    }

    const err = await rejection(h.service.createRule(SHEET_ID, {
      name: 'F9c sibling empty',
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'condition_branch',
      actionConfig: action.config,
      actions: [action] as never,
      executionMode: 'workflow_job_v1',
      createdBy: 'u1',
    }))

    expect(err.code).toBe('NO_RECIPIENTS')
    expect(h.insertedRows()).toHaveLength(0)
    // The valid sibling must not buy the empty one a roster read either.
    expect(h.rosterCalls()).toHaveLength(0)
  })

  it('refuses the save when the roster read THROWS — never treats it as an empty pass (M2)', async () => {
    h = makeHarness({ rosterError: new Error('connection terminated') })

    const err = await rejection(h.service.createRule(SHEET_ID, notifyCreateInput({ message: 'ping', userIds: ['u1'] })))

    expect(err.code).toBe('ROSTER_UNAVAILABLE')
    expect(err.message).toBe(AUTOMATION_SAVE_ROSTER_UNAVAILABLE_ERROR)
    // Fail-closed AND quiet: the driver text never reaches the response.
    expect(err.message).not.toContain('connection terminated')
    expect(h.insertedRows()).toHaveLength(0)
  })

  it('refuses the save when no queryFn is wired (fail-closed sink, never a skip)', async () => {
    h = makeHarness({ withQueryFn: false })

    const err = await rejection(h.service.createRule(SHEET_ID, notifyCreateInput({ message: 'ping', userIds: ['u1'] })))

    expect(err.code).toBe('ROSTER_UNAVAILABLE')
    expect(h.insertedRows()).toHaveLength(0)
  })

  it('enumerates the legacy `notify` alias through the SAME gate', async () => {
    const err = await rejection(h.service.createRule(SHEET_ID, {
      name: 'legacy notify',
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'notify',
      actionConfig: { message: 'ping', userIds: ['u_ghost'] },
      createdBy: 'u1',
    }))

    expect(err.code).toBe('RECIPIENT_NOT_AUTHORIZED')
    expect(err.message).toContain('u_ghost')
    expect(h.insertedRows()).toHaveLength(0)
  })

  it('does not read the roster at all for a rule without send_notification', async () => {
    await h.service.createRule(SHEET_ID, {
      name: 'no notify',
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'update_record',
      actionConfig: { fields: { status: 'done' } },
      createdBy: 'u1',
    })

    expect(h.insertedRows()).toHaveLength(1)
    expect(h.rosterCalls()).toHaveLength(0)
  })
})

describe('F9c — updateRule recipient roster gate', () => {
  let h: Harness

  beforeEach(() => { h = makeHarness() })

  it('refuses an edited recipient outside the roster and writes no update', async () => {
    h.pushSelect(storedRow({ action_type: 'send_notification', action_config: { message: 'old', userIds: ['u1'] } }))

    const err = await rejection(h.service.updateRule('atr_f9c', SHEET_ID, {
      actionConfig: { message: 'new', userIds: ['u_ghost'] },
    }))

    expect(err.code).toBe('RECIPIENT_NOT_AUTHORIZED')
    expect(err.message).toContain('u_ghost')
    expect(h.updateSets()).toHaveLength(0)
  })

  it('refuses a NAME-ONLY edit of a rule whose stored recipients are already dirty', async () => {
    // 222's existing "测试" rule shape: nothing about the notification is being edited, but the save
    // still carries those recipients forward. Editing it stays blocked until they are fixed.
    h.pushSelect(storedRow({ action_type: 'send_notification', action_config: { message: 'old', userIds: ['u_ghost'] } }))

    const err = await rejection(h.service.updateRule('atr_f9c', SHEET_ID, { name: 'renamed' }))

    expect(err.code).toBe('RECIPIENT_NOT_AUTHORIZED')
    expect(err.message).toContain('u_ghost')
    expect(h.updateSets()).toHaveLength(0)
  })

  it('refuses an enable/disable toggle of a rule whose stored recipients are dirty (enabled is not a bypass)', async () => {
    h.pushSelect(storedRow({
      enabled: false,
      action_type: 'send_notification',
      action_config: { message: 'old', userIds: ['u_ghost'] },
    }))

    const err = await rejection(h.service.setRuleEnabled('atr_f9c', SHEET_ID, true))

    expect(err.code).toBe('RECIPIENT_NOT_AUTHORIZED')
    expect(h.updateSets()).toHaveLength(0)
  })

  it('refuses an out-of-roster recipient nested in a branch sub-action on update (M1)', async () => {
    const action = {
      type: 'parallel_branch',
      config: {
        joinMode: 'all',
        branches: [
          { key: 'ops', actions: [{ type: 'update_record', config: { fields: { status: 'ops' } } }] },
          { key: 'notify', actions: [{ type: 'send_notification', config: { userIds: ['u_branch_ghost'], message: 'ok' } }] },
        ],
      },
    }
    h.pushSelect(storedRow())

    const err = await rejection(h.service.updateRule('atr_f9c', SHEET_ID, {
      actionType: 'parallel_branch',
      actionConfig: action.config,
      actions: [action] as never,
      executionMode: 'workflow_job_v1',
    }))

    expect(err.code).toBe('RECIPIENT_NOT_AUTHORIZED')
    expect(err.message).toContain('u_branch_ghost')
    expect(h.updateSets()).toHaveLength(0)
  })

  it('refuses an update that empties the recipients with NO_RECIPIENTS', async () => {
    h.pushSelect(storedRow({ action_type: 'send_notification', action_config: { message: 'old', userIds: ['u1'] } }))

    const err = await rejection(h.service.updateRule('atr_f9c', SHEET_ID, {
      actionConfig: { message: 'new', userIds: [] },
    }))

    expect(err.code).toBe('NO_RECIPIENTS')
    expect(h.updateSets()).toHaveLength(0)
  })

  it('refuses the update when the roster read THROWS (M2)', async () => {
    h = makeHarness({ rosterError: new Error('connection terminated') })
    h.pushSelect(storedRow({ action_type: 'send_notification', action_config: { message: 'old', userIds: ['u1'] } }))

    const err = await rejection(h.service.updateRule('atr_f9c', SHEET_ID, { name: 'renamed' }))

    expect(err.code).toBe('ROSTER_UNAVAILABLE')
    expect(h.updateSets()).toHaveLength(0)
  })

  it('saves normally when every recipient is in the roster', async () => {
    h.pushSelect(storedRow({ action_type: 'send_notification', action_config: { message: 'old', userIds: ['u1'] } }))
    h.pushExecute([storedRow({ action_type: 'send_notification', action_config: { message: 'new', userIds: ['u1', 'u2'] } })])

    const updated = await h.service.updateRule('atr_f9c', SHEET_ID, {
      actionConfig: { message: 'new', userIds: ['u1', 'u2'] },
    })

    expect(updated).not.toBeNull()
    expect(h.updateSets()).toHaveLength(1)
    expect(JSON.parse(String(h.updateSets()[0].action_config))).toEqual({ message: 'new', userIds: ['u1', 'u2'] })
  })

  it('reads NO roster for an edit of a rule that has no send_notification', async () => {
    h.pushSelect(storedRow())
    h.pushExecute([storedRow({ name: 'renamed' })])

    const updated = await h.service.updateRule('atr_f9c', SHEET_ID, { name: 'renamed' })

    expect(updated).not.toBeNull()
    expect(h.rosterCalls()).toHaveLength(0)
  })

  it('enumerates a STORED legacy `notify` rule through the gate on an unrelated edit', async () => {
    h.pushSelect(storedRow({ action_type: 'notify', action_config: { message: 'old', userIds: ['u_ghost'] } }))

    const err = await rejection(h.service.updateRule('atr_f9c', SHEET_ID, { name: 'renamed' }))

    expect(err.code).toBe('RECIPIENT_NOT_AUTHORIZED')
    expect(err.message).toContain('u_ghost')
    expect(h.updateSets()).toHaveLength(0)
  })
})

describe('F9c — collectNotificationRecipientGroupsAtSave', () => {
  it('yields ONE normalized list per send_notification (legacy pair + flattened actions)', () => {
    const groups = collectNotificationRecipientGroupsAtSave(
      'send_notification',
      { userIds: [' u1 ', 'u1'] },
      [
        { type: 'update_record', config: { fields: {} } },
        { type: 'send_notification', config: { userIds: ['u2', '  '] } },
        { type: 'send_notification', config: {} },
      ] as never,
    )

    // trim + dedupe come from the executor's own normalizer, not a second copy here.
    expect(groups).toEqual([['u1'], ['u2'], []])
  })

  it('yields nothing for a rule with no send_notification', () => {
    expect(collectNotificationRecipientGroupsAtSave('update_record', { fields: {} }, [])).toEqual([])
  })
})

/**
 * F9c — the ASYMMETRY is the point, and it is the one rule of this slice that no other spec pins:
 * the rejected ids MUST reach the response (the author typed them and cannot fix the rule otherwise)
 * and MUST NOT reach the server log (operators reading logs have no business learning who someone
 * tried to notify). Every one of the gate's three refusal logs is checked ARGUMENT-BY-ARGUMENT with
 * `toEqual`, so a payload that grows an id-bearing field — `rejected: rejected` instead of
 * `rejected.length`, a `userIds`, a `join()` — reds here, and a refusal that stops logging altogether
 * reds here too.
 *
 * The seam is `Logger.prototype` — ALL FOUR levels, not only the one the gate happens to use today.
 * A spy on `warn` alone would have let a later `logger.info('…', { rejected })` or
 * `logger.error('…', new Error(rejected.join()))` inside this same gate leak every rejected id while
 * this suite stayed green; both escapes were reproduced as in-memory mutations, and widening the spy is
 * what makes them red. The spies capture the RAW arguments the service hands over, BEFORE the winston
 * formatter — exactly where the service decides what to disclose.
 */
describe('F9c — save-gate logs are values-free (ids to the author, counts to the log)', () => {
  const AUTHOR = 'u_author'
  const KEEP = 'u_keep'
  const GHOST = 'u_ghost'
  let warn: ReturnType<typeof vi.spyOn>
  let logSpies: ReturnType<typeof vi.spyOn>[]

  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    logSpies = [
      vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {}),
      vi.spyOn(Logger.prototype, 'info').mockImplementation(() => {}),
      warn,
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {}),
    ]
  })
  afterEach(() => {
    for (const spy of logSpies) spy.mockRestore()
  })

  /**
   * Everything the service handed to ANY logger level during the save, serialized.
   *
   * Errors are UNWRAPPED on the way out: `Logger.error(message, error)` and `Logger.warn(message, error)`
   * both funnel `error.message` + `error.stack` into the emitted meta (src/core/logger.ts:104-115), so an
   * id smuggled inside an Error really does reach the log — but a plain `JSON.stringify` of an Error
   * yields `{}` and would hide it. The replacer below is what keeps that escape red.
   */
  const logged = (): string =>
    JSON.stringify(
      logSpies.map((spy) => spy.mock.calls),
      (_key, value) => (value instanceof Error ? { message: value.message, stack: value.stack } : value),
    )
  const metaFor = (message: string): unknown => warn.mock.calls.find(([msg]) => msg === message)?.[1]

  function notifyCreate(config: Record<string, unknown>) {
    return {
      name: 'F9c log check',
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'send_notification',
      actionConfig: config,
      createdBy: AUTHOR,
    }
  }

  it('logs counts only when recipients are rejected — the ids go to the 400 body, not the log', async () => {
    const h = makeHarness({ members: [KEEP] })

    const err = await rejection(h.service.createRule(SHEET_ID, notifyCreate({ message: 'ping', userIds: [KEEP, GHOST] })))

    // Positive control: the id IS disclosed to the author.
    expect(err.code).toBe('RECIPIENT_NOT_AUTHORIZED')
    expect(err.message).toContain(GHOST)
    // …and the refusal IS logged, with counts and nothing else.
    expect(metaFor('[automation.save] recipients rejected: outside selectable-people roster')).toEqual({
      sheetId: SHEET_ID,
      requested: 2,
      rejected: 1,
    })
    // Neither the rejected id nor the accepted co-recipient appears anywhere in the log.
    expect(logged()).not.toContain(GHOST)
    expect(logged()).not.toContain(KEEP)
  })

  it('logs counts only when the roster read throws — no ids, no driver text', async () => {
    const h = makeHarness({ members: [KEEP], rosterError: new Error('connection terminated: host 10.0.0.9') })

    const err = await rejection(h.service.createRule(SHEET_ID, notifyCreate({ message: 'ping', userIds: [KEEP] })))

    expect(err.code).toBe('ROSTER_UNAVAILABLE')
    expect(metaFor('[automation.save] recipient roster unreadable; rule save refused')).toEqual({
      sheetId: SHEET_ID,
      requested: 1,
      error: 'Error',
    })
    expect(logged()).not.toContain(KEEP)
    expect(logged()).not.toContain('connection terminated')
  })

  it('logs counts only when the roster sink is unwired — no ids', async () => {
    const h = makeHarness({ members: [KEEP], withQueryFn: false })

    const err = await rejection(h.service.createRule(SHEET_ID, notifyCreate({ message: 'ping', userIds: [KEEP, GHOST] })))

    expect(err.code).toBe('ROSTER_UNAVAILABLE')
    expect(metaFor('[automation.save] recipient roster sink unavailable; rule save refused')).toEqual({
      sheetId: SHEET_ID,
      requested: 2,
    })
    expect(logged()).not.toContain(GHOST)
    expect(logged()).not.toContain(KEEP)
  })
})
