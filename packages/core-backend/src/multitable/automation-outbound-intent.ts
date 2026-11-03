/**
 * #4196 Class-B — outbound / external side-effect two-phase intent/outcome (design-lock
 * `approval-automation-retry-action-classification-designlock-20260712.md` §3 + §8 Q-B + §9 V7/V8/V9).
 *
 * Class-B actions (`send_webhook`, `send_email`, `send_dingtalk_*`) leave the process (HTTP/DingTalk
 * egress), so NO transaction can span the network call (§0). The correct answer is NOT a durability trade
 * but TWO-PHASE state plus an `outcome_unknown` terminal state that NEVER auto-resends:
 *
 *   (1) record intent  — a durable row keyed by (kind, root_execution_id, action_key, target_key), committed
 *       in state `pending` BEFORE the network call (Tx A, its OWN commit — there is no DB mutation to
 *       co-commit, so unlike the class-A claim it does not require the same-transaction guarantee; it only
 *       needs its own commit to LAND FIRST so a crash cannot lose the fact that a send was about to happen).
 *       The claim mints an ATTEMPT TOKEN and a LEASE for the attempt it authorizes.
 *   (2) attempt        — the actual HTTP/DingTalk call, OUTSIDE any DB transaction;
 *   (3) record outcome — a SECOND, separate commit (Tx B) flipping the row to a terminal state
 *       `sent` / `failed` / `outcome_unknown`, guarded `WHERE status='pending' AND attempt_token = <mine>` so
 *       only THE attempt that was authorized can confirm its own result, and it learns (rowCount) whether its
 *       write landed. A caller that did not land its terminal write MUST NOT report success.
 *
 * The core hazard is the CRASH-MID-SEND window: intent committed `pending`, the send MAY have gone out, but
 * the process died before recording an outcome. A replay that finds `pending` MUST fail closed — but only
 * once the attempt's LEASE has expired may it flip the row to `outcome_unknown` (token-guarded), because a
 * `pending` row with a LIVE lease is an attempt that is still in flight on another worker, not a corpse. A
 * replay never resends on ambiguity (a resend on ambiguity is a duplicate external effect §3).
 *
 * Single winner: the `failed → pending` re-arm is a compare-and-set (`WHERE status='failed'`) whose rowCount
 * decides the winner; a loser re-consults the row and never sends.
 *
 * Per-target keys (#4450 §2.1, PROPOSED): `target_key` is the resolved recipient's stable identity for fan-out
 * actions (`deriveOutboundTargetKey`), `''` for whole-action intents (every single-send action). Rows written
 * before `target_key` existed carry `''` by column default and stay recognized; a per-target claim also
 * consults the whole-action sentinel row of the same action so a key-format upgrade never resends history.
 *
 * VALUES-FREE by construction: the row carries only the identity (sha256 keys, never a payload), a status, an
 * attempt count, an opaque attempt token, a lease timestamp, and a BOUNDED, REDACTED reason CLASS in
 * `last_error` — never a raw response body, a URL, or a credential.
 *
 * V7/V8/V9 scope (§9): intent/outcome is written INLINE in the dispatch path (not a background re-lease
 * worker). The lease here fences REPLAYS of the same identity (who may declare an attempt dead); it is not a
 * scheduler. The zombie-fence (V7), poison-terminal (V8), and class-B storm-leg (V9) obligations remain
 * satisfied by the S6 event_fires lease (#4426) plus the token-fenced single-writer outcome guard here.
 */
import { createHash, randomUUID } from 'node:crypto'

const NON_BLANK = /[!-~]/
const OUTBOUND_KINDS: ReadonlySet<string> = new Set(['execution', 'test_run'])
/** last_error is a bounded, redacted CLASS string — hard cap so a caller can never smuggle a body in. */
const LAST_ERROR_MAX = 200
/** #4450 §2.2 target_key shape: '' (whole-action sentinel) or a 16..64 hex digest. */
const TARGET_KEY_SHAPE = /^[0-9a-f]{16,64}$/
/** How many times a claim re-consults the row after losing a compare-and-set before failing closed. */
const MAX_CONSULT_PASSES = 3

