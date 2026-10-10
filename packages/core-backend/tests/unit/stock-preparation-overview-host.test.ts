/**
 * 一个项目一张备料表 — S3 项目总览表, HOST HALF (ADR adr-stock-prep-project-sheets-20261008 §5 「只读（Q5）」;
 * owner ruling Q5 2026-10-08: 宿主级只读 + O1 + O2(a)). Mock query functions, no DB — the real-DB twin is the
 * `S3 overview` case in tests/integration/stock-prep-w2-scoped-repair-realdb.test.ts.
 *
 *   (a) the kind: `stock_prep_overview` is a recognized server-owned system kind (both kind lists agree),
 *       it is NOT hidden from sheet lists, and the delete guard refuses the sheet;
 *   (b) provisioning: the stamp rides the sheet INSERT as $5 only when asked, the un-stamped INSERT is
 *       byte-identical to the pre-S3 statement, an unknown kind throws before any IO, an existing row's kind
 *       is never rewritten, and ensureObject forwards the stamp;
 *   (c) the plugin-scope gate: only (plugin-integration-core, the overview kind, the overview object id) is
 *       admitted, every other combination is a typed 403 with nothing called, values are read once;
 *   (d) the clamp: on an overview sheet every person — a non-admin holding every write code, a floor role
 *       holding a sheet grant, a platform admin — resolves read + export and nothing else, through ALL
 *       THREE capability resolvers; an ordinary sheet is untouched;
 *   (e) the lookup: no query for no ids, the column-tolerant SQL and the kind param.
 *
 * FIX ROUND 1 (R1 / R8c / R12 / E1) — appended blocks (f)–(l): the clamp KEEPS access management (so the
 * overview can be granted for reading) and ignores any write / admin row; the derived-id prefilter means an
 * ordinary id costs no statement in any resolver; provisioning refuses the overview stamp on a non-derived
 * id and refuses to ADOPT an existing sheet of another kind inside its transaction; the G1 READ port
 * (service census + wrapper); the host's `supportsSystemKindStamp` declaration; the index.ts `systemKind`
 * plumbing pin; the template-install response carries no `systemKind: null`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn(),
  listUserPermissions: vi.fn(),
}))

import type { ResolvedRequestAccess } from '../../src/multitable/access'
import { SYSTEM_SHEET_KINDS as CHECKPOINT_SYSTEM_SHEET_KINDS } from '../../src/multitable/history-trust-checkpoint'
import { MULTITABLE_MANAGE_SCHEMA_PERMISSION } from '../../src/multitable/manage-schema-permission'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { deriveRecordPermissions } from '../../src/multitable/permission-derivation'
import { resolveSheetCapabilitiesForAccess, type QueryFn } from '../../src/multitable/permission-service'
import {
  MultitableProjectNamespaceError,
  MultitableSheetScopeError,
  assertPluginOwnsSheet,
  createPluginScopedMultitableApi,
} from '../../src/multitable/plugin-scope'
import {
  createSheet,
  ensureObject,
  ensureSheet,
  findObjectSheet,
  getObjectSheetId,
  type MultitableProvisioningQueryFn,
} from '../../src/multitable/provisioning'
import { resolveSheetCapabilitiesForUser } from '../../src/multitable/sheet-capabilities'
import { isSystemManagedSheet, resolveSheetDeleteRefusal } from '../../src/multitable/sheet-delete-guard'
import {
  STOCK_PREPARATION_OVERVIEW_GRANT_PERM_CODE,
  STOCK_PREPARATION_OVERVIEW_PORT_PLUGIN,
  STOCK_PREPARATION_OVERVIEW_SHEET_ID_PATTERN,
  STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID,
  STOCK_PREPARATION_PROJECT_OVERVIEW_SYSTEM_KIND,
  SheetSystemKindConflictError,
  StockPreparationOverviewStructureWriteError,
  StockPreparationOverviewSystemKindError,
  isStockPreparationOverviewGrantableAccessLevel,
  isStockPreparationOverviewSheetIdCandidate,
  loadStockPreparationOverviewSheetIds,
  restrictStockPreparationOverviewCapabilities,
} from '../../src/multitable/stock-preparation-overview-contract'
import { StockPreparationProjectSheetGrantError } from '../../src/multitable/stock-preparation-project-sheet-grant-contract'
import {
  grantStockPreparationOverviewRoleRead,
  stockPreparationOverviewGrantEntityId,
} from '../../src/services/stock-preparation-overview-grants'
import { MULTITABLE_SUBMIT_APPROVAL_PERMISSION } from '../../src/multitable/submit-approval-permission'
import {
  SYSTEM_SHEET_KINDS,
  STOCK_PREP_OVERVIEW_SHEET_KIND,
  isHiddenSystemSheet,
  isSystemSheet,
  isSystemSheetKind,
} from '../../src/multitable/system-sheet-predicate'
import { isAdmin, listUserPermissions } from '../../src/rbac/service'
import { resolveSheetCapabilitiesForUserOnQuery } from '../../src/services/approval-record-link-txn-auth'

const KIND = 'stock_prep_overview'
const OVERVIEW_SQL = "SELECT id FROM meta_sheets WHERE id = ANY($1::text[]) AND (to_jsonb(meta_sheets) ->> 'system_kind') = $2"
const UNSTAMPED_SHEET_INSERT_SQL = 'INSERT INTO meta_sheets (id, base_id, name, description)\n     VALUES ($1, $2, $3, $4)\n     ON CONFLICT (id) DO NOTHING'
const KEPT = new Set(['canRead', 'canExport', 'canManageSheetAccess'])
const WRITE_KEYS = [
  'canCreateRecord',
  'canEditRecord',
  'canDeleteRecord',
  'canManageFields',
  'canManageViews',
  'canComment',
  'canManageAutomation',
  'canSendNotification',
  'canSubmitApproval',
] as const

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim()

/** Fix round 1: every overview id is host-derived (`sheet_` + 24 hex) — the prefilter only looks at those. */
const OV_PROJECT = 'tenant_1:integration-core'
const OV_SHEET = getObjectSheetId(OV_PROJECT, STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID)
/** A derived id that is NOT stamped (another plugin object) — the lookup runs for it and answers "no". */
const DERIVED_PLAIN_SHEET = getObjectSheetId(OV_PROJECT, 'plm_stock_preparation_main')

// ── (a) the kind ─────────────────────────────────────────────────────────────────────────────────────

describe('S3 host — the stock_prep_overview system kind', () => {
  it('is a recognized server-owned system kind, under the exported constant, in BOTH kind lists', () => {
    expect(STOCK_PREP_OVERVIEW_SHEET_KIND).toBe(KIND)
    expect(STOCK_PREPARATION_PROJECT_OVERVIEW_SYSTEM_KIND).toBe(KIND)
    expect(SYSTEM_SHEET_KINDS).toContain(KIND)
    expect(isSystemSheetKind(KIND)).toBe(true)
    expect(isSystemSheet({ systemKind: KIND })).toBe(true)
    // The checkpoint module keeps its own denormalized list; the two must not drift.
    expect([...CHECKPOINT_SYSTEM_SHEET_KINDS].sort()).toEqual([...SYSTEM_SHEET_KINDS].sort())
    // Neighbouring strings are not the kind.
    expect(isSystemSheetKind('stock_prep_overview ')).toBe(false)
    expect(isSystemSheetKind('STOCK_PREP_OVERVIEW')).toBe(false)
  })

  it('stays LISTED: isHiddenSystemSheet is false for it (only the People kind is hidden)', () => {
    expect(isHiddenSystemSheet({ system_kind: KIND, description: null })).toBe(false)
    expect(isHiddenSystemSheet({ system_kind: KIND, description: 'anything' })).toBe(false)
  })

  it('the delete guard refuses it (system-managed), and an unstamped sheet is not refused (control)', async () => {
    const guardQuery = (kind: string | null, registryOwner: string | null) => vi.fn(async (sql: string) => {
      const q = normalize(sql)
      if (q.startsWith("SELECT (to_jsonb(meta_sheets) ->> 'system_kind') AS system_kind, description FROM meta_sheets")) {
        return { rows: [{ system_kind: kind, description: null }] }
      }
      if (q.includes('FROM plugin_multitable_object_registry')) {
        return { rows: registryOwner ? [{ plugin_name: registryOwner }] : [] }
      }
      throw new Error(`Unhandled SQL in delete-guard fake: ${q}`)
    })
    await expect(isSystemManagedSheet(guardQuery(KIND, null) as never, 'sheet_overview')).resolves.toBe(true)
    await expect(resolveSheetDeleteRefusal(guardQuery(KIND, null) as never, 'sheet_overview')).resolves.toBe('system-managed')
    await expect(isSystemManagedSheet(guardQuery(null, null) as never, 'sheet_plain')).resolves.toBe(false)
    await expect(resolveSheetDeleteRefusal(guardQuery(null, null) as never, 'sheet_plain')).resolves.toBeNull()
  })
})

// ── (b) provisioning ─────────────────────────────────────────────────────────────────────────────────

type FakeSheetRow = { id: string; base_id: string; name: string; description: string | null; system_kind: string | null }

function createProvisioningQuery(seed: FakeSheetRow[] = []) {
  const sheets: FakeSheetRow[] = [...seed]
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params })
    const q = normalize(sql)
    if (q.startsWith('INSERT INTO meta_bases')) return { rows: [], rowCount: 1 }
    if (q.startsWith('INSERT INTO meta_sheets')) {
      const [id, baseId, name, description, systemKind] = params as [string, string, string, string | null, string | undefined]
      if (sheets.some((row) => row.id === id)) return { rows: [], rowCount: 0 }
      sheets.push({ id, base_id: baseId, name, description, system_kind: systemKind ?? null })
      return { rows: [], rowCount: 1 }
    }
    if (q.startsWith('UPDATE meta_sheets')) throw new Error('provisioning must never UPDATE meta_sheets')
    if (q.startsWith("SELECT id, base_id, name, description, (to_jsonb(meta_sheets) ->> 'system_kind') AS system_kind FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL")) {
      return { rows: sheets.filter((row) => row.id === params[0]) }
    }
    if (q.includes('FROM meta_fields')) return { rows: [] }
    throw new Error(`Unhandled SQL in provisioning fake: ${q}`)
  })
  const sheetInserts = () => calls.filter((call) => normalize(call.sql).startsWith('INSERT INTO meta_sheets'))
  return { query: query as unknown as MultitableProvisioningQueryFn & typeof query, sheets, calls, sheetInserts }
}

