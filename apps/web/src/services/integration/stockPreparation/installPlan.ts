// BOM备料 INSTALL PAGE — the READ side.
//
// §14 of docs/development/platform-overall-design/multitable-application-model-20260830.md ("安装页
// 展示默认配置,由客户确认") says installing is not filling a form, it is READING THE DEFAULTS AND
// CONFIRMING THEM. The defaults live in exactly one place — `plugins/plugin-integration-core/
// app.manifest.json` — and this module is how the page reads them:
//
//     GET /api/platform/apps/stock-preparation
//
// That is the EXISTING platform app-catalog route; this wave only widened its projection
// (packages/core-backend/src/platform/app-registry.ts) to stop dropping the five manifest sections
// the install page exists to show. No new endpoint, no new write authority, and nothing here can
// mutate anything: the module issues two GETs.
//
// WHY THE MANIFEST AND NOT A LOCAL TABLE. §1: the manifest is the installer's ONLY input, and §11
// records why — the first live deployment had two operators independently INVENT sandbox table
// names, so the declared `objectId` came out of the manifest and the humans stopped naming things.
// A page that retyped those ids would reopen that incident, so nothing below restates a default: it
// is read from the served manifest or it is not shown.
//
// VALUES-FREE. Nothing this module reads can carry a customer business value or a credential:
//   - the manifest projection is a committed JSON file, and names env VARS, never their contents
//     (the backend suite's P-03 pins that the projection never reads `process.env`);
//   - the preflight is the server's own values-free evidence — ids, counts, env KEY names, and a
//     paste-able `fix.run` per blocker.
import { apiFetch } from '../../../utils/api'
import { buildQueryString, type IntegrationApiEnvelope, type IntegrationScope } from '../workbench'

/** The app id. Immutable — it is in code, routes and documents (§11's identity layer 1). */
export const STOCK_PREPARATION_APP_ID = 'stock-preparation'

/** The catalog route that serves the manifest. Stated once so the view can show it. */
export const STOCK_PREPARATION_MANIFEST_ROUTE = `/api/platform/apps/${STOCK_PREPARATION_APP_ID}`

/** The preflight route (#5345). Read tier: values-free evidence + fixes, zero provisioning. */
export const STOCK_PREPARATION_PREFLIGHT_ROUTE = '/api/integration/stock-preparation/preflight'

// ---------------------------------------------------------------------------
// The manifest projection (mirrors PlatformAppSummary's install-page sections)
// ---------------------------------------------------------------------------

export interface StockPreparationManifestObject {
  id: string
  name: string
  backing?: string
  objectIdPolicy?: 'fixed' | 'from-config'
  objectId?: string
  objectIdNamespace?: string
  objectIdFrom?: { configSurface: string; field: string }
  displayNames?: Record<string, string>
  columnCount?: number
  ensure?: { idempotent: true; method: string; path: string; permission?: string }
  note?: string
}

export interface StockPreparationManifestConfigSurface {
  id: string
  name: string
  kind: 'deployment-data-file' | 'env-allowlist'
  envVar?: string
  envVars?: string[]
  serverConfigKey?: string
  committed: false
  note: string
}

export interface StockPreparationManifestPostureEntry {
  id: string
  expectedState: string
  what: string
  envVar?: string
}

export interface StockPreparationManifestPosture {
  mode: string
  /**
   * `PlatformAppPostureSchema` pins this to the LITERAL `false` server-side, so a manifest can carry
   * nothing else. It is typed `boolean` here on purpose: this file parses a payload off the wire,
   * and narrowing an untrusted field to the value we hope it has would make the page's own check of
   * it unwritable — which is precisely the check §4 asks for.
   */
  installerMayModify: boolean
  note: string
  entries: StockPreparationManifestPostureEntry[]
}

export interface StockPreparationManifestAcceptance {
  verifiedBy: { script: string; note?: string }
  runbook?: string
  criteria: Array<{ id: string; statement: string; after?: string[] }>
}

export interface StockPreparationManifestPermissionPolicy {
  automaticHolders: string[]
  seededBy?: string
  source?: string
  note: string
}

