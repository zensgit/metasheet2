/**
 * B1-a1 button/run AUDIT round-trip (wire-vs-fixture-drift guard).
 *
 * The route tests inject a fake `recordAudit`, so they prove the route CALLS
 * audit but NOT that the synthetic `AutomationExecution` the route builds is
 * compatible with the REAL `AutomationLogService.record()` field-by-field
 * serializer (`toPersistedExecutionValues` → kysely insert). Because the audit
 * call site is a swallowing best-effort try/catch, a shape incompatibility would
 * SILENTLY no-op the audit in production while every spy-injected test stayed
 * green — exactly the wire-vs-fixture-drift trap this repo has been bitten by.
 *
 * This test runs the REAL `record()` over the EXACT object the route builds
 * (`buildButtonExecution`) with the kysely `db` mocked to capture the insert,
 * and asserts the row materializes (no throw) with the expected columns.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const insertedValues: unknown[] = []

vi.mock('../../src/db/db', () => {
  const makeChain = (): Record<string, unknown> => {
    const self: Record<string, unknown> = {}
    const chainFn = () => self
    for (const m of ['insertInto', 'updateTable', 'set', 'where', 'returningAll', 'selectFrom', 'select', 'selectAll']) {
      self[m] = vi.fn(chainFn)
    }
    self.values = vi.fn((value: unknown) => {
      insertedValues.push(value)
      return self
    })
    self.execute = vi.fn(async () => [])
    self.executeTakeFirst = vi.fn(async () => undefined)
    return self
  }
  const root: Record<string, unknown> = {}
  for (const m of ['insertInto', 'updateTable', 'selectFrom', 'deleteFrom']) {
    root[m] = vi.fn(() => makeChain())
  }
  return { db: root }
})

import { AutomationLogService } from '../../src/multitable/automation-log-service'
import { buildButtonExecution } from '../../src/routes/multitable-button-run'

/**
 * Extract the interpolated JSON text from a `toJsonValue()` RawBuilder
 * (`sql\`${JSON.stringify(value)}::jsonb\``). Its operation node carries the
 * JSON string as the first ValueNode parameter — this is what actually rides
 * into Postgres, so asserting over it is the real-wire check.
 */
function rawBuilderJson(rb: unknown): string {
  const node = (rb as { toOperationNode?: () => unknown })?.toOperationNode?.() as
    | { parameters?: Array<{ value?: unknown }> }
    | undefined
  const value = node?.parameters?.[0]?.value
  return typeof value === 'string' ? value : JSON.stringify(value ?? null)
}

describe('B1-a1 button/run audit round-trip (real record(), mocked db)', () => {
  beforeEach(() => {
    insertedValues.length = 0
  })

  it('a SUCCESS button execution round-trips through the real record() serializer (no throw, correct columns)', async () => {
    const exec = buildButtonExecution({
      executionId: 'axe_btn_sheet1_fld1_123',
      ruleId: 'button:fld1',
      sheetId: 'sheet1',
      actorId: 'u_actor',
      actionType: 'record_click',
      status: 'success',
      error: null,
      triggerEvent: { _source: 'button_run', sheetId: 'sheet1', recordId: 'rec1', fieldId: 'fld1', actorId: 'u_actor' },
    })

    const svc = new AutomationLogService()
    await expect(svc.record(exec)).resolves.toBeUndefined()

    expect(insertedValues).toHaveLength(1)
    const row = insertedValues[0] as Record<string, unknown>
    expect(row.id).toBe('axe_btn_sheet1_fld1_123')
    expect(row.rule_id).toBe('button:fld1')
    expect(row.triggered_by).toBe('u_actor')
    expect(row.status).toBe('success')
    expect(row.sheet_id).toBe('sheet1')
    // `steps` rides into the row as a kysely jsonb RawBuilder (`<json>::jsonb`);
    // it must be PRESENT (the field-by-field projection serialized it without
    // throwing) and its interpolated JSON must carry the inert record_click step.
    expect(row.steps).toBeTruthy()
    expect(rawBuilderJson(row.steps)).toContain('record_click')
    // a null ruleSnapshot must NOT break the field-by-field serializer.
    expect(row.rule_snapshot).toBeNull()
    expect(row.error).toBeNull()
  })

  it('a FAILED button execution round-trips and carries the error', async () => {
    const exec = buildButtonExecution({
      executionId: 'axe_btn_sheet1_fld1_456',
      ruleId: 'button:fld1',
      sheetId: 'sheet1',
      actorId: 'u_actor',
      actionType: 'record_click',
      status: 'failed',
      error: 'dispatch failed somehow',
      triggerEvent: { _source: 'button_run' },
    })

    const svc = new AutomationLogService()
    await expect(svc.record(exec)).resolves.toBeUndefined()

    const row = insertedValues[0] as Record<string, unknown>
    expect(row.status).toBe('failed')
    expect(row.error).toBe('dispatch failed somehow')
    expect(rawBuilderJson(row.steps)).toContain('dispatch failed somehow')
  })
})
