import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_BASE_ID,
  createSheet,
  ensureLegacyBase,
  ensureObject,
  ensureView,
  findObjectSheet,
  patchObjectFieldProperty,
  getObjectField,
  resolveObjectFieldIds,
  buildObjectFieldsRepairSurface,
  runObjectFieldsRepairTransactionWith,
  ensureMissingObjectFields,
  type MultitableProvisioningQueryFn,
} from '../../src/multitable/provisioning'
import {
  ENSURE_FIELDS_OVERWRITE_MODE_ENV,
  MultitableEnsureFieldsRefusedError,
} from '../../src/multitable/ensureFieldsOverwriteMode'

type FakeBase = {
  id: string
  name: string
}

type FakeSheet = {
  id: string
  base_id: string
  name: string
  description: string | null
}

type FakeField = {
  id: string
  sheet_id: string
  name: string
  type: string
  property: Record<string, unknown>
  order: number
}

type FakeView = {
  id: string
  sheet_id: string
  name: string
  type: string
  filter_info: Record<string, unknown>
  sort_info: Record<string, unknown>
  group_info: Record<string, unknown>
  hidden_field_ids: string[]
  config: Record<string, unknown>
}

function createQuery(): {
  query: MultitableProvisioningQueryFn
  bases: FakeBase[]
  sheets: FakeSheet[]
  fields: FakeField[]
  views: FakeView[]
} {
  const bases: FakeBase[] = []
  const sheets: FakeSheet[] = []
  const fields: FakeField[] = []
  const views: FakeView[] = []

  const query: MultitableProvisioningQueryFn = async (sql, params = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim()

    if (normalized.startsWith('INSERT INTO meta_bases')) {
      const [id, name] = params as [string, string]
      if (!bases.find((base) => base.id === id)) {
        bases.push({ id, name })
      }
      return { rows: [], rowCount: 1 }
    }

    if (normalized.startsWith('INSERT INTO meta_sheets')) {
      const [id, baseId, name, description] = params as [string, string, string, string | null]
      if (!sheets.find((sheet) => sheet.id === id)) {
        sheets.push({
          id,
          base_id: baseId,
          name,
          description,
        })
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }

    if (normalized.includes('FROM meta_sheets') && normalized.includes('WHERE id = $1')) {
      const [sheetId] = params as [string]
      return {
        rows: sheets.filter((sheet) => sheet.id === sheetId),
      }
    }

    if (normalized.startsWith('INSERT INTO meta_fields')) {
      const [id, sheetId, name, type, propertyJson, order] = params as [
        string,
        string,
        string,
        string,
        string,
        number,
      ]
      const existing = fields.find((field) => field.id === id)
      const nextField = {
        id,
        sheet_id: sheetId,
        name,
        type,
        property: JSON.parse(propertyJson),
        order,
      }
      if (existing) {
        // Honor the actual conflict clause: `DO NOTHING` (preserve mode and
        // ensureMissingObjectFields) must leave the stored row untouched and report
        // rowCount 0, which is how additive callers tell "added" from "skipped".
        if (normalized.includes('ON CONFLICT (id) DO NOTHING')) {
          return { rows: [], rowCount: 0 }
        }
        Object.assign(existing, nextField)
      } else {
        fields.push(nextField)
      }
      return { rows: [], rowCount: 1 }
    }

    if (normalized.startsWith('INSERT INTO meta_views')) {
      const [id, sheetId, name, type, filterInfoJson, sortInfoJson, groupInfoJson, hiddenFieldIdsJson, configJson] = params as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
      const nextView = {
        id,
        sheet_id: sheetId,
        name,
        type,
        filter_info: JSON.parse(filterInfoJson),
        sort_info: JSON.parse(sortInfoJson),
        group_info: JSON.parse(groupInfoJson),
        hidden_field_ids: JSON.parse(hiddenFieldIdsJson),
        config: JSON.parse(configJson),
      }
      const existing = views.find((view) => view.id === id)
      if (existing) {
        if (normalized.includes('ON CONFLICT (id) DO UPDATE')) {
          Object.assign(existing, nextView)
          return { rows: [], rowCount: 1 }
        }
        return { rows: [], rowCount: 0 }
      } else {
        views.push(nextView)
        return { rows: [], rowCount: 1 }
      }
    }

    // P0-S S3 destructive-reconcile pre-read. The guard is fail-closed by DEFAULT now, so
    // every ensureFields/ensureObject call issues this SELECT before each upsert; without
    // this branch the fake would fall through to the `Unhandled SQL` throw below.
    if (
      normalized.includes('FROM meta_fields') &&
      normalized.includes('WHERE id = $1 AND sheet_id = $2')
    ) {
      const [id, sheetId] = params as [string, string]
      return {
        rows: fields.filter((field) => field.id === id && field.sheet_id === sheetId),
      }
    }

    if (normalized.includes('FROM meta_fields') && normalized.includes('id = ANY($2::text[])')) {
      const [sheetId, ids] = params as [string, string[]]
      const idSet = new Set(ids)
      return {
        rows: fields
          .filter((field) => field.sheet_id === sheetId && idSet.has(field.id))
          .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)),
      }
    }

    if (normalized.includes('FROM meta_fields') && normalized.includes('WHERE sheet_id = $1 AND id = $2')) {
      const [sheetId, id] = params as [string, string]
      return {
        rows: fields.filter((field) => field.sheet_id === sheetId && field.id === id),
      }
    }

    if (normalized.startsWith('UPDATE meta_fields SET property = $3::jsonb')) {
      const [sheetId, id, propertyJson] = params as [string, string, string]
      const field = fields.find((entry) => entry.sheet_id === sheetId && entry.id === id)
      if (!field) return { rows: [], rowCount: 0 }
      field.property = JSON.parse(propertyJson)
      return { rows: [field], rowCount: 1 }
    }

    if (normalized.includes('FROM meta_views') && normalized.includes('WHERE id = $1')) {
      const [viewId] = params as [string]
      return {
        rows: views.filter((view) => view.id === viewId),
      }
    }

    throw new Error(`Unhandled SQL in test: ${normalized}`)
  }

  return { query, bases, sheets, fields, views }
}

