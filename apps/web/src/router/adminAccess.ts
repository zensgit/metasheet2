import type { RouteLocationNormalized } from 'vue-router'
import type { AdminAccessCapabilities } from '../composables/adminAccessCapabilities'
import type { useAuth } from '../composables/useAuth'
import type { useFeatureFlags } from '../stores/featureFlags'

type AuthAccess = Pick<ReturnType<typeof useAuth>, 'hasAdminAccess'>
type FeatureFlagAccess = Pick<ReturnType<typeof useFeatureFlags>, 'loadProductFeatures' | 'resolveHomePath'>

export async function resolveAdminRouteRedirect(
  to: Pick<RouteLocationNormalized, 'meta'>,
  auth: AuthAccess,
  flags: FeatureFlagAccess,
  capabilities?: Pick<AdminAccessCapabilities, 'isPlatformAdmin'> | null,
): Promise<string | null> {
  if (to.meta?.requiresAdmin !== true) return null
  // When the caller supplies the capability read, that answer is authoritative.
  // `null` and a non-true flag fail closed. Callers that omit it use
  // hasAdminAccess(), which is true only after the live read grants platform admin.
  const allowed = capabilities !== undefined
    ? capabilities?.isPlatformAdmin === true
    : auth.hasAdminAccess()
  if (allowed) return null

  try {
    await flags.loadProductFeatures()
  } catch {
    // Keep the admin boundary closed even when feature probing is temporarily unavailable.
  }

  return flags.resolveHomePath()
}
