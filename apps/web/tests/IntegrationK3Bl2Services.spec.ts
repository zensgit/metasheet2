import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import {
  buildReadSourceConfigPayload,
  createK3WiseBomListByMaterialDraft,
  isK3WiseBomListByMaterialDraft,
  normalizeReadSourceConfigRow,
} from '../src/services/integration/readSourceConfigs'
import { K3Bl2ReadError, normalizeK3Bl2Key, readK3Bl2Bom } from '../src/services/integration/k3Bl2Runs'

// Actual backend validator -> prepare -> adapter -> resolver produces every positive fixture.
// The adapter's private synthetic fetch and the browser's fetch are separate, closed local seams.
const require = createRequire(import.meta.url)
const { K3WISE_BOM_LIST_BY_MATERIAL_PRESET: preset, bomListByMaterialContractViolation, K3_WISE_BOM_LIST_BY_MATERIAL_ERROR_CODES } = require('../../../plugins/plugin-integration-core/lib/read-source-bom-list-by-material-contract.cjs')
const { validateReadSourceConfig } = require('../../../plugins/plugin-integration-core/lib/read-source-config.cjs')
const { prepareConfiguredRead, executeConfiguredRead } = require('../../../plugins/plugin-integration-core/lib/read-source-read-runtime.cjs')
const { createK3WiseWebApiAdapter } = require('../../../plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs')
type Wire = Record<string, unknown>
const SYSTEM_ID = 'synthetic-k3-bl2'
const PRIVATE = 'SYNTHETIC_PRIVATE_NOT_EXPOSED'
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function actualConfig(readPath = '/K3API/BOM/GetList'): Wire {
  const result = validateReadSourceConfig({
    version: 7, systemId: SYSTEM_ID, requiredKind: preset.requiredKind, object: preset.object,
    mode: preset.mode, readPath, readMethod: preset.readMethod, operations: ['read'],
    keyField: preset.filterField, keyEncoding: 'numeric_id', containerPaths: [preset.rowContainerPath],
    resolverRule: 'exactly_one', fieldMap: [{ source: preset.outputField, target: 'bom_number' }],
  })
  expect(result.valid).toBe(true)
  expect(bomListByMaterialContractViolation(result.normalized)).toBeNull()
  return result.normalized
}

function savedRow(readPath?: string): Wire {
  return {
    id: 'saved-bl2', systemId: SYSTEM_ID, object: preset.object, mode: preset.mode,
    version: 7, status: 'approved', contentKey: 'synthetic-content-7', config: clone(actualConfig(readPath)),
  }
}

function setPath(object: Wire, path: string, value: unknown): void {
  const keys = path.split('.')
  let parent = object
  for (const key of keys.slice(0, -1)) parent = parent[key] as Wire
  parent[keys.at(-1)!] = value
}

async function runtimeFixture(rows: Wire[], envelope?: Wire): Promise<Wire> {
  const prepared = prepareConfiguredRead({ config: actualConfig(), inputs: { key: '00031415' } })
  const system = {
    id: SYSTEM_ID, kind: preset.requiredKind, role: 'source',
    credentials: { sessionId: 'synthetic-session' }, config: { baseUrl: 'https://synthetic-k3.invalid' },
  }
  const calls: Array<{ path: string; method: string | undefined; body: unknown }> = []
  const result = await executeConfiguredRead(prepared, {
    system,
    createAdapter: (overlaid: Wire) => createK3WiseWebApiAdapter({
      system: overlaid,
      fetchImpl: async (url: string, init: RequestInit) => {
        calls.push({ path: new URL(url).pathname, method: init.method, body: JSON.parse(String(init.body)) })
        return new Response(JSON.stringify(envelope ?? {
          StatusCode: 200, Message: PRIVATE,
          Data: { ROWCOUNT: rows.length, PAGESIZE: 10, PAGEINDEX: 1, DATA: rows },
        }), { status: 200 })
      },
    }),
  })
  expect(calls).toEqual([{
    path: '/K3API/BOM/GetList', method: 'POST',
    body: { Data: { Top: 10, PageSize: 10, PageIndex: 1, Filter: '[FPercentItemID] = 00031415', OrderBy: '', SelectPage: 2, Fields: 'FBOMNumber' } },
  }])
  expect(JSON.stringify(result.evidence)).not.toContain(PRIVATE)
  return clone(result) as Wire
}

