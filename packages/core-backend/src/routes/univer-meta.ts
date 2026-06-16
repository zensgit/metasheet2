import type { Request, Response } from 'express'
import { randomUUID } from 'crypto'
import * as path from 'path'
import { Router } from 'express'
import { z } from 'zod'
import { poolManager } from '../integration/db/connection-pool'
import { db as kyselyDb } from '../db/db'
import { eventBus } from '../integration/events/event-bus'
import {
  deriveFieldPermissions,
  deriveRecordPermissions,
  deriveViewPermissions,
  type FieldPermissionScope,
  type RecordPermissionScope,
  isFieldAlwaysReadOnly,
  isFieldPermissionHidden,
} from '../multitable/permission-derivation'
import { validateAiShortcutFieldProperty } from '../multitable/ai-shortcut-config'
import { withFieldVisibilityRule } from '../multitable/field-visibility-rule'
import { withFormLayout, projectPublicFormLayout, sanitizeFormRedirectUrl } from '../multitable/form-layout'
import { rbacGuard, rbacGuardAny } from '../rbac/rbac'
import {
  deriveCapabilities,
  normalizePermissionCodes,
  resolveRequestAccess,
  type MultitableCapabilities,
  type ResolvedRequestAccess,
} from '../multitable/access'
import {
  CANONICAL_SHEET_PERMISSION_CODE_BY_ACCESS_LEVEL,
  MANAGED_SHEET_PERMISSION_CODES,
  PUBLIC_FORM_CAPABILITIES,
  applyContextSheetSchemaWriteGrant,
  applySheetPermissionScope,
  buildRowActionOverrides,
  canReadWithSheetGrant,
  deriveCapabilityOrigin,
  deriveDefaultRowActions,
  deriveRecordRowActions,
  deriveSheetAccessLevel,
  enrichFormShareCandidatesWithDingTalkStatus,
  ensureRecordWriteAllowed,
  filterReadableSheetRowsForAccess,
  hasRecordPermissionAssignments,
  isSheetPermissionSubjectType,
  listSheetPermissionCandidates,
  listSheetPermissionEntries,
  loadFieldPermissionScopeMap,
  loadRecordCreatorMap,
  loadRecordPermissionScopeMap,
  loadSheetMemberUserIdSet,
  loadSheetPermissionScopeMap,
  loadViewPermissionScopeMap,
  requiresOwnWriteRowPolicy,
  resolveBaseReadable,
  resolveReadableSheetIds,
  resolveSheetCapabilities,
  resolveSheetReadableCapabilities,
  type MultitableCapabilityOrigin,
  type MultitableRowActions,
  type MultitableSheetAccessLevel,
  type MultitableSheetPermissionCandidate,
  type MultitableSheetPermissionEntry,
  type MultitableSheetPermissionSubjectType,
  type SheetPermissionScope,
} from '../multitable/permission-service'
import {
  loadFieldsForSheet as loadFieldsForSheetShared,
  loadSheetRow as loadSheetRowShared,
  tryResolveView as tryResolveViewShared,
  type MultitableViewConfig as SharedMultitableViewConfig,
} from '../multitable/loaders'
import { parseAggregations, aggregateField, groupRowsByField, type AggregationFn } from '../multitable/aggregation-helpers'
import { ensureLegacyBase as ensureLegacyBaseShared } from '../multitable/provisioning'
import {
  MultitableTemplateConflictError,
  MultitableTemplateNotFoundError,
  buildTemplateWouldCreate,
  detectTemplateConflicts,
  getMultitableTemplate,
  installMultitableTemplate,
  listMultitableTemplates,
} from '../multitable/template-library'
import { Logger } from '../core/logger'
import {
  queryRecordsWithCursor,
  type CursorPaginatedResult,
  type LoadedMultitableRecord,
} from '../multitable/records'
import {
  buildAttachmentSummaries as buildAttachmentSummariesShared,
  deleteAttachmentBinary as deleteAttachmentBinaryShared,
  ensureAttachmentIdsExist as ensureAttachmentIdsExistShared,
  normalizeAttachmentIds as normalizeAttachmentIdsShared,
  readAttachmentBinary as readAttachmentBinaryShared,
  readAttachmentForDelete as readAttachmentForDeleteShared,
  readAttachmentMetadata as readAttachmentMetadataShared,
  serializeAttachmentRow as serializeAttachmentRowShared,
  serializeAttachmentSummaryMap as serializeAttachmentSummaryMapShared,
  softDeleteAttachmentRow as softDeleteAttachmentRowShared,
  storeAttachment as storeAttachmentShared,
  type MultitableAttachment as SharedMultitableAttachment,
} from '../multitable/attachment-service'
import { StorageServiceImpl } from '../services/StorageService'
import { createUploadMiddleware, loadMulter } from '../types/multer'
import type { RequestWithFile } from '../types/multer'
import { MultitableFormulaEngine } from '../multitable/formula-engine'
import { FormulaEngine } from '../formula/engine'
import { validateRecord, getDefaultValidationRules } from '../multitable/field-validation-engine'
import type { FieldValidationConfig } from '../multitable/field-validation'
import { assertRichLongTextToggleAllowed, BATCH1_FIELD_TYPES, coerceBatch1Value, isPersonSingleRecord, isRichLongTextProperty, normalizeMultiSelectValue, richLongTextToPlainText, validateLongTextValue, validatePersonValue } from '../multitable/field-codecs'
import { conditionalPublicRateLimiter, publicFormContextLimiter, publicFormSubmitLimiter } from '../middleware/rate-limiter'
import {
  AutomationRuleValidationError,
  getAutomationServiceInstance,
  parseCreateRuleInput,
  parseDingTalkAutomationDeliveryLimit,
  parseUpdateRuleInput,
  preflightAutomationConditionFields,
  preflightDingTalkAutomationCreate,
  preflightDingTalkAutomationUpdate,
  serializeAutomationRule,
} from '../multitable/automation-service'
import { listAutomationDingTalkGroupDeliveries } from '../multitable/dingtalk-group-delivery-service'
import { listAutomationDingTalkPersonDeliveries } from '../multitable/dingtalk-person-delivery-service'
import {
  publishMultitableSheetRealtime as publishMultitableSheetRealtimeShared,
  type MultitableSheetRealtimePayload as SharedRealtimePayload,
} from '../multitable/realtime-publish'
import {
  RecordWriteService,
  VersionConflictError as ServiceVersionConflictError,
  RecordNotFoundError as ServiceNotFoundError,
  RecordValidationError as ServiceValidationError,
  RecordFieldForbiddenError as ServiceFieldForbiddenError,
  type RecordWriteHelpers,
  type RecordChange,
} from '../multitable/record-write-service'
import {
  RecordService,
  VersionConflictError as RecordServiceVersionConflictError,
  RecordNotFoundError as RecordServiceNotFoundError,
  RecordValidationError as RecordServiceValidationError,
  RecordFieldForbiddenError as RecordServiceFieldForbiddenError,
  RecordPermissionError as RecordServicePermissionError,
  RecordValidationFailedError as RecordCreateValidationFailedError,
  RecordPatchFieldValidationError as RecordServicePatchFieldValidationError,
} from '../multitable/record-service'
import { canUnlock, ensureRecordNotLocked, mapRecordLockState } from '../multitable/record-lock'
import {
  acquireAutoNumberSheetWriteLock,
  allocateAutoNumberValues,
  backfillAutoNumberField,
} from '../multitable/auto-number-service'
import { normalizeAutoNumberProperty } from '../multitable/auto-number-property'
import {
  createYjsInvalidationPostCommitHook,
  type YjsInvalidator,
} from '../multitable/post-commit-hooks'
import { listRecordRevisions, type RecordRevisionEntry } from '../multitable/record-history-service'
import {
  countUnreadRecordSubscriptionNotifications,
  getRecordSubscriptionStatus,
  listRecordSubscriptionNotifications,
  markAllRecordSubscriptionNotificationsRead,
  markRecordSubscriptionNotificationsRead,
  subscribeRecord,
  unsubscribeRecord,
} from '../multitable/record-subscription-service'
import {
  CONDITIONAL_FORMATTING_RULE_LIMIT,
  sanitizeConditionalFormattingRules,
} from '../multitable/conditional-formatting-service'
import {
  XLSX_MAX_BYTES,
  XLSX_MAX_ROWS,
  buildXlsxBuffer,
  buildXlsxImportRecords,
  normalizeXlsxColumnMapping,
  parseXlsxBuffer,
  serializeXlsxCell,
  type ParsedXlsxResult,
  type XlsxModule,
} from '../multitable/xlsx-service'

const multitableFormulaEngine = new MultitableFormulaEngine()

// Formula dry-run (#5a, design #1860): a no-DB engine is the hard backstop — combined with the
// wrapper's A1/range pre-eval gate, dry-run physically cannot reach the database. The stub's only
// method throws, so any (gate-escaped) cell/range ref surfaces as a runtime diagnostic, never a query.
const DRY_RUN_NO_DB = {
  selectFrom() { throw new Error('formula dry-run does not permit database access') },
} as unknown as NonNullable<ConstructorParameters<typeof FormulaEngine>[0]>['db']
const dryRunFormulaEngine = new MultitableFormulaEngine(new FormulaEngine({ db: DRY_RUN_NO_DB }))
// Structural caps for the user-supplied expression (no hard in-process timeout — design #1860 §3.3).
const DRY_RUN_MAX_EXPRESSION_LEN = 4000
const DRY_RUN_MAX_REFERENCED_FIELDS = 64
const DRY_RUN_MAX_PAREN_DEPTH = 32

// Observation-readiness logger for the multitable H-series. Emits the stable
// `[multitable.template.install]` event consumed by the H-series observation
// SOP (docs/operations/multitable-h-series-observation-sop-20260519.md), plus
// the symmetric `[multitable.template.dry-run]` event (S2 review 2026-06-11
// F5; distinct token, so the SOP's install grep stays single-counted).
// Structured fields only — never logs baseName / request body / token / email
// / template content / arbitrary user text.
const templateInstallLogger = new Logger('MultitableTemplates')

/**
 * Module-level Yjs invalidator set by `index.ts` when the Yjs collab
 * path is wired. Used by REST write handlers that must purge stale Yjs
 * state after committing `meta_records.data` outside the Yjs bridge.
 *
 * When `null`, no invalidation happens — safe for Yjs-off deployments.
 */
let yjsInvalidator: YjsInvalidator | null = null

export function setYjsInvalidatorForRoutes(invalidator: YjsInvalidator | null): void {
  yjsInvalidator = invalidator
}

/**
 * A2 (design §2.2): the AI shortcut run route (routes/multitable-ai.ts) must
 * wire the SAME post-commit Yjs invalidation hook as POST /patch. The
 * invalidator is module-private state set by index.ts via
 * `setYjsInvalidatorForRoutes`; this getter is the minimal read seam — no
 * behavior change for /patch.
 */
export function getYjsInvalidatorForRoutes(): YjsInvalidator | null {
  return yjsInvalidator
}

const MULTITABLE_FIELD_TYPES = [
  'string',
  'number',
  'boolean',
  'date',
  'dateTime',
  'formula',
  'select',
  'multiSelect',
  'link',
  'lookup',
  'rollup',
  'attachment',
  'currency',
  'percent',
  'rating',
  'url',
  'email',
  'phone',
  'barcode',
  'qrcode',
  'location',
  'longText',
  'autoNumber',
  'createdTime',
  'modifiedTime',
  'createdBy',
  'modifiedBy',
] as const

const MULTITABLE_FIELD_INPUT_TYPES = [
  ...MULTITABLE_FIELD_TYPES,
  'person',
] as const

type MultitableFieldInputType = (typeof MULTITABLE_FIELD_INPUT_TYPES)[number]

type UniverMetaField = {
  id: string
  name: string
  type:
    | 'string'
    | 'number'
    | 'boolean'
    | 'date'
    | 'dateTime'
    | 'formula'
    | 'select'
    | 'multiSelect'
    | 'link'
    | 'person'
    | 'lookup'
    | 'rollup'
    | 'attachment'
    | 'currency'
    | 'percent'
    | 'rating'
    | 'url'
    | 'email'
    | 'phone'
    | 'barcode'
    | 'qrcode'
    | 'location'
    | 'longText'
    | 'autoNumber'
    | 'createdTime'
    | 'modifiedTime'
    | 'createdBy'
    | 'modifiedBy'
    | 'button'
  options?: Array<{ value: string; color?: string }>
  order?: number
  property?: Record<string, unknown>
}

type UniverMetaRecord = {
  id: string
  version: number
  data: Record<string, unknown>
  createdBy?: string | null
  // Record-locking metadata (design #2278 follow-up). TOP-LEVEL on the wire — NOT a `data` field, so it
  // is never swept by the §2a.3 `filterRecordDataByFieldIds` / `maskStoredRecordFieldIds` masking.
  locked?: boolean
  lockedBy?: string | null
  lockedAt?: string | null
  // Server-authoritative per-row unlock gate (decision b) so the grid/drawer can show the unlock
  // action without exposing `created_by` to the client. Only meaningful when `locked` is true.
  canUnlock?: boolean
}

type UniverMetaView = {
  id: string
  fields: UniverMetaField[]
  rows: UniverMetaRecord[]
  linkSummaries?: Record<string, Record<string, LinkedRecordSummary[]>>
  personSummaries?: Record<string, Record<string, PersonSummary[]>>
  attachmentSummaries?: Record<string, Record<string, MultitableAttachment[]>>
  view?: UniverMetaViewConfig
  meta?: {
    warnings?: string[]
    computedFilterSort?: boolean
    ignoredSortFieldIds?: string[]
    ignoredFilterFieldIds?: string[]
    capabilityOrigin?: MultitableCapabilityOrigin
    permissions?: MultitableScopedPermissions
  }
  page?: {
    offset: number
    limit: number
    total: number
    hasMore: boolean
  }
}

type UniverMetaViewConfig = {
  id: string
  sheetId: string
  name: string
  type: string
  filterInfo?: Record<string, unknown>
  sortInfo?: Record<string, unknown>
  groupInfo?: Record<string, unknown>
  hiddenFieldIds?: string[]
  config?: Record<string, unknown>
}

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>

const DEFAULT_BASE_ID = 'base_legacy'
const DEFAULT_BASE_NAME = 'Migrated Base'
const SYSTEM_PEOPLE_SHEET_NAME = 'People'
const SYSTEM_PEOPLE_SHEET_DESCRIPTION = '__metasheet_system:people__'
const ATTACHMENT_PATH = process.env.ATTACHMENT_PATH || path.join(process.cwd(), 'data', 'attachments')
const ATTACHMENT_UPLOAD_MAX_SIZE = Number.parseInt(process.env.ATTACHMENT_MAX_SIZE ?? '', 10) || 100 * 1024 * 1024
const multitableMulter = loadMulter()
const multitableUpload = createUploadMiddleware(multitableMulter, { fileSize: ATTACHMENT_UPLOAD_MAX_SIZE })
const xlsxUpload = createUploadMiddleware(multitableMulter, { fileSize: XLSX_MAX_BYTES })

let multitableAttachmentStorage: StorageServiceImpl | null = null
const metaSheetSummaryCache = new Map<string, { id: string; name: string }>()
const metaFieldCache = new Map<string, UniverMetaField[]>()
const metaViewConfigCache = new Map<string, UniverMetaViewConfig>()

type UniverMetaBase = {
  id: string
  name: string
  icon: string | null
  color: string | null
  ownerId: string | null
  workspaceId: string | null
}

type MultitableFieldPermission = {
  visible: boolean
  readOnly: boolean
}

type MultitableViewPermission = {
  canAccess: boolean
  canConfigure: boolean
  canDelete: boolean
}

type MultitableScopedPermissions = {
  fieldPermissions?: Record<string, MultitableFieldPermission>
  viewPermissions?: Record<string, MultitableViewPermission>
  rowActions?: MultitableRowActions
  rowActionOverrides?: Record<string, MultitableRowActions>
}

type LinkedRecordSummary = {
  id: string
  display: string
}

// Native person (人员, design 2026-06-16) display source. Parallel to LinkedRecordSummary
// but keyed by `userId` (NOT a recordId) and resolved from the `users` table at view-assembly
// time — the native person value carries no linkSummaries, so the renderer reads this instead.
type PersonSummary = {
  id: string
  display: string
}

type MultitableAttachment = SharedMultitableAttachment

type MultitableSheetRealtimePayload = {
  spreadsheetId: string
  actorId?: string | null
  source: 'multitable'
  kind: 'record-created' | 'record-updated' | 'record-deleted' | 'attachment-updated'
  recordId?: string
  recordIds?: string[]
  fieldIds?: string[]
  recordPatches?: Array<{
    recordId: string
    version?: number
    patch: Record<string, unknown>
  }>
}

type RecordSummaryPage = {
  records: LinkedRecordSummary[]
  displayMap: Record<string, string>
  page: {
    offset: number
    limit: number
    total: number
    hasMore: boolean
  }
  displayFieldId: string | null
}

type PeopleSheetPreset = {
  sheet: {
    id: string
    baseId: string | null
    name: string
    description: string | null
  }
  fieldProperty: Record<string, unknown>
}

type PublicFormAccessMode = 'public' | 'dingtalk' | 'dingtalk_granted'

type PublicFormConfig = {
  enabled?: boolean
  publicToken?: string
  expiresAt?: unknown
  expiresOn?: unknown
  accessMode?: unknown
  allowedUserIds?: unknown
  allowedMemberGroupIds?: unknown
}

type PublicFormAllowedSubjectSummary = {
  subjectType: 'user' | 'member-group'
  subjectId: string
  label: string
  subtitle: string | null
  isActive: boolean
  dingtalkBound?: boolean | null
  dingtalkGrantEnabled?: boolean | null
  dingtalkPersonDeliveryAvailable?: boolean | null
}

type PublicFormShareConfigResponse = {
  enabled: boolean
  publicToken: string | null
  expiresAt: string | null
  status: 'active' | 'expired' | 'disabled'
  accessMode: PublicFormAccessMode
  allowedUserIds: string[]
  allowedUsers: PublicFormAllowedSubjectSummary[]
  allowedMemberGroupIds: string[]
  allowedMemberGroups: PublicFormAllowedSubjectSummary[]
}

type DashboardChartType = 'bar' | 'line' | 'pie'
type DashboardMetric = 'count' | 'sum' | 'avg'

type DashboardWidgetInput = {
  id?: string
  title: string
  chartType: DashboardChartType
  groupByFieldId: string
  metric: DashboardMetric
  valueFieldId?: string | null
  limit?: number
}

type DashboardDataPoint = {
  key: string
  label: string
  value: number
  recordCount: number
}

type DashboardWidgetResult = {
  id: string
  title: string
  chartType: DashboardChartType
  groupByFieldId: string
  groupByFieldName: string | null
  metric: DashboardMetric
  valueFieldId: string | null
  valueFieldName: string | null
  limit: number
  totalRecords: number
  totalValue: number
  points: DashboardDataPoint[]
}

function buildId(prefix: string): string {
  return `${prefix}_${randomUUID()}`
}

function getPublicFormConfig(view?: UniverMetaViewConfig | null): PublicFormConfig | null {
  const config = view?.config
  if (!isPlainObject(config)) return null
  const publicForm = config.publicForm
  if (!isPlainObject(publicForm)) return null
  return publicForm as PublicFormConfig
}

function parsePublicFormExpiryMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value instanceof Date) return value.getTime()
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed)
    return Number.isFinite(numeric) ? numeric : null
  }
  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

function normalizePublicFormAccessMode(value: unknown): PublicFormAccessMode {
  if (value === 'dingtalk') return 'dingtalk'
  if (value === 'dingtalk_granted') return 'dingtalk_granted'
  return 'public'
}

function normalizePublicFormAllowlistIds(value: unknown): string[] {
  return Array.from(new Set(normalizeJsonArray(value)))
}

function buildPublicFormToken(): string {
  return buildId('pub')
}

function isPublicFormAccessAllowed(view: UniverMetaViewConfig | null | undefined, publicToken: string): boolean {
  if (!view || !publicToken) return false
  const publicForm = getPublicFormConfig(view)
  if (!publicForm || publicForm.enabled !== true) return false
  const configuredToken = typeof publicForm.publicToken === 'string' ? publicForm.publicToken.trim() : ''
  if (!configuredToken || configuredToken !== publicToken) return false
  const expiryMs = parsePublicFormExpiryMs(publicForm.expiresAt ?? publicForm.expiresOn)
  if (expiryMs !== null && Date.now() >= expiryMs) return false
  return true
}

async function loadPublicFormAllowedSubjectSummaries(
  query: QueryFn,
  config: PublicFormConfig | null | undefined,
): Promise<{
  allowedUserIds: string[]
  allowedUsers: PublicFormAllowedSubjectSummary[]
  allowedMemberGroupIds: string[]
  allowedMemberGroups: PublicFormAllowedSubjectSummary[]
}> {
  const allowedUserIds = normalizePublicFormAllowlistIds(config?.allowedUserIds)
  const allowedMemberGroupIds = normalizePublicFormAllowlistIds(config?.allowedMemberGroupIds)

  const [userResult, groupResult] = await Promise.all([
    allowedUserIds.length > 0
      ? query(
        `SELECT id, name, email, is_active
         FROM users
         WHERE id = ANY($1::text[])`,
        [allowedUserIds],
      )
      : Promise.resolve({ rows: [], rowCount: 0 }),
    allowedMemberGroupIds.length > 0
      ? query(
        `SELECT g.id::text AS id, g.name, g.description, COUNT(m.user_id)::int AS member_count
         FROM platform_member_groups g
         LEFT JOIN platform_member_group_members m ON m.group_id = g.id
         WHERE g.id::text = ANY($1::text[])
         GROUP BY g.id, g.name, g.description`,
        [allowedMemberGroupIds],
      )
      : Promise.resolve({ rows: [], rowCount: 0 }),
  ])

  const usersById = new Map(
    (userResult.rows as Array<{ id: string; name?: string | null; email?: string | null; is_active?: boolean | null }>)
      .map((row) => [
        String(row.id),
        {
          subjectType: 'user' as const,
          subjectId: String(row.id),
          label: String(row.name ?? row.email ?? row.id),
          subtitle: typeof row.email === 'string' && row.email.trim().length > 0 ? row.email.trim() : null,
          isActive: row.is_active !== false,
        } satisfies PublicFormAllowedSubjectSummary,
      ]),
  )
  const groupsById = new Map(
    (groupResult.rows as Array<{ id: string; name?: string | null; description?: string | null; member_count?: number | null }>)
      .map((row) => [
        String(row.id),
        {
          subjectType: 'member-group' as const,
          subjectId: String(row.id),
          label: String(row.name ?? row.id),
          subtitle:
            typeof row.description === 'string' && row.description.trim().length > 0
              ? row.description.trim()
              : typeof row.member_count === 'number'
                ? `${row.member_count} member${row.member_count === 1 ? '' : 's'}`
                : 'Member group',
          isActive: true,
        } satisfies PublicFormAllowedSubjectSummary,
      ]),
  )

  const subjects: PublicFormAllowedSubjectSummary[] = [
    ...allowedUserIds.map((userId) => usersById.get(userId) ?? {
      subjectType: 'user' as const,
      subjectId: userId,
      label: userId,
      subtitle: null,
      isActive: false,
    } satisfies PublicFormAllowedSubjectSummary),
    ...allowedMemberGroupIds.map((groupId) => groupsById.get(groupId) ?? {
      subjectType: 'member-group' as const,
      subjectId: groupId,
      label: groupId,
      subtitle: 'Member group',
      isActive: true,
    } satisfies PublicFormAllowedSubjectSummary),
  ]
  const enrichedSubjects = await enrichFormShareCandidatesWithDingTalkStatus(
    query,
    subjects as MultitableSheetPermissionCandidate[],
  ) as PublicFormAllowedSubjectSummary[]

  return {
    allowedUserIds,
    allowedUsers: enrichedSubjects.filter((subject) => subject.subjectType === 'user'),
    allowedMemberGroupIds,
    allowedMemberGroups: enrichedSubjects.filter((subject) => subject.subjectType === 'member-group'),
  }
}

async function serializePublicFormShareConfig(
  query: QueryFn,
  view: UniverMetaViewConfig | null | undefined,
): Promise<PublicFormShareConfigResponse> {
  const publicForm = getPublicFormConfig(view)
  const enabled = publicForm?.enabled === true
  const publicToken = typeof publicForm?.publicToken === 'string' && publicForm.publicToken.trim().length > 0
    ? publicForm.publicToken.trim()
    : null
  const expiryMs = parsePublicFormExpiryMs(publicForm?.expiresAt ?? publicForm?.expiresOn)
  const expiresAt = expiryMs === null ? null : new Date(expiryMs).toISOString()
  const status = !enabled || !publicToken ? 'disabled' : expiryMs !== null && Date.now() >= expiryMs ? 'expired' : 'active'
  const allowlists = await loadPublicFormAllowedSubjectSummaries(query, publicForm)
  return {
    enabled,
    publicToken,
    expiresAt,
    status,
    accessMode: normalizePublicFormAccessMode(publicForm?.accessMode),
    allowedUserIds: allowlists.allowedUserIds,
    allowedUsers: allowlists.allowedUsers,
    allowedMemberGroupIds: allowlists.allowedMemberGroupIds,
    allowedMemberGroups: allowlists.allowedMemberGroups,
  }
}

async function loadDingTalkPublicFormAccessState(query: QueryFn, userId: string): Promise<{
  hasBinding: boolean
  grantEnabled: boolean
}> {
  const [identityResult, linkResult, grantResult] = await Promise.all([
    query(
      `SELECT 1
       FROM user_external_identities
       WHERE provider = $1 AND local_user_id = $2
       LIMIT 1`,
      ['dingtalk', userId],
    ),
    query(
      `SELECT 1
       FROM directory_account_links l
       JOIN directory_accounts a ON a.id = l.directory_account_id
       WHERE l.local_user_id = $1
         AND l.link_status = 'linked'
         AND a.provider = $2
       LIMIT 1`,
      [userId, 'dingtalk'],
    ),
    query(
      `SELECT enabled
       FROM user_external_auth_grants
       WHERE provider = $1 AND local_user_id = $2
       LIMIT 1`,
      ['dingtalk', userId],
    ),
  ])

  const hasBinding = identityResult.rows.length > 0 || linkResult.rows.length > 0
  const grantRow = grantResult.rows[0] as { enabled?: boolean } | undefined
  const grantEnabled = grantRow?.enabled === true

  return {
    hasBinding,
    grantEnabled,
  }
}

async function evaluateProtectedPublicFormAccess(
  query: QueryFn,
  req: Request,
  view: UniverMetaViewConfig | null | undefined,
): Promise<
  | { allowed: true; accessMode: PublicFormAccessMode }
  | { allowed: false; statusCode: number; code: string; message: string }
> {
  const accessMode = normalizePublicFormAccessMode(getPublicFormConfig(view)?.accessMode)
  if (accessMode === 'public') {
    return { allowed: true, accessMode }
  }

  const userId = req.user?.id?.toString() ?? req.user?.sub?.toString() ?? req.user?.userId?.toString() ?? ''
  if (!userId) {
    return {
      allowed: false,
      statusCode: 401,
      code: 'DINGTALK_AUTH_REQUIRED',
      message: 'DingTalk sign-in is required for this form',
    }
  }

  const dingtalkAccess = await loadDingTalkPublicFormAccessState(query, userId)
  if (!dingtalkAccess.hasBinding) {
    return {
      allowed: false,
      statusCode: 403,
      code: 'DINGTALK_BIND_REQUIRED',
      message: 'A bound DingTalk account is required for this form',
    }
  }

  if (accessMode === 'dingtalk_granted' && !dingtalkAccess.grantEnabled) {
    return {
      allowed: false,
      statusCode: 403,
      code: 'DINGTALK_GRANT_REQUIRED',
      message: 'A DingTalk-authorized account is required for this form',
    }
  }

  const publicForm = getPublicFormConfig(view)
  const allowedUserIds = normalizePublicFormAllowlistIds(publicForm?.allowedUserIds)
  const allowedMemberGroupIds = normalizePublicFormAllowlistIds(publicForm?.allowedMemberGroupIds)
  if (allowedUserIds.length > 0 || allowedMemberGroupIds.length > 0) {
    const directAllowed = allowedUserIds.includes(userId)
    let memberGroupAllowed = false
    if (!directAllowed && allowedMemberGroupIds.length > 0) {
      const membershipResult = await query(
        `SELECT 1
         FROM platform_member_group_members
         WHERE user_id = $1
           AND group_id::text = ANY($2::text[])
         LIMIT 1`,
        [userId, allowedMemberGroupIds],
      )
      memberGroupAllowed = membershipResult.rows.length > 0
    }
    if (!directAllowed && !memberGroupAllowed) {
      return {
        allowed: false,
        statusCode: 403,
        code: 'DINGTALK_FORM_NOT_ALLOWED',
        message: 'Only selected system users or member groups can access this form',
      }
    }
  }

  return { allowed: true, accessMode }
}

function appendQueryParam(path: string, key: string, value: string): string {
  const delimiter = path.includes('?') ? '&' : '?'
  return `${path}${delimiter}${encodeURIComponent(key)}=${encodeURIComponent(value)}`
}

function buildPublicFormSubmitPath(viewId: string, publicToken: string): string {
  return appendQueryParam(`/api/multitable/views/${viewId}/submit`, 'publicToken', publicToken)
}

type FormulaDependencyQueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>

async function syncFormulaDependencies(
  query: FormulaDependencyQueryFn,
  sheetId: string,
  fieldId: string,
  dependsOnFieldIds: string[],
): Promise<void> {
  // Remove old dependencies for this field
  await query(
    'DELETE FROM formula_dependencies WHERE sheet_id = $1 AND field_id = $2',
    [sheetId, fieldId],
  )
  // Insert new dependencies
  for (const depFieldId of dependsOnFieldIds) {
    await query(
      `INSERT INTO formula_dependencies (sheet_id, field_id, depends_on_field_id, depends_on_sheet_id)
       VALUES ($1, $2, $3, NULL)
       ON CONFLICT ON CONSTRAINT uq_formula_dep DO NOTHING`,
      [sheetId, fieldId, depFieldId],
    )
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeJson(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (isPlainObject(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      if (isPlainObject(parsed)) return parsed
    } catch {
      return {}
    }
  }
  return {}
}

function normalizeJsonArray(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) {
    return value
      .map((v) => {
        if (typeof v === 'string') return v.trim()
        if (typeof v === 'number' && Number.isFinite(v)) return String(v)
        return ''
      })
      .filter((v) => v.length > 0)
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return normalizeJsonArray(parsed)
    } catch {
      return []
    }
  }
  return []
}

function isSystemPeopleSheetDescription(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === SYSTEM_PEOPLE_SHEET_DESCRIPTION
}

function filterVisibleSheetRows<T extends { description?: unknown }>(rows: T[]): T[] {
  return rows.filter((row) => !isSystemPeopleSheetDescription(row.description))
}

type LinkFieldConfig = {
  foreignSheetId: string
  limitSingleRecord: boolean
  // ②b slice 1 — explicit cross-base opt-in claim. Present only when the link declares a foreign base;
  // a same-base link omits it (back-compat). The §2a.2 wall allows the cross-base link IFF this equals
  // the foreign sheet's actual base_id (claim == truth). Extracted explicitly (not via incidental
  // spread) so it round-trips the real wire — see the wire-vs-fixture rule.
  foreignBaseId?: string
  // Bidirectional / mirror links MVP (design 2026-06-14). The reverse is a DERIVED read-projection of
  // the SINGLE forward `meta_links` edge (no materialized mirror row, no migration, no write-back).
  //   - `twoWay`: this link participates in a paired (two-way) relationship.
  //   - `mirrorFieldId`: id of the paired field on the foreign sheet (symmetric: each side names the other).
  //   - `mirrorOf`: read-only marker present ONLY on the DERIVED (mirror) side; its value = the paired
  //     FORWARD field's id. When set, this field RESOLVES the reverse projection
  //     (`WHERE field_id=mirrorOf AND foreign_record_id=<this record>`, served by idx_meta_links_foreign)
  //     and is forced read-only (the codec promotes `readOnly:true`) so the single-edge invariant holds.
  // All three are promoted explicitly in the codec (wire-vs-fixture), same as `foreignBaseId`.
  twoWay?: boolean
  mirrorFieldId?: string
  mirrorOf?: string
}

type LookupFieldConfig = {
  linkFieldId: string
  targetFieldId: string
  foreignSheetId?: string
  // §2a.3: deliberate same-base projection opt-out. Honored ONLY for same-base lookups; a
  // cross-base lookup of an unreadable foreign field is ALWAYS masked (flag ignored).
  skipForeignFieldMasking?: boolean
}

type RollupAggregation = 'count' | 'sum' | 'avg' | 'min' | 'max'

type RollupFieldConfig = {
  linkFieldId: string
  targetFieldId: string
  aggregation: RollupAggregation
  foreignSheetId?: string
  // §2a.3: see LookupFieldConfig.skipForeignFieldMasking — same semantics for rollup configs.
  skipForeignFieldMasking?: boolean
}

function parseLinkFieldConfig(property: unknown): LinkFieldConfig | null {
  const obj = normalizeJson(property)
  const foreign = obj.foreignDatasheetId ?? obj.foreignSheetId ?? obj.datasheetId
  if (typeof foreign !== 'string' || foreign.trim().length === 0) return null

  // ②b slice 1 — the explicit cross-base opt-in claim (trim; empty → omitted).
  const claimedBase = typeof obj.foreignBaseId === 'string' && obj.foreignBaseId.trim().length > 0
    ? obj.foreignBaseId.trim()
    : undefined
  // Bidirectional / mirror links (design 2026-06-14). Parsed explicitly (trim; empty → omitted) so the
  // pairing config round-trips the wire. `mirrorOf` (the derived-side marker) is the discriminator used
  // by the reverse read; `twoWay`/`mirrorFieldId` drive the forward-side invalidation fan-out.
  const mirrorFieldId = typeof obj.mirrorFieldId === 'string' && obj.mirrorFieldId.trim().length > 0
    ? obj.mirrorFieldId.trim()
    : undefined
  const mirrorOf = typeof obj.mirrorOf === 'string' && obj.mirrorOf.trim().length > 0
    ? obj.mirrorOf.trim()
    : undefined
  return {
    foreignSheetId: foreign.trim(),
    limitSingleRecord: obj.limitSingleRecord === true,
    ...(claimedBase ? { foreignBaseId: claimedBase } : {}),
    ...(obj.twoWay === true ? { twoWay: true } : {}),
    ...(mirrorFieldId ? { mirrorFieldId } : {}),
    ...(mirrorOf ? { mirrorOf } : {}),
  }
}

/**
 * ②a §2a.2 compat gate — does the RAW request payload explicitly carry a link foreign-sheet key?
 * Mirrors the aiShortcut / expression payload-presence gates: the cross-base wall fires only when the
 * caller is actually (re)writing the link target, so a rename-only PATCH on a pre-existing (possibly
 * legacy cross-base) link is not retroactively rejected (GA-T4b). Covers ALL `parseLinkFieldConfig`
 * foreign aliases so a cross-base link sent under `datasheetId` cannot bypass the wall.
 */
const LINK_FOREIGN_KEYS = ['foreignSheetId', 'foreignDatasheetId', 'datasheetId'] as const
function linkForeignKeyInPayload(payloadProperty: unknown): boolean {
  if (typeof payloadProperty === 'undefined' || payloadProperty === null) return false
  return LINK_FOREIGN_KEYS.some((key) => Object.prototype.hasOwnProperty.call(payloadProperty, key))
}

/**
 * ②b §2.5(b) / decision (c) — does the RAW PATCH payload explicitly carry a `foreignBaseId` key?
 * Mirrors `linkForeignKeyInPayload`: immutability is enforced only when the caller is actually
 * (re)writing the claim, so a rename-only / unrelated PATCH (no `foreignBaseId` key) leaves the stored
 * claim untouched (and the explicit codec keeps it from being dropped).
 */
function foreignBaseIdInPayload(payloadProperty: unknown): boolean {
  if (typeof payloadProperty === 'undefined' || payloadProperty === null) return false
  return Object.prototype.hasOwnProperty.call(payloadProperty, 'foreignBaseId')
}

/** ②b — normalized cross-base opt-in claim (trim; empty/absent → null) from a (possibly stored) property. */
function extractForeignBaseId(property: unknown): string | null {
  const obj = normalizeJson(property)
  return typeof obj.foreignBaseId === 'string' && obj.foreignBaseId.trim().length > 0
    ? obj.foreignBaseId.trim()
    : null
}

function parseLookupFieldConfig(property: unknown): LookupFieldConfig | null {
  const obj = normalizeJson(property)
  const linkFieldId = obj.relatedLinkFieldId ?? obj.linkFieldId ?? obj.linkedFieldId ?? obj.sourceFieldId
  const targetFieldId = obj.lookUpTargetFieldId ?? obj.lookupTargetFieldId ?? obj.targetFieldId ?? obj.lookupFieldId
  if (typeof linkFieldId !== 'string' || linkFieldId.trim().length === 0) return null
  if (typeof targetFieldId !== 'string' || targetFieldId.trim().length === 0) return null

  const foreign = obj.datasheetId ?? obj.foreignDatasheetId ?? obj.foreignSheetId
  const foreignSheetId = typeof foreign === 'string' && foreign.trim().length > 0 ? foreign.trim() : undefined

  return {
    linkFieldId: linkFieldId.trim(),
    targetFieldId: targetFieldId.trim(),
    ...(foreignSheetId ? { foreignSheetId } : {}),
    ...(obj.skipForeignFieldMasking === true ? { skipForeignFieldMasking: true } : {}),
  }
}

function parseRollupAggregation(value: unknown): RollupAggregation | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (normalized === 'counta') return 'count'
  if (normalized === 'count' || normalized === 'sum' || normalized === 'avg' || normalized === 'min' || normalized === 'max') {
    return normalized as RollupAggregation
  }
  return null
}

function parseRollupFieldConfig(property: unknown): RollupFieldConfig | null {
  const obj = normalizeJson(property)
  const linkFieldId = obj.linkedFieldId ?? obj.linkFieldId ?? obj.relatedLinkFieldId ?? obj.sourceFieldId
  const targetFieldId = obj.targetFieldId ?? obj.lookUpTargetFieldId ?? obj.lookupTargetFieldId ?? obj.lookupFieldId
  if (typeof linkFieldId !== 'string' || linkFieldId.trim().length === 0) return null
  if (typeof targetFieldId !== 'string' || targetFieldId.trim().length === 0) return null

  const aggregation = parseRollupAggregation(obj.aggregation ?? obj.agg ?? obj.function ?? obj.rollupFunction)
  if (!aggregation) return null

  const foreign = obj.datasheetId ?? obj.foreignDatasheetId ?? obj.foreignSheetId
  const foreignSheetId = typeof foreign === 'string' && foreign.trim().length > 0 ? foreign.trim() : undefined

  return {
    linkFieldId: linkFieldId.trim(),
    targetFieldId: targetFieldId.trim(),
    aggregation,
    ...(foreignSheetId ? { foreignSheetId } : {}),
    ...(obj.skipForeignFieldMasking === true ? { skipForeignFieldMasking: true } : {}),
  }
}

async function validateLookupRollupConfig(
  req: Request,
  query: QueryFn,
  sheetId: string,
  type: UniverMetaField['type'],
  property: unknown,
): Promise<string | null> {
  if (type !== 'lookup' && type !== 'rollup') return null

  const config =
    type === 'lookup' ? parseLookupFieldConfig(property) : parseRollupFieldConfig(property)
  if (!config) {
    return type === 'lookup'
      ? 'Lookup 属性需要 relatedLinkFieldId 和 lookUpTargetFieldId'
      : 'Rollup 属性需要 linkedFieldId、targetFieldId 和 aggregation'
  }

  const linkFieldRes = await query(
    'SELECT id, type, property FROM meta_fields WHERE sheet_id = $1 AND id = $2',
    [sheetId, config.linkFieldId],
  )
  if ((linkFieldRes as any).rows.length === 0) {
    return `Link 字段不存在：${config.linkFieldId}`
  }
  const linkRow = (linkFieldRes as any).rows[0]
  const linkType = mapFieldType(String(linkRow.type ?? ''))
  if (linkType !== 'link') {
    return `字段 ${config.linkFieldId} 不是 Link 类型`
  }
  const linkCfg = parseLinkFieldConfig(linkRow.property)
  if (!linkCfg) {
    return `Link 字段缺少 foreignSheetId：${config.linkFieldId}`
  }

  if (config.foreignSheetId && config.foreignSheetId !== linkCfg.foreignSheetId) {
    return `外表不匹配：Link 字段指向 ${linkCfg.foreignSheetId}，配置为 ${config.foreignSheetId}`
  }

  const targetRes = await query(
    'SELECT id FROM meta_fields WHERE sheet_id = $1 AND id = $2',
    [linkCfg.foreignSheetId, config.targetFieldId],
  )
  if ((targetRes as any).rows.length === 0) {
    return `外表字段不存在：${config.targetFieldId}（sheetId=${linkCfg.foreignSheetId}）`
  }

  const { capabilities } = await resolveSheetCapabilities(req, query, linkCfg.foreignSheetId)
  if (!capabilities.canRead) {
    throw new PermissionError(`Insufficient permissions to read linked sheet: ${linkCfg.foreignSheetId}`)
  }

  return null
}

/**
 * ②a §2a.4 — the single source of truth for "are these two bases DIFFERENT bases". STRICT and
 * null-aware: a null/legacy base and a set base count as cross-base (`!==`); null-vs-null is same-base;
 * set-vs-same-set is same-base. Shared by the §2a.2 wall (`validateLinkFieldConfig`) and the §2a.4-c
 * sheet-create TOCTOU guard so they cannot drift; the §2a.4-b ops sweep replicates this in SQL via
 * `IS DISTINCT FROM`. Exported for the pure unit test that pins the rule.
 */
export function baseIdsAreCrossBase(a: string | null, b: string | null): boolean {
  return a !== b
}

function linkTargetMaterializationLockKey(sheetId: string): string {
  return `multitable:link-target:${sheetId}`
}

async function acquireLinkTargetMaterializationLock(query: QueryFn, sheetId: string): Promise<void> {
  await query('SELECT pg_advisory_xact_lock(hashtext($1))', [linkTargetMaterializationLockKey(sheetId)])
}

function getLinkTargetSheetIdForMaterializationLock(type: UniverMetaField['type'], property: unknown): string | null {
  if (type !== 'link') return null
  return parseLinkFieldConfig(property)?.foreignSheetId ?? null
}

/**
 * ②a §2a.2 — the cross-base WALL. A `link` field may not silently span two bases: the foreign sheet's
 * `base_id` must equal the source sheet's `base_id`. This closes the STRUCTURAL hole — today the
 * backend accepts ANY `foreignSheetId` regardless of base ("no cross-base" was only a UI convention).
 *
 * ZERO opt-out (first slice): there is no `foreignBaseId` flag yet — every silently-cross-base link is
 * rejected. The explicit cross-base opt-in is ②b, a separate later lane.
 *
 * Cross-base is detected by strict `===` on the two `base_id` values, so it INCLUDES null-vs-non-null
 * (a null/legacy base and a set base count as cross-base; null-vs-null is same-base and allowed). The
 * `req` argument is intentionally unused: this is a pure structural base comparison — the foreign-sheet
 * READ-permission masking is §2a.3's job (adding a perm check here would over-reach). Returns a Chinese-
 * with-id error string (matching `validateLookupRollupConfig`'s style) or null. The foreign value is
 * extracted via `parseLinkFieldConfig` so all aliases (foreignSheetId / foreignDatasheetId /
 * datasheetId) are covered.
 *
 * Caller compat: invoke ONLY when the payload explicitly carries a foreign-sheet key (see
 * `linkForeignKeyInPayload`) — a rename-only PATCH on a pre-existing (possibly legacy cross-base) link
 * must NOT be retroactively rejected (GA-T4b). When no foreign key is present this returns null anyway,
 * but the caller-side presence gate is the authoritative compat boundary.
 */
async function validateLinkFieldConfig(
  _req: Request,
  query: QueryFn,
  sourceSheetId: string,
  type: UniverMetaField['type'],
  property: unknown,
): Promise<string | null> {
  if (type !== 'link') return null

  const linkCfg = parseLinkFieldConfig(property)
  // No foreign sheet in the payload → nothing to validate (e.g. an incomplete draft). The authoritative
  // compat gate lives at the call sites; this internal guard is defensive.
  if (!linkCfg) return null

  const sourceSheet = await loadSheetRowShared(query, sourceSheetId)
  const foreignSheet = await loadSheetRowShared(query, linkCfg.foreignSheetId)
  // Foreign sheet not found (missing / soft-deleted): existence is out of this slice's scope — don't
  // null-deref and don't block here. The source sheet is reliably present at both write chokepoints.
  if (!foreignSheet) return null

  const sourceBaseId = sourceSheet?.baseId ?? null
  // ②b §2: disambiguated names. `actualForeignBaseId` = the foreign sheet's real base; `claimed` =
  // the opt-in declaration carried in the link property (null when absent).
  const actualForeignBaseId = foreignSheet.baseId ?? null
  const claimed = linkCfg.foreignBaseId ?? null
  if (claimed !== null && claimed !== actualForeignBaseId) {
    return `链接字段 foreignBaseId 需与外表实际 base 一致：源表 base=${sourceBaseId ?? 'null'}，外表 ${linkCfg.foreignSheetId} 实际 base=${actualForeignBaseId ?? 'null'}，声明=${claimed ?? 'null'}`
  }
  if (baseIdsAreCrossBase(sourceBaseId, actualForeignBaseId)) {
    // Bidirectional / mirror links MVP (design 2026-06-14 §7.2) — cross-base bidirectional is DEFERRED.
    // A two-way link must be same-base, even if it carries a valid cross-base `foreignBaseId` opt-in
    // (this fires BEFORE the ②b opt-in short-circuit so the opt-in cannot rescue a cross-base pairing).
    // Uses only this field's own config, so create-order / paired-field existence is irrelevant.
    if (linkCfg.twoWay === true) {
      return `二维（双向）链接 MVP 不支持跨 base 配对：源表 base=${sourceBaseId ?? 'null'}，外表 ${linkCfg.foreignSheetId} base=${actualForeignBaseId ?? 'null'}`
    }
    // ②b opt-in short-circuit — a cross-base link is allowed IFF it carries an EXPLICIT foreignBaseId
    // EQUAL to the foreign sheet's real base (claim == truth; you can't declare a wrong base). A
    // degenerate null/legacy-base foreign sheet has no concrete base to claim, so it can never opt in
    // (claimed===null falls through to reject; a non-null claim !== null actual also rejects). This is a
    // pure consistency gate — the foreign READ-permission check is §3 (base-read) + §2a.3 (field mask),
    // NOT here (adding a perm check in this structural wall would over-reach).
    if (claimed !== null) {
      return null
    }
    return `链接字段跨 base 需显式 foreignBaseId 且与外表实际 base 一致：源表 base=${sourceBaseId ?? 'null'}，外表 ${linkCfg.foreignSheetId} 实际 base=${actualForeignBaseId ?? 'null'}，声明=${claimed ?? 'null'}`
  }

  return null
}

/**
 * ②a §2a.4-c — sheet-create TOCTOU close. The §2a.2 wall (`validateLinkFieldConfig`) can only compare
 * bases when BOTH sheets exist; a link created against a not-yet-existent foreign sheet id slips through
 * (the wall no-ops). The hole is closed from the OTHER side: when a sheet is created with a caller-chosen
 * id + baseId, reject if some EXISTING link field's foreignSheetId equals this new sheet's id while that
 * field's source sheet is in a DIFFERENT base than the new sheet's baseId (a retroactively-cross-base
 * link). Symmetric to the wall, applied at sheet-create.
 *
 * The foreign target is matched across the parseLinkFieldConfig aliases in the SAME precedence
 * (`foreignDatasheetId` → `foreignSheetId` → `datasheetId`, trimmed) so an aliased link cannot bypass
 * the check; only `type = 'link'` fields are considered. Base comparison reuses `baseIdsAreCrossBase`
 * (null-aware). Returns a Chinese-with-id error string (matching the wall's style) or null. The new
 * sheet does not exist yet, so its base is supplied by the caller (`newSheetBaseId`).
 */
async function validateSheetCreateNoRetroactiveCrossBaseLink(
  query: QueryFn,
  newSheetId: string,
  newSheetBaseId: string | null,
): Promise<string | null> {
  // Existing link fields whose effective foreign target (alias-aware) is this new sheet id, joined to
  // their source sheet's base_id. NULLIF('') drops empty-string aliases so they don't match a real id.
  const res = await query(
    `SELECT mf.id AS field_id, s.base_id AS source_base_id,
            NULLIF(trim(mf.property ->> 'foreignBaseId'), '') AS claimed_foreign_base
       FROM meta_fields mf
       JOIN meta_sheets s ON s.id = mf.sheet_id
      WHERE mf.type = 'link'
        AND COALESCE(
              NULLIF(trim(mf.property ->> 'foreignDatasheetId'), ''),
              NULLIF(trim(mf.property ->> 'foreignSheetId'), ''),
              NULLIF(trim(mf.property ->> 'datasheetId'), '')
            ) = $1`,
    [newSheetId],
  )
  const rows = (res as { rows: Array<{ field_id: unknown; source_base_id: unknown; claimed_foreign_base: unknown }> }).rows
  for (const row of rows) {
    const sourceBaseId = typeof row.source_base_id === 'string' ? row.source_base_id : null
    const claimedForeignBase = typeof row.claimed_foreign_base === 'string' ? row.claimed_foreign_base : null
    // ②b §2.4 — an EXISTING link that already opted into the base this new sheet is being created in
    // (claim == new sheet's base) is a LEGITIMATE cross-base link; the TOCTOU guard must NOT retroactively
    // reject it. The wall (§2) will accept it at write-time because its claim equals the foreign sheet's
    // (now-materialized) real base. A non-opted-in (or wrong-claim) link still blocks.
    if (claimedForeignBase !== null && claimedForeignBase === newSheetBaseId) {
      continue
    }
    if (baseIdsAreCrossBase(sourceBaseId, newSheetBaseId)) {
      const fieldId = String(row.field_id)
      return `创建该 sheet 会使现有链接字段跨 base：字段 ${fieldId} 的源表 base=${sourceBaseId ?? 'null'}，新 sheet ${newSheetId} base=${newSheetBaseId ?? 'null'}`
    }
  }
  return null
}

/**
 * A2-defense (formula→formula guard). The product does NOT support a formula field
 * referencing another formula field: the frontend hard-blocks it (the token picker
 * `formulaSourceFields` excludes `type === 'formula'`, and the expression validator
 * flags a hand-typed formula ref as an error that disables save), and
 * `recalculateRecord` has no intra-record topological order — so a formula→formula
 * chain would silently compute against stale intermediate values. This closes the
 * raw-API path the frontend can't. lookup/rollup fields ARE permitted as formula
 * inputs (the frontend offers them — only `type !== 'formula'` is filtered), so only
 * `formula`-typed references and self-references are rejected. Unknown / missing
 * references stay tolerated (current behavior; a separate decision). Returns an
 * error message (matching `validateLookupRollupConfig`'s Chinese-with-field-id style)
 * or null when the expression is clean.
 */
async function validateFormulaReferences(
  query: QueryFn,
  sheetId: string,
  fieldId: string,
  expression: string,
): Promise<string | null> {
  const refs = multitableFormulaEngine.extractFieldReferences(expression)
  if (refs.length === 0) return null
  if (refs.includes(fieldId)) {
    return `公式字段不能引用自身：{${fieldId}}`
  }
  const res = await query(
    'SELECT id, type FROM meta_fields WHERE sheet_id = $1 AND id = ANY($2::text[])',
    [sheetId, refs],
  )
  const formulaRefs = (res.rows as Array<{ id: unknown; type: unknown }>)
    .filter((row) => mapFieldType(String(row.type ?? '')) === 'formula')
    .map((row) => String(row.id))
  if (formulaRefs.length > 0) {
    return `公式字段不能引用其它公式字段：${formulaRefs.map((id) => `{${id}}`).join('、')}`
  }
  return null
}

/**
 * A2-defense reverse guard. Lists the *live* formula fields whose expression
 * references `fieldId`, used to reject converting `fieldId` INTO a formula when a
 * formula already depends on it (a path the forward guard never sees: A is created
 * as a non-formula, formula B references A, then A is converted to formula). The
 * JOIN + `mapFieldType` re-check is load-bearing: `formula_dependencies` is NOT
 * cleaned up on field delete or on a formula→non-formula conversion, so it can hold
 * stale edges pointing at fields that are no longer formulas — those must NOT block.
 */
async function findFormulaReferrers(
  query: QueryFn,
  sheetId: string,
  fieldId: string,
): Promise<string[]> {
  const res = await query(
    `SELECT DISTINCT fd.field_id AS field_id, mf.type AS type
       FROM formula_dependencies fd
       JOIN meta_fields mf ON mf.id = fd.field_id AND mf.sheet_id = fd.sheet_id
      WHERE fd.sheet_id = $1 AND fd.depends_on_field_id = $2`,
    [sheetId, fieldId],
  )
  return (res.rows as Array<{ field_id: unknown; type: unknown }>)
    .filter((row) => mapFieldType(String(row.type ?? '')) === 'formula')
    .map((row) => String(row.field_id))
}

function normalizeLinkIds(value: unknown): string[] {
  if (value === null || value === undefined) return []

  const raw: string[] = []
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === 'string') raw.push(v)
      else if (typeof v === 'number' && Number.isFinite(v)) raw.push(String(v))
    }
  } else if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length === 0) return []
    const jsonParsed = normalizeJsonArray(trimmed)
    if (jsonParsed.length > 0) raw.push(...jsonParsed)
    else if (trimmed.includes(',')) raw.push(...trimmed.split(','))
    else raw.push(trimmed)
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    raw.push(String(value))
  }

  const seen = new Set<string>()
  return raw
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
    .filter((v) => {
      if (seen.has(v)) return false
      seen.add(v)
      return true
    })
}

const normalizeAttachmentIds = normalizeAttachmentIdsShared

function normalizeSearchTerm(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/**
 * Parse an optional `fieldIds` column-selection query param for export.
 * Accepts the comma-joined form (`?fieldIds=a,c`) and the repeated form
 * (`?fieldIds=a&fieldIds=c`); trims and drops empty tokens. Returns `undefined`
 * when nothing usable is supplied (= "no selection" → export all permitted columns,
 * preserving the pre-selection default behavior). A non-empty result is a SELECTION
 * hint only — the caller MUST intersect it with the already-permitted/masked field
 * set; it can only narrow, never widen.
 */
function parseFieldIdSelection(value: unknown): Set<string> | undefined {
  const raw: unknown[] = Array.isArray(value) ? value : value === undefined ? [] : [value]
  const ids = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    for (const token of entry.split(',')) {
      const id = token.trim()
      if (id) ids.add(id)
    }
  }
  return ids.size > 0 ? ids : undefined
}

function isSearchableFieldType(type: UniverMetaField['type']): boolean {
  return type === 'string' || type === 'longText' || type === 'number' || type === 'date' || type === 'select' || type === 'multiSelect' || type === 'formula'
}

function valueMatchesSearch(value: unknown, search: string): boolean {
  if (!search) return true
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.toLowerCase().includes(search)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).toLowerCase().includes(search)
  if (Array.isArray(value)) return value.some((item) => valueMatchesSearch(item, search))
  return false
}

function recordMatchesSearch(record: UniverMetaRecord, fields: UniverMetaField[], search: string): boolean {
  if (!search) return true
  return fields.some((field) => isSearchableFieldType(field.type) && valueMatchesSearch(record.data[field.id], search))
}

function escapeSqlLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

function buildRecordSearchPredicateSql(
  fieldIds: string[],
  searchParamIndex: number,
  firstFieldParamIndex: number,
  dataExpression = 'data',
): string {
  if (fieldIds.length === 0) return 'FALSE'
  return fieldIds
    .map((_, index) =>
      `LOWER(COALESCE(${dataExpression} ->> $${firstFieldParamIndex + index}, '')) LIKE $${searchParamIndex} ESCAPE '\\'`,
    )
    .join(' OR ')
}

function isUndefinedTableError(err: unknown, tableName: string): boolean {
  const code = typeof (err as any)?.code === 'string' ? (err as any).code : null
  const msg = typeof (err as any)?.message === 'string' ? (err as any).message : ''
  if (code === '42P01') return msg.includes(tableName)
  return msg.includes(`relation \"${tableName}\" does not exist`)
}

function mapFieldType(type: string): UniverMetaField['type'] {
  const normalized = type.trim().toLowerCase()
  if (normalized === 'number') return 'number'
  if (normalized === 'boolean' || normalized === 'checkbox') return 'boolean'
  if (normalized === 'button') return 'button'
  if (normalized === 'date') return 'date'
  if (
    normalized === 'datetime' ||
    normalized === 'date_time' ||
    normalized === 'date-time' ||
    normalized === 'timestamp'
  ) {
    return 'dateTime'
  }
  if (normalized === 'formula') return 'formula'
  if (normalized === 'select') return 'select'
  if (
    normalized === 'multiselect' ||
    normalized === 'multi_select' ||
    normalized === 'multi-select'
  ) {
    return 'multiSelect'
  }
  if (normalized === 'link') return 'link'
  // Native person field (人员, design 2026-06-16): stored as first-class `type='person'`
  // (userId[]), no longer aliased to `link`. Legacy person fields are stored as
  // `type='link'`+refKind:user, so this flip is coexistence-safe — see field-codecs.ts.
  if (normalized === 'person') return 'person'
  if (normalized === 'lookup') return 'lookup'
  if (normalized === 'rollup') return 'rollup'
  if (normalized === 'attachment') return 'attachment'
  if (BATCH1_FIELD_TYPES.has(normalized as any)) return normalized as UniverMetaField['type']
  if (normalized === 'autonumber' || normalized === 'auto_number' || normalized === 'auto-number') return 'autoNumber'
  if (normalized === 'createdtime' || normalized === 'created_time' || normalized === 'created-time') {
    return 'createdTime'
  }
  if (normalized === 'modifiedtime' || normalized === 'modified_time' || normalized === 'modified-time') {
    return 'modifiedTime'
  }
  if (normalized === 'createdby' || normalized === 'created_by' || normalized === 'created-by') return 'createdBy'
  if (normalized === 'modifiedby' || normalized === 'modified_by' || normalized === 'modified-by') return 'modifiedBy'
  if (
    normalized === 'longtext' ||
    normalized === 'long_text' ||
    normalized === 'long-text' ||
    normalized === 'textarea' ||
    normalized === 'multi_line_text' ||
    normalized === 'multiline'
  ) {
    return 'longText'
  }
  return 'string'
}

function extractSelectOptions(property: unknown): Array<{ value: string; color?: string }> | undefined {
  const obj = normalizeJson(property)
  const raw = obj.options
  if (!Array.isArray(raw)) return undefined

  const options: Array<{ value: string; color?: string }> = []
  for (const item of raw) {
    if (!isPlainObject(item)) continue
    const value = item.value
    if (typeof value !== 'string' && typeof value !== 'number') continue
    const color = typeof item.color === 'string' ? item.color : undefined
    options.push({ value: String(value), ...(color ? { color } : {}) })
  }

  return options.length > 0 ? options : undefined
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

const FIELD_VALIDATION_RULE_TYPES: ReadonlySet<string> = new Set([
  'required',
  'min',
  'max',
  'minLength',
  'maxLength',
  'pattern',
  'enum',
  'custom',
])

/**
 * Normalise a single validation-rule entry to the engine contract
 * (`{ type, params?, message? }`).
 *
 * Accepts both the engine shape and the flat UI shape emitted by
 * `MetaFieldValidationPanel` (`{ type, value, message }`) so that clients
 * stuck on either format round-trip correctly. Returns `null` for
 * entries we can't safely reason about.
 */
function normalizeFieldValidationRule(raw: unknown): Record<string, unknown> | null {
  if (!isPlainObject(raw)) return null
  const ruleType = typeof raw.type === 'string' ? raw.type : ''
  if (!FIELD_VALIDATION_RULE_TYPES.has(ruleType)) return null

  const message = typeof raw.message === 'string' && raw.message.length > 0 ? raw.message : undefined
  const paramsRaw = isPlainObject(raw.params) ? raw.params : undefined
  const flatValue = 'value' in raw ? raw.value : undefined

  let params: Record<string, unknown> | undefined

  switch (ruleType) {
    case 'required':
      break
    case 'custom':
      // `custom` rules are pass-throughs for external handlers — the
      // engine doesn't interpret them, but downstream consumers rely
      // on `params`, so keep it verbatim if present.
      if (paramsRaw) params = { ...paramsRaw }
      break
    case 'min':
    case 'max':
    case 'minLength':
    case 'maxLength': {
      const candidate = paramsRaw && 'value' in paramsRaw ? paramsRaw.value : flatValue
      const num = typeof candidate === 'number' ? candidate : Number(candidate)
      if (!Number.isFinite(num)) return null
      params = { value: num }
      break
    }
    case 'pattern': {
      const regex = paramsRaw && typeof paramsRaw.regex === 'string'
        ? paramsRaw.regex
        : typeof flatValue === 'string'
          ? flatValue
          : ''
      if (!regex) return null
      const flags = paramsRaw && typeof paramsRaw.flags === 'string' ? paramsRaw.flags : undefined
      params = flags ? { regex, flags } : { regex }
      break
    }
    case 'enum': {
      let values: string[] | undefined
      if (paramsRaw && Array.isArray(paramsRaw.values)) {
        values = paramsRaw.values
          .map((v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''))
          .filter((v) => v.length > 0)
      } else if (Array.isArray(flatValue)) {
        values = flatValue
          .map((v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''))
          .filter((v) => v.length > 0)
      }
      if (!values) return null
      params = { values }
      break
    }
    default:
      return null
  }

  return {
    type: ruleType,
    ...(params ? { params } : {}),
    ...(message ? { message } : {}),
  }
}

function sanitizeFieldValidationRules(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined
  const normalised: Record<string, unknown>[] = []
  for (const entry of value) {
    const rule = normalizeFieldValidationRule(entry)
    if (rule) normalised.push(rule)
  }
  return normalised
}

/**
 * Rewrite the `validation` key on a field-property object to the engine
 * contract. Applied once up front so every type-specific branch of
 * `sanitizeFieldProperty` sees already-normalised rules via the
 * downstream spread.
 *
 * An empty array is preserved (it is a meaningful "disable defaults"
 * signal). A non-array value is dropped entirely so the engine's
 * default rules kick back in.
 */
function applyFieldValidationNormalisation(obj: Record<string, unknown>): Record<string, unknown> {
  if (!('validation' in obj)) return obj
  if (!Array.isArray(obj.validation)) {
    const { validation: _omit, ...rest } = obj
    return rest
  }
  const normalised = sanitizeFieldValidationRules(obj.validation) ?? []
  return { ...obj, validation: normalised }
}

function sanitizeFieldProperty(type: UniverMetaField['type'], property: unknown): Record<string, unknown> {
  // `visibilityRule` is cross-cutting (any field type) — sanitize + merge it
  // uniformly so the write path can never leak a malformed rule via `...obj`
  // passthrough. Mirrors field-codecs.ts's sanitizeFieldProperty (shared helper).
  return withFieldVisibilityRule(sanitizeFieldPropertyByType(type, property), property)
}

function sanitizeFieldPropertyByType(type: UniverMetaField['type'], property: unknown): Record<string, unknown> {
  const obj = applyFieldValidationNormalisation(normalizeJson(property))
  if (type === 'select' || type === 'multiSelect') {
    const options = extractSelectOptions(obj) ?? []
    return { ...obj, options }
  }

  if (type === 'link') {
    const { foreignBaseId: _omitForeignBaseId, ...cleanObj } = obj
    const foreignSheetId = typeof (obj.foreignSheetId ?? obj.foreignDatasheetId ?? obj.datasheetId) === 'string'
      ? String(obj.foreignSheetId ?? obj.foreignDatasheetId ?? obj.datasheetId).trim()
      : ''
    // ②b slice 1 — promote foreignBaseId (the cross-base opt-in claim) to an EXPLICIT normalized key
    // (trim; empty → omitted) so it survives even if the `...obj` passthrough is later tightened
    // (wire-vs-fixture: the claim is contractual, not incidental).
    const foreignBaseId = typeof obj.foreignBaseId === 'string' && obj.foreignBaseId.trim().length > 0
      ? obj.foreignBaseId.trim()
      : ''
    // Bidirectional / mirror links (design 2026-06-14) — promote the pairing keys explicitly (wire-vs-fixture).
    const mirrorFieldId = typeof obj.mirrorFieldId === 'string' && obj.mirrorFieldId.trim().length > 0
      ? obj.mirrorFieldId.trim()
      : ''
    const mirrorOf = typeof obj.mirrorOf === 'string' && obj.mirrorOf.trim().length > 0
      ? obj.mirrorOf.trim()
      : ''
    return {
      ...cleanObj,
      ...(foreignSheetId ? { foreignSheetId, foreignDatasheetId: foreignSheetId } : {}),
      ...(foreignSheetId && foreignBaseId ? { foreignBaseId } : {}),
      limitSingleRecord: obj.limitSingleRecord === true,
      ...(typeof obj.refKind === 'string' && obj.refKind.trim().length > 0 ? { refKind: obj.refKind.trim() } : {}),
      ...(obj.twoWay === true ? { twoWay: true } : {}),
      ...(mirrorFieldId ? { mirrorFieldId } : {}),
      // The derived (mirror) side is read-only: `mirrorOf` set ⇒ force `readOnly:true` so both write
      // services reject a PATCH on it (isFieldAlwaysReadOnly honors property.readOnly) — this is what
      // keeps the single canonical edge from gaining a second, materialized row.
      ...(mirrorOf ? { mirrorOf, readOnly: true } : {}),
    }
  }

  if (type === 'person') {
    // Native person (人员, design 2026-06-16) — value is `userId[]`. Mirrors the
    // field-codecs.ts person branch: only `limitSingleRecord` is user-controlled and its
    // default is TRUE (`!== false`), matching the legacy person path so single/multi never
    // silently flips between a legacy link-backed person and a native person. NOT readOnly.
    const restrict = Array.isArray(obj.restrictToMemberGroupIds)
      ? Array.from(new Set(obj.restrictToMemberGroupIds.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim())))
      : []
    return {
      limitSingleRecord: obj.limitSingleRecord !== false,
      ...(restrict.length > 0 ? { restrictToMemberGroupIds: restrict } : {}),
    }
  }

  if (type === 'lookup') {
    const linkFieldId = typeof (obj.linkFieldId ?? obj.relatedLinkFieldId ?? obj.linkedFieldId ?? obj.sourceFieldId) === 'string'
      ? String(obj.linkFieldId ?? obj.relatedLinkFieldId ?? obj.linkedFieldId ?? obj.sourceFieldId).trim()
      : ''
    const targetFieldId = typeof (obj.targetFieldId ?? obj.lookUpTargetFieldId ?? obj.lookupTargetFieldId ?? obj.lookupFieldId) === 'string'
      ? String(obj.targetFieldId ?? obj.lookUpTargetFieldId ?? obj.lookupTargetFieldId ?? obj.lookupFieldId).trim()
      : ''
    const foreignSheetId = typeof (obj.foreignSheetId ?? obj.foreignDatasheetId ?? obj.datasheetId) === 'string'
      ? String(obj.foreignSheetId ?? obj.foreignDatasheetId ?? obj.datasheetId).trim()
      : ''
    return {
      ...obj,
      ...(linkFieldId ? { linkFieldId, relatedLinkFieldId: linkFieldId } : {}),
      ...(targetFieldId ? { targetFieldId, lookUpTargetFieldId: targetFieldId } : {}),
      ...(foreignSheetId ? { foreignSheetId, foreignDatasheetId: foreignSheetId, datasheetId: foreignSheetId } : {}),
    }
  }

  if (type === 'rollup') {
    const linkFieldId = typeof (obj.linkFieldId ?? obj.linkedFieldId ?? obj.relatedLinkFieldId ?? obj.sourceFieldId) === 'string'
      ? String(obj.linkFieldId ?? obj.linkedFieldId ?? obj.relatedLinkFieldId ?? obj.sourceFieldId).trim()
      : ''
    const targetFieldId = typeof (obj.targetFieldId ?? obj.lookUpTargetFieldId ?? obj.lookupTargetFieldId ?? obj.lookupFieldId) === 'string'
      ? String(obj.targetFieldId ?? obj.lookUpTargetFieldId ?? obj.lookupTargetFieldId ?? obj.lookupFieldId).trim()
      : ''
    const foreignSheetId = typeof (obj.foreignSheetId ?? obj.foreignDatasheetId ?? obj.datasheetId) === 'string'
      ? String(obj.foreignSheetId ?? obj.foreignDatasheetId ?? obj.datasheetId).trim()
      : ''
    const aggregation = parseRollupAggregation(obj.aggregation ?? obj.agg ?? obj.function ?? obj.rollupFunction) ?? 'count'
    return {
      ...obj,
      ...(linkFieldId ? { linkFieldId, linkedFieldId: linkFieldId } : {}),
      ...(targetFieldId ? { targetFieldId } : {}),
      aggregation,
      ...(foreignSheetId ? { foreignSheetId, foreignDatasheetId: foreignSheetId, datasheetId: foreignSheetId } : {}),
    }
  }

  if (type === 'formula') {
    return {
      ...obj,
      expression: typeof obj.expression === 'string' ? obj.expression.trim() : '',
    }
  }

  if (type === 'attachment') {
    const maxFiles = typeof obj.maxFiles === 'number' ? obj.maxFiles : Number(obj.maxFiles)
    return {
      ...obj,
      ...(Number.isFinite(maxFiles) && maxFiles > 0 ? { maxFiles: Math.round(maxFiles) } : {}),
      acceptedMimeTypes: sanitizeStringArray(obj.acceptedMimeTypes),
    }
  }

  if (type === 'number') {
    const next: Record<string, unknown> = { ...obj }
    if ('decimals' in obj) {
      const decimalsRaw = typeof obj.decimals === 'number' ? obj.decimals : Number(obj.decimals)
      if (Number.isFinite(decimalsRaw) && decimalsRaw >= 0 && decimalsRaw <= 6) {
        next.decimals = Math.round(decimalsRaw)
      } else {
        delete next.decimals
      }
    }
    next.thousands = obj.thousands === true
    const unit = typeof obj.unit === 'string' ? obj.unit.trim().slice(0, 24) : ''
    if (unit) next.unit = unit
    else delete next.unit
    return next
  }

  if (type === 'autoNumber') {
    return normalizeAutoNumberProperty(obj)
  }

  if (type === 'createdTime' || type === 'modifiedTime' || type === 'createdBy' || type === 'modifiedBy') {
    return { ...obj, readOnly: true }
  }

  return obj
}

function serializeFieldRow(row: any): UniverMetaField {
  const rawType = String(row.type ?? 'string')
  const mappedType = mapFieldType(rawType)
  const property = sanitizeFieldProperty(mappedType, row.property)
  const order = Number(row.order ?? 0)
  return {
    id: String(row.id),
    name: String(row.name),
    type: mappedType,
    ...(mappedType === 'select' || mappedType === 'multiSelect' ? { options: extractSelectOptions(property) } : {}),
    order: Number.isFinite(order) ? order : 0,
    property,
  }
}

type MetaSortRule = { fieldId: string; desc: boolean }

function isNullishSortValue(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string' && value.trim() === '') return true
  if (Array.isArray(value) && value.length === 0) return true
  return false
}

type MetaFilterConjunction = 'and' | 'or'
type MetaFilterCondition = { fieldId: string; operator: string; value?: unknown }

type MetaFilterInfo = {
  conjunction: MetaFilterConjunction
  conditions: MetaFilterCondition[]
}

function parseMetaSortRules(sortInfo: unknown): MetaSortRule[] {
  if (!sortInfo || typeof sortInfo !== 'object') return []
  const rawRules = (sortInfo as { rules?: unknown }).rules
  if (!Array.isArray(rawRules)) return []

  const rules: MetaSortRule[] = []
  for (const raw of rawRules) {
    if (!isPlainObject(raw)) continue
    const fieldId = raw.fieldId
    if (typeof fieldId !== 'string' || fieldId.trim().length === 0) continue
    rules.push({ fieldId: fieldId.trim(), desc: raw.desc === true })
  }
  return rules
}

/**
 * Numeric query semantics: these field types sort + range-filter as JS numbers
 * via toComparableNumber. `date` is intentionally excluded — it has its own
 * epoch branch (toEpoch). `rollup` is pre-normalized to `number` by callers
 * (effectiveType), so it need not appear here. Shared by compareMetaSortValue
 * (sort) and evaluateMetaFilterCondition (filter) so the two cannot drift.
 * See docs/development/multitable-typed-query-polish-design-20260603.md.
 */
export function isNumericQueryFieldType(type: string): boolean {
  return type === 'number' || type === 'currency' || type === 'percent' || type === 'rating'
}

export function compareMetaSortValue(type: UniverMetaField['type'], valueA: unknown, valueB: unknown, desc: boolean): number {
  const effectiveType = type === 'rollup' ? 'number' : type
  const aNull = isNullishSortValue(valueA)
  const bNull = isNullishSortValue(valueB)
  if (aNull && bNull) return 0
  if (aNull) return 1
  if (bNull) return -1

  let cmp = 0
  if (isNumericQueryFieldType(effectiveType) || effectiveType === 'date') {
    const toComparable = effectiveType === 'date' ? toEpoch : toComparableNumber
    const leftValue = toComparable(valueA)
    const rightValue = toComparable(valueB)
    const aOk = leftValue !== null && Number.isFinite(leftValue)
    const bOk = rightValue !== null && Number.isFinite(rightValue)

    if (aOk && bOk) cmp = leftValue === rightValue ? 0 : leftValue > rightValue ? 1 : -1
    else if (aOk) cmp = -1
    else if (bOk) cmp = 1
    else cmp = 0
  } else if (effectiveType === 'boolean') {
    const toBool = (v: unknown) => {
      if (typeof v === 'boolean') return v
      if (typeof v === 'number') return v !== 0
      if (typeof v === 'string') {
        const s = v.trim().toLowerCase()
        if (s === 'true' || s === '1' || s === 'yes' || s === 'y') return true
        if (s === 'false' || s === '0' || s === 'no' || s === 'n') return false
        return s.length > 0
      }
      return Boolean(v)
    }
    const a = toBool(valueA)
    const b = toBool(valueB)
    cmp = a === b ? 0 : a ? 1 : -1
  }

  if (cmp === 0 && effectiveType !== 'boolean') {
    cmp = String(valueA).localeCompare(String(valueB), undefined, { numeric: true, sensitivity: 'base' })
  }

  if (cmp === 0) return 0
  return desc ? -cmp : cmp
}

function normalizeFilterScalar(value: unknown): unknown {
  if (Array.isArray(value)) return value[0]
  return value
}

function parseMetaFilterInfo(filterInfo: unknown): MetaFilterInfo | null {
  if (!filterInfo || typeof filterInfo !== 'object') return null
  const obj = filterInfo as { conjunction?: unknown; conditions?: unknown }
  if (!Array.isArray(obj.conditions)) return null

  const conditions: MetaFilterCondition[] = []
  for (const raw of obj.conditions) {
    if (!isPlainObject(raw)) continue
    const fieldId = raw.fieldId
    const operator = raw.operator
    if (typeof fieldId !== 'string' || fieldId.trim().length === 0) continue
    if (typeof operator !== 'string' || operator.trim().length === 0) continue
    conditions.push({
      fieldId: fieldId.trim(),
      operator: operator.trim(),
      ...(Object.prototype.hasOwnProperty.call(raw, 'value') ? { value: (raw as any).value } : {}),
    })
  }
  if (conditions.length === 0) return null

  const conjunctionRaw = typeof obj.conjunction === 'string' ? obj.conjunction.trim().toLowerCase() : 'and'
  const conjunction: MetaFilterConjunction = conjunctionRaw === 'or' ? 'or' : 'and'
  return { conjunction, conditions }
}

function toComparableString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function toComparableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function toComparableBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase()
    if (s === '') return null
    if (s === 'true' || s === '1' || s === 'yes' || s === 'y') return true
    if (s === 'false' || s === '0' || s === 'no' || s === 'n') return false
    return true
  }
  return Boolean(value)
}

type RelationalLinkField = { fieldId: string; cfg: LinkFieldConfig }

async function loadLinkValuesByRecord(
  query: QueryFn,
  recordIds: string[],
  relationalLinkFields: RelationalLinkField[],
): Promise<Map<string, Map<string, string[]>>> {
  const linkValuesByRecord = new Map<string, Map<string, string[]>>()
  if (relationalLinkFields.length === 0 || recordIds.length === 0) return linkValuesByRecord

  const pushValue = (recordId: string, fieldId: string, value: string): void => {
    const recordMap = linkValuesByRecord.get(recordId) ?? new Map<string, string[]>()
    const list = recordMap.get(fieldId) ?? []
    list.push(value)
    recordMap.set(fieldId, list)
    linkValuesByRecord.set(recordId, recordMap)
  }

  // Bidirectional / mirror links (design 2026-06-14) — partition the link fields by side. A DERIVED
  // (mirror) field carries `cfg.mirrorOf` = the paired FORWARD field's id; its value set is the REVERSE
  // projection of the SAME single edge (no stored mirror row). Forward fields read as before. Centralizing
  // the split here makes every read consumer (/view, single-record read :9007, write-echo) resolve the
  // reverse identically — wiring it per-call-site would risk a canary hitting an unconverted path.
  const forwardFields = relationalLinkFields.filter((l) => !l.cfg.mirrorOf)
  const derivedFields = relationalLinkFields.filter((l) => l.cfg.mirrorOf)

  // Forward — the canonical read: WHERE field_id IN (forward ids) AND record_id IN (records) → foreign ids.
  if (forwardFields.length > 0) {
    const fieldIds = forwardFields.map((l) => l.fieldId)
    const linkRes = await query(
      `SELECT field_id, record_id, foreign_record_id
       FROM meta_links
       WHERE field_id = ANY($1::text[]) AND record_id = ANY($2::text[])`,
      [fieldIds, recordIds],
    )
    for (const raw of linkRes.rows as any[]) {
      pushValue(String(raw.record_id), String(raw.field_id), String(raw.foreign_record_id))
    }
  }

  // Reverse — for derived (mirror) fields: WHERE field_id IN (paired forward ids = mirrorOf) AND
  // foreign_record_id IN (records) → the SOURCE record_id is the linked value, surfaced under the MIRROR
  // field's id. Served by idx_meta_links_foreign (no migration). Multiple mirror fields may share one
  // forward field, so map mirrorOf → mirror field ids and fan each matching row out to all of them.
  if (derivedFields.length > 0) {
    const mirrorFieldsByForwardId = new Map<string, string[]>()
    for (const { fieldId, cfg } of derivedFields) {
      const forwardId = cfg.mirrorOf as string
      const list = mirrorFieldsByForwardId.get(forwardId) ?? []
      list.push(fieldId)
      mirrorFieldsByForwardId.set(forwardId, list)
    }
    const forwardIds = Array.from(mirrorFieldsByForwardId.keys())
    const reverseRes = await query(
      `SELECT field_id, record_id, foreign_record_id
       FROM meta_links
       WHERE field_id = ANY($1::text[]) AND foreign_record_id = ANY($2::text[])`,
      [forwardIds, recordIds],
    )
    for (const raw of reverseRes.rows as any[]) {
      const forwardId = String(raw.field_id)
      const thisRecordId = String(raw.foreign_record_id) // the mirror record being read
      const sourceRecordId = String(raw.record_id) // the reverse-linked source record
      for (const mirrorFieldId of mirrorFieldsByForwardId.get(forwardId) ?? []) {
        pushValue(thisRecordId, mirrorFieldId, sourceRecordId)
      }
    }
  }

  return linkValuesByRecord
}

/**
 * Bidirectional / mirror links (design 2026-06-14) — RAW-DATA foreign-readability mask (B3 review nit).
 *
 * A DERIVED (mirror) field (`cfg.mirrorOf` set) surfaces the REVERSE edges = the *source* (foreign-sheet)
 * records that link INTO this record. Those source ids are inbound edges this record never authored, so a
 * record-reader who CANNOT read the mirror's foreign sheet (`cfg.foreignSheetId`) must not learn their
 * opaque ids + count via the raw `record.data[mirrorFieldId]` array. `buildLinkSummaries` already gates the
 * summary on `cfg.foreignSheetId` readability; the raw-data array was a SECOND, ungated projection (it leaked
 * `[A1,A2]` to a foreign-denied actor on /view, single-record GET, and the write-echo). Reuse the SAME
 * `resolveReadableSheetIds` gate keyed on `cfg.foreignSheetId` and blank the value to `[]` when denied.
 *
 * FORWARD link fields are deliberately left UNTOUCHED: their raw-id posture is pre-existing and shared
 * repo-wide (an outbound edge this record authored), and the task scopes this fix to mirror fields only.
 * Same-base only by construction (cross-base twoWay/mirror is rejected at field-create), so the cross-base
 * coarse gate `buildLinkSummaries` adds on top of `resolveReadableSheetIds` is a no-op here — sheet-level
 * read IS the exact gate. Idempotent / order-independent: mutates `row.data` in place for denied mirrors only.
 */
async function maskDerivedMirrorFieldIds(
  req: Request,
  query: QueryFn,
  rows: UniverMetaRecord[],
  relationalLinkFields: RelationalLinkField[],
): Promise<void> {
  const mirrorFields = relationalLinkFields.filter((l) => l.cfg.mirrorOf)
  if (mirrorFields.length === 0 || rows.length === 0) return
  const readableSheetIds = await resolveReadableSheetIds(
    req,
    query,
    mirrorFields.map((l) => l.cfg.foreignSheetId),
  )
  for (const row of rows) {
    for (const { fieldId, cfg } of mirrorFields) {
      if (!readableSheetIds.has(cfg.foreignSheetId)) {
        row.data[fieldId] = []
      }
    }
  }
}

/**
 * Recalculate `formula` fields for just-updated records when a changed field has
 * a dependent formula in this sheet (per `formula_dependencies`). Delegates the
 * per-record evaluate + materialize to MultitableFormulaEngine.recalculateRecord
 * (which sources the expression from `field.property.expression`) and returns the
 * recomputed formula-field values per record so the write path can surface them
 * in the response + realtime patch. Returns `[]` when no formula depends on the
 * change. Only the DEPENDENT formulas are re-evaluated/persisted (the dep-gate
 * result doubles as the engine allowlist) — formulas with unchanged inputs keep
 * their stored value, since actor-scoped hydration could otherwise clobber them.
 * Intra-sheet / intra-record only — no cross-sheet read, no perm gate.
 */
async function recalculateFormulaFields(
  // §2a.3 B1: `req` is the WRITING actor — needed to resolve write-side formula taint so a
  // foreign-field-denied writer never recomputes (and persists) a permission-degraded formula
  // value into shared meta_records.data. See the taint skip below.
  req: Request,
  query: QueryFn,
  sheetId: string,
  fields: UniverMetaField[],
  updatedRecordIds: string[],
  changedFieldIds: string[],
  // A-min (design #2246): per-record rows whose lookup/rollup were already hydrated in-memory
  // (write-path Step 4). When provided, eval formulas against the hydrated data so a
  // formula-over-lookup sees the actual lookup value instead of the absent-on-reload `0`.
  // Same-record / same-sheet only; absent → raw reload (unchanged for form-submit).
  hydratedDataByRecord?: Map<string, Record<string, unknown>>,
): Promise<Array<{ recordId: string; data: Record<string, unknown> }>> {
  if (updatedRecordIds.length === 0 || changedFieldIds.length === 0) return []
  const formulaFieldIds = fields.filter((f) => f.type === 'formula').map((f) => f.id)
  if (formulaFieldIds.length === 0) return []

  // A-min trigger: a lookup/rollup's value changes when its underlying LINK field is edited, but
  // changedFieldIds carries the link id, not the derived lookup id — so the dependency gate
  // (formula → lookup) would miss. Expand the changed set with the SAME-RECORD lookup/rollup ids
  // whose linkFieldId is in changedFieldIds. This stays bounded to updatedRecordIds (the patched
  // records) → it never reaches foreign/related records' formulas (that is A-full, gated).
  const changedSet = new Set(changedFieldIds)
  const effectiveChangedFieldIds = [...changedSet]
  for (const field of fields) {
    if (field.type !== 'lookup' && field.type !== 'rollup') continue
    if (changedSet.has(field.id)) continue
    const cfg = field.type === 'lookup' ? parseLookupFieldConfig(field.property) : parseRollupFieldConfig(field.property)
    if (cfg && changedSet.has(cfg.linkFieldId)) {
      effectiveChangedFieldIds.push(field.id)
    }
  }

  // Gate: only recompute when a changed (or dependent-lookup) field actually feeds a formula here.
  // The returned field ids are ALSO the recompute allowlist (F1, review of #2450): hydration is
  // actor-scoped, so a formula whose inputs did not change must not be re-evaluated — it could
  // be clobbered with a permission-degraded value (unreadable foreign sheet → lookup []).
  const depRes = await query(
    `SELECT DISTINCT field_id FROM formula_dependencies
     WHERE depends_on_field_id = ANY($1::text[])
       AND (depends_on_sheet_id IS NULL OR depends_on_sheet_id = $2)
       AND sheet_id = $2`,
    [effectiveChangedFieldIds, sheetId],
  )
  if (depRes.rows.length === 0) return []
  const formulaFieldIdSet = new Set(formulaFieldIds)
  const dependentFormulaFieldIds = new Set(
    (depRes.rows as any[]).map((row) => String(row.field_id)).filter((id) => formulaFieldIdSet.has(id)),
  )
  if (dependentFormulaFieldIds.size === 0) return []

  // §2a.3 B1 (write-side taint skip-recompute): the write path hydrates rows via applyLookupRollup,
  // which MASKS a lookup/rollup over a foreign field this actor cannot read (→ []). Recomputing a
  // formula against that masked input would PERSIST a permission-degraded value into shared
  // meta_records.data (recalculateRecordFromData unconditionally writes back). Drop any formula
  // whose deps (transitively) reach a lookup/rollup masked for THIS writer, leaving the previously
  // stored AUTHORIZED value untouched — symmetric to the export/aggregate/read taint sinks. An
  // authorized writer (nothing masked) gets an empty tainted set → recompute is unchanged.
  const taintedForWriter = await resolveTaintedFormulaFieldIds(req, query, sheetId, dependentFormulaFieldIds)
  for (const id of taintedForWriter) dependentFormulaFieldIds.delete(id)
  if (dependentFormulaFieldIds.size === 0) return []

  const results: Array<{ recordId: string; data: Record<string, unknown> }> = []
  for (const recordId of updatedRecordIds) {
    const hydrated = hydratedDataByRecord?.get(recordId)
    const nextData = hydrated
      ? await multitableFormulaEngine.recalculateRecordFromData(query, sheetId, recordId, hydrated, fields, dependentFormulaFieldIds)
      : await multitableFormulaEngine.recalculateRecord(query, sheetId, recordId, fields, dependentFormulaFieldIds)
    if (!nextData) continue
    const formulaData: Record<string, unknown> = {}
    for (const fieldId of dependentFormulaFieldIds) {
      if (fieldId in nextData) formulaData[fieldId] = nextData[fieldId]
    }
    results.push({ recordId, data: formulaData })
  }
  return results
}

/**
 * A-min-create (design #2255): compute a NEWLY created / submitted record's same-record formulas
 * for the FIRST time, with lookup/rollup hydrated in-memory so a formula-over-lookup sees the
 * actual value instead of the absent-on-reload `0`. Run only AFTER insert + meta_links exist.
 * NO dependency gate — a fresh record computes ALL its formula fields once. Loads the record(s),
 * hydrates via applyLookupRollup, then recalculateRecordFromData (writes back ONLY formula keys —
 * lookup/rollup are NOT materialized). Same-record / same-sheet only (no foreign/related
 * propagation — that is A-full, gated). Returns the recomputed formula values per record so the
 * CALLER can surface them in echo/realtime under its own field-read mask. Route-layer: owns `req`
 * + applyLookupRollup so the service layer never learns either. Reused by the createRecord hook
 * (POST /records + import-xlsx) and the form-submit handler.
 */
async function recalcNewRecordFormulas(
  req: Request,
  query: QueryFn,
  sheetId: string,
  recordIds: string[],
): Promise<Array<{ recordId: string; data: Record<string, unknown> }>> {
  if (recordIds.length === 0) return []
  const fields = await loadSheetFields({ query }, sheetId)
  const formulaFieldIds = fields.filter((f) => f.type === 'formula').map((f) => f.id)
  if (formulaFieldIds.length === 0) return []

  const recordRes = await query(
    'SELECT id, version, data FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])',
    [sheetId, recordIds],
  )
  const rows = (recordRes.rows as any[]).map((r) => ({
    id: String(r.id),
    version: Number(r.version ?? 1),
    data: normalizeJson(r.data),
  })) as UniverMetaRecord[]
  if (rows.length === 0) return []

  const relationalLinkFields = fields
    .map((f) => (f.type === 'link' ? { fieldId: f.id, cfg: parseLinkFieldConfig(f.property) } : null))
    .filter((v): v is RelationalLinkField => !!v && !!v.cfg)
  const linkValuesByRecord = await loadLinkValuesByRecord(query, recordIds, relationalLinkFields)
  // Hydrate same-record lookup/rollup into row.data (perm-scoped foreign read inside).
  await applyLookupRollup(req, query, sheetId, fields, rows, relationalLinkFields, linkValuesByRecord)

  // §2a.3 B1-CREATE (write-side taint skip-recompute on the CREATE/import/form-submit path): the
  // hydration above MASKS a lookup/rollup over a foreign field this actor (the creator / form
  // submitter — possibly anonymous on the public form) cannot read (→ []). Recomputing a formula
  // against that masked input would PERSIST a permission-degraded value into shared
  // meta_records.data (recalculateRecordFromData unconditionally writes back). Restrict the
  // recompute to formula fields whose deps do NOT (transitively) reach a lookup/rollup masked for
  // THIS actor, leaving any tainted formula absent rather than degraded — symmetric to the PATCH
  // recompute skip and the export/aggregate/read taint sinks. An authorized creator (nothing
  // masked) gets an empty tainted set → recompute is unchanged.
  const taintedForCreator = await resolveTaintedFormulaFieldIds(req, query, sheetId, new Set(formulaFieldIds))
  const recomputeFormulaFieldIds = new Set(formulaFieldIds.filter((id) => !taintedForCreator.has(id)))
  if (recomputeFormulaFieldIds.size === 0) return []

  const results: Array<{ recordId: string; data: Record<string, unknown> }> = []
  for (const row of rows) {
    const nextData = await multitableFormulaEngine.recalculateRecordFromData(query, sheetId, row.id, row.data, fields, recomputeFormulaFieldIds)
    if (!nextData) continue
    const formulaData: Record<string, unknown> = {}
    for (const fieldId of recomputeFormulaFieldIds) {
      if (fieldId in nextData) formulaData[fieldId] = nextData[fieldId]
    }
    results.push({ recordId: row.id, data: formulaData })
  }
  return results
}

/**
 * §2a.3 — per (foreignSheetId) actor-scoped foreign-field readability + cross-base flag.
 * `readableFieldIds` = the foreign fields the actor may read (visible !== false under the
 * foreign sheet's subject-scoped field_permissions), mirroring the export/view derivation.
 * `crossBase` = foreign base_id ≠ source base_id (null vs non-null counts as cross-base;
 * both null / equal counts as same-base). Decided ONCE per foreign sheet, never per record.
 */
type ForeignFieldReadability = { readableFieldIds: Set<string>; crossBase: boolean }

async function resolveForeignFieldReadability(
  req: Request,
  query: QueryFn,
  sourceBaseId: string | null,
  foreignSheetIds: Iterable<string>,
): Promise<Map<string, ForeignFieldReadability>> {
  const out = new Map<string, ForeignFieldReadability>()
  const unique = Array.from(new Set(Array.from(foreignSheetIds).filter(Boolean)))
  if (unique.length === 0) return out
  const access = await resolveRequestAccess(req)
  for (const foreignSheetId of unique) {
    const [foreignSheet, foreignFields, capabilities, fieldScopeMap] = await Promise.all([
      loadSheetRowShared(query, foreignSheetId),
      loadFieldsForSheetShared(query, foreignSheetId),
      // Capabilities don't affect field VISIBILITY (only readOnly), but resolve them so the
      // foreign-sheet derivation matches the export/view path exactly.
      resolveSheetReadableCapabilities(req, query, foreignSheetId).then((r) => r.capabilities),
      access.userId ? loadFieldPermissionScopeMap(query, foreignSheetId, access.userId) : Promise.resolve(new Map<string, FieldPermissionScope>()),
    ])
    let readableFieldIds = computeAllowedFieldIds(foreignFields as UniverMetaField[], capabilities, fieldScopeMap)
    // null vs non-null ⇒ cross-base (mask); equal (incl. both null) ⇒ same-base.
    const foreignBaseId = foreignSheet?.baseId ?? null
    const crossBase = foreignBaseId !== sourceBaseId
    // ②b §3.2 Sink A — base-read COARSE gate, ONLY for cross-base foreign sheets. A reader lacking
    // base-read on the foreign base sees the WHOLE foreign sheet's readable-field set emptied (→
    // shouldMaskForeignField :1988 never short-circuits → every foreign field masked → lookup/rollup
    // hydration AND formula-taint both drop it). This is a strict ADD on top of the §2a.3 field mask
    // (it only REDUCES visibility, never widens it — §6.2.2). Same-base is never touched (XB-3). A null
    // foreign base is unreadable by definition (can't opt in / can't grant) → mask (also crash-safe:
    // resolveBaseReadable would throw on null).
    if (crossBase) {
      const baseReadable = foreignBaseId != null && (await resolveBaseReadable(req, query, foreignBaseId))
      if (!baseReadable) {
        readableFieldIds = new Set<string>()
      }
    }
    out.set(foreignSheetId, { readableFieldIds, crossBase })
  }
  return out
}

/**
 * §2a.3 — given the per-foreign-sheet readability map + a lookup/rollup config, decide whether
 * the config's foreign target field must be MASKED for the actor. A field is masked when the
 * actor cannot read it AND (cross-base OR (same-base AND no opt-out)). Returns false when the
 * foreign field is readable, when the foreign sheet is unknown, or when same-base opt-out is set.
 */
function shouldMaskForeignField(
  readability: Map<string, ForeignFieldReadability>,
  foreignSheetId: string | undefined,
  targetFieldId: string,
  skipForeignFieldMasking: boolean | undefined,
): boolean {
  if (!foreignSheetId) return false
  const entry = readability.get(foreignSheetId)
  if (!entry) return false
  if (entry.readableFieldIds.has(targetFieldId)) return false // actor can read it → flows normally
  // Unreadable foreign field: cross-base masks unconditionally; same-base masks unless opted out.
  if (entry.crossBase) return true
  return skipForeignFieldMasking !== true
}

/**
 * §2a.3 formula taint-check (surface-neutral) — returns the subset of `candidateFormulaFieldIds`
 * whose MATERIALIZED value must be DROPPED because the formula (directly OR transitively via
 * formula→formula dependency edges within this sheet) reads a lookup/rollup field whose foreign
 * target field is masked for `req`'s actor (cross-base unconditional / same-base default unless
 * opt-out). Transitive closure is bounded to same-sheet formula→formula edges, which is the
 * model `formula_dependencies` records; cross-sheet formula chaining is not part of the model.
 *
 * Applied UNIFORMLY across EVERY sink that reads or persists materialized formula values RAW
 * (without applyLookupRollup re-masking them):
 *   READ/EMIT sinks (drop tainted ids from the actor's allowed/visible set before emitting data):
 *     - GET /view, single-record GET /records/:id, cursor GET /records,
 *     - PATCH /records/:id echo, GET /form-context edit-mode echo,
 *     - export-xlsx, view-aggregate, dashboard group-by/aggregate, record-history.
 *   WRITE/RECOMPUTE sinks (drop tainted ids from the recompute set so a denied write never
 *   materializes a degraded value into shared state):
 *     - PATCH recompute (recalculateFormulaFields),
 *     - CREATE / import / public form-submit recompute (recalcNewRecordFormulas).
 * The POST /records create echo carries only the recompute output, so it inherits the create
 * recompute skip automatically; the bulk-PATCH related-record echo carries only the (already
 * taint-skipped) recompute output and never raw stored formula values.
 */
async function resolveTaintedFormulaFieldIds(
  req: Request,
  query: QueryFn,
  sheetId: string,
  candidateFormulaFieldIds: Set<string>,
): Promise<Set<string>> {
  if (candidateFormulaFieldIds.size === 0) return new Set()

  const fields = (await loadFieldsForSheetShared(query, sheetId)) as UniverMetaField[]
  // Map each lookup/rollup field id → its parsed config (the foreign target it reads).
  const computedConfigById = new Map<string, LookupFieldConfig | RollupFieldConfig>()
  const linkConfigById = new Map<string, LinkFieldConfig>()
  for (const f of fields) {
    if (f.type === 'link') {
      const cfg = parseLinkFieldConfig(f.property)
      if (cfg) linkConfigById.set(f.id, cfg)
    } else if (f.type === 'lookup') {
      const cfg = parseLookupFieldConfig(f.property)
      if (cfg) computedConfigById.set(f.id, cfg)
    } else if (f.type === 'rollup') {
      const cfg = parseRollupFieldConfig(f.property)
      if (cfg) computedConfigById.set(f.id, cfg)
    }
  }
  const formulaFieldIds = new Set(fields.filter((f) => f.type === 'formula').map((f) => f.id))
  // No computed fields on this sheet → nothing a formula could taint-leak.
  if (computedConfigById.size === 0) return new Set()

  // All in-sheet dependency edges (field_id depends_on depends_on_field_id, same sheet).
  const depRes = await query(
    `SELECT field_id, depends_on_field_id FROM formula_dependencies
     WHERE sheet_id = $1 AND (depends_on_sheet_id IS NULL OR depends_on_sheet_id = $1)`,
    [sheetId],
  )
  const dependsOnByField = new Map<string, Set<string>>()
  for (const raw of depRes.rows as Array<{ field_id?: unknown; depends_on_field_id?: unknown }>) {
    const fieldId = typeof raw.field_id === 'string' ? raw.field_id : ''
    const dep = typeof raw.depends_on_field_id === 'string' ? raw.depends_on_field_id : ''
    if (!fieldId || !dep) continue
    const set = dependsOnByField.get(fieldId) ?? new Set<string>()
    set.add(dep)
    dependsOnByField.set(fieldId, set)
  }

  // Resolve foreign-field readability ONCE for every foreign sheet any computed field references.
  const sourceSheet = await loadSheetRowShared(query, sheetId)
  const sourceBaseId = sourceSheet?.baseId ?? null
  const foreignSheetIds = new Set<string>()
  for (const cfg of computedConfigById.values()) {
    const fs = cfg.foreignSheetId ?? linkConfigById.get(cfg.linkFieldId)?.foreignSheetId
    if (fs) foreignSheetIds.add(fs)
  }
  const readability = await resolveForeignFieldReadability(req, query, sourceBaseId, foreignSheetIds)

  // A computed (lookup/rollup) field is "masked" iff its foreign target field is masked.
  const maskedComputedFieldIds = new Set<string>()
  for (const [fieldId, cfg] of computedConfigById.entries()) {
    const fs = cfg.foreignSheetId ?? linkConfigById.get(cfg.linkFieldId)?.foreignSheetId
    if (shouldMaskForeignField(readability, fs, cfg.targetFieldId, cfg.skipForeignFieldMasking)) {
      maskedComputedFieldIds.add(fieldId)
    }
  }
  if (maskedComputedFieldIds.size === 0) return new Set()

  // For each candidate FORMULA field, transitively resolve whether it reaches a masked computed
  // field via same-sheet formula→formula edges (bounded — visited-guarded, no cycles). Non-formula
  // candidate ids are ignored defensively so a caller may pass a broad allow-set (e.g. history)
  // without ever dropping a non-formula field.
  const tainted = new Set<string>()
  for (const formulaFieldId of candidateFormulaFieldIds) {
    if (!formulaFieldIds.has(formulaFieldId)) continue
    const stack = [formulaFieldId]
    const visited = new Set<string>()
    let leaks = false
    while (stack.length > 0) {
      const current = stack.pop() as string
      if (visited.has(current)) continue
      visited.add(current)
      for (const dep of dependsOnByField.get(current) ?? []) {
        if (maskedComputedFieldIds.has(dep)) { leaks = true; break }
        // Only chase further through formula→formula edges (a formula's deps that are themselves
        // formulas); a dep on a non-formula, non-masked-computed field is a leaf.
        if (formulaFieldIds.has(dep)) stack.push(dep)
      }
      if (leaks) break
    }
    if (leaks) tainted.add(formulaFieldId)
  }
  return tainted
}

/**
 * §2a.3 CHOKEPOINT — the single place that knows the "stored-data read sink" masking rule.
 *
 * Every surface that re-reads stored `meta_records.data` and then masks it with a SOURCE-SHEET-ONLY
 * field set (`filterRecordDataByFieldIds(storedData, allowedFieldIds)`) MUST derive that allowed set
 * through this helper. A formula field whose value was materialized from a lookup/rollup over a
 * foreign field that is DENIED to the requesting actor is itself source-visible, so it survives the
 * layer-2 ∧ layer-3 field mask — but its persisted value still encodes the denied foreign data. This
 * helper drops those tainted formula ids from the base allowed set so the materialized value can
 * never reach a non-authorized actor.
 *
 * Returns a NEW set (does not mutate `baseAllowedFieldIds`): `baseAllowedFieldIds` MINUS the formula
 * field ids tainted for this actor. The taint is per-(sheet, actor) — computed once per request, the
 * same granularity as the existing allowed set — NOT per-record.
 *
 * `fields` is optional: when supplied, only formula fields present in both `fields` and
 * `baseAllowedFieldIds` are offered to the resolver (a clarity/perf narrowing). When omitted, the
 * full `baseAllowedFieldIds` is passed to the resolver, which defensively ignores non-formula ids
 * (used by the record-history redaction, whose allow-set is built without a typed field list).
 *
 * Adding a NEW stored-data read sink? Route its allowed set through THIS helper. The durable guard
 * test `multitable-stored-data-taint-chokepoint.guard.test.ts` will FAIL if a
 * `filterRecordDataByFieldIds` call over stored record data is reachable without it.
 */
async function maskStoredRecordFieldIds(
  req: Request,
  query: QueryFn,
  sheetId: string,
  fields: Array<{ id: string; type: string }> | undefined,
  baseAllowedFieldIds: Set<string>,
): Promise<Set<string>> {
  const candidateFormulaIds = fields
    ? new Set(
        fields
          .filter((field) => field.type === 'formula' && baseAllowedFieldIds.has(field.id))
          .map((field) => field.id),
      )
    : new Set(baseAllowedFieldIds)
  const tainted = await resolveTaintedFormulaFieldIds(req, query, sheetId, candidateFormulaIds)
  if (tainted.size === 0) return new Set(baseAllowedFieldIds)
  const masked = new Set(baseAllowedFieldIds)
  for (const id of tainted) masked.delete(id)
  return masked
}

/**
 * §2a.3 DISPLAY-PROJECTION chokepoint — the symmetric guard for single-field display projections over
 * stored data (e.g. `loadRecordSummaries` choosing one `displayFieldId` to string-coerce). A tainted
 * formula field passed as the display field would leak its materialized foreign-derived value as the
 * summary string. Resolves whether `displayFieldId` is tainted for the actor, and returns the set of
 * candidate display field ids with tainted formula fields removed (for auto-pick). Callers that accept
 * an explicit attacker-controlled `displayFieldId` must reject it when `taintedDisplay` is true (same
 * 400 posture as the existing `allowedFieldIds.has(...)` validation).
 */
async function resolveDisplayFieldTaint(
  req: Request,
  query: QueryFn,
  sheetId: string,
  fields: Array<{ id: string; type: string }>,
  candidateDisplayFieldIds: Set<string>,
  explicitDisplayFieldId: string | null,
): Promise<{ taintedExplicit: boolean; allowedDisplayFieldIds: Set<string> }> {
  const candidateFormulaIds = new Set(
    fields
      .filter((field) => field.type === 'formula' && candidateDisplayFieldIds.has(field.id))
      .map((field) => field.id),
  )
  const tainted = await resolveTaintedFormulaFieldIds(req, query, sheetId, candidateFormulaIds)
  const allowedDisplayFieldIds = new Set(candidateDisplayFieldIds)
  for (const id of tainted) allowedDisplayFieldIds.delete(id)
  return {
    taintedExplicit: explicitDisplayFieldId !== null && tainted.has(explicitDisplayFieldId),
    allowedDisplayFieldIds,
  }
}

async function applyLookupRollup(
  req: Request,
  query: QueryFn,
  sourceSheetId: string,
  fields: UniverMetaField[],
  rows: UniverMetaRecord[],
  relationalLinkFields: RelationalLinkField[],
  linkValuesByRecord: Map<string, Map<string, string[]>>,
): Promise<void> {
  const lookupFieldIds = fields.filter((f) => f.type === 'lookup').map((f) => f.id)
  const rollupFieldIds = fields.filter((f) => f.type === 'rollup').map((f) => f.id)
  if ((lookupFieldIds.length === 0 && rollupFieldIds.length === 0) || rows.length === 0) return

  const lookupConfigs = new Map<string, LookupFieldConfig | null>()
  for (const f of fields) {
    if (f.type !== 'lookup') continue
    lookupConfigs.set(f.id, parseLookupFieldConfig(f.property))
  }

  const rollupConfigs = new Map<string, RollupFieldConfig | null>()
  for (const f of fields) {
    if (f.type !== 'rollup') continue
    rollupConfigs.set(f.id, parseRollupFieldConfig(f.property))
  }

  const linkConfigById = new Map<string, LinkFieldConfig>()
  for (const { fieldId, cfg } of relationalLinkFields) {
    linkConfigById.set(fieldId, cfg)
  }

  const getLinkIds = (record: UniverMetaRecord, linkFieldId: string) => {
    const recordMap = linkValuesByRecord.get(record.id)
    const cached = recordMap?.get(linkFieldId)
    if (cached) return cached
    return normalizeLinkIds(record.data[linkFieldId])
  }

  const foreignIdsBySheet = new Map<string, Set<string>>()
  const ensureSheetSet = (sheetId: string) => {
    const set = foreignIdsBySheet.get(sheetId) ?? new Set<string>()
    foreignIdsBySheet.set(sheetId, set)
    return set
  }

  for (const row of rows) {
    for (const cfg of lookupConfigs.values()) {
      if (!cfg) continue
      const foreignSheetId = cfg.foreignSheetId ?? linkConfigById.get(cfg.linkFieldId)?.foreignSheetId
      if (!foreignSheetId) continue
      const ids = getLinkIds(row, cfg.linkFieldId)
      if (ids.length === 0) continue
      const set = ensureSheetSet(foreignSheetId)
      for (const id of ids) set.add(id)
    }
    for (const cfg of rollupConfigs.values()) {
      if (!cfg) continue
      const foreignSheetId = cfg.foreignSheetId ?? linkConfigById.get(cfg.linkFieldId)?.foreignSheetId
      if (!foreignSheetId) continue
      const ids = getLinkIds(row, cfg.linkFieldId)
      if (ids.length === 0) continue
      const set = ensureSheetSet(foreignSheetId)
      for (const id of ids) set.add(id)
    }
  }

  const readableForeignSheetIds = await resolveReadableSheetIds(req, query, foreignIdsBySheet.keys())

  // §2a.3 — resolve foreign-FIELD-level readability + cross-base for every readable foreign sheet
  // (one scope-map load per foreign sheet, batched — never per record). Source base_id is needed
  // for the cross-base decision; load it once.
  const sourceSheet = await loadSheetRowShared(query, sourceSheetId)
  const sourceBaseId = sourceSheet?.baseId ?? null
  const foreignFieldReadability = await resolveForeignFieldReadability(
    req,
    query,
    sourceBaseId,
    Array.from(foreignIdsBySheet.keys()).filter((id) => readableForeignSheetIds.has(id)),
  )

  const foreignRecordsBySheet = new Map<string, Map<string, Record<string, unknown>>>()
  for (const [foreignSheetId, ids] of foreignIdsBySheet.entries()) {
    if (!readableForeignSheetIds.has(foreignSheetId)) continue
    if (ids.size === 0) continue
    const idList = Array.from(ids)
    const foreignRes = await query(
      'SELECT id, data FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])',
      [foreignSheetId, idList],
    )
    const recordMap = new Map<string, Record<string, unknown>>()
    for (const raw of foreignRes.rows as any[]) {
      recordMap.set(String(raw.id), normalizeJson(raw.data))
    }
    foreignRecordsBySheet.set(foreignSheetId, recordMap)
  }

  const resolveLookupValues = (
    record: UniverMetaRecord,
    cfg: LookupFieldConfig | RollupFieldConfig,
  ): { values: unknown[]; masked: boolean } => {
    const foreignSheetId = cfg.foreignSheetId ?? linkConfigById.get(cfg.linkFieldId)?.foreignSheetId
    if (!foreignSheetId) return { values: [], masked: false }
    const linkIds = getLinkIds(record, cfg.linkFieldId)
    if (linkIds.length === 0) return { values: [], masked: false }
    if (!readableForeignSheetIds.has(foreignSheetId)) return { values: [], masked: true }
    // §2a.3: fail-closed foreign-FIELD mask — if the actor can't read the foreign target field,
    // mask it (cross-base unconditional / same-base default unless opt-out). Same gate for
    // lookup AND rollup (both read data[targetFieldId]).
    if (shouldMaskForeignField(foreignFieldReadability, foreignSheetId, cfg.targetFieldId, cfg.skipForeignFieldMasking)) {
      return { values: [], masked: true }
    }
    const foreignMap = foreignRecordsBySheet.get(foreignSheetId)
    if (!foreignMap) return { values: [], masked: true }
    const values: unknown[] = []
    for (const id of linkIds) {
      const data = foreignMap.get(id)
      if (!data) continue
      const value = data[cfg.targetFieldId]
      if (value === null || value === undefined) continue
      values.push(value)
    }
    return { values, masked: false }
  }

  const aggregateRollup = (values: unknown[], aggregation: RollupAggregation): number | null => {
    if (aggregation === 'count') return values.length
    const nums = values
      .map((v) => toComparableNumber(v))
      .filter((v): v is number => v !== null && Number.isFinite(v))
    if (nums.length === 0) return null
    if (aggregation === 'sum') return nums.reduce((sum, v) => sum + v, 0)
    if (aggregation === 'avg') return nums.reduce((sum, v) => sum + v, 0) / nums.length
    if (aggregation === 'min') return Math.min(...nums)
    if (aggregation === 'max') return Math.max(...nums)
    return null
  }

  for (const row of rows) {
    for (const [fieldId, cfg] of lookupConfigs.entries()) {
      if (!cfg) {
        row.data[fieldId] = []
        continue
      }
      row.data[fieldId] = resolveLookupValues(row, cfg).values
    }

    for (const [fieldId, cfg] of rollupConfigs.entries()) {
      if (!cfg) {
        row.data[fieldId] = null
        continue
      }
      const { values, masked } = resolveLookupValues(row, cfg)
      row.data[fieldId] = masked ? null : aggregateRollup(values, cfg.aggregation)
    }
  }
}

function extractLookupRollupData(fields: UniverMetaField[], rowData: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  for (const field of fields) {
    if (field.type !== 'lookup' && field.type !== 'rollup') continue
    data[field.id] = rowData[field.id]
  }
  return data
}

type RelatedComputedRecord = {
  sheetId: string
  recordId: string
  data: Record<string, unknown>
  /**
   * FOL-1 (followups design 2026-06-10 §2.1): UNMASKED affected-field metadata — the
   * lookup/rollup ids the edited source fields actually feed for THIS record, plus the
   * formula ids actually recomputed. Drives the related-sheet realtime fan-out + Yjs
   * invalidation gates in RecordWriteService; ids are metadata, never values. The masked
   * `data` above stays the only thing surfaced in the HTTP echo.
   */
  affectedFieldIds: string[]
}

function mergeComputedRecords(
  base: Array<{ recordId: string; data: Record<string, unknown> }> | undefined,
  extra: Array<{ recordId: string; data: Record<string, unknown> }>,
): Array<{ recordId: string; data: Record<string, unknown> }> | undefined {
  if ((!base || base.length === 0) && extra.length === 0) return undefined
  const merged = new Map<string, { recordId: string; data: Record<string, unknown> }>()
  if (base) {
    for (const record of base) {
      merged.set(record.recordId, record)
    }
  }
  for (const record of extra) {
    const existing = merged.get(record.recordId)
    if (existing) {
      merged.set(record.recordId, {
        recordId: record.recordId,
        data: { ...existing.data, ...record.data },
      })
    } else {
      merged.set(record.recordId, record)
    }
  }
  return Array.from(merged.values())
}

async function computeDependentLookupRollupRecords(
  req: Request,
  query: QueryFn,
  // A-full (design #2410): the edited (source) sheet + its changed field ids gate which related
  // lookup/rollup fields count as "affected" for the one-hop formula recompute below.
  sourceSheetId: string,
  updatedRecordIds: string[],
  changedFieldIds: string[],
): Promise<RelatedComputedRecord[]> {
  if (updatedRecordIds.length === 0) return []

  let linkRes: { rows: unknown[] }
  try {
    linkRes = await query(
      'SELECT record_id FROM meta_links WHERE foreign_record_id = ANY($1::text[])',
      [updatedRecordIds],
    )
  } catch (err) {
    if (isUndefinedTableError(err, 'meta_links')) return []
    throw err
  }
  const recordIds = Array.from(new Set((linkRes.rows as any[]).map((row) => String(row.record_id))))
  if (recordIds.length === 0) return []

  const recordRes = await query(
    'SELECT id, sheet_id, data FROM meta_records WHERE id = ANY($1::text[])',
    [recordIds],
  )
  if (recordRes.rows.length === 0) return []

  const rowsBySheet = new Map<string, UniverMetaRecord[]>()
  for (const row of recordRes.rows as any[]) {
    const sheetId = String(row.sheet_id)
    const list = rowsBySheet.get(sheetId) ?? []
    list.push({
      id: String(row.id),
      version: 0,
      data: normalizeJson(row.data),
    })
    rowsBySheet.set(sheetId, list)
  }

  const sheetIds = Array.from(rowsBySheet.keys())
  if (sheetIds.length === 0) return []

  const fieldRes = await query(
    'SELECT id, sheet_id, name, type, property, \"order\" FROM meta_fields WHERE sheet_id = ANY($1::text[]) ORDER BY \"order\" ASC',
    [sheetIds],
  )

  const fieldsBySheet = new Map<string, UniverMetaField[]>()
  for (const row of fieldRes.rows as any[]) {
    const sheetId = String(row.sheet_id)
    const list = fieldsBySheet.get(sheetId) ?? []
    list.push(serializeFieldRow(row))
    fieldsBySheet.set(sheetId, list)
  }

  const allowedFieldIdsBySheet = new Map<string, Set<string>>()
  // ②b arc closeout — related-record write echoes are another cross-base read sink. Sheet-read
  // alone is not enough: mirror the link-summary base-read gate so PATCH and the A2 AI-shortcut
  // path cannot echo related ids or computed values from a base the caller cannot read.
  const sourceSheet = await loadSheetRowShared(query, sourceSheetId)
  const sourceBaseId = sourceSheet?.baseId ?? null
  for (const sheetId of rowsBySheet.keys()) {
    const relatedSheet = await loadSheetRowShared(query, sheetId)
    const relatedBaseId = relatedSheet?.baseId ?? null
    if (baseIdsAreCrossBase(sourceBaseId, relatedBaseId)) {
      const baseReadable = relatedBaseId != null && (await resolveBaseReadable(req, query, relatedBaseId))
      if (!baseReadable) continue
    }
    const fields = fieldsBySheet.get(sheetId) ?? []
    if (fields.length === 0) continue
    const { access, capabilities } = await resolveSheetReadableCapabilities(req, query, sheetId)
    if (!access.userId || !capabilities.canRead) continue
    const fieldScopeMap = await loadFieldPermissionScopeMap(query, sheetId, access.userId)
    allowedFieldIdsBySheet.set(sheetId, computeAllowedFieldIds(fields, capabilities, fieldScopeMap))
  }

  const results: RelatedComputedRecord[] = []
  for (const [sheetId, rows] of rowsBySheet.entries()) {
    const allowedFieldIds = allowedFieldIdsBySheet.get(sheetId)
    if (!allowedFieldIds) continue
    const fields = fieldsBySheet.get(sheetId) ?? []
    if (fields.length === 0) continue
    const hasComputed = fields.some((f) => f.type === 'lookup' || f.type === 'rollup')
    if (!hasComputed) continue

    const relationalLinkFields = fields
      .map((f) => (f.type === 'link' ? { fieldId: f.id, cfg: parseLinkFieldConfig(f.property) } : null))
      .filter((v): v is { fieldId: string; cfg: LinkFieldConfig } => !!v && !!v.cfg)

    const linkValuesByRecord = await loadLinkValuesByRecord(
      query,
      rows.map((r) => r.id),
      relationalLinkFields,
    )

    await applyLookupRollup(req, query, sheetId, fields, rows, relationalLinkFields, linkValuesByRecord)

    // A-full (design #2410): one-hop formula recompute on the related records. A related
    // lookup/rollup is "affected" only when it resolves to the edited source sheet, its
    // targetFieldId is one of the changed source fields, AND the record actually links to one
    // of the edited source records via that field's linkFieldId — an unrelated edit on the
    // foreign record must not rewrite formulas just because the record is linked (§3.3).
    const changedSourceFieldIds = new Set(changedFieldIds)
    const updatedSourceRecordIds = new Set(updatedRecordIds)
    const linkConfigById = new Map(relationalLinkFields.map(({ fieldId, cfg }) => [fieldId, cfg]))
    const affectedFieldIdsByRecord = new Map<string, Set<string>>()
    for (const field of fields) {
      if (field.type !== 'lookup' && field.type !== 'rollup') continue
      const cfg = field.type === 'lookup' ? parseLookupFieldConfig(field.property) : parseRollupFieldConfig(field.property)
      if (!cfg) continue
      const foreignSheetId = cfg.foreignSheetId ?? linkConfigById.get(cfg.linkFieldId)?.foreignSheetId
      if (foreignSheetId !== sourceSheetId) continue
      if (!changedSourceFieldIds.has(cfg.targetFieldId)) continue
      for (const row of rows) {
        const linkedIds =
          linkValuesByRecord.get(row.id)?.get(cfg.linkFieldId) ?? normalizeLinkIds(row.data[cfg.linkFieldId])
        if (!linkedIds.some((id) => updatedSourceRecordIds.has(id))) continue
        const set = affectedFieldIdsByRecord.get(row.id) ?? new Set<string>()
        set.add(field.id)
        affectedFieldIdsByRecord.set(row.id, set)
      }
    }

    let formulaDataByRecord = new Map<string, Record<string, unknown>>()
    if (affectedFieldIdsByRecord.size > 0) {
      const affectedComputedFieldIds = new Set<string>()
      for (const set of affectedFieldIdsByRecord.values()) {
        for (const id of set) affectedComputedFieldIds.add(id)
      }
      // Formula eval consumes the FULL hydrated row (row.data after applyLookupRollup), never
      // the permission-masked echo patch built below — recompute stays reader-agnostic (§3.2).
      // recalculateRecordFromData materializes ONLY formula keys; lookup/rollup remain
      // computed-on-read. One hop only: results never re-enter this propagation.
      const hydratedDataByRecord = new Map(rows.map((row) => [row.id, row.data]))
      const formulaRecords = await recalculateFormulaFields(
        req,
        query,
        sheetId,
        fields,
        Array.from(affectedFieldIdsByRecord.keys()),
        Array.from(affectedComputedFieldIds),
        hydratedDataByRecord,
      )
      formulaDataByRecord = new Map(formulaRecords.map((record) => [record.recordId, record.data]))
    }

    for (const row of rows) {
      const recomputedFormulaData = formulaDataByRecord.get(row.id)
      results.push({
        sheetId,
        recordId: row.id,
        data: filterRecordDataByFieldIds(
          { ...extractLookupRollupData(fields, row.data), ...(recomputedFormulaData ?? {}) },
          allowedFieldIds,
        ),
        affectedFieldIds: [
          ...(affectedFieldIdsByRecord.get(row.id) ?? []),
          ...Object.keys(recomputedFormulaData ?? {}),
        ],
      })
    }
  }

  return results
}

export function evaluateMetaFilterCondition(
  type: UniverMetaField['type'],
  cellValue: unknown,
  condition: MetaFilterCondition,
): boolean {
  const effectiveType = type === 'rollup' ? 'number' : type
  const op = condition.operator.trim()
  const opNorm = op.toLowerCase()
  const value = normalizeFilterScalar(condition.value)

  if (opNorm === 'isempty') return isNullishSortValue(cellValue)
  if (opNorm === 'isnotempty') return !isNullishSortValue(cellValue)

  if (isNumericQueryFieldType(effectiveType) || effectiveType === 'date') {
    const toComparable = effectiveType === 'date' ? toEpoch : toComparableNumber
    const left = toComparable(cellValue)
    const right = toComparable(value)

    if (opNorm === 'is' || opNorm === 'equal') return left !== null && right !== null && left === right
    if (opNorm === 'isnot' || opNorm === 'notequal') return left === null || right === null ? left !== right : left !== right
    if (opNorm === 'greater' || opNorm === 'isgreater') return left !== null && right !== null && left > right
    if (opNorm === 'greaterequal' || opNorm === 'isgreaterequal') return left !== null && right !== null && left >= right
    if (opNorm === 'less' || opNorm === 'isless') return left !== null && right !== null && left < right
    if (opNorm === 'lessequal' || opNorm === 'islessequal') return left !== null && right !== null && left <= right
    // Unrecognized operator on a numeric field → no-op (pre-existing catch-all). Accepted
    // reclassification effect: a `contains`/`doesNotContain` filter persisted on currency/
    // percent/rating BEFORE Slice 1 (when they fell back to the string operator set) now lands
    // here and shows all rows. The operator menu no longer offers text ops for these types, so
    // new filters can't reach this branch. See multitable-typed-query-polish-design-20260603.md.
    return true
  }

  if (effectiveType === 'boolean') {
    const left = toComparableBoolean(cellValue)
    const right = toComparableBoolean(value)
    if (opNorm === 'is' || opNorm === 'equal') return left !== null && right !== null && left === right
    if (opNorm === 'isnot' || opNorm === 'notequal') return left === null || right === null ? left !== right : left !== right
    return true
  }

  const left = toComparableString(cellValue)
  const right = toComparableString(value)
  const leftNorm = left.trim().toLowerCase()
  const rightNorm = right.trim().toLowerCase()

  if (opNorm === 'is' || opNorm === 'equal') return leftNorm === rightNorm
  if (opNorm === 'isnot' || opNorm === 'notequal') return leftNorm !== rightNorm
  if (opNorm === 'contains') return rightNorm === '' ? true : leftNorm.includes(rightNorm)
  if (opNorm === 'doesnotcontain') return rightNorm === '' ? true : !leftNorm.includes(rightNorm)
  return true
}

function toEpoch(value: unknown): number | null {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

const DASHBOARD_GROUPABLE_FIELD_TYPES = new Set<UniverMetaField['type']>([
  'string',
  'number',
  'boolean',
  'date',
  'dateTime',
  'formula',
  'select',
  'lookup',
  'rollup',
])

const DASHBOARD_NUMERIC_FIELD_TYPES = new Set<UniverMetaField['type']>([
  'number',
  'rollup',
])

const dashboardWidgetSchema = z.object({
  id: z.string().min(1).max(120).optional(),
  title: z.string().min(1).max(120),
  chartType: z.enum(['bar', 'line', 'pie']),
  groupByFieldId: z.string().min(1).max(120),
  metric: z.enum(['count', 'sum', 'avg']),
  valueFieldId: z.string().min(1).max(120).nullable().optional(),
  limit: z.number().int().min(1).max(24).optional(),
})

function serializeDashboardWidget(widget: DashboardWidgetInput): Required<Pick<DashboardWidgetInput, 'id' | 'title' | 'chartType' | 'groupByFieldId' | 'metric' | 'limit'>> & { valueFieldId: string | null } {
  return {
    id: typeof widget.id === 'string' && widget.id.trim().length > 0 ? widget.id.trim() : `dash_${randomUUID()}`,
    title: widget.title.trim(),
    chartType: widget.chartType,
    groupByFieldId: widget.groupByFieldId.trim(),
    metric: widget.metric,
    valueFieldId: typeof widget.valueFieldId === 'string' && widget.valueFieldId.trim().length > 0 ? widget.valueFieldId.trim() : null,
    limit: Number.isFinite(widget.limit) ? Math.min(Math.max(Math.round(widget.limit ?? 6), 1), 24) : 6,
  }
}

function normalizeDashboardBucketKey(value: unknown): string {
  if (value === null || value === undefined) return '__empty__'
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : '__empty__'
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? JSON.stringify(value.map((item) => toSummaryDisplay(item))) : '__empty__'
  }
  return JSON.stringify(value)
}

function normalizeDashboardBucketLabel(value: unknown): string {
  if (value === null || value === undefined) return 'Empty'
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (Array.isArray(value)) return value.length > 0 ? value.map((item) => toSummaryDisplay(item)).join(', ') : 'Empty'
  const text = toSummaryDisplay(value).trim()
  return text.length > 0 ? text : 'Empty'
}

function toDashboardMetricNumber(value: unknown): number | null {
  return toComparableNumber(value)
}

function getDbNotReadyMessage(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  const relationMissing = msg.includes('relation') && msg.includes('does not exist')
  const columnMissing = msg.includes('column') && msg.includes('does not exist')
  if (!relationMissing && !columnMissing) return null

  if (
    msg.includes('meta_bases') ||
    msg.includes('meta_sheets') ||
    msg.includes('meta_fields') ||
    msg.includes('meta_records') ||
    msg.includes('meta_record_revisions') ||
    msg.includes('meta_record_subscriptions') ||
    msg.includes('meta_record_subscription_notifications') ||
    msg.includes('meta_views') ||
    msg.includes('meta_links') ||
    msg.includes('plugin_multitable_object_registry') ||
    msg.includes('base_id')
  ) {
    return 'Database schema not ready (meta tables missing). Run `pnpm --filter @metasheet/core-backend migrate` and ensure `DATABASE_URL` points to the dev DB.'
  }

  return null
}

function isRecordCreateValidationError(err: unknown): err is { fieldErrors: unknown } {
  if (err instanceof RecordCreateValidationFailedError) return true
  if (!err || typeof err !== 'object') return false
  const candidate = err as { name?: unknown; fieldErrors?: unknown }
  return candidate.name === 'RecordValidationFailedError' && 'fieldErrors' in candidate
}

function normalizeRecordCreateFieldErrors(fieldErrors: unknown): Record<string, string> {
  if (Array.isArray(fieldErrors)) {
    const normalized: Record<string, string> = {}
    fieldErrors.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') return
      const error = entry as { fieldId?: unknown; message?: unknown }
      const fieldId = typeof error.fieldId === 'string' && error.fieldId.trim()
        ? error.fieldId.trim()
        : `field_${index + 1}`
      const message = typeof error.message === 'string' && error.message.trim()
        ? error.message.trim()
        : 'Validation failed'
      normalized[fieldId] = message
    })
    return normalized
  }

  if (fieldErrors && typeof fieldErrors === 'object') {
    return Object.fromEntries(
      Object.entries(fieldErrors as Record<string, unknown>)
        .map(([fieldId, message]) => [
          fieldId,
          typeof message === 'string' && message.trim() ? message.trim() : 'Validation failed',
        ]),
    )
  }

  return {}
}

function invalidateSheetSummaryCache(sheetId: string): void {
  metaSheetSummaryCache.delete(sheetId)
}

function invalidateFieldCache(sheetId: string): void {
  metaFieldCache.delete(sheetId)
}

function invalidateViewConfigCache(viewId?: string): void {
  if (typeof viewId === 'string' && viewId.trim().length > 0) {
    metaViewConfigCache.delete(viewId.trim())
    return
  }
  metaViewConfigCache.clear()
}

async function loadSheetSummary(
  pool: { query: QueryFn },
  sheetId: string,
): Promise<{ id: string; name: string } | null> {
  const cached = metaSheetSummaryCache.get(sheetId)
  if (cached) return cached

  const result = await pool.query(
    'SELECT id, name FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL',
    [sheetId],
  )
  if (result.rows.length === 0) return null

  const row: any = result.rows[0]
  const sheet = {
    id: String(row.id),
    name: String(row.name),
  }
  metaSheetSummaryCache.set(sheetId, sheet)
  return sheet
}

async function loadSheetFields(
  pool: { query: QueryFn },
  sheetId: string,
): Promise<UniverMetaField[]> {
  const cached = metaFieldCache.get(sheetId)
  if (cached) return cached

  const fieldRes = await pool.query(
    'SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC',
    [sheetId],
  )
  const fields = fieldRes.rows.map((f: any) => serializeFieldRow(f))
  metaFieldCache.set(sheetId, fields)
  return fields
}

async function tryResolveView(
  pool: { query: QueryFn },
  viewId: string,
): Promise<UniverMetaViewConfig | null> {
  return tryResolveViewShared(
    pool as { query: QueryFn },
    viewId,
    metaViewConfigCache as Map<string, SharedMultitableViewConfig>,
  )
}

function sendForbidden(res: Response, message = 'Insufficient permissions') {
  return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message } })
}

export async function requireRecordReadable(
  req: Request,
  query: QueryFn,
  sheetId: string,
  recordId: string,
): Promise<{
  access: ResolvedRequestAccess
  capabilities: MultitableCapabilities
  capabilityOrigin: MultitableCapabilityOrigin
  sheetScope?: SheetPermissionScope
} | { status: number; body: unknown }> {
  const recordCheck = await query(
    'SELECT id, sheet_id FROM meta_records WHERE id = $1 AND sheet_id = $2',
    [recordId, sheetId],
  )
  if (recordCheck.rows.length === 0) {
    return {
      status: 404,
      body: { ok: false, error: { code: 'NOT_FOUND', message: `Record not found: ${recordId}` } },
    }
  }

  const { access, capabilities, capabilityOrigin, sheetScope } = await resolveSheetReadableCapabilities(req, query, sheetId)
  if (!access.userId) {
    return { status: 401, body: { error: 'Authentication required' } }
  }
  if (!capabilities.canRead) {
    return {
      status: 403,
      body: { ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } },
    }
  }

  if (!access.isAdminRole) {
    const hasRecordPerms = await hasRecordPermissionAssignments(query, sheetId)
    if (hasRecordPerms) {
      const recordScopeMap = await loadRecordPermissionScopeMap(query, sheetId, [recordId], access.userId)
      if (recordScopeMap.size > 0 && !deriveRecordPermissions(recordId, capabilities, recordScopeMap).canRead) {
        return {
          status: 403,
          body: { ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } },
        }
      }
    }
  }

  return { access, capabilities, capabilityOrigin, ...(sheetScope ? { sheetScope } : {}) }
}

type FieldMutationGuard = {
  type: UniverMetaField['type']
  options?: string[]
  readOnly: boolean
  hidden: boolean
  link?: LinkFieldConfig | null
  /** Sanitized property — populated for field types whose write path needs config. */
  property?: Record<string, unknown>
}

function buildFieldMutationGuardMap(fields: UniverMetaField[]): Map<string, FieldMutationGuard> {
  return new Map(
    fields.map((field) => {
      const property = normalizeJson(field.property)
      const base: FieldMutationGuard = {
        type: field.type,
        readOnly: isFieldAlwaysReadOnly(field),
        hidden: isFieldPermissionHidden(field),
      }
      if (field.type === 'select' || field.type === 'multiSelect') {
        return [field.id, { ...base, options: field.options?.map((option) => option.value) ?? [] }] as const
      }
      if (field.type === 'link') {
        return [field.id, { ...base, link: parseLinkFieldConfig(property) }] as const
      }
      if (BATCH1_FIELD_TYPES.has(field.type)) {
        return [field.id, { ...base, property }] as const
      }
      return [field.id, base] as const
    }),
  )
}

function filterVisiblePropertyFields(fields: UniverMetaField[]): UniverMetaField[] {
  return fields.filter((field) => !isFieldPermissionHidden(field))
}

function filterRecordDataByFieldIds(data: unknown, allowedFieldIds: Set<string>): Record<string, unknown> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
  return Object.fromEntries(
    Object.entries(data as Record<string, unknown>).filter(([fieldId]) => allowedFieldIds.has(fieldId)),
  )
}

/**
 * A2 (design §2.2 seam decision): the req-scoped `RecordWriteHelpers` factory.
 * This COHERES the former inline `writeHelpers` literal from POST /patch into
 * the single source of truth consumed by BOTH /patch and the AI shortcut run
 * route (routes/multitable-ai.ts) — the helper bodies stay module-private
 * here; nothing is moved or copied.
 *
 * The `_pool` slot is part of the locked factory signature
 * (`createRecordWriteHelpers(req, pool)`); every helper receives its query
 * function per-call from RecordWriteService, so the pool is not consumed here.
 */
export function createRecordWriteHelpers(req: Request, _pool?: { query: QueryFn }): RecordWriteHelpers {
  return {
    normalizeLinkIds,
    normalizeAttachmentIds,
    normalizeJson,
    parseLinkFieldConfig,
    buildId,
    ensureRecordWriteAllowed,
    filterRecordDataByFieldIds,
    extractLookupRollupData,
    mergeComputedRecords,
    filterRecordFieldSummaryMap,
    serializeLinkSummaryMap,
    serializeAttachmentSummaryMap,
    applyLookupRollup: (q, sid, f, rows, rl, lv) => applyLookupRollup(req, q, sid, f, rows, rl, lv),
    computeDependentLookupRollupRecords: (q, sourceSheetId, ids, changed) =>
      computeDependentLookupRollupRecords(req, q, sourceSheetId, ids, changed),
    recalculateFormulaFields: (q, sid, f, ids, changed, hydrated) =>
      recalculateFormulaFields(req, q, sid, f, ids, changed, hydrated),
    loadLinkValuesByRecord,
    buildLinkSummaries: (q, sourceSheetId, rows, rl, lv) => buildLinkSummaries(req, q, sourceSheetId, rows, rl, lv),
    buildAttachmentSummaries: (q, sid, rows, af) => buildAttachmentSummaries(q, req, sid, rows, af),
    ensureAttachmentIdsExist,
    loadSheetMemberUserIds: (q, sid) => loadSheetMemberUserIdSet(q, sid),
  }
}

/**
 * A2: the field/permission context POST /patch composes before delegating to
 * `RecordWriteService.patchRecords` — extracted so the AI shortcut run route
 * consumes the IDENTICAL construction (single source of truth; /patch behavior
 * unchanged). Returns null when the sheet has no fields (the /patch 404).
 *
 * F3 (#2106 §3 F3): `readableEchoFields` is the layer-2 ∧ layer-3 readable
 * set used ONLY for the read-back echo (RecordWriteService masks record /
 * related / formula data + summaries with it) — a field_permissions-denied
 * value must never be echoed. `fieldById` (the write gate) stays built from
 * ALL fields so a write-only-no-read field remains writable. `fieldPermissions`
 * exposes the same layer-2 ∧ layer-3 derive for callers that need a layer-3
 * pre-check (A2 target-editable — patchRecords itself never executes the
 * layer-3 write gate).
 */
export interface RecordPatchRouteContext {
  fields: UniverMetaField[]
  readableEchoFields: UniverMetaField[]
  readableEchoFieldIds: Set<string>
  attachmentFields: UniverMetaField[]
  fieldById: Map<string, FieldMutationGuard>
  fieldPermissions: Record<string, MultitableFieldPermission>
}

export async function buildRecordPatchContext(
  req: Request,
  query: QueryFn,
  sheetId: string,
  access: ResolvedRequestAccess,
  capabilities: MultitableCapabilities,
): Promise<RecordPatchRouteContext | null> {
  const fieldRes = await query(
    'SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC',
    [sheetId],
  )
  if (fieldRes.rows.length === 0) return null

  const fields = (fieldRes.rows as any[]).map(serializeFieldRow)
  const visiblePropertyFields = filterVisiblePropertyFields(fields)
  const echoFieldScopeMap = access.userId
    ? await loadFieldPermissionScopeMap(query, sheetId, access.userId)
    : new Map<string, FieldPermissionScope>()
  const fieldPermissions = deriveFieldPermissions(visiblePropertyFields, capabilities, {
    hiddenFieldIds: [],
    fieldScopeMap: echoFieldScopeMap,
  })
  const echoVisibleFields = visiblePropertyFields.filter((field) => fieldPermissions[field.id]?.visible !== false)
  // §2a.3 read/JSON taint mask via the single CHOKEPOINT (maskStoredRecordFieldIds): the
  // RecordWriteService masks the bulk-PATCH echo (record / related / formula data) with this set over
  // re-read stored meta_records.data, so a formula over a denied foreign lookup must be dropped here so
  // its materialized value cannot be echoed back to a foreign-field-denied actor. Shared with the AI
  // shortcut run route, so BOTH echo consumers inherit the taint drop from this single source.
  const readableEchoFieldIds = await maskStoredRecordFieldIds(
    req,
    query,
    sheetId,
    echoVisibleFields,
    new Set(echoVisibleFields.map((field) => field.id)),
  )
  const readableEchoFields = echoVisibleFields.filter((field) => readableEchoFieldIds.has(field.id))
  const attachmentFields = readableEchoFields.filter((field) => field.type === 'attachment')
  const fieldById = buildFieldMutationGuardMap(fields)

  return { fields, readableEchoFields, readableEchoFieldIds, attachmentFields, fieldById, fieldPermissions }
}

function redactRecordRevisionEntry(item: RecordRevisionEntry, allowedFieldIds: Set<string>): RecordRevisionEntry {
  return {
    ...item,
    changedFieldIds: item.changedFieldIds.filter((fieldId) => allowedFieldIds.has(fieldId)),
    patch: filterRecordDataByFieldIds(item.patch, allowedFieldIds),
    snapshot: item.snapshot === null ? null : filterRecordDataByFieldIds(item.snapshot, allowedFieldIds),
  }
}

// #2052 (b): the layer-2 ∧ layer-3 allowed-field set (the #2015 composite, hiddenFieldIds: [] — layer-1
// excluded). Reused as the redaction gate for view-config filter literals.
function computeAllowedFieldIds(fields: UniverMetaField[], capabilities: MultitableCapabilities, fieldScopeMap: Map<string, FieldPermissionScope>): Set<string> {
  const visible = filterVisiblePropertyFields(fields)
  const perms = deriveFieldPermissions(visible, capabilities, { hiddenFieldIds: [], fieldScopeMap })
  return new Set(visible.filter((field) => perms[field.id]?.visible !== false).map((field) => field.id))
}

// #2052 (b): load the allowed-field set for a (sheet, subject). No subject / no sheet → EMPTY set =
// FAIL CLOSED (anonymous/unscoped callers redact every filter literal — never the authenticated
// "empty map ⇒ no denials ⇒ show all" default, which would fail open on public/base-only paths).
async function loadAllowedFieldIds(query: QueryFn, sheetId: string | null | undefined, userId: string | null | undefined, capabilities: MultitableCapabilities): Promise<Set<string>> {
  if (!userId || !sheetId) return new Set()
  const [fields, fieldScopeMap] = await Promise.all([
    loadFieldsForSheet(query, sheetId),
    loadFieldPermissionScopeMap(query, sheetId, userId),
  ])
  return computeAllowedFieldIds(fields, capabilities, fieldScopeMap)
}

// #2052 (b): PURE — returns a redacted COPY (view configs are cached/shared; never mutate in place, or a
// per-user redaction corrupts a later cross-user read). For each filterInfo condition on a field NOT in
// allowedFieldIds, OMIT the `value` key (keep fieldId+operator so the client can still render the chip);
// sortInfo/groupInfo/config carry only fieldIds (not literals) → untouched. Returns the input unchanged
// when nothing needs redacting (still never mutated).
function redactViewConfigFilterLiterals<T extends { filterInfo?: unknown } | null | undefined>(view: T, allowedFieldIds: Set<string>): T {
  if (!view || typeof view !== 'object') return view
  const filterInfo = (view as { filterInfo?: unknown }).filterInfo
  if (!filterInfo || typeof filterInfo !== 'object' || !Array.isArray((filterInfo as { conditions?: unknown }).conditions)) return view
  const conditions = (filterInfo as { conditions: Array<Record<string, unknown>> }).conditions
  const isDenied = (c: Record<string, unknown>) =>
    typeof c?.fieldId === 'string' && !allowedFieldIds.has(c.fieldId) && Object.prototype.hasOwnProperty.call(c, 'value')
  if (!conditions.some(isDenied)) return view
  const redactedConditions = conditions.map((c) => {
    if (!isDenied(c)) return c
    const { value: _omitted, ...rest } = c // omit the literal; keep fieldId + operator
    return rest
  })
  return { ...(view as object), filterInfo: { ...(filterInfo as object), conditions: redactedConditions } } as T
}

// #2068 re-save guard: PURE merge of an incoming PATCH filterInfo against the current DB filterInfo, so a
// field-denied user re-saving a view (whose denied conditions came back from #2059 redaction with NO `value`
// key) does not silently erase the literal they were never allowed to see. Value-only, mirroring #2059 —
// only filterInfo.conditions[].value is ever preserved; sortInfo/groupInfo/config/operator/fieldId pass through.
// Matches by array-index + (fieldId, operator) (no stable condition IDs); rejects on structural mismatch
// rather than guess. Returns null on structural mismatch so the route can answer 400 (never persist a missing literal).
function mergeRedactedFilterInfoForUpdate(incoming: Record<string, unknown>, current: unknown, allowedFieldIds: Set<string>): Record<string, unknown> | null {
  if (!Array.isArray((incoming as { conditions?: unknown }).conditions)) {
    return incoming // not a conditions-bearing filter → nothing to preserve
  }
  const incomingConditions = (incoming as { conditions: Array<Record<string, unknown>> }).conditions
  const currentConditions = (current && typeof current === 'object' && Array.isArray((current as { conditions?: unknown }).conditions))
    ? (current as { conditions: Array<Record<string, unknown>> }).conditions
    : []
  const merged: Array<Record<string, unknown>> = []
  for (let i = 0; i < incomingConditions.length; i++) {
    const c = incomingConditions[i]
    if (!c || typeof c !== 'object' || Array.isArray(c)) return null // malformed condition (null/non-object) → reject (route → 400), never a 500 or persisted garbage
    const fieldId = typeof c.fieldId === 'string' ? c.fieldId : null
    const allowed = fieldId !== null && allowedFieldIds.has(fieldId)
    const hasValue = !!c && typeof c === 'object' && Object.prototype.hasOwnProperty.call(c, 'value')
    if (allowed || hasValue) { merged.push(c); continue } // allowed field, or explicit value (incl. denied) → trust incoming
    // denied field with NO value key → must restore from the same-index current condition or reject.
    const cur = currentConditions[i]
    const sameShape = !!cur && typeof cur === 'object' && cur.fieldId === c.fieldId && cur.operator === c.operator
    if (!sameShape) return null // structural mismatch → reject (route answers 400; never persist a missing literal)
    if (Object.prototype.hasOwnProperty.call(cur, 'value')) merged.push({ ...c, value: (cur as { value?: unknown }).value }) // restore the literal
    else merged.push(c) // current is also unary (no value) → nothing to protect; keep as-is
  }
  return { ...incoming, conditions: merged }
}

async function loadXlsxModule(): Promise<XlsxModule> {
  return await import('xlsx') as unknown as XlsxModule
}

function parseJsonFormField(value: unknown, fieldName: string): unknown {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new ValidationError(`${fieldName} must be valid JSON`)
  }
}

function buildXlsxAttachmentFilename(sheetName: string): string {
  const base = sheetName.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'multitable'
  return `${base}.xlsx`
}

async function loadDashboardSourceRows(args: {
  req: Request
  query: QueryFn
  sheetId: string
  viewConfig: UniverMetaViewConfig | null
  fields: UniverMetaField[]
  visibleFields: UniverMetaField[]
  widgets: Array<ReturnType<typeof serializeDashboardWidget>>
  access: ResolvedRequestAccess
  capabilities: MultitableCapabilities
}): Promise<UniverMetaRecord[]> {
  const { req, query, sheetId, viewConfig, fields, visibleFields, widgets, access, capabilities } = args
  const recordRes = await query(
    'SELECT id, version, data, created_at FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC',
    [sheetId],
  )

  let rows = recordRes.rows.map((row: any) => ({
    id: String(row.id),
    version: Number(row.version ?? 1),
    data: normalizeJson(row.data),
    createdAt: row.created_at as unknown,
  }))

  // §2a.3 taint mask via the single CHOKEPOINT (maskStoredRecordFieldIds): dashboard widgets
  // group/aggregate over row.data raw, so a formula over a denied foreign lookup would leak its
  // materialized value as a group-by bucket label (and into count-family aggregates). The chokepoint
  // drops tainted formula fields from the visible set before the per-row data-mask below, so the
  // value never reaches the widget builder.
  const visibleFieldIds = await maskStoredRecordFieldIds(
    req,
    query,
    sheetId,
    visibleFields,
    new Set(visibleFields.map((field) => field.id)),
  )
  const fieldTypeById = new Map(visibleFields.map((field) => [field.id, field.type] as const))
  const rawFilterInfo = viewConfig ? parseMetaFilterInfo(viewConfig.filterInfo) : null
  const filteredConditions = rawFilterInfo
    ? rawFilterInfo.conditions.filter((condition) => fieldTypeById.has(condition.fieldId))
    : []
  const filterInfo = filteredConditions.length > 0 && rawFilterInfo
    ? { ...rawFilterInfo, conditions: filteredConditions }
    : null

  const relationalLinkFields = fields
    .map((field) => (field.type === 'link' ? { fieldId: field.id, cfg: parseLinkFieldConfig(field.property) } : null))
    .filter((value): value is { fieldId: string; cfg: LinkFieldConfig } => !!value && !!value.cfg)
  const computedFieldIds = new Set(
    fields.filter((field) => field.type === 'lookup' || field.type === 'rollup').map((field) => field.id),
  )
  const widgetFieldIds = new Set<string>()
  for (const widget of widgets) {
    widgetFieldIds.add(widget.groupByFieldId)
    if (widget.valueFieldId) widgetFieldIds.add(widget.valueFieldId)
  }
  const needsComputedFields =
    Array.from(widgetFieldIds).some((fieldId) => computedFieldIds.has(fieldId)) ||
    (filterInfo?.conditions ?? []).some((condition) => computedFieldIds.has(condition.fieldId))

  if (needsComputedFields && rows.length > 0) {
    const linkValuesByRecord = await loadLinkValuesByRecord(
      query,
      rows.map((row) => row.id),
      relationalLinkFields,
    )
    await applyLookupRollup(req, query, sheetId, fields, rows, relationalLinkFields, linkValuesByRecord)
  }

  if (filterInfo) {
    rows = rows.filter((record) => {
      const matches = (condition: MetaFilterCondition) => {
        const fieldType = fieldTypeById.get(condition.fieldId)
        if (!fieldType) return true
        return evaluateMetaFilterCondition(fieldType, record.data[condition.fieldId], condition)
      }
      return filterInfo.conjunction === 'or'
        ? filterInfo.conditions.some(matches)
        : filterInfo.conditions.every(matches)
    })
  }

  if (!access.isAdminRole && access.userId && rows.length > 0) {
    const hasRecordPerms = await hasRecordPermissionAssignments(query, sheetId)
    if (hasRecordPerms) {
      const recordScopeMap = await loadRecordPermissionScopeMap(
        query,
        sheetId,
        rows.map((row) => row.id),
        access.userId,
      )
      if (recordScopeMap.size > 0) {
        rows = rows.filter((row) => deriveRecordPermissions(row.id, capabilities, recordScopeMap).canRead)
      }
    }
  }

  return rows.map((row) => ({
    ...row,
    data: filterRecordDataByFieldIds(row.data, visibleFieldIds),
  }))
}

function buildDashboardWidgetResult(args: {
  widget: ReturnType<typeof serializeDashboardWidget>
  rows: UniverMetaRecord[]
  fields: UniverMetaField[]
}): DashboardWidgetResult {
  const { widget, rows, fields } = args
  const fieldById = new Map(fields.map((field) => [field.id, field] as const))
  const groupField = fieldById.get(widget.groupByFieldId) ?? null
  const valueField = widget.valueFieldId ? fieldById.get(widget.valueFieldId) ?? null : null

  const buckets = new Map<string, { key: string; label: string; sum: number; count: number; recordCount: number }>()
  for (const row of rows) {
    const rawGroupValue = row.data[widget.groupByFieldId]
    const bucketKey = normalizeDashboardBucketKey(rawGroupValue)
    const bucketLabel = normalizeDashboardBucketLabel(rawGroupValue)
    const bucket = buckets.get(bucketKey) ?? {
      key: bucketKey,
      label: bucketLabel,
      sum: 0,
      count: 0,
      recordCount: 0,
    }
    bucket.recordCount += 1
    if (widget.metric === 'count') {
      bucket.sum += 1
      bucket.count += 1
    } else {
      const numericValue = widget.valueFieldId ? toDashboardMetricNumber(row.data[widget.valueFieldId]) : null
      if (numericValue !== null) {
        bucket.sum += numericValue
        bucket.count += 1
      }
    }
    buckets.set(bucketKey, bucket)
  }

  let points: DashboardDataPoint[] = Array.from(buckets.values()).map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    value: widget.metric === 'avg'
      ? (bucket.count > 0 ? bucket.sum / bucket.count : 0)
      : bucket.sum,
    recordCount: bucket.recordCount,
  }))

  if (widget.chartType === 'line') {
    points = points.sort((left, right) => {
      if (groupField?.type === 'date') {
        const leftEpoch = toEpoch(left.key)
        const rightEpoch = toEpoch(right.key)
        if (leftEpoch !== null && rightEpoch !== null && leftEpoch !== rightEpoch) return leftEpoch - rightEpoch
      }
      if (groupField?.type === 'number' || groupField?.type === 'rollup') {
        const leftNumber = toComparableNumber(left.key)
        const rightNumber = toComparableNumber(right.key)
        if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber) return leftNumber - rightNumber
      }
      return left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: 'base' })
    })
  } else {
    points = points.sort((left, right) => {
      if (right.value !== left.value) return right.value - left.value
      return left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: 'base' })
    })
  }

  points = points.slice(0, widget.limit)

  return {
    ...widget,
    groupByFieldName: groupField?.name ?? null,
    valueFieldId: widget.valueFieldId,
    valueFieldName: valueField?.name ?? null,
    totalRecords: rows.length,
    totalValue: points.reduce((sum, point) => sum + point.value, 0),
    points,
  }
}

function filterRecordFieldSummaryMap<T>(
  summaryMap: Record<string, Record<string, T>> | undefined,
  allowedFieldIds: Set<string>,
): Record<string, Record<string, T>> | undefined {
  if (!summaryMap) return undefined
  return Object.fromEntries(
    Object.entries(summaryMap).map(([recordId, fieldSummaries]) => [
      recordId,
      Object.fromEntries(
        Object.entries(fieldSummaries).filter(([fieldId]) => allowedFieldIds.has(fieldId)),
      ),
    ]),
  )
}

function filterSingleRecordFieldSummaryMap<T>(
  summaryMap: Record<string, T> | undefined,
  allowedFieldIds: Set<string>,
): Record<string, T> | undefined {
  if (!summaryMap) return undefined
  return Object.fromEntries(
    Object.entries(summaryMap).filter(([fieldId]) => allowedFieldIds.has(fieldId)),
  )
}

function toSummaryDisplay(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null || value === undefined) return ''
  return JSON.stringify(value)
}

function getAttachmentStorageService(): StorageServiceImpl {
  if (!multitableAttachmentStorage) {
    const baseUrl = process.env.ATTACHMENT_STORAGE_BASE_URL || 'http://localhost:8900/files'
    multitableAttachmentStorage = StorageServiceImpl.createLocalService(ATTACHMENT_PATH, baseUrl)
  }
  return multitableAttachmentStorage
}

function getRequestActorId(req: Request): string | null {
  const actorId = req.user?.id
  return typeof actorId === 'string' && actorId.trim().length > 0 ? actorId.trim() : null
}

function publishMultitableSheetRealtime(payload: MultitableSheetRealtimePayload): void {
  // Delegate to the shared module (extracted for reuse by future Yjs bridge)
  publishMultitableSheetRealtimeShared(payload as SharedRealtimePayload)
}

function isImageMimeType(mimeType: string | null | undefined): boolean {
  return typeof mimeType === 'string' && mimeType.toLowerCase().startsWith('image/')
}

const serializeAttachmentRow = serializeAttachmentRowShared

function serializeBaseRow(row: any): UniverMetaBase {
  return {
    id: String(row.id),
    name: String(row.name),
    icon: typeof row.icon === 'string' ? row.icon : null,
    color: typeof row.color === 'string' ? row.color : null,
    ownerId: typeof row.owner_id === 'string' ? row.owner_id : null,
    workspaceId: typeof row.workspace_id === 'string' ? row.workspace_id : null,
  }
}

const ensureLegacyBase = ensureLegacyBaseShared

async function ensurePeopleSheetPreset(query: QueryFn, baseId: string): Promise<PeopleSheetPreset> {
  const existingSheets = await query(
    `SELECT id, base_id, name, description
     FROM meta_sheets
     WHERE base_id = $1 AND deleted_at IS NULL
     ORDER BY created_at ASC`,
    [baseId],
  )

  let peopleSheetRow = (existingSheets.rows as any[]).find((row) => isSystemPeopleSheetDescription(row.description)) ?? null
  let peopleSheetId = typeof peopleSheetRow?.id === 'string' ? String(peopleSheetRow.id) : buildId('sheet').slice(0, 50)

  if (!peopleSheetRow) {
    await query(
      `INSERT INTO meta_sheets (id, base_id, name, description)
       VALUES ($1, $2, $3, $4)`,
      [peopleSheetId, baseId, SYSTEM_PEOPLE_SHEET_NAME, SYSTEM_PEOPLE_SHEET_DESCRIPTION],
    )
    peopleSheetRow = {
      id: peopleSheetId,
      base_id: baseId,
      name: SYSTEM_PEOPLE_SHEET_NAME,
      description: SYSTEM_PEOPLE_SHEET_DESCRIPTION,
    }
  }

  const fieldRows = await query(
    'SELECT id, name, type, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC',
    [peopleSheetId],
  )
  const fieldIdByName = new Map<string, string>()
  for (const row of fieldRows.rows as any[]) {
    const name = typeof row.name === 'string' ? row.name.trim() : ''
    const id = typeof row.id === 'string' ? row.id : ''
    if (name && id && !fieldIdByName.has(name)) fieldIdByName.set(name, id)
  }

  const ensureField = async (name: string, order: number): Promise<string> => {
    const existingId = fieldIdByName.get(name)
    if (existingId) return existingId
    const id = buildId('fld').slice(0, 50)
    await query(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order")
       VALUES ($1, $2, $3, 'string', '{}'::jsonb, $4)`,
      [id, peopleSheetId, name, order],
    )
    fieldIdByName.set(name, id)
    return id
  }

  const userIdFieldId = await ensureField('User ID', 0)
  const nameFieldId = await ensureField('Name', 1)
  const emailFieldId = await ensureField('Email', 2)
  const avatarFieldId = await ensureField('Avatar URL', 3)

  let userRows: Array<{ id: string; email: string; name: string | null; avatar_url: string | null }> = []
  try {
    const result = await query(
      `SELECT id, email, name, avatar_url
       FROM users
       WHERE is_active = TRUE
       ORDER BY created_at ASC, id ASC`,
    )
    userRows = (result.rows as any[]).map((row) => ({
      id: String(row.id),
      email: String(row.email),
      name: typeof row.name === 'string' ? row.name : null,
      avatar_url: typeof row.avatar_url === 'string' ? row.avatar_url : null,
    }))
  } catch (err: any) {
    if (!(typeof err?.code === 'string' && err.code === '42P01')) {
      throw err
    }
  }

  if (userRows.length > 0) {
    const existingRecords = await query(
      'SELECT id, data FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC',
      [peopleSheetId],
    )
    const recordByUserId = new Map<string, { id: string; data: Record<string, unknown> }>()
    for (const row of existingRecords.rows as any[]) {
      const data = normalizeJson(row.data)
      const userId = typeof data[userIdFieldId] === 'string' ? String(data[userIdFieldId]) : ''
      if (userId) {
        recordByUserId.set(userId, { id: String(row.id), data })
      }
    }

    for (const user of userRows) {
      const nextData = {
        [userIdFieldId]: user.id,
        [nameFieldId]: user.name?.trim() || user.email,
        [emailFieldId]: user.email,
        [avatarFieldId]: user.avatar_url ?? '',
      }
      const existing = recordByUserId.get(user.id)
      if (!existing) {
        await query(
          `INSERT INTO meta_records (id, sheet_id, data, version)
           VALUES ($1, $2, $3::jsonb, 1)`,
          [buildId('rec').slice(0, 50), peopleSheetId, JSON.stringify(nextData)],
        )
        continue
      }

      const changed =
        existing.data[userIdFieldId] !== nextData[userIdFieldId] ||
        existing.data[nameFieldId] !== nextData[nameFieldId] ||
        existing.data[emailFieldId] !== nextData[emailFieldId] ||
        existing.data[avatarFieldId] !== nextData[avatarFieldId]

      if (changed) {
        // lock-exempt: internal people-directory sync — system sheet, not a user-facing record edit path.
        await query(
          `UPDATE meta_records
           SET data = $1::jsonb, version = version + 1, updated_at = now()
           WHERE id = $2`,
          [JSON.stringify(nextData), existing.id],
        )
      }
    }
  }

  return {
    sheet: {
      id: peopleSheetId,
      baseId,
      name: SYSTEM_PEOPLE_SHEET_NAME,
      description: SYSTEM_PEOPLE_SHEET_DESCRIPTION,
    },
    fieldProperty: {
      foreignSheetId: peopleSheetId,
      limitSingleRecord: true,
      refKind: 'user',
    },
  }
}

async function normalizeFieldWriteInput(
  query: QueryFn,
  _sheetId: string,
  requestedType: MultitableFieldInputType | UniverMetaField['type'],
  rawProperty: unknown,
): Promise<{ type: UniverMetaField['type']; property: Record<string, unknown> }> {
  // Native person (人员, design 2026-06-16): `type:'person'` is now a FIRST-CLASS native
  // field stored as `type='person'` (userId[]) — it flows through the generic branch and is
  // NO LONGER rewritten to a `link`+refKind:user against the system People sheet. This is the
  // default for newly-created person fields.
  //
  // COEXISTENCE: existing legacy person fields are persisted as `type='link'`+refKind:user
  // and are untouched — they keep rendering/behaving as people. `ensurePeopleSheetPreset` and
  // the `/person-fields/prepare` route stay intact (now vestigial for the FE create path, but
  // preserved for legacy fields + direct API callers who still want the link-backed shape).
  //
  // The `query`/`_sheetId` params are retained for signature stability with the route call
  // sites and any future per-type async normalization.
  void query
  return {
    type: requestedType as UniverMetaField['type'],
    property: sanitizeFieldProperty(requestedType as UniverMetaField['type'], rawProperty),
  }
}

const loadSheetRow = loadSheetRowShared
const loadFieldsForSheet = loadFieldsForSheetShared

async function ensureAttachmentIdsExist(
  query: QueryFn,
  sheetId: string,
  fieldId: string,
  attachmentIds: string[],
): Promise<string | null> {
  return ensureAttachmentIdsExistShared({ query, sheetId, fieldId, attachmentIds })
}

async function buildLinkSummaries(
  req: Request,
  query: QueryFn,
  sourceSheetId: string,
  rows: UniverMetaRecord[],
  relationalLinkFields: RelationalLinkField[],
  linkValuesByRecord: Map<string, Map<string, string[]>>,
): Promise<Map<string, Map<string, LinkedRecordSummary[]>>> {
  const result = new Map<string, Map<string, LinkedRecordSummary[]>>()
  if (rows.length === 0 || relationalLinkFields.length === 0) return result

  const idsBySheet = new Map<string, Set<string>>()
  for (const { cfg } of relationalLinkFields) {
    idsBySheet.set(cfg.foreignSheetId, idsBySheet.get(cfg.foreignSheetId) ?? new Set<string>())
  }

  for (const row of rows) {
    const recordLinks = linkValuesByRecord.get(row.id)
    if (!recordLinks) continue
    for (const { fieldId, cfg } of relationalLinkFields) {
      const ids = recordLinks.get(fieldId) ?? []
      const set = idsBySheet.get(cfg.foreignSheetId) ?? new Set<string>()
      for (const id of ids) set.add(id)
      idsBySheet.set(cfg.foreignSheetId, set)
    }
  }

  const readableSheetIds = await resolveReadableSheetIds(req, query, idsBySheet.keys())

  // ②b §3.2 Sink B-1 — base-read COARSE gate on the inline link summaries. resolveReadableSheetIds
  // only checks SHEET-level read, so a sheet-readable-but-base-unreadable actor could enumerate a
  // cross-base foreign sheet's records (id + display) via every summary consumer (/view, single-record
  // read, write-echo). For each CROSS-BASE foreign sheet (foreign base ≠ source base), require
  // resolveBaseReadable; failure DROPS it from readableSheetIds, so the existing :3611 gate masks the
  // summary AND the display-field load + foreign-record load below skip it (one gate, all consumers,
  // no wasted loads). Same-base is untouched; a null foreign base is unreadable (mask) and crash-safe.
  // Decision (d): silent mask here (omit summaries) — the explicit pull endpoint 403s separately.
  const sourceSheet = await loadSheetRowShared(query, sourceSheetId)
  const sourceBaseId = sourceSheet?.baseId ?? null
  for (const foreignSheetId of Array.from(readableSheetIds)) {
    const foreignSheet = await loadSheetRowShared(query, foreignSheetId)
    const foreignBaseId = foreignSheet?.baseId ?? null
    if (!baseIdsAreCrossBase(sourceBaseId, foreignBaseId)) continue
    const baseReadable = foreignBaseId != null && (await resolveBaseReadable(req, query, foreignBaseId))
    if (!baseReadable) readableSheetIds.delete(foreignSheetId)
  }

  // F5-followup (#2106): the foreign-record `display` echoed in link summaries is the value of the foreign
  // sheet's default display field. resolveReadableSheetIds gates SHEET-level read, but the display field
  // itself can be field_permissions.visible=false for this caller — so pick it only from the foreign sheet's
  // OWN layer-2 ∧ layer-3 allowed set (keyed to that sheet + the requester, the crossSheetRelated per-sheet
  // rule). Otherwise the denied value leaks via every buildLinkSummaries consumer (/view, single-record read,
  // link-options `selected`, write-echo). Selecting only from allowed fields makes the value read at the
  // displayValue line below inherently safe.
  const displayFieldBySheet = new Map<string, string | null>()
  for (const [sheetId] of idsBySheet.entries()) {
    if (!readableSheetIds.has(sheetId)) continue
    const fields = await loadFieldsForSheet(query, sheetId)
    const { access, capabilities } = await resolveSheetReadableCapabilities(req, query, sheetId)
    const baseAllowedFieldIds = await loadAllowedFieldIds(query, sheetId, access.userId, capabilities)
    // §2a.3 DISPLAY-PROJECTION chokepoint (resolveDisplayFieldTaint) — C2 (link-summary auto-pick):
    // the auto-picked foreign display field is projected over stored data; a foreign formula over a
    // (further) denied lookup is source-visible and could be auto-picked when there is no string field
    // ahead of it, leaking its materialized value as the link display. Drop tainted foreign formula
    // ids from the candidate set so they are never selectable here.
    const { allowedDisplayFieldIds: allowedFieldIds } = await resolveDisplayFieldTaint(
      req,
      query,
      sheetId,
      fields,
      baseAllowedFieldIds,
      null,
    )
    const allowedFields = fields.filter((field) => allowedFieldIds.has(field.id))
    const stringField = allowedFields.find((field) => field.type === 'string')
    displayFieldBySheet.set(sheetId, stringField?.id ?? allowedFields[0]?.id ?? null)
  }

  const foreignRecordsBySheet = new Map<string, Map<string, Record<string, unknown>>>()
  for (const [sheetId, ids] of idsBySheet.entries()) {
    if (!readableSheetIds.has(sheetId)) continue
    const idList = Array.from(ids)
    if (idList.length === 0) continue
    const recordRes = await query(
      'SELECT id, data FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])',
      [sheetId, idList],
    )
    const recordMap = new Map<string, Record<string, unknown>>()
    for (const row of recordRes.rows as any[]) {
      recordMap.set(String(row.id), normalizeJson(row.data))
    }
    foreignRecordsBySheet.set(sheetId, recordMap)
  }

  for (const row of rows) {
    const byField = new Map<string, LinkedRecordSummary[]>()
    const recordLinks = linkValuesByRecord.get(row.id) ?? new Map<string, string[]>()
    for (const { fieldId, cfg } of relationalLinkFields) {
      const ids = recordLinks.get(fieldId) ?? []
      if (!readableSheetIds.has(cfg.foreignSheetId)) {
        byField.set(fieldId, [])
        continue
      }
      const foreignMap = foreignRecordsBySheet.get(cfg.foreignSheetId)
      const displayFieldId = displayFieldBySheet.get(cfg.foreignSheetId) ?? null
      const summaries: LinkedRecordSummary[] = ids.map((id) => {
        const data = foreignMap?.get(id) ?? {}
        const displayValue = displayFieldId ? data[displayFieldId] : undefined
        return {
          id,
          display: toSummaryDisplay(displayValue),
        }
      })
      byField.set(fieldId, summaries)
    }
    result.set(row.id, byField)
  }

  return result
}

function serializeLinkSummaryMap(
  linkSummaries: Map<string, Map<string, LinkedRecordSummary[]>>,
): Record<string, Record<string, LinkedRecordSummary[]>> {
  return Object.fromEntries(
    Array.from(linkSummaries.entries()).map(([recordId, fieldMap]) => [
      recordId,
      Object.fromEntries(Array.from(fieldMap.entries()).map(([fieldId, summaries]) => [fieldId, summaries])),
    ]),
  )
}

async function buildAttachmentSummaries(
  query: QueryFn,
  req: Request,
  sheetId: string,
  rows: UniverMetaRecord[],
  attachmentFields: UniverMetaField[],
): Promise<Map<string, Map<string, MultitableAttachment[]>>> {
  return buildAttachmentSummariesShared({ query, req, sheetId, rows, attachmentFields })
}

/**
 * Native person (人员, design 2026-06-16) display assembly. For each person field's
 * `userId[]` cell, resolve a `{ id: userId, display }` summary from the `users` table
 * (name → email → id fallback) — ONE query for all userIds across all person fields,
 * parallel to buildLinkSummaries (no FE per-userId fetch / N+1). The native person value
 * carries no linkSummaries, so the renderer reads THIS to draw the people chips.
 */
async function buildPersonSummaries(
  query: QueryFn,
  rows: UniverMetaRecord[],
  personFields: UniverMetaField[],
): Promise<Map<string, Map<string, PersonSummary[]>>> {
  const result = new Map<string, Map<string, PersonSummary[]>>()
  if (personFields.length === 0 || rows.length === 0) return result

  const personFieldIds = personFields.map((f) => f.id)
  const userIds = new Set<string>()
  for (const row of rows) {
    for (const fieldId of personFieldIds) {
      const value = row.data[fieldId]
      if (!Array.isArray(value)) continue
      for (const item of value) {
        if (typeof item === 'string' && item.trim()) userIds.add(item.trim())
      }
    }
  }
  if (userIds.size === 0) return result

  const displayByUserId = new Map<string, string>()
  try {
    const usersRes = await query(
      'SELECT id, email, name FROM users WHERE id = ANY($1::text[])',
      [Array.from(userIds)],
    )
    for (const u of usersRes.rows as Array<{ id?: unknown; email?: unknown; name?: unknown }>) {
      const id = typeof u.id === 'string' ? u.id : String(u.id ?? '')
      if (!id) continue
      const name = typeof u.name === 'string' ? u.name.trim() : ''
      const email = typeof u.email === 'string' ? u.email.trim() : ''
      displayByUserId.set(id, name || email || id)
    }
  } catch (err) {
    // users table absent (minimal test harness) — fall back to userId as display below.
    if (!(typeof (err as any)?.code === 'string' && (err as any).code === '42P01')) throw err
  }

  for (const row of rows) {
    const fieldMap = new Map<string, PersonSummary[]>()
    for (const fieldId of personFieldIds) {
      const value = row.data[fieldId]
      if (!Array.isArray(value)) continue
      const summaries: PersonSummary[] = []
      for (const item of value) {
        if (typeof item !== 'string' || !item.trim()) continue
        const userId = item.trim()
        summaries.push({ id: userId, display: displayByUserId.get(userId) ?? userId })
      }
      if (summaries.length > 0) fieldMap.set(fieldId, summaries)
    }
    if (fieldMap.size > 0) result.set(row.id, fieldMap)
  }
  return result
}

/**
 * Resolve a `userId → display` map for sort-by-display over native person fields. Scans the
 * given records' person-sort-field cells for userIds, then joins the `users` table ONCE.
 * Missing/absent users fall back to the userId (handled by the caller).
 */
async function resolvePersonSortDisplayMap(
  query: QueryFn,
  records: Array<{ data: Record<string, unknown> }>,
  personFieldIds: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const displayByUserId = new Map<string, string>()
  const userIds = new Set<string>()
  for (const record of records) {
    for (const fieldId of personFieldIds) {
      const value = record.data[fieldId]
      if (!Array.isArray(value)) continue
      for (const item of value) {
        if (typeof item === 'string' && item.trim()) userIds.add(item.trim())
      }
    }
  }
  if (userIds.size === 0) return displayByUserId
  try {
    const usersRes = await query('SELECT id, email, name FROM users WHERE id = ANY($1::text[])', [Array.from(userIds)])
    for (const u of usersRes.rows as Array<{ id?: unknown; email?: unknown; name?: unknown }>) {
      const id = typeof u.id === 'string' ? u.id : String(u.id ?? '')
      if (!id) continue
      const name = typeof u.name === 'string' ? u.name.trim() : ''
      const email = typeof u.email === 'string' ? u.email.trim() : ''
      displayByUserId.set(id, name || email || id)
    }
  } catch (err) {
    if (!(typeof (err as any)?.code === 'string' && (err as any).code === '42P01')) throw err
  }
  return displayByUserId
}

function serializePersonSummaryMap(
  personSummaries: Map<string, Map<string, PersonSummary[]>>,
): Record<string, Record<string, PersonSummary[]>> {
  return Object.fromEntries(
    Array.from(personSummaries.entries()).map(([recordId, fieldMap]) => [
      recordId,
      Object.fromEntries(Array.from(fieldMap.entries()).map(([fieldId, summaries]) => [fieldId, summaries])),
    ]),
  )
}

const serializeAttachmentSummaryMap = serializeAttachmentSummaryMapShared

async function loadRecordSummaries(
  query: QueryFn,
  sheetId: string,
  args: {
    displayFieldId?: string | null
    allowedFieldIds?: Set<string>
    search?: string
    limit?: number
    offset?: number
  },
): Promise<RecordSummaryPage> {
  const search = typeof args.search === 'string' ? args.search.trim().toLowerCase() : ''
  const limit = typeof args.limit === 'number' ? args.limit : 50
  const offset = typeof args.offset === 'number' ? args.offset : 0

  const fieldRes = await query(
    'SELECT id, name, type FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC',
    [sheetId],
  )
  const fields = fieldRes.rows as Array<{ id: string; name: string; type: string }>
  const selectableFields = args.allowedFieldIds
    ? fields.filter((field) => args.allowedFieldIds?.has(field.id))
    : fields

  let effectiveDisplayFieldId = args.displayFieldId ?? null
  if (!effectiveDisplayFieldId && selectableFields.length > 0) {
    const stringField = selectableFields.find((field) => mapFieldType(field.type) === 'string')
    effectiveDisplayFieldId = stringField?.id ?? selectableFields[0]?.id ?? null
  }

  const recordRes = await query(
    'SELECT id, data FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC',
    [sheetId],
  )

  let summaries = (recordRes.rows as Array<{ id: string; data: unknown }>).map((row) => {
    const data = normalizeJson(row.data)
    const displayValue = effectiveDisplayFieldId ? data[effectiveDisplayFieldId] : undefined
    return {
      id: String(row.id),
      display: toSummaryDisplay(displayValue),
    }
  })

  if (search) {
    summaries = summaries.filter((summary) => summary.display.toLowerCase().includes(search))
  }

  const total = summaries.length
  const records = summaries.slice(offset, offset + limit)
  const hasMore = offset + records.length < total
  const displayMap: Record<string, string> = {}
  for (const summary of summaries) {
    displayMap[summary.id] = summary.display
  }

  return {
    records,
    displayMap,
    page: { offset, limit, total, hasMore },
    displayFieldId: effectiveDisplayFieldId,
  }
}

async function resolveMetaSheetId(
  pool: { query: QueryFn },
  args: { sheetId?: string | null; viewId?: string | null },
): Promise<{ sheetId: string; view: UniverMetaViewConfig | null }> {
  const sheetId = typeof args.sheetId === 'string' && args.sheetId.trim().length > 0 ? args.sheetId.trim() : null
  const viewId = typeof args.viewId === 'string' && args.viewId.trim().length > 0 ? args.viewId.trim() : null

  if (sheetId) {
    if (!viewId) return { sheetId, view: null }
    const view = await tryResolveView(pool, viewId)
    if (!view) return { sheetId, view: null }
    if (view.sheetId !== sheetId) {
      throw new ConflictError(`View ${viewId} does not belong to sheet ${sheetId}`)
    }
    return { sheetId, view }
  }

  if (!viewId) {
    throw new ValidationError('sheetId or viewId is required')
  }

  const view = await tryResolveView(pool, viewId)
  if (view) return { sheetId: view.sheetId, view }

  // Backward-compatible fallback: treat viewId as a sheetId when no view exists.
  return { sheetId: viewId, view: null }
}

function normalizeRecordCreateContextId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function decodeRecordCreateRoutePart(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    return normalizeRecordCreateContextId(decodeURIComponent(value))
  } catch {
    return normalizeRecordCreateContextId(value)
  }
}

export function extractMultitableRecordCreateContextFromUrl(value: unknown): { sheetId?: string; viewId?: string } {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return {}

  const candidates = [raw]
  let queryContext: { sheetId?: string; viewId?: string } = {}
  try {
    const url = new URL(raw, 'http://metasheet.local')
    candidates.push(url.pathname)
    if (url.hash) candidates.push(url.hash.slice(1))
    queryContext = {
      sheetId: decodeRecordCreateRoutePart(url.searchParams.get('sheetId') ?? undefined),
      viewId: decodeRecordCreateRoutePart(url.searchParams.get('viewId') ?? undefined),
    }
  } catch {
    const hashIndex = raw.indexOf('#')
    if (hashIndex >= 0) candidates.push(raw.slice(hashIndex + 1))
  }

  for (const candidate of candidates) {
    const pathname = candidate.replace(/^#/, '').split(/[?#]/)[0]
    const segments = pathname.split('/').filter(Boolean)
    const multitableIndex = segments.lastIndexOf('multitable')
    if (multitableIndex < 0) continue
    if (segments[multitableIndex + 1] === 'public-form') return {}
    const sheetId = decodeRecordCreateRoutePart(segments[multitableIndex + 1])
    const viewId = decodeRecordCreateRoutePart(segments[multitableIndex + 2])
    if (sheetId || viewId) return { sheetId, viewId }
  }

  if (queryContext.sheetId || queryContext.viewId) return queryContext
  return {}
}

async function createSeededSheet(args: { sheetId: string; name: string; description?: string | null; query?: QueryFn }): Promise<void> {
  const pool = poolManager.get()

  const fields = [
    { id: buildId('fld'), name: '产品名称', type: 'string' as const, order: 1, property: {} },
    { id: buildId('fld'), name: '数量', type: 'number' as const, order: 2, property: {} },
    { id: buildId('fld'), name: '单价', type: 'number' as const, order: 3, property: {} },
    { id: buildId('fld'), name: '总价', type: 'formula' as const, order: 4, property: {} },
    {
      id: buildId('fld'),
      name: '优先级',
      type: 'select' as const,
      order: 5,
      property: {
        options: [
          { value: 'P0', color: '#ff4d4f' },
          { value: 'P1', color: '#faad14' },
          { value: 'P2', color: '#1677ff' },
          { value: 'Done', color: '#52c41a' },
        ],
      },
    },
    { id: buildId('fld'), name: '关联', type: 'link' as const, order: 6, property: {} },
  ]

  const byName = new Map(fields.map(f => [f.name, f.id] as const))
  const nameId = byName.get('产品名称')!
  const qtyId = byName.get('数量')!
  const priceId = byName.get('单价')!
  const totalId = byName.get('总价')!
  const priorityId = byName.get('优先级')!
  const relatedId = byName.get('关联')!

  const records: Array<{ id: string; version: number; data: Record<string, unknown> }> = [
    {
      id: buildId('rec'),
      version: 1,
      data: {
        [nameId]: '产品A',
        [qtyId]: 10,
        [priceId]: 100,
        [totalId]: '=B1*C1',
        [priorityId]: 'P0',
        [relatedId]: 'PLM#6',
      },
    },
    {
      id: buildId('rec'),
      version: 1,
      data: {
        [nameId]: '产品B',
        [qtyId]: 20,
        [priceId]: 150,
        [totalId]: '=B2*C2',
        [priorityId]: 'P1',
        [relatedId]: 'PLM#7',
      },
    },
    {
      id: buildId('rec'),
      version: 1,
      data: {
        [nameId]: '产品C',
        [qtyId]: 15,
        [priceId]: 200,
        [totalId]: '=B3*C3',
        [priorityId]: 'P2',
        [relatedId]: 'PLM#8',
      },
    },
    {
      id: buildId('rec'),
      version: 1,
      data: {
        [nameId]: '产品D',
        [qtyId]: 25,
        [priceId]: 120,
        [totalId]: '=B4*C4',
        [priorityId]: 'P1',
        [relatedId]: 'PLM#9',
      },
    },
    {
      id: buildId('rec'),
      version: 1,
      data: {
        [nameId]: '合计',
        [qtyId]: '',
        [priceId]: '',
        [totalId]: '=SUM(D1:D4)',
        [priorityId]: '',
        [relatedId]: '',
      },
    },
  ]

  const run = async (query: QueryFn) => {
    const baseId = await ensureLegacyBase(query)

    // ②a §2a.4-c TOCTOU close — CENTRALIZED chokepoint. `createSeededSheet` is the sheet-create sink for
    // BOTH POST /sheets (sheet pre-inserted by the route at the caller-chosen base, route-guarded there)
    // and GET /view?seed=true (caller-chosen id, NO route guard). Gating the guard HERE — keyed to a
    // GENUINELY-NEW insert — covers every caller (incl. future ones) by construction.
    //
    // Fire only when this sheet does NOT exist yet (i.e. the INSERT below will actually create it at the
    // legacy `baseId`). The POST /sheets path already inserted the sheet at its resolved (caller-chosen)
    // base before reaching here, so it exists → skip (the INSERT no-ops via ON CONFLICT). Re-running the
    // guard there with the LEGACY baseId would false-positive the legit caller-chosen-base create. When
    // the sheet IS new (the seed path), validate against the base it is ACTUALLY created at (legacy).
    const existing = await query('SELECT id FROM meta_sheets WHERE id = $1', [args.sheetId])
    const isGenuinelyNew = (existing.rows as unknown[]).length === 0
    if (isGenuinelyNew) {
      await acquireLinkTargetMaterializationLock(query as unknown as QueryFn, args.sheetId)
      const retroactiveCrossBase = await validateSheetCreateNoRetroactiveCrossBaseLink(query, args.sheetId, baseId)
      if (retroactiveCrossBase) {
        throw new CrossBaseLinkError(retroactiveCrossBase)
      }
    }

    await query(
      `INSERT INTO meta_sheets (id, base_id, name, description)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [args.sheetId, baseId, args.name, args.description ?? null],
    )

    for (const field of fields) {
      await query(
        `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order")
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (id) DO NOTHING`,
        [field.id, args.sheetId, field.name, field.type, JSON.stringify(field.property ?? {}), field.order],
      )
    }

    for (const record of records) {
      await query(
        `INSERT INTO meta_records (id, sheet_id, data, version)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (id) DO NOTHING`,
        [record.id, args.sheetId, JSON.stringify(record.data), record.version],
      )
    }
  }

  if (args.query) {
    await run(args.query)
    return
  }

  await pool.transaction(async ({ query }) => {
    await run(query as unknown as QueryFn)
  })
}

class VersionConflictError extends Error {
  constructor(
    public recordId: string,
    public serverVersion: number,
  ) {
    super(`Version conflict for ${recordId}`)
    this.name = 'VersionConflictError'
  }
}

class NotFoundError extends Error {
  constructor(public message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

class ConflictError extends Error {
  constructor(public message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}

class ValidationError extends Error {
  constructor(public message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

/**
 * ②a §2a.4-c — thrown by the sheet-create TOCTOU guard. Distinct from `ValidationError` (which the
 * POST /sheets catch maps to 403 FORBIDDEN for the permission cases): a retroactively-cross-base sheet
 * create is a 400 VALIDATION_ERROR, mirroring the §2a.2 wall's reject code.
 */
class CrossBaseLinkError extends Error {
  constructor(public message: string) {
    super(message)
    this.name = 'CrossBaseLinkError'
  }
}

/** Thrown by `ensureRecordNotLocked` on a throw-based route path (form-submit edit) → 403. */
class RecordLockedError extends Error {
  constructor(message = 'Record is locked') {
    super(message)
    this.name = 'RecordLockedError'
  }
}

type PatchFailurePayload = {
  recordId: string
  code: string
  message: string
  serverVersion?: number
}

function serializePatchFailure(recordId: string, err: unknown): PatchFailurePayload | null {
  if (err instanceof ConflictError) {
    return { recordId, code: 'CONFLICT', message: err.message }
  }
  if (err instanceof VersionConflictError || err instanceof ServiceVersionConflictError) {
    return {
      recordId,
      code: 'VERSION_CONFLICT',
      message: err.message,
      serverVersion: err.serverVersion,
    }
  }
  if (err instanceof NotFoundError || err instanceof ServiceNotFoundError) {
    return { recordId, code: 'NOT_FOUND', message: err.message }
  }
  if (err instanceof ServiceFieldForbiddenError) {
    return { recordId, code: err.code, message: err.message }
  }
  if (err instanceof ValidationError) {
    return { recordId, code: 'VALIDATION_ERROR', message: err.message }
  }
  if (err instanceof ServiceValidationError) {
    return { recordId, code: err.code || 'VALIDATION_ERROR', message: err.message }
  }
  return null
}

function stringFromRecord(value: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const raw = value[key]
    if (typeof raw === 'string' && raw.trim()) return raw.trim()
  }
  return ''
}

async function validateGanttDependencyConfig(
  query: QueryFn,
  sheetId: string,
  viewType: string,
  config: Record<string, unknown>,
): Promise<string | null> {
  if (viewType !== 'gantt') return null
  const dependencyFieldId = typeof config.dependencyFieldId === 'string' ? config.dependencyFieldId.trim() : ''
  if (!dependencyFieldId) return null

  const fieldRes = await query(
    'SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 AND id = $2',
    [sheetId, dependencyFieldId],
  )
  const fieldRow = (fieldRes.rows as any[])[0]
  if (!fieldRow) {
    return `Gantt dependency field must be a self-table link field: ${dependencyFieldId}`
  }

  const field = serializeFieldRow(fieldRow)
  const foreignSheetId = stringFromRecord(field.property ?? {}, ['foreignSheetId', 'foreignDatasheetId', 'datasheetId'])
  if (field.type !== 'link' || foreignSheetId !== sheetId) {
    return `Gantt dependency field must be a self-table link field: ${dependencyFieldId}`
  }

  return null
}

// S4 — the hierarchy view reparents by writing `[parentRecordId]` over the configured parent
// link field via a generic record patch (no dedicated reparent endpoint), so a MULTI-value
// link used as parent gets silently overwritten on every drag-to-reparent. Reject saving a
// hierarchy view whose explicit parentFieldId is not a single-value (`limitSingleRecord`)
// same-sheet link field. An absent parentFieldId is allowed (runtime auto/first-link fallback unchanged).
// PATCH /fields/:fieldId carries the matching reverse guard below: once a hierarchy
// view explicitly uses a single-value link as its parent field, that field cannot
// be downgraded to multi-value, non-link, or a different target sheet while the
// view still points at it.
// Documented residual (accepted): provisioning ensureView/createView bypasses
// route-layer view validation by design (template library ships no hierarchy views today).
async function validateHierarchyParentLinkConfig(
  query: QueryFn,
  sheetId: string,
  viewType: string,
  config: Record<string, unknown>,
): Promise<string | null> {
  if (viewType !== 'hierarchy') return null
  const parentFieldId = normalizeHierarchyParentFieldId(config.parentFieldId)
  if (!parentFieldId) return null

  const fieldRes = await query(
    'SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 AND id = $2',
    [sheetId, parentFieldId],
  )
  const fieldRow = (fieldRes.rows as any[])[0]
  if (!fieldRow) {
    return `Hierarchy parent field must be a single-value link field: ${parentFieldId}`
  }

  const field = serializeFieldRow(fieldRow)
  if (!isSameSheetSingleValueHierarchyParentLink(sheetId, field.type, field.property)) {
    return `Hierarchy parent field must be a single-value link field: ${parentFieldId}`
  }

  return null
}

function normalizeHierarchyParentFieldId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeHierarchyViewConfig(
  viewType: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (viewType !== 'hierarchy' || typeof config.parentFieldId !== 'string') return config

  const normalizedParentFieldId = normalizeHierarchyParentFieldId(config.parentFieldId)
  const nextConfig = { ...config }
  if (normalizedParentFieldId) {
    nextConfig.parentFieldId = normalizedParentFieldId
  } else {
    delete nextConfig.parentFieldId
  }
  return nextConfig
}

function isSameSheetSingleValueHierarchyParentLink(
  sheetId: string,
  type: UniverMetaField['type'],
  property: Record<string, unknown> | null | undefined,
): boolean {
  const obj = property ?? {}
  const foreignSheetId = stringFromRecord(obj, ['foreignSheetId', 'foreignDatasheetId', 'datasheetId'])
  return type === 'link' && obj.limitSingleRecord === true && foreignSheetId === sheetId
}

async function validateHierarchyParentFieldMutation(
  query: QueryFn,
  sheetId: string,
  fieldId: string,
  currentType: UniverMetaField['type'],
  currentProperty: Record<string, unknown>,
  nextType: UniverMetaField['type'],
  nextProperty: Record<string, unknown>,
): Promise<string | null> {
  if (!isSameSheetSingleValueHierarchyParentLink(sheetId, currentType, currentProperty)) return null
  if (isSameSheetSingleValueHierarchyParentLink(sheetId, nextType, nextProperty)) return null

  const viewRes = await query(
    `SELECT id, name, config
     FROM meta_views
     WHERE sheet_id = $1
       AND type = $2
       AND config ? 'parentFieldId'`,
    [sheetId, 'hierarchy'],
  )
  const viewRow = (viewRes.rows as any[]).find((row) =>
    normalizeHierarchyParentFieldId(normalizeJson(row.config).parentFieldId) === fieldId)
  if (!viewRow) return null

  return `Cannot change hierarchy parent field ${fieldId}: update or remove the hierarchy view parentFieldId first.`
}

class PermissionError extends Error {
  constructor(public message: string) {
    super(message)
    this.name = 'PermissionError'
  }
}

export function univerMetaRouter(): Router {
  const router = Router()

  router.get('/bases', async (req: Request, res: Response) => {
    try {
      const pool = poolManager.get()
      const access = await resolveRequestAccess(req)
      if (!access.userId) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      const result = await pool.query(
        `SELECT id, name, icon, color, owner_id, workspace_id
         FROM meta_bases
         WHERE deleted_at IS NULL
         ORDER BY created_at ASC
         LIMIT 200`,
      )
      const visibleSheetRows = filterVisibleSheetRows((
        await pool.query(
          'SELECT id, base_id, name, description FROM meta_sheets WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 200',
        )
      ).rows as any[])
      const readableSheetRows = await filterReadableSheetRowsForAccess(
        pool.query.bind(pool),
        visibleSheetRows.map((row: any) => ({
          id: String(row.id),
          base_id: typeof row.base_id === 'string' ? row.base_id : null,
        })),
        access,
      )
      const readableBaseIds = new Set(
        readableSheetRows
          .map((row) => row.base_id)
          .filter((baseId): baseId is string => typeof baseId === 'string' && baseId.length > 0),
      )
      const bases = result.rows
        .filter((row: any) => readableBaseIds.has(String(row.id)))
        .map((row: any) => serializeBaseRow(row))
      return res.json({ ok: true, data: { bases } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] list bases failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list bases' } })
    }
  })

  router.post('/bases', rbacGuard('multitable', 'write'), async (req: Request, res: Response) => {
    const schema = z.object({
      id: z.string().min(1).max(50).optional(),
      name: z.string().min(1).max(255),
      icon: z.string().min(1).max(64).optional(),
      color: z.string().min(1).max(32).optional(),
      ownerId: z.string().min(1).max(100).optional(),
      workspaceId: z.string().min(1).max(100).optional(),
    })

    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    const baseId = parsed.data.id ?? buildId('base').slice(0, 50)
    const ownerId = parsed.data.ownerId ?? req.user?.id?.toString() ?? null

    try {
      const pool = poolManager.get()
      const insert = await pool.query(
        `INSERT INTO meta_bases (id, name, icon, color, owner_id, workspace_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, name, icon, color, owner_id, workspace_id`,
        [
          baseId,
          parsed.data.name.trim(),
          parsed.data.icon ?? null,
          parsed.data.color ?? null,
          ownerId,
          parsed.data.workspaceId ?? null,
        ],
      )
      return res.status(201).json({ ok: true, data: { base: serializeBaseRow((insert as any).rows[0]) } })
    } catch (err: any) {
      if (typeof err?.code === 'string' && err.code === '23505') {
        return res.status(409).json({ ok: false, error: { code: 'CONFLICT', message: `Base already exists: ${baseId}` } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] create base failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create base' } })
    }
  })

  router.get('/templates', rbacGuard('multitable', 'read'), async (_req: Request, res: Response) => {
    return res.json({ ok: true, data: { templates: listMultitableTemplates() } })
  })

  router.post('/templates/:templateId/install', rbacGuard('multitable', 'write'), async (req: Request, res: Response) => {
    const schema = z.object({
      baseName: z.string().min(1).max(255).optional(),
      workspaceId: z.string().min(1).max(100).optional(),
    })

    const parsed = schema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    const templateId = typeof req.params.templateId === 'string' ? req.params.templateId.trim() : ''
    if (!templateId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'templateId is required' } })
    }

    // Hoisted so the catch block can attribute failures to the same user
    // (access is block-scoped to the try). null = failure before auth resolved.
    let userId: string | null = null
    try {
      const pool = poolManager.get()
      const access = await resolveRequestAccess(req)
      if (!access.userId) {
        return res.status(401).json({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } })
      }
      userId = access.userId

      const result = await pool.transaction(async ({ query }) => installMultitableTemplate({
        query: query as unknown as QueryFn,
        templateId,
        baseName: parsed.data.baseName,
        ownerId: access.userId,
        workspaceId: parsed.data.workspaceId ?? null,
        idGenerator: (prefix) => buildId(prefix).slice(0, 50),
      }))

      templateInstallLogger.info('[multitable.template.install]', {
        templateId,
        ok: true,
        userId,
        baseId: result.base.id,
        sheetId: result.sheets[0]?.id ?? null,
      })
      return res.status(201).json({ ok: true, data: result })
    } catch (err) {
      let statusCode: number
      let errorCode: string
      let message: string
      if (err instanceof MultitableTemplateNotFoundError) {
        statusCode = 404
        errorCode = 'NOT_FOUND'
        message = err.message
      } else if (err instanceof MultitableTemplateConflictError) {
        statusCode = 409
        errorCode = 'CONFLICT'
        message = err.message
      } else {
        const hint = getDbNotReadyMessage(err)
        if (hint) {
          statusCode = 503
          errorCode = 'DB_NOT_READY'
          message = hint
        } else {
          statusCode = 500
          errorCode = 'INTERNAL_ERROR'
          message = 'Failed to install template'
          // Raw exception/stack kept separate from the structured event
          // (Logger.error only carries an Error, not arbitrary meta).
          // Message intentionally omits the stable `[multitable.template.install]`
          // token so the SOP's event-name grep is not double-counted on the
          // 500 path (this line + the structured ok:false event below).
          templateInstallLogger.error(
            'Install multitable template failed',
            err instanceof Error ? err : new Error(String(err)),
          )
        }
      }
      templateInstallLogger.info('[multitable.template.install]', {
        templateId,
        ok: false,
        userId,
        statusCode,
        errorCode,
      })
      return res.status(statusCode).json({ ok: false, error: { code: errorCode, message } })
    }
  })

  // S2 (design 20260611 §2.1): ZERO-WRITE install simulation — no transaction,
  // no INSERT; pure SELECT id-occupancy probes via the shared
  // detectTemplateConflicts (same source install consumes). Guarded with the
  // same gate as install: dry-run answers "can I install", which is
  // meaningless for read-only users. Conflict messages are English + a stable
  // kind; clients localize by kind (formula dry-run convention).
  router.post('/templates/:templateId/dry-run', rbacGuard('multitable', 'write'), async (req: Request, res: Response) => {
    // Request body is install-shaped on purpose (workspaceId accepted for
    // parity; it does not influence id occupancy).
    const schema = z.object({
      baseName: z.string().min(1).max(255).optional(),
      workspaceId: z.string().min(1).max(100).optional(),
    })

    const parsed = schema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    const templateId = typeof req.params.templateId === 'string' ? req.params.templateId.trim() : ''
    if (!templateId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'templateId is required' } })
    }

    // Observability userId (review 2026-06-11 F5): token-derived only — same
    // claim fallbacks resolveRequestAccess reads, WITHOUT its DB-backed
    // permission lookups, so the route's query surface stays exactly the
    // SELECT-only occupancy probes (zero-write proof unchanged).
    const userId =
      req.user?.id?.toString() ??
      req.user?.sub?.toString() ??
      req.user?.userId?.toString() ??
      null

    const template = getMultitableTemplate(templateId)
    if (!template) {
      templateInstallLogger.info('[multitable.template.dry-run]', {
        templateId,
        ok: false,
        userId,
        statusCode: 404,
        errorCode: 'NOT_FOUND',
      })
      // 404 semantics shared with install — same error type supplies the message.
      return res.status(404).json({
        ok: false,
        error: { code: 'NOT_FOUND', message: new MultitableTemplateNotFoundError(templateId).message },
      })
    }

    try {
      const pool = poolManager.get()
      // Ids derive through the same generator path install uses (buildId +
      // the shared stableChildId derivation in template-library). Install
      // draws a FRESH base id per call, so the ids returned here are
      // illustrative of shape/derivation — NOT a promise of the exact ids a
      // subsequent install will create.
      const baseId = buildId('base').slice(0, 50)
      const baseName = (parsed.data.baseName?.trim() || template.name).slice(0, 255)
      const wouldCreate = buildTemplateWouldCreate(template, { baseId, baseName })
      const conflicts = await detectTemplateConflicts(
        (sql, params) => pool.query(sql, params),
        template,
        { baseId, baseName },
      )
      const installable = !conflicts.some((conflict) => conflict.severity === 'error')
      templateInstallLogger.info('[multitable.template.dry-run]', {
        templateId,
        ok: true,
        userId,
        installable,
        conflictCount: conflicts.length,
      })
      return res.json({ ok: true, data: { templateId, wouldCreate, conflicts, installable } })
    } catch (err) {
      let statusCode: number
      let errorCode: string
      let message: string
      const hint = getDbNotReadyMessage(err)
      if (hint) {
        statusCode = 503
        errorCode = 'DB_NOT_READY'
        message = hint
      } else {
        statusCode = 500
        errorCode = 'INTERNAL_ERROR'
        message = 'Failed to dry-run template'
        // Raw exception/stack kept separate from the structured event, and the
        // message omits the stable `[multitable.template.dry-run]` token so an
        // event-name grep is not double-counted on the 500 path (install-route
        // convention).
        templateInstallLogger.error(
          'Dry-run multitable template failed',
          err instanceof Error ? err : new Error(String(err)),
        )
      }
      templateInstallLogger.info('[multitable.template.dry-run]', {
        templateId,
        ok: false,
        userId,
        statusCode,
        errorCode,
      })
      return res.status(statusCode).json({ ok: false, error: { code: errorCode, message } })
    }
  })

  router.get('/context', async (req: Request, res: Response) => {
    const baseId = typeof req.query.baseId === 'string' ? req.query.baseId.trim() : ''
    const sheetId = typeof req.query.sheetId === 'string' ? req.query.sheetId.trim() : ''
    const viewId = typeof req.query.viewId === 'string' ? req.query.viewId.trim() : ''
    if (!baseId && !sheetId && !viewId) {
      return res.status(400).json({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'baseId, sheetId, or viewId is required' },
      })
    }

    try {
      const pool = poolManager.get()
      const access = await resolveRequestAccess(req)
      if (!access.userId) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      const baseCapabilities = deriveCapabilities(access.permissions, access.isAdminRole)

      let resolvedBaseId = baseId || null
      let resolvedSheetId = sheetId || null
      if (resolvedSheetId || viewId) {
        const resolved = await resolveMetaSheetId(pool as unknown as { query: QueryFn }, {
          sheetId: resolvedSheetId,
          viewId: viewId || undefined,
        })
        resolvedSheetId = resolved.sheetId
      }

      const sheetRowResult = resolvedSheetId
        ? await pool.query(
          `SELECT s.id, s.base_id, s.name, s.description, b.id AS base_ref_id, b.name AS base_name, b.icon AS base_icon,
                  b.color AS base_color, b.owner_id AS base_owner_id, b.workspace_id AS base_workspace_id
           FROM meta_sheets s
           LEFT JOIN meta_bases b ON b.id = s.base_id
           WHERE s.id = $1 AND s.deleted_at IS NULL`,
          [resolvedSheetId],
        )
        : { rows: [] }

      const sheetRow = (sheetRowResult as any).rows?.[0]
      if (resolvedSheetId && !sheetRow) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${resolvedSheetId}` } })
      }

      if (!resolvedBaseId) {
        resolvedBaseId = typeof sheetRow?.base_id === 'string' ? sheetRow.base_id : null
      }

      const baseRowResult = resolvedBaseId
        ? await pool.query(
          `SELECT id, name, icon, color, owner_id, workspace_id
           FROM meta_bases
           WHERE id = $1 AND deleted_at IS NULL`,
          [resolvedBaseId],
        )
        : { rows: [] }

      const baseRow = (baseRowResult as any).rows?.[0]
      const sheetListResult = resolvedBaseId
        ? await pool.query(
          `SELECT id, base_id, name, description
           FROM meta_sheets
           WHERE base_id = $1 AND deleted_at IS NULL
           ORDER BY created_at ASC`,
          [resolvedBaseId],
        )
        : { rows: [] }
      const visibleSheetRows = filterVisibleSheetRows(((sheetListResult as any).rows ?? []) as any[])
      const sheetPermissionScopeMap = await loadSheetPermissionScopeMap(
        pool.query.bind(pool),
        visibleSheetRows.map((row) => String(row.id)),
        access.userId,
      )
      const readableSheetRows = visibleSheetRows.filter((row) =>
        canReadWithSheetGrant(
          baseCapabilities,
          sheetPermissionScopeMap.get(String(row.id)),
          access.isAdminRole,
        ),
      )

      const effectiveSheetId =
        resolvedSheetId ??
        (typeof readableSheetRows[0]?.id === 'string' ? String(readableSheetRows[0].id) : null)
      if (resolvedSheetId && !readableSheetRows.some((row) => String(row.id) === resolvedSheetId)) {
        return sendForbidden(res)
      }
      if (!baseCapabilities.canRead && !effectiveSheetId) {
        return sendForbidden(res)
      }
      const selectedSheetScope = effectiveSheetId
        ? sheetPermissionScopeMap.get(effectiveSheetId)
        : undefined
      const capabilities = effectiveSheetId
        ? applyContextSheetSchemaWriteGrant(
            baseCapabilities,
            selectedSheetScope,
            access.isAdminRole,
          )
        : baseCapabilities
      const capabilityOrigin = deriveCapabilityOrigin(
        baseCapabilities,
        capabilities,
        selectedSheetScope,
        access.isAdminRole,
      )
      const selectedSheet =
        (!isSystemPeopleSheetDescription(sheetRow?.description) ? sheetRow : null) ??
        readableSheetRows.find((row) => String(row.id) === effectiveSheetId) ??
        null

      const viewsResult = effectiveSheetId
        ? await pool.query(
          `SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config
           FROM meta_views
           WHERE sheet_id = $1
           ORDER BY created_at ASC`,
          [effectiveSheetId],
        )
        : { rows: [] }

      const activeFields = effectiveSheetId
        ? await loadFieldsForSheet(pool.query.bind(pool), effectiveSheetId)
        : []
      const serializedViews = (viewsResult as any).rows.map((row: any) => ({
        id: String(row.id),
        sheetId: String(row.sheet_id),
        name: String(row.name),
        type: String(row.type ?? 'grid'),
        filterInfo: normalizeJson(row.filter_info),
        sortInfo: normalizeJson(row.sort_info),
        groupInfo: normalizeJson(row.group_info),
        hiddenFieldIds: normalizeJsonArray(row.hidden_field_ids),
        config: normalizeJson(row.config),
      }))
      const selectedView = viewId
        ? serializedViews.find((view: UniverMetaViewConfig) => view.id === viewId) ?? null
        : serializedViews[0] ?? null
      const viewIds = serializedViews.map((v: UniverMetaViewConfig) => v.id)
      const viewScopeMap = access.userId ? await loadViewPermissionScopeMap(pool.query.bind(pool), viewIds, access.userId) : new Map()
      // #2052 (b): bind fieldScopeMap to effectiveSheetId (NOT resolvedSheetId) — on a base-only ?baseId=
      // request resolvedSheetId is null but the returned views bind to effectiveSheetId; gating off
      // resolvedSheetId leaves the map empty and fails open. (Also corrects the fieldPermissions metadata.)
      const fieldScopeMap = (access.userId && effectiveSheetId) ? await loadFieldPermissionScopeMap(pool.query.bind(pool), effectiveSheetId, access.userId) : new Map()
      const fieldPermissions = deriveFieldPermissions(activeFields, capabilities, {
        hiddenFieldIds: selectedView?.hiddenFieldIds ?? [],
        fieldScopeMap,
      })
      // #2052 (b): allowed-field set for redacting filter literals — BOTH inputs keyed to effectiveSheetId
      // (activeFields above + this fieldScopeMap), so the redaction matches the sheet whose views ship.
      const allowedFieldIds = computeAllowedFieldIds(activeFields, capabilities, fieldScopeMap)
      const viewPermissions = deriveViewPermissions(serializedViews, capabilities, viewScopeMap)

      return res.json({
        ok: true,
        data: {
          base: baseRow ? serializeBaseRow(baseRow) : null,
          sheet: selectedSheet
            ? {
              id: String(selectedSheet.id),
              baseId: typeof selectedSheet.base_id === 'string' ? selectedSheet.base_id : null,
              name: String(selectedSheet.name),
              description: typeof selectedSheet.description === 'string' ? selectedSheet.description : null,
            }
            : null,
          sheets: (sheetListResult as any).rows.map((row: any) => ({
            id: String(row.id),
            baseId: typeof row.base_id === 'string' ? row.base_id : null,
            name: String(row.name),
            description: typeof row.description === 'string' ? row.description : null,
          })).filter((row: any) =>
            !isSystemPeopleSheetDescription(row.description)
            && readableSheetRows.some((visibleRow) => String(visibleRow.id) === String(row.id)),
          ),
          views: serializedViews.map((view: UniverMetaViewConfig) => redactViewConfigFilterLiterals(view, allowedFieldIds)),
          capabilities,
          capabilityOrigin,
          fieldPermissions,
          viewPermissions,
        },
      })
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: err.message } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] load context failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load multitable context' } })
    }
  })

  router.get('/sheets', async (req: Request, res: Response) => {
    try {
      const pool = poolManager.get()
      const access = await resolveRequestAccess(req)
      if (!access.userId) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      const result = await pool.query(
        'SELECT id, base_id, name, description FROM meta_sheets WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 200',
      )
      const readableSheetRows = await filterReadableSheetRowsForAccess(
        pool.query.bind(pool),
        filterVisibleSheetRows((result.rows ?? []) as any[]),
        access,
      )
      const sheets = readableSheetRows.map((r: any) => ({
        id: String(r.id),
        baseId: typeof r.base_id === 'string' ? r.base_id : null,
        name: String(r.name),
        description: typeof r.description === 'string' ? r.description : null,
      }))
      return res.json({ ok: true, data: { sheets } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] list sheets failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list sheets' } })
    }
  })

  router.get('/sheets/:sheetId/permissions', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    if (!sheetId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId is required' } })
    }

    try {
      const pool = poolManager.get()
      const sheet = await loadSheetRow(pool.query.bind(pool), sheetId)
      if (!sheet) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageSheetAccess) return sendForbidden(res)

      const items = await listSheetPermissionEntries(pool.query.bind(pool), sheetId)
      return res.json({ ok: true, data: { items } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] list sheet permissions failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list sheet permissions' } })
    }
  })

  router.get('/sheets/:sheetId/permission-candidates', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    if (!sheetId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId is required' } })
    }

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined
    const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, Math.floor(rawLimit as number))) : 20

    try {
      const pool = poolManager.get()
      const sheet = await loadSheetRow(pool.query.bind(pool), sheetId)
      if (!sheet) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageSheetAccess) return sendForbidden(res)

      const items = await listSheetPermissionCandidates(pool.query.bind(pool), sheetId, { q, limit })
      return res.json({ ok: true, data: { items, total: items.length, limit, query: q } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] list sheet permission candidates failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list sheet permission candidates' } })
    }
  })

  router.put('/sheets/:sheetId/permissions/:subjectType/:subjectId', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    const subjectType = typeof req.params.subjectType === 'string' ? req.params.subjectType.trim() : ''
    const subjectId = typeof req.params.subjectId === 'string' ? req.params.subjectId.trim() : ''
    if (!sheetId || !subjectId || !isSheetPermissionSubjectType(subjectType)) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId, subjectType, and subjectId are required' } })
    }

    const schema = z.object({
      accessLevel: z.enum(['read', 'write', 'write-own', 'admin', 'none']),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const pool = poolManager.get()
      const sheet = await loadSheetRow(pool.query.bind(pool), sheetId)
      if (!sheet) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageSheetAccess) return sendForbidden(res)

      if (subjectType !== 'user' && parsed.data.accessLevel === 'write-own') {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'write-own is only supported for direct user grants' } })
      }

      if (subjectType === 'user') {
        const userResult = await pool.query(
          'SELECT id FROM users WHERE id = $1',
          [subjectId],
        )
        if (userResult.rows.length === 0) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `User not found: ${subjectId}` } })
        }
      } else if (subjectType === 'role') {
        const roleResult = await pool.query(
          'SELECT id FROM roles WHERE id = $1',
          [subjectId],
        )
        if (roleResult.rows.length === 0) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Role not found: ${subjectId}` } })
        }
      } else {
        const groupResult = await pool.query(
          'SELECT id FROM platform_member_groups WHERE id::text = $1',
          [subjectId],
        )
        if (groupResult.rows.length === 0) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Member group not found: ${subjectId}` } })
        }
      }

      await pool.transaction(async ({ query }) => {
        await query(
          `DELETE FROM spreadsheet_permissions
           WHERE sheet_id = $1
             AND subject_type = $2
             AND subject_id = $3
             AND perm_code = ANY($4::text[])`,
          [sheetId, subjectType, subjectId, MANAGED_SHEET_PERMISSION_CODES],
        )
        if (parsed.data.accessLevel !== 'none') {
          await query(
            `INSERT INTO spreadsheet_permissions(sheet_id, user_id, subject_type, subject_id, perm_code)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              sheetId,
              subjectType === 'user' ? subjectId : null,
              subjectType,
              subjectId,
              CANONICAL_SHEET_PERMISSION_CODE_BY_ACCESS_LEVEL[parsed.data.accessLevel],
            ],
          )
        }
      })

      const items = await listSheetPermissionEntries(pool.query.bind(pool), sheetId)
      const entry = items.find((item) => item.subjectType === subjectType && item.subjectId === subjectId) ?? null
      return res.json({
        ok: true,
        data: {
          subjectType,
          subjectId,
          accessLevel: parsed.data.accessLevel,
          entry,
        },
      })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] update sheet permission failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update sheet permission' } })
    }
  })

  // ── View permission authoring ──

  router.get('/views/:viewId/permissions', async (req: Request, res: Response) => {
    const viewId = typeof req.params.viewId === 'string' ? req.params.viewId.trim() : ''
    if (!viewId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'viewId is required' } })
    }

    try {
      const pool = poolManager.get()
      const viewRow = await pool.query('SELECT id, sheet_id FROM meta_views WHERE id = $1', [viewId])
      if (viewRow.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `View not found: ${viewId}` } })
      }
      const sheetId = String((viewRow.rows[0] as any).sheet_id)
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageViews) return sendForbidden(res)

      let result: { rows: any[] }
      try {
        result = await pool.query(
          `SELECT
              vp.id,
              vp.view_id,
              vp.subject_type,
              vp.subject_id,
              vp.permission,
              vp.created_at,
              vp.created_by,
              u.name AS user_name,
              u.email AS user_email,
              u.is_active AS user_is_active,
              r.name AS role_name,
              r.description AS role_description,
              g.name AS group_name,
              g.description AS group_description
           FROM meta_view_permissions vp
           LEFT JOIN users u
             ON vp.subject_type = 'user'
            AND u.id = vp.subject_id
           LEFT JOIN roles r
             ON vp.subject_type = 'role'
            AND r.id::text = vp.subject_id
           LEFT JOIN platform_member_groups g
             ON vp.subject_type = 'member-group'
            AND g.id::text = vp.subject_id
           WHERE vp.view_id = $1
           ORDER BY vp.created_at ASC`,
          [viewId],
        )
      } catch (err) {
        if (!isUndefinedTableError(err, 'platform_member_groups')) throw err
        result = await pool.query(
          `SELECT
              vp.id,
              vp.view_id,
              vp.subject_type,
              vp.subject_id,
              vp.permission,
              vp.created_at,
              vp.created_by,
              u.name AS user_name,
              u.email AS user_email,
              u.is_active AS user_is_active,
              r.name AS role_name,
              r.description AS role_description,
              NULL::text AS group_name,
              NULL::text AS group_description
           FROM meta_view_permissions vp
           LEFT JOIN users u
             ON vp.subject_type = 'user'
            AND u.id = vp.subject_id
           LEFT JOIN roles r
             ON vp.subject_type = 'role'
            AND r.id::text = vp.subject_id
           WHERE vp.view_id = $1
           ORDER BY vp.created_at ASC`,
          [viewId],
        )
      }
      const items = (result.rows as any[]).map((row) => ({
        id: String(row.id),
        viewId: String(row.view_id),
        subjectType: String(row.subject_type),
        subjectId: String(row.subject_id),
        subjectLabel:
          row.subject_type === 'user'
            ? String(row.user_name ?? row.subject_id)
            : row.subject_type === 'member-group'
              ? String(row.group_name ?? row.subject_id)
              : String(row.role_name ?? row.subject_id),
        subjectSubtitle:
          row.subject_type === 'user'
            ? (typeof row.user_email === 'string' ? row.user_email : null)
            : row.subject_type === 'member-group'
              ? (typeof row.group_description === 'string' ? row.group_description : null)
              : (typeof row.role_description === 'string' ? row.role_description : null),
        isActive: row.subject_type === 'user' ? row.user_is_active !== false : true,
        permission: String(row.permission),
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ''),
      }))
      return res.json({ ok: true, data: { items } })
    } catch (err) {
      if (isUndefinedTableError(err, 'meta_view_permissions')) {
        return res.json({ ok: true, data: { items: [] } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] list view permissions failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list view permissions' } })
    }
  })

  router.put('/views/:viewId/permissions/:subjectType/:subjectId', async (req: Request, res: Response) => {
    const viewId = typeof req.params.viewId === 'string' ? req.params.viewId.trim() : ''
    const subjectType = typeof req.params.subjectType === 'string' ? req.params.subjectType.trim() : ''
    const subjectId = typeof req.params.subjectId === 'string' ? req.params.subjectId.trim() : ''
    if (!viewId || !subjectId || !isSheetPermissionSubjectType(subjectType)) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'viewId, subjectType (user|member-group|role), and subjectId are required' } })
    }

    const schema = z.object({
      permission: z.enum(['read', 'write', 'admin', 'none']),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const pool = poolManager.get()
      const viewRow = await pool.query('SELECT id, sheet_id FROM meta_views WHERE id = $1', [viewId])
      if (viewRow.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `View not found: ${viewId}` } })
      }
      const sheetId = String((viewRow.rows[0] as any).sheet_id)
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageViews) return sendForbidden(res)

      if (subjectType === 'user') {
        const userCheck = await pool.query('SELECT id FROM users WHERE id = $1', [subjectId])
        if (userCheck.rows.length === 0) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `User not found: ${subjectId}` } })
        }
      } else if (subjectType === 'role') {
        const roleCheck = await pool.query('SELECT id FROM roles WHERE id = $1', [subjectId])
        if (roleCheck.rows.length === 0) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Role not found: ${subjectId}` } })
        }
      } else {
        const groupCheck = await pool.query('SELECT id FROM platform_member_groups WHERE id::text = $1', [subjectId])
        if (groupCheck.rows.length === 0) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Member group not found: ${subjectId}` } })
        }
      }

      await pool.transaction(async ({ query }) => {
        await query(
          `DELETE FROM meta_view_permissions WHERE view_id = $1 AND subject_type = $2 AND subject_id = $3`,
          [viewId, subjectType, subjectId],
        )
        if (parsed.data.permission !== 'none') {
          await query(
            `INSERT INTO meta_view_permissions(view_id, subject_type, subject_id, permission)
             VALUES ($1, $2, $3, $4)`,
            [viewId, subjectType, subjectId, parsed.data.permission],
          )
        }
      })

      return res.json({ ok: true, data: { viewId, subjectType, subjectId, permission: parsed.data.permission } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] update view permission failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update view permission' } })
    }
  })

  // ── Field permission authoring ──

  router.get('/sheets/:sheetId/field-permissions', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    if (!sheetId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId is required' } })
    }

    try {
      const pool = poolManager.get()
      const sheet = await loadSheetRow(pool.query.bind(pool), sheetId)
      if (!sheet) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageFields) return sendForbidden(res)

      let result: { rows: any[] }
      try {
        result = await pool.query(
          `SELECT
              fp.id,
              fp.sheet_id,
              fp.field_id,
              fp.subject_type,
              fp.subject_id,
              fp.visible,
              fp.read_only,
              fp.created_at,
              u.name AS user_name,
              u.email AS user_email,
              u.is_active AS user_is_active,
              r.name AS role_name,
              r.description AS role_description,
              g.name AS group_name,
              g.description AS group_description
           FROM field_permissions fp
           LEFT JOIN users u
             ON fp.subject_type = 'user'
            AND u.id = fp.subject_id
           LEFT JOIN roles r
             ON fp.subject_type = 'role'
            AND r.id::text = fp.subject_id
           LEFT JOIN platform_member_groups g
             ON fp.subject_type = 'member-group'
            AND g.id::text = fp.subject_id
           WHERE fp.sheet_id = $1
           ORDER BY fp.field_id ASC, fp.created_at ASC`,
          [sheetId],
        )
      } catch (err) {
        if (!isUndefinedTableError(err, 'platform_member_groups')) throw err
        result = await pool.query(
          `SELECT
              fp.id,
              fp.sheet_id,
              fp.field_id,
              fp.subject_type,
              fp.subject_id,
              fp.visible,
              fp.read_only,
              fp.created_at,
              u.name AS user_name,
              u.email AS user_email,
              u.is_active AS user_is_active,
              r.name AS role_name,
              r.description AS role_description,
              NULL::text AS group_name,
              NULL::text AS group_description
           FROM field_permissions fp
           LEFT JOIN users u
             ON fp.subject_type = 'user'
            AND u.id = fp.subject_id
           LEFT JOIN roles r
             ON fp.subject_type = 'role'
            AND r.id::text = fp.subject_id
           WHERE fp.sheet_id = $1
           ORDER BY fp.field_id ASC, fp.created_at ASC`,
          [sheetId],
        )
      }
      const items = (result.rows as any[]).map((row) => ({
        id: String(row.id),
        sheetId: String(row.sheet_id),
        fieldId: String(row.field_id),
        subjectType: String(row.subject_type),
        subjectId: String(row.subject_id),
        subjectLabel:
          row.subject_type === 'user'
            ? String(row.user_name ?? row.subject_id)
            : row.subject_type === 'member-group'
              ? String(row.group_name ?? row.subject_id)
              : String(row.role_name ?? row.subject_id),
        subjectSubtitle:
          row.subject_type === 'user'
            ? (typeof row.user_email === 'string' ? row.user_email : null)
            : row.subject_type === 'member-group'
              ? (typeof row.group_description === 'string' ? row.group_description : null)
              : (typeof row.role_description === 'string' ? row.role_description : null),
        isActive: row.subject_type === 'user' ? row.user_is_active !== false : true,
        visible: row.visible !== false,
        readOnly: row.read_only === true,
      }))
      return res.json({ ok: true, data: { items } })
    } catch (err) {
      if (isUndefinedTableError(err, 'field_permissions')) {
        return res.json({ ok: true, data: { items: [] } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] list field permissions failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list field permissions' } })
    }
  })

  router.put('/sheets/:sheetId/field-permissions/:fieldId/:subjectType/:subjectId', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    const fieldId = typeof req.params.fieldId === 'string' ? req.params.fieldId.trim() : ''
    const subjectType = typeof req.params.subjectType === 'string' ? req.params.subjectType.trim() : ''
    const subjectId = typeof req.params.subjectId === 'string' ? req.params.subjectId.trim() : ''
    if (!sheetId || !fieldId || !subjectId || !isSheetPermissionSubjectType(subjectType)) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId, fieldId, subjectType (user|member-group|role), and subjectId are required' } })
    }

    const schema = z.object({
      visible: z.boolean().optional(),
      readOnly: z.boolean().optional(),
      remove: z.boolean().optional(),
    }).refine((v) => v.remove || v.visible !== undefined || v.readOnly !== undefined, { message: 'visible, readOnly, or remove required' })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const pool = poolManager.get()
      const sheet = await loadSheetRow(pool.query.bind(pool), sheetId)
      if (!sheet) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageFields) return sendForbidden(res)

      const fieldCheck = await pool.query('SELECT id FROM meta_fields WHERE id = $1 AND sheet_id = $2', [fieldId, sheetId])
      if (fieldCheck.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Field ${fieldId} not found in sheet ${sheetId}` } })
      }

      if (subjectType === 'user') {
        const userCheck = await pool.query('SELECT id FROM users WHERE id = $1', [subjectId])
        if (userCheck.rows.length === 0) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `User not found: ${subjectId}` } })
        }
      } else if (subjectType === 'role') {
        const roleCheck = await pool.query('SELECT id FROM roles WHERE id = $1', [subjectId])
        if (roleCheck.rows.length === 0) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Role not found: ${subjectId}` } })
        }
      } else {
        const groupCheck = await pool.query('SELECT id FROM platform_member_groups WHERE id::text = $1', [subjectId])
        if (groupCheck.rows.length === 0) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Member group not found: ${subjectId}` } })
        }
      }

      if (parsed.data.remove) {
        await pool.query(
          `DELETE FROM field_permissions WHERE sheet_id = $1 AND field_id = $2 AND subject_type = $3 AND subject_id = $4`,
          [sheetId, fieldId, subjectType, subjectId],
        )
        return res.json({ ok: true, data: { sheetId, fieldId, subjectType, subjectId, removed: true } })
      }

      await pool.query(
        `INSERT INTO field_permissions(sheet_id, field_id, subject_type, subject_id, visible, read_only)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (sheet_id, field_id, subject_type, subject_id)
         DO UPDATE SET visible = EXCLUDED.visible, read_only = EXCLUDED.read_only`,
        [sheetId, fieldId, subjectType, subjectId, parsed.data.visible ?? true, parsed.data.readOnly ?? false],
      )

      return res.json({
        ok: true,
        data: { sheetId, fieldId, subjectType, subjectId, visible: parsed.data.visible ?? true, readOnly: parsed.data.readOnly ?? false },
      })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] update field permission failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update field permission' } })
    }
  })

  // ── Record permission authoring ──

  router.get('/sheets/:sheetId/records/:recordId/permissions', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    const recordId = typeof req.params.recordId === 'string' ? req.params.recordId.trim() : ''
    if (!sheetId || !recordId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId and recordId are required' } })
    }

    try {
      const pool = poolManager.get()
      const sheet = await loadSheetRow(pool.query.bind(pool), sheetId)
      if (!sheet) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageSheetAccess) return sendForbidden(res)

      const recordCheck = await pool.query('SELECT id FROM meta_records WHERE id = $1 AND sheet_id = $2', [recordId, sheetId])
      if (recordCheck.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Record not found: ${recordId}` } })
      }

      const result = await pool.query(
        `SELECT
            rp.id,
            rp.sheet_id,
            rp.record_id,
            rp.subject_type,
            rp.subject_id,
            rp.access_level,
            rp.created_at,
            rp.created_by,
            u.name AS user_name,
            u.email AS user_email,
            u.is_active AS user_is_active,
            r.name AS role_name,
            r.description AS role_description,
            g.name AS group_name,
            g.description AS group_description
         FROM record_permissions rp
         LEFT JOIN users u
           ON rp.subject_type = 'user'
          AND u.id = rp.subject_id
         LEFT JOIN roles r
           ON rp.subject_type = 'role'
          AND r.id::text = rp.subject_id
         LEFT JOIN platform_member_groups g
           ON rp.subject_type = 'member-group'
          AND g.id::text = rp.subject_id
         WHERE rp.sheet_id = $1 AND rp.record_id = $2
         ORDER BY rp.created_at ASC`,
        [sheetId, recordId],
      )
      const items = (result.rows as any[]).map((row) => ({
        id: String(row.id),
        sheetId: String(row.sheet_id),
        recordId: String(row.record_id),
        subjectType: String(row.subject_type),
        subjectId: String(row.subject_id),
        accessLevel: String(row.access_level),
        label:
          row.subject_type === 'user'
            ? String(row.user_name ?? row.subject_id)
            : row.subject_type === 'member-group'
              ? String(row.group_name ?? row.subject_id)
              : String(row.role_name ?? row.subject_id),
        subtitle:
          row.subject_type === 'user'
            ? (typeof row.user_email === 'string' ? row.user_email : null)
            : row.subject_type === 'member-group'
              ? (typeof row.group_description === 'string' ? row.group_description : null)
              : (typeof row.role_description === 'string' ? row.role_description : null),
        isActive: row.subject_type === 'user' ? row.user_is_active !== false : true,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ''),
      }))
      return res.json({ ok: true, data: { items } })
    } catch (err) {
      if (isUndefinedTableError(err, 'record_permissions')) {
        return res.json({ ok: true, data: { items: [] } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] list record permissions failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list record permissions' } })
    }
  })

  router.get('/sheets/:sheetId/records/:recordId/history', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    const recordId = typeof req.params.recordId === 'string' ? req.params.recordId.trim() : ''
    const limitParam = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 50
    const offsetParam = typeof req.query.offset === 'string' ? Number.parseInt(req.query.offset, 10) : 0
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 100) : 50
    const offset = Number.isFinite(offsetParam) ? Math.max(offsetParam, 0) : 0
    if (!sheetId || !recordId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId and recordId are required' } })
    }

    try {
      const pool = poolManager.get()
      const recordCheck = await pool.query(
        'SELECT id, sheet_id FROM meta_records WHERE id = $1 AND sheet_id = $2',
        [recordId, sheetId],
      )
      if (recordCheck.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Record not found: ${recordId}` } })
      }

      const { access, capabilities } = await resolveSheetReadableCapabilities(req, pool.query.bind(pool), sheetId)
      if (!access.userId) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      if (!capabilities.canRead) return sendForbidden(res)

      if (!access.isAdminRole) {
        const hasRecordPerms = await hasRecordPermissionAssignments(pool.query.bind(pool), sheetId)
        if (hasRecordPerms) {
          const recordScopeMap = await loadRecordPermissionScopeMap(
            pool.query.bind(pool),
            sheetId,
            [recordId],
            access.userId,
          )
          if (recordScopeMap.size > 0 && !deriveRecordPermissions(recordId, capabilities, recordScopeMap).canRead) {
            return sendForbidden(res)
          }
        }
      }

      const baseAllowedFieldIds = await loadAllowedFieldIds(pool.query.bind(pool), sheetId, access.userId, capabilities)
      // §2a.3 (m1) via the single CHOKEPOINT (maskStoredRecordFieldIds): a record-revision
      // snapshot/patch can carry a MATERIALIZED formula value whose foreign lookup input is masked for
      // this actor; the source-sheet allowed-field set above does not catch it (the formula field
      // itself is source-visible). The chokepoint taint-drops those formula fields from the redaction
      // allow-set. No typed field list here (the allow-set is built without one), so `fields` is
      // omitted — the resolver defensively ignores non-formula ids. Cheap (one resolver call per
      // history request; snapshot capture is often null anyway).
      const allowedFieldIds = await maskStoredRecordFieldIds(req, pool.query.bind(pool), sheetId, undefined, baseAllowedFieldIds)
      const items = (await listRecordRevisions(pool.query.bind(pool), { sheetId, recordId, limit, offset }))
        .map((item) => redactRecordRevisionEntry(item, allowedFieldIds))
      return res.json({ ok: true, data: { items, limit, offset } })
    } catch (err) {
      if (isUndefinedTableError(err, 'meta_record_revisions')) {
        return res.json({ ok: true, data: { items: [], limit, offset } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] list record history failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list record history' } })
    }
  })

  // ---------------------------------------------------------------------------
  // Layer 1 — record-level version restore.
  // Design-lock: docs/development/multitable-record-restore-layer1-design-20260615.md
  //
  // Restore a single LIVE record's scalar user-data fields back to a prior
  // revision's recorded values. Properties locked in the design:
  //  - forward-change: a value-changing restore emits a NEW 'restore' revision
  //    (action='update') and bumps version; an empty diff is a no-op.
  //  - Lock A faithful set∪unset diff vs the unmasked stored snapshot (never patch replay).
  //  - Lock B write-gated: BOTH the static FieldMutationGuard AND restore's own
  //    layer-3 pre-check (the spine does not enforce layer-3 — see #2106 / multitable-ai.ts).
  //  - Lock C update-restore only: hard-deleted record → 404; delete-target → RESTORE_UNSUPPORTED.
  //  - Lock D scalar-only: computed/link/system-auto/attachment excluded by type.
  // ---------------------------------------------------------------------------
  router.post('/sheets/:sheetId/records/:recordId/restore', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    const recordId = typeof req.params.recordId === 'string' ? req.params.recordId.trim() : ''
    if (!sheetId || !recordId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId and recordId are required' } })
    }
    const schema = z.object({
      targetVersion: z.number().int().positive(),
      expectedVersion: z.number().int().nonnegative(),
      // Per-field (column-level) restore: optional subset of field ids. Omitted → restore the whole
      // restorable diff (full-record). Present → restrict to those fields (still atomic over the subset).
      fieldIds: z.array(z.string().min(1)).min(1).optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }
    const { targetVersion, expectedVersion, fieldIds } = parsed.data

    const asRecord = (value: unknown): Record<string, unknown> => {
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
      if (typeof value === 'string') {
        try {
          const p = JSON.parse(value)
          if (p && typeof p === 'object' && !Array.isArray(p)) return p as Record<string, unknown>
        } catch { /* fall through */ }
      }
      return {}
    }
    // Lock D: this set gates the SCALAR-data path. Computed/system-auto/attachment are non-data and
    // excluded; `button` is the no-value trigger (also caught by raw type below). `link` is listed as a
    // defensive backstop, but link fields never reach this check — they are handled by a dedicated SET
    // path (Slice 2a) above the scalar branch, which re-syncs meta_links + the mirror through the spine.
    const NON_RESTORABLE_TYPES = new Set([
      'formula', 'lookup', 'rollup', 'link', 'attachment', 'button',
      'autoNumber', 'createdTime', 'modifiedTime', 'createdBy', 'modifiedBy',
    ])
    const isRestorableType = (t: string): boolean => !NON_RESTORABLE_TYPES.has(t)
    const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
    // Link state is authoritative in meta_links, which is an unordered SET — so a pure reorder of the
    // data-mirror id array is NOT a meaningful change and must not emit a spurious SET (version bump +
    // data reorder while meta_links is unchanged). Compare link ids order-insensitively.
    const sameLinkSet = (a: string[], b: string[]): boolean => {
      if (a.length !== b.length) return false
      const sa = [...a].sort()
      const sb = [...b].sort()
      return sa.every((v, i) => v === sb[i])
    }

    try {
      const pool = poolManager.get()
      const { access, capabilities, sheetScope } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!access.userId) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      if (!capabilities.canEditRecord) return sendForbidden(res)

      // Live record only — undelete (resurrect + meta_links rebuild) is Slice 2.
      const currentRes = await pool.query(
        'SELECT id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2',
        [recordId, sheetId],
      )
      if (currentRes.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Record not found: ${recordId}` } })
      }
      const currentRow = currentRes.rows[0] as { version?: unknown; data?: unknown }
      const currentVersion = Number(currentRow.version ?? 0)
      // Concurrency pre-check BEFORE the no-op branch: a stale caller must get a conflict, never noop.
      if (expectedVersion !== currentVersion) {
        return res.status(409).json({ ok: false, error: { code: 'VERSION_CONFLICT', message: `Record is at version ${currentVersion}, expected ${expectedVersion}` } })
      }
      const currentData = asRecord(currentRow.data)

      // Resolve the target revision: non-delete wins; delete-only at that version → unsupported.
      // (meta_record_revisions has no (sheet,record,version) uniqueness; delete reuses the version.)
      const revRes = await pool.query(
        `SELECT action, snapshot FROM meta_record_revisions
         WHERE sheet_id = $1 AND record_id = $2 AND version = $3
         ORDER BY created_at DESC`,
        [sheetId, recordId, targetVersion],
      )
      const revRows = revRes.rows as Array<{ action?: unknown; snapshot?: unknown }>
      if (revRows.length === 0) {
        // Distinguish a PRUNED target (retention aged it out) from one that never existed: if the
        // target is below the surviving floor (MIN retained version for this record), it was pruned
        // → VERSION_EXPIRED. This is data-driven (true whether or not the retention sweep is enabled;
        // with retention off, MIN is the create version so this never fires spuriously).
        const floorRes = await pool.query(
          'SELECT MIN(version) AS min_version FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2',
          [sheetId, recordId],
        )
        const minVersion = Number((floorRes.rows[0] as { min_version?: unknown } | undefined)?.min_version ?? 0)
        if (minVersion > 0 && targetVersion < minVersion) {
          return res.status(410).json({ ok: false, error: { code: 'VERSION_EXPIRED', message: `Version ${targetVersion} is older than the retained floor (v${minVersion}) and has been pruned` } })
        }
        return res.status(404).json({ ok: false, error: { code: 'VERSION_NOT_FOUND', message: `No revision at version ${targetVersion}` } })
      }
      const targetRev = revRows.find((r) => r.action !== 'delete')
      if (!targetRev) {
        return res.status(422).json({ ok: false, error: { code: 'RESTORE_UNSUPPORTED', message: `Version ${targetVersion} is a delete revision; undelete is not supported in this slice` } })
      }
      if (targetRev.snapshot === null || targetRev.snapshot === undefined) {
        return res.status(422).json({ ok: false, error: { code: 'SNAPSHOT_UNAVAILABLE', message: `Revision ${targetVersion} has no stored snapshot to restore from` } })
      }
      const targetSnapshot = asRecord(targetRev.snapshot)

      // Field + permission context — single source of truth shared with /patch and the AI shortcut.
      const patchContext = await buildRecordPatchContext(req, pool.query.bind(pool), sheetId, access, capabilities)
      if (!patchContext) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      const { fields, readableEchoFields, readableEchoFieldIds, attachmentFields, fieldById, fieldPermissions } = patchContext

      // Raw DB field types — `mapFieldType` currently folds the no-value `button` trigger into
      // `string`, so guard.type never reports 'button'. Restore excludes the no-value `button` by its
      // RAW type so it is skipped regardless of that mapping (otherwise a legacy button key in data
      // would enter the diff and the spine would refuse it, blocking an otherwise-restorable record).
      const rawTypeRes = await pool.query('SELECT id, type FROM meta_fields WHERE sheet_id = $1', [sheetId])
      const rawTypeById = new Map<string, string>(
        (rawTypeRes.rows as Array<{ id: string; type: unknown }>).map((r) => [String(r.id), String(r.type ?? '').trim().toLowerCase()]),
      )

      // Schema drift: a snapshot field id absent from the current schema means version N cannot be
      // faithfully reproduced. This is checked ONLY for FULL-record restore. For per-field (`fieldIds`)
      // a requested field missing from the schema — whether deleted-since (and still in the snapshot) or
      // never-existed — simply falls through to the empty selected diff (200 no-op), matching the
      // contract. Critically it must NOT 422 on a per-field request: a 422-vs-200 split would let an
      // actor probe `fieldIds` to learn whether a now-deleted field existed in this revision's snapshot
      // (the same probe class as the hidden-field leak closed below). (A type-change since capture is not
      // detectable without a stored schema snapshot; the spine value validators backstop bad values.)
      if (!fieldIds) {
        for (const fid of Object.keys(targetSnapshot)) {
          if (!fieldById.has(fid)) {
            return res.status(422).json({ ok: false, error: { code: 'SCHEMA_DRIFT', message: `Field ${fid} in revision ${targetVersion} no longer exists in the current schema` } })
          }
        }
      }

      // Faithful set ∪ unset diff over restorable fields.
      const diff: RecordChange[] = []
      for (const [fid, guard] of fieldById.entries()) {
        if (rawTypeById.get(fid) === 'button') continue // no-value trigger (mapFieldType folds it to 'string')
        const inSnap = Object.prototype.hasOwnProperty.call(targetSnapshot, fid)
        const inCur = Object.prototype.hasOwnProperty.call(currentData, fid)
        // Slice 2a — link fields: restore the snapshot's link id array (or [] when absent at version N)
        // as a SET routed through patchRecords, which re-syncs meta_links + the twoWay mirror fan-out.
        // NEVER a data-`unset` (that touches only the data mirror and would desync the join table).
        // Only emit when the id set actually differs (preserves no-op). The link config (guard.link)
        // drives the spine's meta_links sync; a snapshot referencing a now-deleted foreign record is
        // rejected fail-closed by the spine's link-target validation (VALIDATION_ERROR). Use the CANONICAL
        // normalizeLinkIds (handles legacy `'["a","b"]'` / `'a,b'` / trim / dedup) so a legacy-shaped
        // snapshot or current value is parsed identically to the write path, not mis-read as one id.
        if (guard.type === 'link') {
          const target = inSnap ? normalizeLinkIds(targetSnapshot[fid]) : []
          if (!sameLinkSet(normalizeLinkIds(currentData[fid]), target)) {
            diff.push({ recordId, fieldId: fid, value: target, expectedVersion: currentVersion, op: 'set' })
          }
          continue
        }
        if (!isRestorableType(guard.type)) continue
        if (inSnap) {
          if (!sameValue(currentData[fid], targetSnapshot[fid])) {
            diff.push({ recordId, fieldId: fid, value: targetSnapshot[fid], expectedVersion: currentVersion, op: 'set' })
          }
        } else if (inCur) {
          diff.push({ recordId, fieldId: fid, value: null, expectedVersion: currentVersion, op: 'unset' })
        }
      }

      // Per-field (column-level) restore: when the caller passes `fieldIds`, restrict the diff to that
      // selection. The atomic gate below then runs over only the selected subset — so a user can restore
      // the writable fields they picked even if another changed field in the revision is forbidden. A
      // requested field that is unchanged / non-restorable / unknown simply isn't in the diff (no error).
      //
      // Security: a requested field the actor cannot SEE (statically hidden, or layer-3 visible=false) is
      // treated as unknown — dropped here rather than reaching the gate. Otherwise a 403 (the field
      // changed) vs 200 no-op (it didn't, or doesn't exist) would let an actor probe `fieldIds` to learn
      // a hidden field exists AND changed in this revision. Visible-but-read-only fields stay (their 403
      // leaks nothing the actor cannot already see).
      const canSeeField = (fid: string): boolean => {
        const g = fieldById.get(fid)
        if (!g || g.hidden) return false
        return fieldPermissions[fid]?.visible !== false
      }
      // INVARIANT (do not reorder): canSeeField is applied HERE, so invisible fields are dropped from
      // selectedDiff BEFORE the hasForbidden gate below. Moving this visibility filter to after the gate
      // would make an invisible-but-changed field 403 instead of no-op, reopening the hidden-field probe.
      const selectedDiff = fieldIds
        ? diff.filter((ch) => fieldIds.includes(ch.fieldId) && canSeeField(ch.fieldId))
        : diff

      // Lock B: gate every (selected) diff field on BOTH the static guard and restore's own layer-3 pre-check.
      const hasForbidden = selectedDiff.some((ch) => {
        const guard = fieldById.get(ch.fieldId)
        const perm = fieldPermissions[ch.fieldId]
        const staticOk = !!guard && !guard.hidden && guard.readOnly !== true
        const layer3Ok = !!perm && perm.visible !== false && perm.readOnly !== true
        return !staticOk || !layer3Ok
      })
      if (hasForbidden) {
        // Generalized message — the forbidden ids are DERIVED server-side from the unmasked snapshot
        // (not caller-submitted like /patch), so echoing them would leak hidden-field metadata to an
        // actor denied visibility. The diff is atomic: nothing is written.
        return res.status(403).json({ ok: false, error: { code: 'RESTORE_FORBIDDEN', message: 'Not permitted to restore one or more fields in this revision' } })
      }

      const restoredFieldIds = selectedDiff.map((ch) => ch.fieldId)
      // No-op: nothing to restore (concurrency already verified above).
      if (selectedDiff.length === 0) {
        return res.json({ ok: true, data: { recordId, newVersion: currentVersion, noop: true, restoredFieldIds: [], skippedFieldIds: [] } })
      }

      // Apply through the canonical spine: atomic txn + version re-check + 'restore' revision
      // (faithful unset after-image) + Yjs invalidation + formula recompute.
      const writeHelpers: RecordWriteHelpers = createRecordWriteHelpers(req, pool)
      const recordWriteService = new RecordWriteService(pool, eventBus, writeHelpers)
      if (yjsInvalidator) {
        recordWriteService.setPostCommitHooks([createYjsInvalidationPostCommitHook(yjsInvalidator)])
      }
      try {
        const result = await recordWriteService.patchRecords({
          sheetId,
          changesByRecord: new Map([[recordId, selectedDiff]]),
          actorId: getRequestActorId(req),
          fields,
          visiblePropertyFields: readableEchoFields,
          visiblePropertyFieldIds: readableEchoFieldIds,
          attachmentFields,
          fieldById,
          capabilities,
          sheetScope,
          access,
          source: 'restore',
        })
        const newVersion = result.updated.find((u) => u.recordId === recordId)?.version ?? currentVersion + 1
        return res.json({ ok: true, data: { recordId, newVersion, noop: false, restoredFieldIds, skippedFieldIds: [] } })
      } catch (err) {
        if (err instanceof ServiceVersionConflictError || err instanceof RecordServiceVersionConflictError) {
          return res.status(409).json({ ok: false, error: { code: 'VERSION_CONFLICT', message: (err as Error).message } })
        }
        if (err instanceof ServiceFieldForbiddenError || err instanceof RecordServiceFieldForbiddenError) {
          return res.status(403).json({ ok: false, error: { code: 'RESTORE_FORBIDDEN', message: (err as Error).message } })
        }
        if (err instanceof ServiceValidationError || err instanceof RecordServiceValidationError) {
          return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: (err as Error).message } })
        }
        throw err
      }
    } catch (err) {
      if (isUndefinedTableError(err, 'meta_record_revisions')) {
        return res.status(404).json({ ok: false, error: { code: 'VERSION_NOT_FOUND', message: 'No revision history available' } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] record restore failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to restore record' } })
    }
  })

  router.get('/sheets/:sheetId/records/:recordId/subscriptions', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    const recordId = typeof req.params.recordId === 'string' ? req.params.recordId.trim() : ''
    if (!sheetId || !recordId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId and recordId are required' } })
    }

    try {
      const pool = poolManager.get()
      const readable = await requireRecordReadable(req, pool.query.bind(pool), sheetId, recordId)
      if ('status' in readable) return res.status(readable.status).json(readable.body)

      const status = await getRecordSubscriptionStatus(pool.query.bind(pool), {
        sheetId,
        recordId,
        userId: readable.access.userId,
      })
      return res.json({
        ok: true,
        data: {
          subscribed: status.subscribed,
          subscription: status.subscription,
        },
      })
    } catch (err) {
      if (isUndefinedTableError(err, 'meta_record_subscriptions')) {
        return res.json({ ok: true, data: { subscribed: false, subscription: null } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] list record subscriptions failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list record subscriptions' } })
    }
  })

  router.put('/sheets/:sheetId/records/:recordId/subscriptions/me', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    const recordId = typeof req.params.recordId === 'string' ? req.params.recordId.trim() : ''
    if (!sheetId || !recordId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId and recordId are required' } })
    }

    try {
      const pool = poolManager.get()
      const readable = await requireRecordReadable(req, pool.query.bind(pool), sheetId, recordId)
      if ('status' in readable) return res.status(readable.status).json(readable.body)

      const subscription = await subscribeRecord(pool.query.bind(pool), {
        sheetId,
        recordId,
        userId: readable.access.userId,
      })
      return res.json({ ok: true, data: { subscribed: true, subscription } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] subscribe record failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to subscribe record' } })
    }
  })

  router.delete('/sheets/:sheetId/records/:recordId/subscriptions/me', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    const recordId = typeof req.params.recordId === 'string' ? req.params.recordId.trim() : ''
    if (!sheetId || !recordId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId and recordId are required' } })
    }

    try {
      const pool = poolManager.get()
      const readable = await requireRecordReadable(req, pool.query.bind(pool), sheetId, recordId)
      if ('status' in readable) return res.status(readable.status).json(readable.body)

      await unsubscribeRecord(pool.query.bind(pool), {
        sheetId,
        recordId,
        userId: readable.access.userId,
      })
      return res.json({ ok: true, data: { subscribed: false, subscription: null } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] unsubscribe record failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to unsubscribe record' } })
    }
  })

  router.get('/record-subscription-notifications', async (req: Request, res: Response) => {
    const limitParam = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 50
    const offsetParam = typeof req.query.offset === 'string' ? Number.parseInt(req.query.offset, 10) : 0
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 100) : 50
    const offset = Number.isFinite(offsetParam) ? Math.max(offsetParam, 0) : 0
    const sheetId = typeof req.query.sheetId === 'string' && req.query.sheetId.trim() ? req.query.sheetId.trim() : undefined
    const recordId = typeof req.query.recordId === 'string' && req.query.recordId.trim() ? req.query.recordId.trim() : undefined

    try {
      const pool = poolManager.get()
      const access = await resolveRequestAccess(req)
      if (!access.userId) return res.status(401).json({ error: 'Authentication required' })
      const items = await listRecordSubscriptionNotifications(pool.query.bind(pool), {
        userId: access.userId,
        sheetId,
        recordId,
        limit,
        offset,
      })
      return res.json({ ok: true, data: { items, limit, offset } })
    } catch (err) {
      if (isUndefinedTableError(err, 'meta_record_subscription_notifications')) {
        return res.json({ ok: true, data: { items: [], limit, offset } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] list record subscription notifications failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list record subscription notifications' } })
    }
  })

  // Notification Center S1 — unread count for the bell badge (actor's own notifications).
  router.get('/record-subscription-notifications/unread-count', async (req: Request, res: Response) => {
    try {
      const access = await resolveRequestAccess(req)
      if (!access.userId) return res.status(401).json({ error: 'Authentication required' })
      const count = await countUnreadRecordSubscriptionNotifications(poolManager.get().query.bind(poolManager.get()), { userId: access.userId })
      return res.json({ ok: true, data: { count } })
    } catch (err) {
      if (isUndefinedTableError(err, 'meta_record_subscription_notifications')) return res.json({ ok: true, data: { count: 0 } })
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] unread notification count failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to count unread notifications' } })
    }
  })

  // Notification Center S1 — mark a set of the actor's OWN notifications read (self-scoped in SQL).
  router.post('/record-subscription-notifications/mark-read', async (req: Request, res: Response) => {
    const rawIds = (req.body as { ids?: unknown } | null | undefined)?.ids
    if (!Array.isArray(rawIds)) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'ids must be an array' } })
    }
    const ids = rawIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    try {
      const access = await resolveRequestAccess(req)
      if (!access.userId) return res.status(401).json({ error: 'Authentication required' })
      const updated = await markRecordSubscriptionNotificationsRead(poolManager.get().query.bind(poolManager.get()), { userId: access.userId, ids })
      return res.json({ ok: true, data: { updated } })
    } catch (err) {
      if (isUndefinedTableError(err, 'meta_record_subscription_notifications')) return res.json({ ok: true, data: { updated: 0 } })
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] mark notifications read failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to mark notifications read' } })
    }
  })

  // Notification Center S1 — mark ALL of the actor's own notifications read.
  router.post('/record-subscription-notifications/mark-all-read', async (req: Request, res: Response) => {
    try {
      const access = await resolveRequestAccess(req)
      if (!access.userId) return res.status(401).json({ error: 'Authentication required' })
      const updated = await markAllRecordSubscriptionNotificationsRead(poolManager.get().query.bind(poolManager.get()), { userId: access.userId })
      return res.json({ ok: true, data: { updated } })
    } catch (err) {
      if (isUndefinedTableError(err, 'meta_record_subscription_notifications')) return res.json({ ok: true, data: { updated: 0 } })
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] mark all notifications read failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to mark all notifications read' } })
    }
  })

  router.put('/sheets/:sheetId/records/:recordId/permissions', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    const recordId = typeof req.params.recordId === 'string' ? req.params.recordId.trim() : ''
    if (!sheetId || !recordId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId and recordId are required' } })
    }

    const schema = z.object({
      subjectType: z.enum(['user', 'role', 'member-group']),
      subjectId: z.string().min(1),
      accessLevel: z.enum(['read', 'write', 'admin']),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const pool = poolManager.get()
      const sheet = await loadSheetRow(pool.query.bind(pool), sheetId)
      if (!sheet) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      const { access, capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageSheetAccess) return sendForbidden(res)

      const recordCheck = await pool.query('SELECT id FROM meta_records WHERE id = $1 AND sheet_id = $2', [recordId, sheetId])
      if (recordCheck.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Record not found: ${recordId}` } })
      }

      const { subjectType, subjectId, accessLevel } = parsed.data
      if (subjectType === 'user') {
        const userCheck = await pool.query('SELECT id FROM users WHERE id = $1', [subjectId])
        if (userCheck.rows.length === 0) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `User not found: ${subjectId}` } })
        }
      } else if (subjectType === 'role') {
        const roleCheck = await pool.query('SELECT id FROM roles WHERE id = $1', [subjectId])
        if (roleCheck.rows.length === 0) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Role not found: ${subjectId}` } })
        }
      } else {
        const groupCheck = await pool.query('SELECT id FROM platform_member_groups WHERE id::text = $1', [subjectId])
        if (groupCheck.rows.length === 0) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Member group not found: ${subjectId}` } })
        }
      }

      await pool.query(
        `INSERT INTO record_permissions(sheet_id, record_id, subject_type, subject_id, access_level, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (record_id, subject_type, subject_id)
         DO UPDATE SET access_level = EXCLUDED.access_level`,
        [sheetId, recordId, subjectType, subjectId, accessLevel, access.userId ?? null],
      )

      return res.json({
        ok: true,
        data: { sheetId, recordId, subjectType, subjectId, accessLevel },
      })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] update record permission failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update record permission' } })
    }
  })

  router.delete('/sheets/:sheetId/records/:recordId/permissions/:permissionId', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    const recordId = typeof req.params.recordId === 'string' ? req.params.recordId.trim() : ''
    const permissionId = typeof req.params.permissionId === 'string' ? req.params.permissionId.trim() : ''
    if (!sheetId || !recordId || !permissionId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId, recordId, and permissionId are required' } })
    }

    try {
      const pool = poolManager.get()
      const sheet = await loadSheetRow(pool.query.bind(pool), sheetId)
      if (!sheet) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageSheetAccess) return sendForbidden(res)

      const result = await pool.query(
        'DELETE FROM record_permissions WHERE id = $1 AND sheet_id = $2 AND record_id = $3',
        [permissionId, sheetId, recordId],
      )
      if ((result.rowCount ?? 0) === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Permission not found: ${permissionId}` } })
      }

      return res.json({ ok: true, data: { deleted: true, permissionId } })
    } catch (err) {
      if (isUndefinedTableError(err, 'record_permissions')) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Permission not found: ${permissionId}` } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] delete record permission failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete record permission' } })
    }
  })

  router.get('/fields', async (req: Request, res: Response) => {
    const sheetId = typeof req.query.sheetId === 'string' ? req.query.sheetId.trim() : ''
    if (!sheetId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId is required' } })
    }

    try {
      const pool = poolManager.get()
      const sheetRes = await pool.query('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL', [sheetId])
      if (sheetRes.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canRead) return sendForbidden(res)

      const result = await pool.query(
        'SELECT id, name, type, property, "order" FROM meta_fields WHERE sheet_id = $1 ORDER BY "order" ASC, id ASC LIMIT 500',
        [sheetId],
      )
      const fields = result.rows.map((r: any) => serializeFieldRow(r))
      return res.json({ ok: true, data: { fields } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] list fields failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list fields' } })
    }
  })

  router.post('/fields', async (req: Request, res: Response) => {
    const schema = z.object({
      id: z.string().min(1).max(50).optional(),
      sheetId: z.string().min(1).max(50),
      name: z.string().min(1).max(255),
      type: z.enum(MULTITABLE_FIELD_INPUT_TYPES).default('string'),
      property: z.record(z.unknown()).optional(),
      order: z.number().int().nonnegative().optional(),
    })

    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    const sheetId = parsed.data.sheetId
    const fieldId = parsed.data.id ?? buildId('fld').slice(0, 50)
    const name = parsed.data.name.trim()
    const requestedType = parsed.data.type
    const rawProperty = parsed.data.property ?? {}
    const desiredOrder = parsed.data.order

    try {
      const pool = poolManager.get()
      const sheetRes = await pool.query('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL', [sheetId])
      if (sheetRes.rows.length === 0) {
        throw new NotFoundError(`Sheet not found: ${sheetId}`)
      }
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageFields) return sendForbidden(res)
      await pool.transaction(async ({ query }) => {
        const { type, property } = await normalizeFieldWriteInput(
          query as unknown as QueryFn,
          sheetId,
          requestedType,
          rawProperty,
        )
        const configError = await validateLookupRollupConfig(req, query, sheetId, type, property)
        if (configError) {
          throw new ValidationError(configError)
        }
        // ②a §2a.2 — cross-base WALL (create). Fire only when the payload explicitly carries a link
        // foreign-sheet key (any alias), mirroring the aiShortcut/expression presence gates.
        if (linkForeignKeyInPayload(parsed.data.property)) {
          const lockTargetSheetId = getLinkTargetSheetIdForMaterializationLock(type, property)
          if (lockTargetSheetId) {
            await acquireLinkTargetMaterializationLock(query as unknown as QueryFn, lockTargetSheetId)
          }
          const linkBaseError = await validateLinkFieldConfig(req, query, sheetId, type, property)
          if (linkBaseError) {
            throw new ValidationError(linkBaseError)
          }
        }
        // A2 (§2.1): sanitizeFieldProperty passes unknown keys through, so the
        // aiShortcut config is validated explicitly at this write chokepoint.
        const aiShortcutError = await validateAiShortcutFieldProperty(query as unknown as QueryFn, sheetId, property)
        if (aiShortcutError) {
          throw new ValidationError(aiShortcutError)
        }
        if (type === 'formula' && property?.expression) {
          const formulaError = await validateFormulaReferences(query, sheetId, fieldId, String(property.expression))
          if (formulaError) throw new ValidationError(formulaError)
        }

        let order = desiredOrder
        if (typeof order !== 'number') {
          const maxRes = await query('SELECT COALESCE(MAX("order"), -1) AS max_order FROM meta_fields WHERE sheet_id = $1', [sheetId])
          const maxOrder = Number((maxRes as any).rows?.[0]?.max_order ?? -1)
          order = Number.isFinite(maxOrder) ? maxOrder + 1 : 0
        } else {
          await query('UPDATE meta_fields SET "order" = "order" + 1 WHERE sheet_id = $1 AND "order" >= $2', [sheetId, order])
        }

        const insert = await query(
          `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order")
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)
           RETURNING id, name, type, property, "order"`,
          [fieldId, sheetId, name, type, JSON.stringify(property), order],
        )
        const row = (insert as any).rows?.[0]
        if (!row) throw new Error('Insert returned no rows')

        // Track formula dependencies
        if (type === 'formula' && property?.expression) {
          const refs = multitableFormulaEngine.extractFieldReferences(String(property.expression))
          await syncFormulaDependencies(query, sheetId, fieldId, refs)
        }

        if (type === 'autoNumber') {
          await backfillAutoNumberField(query, sheetId, fieldId, property)
        }
      })

      const fieldRes = await pool.query(
        'SELECT id, name, type, property, "order" FROM meta_fields WHERE id = $1',
        [fieldId],
      )
      invalidateFieldCache(sheetId)
      return res.status(201).json({ ok: true, data: { field: serializeFieldRow((fieldRes as any).rows[0]) } })
    } catch (err: any) {
      if (err instanceof NotFoundError) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: err.message } })
      }
      if (err instanceof PermissionError) {
        return sendForbidden(res, err.message)
      }
      if (err instanceof ValidationError) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: err.message } })
      }
      if (typeof err?.code === 'string' && err.code === '23505') {
        return res.status(409).json({ ok: false, error: { code: 'CONFLICT', message: 'Field name already exists in this sheet' } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] create field failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create field' } })
    }
  })

  router.post('/dashboard/query', async (req: Request, res: Response) => {
    const schema = z.object({
      sheetId: z.string().min(1).max(50).optional(),
      viewId: z.string().min(1).max(50).optional(),
      widgets: z.array(dashboardWidgetSchema).min(1).max(12),
    })

    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const pool = poolManager.get()
      const refererContext = extractMultitableRecordCreateContextFromUrl(
        req.get('referer') ?? req.get('referrer'),
      )
      const resolved = await resolveMetaSheetId(pool as unknown as { query: QueryFn }, {
        sheetId: parsed.data.sheetId ?? refererContext.sheetId,
        viewId: parsed.data.viewId ?? refererContext.viewId,
      })
      const sheetId = resolved.sheetId
      const viewConfig = resolved.view
      const widgets = parsed.data.widgets.map((widget) => serializeDashboardWidget(widget as DashboardWidgetInput))
      const { access, capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)

      if (!access.userId) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      if (!capabilities.canRead) return sendForbidden(res)

      const fields = await loadSheetFields(pool as unknown as { query: QueryFn }, sheetId)
      const fieldScopeMap = access.userId
        ? await loadFieldPermissionScopeMap(pool.query.bind(pool), sheetId, access.userId)
        : new Map<string, FieldPermissionScope>()
      const visibleFields = filterVisiblePropertyFields(fields).filter((field) => {
        const permission = deriveFieldPermissions(fields, capabilities, {
          hiddenFieldIds: viewConfig?.hiddenFieldIds ?? [],
          fieldScopeMap,
        })[field.id]
        return permission?.visible !== false
      })

      const visibleFieldsById = new Map(visibleFields.map((field) => [field.id, field] as const))
      for (const widget of widgets) {
        const groupField = visibleFieldsById.get(widget.groupByFieldId)
        if (!groupField) {
          throw new ValidationError(`Dashboard group field not available: ${widget.groupByFieldId}`)
        }
        if (!DASHBOARD_GROUPABLE_FIELD_TYPES.has(groupField.type)) {
          throw new ValidationError(`Field ${groupField.name} does not support dashboard grouping`)
        }
        if (widget.metric !== 'count') {
          const valueField = widget.valueFieldId ? visibleFieldsById.get(widget.valueFieldId) : null
          if (!valueField) {
            throw new ValidationError('valueFieldId is required for sum and avg dashboard metrics')
          }
          if (!DASHBOARD_NUMERIC_FIELD_TYPES.has(valueField.type)) {
            throw new ValidationError(`Field ${valueField.name} must be numeric for dashboard ${widget.metric}`)
          }
        }
      }

      const rows = await loadDashboardSourceRows({
        req,
        query: pool.query.bind(pool),
        sheetId,
        viewConfig,
        fields,
        visibleFields,
        widgets,
        access,
        capabilities,
      })

      const results = widgets.map((widget) => buildDashboardWidgetResult({
        widget,
        rows,
        fields: visibleFields,
      }))

      return res.json({
        ok: true,
        data: {
          sheetId,
          viewId: viewConfig?.id ?? null,
          widgets: results,
        },
      })
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: err.message } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] dashboard query failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load dashboard data' } })
    }
  })

  router.post('/person-fields/prepare', async (req: Request, res: Response) => {
    const schema = z.object({
      sheetId: z.string().min(1).max(50),
    })

    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const pool = poolManager.get()
      const sourceSheet = await loadSheetRow(pool.query.bind(pool), parsed.data.sheetId)
      if (!sourceSheet) throw new NotFoundError(`Sheet not found: ${parsed.data.sheetId}`)
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), parsed.data.sheetId)
      if (!capabilities.canManageFields) return sendForbidden(res)
      const preset = await pool.transaction(async ({ query }) => {
        const baseId = sourceSheet.baseId ?? await ensureLegacyBase(query as unknown as QueryFn)
        return ensurePeopleSheetPreset(query as unknown as QueryFn, baseId)
      })

      return res.json({ ok: true, data: { targetSheet: preset.sheet, fieldProperty: preset.fieldProperty } })
    } catch (err) {
      if (err instanceof NotFoundError) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: err.message } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] prepare person field failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to prepare person field preset' } })
    }
  })

  router.get('/people-search', async (req: Request, res: Response) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    const limit = Math.min(20, Math.max(1, Number(req.query.limit ?? 10)))
    const baseId = typeof req.query.baseId === 'string' ? req.query.baseId.trim() : ''

    if (!baseId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'baseId is required' } })
    }

    try {
      const pool = poolManager.get()
      const query = pool.query.bind(pool)

      const sheetsRes = await query(
        `SELECT id FROM meta_sheets WHERE base_id = $1 AND description = $2 AND deleted_at IS NULL LIMIT 1`,
        [baseId, SYSTEM_PEOPLE_SHEET_DESCRIPTION],
      )
      const peopleSheetId = (sheetsRes.rows[0] as any)?.id

      if (!peopleSheetId) {
        return res.json({ ok: true, data: { items: [] } })
      }

      const { access, capabilities } = await resolveSheetReadableCapabilities(req, query, peopleSheetId)
      if (!capabilities.canRead) return sendForbidden(res)

      // F5 (#2106 §3 F5): gate the people sheet's default display field by its own layer-2 ∧ layer-3 allowed set.
      // §2a.3 DISPLAY-PROJECTION chokepoint (resolveDisplayFieldTaint) — C2 (auto-pick parity): drop any
      // tainted formula id from the auto-pick candidate set so a formula-over-denied-lookup can never be
      // selected as the people display (uniform with the link-picker / records-summary display guard).
      const peopleBaseAllowedFieldIds = await loadAllowedFieldIds(query, peopleSheetId, access.userId, capabilities)
      const peopleFields = await loadFieldsForSheetShared(query, peopleSheetId)
      const { allowedDisplayFieldIds: peopleAllowedFieldIds } = await resolveDisplayFieldTaint(
        req,
        query,
        peopleSheetId,
        peopleFields,
        peopleBaseAllowedFieldIds,
        null,
      )
      const summary = await loadRecordSummaries(query, peopleSheetId, { search: q, limit, offset: 0, allowedFieldIds: peopleAllowedFieldIds })
      return res.json({ ok: true, data: { items: summary.records } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] people-search failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'People search failed' } })
    }
  })

  router.patch('/fields/:fieldId', async (req: Request, res: Response) => {
    const fieldId = typeof req.params.fieldId === 'string' ? req.params.fieldId : ''
    if (!fieldId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'fieldId is required' } })
    }

    const schema = z.object({
      name: z.string().min(1).max(255).optional(),
      type: z.enum(MULTITABLE_FIELD_INPUT_TYPES).optional(),
      property: z.record(z.unknown()).optional(),
      order: z.number().int().nonnegative().optional(),
    }).refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be updated' })

    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const pool = poolManager.get()
      const existing = await pool.query(
        'SELECT id, sheet_id FROM meta_fields WHERE id = $1',
        [fieldId],
      )
      if (existing.rows.length === 0) throw new NotFoundError(`Field not found: ${fieldId}`)
      const preflightSheetId = String((existing.rows[0] as any).sheet_id ?? '')
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), preflightSheetId)
      if (!capabilities.canManageFields) return sendForbidden(res)
      let sheetId = ''
      const updated = await pool.transaction(async ({ query }) => {
        const existing = await query(
          'SELECT id, sheet_id, name, type, property, "order" FROM meta_fields WHERE id = $1',
          [fieldId],
        )
        if ((existing as any).rows.length === 0) throw new NotFoundError(`Field not found: ${fieldId}`)

        const row = (existing as any).rows[0]
        sheetId = String(row.sheet_id)
        const currentOrder = Number(row.order ?? 0)
        const currentType = mapFieldType(String(row.type))
        const currentProperty = normalizeJson(row.property)

        const nextName = typeof parsed.data.name === 'string' ? parsed.data.name.trim() : String(row.name)
        const requestedType = parsed.data.type ?? mapFieldType(String(row.type))
        const { type: nextType, property: nextProperty } = await normalizeFieldWriteInput(
          query as unknown as QueryFn,
          sheetId,
          requestedType,
          typeof parsed.data.property !== 'undefined' ? parsed.data.property : row.property,
        )
        const desiredOrder = parsed.data.order

        // Rich-longText backward-compat gate (§4) — shared with the plugin-SDK provisioning
        // property write so BOTH boundaries reject flipping a POPULATED field to rich (whose old
        // plain values were never sanitized → retroactive stored-XSS). Gated on an actual OFF→ON
        // transition so a rename-only PATCH on an already-rich/non-longText field never trips it.
        await assertRichLongTextToggleAllowed({
          query: query as unknown as Parameters<typeof assertRichLongTextToggleAllowed>[0]['query'],
          sheetId,
          fieldId,
          currentType,
          currentProperty: row.property,
          nextType,
          nextProperty,
          makeError: (message) => new ValidationError(message),
        })

        const configError = await validateLookupRollupConfig(req, query, sheetId, nextType, nextProperty)
        if (configError) {
          throw new ValidationError(configError)
        }
        // ②b decision (c) — foreignBaseId is IMMUTABLE after create. A PATCH that explicitly carries a
        // `foreignBaseId` DIFFERENT from the stored field's claim is rejected (not silently ignored).
        // Gating on the RAW payload (not nextProperty) is load-bearing: nextProperty falls back to the
        // stored property, so re-asserting nothing must not 400 (GA-T4b parity). Re-sending the SAME
        // claim is allowed (no-op). This blocks the two-step bypass (create a same-base link, then PATCH
        // a `foreignBaseId` to falsely claim cross-base) and means the wall's claim==truth check, once
        // passed at create, can never be retroactively desynced.
        if (foreignBaseIdInPayload(parsed.data.property)) {
          if (!linkForeignKeyInPayload(parsed.data.property)) {
            throw new ValidationError('foreignBaseId PATCH 必须同时携带 foreignSheetId')
          }
          const storedForeignBaseId = extractForeignBaseId(row.property)
          const payloadForeignBaseId = extractForeignBaseId(parsed.data.property)
          if (payloadForeignBaseId !== storedForeignBaseId) {
            throw new ValidationError(
              `foreignBaseId 建后不可变：当前=${storedForeignBaseId ?? 'null'}，请求=${payloadForeignBaseId ?? 'null'}`,
            )
          }
        }
        // ②a §2a.2 — cross-base WALL (update). Lazy/on-edit, exactly like the expression/aiShortcut
        // re-validation below: `nextProperty` falls back to the STORED `row.property`, so gating on the
        // RAW payload carrying a foreign-sheet key is load-bearing — a rename-only PATCH on a
        // pre-existing (possibly legacy cross-base) link must NOT reload the stored target and 400
        // (GA-T4b). Covers all foreign-key aliases.
        //
        // ALSO fire on a non-link → link TYPE CONVERSION (`nextType==='link' && currentType!=='link'`):
        // otherwise a two-step bypass slips through — POST a `string` field with a cross-base
        // `foreignSheetId` stashed in its property (the wall no-ops for non-link), then PATCH `{type:'link'}`
        // with NO property; the raw payload carries no foreign key, but `nextProperty` falls back to the
        // stored cross-base target and is canonicalized into a real link that never hit the wall. On a
        // conversion we MUST validate the effective `nextProperty`. (link→link rename keeps currentType
        // 'link' so this clause stays false → GA-T4b compat preserved.)
        if (linkForeignKeyInPayload(parsed.data.property) || (nextType === 'link' && currentType !== 'link')) {
          const lockTargetSheetId = getLinkTargetSheetIdForMaterializationLock(nextType, nextProperty)
          if (lockTargetSheetId) {
            await acquireLinkTargetMaterializationLock(query as unknown as QueryFn, lockTargetSheetId)
          }
          const linkBaseError = await validateLinkFieldConfig(req, query, sheetId, nextType, nextProperty)
          if (linkBaseError) {
            throw new ValidationError(linkBaseError)
          }
        }
        // A2 (§2.1): validate aiShortcut only when the payload explicitly carries it
        // (mirrors the lazy expression re-validation below) — a rename-only PATCH on a
        // field with a pre-existing config must not re-validate and 400.
        const aiShortcutInPayload =
          typeof parsed.data.property !== 'undefined'
          && Object.prototype.hasOwnProperty.call(parsed.data.property ?? {}, 'aiShortcut')
        if (aiShortcutInPayload) {
          const aiShortcutError = await validateAiShortcutFieldProperty(query as unknown as QueryFn, sheetId, nextProperty)
          if (aiShortcutError) {
            throw new ValidationError(aiShortcutError)
          }
        }
        // Only re-validate the expression when the caller is actually writing it
        // (lazy/on-edit): `nextProperty` falls back to the stored `row.property`, so a
        // rename-only PATCH on a pre-existing chained formula must NOT re-validate and
        // 400. Gate on the payload explicitly carrying `property.expression`.
        const expressionInPayload =
          typeof parsed.data.property !== 'undefined'
          && Object.prototype.hasOwnProperty.call(parsed.data.property ?? {}, 'expression')
        if (nextType === 'formula' && expressionInPayload && nextProperty?.expression) {
          const formulaError = await validateFormulaReferences(query, sheetId, fieldId, String(nextProperty.expression))
          if (formulaError) throw new ValidationError(formulaError)
        }
        // Reverse guard: converting a non-formula field INTO a formula must not create
        // a formula→formula edge that a formula already depends on (see findFormulaReferrers).
        if (nextType === 'formula' && currentType !== 'formula') {
          const referrers = await findFormulaReferrers(query, sheetId, fieldId)
          if (referrers.length > 0) {
            throw new ValidationError(
              `无法将该字段转换为公式：已有公式字段引用它：${referrers.map((id) => `{${id}}`).join('、')}`,
            )
          }
        }
        const hierarchyParentMutationError = await validateHierarchyParentFieldMutation(
          query as unknown as QueryFn,
          sheetId,
          fieldId,
          currentType,
          currentProperty,
          nextType,
          nextProperty,
        )
        if (hierarchyParentMutationError) {
          throw new ValidationError(hierarchyParentMutationError)
        }

        if (typeof desiredOrder === 'number' && desiredOrder !== currentOrder) {
          if (desiredOrder < currentOrder) {
            await query(
              'UPDATE meta_fields SET "order" = "order" + 1 WHERE sheet_id = $1 AND "order" >= $2 AND "order" < $3 AND id <> $4',
              [sheetId, desiredOrder, currentOrder, fieldId],
            )
          } else {
            await query(
              'UPDATE meta_fields SET "order" = "order" - 1 WHERE sheet_id = $1 AND "order" > $2 AND "order" <= $3 AND id <> $4',
              [sheetId, currentOrder, desiredOrder, fieldId],
            )
          }
        }

        const nextOrder = typeof desiredOrder === 'number' ? desiredOrder : currentOrder

        const update = await query(
          `UPDATE meta_fields
           SET name = $2, type = $3, property = $4::jsonb, "order" = $5, updated_at = now()
           WHERE id = $1
           RETURNING id, name, type, property, "order"`,
          [fieldId, nextName, nextType, JSON.stringify(nextProperty), nextOrder],
        )
        const updatedRow = (update as any).rows?.[0]
        if (!updatedRow) throw new Error('Update returned no rows')

        if (currentType === 'autoNumber' && nextType !== 'autoNumber') {
          await query('DELETE FROM meta_field_auto_number_sequences WHERE field_id = $1', [fieldId])
        }

        if (currentType !== 'autoNumber' && nextType === 'autoNumber') {
          await backfillAutoNumberField(query, sheetId, fieldId, nextProperty, { overwrite: true })
        }

        // Track formula dependencies on update
        if (nextType === 'formula' && nextProperty?.expression) {
          const refs = multitableFormulaEngine.extractFieldReferences(String(nextProperty.expression))
          await syncFormulaDependencies(query, sheetId, fieldId, refs)
        }

        return serializeFieldRow(updatedRow)
      })

      invalidateFieldCache(sheetId)
      return res.json({ ok: true, data: { field: updated } })
    } catch (err: any) {
      if (err instanceof NotFoundError) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: err.message } })
      }
      if (err instanceof PermissionError) {
        return sendForbidden(res, err.message)
      }
      if (err instanceof ValidationError) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: err.message } })
      }
      if (typeof err?.code === 'string' && err.code === '23505') {
        return res.status(409).json({ ok: false, error: { code: 'CONFLICT', message: 'Field name already exists in this sheet' } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] update field failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update field' } })
    }
  })

  router.delete('/fields/:fieldId', async (req: Request, res: Response) => {
    const fieldId = typeof req.params.fieldId === 'string' ? req.params.fieldId : ''
    if (!fieldId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'fieldId is required' } })
    }

    const cleanupViewConfig = (args: {
      filterInfo: Record<string, unknown>
      sortInfo: Record<string, unknown>
      groupInfo: Record<string, unknown>
      hiddenFieldIds: string[]
    }) => {
      const nextHidden = args.hiddenFieldIds.filter((id) => id !== fieldId)

      const rawSortRules = Array.isArray(args.sortInfo.rules) ? args.sortInfo.rules : []
      const nextSortRules = rawSortRules.filter((r) => isPlainObject(r) && r.fieldId !== fieldId)
      const nextSortInfo = nextSortRules.length > 0 ? { ...args.sortInfo, rules: nextSortRules } : {}

      const nextGroupInfo = args.groupInfo.fieldId === fieldId ? {} : args.groupInfo

      const rawConditions = Array.isArray(args.filterInfo.conditions) ? args.filterInfo.conditions : []
      const nextConditions = rawConditions.filter((c) => isPlainObject(c) && c.fieldId !== fieldId)
      const nextFilterInfo = nextConditions.length > 0 ? { ...args.filterInfo, conditions: nextConditions } : {}

      return { nextHidden, nextSortInfo, nextGroupInfo, nextFilterInfo }
    }

    try {
      const pool = poolManager.get()
      const existing = await pool.query('SELECT id, sheet_id FROM meta_fields WHERE id = $1', [fieldId])
      if (existing.rows.length === 0) throw new NotFoundError(`Field not found: ${fieldId}`)
      const sheetId = String((existing.rows[0] as any).sheet_id ?? '')
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageFields) return sendForbidden(res)
      const result = await pool.transaction(async ({ query }) => {
        const existing = await query('SELECT id, sheet_id, "order" FROM meta_fields WHERE id = $1', [fieldId])
        if ((existing as any).rows.length === 0) throw new NotFoundError(`Field not found: ${fieldId}`)
        const row = (existing as any).rows[0]
        const sheetId = String(row.sheet_id)
        const order = Number(row.order ?? 0)

        await query('DELETE FROM meta_fields WHERE id = $1', [fieldId])
        await query('DELETE FROM meta_field_auto_number_sequences WHERE field_id = $1', [fieldId])

        try {
          await query('DELETE FROM meta_links WHERE field_id = $1', [fieldId])
        } catch (err) {
          if (!isUndefinedTableError(err, 'meta_links')) throw err
        }

        // lock-exempt: field-delete schema op — drops the deleted field's key sheet-wide; not a per-record user edit.
        await query('UPDATE meta_records SET data = data - $1 WHERE sheet_id = $2', [fieldId, sheetId])
        await query('UPDATE meta_fields SET "order" = "order" - 1 WHERE sheet_id = $1 AND "order" > $2', [sheetId, order])

        const views = await query(
          'SELECT id, filter_info, sort_info, group_info, hidden_field_ids FROM meta_views WHERE sheet_id = $1',
          [sheetId],
        )
        for (const v of (views as any).rows as any[]) {
          const filterInfo = normalizeJson(v.filter_info)
          const sortInfo = normalizeJson(v.sort_info)
          const groupInfo = normalizeJson(v.group_info)
          const hiddenFieldIds = normalizeJsonArray(v.hidden_field_ids)

          const { nextHidden, nextSortInfo, nextGroupInfo, nextFilterInfo } = cleanupViewConfig({
            filterInfo,
            sortInfo,
            groupInfo,
            hiddenFieldIds,
          })

          const changed =
            nextHidden.length !== hiddenFieldIds.length ||
            JSON.stringify(nextSortInfo) !== JSON.stringify(sortInfo) ||
            JSON.stringify(nextGroupInfo) !== JSON.stringify(groupInfo) ||
            JSON.stringify(nextFilterInfo) !== JSON.stringify(filterInfo)
          if (!changed) continue

          await query(
            'UPDATE meta_views SET filter_info = $2::jsonb, sort_info = $3::jsonb, group_info = $4::jsonb, hidden_field_ids = $5::jsonb WHERE id = $1',
            [String(v.id), JSON.stringify(nextFilterInfo), JSON.stringify(nextSortInfo), JSON.stringify(nextGroupInfo), JSON.stringify(nextHidden)],
          )
        }

        return { deleted: fieldId, sheetId }
      })

      invalidateFieldCache(result.sheetId)
      invalidateViewConfigCache()
      return res.json({ ok: true, data: result })
    } catch (err: any) {
      if (err instanceof NotFoundError) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: err.message } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] delete field failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete field' } })
    }
  })

  router.get('/views', async (req: Request, res: Response) => {
    const sheetId = typeof req.query.sheetId === 'string' ? req.query.sheetId.trim() : ''
    if (!sheetId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId is required' } })
    }

    try {
      const pool = poolManager.get()
      const sheetRes = await pool.query('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL', [sheetId])
      if (sheetRes.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canRead) return sendForbidden(res)

      let result = await pool.query(
        'SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE sheet_id = $1 ORDER BY created_at ASC LIMIT 200',
        [sheetId],
      )

      if (result.rows.length === 0 && capabilities.canManageViews) {
        const defaultId = buildId('view')
        await pool.query(
          `INSERT INTO meta_views (id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb)
           ON CONFLICT (id) DO NOTHING`,
          [defaultId, sheetId, '默认视图', 'grid', '{}', '{}', '{}', '[]', '{}'],
        )
        result = await pool.query(
          'SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE sheet_id = $1 ORDER BY created_at ASC LIMIT 200',
          [sheetId],
        )
      }

      const views: UniverMetaViewConfig[] = result.rows.map((r: any) => ({
        id: String(r.id),
        sheetId: String(r.sheet_id),
        name: String(r.name),
        type: String(r.type ?? 'grid'),
        filterInfo: normalizeJson(r.filter_info),
        sortInfo: normalizeJson(r.sort_info),
        groupInfo: normalizeJson(r.group_info),
        hiddenFieldIds: normalizeJsonArray(r.hidden_field_ids),
        config: normalizeJson(r.config),
      }))

      // #2052 (b): redact denied-field filter literals per the requester's allowed-field set.
      const allowedFieldIds = await loadAllowedFieldIds(pool.query.bind(pool), sheetId, (await resolveRequestAccess(req)).userId, capabilities)
      return res.json({ ok: true, data: { views: views.map((view: UniverMetaViewConfig) => redactViewConfigFilterLiterals(view, allowedFieldIds)) } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] list views failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list views' } })
    }
  })

  router.post('/views', async (req: Request, res: Response) => {
    const schema = z.object({
      id: z.string().min(1).max(50).optional(),
      sheetId: z.string().min(1).max(50),
      name: z.string().min(1).max(255),
      type: z.string().min(1).max(50).optional(),
      filterInfo: z.record(z.unknown()).optional(),
      sortInfo: z.record(z.unknown()).optional(),
      groupInfo: z.record(z.unknown()).optional(),
      hiddenFieldIds: z.array(z.string().min(1)).optional(),
      config: z.record(z.unknown()).optional(),
    })

    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    const viewId = parsed.data.id ?? buildId('view')
    const sheetId = parsed.data.sheetId
    const name = parsed.data.name
    const type = parsed.data.type ?? 'grid'

    try {
      const pool = poolManager.get()
      const sheetRes = await pool.query('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL', [sheetId])
      if (sheetRes.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageViews) return sendForbidden(res)

      const incomingConfig: Record<string, unknown> = normalizeHierarchyViewConfig(type, parsed.data.config ?? {})
      const incomingRules = incomingConfig.conditionalFormattingRules
      if (Array.isArray(incomingRules) && incomingRules.length > CONDITIONAL_FORMATTING_RULE_LIMIT) {
        return res.status(400).json({
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: `conditionalFormattingRules exceeds limit of ${CONDITIONAL_FORMATTING_RULE_LIMIT}`,
          },
        })
      }
      if (incomingRules !== undefined) {
        incomingConfig.conditionalFormattingRules = sanitizeConditionalFormattingRules(incomingRules)
      }
      const ganttConfigError = await validateGanttDependencyConfig(pool.query.bind(pool), sheetId, type, incomingConfig)
      if (ganttConfigError) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: ganttConfigError } })
      }
      const hierarchyConfigError = await validateHierarchyParentLinkConfig(pool.query.bind(pool), sheetId, type, incomingConfig)
      if (hierarchyConfigError) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: hierarchyConfigError } })
      }

      await pool.query(
        `INSERT INTO meta_views (id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb)`,
        [
          viewId,
          sheetId,
          name,
          type,
          JSON.stringify(parsed.data.filterInfo ?? {}),
          JSON.stringify(parsed.data.sortInfo ?? {}),
          JSON.stringify(parsed.data.groupInfo ?? {}),
          JSON.stringify(parsed.data.hiddenFieldIds ?? []),
          JSON.stringify(incomingConfig),
        ],
      )

      const view: UniverMetaViewConfig = {
        id: viewId,
        sheetId,
        name,
        type,
        filterInfo: parsed.data.filterInfo ?? {},
        sortInfo: parsed.data.sortInfo ?? {},
        groupInfo: parsed.data.groupInfo ?? {},
        hiddenFieldIds: parsed.data.hiddenFieldIds ?? [],
        config: incomingConfig,
      }

      metaViewConfigCache.set(viewId, view)
      const allowedFieldIds = await loadAllowedFieldIds(pool.query.bind(pool), sheetId, (await resolveRequestAccess(req)).userId, capabilities)
      return res.status(201).json({ ok: true, data: { view: redactViewConfigFilterLiterals(view, allowedFieldIds) } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] create view failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create view' } })
    }
  })

  router.patch('/views/:viewId', async (req: Request, res: Response) => {
    const viewId = req.params.viewId
    if (!viewId || typeof viewId !== 'string') {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'viewId is required' } })
    }

    const schema = z.object({
      name: z.string().min(1).max(255).optional(),
      type: z.string().min(1).max(50).optional(),
      filterInfo: z.record(z.unknown()).optional(),
      sortInfo: z.record(z.unknown()).optional(),
      groupInfo: z.record(z.unknown()).optional(),
      hiddenFieldIds: z.array(z.string().min(1)).optional(),
      config: z.record(z.unknown()).optional(),
    })

    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const pool = poolManager.get()
      const current = await pool.query(
        'SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE id = $1',
        [viewId],
      )
      if (current.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `View not found: ${viewId}` } })
      }

      const row: any = current.rows[0]
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), String(row.sheet_id))
      if (!capabilities.canManageViews) return sendForbidden(res)
      // #2068 re-save guard: compute the writer's allowed-field set up front, then merge the incoming
      // filterInfo against the current DB filter so a redacted denied condition (echoed back with NO `value`)
      // preserves the persisted literal instead of erasing it; reject 400 on a structural mismatch.
      const allowedFieldIds = await loadAllowedFieldIds(pool.query.bind(pool), String(row.sheet_id), (await resolveRequestAccess(req)).userId, capabilities)
      const nextName = parsed.data.name ?? String(row.name)
      const nextType = parsed.data.type ?? String(row.type ?? 'grid')
      let nextFilter: Record<string, unknown> = normalizeJson(row.filter_info)
      if (parsed.data.filterInfo !== undefined) {
        const mergedFilter = mergeRedactedFilterInfoForUpdate(parsed.data.filterInfo, normalizeJson(row.filter_info), allowedFieldIds)
        if (mergedFilter === null) {
          return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Cannot re-save a hidden filter value that no longer matches the saved view; resubmit an explicit value or remove the condition.' } })
        }
        nextFilter = mergedFilter
      }
      const nextSort = parsed.data.sortInfo ?? normalizeJson(row.sort_info)
      const nextGroup = parsed.data.groupInfo ?? normalizeJson(row.group_info)
      const nextHiddenFieldIds = parsed.data.hiddenFieldIds ?? normalizeJsonArray(row.hidden_field_ids)
      const nextConfig = normalizeHierarchyViewConfig(
        nextType,
        parsed.data.config ?? normalizeJson(row.config),
      )
      const incomingRules = (nextConfig as Record<string, unknown>).conditionalFormattingRules
      if (Array.isArray(incomingRules) && incomingRules.length > CONDITIONAL_FORMATTING_RULE_LIMIT) {
        return res.status(400).json({
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: `conditionalFormattingRules exceeds limit of ${CONDITIONAL_FORMATTING_RULE_LIMIT}`,
          },
        })
      }
      if (incomingRules !== undefined) {
        ;(nextConfig as Record<string, unknown>).conditionalFormattingRules =
          sanitizeConditionalFormattingRules(incomingRules)
      }
      if (parsed.data.config !== undefined || parsed.data.type !== undefined) {
        const ganttConfigError = await validateGanttDependencyConfig(
          pool.query.bind(pool),
          String(row.sheet_id),
          nextType,
          nextConfig as Record<string, unknown>,
        )
        if (ganttConfigError) {
          return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: ganttConfigError } })
        }
        const hierarchyConfigError = await validateHierarchyParentLinkConfig(
          pool.query.bind(pool),
          String(row.sheet_id),
          nextType,
          nextConfig as Record<string, unknown>,
        )
        if (hierarchyConfigError) {
          return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: hierarchyConfigError } })
        }
      }

      await pool.query(
        `UPDATE meta_views
         SET name = $2, type = $3, filter_info = $4::jsonb, sort_info = $5::jsonb, group_info = $6::jsonb, hidden_field_ids = $7::jsonb, config = $8::jsonb
         WHERE id = $1`,
        [
          viewId,
          nextName,
          nextType,
          JSON.stringify(nextFilter ?? {}),
          JSON.stringify(nextSort ?? {}),
          JSON.stringify(nextGroup ?? {}),
          JSON.stringify(nextHiddenFieldIds ?? []),
          JSON.stringify(nextConfig ?? {}),
        ],
      )

      const view: UniverMetaViewConfig = {
        id: viewId,
        sheetId: String(row.sheet_id),
        name: nextName,
        type: nextType,
        filterInfo: nextFilter ?? {},
        sortInfo: nextSort ?? {},
        groupInfo: nextGroup ?? {},
        hiddenFieldIds: nextHiddenFieldIds ?? [],
        config: nextConfig ?? {},
      }

      metaViewConfigCache.set(viewId, view)
      return res.json({ ok: true, data: { view: redactViewConfigFilterLiterals(view, allowedFieldIds) } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] update view failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update view' } })
    }
  })

  router.get('/sheets/:sheetId/views/:viewId/form-share', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    const viewId = typeof req.params.viewId === 'string' ? req.params.viewId.trim() : ''
    if (!sheetId || !viewId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId and viewId are required' } })
    }

    try {
      const pool = poolManager.get()
      const current = await pool.query(
        'SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE id = $1',
        [viewId],
      )
      if (current.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `View not found: ${viewId}` } })
      }

      const row: any = current.rows[0]
      if (String(row.sheet_id) !== sheetId) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `View ${viewId} does not belong to sheet ${sheetId}` } })
      }

      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageViews) return sendForbidden(res)

      const view: UniverMetaViewConfig = {
        id: viewId,
        sheetId,
        name: String(row.name),
        type: String(row.type ?? 'grid'),
        filterInfo: normalizeJson(row.filter_info),
        sortInfo: normalizeJson(row.sort_info),
        groupInfo: normalizeJson(row.group_info),
        hiddenFieldIds: normalizeJsonArray(row.hidden_field_ids),
        config: normalizeJson(row.config),
      }

      return res.json({ ok: true, data: await serializePublicFormShareConfig(pool.query.bind(pool), view) })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] get form share config failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load form share config' } })
    }
  })

  router.patch('/sheets/:sheetId/views/:viewId/form-share', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    const viewId = typeof req.params.viewId === 'string' ? req.params.viewId.trim() : ''
    if (!sheetId || !viewId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId and viewId are required' } })
    }

    const schema = z.object({
      enabled: z.boolean().optional(),
      expiresAt: z.string().datetime().nullable().optional(),
      accessMode: z.enum(['public', 'dingtalk', 'dingtalk_granted']).optional(),
      allowedUserIds: z.array(z.string().min(1)).optional(),
      allowedMemberGroupIds: z.array(z.string().min(1)).optional(),
      // A4 form-logic config (multi-page/section · URL-prefill · post-submit
      // redirect · thank-you). Freeform here — the canonical normalizer
      // (sanitizeFormLayout) bounds/validates every field, including the
      // open-redirect-safe URL check, before persisting under
      // view.config.formLayout (SEPARATE from publicForm access-control).
      // `null` clears it; omitted leaves it untouched.
      formLayout: z.unknown().optional(),
    })

    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const pool = poolManager.get()
      const current = await pool.query(
        'SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE id = $1',
        [viewId],
      )
      if (current.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `View not found: ${viewId}` } })
      }

      const row: any = current.rows[0]
      if (String(row.sheet_id) !== sheetId) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `View ${viewId} does not belong to sheet ${sheetId}` } })
      }

      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageViews) return sendForbidden(res)

      const nextConfig = normalizeJson(row.config)
      const existingPublicForm = getPublicFormConfig({
        id: viewId,
        sheetId,
        name: String(row.name),
        type: String(row.type ?? 'grid'),
        filterInfo: normalizeJson(row.filter_info),
        sortInfo: normalizeJson(row.sort_info),
        groupInfo: normalizeJson(row.group_info),
        hiddenFieldIds: normalizeJsonArray(row.hidden_field_ids),
        config: nextConfig,
      })
      const nextEnabled = parsed.data.enabled ?? (existingPublicForm?.enabled === true)
      const nextPublicToken = (() => {
        const existing = typeof existingPublicForm?.publicToken === 'string' ? existingPublicForm.publicToken.trim() : ''
        if (existing) return existing
        return nextEnabled ? buildPublicFormToken() : ''
      })()
      const nextPublicForm: PublicFormConfig = {
        ...(existingPublicForm ?? {}),
        enabled: nextEnabled,
        publicToken: nextPublicToken || undefined,
        ...(parsed.data.expiresAt !== undefined
          ? (parsed.data.expiresAt ? { expiresAt: parsed.data.expiresAt } : { expiresAt: null })
          : (existingPublicForm?.expiresAt ?? existingPublicForm?.expiresOn) !== undefined
            ? { expiresAt: existingPublicForm?.expiresAt ?? existingPublicForm?.expiresOn }
            : {}),
        accessMode: parsed.data.accessMode ?? normalizePublicFormAccessMode(existingPublicForm?.accessMode),
        allowedUserIds: parsed.data.allowedUserIds !== undefined
          ? normalizePublicFormAllowlistIds(parsed.data.allowedUserIds)
          : normalizePublicFormAllowlistIds(existingPublicForm?.allowedUserIds),
        allowedMemberGroupIds: parsed.data.allowedMemberGroupIds !== undefined
          ? normalizePublicFormAllowlistIds(parsed.data.allowedMemberGroupIds)
          : normalizePublicFormAllowlistIds(existingPublicForm?.allowedMemberGroupIds),
      }
      const nextAccessMode = normalizePublicFormAccessMode(nextPublicForm.accessMode)
      const allowedUserIds = normalizePublicFormAllowlistIds(nextPublicForm.allowedUserIds)
      const allowedMemberGroupIds = normalizePublicFormAllowlistIds(nextPublicForm.allowedMemberGroupIds)
      if (nextAccessMode === 'public' && (allowedUserIds.length > 0 || allowedMemberGroupIds.length > 0)) {
        return res.status(400).json({
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Allowed users and member groups require a DingTalk-protected access mode',
          },
        })
      }
      if (allowedUserIds.length > 0) {
        const userCheck = await pool.query(
          'SELECT id, is_active FROM users WHERE id = ANY($1::text[])',
          [allowedUserIds],
        )
        const existingUserIds = new Set(
          (userCheck.rows as Array<{ id: string }>).map((entry) => String(entry.id)),
        )
        const missingUserIds = allowedUserIds.filter((userId) => !existingUserIds.has(userId))
        if (missingUserIds.length > 0) {
          return res.status(400).json({
            ok: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: `Unknown allowed users: ${missingUserIds.join(', ')}`,
            },
          })
        }
        const inactiveUserIds = (userCheck.rows as Array<{ id: string; is_active?: boolean | null }>)
          .filter((entry) => entry.is_active === false)
          .map((entry) => String(entry.id))
          .filter((userId) => allowedUserIds.includes(userId))
        if (inactiveUserIds.length > 0) {
          return res.status(400).json({
            ok: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: `Inactive allowed users: ${inactiveUserIds.join(', ')}`,
            },
          })
        }
      }
      if (allowedMemberGroupIds.length > 0) {
        const groupCheck = await pool.query(
          'SELECT id::text AS id FROM platform_member_groups WHERE id::text = ANY($1::text[])',
          [allowedMemberGroupIds],
        )
        const existingGroupIds = new Set(
          (groupCheck.rows as Array<{ id: string }>).map((entry) => String(entry.id)),
        )
        const missingGroupIds = allowedMemberGroupIds.filter((groupId) => !existingGroupIds.has(groupId))
        if (missingGroupIds.length > 0) {
          return res.status(400).json({
            ok: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: `Unknown allowed member groups: ${missingGroupIds.join(', ')}`,
            },
          })
        }
      }
      nextConfig.publicForm = nextPublicForm as Record<string, unknown>

      // A4: persist the form-logic layout (pages/prefill/redirect/confirmation)
      // under view.config.formLayout, SEPARATE from publicForm access-control.
      // Only touched when the caller supplied `formLayout` (undefined = leave
      // existing untouched). `null` clears it. The normalizer (withFormLayout)
      // bounds every field; a redirect URL that is non-empty but FAILS the
      // open-redirect-safe check is surfaced as a 400 rather than silently
      // dropped, so the author gets feedback.
      if (parsed.data.formLayout !== undefined) {
        const layoutInput = parsed.data.formLayout
        if (layoutInput !== null && typeof layoutInput === 'object' && !Array.isArray(layoutInput)) {
          const redirectInput = (layoutInput as Record<string, unknown>).redirect
          if (redirectInput && typeof redirectInput === 'object' && !Array.isArray(redirectInput)) {
            const rawUrl = (redirectInput as Record<string, unknown>).url
            if (typeof rawUrl === 'string' && rawUrl.trim() && sanitizeFormRedirectUrl(rawUrl) === null) {
              return res.status(400).json({
                ok: false,
                error: {
                  code: 'VALIDATION_ERROR',
                  message: 'Post-submit redirect must be a same-origin relative path (e.g. /thanks)',
                },
              })
            }
          }
        }
        const withLayout = withFormLayout(nextConfig, layoutInput === null ? undefined : layoutInput)
        // Replace nextConfig in place so the persisted JSON + the cache reflect it.
        for (const key of Object.keys(nextConfig)) {
          if (!(key in withLayout)) delete nextConfig[key]
        }
        Object.assign(nextConfig, withLayout)
      }

      await pool.query(
        `UPDATE meta_views
         SET config = $2::jsonb
         WHERE id = $1`,
        [viewId, JSON.stringify(nextConfig)],
      )

      const view: UniverMetaViewConfig = {
        id: viewId,
        sheetId,
        name: String(row.name),
        type: String(row.type ?? 'grid'),
        filterInfo: normalizeJson(row.filter_info),
        sortInfo: normalizeJson(row.sort_info),
        groupInfo: normalizeJson(row.group_info),
        hiddenFieldIds: normalizeJsonArray(row.hidden_field_ids),
        config: nextConfig,
      }
      metaViewConfigCache.set(viewId, view)
      return res.json({ ok: true, data: await serializePublicFormShareConfig(pool.query.bind(pool), view) })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] update form share config failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update form share config' } })
    }
  })

  router.post('/sheets/:sheetId/views/:viewId/form-share/regenerate', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    const viewId = typeof req.params.viewId === 'string' ? req.params.viewId.trim() : ''
    if (!sheetId || !viewId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId and viewId are required' } })
    }

    try {
      const pool = poolManager.get()
      const current = await pool.query(
        'SELECT id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config FROM meta_views WHERE id = $1',
        [viewId],
      )
      if (current.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `View not found: ${viewId}` } })
      }

      const row: any = current.rows[0]
      if (String(row.sheet_id) !== sheetId) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `View ${viewId} does not belong to sheet ${sheetId}` } })
      }

      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageViews) return sendForbidden(res)

      const nextConfig = normalizeJson(row.config)
      const existingPublicForm = getPublicFormConfig({
        id: viewId,
        sheetId,
        name: String(row.name),
        type: String(row.type ?? 'grid'),
        filterInfo: normalizeJson(row.filter_info),
        sortInfo: normalizeJson(row.sort_info),
        groupInfo: normalizeJson(row.group_info),
        hiddenFieldIds: normalizeJsonArray(row.hidden_field_ids),
        config: nextConfig,
      })
      const nextPublicToken = buildPublicFormToken()
      nextConfig.publicForm = {
        ...(existingPublicForm ?? {}),
        enabled: existingPublicForm?.enabled === true,
        publicToken: nextPublicToken,
        accessMode: normalizePublicFormAccessMode(existingPublicForm?.accessMode),
      } as Record<string, unknown>

      await pool.query(
        `UPDATE meta_views
         SET config = $2::jsonb
         WHERE id = $1`,
        [viewId, JSON.stringify(nextConfig)],
      )

      const view: UniverMetaViewConfig = {
        id: viewId,
        sheetId,
        name: String(row.name),
        type: String(row.type ?? 'grid'),
        filterInfo: normalizeJson(row.filter_info),
        sortInfo: normalizeJson(row.sort_info),
        groupInfo: normalizeJson(row.group_info),
        hiddenFieldIds: normalizeJsonArray(row.hidden_field_ids),
        config: nextConfig,
      }
      metaViewConfigCache.set(viewId, view)
      return res.json({
        ok: true,
        data: {
          publicToken: (await serializePublicFormShareConfig(pool.query.bind(pool), view)).publicToken,
        },
      })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] regenerate form share token failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to regenerate form share token' } })
    }
  })

  router.get('/sheets/:sheetId/form-share-candidates', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    if (!sheetId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId is required' } })
    }

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    const rawLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined
    const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, Math.floor(rawLimit as number))) : 20

    try {
      const pool = poolManager.get()
      const sheet = await loadSheetRow(pool.query.bind(pool), sheetId)
      if (!sheet) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageViews) return sendForbidden(res)

      const candidates = (await listSheetPermissionCandidates(pool.query.bind(pool), sheetId, { q, limit }))
        .filter((candidate) => candidate.subjectType === 'user' || candidate.subjectType === 'member-group')
      const items = await enrichFormShareCandidatesWithDingTalkStatus(pool.query.bind(pool), candidates)
      return res.json({ ok: true, data: { items, total: items.length, limit, query: q } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] list form-share candidates failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list form-share candidates' } })
    }
  })

  router.delete('/views/:viewId', async (req: Request, res: Response) => {
    const viewId = req.params.viewId
    if (!viewId || typeof viewId !== 'string') {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'viewId is required' } })
    }

    try {
      const pool = poolManager.get()
      const current = await pool.query('SELECT id, sheet_id FROM meta_views WHERE id = $1', [viewId])
      if (current.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `View not found: ${viewId}` } })
      }
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), String((current.rows[0] as any).sheet_id ?? ''))
      if (!capabilities.canManageViews) return sendForbidden(res)
      await pool.query('DELETE FROM meta_views WHERE id = $1', [viewId])
      invalidateViewConfigCache(viewId)
      return res.json({ ok: true, data: { deleted: viewId } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] delete view failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete view' } })
    }
  })

  router.delete('/sheets/:sheetId', async (req: Request, res: Response) => {
    const sheetId = req.params.sheetId
    if (!sheetId || typeof sheetId !== 'string') {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId is required' } })
    }

    try {
      const pool = poolManager.get()
      const sheetRes = await pool.query('SELECT id FROM meta_sheets WHERE id = $1', [sheetId])
      if (sheetRes.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      const { capabilities, sheetScope } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (sheetScope?.hasAssignments) {
        if (!capabilities.canManageSheetAccess) return sendForbidden(res)
      } else if (!capabilities.canManageViews) {
        return sendForbidden(res)
      }
      const del = await pool.query('DELETE FROM meta_sheets WHERE id = $1', [sheetId])
      invalidateSheetSummaryCache(sheetId)
      invalidateFieldCache(sheetId)
      invalidateViewConfigCache()
      return res.json({ ok: true, data: { deleted: sheetId } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] delete sheet failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete sheet' } })
    }
  })

  router.post('/sheets', async (req: Request, res: Response) => {
    const schema = z.object({
      id: z.string().min(1).max(50).optional(),
      baseId: z.string().min(1).max(50).optional(),
      name: z.string().min(1).max(255).optional(),
      description: z.string().max(2000).optional(),
      seed: z.boolean().optional(),
    })

    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    const sheetId = parsed.data.id ?? buildId('sheet').slice(0, 50)
    const name = parsed.data.name ?? `Univer Sheet ${new Date().toISOString()}`
    const description = parsed.data.description ?? null
    const requestedBaseId = parsed.data.baseId?.trim()
    const seed = parsed.data.seed === true

    try {
      const pool = poolManager.get()
      const access = await resolveRequestAccess(req)
      const baseCapabilities = deriveCapabilities(access.permissions, access.isAdminRole)
      let baseId = requestedBaseId ?? null
      await pool.transaction(async ({ query }) => {
        if (!baseId) {
          if (!baseCapabilities.canManageViews) {
            throw new ValidationError('Insufficient permissions')
          }
          baseId = await ensureLegacyBase(query as unknown as QueryFn)
        } else {
          const baseRes = await query(
            'SELECT id, owner_id FROM meta_bases WHERE id = $1 AND deleted_at IS NULL',
            [baseId],
          )
          if ((baseRes as any).rows.length === 0) {
            throw new NotFoundError(`Base not found: ${baseId}`)
          }
          const baseRow = (baseRes as any).rows[0] as { owner_id?: unknown }
          const baseOwnerId = typeof baseRow.owner_id === 'string' ? baseRow.owner_id : null
          const canCreateInBase = baseCapabilities.canManageViews || (baseOwnerId !== null && baseOwnerId === access.userId)
          if (!canCreateInBase) {
            throw new ValidationError('Insufficient permissions')
          }
        }

        // ②a §2a.4-c TOCTOU close: reject if creating this sheet (with this resolved baseId) would
        // retroactively make an EXISTING link field cross-base (a link previously pointed at this
        // not-yet-existent sheet id from a source sheet in a different base). Mirrors the §2a.2 wall.
        await acquireLinkTargetMaterializationLock(query as unknown as QueryFn, sheetId)
        const retroactiveCrossBase = await validateSheetCreateNoRetroactiveCrossBaseLink(
          query as unknown as QueryFn,
          sheetId,
          baseId,
        )
        if (retroactiveCrossBase) {
          throw new CrossBaseLinkError(retroactiveCrossBase)
        }

        const insert = await query(
          `INSERT INTO meta_sheets (id, base_id, name, description)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (id) DO NOTHING`,
          [sheetId, baseId, name, description],
        )
        if ((insert as any).rowCount === 0) {
          throw new ConflictError(`Sheet already exists: ${sheetId}`)
        }

        // Every sheet needs at least one view to be openable. A plain
        // (un-seeded) create otherwise strands users on "这个 Base 还没有可打开
        // 的 Sheet 或 View。" because GET /api/multitable/context — unlike
        // GET /views — does not lazily create a default view (#1670). Seed the
        // same default Grid view the /views fallback would create.
        const defaultViewId = buildId('view')
        await query(
          `INSERT INTO meta_views (id, sheet_id, name, type, filter_info, sort_info, group_info, hidden_field_ids, config)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb)
           ON CONFLICT (id) DO NOTHING`,
          [defaultViewId, sheetId, '默认视图', 'grid', '{}', '{}', '{}', '[]', '{}'],
        )

        if (seed) {
          await createSeededSheet({ sheetId, name, description, query: query as unknown as QueryFn })
        }
      })

      return res.json({ ok: true, data: { sheet: { id: sheetId, baseId, name, description, seeded: seed } } })
    } catch (err) {
      if (err instanceof CrossBaseLinkError) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: err.message } })
      }
      if (err instanceof ValidationError) {
        return res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: err.message } })
      }
      if (err instanceof NotFoundError) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: err.message } })
      }
      if (err instanceof ConflictError) {
        return res.status(409).json({ ok: false, error: { code: 'CONFLICT', message: err.message } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] create sheet failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create sheet' } })
    }
  })

  router.post('/sheets/:sheetId/import-xlsx', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    if (!sheetId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId is required' } })
    }
    if (!xlsxUpload) {
      return res.status(500).json({ ok: false, error: { code: 'UPLOAD_UNAVAILABLE', message: 'XLSX upload not available - multer not installed' } })
    }

    xlsxUpload.single('file')(req, res, async (uploadErr: unknown) => {
      if (uploadErr) {
        return res.status(400).json({ ok: false, error: { code: 'UPLOAD_FAILED', message: String(uploadErr) } })
      }

      const file = (req as RequestWithFile).file
      if (!file?.buffer || file.buffer.length === 0) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'No XLSX file provided. Use "file" as the form field name.' } })
      }

      try {
        const pool = poolManager.get()
        const sheet = await loadSheetRowShared(pool.query.bind(pool), sheetId)
        if (!sheet) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
        }

        const { access, capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
        if (!access.userId) {
          return res.status(401).json({ error: 'Authentication required' })
        }
        if (!capabilities.canCreateRecord) return sendForbidden(res)

        const xlsx = await loadXlsxModule()
        let parsed: ParsedXlsxResult
        try {
          parsed = parseXlsxBuffer(xlsx, file.buffer, {
            sheetName: typeof req.body.sheetName === 'string' ? req.body.sheetName : undefined,
          })
        } catch {
          throw new ValidationError('Invalid XLSX file')
        }
        if (parsed.headers.length === 0) {
          return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'XLSX file has no header row' } })
        }

        const fields = await loadFieldsForSheetShared(pool.query.bind(pool), sheetId)
        const rawMapping = parseJsonFormField(req.body.mapping, 'mapping')
        const columnMapping = normalizeXlsxColumnMapping(rawMapping, parsed.headers, fields)
        if (Object.keys(columnMapping.mapping).length === 0) {
          return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'No XLSX columns map to importable fields' } })
        }

        const built = buildXlsxImportRecords(parsed, columnMapping.mapping)
        const recordService = new RecordService(pool, eventBus)
        // A-min-create (#2255): import-xlsx inherits create-time formula-over-lookup recalc via createRecord.
        recordService.setFormulaRecalcHook((q, sid, ids) => recalcNewRecordFormulas(req, q, sid, ids))
        if (yjsInvalidator) {
          recordService.setPostCommitHooks([createYjsInvalidationPostCommitHook(yjsInvalidator)])
        }

        const failures: Array<{ rowIndex: number; message: string; code?: string }> = []
        const createdRecordIds: string[] = []
        for (let index = 0; index < built.records.length; index += 1) {
          const data = built.records[index]
          const rowIndex = built.rowIndexes[index] ?? index
          try {
            const created = await recordService.createRecord({
              sheetId,
              capabilities,
              actorId: getRequestActorId(req),
              data,
            })
            createdRecordIds.push(created.recordId)
          } catch (error) {
            if (error instanceof RecordCreateValidationFailedError) {
              failures.push({ rowIndex, message: 'Record validation failed', code: 'VALIDATION_FAILED' })
            } else if (error instanceof RecordServiceFieldForbiddenError || error instanceof RecordServiceValidationError) {
              failures.push({ rowIndex, message: error.message, code: error.code })
            } else if (error instanceof RecordServicePermissionError) {
              failures.push({ rowIndex, message: error.message, code: 'FORBIDDEN' })
            } else {
              throw error
            }
          }
        }

        return res.json({
          ok: failures.length === 0,
          data: {
            sheetId,
            sheetName: parsed.sheetName,
            headers: parsed.headers,
            mapping: columnMapping.mapping,
            unmappedHeaders: columnMapping.unmappedHeaders,
            unmappedFields: columnMapping.unmappedFields,
            attempted: built.records.length,
            imported: createdRecordIds.length,
            failed: failures.length,
            failures,
            createdRecordIds,
            truncated: parsed.truncated,
          },
        })
      } catch (err) {
        if (err instanceof ValidationError) {
          return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: err.message } })
        }
        if (err instanceof RecordServiceNotFoundError || err instanceof NotFoundError) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: err.message } })
        }
        if (err instanceof RecordServicePermissionError) {
          return sendForbidden(res, err.message)
        }
        if (err instanceof RecordServiceValidationError || err instanceof ServiceValidationError) {
          return res.status(400).json({ ok: false, error: { code: err.code || 'VALIDATION_ERROR', message: err.message } })
        }
        const hint = getDbNotReadyMessage(err)
        if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
        console.error('[univer-meta] xlsx import failed:', err)
        return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to import XLSX' } })
      }
    })
  })

  router.get('/sheets/:sheetId/export-xlsx', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    const viewId = typeof req.query.viewId === 'string' ? req.query.viewId.trim() : ''
    // Optional column selection: caller picks a SUBSET of columns to export. Accept both the
    // comma-joined form (?fieldIds=a,c) and the repeated form (?fieldIds=a&fieldIds=c). Empty /
    // absent → undefined (export all permitted columns = unchanged behavior). This is a SELECTION
    // hint only; it is intersected with the permitted/masked field set below and can ONLY narrow,
    // never widen — a denied/masked/tainted id requested here stays excluded.
    const requestedFieldIds = parseFieldIdSelection(req.query.fieldIds)
    if (!sheetId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId is required' } })
    }

    try {
      const pool = poolManager.get()
      const sheet = await loadSheetRowShared(pool.query.bind(pool), sheetId)
      if (!sheet) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      let viewHiddenFieldIds: string[] = []
      if (viewId) {
        const view = await tryResolveViewShared(pool.query.bind(pool), viewId)
        if (!view || view.sheetId !== sheetId) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `View not found: ${viewId}` } })
        }
        viewHiddenFieldIds = view.hiddenFieldIds ?? []
      }

      const { access, capabilities } = await resolveSheetReadableCapabilities(req, pool.query.bind(pool), sheetId)
      if (!access.userId) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      if (!capabilities.canRead || !capabilities.canExport) return sendForbidden(res)

      // D3c: export must mirror the view path's field masking — apply subject-scoped
      // field_permissions + view.hidden_field_ids, not only static property.hidden.
      const visibleFields = filterVisiblePropertyFields(await loadFieldsForSheetShared(pool.query.bind(pool), sheetId))
      const fieldScopeMap = await loadFieldPermissionScopeMap(pool.query.bind(pool), sheetId, access.userId)
      const fieldPermissions = deriveFieldPermissions(visibleFields, capabilities, {
        hiddenFieldIds: viewHiddenFieldIds,
        fieldScopeMap,
      })
      let fields = visibleFields.filter((field) => fieldPermissions[field.id]?.visible !== false)
      // §2a.3 export taint-check (fail-closed) via the single CHOKEPOINT (maskStoredRecordFieldIds):
      // formula values are MATERIALIZED into meta_records.data, and this export path reads them RAW
      // (no applyLookupRollup), so a formula over a lookup/rollup of an UNREADABLE foreign field would
      // leak the value. The chokepoint yields the taint-dropped allowed set; export additionally drops
      // the WHOLE formula column from the header `fields` list (consistent with field-level export
      // masking above), so re-derive `fields` from the masked set rather than mutating in place.
      let fieldIds = await maskStoredRecordFieldIds(req, pool.query.bind(pool), sheetId, fields, new Set(fields.map((field) => field.id)))
      if (fieldIds.size !== fields.length) {
        fields = fields.filter((field) => fieldIds.has(field.id))
        fieldIds = new Set(fields.map((field) => field.id))
      }

      // Column selection (optional). CRITICAL SECURITY INVARIANT: the requested `fieldIds` are
      // intersected with the FULLY-MASKED set computed above (`fields` already excludes
      // field_permissions-denied, view-hidden, and §2a.3 formula-tainted columns). Selection can
      // ONLY narrow this set, never widen it — a denied/masked/tainted id requested here is simply
      // absent from `fields` and so drops out of the intersection (it cannot bypass the mask).
      // Filter in place to preserve sheet field order (headers + cell projection). Unknown/foreign
      // ids fall out of the intersection. If the selection resolves to ZERO exportable columns
      // (all requested ids were foreign or masked), fail with 400 rather than emitting an empty
      // workbook — an empty export is almost certainly a client bug, not an intended request.
      if (requestedFieldIds) {
        fields = fields.filter((field) => requestedFieldIds.has(field.id))
        fieldIds = new Set(fields.map((field) => field.id))
        if (fields.length === 0) {
          return res.status(400).json({
            ok: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: 'fieldIds selection resolved to no exportable columns (unknown or not permitted)',
            },
          })
        }
      }

      const rows: Array<Array<string | number | boolean | null | undefined>> = []
      let cursor: string | undefined
      let truncated = false
      do {
        const result = await queryRecordsWithCursor({
          query: pool.query.bind(pool),
          sheetId,
          cursor,
          limit: Math.min(5000, XLSX_MAX_ROWS - rows.length),
        })
        for (const record of result.items) {
          const data = filterRecordDataByFieldIds(record.data, fieldIds)
          rows.push(fields.map((field) => {
            const cell = data[field.id]
            // Rich-longText export = the §7 plain-text projection, NOT the raw HTML
            // (a cell must read as text, never `<p>…</p>`).
            if (field.type === 'longText' && isRichLongTextProperty(field.property) && typeof cell === 'string') {
              return serializeXlsxCell(richLongTextToPlainText(cell))
            }
            return serializeXlsxCell(cell)
          }))
          if (rows.length >= XLSX_MAX_ROWS) {
            truncated = result.hasMore
            break
          }
        }
        cursor = result.hasMore && rows.length < XLSX_MAX_ROWS ? result.nextCursor ?? undefined : undefined
      } while (cursor)

      const xlsx = await loadXlsxModule()
      const buffer = buildXlsxBuffer(xlsx, {
        sheetName: sheet.name,
        headers: fields.map((field) => field.name),
        rows,
      })
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      res.setHeader('Content-Disposition', `attachment; filename="${buildXlsxAttachmentFilename(sheet.name)}"`)
      res.setHeader('X-MetaSheet-XLSX-Truncated', truncated ? 'true' : 'false')
      return res.send(buffer)
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: err.message } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] xlsx export failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to export XLSX' } })
    }
  })

  // Aggregation footer (benchmark v2 #4-3b-1): aggregate the full (unpaginated) PERSISTED-view-filtered
  // record set. view-config-driven (view.config.aggregations), no ad-hoc params. Field visibility uses
  // the D3c export composite (hidden fields' aggregates OMITTED — leak guard). Max-rows hard-fails (413).
  router.get('/sheets/:sheetId/view-aggregate', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    const viewId = typeof req.query.viewId === 'string' ? req.query.viewId.trim() : ''
    const search = normalizeSearchTerm(req.query.search) // same normalization as /view (trim+lowercase) → search parity
    if (!sheetId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId is required' } })
    }
    try {
      const pool = poolManager.get()
      const sheet = await loadSheetRowShared(pool.query.bind(pool), sheetId)
      if (!sheet) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      let view: SharedMultitableViewConfig | null = null
      if (viewId) {
        view = await tryResolveViewShared(pool.query.bind(pool), viewId)
        if (!view || view.sheetId !== sheetId) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `View not found: ${viewId}` } })
        }
      }
      const { access, capabilities } = await resolveSheetReadableCapabilities(req, pool.query.bind(pool), sheetId)
      if (!access.userId) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      if (!capabilities.canRead) return sendForbidden(res)

      // max-rows guard: COUNT first, HARD-FAIL (413) with total — never truncate (aggregates must be exact)
      const maxRows = Number(process.env.MULTITABLE_AGGREGATE_MAX_ROWS || '10000')
      const countRes = await pool.query('SELECT COUNT(*)::int AS n FROM meta_records WHERE sheet_id = $1', [sheetId])
      const rawCount = Number((countRes.rows[0] as { n?: number })?.n ?? 0)
      if (rawCount > maxRows) {
        return res.status(413).json({ ok: false, error: { code: 'AGGREGATE_TOO_LARGE', message: `Too many rows to aggregate (${rawCount} > ${maxRows})`, total: rawCount } })
      }

      // #2038 (a): SEARCH/FILTER SELECTION is gated by a layer-3-ONLY set (selectableFieldIds, hiddenFieldIds: []),
      // mirroring /view's allowedFieldIds → the filtered SET stays identical to /view (the parity invariant) while a
      // field_permissions-denied field is treated as unavailable (dropped from search/filter, exactly like a
      // non-existent field). This is SEPARATE from the AGGREGATE OUTPUT set (aggregateFieldTypeById below), which is
      // layer-1∧layer-3 (hiddenFieldIds: viewHiddenFieldIds) and omits view-hidden + denied aggregates — layer-1
      // stays display-only for SELECTION (a readable-but-view-hidden field is still searchable/filterable on both).
      const viewHiddenFieldIds = view?.hiddenFieldIds ?? []
      const visibleFields = filterVisiblePropertyFields(await loadFieldsForSheetShared(pool.query.bind(pool), sheetId))
      const filterFieldTypeById = new Map(visibleFields.map((field) => [field.id, field.type]))
      const filterInfo = view ? parseMetaFilterInfo(view.filterInfo) : null

      const fieldScopeMap = await loadFieldPermissionScopeMap(pool.query.bind(pool), sheetId, access.userId)
      const selectionFieldPermissions = deriveFieldPermissions(visibleFields, capabilities, { hiddenFieldIds: [], fieldScopeMap })
      const selectableFieldIds = new Set(visibleFields.filter((field) => selectionFieldPermissions[field.id]?.visible !== false).map((field) => field.id))
      const selectableFields = visibleFields.filter((field) => selectableFieldIds.has(field.id))

      // Computed (lookup/rollup/formula) filter conditions can't be evaluated here (no applyLookupRollup),
      // so the filtered set would silently disagree with /view. HARD-FAIL instead (deferred to #4-3b-2).
      // Only SELECTABLE (non-denied) conditions trip this — a denied condition is dropped (= non-existent),
      // matching /view, so it never forces a 422 (which would break the parity invariant).
      const COMPUTED_FILTER_TYPES = new Set(['lookup', 'rollup', 'formula'])
      if (filterInfo?.conditions.some((c) => selectableFieldIds.has(c.fieldId) && COMPUTED_FILTER_TYPES.has(filterFieldTypeById.get(c.fieldId) ?? ''))) {
        return res.status(422).json({ ok: false, error: { code: 'AGGREGATE_COMPUTED_FILTER_UNSUPPORTED', message: 'Aggregation over a view filtering on a computed (lookup/rollup/formula) field is not yet supported' } })
      }

      // D3c permission composite → which fields' aggregates may be OUTPUT (layer-1∧layer-3; reuses fieldScopeMap above)
      const fieldPermissions = deriveFieldPermissions(visibleFields, capabilities, { hiddenFieldIds: viewHiddenFieldIds, fieldScopeMap })
      const aggregateFieldTypeById = new Map(
        visibleFields.filter((field) => fieldPermissions[field.id]?.visible !== false).map((field) => [field.id, field.type]),
      )

      // §2a.3 (M1) via the single CHOKEPOINT (maskStoredRecordFieldIds): view-aggregate reads
      // MATERIALIZED formula values raw (no applyLookupRollup). A formula over a lookup/rollup of an
      // UNREADABLE foreign field passes the source-sheet gate above (the formula field itself isn't
      // denied) but its count/countDistinct/countNonEmpty would leak the foreign-derived
      // cardinality/non-emptiness. The chokepoint yields the taint-dropped allowed set; remove any
      // aggregate-output key that did not survive it (fail-closed). This shape gates a Map (id→type),
      // not a per-row data mask, so it derives the masked set then deletes the dropped keys.
      const maskedAggFieldIds = await maskStoredRecordFieldIds(
        req,
        pool.query.bind(pool),
        sheetId,
        visibleFields,
        new Set(aggregateFieldTypeById.keys()),
      )
      for (const id of [...aggregateFieldTypeById.keys()]) {
        if (!maskedAggFieldIds.has(id)) aggregateFieldTypeById.delete(id)
      }

      // full filtered set = all records + persisted filterInfo + search, resolved over the SAME field set
      // as /view (visibleFields) → identical filtered set
      const recordRes = await pool.query('SELECT id, version, data FROM meta_records WHERE sheet_id = $1', [sheetId])
      let rows = (recordRes.rows as Array<{ id: unknown; version: unknown; data: unknown }>).map((r) => ({
        id: String(r.id),
        version: Number(r.version ?? 1),
        data: normalizeJson(r.data),
      }))
      if (search) rows = rows.filter((rec) => recordMatchesSearch(rec, selectableFields, search))
      if (filterInfo) {
        const conditions = filterInfo.conditions.filter((c) => filterFieldTypeById.has(c.fieldId) && selectableFieldIds.has(c.fieldId))
        if (conditions.length > 0) {
          rows = rows.filter((rec) => {
            const matches = (c: MetaFilterCondition) => evaluateMetaFilterCondition(filterFieldTypeById.get(c.fieldId)!, rec.data[c.fieldId], c)
            return filterInfo.conjunction === 'or' ? conditions.some(matches) : conditions.every(matches)
          })
        }
      }

      // aggregate ONLY configured + D3c-allowed fields; disallowed (hidden) field aggregates are OMITTED
      const aggConfig = parseAggregations(view?.config ?? null)
      const computeAggregates = (dataRows: Array<Record<string, unknown>>) => {
        const out: Record<string, { fn: AggregationFn; value: number }> = {}
        for (const [fieldId, fn] of Object.entries(aggConfig)) {
          const fieldType = aggregateFieldTypeById.get(fieldId)
          if (!fieldType) continue // hidden / permission-denied / unknown → omit (no leak)
          const value = aggregateField(dataRows.map((d) => d[fieldId]), fn, fieldType)
          if (value !== null) out[fieldId] = { fn, value }
        }
        return out
      }
      // group subtotals (#4-3b-2a): grid group field is view.groupInfo.fieldId (NOT view.config.groupFieldId).
      // Resolve + run the 422 gates BEFORE the grand total → no wasted aggregation on a refused request.
      const groupFieldId =
        typeof (view?.groupInfo as { fieldId?: unknown } | undefined)?.fieldId === 'string'
          ? ((view!.groupInfo as { fieldId?: string }).fieldId as string).trim()
          : ''
      if (groupFieldId) {
        // group field computed → can't materialize here (same posture as computed filter)
        const groupFieldType = filterFieldTypeById.get(groupFieldId)
        if (groupFieldType && COMPUTED_FILTER_TYPES.has(groupFieldType)) {
          return res.status(422).json({ ok: false, error: { code: 'AGGREGATE_COMPUTED_GROUP_UNSUPPORTED', message: 'Grouping a view by a computed (lookup/rollup/formula) field is not yet supported' } })
        }
        // group field hidden/denied (or not a visible property field) → REFUSE: the group keys are that
        // field's distinct values, so emitting them would leak data the user can't see.
        if (!aggregateFieldTypeById.has(groupFieldId)) {
          return res.status(422).json({ ok: false, error: { code: 'AGGREGATE_GROUP_FIELD_DENIED', message: 'Cannot group by a field that is not visible to this user' } })
        }
      }

      const aggregates = computeAggregates(rows.map((rec) => rec.data))
      if (!groupFieldId) {
        // not grouped → response byte-identical to #4-3b-1
        return res.json({ ok: true, data: { total: rows.length, aggregates } })
      }
      const groups = groupRowsByField(rows.map((rec) => rec.data), groupFieldId).map((bucket) => ({
        key: bucket.key,
        count: bucket.rows.length,
        aggregates: computeAggregates(bucket.rows),
      }))
      return res.json({ ok: true, data: { total: rows.length, aggregates, groupFieldId, groups } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] view-aggregate failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to aggregate view' } })
    }
  })

  // Formula dry-run (#5a, design #1860): evaluate an UNSAVED formula expression against caller-supplied
  // sample values. Pure in-memory ({fldId} refs only; A1/range rejected) over a no-DB engine.
  router.post('/sheets/:sheetId/formula/dry-run', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId.trim() : ''
    const body = (req.body ?? {}) as { expression?: unknown; sampleValues?: unknown; recordId?: unknown }
    const expression = typeof body.expression === 'string' ? body.expression : ''
    const recordId = typeof body.recordId === 'string' ? body.recordId.trim() : ''
    if (!sheetId || !expression.trim()) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId and a non-empty expression are required' } })
    }
    const sampleValues =
      body.sampleValues && typeof body.sampleValues === 'object' && !Array.isArray(body.sampleValues)
        ? (body.sampleValues as Record<string, unknown>)
        : {}
    // Structural caps (no hard timeout) — reject before any eval.
    if (expression.length > DRY_RUN_MAX_EXPRESSION_LEN) {
      return res.status(413).json({ ok: false, error: { code: 'DRYRUN_EXPRESSION_TOO_LONG', message: `Expression exceeds ${DRY_RUN_MAX_EXPRESSION_LEN} characters` } })
    }
    let depth = 0
    let maxDepth = 0
    for (const ch of expression) {
      if (ch === '(' || ch === '[') maxDepth = Math.max(maxDepth, ++depth)
      else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1)
    }
    if (maxDepth > DRY_RUN_MAX_PAREN_DEPTH) {
      return res.status(422).json({ ok: false, error: { code: 'DRYRUN_TOO_DEEP', message: `Expression nesting exceeds depth ${DRY_RUN_MAX_PAREN_DEPTH}` } })
    }
    try {
      const pool = poolManager.get()
      const sheet = await loadSheetRowShared(pool.query.bind(pool), sheetId)
      if (!sheet) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      // #5c: when recordId is present, the record-level read gate (requireRecordReadable) yields
      // access + capabilities (404 record-not-on-sheet / 401 / 403 sheet-!canRead). Per the current
      // schema record-read is grant-additive (record_permissions.access_level is read|write|admin,
      // no deny level), so this gate enforces existence + sheet-read, not a per-record read-deny.
      // Absent recordId → unchanged #5b path. The dry-run ENGINE stays no-DB; the read below is route-level.
      let capabilities: MultitableCapabilities
      let recordReadAccess: ResolvedRequestAccess | undefined
      if (recordId) {
        const readable = await requireRecordReadable(req, pool.query.bind(pool), sheetId, recordId)
        if ('status' in readable) {
          return res.status(readable.status).json(readable.body)
        }
        capabilities = readable.capabilities
        recordReadAccess = readable.access
      } else {
        const resolved = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
        capabilities = resolved.capabilities
      }
      if (!capabilities.canManageFields) return sendForbidden(res)

      const referencedFieldIds = dryRunFormulaEngine.extractFieldReferences(expression)
      if (referencedFieldIds.length > DRY_RUN_MAX_REFERENCED_FIELDS) {
        return res.status(422).json({ ok: false, error: { code: 'DRYRUN_TOO_MANY_REFS', message: `Expression references more than ${DRY_RUN_MAX_REFERENCED_FIELDS} fields` } })
      }
      const fields = await loadFieldsForSheetShared(pool.query.bind(pool), sheetId)

      // #5c + FOL-2: optional real-record sampling. Production recalc evaluates HYDRATED rows since
      // A-min (#2247), so the sampled record hydrates its referenced lookup/rollup the same way —
      // at the ROUTE layer only (the dry-run engine keeps its no-DB invariant). Order is
      // hydrate → mask → manual override: a denied/hidden lookup key is dropped by the mask and
      // still surfaces as missing_sample.
      let effectiveSampleValues: Record<string, unknown> = sampleValues
      if (recordId && recordReadAccess) {
        const userId = recordReadAccess.userId
        if (userId) {
          const recordRes = await pool.query(
            'SELECT data FROM meta_records WHERE id = $1 AND sheet_id = $2',
            [recordId, sheetId],
          )
          const rawData = recordRes.rows.length > 0 ? normalizeJson(recordRes.rows[0].data) : {}
          // FOL-2 hydration is EXPRESSION-SCOPED (design 2026-06-10 §3.1): only the lookup/rollup
          // fields the expression references are passed to applyLookupRollup (its `fields` param
          // consumes lookup/rollup entries only; link configs flow via `relationalLinkFields`),
          // binding the per-preview cost to the expression — no computed ref → zero
          // link/foreign-sheet reads. Requester-perspective (`req`): an unreadable foreign sheet
          // hydrates a lookup to [] and a rollup to null, same as every read path.
          const referencedIdSet = new Set(referencedFieldIds)
          const referencedComputedFields = fields.filter(
            (field) => (field.type === 'lookup' || field.type === 'rollup') && referencedIdSet.has(field.id),
          )
          if (referencedComputedFields.length > 0) {
            const relationalLinkFields = fields
              .map((f) => (f.type === 'link' ? { fieldId: f.id, cfg: parseLinkFieldConfig(f.property) } : null))
              .filter((v): v is RelationalLinkField => !!v && !!v.cfg)
            const row: UniverMetaRecord = { id: recordId, version: 0, data: rawData }
            const linkValuesByRecord = await loadLinkValuesByRecord(pool.query.bind(pool), [recordId], relationalLinkFields)
            await applyLookupRollup(req, pool.query.bind(pool), sheetId, referencedComputedFields, [row], relationalLinkFields, linkValuesByRecord)
          }
          // D3c field mask, sheet-scope (hiddenFieldIds: [] — display-consistency defer, see #5c design-lock §4).
          // scope.visible is the real field-read gate; a denied field is omitted → becomes missing_sample.
          const visibleFields = filterVisiblePropertyFields(fields)
          const fieldScopeMap = await loadFieldPermissionScopeMap(pool.query.bind(pool), sheetId, userId)
          const fieldPermissions = deriveFieldPermissions(visibleFields, capabilities, { hiddenFieldIds: [], fieldScopeMap })
          // §2a.3 read taint mask via the single CHOKEPOINT (maskStoredRecordFieldIds): the sampled
          // stored data can hold a MATERIALIZED formula-over-denied-lookup value; feeding it as a
          // dry-run sample would surface/transitively leak it to the actor. The chokepoint drops
          // tainted formula ids before the data-mask (a dropped key then surfaces as missing_sample,
          // identical to a masked lookup key).
          const allowedIds = await maskStoredRecordFieldIds(
            req,
            pool.query.bind(pool),
            sheetId,
            visibleFields,
            new Set(visibleFields.filter((field) => fieldPermissions[field.id]?.visible !== false).map((field) => field.id)),
          )
          const maskedData = filterRecordDataByFieldIds(rawData, allowedIds)
          // Record values are the base; explicit manual sampleValues override per-field (denied keys stay omitted).
          effectiveSampleValues = { ...maskedData, ...sampleValues }
        }
      }
      const data = await dryRunFormulaEngine.dryRun(expression, effectiveSampleValues, fields.map((f) => ({ id: f.id, type: f.type })))
      return res.json({ ok: true, data })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] formula dry-run failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to dry-run formula' } })
    }
  })

  router.get('/view', async (req: Request, res: Response) => {
    const sheetIdParam = typeof req.query.sheetId === 'string' ? req.query.sheetId.trim() : undefined
    const viewIdParam = typeof req.query.viewId === 'string' ? req.query.viewId.trim() : undefined
    const seed = req.query.seed === 'true'
    const includeLinkSummaries = req.query.includeLinkSummaries === 'true'
    const search = normalizeSearchTerm(req.query.search)
    const limitParam = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : undefined
    const offsetParam = typeof req.query.offset === 'string' ? Number.parseInt(req.query.offset, 10) : undefined
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam!, 1), 5000) : undefined
    const offset = Number.isFinite(offsetParam) ? Math.max(offsetParam!, 0) : 0

    try {
      const pool = poolManager.get()
      const resolved = await resolveMetaSheetId(pool as unknown as { query: QueryFn }, {
        sheetId: sheetIdParam,
        viewId: viewIdParam,
      })
      const sheetId = resolved.sheetId
      const viewConfig = resolved.view
      const { access, capabilities, capabilityOrigin, sheetScope } = await resolveSheetReadableCapabilities(req, pool.query.bind(pool), sheetId)
      if (!access.userId) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      if (!capabilities.canRead) return sendForbidden(res)
      const rawSortRules = viewConfig ? parseMetaSortRules(viewConfig.sortInfo) : []
      const rawFilterInfo = viewConfig ? parseMetaFilterInfo(viewConfig.filterInfo) : null
      if (seed) {
        await createSeededSheet({ sheetId, name: `Seed ${sheetId}` })
      }

      const [sheet, fields] = await Promise.all([
        loadSheetSummary(pool as unknown as { query: QueryFn }, sheetId),
        loadSheetFields(pool as unknown as { query: QueryFn }, sheetId),
      ])

      if (!sheet) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }

      const visiblePropertyFields = filterVisiblePropertyFields(fields)
      // #2015 read-path field mask: the D3c security composite — layer-2 (property.hidden, already applied
      // by filterVisiblePropertyFields) ∧ layer-3 (field_permissions.visible, the subject-scoped read gate).
      // Mirrors export-xlsx (:5839) and formula dry-run #5c-a (:6089). hiddenFieldIds:[] deliberately omits
      // layer-1 (view.hidden_field_ids) — that stays a display-only concern carried in the returned
      // fieldPermissions metadata below, not a server-side data drop. access.userId is guaranteed truthy
      // here (401 at the top of the handler); loaded ONCE and reused for the metadata derive below — do not
      // re-load (this is the hottest read endpoint).
      const fieldScopeMap = access.userId
        ? await loadFieldPermissionScopeMap(pool.query.bind(pool), sheetId, access.userId)
        : new Map()
      const securityFieldPermissions = deriveFieldPermissions(visiblePropertyFields, capabilities, { hiddenFieldIds: [], fieldScopeMap })
      let allowedFieldIds = new Set(
        visiblePropertyFields.filter((field) => securityFieldPermissions[field.id]?.visible !== false).map((field) => field.id),
      )
      // §2a.3 read/JSON taint mask via the single CHOKEPOINT (maskStoredRecordFieldIds): the LOOKUP
      // column is masked by applyLookupRollup below, but the MATERIALIZED FORMULA column is read
      // straight from meta_records.data and would otherwise leak a formula-over-denied-foreign-lookup
      // value. The chokepoint drops tainted formula fields from allowedFieldIds (the data-mask gate at
      // filterRecordDataByFieldIds below) so the value never reaches the wire. The column still
      // appears in the returned field list (parity with how a masked lookup keeps its column); only
      // the per-row materialized value is withheld.
      allowedFieldIds = await maskStoredRecordFieldIds(req, pool.query.bind(pool), sheetId, visiblePropertyFields, allowedFieldIds)
      const fieldTypeById = new Map(visiblePropertyFields.map((f) => [f.id, f.type] as const))
      // #2038 (a): search/sort/filter SELECTION is gated by allowedFieldIds (layer-3, the field-read gate) —
      // a field_permissions-denied field is treated as unavailable (not searchable/filterable/sortable),
      // exactly like a non-existent field. `allowedFieldIds` is layer-3-ONLY (hiddenFieldIds: [], :6161), so
      // layer-1 (view.hidden_field_ids) stays display-only here (a readable-but-view-hidden field is still
      // searchable). Denied fields are SILENTLY dropped — NOT added to the "field doesn't exist" warning below.
      const searchableFields = visiblePropertyFields.filter((field) => allowedFieldIds.has(field.id) && isSearchableFieldType(field.type))
      const searchableFieldIds = searchableFields.map((field) => field.id)
      const warnings: string[] = []

      const ignoredSortFieldIds = rawSortRules
        .filter((rule) => !fieldTypeById.has(rule.fieldId))
        .map((rule) => rule.fieldId)
      const sortRules = rawSortRules.filter((rule) => fieldTypeById.has(rule.fieldId) && allowedFieldIds.has(rule.fieldId))

      const ignoredFilterFieldIds = rawFilterInfo
        ? rawFilterInfo.conditions.filter((condition) => !fieldTypeById.has(condition.fieldId)).map((c) => c.fieldId)
        : []
      const filteredConditions = rawFilterInfo
        ? rawFilterInfo.conditions.filter((condition) => fieldTypeById.has(condition.fieldId) && allowedFieldIds.has(condition.fieldId))
        : []
      const filterInfo = filteredConditions.length > 0 && rawFilterInfo
        ? { ...rawFilterInfo, conditions: filteredConditions }
        : null

      if (ignoredSortFieldIds.length > 0) {
        warnings.push(`排序字段不存在，已忽略: ${ignoredSortFieldIds.join(', ')}`)
      }
      if (ignoredFilterFieldIds.length > 0) {
        warnings.push(`筛选字段不存在，已忽略: ${ignoredFilterFieldIds.join(', ')}`)
      }

      const relationalLinkFields = fields
        .map((f) => (f.type === 'link' ? { fieldId: f.id, cfg: parseLinkFieldConfig(f.property) } : null))
        .filter((v): v is { fieldId: string; cfg: LinkFieldConfig } => !!v && !!v.cfg)
      const attachmentFields = visiblePropertyFields.filter((field) => field.type === 'attachment')
      // Native person (人员) fields — distinct from link fields (legacy link-backed person is
      // `type='link'` and renders via linkSummaries; native person is `type='person'` and needs
      // personSummaries). Coexistence: a sheet may have both.
      const personFields = visiblePropertyFields.filter((field) => field.type === 'person')
      const computedFieldIdSet = new Set(
        visiblePropertyFields.filter((f) => f.type === 'lookup' || f.type === 'rollup').map((f) => f.id),
      )

      let rows: UniverMetaRecord[] = []
      let page: UniverMetaView['page'] | undefined

      const hasSearch = search.length > 0
      const hasFilterOrSort = sortRules.length > 0 || !!filterInfo
      const hasSimpleSearchFastPath = hasSearch && !hasFilterOrSort
      const hasInMemoryProcessing = hasFilterOrSort || hasSearch

      let computedFilterSort = false

      if (hasSimpleSearchFastPath) {
        if (searchableFieldIds.length === 0) {
          rows = []
          if (limit) page = { offset, limit, total: 0, hasMore: false }
        } else {
          const searchLike = `%${escapeSqlLikePattern(search)}%`
          const firstFieldParamIndex = 3
          const predicate = buildRecordSearchPredicateSql(searchableFieldIds, 2, firstFieldParamIndex)

          if (limit) {
            const limitParamIndex = firstFieldParamIndex + searchableFieldIds.length
            const offsetParamIndex = limitParamIndex + 1
            const recordRes = await pool.query(
              `SELECT id, version, data, locked, locked_by, locked_at, COUNT(*) OVER()::int AS total
               FROM meta_records
               WHERE sheet_id = $1 AND (${predicate})
               ORDER BY created_at ASC, id ASC
               LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}`,
              [sheetId, searchLike, ...searchableFieldIds, limit, offset],
            )

            rows = recordRes.rows.map((r: any) => ({
              id: String(r.id),
              version: Number(r.version ?? 1),
              data: normalizeJson(r.data),
              ...mapRecordLockState(r),
            }))

            let total = Number((recordRes.rows[0] as any)?.total ?? 0)
            if (rows.length === 0 && offset > 0) {
              const countRes = await pool.query(
                `SELECT COUNT(*)::int AS total
                 FROM meta_records
                 WHERE sheet_id = $1 AND (${predicate})`,
                [sheetId, searchLike, ...searchableFieldIds],
              )
              total = Number((countRes.rows[0] as any)?.total ?? 0)
            }
            page = { offset, limit, total, hasMore: offset + rows.length < total }
          } else {
            const recordRes = await pool.query(
              `SELECT id, version, data, locked, locked_by, locked_at
               FROM meta_records
               WHERE sheet_id = $1 AND (${predicate})
               ORDER BY created_at ASC, id ASC`,
              [sheetId, searchLike, ...searchableFieldIds],
            )

            rows = recordRes.rows.map((r: any) => ({
              id: String(r.id),
              version: Number(r.version ?? 1),
              data: normalizeJson(r.data),
              ...mapRecordLockState(r),
            }))
          }
        }
      } else if (hasInMemoryProcessing) {
        const recordRes = await pool.query(
          'SELECT id, version, data, created_at, locked, locked_by, locked_at FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC',
          [sheetId],
        )

        let all = recordRes.rows.map((r: any) => ({
          id: String(r.id),
          version: Number(r.version ?? 1),
          data: normalizeJson(r.data),
          createdAt: (r as any).created_at as unknown,
          lock: mapRecordLockState(r),
        }))

        const needsComputedFilterSort =
          computedFieldIdSet.size > 0 &&
          (sortRules.some((rule) => computedFieldIdSet.has(rule.fieldId)) ||
            (filterInfo?.conditions ?? []).some((condition) => computedFieldIdSet.has(condition.fieldId)))

        if (needsComputedFilterSort) {
          warnings.push('筛选/排序包含 Lookup/Rollup，当前为内存计算，数据量大时较慢。')
        }
        computedFilterSort = needsComputedFilterSort

        if (needsComputedFilterSort) {
          const linkValuesByRecord = await loadLinkValuesByRecord(
            pool.query.bind(pool),
            all.map((r) => r.id),
            relationalLinkFields,
          )
          await applyLookupRollup(
            req,
            pool.query.bind(pool),
            sheetId,
            fields,
            all,
            relationalLinkFields,
            linkValuesByRecord,
          )
        }

        if (hasSearch) {
          all = all.filter((record) => recordMatchesSearch(record, searchableFields, search))
        }

        if (filterInfo) {
          const conditions = filterInfo.conditions.filter((c) => fieldTypeById.has(c.fieldId))
          if (conditions.length > 0) {
            all = all.filter((record) => {
              const matches = (condition: MetaFilterCondition) => {
                const fieldType = fieldTypeById.get(condition.fieldId)
                if (!fieldType) return true
                return evaluateMetaFilterCondition(fieldType, record.data[condition.fieldId], condition)
              }

              if (filterInfo.conjunction === 'or') return conditions.some(matches)
              return conditions.every(matches)
            })
          }
        }

        // Native person (人员) sort-by-display: compareMetaSortValue's string fallback would order
        // person cells by raw `String(userId[])`, not the visible name. Resolve a userId→display
        // map once for the person fields that actually appear in the sort rules, then feed
        // compareMetaSortValue the joined DISPLAY string instead of the raw userId array.
        const personSortFieldIds = new Set(
          sortRules.filter((rule) => fieldTypeById.get(rule.fieldId) === 'person').map((rule) => rule.fieldId),
        )
        const personSortDisplayByUserId = personSortFieldIds.size > 0
          ? await resolvePersonSortDisplayMap(pool.query.bind(pool), all, personSortFieldIds)
          : new Map<string, string>()
        const personSortKey = (value: unknown): string => {
          if (!Array.isArray(value) || value.length === 0) return ''
          return value
            .map((item) => (typeof item === 'string' && item.trim() ? (personSortDisplayByUserId.get(item.trim()) ?? item.trim()) : ''))
            .filter(Boolean)
            .join(', ')
        }

        const sorted = sortRules.length > 0 ? [...all].sort((a, b) => {
          for (const rule of sortRules) {
            const fieldType = fieldTypeById.get(rule.fieldId) ?? 'string'
            const aValue = personSortFieldIds.has(rule.fieldId) ? personSortKey(a.data[rule.fieldId]) : a.data[rule.fieldId]
            const bValue = personSortFieldIds.has(rule.fieldId) ? personSortKey(b.data[rule.fieldId]) : b.data[rule.fieldId]
            const cmp = compareMetaSortValue(fieldType, aValue, bValue, rule.desc)
            if (cmp !== 0) return cmp
          }

          const aEpoch = toEpoch(a.createdAt)
          const bEpoch = toEpoch(b.createdAt)
          if (aEpoch !== null && bEpoch !== null && aEpoch !== bEpoch) {
            return aEpoch > bEpoch ? 1 : -1
          }
          return a.id.localeCompare(b.id)
        }) : all

        const total = sorted.length
        const paged = limit ? sorted.slice(offset, offset + limit) : sorted
        rows = paged.map((r) => ({ id: r.id, version: r.version, data: r.data, ...r.lock }))
        if (limit) page = { offset, limit, total, hasMore: offset + rows.length < total }
      } else {
        if (limit) {
          const recordRes = await pool.query(
            `SELECT id, version, data, locked, locked_by, locked_at, COUNT(*) OVER()::int AS total
             FROM meta_records
             WHERE sheet_id = $1
             ORDER BY created_at ASC, id ASC
             LIMIT $2 OFFSET $3`,
            [sheetId, limit, offset],
          )

          rows = recordRes.rows.map((r: any) => ({
            id: String(r.id),
            version: Number(r.version ?? 1),
            data: normalizeJson(r.data),
            ...mapRecordLockState(r),
          }))

          let total = Number((recordRes.rows[0] as any)?.total ?? 0)
          if (rows.length === 0 && offset > 0) {
            const countRes = await pool.query('SELECT COUNT(*)::int AS total FROM meta_records WHERE sheet_id = $1', [sheetId])
            total = Number((countRes.rows[0] as any)?.total ?? 0)
          }
          page = { offset, limit, total, hasMore: offset + rows.length < total }
        } else {
          const recordRes = await pool.query(
            'SELECT id, version, data, locked, locked_by, locked_at FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC',
            [sheetId],
          )

          rows = recordRes.rows.map((r: any) => ({
            id: String(r.id),
            version: Number(r.version ?? 1),
            data: normalizeJson(r.data),
            ...mapRecordLockState(r),
          }))
        }
      }

      const linkValuesByRecord = await loadLinkValuesByRecord(
        pool.query.bind(pool),
        rows.map((r) => r.id),
        relationalLinkFields,
      )

      if (relationalLinkFields.length > 0 && rows.length > 0) {
        for (const row of rows) {
          for (const { fieldId } of relationalLinkFields) {
            row.data[fieldId] = []
          }
        }

        for (const row of rows) {
          const recordMap = linkValuesByRecord.get(row.id)
          if (!recordMap) continue
          for (const { fieldId } of relationalLinkFields) {
            const list = recordMap.get(fieldId)
            if (list && list.length > 0) row.data[fieldId] = list
          }
        }

        // B3 review nit: blank a DERIVED (mirror) field's raw reverse ids for an actor who can't read the
        // mirror's foreign sheet — parity with the buildLinkSummaries gate below. Forward links untouched.
        await maskDerivedMirrorFieldIds(req, pool.query.bind(pool), rows, relationalLinkFields)
      }

      await applyLookupRollup(
        req,
        pool.query.bind(pool),
        sheetId,
        fields,
        rows,
        relationalLinkFields,
        linkValuesByRecord,
      )
      for (const row of rows) {
        row.data = filterRecordDataByFieldIds(row.data, allowedFieldIds)
      }
      const linkSummaries = includeLinkSummaries
        ? filterRecordFieldSummaryMap(
            serializeLinkSummaryMap(
              await buildLinkSummaries(
                req,
                pool.query.bind(pool),
                sheetId,
                rows,
                relationalLinkFields,
                linkValuesByRecord,
              ),
            ),
            allowedFieldIds,
          )
        : undefined
      const attachmentSummaries = attachmentFields.length > 0
        ? filterRecordFieldSummaryMap(
            serializeAttachmentSummaryMap(
              await buildAttachmentSummaries(
                pool.query.bind(pool),
                req,
                sheetId,
                rows,
                attachmentFields,
              ),
            ),
            allowedFieldIds,
          )
        : undefined
      // Native person (人员) display: ALWAYS assembled (not gated on includeLinkSummaries) because
      // a native person chip has no other display source — the value is just userId[].
      const personSummaries = personFields.length > 0
        ? filterRecordFieldSummaryMap(
            serializePersonSummaryMap(
              await buildPersonSummaries(pool.query.bind(pool), rows, personFields),
            ),
            allowedFieldIds,
          )
        : undefined
      // Record-level permission filtering: remove records user cannot read (admin bypass)
      if (!access.isAdminRole && access.userId && rows.length > 0) {
        const hasRecordPerms = await hasRecordPermissionAssignments(pool.query.bind(pool), sheetId)
        if (hasRecordPerms) {
          const recordScopeMap = await loadRecordPermissionScopeMap(
            pool.query.bind(pool),
            sheetId,
            rows.map((r) => r.id),
            access.userId,
          )
          if (recordScopeMap.size > 0) {
            rows = rows.filter((row) => {
              const perms = deriveRecordPermissions(row.id, capabilities, recordScopeMap)
              return perms.canRead
            })
          }
        }
      }

      const rowActionOverrides = buildRowActionOverrides(
        rows,
        requiresOwnWriteRowPolicy(sheetScope, access.isAdminRole)
          ? await loadRecordCreatorMap(pool.query.bind(pool), sheetId, rows.map((row) => row.id))
          : new Map(),
        capabilities,
        sheetScope,
        access,
      )
      // Per-row unlock gate (decision b): compute `canUnlock` server-side for the LOCKED rows so the
      // grid/drawer can show the unlock action without the client ever seeing `created_by`. The owner
      // layer needs each locked row's creator, so load a creator map scoped to just the locked ids.
      const lockedRowIds = rows.filter((row) => row.locked).map((row) => row.id)
      if (lockedRowIds.length > 0) {
        const lockedCreatorMap = await loadRecordCreatorMap(pool.query.bind(pool), sheetId, lockedRowIds)
        for (const row of rows) {
          if (!row.locked) continue
          row.canUnlock = canUnlock(
            access.userId ?? null,
            {
              lockedBy: row.lockedBy ?? null,
              createdBy: lockedCreatorMap.get(row.id) ?? null,
            },
            capabilities,
          )
        }
      }

      const viewScopeMap = (access.userId && viewConfig) ? await loadViewPermissionScopeMap(pool.query.bind(pool), [viewConfig.id], access.userId) : new Map()
      const permissions: MultitableScopedPermissions = {
        fieldPermissions: deriveFieldPermissions(fields, capabilities, {
          hiddenFieldIds: viewConfig?.hiddenFieldIds ?? [],
          fieldScopeMap,
        }),
        rowActions: deriveDefaultRowActions(capabilities, sheetScope, access.isAdminRole),
        ...(rowActionOverrides ? { rowActionOverrides } : {}),
        ...(viewConfig ? { viewPermissions: deriveViewPermissions([viewConfig], capabilities, viewScopeMap) } : {}),
      }

      const meta = warnings.length > 0 || hasFilterOrSort
        ? {
            ...(warnings.length > 0 ? { warnings } : {}),
            ...(hasFilterOrSort ? { computedFilterSort } : {}),
            ...(ignoredSortFieldIds.length > 0 ? { ignoredSortFieldIds } : {}),
            ...(ignoredFilterFieldIds.length > 0 ? { ignoredFilterFieldIds } : {}),
            capabilityOrigin,
            permissions,
          }
        : { capabilityOrigin, permissions }

      const view: UniverMetaView = {
        id: sheetId,
        fields: visiblePropertyFields,
        rows,
        ...(linkSummaries ? { linkSummaries } : {}),
        ...(personSummaries ? { personSummaries } : {}),
        ...(attachmentSummaries ? { attachmentSummaries } : {}),
        ...(viewConfig ? { view: redactViewConfigFilterLiterals(viewConfig, allowedFieldIds) } : {}),
        ...(meta ? { meta } : {}),
        ...(page ? { page } : {}),
      }
      return res.json({ ok: true, data: view })
    } catch (err) {
      // ②a §2a.4-c: a centralized sheet-create TOCTOU rejection surfaced by the `seed=true` branch
      // (createSeededSheet) maps to 400 VALIDATION_ERROR, mirroring POST /sheets (:6838).
      if (err instanceof CrossBaseLinkError) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: err.message } })
      }
      if (err instanceof ValidationError) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: err.message } })
      }
      if (err instanceof ConflictError) {
        return res.status(409).json({ ok: false, error: { code: 'CONFLICT', message: err.message } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] view failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load meta view' } })
    }
  })

  router.get('/form-context', conditionalPublicRateLimiter(publicFormContextLimiter), async (req: Request, res: Response) => {
    const sheetIdParam = typeof req.query.sheetId === 'string' ? req.query.sheetId.trim() : undefined
    const viewIdParam = typeof req.query.viewId === 'string' ? req.query.viewId.trim() : undefined
    const recordIdParam = typeof req.query.recordId === 'string' ? req.query.recordId.trim() : undefined
    const publicTokenParam = typeof req.query.publicToken === 'string' ? req.query.publicToken.trim() : ''

    try {
      const pool = poolManager.get()
      const resolved = await resolveMetaSheetId(pool as unknown as { query: QueryFn }, {
        sheetId: sheetIdParam,
        viewId: viewIdParam,
      })
      const sheetId = resolved.sheetId
      const { access, capabilities, capabilityOrigin, sheetScope } = await resolveSheetReadableCapabilities(req, pool.query.bind(pool), sheetId)
      const publicAccessAllowed = isPublicFormAccessAllowed(resolved.view, publicTokenParam)
      const protectedPublicAccess = publicAccessAllowed
        ? await evaluateProtectedPublicFormAccess(pool.query.bind(pool), req, resolved.view)
        : null
      if (protectedPublicAccess?.allowed === false) {
        return res.status(protectedPublicAccess.statusCode).json({
          ok: false,
          error: {
            code: protectedPublicAccess.code,
            message: protectedPublicAccess.message,
          },
        })
      }
      const effectivePublicAccessAllowed = publicAccessAllowed && (!protectedPublicAccess || protectedPublicAccess.allowed)
      if (!access.userId && !publicAccessAllowed) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      if (!effectivePublicAccessAllowed && !capabilities.canRead) return sendForbidden(res)
      const sheet = await loadSheetRow(pool.query.bind(pool), sheetId)
      if (!sheet) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }

      const fields = await loadFieldsForSheet(pool.query.bind(pool), sheetId)
      const effectiveCapabilities = effectivePublicAccessAllowed ? PUBLIC_FORM_CAPABILITIES : capabilities
      const effectiveCapabilityOrigin = effectivePublicAccessAllowed ? undefined : capabilityOrigin
      const effectiveSheetScope = effectivePublicAccessAllowed ? undefined : sheetScope
      const effectiveAccess = effectivePublicAccessAllowed ? { userId: '', permissions: [], isAdminRole: false } : access
      if (effectivePublicAccessAllowed && recordIdParam) {
        return res.status(400).json({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'Public forms do not support loading an existing record' },
        })
      }

      let record: UniverMetaRecord | undefined
      if (recordIdParam) {
        const recordRes = await pool.query(
          'SELECT id, version, data, created_by FROM meta_records WHERE id = $1 AND sheet_id = $2',
          [recordIdParam, sheetId],
        )
        const row: any = recordRes.rows[0]
        if (!row) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Record not found: ${recordIdParam}` } })
        }
        record = {
          id: String(row.id),
          version: Number(row.version ?? 1),
          data: normalizeJson(row.data),
          createdBy: typeof row.created_by === 'string' ? row.created_by : null,
        }
      }

      const hiddenFieldIds = new Set(resolved.view?.hiddenFieldIds ?? [])
      const visibleFields = fields.filter((field) => !hiddenFieldIds.has(field.id) && !isFieldPermissionHidden(field))
      const visibleFieldIds = new Set(visibleFields.map((field) => field.id))
      const fieldScopeMap = effectiveAccess.userId ? await loadFieldPermissionScopeMap(pool.query.bind(pool), sheetId, effectiveAccess.userId) : new Map()
      const viewScopeMap = (effectiveAccess.userId && resolved.view) ? await loadViewPermissionScopeMap(pool.query.bind(pool), [resolved.view.id], effectiveAccess.userId) : new Map()
      const fieldPermissions = deriveFieldPermissions(fields, effectiveCapabilities, {
        hiddenFieldIds: resolved.view?.hiddenFieldIds ?? [],
        allowCreateOnly: !record,
        fieldScopeMap,
      })
      // D1 (#2106): the record-value echo must honor layer-3 (field_permissions), not just layer-1∧2 — the
      // same composite /view + /records enforce (#2028). visibleFields already applied layer-1 (view.hidden) ∧
      // layer-2 (property.hidden); fieldPermissions[].visible adds layer-3. For an ANONYMOUS public-form caller
      // effectiveAccess.userId='' → fieldScopeMap is empty → this equals visibleFieldIds (the public path is
      // unchanged; anonymous has no subject to scope to).
      let readableFieldIds = new Set(visibleFields.filter((field) => fieldPermissions[field.id]?.visible !== false).map((field) => field.id))
      // §2a.3 read/JSON taint mask via the single CHOKEPOINT (maskStoredRecordFieldIds): in edit-mode
      // the form echoes an existing record's stored meta_records.data, so a formula over a denied
      // foreign lookup would leak its materialized value into the form prefill. The chokepoint drops
      // tainted formula fields (only matters when a record is loaded — create-mode has no stored value
      // to leak).
      if (record) {
        readableFieldIds = await maskStoredRecordFieldIds(req, pool.query.bind(pool), sheetId, visibleFields, readableFieldIds)
      }
      const viewPermissions = resolved.view ? deriveViewPermissions([resolved.view], effectiveCapabilities, viewScopeMap) : {}
      const rowActions = record
        ? deriveRecordRowActions(effectiveCapabilities, effectiveSheetScope, effectiveAccess, record.createdBy)
        : deriveRecordRowActions({
            ...effectiveCapabilities,
            canEditRecord: effectiveCapabilities.canCreateRecord,
            canDeleteRecord: false,
          }, effectiveSheetScope, effectiveAccess, null)
      const attachmentFields = visibleFields.filter((field) => field.type === 'attachment')
      const attachmentSummaries = record && attachmentFields.length > 0
        ? filterSingleRecordFieldSummaryMap(
            serializeAttachmentSummaryMap(
              await buildAttachmentSummaries(
                pool.query.bind(pool),
                req,
                sheetId,
                [record],
                attachmentFields,
              ),
            )[record.id] ?? {},
            readableFieldIds,
          )
        : undefined
      if (record) {
        record.data = filterRecordDataByFieldIds(record.data, readableFieldIds)
      }

      return res.json({
        ok: true,
        data: {
          mode: 'form',
          readOnly: !effectiveCapabilities.canCreateRecord,
          submitPath: resolved.view
            ? (effectivePublicAccessAllowed && publicTokenParam
              ? buildPublicFormSubmitPath(resolved.view.id, publicTokenParam)
              : `/api/multitable/views/${resolved.view.id}/submit`)
            : '/api/multitable/records',
          sheet,
          // Requester-aware view echo (unchanged from pre-A4): redactViewConfigFilterLiterals keeps
          // filter literals the requester may read and redacts denied ones (#2052 / R5b). NOTE: this still
          // echoes view.config.publicForm to anonymous callers — a PRE-EXISTING leak (NOT introduced by A4),
          // tracked separately so it gets its own one-concern fix rather than riding this feature PR.
          ...(resolved.view ? { view: redactViewConfigFilterLiterals(resolved.view, await loadAllowedFieldIds(pool.query.bind(pool), sheetId, access.userId, capabilities)) } : {}),
          // A4 SAFE form-logic projection: ONLY the presentational layout sub-objects (pages / prefill
          // allowlist / validated redirect / confirmation text), normalized by sanitizeFormLayout. Built
          // from view.config.formLayout via a whitelist — never carries publicForm or other config keys.
          ...(resolved.view ? (() => { const layout = projectPublicFormLayout(resolved.view.config); return layout ? { formLayout: layout } : {} })() : {}),
          fields: visibleFields,
          capabilities: effectiveCapabilities,
          ...(effectiveCapabilityOrigin ? { capabilityOrigin: effectiveCapabilityOrigin } : {}),
          fieldPermissions,
          ...(resolved.view ? { viewPermissions } : {}),
          ...(record ? { rowActions } : {}),
          ...(record ? { record } : {}),
          ...(attachmentSummaries ? { attachmentSummaries } : {}),
          ...(record
            ? {
              commentsScope: {
                targetType: 'meta_record',
                targetId: record.id,
                baseId: sheet.baseId ?? null,
                sheetId: sheet.id,
                viewId: resolved.view?.id ?? null,
                recordId: record.id,
                containerType: 'meta_sheet',
                containerId: sheet.id,
              },
            }
            : {}),
        },
      })
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: err.message } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] form-context failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load form context' } })
    }
  })

  router.post('/views/:viewId/submit', conditionalPublicRateLimiter(publicFormSubmitLimiter), async (req: Request, res: Response) => {
    const viewId = typeof req.params.viewId === 'string' ? req.params.viewId.trim() : ''
    if (!viewId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'viewId is required' } })
    }

    const schema = z.object({
      recordId: z.string().min(1).optional(),
      expectedVersion: z.number().int().nonnegative().optional(),
      publicToken: z.string().min(1).optional(),
      data: z.record(z.unknown()).optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const pool = poolManager.get()
      const view = await tryResolveView(pool as unknown as { query: QueryFn }, viewId)
      if (!view) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `View not found: ${viewId}` } })
      }

      const sheet = await loadSheetRow(pool.query.bind(pool), view.sheetId)
      if (!sheet) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${view.sheetId}` } })
      }
      const { access, capabilities, sheetScope } = await resolveSheetCapabilities(req, pool.query.bind(pool), view.sheetId)
      const publicTokenParam = typeof parsed.data.publicToken === 'string'
        ? parsed.data.publicToken.trim()
        : typeof req.query.publicToken === 'string'
          ? req.query.publicToken.trim()
          : ''
      const publicAccessAllowed = isPublicFormAccessAllowed(view, publicTokenParam)
      const protectedPublicAccess = publicAccessAllowed
        ? await evaluateProtectedPublicFormAccess(pool.query.bind(pool), req, view)
        : null
      if (protectedPublicAccess?.allowed === false) {
        return res.status(protectedPublicAccess.statusCode).json({
          ok: false,
          error: {
            code: protectedPublicAccess.code,
            message: protectedPublicAccess.message,
          },
        })
      }
      const effectivePublicAccessAllowed = publicAccessAllowed && (!protectedPublicAccess || protectedPublicAccess.allowed)
      if (!access.userId && !publicAccessAllowed) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      const effectiveCapabilities = effectivePublicAccessAllowed ? PUBLIC_FORM_CAPABILITIES : capabilities
      const effectiveSheetScope = effectivePublicAccessAllowed ? undefined : sheetScope
      const effectiveAccess = effectivePublicAccessAllowed ? { userId: '', permissions: [], isAdminRole: false } : access
      if (effectivePublicAccessAllowed && parsed.data.recordId) {
        return res.status(400).json({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: 'Public forms do not support updating an existing record' },
        })
      }
      const canWriteFormRecord = parsed.data.recordId ? effectiveCapabilities.canEditRecord : effectiveCapabilities.canCreateRecord
      if (!canWriteFormRecord) return sendForbidden(res)

      const fields = await loadFieldsForSheet(pool.query.bind(pool), view.sheetId)
      const fieldById = buildFieldMutationGuardMap(fields)

      const hiddenFieldIds = new Set(view.hiddenFieldIds ?? [])
      const data = parsed.data.data ?? {}
      const fieldErrors: Record<string, string> = {}
      const patch: Record<string, unknown> = {}
      const linkUpdates = new Map<string, { ids: string[]; cfg: LinkFieldConfig }>()

      // Native person (人员): resolve the sheet member set ONCE per request (lazily, only when a
      // person field value is actually written) — parallel to the link-target-exists hot-path —
      // and reuse it for every person cell's write-time membership validation (SECURITY boundary).
      let personMemberUserIds: Set<string> | null = null
      const resolvePersonMemberUserIds = async (): Promise<Set<string>> => {
        if (personMemberUserIds === null) {
          personMemberUserIds = await loadSheetMemberUserIdSet(pool.query.bind(pool), view.sheetId)
        }
        return personMemberUserIds
      }

      for (const [fieldId, value] of Object.entries(data)) {
        const field = fieldById.get(fieldId)
        if (!field) {
          fieldErrors[fieldId] = 'Unknown field'
          continue
        }
        if (field.hidden) {
          fieldErrors[fieldId] = 'Field is hidden'
          continue
        }
        if (hiddenFieldIds.has(fieldId)) {
          fieldErrors[fieldId] = 'Field is not available in this form'
          continue
        }
        if (field.readOnly === true || field.type === 'lookup' || field.type === 'rollup') {
          fieldErrors[fieldId] = 'Field is readonly'
          continue
        }

        if (field.type === 'select') {
          if (typeof value !== 'string') {
            fieldErrors[fieldId] = 'Select value must be a string'
            continue
          }
          const allowed = new Set(field.options ?? [])
          if (value !== '' && !allowed.has(value)) {
            fieldErrors[fieldId] = 'Invalid select option'
            continue
          }
        }

        if (field.type === 'multiSelect') {
          try {
            patch[fieldId] = normalizeMultiSelectValue(value, fieldId, field.options ?? [])
          } catch (error) {
            fieldErrors[fieldId] = error instanceof Error ? error.message : String(error)
          }
          continue
        }

        if (field.type === 'person') {
          try {
            const allowed = await resolvePersonMemberUserIds()
            patch[fieldId] = validatePersonValue(value, fieldId, allowed, isPersonSingleRecord(field.property))
          } catch (error) {
            fieldErrors[fieldId] = error instanceof Error ? error.message : String(error)
          }
          continue
        }

        if (field.type === 'link') {
          if (!field.link) {
            fieldErrors[fieldId] = 'Link field is missing foreign sheet configuration'
            continue
          }
          const ids = normalizeLinkIds(value)
          if (field.link.limitSingleRecord && ids.length > 1) {
            fieldErrors[fieldId] = 'Only one linked record is allowed'
            continue
          }
          const tooLong = ids.find((id) => id.length > 50)
          if (tooLong) {
            fieldErrors[fieldId] = `Link id too long: ${tooLong}`
            continue
          }
          if (ids.length > 0) {
            const exists = await pool.query(
              'SELECT id FROM meta_records WHERE sheet_id = $1 AND id = ANY($2::text[])',
              [field.link.foreignSheetId, ids],
            )
            const found = new Set((exists.rows as any[]).map((row: any) => String(row.id)))
            const missing = ids.filter((id) => !found.has(id))
            if (missing.length > 0) {
              fieldErrors[fieldId] = `Linked record not found: ${missing.join(', ')}`
              continue
            }
          }
          patch[fieldId] = ids
          linkUpdates.set(fieldId, { ids, cfg: field.link })
          continue
        }

        if (field.type === 'attachment') {
          const ids = normalizeAttachmentIds(value)
          const tooLong = ids.find((id) => id.length > 100)
          if (tooLong) {
            fieldErrors[fieldId] = `Attachment id too long: ${tooLong}`
            continue
          }
          const attachmentError = await ensureAttachmentIdsExist(pool.query.bind(pool), view.sheetId, fieldId, ids)
          if (attachmentError) {
            fieldErrors[fieldId] = attachmentError
            continue
          }
          patch[fieldId] = ids
          continue
        }

        if (field.type === 'formula') {
          if (typeof value !== 'string') {
            fieldErrors[fieldId] = 'Formula value must be a string'
            continue
          }
          if (value !== '' && !value.startsWith('=')) {
            fieldErrors[fieldId] = 'Formula must start with ='
            continue
          }
        }

        if (field.type === 'longText') {
          try {
            patch[fieldId] = validateLongTextValue(value, fieldId, field.property)
          } catch (error) {
            fieldErrors[fieldId] = error instanceof Error ? error.message : String(error)
          }
          continue
        }

        if (BATCH1_FIELD_TYPES.has(field.type)) {
          try {
            patch[fieldId] = coerceBatch1Value(field.type, field.property, fieldId, value)
          } catch (error) {
            fieldErrors[fieldId] = error instanceof Error ? error.message : String(error)
          }
          continue
        }

        patch[fieldId] = value
      }

      if (Object.keys(fieldErrors).length > 0) {
        const hiddenOnly = Object.values(fieldErrors).every((message) => message === 'Field is hidden')
        const readonlyOnly = Object.values(fieldErrors).every((message) => message === 'Field is readonly')
        return res.status(hiddenOnly || readonlyOnly ? 403 : 400).json({
          ok: false,
          error: {
            code: hiddenOnly ? 'FIELD_HIDDEN' : readonlyOnly ? 'FIELD_READONLY' : 'VALIDATION_ERROR',
            message: hiddenOnly ? 'Hidden field update rejected' : readonlyOnly ? 'Readonly field update rejected' : 'Validation failed',
            fieldErrors,
          },
        })
      }

      // --- Field validation rules ---
      const validationFields = fields.map((f) => {
        const prop = normalizeJson(f.property) as Record<string, unknown> | undefined
        const explicitRules = Array.isArray(prop?.validation) ? prop!.validation as FieldValidationConfig : undefined
        const defaultRules = getDefaultValidationRules(f.type, prop ?? undefined)
        const mergedRules = explicitRules ?? defaultRules
        return {
          id: f.id,
          name: f.name,
          type: f.type,
          config: mergedRules.length > 0 ? { validation: mergedRules } : undefined,
        }
      })
      const validationResult = validateRecord(validationFields, patch)
      if (!validationResult.valid) {
        return res.status(422).json({
          error: 'VALIDATION_FAILED',
          message: 'Record validation failed',
          fieldErrors: validationResult.errors,
        })
      }

      const recordId = parsed.data.recordId
      let resultRecordId = recordId ?? buildId('rec')
      let nextVersion = 1

      await pool.transaction(async ({ query }) => {
        await acquireAutoNumberSheetWriteLock(query, view.sheetId)

        if (recordId) {
          const currentRes = await query(
            'SELECT id, version, created_by, locked, locked_by FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE',
            [recordId, view.sheetId],
          )
          if ((currentRes as any).rows.length === 0) {
            throw new NotFoundError(`Record not found: ${recordId}`)
          }
          const currentRow: any = (currentRes as any).rows[0]
          if (!ensureRecordWriteAllowed(effectiveCapabilities, effectiveSheetScope, effectiveAccess, typeof currentRow?.created_by === 'string' ? currentRow.created_by : null, 'edit')) {
            throw new ValidationError('Record editing is not allowed for this row')
          }
          // Record-lock guard (rank-8 review B2; decision d/e). The form-submit EDIT branch is reachable
          // only by an authenticated member with edit rights — exactly the non-locker the lock must stop.
          ensureRecordNotLocked(getRequestActorId(req), currentRow, () => new RecordLockedError())
          const serverVersion = Number(currentRow?.version ?? 1)
          if (typeof parsed.data.expectedVersion === 'number' && parsed.data.expectedVersion !== serverVersion) {
            throw new VersionConflictError(recordId, serverVersion)
          }

          if (Object.keys(patch).length > 0) {
            // lock-guarded: form-submit EDIT (B2) — ensureRecordNotLocked enforced just above.
            const updateRes = await query(
              `UPDATE meta_records
               SET data = data || $1::jsonb, updated_at = now(), version = version + 1, modified_by = $4
               WHERE id = $2 AND sheet_id = $3
               RETURNING version`,
              [JSON.stringify(patch), recordId, view.sheetId, getRequestActorId(req)],
            )
            nextVersion = Number((updateRes as any).rows[0]?.version ?? serverVersion)
          } else {
            nextVersion = serverVersion
          }

          for (const [fieldId, { ids }] of linkUpdates.entries()) {
            const currentLinks = await query(
              'SELECT foreign_record_id FROM meta_links WHERE field_id = $1 AND record_id = $2',
              [fieldId, recordId],
            )
            const existingIds = (currentLinks as any).rows.map((row: any) => String(row.foreign_record_id))
            const existing = new Set(existingIds)
            const next = new Set(ids)
            const toDelete = existingIds.filter((id) => !next.has(id))
            const toInsert = ids.filter((id) => !existing.has(id))

            if (toDelete.length > 0) {
              await query(
                'DELETE FROM meta_links WHERE field_id = $1 AND record_id = $2 AND foreign_record_id = ANY($3::text[])',
                [fieldId, recordId, toDelete],
              )
            }
            for (const foreignId of toInsert) {
              await query(
                `INSERT INTO meta_links (id, field_id, record_id, foreign_record_id)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT DO NOTHING`,
                [buildId('lnk').slice(0, 50), fieldId, recordId, foreignId],
              )
            }
            if (ids.length === 0) {
              await query('DELETE FROM meta_links WHERE field_id = $1 AND record_id = $2', [fieldId, recordId])
            }
          }
          return
        }

        const latestFields = await loadFieldsForSheet(query, view.sheetId)
        Object.assign(patch, await allocateAutoNumberValues(query, view.sheetId, latestFields))

        const insertRes = await query(
          `INSERT INTO meta_records (id, sheet_id, data, version, created_by, modified_by)
           VALUES ($1, $2, $3::jsonb, 1, $4, $4)
           RETURNING id, version`,
          [
            resultRecordId,
            view.sheetId,
            JSON.stringify(patch),
            effectivePublicAccessAllowed && !access.userId ? null : getRequestActorId(req),
          ],
        )
        resultRecordId = String((insertRes as any).rows[0]?.id ?? resultRecordId)
        nextVersion = Number((insertRes as any).rows[0]?.version ?? 1)

        for (const [fieldId, { ids }] of linkUpdates.entries()) {
          for (const foreignId of ids) {
            await query(
              `INSERT INTO meta_links (id, field_id, record_id, foreign_record_id)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT DO NOTHING`,
              [buildId('lnk').slice(0, 50), fieldId, resultRecordId, foreignId],
            )
          }
        }
      })

      const recordRes = await pool.query(
        'SELECT id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2',
        [resultRecordId, view.sheetId],
      )
      const row: any = recordRes.rows[0]
      if (!row) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Record not found: ${resultRecordId}` } })
      }

      const record: UniverMetaRecord = {
        id: String(row.id),
        version: Number(row.version ?? nextVersion),
        data: normalizeJson(row.data),
      }
      const visibleFormFields = fields.filter((field) => !hiddenFieldIds.has(field.id) && !isFieldPermissionHidden(field))
      const visibleFormFieldIds = new Set(visibleFormFields.map((field) => field.id))
      // D1 (#2106): gate the write echo by layer-2 ∧ layer-3 (the #2028 composite), not just layer-1∧2. This
      // covers a denied field the submitter never sent — a server-assigned / recalculated formula value. The
      // submit handler loads no fieldScopeMap today; add one. ANONYMOUS (effectiveAccess.userId='') → empty
      // scope map → readableEchoFieldIds equals visibleFormFieldIds, so the public-form echo is unchanged.
      const echoFieldScopeMap = effectiveAccess.userId ? await loadFieldPermissionScopeMap(pool.query.bind(pool), view.sheetId, effectiveAccess.userId) : new Map()
      const echoFieldPermissions = deriveFieldPermissions(fields, effectiveCapabilities, { hiddenFieldIds: view.hiddenFieldIds ?? [], fieldScopeMap: echoFieldScopeMap })
      // §2a.3 read/JSON taint mask via the single CHOKEPOINT (maskStoredRecordFieldIds) — C1: in
      // EDIT mode (`recordId` present) this echo re-reads the existing record's stored
      // meta_records.data, which holds a previously-materialized AUTHORIZED formula value. The
      // taint-SKIPPED recalcNewRecordFormulas overlay below only OVERWRITES a formula it recomputes —
      // a tainted formula is absent from `formulaValues`, so the stored authorized value would survive
      // into the echo to a foreign-field-denied (often anonymous) submitter. The chokepoint drops
      // tainted formula fields so that value is withheld. Harmless in create mode (no stored value;
      // overlay already taint-skips), so applied uniformly.
      const readableEchoFieldIds = await maskStoredRecordFieldIds(
        req,
        pool.query.bind(pool),
        view.sheetId,
        visibleFormFields,
        new Set(visibleFormFields.filter((field) => echoFieldPermissions[field.id]?.visible !== false).map((field) => field.id)),
      )

      const relationalLinkFields = fields
        .map((field) => (field.type === 'link' ? { fieldId: field.id, cfg: parseLinkFieldConfig(field.property) } : null))
        .filter((value): value is RelationalLinkField => !!value && !!value.cfg)
      const attachmentFields = visibleFormFields.filter((field) => field.type === 'attachment')
      const linkValuesByRecord = await loadLinkValuesByRecord(pool.query.bind(pool), [record.id], relationalLinkFields)
      for (const { fieldId } of relationalLinkFields) {
        record.data[fieldId] = linkValuesByRecord.get(record.id)?.get(fieldId) ?? []
      }
      // B3 review nit: blank a mirror field's raw reverse ids for a foreign-sheet-denied actor (write-echo).
      await maskDerivedMirrorFieldIds(req, pool.query.bind(pool), [record], relationalLinkFields)
      record.data = filterRecordDataByFieldIds(record.data, readableEchoFieldIds)
      const attachmentSummaries = attachmentFields.length > 0
        ? filterSingleRecordFieldSummaryMap(
            serializeAttachmentSummaryMap(
              await buildAttachmentSummaries(
                pool.query.bind(pool),
                req,
                view.sheetId,
                [record],
                attachmentFields,
              ),
            )[record.id] ?? {},
            readableEchoFieldIds,
          )
        : undefined

      // Recalculate the submitted record's formula fields (A-min-create #2255). Reuse the shared
      // route helper: it hydrates same-record lookup/rollup FIRST so a formula-over-lookup computes
      // against the actual value instead of the absent-on-reload `0`. NO dependency gate — the
      // submitted record computes ALL its formulas once. Echo + realtime stay behind the D1 field
      // mask (readableEchoFieldIds); `formulaEcho` carries the masked values into the broadcast.
      const formulaEcho: Record<string, unknown> = {}
      try {
        const recomputed = await recalcNewRecordFormulas(req, pool.query.bind(pool), view.sheetId, [record.id])
        const formulaValues = recomputed.find((entry) => entry.recordId === record.id)?.data
        if (formulaValues) {
          // record.data was already filtered + link-merged above; overlay only the visible formula
          // fields (avoids clobbering normalized link values, and never surfaces a masked field).
          for (const field of fields) {
            if (field.type === 'formula' && field.id in formulaValues && readableEchoFieldIds.has(field.id)) {
              record.data[field.id] = formulaValues[field.id]
              formulaEcho[field.id] = formulaValues[field.id]
            }
          }
        }
      } catch (recalcErr) {
        console.error('[univer-meta] formula recalculation failed:', recalcErr)
      }

      // Audit log for public form submissions
      if (publicAccessAllowed && publicTokenParam) {
        console.info('[public-form-submission]', JSON.stringify({
          viewId,
          publicToken: publicTokenParam.slice(0, 8) + '...',
          ip: req.ip,
          recordId: record.id,
          timestamp: new Date().toISOString(),
        }))
      }

      publishMultitableSheetRealtime({
        spreadsheetId: view.sheetId,
        actorId: getRequestActorId(req),
        source: 'multitable',
        kind: 'record-updated',
        recordId: record.id,
        recordIds: [record.id],
        fieldIds: [...new Set([...Object.keys(patch), ...Object.keys(formulaEcho)])],
        recordPatches: [{
          recordId: record.id,
          version: record.version,
          patch: { ...patch, ...formulaEcho },
        }],
      })

      return res.json({
        ok: true,
        data: {
          mode: recordId ? 'update' : 'create',
          record,
          ...(attachmentSummaries ? { attachmentSummaries } : {}),
          commentsScope: {
            targetType: 'meta_record',
            targetId: record.id,
            baseId: sheet.baseId ?? null,
            sheetId: sheet.id,
            viewId: view.id,
            recordId: record.id,
            containerType: 'meta_sheet',
            containerId: sheet.id,
          },
        },
      })
    } catch (err) {
      if (err instanceof VersionConflictError) {
        return res.status(409).json({
          ok: false,
          error: {
            code: 'VERSION_CONFLICT',
            message: err.message,
            serverVersion: err.serverVersion,
          },
        })
      }
      if (err instanceof NotFoundError) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: err.message } })
      }
      if (err instanceof RecordLockedError) {
        return sendForbidden(res, err.message)
      }
      if (err instanceof ValidationError) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: err.message } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] view submit failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to submit multitable view form' } })
    }
  })

  router.patch('/records/:recordId', async (req: Request, res: Response) => {
    const recordId = typeof req.params.recordId === 'string' ? req.params.recordId.trim() : ''
    if (!recordId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'recordId is required' } })
    }

    const schema = z.object({
      sheetId: z.string().min(1).optional(),
      viewId: z.string().min(1).optional(),
      expectedVersion: z.number().int().nonnegative().optional(),
      data: z.record(z.unknown()).optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const pool = poolManager.get()
      let sheetId = parsed.data.sheetId
      if (parsed.data.sheetId || parsed.data.viewId) {
        const resolved = await resolveMetaSheetId(pool as unknown as { query: QueryFn }, {
          sheetId: parsed.data.sheetId,
          viewId: parsed.data.viewId,
        })
        sheetId = resolved.sheetId
      }

      const recordLookup = sheetId
        ? await pool.query('SELECT id, sheet_id FROM meta_records WHERE id = $1 AND sheet_id = $2', [recordId, sheetId])
        : await pool.query('SELECT id, sheet_id FROM meta_records WHERE id = $1', [recordId])
      const recordRow: any = recordLookup.rows[0]
      if (!recordRow) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Record not found: ${recordId}` } })
      }
      sheetId = String(recordRow.sheet_id)

      const sheet = await loadSheetRow(pool.query.bind(pool), sheetId)
      if (!sheet) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      const { access, capabilities, sheetScope } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!access.userId) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      if (!capabilities.canEditRecord) return sendForbidden(res)

      const recordService = new RecordService(pool, eventBus)
      if (yjsInvalidator) {
        recordService.setPostCommitHooks([createYjsInvalidationPostCommitHook(yjsInvalidator)])
      }
      const patchResult = await recordService.patchRecord({
        recordId,
        sheetId,
        data: parsed.data.data ?? {},
        expectedVersion: parsed.data.expectedVersion,
        actorId: getRequestActorId(req),
        access,
        capabilities,
        sheetScope,
      })
      const fields = patchResult.fields
      const nextVersion = patchResult.version

      const recordRes = await pool.query(
        'SELECT id, version, data, locked, locked_by, locked_at FROM meta_records WHERE id = $1 AND sheet_id = $2',
        [recordId, sheetId],
      )
      const row: any = recordRes.rows[0]
      if (!row) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Record not found: ${recordId}` } })
      }

      const record: UniverMetaRecord = {
        id: String(row.id),
        version: Number(row.version ?? nextVersion),
        data: normalizeJson(row.data),
        ...mapRecordLockState(row),
      }
      const visiblePropertyFields = filterVisiblePropertyFields(fields)
      // F3 (#2106 §3 F3): the write already happened above; this set gates ONLY the read-back echo, so it must
      // honor layer-3 field_permissions, not just layer-2 (property.hidden). Same composite as the #2028 read
      // mask. The write gate (canEditRecord + RecordService) is unchanged — a write-only-no-read field is still
      // writable, just omitted from the echo.
      const echoFieldScopeMap = access.userId ? await loadFieldPermissionScopeMap(pool.query.bind(pool), sheetId, access.userId) : new Map()
      const echoFieldPermissions = deriveFieldPermissions(visiblePropertyFields, capabilities, { hiddenFieldIds: [], fieldScopeMap: echoFieldScopeMap })
      const readableEchoFields = visiblePropertyFields.filter((field) => echoFieldPermissions[field.id]?.visible !== false)
      // §2a.3 read/JSON taint mask via the single CHOKEPOINT (maskStoredRecordFieldIds): the echo
      // re-reads the stored meta_records.data, so a formula over a denied foreign lookup would leak its
      // materialized value back to the writer. The chokepoint drops tainted formula fields from the
      // echo's allowed set. The write-side recompute skip leaves the stored formula at the authorized
      // value; this prevents re-emitting it to a foreign-field-denied actor.
      const readableEchoFieldIds = await maskStoredRecordFieldIds(
        req,
        pool.query.bind(pool),
        sheetId,
        readableEchoFields,
        new Set(readableEchoFields.map((field) => field.id)),
      )

      const relationalLinkFields = fields
        .map((field) => (field.type === 'link' ? { fieldId: field.id, cfg: parseLinkFieldConfig(field.property) } : null))
        .filter((value): value is RelationalLinkField => !!value && !!value.cfg)
      const attachmentFields = readableEchoFields.filter((field) => field.type === 'attachment')
      const linkValuesByRecord = await loadLinkValuesByRecord(pool.query.bind(pool), [record.id], relationalLinkFields)
      for (const { fieldId } of relationalLinkFields) {
        record.data[fieldId] = linkValuesByRecord.get(record.id)?.get(fieldId) ?? []
      }
      // B3 review nit: blank a mirror field's raw reverse ids for a foreign-sheet-denied actor (write-echo).
      await maskDerivedMirrorFieldIds(req, pool.query.bind(pool), [record], relationalLinkFields)
      record.data = filterRecordDataByFieldIds(record.data, readableEchoFieldIds)
      const attachmentSummaries = attachmentFields.length > 0
        ? filterSingleRecordFieldSummaryMap(
            serializeAttachmentSummaryMap(
              await buildAttachmentSummaries(
                pool.query.bind(pool),
                req,
                sheetId,
                [record],
                attachmentFields,
              ),
            )[record.id] ?? {},
            readableEchoFieldIds,
          )
        : undefined

      return res.json({
        ok: true,
        data: {
          record,
          ...(attachmentSummaries ? { attachmentSummaries } : {}),
          commentsScope: {
            targetType: 'meta_record',
            targetId: record.id,
            baseId: sheet.baseId ?? null,
            sheetId: sheet.id,
            viewId: parsed.data.viewId ?? null,
            recordId: record.id,
            containerType: 'meta_sheet',
            containerId: sheet.id,
          },
        },
      })
    } catch (err) {
      if (err instanceof RecordServicePatchFieldValidationError) {
        return res.status(err.statusCode).json({
          ok: false,
          error: {
            code: err.code,
            message: err.message,
            fieldErrors: err.fieldErrors,
          },
        })
      }
      if (err instanceof RecordServiceVersionConflictError || err instanceof VersionConflictError) {
        return res.status(409).json({
          ok: false,
          error: {
            code: 'VERSION_CONFLICT',
            message: err.message,
            serverVersion: err.serverVersion,
          },
        })
      }
      if (err instanceof RecordServiceNotFoundError || err instanceof NotFoundError) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: err.message } })
      }
      if (err instanceof RecordServicePermissionError || err instanceof PermissionError) {
        return sendForbidden(res, err.message)
      }
      if (err instanceof RecordServiceValidationError || err instanceof ValidationError) {
        const code = err instanceof RecordServiceValidationError ? err.code : 'VALIDATION_ERROR'
        return res.status(400).json({ ok: false, error: { code, message: err.message } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] patch record failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to patch meta record' } })
    }
  })

  /**
   * GET /records - Cursor-based paginated record listing.
   *
   * Query params:
   *   sheetId   (required)  - sheet to query
   *   cursor    (optional)  - opaque cursor from previous response
   *   limit     (optional)  - page size (default 100, max 5000)
   *   sortField (optional)  - field id to sort by
   *   sortDir   (optional)  - 'asc' | 'desc'
   *   filter.*  (optional)  - field-level equality filters (e.g. filter.status=active)
   *
   * When `cursor` is absent the first page is returned.
   * When `cursor` is present, offset-based params are ignored.
   */
  router.get('/records', async (req: Request, res: Response) => {
    const sheetId = typeof req.query.sheetId === 'string' ? req.query.sheetId.trim() : ''
    if (!sheetId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId is required' } })
    }

    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor.trim() : undefined
    const limitRaw = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : undefined
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw!, 1), 5000) : 100
    const sortField = typeof req.query.sortField === 'string' ? req.query.sortField.trim() : undefined
    const sortDir = req.query.sortDir === 'desc' ? 'desc' as const : 'asc' as const

    // Collect filter.* query params
    const filter: Record<string, string> = {}
    for (const [key, val] of Object.entries(req.query)) {
      if (key.startsWith('filter.') && typeof val === 'string') {
        filter[key.slice(7)] = val
      }
    }

    try {
      const pool = poolManager.get()

      // F0a (#2106 §3 F0a / §4): this cursor-list endpoint previously had NO authorization, NO field
      // mask, and a subject-less response cache — any authenticated caller could read any sheet's full
      // records by id, and filter.*/sortField over a denied field was an oracle a data mask alone would
      // not close. Apply the full read gate (mirrors GET /view): sheet canRead → layer-2 ∧ layer-3 field
      // mask → filter/sort selection gate → record-permission filter. The response cache is REMOVED (see
      // the deleted records-query-cache block): a subject-scoped mask cannot ride a subject-less cache key
      // without cross-subject poisoning, and this is not the grid hot path (the grid uses GET /view), so
      // dropping the cache is smaller and safer than designing a subject-aware key.
      const { access, capabilities } = await resolveSheetReadableCapabilities(req, pool.query.bind(pool), sheetId)
      if (!access.userId) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      if (!capabilities.canRead) return sendForbidden(res)

      // Field-read gate: layer-2 (property.hidden) ∧ layer-3 (field_permissions.visible) — the #2015
      // composite shared with GET /view. hiddenFieldIds:[] keeps layer-1 a display-only concern (this list
      // endpoint takes a sheetId, not a viewId, so layer-1 does not apply here). access.userId is
      // guaranteed truthy past the 401 above.
      const fields = await loadSheetFields(pool as unknown as { query: QueryFn }, sheetId)
      const visiblePropertyFields = filterVisiblePropertyFields(fields)
      const fieldScopeMap = await loadFieldPermissionScopeMap(pool.query.bind(pool), sheetId, access.userId)
      const securityFieldPermissions = deriveFieldPermissions(visiblePropertyFields, capabilities, { hiddenFieldIds: [], fieldScopeMap })
      // §2a.3 read/JSON taint mask via the single CHOKEPOINT (maskStoredRecordFieldIds): drop tainted
      // formula fields whose materialized value derives from a denied foreign lookup, before the
      // per-row data-mask below (parity with GET /view).
      const allowedFieldIds = await maskStoredRecordFieldIds(
        req,
        pool.query.bind(pool),
        sheetId,
        visiblePropertyFields,
        new Set(visiblePropertyFields.filter((field) => securityFieldPermissions[field.id]?.visible !== false).map((field) => field.id)),
      )

      // Selection gate (#2044 parity): filter.*/sortField over a field the caller cannot read (denied,
      // statically hidden, or non-existent — all ∉ allowedFieldIds) is a value/ordering oracle that
      // survives the data mask. Reject with one generic 400 whose message names NO field and is identical
      // for denied vs non-existent, so it cannot be used to probe field existence.
      const selectionFieldIds = [...Object.keys(filter), ...(sortField ? [sortField] : [])]
      if (selectionFieldIds.some((fieldId) => !allowedFieldIds.has(fieldId))) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Field not permitted for filter/sort' } })
      }

      const sort = sortField ? { fieldId: sortField, direction: sortDir } : undefined
      const result: CursorPaginatedResult<LoadedMultitableRecord> = await queryRecordsWithCursor({
        query: pool.query.bind(pool),
        sheetId,
        cursor: cursor || undefined,
        limit,
        sort,
        filter,
      })

      // Record-permission filter (parity with GET /view): drop records the subject cannot read when
      // record-level assignments exist. Read is grant-additive today, so this is mostly defense-in-depth,
      // but keeps GET /records' record posture identical to GET /view.
      let items = result.items
      if (!access.isAdminRole && access.userId && items.length > 0) {
        const hasRecordPerms = await hasRecordPermissionAssignments(pool.query.bind(pool), sheetId)
        if (hasRecordPerms) {
          const recordScopeMap = await loadRecordPermissionScopeMap(
            pool.query.bind(pool),
            sheetId,
            items.map((r) => r.id),
            access.userId,
          )
          if (recordScopeMap.size > 0) {
            items = items.filter((r) => deriveRecordPermissions(r.id, capabilities, recordScopeMap).canRead)
          }
        }
      }

      const body = {
        ok: true,
        data: {
          records: items.map((r) => ({
            id: r.id,
            version: r.version,
            data: filterRecordDataByFieldIds(r.data, allowedFieldIds),
            // Lock metadata is TOP-LEVEL (never inside data) — not subject to the §2a.3 data mask.
            locked: r.locked,
            lockedBy: r.lockedBy,
            lockedAt: r.lockedAt,
          })),
          nextCursor: result.nextCursor,
          hasMore: result.hasMore,
        },
      }
      return res.json(body)
    } catch (err: any) {
      if (err?.code === 'VALIDATION_ERROR') {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: err.message } })
      }
      if (err?.code === 'NOT_FOUND') {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: err.message } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] cursor records query failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to query records' } })
    }
  })

  router.get('/records/:recordId', async (req: Request, res: Response) => {
    const recordId = typeof req.params.recordId === 'string' ? req.params.recordId.trim() : ''
    const sheetIdParam = typeof req.query.sheetId === 'string' ? req.query.sheetId.trim() : undefined
    const viewIdParam = typeof req.query.viewId === 'string' ? req.query.viewId.trim() : undefined
    if (!recordId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'recordId is required' } })
    }

    try {
      const pool = poolManager.get()
      let sheetId = sheetIdParam
      let viewConfig: UniverMetaViewConfig | null = null
      if (sheetIdParam || viewIdParam) {
        const resolved = await resolveMetaSheetId(pool as unknown as { query: QueryFn }, {
          sheetId: sheetIdParam,
          viewId: viewIdParam,
        })
        sheetId = resolved.sheetId
        viewConfig = resolved.view
      }

      const recordRes = sheetId
        ? await pool.query(
          'SELECT id, sheet_id, version, data, created_by, locked, locked_by, locked_at FROM meta_records WHERE id = $1 AND sheet_id = $2',
          [recordId, sheetId],
        )
        : await pool.query(
          'SELECT id, sheet_id, version, data, created_by, locked, locked_by, locked_at FROM meta_records WHERE id = $1',
          [recordId],
        )
      const row: any = recordRes.rows[0]
      if (!row) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Record not found: ${recordId}` } })
      }

      sheetId = String(row.sheet_id)
      const readable = await requireRecordReadable(req, pool.query.bind(pool), sheetId, recordId)
      if ('status' in readable) return res.status(readable.status).json(readable.body)
      const { access, capabilities, capabilityOrigin, sheetScope } = readable
      const sheet = await loadSheetRow(pool.query.bind(pool), sheetId)
      if (!sheet) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }

      const fields = await loadFieldsForSheet(pool.query.bind(pool), sheetId)
      const record: UniverMetaRecord = {
        id: String(row.id),
        version: Number(row.version ?? 1),
        data: normalizeJson(row.data),
        createdBy: typeof row.created_by === 'string' ? row.created_by : null,
        ...mapRecordLockState(row),
      }

      const relationalLinkFields = fields
        .map((field) => (field.type === 'link' ? { fieldId: field.id, cfg: parseLinkFieldConfig(field.property) } : null))
        .filter((value): value is RelationalLinkField => !!value && !!value.cfg)
      const linkValuesByRecord = await loadLinkValuesByRecord(pool.query.bind(pool), [record.id], relationalLinkFields)
      for (const { fieldId } of relationalLinkFields) {
        record.data[fieldId] = linkValuesByRecord.get(record.id)?.get(fieldId) ?? []
      }
      // B3 review nit: blank a mirror field's raw reverse ids for an actor who can't read the mirror's
      // foreign sheet (parity with the buildLinkSummaries gate below). Forward links untouched.
      await maskDerivedMirrorFieldIds(req, pool.query.bind(pool), [record], relationalLinkFields)
      await applyLookupRollup(req, pool.query.bind(pool), sheetId, fields, [record], relationalLinkFields, linkValuesByRecord)
      const visiblePropertyFields = filterVisiblePropertyFields(fields)
      // #2015 read-path field mask: D3c security composite (layer-2 property.hidden ∧ layer-3
      // field_permissions.visible), mirroring export-xlsx / dry-run #5c-a. hiddenFieldIds:[] keeps layer-1
      // (view.hidden_field_ids) a display-only concern in the returned fieldPermissions metadata, not a
      // data drop. access.userId is guaranteed truthy here (401 at :7399); loaded ONCE and reused for the
      // metadata derive below.
      const fieldScopeMap = access.userId
        ? await loadFieldPermissionScopeMap(pool.query.bind(pool), sheetId, access.userId)
        : new Map()
      const securityFieldPermissions = deriveFieldPermissions(visiblePropertyFields, capabilities, { hiddenFieldIds: [], fieldScopeMap })
      // §2a.3 read/JSON taint mask via the single CHOKEPOINT (maskStoredRecordFieldIds): the
      // MATERIALIZED formula column is read straight from meta_records.data, so a formula over a denied
      // foreign lookup would leak. The chokepoint drops tainted formula fields before the data-mask
      // below (parity with GET /view).
      const allowedFieldIds = await maskStoredRecordFieldIds(
        req,
        pool.query.bind(pool),
        sheetId,
        visiblePropertyFields,
        new Set(visiblePropertyFields.filter((field) => securityFieldPermissions[field.id]?.visible !== false).map((field) => field.id)),
      )
      record.data = filterRecordDataByFieldIds(record.data, allowedFieldIds)
      const linkSummaries = filterSingleRecordFieldSummaryMap(
        Object.fromEntries(
          Array.from((await buildLinkSummaries(req, pool.query.bind(pool), sheetId, [record], relationalLinkFields, linkValuesByRecord)).get(record.id)?.entries() ?? []),
        ),
        allowedFieldIds,
      )
      const attachmentSummaries = visiblePropertyFields.some((field) => field.type === 'attachment')
        ? filterSingleRecordFieldSummaryMap(
            serializeAttachmentSummaryMap(
              await buildAttachmentSummaries(
                pool.query.bind(pool),
                req,
                sheetId,
                [record],
                visiblePropertyFields.filter((field) => field.type === 'attachment'),
              ),
            )[record.id] ?? {},
            allowedFieldIds,
          )
        : undefined
      // Native person (人员) display for the single-record drawer/form — same users-table join as the
      // grid view, masked through the SAME single-record layer-2∧3 composite as linkSummaries.
      const personFieldsSingle = visiblePropertyFields.filter((field) => field.type === 'person')
      const personSummaries = personFieldsSingle.length > 0
        ? filterSingleRecordFieldSummaryMap(
            serializePersonSummaryMap(
              await buildPersonSummaries(pool.query.bind(pool), [record], personFieldsSingle),
            )[record.id] ?? {},
            allowedFieldIds,
          )
        : undefined

      const viewScopeMap = (access.userId && viewConfig) ? await loadViewPermissionScopeMap(pool.query.bind(pool), [viewConfig.id], access.userId) : new Map()
      const fieldPermissions = deriveFieldPermissions(fields, capabilities, {
        hiddenFieldIds: viewConfig?.hiddenFieldIds ?? [],
        fieldScopeMap,
      })
      const viewPermissions = viewConfig ? deriveViewPermissions([viewConfig], capabilities, viewScopeMap) : {}
      const rowActions = deriveRecordRowActions(capabilities, sheetScope, access, record.createdBy)
      // Per-row unlock gate (decision b) for the drawer's lock/unlock action. `created_by` is already
      // resolved on `record` here, so no extra read is needed. Only meaningful while locked.
      if (record.locked) {
        record.canUnlock = canUnlock(
          access.userId ?? null,
          { lockedBy: record.lockedBy ?? null, createdBy: record.createdBy ?? null },
          capabilities,
        )
      }

      return res.json({
        ok: true,
        data: {
          sheet,
          ...(viewConfig ? { view: redactViewConfigFilterLiterals(viewConfig, allowedFieldIds) } : {}),
          fields: visiblePropertyFields,
          record,
          capabilities,
          capabilityOrigin,
          fieldPermissions,
          ...(viewConfig ? { viewPermissions } : {}),
          rowActions,
          commentsScope: {
            targetType: 'meta_record',
            targetId: record.id,
            baseId: sheet.baseId ?? null,
            sheetId: sheet.id,
            viewId: viewConfig?.id ?? null,
            recordId: record.id,
            containerType: 'meta_sheet',
            containerId: sheet.id,
          },
          linkSummaries,
          ...(personSummaries ? { personSummaries } : {}),
          ...(attachmentSummaries ? { attachmentSummaries } : {}),
        },
      })
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: err.message } })
      }
      if (err instanceof ConflictError) {
        return res.status(409).json({ ok: false, error: { code: 'CONFLICT', message: err.message } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] record context failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load record context' } })
    }
  })

  /**
   * GET /records-summary - Lightweight record summaries for Link selector
   *
   * Query params:
   *   - sheetId (required): target sheet to query
   *   - displayFieldId (optional): field ID to use for display value; if not provided, first string field is used
   *   - search (optional): case-insensitive substring filter on display value
   *   - limit (optional): max records to return (default 50, max 200)
   *   - offset (optional): pagination offset (default 0)
   *
   * Returns: { ok: true, data: { records: [{id, display}], page: {offset, limit, total, hasMore} } }
   */
  router.get('/records-summary', async (req: Request, res: Response) => {
    const sheetId = typeof req.query.sheetId === 'string' ? req.query.sheetId.trim() : ''
    const displayFieldId = typeof req.query.displayFieldId === 'string' ? req.query.displayFieldId.trim() : null
    const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : ''
    const limitParam = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 50
    const offsetParam = typeof req.query.offset === 'string' ? Number.parseInt(req.query.offset, 10) : 0
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 50
    const offset = Number.isFinite(offsetParam) ? Math.max(offsetParam, 0) : 0

    if (!sheetId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId is required' } })
    }

    try {
      const pool = poolManager.get()

      // Verify sheet exists
      const sheetRes = await pool.query('SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL', [sheetId])
      if (sheetRes.rows.length === 0) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      const { access, capabilities } = await resolveSheetReadableCapabilities(req, pool.query.bind(pool), sheetId)
      if (!access.userId) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      if (!capabilities.canRead) return sendForbidden(res)

      const baseAllowedFieldIds = await loadAllowedFieldIds(pool.query.bind(pool), sheetId, access.userId, capabilities)
      // §2a.3 DISPLAY-PROJECTION chokepoint (resolveDisplayFieldTaint) — C2: /records-summary projects
      // ONE caller-chosen `displayFieldId` over stored data and string-coerces it. A formula over a
      // denied foreign lookup is itself source-visible, so it passes the source-sheet `allowedFieldIds`
      // gate; an attacker could set `displayFieldId=<that formula>` and read its materialized value as
      // the summary string. Drop tainted formula ids from the allowed set: an explicit tainted
      // `displayFieldId` then fails the validation below (same 400), and the auto-pick `selectableFields`
      // inside loadRecordSummaries excludes it too.
      const summaryFields = await loadFieldsForSheetShared(pool.query.bind(pool), sheetId)
      const { allowedDisplayFieldIds: allowedFieldIds } = await resolveDisplayFieldTaint(
        req,
        pool.query.bind(pool),
        sheetId,
        summaryFields,
        baseAllowedFieldIds,
        displayFieldId,
      )
      if (displayFieldId && !allowedFieldIds.has(displayFieldId)) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid displayFieldId' } })
      }

      const summary = await loadRecordSummaries(pool.query.bind(pool), sheetId, {
        displayFieldId,
        allowedFieldIds,
        search,
        limit,
        offset,
      })

      return res.json({
        ok: true,
        data: {
          records: summary.records,
          displayMap: summary.displayMap,
          page: summary.page,
        },
      })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] records-summary failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load records summary' } })
    }
  })

  router.get('/fields/:fieldId/link-options', async (req: Request, res: Response) => {
    const fieldId = typeof req.params.fieldId === 'string' ? req.params.fieldId.trim() : ''
    const recordId = typeof req.query.recordId === 'string' ? req.query.recordId.trim() : undefined
    const search = typeof req.query.search === 'string' ? req.query.search.trim().toLowerCase() : ''
    const limitParam = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 20
    const offsetParam = typeof req.query.offset === 'string' ? Number.parseInt(req.query.offset, 10) : 0
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 20
    const offset = Number.isFinite(offsetParam) ? Math.max(offsetParam, 0) : 0

    if (!fieldId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'fieldId is required' } })
    }

    try {
      const pool = poolManager.get()
      const fieldRes = await pool.query(
        'SELECT id, sheet_id, name, type, property FROM meta_fields WHERE id = $1',
        [fieldId],
      )
      const fieldRow: any = fieldRes.rows[0]
      if (!fieldRow) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Field not found: ${fieldId}` } })
      }
      const field = serializeFieldRow(fieldRow)
      if (field.type !== 'link') {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: `Field is not a link field: ${fieldId}` } })
      }
      const { access: sourceAccess, capabilities: sourceCapabilities } = await resolveSheetReadableCapabilities(
        req,
        pool.query.bind(pool),
        String(fieldRow.sheet_id),
      )
      if (!sourceAccess.userId) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      if (!sourceCapabilities.canRead) return sendForbidden(res)

      const linkConfig = parseLinkFieldConfig(field.property)
      if (!linkConfig) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: `Link field is missing foreignSheetId: ${fieldId}` } })
      }

      const targetSheet = await loadSheetRow(pool.query.bind(pool), linkConfig.foreignSheetId)
      if (!targetSheet) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Target sheet not found: ${linkConfig.foreignSheetId}` } })
      }
      const { access: foreignAccess, capabilities } = await resolveSheetReadableCapabilities(req, pool.query.bind(pool), linkConfig.foreignSheetId)
      if (!capabilities.canRead) return sendForbidden(res)

      // ②b §3.2 Sink B-2 / decision (d) — the EXPLICIT cross-base candidate pull. Unlike the inline
      // summary sinks (silent mask), this endpoint deliberately enumerates the foreign sheet's records,
      // so a sheet-readable-but-base-unreadable actor would leak them. For a CROSS-BASE foreign sheet
      // (source base ≠ foreign base) require base-read; failure → 403 (explicit, matching the existing
      // sendForbidden semantics). Placed BEFORE the `selected` summaries and the candidate pull so it
      // short-circuits both. Same-base is untouched (200 as before); a null foreign base is unreadable.
      const sourceSheetRow = await loadSheetRow(pool.query.bind(pool), String(fieldRow.sheet_id))
      const sourceBaseId = sourceSheetRow?.baseId ?? null
      const foreignBaseId = targetSheet.baseId ?? null
      if (baseIdsAreCrossBase(sourceBaseId, foreignBaseId)) {
        const baseReadable = foreignBaseId != null && (await resolveBaseReadable(req, pool.query.bind(pool), foreignBaseId))
        if (!baseReadable) return sendForbidden(res)
      }

      let selected: LinkedRecordSummary[] = []
      if (recordId) {
        const sourceRecordRes = await pool.query(
          'SELECT id FROM meta_records WHERE id = $1 AND sheet_id = $2',
          [recordId, String(fieldRow.sheet_id)],
        )
        if (sourceRecordRes.rows.length === 0) {
          return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Record not found: ${recordId}` } })
        }

        const linkValuesByRecord = await loadLinkValuesByRecord(
          pool.query.bind(pool),
          [recordId],
          [{ fieldId, cfg: linkConfig }],
        )
        const linkSummaries = await buildLinkSummaries(
          req,
          pool.query.bind(pool),
          String(fieldRow.sheet_id),
          [{ id: recordId, version: 0, data: {} }],
          [{ fieldId, cfg: linkConfig }],
          linkValuesByRecord,
        )
        selected = linkSummaries.get(recordId)?.get(fieldId) ?? []
      }

      // F5 (#2106 §3 F5): gate the FOREIGN sheet's default display field by ITS OWN layer-2 ∧ layer-3 allowed
      // set (keyed to the foreign sheet, not the caller's) so a field_permissions-denied display value never
      // leaks via the summary `display`.
      // §2a.3 DISPLAY-PROJECTION chokepoint (resolveDisplayFieldTaint) — C2 (auto-pick path): the
      // link-picker auto-picks the foreign sheet's display field over stored data. A foreign formula
      // over a (further) denied lookup is source-visible on the foreign sheet, so it could be auto-picked
      // and leak its materialized value as the picker display. Drop tainted foreign formula ids from the
      // foreign allowed set so they are never selectable. No explicit displayFieldId here (auto-pick only).
      const foreignBaseAllowedFieldIds = await loadAllowedFieldIds(pool.query.bind(pool), linkConfig.foreignSheetId, foreignAccess.userId, capabilities)
      const foreignFields = await loadFieldsForSheetShared(pool.query.bind(pool), linkConfig.foreignSheetId)
      const { allowedDisplayFieldIds: foreignAllowedFieldIds } = await resolveDisplayFieldTaint(
        req,
        pool.query.bind(pool),
        linkConfig.foreignSheetId,
        foreignFields,
        foreignBaseAllowedFieldIds,
        null,
      )
      const summary = await loadRecordSummaries(pool.query.bind(pool), linkConfig.foreignSheetId, {
        search,
        limit,
        offset,
        allowedFieldIds: foreignAllowedFieldIds,
      })

      return res.json({
        ok: true,
        data: {
          field: {
            id: field.id,
            name: field.name,
            type: field.type,
          },
          targetSheet,
          selected,
          records: summary.records,
          page: summary.page,
        },
      })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] link-options failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load link options' } })
    }
  })

  router.post('/attachments', async (req: Request, res: Response) => {
    try {
      if (!multitableUpload) {
        return res.status(500).json({ ok: false, error: { code: 'UPLOAD_UNAVAILABLE', message: 'Attachment upload not available - multer not installed' } })
      }

      multitableUpload.single('file')(req, res, async (uploadErr: unknown) => {
        if (uploadErr) {
          return res.status(400).json({ ok: false, error: { code: 'UPLOAD_FAILED', message: String(uploadErr) } })
        }

        const multerReq = req as RequestWithFile
        const file = multerReq.file
        if (!file) {
          return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'No file provided. Use "file" as the form field name.' } })
        }

        const sheetId = typeof req.body.sheetId === 'string' ? req.body.sheetId.trim() : ''
        const recordId = typeof req.body.recordId === 'string' && req.body.recordId.trim().length > 0 ? req.body.recordId.trim() : null
        const fieldId = typeof req.body.fieldId === 'string' && req.body.fieldId.trim().length > 0 ? req.body.fieldId.trim() : null
        if (!sheetId) {
          return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId is required' } })
        }

        const pool = poolManager.get()
        try {
          const sheetRes = await pool.query(
            'SELECT id FROM meta_sheets WHERE id = $1 AND deleted_at IS NULL',
            [sheetId],
          )
          if (sheetRes.rows.length === 0) {
            return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
          }
          const { access, capabilities, sheetScope } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
          if (!capabilities.canEditRecord) return sendForbidden(res)

          if (fieldId) {
            const fieldRes = await pool.query(
              'SELECT id, type FROM meta_fields WHERE id = $1 AND sheet_id = $2',
              [fieldId, sheetId],
            )
            const fieldRow: any = fieldRes.rows[0]
            if (!fieldRow) {
              return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Field not found: ${fieldId}` } })
            }
            if (mapFieldType(String(fieldRow.type ?? 'string')) !== 'attachment') {
              return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: `Field is not an attachment field: ${fieldId}` } })
            }
          }

          if (recordId) {
            const recordRes = await pool.query(
              'SELECT id, created_by FROM meta_records WHERE id = $1 AND sheet_id = $2',
              [recordId, sheetId],
            )
            const recordRow: any = recordRes.rows[0]
            if (!recordRow) {
              return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Record not found: ${recordId}` } })
            }
            if (!ensureRecordWriteAllowed(capabilities, sheetScope, access, typeof recordRow?.created_by === 'string' ? recordRow.created_by : null, 'edit')) {
              return sendForbidden(res, 'Record editing is not allowed for this row')
            }
          }

          const storage = getAttachmentStorageService()
          const userIdRaw = req.user?.sub || req.user?.userId || req.user?.id || 'anonymous'
          const userId = typeof userIdRaw === 'number' ? String(userIdRaw) : userIdRaw
          const { row: attachmentRow } = await storeAttachmentShared({
            query: pool.query.bind(pool),
            storage,
            sheetId,
            recordId,
            fieldId,
            file,
            uploaderId: userId,
            idGenerator: () => buildId('att').slice(0, 50),
          })
          return res.status(201).json({
            ok: true,
            data: {
              attachment: serializeAttachmentRow(req, attachmentRow),
            },
          })
        } catch (err) {
          if (err instanceof ValidationError) {
            return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: err.message } })
          }
          if (err instanceof NotFoundError) {
            return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: err.message } })
          }
          const hint = getDbNotReadyMessage(err)
          if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
          console.error('[univer-meta] attachment upload failed:', err)
          return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to upload attachment' } })
        }
      })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] attachment middleware failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to upload attachment' } })
    }
  })

  router.get('/attachments/:attachmentId', async (req: Request, res: Response) => {
    const attachmentId = typeof req.params.attachmentId === 'string' ? req.params.attachmentId.trim() : ''
    if (!attachmentId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'attachmentId is required' } })
    }

    try {
      const pool = poolManager.get()
      const metadata = await readAttachmentMetadataShared({
        query: pool.query.bind(pool),
        attachmentId,
      })
      if (!metadata) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Attachment not found: ${attachmentId}` } })
      }
      if (metadata.sheetId) {
        const { access, capabilities } = await resolveSheetReadableCapabilities(req, pool.query.bind(pool), metadata.sheetId)
        if (!access.userId) {
          return res.status(401).json({ error: 'Authentication required' })
        }
        if (!capabilities.canRead) return sendForbidden(res)
      }

      const storage = getAttachmentStorageService()
      const buffer = await readAttachmentBinaryShared({ storage, storageFileId: metadata.storageFileId })
      const mimeType = metadata.mimeType
      const fileName = metadata.filename ?? metadata.originalName ?? attachmentId
      const forceInline = req.query.thumbnail === 'true' || isImageMimeType(mimeType)

      res.setHeader('Content-Type', mimeType)
      res.setHeader('Content-Disposition', `${forceInline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(fileName)}"`)
      res.setHeader('Content-Length', buffer.length)
      return res.send(buffer)
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] attachment download failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to download attachment' } })
    }
  })

  router.delete('/attachments/:attachmentId', async (req: Request, res: Response) => {
    const attachmentId = typeof req.params.attachmentId === 'string' ? req.params.attachmentId.trim() : ''
    if (!attachmentId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'attachmentId is required' } })
    }

    try {
      const pool = poolManager.get()
      let updatedRecordRealtimeScope: {
        sheetId: string
        recordId: string
        fieldId: string
        version: number
        patch: Record<string, unknown>
      } | null = null
      const attachmentRow = await readAttachmentForDeleteShared({
        query: pool.query.bind(pool),
        attachmentId,
      })
      if (!attachmentRow) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Attachment not found: ${attachmentId}` } })
      }
      const access = await resolveRequestAccess(req)
      const sheetCapabilities = await resolveSheetCapabilities(req, pool.query.bind(pool), attachmentRow.sheetId)
      if (!sheetCapabilities.capabilities.canEditRecord) return sendForbidden(res)
      if (attachmentRow.recordId) {
        const creatorMap = await loadRecordCreatorMap(
          pool.query.bind(pool),
          attachmentRow.sheetId,
          [attachmentRow.recordId],
        )
        if (!ensureRecordWriteAllowed(
          sheetCapabilities.capabilities,
          sheetCapabilities.sheetScope,
          access,
          creatorMap.get(attachmentRow.recordId),
          'edit',
        )) return sendForbidden(res, 'Record editing is not allowed for this row')
        // Record-lock guard (rank-8 review B3; decision d/e). Removing an attachment mutates the
        // record's `data`, so it is an EDIT — blocked on a locked record for a non-locker/owner.
        const lockRes = await pool.query(
          'SELECT locked, locked_by, created_by FROM meta_records WHERE id = $1 AND sheet_id = $2',
          [attachmentRow.recordId, attachmentRow.sheetId],
        )
        const lockRow = lockRes.rows[0] as
          | { locked?: unknown; locked_by?: unknown; created_by?: unknown }
          | undefined
        if (lockRow) {
          try {
            ensureRecordNotLocked(getRequestActorId(req), lockRow, () => new RecordLockedError())
          } catch (lockErr) {
            if (lockErr instanceof RecordLockedError) return sendForbidden(res, lockErr.message)
            throw lockErr
          }
        }
      } else if (!ensureRecordWriteAllowed(
        sheetCapabilities.capabilities,
        sheetCapabilities.sheetScope,
        access,
        attachmentRow.createdBy,
        'edit',
      )) {
        return sendForbidden(res, 'Attachment deletion is not allowed for this draft attachment')
      }

      await pool.transaction(async ({ query }) => {
        const recordId = attachmentRow.recordId
        const fieldId = attachmentRow.fieldId
        const sheetId = attachmentRow.sheetId

        if (recordId && fieldId) {
          const recordRes = await query(
            'SELECT id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE',
            [recordId, sheetId],
          )
          const recordRow: any = recordRes.rows[0]
          if (recordRow) {
            const data = normalizeJson(recordRow.data)
            const currentIds = normalizeAttachmentIds(data[fieldId])
            const nextIds = currentIds.filter((id) => id !== attachmentId)
            if (nextIds.length !== currentIds.length) {
              // lock-guarded: attachment-delete record edit (B3) — ensureRecordNotLocked enforced before this txn.
              const updateRes = await query(
                `UPDATE meta_records
                 SET data = data || $1::jsonb, updated_at = now(), version = version + 1, modified_by = $4
                 WHERE id = $2 AND sheet_id = $3
                 RETURNING version`,
                [JSON.stringify({ [fieldId]: nextIds }), recordId, sheetId, getRequestActorId(req)],
              )
              updatedRecordRealtimeScope = {
                sheetId,
                recordId,
                fieldId,
                version: Number((updateRes.rows[0] as any)?.version ?? Number(recordRow?.version ?? 0) + 1),
                patch: { [fieldId]: nextIds },
              }
            }
          }
        }

        await softDeleteAttachmentRowShared({ query, attachmentId })
      })

      const storage = getAttachmentStorageService()
      await deleteAttachmentBinaryShared({ storage, storageFileId: attachmentRow.storageFileId })

      if (updatedRecordRealtimeScope) {
        publishMultitableSheetRealtime({
          spreadsheetId: updatedRecordRealtimeScope.sheetId,
          actorId: getRequestActorId(req),
          source: 'multitable',
          kind: 'attachment-updated',
          recordId: updatedRecordRealtimeScope.recordId,
          recordIds: [updatedRecordRealtimeScope.recordId],
          fieldIds: [updatedRecordRealtimeScope.fieldId],
          recordPatches: [{
            recordId: updatedRecordRealtimeScope.recordId,
            version: updatedRecordRealtimeScope.version,
            patch: updatedRecordRealtimeScope.patch,
          }],
        })
      }

      return res.json({ ok: true, data: { deleted: attachmentId } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] attachment delete failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete attachment' } })
    }
  })

  router.post('/records', async (req: Request, res: Response) => {
    const schema = z.object({
      viewId: z.string().min(1).optional(),
      sheetId: z.string().min(1).optional(),
      data: z.record(z.unknown()).optional(),
    })

    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    const data = parsed.data.data ?? {}

    try {
      const pool = poolManager.get()
      const resolved = await resolveMetaSheetId(pool as unknown as { query: QueryFn }, {
        sheetId: parsed.data.sheetId,
        viewId: parsed.data.viewId,
      })
      const sheetId = resolved.sheetId

      const { access, capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!access.userId) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      const recordService = new RecordService(pool, eventBus)
      // A-min-create (#2255): compute the new record's same-record formula-over-lookup on create.
      recordService.setFormulaRecalcHook((q, sid, ids) => recalcNewRecordFormulas(req, q, sid, ids))
      const result = await recordService.createRecord({
        sheetId,
        capabilities,
        actorId: getRequestActorId(req),
        data,
      })

      // F4 (#2106 §3 F4): the create echo previously returned result.data UNMASKED, so a field_permissions-
      // denied value — whether the creator wrote it (the create write gate is layer-2 only) or the server
      // assigned it (e.g. an auto-number) — was handed back. Apply the layer-2 ∧ layer-3 read mask (the #2028
      // composite); the create write itself is unchanged. access.userId is guaranteed truthy past the 401 above.
      const fields = await loadSheetFields(pool as unknown as { query: QueryFn }, sheetId)
      const visiblePropertyFields = filterVisiblePropertyFields(fields)
      const fieldScopeMap = await loadFieldPermissionScopeMap(pool.query.bind(pool), sheetId, access.userId)
      const securityFieldPermissions = deriveFieldPermissions(visiblePropertyFields, capabilities, { hiddenFieldIds: [], fieldScopeMap })
      // §2a.3 read/JSON taint mask via the single CHOKEPOINT (maskStoredRecordFieldIds): the create
      // recompute (recalcNewRecordFormulas) already taint-skips, so a tainted formula is absent from
      // result.data and would filter out by absence — but routing the echo's allowed set through the
      // chokepoint makes that structural (defense-in-depth) rather than safe-by-accident, identical to
      // every other stored-data read sink.
      const allowedFieldIds = await maskStoredRecordFieldIds(
        req,
        pool.query.bind(pool),
        sheetId,
        visiblePropertyFields,
        new Set(visiblePropertyFields.filter((field) => securityFieldPermissions[field.id]?.visible !== false).map((field) => field.id)),
      )

      return res.json({
        ok: true,
        data: {
          record: {
            id: result.recordId,
            version: result.version,
            data: filterRecordDataByFieldIds(result.data, allowedFieldIds),
          },
        },
      })
    } catch (err) {
      if (isRecordCreateValidationError(err)) {
        const fieldErrors = normalizeRecordCreateFieldErrors(err.fieldErrors)
        return res.status(422).json({
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Record validation failed',
            fieldErrors,
          },
        })
      }
      if (err instanceof RecordServiceFieldForbiddenError) {
        return res.status(403).json({ ok: false, error: { code: err.code, message: err.message } })
      }
      if (err instanceof RecordServiceValidationError || err instanceof ServiceValidationError) {
        return res.status(400).json({ ok: false, error: { code: err.code || 'VALIDATION_ERROR', message: err.message } })
      }
      if (err instanceof ValidationError) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: err.message } })
      }
      if (err instanceof RecordServiceNotFoundError || err instanceof ServiceNotFoundError) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: err.message } })
      }
      if (err instanceof RecordServicePermissionError) {
        return sendForbidden(res, err.message)
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] create record failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create meta record' } })
    }
  })

  router.delete('/records/:recordId', async (req: Request, res: Response) => {
    const recordId = typeof req.params.recordId === 'string' ? req.params.recordId : ''
    if (!recordId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'recordId is required' } })
    }

    const expectedRaw = typeof req.query.expectedVersion === 'string' ? Number.parseInt(req.query.expectedVersion, 10) : Number.NaN
    const expectedVersion = Number.isFinite(expectedRaw) ? expectedRaw : undefined

    try {
      const pool = poolManager.get()
      const access = await resolveRequestAccess(req)
      if (!access.userId) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      const recordService = new RecordService(pool, eventBus)
      await recordService.deleteRecord({
        recordId,
        actorId: getRequestActorId(req),
        expectedVersion,
        access,
        resolveSheetAccess: async (sheetId) => {
          const { capabilities, sheetScope } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
          return { capabilities, ...(sheetScope ? { sheetScope } : {}) }
        },
      })

      return res.json({ ok: true, data: { deleted: recordId } })
    } catch (err) {
      if (err instanceof RecordServicePermissionError) {
        return sendForbidden(res, err.message)
      }
      if (err instanceof RecordServiceNotFoundError || err instanceof ServiceNotFoundError) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: err.message } })
      }
      if (err instanceof RecordServiceVersionConflictError || err instanceof ServiceVersionConflictError) {
        return res.status(409).json({
          ok: false,
          error: {
            code: 'VERSION_CONFLICT',
            message: err.message,
            serverVersion: err.serverVersion,
          },
        })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] delete record failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete record' } })
    }
  })

  // Manual record lock / unlock (design #2278 follow-up). `{ locked: true }` LOCKS, `{ locked: false }`
  // UNLOCKS. Locking requires edit rights on the row (you may protect a row you can edit). Unlocking
  // requires `canUnlock` (decision b: locker ∨ owner ∨ sheet-admin) — decision e's explicit unlock gate.
  router.post('/records/:recordId/lock', async (req: Request, res: Response) => {
    const recordId = typeof req.params.recordId === 'string' ? req.params.recordId.trim() : ''
    if (!recordId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'recordId is required' } })
    }
    const schema = z.object({
      locked: z.boolean(),
      sheetId: z.string().min(1).optional(),
      viewId: z.string().min(1).optional(),
    })
    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const pool = poolManager.get()
      let sheetId = parsed.data.sheetId
      if (parsed.data.sheetId || parsed.data.viewId) {
        const resolved = await resolveMetaSheetId(pool as unknown as { query: QueryFn }, {
          sheetId: parsed.data.sheetId,
          viewId: parsed.data.viewId,
        })
        sheetId = resolved.sheetId
      }

      const lookup = sheetId
        ? await pool.query('SELECT id, sheet_id, created_by, locked, locked_by FROM meta_records WHERE id = $1 AND sheet_id = $2', [recordId, sheetId])
        : await pool.query('SELECT id, sheet_id, created_by, locked, locked_by FROM meta_records WHERE id = $1', [recordId])
      const recordRow: any = lookup.rows[0]
      if (!recordRow) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Record not found: ${recordId}` } })
      }
      sheetId = String(recordRow.sheet_id)
      const createdBy = typeof recordRow.created_by === 'string' ? recordRow.created_by : null

      const { access, capabilities, sheetScope } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!access.userId) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      const actorId = getRequestActorId(req)

      if (parsed.data.locked) {
        // LOCK: must be allowed to edit this row.
        if (!capabilities.canEditRecord || !ensureRecordWriteAllowed(capabilities, sheetScope, access, createdBy, 'edit')) {
          return sendForbidden(res, 'Record editing is not allowed for this row')
        }
        const lockedBy = actorId ?? access.userId
        // lock-mgmt: LOCK action — sets the lock columns (own canEditRecord authority above).
        await pool.query(
          `UPDATE meta_records SET locked = true, locked_by = $2, locked_at = NOW(), version = version + 1, updated_at = NOW()
           WHERE id = $1 AND sheet_id = $3`,
          [recordId, lockedBy, sheetId],
        )
      } else {
        // UNLOCK: must pass canUnlock (locker ∨ owner ∨ sheet-admin).
        if (!canUnlock(actorId ?? access.userId ?? null, {
          lockedBy: typeof recordRow.locked_by === 'string' ? recordRow.locked_by : null,
          createdBy,
        }, capabilities)) {
          return sendForbidden(res, 'Not allowed to unlock this record')
        }
        // lock-mgmt: UNLOCK action — clears the lock columns (own canUnlock authority above).
        await pool.query(
          `UPDATE meta_records SET locked = false, locked_by = NULL, locked_at = NULL, version = version + 1, updated_at = NOW()
           WHERE id = $1 AND sheet_id = $2`,
          [recordId, sheetId],
        )
      }

      const after = await pool.query('SELECT locked, locked_by, locked_at FROM meta_records WHERE id = $1', [recordId])
      publishMultitableSheetRealtime({
        spreadsheetId: sheetId,
        actorId,
        source: 'multitable',
        kind: 'record-updated',
        recordIds: [recordId],
        fieldIds: [],
      })
      return res.json({ ok: true, data: { recordId, ...mapRecordLockState(after.rows[0] as any) } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] lock record failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update record lock state' } })
    }
  })

  router.post('/patch', async (req: Request, res: Response) => {
    const schema = z.object({
      viewId: z.string().min(1).optional(),
      sheetId: z.string().min(1).optional(),
      partialSuccess: z.boolean().optional(),
      changes: z.array(z.object({
        recordId: z.string().min(1),
        fieldId: z.string().min(1),
        value: z.unknown(),
        expectedVersion: z.number().int().nonnegative().optional(),
      })).min(1),
    })

    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    try {
      const pool = poolManager.get()
      const resolved = await resolveMetaSheetId(pool as unknown as { query: QueryFn }, {
        sheetId: parsed.data.sheetId,
        viewId: parsed.data.viewId,
      })
      const sheetId = resolved.sheetId
      const { access, capabilities, sheetScope } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!access.userId) {
        return res.status(401).json({ error: 'Authentication required' })
      }
      if (!capabilities.canEditRecord) return sendForbidden(res)

      // F3 (#2106 §3 F3) echo-mask composition + write-gate guard map — extracted to
      // `buildRecordPatchContext` (single source of truth shared with the A2 AI shortcut
      // run route; see the factory's doc comment). crossSheetRelated stays masked per
      // related sheet inside computeDependentLookupRollupRecords (locked by the
      // multitable-cross-sheet-related-echo-mask suite).
      const patchContext = await buildRecordPatchContext(req, pool.query.bind(pool), sheetId, access, capabilities)
      if (!patchContext) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Sheet not found: ${sheetId}` } })
      }
      const { fields, readableEchoFields, readableEchoFieldIds, attachmentFields, fieldById } = patchContext

      const changesByRecord = new Map<string, typeof parsed.data.changes>()
      for (const change of parsed.data.changes) {
        const list = changesByRecord.get(change.recordId)
        if (list) list.push(change)
        else changesByRecord.set(change.recordId, [change])
      }

      // --------------- Delegate to RecordWriteService (validation + pipeline) ---------------
      const writeHelpers: RecordWriteHelpers = createRecordWriteHelpers(req, pool)
      const recordWriteService = new RecordWriteService(pool, eventBus, writeHelpers)
      if (yjsInvalidator) {
        recordWriteService.setPostCommitHooks([createYjsInvalidationPostCommitHook(yjsInvalidator)])
      }

      if (parsed.data.partialSuccess === true) {
        const updated: Array<{ recordId: string; version: number }> = []
        const records: Array<{ recordId: string; data: Record<string, unknown> }> = []
        const relatedRecords: Array<{ sheetId: string; recordId: string; data: Record<string, unknown> }> = []
        const failures: PatchFailurePayload[] = []
        let linkSummaries: Record<string, unknown> | undefined
        let attachmentSummaries: Record<string, unknown> | undefined

        for (const [recordId, recordChanges] of changesByRecord.entries()) {
          try {
            const result = await recordWriteService.patchRecords({
              sheetId,
              changesByRecord: new Map([[recordId, recordChanges]]) as Map<string, Array<{ fieldId: string; value: unknown; expectedVersion?: number }>>,
              actorId: getRequestActorId(req),
              fields,
              visiblePropertyFields: readableEchoFields,
              visiblePropertyFieldIds: readableEchoFieldIds,
              attachmentFields,
              fieldById,
              capabilities,
              sheetScope,
              access,
            })
            updated.push(...result.updated)
            if (result.records) records.push(...(result.records as Array<{ recordId: string; data: Record<string, unknown> }>))
            if (result.relatedRecords) relatedRecords.push(...(result.relatedRecords as Array<{ sheetId: string; recordId: string; data: Record<string, unknown> }>))
            if (result.linkSummaries) {
              linkSummaries = { ...(linkSummaries ?? {}), ...(result.linkSummaries as Record<string, unknown>) }
            }
            if (result.attachmentSummaries) {
              attachmentSummaries = { ...(attachmentSummaries ?? {}), ...(result.attachmentSummaries as Record<string, unknown>) }
            }
          } catch (err) {
            const failure = serializePatchFailure(recordId, err)
            if (!failure) throw err
            failures.push(failure)
          }
        }

        return res.json({
          ok: true,
          data: {
            updated,
            failed: failures,
            ...(records.length > 0 ? { records } : {}),
            ...(linkSummaries ? { linkSummaries } : {}),
            ...(attachmentSummaries ? { attachmentSummaries } : {}),
            ...(relatedRecords.length > 0 ? { relatedRecords } : {}),
          },
        })
      }

      const result = await recordWriteService.patchRecords({
        sheetId,
        changesByRecord: changesByRecord as Map<string, Array<{ fieldId: string; value: unknown; expectedVersion?: number }>>,
        actorId: getRequestActorId(req),
        fields,
        visiblePropertyFields: readableEchoFields,
        visiblePropertyFieldIds: readableEchoFieldIds,
        attachmentFields,
        fieldById,
        capabilities,
        sheetScope,
        access,
      })

      return res.json({
        ok: true,
        data: {
          updated: result.updated,
          ...(result.records ? { records: result.records } : {}),
          ...(result.linkSummaries ? { linkSummaries: result.linkSummaries } : {}),
          ...(result.attachmentSummaries ? { attachmentSummaries: result.attachmentSummaries } : {}),
          ...(result.relatedRecords ? { relatedRecords: result.relatedRecords } : {}),
        },
      })
    } catch (err) {
      if (err instanceof ConflictError) {
        return res.status(409).json({ ok: false, error: { code: 'CONFLICT', message: err.message } })
      }
      if (err instanceof VersionConflictError || err instanceof ServiceVersionConflictError) {
        return res.status(409).json({
          ok: false,
          error: {
            code: 'VERSION_CONFLICT',
            message: err.message,
            serverVersion: err.serverVersion,
          },
        })
      }
      if (err instanceof NotFoundError || err instanceof ServiceNotFoundError) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: err.message } })
      }
      if (err instanceof ServiceFieldForbiddenError) {
        return res.status(403).json({ ok: false, error: { code: err.code, message: err.message } })
      }
      if (err instanceof ValidationError || err instanceof ServiceValidationError) {
        const code = err instanceof ServiceValidationError ? (err.code || 'VALIDATION_ERROR') : 'VALIDATION_ERROR'
        return res.status(400).json({ ok: false, error: { code, message: err.message } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] patch failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to patch meta records' } })
    }
  })

  // ── Automation rule CRUD ──────────────────────────────────────────────

  router.get('/sheets/:sheetId/automations', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId : ''
    if (!sheetId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId is required' } })
    }
    try {
      const pool = poolManager.get()
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageAutomation) return sendForbidden(res)
      const automationService = getAutomationServiceInstance()
      if (!automationService) {
        return res.status(503).json({ ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'Automation service is not available' } })
      }

      const rules = await automationService.listRules(sheetId)

      return res.json({ ok: true, data: { rules: rules.map(serializeAutomationRule) } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] list automation rules failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list automation rules' } })
    }
  })

  router.post('/sheets/:sheetId/automations', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId : ''
    if (!sheetId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId is required' } })
    }
    try {
      const pool = poolManager.get()
      const access = await resolveRequestAccess(req)
      if (!access.userId) return res.status(401).json({ error: 'Authentication required' })
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageAutomation) return sendForbidden(res)
      const automationService = getAutomationServiceInstance()
      if (!automationService) {
        return res.status(503).json({ ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'Automation service is not available' } })
      }

      const parsed = parseCreateRuleInput(req.body as Record<string, unknown> | undefined, access.userId)
      const input = await preflightDingTalkAutomationCreate(pool.query.bind(pool), sheetId, parsed)
      await preflightAutomationConditionFields(pool.query.bind(pool), sheetId, input.conditions)
      const rule = await automationService.createRule(sheetId, input)

      return res.json({
        ok: true,
        data: {
          rule: serializeAutomationRule(rule),
        },
      })
    } catch (err) {
      if (err instanceof AutomationRuleValidationError) {
        return res.status(400).json({ ok: false, error: { code: err.code, message: err.message } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] create automation rule failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create automation rule' } })
    }
  })

  router.patch('/sheets/:sheetId/automations/:ruleId', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId : ''
    const ruleId = typeof req.params.ruleId === 'string' ? req.params.ruleId : ''
    if (!sheetId || !ruleId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId and ruleId are required' } })
    }
    try {
      const pool = poolManager.get()
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageAutomation) return sendForbidden(res)
      const automationService = getAutomationServiceInstance()
      if (!automationService) {
        return res.status(503).json({ ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'Automation service is not available' } })
      }

      const parsed = parseUpdateRuleInput(req.body as Record<string, unknown> | undefined)
      if (!parsed) {
        return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'No fields to update' } })
      }
      const input = await preflightDingTalkAutomationUpdate(
        pool.query.bind(pool),
        sheetId,
        ruleId,
        parsed,
        automationService,
      )
      if (!input) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Automation rule not found' } })
      }
      await preflightAutomationConditionFields(pool.query.bind(pool), sheetId, input.conditions)

      const updated = await automationService.updateRule(ruleId, sheetId, input)
      if (!updated) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Automation rule not found' } })
      }

      return res.json({ ok: true, data: { rule: serializeAutomationRule(updated) } })
    } catch (err) {
      if (err instanceof AutomationRuleValidationError) {
        return res.status(400).json({ ok: false, error: { code: err.code, message: err.message } })
      }
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] update automation rule failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update automation rule' } })
    }
  })

  router.delete('/sheets/:sheetId/automations/:ruleId', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId : ''
    const ruleId = typeof req.params.ruleId === 'string' ? req.params.ruleId : ''
    if (!sheetId || !ruleId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId and ruleId are required' } })
    }
    try {
      const pool = poolManager.get()
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageAutomation) return sendForbidden(res)
      const automationService = getAutomationServiceInstance()
      if (!automationService) {
        return res.status(503).json({ ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'Automation service is not available' } })
      }

      const deleted = await automationService.deleteRule(ruleId, sheetId)

      if (!deleted) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Automation rule not found' } })
      }

      return res.json({ ok: true, data: { deleted: ruleId } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] delete automation rule failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete automation rule' } })
    }
  })

  router.get('/sheets/:sheetId/automations/:ruleId/dingtalk-person-deliveries', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId : ''
    const ruleId = typeof req.params.ruleId === 'string' ? req.params.ruleId : ''
    if (!sheetId || !ruleId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId and ruleId are required' } })
    }
    try {
      const pool = poolManager.get()
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageAutomation) return sendForbidden(res)
      const automationService = getAutomationServiceInstance()
      if (!automationService) {
        return res.status(503).json({ ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'Automation service is not available' } })
      }

      const rule = await automationService.getRule(ruleId)
      if (!rule || rule.sheet_id !== sheetId) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Automation rule not found' } })
      }

      const limit = parseDingTalkAutomationDeliveryLimit(req.query.limit)
      const deliveries = await listAutomationDingTalkPersonDeliveries(pool.query.bind(pool), ruleId, limit)
      return res.json({ ok: true, data: { deliveries } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] list dingtalk person deliveries failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list DingTalk person deliveries' } })
    }
  })

  router.get('/sheets/:sheetId/automations/:ruleId/dingtalk-group-deliveries', async (req: Request, res: Response) => {
    const sheetId = typeof req.params.sheetId === 'string' ? req.params.sheetId : ''
    const ruleId = typeof req.params.ruleId === 'string' ? req.params.ruleId : ''
    if (!sheetId || !ruleId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'sheetId and ruleId are required' } })
    }
    try {
      const pool = poolManager.get()
      const { capabilities } = await resolveSheetCapabilities(req, pool.query.bind(pool), sheetId)
      if (!capabilities.canManageAutomation) return sendForbidden(res)
      const automationService = getAutomationServiceInstance()
      if (!automationService) {
        return res.status(503).json({ ok: false, error: { code: 'SERVICE_UNAVAILABLE', message: 'Automation service is not available' } })
      }

      const rule = await automationService.getRule(ruleId)
      if (!rule || rule.sheet_id !== sheetId) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Automation rule not found' } })
      }

      const limit = parseDingTalkAutomationDeliveryLimit(req.query.limit)
      const deliveries = await listAutomationDingTalkGroupDeliveries(pool.query.bind(pool), ruleId, limit)
      return res.json({ ok: true, data: { deliveries } })
    } catch (err) {
      const hint = getDbNotReadyMessage(err)
      if (hint) return res.status(503).json({ ok: false, error: { code: 'DB_NOT_READY', message: hint } })
      console.error('[univer-meta] list dingtalk group deliveries failed:', err)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list DingTalk group deliveries' } })
    }
  })

  return router
}
