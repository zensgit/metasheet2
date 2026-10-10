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
    // S3 follow-ups, fix round 1 (no ordering oracle) — a FOREIGN plugin's unmarked ensureView meets the REAL owner
    // check (the registry rows of this database) before anything else: the overview and an ordinary integration-core
    // sheet answer the same scope refusal, and the stamp lookup is never asked.
    const foreignLookup = vi.fn(async ({ sheetId }: { sheetId: string }) => (await loadStockPreparationOverviewSheetIds(q as never, [sheetId])).has(sheetId))
    const foreign = createPluginScopedMultitableApi({ provisioning: { getObjectSheetId, ensureView: hostEnsureView }, records: {} } as never, 'plugin-after-sales', {
      assertSheetScope: async ({ pluginName, sheetId }) => ({ registered: await assertPluginOwnsSheet(q as never, { pluginName, sheetId }) }),
      isStockPreparationOverviewSheet: foreignLookup,
    })
    const probeForeign = async (sheetId: string) => {
      const error = await foreign.provisioning.ensureView({ projectId: `${tenantId}:after-sales`, sheetId, descriptor: viewDescriptor } as never).then(() => null, (e: unknown) => e)
      expect(error).toBeInstanceOf(MultitableSheetScopeError)
      const e = error as MultitableSheetScopeError
      return { name: e.name, code: e.code, message: e.message.split(sheetId).join('<sheet>') }
    }
    expect(await probeForeign(overviewSheet)).toStrictEqual(await probeForeign(sheetA))
    expect(foreignLookup).not.toHaveBeenCalled()
    expect(hostEnsureView).toHaveBeenCalledTimes(2)
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

// ---------------------------------------------------------------------------------------------
// 备料「成员与权限」S5b (ADR adr-stock-prep-project-sheets-20261008 §11.4–11.6, register R-39) — the
// host's narrow members port through its REAL wiring (`createStockPrepMembersHostPort`: db/pg, the
// rbac service, namespace admission, the grid's readability resolver, the audit writer), against
// real PostgreSQL:
//   * RD-01 a platform admin's create lands a server-generated stock-prep_c_ role, exactly the codes,
//     and an audit_logs row in the delegation shape;
//   * RD-02 a platform code in the body is 400 with ZERO rows written;
//   * RD-03 the admitted, scoped stock-prep_admin reads the page: the scope SQL runs on the real
//     delegation tables (member group), the out-of-scope member is a count only, the audit section
//     reads audit_logs;
//   * RD-04 the same admin may not change what a role grants while it has an out-of-scope member; once
//     every member is in scope the change lands (DELETE/INSERT on role_permissions, audit `update`);
//   * RD-05 without an effective admission the role holder is 403 and nothing is written;
//   * RD-06 project-sheet scope: a sheet the delegated admin cannot write refuses the whole call with no
//     grant row; the platform admin's call lands a role-only `spreadsheet:write` row through the real
//     G1 grant service, and an audit `grant` row.
// Synthetic ids, random per run; everything this block creates is removed afterwards (audit_logs rows
// stay — the CI database is throwaway).
// ---------------------------------------------------------------------------------------------
import { createStockPrepMembersHostPort } from '../../src/services/stock-preparation-members-host'

