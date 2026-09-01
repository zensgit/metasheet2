// K3 DESTINATION MARKER — a DECLARED-identity marker and its set-once durability.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE IS NOW, AND WHAT IT DELIBERATELY IS NOT
// ─────────────────────────────────────────────────────────────────────────────
//
// This module USED to be a destination sniffer: it parsed SQL for K3 table names, matched a K3
// business-table signature, and probed the catalog to guess whether a connection "reached K3". Four
// rounds of adversarial verification defeated that with ordinary single-connection T-SQL — an aliased
// `UPDATE … FROM t_ICItem`, an `UPDATE TOP (5) t_ICItem`, a 4-part `INSERT INTO srv.AIS.dbo.t_ICItem`,
// a `WITH c AS (…) DELETE …`, and an unterminated `SELECT 1 / DELETE …` batch.
//
// That was not a run of bugs. Sniffing the destination is EXACTLY the option the owner REJECTED on
// 2026-08-29 (W-1): judging "whether the target is a K3 endpoint" is "brittle, defeatable by a proxy
// hop / IP literal — worse than none". The ruling was (c): gate the CAPABILITY. The generic HTTP write
// lane was closed that way in `outbound-http-write-gate.cjs`; the SQL lane is now closed the same way
// in `outbound-sql-write-gate.ts`, which is the LOAD-BEARING control for SQL writes.
//
// So the destination machinery is RETIRED: no SQL parsing, no K3 business-table signature, no catalog
// probe, no connection "read-only" inference. None of it is a claimed guarantee anywhere, because
// none of it survived being one.
//
// WHAT REMAINS, and only because it is cheap and honest:
//   * the DECLARED marker `options.k3Destination === true` — an operator's positive attestation that a
//     data source points at the customer K3; and
//   * its SET-ONCE durability: once true it cannot be cleared by any later config edit.
// A marked source refuses structured writes as defense in depth. This is NOT the guarantee. The
// PROVABLE guarantee lives one layer down, at the DATABASE ACCOUNT: the owner's boundary ruling
// (option A, 2026-08-29) placed it there — a K3-reaching login granted no INSERT/UPDATE/DELETE
// refuses the write AT THE SERVER, whatever any in-process code decided, and that is the only layer
// that holds against an in-process defect, a missed call path, or an operator editing config. Beneath
// it, in descending order of strength: generic SQL write is default-deny (`outbound-sql-write-gate.ts`,
// the load-bearing in-process control), armed sources are pinned to the connection they were armed on
// (`sql-write-arm-binding.ts`), and finally this marker. Operator discipline — "no K3-reaching source
// is ever armed" — is a PROCEDURE, not a proof, and is named here as such rather than counted as the
// guarantee. The marker is a declaration, and a declaration is only as truthful as the operator who
// wrote it.
//
// The by-kind K3 fences (`erp:k3-wise-webapi` permanent four-layer, and the `erp:k3-wise-sqlserver`
// sibling) are untouched and remain their own control.

import type { AdapterOptions, DataSourceConfig } from './BaseAdapter'

// The single closed refusal token, identical to the plugin fence's `K3_WISE_EXTERNAL_WRITE_DISABLED`.
// A test pins the two together by value so a rename on either side reds rather than diverging.
export const K3_WISE_EXTERNAL_WRITE_DISABLED = 'K3_WISE_EXTERNAL_WRITE_DISABLED'

export const K3_DESTINATION_MARKER_REFUSAL_MESSAGE =
  'K3 external write-back is permanently disabled; this data source is marked as a K3 destination'

// The set-once marker's immutability contract, surfaced to the config-edit route.
export const K3_DESTINATION_MARKER_IMMUTABLE = 'K3_DESTINATION_MARKER_IMMUTABLE'
export const K3_DESTINATION_MARKER_IMMUTABLE_MESSAGE =
  'the k3Destination marker is set-once and cannot be cleared or unset'

export class K3DestinationWriteError extends Error {
  public readonly code = K3_WISE_EXTERNAL_WRITE_DISABLED
  public readonly status = 403

  constructor(message: string) {
    super(message)
    this.name = 'K3DestinationWriteError'
  }
}

// `=== true` on purpose: no truthy coercion, so only a deliberate boolean attestation counts, and no
// other value can accidentally arm — or, being non-true, disarm — it.
export function isK3MarkedDestination(options: AdapterOptions | undefined): boolean {
  return options?.k3Destination === true
}

/**
 * Defense in depth for the STRUCTURED write methods: a source DECLARED to be a K3 destination refuses
 * them. Deliberately marker-only — there is no table inspection here any more, because a table-name
 * check is the thing that was defeated four times and is not a control.
 */
export function assertNotK3Destination(config: Pick<DataSourceConfig, 'options'>): void {
  if (isK3MarkedDestination(config.options)) {
    throw new K3DestinationWriteError(K3_DESTINATION_MARKER_REFUSAL_MESSAGE)
  }
}

// ── SET-ONCE DURABILITY ──────────────────────────────────────────────────────
// Once `k3Destination` is true it is set-once: no later config edit may clear or unset it. The route
// returns a coded refusal for a client edit that tries; the manager additionally FORCES it true on
// every update so no path can drop it silently.

export function attemptsToClearK3Marker(
  oldOptions: AdapterOptions | undefined,
  incomingOptions: AdapterOptions | undefined,
): boolean {
  if (oldOptions?.k3Destination !== true) return false
  if (!incomingOptions || typeof incomingOptions !== 'object') return false
  return 'k3Destination' in incomingOptions && incomingOptions.k3Destination !== true
}

export function preserveK3Marker(
  oldOptions: AdapterOptions | undefined,
  mergedOptions: AdapterOptions | undefined,
): AdapterOptions | undefined {
  if (oldOptions?.k3Destination !== true) return mergedOptions
  return { ...(mergedOptions ?? {}), k3Destination: true }
}
