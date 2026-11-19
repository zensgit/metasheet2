import { canCopyText, copyText } from '../../utils/clipboard'
import { type InjectionKey, computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue'
import { ElMessageBox } from 'element-plus'
import { presentRoleTitle } from '../../views/builtinCatalogPresentation'
import {
  buildMemberGroupNamespaceOptions,
  buildMemberGroupRoleOptions,
  isRoleRejectedAsMemberGroupDefault,
  normalizeDirectoryRoleCatalog,
  type DirectoryPickerOption,
  type DirectoryRoleCatalogItem,
} from '../../views/directoryConfigPickerOptions'
import { apiFetch } from '../../utils/api'
import {
  DINGTALK_REDIRECT_URI_REQUIREMENT,
  formatDingTalkLoginEnvList,
  readDingTalkMissingEnv,
  requirementForDingTalkReason,
} from '../../utils/dingtalkLoginConfig'
import { subscribeToLocationChanges } from '../../utils/browserLocation'

export function useDirectoryManagement() {

type DirectoryIntegration = {
  orgId?: string
  id: string
  name: string
  corpId: string
  status: string
  syncEnabled: boolean
  scheduleCron: string | null
  defaultDeprovisionPolicy: string
  lastSyncAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
  config: {
    corpName?: string | null
    appName?: string | null
    identityStatus?: 'unverified' | 'verified' | 'mismatch'
    identityVerification?: { appCorpId: string; appCorpName: string; checkedAt: string } | null
    appKey: string
    appSecretConfigured: boolean
    workNotificationAgentIdConfigured?: boolean
    approvalCardLinkSecretConfigured?: boolean
    approvalCardPublicAppUrl?: string | null
    rootDepartmentId: string
    baseUrl: string | null
    pageSize: number
    admissionMode: 'manual_only' | 'auto_for_scoped_departments'
    admissionDepartmentIds: string[]
    excludeDepartmentIds: string[]
    memberGroupSyncMode: 'disabled' | 'sync_scoped_departments'
    memberGroupDepartmentIds: string[]
    memberGroupDefaultRoleIds: string[]
    memberGroupDefaultNamespaces: string[]
  }
  stats: {
    departmentCount: number
    accountCount: number
    pendingLinkCount: number
    linkedCount: number
    lastRunStatus: string | null
  }
}

type DirectoryRun = {
  id: string
  status: string
  startedAt: string
  finishedAt: string | null
  stats: Record<string, unknown>
  errorMessage: string | null
}

// Mirrors DirectorySyncPreview from packages/core-backend/src/directory/directory-sync.ts
// (DT-OPS-02 preview endpoint) — read-only dry-run counts + samples, nothing written.
type DirectorySyncPreview = {
  integrationId: string
  integrationName: string
  departmentsSeen: number
  accountsSeen: number
  wouldCreateAccounts: number
  wouldDeactivateAccounts: number
  wouldDeactivateLinkedAccounts: number
  autoAdmissionMode: 'manual_only' | 'auto_for_scoped_departments'
  autoAdmissionCandidateCount: number
  autoAdmissionSkippedMissingEmailCount: number
  autoAdmissionExcludedCount: number
  sampledNewAccounts: Array<{ externalUserId: string; name: string }>
  sampledDeactivations: Array<{ externalUserId: string; name: string; linked: boolean }>
}

type DirectoryObservationStatus =
  | 'disabled'
  | 'missing_cron'
  | 'invalid_cron'
  | 'awaiting_first_run'
  | 'scheduler_observed'
  | 'configured_no_runs'
  | 'manual_only'
  | 'auto_observed'

type DirectoryScheduleRun = {
  id: string
  status: string
  startedAt: string
  finishedAt: string | null
  stats: Record<string, unknown>
  errorMessage: string | null
  triggeredBy: string | null
  triggerSource: string
  createdAt: string
  updatedAt: string
}

type DirectoryScheduleSnapshot = {
  integrationId: string
  syncEnabled: boolean
  scheduleCron: string | null
  cronValid: boolean
  nextExpectedRunAt: string | null
  lastRun: DirectoryScheduleRun | null
  lastManualRun: DirectoryScheduleRun | null
  lastAutomaticRun: DirectoryScheduleRun | null
  observationStatus: DirectoryObservationStatus
  observationMessage: string
}

type DirectoryAlertFilter = 'all' | 'pending' | 'acknowledged'
type DirectoryDepartmentScopeFilter = 'all' | 'configured' | 'issues' | 'inactive' | 'unlinked' | 'staleBatch' | DirectoryDepartmentTargetField

type DirectorySyncAlert = {
  id: string
  integrationId: string
  runId: string | null
  level: 'info' | 'warning' | 'error'
  code: string
  message: string
  details: Record<string, unknown> | null
  createdAt: string
  acknowledgedAt: string | null
  acknowledgedBy: string | null
}

type DirectoryReviewItemFilter = 'all' | 'pending_binding' | 'inactive_linked' | 'missing_identifier'

type DirectoryReviewItem = {
  kind: DirectoryReviewItemFilter
  reason: string
  account: DirectoryAccount
  recommendations: DirectoryBindingRecommendation[]
  recommendationStatus: DirectoryBindingRecommendationStatus | null
  flags: {
    missingUnionId: boolean
    missingOpenId: boolean
  }
  actionable: {
    canBatchUnbind: boolean
    canConfirmRecommendation: boolean
  }
}

type DirectoryBindingRecommendationReason = 'pending_link' | 'email' | 'mobile'
type DirectoryBindingRecommendationStatusCode =
  | 'recommended'
  | 'no_exact_match'
  | 'ambiguous_exact_match'
  | 'pending_link_conflict'
  | 'linked_user_conflict'
  | 'external_identity_conflict'

type PendingBindingView = 'all' | 'recommended' | 'manual'
type PendingBindingManualReasonFilter = 'all' | 'no_exact_match' | 'conflict'
type ReviewBatchProgressKind = 'bind' | 'recommend' | 'admit' | 'unbind'
type ReviewBatchProgressPhase = 'submitting' | 'refreshing' | 'completed' | 'failed'

type ReviewBatchProgress = {
  kind: ReviewBatchProgressKind
  phase: ReviewBatchProgressPhase
  total: number
  applied: number
  message: string
}

type DirectoryBindingRecommendation = {
  localUser: LocalUserOption
  reasons: DirectoryBindingRecommendationReason[]
}

type DirectoryBindingRecommendationStatus = {
  code: DirectoryBindingRecommendationStatusCode
  message: string
}

type DirectoryAccount = {
  id: string
  integrationId: string
  provider: string
  corpId: string | null
  externalUserId: string
  unionId: string | null
  openId: string | null
  /**
   * Server-computed with the SAME predicate the bind/admit grant check runs (own openId, else the
   * openId a DingTalk login recorded for the same corp+unionId). Missing ⇒ treated as not grantable.
   */
  grantOpenIdAvailable?: boolean
  externalKey: string
  name: string
  email: string | null
  mobile: string | null
  isActive: boolean
  updatedAt: string
  linkStatus: string
  matchStrategy: string | null
  reviewedBy: string | null
  reviewNote: string | null
  linkUpdatedAt: string | null
  localUser: {
    id: string
    email: string | null
    username?: string | null
    name: string | null
  } | null
  departmentPaths: string[]
}

type DirectoryDepartment = {
  id: string
  integrationId: string
  provider: string
  externalDepartmentId: string
  parentExternalDepartmentId: string | null
  name: string
  fullPath: string | null
  orderIndex: number
  isActive: boolean
  lastSeenAt: string
  updatedAt: string
  accountCount: number
  linkedAccountCount: number
  childCount: number
}

type DirectoryDepartmentTreeRow = DirectoryDepartment & {
  depth: number
}

type DirectoryDepartmentTargetField = 'admission' | 'exclude' | 'memberGroup'

type DirectoryDepartmentReferenceIssue = {
  key: string
  field: DirectoryDepartmentTargetField
  fieldLabel: string
  kind: 'missing' | 'inactive'
  departmentId: string
  departmentName: string
}

type DirectoryDepartmentScopeChange = {
  field: DirectoryDepartmentTargetField
  fieldLabel: string
  added: string[]
  removed: string[]
}

type LocalUserOption = {
  id: string
  email: string | null
  username?: string | null
  name: string | null
  mobile?: string | null
  role: string
  is_active: boolean
}

type OnboardingPacket = {
  accountLabel?: string
  acceptInviteUrl?: string
  inviteMessage?: string
}

type ManualAdmissionDraft = {
  name: string
  email: string
  username: string
  mobile: string
}

type ManualAdmissionResult = {
  accountId: string
  accountName: string
  integrationId: string
  userId: string
  userName: string
  email: string | null
  username: string | null
  mobile: string
  temporaryPassword: string
  onboarding: OnboardingPacket | null
  bound: boolean
  bindError: string
  mobileBackfilled: boolean
  mobileBackfillError: string
}

type AutoAdmissionOnboardingPacket = {
  userId: string
  name: string
  email: string | null
  username: string | null
  mobile: string | null
  temporaryPassword: string
  onboarding: OnboardingPacket | null
}

type InitialDirectoryNavigation = {
  integrationId: string
  accountId: string
  source: string
  userId: string
}

type DirectoryRouteNavigationFailureNotice = {
  kind: 'missing_integration' | 'missing_account'
  message: string
  targetIntegrationId: string
  targetAccountId: string
  currentIntegrationName: string
}

type TestResult = {
  rootDepartmentId: string
  departmentSampleCount: number
  sampledDepartments: Array<{ id: string; name: string }>
  userSampleCount: number
  sampledUsers: Array<{ userId: string; name: string }>
  diagnostics: {
    rootDepartmentChildCount: number
    rootDepartmentDirectUserCount: number
    rootDepartmentDirectUserHasMore: boolean
    rootDepartmentDirectUserCountWithAccessLimit: number
    rootDepartmentDirectUserHasMoreWithAccessLimit: boolean
    sampledRootDepartmentUsers: Array<{ userId: string; name: string }>
    sampledRootDepartmentUsersWithAccessLimit: Array<{ userId: string; name: string }>
  }
  summary?: {
    code: string
    title: string
    nextAction: string
  }
  warnings: string[]
}

type DirectoryDraft = {
  appName: string
  corpName: string
  name: string
  corpId: string
  appKey: string
  appSecret: string
  workNotificationAgentId: string
  workNotificationTestUserId: string
  approvalCardPublicAppUrl: string
  rootDepartmentId: string
  baseUrl: string
  pageSize: number
  admissionMode: 'manual_only' | 'auto_for_scoped_departments'
  admissionDepartmentIdsText: string
  excludeDepartmentIdsText: string
  memberGroupSyncMode: 'disabled' | 'sync_scoped_departments'
  memberGroupDepartmentIdsText: string
  memberGroupDefaultRoleIdsText: string
  memberGroupDefaultNamespacesText: string
  status: string
  scheduleCron: string
  defaultDeprovisionPolicy: string
  syncEnabled: boolean
}

const integrations = ref<DirectoryIntegration[]>([])
const integrationsLoaded = ref(false)
const integrationsLoadError = ref(false)
const runs = ref<DirectoryRun[]>([])
const accounts = ref<DirectoryAccount[]>([])
const departments = ref<DirectoryDepartment[]>([])
const scheduleSnapshot = ref<DirectoryScheduleSnapshot | null>(null)
const alerts = ref<DirectorySyncAlert[]>([])
const reviewItems = ref<DirectoryReviewItem[]>([])
const accountsSectionRef = ref<HTMLElement | null>(null)
const accountPageSizeOptions = [25, 50, 100]
const accountPage = ref(1)
const accountPageSize = ref(25)
const accountTotal = ref(0)
const focusedAccountId = ref('')
const pendingFocusedAccountScroll = ref(false)
const selectedIntegrationId = ref('')
let directoryContextVersion = 0
let directoryViewActive = true
const directoryTabs = [
  { id: 'overview', label: '概览' },
  { id: 'accounts', label: '成员账号' },
  { id: 'organization', label: '组织架构' },
  { id: 'review', label: '待处理' },
  { id: 'sync', label: '同步与运行' },
  { id: 'settings', label: '设置' },
] as const
type DirectoryTab = typeof directoryTabs[number]['id']
const activeDirectoryTab = ref<DirectoryTab>(readDirectoryTab())

function onDirectoryRoute(): boolean {
  return typeof window !== 'undefined'
    && window.location.pathname.replace(/\/$/, '').toLowerCase() === `${import.meta.env.BASE_URL}admin/directory`.toLowerCase()
}

function readDirectoryTab(): DirectoryTab {
  if (!onDirectoryRoute()) return 'overview'
  const params = new URL(window.location.href).searchParams
  if (params.get('accountId')?.trim()) return 'accounts'
  const requested = params.get('tab')
  return directoryTabs.find((tab) => tab.id === requested)?.id ?? 'overview'
}

function setDirectoryTab(tab: DirectoryTab) {
  activeDirectoryTab.value = tab
  if (!onDirectoryRoute()) return
  const url = new URL(window.location.href)
  url.searchParams.set('tab', tab)
  if (tab !== 'accounts') url.searchParams.delete('accountId')
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}
const loading = ref(false)
const loadingRuns = ref(false)
const loadingSchedule = ref(false)
const loadingAlerts = ref(false)
const loadingReviewItems = ref(false)
const loadingMoreReviewItems = ref(false)
const loadingAccounts = ref(false)
const loadingDepartments = ref(false)
const busy = ref(false)
const approvalCardBusy = ref(false)
// Wave 2 async-sync UI state. `previewBusy` is deliberately its OWN flag (a preview does a
// full DingTalk pull — it must not silently block/unblock the global `busy` actions).
const previewBusy = ref(false)
const previewResult = ref<DirectorySyncPreview | null>(null)
const asyncSyncBusy = ref(false)
/** Non-empty exactly while this tab is polling a background sync run it started. */
const pollingRunId = ref('')
/** Which integration the active poll belongs to (poll survives same-integration refreshes). */
let pollingIntegrationId = ''
// Self-rescheduling setTimeout (NOT setInterval) so a slow poll never overlaps the next tick;
// `runPollToken` defeats zombie continuations — stopRunPolling() bumps it, and every async
// continuation re-checks it after each await (a fetch resolving after unmount/stop can't
// resurrect the loop). Pattern borrowed from useAiBulkFill.ts.
let runPollTimer: ReturnType<typeof setTimeout> | null = null
let runPollToken = 0
const approvalCardLinkSecretEnvOverrideActive = ref(false)
const bindingAccountId = ref('')
const unbindingAccountId = ref('')
const acknowledgingAlertId = ref('')
const reviewProcessingAccountId = ref('')
const reviewBatchProcessing = ref(false)
const reviewBatchProgress = ref<ReviewBatchProgress | null>(null)
const status = ref('')
const statusTone = ref<'info' | 'error'>('info')
// #6467: on-demand check of the DingTalk login (OAuth) probe -- the same endpoint the login page
// uses. Click-to-check rather than on mount, so opening this page sends no extra request.
// The probe only reads the server configuration and enterprise allowlist: it does not verify the
// credentials, an actual scan, the identity link or the account authorization, so the result is
// worded as a configuration check, never as "login works".
const dingtalkLoginProbeBusy = ref(false)
const dingtalkLoginProbeMessage = ref('')
const routeNavigationFailureNotice = ref<DirectoryRouteNavigationFailureNotice | null>(null)
const routeNavigationFailureAction = ref<'retry' | 'clear' | ''>('')
const testResult = ref<TestResult | null>(null)

const DINGTALK_LOGIN_PROBE_FAILED = '登录配置检查：无法获取检查结果，请稍后重试。'

function describeDingTalkLoginProbe(ok: boolean, payload: unknown): string {
  const envelope = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null
  const data = envelope?.data && typeof envelope.data === 'object' ? envelope.data as Record<string, unknown> : null
  if (!ok || envelope?.success !== true || !data) return DINGTALK_LOGIN_PROBE_FAILED
  if (data.available === true) return '登录配置检查：配置检查通过，尚未验证实际扫码、身份关联及账号授权。'
  if (data.unavailableReason === 'corp_not_allowed') {
    return '登录配置检查：未通过，企业白名单未放行，请检查 DINGTALK_CORP_ID 与 DINGTALK_ALLOWED_CORP_IDS。'
  }
  const reported = readDingTalkMissingEnv(data.missingEnv)
  const fromReason = requirementForDingTalkReason(data.unavailableReason)
  const missing = reported.length > 0 ? reported : fromReason ? [fromReason] : []
  if (missing.length === 0) return '登录配置检查：未通过，服务端钉钉登录当前不可用。'
  const redirectNote = missing.includes(DINGTALK_REDIRECT_URI_REQUIREMENT)
    ? '；DINGTALK_REDIRECT_URI 须与钉钉开放平台的登录回调地址一致'
    : ''
  return `登录配置检查：未通过，缺少服务端环境变量 ${formatDingTalkLoginEnvList(missing, true)}${redirectNote}。`
}

async function checkDingTalkLoginProbe(): Promise<void> {
  if (dingtalkLoginProbeBusy.value) return
  dingtalkLoginProbeBusy.value = true
  dingtalkLoginProbeMessage.value = '正在进行登录配置检查…'
  try {
    const response = await apiFetch('/api/auth/dingtalk/launch?probe=1', {
      method: 'GET',
      suppressUnauthorizedRedirect: true,
    })
    const payload = await response.json().catch(() => null)
    dingtalkLoginProbeMessage.value = describeDingTalkLoginProbe(response.ok, payload)
  } catch {
    dingtalkLoginProbeMessage.value = DINGTALK_LOGIN_PROBE_FAILED
  } finally {
    dingtalkLoginProbeBusy.value = false
  }
}
const departmentsLoaded = ref(false)
const departmentLoadError = ref('')
const departmentQuery = ref('')
const departmentScopeFilter = ref<DirectoryDepartmentScopeFilter>('all')
const manualDepartmentId = ref('')
const manualDepartmentName = ref('')
const pickedDepartmentId = ref('')
// Platform role catalog (GET /api/admin/roles), loaded lazily the first time a role or
// plugin picker opens; it is platform-level, so it survives integration switches.
const roleCatalog = ref<DirectoryRoleCatalogItem[]>([])
const roleCatalogLoaded = ref(false)
const roleCatalogLoading = ref(false)
const roleCatalogError = ref('')
const accountQuery = ref('')
let accountLoadVersion = 0
let alertLoadVersion = 0
let scheduleLoadVersion = 0
const accountSnapshotIntegrationId = ref('')
const alertSnapshotIntegrationId = ref('')
const accountsLoadFailed = ref(false)
const alertsLoadFailed = ref(false)
const scheduleLoadFailed = ref(false)
const accountStatusFilter = ref<'all' | 'linked' | 'pending' | 'unmatched' | 'manual_unbound'>('all')
const alertFilter = ref<DirectoryAlertFilter>('all')
const reviewFilter = ref<DirectoryReviewItemFilter>('all')
const pendingBindingView = ref<PendingBindingView>('recommended')
const pendingBindingViewTouched = ref(false)
const pendingBindingManualReason = ref<PendingBindingManualReasonFilter>('all')
const bindingDrafts = reactive<Record<string, string>>({})
const selectedBindingUsers = reactive<Record<string, LocalUserOption>>({})
const mobileOverrideConfirmations = reactive<Record<string, boolean>>({})
const mobileConflictHints = reactive<Record<string, string>>({})
const userSearchResults = reactive<Record<string, LocalUserOption[]>>({})
const userSearchLoading = reactive<Record<string, boolean>>({})
const userSearchError = reactive<Record<string, string>>({})
const manualAdmissionDrafts = reactive<Record<string, ManualAdmissionDraft>>({})
const manualAdmissionExpanded = reactive<Record<string, boolean>>({})
const manualAdmissionResult = ref<ManualAdmissionResult | null>(null)
const autoAdmissionOnboardingPackets = ref<AutoAdmissionOnboardingPacket[]>([])
const batchAdmissionOnboardingPackets = ref<AutoAdmissionOnboardingPacket[]>([])
const grantToggles = reactive<Record<string, boolean>>({})
const selectedReviewIds = reactive<Record<string, boolean>>({})
const reviewDisableDingTalkGrant = ref(true)
const reviewPageSize = 100
const reviewPage = ref(1)
const reviewTotal = ref(0)
const appliedDirectoryNavigationKey = ref('')
const alertFilterOptions = [
  { value: 'all' as const, label: '全部' },
  { value: 'pending' as const, label: '待确认' },
  { value: 'acknowledged' as const, label: '已确认' },
]
// The fixed review note the server writes when an admin unbinds a directory account
// (unbindDirectoryAccount in packages/core-backend/src/directory/directory-sync.ts). A manual bind
// resets it to NULL; directory sync leaves it unchanged. Copied here because the packages do not
// share code; a backend unit test pins the written value.
const DIRECTORY_ADMIN_UNBIND_REVIEW_NOTE = 'unbound by admin'
const visibleAccounts = computed(() => accounts.value.filter((account) => {
  if (accountStatusFilter.value === 'all') return true
  if (accountStatusFilter.value === 'manual_unbound') {
    return account.reviewNote === DIRECTORY_ADMIN_UNBIND_REVIEW_NOTE && account.linkStatus !== 'linked'
  }
  return account.linkStatus === accountStatusFilter.value
}))
const reviewFilterOptions = [
  { value: 'all' as const, label: '全部待处理' },
  { value: 'pending_binding' as const, label: '待绑定' },
  { value: 'inactive_linked' as const, label: '停用待停权' },
  { value: 'missing_identifier' as const, label: '缺身份标识' },
]
const pendingBindingViewOptions = [
  { value: 'all' as const, label: '全部待绑定' },
  { value: 'recommended' as const, label: '可推荐处理' },
  { value: 'manual' as const, label: '需人工处理' },
]
const pendingBindingManualReasonOptions = [
  { value: 'all' as const, label: '全部人工' },
  { value: 'no_exact_match' as const, label: '无精确匹配' },
  { value: 'conflict' as const, label: '冲突待复核' },
]
const departmentScopeFilterOptions = [
  { value: 'all' as const, label: '全部部门' },
  { value: 'unlinked' as const, label: '只看未全绑定' },
  { value: 'inactive' as const, label: '只看停用部门' },
  { value: 'staleBatch' as const, label: '只看非最新批次' },
  { value: 'configured' as const, label: '只看已配置' },
  { value: 'issues' as const, label: '只看异常' },
  { value: 'admission' as const, label: '只看准入' },
  { value: 'exclude' as const, label: '只看排除' },
  { value: 'memberGroup' as const, label: '只看成员组同步' },
]
const departmentTargetFields: DirectoryDepartmentTargetField[] = ['admission', 'exclude', 'memberGroup']
const directoryNavigation = ref(readInitialDirectoryNavigation())

const draft = reactive<DirectoryDraft>({
  name: '',
  corpId: '',
  corpName: '',
  appName: '',
  appKey: '',
  appSecret: '',
  workNotificationAgentId: '',
  workNotificationTestUserId: '',
  approvalCardPublicAppUrl: '',
  rootDepartmentId: '1',
  baseUrl: '',
  pageSize: 50,
  admissionMode: 'manual_only',
  admissionDepartmentIdsText: '',
  excludeDepartmentIdsText: '',
  memberGroupSyncMode: 'disabled',
  memberGroupDepartmentIdsText: '',
  memberGroupDefaultRoleIdsText: '',
  memberGroupDefaultNamespacesText: '',
  status: 'active',
  scheduleCron: '',
  defaultDeprovisionPolicy: 'manual_review',
  syncEnabled: false,
})

const selectedIntegration = computed(() =>
  integrations.value.find((integration) => integration.id === selectedIntegrationId.value) ?? null,
)
const routeNavigationFailureUserManagementLocation = computed(() => {
  const navigation = directoryNavigation.value
  if (navigation.source !== 'user-management' || navigation.userId.trim().length === 0) return ''
  const params = new URLSearchParams({
    userId: navigation.userId.trim(),
    source: 'directory-sync',
  })
  const failureKind = routeNavigationFailureNotice.value?.kind?.trim() || ''
  const integrationId = routeNavigationFailureNotice.value?.targetIntegrationId?.trim() || navigation.integrationId.trim()
  const accountId = routeNavigationFailureNotice.value?.targetAccountId?.trim() || navigation.accountId.trim()
  if (failureKind.length > 0) params.set('directoryFailure', failureKind)
  if (integrationId.length > 0) params.set('integrationId', integrationId)
  if (accountId.length > 0) params.set('accountId', accountId)
  return `/admin/users?${params.toString()}`
})
const accountPageCount = computed(() => Math.max(1, Math.ceil(accountTotal.value / accountPageSize.value)))
const accountRangeStart = computed(() => (
  accountTotal.value === 0
    ? 0
    : ((accountPage.value - 1) * accountPageSize.value) + 1
))
const accountRangeEnd = computed(() => (
  accountTotal.value === 0
    ? 0
    : Math.min(accountPage.value * accountPageSize.value, accountTotal.value)
))
const alertCounts = computed<Record<DirectoryAlertFilter, number>>(() => ({
  all: alerts.value.length,
  pending: alerts.value.filter((item) => !item.acknowledgedAt).length,
  acknowledged: alerts.value.filter((item) => Boolean(item.acknowledgedAt)).length,
}))
const filteredAlerts = computed(() => {
  if (alertFilter.value === 'pending') return alerts.value.filter((item) => !item.acknowledgedAt)
  if (alertFilter.value === 'acknowledged') return alerts.value.filter((item) => Boolean(item.acknowledgedAt))
  return alerts.value
})
const reviewCounts = computed<Record<DirectoryReviewItemFilter, number>>(() => ({
  all: reviewItems.value.length,
  pending_binding: reviewItems.value.filter((item) => item.kind === 'pending_binding').length,
  inactive_linked: reviewItems.value.filter((item) => item.kind === 'inactive_linked').length,
  missing_identifier: reviewItems.value.filter((item) => item.kind === 'missing_identifier').length,
}))
const pendingBindingCounts = computed<Record<PendingBindingView, number>>(() => ({
  all: reviewItems.value.filter((item) => item.kind === 'pending_binding').length,
  recommended: reviewItems.value.filter((item) => item.kind === 'pending_binding' && item.actionable.canConfirmRecommendation).length,
  manual: reviewItems.value.filter((item) => item.kind === 'pending_binding' && !item.actionable.canConfirmRecommendation).length,
}))
const pendingBindingManualReasonCounts = computed<Record<PendingBindingManualReasonFilter, number>>(() => {
  const manualItems = reviewItems.value.filter((item) => item.kind === 'pending_binding' && !item.actionable.canConfirmRecommendation)
  return {
    all: manualItems.length,
    no_exact_match: manualItems.filter((item) => readPendingBindingManualReasonCode(item) === 'no_exact_match').length,
    conflict: manualItems.filter((item) => readPendingBindingManualReasonCode(item) === 'conflict').length,
  }
})
const showPendingBindingManualReasonFilters = computed(() => (
  pendingBindingView.value === 'manual'
  && pendingBindingCounts.value.manual > 0
  && (reviewFilter.value === 'all' || reviewFilter.value === 'pending_binding')
))
const focusedVisibleAccount = computed(() => (
  visibleAccounts.value.find((account) => account.id === focusedAccountId.value) ?? null
))
const departmentRows = computed(() => buildDirectoryDepartmentTreeRows(departments.value))
const departmentFilterActive = computed(() => departmentQuery.value.trim().length > 0)
const departmentAccountCount = computed(() =>
  departmentRows.value.reduce((sum, department) => sum + department.accountCount, 0),
)
const departmentLinkedAccountCount = computed(() =>
  departmentRows.value.reduce((sum, department) => sum + department.linkedAccountCount, 0),
)
const departmentUnlinkedAccountCount = computed(() =>
  departmentRows.value.reduce((sum, department) => sum + readDepartmentUnlinkedAccountCount(department), 0),
)
const departmentUnlinkedMirrorCount = computed(() =>
  departmentRows.value.filter((department) => readDepartmentUnlinkedAccountCount(department) > 0).length,
)
const inactiveDepartmentCount = computed(() =>
  departmentRows.value.filter((department) => !department.isActive).length,
)
const departmentMirrorLatestSeenAt = computed(() =>
  readLatestDepartmentTimestamp(departmentRows.value, 'lastSeenAt'),
)
const departmentMirrorLatestUpdatedAt = computed(() =>
  readLatestDepartmentTimestamp(departmentRows.value, 'updatedAt'),
)
const departmentMirrorCurrentBatchCount = computed(() => {
  const latestSeenAtMs = readTimestampMs(departmentMirrorLatestSeenAt.value)
  if (latestSeenAtMs === null) return departmentRows.value.length
  return departmentRows.value.filter((department) => readTimestampMs(department.lastSeenAt) === latestSeenAtMs).length
})
const departmentMirrorStaleSeenCount = computed(() =>
  Math.max(0, departmentRows.value.length - departmentMirrorCurrentBatchCount.value),
)
const departmentMirrorObservationHasWarnings = computed(() =>
  departmentMirrorStaleSeenCount.value > 0 || inactiveDepartmentCount.value > 0,
)
const departmentMirrorObservationMessage = computed(() => {
  if (departmentMirrorStaleSeenCount.value > 0) {
    return `有 ${departmentMirrorStaleSeenCount.value} 个部门未出现在最新同步批次，建议复核是否为钉钉侧停用或本地镜像滞后。`
  }
  if (inactiveDepartmentCount.value > 0) {
    return `最新镜像中存在 ${inactiveDepartmentCount.value} 个停用部门，建议复核配置引用后再清理。`
  }
  return '本地组织镜像批次一致，未发现停用或跨批次部门。'
})
const departmentConfigScope = computed<Record<DirectoryDepartmentTargetField, Set<string>>>(() => ({
  admission: new Set(parseAdmissionDepartmentIdsText(draft.admissionDepartmentIdsText)),
  exclude: new Set(parseAdmissionDepartmentIdsText(draft.excludeDepartmentIdsText)),
  memberGroup: new Set(parseAdmissionDepartmentIdsText(draft.memberGroupDepartmentIdsText)),
}))
const departmentSavedConfigScope = computed<Record<DirectoryDepartmentTargetField, Set<string>>>(() => ({
  admission: new Set(readSavedDepartmentTargetIds('admission')),
  exclude: new Set(readSavedDepartmentTargetIds('exclude')),
  memberGroup: new Set(readSavedDepartmentTargetIds('memberGroup')),
}))
const departmentDraftScopeChanges = computed(() =>
  buildDepartmentScopeChanges(departmentConfigScope.value, departmentSavedConfigScope.value),
)
const hasDepartmentDraftScopeChanges = computed(() => departmentDraftScopeChanges.value.length > 0)
const departmentDraftScopeAddedCount = computed(() =>
  departmentDraftScopeChanges.value.reduce((sum, change) => sum + change.added.length, 0),
)
const departmentDraftScopeRemovedCount = computed(() =>
  departmentDraftScopeChanges.value.reduce((sum, change) => sum + change.removed.length, 0),
)
const hasScopedDepartmentConfig = computed(() =>
  departmentTargetFields.some((field) => departmentConfigScope.value[field].size > 0),
)
const departmentConfigReferenceIssues = computed(() =>
  buildDepartmentConfigReferenceIssues(departments.value, departmentConfigScope.value),
)
const configuredDepartmentIds = computed(() => buildConfiguredDepartmentIdSet(departmentConfigScope.value))
const configuredDepartmentCount = computed(() => configuredDepartmentIds.value.size)
const departmentReferenceIssueIds = computed(() => new Set(
  departmentConfigReferenceIssues.value.map((issue) => issue.departmentId),
))
const configuredDepartmentMirrorCount = computed(() => departmentRows.value.filter((department) =>
  configuredDepartmentIds.value.has(department.externalDepartmentId),
).length)
const issueDepartmentMirrorCount = computed(() => departmentRows.value.filter((department) =>
  departmentReferenceIssueIds.value.has(department.externalDepartmentId),
).length)
const scopeFilteredDepartmentRows = computed(() =>
  filterDirectoryDepartmentRowsByScope(
    departmentRows.value,
    departmentScopeFilter.value,
    configuredDepartmentIds.value,
    departmentReferenceIssueIds.value,
    departmentConfigScope.value,
  ),
)
const visibleDepartmentRows = computed(() =>
  filterDirectoryDepartmentRows(scopeFilteredDepartmentRows.value, departmentQuery.value),
)
const visibleDepartmentIdPreview = computed(() =>
  visibleDepartmentRows.value.map((department) => department.externalDepartmentId).join('\n'),
)
const visibleDepartmentNamePreview = computed(() =>
  visibleDepartmentRows.value.map((department) => readDepartmentPreviewLine(department)).join('\n'),
)
const departmentPickerOptions = computed<DirectoryPickerOption[]>(() =>
  departmentRows.value.map((department) => {
    const path = readDepartmentPickerPath(department)
    const detail = department.isActive ? path : `${path}（已停用）`
    return {
      value: department.externalDepartmentId,
      label: department.name || department.externalDepartmentId,
      detail,
      keywords: `${department.name} ${path}`,
    }
  }),
)
// With no integration selected there is nothing to load, so the picker shows its empty hint.
const departmentPickerLoaded = computed(() => departmentsLoaded.value || !selectedIntegration.value)
const departmentPickerError = computed(() => (
  departmentLoadError.value ? `加载部门失败：${departmentLoadError.value}` : ''
))
const departmentPickerEmptyText = '请先同步一次目录以加载部门'
const memberGroupRoleOptions = computed(() => buildMemberGroupRoleOptions(roleCatalog.value))
const memberGroupNamespaceOptions = computed(() => buildMemberGroupNamespaceOptions(roleCatalog.value))
const rootDepartmentPickerAvailable = computed(() => departmentsLoaded.value && departmentRows.value.length > 0)
const rootDepartmentTreeIds = computed(() => new Set(departmentRows.value.map((department) => department.externalDepartmentId)))
// The mirror only holds departments under the CURRENT root (the sync walks down from it), so
// 全公司 (ID 1) is always offered as its own option, and any other id outside the tree keeps an
// option of its own instead of being silently replaced by the first row.
const rootDepartmentNeedsFallbackOption = computed(() => {
  const rootDepartmentId = draft.rootDepartmentId.trim()
  return rootDepartmentId !== '1' && !rootDepartmentTreeIds.value.has(rootDepartmentId)
})
const departmentViewFilterActive = computed(() =>
  departmentFilterActive.value || departmentScopeFilter.value !== 'all',
)
const showVisibleDepartmentBulkActions = computed(() =>
  visibleDepartmentRows.value.length > 0
  && departmentViewFilterActive.value,
)
const departmentTreeEmptyMessage = computed(() => {
  const query = departmentQuery.value.trim()
  const hasQuery = query.length > 0
  if (departmentScopeFilter.value === 'configured') {
    return hasQuery
      ? `没有匹配“${query}”的已配置部门；可清空筛选或切回全部部门。`
      : '当前草稿没有可在组织架构镜像中展示的已配置部门；未同步引用请查看配置引用检查。'
  }
  if (departmentScopeFilter.value === 'issues') {
    return hasQuery
      ? `没有匹配“${query}”的异常部门；未同步引用请查看配置引用检查。`
      : '当前没有可在组织架构镜像中展示的异常部门；未同步引用请查看配置引用检查。'
  }
  if (departmentScopeFilter.value === 'unlinked') {
    return hasQuery
      ? `没有匹配“${query}”的未全绑定部门；可清空筛选或切回全部部门。`
      : '当前没有未完全绑定的部门。'
  }
  if (departmentScopeFilter.value === 'inactive') {
    return hasQuery
      ? `没有匹配“${query}”的停用部门；可清空筛选或切回全部部门。`
      : '当前没有停用部门。'
  }
  if (departmentScopeFilter.value === 'staleBatch') {
    return hasQuery
      ? `没有匹配“${query}”的非最新批次部门；可清空筛选或切回全部部门。`
      : '当前没有非最新批次部门。'
  }
  if (departmentTargetFields.includes(departmentScopeFilter.value as DirectoryDepartmentTargetField)) {
    const targetLabel = readDepartmentTargetLabel(departmentScopeFilter.value as DirectoryDepartmentTargetField)
    return hasQuery
      ? `没有匹配“${query}”的${targetLabel}部门；可清空筛选或切回全部部门。`
      : `当前草稿没有可在组织架构镜像中展示的${targetLabel}部门；未同步引用请查看配置引用检查。`
  }
  return hasQuery
    ? `没有匹配“${query}”的部门；可按部门名、部门 ID 或完整路径筛选。`
    : '没有可展示的部门。'
})
const focusedVisibleAccountBindDraft = computed(() => {
  if (!focusedVisibleAccount.value) return ''
  return readBindingDraft(focusedVisibleAccount.value).trim()
})
const focusedVisibleAccountBindLabel = computed(() => {
  if (!focusedVisibleAccount.value) return '绑定当前成员'
  if (bindingAccountId.value === focusedVisibleAccount.value.id) return '绑定中...'
  return focusedVisibleAccount.value.localUser ? '更新当前绑定' : '绑定当前成员'
})
const hasMoreReviewItems = computed(() => reviewItems.value.length < reviewTotal.value)
const filteredReviewItems = computed(() => {
  if (reviewFilter.value === 'all') {
    if (pendingBindingView.value === 'all') return reviewItems.value
    return reviewItems.value.filter((item) => (
      item.kind === 'pending_binding'
      && matchesPendingBindingView(item)
    ))
  }
  if (reviewFilter.value !== 'pending_binding') {
    return reviewItems.value.filter((item) => item.kind === reviewFilter.value)
  }
  if (pendingBindingView.value === 'all') {
    return reviewItems.value.filter((item) => item.kind === 'pending_binding')
  }
  return reviewItems.value.filter((item) => (
    item.kind === 'pending_binding'
    && matchesPendingBindingView(item)
  ))
})
// Bulk selection (选择当前筛选, 选择可推荐 and the default pre-selection) skips pending rows the
// server would reject (directory account inactive) and rows an admin unbound that are not linked
// again, so one click cannot re-bind what was just unbound. The per-row checkbox is unaffected.
function isBulkSelectablePendingBinding(item: DirectoryReviewItem): boolean {
  if (item.kind !== 'pending_binding') return false
  if (!item.account.isActive) return false
  return !(
    item.account.reviewNote === DIRECTORY_ADMIN_UNBIND_REVIEW_NOTE
    && item.account.linkStatus !== 'linked'
  )
}
const selectableVisibleReviewIds = computed(() => (
  filteredReviewItems.value
    .filter((item) => isBulkSelectablePendingBinding(item) || item.actionable.canBatchUnbind)
    .map((item) => item.account.id)
))
const selectableVisibleRecommendedReviewIds = computed(() => (
  filteredReviewItems.value
    .filter((item) => isBulkSelectablePendingBinding(item) && item.actionable.canConfirmRecommendation)
    .map((item) => item.account.id)
))
const selectedRecommendedReviewBindEntries = computed(() => (
  filteredReviewItems.value
    .filter((item) => (
      item.kind === 'pending_binding'
      && selectedReviewIds[item.account.id]
      && item.actionable.canConfirmRecommendation
      && item.recommendations.length > 0
    ))
    .map((item) => ({
      accountId: item.account.id,
      localUserRef: item.recommendations[0].localUser.id,
      enableDingTalkGrant: readAccountGrantToggle(item.account),
    }))
))
const selectedReviewBindEntries = computed(() => (
  filteredReviewItems.value
    .filter((item) => item.kind === 'pending_binding' && selectedReviewIds[item.account.id])
    .map((item) => ({
      accountId: item.account.id,
      localUserRef: readBindingDraft(item.account).trim(),
      enableDingTalkGrant: readAccountGrantToggle(item.account),
    }))
    .filter((item) => item.localUserRef.length > 0)
))
const selectedReviewAdmissionIds = computed(() => (
  filteredReviewItems.value
    .filter((item) => (
      item.kind === 'pending_binding'
      && selectedReviewIds[item.account.id]
      && !item.account.localUser
      && !item.actionable.canConfirmRecommendation
    ))
    .map((item) => item.account.id)
))
const selectedReviewBatchIds = computed(() => (
  filteredReviewItems.value
    .filter((item) => item.actionable.canBatchUnbind && selectedReviewIds[item.account.id])
    .map((item) => item.account.id)
))

const canSave = computed(() =>
  draft.name.trim().length > 0 &&
  draft.corpId.trim().length > 0 &&
  draft.appKey.trim().length > 0 &&
  (selectedIntegration.value !== null || draft.appSecret.trim().length > 0),
)

function setStatus(message: string, tone: 'info' | 'error' = 'info') {
  status.value = message
  statusTone.value = tone
}

function readInitialDirectoryNavigation(): InitialDirectoryNavigation {
  if (!onDirectoryRoute()) {
    return { integrationId: '', accountId: '', source: '', userId: '' }
  }
  const params = new URL(window.location.href).searchParams
  return {
    integrationId: params.get('integrationId')?.trim() || '',
    accountId: params.get('accountId')?.trim() || '',
    source: params.get('source')?.trim() || '',
    userId: params.get('userId')?.trim() || '',
  }
}

function buildDirectoryNavigationKey(navigation: InitialDirectoryNavigation): string {
  return [
    navigation.integrationId.trim(),
    navigation.accountId.trim(),
    navigation.source.trim(),
    navigation.userId.trim(),
  ].join('|')
}

function buildDirectoryLocation(navigation: InitialDirectoryNavigation): string {
  if (typeof window === 'undefined') return '/admin/directory'
  const url = new URL(window.location.href)
  const params = new URLSearchParams(url.search)
  const updateParam = (key: string, value: string) => {
    if (value.trim().length > 0) params.set(key, value.trim())
    else params.delete(key)
  }
  updateParam('integrationId', navigation.integrationId)
  updateParam('accountId', navigation.accountId)
  updateParam('source', navigation.source)
  updateParam('userId', navigation.userId)
  const search = params.toString()
  return `${url.pathname}${search ? `?${search}` : ''}${url.hash}`
}

function replaceDirectoryNavigation(navigation: InitialDirectoryNavigation): void {
  if (!onDirectoryRoute()) return
  window.history.replaceState(window.history.state, '', buildDirectoryLocation(navigation))
}

function syncDirectoryNavigationFromLocation(): boolean {
  const next = readInitialDirectoryNavigation()
  const currentKey = buildDirectoryNavigationKey(directoryNavigation.value)
  const nextKey = buildDirectoryNavigationKey(next)
  directoryNavigation.value = next
  return currentKey !== nextKey
}

function resetDraft() {
  directoryContextVersion += 1
  accountLoadVersion += 1
  alertLoadVersion += 1
  scheduleLoadVersion += 1
  accountSnapshotIntegrationId.value = ''
  alertSnapshotIntegrationId.value = ''
  accountsLoadFailed.value = false
  alertsLoadFailed.value = false
  scheduleLoadFailed.value = false
  setDirectoryTab('settings')
  selectedIntegrationId.value = ''
  testResult.value = null
  runs.value = []
  accounts.value = []
  cancelPendingDepartmentLoad()
  departments.value = []
  departmentsLoaded.value = false
  departmentLoadError.value = ''
  departmentQuery.value = ''
  departmentScopeFilter.value = 'all'
  manualDepartmentId.value = ''
  manualDepartmentName.value = ''
  pickedDepartmentId.value = ''
  reviewBatchProgress.value = null
  scheduleSnapshot.value = null
  alerts.value = []
  reviewItems.value = []
  reviewPage.value = 1
  reviewTotal.value = 0
  accountPage.value = 1
  accountPageSize.value = accountPageSizeOptions[0]
  accountTotal.value = 0
  accountQuery.value = ''
  accountStatusFilter.value = 'all'
  alertFilter.value = 'all'
  reviewFilter.value = 'all'
  pendingBindingView.value = 'recommended'
  pendingBindingViewTouched.value = false
  pendingBindingManualReason.value = 'all'
  reviewDisableDingTalkGrant.value = true
  for (const key of Object.keys(bindingDrafts)) delete bindingDrafts[key]
  for (const key of Object.keys(selectedBindingUsers)) delete selectedBindingUsers[key]
  for (const key of Object.keys(mobileOverrideConfirmations)) delete mobileOverrideConfirmations[key]
  for (const key of Object.keys(mobileConflictHints)) delete mobileConflictHints[key]
  for (const key of Object.keys(userSearchResults)) delete userSearchResults[key]
  for (const key of Object.keys(userSearchLoading)) delete userSearchLoading[key]
  for (const key of Object.keys(userSearchError)) delete userSearchError[key]
  for (const key of Object.keys(grantToggles)) delete grantToggles[key]
  for (const key of Object.keys(selectedReviewIds)) delete selectedReviewIds[key]
  autoAdmissionOnboardingPackets.value = []
  batchAdmissionOnboardingPackets.value = []
  draft.name = ''
  draft.corpId = ''
  draft.corpName = ''
  draft.appName = ''
  draft.appKey = ''
  draft.appSecret = ''
  draft.workNotificationAgentId = ''
  draft.workNotificationTestUserId = ''
  draft.approvalCardPublicAppUrl = ''
  approvalCardLinkSecretEnvOverrideActive.value = false
  draft.rootDepartmentId = '1'
  draft.baseUrl = ''
  draft.pageSize = 50
  draft.admissionMode = 'manual_only'
  draft.admissionDepartmentIdsText = ''
  draft.excludeDepartmentIdsText = ''
  draft.memberGroupSyncMode = 'disabled'
  draft.memberGroupDepartmentIdsText = ''
  draft.memberGroupDefaultRoleIdsText = ''
  draft.memberGroupDefaultNamespacesText = ''
  draft.status = 'active'
  draft.scheduleCron = ''
  draft.defaultDeprovisionPolicy = 'manual_review'
  draft.syncEnabled = false
}

function applyIntegrationToDraft(integration: DirectoryIntegration) {
  draft.name = integration.name
  draft.corpId = integration.corpId
  draft.corpName = integration.config.corpName ?? ''
  draft.appName = integration.config.appName ?? ''
  draft.appKey = integration.config.appKey
  draft.appSecret = ''
  draft.workNotificationAgentId = ''
  draft.workNotificationTestUserId = ''
  draft.approvalCardPublicAppUrl = integration.config.approvalCardPublicAppUrl ?? ''
  draft.rootDepartmentId = integration.config.rootDepartmentId
  draft.baseUrl = integration.config.baseUrl ?? ''
  draft.pageSize = integration.config.pageSize
  draft.admissionMode = integration.config.admissionMode
  draft.admissionDepartmentIdsText = integration.config.admissionDepartmentIds.join('\n')
  draft.excludeDepartmentIdsText = integration.config.excludeDepartmentIds.join('\n')
  draft.memberGroupSyncMode = integration.config.memberGroupSyncMode
  draft.memberGroupDepartmentIdsText = integration.config.memberGroupDepartmentIds.join('\n')
  draft.memberGroupDefaultRoleIdsText = integration.config.memberGroupDefaultRoleIds.join('\n')
  draft.memberGroupDefaultNamespacesText = integration.config.memberGroupDefaultNamespaces.join('\n')
  draft.status = integration.status
  draft.scheduleCron = integration.scheduleCron ?? ''
  draft.defaultDeprovisionPolicy = integration.defaultDeprovisionPolicy
  draft.syncEnabled = integration.syncEnabled
}

function parseAdmissionDepartmentIdsText(value: string): string[] {
  return Array.from(new Set(
    value
      .split(/[\n,]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  ))
}

function readDepartmentTargetText(field: DirectoryDepartmentTargetField): string {
  if (field === 'exclude') return draft.excludeDepartmentIdsText
  if (field === 'memberGroup') return draft.memberGroupDepartmentIdsText
  return draft.admissionDepartmentIdsText
}

function writeDepartmentTargetText(field: DirectoryDepartmentTargetField, ids: string[]): void {
  const nextValue = ids.join('\n')
  if (field === 'exclude') {
    draft.excludeDepartmentIdsText = nextValue
    return
  }
  if (field === 'memberGroup') {
    draft.memberGroupDepartmentIdsText = nextValue
    return
  }
  draft.admissionDepartmentIdsText = nextValue
}

function readDepartmentTargetLabel(field: DirectoryDepartmentTargetField): string {
  if (field === 'exclude') return '排除部门'
  if (field === 'memberGroup') return '成员组同步部门'
  return '准入白名单'
}

function readSavedDepartmentTargetIds(field: DirectoryDepartmentTargetField): string[] {
  const integration = selectedIntegration.value
  if (!integration) return []
  if (field === 'exclude') return integration.config.excludeDepartmentIds
  if (field === 'memberGroup') return integration.config.memberGroupDepartmentIds
  return integration.config.admissionDepartmentIds
}

function buildConfiguredDepartmentIdSet(
  scope: Record<DirectoryDepartmentTargetField, Set<string>>,
): Set<string> {
  const ids = new Set<string>()
  for (const field of departmentTargetFields) {
    for (const departmentId of scope[field]) ids.add(departmentId)
  }
  return ids
}

function buildDepartmentScopeChanges(
  draftScope: Record<DirectoryDepartmentTargetField, Set<string>>,
  savedScope: Record<DirectoryDepartmentTargetField, Set<string>>,
): DirectoryDepartmentScopeChange[] {
  return departmentTargetFields
    .map((field) => {
      const added = Array.from(draftScope[field]).filter((departmentId) => !savedScope[field].has(departmentId))
      const removed = Array.from(savedScope[field]).filter((departmentId) => !draftScope[field].has(departmentId))
      return {
        field,
        fieldLabel: readDepartmentTargetLabel(field),
        added,
        removed,
      }
    })
    .filter((change) => change.added.length > 0 || change.removed.length > 0)
}

function readTimestampMs(value: string | null | undefined): number | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? null : timestamp
}

function readLatestDepartmentTimestamp(
  rows: DirectoryDepartment[],
  field: 'lastSeenAt' | 'updatedAt',
): string | null {
  let latestValue: string | null = null
  let latestTimestamp: number | null = null
  for (const department of rows) {
    const timestamp = readTimestampMs(department[field])
    if (timestamp === null) continue
    if (latestTimestamp === null || timestamp > latestTimestamp) {
      latestTimestamp = timestamp
      latestValue = department[field]
    }
  }
  return latestValue
}

function isDepartmentInLatestMirrorBatch(department: DirectoryDepartment): boolean {
  const latestSeenAtMs = readTimestampMs(departmentMirrorLatestSeenAt.value)
  if (latestSeenAtMs === null) return true
  return readTimestampMs(department.lastSeenAt) === latestSeenAtMs
}

function readDepartmentUnlinkedAccountCount(department: DirectoryDepartment): number {
  return Math.max(0, department.accountCount - department.linkedAccountCount)
}

function filterDirectoryDepartmentRowsByScope(
  rows: DirectoryDepartmentTreeRow[],
  filter: DirectoryDepartmentScopeFilter,
  configuredIds: Set<string>,
  issueIds: Set<string>,
  scope: Record<DirectoryDepartmentTargetField, Set<string>>,
): DirectoryDepartmentTreeRow[] {
  if (filter === 'unlinked') {
    return rows.filter((department) => readDepartmentUnlinkedAccountCount(department) > 0)
  }
  if (filter === 'inactive') {
    return rows.filter((department) => !department.isActive)
  }
  if (filter === 'staleBatch') {
    return rows.filter((department) => !isDepartmentInLatestMirrorBatch(department))
  }
  if (filter === 'configured') {
    return rows.filter((department) => configuredIds.has(department.externalDepartmentId))
  }
  if (filter === 'issues') {
    return rows.filter((department) => issueIds.has(department.externalDepartmentId))
  }
  if (departmentTargetFields.includes(filter as DirectoryDepartmentTargetField)) {
    const field = filter as DirectoryDepartmentTargetField
    return rows.filter((department) => scope[field].has(department.externalDepartmentId))
  }
  return rows
}

function readDepartmentScopeFilterCount(filter: DirectoryDepartmentScopeFilter): string {
  if (filter === 'unlinked') return departmentUnlinkedMirrorCount.value > 0 ? ` (${departmentUnlinkedMirrorCount.value})` : ''
  if (filter === 'inactive') return inactiveDepartmentCount.value > 0 ? ` (${inactiveDepartmentCount.value})` : ''
  if (filter === 'staleBatch') return departmentMirrorStaleSeenCount.value > 0 ? ` (${departmentMirrorStaleSeenCount.value})` : ''
  if (filter === 'configured') return configuredDepartmentMirrorCount.value > 0 ? ` (${configuredDepartmentMirrorCount.value})` : ''
  if (filter === 'issues') return issueDepartmentMirrorCount.value > 0 ? ` (${issueDepartmentMirrorCount.value})` : ''
  if (departmentTargetFields.includes(filter as DirectoryDepartmentTargetField)) {
    const field = filter as DirectoryDepartmentTargetField
    const count = departmentRows.value.filter((department) =>
      departmentConfigScope.value[field].has(department.externalDepartmentId),
    ).length
    return count > 0 ? ` (${count})` : ''
  }
  return ''
}

function readDepartmentScopeFilterLabel(filter: DirectoryDepartmentScopeFilter): string {
  return departmentScopeFilterOptions.find((option) => option.value === filter)?.label ?? '全部部门'
}

function resetDepartmentViewFilters(): void {
  departmentQuery.value = ''
  departmentScopeFilter.value = 'all'
}

function focusDepartmentScopeFilter(filter: DirectoryDepartmentScopeFilter): void {
  departmentQuery.value = ''
  departmentScopeFilter.value = filter
}

function restoreDepartmentScopeDraftsToSavedConfig(): void {
  draft.admissionDepartmentIdsText = readSavedDepartmentTargetIds('admission').join('\n')
  draft.excludeDepartmentIdsText = readSavedDepartmentTargetIds('exclude').join('\n')
  draft.memberGroupDepartmentIdsText = readSavedDepartmentTargetIds('memberGroup').join('\n')
  setStatus('已还原部门范围草稿为已保存配置')
}

function restoreDepartmentScopeDraftToSavedConfig(field: DirectoryDepartmentTargetField): void {
  writeDepartmentTargetText(field, readSavedDepartmentTargetIds(field))
  setStatus(`已还原${readDepartmentTargetLabel(field)}为已保存配置`)
}

async function writeClipboardText(
  value: string,
  successMessage: string,
  options: {
    emptyMessage?: string
    unsupportedMessage?: string
    failureMessage?: string
  } = {},
): Promise<void> {
  const text = value.trim()
  if (text.length === 0) {
    setStatus(options.emptyMessage ?? '没有可复制的部门 ID', 'error')
    return
  }
  // "Unsupported" now means NO copy mechanism at all — plain-HTTP intranet deployments (no Clipboard
  // API) still copy through copyText's execCommand fallback.
  if (!canCopyText()) {
    setStatus(options.unsupportedMessage ?? '当前浏览器不支持自动复制，请从预览框手动复制部门 ID', 'error')
    return
  }
  if (await copyText(text)) {
    setStatus(successMessage)
  } else {
    setStatus(options.failureMessage ?? '复制部门 ID 失败，请从预览框手动复制', 'error')
  }
}

async function copyVisibleDepartmentIds(): Promise<void> {
  await writeClipboardText(
    visibleDepartmentIdPreview.value,
    `已复制 ${visibleDepartmentRows.value.length} 个当前可见部门 ID`,
  )
}

function buildVisibleDepartmentReport(): string {
  if (visibleDepartmentRows.value.length === 0) return ''
  const integrationName = selectedIntegration.value?.name ?? '未选择集成'
  const query = departmentQuery.value.trim()
  const lines = [
    'DingTalk organization visible department report',
    `Integration: ${integrationName}`,
    `Scope filter: ${readDepartmentScopeFilterLabel(departmentScopeFilter.value)}`,
    `Search query: ${query.length > 0 ? query : 'none'}`,
    `Visible department count: ${visibleDepartmentRows.value.length}`,
    `Latest mirror batch: ${departmentMirrorLatestSeenAt.value ?? 'not_recorded'}`,
    '',
    ...visibleDepartmentRows.value.map((department, index) => {
      const name = department.fullPath || department.name
      const activeStatus = department.isActive ? 'active_department' : 'inactive_department'
      const batchStatus = isDepartmentInLatestMirrorBatch(department) ? 'latest_batch' : 'not_latest_batch'
      const gapCount = readDepartmentUnlinkedAccountCount(department)
      return `${index + 1}. [${activeStatus}; ${batchStatus}] ${department.externalDepartmentId} · ${name} · members=${department.accountCount} · linked=${department.linkedAccountCount} · unlinked=${gapCount}`
    }),
  ]
  return lines.join('\n')
}

async function copyVisibleDepartmentReport(): Promise<void> {
  await writeClipboardText(
    buildVisibleDepartmentReport(),
    `已复制 ${visibleDepartmentRows.value.length} 个当前可见部门报告`,
    {
      emptyMessage: '当前没有可复制的可见部门',
      unsupportedMessage: '当前浏览器不支持自动复制，请手动复制当前可见部门内容',
      failureMessage: '复制当前可见部门报告失败，请手动复制当前可见部门内容',
    },
  )
}

async function copyDepartmentId(department: DirectoryDepartment): Promise<void> {
  await writeClipboardText(
    department.externalDepartmentId,
    `已复制部门 ${department.name} (${department.externalDepartmentId}) 的 ID`,
  )
}

function buildDepartmentReferenceIssueReport(): string {
  const issues = departmentConfigReferenceIssues.value
  if (issues.length === 0) return ''
  const integrationName = selectedIntegration.value?.name ?? '未选择集成'
  const lines = [
    'DingTalk organization reference issue report',
    `Integration: ${integrationName}`,
    `Issue count: ${issues.length}`,
    '',
    ...issues.map((issue, index) => {
      const status = issue.kind === 'missing' ? 'missing_from_mirror' : 'inactive_department'
      return `${index + 1}. [${status}] ${readDepartmentReferenceIssueLabel(issue)}`
    }),
  ]
  return lines.join('\n')
}

function describeDepartmentConfigReference(
  departmentId: string,
  departmentByExternalId: Map<string, DirectoryDepartment>,
): string {
  const department = departmentByExternalId.get(departmentId)
  if (!department) return `${departmentId} · missing_from_mirror`
  const status = department.isActive ? 'active_department' : 'inactive_department'
  const name = department.fullPath || department.name
  return `${departmentId} · ${status} · ${name}`
}

function buildDepartmentConfigReferenceReport(): string {
  const departmentByExternalId = new Map(departments.value.map((department) => [department.externalDepartmentId, department]))
  const integrationName = selectedIntegration.value?.name ?? '未选择集成'
  const lines = [
    'DingTalk organization configuration reference report',
    `Integration: ${integrationName}`,
    `Configured unique department IDs: ${configuredDepartmentCount.value}`,
    `Mirror departments loaded: ${departments.value.length}`,
    `Reference issue count: ${departmentConfigReferenceIssues.value.length}`,
  ]
  for (const field of departmentTargetFields) {
    const ids = parseAdmissionDepartmentIdsText(readDepartmentTargetText(field))
    lines.push('', `[${readDepartmentTargetLabel(field)}]`)
    if (ids.length === 0) {
      lines.push('- none')
      continue
    }
    for (const departmentId of ids) {
      lines.push(`- ${describeDepartmentConfigReference(departmentId, departmentByExternalId)}`)
    }
  }
  return lines.join('\n')
}

function buildDepartmentBindingGapReport(): string {
  const gapDepartments = departmentRows.value.filter((department) => readDepartmentUnlinkedAccountCount(department) > 0)
  if (gapDepartments.length === 0) return ''
  const integrationName = selectedIntegration.value?.name ?? '未选择集成'
  const lines = [
    'DingTalk organization binding gap report',
    `Integration: ${integrationName}`,
    `Unlinked member count: ${departmentUnlinkedAccountCount.value}`,
    `Departments with gaps: ${gapDepartments.length}`,
    '',
    ...gapDepartments.map((department, index) => {
      const status = department.isActive ? 'active_department' : 'inactive_department'
      const name = department.fullPath || department.name
      const gapCount = readDepartmentUnlinkedAccountCount(department)
      return `${index + 1}. [${status}] ${department.externalDepartmentId} · ${name} · members=${department.accountCount} · linked=${department.linkedAccountCount} · unlinked=${gapCount}`
    }),
  ]
  return lines.join('\n')
}

function buildInactiveDepartmentReport(): string {
  const inactiveDepartments = departmentRows.value.filter((department) => !department.isActive)
  if (inactiveDepartments.length === 0) return ''
  const integrationName = selectedIntegration.value?.name ?? '未选择集成'
  const lines = [
    'DingTalk organization inactive department report',
    `Integration: ${integrationName}`,
    `Inactive department count: ${inactiveDepartments.length}`,
    '',
    ...inactiveDepartments.map((department, index) => {
      const name = department.fullPath || department.name
      const gapCount = readDepartmentUnlinkedAccountCount(department)
      return `${index + 1}. [inactive_department] ${department.externalDepartmentId} · ${name} · members=${department.accountCount} · linked=${department.linkedAccountCount} · unlinked=${gapCount}`
    }),
  ]
  return lines.join('\n')
}

function buildDepartmentMirrorObservationReport(): string {
  if (departmentRows.value.length === 0) return ''
  const integrationName = selectedIntegration.value?.name ?? '未选择集成'
  const staleDepartments = departmentRows.value.filter((department) => !isDepartmentInLatestMirrorBatch(department))
  const lines = [
    'DingTalk organization mirror observation report',
    `Integration: ${integrationName}`,
    `Latest mirror batch: ${departmentMirrorLatestSeenAt.value ?? 'not_recorded'}`,
    `Latest mirror update: ${departmentMirrorLatestUpdatedAt.value ?? 'not_recorded'}`,
    `Integration last successful sync: ${selectedIntegration.value?.lastSuccessAt ?? 'not_recorded'}`,
    `Mirror department count: ${departmentRows.value.length}`,
    `Current batch departments: ${departmentMirrorCurrentBatchCount.value}`,
    `Not seen in latest batch: ${departmentMirrorStaleSeenCount.value}`,
    `Inactive departments: ${inactiveDepartmentCount.value}`,
    `Unlinked member count: ${departmentUnlinkedAccountCount.value}`,
  ]
  if (staleDepartments.length > 0) {
    lines.push('', '[not_seen_in_latest_batch]')
    for (const department of staleDepartments) {
      const name = department.fullPath || department.name
      lines.push(`- ${department.externalDepartmentId} · ${name} · active=${department.isActive ? 'yes' : 'no'} · lastSeenAt=${department.lastSeenAt}`)
    }
  }
  return lines.join('\n')
}

function buildDepartmentDraftScopeChangeReport(): string {
  if (departmentDraftScopeChanges.value.length === 0) return ''
  const departmentByExternalId = new Map(departments.value.map((department) => [department.externalDepartmentId, department]))
  const integrationName = selectedIntegration.value?.name ?? '未选择集成'
  const lines = [
    'DingTalk organization draft scope change report',
    `Integration: ${integrationName}`,
    `Changed fields: ${departmentDraftScopeChanges.value.length}`,
    `Added department references: ${departmentDraftScopeAddedCount.value}`,
    `Removed department references: ${departmentDraftScopeRemovedCount.value}`,
  ]
  for (const change of departmentDraftScopeChanges.value) {
    lines.push('', `[${change.fieldLabel}]`)
    if (change.added.length > 0) {
      lines.push('added:')
      for (const departmentId of change.added) {
        lines.push(`- ${describeDepartmentConfigReference(departmentId, departmentByExternalId)}`)
      }
    }
    if (change.removed.length > 0) {
      lines.push('removed:')
      for (const departmentId of change.removed) {
        lines.push(`- ${describeDepartmentConfigReference(departmentId, departmentByExternalId)}`)
      }
    }
  }
  return lines.join('\n')
}

async function copyDepartmentReferenceIssueReport(): Promise<void> {
  await writeClipboardText(
    buildDepartmentReferenceIssueReport(),
    `已复制 ${departmentConfigReferenceIssues.value.length} 条异常引用报告`,
    {
      emptyMessage: '当前没有可复制的异常引用',
      unsupportedMessage: '当前浏览器不支持自动复制，请手动复制异常引用内容',
      failureMessage: '复制异常引用报告失败，请手动复制异常引用内容',
    },
  )
}

async function copyDepartmentConfigReferenceReport(): Promise<void> {
  await writeClipboardText(
    buildDepartmentConfigReferenceReport(),
    `已复制 ${configuredDepartmentCount.value} 个配置部门引用报告`,
    {
      emptyMessage: '当前没有可复制的部门配置引用',
      unsupportedMessage: '当前浏览器不支持自动复制，请手动复制配置引用内容',
      failureMessage: '复制配置引用报告失败，请手动复制配置引用内容',
    },
  )
}

async function copyDepartmentBindingGapReport(): Promise<void> {
  await writeClipboardText(
    buildDepartmentBindingGapReport(),
    `已复制 ${departmentUnlinkedMirrorCount.value} 个未全绑定部门报告`,
    {
      emptyMessage: '当前没有可复制的未绑定部门',
      unsupportedMessage: '当前浏览器不支持自动复制，请手动复制未绑定部门内容',
      failureMessage: '复制未绑定部门报告失败，请手动复制未绑定部门内容',
    },
  )
}

async function copyInactiveDepartmentReport(): Promise<void> {
  await writeClipboardText(
    buildInactiveDepartmentReport(),
    `已复制 ${inactiveDepartmentCount.value} 个停用部门报告`,
    {
      emptyMessage: '当前没有可复制的停用部门',
      unsupportedMessage: '当前浏览器不支持自动复制，请手动复制停用部门内容',
      failureMessage: '复制停用部门报告失败，请手动复制停用部门内容',
    },
  )
}

async function copyDepartmentMirrorObservationReport(): Promise<void> {
  await writeClipboardText(
    buildDepartmentMirrorObservationReport(),
    `已复制 ${departmentRows.value.length} 个部门的同步观测报告`,
    {
      emptyMessage: '当前没有可复制的同步观测数据',
      unsupportedMessage: '当前浏览器不支持自动复制，请手动复制同步观测内容',
      failureMessage: '复制同步观测报告失败，请手动复制同步观测内容',
    },
  )
}

async function copyDepartmentDraftScopeChangeReport(): Promise<void> {
  await writeClipboardText(
    buildDepartmentDraftScopeChangeReport(),
    `已复制 ${departmentDraftScopeChanges.value.length} 个部门范围草稿变更报告`,
    {
      emptyMessage: '当前没有可复制的部门范围草稿变更',
      unsupportedMessage: '当前浏览器不支持自动复制，请手动复制草稿变更内容',
      failureMessage: '复制部门范围草稿变更报告失败，请手动复制草稿变更内容',
    },
  )
}

function buildDepartmentConfigReferenceIssues(
  items: DirectoryDepartment[],
  scope: Record<DirectoryDepartmentTargetField, Set<string>>,
): DirectoryDepartmentReferenceIssue[] {
  const hasConfiguredScope = departmentTargetFields.some((field) => scope[field].size > 0)
  if (items.length === 0 && !hasConfiguredScope) return []
  const departmentByExternalId = new Map(items.map((item) => [item.externalDepartmentId, item]))
  const issues: DirectoryDepartmentReferenceIssue[] = []
  for (const field of departmentTargetFields) {
    const fieldLabel = readDepartmentTargetLabel(field)
    for (const departmentId of scope[field]) {
      const department = departmentByExternalId.get(departmentId)
      if (!department) {
        issues.push({
          key: `${field}:missing:${departmentId}`,
          field,
          fieldLabel,
          kind: 'missing',
          departmentId,
          departmentName: '',
        })
        continue
      }
      if (!department.isActive) {
        issues.push({
          key: `${field}:inactive:${departmentId}`,
          field,
          fieldLabel,
          kind: 'inactive',
          departmentId,
          departmentName: department.name,
        })
      }
    }
  }
  return issues
}

function readDepartmentReferenceIssueLabel(issue: DirectoryDepartmentReferenceIssue): string {
  if (issue.kind === 'missing') {
    return `${issue.fieldLabel}引用不存在的部门 ID ${issue.departmentId}`
  }
  return `${issue.fieldLabel}引用已停用部门 ${issue.departmentName} (${issue.departmentId})`
}

function addDepartmentIdToTarget(
  departmentId: string,
  departmentName: string,
  field: DirectoryDepartmentTargetField,
  options: { manual?: boolean } = {},
): boolean {
  const normalizedDepartmentId = departmentId.trim()
  const normalizedDepartmentName = departmentName.trim() || (options.manual ? '手动部门' : '部门')
  const targetLabel = readDepartmentTargetLabel(field)
  if (normalizedDepartmentId.length === 0) {
    setStatus(`${normalizedDepartmentName}缺少部门 ID，无法加入${targetLabel}`, 'error')
    return false
  }
  const currentIds = parseAdmissionDepartmentIdsText(readDepartmentTargetText(field))
  if (currentIds.includes(normalizedDepartmentId)) {
    setStatus(`${normalizedDepartmentName} (${normalizedDepartmentId}) 已在${targetLabel}中`)
    return false
  }
  writeDepartmentTargetText(field, [...currentIds, normalizedDepartmentId])
  setStatus(`已将${options.manual ? '手动部门' : '部门'} ${normalizedDepartmentName} (${normalizedDepartmentId}) 加入${targetLabel}`)
  return true
}

function addDepartmentToTarget(department: DirectoryDepartment, field: DirectoryDepartmentTargetField): void {
  addDepartmentIdToTarget(department.externalDepartmentId, department.name, field)
}

function addVisibleDepartmentsToTarget(field: DirectoryDepartmentTargetField): void {
  const targetLabel = readDepartmentTargetLabel(field)
  const departmentIds = visibleDepartmentRows.value
    .map((department) => department.externalDepartmentId.trim())
    .filter((departmentId) => departmentId.length > 0)
  if (departmentIds.length === 0) {
    setStatus(`当前没有可加入${targetLabel}的可见部门`, 'error')
    return
  }
  const currentIds = parseAdmissionDepartmentIdsText(readDepartmentTargetText(field))
  const currentSet = new Set(currentIds)
  const nextIds = [...currentIds]
  for (const departmentId of departmentIds) {
    if (currentSet.has(departmentId)) continue
    currentSet.add(departmentId)
    nextIds.push(departmentId)
  }
  const addedCount = nextIds.length - currentIds.length
  if (addedCount === 0) {
    setStatus(`当前可见部门均已在${targetLabel}中`)
    return
  }
  writeDepartmentTargetText(field, nextIds)
  setStatus(`已将 ${addedCount} 个当前可见部门加入${targetLabel}`)
}

function removeVisibleDepartmentsFromTarget(field: DirectoryDepartmentTargetField): void {
  const targetLabel = readDepartmentTargetLabel(field)
  const departmentIds = new Set(
    visibleDepartmentRows.value
      .map((department) => department.externalDepartmentId.trim())
      .filter((departmentId) => departmentId.length > 0),
  )
  if (departmentIds.size === 0) {
    setStatus(`当前没有可从${targetLabel}移除的可见部门`, 'error')
    return
  }
  const currentIds = parseAdmissionDepartmentIdsText(readDepartmentTargetText(field))
  const nextIds = currentIds.filter((departmentId) => !departmentIds.has(departmentId))
  const removedCount = currentIds.length - nextIds.length
  if (removedCount === 0) {
    setStatus(`当前可见部门不在${targetLabel}中`)
    return
  }
  writeDepartmentTargetText(field, nextIds)
  setStatus(`已从${targetLabel}移除 ${removedCount} 个当前可见部门`)
}

function addManualDepartmentToTarget(field: DirectoryDepartmentTargetField): void {
  addDepartmentIdToTarget(manualDepartmentId.value, manualDepartmentName.value, field, { manual: true })
}

function writePickedDepartment(ids: string[]): void {
  pickedDepartmentId.value = ids[0] ?? ''
}

function addPickedDepartmentToTarget(field: DirectoryDepartmentTargetField): void {
  const departmentId = pickedDepartmentId.value
  const department = departments.value.find((item) => item.externalDepartmentId === departmentId)
  addDepartmentIdToTarget(departmentId, department?.name ?? '', field)
}

function readDepartmentTargetIds(field: DirectoryDepartmentTargetField): string[] {
  return parseAdmissionDepartmentIdsText(readDepartmentTargetText(field))
}

function writeMemberGroupDefaultRoleIds(roleIds: string[]): void {
  draft.memberGroupDefaultRoleIdsText = roleIds.join('\n')
}

function writeMemberGroupDefaultNamespaces(namespaces: string[]): void {
  draft.memberGroupDefaultNamespacesText = namespaces.join('\n')
}

function readDepartmentPickerPath(department: DirectoryDepartment): string {
  return department.fullPath?.trim() || department.name || department.externalDepartmentId
}

function readDepartmentPreviewLine(department: DirectoryDepartment): string {
  const name = department.name || department.externalDepartmentId
  const path = readDepartmentPickerPath(department)
  return path === name ? name : `${name} · ${path}`
}

function readUnknownDepartmentLabel(departmentId: string): string {
  return `未知部门（ID ${departmentId}）`
}

function readUnknownRoleLabel(roleId: string): string {
  const role = roleCatalog.value.find((item) => item.id === roleId)
  if (role && isRoleRejectedAsMemberGroupDefault(roleId)) {
    return `${presentRoleTitle(role) || roleId}（${roleId}，不可作为默认角色，保存会被拒绝）`
  }
  return `已删除的角色（${roleId}）`
}

function readUnknownNamespaceLabel(namespace: string): string {
  return `未知插件（${namespace}）`
}

function readRootDepartmentFallbackLabel(rootDepartmentId: string): string {
  const normalized = rootDepartmentId.trim()
  if (!normalized) return '未填写（保存时按 ID 1）'
  if (normalized === '1') return '全公司（ID 1）'
  return readUnknownDepartmentLabel(normalized)
}

async function loadDepartmentsForPicker(): Promise<void> {
  const integration = selectedIntegration.value
  if (!integration || loadingDepartments.value) return
  // A failed load leaves departmentsLoaded=true (the mirror section shows the error); reopening a
  // picker retries it, the same way the role catalog does.
  if (departmentsLoaded.value && !departmentLoadError.value) return
  await loadDepartments(integration.id, { force: true })
}

async function ensureRoleCatalogLoaded(): Promise<void> {
  if (roleCatalogLoaded.value || roleCatalogLoading.value) return
  roleCatalogLoading.value = true
  roleCatalogError.value = ''
  try {
    const response = await apiFetch('/api/admin/roles')
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '加载角色列表失败'))
    roleCatalog.value = normalizeDirectoryRoleCatalog(body?.data?.items)
    roleCatalogLoaded.value = true
  } catch (error) {
    // Left unloaded so reopening a picker retries; chips keep showing the raw saved values.
    roleCatalog.value = []
    roleCatalogError.value = `加载角色列表失败：${error instanceof Error ? error.message : '未知错误'}`
  } finally {
    roleCatalogLoading.value = false
  }
}