/** The subset of the catalog payload the install page reads. Everything else is ignored. */
export interface StockPreparationAppManifest {
  id: string
  displayName: string
  version?: string
  valueStatement?: string
  permissions: string[]
  permissionPolicy?: StockPreparationManifestPermissionPolicy
  objects: StockPreparationManifestObject[]
  configSurfaces?: StockPreparationManifestConfigSurface[]
  acceptance?: StockPreparationManifestAcceptance
  posture?: StockPreparationManifestPosture
}

// ---------------------------------------------------------------------------
// The §14 confirmation table
// ---------------------------------------------------------------------------

/**
 * How the page must treat one section, straight out of §14's table. The three values ARE the three
 * rows of that table, and the view branches on nothing else:
 *
 *   'confirm'   展示,由客户确认   — display names, option sets, formula wording
 *   'read-only' 只展示,不可改     — managed objectIds, permission codes
 *   'no-switch' 只展示,无开关     — the four fences; the installer may never arm one
 */
export type StockPreparationConfirmationPosture = 'confirm' | 'read-only' | 'no-switch'

export interface StockPreparationInstallDefaults {
  appId: string
  displayName: string
  version: string | null
  valueStatement: string | null
  /** Managed multitable objects: display names (confirm) + objectIds (read-only). */
  objects: Array<{
    id: string
    zhName: string
    enName: string | null
    objectId: string | null
    objectIdNamespace: string | null
    objectIdSource: string | null
    columnCount: number | null
    ensurePath: string | null
    note: string | null
    /** §14: names are the customer's vocabulary; the id is never editable. */
    namePosture: StockPreparationConfirmationPosture
    objectIdPosture: StockPreparationConfirmationPosture
  }>
  permissions: {
    codes: string[]
    automaticHolders: string[]
    note: string | null
    posture: StockPreparationConfirmationPosture
  }
  configSurfaces: Array<{
    id: string
    name: string
    kind: string
    envVars: string[]
    serverConfigKey: string | null
    note: string
    /** Deployment data: shown as a NAME, never as an input. */
    posture: StockPreparationConfirmationPosture
  }>
  posture: {
    mode: string | null
    installerMayModify: boolean
    note: string | null
    entries: StockPreparationManifestPostureEntry[]
    /** Always 'no-switch'. Named rather than implied, so the view cannot render a control. */
    display: StockPreparationConfirmationPosture
  }
  acceptance: {
    script: string | null
    runbook: string | null
    criteria: Array<{ id: string; statement: string }>
  }
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

/**
 * Shape the served manifest into §14's confirmation table. PURE — the view renders this and nothing
 * else, so what a customer admin confirms is exactly what the manifest declares.
 *
 * Deliberately TOLERANT of a deployment whose backend predates the widened projection: every section
 * degrades to an empty list rather than throwing, because a page that blanks out entirely is a worse
 * answer than a page that shows the objects and says the fences were not served.
 */
export function buildStockPreparationInstallDefaults(
  manifest: StockPreparationAppManifest,
): StockPreparationInstallDefaults {
  const objects = asArray<StockPreparationManifestObject>(manifest.objects).map((object) => ({
    id: object.id,
    zhName: (object.displayNames && object.displayNames['zh-CN']) || object.name,
    enName: (object.displayNames && asText(object.displayNames.en)) || null,
    objectId: asText(object.objectId),
    objectIdNamespace: asText(object.objectIdNamespace),
    // 'from-config' ids are NOT in the manifest by design (§11): the namespace is fixed, the
    // concrete id comes from the configured pack. Saying so is the point — it is what stops the
    // next operator inventing one.
    objectIdSource: object.objectIdFrom
      ? `${object.objectIdFrom.configSurface}.${object.objectIdFrom.field}`
      : (object.objectIdPolicy === 'fixed' ? 'manifest' : null),
    columnCount: typeof object.columnCount === 'number' ? object.columnCount : null,
    ensurePath: (object.ensure && asText(object.ensure.path)) || null,
    note: asText(object.note),
    namePosture: 'confirm' as StockPreparationConfirmationPosture,
    objectIdPosture: 'read-only' as StockPreparationConfirmationPosture,
  }))

  const policy = manifest.permissionPolicy
  const posture = manifest.posture
  const acceptance = manifest.acceptance

  return {
    appId: manifest.id,
    displayName: manifest.displayName,
    version: asText(manifest.version),
    valueStatement: asText(manifest.valueStatement),
    objects,
    permissions: {
      codes: asArray<string>(manifest.permissions),
      automaticHolders: asArray<string>(policy?.automaticHolders),
      note: asText(policy?.note),
      posture: 'read-only',
    },
    configSurfaces: asArray<StockPreparationManifestConfigSurface>(manifest.configSurfaces).map((surface) => ({
      id: surface.id,
      name: surface.name,
      kind: surface.kind,
      envVars: [
        ...(asText(surface.envVar) ? [surface.envVar as string] : []),
        ...asArray<string>(surface.envVars),
      ],
      serverConfigKey: asText(surface.serverConfigKey),
      note: surface.note,
      posture: 'read-only',
    })),
    posture: {
      mode: asText(posture?.mode),
      // Absent is the SAFE reading: a page that could not read the fence contract must not imply
      // the installer may touch one.
      installerMayModify: posture?.installerMayModify === true,
      note: asText(posture?.note),
      entries: asArray<StockPreparationManifestPostureEntry>(posture?.entries),
      display: 'no-switch',
    },
    acceptance: {
      script: asText(acceptance?.verifiedBy?.script),
      runbook: asText(acceptance?.runbook),
      criteria: asArray<{ id: string; statement: string }>(acceptance?.criteria).map((criterion) => ({
        id: criterion.id,
        statement: criterion.statement,
      })),
    },
  }
}

// ---------------------------------------------------------------------------
// The preflight
// ---------------------------------------------------------------------------

/**
 * A blocker's fix, verbatim from the route. Two kinds, and the difference is load-bearing for the
 * install run (see installRun.ts): an `http` fix is a call the run itself makes, an `env` fix is
 * deployment data only a human on the deployment machine can supply.
 */
export interface StockPreparationPreflightFix {
  kind: 'http' | 'env'
  run: string
  method?: string
  path?: string
  name?: string
  placeholder?: boolean
}

export interface StockPreparationPreflightBlocker {
  code: string
  what: string
  fix?: StockPreparationPreflightFix
}

export interface StockPreparationPreflightPostureEntry {
  state: string
  note?: string
  envVar?: string
  code?: string
  canonicalObjectId?: string
}

export interface StockPreparationPreflight {
  ready: boolean
  blockerCount: number
  blockers: StockPreparationPreflightBlocker[]
  posture: Record<string, StockPreparationPreflightPostureEntry>
}

/** Raised when a read fails. Carries the HTTP status only — never a server message. */
export class StockPreparationInstallReadError extends Error {
  status: number

