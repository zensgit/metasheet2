/**
 * Who may load the user notification modules. The edges are exact sets: a new importer, a re-export or
 * a second load from an allowed file fails the test until the set is changed on purpose.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  NON_LITERAL_SPECIFIER,
  collectImportEdges,
  importEdgeViolations,
  importSpecifiers,
  listSourceFiles,
  type ImportEdge,
} from '../helpers/import-edge-allowlist'

const BACKEND = path.resolve(__dirname, '..', '..')
const SRC = path.join(BACKEND, 'src')
const NOTIFICATIONS = path.join(SRC, 'notifications') + path.sep

const read = (file: string): string => readFileSync(file, 'utf8')

/** Files outside notifications/ that load a module of notifications/, and which module. */
function importersFromOutside(): ImportEdge[] {
  const edges: ImportEdge[] = []
  for (const file of listSourceFiles(SRC)) {
    if (file.startsWith(NOTIFICATIONS)) continue
    const source = read(file)
    if (!/notifications/.test(source)) continue
    for (const specifier of importSpecifiers(source, file)) {
      if (specifier === NON_LITERAL_SPECIFIER) {
        edges.push([path.relative(SRC, file), specifier])
        continue
      }
      if (!specifier.startsWith('.')) continue
      const target = path.resolve(path.dirname(file), specifier)
      if (target.startsWith(NOTIFICATIONS) || target === NOTIFICATIONS.slice(0, -1)) {
        edges.push([path.relative(SRC, file), path.relative(SRC, target)])
      }
    }
  }
  return edges
}

const OUTSIDE_ALLOWLIST: ReadonlyArray<ImportEdge> = [
  ['integrations/dingtalk/notification-fingerprint.ts', 'notifications/witness'],
  ['integrations/provider-capability-registry.ts', 'notifications/notification-precondition'],
  ['integrations/provider-capability-registry.ts', 'notifications/notification-flags'],
  ['routes/admin-notification-verifications.ts', 'notifications/notification-errors'],
  ['routes/admin-notification-verifications.ts', 'notifications/notification-flags'],
  ['routes/admin-notification-verifications.ts', 'notifications/notification-tx'],
  ['routes/admin-notification-verifications.ts', 'notifications/verification-service'],
  ['routes/me-notification-endpoints.ts', 'notifications/endpoints-service'],
  ['routes/me-notification-endpoints.ts', 'notifications/notification-flags'],
  ['routes/me-notification-endpoints.ts', 'notifications/provider-notification-registry'],
  ['routes/me-notification-http.ts', 'notifications/notification-errors'],
  ['routes/me-notification-http.ts', 'notifications/notification-tx'],
  ['routes/me-notification-preferences.ts', 'notifications/notification-flags'],
  ['routes/me-notification-preferences.ts', 'notifications/preferences-service'],
  ['routes/me-notification-preferences.ts', 'notifications/quiet-hours'],
  ['routes/me-notification-preferences.ts', 'notifications/topic-registry'],
  ['routes/me-notification-test-send.ts', 'notifications/notification-errors'],
  ['routes/me-notification-test-send.ts', 'notifications/notification-flags'],
  ['routes/me-notification-test-send.ts', 'notifications/notification-tx'],
  ['routes/me-notification-test-send.ts', 'notifications/test-send-service'],
  ['routes/me-notification-wiring.ts', 'notifications/notification-errors'],
  ['routes/me-notification-wiring.ts', 'notifications/notification-flags'],
  ['routes/me-notification-wiring.ts', 'notifications/notification-tx'],
  ['routes/me-notification-wiring.ts', 'notifications/recipient-resolver'],
  ['routes/me-notification-wiring.ts', 'notifications/test-send-service'],
  ['routes/me-notification-wiring.ts', 'notifications/verification-evidence'],
  ['services/notification-adapter-bootstrap.ts', 'notifications/adapters'],
  ['services/notification-adapter-bootstrap.ts', 'notifications/adapters/notification-adapter'],
]

