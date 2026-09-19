/**
 * P3-3 — `approval_form_drafts` service: server-side approval form draft storage
 * (docs contract: reviews/p33-server-draft-contract-20260914.md).
 *
 * WHAT MOVED, WHAT DIDN'T: `apps/web/src/approvals/formDraft.ts` is a pure client module keyed on
 * an injected `Storage`-shaped object (today `window.localStorage`). This service is its
 * server-side counterpart — same `{signature, savedAt, data}` shape, same "one (user, template)
 * slot" semantic, same drift-guard-by-signature model. What moved is WHERE the bytes live (a DB
 * row instead of a browser origin), which is what makes the draft cross-device and listable in an
 * inbox. The drift-guard COMPARISON itself (strict-equal on `signature`) still happens wherever the
 * caller has the current schema; this module additionally carries its own byte-identical
 * `formSchemaSignature` reimplementation (parity proven live against the FE function in
 * tests/unit/approval-form-draft-signature-web-parity.test.ts) for server-side uses that don't have
 * the FE schema object handy (e.g. a future drafts-inbox staleness badge) — it is NOT required to
 * be on the client's request path, which still sends its own already-computed signature verbatim.
 *
 * ACCESS CONTROL IS `user_id` ONLY (contract §2). Every exported function here takes a `userId`
 * and every query is scoped `WHERE user_id = $1`. There is no `orgId`/`tenantId` parameter on any
 * function in this file and no query here ever references an org column — deliberately: org must
 * never participate in this table's visibility (see the migration's docblock for the full
 * reasoning). Do not add one "for safety" — that is precisely the anti-pattern §2 rules out.
 *
 * EMPTINESS ("no meaningful value ⇒ delete, not write") IS THE CLIENT'S JOB, NOT REIMPLEMENTED
 * HERE. `formDraft.ts`'s `saveFormDraft` already computes "meaningful" once; giving the server a
 * second copy of that predicate would be a second parity surface with no test proving it agrees
 * with the client's (the "single definition doesn't make a narrow predicate correct" trap runs the
 * other way here: TWO definitions that silently diverge is strictly worse). The client-facing
 * wrapper (`apps/web/src/approvals/serverFormDraft.ts`) decides PUT-if-meaningful vs.
 * DELETE-if-empty and this service just stores or removes whatever it is told to.
 *
 * QUOTAS:
 *   - `APPROVAL_FORM_DRAFT_LIMITS.maxPayloadBytes` mirrors `APPROVAL_ATTACHMENT_LIMITS`'s shape
 *     (frozen constant + service comparison) AND is backed by the DB CHECK
 *     `approval_fd_payload_bounds` in the migration (defense in depth). This service's own
 *     rejection threshold (`maxServicePayloadBytes`) is set STRICTLY BELOW the DB CHECK's bound —
 *     `octet_length(jsonb::text)` (Postgres's re-serialization) is not byte-identical to
 *     `Buffer.byteLength(JSON.stringify(data))` (this process's serialization) for all inputs, so a
 *     request that clears this service's check must never be able to bounce off the DB CHECK as an
 *     unexpected 500 (which would also collide with the "never throw to the user" requirement).
 *   - `APPROVAL_FORM_DRAFT_SIGNATURE_LIMITS.maxSignatureBytes` (FIX 5, gate P3-5): `signature` is a
 *     SECOND client-controlled string on this endpoint that carried no bound at all before this fix
 *     — same two-layer shape and margin discipline as the payload cap immediately above, backed by
 *     the DB CHECK `approval_fd_signature_bounds` and the non-blank `approval_fd_signature_nonblank`
 *     (matching `user_id`/`template_id`'s shape, for consistency across all three text columns).
 *   - `APPROVAL_FORM_DRAFT_TTL_HOURS` + `sweepExpiredApprovalFormDrafts` mirror
 *     `UNBOUND_ATTACHMENT_TTL_HOURS` + `sweepUnboundAttachments`'s constant+sweep-function shape —
 *     NOT a DB auto-expiry. The sweep is exported but NOT wired into any timer in this slice.
 *   - `APPROVAL_FORM_DRAFT_MAX_ROWS_PER_USER` — NO PRECEDENT in this repo (see the migration's
 *     docblock for the negative-claim evidence). Enforced by PRUNE-ON-WRITE (`pruneDraftsForUser`,
 *     called unconditionally at the end of every successful save): upsert first, then delete every
 *     row for that user beyond the newest N by `(saved_at DESC, id DESC)`.
 *     FIX 6 (gate P3-1) — CORRECTED CLAIM: this file previously claimed the cap was "race-free by
 *     CONVERGENCE, not by locking out concurrent writers," reasoning that two concurrent saves for
 *     DIFFERENT templates by the same user would each compute an overlapping "newest N" and both
 *     issue a (idempotent, no-op-safe) prune DELETE, converging on the same <= N set. That claim
 *     was measured FALSE at the "commits" granularity: under constructed concurrency (two
 *     different-template saves by the same user, 25 rounds, then 40 four-way rounds) the gate
 *     measured the row count stabilize at N+1 = 21, not <= N — READ COMMITTED means a concurrent
 *     writer's prune snapshot cannot see the OTHER transaction's not-yet-committed new row, so each
 *     one deletes down to what IT believes is the newest N, and the two newest rows across both
 *     transactions can both survive.
 *     THE FIX: the advisory lock below is now keyed by USER ONLY (previously (user, template)) —
 *     see its own comment for the full reasoning. This makes ALL of one user's saves (any
 *     template) serialize against each other and against that user's own prune, so the
 *     upsert-then-prune sequence for a given user can never interleave with another save by that
 *     SAME user. The claim this file now makes is stronger and TRUE by construction (locking, not
 *     convergence): the row count for a given user is <= N immediately after every one of that
 *     user's saves COMMITS, full stop — re-measured under the SAME concurrency construction (see
 *     the interleaving/concurrency section of approval-form-drafts.db.test.ts) with 0 rows over N
 *     observed. "Count then reject" is still not used (a classic TOCTOU race between the count
 *     read and the insert) — prune-on-write remains self-healing against rows inserted by some
 *     OTHER path directly, because the very next write (now itself serialized per-user) re-runs
 *     the same DELETE against a fully committed view of that user's rows.
 *
 *   FIX (gate2 P3-D) — `clearApprovalFormDraft` NOW ALSO takes this same user-scoped advisory lock
 *     (see its own comment for the full race and the exact window this closes: a clear that used to
 *     be able to commit as a no-op WHILE a save's transaction was between its existence-SELECT and
 *     its INSERT, letting that save's INSERT resurrect the draft moments after the user asked to
 *     remove it). Honest residual (documented in the PR body, not closed here — it needs a
 *     monotonic marker that survives row deletion, which is DDL): a clear that runs to completion
 *     entirely BEFORE a save's transaction even begins is unaffected by this lock — that save will
 *     still create a fresh row, because from the lock's point of view the two transactions never
 *     overlapped at all.
 */
