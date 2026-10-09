/**
 * W2 — SCOPED repair through the REAL provisioning surface (real DB).
 *
 * The earlier W2 realdb test called the ensureMissingObjectFields PRIMITIVE directly,
 * which bypassed the repair's field-discovery chain (review P1b). THIS test drives the
 * plugin repair function `repairStockPreparationCanonicalTarget` end-to-end against a
 * provisioning surface wired to the real DB — so it exercises:
 *   findObjectSheet → resolveExistingObjectFieldIds (DB-backed, the fix) → ensureMissingObjectFields
 * proving a genuinely-missing template column is discovered and re-added, and existing
 * columns are untouched. If discovery reverted to the compute-only resolveFieldIds,
 * repair would find nothing missing and this test would fail.
 */
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { vi } from 'vitest'

import {
  findObjectSheet,
  getObjectSheetId,
  resolveExistingObjectFieldIds,
  readObjectFieldsContent,
  ensureMissingObjectFields,
  ensureObject,
  buildObjectFieldsRepairSurface,
} from '../../src/multitable/provisioning'
import { createPluginScopedMultitableApi } from '../../src/multitable/plugin-scope'
import { MetaSheetServer } from '../../src/index'

// Narrow view of the SHIPPED core API — just the repair runner we drive end-to-end.
type ShippedRepairSurface = {
  findObjectSheet: (i: { projectId: string; objectId: string }) => Promise<unknown>
  resolveExistingObjectFieldIds: (i: { projectId: string; objectId: string; fieldIds: string[] }) => Promise<Record<string, string>>
  readObjectFieldsContent: (i: { projectId: string; objectId: string; fieldIds: string[] }) => Promise<Record<string, unknown>>
  ensureMissingObjectFields: (i: { projectId: string; objectId: string; fields: unknown[] }) => Promise<{ addedFieldIds: string[]; skippedExistingFieldIds: string[] }>
}
type ShippedCoreApiShape = {
  multitable: {
    provisioning: {
      runObjectFieldsRepairTransaction: <T>(fn: (surface: ShippedRepairSurface) => Promise<T>) => Promise<T>
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const targetProvisioning = require(
  path.join(__dirname, '..', '..', '..', '..', 'plugins', 'plugin-integration-core', 'lib', 'stock-preparation-target-provisioning.cjs'),
)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const templates = require(
  path.join(__dirname, '..', '..', '..', '..', 'plugins', 'plugin-integration-core', 'lib', 'stock-preparation-templates.cjs'),
)

const dbUrl = process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

const MAIN_OBJECT_ID = templates.STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId
const PLM_FIELD = templates.STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.find(
  (f: { ownership: string }) => f.ownership === 'plm_system',
).id

describeDb('W2 scoped canonical repair (real provisioning surface, real DB)', () => {
  // projectId must carry the plugin namespace suffix so the scope wrapper allows it.
  const PLUGIN = 'plugin-w2test'
  const projectId = `w2scoped_${randomUUID().replace(/-/g, '').slice(0, 10)}:${PLUGIN}`
  const assertObjectScope = vi.fn(async () => {})
  let pool: Pool
  let context: unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rawProvisioning: any

  const withClient = async <T>(fn: (q: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>) => Promise<T>): Promise<T> => {
    const client = await pool.connect()
    try {
      return await fn((sql, params) => client.query(sql, params as unknown[]))
    } finally {
      client.release()
    }
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    // A provisioning surface wired to the real DB (mirrors the index.ts surface shape
    // the plugin actually receives), exposing the three methods repair uses.
    rawProvisioning = {
      getObjectSheetId,
      findObjectSheet: ({ projectId: p, objectId }: { projectId: string; objectId: string }) =>
        withClient((q) => findObjectSheet(q as never, p, objectId)),
      resolveExistingObjectFieldIds: ({ projectId: p, objectId, fieldIds }: { projectId: string; objectId: string; fieldIds: string[] }) =>
        withClient((q) => resolveExistingObjectFieldIds({ query: q as never, projectId: p, objectId, fieldIds })),
      readObjectFieldsContent: ({ projectId: p, objectId, fieldIds }: { projectId: string; objectId: string; fieldIds: string[] }) =>
        withClient((q) => readObjectFieldsContent({ query: q as never, projectId: p, objectId, fieldIds })),
      ensureMissingObjectFields: ({ projectId: p, objectId, fields }: { projectId: string; objectId: string; fields: unknown[] }) =>
        withClient(async (q) => {
          await q('BEGIN')
          const r = await ensureMissingObjectFields({ query: q as never, projectId: p, objectId, fields: fields as never })
          await q('COMMIT')
          return r
        }),
      // W2/P2-3: the ATOMIC repair runner — mirrors index.ts by using the SAME shipped
      // surface-builder (buildObjectFieldsRepairSurface), so this real-DB rollback test
      // exercises the production surface-binding, not a hand-mirrored copy (review P3:
      // runner-vs-prod gap). ONE client, ONE transaction; a thrown verify ROLLS BACK.
      runObjectFieldsRepairTransaction: async (fn: (surface: unknown) => Promise<unknown>) => {
        const client = await pool.connect()
        const q = (sql: string, params?: unknown[]) => client.query(sql, params as unknown[])
        try {
          await q('BEGIN')
          const r = await fn(buildObjectFieldsRepairSurface(q as never))
          await q('COMMIT')
          return r
        } catch (e) {
          await q('ROLLBACK').catch(() => {})
          throw e
        } finally {
          client.release()
        }
      },
    }
    // Route repair through the REAL scope wrapper (not a hand-built facade): repair
    // must reach the DB-backed methods THROUGH createPluginScopedMultitableApi, and
    // the write must pass hooks.assertObjectScope (review P2).
    const scoped = createPluginScopedMultitableApi(
      { provisioning: rawProvisioning, records: {} } as never,
      PLUGIN,
      { assertObjectScope },
    )
    context = { api: { multitable: scoped } }

    // Provision the canonical main table (all template fields) via the real ensureObject.
    const descriptor = targetProvisioning.buildStockPreparationTargetDescriptor({})
    await withClient(async (q) => {
      await q('BEGIN')
      await ensureObject({ query: q as never, projectId, baseId: null, descriptor })
      await q('COMMIT')
    })
  })

  afterAll(async () => {
    const sheetId = getObjectSheetId(projectId, MAIN_OBJECT_ID)
    await pool.query(`DELETE FROM meta_fields WHERE sheet_id = $1`, [sheetId]).catch(() => {})
    await pool.query(`DELETE FROM meta_sheets WHERE id = $1`, [sheetId]).catch(() => {})
    await pool.end()
  })

  it('discovers a genuinely-missing template column via the DB and re-adds it (existing untouched)', async () => {
    // Resolve the plm_system field's physical id, then DELETE it to simulate a table
    // that predates that template column (the "template evolved" state).
    const before = await withClient((q) =>
      resolveExistingObjectFieldIds({ query: q as never, projectId, objectId: MAIN_OBJECT_ID, fieldIds: [PLM_FIELD] }),
    )
    const physicalId = before[PLM_FIELD]
    expect(physicalId).toBeTruthy()
    await pool.query(`DELETE FROM meta_fields WHERE id = $1`, [physicalId])

    // The field is now genuinely missing (real DB), so the compute-only resolver would
    // WRONGLY still report it present — the DB-backed one must report it gone.
    const afterDelete = await withClient((q) =>
      resolveExistingObjectFieldIds({ query: q as never, projectId, objectId: MAIN_OBJECT_ID, fieldIds: [PLM_FIELD] }),
    )
    expect(afterDelete[PLM_FIELD]).toBeUndefined()

    // Repair through the plugin function → it must discover + re-add the missing column.
    assertObjectScope.mockClear()
    const result = await targetProvisioning.repairStockPreparationCanonicalTarget({ context, projectId, permission: 'admin' })
    expect(result.mode).toBe('canonical_repaired')
    expect(result.evidence.addedFieldCount).toBe(1)
    expect(result.evidence.schemaCompleteAfter).toBe(true)
    // The scoped write passed through the object-scope hook (proves it went through
    // the real scope wrapper, not a bare facade).
    expect(assertObjectScope).toHaveBeenCalledWith(
      expect.objectContaining({ pluginName: PLUGIN, objectId: MAIN_OBJECT_ID }),
    )

    // The column is back.
    const afterRepair = await withClient((q) =>
      resolveExistingObjectFieldIds({ query: q as never, projectId, objectId: MAIN_OBJECT_ID, fieldIds: [PLM_FIELD] }),
    )
    expect(afterRepair[PLM_FIELD]).toBeTruthy()

    // A second repair is a clean no-op (nothing missing now).
    const again = await targetProvisioning.repairStockPreparationCanonicalTarget({ context, projectId, permission: 'admin' })
    expect(again.mode).toBe('canonical_already_ready')
    expect(again.evidence.addedFieldCount).toBe(0)
  })

  it('atomically ROLLS BACK the additive write when the mutation guard trips (P2-3)', async () => {
    // Delete the plm field so repair has exactly one column to add.
    const before = await withClient((q) =>
      resolveExistingObjectFieldIds({ query: q as never, projectId, objectId: MAIN_OBJECT_ID, fieldIds: [PLM_FIELD] }),
    )
    const physicalId = before[PLM_FIELD]
    expect(physicalId).toBeTruthy()
    await pool.query(`DELETE FROM meta_fields WHERE id = $1`, [physicalId])

    // A repair runner identical to the real one EXCEPT the AFTER-read returns a MUTATED
    // existing-field snapshot — as if the write primitive had also touched a pre-existing
    // column. assertNoExistingFieldMutated throws INSIDE the transaction, so the additive
    // INSERT this same transaction performed must ROLL BACK (atomic fail-close, not a
    // post-commit detection canary).
    let readCount = 0
    const mutatingProvisioning = {
      ...rawProvisioning,
      runObjectFieldsRepairTransaction: async (fn: (surface: unknown) => Promise<unknown>) => {
        const client = await pool.connect()
        const q = (sql: string, params?: unknown[]) => client.query(sql, params as unknown[])
        try {
          await q('BEGIN')
          // Real shipped surface, with ONLY the after-read wrapped to inject the mutation.
          const base = buildObjectFieldsRepairSurface(q as never)
          const surface = {
            ...base,
            readObjectFieldsContent: async (i: { projectId: string; objectId: string; fieldIds: string[] }) => {
              readCount += 1
              const real = await base.readObjectFieldsContent(i)
              if (readCount >= 2) {
                for (const k of Object.keys(real)) real[k] = { ...real[k], name: `${real[k].name}_MUTATED` }
              }
              return real
            },
          }
          const r = await fn(surface)
          await q('COMMIT')
          return r
        } catch (e) {
          await q('ROLLBACK').catch(() => {})
          throw e
        } finally {
          client.release()
        }
      },
    }
    const mutatingContext = {
      api: {
        multitable: createPluginScopedMultitableApi(
          { provisioning: mutatingProvisioning, records: {} } as never,
          PLUGIN,
          { assertObjectScope },
        ),
      },
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let mutErr: any = null
    try {
      await targetProvisioning.repairStockPreparationCanonicalTarget({ context: mutatingContext, projectId, permission: 'admin' })
    } catch (e) {
      mutErr = e
    }
    expect(mutErr?.code).toBe('REPAIR_MUTATED_EXISTING_FIELD')

    // ATOMIC PROOF: the additive INSERT was rolled back with the failed transaction, so the
    // plm field is STILL missing. A non-atomic (separate-transaction) design would have
    // left it committed — the write and the throwing verify were in the same transaction.
    const afterRollback = await withClient((q) =>
      resolveExistingObjectFieldIds({ query: q as never, projectId, objectId: MAIN_OBJECT_ID, fieldIds: [PLM_FIELD] }),
    )
    expect(afterRollback[PLM_FIELD]).toBeUndefined()

    // Restore a clean end state for any later test (real repair, real commit).
    await targetProvisioning.repairStockPreparationCanonicalTarget({ context, projectId, permission: 'admin' })
  })

  it('REAL production wiring: index.ts createCoreAPI() runObjectFieldsRepairTransaction is transactional (SHIPPED runner)', async () => {
    // Drive the ACTUAL shipped runner from MetaSheetServer.createCoreAPI() — not the in-test
    // runner and not the extracted helper. This closes the runner-vs-prod gap (review P2):
    // disabling index.ts's runObjectFieldsRepairTransaction (e.g. `throw`) REDs THIS test,
    // whereas the other suites (in-test runner / direct helper call) stay green. Follows the
    // G18 precedent (multitable-d2-sidedoor-delete-recoverability-realdb.test.ts).
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    const coreApi = (server as unknown as { createCoreAPI: () => ShippedCoreApiShape }).createCoreAPI()
    const shippedRunner = coreApi.multitable.provisioning.runObjectFieldsRepairTransaction
    expect(typeof shippedRunner).toBe('function')

    // Make the plm field genuinely missing so the runner has something to add.
    const before = await withClient((q) =>
      resolveExistingObjectFieldIds({ query: q as never, projectId, objectId: MAIN_OBJECT_ID, fieldIds: [PLM_FIELD] }),
    )
    const physicalId = before[PLM_FIELD]
    expect(physicalId).toBeTruthy()
    await pool.query(`DELETE FROM meta_fields WHERE id = $1`, [physicalId])

    const missingDescriptor = targetProvisioning
      .buildStockPreparationTargetDescriptor({})
      .fields.find((f: { id: string }) => f.id === PLM_FIELD)
    expect(missingDescriptor).toBeTruthy()

    // (1) add-then-throw INSIDE the shipped runner → the additive INSERT must ROLL BACK
    //     (proves the shipped runner opens a real transaction and propagates the throw).
    let threw: unknown = null
    try {
      await shippedRunner(async (surface) => {
        await surface.ensureMissingObjectFields({ projectId, objectId: MAIN_OBJECT_ID, fields: [missingDescriptor] })
        throw new Error('force-rollback')
      })
    } catch (e) {
      threw = e
    }
    expect((threw as Error | null)?.message).toBe('force-rollback')
    const afterRollback = await withClient((q) =>
      resolveExistingObjectFieldIds({ query: q as never, projectId, objectId: MAIN_OBJECT_ID, fieldIds: [PLM_FIELD] }),
    )
    expect(afterRollback[PLM_FIELD]).toBeUndefined()

    // (2) a non-throwing fn COMMITS through the shipped runner (also reds an always-throw
    //     mutant of the shipped runner, since this await would reject).
    await shippedRunner(async (surface) =>
      surface.ensureMissingObjectFields({ projectId, objectId: MAIN_OBJECT_ID, fields: [missingDescriptor] }),
    )
    const afterCommit = await withClient((q) =>
      resolveExistingObjectFieldIds({ query: q as never, projectId, objectId: MAIN_OBJECT_ID, fieldIds: [PLM_FIELD] }),
    )
    expect(afterCommit[PLM_FIELD]).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------------------------
// 一个项目一张备料表 — S1 G1 against the REAL registry, the REAL grant service and the REAL wrapper
// (ADR adr-stock-prep-project-sheets-20261008 §10 S1 「真库」; register R-35).
//
//   * two projects → two sheets, both provisioned through the real `ensureObject` with the plugin's
//     own per-project template and both CLAIMED in plugin_multitable_object_registry;
//   * G1 writes ONLY role subjects, with the literal spreadsheet:write, and the operator-facing read
//     (`listSheetPermissionEntries`, what the 权限 panel lists) shows them at level `write` — the
//     read a floor role's landing resolves against;
//   * a repeat adds no row and no history row (ON CONFLICT DO NOTHING end to end);
//   * a role outside the `stock-prep` namespace, a role that does not exist, a sheet another plugin
//     claimed and a sheet nobody claimed are all refused with ZERO rows written.
// Role ids and project ids are synthetic and random per run; everything is cleaned up afterwards.
// ---------------------------------------------------------------------------------------------
import { assertPluginOwnsSheet, claimPluginObjectScope, isSheetOwnedByProject, MultitableSheetScopeError } from '../../src/multitable/plugin-scope'
import { listSheetPermissionEntries } from '../../src/multitable/permission-service'
import { grantStockPreparationProjectSheetRoleWrite } from '../../src/services/stock-preparation-project-sheet-grants'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const projectTargets = require(
  path.join(__dirname, '..', '..', '..', '..', 'plugins', 'plugin-integration-core', 'lib', 'stock-preparation-project-targets.cjs'),
)
// E4: the REAL registry store over the plugin's own db helper, against real PostgreSQL.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const projectTargetStore = require(
  path.join(__dirname, '..', '..', '..', '..', 'plugins', 'plugin-integration-core', 'lib', 'stock-preparation-project-target-store.cjs'),
)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pluginDb = require(
  path.join(__dirname, '..', '..', '..', '..', 'plugins', 'plugin-integration-core', 'lib', 'db.cjs'),
)

describeDb('S1 G1 project-sheet role grant (real registry + real grant service + real wrapper, real DB)', () => {
  const PLUGIN = 'plugin-integration-core'
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10)
  const tenantId = `s1g1_${suffix}`
  const projectId = `${tenantId}:integration-core`
  const PROJECT_A = `S1G1-A-${suffix}`
  const PROJECT_B = `S1G1-B-${suffix}`
  const ROLE_A = `stock-prep_s1test_${suffix}_a`
  const ROLE_B = `stock-prep_s1test_${suffix}_b`
  const ROLE_FOREIGN = `s1test_foreign_${suffix}`
  let pool: Pool
  let sheetA = ''
  let sheetB = ''
  let objectA = ''
  let objectB = ''
  let unclaimedSheet = ''
  let unclaimedObject = ''
  let otherPluginSheet = ''
  let otherPluginObject = ''

  const q = async (sql: string, params?: unknown[]) => {
    const r = await pool.query(sql, params as unknown[])
    return { rows: r.rows as unknown[], rowCount: r.rowCount }
  }

  const provisionProject = async (projectNo: string, { claimAs }: { claimAs: string | null }) => {
    const template = projectTargets.projectSheetTemplate({ tenantId, projectNo })
    const descriptor = targetProvisioning.buildStockPreparationTargetDescriptor({ template })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const cq = (sql: string, params?: unknown[]) => client.query(sql, params as unknown[])
      const ensured = await ensureObject({ query: cq as never, projectId, baseId: null, descriptor })
      if (claimAs) {
        await claimPluginObjectScope(cq as never, { pluginName: claimAs, projectId, objectId: descriptor.id, sheetId: ensured.sheet.id })
      }
      await client.query('COMMIT')
      return { sheetId: ensured.sheet.id, objectId: descriptor.id as string }
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
  }

  const scopedApi = () => createPluginScopedMultitableApi(
    {
      provisioning: {
        getObjectSheetId,
        isSheetOwnedByProject: (sheetId: string, pid: string) => isSheetOwnedByProject(q as never, sheetId, pid),
        grantSheetRoleWrite: async ({ sheetId, roleIds, actorId }: { sheetId: string; roleIds: string[]; actorId?: string | null }) => {
          const client = await pool.connect()
          try {
            await client.query('BEGIN')
            const cq = async (sql: string, params?: unknown[]) => {
              const r = await client.query(sql, params as unknown[])
              return { rows: r.rows as unknown[], rowCount: r.rowCount }
            }
            const result = await grantStockPreparationProjectSheetRoleWrite(cq, { sheetId, roleIds, actorId })
            await client.query('COMMIT')
            return result
          } catch (e) {
            await client.query('ROLLBACK').catch(() => {})
            throw e
          } finally {
            client.release()
          }
        },
      },
      records: {},
    } as never,
    PLUGIN,
    {
      // The host's STRICT hook (index.ts): assertPluginOwnsSheet, and an unregistered sheet refuses.
      assertSheetOwnedByPlugin: async ({ pluginName, sheetId }) => {
        const owns = await assertPluginOwnsSheet(q as never, { pluginName, sheetId })
        if (!owns) throw new MultitableSheetScopeError(pluginName, sheetId, 'unregistered')
      },
      isSheetOwnedByProject: ({ sheetId, projectId: pid }) => isSheetOwnedByProject(q as never, sheetId, pid),
    },
  )

  const permissionRows = async (sheetId: string) => {
    const r = await pool.query(
      'SELECT subject_type, subject_id, perm_code, user_id FROM spreadsheet_permissions WHERE sheet_id = $1 ORDER BY subject_id, perm_code',
      [sheetId],
    )
    return r.rows as Array<{ subject_type: string; subject_id: string; perm_code: string; user_id: string | null }>
  }
  const revisionCount = async (sheetId: string) => {
    const r = await pool.query("SELECT COUNT(*)::int AS n FROM meta_config_revisions WHERE sheet_id = $1 AND entity_type = 'permission'", [sheetId])
    return Number((r.rows[0] as { n: number }).n)
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    for (const [id, name] of [[ROLE_A, 'S1 test role A'], [ROLE_B, 'S1 test role B'], [ROLE_FOREIGN, 'S1 test foreign role']]) {
      await pool.query('INSERT INTO roles (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [id, name])
    }
    ;({ sheetId: sheetA, objectId: objectA } = await provisionProject(PROJECT_A, { claimAs: PLUGIN }))
    ;({ sheetId: sheetB, objectId: objectB } = await provisionProject(PROJECT_B, { claimAs: PLUGIN }))
    ;({ sheetId: unclaimedSheet, objectId: unclaimedObject } = await provisionProject(`S1G1-U-${suffix}`, { claimAs: null }))
    ;({ sheetId: otherPluginSheet, objectId: otherPluginObject } = await provisionProject(`S1G1-O-${suffix}`, { claimAs: 'plugin-other-s1test' }))
  })

  afterAll(async () => {
    const sheets = [sheetA, sheetB, unclaimedSheet, otherPluginSheet].filter(Boolean)
    if (sheets.length) {
      await pool.query('DELETE FROM spreadsheet_permissions WHERE sheet_id = ANY($1::text[])', [sheets]).catch(() => {})
      await pool.query('DELETE FROM meta_config_revisions WHERE sheet_id = ANY($1::text[])', [sheets]).catch(() => {})
      await pool.query('DELETE FROM plugin_multitable_object_registry WHERE sheet_id = ANY($1::text[])', [sheets]).catch(() => {})
      await pool.query('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [sheets]).catch(() => {})
      await pool.query('DELETE FROM meta_views WHERE sheet_id = ANY($1::text[])', [sheets]).catch(() => {})
      await pool.query('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [sheets]).catch(() => {})
    }
    await pool.query('DELETE FROM roles WHERE id = ANY($1::text[])', [[ROLE_A, ROLE_B, ROLE_FOREIGN]]).catch(() => {})
    await pool.query('DELETE FROM integration_stock_prep_project_target WHERE tenant_id = $1', [tenantId]).catch(() => {})
    await pool.end()
  })

  it('two projects produce two distinct project sheets, both claimed by the plugin for this project', async () => {
    expect(objectA).toMatch(projectTargets.STOCK_PREPARATION_PROJECT_SHEET_OBJECT_ID_PATTERN)
    expect(objectB).toMatch(projectTargets.STOCK_PREPARATION_PROJECT_SHEET_OBJECT_ID_PATTERN)
    expect(objectA).not.toBe(objectB)
    expect(sheetA).not.toBe(sheetB)
    expect(sheetA).toBe(getObjectSheetId(projectId, objectA))
    expect(sheetB).toBe(getObjectSheetId(projectId, objectB))
    await expect(isSheetOwnedByProject(q as never, sheetA, projectId)).resolves.toBe(true)
    await expect(isSheetOwnedByProject(q as never, sheetB, projectId)).resolves.toBe(true)
    await expect(assertPluginOwnsSheet(q as never, { pluginName: PLUGIN, sheetId: sheetA })).resolves.toBe(true)
    // Neither sheet carries any grant yet — a floor role could not open either.
    expect(await permissionRows(sheetA)).toEqual([])
    expect(await permissionRows(sheetB)).toEqual([])
  })

  it('G1 writes role-only spreadsheet:write rows, visible to the permissions read at level write, with a history row each', async () => {
    const api = scopedApi()
    const result = await api.provisioning.grantSheetRoleWrite!({ projectId, sheetId: sheetA, objectId: objectA, roleIds: [ROLE_A, ROLE_B], actorId: 'u_s1_pull' })
    expect(result).toEqual({ sheetId: sheetA, granted: [ROLE_A, ROLE_B], alreadyGranted: [] })
    expect(await permissionRows(sheetA)).toEqual([
      { subject_type: 'role', subject_id: ROLE_A, perm_code: 'spreadsheet:write', user_id: null },
      { subject_type: 'role', subject_id: ROLE_B, perm_code: 'spreadsheet:write', user_id: null },
    ])
    const entries = await listSheetPermissionEntries(q as never, sheetA)
    expect(entries.filter((e) => e.subjectType === 'role').map((e) => [e.subjectId, e.accessLevel]).sort()).toEqual([[ROLE_A, 'write'], [ROLE_B, 'write']])
    expect(await revisionCount(sheetA)).toBe(2)
    // Sheet B is untouched by sheet A's grant.
    expect(await permissionRows(sheetB)).toEqual([])
  })

  it('a repeat call adds no row and no history row (ON CONFLICT DO NOTHING end to end)', async () => {
    const api = scopedApi()
    const result = await api.provisioning.grantSheetRoleWrite!({ projectId, sheetId: sheetA, objectId: objectA, roleIds: [ROLE_A, ROLE_B], actorId: 'u_s1_pull' })
    expect(result).toEqual({ sheetId: sheetA, granted: [], alreadyGranted: [ROLE_A, ROLE_B] })
    expect((await permissionRows(sheetA)).length).toBe(2)
    expect(await revisionCount(sheetA)).toBe(2)
  })

  it('a role outside the stock-prep namespace is refused with zero rows written', async () => {
    const api = scopedApi()
    await expect(api.provisioning.grantSheetRoleWrite!({ projectId, sheetId: sheetB, objectId: objectB, roleIds: [ROLE_A, ROLE_FOREIGN] })).rejects.toMatchObject({ code: 'STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_OUTSIDE_NAMESPACE' })
    expect(await permissionRows(sheetB)).toEqual([])
    expect(await revisionCount(sheetB)).toBe(0)
  })

  it('a role that does not exist refuses the whole call with zero rows written', async () => {
    const api = scopedApi()
    await expect(api.provisioning.grantSheetRoleWrite!({ projectId, sheetId: sheetB, objectId: objectB, roleIds: [ROLE_A, `stock-prep_missing_${suffix}`] })).rejects.toMatchObject({ code: 'STOCK_PREP_PROJECT_SHEET_GRANT_ROLE_NOT_FOUND', status: 404 })
    expect(await permissionRows(sheetB)).toEqual([])
  })

  it('a sheet another plugin claimed, and a sheet nobody claimed, are refused before any write', async () => {
    const api = scopedApi()
    await expect(api.provisioning.grantSheetRoleWrite!({ projectId, sheetId: otherPluginSheet, objectId: otherPluginObject, roleIds: [ROLE_A] })).rejects.toBeInstanceOf(MultitableSheetScopeError)
    await expect(api.provisioning.grantSheetRoleWrite!({ projectId, sheetId: unclaimedSheet, objectId: unclaimedObject, roleIds: [ROLE_A] })).rejects.toBeInstanceOf(MultitableSheetScopeError)
    expect(await permissionRows(otherPluginSheet)).toEqual([])
    expect(await permissionRows(unclaimedSheet)).toEqual([])
    // ...and the canonical main table is refused on SHAPE, before the registry is even asked.
    await expect(api.provisioning.grantSheetRoleWrite!({ projectId, sheetId: getObjectSheetId(projectId, MAIN_OBJECT_ID), objectId: MAIN_OBJECT_ID, roleIds: [ROLE_A] })).rejects.toMatchObject({ code: 'STOCK_PREP_PROJECT_SHEET_GRANT_OBJECT_NOT_PROJECT_SHEET' })
  })

  // E4 (S1 fix round 1): THE REGISTRY CREATE RACE against real PostgreSQL. Two concurrent creates
  // for one (tenant_id, project_no) through the REAL store over the plugin's REAL db helper: exactly
  // one row lands and the loser is the typed 409 — which pins that node-postgres surfaces the unique
  // index NAME in `error.constraint` (the store routes on it) and that migration 087's scope index is
  // the one that fires (the two creates name DIFFERENT sheet ids, so the sheet index stays quiet).
  // The E1 lock rides the same path: both creates take the tenant's advisory lock, so they also
  // serialize the cap check, and a cap of 1 refuses the next project's create with zero rows added.
  it('E4 registry create race (real DB): two concurrent creates for one (tenant, project) → one row, the loser 409 EXISTS off the unique index name', async () => {
    type Q = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>
    const database = {
      query: (async (sql, params) => {
        const r = await pool.query(sql, params as unknown[])
        return { rows: r.rows as unknown[], rowCount: r.rowCount }
      }) as Q,
      transaction: async <T>(fn: (trx: { query: Q; commit: () => Promise<void>; rollback: () => Promise<void> }) => Promise<T>): Promise<T> => {
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          const out = await fn({
            query: async (sql, params) => {
              const r = await client.query(sql, params as unknown[])
              return { rows: r.rows as unknown[], rowCount: r.rowCount }
            },
            commit: async () => { await client.query('COMMIT') },
            rollback: async () => { await client.query('ROLLBACK') },
          })
          await client.query('COMMIT')
          return out
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {})
          throw e
        } finally {
          client.release()
        }
      },
    }
    const store = projectTargetStore.createStockPreparationProjectTargetStore({ db: pluginDb.createDb({ database }) })
    const projectNo = `S1RACE-${suffix}`
    const sheet = (n: number) => `sheet_s1race_${suffix}_${n}`
    const results = await Promise.allSettled([1, 2].map((n) =>
      store.create({ tenantId, projectNo, sheetId: sheet(n), objectId: objectA, createdBy: 'race', maxPerTenant: 200 }) as Promise<{ sheetId: string }>,
    ))
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<{ sheetId: string }> => r.status === 'fulfilled')
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(fulfilled, JSON.stringify(results.map((r) => r.status))).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toMatchObject({ status: 409, code: 'STOCK_PREPARATION_PROJECT_TARGET_EXISTS' })
    const rows = await pool.query('SELECT sheet_id FROM integration_stock_prep_project_target WHERE tenant_id = $1 AND project_no = $2', [tenantId, projectNo])
    expect(rows.rowCount).toBe(1)
    expect((rows.rows[0] as { sheet_id: string }).sheet_id).toBe(fulfilled[0].value.sheetId)
    // The cap, under the same lock: this tenant now holds one row, so a cap of 1 refuses the next
    // project's create and adds nothing.
    await expect(store.create({ tenantId, projectNo: `${projectNo}-B`, sheetId: sheet(3), objectId: objectB, maxPerTenant: 1 }))
      .rejects.toMatchObject({ status: 409, code: 'STOCK_PREPARATION_PROJECT_TARGET_LIMIT' })
    const after = await pool.query('SELECT COUNT(*)::int AS n FROM integration_stock_prep_project_target WHERE tenant_id = $1', [tenantId])
    expect(Number((after.rows[0] as { n: number }).n)).toBe(1)
  })
})
