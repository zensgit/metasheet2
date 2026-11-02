/**
 * 派发任务 from a multitable record: the retry key of one dispatch, kept per record.
 *
 * When a create gets no readable answer, the task may or may not exist. Resending under the same key
 * lets the server return the task it already made instead of making a second one, so the key has to
 * outlive the dialog and a page reload until the result has been shown.
 *
 * The browser keeps, under a name built from the sheet id and the record id, a random id, the time it
 * was made and one counter (`unsettled`): requests handed to the transport under this key that no 4xx
 * has answered (a 4xx means that attempt created nothing). An entry with `unsettled > 0` is unresolved;
 * one with `unsettled === 0` is dormant, and the next send reuses its key, which the server has never
 * stored, unless a write failed, which `persisted: false` reports: after a failed `markSent` write and
 * a reload the stored count misses a request that did go out, so the entry reads dormant, and reusing
 * its key is still safe. Nothing here is derived from the session: what stops another account from
 * reusing an entry is the server, which matches a key only within the caller's own org and dispatcher,
 * so another account's send makes that account's own task.
 *
 * The in-memory map is the record for this page; sessionStorage is the mirror that survives a reload.
 * Every storage call has its own try/catch: a failed write is reported as `persisted: false`, a failed
 * read reads as no entry, and a send still goes out with the key held in memory. Only `mint` can
 * throw out of this module.
 *
 * `obtain` writes the entry when it makes it, before the caller's run has started. A run that is then
 * refused leaves a dormant entry, which holds no attempt and is the first to go at the cap.
 *
 * An entry is released when its result has been shown, on 再派一项, and when the server refuses the
 * key. A released key is not handed out again by this page: it keeps the released names and takes no
 * entry under them from storage until an entry made after the release has been written there. Making
 * room at the cap still reads such values to count them, apart from the one for the record whose entry
 * is being written. When storage refuses the removal, the stored value is overwritten with one that
 * reads as no entry, so a reloaded page does not read it back either. When storage refuses both, a
 * reloaded page cannot tell the released entry from a live one and hands its key out again. That still
 * makes no second task: within one org and dispatcher the server keeps a key for one task only, so a
 * resend under it is answered with the task that key already made, and after a shown result the next
 * dispatch from that record therefore gets the earlier task back instead of creating a new one; a key
 * it never stored (a dormant entry on 再派一项) is as new as any other, and a key it refused is refused
 * again.
 *
 * Separately, every entry goes when a session change moves this tab away from the principal it
 * remembers. That sweep runs only on a page that has loaded this module, and only for transitions
 * announced through `useAuth`; everything else (a page whose chunk has not loaded, a redirect from
 * `handleUnauthorized`, an ordinary session's change in another tab) leaves the entries to the
 * server's scope above.
 *
 * What counts as moving away is the principal key changing, so besides sign-out, another account and a
 * partial session switch it also covers:
 *  - `setToken` for the same account during an explicitly selected session, which moves the key from
 *    the session's tuple to the subject;
 *  - any change of a token with no usable subject, which is keyed by its text;
 *  - every org switch of the same account, a return to the first org included, because each one has
 *    a new epoch;
 *  - a sign-out on a 401 from the session probe;
 *  - a sign-in after a session that could not be read (a partial switch, an expired explicit session).
 *    It sweeps on purpose: nothing says whose entries these are, and the cost is losing a retry key.
 * A sign-in with no principal before it keeps the entries, and a token refresh for the same principal
 * changes nothing.
 */
import { getAuthPrincipalKey, onAuthSessionSwitch } from '../composables/authPrincipal'
import { randomUuid } from '../utils/uuid'

export const DISPATCH_KEY_STORAGE_PREFIX = 'metasheet.tasks.dispatchKey.v1:'

/** Entries per tab. Age never makes a key wrong (reusing it is still the same attempt), so there is no TTL. */
export const DISPATCH_KEY_MAX_ENTRIES = 32

const DISPATCH_KEY_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/

/** Written over a value that storage would not remove; `parseEntry` reads it as no entry. */
const DISCARDED_VALUE = 'discarded'

export interface DispatchKeyScope {
  sheetId: string
  recordId: string
}

export interface DispatchKeyEntry {
  v: 1
  key: string
  /** When the key was made; orders the entries at the cap. */
  at: number
  /** Requests handed to the transport under this key that no 4xx has answered; never below zero. */
  unsettled: number
}

