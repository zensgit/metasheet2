// SQL WRITE ARM-BINDING — pins an armed source to the CONNECTION it had when the gate first observed
// it, so authorization cannot be INHERITED by id-reuse or REDIRECTED by a config edit.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE HOLE THIS CLOSES (P1)
// ─────────────────────────────────────────────────────────────────────────────
//
// `outbound-sql-write-gate.ts` authorizes a write by DECLARED IDENTITY — `systemId` (+ optional
// corroborating name/kind). But at the `data_sources:write` tier those are all CLIENT-SUPPLIED:
//   * the id is chosen at create (`DataSourceCreateSchema.id`) and survives a soft-delete → revival;
//   * `systemName`/`kind` are client-supplied too.
// So an operator with `data_sources:write` but NO deploy-file access could:
//   (i)  create / revive a source whose id matches an armed allowlist entry and INHERIT its write
//        authorization; or
//   (ii) redirect an already-armed source's CONNECTION (the PUT deep-merges `connection`) to a new
//        destination while it stays authorized.
// Either makes the gate's premise ("only deploy-file access can arm a write") weaker than claimed.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FIX — PIN THE CONNECTION FINGERPRINT, FROM THE LIVE SOURCE, NOT THE FILE
// ─────────────────────────────────────────────────────────────────────────────
//
// The ratified doctrine forbids naming a DESTINATION in the allowlist file (a URL/host matcher is
// defeatable by a proxy hop). This module does NOT. It captures the source's OWN connection
// fingerprint from the LIVE source the first time the manager observes it (add / load), and pins it
// in-process. On every write authorization the CURRENT fingerprint must equal the pin:
//   * a CONNECTION REDIRECT (ii) changes the current fingerprint → mismatch → refuse;
//   * an ID-REUSE / REVIVAL (i) to a DIFFERENT connection has a different fingerprint → refuse;
//     (a revival to the SAME connection matches — but that is the same destination, so no privilege
//     is gained.)
// The pin is FIRST-SEEN-WINS and is never overwritten by a later edit, so a redirect cannot re-pin
// itself. "Re-arm at the deploy tier" is a process restart (a deploy-controlled event), which
// re-observes whatever source is present then — the documented boundary below.
//
// A fingerprint is a one-way hash of the source's declared connection config (server/host/port/
// database/instance/connectionString). It is NOT a network probe and NOT readable as a destination:
// it only answers "is this the SAME connection the deployer armed?", by equality. That is exactly the
// integrity binding the doctrine's rejection of URL-matching leaves room for.
//
// RESIDUAL, stated plainly: this binds within a PROCESS. If a malicious source already holds the
// armed id at process start, the load-time observation pins IT — but a `data_sources:write` operator
// does not control restart timing, and between restarts any create/revive/redirect changes the
// fingerprint and is refused. The deploy tier owns the restart and the allowlist; that is the same
// trust floor the owner accepted for the HTTP gate.
//
// VALUES-FREE: a fingerprint is a SHA-256 hex digest; nothing here logs or returns a host, database,
// connection string or credential. The pin map is keyed by `systemId` (a config-authored id).

import crypto from 'node:crypto'

import type { BuildGateError, SqlWriteSubject } from './outbound-sql-write-gate'
import {
  OUTBOUND_SQL_WRITE_OPERATION_STATEMENT,
  OUTBOUND_SQL_WRITE_REFUSAL_STATUS,
  OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED,
  assertOutboundSqlWriteAuthorized,
  isPureReadStatement,
} from './outbound-sql-write-gate'

// The connection fields that define a DESTINATION. A change to any of them is a redirect. Kept as a
// closed list so a new connection field cannot silently escape the fingerprint — but note the
// fingerprint is a BINDING (same-or-different), not a parser, so an unknown extra field only ever
// makes two connections compare unequal, which fails closed.
const FINGERPRINTED_CONNECTION_KEYS = [
  'server', 'host', 'hostname', 'address', 'port', 'instanceName', 'instance',
  'database', 'catalog', 'connectionString', 'dsn', 'url',
] as const

function normalizeConnectionValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  return String(value).trim().toLowerCase()
}

/**
 * A stable, one-way fingerprint of a source's declared connection destination. Deterministic in the
 * connection's destination fields and blind to everything else (options, credentials, pool config).
 */
export function sqlConnectionFingerprint(connection: Record<string, unknown> | undefined | null): string {
  const conn = connection && typeof connection === 'object' ? (connection as Record<string, unknown>) : {}
  const canonical: Record<string, string | number | null> = {}
  for (const key of FINGERPRINTED_CONNECTION_KEYS) {
    canonical[key] = normalizeConnectionValue(conn[key])
  }
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

interface ArmBinding {
  readonly fingerprint: string
}

// In-process pin registry, keyed by systemId. FIRST-SEEN-WINS: once a source is pinned it is never
// overwritten, so a later redirect/reuse cannot re-pin itself to a new destination.
const bindings = new Map<string, ArmBinding>()

/**
 * Observe a live source (call at add / load). Pins its current connection fingerprint the FIRST time
 * only; subsequent observations are no-ops, so a redirect (which re-adds an adapter with a new
 * connection) cannot move the pin. Idempotent and cheap.
 */
export function pinSqlSourceConnection(systemId: string | null | undefined, connection: Record<string, unknown> | undefined | null): void {
  if (typeof systemId !== 'string' || systemId.length === 0) return
  if (bindings.has(systemId)) return
  bindings.set(systemId, { fingerprint: sqlConnectionFingerprint(connection) })
}

/** True when the source's CURRENT connection still equals the pinned one. */
export function sqlSourceConnectionMatchesPin(systemId: string | null | undefined, connection: Record<string, unknown> | undefined | null): boolean {
  if (typeof systemId !== 'string' || systemId.length === 0) return false
  const pin = bindings.get(systemId)
  if (!pin) return false // no observation ⇒ cannot confirm the binding ⇒ fail-closed
  return pin.fingerprint === sqlConnectionFingerprint(connection)
}

// Test-only: the pin registry is a process singleton, so suites must reset it between cases.
export function __resetSqlArmBindingsForTests(): void {
  bindings.clear()
}

export interface SqlWriteSource {
  id?: string | null
  name?: string | null
  type?: string | null
  connection?: Record<string, unknown> | null
}

/**
 * THE COMPOSED WRITE AUTHORIZATION used at every enforcement point. A pure read returns immediately.
 * A write must BOTH be an armed target (the file gate) AND still be at the connection it was pinned to
 * (the arm binding). The binding check runs only after the gate authorizes, so an unarmed source
 * still refuses with the gate's own `OUTBOUND_SQL_WRITE_DISABLED` / not-authorized codes — the binding
 * never widens authorization, only revokes an armed one whose destination moved.
 */
export function assertSqlWriteAllowed(
  buildError: BuildGateError,
  sql: string,
  source: SqlWriteSource,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (isPureReadStatement(sql)) return

  const subject: SqlWriteSubject = {
    systemId: source.id ?? null,
    systemName: source.name ?? null,
    kind: source.type ?? null,
    operation: OUTBOUND_SQL_WRITE_OPERATION_STATEMENT,
  }
  // (1) the file gate — default-deny by declared identity.
  assertOutboundSqlWriteAuthorized(buildError, subject, env)

  // (2) the arm binding — the armed source must still be at the connection it was pinned to.
  if (!sqlSourceConnectionMatchesPin(source.id ?? null, source.connection ?? null)) {
    throw buildError(
      OUTBOUND_SQL_WRITE_REFUSAL_STATUS,
      OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED,
      'this data source is armed for SQL write but its connection no longer matches the one it was armed with; re-arm at the deploy tier',
      {
        code: OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED,
        systemId: source.id ?? null,
        reason: 'arm_binding_connection_mismatch',
      },
    )
  }
}
