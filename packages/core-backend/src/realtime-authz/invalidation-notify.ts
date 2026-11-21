/**
 * Transactional invalidation notices for realtime protection.
 *
 * A writer that commits a low-frequency session fact (a revocation, a watermark, a switch) calls
 * `notifyRealtimeInvalidation(client, scope)` with the client of the transaction that writes the
 * fact. PostgreSQL delivers the notice when that transaction commits and drops it when it rolls
 * back, so a notice never precedes its fact and a rolled-back write sends nothing.
 *
 * A notice is a hint to re-read, nothing more: receivers re-check their connections against the
 * committed facts. It grants nothing and restores nothing, and every protected boundary re-reads the
 * facts whether or not a notice arrived.
 *
 * PAYLOAD. Version 1: `{"v":1,"k":"g"}` for a global hint, `{"v":1,"k":"o","r":<ref>}` for an
 * organization and `{"v":1,"k":"u","r":<ref>}` for a user. `<ref>` is an opaque internal reference
 * derived from the id by a one-way function; no user data, credential or business value is sent.
 * Every payload is checked to be strictly below 8000 bytes of UTF-8.
 *
 * AGGREGATION. Hints for more than one user in one call are promoted to the organization that
 * covers them when the caller names it, otherwise to a single global hint.
 */
import { createHash } from 'node:crypto'
import type { InvalidationScope } from './protection'

export const REALTIME_INVALIDATION_CHANNEL = 'metasheet_realtime_invalidation_v1'
export const REALTIME_INVALIDATION_PAYLOAD_VERSION = 1
export const REALTIME_INVALIDATION_MAX_PAYLOAD_BYTES = 8000

export type InvalidationTarget =
  | { readonly kind: 'global' }
  | { readonly kind: 'organization'; readonly organizationId: string }
  | { readonly kind: 'user'; readonly userId: string }

export interface NotifyClient {
  query(sql: string, params?: unknown[]): Promise<unknown>
}

/** One-way opaque reference of an internal id; equal ids give equal references. */
export function invalidationRef(kind: 'organization' | 'user', id: string): string {
  return createHash('sha256')
    .update('metasheet2:realtime-invalidation:v1\0')
    .update(kind)
    .update('\0')
    .update(id)
    .digest('hex')
    .slice(0, 32)
}

export function encodeInvalidationPayload(target: InvalidationTarget): string {
  const payload = target.kind === 'global'
    ? JSON.stringify({ v: REALTIME_INVALIDATION_PAYLOAD_VERSION, k: 'g' })
    : target.kind === 'organization'
      ? JSON.stringify({ v: REALTIME_INVALIDATION_PAYLOAD_VERSION, k: 'o', r: invalidationRef('organization', target.organizationId) })
      : JSON.stringify({ v: REALTIME_INVALIDATION_PAYLOAD_VERSION, k: 'u', r: invalidationRef('user', target.userId) })
  if (Buffer.byteLength(payload, 'utf8') >= REALTIME_INVALIDATION_MAX_PAYLOAD_BYTES) {
    throw new Error('realtime invalidation payload too large')
  }
  return payload
}

const OPAQUE_REF = /^[0-9a-f]{32}$/

/**
 * Decodes a received payload. Anything that is not a well-formed version 1 payload decodes to a
 * global hint: a receiver that cannot read a notice re-checks everything.
 */
export function decodeInvalidationPayload(payload: string | undefined | null): InvalidationScope {
  try {
    const parsed = JSON.parse(String(payload ?? '')) as { v?: unknown; k?: unknown; r?: unknown }
    if (parsed && parsed.v === REALTIME_INVALIDATION_PAYLOAD_VERSION && typeof parsed.r === 'string' && OPAQUE_REF.test(parsed.r)) {
      if (parsed.k === 'u') return { kind: 'user', ref: parsed.r }
      if (parsed.k === 'o') return { kind: 'organization', ref: parsed.r }
    }
  } catch {
    // Not a payload of this version.
  }
  return { kind: 'global' }
}

/**
 * Reduces the hints of one transaction to the notices it sends: duplicates collapse, a global hint
 * covers everything, and more than one user is promoted to the covering organization or to global.
 */
export function aggregateInvalidationTargets(
  targets: readonly InvalidationTarget[],
  options: { coveringOrganizationId?: string } = {},
): InvalidationTarget[] {
  if (targets.length === 0) return []
  if (targets.some((target) => target.kind === 'global')) return [{ kind: 'global' }]
  const organizations = new Set<string>()
  const users = new Set<string>()
  for (const target of targets) {
    if (target.kind === 'organization') organizations.add(target.organizationId)
    else if (target.kind === 'user') users.add(target.userId)
  }
  if (users.size > 1) {
    if (!options.coveringOrganizationId) return [{ kind: 'global' }]
    organizations.add(options.coveringOrganizationId)
    users.clear()
  }
  if (organizations.size > 1) return [{ kind: 'global' }]
  return [
    ...[...organizations].map((organizationId): InvalidationTarget => ({ kind: 'organization', organizationId })),
    ...[...users].map((userId): InvalidationTarget => ({ kind: 'user', userId })),
  ]
}

/**
 * Sends one hint on the transaction of `client`. Call it with the client that writes the fact,
 * inside that transaction.
 */
export async function notifyRealtimeInvalidation(client: NotifyClient, target: InvalidationTarget): Promise<void> {
  await client.query('SELECT pg_catalog.pg_notify($1, $2)', [REALTIME_INVALIDATION_CHANNEL, encodeInvalidationPayload(target)])
}

/** Aggregates the hints of one transaction and sends the resulting notices on `client`. */
export async function notifyRealtimeInvalidations(
  client: NotifyClient,
  targets: readonly InvalidationTarget[],
  options: { coveringOrganizationId?: string } = {},
): Promise<InvalidationTarget[]> {
  const notices = aggregateInvalidationTargets(targets, options)
  for (const notice of notices) await notifyRealtimeInvalidation(client, notice)
  return notices
}
