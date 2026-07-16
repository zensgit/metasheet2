<template>
  <div id="app">
    <nav class="app-nav" v-if="showNav" aria-label="Primary navigation">
      <router-link class="nav-brand" to="/apps" aria-label="MetaSheet">
        <span class="brand-mark" aria-hidden="true">MS</span>
        <span class="brand-text">{{ brandText }}</span>
      </router-link>
      <div class="nav-links" aria-label="Workspace navigation">
        <router-link v-if="attendanceFocused" to="/attendance" class="nav-link">{{ navLabels.attendance }}</router-link>

        <template v-else>
          <template v-if="plmWorkbenchFocused">
            <router-link to="/plm" class="nav-link">{{ navLabels.plm }}</router-link>
            <router-link v-if="canUsePlm" to="/plm/audit" class="nav-link">{{ navLabels.audit }}</router-link>
            <router-link v-if="hasFeature('workflow')" to="/workflows" class="nav-link">{{ navLabels.workflows }}</router-link>
            <router-link v-if="canUseApprovals" to="/approvals" class="nav-link">{{ navLabels.approvals }}</router-link>
          </template>
          <template v-else>
            <router-link v-if="hasFeature('attendance')" to="/attendance" class="nav-link">{{ navLabels.attendance }}</router-link>
            <router-link v-if="canUseAppCenter" to="/apps" class="nav-link">{{ navLabels.apps }}</router-link>
            <router-link to="/multitable" class="nav-link">{{ navLabels.multitable }}</router-link>
            <router-link v-if="hasFeature('workflow')" to="/workflows" class="nav-link">{{ navLabels.workflows }}</router-link>
            <router-link v-if="canUseApprovals" to="/approvals" class="nav-link">{{ navLabels.approvals }}</router-link>
            <details v-if="canUseIntegration || canUsePlm" class="nav-menu">
              <summary class="nav-menu__trigger">{{ navLabels.operations }}</summary>
              <div class="nav-menu__panel" role="group" :aria-label="navLabels.operations">
                <router-link v-if="canUseIntegration" to="/integrations/workbench" class="nav-menu__item">{{ navLabels.systemIntegration }}</router-link>
                <router-link v-if="canUseIntegration" to="/stock-prep" class="nav-menu__item">{{ navLabels.stockPreparation }}</router-link>
                <router-link v-if="canUseIntegration" to="/data-sources" class="nav-menu__item">{{ navLabels.dataSources }}</router-link>
                <router-link v-if="canUsePlm" to="/plm" class="nav-menu__item">{{ navLabels.plm }}</router-link>
                <router-link v-if="canUsePlm" to="/plm/audit" class="nav-menu__item">{{ navLabels.audit }}</router-link>
              </div>
            </details>
            <details v-if="canManageUsers || isAdmin" class="nav-menu">
              <summary class="nav-menu__trigger">{{ navLabels.management }}</summary>
              <div class="nav-menu__panel" role="group" :aria-label="navLabels.management">
                <router-link v-if="canManageUsers" to="/admin/users" class="nav-menu__item">{{ navLabels.users }}</router-link>
                <router-link v-if="canManageUsers" to="/admin/roles" class="nav-menu__item">{{ navLabels.roles }}</router-link>
                <router-link v-if="canManageUsers" to="/admin/permissions" class="nav-menu__item">{{ navLabels.permissions }}</router-link>
                <router-link v-if="canManageUsers" to="/admin/audit" class="nav-menu__item">{{ navLabels.adminAudit }}</router-link>
                <router-link v-if="canManageUsers" to="/admin/automation-executions" class="nav-menu__item">{{ navLabels.automationRuns }}</router-link>
                <router-link v-if="canManageUsers" to="/approvals/metrics" class="nav-menu__item">{{ navLabels.approvalMetrics }}</router-link>
                <router-link v-if="isAdmin" to="/admin/plugins" class="nav-menu__item">{{ navLabels.plugins }}</router-link>
              </div>
            </details>
            <details v-if="pluginNavItems.length" class="nav-menu">
              <summary class="nav-menu__trigger">{{ navLabels.extensions }}</summary>
              <div class="nav-menu__panel" role="group" :aria-label="navLabels.extensions">
                <router-link v-for="item in pluginNavItems" :key="item.id" :to="item.path" class="nav-menu__item">
                  {{ item.label }}
                </router-link>
              </div>
            </details>
          </template>
        </template>
      </div>

      <div class="nav-actions">
        <label class="nav-locale">
          <select
            class="nav-locale__select"
            data-testid="locale-switcher"
            :aria-label="navLabels.language"
            :title="navLabels.language"
            :value="locale"
            @change="onLocaleChange"
          >
            <option value="en">English</option>
            <option value="zh-CN">中文</option>
          </select>
        </label>
        <template v-if="isLoggedIn">
          <details class="nav-account">
            <summary class="nav-account__trigger" :title="accountEmail || navLabels.account">
              <span class="nav-account__avatar" aria-hidden="true">{{ accountInitial }}</span>
              <span v-if="accountEmail" class="nav-user">{{ accountEmail }}</span>
            </summary>
            <div class="nav-account__panel">
              <span v-if="accountEmail" class="nav-account__email">{{ accountEmail }}</span>
              <router-link to="/settings" class="nav-menu__item">{{ navLabels.mySessions }}</router-link>
              <button class="nav-menu__item nav-menu__item--button" type="button" @click="logout">{{ navLabels.signOut }}</button>
            </div>
          </details>
        </template>
      </div>
    </nav>
    <!-- CI trigger: lockfile update -->
    <main class="app-main">
      <router-view />
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useAuth } from './composables/useAuth'
import { useLocale } from './composables/useLocale'
import { usePlugins } from './composables/usePlugins'
import { usePlatformApps } from './composables/usePlatformApps'
import { setMultitableApiErrorLocaleResolver } from './multitable/api/client'
import { resolveRouteDocumentTitle } from './router/routeTitles'
import { useFeatureFlags } from './stores/featureFlags'
import { clearStoredAuthState, getApiBase } from './utils/api'