function removeDepartmentFromTarget(departmentId: string, field: DirectoryDepartmentTargetField): void {
  const normalizedDepartmentId = departmentId.trim()
  const targetLabel = readDepartmentTargetLabel(field)
  if (normalizedDepartmentId.length === 0) {
    setStatus(`缺少部门 ID，无法从${targetLabel}移除`, 'error')
    return
  }
  const currentIds = parseAdmissionDepartmentIdsText(readDepartmentTargetText(field))
  const nextIds = currentIds.filter((id) => id !== normalizedDepartmentId)
  if (nextIds.length === currentIds.length) {
    setStatus(`部门 ${normalizedDepartmentId} 不在${targetLabel}中`)
    return
  }
  writeDepartmentTargetText(field, nextIds)
  setStatus(`已将部门 ${normalizedDepartmentId} 从${targetLabel}移除`)
}

function removeAllDepartmentReferenceIssues(): void {
  const issues = departmentConfigReferenceIssues.value
  if (issues.length === 0) {
    setStatus('当前没有需要清理的异常部门引用')
    return
  }
  const removeIdsByField: Record<DirectoryDepartmentTargetField, Set<string>> = {
    admission: new Set(),
    exclude: new Set(),
    memberGroup: new Set(),
  }
  for (const issue of issues) {
    removeIdsByField[issue.field].add(issue.departmentId)
  }
  for (const field of departmentTargetFields) {
    const removeIds = removeIdsByField[field]
    if (removeIds.size === 0) continue
    const nextIds = parseAdmissionDepartmentIdsText(readDepartmentTargetText(field))
      .filter((id) => !removeIds.has(id))
    writeDepartmentTargetText(field, nextIds)
  }
  setStatus(`已清理 ${issues.length} 个异常部门引用`)
}

