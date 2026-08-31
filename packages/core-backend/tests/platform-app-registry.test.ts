import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  collectPlatformApps,
  isPlatformAppVisibleInCatalog,
} from '../src/platform/app-registry'
import { ELEARNING_FLAG_NAMES, resolveElearningCatalogFeature } from '../src/elearning/feature-flags'
import type { LoadedPlugin } from '../src/core/plugin-loader'

const tempDirs: string[] = []

function createLoadedPlugin(pluginName: string, manifest: Record<string, unknown> | null): LoadedPlugin {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `metasheet-platform-app-${pluginName}-`))
  tempDirs.push(dir)
  if (manifest) {
    fs.writeFileSync(path.join(dir, 'app.manifest.json'), JSON.stringify(manifest, null, 2))
  }
  return {
    manifest: {
      name: pluginName,
      version: '1.0.0',
      displayName: `${pluginName} display`,
    } as any,
    plugin: {} as any,
    path: dir,
    loadedAt: new Date(),
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('collectPlatformApps', () => {
  it('collects valid app manifests and derives entry path', async () => {
    const loaded = createLoadedPlugin('plugin-after-sales', {
      id: 'after-sales',
      version: '0.1.0',
      displayName: 'After Sales',
      pluginId: 'plugin-after-sales',
      boundedContext: { code: 'after-sales' },
      platformDependencies: ['multitable', 'comments'],
      navigation: [
        { id: 'hidden-entry', title: 'Hidden', path: '/hidden', location: 'hidden', order: 1 },
        { id: 'home', title: 'After Sales', path: '/p/plugin-after-sales/after-sales', location: 'main-nav', order: 2 },
      ],
      permissions: [],
      featureFlags: ['afterSales'],
      objects: [],
      workflows: [],
      integrations: [],
    })

    const result = await collectPlatformApps({
      loadedPlugins: [loaded],
      pluginStatus: new Map([
        ['plugin-after-sales', { status: 'active' as const }],
      ]),
    })

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: 'after-sales',
      pluginName: 'plugin-after-sales',
      pluginStatus: 'active',
      runtimeModel: 'instance',
      entryPath: '/p/plugin-after-sales/after-sales',
      runtimeBindings: undefined,
    })
  })

  it('prefers main-nav entry path over admin entry path even when admin order is smaller', async () => {
    const loaded = createLoadedPlugin('plugin-after-sales', {
      id: 'after-sales',
      version: '0.1.0',
      displayName: 'After Sales',
      pluginId: 'plugin-after-sales',
      boundedContext: { code: 'after-sales' },
      runtimeBindings: {
        currentPath: '/api/after-sales/projects/current',
        installPath: '/api/after-sales/projects/install',
        installPayload: {
          templateId: 'after-sales-default',
        },
      },
      platformDependencies: ['multitable', 'comments'],
      navigation: [
        { id: 'runtime-admin', title: 'Runtime admin', path: '/p/plugin-after-sales/after-sales#after-sales-runtime-admin', location: 'admin', order: 10 },
        { id: 'home', title: 'After Sales', path: '/p/plugin-after-sales/after-sales', location: 'main-nav', order: 60 },
      ],
      permissions: [],
      featureFlags: ['afterSales'],
      objects: [],
      workflows: [],
      integrations: [],
    })

    const result = await collectPlatformApps({
      loadedPlugins: [loaded],
      pluginStatus: new Map([
        ['plugin-after-sales', { status: 'active' as const }],
      ]),
    })

    expect(result).toHaveLength(1)
    expect(result[0].entryPath).toBe('/p/plugin-after-sales/after-sales')
    expect(result[0].runtimeBindings).toEqual({
      currentPath: '/api/after-sales/projects/current',
      installPath: '/api/after-sales/projects/install',
      installPayload: {
        templateId: 'after-sales-default',
      },
    })
  })

  it('skips plugins without app manifest', async () => {
    const loaded = createLoadedPlugin('plugin-no-app', null)
    const result = await collectPlatformApps({ loadedPlugins: [loaded] })
    expect(result).toEqual([])
  })

  it('skips invalid app manifests', async () => {
    const loaded = createLoadedPlugin('plugin-invalid-app', {
      id: 'broken-app',
      version: '0.1.0',
      displayName: 'Broken App',
    })
    const result = await collectPlatformApps({ loadedPlugins: [loaded] })
    expect(result).toEqual([])
  })

  it('collects direct-runtime manifests without requiring tenant instances', async () => {
    const loaded = createLoadedPlugin('plugin-attendance', {
      id: 'attendance',
      version: '0.1.0',
      displayName: 'Attendance',
      pluginId: 'plugin-attendance',
      runtimeModel: 'direct',
      boundedContext: { code: 'attendance' },
      platformDependencies: ['workflow'],
      navigation: [
        { id: 'home', title: 'Attendance', path: '/attendance', location: 'main-nav', order: 50 },
      ],
      permissions: [],
      featureFlags: ['attendance'],
      objects: [],
      workflows: [],
      integrations: [],
    })

    const result = await collectPlatformApps({
      loadedPlugins: [loaded],
      pluginStatus: new Map([
        ['plugin-attendance', { status: 'active' as const }],
      ]),
    })

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: 'attendance',
      pluginName: 'plugin-attendance',
      pluginStatus: 'active',
      runtimeModel: 'direct',
      entryPath: '/attendance',
    })
  })

  it('reuses cached manifest parsing for the same loaded plugin instance', async () => {
    const loaded = createLoadedPlugin('plugin-after-sales', {
      id: 'after-sales',
      version: '0.1.0',
      displayName: 'After Sales',
      pluginId: 'plugin-after-sales',
      boundedContext: { code: 'after-sales' },
      platformDependencies: ['multitable'],
      navigation: [
        { id: 'home', title: 'After Sales', path: '/p/plugin-after-sales/after-sales', location: 'main-nav', order: 1 },
      ],
      permissions: [],
      featureFlags: [],
      objects: [],
      workflows: [],
      integrations: [],
    })

    const readTextFile = vi.fn(async (filePath: string) => fs.promises.readFile(filePath, 'utf-8'))

    const first = await collectPlatformApps({ loadedPlugins: [loaded], readTextFile })
    const second = await collectPlatformApps({ loadedPlugins: [loaded], readTextFile })

    expect(first[0]?.id).toBe('after-sales')
    expect(second[0]?.id).toBe('after-sales')
    expect(readTextFile).toHaveBeenCalledTimes(1)
  })
})

