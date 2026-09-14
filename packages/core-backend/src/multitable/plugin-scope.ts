import type {
  MultitableAPI,
  MultitableRecordsWriteUnitOfWorkAPI,
  MultitableRepairTransactionSurface,
  StockPreparationPersistUnitOfWorkInput,
} from '../types/plugin'
import { validateStockPreparationPersistUnitOfWorkInput } from './stock-preparation-persist-unit-of-work'
import {
  getMultitableRequestMetadataCache,
  runWithMultitableRequestMetadataCache,
} from './request-metadata-cache'

export type MultitableScopeQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export type ClaimPluginObjectScopeInput = {
  pluginName: string
  projectId: string
  objectId: string
  sheetId: string
}

export type AssertPluginSheetScopeInput = {
  pluginName: string
  sheetId: string
}

/**
 * W8-4 (L1). What a host may report back from `assertSheetScope` when it RETURNS (a refusal still
 * throws). `registered: false` means "this sheet has no registry row and the deployment's
 * `MULTITABLE_PLUGIN_SHEET_SCOPE_MODE` is tolerating that" — an outcome that is NOT a pass and must
 * therefore never be memoized, or the P0-S S4 "accessed unregistered sheet" warning would drop from
 * one line per records call to one line per scope. Omitting the value keeps the pre-existing
 * meaning (a plain successful assertion).
 */
export type AssertPluginSheetScopeOutcome = {
  registered?: boolean
}

export type AssertPluginObjectScopeInput = {
  pluginName: string
  projectId: string
  objectId: string
}

export type MultitableScopeHooks = {
  ensureObjectInScope?: (
    input: Parameters<MultitableAPI['provisioning']['ensureObject']>[0] & { pluginName: string }
  ) => ReturnType<MultitableAPI['provisioning']['ensureObject']>
  assertObjectScope?: (input: AssertPluginObjectScopeInput) => Promise<void>
  claimObjectScope?: (input: ClaimPluginObjectScopeInput) => Promise<void>
  assertSheetScope?: (
    input: AssertPluginSheetScopeInput,
  ) => Promise<void | AssertPluginSheetScopeOutcome>
  isSheetOwnedByProject?: (input: { sheetId: string; projectId: string }) => Promise<boolean>
  runStockPreparationPersistUnitOfWork?: <T>(
    input: StockPreparationPersistUnitOfWorkInput & { pluginName: string },
    operation: (records: MultitableRecordsWriteUnitOfWorkAPI) => Promise<T>,
  ) => Promise<T>
}

export class MultitableUnitOfWorkUnavailableError extends Error {
  code = 'MULTITABLE_UNIT_OF_WORK_UNAVAILABLE'

  constructor() {
    super('Required multitable unit-of-work capability is unavailable')
    this.name = 'MultitableUnitOfWorkUnavailableError'
  }
}

export class MultitableUnitOfWorkScopeError extends Error {
  code = 'MULTITABLE_UNIT_OF_WORK_SCOPE_FORBIDDEN'

  constructor() {
    super('Multitable unit-of-work attempted to access an undeclared sheet')
    this.name = 'MultitableUnitOfWorkScopeError'
  }
}

export class MultitableProjectNamespaceError extends Error {
  code = 'MULTITABLE_PROJECT_NAMESPACE_FORBIDDEN'

  constructor(pluginName: string, projectId: string) {
    super(`Plugin ${pluginName} cannot access multitable projectId ${projectId}`)
    this.name = 'MultitableProjectNamespaceError'
  }
}

export class MultitableObjectScopeError extends Error {
  code = 'MULTITABLE_OBJECT_SCOPE_FORBIDDEN'

  constructor(pluginName: string, projectId: string, objectId: string, ownerPluginName: string) {
    super(
      `Plugin ${pluginName} cannot claim multitable object ${projectId}/${objectId}; owned by ${ownerPluginName}`,
    )
    this.name = 'MultitableObjectScopeError'
  }
}

export class MultitableSheetScopeError extends Error {
  code = 'MULTITABLE_SHEET_SCOPE_FORBIDDEN'

