/**
 * P2 durable-delivery S3 — versioned routing manifest + bidirectional completeness assertion (pure, no DB).
 *
 * Pins the lock's ratified v1 full set (#4203 §283-291) so a silent manifest edit is a red test, and proves
 * the startup assertion catches BOTH failure directions with the exact offending keys named.
 */
import { describe, expect, test } from 'vitest'

import {
  APPROVAL_COMPLETION_CONSUMERS,
  APPROVAL_COMPLETION_CONSUMERS_V2,
  APPROVAL_COMPLETION_CONSUMERS_V3,
  APPROVAL_TASK_CREATED_CONSUMERS_V3,
  assertManifestCompleteness,
  CURRENT_ROUTING_MANIFEST,
  expandConsumerKeysForEvent,
  manifestConsumerKeys,
  ROUTING_MANIFEST_V1,
  ROUTING_MANIFEST_V2,
  ROUTING_MANIFEST_V3,
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
// v2 = v1 + the record-level submit-for-approval consumer (multitable x approval phase 2).
const FULL_V2_KEYS = [...FULL_V1_KEYS, 'multitable-record-approval']
// v3 = v2 + the DingTalk approval-todo one-way mirror (plan B).
const FULL_V3_KEYS = [...FULL_V2_KEYS, 'dingtalk-todo-mirror']

describe('P2 S3 — routing manifest v1 (lock #4203 §283-291 full set)', () => {
  test('v1 routes exactly the ratified event families to their FULL consumer sets', () => {
    expect(ROUTING_MANIFEST_V1.version).toBe(1)
    // EXPLICIT v1 manifest argument: the DEFAULT manifest is now v2, and an in-flight row stamped v1 must
    // keep its v1 fan-out forever (#4203 manifest rule). Passing the default here would silently retire v1.
    for (const t of ['approval.approved', 'approval.rejected', 'approval.revoked', 'approval.cancelled']) {
      expect(expandConsumerKeysForEvent(t, ROUTING_MANIFEST_V1)).toEqual(['approval-bridge', 'approval-trigger', 'approval-projection'])
    }
    expect(expandConsumerKeysForEvent('approval.task_created', ROUTING_MANIFEST_V1)).toEqual(['approval-task-trigger'])
    for (const t of ['multitable.record.created', 'multitable.record.updated', 'multitable.record.deleted']) {
      expect(expandConsumerKeysForEvent(t, ROUTING_MANIFEST_V1)).toEqual(['automation-record-trigger', 'webhook-event-bridge'])
    }
    // REMOVED from v1 (owner closure item 2): no producer exists anywhere for this event type — a route
    // nobody produces is dead configuration; family-6 (real comment producer) re-adds it as manifest v2.
    expect(expandConsumerKeysForEvent('multitable.comment.created', ROUTING_MANIFEST_V1)).toBeUndefined()
    // BUS event type (what univer-meta emits + automation-service subscribes) — NOT the trigger type
    // 'form.submitted' the lock's prose shorthand used; the bare trigger-type literal routes nothing.
    expect(expandConsumerKeysForEvent('multitable.form.submitted', ROUTING_MANIFEST_V1)).toEqual(['automation-record-trigger'])
    expect(expandConsumerKeysForEvent('form.submitted', ROUTING_MANIFEST_V1)).toBeUndefined()
    // the distinct key universe is exactly the six ratified consumers — no stragglers, none missing
    expect([...manifestConsumerKeys(ROUTING_MANIFEST_V1)].sort()).toEqual([...FULL_V1_KEYS].sort())
    // EXACT event-family set — a route ADDED/removed/renamed reds even if it reuses an existing consumer
    // (the per-key checks + the distinct-key universe would otherwise stay green) (#4335 review P2).
    expect(Object.keys(ROUTING_MANIFEST_V1.routes).sort()).toEqual([
      'approval.approved',
      'approval.cancelled',
      'approval.rejected',
      'approval.revoked',
      'approval.task_created',
      'multitable.form.submitted',
      'multitable.record.created',
      'multitable.record.deleted',
      'multitable.record.updated',
    ])
  })

  test('an unrouted event type expands to undefined (the producer must treat that as a hard error)', () => {
    expect(expandConsumerKeysForEvent('some.unknown.event')).toBeUndefined()
    expect(expandConsumerKeysForEvent('')).toBeUndefined()
    expect(expandConsumerKeysForEvent('some.unknown.event', ROUTING_MANIFEST_V1)).toBeUndefined()
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
    expect(expandConsumerKeysForEvent('approval.approved', ROUTING_MANIFEST_V1)).toEqual(['approval-bridge', 'approval-trigger', 'approval-projection'])
    expect(SUPPORTED_MANIFEST_VERSIONS.has(1)).toBe(true)
  })

  test('completeness: a registry serving exactly the manifest keys passes', () => {
    expect(() => assertManifestCompleteness(registryOf(...FULL_V1_KEYS), ROUTING_MANIFEST_V1)).not.toThrow()
    expect(() => assertManifestCompleteness(registryOf(...FULL_V2_KEYS), ROUTING_MANIFEST_V2)).not.toThrow()
    // no explicit manifest = the CURRENT one (v3)
    expect(() => assertManifestCompleteness(registryOf(...FULL_V3_KEYS))).not.toThrow()
  })

  test('completeness direction 1: a manifest key with NO adapter throws naming that key (rows would park forever)', () => {
    const missingProjection = FULL_V1_KEYS.filter((k) => k !== 'approval-projection')
    expect(() => assertManifestCompleteness(registryOf(...missingProjection), ROUTING_MANIFEST_V1)).toThrow(/NO registered adapter.*approval-projection/)
  })

  test('completeness direction 2: an adapter NOT routed by the manifest throws naming that key (dead configuration)', () => {
    expect(() => assertManifestCompleteness(registryOf(...FULL_V1_KEYS, 'ghost-consumer'), ROUTING_MANIFEST_V1)).toThrow(/NOT routed by the manifest.*ghost-consumer/)
  })

  test('completeness: both directions violated at once reports BOTH keys', () => {
    const swapped = [...FULL_V1_KEYS.filter((k) => k !== 'approval-bridge'), 'ghost-consumer']
    expect(() => assertManifestCompleteness(registryOf(...swapped), ROUTING_MANIFEST_V1)).toThrow(/approval-bridge[\s\S]*ghost-consumer/)
  })
})

describe('P2 S3 — routing manifest v2 (multitable x approval phase 2: record-level submit-for-approval)', () => {
  test('v2 adds multitable-record-approval to the FOUR completion families ONLY (frozen at that shape)', () => {
    expect(ROUTING_MANIFEST_V2.version).toBe(2)
    // v2 is no longer CURRENT (v3 is) - but an in-flight v2 row must keep the v2 fan-out FOREVER, so
    // every expectation here names the manifest explicitly instead of riding the default.
    for (const t of ['approval.approved', 'approval.rejected', 'approval.revoked', 'approval.cancelled']) {
      expect(expandConsumerKeysForEvent(t, ROUTING_MANIFEST_V2)).toEqual([
        'approval-bridge',
        'approval-trigger',
        'approval-projection',
        'multitable-record-approval',
      ])
    }
    // every OTHER family is byte-identical to v1 - the delta is the completion fan-out and nothing else
    expect(expandConsumerKeysForEvent('approval.task_created', ROUTING_MANIFEST_V2)).toEqual(['approval-task-trigger'])
    for (const t of ['multitable.record.created', 'multitable.record.updated', 'multitable.record.deleted']) {
      expect(expandConsumerKeysForEvent(t, ROUTING_MANIFEST_V2)).toEqual(['automation-record-trigger', 'webhook-event-bridge'])
    }
    expect(expandConsumerKeysForEvent('multitable.form.submitted', ROUTING_MANIFEST_V2)).toEqual(['automation-record-trigger'])
    // EXACT event-family set: v2 adds NO new family (a new route would red here even if it reused a key)
    expect(Object.keys(ROUTING_MANIFEST_V2.routes).sort()).toEqual(Object.keys(ROUTING_MANIFEST_V1.routes).sort())
    expect([...manifestConsumerKeys(ROUTING_MANIFEST_V2)].sort()).toEqual([...FULL_V2_KEYS].sort())
    // the v3 consumer NEVER leaked backwards into v2
    expect(manifestConsumerKeys(ROUTING_MANIFEST_V2)).not.toContain('dingtalk-todo-mirror')
  })

  test('v1 is UNCHANGED by v2 (an in-flight v1 row keeps its three-consumer fan-out forever)', () => {
    expect([...manifestConsumerKeys(ROUTING_MANIFEST_V1)].sort()).toEqual([...FULL_V1_KEYS].sort())
    expect(expandConsumerKeysForEvent('approval.approved', ROUTING_MANIFEST_V1)).not.toContain('multitable-record-approval')
    // the shared v1 completion array was not mutated into the v2 shape
    expect([...APPROVAL_COMPLETION_CONSUMERS]).toEqual(['approval-bridge', 'approval-trigger', 'approval-projection'])
  })

  test('v2 is DEEP-frozen too, and BOTH versions are dispatchable by this build', () => {
    expect(Object.isFrozen(ROUTING_MANIFEST_V2)).toBe(true)
    expect(Object.isFrozen(ROUTING_MANIFEST_V2.routes)).toBe(true)
    for (const arr of Object.values(ROUTING_MANIFEST_V2.routes)) expect(Object.isFrozen(arr)).toBe(true)
    expect(Object.isFrozen(APPROVAL_COMPLETION_CONSUMERS_V2)).toBe(true)
    expect(() => (APPROVAL_COMPLETION_CONSUMERS_V2 as string[]).push('x')).toThrow(TypeError)
    expect([...SUPPORTED_MANIFEST_VERSIONS].sort()).toEqual([1, 2, 3])
  })

  test('SUPPORTED_MANIFEST_VERSIONS is ENFORCED, not prose: an undeclared manifest version fails the boot assertion', () => {
    // Review finding (2026-09-15): the header called this constant "the deploy gate's anchor" while the
    // dispatcher never compares manifest_version — the constant was read by nothing in src. It is now the
    // boot gate for the manifest THIS BUILD ships: stamping outbox rows with a version the fleet does not
    // declare must fail at startup, not at delivery time.
    const v4 = { version: 4, routes: ROUTING_MANIFEST_V3.routes }
    expect(() => assertManifestCompleteness(registryOf(...FULL_V3_KEYS), v4)).toThrow(
      /manifest v4 is not in SUPPORTED_MANIFEST_VERSIONS/,
    )
    // all three DECLARED versions still pass with their own complete registries
    expect(() => assertManifestCompleteness(registryOf(...FULL_V1_KEYS), ROUTING_MANIFEST_V1)).not.toThrow()
    expect(() => assertManifestCompleteness(registryOf(...FULL_V2_KEYS), ROUTING_MANIFEST_V2)).not.toThrow()
    expect(() => assertManifestCompleteness(registryOf(...FULL_V3_KEYS), ROUTING_MANIFEST_V3)).not.toThrow()
    // ...and the manifest this build actually ships is one of them
    expect(SUPPORTED_MANIFEST_VERSIONS.has(CURRENT_ROUTING_MANIFEST.version)).toBe(true)
  })

  test('completeness: the v2 universe REQUIRES an adapter for multitable-record-approval (a v1-only worker reds)', () => {
    // A worker that still registers only the six v1 adapters would park every v2 completion row for the
    // record-approval consumer - the boot assertion must refuse that, naming the key.
    expect(() => assertManifestCompleteness(registryOf(...FULL_V1_KEYS), ROUTING_MANIFEST_V2)).toThrow(
      /NO registered adapter.*multitable-record-approval/,
    )
  })
})

describe('P2 S3 - routing manifest v3 (DingTalk approval-todo one-way mirror, plan B)', () => {
  test('v3 is the CURRENT manifest and adds dingtalk-todo-mirror to the four completion families AND task_created', () => {
    expect(ROUTING_MANIFEST_V3.version).toBe(3)
    expect(CURRENT_ROUTING_MANIFEST).toBe(ROUTING_MANIFEST_V3)
    for (const t of ['approval.approved', 'approval.rejected', 'approval.revoked', 'approval.cancelled']) {
      expect(expandConsumerKeysForEvent(t)).toEqual([
        'approval-bridge',
        'approval-trigger',
        'approval-projection',
        'multitable-record-approval',
        'dingtalk-todo-mirror',
      ])
    }
    // task_created gains its SECOND consumer - the one route shape v1/v2 never had.
    expect(expandConsumerKeysForEvent('approval.task_created')).toEqual(['approval-task-trigger', 'dingtalk-todo-mirror'])
    // every record/form family is byte-identical to v1 - the delta is the approval fan-out, nothing else
    for (const t of ['multitable.record.created', 'multitable.record.updated', 'multitable.record.deleted']) {
      expect(expandConsumerKeysForEvent(t)).toEqual(['automation-record-trigger', 'webhook-event-bridge'])
    }
    expect(expandConsumerKeysForEvent('multitable.form.submitted')).toEqual(['automation-record-trigger'])
    // EXACT event-family set: v3 adds NO new family (a new route reds here even if it reused a key)
    expect(Object.keys(ROUTING_MANIFEST_V3.routes).sort()).toEqual(Object.keys(ROUTING_MANIFEST_V1.routes).sort())
    expect([...manifestConsumerKeys()].sort()).toEqual([...FULL_V3_KEYS].sort())
  })

  test('v1 and v2 are UNCHANGED by v3 (an in-flight row keeps the fan-out it was enqueued with)', () => {
    expect([...manifestConsumerKeys(ROUTING_MANIFEST_V1)].sort()).toEqual([...FULL_V1_KEYS].sort())
    expect([...manifestConsumerKeys(ROUTING_MANIFEST_V2)].sort()).toEqual([...FULL_V2_KEYS].sort())
    expect(expandConsumerKeysForEvent('approval.task_created', ROUTING_MANIFEST_V1)).toEqual(['approval-task-trigger'])
    expect(expandConsumerKeysForEvent('approval.task_created', ROUTING_MANIFEST_V2)).toEqual(['approval-task-trigger'])
    expect([...APPROVAL_COMPLETION_CONSUMERS]).toEqual(['approval-bridge', 'approval-trigger', 'approval-projection'])
    expect([...APPROVAL_COMPLETION_CONSUMERS_V2]).toEqual([
      'approval-bridge', 'approval-trigger', 'approval-projection', 'multitable-record-approval',
    ])
  })

  test('v3 is DEEP-frozen and its shared arrays cannot be mutated at runtime', () => {
    expect(Object.isFrozen(ROUTING_MANIFEST_V3)).toBe(true)
    expect(Object.isFrozen(ROUTING_MANIFEST_V3.routes)).toBe(true)
    for (const arr of Object.values(ROUTING_MANIFEST_V3.routes)) expect(Object.isFrozen(arr)).toBe(true)
    expect(Object.isFrozen(APPROVAL_COMPLETION_CONSUMERS_V3)).toBe(true)
    expect(Object.isFrozen(APPROVAL_TASK_CREATED_CONSUMERS_V3)).toBe(true)
    expect(() => (APPROVAL_COMPLETION_CONSUMERS_V3 as string[]).push('x')).toThrow(TypeError)
    expect(() => (APPROVAL_TASK_CREATED_CONSUMERS_V3 as string[]).push('x')).toThrow(TypeError)
  })

  test('completeness: the v3 universe REQUIRES an adapter for dingtalk-todo-mirror (a v2-only worker reds)', () => {
    // A worker that registers only the seven v2 adapters would park every v3 mirror row - the boot
    // assertion must refuse that, naming the key.
    expect(() => assertManifestCompleteness(registryOf(...FULL_V2_KEYS))).toThrow(
      /NO registered adapter.*dingtalk-todo-mirror/,
    )
  })
})
