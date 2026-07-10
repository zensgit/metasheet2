import { createHmac } from 'crypto'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeStoredSecretValue } from '../../src/security/encrypted-secrets'

const dbMocks = vi.hoisted(() => ({
  query: vi.fn(),
}))

vi.mock('../../src/db/pg', () => ({
  query: dbMocks.query,
}))

import {
  APPROVAL_CARD_LINK_SECRET_CONFIG_KEY,
  APPROVAL_CARD_PUBLIC_APP_URL_CONFIG_KEY,
  generateApprovalCardLinkSecret,
  getApprovalCardConfigStatus,
  resolveApprovalCardLinkSecret,
  resolveApprovalCardLinkSecretForIntegration,
  resolveApprovalCardPublicAppUrl,
  saveApprovalCardPublicAppUrl,
} from '../../src/integrations/dingtalk/approval-card-config'
import { verifyApprovalCardLinkToken } from '../../src/services/ApprovalCardDeliveryAction'

function integrationRow(config: Record<string, unknown> = {}) {
  return { config }
}

function clearCardEnv() {
  vi.stubEnv('APPROVAL_CARD_LINK_SECRET', '')
  vi.stubEnv('PUBLIC_APP_URL', '')
  vi.stubEnv('APP_BASE_URL', '')
}

