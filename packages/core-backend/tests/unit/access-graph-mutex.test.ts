import { describe, expect, it, vi } from 'vitest'
import {
  lockUsersForAccessGraphWrite,
  supersedeDeprovisionEvidenceForAccessGraphWrite,
} from '../../src/directory/access-graph-mutex'

describe('access-graph mutex protocol', () => {
  it('deduplicates and locks multi-user batches in lexical order', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    const client = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params })
        return {
          rows: [{
            id: params[0],
            email: null,
            username: null,
            mobile: null,
            activation_status: 'activated',
            is_active: true,
            access_generation: 0,
          }],
        }
      }),
    }

    const locked = await lockUsersForAccessGraphWrite(client, [
      'user-z',
      'user-a',
      'user-z',
      ' user-m ',
    ])

    expect(calls.map((call) => call.params[0])).toEqual([
      'user-a',
      'user-m',
      'user-z',
    ])
    expect(calls.every((call) => /FROM users[\s\S]*FOR UPDATE/i.test(call.sql))).toBe(true)
    expect(Array.from(locked.keys())).toEqual(['user-a', 'user-m', 'user-z'])
  })

  it('keeps supersede and generation as one inseparable helper contract', async () => {
    const statements: string[] = []
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql)
        if (/RETURNING access_generation/i.test(sql)) {
          return { rows: [{ access_generation: 9 }] }
        }
        return { rows: [] }
      }),
    }

    const generations = await supersedeDeprovisionEvidenceForAccessGraphWrite(
      client,
      {
        userIds: ['user-1'],
        actorId: 'admin-1',
        reason: 'test override',
      },
    )

    expect(statements).toHaveLength(3)
    expect(statements[0]).toMatch(/UPDATE directory_deprovision_effects[\s\S]*status = 'superseded'/)
    expect(statements[1]).toMatch(/UPDATE directory_deprovision_events[\s\S]*status = 'superseded'/)
    expect(statements[2]).toMatch(/access_generation = COALESCE\(access_generation, 0\) \+ 1/)
    expect(generations.get('user-1')).toBe(9)
  })
})