export type OutboundIntentKind = 'execution' | 'test_run'
export type OutboundIntentStatus = 'pending' | 'sent' | 'failed' | 'outcome_unknown'
export type OutboundOutcome = 'sent' | 'failed' | 'outcome_unknown'
export type OutboundSkipDecision = 'skip_sent' | 'skip_unknown' | 'skip_inflight'
export type OutboundClaimDecision = 'proceed' | 'retry_failed' | OutboundSkipDecision

/** `target_key` of a whole-action intent (every single-send action; the pre-#4450 row shape). */
export const WHOLE_ACTION_TARGET_KEY = ''
/** Lease for call sites without a single bounded transport timeout (email, DingTalk multi-call sends). */
export const DEFAULT_OUTBOUND_LEASE_MS = 120_000
/** Slack added on top of a bounded transport timeout so a slow-but-alive attempt is never declared dead early. */
export const OUTBOUND_LEASE_GRACE_MS = 30_000
export const OUTBOUND_LEASE_MIN_MS = 1_000
export const OUTBOUND_LEASE_MAX_MS = 3_600_000

export interface OutboundIntentIdentity {
  kind: OutboundIntentKind
  /** kind='execution': the execution lineage root; kind='test_run': the §6.1 server-derived scoped root. */
  rootExecutionId: string
  /** the §2.1 triple identity — produce with deriveActionKey (injective JSON-array encoding). */
  actionKey: string
  /**
   * #4450 §2.1 per-target segment: `deriveOutboundTargetKey(...)` for ONE resolved recipient of a fan-out
   * action; omitted / '' = the whole-action intent every single-send action writes.
   */
  targetKey?: string
}

export interface OutboundClaimOptions {
  /** Lease length for the attempt this claim authorizes (clamped to [1s, 1h]); default 120s. */
  leaseMs?: number
  /** Test seam: the attempt token to mint instead of a random UUID. */
  attemptToken?: string
}

/**
 * The claim result. `proceed` / `retry_failed` authorize exactly ONE attempt and carry the token that attempt
 * must present to {@link recordOutboundOutcome}; every `skip_*` decision means: do NOT send.
 *   - skip_sent      → already delivered (a success-shaped alreadyApplied step is honest);
 *   - skip_unknown   → §3 TERMINAL ambiguity; dependents must stop until reconciliation, never auto-resent;
 *   - skip_inflight  → another attempt holds a LIVE lease on this identity; nothing is known yet, nothing is
 *                      declared dead, nothing is sent.
 */
export type OutboundClaim =
  | { decision: 'proceed' | 'retry_failed'; attemptToken: string; leaseMs: number }
  | { decision: OutboundSkipDecision; attemptToken: null }

export interface OutboundOutcomeRecord {
  /** true iff THIS attempt's terminal write landed on exactly one `pending` row carrying its token. */
  confirmed: boolean
}

/** The autocommit query fn shape used across the automation executor (AutomationDeps['queryFn']). */
export type OutboundQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

/**
 * #4196 Class-B outbound RUNTIME GATE — default OFF. The executor's send_* methods only take the two-phase
 * intent/outcome path when this is ON AND a class-A action identity is present. Off ⇒ every send path is
 * BYTE-IDENTICAL to pre-slice (no intent row, no classification, no outcome write). Follows the repo flag
 * convention (`env.<NAME> === 'true'`, mirroring isClassAExecutionClaimEnabled).
 */
export function isClassBOutboundEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AUTOMATION_CLASSB_OUTBOUND_ENABLED === 'true'
}

