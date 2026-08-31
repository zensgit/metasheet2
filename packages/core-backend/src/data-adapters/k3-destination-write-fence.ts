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

// Fixed, values-free operator-facing text. Three variants so an operator learns WHICH check fired
// (a declared destination / a K3 table shape / a raw statement that writes a K3 table) — none carries
// a customer value.
export const K3_DESTINATION_MARKER_REFUSAL_MESSAGE =
  'K3 external write-back is permanently disabled; this data source is marked as a K3 destination'
export const K3_DESTINATION_TABLE_REFUSAL_MESSAGE =
  'K3 external write-back is permanently disabled; the target table is a K3 business table'
export const K3_DESTINATION_SQL_REFUSAL_MESSAGE =
  'K3 external write-back is permanently disabled; the statement writes to a K3 business table'

// The K3 WISE write-target signature. FROZEN and pinned BY VALUE in the fence test: shrinking or
// mutating it at runtime would be an unlock, and deriving it from elsewhere would let that elsewhere
// defeat it.
//
// SCOPE — the PHYSICAL TABLE plane. This fence guards a SQL write into a `data_sources` destination.
// The legacy ErpController K3 write surface is expressed as WebAPI FormIds (`Material/Save`,
// `BOM/Save`, `Bill1002535/Save` 工程变更单, `Bill1002502/Save` 生产投料变更单, `PD/Save` 生产任务单) —
// those are fenced on the ENDPOINT plane by the plugin's by-kind permanent fence, a different
// transport. Here we must recognise the PHYSICAL tables a direct-SQL write would name, including the
// tables those FormIds ultimately land in.
//
// `exact` — physical tables this repo's own docs name as K3 write-forbidden "core tables"
// (`integration-core-k3wise-adapters-design-20260424.md`, `integration-k3wise-sql-executor-bridge-handoff.md`),
// PLUS the physical tables behind the legacy write FormIds (production order `ICMO` from `PD/Save`,
// inventory bills `ICStockBill`, purchase/sales orders, and the ECN bill numbers). `prefixes` — the
// two Kingdee K3 WISE physical families every item/BOM/base-data write lands in: `t_IC*` and `t_BD*`.
//
// CAVEAT, load-bearing and honest: physical K3 table names are DEPLOYMENT-VARIABLE — a customer may
// front K3 through readonly views / synonyms with arbitrary names
// (`data-factory-legacy-sql-readonly-bridge-agent-plan-20260520.md`: "customer readonly view",
// `v_MetaSheet_MaterialRead`). A physical-name signature therefore cannot be COMPLETE. That is why
// the explicit marker (A) is the PRIMARY, reliable control and this signature (B) is a BACKSTOP that
// must at minimum cover the tables the legacy system actually wrote — which it now does. The
// residual (an unmarked source writing through a renamed alias) is documented at the top of this
// module and is out of reach of any in-process check without a physical-destination oracle.
export const K3_WISE_BUSINESS_TABLE_SIGNATURE = Object.freeze({
  exact: Object.freeze([
    // item / inventory / BOM — enumerated as K3 read objects in the sqlserver channel, write-forbidden
    't_icitem', 't_icbom', 't_icbomchild', 't_icitembase',
    // base-data "K3 core tables" the bridge handoff names explicitly — NO t_ic/t_bd prefix, so they
    // were a real gap before this widening
    't_measureunit', 't_organization',
    // production order (PD/Save -> ICMO) + its entry/detail
    'icmo', 'icmoentry',
    // inventory bills (ICStockBill family)
    'icstockbill', 'icstockbillentry',
    // purchase / sales orders
    'poorder', 'poorderentry', 'seorder', 'seorderentry',
    // ECN / material-change bills — primarily WebAPI FormIds; matched here too in case a deployment
    // exposes them as physical bill tables of the same name
    'bill1002535', 'bill1002502',
  ]),
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
  // Take the last dotted segment (the table), tolerating bracket/quote-wrapped segments with dots.
  const segments = name.match(/\[[^\]]*\]|"[^"]*"|[^.]+/g)
  if (segments && segments.length > 0) {
    name = segments[segments.length - 1]
  }
  name = name.trim().replace(/^[["]/, '').replace(/[\]"]$/, '').trim().toLowerCase()
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

// ── Raw-SQL write classification (P0 — SWITCH-THE-VERB bypass) ────────────────────────────────
// A destination check that inspects only a structured `table` argument is defeated by switching the
// verb: `query("INSERT INTO t_ICItem …")` names the K3 table by hand and reaches the driver
// untouched, because the structured `insert/update/delete` are fenced but the raw SQL path was not.
// So the RAW SQL is classified: its WRITE-TARGET identifiers are extracted (never FROM/JOIN read
// sources) and matched against the K3 signature, and a write of any shape to a marked K3 destination
// is refused. READS (a SELECT with no INTO) produce no write-target and are never fenced.
//
// This is a conservative static classifier, not a full T-SQL parser. It errs toward REFUSAL on a
// marked destination (fail-safe) and toward PRECISION on the signature match (only real write-target
// positions are captured), so it cannot silently allow a K3 write while it may over-refuse an exotic
// statement on an already-K3-marked source. Two residuals are out of a static classifier's reach and
// are covered by the marker instead: dynamic SQL assembled and run as `EXEC(@sql)`, and a write
// routed through a customer-created view/synonym that renames a K3 table off the signature.

const SQL_STRING_LITERAL = /'(?:[^']|'')*'/g
const SQL_BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g
const SQL_LINE_COMMENT = /--[^\n\r]*/g

