import type { VisualPreviewDescriptor } from './visual-preview-token'

export type VisualMarkupType = 'pin' | 'rectangle' | 'arrow' | 'callout'
export interface VisualMarkupInput {
  schema_version: 1
  markup_type: VisualMarkupType
  geometry: Record<string, number>
  viewport: { width: number; height: number; rotation: 0 }
  file_id: string
}
export interface VisualMarkupAnchor {
  kind: 'cad_2d_markup'
  file_id: string
  file_version: string
  content_checksum: string
  preview_checksum: string
  page: 0
}
export interface VisualMarkupReadBase {
  id: string
  markup_type: string
  geometry: Record<string, unknown> | unknown[]
  viewport: Record<string, unknown> | null
  file_id: string | null
  created_by_id: number
  created_at: string
}
export type VisualMarkupRead =
  | (VisualMarkupReadBase & Omit<VisualPreviewDescriptor, 'version_is_current'> & { binding_state: 'bound' })
  | (VisualMarkupReadBase & {
      binding_state: 'legacy_unbound'
      schema_version: null; part_id: null; file_version: null; content_checksum: null
      preview_checksum: null; page: null; preview_width: null; preview_height: null
    })

const SHA256 = /^[a-f0-9]{64}$/
const BINDING_FIELDS = ['schema_version', 'part_id', 'file_version', 'content_checksum',
  'preview_checksum', 'page', 'preview_width', 'preview_height'] as const
const BASE_FIELDS = ['id', 'markup_type', 'geometry', 'viewport', 'file_id', 'created_by_id', 'created_at']

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value
}
function checksum(value: unknown): value is string { return typeof value === 'string' && SHA256.test(value) }
function dimensions(width: unknown, height: unknown): boolean {
  return typeof width === 'number' && typeof height === 'number'
    && Number.isSafeInteger(width) && Number.isSafeInteger(height)
    && width > 0 && height > 0 && width <= 16_000_000 && height <= 16_000_000 && width * height <= 16_000_000
}
function safeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}
function positiveIntegerArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => safeCount(item))
}
function nonemptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function validVisualMarkupInput(value: unknown): value is VisualMarkupInput {
  if (!object(value)) return false
  if (!keys(value, ['schema_version', 'markup_type', 'geometry', 'viewport', 'file_id'])) return false
  if (value.schema_version !== 1 || !identifier(value.file_id)) return false
  if (!object(value.viewport)) return false
  if (!object(value.geometry)) return false
  if (!keys(value.viewport, ['width', 'height', 'rotation']) || value.viewport.rotation !== 0) return false
  if (!dimensions(value.viewport.width, value.viewport.height)) return false
  const geometryKeys = value.markup_type === 'pin' || value.markup_type === 'callout' ? ['x', 'y']
    : value.markup_type === 'rectangle' ? ['x', 'y', 'width', 'height']
      : value.markup_type === 'arrow' ? ['x1', 'y1', 'x2', 'y2'] : null
  if (!geometryKeys || !keys(value.geometry, geometryKeys)) return false
  if (!Object.values(value.geometry).every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)) return false
  if (value.markup_type !== 'rectangle') return true
  const g = value.geometry
  const x = g.x
  const y = g.y
  const width = g.width
  const height = g.height
  return typeof x === 'number' && typeof y === 'number' && typeof width === 'number' && typeof height === 'number'
    && width > 0 && height > 0 && x + width <= 1 && y + height <= 1
}

export function validVisualMarkupAnchor(value: unknown): value is VisualMarkupAnchor {
  return object(value) && keys(value, ['kind', 'file_id', 'file_version', 'content_checksum', 'preview_checksum', 'page'])
    && value.kind === 'cad_2d_markup' && identifier(value.file_id) && identifier(value.file_version)
    && checksum(value.content_checksum) && checksum(value.preview_checksum) && value.page === 0
}

