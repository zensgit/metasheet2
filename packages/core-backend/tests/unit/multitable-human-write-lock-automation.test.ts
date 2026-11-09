/**
 * 备料 option B — the human write lock (multitable/human-write-lock.ts) on the RULE-DRIVEN bare-SQL writers.
 *
 * Automations and approval write-backs act on behalf of a rule a PERSON authored (`canManageAutomation`), never as
 * the plugin, so a PLM-system column (`property.humanWriteLock = 'plm_system'`) is closed to them too. They write
 * `meta_records` with bare SQL — none of the person write spines' guards run — so each sink checks on its own:
 *
 *   E-01..E-04  `update_record` / `create_record` naming a locked column fail with the closed code
 *               (`FIELD_READONLY_PLM_SYSTEM: …`, values-free) and mutate nothing — checked at EXECUTION, so a rule
 *               saved before the column was marked is refused too; a step naming only unlocked columns runs as before.
 *   RW-01/02    the approval `resultWriteback` sink (`applyResultWritebackPatch`) refuses a write-back mapped onto a
 *               locked column — thrown inside the transaction, surfaced as `backwriteSkipped`, nothing written; an
 *               unlocked status column still writes once.
 *   FWB-01      approval form write-back (`write_approval_form_values`) needs no new code: its activation AND
 *               execute-time gate (`canUserWriteFwbTargetFields`) derive field permissions, and the lock is folded
 *               into that derivation — pinned here so the dependency is visible (the FWB gate file is unchanged).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/multitable/automation-producer-emit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/multitable/automation-producer-emit')>()
  return { ...actual, enqueueRecordEventIfDurable: vi.fn(async () => false) }
})
vi.mock('../../src/multitable/realtime-publish', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/multitable/realtime-publish')>()
  return { ...actual, publishMultitableSheetRealtime: vi.fn(() => undefined) }
})
const fullCapabilities = {
  canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true, canManageFields: true,
  canManageSheetAccess: true, canManageViews: true, canComment: true, canManageAutomation: true, canExport: true,
}
vi.mock('../../src/services/approval-record-link-txn-auth', () => ({
  resolveSheetCapabilitiesForUserOnQuery: vi.fn(async () => ({ capabilities: fullCapabilities })),
}))
vi.mock('../../src/multitable/permission-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/multitable/permission-service')>()
  return { ...actual, loadFieldPermissionScopeMap: vi.fn(async () => new Map()) }
})

import { EventBus } from '../../src/integration/events/event-bus'
import { Logger } from '../../src/core/logger'
import { poolManager } from '../../src/integration/db/connection-pool'
import { AutomationService } from '../../src/multitable/automation-service'
import { AutomationExecutor, type AutomationDeps, type AutomationRule } from '../../src/multitable/automation-executor'
import { canUserWriteFwbTargetFields } from '../../src/multitable/approval-fwb-activation'

const SHEET = 'sheet_plmro_auto'
const LOCKED = new Set(['fld_plm_key', 'fld_status_locked'])
const LOCK_SQL = 'SELECT id, property FROM meta_fields WHERE sheet_id = $1 AND id = ANY($2::text[])'
const norm = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim()

interface State { statements: string[]; mutations: number; updates: Array<{ recordId: unknown; sheetId: unknown }> }
const fresh = (): State => ({ statements: [], mutations: 0, updates: [] })

function handler(state: State) {
  return async (sql: unknown, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> => {
    const s = norm(sql)
    state.statements.push(s)
    if (s === LOCK_SQL || /^SELECT id, type, property FROM meta_fields WHERE sheet_id = \$1 AND id = ANY/.test(s)) {
      const ids = ((params ?? [])[1] as string[]) ?? []
      const rows = ids.map((id) => ({ id, type: 'string', property: LOCKED.has(id) ? { humanWriteLock: 'plm_system' } : {} }))
      return { rows, rowCount: rows.length }
    }
    if (/meta_record_revisions/i.test(s)) return { rows: [{ seq: '1' }], rowCount: 1 }
    if (/^UPDATE meta_records/i.test(s)) {
      state.mutations += 1
      state.updates.push({ recordId: params?.[1], sheetId: params?.[2] })
      return { rows: [{ version: 2, data: {} }], rowCount: 1 }
    }
    if (/INSERT\s+INTO\s+meta_records/i.test(s)) {
      state.mutations += 1
      return { rows: [{ version: 1 }], rowCount: 1 }
    }
    if (/SELECT[\s\S]*FROM\s+meta_records/i.test(s)) {
      return { rows: [{ locked: false, locked_by: null, created_by: 'u_author', version: 1, data: {} }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }
}

function executorDeps(state: State): AutomationDeps {
  const h = handler(state)
  return { eventBus: new EventBus(), queryFn: vi.fn(h), transaction: vi.fn(async (fn) => fn({ query: vi.fn(h) })) }
}

const rule = (action: { type: string; config: Record<string, unknown> }): AutomationRule => ({
  id: 'rule_plmro', name: 'PLM lock rule', sheetId: SHEET, trigger: { type: 'record.created', config: {} },
  actions: [action as never], enabled: true, createdBy: 'u_author', createdAt: '2026-10-19T00:00:00Z',
}) as AutomationRule

beforeEach(() => {
  delete process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED
  delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
  vi.spyOn(Logger.prototype, 'info').mockImplementation(() => {})
  vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('automation update_record / create_record never write a human-write-locked column', () => {
  const REFUSED = [
    { label: 'E-01 update_record naming the locked column', action: { type: 'update_record', config: { fields: { fld_plm_key: 'HACK' } } } },
    { label: 'E-02 update_record mixing an unlocked and a locked column (refused whole)', action: { type: 'update_record', config: { fields: { fld_notes: 'ok', fld_plm_key: 'HACK' } } } },
    { label: 'E-03 create_record seeding the locked column', action: { type: 'create_record', config: { sheetId: SHEET, data: { fld_plm_key: 'FAKE' } } } },
  ]
  for (const { label, action } of REFUSED) {
    it(`${label} → failed FIELD_READONLY_PLM_SYSTEM, values-free, nothing mutated`, async () => {
      const state = fresh()
      const exec = await new AutomationExecutor(executorDeps(state)).execute(rule(action), { recordId: 'rec_1', sheetId: SHEET, actorId: 'u_author', data: {} })
      expect(exec.steps[0]?.status).toBe('failed')
      expect(exec.steps[0]?.error).toMatch(/^FIELD_READONLY_PLM_SYSTEM: /)
      expect(exec.steps[0]?.error).not.toMatch(/fld_|rec_|sheet_|HACK|FAKE/)
      expect(state.mutations).toBe(0)
      expect(state.statements).toContain(LOCK_SQL)
    })
  }

  it('E-04 control: the same actions on unlocked columns run exactly as before (one mutation each)', async () => {
    for (const action of [
      { type: 'update_record', config: { fields: { fld_notes: 'ok' } } },
      { type: 'create_record', config: { sheetId: SHEET, data: { fld_notes: 'ok' } } },
    ]) {
      const state = fresh()
      const exec = await new AutomationExecutor(executorDeps(state)).execute(rule(action), { recordId: 'rec_1', sheetId: SHEET, actorId: 'u_author', data: {} })
      expect(exec.steps[0]?.status, action.type).toBe('success')
      expect(state.mutations, action.type).toBe(1)
    }
  })
})

describe('approval resultWriteback never writes a human-write-locked column', () => {
  type BridgeLike = { id: string; sheetId: string | null; recordId: string | null; triggerEvent: Record<string, unknown> | null }
  type Internals = {
    writeApprovalResultBack(bridge: BridgeLike, config: Record<string, unknown>, event: unknown): Promise<unknown>
    tryWriteApprovalResultBack(bridge: BridgeLike, config: Record<string, unknown>, event: unknown, result: { actionType: string; status: string; output?: Record<string, unknown> }): Promise<unknown>
    assertResultWritebackFields: (...args: unknown[]) => Promise<void>
  }
  const service = (state: State): Internals => {
    const query = vi.fn(handler(state))
    const svc = new AutomationService(new EventBus(), {} as never, query as never)
    vi.spyOn(poolManager, 'get').mockReturnValue({ query, transaction: (fn: (c: { query: typeof query }) => Promise<unknown>) => fn({ query }) } as never)
    const internals = svc as unknown as Internals
    vi.spyOn(internals, 'assertResultWritebackFields').mockResolvedValue(undefined)
    return internals
  }
  const bridge: BridgeLike = { id: 'aab_plmro', sheetId: SHEET, recordId: 'rec_src', triggerEvent: { actorId: 'u_author', recordId: 'rec_src', _automationDepth: 0 } }
  const event = {
    version: 1, source: 'approval-product', eventType: 'approval.approved', eventId: 'evt_plmro', occurredAt: '2026-10-19T00:00:00.000Z',
    approval: { instanceId: 'ai_plmro', requestNo: 'REQ', templateId: 'tpl_plmro', publishedDefinitionId: 'pd' },
    transition: { toStatus: 'approved' }, actor: { id: 'u_approver' }, requester: { id: 'u_author' },
  }

  it('RW-01 a write-back mapped onto a locked column throws the closed code and writes nothing; an unlocked column writes once', async () => {
    const state = fresh()
    await expect(service(state).writeApprovalResultBack(bridge, { templateId: 'tpl_plmro', resultWriteback: { statusField: 'fld_status_locked' } }, event))
      .rejects.toThrow(/^FIELD_READONLY_PLM_SYSTEM: /)
    expect(state.updates).toEqual([])

    const control = fresh()
    await expect(service(control).writeApprovalResultBack(bridge, { templateId: 'tpl_plmro', resultWriteback: { statusField: 'fld_status_open' } }, event))
      .resolves.toMatchObject({ kind: 'same-base' })
    expect(control.updates).toEqual([{ sheetId: SHEET, recordId: 'rec_src' }])
  })

  it('RW-02 the step reports backwriteSkipped with the values-free closed-code sentence', async () => {
    const state = fresh()
    const step = { actionType: 'start_approval', status: 'success', output: {} as Record<string, unknown> }
    await service(state).tryWriteApprovalResultBack(bridge, { templateId: 'tpl_plmro', resultWriteback: { statusField: 'fld_status_locked' } }, event, step)
    expect(String(step.output.backwriteSkipped)).toMatch(/^FIELD_READONLY_PLM_SYSTEM: /)
    expect(String(step.output.backwriteSkipped)).not.toMatch(/fld_|rec_|sheet_/)
    expect(state.updates).toEqual([])
  })
})

describe('approval form write-back: the existing FWB field gate already refuses a locked target (no FWB code changed)', () => {
  it('FWB-01 canUserWriteFwbTargetFields is false for a locked target in create and update mode; true for an unlocked one', async () => {
    const state = fresh()
    const query = vi.fn(handler(state))
    for (const mode of ['create', 'update'] as const) {
      await expect(canUserWriteFwbTargetFields(query as never, 'u_author', SHEET, ['fld_plm_key'], mode)).resolves.toBe(false)
      await expect(canUserWriteFwbTargetFields(query as never, 'u_author', SHEET, ['fld_notes', 'fld_plm_key'], mode)).resolves.toBe(false)
      await expect(canUserWriteFwbTargetFields(query as never, 'u_author', SHEET, ['fld_notes'], mode)).resolves.toBe(true)
    }
  })
})
