import { ref, shallowRef, watch, onUnmounted } from 'vue'
import type { Ref } from 'vue'
import type { YjsPresenceUser } from '../types'

type UseYjsDocumentFn = typeof import('./useYjsDocument')['useYjsDocument']
type UseYjsTextFieldFn = typeof import('./useYjsTextField')['useYjsTextField']
type YjsDocumentApi = ReturnType<UseYjsDocumentFn>

/**
 * Opt-in Yjs binding for a single text cell.
 *
 * Behavior summary:
 * - Reads the build-time flag `VITE_ENABLE_YJS_COLLAB`. When not exactly the
 *   string `"true"`, this composable is inert: `active` stays false, no
 *   Socket.IO connection is attempted, no Y.Doc is created, and the caller's
 *   existing REST submit path continues to run unchanged.
 * - When the flag is on and a `recordId`/`fieldId` is supplied, this
 *   composable connects to `/yjs`, binds a `Y.Text` under the field key,
 *   and exposes reactive `text`, `setText`, and per-field `collaborators`.
 * - Includes a conservative connect timeout (`CONNECT_TIMEOUT_MS`) so the
 *   caller can fall back to REST without hanging. On timeout or error the
 *   binding marks itself inactive and disconnects; the caller MUST continue
 *   with REST — this composable never throws and never swallows user edits.
 *
 * Scope: POC wiring. Only text (`string` non-date-like) cells should call
 * this. Other field types stay on REST. The Yjs runtime modules are loaded
 * lazily only after the flag is on, keeping the default flag-off path from
 * eagerly importing the Socket.IO/Yjs composables.
 *
 * To enable at build time:
 *   VITE_ENABLE_YJS_COLLAB=true npm --workspace @metasheet/web run build
 */

export const YJS_COLLAB_ENV_FLAG = 'VITE_ENABLE_YJS_COLLAB'
const viteYjsCollabEnabled = import.meta.env.VITE_ENABLE_YJS_COLLAB === 'true'
const allowProcessEnvFlagFallback = import.meta.env.MODE === 'test'

/**
 * Reads the build-time flag from `import.meta.env`, which Vite replaces at
 * bundle time. Falls back to `process.env` so `vi.stubEnv` picks it up in
 * Vitest (the stub is visible on `process.env` in Node, not in the
 * per-file-transformed `import.meta.env`). Downstream: a browser build
 * with the flag off has the Vite value `undefined` and the process
 * fallback is a no-op, so the whole Yjs path stays inert.
 */
export function isYjsCollabEnabled(): boolean {
  try {
    if (viteYjsCollabEnabled) return true
    if (!allowProcessEnvFlagFallback) return false
    // Fallback to process.env so `vi.stubEnv` (which writes to process.env
    // in Node) picks the flag up in Vitest. This path is intentionally
    // test-only; production flag-off builds can return before the lazy
    // Yjs imports so the runtime chunk is dropped.
    const globalProcess = (globalThis as unknown as {
      process?: { env?: Record<string, string | undefined> }
    }).process
    return globalProcess?.env?.[YJS_COLLAB_ENV_FLAG] === 'true'
  } catch {
    return false
  }
}

/**
 * Hard cap on how long we wait for the Socket.IO handshake + initial sync.
 * If neither `connected` nor `synced` flips true in this window, we give
 * up, disconnect, and let the caller stick with REST.
 */
const CONNECT_TIMEOUT_MS = 2500

export interface UseYjsCellBindingOptions {
  /** Record being edited. When null, binding is inert. */
  recordId: Ref<string | null>
  /** Field being edited. When null, binding is inert. */
  fieldId: Ref<string | null>
  /** Connect-timeout override (tests). */
  connectTimeoutMs?: number
  /**
   * Called when Yjs is unavailable so the caller can log or show a soft
   * message (default: none). Failure is deliberately non-fatal; callers
   * MUST continue with REST. `disabled` is emitted once if the flag is off.
   */
  onFallback?: (reason: 'timeout' | 'error' | 'disabled') => void
}

export interface YjsCellBinding {
  /** True once a live Yjs Y.Doc is attached for this record/field. */
  active: Ref<boolean>
  /** Reactive Y.Text text value. Empty string when inactive. */
  text: Ref<string>
  /** Update the bound Y.Text atomically. No-op when inactive. */
  setText: (next: string) => void
  /** Users editing the same field (excluding the current user). */
  collaborators: Ref<YjsPresenceUser[]>
  /** Manually tear down the Yjs connection (e.g. on blur). */
  release: () => void
}