describeDb('S5b members port (real host wiring, real DB)', () => {
  const ENV = 'STOCK_PREP_MEMBERS_PAGE_ENABLED'
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10)
  const ADMIN = `s5b_admin_${suffix}`
  const DELEGATED = `s5b_deleg_${suffix}`
  const IN_SCOPE = `s5b_in_${suffix}`
  const OUT_SCOPE = `s5b_out_${suffix}`
  const USERS = [ADMIN, DELEGATED, IN_SCOPE, OUT_SCOPE]
  const MAIN = 'stock-prep_admin'
  const BASE = `s5b_base_${suffix}`
  const SHEET = `s5b_sheet_${suffix}`
  let pool: Pool
  let previousEnv: string | undefined
  let createdAdminRole = false
  let createdMainRole = false
  let createdMainCode = false
  let groupId = ''
  const createdRoleIds: string[] = []
  let port: ReturnType<typeof createStockPrepMembersHostPort>

  const roleCodes = async (roleId: string) => (await pool.query(
    'SELECT permission_code FROM role_permissions WHERE role_id = $1 ORDER BY permission_code', [roleId],
  )).rows.map((row: { permission_code: string }) => row.permission_code)
  const auditRows = async (roleId: string) => (await pool.query(
    "SELECT action, resource_type, resource_id, action_details FROM audit_logs WHERE resource_type = 'role' AND resource_id = $1 ORDER BY id",
    [roleId],
  )).rows as Array<{ action: string; resource_type: string; resource_id: string; action_details: Record<string, unknown> }>
  const refusal = async (promise: Promise<unknown>) => {
    try {
      await promise
    } catch (error) {
      return error as { status: number; code: string }
    }
    throw new Error('expected a refusal')
  }

  beforeAll(async () => {
    previousEnv = process.env[ENV]
    process.env[ENV] = 'true'
    pool = new Pool({ connectionString: dbUrl })
    for (const id of USERS) {
      await pool.query('INSERT INTO users (id, password_hash, name, username) VALUES ($1, $2, $3, $4)', [id, 'not-a-hash', `S5b ${id.split('_')[1]}`, id])
    }
    createdAdminRole = (await pool.query("INSERT INTO roles (id, name) VALUES ('admin', 'admin') ON CONFLICT (id) DO NOTHING RETURNING id")).rows.length > 0
    // S5a seeds the main administrator; on a database that has not run it yet, this block brings its own.
    createdMainRole = (await pool.query('INSERT INTO roles (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id', [MAIN, 'S5b test main admin'])).rows.length > 0
    createdMainCode = (await pool.query("INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, 'stock-prep:admin') ON CONFLICT DO NOTHING RETURNING role_id", [MAIN])).rows.length > 0
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin')", [ADMIN])
    await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [DELEGATED, MAIN])
    await pool.query("INSERT INTO user_namespace_admissions (user_id, namespace, enabled, source) VALUES ($1, 'stock-prep', true, 'platform_admin')", [DELEGATED])
    groupId = (await pool.query('INSERT INTO platform_member_groups (name) VALUES ($1) RETURNING id', [`s5b group ${suffix}`])).rows[0].id
    await pool.query('INSERT INTO platform_member_group_members (group_id, user_id) VALUES ($1, $2)', [groupId, IN_SCOPE])
    await pool.query("INSERT INTO delegated_role_admin_member_groups (admin_user_id, namespace, group_id) VALUES ($1, 'stock-prep', $2)", [DELEGATED, groupId])
    await pool.query('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE, 's5b base'])
    await pool.query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [SHEET, BASE, 's5b sheet'])
    port = createStockPrepMembersHostPort()
  })

  afterAll(async () => {
    if (previousEnv === undefined) delete process.env[ENV]
    else process.env[ENV] = previousEnv
    await pool.query('DELETE FROM spreadsheet_permissions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await pool.query('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET]).catch(() => {})
    await pool.query('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await pool.query('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await pool.query('DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [USERS]).catch(() => {})
    if (createdRoleIds.length) {
      await pool.query('DELETE FROM user_roles WHERE role_id = ANY($1::text[])', [createdRoleIds]).catch(() => {})
      await pool.query('DELETE FROM role_permissions WHERE role_id = ANY($1::text[])', [createdRoleIds]).catch(() => {})
      await pool.query('DELETE FROM roles WHERE id = ANY($1::text[])', [createdRoleIds]).catch(() => {})
    }
    if (createdMainCode) await pool.query("DELETE FROM role_permissions WHERE role_id = $1 AND permission_code = 'stock-prep:admin'", [MAIN]).catch(() => {})
    if (createdMainRole) await pool.query('DELETE FROM roles WHERE id = $1', [MAIN]).catch(() => {})
    if (createdAdminRole) await pool.query("DELETE FROM roles WHERE id = 'admin'").catch(() => {})
    await pool.query('DELETE FROM delegated_role_admin_member_groups WHERE admin_user_id = $1', [DELEGATED]).catch(() => {})
    if (groupId) {
      await pool.query('DELETE FROM platform_member_group_members WHERE group_id = $1', [groupId]).catch(() => {})
      await pool.query('DELETE FROM platform_member_groups WHERE id = $1', [groupId]).catch(() => {})
    }
    await pool.query('DELETE FROM user_namespace_admissions WHERE user_id = ANY($1::text[])', [USERS]).catch(() => {})
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [USERS]).catch(() => {})
    await pool.end()
  })

  it('RD-01 a platform admin creates a server-generated custom role with exactly its codes and an audit row', async () => {
    const created = await port.createCustomRole({ actorId: ADMIN, name: 'S5b 采购只读', permissionCodes: ['stock-prep:read', 'stock-prep:operate'] }) as { roleId: string }
    createdRoleIds.push(created.roleId)
    expect(created.roleId).toMatch(/^stock-prep_c_[0-9a-f]{8}$/)
    expect((await pool.query('SELECT name FROM roles WHERE id = $1', [created.roleId])).rows[0].name).toBe('S5b 采购只读')
    expect(await roleCodes(created.roleId)).toEqual(['stock-prep:operate', 'stock-prep:read'])
    const audit = await auditRows(created.roleId)
    expect(audit.map((row) => row.action)).toEqual(['create'])
    expect(audit[0].action_details).toMatchObject({ adminUserId: ADMIN, delegated: false, roleId: created.roleId, permissions: ['stock-prep:read', 'stock-prep:operate'] })
  })

  it('RD-02 a platform code in the body is 400 and writes no role', async () => {
    const before = Number((await pool.query("SELECT COUNT(*)::int AS n FROM roles WHERE id LIKE 'stock-prep\\_c\\_%' ESCAPE '\\'")).rows[0].n)
    for (const code of ['multitable:read', 'roles:write', '*:*']) {
      const error = await refusal(port.createCustomRole({ actorId: ADMIN, name: 'x', permissionCodes: [code] }))
      expect([error.status, error.code]).toEqual([400, 'STOCK_PREP_CUSTOM_ROLE_PLATFORM_CODE_FORBIDDEN'])
    }
    expect(Number((await pool.query("SELECT COUNT(*)::int AS n FROM roles WHERE id LIKE 'stock-prep\\_c\\_%' ESCAPE '\\'")).rows[0].n)).toBe(before)
  })

  it('RD-03 the admitted, scoped main administrator reads the page; out-of-scope members are a count', async () => {
    const roleId = createdRoleIds[0]
    await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2), ($3, $2)', [IN_SCOPE, roleId, OUT_SCOPE])
    const view = await port.describe({ actorId: DELEGATED }) as Record<string, any>
    expect(view.actor).toMatchObject({ isPlatformAdmin: false, delegated: true })
    expect(view.grantableCodes).toEqual(['stock-prep:read', 'stock-prep:operate', 'stock-prep:pull'])
    const custom = view.customRoles.find((role: any) => role.id === roleId)
    expect(custom.members.map((member: any) => member.userId)).toEqual([IN_SCOPE])
    expect(custom.outOfScopeMemberCount).toBe(1)
    expect(JSON.stringify(view)).not.toContain(OUT_SCOPE)
    expect(view.builtInRoles.find((role: any) => role.id === MAIN)).toMatchObject({ installed: true, appointable: false })
    expect(view.audit.available).toBe(true)
  })

  it('RD-04 a role with an out-of-scope member cannot be changed by the delegated admin; with every member in scope it can', async () => {
    const roleId = createdRoleIds[0]
    const error = await refusal(port.updateCustomRole({ actorId: DELEGATED, roleId, permissionCodes: ['stock-prep:read'] }))
    expect([error.status, error.code]).toEqual([403, 'STOCK_PREP_CUSTOM_ROLE_MEMBERS_OUT_OF_SCOPE'])
    expect(await roleCodes(roleId)).toEqual(['stock-prep:operate', 'stock-prep:read'])
    await pool.query('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2', [OUT_SCOPE, roleId])
    await port.updateCustomRole({ actorId: DELEGATED, roleId, permissionCodes: ['stock-prep:read', 'stock-prep:pull'] })
    expect(await roleCodes(roleId)).toEqual(['stock-prep:pull', 'stock-prep:read'])
    const audit = await auditRows(roleId)
    expect(audit.map((row) => row.action)).toEqual(['create', 'update'])
    expect(audit[1].action_details).toMatchObject({ adminUserId: DELEGATED, delegated: true, delegableNamespaces: ['stock-prep'], permissionsAdded: ['stock-prep:pull'], permissionsRemoved: ['stock-prep:operate'] })
  })

  it('RD-05 without an effective admission the main-administrator role grants nothing', async () => {
    await pool.query("UPDATE user_namespace_admissions SET enabled = false WHERE user_id = $1 AND namespace = 'stock-prep'", [DELEGATED])
    try {
      const error = await refusal(port.createCustomRole({ actorId: DELEGATED, name: 'x', permissionCodes: ['stock-prep:read'] }))
      expect([error.status, error.code]).toEqual([403, 'STOCK_PREP_MEMBERS_FORBIDDEN'])
    } finally {
      await pool.query("UPDATE user_namespace_admissions SET enabled = true WHERE user_id = $1 AND namespace = 'stock-prep'", [DELEGATED])
    }
  })

  it('RD-06 project-sheet scope: not writable for the grantor refuses with no row; the platform admin lands a role-only write row through G1', async () => {
    const roleId = createdRoleIds[0]
    const grantThroughG1 = async () => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const cq = async (sql: string, params?: unknown[]) => {
          const r = await client.query(sql, params as unknown[])
          return { rows: r.rows as unknown[], rowCount: r.rowCount }
        }
        const result = await grantStockPreparationProjectSheetRoleWrite(cq, { sheetId: SHEET, roleIds: [roleId], actorId: 'actor' })
        await client.query('COMMIT')
        return { granted: result.granted.length > 0 }
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        throw error
      } finally {
        client.release()
      }
    }
    const refused = await refusal(port.grantCustomRoleProjectSheets({ actorId: DELEGATED, roleId, resolveTargets: async () => [{ sheetId: SHEET, grant: grantThroughG1 }] }))
    expect([refused.status, refused.code]).toEqual([403, 'STOCK_PREP_CUSTOM_ROLE_SHEET_NOT_WRITABLE'])
    expect((await pool.query('SELECT COUNT(*)::int AS n FROM spreadsheet_permissions WHERE sheet_id = $1', [SHEET])).rows[0].n).toBe(0)
    const result = await port.grantCustomRoleProjectSheets({ actorId: ADMIN, roleId, resolveTargets: async () => [{ sheetId: SHEET, grant: grantThroughG1 }] })
    expect(result).toEqual({ roleId, sheets: [{ sheetId: SHEET, granted: true }] })
    const rows = (await pool.query('SELECT subject_type, subject_id, perm_code, user_id FROM spreadsheet_permissions WHERE sheet_id = $1', [SHEET])).rows
    expect(rows).toEqual([{ subject_type: 'role', subject_id: roleId, perm_code: 'spreadsheet:write', user_id: null }])
    const audit = await auditRows(roleId)
    expect(audit.map((row) => row.action)).toEqual(['create', 'update', 'grant'])
    expect(audit[2].action_details).toMatchObject({ adminUserId: ADMIN, sheetId: SHEET, permission: 'spreadsheet:write', granted: true })
  })
})

