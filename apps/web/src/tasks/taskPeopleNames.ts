/**
 * Names for the user ids a task page shows without a name of its own: the actors of the list page's
 * activity and the roster of the list members dialog. Each page or dialog holds its own instance.
 *
 * Names come only from the people lookup (`resolvePeople`, `GET /api/tasks/people?ids=`). An id the
 * lookup gives no name stays as it is, and nothing is read into the missing name.
 *
 * `request(ids)` asks only for ids not asked yet under the identity held (until `clear()`) that are
 * printable ASCII, 1 to 255 characters long, not `.` or `..`, and hold no comma. They go out in parts
 * of at most 50 ids and at most 4096 characters joined by commas, one part after the other. An `ok`
 * answer adds the names it gives for that part's ids. A 403 answer stops every lookup until another
 * identity is seen. Any other answer, a thrown call or no answer gives no names and stops the parts
 * still to go. A later request may retry the failed part and the parts that were not sent.
 *
 * Identity: the instance holds the identity a request would carry (`readDispatchIdentity`, the user
 * and org, read as the people picker and the task detail page read it) and compares it with `===`.
 * It is checked on a session switch in this tab, on a storage change from another tab, right before
 * each part is sent and when each answer lands. When another one is seen, the names, the asked ids
 * and the 403 stop are dropped. Old answers are discarded and the lookup holds the new identity. A request that is the first to see another
 * identity takes it and asks nothing. A token refresh for the same user and org is not a change.
 * The identity is derived on the client and only compared for equality.
 *
 * `clear()` drops the names and the asked ids, and an answer still out; it keeps the 403 stop.
 * `dispose()` stops listening; nothing is sent after it and no answer is kept.
 */
import { shallowRef, type ShallowRef } from 'vue'
import { onAuthSessionSwitch } from '../composables/authPrincipal'
import { readDispatchIdentity } from './recordTaskDispatchIdentity'
import { resolvePeople, type SearchPeopleResult } from './tasksApi'

/** Most ids in one part of a lookup. */
const PART_MAX_IDS = 50
/** Most characters in one part of a lookup, its ids joined by commas. */
const PART_MAX_CHARS = 4096
const ID_MAX_LENGTH = 255
const PRINTABLE_ID = /^[!-~]+$/

export interface TaskPeopleNames {
  /** Id to name for the ids the lookups named under the identity held; a new map on each change. */
  readonly names: Readonly<ShallowRef<ReadonlyMap<string, string>>>
  /** The name of `id`, or `''` when there is none. */
  nameOf(id: string): string
  /** Looks up the ids that may still be asked (see the header); resolves once its parts are done. */
  request(ids: readonly string[]): Promise<void>
  /** Drops the names and the asked ids; an answer still out is dropped. */
  clear(): void
  /** Stops listening; nothing is sent after it and no answer is kept. */
  dispose(): void
}

/** An id the lookup may be asked for. */
function isAskable(id: string): boolean {
  return id.length > 0
    && id.length <= ID_MAX_LENGTH
    && PRINTABLE_ID.test(id)
    && id !== '.'
    && id !== '..'
    && !id.includes(',')
}

/** `ids` in parts of at most PART_MAX_IDS ids and PART_MAX_CHARS characters joined by commas. */
function lookupParts(ids: readonly string[]): string[][] {
  const parts: string[][] = []
  let part: string[] = []
  let chars = 0
  for (const id of ids) {
    if (part.length > 0 && (part.length === PART_MAX_IDS || chars + 1 + id.length > PART_MAX_CHARS)) {
      parts.push(part)
      part = []
      chars = 0
    }
    chars += (part.length > 0 ? 1 : 0) + id.length
    part.push(id)
  }
  if (part.length > 0) parts.push(part)
  return parts
}

export function createTaskPeopleNames(): TaskPeopleNames {
  const names = shallowRef<ReadonlyMap<string, string>>(new Map())
  let identity = readDispatchIdentity()
  let generation = 0
  let asked = new Set<string>()
  let forbidden = false
  let disposed = false

  function identityHolds(): boolean {
    const current = readDispatchIdentity()
    if (current === identity) return true
    identity = current
    generation += 1
    asked = new Set()
    forbidden = false
    names.value = new Map()
    return false
  }

  async function request(ids: readonly string[]): Promise<void> {
    if (disposed || !identityHolds() || forbidden) return
    const fresh: string[] = []
    for (const id of ids) {
      if (!isAskable(id) || asked.has(id)) continue
      asked.add(id)
      fresh.push(id)
    }
    let completed = 0
    const mine = generation
    for (const part of lookupParts(fresh)) {
      if (mine !== generation || !identityHolds() || forbidden) return
      let result: SearchPeopleResult | undefined
      try {
        result = await resolvePeople(part)
      } catch {
        result = undefined
      }
      // An answer that lands after a clear, a dispose or another identity is dropped.
      if (mine !== generation || !identityHolds()) return
      if (!result || result.kind !== 'ok') {
        if (result?.kind === 'forbidden') forbidden = true
        else {
          for (const id of fresh.slice(completed)) asked.delete(id)
        }
        return
      }
      completed += part.length
      const inPart = new Set(part)
      const next = new Map(names.value)
      for (const person of result.items) {
        if (person.name && inPart.has(person.id)) next.set(person.id, person.name)
      }
      names.value = next
    }
  }

  function clear(): void {
    generation += 1
    asked = new Set()
    names.value = new Map()
  }

  const stopSessionSwitch = onAuthSessionSwitch(() => { identityHolds() })
  const onStorage = () => { identityHolds() }
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)

  function dispose(): void {
    if (disposed) return
    disposed = true
    generation += 1
    stopSessionSwitch()
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
  }

  return {
    names,
    nameOf: (id) => names.value.get(id) ?? '',
    request,
    clear,
    dispose,
  }
}