function assertIdentity(id: OutboundIntentIdentity, fn: string): void {
  if (typeof id.kind !== 'string' || !OUTBOUND_KINDS.has(id.kind)) {
    throw new RangeError(`${fn}: kind must be 'execution' | 'test_run' (got ${String(id.kind)})`)
  }
  for (const [name, v] of [['rootExecutionId', id.rootExecutionId], ['actionKey', id.actionKey]] as const) {
    if (typeof v !== 'string' || !NON_BLANK.test(v)) {
      throw new RangeError(`${fn}: ${name} must be non-blank`)
    }
  }
  if (id.targetKey !== undefined && id.targetKey !== WHOLE_ACTION_TARGET_KEY) {
    if (typeof id.targetKey !== 'string' || !TARGET_KEY_SHAPE.test(id.targetKey)) {
      throw new RangeError(`${fn}: targetKey must be '' or a 16..64 hex digest (deriveOutboundTargetKey)`)
    }
  }
}

function clampLeaseMs(leaseMs: number | undefined): number {
  if (typeof leaseMs !== 'number' || !Number.isFinite(leaseMs)) return DEFAULT_OUTBOUND_LEASE_MS
  return Math.min(Math.max(Math.floor(leaseMs), OUTBOUND_LEASE_MIN_MS), OUTBOUND_LEASE_MAX_MS)
}

/** Lease for an attempt bounded by a transport timeout: the timeout plus a fixed grace. */
export function outboundLeaseForTimeout(timeoutMs: number): number {
  return clampLeaseMs(Math.max(0, Number.isFinite(timeoutMs) ? timeoutMs : 0) + OUTBOUND_LEASE_GRACE_MS)
}

/**
 * #4450 §2.1 — a stable per-target key for ONE resolved recipient/record of a fan-out step. Injective
 * JSON-array encoding of the identity parts, then sha256 hex (64 chars; satisfies the §2.2 CHECK). The key
 * depends ONLY on the parts (never on position in a batch, a display name, or a timestamp), so two records
 * give two keys, the same record gives the same key after a crash, and reordering changes nothing.
 * Examples of parts: ['dingtalk_user', integrationId, dingtalkUserId]; ['dingtalk_group_destination', id];
 * ['yida_form_record', formUuid, recordId].
 */
export function deriveOutboundTargetKey(parts: readonly string[]): string {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new RangeError('deriveOutboundTargetKey: parts must be a non-empty array')
  }
  for (const part of parts) {
    if (typeof part !== 'string' || !NON_BLANK.test(part)) {
      throw new RangeError('deriveOutboundTargetKey: every part must be a non-blank string')
    }
  }
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

function rowCountOf(result: { rowCount?: number | null }): number {
  return Number(result.rowCount ?? 0)
}

interface ConsultedRow {
  status?: string
  attempt_token?: string | null
  lease_live?: boolean | null
}

interface IdentityParams {
  kind: string
  root: string
  actionKey: string
  targetKey: string
}

async function consultRow(query: OutboundQueryFn, p: IdentityParams): Promise<ConsultedRow | undefined> {
  // The DB clock decides liveness (every worker compares against the same now()). A NULL lease (a row written
  // before leases existed) is never live.
  const consult = await query(
    `SELECT status, attempt_token,
            (lease_expires_at IS NOT NULL AND lease_expires_at > now()) AS lease_live
       FROM meta_automation_outbound_intent
      WHERE kind = $1 AND root_execution_id = $2 AND action_key = $3 AND target_key = $4`,
    [p.kind, p.root, p.actionKey, p.targetKey],
  )
  return consult.rows[0] as ConsultedRow | undefined
}

/**
 * Flip an EXPIRED `pending` row to `outcome_unknown`. Token-guarded: the flip names the attempt it observed,
 * so a row re-armed by a newer attempt in between (different token, live lease) is left alone. Returns true
 * iff this call performed the flip.
 */
