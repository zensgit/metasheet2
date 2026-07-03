import { onBeforeUnmount, onMounted, readonly, ref } from 'vue'

/**
 * T3-1 v0 — shared mobile-viewport detection for the approval surface.
 *
 * Pure viewport width test (no touch/UA runtime gating): the mobile approval
 * surface is already opt-in behind the `approvalMobile` feature flag, so the
 * only remaining question is "is this a narrow viewport?". Keeping it width-only
 * makes the layout deterministic and testable — a caller composes it with the
 * flag as `flag && isMobile`.
 *
 * `window.matchMedia` is undefined under jsdom / SSR, so every access is
 * guarded; when it is unavailable the viewport is treated as non-mobile (the
 * desktop path stays the safe default). The resize listener is registered on
 * mount and torn down on unmount so no global listener leaks.
 */
const DEFAULT_MOBILE_QUERY = '(max-width: 768px)'

function matchesMediaQuery(query: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    return Boolean(window.matchMedia?.(query)?.matches)
  } catch {
    return false
  }
}

export function useMobileViewport(query: string = DEFAULT_MOBILE_QUERY) {
  const isMobile = ref(matchesMediaQuery(query))

  function updateMobileState(): void {
    isMobile.value = matchesMediaQuery(query)
  }

  onMounted(() => {
    updateMobileState()
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', updateMobileState)
    }
  })

  onBeforeUnmount(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', updateMobileState)
    }
  })

  return {
    isMobile: readonly(isMobile),
    updateMobileState,
  }
}
