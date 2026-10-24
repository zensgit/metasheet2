import { clone, equal, exact, isHash, isObject, jsonBytes, need, safeId, sourceId, text, DRAFT_BYTES } from './planRecovery'

export const resourceKinds = ['wps', 'pqr', 'parameter_reference', 'requirements', 'material', 'filler', 'joint_diagram'] as const
export type ResourceKind = typeof resourceKinds[number]
export const resourceKindFields: Record<ResourceKind, string[]> = {
  wps: ['method', 'material_a', 'material_b', 'filler', 'joint_type', 'thickness_a', 'thickness_b', 'welding_requirements', 'inspection_requirements', 'passes'],
  pqr: ['method', 'material_a', 'material_b', 'filler', 'joint_type', 'thickness_a', 'thickness_b', 'welding_requirements', 'inspection_requirements', 'passes'],
  parameter_reference: ['method', 'material_a', 'material_b', 'filler', 'joint_type', 'thickness_a', 'thickness_b', 'passes'],
  requirements: ['welding_requirements', 'inspection_requirements'], material: ['material_a', 'material_b'], filler: ['filler'], joint_diagram: ['joint_type'],
}
export interface ResourceDocument { item_id: string; version_id: string; file_id: string; file_role: 'attachment' | 'reference'; expected_fingerprint: string }
export interface ResourcePayload { schema_version: 1; kind: ResourceKind; suggested_fields: Record<string, unknown>; document?: ResourceDocument }
export interface ResourceForm { name: string; number: string; payload: ResourcePayload }
export interface ResourceBasis { resource_id: string; item_version_id: string; content_hash: string; number: string; kind: ResourceKind }
export interface ResourceMaintenanceRecord extends ResourceForm, ResourceBasis { version_label: string; state: string; sources: Record<string, unknown>; predecessor_version_id?: string; predecessor_content_hash?: string }
export interface DiagramQualification { schema: 'yuantus.welding_joint_diagram/1'; actual_sha256: string; byte_size: number; mime_type: 'image/png' | 'image/jpeg' | 'image/webp'; format: 'png' | 'jpeg' | 'webp'; width: number; height: number; exif_orientation: number }
export function resourceDiagram(record: ResourceMaintenanceRecord): DiagramQualification {
  const value = validateResourceMaintenanceRecord(record, record.resource_id, record.item_version_id)
  need(value.kind === 'joint_diagram', '仅可读取固定接头图资料')
  return clone(value.sources.diagram) as DiagramQualification
}
export interface CreateResourceRequest extends ResourceForm { resource_id: string; request_id: string }
export interface ReviseResourceRequest { request_id: string; source_version_id: string; expected_current_version_id: string; expected_content_hash: string; name: string; payload: ResourcePayload }
export type ResourceOriginal = { action: 'create'; resource_id: string; body: CreateResourceRequest; source: null }
  | { action: 'revise'; resource_id: string; body: ReviseResourceRequest; source: ResourceBasis }

