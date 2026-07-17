/**
 * #4196 Class-B — outbound / external side-effect two-phase intent/outcome (design-lock
 * `approval-automation-retry-action-classification-designlock-20260712.md` §3 + §8 Q-B + §9 V7/V8/V9).
 *
 * Class-B actions (`send_webhook`, `send_email`, `send_dingtalk_*`) leave the process (HTTP/DingTalk
 * egress), so NO transaction can span the network call (§0). The correct answer is NOT a durability trade
 * but TWO-PHASE state plus an `outcome_unknown` terminal state that NEVER auto-resends:
 *
 *   (1) record intent  — a durable row keyed by (kind, root_execution_id, action_key), committed in state
 *       `pending` BEFORE the network call (Tx A, its OWN commit — there is no DB mutation to co-commit, so
 *       unlike the class-A claim it does not require the same-transaction guarantee; it only needs its own
 *       commit to LAND FIRST so a crash cannot lose the fact that a send was about to happen);
 *   (2) attempt        — the actual HTTP/DingTalk call, OUTSIDE any DB transaction;
 *   (3) record outcome — a SECOND, separate commit (Tx B) flipping the row to a terminal state
 *       `sent` / `failed` / `outcome_unknown`, guarded `WHERE status='pending'` so a concurrent zombie that
 *       already terminalized the row writes 0 rows (single-writer for the terminal outcome).
 *
 * The core hazard is the CRASH-MID-SEND window: intent committed `pending`, the send MAY have gone out, but
 * the process died before recording an outcome. A retry that finds `pending` MUST fail closed — flip it to
 * `outcome_unknown` and NEVER auto-resend (a resend on ambiguity is a duplicate external effect §3).
 *
 * VALUES-FREE by construction: the row carries only the identity (a sha256 `action_key`, never a payload),
 * a status, an attempt count, and a BOUNDED, REDACTED reason CLASS in `last_error` — never a raw response
 * body, a URL, or a token.
 *
 * V7/V8/V9 scope (§9): this v1 slice writes intent/outcome INLINE in the dispatch path (not a background
 * re-lease worker), so it introduces NO new lease surface — the zombie-fence (V7), poison-terminal (V8),
 * and class-B storm-leg (V9) obligations remain satisfied by the S6 event_fires lease (#4426) plus the
 * `status='pending'` single-writer outcome guard here. Any FUTURE time-based re-lease of class-B would
 * inherit #4203 Layer-1 fencing.
 */

const NON_BLANK = /[!-~]/
const OUTBOUND_KINDS: ReadonlySet<string> = new Set(['execution', 'test_run'])
/** last_error is a bounded, redacted CLASS string — hard cap so a caller can never smuggle a body in. */
const LAST_ERROR_MAX = 200

export type OutboundIntentKind = 'execution' | 'test_run'
export type OutboundIntentStatus = 'pending' | 'sent' | 'failed' | 'outcome_unknown'
export type OutboundOutcome = 'sent' | 'failed' | 'outcome_unknown'
export type OutboundClaimDecision = 'proceed' | 'skip_sent' | 'skip_unknown' | 'retry_failed'

export interface OutboundIntentIdentity {
  kind: OutboundIntentKind
  /** kind='execution': the execution lineage root; kind='test_run': the §6.1 server-derived scoped root. */
  rootExecutionId: string
  /** the §2.1 triple identity — produce with deriveActionKey (injective JSON-array encoding). */
  actionKey: string
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
}

/**
 * Tx A — record intent (its own committed transaction, BEFORE the network call). INSERT a fresh `pending`
 * row; ON CONFLICT DO NOTHING. The decision governs whether the caller performs the send:
 *
 *   - fresh insert (rowCount 1) → 'proceed' — we own a fresh `pending`; attempt the send.
 *   - row already exists (rowCount 0) → consult its status:
 *       'sent'            → 'skip_sent'    — already delivered; do NOT resend.
 *       'outcome_unknown' → 'skip_unknown' — §3 TERMINAL; NEVER auto-resend.
 *       'pending'         → a prior attempt committed intent then CRASHED before recording an outcome ⇒ the
 *                           send MAY have happened ⇒ FAIL CLOSED: flip pending→outcome_unknown (guarded
 *                           `AND status='pending'`) and return 'skip_unknown' — never a second send.
 *       'failed'          → prior attempt was DEFINITE pre-dispatch non-delivery (nothing ever sent) ⇒
 *                           eligible to re-attempt: flip failed→pending (attempts+1) and return
 *                           'retry_failed' (caller attempts the send).
 *       (absent/other)    → the row vanished between the conflict and the SELECT (concurrent delete) ⇒ fail
 *                           closed to 'skip_unknown'; never send when the state cannot be proven.
 */
