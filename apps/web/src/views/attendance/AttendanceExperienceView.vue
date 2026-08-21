<template>
  <div class="attendance-shell">
    <nav class="attendance-shell__tabs" :aria-label="t.attendanceSections">
      <button
        v-for="tab in availableTabs"
        :key="tab.id"
        class="attendance-shell__tab"
        :class="{ 'attendance-shell__tab--active': activeTab === tab.id }"
        type="button"
        @click="selectTab(tab.id)"
      >
        {{ tab.label }}
      </button>
    </nav>

    <section v-if="!featuresReady" class="attendance-shell__loading">
      <p>{{ t.loadingAttendance }}</p>
    </section>

    <section v-else-if="desktopOnlyBlocked" class="attendance-shell__desktop-hint">
      <h3>{{ t.desktopRecommended }}</h3>
      <p>{{ desktopOnlyMessage }}</p>
      <button class="attendance-shell__btn" type="button" @click="returnFromGroupRoute">
        {{ t.backToOverview }}
      </button>
    </section>

    <AttendanceGroupContextHost
      v-else-if="groupRouteActive"
      :key="groupRouteHostKey"
      :context="routeGroupContext"
      @return="returnFromGroupRoute"
    >
      <template #default="{ group, step, surface, returnTo }">
        <AttendanceAdminCenter
          :route-group-context="{ group, step, surface, returnTo }"
          @clear-section="returnFromGroupRoute"
          @open-group-route="openGroupRoute"
        />
      </template>
    </AttendanceGroupContextHost>

    <component
      v-else-if="activeView"
      :is="activeView.component"
      :key="activeView.key"
      v-bind="activeView.props"
    />
    <section v-else class="attendance-shell__desktop-hint" data-attendance-capability-unavailable>
      <h3>{{ unavailableCapabilityCopy.heading }}</h3>
      <p>{{ unavailableCapabilityCopy.detail }}</p>
      <div class="attendance-shell__capability-actions">
        <button class="attendance-shell__btn" type="button" @click="selectTab('overview')">
          {{ t.backToOverview }}
        </button>
        <button
          class="attendance-shell__btn"
          type="button"
          data-attendance-capability-retry
          @click="retryCapabilityProbe"
        >
          {{ t.retryCapabilityProbe }}
        </button>
      </div>
      <template v-if="unavailableCapabilityOverrideAllowed">
        <p class="attendance-shell__capability-state" data-attendance-capability-override-state>
          {{ t.capabilityCurrentStateOff }}
        </p>
        <button
          class="attendance-shell__btn attendance-shell__btn--primary"
          type="button"
          data-attendance-capability-enable-locally
          @click="enableUnavailableCapabilityLocally"
        >
          {{ t.enableCapabilityLocally }}
        </button>
      </template>
      <p v-else class="attendance-shell__capability-contact" data-attendance-capability-contact-admin>
        {{ t.contactAdministrator }}
      </p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import type { LocationQueryRaw } from 'vue-router'
import { useLocale } from '../../composables/useLocale'
import { useFeatureFlags } from '../../stores/featureFlags'
import { confirmAttendanceSetupPrefillLeave } from './attendanceSetupPrefillLeaveGuard'
import {
  buildAttendanceCapabilityUnavailableCopy,
  resolveAttendanceCapabilityInfo,
} from './attendanceCapabilityUnavailable'
import {
  buildAttendanceGroupRouteHref,
  isAttendanceGroupContextPath,
  resolveAttendanceGroupRouteContext,
} from '../../router/attendanceGroupContextRoute'
import type { AttendanceGroupRouteStep, AttendanceGroupRouteSurface } from '../../router/attendanceGroupContextRoute'
import AttendanceOverview from './AttendanceOverview.vue'
import AttendanceReportsView from './AttendanceReportsView.vue'
import AttendanceAdminCenter from './AttendanceAdminCenter.vue'
import AttendanceGroupContextHost from './AttendanceGroupContextHost.vue'
import AttendanceWorkflowDesigner from './AttendanceWorkflowDesigner.vue'

