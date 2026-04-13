import * as fs from 'fs/promises'
import * as path from 'path'
import type { LoadedPlugin } from '../core/plugin-loader'
import { parsePlatformAppManifest, type PlatformAppManifest } from './app-manifest'

export interface PlatformAppPluginState {
  status: 'active' | 'inactive' | 'failed'
  error?: string
  lastAttempt?: string | Date
}

export interface PlatformAppSummary {
  id: string
  pluginId: string
  pluginName: string
  pluginVersion?: string
  pluginDisplayName?: string
  pluginStatus: PlatformAppPluginState['status']
  pluginError?: string
  displayName: string
  runtimeModel: PlatformAppManifest['runtimeModel']
  boundedContext: PlatformAppManifest['boundedContext']
  runtimeBindings?: PlatformAppManifest['runtimeBindings']
  platformDependencies: PlatformAppManifest['platformDependencies']
  navigation: PlatformAppManifest['navigation']
  permissions: PlatformAppManifest['permissions']
  featureFlags: PlatformAppManifest['featureFlags']
  objects: PlatformAppManifest['objects']
  workflows: PlatformAppManifest['workflows']
  integrations: PlatformAppManifest['integrations']
  entryPath: string | null
}

export interface CollectPlatformAppsOptions {
  loadedPlugins: Iterable<LoadedPlugin>
  pluginStatus?: Map<string, PlatformAppPluginState>
  readTextFile?: (filePath: string) => Promise<string>
}

interface CachedManifestSummary {
  id: string
  pluginId: string
  displayName: string
  runtimeModel: PlatformAppManifest['runtimeModel']
  boundedContext: PlatformAppManifest['boundedContext']
  runtimeBindings?: PlatformAppManifest['runtimeBindings']
  platformDependencies: PlatformAppManifest['platformDependencies']
  navigation: PlatformAppManifest['navigation']
  permissions: PlatformAppManifest['permissions']
  featureFlags: PlatformAppManifest['featureFlags']
  objects: PlatformAppManifest['objects']
  workflows: PlatformAppManifest['workflows']
  integrations: PlatformAppManifest['integrations']
  entryPath: string | null
}

const manifestSummaryCache = new Map<string, CachedManifestSummary | null>()

function buildManifestCacheKey(loaded: LoadedPlugin): string {
  const loadedAt =
    loaded.loadedAt instanceof Date
      ? loaded.loadedAt.toISOString()
      : String(loaded.loadedAt ?? '')
  return `${loaded.path}::${loadedAt}`
}

function resolveEntryPath(manifest: PlatformAppManifest): string | null {
  const visibleItems = manifest.navigation.filter((item) => item.location !== 'hidden')
  const sortByOrder = (items: PlatformAppManifest['navigation']): typeof items =>
    items
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title))

  const mainNavItems = sortByOrder(visibleItems.filter((item) => item.location === 'main-nav'))
  if (mainNavItems.length > 0) {
    return mainNavItems[0].path
  }

  const adminItems = sortByOrder(visibleItems.filter((item) => item.location === 'admin'))
  if (adminItems.length > 0) {
    return adminItems[0].path
  }

  return sortByOrder(visibleItems)[0]?.path ?? manifest.navigation[0]?.path ?? null
}

export async function collectPlatformApps(options: CollectPlatformAppsOptions): Promise<PlatformAppSummary[]> {
  const readTextFile = options.readTextFile ?? ((filePath: string) => fs.readFile(filePath, 'utf-8'))
  const apps: PlatformAppSummary[] = []

  for (const loaded of options.loadedPlugins) {
    const cacheKey = buildManifestCacheKey(loaded)
    let cachedSummary = manifestSummaryCache.get(cacheKey)

    if (cachedSummary === undefined) {
      const manifestPath = path.join(loaded.path, 'app.manifest.json')
      let rawText: string
      try {
        rawText = await readTextFile(manifestPath)
      } catch {
        cachedSummary = null
        manifestSummaryCache.set(cacheKey, cachedSummary)
        continue
      }

      let parsedManifest: PlatformAppManifest
      try {
        parsedManifest = parsePlatformAppManifest(JSON.parse(rawText))
      } catch {
        cachedSummary = null
        manifestSummaryCache.set(cacheKey, cachedSummary)
        continue
      }

      cachedSummary = {
        id: parsedManifest.id,
        pluginId: parsedManifest.pluginId ?? loaded.manifest.name,
        displayName: parsedManifest.displayName,
        runtimeModel: parsedManifest.runtimeModel,
        boundedContext: parsedManifest.boundedContext,
        runtimeBindings: parsedManifest.runtimeBindings,
        platformDependencies: parsedManifest.platformDependencies,
        navigation: parsedManifest.navigation,
        permissions: parsedManifest.permissions,
        featureFlags: parsedManifest.featureFlags,
        objects: parsedManifest.objects,
        workflows: parsedManifest.workflows,
        integrations: parsedManifest.integrations,
        entryPath: resolveEntryPath(parsedManifest),
      }
      manifestSummaryCache.set(cacheKey, cachedSummary)
    }

    if (!cachedSummary) {
      continue
    }

    const runtime = options.pluginStatus?.get(loaded.manifest.name)
    apps.push({
      id: cachedSummary.id,
      pluginId: cachedSummary.pluginId,
      pluginName: loaded.manifest.name,
      pluginVersion: loaded.manifest.version,
      pluginDisplayName: loaded.manifest.displayName,
      pluginStatus: runtime?.status ?? 'active',
      pluginError: runtime?.error,
      displayName: cachedSummary.displayName,
      runtimeModel: cachedSummary.runtimeModel,
      boundedContext: cachedSummary.boundedContext,
      runtimeBindings: cachedSummary.runtimeBindings,
      platformDependencies: cachedSummary.platformDependencies,
      navigation: cachedSummary.navigation,
      permissions: cachedSummary.permissions,
      featureFlags: cachedSummary.featureFlags,
      objects: cachedSummary.objects,
      workflows: cachedSummary.workflows,
      integrations: cachedSummary.integrations,
      entryPath: cachedSummary.entryPath,
    })
  }

  return apps
    .slice()
    .sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id))
}
