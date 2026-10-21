// Defer non-critical work (ambient badges, unread counts) until the main
// thread is idle, so it never competes with first paint or the sheet-open
// critical path. Falls back to a macrotask where requestIdleCallback is
// unavailable (Safari, jsdom test environment).
type IdleScheduler = (cb: () => void, opts?: { timeout: number }) => number

export function scheduleIdle(callback: () => void, timeoutMs = 1500): void {
  const ric = (globalThis as { requestIdleCallback?: IdleScheduler }).requestIdleCallback
  if (typeof ric === 'function') {
    ric(() => callback(), { timeout: timeoutMs })
    return
  }
  setTimeout(callback, 0)
}
