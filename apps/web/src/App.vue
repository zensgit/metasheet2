<template>
  <div id="app">
    <nav class="app-nav" v-if="showNav">
      <div class="nav-brand">
        <span class="brand-text">{{ brandText }}</span>
      </div>
      <div class="nav-links">
        <template v-if="attendanceFocused">
          <router-link to="/attendance" class="nav-link">{{ navLabels.attendance }}</router-link>
          <router-link v-if="canAccessDirectoryAdmin" to="/admin/directory" class="nav-link">{{ navLabels.directory }}</router-link>
        </template>

        <template v-else>
          <router-link to="/grid" class="nav-link">{{ navLabels.grid }}</router-link>
          <router-link to="/spreadsheets" class="nav-link">{{ navLabels.spreadsheets }}</router-link>
          <router-link to="/kanban" class="nav-link">{{ navLabels.kanban }}</router-link>
          <router-link to="/calendar" class="nav-link">{{ navLabels.calendar }}</router-link>
          <router-link to="/gallery" class="nav-link">{{ navLabels.gallery }}</router-link>
          <router-link to="/form" class="nav-link">{{ navLabels.form }}</router-link>
          <router-link
            v-for="item in pluginNavItems"
            :key="item.id"
            :to="item.path"
            class="nav-link"
          >
            {{ item.label }}
          </router-link>
          <router-link v-if="canAccessDirectoryAdmin" to="/admin/directory" class="nav-link">{{ navLabels.directory }}</router-link>
          <router-link v-if="canAccessAttendanceAdmin" to="/admin/plugins" class="nav-link">{{ navLabels.plugins }}</router-link>
          <router-link to="/plm" class="nav-link">{{ navLabels.plm }}</router-link>
        </template>
      </div>

      <div class="nav-actions">
        <label class="nav-locale">
          <span class="nav-locale__label">{{ navLabels.language }}</span>
          <select class="nav-locale__select" :value="locale" @change="onLocaleChange">
            <option value="en">English</option>
            <option value="zh-CN">中文</option>
          </select>
        </label>
        <template v-if="attendanceFocused">
          <span v-if="accountEmail" class="nav-user">{{ accountEmail }}</span>
          <button class="nav-link nav-link--button" type="button" @click="logout">{{ navLabels.signOut }}</button>
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
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useAuth } from './composables/useAuth'
import { useLocale } from './composables/useLocale'
import { usePlugins } from './composables/usePlugins'
import { useFeatureFlags } from './stores/featureFlags'
import { getApiBase } from './utils/api'

const route = useRoute()
const { navItems: pluginNavItems, fetchPlugins } = usePlugins()
const { loadProductFeatures, isAttendanceFocused, hasFeature } = useFeatureFlags()
const { locale, isZh, setLocale } = useLocale()
const auth = useAuth()

const showNav = computed(() => {
  return route.meta?.hideNavbar !== true
})

const attendanceFocused = computed(() => isAttendanceFocused())
const canAccessAttendanceAdmin = computed(() => hasFeature('attendanceAdmin'))
const canAccessDirectoryAdmin = computed(() => hasFeature('platformAdmin'))
const navLabels = computed(() => {
  if (isZh.value) {
    return {
      attendance: '考勤',
      directory: '目录同步',
      grid: '表格',
      spreadsheets: '电子表格',
      kanban: '看板',
      calendar: '日历',
      gallery: '画廊',
      form: '表单',
      plugins: '插件',
      plm: 'PLM',
      signOut: '退出登录',
      language: '语言',
    }
  }
  return {
    attendance: 'Attendance',
    directory: 'Directory',
    grid: 'Grid',
    spreadsheets: 'Spreadsheets',
    kanban: 'Kanban',
    calendar: 'Calendar',
    gallery: 'Gallery',
    form: 'Form',
    plugins: 'Plugins',
    plm: 'PLM',
    signOut: 'Sign out',
    language: 'Language',
  }
})

const brandText = computed(() => {
  if (attendanceFocused.value) return navLabels.value.attendance
  return 'MetaSheet'
})

const accountEmail = computed(() => auth.getAccessSnapshot().user.email)

async function logout(): Promise<void> {
  const redirect = typeof route.fullPath === 'string' && route.fullPath.length > 0
    ? route.fullPath
    : '/attendance'

  try {
    const token = auth.getToken()
    if (token) {
      await fetch(`${getApiBase()}/api/auth/logout`, {
        method: 'POST',
        headers: auth.buildAuthHeaders(),
      })
    }
  } catch {
    // Ignore logout transport failures; the client still needs to terminate its local session.
  }

  auth.clearToken()
  window.location.assign(`/login?redirect=${encodeURIComponent(redirect)}`)
}

function onLocaleChange(event: Event): void {
  const target = event.target as HTMLSelectElement | null
  if (!target) return
  setLocale(target.value)
}

onMounted(async () => {
  await loadProductFeatures()
  await fetchPlugins()
})
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
  background-color: #f5f5f5;
}

#app {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.app-nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  height: 50px;
  background: #fff;
  border-bottom: 1px solid #e0e0e0;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
}

.nav-brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.brand-text {
  font-size: 18px;
  font-weight: 600;
  color: #1976d2;
}

.nav-links {
  display: flex;
  gap: 8px;
}

.nav-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.nav-user {
  color: #6b7280;
  font-size: 13px;
}

.nav-locale {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.nav-locale__label {
  color: #6b7280;
  font-size: 12px;
}

.nav-locale__select {
  border: 1px solid #d1d5db;
  border-radius: 6px;
  padding: 4px 6px;
  background: #fff;
  color: #374151;
}

.nav-link {
  padding: 8px 16px;
  text-decoration: none;
  color: #666;
  border-radius: 4px;
  transition: all 0.2s;
}

.nav-link--button {
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
}

.nav-link:hover {
  background-color: #f0f0f0;
  color: #333;
}

.nav-link.router-link-active {
  background-color: #e3f2fd;
  color: #1976d2;
}

.app-main {
  flex: 1;
  overflow: auto;
}

/* Dark mode support */
@media (prefers-color-scheme: dark) {
  html, body {
    background-color: #1a1a1a;
    color: #e0e0e0;
  }

  .app-nav {
    background: #2d2d2d;
    border-bottom-color: #404040;
  }

  .brand-text {
    color: #64b5f6;
  }

  .nav-link {
    color: #aaa;
  }

  .nav-link:hover {
    background-color: #3d3d3d;
    color: #fff;
  }

  .nav-link.router-link-active {
    background-color: #1e3a5f;
    color: #64b5f6;
  }
}
</style>