// ---------------------------------------------------------------------------------------------
// S5b fix round 1 — the members port's new guards through the REAL host wiring on real PostgreSQL:
//   * RF-01 (S2) the project-sheet bound is WRITE: a delegated admin holding only `spreadsheet:read`
//     (or `spreadsheet:write-own`) on a sheet is refused with no row written; `spreadsheet:write' lands;
//   * RF-02 (S2, S3) a global record-write code without `multitable:manage-schema` is not enough to
//     hand out `spreadsheet:write`; the sheet decision reads FRESH codes: a code revoked in the
//     database while still in the 60 s permission memo is not honoured;
//   * RF-03 (S4) the caller tier is exactly `stock-prep_admin`: another admitted, scoped `_admin`
//     role of the namespace is 403;
//   * RF-04 (S4) the platform-admin decision is the DB `admin` role only: legacy `users.is_admin` /
//     `users.role = 'admin'` without it is 403;
//   * RF-05 (S1) a custom-shaped role carrying a platform code is locked: shown, not appointable or
//     editable, every port write 409, nothing changes;
//   * RF-06 (S5) 98 custom roles + 6 parallel creates → exactly 2 land, the cap holds at 100;
//     RF-06b the same at 99 with a barrier that holds the first in-lock count open: one lands;
//   * RF-07 (S5) an out-of-scope member appointed after the fast scan is seen by the scan under the
//     locks (refused); one appointed DURING the locked transaction waits for its commit;
//   * RF-08 (S5) the grantor's admission revoked after the fast check is seen under the locks
//     (refused); one revoked DURING the locked transaction waits for its commit.
// Synthetic ids, random per run; everything this block creates is removed afterwards.
// ---------------------------------------------------------------------------------------------
import { createStockPrepMembersHostDeps } from '../../src/services/stock-preparation-members-host'
import { createStockPrepMembersPort, type StockPrepMembersQueryFn } from '../../src/services/stock-preparation-members'
import { listUserPermissions as rbacListUserPermissions } from '../../src/rbac/service'

