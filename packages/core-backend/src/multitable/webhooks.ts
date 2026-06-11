/**
 * Webhook Types
 * Type definitions for the multitable webhook delivery system.
 */

import { z } from 'zod'

export interface Webhook {
  id: string
  name: string
  url: string              // delivery target URL
  secret?: string          // HMAC signing secret
  events: WebhookEventType[]
  active: boolean
  createdBy: string
  createdAt: string
  updatedAt?: string
  lastDeliveredAt?: string
  failureCount: number     // consecutive failures
  maxRetries: number       // default 3 (WEBHOOK_DEFAULT_MAX_RETRIES)
  // Backoff policy for the retry scheduler. Both NULL/undefined on existing rows
  // → fall back to the module defaults so legacy webhooks keep today's behavior.
  retryBaseDelayMs?: number // first-retry delay; exponential 2^n from here
  retryMaxDelayMs?: number  // cap on the computed backoff (undefined = uncapped)
}

// ─── Retry-policy bounds (shared by route schema + service) ────────────────
export const WEBHOOK_DEFAULT_MAX_RETRIES = 3
export const WEBHOOK_MIN_MAX_RETRIES = 0
export const WEBHOOK_MAX_MAX_RETRIES = 10

export const WEBHOOK_DEFAULT_BASE_RETRY_DELAY_MS = 1_000
export const WEBHOOK_MIN_BASE_RETRY_DELAY_MS = 100
export const WEBHOOK_MAX_BASE_RETRY_DELAY_MS = 60_000 // 1 min

export const WEBHOOK_MIN_MAX_RETRY_DELAY_MS = 1_000
export const WEBHOOK_MAX_MAX_RETRY_DELAY_MS = 3_600_000 // 1 hour

export type WebhookEventType =
  | 'record.created'
  | 'record.updated'
  | 'record.deleted'
  | 'comment.created'

export const ALL_WEBHOOK_EVENT_TYPES: WebhookEventType[] = [
  'record.created',
  'record.updated',
  'record.deleted',
  'comment.created',
]

export interface WebhookDelivery {
  id: string
  webhookId: string
  event: WebhookEventType
  payload: unknown
  status: 'pending' | 'success' | 'failed'
  httpStatus?: number
  responseBody?: string
  attemptCount: number
  createdAt: string
  deliveredAt?: string
  nextRetryAt?: string
}

export interface WebhookCreateInput {
  name: string
  url: string
  secret?: string
  events: WebhookEventType[]
  maxRetries?: number
  retryBaseDelayMs?: number
  retryMaxDelayMs?: number
}

export interface WebhookUpdateInput {
  name?: string
  url?: string
  secret?: string
  events?: WebhookEventType[]
  active?: boolean
  maxRetries?: number
  retryBaseDelayMs?: number
  retryMaxDelayMs?: number
}

// ─── Route validation schemas ──────────────────────────────────────────────
// Bounds-checked at the route layer; out-of-range values are rejected (not
// silently clamped) so callers learn their config is invalid.

const maxRetriesSchema = z
  .number()
  .int()
  .min(WEBHOOK_MIN_MAX_RETRIES)
  .max(WEBHOOK_MAX_MAX_RETRIES)

const retryBaseDelayMsSchema = z
  .number()
  .int()
  .min(WEBHOOK_MIN_BASE_RETRY_DELAY_MS)
  .max(WEBHOOK_MAX_BASE_RETRY_DELAY_MS)

const retryMaxDelayMsSchema = z
  .number()
  .int()
  .min(WEBHOOK_MIN_MAX_RETRY_DELAY_MS)
  .max(WEBHOOK_MAX_MAX_RETRY_DELAY_MS)

export const CreateWebhookSchema = z.object({
  name: z.string().min(1).max(100),
  url: z.string().url(),
  secret: z.string().optional(),
  events: z
    .array(z.enum(ALL_WEBHOOK_EVENT_TYPES as [string, ...string[]]))
    .min(1),
  maxRetries: maxRetriesSchema.optional(),
  retryBaseDelayMs: retryBaseDelayMsSchema.optional(),
  retryMaxDelayMs: retryMaxDelayMsSchema.optional(),
})

export const UpdateWebhookSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  url: z.string().url().optional(),
  secret: z.string().optional(),
  events: z
    .array(z.enum(ALL_WEBHOOK_EVENT_TYPES as [string, ...string[]]))
    .min(1)
    .optional(),
  active: z.boolean().optional(),
  maxRetries: maxRetriesSchema.optional(),
  retryBaseDelayMs: retryBaseDelayMsSchema.optional(),
  retryMaxDelayMs: retryMaxDelayMsSchema.optional(),
})

export type CreateWebhookBody = z.infer<typeof CreateWebhookSchema>
export type UpdateWebhookBody = z.infer<typeof UpdateWebhookSchema>
