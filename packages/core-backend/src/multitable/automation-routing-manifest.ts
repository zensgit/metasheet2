/**
 * P2 durable-delivery — slice S3: the versioned routing manifest + startup completeness assertion.
 *
 * The manifest maps each event family to the FULL set of consumer_keys that must receive a durable delivery
 * row. The producer (S4) expands an event into its `(outbox_id, consumer_key)` rows AT ENQUEUE, stamping
 * `manifest_version` — a row enqueued under v1 is dispatched per v1 forever and never re-interpreted against
 * a live manifest (#4203 §manifest). Content is the lock's ratified v1 full set (§283-291), grounded in the
 * actual subscription surfaces (`automation-service.ts:892-936`, `index.ts:2119` projection,
 * `webhook-event-bridge.ts:36-39`):
 *
 *   approval.{approved,rejected,revoked,cancelled} → approval-bridge, approval-trigger, approval-projection
 *   approval.task_created                          → approval-task-trigger
 *   multitable.record.{created,updated,deleted}    → automation-record-trigger, webhook-event-bridge
 *   multitable.form.submitted                      → automation-record-trigger
 *
 * REMOVED from v1 (owner closure item 2, 2026-07-17): `multitable.comment.created` → webhook-event-bridge.
 * NOTHING in the codebase emits that event type (repo-wide census; the comment feature writes rows but has
 * never emitted a bus event, so even the LEGACY webhook bridge's subscription to it has been inert since it
 * shipped). A manifest route nobody produces is dead configuration masquerading as coverage. Wiring a real
 * comment producer is a deliberate FEATURE enable (it would create webhook deliveries that have never fired
 * = a flag-OFF behavior change), so it ships as its own family-6 slice with a manifest v2 — not as a v1
 * literal. The legacy bridge's inert subscription is left untouched (removing it is that slice's business).
 *
 * NOTE on the form-submission literal: the lock's §283-291 prose names the family by its TRIGGER TYPE
 * (`form.submitted`), but the manifest keys on BUS EVENT TYPES — and the lock's own grounding citation
 * (`automation-service.ts:892-936`) subscribes to `multitable.form.submitted` (the trigger-type mapping
 * `multitable.form.submitted → form.submitted` lives in `automation-triggers.ts`). The v1 literal
 * originally transcribed the lock's shorthand (`form.submitted`) — an event type NOTHING ever emits, so
 * the durable path could never route a form submission (the producer's fail-closed expand would throw).
 * Corrected to the real bus event type; flagged for owner review in PR #4337 (ratified-set transcription
 * fix, not a routing change — same family, same consumer set).
 *
 * Completeness is asserted BIDIRECTIONALLY at startup with the adapter registry as the single enumeration
 * source (#4203 §293-300): (a) every consumer_key the manifest routes to has a registered adapter — a
 * manifest entry nobody serves would park rows forever; (b) every registered adapter is routed by the
 * manifest — an adapter no event reaches is dead configuration (and, worse, a sign the manifest lost an
 * entry). NOTE the lock's third direction — an ANONYMOUS bare `eventBus.subscribe(...)` closure carries no
 * consumer_key and cannot be enumerated from the bus side — is NOT enforceable here at runtime; it is closed
 * structurally in S5 by replacing those subscription sites with registered adapters (the cutover makes the
 * old bus non-load-bearing).
 *
 * Rolling deploy (#4203 §234-255): expanding an event family to a NEW consumer_key K is activation-gated —
 * (1) ship workers that know K (adapter registered), (2) only then ship producers whose manifest expands K.
 * The worker side is protected at runtime (unknown key → pending + alert, S2-a/S2-b); the PRODUCER side
 * CANNOT be (an N-1 producer simply never writes the K row — nothing exists to park or alert on), so K
 * expansion must wait until all producers are N-aware. `SUPPORTED_MANIFEST_VERSIONS` is this BUILD's
 * declaration of the manifest versions it understands; it is enforced at BOOT by
 * `assertManifestCompleteness` (shipping a CURRENT manifest whose version is not declared supported is a
 * startup error). It is NOT a dispatcher-side filter: `automation-durable-dispatcher` selects
 * `manifest_version` but does not compare it — a row's fan-out was already decided AT ENQUEUE, and the
 * runtime protection against a row this worker cannot serve is the unknown-consumer_key park + alert.
 *
 * Pure data + assertions — no DB, no side effects, flag-independent (nothing reads it until S4 enqueues).
 */