// A possibly schema-qualified identifier (up to three dotted parts); each part bare / [bracketed] /
// "quoted", with whitespace tolerated around the dots.
const SQL_ID = String.raw`(?:\[[^\]]+\]|"[^"]+"|[A-Za-z_@#][\w$#]*)(?:\s*\.\s*(?:\[[^\]]+\]|"[^"]+"|[A-Za-z_@#][\w$#]*)){0,2}`

// Each pattern captures the WRITE-TARGET identifier — the table/proc being mutated, never a read
// source. `INTO (id)` also covers `SELECT … INTO newtable`, which creates and populates a table.
const SQL_WRITE_TARGET_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\bINSERT\s+(?:INTO\s+)?(${SQL_ID})`, 'gi'),
  new RegExp(String.raw`\bUPDATE\s+(${SQL_ID})`, 'gi'),
  new RegExp(String.raw`\bDELETE\s+(?:FROM\s+)?(${SQL_ID})`, 'gi'),
  new RegExp(String.raw`\bMERGE\s+(?:INTO\s+)?(${SQL_ID})`, 'gi'),
  new RegExp(String.raw`\b(?:EXEC|EXECUTE)\s+(${SQL_ID})`, 'gi'),
  new RegExp(String.raw`\bTRUNCATE\s+TABLE\s+(${SQL_ID})`, 'gi'),
  new RegExp(String.raw`\bBULK\s+INSERT\s+(${SQL_ID})`, 'gi'),
  new RegExp(String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(${SQL_ID})`, 'gi'),
  new RegExp(String.raw`\bALTER\s+TABLE\s+(${SQL_ID})`, 'gi'),
  new RegExp(String.raw`\bINTO\s+(${SQL_ID})`, 'gi'),
]

// Any statement head that mutates — used to decide isWrite for the MARKER case, independent of
// whether a concrete target was captured (e.g. `EXEC(@sql)` dynamic SQL, or `GRANT`).
const SQL_WRITE_VERB = /\b(INSERT|UPDATE|DELETE|MERGE|EXEC|EXECUTE|TRUNCATE|DROP|ALTER|CREATE|BULK\s+INSERT|GRANT|REVOKE|DENY)\b/i
const SQL_SELECT_INTO = /\bSELECT\b[\s\S]*?\bINTO\b/i

// Keywords a write-target regex can capture as a spurious identifier (e.g. `MERGE … WHEN MATCHED
// THEN UPDATE SET a=1` makes the `UPDATE <id>` pattern grab `SET`). Dropped from the target set so
// a bare keyword is never treated as a K3 table. Harmless even if one slipped through — no keyword
// is a K3 table — but kept precise so the classifier's output is exactly the real write targets.
const SQL_NON_TABLE_KEYWORDS = new Set([
  'set', 'from', 'where', 'values', 'select', 'table', 'as', 'on', 'output', 'with', 'when',
  'then', 'matched', 'using', 'default', 'top', 'into',
])

function stripSqlNoise(sql: string): string {
  return String(sql ?? '')
    .replace(SQL_BLOCK_COMMENT, ' ')
    .replace(SQL_LINE_COMMENT, ' ')
    .replace(SQL_STRING_LITERAL, " '' ")
}

// Classify a raw statement: whether it mutates at all, and every write-target identifier it names
// (normalised to the signature's form).
export function classifySqlWrite(sql: string): { isWrite: boolean; targets: string[] } {
  const cleaned = stripSqlNoise(sql)
  const isWrite = SQL_WRITE_VERB.test(cleaned) || SQL_SELECT_INTO.test(cleaned)
  const targets = new Set<string>()
  for (const pattern of SQL_WRITE_TARGET_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(cleaned)) !== null) {
      const normalized = normalizeDestinationTable(match[1])
      if (normalized && !SQL_NON_TABLE_KEYWORDS.has(normalized)) targets.add(normalized)
    }
  }
  return { isWrite, targets: [...targets] }
}

// True when a raw statement writes to a K3 business table, whatever the verb.
export function sqlTargetsK3BusinessTable(sql: string): boolean {
  return classifySqlWrite(sql).targets.some((target) => isK3BusinessTable(target))
}

// The destination assertion for a RAW SQL statement (query / federatedQuery / the adapter's own
// query funnel). Refuses (a) any write against a marked K3 destination, and (b) any write whose
// target is a K3 business table on ANY destination — marked or not. A read is never a write and is
// always allowed, so this never fences a SELECT.
export function assertNotK3SqlWrite(config: Pick<DataSourceConfig, 'options'>, sql: string): void {
  const { isWrite, targets } = classifySqlWrite(sql)
  if (isWrite && isK3MarkedDestination(config.options)) {
    throw new K3DestinationWriteError(K3_DESTINATION_MARKER_REFUSAL_MESSAGE)
  }
  if (targets.some((target) => isK3BusinessTable(target))) {
    throw new K3DestinationWriteError(K3_DESTINATION_SQL_REFUSAL_MESSAGE)
  }
}