describe('S3 host — provisioning stamps system_kind at INSERT only', () => {
  it('ensureSheet with the kind INSERTs the 5-column statement with the kind as $5 and returns it', async () => {
    const fake = createProvisioningQuery()
    const sheet = await ensureSheet({ query: fake.query, sheetId: OV_SHEET, baseId: 'base_x', name: ' Overview ', description: null, systemKind: KIND })
    const [insert] = fake.sheetInserts()
    expect(normalize(insert.sql)).toBe('INSERT INTO meta_sheets (id, base_id, name, description, system_kind) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING')
    expect(insert.params).toEqual([OV_SHEET, 'base_x', 'Overview', null, KIND])
    expect(sheet).toEqual({ id: OV_SHEET, baseId: 'base_x', name: 'Overview', description: null, systemKind: KIND })
  })

  it('without a kind (undefined or null) the INSERT is BYTE-IDENTICAL to the pre-S3 4-column statement', async () => {
    for (const systemKind of [undefined, null]) {
      const fake = createProvisioningQuery()
      const sheet = await ensureSheet({ query: fake.query, sheetId: 'sheet_plain', baseId: 'base_x', name: 'Plain', description: 'd', ...(systemKind === undefined ? {} : { systemKind }) })
      const [insert] = fake.sheetInserts()
      expect(insert.sql).toBe(UNSTAMPED_SHEET_INSERT_SQL)
      expect(insert.params).toEqual(['sheet_plain', 'base_x', 'Plain', 'd'])
      expect(sheet.systemKind).toBeNull()

      const created = createProvisioningQuery()
      await createSheet({ query: created.query, sheetId: 'sheet_plain', baseId: 'base_x', name: 'Plain', description: 'd', ...(systemKind === undefined ? {} : { systemKind }) })
      expect(created.sheetInserts()[0].sql).toBe(UNSTAMPED_SHEET_INSERT_SQL)
      expect(created.sheetInserts()[0].params).toHaveLength(4)
    }
  })

  it('createSheet stamps the same way', async () => {
    const fake = createProvisioningQuery()
    const result = await createSheet({ query: fake.query, sheetId: OV_SHEET, baseId: 'base_x', name: 'Overview', systemKind: KIND })
    expect(normalize(fake.sheetInserts()[0].sql)).toContain('(id, base_id, name, description, system_kind) VALUES ($1, $2, $3, $4, $5)')
    expect(fake.sheetInserts()[0].params[4]).toBe(KIND)
    expect(result).toEqual({ created: true, sheet: { id: OV_SHEET, baseId: 'base_x', name: 'Overview', description: null, systemKind: KIND } })
  })

  it('an unknown or malformed kind throws "unknown system kind" BEFORE any IO (ensureSheet, createSheet, ensureObject)', async () => {
    for (const bogus of ['bogus_kind', '', ' stock_prep_overview', 42, {}]) {
      const fake = createProvisioningQuery()
      await expect(ensureSheet({ query: fake.query, sheetId: 's', baseId: null, name: 'n', systemKind: bogus as never })).rejects.toThrow('unknown system kind')
      await expect(createSheet({ query: fake.query, sheetId: 's', baseId: null, name: 'n', systemKind: bogus as never })).rejects.toThrow('unknown system kind')
      await expect(ensureObject({
        query: fake.query,
        projectId: 'tenant_1:integration-core',
        baseId: null,
        descriptor: { id: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID, name: 'Overview', fields: [] },
        systemKind: bogus as never,
      })).rejects.toThrow('unknown system kind')
      expect(fake.calls).toEqual([])
    }
  })

  it('never rewrites an EXISTING row\'s kind (ON CONFLICT DO NOTHING, no UPDATE) and (fix round 1, R8c) refuses to ADOPT it: SheetSystemKindConflictError, kind stays null', async () => {
    const fake = createProvisioningQuery([{ id: OV_SHEET, base_id: 'base_x', name: 'Old', description: null, system_kind: null }])
    const error = await ensureSheet({ query: fake.query, sheetId: OV_SHEET, baseId: 'base_x', name: 'Old', systemKind: KIND }).then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(SheetSystemKindConflictError)
    expect(error).toMatchObject({ status: 409, code: 'SHEET_SYSTEM_KIND_CONFLICT' })
    expect(fake.calls.some((call) => /\bUPDATE\b/i.test(call.sql))).toBe(false)
    expect(fake.sheets.find((row) => row.id === OV_SHEET)?.system_kind).toBeNull()
    // Without a kind the same existing sheet is ensured as before (the guard only acts on a stamped ensure).
    const plain = createProvisioningQuery([{ id: OV_SHEET, base_id: 'base_x', name: 'Old', description: null, system_kind: null }])
    await expect(ensureSheet({ query: plain.query, sheetId: OV_SHEET, baseId: 'base_x', name: 'Old' })).resolves.toMatchObject({ id: OV_SHEET, systemKind: null })
  })

  it('fix round 1 (R8c): a stamped ensureObject onto an existing UNSTAMPED sheet throws before ensureFields — no field statement runs', async () => {
    const fake = createProvisioningQuery([{ id: OV_SHEET, base_id: 'base_x', name: 'Squatter', description: null, system_kind: null }])
    await expect(ensureObject({
      query: fake.query,
      projectId: OV_PROJECT,
      baseId: 'base_x',
      descriptor: { id: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID, name: 'Overview', fields: [{ id: 'projectNo', name: 'Project', type: 'string' }] },
      systemKind: KIND,
    })).rejects.toBeInstanceOf(SheetSystemKindConflictError)
    expect(fake.calls.some((call) => /meta_fields/i.test(call.sql))).toBe(false)
  })

  it('fix round 1 (R12): the overview stamp is refused on any id outside the derived-id shape, before any IO (ensureSheet, createSheet)', async () => {
    for (const sheetId of ['sheet_ov', 'sheet_0123456789abcdef0123456', `${OV_SHEET}x`, OV_SHEET.toUpperCase(), `sheet_${'g'.repeat(24)}`]) {
      const fake = createProvisioningQuery()
      await expect(ensureSheet({ query: fake.query, sheetId, baseId: 'base_x', name: 'n', systemKind: KIND })).rejects.toThrow('system kind not admitted for this sheet id')
      await expect(createSheet({ query: fake.query, sheetId, baseId: 'base_x', name: 'n', systemKind: KIND })).rejects.toThrow('system kind not admitted for this sheet id')
      expect(fake.calls).toEqual([])
    }
    // Other kinds keep their own id rules (not this one).
    const people = createProvisioningQuery()
    await expect(ensureSheet({ query: people.query, sheetId: 'sheet_people_x', baseId: 'base_x', name: 'People', systemKind: 'people_directory' })).resolves.toMatchObject({ systemKind: 'people_directory' })
  })

  it('ensureObject forwards the kind to ensureSheet, and findObjectSheet reads it back', async () => {
    const projectId = 'tenant_1:integration-core'
    const fake = createProvisioningQuery()
    const result = await ensureObject({
      query: fake.query,
      projectId,
      baseId: 'base_x',
      descriptor: { id: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID, name: 'Overview', fields: [] },
      systemKind: KIND,
    })
    expect(fake.sheetInserts()[0].params[4]).toBe(KIND)
    expect(result.sheet.systemKind).toBe(KIND)
    const found = await findObjectSheet(fake.query, projectId, STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID)
    expect(found?.id).toBe(getObjectSheetId(projectId, STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID))
    expect(found?.systemKind).toBe(KIND)

    // …and without one, ensureObject keeps the 4-column INSERT.
    const plain = createProvisioningQuery()
    const plainResult = await ensureObject({ query: plain.query, projectId, baseId: 'base_x', descriptor: { id: 'plm_other', name: 'Other', fields: [] } })
    expect(plain.sheetInserts()[0].sql).toBe(UNSTAMPED_SHEET_INSERT_SQL)
    expect(plainResult.sheet.systemKind).toBeNull()
  })
})

// ── (c) the plugin-scope gate ────────────────────────────────────────────────────────────────────────