function readAdmissionModeLabel(integration: DirectoryIntegration): string {
  if (integration.config.admissionMode === 'auto_for_scoped_departments') {
    const includeCount = integration.config.admissionDepartmentIds.length
    const excludeCount = integration.config.excludeDepartmentIds.length
    const includeLabel = includeCount > 0 ? `${includeCount} 个部门白名单` : '未配置白名单'
    if (excludeCount > 0) return `自动准入 · ${includeLabel} / 排除 ${excludeCount} 个部门`
    return `自动准入 · ${includeLabel}`
  }
  return '自动准入已关闭'
}

function readMemberGroupSyncLabel(integration: DirectoryIntegration): string {
  if (integration.config.memberGroupSyncMode === 'sync_scoped_departments') {
    const count = integration.config.memberGroupDepartmentIds.length
    const governanceParts: string[] = []
    if (integration.config.memberGroupDefaultRoleIds.length > 0) {
      governanceParts.push(`默认角色 ${integration.config.memberGroupDefaultRoleIds.length}`)
    }
    if (integration.config.memberGroupDefaultNamespaces.length > 0) {
      governanceParts.push(`默认开通 ${integration.config.memberGroupDefaultNamespaces.length}`)
    }
    const scopeLabel = count > 0 ? `成员组同步 · ${count} 个部门` : '成员组同步 · 未配置部门'
    return governanceParts.length > 0 ? `${scopeLabel} / ${governanceParts.join(' / ')}` : scopeLabel
  }
  return '成员组同步已关闭'
}