/**
 * Creates a binding to Y.Text for a single text cell. Always returns a
 * consistent API regardless of flag state; callers read `active.value` to
 * decide whether to drive the input from `text.value` or stick to REST.
 */
export function useYjsCellBinding(options: UseYjsCellBindingOptions): YjsCellBinding {
  const active = ref(false)
  const text = ref('')
  const collaborators = ref<YjsPresenceUser[]>([])

  if (!viteYjsCollabEnabled && !allowProcessEnvFlagFallback) {
    options.onFallback?.('disabled')
    return {
      active,
      text,
      setText: () => { /* inactive: no-op, caller uses REST path */ },
      collaborators,
      release: () => { /* nothing to release */ },
    }
  }

  if (!isYjsCollabEnabled()) {
    // Flag off: composable is inert. No watchers, no socket call.
    options.onFallback?.('disabled')
    return {
      active,
      text,
      setText: () => { /* inactive: no-op, caller uses REST path */ },
      collaborators,
      release: () => { /* nothing to release */ },
    }
  }

  const timeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS

  // Live record ref that drives useYjsDocument's internal watch. We keep
  // a second ref so we can tear the binding down cleanly (setting to null
  // triggers the composable's disconnect path).
  const liveRecordId = shallowRef<string | null>(null)
  const fieldKey = ref<string | null>(null)
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  let released = false
  let yjsTextApi: { setText: (next: string) => void } | null = null
  let yjsTextDispose: (() => void) | null = null
  let textWatchStop: (() => void) | null = null
  let yjsActiveStop: (() => void) | null = null
  // Mirrors the Y.Text-exists signal from useYjsTextField for the active
  // field binding. Only when this is true AND the sync handshake has
  // completed do we flip `active` on. See seed contract in
  // useYjsTextField.ts — if the Y.Text doesn't exist we MUST fall back
  // to REST rather than creating an empty Y.Text and risking overwrite.
  const boundYjsActive = ref(false)
  let yjs: YjsDocumentApi | null = null
  let useYjsTextFieldRuntime: UseYjsTextFieldFn | null = null
  let runtimeReady = false

  let stopPresenceWatch: (() => void) | null = null
  let stopErrorWatch: (() => void) | null = null
  let stopSyncedWatch: (() => void) | null = null
  let stopConnectedWatch: (() => void) | null = null

  void loadYjsRuntime()

  function clearTimer() {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle)
      timeoutHandle = null
    }
  }

  function fallback(reason: 'timeout' | 'error') {
    if (released) return
    clearTimer()
    active.value = false
    boundYjsActive.value = false
    collaborators.value = []
    text.value = ''
    yjsTextApi = null
    if (yjsTextDispose) {
      try { yjsTextDispose() } catch { /* ignore */ }
      yjsTextDispose = null
    }
    if (textWatchStop) {
      try { textWatchStop() } catch { /* ignore */ }
      textWatchStop = null
    }
    if (yjsActiveStop) {
      try { yjsActiveStop() } catch { /* ignore */ }
      yjsActiveStop = null
    }
    fieldKey.value = null
    // Setting liveRecordId to null triggers useYjsDocument's disconnect.
    liveRecordId.value = null
    options.onFallback?.(reason)
  }

  function bindField(fid: string) {
    if (!yjs || !useYjsTextFieldRuntime) return
    fieldKey.value = fid
    // useYjsTextField returns reactive text + setText/insertAt/deleteRange
    // + yjsActive (true only when a Y.Text already exists under this
    // fieldId). We refuse to activate our binding until yjsActive flips
    // true so we never drive the input off an empty Y.Text.
    const bound = useYjsTextFieldRuntime(yjs.doc, fid, {
      setActiveField: yjs.setActiveField,
      registerUnmount: false,
    })
    yjsTextApi = { setText: bound.setText }
    yjsTextDispose = bound.dispose
    boundYjsActive.value = bound.yjsActive.value
    textWatchStop = watch(
      () => bound.text.value,
      (next) => {
        text.value = next
      },
      { immediate: true },
    )
    yjsActiveStop = watch(
      () => bound.yjsActive.value,
      (next) => {
        boundYjsActive.value = next
      },
      { immediate: true },
    )
  }

  async function loadYjsRuntime(): Promise<void> {
    try {
      const [{ useYjsDocument }, { useYjsTextField }] = await Promise.all([
        import('./useYjsDocument'),
        import('./useYjsTextField'),
      ])
      if (released) return
      yjs = useYjsDocument(liveRecordId, { registerUnmount: false })
      useYjsTextFieldRuntime = useYjsTextField

      // Presence → per-field collaborators. `getFieldCollaborators` already
      // excludes the current user; we only need to refresh on presence updates.
      stopPresenceWatch = watch(
        () => yjs!.activeUsers.value,
        () => {
          collaborators.value = fieldKey.value && yjs
            ? yjs.getFieldCollaborators(fieldKey.value)
            : []
        },
        { deep: true },
      )

      // Listen for error events surfaced by useYjsDocument (missing JWT,
      // explicit 'yjs:error' from server, etc.) and treat them as soft
      // fallbacks.
      stopErrorWatch = watch(
        () => yjs!.error.value,
        (err) => {
          if (err) fallback('error')
        },
      )

      // Consider the binding active once BOTH (a) the sync handshake
      // completes AND (b) a Y.Text actually exists for this field. Without
      // (b) we'd bind the input to a useYjsTextField that returns
      // `text: ""` and a no-op `setText`, silently sending empty edits.
      // The seed on the backend ensures (b) for existing fields, but if
      // seed is delayed or failed we stay inactive and the caller keeps
      // REST.
      stopSyncedWatch = watch(
        [() => yjs!.synced.value, () => boundYjsActive.value],
        ([isSynced, hasYText]) => {
          if (released) return
          if (isSynced && hasYText) {
            clearTimer()
            active.value = true
          } else if (!hasYText && active.value) {
            // Y.Text disappeared mid-session (shouldn't happen in normal
            // flow; defensive). Fall back to REST.
            active.value = false
          }
        },
      )

      // Mid-session disconnect → fall back so the caller goes back to REST.
      stopConnectedWatch = watch(
        () => yjs!.connected.value,
        (isConnected) => {
          if (!isConnected && active.value) fallback('error')
        },
      )

      runtimeReady = true
      startBinding(options.recordId.value, options.fieldId.value)
    } catch (err) {
      console.warn('[multitable] failed to load Yjs cell binding runtime', err)
      fallback('error')
    }
  }

  function resetActiveFieldBinding(): void {
    clearTimer()
    active.value = false
    boundYjsActive.value = false
    collaborators.value = []
    text.value = ''
    yjsTextApi = null
    if (yjsTextDispose) {
      try { yjsTextDispose() } catch { /* ignore */ }
      yjsTextDispose = null
    }
    if (textWatchStop) {
      try { textWatchStop() } catch { /* ignore */ }
      textWatchStop = null
    }
    if (yjsActiveStop) {
      try { yjsActiveStop() } catch { /* ignore */ }
      yjsActiveStop = null
    }
  }

  function startBinding(newRecordId: string | null, newFieldId: string | null): void {
    resetActiveFieldBinding()
    if (!runtimeReady) return
    if (!newRecordId || !newFieldId) {
      fieldKey.value = null
      liveRecordId.value = null
      return
    }
    liveRecordId.value = newRecordId
    bindField(newFieldId)
    timeoutHandle = setTimeout(() => {
      if (!active.value) fallback('timeout')
    }, timeoutMs)
  }

  // Main driver: (re)bind when record/field inputs change.
  const stopInputsWatch = watch(
    [options.recordId, options.fieldId],
    ([newRecordId, newFieldId]) => {
      if (released) return
      startBinding(newRecordId, newFieldId)
    },
    { immediate: true },
  )

  function setText(next: string) {
    if (!active.value) return
    yjsTextApi?.setText(next)
  }

  function release() {
    if (released) return
    released = true
    clearTimer()
    active.value = false
    collaborators.value = []
    text.value = ''
    yjsTextApi = null
    if (yjsTextDispose) {
      try { yjsTextDispose() } catch { /* ignore */ }
      yjsTextDispose = null
    }
    if (textWatchStop) {
      try { textWatchStop() } catch { /* ignore */ }
      textWatchStop = null
    }
    if (yjsActiveStop) {
      try { yjsActiveStop() } catch { /* ignore */ }
      yjsActiveStop = null
    }
    boundYjsActive.value = false
    fieldKey.value = null
    liveRecordId.value = null
    if (stopPresenceWatch) try { stopPresenceWatch() } catch { /* ignore */ }
    if (stopErrorWatch) try { stopErrorWatch() } catch { /* ignore */ }
    if (stopSyncedWatch) try { stopSyncedWatch() } catch { /* ignore */ }
    if (stopConnectedWatch) try { stopConnectedWatch() } catch { /* ignore */ }
    try { stopInputsWatch() } catch { /* ignore */ }
    try { yjs?.dispose() } catch { /* ignore */ }
  }

  onUnmounted(release)

  return {
    active,
    text,
    setText,
    collaborators,
    release,
  }
}