describe('multitable provisioning helper', () => {
  it('ensures the legacy base', async () => {
    const { query, bases } = createQuery()

    const baseId = await ensureLegacyBase(query)

    expect(baseId).toBe(DEFAULT_BASE_ID)
    expect(bases).toEqual([
      {
        id: 'base_legacy',
        name: 'Migrated Base',
      },
    ])
  })

  it('ensures one object with deterministic sheet and field ids', async () => {
    const { query, bases, sheets, fields } = createQuery()

    const first = await ensureObject({
      query,
      projectId: 'tenant_42:after-sales',
      descriptor: {
        id: 'installedAsset',
        name: 'Installed Asset',
        fields: [
          { id: 'assetCode', name: 'Asset Code', type: 'string' },
          { id: 'serialNo', name: 'Serial No', type: 'string' },
        ],
      },
    })

    const second = await ensureObject({
      query,
      projectId: 'tenant_42:after-sales',
      descriptor: {
        id: 'installedAsset',
        name: 'Installed Asset',
        fields: [
          { id: 'assetCode', name: 'Asset Code', type: 'string' },
          { id: 'serialNo', name: 'Serial No', type: 'string' },
        ],
      },
    })

    expect(first.baseId).toBe(DEFAULT_BASE_ID)
    expect(first.sheet.id).toBe(second.sheet.id)
    expect(first.fields.map((field) => field.id)).toEqual(second.fields.map((field) => field.id))
    expect(first.fields.map((field) => field.name)).toEqual(['Asset Code', 'Serial No'])
    expect(bases).toHaveLength(1)
    expect(sheets).toHaveLength(1)
    expect(fields).toHaveLength(2)
  })

  it('finds provisioned sheets and resolves logical field ids without leaking hash details', async () => {
    const { query } = createQuery()

    const ensured = await ensureObject({
      query,
      projectId: 'tenant_42:after-sales',
      descriptor: {
        id: 'serviceTicket',
        name: 'Service Ticket',
        fields: [
          { id: 'ticketNo', name: 'Ticket No', type: 'string' },
          { id: 'status', name: 'Status', type: 'select', options: ['new', 'done'] },
        ],
      },
    })

    const sheet = await findObjectSheet(query, 'tenant_42:after-sales', 'serviceTicket')
    const resolved = resolveObjectFieldIds('tenant_42:after-sales', 'serviceTicket', ['ticketNo', 'status'])

    expect(sheet).toEqual(ensured.sheet)
    expect(resolved).toEqual({
      ticketNo: ensured.fields[0]?.id,
      status: ensured.fields[1]?.id,
    })
  })

  it('creates a sheet once and reports conflicts on repeats', async () => {
    const { query, sheets } = createQuery()

    const first = await createSheet({
      query,
      sheetId: 'sheet_vendor_intake',
      name: 'Vendor Intake',
      description: 'Main vendor list',
    })

    const second = await createSheet({
      query,
      sheetId: 'sheet_vendor_intake',
      name: 'Vendor Intake',
      description: 'Main vendor list',
    })

    expect(first).toEqual({
      created: true,
      sheet: {
        id: 'sheet_vendor_intake',
        baseId: DEFAULT_BASE_ID,
        name: 'Vendor Intake',
        description: 'Main vendor list',
      },
    })
    expect(second).toEqual({
      created: false,
      sheet: null,
    })
    expect(sheets).toHaveLength(1)
  })

  it('serializes select field options when ensuring object fields', async () => {
    const { query } = createQuery()

    const result = await ensureObject({
      query,
      projectId: 'tenant_42:after-sales',
      descriptor: {
        id: 'installedAsset',
        name: 'Installed Asset',
        fields: [
          {
            id: 'status',
            name: 'Status',
            type: 'select',
            options: ['active', 'expired', 'decommissioned'],
          },
        ],
      },
    })

    expect(result.fields).toEqual([
      expect.objectContaining({
        name: 'Status',
        type: 'select',
        property: {
          options: [
            { value: 'active' },
            { value: 'expired' },
            { value: 'decommissioned' },
          ],
        },
      }),
    ])
  })

  it('patches provisioned field property without accepting prototype-pollution keys', async () => {
    const { query, fields } = createQuery()

    await ensureObject({
      query,
      projectId: 'tenant_42:after-sales',
      descriptor: {
        id: 'installedAsset',
        name: 'Installed Asset',
        fields: [
          {
            id: 'status',
            name: 'Status',
            type: 'select',
            options: ['new'],
            property: { stockPreparation: { ownership: 'human_preserved' } },
          },
        ],
      },
    })

    const patched = await patchObjectFieldProperty({
      query,
      projectId: 'tenant_42:after-sales',
      objectId: 'installedAsset',
      fieldId: 'status',
      propertyPatch: {
        options: [{ value: 'done' }],
        stockPreparation: { optionSync: { optionCount: 1 } },
      },
    })

    expect(patched.property).toEqual({
      options: [{ value: 'done' }],
      stockPreparation: {
        ownership: 'human_preserved',
        optionSync: { optionCount: 1 },
      },
    })
    expect(fields[0]?.property).toEqual(patched.property)

    await expect(
      patchObjectFieldProperty({
        query,
        projectId: 'tenant_42:after-sales',
        objectId: 'installedAsset',
        fieldId: 'status',
        propertyPatch: JSON.parse('{"stockPreparation":{"__proto__":{"polluted":true}}}'),
      }),
    ).rejects.toThrow('Unsafe field property patch key')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('FOS-2b-pre: getObjectField reads current field property (incl. options) read-only; null when absent', async () => {
    const { query, fields } = createQuery()

    await ensureObject({
      query,
      projectId: 'tenant_7:fos',
      descriptor: {
        id: 'catalog',
        name: 'Catalog',
        fields: [
          {
            id: 'kind',
            name: 'Kind',
            type: 'select',
            options: ['a', 'b'],
            property: { stockPreparation: { ownership: 'human_preserved' } },
          },
        ],
      },
    })

    const stored = fields.find((field) => field.name === 'Kind')
    expect(stored).toBeTruthy()
    const before = JSON.parse(JSON.stringify(fields))

    const got = await getObjectField({
      query,
      projectId: 'tenant_7:fos',
      objectId: 'catalog',
      fieldId: 'kind',
    })
    // reads the CURRENT stored property, including the select options
    expect(got).not.toBeNull()
    expect(got?.property).toEqual(stored?.property)
    expect((got?.property as { options?: unknown[] }).options?.length).toBe(2)

    // read-only: the stored fields are byte-identical after the read (no UPDATE)
    expect(fields).toEqual(before)

    // missing field → null (read-only: caller decides; does NOT throw, unlike patch)
    const missing = await getObjectField({
      query,
      projectId: 'tenant_7:fos',
      objectId: 'catalog',
      fieldId: 'doesNotExist',
    })
    expect(missing).toBeNull()
  })

  it('ensures one view with deterministic id and normalized config', async () => {
    const { query, views } = createQuery()

    const first = await ensureView({
      query,
      projectId: 'tenant_42:after-sales',
      sheetId: 'sheet_asset',
      descriptor: {
        id: 'installedAsset-grid',
        objectId: 'installedAsset',
        name: 'Installed Assets',
        type: 'grid',
        hiddenFieldIds: ['fld_internal'],
        config: { density: 'compact' },
      },
    })

    const second = await ensureView({
      query,
      projectId: 'tenant_42:after-sales',
      sheetId: 'sheet_asset',
      descriptor: {
        id: 'installedAsset-grid',
        objectId: 'installedAsset',
        name: 'Installed Assets',
        type: 'grid',
        hiddenFieldIds: ['fld_internal'],
        config: { density: 'compact' },
      },
    })

    expect(first.id).toBe(second.id)
    expect(first.sheetId).toBe('sheet_asset')
    expect(first.hiddenFieldIds).toEqual(['fld_internal'])
    expect(first.config).toEqual({ density: 'compact' })
    expect(views).toHaveLength(1)
  })

  it('persists kanban group metadata for default board views', async () => {
    const { query } = createQuery()

    const result = await ensureView({
      query,
      projectId: 'tenant_42:after-sales',
      sheetId: 'sheet_ticket',
      descriptor: {
        id: 'ticket-board',
        objectId: 'serviceTicket',
        name: 'Ticket Board',
        type: 'kanban',
        groupInfo: { fieldId: 'status' },
        config: {
          groupFieldId: 'status',
          cardFieldIds: ['ticketNo', 'title', 'priority'],
        },
      },
    })

    expect(result.type).toBe('kanban')
    expect(result.groupInfo).toEqual({ fieldId: 'status' })
    expect(result.config).toEqual({
      groupFieldId: 'status',
      cardFieldIds: ['ticketNo', 'title', 'priority'],
    })
  })
})

describe('buildObjectFieldsRepairSurface (W2/P2-3 atomic repair surface)', () => {
  it('binds every method to the ONE passed query — no method escapes to another connection', async () => {
    // The atomicity guarantee is that all four repair methods share a single (tx-bound)
    // query. This exercises the SHIPPED surface-builder (index.ts uses the same function),
    // so a future divergence — one method wired to a different connection — is caught here
    // and in the real-DB rollback test, not left to a hand-mirrored copy (review P3).
    const sqls: string[] = []
    const spy: MultitableProvisioningQueryFn = async (sql: string) => {
      sqls.push(sql)
      return { rows: [], rowCount: 0 }
    }
    const surface = buildObjectFieldsRepairSurface(spy)

    await surface.findObjectSheet({ projectId: 'tenant_1:plugin', objectId: 'obj' })
    await surface.resolveExistingObjectFieldIds({ projectId: 'tenant_1:plugin', objectId: 'obj', fieldIds: ['a'] })
    await surface.readObjectFieldsContent({ projectId: 'tenant_1:plugin', objectId: 'obj', fieldIds: ['a'] })
    // Non-empty fields so ensureMissingObjectFields actually emits an INSERT — otherwise the
    // WRITE binding is not pinned hermetically (review NIT: an empty-fields ensure emits zero
    // SQL, so a write-method escape would leave this test green).
    await surface.ensureMissingObjectFields({
      projectId: 'tenant_1:plugin',
      objectId: 'obj',
      fields: [{ id: 'newField', name: 'New Field', type: 'string' }],
    })

    const joined = sqls.join(' ; ').toLowerCase()
    // findObjectSheet routed through the spy (meta_sheets) …
    expect(joined).toMatch(/meta_sheets/)
    // … resolveExistingObjectFieldIds + readObjectFieldsContent (meta_fields SELECT) …
    expect(joined).toMatch(/from meta_fields/)
    // … and ensureMissingObjectFields (meta_fields INSERT) — the WRITE binding, pinned.
    expect(joined).toMatch(/insert into meta_fields/)
    // All four DB-touching methods used the injected query.
    expect(sqls.length).toBeGreaterThanOrEqual(4)
  })
})

describe('runObjectFieldsRepairTransactionWith (W2/P2-3 atomic glue)', () => {
  it('builds the surface from the tx query and propagates a verify throw so the caller rolls back', async () => {
    const sqls: string[] = []
    let committed = false
    let rolledBack = false
    // Fake transaction runner: commits when `run` resolves, "rolls back" (records + rethrows)
    // when `run` throws. This is exactly the contract index.ts fulfils with
    // poolManager.get().transaction — so testing over it tests the shipped glue's shape.
    const withTxQuery = async <R>(run: (q: MultitableProvisioningQueryFn) => Promise<R>): Promise<R> => {
      const spy: MultitableProvisioningQueryFn = async (sql: string) => {
        sqls.push(sql)
        return { rows: [], rowCount: 0 }
      }
      try {
        const r = await run(spy)
        committed = true
        return r
      } catch (e) {
        rolledBack = true
        throw e
      }
    }

    // Happy path: fn receives a surface bound to the tx query; the runner commits.
    const ok = await runObjectFieldsRepairTransactionWith(withTxQuery, async (surface) => {
      await surface.findObjectSheet({ projectId: 'tenant_1:plugin', objectId: 'obj' })
      return 'done'
    })
    expect(ok).toBe('done')
    expect(committed).toBe(true)
    expect(sqls.join(' ')).toMatch(/meta_sheets/) // surface really used the tx query

    // Verify-throw path: fn throws → the throw propagates OUT so the caller's tx rolls back
    // (a runner that swallowed the throw would leave committed=true here).
    committed = false
    await expect(
      runObjectFieldsRepairTransactionWith(withTxQuery, async () => {
        throw new Error('verify failed')
      }),
    ).rejects.toThrow('verify failed')
    expect(rolledBack).toBe(true)
    expect(committed).toBe(false)
  })
})

/**
 * P0-S S3 (Codex round 2) — ensureFields/ensureObject destructive-reconcile default.
 *
 * The ratified direction: an EXISTING object is never silently destructively reconciled.
 * On any name/type/property/order diff the DEFAULT refuses; only an explicit opt-in may
 * overwrite; additive repair goes through ensureMissingObjectFields.
 */
describe('ensureObject destructive-reconcile guard (P0-S S3 fail-closed default)', () => {
  const DESCRIPTOR = {
    id: 'installedAsset',
    name: 'Installed Asset',
    fields: [
      { id: 'assetCode', name: 'Asset Code', type: 'string' as const },
      { id: 'serialNo', name: 'Serial No', type: 'string' as const },
    ],
  }
  const PROJECT = 'tenant_42:after-sales'

  afterEach(() => {
    delete process.env[ENSURE_FIELDS_OVERWRITE_MODE_ENV]
  })

  it('leaves a FRESH install completely unaffected — every field is a create, never a refusal', async () => {
    const { query, fields } = createQuery()

    const result = await ensureObject({ query, projectId: PROJECT, descriptor: DESCRIPTOR })

    expect(result.fields).toHaveLength(2)
    expect(fields.map((field) => field.name)).toEqual(['Asset Code', 'Serial No'])
  })

  it('re-ensuring an UNCHANGED descriptor stays idempotent — no diff, so no refusal', async () => {
    const { query, fields } = createQuery()

    await ensureObject({ query, projectId: PROJECT, descriptor: DESCRIPTOR })
    await expect(
      ensureObject({ query, projectId: PROJECT, descriptor: DESCRIPTOR }),
    ).resolves.toBeDefined()

    expect(fields).toHaveLength(2)
  })

  it('ADDITIVE evolution still works — a brand-new field id is a create, not an overwrite', async () => {
    const { query, fields } = createQuery()

    await ensureObject({ query, projectId: PROJECT, descriptor: DESCRIPTOR })
    await ensureObject({
      query,
      projectId: PROJECT,
      descriptor: {
        ...DESCRIPTOR,
        fields: [...DESCRIPTOR.fields, { id: 'warrantyEnd', name: 'Warranty End', type: 'date' as const }],
      },
    })

    expect(fields).toHaveLength(3)
    expect(fields.map((field) => field.name)).toEqual(['Asset Code', 'Serial No', 'Warranty End'])
  })

  it.each([
    ['name', { id: 'serialNo', name: 'Serial Number', type: 'string' as const }, ['name']],
    ['type', { id: 'serialNo', name: 'Serial No', type: 'number' as const }, ['type']],
  ])(
    'REFUSES by default when an existing field differs in %s, naming the diff kinds',
    async (_label, mutated, expectedKinds) => {
      const { query, fields } = createQuery()
      await ensureObject({ query, projectId: PROJECT, descriptor: DESCRIPTOR })
      const before = fields.map((field) => ({ ...field }))

      const attempt = ensureObject({
        query,
        projectId: PROJECT,
        descriptor: { ...DESCRIPTOR, fields: [DESCRIPTOR.fields[0], mutated] },
      })

      await expect(attempt).rejects.toBeInstanceOf(MultitableEnsureFieldsRefusedError)
      const error = await attempt.catch((err) => err as MultitableEnsureFieldsRefusedError)
      expect(error.code).toBe('MULTITABLE_ENSURE_FIELDS_REFUSED')
      expect(error.diffKinds).toEqual(expectedKinds)
      // values-free: ids + kinds only, never the stored or incoming field name
      expect(error.message).not.toContain('Serial Number')
      // and the tenant's rows are untouched — the refusal happens BEFORE the write
      expect(fields).toEqual(before)
    },
  )

  it('REFUSES on a reorder — positional churn is a real overwrite, not a no-op', async () => {
    const { query } = createQuery()
    await ensureObject({ query, projectId: PROJECT, descriptor: DESCRIPTOR })

    await expect(
      ensureObject({
        query,
        projectId: PROJECT,
        descriptor: { ...DESCRIPTOR, fields: [DESCRIPTOR.fields[1], DESCRIPTOR.fields[0]] },
      }),
    ).rejects.toBeInstanceOf(MultitableEnsureFieldsRefusedError)
  })

  it('the exact literal overwrite env restores the old destructive behavior', async () => {
    const { query, fields } = createQuery()
    await ensureObject({ query, projectId: PROJECT, descriptor: DESCRIPTOR })
    process.env[ENSURE_FIELDS_OVERWRITE_MODE_ENV] = 'overwrite'

    await expect(
      ensureObject({
        query,
        projectId: PROJECT,
        descriptor: {
          ...DESCRIPTOR,
          fields: [DESCRIPTOR.fields[0], { id: 'serialNo', name: 'Serial Number', type: 'string' as const }],
        },
      }),
    ).resolves.toBeDefined()

    expect(fields.map((field) => field.name)).toEqual(['Asset Code', 'Serial Number'])
  })

  it.each(['', 'OVERWRITE', 'overwrit', 'true'])(
    'a near-miss env value %j does NOT re-arm overwrite — still refuses',
    async (value) => {
      const { query } = createQuery()
      await ensureObject({ query, projectId: PROJECT, descriptor: DESCRIPTOR })
      process.env[ENSURE_FIELDS_OVERWRITE_MODE_ENV] = value

      await expect(
        ensureObject({
          query,
          projectId: PROJECT,
          descriptor: {
            ...DESCRIPTOR,
            fields: [DESCRIPTOR.fields[0], { id: 'serialNo', name: 'Serial Number', type: 'string' as const }],
          },
        }),
      ).rejects.toBeInstanceOf(MultitableEnsureFieldsRefusedError)
    },
  )

  it('the per-call opt-in overwrites without disarming the guard process-wide', async () => {
    const { query, fields } = createQuery()
    await ensureObject({ query, projectId: PROJECT, descriptor: DESCRIPTOR })
    const mutatedDescriptor = {
      ...DESCRIPTOR,
      fields: [DESCRIPTOR.fields[0], { id: 'serialNo', name: 'Serial Number', type: 'string' as const }],
    }

    await expect(
      ensureObject({ query, projectId: PROJECT, descriptor: mutatedDescriptor, overwriteMode: 'overwrite' }),
    ).resolves.toBeDefined()
    expect(fields.map((field) => field.name)).toEqual(['Asset Code', 'Serial Number'])

    // the env was never set, so an ordinary caller is still fail-closed
    await expect(
      ensureObject({
        query,
        projectId: PROJECT,
        descriptor: { ...DESCRIPTOR, fields: [DESCRIPTOR.fields[0], { id: 'serialNo', name: 'Serial No v3', type: 'string' as const }] },
      }),
    ).rejects.toBeInstanceOf(MultitableEnsureFieldsRefusedError)
  })

  it('preserve mode keeps the existing row and does not throw', async () => {
    const { query, fields } = createQuery()
    await ensureObject({ query, projectId: PROJECT, descriptor: DESCRIPTOR })
    process.env[ENSURE_FIELDS_OVERWRITE_MODE_ENV] = 'preserve'

    await expect(
      ensureObject({
        query,
        projectId: PROJECT,
        descriptor: {
          ...DESCRIPTOR,
          fields: [DESCRIPTOR.fields[0], { id: 'serialNo', name: 'Serial Number', type: 'string' as const }],
        },
      }),
    ).resolves.toBeDefined()

    expect(fields.map((field) => field.name)).toEqual(['Asset Code', 'Serial No'])
  })

  it('ensureMissingObjectFields remains the additive repair path for an existing object', async () => {
    const { query, fields } = createQuery()
    await ensureObject({ query, projectId: PROJECT, descriptor: DESCRIPTOR })

    const result = await ensureMissingObjectFields({
      query,
      projectId: PROJECT,
      objectId: DESCRIPTOR.id,
      fields: [
        // one already-present field (must be skipped, never mutated) and one genuinely new
        { id: 'serialNo', name: 'Serial Number', type: 'string' as const },
        { id: 'warrantyEnd', name: 'Warranty End', type: 'date' as const },
      ],
    })

    expect(result.addedFieldIds).toHaveLength(1)
    expect(result.skippedExistingFieldIds).toHaveLength(1)
    // the pre-existing row kept its ORIGINAL name despite the differing descriptor
    expect(fields.map((field) => field.name)).toEqual(['Asset Code', 'Serial No', 'Warranty End'])
  })
})