export const RESOURCE_CATALOG_BYTES = 2 * 1024 * 1024
export interface ResourceSummary extends ResourceBasis { version_label: string; state: string; name: string }
export interface ResourceCatalog { schema: 'yuantus.welding_resource_catalog/1'; items: ResourceSummary[]; next_cursor: string | null }
export interface ResourceVersionCatalog { schema: 'yuantus.welding_resource_versions/1'; resource_id: string; current_version_id: string | null; items: ResourceSummary[]; next_cursor: string | null }
export interface ResourceDocumentCandidate { item_id: string; version_id: string; file_id: string; file_role: 'attachment' | 'reference'; title: string; version_label: string | null; state: string | null; is_released: boolean; file_name: string; checksum: string; fingerprint: string }
export interface ResourceDocumentCatalog { schema: 'yuantus.welding_process_reference_catalog/1'; items: ResourceDocumentCandidate[]; limit: 20; next_cursor: string | null }
export interface ResourceCatalogQuery {
  kind?: ResourceKind; method?: string; material_a?: string; material_b?: string; filler?: string; joint_type?: string
  thickness_a_value?: number; thickness_a_unit?: 'mm' | 'in'; thickness_b_value?: number; thickness_b_unit?: 'mm' | 'in'
  limit?: number; cursor?: string
}
export function validateResourceCursor(value: unknown): asserts value is string {
  need(typeof value === 'string' && value.length <= 4096 && /^[A-Za-z0-9_-]+\.[0-9a-f]{64}$/.test(value), '分页凭据格式不可确认')
  const part = value.split('.')[0]
  need(part.length % 4 !== 1)
  const decoded = atob(part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - part.length % 4) % 4))
  need(btoa(decoded).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') === part, '分页凭据不是规范 base64url')
}
export function resourceCatalogQuery(value: ResourceCatalogQuery): string {
  const names = ['kind', 'method', 'material_a', 'material_b', 'filler', 'joint_type', 'thickness_a_value', 'thickness_a_unit', 'thickness_b_value', 'thickness_b_unit', 'limit', 'cursor']
  exact(value, [], names)
  if (Object.hasOwn(value, 'kind')) need(resourceKinds.includes(value.kind as ResourceKind))
  for (const key of ['method', 'material_a', 'material_b', 'filler', 'joint_type']) if (Object.hasOwn(value, key)) { text(value[key]); need(Array.from(value[key] as string).length <= 256) }
  for (const side of ['a', 'b']) {
    const amount = `thickness_${side}_value`, unit = `thickness_${side}_unit`
    need(Object.hasOwn(value, amount) === Object.hasOwn(value, unit), '板厚数值和单位须成对填写')
    if (Object.hasOwn(value, amount)) need(typeof value[amount] === 'number' && Number.isFinite(value[amount]) && (value[amount] as number) >= 0 && ['mm', 'in'].includes(value[unit] as string))
  }
  if (Object.hasOwn(value, 'limit')) need(Number.isInteger(value.limit) && (value.limit as number) >= 1 && (value.limit as number) <= 20)
  if (Object.hasOwn(value, 'cursor')) validateResourceCursor(value.cursor)
  return new URLSearchParams(names.filter(key => Object.hasOwn(value, key)).map(key => [key, String(value[key])])).toString()
}
export function resourceVersionQuery(value: { limit?: number; cursor?: string }): string {
  exact(value, [], ['limit', 'cursor']); return resourceCatalogQuery(value)
}
export function resourceDocumentQuery(query: string, cursor?: string): string {
  text(query); need(Array.from(query).length >= 1 && Array.from(query).length <= 100 && query.trim() === query && !/[\r\n]/.test(query), '文档查询须为 1–100 个单行字符')
  if (cursor !== undefined) validateResourceCursor(cursor)
  return new URLSearchParams({ query, ...(cursor === undefined ? {} : { cursor }) }).toString()
}
function catalogEnvelope(value: unknown, fields: string[], schema: string, limit: number): asserts value is Record<string, unknown> {
  need(Number.isInteger(limit) && limit >= 1 && limit <= 20)
  exact(value, fields); need(value.schema === schema && Array.isArray(value.items) && value.items.length <= limit)
  need(new TextEncoder().encode(jsonBytes(value)).byteLength <= RESOURCE_CATALOG_BYTES, '目录回应超过 2 MiB')
  if (value.next_cursor !== null) { validateResourceCursor(value.next_cursor); need(value.items.length === limit, '带分页凭据的目录页必须完整') }
}
function resourceSummaries(items: unknown, resource?: string): void {
  need(Array.isArray(items)); const seen = new Set<string>()
  for (const row of items) {
    exact(row, ['resource_id', 'item_version_id', 'version_label', 'state', 'name', 'number', 'kind', 'content_hash'])
    for (const key of ['resource_id', 'item_version_id']) { safeId(row[key]); sourceId(row[key]) }
    need(resource === undefined || row.resource_id === resource)
    referenceName(row.name); referenceName(row.number)
    for (const key of ['version_label', 'state']) { text(row[key]); need(Array.from(row[key] as string).length > 0 && Array.from(row[key] as string).length <= 128) }
    need(resourceKinds.includes(row.kind as ResourceKind) && isHash(row.content_hash))
    const key = jsonBytes([row.resource_id, row.item_version_id]); need(!seen.has(key)); seen.add(key)
  }
}
export function validateResourceCatalog(value: unknown, limit = 20): ResourceCatalog {
  catalogEnvelope(value, ['schema', 'items', 'next_cursor'], 'yuantus.welding_resource_catalog/1', limit); resourceSummaries(value.items)
  return clone(value) as unknown as ResourceCatalog
}
export function validateResourceVersionCatalog(value: unknown, resource: string, limit = 20): ResourceVersionCatalog {
  catalogEnvelope(value, ['schema', 'resource_id', 'current_version_id', 'items', 'next_cursor'], 'yuantus.welding_resource_versions/1', limit)
  need(value.resource_id === resource); safeId(value.resource_id); sourceId(value.resource_id)
  if (value.current_version_id !== null) { safeId(value.current_version_id); sourceId(value.current_version_id) }
  resourceSummaries(value.items, resource)
  return clone(value) as unknown as ResourceVersionCatalog
}
export function validateResourceDocumentCatalog(value: unknown): ResourceDocumentCatalog {
  catalogEnvelope(value, ['schema', 'items', 'limit', 'next_cursor'], 'yuantus.welding_process_reference_catalog/1', 20); need(value.limit === 20)
  const seen = new Set<string>()
  for (const row of value.items as unknown[]) {
    exact(row, ['item_id', 'version_id', 'file_id', 'file_role', 'title', 'version_label', 'state', 'is_released', 'file_name', 'checksum', 'fingerprint'])
    for (const key of ['item_id', 'version_id', 'file_id']) sourceId(row[key])
    need(['attachment', 'reference'].includes(row.file_role as string) && typeof row.is_released === 'boolean' && isHash(row.checksum) && isHash(row.fingerprint))
    text(row.title); text(row.file_name)
    for (const key of ['version_label', 'state']) if (row[key] !== null) text(row[key])
    const key = jsonBytes([row.item_id, row.version_id, row.file_id, row.file_role]); need(!seen.has(key)); seen.add(key)
  }
  return clone(value) as unknown as ResourceDocumentCatalog
}