import { randomUUID } from 'crypto'
import { transaction as runInTransaction } from '../db/pg'
import type { Queryable } from '../multitable/automation-durable-dispatcher'

// ------------------------------------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------------------------------------

/** SHAPE mirrors `APPROVAL_ATTACHMENT_LIMITS`; the NUMBERS are reversible implementation judgement
 *  (not ratified) — see the migration's docblock. `maxServicePayloadBytes` is the enforced
 *  service-layer threshold; `maxPayloadBytes` documents the DB CHECK's own bound for reference
 *  (the CHECK is the literal `262144` baked into the migration — keep these in sync by hand if
 *  either changes, there is no shared source at the SQL layer). */
export const APPROVAL_FORM_DRAFT_LIMITS = Object.freeze({
  maxPayloadBytes: 262144, // 256 KiB — matches migration CHECK approval_fd_payload_bounds
  maxServicePayloadBytes: 258048, // 256 KiB - 4 KiB safety margin, strictly below the DB CHECK
})

/** FIX 5 (gate P3-5): `signature` had NO bound at all — not even the non-blank shape `user_id`/
 *  `template_id` carry. Same two-layer shape as `APPROVAL_FORM_DRAFT_LIMITS`: `maxSignatureBytes`
 *  documents the DB CHECK's own bound (`approval_fd_signature_bounds`, literal `8192` baked into
 *  the migration); `maxServiceSignatureBytes` is the enforced service-layer threshold, set
 *  STRICTLY BELOW it for the same reason (`octet_length` re-serialization is not guaranteed
 *  byte-identical across the two layers) — see the payload cap's own comment above. In practice a
 *  signature is an `id:type|...` join of field ids/types (`formSchemaSignature`) — normally a few
 *  hundred bytes even for a large form, so 8 KiB is headroom, not a tight fit. */
