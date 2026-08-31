import * as fs from 'fs'
import * as path from 'path'
import { describe, expect, it } from 'vitest'
import { parsePlatformAppManifest } from '../../src/platform/app-manifest'

/**
 * THE REAL `app.manifest.json` FILES, parsed by the real schema.
 *
 * `platform-app-registry.test.ts` covers the loader with hand-built manifests in temp directories,
 * which is the right shape for testing the loader — and it means nothing in the repository proves
 * that the manifests actually SHIPPED still parse. Adding `backing: 'multitable'` managed-object
 * fields to the schema is exactly the kind of change that could break a shipped manifest silently,
 * so this file walks `plugins/<x>/app.manifest.json` and parses every one it finds.
 *
 * The walk (rather than a hard-coded list of four) is deliberate: the next manifest is covered the
 * day it is added, without anyone remembering this file.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')
const PLUGINS_DIR = path.join(REPO_ROOT, 'plugins')

function findAppManifests(): Array<{ pluginDir: string; manifestPath: string }> {
  return fs
    .readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      pluginDir: entry.name,
      manifestPath: path.join(PLUGINS_DIR, entry.name, 'app.manifest.json'),
    }))
    .filter((entry) => fs.existsSync(entry.manifestPath))
    .sort((a, b) => a.pluginDir.localeCompare(b.pluginDir))
}

const manifests = findAppManifests()

describe('shipped app.manifest.json files', () => {
  it('finds the manifests it is supposed to be checking', () => {
    // Negative control on the walker: a wrong path would make every case below vacuous.
    expect(manifests.length).toBeGreaterThanOrEqual(4)
    expect(manifests.map((entry) => entry.pluginDir)).toEqual(
      expect.arrayContaining([
        'plugin-after-sales',
        'plugin-attendance',
        'plugin-elearning',
        'plugin-integration-core',
      ])
    )
  })

  it.each(manifests.map((entry) => [entry.pluginDir, entry.manifestPath]))(
    '%s parses through the platform app-manifest schema',
    (pluginDir, manifestPath) => {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      const parsed = parsePlatformAppManifest(raw)
      expect(parsed.id).toBeTruthy()
      expect(parsed.pluginId).toBe(pluginDir)
      expect(parsed.displayName).toBeTruthy()
    }
  )

  /**
   * The manifests that predate the managed-multitable fields must parse to the SAME value they did
   * before those fields existed — that is what "additive" has to mean. Every new field is optional
   * and none carries a default, so a manifest that does not mention them parses without them.
   */
  it.each(['plugin-after-sales', 'plugin-attendance', 'plugin-elearning'])(
    '%s is untouched by the new sections',
    (pluginDir) => {
      const manifestPath = path.join(PLUGINS_DIR, pluginDir, 'app.manifest.json')
      const parsed = parsePlatformAppManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))) as Record<
        string,
        unknown
      >
      for (const field of ['valueStatement', 'permissionPolicy', 'configSurfaces', 'acceptance', 'posture']) {
        expect(field in parsed).toBe(false)
      }
      for (const object of parsed.objects as Array<Record<string, unknown>>) {
        expect('objectIdPolicy' in object).toBe(false)
        expect('ensure' in object).toBe(false)
      }
    }
  )

  it('after-sales keeps its five multitable-backed objects without declaring managed identity', () => {
    // The pre-existing `backing: 'multitable'` case. Requiring an objectId for every multitable
    // object would have broken this manifest, which is why the managed-object rules key on
    // `objectIdPolicy` rather than on `backing`.
    const parsed = parsePlatformAppManifest(
      JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR, 'plugin-after-sales', 'app.manifest.json'), 'utf8'))
    )
    const multitableObjects = parsed.objects.filter((object) => object.backing === 'multitable')
    expect(multitableObjects.length).toBe(5)
    for (const object of multitableObjects) {
      expect(object.objectIdPolicy).toBeUndefined()
    }
  })

  it('stock-preparation declares the multitable-backed application sections', () => {
    const parsed = parsePlatformAppManifest(
      JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR, 'plugin-integration-core', 'app.manifest.json'), 'utf8'))
    )
    expect(parsed.id).toBe('stock-preparation')
    expect(parsed.displayName).toBe('BOM 备料')
    expect(parsed.valueStatement).toBeTruthy()
    expect(parsed.objects.every((object) => object.backing === 'multitable')).toBe(true)
    expect(parsed.objects.every((object) => object.ensure?.idempotent === true)).toBe(true)
    expect(parsed.permissionPolicy?.automaticHolders).toEqual([])
    expect(parsed.configSurfaces?.every((surface) => surface.committed === false)).toBe(true)
    expect(parsed.acceptance?.criteria.length).toBe(2)
    expect(parsed.posture?.mode).toBe('reported-not-installed')
    expect(parsed.posture?.installerMayModify).toBe(false)
  })
})

describe('app-manifest schema refusals for a multitable-backed application', () => {
  const base = () =>
    JSON.parse(
      fs.readFileSync(path.join(PLUGINS_DIR, 'plugin-integration-core', 'app.manifest.json'), 'utf8')
    ) as Record<string, any>

  it('accepts the shipped manifest unchanged (the control for every refusal below)', () => {
    expect(() => parsePlatformAppManifest(base())).not.toThrow()
  })

  it('refuses a managed object with no ensure', () => {
    const raw = base()
    delete raw.objects[0].ensure
    expect(() => parsePlatformAppManifest(raw)).toThrow()
  })

  it('refuses an ensure that is not idempotent', () => {
    const raw = base()
    raw.objects[0].ensure.idempotent = false
    expect(() => parsePlatformAppManifest(raw)).toThrow()
  })

  it("refuses objectIdPolicy 'fixed' without the objectId", () => {
    const raw = base()
    delete raw.objects[0].objectId
    expect(() => parsePlatformAppManifest(raw)).toThrow()
  })

  it("refuses objectIdPolicy 'from-config' without a namespace", () => {
    const raw = base()
    delete raw.objects[1].objectIdNamespace
    expect(() => parsePlatformAppManifest(raw)).toThrow()
  })

  it('refuses a config surface that claims to be committed', () => {
    const raw = base()
    raw.configSurfaces[0].committed = true
    expect(() => parsePlatformAppManifest(raw)).toThrow()
  })

  it('refuses a posture entry carrying any additional key — a fix instruction cannot be declared', () => {
    const raw = base()
    raw.posture.entries[0].fix = 'POST /api/integration/stock-preparation/target/ensure {}'
    expect(() => parsePlatformAppManifest(raw)).toThrow()
  })

  it('refuses a posture that claims the installer may modify a fence', () => {
    const raw = base()
    raw.posture.installerMayModify = true
    expect(() => parsePlatformAppManifest(raw)).toThrow()
  })
})