describe('BL2 canonical shortcut and full saved-config eligibility', () => {
  it.each(['/K3API/BOM/GetList', '/BOM/GetList', '/deployment/v2/BOM/GetList'])('matches actual normalized BL2 contract at %s', (path) => {
    const draft = createK3WiseBomListByMaterialDraft(SYSTEM_ID, path)
    expect(isK3WiseBomListByMaterialDraft(draft)).toBe(true)
    const payload = buildReadSourceConfigPayload(draft)
    expect(payload).toEqual({ ...actualConfig(path), version: 1 })
    expect(payload).not.toHaveProperty('actionProfileVersion')
    expect(prepareConfiguredRead({ config: payload, inputs: { key: '0001' } }).plan.object).toBe(preset.object)
    expect(normalizeReadSourceConfigRow(savedRow(path))?.k3Bl2Eligible).toBe(true)
  })

  it('normalizes an unprefixed path but compares hidden draft fields independently of payload stripping', () => {
    const draft = createK3WiseBomListByMaterialDraft(SYSTEM_ID, ' BOM/GetList ')
    expect(draft.readPath).toBe('/BOM/GetList')
    expect(isK3WiseBomListByMaterialDraft({ ...draft, readPath: ' BOM/GetList ' })).toBe(true)
    for (const field of ['headerContainerPaths', 'lineContainerPaths', 'multiplicityRuleField', 'resolverSortDirection', 'resolverDiscriminatorValue', 'actionProfileVersion']) {
      expect(isK3WiseBomListByMaterialDraft({ ...draft, [field]: 'leftover' }), field).toBe(false)
    }
    expect(isK3WiseBomListByMaterialDraft({ ...draft, version: 2 })).toBe(false)
  })

  it.each(['https://other.invalid/BOM/GetList', '//other/BOM/GetList', '/a/../BOM/GetList', '/a%2f/BOM/GetList', '/a\\BOM/GetList', '/BOM/GetDetail', '/BOM/GetList?extra=1'])('rejects unsafe or terminal drift %s', (path) => {
    expect(isK3WiseBomListByMaterialDraft(createK3WiseBomListByMaterialDraft(SYSTEM_ID, path))).toBe(false)
    const row = savedRow(); setPath(row, 'config.readPath', path); row.k3Bl2Eligible = true
    expect(normalizeReadSourceConfigRow(row)?.k3Bl2Eligible).toBe(false)
  })

  it('accepts reordered exact fields and store versions, but never a forged eligibility flag or hidden config drift', () => {
    const reordered = savedRow()
    reordered.config = Object.fromEntries(Object.entries(reordered.config as Wire).reverse())
    ;(reordered.config as Wire).fieldMap = [{ target: 'bom_number', source: 'FBOMNumber' }]
    expect(normalizeReadSourceConfigRow(reordered)?.k3Bl2Eligible).toBe(true)
    for (const [path, value] of [
      ['version', 0], ['version', Number.MAX_SAFE_INTEGER + 1], ['contentKey', ''], ['status', 'unknown'],
      ['systemId', 'other'], ['object', 'material'], ['mode', 'list_page'], ['config', null],
      ['config.version', 1], ['config.systemId', 'other'], ['config.requiredKind', 'http'],
      ['config.readMethod', 'GET'], ['config.operations', ['read', 'write']], ['config.keyField', 'FItemID'],
      ['config.keyEncoding', 'filter_expression'], ['config.containerPaths', ['Data']],
      ['config.resolverRule', 'first_when_sorted'], ['config.fieldMap', [{ source: 'FBOMNumber', target: 'other' }]],
      ['config.fieldMap', [{ source: 'FNumber', target: 'bom_number' }]], ['config.actionProfileVersion', 'synthetic.generic.v1'],
      ['config.orderingKeySpec', { field: 'FBOMNumber', direction: 'asc' }], ['config.headerContainerPaths', []],
      ['config.extra', true],
    ] as Array<[string, unknown]>) {
      const row = savedRow(); setPath(row, path, value); row.k3Bl2Eligible = true
      expect(normalizeReadSourceConfigRow(row)?.k3Bl2Eligible, path).toBe(false)
    }
    // Structural eligibility is not approval; the running panel still requires approved + active K3.
    for (const status of ['draft', 'retired']) expect(normalizeReadSourceConfigRow({ ...savedRow(), status })?.k3Bl2Eligible).toBe(true)
  })
})

