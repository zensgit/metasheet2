/**
 * #6155 — an EXISTING rule with trigger `record.deleted` and action `delete_record` (same base, i.e. the trigger
 * record) that an operator switched OFF in the automation panel can be switched back ON from the same panel.
 *
 * Before: PATCH `{ enabled: false }` answered 200, then PATCH `{ enabled: true }` answered
 * 400 DELETED_TRIGGER_SELF_MUTATION, so the only way back was a database edit. The rule's shape did not change,
 * and a rule of this shape that is already on keeps firing (each run ends as skipped, #6078), so an enable-only
 * PATCH no longer runs the deleted-trigger shape check. Everything that creates the shape or changes a rule INTO it
 * stays refused — including `enabled: true` sent TOGETHER with a shape field.
 *
 * Through the REAL router (univer-meta PATCH/POST/GET automations) and the REAL AutomationService: only the
 * database seams are mocked. The Kysely mock is stateful (an UPDATE merges its SET into the stored row and the
 * next read returns it), so "the stored flag" is read back through the list route, not assumed. The transport is
 * the pinned per-suite server (#4154: never `request(app)`).
 */
import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

const SHEET_ID = 'sheet_reenable_1'
const RULE_ID = 'atr_reenable_1'
const AUTOMATIONS = `/api/multitable/sheets/${SHEET_ID}/automations`
const RULE_URL = `${AUTOMATIONS}/${RULE_ID}`
const CODE = 'DELETED_TRIGGER_SELF_MUTATION'
const MESSAGE = '记录删除时触发记录已不存在，不能再修改/删除/锁定它'

function storedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RULE_ID,
    sheet_id: SHEET_ID,
    name: 'Record-deleted sample rule',
    trigger_type: 'record.deleted',
    trigger_config: {},
    action_type: 'delete_record',
    action_config: {},
    enabled: true,
    created_at: '2026-09-20T00:00:00.000Z',
    updated_at: '2026-09-20T00:00:00.000Z',
    created_by: 'admin_1',
    conditions: null,
    actions: [{ type: 'delete_record', config: {} }],
    execution_mode: null,
    ...overrides,
  }
}

/** A stateful Kysely stand-in for the one `automation_rules` row the suite is about. */
function makeRuleTable(initial: Record<string, unknown> | undefined) {
  let stored = initial ? { ...initial } : undefined
  let verb = ''
  let pendingSet: Record<string, unknown> | null = null
  const sets: Record<string, unknown>[] = []
  const inserts: Record<string, unknown>[] = []
  const chain: Record<string, unknown> = {}
  const self = () => chain
  for (const m of [
    'selectAll', 'select', 'where', 'orderBy', 'limit', 'offset', 'groupBy',
    'onConflict', 'columns', 'doUpdateSet', 'returningAll', 'leftJoin',
  ]) {
    chain[m] = vi.fn(self)
  }
  chain.selectFrom = vi.fn(() => { verb = 'select'; return chain })
  chain.insertInto = vi.fn(() => { verb = 'insert'; return chain })
  chain.updateTable = vi.fn(() => { verb = 'update'; return chain })
  chain.deleteFrom = vi.fn(() => { verb = 'delete'; return chain })
  chain.values = vi.fn((row: unknown) => { inserts.push(row as Record<string, unknown>); return chain })
  chain.set = vi.fn((row: unknown) => { pendingSet = row as Record<string, unknown>; sets.push(pendingSet); return chain })
  chain.execute = vi.fn(async () => {
    if (verb === 'update') {
      if (!stored) return []
      stored = { ...stored, ...(pendingSet ?? {}) }
      return [stored]
    }
    if (verb === 'select') return stored ? [stored] : []
    return []
  })
  chain.executeTakeFirst = vi.fn(async () => stored)
  return {
    chain,
    sets: () => sets,
    inserts: () => inserts,
    stored: () => stored,
  }
}

function createMockPool() {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    // Sheet liveness (`SELECT deleted_at …`) and the plain existence reads: only THE sheet resolves.
    if (sql.includes('FROM meta_sheets') && sql.includes('WHERE id = $1')) {
      const rows = params?.[0] === SHEET_ID ? [{ id: SHEET_ID, deleted_at: null }] : []
      return { rows, rowCount: rows.length }
    }
    return { rows: [], rowCount: 0 }
  })
  const transaction = vi.fn(async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }))
  return { query, transaction }
}

const pinned = usePinnedServer()

