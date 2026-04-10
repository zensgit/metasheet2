/**
 * Unit tests for plugin-after-sales installer orchestrator.
 *
 * Design invariants locked by these tests:
 *  - validateBlueprint rejects structurally invalid input and accepts a
 *    minimum viable blueprint
 *  - getProjectId returns the v1 pseudo value `${tenantId}:${appId}`
 *  - mode='enable' with existing ledger row -> already-installed
 *  - mode='reinstall' with no ledger row -> no-install-to-rebuild
 *  - mode='enable' with no row writes terminal 'installed' ledger row
 *  - mode='reinstall' with existing row updates ledger (UPSERT semantics)
 *  - Ledger-write failure surfaces as LEDGER_WRITE_FAILED
 *  - loadCurrent returns not-installed when ledger is empty
 *  - loadCurrent returns full ProjectCurrentResponse shape when a row exists
 *    (including displayName, config, installResult with reportRef)
 *
 * Design reference:
 *  - platform-object-model-and-template-installer-design-20260407.md §3 §4 §6
 *  - platform-project-builder-and-template-architecture-design-20260407.md §5.2.1 §6.2 §6.3
 *  - platform-project-creation-flow-design-20260407.md §4.3
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// CJS interop: the installer module lives under plugins/ and is authored as CJS
// to match the plugin-after-sales skeleton convention.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const installer = require('../../../../plugins/plugin-after-sales/lib/installer.cjs') as {
  ERROR_CODES: {
    VALIDATION_FAILED: string
    ALREADY_INSTALLED: string
    NO_INSTALL_TO_REBUILD: string
    CORE_OBJECT_FAILED: string
    LEDGER_READ_FAILED: string
    LEDGER_WRITE_FAILED: string
    INVALID_TEMPLATE_ID: string
  }
  InstallerError: new (code: string, message: string, meta?: unknown) => Error & {
    code: string
    meta: unknown
  }
  LEDGER_TABLE: string
  getProjectId: (tenantId: string, appId: string) => string
  validateBlueprint: (blueprint: unknown) => void
  loadInstallLedger: (db: FakeDatabase, tenantId: string, appId: string) => Promise<FakeRow | null>
  writeInstallLedger: (db: FakeDatabase, row: LedgerInput) => Promise<FakeRow>
  runInstall: (input: RunInstallInput) => Promise<RunInstallResult>
  loadCurrent: (context: FakeContext, tenantId: string, appId: string) => Promise<CurrentResponse>
}

// --------------------------------------------------------------------------
// Test fixtures
// --------------------------------------------------------------------------

interface FakeRowRaw {
  id: string
  tenant_id: string
  app_id: string
  project_id: string
  template_id: string
  template_version: string
  mode: string
  status: string
  created_objects_json: string
  created_views_json: string
  warnings_json: string
  display_name: string
  config_json: string
  last_install_at: Date
  created_at: Date
}

interface FakeRow {
  id: string
  tenantId: string
  appId: string
  projectId: string
  status: string
  createdObjects: string[]
  createdViews: string[]
  warnings: string[]
  displayName: string
  config: Record<string, unknown>
}

interface LedgerInput {
  tenantId: string
  appId: string
  projectId: string
  templateId: string
  templateVersion: string
  mode: string
  status: string
  createdObjects: string[]
  createdViews: string[]
  warnings: string[]
  displayName: string
  config: Record<string, unknown>
}

interface RunInstallInput {
  context: FakeContext
  tenantId: string
  blueprint: unknown
  mode: string
  displayName?: string
  config?: Record<string, unknown>
}

interface RunInstallResult {
  projectId: string
  appId: string
  status: string
  createdObjects: string[]
  createdViews: string[]
  warnings: string[]
  reportRef: string
}

interface CurrentResponse {
  status: string
  projectId?: string
  displayName?: string
  config?: Record<string, unknown>
  installResult?: unknown
  reportRef?: string
}

interface FakeDatabase {
  rows: FakeRowRaw[]
  query: (sql: string, params?: unknown[]) => Promise<FakeRowRaw[]>
  // Optional hook to force next query to throw (simulates DB failure)
  failNextQuery?: string
}

interface FakeContext {
  api: {
    database: FakeDatabase
    multitable?: {
      provisioning?: {
        ensureObject: (input: {
          projectId: string
          descriptor: Record<string, unknown>
        }) => Promise<unknown>
        ensureView?: (input: {
          projectId: string
          sheetId: string
          descriptor: Record<string, unknown>
        }) => Promise<unknown>
      }
    }
  }
  metadata?: {
    name?: string
  }
  services?: {
    automationRegistry?: {
      upsertRules: (input: Record<string, unknown>) => Promise<unknown>
    }
    rbacProvisioning?: {
      applyRoleMatrix: (input: Record<string, unknown>) => Promise<unknown>
    }
  }
}

function createFakeDatabase(): FakeDatabase {
  const db: FakeDatabase = {
    rows: [],
    async query(sql: string, params: unknown[] = []) {
      if (db.failNextQuery) {
        const msg = db.failNextQuery
        db.failNextQuery = undefined
        throw new Error(msg)
      }
      const normalized = sql.replace(/\s+/g, ' ').trim()
      if (normalized.startsWith('SELECT')) {
        const [tenantId, appId] = params as [string, string]
        return db.rows.filter((r) => r.tenant_id === tenantId && r.app_id === appId)
      }
      if (normalized.startsWith('INSERT INTO')) {
        const [
          tenantId,
          appId,
          projectId,
          templateId,
          templateVersion,
          mode,
          status,
          createdObjectsJson,
          createdViewsJson,
          warningsJson,
          displayName,
          configJson,
        ] = params as string[]
        const now = new Date()
        const existingIdx = db.rows.findIndex(
          (r) => r.tenant_id === tenantId && r.app_id === appId,
        )
        if (existingIdx >= 0) {
          const updated: FakeRowRaw = {
            ...db.rows[existingIdx],
            project_id: projectId,
            template_id: templateId,
            template_version: templateVersion,
            mode,
            status,
            created_objects_json: createdObjectsJson,
            created_views_json: createdViewsJson,
            warnings_json: warningsJson,
            display_name: displayName,
            config_json: configJson,
            last_install_at: now,
          }
          db.rows[existingIdx] = updated
          return [updated]
        }
        const newRow: FakeRowRaw = {
          id: `fake-uuid-${db.rows.length + 1}`,
          tenant_id: tenantId,
          app_id: appId,
          project_id: projectId,
          template_id: templateId,
          template_version: templateVersion,
          mode,
          status,
          created_objects_json: createdObjectsJson,
          created_views_json: createdViewsJson,
          warnings_json: warningsJson,
          display_name: displayName,
          config_json: configJson,
          last_install_at: now,
          created_at: now,
        }
        db.rows.push(newRow)
        return [newRow]
      }
      return []
    },
  }
  return db
}

function buildValidBlueprint() {
  return {
    id: 'after-sales-default',
    version: '0.1.0',
    displayName: 'After Sales Default',
    appId: 'after-sales',
    objects: [
      { id: 'customer', name: 'Customer', backing: 'multitable' },
      { id: 'serviceTicket', name: 'Service Ticket', backing: 'multitable' },
      { id: 'warrantyPolicy', name: 'Warranty Policy', backing: 'service' },
    ],
    views: [{ id: 'ticket-board', objectId: 'serviceTicket', type: 'kanban', name: 'Board' }],
    automations: [],
    roles: [],
    fieldPolicies: [],
    notifications: [],
    configDefaults: {},
  }
}

function buildAdapterBackedBlueprint() {
  return {
    ...buildValidBlueprint(),
    automations: [
      {
        id: 'ticket-triage',
        trigger: { event: 'ticket.created' },
        actions: [{ type: 'sendNotification', topic: 'after-sales.ticket.assigned' }],
        enabled: true,
      },
    ],
    roles: [
      {
        slug: 'finance',
        label: 'Finance',
        permissions: ['after_sales:read', 'after_sales:approve'],
      },
    ],
    fieldPolicies: [
      {
        objectId: 'serviceTicket',
        field: 'refundAmount',
        roleSlug: 'finance',
        visibility: 'visible',
        editability: 'editable',
      },
    ],
  }
}

function buildRunInput(
  overrides: Partial<RunInstallInput> = {},
  db?: FakeDatabase,
): RunInstallInput {
  return {
    context: { api: { database: db || createFakeDatabase() } },
    tenantId: 'tenant_42',
    blueprint: buildValidBlueprint(),
    mode: 'enable',
    displayName: 'Acme Support',
    config: { enableWarranty: true, defaultSlaHours: 24 },
    ...overrides,
  }
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe('plugin-after-sales installer: ERROR_CODES', () => {
  it('exposes all 7 canonical codes', () => {
    expect(installer.ERROR_CODES).toMatchObject({
      VALIDATION_FAILED: 'validation-failed',
      ALREADY_INSTALLED: 'already-installed',
      NO_INSTALL_TO_REBUILD: 'no-install-to-rebuild',
      CORE_OBJECT_FAILED: 'core-object-failed',
      LEDGER_READ_FAILED: 'ledger-read-failed',
      LEDGER_WRITE_FAILED: 'ledger-write-failed',
      INVALID_TEMPLATE_ID: 'invalid-template-id',
    })
  })

  it('ERROR_CODES object is frozen', () => {
    expect(Object.isFrozen(installer.ERROR_CODES)).toBe(true)
  })
})

describe('plugin-after-sales installer: getProjectId', () => {
  it('returns ${tenantId}:${appId} pseudo value', () => {
    expect(installer.getProjectId('tenant_42', 'after-sales')).toBe('tenant_42:after-sales')
  })

  it('throws VALIDATION_FAILED when tenantId is missing', () => {
    expect(() => installer.getProjectId('', 'after-sales')).toThrowError()
    try {
      installer.getProjectId('', 'after-sales')
    } catch (err) {
      expect((err as { code: string }).code).toBe(installer.ERROR_CODES.VALIDATION_FAILED)
    }
  })

  it('throws VALIDATION_FAILED when appId is missing', () => {
    expect(() => installer.getProjectId('tenant_42', '')).toThrowError()
    try {
      installer.getProjectId('tenant_42', '')
    } catch (err) {
      expect((err as { code: string }).code).toBe(installer.ERROR_CODES.VALIDATION_FAILED)
    }
  })
})

describe('plugin-after-sales installer: validateBlueprint', () => {
  it('rejects non-object input', () => {
    expect(() => installer.validateBlueprint(null)).toThrowError(/blueprint is not an object/)
    expect(() => installer.validateBlueprint(undefined)).toThrowError()
    expect(() => installer.validateBlueprint(42)).toThrowError()
    expect(() => installer.validateBlueprint('string')).toThrowError()
  })

  it('rejects blueprint missing id', () => {
    const bp = buildValidBlueprint() as Record<string, unknown>
    delete bp.id
    expect(() => installer.validateBlueprint(bp)).toThrowError(/blueprint\.id missing/)
  })

  it('rejects blueprint missing version', () => {
    const bp = buildValidBlueprint() as Record<string, unknown>
    delete bp.version
    expect(() => installer.validateBlueprint(bp)).toThrowError(/blueprint\.version missing/)
  })

  it('rejects blueprint missing appId', () => {
    const bp = buildValidBlueprint() as Record<string, unknown>
    delete bp.appId
    expect(() => installer.validateBlueprint(bp)).toThrowError(/blueprint\.appId missing/)
  })

  it('rejects blueprint with empty objects array', () => {
    const bp = { ...buildValidBlueprint(), objects: [] }
    expect(() => installer.validateBlueprint(bp)).toThrowError(/non-empty array/)
  })

  it('rejects blueprint with missing objects array', () => {
    const bp = buildValidBlueprint() as Record<string, unknown>
    delete bp.objects
    expect(() => installer.validateBlueprint(bp)).toThrowError(/non-empty array/)
  })

  it('rejects object descriptor without id', () => {
    const bp = buildValidBlueprint()
    bp.objects = [{ id: '', name: 'x', backing: 'multitable' } as never]
    expect(() => installer.validateBlueprint(bp)).toThrowError(/object\.id missing/)
  })

  it('rejects object descriptor with invalid backing', () => {
    const bp = buildValidBlueprint()
    bp.objects = [{ id: 'x', name: 'x', backing: 'postgres' } as never]
    expect(() => installer.validateBlueprint(bp)).toThrowError(/object\.backing invalid/)
  })

  it('accepts a valid minimum blueprint', () => {
    expect(() => installer.validateBlueprint(buildValidBlueprint())).not.toThrow()
  })

  it('accepts service and hybrid backings', () => {
    const bp = buildValidBlueprint()
    bp.objects = [
      { id: 'a', name: 'A', backing: 'multitable' },
      { id: 'b', name: 'B', backing: 'service' },
      { id: 'c', name: 'C', backing: 'hybrid' },
    ]
    expect(() => installer.validateBlueprint(bp)).not.toThrow()
  })

  it('rejects blueprint with non-array automations', () => {
    const bp = buildValidBlueprint() as Record<string, unknown>
    bp.automations = 'ticket-triage'
    expect(() => installer.validateBlueprint(bp)).toThrowError(/blueprint\.automations must be an array/)
  })

  it('rejects blueprint with non-array roles', () => {
    const bp = buildValidBlueprint() as Record<string, unknown>
    bp.roles = { slug: 'finance' }
    expect(() => installer.validateBlueprint(bp)).toThrowError(/blueprint\.roles must be an array/)
  })

  it('rejects blueprint with non-array fieldPolicies', () => {
    const bp = buildValidBlueprint() as Record<string, unknown>
    bp.fieldPolicies = { field: 'refundAmount' }
    expect(() => installer.validateBlueprint(bp)).toThrowError(/blueprint\.fieldPolicies must be an array/)
  })
})

describe('plugin-after-sales installer: runInstall enable mode', () => {
  let db: FakeDatabase

  beforeEach(() => {
    db = createFakeDatabase()
  })

  it('writes a ledger row with status=installed on first install', async () => {
    const result = await installer.runInstall(buildRunInput({ mode: 'enable' }, db))

    expect(result.status).toBe('installed')
    expect(result.projectId).toBe('tenant_42:after-sales')
    expect(result.appId).toBe('after-sales')
    expect(result.reportRef).toMatch(/^fake-uuid-/)
    expect(db.rows).toHaveLength(1)
    expect(db.rows[0].status).toBe('installed')
    expect(db.rows[0].tenant_id).toBe('tenant_42')
    expect(db.rows[0].app_id).toBe('after-sales')
  })

  it('records createdObjects only for multitable backings', async () => {
    const result = await installer.runInstall(buildRunInput({ mode: 'enable' }, db))
    // blueprint has 2 multitable + 1 service objects
    expect(result.createdObjects).toEqual(['customer', 'serviceTicket'])
    expect(result.createdObjects).not.toContain('warrantyPolicy')
  })

  it('calls multitable provisioning seam when available on context.api', async () => {
    const ensureObject = vi.fn(async () => ({
      baseId: 'base_legacy',
      sheet: { id: 'sheet_customer', baseId: 'base_legacy', name: 'Any', description: null },
      fields: [],
    }))
    const ensureView = vi.fn(async () => ({
      id: 'view_ticket_board',
      sheetId: 'sheet_customer',
      name: 'Board',
      type: 'kanban',
      filterInfo: {},
      sortInfo: {},
      groupInfo: {},
      hiddenFieldIds: [],
      config: {},
    }))
    const input = buildRunInput({ mode: 'enable' }, db)
    const blueprint = input.blueprint as { objects: Array<Record<string, unknown>> }
    input.context.api.multitable = {
      provisioning: {
        ensureObject,
        ensureView,
      },
    }

    const result = await installer.runInstall(input)

    expect(result.status).toBe('installed')
    expect(ensureObject).toHaveBeenCalledTimes(2)
    expect(ensureObject).toHaveBeenNthCalledWith(1, {
      projectId: 'tenant_42:after-sales',
      descriptor: blueprint.objects[0],
    })
    expect(ensureObject).toHaveBeenNthCalledWith(2, {
      projectId: 'tenant_42:after-sales',
      descriptor: blueprint.objects[1],
    })
    expect(ensureView).toHaveBeenCalledTimes(1)
    expect(ensureView).toHaveBeenCalledWith({
      projectId: 'tenant_42:after-sales',
      sheetId: 'sheet_customer',
      descriptor: { id: 'ticket-board', objectId: 'serviceTicket', type: 'kanban', name: 'Board' },
    })
  })

  it('records createdViews from blueprint.views', async () => {
    const result = await installer.runInstall(buildRunInput({ mode: 'enable' }, db))
    expect(result.createdViews).toEqual(['ticket-board'])
  })

  it('registers automations and applies role matrix when services are present', async () => {
    const upsertRules = vi.fn(async () => [{ id: 'ticket-triage', enabled: true }])
    const applyRoleMatrix = vi.fn(async () => ({
      rolesApplied: ['finance'],
      fieldPoliciesApplied: 1,
    }))

    const result = await installer.runInstall(
      buildRunInput(
        {
          mode: 'enable',
          blueprint: buildAdapterBackedBlueprint(),
          context: {
            api: { database: db },
            metadata: { name: 'plugin-after-sales' },
            services: {
              automationRegistry: { upsertRules },
              rbacProvisioning: { applyRoleMatrix },
            },
          },
        },
        db,
      ),
    )

    expect(result.status).toBe('installed')
    expect(upsertRules).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: 'plugin-after-sales',
        appId: 'after-sales',
        tenantId: 'tenant_42',
        projectId: 'tenant_42:after-sales',
        templateId: 'after-sales-default',
      }),
    )
    expect(applyRoleMatrix).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: 'plugin-after-sales',
        appId: 'after-sales',
        tenantId: 'tenant_42',
        projectId: 'tenant_42:after-sales',
        matrix: {
          roles: [
            {
              slug: 'finance',
              label: 'Finance',
              permissions: ['after_sales:read', 'after_sales:approve'],
            },
          ],
          fieldPolicies: [
            {
              objectId: 'serviceTicket',
              field: 'refundAmount',
              roleSlug: 'finance',
              visibility: 'visible',
              editability: 'editable',
            },
          ],
        },
      }),
    )
  })

  it('falls back to plugin-after-sales when metadata.name is missing', async () => {
    const upsertRules = vi.fn(async () => [{ id: 'ticket-triage', enabled: true }])
    const applyRoleMatrix = vi.fn(async () => ({
      rolesApplied: ['finance'],
      fieldPoliciesApplied: 1,
    }))

    await installer.runInstall(
      buildRunInput(
        {
          mode: 'enable',
          blueprint: buildAdapterBackedBlueprint(),
          context: {
            api: { database: db },
            services: {
              automationRegistry: { upsertRules },
              rbacProvisioning: { applyRoleMatrix },
            },
          },
        },
        db,
      ),
    )

    expect(upsertRules).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: 'plugin-after-sales',
      }),
    )
    expect(applyRoleMatrix).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: 'plugin-after-sales',
      }),
    )
  })

  it('persists displayName and config to the ledger row', async () => {
    await installer.runInstall(
      buildRunInput(
        {
          mode: 'enable',
          displayName: 'Acme Support',
          config: { enableWarranty: false, defaultSlaHours: 8 },
        },
        db,
      ),
    )
    expect(db.rows[0].display_name).toBe('Acme Support')
    expect(JSON.parse(db.rows[0].config_json)).toEqual({
      enableWarranty: false,
      defaultSlaHours: 8,
    })
  })

  it('throws already-installed when mode=enable and a row already exists', async () => {
    // Pre-populate one row
    await installer.runInstall(buildRunInput({ mode: 'enable' }, db))
    expect(db.rows).toHaveLength(1)

    // Second enable should fail
    await expect(installer.runInstall(buildRunInput({ mode: 'enable' }, db))).rejects.toThrow()

    try {
      await installer.runInstall(buildRunInput({ mode: 'enable' }, db))
    } catch (err) {
      const e = err as { code: string; meta: { reportRef: string; projectId: string } }
      expect(e.code).toBe(installer.ERROR_CODES.ALREADY_INSTALLED)
      expect(e.meta.reportRef).toMatch(/^fake-uuid-/)
      expect(e.meta.projectId).toBe('tenant_42:after-sales')
    }

    // Ledger state unchanged (still exactly 1 row)
    expect(db.rows).toHaveLength(1)
  })

  it('throws VALIDATION_FAILED for invalid blueprint', async () => {
    const input = buildRunInput({ mode: 'enable', blueprint: { id: 'x' } }, db)
    await expect(installer.runInstall(input)).rejects.toThrow()
    try {
      await installer.runInstall(input)
    } catch (err) {
      expect((err as { code: string }).code).toBe(installer.ERROR_CODES.VALIDATION_FAILED)
    }
    // No ledger row written on validation failure
    expect(db.rows).toHaveLength(0)
  })

  it('throws VALIDATION_FAILED for invalid mode value', async () => {
    const input = buildRunInput({ mode: 'unknown' as never }, db)
    await expect(installer.runInstall(input)).rejects.toThrow()
  })

  it('throws LEDGER_WRITE_FAILED when ledger INSERT throws', async () => {
    // Make the next write query fail. SELECT for loadInstallLedger runs first,
    // then the INSERT. Configure the hook so that the INSERT throws.
    const originalQuery = db.query.bind(db)
    db.query = async (sql: string, params?: unknown[]) => {
      if (sql.replace(/\s+/g, ' ').trim().startsWith('INSERT INTO')) {
        throw new Error('simulated db down')
      }
      return originalQuery(sql, params)
    }

    await expect(installer.runInstall(buildRunInput({ mode: 'enable' }, db))).rejects.toThrow()
    try {
      await installer.runInstall(buildRunInput({ mode: 'enable' }, db))
    } catch (err) {
      expect((err as { code: string }).code).toBe(installer.ERROR_CODES.LEDGER_WRITE_FAILED)
    }
    // Confirming the invariant: LEDGER_WRITE_FAILED means no row persisted
    expect(db.rows).toHaveLength(0)
  })

  it('throws LEDGER_READ_FAILED when ledger SELECT throws before branching', async () => {
    db.failNextQuery = 'simulated ledger read failure'

    await expect(installer.runInstall(buildRunInput({ mode: 'enable' }, db))).rejects.toMatchObject({
      code: installer.ERROR_CODES.LEDGER_READ_FAILED,
    })
    expect(db.rows).toHaveLength(0)
  })

  it('returns partial when automation registry registration fails', async () => {
    const upsertRules = vi.fn(async () => {
      throw new Error('automation registry down')
    })

    const result = await installer.runInstall(
      buildRunInput(
        {
          mode: 'enable',
          blueprint: buildAdapterBackedBlueprint(),
          context: {
            api: { database: db },
            metadata: { name: 'plugin-after-sales' },
            services: {
              automationRegistry: { upsertRules },
              rbacProvisioning: {
                applyRoleMatrix: vi.fn(async () => ({
                  rolesApplied: ['finance'],
                  fieldPoliciesApplied: 1,
                })),
              },
            },
          },
        },
        db,
      ),
    )

    expect(result.status).toBe('partial')
    expect(result.warnings).toContain('automation registration failed: automation registry down')
    expect(db.rows[0].status).toBe('partial')
  })

  it('returns partial when role matrix provisioning fails', async () => {
    const applyRoleMatrix = vi.fn(async () => {
      throw new Error('rbac registry down')
    })

    const result = await installer.runInstall(
      buildRunInput(
        {
          mode: 'enable',
          blueprint: buildAdapterBackedBlueprint(),
          context: {
            api: { database: db },
            metadata: { name: 'plugin-after-sales' },
            services: {
              automationRegistry: {
                upsertRules: vi.fn(async () => [{ id: 'ticket-triage', enabled: true }]),
              },
              rbacProvisioning: { applyRoleMatrix },
            },
          },
        },
        db,
      ),
    )

    expect(result.status).toBe('partial')
    expect(result.warnings).toContain('rbac provisioning failed: rbac registry down')
    expect(db.rows[0].status).toBe('partial')
  })
})

describe('plugin-after-sales installer: runInstall reinstall mode', () => {
  let db: FakeDatabase

  beforeEach(() => {
    db = createFakeDatabase()
  })

  it('throws no-install-to-rebuild when no row exists', async () => {
    await expect(installer.runInstall(buildRunInput({ mode: 'reinstall' }, db))).rejects.toThrow()
    try {
      await installer.runInstall(buildRunInput({ mode: 'reinstall' }, db))
    } catch (err) {
      expect((err as { code: string }).code).toBe(installer.ERROR_CODES.NO_INSTALL_TO_REBUILD)
    }
    expect(db.rows).toHaveLength(0)
  })

  it('upserts existing row when reinstalling', async () => {
    // First enable to create a row
    const initial = await installer.runInstall(buildRunInput({ mode: 'enable' }, db))
    expect(db.rows).toHaveLength(1)
    const firstInstallAt = db.rows[0].last_install_at.getTime()

    // Sleep a tiny bit to ensure different timestamp
    await new Promise((resolve) => setTimeout(resolve, 5))

    // Reinstall with updated displayName
    const result = await installer.runInstall(
      buildRunInput(
        {
          mode: 'reinstall',
          displayName: 'Acme Support Updated',
        },
        db,
      ),
    )

    expect(result.status).toBe('installed')
    expect(result.reportRef).toBe(initial.reportRef) // Same row id
    expect(db.rows).toHaveLength(1) // Still one row
    expect(db.rows[0].display_name).toBe('Acme Support Updated')
    expect(db.rows[0].mode).toBe('reinstall')
    expect(db.rows[0].last_install_at.getTime()).toBeGreaterThan(firstInstallAt)
  })
})

describe('plugin-after-sales installer: loadCurrent', () => {
  let db: FakeDatabase

  beforeEach(() => {
    db = createFakeDatabase()
  })

  it('returns not-installed when ledger is empty', async () => {
    const context: FakeContext = { api: { database: db } }
    const current = await installer.loadCurrent(context, 'tenant_42', 'after-sales')
    expect(current).toEqual({ status: 'not-installed' })
  })

  it('throws LEDGER_READ_FAILED when loadCurrent cannot read the ledger', async () => {
    db.failNextQuery = 'simulated ledger read failure'
    const context: FakeContext = { api: { database: db } }

    await expect(installer.loadCurrent(context, 'tenant_42', 'after-sales')).rejects.toMatchObject({
      code: installer.ERROR_CODES.LEDGER_READ_FAILED,
    })
  })

  it('returns full ProjectCurrentResponse shape when a row exists', async () => {
    // Install first
    await installer.runInstall(
      buildRunInput(
        {
          mode: 'enable',
          displayName: 'Acme Support',
          config: { enableWarranty: true, defaultSlaHours: 24 },
        },
        db,
      ),
    )

    const context: FakeContext = { api: { database: db } }
    const current = await installer.loadCurrent(context, 'tenant_42', 'after-sales')

    expect(current.status).toBe('installed')
    expect(current.projectId).toBe('tenant_42:after-sales')
    expect(current.displayName).toBe('Acme Support')
    expect(current.config).toEqual({ enableWarranty: true, defaultSlaHours: 24 })
    expect(current.reportRef).toMatch(/^fake-uuid-/)
    expect(current.installResult).toMatchObject({
      projectId: 'tenant_42:after-sales',
      status: 'installed',
      createdObjects: ['customer', 'serviceTicket'],
      createdViews: ['ticket-board'],
      warnings: [],
    })
  })

  it('returns not-installed for a different tenant even when row exists', async () => {
    await installer.runInstall(buildRunInput({ mode: 'enable', tenantId: 'tenant_A' }, db))

    const context: FakeContext = { api: { database: db } }
    const current = await installer.loadCurrent(context, 'tenant_B', 'after-sales')
    expect(current.status).toBe('not-installed')
  })
})

describe('plugin-after-sales installer: InstallerError', () => {
  it('carries code and meta', () => {
    const err = new installer.InstallerError('already-installed', 'oops', {
      reportRef: 'r_1',
    }) as Error & { code: string; meta: { reportRef: string } }
    expect(err.name).toBe('InstallerError')
    expect(err.code).toBe('already-installed')
    expect(err.message).toBe('oops')
    expect(err.meta.reportRef).toBe('r_1')
    expect(err instanceof Error).toBe(true)
  })

  it('defaults meta to null when not provided', () => {
    const err = new installer.InstallerError('validation-failed', 'no blueprint') as Error & {
      meta: unknown
    }
    expect(err.meta).toBeNull()
  })
})