export async function claimOutboundIntent(
  query: OutboundQueryFn,
  id: OutboundIntentIdentity,
): Promise<OutboundClaimDecision> {
  assertIdentity(id, 'claimOutboundIntent')
  const inserted = await query(
    `INSERT INTO meta_automation_outbound_intent (kind, root_execution_id, action_key)
     VALUES ($1, $2, $3)
     ON CONFLICT (kind, root_execution_id, action_key) DO NOTHING`,
    [id.kind, id.rootExecutionId, id.actionKey],
  )
  if (Number(inserted.rowCount ?? 0) === 1) return 'proceed'

  const consult = await query(
    `SELECT status FROM meta_automation_outbound_intent
      WHERE kind = $1 AND root_execution_id = $2 AND action_key = $3`,
    [id.kind, id.rootExecutionId, id.actionKey],
  )
  const status = (consult.rows[0] as { status?: string } | undefined)?.status

  if (status === 'sent') return 'skip_sent'
  if (status === 'outcome_unknown') return 'skip_unknown'
  if (status === 'pending') {
    // CRASH-MID-SEND fail-closed flip. Guarded `AND status='pending'` so a racing writer that already
    // terminalized the row does not get clobbered back to unknown. NEVER auto-resend after this.
    await query(
      `UPDATE meta_automation_outbound_intent
          SET status = 'outcome_unknown', updated_at = now()
        WHERE kind = $1 AND root_execution_id = $2 AND action_key = $3 AND status = 'pending'`,
      [id.kind, id.rootExecutionId, id.actionKey],
    )
    return 'skip_unknown'
  }
  if (status === 'failed') {
    // Definite pre-dispatch non-delivery last time (nothing left the client) ⇒ safe to re-attempt.
    await query(
      `UPDATE meta_automation_outbound_intent
          SET status = 'pending', attempts = attempts + 1, updated_at = now()
        WHERE kind = $1 AND root_execution_id = $2 AND action_key = $3 AND status = 'failed'`,
      [id.kind, id.rootExecutionId, id.actionKey],
    )
    return 'retry_failed'
  }
  // Row vanished (swept/deleted concurrently) — cannot prove non-delivery, so never send.
  return 'skip_unknown'
}

/**
 * Tx B — record outcome (a SECOND, separate commit AFTER the attempt). The `AND status='pending'` guard is
 * the SINGLE-WRITER guard: a concurrent zombie that already terminalized the row writes 0 rows, so the
 * terminal outcome is written exactly once. `lastError` is bounded + stored as-is: callers pass a REDACTED
 * reason CLASS (see {@link outboundReasonClass}), never a raw body/URL/token; the bound is defense-in-depth.
 */
export async function recordOutboundOutcome(
  query: OutboundQueryFn,
  id: OutboundIntentIdentity,
  outcome: OutboundOutcome,
  lastError?: string | null,
): Promise<void> {
  assertIdentity(id, 'recordOutboundOutcome')
  if (outcome !== 'sent' && outcome !== 'failed' && outcome !== 'outcome_unknown') {
    throw new RangeError(`recordOutboundOutcome: outcome must be 'sent' | 'failed' | 'outcome_unknown'`)
  }
  const boundedError = lastError == null ? null : String(lastError).slice(0, LAST_ERROR_MAX)
  await query(
    `UPDATE meta_automation_outbound_intent
        SET status = $4, last_error = $5, updated_at = now()
      WHERE kind = $1 AND root_execution_id = $2 AND action_key = $3 AND status = 'pending'`,
    [id.kind, id.rootExecutionId, id.actionKey, outcome, boundedError],
  )
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