function buildDirectoryDepartmentTreeRows(items: DirectoryDepartment[]): DirectoryDepartmentTreeRow[] {
  if (items.length === 0) return []
  const byExternalId = new Map(items.map((item) => [item.externalDepartmentId, item]))
  const childrenByParent = new Map<string, DirectoryDepartment[]>()
  const roots: DirectoryDepartment[] = []

  for (const item of items) {
    const parentId = item.parentExternalDepartmentId?.trim() || ''
    if (!parentId || !byExternalId.has(parentId)) {
      roots.push(item)
      continue
    }
    const children = childrenByParent.get(parentId) ?? []
    children.push(item)
    childrenByParent.set(parentId, children)
  }

  const sortDepartments = (left: DirectoryDepartment, right: DirectoryDepartment) => (
    left.orderIndex - right.orderIndex
    || left.name.localeCompare(right.name, 'zh-Hans-CN')
    || left.externalDepartmentId.localeCompare(right.externalDepartmentId)
  )
  roots.sort(sortDepartments)
  for (const children of childrenByParent.values()) {
    children.sort(sortDepartments)
  }

  const rows: DirectoryDepartmentTreeRow[] = []
  const visit = (item: DirectoryDepartment, depth: number, seen: Set<string>) => {
    if (seen.has(item.externalDepartmentId)) return
    rows.push({ ...item, depth })
    const nextSeen = new Set(seen)
    nextSeen.add(item.externalDepartmentId)
    for (const child of childrenByParent.get(item.externalDepartmentId) ?? []) {
      visit(child, depth + 1, nextSeen)
    }
  }
  for (const root of roots) visit(root, 0, new Set())
  return rows
}

function normalizeDepartmentSearchValue(value: unknown): string {
  return String(value ?? '').trim().toLocaleLowerCase('zh-Hans-CN')
}

function filterDirectoryDepartmentRows(
  rows: DirectoryDepartmentTreeRow[],
  query: string,
): DirectoryDepartmentTreeRow[] {
  const normalizedQuery = normalizeDepartmentSearchValue(query)
  if (normalizedQuery.length === 0) return rows
  return rows.filter((department) => {
    const searchable = [
      department.name,
      department.fullPath,
      department.externalDepartmentId,
      department.parentExternalDepartmentId,
    ]
      .map(normalizeDepartmentSearchValue)
      .join(' ')
    return searchable.includes(normalizedQuery)
  })
}

function readDepartmentIndentStyle(department: DirectoryDepartmentTreeRow): Record<string, string> {
  return {
    paddingLeft: `${Math.min(department.depth, 8) * 18 + 14}px`,
  }
}

function describeDepartmentParent(department: DirectoryDepartment): string {
  const parentId = department.parentExternalDepartmentId?.trim()
  if (!parentId) return '根部门'
  const parent = departments.value.find((item) => item.externalDepartmentId === parentId)
  return parent ? `${parent.name} (${parent.externalDepartmentId})` : parentId
}

async function selectIntegration(
  integrationId: string,
  options: { keepDepartments?: boolean } = {},
): Promise<void> {
  const integration = integrations.value.find((item) => item.id === integrationId)
  if (selectedIntegrationId.value !== integrationId) {
    directoryContextVersion += 1
    accountLoadVersion += 1
    alertLoadVersion += 1
    scheduleLoadVersion += 1
    accounts.value = []
    alerts.value = []
    scheduleSnapshot.value = null
    accountSnapshotIntegrationId.value = ''
    alertSnapshotIntegrationId.value = ''
    accountsLoadFailed.value = false
    alertsLoadFailed.value = false
    scheduleLoadFailed.value = false
    accountStatusFilter.value = 'all'
    loadingAccounts.value = Boolean(integration)
    loadingAlerts.value = Boolean(integration)
    loadingSchedule.value = Boolean(integration)
  }
  // A same-integration refresh after a save keeps the loaded tree on screen (pickers stay open,
  // the root-department select does not flip back to a text box) and reloads it in place.
  const keepDepartments = options.keepDepartments === true
    && selectedIntegrationId.value === integrationId
    && departmentsLoaded.value
    && !departmentLoadError.value
  // Poll + preview are integration-scoped: kill them only when actually SWITCHING integration
  // (selectIntegration also runs as a same-integration refresh after saves — an active
  // background-sync poll must survive those).
  if (pollingRunId.value && pollingIntegrationId !== integrationId) stopRunPolling()
  if (previewResult.value && previewResult.value.integrationId !== integrationId) previewResult.value = null
  selectedIntegrationId.value = integrationId
  approvalCardLinkSecretEnvOverrideActive.value = false
  testResult.value = null
  if (!keepDepartments) {
    cancelPendingDepartmentLoad()
    departments.value = []
    departmentsLoaded.value = false
    departmentLoadError.value = ''
    departmentQuery.value = ''
    departmentScopeFilter.value = 'all'
    pickedDepartmentId.value = ''
  }
  manualDepartmentId.value = ''
  manualDepartmentName.value = ''
  clearAutoAdmissionOnboardingPackets()
  clearBatchAdmissionOnboardingPackets()
  clearFocusedAccount()
  accountPage.value = 1
  accountTotal.value = 0
  reviewBatchProgress.value = null
  alertFilter.value = 'all'
  reviewFilter.value = 'all'
  pendingBindingView.value = 'recommended'
  pendingBindingViewTouched.value = false
  pendingBindingManualReason.value = 'all'
  reviewPage.value = 1
  reviewTotal.value = 0
  for (const key of Object.keys(selectedReviewIds)) delete selectedReviewIds[key]
  if (!integration) return
  applyIntegrationToDraft(integration)
  await applyInitialDirectoryNavigationBeforeLoads(integrationId)
  await Promise.all([
    loadRuns(integrationId),
    loadScheduleSnapshot(integrationId),
    loadAlerts(integrationId),
    loadReviewItems(integrationId),
    loadAccounts(integrationId),
    keepDepartments ? loadDepartments(integrationId, { force: true }) : Promise.resolve(),
  ])
}

function readApiError(payload: unknown, fallback: string): string {
  const error = payload && typeof payload === 'object' ? (payload as { error?: { message?: unknown } }).error : undefined
  return typeof error?.message === 'string' && error.message.trim().length > 0 ? error.message : fallback
}

function readApiErrorCode(payload: unknown): string {
  const error = payload && typeof payload === 'object' ? (payload as { error?: { code?: unknown } }).error : undefined
  return typeof error?.code === 'string' ? error.code : ''
}

// #6259: the admit-user route answers a login-name rule failure with 400 INVALID_USERNAME and
// `details.rule === 'login_name_ascii'` (English message unchanged). Localise by that code, never by
// the English prose. Copy matches the create-user form (UserManagementView, #6257); when #6257's
// shared copy module lands this can call it instead. Unknown codes return null (server message kept).
const DIRECTORY_ADMISSION_LOGIN_NAME_RULE_COPY = '登录名只能用小写字母、数字和 . _ -，3–64 位且至少一个字母；中文姓名请填「姓名」栏'
const DIRECTORY_ADMISSION_LOGIN_NAME_HINT = '登录名：只能用小写字母、数字和 . _ -，3–64 位且至少一个字母；中文姓名请填「姓名」栏。'

function describeDirectoryAdmissionError(payload: unknown): string | null {
  const error = payload && typeof payload === 'object'
    ? (payload as { error?: { code?: unknown; details?: unknown } }).error
    : undefined
  const details = error?.details && typeof error.details === 'object' && !Array.isArray(error.details)
    ? error.details as Record<string, unknown>
    : null
  if (error?.code === 'INVALID_USERNAME' && details?.rule === 'login_name_ascii') {
    return DIRECTORY_ADMISSION_LOGIN_NAME_RULE_COPY
  }
  return null
}

async function readJson(response: Response): Promise<any> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

async function loadIntegrations() {
  if (integrationsLoadError.value) setStatus('')
  loading.value = true
  integrationsLoadError.value = false
  integrationsLoaded.value = false
  try {
    const response = await apiFetch('/api/admin/directory/integrations')
    const payload = await readJson(response)
    if (!response.ok) throw new Error(readApiError(payload, '加载目录集成失败'))

    if (!Array.isArray(payload?.data?.items)) throw new Error('目录集成响应格式错误')
    const hadSelectedIntegration = Boolean(selectedIntegration.value)
    integrations.value = payload.data.items
    integrationsLoaded.value = true
    const navigation = directoryNavigation.value
    const navigationKey = buildDirectoryNavigationKey(navigation)
    const hasPendingCrossIntegrationNavigation = (
      navigation.accountId.length > 0
      && navigation.integrationId.length > 0
      && navigation.integrationId !== selectedIntegrationId.value
      && navigationKey !== appliedDirectoryNavigationKey.value
    )
    if (!selectedIntegrationId.value && integrations.value.length > 0) {
      const requestedIntegrationId = navigation.integrationId
      const requestedIntegration = requestedIntegrationId
        ? integrations.value.find((item) => item.id === requestedIntegrationId)
        : null
      if (requestedIntegrationId && !requestedIntegration) {
        clearFocusedAccountNavigationState()
        const message = readDirectoryIntegrationMissingMessage(requestedIntegrationId)
        setStatus(message, 'error')
        setRouteNavigationFailureNotice({
          kind: 'missing_integration',
          message,
          targetIntegrationId: requestedIntegrationId,
          targetAccountId: navigation.accountId,
          currentIntegrationName: integrations.value[0]?.name ?? '',
        })
      }
      const targetIntegration = requestedIntegration || integrations.value[0]
      if (targetIntegration) await selectIntegration(targetIntegration.id)
    } else if (hasPendingCrossIntegrationNavigation) {
      const targetIntegration = integrations.value.find((item) => item.id === navigation.integrationId)
      if (targetIntegration) {
        await selectIntegration(targetIntegration.id)
        return
      }
      clearFocusedAccountNavigationState()
      const message = readDirectoryIntegrationMissingMessage(navigation.integrationId)
      setStatus(message, 'error')
      setRouteNavigationFailureNotice({
        kind: 'missing_integration',
        message,
        targetIntegrationId: navigation.integrationId,
        targetAccountId: navigation.accountId,
        currentIntegrationName: selectedIntegration.value?.name ?? '',
      })
      const current = integrations.value.find((item) => item.id === selectedIntegrationId.value)
      if (current) {
        applyIntegrationToDraft(current)
        await loadAccounts(current.id)
      }
    } else if (selectedIntegrationId.value) {
      const current = integrations.value.find((item) => item.id === selectedIntegrationId.value)
      if (current) {
        if (hadSelectedIntegration) applyIntegrationToDraft(current)
        else await selectIntegration(current.id)
      }
    }
  } catch (error) {
    integrationsLoadError.value = !integrationsLoaded.value
    setStatus(error instanceof Error ? error.message : '加载目录集成失败', 'error')
  } finally {
    loading.value = false
  }
}

function readBindingDraft(account: DirectoryAccount): string {
  return bindingDrafts[account.id] ?? describeLocalUserIdentifier(account.localUser) ?? ''
}

function readBindingDraftByAccountId(accountId: string): string {
  const account = accounts.value.find((item) => item.id === accountId)
  if (!account) return bindingDrafts[accountId] ?? ''
  return readBindingDraft(account)
}

function clearFocusedAccount() {
  focusedAccountId.value = ''
  pendingFocusedAccountScroll.value = false
}

function clearFocusedAccountNavigationState() {
  clearFocusedAccount()
  accountQuery.value = ''
  accountStatusFilter.value = 'all'
  accountPage.value = 1
}

function clearRouteNavigationFailureNotice() {
  routeNavigationFailureNotice.value = null
}

async function retryRouteNavigationFailureNotice(): Promise<void> {
  if (!routeNavigationFailureNotice.value || routeNavigationFailureAction.value.length > 0) return
  routeNavigationFailureAction.value = 'retry'
  try {
    appliedDirectoryNavigationKey.value = ''
    await handleDirectoryNavigationChange()
  } finally {
    routeNavigationFailureAction.value = ''
  }
}

function clearFailedDirectoryNavigation() {
  if (!routeNavigationFailureNotice.value || routeNavigationFailureAction.value.length > 0) return
  routeNavigationFailureAction.value = 'clear'
  try {
    const retainedIntegrationId = selectedIntegration.value?.id ?? selectedIntegrationId.value
    const retainedIntegrationName = selectedIntegration.value?.name ?? routeNavigationFailureNotice.value.currentIntegrationName
    clearRouteNavigationFailureNotice()
    replaceDirectoryNavigation({
      integrationId: retainedIntegrationId,
      accountId: '',
      source: '',
      userId: '',
    })
    setStatus(retainedIntegrationName ? `已保留当前目录上下文 ${retainedIntegrationName}` : '已清除失败定位条件')
  } finally {
    routeNavigationFailureAction.value = ''
  }
}

function setRouteNavigationFailureNotice(notice: DirectoryRouteNavigationFailureNotice) {
  routeNavigationFailureNotice.value = notice
}

function readDirectoryIntegrationMissingMessage(integrationId: string): string {
  return `未找到目录集成 ${integrationId}，请确认该集成仍存在或稍后刷新列表重试`
}

function readDirectoryAccountMissingMessage(accountId: string): string {
  return `未找到目录成员 ${accountId}，请确认该成员仍存在`
}

function updateBindingDraft(accountId: string, value: string) {
  bindingDrafts[accountId] = value
  const selectedUser = selectedBindingUsers[accountId]
  if (!selectedUser) return
  const normalizedValue = value.trim()
  const selectedIdentifiers = new Set([
    selectedUser.id,
    selectedUser.email || '',
    selectedUser.username || '',
    selectedUser.mobile || '',
  ].filter((item) => item.trim().length > 0))
  if (!selectedIdentifiers.has(normalizedValue)) {
    delete selectedBindingUsers[accountId]
    delete mobileOverrideConfirmations[accountId]
    delete mobileConflictHints[accountId]
  }
}

function onBindingDraftInput(accountId: string, event: Event) {
  const target = event.target
  updateBindingDraft(accountId, target instanceof HTMLInputElement ? target.value : '')
  clearBindingSearch(accountId)
}

function readBindingSearchResults(accountId: string): LocalUserOption[] {
  return userSearchResults[accountId] ?? []
}

function readBindingSearchLoading(accountId: string): boolean {
  return userSearchLoading[accountId] ?? false
}

function readBindingSearchError(accountId: string): string {
  return userSearchError[accountId] ?? ''
}

function setBindingSearchState(accountId: string, state: {
  loading?: boolean
  error?: string
  results?: LocalUserOption[]
}) {
  if (typeof state.loading === 'boolean') userSearchLoading[accountId] = state.loading
  if (typeof state.error === 'string') userSearchError[accountId] = state.error
  else delete userSearchError[accountId]
  if (Array.isArray(state.results)) userSearchResults[accountId] = state.results
}

async function searchLocalUsers(accountId: string) {
  const term = readBindingDraftByAccountId(accountId).trim()
  if (!term) {
    setBindingSearchState(accountId, { results: [], error: '', loading: false })
    return
  }

  setBindingSearchState(accountId, { loading: true, error: '' })
  try {
    const params = new URLSearchParams({ page: '1', pageSize: '8', q: term })
    const response = await apiFetch(`/api/admin/users?${params.toString()}`)
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '搜索本地用户失败'))
    const items = Array.isArray(body?.data?.items) ? body.data.items : []
    setBindingSearchState(accountId, { results: items, loading: false })
  } catch (error) {
    setBindingSearchState(accountId, {
      results: [],
      loading: false,
      error: error instanceof Error ? error.message : '搜索本地用户失败',
    })
  }
}

function chooseLocalUser(accountId: string, user: LocalUserOption) {
  updateBindingDraft(accountId, describeLocalUserIdentifier(user))
  selectedBindingUsers[accountId] = user
  delete mobileOverrideConfirmations[accountId]
  delete mobileConflictHints[accountId]
  setBindingSearchState(accountId, { results: [] })
}

function applyRecommendedLocalUser(accountId: string, recommendation: DirectoryBindingRecommendation) {
  updateBindingDraft(accountId, describeLocalUserIdentifier(recommendation.localUser))
  selectedBindingUsers[accountId] = recommendation.localUser
  delete mobileOverrideConfirmations[accountId]
  delete mobileConflictHints[accountId]
  clearBindingSearch(accountId)
}

function readSelectedBindingUser(item: DirectoryReviewItem): LocalUserOption | null {
  return selectedBindingUsers[item.account.id] ?? item.recommendations[0]?.localUser ?? null
}

function hasSelectedBindingUserMobileConflict(item: DirectoryReviewItem): boolean {
  const selectedUser = readSelectedBindingUser(item)
  const accountMobile = item.account.mobile?.trim() || ''
  const userMobile = selectedUser?.mobile?.trim() || ''
  return accountMobile.length > 0 && userMobile.length > 0 && accountMobile !== userMobile
}

function shouldOfferMobileBackfill(item: DirectoryReviewItem): boolean {
  const selectedUser = readSelectedBindingUser(item)
  const accountMobile = item.account.mobile?.trim() || ''
  const userMobile = selectedUser?.mobile?.trim() || ''
  return item.kind === 'pending_binding' && accountMobile.length > 0 && selectedUser !== null && accountMobile !== userMobile
}

