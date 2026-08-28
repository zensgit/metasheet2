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
