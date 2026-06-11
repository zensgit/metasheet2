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
  loadSheetPermissionScopeMap,
  loadViewPermissionScopeMap,
  requiresOwnWriteRowPolicy,
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
import { BATCH1_FIELD_TYPES, coerceBatch1Value, normalizeMultiSelectValue, validateLongTextValue } from '../multitable/field-codecs'
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
  getRecordSubscriptionStatus,
  listRecordSubscriptionNotifications,
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
// SOP (docs/operations/multitable-h-series-observation-sop-20260519.md).
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
    | 'location'
    | 'longText'
    | 'autoNumber'
    | 'createdTime'
    | 'modifiedTime'
    | 'createdBy'
    | 'modifiedBy'
  options?: Array<{ value: string; color?: string }>
  order?: number
  property?: Record<string, unknown>
}

type UniverMetaRecord = {
  id: string
  version: number
  data: Record<string, unknown>
  createdBy?: string | null
}

type UniverMetaView = {
  id: string
  fields: UniverMetaField[]
  rows: UniverMetaRecord[]
  linkSummaries?: Record<string, Record<string, LinkedRecordSummary[]>>
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
}

type LookupFieldConfig = {
  linkFieldId: string
  targetFieldId: string
  foreignSheetId?: string
}

type RollupAggregation = 'count' | 'sum' | 'avg' | 'min' | 'max'

type RollupFieldConfig = {
  linkFieldId: string
  targetFieldId: string
  aggregation: RollupAggregation
  foreignSheetId?: string
}

