import { resolve } from 'node:path'
import ts from 'typescript'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { query, transaction } from '../../src/db/pg'
import { resolveEffectiveNotificationCapabilityForBackground } from '../../src/integrations/integration-capability-resolve-background'
import { meNotificationEndpointsRouter } from '../../src/routes/me-notification-endpoints'
import { meNotificationPreferencesRouter } from '../../src/routes/me-notification-preferences'
import { meNotificationTestSendRouter } from '../../src/routes/me-notification-test-send'
import {
  productionNotificationConnectionReadiness,
  productionNotificationDbDeps,
  productionRecipientResolver,
} from '../../src/routes/me-notification-wiring'

const captured = vi.hoisted(() => ({ endpoints: [] as unknown[], preferences: [] as unknown[], send: [] as unknown[] }))

vi.mock('../../src/db/pg', () => ({ query: vi.fn(), transaction: vi.fn() }))
vi.mock('../../src/audit/audit', () => ({ auditLog: vi.fn() }))
vi.mock('../../src/integrations/dingtalk/notification-fingerprint', () => ({ readNotificationTupleFingerprint: vi.fn() }))
vi.mock('../../src/services/task-org-members', () => ({ findActiveOrgMembers: vi.fn() }))
vi.mock('../../src/middleware/auth', () => ({ authenticate: vi.fn() }))
vi.mock('../../src/services/notification-adapter-bootstrap', () => ({}))
vi.mock('../../src/metrics/metrics', () => ({ metrics: { notificationTestSendsTotal: { inc: vi.fn() } } }))

// Observe the actual route assembly, then retain the real service factory and resolver implementation.
vi.mock('../../src/notifications/endpoints-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/notifications/endpoints-service')>()
  return { ...actual, createEndpointsService: (deps: Parameters<typeof actual.createEndpointsService>[0]) => {
    captured.endpoints.push(deps)
    return actual.createEndpointsService(deps)
  } }
})
vi.mock('../../src/notifications/preferences-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/notifications/preferences-service')>()
  return { ...actual, createPreferencesService: (deps: Parameters<typeof actual.createPreferencesService>[0]) => {
    captured.preferences.push(deps)
    return actual.createPreferencesService(deps)
  } }
})
vi.mock('../../src/notifications/test-send-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/notifications/test-send-service')>()
  return { ...actual, createNotificationTestSendService: (deps: Parameters<typeof actual.createNotificationTestSendService>[0]) => {
    captured.send.push(deps)
    return actual.createNotificationTestSendService(deps)
  } }
})

// This detects direct function injection in these inspected objects, not arbitrary callback closures.
function backgroundReferences(value: unknown, path = 'deps'): string[] {
  if (value === resolveEffectiveNotificationCapabilityForBackground) return [path]
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) => backgroundReferences(child, `${path}.${key}`))
}

const RESOLVER_KEYS = ['deriveDefaultTarget', 'deriveDefaultTargets', 'listCandidates', 'resolveForConnection', 'resolveMany', 'verifyEndpoint', 'verifyEndpoints']

