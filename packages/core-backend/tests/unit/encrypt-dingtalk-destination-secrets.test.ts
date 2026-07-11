import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  assertEncryptionConfigPresent,
  findCanary,
  runBackfill,
  verifyEncryptionConfig,
  type DestinationSecretRow,
  type QueryablePool,
} from '../../scripts/encrypt-dingtalk-destination-secrets'
import { encryptStoredSecretValue, isEncryptedSecretValue } from '../../src/security/encrypted-secrets'

/**
 * DT-HARDEN-03 P2-1 — backfill pre-flight.
 *
 * The derived key is pbkdf2(ENCRYPTION_KEY, ENCRYPTION_SALT). A fresh
 * "encrypt+decrypt a sentinel" round-trips against WHATEVER key happens to be
 * derived — right or wrong — so it cannot catch a wrong-salt run. The only check
 * that discriminates is decrypting ciphertext the application already wrote with
 * the KEY/SALT this invocation holds: proven below by round-tripping a canary
 * encrypted under one salt while the process env holds a DIFFERENT salt.
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
  // Promise-aware: encrypted-secrets derives its key from process.env AT CALL TIME, so an
  // async callback must keep the staged env alive until it settles — a plain finally would
  // restore the moment fn() RETURNS the promise, and everything past the callback's first
  // await would run under the outer env (making e.g. the catastrophe test pass for the
  // wrong reason: decrypt fails under the restored env too).
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

/**
 * Honest fixture: UPDATEs are applied against in-memory state and the CAS WHERE is
 * ENFORCED (id + exact previous webhook_url/secret), returning the RETURNING row only on
 * a real match — a fake that ignored the WHERE would shadow exactly the guard the
 * concurrent-rotation test exists to prove. `afterSelect` simulates a writer that lands
 * between the script's SELECT and its UPDATE.
 */
function makeFakePool(
  rows: DestinationSecretRow[],
  opts: { afterSelect?: (state: DestinationSecretRow[]) => void } = {},
): { pool: QueryablePool; queries: { text: string; params?: unknown[] }[]; state: DestinationSecretRow[] } {
  const state = rows.map((row) => ({ ...row }))
  const queries: { text: string; params?: unknown[] }[] = []
  const pool: QueryablePool = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      queries.push({ text, params })
      if (/^\s*SELECT/i.test(text)) {
        const snapshot = state.map((row) => ({ ...row }))
        opts.afterSelect?.(state)
        return { rows: snapshot as unknown[] }
      }
      if (/^\s*UPDATE/i.test(text)) {
        const [id, nextUrl, nextSecret, prevUrl, prevSecret] = params ?? []
        const row = state.find((candidate) => candidate.id === id)
        const casMatches = row
          && row.webhook_url === prevUrl
          && (row.secret ?? null) === ((prevSecret as string | null) ?? null)
        if (!casMatches || !row) return { rows: [] }
        row.webhook_url = nextUrl as string
        row.secret = (nextSecret as string | null) ?? null
        return { rows: [{ id }] as unknown[] }
      }
      return { rows: [] }
    }),
  }
  return { pool, queries, state }
}

describe('DT-HARDEN-03 backfill — assertEncryptionConfigPresent', () => {
  it('requires ENCRYPTION_KEY', () => {
    withEnv({ ENCRYPTION_KEY: undefined, ENCRYPTION_SALT: 'salt-a' }, () => {
      expect(() => assertEncryptionConfigPresent()).toThrow('ENCRYPTION_KEY is required')
    })
  })

  it('requires ENCRYPTION_SALT even when ENCRYPTION_KEY is set (asymmetry P2-1)', () => {
    withEnv({ ENCRYPTION_KEY: 'key-a', ENCRYPTION_SALT: undefined }, () => {
      expect(() => assertEncryptionConfigPresent()).toThrow('ENCRYPTION_SALT is required')
    })
  })

  it('passes when both are set', () => {
    withEnv({ ENCRYPTION_KEY: 'key-a', ENCRYPTION_SALT: 'salt-a' }, () => {
      expect(() => assertEncryptionConfigPresent()).not.toThrow()
    })
  })
})

