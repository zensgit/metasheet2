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
      <button class="attendance-shell__btn" type="button" @click="selectTab('overview')">
        {{ t.backToOverview }}
      </button>
    </section>

    <component
      v-else-if="activeView"
      :is="activeView.component"
      :key="activeView.key"
      v-bind="activeView.props"
    />
    <section v-else class="attendance-shell__desktop-hint">
      <h3>{{ t.capabilityUnavailable }}</h3>
      <p>{{ t.capabilityHint }}</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useLocale } from '../../composables/useLocale'
import { useFeatureFlags } from '../../stores/featureFlags'
import AttendanceOverview from './AttendanceOverview.vue'
import AttendanceReportsView from './AttendanceReportsView.vue'
import AttendanceAdminCenter from './AttendanceAdminCenter.vue'
import AttendanceWorkflowDesigner from './AttendanceWorkflowDesigner.vue'

type AttendanceTab = 'overview' | 'reports' | 'admin' | 'import' | 'workflow'

const route = useRoute()
const router = useRouter()
const { hasFeature, loadProductFeatures } = useFeatureFlags()
const { isZh } = useLocale()

const activeTab = ref<AttendanceTab>('overview')
const featuresReady = ref(false)
const isMobile = ref(false)

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

const activeView = computed(() => {
  switch (activeTab.value) {
    case 'overview':
      return {
        component: AttendanceOverview,
        key: 'attendance-overview',
        props: {},
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
        props: {},
      }
    case 'import':
      if (!canAccessAdmin.value) return null
      return {
        component: AttendanceAdminCenter,
        key: 'attendance-import',
        props: { initialSectionId: 'attendance-admin-import' },
      }
    case 'workflow':
      if (!canAccessWorkflow.value) return null
      return {
        component: AttendanceWorkflowDesigner,
        key: 'attendance-workflow',
        props: { canDesign: canAccessWorkflow.value },
      }
  }
})

function updateMobileState(): void {
  if (typeof window === 'undefined') return
  // Prefer media query (most stable) then fallback to viewport measurements.
  // Some environments can report a scaled `innerWidth` even when the CSS viewport is narrow.
  try {
    if (window.matchMedia?.('(max-width: 899px)')?.matches) {
      isMobile.value = true
      return
    }
  } catch {
    // ignore
  }

  const docWidth = typeof document !== 'undefined'
    ? document.documentElement?.clientWidth
    : 0
  const viewportWidth = window.visualViewport?.width ?? 0
  const width = Math.max(viewportWidth || 0, docWidth || 0) || window.innerWidth

  // NOTE: `window.innerWidth` can be misleading on mobile due to viewport scaling.
  // Prefer visualViewport / clientWidth for consistent gating.
  isMobile.value = width < 900
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
  const queryTab = normalizeTab(route.query.tab)
  activeTab.value = ensureTabAllowed(queryTab)
}

async function selectTab(tab: AttendanceTab): Promise<void> {
  const nextTab = ensureTabAllowed(tab)
  activeTab.value = nextTab

  // Keep this page-level state isolated to `tab`.
  const query = nextTab === 'overview' ? {} : { tab: nextTab }
  await router.replace({ query })
}

watch(() => route.query.tab, () => {
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