describe('background capability request-wiring boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    captured.endpoints.length = 0
    captured.preferences.length = 0
    captured.send.length = 0
  })

  it('keeps the actual production database and recipient dependencies free of the background authority', () => {
    const db = productionNotificationDbDeps()
    const resolver = productionRecipientResolver()
    expect(Object.keys(db).sort()).toEqual(['db', 'transaction'])
    expect(Object.keys(db.db)).toEqual(['query'])
    expect(Object.keys(resolver).sort()).toEqual(RESOLVER_KEYS)
    expect(backgroundReferences({ db, resolver })).toEqual([])
    expect(query).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
  })

  it('observes all three production request factories without injecting a background function', () => {
    meNotificationEndpointsRouter()
    meNotificationPreferencesRouter()
    meNotificationTestSendRouter()
    const expected = {
      endpoints: ['audit', 'connectionVerified', 'db', 'deliveryEnabled', 'resolver', 'transaction'],
      preferences: ['audit', 'db', 'resolver', 'transaction'],
      send: ['checkConnection', 'db', 'isDeliveryEnabled', 'isPreferencesEnabled', 'onOutcome', 'prepareBudgetMs', 'resolver', 'transaction'],
    }
    for (const kind of ['endpoints', 'preferences', 'send'] as const) {
      expect(captured[kind]).toHaveLength(1)
      const deps = captured[kind][0] as Record<string, unknown>
      expect(Object.keys(deps).sort()).toEqual(expected[kind])
      expect(Object.keys(deps.resolver as object).sort()).toEqual(RESOLVER_KEYS)
      expect(backgroundReferences(deps)).toEqual([])
    }
    expect((captured.send[0] as Record<string, unknown>).checkConnection).toBe(productionNotificationConnectionReadiness)
    expect(query).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
  })

  it.each(['extra', 'checkConnection', 'resolver'])('detects finite %s injection in the inspected production assembly', (slot) => {
    meNotificationTestSendRouter()
    const original = captured.send[0] as Record<string, unknown>
    expect(backgroundReferences(original)).toEqual([])
    const changed = slot === 'resolver'
      ? { ...original, resolver: { ...original.resolver as object, verifyEndpoint: resolveEffectiveNotificationCapabilityForBackground } }
      : { ...original, [slot]: resolveEffectiveNotificationCapabilityForBackground }
    expect(backgroundReferences(changed)).toEqual([slot === 'resolver' ? 'deps.resolver.verifyEndpoint' : `deps.${slot}`])
    expect(backgroundReferences(original)).toEqual([])
  })

  it('executes TypeScript diagnostics for the entry signature and request dependency rejection', () => {
    const filename = resolve(__dirname, '__background-boundary.typecheck.ts')
    const source = `
import { resolveEffectiveNotificationCapabilityForBackground as background } from '../../src/integrations/integration-capability-resolve-background'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'
import type { NotificationDbDeps } from '../../src/notifications/notification-tx'
import type { RecipientResolverDeps } from '../../src/notifications/recipient-resolver'
import type { EndpointsServiceDeps } from '../../src/notifications/endpoints-service'
import type { PreferencesServiceDeps } from '../../src/notifications/preferences-service'
import type { NotificationTestSendDeps } from '../../src/notifications/test-send-service'
import type { MeNotificationEndpointsRouterDeps } from '../../src/routes/me-notification-endpoints'
import type { MeNotificationPreferencesRouterDeps } from '../../src/routes/me-notification-preferences'
import type { MeNotificationTestSendRouterDeps } from '../../src/routes/me-notification-test-send'
declare const executor: Queryable
const input = { integrationId: '11111111-1111-4111-8111-111111111111', eventOrgId: 'org-alpha' }
background(executor, input)
// Structural variables may have extra fields; the runtime entry checks exact keys.
const structural = { ...input, capability: 'notification' }
background(executor, structural)
// @ts-expect-error The caller cannot add a third position argument.
background(executor, input, background)
// @ts-expect-error Both position arguments are required.
background(executor)
// @ts-expect-error A fresh input cannot choose a capability.
background(executor, { ...input, capability: 'notification' })
// @ts-expect-error A fresh input cannot choose a source.
background(executor, { ...input, orgSource: 'authenticated_tenant' })
// @ts-expect-error The event organization is mandatory.
background(executor, { integrationId: input.integrationId })
declare const db: NotificationDbDeps
declare const resolver: RecipientResolverDeps
declare const endpoints: EndpointsServiceDeps
declare const preferences: PreferencesServiceDeps
declare const send: NotificationTestSendDeps
declare const endpointsRoute: MeNotificationEndpointsRouterDeps
declare const preferencesRoute: MeNotificationPreferencesRouterDeps
declare const sendRoute: MeNotificationTestSendRouterDeps
// @ts-expect-error Request database dependencies do not expose background authority.
const badDb: NotificationDbDeps = { ...db, background }
// @ts-expect-error Recipient dependencies do not expose background authority.
const badResolver: RecipientResolverDeps = { ...resolver, background }
// @ts-expect-error Request service dependencies do not expose background authority.
const badEndpoints: EndpointsServiceDeps = { ...endpoints, background }
// @ts-expect-error Request service dependencies do not expose background authority.
const badPreferences: PreferencesServiceDeps = { ...preferences, background }
// @ts-expect-error Request service dependencies do not expose background authority.
const badSend: NotificationTestSendDeps = { ...send, background }
// @ts-expect-error Background signature is not an authenticated connection-readiness callback.
const badReadiness: NotificationTestSendDeps = { ...send, checkConnection: background }
// @ts-expect-error Request route dependencies do not expose background authority.
const badEndpointsRoute: MeNotificationEndpointsRouterDeps = { ...endpointsRoute, background }
// @ts-expect-error Request route dependencies do not expose background authority.
const badPreferencesRoute: MeNotificationPreferencesRouterDeps = { ...preferencesRoute, background }
// @ts-expect-error Request route dependencies do not expose background authority.
const badSendRoute: MeNotificationTestSendRouterDeps = { ...sendRoute, background }
`
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true,
      esModuleInterop: true, skipLibCheck: true, noEmit: true, types: ['node'],
    }
    const host = ts.createCompilerHost(options)
    const getSourceFile = host.getSourceFile.bind(host)
    host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => name === filename
      ? ts.createSourceFile(name, source, languageVersion, true)
      : getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile)
    const program = ts.createProgram([filename], options, host)
    const fixture = program.getSourceFile(filename)!
    const diagnostics = [...program.getSyntacticDiagnostics(fixture), ...program.getSemanticDiagnostics(fixture)]
    expect(diagnostics.map((diagnostic) => ({
      code: diagnostic.code, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    }))).toEqual([])
  })
})
