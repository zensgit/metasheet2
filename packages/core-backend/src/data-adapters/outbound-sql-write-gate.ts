// W-1(c) DEFAULT-DENY AUTHORIZATION GATE for GENERIC OUTBOUND SQL WRITE.
//
// OWNER RULING (2026-08-29), applied to the second lane. Generic outbound SQL write is a capability
// that must be EXPLICITLY AUTHORIZED per deployment. `INTEGRATION_CORE_OUTBOUND_SQL_WRITE_TARGETS`
// UNSET => DENY. Reads, lists, schema fetches and health probes are byte-identical to a deployment
// that never heard of this module.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS AT ALL — FOUR ROUNDS OF EVIDENCE
// ─────────────────────────────────────────────────────────────────────────────
//
// The generic HTTP write lane was closed this way in `outbound-http-write-gate.cjs` (#5314). The SQL
// lane was, until now, governed instead by a DESTINATION SNIFFER: parse the statement for K3 table
// names, probe the catalog for K3 tables, refuse if it "looks like" K3. Four rounds of adversarial
// verification defeated that approach with ordinary single-connection T-SQL:
//
//   * `UPDATE t SET … FROM t_ICItem AS t` — the real target is in FROM; the extractor grabs the alias.
//   * `UPDATE TOP (5) t_ICItem`           — TOP sits between verb and table.
//   * `INSERT INTO srv.AIS.dbo.t_ICItem`  — a 4-part linked-server name the extractor never parsed.
//   * `WITH c AS (SELECT …) DELETE …`     — a data-modifying CTE that led with a "read" keyword.
//
// That is not a series of bugs; it is the shape of the problem. Sniffing the destination is EXACTLY
// the option the owner already REJECTED on 2026-08-29 (W-1: judging "whether the target is a K3
// endpoint" is "brittle, defeatable by a proxy hop / IP literal — worse than none"). The ruling was
// (c): gate the CAPABILITY. This module is that ruling applied to SQL.
//
// The consequence worth stating plainly, because it is the whole point: THERE IS NOTHING LEFT TO
// LAUNDER PAST. The gate never asks what table or what server a statement names. A write is a write,
// off by default. A 4-part linked-server INSERT, a CTE-wrapped DELETE, an aliased UPDATE…FROM and a
// plain `INSERT INTO staging` are all the same question — "is this source armed for SQL write?" —
// and the answer is no unless a deployment file says yes.
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS IS NOT G-4. READ THIS BEFORE CHANGING ANYTHING HERE.
// ─────────────────────────────────────────────────────────────────────────────
//
// `k3-external-write-permanent-fence.cjs` is a PERMANENT BAN (E4 / G-4, HG v1.2 §10.1): K3
// Save/Submit/Audit is unreachable, NO runtime switch is reserved, and re-enabling it requires a
// superseding ADR plus its own Gate. That module is deliberately PARAMETERLESS AND ENV-FREE, because
// any env read would be the re-enable surface §10.1 forbids.
//
// This module is the OPPOSITE KIND OF OBJECT and says so out loud: it is an AUTHORIZATION GATE, so it
// IS env-configurable BY DESIGN. Its posture is "closed until a deployment opens it for named
// sources", not "closed forever". Reading an env var here is the mechanism, not a leak in it.
//
// The two must not be confused in either direction:
//   * Nothing in this file can ever unlock K3. The K3 by-kind fences refuse `erp:k3-wise-webapi` and
//     `erp:k3-wise-sqlserver` at four layers each regardless of what any allowlist says. An operator
//     who writes a K3-shaped entry into this allowlist has authorized NOTHING about those kinds.
//   * Nothing in the K3 fences covers a GENERIC `sqlserver` data source. That is exactly the hole
//     this file closes: the fences key on connector KIND, and a generic SQL source whose connection
//     happens to point at (or link to) a K3 database was, before this file, an ungoverned write.
//
// ─────────────────────────────────────────────────────────────────────────────
// ARMING SEMANTICS — DENY IS THE DEFAULT
// ─────────────────────────────────────────────────────────────────────────────
//
//   ENV UNSET  ->  every generic SQL WRITE is REFUSED with the fixed code
//                  `OUTBOUND_SQL_WRITE_DISABLED`. Reads are untouched.
//
//   ENV SET    ->  the named server-side JSON file enumerates the sources that MAY be written, by
//                  DECLARED IDENTITY (data source id / name / type), never by host, server, database
//                  or connection string. A source the file does not name is refused with the DISTINCT
//                  code `OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED`, so an operator can tell "the gate
//                  is shut" from "the gate is open and your source is not on the list".
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE ENV IS READ HERE AND NOT THREADED IN
// ─────────────────────────────────────────────────────────────────────────────
//
// `new MSSQLAdapter(config)` takes no policy context. Threading an allowlist in as a constructor dep
// or a factory default would make the allowlist an ARGUMENT — and an argument is an unlock surface.
// ANY in-process caller (a script, a scheduler, a route that builds its own adapter, a test) could
// then hand itself an allowlist and write anywhere.
//
// So the gate reads `process.env` ITSELF, from a LEAF module with ZERO intra-package imports (only
// `node:fs`), and every public function is PARAMETERLESS with respect to configuration: the caller
// supplies the SUBJECT of the decision (which source, which operation) and never the POLICY.
//
// FILE-LOADING POSTURE, borrowed verbatim from the HTTP gate:
//   * unset / blank  -> not configured (DENY)
//   * unreadable     -> THROW, naming the ENV KEY, NEVER echoing the path
//   * not JSON       -> THROW, same shape
//   * not an object  -> THROW, same shape
// A typo in the path must never be indistinguishable from a valid configuration.
//
// NO CACHING, ON PURPOSE. The file is re-read on every write authorization, so a REVOKED entry stops
// working immediately rather than at the next process restart. The DEFAULT path costs nothing: an
// unset env var short-circuits before any file I/O.
//
// ─────────────────────────────────────────────────────────────────────────────
// IDENTITY MATCHING, NOT DESTINATION MATCHING
// ─────────────────────────────────────────────────────────────────────────────
//
// An entry names the source's DECLARED IDENTITY: `systemId` (required), plus optional `systemName`
// and `kind` (the data source `type`, e.g. `sqlserver`) which must AGREE when present. It may NOT
// name a host, server, database, port, connection string or credential — `FORBIDDEN_TARGET_KEYS`
// refuses those AT LOAD, and the refusal states the RULE rather than saying "unsupported key".
//
// That is the ruling restated in code, and it is the same reason URL matching was rejected for HTTP:
// a destination is not an identity. It changes under a proxy, a CNAME, an IP literal, an alias, a
// linked server or a synonym. A data source id is a config-authored binding a human wrote and a human
// reviews.
//
// NO WILDCARDS. `'*'` is refused at load in every string position.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE WRITE/READ SPLIT IS THE ONLY CLASSIFICATION — AND IT IS COARSE AND FAIL-CLOSED
// ─────────────────────────────────────────────────────────────────────────────
//
// The gate asks ONE question of a statement: is it PROVABLY a pure read? If not, it is a WRITE and
// needs authorization. It never asks what the statement writes TO.
//
// Provably-a-pure-read means ALL of: a single statement (no `;` separator), no `INTO`, and a leading
// SELECT / EXPLAIN / SHOW. Everything else — including a leading `WITH` — is treated as a WRITE.
//
// WITH IS TREATED AS A WRITE, DELIBERATELY. SQL Server allows a CTE to precede a data-modifying
// statement (`WITH c AS (SELECT …) DELETE …`), and proving a given CTE terminates in a SELECT is the
// same unbounded parsing game this module exists to retire. So a CTE requires authorization. The cost
// is that a CTE-shaped READ on an unarmed source is refused; that is a small, visible, documented
// cost, and the alternative is the round-4 hole.
//
// ─────────────────────────────────────────────────────────────────────────────
// OBJECT SCOPE IS DELIBERATELY NOT OFFERED — AND WHY
// ─────────────────────────────────────────────────────────────────────────────
//
// The HTTP gate scopes an entry to named objects because an `upsert` knows its object. A SQL write
// does not: every write on this lane is ultimately a STATEMENT executed at the adapter, and naming
// the object it touches would require parsing the statement — the exact thing the ruling retires. So
// an entry authorizes a SOURCE for SQL write, and `allObjects: true` must be stated EXPLICITLY; an
// `objects` enumeration is refused at load with a message that explains this rather than silently
// never matching. The scope is coarse on purpose, and it is visible in the file.
//
// ─────────────────────────────────────────────────────────────────────────────
// VALUES-FREE
// ─────────────────────────────────────────────────────────────────────────────
//
// A refusal carries: a FIXED code, a coarse reason token, `systemId`, `operation`, the allowlist
// id/version when one loaded, the matched entry id, and BOOLEANS/COUNTS.
//
// It NEVER carries: the SQL statement or any fragment of it, a table name, a host, server, database,
// port, connection string, credential, bound parameter, row value, file path, or any raw error
// message from the file system or JSON parser. `systemId` is a deployment/config-authored identifier
// — the thing an operator must add to the allowlist file to fix a refusal — not customer data.