export function hasVisualMarkupInput(body: Record<string, unknown>): boolean {
  return body.markup !== undefined || (object(body.anchor) && body.anchor.kind === 'cad_2d_markup')
}

function presentEnvelope(body: Record<string, unknown>, create: boolean): boolean {
  if (!nonemptyText(body.body)) return false
  if (create && (body.target_type !== 'item' || !identifier(body.target_id))) return false
  if (Object.prototype.hasOwnProperty.call(body, 'title') && typeof body.title !== 'string') return false
  if (Object.prototype.hasOwnProperty.call(body, 'mentioned_user_ids') && !positiveIntegerArray(body.mentioned_user_ids)) return false
  if (!create && Object.prototype.hasOwnProperty.call(body, 'parent_comment_id') && !identifier(body.parent_comment_id)) return false
  return true
}

export function validVisualMarkupBody(body: Record<string, unknown>, create: boolean): boolean {
  const allowed = create
    ? ['target_type', 'target_id', 'title', 'body', 'mentioned_user_ids', 'anchor', 'markup']
    : ['body', 'parent_comment_id', 'mentioned_user_ids', 'anchor', 'markup']
  if (!Object.keys(body).every((key) => allowed.includes(key))) return false
  if (!presentEnvelope(body, create)) return false
  if (!validVisualMarkupAnchor(body.anchor)) return false
  if (!validVisualMarkupInput(body.markup)) return false
  return body.anchor.file_id === body.markup.file_id
}

export function validVisualMarkupRead(value: unknown, partId: string): value is VisualMarkupRead {
  if (!object(value)) return false
  if (!keys(value, [...BASE_FIELDS, ...BINDING_FIELDS, 'binding_state']) || !identifier(value.id)) return false
  const createdAt = value.created_at
  const createdBy = value.created_by_id
  if (typeof createdAt !== 'string' || createdAt.length > 128 || !safeCount(createdBy)) return false
  if (value.binding_state === 'legacy_unbound') {
    return BINDING_FIELDS.every((key) => value[key] === null)
      && typeof value.markup_type === 'string'
      && (object(value.geometry) || Array.isArray(value.geometry))
      && (value.viewport === null || object(value.viewport))
      && (value.file_id === null || identifier(value.file_id))
  }
  if (value.binding_state !== 'bound' || value.part_id !== partId || !identifier(value.part_id)
    || !identifier(value.file_version) || !checksum(value.content_checksum) || !checksum(value.preview_checksum)
    || value.page !== 0 || !dimensions(value.preview_width, value.preview_height)) return false
  const markup = { schema_version: value.schema_version, markup_type: value.markup_type,
    geometry: value.geometry, viewport: value.viewport, file_id: value.file_id }
  return validVisualMarkupInput(markup) && markup.viewport.width === value.preview_width && markup.viewport.height === value.preview_height
}

function hideMarkup(comment: Record<string, unknown>): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(comment, 'markup')) return comment
  const textOnly = Object.fromEntries(Object.keys(comment).filter((key) => key !== 'markup')
    .map((key) => [key, comment[key]]))
  return { ...textOnly, markup: null }
}

function projectComment(comment: unknown, enabled: boolean, partId: string): unknown {
  if (!object(comment)) return comment
  const redact = !enabled || comment.deleted_at != null || typeof comment.body !== 'string'
  if (redact) return hideMarkup(comment)
  if (comment.markup === undefined) return comment
  return { ...comment, markup: validVisualMarkupRead(comment.markup, partId) ? comment.markup : null }
}

export function projectVisualMarkups<T>(detail: T, enabled: boolean, partId: string): T {
  // Gate before accessing markup. The text discussion remains usable while visual is off.
  if (!object(detail) || !Array.isArray(detail.comments)) return detail
  return {
    ...detail,
    comments: detail.comments.map((comment) => projectComment(comment, enabled, partId)),
  } as T
}
