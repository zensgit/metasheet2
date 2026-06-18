import { ref, shallowRef, watch, onUnmounted } from 'vue'
import type { Ref } from 'vue'
import * as Y from 'yjs'
import { isYjsCollabEnabled } from './useYjsCellBinding'

type UseYjsDocumentFn = typeof import('./useYjsDocument')['useYjsDocument']
type YjsDocumentApi = ReturnType<UseYjsDocumentFn>

/**
 * Opt-in Yjs binding for a single NON-STRING (scalar) cell — the sibling of
 * `useYjsCellBinding` (which handles `Y.Text` string cells).
 *
 * Scalars (number/currency/percent/rating/duration/select/boolean/...) are
 * atomic values: character-level CRDT is meaningless, so the correct realtime
 * semantic is **last-write-wins via the record `fields` Y.Map** (a Yjs Y.Map
 * is a CRDT — LWW per key). This binds the cell to the plain value stored under
 * the field key in that map.
 *
 * TYPE-AGNOSTIC BY DESIGN: it stores and returns whatever value the caller
 * passes via `setValue`. It does NOT coerce or guess a per-type representation
 * — the caller (the grid editor) is responsible for passing EXACTLY the value
 * shape the REST patch would write for that field type, because the backend
 * bridge persists whatever is in the Y.Map verbatim. Passing a wrong-typed
 * value would persist corruption; that responsibility stays with the caller.
 *
 * Activation contract (mirrors `useYjsCellBinding`'s Y.Text-exists guard): we
 * only flip `active` true once the sync handshake completes AND the field key
 * already exists in the `fields` Y.Map. If the key is absent (e.g. the backend
 * seed has not seeded scalar values yet) we stay inactive and the caller MUST
 * keep its REST path — we never `set` into a missing key and risk clobbering a
 * value the actor cannot see. The whole composable is inert when the
 * `VITE_ENABLE_YJS_COLLAB` flag is off (same as `useYjsCellBinding`).
 */

const CONNECT_TIMEOUT_MS = 2500

export interface UseYjsScalarCellOptions {
  /** Record being edited. When null, binding is inert. */
  recordId: Ref<string | null>
  /** Field being edited. When null, binding is inert. */
  fieldId: Ref<string | null>
  /** Connect-timeout override (tests). */
  connectTimeoutMs?: number
  /**
   * Dual-reader for string-stored atomics (select/date/dateTime). When true, a
   * `Y.Text` value read from the map is coerced to its string via `.toString()`.
   * This lets a string-stored atomic cell bind even when an existing/persisted
   * doc still holds the field as `Y.Text` (the historical seed shape); on the
   * first `setValue` it converges to a plain string (LWW). Off by default so
   * genuine non-string scalars (number/boolean/array) are returned verbatim.
   */
  coerceText?: boolean
  /** Soft-fallback notification; callers MUST continue with REST regardless. */
  onFallback?: (reason: 'timeout' | 'error' | 'disabled') => void
}

export interface YjsScalarCellBinding<T = unknown> {
  /** True once a live Y.Doc is attached AND the field key exists in `fields`. */
  active: Ref<boolean>
  /** Reactive plain value from the `fields` Y.Map (undefined when inactive). */
  value: Ref<T | undefined>
  /** Write the value into the `fields` Y.Map (LWW). No-op when inactive. */
  setValue: (next: T) => void
  /** Tear down the Yjs connection. */
  release: () => void
}

/**
 * Binds a scalar cell to its `fields` Y.Map value. Always returns a consistent
 * API regardless of flag/active state; callers read `active.value` to decide
 * whether to drive the cell from `value.value` or stick to their REST path.
 */