type AttendanceTab = 'overview' | 'reports' | 'admin' | 'import' | 'workflow'

// vNext charter §7 Wave 3 (issue #4353, reclaimed from stacked draft #4414):
// the admin task home's Anomalies entry deep-links here, so every known
// overview section id (not just `requests`) must survive the round trip
// through the route query.
const ATTENDANCE_OVERVIEW_SECTION_IDS = new Set([
  'attendance-overview-requests',
  'attendance-overview-anomalies',
  'attendance-overview-request-report',
  'attendance-overview-records',
  // W5-1 (Wave 5 explainability design-lock §6/§9 W5-1): the self face of the read-only
  // decision-trace surface — canonical `?section=attendance-overview-decision-trace` query deep
  // link (R2: query form, never hash).
  'attendance-overview-decision-trace',
])

const route = useRoute()
const router = useRouter()
const { hasFeature, loadProductFeatures, isFeatureOverrideAllowed, setLocalFeatureOverride } = useFeatureFlags()
const { isZh } = useLocale()

// W4-2 OD-W4-7② (切区确认 leg): an applied-but-unsaved template prefill lives in the admin
// host's in-memory forms (AttendanceView). Leaving the /attendance route unmounts everything —
// beforeunload never fires on SPA navigation, so ask here before vue-router proceeds.
const setupPrefillLeaveTr = (en: string, zh: string): string => (isZh.value ? zh : en)
onBeforeRouteLeave(() => confirmAttendanceSetupPrefillLeave(setupPrefillLeaveTr))

const activeTab = ref<AttendanceTab>('overview')
const featuresReady = ref(false)
const isMobile = ref(false)

function routeStepFromMetadata(): unknown {
  const step = route.params?.step
  if (typeof step === 'string') return step
  if (route.name === 'attendance-admin-group-schedule') return 'schedule'
  if (route.name === 'attendance-admin-group-calendar') return 'calendar'
  if (route.name === 'attendance-admin-group-rules') return 'rules'
  return undefined
}

const groupRoutePathActive = computed(() => isAttendanceGroupContextPath(route.path))
const routeGroupContext = computed(() => {
  if (!groupRoutePathActive.value) return null
  return resolveAttendanceGroupRouteContext({
    groupId: route.params?.groupId,
    step: routeStepFromMetadata(),
    surface: route.query.surface,
    returnTo: route.query.returnTo,
    currentPath: route.path,
  })
})
const groupRouteActive = computed(() => groupRoutePathActive.value && routeGroupContext.value !== null)
const groupRouteHostKey = computed(() => routeGroupContext.value
  ? `${routeGroupContext.value.groupId}:${routeGroupContext.value.step}:${routeGroupContext.value.surface ?? ''}`
  : route.path)