export interface DispatchKeyStore {
  /** The scope's key, made and written now when it has none. Throws only when `mint` throws. */
  obtain(scope: DispatchKeyScope): { key: string; persisted: boolean }
  /** One more request under this key; called before the request is handed to the transport. */
  markSent(scope: DispatchKeyScope): { persisted: boolean }
  /** A 4xx answered one of the requests. Never goes below zero; does nothing when there is no entry. */
  markSettled(scope: DispatchKeyScope): void
  /** There is an entry and at least one of its requests has no 4xx answer. */
  isUnresolved(scope: DispatchKeyScope): boolean
  /** The last write of this scope's entry reached storage. */
  isPersisted(scope: DispatchKeyScope): boolean
  /** The result has been shown, 再派一项, or the server refused the key. */
  release(scope: DispatchKeyScope): void
  /** Every entry under the prefix, and everything held in memory. */
  releaseAll(): void
}

export interface DispatchKeyStoreDeps {
  storage: () => Storage | null
  mint: () => string
  now: () => number
}

interface HeldEntry {
  entry: DispatchKeyEntry
  persisted: boolean
}

export function dispatchKeyStorageKey(scope: DispatchKeyScope): string {
  return DISPATCH_KEY_STORAGE_PREFIX + JSON.stringify([scope.sheetId, scope.recordId])
}

export function isDispatchKey(value: unknown): value is string {
  return typeof value === 'string' && DISPATCH_KEY_PATTERN.test(value)
}

/** The stored text as an entry, or null when it is not one this version wrote. */
function parseEntry(raw: string): DispatchKeyEntry | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const { v, key, at, unsettled } = value as Record<string, unknown>
  if (v !== 1 || !isDispatchKey(key) || typeof at !== 'number' || !Number.isFinite(at)) return null
  if (!Number.isInteger(unsettled) || (unsettled as number) < 0) return null
  return { v: 1, key, at, unsettled: unsettled as number }
}

/** At the cap, dormant entries go before unresolved ones, oldest first within each. */
function evictionOrder(a: [string, DispatchKeyEntry], b: [string, DispatchKeyEntry]): number {
  const unresolved = Number(a[1].unsettled > 0) - Number(b[1].unsettled > 0)
  if (unresolved !== 0) return unresolved
  return a[1].at - b[1].at || a[0].localeCompare(b[0])
}

