import { describe, expect, it, vi } from 'vitest'

import {
  findIntegrationCanary,
  runIntegrationBackfill,
  verifyIntegrationEncryptionConfig,
  type IntegrationConfigRow,
} from '../../scripts/encrypt-dingtalk-integration-secrets'
import type { QueryablePool } from '../../scripts/encrypt-dingtalk-destination-secrets'
import { encryptStoredSecretValue, isEncryptedSecretValue } from '../../src/security/encrypted-secrets'

/**
 * DT-HARDEN-03 P3-3 — the sibling backfill (integration appSecrets) gets the same safety
 * posture the destination backfill was reviewed into: canary pre-flight before any write
 * (a wrong-salt run here overwrites the WHOLE config JSON irreversibly) and a CAS so a
 * concurrent admin save is never clobbered with a stale re-encrypted copy.
 */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {}
  for (const key of Object.keys(vars)) prev[key] = process.env[key]
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const restore = () => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  let result: T
  try {
    result = fn()
  } catch (error) {
    restore()
    throw error
  }
  if (result instanceof Promise) {
    return result.finally(restore) as unknown as T
  }
  restore()
  return result
}

type Tables = { directory: IntegrationConfigRow[]; attendance: IntegrationConfigRow[] }

/** Honest fixture: enforces the jsonb-equality CAS against in-memory state. */
function makeFakePool(
  tables: Tables,
  opts: { afterSelect?: (state: Tables) => void } = {},
): { pool: QueryablePool; queries: { text: string; params?: unknown[] }[]; state: Tables } {
  const state: Tables = {
    directory: tables.directory.map((row) => ({ ...row, config: row.config ? { ...row.config } : row.config })),
    attendance: tables.attendance.map((row) => ({ ...row, config: row.config ? { ...row.config } : row.config })),
  }
  const queries: { text: string; params?: unknown[] }[] = []
  let selects = 0
  const tableOf = (text: string): IntegrationConfigRow[] =>
    /attendance_integrations/.test(text) ? state.attendance : state.directory

  const pool: QueryablePool = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      queries.push({ text, params })
      if (/^\s*SELECT/i.test(text)) {
        const snapshot = tableOf(text).map((row) => ({ ...row, config: row.config ? { ...row.config } : row.config }))
        selects += 1
        if (selects === 2) opts.afterSelect?.(state)
        return { rows: snapshot as unknown[] }
      }
      if (/^\s*UPDATE/i.test(text)) {
        const [id, nextJson, prevJson] = params ?? []
        const row = tableOf(text).find((candidate) => candidate.id === id)
        // jsonb equality is semantic — compare parsed values, not strings.
        const matches = row && JSON.stringify(row.config ?? {}) === JSON.stringify(JSON.parse(prevJson as string))
        if (!matches || !row) return { rows: [] }
        row.config = JSON.parse(nextJson as string)
        return { rows: [{ id }] as unknown[] }
      }
      return { rows: [] }
    }),
  }
  return { pool, queries, state }
}

describe('DT-HARDEN-03 sibling backfill — canary pre-flight', () => {
  it('finds a canary in either table', () => {
    withEnv({ ENCRYPTION_KEY: 'key-a', ENCRYPTION_SALT: 'salt-a' }, () => {
      const enc = encryptStoredSecretValue('secret-live')
      expect(findIntegrationCanary([[], [{ id: 'a', config: { appSecret: enc } }]])).toBe(enc)
      expect(findIntegrationCanary([[{ id: 'b', config: { appsecret: enc } }], []])).toBe(enc)
      expect(findIntegrationCanary([[{ id: 'c', config: { appSecret: 'plain' } }], []])).toBeUndefined()
    })
  })

  it('THE catastrophe case: aborts when the canary was encrypted under a DIFFERENT salt', async () => {
    const canary = withEnv({ ENCRYPTION_KEY: 'key-a', ENCRYPTION_SALT: 'salt-a' }, () =>
      encryptStoredSecretValue('secret-live'),
    )
    await withEnv({ ENCRYPTION_KEY: 'key-a', ENCRYPTION_SALT: 'salt-b' }, async () => {
      const { pool, queries } = makeFakePool({
        directory: [
          { id: 'good', config: { appSecret: canary } },
          { id: 'victim', config: { appSecret: 'plain-live-secret' } },
        ],
        attendance: [],
      })
      await expect(runIntegrationBackfill(pool, { dryRun: false, allowFirstRun: false }))
        .rejects.toThrow(/do not match the pair that encrypted the existing rows/)
      expect(queries.filter((q) => /^\s*UPDATE/i.test(q.text))).toHaveLength(0)
    })
  })

  it('aborts a plaintext-only run without --confirm-first-run', () => {
    withEnv({ ENCRYPTION_KEY: 'key-a', ENCRYPTION_SALT: 'salt-a' }, () => {
      expect(() => verifyIntegrationEncryptionConfig([[{ id: 'a', config: { appSecret: 'plain' } }], []], false))
        .toThrow(/--confirm-first-run/)
      expect(() => verifyIntegrationEncryptionConfig([[{ id: 'a', config: { appSecret: 'plain' } }], []], true))
        .not.toThrow()
    })
  })
})

