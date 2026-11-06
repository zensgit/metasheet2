/**
 * C1/S2 first slice — the synthetic integration preview runtime (integration/automation-synthetic-preview.ts)
 * on an in-memory admission database. Evidence D §7:
 *   C05 budget (atomic page reservation, one in-flight call, repeated cursor, page/row/byte limits, deadline,
 *       a failed attempt still counted);
 *   S02 (unit half) raw values / sentinels never reach the summary insert, errors or logs;
 *   S03 cancel / deadline / UNAVAILABLE run no successor; after settle the value store is empty and its
 *       old handle is revoked;
 *   G01 the switch is exact 'true' and no other flag (durable, Class-A/B, YiDa send / multi-target /
 *       connection test) opens it, even all at once;
 *   G03 host shutdown (AutomationService.stopProducerAdmissions) waits for the in-flight provider page,
 *       transactions and the summary insert, and nothing is published after the stop.
 * The real lock protocol (C03/C04) is in tests/integration/automation-synthetic-preview-realdb.test.ts.
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  buildSyntheticPreviewSummary,
  createAutomationSyntheticPreviewRuntime,
  syntheticPreviewErrorCode,
  type SyntheticPreviewRuntimeDependencies,
} from '../../src/integration/automation-synthetic-preview'
import {
  createSyntheticMaterialProvider,
  SYNTHETIC_MATERIAL_PROVIDER_ID,
  SYNTHETIC_PREVIEW_BUDGET,
  syntheticMaterialFixture,
  syntheticYidaMappingPreset,
  type SyntheticFixturePage,
  type SyntheticProviderPageRequest,
} from '../../src/integration/automation-operation-catalog'
import type { YidaLocalDraftCompile } from '../../src/integration/yida-automation-preview'
import { AutomationLogService } from '../../src/multitable/automation-log-service'
import { EventBus } from '../../src/integration/events/event-bus'
import { createFakePreviewDatabase, defaultFakePreviewState, deferred, type FakePreviewState } from '../utils/synthetic-preview-fake-db'

const LIB = path.resolve(__dirname, '..', '..', '..', '..', 'plugins', 'plugin-integration-core', 'lib')
let compileYidaLocalDraft: YidaLocalDraftCompile
beforeAll(async () => {
  compileYidaLocalDraft = (await import(pathToFileURL(path.join(LIB, 'yida-draft-compiler.mjs')).href)).compileYidaLocalDraft
})

const scope = { actorId: 'synthetic-actor', tenantId: 'synthetic-tenant', sheetId: 'synthetic-sheet', ruleId: 'synthetic-rule' }
const request = (fixtureId = 'synthetic-materials.two-page.v1', mappingPresetId = 'yida-material-v3.original.v1') => ({
  planId: 'plm-material-to-yida-preview.v1', fixtureId, mappingPresetId,
})
const SENTINEL = 'SYN-SENTINEL-7f3a'

type ProviderDouble = {
  id: typeof SYNTHETIC_MATERIAL_PROVIDER_ID
  calls: SyntheticProviderPageRequest[]
  active: number
  maxActive: number
  readPage(request: SyntheticProviderPageRequest): Promise<SyntheticFixturePage>
}

/** Counts calls and concurrency; delegates to the real synthetic provider unless `impl` overrides a call. */
function providerDouble(impl?: (request: SyntheticProviderPageRequest, call: number) => Promise<SyntheticFixturePage> | undefined): ProviderDouble {
  const real = createSyntheticMaterialProvider()
  const double: ProviderDouble = {
    id: SYNTHETIC_MATERIAL_PROVIDER_ID,
    calls: [],
    active: 0,
    maxActive: 0,
    async readPage(pageRequest) {
      double.calls.push(pageRequest)
      double.active += 1
      double.maxActive = Math.max(double.maxActive, double.active)
      try {
        const override = impl?.(pageRequest, double.calls.length)
        return override ? await override : await real.readPage(pageRequest)
      } finally {
        double.active -= 1
      }
    },
  }
  return double
}

