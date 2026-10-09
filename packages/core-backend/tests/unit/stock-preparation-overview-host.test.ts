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
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/rbac/service', () => ({
  isAdmin: vi.fn(),
  listUserPermissions: vi.fn(),
}))

import type { ResolvedRequestAccess } from '../../src/multitable/access'
import { SYSTEM_SHEET_KINDS as CHECKPOINT_SYSTEM_SHEET_KINDS } from '../../src/multitable/history-trust-checkpoint'
import { MULTITABLE_MANAGE_SCHEMA_PERMISSION } from '../../src/multitable/manage-schema-permission'
import { resolveSheetCapabilitiesForAccess, type QueryFn } from '../../src/multitable/permission-service'
import { MultitableProjectNamespaceError, createPluginScopedMultitableApi } from '../../src/multitable/plugin-scope'
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
  STOCK_PREPARATION_OVERVIEW_PORT_PLUGIN,
  STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID,
  STOCK_PREPARATION_PROJECT_OVERVIEW_SYSTEM_KIND,
  StockPreparationOverviewSystemKindError,
  loadStockPreparationOverviewSheetIds,
  restrictStockPreparationOverviewCapabilities,
} from '../../src/multitable/stock-preparation-overview-contract'
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
const KEPT = new Set(['canRead', 'canExport'])
const WRITE_KEYS = [
  'canCreateRecord',
  'canEditRecord',
  'canDeleteRecord',
  'canManageFields',
  'canManageSheetAccess',
  'canManageViews',
  'canComment',
  'canManageAutomation',
  'canSendNotification',
  'canSubmitApproval',
] as const

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim()

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
    const sheet = await ensureSheet({ query: fake.query, sheetId: 'sheet_ov', baseId: 'base_x', name: ' Overview ', description: null, systemKind: KIND })
    const [insert] = fake.sheetInserts()
    expect(normalize(insert.sql)).toBe('INSERT INTO meta_sheets (id, base_id, name, description, system_kind) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING')
    expect(insert.params).toEqual(['sheet_ov', 'base_x', 'Overview', null, KIND])
    expect(sheet).toEqual({ id: 'sheet_ov', baseId: 'base_x', name: 'Overview', description: null, systemKind: KIND })
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
    const result = await createSheet({ query: fake.query, sheetId: 'sheet_ov', baseId: 'base_x', name: 'Overview', systemKind: KIND })
    expect(normalize(fake.sheetInserts()[0].sql)).toContain('(id, base_id, name, description, system_kind) VALUES ($1, $2, $3, $4, $5)')
    expect(fake.sheetInserts()[0].params[4]).toBe(KIND)
    expect(result).toEqual({ created: true, sheet: { id: 'sheet_ov', baseId: 'base_x', name: 'Overview', description: null, systemKind: KIND } })
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

  it('never rewrites an EXISTING row\'s kind (ON CONFLICT DO NOTHING, no UPDATE): an unstamped sheet stays null', async () => {
    const fake = createProvisioningQuery([{ id: 'sheet_old', base_id: 'base_x', name: 'Old', description: null, system_kind: null }])
    const sheet = await ensureSheet({ query: fake.query, sheetId: 'sheet_old', baseId: 'base_x', name: 'Old', systemKind: KIND })
    expect(sheet.systemKind).toBeNull()
    expect(fake.calls.some((call) => /\bUPDATE\b/i.test(call.sql))).toBe(false)
    expect(fake.sheets.find((row) => row.id === 'sheet_old')?.system_kind).toBeNull()
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
      const sheetId = 'sheet_s3_overview'
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
      const sheetId = 'sheet_s3_overview'
      const plain = await resolveSheetCapabilitiesForUser(clampQuery(sheetId, { overview: false, sheetCodes: person.sheetCodes }) as never, sheetId, 'u_s3_clamp')
      expect(plain.capabilities).toMatchObject({ canRead: true, canCreateRecord: true, canEditRecord: true })
      const overview = await resolveSheetCapabilitiesForUser(clampQuery(sheetId, { overview: true, sheetCodes: person.sheetCodes }) as never, sheetId, 'u_s3_clamp')
      expectClamped(overview.capabilities as unknown as Record<string, unknown>, plain.capabilities as unknown as Record<string, unknown>)
    })

    it(`resolveSheetCapabilitiesForUserOnQuery (automation FWB / record-permission routes): ${person.label}`, async () => {
      const sheetId = 'sheet_s3_overview'
      const precomputed = { isAdminRole: person.isAdminRole, permissions: person.permissions }
      const plain = await resolveSheetCapabilitiesForUserOnQuery(clampQuery(sheetId, { overview: false, sheetCodes: person.sheetCodes }), sheetId, 'u_s3_clamp', undefined, precomputed)
      expect(plain.capabilities).toMatchObject({ canRead: true, canCreateRecord: true, canEditRecord: true })
      const overview = await resolveSheetCapabilitiesForUserOnQuery(clampQuery(sheetId, { overview: true, sheetCodes: person.sheetCodes }), sheetId, 'u_s3_clamp', undefined, precomputed)
      expectClamped(overview.capabilities as unknown as Record<string, unknown>, plain.capabilities as unknown as Record<string, unknown>)
    })
  }

  it('the clamp never GRANTS read: a person who cannot read the overview still cannot', async () => {
    const sheetId = 'sheet_s3_overview'
    const resolved = await resolveSheetCapabilitiesForAccess(clampQuery(sheetId, { overview: true }), sheetId, accessOf([], false))
    expect(resolved.capabilities.canRead).toBe(false)
    expect(resolved.capabilities.canExport).toBe(false)
    for (const key of WRITE_KEYS) expect(resolved.capabilities[key]).toBe(false)
  })

  it('an ordinary sheet: the admin keeps canEditRecord (the lookup answered "not an overview")', async () => {
    const sheetId = 'sheet_plain'
    const query = clampQuery(sheetId, { overview: false })
    const resolved = await resolveSheetCapabilitiesForAccess(query, sheetId, accessOf([], true))
    expect(resolved.capabilities.canEditRecord).toBe(true)
    expect(resolved.capabilities.canManageFields).toBe(true)
    // The lookup WAS asked (for an admin too — no isAdminRole short-circuit), with the sheet id and the kind.
    const lookups = query.mock.calls.filter(([sql]) => normalize(sql as string) === OVERVIEW_SQL)
    expect(lookups).toHaveLength(1)
    expect(lookups[0][1]).toEqual([[sheetId], KIND])
  })
})

