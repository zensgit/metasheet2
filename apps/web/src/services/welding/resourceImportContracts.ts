import { clone, equal, exact, isHash, jsonBytes, need, sourceId, text, validateOwner, type WeldingOwner } from './planRecovery'
import { resourceKinds, validateResourceForm, type ResourceDocument, type ResourceKind, type ResourcePayload } from './resourceContracts'

export const IMPORT_RAW_BYTES = 5 * 1024 * 1024
export const IMPORT_METADATA_BYTES = 512 * 1024
export const IMPORT_PREVIEW_BYTES = 32 * 1024 * 1024
export const IMPORT_RESPONSE_BYTES = 1024 * 1024
export const IMPORT_DEADLINE_MS = 330000
export type ResourceImportFormat = 'csv' | 'xlsx'
export interface ResourceImportIssue { row: number | null; column: string; code: string; message: string }
export interface ResourceImportIdentity { row: number; row_key: string; name: string; number: string; kind: ResourceKind }
export interface ResourceImportRow { row: number; row_key: string; name: string; number: string; payload: ResourcePayload; sources?: Record<string, unknown> }
export interface ResourceImportPreview {
  schema: 'yuantus.welding_resource_import/1'; format: ResourceImportFormat; raw_sha256: string; normalized_sha256: string
  preview_digest: string | null; total_rows: number; ready: boolean; rows: ResourceImportRow[]; errors: ResourceImportIssue[]
}
export interface ResourceImportPending {
  schema: 'metasheet.welding_resource_import_pending/1'; kind: 'resource-import'; owner: WeldingOwner
  import_id: string; format: ResourceImportFormat; bytes: ArrayBuffer; raw_sha256: string; normalized_sha256: string
  preview_digest: string; total_rows: number; rows: ResourceImportIdentity[]
}
export interface ResourceImportItem extends ResourceImportIdentity { resource_id: string; item_version_id: string; version_label: string; content_hash: string; state: 'Draft' }
export interface ResourceImportReceipt {
  schema: 'yuantus.welding_resource_import/1'; import_id: string; raw_sha256: string; normalized_sha256: string
  preview_digest: string; total_rows: number; items: ResourceImportItem[]
}
export function importFormat(value: unknown): asserts value is ResourceImportFormat { need(value === 'csv' || value === 'xlsx', '请选择 CSV 或 XLSX 格式') }
export function copyImportBytes(value: unknown): ArrayBuffer {
  need(value instanceof ArrayBuffer && Object.getPrototypeOf(value) === ArrayBuffer.prototype
    && !(value as ArrayBuffer & { resizable?: boolean }).resizable && value.byteLength > 0 && value.byteLength <= IMPORT_RAW_BYTES, '原文件必须为定长二进制，且不超过 5 MiB')
  return value.slice(0)
}
export async function hashImportBytes(value: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', copyImportBytes(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
function identity(value: unknown): asserts value is ResourceImportIdentity {
  exact(value, ['row', 'row_key', 'name', 'number', 'kind']); sourceId(value.row_key)
  need(Number.isSafeInteger(value.row) && (value.row as number) >= 2 && (value.row as number) <= 101 && resourceKinds.includes(value.kind as ResourceKind))
  validateResourceForm({ name: value.name, number: value.number, payload: { schema_version: 1, kind: 'material', suggested_fields: {} } })
}
export function importIdentities(rows: ResourceImportRow[]): ResourceImportIdentity[] {
  return rows.map(row => ({ row: row.row, row_key: row.row_key, name: row.name, number: row.number, kind: row.payload.kind }))
}
export function validateImportIssues(value: unknown): ResourceImportIssue[] {
  need(Array.isArray(value))
  for (const issue of value) {
    exact(issue, ['row', 'column', 'code', 'message'])
    need(issue.row === null || Number.isSafeInteger(issue.row) && (issue.row as number) >= 2 && (issue.row as number) <= 101)
    for (const key of ['column', 'code', 'message']) text(issue[key])
    need((issue.code as string).length > 0 && (issue.message as string).length > 0)
  }
  return clone(value) as ResourceImportIssue[]
}
function sources(row: ResourceImportRow): void {
  const payload = row.payload, value = row.sources
  if (!payload.document) { exact(value, []); return }
  exact(value, payload.kind === 'joint_diagram' ? ['document', 'diagram'] : ['document'])
  exact(value.document, ['item_id', 'version_id', 'file_id', 'file_role', 'title', 'version_label', 'state', 'is_released', 'file_name', 'checksum', 'fingerprint'])
  const source = value.document
  need(['item_id', 'version_id', 'file_id', 'file_role'].every(key => source[key] === payload.document![key as keyof ResourceDocument])
    && source.fingerprint === payload.document.expected_fingerprint.toLowerCase() && isHash(source.checksum) && typeof source.is_released === 'boolean')
  text(source.title); text(source.file_name)
  for (const key of ['version_label', 'state']) if (source[key] !== null) text(source[key])
  if (payload.kind === 'joint_diagram') {
    exact(value.diagram, ['schema', 'actual_sha256', 'byte_size', 'mime_type', 'format', 'width', 'height', 'exif_orientation'])
    const d = value.diagram
    need(d.schema === 'yuantus.welding_joint_diagram/1' && d.actual_sha256 === source.checksum && Number.isSafeInteger(d.byte_size)
      && (d.byte_size as number) > 0 && (d.byte_size as number) <= IMPORT_RAW_BYTES
      && [['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp']].some(([format, mime]) => format === d.format && mime === d.mime_type))
    for (const key of ['width', 'height', 'exif_orientation']) need(Number.isSafeInteger(d[key]) && (d[key] as number) >= 1 && (d[key] as number) <= (key === 'exif_orientation' ? 8 : 4096))
  }
}
export function validateImportPreview(value: unknown, format: ResourceImportFormat, rawHash: string): ResourceImportPreview {
  exact(value, ['schema', 'format', 'raw_sha256', 'normalized_sha256', 'preview_digest', 'total_rows', 'ready', 'rows', 'errors'])
  importFormat(format); need(isHash(rawHash) && value.schema === 'yuantus.welding_resource_import/1' && value.format === format && value.raw_sha256 === rawHash && isHash(value.normalized_sha256))
  need(typeof value.ready === 'boolean' && Number.isSafeInteger(value.total_rows) && (value.total_rows as number) >= 0 && (value.total_rows as number) <= 100)
  need(value.ready ? isHash(value.preview_digest) : value.preview_digest === null)
  const errors = validateImportIssues(value.errors), total = value.total_rows as number
  need(Array.isArray(value.rows) && value.rows.length <= total)
  const numbers = new Set<number>(), keys = new Set<string>()
  for (const row of value.rows) {
    exact(row, ['row', 'row_key', 'name', 'number', 'payload'], ['sources'])
    const form = validateResourceForm({ name: row.name, number: row.number, payload: row.payload })
    const id = { row: row.row, row_key: row.row_key, name: row.name, number: row.number, kind: form.payload.kind }; identity(id)
    need(id.row <= total + 1 && !numbers.has(id.row) && !keys.has(id.row_key)); numbers.add(id.row); keys.add(id.row_key)
    if (Object.hasOwn(row, 'sources')) sources(row as unknown as ResourceImportRow)
    if (value.ready) need(Object.hasOwn(row, 'sources'))
  }
  if (value.ready) need(total >= 1 && value.rows.length === total && errors.length === 0 && value.rows.every((row, index) => row.row === index + 2))
  need(new TextEncoder().encode(jsonBytes(value)).byteLength <= IMPORT_PREVIEW_BYTES)
  return clone(value) as unknown as ResourceImportPreview
}
export function importMetadata(value: ResourceImportPending): Omit<ResourceImportPending, 'bytes'> {
  const { bytes: _bytes, ...metadata } = value
  return clone(metadata)
}
export function validateImportPending(value: unknown): ResourceImportPending {
  exact(value, ['schema', 'kind', 'owner', 'import_id', 'format', 'bytes', 'raw_sha256', 'normalized_sha256', 'preview_digest', 'total_rows', 'rows'])
  need(value.schema === 'metasheet.welding_resource_import_pending/1' && value.kind === 'resource-import')
  validateOwner(value.owner); sourceId(value.import_id); importFormat(value.format)
  for (const key of ['raw_sha256', 'normalized_sha256', 'preview_digest']) need(isHash(value[key]))
  need(Number.isSafeInteger(value.total_rows) && (value.total_rows as number) >= 1 && (value.total_rows as number) <= 100 && Array.isArray(value.rows) && value.rows.length === value.total_rows)
  const numbers = new Set<number>(), keys = new Set<string>()
  for (const row of value.rows) {
    identity(row); need(row.row <= (value.total_rows as number) + 1 && !numbers.has(row.row) && !keys.has(row.row_key)); numbers.add(row.row); keys.add(row.row_key)
  }
  const bytes = copyImportBytes(value.bytes), metadata = importMetadata(value as unknown as ResourceImportPending)
  need(new TextEncoder().encode(jsonBytes(metadata)).byteLength <= IMPORT_METADATA_BYTES, '整批原请求元数据超过 512 KiB')
  return { ...metadata, bytes }
}
export async function verifyImportPending(value: unknown): Promise<ResourceImportPending> {
  const pending = validateImportPending(value)
  need(await hashImportBytes(pending.bytes) === pending.raw_sha256, '整批原文件与摘要不符，记录保留')
  return pending
}
export function equalImportPending(a: ResourceImportPending | null, b: ResourceImportPending): boolean {
  if (!a || !equal(importMetadata(a), importMetadata(b)) || a.bytes.byteLength !== b.bytes.byteLength) return false
  const left = new Uint8Array(a.bytes), right = new Uint8Array(b.bytes)
  return left.every((byte, index) => byte === right[index])
}
export function validateImportReceipt(value: unknown, pending: ResourceImportPending): ResourceImportReceipt {
  exact(value, ['schema', 'import_id', 'raw_sha256', 'normalized_sha256', 'preview_digest', 'total_rows', 'items'])
  need(value.schema === 'yuantus.welding_resource_import/1')
  for (const key of ['import_id', 'raw_sha256', 'normalized_sha256', 'preview_digest', 'total_rows'] as const) need(value[key] === pending[key], '整批回执与原请求不符')
  need(Array.isArray(value.items) && value.items.length === pending.total_rows)
  const resources = new Set<string>(), versions = new Set<string>(), rows = new Set<number>()
  for (const [index, item] of value.items.entries()) {
    exact(item, ['row', 'row_key', 'resource_id', 'item_version_id', 'version_label', 'content_hash', 'name', 'number', 'kind', 'state'])
    const id = { row: item.row, row_key: item.row_key, name: item.name, number: item.number, kind: item.kind }; identity(id)
    need(!rows.has(id.row) && equal(pending.rows[index], id), '整批回执行身份或顺序不符'); rows.add(id.row)
    sourceId(item.resource_id); sourceId(item.item_version_id); text(item.version_label)
    need(item.version_label.length > 0 && Array.from(item.version_label).length <= 128 && isHash(item.content_hash) && item.state === 'Draft'
      && !resources.has(item.resource_id) && !versions.has(item.item_version_id))
    resources.add(item.resource_id); versions.add(item.item_version_id)
  }
  return clone(value) as unknown as ResourceImportReceipt
}