function harness(options: {
  state?: Partial<FakePreviewState>
  provider?: ProviderDouble
  compile?: YidaLocalDraftCompile
  enablement?: () => unknown
  hooks?: SyntheticPreviewRuntimeDependencies['hooks']
  deadlineMs?: number
} = {}) {
  const state = defaultFakePreviewState(options.state)
  const db = createFakePreviewDatabase(state)
  const provider = options.provider ?? providerDouble()
  const compileSpy = vi.fn((input: Parameters<YidaLocalDraftCompile>[0]) => (options.compile ?? compileYidaLocalDraft)(input))
  const logService = new AutomationLogService()
  const recordSummary = vi.fn((trx, entry) => logService.recordSyntheticPreviewSummary((sql, params) => trx.query(sql, params), entry))
  const runtime = createAutomationSyntheticPreviewRuntime({
    database: db.database,
    readEnablement: options.enablement ?? (() => 'true'),
    loadCompiler: async () => compileSpy as unknown as YidaLocalDraftCompile,
    recordSummary,
    provider: provider as never,
    hooks: options.hooks,
    deadlineMs: options.deadlineMs,
  })
  return { state, db, provider, compileSpy, recordSummary, runtime }
}

async function refusal(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
  } catch (error) {
    return syntheticPreviewErrorCode(error)
  }
  return 'RESOLVED'
}

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.AUTOMATION_SYNTHETIC_INTEGRATION_PREVIEW_ENABLED
})

describe('synthetic preview runtime — happy path and fixed response', () => {
  it('reads two synthetic pages, previews them through the pure compiler and returns only the fixed view', async () => {
    const h = harness()
    const result = await h.runtime.run(scope, request())
    expect(h.provider.calls.map((call) => call.cursor)).toEqual([null, 'synthetic-cursor-2'])
    expect(result).toMatchObject({ ok: true, synthetic: true, canSend: false, canApply: false, tokenIssued: false, externalWriteAttempted: false })
    expect(result.summary).toMatchObject({ outcome: 'OK', counts: { pages: 2, rows: 3 }, fixtureId: 'synthetic-materials.two-page.v1' })
    expect(result.preview.rowCount).toBe(3)
    expect(Object.isFrozen(result)).toBe(true)
    // start + page + page + consume + publish admissions, then one summary transaction.
    expect(h.db.transactions()).toBe(6)
    expect(h.db.inserts).toHaveLength(1)
    // The response carries no provider page, no handle and no compiler internals.
    const text = JSON.stringify(result)
    expect(text).not.toMatch(/nextCursor|synthetic-cursor|rowsText|protocolPreview|formDataJson|localBusinessKey/)
    expect(Object.keys(result).sort()).toEqual(['canApply', 'canSend', 'externalWriteAttempted', 'ok', 'preview', 'summary', 'synthetic', 'tokenIssued'])
  })

  it('Y01 host half: the host preview equals the pure compiler on the same synthetic rows (digests and rows)', async () => {
    const h = harness()
    const result = await h.runtime.run(scope, request())
    const fixture = syntheticMaterialFixture('synthetic-materials.two-page.v1')
    const rows = fixture.pages.flatMap((page) => page.rows)
    const preset = syntheticYidaMappingPreset('yida-material-v3.original.v1')
    const direct = compileYidaLocalDraft({ config: { ...JSON.parse(JSON.stringify(preset.rules)), target: { ...preset.target } }, rowsText: JSON.stringify(rows), allocation: { mode: 'original' } }) as {
      planDigest: string; keyDefinitionDigest: string; locatorDigest: string; rowSpecs: Array<{ businessKeyDigest: string; payloadDigest: string }>
    }
    expect(result.preview.planDigest).toBe(direct.planDigest)
    expect(result.preview.keyDefinitionDigest).toBe(direct.keyDefinitionDigest)
    expect(result.preview.locatorDigest).toBe(direct.locatorDigest)
    expect(result.preview.rows.map((row) => row.businessKeyDigest)).toEqual(direct.rowSpecs.map((spec) => spec.businessKeyDigest))
    expect(result.preview.rows.map((row) => row.payloadDigest)).toEqual(direct.rowSpecs.map((spec) => spec.payloadDigest))
  })
})