const canAccessAdmin = computed(() => hasFeature('attendanceAdmin'))
const canAccessWorkflow = computed(() => hasFeature('workflow'))
const desktopOnlyTabs: AttendanceTab[] = ['admin', 'import', 'workflow']
const t = computed(() => isZh.value
  ? {
      attendanceSections: '考勤模块',
      overview: '总览',
      reports: '报表',
      adminCenter: '管理中心',
      importCenter: '导入',
      workflowDesigner: '流程设计',
      loadingAttendance: '加载考勤模块...',
      desktopRecommended: '建议使用桌面端',
      backToOverview: '返回总览',
      capabilityUnavailable: '当前能力不可用',
      capabilityHint: '当前账号没有此模块的访问权限。',
      workflowDesktopHint: '当前版本流程设计仅支持桌面端，请在桌面端编辑和发布流程。',
      adminDesktopHint: '管理中心以桌面端为主，请在桌面端管理导入、规则与计薪配置。',
      retryCapabilityProbe: '重试',
      capabilityCurrentStateOff: '当前状态：本会话未启用。',
      enableCapabilityLocally: '在本会话本地启用',
      contactAdministrator: '请联系管理员为您的账号启用此功能。',
    }
  : {
      attendanceSections: 'Attendance sections',
      overview: 'Overview',
      reports: 'Reports',
      adminCenter: 'Admin Center',
      importCenter: 'Import',
      workflowDesigner: 'Workflow Designer',
      loadingAttendance: 'Loading attendance module...',
      desktopRecommended: 'Desktop recommended',
      backToOverview: 'Back to Overview',
      capabilityUnavailable: 'Capability not available',
      capabilityHint: 'Current account does not have access to this section.',
      workflowDesktopHint: 'Workflow designer is desktop-only in this release. Use desktop for editing and publishing flows.',
      adminDesktopHint: 'Admin center is desktop-first. Use desktop to manage import, rules, and payroll settings.',
      retryCapabilityProbe: 'Retry',
      capabilityCurrentStateOff: 'Current state: off for this session.',
      enableCapabilityLocally: 'Enable locally for this session',
      contactAdministrator: 'Ask your administrator to enable this for your account.',
    })

const availableTabs = computed<Array<{ id: AttendanceTab; label: string }>>(() => {
  const tabs: Array<{ id: AttendanceTab; label: string }> = [
    { id: 'overview', label: t.value.overview },
    { id: 'reports', label: t.value.reports },
  ]

  if (canAccessAdmin.value) {
    tabs.push({ id: 'admin', label: t.value.adminCenter })
    tabs.push({ id: 'import', label: t.value.importCenter })
  }

  if (canAccessWorkflow.value) {
    tabs.push({ id: 'workflow', label: t.value.workflowDesigner })
  }

  return tabs
})

const desktopOnlyBlocked = computed(() => isMobile.value && desktopOnlyTabs.includes(activeTab.value))

const desktopOnlyMessage = computed(() => {
  if (activeTab.value === 'workflow') {
    return t.value.workflowDesktopHint
  }
  return t.value.adminDesktopHint
})

const overviewInitialSectionId = computed(() => {
  const section = Array.isArray(route.query.section) ? route.query.section[0] : route.query.section
  return typeof section === 'string' && ATTENDANCE_OVERVIEW_SECTION_IDS.has(section) ? section : ''
})

const overviewInitialRequestId = computed(() => {
  const requestId = Array.isArray(route.query.requestId) ? route.query.requestId[0] : route.query.requestId
  return typeof requestId === 'string' ? requestId.trim() : ''
})

const adminInitialSectionId = computed(() => {
  const section = Array.isArray(route.query.section) ? route.query.section[0] : route.query.section
  return typeof section === 'string' && section.startsWith('attendance-admin-') ? section : ''
})

function matchesMediaQuery(query: string): boolean {
  try {
    return Boolean(window.matchMedia?.(query)?.matches)
  } catch {
    return false
  }
}

function hasMobileRuntimeSignals(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false

  if (matchesMediaQuery('(pointer: coarse)')) return true

  const touchPoints = Number(navigator.maxTouchPoints ?? 0)
  if (touchPoints > 0) return true

  const userAgent = String(navigator.userAgent || '')
  if (/(android|iphone|ipad|ipod|mobile)/i.test(userAgent)) return true

  return false
}