function parseLinkFieldConfig(property: unknown): LinkFieldConfig | null {
  const obj = normalizeJson(property)
  const foreign = obj.foreignDatasheetId ?? obj.foreignSheetId ?? obj.datasheetId
  if (typeof foreign !== 'string' || foreign.trim().length === 0) return null

  return {
    foreignSheetId: foreign.trim(),
    limitSingleRecord: obj.limitSingleRecord === true,
  }
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
  if (normalized === 'person') return 'link'
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
  const obj = applyFieldValidationNormalisation(normalizeJson(property))
  if (type === 'select' || type === 'multiSelect') {
    const options = extractSelectOptions(obj) ?? []
    return { ...obj, options }
  }

  if (type === 'link') {
    const foreignSheetId = typeof (obj.foreignSheetId ?? obj.foreignDatasheetId ?? obj.datasheetId) === 'string'
      ? String(obj.foreignSheetId ?? obj.foreignDatasheetId ?? obj.datasheetId).trim()
      : ''
    return {
      ...obj,
      ...(foreignSheetId ? { foreignSheetId, foreignDatasheetId: foreignSheetId } : {}),
      limitSingleRecord: obj.limitSingleRecord === true,
      ...(typeof obj.refKind === 'string' && obj.refKind.trim().length > 0 ? { refKind: obj.refKind.trim() } : {}),
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

  const fieldIds = relationalLinkFields.map((l) => l.fieldId)
  const linkRes = await query(
    `SELECT field_id, record_id, foreign_record_id
     FROM meta_links
     WHERE field_id = ANY($1::text[]) AND record_id = ANY($2::text[])`,
    [fieldIds, recordIds],
  )

  for (const raw of linkRes.rows as any[]) {
    const recordId = String(raw.record_id)
    const fieldId = String(raw.field_id)
    const foreignId = String(raw.foreign_record_id)
    const recordMap = linkValuesByRecord.get(recordId) ?? new Map<string, string[]>()
    const list = recordMap.get(fieldId) ?? []
    list.push(foreignId)
    recordMap.set(fieldId, list)
    linkValuesByRecord.set(recordId, recordMap)
  }

  return linkValuesByRecord
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
  await applyLookupRollup(req, query, fields, rows, relationalLinkFields, linkValuesByRecord)

  const results: Array<{ recordId: string; data: Record<string, unknown> }> = []
  for (const row of rows) {
    const nextData = await multitableFormulaEngine.recalculateRecordFromData(query, sheetId, row.id, row.data, fields)
    if (!nextData) continue
    const formulaData: Record<string, unknown> = {}
    for (const fieldId of formulaFieldIds) {
      if (fieldId in nextData) formulaData[fieldId] = nextData[fieldId]
    }
    results.push({ recordId: row.id, data: formulaData })
  }
  return results
}

async function applyLookupRollup(
  req: Request,
  query: QueryFn,
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

  const resolveLookupValues = (record: UniverMetaRecord, cfg: LookupFieldConfig): unknown[] => {
    const foreignSheetId = cfg.foreignSheetId ?? linkConfigById.get(cfg.linkFieldId)?.foreignSheetId
    if (!foreignSheetId) return []
    if (!readableForeignSheetIds.has(foreignSheetId)) return []
    const linkIds = getLinkIds(record, cfg.linkFieldId)
    if (linkIds.length === 0) return []
    const foreignMap = foreignRecordsBySheet.get(foreignSheetId)
    if (!foreignMap) return []
    const values: unknown[] = []
    for (const id of linkIds) {
      const data = foreignMap.get(id)
      if (!data) continue
      const value = data[cfg.targetFieldId]
      if (value === null || value === undefined) continue
      values.push(value)
    }
    return values
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
      row.data[fieldId] = resolveLookupValues(row, cfg)
    }

    for (const [fieldId, cfg] of rollupConfigs.entries()) {
      if (!cfg) {
        row.data[fieldId] = null
        continue
      }
      const values = resolveLookupValues(row, cfg)
      row.data[fieldId] = aggregateRollup(values, cfg.aggregation)
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
  for (const sheetId of rowsBySheet.keys()) {
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

    await applyLookupRollup(req, query, fields, rows, relationalLinkFields, linkValuesByRecord)

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
    applyLookupRollup: (q, f, rows, rl, lv) => applyLookupRollup(req, q, f, rows, rl, lv),
    computeDependentLookupRollupRecords: (q, sourceSheetId, ids, changed) =>
      computeDependentLookupRollupRecords(req, q, sourceSheetId, ids, changed),
    recalculateFormulaFields,
    loadLinkValuesByRecord,
    buildLinkSummaries: (q, rows, rl, lv) => buildLinkSummaries(req, q, rows, rl, lv),
    buildAttachmentSummaries: (q, sid, rows, af) => buildAttachmentSummaries(q, req, sid, rows, af),
    ensureAttachmentIdsExist,
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
  const readableEchoFields = visiblePropertyFields.filter((field) => fieldPermissions[field.id]?.visible !== false)
  const readableEchoFieldIds = new Set(readableEchoFields.map((field) => field.id))
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

  const visibleFieldIds = new Set(visibleFields.map((field) => field.id))
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
    await applyLookupRollup(req, query, fields, rows, relationalLinkFields, linkValuesByRecord)
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
  sheetId: string,
  requestedType: MultitableFieldInputType | UniverMetaField['type'],
  rawProperty: unknown,
): Promise<{ type: UniverMetaField['type']; property: Record<string, unknown> }> {
  if (requestedType !== 'person') {
    return {
      type: requestedType as UniverMetaField['type'],
      property: sanitizeFieldProperty(requestedType as UniverMetaField['type'], rawProperty),
    }
  }

  const sourceSheet = await loadSheetRow(query, sheetId)
  if (!sourceSheet) throw new NotFoundError(`Sheet not found: ${sheetId}`)

  const baseId = sourceSheet.baseId ?? await ensureLegacyBase(query)
  const preset = await ensurePeopleSheetPreset(query, baseId)
  const obj = normalizeJson(rawProperty)
  const limitSingleRecord = obj.limitSingleRecord !== false

  return {
    type: 'link',
    property: sanitizeFieldProperty('link', {
      ...preset.fieldProperty,
      limitSingleRecord,
      refKind: 'user',
    }),
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
    const allowedFieldIds = await loadAllowedFieldIds(query, sheetId, access.userId, capabilities)
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
// link field. An absent parentFieldId is allowed (runtime auto/first-link fallback unchanged).
// Documented residuals (accepted): (a) PATCH /fields/:fieldId can later flip limitSingleRecord
// or the field type without view re-validation — same pre-existing class as gantt's dependency
// field, follow-up candidate; (b) provisioning ensureView/createView bypass route-layer view
// validation by design (template library ships no hierarchy views today).
async function validateHierarchyParentLinkConfig(
  query: QueryFn,
  sheetId: string,
  viewType: string,
  config: Record<string, unknown>,
): Promise<string | null> {
  if (viewType !== 'hierarchy') return null
  const parentFieldId = typeof config.parentFieldId === 'string' ? config.parentFieldId.trim() : ''
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
  if (field.type !== 'link' || (field.property ?? {}).limitSingleRecord !== true) {
    return `Hierarchy parent field must be a single-value link field: ${parentFieldId}`
  }

  return null
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

      const allowedFieldIds = await loadAllowedFieldIds(pool.query.bind(pool), sheetId, access.userId, capabilities)
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
      const peopleAllowedFieldIds = await loadAllowedFieldIds(query, peopleSheetId, access.userId, capabilities)
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

        const nextName = typeof parsed.data.name === 'string' ? parsed.data.name.trim() : String(row.name)
        const requestedType = parsed.data.type ?? mapFieldType(String(row.type))
        const { type: nextType, property: nextProperty } = await normalizeFieldWriteInput(
          query as unknown as QueryFn,
          sheetId,
          requestedType,
          typeof parsed.data.property !== 'undefined' ? parsed.data.property : row.property,
        )
        const desiredOrder = parsed.data.order

        const configError = await validateLookupRollupConfig(req, query, sheetId, nextType, nextProperty)
        if (configError) {
          throw new ValidationError(configError)
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

      const incomingConfig: Record<string, unknown> = parsed.data.config ?? {}
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
      const nextConfig = parsed.data.config ?? normalizeJson(row.config)
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
      const fields = visibleFields.filter((field) => fieldPermissions[field.id]?.visible !== false)
      const fieldIds = new Set(fields.map((field) => field.id))
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
          rows.push(fields.map((field) => serializeXlsxCell(data[field.id])))
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
            await applyLookupRollup(req, pool.query.bind(pool), referencedComputedFields, [row], relationalLinkFields, linkValuesByRecord)
          }
          // D3c field mask, sheet-scope (hiddenFieldIds: [] — display-consistency defer, see #5c design-lock §4).
          // scope.visible is the real field-read gate; a denied field is omitted → becomes missing_sample.
          const visibleFields = filterVisiblePropertyFields(fields)
          const fieldScopeMap = await loadFieldPermissionScopeMap(pool.query.bind(pool), sheetId, userId)
          const fieldPermissions = deriveFieldPermissions(visibleFields, capabilities, { hiddenFieldIds: [], fieldScopeMap })
          const allowedIds = new Set(
            visibleFields.filter((field) => fieldPermissions[field.id]?.visible !== false).map((field) => field.id),
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
      const allowedFieldIds = new Set(
        visiblePropertyFields.filter((field) => securityFieldPermissions[field.id]?.visible !== false).map((field) => field.id),
      )
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
              `SELECT id, version, data, COUNT(*) OVER()::int AS total
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
              `SELECT id, version, data
               FROM meta_records
               WHERE sheet_id = $1 AND (${predicate})
               ORDER BY created_at ASC, id ASC`,
              [sheetId, searchLike, ...searchableFieldIds],
            )

            rows = recordRes.rows.map((r: any) => ({
              id: String(r.id),
              version: Number(r.version ?? 1),
              data: normalizeJson(r.data),
            }))
          }
        }
      } else if (hasInMemoryProcessing) {
        const recordRes = await pool.query(
          'SELECT id, version, data, created_at FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC',
          [sheetId],
        )

        let all = recordRes.rows.map((r: any) => ({
          id: String(r.id),
          version: Number(r.version ?? 1),
          data: normalizeJson(r.data),
          createdAt: (r as any).created_at as unknown,
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

        const sorted = sortRules.length > 0 ? [...all].sort((a, b) => {
          for (const rule of sortRules) {
            const fieldType = fieldTypeById.get(rule.fieldId) ?? 'string'
            const cmp = compareMetaSortValue(fieldType, a.data[rule.fieldId], b.data[rule.fieldId], rule.desc)
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
        rows = paged.map((r) => ({ id: r.id, version: r.version, data: r.data }))
        if (limit) page = { offset, limit, total, hasMore: offset + rows.length < total }
      } else {
        if (limit) {
          const recordRes = await pool.query(
            `SELECT id, version, data, COUNT(*) OVER()::int AS total
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
          }))

          let total = Number((recordRes.rows[0] as any)?.total ?? 0)
          if (rows.length === 0 && offset > 0) {
            const countRes = await pool.query('SELECT COUNT(*)::int AS total FROM meta_records WHERE sheet_id = $1', [sheetId])
            total = Number((countRes.rows[0] as any)?.total ?? 0)
          }
          page = { offset, limit, total, hasMore: offset + rows.length < total }
        } else {
          const recordRes = await pool.query(
            'SELECT id, version, data FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC',
            [sheetId],
          )

          rows = recordRes.rows.map((r: any) => ({
            id: String(r.id),
            version: Number(r.version ?? 1),
            data: normalizeJson(r.data),
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
      }

      await applyLookupRollup(
        req,
        pool.query.bind(pool),
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
        ...(attachmentSummaries ? { attachmentSummaries } : {}),
        ...(viewConfig ? { view: redactViewConfigFilterLiterals(viewConfig, allowedFieldIds) } : {}),
        ...(meta ? { meta } : {}),
        ...(page ? { page } : {}),
      }
      return res.json({ ok: true, data: view })
    } catch (err) {
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
      const readableFieldIds = new Set(visibleFields.filter((field) => fieldPermissions[field.id]?.visible !== false).map((field) => field.id))
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
          // #2052 (b): redact denied-field filter literals per the REQUESTER's allowed-field set (same
          // field-permission-aware contract as the other readbacks). loadAllowedFieldIds fails CLOSED for an
          // ANONYMOUS public-form caller (no access.userId → empty set → every literal redacted); an
          // AUTHENTICATED caller keeps literals for fields they can read, redacts only the denied ones.
          ...(resolved.view ? { view: redactViewConfigFilterLiterals(resolved.view, await loadAllowedFieldIds(pool.query.bind(pool), sheetId, access.userId, capabilities)) } : {}),
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
            patch[fieldId] = validateLongTextValue(value, fieldId)
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
            'SELECT id, version, created_by FROM meta_records WHERE id = $1 AND sheet_id = $2 FOR UPDATE',
            [recordId, view.sheetId],
          )
          if ((currentRes as any).rows.length === 0) {
            throw new NotFoundError(`Record not found: ${recordId}`)
          }
          const currentRow: any = (currentRes as any).rows[0]
          if (!ensureRecordWriteAllowed(effectiveCapabilities, effectiveSheetScope, effectiveAccess, typeof currentRow?.created_by === 'string' ? currentRow.created_by : null, 'edit')) {
            throw new ValidationError('Record editing is not allowed for this row')
          }
          const serverVersion = Number(currentRow?.version ?? 1)
          if (typeof parsed.data.expectedVersion === 'number' && parsed.data.expectedVersion !== serverVersion) {
            throw new VersionConflictError(recordId, serverVersion)
          }

          if (Object.keys(patch).length > 0) {
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
      const readableEchoFieldIds = new Set(visibleFormFields.filter((field) => echoFieldPermissions[field.id]?.visible !== false).map((field) => field.id))

      const relationalLinkFields = fields
        .map((field) => (field.type === 'link' ? { fieldId: field.id, cfg: parseLinkFieldConfig(field.property) } : null))
        .filter((value): value is RelationalLinkField => !!value && !!value.cfg)
      const attachmentFields = visibleFormFields.filter((field) => field.type === 'attachment')
      const linkValuesByRecord = await loadLinkValuesByRecord(pool.query.bind(pool), [record.id], relationalLinkFields)
      for (const { fieldId } of relationalLinkFields) {
        record.data[fieldId] = linkValuesByRecord.get(record.id)?.get(fieldId) ?? []
      }
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
        'SELECT id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2',
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
      }
      const visiblePropertyFields = filterVisiblePropertyFields(fields)
      // F3 (#2106 §3 F3): the write already happened above; this set gates ONLY the read-back echo, so it must
      // honor layer-3 field_permissions, not just layer-2 (property.hidden). Same composite as the #2028 read
      // mask. The write gate (canEditRecord + RecordService) is unchanged — a write-only-no-read field is still
      // writable, just omitted from the echo.
      const echoFieldScopeMap = access.userId ? await loadFieldPermissionScopeMap(pool.query.bind(pool), sheetId, access.userId) : new Map()
      const echoFieldPermissions = deriveFieldPermissions(visiblePropertyFields, capabilities, { hiddenFieldIds: [], fieldScopeMap: echoFieldScopeMap })
      const readableEchoFields = visiblePropertyFields.filter((field) => echoFieldPermissions[field.id]?.visible !== false)
      const readableEchoFieldIds = new Set(readableEchoFields.map((field) => field.id))

      const relationalLinkFields = fields
        .map((field) => (field.type === 'link' ? { fieldId: field.id, cfg: parseLinkFieldConfig(field.property) } : null))
        .filter((value): value is RelationalLinkField => !!value && !!value.cfg)
      const attachmentFields = readableEchoFields.filter((field) => field.type === 'attachment')
      const linkValuesByRecord = await loadLinkValuesByRecord(pool.query.bind(pool), [record.id], relationalLinkFields)
      for (const { fieldId } of relationalLinkFields) {
        record.data[fieldId] = linkValuesByRecord.get(record.id)?.get(fieldId) ?? []
      }
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
      const allowedFieldIds = new Set(
        visiblePropertyFields.filter((field) => securityFieldPermissions[field.id]?.visible !== false).map((field) => field.id),
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
          records: items.map((r) => ({ id: r.id, version: r.version, data: filterRecordDataByFieldIds(r.data, allowedFieldIds) })),
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
          'SELECT id, sheet_id, version, data, created_by FROM meta_records WHERE id = $1 AND sheet_id = $2',
          [recordId, sheetId],
        )
        : await pool.query(
          'SELECT id, sheet_id, version, data, created_by FROM meta_records WHERE id = $1',
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
      }

      const relationalLinkFields = fields
        .map((field) => (field.type === 'link' ? { fieldId: field.id, cfg: parseLinkFieldConfig(field.property) } : null))
        .filter((value): value is RelationalLinkField => !!value && !!value.cfg)
      const linkValuesByRecord = await loadLinkValuesByRecord(pool.query.bind(pool), [record.id], relationalLinkFields)
      for (const { fieldId } of relationalLinkFields) {
        record.data[fieldId] = linkValuesByRecord.get(record.id)?.get(fieldId) ?? []
      }
      await applyLookupRollup(req, pool.query.bind(pool), fields, [record], relationalLinkFields, linkValuesByRecord)
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
      const allowedFieldIds = new Set(
        visiblePropertyFields.filter((field) => securityFieldPermissions[field.id]?.visible !== false).map((field) => field.id),
      )
      record.data = filterRecordDataByFieldIds(record.data, allowedFieldIds)
      const linkSummaries = filterSingleRecordFieldSummaryMap(
        Object.fromEntries(
          Array.from((await buildLinkSummaries(req, pool.query.bind(pool), [record], relationalLinkFields, linkValuesByRecord)).get(record.id)?.entries() ?? []),
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

      const viewScopeMap = (access.userId && viewConfig) ? await loadViewPermissionScopeMap(pool.query.bind(pool), [viewConfig.id], access.userId) : new Map()
      const fieldPermissions = deriveFieldPermissions(fields, capabilities, {
        hiddenFieldIds: viewConfig?.hiddenFieldIds ?? [],
        fieldScopeMap,
      })
      const viewPermissions = viewConfig ? deriveViewPermissions([viewConfig], capabilities, viewScopeMap) : {}
      const rowActions = deriveRecordRowActions(capabilities, sheetScope, access, record.createdBy)

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

      const allowedFieldIds = await loadAllowedFieldIds(pool.query.bind(pool), sheetId, access.userId, capabilities)
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
          [{ id: recordId, version: 0, data: {} }],
          [{ fieldId, cfg: linkConfig }],
          linkValuesByRecord,
        )
        selected = linkSummaries.get(recordId)?.get(fieldId) ?? []
      }

      // F5 (#2106 §3 F5): gate the FOREIGN sheet's default display field by ITS OWN layer-2 ∧ layer-3 allowed
      // set (keyed to the foreign sheet, not the caller's) so a field_permissions-denied display value never
      // leaks via the summary `display`.
      const foreignAllowedFieldIds = await loadAllowedFieldIds(pool.query.bind(pool), linkConfig.foreignSheetId, foreignAccess.userId, capabilities)
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
      const allowedFieldIds = new Set(
        visiblePropertyFields.filter((field) => securityFieldPermissions[field.id]?.visible !== false).map((field) => field.id),
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
      const patchContext = await buildRecordPatchContext(pool.query.bind(pool), sheetId, access, capabilities)
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