describe('BL2 service through actual apiFetch with actual backend response fixtures', () => {
  let success: Wire
  let notFound: Wire
  let ambiguous: Wire
  let capped: Wire
  let missing: Wire
  let rejected: Wire
  let nextResponse: () => Promise<Response>
  const calls: Array<{ url: URL; init: RequestInit }> = []
  const respond = (data: unknown, status = 200) => new Response(JSON.stringify({ ok: true, data }), { status })

  beforeAll(async () => {
    ;[success, notFound, ambiguous, capped, missing, rejected] = await Promise.all([
      runtimeFixture([{ FBOMNumber: ' SYN-BOM-001 ', extra: PRIVATE }]), runtimeFixture([]),
      runtimeFixture([{ FBOMNumber: 'SYN-A' }, { FBOMNumber: 'SYN-B' }]),
      runtimeFixture(Array.from({ length: 10 }, () => ({ FBOMNumber: 'SYN-CAP' }))),
      runtimeFixture([{}]), runtimeFixture([], { StatusCode: 500, Message: PRIVATE, Data: PRIVATE }),
    ])
  })
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('auth_token', 'synthetic-session-token')
    localStorage.setItem('tenantId', 'synthetic-forged-hint')
    calls.length = 0
    nextResponse = async () => respond(success)
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url: new URL(url), init })
      return nextResponse()
    }))
  })
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear() })

  it('accepts the exact real evaluator shape (boundedSmoke false), returning only the original bounded value', async () => {
    expect(success.evidence).toEqual({
      ok: true, object: 'material-bom-list', mode: 'resolver_lookup', boundedSmoke: false,
      containers: { primary: { type: 'array', arrayLength: 1 } }, candidateCount: 1, matchedCount: 1,
      containerLocated: true, resolved: true, rule: 'exactly_one',
    })
    const result = await readK3Bl2Bom('saved/bl2', ' 00031415 ', 'synthetic workspace')
    expect(result).toEqual({ value: ' SYN-BOM-001 ' })
    expect(calls).toHaveLength(1)
    expect(calls[0].url.pathname).toBe('/api/integration/read-source-configs/saved%2Fbl2/read')
    expect([...calls[0].url.searchParams.entries()]).toEqual([['workspaceId', 'synthetic workspace']])
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ inputs: { key: '00031415' } })
    const headers = new Headers(calls[0].init.headers)
    expect(headers.has('x-tenant-id')).toBe(false)
    expect(headers.get('authorization')).toBe('Bearer synthetic-session-token')
    expect(JSON.stringify(result)).not.toContain(PRIVATE)
  })

  it('omits absent workspace, preserves all 20 digits, and never stores the business key', async () => {
    const before = { ...localStorage }
    await readK3Bl2Bom('saved-bl2', '90071992547409931234', null)
    expect(calls[0].url.search).toBe('')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ inputs: { key: '90071992547409931234' } })
    expect({ ...localStorage }).toEqual(before)
  })

  it.each([null, undefined, true, 123, Number.MAX_SAFE_INTEGER + 1, {}, [], '', ' ', '9'.repeat(21), '-1', '1.0', '1e2', '１２', '1 OR 1=1'])('rejects invalid string-only key %j with zero POST', async (key) => {
    expect(normalizeK3Bl2Key(key)).toBeNull()
    await expect(readK3Bl2Bom('saved-bl2', key as string)).rejects.toMatchObject({ name: 'K3Bl2ReadError', code: 'K3_WISE_BOM_LIST_BY_MATERIAL_KEY_INVALID' })
    expect(calls).toHaveLength(0)
  })

  it('retains the exact allowlisted actual failure family and never exposes a failed response data plane', async () => {
    for (const [fixture, code] of [[notFound, 'NOT_FOUND'], [ambiguous, 'AMBIGUOUS'], [capped, 'AMBIGUOUS'], [missing, 'FIELD_MISSING'], [rejected, 'REJECTED']] as const) {
      nextResponse = async () => respond({ ...fixture, data: { resolver: { target: 'bom_number', value: PRIVATE } } })
      await expect(readK3Bl2Bom('saved-bl2', '1')).rejects.toMatchObject({ message: `K3_WISE_BOM_LIST_BY_MATERIAL_${code}`, code: `K3_WISE_BOM_LIST_BY_MATERIAL_${code}` })
    }
    expect(calls).toHaveLength(5)
  })

  it('clamps unknown error codes and all upstream text, with exact registry parity', async () => {
    for (const code of K3_WISE_BOM_LIST_BY_MATERIAL_ERROR_CODES) expect(new K3Bl2ReadError(code).code).toBe(code)
    for (const code of [PRIVATE, 'K3_WISE_BOM_LIST_BY_MATERIAL_NEW', 'READ_SOURCE_RESOLVER_NO_MATCH', null]) {
      nextResponse = async () => respond({ ...notFound, evidence: { ...notFound.evidence as Wire, errorCode: code, message: PRIVATE } })
      await expect(readK3Bl2Bom('saved-bl2', '1')).rejects.toMatchObject({ message: 'K3_BL2_READ_FAILED', code: 'K3_BL2_READ_FAILED' })
    }
  })

  it.each([
    ['evidence.ok', 'true'], ['evidence.resolved', false], ['evidence.containerLocated', 'true'],
    ['evidence.object', 'material'], ['evidence.mode', 'list_page'], ['evidence.rule', 'first_when_sorted'],
    ['evidence.candidateCount', 0], ['evidence.candidateCount', 2], ['evidence.matchedCount', '1'],
    ['evidence.containers.primary.type', 'object'], ['evidence.containers.primary.arrayLength', 2],
    ['evidence.ambiguous', true], ['evidence.capReached', 'false'], ['evidence.timeoutReached', true],
    ['evidence.boundedSmoke', 'false'], ['evidence.errorCode', 'K3_WISE_BOM_LIST_BY_MATERIAL_NOT_FOUND'],
    ['data.resolver.target', 'other'], ['data.resolver.value', null], ['data.resolver.value', true],
    ['data.resolver.value', []], ['data.resolver.value', {}], ['data.resolver.value', ' '],
    ['data.resolver.value', 'x'.repeat(4097)], ['data.resolver.value', -1],
    ['data.resolver.value', Number.MAX_SAFE_INTEGER + 1], ['data.resolver.value', 1.5],
  ] as Array<[string, unknown]>)('rejects contradictory or unsafe result at %s', async (path, value) => {
    const malformed = clone(success); setPath(malformed, path, value)
    nextResponse = async () => respond(malformed)
    await expect(readK3Bl2Bom('saved-bl2', '1')).rejects.toMatchObject({ code: 'K3_BL2_READ_FAILED' })
    expect(calls).toHaveLength(1)
  })

  it('accepts bounded strings and nonnegative safe integers from actual backend results, dropping extras', async () => {
    for (const value of ['x'.repeat(4096), 0, Number.MAX_SAFE_INTEGER]) {
      const fixture = await runtimeFixture([{ FBOMNumber: value, extra: PRIVATE }])
      nextResponse = async () => respond({ ...fixture, raw: PRIVATE, extra: PRIVATE })
      expect(await readK3Bl2Bom('saved-bl2', '1')).toEqual({ value })
    }
  })

  it('rejects HTTP, outer envelope, JSON and transport failures without retry or auth redirect', async () => {
    const cases = [
      () => Promise.resolve(respond(success, 401)), () => Promise.resolve(respond(success, 403)),
      () => Promise.resolve(respond(success, 409)),
      () => Promise.resolve(new Response(JSON.stringify({ ok: false, data: success, error: { message: PRIVATE } }))),
      () => Promise.resolve(new Response(JSON.stringify({ data: success }))),
      () => Promise.resolve(new Response(PRIVATE)), () => Promise.reject(new Error(PRIVATE)),
    ]
    for (const run of cases) {
      nextResponse = run
      await expect(readK3Bl2Bom('saved-bl2', '1')).rejects.toMatchObject({ message: 'K3_BL2_READ_FAILED', code: 'K3_BL2_READ_FAILED' })
    }
    expect(calls).toHaveLength(cases.length)
    expect(localStorage.getItem('auth_token')).toBe('synthetic-session-token')
  })
})