function isAwaitingMobileOverrideConfirmation(accountId: string): boolean {
  return mobileOverrideConfirmations[accountId] === true
}

function clearMobileOverrideConfirmation(accountId: string): void {
  delete mobileOverrideConfirmations[accountId]
}

function readBackfillAndBindLabel(item: DirectoryReviewItem): string {
  if (hasSelectedBindingUserMobileConflict(item)) {
    return isAwaitingMobileOverrideConfirmation(item.account.id) ? '确认覆盖手机号并绑定' : '回填手机号后绑定'
  }
  return '回填手机号后绑定'
}

async function refreshSingleReviewItem(accountId: string): Promise<void> {
  const response = await apiFetch(`/api/admin/directory/accounts/${encodeURIComponent(accountId)}/review-item`)
  const body = await readJson(response)
  if (!response.ok) throw new Error(readApiError(body, '刷新待绑定项失败'))
  const item = body?.data?.item
  if (!item || typeof item !== 'object') return
  const normalizedItem = normalizeReviewItems([item])[0]
  if (!normalizedItem) return
  const currentIndex = reviewItems.value.findIndex((entry) => entry.account.id === accountId)
  if (currentIndex >= 0) {
    reviewItems.value = reviewItems.value.map((entry, index) => index === currentIndex ? normalizedItem : entry)
  } else {
    reviewItems.value = [normalizedItem, ...reviewItems.value]
  }
  syncPendingBindingQueueDefaults()
}

function readMobileConflictHint(accountId: string): string {
  return mobileConflictHints[accountId] ?? ''
}

function clearMobileConflictHint(accountId: string): void {
  delete mobileConflictHints[accountId]
}

async function refreshSingleAccount(accountId: string): Promise<void> {
  const response = await apiFetch(`/api/admin/directory/accounts/${encodeURIComponent(accountId)}`)
  const body = await readJson(response)
  if (!response.ok) throw new Error(readApiError(body, '刷新目录成员失败'))
  const account = body?.data?.account as DirectoryAccount | undefined
  if (!account) return
  const currentIndex = accounts.value.findIndex((entry) => entry.id === accountId)
  if (currentIndex >= 0) {
    accounts.value = accounts.value.map((entry, index) => index === currentIndex ? account : entry)
  }
}

function readRecommendationReasonLabel(reasons: DirectoryBindingRecommendationReason[]): string {
  return reasons.map((reason) => {
    if (reason === 'pending_link') return '已存在待确认匹配'
    if (reason === 'email') return '邮箱精确匹配'
    return '手机号精确匹配'
  }).join(' · ')
}

function readGrantToggle(accountId: string): boolean {
  return grantToggles[accountId] ?? true
}

// The page does NOT re-derive the DT-HARDEN-02 rule from corpId/openId: the server computes
// grantOpenIdAvailable with the same predicate its grant check runs (which also accepts the openId
// a DingTalk login recorded for this person), so the checkbox can never disagree with the server.
function canEnableDingTalkGrant(account: Partial<Pick<DirectoryAccount, 'grantOpenIdAvailable'>>): boolean {
  return account.grantOpenIdAvailable === true
}

function readAccountGrantToggle(account: DirectoryAccount): boolean {
  return canEnableDingTalkGrant(account) && readGrantToggle(account.id)
}

function shouldWarnMissingOpenIdForGrant(account: Partial<Pick<DirectoryAccount, 'grantOpenIdAvailable'>>): boolean {
  return !canEnableDingTalkGrant(account)
}

function updateGrantToggle(accountId: string, value: boolean) {
  grantToggles[accountId] = value
}

function onGrantToggleChange(account: DirectoryAccount, event: Event) {
  const target = event.target
  if (!canEnableDingTalkGrant(account)) {
    updateGrantToggle(account.id, false)
    setStatus(`目录成员 ${account.name} 暂时拿不到 openId，暂不能开通钉钉登录；请先不勾选开通，完成绑定或激活 → 让成员用钉钉扫码登录一次 → 刷新当前成员后再开通（或到用户管理开通）`, 'error')
    return
  }
  updateGrantToggle(account.id, target instanceof HTMLInputElement ? target.checked : true)
}

function clearBindingSearch(accountId: string) {
  setBindingSearchState(accountId, { results: [], error: '' })
}

function buildManualAdmissionDraft(account: DirectoryAccount): ManualAdmissionDraft {
  return {
    name: account.name?.trim() || '',
    email: account.email?.trim() || '',
    username: '',
    mobile: account.mobile?.trim() || '',
  }
}

function readManualAdmissionDraft(account: DirectoryAccount): ManualAdmissionDraft {
  if (!manualAdmissionDrafts[account.id]) {
    manualAdmissionDrafts[account.id] = buildManualAdmissionDraft(account)
  }
  return manualAdmissionDrafts[account.id]
}

function isManualAdmissionExpanded(accountId: string): boolean {
  return manualAdmissionExpanded[accountId] === true
}

function toggleManualAdmission(account: DirectoryAccount): void {
  readManualAdmissionDraft(account)
  manualAdmissionExpanded[account.id] = !isManualAdmissionExpanded(account.id)
}

function onManualAdmissionDraftInput(accountId: string, field: keyof ManualAdmissionDraft, event: Event): void {
  const target = event.target
  const nextValue = target instanceof HTMLInputElement ? target.value : ''
  const current = manualAdmissionDrafts[accountId] ?? {
    name: '',
    email: '',
    username: '',
    mobile: '',
  }
  manualAdmissionDrafts[accountId] = {
    ...current,
    [field]: nextValue,
  }
}

function canSubmitManualAdmission(account: DirectoryAccount): boolean {
  const draft = readManualAdmissionDraft(account)
  return draft.name.trim().length > 0
    && (draft.email.trim().length > 0 || draft.username.trim().length > 0 || draft.mobile.trim().length > 0)
}

function describeLocalUserIdentifier(user: Pick<LocalUserOption, 'id' | 'email' | 'username' | 'mobile'> | null | undefined): string {
  if (!user) return ''
  return user.email || user.username || user.mobile || user.id
}

function describeLocalUserLabel(user: Pick<LocalUserOption, 'id' | 'email' | 'username' | 'mobile' | 'name'> | null | undefined): string {
  if (!user) return ''
  return user.name || describeLocalUserIdentifier(user)
}

function clearManualAdmissionResult(): void {
  manualAdmissionResult.value = null
}

function clearAutoAdmissionOnboardingPackets(): void {
  autoAdmissionOnboardingPackets.value = []
}

function clearBatchAdmissionOnboardingPackets(): void {
  batchAdmissionOnboardingPackets.value = []
}

function readCreatedLocalUserOption(data: Record<string, unknown>, fallback: ManualAdmissionDraft): LocalUserOption {
  const user = data.user && typeof data.user === 'object' ? data.user as Record<string, unknown> : null
  const id = typeof user?.id === 'string' ? user.id.trim() : ''
  if (!id) {
    throw new Error('创建用户成功但未返回用户 ID')
  }
  return {
    id,
    email: typeof user?.email === 'string' && user.email.trim().length > 0 ? user.email : (fallback.email || null),
    username: typeof user?.username === 'string' && user.username.trim().length > 0 ? user.username : (fallback.username || null),
    name: typeof user?.name === 'string' && user.name.trim().length > 0 ? user.name : fallback.name,
    mobile: typeof user?.mobile === 'string' && user.mobile.trim().length > 0 ? user.mobile : null,
    role: typeof user?.role === 'string' && user.role.trim().length > 0 ? user.role : 'user',
    is_active: typeof user?.is_active === 'boolean' ? user.is_active : true,
  }
}

function readAutoAdmissionOnboardingPackets(data: Record<string, unknown> | undefined): AutoAdmissionOnboardingPacket[] {
  const rawPackets = Array.isArray(data?.autoAdmissionOnboardingPackets) ? data.autoAdmissionOnboardingPackets : []
  return readDirectoryOnboardingPackets(rawPackets)
}

function readBatchAdmissionOnboardingPackets(data: Record<string, unknown> | undefined): AutoAdmissionOnboardingPacket[] {
  const rawPackets = Array.isArray(data?.onboardingPackets) ? data.onboardingPackets : []
  return readDirectoryOnboardingPackets(rawPackets)
}

function readDirectoryOnboardingPackets(rawPackets: unknown[]): AutoAdmissionOnboardingPacket[] {
  return rawPackets.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const packet = entry as Record<string, unknown>
    const userId = typeof packet.userId === 'string' ? packet.userId.trim() : ''
    if (!userId) return []
    return [{
      userId,
      name: typeof packet.name === 'string' ? packet.name : '',
      email: typeof packet.email === 'string' && packet.email.trim().length > 0 ? packet.email : null,
      username: typeof packet.username === 'string' && packet.username.trim().length > 0 ? packet.username : null,
      mobile: typeof packet.mobile === 'string' && packet.mobile.trim().length > 0 ? packet.mobile : null,
      temporaryPassword: typeof packet.temporaryPassword === 'string' ? packet.temporaryPassword : '',
      onboarding: packet.onboarding && typeof packet.onboarding === 'object'
        ? packet.onboarding as OnboardingPacket
        : null,
    }]
  })
}

function buildPayload() {
  const corpName = draft.corpName.trim()
  const currentCorpName = selectedIntegration.value?.config.corpName ?? ''
  const appName = draft.appName.trim()
  const currentAppName = selectedIntegration.value?.config.appName ?? ''
  return {
    integrationId: selectedIntegration.value?.id,
    name: draft.name.trim(),
    corpId: draft.corpId.trim(),
    ...(corpName !== currentCorpName ? { corpName } : {}),
    ...(appName !== currentAppName ? { appName } : {}),
    appKey: draft.appKey.trim(),
    appSecret: draft.appSecret.trim(),
    rootDepartmentId: draft.rootDepartmentId.trim() || '1',
    baseUrl: draft.baseUrl.trim(),
    pageSize: Number(draft.pageSize || 50),
    admissionMode: draft.admissionMode,
    admissionDepartmentIds: parseAdmissionDepartmentIdsText(draft.admissionDepartmentIdsText),
    excludeDepartmentIds: parseAdmissionDepartmentIdsText(draft.excludeDepartmentIdsText),
    memberGroupSyncMode: draft.memberGroupSyncMode,
    memberGroupDepartmentIds: parseAdmissionDepartmentIdsText(draft.memberGroupDepartmentIdsText),
    memberGroupDefaultRoleIds: parseAdmissionDepartmentIdsText(draft.memberGroupDefaultRoleIdsText),
    memberGroupDefaultNamespaces: parseAdmissionDepartmentIdsText(draft.memberGroupDefaultNamespacesText),
    status: draft.status,
    scheduleCron: draft.scheduleCron.trim(),
    defaultDeprovisionPolicy: draft.defaultDeprovisionPolicy,
    syncEnabled: draft.syncEnabled,
  }
}

async function saveIntegration() {
  busy.value = true
  try {
    const payload = buildPayload()
    const path = selectedIntegration.value
      ? `/api/admin/directory/integrations/${selectedIntegration.value.id}`
      : '/api/admin/directory/integrations'
    const method = selectedIntegration.value ? 'PUT' : 'POST'
    const response = await apiFetch(path, {
      method,
      body: JSON.stringify(payload),
    })
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '保存目录集成失败'))

    const integration = body?.data?.integration as DirectoryIntegration | undefined
    setStatus(selectedIntegration.value ? '目录集成已更新' : '目录集成已创建')
    testResult.value = null
    await loadIntegrations()
    if (integration?.id) await selectIntegration(integration.id, { keepDepartments: true })
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '保存目录集成失败', 'error')
  } finally {
    busy.value = false
  }
}

async function testIntegration() {
  busy.value = true
  try {
    const response = await apiFetch('/api/admin/directory/integrations/test', {
      method: 'POST',
      body: JSON.stringify(buildPayload()),
    })
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '目录连通性测试失败'))
    testResult.value = body?.data ?? null
    // The test reads samples only: name what was read, never a blanket pass.
    setStatus(testResult.value?.summary?.code === 'healthy'
      ? '目录连通性测试：抽样接口读取成功（未验证全员范围与扫码登录）'
      : '目录连通性测试完成，请查看诊断结论')
  } catch (error) {
    // A failed test must not leave an earlier result on screen as if it were current.
    testResult.value = null
    setStatus(error instanceof Error ? error.message : '目录连通性测试失败', 'error')
  } finally {
    busy.value = false
  }
}

function buildWorkNotificationPayload() {
  return {
    integrationId: selectedIntegration.value?.id ?? '',
    agentId: draft.workNotificationAgentId.trim(),
    recipientUserId: draft.workNotificationTestUserId.trim(),
  }
}

async function testWorkNotificationAgentId() {
  if (!selectedIntegration.value) {
    setStatus('请先选择或创建钉钉目录集成', 'error')
    return
  }
  busy.value = true
  try {
    const response = await apiFetch('/api/admin/directory/dingtalk/work-notification/test', {
      method: 'POST',
      body: JSON.stringify(buildWorkNotificationPayload()),
    })
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '工作通知 Agent ID 测试失败'))
    const notificationSent = body?.data?.result?.notificationSent === true
    setStatus(notificationSent
      ? '工作通知 Agent ID 测试通过，已发送测试消息'
      : '工作通知 Agent ID 基础测试通过；未填写测试接收人，未发送真实工作通知')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '工作通知 Agent ID 测试失败', 'error')
  } finally {
    busy.value = false
  }
}

async function saveWorkNotificationAgentId() {
  if (!selectedIntegration.value) {
    setStatus('请先选择或创建钉钉目录集成', 'error')
    return
  }
  if (!draft.workNotificationAgentId.trim()) {
    setStatus('请填写工作通知 Agent ID', 'error')
    return
  }
  busy.value = true
  try {
    const response = await apiFetch('/api/admin/directory/dingtalk/work-notification', {
      method: 'PUT',
      body: JSON.stringify(buildWorkNotificationPayload()),
    })
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '保存工作通知 Agent ID 失败'))
    const currentIntegrationId = selectedIntegration.value.id
    setStatus('工作通知 Agent ID 已验证并保存')
    await loadIntegrations()
    await selectIntegration(currentIntegrationId)
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '保存工作通知 Agent ID 失败', 'error')
  } finally {
    busy.value = false
  }
}

// Card-config lock §3.3 必做交互: regenerate is destructive for in-flight links → explicit
// ElMessageBox warning confirm (service API — works app-wide even though this view is hand-rolled).
async function confirmApprovalCardSecretRegenerate(): Promise<boolean> {
  try {
    await ElMessageBox.confirm(
      '重新生成将使已发出但未处理的审批卡片链接失效，确定吗？',
      '重新生成密钥',
      { type: 'warning', confirmButtonText: '重新生成', cancelButtonText: '取消' },
    )
    return true
  } catch {
    return false
  }
}

// CFG-3 (card-config lock §3.3): generate button never sends a secret — it only asks the
// backend to generate+store one (encrypted) and returns presence booleans, never the value.
async function generateApprovalCardLinkSecret() {
  const integration = selectedIntegration.value
  if (!integration) {
    setStatus('请先选择或创建钉钉目录集成', 'error')
    return
  }
  if (integration.config.approvalCardLinkSecretConfigured && !(await confirmApprovalCardSecretRegenerate())) {
    return
  }
  approvalCardBusy.value = true
  try {
    const response = await apiFetch(`/api/admin/directory/integrations/${integration.id}/approval-card-config/secret/generate`, {
      method: 'POST',
    })
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '生成一键卡片密钥失败'))
    setStatus('已生成新的一键卡片密钥')
    await loadIntegrations()
    await selectIntegration(integration.id)
    approvalCardLinkSecretEnvOverrideActive.value = body?.data?.status?.linkSecret?.envOverrideActive === true
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '生成一键卡片密钥失败', 'error')
  } finally {
    approvalCardBusy.value = false
  }
}

function buildApprovalCardConfigPayload() {
  return {
    publicAppUrl: draft.approvalCardPublicAppUrl.trim(),
  }
}

async function saveApprovalCardPublicAppUrl() {
  const integration = selectedIntegration.value
  if (!integration) {
    setStatus('请先选择或创建钉钉目录集成', 'error')
    return
  }
  approvalCardBusy.value = true
  try {
    const response = await apiFetch(`/api/admin/directory/integrations/${integration.id}/approval-card-config`, {
      method: 'PUT',
      body: JSON.stringify(buildApprovalCardConfigPayload()),
    })
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '保存一键卡片对外访问地址失败'))
    const currentIntegrationId = integration.id
    setStatus('一键卡片对外访问地址已保存')
    await loadIntegrations()
    await selectIntegration(currentIntegrationId)
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '保存一键卡片对外访问地址失败', 'error')
  } finally {
    approvalCardBusy.value = false
  }
}

async function syncIntegration() {
  if (!selectedIntegration.value) return
  busy.value = true
  try {
    clearAutoAdmissionOnboardingPackets()
    const response = await apiFetch(`/api/admin/directory/integrations/${selectedIntegration.value.id}/sync`, {
      method: 'POST',
    })
    const body = await readJson(response)
    if (!response.ok) {
      // DT-HARDEN-05 / #4049: another sync already holds the lease — benign, show the
      // active run instead of a generic failure.
      if (readApiErrorCode(body) === 'DIRECTORY_SYNC_IN_PROGRESS') {
        setStatus(buildSyncInProgressMessage(body), 'error')
        return
      }
      throw new Error(readApiError(body, '目录同步失败'))
    }
    autoAdmissionOnboardingPackets.value = readAutoAdmissionOnboardingPackets(body?.data as Record<string, unknown> | undefined)
    const autoAdmittedCount = Number(body?.data?.run?.stats?.autoAdmittedCount ?? 0)
    const autoAdmittedNoEmailCount = Number(body?.data?.run?.stats?.autoAdmittedNoEmailCount ?? 0)
    const autoAdmissionSkippedMissingEmailCount = Number(body?.data?.run?.stats?.autoAdmissionSkippedMissingEmailCount ?? 0)
    const autoAdmissionExcludedCount = Number(body?.data?.run?.stats?.autoAdmissionExcludedCount ?? 0)
    const memberGroupsSyncedCount = Number(body?.data?.run?.stats?.memberGroupsSyncedCount ?? 0)
    const memberGroupsCreatedCount = Number(body?.data?.run?.stats?.memberGroupsCreatedCount ?? 0)
    const memberGroupGovernedUserCount = Number(body?.data?.run?.stats?.memberGroupGovernedUserCount ?? 0)
    const memberGroupDefaultRoleAssignmentsCount = Number(body?.data?.run?.stats?.memberGroupDefaultRoleAssignmentsCount ?? 0)
    const memberGroupDefaultNamespaceAdmissionsCount = Number(body?.data?.run?.stats?.memberGroupDefaultNamespaceAdmissionsCount ?? 0)
    if (
      autoAdmittedCount > 0
      || autoAdmittedNoEmailCount > 0
      || autoAdmissionSkippedMissingEmailCount > 0
      || autoAdmissionExcludedCount > 0
      || memberGroupsSyncedCount > 0
      || memberGroupGovernedUserCount > 0
    ) {
      const parts = ['目录同步已完成']
      if (autoAdmittedCount > 0) parts.push(`自动准入 ${autoAdmittedCount} 位成员`)
      if (autoAdmittedNoEmailCount > 0) parts.push(`其中 ${autoAdmittedNoEmailCount} 位成员无邮箱，已生成平台登录账号和临时密码`)
      if (autoAdmissionSkippedMissingEmailCount > 0) parts.push(`${autoAdmissionSkippedMissingEmailCount} 位成员因缺少邮箱未自动创建`)
      if (autoAdmissionExcludedCount > 0) parts.push(`${autoAdmissionExcludedCount} 位成员命中排除部门，未自动创建`)
      if (memberGroupsSyncedCount > 0) {
        if (memberGroupsCreatedCount > 0) {
          parts.push(`同步 ${memberGroupsSyncedCount} 个成员组（新建 ${memberGroupsCreatedCount} 个）`)
        } else {
          parts.push(`同步 ${memberGroupsSyncedCount} 个成员组`)
        }
      }
      if (memberGroupGovernedUserCount > 0) {
        const governanceDetails: string[] = []
        if (memberGroupDefaultRoleAssignmentsCount > 0) governanceDetails.push(`角色新增 ${memberGroupDefaultRoleAssignmentsCount} 项`)
        if (memberGroupDefaultNamespaceAdmissionsCount > 0) governanceDetails.push(`插件开通新增 ${memberGroupDefaultNamespaceAdmissionsCount} 项`)
        parts.push(
          governanceDetails.length > 0
            ? `为 ${memberGroupGovernedUserCount} 位成员补齐默认治理（${governanceDetails.join('，')}）`
            : `为 ${memberGroupGovernedUserCount} 位成员补齐默认治理`,
        )
      }
      setStatus(parts.join('，'))
    } else {
      setStatus('目录同步已完成')
    }
    await refreshAfterDirectorySync(selectedIntegration.value.id)
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '目录同步失败', 'error')
  } finally {
    busy.value = false
  }
}

/** The post-sync panel refresh both the synchronous and the background (polled) path share. */
async function refreshAfterDirectorySync(integrationId: string): Promise<void> {
  await Promise.all([
    loadIntegrations(),
    loadRuns(integrationId),
    loadScheduleSnapshot(integrationId),
    loadAlerts(integrationId),
    loadReviewItems(integrationId),
    loadAccounts(integrationId),
    departmentsLoaded.value ? loadDepartments(integrationId, { force: true }) : Promise.resolve(),
  ])
}

function readActiveRunId(payload: unknown): string {
  const error = payload && typeof payload === 'object'
    ? (payload as { error?: { details?: unknown } }).error
    : undefined
  const details = error && typeof error === 'object' ? error.details : undefined
  const activeRunId = details && typeof details === 'object'
    ? (details as { activeRunId?: unknown }).activeRunId
    : undefined
  return typeof activeRunId === 'string' ? activeRunId : ''
}

/** #4049: 409 DIRECTORY_SYNC_IN_PROGRESS carries details.activeRunId — surface it, not a generic error. */
function buildSyncInProgressMessage(payload: unknown): string {
  const activeRunId = readActiveRunId(payload)
  return activeRunId ? `已有同步在进行中（运行 ${activeRunId}）` : '已有同步在进行中'
}

// DT-OPS-02 dry-run preview: read-only, but it performs a FULL DingTalk directory pull —
// hence its own busy flag and the same 409 lease refusal handling as the sync triggers.
async function previewSync() {
  const integration = selectedIntegration.value
  if (!integration) return
  previewBusy.value = true
  try {
    const response = await apiFetch(`/api/admin/directory/integrations/${integration.id}/sync/preview`, {
      method: 'POST',
    })
    const body = await readJson(response)
    if (!response.ok) {
      if (readApiErrorCode(body) === 'DIRECTORY_SYNC_IN_PROGRESS') {
        setStatus(buildSyncInProgressMessage(body), 'error')
        return
      }
      throw new Error(readApiError(body, '同步预览失败'))
    }
    const preview = (body?.data?.preview ?? null) as DirectorySyncPreview | null
    if (!preview) throw new Error('同步预览未返回结果')
    previewResult.value = preview
    setStatus('同步预览已生成（未写入任何数据）')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '同步预览失败', 'error')
  } finally {
    previewBusy.value = false
  }
}

function formatPreviewSample(entries: Array<{ externalUserId: string; name: string }>, total: number): string {
  if (entries.length === 0) return '无'
  const summary = entries.map((entry) => `${entry.name} (${entry.externalUserId})`).join('，')
  return total > entries.length ? `${summary} 等 ${total} 人` : summary
}

function formatPreviewDeactivationSample(
  entries: Array<{ externalUserId: string; name: string; linked: boolean }>,
  total: number,
): string {
  if (entries.length === 0) return '无'
  const summary = entries
    .map((entry) => `${entry.name} (${entry.externalUserId}${entry.linked ? '，已绑定本地用户' : ''})`)
    .join('，')
  return total > entries.length ? `${summary} 等 ${total} 人` : summary
}

