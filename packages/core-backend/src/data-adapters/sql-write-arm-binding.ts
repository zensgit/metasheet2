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
// TWO FURTHER HOLES CLOSED HERE (a bounded re-verification of the P1 fix):
//   * FIX 2 — ARM-AHEAD-OF-PROVISIONING. Pinning now happens ONLY on the DEPLOY-controlled LOAD path.
//     The runtime (API) create/redirect path never pins; instead it REFUSES to provision an armed id
//     that has no load-time pin (see {@link assertSqlSourceProvisionableAtRuntime}), before any row is
//     persisted. So a `data_sources:write` operator can no longer create a source at an armed-but-
//     never-provisioned id and have the create-time observation pin the OPERATOR's connection.
//   * FIX 3 — CREDENTIAL / DEFAULT-DB REDIRECT. The fingerprint is credential-blind, and a blank
//     `connection.database` resolves to the LOGIN's default DB, so a login swap could redirect the
//     write with an unchanged fingerprint. An armed write on a blank-database source is now refused
//     (see the `hasExplicitDatabase` gate in {@link assertSqlWriteAllowed}); an explicit database folds
//     the destination catalog into the pin.
//
// RESIDUAL, stated plainly (the credential-blind residual, and it is NOT closed): FIX 3 closed the
// case where the DESTINATION could move (a blank database resolving to whatever the login defaults
// to). It did NOT — and this binding cannot — close a PRIVILEGE change on an UNCHANGED destination:
// a swap of `connection.user`/`password` to a WRITE-CAPABLE login on the SAME server and the SAME
// explicit database keeps every fingerprinted field identical, so the pin still matches and the armed
// write proceeds. That is inherent, not an oversight: the fingerprint deliberately hashes the declared
// DESTINATION fields only (server/host/port/database/instance/connectionString) and is values-free, so
// it can answer "is this the same destination the deployer armed?" but never "does this login still
// lack write rights?". Answering the second question is the READ-ONLY DATABASE ACCOUNT's job — the
// layer the owner ruled is the PROVABLE one (option A, the boundary ruling): a login with no INSERT/
// UPDATE/DELETE grant refuses the write at the server regardless of what any in-process gate decided.
// This module, and the gate above it, are DEFENSE IN DEPTH beneath that account. An operator who can
// rewrite a source's credentials to a write-capable login has already defeated the provable layer, and
// no in-process binding can restore it.
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
  loadOutboundSqlWriteAllowlist,
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

// FIX 3: is the destination DATABASE explicitly named on this connection? The MSSQL adapter passes
// `connection.database` straight through as the target catalog; a blank value connects to the login's
// default database. `catalog` is accepted as its synonym for adapters that spell it that way. A raw
// `connectionString`/`dsn`/`url` may embed the DB opaquely, but the adapters this gate protects do not
// use one, so — fail-closed — only an explicit structured `database`/`catalog` counts as unambiguous.
function hasExplicitDatabase(connection: Record<string, unknown> | undefined | null): boolean {
  const conn = connection && typeof connection === 'object' ? (connection as Record<string, unknown>) : {}
  for (const key of ['database', 'catalog'] as const) {
    const value = conn[key]
    if (typeof value === 'string' && value.trim().length > 0) return true
  }
  return false
}

interface ArmBinding {
  readonly fingerprint: string
}

// In-process pin registry, keyed by systemId. FIRST-SEEN-WINS: once a source is pinned it is never
// overwritten, so a later redirect/reuse cannot re-pin itself to a new destination.
const bindings = new Map<string, ArmBinding>()

/**
 * Pin a source's connection fingerprint AT ALLOWLIST-LOAD TIME. This is the ONLY function that adds a
 * pin, and its ONE legitimate caller is the manager's load path (`loadFromDatabase`), which re-observes
 * whatever persisted sources exist at process start — a deploy-controlled moment. Pins FIRST-SEEN-WINS,
 * so a later redirect cannot move the pin. Idempotent and cheap.
 *
 * FIX 2 — WHY PINNING IS LOAD-ONLY. Before this fix the manager also pinned on the RUNTIME create path
 * (`addDataSource`), so a `data_sources:write` operator could provision an id that a deploy file had
 * armed-but-never-provisioned and the create-time observation would pin the OPERATOR's connection —
 * arming ahead of provisioning, no restart needed. Now the runtime path never pins (it calls
 * {@link assertSqlSourceProvisionableAtRuntime} instead), so an armed id can only ever be pinned from a
 * source that already existed when the allowlist was loaded. An armed id with no source at load is
 * INERT until a deploy provisions it and the process reloads.
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

/**
 * Is this systemId named by ANY entry in the deploy allowlist? Coarse on purpose — it asks only
 * whether the id is ARMED at all, not whether a given write would match (name/kind/operation), because
 * the runtime provisioning guard must fail closed toward REFUSAL for any armed id. A broken allowlist
 * (load throws) returns `false`: the gate already refuses every write with ALLOWLIST_INVALID while it
 * is broken, so a source created during that window is harmless (its writes are refused), and blocking
 * unrelated source creation on a config typo would be a worse operational failure than the narrow,
 * deploy-gated residual (documented on {@link assertSqlSourceProvisionableAtRuntime}).
 */
