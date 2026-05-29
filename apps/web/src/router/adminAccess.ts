import type { RouteLocationNormalized } from 'vue-router'
import type { useAuth } from '../composables/useAuth'
import type { useFeatureFlags } from '../stores/featureFlags'

type AuthAccess = Pick<ReturnType<typeof useAuth>, 'hasAdminAccess'>
type FeatureFlagAccess = Pick<ReturnType<typeof useFeatureFlags>, 'loadProductFeatures' | 'resolveHomePath'>

export async function resolveAdminRouteRedirect(
  to: Pick<RouteLocationNormalized, 'meta'>,
  auth: AuthAccess,
  flags: FeatureFlagAccess,
): Promise<string | null> {
  if (to.meta?.requiresAdmin !== true) return null
  if (auth.hasAdminAccess()) return null

  try {
    await flags.loadProductFeatures()
  } catch {
    // Keep the admin boundary closed even when feature probing is temporarily unavailable.
  }

  return flags.resolveHomePath()
}