describe('importers of the notification modules', () => {
  it('are exactly the notification routes, production wiring, fingerprint helper and capability precondition', () => {
    expect(importEdgeViolations(importersFromOutside(), OUTSIDE_ALLOWLIST)).toEqual([])
  })

  it('exclude the legacy senders, the task pipeline, the credential and verification code and the index', () => {
    const legacy = [
      'services/AttendanceNotificationDeliveryWorker.ts',
      'services/AttendanceNotifier.ts',
      'services/NotificationService.ts',
      'services/elearning-notification-delivery.ts',
      'services/elearning-notification-dispatch.ts',
      'services/task-notification-delivery-worker.ts',
      'services/task-notification-dingtalk.ts',
      'services/task-scheduler.ts',
      'integrations/dingtalk/work-notification-settings.ts',
      'integrations/dingtalk/work-notification-verify.ts',
      'index.ts',
    ]
    const importers = new Set(importersFromOutside().map(([file]) => file))
    for (const file of legacy) {
      expect(existsSync(path.join(SRC, file)), `${file} exists`).toBe(true)
      expect(importers.has(file), file).toBe(false)
    }
  })

  it('reach the resolver and the provider registry only from the routes, the services and the wiring', () => {
    const found = collectImportEdges(SRC, /recipient-resolver|provider-notification-registry/, read)
    expect(importEdgeViolations(found, [
      ['notifications/endpoints-service.ts', './provider-notification-registry'],
      ['notifications/endpoints-service.ts', './recipient-resolver'],
      ['notifications/adapters/notification-adapter.ts', '../recipient-resolver'],
      ['notifications/adapters/dingtalk-work-notification-adapter.ts', '../provider-notification-registry'],
      ['notifications/adapters/dingtalk-work-notification-adapter.ts', '../recipient-resolver'],
      ['notifications/delivery-outcome.ts', './provider-notification-registry'],
      ['notifications/notification-tx.ts', './recipient-resolver'],
      ['notifications/preferences-service.ts', './provider-notification-registry'],
      ['notifications/preferences-service.ts', './recipient-resolver'],
      ['notifications/recipient-resolver.ts', './provider-notification-registry'],
      ['notifications/witness.ts', './provider-notification-registry'],
      ['notifications/test-send-service.ts', './recipient-resolver'],
      ['notifications/verification-evidence.ts', './recipient-resolver'],
      ['notifications/verification-service.ts', './recipient-resolver'],
      ['routes/me-notification-endpoints.ts', '../notifications/provider-notification-registry'],
      ['routes/me-notification-wiring.ts', '../notifications/recipient-resolver'],
    ])).toEqual([])
  })

  it('load the display evaluation of a capability only from the endpoint service', () => {
    const found = collectImportEdges(SRC, /integration-capability-evaluate/, read).filter(([file]) => !file.startsWith('integrations/'))
    expect(found).toEqual([['notifications/endpoints-service.ts', '../integrations/integration-capability-evaluate']])
  })

  it('load the fingerprint helper and adapter bootstrap only from the named production boundaries', () => {
    const found = collectImportEdges(SRC, /notification-fingerprint|notification-adapter-bootstrap/, read)
    expect(importEdgeViolations(found, [
      ['index.ts', './services/notification-adapter-bootstrap'],
      ['integrations/provider-capability-registry.ts', './dingtalk/notification-fingerprint'],
      ['notifications/verification-service.ts', '../integrations/dingtalk/notification-fingerprint'],
      ['routes/me-notification-wiring.ts', '../integrations/dingtalk/notification-fingerprint'],
      ['routes/me-notification-test-send.ts', '../services/notification-adapter-bootstrap'],
    ])).toEqual([])
  })
})

describe('imports of the notification modules', () => {
  it('use only the pure delivery protocol from tasks: the active-member predicate is passed in', () => {
    const offenders: string[] = []
    const protocolEdges: ImportEdge[] = []
    for (const file of listSourceFiles(NOTIFICATIONS)) {
      for (const specifier of importSpecifiers(read(file), file)) {
        if (specifier === NON_LITERAL_SPECIFIER) offenders.push(`${path.relative(SRC, file)} -> ${specifier}`)
        else if (/(^|\/)task-[^/]*$/.test(specifier) || /(^|\/)tasks\//.test(specifier)) {
          if (path.resolve(path.dirname(file), specifier) === path.join(SRC, 'tasks/task-delivery-protocol')) {
            protocolEdges.push([path.relative(SRC, file), specifier])
          } else offenders.push(`${path.relative(SRC, file)} -> ${specifier}`)
        }
      }
    }
    expect(offenders).toEqual([])
    expect(importEdgeViolations(protocolEdges, [
      ['notifications/adapters/dingtalk-work-notification-adapter.ts', '../../tasks/task-delivery-protocol'],
      ['notifications/delivery-outcome.ts', '../tasks/task-delivery-protocol'],
    ])).toEqual([])
  })

  it('stay inside the notification, capability and utility modules (nothing of routes, services or directory)', () => {
    const offenders: string[] = []
    for (const file of listSourceFiles(NOTIFICATIONS)) {
      for (const specifier of importSpecifiers(read(file), file)) {
        if (!specifier.startsWith('.')) continue
        const target = path.relative(SRC, path.resolve(path.dirname(file), specifier))
        if (/^(routes|services|directory|index)(\/|$)/.test(target)) offenders.push(`${path.relative(SRC, file)} -> ${specifier}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('are recognised in every spelling of a module load, with or without a .js suffix', () => {
    const spellings = [
      "import { x } from '../notifications/recipient-resolver'",
      "import { x } from '../notifications/recipient-resolver.js'",
      "export * from '../notifications/recipient-resolver'",
      "const m = require('../notifications/recipient-resolver.js')",
      'const m = await import(`../notifications/recipient-resolver`)',
      "type T = import('../notifications/recipient-resolver').X",
    ]
    for (const spelling of spellings) {
      expect(importSpecifiers(spelling).some((specifier) => /notifications\/recipient-resolver(\.js)?$/.test(specifier)), spelling).toBe(true)
    }
    expect(importSpecifiers('const m = require(name)')).toEqual([NON_LITERAL_SPECIFIER])
  })

  it('treat a second load of the same module from an allowed file as a violation', () => {
    const doubled: ImportEdge[] = [...OUTSIDE_ALLOWLIST, ['routes/me-notification-endpoints.ts', 'notifications/endpoints-service']]
    expect(importEdgeViolations(doubled, OUTSIDE_ALLOWLIST)).toEqual(['unexpected: routes/me-notification-endpoints.ts -> notifications/endpoints-service'])
  })
})