export const APPROVAL_FORM_DRAFT_SIGNATURE_LIMITS = Object.freeze({
  maxSignatureBytes: 8192, // 8 KiB — matches migration CHECK approval_fd_signature_bounds
  maxServiceSignatureBytes: 8064, // 8 KiB - 128 byte safety margin, strictly below the DB CHECK
})

/** Reversible implementation judgement (not ratified) — mirrors `UNBOUND_ATTACHMENT_TTL_HOURS`'s
 *  constant+sweep-function shape. 30 days: long enough that switching devices/days does not lose a
 *  draft, short enough that abandoned drafts do not accumulate forever. */
export const APPROVAL_FORM_DRAFT_TTL_HOURS = 720

/** NEW mechanism, no repo precedent (see migration docblock). Reversible implementation judgement. */
export const APPROVAL_FORM_DRAFT_MAX_ROWS_PER_USER = 20

// ------------------------------------------------------------------------------------------------
// Errors
// ------------------------------------------------------------------------------------------------

export class ApprovalFormDraftValidationError extends Error {
  readonly code = 'VALIDATION_ERROR'
  constructor(message: string) {
    super(message)
    this.name = 'ApprovalFormDraftValidationError'
  }
}

export class ApprovalFormDraftTooLargeError extends Error {
  readonly code = 'APPROVAL_FORM_DRAFT_TOO_LARGE'
  constructor() {
    super('Draft payload too large')
    this.name = 'ApprovalFormDraftTooLargeError'
  }
}

/** FIX 4 (gate P2-4): thrown when the upsert's UPDATE branch's row disappears between the
 *  existence SELECT and the UPDATE itself (e.g. a same-user `clearApprovalFormDraft` racing this
 *  save — that endpoint deliberately takes NO advisory lock, see the service's own comment on
 *  `clearApprovalFormDraft`). The route maps this to 409: a clean, deliberate conflict instead of
 *  `toView(undefined)`'s `TypeError`. Re-inserting instead would silently resurrect the very draft
 *  a concurrent clear just removed — see the save function's own comment for why that is rejected. */
export class ApprovalFormDraftConflictError extends Error {
  readonly code = 'APPROVAL_FORM_DRAFT_CONFLICT'
  constructor() {
    super('Draft was concurrently cleared')
    this.name = 'ApprovalFormDraftConflictError'
  }
}

// ------------------------------------------------------------------------------------------------
// Server-side schema-drift signature — BYTE-IDENTICAL reimplementation of
// apps/web/src/approvals/formDraft.ts's `formSchemaSignature` (parity proven live in
// tests/unit/approval-form-draft-signature-web-parity.test.ts, which imports the REAL client
// function across the package boundary rather than re-deriving an "expected" value here).
// ------------------------------------------------------------------------------------------------

export interface ApprovalFormDraftFieldLike {
  id: string
  type: string
  props?: Record<string, unknown>
}

export interface ApprovalFormSchemaLike {
  fields?: ApprovalFormDraftFieldLike[]
}