// MAIN-LOOP-RATIFIED FAIL-SAFE: async mode discards the one-time temp-password onboarding
// packets (the backend never persists them — a 202 cannot carry them). When auto-admission
// is enabled the admin must explicitly acknowledge that before a background sync runs.
async function confirmAsyncSyncDiscardsOnboardingPackets(): Promise<boolean> {
  try {
    await ElMessageBox.confirm(
      '后台同步不会返回一次性临时密码入职凭据：这些凭据从不持久化，异步模式下会被直接丢弃且无法找回。当前集成已开启自动准入，如本次同步可能为新成员创建账号，建议改用「手动同步」（同步模式）以获取临时凭据。确定继续后台同步吗？',
      '后台同步将丢弃临时凭据',
      { type: 'warning', confirmButtonText: '仍然后台同步', cancelButtonText: '取消' },
    )
    return true
  } catch {
    return false
  }
}

function stopRunPolling(): void {
  if (runPollTimer) {
    clearTimeout(runPollTimer)
    runPollTimer = null
  }
  // Invalidate any in-flight poll continuation (checked after every await in pollAsyncRun).
  runPollToken += 1
  pollingRunId.value = ''
  pollingIntegrationId = ''
}

const DIRECTORY_RUN_POLL_INTERVAL_MS = 5000
// P3 hardening: a crashed worker (scheduler disabled) leaves the run row 'running' forever, and
// this tab locks its own sync/preview buttons on pollingRunId — the very actions that would
// reclaim the lease. Bound the poll so the tab gives up and unlocks instead of hammering /runs
// indefinitely; the run itself is untouched server-side.
const DIRECTORY_RUN_POLL_MAX_DURATION_MS = 10 * 60 * 1000
let runPollStartedAtMs = 0

async function pollAsyncRun(integrationId: string, runId: string, token: number): Promise<void> {
  let body: unknown = null
  let responseOk = false
  try {
    const response = await apiFetch(`/api/admin/directory/integrations/${integrationId}/runs?page=1&pageSize=10`)
    body = await readJson(response)
    responseOk = response.ok
  } catch {
    responseOk = false
  }
  if (token !== runPollToken) return
  if (!responseOk) {
    stopRunPolling()
    setStatus(readApiError(body, '后台同步状态查询失败，已停止轮询，请手动刷新运行记录'), 'error')
    return
  }
  const data = (body as { data?: { items?: unknown } } | null)?.data
  const items = data && Array.isArray(data.items) ? (data.items as DirectoryRun[]) : []
  // Keep the 运行记录 panel live while polling — it is the run-status surface.
  runs.value = items
  const run = items.find((item) => item.id === runId)
  if (run && run.status !== 'running') {
    stopRunPolling()
    // DISPLAY TRUTH (B1 rework): the success summary is an ALLOWLIST — reachable only by an
    // explicit 'completed'. Every other terminal value, including ones this build has never
    // heard of, must fall through to the fail-safe `else` and say the sync did NOT complete.
    // Blocklisting the known-bad states instead ("not running, not failed, no errorMessage
    // ⇒ 完成") is exactly how the deliberate 'aborted' state rendered as SUCCESS: the admin
    // is not going to retry on their own, and the message never corrects itself.
    if (run.status === 'failed' || run.errorMessage) {
      setStatus(`后台同步失败（运行 ${runId}）：${run.errorMessage || '未知错误'}`, 'error')
    } else if (run.status === 'aborted') {
      // 'aborted' is written by exactly one backend path — markSyncAbortedByFreeze, i.e. the
      // apply-time recheck found an active org transfer and rolled the apply back (deliberate
      // state, no alert, error_message stays NULL). The reason lives in the run's `meta`, which
      // this runs payload does not carry, so the wording is derived from the status alone.
      setStatus(
        `后台同步已中止（运行 ${runId}）：该集成的来源正被进行中的组织迁移冻结，本次同步未写入任何数据。请先完成或取消该迁移，然后重新发起同步。`,
        'error',
      )
    } else if (run.status === 'completed') {
      setStatus(buildAsyncRunSummary(run))
    } else {
      setStatus(
        `后台同步以未识别的终态结束（运行 ${runId}，状态 ${run.status}），无法确认是否成功，请前往下方运行记录核对后再决定是否重试。`,
        'error',
      )
    }
    await refreshAfterDirectorySync(integrationId)
    return
  }
  if (Date.now() - runPollStartedAtMs >= DIRECTORY_RUN_POLL_MAX_DURATION_MS) {
    stopRunPolling()
    setStatus('已停止自动轮询（超过 10 分钟），运行可能仍在进行，请前往下方运行记录手动刷新查看最新状态', 'error')
    return
  }
  // Still running — or paged out of the first page (>10 newer runs between polls; the run is
  // still live, keep polling rather than fail). Reschedule exactly one next tick.
  runPollTimer = setTimeout(() => {
    runPollTimer = null
    void pollAsyncRun(integrationId, runId, token)
  }, DIRECTORY_RUN_POLL_INTERVAL_MS)
}

function buildAsyncRunSummary(run: DirectoryRun): string {
  const stats = run.stats ?? {}
  const parts = [`后台同步已完成（运行 ${run.id}）`]
  parts.push(
    `账号 ${readNumericStat(stats, 'accountsSynced')} / 部门 ${readNumericStat(stats, 'departmentsSynced')} / 待确认 ${readNumericStat(stats, 'pendingCount')} / 已链接 ${readNumericStat(stats, 'linkedCount')}`,
  )
  if (hasRunStat(stats, 'accountsCreatedCount') || hasRunStat(stats, 'accountsUpdatedCount')) {
    parts.push(
      `本次新增账号 ${readNumericStat(stats, 'accountsCreatedCount')}，更新 ${readNumericStat(stats, 'accountsUpdatedCount')}，停用 ${readNumericStat(stats, 'accountsDeactivatedCount')}`,
    )
  }
  const autoAdmittedCount = readNumericStat(stats, 'autoAdmittedCount')
  if (autoAdmittedCount > 0) {
    parts.push(`自动准入 ${autoAdmittedCount} 位成员（后台同步不返回一次性临时凭据）`)
  }
  return parts.join('，')
}

async function startAsyncSync() {
  const integration = selectedIntegration.value
  if (!integration) return
  if (pollingRunId.value) return
  if (
    integration.config.admissionMode === 'auto_for_scoped_departments'
    && !(await confirmAsyncSyncDiscardsOnboardingPackets())
  ) {
    return
  }
  asyncSyncBusy.value = true
  try {
    const response = await apiFetch(`/api/admin/directory/integrations/${integration.id}/sync`, {
      method: 'POST',
      body: JSON.stringify({ async: true }),
    })
    const body = await readJson(response)
    if (!response.ok) {
      if (readApiErrorCode(body) === 'DIRECTORY_SYNC_IN_PROGRESS') {
        setStatus(buildSyncInProgressMessage(body), 'error')
        return
      }
      throw new Error(readApiError(body, '启动后台同步失败'))
    }
    const runId = typeof body?.data?.runId === 'string' ? body.data.runId : ''
    if (!runId) throw new Error('后台同步已受理，但未返回运行 ID')
    stopRunPolling()
    pollingRunId.value = runId
    pollingIntegrationId = integration.id
    runPollStartedAtMs = Date.now()
    const token = runPollToken
    setStatus(`后台同步已启动（运行 ${runId}），正在轮询运行状态...`)
    void pollAsyncRun(integration.id, runId, token)
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '启动后台同步失败', 'error')
  } finally {
    asyncSyncBusy.value = false
  }
}

async function searchAccounts() {
  if (!selectedIntegration.value) return
  clearFocusedAccount()
  accountPage.value = 1
  await loadAccounts(selectedIntegration.value.id)
}

async function changeAccountPage(nextPage: number) {
  if (!selectedIntegration.value) return
  const normalizedPage = Math.max(1, Math.min(nextPage, accountPageCount.value))
  if (normalizedPage === accountPage.value) return
  clearFocusedAccount()
  accountPage.value = normalizedPage
  await loadAccounts(selectedIntegration.value.id)
}

async function updateAccountPageSize(event: Event) {
  if (!selectedIntegration.value) return
  const target = event.target
  const nextPageSize = Number(target instanceof HTMLSelectElement ? target.value : accountPageSize.value)
  if (!Number.isFinite(nextPageSize) || nextPageSize <= 0 || nextPageSize === accountPageSize.value) return
  clearFocusedAccount()
  accountPageSize.value = nextPageSize
  accountPage.value = 1
  await loadAccounts(selectedIntegration.value.id)
}

async function scrollFocusedAccountIntoView() {
  await nextTick()
  const section = accountsSectionRef.value
  const focusedAccountElement = section?.querySelector('.directory-admin__account--focused')
  if (focusedAccountElement instanceof HTMLElement) {
    focusedAccountElement.scrollIntoView({ behavior: 'smooth', block: 'start' })
    return
  }
  if (section instanceof HTMLElement) {
    section.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
}

async function loadAccounts(integrationId: string) {
  if (selectedIntegrationId.value !== integrationId) return
  const version = ++accountLoadVersion
  loadingAccounts.value = true
  accountsLoadFailed.value = false
  try {
    const params = new URLSearchParams({
      page: String(accountPage.value),
      pageSize: String(accountPageSize.value),
    })
    if (accountQuery.value.trim().length > 0) {
      params.set('q', accountQuery.value.trim())
    }
    const response = await apiFetch(`/api/admin/directory/integrations/${integrationId}/accounts?${params.toString()}`)
    const body = await readJson(response)
    if (version !== accountLoadVersion || selectedIntegrationId.value !== integrationId) return
    if (!response.ok) throw new Error(readApiError(body, '加载目录成员失败'))
    const items = Array.isArray(body?.data?.items) ? body.data.items : []
    const total = typeof body?.data?.total === 'number'
      ? body.data.total
      : Number(body?.data?.total ?? items.length)
    const normalizedTotal = Number.isFinite(total) && total >= 0 ? total : items.length
    const maxPage = Math.max(1, Math.ceil(normalizedTotal / accountPageSize.value))
    if (normalizedTotal > 0 && accountPage.value > maxPage) {
      accountPage.value = maxPage
      await loadAccounts(integrationId)
      return
    }
    accountTotal.value = normalizedTotal
    accounts.value = items
    accountSnapshotIntegrationId.value = integrationId
    if (pendingFocusedAccountScroll.value) {
      pendingFocusedAccountScroll.value = false
      await scrollFocusedAccountIntoView()
    }
  } catch (error) {
    if (version !== accountLoadVersion || selectedIntegrationId.value !== integrationId) return
    accountsLoadFailed.value = true
    accountSnapshotIntegrationId.value = ''
    accounts.value = []
    accountTotal.value = 0
    pendingFocusedAccountScroll.value = false
    setStatus(error instanceof Error ? error.message : '加载目录成员失败', 'error')
  } finally {
    if (version === accountLoadVersion && selectedIntegrationId.value === integrationId) loadingAccounts.value = false
  }
}

// Bumped whenever an in-flight department load must be ignored (integration switch, draft reset,
// or a newer load). DingTalk department ids repeat across corps, so a late response for
// integration A must never land in integration B's tree / pickers.
let departmentLoadToken = 0

function cancelPendingDepartmentLoad(): void {
  departmentLoadToken += 1
  loadingDepartments.value = false
}

async function loadDepartments(integrationId: string, options: { force?: boolean } = {}) {
  if (departmentsLoaded.value && options.force !== true) return
  const token = ++departmentLoadToken
  const isStale = () => token !== departmentLoadToken || selectedIntegrationId.value !== integrationId
  loadingDepartments.value = true
  departmentLoadError.value = ''
  try {
    const response = await apiFetch(`/api/admin/directory/integrations/${integrationId}/departments`)
    const body = await readJson(response)
    if (isStale()) return
    if (!response.ok) throw new Error(readApiError(body, '加载组织架构失败'))
    departments.value = Array.isArray(body?.data?.items) ? body.data.items : []
    departmentsLoaded.value = true
  } catch (error) {
    if (isStale()) return
    departments.value = []
    departmentsLoaded.value = true
    departmentLoadError.value = error instanceof Error ? error.message : '加载组织架构失败'
    setStatus(departmentLoadError.value, 'error')
  } finally {
    if (token === departmentLoadToken) loadingDepartments.value = false
  }
}

async function loadRuns(integrationId: string) {
  loadingRuns.value = true
  try {
    const response = await apiFetch(`/api/admin/directory/integrations/${integrationId}/runs?page=1&pageSize=10`)
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '加载同步记录失败'))
    runs.value = Array.isArray(body?.data?.items) ? body.data.items : []
  } catch (error) {
    runs.value = []
    setStatus(error instanceof Error ? error.message : '加载同步记录失败', 'error')
  } finally {
    loadingRuns.value = false
  }
}

async function loadScheduleSnapshot(integrationId: string) {
  if (selectedIntegrationId.value !== integrationId) return
  const version = ++scheduleLoadVersion
  loadingSchedule.value = true
  scheduleLoadFailed.value = false
  try {
    const response = await apiFetch(`/api/admin/directory/integrations/${integrationId}/schedule`)
    const body = await readJson(response)
    if (version !== scheduleLoadVersion || selectedIntegrationId.value !== integrationId) return
    if (!response.ok) throw new Error(readApiError(body, '加载自动同步观测失败'))
    scheduleSnapshot.value = body?.data?.snapshot ?? null
  } catch (error) {
    if (version !== scheduleLoadVersion || selectedIntegrationId.value !== integrationId) return
    scheduleLoadFailed.value = true
    scheduleSnapshot.value = null
    setStatus(error instanceof Error ? error.message : '加载自动同步观测失败', 'error')
  } finally {
    if (version === scheduleLoadVersion && selectedIntegrationId.value === integrationId) loadingSchedule.value = false
  }
}

async function loadAlerts(integrationId: string) {
  if (selectedIntegrationId.value !== integrationId) return
  const version = ++alertLoadVersion
  loadingAlerts.value = true
  alertsLoadFailed.value = false
  try {
    const params = new URLSearchParams({ page: '1', pageSize: '20', filter: 'all' })
    const response = await apiFetch(`/api/admin/directory/integrations/${integrationId}/alerts?${params.toString()}`)
    const body = await readJson(response)
    if (version !== alertLoadVersion || selectedIntegrationId.value !== integrationId) return
    if (!response.ok) throw new Error(readApiError(body, '加载最近告警失败'))
    alerts.value = Array.isArray(body?.data?.items) ? body.data.items : []
    alertSnapshotIntegrationId.value = integrationId
  } catch (error) {
    if (version !== alertLoadVersion || selectedIntegrationId.value !== integrationId) return
    alertsLoadFailed.value = true
    alertSnapshotIntegrationId.value = ''
    alerts.value = []
    setStatus(error instanceof Error ? error.message : '加载最近告警失败', 'error')
  } finally {
    if (version === alertLoadVersion && selectedIntegrationId.value === integrationId) loadingAlerts.value = false
  }
}

function normalizeReviewItems(items: unknown[]): DirectoryReviewItem[] {
  return items.map((item) => {
    const raw = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    const recommendationStatusRaw = raw.recommendationStatus && typeof raw.recommendationStatus === 'object'
      ? raw.recommendationStatus as Record<string, unknown>
      : null
    const actionableRaw = raw.actionable && typeof raw.actionable === 'object'
      ? raw.actionable as Record<string, unknown>
      : null

    return {
      ...raw,
      recommendations: Array.isArray(raw.recommendations) ? raw.recommendations as DirectoryBindingRecommendation[] : [],
      recommendationStatus: recommendationStatusRaw
        ? {
          code: typeof recommendationStatusRaw.code === 'string' ? recommendationStatusRaw.code as DirectoryBindingRecommendationStatusCode : 'no_exact_match',
          message: typeof recommendationStatusRaw.message === 'string'
            ? recommendationStatusRaw.message
            : '未命中唯一的邮箱或手机号精确匹配，请人工搜索本地用户。',
        }
        : null,
      actionable: {
        canBatchUnbind: actionableRaw?.canBatchUnbind === true,
        canConfirmRecommendation: actionableRaw?.canConfirmRecommendation === true,
      },
    } as DirectoryReviewItem
  })
}

function mergeReviewItems(existingItems: DirectoryReviewItem[], incomingItems: DirectoryReviewItem[]): DirectoryReviewItem[] {
  if (existingItems.length === 0) return incomingItems
  const merged = [...existingItems]
  const indexByAccountId = new Map(existingItems.map((item, index) => [item.account.id, index]))
  for (const item of incomingItems) {
    const existingIndex = indexByAccountId.get(item.account.id)
    if (typeof existingIndex === 'number') {
      merged[existingIndex] = item
      continue
    }
    indexByAccountId.set(item.account.id, merged.length)
    merged.push(item)
  }
  return merged
}

async function loadReviewItems(integrationId: string, options: { append?: boolean } = {}) {
  const append = options.append === true
  if (append) loadingMoreReviewItems.value = true
  else loadingReviewItems.value = true
  try {
    const nextPage = append ? reviewPage.value + 1 : 1
    const response = await apiFetch(`/api/admin/directory/integrations/${integrationId}/review-items?page=${nextPage}&pageSize=${reviewPageSize}&filter=all`)
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '加载待处理队列失败'))
    const items = Array.isArray(body?.data?.items) ? body.data.items : []
    const total = typeof body?.data?.total === 'number'
      ? body.data.total
      : Number(body?.data?.total ?? items.length)
    const normalizedTotal = Number.isFinite(total) && total >= 0 ? total : items.length
    const normalizedItems = normalizeReviewItems(items)
    reviewItems.value = append
      ? mergeReviewItems(reviewItems.value, normalizedItems)
      : normalizedItems
    reviewTotal.value = normalizedTotal
    if (!append) reviewPage.value = 1
    else if (normalizedItems.length > 0) reviewPage.value = nextPage
    const validIds = new Set(reviewItems.value.map((item) => item.account.id))
    for (const key of Object.keys(selectedReviewIds)) {
      if (!validIds.has(key)) delete selectedReviewIds[key]
    }
    syncPendingBindingQueueDefaults()
  } catch (error) {
    if (!append) {
      reviewItems.value = []
      reviewPage.value = 1
      reviewTotal.value = 0
      for (const key of Object.keys(selectedReviewIds)) delete selectedReviewIds[key]
    }
    setStatus(error instanceof Error ? error.message : '加载待处理队列失败', 'error')
  } finally {
    if (append) loadingMoreReviewItems.value = false
    else loadingReviewItems.value = false
  }
}

async function updateAlertFilter(value: DirectoryAlertFilter) {
  alertFilter.value = value
}

async function updateReviewFilter(value: DirectoryReviewItemFilter) {
  reviewFilter.value = value
}

function updatePendingBindingView(value: PendingBindingView) {
  pendingBindingView.value = value
  pendingBindingViewTouched.value = true
  if (value !== 'manual') pendingBindingManualReason.value = 'all'
}

function updatePendingBindingManualReason(value: PendingBindingManualReasonFilter) {
  pendingBindingManualReason.value = value
}

function syncPendingBindingQueueDefaults() {
  if (reviewCounts.value.pending_binding === 0) {
    pendingBindingView.value = 'all'
    pendingBindingViewTouched.value = false
    pendingBindingManualReason.value = 'all'
    clearReviewSelection()
    return
  }

  const recommendedAvailable = pendingBindingCounts.value.recommended > 0
  const manualAvailable = pendingBindingCounts.value.manual > 0

  const currentViewInvalid = (
    (pendingBindingView.value === 'recommended' && !recommendedAvailable)
    || (pendingBindingView.value === 'manual' && !manualAvailable)
  )

  if (!pendingBindingViewTouched.value || currentViewInvalid) {
    if (recommendedAvailable) pendingBindingView.value = 'recommended'
    else if (manualAvailable) pendingBindingView.value = 'manual'
    else pendingBindingView.value = 'all'
    pendingBindingViewTouched.value = false
  }

  if (!manualAvailable || pendingBindingView.value !== 'manual') {
    pendingBindingManualReason.value = 'all'
  } else if (
    pendingBindingManualReason.value !== 'all'
    && pendingBindingManualReasonCounts.value[pendingBindingManualReason.value] === 0
  ) {
    pendingBindingManualReason.value = 'all'
  }

  const hasSelection = Object.keys(selectedReviewIds).length > 0
  if (!hasSelection && pendingBindingView.value === 'recommended' && selectableVisibleRecommendedReviewIds.value.length > 0) {
    selectVisibleRecommendedReviewItems()
  }
}

async function loadMoreReviewItems() {
  if (!selectedIntegration.value || !hasMoreReviewItems.value || loadingMoreReviewItems.value) return
  await loadReviewItems(selectedIntegration.value.id, { append: true })
}

function clearReviewBatchProgress() {
  reviewBatchProgress.value = null
}

function readReviewBatchProgressKindLabel(kind: ReviewBatchProgressKind): string {
  if (kind === 'recommend') return '推荐绑定确认'
  if (kind === 'admit') return '批量创建并绑定'
  if (kind === 'unbind') return '批量停权处理'
  return '批量绑定'
}

function readReviewBatchProgressPhaseLabel(phase: ReviewBatchProgressPhase): string {
  if (phase === 'submitting') return '提交中'
  if (phase === 'refreshing') return '刷新中'
  if (phase === 'completed') return '已完成'
  return '失败'
}

function readReviewBatchProgressPhaseClass(phase: ReviewBatchProgressPhase): string {
  if (phase === 'completed') return 'directory-admin__chip--success'
  if (phase === 'failed') return 'directory-admin__chip--danger'
  return 'directory-admin__chip--warning'
}

function setReviewBatchProgress(progress: ReviewBatchProgress) {
  reviewBatchProgress.value = progress
}

function readPendingBindingManualReasonCode(item: DirectoryReviewItem): PendingBindingManualReasonFilter {
  if (item.kind !== 'pending_binding' || item.actionable.canConfirmRecommendation) return 'all'
  const code = item.recommendationStatus?.code ?? 'no_exact_match'
  return code === 'no_exact_match' ? 'no_exact_match' : 'conflict'
}

function matchesPendingBindingView(item: DirectoryReviewItem): boolean {
  if (pendingBindingView.value === 'all') return true
  if (pendingBindingView.value === 'recommended') return item.actionable.canConfirmRecommendation
  if (item.actionable.canConfirmRecommendation) return false
  if (pendingBindingManualReason.value === 'all') return true
  return readPendingBindingManualReasonCode(item) === pendingBindingManualReason.value
}

async function acknowledgeAlert(alert: DirectorySyncAlert) {
  if (!selectedIntegration.value || alert.acknowledgedAt) return
  acknowledgingAlertId.value = alert.id
  try {
    const response = await apiFetch(`/api/admin/directory/alerts/${alert.id}/ack`, {
      method: 'POST',
    })
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '确认告警失败'))
    await loadAlerts(selectedIntegration.value.id)
    setStatus('目录告警已确认')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '确认告警失败', 'error')
  } finally {
    acknowledgingAlertId.value = ''
  }
}

async function bindAccount(account: DirectoryAccount) {
  bindingAccountId.value = account.id
  try {
    const response = await apiFetch(`/api/admin/directory/accounts/${account.id}/bind`, {
      method: 'POST',
      body: JSON.stringify({
        localUserRef: readBindingDraft(account).trim(),
        enableDingTalkGrant: readAccountGrantToggle(account),
      }),
    })
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '绑定目录成员失败'))

    const boundAccount = body?.data?.account as DirectoryAccount | undefined
    if (boundAccount) {
      accounts.value = accounts.value.map((item) => (item.id === boundAccount.id ? boundAccount : item))
      bindingDrafts[account.id] = describeLocalUserIdentifier(boundAccount.localUser) || readBindingDraft(account)
    }

    setStatus(`目录成员 ${account.name} 已绑定到本地用户`)
    if (selectedIntegration.value) {
      await loadIntegrations()
      await loadReviewItems(selectedIntegration.value.id)
      await loadAccounts(selectedIntegration.value.id)
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '绑定目录成员失败', 'error')
  } finally {
    bindingAccountId.value = ''
  }
}