describe('DT-HARDEN-03 sibling backfill — rewrite + CAS', () => {
  it('encrypts plaintext appSecrets in both tables, normalizes legacy keys, reports counts', async () => {
    await withEnv({ ENCRYPTION_KEY: 'key-a', ENCRYPTION_SALT: 'salt-a' }, async () => {
      const already = encryptStoredSecretValue('done')
      const { pool, state } = makeFakePool({
        directory: [
          { id: 'd-plain', config: { appSecret: 'dir-secret', corpId: 'c1' } },
          { id: 'd-done', config: { appSecret: already } },
          { id: 'd-none', config: { corpId: 'c2' } },
        ],
        attendance: [{ id: 'a-legacy', config: { app_secret: 'att-secret' } }],
      })

      const result = await runIntegrationBackfill(pool, { dryRun: false, allowFirstRun: false })

      expect(result.directory).toEqual({ encrypted: 1, alreadyEncrypted: 1, skippedConcurrent: 0, total: 3 })
      expect(result.attendance).toEqual({ encrypted: 1, alreadyEncrypted: 0, skippedConcurrent: 0, total: 1 })
      const dPlain = state.directory.find((row) => row.id === 'd-plain')!.config!
      expect(isEncryptedSecretValue(dPlain.appSecret as string)).toBe(true)
      expect(dPlain.corpId).toBe('c1')
      const aLegacy = state.attendance.find((row) => row.id === 'a-legacy')!.config!
      expect(isEncryptedSecretValue(aLegacy.appSecret as string)).toBe(true)
      expect(aLegacy).not.toHaveProperty('app_secret')
    })
  })

  it('dry-run writes nothing', async () => {
    await withEnv({ ENCRYPTION_KEY: 'key-a', ENCRYPTION_SALT: 'salt-a' }, async () => {
      const { pool, queries } = makeFakePool({
        directory: [{ id: 'd-plain', config: { appSecret: 'dir-secret' } }],
        attendance: [],
      })
      const result = await runIntegrationBackfill(pool, { dryRun: true, allowFirstRun: true })
      expect(result.directory.encrypted).toBe(1)
      expect(queries.filter((q) => /^\s*UPDATE/i.test(q.text))).toHaveLength(0)
    })
  })

  it('P3-1 CAS: a config saved concurrently by an admin is skipped, never clobbered', async () => {
    await withEnv({ ENCRYPTION_KEY: 'key-a', ENCRYPTION_SALT: 'salt-a' }, async () => {
      const rotated = encryptStoredSecretValue('rotated-by-admin')
      const { pool, state } = makeFakePool(
        {
          directory: [{ id: 'victim', config: { appSecret: 'stale-plain' } }],
          attendance: [],
        },
        {
          afterSelect: (tables) => {
            tables.directory[0].config = { appSecret: rotated, note: 'admin edit' }
          },
        },
      )

      const result = await runIntegrationBackfill(pool, { dryRun: false, allowFirstRun: true })

      expect(result.directory).toEqual({ encrypted: 0, alreadyEncrypted: 0, skippedConcurrent: 1, total: 1 })
      expect(state.directory[0].config).toEqual({ appSecret: rotated, note: 'admin edit' })
    })
  })

  it('CAS shape: the UPDATE pins jsonb equality in SQL and carries the previous config as a param', async () => {
    await withEnv({ ENCRYPTION_KEY: 'key-a', ENCRYPTION_SALT: 'salt-a' }, async () => {
      const { pool, queries } = makeFakePool({
        directory: [{ id: 'd-plain', config: { appSecret: 'dir-secret' } }],
        attendance: [],
      })
      await runIntegrationBackfill(pool, { dryRun: false, allowFirstRun: true })
      const update = queries.find((q) => /^\s*UPDATE/i.test(q.text))
      expect(update).toBeDefined()
      expect(update!.text).toContain('AND config = $3::jsonb')
      expect(JSON.parse(update!.params?.[2] as string)).toEqual({ appSecret: 'dir-secret' })
    })
  })
})