const route = useRoute()
const { navItems: pluginNavItems, fetchPlugins } = usePlugins()
const { apps: platformApps, fetchApps: fetchPlatformApps } = usePlatformApps()
const { isAttendanceFocused, isPlmWorkbenchFocused, hasFeature, loadProductFeatures } = useFeatureFlags()
const { clearToken, getAccessSnapshot, getToken, hasPermission } = useAuth()
const { locale, isZh, setLocale } = useLocale()
setMultitableApiErrorLocaleResolver(() => isZh.value)

const showNav = computed(() => {
  return route.meta?.hideNavbar !== true
})

const isPublicRoute = computed(() => {
  return route.path === '/login'
    || route.meta?.requiresAuth === false
    || route.meta?.requiresGuest === true
    || route.meta?.skipShellBootstrap === true
})
const attendanceFocused = computed(() => isAttendanceFocused())
const plmWorkbenchFocused = computed(() => isPlmWorkbenchFocused())
const isAdmin = computed(() => hasFeature('attendanceAdmin'))
const canManageUsers = computed(() => {
  void route.fullPath
  return getAccessSnapshot().isAdmin
})
const canUseAppCenter = computed(() => canManageUsers.value || platformApps.value.length > 0)
const canUseIntegration = computed(() => {
  void route.fullPath
  return hasPermission('integration:write')
})
const canUseApprovals = computed(() => {
  void route.fullPath
  return hasPermission('approvals:read')
})
const isLoggedIn = computed(() => {
  void route.fullPath
  return Boolean(getToken())
})
const canUsePlm = computed(() => hasFeature('plm'))
const navLabels = computed(() => {
  if (isZh.value) {
    return {
      attendance: '考勤',
      multitable: '多维表',
      workflows: '流程',
      approvals: '审批中心',
      apps: '应用中心',
      users: '用户',
      roles: '角色',
      permissions: '权限',
      adminAudit: '管理审计',
      automationRuns: '自动化运行',
      approvalMetrics: '审批 SLA',
      systemIntegration: '数据工厂',
      stockPreparation: '备料工作台',
      dataSources: '外接数据源',
      operations: '运营',
      management: '管理',
      extensions: '扩展',
      plugins: '插件',
      plm: 'PLM',
      audit: '审计',
      plmWorkbench: 'PLM 工作台',
      mySessions: '我的会话',
      signOut: '退出登录',
      language: '语言',
      account: '账户',
    }
  }
  return {
    attendance: 'Attendance',
    multitable: 'Multitable',
    workflows: 'Workflows',
    approvals: 'Approvals',
    apps: 'App Center',
    users: 'Users',
    roles: 'Roles',
    permissions: 'Permissions',
    adminAudit: 'Admin Audit',
    automationRuns: 'Automation Runs',
    approvalMetrics: 'Approval SLA',
    systemIntegration: 'Data Factory',
    stockPreparation: 'Stock Preparation',
    dataSources: 'Data Sources',
    operations: 'Operations',
    management: 'Management',
    extensions: 'Extensions',
    plugins: 'Plugins',
    plm: 'PLM',
    audit: 'Audit',
    plmWorkbench: 'PLM Workbench',
    mySessions: 'My Sessions',
    signOut: 'Sign out',
    language: 'Language',
    account: 'Account',
  }
})