describe('S3 host — the plugin-scope ensureObject gate admits exactly one (plugin, kind, object) triple', () => {
  const PROJECT = 'tenant_1:integration-core'
  const overviewInput = () => ({
    projectId: PROJECT,
    baseId: 'base_integration-core_x',
    descriptor: { id: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID, name: 'Overview', fields: [] },
    systemKind: KIND,
  })
  const build = (pluginName: string, withHook: boolean) => {
    const hostEnsureObject = vi.fn(async (input: { projectId: string; descriptor: { id: string } }) => ({
      baseId: 'base_x',
      sheet: { id: getObjectSheetId(input.projectId, input.descriptor.id), baseId: 'base_x', name: 'Overview', description: null, systemKind: KIND },
      fields: [],
    }))
    const ensureObjectInScope = vi.fn(async (input: { projectId: string; descriptor: { id: string } }) => hostEnsureObject(input))
    const assertObjectScope = vi.fn(async () => {})
    const claimObjectScope = vi.fn(async () => {})
    const api = createPluginScopedMultitableApi(
      { provisioning: { ensureObject: hostEnsureObject }, records: {} } as never,
      pluginName,
      (withHook ? { ensureObjectInScope, assertObjectScope, claimObjectScope } : { assertObjectScope, claimObjectScope }) as never,
    )
    return { api, hostEnsureObject, ensureObjectInScope, assertObjectScope, claimObjectScope }
  }
  const expectRefused = async (promise: Promise<unknown>, reason: 'plugin' | 'kind' | 'object') => {
    const error = await promise.then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(StockPreparationOverviewSystemKindError)
    expect(error).toMatchObject({ status: 403, code: 'MULTITABLE_SYSTEM_KIND_FORBIDDEN', details: { reason } })
  }

  it('the port plugin is plugin-integration-core', () => {
    expect(STOCK_PREPARATION_OVERVIEW_PORT_PLUGIN).toBe('plugin-integration-core')
    expect(STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID).toBe('plm_stock_preparation_project_overview')
  })

  it('(i) another plugin naming the right kind and object id is refused 403; neither the hook nor the host is called', async () => {
    for (const withHook of [true, false]) {
      const s = build('plugin-after-sales', withHook)
      await expectRefused(s.api.provisioning.ensureObject({ ...overviewInput(), projectId: 'tenant_1:after-sales' }), 'plugin')
      expect(s.ensureObjectInScope).not.toHaveBeenCalled()
      expect(s.hostEnsureObject).not.toHaveBeenCalled()
      expect(s.assertObjectScope).not.toHaveBeenCalled()
      expect(s.claimObjectScope).not.toHaveBeenCalled()
    }
    // An `integration-core`-namespaced alias that is not the exact plugin name is not the port plugin either.
    const alias = build('integration-core', true)
    await expectRefused(alias.api.provisioning.ensureObject(overviewInput()), 'plugin')
    expect(alias.ensureObjectInScope).not.toHaveBeenCalled()
  })

  it('(ii) the right plugin naming another recognized kind is refused', async () => {
    for (const kind of ['people_directory', 'approval_projection', 'elearning_projection', 'bogus', '']) {
      const s = build('plugin-integration-core', true)
      await expectRefused(s.api.provisioning.ensureObject({ ...overviewInput(), systemKind: kind }), 'kind')
      expect(s.ensureObjectInScope).not.toHaveBeenCalled()
      expect(s.hostEnsureObject).not.toHaveBeenCalled()
    }
  })

  it('(iii) the right plugin and kind on any other object is refused', async () => {
    for (const objectId of ['plm_stock_preparation_main', 'plm_stock_preparation_sandbox_p_0123456789abcdef01234567', `${STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID}_x`]) {
      const s = build('plugin-integration-core', false)
      await expectRefused(s.api.provisioning.ensureObject({ ...overviewInput(), descriptor: { id: objectId, name: 'x', fields: [] } }), 'object')
      expect(s.hostEnsureObject).not.toHaveBeenCalled()
      expect(s.assertObjectScope).not.toHaveBeenCalled()
    }
  })

  it('(iv) the exact triple reaches the hook WITH systemKind, and (no hook) the host ensureObject WITH systemKind', async () => {
    const hooked = build('plugin-integration-core', true)
    const viaHook = await hooked.api.provisioning.ensureObject(overviewInput())
    expect(hooked.ensureObjectInScope).toHaveBeenCalledTimes(1)
    expect(hooked.ensureObjectInScope).toHaveBeenCalledWith(expect.objectContaining({
      pluginName: 'plugin-integration-core',
      projectId: PROJECT,
      systemKind: KIND,
      descriptor: expect.objectContaining({ id: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID }),
    }))
    expect(viaHook.sheet.systemKind).toBe(KIND)

    const bare = build('plugin-integration-core', false)
    await bare.api.provisioning.ensureObject(overviewInput())
    expect(bare.hostEnsureObject).toHaveBeenCalledWith(expect.objectContaining({ projectId: PROJECT, systemKind: KIND }))
    expect(bare.assertObjectScope).toHaveBeenCalledWith({ pluginName: 'plugin-integration-core', projectId: PROJECT, objectId: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID })
    expect(bare.claimObjectScope).toHaveBeenCalledWith(expect.objectContaining({ objectId: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID }))
  })

  it('(v) without systemKind the call is unchanged: the hook gets exactly { pluginName, ...input } (no systemKind key added)', async () => {
    for (const pluginName of ['plugin-integration-core', 'plugin-after-sales']) {
      const s = build(pluginName, true)
      const projectId = pluginName === 'plugin-after-sales' ? 'tenant_1:after-sales' : PROJECT
      const input = { projectId, descriptor: { id: 'serviceTicket', name: 'Ticket', fields: [] }, overwriteMode: 'refuse' as const }
      await s.api.provisioning.ensureObject(input as never)
      expect(s.ensureObjectInScope.mock.calls[0][0]).toStrictEqual({ pluginName, ...input })
      // null is "absent", too — forwarded as given, never refused.
      const n = build(pluginName, false)
      await n.api.provisioning.ensureObject({ ...input, systemKind: null } as never)
      expect(n.hostEnsureObject).toHaveBeenCalledTimes(1)
    }
  })

  it('the project namespace is still checked first, and the gate reads each value ONCE (the checked values are forwarded)', async () => {
    const s = build('plugin-integration-core', true)
    await expect(s.api.provisioning.ensureObject({ ...overviewInput(), projectId: 'tenant_1:after-sales' })).rejects.toBeInstanceOf(MultitableProjectNamespaceError)
    expect(s.ensureObjectInScope).not.toHaveBeenCalled()

    // A getter that shows the gate the admitted values and would show the host different ones.
    let kindReads = 0
    let idReads = 0
    const descriptor = {
      get id() { idReads += 1; return idReads === 1 ? STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID : 'plm_stock_preparation_main' },
      name: 'Overview',
      fields: [],
    }
    const input = {
      projectId: PROJECT,
      descriptor,
      get systemKind() { kindReads += 1; return kindReads === 1 ? KIND : 'people_directory' },
    }
    const g = build('plugin-integration-core', false)
    await g.api.provisioning.ensureObject(input as never)
    const forwarded = g.hostEnsureObject.mock.calls[0][0] as unknown as { systemKind: string; descriptor: { id: string } }
    expect(forwarded.systemKind).toBe(KIND)
    expect(forwarded.descriptor.id).toBe(STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID)
  })
})

// ── (d) the clamp, through all three resolvers ───────────────────────────────────────────────────────

const EVERY_WRITE_CODE = [
  'multitable:read',
  'multitable:write',
  'multitable:share',
  MULTITABLE_MANAGE_SCHEMA_PERMISSION,
  MULTITABLE_SUBMIT_APPROVAL_PERMISSION,
  'comments:write',
  'workflow:all',
]

type ClampPremise = { overview: boolean; sheetCodes?: string[] }

/** Answers every statement the three resolvers issue for one ordinary-id sheet. */
function clampQuery(sheetId: string, premise: ClampPremise): QueryFn & ReturnType<typeof vi.fn> {
  return vi.fn(async (sql: string, params: unknown[] = []) => {
    const q = normalize(sql)
    if (q === OVERVIEW_SQL) {
      const ids = Array.isArray(params[0]) ? (params[0] as string[]) : []
      expect(params[1]).toBe(KIND)
      return { rows: premise.overview && ids.includes(sheetId) ? [{ id: sheetId }] : [] }
    }
    if (q === 'SELECT deleted_at FROM meta_sheets WHERE id = $1') return { rows: [{ deleted_at: null }] }
    if (q.includes('FROM spreadsheet_permissions')) {
      return { rows: (premise.sheetCodes ?? []).map((code) => ({ sheet_id: sheetId, perm_code: code, subject_type: 'role' })) }
    }
    if (q === 'SELECT id FROM meta_sheets WHERE id = ANY($1::text[]) AND base_id = $2') return { rows: [] }
    return { rows: [] }
  }) as never
}

const accessOf = (permissions: string[], isAdminRole: boolean): ResolvedRequestAccess => ({
  userId: 'u_s3_clamp',
  permissions,
  isAdminRole,
})

const PERSONS: Array<{ label: string; permissions: string[]; isAdminRole: boolean; sheetCodes: string[] }> = [
  { label: 'a non-admin holding every write code', permissions: EVERY_WRITE_CODE, isAdminRole: false, sheetCodes: [] },
  { label: 'a floor role holding only a spreadsheet:write sheet grant', permissions: [], isAdminRole: false, sheetCodes: ['spreadsheet:write'] },
  { label: 'a platform admin', permissions: [], isAdminRole: true, sheetCodes: [] },
]

/**
 * Clamped = read stays TRUE, export is exactly what the same person resolves on an ordinary sheet (the
 * clamp keeps it as resolved — it never grants export to a floor role that lacks it), every other can* false.
 */
function expectClamped(caps: Record<string, unknown>, plain: Record<string, unknown>) {
  expect(caps.canRead).toBe(true)
  expect(caps.canExport).toBe(plain.canExport)
  // Fix round 1 (R1): access management is kept EXACTLY as the same person resolves it on an ordinary sheet.
  expect(caps.canManageSheetAccess).toBe(plain.canManageSheetAccess)
  for (const key of WRITE_KEYS) expect(caps[key], key).toBe(false)
  for (const [key, value] of Object.entries(caps)) {
    if (key.startsWith('can') && !KEPT.has(key)) expect(value, key).toBe(false)
  }
}

