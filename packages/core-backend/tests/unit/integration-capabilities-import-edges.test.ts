/**
 * Who may load the capability modules, and which source files may name the capability tables.
 * Both are exact sets: a new importer, a re-export, a second load from an allowed file, or a new
 * file naming a table makes the test fail until the set is changed on purpose.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  NON_LITERAL_SPECIFIER,
  collectImportEdges,
  importEdgeViolations,
  importSpecifiers,
  listAllFiles,
  type ImportEdge,
} from '../helpers/import-edge-allowlist'

const BACKEND = path.resolve(__dirname, '..', '..')
const ROOT = path.resolve(BACKEND, '..', '..')
const SRC = path.join(BACKEND, 'src')
const BACKEND_SCRIPTS = path.join(BACKEND, 'scripts')

/** A module specifier that loads one of the capability modules (any directory prefix, with or without a .js/.ts suffix). */
const CAPABILITY_MODULE =
  /(?:directory-integration-capabilities-flag|provider-capability-registry|integration-capability-implementations|integration-capability-evaluate|directory-integration-capabilities-service|admin-directory-capabilities)(?:\.[cm]?[jt]s)?$/

const SRC_ALLOWLIST: ReadonlyArray<ImportEdge> = [
  ['integrations/integration-capability-evaluate.ts', './provider-capability-registry'],
  ['integrations/integration-capability-implementations.ts', './provider-capability-registry'],
  ['integrations/directory-integration-capabilities-service.ts', './integration-capability-evaluate'],
  ['integrations/directory-integration-capabilities-service.ts', './provider-capability-registry'],
  ['routes/admin-directory-capabilities.ts', '../integrations/directory-integration-capabilities-flag'],
  ['routes/admin-directory-capabilities.ts', '../integrations/directory-integration-capabilities-service'],
  ['routes/admin-directory-capabilities.ts', '../integrations/integration-capability-implementations'],
  ['routes/admin-directory-capabilities.ts', '../integrations/provider-capability-registry'],
  ['index.ts', './routes/admin-directory-capabilities'],
  ['integrations/feishu/config.ts', '../provider-capability-registry'],
  ['routes/admin-directory-feishu.ts', '../integrations/directory-integration-capabilities-flag'],
  ['notifications/recipient-resolver.ts', '../integrations/provider-capability-registry'],
  ['notifications/endpoints-service.ts', '../integrations/integration-capability-evaluate'],
  ['notifications/endpoints-service.ts', '../integrations/directory-integration-capabilities-flag'],
  ['notifications/endpoints-service.ts', '../integrations/integration-capability-implementations'],
  ['notifications/endpoints-service.ts', '../integrations/provider-capability-registry'],
]

const read = (file: string): string => readFileSync(file, 'utf8')

function filesBelow(dir: string): string[] {
  return existsSync(dir)
    ? readdirSync(dir).flatMap((entry) => {
        if (entry === 'node_modules') return []
        const full = path.join(dir, entry)
        return statSync(full).isDirectory() ? filesBelow(full) : [full]
      })
    : []
}

describe('importers of the capability modules', () => {
  it('are exactly the allowlist under src', () => {
    const found = collectImportEdges(SRC, /integration-capabilit|provider-capability-registry|admin-directory-capabilities/, read).filter(
      ([, specifier]) => specifier === NON_LITERAL_SPECIFIER || CAPABILITY_MODULE.test(specifier),
    )
    expect(importEdgeViolations(found, SRC_ALLOWLIST)).toEqual([])
  })

  it('include no importer in the backend scripts', () => {
    const found = collectImportEdges(BACKEND_SCRIPTS, /integration-capabilit|provider-capability-registry|admin-directory-capabilities/, read).filter(
      ([, specifier]) => specifier === NON_LITERAL_SPECIFIER || CAPABILITY_MODULE.test(specifier),
    )
    expect(found).toEqual([])
  })

  it('exclude the legacy entry points, the sync paths and the credential and verification code', () => {
    const legacy = [
      'auth/dingtalk-oauth.ts',
      'routes/auth.ts',
      'auth/user-activate.ts',
      'integrations/dingtalk/work-notification-settings.ts',
      'integrations/dingtalk/work-notification-verify.ts',
      'directory/directory-sync.ts',
      'directory/directory-sync-scheduler.ts',
    ]
    for (const file of legacy) {
      const full = path.join(SRC, file)
      expect(existsSync(full), `${file} exists`).toBe(true)
      const specifiers = importSpecifiers(read(full), full)
      expect(specifiers.filter((specifier) => CAPABILITY_MODULE.test(specifier) || specifier === NON_LITERAL_SPECIFIER), file).toEqual([])
    }
  })

  it('are recognised in every spelling of a module load', () => {
    const spellings = [
      "import { x } from '../integrations/integration-capability-evaluate'",
      "import { x } from '../integrations/integration-capability-evaluate.js'",
      "export * from '../integrations/provider-capability-registry'",
      "const m = require('../integrations/integration-capability-implementations.js')",
      'const m = await import(`../integrations/directory-integration-capabilities-service`)',
      "type T = import('../integrations/directory-integration-capabilities-flag').X",
    ]
    for (const spelling of spellings) {
      const specifiers = importSpecifiers(spelling)
      expect(specifiers.some((specifier) => CAPABILITY_MODULE.test(specifier)), spelling).toBe(true)
    }
    expect(importSpecifiers('const m = require(name)')).toEqual([NON_LITERAL_SPECIFIER])
  })

  it('treat a second load of the same module from an allowed file as a violation', () => {
    const doubled: ImportEdge[] = [...SRC_ALLOWLIST, ['routes/admin-directory-capabilities.ts', '../integrations/provider-capability-registry']]
    expect(importEdgeViolations(doubled, SRC_ALLOWLIST)).toEqual([
      'unexpected: routes/admin-directory-capabilities.ts -> ../integrations/provider-capability-registry',
    ])
  })
})

describe('source files that name a capability table', () => {
  const TABLE_NAME = /directory_integration_capabilit(?:ies|y_history)/
  const ROOTS = [SRC, path.join(ROOT, 'scripts'), BACKEND_SCRIPTS, path.join(ROOT, '.github'), path.join(ROOT, 'docker')]
  const ALLOWED = [
    'packages/core-backend/src/db/migrate.ts',
    'packages/core-backend/src/db/migrations/zzzz20261106130000_create_directory_integration_capabilities.ts',
    'packages/core-backend/src/integrations/integration-capability-evaluate.ts',
  ]

  it('are exactly the migration, its help text and the capability reader', () => {
    const named: string[] = []
    for (const root of ROOTS) {
      expect(existsSync(root), root).toBe(true)
      for (const file of filesBelow(root)) {
        if (TABLE_NAME.test(readFileSync(file, 'utf8'))) named.push(path.relative(ROOT, file))
      }
    }
    expect(named.sort()).toEqual(ALLOWED)
  })

  it('scans a non-trivial population', () => {
    const count = ROOTS.reduce((total, root) => total + filesBelow(root).length, 0)
    expect(count).toBeGreaterThan(500)
    expect(listAllFiles(SRC).length).toBeGreaterThan(300)
  })
})