  constructor(pluginName: string, sheetId: string, ownerPluginName: string) {
    super(`Plugin ${pluginName} cannot access multitable sheet ${sheetId}; owned by ${ownerPluginName}`)
    this.name = 'MultitableSheetScopeError'
  }
}

export function getPluginProjectNamespaces(pluginName: string): string[] {
  const raw = typeof pluginName === 'string' ? pluginName.trim() : ''
  if (!raw) return []

  const namespaces = new Set<string>([raw])
  if (raw.startsWith('plugin-') && raw.length > 'plugin-'.length) {
    namespaces.add(raw.slice('plugin-'.length))
  }
  return Array.from(namespaces)
}

export function assertProjectIdAllowedForPlugin(pluginName: string, projectId: string): void {
  if (typeof projectId !== 'string' || projectId.trim().length === 0) {
    throw new MultitableProjectNamespaceError(pluginName, String(projectId))
  }

  const suffix = projectId.split(':').pop()?.trim() ?? ''
  const allowedNamespaces = getPluginProjectNamespaces(pluginName)
  if (!suffix || !allowedNamespaces.includes(suffix)) {
    throw new MultitableProjectNamespaceError(pluginName, projectId)
  }
}

export async function claimPluginObjectScope(
  query: MultitableScopeQueryFn,
  input: ClaimPluginObjectScopeInput,
): Promise<void> {
  await query(
    `INSERT INTO plugin_multitable_object_registry (sheet_id, project_id, object_id, plugin_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id, object_id) DO UPDATE SET
       updated_at = now()
     WHERE plugin_multitable_object_registry.sheet_id = EXCLUDED.sheet_id
       AND plugin_multitable_object_registry.plugin_name = EXCLUDED.plugin_name`,
    [input.sheetId, input.projectId, input.objectId, input.pluginName],
  )

  const result = await query(
    `SELECT sheet_id, plugin_name
     FROM plugin_multitable_object_registry
     WHERE project_id = $1 AND object_id = $2`,
    [input.projectId, input.objectId],
  )
  const row = (result.rows as Array<{ sheet_id?: unknown; plugin_name?: unknown }>)[0]
  if (!row) {
    throw new MultitableObjectScopeError(input.pluginName, input.projectId, input.objectId, 'unknown')
  }

  const ownerPluginName = typeof row.plugin_name === 'string' ? row.plugin_name : ''
  const ownedSheetId = typeof row.sheet_id === 'string' ? row.sheet_id : ''
  if (ownerPluginName !== input.pluginName || ownedSheetId !== input.sheetId) {
    throw new MultitableObjectScopeError(
      input.pluginName,
      input.projectId,
      input.objectId,
      ownerPluginName || 'unknown',
    )
  }
}

/**
 * Is `sheetId` registered to `projectId`? A YES/NO question, never "who owns it".
 *
 * The predicate is asked of the DB rather than computed from a returned owner on purpose: see
 * MultitableProvisioningAPI.isSheetOwnedByProject for why returning the owner would leak one
 * tenant's project id to another tenant's caller through a namespace guard that cannot tell them
 * apart. False covers both "owned by another project" and "no registry row" — indistinguishable
 * here, and for a tenancy decision both mean the same thing: not proven yours.
 */
export async function isSheetOwnedByProject(
  query: MultitableScopeQueryFn,
  sheetId: string,
  projectId: string,
): Promise<boolean> {
  const result = await query(
    `SELECT 1
     FROM plugin_multitable_object_registry
     WHERE sheet_id = $1 AND project_id = $2`,
    [sheetId, projectId],
  )
  return (result.rows as unknown[]).length > 0
}

export async function assertPluginOwnsSheet(
  query: MultitableScopeQueryFn,
  input: AssertPluginSheetScopeInput,
): Promise<boolean> {
  const result = await query(
    `SELECT plugin_name
     FROM plugin_multitable_object_registry
     WHERE sheet_id = $1`,
    [input.sheetId],
  )
  const row = (result.rows as Array<{ plugin_name?: unknown }>)[0]
  if (!row) return false

  const ownerPluginName = typeof row.plugin_name === 'string' ? row.plugin_name : ''
  if (ownerPluginName && ownerPluginName !== input.pluginName) {
    throw new MultitableSheetScopeError(input.pluginName, input.sheetId, ownerPluginName)
  }
  return true
}