import type { ConsumerAdapterRegistry } from './automation-durable-dispatch-loop'

export interface RoutingManifest {
  readonly version: number
  /** event_type → the FULL set of consumer_keys that must each get a durable delivery row. */
  readonly routes: Readonly<Record<string, readonly string[]>>
}

/**
 * DEEP-freeze a manifest so v1 routing is immutable at RUNTIME. `as const` / a bare outer `Object.freeze` are
 * NOT enough: the CONSUMER ARRAYS inside `routes` stay mutable, so `manifest.routes[e].pop()` (or a pop on the
 * shared APPROVAL_COMPLETION_CONSUMERS array) would silently rewrite v1's routing (#4335 review P2). Freeze
 * every route array, the routes record, and the object itself.
 */
function deepFreezeManifest(m: RoutingManifest): RoutingManifest {
  for (const keys of Object.values(m.routes)) {
    Object.freeze(keys)
  }
  Object.freeze(m.routes)
  return Object.freeze(m)
}

/** Shared across the four approval-completion routes — frozen so no route can mutate it out from under the others. */
export const APPROVAL_COMPLETION_CONSUMERS: readonly string[] = Object.freeze(['approval-bridge', 'approval-trigger', 'approval-projection'])

/** v1 — the lock's ratified full set (#4203 §283-291). Deep-frozen: never mutate at runtime; new needs = new version. */
export const ROUTING_MANIFEST_V1: RoutingManifest = deepFreezeManifest({
  version: 1,
  routes: {
    'approval.approved': APPROVAL_COMPLETION_CONSUMERS,
    'approval.rejected': APPROVAL_COMPLETION_CONSUMERS,
    'approval.revoked': APPROVAL_COMPLETION_CONSUMERS,
    'approval.cancelled': APPROVAL_COMPLETION_CONSUMERS,
    'approval.task_created': ['approval-task-trigger'],
    'multitable.record.created': ['automation-record-trigger', 'webhook-event-bridge'],
    'multitable.record.updated': ['automation-record-trigger', 'webhook-event-bridge'],
    'multitable.record.deleted': ['automation-record-trigger', 'webhook-event-bridge'],
    'multitable.form.submitted': ['automation-record-trigger'],
  },
})

/**
 * v2 — v1 PLUS the record-level submit-for-approval consumer (`multitable-record-approval`).
 *
 * WHY A NEW VERSION AND NOT AN EDIT OF v1: a row is dispatched per the manifest version STAMPED ON IT at
 * enqueue (#4203 §manifest). v1 is deep-frozen and stays byte-for-byte what it was, so every in-flight v1
 * row keeps fanning out to exactly the three consumers that existed when it was enqueued — the new
 * consumer never inherits a backlog it has no row for, and no v1 row parks waiting for an adapter that a
 * rolling-deploy N-1 worker does not have.
 *
 * DELTA vs v1: the four `approval.*` COMPLETION families gain `multitable-record-approval`. Every other
 * route (task_created, the record families, form.submitted) is the SAME array object as v1 — identical
 * routing, shared frozen arrays, no accidental divergence.
 *
 * ROLLING DEPLOY (#4203 §234-255): expanding a family to a new consumer_key is activation-gated — workers
 * that KNOW the key ship first (adapter registered = this commit's `DURABLE_CONSUMER_KEYS` +
 * `buildDurableConsumerHandlers` entry), and only then may producers stamp v2. Both halves land in THIS
 * commit, which is the supported shape for a single-artifact deployment. Be precise about what that buys
 * during a MULTI-REPLICA rolling deploy: every replica shares one `meta_automation_outbox_consumer` table,
 * so an N-1 worker DOES see rows an N replica's producer enqueued — it just cannot claim them. The
 * guarantee is the unknown-consumer_key rule (`automation-durable-dispatch-loop`: unknown keys are alerted
 * and left `pending`, never claimed and never terminated), so a `multitable-record-approval` row waits for
 * an N worker instead of being lost. The reverse direction is what the frozen v1 protects: an in-flight v1
 * row keeps its v1 fan-out and never acquires the new consumer.
 */