describe('S3 host — every person resolves read + export only on the overview (admins included)', () => {
  beforeEach(() => {
    vi.mocked(isAdmin).mockReset()
    vi.mocked(listUserPermissions).mockReset()
  })

  for (const person of PERSONS) {
    it(`resolveSheetCapabilitiesForAccess (REST): ${person.label}`, async () => {
      const sheetId = OV_SHEET
      // Control first: the SAME person on an ordinary sheet keeps record writes — the clamp is what removes them.
      const plain = await resolveSheetCapabilitiesForAccess(clampQuery(sheetId, { overview: false, sheetCodes: person.sheetCodes }), sheetId, accessOf(person.permissions, person.isAdminRole))
      expect(plain.capabilities).toMatchObject({ canRead: true, canCreateRecord: true, canEditRecord: true, canDeleteRecord: true })
      const overview = await resolveSheetCapabilitiesForAccess(clampQuery(sheetId, { overview: true, sheetCodes: person.sheetCodes }), sheetId, accessOf(person.permissions, person.isAdminRole))
      expectClamped(overview.capabilities as unknown as Record<string, unknown>, plain.capabilities as unknown as Record<string, unknown>)
      expect(overview.sheetLiveness).toBe('live')
      if (person.permissions.length > 0 || person.isAdminRole) expect(overview.capabilities.canExport).toBe(true)
    })

    it(`resolveSheetCapabilitiesForUser (Yjs / collab / API token): ${person.label}`, async () => {
      vi.mocked(isAdmin).mockResolvedValue(person.isAdminRole)
      vi.mocked(listUserPermissions).mockResolvedValue(person.permissions)
      const sheetId = OV_SHEET
      const plain = await resolveSheetCapabilitiesForUser(clampQuery(sheetId, { overview: false, sheetCodes: person.sheetCodes }) as never, sheetId, 'u_s3_clamp')
      expect(plain.capabilities).toMatchObject({ canRead: true, canCreateRecord: true, canEditRecord: true })
      const overview = await resolveSheetCapabilitiesForUser(clampQuery(sheetId, { overview: true, sheetCodes: person.sheetCodes }) as never, sheetId, 'u_s3_clamp')
      expectClamped(overview.capabilities as unknown as Record<string, unknown>, plain.capabilities as unknown as Record<string, unknown>)
    })

    it(`resolveSheetCapabilitiesForUserOnQuery (automation FWB / record-permission routes): ${person.label}`, async () => {
      const sheetId = OV_SHEET
      const precomputed = { isAdminRole: person.isAdminRole, permissions: person.permissions }
      const plain = await resolveSheetCapabilitiesForUserOnQuery(clampQuery(sheetId, { overview: false, sheetCodes: person.sheetCodes }), sheetId, 'u_s3_clamp', undefined, precomputed)
      expect(plain.capabilities).toMatchObject({ canRead: true, canCreateRecord: true, canEditRecord: true })
      const overview = await resolveSheetCapabilitiesForUserOnQuery(clampQuery(sheetId, { overview: true, sheetCodes: person.sheetCodes }), sheetId, 'u_s3_clamp', undefined, precomputed)
      expectClamped(overview.capabilities as unknown as Record<string, unknown>, plain.capabilities as unknown as Record<string, unknown>)
    })
  }

  it('the clamp never GRANTS read: a person who cannot read the overview still cannot', async () => {
    const sheetId = OV_SHEET
    const resolved = await resolveSheetCapabilitiesForAccess(clampQuery(sheetId, { overview: true }), sheetId, accessOf([], false))
    expect(resolved.capabilities.canRead).toBe(false)
    expect(resolved.capabilities.canExport).toBe(false)
    for (const key of WRITE_KEYS) expect(resolved.capabilities[key]).toBe(false)
  })

  it('an ordinary DERIVED-id sheet: the admin keeps canEditRecord (the lookup was asked and answered "not an overview")', async () => {
    const sheetId = DERIVED_PLAIN_SHEET
    const query = clampQuery(sheetId, { overview: false })
    const resolved = await resolveSheetCapabilitiesForAccess(query, sheetId, accessOf([], true))
    expect(resolved.capabilities.canEditRecord).toBe(true)
    expect(resolved.capabilities.canManageFields).toBe(true)
    expect('stockPrepOverview' in resolved).toBe(false)
    // The lookup WAS asked (for an admin too — no isAdminRole short-circuit), with the sheet id and the kind.
    const lookups = query.mock.calls.filter(([sql]) => normalize(sql as string) === OVERVIEW_SQL)
    expect(lookups).toHaveLength(1)
    expect(lookups[0][1]).toEqual([[sheetId], KIND])
  })

  it('fix round 1 (R12): an ordinary NON-derived id costs NO overview statement in any of the three resolvers', async () => {
    vi.mocked(isAdmin).mockResolvedValue(true)
    vi.mocked(listUserPermissions).mockResolvedValue([])
    for (const sheetId of ['sheet_plain', `sheet_${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`, 'sheet_orders']) {
      const q1 = clampQuery(sheetId, { overview: true })
      const viaAccess = await resolveSheetCapabilitiesForAccess(q1, sheetId, accessOf([], true))
      const q2 = clampQuery(sheetId, { overview: true })
      const viaUser = await resolveSheetCapabilitiesForUser(q2 as never, sheetId, 'u_s3_clamp')
      const q3 = clampQuery(sheetId, { overview: true })
      const viaQuery = await resolveSheetCapabilitiesForUserOnQuery(q3, sheetId, 'u_s3_clamp', undefined, { isAdminRole: true, permissions: [] })
      for (const q of [q1, q2, q3]) {
        expect(q.mock.calls.filter(([sql]) => /system_kind/.test(normalize(sql as string))), sheetId).toEqual([])
      }
      // …even though the fake WOULD have answered "overview" had it been asked: the prefilter, not the
      // answer, is what kept the admin's writes.
      expect(viaAccess.capabilities.canEditRecord).toBe(true)
      expect(viaUser.capabilities.canEditRecord).toBe(true)
      expect(viaQuery.capabilities.canEditRecord).toBe(true)
    }
  })

  it('fix round 1 (R1): access management is KEPT as resolved — an admin keeps it, a write-grant holder never had it — and the overview flag rides the REST result', async () => {
    const admin = await resolveSheetCapabilitiesForAccess(clampQuery(OV_SHEET, { overview: true }), OV_SHEET, accessOf([], true))
    expect(admin.capabilities.canManageSheetAccess).toBe(true)
    expect(admin.capabilities.canEditRecord).toBe(false)
    expect(admin.stockPrepOverview).toBe(true)
    const sharer = await resolveSheetCapabilitiesForAccess(clampQuery(OV_SHEET, { overview: true }), OV_SHEET, accessOf(['multitable:read', 'multitable:share'], false))
    expect(sharer.capabilities.canManageSheetAccess).toBe(true)
    expect(sharer.capabilities.canCreateRecord).toBe(false)
    const floor = await resolveSheetCapabilitiesForAccess(clampQuery(OV_SHEET, { overview: true, sheetCodes: ['spreadsheet:write'] }), OV_SHEET, accessOf([], false))
    expect(floor.capabilities.canManageSheetAccess).toBe(false)
    expect(floor.capabilities.canRead).toBe(true)
  })

  it('fix round 1 (R1): a spreadsheet:write OR admin grant on the overview is IGNORED by the clamp — read only, and a record-level write grant edits nothing', async () => {
    for (const code of ['spreadsheet:write', 'spreadsheet:admin']) {
      const resolved = await resolveSheetCapabilitiesForAccess(clampQuery(OV_SHEET, { overview: true, sheetCodes: [code] }), OV_SHEET, accessOf([], false))
      expect(resolved.capabilities.canRead, code).toBe(true)
      for (const key of WRITE_KEYS) expect(resolved.capabilities[key], `${code} ${key}`).toBe(false)
      // A record-level write/admin grant on an overview row cannot reopen editing: the derivation needs canEditRecord.
      const recordScope = new Map([['rec_1', { accessLevel: 'admin' as const }]])
      expect(deriveRecordPermissions('rec_1', resolved.capabilities, recordScope as never)).toMatchObject({ canEdit: false, canDelete: false })
    }
  })
})

describe('S3 host — restrictStockPreparationOverviewCapabilities (pure)', () => {
  it('off the overview it returns the input object untouched', () => {
    const caps = { canRead: true, canExport: true, canEditRecord: true }
    expect(restrictStockPreparationOverviewCapabilities(caps, false)).toBe(caps)
  })

  it('on the overview it keeps canRead/canExport/canManageSheetAccess AS RESOLVED and forces every other can* key — including unknown future ones — to false', () => {
    const caps = { canRead: true, canExport: false, canManageSheetAccess: true, canEditRecord: true, canFutureWrite: true, canOdd: 'yes', label: 'kept' } as unknown as { canRead: boolean; canExport: boolean }
    const out = restrictStockPreparationOverviewCapabilities(caps, true) as unknown as Record<string, unknown>
    expect(out).toEqual({ canRead: true, canExport: false, canManageSheetAccess: true, canEditRecord: false, canFutureWrite: false, canOdd: false, label: 'kept' })
    const notManager = restrictStockPreparationOverviewCapabilities({ canRead: true, canExport: true, canManageSheetAccess: false }, true)
    expect(notManager.canManageSheetAccess).toBe(false)
    expect(out).not.toBe(caps)
    expect((caps as unknown as Record<string, unknown>).canEditRecord).toBe(true)
  })
})

// ── (e) the lookup ───────────────────────────────────────────────────────────────────────────────────

describe('S3 host — loadStockPreparationOverviewSheetIds', () => {
  it('no ids → empty set, no query', async () => {
    const query = vi.fn()
    await expect(loadStockPreparationOverviewSheetIds(query as never, [])).resolves.toEqual(new Set())
    expect(query).not.toHaveBeenCalled()
  })

  it('fix round 1 (R12): ids outside the derived shape are dropped BEFORE the statement — none left, no query', async () => {
    const query = vi.fn(async () => ({ rows: [{ id: 'sheet_a' }] }))
    await expect(loadStockPreparationOverviewSheetIds(query as never, ['sheet_a', 'sheet_s3_overview', '', 7, null])).resolves.toEqual(new Set())
    expect(query).not.toHaveBeenCalled()
    expect(isStockPreparationOverviewSheetIdCandidate(OV_SHEET)).toBe(true)
    expect(isStockPreparationOverviewSheetIdCandidate(DERIVED_PLAIN_SHEET)).toBe(true)
    for (const bad of ['sheet_a', `${OV_SHEET} `, OV_SHEET.toUpperCase(), `view${OV_SHEET.slice(5)}`, `sheet_${randomUUID()}`, 42, null, undefined]) {
      expect(isStockPreparationOverviewSheetIdCandidate(bad), String(bad)).toBe(false)
    }
    // The pattern IS the derivation's shape: every derived sheet id matches it.
    for (const objectId of ['a', STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID, 'plm_stock_preparation_sandbox_p_0123456789abcdef01234567']) {
      for (const projectId of ['t:integration-core', 'tenant_x:after-sales', '']) {
        expect(STOCK_PREPARATION_OVERVIEW_SHEET_ID_PATTERN.test(getObjectSheetId(projectId, objectId))).toBe(true)
      }
    }
  })

  it('issues the column-tolerant statement with the CANDIDATE ids and the kind, and keeps only string ids', async () => {
    const SHEET_A = getObjectSheetId('p', 'a')
    const SHEET_B = getObjectSheetId('p', 'b')
    const query = vi.fn(async () => ({ rows: [{ id: SHEET_A }, { id: 7 }, { id: null }, {}] }))
    const ids = await loadStockPreparationOverviewSheetIds(query as never, [SHEET_A, 'sheet_not_derived', SHEET_B, SHEET_A])
    expect(ids).toEqual(new Set([SHEET_A]))
    expect(query).toHaveBeenCalledTimes(1)
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(normalize(sql)).toBe(OVERVIEW_SQL)
    expect(sql).toContain("to_jsonb(meta_sheets) ->> 'system_kind'")
    expect(params).toEqual([[SHEET_A, SHEET_B], KIND])
  })
})