async function expirePendingRow(query: OutboundQueryFn, p: IdentityParams, observedToken: string | null): Promise<boolean> {
  const flipped = await query(
    `UPDATE meta_automation_outbound_intent
        SET status = 'outcome_unknown', last_error = 'lease_expired', updated_at = now()
      WHERE kind = $1 AND root_execution_id = $2 AND action_key = $3 AND target_key = $4
        AND status = 'pending'
        AND attempt_token IS NOT DISTINCT FROM $5
        AND (lease_expires_at IS NULL OR lease_expires_at <= now())`,
    [p.kind, p.root, p.actionKey, p.targetKey, observedToken],
  )
  return rowCountOf(flipped) === 1
}

/**
 * Shared consult loop over ONE row identity. Returns a skip decision when the row forbids sending, a
 * `retry_failed` claim when this caller WON the failed→pending compare-and-set (only when `allowRearm`), or
 * null when there is nothing blocking (`absent` ⇒ null only when `absentMeans` says so).
 */
async function resolveExistingRow(
  query: OutboundQueryFn,
  p: IdentityParams,
  token: string,
  leaseMs: number,
  mode: { allowRearm: boolean; absentMeans: 'proceed' | 'skip_unknown' },
): Promise<OutboundClaim | null> {
  for (let pass = 0; pass < MAX_CONSULT_PASSES; pass++) {
    const row = await consultRow(query, p)
    if (!row) {
      // Row vanished (swept/deleted concurrently) — for the OWN identity this cannot prove non-delivery, so
      // never send; for the legacy sentinel probe absence simply means no history.
      return mode.absentMeans === 'proceed' ? null : { decision: 'skip_unknown', attemptToken: null }
    }
    if (row.status === 'sent') return { decision: 'skip_sent', attemptToken: null }
    if (row.status === 'outcome_unknown') return { decision: 'skip_unknown', attemptToken: null }
    if (row.status === 'pending') {
      // A LIVE lease is an attempt still in flight elsewhere: do not send, do not declare it dead.
      if (row.lease_live === true) return { decision: 'skip_inflight', attemptToken: null }
      // Expired (or lease-less legacy) pending ⇒ CRASH-MID-SEND fail-closed flip, fenced by the observed
      // token. Losing the flip means the row moved under us (re-armed or terminalized) ⇒ re-consult.
      if (await expirePendingRow(query, p, row.attempt_token ?? null)) {
        return { decision: 'skip_unknown', attemptToken: null }
      }
      continue
    }
    if (row.status === 'failed') {
      if (!mode.allowRearm) return null // legacy sentinel: definite non-delivery blocks nothing
      // Definite pre-dispatch non-delivery last time (nothing left the client) ⇒ safe to re-attempt — but
      // EXACTLY ONE re-attempt wins: the CAS is decided by rowCount, never assumed.
      const rearmed = await query(
        `UPDATE meta_automation_outbound_intent
            SET status = 'pending', attempts = attempts + 1, attempt_token = $5,
                lease_expires_at = now() + ($6::int * interval '1 millisecond'), updated_at = now()
          WHERE kind = $1 AND root_execution_id = $2 AND action_key = $3 AND target_key = $4
            AND status = 'failed'`,
        [p.kind, p.root, p.actionKey, p.targetKey, token, leaseMs],
      )
      if (rowCountOf(rearmed) === 1) return { decision: 'retry_failed', attemptToken: token, leaseMs }
      continue // a concurrent re-arm won; re-consult (it now holds a live lease ⇒ skip_inflight)
    }
    // Unknown status literal (schema drift) — never send when the state cannot be proven.
    return { decision: 'skip_unknown', attemptToken: null }
  }
  // Lost every compare-and-set race — the row is being driven by someone else; fail closed.
  return { decision: 'skip_unknown', attemptToken: null }
}