function buildStore(deps: DispatchKeyStoreDeps): { store: DispatchKeyStore; clearMemory: () => void } {
  const held = new Map<string, HeldEntry>()
  // Names released on this page whose stored value may still be the released entry: `find` takes no
  // entry under them from storage until a newer entry under that name has been written there.
  const released = new Set<string>()

  function target(): Storage | null {
    try {
      return deps.storage()
    } catch {
      return null
    }
  }

  /** A value storage will not remove is overwritten with one that reads as no entry. */
  function removeStored(name: string): void {
    const storage = target()
    if (!storage) return
    try {
      storage.removeItem(name)
      return
    } catch {
      // Overwritten below instead.
    }
    try {
      storage.setItem(name, DISCARDED_VALUE)
    } catch {
      // Stays in storage as it was; it is still one random id under a record's name (see the header).
    }
  }

  /** A stored value that is not a valid entry is removed and reads as none. */
  function readStored(name: string): DispatchKeyEntry | null {
    let raw: string | null | undefined
    try {
      raw = target()?.getItem(name)
    } catch {
      return null
    }
    if (raw === null || raw === undefined) return null
    const entry = parseEntry(raw)
    if (!entry) removeStored(name)
    return entry
  }

  function writeStored(name: string, entry: DispatchKeyEntry): boolean {
    const storage = target()
    if (!storage) return false
    try {
      storage.setItem(name, JSON.stringify(entry))
      released.delete(name)
      return true
    } catch {
      return false
    }
  }

  /** Collected before anything is removed: removing while walking `key(i)` skips entries. */
  function storedNames(): string[] {
    const names: string[] = []
    try {
      const storage = target()
      if (!storage) return names
      for (let index = 0; index < storage.length; index += 1) {
        const name = storage.key(index)
        if (name?.startsWith(DISPATCH_KEY_STORAGE_PREFIX)) names.push(name)
      }
    } catch {
      // The names collected so far are still handled.
    }
    return names
  }

  function find(name: string): HeldEntry | null {
    const inMemory = held.get(name)
    if (inMemory) return inMemory
    if (released.has(name)) return null
    const entry = readStored(name)
    if (!entry) return null
    const found: HeldEntry = { entry, persisted: true }
    held.set(name, found)
    return found
  }

  /** Makes room for one more entry under `except`, which is not counted: its value is replaced next. */
  function evict(except: string): void {
    const all = new Map<string, DispatchKeyEntry>()
    for (const name of storedNames()) {
      const entry = readStored(name)
      if (entry) all.set(name, entry)
    }
    for (const [name, current] of held) all.set(name, current.entry)
    all.delete(except)
    const surplus = all.size - DISPATCH_KEY_MAX_ENTRIES + 1
    if (surplus <= 0) return
    for (const [name] of [...all.entries()].sort(evictionOrder).slice(0, surplus)) {
      held.delete(name)
      removeStored(name)
    }
  }

  function update(current: HeldEntry, name: string, entry: DispatchKeyEntry): boolean {
    current.entry = entry
    current.persisted = writeStored(name, entry)
    return current.persisted
  }

  const store: DispatchKeyStore = {
    obtain(scope) {
      const name = dispatchKeyStorageKey(scope)
      const found = find(name)
      if (found) return { key: found.entry.key, persisted: found.persisted }
      const key = deps.mint()
      evict(name)
      const entry: DispatchKeyEntry = { v: 1, key, at: deps.now(), unsettled: 0 }
      const persisted = writeStored(name, entry)
      held.set(name, { entry, persisted })
      return { key, persisted }
    },
    markSent(scope) {
      const name = dispatchKeyStorageKey(scope)
      const found = find(name)
      if (!found) return { persisted: false }
      return { persisted: update(found, name, { ...found.entry, unsettled: found.entry.unsettled + 1 }) }
    },
    markSettled(scope) {
      const name = dispatchKeyStorageKey(scope)
      const found = find(name)
      if (!found || found.entry.unsettled === 0) return
      update(found, name, { ...found.entry, unsettled: found.entry.unsettled - 1 })
    },
    isUnresolved(scope) {
      const found = find(dispatchKeyStorageKey(scope))
      return found !== null && found.entry.unsettled > 0
    },
    isPersisted(scope) {
      return find(dispatchKeyStorageKey(scope))?.persisted ?? false
    },
    release(scope) {
      const name = dispatchKeyStorageKey(scope)
      released.add(name)
      held.delete(name)
      removeStored(name)
    },
    releaseAll() {
      // Names held here count too: a storage that cannot list its names may still read them back.
      const names = new Set([...held.keys(), ...storedNames()])
      held.clear()
      for (const name of names) {
        released.add(name)
        removeStored(name)
      }
    },
  }
  return {
    store,
    clearMemory: () => {
      held.clear()
      released.clear()
    },
  }
}

export function createDispatchKeyStore(deps: DispatchKeyStoreDeps): DispatchKeyStore {
  return buildStore(deps).store
}

const defaultStore = buildStore({
  storage: () => (typeof sessionStorage === 'undefined' ? null : sessionStorage),
  mint: randomUuid,
  now: () => Date.now(),
})

export const dispatchKeys: DispatchKeyStore = defaultStore.store

// Compared by principal, not by the switch signal's own signature: a token refresh fires the signal
// and leaves the principal unchanged. The value stays in this variable and is never written out.
let rememberedPrincipal: string | null = null
let unsubscribeSessionSwitch: (() => void) | null = null

function readPrincipal(): string | null {
  try {
    return getAuthPrincipalKey()
  } catch {
    return 'invalid'
  }
}

// Subscribed at module load, not on the first dispatch: on a page that has loaded this module, entries
// from before a reload go when it signs out, whether or not it has opened the dialog. A page that has
// not loaded it has no subscription (see the header).
function watchSessionSwitch(): void {
  rememberedPrincipal = readPrincipal()
  unsubscribeSessionSwitch = onAuthSessionSwitch(() => {
    const next = readPrincipal()
    if (rememberedPrincipal !== null && next !== rememberedPrincipal) dispatchKeys.releaseAll()
    rememberedPrincipal = next
  })
}

watchSessionSwitch()

/** Test harnesses only: drops what this page holds and re-reads the principal under a fresh subscription. */
export function resetDispatchKeysForTests(): void {
  unsubscribeSessionSwitch?.()
  defaultStore.clearMemory()
  watchSessionSwitch()
}
