import { describe, it, expect } from 'vitest'
import { resolveUserDisplayNames } from '../../src/multitable/user-display'

function fakeQuery(rows: Array<{ id: string; email?: string | null; name?: string | null }>) {
  return async (_sql: string, params?: unknown[]) => {
    const ids = (params?.[0] as string[]) ?? []
    return { rows: rows.filter((r) => ids.includes(r.id)) }
  }
}

describe('resolveUserDisplayNames', () => {
  it('prefers name → email; omits ids with neither (caller falls back to the raw id)', async () => {
    const q = fakeQuery([
      { id: 'u1', name: 'Alice', email: 'a@x.com' },
      { id: 'u2', name: '', email: 'b@x.com' },
      { id: 'u3', name: null, email: null },
    ])
    const m = await resolveUserDisplayNames(q, ['u1', 'u2', 'u3', 'u4'])
    expect(m.get('u1')).toBe('Alice')
    expect(m.get('u2')).toBe('b@x.com')
    expect(m.has('u3')).toBe(false) // no name/email → omitted → caller shows the id
    expect(m.has('u4')).toBe(false) // not a known user
  })

  it('dedups + ignores null/empty ids; empty input issues no query', async () => {
    let calls = 0
    const q = async () => { calls++; return { rows: [] as unknown[] } }
    expect((await resolveUserDisplayNames(q, [])).size).toBe(0)
    expect((await resolveUserDisplayNames(q, [null, undefined, ''])).size).toBe(0)
    expect(calls).toBe(0)
  })

  it('is graceful when the users table is absent (throws) → empty map', async () => {
    const q = async () => { throw new Error('relation "users" does not exist') }
    expect((await resolveUserDisplayNames(q, ['u1'])).size).toBe(0)
  })

  it('trims whitespace in name/email', async () => {
    const q = fakeQuery([{ id: 'u1', name: '  Bob  ', email: '' }])
    expect((await resolveUserDisplayNames(q, ['u1'])).get('u1')).toBe('Bob')
  })
})