describe('isPlatformAppVisibleInCatalog', () => {
  it('keeps apps visible when no predicate is provided', () => {
    expect(isPlatformAppVisibleInCatalog(['elearning'])).toBe(true)
    expect(isPlatformAppVisibleInCatalog(['afterSales'])).toBe(true)
    expect(isPlatformAppVisibleInCatalog(['attendance', 'attendanceAdmin'])).toBe(true)
  })

  it('hides only flags the predicate explicitly rejects, not unknown featureFlags', () => {
    const predicate = (flag: string) => (flag === 'elearning' ? false : undefined)
    expect(isPlatformAppVisibleInCatalog(['elearning'], predicate)).toBe(false)
    expect(isPlatformAppVisibleInCatalog(['elearning', 'afterSales'], predicate)).toBe(false)
    expect(isPlatformAppVisibleInCatalog(['afterSales'], predicate)).toBe(true)
    expect(isPlatformAppVisibleInCatalog(['attendance', 'attendanceAdmin', 'attendanceImport', 'workflow'], predicate)).toBe(true)
    expect(isPlatformAppVisibleInCatalog(['not-a-real-feature'], predicate)).toBe(true)
    expect(isPlatformAppVisibleInCatalog([], predicate)).toBe(true)
  })
})

describe('collectPlatformApps catalog feature predicate', () => {
  const flagSnapshot: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const name of ELEARNING_FLAG_NAMES) {
      flagSnapshot[name] = Object.prototype.hasOwnProperty.call(process.env, name)
        ? process.env[name]
        : undefined
    }
  })

  afterEach(() => {
    for (const name of ELEARNING_FLAG_NAMES) {
      if (flagSnapshot[name] === undefined) delete process.env[name]
      else process.env[name] = flagSnapshot[name]
    }
  })

  function createMixedCatalog(): LoadedPlugin[] {
    return [
      createLoadedPlugin('plugin-elearning', {
        id: 'elearning',
        version: '0.1.0',
        displayName: '学习中心',
        pluginId: 'plugin-elearning',
        runtimeModel: 'direct',
        boundedContext: { code: 'elearning' },
        platformDependencies: ['auth'],
        navigation: [],
        permissions: [],
        featureFlags: ['elearning'],
        objects: [],
        workflows: [],
        integrations: [],
      }),
      createLoadedPlugin('plugin-after-sales', {
        id: 'after-sales',
        version: '0.1.0',
        displayName: 'After Sales',
        pluginId: 'plugin-after-sales',
        boundedContext: { code: 'after-sales' },
        platformDependencies: ['multitable'],
        navigation: [
          { id: 'home', title: 'After Sales', path: '/p/plugin-after-sales/after-sales', location: 'main-nav', order: 1 },
        ],
        permissions: [],
        featureFlags: ['afterSales'],
        objects: [],
        workflows: [],
        integrations: [],
      }),
      createLoadedPlugin('plugin-attendance', {
        id: 'attendance',
        version: '0.1.0',
        displayName: 'Attendance',
        pluginId: 'plugin-attendance',
        runtimeModel: 'direct',
        boundedContext: { code: 'attendance' },
        platformDependencies: ['workflow'],
        navigation: [
          { id: 'home', title: 'Attendance', path: '/attendance', location: 'main-nav', order: 50 },
        ],
        permissions: [],
        featureFlags: ['attendance', 'attendanceAdmin', 'attendanceImport', 'workflow'],
        objects: [],
        workflows: [],
        integrations: [],
      }),
      createLoadedPlugin('plugin-unknown-flag', {
        id: 'unknown-flag-app',
        version: '0.1.0',
        displayName: 'Unknown Flag App',
        pluginId: 'plugin-unknown-flag',
        boundedContext: { code: 'unknown-flag' },
        platformDependencies: ['auth'],
        navigation: [],
        permissions: [],
        featureFlags: ['notARealProductFeature'],
        objects: [],
        workflows: [],
        integrations: [],
      }),
    ]
  }

  function idsOf(apps: Array<{ id: string }>): string[] {
    return apps.map((app) => app.id).sort()
  }

  it('without a predicate still collects elearning (filter is opt-in)', async () => {
    delete process.env.ELEARNING_ENABLED
    const result = await collectPlatformApps({ loadedPlugins: createMixedCatalog() })
    expect(idsOf(result)).toEqual(['after-sales', 'attendance', 'elearning', 'unknown-flag-app'])
  })

  it.each([
    ['missing', undefined],
    ['false', 'false'],
    ['TRUE', 'TRUE'],
    ['true-space', 'true '],
  ] as const)('hides elearning when master is %s and leaves unrelated apps visible', async (_label, value) => {
    if (value === undefined) delete process.env.ELEARNING_ENABLED
    else process.env.ELEARNING_ENABLED = value

    const result = await collectPlatformApps({
      loadedPlugins: createMixedCatalog(),
      isCatalogFeatureEnabled: resolveElearningCatalogFeature,
    })
    expect(idsOf(result)).toEqual(['after-sales', 'attendance', 'unknown-flag-app'])
    expect(result.some((app) => app.id === 'elearning' || app.displayName === '学习中心')).toBe(false)
  })

  it('shows elearning when master is exact true and still leaves unrelated apps visible', async () => {
    process.env.ELEARNING_ENABLED = 'true'
    const result = await collectPlatformApps({
      loadedPlugins: createMixedCatalog(),
      isCatalogFeatureEnabled: resolveElearningCatalogFeature,
    })
    expect(idsOf(result)).toEqual(['after-sales', 'attendance', 'elearning', 'unknown-flag-app'])
    expect(result.find((app) => app.id === 'elearning')?.displayName).toBe('学习中心')
  })
})