describe('DT-HARDEN-03 backfill — findCanary', () => {
  it('finds an already-encrypted webhook_url', () => {
    const rows: DestinationSecretRow[] = [
      { id: '1', webhook_url: 'plain', secret: null },
      { id: '2', webhook_url: 'enc:abc', secret: null },
    ]
    expect(findCanary(rows)).toBe('enc:abc')
  })

  it('finds an already-encrypted secret when webhook_url is plaintext', () => {
    const rows: DestinationSecretRow[] = [
      { id: '1', webhook_url: 'plain', secret: 'enc:xyz' },
    ]
    expect(findCanary(rows)).toBe('enc:xyz')
  })

  it('returns undefined when every row is plaintext', () => {
    const rows: DestinationSecretRow[] = [
      { id: '1', webhook_url: 'plain', secret: 'plainsecret' },
    ]
    expect(findCanary(rows)).toBeUndefined()
  })
})

describe('DT-HARDEN-03 backfill — verifyEncryptionConfig (P2-1 pre-flight)', () => {
  it('passes when the canary decrypts under the current KEY/SALT', () => {
    withEnv({ ENCRYPTION_KEY: 'key-a', ENCRYPTION_SALT: 'salt-a' }, () => {
      const canary = encryptStoredSecretValue('https://oapi.dingtalk.com/robot/send?access_token=live')
      expect(isEncryptedSecretValue(canary)).toBe(true)
      expect(() => verifyEncryptionConfig([{ id: '1', webhook_url: canary, secret: null }], false)).not.toThrow()
    })
  })

  it('THE catastrophe case: aborts when the canary was encrypted under a DIFFERENT salt', () => {
    const canary = withEnv({ ENCRYPTION_KEY: 'key-a', ENCRYPTION_SALT: 'salt-a' }, () =>
      encryptStoredSecretValue('https://oapi.dingtalk.com/robot/send?access_token=live'),
    )
    // Same key, WRONG salt — the exact scenario the review flagged: presence of
    // ENCRYPTION_KEY alone does not prove the pair matches production.
    withEnv({ ENCRYPTION_KEY: 'key-a', ENCRYPTION_SALT: 'salt-b' }, () => {
      expect(() => verifyEncryptionConfig([{ id: '1', webhook_url: canary, secret: null }], false))
        .toThrow(/do not match the pair that encrypted the existing rows/)
    })
  })

  it('aborts when every row is plaintext and --confirm-first-run was not passed', () => {
    withEnv({ ENCRYPTION_KEY: 'key-a', ENCRYPTION_SALT: 'salt-a' }, () => {
      expect(() => verifyEncryptionConfig([{ id: '1', webhook_url: 'plain', secret: null }], false))
        .toThrow(/--confirm-first-run/)
    })
  })

  it('allows a plaintext-only run when --confirm-first-run is explicit', () => {
    withEnv({ ENCRYPTION_KEY: 'key-a', ENCRYPTION_SALT: 'salt-a' }, () => {
      expect(() => verifyEncryptionConfig([{ id: '1', webhook_url: 'plain', secret: null }], true)).not.toThrow()
    })
  })
})

