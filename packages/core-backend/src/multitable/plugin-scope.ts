import type {
  MultitableAPI,
  MultitableRecordsWriteUnitOfWorkAPI,
  MultitableRepairTransactionSurface,
  StockPreparationPersistUnitOfWorkInput,
} from '../types/plugin'
import { validateStockPreparationPersistUnitOfWorkInput } from './stock-preparation-persist-unit-of-work'
import {
  StockPreparationProjectSheetGrantError,
  isStockPreparationProjectSheetObjectId,
  normalizeStockPreparationGrantRoleIds,
} from './stock-preparation-project-sheet-grant-contract'
import {
  STOCK_PREPARATION_OVERVIEW_PORT_PLUGIN,
  STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID,
  STOCK_PREPARATION_PROJECT_OVERVIEW_SYSTEM_KIND,
  StockPreparationOverviewRecordsWriteError,
  StockPreparationOverviewStructureWriteError,
  StockPreparationOverviewSystemKindError,
  isStockPreparationOverviewSheetIdCandidate,
} from './stock-preparation-overview-contract'
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
  /**
   * G1 (R-35): the STRICT sheet-ownership assertion the grant port runs — throws unless the plugin
   * object registry records this sheet as THIS plugin's. Unlike `assertSheetScope` it has no
   * `observe` tolerance: an unregistered sheet is a refusal in every deployment mode, because a
   * grant is an authorization write and "nobody has claimed this sheet" must never admit one.
   */
  assertSheetOwnedByPlugin?: (input: AssertPluginSheetScopeInput) => Promise<void>
  assertSheetScope?: (
    input: AssertPluginSheetScopeInput,
  ) => Promise<void | AssertPluginSheetScopeOutcome>
  isSheetOwnedByProject?: (input: { sheetId: string; projectId: string }) => Promise<boolean>
  /**
   * S3 fix round 2 (F3; register R-37): does the host's `meta_sheets.system_kind` say this sheet is the
   * read-only stock-preparation project overview? Asked only for ids of the host-derived shape (no other id can
   * be the overview). Missing → every derived-shape GENERIC record write is refused as `unverifiable`, and the
   * overview port refuses too: an un-wired host never guesses "not the overview".
   */
  isStockPreparationOverviewSheet?: (input: { sheetId: string }) => Promise<boolean>
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

// B3: same shape as the projectId namespace refusal, for a system-base id outside the plugin's prefix.
export class MultitableBaseScopeError extends Error {
  code = 'MULTITABLE_BASE_SCOPE_FORBIDDEN'