describe('S3 host — restrictStockPreparationOverviewCapabilities (pure)', () => {
  it('off the overview it returns the input object untouched', () => {
    const caps = { canRead: true, canExport: true, canEditRecord: true }
    expect(restrictStockPreparationOverviewCapabilities(caps, false)).toBe(caps)
  })

  it('on the overview it keeps canRead/canExport AS RESOLVED and forces every other can* key — including unknown future ones — to false', () => {
    const caps = { canRead: true, canExport: false, canEditRecord: true, canFutureWrite: true, canOdd: 'yes', label: 'kept' } as unknown as { canRead: boolean; canExport: boolean }
    const out = restrictStockPreparationOverviewCapabilities(caps, true) as unknown as Record<string, unknown>
    expect(out).toEqual({ canRead: true, canExport: false, canEditRecord: false, canFutureWrite: false, canOdd: false, label: 'kept' })
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

  it('issues the column-tolerant statement with the ids and the kind, and keeps only string ids', async () => {
    const query = vi.fn(async () => ({ rows: [{ id: 'sheet_a' }, { id: 7 }, { id: null }, {}] }))
    const ids = await loadStockPreparationOverviewSheetIds(query as never, ['sheet_a', 'sheet_b'])
    expect(ids).toEqual(new Set(['sheet_a']))
    expect(query).toHaveBeenCalledTimes(1)
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(normalize(sql)).toBe(OVERVIEW_SQL)
    expect(sql).toContain("to_jsonb(meta_sheets) ->> 'system_kind'")
    expect(params).toEqual([['sheet_a', 'sheet_b'], KIND])
  })
})
