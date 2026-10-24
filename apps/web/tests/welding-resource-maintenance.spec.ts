import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import Panel from '../src/views/welding/WeldingResourceMaintenancePanel.vue'
import { useWeldingResourceSession } from '../src/views/welding/useWeldingResourceSession'
import { createWeldingPlanClient, WeldingPlanError, type WeldingPlanClient, type RequestScope } from '../src/services/welding/planClient'
import { validateResourcePending, type ResourcePending, type ResourceRecoveryStore } from '../src/services/welding/commandRecovery'
import { resourcePath, validateResourceAck, validateResourceOriginal, validateResourcePayload, validateResourceCatalog, validateResourceVersionCatalog, validateResourceDocumentCatalog,
  resourceCatalogQuery, resourceVersionQuery, resourceDocumentQuery, validateResourceCursor, RESOURCE_CATALOG_BYTES,
  type ResourceCatalogQuery, type ResourceSummary, type ResourceCatalog, type ResourceVersionCatalog, type ResourceDocumentCatalog, type ResourcePayload, type ResourceMaintenanceRecord, type CreateResourceRequest, type ReviseResourceRequest, type ResourceBasis } from '../src/services/welding/resourceContracts'
import { clone, equal, jsonBytes, type WeldingOwner } from '../src/services/welding/planRecovery'
import type { ApiFetchOptions } from '../src/utils/api'
import { EXPLICIT_SESSION_ORG_KEY, beginExplicitSessionOrgChange, installExplicitSessionOrg } from '../src/utils/explicitSessionOrg'
import { webcrypto } from 'node:crypto'
import { importHarness } from './utils/weldingResourceImportHarness'

const owner = { tenant_id: 'tenant', org_id: 'org', auth_user_id: 7, rbac_user_id: 19 }
const fixedDocument = { item_id: 'document/one', version_id: 'doc-v1', file_id: 'file%one', file_role: 'reference' as const, expected_fingerprint: 'c'.repeat(64) }
const payload = (kind: ResourcePayload['kind'] = 'material'): ResourcePayload => ({ schema_version: 1, kind,
  suggested_fields: kind === 'material' ? { material_a: 'steel' } : kind === 'filler' ? { filler: 'ER70S-6' } : kind === 'requirements' ? { inspection_requirements: '' }
    : kind === 'joint_diagram' ? { joint_type: 'manual joint' } : { method: 'GTAW', thickness_a: { value: 12.7, unit: 'mm' }, passes: [{ sequence: 1, current: { value: 0, unit: 'A' } }] },
  ...(['wps', 'pqr', 'joint_diagram'].includes(kind) ? { document: clone(fixedDocument) } : {}) })
function record(resource_id: string, item_version_id: string, name: string, number: string, value: ResourcePayload): ResourceMaintenanceRecord {
  const fixed = value.document
  const sources = fixed ? { document: { item_id: fixed.item_id, version_id: fixed.version_id, file_id: fixed.file_id, file_role: fixed.file_role, fingerprint: fixed.expected_fingerprint.toLowerCase(), title: 'Fixed document', version_label: 'A', state: 'Released',
    is_released: true, file_name: 'fixed.pdf', checksum: 'd'.repeat(64) }, ...(value.kind === 'joint_diagram' ? { diagram: { schema: 'yuantus.welding_joint_diagram/1', actual_sha256: 'd'.repeat(64), byte_size: 23, mime_type: 'image/png', format: 'png', width: 1, height: 1, exif_orientation: 1 } } : {}) } : {}
  return { resource_id, item_version_id, name, number, payload: clone(value), kind: value.kind, sources, content_hash: 'a'.repeat(64), version_label: '1.A', state: 'Draft' }
}
function createAck(body: CreateResourceRequest) { return record(body.resource_id, 'resource-v1', body.name, body.number, body.payload) }
function revisionAck(resource: string, body: ReviseResourceRequest, source: ResourceBasis) {
  return { ...record(resource, 'resource-v2', body.name, source.number, body.payload), content_hash: 'b'.repeat(64), version_label: '1.B',
    predecessor_version_id: body.source_version_id, predecessor_content_hash: body.expected_content_hash }
}
const key = (value: WeldingOwner) => jsonBytes(value)
const cursor = `e30.${'c'.repeat(64)}`
const summary = (resource = 'r', version = 'v1'): ResourceSummary => ({ resource_id: resource, item_version_id: version, version_label: '1.A', state: 'Draft', name: 'Original', number: 'M-1', kind: 'material', content_hash: 'a'.repeat(64) })
const catalog = (items = [summary()], next_cursor: string | null = null): ResourceCatalog => ({ schema: 'yuantus.welding_resource_catalog/1', items, next_cursor })
const versions = (items = [summary()], next_cursor: string | null = null): ResourceVersionCatalog => ({ schema: 'yuantus.welding_resource_versions/1', resource_id: 'r', current_version_id: 'current-outside-page', items, next_cursor })
const documentCatalog = (): ResourceDocumentCatalog => ({ schema: 'yuantus.welding_process_reference_catalog/1', limit: 20, next_cursor: null,
  items: [{ item_id: fixedDocument.item_id, version_id: fixedDocument.version_id, file_id: fixedDocument.file_id, file_role: fixedDocument.file_role,
    title: 'Fixed document', version_label: 'A', state: 'Released', is_released: true, file_name: 'fixed.pdf', checksum: 'd'.repeat(64), fingerprint: fixedDocument.expected_fingerprint }] })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function memory() {
  const rows = new Map<string, string>(), listeners = new Set<() => void>()
  const emit = () => { for (const listener of listeners) listener() }
  const store: ResourceRecoveryStore = {
    getResource: vi.fn(async (who: WeldingOwner) => { const raw = rows.get(key(who)); return raw === undefined ? null : validateResourcePending(JSON.parse(raw)) }),
    claimResource: vi.fn(async (input: ResourcePending) => { const value = validateResourcePending(input), raw = jsonBytes(value), current = rows.get(key(value.owner)); if (current !== undefined) return current === raw; rows.set(key(value.owner), raw); emit(); return true }),
    clearResource: vi.fn(async (input: ResourcePending) => { const raw = jsonBytes(validateResourcePending(input)); if (rows.get(key(input.owner)) !== raw) return false; rows.delete(key(input.owner)); emit(); return true }),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, close: vi.fn(),
  }
  return { rows, store, emit }
}
function setup(shared = memory()) {
  let currentOwner = clone(owner), writable = true, id = 0
  const api = {
    authority: vi.fn(async () => clone(currentOwner)),
    readResource: vi.fn(async (resource: string, version: string) => record(resource, version, 'Original', 'M-1', payload())),
    readResourceDiagram: vi.fn(async (_record: ResourceMaintenanceRecord, _scope?: RequestScope) => new Blob(['qualified-image-content'], { type: 'image/png' })),
    resourceCatalog: vi.fn(async (_query: ResourceCatalogQuery, _scope?: RequestScope) => catalog()),
    resourceVersionCatalog: vi.fn(async (_resource: string, _query: { limit?: number; cursor?: string }, _scope?: RequestScope) => versions()),
    resourceDocumentCatalog: vi.fn(async (_query: string, _cursor?: string, _scope?: RequestScope) => documentCatalog()),
    createResource: vi.fn(async (body: CreateResourceRequest) => createAck(body)),
    reviseResource: vi.fn(async (resource: string, body: ReviseResourceRequest, source: ResourceBasis) => revisionAck(resource, body, source)),
  }
  const session = useWeldingResourceSession({ client: api as unknown as WeldingPlanClient, active: () => true, writable: () => writable,
    openStore: async () => shared.store, uuid: () => `request-${++id}` })
  disposers.push(session.dispose)
  const fill = () => { session.state.form = { name: 'Manual steel', number: 'M-1', payload: payload() } }
  return { session, api, shared, fill, changeOwner: (value: WeldingOwner) => { currentOwner = value }, disableWrite: () => { writable = false } }
}
let disposers: Array<() => void> = [], app: App<Element> | undefined, root: HTMLDivElement | undefined
const previousLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
beforeEach(() => {
  localStorage.removeItem(EXPLICIT_SESSION_ORG_KEY); localStorage.removeItem('jwt')
  localStorage.setItem('auth_token', 'native-A')
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn(async (_name: string, _options: unknown, callback: (lock: unknown) => unknown) => callback({})) } })
})
afterEach(() => {
  app?.unmount(); app = undefined; root?.remove(); root = undefined
  disposers.forEach(dispose => dispose()); disposers = []; vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (previousLocks) Object.defineProperty(navigator, 'locks', previousLocks); else Reflect.deleteProperty(navigator, 'locks')
})