// ── (f) fix round 1 (R1): the grant-level rule both grant routes apply ───────────────────────────────

describe('S3 fix round 1 — the overview grant-level rule (R1)', () => {
  it('only read and none (revoke) are grantable on an overview; the legacy door may write the read code only', () => {
    expect(isStockPreparationOverviewGrantableAccessLevel('read')).toBe(true)
    expect(isStockPreparationOverviewGrantableAccessLevel('none')).toBe(true)
    for (const level of ['write', 'write-own', 'admin', 'READ', ' read', '', null, undefined, 1]) {
      expect(isStockPreparationOverviewGrantableAccessLevel(level), String(level)).toBe(false)
    }
    expect(STOCK_PREPARATION_OVERVIEW_GRANT_PERM_CODE).toBe('spreadsheet:read')
  })
})

// ── (g) fix round 1 (R1): the G1 READ port — the host service ────────────────────────────────────────

type GrantFake = {
  query: ReturnType<typeof vi.fn>
  statements: Array<{ sql: string; params: unknown[] }>
  rows: Array<{ sheet_id: string; subject_id: string; perm_code: string }>
}

function createOverviewGrantFake({ kind = KIND as string | null, roles = ['stock-prep_frontline', 'stock-prep_puller'], live = true } = {}): GrantFake {
  const statements: GrantFake['statements'] = []
  const rows: GrantFake['rows'] = []
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const q = normalize(sql)
    statements.push({ sql: q, params })
    if (q === 'SELECT deleted_at FROM meta_sheets WHERE id = $1 FOR UPDATE') return { rows: live ? [{ deleted_at: null }] : [], rowCount: live ? 1 : 0 }
    if (q === "SELECT (to_jsonb(meta_sheets) ->> 'system_kind') AS system_kind FROM meta_sheets WHERE id = $1") return { rows: [{ system_kind: kind }], rowCount: 1 }
    if (q === 'SELECT id FROM roles WHERE id = ANY($1::text[])') {
      const asked = params[0] as string[]
      return { rows: asked.filter((id) => roles.includes(id)).map((id) => ({ id })), rowCount: 0 }
    }
    if (q.startsWith('SELECT perm_code FROM spreadsheet_permissions')) {
      return { rows: rows.filter((r) => r.sheet_id === params[0] && r.subject_id === params[1]).map((r) => ({ perm_code: r.perm_code })), rowCount: 0 }
    }
    if (q.startsWith('INSERT INTO spreadsheet_permissions')) {
      const [sheetId, roleId, perm] = params as [string, string, string]
      if (rows.some((r) => r.sheet_id === sheetId && r.subject_id === roleId && r.perm_code === perm)) return { rows: [], rowCount: 0 }
      rows.push({ sheet_id: sheetId, subject_id: roleId, perm_code: perm })
      return { rows: [{ subject_id: roleId }], rowCount: 1 }
    }
    if (q.startsWith('INSERT INTO meta_config_revisions')) return { rows: [], rowCount: 1 }
    throw new Error(`Unhandled SQL in overview grant fake: ${q}`)
  })
  return { query, statements, rows }
}

describe('S3 fix round 1 — G1 READ port, host service (grantStockPreparationOverviewRoleRead)', () => {
  it('G-OV-01 source census: one INSERT, zero DELETE / UPDATE of grants, the perm code bound only as the READ literal', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'src', 'services', 'stock-preparation-overview-grants.ts'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    expect(code.match(/INSERT INTO spreadsheet_permissions/g)).toHaveLength(1)
    expect(code.match(/\bDELETE\b/g)).toBeNull()
    expect(code.match(/UPDATE spreadsheet_permissions/g)).toBeNull()
    expect(code).toContain('STOCK_PREPARATION_OVERVIEW_GRANT_PERM_CODE]')
    expect(code).not.toMatch(/'spreadsheet:(read|write|admin|write-own)'/)
    expect(code).toContain("VALUES ($1, NULL, 'role', $2, $3)")
  })

  it('G-OV-02 grants spreadsheet:read to each role on a STAMPED overview, with a history row; a repeat is idempotent', async () => {
    const fake = createOverviewGrantFake()
    const first = await grantStockPreparationOverviewRoleRead(fake.query as never, { sheetId: OV_SHEET, roleIds: ['stock-prep_frontline', 'stock-prep_puller'], actorId: 'u_puller' })
    expect(first).toEqual({ sheetId: OV_SHEET, granted: ['stock-prep_frontline', 'stock-prep_puller'], alreadyGranted: [] })
    const inserts = fake.statements.filter((s) => s.sql.startsWith('INSERT INTO spreadsheet_permissions'))
    expect(inserts.map((s) => s.params)).toEqual([
      [OV_SHEET, 'stock-prep_frontline', 'spreadsheet:read'],
      [OV_SHEET, 'stock-prep_puller', 'spreadsheet:read'],
    ])
    expect(fake.statements.filter((s) => s.sql.startsWith('INSERT INTO meta_config_revisions'))).toHaveLength(2)
    // ORDER: the row lock first, then the kind under it, then the roles — nothing written before the kind check.
    expect(fake.statements[0].sql).toBe('SELECT deleted_at FROM meta_sheets WHERE id = $1 FOR UPDATE')
    expect(fake.statements[1].sql).toContain("'system_kind'")
    const before = fake.statements.length
    const again = await grantStockPreparationOverviewRoleRead(fake.query as never, { sheetId: OV_SHEET, roleIds: ['stock-prep_frontline', 'stock-prep_puller'] })
    expect(again).toEqual({ sheetId: OV_SHEET, granted: [], alreadyGranted: ['stock-prep_frontline', 'stock-prep_puller'] })
    expect(fake.statements.slice(before).filter((s) => s.sql.startsWith('INSERT INTO meta_config_revisions'))).toHaveLength(0)
    expect(fake.statements.some((s) => /\bDELETE\b|\bUPDATE spreadsheet_permissions\b/i.test(s.sql))).toBe(false)
    expect(stockPreparationOverviewGrantEntityId('stock-prep_frontline')).toBe('sheet:["role","stock-prep_frontline"]')
  })

  it('G-OV-03 refuses a sheet that does not carry the overview kind (an older host, an unstamped twin) — 409, nothing written', async () => {
    for (const kind of [null, 'people_directory', 'approval_projection', '']) {
      const fake = createOverviewGrantFake({ kind })
      const error = await grantStockPreparationOverviewRoleRead(fake.query as never, { sheetId: OV_SHEET, roleIds: ['stock-prep_frontline'] }).then(() => null, (e: unknown) => e)
      expect(error).toBeInstanceOf(StockPreparationProjectSheetGrantError)
      expect(error).toMatchObject({ status: 409, code: 'STOCK_PREP_OVERVIEW_GRANT_NOT_OVERVIEW' })
      expect(fake.statements.some((s) => s.sql.startsWith('INSERT'))).toBe(false)
      expect(fake.statements.some((s) => s.sql.includes('FROM roles'))).toBe(false)
    }
  })

  it('G-OV-04 role rules: outside the namespace → 422 before any statement; a missing role → 404 with nothing inserted; no roles → no statement', async () => {
    const outside = createOverviewGrantFake()
    await expect(grantStockPreparationOverviewRoleRead(outside.query as never, { sheetId: OV_SHEET, roleIds: ['admin'] })).rejects.toMatchObject({ status: 422, code: 'STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_OUTSIDE_NAMESPACE' })
    expect(outside.statements).toEqual([])
    const missing = createOverviewGrantFake({ roles: ['stock-prep_frontline'] })
    await expect(grantStockPreparationOverviewRoleRead(missing.query as never, { sheetId: OV_SHEET, roleIds: ['stock-prep_frontline', 'stock-prep_ghost'] })).rejects.toMatchObject({ status: 404, code: 'STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_NOT_FOUND' })
    expect(missing.statements.some((s) => s.sql.startsWith('INSERT'))).toBe(false)
    const none = createOverviewGrantFake()
    await expect(grantStockPreparationOverviewRoleRead(none.query as never, { sheetId: OV_SHEET, roleIds: [] })).resolves.toEqual({ sheetId: OV_SHEET, granted: [], alreadyGranted: [] })
    expect(none.statements).toEqual([])
  })

  it('G-OV-05 a role that already holds WRITE on the overview gets the read row and no history (the clamp makes write read-only in effect)', async () => {
    const fake = createOverviewGrantFake()
    fake.rows.push({ sheet_id: OV_SHEET, subject_id: 'stock-prep_frontline', perm_code: 'spreadsheet:write' })
    const result = await grantStockPreparationOverviewRoleRead(fake.query as never, { sheetId: OV_SHEET, roleIds: ['stock-prep_frontline'] })
    expect(result.granted).toEqual(['stock-prep_frontline'])
    expect(fake.statements.filter((s) => s.sql.startsWith('INSERT INTO meta_config_revisions'))).toHaveLength(0)
    expect(fake.rows.filter((r) => r.subject_id === 'stock-prep_frontline').map((r) => r.perm_code).sort()).toEqual(['spreadsheet:read', 'spreadsheet:write'])
  })
})

// ── (h) fix round 1 (R1 / R8c): the plugin-scope READ-port wrapper and the stamp declaration ──────────