import fs from 'node:fs'

// The single env var. Named for the CAPABILITY (generic outbound sql write), not for a consumer: a
// second consumer of this gate arrives as a new entry in the same file, not a new env var.
export const OUTBOUND_SQL_WRITE_TARGETS_ENV = 'INTEGRATION_CORE_OUTBOUND_SQL_WRITE_TARGETS'

// ─── FIXED ERROR CODES ───────────────────────────────────────────────────────
// Frozen vocabulary. Fixed strings, never derived, never formatted from input, identical at every
// layer so a caller cannot probe WHICH layer caught them and work inward.

// The env var is unset/blank: the capability is off for this deployment.
export const OUTBOUND_SQL_WRITE_DISABLED = 'OUTBOUND_SQL_WRITE_DISABLED'
// The capability is on, but this source/operation is not on the list. DISTINCT on purpose —
// collapsing them would leave an operator unable to tell a shut gate from a missing entry.
export const OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED = 'OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED'
// The deployment configured something the gate cannot honour. A broken DEPLOYMENT, not a refused
// caller, so it carries its own code and a 500 — and it still DENIES, never falls through to allow.
export const OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID = 'OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID'

export const OUTBOUND_SQL_WRITE_ERROR_CODES = Object.freeze([
  OUTBOUND_SQL_WRITE_DISABLED,
  OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED,
  OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID,
])

