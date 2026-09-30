/**
 * Migration: `approval_form_drafts` — P3-3 server-side approval form draft storage
 * (docs contract: reviews/p33-server-draft-contract-20260914.md).
 *
 * ⚠️ DDL, OWNER-GATED: this migration is shipped in a Draft PR and is NOT to be merged / applied
 * to any shared (dev/staging/prod) database. It may only run against an ephemeral CI Postgres
 * container or a throwaway local test database. See the PR body's first paragraph.
 *
 * Moves the approval "fill-in-progress" form draft (today: browser localStorage, one slot per
 * (user, template), `apps/web/src/approvals/formDraft.ts`) to the server so it is cross-device and
 * lists in a drafts inbox. Every semantic of the client module (§1 of the contract) is preserved —
 * this table is a dumb opaque-signature store; the drift-guard comparison itself still happens
 * against the (byte-identical, parity-tested) signature string, wherever it is computed.
 *
 * Design rulings baked into this DDL (each with its stated reason):
 *
 *  - NO `org_id` column (contract §2, reversible - owner may overturn). A draft is pre-submission
 *    (no `instance_id` to derive org from, `approval_comments`'s precedent) and its only anchor,
 *    `approval_templates`, has NEVER carried an org column (four migrations checked). Access
 *    control for this table is by `user_id` ALONE — a draft is private data the author reads back,
 *    not participant/org-scoped data. Adding a column with no verifiable anchor would create a
 *    second, driftable source of truth (the exact `approval_instances.org_id` phase-1 half-
 *    finished shape this repo already knows to avoid). No code path may use org to gate visibility
 *    of this table.
 *
 *  - NO FK to `approval_templates`. Its `id` is `UUID`; `template_id` here is `text` (matches the
 *    localStorage key's string template id and stays FK-free deliberately) — templates ARE
 *    deleted/archived over their lifecycle and a draft must not block that, nor need repair when it
 *    happens. A draft whose template is gone simply becomes unopenable (the FE 404s resolving the
 *    template) — orphaned rows are swept the same way as any other stale draft (TTL sweep below).
 *
 *  - Non-blank CHECKs on `user_id`/`template_id` use `~ '[!-~]'` (matches `approval_attachments`'s
 *    `approval_att_*_nonblank` shape), not `<> ''` (a whitespace-only string would pass `<> ''`).
 *
 *  - `id` is an APP-GENERATED text id (`afd_${randomUUID()}`, minted in
 *    `approval-form-draft-service.ts`), never a DB-default UUID — this repo's id shape is a
 *    per-table choice (`approval_comments` uses `acmt_${randomUUID()}` for the same reason), not a
 *    uniform convention.
 *
 *  - Per-draft payload cap is DEFENSE IN DEPTH: the primary enforcement is the frozen
 *    `APPROVAL_FORM_DRAFT_LIMITS.maxPayloadBytes` constant compared in the SERVICE layer (mirrors
 *    `APPROVAL_ATTACHMENT_LIMITS` + its service-layer comparisons); this CHECK is the second layer,
 *    mirroring `approval_att_size_bounds`. The service threshold is set STRICTLY BELOW this CHECK's
 *    bound (a safety margin) so a request that clears the service layer can never bounce off this
 *    CHECK as an unexpected 500 — see the service module's own comment.
 *
 *  - `signature` gets THE SAME TWO-LAYER TREATMENT as `data` (gate P3-5, added in the same
 *    migration file rather than a second one, since this migration has not been applied anywhere
 *    — see the file's top docblock). It is a second client-controlled string on this endpoint that
 *    had NO bound at all: a frozen `APPROVAL_FORM_DRAFT_SIGNATURE_LIMITS.maxSignatureBytes`
 *    constant in the service layer, backed by `approval_fd_signature_bounds` here (service
 *    threshold strictly below this CHECK's bound, same margin discipline as the payload cap), PLUS
 *    the same non-blank `~ '[!-~]'` shape `user_id`/`template_id` already carry (`approval_fd_*_nonblank`)
 *    for consistency across all three text columns. In practice `signature` is an `id:type|...`
 *    join of field ids/types (`formSchemaSignature`) — normally a few hundred bytes even for a
 *    large form — so 8 KiB is generous headroom, not a tight fit.
 *
 *  - TTL is a frozen constant (`APPROVAL_FORM_DRAFT_TTL_HOURS`) + a periodic SWEEP FUNCTION
 *    (`sweepExpiredApprovalFormDrafts`), mirroring `UNBOUND_ATTACHMENT_TTL_HOURS` +
 *    `sweepUnboundAttachments` — deliberately NOT a DB auto-expiry (no pg_cron / trigger here).
 *    The sweep function is NOT wired into any running timer in this slice (the table itself is not
 *    applied anywhere yet) — wiring it into `MetaSheetServer` boot is an explicit owner follow-up,
 *    flagged in the PR body.
 *
 *  - Per-user ROW-COUNT cap (`APPROVAL_FORM_DRAFT_MAX_ROWS_PER_USER`) has NO PRECEDENT anywhere in
 *    this repo (full-repo search found only time-windowed rate limits, e.g.
 *    `guards/idempotency.ts`'s `maxRequests` per window — never a "keep the newest N rows for this
 *    user" cap). It is enforced by PRUNE-ON-WRITE in the service layer (upsert, then
 *    `DELETE ... WHERE user_id = $1 AND id NOT IN (SELECT id ... ORDER BY saved_at DESC, id DESC
 *    LIMIT N)`) — deliberately NOT "count then reject", which races between the count read and the
 *    insert. Prune-on-write is self-healing: even if some OTHER path ever inserts extra rows
 *    directly, the very next write converges the user back to <= N, and re-running the DELETE
 *    against an already-pruned set is a no-op (idempotent), not a source of failure under
 *    concurrent writers for different templates. This is a NEW mechanism for this repo — flagged
 *    explicitly in the PR body, not represented as an existing convention.
 *
 * Reversible: `down()` mirrors `up()` exactly (drops the index, then the table).
 */
import { sql, type Kysely } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS approval_form_drafts (
      id           text PRIMARY KEY,
      user_id      text NOT NULL
                     CONSTRAINT approval_fd_user_nonblank CHECK (user_id ~ '[!-~]'),
      template_id  text NOT NULL
                     CONSTRAINT approval_fd_template_nonblank CHECK (template_id ~ '[!-~]'),
      signature    text NOT NULL
                     CONSTRAINT approval_fd_signature_nonblank CHECK (signature ~ '[!-~]')
                     CONSTRAINT approval_fd_signature_bounds CHECK (octet_length(signature) <= 8192),
      data         jsonb NOT NULL,
      saved_at     timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT approval_fd_payload_bounds CHECK (octet_length(data::text) <= 262144)
    )
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_approval_form_drafts_user_saved
    ON approval_form_drafts (user_id, saved_at DESC)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_approval_form_drafts_user_saved`.execute(db)
  await sql`DROP TABLE IF EXISTS approval_form_drafts`.execute(db)
}