async function mountApp(initial: Record<string, unknown> | undefined) {
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(true),
    userHasPermission: vi.fn().mockResolvedValue(true),
    listUserPermissions: vi.fn().mockResolvedValue(['workflow:write', 'multitable:write']),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))

  const { poolManager } = await import('../../src/integration/db/connection-pool')
  // The service class comes from the SAME module graph as the router, so the route's
  // `instanceof AutomationRuleValidationError` sees the service's own error class.
  const { AutomationService, setAutomationServiceInstance } = await import('../../src/multitable/automation-service')
  const { EventBus } = await import('../../src/integration/events/event-bus')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')

  const pool = createMockPool()
  vi.spyOn(poolManager, 'get').mockReturnValue(pool as never)
  const table = makeRuleTable(initial)
  // No rule here carries a notification / DingTalk / approval action, so the service's own raw reads answer empty.
  const serviceQuery = vi.fn(async () => ({ rows: [], rowCount: 0 }))
  const service = new AutomationService(new EventBus(), table.chain as never, serviceQuery as never)
  setAutomationServiceInstance(service)

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    req.user = {
      id: 'admin_1',
      role: 'admin',
      roles: ['admin'],
      perms: ['workflow:write', 'multitable:write'],
    }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  pinned.setApp(app)

  return { table, service, setAutomationServiceInstance }
}

async function listedEnabled(): Promise<unknown> {
  const res = await request(pinned.url()).get(AUTOMATIONS)
  expect(res.status).toBe(200)
  const rule = (res.body.data.rules as Array<{ id: string; enabled: boolean }>).find((r) => r.id === RULE_ID)
  return rule?.enabled
}

describe('#6155 — switching an existing record-deleted rule back on through the PATCH route', () => {
  let cleanup: (() => void) | null = null
  afterEach(() => {
    cleanup?.()
    cleanup = null
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('the customer sequence: on → PATCH { enabled:false } 200 → PATCH { enabled:true } 200, and the stored flag is true again', async () => {
    const { table, setAutomationServiceInstance } = await mountApp(storedRow({ enabled: true }))
    cleanup = () => setAutomationServiceInstance(null)

    const off = await request(pinned.url()).patch(RULE_URL).send({ enabled: false })
    expect(off.status).toBe(200)
    expect(off.body.data.rule.enabled).toBe(false)
    expect(await listedEnabled()).toBe(false)

    const on = await request(pinned.url()).patch(RULE_URL).send({ enabled: true })
    expect(on.status).toBe(200)
    expect(on.body.ok).toBe(true)
    expect(on.body.data.rule.enabled).toBe(true)
    // Nothing but the flag (and the timestamp) was written: the rule's shape is exactly the one it had.
    expect(table.sets()).toHaveLength(2)
    expect(Object.keys(table.sets()[1]).sort()).toEqual(['enabled', 'updated_at'])
    expect(table.sets()[1].enabled).toBe(true)
    expect(table.stored()).toMatchObject({ trigger_type: 'record.deleted', action_type: 'delete_record', enabled: true })
    expect(await listedEnabled()).toBe(true)
  })

  it('an enable PATCH that ALSO carries a shape field (the editor save with enabled) is still refused 400, and the flag stays off', async () => {
    const { table, setAutomationServiceInstance } = await mountApp(storedRow({ enabled: false }))
    cleanup = () => setAutomationServiceInstance(null)

    const res = await request(pinned.url()).patch(RULE_URL).send({
      enabled: true,
      actionType: 'delete_record',
      actionConfig: {},
      actions: [{ type: 'delete_record', config: {} }],
    })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ ok: false, error: { code: CODE, message: MESSAGE } })
    expect(table.sets()).toHaveLength(0)
    expect(await listedEnabled()).toBe(false)
  })

  it('creating the shape through POST is still refused 400 (unchanged)', async () => {
    const { table, setAutomationServiceInstance } = await mountApp(undefined)
    cleanup = () => setAutomationServiceInstance(null)

    const res = await request(pinned.url()).post(AUTOMATIONS).send({
      name: 'Record-deleted sample rule',
      triggerType: 'record.deleted',
      triggerConfig: {},
      actionType: 'delete_record',
      actionConfig: {},
      actions: [{ type: 'delete_record', config: {} }],
    })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ ok: false, error: { code: CODE, message: MESSAGE } })
    expect(table.inserts()).toHaveLength(0)
  })
})