describe('DT-HARDEN-03 backfill — runBackfill', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'unit-test-key'
    process.env.ENCRYPTION_SALT = process.env.ENCRYPTION_SALT || 'unit-test-salt'
  })

  it('encrypts plaintext rows, skips already-encrypted rows, and reports counts', async () => {
    const canary = encryptStoredSecretValue('https://oapi.dingtalk.com/robot/send?access_token=already')
    const { pool, queries } = makeFakePool([
      { id: 'already', webhook_url: canary, secret: null },
      { id: 'needs-both', webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=new', secret: 'SECplain' },
    ])

    const result = await runBackfill(pool, { dryRun: false, allowFirstRun: false })

    expect(result).toEqual({ encrypted: 1, alreadyEncrypted: 1, skippedConcurrent: 0, total: 2 })
    const updates = queries.filter((q) => /^\s*UPDATE/i.test(q.text))
    expect(updates).toHaveLength(1)
    expect(updates[0].params?.[0]).toBe('needs-both')
    expect(isEncryptedSecretValue(updates[0].params?.[1] as string)).toBe(true)
    expect(isEncryptedSecretValue(updates[0].params?.[2] as string)).toBe(true)
  })

  it('P3-1 CAS: a credential rotated between the SELECT and the UPDATE is skipped, never overwritten with the stale re-encryption', async () => {
    const rotatedByAdmin = encryptStoredSecretValue('https://oapi.dingtalk.com/robot/send?access_token=rotated')
    const { pool, state } = makeFakePool(
      [{ id: 'victim', webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=stale-plain', secret: null }],
      {
        // Admin saves a NEW credential (encrypt-on-write stores ciphertext) right after
        // the script read the old plaintext.
        afterSelect: (rows) => {
          const victim = rows.find((row) => row.id === 'victim')
          if (victim) victim.webhook_url = rotatedByAdmin
        },
      },
    )

    const result = await runBackfill(pool, { dryRun: false, allowFirstRun: true })

    expect(result).toEqual({ encrypted: 0, alreadyEncrypted: 0, skippedConcurrent: 1, total: 1 })
    // The admin's rotation survived — not clobbered by re-encrypted stale plaintext.
    expect(state.find((row) => row.id === 'victim')?.webhook_url).toBe(rotatedByAdmin)
  })

  it('P3-1 CAS: the UPDATE itself carries the compare — SQL pins the WHERE, params carry the previous values', async () => {
    // The fixture enforces CAS from the params, so it cannot see a WHERE-only revert;
    // Postgres enforces it from the SQL, which cannot see a params-only revert. Pinning
    // BOTH halves makes either revert red at unit level (the real-DB semantics of this
    // exact clause shape are Postgres's own contract).
    const { pool, queries } = makeFakePool([
      { id: 'plain', webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=old', secret: 'SECplain' },
    ])

    await runBackfill(pool, { dryRun: false, allowFirstRun: true })

    const update = queries.find((q) => /^\s*UPDATE/i.test(q.text))
    expect(update).toBeDefined()
    expect(update!.text).toContain('AND webhook_url = $4')
    expect(update!.text).toContain('AND secret IS NOT DISTINCT FROM $5')
    expect(update!.params?.[3]).toBe('https://oapi.dingtalk.com/robot/send?access_token=old')
    expect(update!.params?.[4]).toBe('SECplain')
  })

  it('dry-run performs zero writes', async () => {
    const canary = encryptStoredSecretValue('https://oapi.dingtalk.com/robot/send?access_token=already')
    const { pool, queries } = makeFakePool([
      { id: 'already', webhook_url: canary, secret: null },
      { id: 'needs-encrypting', webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=new', secret: null },
    ])

    const result = await runBackfill(pool, { dryRun: true, allowFirstRun: false })

    expect(result).toEqual({ encrypted: 1, alreadyEncrypted: 1, skippedConcurrent: 0, total: 2 })
    expect(queries.filter((q) => /^\s*UPDATE/i.test(q.text))).toHaveLength(0)
  })

  it('idempotent re-run: nothing left to encrypt writes zero UPDATEs', async () => {
    const canaryUrl = encryptStoredSecretValue('https://oapi.dingtalk.com/robot/send?access_token=x')
    const canarySecret = encryptStoredSecretValue('SECalready')
    const { pool, queries } = makeFakePool([
      { id: 'already', webhook_url: canaryUrl, secret: canarySecret },
    ])

    const result = await runBackfill(pool, { dryRun: false, allowFirstRun: false })

    expect(result).toEqual({ encrypted: 0, alreadyEncrypted: 1, skippedConcurrent: 0, total: 1 })
    expect(queries.filter((q) => /^\s*UPDATE/i.test(q.text))).toHaveLength(0)
  })

  it(
    'CATASTROPHE GUARD: wrong ENCRYPTION_SALT aborts with ZERO writes instead of overwriting recoverable ' +
    'ciphertext with unrecoverable ciphertext',
    async () => {
      const canary = withEnv({ ENCRYPTION_KEY: 'prod-key', ENCRYPTION_SALT: 'prod-salt' }, () =>
        encryptStoredSecretValue('https://oapi.dingtalk.com/robot/send?access_token=prod-live'),
      )

      await withEnv({ ENCRYPTION_KEY: 'prod-key', ENCRYPTION_SALT: 'wrong-salt' }, async () => {
        const { pool, queries } = makeFakePool([
          { id: 'good', webhook_url: canary, secret: null },
          { id: 'plaintext-victim', webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=victim', secret: null },
        ])

        await expect(runBackfill(pool, { dryRun: false, allowFirstRun: false })).rejects.toThrow(
          /do not match the pair that encrypted the existing rows/,
        )
        expect(queries.filter((q) => /^\s*UPDATE/i.test(q.text))).toHaveLength(0)
      })
    },
  )
})
