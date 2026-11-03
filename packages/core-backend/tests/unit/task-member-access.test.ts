/**
 * The task access test for the assignee writes (src/services/task-member-access.ts): the copied
 * matcher, the order and number of statements on the caller's `db`, and the one refusal code.
 * Every statement must run on the `db` passed in; the pool is never used.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { query } from '../../src/db/pg'
import { assertTaskAccess, findTaskAccessHolders, holdsTaskCode, TASK_ACCESS_CODES } from '../../src/services/task-member-access'

vi.mock('../../src/db/pg', () => ({
  query: vi.fn(async () => ({ rows: [] })),
  transaction: vi.fn(async () => {
    throw new Error('no transaction in this file')
  }),
}))

interface Person {
  admin?: boolean
  codes?: string[]
  roleCodes?: string[]
  enabled?: boolean
}

const calls: Array<{ sql: string; params?: unknown[] }> = []
let people: Record<string, Person> = {}
/** A read kind (see `kindOf`) whose statement throws instead of answering. */
let failing: { kind: string; error: Error } | null = null

function kindOf(sql: string): string {
  if (sql.includes('FROM users u')) return 'admin'
  if (sql.includes('UNION ALL')) return 'codes'
  if (sql.includes('permissions FROM users')) return 'column'
  if (sql.includes('LEFT JOIN role_permissions')) return 'roles'
  if (sql.includes('FROM user_namespace_admissions')) return 'enabled'
  return sql
}

const db = {
  query: async (raw: string, params?: unknown[]) => {
    const sql = raw.replace(/\s+/g, ' ').trim()
    calls.push({ sql, params })
    if (failing && kindOf(sql) === failing.kind) throw failing.error
    if (sql.includes('FROM users u')) {
      const asked = (params?.[0] ?? []) as string[]
      return { rows: asked.filter((id) => people[id]?.admin).map((user_id) => ({ user_id })) }
    }
    const person = people[String(params?.[0] ?? '')] ?? {}
    if (sql.includes('UNION ALL')) return { rows: (person.codes ?? []).map((code) => ({ code })) }
    if (sql.includes('permissions FROM users')) return { rows: [{ permissions: [] }] }
    if (sql.includes('LEFT JOIN role_permissions')) {
      return { rows: (person.roleCodes ?? person.codes ?? []).map((permission_code) => ({ role_id: 'tasks_member', permission_code })) }
    }
    if (sql.includes('FROM user_namespace_admissions')) {
      return { rows: person.enabled === undefined ? [] : [{ namespace: 'tasks', enabled: person.enabled }] }
    }
    return { rows: [] }
  },
}

function kinds(): string[] {
  return calls.map(({ sql }) => kindOf(sql))
}

beforeEach(() => {
  calls.length = 0
  people = {}
  failing = null
  vi.mocked(query).mockClear()
})

describe('holdsTaskCode', () => {
  it.each([
    [['tasks:read'], 'tasks:read', true],
    [['tasks:write'], 'tasks:read', false],
    [['tasks:*'], 'tasks:write', true],
    [['*:*'], 'tasks:read', true],
    [['tasks:admin'], 'tasks:read', false],
    [['tasks:admin'], 'tasks:write', false],
    [['attendance:*'], 'tasks:read', false],
    [[], 'tasks:read', false],
  ] as Array<[string[], string, boolean]>)('holds the code through the same matcher as the route guard', (codes, code, expected) => {
    expect(holdsTaskCode(codes, code)).toBe(expected)
  })

  it('names the two codes the task routes check', () => {
    expect(TASK_ACCESS_CODES).toEqual(['tasks:read', 'tasks:write'])
  })
})