/**
 * Tx A — record intent (its own committed transaction, BEFORE the network call). INSERT a fresh `pending`
 * row carrying THIS attempt's token and lease; ON CONFLICT DO NOTHING. The decision governs whether the caller
 * performs the send:
 *
 *   - fresh insert (rowCount 1) → 'proceed' — we own a fresh `pending`; attempt the send ONCE.
 *   - row already exists (rowCount 0) → consult its status:
 *       'sent'            → 'skip_sent'     — already delivered; do NOT resend.
 *       'outcome_unknown' → 'skip_unknown'  — §3 TERMINAL; NEVER auto-resend.
 *       'pending', lease LIVE    → 'skip_inflight' — an attempt is in flight elsewhere: do not send, do not
 *                                  flip (the in-flight attempt still owns the terminal write).
 *       'pending', lease expired → the attempt crashed (or ran past its lease) ⇒ the send MAY have happened
 *                                  ⇒ FAIL CLOSED: flip pending→outcome_unknown, guarded by status AND the
 *                                  observed token, and return 'skip_unknown' — never a second send.
 *       'failed'          → prior attempt was DEFINITE pre-dispatch non-delivery (nothing ever sent) ⇒
 *                           eligible to re-attempt: compare-and-set failed→pending (attempts+1, new token +
 *                           lease). EXACTLY ONE concurrent caller wins ('retry_failed'); losers re-consult.
 *       (absent/other)    → the row vanished between the conflict and the SELECT (concurrent delete) ⇒ fail
 *                           closed to 'skip_unknown'; never send when the state cannot be proven.
 *
 * Per-target identities (#4450) first consult the whole-action sentinel row of the same action: history
 * written under the pre-#4450 key format (`sent` / `outcome_unknown` / a crashed `pending`) is recognized and
 * blocks the per-target send; a sentinel `failed` (definite non-delivery) blocks nothing.
 *
 * The consult is ONE-directional (whole-action → per-target upgrade only): a whole-action claim does NOT
 * consult per-target rows. An action type's key shape is therefore fixed once it is wired — never mix
 * whole-action and per-target claims for the same action, or a whole-action claim would proceed over a
 * per-target `sent` row (a resend). A reverse consult is a follow-up for when fan-out actions are wired.
 */
export async function claimOutboundIntent(
  query: OutboundQueryFn,
  id: OutboundIntentIdentity,
  opts: OutboundClaimOptions = {},
): Promise<OutboundClaim> {
  assertIdentity(id, 'claimOutboundIntent')
  const targetKey = id.targetKey ?? WHOLE_ACTION_TARGET_KEY
  const token = typeof opts.attemptToken === 'string' && NON_BLANK.test(opts.attemptToken) ? opts.attemptToken : randomUUID()
  const leaseMs = clampLeaseMs(opts.leaseMs)
  const own: IdentityParams = { kind: id.kind, root: id.rootExecutionId, actionKey: id.actionKey, targetKey }

  if (targetKey !== WHOLE_ACTION_TARGET_KEY) {
    // Key-format upgrade guard: a whole-action row written before per-target keys existed is still history.
    const legacy = await resolveExistingRow(
      query,
      { ...own, targetKey: WHOLE_ACTION_TARGET_KEY },
      token,
      leaseMs,
      { allowRearm: false, absentMeans: 'proceed' },
    )
    if (legacy) return legacy
  }

  const inserted = await query(
    `INSERT INTO meta_automation_outbound_intent
       (kind, root_execution_id, action_key, target_key, attempt_token, lease_expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + ($6::int * interval '1 millisecond'))
     ON CONFLICT (kind, root_execution_id, action_key, target_key) DO NOTHING`,
    [own.kind, own.root, own.actionKey, own.targetKey, token, leaseMs],
  )
  if (rowCountOf(inserted) === 1) return { decision: 'proceed', attemptToken: token, leaseMs }

  const existing = await resolveExistingRow(query, own, token, leaseMs, { allowRearm: true, absentMeans: 'skip_unknown' })
  return existing ?? { decision: 'skip_unknown', attemptToken: null }
}