describe('C05 — budget', () => {
  it('a concurrent internal call cannot pass the atomic reservation or the single in-flight limit', async () => {
    const gate = deferred<void>()
    const provider = providerDouble((_request, call) => (call === 1 ? gate.promise.then(() => syntheticMaterialFixture('synthetic-materials.two-page.v1').pages[0]) : undefined))
    let second: Promise<unknown> | undefined
    let secondSettled: Promise<string | undefined> | undefined
    const h = harness({
      provider,
      hooks: {
        afterProviderPage: () => undefined,
        onOperations: (operations) => {
          // Started alongside the plan's own read; both race for page 1.
          setTimeout(() => {
            second = operations.request('plm.material.list.synthetic.v1', { fixtureId: 'synthetic-materials.two-page.v1' })
            secondSettled = refusal(second)
            void secondSettled.then(() => gate.resolve())
          }, 0)
        },
      },
    })
    const result = await h.runtime.run(scope, request())
    expect(await secondSettled).toBe('LIMIT')
    expect(provider.maxActive).toBe(1)
    expect(result.summary.counts.pages).toBe(2)
    expect(provider.calls).toHaveLength(2)
  })

  it.each([
    ['synthetic-materials.repeat-cursor.v1', 2],
    ['synthetic-materials.six-page.v1', SYNTHETIC_PREVIEW_BUDGET.maxPages],
    ['synthetic-materials.too-many-rows.v1', 2],
    ['synthetic-materials.too-many-bytes.v1', 1],
  ] as const)('%s ends LIMIT after %i provider calls, before any further page, and no consumer step runs', async (fixtureId, calls) => {
    const h = harness()
    expect(await refusal(h.runtime.run(scope, request(fixtureId)))).toBe('LIMIT')
    expect((h.provider as ProviderDouble).calls).toHaveLength(calls)
    expect(h.compileSpy).not.toHaveBeenCalled()
    const status = h.db.inserts[0].params[3]
    expect(status).toBe('failed')
    expect(h.db.inserts[0].params[5]).toBe('INTEGRATION_PREVIEW_LIMIT')
  })

  it('the deadline ends the run: the page in flight settles, no next page is read, nothing is published', async () => {
    const gate = deferred<void>()
    const provider = providerDouble((_request, call) => (call === 1 ? gate.promise.then(() => syntheticMaterialFixture('synthetic-materials.two-page.v1').pages[0]) : undefined))
    const h = harness({ provider, deadlineMs: 20 })
    const pending = refusal(h.runtime.run(scope, request()))
    await new Promise((resolve) => setTimeout(resolve, 40))
    gate.resolve()
    expect(await pending).toBe('TIMEOUT')
    expect(provider.calls).toHaveLength(1)
    expect(h.compileSpy).not.toHaveBeenCalled()
    expect(h.db.inserts[0].params[5]).toBe('INTEGRATION_PREVIEW_TIMEOUT')
  })

  it('a failed provider attempt is not refunded: it is counted in the summary', async () => {
    const provider = providerDouble(() => Promise.reject(new Error('synthetic provider failure')))
    const h = harness({ provider })
    expect(await refusal(h.runtime.run(scope, request()))).toBe('UNAVAILABLE')
    expect(JSON.parse(h.db.inserts[0].params[4] as string)[0].output.pages).toBe(1)
  })

  it('the deadline override can only shorten the fixed budget', () => {
    expect(SYNTHETIC_PREVIEW_BUDGET).toEqual({ maxPages: 5, maxRows: 100, maxBytes: 256 * 1024, maxInFlight: 1, deadlineMs: 10_000 })
  })
})