describe('findTaskAccessHolders', () => {
  it('sends nothing for an empty list', async () => {
    expect(await findTaskAccessHolders(db, [])).toEqual(new Set())
    await expect(assertTaskAccess(db, [])).resolves.toBeUndefined()
    expect(calls).toEqual([])
  })

  it('sends the administrator read first and once for every id, deduplicated; an administrator needs nothing more', async () => {
    people = { 'usr-a': { admin: true }, 'usr-b': { admin: true } }
    expect(await findTaskAccessHolders(db, ['usr-a', 'usr-b', 'usr-a'])).toEqual(new Set(['usr-a', 'usr-b']))
    expect(kinds()).toEqual(['admin'])
    expect(calls[0]?.params).toEqual([['usr-a', 'usr-b']])
  })

  it('stops after the code reads for a person with no codes', async () => {
    expect(await findTaskAccessHolders(db, ['usr-n'])).toEqual(new Set())
    expect(kinds()).toEqual(['admin', 'codes', 'column'])
  })

  it('stops after the code reads and their filter for a person with one code', async () => {
    people = { 'usr-r': { codes: ['tasks:read'], enabled: true } }
    expect(await findTaskAccessHolders(db, ['usr-r'])).toEqual(new Set())
    expect(kinds()).toEqual(['admin', 'codes', 'column', 'roles', 'enabled'])
  })

  it('asks the task access helper for a person with both codes', async () => {
    people = { 'usr-e': { codes: ['tasks:read', 'tasks:write'], enabled: true } }
    expect(await findTaskAccessHolders(db, ['usr-e'])).toEqual(new Set(['usr-e']))
    expect(kinds()).toEqual(['admin', 'codes', 'column', 'roles', 'enabled', 'roles', 'enabled'])
    expect(calls.slice(1).every(({ params }) => params?.[0] === 'usr-e')).toBe(true)
  })

  it('refuses a person with both codes whose task access is not enabled', async () => {
    people = { 'usr-k': { codes: ['tasks:read', 'tasks:write'], enabled: false } }
    expect(await findTaskAccessHolders(db, ['usr-k'])).toEqual(new Set())
  })

  it('checks every person in input order and never uses the pool', async () => {
    people = { 'usr-e': { codes: ['tasks:read', 'tasks:write'], enabled: true }, 'usr-a': { admin: true } }
    expect(await findTaskAccessHolders(db, ['usr-n', 'usr-e', 'usr-a'])).toEqual(new Set(['usr-e', 'usr-a']))
    const order = calls.filter(({ sql }) => sql.includes('UNION ALL')).map(({ params }) => params?.[0])
    expect(order).toEqual(['usr-n', 'usr-e'])
    expect(vi.mocked(query)).not.toHaveBeenCalled()
  })
})

describe('assertTaskAccess', () => {
  it('is 422 ASSIGNEE_TASK_ACCESS_REQUIRED when any person cannot use tasks, and names nobody', async () => {
    people = { 'usr-e': { codes: ['tasks:read', 'tasks:write'], enabled: true } }
    const failure = await assertTaskAccess(db, ['usr-e', 'usr-n']).then(() => null, (error: unknown) => error)
    expect(failure).toMatchObject({ status: 422, code: 'ASSIGNEE_TASK_ACCESS_REQUIRED' })
    expect(String((failure as Error).message)).toBe('ASSIGNEE_TASK_ACCESS_REQUIRED')
    expect(String((failure as Error).message)).not.toContain('usr-n')
  })

  it('resolves when every person can use tasks', async () => {
    people = { 'usr-e': { codes: ['tasks:read', 'tasks:write'], enabled: true }, 'usr-a': { admin: true } }
    await expect(assertTaskAccess(db, ['usr-e', 'usr-a'])).resolves.toBeUndefined()
  })
})

describe('a failed read', () => {
  it.each(['admin', 'codes', 'column', 'roles', 'enabled'])('read %# failing rejects with its own error, not 422, and nothing is sent after it', async (kind) => {
    people = { 'usr-e': { codes: ['tasks:read', 'tasks:write'], enabled: true } }
    const error = new Error(`read failed: ${kind}`)
    failing = { kind, error }
    await expect(findTaskAccessHolders(db, ['usr-e', 'usr-f'])).rejects.toBe(error)
    expect(kinds().at(-1)).toBe(kind)
    expect(kinds().filter((seen) => seen === kind)).toHaveLength(1)

    calls.length = 0
    const failure = await assertTaskAccess(db, ['usr-e']).then(() => null, (caught: unknown) => caught)
    expect(failure).toBe(error)
    expect(failure).not.toMatchObject({ status: 422 })
    expect(vi.mocked(query)).not.toHaveBeenCalled()
  })
})