describe('S3 fix round 1 — plugin-scope grantOverviewRoleRead wrapper and supportsSystemKindStamp', () => {
  const PROJECT = OV_PROJECT
  function build({ pluginName = 'plugin-integration-core', withHost = true, strictHook = true, ownedByProject = true, declares = true }: {
    pluginName?: string
    withHost?: boolean
    strictHook?: boolean
    ownedByProject?: boolean
    declares?: boolean | 'yes'
  } = {}) {
    const host = vi.fn(async (input: { sheetId: string; roleIds: string[] }) => ({ sheetId: input.sheetId, granted: [...input.roleIds], alreadyGranted: [] }))
    const assertSheetOwnedByPlugin = vi.fn(async () => {})
    const isSheetOwnedByProject = vi.fn(async () => ownedByProject)
    const multitable = {
      provisioning: {
        getObjectSheetId,
        isSheetOwnedByProject: vi.fn(async () => { throw new Error('the hook answers') }),
        ...(declares === true ? { supportsSystemKindStamp: true } : declares === 'yes' ? { supportsSystemKindStamp: 'yes' } : {}),
        ...(withHost ? { grantOverviewRoleRead: host } : {}),
      },
      records: {},
    }
    const hooks = strictHook ? { assertSheetOwnedByPlugin, isSheetOwnedByProject } : { isSheetOwnedByProject }
    const scoped = createPluginScopedMultitableApi(multitable as never, pluginName, hooks as never)
    return { scoped, host, assertSheetOwnedByPlugin, isSheetOwnedByProject }
  }
  const input = (extra: Record<string, unknown> = {}) => ({
    projectId: PROJECT,
    sheetId: OV_SHEET,
    objectId: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID,
    roleIds: [' stock-prep_frontline ', 'stock-prep_frontline'],
    actorId: ' u_puller ',
    ...extra,
  })

  it('is exposed only to plugin-integration-core and only when the host exposes it', () => {
    expect(typeof build().scoped.provisioning.grantOverviewRoleRead).toBe('function')
    expect(build({ withHost: false }).scoped.provisioning.grantOverviewRoleRead).toBeUndefined()
    for (const other of ['plugin-after-sales', 'Plugin-Integration-Core', 'plugin-integration-core-fork']) {
      const s = build({ pluginName: other })
      expect(s.scoped.provisioning.grantOverviewRoleRead, other).toBeUndefined()
      expect('grantOverviewRoleRead' in s.scoped.provisioning, other).toBe(false)
    }
  })

  it('the exact overview object, the derived sheet, a strict owner hook and the project registry — then the host gets the checked values', async () => {
    const s = build()
    await s.scoped.provisioning.grantOverviewRoleRead!(input())
    expect(s.host).toHaveBeenCalledWith({ projectId: PROJECT, sheetId: OV_SHEET, objectId: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID, roleIds: ['stock-prep_frontline'], actorId: 'u_puller' })
    expect(s.assertSheetOwnedByPlugin).toHaveBeenCalledWith({ pluginName: 'plugin-integration-core', sheetId: OV_SHEET })
    expect(s.isSheetOwnedByProject).toHaveBeenCalledWith({ sheetId: OV_SHEET, projectId: PROJECT })
  })

  it('refuses any other object (a project sheet, the main table), a non-derived sheet id, a missing strict hook and another project — the host is never called', async () => {
    const projectSheetObject = 'plm_stock_preparation_sandbox_p_0123456789abcdef01234567'
    for (const objectId of [projectSheetObject, 'plm_stock_preparation_main', `${STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID}_x`]) {
      const s = build()
      await expect(s.scoped.provisioning.grantOverviewRoleRead!(input({ objectId, sheetId: getObjectSheetId(PROJECT, objectId) }))).rejects.toMatchObject({ status: 422, code: 'STOCK_PREP_OVERVIEW_GRANT_OBJECT_NOT_OVERVIEW' })
      expect(s.host).not.toHaveBeenCalled()
      expect(s.assertSheetOwnedByPlugin).not.toHaveBeenCalled()
    }
    const mismatch = build()
    await expect(mismatch.scoped.provisioning.grantOverviewRoleRead!(input({ sheetId: DERIVED_PLAIN_SHEET }))).rejects.toMatchObject({ status: 422, code: 'STOCK_PREP_PROJECT_SHEET_GRANT_SHEET_MISMATCH' })
    expect(mismatch.host).not.toHaveBeenCalled()
    const noHook = build({ strictHook: false })
    await expect(noHook.scoped.provisioning.grantOverviewRoleRead!(input())).rejects.toBeInstanceOf(Error)
    expect(noHook.host).not.toHaveBeenCalled()
    const otherProject = build({ ownedByProject: false })
    await expect(otherProject.scoped.provisioning.grantOverviewRoleRead!(input())).rejects.toBeInstanceOf(Error)
    expect(otherProject.host).not.toHaveBeenCalled()
    const namespace = build()
    await expect(namespace.scoped.provisioning.grantOverviewRoleRead!(input({ projectId: 'tenant_1:after-sales' }))).rejects.toBeInstanceOf(MultitableProjectNamespaceError)
    const roles = build()
    await expect(roles.scoped.provisioning.grantOverviewRoleRead!(input({ roleIds: ['admin'] }))).rejects.toMatchObject({ code: 'STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_OUTSIDE_NAMESPACE' })
    expect(roles.host).not.toHaveBeenCalled()
  })

  it('supportsSystemKindStamp is forwarded only as the host\'s literal true (for every plugin — it describes the host)', () => {
    expect((build().scoped.provisioning as { supportsSystemKindStamp?: unknown }).supportsSystemKindStamp).toBe(true)
    expect((build({ pluginName: 'plugin-after-sales' }).scoped.provisioning as { supportsSystemKindStamp?: unknown }).supportsSystemKindStamp).toBe(true)
    expect('supportsSystemKindStamp' in build({ declares: false }).scoped.provisioning).toBe(false)
    expect('supportsSystemKindStamp' in build({ declares: 'yes' }).scoped.provisioning).toBe(false)
  })
})

// ── (i) fix round 1 (E1): the index.ts plumbing, pinned so dropping it from EITHER hook goes red ───────