// 403, not 422: a refused caller cannot fix this by editing their request. 500 for the load fault.
export const OUTBOUND_SQL_WRITE_REFUSAL_STATUS = 403
export const OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID_STATUS = 500

export const OUTBOUND_SQL_WRITE_REFUSAL_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  [OUTBOUND_SQL_WRITE_DISABLED]:
    'generic outbound SQL write is disabled; it must be authorized by the server-side outbound SQL write target file',
  [OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED]:
    'this data source is not authorized for generic outbound SQL write',
  [OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID]:
    'the server-side outbound SQL write target file is not usable; generic outbound SQL write stays refused',
})

// ─── THE CLOSED OPERATION VOCABULARY ─────────────────────────────────────────
//
// There is exactly ONE generic SQL write entry point: a STATEMENT executed at the adapter. Structured
// `insert`/`update`/`delete` all build a statement and run it through the same funnel, so they are the
// same operation — modelling them separately would invite an entry that arms `insert` while the same
// bytes flow through as a statement anyway.
//
// AN UNKNOWN OPERATION DEFAULT-REFUSES: a new write path that has not been inventoried presents an
// operation outside this list and is refused rather than inheriting an existing entry. Adding a write
// path therefore requires a visible edit to this list.
export const OUTBOUND_SQL_WRITE_OPERATION_STATEMENT = 'statement'

export const OUTBOUND_SQL_WRITE_OPERATIONS = Object.freeze([
  OUTBOUND_SQL_WRITE_OPERATION_STATEMENT,
])

// ─── THE WRITE/READ SPLIT ────────────────────────────────────────────────────

// Noise stripped before classification so a table name, keyword or separator that appears only inside
// a comment, a string literal or a QUOTED IDENTIFIER cannot change the verdict. Stripping quoted and
// bracketed identifiers is what keeps a legitimate read of a column named `[delete]` from being
// misclassified as a write, while a real `DELETE FROM …` is still seen.
const SQL_BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g
const SQL_LINE_COMMENT = /--[^\n\r]*/g
const SQL_STRING_LITERAL = /'(?:[^']|'')*'/g
const SQL_BRACKET_IDENT = /\[[^\]]*\]/g
const SQL_QUOTED_IDENT = /"[^"]*"/g

