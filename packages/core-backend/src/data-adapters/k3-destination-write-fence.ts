// K3 DESTINATION WRITE FENCE — host-side companion to the plugin's permanent kind fence.
//
// AUTHORITY. G-4 / E4 (HG v1.2 §10): "K3 Save/Submit/Audit external write-back permanently banned."
// The plugin's `k3-external-write-permanent-fence.cjs` enforces this BY CONNECTOR KIND — it refuses
// `erp:k3-wise-webapi` and `erp:k3-wise-sqlserver`. But a ban that keys only on kind is bypassable
// by DESTINATION laundering: a `data-source:sql-write-gated` external system whose
// `config.dataSourceId` points at a `type:'sqlserver'` `data_sources` row aimed at the customer's
// K3 database is a K3-shaped external WRITE that wears the GENERIC C6 kind. It travels
//     C6 apply -> data-source write facade -> DataSourceManager.insert/update/delete -> MSSQLAdapter
// and neither by-kind fence ever inspects it. "K3 external write permanently banned" therefore has
// to mean banned BY DESTINATION, not merely by adapter kind — or the ban is trivially defeated by
// wrapping K3 in a sql-write-gated source.
//
// THIS MODULE is that destination assertion, placed at the true chokepoint every generic external
// write funnels through (DataSourceManager's write methods). It is self-contained ON PURPOSE: the
// host must not import the plugin (the dependency runs the wrong way), and — exactly as the plugin
// fence argues for itself — a fence that resolves its own subject through another module can be
// defeated by changing that module. So the closed token is spelled here as a literal; a test binds
// it by VALUE to the plugin fence's token so the two provably agree.
//
// TWO INDEPENDENT CHECKS, because a single one has a hole the other closes:
//
//   A. THE EXPLICIT DESTINATION MARKER (deterministic). A `data_sources` row may carry
//      `options.k3Destination === true` — a durable, positive attestation, set at registration
//      (by the K3 provisioning template / an operator following the runbook / an admin), that this
//      source's destination IS the customer K3. When present, every write is refused, unconditionally
//      and non-overridably. This is the honest-registration path and it is exact.
//
//      Its limit, stated plainly: a marker is only as truthful as whoever set it. An owner who
//      deliberately points a generic sqlserver source at K3 and simply OMITS the marker is not caught
//      by (A) alone. That is the hole (B) closes.
//
//   B. THE K3 BUSINESS-TABLE SIGNATURE (structural, catches disguise). Independently of the marker,
//      a write whose TARGET TABLE matches the K3 WISE business-table signature (the `t_IC*` / `t_BD*`
//      catalog — the same tables the plugin's `k3-wise-sqlserver-channel` enumerates) is refused.
//      This is NOT the host/IP heuristic the owner rejected for the HTTP adapter (a matcher a proxy
//      hop or an IP literal defeats): the table name is part of the write CALL, not the connection —
//      an attacker who wants to write K3's item master must NAME `t_ICItem`, and cannot disguise that
//      away while still hitting K3's data. The legitimate C6 middle-table lane writes to staging
//      tables (`integration_material_stage`-style), which do not match the signature, so (B) does not
//      touch it.
//
// RESIDUAL, recorded honestly: (A)+(B) do not stop an owner who BOTH leaves the source unmarked AND
// writes only through a customer-created VIEW or SYNONYM that renames a K3 table off the signature.
// That requires the owner to have already installed an aliasing object inside the customer database —
// i.e. they already hold direct K3 write access out of band, at which point the plugin's fence is not
// the operative control. No purely-structural check inside this process can distinguish, at the byte
// level, a write to a K3 table reached through a same-database alias from a write to a legitimate
// staging table; that discrimination needs a physical-destination oracle the deployment does not
// have. This is the minimal reliable marker in this pass, and the boundary is drawn where it is
// because that is where reliability actually ends.
//
// READS ARE UNTOUCHED. This fence gates only the WRITE surface (insert / update / delete / copyData
// target, plus a marker-only guard on raw `query`). `select` is never gated: reading a K3 source is
// legitimate, and a blanket deny that killed reads would be a FAIL, not a pass (§15.2 E4-05).

import type { AdapterOptions, DataSourceConfig } from './BaseAdapter'

// The single closed refusal token. A LITERAL, identical to the plugin fence's
// `K3_WISE_EXTERNAL_WRITE_DISABLED`; a test pins the two together by value so a rename on either
// side reds rather than silently diverging.
export const K3_WISE_EXTERNAL_WRITE_DISABLED = 'K3_WISE_EXTERNAL_WRITE_DISABLED'