  constructor(pluginName: string, baseId: string) {
    super(`Plugin ${pluginName} cannot access multitable baseId ${baseId}`)
    this.name = 'MultitableBaseScopeError'
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

/**
 * B3 — the plugin system-base PREFIX RULE. Computed directly from the plugin name, with NO
 * sanitising: the slug is the name minus a leading `plugin-`, and it must match
 * `PLUGIN_BASE_SLUG_PATTERN` exactly or the plugin has no system-base surface at all (null) —
 * never a trimmed or lower-cased one. Because the slug cannot contain `_`, the prefix ends at
 * the first `_` after `base_`, which makes the rule injective on its accepted domain:
 * `base_integration_x` does not start with `base_integration-core_`, and `base_a_...` is not
 * under `base_a-b_`. `attendance` and `plugin-attendance` share `base_attendance_` by design —
 * exactly the aliasing `getPluginProjectNamespaces` already applies to projectId namespaces.
 */
export const PLUGIN_BASE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/

export function getPluginBaseSlug(pluginName: string): string | null {
  const raw = typeof pluginName === 'string' ? pluginName.trim() : ''
  const slug = raw.startsWith('plugin-') ? raw.slice('plugin-'.length) : raw
  return PLUGIN_BASE_SLUG_PATTERN.test(slug) ? slug : null
}

export function getPluginBaseIdPrefix(pluginName: string): string | null {
  const slug = getPluginBaseSlug(pluginName)
  return slug ? `base_${slug}_` : null
}

/** Pure string rule, no I/O: a system-base id must sit strictly under the plugin's own prefix. */
export function assertBaseIdAllowedForPlugin(pluginName: string, baseId: string): void {
  const prefix = getPluginBaseIdPrefix(pluginName)
  if (!prefix) {
    throw new MultitableBaseScopeError(pluginName, String(baseId))
  }
  if (typeof baseId !== 'string' || baseId.trim().length === 0) {
    throw new MultitableBaseScopeError(pluginName, String(baseId))
  }
  if (!baseId.startsWith(prefix) || baseId.length === prefix.length) {
    throw new MultitableBaseScopeError(pluginName, baseId)
  }
}

/**
 * B3 — the RESERVATION half of the same rule, for the user-facing `POST /bases` route: does this
 * caller-chosen id look like a plugin system-base id (`base_<slug>_<rest>`)? Server-minted ids
 * (`base_<uuid>`, no second `_`) and `base_legacy` never match; `base_attendance_catalog` and
 * `base_integration-core_sp_...` do. One rule, two enforcement points, no shared mutable state.
 */
export const PLUGIN_SYSTEM_BASE_ID_PATTERN = /^base_[a-z0-9][a-z0-9-]*_[A-Za-z0-9_-]+$/

export function isPluginSystemBaseIdCandidate(baseId: string): boolean {
  return typeof baseId === 'string' && PLUGIN_SYSTEM_BASE_ID_PATTERN.test(baseId)
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

/**
 * R5 (S1 fix round 1): the ONE plugin whose scoped api carries the G1 grant port. Mirrors how
 * index.ts hands `stockPreparationFieldPermissions` / `dataSources` to `plugin-integration-core`
 * alone: a port that writes authorization rows is a capability boundary, not a type description,
 * so every other plugin's scoped api simply has no `grantSheetRoleWrite` (undefined, never a throw).
 */
const STOCK_PREPARATION_PROJECT_SHEET_GRANT_PORT_PLUGIN = 'plugin-integration-core'

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

  /**
   * S3 fix round 2 (F3; register R-37): the GENERIC record writes below never write the read-only
   * stock-preparation project overview — for ANY plugin, including the overview's own plugin, whose
   * pipelines / multitable target adapter take their sheet id from external-system config. Only an id of the
   * host-derived shape can be the overview (no statement for any other id); for one, the host's stamp decides,
   * and a host that cannot answer is refused as `unverifiable`. The overview is written only through the
   * `records.stockPreparationOverview` port (plugin-integration-core only, below).
   */
  const refuseGenericOverviewRecordWrite = async (sheetId: unknown): Promise<void> => {
    if (!isStockPreparationOverviewSheetIdCandidate(sheetId)) return
    if (!hooks.isStockPreparationOverviewSheet) throw new StockPreparationOverviewRecordsWriteError('unverifiable')
    if ((await hooks.isStockPreparationOverviewSheet({ sheetId })) !== false) {
      throw new StockPreparationOverviewRecordsWriteError('generic_write')
    }
  }

  /**
   * S3 follow-up E (register R-37): the overview's STRUCTURE (columns, field properties, display names, views)
   * is written only by the overview module's own provisioning — `ensureObject` with the overview `systemKind`
   * (the gate below) and, right after it, `ensureView` with the same marker. Every object-keyed structural write
   * naming the overview OBJECT is refused here, before any hook or host call (a pure check: the overview object id
   * is only ever provisioned stamped, so nothing legitimate reaches these methods with it). This closes the
   * config-driven paths (field-option sync, customer-pack install, additive repair) whose objectId is not the
   * overview module's.
   */
  const refuseOverviewObjectStructureWrite = (objectId: unknown): void => {
    if (objectId === STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID) {
      throw new StockPreparationOverviewStructureWriteError('structure_write')
    }
  }

  /**
   * S3 follow-up E: `ensureView` names a SHEET, not an object. A view on the STAMPED overview is admitted only as the
   * overview module's provisioning step: the port plugin, the overview `systemKind` marker, and the sheet id derived
   * for (projectId, the overview object) — all pure checks. Without the marker, a derived-shape id is looked up (the
   * host's stamp decides; a host that cannot answer is `unverifiable`); an id of any other shape is never the overview
   * and costs no statement. A marker on anything but this project's derived overview sheet is refused like the
   * `ensureObject` gate refuses a misused kind.
   */
  const refuseOverviewViewStructureWrite = async (input: { projectId: string; sheetId: unknown; systemKind: unknown }): Promise<void> => {
    const { projectId, sheetId, systemKind } = input
    if (systemKind !== undefined && systemKind !== null) {
      if (pluginName !== STOCK_PREPARATION_OVERVIEW_PORT_PLUGIN) throw new StockPreparationOverviewSystemKindError('plugin')
      if (systemKind !== STOCK_PREPARATION_PROJECT_OVERVIEW_SYSTEM_KIND) throw new StockPreparationOverviewSystemKindError('kind')
      if (sheetId !== multitable.provisioning.getObjectSheetId(projectId, STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID)) {
        throw new StockPreparationOverviewSystemKindError('object')
      }
      return
    }
    if (!isStockPreparationOverviewSheetIdCandidate(sheetId)) return
    if (!hooks.isStockPreparationOverviewSheet) throw new StockPreparationOverviewStructureWriteError('unverifiable')
    if ((await hooks.isStockPreparationOverviewSheet({ sheetId })) !== false) {
      throw new StockPreparationOverviewStructureWriteError('structure_write')
    }
  }

  /**
   * S3 fix round 2 (F3): the overview port's ONE target. The caller names a PROJECT, never a sheet: the id is
   * derived here for that (namespace-checked) project, must have the derived shape, must be registered to THIS
   * plugin (the strict hook, no `observe` tolerance) and must carry the host's overview stamp — every write
   * re-checks, so a sheet the stamp left (or never had) is never written through the port.
   */
  const resolveOverviewRecordsSheet = async (projectId: unknown): Promise<string> => {
    if (typeof projectId !== 'string') throw new MultitableProjectNamespaceError(pluginName, String(projectId))
    assertProjectIdAllowedForPlugin(pluginName, projectId)
    const sheetId = multitable.provisioning.getObjectSheetId(projectId, STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID)
    if (!isStockPreparationOverviewSheetIdCandidate(sheetId)) throw new StockPreparationOverviewRecordsWriteError('not_overview')
    if (!hooks.assertSheetOwnedByPlugin || !hooks.isStockPreparationOverviewSheet) {
      throw new StockPreparationOverviewRecordsWriteError('unverifiable')
    }
    await hooks.assertSheetOwnedByPlugin({ pluginName, sheetId })
    if ((await hooks.isStockPreparationOverviewSheet({ sheetId })) !== true) {
      throw new StockPreparationOverviewRecordsWriteError('not_overview')
    }
    return sheetId
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
      // S3 fix round 1 (R8c): the host's declaration that it stamps a requested `systemKind` at INSERT and
      // reports it back. A boolean about the HOST, not about any object — forwarded as-is (only `true`
      // counts), so a plugin can fail closed BEFORE any write on a host that would create an ordinary,
      // writable sheet where a read-only one was meant.
      ...(multitable.provisioning?.supportsSystemKindStamp === true ? { supportsSystemKindStamp: true } : {}),
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
        // S3 follow-up E: never a column onto the read-only overview (pure, before any IO).
        refuseOverviewObjectStructureWrite(input.objectId)
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
        // S3 follow-up E: the overview's views are its own provisioning's (pure, before any IO).
        refuseOverviewObjectStructureWrite(input.objectId)
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
              // S3 follow-up E: never a column onto the read-only overview, inside the repair transaction too.
              refuseOverviewObjectStructureWrite(input.objectId)
              await hooks.assertObjectScope?.({ pluginName, projectId: input.projectId, objectId: input.objectId })
              return surface.ensureMissingObjectFields(input)
            },
          }
          return fn(scoped)
        })
      },
      // B3: exposed iff the host exposes it (the `ensureObjectDefaultView` / `findObjectView`
      // optional-capability idiom), so a plugin's feature detection stays truthful. The wrapper
      // adds exactly one thing — the prefix assertion — and delegates. Read defensively at build
      // time for the same reason `supportsFilterValueLists` below is. The baseId is read ONCE and
      // the checked value is what the delegate receives: forwarding `input` itself would let a
      // getter hand the prefix check one id and the host another (refuter r2 minor).
      ...(typeof multitable.provisioning?.ensureSystemBase === 'function'
        ? {
            ensureSystemBase: async (input: { baseId: string; name: string }) => {
              const baseId = input.baseId
              assertBaseIdAllowedForPlugin(pluginName, baseId)
              return multitable.provisioning.ensureSystemBase!({ baseId, name: input.name })
            },
          }
        : {}),
      // Display-name relabel — a WRITE against the plugin's own object, so it takes the same two
      // assertions every other object write here takes (project namespace, then object scope) and is
      // never bare-forwarded. Exposed iff the host exposes it (the optional-capability idiom above).
      // projectId/objectId are read ONCE and the checked values are what the host receives, so a
      // getter cannot show the scope checks one object and the host another.
      ...(typeof multitable.provisioning?.relabelObjectDisplayNames === 'function'
        ? {
            relabelObjectDisplayNames: async (
              input: Parameters<NonNullable<MultitableAPI['provisioning']['relabelObjectDisplayNames']>>[0],
            ) => {
              const projectId = input.projectId
              const objectId = input.objectId
              assertProjectIdAllowedForPlugin(pluginName, projectId)
              // S3 follow-up E: the overview's display names are its own provisioning's (pure, before any IO).
              refuseOverviewObjectStructureWrite(objectId)
              await hooks.assertObjectScope?.({ pluginName, projectId, objectId })
              return multitable.provisioning.relabelObjectDisplayNames!({
                projectId,
                objectId,
                sheetName: input.sheetName,
                fields: input.fields,
                takenSheetNames: input.takenSheetNames,
                apply: input.apply,
                expectedPlanDigest: input.expectedPlanDigest,
                actorId: input.actorId,
              })
            },
          }
        : {}),
      // G1 (R-35): the project-sheet role grant — an AUTHORIZATION write, so it takes MORE than the
      // two assertions every other write here takes. Exposed iff the host exposes it (the optional-
      // capability idiom above) AND the plugin is `plugin-integration-core` (R5: the same least-
      // privilege posture index.ts applies to the field-permissions port — every other plugin gets
      // no port at all, `undefined`, and so cannot even ask). Every value is read ONCE and the
      // checked values are what the host receives. Order, each refusing before the next does any IO:
      //   1. project namespace (pure);
      //   2. the role list is well-formed and entirely inside the `stock-prep` namespace (pure);
      //   3. the objectId has the project-sheet shape (pure) — the canonical main table and a
      //      hand-named sandbox twin are refused here;
      //   4. the sheet id IS the one derived for (projectId, objectId) (pure) — so a caller cannot
      //      pair a project-shaped objectId with some other sheet's id;
      //   5. the registry records the sheet as THIS plugin's (strict hook — no `observe` tolerance;
      //      a host that does not provide the hook cannot verify ownership and the port refuses);
      //   6. the registry records the sheet as THIS project's (the same boolean port the tenant
      //      wall uses, never an owner id).
      ...(typeof multitable.provisioning?.grantSheetRoleWrite === 'function'
        && pluginName === STOCK_PREPARATION_PROJECT_SHEET_GRANT_PORT_PLUGIN
        ? {
            grantSheetRoleWrite: async (input: {
              projectId: string
              sheetId: string
              objectId: string
              roleIds: string[]
              actorId?: string | null
            }) => {
              const projectId = input.projectId
              const sheetId = input.sheetId
              const objectId = input.objectId
              assertProjectIdAllowedForPlugin(pluginName, projectId)
              const roleIds = normalizeStockPreparationGrantRoleIds(input.roleIds)
              if (!isStockPreparationProjectSheetObjectId(objectId)) {
                throw new StockPreparationProjectSheetGrantError(
                  422,
                  'STOCK_PREP_PROJECT_SHEET_GRANT_OBJECT_NOT_PROJECT_SHEET',
                  'a project-sheet grant may target only a per-project stock-preparation sheet',
                  { objectId: String(objectId) },
                )
              }
              if (typeof sheetId !== 'string' || sheetId.trim().length === 0
                || multitable.provisioning.getObjectSheetId(projectId, objectId) !== sheetId) {
                throw new StockPreparationProjectSheetGrantError(
                  422,
                  'STOCK_PREP_PROJECT_SHEET_GRANT_SHEET_MISMATCH',
                  'the sheet is not the one derived for this project and objectId',
                  { objectId },
                )
              }
              if (!hooks.assertSheetOwnedByPlugin) {
                throw new MultitableSheetScopeError(pluginName, sheetId, 'unverifiable')
              }
              await hooks.assertSheetOwnedByPlugin({ pluginName, sheetId })
              const ownedByProject = hooks.isSheetOwnedByProject
                ? await hooks.isSheetOwnedByProject({ sheetId, projectId })
                : await multitable.provisioning.isSheetOwnedByProject(sheetId, projectId)
              if (ownedByProject !== true) {
                throw new MultitableSheetScopeError(pluginName, sheetId, 'other_project')
              }
              return multitable.provisioning.grantSheetRoleWrite!({
                projectId,
                sheetId,
                objectId,
                roleIds,
                actorId: typeof input.actorId === 'string' && input.actorId.trim() ? input.actorId.trim() : null,
              })
            },
          }
        : {}),
      // S3 fix round 1 (R1): G1 for the PROJECT OVERVIEW — the configured roles get READ on the overview
      // sheet. The same least-privilege posture and the same order as `grantSheetRoleWrite` above, each
      // step refusing before the next does any IO; the one difference is WHICH object: only the overview
      // object id is admitted (a project sheet, the main table or any other object is refused here, and the
      // host re-checks the sheet's `stock_prep_overview` kind inside its write transaction). The level is
      // the host's literal `spreadsheet:read`; nothing here can ask for more.
      ...(typeof multitable.provisioning?.grantOverviewRoleRead === 'function'
        && pluginName === STOCK_PREPARATION_PROJECT_SHEET_GRANT_PORT_PLUGIN
        ? {
            grantOverviewRoleRead: async (input: {
              projectId: string
              sheetId: string
              objectId: string
              roleIds: string[]
              actorId?: string | null
            }) => {
              const projectId = input.projectId
              const sheetId = input.sheetId
              const objectId = input.objectId
              assertProjectIdAllowedForPlugin(pluginName, projectId)
              const roleIds = normalizeStockPreparationGrantRoleIds(input.roleIds)
              if (objectId !== STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID) {
                throw new StockPreparationProjectSheetGrantError(
                  422,
                  'STOCK_PREP_OVERVIEW_GRANT_OBJECT_NOT_OVERVIEW',
                  'an overview read grant may target only the stock-preparation project overview object',
                  { field: 'objectId' },
                )
              }
              if (typeof sheetId !== 'string' || sheetId.trim().length === 0
                || multitable.provisioning.getObjectSheetId(projectId, objectId) !== sheetId) {
                throw new StockPreparationProjectSheetGrantError(
                  422,
                  'STOCK_PREP_PROJECT_SHEET_GRANT_SHEET_MISMATCH',
                  'the sheet is not the one derived for this project and objectId',
                  { objectId },
                )
              }
              if (!hooks.assertSheetOwnedByPlugin) {
                throw new MultitableSheetScopeError(pluginName, sheetId, 'unverifiable')
              }
              await hooks.assertSheetOwnedByPlugin({ pluginName, sheetId })
              const ownedByProject = hooks.isSheetOwnedByProject
                ? await hooks.isSheetOwnedByProject({ sheetId, projectId })
                : await multitable.provisioning.isSheetOwnedByProject(sheetId, projectId)
              if (ownedByProject !== true) {
                throw new MultitableSheetScopeError(pluginName, sheetId, 'other_project')
              }
              return multitable.provisioning.grantOverviewRoleRead!({
                projectId,
                sheetId,
                objectId,
                roleIds,
                actorId: typeof input.actorId === 'string' && input.actorId.trim() ? input.actorId.trim() : null,
              })
            },
          }
        : {}),
      // S3 (ADR adr-stock-prep-project-sheets-20261008 §5, Q5): `systemKind` is a HOST-OWNED stamp — the
      // server-owned `meta_sheets.system_kind` that makes a sheet a system sheet (undeletable, clamped to
      // read/export for every person). A plugin may ask for it in exactly one case, checked here BEFORE any
      // hook or host call: the plugin is `plugin-integration-core` (the G1 port's least-privilege posture),
      // the kind is the overview kind, and the descriptor is the overview object. Anything else that names a
      // kind is 403 MULTITABLE_SYSTEM_KIND_FORBIDDEN with nothing written. Each value is read ONCE and the
      // checked values are what the hook / host receive (a getter cannot show the gate one object and the
      // host another). A call without `systemKind` takes the pre-S3 path unchanged.
      ensureObject: async (input) => {
        assertProjectIdAllowedForPlugin(pluginName, input.projectId)
        let forwarded = input
        const systemKind = input.systemKind
        // S3 follow-up E: the overview object is only ever provisioned STAMPED. An ensure of it without the kind
        // (which would create an ordinary sheet at its id, or add columns to the stamped one) is refused here,
        // pure, before any hook or host call; the stamped ensure takes the gate below.
        if ((systemKind === undefined || systemKind === null) && input.descriptor?.id === STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID) {
          throw new StockPreparationOverviewStructureWriteError('structure_write')
        }
        if (systemKind !== undefined && systemKind !== null) {
          const projectId = input.projectId
          const descriptor = input.descriptor
          const objectId = descriptor?.id
          if (pluginName !== STOCK_PREPARATION_OVERVIEW_PORT_PLUGIN) {
            throw new StockPreparationOverviewSystemKindError('plugin')
          }
          if (systemKind !== STOCK_PREPARATION_PROJECT_OVERVIEW_SYSTEM_KIND) {
            throw new StockPreparationOverviewSystemKindError('kind')
          }
          if (objectId !== STOCK_PREPARATION_PROJECT_OVERVIEW_OBJECT_ID) {
            throw new StockPreparationOverviewSystemKindError('object')
          }
          assertProjectIdAllowedForPlugin(pluginName, projectId)
          forwarded = {
            ...input,
            projectId,
            descriptor: { ...descriptor, id: objectId },
            systemKind,
          }
        }
        if (hooks.ensureObjectInScope) {
          return hooks.ensureObjectInScope({
            pluginName,
            ...forwarded,
          })
        }
        await hooks.assertObjectScope?.({
          pluginName,
          projectId: forwarded.projectId,
          objectId: forwarded.descriptor.id,
        })
        const result = await multitable.provisioning.ensureObject(forwarded)
        await hooks.claimObjectScope?.({
          pluginName,
          projectId: forwarded.projectId,
          objectId: forwarded.descriptor.id,
          sheetId: result.sheet.id,
        })
        return result
      },
      // S3 follow-up E: each value is read ONCE; the overview check runs before the scope hook and the host, and the
      // `systemKind` marker (the overview module's) is never forwarded — the host's ensureView takes no kind.
      ensureView: async (input) => {
        const projectId = input.projectId
        const sheetId = input.sheetId
        const descriptor = input.descriptor
        assertProjectIdAllowedForPlugin(pluginName, projectId)
        await refuseOverviewViewStructureWrite({ projectId, sheetId, systemKind: input.systemKind })
        await hooks.assertSheetScope?.({ pluginName, sheetId })
        return multitable.provisioning.ensureView({ projectId, sheetId, descriptor })
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
        // S3 follow-up E: never a field property change on the read-only overview (pure, before any IO).
        refuseOverviewObjectStructureWrite(input.objectId)
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
      // S3 fix round 2 (F3): the three generic WRITES read `sheetId` ONCE, assert scope on it, refuse the
      // stock-preparation overview on it, and forward exactly that value (a getter cannot show the checks one
      // sheet and the host another).
      createRecord: async (input) => {
        const sheetId = input.sheetId
        await assertSheetScopeOnce(sheetId)
        await refuseGenericOverviewRecordWrite(sheetId)
        return multitable.records.createRecord({ ...input, sheetId })
      },
      getRecord: async (input) => {
        await assertSheetScopeOnce(input.sheetId)
        return multitable.records.getRecord(input)
      },
      patchRecord: async (input) => {
        const sheetId = input.sheetId
        await assertSheetScopeOnce(sheetId)
        await refuseGenericOverviewRecordWrite(sheetId)
        return multitable.records.patchRecord({ ...input, sheetId })
      },
      deleteRecord: async (input) => {
        const sheetId = input.sheetId
        await assertSheetScopeOnce(sheetId)
        await refuseGenericOverviewRecordWrite(sheetId)
        return multitable.records.deleteRecord({ ...input, sheetId })
      },
      // S3 fix round 2 (F3): read-only — would a generic write to this (own) sheet be refused as a read-only
      // system sheet? Same scope assertion as a read; a non-string id is simply not one.
      isReadOnlySystemSheet: async (input) => {
        const sheetId = input?.sheetId
        if (typeof sheetId !== 'string') return false
        await assertSheetScopeOnce(sheetId)
        if (!isStockPreparationOverviewSheetIdCandidate(sheetId)) return false
        if (!hooks.isStockPreparationOverviewSheet) return true
        return (await hooks.isStockPreparationOverviewSheet({ sheetId })) !== false
      },
      // S3 fix round 2 (F3): THE overview write port — plugin-integration-core only. Takes a PROJECT id; the
      // sheet is derived and re-checked (ownership + stamp) on every write by `resolveOverviewRecordsSheet`.
      ...(pluginName === STOCK_PREPARATION_OVERVIEW_PORT_PLUGIN
        ? {
            stockPreparationOverview: {
              createRecord: async (input: { projectId: string; data: Record<string, unknown> }) => {
                const sheetId = await resolveOverviewRecordsSheet(input?.projectId)
                return multitable.records.createRecord({ sheetId, data: input.data })
              },
              patchRecord: async (input: { projectId: string; recordId: string; changes: Record<string, unknown>; expectedVersion?: number }) => {
                const sheetId = await resolveOverviewRecordsSheet(input?.projectId)
                return multitable.records.patchRecord({
                  sheetId,
                  recordId: input.recordId,
                  changes: input.changes,
                  ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
                })
              },
              deleteRecord: async (input: { projectId: string; recordId: string }) => {
                const sheetId = await resolveOverviewRecordsSheet(input?.projectId)
                return multitable.records.deleteRecord({ sheetId, recordId: input.recordId })
              },
            },
          }
        : {}),
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
        // S3 fix round 2 (F3): the unit of work's create / patch are generic record writes too — no declared
        // sheet may be the stock-preparation overview (refused before the host opens the transaction).
        for (const sheetId of normalized.sheetIds) await refuseGenericOverviewRecordWrite(sheetId)
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