describe('S3 fix round 1 — index.ts wires systemKind, the stamp declaration and the READ port (E1)', () => {
  const source = readFileSync(join(__dirname, '..', '..', 'src', 'index.ts'), 'utf8').replace(/\r\n/g, '\n')
  // Whole-line `//` comments only: a block-comment strip would also eat the code between a `/*` inside a
  // string (a route glob) and the next `*/`.
  const code = source.replace(/^[ \t]*\/\/[^\n]*$/gm, '')

  it('both provisioning hooks destructure systemKind AND forward it, as a bare binding, to the ONE provisioning call in their body', () => {
    const hooks = [...code.matchAll(/(ensureObject(?:InScope)?): async \(\{([^}]*)\}\) =>([\s\S]*?)ensureMultitableObject\(\{([^}]*)\}\)/g)]
    expect(hooks.map((hook) => hook[1]).sort()).toEqual(['ensureObject', 'ensureObjectInScope'])
    // Exactly two provisioning calls in the file — a third, unpinned path would be a bypass.
    expect(code.match(/ensureMultitableObject\(\{/g)).toHaveLength(2)
    for (const hook of hooks) {
      const destructure = hook[2]
      const forwarded = hook[4]
      expect(destructure, `${hook[1]} destructure`).toMatch(/(^|[\s,])systemKind\s*(,|$)/)
      // A bare shorthand `systemKind,` (or `systemKind: systemKind`) — `systemKind: undefined`, `null`
      // or a dropped line all go red here.
      expect(forwarded, `${hook[1]} forward`).toMatch(/(^|[\s,{])systemKind\s*(,|\n|$)|systemKind:\s*systemKind\b/)
      expect(forwarded, `${hook[1]} forward`).not.toMatch(/systemKind:\s*(undefined|null)\b/)
    }
  })

  it('the host declares supportsSystemKindStamp: true once, and wires the READ port to the overview grant service', () => {
    expect(code.match(/supportsSystemKindStamp:\s*true\b/g)).toHaveLength(1)
    expect(code).toMatch(/grantOverviewRoleRead: async \(\{ sheetId, roleIds, actorId \}\) => \{[\s\S]{0,800}?grantStockPreparationOverviewRoleRead\(txQuery, \{ sheetId, roleIds, actorId \}\)/)
  })
})

// ── S3 follow-up E (register R-37): STRUCTURAL writes to the overview, at the plugin-scope layer ────────────
//
// The overview's structure (columns, field properties, display names, views) is written only by the overview
// module's own provisioning: `ensureObject` with the overview kind (the gate above) and `ensureView` with the same
// marker. Every other structural write naming the overview is a values-free 403 STOCK_PREP_OVERVIEW_READ_ONLY
// before the host is reached:
//   E-01 object-keyed writes naming the overview OBJECT (ensureMissingObjectFields, the repair transaction's
//        ensureMissingObjectFields, ensureObjectDefaultView, patchObjectFieldProperty, relabelObjectDisplayNames)
//        are refused PURELY — no hook, no host call — for the port plugin too; an unstamped ensureObject of the
//        overview object is refused the same way; other objects pass unchanged (control);
//   E-02 ensureView on the STAMPED overview without the marker is refused (the host's stamp decides; no hook →
//        `unverifiable`); an ordinary derived-shape sheet and a non-derived id pass, the latter with no lookup;
//   E-03 the overview module's own call — port plugin + marker + this project's derived overview sheet — reaches
//        the host WITHOUT the marker; a misused marker (another plugin / kind / sheet) is the systemKind 403.
describe('S3 follow-up E — structural writes to the overview are refused at the plugin-scope layer', () => {
  const PROJECT = OV_PROJECT
  const OTHER_TENANT_OVERVIEW = getObjectSheetId('tenant_2:integration-core', STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID)
  const build = (pluginName = 'plugin-integration-core', { stamped = [OV_SHEET, OTHER_TENANT_OVERVIEW], withStampHook = true } = {}) => {
    const host = {
      getObjectSheetId,
      ensureObject: vi.fn(async () => ({ baseId: 'b', sheet: { id: OV_SHEET, baseId: 'b', name: 'x', description: null, systemKind: null }, fields: [] })),
      ensureView: vi.fn(async (input: { sheetId: string }) => ({ id: 'view_x', sheetId: input.sheetId, name: 'v', type: 'grid', filterInfo: {}, sortInfo: {}, groupInfo: {}, hiddenFieldIds: [], config: {} })),
      ensureMissingObjectFields: vi.fn(async () => ({ addedFieldIds: [], skippedExistingFieldIds: [] })),
      ensureObjectDefaultView: vi.fn(async () => ({})),
      patchObjectFieldProperty: vi.fn(async () => ({})),
      relabelObjectDisplayNames: vi.fn(async () => ({})),
      runObjectFieldsRepairTransaction: vi.fn(async (fn: (surface: Record<string, unknown>) => Promise<unknown>) => fn({
        findObjectSheet: vi.fn(async () => null),
        resolveExistingObjectFieldIds: vi.fn(async () => ({})),
        readObjectFieldsContent: vi.fn(async () => ({})),
        ensureMissingObjectFields: txEnsureMissing,
      })),
    }
    const txEnsureMissing = vi.fn(async () => ({ addedFieldIds: [], skippedExistingFieldIds: [] }))
    const hooks = {
      assertObjectScope: vi.fn(async () => {}),
      assertSheetScope: vi.fn(async () => ({ registered: true })),
      ...(withStampHook ? { isStockPreparationOverviewSheet: vi.fn(async ({ sheetId }: { sheetId: string }) => stamped.includes(sheetId)) } : {}),
    }
    const api = createPluginScopedMultitableApi({ provisioning: host, records: {} } as never, pluginName, hooks as never)
    const projectId = pluginName === 'plugin-integration-core' ? PROJECT : 'tenant_1:after-sales'
    return { api, host, hooks, txEnsureMissing, projectId }
  }
  const refusedWith = async (promise: Promise<unknown>, reason: 'structure_write' | 'unverifiable') => {
    const error = await promise.then(() => null, (e: unknown) => e)
    expect(error).toBeInstanceOf(StockPreparationOverviewStructureWriteError)
    expect(error).toMatchObject({ status: 403, code: 'STOCK_PREP_OVERVIEW_READ_ONLY', details: { reason } })
    expect(JSON.stringify((error as { details: unknown }).details)).toBe(JSON.stringify({ reason }))
  }
  const viewDescriptor = { id: 'overview-active', objectId: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID, name: 'Active', type: 'grid' }

  it('E-01 every object-keyed structural write naming the overview object is refused purely — no hook, no host — for every plugin; other objects pass (control)', async () => {
    for (const pluginName of ['plugin-integration-core', 'plugin-after-sales']) {
      const s = build(pluginName)
      const o = { projectId: s.projectId, objectId: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID }
      await refusedWith(s.api.provisioning.ensureMissingObjectFields({ ...o, fields: [{ id: 'extra', name: 'Extra', type: 'string' }] } as never), 'structure_write')
      await refusedWith(s.api.provisioning.ensureObjectDefaultView!({ ...o, viewId: 'default' } as never), 'structure_write')
      await refusedWith(s.api.provisioning.patchObjectFieldProperty({ ...o, fieldId: 'status', property: { options: [] } } as never), 'structure_write')
      await refusedWith(s.api.provisioning.relabelObjectDisplayNames!({ ...o, sheetName: 'x', fields: [], apply: true } as never), 'structure_write')
      await refusedWith(s.api.provisioning.runObjectFieldsRepairTransaction!(async (surface) => surface.ensureMissingObjectFields({ ...o, fields: [] } as never)), 'structure_write')
      // An UNSTAMPED ensure of the overview object (would create an ordinary sheet at its id or add columns to it).
      await refusedWith(s.api.provisioning.ensureObject({ projectId: s.projectId, descriptor: { id: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID, name: 'x', fields: [] } } as never), 'structure_write')
      await refusedWith(s.api.provisioning.ensureObject({ projectId: s.projectId, descriptor: { id: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID, name: 'x', fields: [] }, systemKind: null } as never), 'structure_write')
      expect(s.hooks.assertObjectScope).not.toHaveBeenCalled()
      for (const method of ['ensureObject', 'ensureMissingObjectFields', 'ensureObjectDefaultView', 'patchObjectFieldProperty', 'relabelObjectDisplayNames'] as const) {
        expect(s.host[method], method).not.toHaveBeenCalled()
      }
      expect(s.txEnsureMissing).not.toHaveBeenCalled()
    }
    // Control: the same calls on another object reach the host.
    const c = build('plugin-integration-core')
    const main = { projectId: PROJECT, objectId: 'plm_stock_preparation_main' }
    await c.api.provisioning.ensureMissingObjectFields({ ...main, fields: [] } as never)
    await c.api.provisioning.patchObjectFieldProperty({ ...main, fieldId: 'status', property: {} } as never)
    await c.api.provisioning.relabelObjectDisplayNames!({ ...main, sheetName: 'x', fields: [], apply: false } as never)
    await c.api.provisioning.ensureObjectDefaultView!({ ...main, viewId: 'default' } as never)
    await c.api.provisioning.runObjectFieldsRepairTransaction!(async (surface) => surface.ensureMissingObjectFields({ ...main, fields: [] } as never))
    await c.api.provisioning.ensureObject({ projectId: PROJECT, descriptor: { id: 'plm_stock_preparation_main', name: 'x', fields: [] } } as never)
    for (const method of ['ensureObject', 'ensureMissingObjectFields', 'ensureObjectDefaultView', 'patchObjectFieldProperty', 'relabelObjectDisplayNames'] as const) {
      expect(c.host[method], method).toHaveBeenCalledTimes(1)
    }
    expect(c.txEnsureMissing).toHaveBeenCalledTimes(1)
  })

  it('E-02 ensureView on the STAMPED overview without the marker is refused (this tenant\'s and another\'s); no stamp hook → unverifiable; ordinary sheets pass, a non-derived id with no lookup', async () => {
    for (const pluginName of ['plugin-integration-core', 'plugin-after-sales']) {
      const s = build(pluginName)
      for (const sheetId of [OV_SHEET, OTHER_TENANT_OVERVIEW]) {
        await refusedWith(s.api.provisioning.ensureView({ projectId: s.projectId, sheetId, descriptor: viewDescriptor } as never), 'structure_write')
      }
      expect(s.host.ensureView).not.toHaveBeenCalled()
      // Fix round 1 (no oracle): the refusal runs AFTER the sheet-scope check (here a scope hook that admits every
      // sheet — the observe-mode tolerance — so the refusal is what stops the write; E-05 is the foreign-plugin case).
      expect(s.hooks.assertSheetScope).toHaveBeenCalledTimes(2)
    }
    const blind = build('plugin-integration-core', { withStampHook: false })
    await refusedWith(blind.api.provisioning.ensureView({ projectId: PROJECT, sheetId: DERIVED_PLAIN_SHEET, descriptor: viewDescriptor } as never), 'unverifiable')
    expect(blind.host.ensureView).not.toHaveBeenCalled()
    // Control: an ordinary derived-shape sheet (the lookup answers "not the overview") and a non-derived id pass.
    const c = build('plugin-integration-core')
    await c.api.provisioning.ensureView({ projectId: PROJECT, sheetId: DERIVED_PLAIN_SHEET, descriptor: viewDescriptor } as never)
    await c.api.provisioning.ensureView({ projectId: PROJECT, sheetId: 'sheet_hand_named', descriptor: viewDescriptor } as never)
    expect(c.host.ensureView).toHaveBeenCalledTimes(2)
    expect(c.hooks.isStockPreparationOverviewSheet).toHaveBeenCalledTimes(1)
    expect(c.hooks.isStockPreparationOverviewSheet).toHaveBeenCalledWith({ sheetId: DERIVED_PLAIN_SHEET })
  })

  it('E-03 the overview module\'s own view provisioning (port plugin + marker + this project\'s derived overview sheet) reaches the host WITHOUT the marker; a misused marker is the systemKind 403', async () => {
    const s = build('plugin-integration-core')
    await s.api.provisioning.ensureView({ projectId: PROJECT, sheetId: OV_SHEET, descriptor: viewDescriptor, systemKind: KIND })
    expect(s.host.ensureView).toHaveBeenCalledTimes(1)
    expect(s.host.ensureView.mock.calls[0][0]).toStrictEqual({ projectId: PROJECT, sheetId: OV_SHEET, descriptor: viewDescriptor })
    expect(s.hooks.assertSheetScope).toHaveBeenCalledWith({ pluginName: 'plugin-integration-core', sheetId: OV_SHEET })
    const misuse = async (pluginName: string, input: Record<string, unknown>, reason: 'plugin' | 'kind' | 'object') => {
      const m = build(pluginName)
      const error = await m.api.provisioning.ensureView({ projectId: m.projectId, descriptor: viewDescriptor, ...input } as never).then(() => null, (e: unknown) => e)
      expect(error).toBeInstanceOf(StockPreparationOverviewSystemKindError)
      expect(error).toMatchObject({ status: 403, code: 'MULTITABLE_SYSTEM_KIND_FORBIDDEN', details: { reason } })
      expect(m.host.ensureView).not.toHaveBeenCalled()
    }
    await misuse('plugin-after-sales', { sheetId: OV_SHEET, systemKind: KIND }, 'plugin')
    await misuse('plugin-integration-core', { sheetId: OV_SHEET, systemKind: 'people_directory' }, 'kind')
    // Another tenant's overview, and an ordinary sheet, under this project with the marker.
    await misuse('plugin-integration-core', { sheetId: OTHER_TENANT_OVERVIEW, systemKind: KIND }, 'object')
    await misuse('plugin-integration-core', { sheetId: DERIVED_PLAIN_SHEET, systemKind: KIND }, 'object')
  })

  // ── S3 follow-ups, fix round 1 ─────────────────────────────────────────────────────────────────────────────────
  //   E-05 (no ordering oracle): a FOREIGN plugin's ensureView on the overview id meets the scope refusal it meets on
  //        any other sheet integration-core owns — the REAL owner check (`assertPluginOwnsSheet`) over a registry
  //        fake — and the stamp lookup is never asked, so the probe cannot tell the overview from an ordinary sheet.
  //   E-06 (read-once): a getter-bearing input that answers a harmless object first and the overview afterwards
  //        reaches the scope hook AND the host with the harmless value it was checked with, read exactly once.
  it('E-05 a foreign plugin probing the overview id gets the same scope refusal as for any foreign sheet; the stamp lookup is never asked', async () => {
    const registry = new Map<string, string>([
      [OV_SHEET, 'plugin-integration-core'],
      [DERIVED_PLAIN_SHEET, 'plugin-integration-core'],
    ])
    const registryQuery = vi.fn(async (_sql: string, params?: unknown[]) => {
      const owner = registry.get(String((params ?? [])[0]))
      return { rows: owner ? [{ plugin_name: owner }] : [] }
    })
    const isStockPreparationOverviewSheet = vi.fn(async ({ sheetId }: { sheetId: string }) => sheetId === OV_SHEET)
    const host = { getObjectSheetId, ensureView: vi.fn(async () => ({ id: 'view_x' })) }
    const api = createPluginScopedMultitableApi({ provisioning: host, records: {} } as never, 'plugin-after-sales', {
      assertSheetScope: async ({ pluginName, sheetId }: { pluginName: string; sheetId: string }) => {
        const registered = await assertPluginOwnsSheet(registryQuery as never, { pluginName, sheetId })
        return { registered }
      },
      isStockPreparationOverviewSheet,
    } as never)
    const probe = async (sheetId: string) => {
      const error = await api.provisioning.ensureView({ projectId: 'tenant_1:after-sales', sheetId, descriptor: viewDescriptor } as never)
        .then(() => null, (e: unknown) => e)
      expect(error).toBeInstanceOf(MultitableSheetScopeError)
      const e = error as MultitableSheetScopeError
      // The message names the probed id; with the id masked, the two refusals are the same refusal.
      return { name: e.name, code: e.code, message: e.message.split(sheetId).join('<sheet>'), keys: Object.keys(e).sort() }
    }
    const onOverview = await probe(OV_SHEET)
    const onOrdinary = await probe(DERIVED_PLAIN_SHEET)
    expect(onOverview).toStrictEqual(onOrdinary)
    expect(onOverview.code).toBe('MULTITABLE_SHEET_SCOPE_FORBIDDEN')
    expect(isStockPreparationOverviewSheet).not.toHaveBeenCalled()
    expect(host.ensureView).not.toHaveBeenCalled()
  })

  it('E-06 read-once: a getter-bearing input is checked and forwarded with ONE read — the hook and the host see the value that was checked, never the overview', async () => {
    const OV = STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID
    const HARMLESS = 'plm_stock_preparation_main'
    const flipping = <T extends Record<string, unknown>>(base: T, key: string, first: unknown, later: unknown) => {
      let reads = 0
      const input: Record<string, unknown> = { ...base }
      Object.defineProperty(input, key, { enumerable: true, get() { reads += 1; return reads === 1 ? first : later } })
      return { input, reads: () => reads }
    }
    const s = build('plugin-integration-core')
    const objectIdSeen = (fn: { mock: { calls: unknown[][] } }) => (fn.mock.calls.at(-1)?.[0] as { objectId?: unknown }).objectId
    // The four object-keyed writes: the getter answers the harmless object first, the overview afterwards.
    const cases: Array<[string, () => Promise<unknown>, () => unknown, () => number]> = []
    {
      const f = flipping({ projectId: PROJECT, fields: [] }, 'objectId', HARMLESS, OV)
      cases.push(['ensureMissingObjectFields', () => s.api.provisioning.ensureMissingObjectFields(f.input as never), () => objectIdSeen(s.host.ensureMissingObjectFields), f.reads])
    }
    {
      const f = flipping({ projectId: PROJECT, name: 'n' }, 'objectId', HARMLESS, OV)
      cases.push(['ensureObjectDefaultView', () => s.api.provisioning.ensureObjectDefaultView!(f.input as never), () => objectIdSeen(s.host.ensureObjectDefaultView), f.reads])
    }
    {
      const f = flipping({ projectId: PROJECT, fieldId: 'status', propertyPatch: {} }, 'objectId', HARMLESS, OV)
      cases.push(['patchObjectFieldProperty', () => s.api.provisioning.patchObjectFieldProperty(f.input as never), () => objectIdSeen(s.host.patchObjectFieldProperty), f.reads])
    }
    {
      const f = flipping({ projectId: PROJECT, fields: [] }, 'objectId', HARMLESS, OV)
      cases.push(['repair-tx ensureMissingObjectFields', () => s.api.provisioning.runObjectFieldsRepairTransaction!(async (surface) => surface.ensureMissingObjectFields(f.input as never)), () => objectIdSeen(s.txEnsureMissing), f.reads])
    }
    for (const [name, run, hostSaw, reads] of cases) {
      await run()
      expect(hostSaw(), `${name}: the host gets the checked value`).toBe(HARMLESS)
      expect(reads(), `${name}: objectId is read once`).toBe(1)
      expect((s.hooks.assertObjectScope.mock.calls.at(-1)?.[0] as { objectId?: unknown }).objectId, `${name}: the scope hook gets the checked value`).toBe(HARMLESS)
    }
    // ensureObject without a kind: the descriptor's id getter answers the harmless object first.
    let idReads = 0
    const descriptor: Record<string, unknown> = { name: 'x', fields: [] }
    Object.defineProperty(descriptor, 'id', { enumerable: true, get() { idReads += 1; return idReads === 1 ? HARMLESS : OV } })
    await s.api.provisioning.ensureObject({ projectId: PROJECT, descriptor } as never)
    const ensured = s.host.ensureObject.mock.calls.at(-1)?.[0] as unknown as { descriptor: { id: unknown } }
    expect(ensured.descriptor.id, 'ensureObject: the host gets the checked descriptor id').toBe(HARMLESS)
    expect(idReads, 'ensureObject: the descriptor id is read once').toBe(1)
    expect((s.hooks.assertObjectScope.mock.calls.at(-1)?.[0] as { objectId?: unknown }).objectId).toBe(HARMLESS)
  })
})

describe('S3 follow-up E — the overview MODULE still provisions through the real wrapper', () => {
  it('E-04 the plugin\'s ensureProjectOverviewSheet: stamped ensureObject + both views reach the host (the marker is wired, and stripped); a second ensure writes nothing', async () => {
    const pluginRequire = createRequire(import.meta.url)
    const overviewLib = pluginRequire('../../../../plugins/plugin-integration-core/lib/stock-preparation-project-overview.cjs') as {
      ensureProjectOverviewSheet: (input: Record<string, unknown>) => Promise<{ created: boolean; sheetId: string; views?: { created: number } }>
    }
    const kinds = new Map<string, string | null>()
    const host = {
      supportsSystemKindStamp: true,
      getObjectSheetId,
      getFieldId: (_p: string, _o: string, fieldId: string) => `fld_${fieldId}`,
      getObjectViewId: (_p: string, _o: string, viewId: string) => `view_${viewId}`,
      findObjectSheet: vi.fn(async ({ projectId, objectId }: { projectId: string; objectId: string }) => {
        const id = getObjectSheetId(projectId, objectId)
        return kinds.has(id) ? { id, baseId: null, name: 'x', description: null, systemKind: kinds.get(id) ?? null } : null
      }),
      ensureObject: vi.fn(async ({ projectId, descriptor, systemKind }: { projectId: string; descriptor: { id: string }; systemKind?: string | null }) => {
        const id = getObjectSheetId(projectId, descriptor.id)
        kinds.set(id, systemKind ?? null)
        return { baseId: 'b', sheet: { id, baseId: 'b', name: 'x', description: null, systemKind: systemKind ?? null }, fields: [] }
      }),
      resolveFieldIds: vi.fn(async ({ fieldIds }: { fieldIds: string[] }) => Object.fromEntries(fieldIds.map((fieldId) => [fieldId, `fld_${fieldId}`]))),
      ensureView: vi.fn(async (input: { sheetId: string; descriptor: { id: string } }) => ({ id: input.descriptor.id, sheetId: input.sheetId, name: 'v', type: 'grid', filterInfo: {}, sortInfo: {}, groupInfo: {}, hiddenFieldIds: [], config: {} })),
    }
    const hooks = {
      assertObjectScope: vi.fn(async () => {}),
      claimObjectScope: vi.fn(async () => {}),
      assertSheetScope: vi.fn(async () => ({ registered: true })),
      isStockPreparationOverviewSheet: vi.fn(async ({ sheetId }: { sheetId: string }) => kinds.get(sheetId) === KIND),
    }
    const scoped = createPluginScopedMultitableApi({ provisioning: host, records: {} } as never, 'plugin-integration-core', hooks as never)
    const ensured = await overviewLib.ensureProjectOverviewSheet({ provisioning: scoped.provisioning, projectId: OV_PROJECT, tenantId: 'tenant_1', locale: 'en', env: {} })
    expect(ensured.created).toBe(true)
    expect(ensured.sheetId).toBe(OV_SHEET)
    expect(ensured.views?.created).toBe(2)
    expect(host.ensureObject).toHaveBeenCalledWith(expect.objectContaining({ systemKind: KIND }))
    expect(host.ensureView).toHaveBeenCalledTimes(2)
    for (const call of host.ensureView.mock.calls) {
      expect(call[0]).not.toHaveProperty('systemKind')
      expect((call[0] as { sheetId: string }).sheetId).toBe(OV_SHEET)
    }
    const again = await overviewLib.ensureProjectOverviewSheet({ provisioning: scoped.provisioning, projectId: OV_PROJECT, tenantId: 'tenant_1', locale: 'en', env: {} })
    expect(again.created).toBe(false)
    expect(host.ensureObject).toHaveBeenCalledTimes(1)
    expect(host.ensureView).toHaveBeenCalledTimes(2)
  })
})