describe('single enterprise resource contracts', () => {
  it('mounted bulk import preserves the single-editor form, fixed record, comparison and original through preview, unknown, replay and fixed read', async () => {
    vi.stubGlobal('crypto', webcrypto); vi.spyOn(window, 'confirm').mockReturnValue(true)
    const single = setup(); await single.session.initialize(); await single.session.read('existing', 'existing-v1')
    single.session.state.form.name = 'unsaved editor name'; single.session.compare()
    const original = validateResourcePending({ schema: 'metasheet.welding_command_pending/1', kind: 'resource', owner, action: 'create', resource_id: 'other-resource', source: null,
      body: { resource_id: 'other-resource', request_id: 'single-original', name: 'Original command', number: 'S-1', payload: payload() } })
    await single.shared.store.claimResource(original); await single.session.initialize(false)
    await vi.waitFor(() => expect(single.session.state.pending).toEqual(original))
    const snapshot = clone({ form: single.session.state.form, record: single.session.state.record, comparison: single.session.state.comparison, pending: single.session.state.pending })
    const batch = importHarness(); disposers.push(batch.session.dispose)
    root = document.createElement('div'); document.body.appendChild(root)
    app = createApp({ render: () => h(Panel, { resources: single.session, imports: batch.session }) }); app.mount(root)
    const unchanged = () => expect({ form: single.session.state.form, record: single.session.state.record, comparison: single.session.state.comparison, pending: single.session.state.pending }).toEqual(snapshot)
    await batch.ready(); unchanged(); batch.api.commitResourceImport.mockRejectedValueOnce(new Error('lost ACK'))
    await batch.session.commit(); unchanged(); await batch.session.replay(); unchanged()
    await batch.session.readItem(batch.session.state.receipt!.items[0]); unchanged()
    expect(root.querySelector('[aria-label="整批资料导入"]')).not.toBeNull()
    expect(await single.shared.store.getResource(owner)).toEqual(original)
  })
  it.each(['wps', 'pqr', 'parameter_reference', 'requirements', 'material', 'filler', 'joint_diagram'] as const)('registers the explicit %s fields and fixed source without inferred qualification', async kind => {
    const body = { resource_id: 'resource-1', request_id: 'original-request', name: 'Registered', number: 'R-1', payload: payload(kind) }
    const transport = vi.fn(async (_path: string, _options: ApiFetchOptions = {}) => new Response(jsonBytes(createAck(body)), { status: 201 }))
    const value = await createWeldingPlanClient(transport).createResource(body)
    expect(value.payload).toEqual(body.payload); expect(value.state).toBe('Draft')
    expect(transport.mock.calls[0][0]).toBe('/api/welding/resources')
    expect(transport.mock.calls[0][1].body).toBe(jsonBytes(body))
    expect(body).not.toHaveProperty('tenant_id'); expect(value).not.toHaveProperty('allowed_actions')
  })
  it.each([
    { schema_version: 1, kind: 'wps', suggested_fields: {} }, { ...payload('wps'), document: undefined }, { ...payload('pqr'), document: null }, { ...payload('joint_diagram'), document: null },
    { ...payload('material'), document: null }, { ...payload('material'), suggested_fields: { material_a: null } },
    { ...payload('material'), suggested_fields: { method: 'GTAW' } }, { ...payload('filler'), suggested_fields: { material_a: 'steel' } },
    { ...payload('requirements'), suggested_fields: { passes: [] } }, { ...payload('joint_diagram'), suggested_fields: { method: 'GTAW' } },
    { ...payload('parameter_reference'), suggested_fields: { thickness_a: { value: true, unit: 'mm' } } },
    { ...payload('parameter_reference'), suggested_fields: { passes: [{ sequence: 1 }, { sequence: 1 }] } },
    { ...payload('material'), kind: ['material'] }, { ...payload('material'), kind: 7 },
    { ...payload('wps'), document: { ...fixedDocument, file_role: ['reference'] } }, { ...payload('wps'), document: { ...fixedDocument, expected_fingerprint: 'not-a-fingerprint' } },
  ])('rejects malformed persisted/HTTP resource payload before any dispatch', async invalid => {
    const transport = vi.fn()
    await expect(createWeldingPlanClient(transport).createResource({ resource_id: 'resource-1', request_id: 'original', name: 'R', number: 'R1', payload: invalid } as unknown as CreateResourceRequest)).rejects.toThrow()
    expect(transport).not.toHaveBeenCalled()
  })
  it('keeps omitted fields distinct from explicit empty/zero values and nullable pass measurements', () => {
    const value = { schema_version: 1, kind: 'wps', document: fixedDocument, suggested_fields: { method: '', passes: [{ sequence: 2, current: null, speed: { value: 0, unit: 'in/min' } }] } }
    expect(validateResourcePayload(value)).toEqual(value); expect(validateResourcePayload(value).suggested_fields).not.toHaveProperty('filler')
  })
  it('binds each revision to the fixed predecessor, number and kind, but permits history replay after that source moved on', () => {
    const source = { resource_id: 'r', item_version_id: 'old-v1', content_hash: 'a'.repeat(64), number: 'R1', kind: 'material' as const }
    const original = validateResourceOriginal({ action: 'revise', resource_id: 'r', source,
      body: { request_id: 'same-key', source_version_id: 'old-v1', expected_current_version_id: 'old-v1', expected_content_hash: source.content_hash, name: 'New', payload: payload() } })
    expect(resourcePath(original)).toBe('/resources/r/revisions')
    const ack = revisionAck('r', original.body as ReviseResourceRequest, source)
    expect(validateResourceAck(ack, original)).toEqual(ack)
    for (const bad of [{ number: 'other' }, { predecessor_version_id: 'other' }, { predecessor_content_hash: 'e'.repeat(64) }, { item_version_id: 'old-v1' }])
      expect(() => validateResourceAck({ ...ack, ...bad }, original)).toThrow()
    expect(() => validateResourceOriginal({ ...original, body: { ...original.body, expected_current_version_id: 'new-v3' } })).toThrow()
  })
  it('reads only the fixed resource/version and rejects source or kind drift in its complete record', async () => {
    const value = record('r', 'v1', 'WPS', 'WPS-1', payload('wps'))
    const transport = vi.fn(async (_path: string, _options: ApiFetchOptions = {}) => new Response(jsonBytes(value), { status: 200 }))
    expect(await createWeldingPlanClient(transport).readResource('r', 'v1')).toEqual(value)
    expect(transport.mock.calls[0][0]).toBe('/api/welding/resources/r/versions/v1')
    const bad = { ...value, sources: { document: { ...(value.sources.document as Record<string, unknown>), fingerprint: 'e'.repeat(64) } } }
    transport.mockResolvedValueOnce(new Response(jsonBytes(bad), { status: 200 }))
    await expect(createWeldingPlanClient(transport).readResource('r', 'v1')).rejects.toThrow()
  })
  it('rejects a fake plan envelope, substituted owner shape and extra body identity in resource recovery', () => {
    const original = { schema: 'metasheet.welding_command_pending/1', kind: 'resource', owner, action: 'create', resource_id: 'r', source: null,
      body: { resource_id: 'r', request_id: 'key', name: 'R', number: 'R1', payload: payload() } }
    expect(validateResourcePending(original)).toEqual(original)
    for (const bad of [{ ...original, plan_id: 'fake' }, { ...original, owner: { ...owner, allowed_actions: ['add'] } }, { ...original, body: { ...original.body, auth_actor_id: 7 } }])
      expect(() => validateResourcePending(bad)).toThrow()
  })
})