const brandText = computed(() => {
  if (attendanceFocused.value) return navLabels.value.attendance
  if (plmWorkbenchFocused.value) return navLabels.value.plmWorkbench
  return 'MetaSheet'
})

const documentTitle = computed(() => resolveRouteDocumentTitle(route.meta, isZh.value))

const accountEmail = computed(() => {
  void route.fullPath
  return getAccessSnapshot().email
})

const accountInitial = computed(() => accountEmail.value?.trim().charAt(0).toUpperCase() || 'M')

async function logout(): Promise<void> {
  const token = getToken()
  clearToken()
  try {
    clearStoredAuthState()
  } catch {
    // Ignore local session cleanup failures; logout should still leave the view.
  }
  if (token) {
    try {
      void fetch(`${getApiBase()}/api/auth/logout`, {
        method: 'POST',
        keepalive: true,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }).catch(() => null)
    } catch {
      // Ignore logout network failures and still clear local session.
    }
  }
  window.location.assign('/login')
}

function onLocaleChange(event: Event): void {
  const target = event.target as HTMLSelectElement | null
  if (!target) return
  setLocale(target.value)
}

onMounted(async () => {
  await loadProductFeatures(false, {
    skipSessionProbe: isPublicRoute.value,
  }).catch(() => null)
  if (isPublicRoute.value || attendanceFocused.value || plmWorkbenchFocused.value) {
    return
  }
  await Promise.all([
    fetchPlugins(),
    fetchPlatformApps(),
  ])
})

watch(documentTitle, (nextTitle) => {
  if (typeof document === 'undefined') return
  document.title = nextTitle
}, { immediate: true })
</script>

<style>
/* Reset and base styles */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html, body {
  height: 100%;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: #333;
  background-color: var(--ms-bg-page);
}

#app {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.app-nav {
  display: flex;
  align-items: center;
  gap: 16px;
  min-height: 56px;
  padding: 0 18px;
  background: #ffffff;
  border-bottom: 1px solid #dce4ee;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
}

.nav-brand {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 8px;
  color: inherit;
  text-decoration: none;
}

.brand-mark {
  display: inline-grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border-radius: 7px;
  background: #0f766e;
  color: #ffffff;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0;
}

.brand-text {
  color: #0f172a;
  font-size: 15px;
  font-weight: 700;
  white-space: nowrap;
}

.nav-links {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
}

.nav-links::-webkit-scrollbar {
  display: none;
}

.nav-actions {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: 8px;
  min-width: 0;
}