export const APPROVAL_COMPLETION_CONSUMERS_V2: readonly string[] = Object.freeze([
  ...APPROVAL_COMPLETION_CONSUMERS,
  'multitable-record-approval',
])

export const ROUTING_MANIFEST_V2: RoutingManifest = deepFreezeManifest({
  version: 2,
  routes: {
    'approval.approved': APPROVAL_COMPLETION_CONSUMERS_V2,
    'approval.rejected': APPROVAL_COMPLETION_CONSUMERS_V2,
    'approval.revoked': APPROVAL_COMPLETION_CONSUMERS_V2,
    'approval.cancelled': APPROVAL_COMPLETION_CONSUMERS_V2,
    'approval.task_created': ROUTING_MANIFEST_V1.routes['approval.task_created'],
    'multitable.record.created': ROUTING_MANIFEST_V1.routes['multitable.record.created'],
    'multitable.record.updated': ROUTING_MANIFEST_V1.routes['multitable.record.updated'],
    'multitable.record.deleted': ROUTING_MANIFEST_V1.routes['multitable.record.deleted'],
    'multitable.form.submitted': ROUTING_MANIFEST_V1.routes['multitable.form.submitted'],
  },
})

/**
 * v3 — v2 PLUS the DingTalk approval-todo ONE-WAY mirror consumer (`dingtalk-todo-mirror`).
 *
 * WHY A NEW VERSION AND NOT AN EDIT OF v1/v2: same rule as the v1→v2 step. A row is dispatched per the
 * manifest version STAMPED ON IT at enqueue (#4203 §manifest), so v1 and v2 stay byte-for-byte what
 * they were and every in-flight row keeps the fan-out it was enqueued with. The mirror consumer never
 * inherits a backlog of rows it has no consumer row for, and no v1/v2 row parks waiting for it.
 *
 * DELTA vs v2 — the mirror is the FIRST consumer to need BOTH halves of the approval life cycle:
 *   - the four COMPLETION families gain `dingtalk-todo-mirror` (mark the mirrored todo done);
 *   - `approval.task_created` gains it too (create the mirrored todo). That is a SECOND consumer on a
 *     family that has had exactly one since v1, which is precisely why this needs its own version.
 * Every other route is the SAME frozen array object as v1/v2 — identical routing, no drift.
 *
 * ROLLING DEPLOY (#4203 §234-255): expanding a family to a new consumer_key is activation-gated — the
 * worker that KNOWS the key ships first (`DURABLE_CONSUMER_KEYS` + `buildDurableConsumerHandlers`
 * entry), and only then may a producer stamp v3. Both halves land in THIS commit, the supported shape
 * for a single-artifact on-prem deployment. In a multi-replica rolling deploy an N-1 worker sees the
 * v3 `dingtalk-todo-mirror` rows an N producer enqueued but cannot claim them: the unknown-consumer_key
 * rule leaves them `pending` with an alert until an N worker drains them — never lost, never poisoned.
 *
 * NOTE the routing is INDEPENDENT of the DINGTALK_TODO_MIRROR_ENABLED feature flag, and must be: the
 * rows have to be enqueued and ACKed either way. With the flag OFF the consumer ACKs without writing
 * anything (`dingtalk-todo-mirror-service.ts`), so a flag-OFF deployment costs one no-op consumer row
 * per approval event and nothing else. Making the ROUTE flag-conditional would make the manifest a
 * function of runtime env — two replicas could then disagree about a row's fan-out.
 */
export const APPROVAL_COMPLETION_CONSUMERS_V3: readonly string[] = Object.freeze([
  ...APPROVAL_COMPLETION_CONSUMERS_V2,
  'dingtalk-todo-mirror',
])

/** task_created's v3 set: the v1 automation trigger PLUS the todo mirror. */
export const APPROVAL_TASK_CREATED_CONSUMERS_V3: readonly string[] = Object.freeze([
  ...ROUTING_MANIFEST_V1.routes['approval.task_created'],
  'dingtalk-todo-mirror',
])