/** Field ids + types, order-independent; attachment fields excluded; record-link pins
 *  baseId:sheetId. MUST stay byte-identical to the client's algorithm — see the parity test. */
export function formSchemaSignature(schema: ApprovalFormSchemaLike): string {
  return (schema.fields ?? [])
    .filter((field) => field.type !== 'attachment')
    .map((field) => {
      if (field.type === 'record-link') {
        const baseId = typeof field.props?.baseId === 'string' ? (field.props.baseId as string).trim() : ''
        const sheetId = typeof field.props?.sheetId === 'string' ? (field.props.sheetId as string).trim() : ''
        return `${field.id}:record-link:${baseId}:${sheetId}`
      }
      return `${field.id}:${field.type}`
    })
    .sort()
    .join('|')
}

// ------------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------------

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && /[!-~]/.test(value)
}

/** FIX (gate2 P3-D): single source for the user-scoped advisory lock key, used by BOTH
 *  `saveApprovalFormDraft` and `clearApprovalFormDraft` so the two paths cannot silently drift onto
 *  different keys — two different literal strings would defeat the entire point of "the same lock"
 *  (see `clearApprovalFormDraft`'s own comment for why it now takes this lock too). */
function draftLockKey(userId: string): string {
  return `approval_form_draft:${userId}`
}