describe('bounded resource catalog contracts', () => {
  it('encodes only the frozen filters and paired thickness, with a canonical cursor and no client HMAC inference', () => {
    const query = new URLSearchParams(resourceCatalogQuery({ kind: 'wps', material_a: '钢 & alloy', thickness_a_value: 0, thickness_a_unit: 'mm', limit: 20, cursor }))
    expect(query.get('material_a')).toBe('钢 & alloy'); expect(query.get('thickness_a_value')).toBe('0'); expect(query.get('cursor')).toBe(cursor)
    expect(resourceVersionQuery({ limit: 1 })).toBe('limit=1')
    expect(new URLSearchParams(resourceDocumentQuery('document / x', cursor)).get('query')).toBe('document / x')
    for (const bad of [{ kind: 'other' }, { thickness_a_value: 1 }, { thickness_b_unit: 'mm' }, { thickness_a_value: -1, thickness_a_unit: 'mm' }, { limit: 21 }, { limit: 1.5 }, { owner }])
      expect(() => resourceCatalogQuery(bad as ResourceCatalogQuery)).toThrow()
    expect(() => resourceVersionQuery({ kind: 'wps' } as unknown as { limit: number })).toThrow()
    for (const bad of ['', 'a'.repeat(101), ' x', 'x\ny']) expect(() => resourceDocumentQuery(bad)).toThrow()
    for (const bad of [`e30=.${'c'.repeat(64)}`, `e31.${'c'.repeat(64)}`, `a.${'c'.repeat(64)}`, `e30.${'C'.repeat(64)}`, 'a'.repeat(4097)])
      expect(() => validateResourceCursor(bad)).toThrow()
    expect(() => validateResourceCursor(cursor)).not.toThrow()
  })
  it('accepts eight-field summaries and an out-of-page or undisclosed current, but rejects extras and duplicate identities', () => {
    expect(validateResourceCatalog(catalog())).toEqual(catalog())
    expect(validateResourceVersionCatalog(versions(), 'r').current_version_id).toBe('current-outside-page')
    expect(validateResourceVersionCatalog({ ...versions(), current_version_id: null }, 'r').current_version_id).toBeNull()
    for (const bad of [{ ...catalog(), total: 1 }, catalog([{ ...summary(), payload: payload() } as ResourceSummary]), catalog([summary(), summary()]),
      catalog(Array.from({ length: 21 }, (_, n) => summary('r', `v${n}`))), catalog([{ ...summary(), resource_id: 'not/route-safe' }])])
      expect(() => validateResourceCatalog(bad)).toThrow()
    expect(() => validateResourceVersionCatalog(versions([summary('other')]), 'r')).toThrow()
    expect(() => validateResourceVersionCatalog(versions(), 'other')).toThrow()
  })
  it('keeps body-only document IDs and fingerprint distinct from checksum, rejecting malformed and oversized DTOs', () => {
    const page = documentCatalog(), row = page.items[0]
    expect(validateResourceDocumentCatalog(page).items[0].item_id).toBe('document/one')
    expect(row.fingerprint).not.toBe(row.checksum)
    for (const bad of [{ ...page, limit: 19 }, { ...page, items: [row, row] }, { ...page, items: [{ ...row, extra: true }] },
      { ...page, items: [{ ...row, fingerprint: 'C'.repeat(64) }] }, { ...page, items: [{ ...row, title: 'x'.repeat(RESOURCE_CATALOG_BYTES) }] }])
      expect(() => validateResourceDocumentCatalog(bad)).toThrow()
  })
  it('binds each page to the requested limit and permits a cursor only on a full page', () => {
    const rows = [summary('r', 'v1'), summary('r', 'v2')]
    expect(() => validateResourceCatalog(catalog(rows), 1)).toThrow()
    expect(() => validateResourceVersionCatalog(versions(rows), 'r', 1)).toThrow()
    for (const count of [0, 1]) {
      expect(() => validateResourceCatalog(catalog(rows.slice(0, count), cursor), 2)).toThrow()
      expect(() => validateResourceVersionCatalog(versions(rows.slice(0, count), cursor), 'r', 2)).toThrow()
      expect(() => validateResourceDocumentCatalog({ ...documentCatalog(), items: documentCatalog().items.slice(0, count), next_cursor: cursor })).toThrow()
    }
    expect(validateResourceCatalog(catalog(rows, cursor), 2).items).toEqual(rows)
    expect(validateResourceVersionCatalog(versions(rows, cursor), 'r', 2).items).toEqual(rows)
    const full = Array.from({ length: 20 }, (_, i) => summary('r', `v${i}`))
    expect(validateResourceCatalog(catalog(full, cursor)).items).toHaveLength(20)
    expect(validateResourceVersionCatalog(versions(full, cursor), 'r').items).toHaveLength(20)
    const docs = Array.from({ length: 20 }, (_, i) => ({ ...documentCatalog().items[0], version_id: `doc-v${i}` }))
    expect(validateResourceDocumentCatalog({ ...documentCatalog(), items: docs, next_cursor: cursor }).items).toHaveLength(20)
    for (const limit of [0, 21, 1.5, NaN, Infinity, '1' as unknown as number]) {
      expect(() => validateResourceCatalog(catalog([]), limit)).toThrow()
      expect(() => validateResourceVersionCatalog(versions([]), 'r', limit)).toThrow()
    }
  })
  it('uses default catalog paths without an empty query and rejects HTTP pages larger than their captured limit', async () => {
    const transport = vi.fn(async (_path: string, _options: ApiFetchOptions = {}) => new Response(jsonBytes(catalog()), { status: 200 })), client = createWeldingPlanClient(transport)
    await client.resourceCatalog({}); expect(transport.mock.calls[0][0]).toBe('/api/welding/resources/catalog')
    transport.mockResolvedValueOnce(new Response(jsonBytes(versions()), { status: 200 }))
    await client.resourceVersionCatalog('r', {}); expect(transport.mock.calls[1][0]).toBe('/api/welding/resources/r/version-catalog')
    const rows = [summary('r', 'v1'), summary('r', 'v2')]
    transport.mockResolvedValueOnce(new Response(jsonBytes(catalog(rows)), { status: 200 }))
    await expect(client.resourceCatalog({ limit: 1 })).rejects.toThrow()
    transport.mockResolvedValueOnce(new Response(jsonBytes(versions(rows)), { status: 200 }))
    await expect(client.resourceVersionCatalog('r', { limit: 1 })).rejects.toThrow()
    transport.mockResolvedValueOnce(new Response(jsonBytes(catalog([], cursor)), { status: 200 }))
    await expect(client.resourceCatalog({ limit: 1 })).rejects.toThrow()
    transport.mockResolvedValueOnce(new Response(jsonBytes(versions([summary()], cursor)), { status: 200 }))
    await expect(client.resourceVersionCatalog('r', {})).rejects.toThrow()
    transport.mockResolvedValueOnce(new Response(jsonBytes({ ...documentCatalog(), next_cursor: cursor }), { status: 200 }))
    await expect(client.resourceDocumentCatalog('pdf', undefined)).rejects.toThrow()
    const later = deferred<Response>(), query = { limit: 1 }; transport.mockReturnValueOnce(later.promise)
    const request = client.resourceCatalog(query); query.limit = 20
    later.resolve(new Response(jsonBytes(catalog(rows)), { status: 200 })); await expect(request).rejects.toThrow()
  })
  it('uses all three GET paths and rejects both declared and actual bodies over the per-response 2 MiB cap', async () => {
    const transport = vi.fn(async (_path: string, _options: ApiFetchOptions = {}) => new Response(jsonBytes(catalog()), { status: 200 })), client = createWeldingPlanClient(transport)
    await client.resourceCatalog({ kind: 'material', cursor })
    expect(transport.mock.calls[0][0]).toBe(`/api/welding/resources/catalog?kind=material&cursor=${cursor}`)
    expect(transport.mock.calls[0][1]).toMatchObject({ method: 'GET', cache: 'no-store' })
    transport.mockResolvedValueOnce(new Response(jsonBytes(versions()), { status: 200 }))
    await client.resourceVersionCatalog('r', { limit: 20 }); expect(transport.mock.calls[1][0]).toBe('/api/welding/resources/r/version-catalog?limit=20')
    transport.mockResolvedValueOnce(new Response(jsonBytes(documentCatalog()), { status: 200 }))
    await client.resourceDocumentCatalog('fixed pdf', undefined); expect(transport.mock.calls[2][0]).toBe('/api/welding/process-references/candidate-catalog?query=fixed+pdf')
    transport.mockResolvedValueOnce(new Response('{}', { status: 200, headers: { 'content-length': String(RESOURCE_CATALOG_BYTES + 1) } }))
    await expect(client.resourceCatalog({})).rejects.toThrow()
    transport.mockResolvedValueOnce(new Response(' '.repeat(RESOURCE_CATALOG_BYTES + 1), { status: 200 }))
    await expect(client.resourceVersionCatalog('r', {})).rejects.toThrow()
    transport.mockResolvedValueOnce(new Response(' '.repeat(RESOURCE_CATALOG_BYTES + 1), { status: 200 }))
    await expect(client.resourceDocumentCatalog('pdf', undefined)).rejects.toThrow()
  })
})

