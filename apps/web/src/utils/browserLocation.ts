const LOCATION_CHANGE_EVENT = 'metasheet:locationchange'
const PATCHED_FLAG = '__metasheetLocationPatched__'

function dispatchLocationChange(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(LOCATION_CHANGE_EVENT))
}

export function ensureLocationChangeEvents(): void {
  if (typeof window === 'undefined') return

  const historyRecord = window.history as History & { [PATCHED_FLAG]?: boolean }
  if (historyRecord[PATCHED_FLAG]) return

  const originalPushState = window.history.pushState.bind(window.history)
  const originalReplaceState = window.history.replaceState.bind(window.history)

  window.history.pushState = function pushState(...args): void {
    originalPushState(...args)
    dispatchLocationChange()
  }

  window.history.replaceState = function replaceState(...args): void {
    originalReplaceState(...args)
    dispatchLocationChange()
  }

  historyRecord[PATCHED_FLAG] = true
}

export function subscribeToLocationChanges(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}

  ensureLocationChangeEvents()
  window.addEventListener('popstate', listener)
  window.addEventListener(LOCATION_CHANGE_EVENT, listener)

  return () => {
    window.removeEventListener('popstate', listener)
    window.removeEventListener(LOCATION_CHANGE_EVENT, listener)
  }
}