export function useYjsScalarCell<T = unknown>(options: UseYjsScalarCellOptions): YjsScalarCellBinding<T> {
  const active = ref(false)
  const value = ref<T | undefined>(undefined) as Ref<T | undefined>

  if (!isYjsCollabEnabled()) {
    options.onFallback?.('disabled')
    return {
      active,
      value,
      setValue: () => { /* inert: caller uses REST */ },
      release: () => { /* nothing to release */ },
    }
  }

  const timeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS
  const liveRecordId = shallowRef<string | null>(null)
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  let released = false
  let yjs: YjsDocumentApi | null = null
  let runtimeReady = false
  let fieldsObserver: (() => void) | null = null
  let currentFieldId: string | null = null

  let stopErrorWatch: (() => void) | null = null
  let stopSyncedWatch: (() => void) | null = null
  let stopConnectedWatch: (() => void) | null = null
  let stopDocWatch: (() => void) | null = null

  void loadRuntime()

  function clearTimer() {
    if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null }
  }

  function fieldsMap(): Y.Map<unknown> | null {
    // `yjs.doc` is a ShallowRef<Doc | null> (created on connect). Read its
    // current value; null until the doc exists. Matches the backend seed +
    // useYjsTextField, which use doc.getMap('fields').
    const d = yjs?.doc.value
    if (!d) return null
    try { return d.getMap('fields') } catch { return null }
  }

  // Re-read the value + recompute `active` from the current map state. Active
  // requires synced AND the key present (an absent key = not seeded → REST).
  function refresh() {
    if (released || !yjs) return
    const map = fieldsMap()
    const fid = currentFieldId
    const present = !!map && !!fid && map.has(fid)
    if (yjs.synced.value && present) {
      clearTimer()
      const raw = map!.get(fid!)
      // Dual-reader: a string-stored atomic cell (coerceText) may find a
      // persisted Y.Text under its key — coerce to the plain string. Genuine
      // scalars are returned verbatim.
      value.value = (options.coerceText === true && raw instanceof Y.Text ? raw.toString() : raw) as T
      active.value = true
    } else if (!present && active.value) {
      active.value = false
      value.value = undefined
    }
  }

  function detachObserver() {
    if (fieldsObserver) { try { fieldsObserver() } catch { /* ignore */ } fieldsObserver = null }
  }

  function attachObserver() {
    detachObserver()
    const map = fieldsMap()
    if (!map) return
    const handler = (event: Y.YMapEvent<unknown>) => {
      if (currentFieldId && event.keysChanged.has(currentFieldId)) refresh()
    }
    map.observe(handler)
    fieldsObserver = () => map.unobserve(handler)
  }

  function fallback(reason: 'timeout' | 'error') {
    if (released) return
    clearTimer()
    detachObserver()
    active.value = false
    value.value = undefined
    liveRecordId.value = null // triggers useYjsDocument disconnect
    options.onFallback?.(reason)
  }

  async function loadRuntime(): Promise<void> {
    try {
      const { useYjsDocument } = await import('./useYjsDocument')
      if (released) return
      yjs = useYjsDocument(liveRecordId, { registerUnmount: false })

      stopErrorWatch = watch(() => yjs!.error.value, (err) => { if (err) fallback('error') })
      stopSyncedWatch = watch(() => yjs!.synced.value, () => refresh())
      stopConnectedWatch = watch(
        () => yjs!.connected.value,
        (isConnected) => { if (!isConnected && active.value) fallback('error') },
      )
      // The doc ref is null until useYjsDocument creates it on connect; (re)attach
      // the observer + refresh when it arrives or changes on a record re-bind.
      stopDocWatch = watch(
        () => yjs!.doc.value,
        () => { if (!released) { attachObserver(); refresh() } },
      )

      runtimeReady = true
      startBinding(options.recordId.value, options.fieldId.value)
    } catch (err) {
      console.warn('[multitable] failed to load Yjs scalar cell runtime', err)
      fallback('error')
    }
  }

  function startBinding(newRecordId: string | null, newFieldId: string | null): void {
    clearTimer()
    detachObserver()
    active.value = false
    value.value = undefined
    currentFieldId = newFieldId
    if (!runtimeReady || !newRecordId || !newFieldId) {
      liveRecordId.value = null
      return
    }
    liveRecordId.value = newRecordId
    // The doc/map exist synchronously once useYjsDocument wires the record;
    // observe + an initial refresh (synced may already be true on re-bind).
    attachObserver()
    refresh()
    timeoutHandle = setTimeout(() => { if (!active.value) fallback('timeout') }, timeoutMs)
  }

  const stopInputsWatch = watch(
    [options.recordId, options.fieldId],
    ([newRecordId, newFieldId]) => { if (!released) startBinding(newRecordId, newFieldId) },
    { immediate: true },
  )

  function setValue(next: T) {
    if (!active.value || !yjs) return
    const map = fieldsMap()
    if (!map || !currentFieldId) return
    // A local (default-origin) Y.Map.set syncs to the server, which applies it
    // with this client's socket.id as the transaction origin. The server-side
    // bridge observer skips only 'rest'/'persistence' origins, so a synced
    // client edit IS flushed via the validated patchRecords path, attributed
    // to the resolved actor. (We never set into an absent key — see the
    // `active`/`refresh` guard — so this can't clobber an unseeded value.)
    map.set(currentFieldId, next as unknown)
    value.value = next
  }

  function release() {
    if (released) return
    released = true
    clearTimer()
    detachObserver()
    active.value = false
    value.value = undefined
    currentFieldId = null
    liveRecordId.value = null
    if (stopErrorWatch) try { stopErrorWatch() } catch { /* ignore */ }
    if (stopSyncedWatch) try { stopSyncedWatch() } catch { /* ignore */ }
    if (stopConnectedWatch) try { stopConnectedWatch() } catch { /* ignore */ }
    if (stopDocWatch) try { stopDocWatch() } catch { /* ignore */ }
    try { stopInputsWatch() } catch { /* ignore */ }
    try { yjs?.dispose() } catch { /* ignore */ }
  }

  onUnmounted(release)

  return { active, value, setValue, release }
}