describe('fresh-owner catalog selection session', () => {
  it('pages with unchanged filters, then clears prior rows and cursor immediately on a filter change', async () => {
    const f = setup(); await f.session.initialize()
    f.session.state.catalog.filters.kind = 'material'; f.session.state.catalog.filters.thickness_a_value = '0'; f.session.state.catalog.filters.thickness_a_unit = 'mm'
    f.api.resourceCatalog.mockResolvedValueOnce(catalog([summary()], cursor)); await f.session.searchCatalog()
    const calls = f.api.authority.mock.calls.length
    f.api.resourceCatalog.mockResolvedValueOnce(catalog([summary('r2', 'v2')])); await f.session.searchCatalog(true)
    expect(f.api.resourceCatalog.mock.calls[1][0]).toEqual({ kind: 'material', thickness_a_value: 0, thickness_a_unit: 'mm', limit: 20, cursor })
    expect(f.api.authority.mock.calls.length).toBe(calls + 2); expect(f.session.state.catalog.items[0].resource_id).toBe('r2')
    f.session.state.catalog.filters.material_a = 'new filter'
    expect(f.session.state.catalog.items).toEqual([]); expect(f.session.state.catalog.nextCursor).toBeNull(); expect(f.session.state.catalog.loaded).toBe(false)
    expect(f.api.resourceCatalog).toHaveBeenCalledTimes(2)
  })
  it('rejects a late page after a filter changes and returns to its original value', async () => {
    const f = setup(); await f.session.initialize(); const later = deferred<ResourceCatalog>()
    f.api.resourceCatalog.mockReturnValueOnce(later.promise); const request = f.session.searchCatalog()
    await vi.waitFor(() => expect(f.api.resourceCatalog).toHaveBeenCalledTimes(1))
    f.session.state.catalog.filters.kind = 'wps'; f.session.state.catalog.filters.kind = ''
    later.resolve(catalog([summary()], cursor)); await request
    expect(f.session.state.catalog.items).toEqual([]); expect(f.session.state.catalog.loaded).toBe(false); expect(f.session.state.busy).toBe(false)
  })
  it.each(['auth_user_id', 'rbac_user_id', 'org_id'] as const)('hides every catalog when fresh %s changes during a page request', async field => {
    const f = setup(); await f.session.initialize(); await f.session.searchCatalog(); f.session.state.history.resourceId = 'r'; await f.session.searchHistory()
    f.session.state.documents.query = 'fixed'; await f.session.searchDocuments()
    f.api.resourceCatalog.mockImplementationOnce(async () => { f.changeOwner({ ...owner, [field]: field === 'org_id' ? 'other-org' : 99 }); return catalog([summary('other')]) })
    await f.session.searchCatalog()
    expect(f.session.state.owner).toBeNull(); expect(f.session.state.catalog.items).toEqual([]); expect(f.session.state.history.items).toEqual([]); expect(f.session.state.documents.items).toEqual([])
  })
  it('clears rows on native session storage invalidation and refuses a late history page after changing resource', async () => {
    const f = setup(); await f.session.initialize(); await f.session.searchCatalog(); f.session.state.history.resourceId = 'r'
    const later = deferred<ResourceVersionCatalog>(); f.api.resourceVersionCatalog.mockReturnValueOnce(later.promise)
    const request = f.session.searchHistory(); await vi.waitFor(() => expect(f.api.resourceVersionCatalog).toHaveBeenCalledTimes(1))
    f.session.state.history.resourceId = 'other'; later.resolve(versions()); await request
    expect(f.session.state.history.loaded).toBe(false)
    window.dispatchEvent(new StorageEvent('storage', { key: 'auth_token', newValue: 'native-B' }))
    expect(f.session.state.catalog.items).toEqual([]); expect(f.session.state.owner).toBeNull()
  })
  it('preserves the previous successful page on a failed next page, showing failure instead of an empty success', async () => {
    const f = setup(); await f.session.initialize(); f.api.resourceCatalog.mockResolvedValueOnce(catalog([summary()], cursor)); await f.session.searchCatalog()
    f.api.resourceCatalog.mockRejectedValueOnce(new WeldingPlanError('catalog denied', 403)); await f.session.searchCatalog(true)
    expect(f.session.state.catalog.items).toEqual([summary()]); expect(f.session.state.catalog.nextCursor).toBe(cursor); expect(f.session.state.catalog.message).toContain('catalog denied')
    f.session.state.documents.query = 'fixed'; f.api.resourceDocumentCatalog.mockRejectedValueOnce(new WeldingPlanError('unavailable', 503)); await f.session.searchDocuments()
    expect(f.session.state.documents.loaded).toBe(false); expect(f.session.state.documents.message).toContain('unavailable')
  })
  it('does not replace dirty editing until explicit confirmation and fresh fixed detail, without using summary as payload', async () => {
    const f = setup(); await f.session.initialize(); f.fill(); await f.session.searchCatalog()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await f.session.selectSummary(summary()); expect(f.api.readResource).not.toHaveBeenCalled(); expect(f.session.state.form.name).toBe('Manual steel')
    confirm.mockReturnValue(true); await f.session.selectSummary(summary())
    expect(f.api.readResource.mock.calls[0].slice(0, 2)).toEqual(['r', 'v1']); expect(f.session.state.form.payload).toEqual(payload()); expect(f.session.state.record?.name).toBe('Original')
    expect(f.api.createResource).not.toHaveBeenCalled(); expect(f.api.reviseResource).not.toHaveBeenCalled()
  })
  it('preserves edits made while fixed detail is loading, even if the edited field is later reverted', async () => {
    const f = setup(); await f.session.initialize(); await f.session.searchCatalog(); const later = deferred<ResourceMaintenanceRecord>()
    f.api.readResource.mockReturnValueOnce(later.promise); const request = f.session.selectSummary(summary())
    await vi.waitFor(() => expect(f.api.readResource).toHaveBeenCalledTimes(1))
    f.session.state.form.name = 'changed'; f.session.state.form.name = ''
    later.resolve(record('r', 'v1', 'Original', 'M-1', payload())); await request
    expect(f.session.state.record).toBeNull(); expect(f.session.state.form.name).toBe('')
  })
  it('cannot project a selected detail over another page durable original arriving during the GET', async () => {
    const f = setup(); await f.session.initialize(); await f.session.searchCatalog(); const later = deferred<ResourceMaintenanceRecord>()
    f.api.readResource.mockReturnValueOnce(later.promise); const request = f.session.selectSummary(summary())
    await vi.waitFor(() => expect(f.api.readResource).toHaveBeenCalledTimes(1))
    const pending = validateResourcePending({ schema: 'metasheet.welding_command_pending/1', kind: 'resource', owner, action: 'create', resource_id: 'other', source: null,
      body: { resource_id: 'other', request_id: 'other-original', name: 'Other', number: 'R-2', payload: payload() } })
    await f.shared.store.claimResource(pending)
    later.resolve(record('r', 'v1', 'Original', 'M-1', payload())); await request
    expect(f.session.state.record).toBeNull(); expect(f.session.state.form.name).toBe(''); expect(f.session.state.pending).toEqual(pending)
    expect(f.shared.rows.get(key(owner))).toBe(jsonBytes(pending)); expect(f.shared.store.clearResource).not.toHaveBeenCalled()
  })
  it('pages history with an out-of-page current and selects the explicit historic ID using a fresh GET', async () => {
    const f = setup(); await f.session.initialize(); f.session.state.history.resourceId = 'r'
    f.api.resourceVersionCatalog.mockResolvedValueOnce(versions([summary('r', 'v10')], cursor)); await f.session.searchHistory()
    expect(f.session.state.history.currentVersionId).toBe('current-outside-page')
    f.api.resourceVersionCatalog.mockResolvedValueOnce({ ...versions([summary('r', 'v2')]), current_version_id: null }); await f.session.searchHistory(true)
    expect(f.api.resourceVersionCatalog.mock.calls[1].slice(0, 2)).toEqual(['r', { limit: 20, cursor }])
    expect(f.session.state.history.currentVersionId).toBeNull(); await f.session.selectSummary(summary('r', 'v2'), true)
    expect(f.session.state.record?.item_version_id).toBe('v2')
  })
  it('pages document candidates without writing the form and binds only the explicit five-field source on selection', async () => {
    const f = setup(); await f.session.initialize(); f.session.state.documents.query = 'fixed'
    f.api.resourceDocumentCatalog.mockResolvedValueOnce({ ...documentCatalog(), next_cursor: cursor }); await f.session.searchDocuments()
    expect(f.session.state.form.payload.document).toBeUndefined(); await f.session.searchDocuments(true)
    expect(f.api.resourceDocumentCatalog.mock.calls[1].slice(0, 2)).toEqual(['fixed', cursor])
    await f.session.selectDocument(documentCatalog().items[0])
    expect(f.session.state.form.payload.document).toEqual(fixedDocument)
    expect(f.session.state.form.payload.document?.expected_fingerprint).not.toBe(documentCatalog().items[0].checksum)
    expect(f.api.createResource).not.toHaveBeenCalled(); expect(f.api.reviseResource).not.toHaveBeenCalled()
  })
  it('discards late document query results and does not overwrite form edits during an explicit candidate selection', async () => {
    const f = setup(); await f.session.initialize(); f.session.state.documents.query = 'fixed'
    const later = deferred<ResourceDocumentCatalog>(); f.api.resourceDocumentCatalog.mockReturnValueOnce(later.promise)
    const request = f.session.searchDocuments(); await vi.waitFor(() => expect(f.api.resourceDocumentCatalog).toHaveBeenCalledTimes(1))
    f.session.state.documents.query = 'other'; later.resolve(documentCatalog()); await request
    expect(f.session.state.documents.items).toEqual([])
    await f.session.searchDocuments(); const authority = deferred<WeldingOwner>(); f.api.authority.mockReturnValueOnce(authority.promise)
    const select = f.session.selectDocument(documentCatalog().items[0]); f.session.state.form.payload.document = { ...fixedDocument, file_id: 'manual-file' }
    authority.resolve(owner); await select
    expect(f.session.state.form.payload.document?.file_id).toBe('manual-file'); expect(f.api.createResource).not.toHaveBeenCalled()
  })
})

