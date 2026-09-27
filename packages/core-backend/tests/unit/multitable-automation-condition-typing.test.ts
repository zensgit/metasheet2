/**
 * 客户反馈 2026-09-24 #4b（自动化条件按字段类型比较），裁定见 PR #6074 — typed condition evaluation +
 * save-time validation for condition_branch conditions.
 *
 * Facts fixed here (all verified on main before the change):
 *   - equals was `===`, so a person/link/multiSelect cell (stored `id[]`) could never equal anything and an
 *     empty person cell (`[]`) was not `is_empty`;
 *   - a `date` cell stored as an ISO instant (`openedAt` = `2026-09-24T18:00:00.000Z`) never equalled the
 *     `YYYY-MM-DD` a person types, and `dateTime` compared raw strings;
 *   - condition_branch conditions were only shape-checked at save (no field-type validation);
 *   - date / dateTime condition values were only checked to be strings.
 *
 * UTC+8 boundary used throughout: 2026-09-24T18:00Z is 2026-09-25 02:00 in Asia/Shanghai.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AUTOMATION_CONDITION_VALUE_INVALID_CODE,
  ConditionGroupValidationError,
  evaluateCondition,
  evaluateConditions,
  normalizeConditionFields,
  validateConditionGroupAgainstFields,
  type AutomationConditionField,
  type ConditionEvaluationOptions,
  type ConditionGroup,
  type ConditionUnreadableValueInfo,
} from '../../src/multitable/automation-conditions'
import {
  AutomationExecutor,
  type ActionJobLifecycle,
  type AutomationDeps,
  type AutomationRule,
} from '../../src/multitable/automation-executor'
import {
  AutomationRuleValidationError,
  preflightAutomationConditionFields,
} from '../../src/multitable/automation-service'
import { EventBus } from '../../src/integration/events/event-bus'
import { Logger } from '../../src/core/logger'

const SHANGHAI_ENV = { MULTITABLE_BUSINESS_TIMEZONE: 'Asia/Shanghai' } as NodeJS.ProcessEnv
const UTC_ENV = { MULTITABLE_BUSINESS_TIMEZONE: 'Etc/UTC' } as NodeJS.ProcessEnv

// The customer's case: an `openedAt` date cell written as a full instant, 18:00Z on the 24th = the 25th in China.
const OPENED_AT_INSTANT = '2026-09-24T18:00:00.000Z'

function typed(fields: AutomationConditionField[], extra: Partial<ConditionEvaluationOptions> = {}): ConditionEvaluationOptions {
  return { fields, env: SHANGHAI_ENV, ...extra }
}

function reporter(): { calls: ConditionUnreadableValueInfo[]; onUnreadableValue: (info: ConditionUnreadableValueInfo) => void } {
  const calls: ConditionUnreadableValueInfo[] = []
  return { calls, onUnreadableValue: (info) => { calls.push(info) } }
}

describe('automation condition typing — legacy path stays byte-identical', () => {
  it('without fields every operator behaves exactly as before (characterization)', () => {
    expect(evaluateCondition({ fieldId: 'x', operator: 'equals', value: 'a' }, { x: 'a' })).toBe(true)
    expect(evaluateCondition({ fieldId: 'x', operator: 'equals', value: 42 }, { x: 42 })).toBe(true)
    expect(evaluateCondition({ fieldId: 'x', operator: 'equals', value: '42' }, { x: 42 })).toBe(false) // strict ===
    expect(evaluateCondition({ fieldId: 'x', operator: 'not_equals', value: 1 }, { x: 2 })).toBe(true)
    expect(evaluateCondition({ fieldId: 'x', operator: 'contains', value: 'ell' }, { x: 'hello' })).toBe(true)
    expect(evaluateCondition({ fieldId: 'x', operator: 'contains', value: 'a' }, { x: ['a', 'b'] })).toBe(true)
    expect(evaluateCondition({ fieldId: 'x', operator: 'contains', value: '1' }, { x: 123 })).toBe(false)
    expect(evaluateCondition({ fieldId: 'x', operator: 'not_contains', value: 'xyz' }, { x: 'hello' })).toBe(true)
    expect(evaluateCondition({ fieldId: 'x', operator: 'greater_than', value: 5 }, { x: 10 })).toBe(true)
    expect(evaluateCondition({ fieldId: 'x', operator: 'greater_than', value: 'a' }, { x: 'b' })).toBe(true)
    expect(evaluateCondition({ fieldId: 'x', operator: 'greater_than', value: 5 }, { x: 'abc' })).toBe(false)
    expect(evaluateCondition({ fieldId: 'x', operator: 'less_or_equal', value: 'm' }, { x: 'alpha' })).toBe(true)
    expect(evaluateCondition({ fieldId: 'x', operator: 'is_empty' }, { x: '' })).toBe(true)
    expect(evaluateCondition({ fieldId: 'x', operator: 'is_empty' }, {})).toBe(true)
    expect(evaluateCondition({ fieldId: 'x', operator: 'is_empty' }, { x: [] })).toBe(false) // legacy: [] is not empty
    expect(evaluateCondition({ fieldId: 'x', operator: 'is_not_empty' }, { x: null })).toBe(false)
    expect(evaluateCondition({ fieldId: 'x', operator: 'in', value: [1, 2, 3] }, { x: 2 })).toBe(true)
    expect(evaluateCondition({ fieldId: 'x', operator: 'in', value: 'not-array' }, { x: 1 })).toBe(false)
    expect(evaluateCondition({ fieldId: 'x', operator: 'not_in', value: [1, 2] }, { x: 3 })).toBe(true)
    expect(evaluateCondition({ fieldId: 'x', operator: 'not_in', value: 'not-array' }, { x: 3 })).toBe(true)
    // The #4b bugs, pinned on the legacy path so the fix is visibly opt-in via `fields`:
    expect(evaluateCondition({ fieldId: 'p', operator: 'equals', value: ['u1'] }, { p: ['u1'] })).toBe(false)
    expect(evaluateCondition({ fieldId: 'd', operator: 'equals', value: '2026-09-25' }, { d: OPENED_AT_INSTANT })).toBe(false)
  })

  it('a field absent from `fields`, or of a type without a typed rule, evaluates on the legacy path', () => {
    const fields: AutomationConditionField[] = [
      { id: 'status', type: 'select' },
      { id: 'title', type: 'string' },
      { id: 'created', type: 'createdTime' },
    ]
    expect(evaluateCondition({ fieldId: 'status', operator: 'equals', value: 'Ready' }, { status: 'Ready' }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'title', operator: 'contains', value: 'ell' }, { title: 'hello' }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'title', operator: 'is_empty' }, { title: [] }, typed(fields))).toBe(false)
    expect(evaluateCondition({ fieldId: 'created', operator: 'equals', value: '2026-09-25' }, { created: OPENED_AT_INSTANT }, typed(fields))).toBe(false)
    expect(evaluateCondition({ fieldId: 'unknown', operator: 'equals', value: '42' }, { unknown: 42 }, typed(fields))).toBe(false)
  })

  it('normalizeConditionFields keys an array by id and passes a map through', () => {
    const map = normalizeConditionFields([{ id: 'a', type: 'date' }, { id: 'b', type: 'number' }])
    expect(map?.get('a')?.type).toBe('date')
    expect(normalizeConditionFields(map)).toBe(map)
    expect(normalizeConditionFields(null)).toBeNull()
    expect(normalizeConditionFields(undefined)).toBeNull()
  })
})

describe('date fields compare by calendar day in the business timezone', () => {
  const fields: AutomationConditionField[] = [{ id: 'openedAt', type: 'date' }]
  const record = { openedAt: OPENED_AT_INSTANT }

  it('a stored ISO instant is bucketed into Asia/Shanghai: 18:00Z on the 24th equals 2026-09-25', () => {
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'equals', value: '2026-09-25' }, record, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'equals', value: '2026-09-24' }, record, typed(fields))).toBe(false)
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'not_equals', value: '2026-09-24' }, record, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'not_equals', value: '2026-09-25' }, record, typed(fields))).toBe(false)
  })

  it('the same instant is the 24th when the business timezone is UTC (env) or the field names a western zone', () => {
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'equals', value: '2026-09-24' }, record, { fields, env: UTC_ENV })).toBe(true)
    const nyField: AutomationConditionField[] = [{ id: 'openedAt', type: 'date', property: { timezone: 'America/New_York' } }]
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'equals', value: '2026-09-24' }, record, typed(nyField))).toBe(true)
    // A JSON-string property (as a raw meta_fields row may carry) is read the same way.
    const jsonField: AutomationConditionField[] = [{ id: 'openedAt', type: 'date', property: JSON.stringify({ timezone: 'America/New_York' }) }]
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'equals', value: '2026-09-24' }, record, typed(jsonField))).toBe(true)
    // The literal 'UTC' is the legacy "unset" marker (#6083), NOT a zone choice — business time still applies.
    const utcMarker: AutomationConditionField[] = [{ id: 'openedAt', type: 'date', property: { timezone: 'UTC' } }]
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'equals', value: '2026-09-25' }, record, typed(utcMarker))).toBe(true)
  })

  it('a bare YYYY-MM-DD is a floating day (#3417): never shifted by any zone', () => {
    const floating = { openedAt: '2026-09-25' }
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'equals', value: '2026-09-25' }, floating, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'equals', value: '2026-09-25' }, floating, { fields, env: UTC_ENV })).toBe(true)
    const nyField: AutomationConditionField[] = [{ id: 'openedAt', type: 'date', property: { timezone: 'America/New_York' } }]
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'equals', value: '2026-09-25' }, floating, typed(nyField))).toBe(true)
  })

  it('ordering operators compare days, not strings; in/not_in match against a list of days', () => {
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'greater_than', value: '2026-09-24' }, record, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'greater_than', value: '2026-09-25' }, record, typed(fields))).toBe(false)
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'greater_or_equal', value: '2026-09-25' }, record, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'less_than', value: '2026-09-26' }, record, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'less_or_equal', value: '2026-09-24' }, record, typed(fields))).toBe(false)
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'in', value: ['2026-09-25', '2026-09-26'] }, record, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'in', value: ['2026-09-24'] }, record, typed(fields))).toBe(false)
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'not_in', value: ['2026-09-24'] }, record, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'not_in', value: ['2026-09-25'] }, record, typed(fields))).toBe(false)
  })

  it('accepts other stored spellings: epoch ms, Date, zone-less wall clock text, and a condition given as an instant', () => {
    const epoch = { openedAt: Date.parse(OPENED_AT_INSTANT) }
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'equals', value: '2026-09-25' }, epoch, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'equals', value: '2026-09-25' }, { openedAt: new Date(OPENED_AT_INSTANT) }, typed(fields))).toBe(true)
    // Zone-less text is a wall clock in the business zone: 2026-09-24 18:00 China time IS the 24th.
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'equals', value: '2026-09-24' }, { openedAt: '2026-09-24 18:00' }, typed(fields))).toBe(true)
    // A condition value that is itself an instant is bucketed the same way.
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'equals', value: OPENED_AT_INSTANT }, { openedAt: '2026-09-25' }, typed(fields))).toBe(true)
  })

  it('is_empty / is_not_empty: null, undefined, "" are empty; an unreadable string is not', () => {
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'is_empty' }, { openedAt: null }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'is_empty' }, {}, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'is_empty' }, { openedAt: '' }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'is_empty' }, { openedAt: 'garbage' }, typed(fields))).toBe(false)
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'is_not_empty' }, record, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'not_equals', value: '2026-09-25' }, { openedAt: null }, typed(fields))).toBe(true)
  })

  it('legacy tolerance: an unreadable stored or condition value never throws — it evaluates unmatched and is reported values-free', () => {
    const r = reporter()
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'equals', value: '2026-09-25' }, { openedAt: 'yesterday' }, typed(fields, r))).toBe(false)
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'not_equals', value: '2026-09-25' }, { openedAt: 'yesterday' }, typed(fields, r))).toBe(true)
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'greater_than', value: '2026-09-25' }, { openedAt: 'yesterday' }, typed(fields, r))).toBe(false)
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'equals', value: 'next week' }, record, typed(fields, r))).toBe(false)
    expect(evaluateCondition({ fieldId: 'openedAt', operator: 'equals', value: '2026-02-30' }, record, typed(fields, r))).toBe(false)
    expect(r.calls).toEqual([
      { fieldId: 'openedAt', fieldType: 'date', operator: 'equals', side: 'record' },
      { fieldId: 'openedAt', fieldType: 'date', operator: 'not_equals', side: 'record' },
      { fieldId: 'openedAt', fieldType: 'date', operator: 'greater_than', side: 'record' },
      { fieldId: 'openedAt', fieldType: 'date', operator: 'equals', side: 'condition' },
      { fieldId: 'openedAt', fieldType: 'date', operator: 'equals', side: 'condition' },
    ])
    // Values-free: the report carries ids and type names only.
    for (const call of r.calls) expect(Object.keys(call).sort()).toEqual(['fieldId', 'fieldType', 'operator', 'side'])
  })
})

describe('dateTime fields compare parsed instants at minute precision', () => {
  const fields: AutomationConditionField[] = [{ id: 'dueAt', type: 'dateTime' }]
  const record = { dueAt: '2026-09-24T18:00:30.000Z' } // seconds are below the displayed precision

  it('a zone-less condition is a wall clock in the business zone; a zone-carrying one is absolute', () => {
    expect(evaluateCondition({ fieldId: 'dueAt', operator: 'equals', value: '2026-09-25 02:00' }, record, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'dueAt', operator: 'equals', value: '2026-09-24 18:00' }, record, typed(fields))).toBe(false)
    expect(evaluateCondition({ fieldId: 'dueAt', operator: 'equals', value: '2026-09-24T18:00:00Z' }, record, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'dueAt', operator: 'equals', value: '2026-09-25T02:00:00+08:00' }, record, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'dueAt', operator: 'equals', value: '2026-09-24 18:00' }, record, { fields, env: UTC_ENV })).toBe(true)
    const explicitUtc: AutomationConditionField[] = [{ id: 'dueAt', type: 'dateTime', property: { timezone: 'Etc/UTC' } }]
    expect(evaluateCondition({ fieldId: 'dueAt', operator: 'equals', value: '2026-09-24 18:00' }, record, typed(explicitUtc))).toBe(true)
  })

  it('ordering and membership work on instants', () => {
    expect(evaluateCondition({ fieldId: 'dueAt', operator: 'greater_than', value: '2026-09-25 01:59' }, record, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'dueAt', operator: 'greater_than', value: '2026-09-25 02:00' }, record, typed(fields))).toBe(false)
    expect(evaluateCondition({ fieldId: 'dueAt', operator: 'less_or_equal', value: '2026-09-25 02:00' }, record, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'dueAt', operator: 'in', value: ['2026-09-25 02:00', '2026-09-26 00:00'] }, record, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'dueAt', operator: 'not_in', value: ['2026-09-25 02:00'] }, record, typed(fields))).toBe(false)
    // A bare date is midnight in the zone (the API contract) — 2026-09-25 00:00 China < the cell.
    expect(evaluateCondition({ fieldId: 'dueAt', operator: 'greater_than', value: '2026-09-25' }, record, typed(fields))).toBe(true)
  })

  it('never throws on legacy text; reports the unreadable side', () => {
    const r = reporter()
    expect(evaluateCondition({ fieldId: 'dueAt', operator: 'equals', value: '2026-09-25 02:00' }, { dueAt: 'soon' }, typed(fields, r))).toBe(false)
    expect(evaluateCondition({ fieldId: 'dueAt', operator: 'equals', value: 'soon' }, record, typed(fields, r))).toBe(false)
    expect(r.calls.map((c) => c.side)).toEqual(['record', 'condition'])
    expect(r.calls[0]).toMatchObject({ fieldId: 'dueAt', fieldType: 'dateTime' })
  })
})

describe('person / link / multiSelect fields use set semantics over the stored id[]', () => {
  const fields: AutomationConditionField[] = [
    { id: 'owner', type: 'person' },
    { id: 'related', type: 'link' },
    { id: 'tags', type: 'multiSelect' },
    { id: 'legacyUser', type: 'user' },
  ]

  it('equals is set equality (order-insensitive); a scalar condition is a one-element set', () => {
    expect(evaluateCondition({ fieldId: 'owner', operator: 'equals', value: ['u2', 'u1'] }, { owner: ['u1', 'u2'] }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'owner', operator: 'equals', value: ['u1'] }, { owner: ['u1', 'u2'] }, typed(fields))).toBe(false)
    expect(evaluateCondition({ fieldId: 'owner', operator: 'equals', value: 'u1' }, { owner: ['u1'] }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'owner', operator: 'equals', value: 'u1' }, { owner: ['u1', 'u2'] }, typed(fields))).toBe(false)
    expect(evaluateCondition({ fieldId: 'owner', operator: 'not_equals', value: 'u1' }, { owner: ['u1', 'u2'] }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'owner', operator: 'not_equals', value: ['u1', 'u2'] }, { owner: ['u2', 'u1'] }, typed(fields))).toBe(false)
  })

  it('in / not_in are intersection semantics', () => {
    expect(evaluateCondition({ fieldId: 'owner', operator: 'in', value: ['u2', 'u9'] }, { owner: ['u1', 'u2'] }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'owner', operator: 'in', value: ['u9'] }, { owner: ['u1', 'u2'] }, typed(fields))).toBe(false)
    expect(evaluateCondition({ fieldId: 'owner', operator: 'not_in', value: ['u9'] }, { owner: ['u1', 'u2'] }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'owner', operator: 'not_in', value: ['u1'] }, { owner: ['u1', 'u2'] }, typed(fields))).toBe(false)
    expect(evaluateCondition({ fieldId: 'owner', operator: 'in', value: ['u1'] }, { owner: [] }, typed(fields))).toBe(false)
    expect(evaluateCondition({ fieldId: 'owner', operator: 'not_in', value: ['u1'] }, {}, typed(fields))).toBe(true)
  })

  it('contains / not_contains are membership (every condition id present)', () => {
    expect(evaluateCondition({ fieldId: 'tags', operator: 'contains', value: 'VIP' }, { tags: ['VIP', 'Internal'] }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'tags', operator: 'contains', value: 'External' }, { tags: ['VIP', 'Internal'] }, typed(fields))).toBe(false)
    expect(evaluateCondition({ fieldId: 'tags', operator: 'contains', value: ['VIP', 'Internal'] }, { tags: ['VIP', 'Internal', 'X'] }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'tags', operator: 'contains', value: ['VIP', 'External'] }, { tags: ['VIP', 'Internal'] }, typed(fields))).toBe(false)
    expect(evaluateCondition({ fieldId: 'tags', operator: 'not_contains', value: 'External' }, { tags: ['VIP'] }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'tags', operator: 'not_contains', value: 'VIP' }, { tags: ['VIP'] }, typed(fields))).toBe(false)
    expect(evaluateCondition({ fieldId: 'tags', operator: 'contains', value: 'VIP' }, { tags: [] }, typed(fields))).toBe(false)
  })

  it('is_empty is true for null / undefined / "" / [] — an empty person cell IS empty now', () => {
    expect(evaluateCondition({ fieldId: 'owner', operator: 'is_empty' }, { owner: [] }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'owner', operator: 'is_empty' }, { owner: null }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'owner', operator: 'is_empty' }, {}, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'owner', operator: 'is_empty' }, { owner: '' }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'owner', operator: 'is_empty' }, { owner: ['u1'] }, typed(fields))).toBe(false)
    expect(evaluateCondition({ fieldId: 'owner', operator: 'is_not_empty' }, { owner: [] }, typed(fields))).toBe(false)
    expect(evaluateCondition({ fieldId: 'owner', operator: 'is_not_empty' }, { owner: ['u1'] }, typed(fields))).toBe(true)
  })

  it('tolerates legacy shapes: a scalar id, numeric ids, {id} objects, and the `user` alias', () => {
    expect(evaluateCondition({ fieldId: 'owner', operator: 'equals', value: 'u1' }, { owner: 'u1' }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'related', operator: 'in', value: ['7'] }, { related: [7, 8] }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'related', operator: 'equals', value: ['rec_1'] }, { related: [{ id: 'rec_1', title: 'x' }] }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'legacyUser', operator: 'equals', value: ['u1'] }, { legacyUser: ['u1'] }, typed(fields))).toBe(true)
    const r = reporter()
    expect(evaluateCondition({ fieldId: 'owner', operator: 'equals', value: 'u1' }, { owner: [{ name: 'no id' }] }, typed(fields, r))).toBe(false)
    expect(evaluateCondition({ fieldId: 'owner', operator: 'is_empty' }, { owner: [{ name: 'no id' }] }, typed(fields, r))).toBe(false)
    expect(r.calls).toEqual([{ fieldId: 'owner', fieldType: 'person', operator: 'equals', side: 'record' }])
  })
})

describe('boolean fields accept true/false and "true"/"false"', () => {
  const fields: AutomationConditionField[] = [{ id: 'done', type: 'boolean' }]

  it('compares the parsed boolean', () => {
    expect(evaluateCondition({ fieldId: 'done', operator: 'equals', value: true }, { done: true }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'done', operator: 'equals', value: 'true' }, { done: true }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'done', operator: 'equals', value: false }, { done: 'false' }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'done', operator: 'equals', value: 'FALSE' }, { done: false }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'done', operator: 'equals', value: true }, { done: false }, typed(fields))).toBe(false)
    expect(evaluateCondition({ fieldId: 'done', operator: 'not_equals', value: true }, { done: 'false' }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'done', operator: 'in', value: [true] }, { done: 'true' }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'done', operator: 'not_in', value: [true] }, { done: 'true' }, typed(fields))).toBe(false)
    expect(evaluateCondition({ fieldId: 'done', operator: 'is_empty' }, { done: null }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'done', operator: 'is_empty' }, { done: false }, typed(fields))).toBe(false)
  })

  it('an unreadable boolean never matches and is reported', () => {
    const r = reporter()
    expect(evaluateCondition({ fieldId: 'done', operator: 'equals', value: true }, { done: 'yes' }, typed(fields, r))).toBe(false)
    expect(evaluateCondition({ fieldId: 'done', operator: 'equals', value: 1 }, { done: true }, typed(fields, r))).toBe(false)
    expect(r.calls.map((c) => c.side)).toEqual(['record', 'condition'])
  })
})

describe('number-like fields compare numerically with safe string coercion', () => {
  const fields: AutomationConditionField[] = [
    { id: 'qty', type: 'number' },
    { id: 'price', type: 'currency' },
    { id: 'ratio', type: 'percent' },
    { id: 'stars', type: 'rating' },
    { id: 'took', type: 'duration' },
    { id: 'seq', type: 'autoNumber' },
  ]

  it('"5" equals 5 on either side; ordering works across the coercion', () => {
    expect(evaluateCondition({ fieldId: 'qty', operator: 'equals', value: 5 }, { qty: '5' }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'qty', operator: 'equals', value: '5' }, { qty: 5 }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'qty', operator: 'equals', value: ' 5.0 ' }, { qty: 5 }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'qty', operator: 'not_equals', value: '5' }, { qty: 6 }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'qty', operator: 'greater_than', value: '4' }, { qty: 5 }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'qty', operator: 'greater_than', value: 10 }, { qty: '9' }, typed(fields))).toBe(false)
    expect(evaluateCondition({ fieldId: 'qty', operator: 'less_than', value: 10 }, { qty: '9' }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'qty', operator: 'greater_or_equal', value: '9' }, { qty: 9 }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'qty', operator: 'less_or_equal', value: 8 }, { qty: '9' }, typed(fields))).toBe(false)
    expect(evaluateCondition({ fieldId: 'qty', operator: 'in', value: ['5', 6] }, { qty: 5 }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'qty', operator: 'not_in', value: ['5', 6] }, { qty: 7 }, typed(fields))).toBe(true)
    expect(evaluateCondition({ fieldId: 'qty', operator: 'not_in', value: ['5', 6] }, { qty: '6' }, typed(fields))).toBe(false)
    for (const id of ['price', 'ratio', 'stars', 'took', 'seq']) {
      expect(evaluateCondition({ fieldId: id, operator: 'equals', value: '3' }, { [id]: 3 }, typed(fields))).toBe(true)
    }
  })

  it('empty and unreadable values: is_empty on null/""; "abc" never matches and is reported', () => {
    const r = reporter()
    expect(evaluateCondition({ fieldId: 'qty', operator: 'is_empty' }, { qty: '' }, typed(fields, r))).toBe(true)
    expect(evaluateCondition({ fieldId: 'qty', operator: 'is_empty' }, { qty: 0 }, typed(fields, r))).toBe(false)
    expect(evaluateCondition({ fieldId: 'qty', operator: 'not_equals', value: 5 }, {}, typed(fields, r))).toBe(true)
    expect(evaluateCondition({ fieldId: 'qty', operator: 'equals', value: 5 }, { qty: 'abc' }, typed(fields, r))).toBe(false)
    expect(evaluateCondition({ fieldId: 'qty', operator: 'greater_than', value: 'abc' }, { qty: 5 }, typed(fields, r))).toBe(false)
    expect(evaluateCondition({ fieldId: 'qty', operator: 'equals', value: 5 }, { qty: true }, typed(fields, r))).toBe(false)
    expect(r.calls).toEqual([
      { fieldId: 'qty', fieldType: 'number', operator: 'equals', side: 'record' },
      { fieldId: 'qty', fieldType: 'number', operator: 'greater_than', side: 'condition' },
      { fieldId: 'qty', fieldType: 'number', operator: 'equals', side: 'record' },
    ])
  })
})

describe('groups thread the typed options through nesting', () => {
  it('a nested AND/OR tree mixes typed and legacy leaves', () => {
    const fields: AutomationConditionField[] = [
      { id: 'openedAt', type: 'date' },
      { id: 'owner', type: 'person' },
      { id: 'status', type: 'select' },
    ]
    const group: ConditionGroup = {
      conjunction: 'AND',
      conditions: [
        { fieldId: 'status', operator: 'equals', value: 'Open' },
        {
          conjunction: 'OR',
          conditions: [
            { fieldId: 'owner', operator: 'contains', value: 'u1' },
            { fieldId: 'openedAt', operator: 'equals', value: '2026-09-25' },
          ],
        },
      ],
    }
    const record = { status: 'Open', owner: ['u2'], openedAt: OPENED_AT_INSTANT }
    expect(evaluateConditions(group, record, typed(fields))).toBe(true)
    expect(evaluateConditions(group, { ...record, openedAt: '2026-09-24' }, typed(fields))).toBe(false)
    expect(evaluateConditions(group, { ...record, openedAt: '2026-09-24', owner: ['u1', 'u2'] }, typed(fields))).toBe(true)
    // Without fields the same group is the legacy (broken) evaluation — pinned so the fix is visibly type-driven.
    expect(evaluateConditions(group, record)).toBe(false)
  })
})

describe('save-time validation of condition values by field type', () => {
  const fields: AutomationConditionField[] = [
    { id: 'openedAt', type: 'date' },
    { id: 'dueAt', type: 'dateTime' },
    { id: 'qty', type: 'number' },
    { id: 'done', type: 'boolean' },
    { id: 'title', type: 'string' },
  ]
  const group = (condition: Record<string, unknown>): ConditionGroup => ({
    conjunction: 'AND',
    conditions: [condition as never],
  })
  const codeOf = (fn: () => void): string | null => {
    try {
      fn()
      return null
    } catch (error) {
      return error instanceof ConditionGroupValidationError ? error.code : 'not-a-condition-error'
    }
  }

  it('date values must be YYYY-MM-DD or a parseable date-time; refusals carry AUTOMATION_CONDITION_VALUE_INVALID', () => {
    for (const ok of ['2026-09-25', '2026-09-24T18:00:00.000Z', '2026-09-24 18:00', '2026/9/25', '2026年9月25日']) {
      expect(() => validateConditionGroupAgainstFields(group({ fieldId: 'openedAt', operator: 'equals', value: ok }), fields)).not.toThrow()
    }
    expect(() => validateConditionGroupAgainstFields(group({ fieldId: 'openedAt', operator: 'equals', value: 'yesterday' }), fields))
      .toThrow('conditions.conditions[0].value must be a date (YYYY-MM-DD)')
    expect(() => validateConditionGroupAgainstFields(group({ fieldId: 'openedAt', operator: 'equals', value: '2026-02-30' }), fields))
      .toThrow('conditions.conditions[0].value must be a date (YYYY-MM-DD)')
    expect(() => validateConditionGroupAgainstFields(group({ fieldId: 'openedAt', operator: 'in', value: ['2026-09-25', '25/09/2026'] }), fields))
      .toThrow('conditions.conditions[0].value[1] must be a date (YYYY-MM-DD)')
    expect(codeOf(() => validateConditionGroupAgainstFields(group({ fieldId: 'openedAt', operator: 'equals', value: 'yesterday' }), fields)))
      .toBe(AUTOMATION_CONDITION_VALUE_INVALID_CODE)
    expect(AUTOMATION_CONDITION_VALUE_INVALID_CODE).toBe('AUTOMATION_CONDITION_VALUE_INVALID')
  })

  it('dateTime values must be ISO-8601 or a YYYY-MM-DD[ HH:mm] wall clock', () => {
    for (const ok of ['2026-09-25 09:00', '2026-09-25T09:00:00+08:00', '2026-09-24T18:00:00Z', '2026-09-25']) {
      expect(() => validateConditionGroupAgainstFields(group({ fieldId: 'dueAt', operator: 'equals', value: ok }), fields)).not.toThrow()
    }
    expect(() => validateConditionGroupAgainstFields(group({ fieldId: 'dueAt', operator: 'equals', value: '09:00' }), fields))
      .toThrow('conditions.conditions[0].value must be a date-time (YYYY-MM-DD HH:mm or ISO-8601)')
    expect(() => validateConditionGroupAgainstFields(group({ fieldId: 'dueAt', operator: 'greater_than', value: 'tomorrow' }), fields))
      .toThrow('conditions.conditions[0].value must be a date-time (YYYY-MM-DD HH:mm or ISO-8601)')
    expect(codeOf(() => validateConditionGroupAgainstFields(group({ fieldId: 'dueAt', operator: 'equals', value: '09:00' }), fields)))
      .toBe(AUTOMATION_CONDITION_VALUE_INVALID_CODE)
    // Still a string check first: a number is refused as before.
    expect(() => validateConditionGroupAgainstFields(group({ fieldId: 'dueAt', operator: 'equals', value: 42 }), fields))
      .toThrow('conditions.conditions[0].value must be a string')
  })

  it('number fields accept a numeric string ("5") and refuse "abc" with the value-invalid code', () => {
    expect(() => validateConditionGroupAgainstFields(group({ fieldId: 'qty', operator: 'greater_than', value: '5' }), fields)).not.toThrow()
    expect(() => validateConditionGroupAgainstFields(group({ fieldId: 'qty', operator: 'equals', value: 5 }), fields)).not.toThrow()
    expect(() => validateConditionGroupAgainstFields(group({ fieldId: 'qty', operator: 'equals', value: 'abc' }), fields))
      .toThrow('conditions.conditions[0].value must be a number')
    expect(() => validateConditionGroupAgainstFields(group({ fieldId: 'qty', operator: 'equals', value: '' }), fields))
      .toThrow('conditions.conditions[0].value must be a number')
    expect(codeOf(() => validateConditionGroupAgainstFields(group({ fieldId: 'qty', operator: 'equals', value: 'abc' }), fields)))
      .toBe(AUTOMATION_CONDITION_VALUE_INVALID_CODE)
    expect(codeOf(() => validateConditionGroupAgainstFields(group({ fieldId: 'done', operator: 'equals', value: 'false' }), fields)))
      .toBe(AUTOMATION_CONDITION_VALUE_INVALID_CODE)
  })

  it('field-existence and operator refusals keep the generic VALIDATION_ERROR code', () => {
    expect(codeOf(() => validateConditionGroupAgainstFields(group({ fieldId: 'missing', operator: 'equals', value: 'x' }), fields)))
      .toBe('VALIDATION_ERROR')
    expect(codeOf(() => validateConditionGroupAgainstFields(group({ fieldId: 'qty', operator: 'contains', value: '3' }), fields)))
      .toBe('VALIDATION_ERROR')
    expect(codeOf(() => validateConditionGroupAgainstFields(group({ fieldId: 'qty', operator: 'in', value: [] }), fields)))
      .toBe('VALIDATION_ERROR')
  })
})

describe('preflightAutomationConditionFields validates condition_branch conditions at every nesting', () => {
  const FIELD_ROWS = [
    { id: 'qty', type: 'number', property: {} },
    { id: 'openedAt', type: 'date', property: {} },
    { id: 'title', type: 'string', property: {} },
  ]
  const queryFn = () => vi.fn(async (sql: string) => {
    if (/FROM meta_fields/i.test(sql)) return { rows: FIELD_ROWS, rowCount: FIELD_ROWS.length }
    return { rows: [], rowCount: 0 }
  })
  const branchAction = (conditions: unknown, key = 'hit') => ({
    type: 'condition_branch',
    config: {
      branches: [{ key, conditions, actions: [{ type: 'update_record', config: { fields: { title: 'x' } } }] }],
      defaultBranch: { key: 'fallback', actions: [] },
    },
  })
  const rejection = async (fn: () => Promise<void>): Promise<{ code: string; message: string } | null> => {
    try {
      await fn()
      return null
    } catch (error) {
      if (error instanceof AutomationRuleValidationError) return { code: error.code, message: error.message }
      throw error
    }
  }

  it('a number-field string "abc" inside actions[0] branch conditions is refused; "5" is accepted', async () => {
    const bad = await rejection(() => preflightAutomationConditionFields(queryFn(), 'sheet_1', null, {
      actions: [branchAction({ conjunction: 'AND', conditions: [{ fieldId: 'qty', operator: 'equals', value: 'abc' }] })] as never,
    }))
    expect(bad).toEqual({
      code: 'AUTOMATION_CONDITION_VALUE_INVALID',
      message: 'actions[0].config.branches[0].conditions.conditions[0].value must be a number',
    })
    await expect(preflightAutomationConditionFields(queryFn(), 'sheet_1', null, {
      actions: [branchAction({ conjunction: 'AND', conditions: [{ fieldId: 'qty', operator: 'equals', value: '5' }] })] as never,
    })).resolves.toBeUndefined()
  })

  it('top-level actionConfig of a condition_branch rule and nested groups are covered, with their own paths', async () => {
    const viaActionConfig = await rejection(() => preflightAutomationConditionFields(queryFn(), 'sheet_1', null, {
      actionType: 'condition_branch',
      actionConfig: {
        branches: [
          { key: 'a', conditions: { conjunction: 'AND', conditions: [{ fieldId: 'qty', operator: 'equals', value: 1 }] }, actions: [] },
          {
            key: 'b',
            conditions: {
              conjunction: 'AND',
              conditions: [{ conjunction: 'OR', conditions: [{ fieldId: 'openedAt', operator: 'equals', value: 'yesterday' }] }],
            },
            actions: [],
          },
        ],
      },
    }))
    expect(viaActionConfig).toEqual({
      code: 'AUTOMATION_CONDITION_VALUE_INVALID',
      message: 'actionConfig.branches[1].conditions.conditions[0].conditions[0].value must be a date (YYYY-MM-DD)',
    })
    const unknownField = await rejection(() => preflightAutomationConditionFields(queryFn(), 'sheet_1', null, {
      actions: [branchAction({ conjunction: 'AND', conditions: [{ fieldId: 'ghost', operator: 'equals', value: 'x' }] })] as never,
    }))
    expect(unknownField).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'actions[0].config.branches[0].conditions.conditions[0].fieldId does not exist on sheet: ghost',
    })
  })

  it('top-level conditions and branch conditions are validated together from ONE field read', async () => {
    const query = queryFn()
    const both = await rejection(() => preflightAutomationConditionFields(
      query,
      'sheet_1',
      { conjunction: 'AND', conditions: [{ fieldId: 'openedAt', operator: 'equals', value: '2026-09-25' }] },
      { actions: [branchAction({ conjunction: 'AND', conditions: [{ fieldId: 'qty', operator: 'less_than', value: 'many' }] })] as never },
    ))
    expect(both?.message).toBe('actions[0].config.branches[0].conditions.conditions[0].value must be a number')
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]?.[0]).toMatch(/FROM meta_fields WHERE sheet_id = \$1/)
  })

  it('a branch whose conditions are not even a valid group is left to the service shape validation (no double report); nothing to check ⇒ no DB read', async () => {
    const query = queryFn()
    await expect(preflightAutomationConditionFields(query, 'sheet_1', null, {
      actions: [branchAction('not-a-group')] as never,
    })).resolves.toBeUndefined()
    await expect(preflightAutomationConditionFields(query, 'sheet_1', null, {
      actions: [{ type: 'update_record', config: { fields: { title: 'x' } } }] as never,
    })).resolves.toBeUndefined()
    await expect(preflightAutomationConditionFields(query, 'sheet_1', null, undefined)).resolves.toBeUndefined()
    expect(query).not.toHaveBeenCalled()
  })
})

describe('AutomationExecutor evaluates rule and branch conditions with the sheet field types', () => {
  const RECORD = { openedAt: OPENED_AT_INSTANT, owner: ['u1', 'u2'], title: 'before' }
  const DATE_FIELDS: AutomationConditionField[] = [
    { id: 'openedAt', type: 'date' },
    { id: 'owner', type: 'person' },
    { id: 'title', type: 'string' },
  ]

  function deps(overrides: Partial<AutomationDeps> = {}): AutomationDeps {
    return {
      eventBus: new EventBus(),
      queryFn: vi.fn(async (sql: unknown) => {
        if (typeof sql === 'string' && /FROM meta_sheets/i.test(sql)) return { rows: [{ base_id: 'base_mock' }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }),
      fetchFn: vi.fn(async () => new Response('OK', { status: 200 })) as unknown as typeof fetch,
      ...overrides,
    }
  }

  function rule(overrides: Partial<AutomationRule> = {}): AutomationRule {
    return {
      id: `rule_${Math.random().toString(36).slice(2, 8)}`,
      name: 'typed conditions',
      sheetId: 'sheet_1',
      trigger: { type: 'record.created', config: {} },
      conditions: { conjunction: 'AND', conditions: [{ fieldId: 'openedAt', operator: 'equals', value: '2026-09-25' }] },
      actions: [{ type: 'update_record', config: { fields: { title: 'matched' } } }],
      enabled: true,
      createdBy: 'u_owner',
      createdAt: '2026-09-01T00:00:00.000Z',
      ...overrides,
    }
  }

  const event = { recordId: 'rec_1', sheetId: 'sheet_1', data: RECORD }

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.MULTITABLE_BUSINESS_TIMEZONE
  })

  it('with a field loader the date condition "equals 2026-09-25" fires for a record stored 2026-09-24T18:00Z', async () => {
    process.env.MULTITABLE_BUSINESS_TIMEZONE = 'Asia/Shanghai'
    const loadConditionFields = vi.fn(async () => DATE_FIELDS)
    const executor = new AutomationExecutor(deps({ loadConditionFields }))
    const execution = await executor.execute(rule(), event)
    expect(execution.status).toBe('success')
    expect(execution.steps).toHaveLength(1)
    expect(loadConditionFields).toHaveBeenCalledWith('sheet_1')
    expect(loadConditionFields).toHaveBeenCalledTimes(1)

    const miss = await executor.execute(
      rule({ conditions: { conjunction: 'AND', conditions: [{ fieldId: 'openedAt', operator: 'equals', value: '2026-09-24' }] } }),
      event,
    )
    expect(miss.status).toBe('skipped')
    expect(miss.steps).toHaveLength(0)
  })

  it('a person condition matches the stored id[] only through the typed path', async () => {
    const executor = new AutomationExecutor(deps({ loadConditionFields: async () => DATE_FIELDS }))
    const ownerRule = rule({ conditions: { conjunction: 'AND', conditions: [{ fieldId: 'owner', operator: 'in', value: ['u2', 'u9'] }] } })
    expect((await executor.execute(ownerRule, event)).status).toBe('success')
    const legacy = new AutomationExecutor(deps())
    const strictEquals = rule({ conditions: { conjunction: 'AND', conditions: [{ fieldId: 'owner', operator: 'equals', value: ['u1', 'u2'] }] } })
    expect((await executor.execute(strictEquals, event)).status).toBe('success')
    expect((await legacy.execute(strictEquals, event)).status).toBe('skipped')
  })

  it('no loader (legacy wiring / zero-DB test runs) ⇒ untyped evaluation and NO field query', async () => {
    const d = deps()
    const executor = new AutomationExecutor(d)
    const execution = await executor.execute(rule(), event)
    expect(execution.status).toBe('skipped')
    expect(d.queryFn).not.toHaveBeenCalled()
    // A rule without conditions never asks for fields either.
    const loadConditionFields = vi.fn(async () => DATE_FIELDS)
    const noConditions = new AutomationExecutor(deps({ loadConditionFields }))
    await noConditions.execute(rule({ conditions: undefined }), event)
    expect(loadConditionFields).not.toHaveBeenCalled()
  })

  it('a failing loader degrades to the untyped path with one values-free warning — the run never throws', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const executor = new AutomationExecutor(deps({ loadConditionFields: async () => { throw new Error('boom: secret=abc') } }))
    const execution = await executor.execute(rule(), event)
    expect(execution.status).toBe('skipped')
    const fieldWarns = warn.mock.calls.filter((c) => /condition field types/i.test(String(c[0])))
    expect(fieldWarns).toHaveLength(1)
    expect(JSON.stringify(fieldWarns[0])).not.toContain('secret=abc')
  })

  it('an unreadable stored value warns ONCE per rule, values-free, and the condition evaluates unmatched', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const executor = new AutomationExecutor(deps({ loadConditionFields: async () => DATE_FIELDS }))
    const r = rule()
    const garbage = { ...event, data: { ...RECORD, openedAt: 'secret-legacy-text' } }
    expect((await executor.execute(r, garbage)).status).toBe('skipped')
    expect((await executor.execute(r, garbage)).status).toBe('skipped')
    const valueWarns = warn.mock.calls.filter((c) => /could not be read as the field type/i.test(String(c[0])))
    expect(valueWarns).toHaveLength(1)
    expect(JSON.stringify(valueWarns[0])).not.toContain('secret-legacy-text')
    expect(valueWarns[0]?.[1]).toMatchObject({ ruleId: r.id, fieldId: 'openedAt', fieldType: 'date', operator: 'equals', side: 'record' })
    // A different rule gets its own single warning.
    expect((await executor.execute(rule(), garbage)).status).toBe('skipped')
    expect(warn.mock.calls.filter((c) => /could not be read as the field type/i.test(String(c[0])))).toHaveLength(2)
  })

  it('condition_branch conditions are evaluated with the same field types', async () => {
    const lifecycle: ActionJobLifecycle = {
      onStart: vi.fn(async () => undefined),
      onSettled: vi.fn(async () => undefined),
      onSkipped: vi.fn(async () => undefined),
    }
    const branchRule = rule({
      conditions: undefined,
      executionMode: 'workflow_job_v1',
      actions: [{
        type: 'condition_branch',
        config: {
          branches: [{
            key: 'hit',
            conditions: { conjunction: 'AND', conditions: [{ fieldId: 'openedAt', operator: 'equals', value: '2026-09-25' }] },
            actions: [],
          }],
          defaultBranch: { key: 'fallback', actions: [] },
        },
      }],
    })
    const loadConditionFields = vi.fn(async () => DATE_FIELDS)
    const typedExecutor = new AutomationExecutor(deps({ loadConditionFields }))
    const typedRun = await typedExecutor.execute(branchRule, event, () => lifecycle)
    expect(typedRun.steps[0]?.output).toMatchObject({ selectedBranchKey: 'hit', matched: true })
    expect(loadConditionFields).toHaveBeenCalledTimes(1)

    const legacyRun = await new AutomationExecutor(deps()).execute(branchRule, event, () => lifecycle)
    expect(legacyRun.steps[0]?.output).toMatchObject({ selectedBranchKey: 'fallback', matched: false })
  })
})
