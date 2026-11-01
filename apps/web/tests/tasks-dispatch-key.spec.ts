/**
 * 派发任务 from a multitable record: the per-record retry key store (`tasks/recordTaskDispatchKey.ts`).
 *
 * The store runs on an in-memory `Storage` here, passed in or put in place of `sessionStorage`, so the
 * cells that walk `key(i)` do not depend on the test environment's own storage. The session cells go
 * through the real `useAuth`.
 *
 * What it pins:
 *  1. Contents: under every kind of session the entry's name is the prefix plus sheet id and record
 *     id, its value is a random id, a time and two counters, and neither holds session data; a session
 *     change adds nothing else to storage. A stored value that is not a valid entry is removed and
 *     reads as none.
 *  2. Counters: unresolved means more sends than 4xx answers; a dormant entry keeps its key; a reload
 *     (a new store on the same storage) finds the same key and counters.
 *  3. Session changes: leaving a signed-in principal removes every entry, also when that principal was
 *     read at page load (a new module graph) or could not be read, and a sign-in with none before it
 *     and a refresh for the same principal keep them. Thirty-three scopes leave thirty-two entries,
 *     counting entries from before a reload.
 *  4. A copied tab (a store on a copy of the storage) holds the same key until it releases its own.
 *  5. Storage that is missing or throws: the store still answers from memory and says so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAuthPrincipalKey, notifyAuthPrincipalChange } from '../src/composables/authPrincipal'
import { useAuth } from '../src/composables/useAuth'
import { readDispatchIdentity } from '../src/tasks/recordTaskDispatchIdentity'
import {
  DISPATCH_KEY_MAX_ENTRIES,
  DISPATCH_KEY_STORAGE_PREFIX,
  createDispatchKeyStore,
  dispatchKeyStorageKey,
  dispatchKeys,
  isDispatchKey,
  resetDispatchKeysForTests,
  type DispatchKeyStore,
  type DispatchKeyStoreDeps,
} from '../src/tasks/recordTaskDispatchKey'
import { UuidUnavailableError, randomUuid } from '../src/utils/uuid'
import { EXPLICIT_SESSION_ORG_KEY } from '../src/utils/explicitSessionOrg'

const SCOPE = { sheetId: 'sht_1', recordId: 'rec_1' }
const OTHER_SCOPE = { sheetId: 'sht_1', recordId: 'rec_2' }
const THIRD_SCOPE = { sheetId: 'sht_2', recordId: 'rec_1' }
const KEY_A = '11111111-1111-4111-8111-111111111111'

function makeStorage(seed: Array<[string, string]> = []): Storage {
  const values = new Map<string, string>(seed)
  return {
    get length() {
      return values.size
    },
    clear() {
      values.clear()
    },
    getItem(key: string) {
      return values.get(key) ?? null
    },
    key(index: number) {
      return [...values.keys()][index] ?? null
    },
    removeItem(key: string) {
      values.delete(key)
    },
    setItem(key: string, value: string) {
      values.set(key, String(value))
    },
  } as Storage
}

function entriesOf(storage: Storage): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (let index = 0; index < storage.length; index += 1) {
    const name = storage.key(index)!
    out.push([name, storage.getItem(name)!])
  }
  return out
}

function keyEntriesOf(storage: Storage): Array<[string, string]> {
  return entriesOf(storage).filter(([name]) => name.startsWith(DISPATCH_KEY_STORAGE_PREFIX))
}

function storeOn(storage: Storage | null, overrides: Partial<DispatchKeyStoreDeps> = {}): DispatchKeyStore {
  return createDispatchKeyStore({ storage: () => storage, mint: randomUuid, now: () => 1000, ...overrides })
}

function jwt(payload: Record<string, unknown>): string {
  return `header.${btoa(JSON.stringify(payload))}.signature`
}

function storeToken(token: string): void {
  localStorage.setItem('auth_token', token)
  localStorage.setItem('jwt', token)
}

function storeExplicitSession(): { token: string; actor: string; tenantId: string; epoch: string } {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const actor = 'usr_explicit'
  const tenantId = 'org_explicit'
  const token = jwt({ userId: actor, tenantId, exp })
  storeToken(token)
  const epoch = 'epoch-marker-text'
  localStorage.setItem(EXPLICIT_SESSION_ORG_KEY, JSON.stringify({ state: 'ready', token, actor, tenantId, exp, epoch }))
  return { token, actor, tenantId, epoch }
}

/** The session switch reads the new session one microtask after the notification. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

let session: Storage

beforeEach(() => {
  session = makeStorage()
  vi.stubGlobal('sessionStorage', session)
  resetDispatchKeysForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetDispatchKeysForTests()
})

describe('what an entry holds', () => {
  afterEach(() => {
    window.history.replaceState({}, '', '/')
  })

  const sessions: Array<{ name: string; arrange: () => string[]; principal: RegExp }> = [
    {
      name: 'a token whose payload has no subject claim',
      arrange: () => {
        const token = jwt({ role: 'member' })
        storeToken(token)
        return [token]
      },
      principal: /^token:/,
    },
    {
      name: 'an opaque token that is not a JWT',
      arrange: () => {
        storeToken('opaque-session-text')
        return ['opaque-session-text']
      },
      principal: /^token:/,
    },
    {
      name: 'an explicitly selected session',
      arrange: () => {
        const { token, actor, tenantId, epoch } = storeExplicitSession()
        return [token, actor, tenantId, epoch]
      },
      principal: /^\["explicit"/,
    },
    {
      name: 'a stored org hint',
      arrange: () => {
        const token = jwt({ userId: 'usr_hint' })
        storeToken(token)
        localStorage.setItem('tenantId', 'org_hint_text')
        return [token, 'usr_hint', 'org_hint_text']
      },
      principal: /^sub:/,
    },
    {
      name: 'an org in the address',
      arrange: () => {
        const token = jwt({ userId: 'usr_address' })
        storeToken(token)
        window.history.replaceState({}, '', '/?tenantId=org_address_text')
        expect(readDispatchIdentity()).toContain('org_address_text')
        return [token, 'usr_address', 'org_address_text']
      },
      principal: /^sub:/,
    },
  ]

  it.each(sessions)('under $name it holds ids and counters only', ({ arrange, principal }) => {
    const sessionTexts = arrange()
    expect(getAuthPrincipalKey()).toMatch(principal)
    resetDispatchKeysForTests()

    const { key, persisted } = dispatchKeys.obtain(SCOPE)
    dispatchKeys.markSent(SCOPE)
    dispatchKeys.markSettled(SCOPE)
    dispatchKeys.markSent(SCOPE)

    expect(persisted).toBe(true)
    expect(isDispatchKey(key)).toBe(true)
    const entries = keyEntriesOf(session)
    expect(entries.map(([name]) => name)).toEqual([`${DISPATCH_KEY_STORAGE_PREFIX}["sht_1","rec_1"]`])
    const value = JSON.parse(entries[0][1]) as Record<string, unknown>
    expect(Object.keys(value).sort()).toEqual(['at', 'key', 'sends', 'settled', 'v'])
    expect(value).toMatchObject({ v: 1, key, sends: 2, settled: 1 })

    const everything = entriesOf(session).flat().join('\n')
    for (const text of [...sessionTexts, readDispatchIdentity(), getAuthPrincipalKey()!]) {
      expect(everything).not.toContain(text)
    }
  })

  it('the entry name does not depend on who is signed in', () => {
    storeToken(jwt({ userId: 'usr_a', tenantId: 'org_a' }))
    const first = dispatchKeyStorageKey(SCOPE)
    storeToken(jwt({ userId: 'usr_b', tenantId: 'org_b' }))
    expect(dispatchKeyStorageKey(SCOPE)).toBe(first)
  })

  it('ids cannot run together in an entry name', () => {
    expect(dispatchKeyStorageKey({ sheetId: 'a","b', recordId: 'c' }))
      .not.toBe(dispatchKeyStorageKey({ sheetId: 'a', recordId: 'b","c' }))
  })

  const invalidValues: Array<[string, string]> = [
    ['not JSON', 'x'],
    ['null', 'null'],
    ['a list', '[]'],
    ['another version', JSON.stringify({ v: 2, key: KEY_A, at: 1, sends: 1, settled: 0 })],
    ['a key that is not a uuid', JSON.stringify({ v: 1, key: 'not-a-uuid-at-all', at: 1, sends: 1, settled: 0 })],
    ['a key with text after it', JSON.stringify({ v: 1, key: `${KEY_A}x`, at: 1, sends: 1, settled: 0 })],
    ['a key with text before it', JSON.stringify({ v: 1, key: `x${KEY_A}`, at: 1, sends: 1, settled: 0 })],
    ['an upper-case key', JSON.stringify({ v: 1, key: KEY_A.replace(/1/g, 'A'), at: 1, sends: 1, settled: 0 })],
    ['more 4xx answers than sends', JSON.stringify({ v: 1, key: KEY_A, at: 1, sends: 1, settled: 2 })],
    ['a negative count', JSON.stringify({ v: 1, key: KEY_A, at: 1, sends: -1, settled: -1 })],
    ['a fractional count', JSON.stringify({ v: 1, key: KEY_A, at: 1, sends: 1.5, settled: 0 })],
    ['a missing count', JSON.stringify({ v: 1, key: KEY_A, at: 1, sends: 1 })],
    ['a time that is not a number', JSON.stringify({ v: 1, key: KEY_A, at: 'then', sends: 1, settled: 0 })],
    // Written out: JSON.stringify turns an infinite number into null, and JSON.parse reads this one as infinite.
    ['a time that is not finite', `{"v":1,"key":"${KEY_A}","at":1e999,"sends":1,"settled":0}`],
  ]

  it.each(invalidValues)('%s reads as no entry and is removed', (_label, raw) => {
    const name = dispatchKeyStorageKey(SCOPE)
    const storage = makeStorage([[name, raw]])
    const store = storeOn(storage)

    expect(store.isUnresolved(SCOPE)).toBe(false)
    expect(storage.getItem(name)).toBeNull()
    expect(store.obtain(SCOPE).key).not.toBe(KEY_A)
  })

  it('a valid stored entry is read back whole', () => {
    const name = dispatchKeyStorageKey(SCOPE)
    const storage = makeStorage([[name, JSON.stringify({ v: 1, key: KEY_A, at: 5, sends: 2, settled: 1 })]])
    const store = storeOn(storage)

    expect(store.isUnresolved(SCOPE)).toBe(true)
    expect(store.isPersisted(SCOPE)).toBe(true)
    expect(store.obtain(SCOPE)).toEqual({ key: KEY_A, persisted: true })

    store.markSettled(SCOPE)
    expect(store.isUnresolved(SCOPE)).toBe(false)
  })
})

describe('counters', () => {
  it('a new entry is dormant, a send makes it unresolved, a 4xx answer makes it dormant again with the same key', () => {
    const store = storeOn(makeStorage())
    const { key } = store.obtain(SCOPE)
    expect(store.isUnresolved(SCOPE)).toBe(false)

    expect(store.markSent(SCOPE)).toEqual({ persisted: true })
    expect(store.isUnresolved(SCOPE)).toBe(true)

    store.markSettled(SCOPE)
    expect(store.isUnresolved(SCOPE)).toBe(false)
    expect(store.obtain(SCOPE).key).toBe(key)
  })

  it('a 4xx answer to a resend after an unanswered send leaves the entry unresolved', () => {
    const store = storeOn(makeStorage())
    store.obtain(SCOPE)
    store.markSent(SCOPE)
    store.markSent(SCOPE)
    store.markSettled(SCOPE)
    expect(store.isUnresolved(SCOPE)).toBe(true)
  })

  it('settled never exceeds sends', () => {
    const storage = makeStorage()
    const store = storeOn(storage)
    store.obtain(SCOPE)
    store.markSent(SCOPE)
    store.markSettled(SCOPE)
    store.markSettled(SCOPE)
    expect(JSON.parse(storage.getItem(dispatchKeyStorageKey(SCOPE))!)).toMatchObject({ sends: 1, settled: 1 })
  })

  it('a mark on a scope with no entry creates nothing', () => {
    const storage = makeStorage()
    const store = storeOn(storage)
    store.markSettled(SCOPE)
    expect(store.markSent(SCOPE)).toEqual({ persisted: false })
    expect(entriesOf(storage)).toEqual([])
    expect(store.isUnresolved(SCOPE)).toBe(false)
    expect(store.isPersisted(SCOPE)).toBe(false)
  })

  it('a reload finds the same key and counters', () => {
    const storage = makeStorage()
    const first = storeOn(storage)
    const { key } = first.obtain(SCOPE)
    first.markSent(SCOPE)

    const afterReload = storeOn(storage)
    expect(afterReload.isUnresolved(SCOPE)).toBe(true)
    expect(afterReload.obtain(SCOPE).key).toBe(key)
    afterReload.markSettled(SCOPE)
    expect(afterReload.isUnresolved(SCOPE)).toBe(false)
  })

  it('a 4xx answer read back after a reload leaves the entry dormant with the same key', () => {
    const storage = makeStorage()
    const first = storeOn(storage)
    const { key } = first.obtain(SCOPE)
    first.markSent(SCOPE)
    first.markSettled(SCOPE)

    const afterReload = storeOn(storage)
    expect(afterReload.isUnresolved(SCOPE)).toBe(false)
    expect(afterReload.obtain(SCOPE).key).toBe(key)
  })

  it('release removes the entry from memory and storage, and the next key is new', () => {
    const storage = makeStorage()
    const store = storeOn(storage)
    const { key } = store.obtain(SCOPE)
    store.obtain(OTHER_SCOPE)
    store.markSent(SCOPE)

    store.release(SCOPE)

    expect(storage.getItem(dispatchKeyStorageKey(SCOPE))).toBeNull()
    expect(storage.getItem(dispatchKeyStorageKey(OTHER_SCOPE))).not.toBeNull()
    expect(store.isUnresolved(SCOPE)).toBe(false)
    expect(store.obtain(SCOPE).key).not.toBe(key)
  })

  it('an entry is written when it is made, not later', () => {
    const storage = makeStorage()
    const { key } = storeOn(storage).obtain(SCOPE)
    expect(JSON.parse(storage.getItem(dispatchKeyStorageKey(SCOPE))!)).toMatchObject({ key, sends: 0, settled: 0 })
  })
})

describe('session changes', () => {
  const USER_A = jwt({ sub: 'usr_a', iat: 1 })
  const USER_A_REFRESHED = jwt({ sub: 'usr_a', iat: 2 })
  const USER_B = jwt({ sub: 'usr_b', iat: 1 })

  function obtainThree(): string {
    const { key } = dispatchKeys.obtain(SCOPE)
    dispatchKeys.obtain(OTHER_SCOPE)
    dispatchKeys.obtain(THIRD_SCOPE)
    expect(keyEntriesOf(session)).toHaveLength(3)
    return key
  }

  it('signing out removes every entry, and only entries', async () => {
    useAuth().setToken(USER_A)
    await settle()
    const key = obtainThree()
    session.setItem('another.feature', 'kept')

    useAuth().clearToken()
    await settle()

    expect(keyEntriesOf(session)).toEqual([])
    expect(session.getItem('another.feature')).toBe('kept')
    expect(dispatchKeys.isUnresolved(SCOPE)).toBe(false)
    expect(dispatchKeys.obtain(SCOPE).key).not.toBe(key)
  })

  it('moving to another account removes every entry', async () => {
    useAuth().setToken(USER_A)
    await settle()
    obtainThree()

    useAuth().setToken(USER_B)
    await settle()

    expect(keyEntriesOf(session)).toEqual([])
  })

  it('a partial session switch removes every entry', async () => {
    useAuth().setToken(USER_A)
    await settle()
    obtainThree()

    localStorage.setItem(EXPLICIT_SESSION_ORG_KEY, JSON.stringify({ state: 'changing', epoch: 'epoch' }))
    notifyAuthPrincipalChange()
    await settle()

    expect(keyEntriesOf(session)).toEqual([])
  })

  it('a token refresh for the same principal keeps the entries', async () => {
    useAuth().setToken(USER_A)
    await settle()
    const key = obtainThree()

    useAuth().setToken(USER_A_REFRESHED)
    await settle()

    expect(keyEntriesOf(session)).toHaveLength(3)
    expect(dispatchKeys.obtain(SCOPE).key).toBe(key)
  })

  it('a sign-in with no principal before it keeps the entries', async () => {
    const key = obtainThree()

    useAuth().setToken(USER_A)
    await settle()

    expect(keyEntriesOf(session)).toHaveLength(3)
    expect(dispatchKeys.obtain(SCOPE).key).toBe(key)
  })

  it('the principal is followed across changes: sign-in, then sign-out', async () => {
    const key = obtainThree()
    useAuth().setToken(USER_A)
    await settle()
    expect(dispatchKeys.obtain(SCOPE).key).toBe(key)

    useAuth().clearToken()
    await settle()

    expect(keyEntriesOf(session)).toEqual([])
  })

  it('setToken for the same account during an explicit session removes every entry', async () => {
    const { token } = storeExplicitSession()
    resetDispatchKeysForTests()
    expect(getAuthPrincipalKey()).toMatch(/^\["explicit"/)
    obtainThree()

    useAuth().setToken(token)
    await settle()

    expect(getAuthPrincipalKey()).toBe('sub:usr_explicit')
    expect(keyEntriesOf(session)).toEqual([])
  })

  it('a sign-in after a session that could not be read removes every entry', async () => {
    localStorage.setItem(EXPLICIT_SESSION_ORG_KEY, JSON.stringify({ state: 'changing', epoch: 'epoch' }))
    resetDispatchKeysForTests()
    obtainThree()

    useAuth().setToken(USER_A)
    await settle()

    expect(keyEntriesOf(session)).toEqual([])
  })

  it('a session change puts nothing in storage but the entries, and no session text', async () => {
    const tokens = ['opaque-session-text-a', 'opaque-session-text-b']
    useAuth().setToken(tokens[0])
    await settle()
    obtainThree()

    useAuth().setToken(tokens[1])
    await settle()
    expect(entriesOf(session)).toEqual([])

    dispatchKeys.obtain(SCOPE)
    const all = entriesOf(session)
    expect(all.map(([name]) => name)).toEqual([dispatchKeyStorageKey(SCOPE)])
    for (const token of tokens) expect(all.flat().join('\n')).not.toContain(token)
  })

  describe('as the page loads', () => {
    afterEach(() => {
      vi.resetModules()
    })

    it('a principal read at load is remembered and its sign-out removes every entry', async () => {
      storeToken(USER_A)
      vi.resetModules()
      const fresh = await import('../src/tasks/recordTaskDispatchKey')
      const { useAuth: freshUseAuth } = await import('../src/composables/useAuth')
      fresh.dispatchKeys.obtain(SCOPE)
      fresh.dispatchKeys.obtain(OTHER_SCOPE)
      fresh.dispatchKeys.obtain(THIRD_SCOPE)
      expect(keyEntriesOf(session)).toHaveLength(3)

      freshUseAuth().clearToken()
      await settle()

      expect(keyEntriesOf(session)).toEqual([])
    })

    it('a session that cannot be read at load does not stop the module loading', async () => {
      localStorage.setItem(EXPLICIT_SESSION_ORG_KEY, JSON.stringify({ state: 'changing', epoch: 'epoch' }))
      vi.resetModules()

      const fresh = await import('../src/tasks/recordTaskDispatchKey')

      expect(isDispatchKey(fresh.dispatchKeys.obtain(SCOPE).key)).toBe(true)
    })
  })
})

describe('the cap', () => {
  function scopeAt(index: number): { sheetId: string; recordId: string } {
    return { sheetId: 'sht_cap', recordId: `rec_${index}` }
  }

  function fill(store: DispatchKeyStore, count: number): void {
    for (let index = 0; index < count; index += 1) store.obtain(scopeAt(index))
  }

  function ticking(storage: Storage | null): DispatchKeyStore {
    let tick = 0
    return storeOn(storage, { now: () => (tick += 1) })
  }

  it('one more scope than the cap leaves the cap, and the oldest entry is the one gone', () => {
    const storage = makeStorage()
    const store = ticking(storage)
    fill(store, DISPATCH_KEY_MAX_ENTRIES + 1)

    expect(DISPATCH_KEY_MAX_ENTRIES).toBe(32)
    expect(keyEntriesOf(storage)).toHaveLength(DISPATCH_KEY_MAX_ENTRIES)
    expect(storage.getItem(dispatchKeyStorageKey(scopeAt(0)))).toBeNull()
    expect(storage.getItem(dispatchKeyStorageKey(scopeAt(1)))).not.toBeNull()
  })

  it('an unresolved entry outlasts newer dormant ones', () => {
    const storage = makeStorage()
    const store = ticking(storage)
    fill(store, DISPATCH_KEY_MAX_ENTRIES)
    store.markSent(scopeAt(0))

    store.obtain(scopeAt(DISPATCH_KEY_MAX_ENTRIES))

    expect(store.isUnresolved(scopeAt(0))).toBe(true)
    expect(storage.getItem(dispatchKeyStorageKey(scopeAt(0)))).not.toBeNull()
    expect(storage.getItem(dispatchKeyStorageKey(scopeAt(1)))).toBeNull()
  })

  it('with every entry unresolved the oldest one goes', () => {
    const storage = makeStorage()
    const store = ticking(storage)
    fill(store, DISPATCH_KEY_MAX_ENTRIES)
    for (let index = 0; index < DISPATCH_KEY_MAX_ENTRIES; index += 1) store.markSent(scopeAt(index))

    store.obtain(scopeAt(DISPATCH_KEY_MAX_ENTRIES))

    expect(storage.getItem(dispatchKeyStorageKey(scopeAt(0)))).toBeNull()
    expect(keyEntriesOf(storage)).toHaveLength(DISPATCH_KEY_MAX_ENTRIES)
  })

  it('reusing an existing scope at the cap removes nothing', () => {
    const storage = makeStorage()
    const store = ticking(storage)
    fill(store, DISPATCH_KEY_MAX_ENTRIES)

    store.obtain(scopeAt(0))

    expect(keyEntriesOf(storage)).toHaveLength(DISPATCH_KEY_MAX_ENTRIES)
    expect(storage.getItem(dispatchKeyStorageKey(scopeAt(0)))).not.toBeNull()
  })

  it('entries from before a reload count toward the cap, and the oldest stored one goes', () => {
    const storage = makeStorage()
    fill(ticking(storage), DISPATCH_KEY_MAX_ENTRIES)

    storeOn(storage).obtain(scopeAt(DISPATCH_KEY_MAX_ENTRIES))

    expect(keyEntriesOf(storage)).toHaveLength(DISPATCH_KEY_MAX_ENTRIES)
    expect(storage.getItem(dispatchKeyStorageKey(scopeAt(0)))).toBeNull()
    expect(storage.getItem(dispatchKeyStorageKey(scopeAt(1)))).not.toBeNull()
  })

  it('more stored entries than the cap come down to the cap, by stored time and not by storage order', () => {
    const seeded = 40
    const storage = makeStorage(Array.from({ length: seeded }, (_, index): [string, string] => [
      dispatchKeyStorageKey(scopeAt(index)),
      JSON.stringify({ v: 1, key: KEY_A, at: seeded - index, sends: 0, settled: 0 }),
    ]))

    storeOn(storage).obtain(scopeAt(seeded))

    expect(keyEntriesOf(storage)).toHaveLength(DISPATCH_KEY_MAX_ENTRIES)
    expect(storage.getItem(dispatchKeyStorageKey(scopeAt(30)))).not.toBeNull()
    for (let index = 31; index < seeded; index += 1) {
      expect(storage.getItem(dispatchKeyStorageKey(scopeAt(index)))).toBeNull()
    }
    expect(storage.getItem(dispatchKeyStorageKey(scopeAt(seeded)))).not.toBeNull()
  })

  it('a mint failure at the cap removes nothing', () => {
    const storage = makeStorage()
    fill(ticking(storage), DISPATCH_KEY_MAX_ENTRIES)
    const store = storeOn(storage, {
      mint: () => {
        throw new UuidUnavailableError()
      },
    })

    expect(() => store.obtain(scopeAt(DISPATCH_KEY_MAX_ENTRIES))).toThrow(UuidUnavailableError)
    expect(keyEntriesOf(storage)).toHaveLength(DISPATCH_KEY_MAX_ENTRIES)
  })

  it('the cap also holds in memory when storage is not available', () => {
    const store = ticking(null)
    fill(store, DISPATCH_KEY_MAX_ENTRIES)
    const oldest = store.obtain(scopeAt(0)).key
    store.obtain(scopeAt(DISPATCH_KEY_MAX_ENTRIES))
    expect(store.obtain(scopeAt(0)).key).not.toBe(oldest)
  })
})

describe('a copied tab', () => {
  function copyOf(storage: Storage): Storage {
    return makeStorage(entriesOf(storage))
  }

  it('holds the same key, and keeps it after the original releases its own', () => {
    const original = makeStorage()
    const first = storeOn(original)
    const { key } = first.obtain(SCOPE)
    first.markSent(SCOPE)

    const copy = storeOn(copyOf(original))
    expect(copy.obtain(SCOPE).key).toBe(key)

    first.release(SCOPE)
    expect(copy.obtain(SCOPE).key).toBe(key)
  })

  it('gets a new key once it has released its own', () => {
    const original = makeStorage()
    const first = storeOn(original)
    const { key } = first.obtain(SCOPE)

    const copy = storeOn(copyOf(original))
    copy.release(SCOPE)

    const next = copy.obtain(SCOPE).key
    expect(next).not.toBe(key)
    expect(first.obtain(SCOPE).key).toBe(key)
  })
})

describe('storage that is missing or throws', () => {
  const throwingSet = (): Storage => {
    const storage = makeStorage()
    storage.setItem = () => {
      throw new Error('quota')
    }
    return storage
  }

  it('a refused write is reported, the key stays in memory, and a new page gets a different key', () => {
    const storage = throwingSet()
    const store = storeOn(storage)

    const first = store.obtain(SCOPE)
    expect(isDispatchKey(first.key)).toBe(true)
    expect(first.persisted).toBe(false)
    expect(store.markSent(SCOPE)).toEqual({ persisted: false })
    expect(store.isPersisted(SCOPE)).toBe(false)
    expect(store.isUnresolved(SCOPE)).toBe(true)
    expect(store.obtain(SCOPE).key).toBe(first.key)

    expect(storeOn(storage).obtain(SCOPE).key).not.toBe(first.key)
  })

  it('a write that lands later is reported as landed', () => {
    const storage = makeStorage()
    const setItem = storage.setItem
    storage.setItem = () => {
      throw new Error('quota')
    }
    const store = storeOn(storage)
    store.obtain(SCOPE)
    storage.setItem = setItem

    expect(store.markSent(SCOPE)).toEqual({ persisted: true })
    expect(store.isPersisted(SCOPE)).toBe(true)
  })

  it('after a failed write this page reads its own counters, and a new page reads the stored ones', () => {
    const storage = makeStorage()
    const store = storeOn(storage)
    store.obtain(SCOPE)
    storage.setItem = () => {
      throw new Error('quota')
    }

    expect(store.markSent(SCOPE)).toEqual({ persisted: false })

    expect(store.isUnresolved(SCOPE)).toBe(true)
    expect(storeOn(storage).isUnresolved(SCOPE)).toBe(false)
  })

  it('an accessor that throws behaves like a refused write', () => {
    const store = storeOn(null, {
      storage: () => {
        throw new Error('blocked')
      },
    })

    const first = store.obtain(SCOPE)
    expect(first.persisted).toBe(false)
    expect(store.markSent(SCOPE)).toEqual({ persisted: false })
    expect(store.obtain(SCOPE).key).toBe(first.key)
    expect(() => store.markSettled(SCOPE)).not.toThrow()
    expect(() => store.release(SCOPE)).not.toThrow()
    expect(() => store.releaseAll()).not.toThrow()
  })

  it('no storage call that throws gets out of the store', () => {
    const storage = makeStorage()
    const store = storeOn(storage)
    const { key } = store.obtain(SCOPE)
    const refuse = () => {
      throw new Error('blocked')
    }
    storage.getItem = refuse
    storage.setItem = refuse
    storage.removeItem = refuse
    storage.key = refuse
    Object.defineProperty(storage, 'length', { get: refuse })

    expect(store.obtain(SCOPE).key).toBe(key)
    expect(isDispatchKey(store.obtain(OTHER_SCOPE).key)).toBe(true)
    expect(store.isPersisted(OTHER_SCOPE)).toBe(false)
    expect(store.isUnresolved(THIRD_SCOPE)).toBe(false)
    expect(() => store.release(SCOPE)).not.toThrow()
    expect(() => store.releaseAll()).not.toThrow()
  })

  it('the shared store works with no sessionStorage at all', () => {
    vi.stubGlobal('sessionStorage', undefined)
    resetDispatchKeysForTests()

    const first = dispatchKeys.obtain(SCOPE)
    expect(first.persisted).toBe(false)
    expect(dispatchKeys.obtain(SCOPE).key).toBe(first.key)
  })

  it('only a mint failure comes out, and it leaves nothing behind', () => {
    const storage = makeStorage()
    const store = storeOn(storage, {
      mint: () => {
        throw new UuidUnavailableError()
      },
    })

    expect(() => store.obtain(SCOPE)).toThrow(UuidUnavailableError)
    expect(entriesOf(storage)).toEqual([])
    expect(store.isUnresolved(SCOPE)).toBe(false)
  })
})