function assertIdentity(userId: string, templateId: string): void {
  if (!isNonBlank(userId) || !isNonBlank(templateId)) {
    throw new ApprovalFormDraftValidationError('userId and templateId are required')
  }
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

// ------------------------------------------------------------------------------------------------
// DTO
// ------------------------------------------------------------------------------------------------

export interface ApprovalFormDraftView {
  templateId: string
  signature: string
  data: Record<string, unknown>
  savedAt: string
}

interface ApprovalFormDraftRow {
  id: string
  template_id: string
  signature: string
  data: unknown
  saved_at: unknown
}

function toView(row: ApprovalFormDraftRow): ApprovalFormDraftView {
  return {
    templateId: row.template_id,
    signature: row.signature,
    data: (row.data ?? {}) as Record<string, unknown>,
    savedAt: toIso(row.saved_at),
  }
}

// ------------------------------------------------------------------------------------------------
// Reads — user_id-scoped ONLY. No orgId parameter; no org column referenced anywhere below.
// ------------------------------------------------------------------------------------------------

export async function loadApprovalFormDraft(
  db: Queryable,
  userId: string,
  templateId: string,
): Promise<ApprovalFormDraftView | null> {
  if (!isNonBlank(userId) || !isNonBlank(templateId)) return null
  const res = await db.query(
    `SELECT id, template_id, signature, data, saved_at
       FROM approval_form_drafts
      WHERE user_id = $1 AND template_id = $2`,
    [userId, templateId],
  )
  const row = res.rows[0] as unknown as ApprovalFormDraftRow | undefined
  return row ? toView(row) : null
}

export async function listApprovalFormDrafts(db: Queryable, userId: string): Promise<ApprovalFormDraftView[]> {
  if (!isNonBlank(userId)) return []
  const res = await db.query(
    `SELECT id, template_id, signature, data, saved_at
       FROM approval_form_drafts
      WHERE user_id = $1
      ORDER BY saved_at DESC, id DESC`,
    [userId],
  )
  return (res.rows as unknown as ApprovalFormDraftRow[]).map(toView)
}

// ------------------------------------------------------------------------------------------------
// Write — upsert under a USER-SCOPED advisory lock (FIX 6: widened from (user, template) — see the
// lock's own comment) so ALL of one user's saves serialize against each other and against that
// user's own prune, resolving upserts to one row per (user, template) AND making the row-cap
// correct by locking rather than by convergence; see the file header for the corrected claim.
// ------------------------------------------------------------------------------------------------

export interface SaveApprovalFormDraftInput {
  userId: string
  templateId: string
  signature: string
  data: Record<string, unknown>
}

export async function saveApprovalFormDraft(input: SaveApprovalFormDraftInput): Promise<ApprovalFormDraftView> {
  const { userId, templateId, signature, data } = input
  assertIdentity(userId, templateId)
  if (!isNonBlank(signature)) {
    throw new ApprovalFormDraftValidationError('signature is required')
  }
  // FIX 5 (gate P3-5): signature previously had no length ceiling at all — reuse the SAME
  // too-large error the payload check below throws (413), not a new error type, so the route
  // layer needs no change.
  if (Buffer.byteLength(signature, 'utf8') > APPROVAL_FORM_DRAFT_SIGNATURE_LIMITS.maxServiceSignatureBytes) {
    throw new ApprovalFormDraftTooLargeError()
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new ApprovalFormDraftValidationError('data must be a plain object')
  }
  const serialized = JSON.stringify(data)
  if (Buffer.byteLength(serialized, 'utf8') > APPROVAL_FORM_DRAFT_LIMITS.maxServicePayloadBytes) {
    throw new ApprovalFormDraftTooLargeError()
  }

  // FIX 4 (gate P2-4): `toView` now runs INSIDE the transaction and its result is what this
  // function returns — there is no longer any statement after the transaction resolves that could
  // throw. Previously `toView(row)` sat OUTSIDE `runInTransaction`, so a post-commit throw (the
  // `existingId` branch's row having vanished — see below) meant the transaction (prune included)
  // had already COMMITTED by the time the request failed: "the request 500'd" did NOT mean
  // "nothing was written." Returning the view from inside the callback removes that gap: any
  // failure detected before this point now throws BEFORE the transaction's implicit COMMIT
  // (`connection-pool.ts`'s `transaction()` rolls back on a thrown error), so a failed request and
  // an unmodified database now go together again.
  return runInTransaction(async (client) => {
    // FIX 6 (gate P3-1): widened from (user, template) scope to USER scope. Previously two
    // concurrent saves for the SAME (user, template) were serialized against each other, but two
    // concurrent saves for DIFFERENT templates by the SAME user were not serialized against each
    // other's prune — gate measurement: 21 rows surviving with N=20 under concurrency (25 and 40
    // rounds). Locking at user scope means ALL of one user's saves (any template) now serialize,
    // so the prune's "keep the newest N of MY rows" read-then-delete can no longer race against
    // another save by the SAME user — see the file header's updated race-freeness claim.
    // CORRECTED CLAIM (gate2 P3-B): a prior version of this comment argued no NEW lock-ordering
    // cycle is introduced because this is "a single, LEAF advisory lock — nothing else is locked
    // here before or after it" and because a repo-wide grep of `pg_advisory_xact_lock` call sites
    // supposedly shows every one of them is likewise a single standalone lock per transaction. Both
    // are FALSE: this transaction DOES hold the advisory lock while then taking row locks on
    // `approval_form_drafts` (the SELECT/UPDATE/INSERT and the prune DELETE below all run AFTER the
    // lock, inside the same transaction) — "nothing else is locked" was never true, LEAF or not. And
    // the grep claim was refuted by that same grep (`pg_advisory_xact_lock` is a substring of
    // `pg_advisory_xact_lock_shared`, so it also matches the SHARED variant):
    // `attendance/w7-resolver/w7-composite-lock-order.ts`'s composite-lock helper (named there;
    // deliberately NOT repeated here — that module's own inertness sweep treats any mention of
    // its symbols inside a PRODUCTION file as a call site, so citing the name would red that lane)
    // takes two SHARED advisory locks in one transaction in a fixed order (membership timeline, then
    // schedule facts); `multitable/stock-preparation-persist-unit-of-work.ts` takes a project lock
    // and a batch lock (plus, via `acquireCanonicalSheetFencesInOrder`, one per sheet id) in one
    // transaction; `multitable/canonical-sheet-fence.ts`'s `acquireCanonicalSheetFencesInOrder` takes
    // one advisory lock per sheet id, in sorted order, in one transaction.
    // UPDATE (gate2 P3-D fix round): `clearApprovalFormDraft` below NOW ALSO acquires this exact
    // key (via the shared `draftLockKey` helper — one string builder, not two copy-pasted literals,
    // so the two call sites cannot drift onto different keys) — see that function's own comment for
    // why (it closes the "clear lands mid-save-transaction" race). The conclusion (no new deadlock
    // cycle) still holds, but the basis below is updated for that:
    //   1. A deadlock cycle over THIS advisory lock needs two transactions EACH holding something
    //      the OTHER is waiting on. Both call sites that ever acquire this key namespace — save's
    //      lock call above and clear's below — take it as their FIRST statement, before any row
    //      operation on `approval_form_drafts`, and neither acquires any OTHER lock (advisory or
    //      otherwise) at any point in its transaction. So the only thing either transaction can ever
    //      be waiting on is this ONE key, held by the other — that is ordinary serialization (one
    //      waits for the other to commit/roll back), not a cycle: a cycle needs a SECOND, differently
    //      -ordered lock for the two transactions to deadlock over, and there isn't one here. Full-
    //      repo grep (not scoped to any one package, `plugins/` included, with a positive control
    //      proving the grep actually reaches every directory searched — `grep -rl
    //      --exclude-dir=.git --exclude-dir=node_modules "pg_advisory_xact_lock" .` returns 163
    //      hits across the tree, so the search is not silently empty):
    //      `grep -rn --exclude-dir=.git --exclude-dir=node_modules "approval_form_draft:" .` returns
    //      exactly 2 hits, both on THIS file: the `draftLockKey` helper's own template string (the
    //      ONLY place this literal exists — both lock-acquiring call sites, here and in
    //      `clearApprovalFormDraft` below, call the helper rather than repeating the literal) and
    //      the comment naming the command — confirming no third code path anywhere reuses this key
    //      namespace.
    //   2. Separately (belt-and-suspenders, not required for #1): the only OTHER writer to this
    //      table is `sweepExpiredApprovalFormDrafts` below, a global TTL sweep across ALL users'
    //      rows (not scoped to a single user, so it cannot meaningfully take a PER-USER lock keyed
    //      this way without defeating its own purpose) — it acquires no advisory lock at all (see
    //      its own comment), so it cannot be a participant in a cycle through this key either way.
    //      This remains a residual (an unlocked bulk writer can still race a save's transaction the
    //      same way `clearApprovalFormDraft` used to — see the PR body's disclosure list); it is not
    //      newly introduced by this fix and is out of scope for it.
    // Narrowing the hash key space from `user:template` to `user` (one fewer distinguishing segment
    // fed into `hashtext()`) is a THROUGHPUT consideration (a hash collision with some unrelated
    // advisory lock elsewhere in the repo would serialize two unrelated critical sections against
    // each other) — it is not a correctness concern.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [draftLockKey(userId)])

    const existing = await client.query(
      `SELECT id FROM approval_form_drafts WHERE user_id = $1 AND template_id = $2`,
      [userId, templateId],
    )
    const existingId = (existing.rows[0] as { id?: string } | undefined)?.id

    let upserted: ApprovalFormDraftRow
    if (existingId) {
      const updateRes = await client.query(
        `UPDATE approval_form_drafts
            SET signature = $1, data = $2::jsonb, saved_at = now()
          WHERE id = $3
        RETURNING id, template_id, signature, data, saved_at`,
        [signature, serialized, existingId],
      )
      const updatedRow = updateRes.rows[0] as unknown as ApprovalFormDraftRow | undefined
      if (!updatedRow) {
        // FIX 4 (gate P2-4): the row existed at the SELECT above but is gone by the time this
        // UPDATE runs. ORIGINALLY this was reachable via `clearApprovalFormDraft` (the DELETE
        // endpoint) racing this same (user, template) slot between this transaction's SELECT and
        // UPDATE — `clearApprovalFormDraft` took no advisory lock at the time. UPDATE (gate2 P3-D
        // fix round): `clearApprovalFormDraft` now takes the SAME user-scoped advisory lock this
        // save transaction is already holding, so it can no longer commit its DELETE while this
        // transaction is mid-flight — that specific interleaving is closed (see
        // `clearApprovalFormDraft`'s own comment). This branch stays reachable via any OTHER
        // unlocked writer racing the same window — currently only `sweepExpiredApprovalFormDrafts`
        // below (a global TTL sweep, deliberately not lock-scoped to one user — see its own comment)
        // — so the 409 handling below remains live code, not dead code; the interleaving test in
        // approval-form-drafts.db.test.ts now constructs it via a direct bypass DELETE standing in
        // for that kind of unlocked writer, since `clearApprovalFormDraft` itself can no longer
        // produce this exact race. Two branches were considered:
        //   - Re-INSERT the row: REJECTED. This is the concurrent-clear scenario. A clear that
        //     legitimately raced (and won) a save must not be undone by that same save silently
        //     falling back to an insert — that would resurrect the exact draft the user just asked
        //     to remove (this is FIX 8's client-side debounce/CLEAR-then-SAVE race, promoted here
        //     from a client-timing hazard to a GUARANTEED server-side outcome any time the timing
        //     lines up — strictly worse, not equivalent).
        //   - Throw a deliberate conflict (409 at the route layer): CHOSEN. The clear already
        //     committed its own deletion; this save simply lost the race and reports that
        //     honestly instead of crashing (`TypeError: Cannot read properties of undefined`) or
        //     silently overwriting the clear's outcome. Thrown HERE, before the prune DELETE runs
        //     and before any RETURNING value is read — `connection-pool.ts`'s `transaction()`
        //     rolls the whole attempt back on a thrown error, so this save contributes NOTHING to
        //     the database (no prune, no partial write) when it loses this race.
        throw new ApprovalFormDraftConflictError()
      }
      upserted = updatedRow
    } else {
      const id = `afd_${randomUUID()}`
      const insertRes = await client.query(
        `INSERT INTO approval_form_drafts (id, user_id, template_id, signature, data)
         VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id, template_id, signature, data, saved_at`,
        [id, userId, templateId, signature, serialized],
      )
      upserted = insertRes.rows[0] as unknown as ApprovalFormDraftRow
    }

    // Prune-on-write: delete every row for this user beyond the newest N. Unconditional (runs on
    // every save, not only when a new row was just inserted) — this is what makes it self-healing
    // against rows created by any OTHER path (e.g. a direct INSERT bypassing this service).
    await client.query(
      `DELETE FROM approval_form_drafts
        WHERE user_id = $1
          AND id NOT IN (
            SELECT id FROM approval_form_drafts
             WHERE user_id = $1
             ORDER BY saved_at DESC, id DESC
             LIMIT $2
          )`,
      [userId, APPROVAL_FORM_DRAFT_MAX_ROWS_PER_USER],
    )

    return toView(upserted)
  })
}

// FIX (gate2 P3-D): this NO LONGER takes a `db: Queryable` parameter — the whole point of this fix
// is that the DELETE must run on the SAME connection, inside the SAME kind of transaction, as the
// advisory lock acquisition immediately below it (an advisory lock acquired via a pool's implicit
// per-statement connection would be released again before the next statement even ran, providing
// no protection at all). `saveApprovalFormDraft` above has the identical shape for the identical
// reason — it does not take a `db` parameter either, always running against the process's one
// connection pool via `runInTransaction`. An unused, silently-ignored `db` parameter would be worse
// than no parameter (see the file's own "single definition doesn't make a narrow predicate
// correct" discipline — the same applies to a parameter nobody consults). The two callers that used
// to pass a pool here (`routes/approval-form-drafts.ts`, this file's own real-DB test) are updated.
//
// WHY THIS NOW TAKES A LOCK AT ALL (gate2 P3-D, CONFIRMED by the gate): before this fix, `clear`
// took no lock and its single-statement DELETE could commit at ANY point relative to a concurrent
// `saveApprovalFormDraft` — including the window BETWEEN that save's existence-SELECT and its
// INSERT (the branch taken when no draft yet exists for this (user, template) — e.g. the user's
// FIRST save for this template, or a save that legitimately raced a PRIOR clear). In that ordering,
// `clear`'s DELETE finds nothing to remove (the row doesn't exist yet), commits as a no-op, and the
// save's INSERT then commits UNHINDERED right after — net effect: the user asked to discard/clear
// and got back exactly the draft they asked to remove, re-created moments later, with no conflict
// signal anywhere (unlike the SELECT-vs-UPDATE window above, this ordering does not even go through
// the 409 branch, because `existingId` was correctly empty at SELECT time — nothing here was ever
// "wrong" from either statement's own point of view; the two operations were each individually
// correct and only their INTERLEAVING was not). This is exactly the "reverse interleaving" gate2
// P3-D disclosed: FIX 4 above only closed the SELECT-vs-UPDATE window (row existed, then vanished);
// this is the SELECT-vs-INSERT window (row never existed yet, then got created after the clear had
// already run to completion).
//
// THE FIX: `clear` now acquires the IDENTICAL advisory lock `saveApprovalFormDraft` takes (same key
// via `draftLockKey`, same "lock first, row op after" order), inside its own transaction. This does
// NOT prevent a clear that starts (and finishes) BEFORE a save's transaction even begins from being
// followed by that save's INSERT — that ordering is a residual, and is the honest one left in the
// PR body (closing it needs a monotonic marker that survives row deletion, which is DDL and out of
// scope here). What it DOES close is the window this comment describes: once a save's transaction
// has already acquired this lock, a concurrent clear for the SAME user cannot even attempt its
// DELETE until that save's transaction has fully committed or rolled back — so if the save's
// existence-SELECT already ran (found nothing) before clear's lock attempt, clear is forced to wait
// until AFTER the save's INSERT has committed, at which point clear's (now finally running) DELETE
// finds the just-created row and removes it. The net observable outcome flips from "clear no-ops,
// then save resurrects" to "save completes, then clear removes it" — the two operations resolve to
// a clean either-order-fully-serialized outcome instead of a lost-update-shaped interleaving.
// (Verified by a constructed interleaving in approval-form-drafts.db.test.ts — see "FIX P3-D".)
export async function clearApprovalFormDraft(userId: string, templateId: string): Promise<void> {
  if (!isNonBlank(userId) || !isNonBlank(templateId)) return
  await runInTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [draftLockKey(userId)])
    await client.query(`DELETE FROM approval_form_drafts WHERE user_id = $1 AND template_id = $2`, [userId, templateId])
  })
}

// ------------------------------------------------------------------------------------------------
// TTL sweep — mirrors `sweepUnboundAttachments`'s constant+sweep-function shape. NOT wired into any
// running timer in this slice (see the migration's docblock: the table itself is not applied
// anywhere yet; wiring a live timer against a table that may not exist would be its own hazard).
// ------------------------------------------------------------------------------------------------

export interface ApprovalFormDraftSweepResult {
  swept: number
}

export async function sweepExpiredApprovalFormDrafts(
  db: Queryable,
  ttlHours: number = APPROVAL_FORM_DRAFT_TTL_HOURS,
): Promise<ApprovalFormDraftSweepResult> {
  if (!Number.isSafeInteger(ttlHours) || ttlHours < 1 || ttlHours > 8760) {
    throw new RangeError(`ttlHours must be a safe integer in [1, 8760] (got ${ttlHours})`)
  }
  const res = await db.query(
    `DELETE FROM approval_form_drafts WHERE saved_at <= now() - ($1::int * interval '1 hour')`,
    [ttlHours],
  )
  return { swept: res.rowCount ?? 0 }
}
