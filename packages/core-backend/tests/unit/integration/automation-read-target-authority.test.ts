import { describe, expect, it } from 'vitest'
import { lockAutomationReadTarget, type AutomationReadTargetInput } from '../../../src/integration/automation-read-target-authority'
import type { Queryable } from '../../../src/multitable/automation-durable-dispatcher'

type Row = Record<string, unknown>
const input: AutomationReadTargetInput = {
  actorId: 'synthetic-owner', baseId: 'synthetic-base', sheetId: 'synthetic-sheet', fieldIds: ['active', 'projectNo'],
}
// Real policy functions consume these SQL row fixtures; this is not a PG lock proof.
function fixture() {
  return {
    isolation: 'read committed', xids: ['101', '101'],
    bases: [{ id: input.baseId, deleted_at: null }] as Row[],
    sheets: [{ id: input.sheetId, base_id: input.baseId, deleted_at: null, row_level_read_permissions_enabled: false }] as Row[],
    fields: [{ id: 'active', sheet_id: input.sheetId, type: 'boolean', property: {} },
      { id: 'projectNo', sheet_id: input.sheetId, type: 'string', property: {} }] as Row[],
    users: [{ role: 'user', permissions: [], is_active: true, rbac_admin: false }] as Row[],
    permissions: [{ code: 'multitable:read' }] as Row[],
    sheetScopes: [] as Row[], fieldScopes: [] as Row[],
  }
}
function harness(data = fixture(), failure?: string, before?: (sql: string) => void) {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  let probes = 0
  const trx: Queryable = { async query(sql, params = []) {
    calls.push({ sql, params })
    before?.(sql)
    if (failure && sql.includes(failure)) {
      throw Object.assign(new Error('synthetic_private_detail field_permissions spreadsheet_permissions'), { code: '42P01' })
    }
    const rows = sql.includes('current_setting') ? [{ isolation: data.isolation }]
      : sql.includes('pg_current_xact_id') ? [{ xid: data.xids[probes++] }]
        : sql.startsWith('LOCK TABLE') ? []
          : sql.includes('FROM meta_bases') ? data.bases
            : sql.includes('row_level_read_permissions_enabled') ? data.sheets
              : sql.includes('FROM meta_fields') ? data.fields
                : sql.includes('SELECT role, permissions') ? data.users
                  : sql.includes('AS effective_permissions') ? data.permissions
                    : sql.includes('FROM spreadsheet_permissions') ? data.sheetScopes
                      : sql.includes('FROM field_permissions') ? data.fieldScopes
                        : sql.startsWith('SELECT deleted_at FROM meta_sheets') ? data.sheets
                          : sql.includes('FROM meta_sheets') && sql.includes('base_id =') ? [] : null
    if (!rows) throw new Error('Unexpected fixture SQL')
    return { rows, rowCount: rows.length }
  } }
  return { trx, calls }
}
async function denied(data: ReturnType<typeof fixture>) {
  await expect(lockAutomationReadTarget(harness(data).trx, input)).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_AUTHORITY_DENIED' })
}