export const ROUTING_MANIFEST_V3: RoutingManifest = deepFreezeManifest({
  version: 3,
  routes: {
    'approval.approved': APPROVAL_COMPLETION_CONSUMERS_V3,
    'approval.rejected': APPROVAL_COMPLETION_CONSUMERS_V3,
    'approval.revoked': APPROVAL_COMPLETION_CONSUMERS_V3,
    'approval.cancelled': APPROVAL_COMPLETION_CONSUMERS_V3,
    'approval.task_created': APPROVAL_TASK_CREATED_CONSUMERS_V3,
    'multitable.record.created': ROUTING_MANIFEST_V1.routes['multitable.record.created'],
    'multitable.record.updated': ROUTING_MANIFEST_V1.routes['multitable.record.updated'],
    'multitable.record.deleted': ROUTING_MANIFEST_V1.routes['multitable.record.deleted'],
    'multitable.form.submitted': ROUTING_MANIFEST_V1.routes['multitable.form.submitted'],
  },
})

export const CURRENT_ROUTING_MANIFEST: RoutingManifest = ROUTING_MANIFEST_V3

/** Versions this build can dispatch. A row stamped with an unknown version must be left alone (older/newer
 *  worker's job), mirroring the unknown-consumer_key rule. v1 stays supported for in-flight rows enqueued
 *  before this deploy — they keep their v1 fan-out forever. */
export const SUPPORTED_MANIFEST_VERSIONS: ReadonlySet<number> = new Set([1, 2, 3])

/**
 * Expand an event type to its consumer_keys under the given manifest. Returns undefined for an event type
 * the manifest does not route — the PRODUCER (S4) treats that as a hard error (it must know its families;
 * silently enqueueing zero rows would be a silent miss).
 */
export function expandConsumerKeysForEvent(
  eventType: string,
  manifest: RoutingManifest = CURRENT_ROUTING_MANIFEST,
): readonly string[] | undefined {
  return manifest.routes[eventType]
}

/** Every distinct consumer_key the manifest routes to. */
export function manifestConsumerKeys(manifest: RoutingManifest = CURRENT_ROUTING_MANIFEST): string[] {
  return [...new Set(Object.values(manifest.routes).flat())]
}

/**
 * Startup completeness assertion — BIDIRECTIONAL, registry as the single enumeration source (#4203 §296).
 * Throws with the exact missing keys; callers run this once at boot BEFORE starting the dispatch loop.
 */
export function assertManifestCompleteness(
  registry: Pick<ConsumerAdapterRegistry, 'keys'>,
  manifest: RoutingManifest = CURRENT_ROUTING_MANIFEST,
): void {
  // The version declaration is load-bearing, not prose: shipping a manifest this build does not declare
  // support for would stamp outbox rows with a version no worker in the fleet admits to serving. Boot
  // fails instead (the same fail-closed posture as the bidirectional key assertion below).
  if (!SUPPORTED_MANIFEST_VERSIONS.has(manifest.version)) {
    throw new Error(
      `routing manifest v${manifest.version} is not in SUPPORTED_MANIFEST_VERSIONS (${[...SUPPORTED_MANIFEST_VERSIONS].join(', ')}) — bump the supported set with the manifest`,
    )
  }
  const registered = new Set(registry.keys())
  const routed = new Set(manifestConsumerKeys(manifest))
  const unserved = [...routed].filter((k) => !registered.has(k))
  const unrouted = [...registered].filter((k) => !routed.has(k))
  if (unserved.length > 0 || unrouted.length > 0) {
    const parts: string[] = []
    if (unserved.length > 0) {
      parts.push(`manifest routes to consumer_key(s) with NO registered adapter (rows would park forever): ${unserved.join(', ')}`)
    }
    if (unrouted.length > 0) {
      parts.push(`registered adapter(s) NOT routed by the manifest (dead configuration / lost manifest entry): ${unrouted.join(', ')}`)
    }
    throw new Error(`routing manifest v${manifest.version} completeness violated — ${parts.join(' ; ')}`)
  }
}
