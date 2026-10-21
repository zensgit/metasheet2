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
 * desktop path stays the safe default).
 *
 * TWO listeners keep `isMobile` current (hardening wave, 2026-09-08):
 *   * the `MediaQueryList`'s own `change` event — fires exactly when the query's
 *     match state flips, independent of WHAT changed it (a window resize, a
 *     rotated device, devtools' responsive-mode picker, an externally connected
 *     display). This is the correct, narrow signal for "did the query's answer
 *     change", and it is what was missing before this wave: a caller resizing
 *     through devtools' preset list (rather than dragging the window) fires no
 *     `resize` event at all, so `isMobile` was silently stale until SOMETHING
 *     else forced a re-render.
 *   * `window`'s `resize` event, kept as a FALLBACK rather than removed: some
 *     older WebViews and a handful of test/embed hosts still fire `resize`
 *     without ever firing the query's `change` (or expose a `matchMedia` whose
 *     `MediaQueryList` predates the `change` event, addressed via `addListener`
 *     below). Both handlers call the same idempotent `updateMobileState`, so a
 *     host that fires BOTH for one resize does not double-toggle anything.
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

/** `window.matchMedia(query)` itself, guarded the same way `matchesMediaQuery` is. `null` under
 *  jsdom / SSR, or when the call throws — the caller treats that exactly like "no listener to add". */
function safeMatchMedia(query: string): MediaQueryList | null {
  if (typeof window === 'undefined') return null
  try {
    return window.matchMedia?.(query) ?? null
  } catch {
    return null
  }
}

export function useMobileViewport(query: string = DEFAULT_MOBILE_QUERY) {
  const isMobile = ref(matchesMediaQuery(query))

  function updateMobileState(): void {
    isMobile.value = matchesMediaQuery(query)
  }

  /** Held across mount/unmount so the SAME `MediaQueryList` instance that gained a listener is the
   *  one that loses it — `window.matchMedia(query)` is not guaranteed to return a cached/identical
   *  object across calls, so re-querying at teardown could target the wrong (or no) list. */
  let mediaQueryList: MediaQueryList | null = null

  onMounted(() => {
    updateMobileState()
    if (typeof window === 'undefined') return
    window.addEventListener('resize', updateMobileState)
    mediaQueryList = safeMatchMedia(query)
    if (!mediaQueryList) return
    // Modern `addEventListener` first; `addListener` (deprecated, still what Safari < 14 exposes) as
    // a fallback rather than the primary — trying the modern API first is what keeps a host that
    // implements BOTH from registering the same handler twice.
    if (typeof mediaQueryList.addEventListener === 'function') {
      mediaQueryList.addEventListener('change', updateMobileState)
    } else if (typeof (mediaQueryList as { addListener?: (cb: () => void) => void }).addListener === 'function') {
      (mediaQueryList as unknown as { addListener: (cb: () => void) => void }).addListener(updateMobileState)
    }
  })

  onBeforeUnmount(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', updateMobileState)
    }
    if (mediaQueryList) {
      if (typeof mediaQueryList.removeEventListener === 'function') {
        mediaQueryList.removeEventListener('change', updateMobileState)
      } else if (typeof (mediaQueryList as { removeListener?: (cb: () => void) => void }).removeListener === 'function') {
        (mediaQueryList as unknown as { removeListener: (cb: () => void) => void }).removeListener(updateMobileState)
      }
    }
    mediaQueryList = null
  })

  return {
    isMobile: readonly(isMobile),
    updateMobileState,
  }
}
