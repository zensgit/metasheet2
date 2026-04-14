/**
 * Webhook Types
 * Type definitions for the multitable webhook delivery system.
 */

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
  maxRetries: number       // default 3
}

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
}

export interface WebhookUpdateInput {
  name?: string
  url?: string
  secret?: string
  events?: WebhookEventType[]
  active?: boolean
}
