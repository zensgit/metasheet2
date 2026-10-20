/**
 * Subscription webhook delivery rules — unit (U1, U2, U3a, U5, U15).
 *
 * The real rules module runs; everything it reads is stubbed: the read transaction hands it a scripted
 * query function, and the database-fresh access loader, the sheet capability resolver, the row-deny reads
 * and the read-path field set are replaced with fixtures. Each case states the rule it checks and has a
 * positive counterpart where the rule is a refusal.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest'

type Fixture = {
  sheetRow: { system_kind: string | null; description: string | null } | undefined
  userRow: Record<string, unknown> | undefined
  access: { userId: string; permissions: string[]; isAdminRole: boolean }
  capabilities: Record<string, boolean>
  liveness: 'live' | 'deleted' | 'absent'
  rowDeny: boolean
  recordLive: boolean
  recordDenied: boolean
  readable: Set<string>
  accessError: Error | null
}

const fx = vi.hoisted(() => ({ current: null as unknown as Fixture }))
const calls = vi.hoisted(() => ({ filter: 0 }))

function baseFixture(): Fixture {
  return {
    sheetRow: { system_kind: null, description: null },
    userRow: { is_active: true, role: 'user', activation_status: 'activated', must_change_password: false },
    access: { userId: 'owner1', permissions: ['multitable:read', 'workflow:write'], isAdminRole: false },
    capabilities: { canRead: true, canManageAutomation: true },
    liveness: 'live',
    rowDeny: false,
    recordLive: true,
    recordDenied: false,
    readable: new Set(['fld_pub']),
    accessError: null,
  }
}

vi.mock('../../src/multitable/webhook-authority-transaction', () => ({
  runWebhookDeliveryCheck: async (_db: unknown, fn: (query: unknown) => Promise<unknown>) => {
    const query = async (text: string) => {
      if (text.includes('FROM meta_sheets')) return { rows: fx.current.sheetRow ? [fx.current.sheetRow] : [] }
      if (text.includes('FROM users')) return { rows: fx.current.userRow ? [fx.current.userRow] : [] }
      if (text.includes('FROM meta_records')) return { rows: fx.current.recordLive ? [{ '?column?': 1 }] : [] }
      throw new Error(`unscripted query: ${text}`)
    }
    return fn(query)
  },
}))

vi.mock('../../src/multitable/recovery-authorization-stability', () => ({
  loadDatabaseFreshRecoveryAccess: async () => {
    if (fx.current.accessError) throw fx.current.accessError
    return fx.current.access
  },
}))

vi.mock('../../src/multitable/permission-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/multitable/permission-service')>()
  return {
    ...actual,
    resolveSheetCapabilitiesForAccess: async (_q: unknown, _sheetId: string, access: unknown) => ({
      access,
      capabilities: fx.current.capabilities,
      capabilityOrigin: { source: 'global-rbac', hasSheetAssignments: false },
      sheetLiveness: fx.current.liveness,
    }),
    loadRowLevelReadDenyEnabledStrict: async () => fx.current.rowDeny,
    isRecordReadDeniedForUserStrict: async () => fx.current.recordDenied,
  }
})

vi.mock('../../src/routes/univer-meta', () => ({
  loadReadableRecordFieldIdsForAccess: async () => fx.current.readable,
  // Same body as the read-path export; counted so the cases can assert it is the function applied.
  filterRecordDataByFieldIds: (data: unknown, allowed: Set<string>) => {
    calls.filter += 1
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
    return Object.fromEntries(Object.entries(data as Record<string, unknown>).filter(([k]) => allowed.has(k)))
  },
}))

import { authorizeWebhookDelivery } from '../../src/multitable/webhook-delivery-authority'

const SHEET = 'sheet_bound'
const webhook = { id: 'wh1', createdBy: 'owner1', sheetId: SHEET as string | null }
const db = {} as never
const decide = (event: string, payload: unknown, target = webhook) => authorizeWebhookDelivery(db, target, event, payload)

beforeEach(() => {
  fx.current = baseFixture()
  calls.filter = 0
})

describe('U1 envelope allow-list and value-map filter', () => {
  const input = {
    sheetId: SHEET,
    recordId: 'rec1',
    data: { fld_pub: 'a', fld_hidden: 'b' },
    changes: { fld_pub: 'c', fld_other: 'd' },
    actorId: 'actor1',
    _eventId: 'evt1',
    _automationDepth: 1,
    nodeKey: 'node1',
    entryEpoch: 3,
    somethingNew: 'x',
  }

  test('U1.envelope only sheetId, recordId and the value maps are delivered', async () => {
    const decision = await decide('record.created', input)
    expect(decision.deliver, 'U1.envelope.deliver').toBe(true)
    const body = (decision as { payload: Record<string, unknown> }).payload
    expect(Object.keys(body).sort(), 'U1.envelope.keys').toEqual(['changes', 'data', 'recordId', 'sheetId'])
  })

  test('U1.values each value map keeps only readable fields, through the read-path filter', async () => {
    const decision = await decide('record.created', input)
    const body = (decision as { payload: Record<string, unknown> }).payload
    expect(body.data, 'U1.values.data').toEqual({ fld_pub: 'a' })
    expect(body.changes, 'U1.values.changes').toEqual({ fld_pub: 'c' })
    expect(calls.filter, 'U1.values.byName').toBe(2)
  })
})

describe('U2 the event sheet must equal the bound sheet', () => {
  test('U2.missing no sheetId → not delivered', async () => {
    const decision = await decide('record.created', { recordId: 'rec1' })
    expect(decision.deliver, 'U2.missing.deliver').toBe(false)
    expect((decision as { reason: string }).reason, 'U2.missing.reason').toBe('sheet_mismatch')
  })
  test('U2.nonString sheetId not a string → not delivered', async () => {
    const decision = await decide('record.created', { sheetId: 42, recordId: 'rec1' })
    expect(decision.deliver, 'U2.nonString.deliver').toBe(false)
  })
  test('U2.mismatch a different sheet → not delivered', async () => {
    const decision = await decide('record.created', { sheetId: 'sheet_other', recordId: 'rec1' })
    expect(decision.deliver, 'U2.mismatch.deliver').toBe(false)
  })
  test('U2.nullBinding an unbound webhook → not delivered', async () => {
    const decision = await decide('record.created', { sheetId: SHEET, recordId: 'rec1' }, { ...webhook, sheetId: null })
    expect(decision.deliver, 'U2.nullBinding.deliver').toBe(false)
    expect((decision as { reason: string }).reason, 'U2.nullBinding.reason').toBe('no_sheet_binding')
  })
  test('U2+ the bound sheet → delivered', async () => {
    const decision = await decide('record.created', { sheetId: SHEET, recordId: 'rec1' })
    expect(decision.deliver, 'U2+.deliver').toBe(true)
  })
})

describe('U3a a failed check refuses', () => {
  test('U3a the access read throws → not delivered, reason authority_check_failed', async () => {
    fx.current.accessError = Object.assign(new Error('connection reset'), { code: '08006' })
    const decision = await decide('record.created', { sheetId: SHEET, recordId: 'rec1' })
    expect(decision.deliver, 'U3a.deliver').toBe(false)
    expect((decision as { reason: string }).reason, 'U3a.reason').toBe('authority_check_failed')
  })
})

describe('U5 an update whose every value was masked is not delivered; id-only updates are', () => {
  test('U5a values present, all removed by the mask → not delivered', async () => {
    const decision = await decide('record.updated', { sheetId: SHEET, recordId: 'rec1', changes: { fld_hidden: 1 } })
    expect(decision.deliver, 'U5a.deliver').toBe(false)
    expect((decision as { reason: string }).reason, 'U5a.reason').toBe('all_values_masked')
  })
  test('U5b no value map (approval write-back shape) → delivered as ids only', async () => {
    const decision = await decide('record.updated', { sheetId: SHEET, recordId: 'rec1', nodeKey: 'n', entryEpoch: 2 })
    expect(decision.deliver, 'U5b.deliver').toBe(true)
    expect(Object.keys((decision as { payload: Record<string, unknown> }).payload).sort(), 'U5b.keys').toEqual(['recordId', 'sheetId'])
  })
  test('U5c an empty value map → delivered', async () => {
    const decision = await decide('record.updated', { sheetId: SHEET, recordId: 'rec1', changes: {} })
    expect(decision.deliver, 'U5c.deliver').toBe(true)
  })
  test('U5d some values remain after the mask → delivered with them', async () => {
    const decision = await decide('record.updated', { sheetId: SHEET, recordId: 'rec1', changes: { fld_pub: 1, fld_hidden: 2 } })
    expect(decision.deliver, 'U5d.deliver').toBe(true)
    expect((decision as { payload: Record<string, unknown> }).payload.changes, 'U5d.changes').toEqual({ fld_pub: 1 })
  })
})

describe('U15 the owner must pass the login gate', () => {
  test('U15 an unrecognised activation status → not delivered', async () => {
    fx.current.userRow = { ...fx.current.userRow, activation_status: 'not_a_status' }
    const decision = await decide('record.created', { sheetId: SHEET, recordId: 'rec1' })
    expect(decision.deliver, 'U15.deliver').toBe(false)
    expect((decision as { reason: string }).reason, 'U15.reason').toBe('owner_gate')
  })
  test('U15+ activated → delivered', async () => {
    fx.current.userRow = { ...fx.current.userRow, activation_status: 'activated' }
    const decision = await decide('record.created', { sheetId: SHEET, recordId: 'rec1' })
    expect(decision.deliver, 'U15+.deliver').toBe(true)
  })
})
