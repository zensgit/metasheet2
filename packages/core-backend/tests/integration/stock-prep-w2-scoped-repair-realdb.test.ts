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
  resolveObjectFieldIds,
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
import { listSheetPermissionEntries, resolveSheetCapabilitiesForAccess } from '../../src/multitable/permission-service'
import { grantStockPreparationProjectSheetRoleWrite } from '../../src/services/stock-preparation-project-sheet-grants'
// S3 fix round 1 (R1): the overview's G1 READ port, against real PostgreSQL.
import { grantStockPreparationOverviewRoleRead } from '../../src/services/stock-preparation-overview-grants'
// S3 (ADR §5 「只读（Q5）」): the host half of the project overview — the stamp, the clamp, the delete guard and
// the plugin records path, all against real PostgreSQL.
import { assertPluginOwnsObject, type MultitableScopeHooks } from '../../src/multitable/plugin-scope'
import { createRecord as createMultitableRecord, getRecord as getMultitableRecord } from '../../src/multitable/records'
import { isSystemManagedSheet } from '../../src/multitable/sheet-delete-guard'
import {
  STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID,
  STOCK_PREPARATION_PROJECT_OVERVIEW_SYSTEM_KIND,
  StockPreparationOverviewSystemKindError,
  SheetSystemKindConflictError,
  // S3 fix round 2 (F3): the stamp lookup index.ts wires as the wrapper's hook, and the generic-write refusal.
  StockPreparationOverviewRecordsWriteError,
  // S3 follow-up E: the plugin-scope refusal of a structural write to the overview.
  StockPreparationOverviewStructureWriteError,
  loadStockPreparationOverviewSheetIds,
} from '../../src/multitable/stock-preparation-overview-contract'

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
  // S3: the overview sheet, its ordinary-sheet control twin, and the synthetic role / floor user the case
  // grants. Cleaned up in afterAll with the rest.
  let overviewSheet = ''
  let overviewTwinSheet = ''
  const ROLE_S3 = `stock-prep_s3test_${suffix}`
  const S3_FLOOR_USER = `s3floor_${suffix}`

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
    const sheets = [sheetA, sheetB, unclaimedSheet, otherPluginSheet, overviewSheet, overviewTwinSheet].filter(Boolean)
    if (sheets.length) {
      // S3: the plugin-path record the overview case writes (and its revision rows) go first.
      await pool.query('DELETE FROM meta_record_revisions WHERE sheet_id = ANY($1::text[])', [sheets]).catch(() => {})
      await pool.query('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [sheets]).catch(() => {})
      await pool.query('DELETE FROM spreadsheet_permissions WHERE sheet_id = ANY($1::text[])', [sheets]).catch(() => {})
      await pool.query('DELETE FROM meta_config_revisions WHERE sheet_id = ANY($1::text[])', [sheets]).catch(() => {})
      await pool.query('DELETE FROM plugin_multitable_object_registry WHERE sheet_id = ANY($1::text[])', [sheets]).catch(() => {})
      await pool.query('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [sheets]).catch(() => {})
      await pool.query('DELETE FROM meta_views WHERE sheet_id = ANY($1::text[])', [sheets]).catch(() => {})
      await pool.query('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [sheets]).catch(() => {})
    }
    await pool.query('DELETE FROM user_roles WHERE user_id = $1', [S3_FLOOR_USER]).catch(() => {})
    await pool.query('DELETE FROM user_roles WHERE user_id = $1', [`${S3_FLOOR_USER}_read`]).catch(() => {})
    await pool.query('DELETE FROM roles WHERE id = ANY($1::text[])', [[ROLE_A, ROLE_B, ROLE_FOREIGN, ROLE_S3, `${ROLE_S3}_read`]]).catch(() => {})
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

  // E5 (S3 host half, next to E4): THE ARCHIVE RACE against real PostgreSQL. Two concurrent archives of ONE
  // fresh registry row through the REAL store over the plugin's REAL db helper: the tenant advisory lock +
  // FOR UPDATE + compare-and-set (`status: 'active'` repeated in the update's where) let exactly one win; the
  // loser re-reads the row as archived and answers the typed 409 ALREADY_ARCHIVED. `archived_at` /
  // `archived_by` are the WINNER's — the loser wrote nothing, so the stamp is set once.
  it('E5 concurrent archive (real DB): two concurrent archives of one row → one archived, the other 409 STOCK_PREPARATION_PROJECT_ALREADY_ARCHIVED, archived_at set once', async () => {
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
    const projectNo = `S1E5-${suffix}`
    const created = await store.create({ tenantId, projectNo, sheetId: `sheet_s1e5_${suffix}`, objectId: objectB, createdBy: 'u_e5_pull', maxPerTenant: 200 }) as { status: string; archivedAt: string | null }
    expect(created.status).toBe('active')
    expect(created.archivedAt).toBeNull()

    const actors = ['u_e5_archiver_a', 'u_e5_archiver_b']
    const results = await Promise.allSettled(actors.map((actorId) =>
      store.archive({ tenantId, projectNo, actorId }) as Promise<{ status: string; archivedAt: string | null }>,
    ))
    const winners = results
      .map((r, i) => ({ r, actorId: actors[i]! }))
      .filter((x): x is { r: PromiseFulfilledResult<{ status: string; archivedAt: string | null }>; actorId: string } => x.r.status === 'fulfilled')
    const losers = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(winners, JSON.stringify(results.map((r) => r.status))).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(losers[0]!.reason).toMatchObject({ status: 409, code: 'STOCK_PREPARATION_PROJECT_ALREADY_ARCHIVED' })
    expect(winners[0]!.r.value.status).toBe('archived')

    const rows = await pool.query(
      'SELECT status, archived_at, archived_by FROM integration_stock_prep_project_target WHERE tenant_id = $1 AND project_no = $2',
      [tenantId, projectNo],
    )
    expect(rows.rowCount).toBe(1)
    const row = rows.rows[0] as { status: string; archived_at: Date | null; archived_by: string | null }
    expect(row.status).toBe('archived')
    // Set ONCE: the stored stamp is the winner's, to the millisecond, and the archiver is the winner.
    expect(row.archived_at).not.toBeNull()
    expect(new Date(row.archived_at as Date).toISOString()).toBe(winners[0]!.r.value.archivedAt)
    expect(row.archived_by).toBe(winners[0]!.actorId)
    // And a third archive after the race is the same typed refusal, still writing nothing.
    await expect(store.archive({ tenantId, projectNo, actorId: 'u_e5_late' })).rejects.toMatchObject({ status: 409, code: 'STOCK_PREPARATION_PROJECT_ALREADY_ARCHIVED' })
    const after = await pool.query('SELECT archived_at, archived_by FROM integration_stock_prep_project_target WHERE tenant_id = $1 AND project_no = $2', [tenantId, projectNo])
    expect(new Date((after.rows[0] as { archived_at: Date }).archived_at).toISOString()).toBe(winners[0]!.r.value.archivedAt)
    expect((after.rows[0] as { archived_by: string }).archived_by).toBe(winners[0]!.actorId)
  })

  // S4 (ADR §6 / §10 S4 「真库」, register R-38): ARCHIVE AND RESTORE against real PostgreSQL, through the
  // REAL store over the plugin's REAL db helper (advisory lock, FOR UPDATE, compare-and-set update):
  //   * archive flips ONLY the registry row — migration 087's CHECK accepts the write — and the sheet
  //     is untouched at the HOST level: `meta_sheets.deleted_at` stays NULL, the G1 role grant rows and
  //     their history are byte-identical, and a user holding the granted role resolves the SAME
  //     capabilities on the sheet's grid (read + record write) before and after;
  //   * while archived the overlay refuses a WRITE lookup 409 ARCHIVED and still resolves a READ one;
  //   * restore puts the row back (archived_at cleared in the same statement — 087's CHECK again) and
  //     the write lookup — the one every pull route makes — resolves the same sheet again;
  //   * the typed 409s hold on the real row, and 087's CHECK is real: an UPDATE that breaks the
  //     status / archived_at pairing is refused by PostgreSQL itself (23514).
  it('S4 archive keeps the grid readable and writable for a G1-granted role; restore makes the write lookup resolve again', async () => {
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
    const registryRow = async () => (await pool.query(
      'SELECT status, archived_at, archived_by, restored_at, restored_by, sheet_id FROM integration_stock_prep_project_target WHERE tenant_id = $1 AND project_no = $2',
      [tenantId, PROJECT_A],
    )).rows[0] as { status: string; archived_at: Date | null; archived_by: string | null; restored_at: Date | null; restored_by: string | null; sheet_id: string }

    // Project A's sheet (provisioned and claimed in beforeAll) registered, with G1 granted to ROLE_A
    // (idempotent if the earlier case already did), and a floor user holding ROLE_A and NO global
    // multitable code — the grant alone is what opens the grid.
    await store.create({ tenantId, projectNo: PROJECT_A, sheetId: sheetA, objectId: objectA, createdBy: 'u_s4_pull', maxPerTenant: 200 })
    await scopedApi().provisioning.grantSheetRoleWrite!({ projectId, sheetId: sheetA, objectId: objectA, roleIds: [ROLE_A], actorId: 'u_s4_pull' })
    const floorUser = `s4floor_${suffix}`
    await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [floorUser, ROLE_A])
    const grid = async () => {
      const resolved = await resolveSheetCapabilitiesForAccess(q as never, sheetA, { userId: floorUser, permissions: [], isAdminRole: false })
      return {
        liveness: resolved.sheetLiveness,
        canRead: resolved.capabilities.canRead,
        canCreateRecord: resolved.capabilities.canCreateRecord,
        canEditRecord: resolved.capabilities.canEditRecord,
      }
    }
    const gridBefore = await grid()
    expect(gridBefore).toEqual({ liveness: 'live', canRead: true, canCreateRecord: true, canEditRecord: true })
    const grantsBefore = await permissionRows(sheetA)
    const historyBefore = await revisionCount(sheetA)
    expect(grantsBefore.some((row) => row.subject_type === 'role' && row.subject_id === ROLE_A && row.perm_code === 'spreadsheet:write')).toBe(true)

    const lookup = (targetPurpose: 'write' | 'read') => projectTargets.resolveProjectTargetForAction({
      store,
      provisioning: {
        resolveFieldIds: async ({ projectId: p, objectId: o, fieldIds }: { projectId: string; objectId: string; fieldIds: string[] }) => resolveObjectFieldIds(p, o, fieldIds),
      },
      projectId,
      tenantId,
      projectNo: PROJECT_A,
      targetPurpose,
      env: { [projectTargets.PROJECT_SHEETS_ENABLED_ENV]: 'true' },
    })

    // ARCHIVE.
    const archived = await store.archive({ tenantId, projectNo: PROJECT_A, actorId: 'u_s4_pull' })
    expect(archived.status).toBe('archived')
    const archivedRow = await registryRow()
    expect(archivedRow.status).toBe('archived')
    expect(archivedRow.archived_at).not.toBeNull()
    expect(archivedRow.archived_by).toBe('u_s4_pull')
    expect(archivedRow.sheet_id).toBe(sheetA)
    // The sheet, at the host level, is exactly as it was.
    const sheetRow = await pool.query('SELECT deleted_at FROM meta_sheets WHERE id = $1', [sheetA])
    expect((sheetRow.rows[0] as { deleted_at: Date | null }).deleted_at).toBeNull()
    expect(await permissionRows(sheetA)).toEqual(grantsBefore)
    expect(await revisionCount(sheetA)).toBe(historyBefore)
    expect(await grid()).toEqual(gridBefore)
    // The overlay: a write lookup refuses, a read lookup still resolves the same sheet.
    await expect(lookup('write')).rejects.toMatchObject({ status: 409, code: 'STOCK_PREPARATION_PROJECT_ARCHIVED' })
    await expect(lookup('read')).resolves.toMatchObject({ status: 'archived', target: { sheetId: sheetA, objectId: objectA } })
    await expect(store.archive({ tenantId, projectNo: PROJECT_A, actorId: 'u_s4_pull' })).rejects.toMatchObject({ status: 409, code: 'STOCK_PREPARATION_PROJECT_ALREADY_ARCHIVED' })
    // 087's CHECK is real: breaking the status / archived_at pairing is refused by PostgreSQL.
    await expect(pool.query(
      'UPDATE integration_stock_prep_project_target SET archived_at = NULL WHERE tenant_id = $1 AND project_no = $2',
      [tenantId, PROJECT_A],
    )).rejects.toMatchObject({ code: '23514' })

    // RESTORE.
    const restored = await store.restore({ tenantId, projectNo: PROJECT_A, actorId: 'u_s4_pull' })
    expect(restored.status).toBe('active')
    const restoredRow = await registryRow()
    expect(restoredRow.status).toBe('active')
    expect(restoredRow.archived_at).toBeNull()
    expect(restoredRow.restored_by).toBe('u_s4_pull')
    expect(restoredRow.restored_at).not.toBeNull()
    await expect(lookup('write')).resolves.toMatchObject({ status: 'active', target: { sheetId: sheetA, objectId: objectA } })
    await expect(store.restore({ tenantId, projectNo: PROJECT_A, actorId: 'u_s4_pull' })).rejects.toMatchObject({ status: 409, code: 'STOCK_PREPARATION_PROJECT_NOT_ARCHIVED' })
    expect(await grid()).toEqual(gridBefore)
    expect(await permissionRows(sheetA)).toEqual(grantsBefore)
  })

  // S3 (ADR §5 「只读（Q5）」, owner ruling Q5 2026-10-08: 宿主级只读 + O1 + O2(a)): THE PROJECT OVERVIEW, HOST HALF,
  // against real PostgreSQL:
  //   * provisioned through the REAL scope wrapper for plugin-integration-core, with an ensureObjectInScope
  //     hook that mirrors index.ts (assertPluginOwnsObject → ensureObject WITH systemKind →
  //     claimPluginObjectScope): `meta_sheets.system_kind` IS the overview kind, the ensure result and
  //     findObjectSheet carry it, and the registry records the sheet as the plugin's;
  //   * a role holding `spreadsheet:write` ON the overview opens it (canRead) but gets no record write — and a
  //     platform admin is clamped the same way; the SAME role on an ordinary twin keeps record writes (control);
  //     the host never rewrites an existing sheet's kind (re-ensuring the twin WITH the kind leaves it NULL);
  //   * the plugin records path — the function index.ts's plugin `createRecord` calls, inside a transaction as
  //     index.ts runs it — still writes a row, and it reads back;
  //   * the delete guard refuses the overview as system-managed (and not the twin);
  //   * another plugin naming the overview kind, and this plugin naming it for another object, are refused
  //     with nothing created.
  it('S3 overview: the host stamps stock_prep_overview, clamps every person to read/export (admin included), refuses deletion, and the plugin records path still writes', async () => {
    const KIND = STOCK_PREPARATION_PROJECT_OVERVIEW_SYSTEM_KIND
    expect(KIND).toBe('stock_prep_overview')
    type TxQuery = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>
    const inTx = async <T>(fn: (cq: TxQuery) => Promise<T>): Promise<T> => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const out = await fn(async (sql, params) => {
          const r = await client.query(sql, params as unknown[])
          return { rows: r.rows as unknown[], rowCount: r.rowCount }
        })
        await client.query('COMMIT')
        return out
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {})
        throw e
      } finally {
        client.release()
      }
    }
    // Mirrors index.ts `ensureObjectInScope` — including that `systemKind` rides the destructure.
    const ensureObjectInScope: NonNullable<MultitableScopeHooks['ensureObjectInScope']> = async ({ pluginName, projectId: pid, baseId, descriptor: d, overwriteMode, systemKind }) => {
      return inTx(async (cq) => {
        await assertPluginOwnsObject(cq, { pluginName, projectId: pid, objectId: d.id })
        const result = await ensureObject({ query: cq, projectId: pid, baseId, descriptor: d, overwriteMode, systemKind })
        await claimPluginObjectScope(cq, { pluginName, projectId: pid, objectId: d.id, sheetId: result.sheet.id })
        return result
      })
    }
    const scoped = (pluginName: string) => createPluginScopedMultitableApi(
      { provisioning: { getObjectSheetId }, records: {} } as never,
      pluginName,
      { ensureObjectInScope },
    )
    const descriptor = {
      id: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID,
      name: `S3 overview ${suffix}`,
      fields: [
        { id: 'projectNo', name: 'Project', type: 'string' as const },
        { id: 'status', name: 'Status', type: 'string' as const },
      ],
    }
    const twinDescriptor = { ...descriptor, id: `plm_s3_twin_${suffix}`, name: `S3 twin ${suffix}` }

    // THE STAMP.
    const ensured = await scoped(PLUGIN).provisioning.ensureObject({ projectId, baseId: null, descriptor, systemKind: KIND })
    overviewSheet = ensured.sheet.id
    expect(overviewSheet).toBe(getObjectSheetId(projectId, STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID))
    expect(ensured.sheet.systemKind).toBe(KIND)
    const stamped = await pool.query('SELECT system_kind, deleted_at FROM meta_sheets WHERE id = $1', [overviewSheet])
    expect(stamped.rows[0]).toEqual({ system_kind: KIND, deleted_at: null })
    expect((await findObjectSheet(q as never, projectId, STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID))?.systemKind).toBe(KIND)
    await expect(assertPluginOwnsSheet(q as never, { pluginName: PLUGIN, sheetId: overviewSheet })).resolves.toBe(true)
    // A re-ensure is idempotent and keeps the stamp.
    const again = await scoped(PLUGIN).provisioning.ensureObject({ projectId, baseId: null, descriptor, systemKind: KIND })
    expect(again.sheet).toMatchObject({ id: overviewSheet, systemKind: KIND })

    // The ordinary twin (no kind), and NO LAUNDERING: re-ensuring it WITH the kind is REFUSED inside the
    // provisioning transaction (fix round 1, R8c — SheetSystemKindConflictError, before any field write), and
    // the row keeps NULL.
    const twin = await inTx((cq) => ensureObject({ query: cq as never, projectId, baseId: null, descriptor: twinDescriptor }))
    overviewTwinSheet = twin.sheet.id
    expect(twin.sheet.systemKind).toBeNull()
    const twinFieldsBefore = Number((await pool.query('SELECT COUNT(*)::int AS n FROM meta_fields WHERE sheet_id = $1', [overviewTwinSheet])).rows[0].n)
    await expect(inTx((cq) => ensureObject({
      query: cq as never,
      projectId,
      baseId: null,
      descriptor: { ...twinDescriptor, fields: [...twinDescriptor.fields, { id: 'extra', name: 'Extra', type: 'string' as const }] },
      systemKind: KIND,
    }))).rejects.toBeInstanceOf(SheetSystemKindConflictError)
    expect((await pool.query('SELECT system_kind FROM meta_sheets WHERE id = $1', [overviewTwinSheet])).rows[0]).toEqual({ system_kind: null })
    expect(Number((await pool.query('SELECT COUNT(*)::int AS n FROM meta_fields WHERE sheet_id = $1', [overviewTwinSheet])).rows[0].n)).toBe(twinFieldsBefore)

    // THE CLAMP. One role holds spreadsheet:write on BOTH sheets; a floor user holds that role and no global code.
    await pool.query('INSERT INTO roles (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [ROLE_S3, 'S3 test role'])
    for (const sheetId of [overviewSheet, overviewTwinSheet]) {
      await pool.query(
        `INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code)
         VALUES ($1, NULL, 'role', $2, 'spreadsheet:write')
         ON CONFLICT (sheet_id, subject_type, subject_id, perm_code) DO NOTHING`,
        [sheetId, ROLE_S3],
      )
    }
    await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [S3_FLOOR_USER, ROLE_S3])
    const floor = { userId: S3_FLOOR_USER, permissions: [] as string[], isAdminRole: false }
    const admin = { userId: `s3admin_${suffix}`, permissions: [] as string[], isAdminRole: true }
    const capsOf = async (sheetId: string, access: typeof floor) =>
      (await resolveSheetCapabilitiesForAccess(q as never, sheetId, access)).capabilities as unknown as Record<string, boolean>
    // Control: on the twin both keep record writes — the grant is real and the admin is an admin.
    for (const access of [floor, admin]) {
      expect(await capsOf(overviewTwinSheet, access)).toMatchObject({ canRead: true, canCreateRecord: true, canEditRecord: true })
    }
    // On the overview: read stays, every write is gone — for the admin too. Access management is KEPT as
    // resolved (fix round 1, R1): the admin may share the overview for reading; the write-grant floor never had it.
    const WRITE_KEYS = ['canCreateRecord', 'canEditRecord', 'canDeleteRecord', 'canManageFields', 'canManageViews', 'canComment', 'canManageAutomation', 'canSendNotification', 'canSubmitApproval']
    for (const access of [floor, admin]) {
      const c = await capsOf(overviewSheet, access)
      expect(c.canRead, `${access.userId} canRead`).toBe(true)
      for (const key of WRITE_KEYS) expect(c[key], `${access.userId} ${key}`).toBe(false)
    }
    expect((await capsOf(overviewSheet, admin)).canManageSheetAccess).toBe(true)
    expect((await capsOf(overviewSheet, floor)).canManageSheetAccess).toBe(false)

    // THE G1 READ PORT (fix round 1, R1), real DB: a second role gets `spreadsheet:read` on the overview — one
    // row, add-only, a history row; a reader holding only that role opens the overview and writes nothing; the
    // port refuses the unstamped twin with nothing written.
    const ROLE_S3_READ = `${ROLE_S3}_read`
    const S3_READER = `${S3_FLOOR_USER}_read`
    await pool.query('INSERT INTO roles (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [ROLE_S3_READ, 'S3 read role'])
    await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [S3_READER, ROLE_S3_READ])
    const readGrant = await inTx((cq) => grantStockPreparationOverviewRoleRead(cq, { sheetId: overviewSheet, roleIds: [ROLE_S3_READ], actorId: 'u_s3_puller' }))
    expect(readGrant).toEqual({ sheetId: overviewSheet, granted: [ROLE_S3_READ], alreadyGranted: [] })
    const readRows = await pool.query("SELECT perm_code FROM spreadsheet_permissions WHERE sheet_id = $1 AND subject_type = 'role' AND subject_id = $2", [overviewSheet, ROLE_S3_READ])
    expect(readRows.rows).toEqual([{ perm_code: 'spreadsheet:read' }])
    const readGrantAgain = await inTx((cq) => grantStockPreparationOverviewRoleRead(cq, { sheetId: overviewSheet, roleIds: [ROLE_S3_READ] }))
    expect(readGrantAgain.alreadyGranted).toEqual([ROLE_S3_READ])
    const reader = await capsOf(overviewSheet, { userId: S3_READER, permissions: [] as string[], isAdminRole: false })
    expect(reader.canRead).toBe(true)
    for (const key of WRITE_KEYS) expect(reader[key], `reader ${key}`).toBe(false)
    await expect(inTx((cq) => grantStockPreparationOverviewRoleRead(cq, { sheetId: overviewTwinSheet, roleIds: [ROLE_S3_READ] })))
      .rejects.toMatchObject({ status: 409, code: 'STOCK_PREP_OVERVIEW_GRANT_NOT_OVERVIEW' })
    const twinReadRows = await pool.query("SELECT 1 FROM spreadsheet_permissions WHERE sheet_id = $1 AND subject_id = $2", [overviewTwinSheet, ROLE_S3_READ])
    expect(twinReadRows.rowCount).toBe(0)
    await pool.query('DELETE FROM user_roles WHERE user_id = $1', [S3_READER]).catch(() => {})
    expect((await capsOf(overviewSheet, admin)).canExport).toBe(true)
    expect((await capsOf(overviewSheet, floor)).canExport).toBe((await capsOf(overviewTwinSheet, floor)).canExport)

    // THE PLUGIN RECORDS PATH still writes (records.ts createRecord, in a transaction, exactly as index.ts runs it).
    const projectField = ensured.fields.find((f) => f.name === 'Project')!.id
    const value = `S3-P-${suffix}`
    const created = await inTx((cq) => createMultitableRecord({ query: cq as never, sheetId: overviewSheet, data: { [projectField]: value } }))
    expect(created.sheetId).toBe(overviewSheet)
    const readBack = await getMultitableRecord({ query: q as never, sheetId: overviewSheet, recordId: created.id })
    expect(readBack.data[projectField]).toBe(value)

    // THE DELETE GUARD.
    await expect(isSystemManagedSheet(q as never, overviewSheet)).resolves.toBe(true)
    await expect(isSystemManagedSheet(q as never, overviewTwinSheet)).resolves.toBe(false)

    // THE GATE, on the real wrapper: another plugin, and this plugin on another object — refused, nothing created.
    const otherProject = `${tenantId}:other-s3test`
    const otherObject = `plm_s3_other_${suffix}`
    await expect(scoped('plugin-other-s3test').provisioning.ensureObject({ projectId: otherProject, baseId: null, descriptor, systemKind: KIND }))
      .rejects.toBeInstanceOf(StockPreparationOverviewSystemKindError)
    await expect(scoped(PLUGIN).provisioning.ensureObject({ projectId, baseId: null, descriptor: { ...descriptor, id: otherObject }, systemKind: KIND }))
      .rejects.toMatchObject({ status: 403, code: 'MULTITABLE_SYSTEM_KIND_FORBIDDEN' })
    const leaked = await pool.query('SELECT id FROM meta_sheets WHERE id = ANY($1::text[])', [[
      getObjectSheetId(otherProject, STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID),
      getObjectSheetId(projectId, otherObject),
    ]])
    expect(leaked.rowCount).toBe(0)
  })

  // S3 fix round 2 (F3 / F4), against real PostgreSQL — runs after the S3 case above (it needs the stamped overview):
  //   * F4: the overview lock is `pg_try_advisory_xact_lock` through the plugin's REAL db helper and the REAL store —
  //     while one transaction holds it, a second answers `{ acquired: false }` AT ONCE (it does not wait for the
  //     holder), and once the holder commits the lock is free again;
  //   * F3: through the REAL plugin-scope wrapper with index.ts's stamp hook (the contract's lookup on this database),
  //     a GENERIC plugin createRecord to the stamped overview is refused (StockPreparationOverviewRecordsWriteError,
  //     no row), while the overview PORT — given only the project id — writes it; an ordinary plugin-owned sheet of
  //     the same id shape still takes a generic write.
  it('S3 fix round 2 (real DB): the overview lock never waits; generic plugin record writes refuse the stamped overview while its port writes it', async () => {
    expect(overviewSheet, 'the S3 case above provisioned the overview').not.toBe('')
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
    const store = projectTargetStore.createStockPreparationProjectTargetStore({ db: pluginDb.createDb({ database }) }) as {
      tryWithOverviewLock: <T>(input: { tenantId: string }, fn: () => Promise<T>) => Promise<{ acquired: boolean; value?: T }>
    }
    // F4 — THE TRY-LOCK.
    let signalHeld!: () => void
    const held = new Promise<void>((resolve) => { signalHeld = resolve })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const holder = store.tryWithOverviewLock({ tenantId }, async () => { signalHeld(); await gate; return 'held' })
    await held
    const started = Date.now()
    let secondRan = false
    await expect(store.tryWithOverviewLock({ tenantId }, async () => { secondRan = true; return 'second' })).resolves.toEqual({ acquired: false })
    expect(secondRan).toBe(false)
    expect(Date.now() - started, 'the busy try answered without waiting for the holder').toBeLessThan(3000)
    // Another tenant's overview lock is independent.
    await expect(store.tryWithOverviewLock({ tenantId: `${tenantId}_other` }, async () => 'other')).resolves.toEqual({ acquired: true, value: 'other' })
    release()
    await expect(holder).resolves.toEqual({ acquired: true, value: 'held' })
    await expect(store.tryWithOverviewLock({ tenantId }, async () => 'again')).resolves.toEqual({ acquired: true, value: 'again' })

    // F3 — THE WRAPPER, index.ts-shaped hooks over this database.
    const inTx = async <T>(fn: (cq: Q) => Promise<T>): Promise<T> => database.transaction((trx) => fn(trx.query))
    const raw = {
      provisioning: { getObjectSheetId },
      records: {
        createRecord: (input: { sheetId: string; data: Record<string, unknown> }) => inTx((cq) => createMultitableRecord({ query: cq as never, sheetId: input.sheetId, data: input.data })),
      },
    }
    const wrapper = createPluginScopedMultitableApi(raw as never, PLUGIN, {
      assertSheetScope: async ({ pluginName, sheetId }) => {
        const owns = await assertPluginOwnsSheet(q as never, { pluginName, sheetId })
        if (!owns) throw new MultitableSheetScopeError(pluginName, sheetId, 'unregistered')
        return { registered: true }
      },
      assertSheetOwnedByPlugin: async ({ pluginName, sheetId }) => {
        const owns = await assertPluginOwnsSheet(q as never, { pluginName, sheetId })
        if (!owns) throw new MultitableSheetScopeError(pluginName, sheetId, 'unregistered')
      },
      isStockPreparationOverviewSheet: async ({ sheetId }) => (await loadStockPreparationOverviewSheetIds(q as never, [sheetId])).has(sheetId),
    })
    const overviewRowCount = async () => Number((await pool.query('SELECT COUNT(*)::int AS n FROM meta_records WHERE sheet_id = $1', [overviewSheet])).rows[0].n)
    const before = await overviewRowCount()
    const generic = await wrapper.records.createRecord({ sheetId: overviewSheet, data: {} }).then(() => null, (e: unknown) => e)
    expect(generic).toBeInstanceOf(StockPreparationOverviewRecordsWriteError)
    expect(generic).toMatchObject({ status: 403, code: 'STOCK_PREP_OVERVIEW_READ_ONLY', details: { reason: 'generic_write' } })
    expect(await overviewRowCount(), 'the generic write left no row').toBe(before)
    const viaPort = await wrapper.records.stockPreparationOverview!.createRecord({ projectId, data: {} })
    expect(viaPort.sheetId).toBe(overviewSheet)
    expect(await overviewRowCount(), 'the port wrote exactly one row').toBe(before + 1)
    // Control: an ordinary sheet of the same id shape, registered to the plugin, still takes a generic write.
    const ordinary = await wrapper.records.createRecord({ sheetId: sheetA, data: {} })
    expect(ordinary.sheetId).toBe(sheetA)
    // S3 follow-up E — the REAL stamp lookup (index.ts's hook over this database) decides an unmarked ensureView:
    // refused on the stamped overview, admitted on an ordinary derived-shape sheet; the overview module's own marked
    // call reaches the host without the marker.
    const viewDescriptor = { id: 'overview-active', objectId: STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID, name: 'Active', type: 'grid' }
    const hostEnsureView = vi.fn(async (input: { sheetId: string }) => ({ id: 'view_e', sheetId: input.sheetId }))
    const structural = createPluginScopedMultitableApi({ provisioning: { getObjectSheetId, ensureView: hostEnsureView }, records: {} } as never, PLUGIN, {
      assertSheetScope: async ({ pluginName, sheetId }) => {
        const owns = await assertPluginOwnsSheet(q as never, { pluginName, sheetId })
        if (!owns) throw new MultitableSheetScopeError(pluginName, sheetId, 'unregistered')
        return { registered: true }
      },
      isStockPreparationOverviewSheet: async ({ sheetId }) => (await loadStockPreparationOverviewSheetIds(q as never, [sheetId])).has(sheetId),
    })
    const unmarked = await structural.provisioning.ensureView({ projectId, sheetId: overviewSheet, descriptor: viewDescriptor } as never).then(() => null, (e: unknown) => e)
    expect(unmarked).toBeInstanceOf(StockPreparationOverviewStructureWriteError)
    expect(unmarked).toMatchObject({ status: 403, code: 'STOCK_PREP_OVERVIEW_READ_ONLY', details: { reason: 'structure_write' } })
    expect(hostEnsureView).not.toHaveBeenCalled()
    await structural.provisioning.ensureView({ projectId, sheetId: sheetA, descriptor: viewDescriptor } as never)
    await structural.provisioning.ensureView({ projectId, sheetId: overviewSheet, descriptor: viewDescriptor, systemKind: STOCK_PREPARATION_PROJECT_OVERVIEW_SYSTEM_KIND } as never)
    expect(hostEnsureView.mock.calls.map((call) => (call[0] as { sheetId: string }).sheetId)).toEqual([sheetA, overviewSheet])
    expect(hostEnsureView.mock.calls[1][0]).not.toHaveProperty('systemKind')
  })
})

