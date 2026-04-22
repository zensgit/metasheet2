/**
 * Vue Application Entry Point
 */
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createRouter, createWebHistory } from 'vue-router'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import App from './App.vue'
import { useAuth } from './composables/useAuth'
import { appRoutes } from './router/appRoutes'
import { ROUTE_PATHS } from './router/types'
import { resolveRouteDocumentTitle } from './router/routeTitles'
import { useFeatureFlags } from './stores/featureFlags'
import { normalizePostLoginRedirect, normalizePreLoginRedirect, shouldSkipPreLoginRedirectQuery } from './utils/authRedirect'

const router = createRouter({
  history: createWebHistory(),
  routes: appRoutes,
})

function requiresPasswordChange(user: unknown): boolean {
  if (!user || typeof user !== 'object') return false
  const record = user as Record<string, unknown>
  return record.must_change_password === true || record.mustChangePassword === true
}

router.beforeEach(async (to, _from, next) => {
  const auth = useAuth()
  const token = auth.getToken()
  const isLoginRoute = to.path === ROUTE_PATHS.LOGIN
  const isForcePasswordChangeRoute = to.path === ROUTE_PATHS.FORCE_PASSWORD_CHANGE
  const requiresAuth = to.meta?.requiresAuth !== false
  const flags = useFeatureFlags()
  const localeRaw =
    typeof window !== 'undefined'
      ? window.localStorage.getItem('metasheet_locale') || window.navigator?.language || ''
      : ''
  const isZh = /^zh/i.test(localeRaw)
  document.title = resolveRouteDocumentTitle(to.meta, isZh)

  if (isLoginRoute) {
    if (token) {
      const session = await auth.bootstrapSession()
      if (session.ok) {
        if (requiresPasswordChange(auth.getCurrentUser())) {
          return next(ROUTE_PATHS.FORCE_PASSWORD_CHANGE)
        }
        try {
          await flags.loadProductFeatures()
        } catch {
          // Fall back to shell redirect when feature probing is temporarily unavailable.
        }
        const redirect = normalizePostLoginRedirect(to.query?.redirect)
        return next(redirect || flags.resolveHomePath())
      }
    }
    return next()
  }

  if (requiresAuth) {
    const requestedPath = to.fullPath || ROUTE_PATHS.ATTENDANCE
    const redirect = normalizePreLoginRedirect(requestedPath)
    const ensuredToken = token || await auth.ensureToken()
    if (!ensuredToken) {
      return next(
        shouldSkipPreLoginRedirectQuery(requestedPath)
          ? { path: ROUTE_PATHS.LOGIN }
          : { path: ROUTE_PATHS.LOGIN, query: { redirect } }
      )
    }

    const session = await auth.bootstrapSession()
    if (!session.ok) {
      return next(
        shouldSkipPreLoginRedirectQuery(requestedPath)
          ? { path: ROUTE_PATHS.LOGIN }
          : { path: ROUTE_PATHS.LOGIN, query: { redirect } }
      )
    }

    const currentUser = auth.getCurrentUser()
    const mustChangePassword = requiresPasswordChange(currentUser)
    if (mustChangePassword && !isForcePasswordChangeRoute) {
      return next(ROUTE_PATHS.FORCE_PASSWORD_CHANGE)
    }
    if (!mustChangePassword && isForcePasswordChangeRoute) {
      try {
        await flags.loadProductFeatures()
      } catch {
        // Ignore transient feature load failures and fall back to default home.
      }
      return next(flags.resolveHomePath())
    }
  }

  try {
    if (to.meta?.skipShellBootstrap === true) {
      return next()
    }
    await flags.loadProductFeatures()

    const required = to.meta?.requiredFeature
    const requiredFeature =
      required === 'attendance'
      || required === 'workflow'
      || required === 'attendanceAdmin'
      || required === 'attendanceImport'
      || required === 'plm'
        ? required
        : null

    if (requiredFeature && !flags.hasFeature(requiredFeature)) {
      return next(flags.resolveHomePath())
    }

    if (flags.isAttendanceFocused()) {
      const allowed = new Set<string>([
        '/attendance',
        '/p/plugin-attendance/attendance',
        '/settings',
      ])
      const path = String(to.path || '')
      if (!allowed.has(path)) {
        return next('/attendance')
      }
    }

    if (typeof flags.isPlmWorkbenchFocused === 'function' && flags.isPlmWorkbenchFocused()) {
      const path = String(to.path || '')
      const allowedPrefixes = ['/plm', '/workflows', '/approvals']
      const allowed = allowedPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
      if (!allowed) {
        return next('/plm')
      }
    }
  } catch {
    // If guard fails (network/offline), don't block navigation.
  }

  next()
})

async function bootstrap(): Promise<void> {
  const app = createApp(App)
  app.use(ElementPlus)
  app.use(createPinia())
  app.use(router)

  await router.isReady()
  app.mount('#app')
}

if (import.meta.env.MODE !== 'test') {
  void bootstrap()
}