function isSystemIdArmed(systemId: string, env: NodeJS.ProcessEnv): boolean {
  let allowlist
  try {
    allowlist = loadOutboundSqlWriteAllowlist(env)
  } catch {
    return false
  }
  if (!allowlist) return false
  return allowlist.targets.some((target) => target.systemId === systemId)
}

/**
 * FIX 2 — REFUSE PROVISIONING AN ARMED-BUT-UNPINNED ID AT THE RUNTIME (API) TIER.
 *
 * The manager's runtime create/redirect path calls this INSTEAD of pinning. An armed id that has no
 * load-time pin is being provisioned (or first-observed) AFTER the allowlist was loaded — the
 * arm-ahead-of-provisioning attack — and is refused BEFORE any row is persisted, so it cannot be
 * "trusted into a fresh pin" now nor re-observed and pinned at a later restart. An armed id that IS
 * already pinned (provisioned at load) is a legitimate re-observation (revival / redirect) and passes
 * here; its write is still governed by the fingerprint binding. An UNARMED id passes untouched.
 *
 * RESIDUAL, stated plainly: this binds within a PROCESS and reads the allowlist as it stands now. While
 * the allowlist file is BROKEN (load throws) {@link isSystemIdArmed} reports "not armed", so a create
 * is not blocked during that window; if a deployer later FIXES the file to arm that exact id AND
 * restarts, the persisted row would be pinned at that restart. That requires deploy-tier intent on both
 * the file and the restart — the same trust floor the arm binding already documents.
 */
export function assertSqlSourceProvisionableAtRuntime(
  buildError: BuildGateError,
  systemId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (typeof systemId !== 'string' || systemId.length === 0) return
  if (bindings.has(systemId)) return // pinned at load ⇒ legitimate re-observation
  if (!isSystemIdArmed(systemId, env)) return // ordinary unarmed source ⇒ nothing to guard
  throw buildError(
    OUTBOUND_SQL_WRITE_REFUSAL_STATUS,
    OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED,
    'this data source id is armed for generic SQL write but was not provisioned when the allowlist was loaded; a source armed for SQL write must already exist at load time (provision it at the deploy tier, then arm it and reload) — it cannot be created or redirected into an armed id at the API tier',
    {
      code: OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED,
      systemId,
      reason: 'arm_ahead_of_provisioning',
    },
  )
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

  // (2) FIX 3 — an armed source's destination DATABASE must be EXPLICIT. The fingerprint is
  // credential-blind, and mssql connects to the LOGIN's DEFAULT database when `connection.database` is
  // blank. So on a blank-database source a `data_sources:write` operator could swap to a login whose
  // default DB is K3 (same server) and redirect the write with an UNCHANGED fingerprint. Requiring an
  // explicit database makes the destination DB part of the pinned fingerprint, so a login swap that
  // changes the effective DB is impossible without also changing `database` (which breaks the pin).
  // The MSSQL adapter uses `connection.database` verbatim as the target catalog, so a blank value here
  // is precisely the ambiguous destination — refuse it.
  if (!hasExplicitDatabase(source.connection ?? null)) {
    throw buildError(
      OUTBOUND_SQL_WRITE_REFUSAL_STATUS,
      OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED,
      'this data source is armed for SQL write but its connection does not set an explicit destination database; a blank database resolves to the login default and is an ambiguous, credential-redirectable target — set connection.database',
      {
        code: OUTBOUND_SQL_WRITE_TARGET_NOT_AUTHORIZED,
        systemId: source.id ?? null,
        reason: 'arm_binding_ambiguous_database',
      },
    )
  }

  // (3) the arm binding — the armed source must still be at the connection it was pinned to.
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