describe('approval card config resolvers (CFG-1)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    dbMocks.query.mockReset()
    clearCardEnv()
  })

  describe('resolveApprovalCardLinkSecret', () => {
    it('env wins and skips the store entirely', async () => {
      vi.stubEnv('APPROVAL_CARD_LINK_SECRET', '  env-secret  ')
      await expect(resolveApprovalCardLinkSecret()).resolves.toBe('env-secret')
      expect(dbMocks.query).not.toHaveBeenCalled()
    })

    it('falls back to the stored encrypted secret and decrypts it', async () => {
      dbMocks.query.mockResolvedValueOnce({
        rows: [integrationRow({ [APPROVAL_CARD_LINK_SECRET_CONFIG_KEY]: normalizeStoredSecretValue('stored-card-secret') })],
      })
      await expect(resolveApprovalCardLinkSecret()).resolves.toBe('stored-card-secret')
      const [sql, params] = dbMocks.query.mock.calls[0] as [string, unknown[]]
      expect(sql).toContain('FROM directory_integrations')
      expect(params).toEqual(['dingtalk'])
    })

    it('resolves empty (fail-closed) when no integration row or no stored key', async () => {
      dbMocks.query.mockResolvedValueOnce({ rows: [] })
      await expect(resolveApprovalCardLinkSecret()).resolves.toBe('')
      dbMocks.query.mockResolvedValueOnce({ rows: [integrationRow({})] })
      await expect(resolveApprovalCardLinkSecret()).resolves.toBe('')
    })

    it('resolves empty (fail-closed) on query failure or undecryptable stored value', async () => {
      dbMocks.query.mockRejectedValueOnce(new Error('db down'))
      await expect(resolveApprovalCardLinkSecret()).resolves.toBe('')
      dbMocks.query.mockResolvedValueOnce({
        rows: [integrationRow({ [APPROVAL_CARD_LINK_SECRET_CONFIG_KEY]: 'enc:not-a-real-ciphertext' })],
      })
      await expect(resolveApprovalCardLinkSecret()).resolves.toBe('')
    })

    it('sign/verify same-source invariant: a token signed with the resolved stored secret verifies', async () => {
      const stored = integrationRow({ [APPROVAL_CARD_LINK_SECRET_CONFIG_KEY]: normalizeStoredSecretValue('same-source-secret') })
      dbMocks.query.mockResolvedValue({ rows: [stored] })

      // Executor side: sign with whatever the resolver yields (env unset → stored path).
      const secret = await resolveApprovalCardLinkSecret()
      expect(secret).toBe('same-source-secret')
      const deliveryId = 'card-delivery-1'
      const token = createHmac('sha256', secret).update(deliveryId).digest('hex').slice(0, 32)

      // Wrapper side: verify resolves the SAME stored source.
      await expect(verifyApprovalCardLinkToken(deliveryId, token)).resolves.toBe(true)
      await expect(verifyApprovalCardLinkToken(deliveryId, 'f'.repeat(32))).resolves.toBe(false)
    })

    it('verify fail-closes when neither env nor store has a secret', async () => {
      dbMocks.query.mockResolvedValue({ rows: [] })
      await expect(verifyApprovalCardLinkToken('card-delivery-1', 'f'.repeat(32))).resolves.toBe(false)
      // Even a token forged with an EMPTY HMAC key must be rejected — no secret means no verify.
      const emptyKeyForgery = createHmac('sha256', '').update('card-delivery-1').digest('hex').slice(0, 32)
      await expect(verifyApprovalCardLinkToken('card-delivery-1', emptyKeyForgery)).resolves.toBe(false)
    })
  })

  describe('DT-R2 resolveApprovalCardLinkSecretForIntegration', () => {
    it('env wins and skips the store entirely', async () => {
      vi.stubEnv('APPROVAL_CARD_LINK_SECRET', 'env-secret')
      await expect(resolveApprovalCardLinkSecretForIntegration('dir-a')).resolves.toBe('env-secret')
      expect(dbMocks.query).not.toHaveBeenCalled()
    })

    it('resolves the SPECIFIC integration by id (never the LIMIT-1 global pick)', async () => {
      dbMocks.query.mockResolvedValueOnce({
        rows: [{ id: 'dir-a', name: 'Corp A', status: 'active', config: { [APPROVAL_CARD_LINK_SECRET_CONFIG_KEY]: normalizeStoredSecretValue('corp-a-secret') } }],
      })
      await expect(resolveApprovalCardLinkSecretForIntegration('dir-a')).resolves.toBe('corp-a-secret')
      const [sql, params] = dbMocks.query.mock.calls[0] as [string, unknown[]]
      expect(sql).toContain('WHERE id = $1 AND provider = $2')
      expect(params).toEqual(['dir-a', 'dingtalk'])
    })

    it('fail-closes ("") on unknown integration, missing key, undecryptable value, or query failure — NO fallback secret', async () => {
      dbMocks.query.mockResolvedValueOnce({ rows: [] })
      await expect(resolveApprovalCardLinkSecretForIntegration('ghost')).resolves.toBe('')
      dbMocks.query.mockResolvedValueOnce({ rows: [{ id: 'dir-a', name: 'n', status: 'active', config: {} }] })
      await expect(resolveApprovalCardLinkSecretForIntegration('dir-a')).resolves.toBe('')
      dbMocks.query.mockResolvedValueOnce({ rows: [{ id: 'dir-a', name: 'n', status: 'active', config: { [APPROVAL_CARD_LINK_SECRET_CONFIG_KEY]: 'enc:not-a-real-ciphertext' } }] })
      await expect(resolveApprovalCardLinkSecretForIntegration('dir-a')).resolves.toBe('')
      dbMocks.query.mockRejectedValueOnce(new Error('db down'))
      await expect(resolveApprovalCardLinkSecretForIntegration('dir-a')).resolves.toBe('')
    })

    it('verify pinned to corp B rejects a token signed under corp A (fail-closed cross-corp)', async () => {
      // Anti-shadowing mock: the by-id lookup yields corp B, while the legacy LIMIT-1 global
      // pick yields CORP A — if verify ever ignored the pinned integration and fell back to the
      // global pick, tokenA would verify and tokenB would fail, flipping both assertions red.
      dbMocks.query.mockImplementation(async (sql: string) => {
        if (sql.includes('WHERE id = $1')) {
          return { rows: [{ id: 'dir-b', name: 'Corp B', status: 'active', config: { [APPROVAL_CARD_LINK_SECRET_CONFIG_KEY]: normalizeStoredSecretValue('corp-b-secret') } }] }
        }
        return { rows: [{ config: { [APPROVAL_CARD_LINK_SECRET_CONFIG_KEY]: normalizeStoredSecretValue('corp-a-secret') } }] }
      })
      const deliveryId = 'card-delivery-r2'
      const tokenA = createHmac('sha256', 'corp-a-secret').update(deliveryId).digest('hex').slice(0, 32)
      const tokenB = createHmac('sha256', 'corp-b-secret').update(deliveryId).digest('hex').slice(0, 32)
      await expect(verifyApprovalCardLinkToken(deliveryId, tokenA, undefined, 'dir-b')).resolves.toBe(false)
      await expect(verifyApprovalCardLinkToken(deliveryId, tokenB, undefined, 'dir-b')).resolves.toBe(true)
    })

    it('verify without an integration id keeps the legacy resolver (NULL delivery rows stay verifiable)', async () => {
      dbMocks.query.mockResolvedValue({
        rows: [{ config: { [APPROVAL_CARD_LINK_SECRET_CONFIG_KEY]: normalizeStoredSecretValue('legacy-secret') } }],
      })
      const deliveryId = 'card-delivery-legacy'
      const token = createHmac('sha256', 'legacy-secret').update(deliveryId).digest('hex').slice(0, 32)
      await expect(verifyApprovalCardLinkToken(deliveryId, token, undefined, null)).resolves.toBe(true)
    })
  })

  describe('CFG-2 generateApprovalCardLinkSecret', () => {
    function mockIntegration(config: Record<string, unknown> = {}) {
      return { id: 'dir-1', name: 'DingTalk CN', status: 'active', config }
    }

    it('stores an ENCRYPTED 32-byte secret and never echoes the plaintext', async () => {
      let storedParam = ''
      dbMocks.query
        .mockResolvedValueOnce({ rows: [mockIntegration()] })
        .mockImplementationOnce(async (_sql: string, params: unknown[]) => {
          storedParam = String(params[2])
          return { rows: [mockIntegration({ [APPROVAL_CARD_LINK_SECRET_CONFIG_KEY]: storedParam })] }
        })
      const status = await generateApprovalCardLinkSecret('dir-1')
      expect(status?.linkSecret.configured).toBe(true)
      expect(status?.linkSecret.source).toBe('stored')
      expect(status?.linkSecret.valuePrinted).toBe(false)
      // Written value is encrypted-at-rest — never the raw hex.
      expect(storedParam.startsWith('enc:')).toBe(true)
      expect(/^[0-9a-f]{64}$/.test(storedParam)).toBe(false)
      // The response must not leak the plaintext (64 hex chars) anywhere.
      expect(JSON.stringify(status)).not.toMatch(/[0-9a-f]{64}/)
      const updateSql = dbMocks.query.mock.calls[1][0] as string
      expect(updateSql).toContain('jsonb_set')
    })

    it('returns null for an unknown integration (no write issued)', async () => {
      dbMocks.query.mockResolvedValueOnce({ rows: [] })
      await expect(generateApprovalCardLinkSecret('ghost')).resolves.toBeNull()
      expect(dbMocks.query).toHaveBeenCalledTimes(1)
    })

    it('reports envOverrideActive when env still wins at runtime', async () => {
      vi.stubEnv('APPROVAL_CARD_LINK_SECRET', 'env-secret')
      dbMocks.query
        .mockResolvedValueOnce({ rows: [mockIntegration()] })
        .mockResolvedValueOnce({ rows: [mockIntegration({ [APPROVAL_CARD_LINK_SECRET_CONFIG_KEY]: 'enc:x' })] })
      const status = await generateApprovalCardLinkSecret('dir-1')
      expect(status?.linkSecret.envOverrideActive).toBe(true)
      expect(status?.linkSecret.source).toBe('env')
    })
  })

  describe('CFG-2 saveApprovalCardPublicAppUrl', () => {
    function mockIntegration(config: Record<string, unknown> = {}) {
      return { id: 'dir-1', name: 'DingTalk CN', status: 'active', config }
    }

    it('accepts absolute http(s) URLs and echoes the stored value (not a secret)', async () => {
      dbMocks.query
        .mockResolvedValueOnce({ rows: [mockIntegration()] })
        .mockResolvedValueOnce({ rows: [mockIntegration({ [APPROVAL_CARD_PUBLIC_APP_URL_CONFIG_KEY]: 'https://app.example.com' })] })
      const status = await saveApprovalCardPublicAppUrl('dir-1', 'https://app.example.com')
      expect(status?.publicAppUrl.storedValue).toBe('https://app.example.com')
      expect(status?.publicAppUrl.source).toBe('stored')
    })

    it('rejects non-http(s) and relative URLs at the write (scheme allowlist)', async () => {
      await expect(saveApprovalCardPublicAppUrl('dir-1', 'javascript:alert(1)')).rejects.toThrow('http or https')
      await expect(saveApprovalCardPublicAppUrl('dir-1', 'ftp://host/x')).rejects.toThrow('http or https')
      await expect(saveApprovalCardPublicAppUrl('dir-1', 'not a url')).rejects.toThrow('absolute http(s) URL')
      // Validation happens BEFORE any DB access.
      expect(dbMocks.query).not.toHaveBeenCalled()
    })

    it('clears the stored URL when saving empty', async () => {
      dbMocks.query
        .mockResolvedValueOnce({ rows: [mockIntegration({ [APPROVAL_CARD_PUBLIC_APP_URL_CONFIG_KEY]: 'https://old.example.com' })] })
        .mockResolvedValueOnce({ rows: [mockIntegration({})] })
      const status = await saveApprovalCardPublicAppUrl('dir-1', '')
      expect(status?.publicAppUrl.storedValue).toBeNull()
      expect(status?.publicAppUrl.source).toBe('missing')
      const clearSql = dbMocks.query.mock.calls[1][0] as string
      expect(clearSql).toContain("- $2::text")
    })
  })

  describe('CFG-2 getApprovalCardConfigStatus', () => {
    it('reports presence booleans only, with env-first sourcing', async () => {
      vi.stubEnv('PUBLIC_APP_URL', 'https://env.example.com')
      dbMocks.query.mockResolvedValueOnce({
        rows: [{ id: 'dir-1', name: 'n', status: 'active', config: { [APPROVAL_CARD_LINK_SECRET_CONFIG_KEY]: normalizeStoredSecretValue('s') } }],
      })
      const status = await getApprovalCardConfigStatus('dir-1')
      expect(status?.linkSecret).toEqual({ configured: true, source: 'stored', envOverrideActive: false, valuePrinted: false })
      expect(status?.publicAppUrl.source).toBe('env')
      expect(status?.publicAppUrl.envOverrideActive).toBe(true)
      expect(JSON.stringify(status)).not.toContain('enc:')
    })

    it('returns null for an unknown integration', async () => {
      dbMocks.query.mockResolvedValueOnce({ rows: [] })
      await expect(getApprovalCardConfigStatus('ghost')).resolves.toBeNull()
    })
  })

  describe('resolveApprovalCardPublicAppUrl', () => {
    it('env wins (PUBLIC_APP_URL then APP_BASE_URL) with trailing-slash normalization', async () => {
      vi.stubEnv('PUBLIC_APP_URL', 'https://app.example.com')
      await expect(resolveApprovalCardPublicAppUrl()).resolves.toBe('https://app.example.com/')
      vi.stubEnv('PUBLIC_APP_URL', '')
      vi.stubEnv('APP_BASE_URL', 'https://base.example.com/')
      await expect(resolveApprovalCardPublicAppUrl()).resolves.toBe('https://base.example.com/')
      expect(dbMocks.query).not.toHaveBeenCalled()
    })

    it('falls back to the stored plaintext URL, normalized', async () => {
      dbMocks.query.mockResolvedValueOnce({
        rows: [integrationRow({ [APPROVAL_CARD_PUBLIC_APP_URL_CONFIG_KEY]: 'https://stored.example.com' })],
      })
      await expect(resolveApprovalCardPublicAppUrl()).resolves.toBe('https://stored.example.com/')
    })

    it('resolves null when nothing is configured or the store is unreadable', async () => {
      dbMocks.query.mockResolvedValueOnce({ rows: [integrationRow({})] })
      await expect(resolveApprovalCardPublicAppUrl()).resolves.toBeNull()
      dbMocks.query.mockRejectedValueOnce(new Error('db down'))
      await expect(resolveApprovalCardPublicAppUrl()).resolves.toBeNull()
    })
  })
})