async function unbindAccount(account: DirectoryAccount, options: {
  disableDingTalkGrant?: boolean
  successMessage?: string
} = {}) {
  if (unbindingAccountId.value) {
    setStatus('已有解绑操作正在处理，请稍后再试')
    return
  }
  const contextVersion = directoryContextVersion
  const integrationId = selectedIntegrationId.value
  const accountId = account.id
  const disableDingTalkGrant = options.disableDingTalkGrant === true
  unbindingAccountId.value = accountId
  try {
    if (!(await confirmDirectoryUnbind(1))) return
    if (!isCurrentUnbindContext(contextVersion, integrationId)) return
    const response = await apiFetch(`/api/admin/directory/accounts/${accountId}/unbind`, {
      method: 'POST',
      body: JSON.stringify({
        disableDingTalkGrant,
      }),
    })
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '解除绑定失败'))

    const unboundAccount = body?.data?.account as DirectoryAccount | undefined
    accounts.value = accounts.value.map((item) => {
      if (item.id !== accountId) return item
      if (unboundAccount) return unboundAccount
      return {
        ...item,
        linkStatus: 'unmatched',
        matchStrategy: 'manual_unbound',
        localUser: null,
      }
    })
    delete bindingDrafts[accountId]
    clearBindingSearch(accountId)
    setStatus(options.successMessage ?? `目录成员 ${account.name} 已解除绑定`)
    if (selectedIntegration.value) {
      await loadIntegrations()
      await loadReviewItems(selectedIntegration.value.id)
      await loadAccounts(selectedIntegration.value.id)
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '解除绑定失败', 'error')
  } finally {
    unbindingAccountId.value = ''
  }
}

async function confirmDirectoryUnbind(count: number): Promise<boolean> {
  try {
    await ElMessageBox.confirm(
      `${count > 1 ? `将解除所选 ${count} 个目录成员的绑定。` : ''}将删除对应人员的钉钉登录身份；如果此人在该组织没有其他有效关联，还会停用其组织成员身份。已登录的会话不会被结束。`,
      '确认解除绑定',
      { type: 'warning', confirmButtonText: '确认解除绑定', cancelButtonText: '取消' },
    )
    return true
  } catch {
    return false
  }
}

function isCurrentUnbindContext(version: number, integrationId: string): boolean {
  if (!directoryViewActive) return false
  if (directoryContextVersion === version && selectedIntegrationId.value === integrationId) return true
  setStatus('操作未提交：页面上下文已变化，请重新选择成员后确认。', 'error')
  return false
}

function updateReviewSelection(accountId: string, checked: boolean) {
  if (checked) selectedReviewIds[accountId] = true
  else delete selectedReviewIds[accountId]
}

function clearReviewSelection() {
  for (const key of Object.keys(selectedReviewIds)) delete selectedReviewIds[key]
}

function selectVisibleReviewItems() {
  clearReviewSelection()
  for (const accountId of selectableVisibleReviewIds.value) {
    selectedReviewIds[accountId] = true
  }
}

function selectVisibleRecommendedReviewItems() {
  clearReviewSelection()
  for (const accountId of selectableVisibleRecommendedReviewIds.value) {
    selectedReviewIds[accountId] = true
  }
}

function onReviewSelectionChange(accountId: string, event: Event) {
  const target = event.target
  updateReviewSelection(accountId, target instanceof HTMLInputElement ? target.checked : false)
}

function focusReviewAccount(item: DirectoryReviewItem) {
  setDirectoryTab('accounts')
  accountStatusFilter.value = 'all'
  focusedAccountId.value = item.account.id
  pendingFocusedAccountScroll.value = true
  accountQuery.value = item.account.externalUserId
  if (selectedIntegration.value) {
    accountPage.value = 1
    void loadAccounts(selectedIntegration.value.id)
  }
}

async function applyInitialDirectoryNavigationBeforeLoads(integrationId: string): Promise<void> {
  const contextVersion = directoryContextVersion
  const isCurrentNavigation = () => directoryViewActive && contextVersion === directoryContextVersion && selectedIntegrationId.value === integrationId
  const navigation = directoryNavigation.value
  const navigationKey = buildDirectoryNavigationKey(navigation)
  if (navigationKey && appliedDirectoryNavigationKey.value === navigationKey) return
  const targetAccountId = navigation.accountId
  if (!targetAccountId) {
    appliedDirectoryNavigationKey.value = navigationKey
    return
  }
  if (navigation.integrationId && navigation.integrationId !== integrationId) return

  try {
    clearFocusedAccountNavigationState()
    const response = await apiFetch(`/api/admin/directory/accounts/${encodeURIComponent(targetAccountId)}`)
    const body = await readJson(response)
    if (!isCurrentNavigation()) return
    if (!response.ok) {
      const fallback = response.status === 404
        ? readDirectoryAccountMissingMessage(targetAccountId)
        : '定位目录成员失败'
      throw new Error(readApiError(body, fallback))
    }
    const account = body?.data?.account as DirectoryAccount | undefined
    if (!account) throw new Error(readDirectoryAccountMissingMessage(targetAccountId))
    clearRouteNavigationFailureNotice()
    accountStatusFilter.value = 'all'
    focusedAccountId.value = account.id
    pendingFocusedAccountScroll.value = true
    accountQuery.value = account.externalUserId
    accountPage.value = 1
    if (navigation.source === 'user-management') {
      setStatus(`已从用户管理定位到目录成员 ${account.name}`)
    }
  } catch (error) {
    if (!isCurrentNavigation()) return
    const message = error instanceof Error ? error.message : '定位目录成员失败'
    setStatus(message, 'error')
    setRouteNavigationFailureNotice({
      kind: 'missing_account',
      message,
      targetIntegrationId: navigation.integrationId || integrationId,
      targetAccountId,
      currentIntegrationName: selectedIntegration.value?.name ?? '',
    })
  } finally {
    if (isCurrentNavigation()) appliedDirectoryNavigationKey.value = navigationKey
  }
}

async function handleDirectoryNavigationChange(): Promise<void> {
  const navigation = directoryNavigation.value
  const navigationKey = buildDirectoryNavigationKey(navigation)
  if (!navigation.accountId) {
    clearRouteNavigationFailureNotice()
    appliedDirectoryNavigationKey.value = navigationKey
    return
  }
  if (navigationKey && appliedDirectoryNavigationKey.value === navigationKey) return

  const targetIntegrationId = navigation.integrationId || selectedIntegrationId.value || integrations.value[0]?.id || ''
  if (!targetIntegrationId) return

  if (selectedIntegrationId.value !== targetIntegrationId) {
    const targetExists = integrations.value.some((item) => item.id === targetIntegrationId)
    if (targetExists) {
      await selectIntegration(targetIntegrationId)
      return
    }
    await loadIntegrations()
    return
  }

  await applyInitialDirectoryNavigationBeforeLoads(targetIntegrationId)
  await Promise.all([
    loadReviewItems(targetIntegrationId),
    loadAccounts(targetIntegrationId),
  ])
}

function buildUserManagementLocation(userId: string, account: Pick<DirectoryAccount, 'id' | 'integrationId'> & Partial<Pick<DirectoryAccount, 'grantOpenIdAvailable'>>): string {
  const params = new URLSearchParams()
  params.set('userId', userId)
  params.set('source', 'directory-sync')
  params.set('integrationId', account.integrationId)
  params.set('accountId', account.id)
  // only when the server said so: a bare {id, integrationId} (manual admission result) carries no verdict
  if (account.grantOpenIdAvailable === false) {
    params.set('filter', 'dingtalk-openid-missing')
  }
  return `/admin/users?${params.toString()}`
}

async function handleReviewUnbind(item: DirectoryReviewItem) {
  reviewProcessingAccountId.value = item.account.id
  try {
    await unbindAccount(item.account, {
      disableDingTalkGrant: reviewDisableDingTalkGrant.value,
      successMessage: `待处理成员 ${item.account.name} 已完成停权处理`,
    })
  } finally {
    reviewProcessingAccountId.value = ''
  }
}

interface ReviewBindingsOutcome {
  appliedCount: number
  failedCount: number
  failed: unknown[]
}

// Shared by the batch-bind, batch-admit-users and batch-unbind partial-failure toasts: all
// three server routes return `failed: [{ accountId, error }]` for per-item failures
// (DT-HARDEN-04). All call sites use the same limit so the toasts stay visually consistent.
const FAILED_BINDINGS_PREVIEW_LIMIT = 3

function readFailedBindingsPreview(failed: unknown[], limit: number): string {
  return failed
    .slice(0, limit)
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return ''
      const item = entry as Record<string, unknown>
      const accountId = typeof item.accountId === 'string' ? item.accountId : ''
      const error = typeof item.error === 'string' ? item.error : ''
      return [accountId, error].filter(Boolean).join(': ')
    })
    .filter(Boolean)
    .join('；')
}

async function postReviewBindings(bindings: Array<{
  accountId: string
  localUserRef: string
  enableDingTalkGrant: boolean
}>, failureMessage = '绑定目录成员失败'): Promise<ReviewBindingsOutcome> {
  if (!selectedIntegration.value || bindings.length === 0) {
    return { appliedCount: 0, failedCount: 0, failed: [] }
  }
  const response = await apiFetch('/api/admin/directory/accounts/batch-bind', {
    method: 'POST',
    body: JSON.stringify({ bindings }),
  })
  const body = await readJson(response)
  if (!response.ok) throw new Error(readApiError(body, failureMessage))
  const data = body?.data as Record<string, unknown> | undefined
  const processedItems = Array.isArray(data?.items) ? data.items : []
  return {
    appliedCount: Number(data?.updatedCount ?? processedItems.length),
    failedCount: Number(data?.failedCount ?? 0),
    failed: Array.isArray(data?.failed) ? data.failed : [],
  }
}

// Writes the outcome status, then reloads the integration, queue and member list. The status is
// set before the reload so a failed reload's own error status is not overwritten; a stale
// integrations-load flag clears the status when the reload starts, so the outcome is written back
// when the reload left the status empty.
async function refreshAfterReviewBindings(message: string, tone: 'info' | 'error' = 'info'): Promise<void> {
  setStatus(message, tone)
  if (!selectedIntegration.value) return
  for (const key of Object.keys(selectedReviewIds)) delete selectedReviewIds[key]
  await Promise.all([
    loadIntegrations(),
    loadReviewItems(selectedIntegration.value.id),
    loadAccounts(selectedIntegration.value.id),
  ])
  if (!status.value) setStatus(message, tone)
}

// After a partial batch failure, re-select the failed rows that are still in the reloaded queue and
// still eligible for the same action, so they can be retried. Committed rows are never re-selected,
// and the retry selection replaces whatever the reload pre-selected. The reload may switch to a view
// that hides these rows; `reveal` is only called when some of them are hidden.
function reselectFailedReviewRows(
  batchIds: string[],
  failedItems: unknown[],
  isEligible: (item: DirectoryReviewItem) => boolean,
  countSelectedVisible: () => number,
  reveal: () => void,
): void {
  const failedIds = new Set(failedItems.map((entry) => (
    entry && typeof entry === 'object' ? (entry as Record<string, unknown>).accountId : undefined
  )))
  const retryableIds = new Set(reviewItems.value.filter(isEligible).map((item) => item.account.id))
  const retryIds = batchIds.filter((accountId) => failedIds.has(accountId) && retryableIds.has(accountId))
  if (retryIds.length === 0) return
  clearReviewSelection()
  for (const accountId of retryIds) selectedReviewIds[accountId] = true
  if (countSelectedVisible() < retryIds.length) reveal()
}

function showPendingBindingView(view: PendingBindingView): void {
  if (reviewFilter.value !== 'all' && reviewFilter.value !== 'pending_binding') reviewFilter.value = 'pending_binding'
  updatePendingBindingView(view)
  // A manual-reason sub-filter could still hide the revealed rows, so show every manual reason.
  if (view === 'manual') pendingBindingManualReason.value = 'all'
}

async function submitReviewBindings(bindings: Array<{
  accountId: string
  localUserRef: string
  enableDingTalkGrant: boolean
}>, successMessage: string, failureMessage: string, progressKind?: ReviewBatchProgressKind) {
  if (!selectedIntegration.value || bindings.length === 0) return
  reviewBatchProcessing.value = true
  let appliedCount = 0
  try {
    if (progressKind) {
      setReviewBatchProgress({
        kind: progressKind,
        phase: 'submitting',
        total: bindings.length,
        applied: 0,
        message: `正在提交${readReviewBatchProgressKindLabel(progressKind)}请求...`,
      })
    }
    const outcome = await postReviewBindings(bindings, failureMessage)
    appliedCount = outcome.appliedCount
    if (progressKind) {
      setReviewBatchProgress({
        kind: progressKind,
        phase: 'refreshing',
        total: bindings.length,
        applied: appliedCount,
        message: `已提交 ${appliedCount} / ${bindings.length}，正在刷新目录成员与待处理队列...`,
      })
    }
    const failedPreview = readFailedBindingsPreview(outcome.failed, FAILED_BINDINGS_PREVIEW_LIMIT)
    const message = outcome.failedCount > 0
      ? `已绑定 ${appliedCount} 个目录成员，另有 ${outcome.failedCount} 个失败${failedPreview ? `：${failedPreview}` : '，请重试'}`
      : successMessage
    await refreshAfterReviewBindings(message, outcome.failedCount > 0 ? 'error' : 'info')
    const batchIds = bindings.map((binding) => binding.accountId)
    if (progressKind === 'bind') {
      reselectFailedReviewRows(
        batchIds,
        outcome.failed,
        (item) => item.kind === 'pending_binding' && item.account.isActive && readBindingDraft(item.account).trim().length > 0,
        () => selectedReviewBindEntries.value.length,
        () => showPendingBindingView('all'),
      )
    } else if (progressKind === 'recommend') {
      reselectFailedReviewRows(
        batchIds,
        outcome.failed,
        (item) => (
          item.kind === 'pending_binding'
          && item.account.isActive
          && item.actionable.canConfirmRecommendation
          && item.recommendations.length > 0
        ),
        () => selectedRecommendedReviewBindEntries.value.length,
        () => showPendingBindingView('recommended'),
      )
    }
    if (progressKind) {
      setReviewBatchProgress({
        kind: progressKind,
        phase: 'completed',
        total: bindings.length,
        applied: appliedCount,
        message,
      })
    }
  } catch (error) {
    if (progressKind) {
      setReviewBatchProgress({
        kind: progressKind,
        phase: 'failed',
        total: bindings.length,
        applied: appliedCount,
        message: error instanceof Error ? error.message : failureMessage,
      })
    }
    setStatus(error instanceof Error ? error.message : failureMessage, 'error')
  } finally {
    reviewBatchProcessing.value = false
  }
}

async function handleReviewBind(item: DirectoryReviewItem) {
  reviewProcessingAccountId.value = item.account.id
  try {
    await submitReviewBindings([{
      accountId: item.account.id,
      localUserRef: readBindingDraft(item.account).trim(),
      enableDingTalkGrant: readAccountGrantToggle(item.account),
    }], `待处理成员 ${item.account.name} 已完成快速绑定`, '快速绑定失败')
  } finally {
    reviewProcessingAccountId.value = ''
  }
}

async function backfillUserMobileAndBindReviewItem(item: DirectoryReviewItem) {
  const selectedUser = readSelectedBindingUser(item)
  const mobile = item.account.mobile?.trim()
  if (!selectedUser || !mobile) return
  if (hasSelectedBindingUserMobileConflict(item) && !isAwaitingMobileOverrideConfirmation(item.account.id)) {
    mobileOverrideConfirmations[item.account.id] = true
    setStatus(`待处理成员 ${item.account.name} 的平台手机号与目录手机号不一致，请再次确认后覆盖并绑定`, 'error')
    return
  }

  reviewProcessingAccountId.value = item.account.id
  try {
    delete mobileConflictHints[item.account.id]
    const profileResponse = await apiFetch(`/api/admin/users/${encodeURIComponent(selectedUser.id)}/profile`, {
      method: 'PATCH',
      body: JSON.stringify({
        mobile,
        expectedMobile: selectedUser.mobile ?? null,
      }),
    })
    const profileBody = await readJson(profileResponse)
    if (!profileResponse.ok) {
      if (readApiErrorCode(profileBody) === 'PROFILE_MOBILE_CONFLICT') {
        delete mobileOverrideConfirmations[item.account.id]
        delete selectedBindingUsers[item.account.id]
        await Promise.all([
          refreshSingleReviewItem(item.account.id),
          refreshSingleAccount(item.account.id),
        ])
        const refreshedItem = reviewItems.value.find((entry) => entry.account.id === item.account.id)
        const refreshedUser = refreshedItem ? readSelectedBindingUser(refreshedItem) : null
        mobileConflictHints[item.account.id] = refreshedUser?.mobile
          ? `待处理成员 ${item.account.name} 的平台手机号已更新为 ${refreshedUser.mobile}，请按最新差异重新确认。`
          : `待处理成员 ${item.account.name} 的平台手机号已被其他操作更新，请按最新差异重新确认。`
        setStatus(`待处理成员 ${item.account.name} 的平台手机号已被其他操作更新，请刷新后的最新差异为准`, 'error')
        return
      }
      throw new Error(readApiError(profileBody, '回填用户手机号失败'))
    }

    selectedBindingUsers[item.account.id] = {
      ...selectedUser,
      mobile,
    }
    delete mobileOverrideConfirmations[item.account.id]

    await submitReviewBindings([{
      accountId: item.account.id,
      localUserRef: selectedUser.id,
      enableDingTalkGrant: readAccountGrantToggle(item.account),
    }], `待处理成员 ${item.account.name} 已回填手机号并完成绑定`, '回填手机号并绑定失败')
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '回填手机号并绑定失败', 'error')
  } finally {
    reviewProcessingAccountId.value = ''
  }
}

async function createAndBindDirectoryAccountUser(account: DirectoryAccount, context: 'review' | 'account') {
  const memberLabel = context === 'review' ? '待处理成员' : '目录成员'
  const draft = readManualAdmissionDraft(account)
  const nextDraft: ManualAdmissionDraft = {
    name: draft.name.trim(),
    email: draft.email.trim(),
    username: draft.username.trim(),
    mobile: draft.mobile.trim(),
  }
  manualAdmissionDrafts[account.id] = nextDraft
  if (!nextDraft.name || (!nextDraft.email && !nextDraft.username && !nextDraft.mobile)) {
    setStatus(`${memberLabel} ${account.name} 的姓名必填，且邮箱、登录名、手机号至少填写一项`, 'error')
    return
  }

  if (context === 'review') reviewProcessingAccountId.value = account.id
  else bindingAccountId.value = account.id
  try {
    const response = await apiFetch(`/api/admin/directory/accounts/${encodeURIComponent(account.id)}/admit-user`, {
      method: 'POST',
      body: JSON.stringify({
        name: nextDraft.name,
        email: nextDraft.email || undefined,
        username: nextDraft.username || undefined,
        mobile: nextDraft.mobile || undefined,
        enableDingTalkGrant: readAccountGrantToggle(account),
      }),
    })
    const body = await readJson(response)
    if (!response.ok || body?.ok !== true) {
      // #6259: known input-rule codes render Chinese copy; anything else keeps the server message.
      throw new Error(describeDirectoryAdmissionError(body) ?? readApiError(body, '创建本地用户并绑定失败'))
    }
    const data = body?.data as Record<string, unknown> | undefined
    const createdUser = readCreatedLocalUserOption(data ?? {}, nextDraft)
    const temporaryPassword = typeof data?.temporaryPassword === 'string' ? data.temporaryPassword : ''
    const onboarding = data?.onboarding && typeof data.onboarding === 'object'
      ? data.onboarding as OnboardingPacket
      : null

    updateBindingDraft(account.id, describeLocalUserIdentifier(createdUser))
    selectedBindingUsers[account.id] = createdUser
    clearBindingSearch(account.id)
    delete mobileOverrideConfirmations[account.id]
    delete mobileConflictHints[account.id]
    delete manualAdmissionExpanded[account.id]
    delete manualAdmissionDrafts[account.id]
    await refreshAfterReviewBindings(`${memberLabel} ${account.name} 已创建本地用户并完成绑定`)
    manualAdmissionResult.value = {
      accountId: account.id,
      accountName: account.name,
      integrationId: account.integrationId,
      userId: createdUser.id,
      userName: createdUser.name || nextDraft.name,
      email: createdUser.email || nextDraft.email || null,
      username: createdUser.username || nextDraft.username || null,
      mobile: createdUser.mobile || nextDraft.mobile,
      temporaryPassword,
      onboarding,
      bound: true,
      bindError: '',
      mobileBackfilled: nextDraft.mobile.length === 0 || (createdUser.mobile ?? '') === nextDraft.mobile,
      mobileBackfillError: '',
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '创建本地用户并绑定失败', 'error')
  } finally {
    if (context === 'review') reviewProcessingAccountId.value = ''
    else bindingAccountId.value = ''
  }
}

async function createAndBindReviewUser(item: DirectoryReviewItem) {
  await createAndBindDirectoryAccountUser(item.account, 'review')
}

async function createAndBindAccountUser(account: DirectoryAccount) {
  await createAndBindDirectoryAccountUser(account, 'account')
}

async function retryBackfillUserMobileAndBindReviewItem(item: DirectoryReviewItem) {
  clearMobileConflictHint(item.account.id)
  clearMobileOverrideConfirmation(item.account.id)
  await backfillUserMobileAndBindReviewItem(item)
}

async function batchAdmitReviewItems() {
  if (!selectedIntegration.value || selectedReviewAdmissionIds.value.length === 0) return
  reviewBatchProcessing.value = true
  let appliedCount = 0
  const batchIds = [...selectedReviewAdmissionIds.value]
  try {
    clearBatchAdmissionOnboardingPackets()
    setReviewBatchProgress({
      kind: 'admit',
      phase: 'submitting',
      total: batchIds.length,
      applied: 0,
      message: '正在批量创建本地用户并绑定目录成员...',
    })
    const response = await apiFetch('/api/admin/directory/accounts/batch-admit-users', {
      method: 'POST',
      body: JSON.stringify({
        accountIds: batchIds,
        enableDingTalkGrant: false,
      }),
    })
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '批量创建并绑定失败'))
    const data = body?.data as Record<string, unknown> | undefined
    const processedItems = Array.isArray(data?.items) ? data.items : []
    appliedCount = Number(data?.updatedCount ?? processedItems.length)
    batchAdmissionOnboardingPackets.value = readBatchAdmissionOnboardingPackets(data)
    setReviewBatchProgress({
      kind: 'admit',
      phase: 'refreshing',
      total: batchIds.length,
      applied: appliedCount,
      message: `已创建并绑定 ${appliedCount} / ${batchIds.length}，正在刷新目录成员与待处理队列...`,
    })
    const failedCount = Number(data?.failedCount ?? 0)
    const failedItems = Array.isArray(data?.failed) ? data.failed : []
    const failedPreview = readFailedBindingsPreview(failedItems, FAILED_BINDINGS_PREVIEW_LIMIT)
    const message = failedCount > 0
      ? `已创建并绑定 ${appliedCount} 个目录成员，另有 ${failedCount} 个失败${failedPreview ? `：${failedPreview}` : '，请重试'}`
      : `已创建并绑定 ${appliedCount} 个目录成员`
    await refreshAfterReviewBindings(message, failedCount > 0 ? 'error' : 'info')
    reselectFailedReviewRows(
      batchIds,
      failedItems,
      (item) => (
        item.kind === 'pending_binding'
        && item.account.isActive
        && !item.account.localUser
        && !item.actionable.canConfirmRecommendation
      ),
      () => selectedReviewAdmissionIds.value.length,
      () => showPendingBindingView('manual'),
    )
    setReviewBatchProgress({
      kind: 'admit',
      phase: 'completed',
      total: batchIds.length,
      applied: appliedCount,
      message,
    })
  } catch (error) {
    setReviewBatchProgress({
      kind: 'admit',
      phase: 'failed',
      total: batchIds.length,
      applied: appliedCount,
      message: error instanceof Error ? error.message : '批量创建并绑定失败',
    })
    setStatus(error instanceof Error ? error.message : '批量创建并绑定失败', 'error')
  } finally {
    reviewBatchProcessing.value = false
  }
}