describe('resource-only original request session', () => {
  it('invalidates a cross-tab explicit-org storage change immediately while preserving the original revision', async () => {
    const f = setup(); await f.session.initialize(); await f.session.read('r', 'v1')
    f.session.state.form.name = 'Manual revision'; f.session.compare()
    f.api.reviseResource.mockRejectedValueOnce(new WeldingPlanError('unknown', 502)); await f.session.submit()
    const raw = f.shared.rows.get(key(owner)), authorityCalls = f.api.authority.mock.calls.length
    expect(raw).toBeDefined(); expect(f.session.state.owner).toEqual(owner)
    expect(beginExplicitSessionOrgChange(localStorage.getItem('auth_token')!)).not.toBeNull()
    window.dispatchEvent(new StorageEvent('storage', { key: EXPLICIT_SESSION_ORG_KEY,
      newValue: localStorage.getItem(EXPLICIT_SESSION_ORG_KEY) }))
    expect(f.session.state.owner).toBeNull(); expect(f.session.state.record).toBeNull()
    expect(f.session.state.comparison).toBeNull(); expect(f.session.state.pending).toBeNull()
    expect(f.session.state.form.name).toBe(''); expect(f.session.state.storageBlocked).toBe(true)
    expect(f.shared.rows.get(key(owner))).toBe(raw); expect(f.shared.store.clearResource).not.toHaveBeenCalled()
    expect(f.api.authority).toHaveBeenCalledTimes(authorityCalls)
    expect(f.api.reviseResource).toHaveBeenCalledTimes(1); expect(f.api.createResource).not.toHaveBeenCalled()
  })
  it('persists and reads back the complete original before create, and clears it only after a bound ACK and fresh owner', async () => {
    const f = setup(); await f.session.initialize(); f.fill()
    f.api.createResource.mockImplementationOnce(async body => {
      expect(JSON.parse(f.shared.rows.get(key(owner))!).body).toEqual(body)
      expect(f.session.state.pending?.body).toEqual(body)
      return createAck(body)
    })
    await f.session.submit()
    expect(f.api.createResource).toHaveBeenCalledTimes(1); expect(f.shared.rows.size).toBe(0); expect(f.session.state.pending).toBeNull()
    expect(f.session.state.record).toMatchObject({ name: 'Manual steel', number: 'M-1', state: 'Draft' })
    expect(f.api).not.toHaveProperty('recover'); expect(f.api).not.toHaveProperty('list')
  })
  it('reloads an unknown create without POST or new IDs, then explicitly resends exactly its full original body', async () => {
    const f = setup(); await f.session.initialize(); f.fill()
    f.api.createResource.mockRejectedValueOnce(new WeldingPlanError('lost response', 502, 'WELDING_RESULT_UNKNOWN'))
    await f.session.submit(); const raw = f.shared.rows.get(key(owner))!, pending = JSON.parse(raw) as ResourcePending
    f.session.dispose(); const reload = setup(f.shared); await reload.session.initialize()
    expect(reload.api.createResource).not.toHaveBeenCalled(); expect(reload.session.state.pending).toEqual(pending)
    expect(reload.session.state.form.name).toBe(pending.body.name)
    await reload.session.confirmOriginal()
    expect(reload.api.createResource.mock.calls[0][0]).toEqual(f.api.createResource.mock.calls[0][0])
    expect(reload.api.createResource.mock.calls[0][0].request_id).toBe(pending.body.request_id); expect(reload.shared.rows.size).toBe(0)
    expect(reload.session.state.record).toMatchObject({ resource_id: pending.resource_id, item_version_id: 'resource-v1', name: pending.body.name })
  })
  it('keeps the original after a malformed success and never constructs a replacement key on explicit confirmation', async () => {
    const f = setup(); await f.session.initialize(); f.fill()
    f.api.createResource.mockImplementationOnce(async body => ({ ...createAck(body), number: 'wrong-number' }))
    await f.session.submit(); const pending = clone(f.session.state.pending)
    expect(pending).not.toBeNull(); expect(f.shared.store.clearResource).not.toHaveBeenCalled()
    await f.session.confirmOriginal(); expect(f.api.createResource.mock.calls[1][0]).toEqual(pending!.body)
  })
  it('shows an explicit old/new comparison, invalidates it on edit, sends source CAS, and does not overwrite the old resource', async () => {
    const f = setup(); await f.session.initialize(); await f.session.read('r', 'v1')
    const old = clone(f.session.state.record); f.session.state.form.name = 'Revised'; f.session.compare()
    f.session.state.form.payload.suggested_fields.material_a = 'later steel'; expect(f.session.state.comparison).toBeNull(); expect(f.session.canRequest.value).toBe(false)
    f.session.compare(); await f.session.submit()
    expect(f.api.reviseResource.mock.calls[0][1]).toMatchObject({ source_version_id: 'v1', expected_current_version_id: 'v1', expected_content_hash: old!.content_hash, name: 'Revised' })
    expect(f.session.state.record?.predecessor_version_id).toBe('v1'); expect(old?.payload.suggested_fields.material_a).toBe('steel')
  })
  it('confirms an unknown revision from its stored basis without re-reading or requiring that old version still be current', async () => {
    const f = setup(); await f.session.initialize(); await f.session.read('r', 'v1'); f.session.state.form.name = 'New'; f.session.compare()
    f.api.reviseResource.mockRejectedValueOnce(new WeldingPlanError('unknown', 502)); await f.session.submit()
    const oldBody = clone(f.session.state.pending!.body); const reload = setup(f.shared)
    reload.api.readResource.mockResolvedValue(record('r', 'v3', 'Later', 'M-1', payload()))
    await reload.session.initialize(); await reload.session.confirmOriginal()
    expect(reload.api.readResource).not.toHaveBeenCalled(); expect(reload.api.reviseResource.mock.calls[0][1]).toEqual(oldBody)
    expect(reload.session.state.record).toMatchObject({ resource_id: 'r', item_version_id: 'resource-v2', predecessor_version_id: 'v1' })
  })
  it.each([403, 404, 409])('keeps the complete original and form after server refusal %s, including a later refusal after unknown', async status => {
    const f = setup(); await f.session.initialize(); f.fill(); const input = clone(f.session.state.form)
    f.api.createResource.mockRejectedValueOnce(new WeldingPlanError('unknown', 502)); await f.session.submit(); const raw = f.shared.rows.get(key(owner))!
    f.api.createResource.mockRejectedValueOnce(new WeldingPlanError('refused', status)); await f.session.confirmOriginal()
    expect(f.shared.rows.get(key(owner))).toBe(raw); expect(f.session.state.form).toEqual(input); expect(f.shared.store.clearResource).not.toHaveBeenCalled()
    expect(f.api.createResource.mock.calls[1][0]).toEqual(f.api.createResource.mock.calls[0][0])
  })
  it('a fresh owner change after durable claim prevents POST and hides old UI while keeping the old owner record', async () => {
    const f = setup(); await f.session.initialize(); f.fill(); const claim = f.shared.store.claimResource
    f.shared.store.claimResource = vi.fn(async (input, scope) => { const result = await claim(input, scope); f.changeOwner({ ...owner, rbac_user_id: 20 }); return result })
    await f.session.submit()
    expect(f.api.createResource).not.toHaveBeenCalled(); expect(f.session.state.owner).toBeNull(); expect(f.shared.rows.has(key(owner))).toBe(true)
    expect(f.session.state.form.name).toBe('')
  })
  it('a changed owner while the server returns a valid ACK does not clear the old original or expose its saved content', async () => {
    const f = setup(); await f.session.initialize(); f.fill()
    f.api.createResource.mockImplementationOnce(async body => { f.changeOwner({ ...owner, auth_user_id: 8 }); return createAck(body) })
    await f.session.submit()
    expect(f.api.createResource).toHaveBeenCalledTimes(1); expect(f.shared.rows.has(key(owner))).toBe(true)
    expect(f.shared.store.clearResource).not.toHaveBeenCalled(); expect(f.session.state.owner).toBeNull()
    expect(f.session.state.record).toBeNull(); expect(f.session.state.form.name).toBe('')
  })
  it('storage failure prevents dispatch and another page cannot overwrite a different original', async () => {
    const f = setup(); await f.session.initialize(); f.fill(); vi.mocked(f.shared.store.claimResource).mockRejectedValueOnce(new Error('quota'))
    await f.session.submit(); expect(f.api.createResource).not.toHaveBeenCalled(); expect(f.session.state.storageBlocked).toBe(true)
    const other = setup(); await other.session.initialize(); other.fill()
    const prior = validateResourcePending({ schema: 'metasheet.welding_command_pending/1', kind: 'resource', owner, action: 'create', resource_id: 'other', source: null,
      body: { resource_id: 'other', request_id: 'original-other', name: 'Other', number: 'O-1', payload: payload() } })
    other.shared.rows.set(key(owner), jsonBytes(prior)); await other.session.submit()
    expect(other.api.createResource).not.toHaveBeenCalled(); expect(other.shared.rows.get(key(owner))).toBe(jsonBytes(prior))
  })
  it('does not clear another durable request or overwrite later in-memory edits after the original ACK', async () => {
    const f = setup(); await f.session.initialize(); f.fill()
    f.api.createResource.mockImplementationOnce(async body => { f.session.state.form.name = 'Later local input'; return createAck(body) })
    await f.session.submit(); expect(f.session.state.form.name).toBe('Later local input'); expect(f.session.state.record).toBeNull()
    expect(f.session.state.message).toContain('后续表单输入和固定依据保持')
    const other = setup(); await other.session.initialize(); other.fill()
    other.api.createResource.mockImplementationOnce(async body => {
      const original = JSON.parse(other.shared.rows.get(key(owner))!); original.body.request_id = 'different-original'
      other.shared.rows.set(key(owner), jsonBytes(original)); return createAck(body)
    })
    await other.session.submit(); expect(other.shared.store.clearResource).not.toHaveBeenCalled(); expect(other.session.state.pending).not.toBeNull()
  })
  it.each(['submit', 'confirm'] as const)('rejects same-owner token/role refresh before %s without waiting for a storage notification', async action => {
    const token = (role: string) => `header.${btoa(JSON.stringify({ sub: '7', roles: [role] }))}.signature`
    localStorage.setItem('auth_token', token('maintainer'))
    const f = setup(); await f.session.initialize(); f.fill()
    if (action === 'confirm') {
      f.api.createResource.mockRejectedValueOnce(new WeldingPlanError('unknown', 502)); await f.session.submit()
    }
    const raw = f.shared.rows.get(key(owner))
    f.api.authority.mockClear(); f.api.createResource.mockClear()
    vi.mocked(f.shared.store.claimResource).mockClear(); vi.mocked(f.shared.store.clearResource).mockClear()
    localStorage.setItem('auth_token', token('reader'))
    await expect(action === 'submit' ? f.session.submit() : f.session.confirmOriginal()).rejects.toThrow('会话准入')
    expect(f.api.authority).not.toHaveBeenCalled(); expect(f.api.createResource).not.toHaveBeenCalled()
    expect(f.shared.store.claimResource).not.toHaveBeenCalled(); expect(f.shared.store.clearResource).not.toHaveBeenCalled()
    expect(f.shared.rows.get(key(owner))).toBe(raw); expect(f.session.state.owner).toBeNull()
    expect(f.session.state.form.name).toBe(''); expect(f.session.state.record).toBeNull(); expect(f.session.state.comparison).toBeNull()
  })
  it('explicit rechecking after a silent signature change drops the old fixed basis before admitting new input', async () => {
    const f = setup(); await f.session.initialize(); await f.session.read('r', 'v1')
    f.session.state.form.name = 'Old admission edit'; f.session.compare()
    localStorage.setItem('auth_token', 'native-B'); await f.session.initialize()
    expect(f.session.state.owner).toEqual(owner); expect(f.session.state.record).toBeNull(); expect(f.session.state.comparison).toBeNull()
    expect(f.session.state.form.name).toBe(''); expect(f.api.reviseResource).not.toHaveBeenCalled()
    expect(f.shared.store.claimResource).not.toHaveBeenCalled(); expect(f.shared.store.clearResource).not.toHaveBeenCalled()
    f.fill(); f.session.state.form.name = 'New admission edit'; await f.session.submit()
    expect(f.api.createResource.mock.calls[0][0].name).toBe('New admission edit')
  })
  it('rejects an in-flight old scope after an explicit A-B-A epoch switch even when the A token text returns', async () => {
    const claims = (tenantId: string) => ({ sub: '7', tenantId, exp: Math.floor(Date.now() / 1000) + 3600 })
    const a = claims('tenant'), b = claims('other-tenant')
    const token = (value: typeof a) => `header.${btoa(JSON.stringify(value))}.signature`
    const switchTo = (value: typeof a) => {
      const change = beginExplicitSessionOrgChange(localStorage.getItem('auth_token')!)!
      const text = token(value); localStorage.setItem('auth_token', text); localStorage.setItem('jwt', text)
      expect(installExplicitSessionOrg(text, value.tenantId, value, change)).toBe(true)
    }
    switchTo(a); const originalToken = localStorage.getItem('auth_token')
    const f = setup(); await f.session.initialize(); f.fill()
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }), held = new Promise<void>(resolve => { release = resolve })
    f.api.authority.mockImplementationOnce(async () => { entered(); await held; return owner })
    const oldOperation = f.session.submit(); await started
    switchTo(b); switchTo(a); expect(localStorage.getItem('auth_token')).toBe(originalToken)
    release(); await oldOperation
    expect(f.api.createResource).not.toHaveBeenCalled(); expect(f.shared.store.claimResource).not.toHaveBeenCalled()
    expect(f.shared.store.clearResource).not.toHaveBeenCalled(); expect(f.session.state.owner).toBeNull(); expect(f.session.state.form.name).toBe('')
    await f.session.initialize(); f.fill(); await f.session.submit()
    expect(f.api.createResource).toHaveBeenCalledTimes(1); expect(f.shared.rows.size).toBe(0)
  })
  it.each(['new', 'revision'] as const)('a second page pending notification preserves the %s form and its fixed comparison', async mode => {
    const shared = memory(), a = setup(shared); await a.session.initialize()
    if (mode === 'revision') await a.session.read('selected-r', 'selected-v1')
    else a.fill()
    a.session.state.form.name = 'This page unsent input'
    if (mode === 'revision') a.session.compare()
    const form = clone(a.session.state.form), selected = clone(a.session.state.record), comparison = clone(a.session.state.comparison)
    const b = setup(shared); await b.session.initialize(); b.fill(); b.session.state.form.name = 'Other page original'
    b.api.createResource.mockRejectedValueOnce(new WeldingPlanError('unknown', 502)); await b.session.submit()
    const pending = clone(b.session.state.pending)!, raw = shared.rows.get(key(owner))!
    await vi.waitFor(() => { expect(a.session.state.pending).toEqual(pending); expect(a.session.state.busy).toBe(false) })
    expect(a.session.state.form).toEqual(form); expect(a.session.state.record).toEqual(selected); expect(a.session.state.comparison).toEqual(comparison)
    expect(a.session.canRequest.value).toBe(false); expect(a.api.createResource).not.toHaveBeenCalled(); expect(a.api.reviseResource).not.toHaveBeenCalled()
    await a.session.initialize()
    expect(a.session.state.form).toEqual(form); expect(a.session.state.record).toEqual(selected); expect(a.session.state.comparison).toEqual(comparison)
    expect(shared.rows.get(key(owner))).toBe(raw)
    await a.session.confirmOriginal()
    expect(a.api.createResource.mock.calls[0][0]).toEqual(b.api.createResource.mock.calls[0][0])
    expect(a.api.createResource.mock.calls[0][0].request_id).toBe(pending.body.request_id); expect(shared.rows.size).toBe(0)
    expect(a.session.state.form).toEqual(form); expect(a.session.state.record).toEqual(selected); expect(a.session.state.comparison).toEqual(comparison)
    expect(a.session.state.message).toContain('固定依据保持')
  })
  it('same-pending subscribe, focus and explicit rechecking preserve later input while retry still sends only the original', async () => {
    const f = setup(); await f.session.initialize(); f.fill()
    f.api.createResource.mockRejectedValueOnce(new WeldingPlanError('unknown', 502)); await f.session.submit()
    const body = clone(f.api.createResource.mock.calls[0][0]), raw = f.shared.rows.get(key(owner))!
    f.session.dispose(); const reload = setup(f.shared); await reload.session.initialize()
    expect(reload.session.state.form.name).toBe(body.name)
    reload.session.state.form.name = 'Later unsent edit'; f.shared.emit()
    await vi.waitFor(() => expect(reload.session.state.busy).toBe(false))
    const calls = reload.api.authority.mock.calls.length; window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => { expect(reload.api.authority.mock.calls.length).toBeGreaterThan(calls); expect(reload.session.state.busy).toBe(false) })
    await reload.session.initialize()
    expect(reload.session.state.form.name).toBe('Later unsent edit'); expect(f.shared.rows.get(key(owner))).toBe(raw)
    expect(reload.api.createResource).not.toHaveBeenCalled(); expect(f.shared.store.claimResource).toHaveBeenCalledTimes(1)
    await reload.session.confirmOriginal()
    expect(reload.api.createResource.mock.calls[0][0]).toEqual(body); expect(reload.session.state.form.name).toBe('Later unsent edit')
    expect(reload.session.state.record).toBeNull(); expect(f.shared.rows.size).toBe(0)
  })
  it.each(['same', 'other-resource', 'other-version'] as const)('an equal-form original ACK projects only the same fixed target: %s', async target => {
    const shared = memory(), a = setup(shared); await a.session.initialize(); await a.session.read('selected-r', 'selected-v1')
    a.session.state.form.name = 'Equal literal edit'; a.session.compare()
    const selected = clone(a.session.state.record), form = clone(a.session.state.form), comparison = clone(a.session.state.comparison)
    const b = setup(shared); await b.session.initialize()
    await b.session.read(target === 'other-resource' ? 'other-r' : 'selected-r', target === 'other-version' ? 'other-v0' : 'selected-v1')
    b.session.state.form.name = form.name; b.session.compare()
    b.api.reviseResource.mockRejectedValueOnce(new WeldingPlanError('unknown', 502)); await b.session.submit()
    await vi.waitFor(() => { expect(a.session.state.pending).toEqual(b.session.state.pending); expect(a.session.state.busy).toBe(false) })
    const pending = clone(a.session.state.pending)!
    expect(a.session.state.form).toEqual(form); expect(a.session.state.record).toEqual(selected); expect(a.session.state.comparison).toEqual(comparison)
    await a.session.confirmOriginal()
    expect(a.api.reviseResource.mock.calls[0][1]).toEqual(b.api.reviseResource.mock.calls[0][1])
    expect(a.api.reviseResource.mock.calls[0][1].request_id).toBe(pending.body.request_id); expect(shared.rows.size).toBe(0)
    if (target === 'same') {
      expect(a.session.state.record?.item_version_id).toBe('resource-v2'); expect(a.session.state.record?.predecessor_version_id).toBe('selected-v1')
      expect(a.session.state.comparison).toBeNull(); expect(a.session.state.message).toContain('已登记固定版本')
    } else {
      expect(a.session.state.record).toEqual(selected); expect(a.session.state.form).toEqual(form); expect(a.session.state.comparison).toEqual(comparison)
      expect(a.session.state.message).toContain('不会被标为已登记')
    }
  })
  it.each(['create', 'revise'] as const)('an equal-form other-page %s original cannot label this page unsent new form as saved', async action => {
    const shared = memory(), a = setup(shared); await a.session.initialize(); a.fill()
    const form = clone(a.session.state.form)
    const b = setup(shared); await b.session.initialize()
    if (action === 'create') {
      b.fill(); b.api.createResource.mockRejectedValueOnce(new WeldingPlanError('unknown', 502))
    } else {
      await b.session.read('other-r', 'other-v1'); b.session.state.form.name = form.name; b.session.compare()
      b.api.reviseResource.mockRejectedValueOnce(new WeldingPlanError('unknown', 502))
    }
    await b.session.submit()
    await vi.waitFor(() => { expect(a.session.state.pending).toEqual(b.session.state.pending); expect(a.session.state.busy).toBe(false) })
    const pending = clone(a.session.state.pending)!
    expect(a.session.state.form).toEqual(form); expect(a.session.state.record).toBeNull()
    expect(a.api.createResource).not.toHaveBeenCalled(); expect(a.api.reviseResource).not.toHaveBeenCalled()
    await a.session.initialize(); expect(a.session.state.form).toEqual(form)
    await a.session.confirmOriginal()
    if (action === 'create') {
      expect(a.api.createResource.mock.calls[0][0]).toEqual(b.api.createResource.mock.calls[0][0])
      expect(a.api.createResource.mock.calls[0][0].request_id).toBe(pending.body.request_id)
    } else {
      expect(a.api.reviseResource.mock.calls[0][1]).toEqual(b.api.reviseResource.mock.calls[0][1])
      expect(a.api.reviseResource.mock.calls[0][1].request_id).toBe(pending.body.request_id)
    }
    expect(shared.store.claimResource).toHaveBeenCalledTimes(1); expect(shared.rows.size).toBe(0)
    expect(a.session.state.form).toEqual(form); expect(a.session.state.record).toBeNull(); expect(a.session.state.comparison).toBeNull()
    expect(a.session.state.message).toContain('不会被标为已登记')
  })
  it('editing a restored original and returning to equal values does not regain its ACK presentation stamp', async () => {
    const f = setup(); await f.session.initialize(); f.fill()
    f.api.createResource.mockRejectedValueOnce(new WeldingPlanError('unknown', 502)); await f.session.submit()
    const body = clone(f.api.createResource.mock.calls[0][0]); f.session.dispose()
    const reload = setup(f.shared); await reload.session.initialize()
    expect(reload.session.state.form.name).toBe(body.name)
    reload.session.state.form.name = 'Changed local intent'; reload.session.state.form.name = body.name
    await reload.session.confirmOriginal()
    expect(reload.api.createResource.mock.calls[0][0]).toEqual(body); expect(f.shared.rows.size).toBe(0)
    expect(reload.session.state.form.name).toBe(body.name); expect(reload.session.state.record).toBeNull()
    expect(reload.session.state.message).toContain('不会被标为已登记')
  })
  it('write-off and a changed native signature never dispatch, even if a caller invokes the method directly', async () => {
    const f = setup(); await f.session.initialize(); f.fill(); f.disableWrite()
    await expect(f.session.submit()).rejects.toThrow(); expect(f.api.createResource).not.toHaveBeenCalled()
    const late = setup(); await late.session.initialize(); late.fill()
    late.api.authority.mockImplementationOnce(async () => { localStorage.setItem('auth_token', 'native-B'); return owner })
    await late.session.submit(); expect(late.api.createResource).not.toHaveBeenCalled(); expect(late.session.state.owner).toBeNull()
  })
})