function referenceName(value: unknown): asserts value is string {
  text(value)
  const chars = Array.from(value), space = /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/
  need(chars.length > 0 && chars.length <= 128 && !space.test(chars[0]) && !space.test(chars[chars.length - 1]) && !/[\r\n]/.test(value))
}
function quantity(value: unknown, units: string[]): void {
  exact(value, ['value', 'unit'])
  need(typeof value.value === 'number' && Number.isFinite(value.value) && value.value >= 0 && typeof value.unit === 'string' && units.includes(value.unit))
}
export function validateResourcePayload(value: unknown): ResourcePayload {
  exact(value, ['schema_version', 'kind', 'suggested_fields'], ['document'])
  need(value.schema_version === 1 && typeof value.kind === 'string' && resourceKinds.includes(value.kind as ResourceKind))
  const kind = value.kind as ResourceKind, fields = value.suggested_fields
  need(isObject(fields) && Object.keys(fields).every(key => resourceKindFields[kind].includes(key)))
  for (const [key, field] of Object.entries(fields)) {
    if (key === 'thickness_a' || key === 'thickness_b') quantity(field, ['mm', 'in'])
    else if (key === 'passes') {
      need(Array.isArray(field) && field.length <= 100)
      const sequences = new Set<number>()
      for (const pass of field) {
        exact(pass, ['sequence'], ['method', 'filler', 'current', 'voltage', 'speed'])
        need(Number.isSafeInteger(pass.sequence) && (pass.sequence as number) >= 1 && !sequences.has(pass.sequence as number)); sequences.add(pass.sequence as number)
        for (const name of ['method', 'filler']) if (Object.hasOwn(pass, name)) { text(pass[name]); need(Array.from(pass[name] as string).length <= 256) }
        for (const [name, units] of [['current', ['A']], ['voltage', ['V']], ['speed', ['mm/min', 'in/min']]] as const)
          if (Object.hasOwn(pass, name) && pass[name] !== null) quantity(pass[name], [...units])
      }
    } else { text(field); need(Array.from(field).length <= (key.endsWith('requirements') ? 4000 : 256)) }
  }
  if (Object.hasOwn(value, 'document')) {
    exact(value.document, ['item_id', 'version_id', 'file_id', 'file_role', 'expected_fingerprint'])
    for (const key of ['item_id', 'version_id', 'file_id']) sourceId(value.document[key])
    need(['attachment', 'reference'].includes(value.document.file_role as string) && typeof value.document.file_role === 'string'
      && typeof value.document.expected_fingerprint === 'string' && /^[0-9a-fA-F]{64}$/.test(value.document.expected_fingerprint))
  }
  need(!['wps', 'pqr', 'joint_diagram'].includes(kind) || Object.hasOwn(value, 'document'), '此类别必须明确填写固定文档来源')
  return clone(value) as unknown as ResourcePayload
}
export function validateResourceForm(value: unknown): ResourceForm {
  exact(value, ['name', 'number', 'payload']); referenceName(value.name); referenceName(value.number); validateResourcePayload(value.payload)
  return clone(value) as unknown as ResourceForm
}
export function validateResourceOriginal(value: unknown): ResourceOriginal {
  exact(value, ['action', 'resource_id', 'body', 'source']); safeId(value.resource_id); sourceId(value.resource_id)
  if (value.action === 'create') {
    exact(value.body, ['resource_id', 'request_id', 'name', 'number', 'payload'])
    need(value.source === null && value.body.resource_id === value.resource_id)
    validateResourceForm({ name: value.body.name, number: value.body.number, payload: value.body.payload })
  } else {
    need(value.action === 'revise')
    exact(value.body, ['request_id', 'source_version_id', 'expected_current_version_id', 'expected_content_hash', 'name', 'payload'])
    exact(value.source, ['resource_id', 'item_version_id', 'content_hash', 'number', 'kind'])
    safeId(value.source.item_version_id); sourceId(value.source.item_version_id); referenceName(value.source.number)
    need(value.source.resource_id === value.resource_id && isHash(value.source.content_hash) && value.body.source_version_id === value.source.item_version_id
      && value.body.expected_current_version_id === value.source.item_version_id && value.body.expected_content_hash === value.source.content_hash)
    validateResourceForm({ name: value.body.name, number: value.source.number, payload: value.body.payload })
    need(isObject(value.body.payload) && value.body.payload.kind === value.source.kind)
  }
  sourceId(value.body.request_id)
  need(new TextEncoder().encode(jsonBytes(value.body)).byteLength <= DRAFT_BYTES, '资料原请求超过 5 MiB')
  return clone(value) as unknown as ResourceOriginal
}
export function resourcePath(original: ResourceOriginal): string {
  validateResourceOriginal(original)
  return original.action === 'create' ? '/resources' : `/resources/${encodeURIComponent(original.resource_id)}/revisions`
}
export function validateResourceMaintenanceRecord(value: unknown, resource: string, version?: string): ResourceMaintenanceRecord {
  exact(value, ['resource_id', 'item_version_id', 'content_hash', 'name', 'number', 'kind', 'payload', 'sources', 'version_label', 'state'], ['predecessor_version_id', 'predecessor_content_hash'])
  safeId(value.item_version_id); sourceId(value.item_version_id); need(value.resource_id === resource && (version === undefined || value.item_version_id === version) && isHash(value.content_hash))
  validateResourceForm({ name: value.name, number: value.number, payload: value.payload })
  text(value.version_label); text(value.state); need(value.version_label.length > 0 && Array.from(value.version_label).length <= 128 && value.state.length > 0 && Array.from(value.state).length <= 128)
  const payload = validateResourcePayload(value.payload); need(value.kind === payload.kind)
  if (payload.document) {
    exact(value.sources, payload.kind === 'joint_diagram' ? ['document', 'diagram'] : ['document'])
    exact(value.sources.document, ['item_id', 'version_id', 'file_id', 'file_role', 'title', 'version_label', 'state', 'is_released', 'file_name', 'checksum', 'fingerprint'])
    const source = value.sources.document
    need(['item_id', 'version_id', 'file_id', 'file_role'].every(key => source[key] === payload.document![key as keyof ResourceDocument])
      && source.fingerprint === payload.document.expected_fingerprint.toLowerCase() && isHash(source.checksum) && typeof source.is_released === 'boolean')
    text(source.title); text(source.file_name)
    for (const key of ['version_label', 'state']) if (source[key] !== null) text(source[key])
    if (payload.kind === 'joint_diagram') {
      exact(value.sources.diagram, ['schema', 'actual_sha256', 'byte_size', 'mime_type', 'format', 'width', 'height', 'exif_orientation'])
      const d = value.sources.diagram
      need(d.schema === 'yuantus.welding_joint_diagram/1' && d.actual_sha256 === source.checksum && Number.isSafeInteger(d.byte_size) && (d.byte_size as number) > 0 && (d.byte_size as number) <= DRAFT_BYTES
        && [['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp']].some(([format, mime]) => format === d.format && mime === d.mime_type))
      for (const key of ['width', 'height', 'exif_orientation']) need(Number.isSafeInteger(d[key]) && (d[key] as number) >= 1 && (d[key] as number) <= (key === 'exif_orientation' ? 8 : 4096))
    }
  } else exact(value.sources, [])
  need(Object.hasOwn(value, 'predecessor_version_id') === Object.hasOwn(value, 'predecessor_content_hash'))
  if (Object.hasOwn(value, 'predecessor_version_id')) { safeId(value.predecessor_version_id); sourceId(value.predecessor_version_id); need(isHash(value.predecessor_content_hash)) }
  return clone(value) as unknown as ResourceMaintenanceRecord
}
export function validateResourceAck(value: unknown, input: ResourceOriginal): ResourceMaintenanceRecord {
  const original = validateResourceOriginal(input), result = validateResourceMaintenanceRecord(value, original.resource_id)
  need(result.state === 'Draft' && result.name === original.body.name && equal(result.payload, original.body.payload), '资料回应不符合原请求，请保留原请求')
  if (original.action === 'create') need(result.number === original.body.number && result.predecessor_version_id === undefined && result.predecessor_content_hash === undefined)
  else need(result.number === original.source.number && result.kind === original.source.kind && result.item_version_id !== original.source.item_version_id
    && result.predecessor_version_id === original.source.item_version_id && result.predecessor_content_hash === original.source.content_hash)
  return result
}