describeDb('S5b members port — fix round 1 guards (real host wiring, real DB)', () => {
  const ENV = 'STOCK_PREP_MEMBERS_PAGE_ENABLED'
  const sfx = randomUUID().replace(/-/g, '').slice(0, 10)
  const ADMIN = `s5bf_admin_${sfx}`
  const DELEGATED = `s5bf_deleg_${sfx}`
  const IN_SCOPE = `s5bf_in_${sfx}`
  const OUT_SCOPE = `s5bf_out_${sfx}`
  const LEGACY_ADMIN = `s5bf_legacy_${sfx}`
  const SUB_ADMIN = `s5bf_sub_${sfx}`
  const USERS = [ADMIN, DELEGATED, IN_SCOPE, OUT_SCOPE, LEGACY_ADMIN, SUB_ADMIN]
  const MAIN = 'stock-prep_admin'
  const SUB_ROLE = `stock-prep_x${sfx}_admin`
  const MTW_ROLE = `s5bf_mtw_${sfx}`
  const LOCKED = `stock-prep_c_${sfx.slice(0, 8)}`
  const BASE = `s5bf_base_${sfx}`
  const SHEET = `s5bf_sheet_${sfx}`
  const SHEET_GLOBAL = `s5bf_sheet_g_${sfx}`
  let pool: Pool
  let previousEnv: string | undefined
  let createdAdminRole = false
  let createdMainRole = false
  let createdMainCode = false
  let groupId = ''
  const createdRoleIds: string[] = [SUB_ROLE, MTW_ROLE, LOCKED]
  const port = () => createStockPrepMembersPort(createStockPrepMembersHostDeps())

  const roleCodes = async (roleId: string) => (await pool.query(
    'SELECT permission_code FROM role_permissions WHERE role_id = $1 ORDER BY permission_code', [roleId],
  )).rows.map((row: { permission_code: string }) => row.permission_code)
  const refusal = async (promise: Promise<unknown>) => {
    try {
      await promise
    } catch (error) {
      return error as { status: number; code: string }
    }
    throw new Error('expected a refusal')
  }
  const customRoleCount = async () => Number((await pool.query("SELECT COUNT(*)::int AS n FROM roles WHERE id LIKE 'stock-prep\\_c\\_%' ESCAPE '\\'")).rows[0].n)
  const g1 = (roleId: string, sheetId: string, calls: string[]) => async () => {
    calls.push(sheetId)
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const cq = async (sql: string, params?: unknown[]) => {
        const r = await client.query(sql, params as unknown[])
        return { rows: r.rows as unknown[], rowCount: r.rowCount }
      }
      const result = await grantStockPreparationProjectSheetRoleWrite(cq, { sheetId, roleIds: [roleId], actorId: 'actor' })
      await client.query('COMMIT')
      return { granted: result.granted.length > 0 }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }
  const roleRowsOn = async (sheetId: string, roleId: string) => Number((await pool.query(
    "SELECT COUNT(*)::int AS n FROM spreadsheet_permissions WHERE sheet_id = $1 AND subject_type = 'role' AND subject_id = $2", [sheetId, roleId],
  )).rows[0].n)
  const setUserSheetGrant = async (code: string | null) => {
    await pool.query("DELETE FROM spreadsheet_permissions WHERE sheet_id = $1 AND subject_type = 'user' AND subject_id = $2", [SHEET, DELEGATED])
    if (code) await pool.query("INSERT INTO spreadsheet_permissions (sheet_id, user_id, perm_code, subject_type, subject_id) VALUES ($1, $2, $3, 'user', $2)", [SHEET, DELEGATED, code])
  }
  const createRole = async (name: string, codes: string[]) => {
    const created = await port().createCustomRole({ actorId: ADMIN, name, permissionCodes: codes }) as { roleId: string }
    createdRoleIds.push(created.roleId)
    return created.roleId
  }
  /**
   * The real host wiring with two seams: `afterPool` runs after a POOL statement (the fast checks run
   * there) and `aroundTx` after / before a TRANSACTION statement — where "someone else" acts.
   */
  const hookedPort = (hooks: {
    afterPool?: (sql: string) => Promise<void>
    afterTx?: (sql: string) => Promise<void> | void
    beforeTx?: (sql: string) => Promise<void> | void
  }) => {
    const deps = createStockPrepMembersHostDeps()
    const base = deps.query
    return createStockPrepMembersPort({
      ...deps,
      query: async (sql, params) => {
        const result = await base(sql, params)
        if (hooks.afterPool) await hooks.afterPool(sql)
        return result
      },
      transaction: (fn) => deps.transaction((txQuery) => fn((async (sql: string, params?: unknown[]) => {
        if (hooks.beforeTx) await hooks.beforeTx(sql)
        const result = await txQuery(sql, params)
        if (hooks.afterTx) await hooks.afterTx(sql)
        return result
      }) as StockPrepMembersQueryFn)),
    })
  }
  /** A statement on its own connection that may have to WAIT; resolves to 'ok' or the SQLSTATE. */
  const concurrently = (sql: string, params: unknown[]) => {
    let settled = false
    const promise = (async () => {
      const client = await pool.connect()
      try {
        await client.query("SET lock_timeout = '15s'")
        await client.query(sql, params)
        return 'ok'
      } catch (error) {
        return String((error as { code?: unknown }).code ?? 'error')
      } finally {
        await client.query('RESET lock_timeout').catch(() => {})
        client.release()
        settled = true
      }
    })()
    return { promise, settled: () => settled }
  }
  const waitSettled = async (probe: { settled: () => boolean }, ms: number) => {
    const until = Date.now() + ms
    while (Date.now() < until && !probe.settled()) await new Promise((done) => setTimeout(done, 20))
    return probe.settled() ? 'settled' : 'pending'
  }
  const isMemberScan = (sql: string) => sql.startsWith('SELECT user_id FROM user_roles WHERE role_id')

  beforeAll(async () => {
    previousEnv = process.env[ENV]
    process.env[ENV] = 'true'
    pool = new Pool({ connectionString: dbUrl })
    for (const id of USERS) {
      await pool.query('INSERT INTO users (id, password_hash, name, username) VALUES ($1, $2, $3, $4)', [id, 'not-a-hash', `S5bf ${id.split('_')[1]}`, id])
    }
    createdAdminRole = (await pool.query("INSERT INTO roles (id, name) VALUES ('admin', 'admin') ON CONFLICT (id) DO NOTHING RETURNING id")).rows.length > 0
    createdMainRole = (await pool.query('INSERT INTO roles (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id', [MAIN, 'S5bf test main admin'])).rows.length > 0
    createdMainCode = (await pool.query("INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, 'stock-prep:admin') ON CONFLICT DO NOTHING RETURNING role_id", [MAIN])).rows.length > 0
    await pool.query("INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin')", [ADMIN])
    await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [DELEGATED, MAIN])
    // Another `_admin` role inside the namespace, carrying the main code, admitted and scoped (RF-03).
    await pool.query('INSERT INTO roles (id, name) VALUES ($1, $1)', [SUB_ROLE])
    await pool.query("INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, 'stock-prep:admin')", [SUB_ROLE])
    await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [SUB_ADMIN, SUB_ROLE])
    // The legacy platform-admin columns, without the DB admin role (RF-04).
    await pool.query("UPDATE users SET is_admin = true, role = 'admin' WHERE id = $1", [LEGACY_ADMIN])
    for (const userId of [DELEGATED, SUB_ADMIN]) {
      await pool.query("INSERT INTO user_namespace_admissions (user_id, namespace, enabled, source) VALUES ($1, 'stock-prep', true, 'platform_admin')", [userId])
    }
    groupId = (await pool.query('INSERT INTO platform_member_groups (name) VALUES ($1) RETURNING id', [`s5bf group ${sfx}`])).rows[0].id
    await pool.query('INSERT INTO platform_member_group_members (group_id, user_id) VALUES ($1, $2)', [groupId, IN_SCOPE])
    for (const userId of [DELEGATED, SUB_ADMIN]) {
      await pool.query("INSERT INTO delegated_role_admin_member_groups (admin_user_id, namespace, group_id) VALUES ($1, 'stock-prep', $2)", [userId, groupId])
    }
    await pool.query('INSERT INTO roles (id, name) VALUES ($1, $1)', [MTW_ROLE])
    await pool.query('INSERT INTO meta_bases (id, name) VALUES ($1, $2)', [BASE, 's5bf base'])
    for (const sheetId of [SHEET, SHEET_GLOBAL]) {
      await pool.query('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1, $2, $3)', [sheetId, BASE, sheetId])
    }
  })

  afterAll(async () => {
    if (previousEnv === undefined) delete process.env[ENV]
    else process.env[ENV] = previousEnv
    for (const sheetId of [SHEET, SHEET_GLOBAL]) {
      await pool.query('DELETE FROM spreadsheet_permissions WHERE sheet_id = $1', [sheetId]).catch(() => {})
      await pool.query('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [sheetId]).catch(() => {})
      await pool.query('DELETE FROM meta_sheets WHERE id = $1', [sheetId]).catch(() => {})
    }
    await pool.query('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await pool.query('DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [USERS]).catch(() => {})
    await pool.query('DELETE FROM user_roles WHERE role_id = ANY($1::text[])', [createdRoleIds]).catch(() => {})
    await pool.query('DELETE FROM role_permissions WHERE role_id = ANY($1::text[])', [createdRoleIds]).catch(() => {})
    await pool.query('DELETE FROM roles WHERE id = ANY($1::text[])', [createdRoleIds]).catch(() => {})
    if (createdMainCode) await pool.query("DELETE FROM role_permissions WHERE role_id = $1 AND permission_code = 'stock-prep:admin'", [MAIN]).catch(() => {})
    if (createdMainRole) await pool.query('DELETE FROM roles WHERE id = $1', [MAIN]).catch(() => {})
    if (createdAdminRole) await pool.query("DELETE FROM roles WHERE id = 'admin'").catch(() => {})
    await pool.query('DELETE FROM delegated_role_admin_member_groups WHERE admin_user_id = ANY($1::text[])', [USERS]).catch(() => {})
    if (groupId) {
      await pool.query('DELETE FROM platform_member_group_members WHERE group_id = $1', [groupId]).catch(() => {})
      await pool.query('DELETE FROM platform_member_groups WHERE id = $1', [groupId]).catch(() => {})
    }
    await pool.query('DELETE FROM user_namespace_admissions WHERE user_id = ANY($1::text[])', [USERS]).catch(() => {})
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [USERS]).catch(() => {})
    await pool.end()
  })

  it('RF-01 (S2) a delegated admin who can only READ (or write-own) a sheet cannot grant it; write can', async () => {
    const roleId = await createRole('S5bf 甲', ['stock-prep:read'])
    await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [IN_SCOPE, roleId])
    for (const code of [null, 'spreadsheet:read', 'spreadsheet:write-own']) {
      await setUserSheetGrant(code)
      const calls: string[] = []
      const error = await refusal(port().grantCustomRoleProjectSheets({ actorId: DELEGATED, roleId, resolveTargets: async () => [{ sheetId: SHEET, grant: g1(roleId, SHEET, calls) }] }))
      expect([error.status, error.code], String(code)).toEqual([403, 'STOCK_PREP_CUSTOM_ROLE_SHEET_NOT_WRITABLE'])
      expect(calls, String(code)).toEqual([])
      expect(await roleRowsOn(SHEET, roleId)).toBe(0)
    }
    await setUserSheetGrant('spreadsheet:write')
    const calls: string[] = []
    const result = await port().grantCustomRoleProjectSheets({ actorId: DELEGATED, roleId, resolveTargets: async () => [{ sheetId: SHEET, grant: g1(roleId, SHEET, calls) }] })
    expect(result).toEqual({ roleId, sheets: [{ sheetId: SHEET, granted: true }] })
    expect(await roleRowsOn(SHEET, roleId)).toBe(1)
  })

  it('RF-02 (S2, S3) record write without schema management is not enough; a global write code revoked in the database is not honoured from the permission memo', async () => {
    const roleId = createdRoleIds[createdRoleIds.length - 1]
    await pool.query("INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, 'multitable:write')", [MTW_ROLE])
    await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [DELEGATED, MTW_ROLE])
    // S2: the global record-write code alone — no `multitable:manage-schema` — may not hand out
    // `spreadsheet:write`, which carries field / view management on the sheet.
    const recordOnly: string[] = []
    const refusedRecordOnly = await refusal(port().grantCustomRoleProjectSheets({ actorId: DELEGATED, roleId, resolveTargets: async () => [{ sheetId: SHEET_GLOBAL, grant: g1(roleId, SHEET_GLOBAL, recordOnly) }] }))
    expect([refusedRecordOnly.status, refusedRecordOnly.code]).toEqual([403, 'STOCK_PREP_CUSTOM_ROLE_SHEET_NOT_WRITABLE'])
    expect(recordOnly).toEqual([])
    await pool.query("INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, 'multitable:manage-schema')", [MTW_ROLE])
    // Positive control: write + schema management make the assignment-free sheet writable.
    const ok: string[] = []
    await expect(port().grantCustomRoleProjectSheets({ actorId: DELEGATED, roleId, resolveTargets: async () => [{ sheetId: SHEET_GLOBAL, grant: g1(roleId, SHEET_GLOBAL, ok) }] }))
      .resolves.toMatchObject({ sheets: [{ sheetId: SHEET_GLOBAL, granted: true }] })
    // Prime the memo WITH the code, then revoke it in the database only.
    expect(await rbacListUserPermissions(DELEGATED)).toContain('multitable:write')
    await pool.query('DELETE FROM role_permissions WHERE role_id = $1', [MTW_ROLE])
    expect(await rbacListUserPermissions(DELEGATED), 'the memo still holds the revoked code').toContain('multitable:write')
    const calls: string[] = []
    const error = await refusal(port().grantCustomRoleProjectSheets({ actorId: DELEGATED, roleId, resolveTargets: async () => [{ sheetId: SHEET_GLOBAL, grant: g1(roleId, SHEET_GLOBAL, calls) }] }))
    expect([error.status, error.code]).toEqual([403, 'STOCK_PREP_CUSTOM_ROLE_SHEET_NOT_WRITABLE'])
    expect(calls).toEqual([])
    await pool.query('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2', [DELEGATED, MTW_ROLE])
  })

  it('RF-03 (S4) another admitted, scoped _admin role of the namespace is not the main administrator', async () => {
    for (const run of [() => port().describe({ actorId: SUB_ADMIN }), () => port().createCustomRole({ actorId: SUB_ADMIN, name: 'S5bf x', permissionCodes: [] })]) {
      const error = await refusal(run())
      expect([error.status, error.code]).toEqual([403, 'STOCK_PREP_MEMBERS_FORBIDDEN'])
    }
  })

  it('RF-04 (S4) the legacy users.is_admin / users.role columns do not make a platform administrator', async () => {
    const before = await customRoleCount()
    for (const run of [() => port().describe({ actorId: LEGACY_ADMIN }), () => port().createCustomRole({ actorId: LEGACY_ADMIN, name: 'S5bf y', permissionCodes: [] })]) {
      const error = await refusal(run())
      expect([error.status, error.code]).toEqual([403, 'STOCK_PREP_MEMBERS_FORBIDDEN'])
    }
    expect(await customRoleCount()).toBe(before)
  })

  it('RF-05 (S1) a custom-shaped role carrying a platform code is locked: never appointable or editable, every write 409', async () => {
    await pool.query('INSERT INTO roles (id, name) VALUES ($1, $2)', [LOCKED, 'S5bf 看似自定义'])
    await pool.query("INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, 'stock-prep:read'), ($1, 'multitable:write')", [LOCKED])
    await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [IN_SCOPE, LOCKED])
    for (const actorId of [ADMIN, DELEGATED]) {
      const view = await port().describe({ actorId }) as Record<string, any>
      expect(view.customRoles.find((role: any) => role.id === LOCKED), actorId).toMatchObject({ locked: true, foreignCodeCount: 1, otherCodeCount: 1, editable: false, appointable: false })
      const writes = [
        () => port().updateCustomRole({ actorId, roleId: LOCKED, name: 'S5bf 改名' }),
        () => port().updateCustomRole({ actorId, roleId: LOCKED, permissionCodes: ['stock-prep:read'] }),
      ]
      for (const run of writes) {
        const error = await refusal(run())
        expect([error.status, error.code], actorId).toEqual([409, 'STOCK_PREP_CUSTOM_ROLE_HAS_PLATFORM_CODES'])
      }
      const calls: string[] = []
      const grant = await refusal(port().grantCustomRoleProjectSheets({ actorId, roleId: LOCKED, resolveTargets: async () => [{ sheetId: SHEET, grant: g1(LOCKED, SHEET, calls) }] }))
      expect([grant.status, grant.code]).toEqual([409, 'STOCK_PREP_CUSTOM_ROLE_HAS_PLATFORM_CODES'])
      expect(calls).toEqual([])
    }
    expect((await pool.query('SELECT name FROM roles WHERE id = $1', [LOCKED])).rows[0].name).toBe('S5bf 看似自定义')
    expect(await roleCodes(LOCKED)).toEqual(['multitable:write', 'stock-prep:read'])
    expect(await roleRowsOn(SHEET, LOCKED)).toBe(0)
  })

  it('RF-06 (S5) the 100-role cap holds under 6 parallel creates', async () => {
    const before = await customRoleCount()
    expect(before).toBeLessThanOrEqual(98)
    const fillers = Array.from({ length: 98 - before }, () => `stock-prep_c_${randomUUID().replace(/-/g, '').slice(0, 8)}`)
    createdRoleIds.push(...fillers)
    if (fillers.length) await pool.query('INSERT INTO roles (id, name) SELECT x, x FROM unnest($1::text[]) x', [fillers])
    expect(await customRoleCount()).toBe(98)
    const outcomes = await Promise.all(Array.from({ length: 6 }, (_, i) => port().createCustomRole({ actorId: ADMIN, name: `S5bf cap ${i}`, permissionCodes: [] })
      .then((created) => { createdRoleIds.push((created as { roleId: string }).roleId); return 'created' }, (error: { code?: string }) => error.code ?? 'error')))
    expect(outcomes.filter((outcome) => outcome === 'created')).toHaveLength(2)
    expect(outcomes.filter((outcome) => outcome === 'STOCK_PREP_CUSTOM_ROLE_LIMIT')).toHaveLength(4)
    expect(await customRoleCount()).toBe(100)
    await pool.query('DELETE FROM roles WHERE id = ANY($1::text[])', [fillers])
  })

  it('RF-06b (S5) at 99 roles, a create that counted waits for no second count: the advisory lock serialises count → insert', async () => {
    // Deterministic: the first transaction to COUNT (inside its locks) holds there for up to 600 ms,
    // waiting for a second transaction to count too. Under the per-namespace lock the second cannot
    // count until the first commits, so it sees 100 and is refused; without the lock both see 99.
    const before = await customRoleCount()
    const fillers = Array.from({ length: 99 - before }, () => `stock-prep_c_${randomUUID().replace(/-/g, '').slice(0, 8)}`)
    createdRoleIds.push(...fillers)
    if (fillers.length) await pool.query('INSERT INTO roles (id, name) SELECT x, x FROM unnest($1::text[]) x', [fillers])
    expect(await customRoleCount()).toBe(99)
    let counted = 0
    const isCount = (sql: string) => sql.startsWith('SELECT COUNT(*)::int AS c FROM roles WHERE id LIKE')
    const racer = () => hookedPort({
      afterTx: async (sql) => {
        if (!isCount(sql)) return
        counted += 1
        if (counted !== 1) return
        const until = Date.now() + 600
        while (Date.now() < until && counted < 2) await new Promise((done) => setTimeout(done, 20))
      },
    })
    const outcomes = await Promise.all([0, 1].map((i) => racer().createCustomRole({ actorId: ADMIN, name: `S5bf barrier ${i}`, permissionCodes: [] })
      .then((created) => { createdRoleIds.push((created as { roleId: string }).roleId); return 'created' }, (error: { code?: string }) => error.code ?? 'error')))
    expect(outcomes.sort()).toEqual(['STOCK_PREP_CUSTOM_ROLE_LIMIT', 'created'])
    expect(await customRoleCount()).toBe(100)
    await pool.query('DELETE FROM roles WHERE id = ANY($1::text[])', [fillers])
  })

  it('RF-07 (S5) an appointment after the fast scan is seen under the locks; one during the locked transaction waits for its commit', async () => {
    const roleId = await createRole('S5bf 乙', ['stock-prep:read'])
    await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [IN_SCOPE, roleId])
    // (a) between the fast scan and the transaction: the scan under the locks sees the new member.
    let fired = false
    const racedBefore = hookedPort({
      afterPool: async (sql) => {
        if (fired || !isMemberScan(sql)) return
        fired = true
        await pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [OUT_SCOPE, roleId])
      },
    })
    const error = await refusal(racedBefore.updateCustomRole({ actorId: DELEGATED, roleId, permissionCodes: ['stock-prep:read', 'stock-prep:operate'] }))
    expect(fired).toBe(true)
    expect([error.status, error.code]).toEqual([403, 'STOCK_PREP_CUSTOM_ROLE_MEMBERS_OUT_OF_SCOPE'])
    expect(await roleCodes(roleId)).toEqual(['stock-prep:read'])
    await pool.query('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2', [OUT_SCOPE, roleId])
    // (b) during the locked transaction: the appointment cannot commit before this one does.
    let appointment: ReturnType<typeof concurrently> | null = null
    let observed = ''
    const racedDuring = hookedPort({
      afterTx: (sql) => {
        if (appointment || !isMemberScan(sql)) return
        appointment = concurrently('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [OUT_SCOPE, roleId])
      },
      beforeTx: async (sql) => {
        if (!appointment || observed || !sql.startsWith('UPDATE roles SET name')) return
        observed = await waitSettled(appointment, 400)
      },
    })
    await expect(racedDuring.updateCustomRole({ actorId: DELEGATED, roleId, permissionCodes: ['stock-prep:read', 'stock-prep:operate'] })).resolves.toMatchObject({ added: ['stock-prep:operate'] })
    expect(observed, 'the appointment waited for the locked transaction').toBe('pending')
    expect(await appointment!.promise).toBe('ok')
    expect(await roleCodes(roleId)).toEqual(['stock-prep:operate', 'stock-prep:read'])
    await pool.query('DELETE FROM user_roles WHERE user_id = $1 AND role_id = $2', [OUT_SCOPE, roleId])
  })

  it('RF-08 (S5) the grantor\'s admission revoked after the fast check is seen under the locks; one revoked during the transaction waits for its commit', async () => {
    const roleId = createdRoleIds[createdRoleIds.length - 1]
    const revokeSql = "UPDATE user_namespace_admissions SET enabled = $2 WHERE user_id = $1 AND namespace = 'stock-prep'"
    try {
      // (a) between the fast checks and the transaction.
      let fired = false
      const racedBefore = hookedPort({
        afterPool: async (sql) => {
          if (fired || !isMemberScan(sql)) return
          fired = true
          await pool.query(revokeSql, [DELEGATED, false])
        },
      })
      const error = await refusal(racedBefore.updateCustomRole({ actorId: DELEGATED, roleId, permissionCodes: ['stock-prep:read'] }))
      expect(fired).toBe(true)
      expect([error.status, error.code]).toEqual([403, 'STOCK_PREP_MEMBERS_FORBIDDEN'])
      expect(await roleCodes(roleId)).toEqual(['stock-prep:operate', 'stock-prep:read'])
      await pool.query(revokeSql, [DELEGATED, true])
      // (b) during the locked transaction.
      let revoke: ReturnType<typeof concurrently> | null = null
      let observed = ''
      const racedDuring = hookedPort({
        afterTx: (sql) => {
          if (revoke || !isMemberScan(sql)) return
          revoke = concurrently(revokeSql, [DELEGATED, false])
        },
        beforeTx: async (sql) => {
          if (!revoke || observed || !sql.startsWith('UPDATE roles SET name')) return
          observed = await waitSettled(revoke, 400)
        },
      })
      await expect(racedDuring.updateCustomRole({ actorId: DELEGATED, roleId, permissionCodes: ['stock-prep:read'] })).resolves.toMatchObject({ removed: ['stock-prep:operate'] })
      expect(observed, 'the revoke waited for the locked transaction').toBe('pending')
      expect(await revoke!.promise).toBe('ok')
    } finally {
      await pool.query(revokeSql, [DELEGATED, true])
    }
  })
})