const activeView = computed(() => {
  switch (activeTab.value) {
    case 'overview':
      return {
        component: AttendanceOverview,
        key: 'attendance-overview',
        props: {
          initialSectionId: overviewInitialSectionId.value,
          initialRequestId: overviewInitialRequestId.value,
        },
      }
    case 'reports':
      return {
        component: AttendanceReportsView,
        key: 'attendance-reports',
        props: {},
      }
    case 'admin':
      if (!canAccessAdmin.value) return null
      return {
        component: AttendanceAdminCenter,
        key: 'attendance-admin',
        props: {
          initialSectionId: adminInitialSectionId.value,
          onClearSection: returnToAdminHome,
          onOpenGroupRoute: openGroupRoute,
        },
      }
    case 'import':
      if (!canAccessAdmin.value) return null
      return {
        component: AttendanceAdminCenter,
        key: 'attendance-import',
        props: {
          initialSectionId: 'attendance-admin-import',
          onClearSection: returnToAdminHome,
          onOpenGroupRoute: openGroupRoute,
        },
      }
    case 'workflow':
      if (!canAccessWorkflow.value) return null
      return {
        component: AttendanceWorkflowDesigner,
        key: 'attendance-workflow',
        props: { canDesign: canAccessWorkflow.value },
      }
  }
  return null
})

// Navigability audit fix 1: the "Capability not available" fallback below names which capability
// is unavailable instead of a bare unexplained empty state. `activeTab.value` is one of
// admin/import/workflow whenever this branch renders (overview/reports never return null above).
const unavailableCapabilityInfo = computed(() => resolveAttendanceCapabilityInfo(activeTab.value))
const unavailableCapabilityCopy = computed(() => {
  const info = unavailableCapabilityInfo.value
  if (!info) return { heading: t.value.capabilityUnavailable, detail: t.value.capabilityHint }
  return buildAttendanceCapabilityUnavailableCopy(info, isZh.value)
})
// isFeatureOverrideAllowed() is a pure env/DEV-mode predicate (no reactive dependency), read once
// per render — this is the SAME gate parseOverrideFeatures() already enforces, just surfaced here
// rather than requiring hand-edited localStorage. When false, the fallback shows an
// "ask your administrator" line instead of an override control (never a new privilege).
const unavailableCapabilityOverrideAllowed = isFeatureOverrideAllowed()

async function retryCapabilityProbe(): Promise<void> {
  await loadProductFeatures(true)
  syncFromRoute()
}

async function enableUnavailableCapabilityLocally(): Promise<void> {
  const info = unavailableCapabilityInfo.value
  if (!info) return
  setLocalFeatureOverride(info.flagKey, true)
  await loadProductFeatures(true)
  syncFromRoute()
}

function updateMobileState(): void {
  if (typeof window === 'undefined') return
  const mediaQueryMatches = matchesMediaQuery('(max-width: 899px)')

  const docWidth = typeof document !== 'undefined'
    ? document.documentElement?.clientWidth
    : 0
  const viewportWidth = window.visualViewport?.width ?? 0
  const width = Math.max(viewportWidth || 0, docWidth || 0) || window.innerWidth
  const narrowViewport = mediaQueryMatches || width < 900

  // Narrow desktop/headless windows should still be usable.
  // Only gate desktop-first tabs when the runtime also looks mobile/touch-first.
  isMobile.value = narrowViewport && hasMobileRuntimeSignals()
}

function normalizeTab(value: unknown): AttendanceTab {
  if (value === 'admin' || value === 'workflow' || value === 'overview' || value === 'reports' || value === 'import') return value
  return 'overview'
}

function ensureTabAllowed(nextTab: AttendanceTab): AttendanceTab {
  const candidates = availableTabs.value.map((tab) => tab.id)
  if (candidates.includes(nextTab)) return nextTab
  return 'overview'
}