describe('Automation target read prerequisite: real policy with SQL fixtures', () => {
  it('allows a non-admin with full read, returns no permission/config values and freezes the closed projection', async () => {
    const { trx, calls } = harness()
    const result = await lockAutomationReadTarget(trx, input)
    expect(result).toEqual({ ...input, fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.fieldIds)).toBe(true)
    expect(calls.some(call => /FROM meta_records|INSERT|UPDATE|DELETE|BEGIN|COMMIT/.test(call.sql))).toBe(false)
    expect(calls.filter(call => call.sql.startsWith('LOCK TABLE'))[0].sql).toMatch(/record_permissions IN SHARE MODE NOWAIT/)
    expect(calls.filter(call => call.sql.includes('FOR SHARE NOWAIT'))).toHaveLength(3)
  })
  it('retains legitimate sheet-specific read rather than requiring platform admin', async () => {
    const data = fixture()
    data.permissions = []
    data.sheetScopes = [{ sheet_id: input.sheetId, perm_code: 'spreadsheet:read', subject_type: 'user' }]
    await expect(lockAutomationReadTarget(harness(data).trx, input)).resolves.toHaveProperty('sheetId', input.sheetId)
  })
  it('copies input before awaiting and uses canonical order independent of driver collation', async () => {
    const mutable = { ...input, fieldIds: ['projectNo', 'active'] }
    const data = fixture()
    data.fields.reverse()
    const { trx } = harness(data, undefined, () => { mutable.actorId = 'foreign'; mutable.fieldIds.length = 0 })
    const result = await lockAutomationReadTarget(trx, mutable)
    expect(result).toMatchObject(input)
    expect(result.fingerprint).toBe((await lockAutomationReadTarget(harness().trx, input)).fingerprint)
  })
  it.each([null, {}, [], { ...input, extra: true }, { ...input, actorId: '' }, { ...input, actorId: ' padded' },
    { ...input, baseId: 'bad\n' }, { ...input, fieldIds: [] }, { ...input, fieldIds: ['active', 'active'] },
    { ...input, fieldIds: [''] }, { ...input, fieldIds: new Array(257).fill('x') }, { ...input, fieldIds: null },
  ])('rejects invalid input without querying (%#)', async bad => {
    const { trx, calls } = harness()
    await expect(lockAutomationReadTarget(trx, bad as AutomationReadTargetInput)).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_INPUT_INVALID' })
    expect(calls).toHaveLength(0)
  })
  it.each(['repeatable read', 'serializable', ''])('requires real read-committed, not %s', async isolation => {
    const data = fixture(); data.isolation = isolation
    await expect(lockAutomationReadTarget(harness(data).trx, input)).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_TRANSACTION_REQUIRED' })
  })
  it('rejects autocommit-shaped xids', async () => {
    const data = fixture(); data.xids = ['101', '102']
    await expect(lockAutomationReadTarget(harness(data).trx, input)).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_TRANSACTION_REQUIRED' })
  })
  it.each(['bases', 'sheets', 'fields', 'users'] as const)('denies missing %s', async key => {
    const data = fixture(); data[key] = []; await denied(data)
  })
  it.each(['bases', 'sheets'] as const)('denies soft-deleted %s', async key => {
    const data = fixture(); data[key][0].deleted_at = '2026-10-01'; await denied(data)
  })
  it.each(['bases', 'sheets', 'fields'] as const)('rejects foreign IDs in %s', async key => {
    const data = fixture(); data[key][0].id = 'foreign'; await denied(data)
  })
  it('rejects wrong sheet base and wrong field sheet', async () => {
    const data = fixture(); data.sheets[0].base_id = 'foreign'; await denied(data)
    const next = fixture(); next.fields[0].sheet_id = 'foreign'; await denied(next)
  })
  it('denies no-read, disabled actors and sheet-specific deny', async () => {
    const noRead = fixture(); noRead.permissions = []; await denied(noRead)
    const disabled = fixture(); disabled.users[0].is_active = false; await denied(disabled)
    const scoped = fixture(); scoped.sheetScopes = [{ sheet_id: input.sheetId, subject_type: 'user', perm_code: 'none' }]; await denied(scoped)
  })
  it('rejects full-row access when non-admin row policy is enabled, without querying records', async () => {
    const data = fixture(); data.sheets[0].row_level_read_permissions_enabled = true
    const { trx, calls } = harness(data)
    await expect(lockAutomationReadTarget(trx, input)).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_AUTHORITY_DENIED' })
    expect(calls.some(call => /meta_records/.test(call.sql))).toBe(false)
    data.users[0].rbac_admin = true
    await expect(lockAutomationReadTarget(harness(data).trx, input)).resolves.toHaveProperty('sheetId', input.sheetId)
  })
  it.each([undefined, null, 0, 'false'])('does not interpret missing/malformed row flag as false: %s', async value => {
    const data = fixture(); data.sheets[0].row_level_read_permissions_enabled = value
    await expect(lockAutomationReadTarget(harness(data).trx, input)).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_AUTHORITY_UNAVAILABLE' })
  })
  it.each([{ hidden: true }, { visible: false }])('denies required hidden field even for admin: %j', async property => {
    const data = fixture(); data.users[0].rbac_admin = true; data.fields[0].property = property; await denied(data)
  })
  it('applies scope deny-wins even for admin and accepts read-only fields', async () => {
    const data = fixture(); data.users[0].rbac_admin = true
    data.fieldScopes = [{ field_id: 'active', visible: true, read_only: true }]
    await expect(lockAutomationReadTarget(harness(data).trx, input)).resolves.toHaveProperty('sheetId')
    data.fieldScopes.push({ field_id: 'active', visible: false, read_only: false }); await denied(data)
  })
  it.each(['formula', 'lookup', 'rollup', 'link', 'person', 'attachment', 'button', 'unknown', ' STRING '])('rejects unsupported stored type %s', async type => {
    const data = fixture(); data.fields[0].type = type; await denied(data)
  })
  it.each([null, '', false])('rejects even inert own mirrorOf value %s', async mirrorOf => {
    const data = fixture(); data.fields[0].property = { mirrorOf }; await denied(data)
  })
  it.each([[], 'bad', false, undefined])('requires typed property object or null (%#)', async property => {
    const data = fixture(); data.fields[0].property = property
    await expect(lockAutomationReadTarget(harness(data).trx, input)).rejects.toMatchObject({ code: 'AUTOMATION_TARGET_AUTHORITY_UNAVAILABLE' })
  })
  it('accepts null property and changes fingerprint for target field changes', async () => {
    const first = await lockAutomationReadTarget(harness().trx, input)
    const data = fixture(); data.fields[0].property = null
    expect((await lockAutomationReadTarget(harness(data).trx, input)).fingerprint).toBe(first.fingerprint)
    data.fields[0].property = { label: 'synthetic changed' }
    expect((await lockAutomationReadTarget(harness(data).trx, input)).fingerprint).not.toBe(first.fingerprint)
  })
  it.each(['LOCK TABLE', 'FROM meta_bases', 'row_level_read_permissions_enabled', 'FROM meta_fields',
    'SELECT role, permissions', 'AS effective_permissions', 'FROM spreadsheet_permissions', 'FROM field_permissions'])(
    'sanitizes failure including legacy caught missing-table fallback: %s', async failure => {
    let caught: unknown
    try { await lockAutomationReadTarget(harness(fixture(), failure).trx, input) } catch (error) { caught = error }
    expect(caught).toMatchObject({ code: 'AUTOMATION_TARGET_AUTHORITY_UNAVAILABLE' })
    expect(caught).not.toHaveProperty('cause')
    expect(String(caught)).not.toContain('synthetic_private_detail')
  })
})