.nav-user {
  color: #6b7280;
  font-size: 13px;
  max-width: clamp(120px, 18vw, 260px);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nav-locale {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
  white-space: nowrap;
}

.nav-locale__select {
  height: 32px;
  border: 1px solid #d5deea;
  border-radius: 6px;
  padding: 0 7px;
  background: #f8fafc;
  color: #475569;
  font-size: 12px;
  font-weight: 600;
}

.nav-link,
.nav-menu__trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  min-height: 32px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: 6px;
  text-decoration: none;
  color: #526174;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.2;
  transition: border-color 0.16s ease, background-color 0.16s ease, color 0.16s ease;
  white-space: nowrap;
}

.nav-link:hover,
.nav-menu__trigger:hover {
  background: #f1f5f9;
  color: #0f172a;
}

.nav-link.router-link-active {
  border-color: #c7e5df;
  background: #eaf7f4;
  color: #0f766e;
}

.nav-menu,
.nav-account {
  position: relative;
  flex: 0 0 auto;
}

.nav-menu__trigger,
.nav-account__trigger {
  list-style: none;
  cursor: pointer;
}

.nav-menu__trigger::-webkit-details-marker,
.nav-account__trigger::-webkit-details-marker {
  display: none;
}

.nav-menu__trigger::after {
  content: '';
  width: 5px;
  height: 5px;
  margin-left: 7px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: translateY(-2px) rotate(45deg);
}

.nav-menu[open] .nav-menu__trigger {
  border-color: #d5deea;
  background: #f8fafc;
  color: #0f172a;
}

.nav-menu__panel,
.nav-account__panel {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 30;
  display: grid;
  min-width: 184px;
  padding: 6px;
  border: 1px solid #dbe4ef;
  border-radius: 8px;
  background: #ffffff;
  box-shadow: 0 12px 28px rgba(15, 23, 42, 0.14);
}

.nav-menu__item {
  display: flex;
  align-items: center;
  min-height: 34px;
  padding: 0 9px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #334155;
  font: inherit;
  font-size: 13px;
  text-align: left;
  text-decoration: none;
  white-space: nowrap;
}

.nav-menu__item:hover,
.nav-menu__item.router-link-active {
  background: #eff6f5;
  color: #0f766e;
}

.nav-menu__item--button {
  width: 100%;
  cursor: pointer;
}

.nav-account__trigger {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 32px;
  padding: 0 4px;
}

.nav-account__avatar {
  display: inline-grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border: 1px solid #b7d9d1;
  border-radius: 50%;
  background: #eaf7f4;
  color: #0f766e;
  font-size: 12px;
  font-weight: 700;
}

.nav-account[open] .nav-account__avatar {
  border-color: #0f766e;
}

.nav-account__panel {
  min-width: 208px;
}

.nav-account__email {
  display: block;
  padding: 6px 9px 8px;
  border-bottom: 1px solid #e6edf5;
  color: #64748b;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.app-main {
  flex: 1;
  overflow: auto;
}

@media (max-width: 768px) {
  .app-nav {
    gap: 10px;
    padding: 0 12px;
  }

  .nav-links {
    gap: 2px;
  }

  .nav-link,
  .nav-menu__trigger {
    padding: 0 8px;
  }

  .nav-user {
    display: none;
  }

  .nav-menu__panel,
  .nav-account__panel {
    position: fixed;
    top: 62px;
    right: 12px;
    left: 12px;
    min-width: 0;
  }
}

@media (max-width: 480px) {
  .app-nav {
    gap: 8px;
    padding: 0 10px;
  }

  .brand-text {
    display: none;
  }

  .nav-locale__select {
    width: 38px;
    padding: 0 3px;
  }
}

/* Dark mode support */
@media (prefers-color-scheme: dark) {
  html, body {
    background-color: #1a1a1a;
    color: #e0e0e0;
  }

  .app-nav {
    background: #17212f;
    border-bottom-color: #334155;
  }

  .brand-text {
    color: #e2e8f0;
  }

  .nav-link,
  .nav-menu__trigger {
    color: #cbd5e1;
  }

  .nav-link:hover,
  .nav-menu__trigger:hover {
    background: #263548;
    color: #ffffff;
  }

  .nav-link.router-link-active {
    border-color: #2d8278;
    background: #173f3a;
    color: #8de0d2;
  }
}
</style>