async function batchBindReviewItems() {
  await submitReviewBindings(
    selectedReviewBindEntries.value.map((item) => ({
      accountId: item.accountId,
      localUserRef: item.localUserRef,
      enableDingTalkGrant: item.enableDingTalkGrant,
    })),
    `已完成 ${selectedReviewBindEntries.value.length} 个目录成员的批量绑定`,
    '批量绑定失败',
    'bind',
  )
}

async function confirmRecommendedReviewBinding(item: DirectoryReviewItem) {
  if (item.recommendations.length === 0) return
  reviewProcessingAccountId.value = item.account.id
  try {
    const recommendation = item.recommendations[0]
    await submitReviewBindings([{
      accountId: item.account.id,
      localUserRef: recommendation.localUser.id,
      enableDingTalkGrant: readAccountGrantToggle(item.account),
    }], `待处理成员 ${item.account.name} 已确认推荐绑定`, '确认推荐绑定失败')
  } finally {
    reviewProcessingAccountId.value = ''
  }
}

async function batchConfirmRecommendedReviewItems() {
  await submitReviewBindings(
    selectedRecommendedReviewBindEntries.value.map((item) => ({
      accountId: item.accountId,
      localUserRef: item.localUserRef,
      enableDingTalkGrant: item.enableDingTalkGrant,
    })),
    `已完成 ${selectedRecommendedReviewBindEntries.value.length} 个目录成员的推荐绑定确认`,
    '批量确认推荐绑定失败',
    'recommend',
  )
}

async function batchUnbindReviewItems() {
  if (!selectedIntegration.value || selectedReviewBatchIds.value.length === 0 || reviewBatchProcessing.value) return
  reviewBatchProcessing.value = true
  let appliedCount = 0
  try {
    const contextVersion = directoryContextVersion
    const integrationId = selectedIntegrationId.value
    const batchIds = [...selectedReviewBatchIds.value]
    const disableDingTalkGrant = reviewDisableDingTalkGrant.value
    if (!(await confirmDirectoryUnbind(batchIds.length))) return
    if (!isCurrentUnbindContext(contextVersion, integrationId)) return
    setReviewBatchProgress({
      kind: 'unbind',
      phase: 'submitting',
      total: batchIds.length,
      applied: 0,
      message: '正在提交批量停权处理请求...',
    })
    const response = await apiFetch('/api/admin/directory/accounts/batch-unbind', {
      method: 'POST',
      body: JSON.stringify({
        accountIds: batchIds,
        disableDingTalkGrant,
      }),
    })
    const body = await readJson(response)
    if (!response.ok) throw new Error(readApiError(body, '批量停权处理失败'))
    const data = body?.data as Record<string, unknown> | undefined
    const processedItems = Array.isArray(data?.items) ? data.items : []
    appliedCount = Number(data?.updatedCount ?? processedItems.length)
    const failedCount = Number(data?.failedCount ?? 0)
    const failedItems = Array.isArray(data?.failed) ? data.failed : []
    setReviewBatchProgress({
      kind: 'unbind',
      phase: 'refreshing',
      total: batchIds.length,
      applied: appliedCount,
      message: `已提交 ${appliedCount} / ${batchIds.length}，正在刷新目录成员与待处理队列...`,
    })
    const failedPreview = readFailedBindingsPreview(failedItems, FAILED_BINDINGS_PREVIEW_LIMIT)
    const message = failedCount > 0
      ? `已停权处理 ${appliedCount} 个目录成员，另有 ${failedCount} 个失败${failedPreview ? `：${failedPreview}` : '，请重试'}`
      : `已完成 ${batchIds.length} 个目录成员的批量停权处理`
    await refreshAfterReviewBindings(message, failedCount > 0 ? 'error' : 'info')
    // Deprovision acts on inactive linked accounts, so eligibility is canBatchUnbind alone.
    reselectFailedReviewRows(
      batchIds,
      failedItems,
      (item) => item.actionable.canBatchUnbind,
      () => selectedReviewBatchIds.value.length,
      () => { reviewFilter.value = 'inactive_linked' },
    )
    setReviewBatchProgress({
      kind: 'unbind',
      phase: 'completed',
      total: batchIds.length,
      applied: appliedCount,
      message,
    })
  } catch (error) {
    setReviewBatchProgress({
      kind: 'unbind',
      phase: 'failed',
      total: selectedReviewBatchIds.value.length,
      applied: appliedCount,
      message: error instanceof Error ? error.message : '批量停权处理失败',
    })
    setStatus(error instanceof Error ? error.message : '批量停权处理失败', 'error')
  } finally {
    reviewBatchProcessing.value = false
  }
}

function formatDateTime(value: string | null): string {
  if (!value) return '未记录'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function readObservationStatusLabel(status: DirectoryObservationStatus | null | undefined): string {
  if (status === 'auto_observed' || status === 'scheduler_observed') return '已观察到自动触发'
  if (status === 'configured_no_runs' || status === 'awaiting_first_run') return '等待首次自动触发'
  if (status === 'manual_only') return '仅观察到手动执行'
  if (status === 'missing_cron') return '缺少 cron'
  if (status === 'invalid_cron') return 'cron 无效'
  if (status === 'disabled') return '自动同步未启用'
  return '状态未知'
}

function readObservationStatusClass(status: DirectoryObservationStatus | null | undefined): string {
  if (status === 'auto_observed' || status === 'scheduler_observed') return 'directory-admin__chip--success'
  if (status === 'manual_only' || status === 'configured_no_runs' || status === 'awaiting_first_run' || status === 'missing_cron' || status === 'disabled') {
    return 'directory-admin__chip--warning'
  }
  if (status === 'invalid_cron') return 'directory-admin__chip--danger'
  return ''
}

function readTriggerSourceLabel(triggerSource: string | null | undefined): string {
  if (!triggerSource) return '未记录'
  if (triggerSource === 'scheduler') return '自动调度'
  if (triggerSource === 'manual') return '手动触发'
  return triggerSource
}

function readAlertLevelLabel(level: DirectorySyncAlert['level']): string {
  if (level === 'info') return '信息'
  if (level === 'warning') return '警告'
  return '错误'
}

function readAlertLevelClass(level: DirectorySyncAlert['level']): string {
  if (level === 'info') return 'directory-admin__chip--success'
  if (level === 'warning') return 'directory-admin__chip--warning'
  return 'directory-admin__chip--danger'
}

function readReviewKindLabel(kind: DirectoryReviewItem['kind']): string {
  if (kind === 'pending_binding') return '待绑定'
  if (kind === 'inactive_linked') return '停用待停权'
  if (kind === 'missing_identifier') return '缺身份标识'
  return '待处理'
}

function readReviewKindClass(kind: DirectoryReviewItem['kind']): string {
  if (kind === 'pending_binding') return 'directory-admin__chip--warning'
  if (kind === 'inactive_linked') return 'directory-admin__chip--danger'
  if (kind === 'missing_identifier') return 'directory-admin__chip--warning'
  return ''
}

function readNumericStat(stats: Record<string, unknown>, key: string): number {
  const value = stats[key]
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim().length > 0 && !Number.isNaN(Number(value))) return Number(value)
  return 0
}

/**
 * R5 (#4054) stats keys are additive jsonb — pre-R5 runs simply lack them. Where rendering
 * a defaulted 0 would mislead ("this run deactivated 0" vs "this run predates counting"),
 * gate on actual key presence instead of readNumericStat's 0 fallback.
 */
function hasRunStat(stats: Record<string, unknown> | null | undefined, key: string): boolean {
  const value = stats?.[key]
  return value !== undefined && value !== null
}

function formatManagerCoverage(stats: Record<string, unknown>): string {
  const managerCount = readNumericStat(stats, 'managerCount')
  const linkedManagerCount = readNumericStat(stats, 'linkedManagerCount')
  const coverage = stats['managerCoverage']
  const percent = typeof coverage === 'number' && Number.isFinite(coverage)
    ? `${Math.round(coverage * 100)}%`
    : '—'
  return `${percent}（${linkedManagerCount}/${managerCount}）`
}

function formatRunDurationMs(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '—'
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`
  const seconds = durationMs / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.round(seconds % 60)
  return `${minutes}m${remainder}s`
}

function readStringStat(stats: Record<string, unknown>, key: string): string {
  const value = stats[key]
  return typeof value === 'string' ? value : ''
}

function readStringArrayStat(stats: Record<string, unknown>, key: string): string[] {
  const value = stats[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function formatSampleUsers(users: Array<{ userId: string; name: string }>, hasMore: boolean): string {
  const summary = users.map((user) => `${user.name} (${user.userId})`).join('，')
  if (!summary) return '无'
  return hasMore ? `${summary} 等` : summary
}

const stopDirectoryLocationSync = subscribeToLocationChanges(() => {
  if (!onDirectoryRoute()) {
    directoryContextVersion += 1
    return
  }
  activeDirectoryTab.value = readDirectoryTab()
  const navigationChanged = syncDirectoryNavigationFromLocation()
  if (directoryNavigation.value.accountId && new URL(window.location.href).searchParams.get('tab') !== 'accounts') {
    setDirectoryTab('accounts')
  }
  if (!navigationChanged) return
  directoryContextVersion += 1
  void handleDirectoryNavigationChange()
})

onMounted(() => {
  if (directoryNavigation.value.accountId) setDirectoryTab('accounts')
  void loadIntegrations()
})

onUnmounted(() => {
  directoryViewActive = false
  directoryContextVersion += 1
  stopDirectoryLocationSync()
  // Timer hygiene: never leak the background-sync poll past the view's lifetime.
  stopRunPolling()
})
return {
  activeDirectoryTab,
  directoryTabs,
  setDirectoryTab,
  integrations,
  integrationsLoaded,
  integrationsLoadError,
  runs,
  accounts,
  visibleAccounts,
  accountSnapshotIntegrationId,
  alertSnapshotIntegrationId,
  accountsLoadFailed,
  alertsLoadFailed,
  scheduleLoadFailed,
  departments,
  scheduleSnapshot,
  alerts,
  reviewItems,
  accountsSectionRef,
  accountPageSizeOptions,
  accountPage,
  accountPageSize,
  accountTotal,
  focusedAccountId,
  pendingFocusedAccountScroll,
  selectedIntegrationId,
  loading,
  loadingRuns,
  loadingSchedule,
  loadingAlerts,
  loadingReviewItems,
  loadingMoreReviewItems,
  loadingAccounts,
  loadingDepartments,
  busy,
  approvalCardBusy,
  previewBusy,
  previewResult,
  asyncSyncBusy,
  pollingRunId,
  approvalCardLinkSecretEnvOverrideActive,
  bindingAccountId,
  unbindingAccountId,
  acknowledgingAlertId,
  reviewProcessingAccountId,
  reviewBatchProcessing,
  reviewBatchProgress,
  status,
  statusTone,
  dingtalkLoginProbeBusy,
  dingtalkLoginProbeMessage,
  routeNavigationFailureNotice,
  routeNavigationFailureAction,
  testResult,
  DINGTALK_LOGIN_PROBE_FAILED,
  describeDingTalkLoginProbe,
  checkDingTalkLoginProbe,
  departmentsLoaded,
  departmentLoadError,
  departmentQuery,
  departmentScopeFilter,
  manualDepartmentId,
  manualDepartmentName,
  pickedDepartmentId,
  roleCatalog,
  roleCatalogLoaded,
  roleCatalogLoading,
  roleCatalogError,
  accountQuery,
  accountStatusFilter,
  alertFilter,
  reviewFilter,
  pendingBindingView,
  pendingBindingViewTouched,
  pendingBindingManualReason,
  bindingDrafts,
  selectedBindingUsers,
  mobileOverrideConfirmations,
  mobileConflictHints,
  userSearchResults,
  userSearchLoading,
  userSearchError,
  manualAdmissionDrafts,
  manualAdmissionExpanded,
  manualAdmissionResult,
  autoAdmissionOnboardingPackets,
  batchAdmissionOnboardingPackets,
  grantToggles,
  selectedReviewIds,
  reviewDisableDingTalkGrant,
  reviewPageSize,
  reviewPage,
  reviewTotal,
  appliedDirectoryNavigationKey,
  alertFilterOptions,
  DIRECTORY_ADMIN_UNBIND_REVIEW_NOTE,
  reviewFilterOptions,
  pendingBindingViewOptions,
  pendingBindingManualReasonOptions,
  departmentScopeFilterOptions,
  departmentTargetFields,
  directoryNavigation,
  draft,
  selectedIntegration,
  routeNavigationFailureUserManagementLocation,
  accountPageCount,
  accountRangeStart,
  accountRangeEnd,
  alertCounts,
  filteredAlerts,
  reviewCounts,
  pendingBindingCounts,
  pendingBindingManualReasonCounts,
  showPendingBindingManualReasonFilters,
  focusedVisibleAccount,
  departmentRows,
  departmentFilterActive,
  departmentAccountCount,
  departmentLinkedAccountCount,
  departmentUnlinkedAccountCount,
  departmentUnlinkedMirrorCount,
  inactiveDepartmentCount,
  departmentMirrorLatestSeenAt,
  departmentMirrorLatestUpdatedAt,
  departmentMirrorCurrentBatchCount,
  departmentMirrorStaleSeenCount,
  departmentMirrorObservationHasWarnings,
  departmentMirrorObservationMessage,
  departmentConfigScope,
  departmentSavedConfigScope,
  departmentDraftScopeChanges,
  hasDepartmentDraftScopeChanges,
  departmentDraftScopeAddedCount,
  departmentDraftScopeRemovedCount,
  hasScopedDepartmentConfig,
  departmentConfigReferenceIssues,
  configuredDepartmentIds,
  configuredDepartmentCount,
  departmentReferenceIssueIds,
  configuredDepartmentMirrorCount,
  issueDepartmentMirrorCount,
  scopeFilteredDepartmentRows,
  visibleDepartmentRows,
  visibleDepartmentIdPreview,
  visibleDepartmentNamePreview,
  departmentPickerOptions,
  departmentPickerLoaded,
  departmentPickerError,
  departmentPickerEmptyText,
  memberGroupRoleOptions,
  memberGroupNamespaceOptions,
  rootDepartmentPickerAvailable,
  rootDepartmentTreeIds,
  rootDepartmentNeedsFallbackOption,
  departmentViewFilterActive,
  showVisibleDepartmentBulkActions,
  departmentTreeEmptyMessage,
  focusedVisibleAccountBindDraft,
  focusedVisibleAccountBindLabel,
  hasMoreReviewItems,
  filteredReviewItems,
  isBulkSelectablePendingBinding,
  selectableVisibleReviewIds,
  selectableVisibleRecommendedReviewIds,
  selectedRecommendedReviewBindEntries,
  selectedReviewBindEntries,
  selectedReviewAdmissionIds,
  selectedReviewBatchIds,
  canSave,
  setStatus,
  readInitialDirectoryNavigation,
  buildDirectoryNavigationKey,
  buildDirectoryLocation,
  replaceDirectoryNavigation,
  syncDirectoryNavigationFromLocation,
  resetDraft,
  applyIntegrationToDraft,
  parseAdmissionDepartmentIdsText,
  readDepartmentTargetText,
  writeDepartmentTargetText,
  readDepartmentTargetLabel,
  readSavedDepartmentTargetIds,
  buildConfiguredDepartmentIdSet,
  buildDepartmentScopeChanges,
  readTimestampMs,
  readLatestDepartmentTimestamp,
  isDepartmentInLatestMirrorBatch,
  readDepartmentUnlinkedAccountCount,
  filterDirectoryDepartmentRowsByScope,
  readDepartmentScopeFilterCount,
  readDepartmentScopeFilterLabel,
  resetDepartmentViewFilters,
  focusDepartmentScopeFilter,
  restoreDepartmentScopeDraftsToSavedConfig,
  restoreDepartmentScopeDraftToSavedConfig,
  writeClipboardText,
  copyVisibleDepartmentIds,
  buildVisibleDepartmentReport,
  copyVisibleDepartmentReport,
  copyDepartmentId,
  buildDepartmentReferenceIssueReport,
  describeDepartmentConfigReference,
  buildDepartmentConfigReferenceReport,
  buildDepartmentBindingGapReport,
  buildInactiveDepartmentReport,
  buildDepartmentMirrorObservationReport,
  buildDepartmentDraftScopeChangeReport,
  copyDepartmentReferenceIssueReport,
  copyDepartmentConfigReferenceReport,
  copyDepartmentBindingGapReport,
  copyInactiveDepartmentReport,
  copyDepartmentMirrorObservationReport,
  copyDepartmentDraftScopeChangeReport,
  buildDepartmentConfigReferenceIssues,
  readDepartmentReferenceIssueLabel,
  addDepartmentIdToTarget,
  addDepartmentToTarget,
  addVisibleDepartmentsToTarget,
  removeVisibleDepartmentsFromTarget,
  addManualDepartmentToTarget,
  writePickedDepartment,
  addPickedDepartmentToTarget,
  readDepartmentTargetIds,
  writeMemberGroupDefaultRoleIds,
  writeMemberGroupDefaultNamespaces,
  readDepartmentPickerPath,
  readDepartmentPreviewLine,
  readUnknownDepartmentLabel,
  readUnknownRoleLabel,
  readUnknownNamespaceLabel,
  readRootDepartmentFallbackLabel,
  loadDepartmentsForPicker,
  ensureRoleCatalogLoaded,
  removeDepartmentFromTarget,
  removeAllDepartmentReferenceIssues,
  readAdmissionModeLabel,
  readMemberGroupSyncLabel,
  buildDirectoryDepartmentTreeRows,
  normalizeDepartmentSearchValue,
  filterDirectoryDepartmentRows,
  readDepartmentIndentStyle,
  describeDepartmentParent,
  selectIntegration,
  readApiError,
  readApiErrorCode,
  DIRECTORY_ADMISSION_LOGIN_NAME_RULE_COPY,
  DIRECTORY_ADMISSION_LOGIN_NAME_HINT,
  describeDirectoryAdmissionError,
  readJson,
  loadIntegrations,
  readBindingDraft,
  readBindingDraftByAccountId,
  clearFocusedAccount,
  clearFocusedAccountNavigationState,
  clearRouteNavigationFailureNotice,
  retryRouteNavigationFailureNotice,
  clearFailedDirectoryNavigation,
  setRouteNavigationFailureNotice,
  readDirectoryIntegrationMissingMessage,
  readDirectoryAccountMissingMessage,
  updateBindingDraft,
  onBindingDraftInput,
  readBindingSearchResults,
  readBindingSearchLoading,
  readBindingSearchError,
  setBindingSearchState,
  searchLocalUsers,
  chooseLocalUser,
  applyRecommendedLocalUser,
  readSelectedBindingUser,
  hasSelectedBindingUserMobileConflict,
  shouldOfferMobileBackfill,
  isAwaitingMobileOverrideConfirmation,
  clearMobileOverrideConfirmation,
  readBackfillAndBindLabel,
  refreshSingleReviewItem,
  readMobileConflictHint,
  clearMobileConflictHint,
  refreshSingleAccount,
  readRecommendationReasonLabel,
  readGrantToggle,
  canEnableDingTalkGrant,
  readAccountGrantToggle,
  shouldWarnMissingOpenIdForGrant,
  updateGrantToggle,
  onGrantToggleChange,
  clearBindingSearch,
  buildManualAdmissionDraft,
  readManualAdmissionDraft,
  isManualAdmissionExpanded,
  toggleManualAdmission,
  onManualAdmissionDraftInput,
  canSubmitManualAdmission,
  describeLocalUserIdentifier,
  describeLocalUserLabel,
  clearManualAdmissionResult,
  clearAutoAdmissionOnboardingPackets,
  clearBatchAdmissionOnboardingPackets,
  readCreatedLocalUserOption,
  readAutoAdmissionOnboardingPackets,
  readBatchAdmissionOnboardingPackets,
  readDirectoryOnboardingPackets,
  buildPayload,
  saveIntegration,
  testIntegration,
  buildWorkNotificationPayload,
  testWorkNotificationAgentId,
  saveWorkNotificationAgentId,
  confirmApprovalCardSecretRegenerate,
  generateApprovalCardLinkSecret,
  buildApprovalCardConfigPayload,
  saveApprovalCardPublicAppUrl,
  syncIntegration,
  refreshAfterDirectorySync,
  readActiveRunId,
  buildSyncInProgressMessage,
  previewSync,
  formatPreviewSample,
  formatPreviewDeactivationSample,
  confirmAsyncSyncDiscardsOnboardingPackets,
  stopRunPolling,
  DIRECTORY_RUN_POLL_INTERVAL_MS,
  DIRECTORY_RUN_POLL_MAX_DURATION_MS,
  pollAsyncRun,
  buildAsyncRunSummary,
  startAsyncSync,
  searchAccounts,
  changeAccountPage,
  updateAccountPageSize,
  scrollFocusedAccountIntoView,
  loadAccounts,
  cancelPendingDepartmentLoad,
  loadDepartments,
  loadRuns,
  loadScheduleSnapshot,
  loadAlerts,
  normalizeReviewItems,
  mergeReviewItems,
  loadReviewItems,
  updateAlertFilter,
  updateReviewFilter,
  updatePendingBindingView,
  updatePendingBindingManualReason,
  syncPendingBindingQueueDefaults,
  loadMoreReviewItems,
  clearReviewBatchProgress,
  readReviewBatchProgressKindLabel,
  readReviewBatchProgressPhaseLabel,
  readReviewBatchProgressPhaseClass,
  setReviewBatchProgress,
  readPendingBindingManualReasonCode,
  matchesPendingBindingView,
  acknowledgeAlert,
  bindAccount,
  unbindAccount,
  updateReviewSelection,
  clearReviewSelection,
  selectVisibleReviewItems,
  selectVisibleRecommendedReviewItems,
  onReviewSelectionChange,
  focusReviewAccount,
  applyInitialDirectoryNavigationBeforeLoads,
  handleDirectoryNavigationChange,
  buildUserManagementLocation,
  handleReviewUnbind,
  FAILED_BINDINGS_PREVIEW_LIMIT,
  readFailedBindingsPreview,
  postReviewBindings,
  refreshAfterReviewBindings,
  reselectFailedReviewRows,
  showPendingBindingView,
  submitReviewBindings,
  handleReviewBind,
  backfillUserMobileAndBindReviewItem,
  createAndBindDirectoryAccountUser,
  createAndBindReviewUser,
  createAndBindAccountUser,
  retryBackfillUserMobileAndBindReviewItem,
  batchAdmitReviewItems,
  batchBindReviewItems,
  confirmRecommendedReviewBinding,
  batchConfirmRecommendedReviewItems,
  batchUnbindReviewItems,
  formatDateTime,
  readObservationStatusLabel,
  readObservationStatusClass,
  readTriggerSourceLabel,
  readAlertLevelLabel,
  readAlertLevelClass,
  readReviewKindLabel,
  readReviewKindClass,
  readNumericStat,
  hasRunStat,
  formatManagerCoverage,
  formatRunDurationMs,
  readStringStat,
  readStringArrayStat,
  formatSampleUsers,
  stopDirectoryLocationSync,
}
}

export type DirectoryManagementContext = ReturnType<typeof useDirectoryManagement>

export const directoryManagementKey: InjectionKey<DirectoryManagementContext> = Symbol('directoryManagement')
