/**
 * Migration: `meta_automation_outbox` + `meta_automation_outbox_consumer` — P2 durable-delivery substrate.
 *
 * FWB-0 design lock (#4203, Layer 1) + approval-line plan (#4239): the automation completion→delivery
 * chain today has two crash-loss windows (commit-then-emit to an in-memory `eventemitter3` bus; a
 * terminal claim-before-execute tombstone). This migration lands the **additive, unused-until-wired**
 * substrate for the durable fix:
 *
 *   - `meta_automation_outbox`         — one row per producer event, written in the SAME transaction as
 *                                        the source state change (approval status write / record write).
 *                                        `manifest_version` stamps the routing manifest that expanded it
 *                                        (a v1 row is dispatched per v1 forever — never re-interpreted).
 *                                        `event_id` is NOT NULL AND non-blank — the stable ORIGINAL-event
 *                                        identity the dispatcher forwards downstream as the per-rule dedup
 *                                        key and the outbound-idempotency seed (#4203 §producer/identity). A
 *                                        CHECK requires a printable-ASCII non-space char (`[!-~]`), so any id
 *                                        the dedup helper (`automation-event-dedup.ts`: `_eventId.trim()`)
 *                                        would collapse to no-identity — empty, ASCII whitespace, OR Unicode
 *                                        whitespace (NBSP/EM/narrow-NBSP/BOM, which PostgreSQL's ASCII-only
 *                                        `[:space:]` misses) — is rejected before it can masquerade as one.
 *                                        It is NOT unique: #4203 §cutover tolerates transient double-emit and
 *                                        dedups at the sink, so a second contract-legal enqueue is allowed.
 *   - `meta_automation_outbox_consumer`— per-(outbox_id, consumer_key) delivery state. `status` is the
 *                                        four-state machine `pending|in_progress|done|dead_letter` — there is
 *                                        NO persistent `failed` state: a transient failure only bumps
 *                                        `attempts` and leaves the row reclaimable (the lease expires → the
 *                                        next claimer reclaims it), and bounded-attempts-exhausted transitions
 *                                        straight to the terminal `dead_letter`. The two terminals `done` and
 *                                        `dead_letter` are exactly the resolve-permitting set (§Layer-1); a
 *                                        row can never get stuck in a non-reclaimable non-terminal state.
 *                                        `fence` is the monotonic epoch bumped on every claim/reclaim (a
 *                                        stale-fence "zombie" write hits 0 rows); `attempts` is incremented AT
 *                                        CLAIM (so an always-crash-after-claim poison still reaches
 *                                        `dead_letter`); `lease_expires_at` is the reclaim lease, and the
 *                                        lease is EXACTLY the in_progress marker — a BICONDITIONAL CHECK ties
 *                                        `lease IS NOT NULL` to `status='in_progress'` in BOTH directions:
 *                                        in_progress ⇒ leased (else unreclaimable), and non-in_progress ⇒
 *                                        NO lease. The reverse half is NOT about the reclaim scan (that scan
 *                                        is status-scoped, so it would never pick up a leftover lease on a
 *                                        settled row) — it keeps a lease meaning EXACTLY "owned by a live
 *                                        in_progress worker", so every terminal/reclaim transition must clear
 *                                        the lease atomically and a settled row can never carry stale
 *                                        ownership. Fence/attempts/depth carry non-negative CHECKs; `event_id`
 *                                        is non-blank (mirrors the dedup helper's `.trim()` → no-identity).
 *
 * NOTHING reads or writes these tables yet — the durable dispatcher (S2), the producer-side atomic enqueue
 * (S4), and the consumer adapters (S5) are separate, flag-gated slices. This migration is byte-for-byte
 * behavior-neutral: no existing table is altered, no code path touches these tables while
 * `AUTOMATION_DURABLE_DELIVERY_ENABLED` is OFF (the default). Additive `CREATE TABLE IF NOT EXISTS` only.
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  // Producer event rows — co-committed with the source state change.
  //   event_id is NOT NULL: it is the stable ORIGINAL-event identity (#4203 §producer/identity contract) the
  //   dispatcher forwards downstream as the per-rule `event_fires` dedup_key and the outbound-idempotency-key
  //   seed. A NULL identity would break cutover-window dedup and outbound idempotency, so it is required.
  //   (Deliberately NOT unique: #4203 §cutover tolerates transient double-emit and dedups at the sink, not
  //   at the outbox — a UNIQUE(event_id) here would reject the second, contract-legal enqueue.)
  await sql`
    CREATE TABLE IF NOT EXISTS meta_automation_outbox (
      id               text PRIMARY KEY,
      event_type       text NOT NULL,
      payload          jsonb NOT NULL,
      automation_depth int  NOT NULL DEFAULT 0
                         CONSTRAINT automation_outbox_depth_nonneg CHECK (automation_depth >= 0),
      manifest_version int  NOT NULL
                         CONSTRAINT automation_outbox_manifest_version_positive CHECK (manifest_version >= 1),
      event_id         text NOT NULL
                         -- reject blank ids: the dedup helper (automation-event-dedup.ts) does _eventId.trim()
                         -- and treats a blank result as NO identity, so a blank id in the outbox is un-dedupable.
                         -- event_id is an ASCII identity by contract, so require at least one PRINTABLE-ASCII
                         -- non-space char: [!-~] = 0x21..0x7E. This is stronger than [^[:space:]] on purpose —
                         -- PostgreSQL's [:space:] is ASCII-only, so [^[:space:]] would ACCEPT an id made solely
                         -- of Unicode whitespace (NBSP U+00A0, EM SPACE U+2003, narrow-NBSP U+202F, BOM U+FEFF),
                         -- all of which JS .trim() strips to '' → no identity. [!-~] rejects those too.
                         -- (A regex, not btrim(); no backslash escapes leak into this template literal.)
                         CONSTRAINT automation_outbox_event_id_nonblank CHECK (event_id ~ '[!-~]'),
      created_at       timestamptz NOT NULL DEFAULT now()
    )
  `.execute(db)
  // Dispatcher polls pending rows oldest-first.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_automation_outbox_created_at
    ON meta_automation_outbox (created_at)
  `.execute(db)

  // Per-(outbox_id, consumer_key) delivery state — the reclaimable lease row (fence-bearing).
  await sql`
    CREATE TABLE IF NOT EXISTS meta_automation_outbox_consumer (
      outbox_id        text NOT NULL REFERENCES meta_automation_outbox(id) ON DELETE CASCADE,
      consumer_key     text NOT NULL,
      status           text NOT NULL DEFAULT 'pending'
                         CONSTRAINT automation_outbox_consumer_status_valid
                         CHECK (status IN ('pending','in_progress','done','dead_letter')),
      lease_expires_at timestamptz,
      fence            bigint NOT NULL DEFAULT 0
                         CONSTRAINT automation_outbox_consumer_fence_nonneg CHECK (fence >= 0),
      attempts         int    NOT NULL DEFAULT 0
                         CONSTRAINT automation_outbox_consumer_attempts_nonneg CHECK (attempts >= 0),
      last_error       text,
      updated_at       timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (outbox_id, consumer_key),
      -- The lease is EXACTLY the in_progress marker — a BICONDITIONAL, not a one-directional guard:
      --   in_progress  => lease present  (else the reclaim scan status=in_progress AND lease < now()
      --                                   could never recover it — a permanently stuck row); AND
      --   NOT in_progress => lease absent. The reason is NOT that the scan would reclaim it — that scan is
      --                                    status-scoped and would never pick up a leftover lease on a
      --                                    pending/done/dead_letter row. It is to keep a lease meaning
      --                                    EXACTLY "owned by a live in_progress worker": every terminal /
      --                                    reclaim transition must clear the lease atomically, so a settled
      --                                    row can never carry stale, ambiguous ownership.
      -- Every state transition (claim/complete/reclaim/poison) sets or clears the lease in the SAME
      -- single-row UPDATE that changes the status, so the biconditional holds at every commit boundary.
      CONSTRAINT automation_outbox_consumer_lease_iff_in_progress
        CHECK ((lease_expires_at IS NOT NULL) = (status = 'in_progress'))
    )
  `.execute(db)
  // Dispatcher claim scan: reclaimable rows are pending, or in_progress past a stale lease.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_automation_outbox_consumer_claim
    ON meta_automation_outbox_consumer (status, lease_expires_at)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS meta_automation_outbox_consumer`.execute(db)
  await sql`DROP TABLE IF EXISTS meta_automation_outbox`.execute(db)
}
