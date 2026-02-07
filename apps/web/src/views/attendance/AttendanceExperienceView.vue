<template>
  <div class="attendance-shell">
    <nav class="attendance-shell__tabs" aria-label="Attendance sections">
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

    <section v-if="desktopOnlyBlocked" class="attendance-shell__desktop-hint">
      <h3>Desktop recommended</h3>
      <p>{{ desktopOnlyMessage }}</p>
      <button class="attendance-shell__btn" type="button" @click="selectTab('overview')">
        Back to Overview
      </button>
    </section>

    <AttendanceOverview
      v-else-if="activeTab === 'overview'"
    />
    <AttendanceAdminCenter
      v-else-if="activeTab === 'admin' && canAccessAdmin"
    />
    <AttendanceWorkflowDesigner
      v-else-if="activeTab === 'workflow'"
      :can-design="canAccessWorkflow"
    />
    <section v-else class="attendance-shell__desktop-hint">
      <h3>Capability not available</h3>
      <p>Current account does not have access to this section.</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useFeatureFlags } from '../../stores/featureFlags'
import AttendanceOverview from './AttendanceOverview.vue'
import AttendanceAdminCenter from './AttendanceAdminCenter.vue'
import AttendanceWorkflowDesigner from './AttendanceWorkflowDesigner.vue'

type AttendanceTab = 'overview' | 'admin' | 'workflow'

const route = useRoute()
const router = useRouter()
const { hasFeature, loadProductFeatures } = useFeatureFlags()

const activeTab = ref<AttendanceTab>('overview')
const isMobile = ref(false)

const canAccessAdmin = computed(() => hasFeature('attendanceAdmin'))
const canAccessWorkflow = computed(() => hasFeature('workflow'))
const desktopOnlyTabs: AttendanceTab[] = ['admin', 'workflow']

const availableTabs = computed<Array<{ id: AttendanceTab; label: string }>>(() => {
  const tabs: Array<{ id: AttendanceTab; label: string }> = [
    { id: 'overview', label: 'Overview' },
  ]

  if (canAccessAdmin.value) {
    tabs.push({ id: 'admin', label: 'Admin Center' })
  }

  if (canAccessWorkflow.value) {
    tabs.push({ id: 'workflow', label: 'Workflow Designer' })
  }

  return tabs
})

const desktopOnlyBlocked = computed(() => isMobile.value && desktopOnlyTabs.includes(activeTab.value))

const desktopOnlyMessage = computed(() => {
  if (activeTab.value === 'workflow') {
    return 'Workflow designer is desktop-only in this release. Use desktop for editing and publishing flows.'
  }
  return 'Admin center is desktop-first. Use desktop to manage import, rules, and payroll settings.'
})

function updateMobileState(): void {
  if (typeof window === 'undefined') return
  isMobile.value = window.innerWidth < 900
}

function normalizeTab(value: unknown): AttendanceTab {
  if (value === 'admin' || value === 'workflow' || value === 'overview') return value
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
  syncFromRoute()
})

watch(availableTabs, () => {
  activeTab.value = ensureTabAllowed(activeTab.value)
})

onMounted(async () => {
  await loadProductFeatures()
  updateMobileState()
  syncFromRoute()
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
</style>