  constructor(status: number, route: string) {
    super(`stock-preparation install read failed (${route} -> ${status})`)
    this.name = 'StockPreparationInstallReadError'
    this.status = status
  }
}

async function readJson(response: Response | undefined): Promise<unknown> {
  try {
    return await response?.json()
  } catch {
    return null
  }
}

/** Null-safe status. A stubbed/absent Response must not become a TypeError in the view. */
function statusOf(response: Response | undefined): number {
  return typeof response?.status === 'number' ? response.status : 0
}

/**
 * The manifest, through the platform app-catalog route. The catalog answers a BARE object (no
 * `{ ok, data }` envelope — it is a core-backend router, not a plugin route), so this reads the
 * payload directly.
 */
export async function readStockPreparationAppManifest(): Promise<StockPreparationAppManifest> {
  const response = await apiFetch(STOCK_PREPARATION_MANIFEST_ROUTE)
  const payload = await readJson(response)
  if (!response?.ok || !payload || typeof payload !== 'object') {
    throw new StockPreparationInstallReadError(statusOf(response), STOCK_PREPARATION_MANIFEST_ROUTE)
  }
  return payload as StockPreparationAppManifest
}

/** The deployment preflight. Read tier (stock-prep:read); provisions nothing. */
export async function readStockPreparationPreflight(
  scope: IntegrationScope,
): Promise<StockPreparationPreflight> {
  const query = buildQueryString({ tenantId: scope.tenantId, workspaceId: scope.workspaceId })
  const response = await apiFetch(`${STOCK_PREPARATION_PREFLIGHT_ROUTE}${query ? `?${query}` : ''}`)
  const payload = await readJson(response) as IntegrationApiEnvelope<StockPreparationPreflight> | null
  if (!response?.ok || payload?.ok === false || !payload?.data) {
    throw new StockPreparationInstallReadError(statusOf(response), STOCK_PREPARATION_PREFLIGHT_ROUTE)
  }
  return payload.data
}
