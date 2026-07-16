/**
 * P2 durable-delivery S3 — versioned routing manifest + bidirectional completeness assertion (pure, no DB).
 *
 * Pins the lock's ratified v1 full set (#4203 §283-291) so a silent manifest edit is a red test, and proves
 * the startup assertion catches BOTH failure directions with the exact offending keys named.
 */
import { describe, expect, test } from 'vitest'

import {
  APPROVAL_COMPLETION_CONSUMERS,
  assertManifestCompleteness,
  CURRENT_ROUTING_MANIFEST,
  expandConsumerKeysForEvent,
  manifestConsumerKeys,
  ROUTING_MANIFEST_V1,
  SUPPORTED_MANIFEST_VERSIONS,
} from '../../src/multitable/automation-routing-manifest'

const registryOf = (...keys: string[]) => ({ keys: () => [...keys] })
const FULL_V1_KEYS = [
  'approval-bridge',
  'approval-trigger',
  'approval-projection',
  'approval-task-trigger',
  'automation-record-trigger',
  'webhook-event-bridge',
]

describe('P2 S3 — routing manifest v1 (lock #4203 §283-291 full set)', () => {
  test('v1 routes exactly the ratified event families to their FULL consumer sets', () => {
    expect(ROUTING_MANIFEST_V1.version).toBe(1)
    for (const t of ['approval.approved', 'approval.rejected', 'approval.revoked', 'approval.cancelled']) {
      expect(expandConsumerKeysForEvent(t)).toEqual(['approval-bridge', 'approval-trigger', 'approval-projection'])
    }
    expect(expandConsumerKeysForEvent('approval.task_created')).toEqual(['approval-task-trigger'])
    for (const t of ['multitable.record.created', 'multitable.record.updated', 'multitable.record.deleted']) {
      expect(expandConsumerKeysForEvent(t)).toEqual(['automation-record-trigger', 'webhook-event-bridge'])
    }
    expect(expandConsumerKeysForEvent('multitable.comment.created')).toEqual(['webhook-event-bridge'])
    expect(expandConsumerKeysForEvent('form.submitted')).toEqual(['automation-record-trigger'])
    // the distinct key universe is exactly the six ratified consumers — no stragglers, none missing
    expect([...manifestConsumerKeys()].sort()).toEqual([...FULL_V1_KEYS].sort())
    // EXACT event-family set — a route ADDED/removed/renamed reds even if it reuses an existing consumer
    // (the per-key checks + the distinct-key universe would otherwise stay green) (#4335 review P2).
    expect(Object.keys(ROUTING_MANIFEST_V1.routes).sort()).toEqual([
      'approval.approved',
      'approval.cancelled',
      'approval.rejected',
      'approval.revoked',
      'approval.task_created',
      'form.submitted',
      'multitable.comment.created',
      'multitable.record.created',
      'multitable.record.deleted',
      'multitable.record.updated',
    ])
  })

  test('an unrouted event type expands to undefined (the producer must treat that as a hard error)', () => {
    expect(expandConsumerKeysForEvent('some.unknown.event')).toBeUndefined()
    expect(expandConsumerKeysForEvent('')).toBeUndefined()
  })

  test('the manifest is DEEP-frozen (a v1 row is dispatched per v1 forever — no in-place edits, incl. arrays)', () => {
    expect(Object.isFrozen(ROUTING_MANIFEST_V1)).toBe(true)
    expect(Object.isFrozen(ROUTING_MANIFEST_V1.routes)).toBe(true)
    // the CONSUMER ARRAYS must be frozen too — `as const` is compile-time only; a bare outer freeze leaves
    // `routes[e].pop()` / a pop on the shared approval array able to silently rewrite v1 (#4335 review P2).
    for (const arr of Object.values(ROUTING_MANIFEST_V1.routes)) {
      expect(Object.isFrozen(arr)).toBe(true)
    }
    expect(Object.isFrozen(APPROVAL_COMPLETION_CONSUMERS)).toBe(true)
    expect(() => (ROUTING_MANIFEST_V1.routes['approval.approved'] as string[]).pop()).toThrow(TypeError)
    expect(() => (APPROVAL_COMPLETION_CONSUMERS as string[]).push('x')).toThrow(TypeError)
    // the mutation attempts changed nothing
    expect(expandConsumerKeysForEvent('approval.approved')).toEqual(['approval-bridge', 'approval-trigger', 'approval-projection'])
    expect(CURRENT_ROUTING_MANIFEST).toBe(ROUTING_MANIFEST_V1)
    expect(SUPPORTED_MANIFEST_VERSIONS.has(1)).toBe(true)
  })

  test('completeness: a registry serving exactly the manifest keys passes', () => {
    expect(() => assertManifestCompleteness(registryOf(...FULL_V1_KEYS))).not.toThrow()
  })

  test('completeness direction 1: a manifest key with NO adapter throws naming that key (rows would park forever)', () => {
    const missingProjection = FULL_V1_KEYS.filter((k) => k !== 'approval-projection')
    expect(() => assertManifestCompleteness(registryOf(...missingProjection))).toThrow(/NO registered adapter.*approval-projection/)
  })

  test('completeness direction 2: an adapter NOT routed by the manifest throws naming that key (dead configuration)', () => {
    expect(() => assertManifestCompleteness(registryOf(...FULL_V1_KEYS, 'ghost-consumer'))).toThrow(/NOT routed by the manifest.*ghost-consumer/)
  })

  test('completeness: both directions violated at once reports BOTH keys', () => {
    const swapped = [...FULL_V1_KEYS.filter((k) => k !== 'approval-bridge'), 'ghost-consumer']
    expect(() => assertManifestCompleteness(registryOf(...swapped))).toThrow(/approval-bridge[\s\S]*ghost-consumer/)
  })
})