// Fixed, values-free operator-facing text. Two variants only so an operator learns WHICH check
// fired (a declared destination vs. a K3 table shape) — neither carries a customer value.
export const K3_DESTINATION_MARKER_REFUSAL_MESSAGE =
  'K3 external write-back is permanently disabled; this data source is marked as a K3 destination'
export const K3_DESTINATION_TABLE_REFUSAL_MESSAGE =
  'K3 external write-back is permanently disabled; the target table is a K3 business table'

// The K3 WISE business-table signature. FROZEN and pinned by value in the fence test: shrinking or
// mutating it at runtime would be an unlock, and deriving it from elsewhere would let that elsewhere
// defeat it. `exact` are the tables the plugin's sqlserver channel already treats as K3; `prefixes`
// are the two Kingdee K3 WISE physical families a write-back would land in — `t_IC*` (inventory /
// item master, incl. BOM) and `t_BD*` (base data). Kept deliberately CONSERVATIVE: staging / middle
// tables never carry these, so the legitimate C6 lane is unaffected.
export const K3_WISE_BUSINESS_TABLE_SIGNATURE = Object.freeze({
  exact: Object.freeze(['t_icitem', 't_icbom', 't_icbomchild', 't_icitembase']),
  prefixes: Object.freeze(['t_ic', 't_bd']),
})

export class K3DestinationWriteError extends Error {
  public readonly code = K3_WISE_EXTERNAL_WRITE_DISABLED
  public readonly status = 403

  constructor(message: string) {
    super(message)
    this.name = 'K3DestinationWriteError'
  }
}

// (A) The explicit marker. `=== true` on purpose: no truthy coercion, so only a deliberate boolean
// attestation counts, and no other value can accidentally arm — or, being non-true, disarm — it.
export function isK3MarkedDestination(options: AdapterOptions | undefined): boolean {
  return options?.k3Destination === true
}

// Normalise a target table to the form the signature matches: strip a `[bracketed]` quote, strip a
// leading `schema.` qualifier, trim, lowercase. `dbo.[t_ICItem]`, `[t_ICItem]`, `t_ICItem` and
// `AIS.dbo.t_ICItem` all reduce to `t_icitem`.
export function normalizeDestinationTable(table: string): string {
  let name = String(table ?? '').trim()
  // Take the last dotted segment (the table), tolerating bracket-quoted segments that contain dots.
  const segments = name.match(/\[[^\]]*\]|[^.]+/g)
  if (segments && segments.length > 0) {
    name = segments[segments.length - 1]
  }
  name = name.replace(/^\[/, '').replace(/\]$/, '').trim().toLowerCase()
  return name
}

// (B) The signature test.
export function isK3BusinessTable(table: string): boolean {
  const name = normalizeDestinationTable(table)
  if (name.length === 0) return false
  if (K3_WISE_BUSINESS_TABLE_SIGNATURE.exact.includes(name)) return true
  return K3_WISE_BUSINESS_TABLE_SIGNATURE.prefixes.some((prefix) => name.startsWith(prefix))
}

// The destination assertion for a table-bearing write (insert / update / delete / copyData target).
// Both checks are unconditional refusals; neither reads env, policy, or any enabling flag. Order is
// marker-then-signature only so the message is the more specific one when both would fire.
export function assertNotK3Destination(
  config: Pick<DataSourceConfig, 'options'>,
  table: string,
): void {
  if (isK3MarkedDestination(config.options)) {
    throw new K3DestinationWriteError(K3_DESTINATION_MARKER_REFUSAL_MESSAGE)
  }
  if (isK3BusinessTable(table)) {
    throw new K3DestinationWriteError(K3_DESTINATION_TABLE_REFUSAL_MESSAGE)
  }
}

// The marker-only assertion for raw `query`, which carries no table argument. A source DECLARED to
// be K3 must not accept a raw statement at all — a raw statement is write-capable, and the ban is on
// the write. (A generic unmarked source's raw query is a separate, already-gated surface.)
export function assertNotK3MarkedDestination(config: Pick<DataSourceConfig, 'options'>): void {
  if (isK3MarkedDestination(config.options)) {
    throw new K3DestinationWriteError(K3_DESTINATION_MARKER_REFUSAL_MESSAGE)
  }
}