/**
 * THE INSTALL-PAGE PROJECTION (§14 of
 * docs/development/platform-overall-design/multitable-application-model-20260830.md — "安装页展示默认
 * 配置,由客户确认").
 *
 * `PlatformAppManifestSchema` has parsed `valueStatement` / `permissionPolicy` / `configSurfaces` /
 * `acceptance` / `posture` since the managed-multitable wave, and `collectPlatformApps` then DROPPED
 * all five. A page whose whole job is to put the manifest's defaults in front of a customer admin
 * therefore had nothing to read. These cases pin the five sections onto the projection, and pin the
 * two properties that make it safe to serve them.
 *
 * Read-only throughout: `collectPlatformApps` inspects manifest files and provisions nothing.
 */
describe('collectPlatformApps — install-page manifest sections', () => {
  const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

  /** The REAL shipped manifest, not a fixture: a drop must redden against the file that ships. */
  function loadRealIntegrationCorePlugin(): LoadedPlugin {
    return {
      manifest: {
        name: 'plugin-integration-core',
        version: '0.1.0',
        displayName: 'Integration Core',
      } as any,
      plugin: {} as any,
      path: path.join(REPO_ROOT, 'plugins', 'plugin-integration-core'),
      // A fresh timestamp per call: the summary cache is keyed on path+loadedAt, and a shared key
      // would let one case's projection satisfy the next one's assertion.
      loadedAt: new Date(),
    }
  }

  it('P-01: carries the five install-page sections for the shipped stock-preparation manifest', async () => {
    const [app] = await collectPlatformApps({ loadedPlugins: [loadRealIntegrationCorePlugin()] })

    expect(app.id).toBe('stock-preparation')

    // §14 row "受管表 objectId、权限码 — 只展示,不可改": the ids the page must show and never let
    // anyone retype. The manifest is the authority precisely because a hand-typed id was the first
    // deployment's incident.
    expect(app.objects.map((object) => object.id).sort()).toEqual(['confirmationDecisionLedger', 'sandboxTarget'])
    expect(app.objects.find((object) => object.id === 'confirmationDecisionLedger')?.objectId)
      .toBe('plm_stock_preparation_confirmation_decision')

    // R-11 零自动持有 — "nobody holds these the moment it installs" has to be READABLE, not inferred
    // from the absence of a field.
    expect(app.permissionPolicy?.automaticHolders).toEqual([])
    expect(app.permissionPolicy?.note).toEqual(expect.any(String))

    // §14 row "围栏姿态 — 只展示,无开关".
    expect(app.posture?.mode).toBe('reported-not-installed')
    expect(app.posture?.installerMayModify).toBe(false)
    expect((app.posture?.entries ?? []).map((entry) => entry.id).sort())
      .toEqual(['b2aTrialRegistry', 'k3ExternalWrite', 'outboundHttpWrite', 'productionApply'])

    // Deployment data the page must MARK as such rather than offer a field for.
    expect((app.configSurfaces ?? []).map((surface) => surface.id).sort())
      .toEqual(['customerPack', 'extFieldMapping', 'sandboxWriteAuthorization'])
    for (const surface of app.configSurfaces ?? []) {
      expect(surface.committed).toBe(false)
    }

    expect(app.acceptance?.verifiedBy.script).toBe('scripts/ops/stock-prep-acceptance-bootstrap.mjs')
    expect((app.acceptance?.criteria ?? []).map((criterion) => criterion.id))
      .toEqual(['ext-columns-written-human-band-untouched', 'second-refresh-all-skip'])

    expect(app.valueStatement).toEqual(expect.any(String))
  })

  it('P-02: a manifest declaring none of them still projects, with each section undefined', async () => {
    const loaded = createLoadedPlugin('plugin-plain', {
      id: 'plain-app',
      version: '0.1.0',
      displayName: 'Plain App',
      pluginId: 'plugin-plain',
      boundedContext: { code: 'plain' },
      platformDependencies: ['auth'],
      navigation: [{ id: 'home', title: 'Plain', path: '/plain' }],
      permissions: [],
      featureFlags: [],
      objects: [],
      workflows: [],
      integrations: [],
    })

    const [app] = await collectPlatformApps({ loadedPlugins: [loaded] })

    expect(app.id).toBe('plain-app')
    for (const section of ['valueStatement', 'permissionPolicy', 'configSurfaces', 'acceptance', 'posture'] as const) {
      expect(app[section]).toBeUndefined()
    }
  })

  it('P-03: VALUES-FREE — the projection reads the manifest only, never the environment', async () => {
    // Every env var the shipped manifest NAMES, set to a sentinel that could not occur in a
    // manifest. A projection that resolved a name to its value would carry one of these; a
    // projection that copies the manifest cannot.
    const SENTINEL = 'SENTINEL_DEPLOYMENT_VALUE_bd41c2'
    const named = [
      'INTEGRATION_CORE_STOCK_PREPARATION_CUSTOMER_PACKS_PATH',
      'INTEGRATION_CORE_STOCK_PREPARATION_EXT_FIELD_MAPPING_PATH',
      'STOCK_PREP_SANDBOX_MODE',
      'STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS',
      'INTEGRATION_CORE_B2A_REGISTRY_PATH',
      'INTEGRATION_CORE_OUTBOUND_HTTP_WRITE_TARGETS',
    ]
    const saved = new Map(named.map((name) => [name, process.env[name]]))
    for (const name of named) process.env[name] = `${SENTINEL}_${name}`

    try {
      const [app] = await collectPlatformApps({ loadedPlugins: [loadRealIntegrationCorePlugin()] })
      expect(JSON.stringify(app)).not.toContain(SENTINEL)

      // Positive control: the env var NAMES themselves ARE part of the projection — otherwise the
      // assertion above would pass on an empty payload and prove nothing.
      const surfaceEnvVars = (app.configSurfaces ?? []).flatMap(
        (surface) => [...(surface.envVar ? [surface.envVar] : []), ...(surface.envVars ?? [])],
      )
      expect(surfaceEnvVars).toContain('INTEGRATION_CORE_STOCK_PREPARATION_CUSTOMER_PACKS_PATH')
      expect((app.posture?.entries ?? []).map((entry) => entry.envVar)).toContain('INTEGRATION_CORE_B2A_REGISTRY_PATH')
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })

  it('P-04: no posture entry reaches the page carrying anything runnable', async () => {
    // §4: "posture 四项只展示,永无「修复」按钮". The manifest schema makes the entry `.strict()`, so
    // this asserts the projection did not add one back on the way out.
    const [app] = await collectPlatformApps({ loadedPlugins: [loadRealIntegrationCorePlugin()] })
    const entries = app.posture?.entries ?? []
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) {
      for (const forbidden of ['fix', 'run', 'enable', 'arm', 'set']) {
        expect(Object.prototype.hasOwnProperty.call(entry, forbidden)).toBe(false)
      }
    }
  })
})