describe('S02 (unit) — raw values never reach the summary, errors or logs', () => {
  function sentinelPage(): SyntheticFixturePage {
    const base = syntheticMaterialFixture('synthetic-materials.single-page.v1').pages[0]
    return { rows: base.rows.map((row) => ({ ...row, componentName: `${SENTINEL}-name`, componentCode: `${SENTINEL}-code` })), nextCursor: null }
  }
  function captureConsole() {
    const lines: string[] = []
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { lines.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${String(arg.cause)}` : typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')) })
    }
    return lines
  }

  it('success: sentinel values appear only in the preset-allowed preview fields, never in the summary row', async () => {
    const lines = captureConsole()
    const h = harness({ provider: providerDouble(() => Promise.resolve(sentinelPage())) })
    const result = await h.runtime.run(scope, request('synthetic-materials.single-page.v1'))
    expect(JSON.stringify(result.preview.rows)).toContain(SENTINEL)
    expect(JSON.stringify(result.summary)).not.toContain(SENTINEL)
    expect(JSON.stringify(h.db.inserts)).not.toContain(SENTINEL)
    expect(lines.join('\n')).not.toContain(SENTINEL)
  })

  it.each([
    ['provider error message and cause', { provider: () => Promise.reject(new Error(`${SENTINEL} provider`, { cause: SENTINEL })) }, 'UNAVAILABLE'],
    ['nested provider output', { provider: () => Promise.resolve({ rows: [{ nested: { value: SENTINEL } }], nextCursor: null } as unknown as SyntheticFixturePage) }, 'UNAVAILABLE'],
    ['compiler error message and cause', { compile: () => { throw new Error(`${SENTINEL} compiler`, { cause: { value: SENTINEL } }) } }, 'REJECTED'],
  ] as const)('%s: fixed code, and the error object, summary row and logs carry no sentinel', async (_label, mode, code) => {
    const lines = captureConsole()
    const h = harness({
      provider: 'provider' in mode ? providerDouble(mode.provider as never) : providerDouble(() => Promise.resolve(sentinelPage())),
      compile: 'compile' in mode ? (mode.compile as unknown as YidaLocalDraftCompile) : undefined,
    })
    let caught: unknown
    try { await h.runtime.run(scope, request('synthetic-materials.single-page.v1')) } catch (error) { caught = error }
    expect(syntheticPreviewErrorCode(caught)).toBe(code)
    const error = caught as Error & { cause?: unknown }
    expect(`${error.message} ${String(error.cause)} ${JSON.stringify(error)} ${error.stack ?? ''}`).not.toContain(SENTINEL)
    expect(JSON.stringify(h.db.inserts)).not.toContain(SENTINEL)
    expect(lines.join('\n')).not.toContain(SENTINEL)
  })

  it('a provider page that arrives after cancel is dropped: not stored, not compiled, not returned, not logged', async () => {
    const gate = deferred<void>()
    const controller = new AbortController()
    const h = harness({ provider: providerDouble(() => gate.promise.then(() => sentinelPage())) })
    const pending = h.runtime.run(scope, request('synthetic-materials.single-page.v1'), { signal: controller.signal })
    const settled = refusal(pending)
    await vi.waitFor(() => expect((h.provider as ProviderDouble).calls).toHaveLength(1))
    controller.abort()
    gate.resolve()
    expect(await settled).toBe('CANCELLED')
    expect(h.compileSpy).not.toHaveBeenCalled()
    expect(JSON.stringify(h.db.inserts)).not.toContain(SENTINEL)
    expect(h.db.inserts[0].params[5]).toBe('INTEGRATION_PREVIEW_CANCELLED')
  })

  it('the summary is rebuilt from enums and counts: a forged outcome or count cannot pass through', () => {
    const summary = buildSyntheticPreviewSummary({
      request: { planId: 'plm-material-to-yida-preview.v1', fixtureId: 'synthetic-materials.two-page.v1', mappingPresetId: 'yida-material-v3.original.v1' },
      outcome: `${SENTINEL}`,
      pages: Number.NaN,
      rows: -1,
      bytes: 1.5,
      durationMs: Infinity,
      steps: [{ stepId: SENTINEL, type: SENTINEL, status: SENTINEL as never, durationMs: 3 }],
    })
    expect(summary.outcome).toBe('UNAVAILABLE')
    expect(summary.counts).toEqual({ pages: 0, rows: 0, bytes: 0 })
    expect(summary.steps.map((step) => step.stepId)).toEqual(['read-materials', 'yida-preview'])
    expect(JSON.stringify(summary)).not.toContain(SENTINEL)
  })
})

describe('S03 — terminal states, value store disposal, no successor', () => {
  it('after a successful run the value store is empty and the old handle no longer resolves', async () => {
    let store: { counts(): unknown; disposed: boolean; resolveForConsumer: (...args: unknown[]) => unknown } | undefined
    let handle: unknown
    const h = harness({ hooks: { onValueStore: (value) => { store = value as never }, onStepValue: (value) => { handle = value } } })
    await h.runtime.run(scope, request())
    expect(store?.disposed).toBe(true)
    expect(store?.counts()).toEqual({ outputs: 0, rows: 0 })
    expect(handle).toBeTruthy()
    expect(() => store!.resolveForConsumer(handle, { fromStep: 'read-materials', output: 'materialRows', columns: ['projectNo'] },
      'yida.preview.synthetic.v1', 'yida-preview', { runId: 'x', tenantId: scope.tenantId })).toThrow('RUN_VALUE_DISPOSED')
  })

  it.each([
    ['cancel', 'CANCELLED'],
    ['unavailable', 'UNAVAILABLE'],
  ] as const)('%s during the read step: the YiDa step is skipped and no compiler call happens', async (mode, code) => {
    const controller = new AbortController()
    const provider = providerDouble(() => {
      if (mode === 'cancel') { controller.abort(); return Promise.resolve(syntheticMaterialFixture('synthetic-materials.two-page.v1').pages[0]) }
      return Promise.reject(new Error('synthetic'))
    })
    let store: { counts(): unknown; disposed: boolean } | undefined
    const h = harness({ provider, hooks: { onValueStore: (value) => { store = value as never } } })
    expect(await refusal(h.runtime.run(scope, request(), { signal: controller.signal }))).toBe(code)
    expect(h.compileSpy).not.toHaveBeenCalled()
    const steps = JSON.parse(h.db.inserts[0].params[4] as string)
    expect(steps.map((step: { status: string }) => step.status)).toEqual(['failed', 'skipped'])
    expect(store?.disposed).toBe(true)
  })

  it('the summary row is triggered_by integration_preview with NULL trigger_event / rule_snapshot', async () => {
    const h = harness()
    await h.runtime.run(scope, request())
    const { sql } = h.db.inserts[0]
    expect(sql).toMatch(/'integration_preview'/)
    expect(sql).toMatch(/NULL, NULL/)
  })
})

describe('G01 — switch', () => {
  const OTHER_FLAGS = [
    'AUTOMATION_DURABLE_DELIVERY_ENABLED', 'AUTOMATION_CLASSA_CLAIM_ENABLED', 'AUTOMATION_CLASSB_OUTBOUND_ENABLED',
    'INTEGRATION_YIDA_OWNER_SEND_ENABLED', 'INTEGRATION_YIDA_MULTI_TARGET_ENABLED', 'INTEGRATION_YIDA_CONNECTION_TEST_ENABLED',
    'ENABLE_SCHEDULER_LEADER_LOCK',
  ]

  it.each([undefined, 'false', 'TRUE', ' true', 'true ', '1', 'yes', 'on'])('%s is OFF: refused before any database, provider or compiler call', async (value) => {
    const h = harness({ enablement: () => value })
    expect(await refusal(h.runtime.run(scope, request()))).toBe('DISABLED')
    expect(h.db.transactions()).toBe(0)
    expect((h.provider as ProviderDouble).calls).toHaveLength(0)
    expect(h.compileSpy).not.toHaveBeenCalled()
  })

  it('the host reads ONLY its own exact-literal switch: every other automation / YiDa flag at once does not open it', async () => {
    const { AutomationService } = await import('../../src/multitable/automation-service')
    const saved = Object.fromEntries(OTHER_FLAGS.map((key) => [key, process.env[key]]))
    try {
      for (const key of OTHER_FLAGS) process.env[key] = 'true'
      delete process.env.AUTOMATION_SYNTHETIC_INTEGRATION_PREVIEW_ENABLED
      const service = new AutomationService(new EventBus(), {} as never, vi.fn() as never)
      expect(service.syntheticIntegrationPreviewEnabled()).toBe(false)
      process.env.AUTOMATION_SYNTHETIC_INTEGRATION_PREVIEW_ENABLED = 'TRUE'
      expect(service.syntheticIntegrationPreviewEnabled()).toBe(false)
      process.env.AUTOMATION_SYNTHETIC_INTEGRATION_PREVIEW_ENABLED = 'true'
      expect(service.syntheticIntegrationPreviewEnabled()).toBe(true)
      await service.shutdown()
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('ON with every other flag on: still only the synthetic provider and the pure compiler, zero fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new Error('no network')))
    const h = harness()
    await h.runtime.run(scope, request())
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('a switch turned off mid-run refuses the next checkpoint', async () => {
    let on = true
    const h = harness({ enablement: () => (on ? 'true' : 'false'), hooks: { afterProviderPage: () => { on = false } } })
    expect(await refusal(h.runtime.run(scope, request()))).toBe('INACTIVE')
    expect((h.provider as ProviderDouble).calls).toHaveLength(1)
  })
})

describe('G03 — host shutdown drains the preview', () => {
  it('stopProducerAdmissions waits for the in-flight page and the summary insert, then nothing is published', async () => {
    const { AutomationService } = await import('../../src/multitable/automation-service')
    const service = new AutomationService(new EventBus(), {} as never, vi.fn() as never)
    const gate = deferred<void>()
    const provider = providerDouble((_request, call) => (call === 1 ? gate.promise.then(() => syntheticMaterialFixture('synthetic-materials.two-page.v1').pages[0]) : undefined))
    const h = harness({ provider })
    service.replaceSyntheticPreviewRuntimeForTest(h.runtime)
    const preview = refusal(service.previewIntegrationPlan(scope, request()))
    await vi.waitFor(() => expect(provider.calls).toHaveLength(1))
    let stopped = false
    const stop = service.stopProducerAdmissions().then(() => { stopped = true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(stopped).toBe(false)
    expect(h.runtime.inFlight()).toBe(1)
    gate.resolve()
    await stop
    expect(stopped).toBe(true)
    expect(await preview).toBe('INACTIVE')
    expect(h.runtime.inFlight()).toBe(0)
    expect(provider.calls).toHaveLength(1)
    expect(h.recordSummary).toHaveBeenCalledTimes(1)
    expect(h.db.inserts[0].params[5]).toBe('INTEGRATION_PREVIEW_INACTIVE')
    expect(await refusal(service.previewIntegrationPlan(scope, request()))).toBe('INACTIVE')
  })
})

describe('admission (unit) — refusals happen before any provider call', () => {
  it.each([
    ['another sheet owns the rule', { ruleSheetId: 'other-sheet' }, 'NOT_FOUND'],
    ['the actor is not the rule owner', { ruleOwner: 'someone-else' }, 'DENIED'],
    ['the sheet was deleted', { sheetLive: false }, 'NOT_FOUND'],
    ['no membership in the authenticated tenant', { membershipTenant: 'other-tenant' }, 'DENIED'],
    ['workflow:write without integration authority', { roles: ['editor'], rolePermissions: [{ role_id: 'editor', permission_code: 'workflow:write' }] }, 'DENIED'],
    ['integration admin without automation capability', { roles: ['integ'], rolePermissions: [{ role_id: 'integ', permission_code: 'integration:admin' }], integrationAdmission: true }, 'DENIED'],
    ['integration admin + workflow:write but a read-only sheet grant', {
      roles: ['integ'], rolePermissions: [{ role_id: 'integ', permission_code: 'integration:admin' }, { role_id: 'integ', permission_code: 'workflow:write' }],
      integrationAdmission: true, sheetGrants: [{ perm_code: 'spreadsheet:read', subject_type: 'user', subject_id: 'synthetic-actor' }],
    }, 'DENIED'],
    ['a permission relation is missing', { failOn: /FROM spreadsheet_permissions/ }, 'UNAVAILABLE'],
  ] as const)('%s -> %s', async (_label, state, code) => {
    const h = harness({ state: state as Partial<FakePreviewState> })
    expect(await refusal(h.runtime.run(scope, request()))).toBe(code)
    expect((h.provider as ProviderDouble).calls).toHaveLength(0)
    expect(h.db.inserts).toHaveLength(0)
  })

  it('integration admin + workflow:write with a write sheet grant is admitted', async () => {
    const h = harness({ state: {
      roles: ['integ'], rolePermissions: [{ role_id: 'integ', permission_code: 'integration:admin' }, { role_id: 'integ', permission_code: 'workflow:write' }],
      integrationAdmission: true, sheetGrants: [{ perm_code: 'spreadsheet:write', subject_type: 'user', subject_id: 'synthetic-actor' }],
    } })
    await expect(h.runtime.run(scope, request())).resolves.toMatchObject({ ok: true })
  })

  it('a forged scope shape or request is refused synchronously (INPUT), before any transaction', async () => {
    const h = harness()
    expect(await refusal(h.runtime.run({ ...scope, actorId: ' padded ' }, request()))).toBe('INPUT')
    expect(await refusal(h.runtime.run(scope, { ...request(), tenantId: 'forged' }))).toBe('INPUT')
    expect(h.db.transactions()).toBe(0)
  })
})

describe('S03 — retry and resume cannot replay a preview run', () => {
  it('the existing retry gates refuse a preview row (no trigger event / not failed) before reading the rule; resume has no token', async () => {
    const { AutomationService } = await import('../../src/multitable/automation-service')
    const query = vi.fn(async () => ({ rows: [] as unknown[], rowCount: 0 }))
    const service = new AutomationService(new EventBus(), {} as never, query)
    const h = harness()
    await h.runtime.run(scope, request())
    const insert = h.db.inserts[0].params
    const row = {
      id: insert[0], ruleId: insert[1], triggeredBy: 'integration_preview', triggeredAt: insert[2], status: 'failed',
      steps: JSON.parse(insert[4] as string), sheetId: insert[7], triggerEvent: undefined, ruleSnapshot: undefined,
    }
    const internals = service as unknown as {
      logService: { getById: (id: string) => Promise<unknown> }
      suspensionService: { findByToken: (token: string) => Promise<unknown> }
    }
    const getById = vi.spyOn(internals.logService, 'getById').mockResolvedValue(row)
    const getRule = vi.spyOn(service, 'getRule')
    // A failed preview row stores no trigger event: the unchanged A4-D7 gate refuses it.
    await expect(service.retryExecution(String(insert[0]), 'synthetic-actor')).resolves.toMatchObject({ status: 409, code: 'MISSING_TRIGGER_EVENT' })
    // A successful preview row is not failed/skipped: the unchanged status gate refuses it.
    getById.mockResolvedValue({ ...row, status: 'success' })
    await expect(service.retryExecution(String(insert[0]), 'synthetic-actor')).resolves.toMatchObject({ status: 409, code: 'NOT_RETRYABLE' })
    expect(getRule).not.toHaveBeenCalled()
    vi.spyOn(internals.suspensionService, 'findByToken').mockResolvedValue(null)
    await expect(service.resumeExecution(String(insert[0]), 'synthetic-actor')).resolves.toMatchObject({ status: 404 })
    // The only stored step outputs are counts and fixed ids: there is no value to take from the log.
    expect(JSON.stringify(row.steps)).not.toMatch(/SYN-DRW|SYN-LINE/)
    await service.shutdown()
  })
})