function stripSqlNoise(sql: string): string {
  return String(sql ?? '')
    .replace(SQL_BLOCK_COMMENT, ' ')
    .replace(SQL_LINE_COMMENT, ' ')
    .replace(SQL_STRING_LITERAL, " '' ")
    .replace(SQL_BRACKET_IDENT, ' x ')
    .replace(SQL_QUOTED_IDENT, ' x ')
}

// Any token that mutates. Presence ANYWHERE (after noise-stripping) disqualifies a statement from
// being a pure read — see the batch note on `isPureReadStatement`.
const SQL_WRITE_VERB_ANYWHERE =
  /\b(INSERT|UPDATE|DELETE|MERGE|EXEC|EXECUTE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|DENY|BULK)\b/i

// DISTRIBUTED-EXECUTION PRIMITIVES carry an OPAQUE payload: `OPENQUERY(SRV,'DELETE FROM t')` hides a
// remote write inside a string literal — and literals are stripped before classification (which is
// what keeps a read mentioning 'DELETE' in a literal from being misread as a write). So the payload
// is unknowable here BY CONSTRUCTION, and a statement that uses one is never PROVABLY a pure read.
// Fail-closed: it is a write and needs an armed target. This is a statement-FORM rule, not a
// destination check — it does not care which server the primitive names.
const SQL_DISTRIBUTED_EXECUTION =
  /\b(openquery|openrowset|opendatasource|openxml)\s*\(|\b(?:exec|execute)\b[\s\S]*?\bat\b\s+(?:\[[^\]]+\]|[A-Za-z_@#][\w$#]*)/i

/**
 * PROVABLY a pure read? ALL of: a SINGLE statement, no INTO, a leading SELECT/EXPLAIN/SHOW, and NO
 * write-verb token anywhere in the statement.
 *
 * A leading WITH is NOT a pure read (see the header): a CTE may precede a data-modifying statement,
 * and proving otherwise is the parsing game this module retires. Fail-closed.
 *
 * MULTI-STATEMENT BATCHES ARE WRITES, and a `;` check alone does not catch them: T-SQL needs no
 * terminator, so `SELECT 1\nDELETE FROM t` , `SELECT 1\nINSERT t(c) VALUES('x')` (INSERT without
 * INTO), `SELECT 1\nTRUNCATE TABLE t` and `SELECT 1\nEXEC dbo.usp_x` all LEAD with SELECT and carry
 * no `;`. Rather than try to split a batch nobody delimited, the rule is inverted to the fail-closed
 * form the gate needs: if the whole string cannot be shown to be ONE read, it is a write. A trailing
 * write verb anywhere is exactly that proof failing.
 */
export function isPureReadStatement(sql: string): boolean {
  const raw = String(sql ?? '').trim().replace(/;\s*$/, '') // drop a single trailing semicolon
  if (raw.length === 0) return false // nothing to allow
  const cleaned = stripSqlNoise(raw)
  if (cleaned.includes(';')) return false // an explicit separator — a batch could smuggle a write
  if (/\binto\b/i.test(cleaned)) return false // reject SELECT … INTO (a write)
  // Must LEAD with a read verb. `with` is DELIBERATELY ABSENT from this allowlist: a CTE may precede
  // a data-modifying statement (`WITH c AS (…) DELETE …`), and proving a given CTE terminates in a
  // SELECT is the unbounded parsing game this module retires. Adding `with` here re-opens that hole —
  // which is exactly what the CTE guard-removal drill demonstrates.
  if (!/^\s*(select|explain|show)\b/i.test(cleaned)) return false
  // …must contain no write verb at all, which is what catches an unterminated batch…
  if (SQL_WRITE_VERB_ANYWHERE.test(cleaned)) return false
  // …and must not use a distributed-execution primitive, whose payload we deliberately cannot see.
  // Checked against the RAW string: the payload lives in a literal that `stripSqlNoise` removes.
  if (SQL_DISTRIBUTED_EXECUTION.test(raw)) return false
  return true
}

/** Anything not provably a pure read is a WRITE and requires authorization. */
export function isSqlWriteStatement(sql: string): boolean {
  return !isPureReadStatement(sql)
}

// ─── ALLOWLIST FILE SHAPE ────────────────────────────────────────────────────

const ALLOWLIST_KEYS = Object.freeze(['allowlistId', 'allowlistVersion', 'targets'])
const TARGET_KEYS = Object.freeze([
  'entryId',
  'systemId',
  'systemName',
  'kind',
  'allObjects',
  'operations',
])

// Key names that would turn this into DESTINATION matching, or smuggle a credential into a reviewed
// file. Refused at load BY NAME so the error states the rule instead of inviting a hunt for the
// supported spelling of a control that deliberately does not exist.
const FORBIDDEN_TARGET_KEYS = Object.freeze([
  'url', 'uri', 'baseUrl', 'endpoint', 'origin', 'host', 'hostname', 'server', 'address', 'ip',
  'port', 'database', 'catalog', 'instance', 'schema', 'table', 'tables', 'path',
  'connectionString', 'dsn', 'linkedServer',
  'user', 'username', 'password', 'secret', 'token', 'credential', 'credentials', 'apiKey',
])

// `objects` is refused with its own message: object scope is deliberately not offered on this lane
// (see the header), and an operator who writes one must be told why rather than watching it never
// match.
const OBJECT_SCOPE_KEYS = Object.freeze(['objects', 'object'])

// Refused in EVERY string position. A gate whose allowlist accepts `'*'` is not an allowlist.
const WILDCARD_TOKENS = Object.freeze(['*', '**', 'all', 'any'])

export class OutboundSqlWriteGateError extends Error {
  public readonly status: number
  public readonly code: string
  public readonly details: Record<string, unknown>

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'OutboundSqlWriteGateError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

// Load-time fault. Values-free: `field` is a JSON POINTER INTO THE FILE (a shape authored by this
// module's own key vocabulary), never a value read out of it and never the file's path.
function failAllowlist(message: string, details?: Record<string, unknown>): never {
  throw new OutboundSqlWriteGateError(
    OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID_STATUS,
    OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID,
    message,
    details || {},
  )
}

function assertNoWildcard(value: string, field: string): string {
  if (WILDCARD_TOKENS.includes(value.toLowerCase()) || value.includes('*')) {
    failAllowlist(`${field} must name one source exactly; this gate has no wildcard`, {
      field,
      reason: 'wildcard_forbidden',
    })
  }
  return value
}

function requiredString(value: unknown, field: string): string {
  const parsed = optionalString(value)
  if (!parsed) failAllowlist(`${field} is required`, { field })
  return assertNoWildcard(parsed, field)
}

function optionalMatchString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  return requiredString(value, field)
}

function assertClosedKeySet(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue
    if (OBJECT_SCOPE_KEYS.includes(key)) {
      failAllowlist(
        `${label}.${key}: object scope is not offered on the SQL write lane — a SQL write is a statement, and naming the object it touches would require parsing it; set allObjects true to authorize this source for SQL write`,
        { field: `${label}.${key}`, reason: 'object_scope_not_supported' },
      )
    }
    if (FORBIDDEN_TARGET_KEYS.includes(key)) {
      failAllowlist(
        `${label}.${key}: an outbound SQL write target is authorized by its declared identity and never by host, server, database, connection string or credential`,
        { field: `${label}.${key}`, reason: 'identity_matching_only' },
      )
    }
    failAllowlist(`${label}.${key} is not a supported key`, { field: `${label}.${key}` })
  }
}

function requiredStringList(list: unknown, field: string): readonly string[] {
  if (!Array.isArray(list) || list.length === 0) {
    failAllowlist(`${field} must be a non-empty array`, { field })
  }
  const out: string[] = []
  for (let index = 0; index < (list as unknown[]).length; index += 1) {
    out.push(requiredString((list as unknown[])[index], `${field}[${index}]`))
  }
  if (new Set(out).size !== out.length) {
    failAllowlist(`${field} must not repeat an entry`, { field })
  }
  return Object.freeze(out)
}

interface SqlWriteTarget {
  readonly entryId: string
  readonly systemId: string
  readonly systemName: string | null
  readonly kind: string | null
  readonly allObjects: boolean
  readonly operations: readonly string[]
}

/**
 * Normalize ONE allowlist entry. Every fault is fatal at load, and a load fault DENIES.
 *
 * `allObjects: true` must be stated EXPLICITLY. Omitting it is a load error rather than an implicit
 * wildcard, so an entry never authorizes a source's whole write surface by accident — the operator
 * writes the words down and a reviewer sees them.
 */
function normalizeTarget(raw: unknown, index: number): SqlWriteTarget {
  const label = `targets[${index}]`
  if (!isPlainObject(raw)) failAllowlist(`${label} must be an object`, { field: label })
  assertClosedKeySet(raw, TARGET_KEYS, label)

  const entryId = requiredString(raw.entryId, `${label}.entryId`)
  const systemId = requiredString(raw.systemId, `${label}.systemId`)
  // Optional CORROBORATING identities. When present they must AGREE with the loaded source, so an
  // entry can be written to survive an id reuse; when absent the id alone decides. They can only ever
  // NARROW a match — there is no spelling of them that widens one.
  const systemName = optionalMatchString(raw.systemName, `${label}.systemName`)
  const kind = optionalMatchString(raw.kind, `${label}.kind`)

  if (raw.allObjects !== true) {
    failAllowlist(
      `${label} must set allObjects true to authorize this source for SQL write; the SQL lane has no object scope`,
      { field: `${label}.allObjects`, reason: 'object_scope_required' },
    )
  }

  const operations = raw.operations === undefined || raw.operations === null
    ? Object.freeze([OUTBOUND_SQL_WRITE_OPERATION_STATEMENT])
    : requiredStringList(raw.operations, `${label}.operations`)
  for (const operation of operations) {
    if (!OUTBOUND_SQL_WRITE_OPERATIONS.includes(operation)) {
      failAllowlist(
        `${label}.operations contains an operation that is not a registered outbound SQL write entry point`,
        { field: `${label}.operations`, reason: 'unknown_operation' },
      )
    }
  }

  return Object.freeze({
    entryId,
    systemId,
    systemName,
    kind,
    allObjects: true,
    operations,
  })
}

export interface SqlWriteAllowlist {
  readonly allowlistId: string
  readonly allowlistVersion: number
  readonly targets: readonly SqlWriteTarget[]
  readonly targetCount: number
}

/**
 * Read the allowlist off the environment. THREE states only.
 *
 *   * env unset / blank        -> `null`. DENIED, and no file I/O happens at all.
 *   * env set, file usable     -> a frozen, validated allowlist.
 *   * env set, anything else   -> THROWS `OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID`. Never `null`.
 *
 * Parameterless with respect to POLICY. `env` exists only so the suites can drive the loader without
 * mutating the process; every production call site invokes this with no arguments.
 */
export function loadOutboundSqlWriteAllowlist(env: NodeJS.ProcessEnv = process.env): SqlWriteAllowlist | null {
  const raw = env ? env[OUTBOUND_SQL_WRITE_TARGETS_ENV] : undefined
  if (typeof raw !== 'string' || raw.trim().length === 0) return null
  const filePath = raw.trim()

  let contents: string
  try {
    contents = fs.readFileSync(filePath, 'utf8')
  } catch {
    // Values-free: the path is deployment topology, so it is named by ENV KEY and never echoed. The
    // underlying fs error message is dropped entirely — it embeds the path.
    failAllowlist(`${OUTBOUND_SQL_WRITE_TARGETS_ENV} points at a file that could not be read`, {
      envKey: OUTBOUND_SQL_WRITE_TARGETS_ENV,
      reason: 'unreadable',
    })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    failAllowlist(`${OUTBOUND_SQL_WRITE_TARGETS_ENV} must point at a file containing valid JSON`, {
      envKey: OUTBOUND_SQL_WRITE_TARGETS_ENV,
      reason: 'malformed_json',
    })
  }
  if (!isPlainObject(parsed)) {
    failAllowlist(
      `${OUTBOUND_SQL_WRITE_TARGETS_ENV} must point at a JSON object with allowlistId, allowlistVersion and targets`,
      { envKey: OUTBOUND_SQL_WRITE_TARGETS_ENV, reason: 'not_an_object' },
    )
  }

  assertClosedKeySet(parsed, ALLOWLIST_KEYS, 'outboundSqlWriteTargets')
  const allowlistId = requiredString(parsed.allowlistId, 'allowlistId')
  if (!Number.isInteger(parsed.allowlistVersion) || (parsed.allowlistVersion as number) <= 0) {
    failAllowlist('allowlistVersion must be a positive integer', { field: 'allowlistVersion' })
  }
  if (!Array.isArray(parsed.targets)) {
    failAllowlist('targets must be an array', { field: 'targets' })
  }

  const targets = (parsed.targets as unknown[]).map((entry, index) => normalizeTarget(entry, index))

  // Duplicate entry ids would make a refusal/authorization stanza ambiguous about WHICH entry decided.
  const seen = new Set<string>()
  for (const target of targets) {
    if (seen.has(target.entryId)) {
      failAllowlist('targets contains a duplicate entryId', {
        field: 'targets',
        entryId: target.entryId,
        reason: 'duplicate_entry_id',
      })
    }
    seen.add(target.entryId)
  }

  // An ARMED allowlist with an EMPTY `targets` array is legal and authorizes nothing. That is the
  // correct state for a deployment that has turned the capability on and has not yet approved a
  // source; rejecting it would push operators toward leaving the env unset, which is not safer, it is
  // merely less visible.
  return Object.freeze({
    allowlistId,
    allowlistVersion: parsed.allowlistVersion as number,
    targets: Object.freeze(targets),
    targetCount: targets.length,
  })
}

export interface SqlWriteSubject {
  systemId?: string | null
  systemName?: string | null
  kind?: string | null
  operation?: string | null
}

function matchesTarget(target: SqlWriteTarget, subject: { systemId: string | null; systemName: string | null; kind: string | null; operation: string | null }): boolean {
  if (target.systemId !== subject.systemId) return false
  if (target.systemName !== null && target.systemName !== subject.systemName) return false
  if (target.kind !== null && target.kind !== subject.kind) return false
  if (subject.operation === null || !target.operations.includes(subject.operation)) return false
  return target.allObjects
}

export interface SqlWriteDecision {
  readonly systemId: string | null
  readonly operation: string | null
  readonly authorized: boolean
  readonly canApply: boolean
  readonly code: string | null
  readonly status: number
  readonly reason: string
  readonly message?: string
  readonly allowlistId?: string
  readonly allowlistVersion?: number
  readonly allowlistTargetCount?: number
  readonly entryId?: string
  readonly matchedEntryCount?: number
}

/**
 * DECIDE, WITHOUT THROWING. Returns a frozen, values-free decision, so a preview surface can say
 * `canApply: false` with the code that WOULD fire instead of showing a clean plan for a write the
 * gate will refuse.
 *
 * A load fault is reported here rather than thrown, so a malformed deployment file degrades a PREVIEW
 * into an honest refusal instead of taking the read leg down with it. `assert…` still throws on the
 * same fault, because a real write must stop hard.
 */
export function evaluateOutboundSqlWrite(input: SqlWriteSubject = {}, env: NodeJS.ProcessEnv = process.env): SqlWriteDecision {
  const subject = Object.freeze({
    systemId: optionalString(input.systemId),
    systemName: optionalString(input.systemName),
    kind: optionalString(input.kind),
    operation: optionalString(input.operation),
  })
  const base = { systemId: subject.systemId, operation: subject.operation }

  // UNKNOWN ENTRY POINTS DEFAULT-REFUSE.
  if (!subject.operation || !OUTBOUND_SQL_WRITE_OPERATIONS.includes(subject.operation)) {
    return Object.freeze({
      ...base,
      authorized: false,
      canApply: false,
      code: OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED,
      status: OUTBOUND_SQL_WRITE_REFUSAL_STATUS,
      reason: 'unknown_write_operation',
      message: OUTBOUND_SQL_WRITE_REFUSAL_MESSAGES[OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED],
    })
  }

  let allowlist: SqlWriteAllowlist | null
  try {
    allowlist = loadOutboundSqlWriteAllowlist(env)
  } catch (error) {
    const details = error instanceof OutboundSqlWriteGateError ? error.details : {}
    return Object.freeze({
      ...base,
      authorized: false,
      canApply: false,
      code: OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID,
      status: OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID_STATUS,
      reason: optionalString(details.reason) || 'allowlist_invalid',
      message: OUTBOUND_SQL_WRITE_REFUSAL_MESSAGES[OUTBOUND_SQL_WRITE_ALLOWLIST_INVALID],
    })
  }

  // THE DEFAULT. Unset env => refused, with the fixed code, before any file is opened.
  if (allowlist === null) {
    return Object.freeze({
      ...base,
      authorized: false,
      canApply: false,
      code: OUTBOUND_SQL_WRITE_DISABLED,
      status: OUTBOUND_SQL_WRITE_REFUSAL_STATUS,
      reason: 'capability_not_authorized',
      message: OUTBOUND_SQL_WRITE_REFUSAL_MESSAGES[OUTBOUND_SQL_WRITE_DISABLED],
    })
  }

  const scoped = {
    ...base,
    allowlistId: allowlist.allowlistId,
    allowlistVersion: allowlist.allowlistVersion,
  }

  // Fail-closed on an under-specified subject: without a resolved source id nothing can match.
  if (!subject.systemId) {
    return Object.freeze({
      ...scoped,
      authorized: false,
      canApply: false,
      code: OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED,
      status: OUTBOUND_SQL_WRITE_REFUSAL_STATUS,
      reason: 'missing_system_identity',
      message: OUTBOUND_SQL_WRITE_REFUSAL_MESSAGES[OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED],
    })
  }

  const matched = allowlist.targets.filter((target) => matchesTarget(target, subject))
  if (matched.length === 0) {
    return Object.freeze({
      ...scoped,
      authorized: false,
      canApply: false,
      code: OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED,
      status: OUTBOUND_SQL_WRITE_REFUSAL_STATUS,
      reason: 'target_not_listed',
      // A count, never the names.
      allowlistTargetCount: allowlist.targetCount,
      message: OUTBOUND_SQL_WRITE_REFUSAL_MESSAGES[OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED],
    })
  }

  // Deterministic pick: lowest entry id, so a stanza names a stable entry.
  const entryIds = matched.map((target) => target.entryId).sort()
  return Object.freeze({
    ...scoped,
    authorized: true,
    canApply: true,
    code: null,
    status: 200,
    reason: 'authorized',
    entryId: entryIds[0],
    matchedEntryCount: matched.length,
  })
}

export type BuildGateError = (status: number, code: string, message: string, details: Record<string, unknown>) => Error

/**
 * REFUSE OR RETURN. The form every enforcement point uses.
 *
 * `buildError` receives (status, code, message, details) so each layer throws ITS OWN error type and
 * rides that layer's established mapping — while the code, message and status stay identical across
 * layers. This module never learns those error shapes; that is what keeps it a leaf.
 */
export function assertOutboundSqlWriteAuthorized(
  buildError: BuildGateError,
  input: SqlWriteSubject = {},
  env: NodeJS.ProcessEnv = process.env,
): SqlWriteDecision {
  const decision = evaluateOutboundSqlWrite(input, env)
  if (decision.authorized) return decision
  const { authorized, canApply, status, code, message, ...details } = decision
  throw buildError(status as number, code as string, message as string, { code, ...details })
}

/**
 * The enforcement helper the SQL adapters call: gate a STATEMENT. A pure read returns immediately and
 * costs nothing; anything else must be authorized. This is the whole classification surface.
 */
export function assertSqlStatementWriteAuthorized(
  buildError: BuildGateError,
  sql: string,
  source: { id?: string | null; name?: string | null; type?: string | null },
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (isPureReadStatement(sql)) return
  assertOutboundSqlWriteAuthorized(
    buildError,
    {
      systemId: source.id ?? null,
      systemName: source.name ?? null,
      kind: source.type ?? null,
      operation: OUTBOUND_SQL_WRITE_OPERATION_STATEMENT,
    },
    env,
  )
}