export async function assertPluginOwnsObject(
  query: MultitableScopeQueryFn,
  input: AssertPluginObjectScopeInput,
): Promise<boolean> {
  const result = await query(
    `SELECT sheet_id, plugin_name
     FROM plugin_multitable_object_registry
     WHERE project_id = $1 AND object_id = $2`,
    [input.projectId, input.objectId],
  )
  const row = (result.rows as Array<{ sheet_id?: unknown; plugin_name?: unknown }>)[0]
  if (!row) return false

  const ownerPluginName = typeof row.plugin_name === 'string' ? row.plugin_name : ''
  if (ownerPluginName && ownerPluginName !== input.pluginName) {
    throw new MultitableObjectScopeError(
      input.pluginName,
      input.projectId,
      input.objectId,
      ownerPluginName,
    )
  }
  return true
}

export function createPluginScopedMultitableApi(
  multitable: MultitableAPI,
  pluginName: string,
  hooks: MultitableScopeHooks = {},
): MultitableAPI {
  /**
   * W8-4 (L1): `assertSheetScope` is a SECURITY hook, so what is memoized here is deliberately
   * narrow — one `(pluginName, sheetId)` pair that ALREADY PASSED AS REGISTERED, for the lifetime
   * of one explicitly opened request scope, and only while the flag is on. Outside a scope this is
   * exactly `await hooks.assertSheetScope?.(...)` on every single call, unchanged.
   *
   * What the memo cannot do: admit a pair that was never asserted. Every records call still runs
   * the hook the first time this scope sees its `(plugin, sheet)` pair, and the key carries both
   * halves, so no plugin inherits another plugin's pass and no sheet inherits another sheet's.
   *
   * What the memo DOES change, stated plainly rather than argued away: it lengthens the ownership
   * re-check interval for an already-passed pair from "every records call" to "once per scope". The
   * scope length is the CALLER's, not this file's — `records.withMetadataCache` below is on the
   * generic plugin API — so the actual bound is the deadline in `request-metadata-cache.ts`
   * (`REQUEST_METADATA_SCOPE_MAX_AGE_MS`), after which the memo stops serving and every call
   * re-asserts. A registry row that flips owner inside that window is caught on the next call after
   * it, not on the next row. Two things are never memoized: a THROW (so a refusal is never sticky)
   * and an `observe`-mode tolerance of an UNREGISTERED sheet (so the P0-S S4 visibility warning
   * still fires once per records call, exactly as before this change).
   */
  const assertSheetScopeOnce = async (sheetId: string): Promise<void> => {
    if (!hooks.assertSheetScope) return
    const cache = getMultitableRequestMetadataCache()
    if (!cache) {
      await hooks.assertSheetScope({ pluginName, sheetId })
      return
    }
    // One scope is shared by every plugin-scoped API built inside it, so the key must carry BOTH
    // halves. JSON of the 2-tuple is injective for any pair of strings — a hand-rolled separator
    // would have to argue that the separator cannot appear in a plugin name or a sheet id, and
    // getting that wrong would let one pair impersonate another.
    const key = JSON.stringify([pluginName, sheetId])
    if (cache.assertedSheetScopes.has(key)) return
    const outcome = await hooks.assertSheetScope({ pluginName, sheetId })
    // `registered === false` is the host saying "no registry row, and this deployment tolerates
    // that" — a WARNING it emits on every call, not a pass. Memoizing it would silently thin the
    // signal P0-S S4 uses to decide whether the registry backfill is complete enough to flip
    // `MULTITABLE_PLUGIN_SHEET_SCOPE_MODE` to `enforce`. A host that reports nothing is treated as
    // registered, which is what every pre-existing implementation and test means.
    if (outcome && outcome.registered === false) return
    cache.assertedSheetScopes.add(key)
  }

  return {
    provisioning: {
      getObjectSheetId: (projectId, objectId) => {
        assertProjectIdAllowedForPlugin(pluginName, projectId)
        return multitable.provisioning.getObjectSheetId(projectId, objectId)
      },
      getFieldId: (projectId, objectId, fieldId) => {
        assertProjectIdAllowedForPlugin(pluginName, projectId)
        return multitable.provisioning.getFieldId(projectId, objectId, fieldId)
      },
      // Pure deterministic id derivation, exactly like the two accessors above: no IO, no view
      // touched, no access granted. It takes the SAME project-namespace assertion they take and,
      // like them, no object-scope check — composing an id for an object the plugin does not own
      // reveals nothing, because every capability that could act on that id checks scope itself.
      getObjectViewId: (projectId, objectId, viewId) => {
        assertProjectIdAllowedForPlugin(pluginName, projectId)
        return multitable.provisioning.getObjectViewId(projectId, objectId, viewId)
      },
      findObjectSheet: async (input) => {
        assertProjectIdAllowedForPlugin(pluginName, input.projectId)
        return multitable.provisioning.findObjectSheet(input)
      },
      // Asks the registry whether a sheet belongs to a project. The namespace guard runs on the
      // ARGUMENT, before any query, exactly as it does for getObjectSheetId/getObjectViewId — the
      // plugin may only ask about projects in its own namespace. Nothing about any other project
      // comes back: the answer is a boolean, so there is no owner id to leak to a caller who should
      // not have it (every tenant of one plugin shares that plugin's namespace, so the guard alone
      // could not have prevented that leak).
      isSheetOwnedByProject: async (sheetId, projectId) => {
        assertProjectIdAllowedForPlugin(pluginName, projectId)
        if (hooks.isSheetOwnedByProject) {
          return hooks.isSheetOwnedByProject({ sheetId, projectId })
        }
        return multitable.provisioning.isSheetOwnedByProject(sheetId, projectId)
      },
      resolveFieldIds: async (input) => {
        assertProjectIdAllowedForPlugin(pluginName, input.projectId)
        return multitable.provisioning.resolveFieldIds(input)
      },
      // W2: DB-backed existence read, scoped to the plugin's own object.
      resolveExistingObjectFieldIds: async (input) => {
        assertProjectIdAllowedForPlugin(pluginName, input.projectId)
        await hooks.assertObjectScope?.({
          pluginName,
          projectId: input.projectId,
          objectId: input.objectId,
        })
        return multitable.provisioning.resolveExistingObjectFieldIds(input)
      },
      // W2: DB-backed field CONTENT read, scoped to the plugin's own object.
      readObjectFieldsContent: async (input) => {
        assertProjectIdAllowedForPlugin(pluginName, input.projectId)
        await hooks.assertObjectScope?.({
          pluginName,
          projectId: input.projectId,
          objectId: input.objectId,
        })
        return multitable.provisioning.readObjectFieldsContent(input)
      },
      // W2: additive-only field write — a WRITE capability, so it must pass the same
      // object-scope check as ensureObject/patchObjectFieldProperty (never bare-forward).
      ensureMissingObjectFields: async (input) => {
        assertProjectIdAllowedForPlugin(pluginName, input.projectId)
        await hooks.assertObjectScope?.({
          pluginName,
          projectId: input.projectId,
          objectId: input.objectId,
        })
        return multitable.provisioning.ensureMissingObjectFields(input)
      },
      // Default-view provisioning — a WRITE capability against the plugin's own object,
      // so it takes exactly the same two assertions as ensureMissingObjectFields:
      // project-namespace, then object scope. Never bare-forwarded.
      ensureObjectDefaultView: async (input) => {
        assertProjectIdAllowedForPlugin(pluginName, input.projectId)
        await hooks.assertObjectScope?.({
          pluginName,
          projectId: input.projectId,
          objectId: input.objectId,
        })
        return multitable.provisioning.ensureObjectDefaultView(input)
      },
      // W2/P2-3: forward the ATOMIC repair transaction, wrapping the tx-bound surface so
      // scope STILL applies INSIDE the transaction. The READ/WRITE methods
      // (resolveExistingObjectFieldIds, readObjectFieldsContent, ensureMissingObjectFields)
      // re-check assertProjectIdAllowedForPlugin + assertObjectScope — a write capability is
      // never bare-forwarded, even inside a host tx. `findObjectSheet` is DISCOVERY-ONLY: it
      // gets the project-namespace check only, NOT object-scope — identical to the non-tx
      // `findObjectSheet` forward above (object ownership is enforced by the subsequent
      // scoped content reads, so a bare findObjectSheet cannot leak object data).
      runObjectFieldsRepairTransaction: async (fn) => {
        return multitable.provisioning.runObjectFieldsRepairTransaction(async (surface) => {
          const scoped: MultitableRepairTransactionSurface = {
            findObjectSheet: async (input) => {
              assertProjectIdAllowedForPlugin(pluginName, input.projectId)
              return surface.findObjectSheet(input)
            },
            resolveExistingObjectFieldIds: async (input) => {
              assertProjectIdAllowedForPlugin(pluginName, input.projectId)
              await hooks.assertObjectScope?.({ pluginName, projectId: input.projectId, objectId: input.objectId })
              return surface.resolveExistingObjectFieldIds(input)
            },
            readObjectFieldsContent: async (input) => {
              assertProjectIdAllowedForPlugin(pluginName, input.projectId)
              await hooks.assertObjectScope?.({ pluginName, projectId: input.projectId, objectId: input.objectId })
              return surface.readObjectFieldsContent(input)
            },
            ensureMissingObjectFields: async (input) => {
              assertProjectIdAllowedForPlugin(pluginName, input.projectId)
              await hooks.assertObjectScope?.({ pluginName, projectId: input.projectId, objectId: input.objectId })
              return surface.ensureMissingObjectFields(input)
            },
          }
          return fn(scoped)
        })
      },
      ensureObject: async (input) => {
        assertProjectIdAllowedForPlugin(pluginName, input.projectId)
        if (hooks.ensureObjectInScope) {
          return hooks.ensureObjectInScope({
            pluginName,
            ...input,
          })
        }
        await hooks.assertObjectScope?.({
          pluginName,
          projectId: input.projectId,
          objectId: input.descriptor.id,
        })
        const result = await multitable.provisioning.ensureObject(input)
        await hooks.claimObjectScope?.({
          pluginName,
          projectId: input.projectId,
          objectId: input.descriptor.id,
          sheetId: result.sheet.id,
        })
        return result
      },
      ensureView: async (input) => {
        assertProjectIdAllowedForPlugin(pluginName, input.projectId)
        await hooks.assertSheetScope?.({ pluginName, sheetId: input.sheetId })
        return multitable.provisioning.ensureView(input)
      },
      // READ-ONLY view existence/content, scoped exactly like the field read below it:
      // project namespace, then object scope. It is strictly NARROWER than the `ensureView`
      // write above — same derived id, no mutation — so it widens no plugin's reach. A host
      // that does not implement it answers null rather than throwing, which is the degrade the
      // optional declaration on the API promises.
      findObjectView: async (input) => {
        assertProjectIdAllowedForPlugin(pluginName, input.projectId)
        await hooks.assertObjectScope?.({
          pluginName,
          projectId: input.projectId,
          objectId: input.objectId,
        })
        if (typeof multitable.provisioning.findObjectView !== 'function') return null
        return multitable.provisioning.findObjectView(input)
      },
      patchObjectFieldProperty: async (input) => {
        assertProjectIdAllowedForPlugin(pluginName, input.projectId)
        await hooks.assertObjectScope?.({
          pluginName,
          projectId: input.projectId,
          objectId: input.objectId,
        })
        return multitable.provisioning.patchObjectFieldProperty(input)
      },
      getObjectField: async (input) => {
        // Read-only, but same project/object scope enforcement as the patch path.
        assertProjectIdAllowedForPlugin(pluginName, input.projectId)
        await hooks.assertObjectScope?.({
          pluginName,
          projectId: input.projectId,
          objectId: input.objectId,
        })
        return multitable.provisioning.getObjectField(input)
      },
    },
    records: {
      /**
       * W8-4 (L1): open ONE request-scoped metadata memo around `operation` (see
       * `request-metadata-cache.ts`). Deliberately NOT a sheet capability: it takes no sheetId,
       * reaches no row, grants nothing, and asserts nothing — every records call made inside it
       * still runs its own scope assertion the first time it sees a `(plugin, sheet)` pair. Its
       * only effect is that a constant re-read inside one call is served from that call's own
       * memory instead of from PostgreSQL. No-op passthrough while the env flag is off.
       *
       * It is on the GENERIC records surface — `createPluginScopedMultitableApi` builds one of
       * these for every plugin — and the env flag is process-wide, so once an operator turns the
       * flag on for the bulk-write path, any plugin can open a scope of any length. That is why the
       * window is capped in `request-metadata-cache.ts` by `REQUEST_METADATA_SCOPE_MAX_AGE_MS`
       * rather than by the convention that a scope equals a chunk: past the cap the memo stops
       * serving and every call re-reads and re-asserts. The caller-visible contract is on
       * `MultitableRecordsAPI.withMetadataCache` in `types/plugin.ts`.
       */
      withMetadataCache: async (operation) => {
        if (typeof operation !== 'function') {
          throw new TypeError('operation must be a function')
        }
        return runWithMultitableRequestMetadataCache(() => operation())
      },
      // W9: FORWARD the wrapped host's array-filter declaration; never assert it. This scope adds
      // an ownership assertion and nothing else — it does not build SQL — so whether a list filter
      // works is entirely a property of `multitable.records` underneath. A host that does not
      // declare it leaves this absent, and the plugin asks one key at a time.
      // Read defensively: unlike every method below, this one is evaluated when the scoped API is
      // BUILT, and callers (tests included) hand in partial `multitable` objects that only populate
      // what they exercise. A missing `records` means "declares nothing", not a crash at wiring time.
      ...(multitable.records?.supportsFilterValueLists === true
        ? { supportsFilterValueLists: true }
        : {}),
      listRecords: async (input) => {
        await assertSheetScopeOnce(input.sheetId)
        return multitable.records.listRecords(input)
      },
      queryRecords: async (input) => {
        await assertSheetScopeOnce(input.sheetId)
        return multitable.records.queryRecords(input)
      },
      createRecord: async (input) => {
        await assertSheetScopeOnce(input.sheetId)
        return multitable.records.createRecord(input)
      },
      getRecord: async (input) => {
        await assertSheetScopeOnce(input.sheetId)
        return multitable.records.getRecord(input)
      },
      patchRecord: async (input) => {
        await assertSheetScopeOnce(input.sheetId)
        return multitable.records.patchRecord(input)
      },
      deleteRecord: async (input) => {
        await assertSheetScopeOnce(input.sheetId)
        return multitable.records.deleteRecord(input)
      },
      runStockPreparationPersistUnitOfWork: async (input, operation) => {
        if (!hooks.runStockPreparationPersistUnitOfWork) {
          throw new MultitableUnitOfWorkUnavailableError()
        }
        if (typeof operation !== 'function') {
          throw new TypeError('operation must be a function')
        }
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw new TypeError('input must be an object')
        }
        // Fail closed on the same validated/trimmed shape the host locks and owns. Building the
        // callback allowlist from raw input.sheetIds would permit a whitespace variant the host
        // never locked (and would refuse the trimmed id the host did lock).
        const normalized = validateStockPreparationPersistUnitOfWorkInput(input)
        const allowedSheetIds = new Set(normalized.sheetIds)
        return hooks.runStockPreparationPersistUnitOfWork(
          { ...normalized, pluginName },
          async (records) => {
            const assertAllowed = (sheetId: string) => {
              if (!allowedSheetIds.has(sheetId)) throw new MultitableUnitOfWorkScopeError()
            }
            const scopedRecords: MultitableRecordsWriteUnitOfWorkAPI = {
              queryRecords: async (recordInput) => {
                assertAllowed(recordInput.sheetId)
                return records.queryRecords(recordInput)
              },
              createRecord: async (recordInput) => {
                assertAllowed(recordInput.sheetId)
                return records.createRecord(recordInput)
              },
              patchRecord: async (recordInput) => {
                assertAllowed(recordInput.sheetId)
                return records.patchRecord(recordInput)
              },
            }
            return operation(scopedRecords)
          },
        )
      },
    },
  }
}
