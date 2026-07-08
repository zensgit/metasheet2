import { decryptStoredSecretValue, normalizeStoredSecretValue } from '../security/encrypted-secrets'

/**
 * DT-HARDEN-03 — at-rest boundary for DingTalk group-robot credentials.
 *
 * `dingtalk_group_destinations.webhook_url` embeds the robot's `access_token` and
 * `secret` is the HMAC signing key: together they are enough to inject messages
 * into a customer's group. They were stored as plain text while every other
 * DingTalk credential in this repo (appSecret, agentId, approvalCardLinkSecret)
 * goes through `encrypted-secrets`, so a database dump leaked live send capability.
 *
 * Encrypt on write, decrypt on read. `decryptStoredSecretValue` passes non-`enc:`
 * values through unchanged, so pre-existing plaintext rows keep working and get
 * re-encrypted the next time they are written (or by the backfill script,
 * scripts/encrypt-dingtalk-destination-secrets.ts).
 *
 * Storage-shaped values MUST NOT reach URL validation, signing, masking, logs, or
 * API responses — every read site decrypts first.
 */
export function encryptDingTalkDestinationValue(plaintext: string): string {
  return normalizeStoredSecretValue(plaintext)
}

export function decryptDingTalkDestinationWebhookUrl(stored: string): string {
  return decryptStoredSecretValue(stored)
}

export function decryptDingTalkDestinationSecret(stored: string | null | undefined): string | undefined {
  if (typeof stored !== 'string' || stored.length === 0) return undefined
  const plaintext = decryptStoredSecretValue(stored)
  return plaintext.length > 0 ? plaintext : undefined
}

export interface DingTalkGroupDestination {
  id: string
  name: string
  webhookUrl: string
  secret?: string
  hasSecret?: boolean
  enabled: boolean
  scope: 'private' | 'sheet' | 'org'
  sheetId?: string
  orgId?: string
  createdBy: string
  createdAt: string
  updatedAt?: string
  lastTestedAt?: string
  lastTestStatus?: 'success' | 'failed'
  lastTestError?: string
}

export interface DingTalkGroupDestinationCreateInput {
  name: string
  webhookUrl: string
  secret?: string
  enabled?: boolean
  scope?: 'private' | 'sheet' | 'org'
  sheetId?: string
  orgId?: string
}

export interface DingTalkGroupDestinationUpdateInput {
  name?: string
  webhookUrl?: string
  secret?: string
  enabled?: boolean
}

export interface DingTalkGroupTestSendInput {
  subject?: string
  content?: string
}

export interface DingTalkGroupDelivery {
  id: string
  destinationId: string
  sourceType: 'manual_test' | 'automation'
  subject: string
  content: string
  success: boolean
  httpStatus?: number
  responseBody?: string
  errorMessage?: string
  automationRuleId?: string
  recordId?: string
  initiatedBy?: string
  createdAt: string
  deliveredAt?: string
}