describe('actual single-resource controls independent of a selected plan', () => {
  const button = (label: string) => [...root!.querySelectorAll('button')].find(value => value.textContent?.trim() === label)!
  async function input(label: string, value: string) {
    const field = [...root!.querySelectorAll('label')].find(row => row.childNodes[0].textContent?.trim() === label)!.querySelector<HTMLInputElement | HTMLSelectElement>('input,select')!
    field.value = value; field.dispatchEvent(new Event(field.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); await nextTick()
  }
  it('queries and pages actual controls, explicitly selects history and fixed document without auto-registering', async () => {
    const f = setup(); await f.session.initialize()
    root = document.createElement('div'); document.body.appendChild(root); app = createApp({ render: () => h(Panel, { resources: f.session }) }); app.mount(root)
    await input('查询类别', 'material'); await input('查询板厚 A 数值', '0'); await input('查询板厚 A 单位', 'mm')
    f.api.resourceCatalog.mockResolvedValueOnce(catalog([summary()], cursor)); button('查询资料').click()
    await vi.waitFor(() => expect(button('下一页资料').disabled).toBe(false))
    expect(f.api.resourceCatalog.mock.calls[0][0]).toEqual({ kind: 'material', thickness_a_value: 0, thickness_a_unit: 'mm', limit: 20 })
    expect(f.session.state.record).toBeNull(); button('下一页资料').click()
    await vi.waitFor(() => { expect(f.api.resourceCatalog).toHaveBeenCalledTimes(2); expect(f.session.state.busy).toBe(false) }); await nextTick()
    expect(f.api.resourceCatalog.mock.calls[1][0].cursor).toBe(cursor)
    f.api.resourceVersionCatalog.mockResolvedValueOnce(versions([summary('r', 'v10')], cursor)); button('查看 M-1 的版本').click()
    await vi.waitFor(() => expect(button('下一页版本').disabled).toBe(false))
    expect(root.textContent).toContain('不代表创建时序'); expect(root.textContent).toContain('current-outside-page')
    f.api.resourceVersionCatalog.mockResolvedValueOnce({ ...versions([summary('r', 'v2')]), current_version_id: null }); button('下一页版本').click()
    await vi.waitFor(() => expect(button('读取历史版本 v2')).toBeDefined())
    expect(root.textContent).toContain('不表示资料没有 current'); button('读取历史版本 v2').click()
    await vi.waitFor(() => expect(f.session.state.record?.item_version_id).toBe('v2')); await nextTick()
    await input('文档查询', 'fixed'); f.api.resourceDocumentCatalog.mockResolvedValueOnce({ ...documentCatalog(), next_cursor: cursor }); button('查询文档候选').click()
    await vi.waitFor(() => expect(button('下一页文档').disabled).toBe(false))
    expect(f.session.state.form.payload.document).toBeUndefined(); button('下一页文档').click()
    await vi.waitFor(() => { expect(f.api.resourceDocumentCatalog).toHaveBeenCalledTimes(2); expect(f.session.state.busy).toBe(false) }); await nextTick()
    button('明确选择文档 fixed.pdf').click(); await vi.waitFor(() => expect(f.session.state.form.payload.document).toEqual(fixedDocument))
    expect(f.api.createResource).not.toHaveBeenCalled(); expect(f.api.reviseResource).not.toHaveBeenCalled()
    expect(root.querySelector<HTMLInputElement>('input[maxlength="64"]')).not.toBeNull()
  })
  it('requires identity and a deliberate button click, then registers only explicitly selected filler values with no plan grant', async () => {
    const f = setup(); root = document.createElement('div'); document.body.appendChild(root); app = createApp({ render: () => h(Panel, { resources: f.session }) }); app.mount(root)
    expect(button('确认请求登记资料草稿').disabled).toBe(true); expect(f.api.createResource).not.toHaveBeenCalled()
    button('核对身份与个人原资料请求').click(); await vi.waitFor(() => expect(f.session.state.owner).toEqual(owner))
    await input('资料名称', 'Filler'); await input('资料编号', 'F-1'); await input('资料类别', 'filler')
    const selected = [...root.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].find(row => row.parentElement!.textContent!.includes('明确登记 填充材料'))!
    selected.checked = true; selected.dispatchEvent(new Event('change', { bubbles: true })); await nextTick()
    const value = root.querySelector<HTMLInputElement>('input[aria-label="填充材料"]')!; value.value = 'ER70S-6'; value.dispatchEvent(new Event('input', { bubbles: true })); await nextTick()
    expect(f.api.createResource).not.toHaveBeenCalled(); button('确认请求登记资料草稿').click()
    await vi.waitFor(() => expect(f.session.state.record?.number).toBe('F-1'))
    expect(f.api.createResource.mock.calls[0][0].payload).toEqual({ schema_version: 1, kind: 'filler', suggested_fields: { filler: 'ER70S-6' } })
    expect(root.textContent).toContain('权限由服务器逐次判定'); expect(f.session.state).not.toHaveProperty('planId')
  })
  it('freezes controls around an unknown original and reload merely exposes the explicit same-request confirmation', async () => {
    const f = setup(); await f.session.initialize(); f.fill(); f.api.createResource.mockRejectedValueOnce(new WeldingPlanError('unknown', 502)); await f.session.submit()
    root = document.createElement('div'); document.body.appendChild(root); app = createApp({ render: () => h(Panel, { resources: f.session }) }); app.mount(root); await nextTick()
    expect(root.querySelector('fieldset')?.disabled).toBe(true); expect(button('确认请求登记资料草稿').disabled).toBe(true)
    expect(button('明确重发同一原资料请求').disabled).toBe(false); expect(f.api.createResource).toHaveBeenCalledTimes(1)
    button('明确重发同一原资料请求').click(); await vi.waitFor(() => expect(f.session.state.pending).toBeNull())
    expect(equal(f.api.createResource.mock.calls[0][0], f.api.createResource.mock.calls[1][0])).toBe(true)
  })
})

describe('fixed diagram read inside the actual resource session', () => {
  it('shows the saved version in the actual maintenance panel and revokes on unregistered source editing', async () => {
    const nativeUrl = URL, revoke = vi.fn()
    vi.stubGlobal('URL', class extends nativeUrl { static createObjectURL = vi.fn(() => 'blob:maintenance'); static revokeObjectURL = revoke })
    vi.stubGlobal('Image', class { naturalWidth = 1; naturalHeight = 1; onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(value: string) { if (value) queueMicrotask(() => this.onload?.()) } })
    const f = setup(); f.api.readResource.mockResolvedValue(record('r', 'v1', 'Joint', 'J1', payload('joint_diagram')))
    await f.session.initialize(); await f.session.read('r', 'v1')
    root = document.createElement('div'); document.body.appendChild(root); app = createApp({ render: () => h(Panel, { resources: f.session }) }); app.mount(root)
    const button = [...root.querySelectorAll('button')].find(value => value.textContent === '读取并预览固定接头图')!
    button.click(); await vi.waitFor(() => expect(root!.querySelector('img')).not.toBeNull())
    f.session.state.form.payload.document!.file_id = 'unregistered-other-file'; await nextTick()
    expect(root.querySelector('img')).toBeNull(); expect(revoke).toHaveBeenCalledTimes(1)
    expect(f.session.state.record!.payload.document!.file_id).toBe(fixedDocument.file_id)
    expect(f.api.reviseResource).not.toHaveBeenCalled(); expect(f.session.state.form.payload.document!.file_id).toBe('unregistered-other-file')
  })
  it('reads the saved fixed image without replacing dirty form, comparison or durable pending', async () => {
    const f = setup(); f.api.readResource.mockResolvedValue(record('r', 'v1', 'Joint', 'J1', payload('joint_diagram')))
    await f.session.initialize(); await f.session.read('r', 'v1')
    f.session.state.form.name = 'Unregistered revision'; f.session.compare()
    f.api.reviseResource.mockRejectedValueOnce(new WeldingPlanError('unknown', 0)); await f.session.submit()
    const before = clone({ form: f.session.state.form, record: f.session.state.record, comparison: f.session.state.comparison, pending: f.session.state.pending })
    const durable = f.shared.rows.get(key(owner)), result = await f.session.readDiagram({ accepts: () => true })
    expect(result.record.item_version_id).toBe('v1'); expect(result.scope.accepts()).toBe(true)
    expect({ form: f.session.state.form, record: f.session.state.record, comparison: f.session.state.comparison, pending: f.session.state.pending }).toEqual(before)
    expect(f.shared.rows.get(key(owner))).toBe(durable); expect(f.shared.store.clearResource).not.toHaveBeenCalled()
  })
  it('rejects a late diagram after form edit-revert and leaves the later input untouched', async () => {
    const f = setup(); f.api.readResource.mockResolvedValue(record('r', 'v1', 'Joint', 'J1', payload('joint_diagram')))
    await f.session.initialize(); await f.session.read('r', 'v1')
    let finish!: (blob: Blob) => void; f.api.readResourceDiagram.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const job = f.session.readDiagram({ accepts: () => true }); await vi.waitFor(() => expect(f.api.readResourceDiagram).toHaveBeenCalled())
    f.session.state.form.name = 'edit'; f.session.state.form.name = 'Joint'
    const assertion = expect(job).rejects.toThrow(); finish(new Blob(['qualified-image-content'], { type: 'image/png' })); await assertion
    expect(f.session.state.form.name).toBe('Joint'); expect(f.api.reviseResource).not.toHaveBeenCalled()
  })
  it('rejects owner drift after the image await and hides the old record', async () => {
    const f = setup(); f.api.readResource.mockResolvedValue(record('r', 'v1', 'Joint', 'J1', payload('joint_diagram')))
    await f.session.initialize(); await f.session.read('r', 'v1')
    f.api.readResourceDiagram.mockImplementationOnce(async () => { f.changeOwner({ ...owner, rbac_user_id: 22 }); return new Blob(['qualified-image-content'], { type: 'image/png' }) })
    await expect(f.session.readDiagram({ accepts: () => true })).rejects.toThrow('身份')
    expect(f.session.state.record).toBeNull(); expect(f.session.state.owner).toBeNull()
  })
})