// S3 follow-up B (register R-37), against real PostgreSQL: the CROSS-PROCESS refresh BUSY at the ROUTE. Another
// database session (a plain pool client — nothing shared with the plugin's in-process writer state, exactly what
// another app process is) holds the tenant's overview advisory lock in an open transaction. The OPERATE refresh
// route, over the REAL registry store and the plugin's REAL db helper:
//   * answers 409 STOCK_PREPARATION_PROJECT_OVERVIEW_BUSY at once (it does not wait for the holder), with no
//     overview write and no audit row;
//   * CLEARS its cooldown — so once the other session commits, the very next click refreshes for real (200
//     `fresh: true`) instead of answering the 60-second cooldown (`fresh: false`).
// The multitable host is a minimal stamped fake: the lock, the registry reads and the route are what this pins.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const s3fuHttpRoutes = require(
  path.join(__dirname, '..', '..', '..', '..', 'plugins', 'plugin-integration-core', 'lib', 'http-routes.cjs'),
)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const s3fuHarness = require(
  path.join(__dirname, '..', '..', '..', '..', 'plugins', 'plugin-integration-core', '__tests__', 'support', 'stock-preparation-project-sheet-harness.cjs'),
)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const s3fuAccess = require(
  path.join(__dirname, '..', '..', '..', '..', 'plugins', 'plugin-integration-core', 'lib', 'stock-preparation-workbench-access.cjs'),
)