/**
 * Tx B — record outcome (a SECOND, separate commit AFTER the attempt). The guard
 * `status='pending' AND attempt_token = <mine>` is the SINGLE-WRITER + SAME-ATTEMPT fence: a zombie whose
 * row was already terminalized, or whose lease expired and was flipped by a replay, writes 0 rows — and is
 * TOLD so (`confirmed:false`), because a step may only report success for a terminal write it landed itself.
 * `lastError` is bounded + stored as-is: callers pass a REDACTED reason CLASS (see
 * {@link outboundReasonClass}), never a raw body/URL/token; the bound is defense-in-depth.
 */
export async function recordOutboundOutcome(
  query: OutboundQueryFn,
  id: OutboundIntentIdentity,
  outcome: OutboundOutcome,
  lastError: string | null | undefined,
  attemptToken: string,
): Promise<OutboundOutcomeRecord> {
  assertIdentity(id, 'recordOutboundOutcome')
  if (outcome !== 'sent' && outcome !== 'failed' && outcome !== 'outcome_unknown') {
    throw new RangeError(`recordOutboundOutcome: outcome must be 'sent' | 'failed' | 'outcome_unknown'`)
  }
  if (typeof attemptToken !== 'string' || !NON_BLANK.test(attemptToken)) {
    throw new RangeError('recordOutboundOutcome: attemptToken must be the non-blank token the claim issued')
  }
  const boundedError = lastError == null ? null : String(lastError).slice(0, LAST_ERROR_MAX)
  const updated = await query(
    `UPDATE meta_automation_outbound_intent
        SET status = $4, last_error = $5, updated_at = now()
      WHERE kind = $1 AND root_execution_id = $2 AND action_key = $3 AND target_key = $6
        AND status = 'pending' AND attempt_token = $7`,
    [id.kind, id.rootExecutionId, id.actionKey, outcome, boundedError, id.targetKey ?? WHOLE_ACTION_TARGET_KEY, attemptToken],
  )
  return { confirmed: rowCountOf(updated) === 1 }
}

/**
 * The single attempt's transport result, in a values-free shape so classification is unit-testable without
 * a live socket:
 *   - `response`      — fetch RESOLVED with a Response; only the HTTP status matters (never the body).
 *   - `timeout`       — the per-attempt timeout / caller abort fired.
 *   - `network-error` — fetch REJECTED without producing a response; `code`/`name` are the undici system
 *     error identifiers used to tell DEFINITE pre-dispatch non-delivery from ambiguous post-dispatch loss.
 */
export type OutboundAttemptResult =
  | { kind: 'response'; status: number }
  | { kind: 'timeout' }
  | { kind: 'network-error'; code: string | null; name?: string | null }

/**
 * Node/undici DNS-resolution and connection-refused system error codes: the request body never left the
 * client, so the receiver cannot have acted on it — the ENTIRE definite-`failed` set alongside TLS below.
 */
const PRE_DISPATCH_NON_DELIVERY_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND', // DNS: host not found
  'EAI_AGAIN', // DNS: temporary resolution failure
  'ECONNREFUSED', // connection refused (no listener) — the TCP handshake never completed
])

/**
 * TLS handshake failure — the handshake PRECEDES any request body leaving the client, so a cert/SSL error
 * is definite pre-dispatch non-delivery. Node surfaces these as a curated set of codes plus the
 * `ERR_TLS_*` / `ERR_SSL_*` families.
 */
const TLS_HANDSHAKE_CODES: ReadonlySet<string> = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'HOSTNAME_MISMATCH',
])

function isPreDispatchNonDelivery(code: string | null | undefined): boolean {
  if (typeof code !== 'string' || code.length === 0) return false
  if (PRE_DISPATCH_NON_DELIVERY_CODES.has(code)) return true
  if (TLS_HANDSHAKE_CODES.has(code)) return true
  return code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_')
}

