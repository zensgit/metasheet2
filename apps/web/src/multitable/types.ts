// ---------------------------------------------------------------------------
// Multitable TypeScript types — derived from OpenAPI schemas in base.yml
// ---------------------------------------------------------------------------

// --- Field types ---
export type MetaFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'formula'
  | 'select'
  | 'link'
  | 'lookup'
  | 'rollup'
  | 'attachment'

export type MetaFieldCreateType = MetaFieldType | 'person'

export type RowDensity = 'compact' | 'normal' | 'expanded'

// --- Core entities ---
export interface MetaBase {
  id: string
  name: string
  icon?: string | null
  color?: string | null
  ownerId?: string | null
  workspaceId?: string | null
}

export interface MetaSheet {
  id: string
  baseId?: string | null
  name: string
  description?: string | null
}

export interface MetaField {
  id: string
  name: string
  type: MetaFieldType
  property?: Record<string, unknown>
  order?: number
  required?: boolean
  // Convenience — populated by backend for select fields
  options?: Array<{ value: string; color?: string }>
}

export interface MetaView {
  id: string
  sheetId: string
  name: string
  type: string
  filterInfo?: Record<string, unknown>
  sortInfo?: Record<string, unknown>
  groupInfo?: Record<string, unknown>
  hiddenFieldIds?: string[]
}

export interface MetaRecord {
  id: string
  version: number
  data: Record<string, unknown>
}

// --- Pagination ---
export interface MetaPage {
  offset: number
  limit: number
  total: number
  hasMore: boolean
}

// --- View data (GET /api/multitable/view) ---
export interface MetaViewData {
  id: string
  fields: MetaField[]
  rows: MetaRecord[]
  linkSummaries?: Record<string, Record<string, LinkedRecordSummary[]>>
  attachmentSummaries?: Record<string, Record<string, MetaAttachment[]>>
  view?: MetaView | null
  meta?: MetaViewMeta
  page?: MetaPage
}

export interface MetaViewMeta {
  warnings?: string[]
  computedFilterSort?: boolean
  ignoredSortFieldIds?: string[]
  ignoredFilterFieldIds?: string[]
}

// --- Context (GET /api/multitable/context) ---
export interface MetaContext {
  base?: MetaBase | null
  sheet?: MetaSheet | null
  sheets: MetaSheet[]
  views: MetaView[]
  capabilities: MetaCapabilities
}

// --- Record context (GET /api/multitable/records/:recordId) ---
export interface MetaRecordContext {
  sheet: MetaSheet
  view?: MetaView | null
  fields: MetaField[]
  record: MetaRecord
  capabilities: MetaCapabilities
  commentsScope: MetaCommentsScope
  linkSummaries?: Record<string, LinkedRecordSummary[]>
  attachmentSummaries?: Record<string, MetaAttachment[]>
}

// --- Form context (GET /api/multitable/form-context) ---
export interface MetaFormContext {
  mode: 'form'
  readOnly: boolean
  submitPath: string
  sheet: MetaSheet
  view?: MetaView | null
  fields: MetaField[]
  capabilities: MetaCapabilities
  record?: MetaRecord | null
  commentsScope?: MetaCommentsScope | null
  attachmentSummaries?: Record<string, MetaAttachment[]>
}

// --- Capabilities ---
export interface MetaCapabilities {
  canRead: boolean
  canCreateRecord: boolean
  canEditRecord: boolean
  canDeleteRecord: boolean
  canManageFields: boolean
  canManageViews: boolean
  canComment: boolean
  canManageAutomation: boolean
}

// --- Comments ---
export interface MetaCommentsScope {
  targetType: string
  targetId: string
  targetFieldId?: string | null
  containerType: string
  containerId: string
}

export interface MultitableComment {
  id: string
  containerId: string
  targetId: string
  targetFieldId?: string | null
  authorId: string
  authorName?: string
  content: string
  resolved: boolean
  createdAt: string
  updatedAt?: string
}

// --- Link records ---
export interface LinkedRecordSummary {
  id: string
  display: string
}

export interface LinkFieldRef {
  id: string
  name: string
  type: string
}

export interface LinkOptionsData {
  field: LinkFieldRef
  targetSheet: MetaSheet
  selected: LinkedRecordSummary[]
  records: LinkedRecordSummary[]
  page: MetaPage
}

// --- Patch ---
export interface CellChange {
  recordId: string
  fieldId: string
  value?: unknown
  expectedVersion?: number
}

export interface RecordVersion {
  recordId: string
  version: number
}

export interface PatchResult {
  updated: RecordVersion[]
  records?: Array<{ recordId: string; data: Record<string, unknown> }>
  linkSummaries?: Record<string, Record<string, LinkedRecordSummary[]>>
  attachmentSummaries?: Record<string, Record<string, MetaAttachment[]>>
  relatedRecords?: Array<{ sheetId: string; recordId: string; data: Record<string, unknown> }>
}

// --- Form submit ---
export interface FormSubmitResult {
  mode: 'create' | 'update'
  record: MetaRecord
  commentsScope: MetaCommentsScope
  attachmentSummaries?: Record<string, MetaAttachment[]>
}

// --- Record summary ---
export interface RecordSummaryPage {
  records: LinkedRecordSummary[]
  displayMap: Record<string, string>
  page: MetaPage
}

// --- Input types ---
export interface CreateBaseInput {
  id?: string
  name: string
  icon?: string
  color?: string
  ownerId?: string
  workspaceId?: string
}

export interface CreateSheetInput {
  id?: string
  baseId?: string
  name: string
  description?: string
  seed?: boolean
}

export interface CreateFieldInput {
  id?: string
  sheetId: string
  name: string
  type?: string
  property?: Record<string, unknown>
  order?: number
}

export interface MetaPreparedPersonField {
  targetSheet: MetaSheet
  fieldProperty: Record<string, unknown>
}

export interface UpdateFieldInput {
  name?: string
  type?: string
  property?: Record<string, unknown>
  order?: number
}

export interface CreateViewInput {
  id?: string
  sheetId: string
  name: string
  type?: string
  filterInfo?: Record<string, unknown>
  sortInfo?: Record<string, unknown>
  groupInfo?: Record<string, unknown>
  hiddenFieldIds?: string[]
}

export interface UpdateViewInput {
  name?: string
  type?: string
  filterInfo?: Record<string, unknown>
  sortInfo?: Record<string, unknown>
  groupInfo?: Record<string, unknown>
  hiddenFieldIds?: string[]
}

export interface CreateRecordInput {
  viewId?: string
  sheetId?: string
  data?: Record<string, unknown>
}

export interface PatchRecordsInput {
  viewId?: string
  sheetId?: string
  changes: CellChange[]
}

export interface FormSubmitInput {
  recordId?: string
  expectedVersion?: number
  data: Record<string, unknown>
}

// --- Attachments ---
export interface MetaAttachment {
  id: string
  filename: string
  mimeType: string
  size: number
  url: string
  thumbnailUrl?: string | null
  uploadedAt?: string | null
}

export interface MetaAttachmentUploadContext {
  sheetId?: string
  recordId?: string
  fieldId?: string
}

export type MetaAttachmentUploadFn = (
  file: File,
  context?: MetaAttachmentUploadContext,
) => Promise<MetaAttachment>

// --- Timeline config ---
export interface TimelineConfig {
  startFieldId: string
  endFieldId: string
  zoom: 'day' | 'week' | 'month'
}