describeDb('S3 follow-up B: cross-process overview refresh BUSY at the route (real registry store, real advisory lock, real DB)', () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10)
  const tenantId = `s3fub_${suffix}`
  const stagingProjectId = `${tenantId}:integration-core`
  const OVERVIEW_SHEET = `sheet_s3fub_overview_${suffix}`
  const SWITCH = 'MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED'
  const LOCK_KEY = `stock-prep-project-overview:${tenantId}`
  const FLOOR = { id: `s3fub_floor_${suffix}`, tenantId, permissions: [s3fuAccess.STOCK_PREP_READ, s3fuAccess.STOCK_PREP_OPERATE] }
  let pool: Pool
  let previousSwitch: string | undefined

  beforeAll(() => {
    pool = new Pool({ connectionString: dbUrl })
    previousSwitch = process.env[SWITCH]
    process.env[SWITCH] = 'true'
  })

  afterAll(async () => {
    if (previousSwitch === undefined) delete process.env[SWITCH]
    else process.env[SWITCH] = previousSwitch
    await pool.query('DELETE FROM integration_stock_prep_project_target WHERE tenant_id = $1', [tenantId]).catch(() => {})
    await pool.end()
  })

  it('another session holds the overview lock: 409 BUSY at once, nothing written or audited, cooldown CLEARED — the first click after it commits refreshes (fresh: true)', async () => {
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
    // The stamped host (minimal): the overview exists and is stamped; every overview write goes through the port.
    const portWrites: string[] = []
    const provisioning = {
      supportsSystemKindStamp: true,
      findObjectSheet: async (input: { projectId: string; objectId: string }) => (
        input.projectId === stagingProjectId && input.objectId === STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID
          ? { id: OVERVIEW_SHEET, systemKind: STOCK_PREPARATION_PROJECT_OVERVIEW_SYSTEM_KIND }
          : null
      ),
      ensureObject: async () => { throw new Error('the refresh never provisions') },
      resolveFieldIds: async (input: { objectId: string; fieldIds: string[] }) => Object.fromEntries(input.fieldIds.map((id) => [id, `fld_${id}`])),
      getFieldId: (_projectId: string, _objectId: string, fieldId: string) => `fld_${fieldId}`,
      getObjectViewId: (_projectId: string, objectId: string, viewId: string) => `view_${objectId.slice(-6)}_${viewId}`,
    }
    const records = {
      queryRecords: async () => [],
      createRecord: async () => { throw new Error('generic write') },
      patchRecord: async () => { throw new Error('generic write') },
      deleteRecord: async () => { throw new Error('generic write') },
      stockPreparationOverview: {
        createRecord: async () => { portWrites.push('create'); return { id: 'rec_x', version: 1, data: {} } },
        patchRecord: async () => { portWrites.push('patch'); return { id: 'rec_x', version: 2, data: {} } },
        deleteRecord: async () => { portWrites.push('delete'); return { id: 'rec_x', version: 1 } },
      },
    }
    const audits: Array<{ action: string; mode: string }> = []
    const routes = new Map<string, unknown>()
    s3fuHttpRoutes.registerIntegrationRoutes({
      context: {
        api: { http: { addRoute(method: string, routePath: string, handler: unknown) { routes.set(`${method.toUpperCase()} ${routePath}`, handler) } }, multitable: { provisioning, records } },
        storage: new Map(),
        config: {},
      },
      services: {
        ...Object.fromEntries(['externalSystemRegistry', 'adapterRegistry', 'pipelineRegistry', 'pipelineRunner', 'deadLetterStore', 'stagingInstaller', 'templateRegistry', 'readSourceConfigStore', 'readSourceCompositionConfigStore', 'bridgeAgentChecklistStore']
          .map((name) => [name, new Proxy({}, { get: (_target, method) => async () => { throw new Error(`unexpected ${name}.${String(method)}`) } })])),
        stockPreparationAuditStore: {
          append: async (entry: { action: string; mode: string }) => { audits.push({ action: entry.action, mode: entry.mode }); return { ok: true } },
          supportsAction: async () => ({ supported: true }),
        },
        stockPreparationProjectTargetStore: store,
        tenantPrincipalDirectory: { verifyTenantMembership: async () => ({ member: true }) },
      },
      logger: { info() {}, warn() {}, error() {} },
    })
    const refresh = () => s3fuHarness.call(routes, 'POST', '/api/integration/stock-preparation/project-overview/refresh', { user: FLOOR, body: {} }) as Promise<{ statusCode: number; body: { ok: boolean; data?: { fresh?: boolean }; error?: { code: string } } }>

    // ANOTHER SESSION takes the tenant's overview lock (the same key derivation the plugin's db helper uses) and holds it.
    const other = await pool.connect()
    try {
      await other.query('BEGIN')
      const taken = await other.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked', [LOCK_KEY])
      expect(taken.rows[0].locked, 'the other session holds the overview lock').toBe(true)
      const started = Date.now()
      const busy = await refresh()
      expect(Date.now() - started, 'the busy refresh did not wait for the other session').toBeLessThan(3000)
      expect(busy.statusCode, JSON.stringify(busy.body)).toBe(409)
      expect(busy.body.ok).toBe(false)
      expect(busy.body.error?.code).toBe('STOCK_PREPARATION_PROJECT_OVERVIEW_BUSY')
      expect(portWrites, 'nothing was written').toEqual([])
      expect(audits, 'nothing was audited').toEqual([])
      await other.query('COMMIT')
    } finally {
      other.release()
    }
    // The lock is free. NO clock step: the BUSY answer must have cleared the cooldown, so this is a real refresh.
    const next = await refresh()
    expect(next.statusCode, JSON.stringify(next.body)).toBe(200)
    expect(next.body.data?.fresh, 'the BUSY click left no cooldown behind').toBe(true)
    expect(audits).toEqual([{ action: 'project_overview_refresh', mode: 'refreshed' }])
    // …and a click right after a refresh that DID run is the cooldown (the control: the cooldown itself works).
    const cooled = await refresh()
    expect(cooled.statusCode).toBe(200)
    expect(cooled.body.data?.fresh).toBe(false)
  })
})