function syncFromRoute(): void {
  if (groupRoutePathActive.value) {
    if (!routeGroupContext.value) {
      void router.replace({
        name: 'not-found',
        params: { pathMatch: route.path.replace(/^\//, '').split('/') },
      })
      return
    }
    activeTab.value = ensureTabAllowed('admin')
    return
  }
  const queryTab = normalizeTab(route.query.tab)
  activeTab.value = ensureTabAllowed(queryTab)
}

async function selectTab(tab: AttendanceTab): Promise<void> {
  const nextTab = ensureTabAllowed(tab)
  // W4-2 OD-W4-7② (切区确认 leg): switching top tabs swaps `component :is` and unmounts the
  // admin host — an applied-but-unsaved template prefill would be discarded silently (no
  // beforeunload, no route leave). Same confirm as the route-leave guard above.
  if (nextTab !== activeTab.value && !confirmAttendanceSetupPrefillLeave(setupPrefillLeaveTr)) {
    return
  }
  activeTab.value = nextTab

  // Navigability audit fix 3: merge onto the existing query instead of replacing it outright —
  // the prior `{}` (overview) / `{ tab }` (everything else) replacement dropped every OTHER query
  // param on every tab switch, and Overview could never be deep-linked since it wrote no `tab` at
  // all. `section`/`requestId` are TAB-SCOPED (a deep-linked admin section or a focused request
  // from the previous tab has no meaning once the destination tab no longer hosts that surface),
  // so they are dropped on every tab switch — mirroring `returnToAdminHome()`'s existing
  // `delete query.section` discipline just below. `surface`/`returnTo` are orthogonal to `tab`
  // and are preserved.
  const query: LocationQueryRaw = { ...route.query, tab: nextTab }
  delete query.section
  delete query.requestId
  await router.replace({ query })
}

// Admin center's "Management home" return action (vNext charter §7 Wave 3):
// keep the `admin`/`import` tab but drop any deep-linked `section`, so a
// route refresh does not re-open the section the operator just left.
async function returnToAdminHome(): Promise<void> {
  const query: LocationQueryRaw = { ...route.query, tab: 'admin' }
  delete query.section
  await router.replace({ query })
}

async function returnFromGroupRoute(): Promise<void> {
  if (groupRouteActive.value) {
    await router.push(routeGroupContext.value?.returnTo ?? '/attendance?tab=admin&section=attendance-admin-groups')
    return
  }
  await selectTab('overview')
}

async function openGroupRoute(target: {
  groupId: string
  step: AttendanceGroupRouteStep
  surface: AttendanceGroupRouteSurface | null
}): Promise<void> {
  if (groupRouteActive.value && routeGroupContext.value?.groupId !== target.groupId) return
  const href = buildAttendanceGroupRouteHref({
    ...target,
    returnTo: groupRouteActive.value
      ? routeGroupContext.value?.returnTo ?? '/attendance?tab=admin&section=attendance-admin-groups'
      : route.fullPath,
  })
  if (!href) return
  await router.push(href)
}

watch(() => [route.path, route.name, route.query.tab, route.query.surface, route.query.returnTo, route.params?.groupId, route.params?.step], () => {
  if (!featuresReady.value) return
  syncFromRoute()
})

watch(availableTabs, () => {
  if (!featuresReady.value) return
  activeTab.value = ensureTabAllowed(activeTab.value)
})

onMounted(async () => {
  await loadProductFeatures()
  updateMobileState()
  syncFromRoute()
  featuresReady.value = true
  window.addEventListener('resize', updateMobileState)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', updateMobileState)
})
</script>

<style scoped>
.attendance-shell {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.attendance-shell__tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.attendance-shell__tab {
  border: 1px solid #d1d5db;
  background: #fff;
  color: #374151;
  border-radius: 8px;
  padding: 8px 14px;
  cursor: pointer;
}

.attendance-shell__tab--active {
  border-color: #2563eb;
  color: #2563eb;
  background: #eff6ff;
}

.attendance-shell__desktop-hint {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 20px;
  display: grid;
  gap: 10px;
}

.attendance-shell__desktop-hint h3 {
  margin: 0;
}

.attendance-shell__desktop-hint p {
  margin: 0;
  color: #4b5563;
}

.attendance-shell__btn {
  width: fit-content;
  border: 1px solid #d1d5db;
  background: #fff;
  color: #111827;
  border-radius: 8px;
  padding: 8px 12px;
  cursor: pointer;
}

.attendance-shell__loading {
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 20px;
  color: #4b5563;
}
</style>
