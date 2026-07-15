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
 *   multitable.comment.created                     → webhook-event-bridge
 *   form.submitted                                 → automation-record-trigger
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
 * expansion must wait until all producers are N-aware. `SUPPORTED_MANIFEST_VERSIONS` is the deploy gate's
 * anchor: a dispatcher refuses rows stamped with a version it does not know.
 *
 * Pure data + assertions — no DB, no side effects, flag-independent (nothing reads it until S4 enqueues).
 */
import type { ConsumerAdapterRegistry } from './automation-durable-dispatch-loop'

export interface RoutingManifest {
  readonly version: number
  /** event_type → the FULL set of consumer_keys that must each get a durable delivery row. */
  readonly routes: Readonly<Record<string, readonly string[]>>
}

export const APPROVAL_COMPLETION_CONSUMERS = ['approval-bridge', 'approval-trigger', 'approval-projection'] as const

/** v1 — the lock's ratified full set (#4203 §283-291). Frozen: never mutate; new needs = new version. */
export const ROUTING_MANIFEST_V1: RoutingManifest = Object.freeze({
  version: 1,
  routes: Object.freeze({
    'approval.approved': APPROVAL_COMPLETION_CONSUMERS,
    'approval.rejected': APPROVAL_COMPLETION_CONSUMERS,
    'approval.revoked': APPROVAL_COMPLETION_CONSUMERS,
    'approval.cancelled': APPROVAL_COMPLETION_CONSUMERS,
    'approval.task_created': ['approval-task-trigger'] as const,
    'multitable.record.created': ['automation-record-trigger', 'webhook-event-bridge'] as const,
    'multitable.record.updated': ['automation-record-trigger', 'webhook-event-bridge'] as const,
    'multitable.record.deleted': ['automation-record-trigger', 'webhook-event-bridge'] as const,
    'multitable.comment.created': ['webhook-event-bridge'] as const,
    'form.submitted': ['automation-record-trigger'] as const,
  }),
})

export const CURRENT_ROUTING_MANIFEST: RoutingManifest = ROUTING_MANIFEST_V1

/** Versions this build can dispatch. A row stamped with an unknown version must be left alone (older/newer
 *  worker's job), mirroring the unknown-consumer_key rule. */
export const SUPPORTED_MANIFEST_VERSIONS: ReadonlySet<number> = new Set([1])

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
