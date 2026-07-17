import { sql, type Kysely } from 'kysely'

/**
 * W0-1 Lane L6-a — the SEALED OPERATION-ENDPOINT LEDGER.
 *
 * Design authority: `…v37-exact-anchor-trust-design-lock-20260715.md` §1.2 (sealed operation endpoints),
 * §0/P2-B (why a mutable `MAX(seq) WHERE batch_id=…` is not a trustworthy anchor), and §9 item 6 (owner
 * ratification bundle: "sealed operation ledger; server-minted, sheet-scoped, one transaction group; exact
 * anchorSeq frozen in signed identity"). PROPOSED design; every runtime consumer of this schema is gated
 * behind `MULTITABLE_ENABLE_WRITER_FENCE` (default OFF — see `operation-ledger.ts`). This migration changes
 * SCHEMA ONLY.
 *
 * THE PROBLEM THIS SOLVES (§0 P2-B, verbatim): a wall-clock `T` (even an in-txn `clock_timestamp()`) is not
 * an exact commit boundary, and a PG sequence value is allocation-order not commit-order. A `seq` in the
 * MIDDLE of a multi-row transaction represents a state that was never externally visible. The SEALED
 * OPERATION ENDPOINT is the exact, externally-visible commit boundary a recovery anchor can trust: it is the
 * endpoint row of ONE committed operation, written LAST, and only visible once the whole operation commits.
 *
 * SCHEMA (contract normative, per §1.2):
 *   meta_record_history_operations(sheet_id, operation_id, endpoint_seq BIGINT, event_count INT, created_at)
 *   PRIMARY KEY (sheet_id, operation_id).  operation_id is server-minted (uuid), sheet-scoped.
 *
 *   Nullable `operation_id` is added to `meta_record_revisions` and `meta_record_version_markers`: legacy
 *   rows have NONE (NULL) and are NEVER trusted as an endpoint (a NULL FK is not enforced — MATCH SIMPLE).
 *
 * DATABASE ENFORCEMENT (required by §1.2 — "not just service comments"):
 *   (1) DEFERRABLE INITIALLY DEFERRED FKs from each event table's operation_id → the endpoint PK, so events
 *       may be written BEFORE the endpoint within one txn, but the FK is enforced at COMMIT — an operation
 *       that writes events but never seals fails the transaction. A NULL operation_id (legacy/flag-off) is
 *       not checked.
 *   (2) an append-after-seal BEFORE-INSERT trigger on both event tables: an event whose operation already
 *       has a VISIBLE endpoint row is refused (a later transaction cannot append to a sealed operation).
 *       Within one txn the endpoint is inserted LAST, so the operation's own events always pass.
 *   (3) an endpoint-validation BEFORE-INSERT trigger on the ledger: the inserted endpoint's `event_count`
 *       must equal the actual number of events carrying that operation_id across BOTH event tables, and its
 *       `endpoint_seq` must equal their exact MAX(seq); any mismatch RAISES and rolls the writer back. This
 *       also enforces endpoint-LAST: an endpoint inserted before its events sees zero (count mismatch).
 *   (4) finding #2 — a BEFORE UPDATE reject trigger on the ledger (`trg_mrho_reject_update`): the sealed
 *       endpoint is write-once (minted last, then only read), so ANY UPDATE unconditionally RAISES — a later
 *       `UPDATE ... SET endpoint_seq=999999` on a sealed row would otherwise silently MOVE an already-frozen
 *       recovery anchor (v3.7 §1.3 takes anchorSeq from "that immutable endpoint row").
 *   (5) H1 (owner hardening) — a BEFORE DELETE reject trigger on the ledger (`trg_mrho_reject_delete`): the
 *       endpoint row is immutable to DELETE as well, NOT just UPDATE. Ordinary DELETE unconditionally RAISES.
 *       The ONE sanctioned exception is the whole-operation retention path (H2, `…_prune` below), which sets
 *       a transaction-local GUC `metasheet.mrho_retention='on'`; the trigger allows a DELETE only while that
 *       GUC is set, so retention can atomically prune a whole sealed operation while every ordinary DELETE
 *       stays fail-closed.
 *
 * WHOLE-OPERATION RETENTION (H2 — owner hardening): `meta_record_history_operations_prune(sheet_id,
 * operation_id)` prunes a whole sealed operation ATOMICALLY — it deletes the operation's events across BOTH
 * event tables AND its endpoint row in ONE transaction, under the retention GUC, so the endpoint's
 * count/max invariant is never left half-satisfied. A partial prune is impossible: dropping only the endpoint
 * leaves the events referencing a vanished endpoint and the DEFERRABLE FK RAISES at COMMIT; dropping only the
 * events leaves an orphan endpoint. A still-referenced / younger operation is untouched (the function is keyed
 * on the exact operation_id).
 *
 * EXACT BIGINT (§1.1 / P2-C): endpoint_seq is BIGINT, compared natively in SQL and kept as a decimal string
 * end-to-end in TS/JSON — never Number()/parseInt/+/-. The validation trigger compares MAX(seq) in-DB
 * (bigint), never via a float round-trip.
 *
 * zzzz-ordering ([[feedback_migration_zzzz_ordering]]): references `meta_record_revisions` /
 * `meta_record_version_markers` (their `seq` column comes from L3's zzzz…160000; `meta_sheets` from
 * zzz…251231) — timestamped 210000 to sort AFTER L5's trust-checkpoint …180000 and the fwb …200000 windows
 * and every prior zzzz migration. Proven on a FRESH-DB full migrate (up/down/replay).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  // ── the endpoint ledger ────────────────────────────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS meta_record_history_operations (
      sheet_id text NOT NULL,
      operation_id uuid NOT NULL,
      endpoint_seq bigint NOT NULL,
      event_count integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_meta_record_history_operations PRIMARY KEY (sheet_id, operation_id),
      CONSTRAINT chk_mrho_endpoint_seq_positive CHECK (endpoint_seq >= 1),
      CONSTRAINT chk_mrho_event_count_positive CHECK (event_count >= 1)
    )
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_record_history_operations_sheet_endpoint
    ON meta_record_history_operations(sheet_id, endpoint_seq)
  `.execute(db)

  // ── nullable operation_id on both event tables (legacy rows keep NULL → outside the trust checkpoint) ─
  await sql`ALTER TABLE meta_record_revisions ADD COLUMN IF NOT EXISTS operation_id uuid`.execute(db)
  await sql`ALTER TABLE meta_record_version_markers ADD COLUMN IF NOT EXISTS operation_id uuid`.execute(db)

  // Partial indexes (most rows are NULL): support the FK check, the append-after-seal trigger lookup, and
  // the seal/resolver COUNT/MAX(seq) scans without bloating the index with legacy NULL rows.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_record_revisions_operation
    ON meta_record_revisions(sheet_id, operation_id) WHERE operation_id IS NOT NULL
  `.execute(db)
  await sql`
    CREATE INDEX IF NOT EXISTS idx_meta_record_version_markers_operation
    ON meta_record_version_markers(sheet_id, operation_id) WHERE operation_id IS NOT NULL
  `.execute(db)

  // ── (1) DEFERRABLE INITIALLY DEFERRED FKs: events → endpoint, enforced at COMMIT ─────────────────────
  // MATCH SIMPLE (default): a row is checked only when ALL referencing columns are non-NULL. sheet_id is
  // always non-NULL, so a NULL operation_id (legacy/flag-off) is NOT enforced; a non-NULL operation_id must
  // resolve to an endpoint by COMMIT. INITIALLY DEFERRED lets the events precede the endpoint in one txn.
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_mrr_operation') THEN
        ALTER TABLE meta_record_revisions
          ADD CONSTRAINT fk_mrr_operation
          FOREIGN KEY (sheet_id, operation_id)
          REFERENCES meta_record_history_operations (sheet_id, operation_id)
          DEFERRABLE INITIALLY DEFERRED;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_mrvm_operation') THEN
        ALTER TABLE meta_record_version_markers
          ADD CONSTRAINT fk_mrvm_operation
          FOREIGN KEY (sheet_id, operation_id)
          REFERENCES meta_record_history_operations (sheet_id, operation_id)
          DEFERRABLE INITIALLY DEFERRED;
      END IF;
    END $$;
  `.execute(db)

  // ── (2) append-after-seal trigger: refuse an event whose operation already has a VISIBLE endpoint ────
  await sql`
    CREATE OR REPLACE FUNCTION meta_record_reject_append_to_sealed_operation()
    RETURNS trigger AS $fn$
    BEGIN
      IF NEW.operation_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM meta_record_history_operations o
        WHERE o.sheet_id = NEW.sheet_id AND o.operation_id = NEW.operation_id
      ) THEN
        RAISE EXCEPTION 'cannot append event to sealed operation % on sheet %', NEW.operation_id, NEW.sheet_id
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql
  `.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_mrr_reject_append_sealed ON meta_record_revisions`.execute(db)
  await sql`
    CREATE TRIGGER trg_mrr_reject_append_sealed
    BEFORE INSERT ON meta_record_revisions
    FOR EACH ROW EXECUTE FUNCTION meta_record_reject_append_to_sealed_operation()
  `.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_mrvm_reject_append_sealed ON meta_record_version_markers`.execute(db)
  await sql`
    CREATE TRIGGER trg_mrvm_reject_append_sealed
    BEFORE INSERT ON meta_record_version_markers
    FOR EACH ROW EXECUTE FUNCTION meta_record_reject_append_to_sealed_operation()
  `.execute(db)

  // ── (3) endpoint-validation trigger: event_count == actual events, endpoint_seq == exact MAX(seq) ────
  // Reads BOTH event tables for (sheet_id, operation_id). Since the endpoint is inserted LAST in the same
  // txn, this sees all of the operation's own (still-uncommitted-but-locally-visible) events. Rejects a
  // wrong count, a non-max endpoint_seq, and (by count=0) an endpoint inserted BEFORE its events.
  await sql`
    CREATE OR REPLACE FUNCTION meta_record_history_operations_validate_endpoint()
    RETURNS trigger AS $fn$
    DECLARE
      actual_count bigint;
      actual_max bigint;
    BEGIN
      SELECT COUNT(*), MAX(seq) INTO actual_count, actual_max
      FROM (
        SELECT seq FROM meta_record_revisions
          WHERE sheet_id = NEW.sheet_id AND operation_id = NEW.operation_id
        UNION ALL
        SELECT seq FROM meta_record_version_markers
          WHERE sheet_id = NEW.sheet_id AND operation_id = NEW.operation_id
      ) e;
      IF actual_count <> NEW.event_count THEN
        RAISE EXCEPTION 'sealed operation % event_count=% does not match % actual events',
          NEW.operation_id, NEW.event_count, actual_count USING ERRCODE = 'check_violation';
      END IF;
      IF actual_max IS DISTINCT FROM NEW.endpoint_seq THEN
        RAISE EXCEPTION 'sealed operation % endpoint_seq=% does not match actual MAX(seq)=%',
          NEW.operation_id, NEW.endpoint_seq, actual_max USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql
  `.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_mrho_validate_endpoint ON meta_record_history_operations`.execute(db)
  await sql`
    CREATE TRIGGER trg_mrho_validate_endpoint
    BEFORE INSERT ON meta_record_history_operations
    FOR EACH ROW EXECUTE FUNCTION meta_record_history_operations_validate_endpoint()
  `.execute(db)

  // ── (4) finding #2: sealed endpoint is immutable to UPDATE (write-once anchor) ───────────────────────
  // The sealed endpoint row is the immutable recovery anchor — v3.7 §1.3 takes anchorSeq from "that immutable
  // endpoint row". The INSERT trigger above validates the seal at mint time, but nothing forbade a later
  // UPDATE, so `UPDATE ... SET endpoint_seq=999999` (or event_count / created_at) on a sealed row would
  // silently MOVE an already-sealed anchor. The endpoint is write-once by design (minted last, then only
  // read), so a blanket UPDATE-reject at the DB level is the correct fail-closed guard.
  await sql`
    CREATE OR REPLACE FUNCTION meta_record_history_operations_reject_update()
    RETURNS trigger AS $fn$
    BEGIN
      RAISE EXCEPTION 'sealed operation endpoint % on sheet % is immutable (UPDATE forbidden)',
        OLD.operation_id, OLD.sheet_id USING ERRCODE = 'check_violation';
    END;
    $fn$ LANGUAGE plpgsql
  `.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_mrho_reject_update ON meta_record_history_operations`.execute(db)
  await sql`
    CREATE TRIGGER trg_mrho_reject_update
    BEFORE UPDATE ON meta_record_history_operations
    FOR EACH ROW EXECUTE FUNCTION meta_record_history_operations_reject_update()
  `.execute(db)

  // ── (5) H1 (owner hardening): sealed endpoint is immutable to DELETE too, EXCEPT the retention path ──
  // An ordinary `DELETE FROM meta_record_history_operations …` unconditionally RAISES — the endpoint row is
  // as immutable to DELETE as it is to UPDATE (dropping it would orphan the operation's events and destroy an
  // already-frozen recovery anchor). The ONE sanctioned exception is the whole-operation retention path (H2),
  // which sets the transaction-local GUC `metasheet.mrho_retention='on'` before deleting; the trigger allows a
  // DELETE only while that GUC reads 'on'. `current_setting(…, true)` is missing-OK (NULL when never set), so
  // an ordinary DELETE (GUC unset ⇒ NULL ⇒ IS DISTINCT FROM 'on') always fails closed.
  await sql`
    CREATE OR REPLACE FUNCTION meta_record_history_operations_reject_delete()
    RETURNS trigger AS $fn$
    BEGIN
      IF current_setting('metasheet.mrho_retention', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'sealed operation endpoint % on sheet % is immutable (DELETE forbidden)',
          OLD.operation_id, OLD.sheet_id USING ERRCODE = 'check_violation';
      END IF;
      RETURN OLD;
    END;
    $fn$ LANGUAGE plpgsql
  `.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_mrho_reject_delete ON meta_record_history_operations`.execute(db)
  await sql`
    CREATE TRIGGER trg_mrho_reject_delete
    BEFORE DELETE ON meta_record_history_operations
    FOR EACH ROW EXECUTE FUNCTION meta_record_history_operations_reject_delete()
  `.execute(db)

  // ── H2 (owner hardening): whole-operation retention — atomic prune of a sealed operation ─────────────
  // Prunes ONE sealed operation ATOMICALLY: deletes the operation's events across BOTH event tables AND its
  // endpoint row in ONE transaction, under the retention GUC that (5)'s DELETE-reject trigger honours. Never a
  // partial prune — dropping only the endpoint leaves events referencing a vanished endpoint (the DEFERRABLE
  // FK RAISES at COMMIT), dropping only the events leaves an orphan endpoint. A younger / still-referenced
  // operation is untouched (keyed on the exact operation_id). The GUC is transaction-local (`set_config(…,
  // true)`) so it never leaks past this call.
  await sql`
    CREATE OR REPLACE FUNCTION meta_record_history_operations_prune(p_sheet_id text, p_operation_id uuid)
    RETURNS void AS $fn$
    BEGIN
      PERFORM set_config('metasheet.mrho_retention', 'on', true);
      DELETE FROM meta_record_revisions
        WHERE sheet_id = p_sheet_id AND operation_id = p_operation_id;
      DELETE FROM meta_record_version_markers
        WHERE sheet_id = p_sheet_id AND operation_id = p_operation_id;
      DELETE FROM meta_record_history_operations
        WHERE sheet_id = p_sheet_id AND operation_id = p_operation_id;
      PERFORM set_config('metasheet.mrho_retention', 'off', true);
    END;
    $fn$ LANGUAGE plpgsql
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION IF EXISTS meta_record_history_operations_prune(text, uuid)`.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_mrho_reject_delete ON meta_record_history_operations`.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_mrho_reject_update ON meta_record_history_operations`.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_mrho_validate_endpoint ON meta_record_history_operations`.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_mrr_reject_append_sealed ON meta_record_revisions`.execute(db)
  await sql`DROP TRIGGER IF EXISTS trg_mrvm_reject_append_sealed ON meta_record_version_markers`.execute(db)
  await sql`DROP FUNCTION IF EXISTS meta_record_history_operations_reject_delete()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS meta_record_history_operations_reject_update()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS meta_record_history_operations_validate_endpoint()`.execute(db)
  await sql`DROP FUNCTION IF EXISTS meta_record_reject_append_to_sealed_operation()`.execute(db)

  await sql`ALTER TABLE meta_record_revisions DROP CONSTRAINT IF EXISTS fk_mrr_operation`.execute(db)
  await sql`ALTER TABLE meta_record_version_markers DROP CONSTRAINT IF EXISTS fk_mrvm_operation`.execute(db)

  await sql`DROP INDEX IF EXISTS idx_meta_record_revisions_operation`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_meta_record_version_markers_operation`.execute(db)

  await sql`ALTER TABLE meta_record_revisions DROP COLUMN IF EXISTS operation_id`.execute(db)
  await sql`ALTER TABLE meta_record_version_markers DROP COLUMN IF EXISTS operation_id`.execute(db)

  await sql`DROP INDEX IF EXISTS idx_meta_record_history_operations_sheet_endpoint`.execute(db)
  await sql`DROP TABLE IF EXISTS meta_record_history_operations`.execute(db)
}