/**
 * §3 + §8 Q-B classification, MIRRORING the DingTalk transport's `send`-tier doctrine
 * (`integrations/dingtalk/transport.ts:110-136`): "network error ≠ not executed; an ambiguous outcome is
 * `outcome_unknown`, never auto-resent." Tiers:
 *
 *   - 2xx → 'sent'.
 *   - DEFINITE pre-dispatch non-delivery ONLY (nothing left the client): DNS failure, connection refused,
 *     TLS handshake failure → 'failed' (eligible to re-attempt).
 *   - EVERYTHING after the body was sent → 'outcome_unknown': request timeout, connection reset, ANY HTTP
 *     status received (INCLUDING every 4xx per §8 Q-B — NO 4xx subset is definite-`failed` in v1 — and every
 *     5xx/3xx), or any client-indistinguishable network error (ECONNRESET/EPIPE/ETIMEDOUT/unknown).
 *
 * NOTE (reported lock-vs-transport divergence): the literal `classifyDingTalkFailure` marks a generic 4xx
 * and a DNS/conn-refused `network_error` on the send tier as NOT-unknown / unknown respectively; the LOCK
 * (§3, §8 Q-B) is MORE conservative for webhook/email — every 4xx ⇒ outcome_unknown, and DNS/conn-refused/
 * TLS is carved out as plain `failed`. Per the build directive the LOCK wins; this mirrors the transport's
 * *tiers* (read/exchange/send), not that call site's DingTalk-specific 4xx/network boundaries.
 */
export function classifyOutboundResult(result: OutboundAttemptResult): OutboundOutcome {
  if (result.kind === 'response') {
    return result.status >= 200 && result.status < 300 ? 'sent' : 'outcome_unknown'
  }
  if (result.kind === 'timeout') {
    return 'outcome_unknown'
  }
  // network-error: only DEFINITE pre-dispatch non-delivery is plain `failed`; all else is ambiguous.
  return isPreDispatchNonDelivery(result.code) ? 'failed' : 'outcome_unknown'
}

/**
 * A BOUNDED, REDACTED reason CLASS for `last_error` — a coarse category, never a raw body/URL/token. Kept
 * in lock-step with {@link classifyOutboundResult} so the recorded class matches the recorded status.
 */
export function outboundReasonClass(result: OutboundAttemptResult): string {
  if (result.kind === 'response') {
    return result.status >= 200 && result.status < 300 ? 'sent_2xx' : `http_${result.status}`
  }
  if (result.kind === 'timeout') return 'timeout'
  const code = result.code
  if (typeof code === 'string' && code.length > 0) {
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns_failure'
    if (code === 'ECONNREFUSED') return 'conn_refused'
    if (isPreDispatchNonDelivery(code)) return 'tls_failure'
    return `network_${code}`.slice(0, LAST_ERROR_MAX)
  }
  return 'network_error'
}

/**
 * Map a raw fetch rejection to the values-free {@link OutboundAttemptResult}. A caller-abort / per-attempt
 * timeout surfaces as `timeout`; every other rejection is a `network-error` whose `code`/`name` are read
 * from the error and its undici `cause` (undici wraps the socket error as the `cause` of a TypeError).
 */
export function classifyFetchError(error: unknown): OutboundAttemptResult {
  if (typeof error === 'object' && error !== null) {
    const name = (error as { name?: unknown }).name
    const cause = (error as { cause?: unknown }).cause
    const causeName = typeof cause === 'object' && cause !== null ? (cause as { name?: unknown }).name : undefined
    if (name === 'AbortError' || name === 'TimeoutError' || causeName === 'AbortError' || causeName === 'TimeoutError') {
      return { kind: 'timeout' }
    }
    const directCode = (error as { code?: unknown }).code
    const causeCode = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined
    const code = typeof directCode === 'string' ? directCode : typeof causeCode === 'string' ? causeCode : null
    return { kind: 'network-error', code, name: typeof name === 'string' ? name : null }
  }
  return { kind: 'network-error', code: null, name: null }
}
