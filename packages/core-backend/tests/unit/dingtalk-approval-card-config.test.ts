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
  resolveApprovalCardLinkSecret,
  resolveApprovalCardPublicAppUrl,
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
