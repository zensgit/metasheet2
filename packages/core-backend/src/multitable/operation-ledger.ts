import { randomUUID } from 'crypto'

import { isWriterFenceEnabled } from './canonical-sheet-fence'

/**
 * W0-1 Lane L6-a — the SEALED OPERATION-ENDPOINT mint protocol.
 *
 * Design authority: `…v37-exact-anchor-trust-design-lock-20260715.md` §1.2 (sealed operation endpoints).
 * Migration: `zzzz20260715210000_create_meta_record_history_operations.ts`. DEFAULT-OFF: minting is gated on
 * `MULTITABLE_ENABLE_WRITER_FENCE` (the same L4 fence flag — an operation id is only causally meaningful once
 * seq is allocated under the canonical fence). With the flag OFF, `mintOperation` returns an INERT ledger
 * (`operationId === null`): no `operation_id` is set on any event, `sealOperation` is a no-op, no endpoint row
 * is written, and behaviour is byte-identical to L4cov.
 *
 * H3 (owner hardening — FAIL-CLOSED schema probe): when the flag is ON but the L6 schema is incomplete (the
 * `operation_id` column / ledger table is absent), `mintOperation` now THROWS `OperationLedgerSchemaError`
 * and rolls the writer transaction back, rather than silently degrading to an inert ledger. Turning the fence
 * ON is a deliberate deploy step that MUST follow the L6 migration (deploy SOP: migrate-then-deploy); a
 * flag-ON writer running against an un-migrated schema is a misconfiguration, and silently minting nothing
 * would let untrusted (endpoint-less) writes flow while the operator believes the trust checkpoint is armed.
 * Fail-closed is the correct posture: no write proceeds until the schema that makes it trustworthy exists.
 *
 * THE PROTOCOL (§1.2, one transaction / one connection, invoked by a writer that already holds the canonical
 * fence — see `fenceWriterEntry`):
 *   1. `const op = await mintOperation(query, sheetId)` — AFTER the fence, mint one server-side operation id.
 *   2. Write each revision/marker THROUGH the history-service helpers, passing `ledger: op`. Each tagged
 *      event carries `operation_id = op.operationId` and its exact `seq` (returned by the INSERT) is fed back
 *      into the ledger via `op.track(seq)`. `batch_id` is NOT touched (finding #1, owner ruling 2026-07-16,
 *      v3.7 lock §10): it keeps the S1 user-action grouping — one commit action may span N transactions
 *      sharing one batchId, so one batch maps to N operations; the two identities are permanently decoupled.
 *   3. `await sealOperation(query, op)` — LAST, before COMMIT: insert the endpoint row with
 *      `endpoint_seq = MAX(tracked seq)` and `event_count = number of tracked events`.
 *   4. COMMIT. An aborted txn exposes neither events nor endpoint (the endpoint is only visible post-commit —
 *      it is the exact externally-visible boundary an in-txn wall-clock sample cannot provide).
 *
 * The DB enforces the invariants (see the migration): a DEFERRABLE-INITIALLY-DEFERRED FK (events written but
 * never sealed fail at COMMIT), an append-after-seal trigger (a later txn cannot append to a sealed
 * operation), and an endpoint-validation trigger (the endpoint's count/max must match the actual events, so a
 * mis-tracked ledger — wrong count or non-max seq — RAISES and rolls the writer back). This module's
 * JS-side accounting is the writer's assertion; the DB is the independent check.
 *
 * EXACT BIGINT (§1.1 / P2-C): seq/endpoint_seq are carried as `bigint`/decimal-string — never Number(),
 * parseInt, unary +, or subtraction. `track` compares with native BigInt; `maxSeq` is emitted as a decimal
 * string bound straight into a `::bigint` parameter.
 */

export type LedgerQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

/**
 * H3 fail-closed: thrown by `mintOperation` when the writer fence flag is ON but the L6-a schema is not
 * deployed (the `operation_id` column / ledger table is absent). It propagates out of the writer's
 * transaction, rolling it back — no write proceeds against a schema that cannot record its sealed endpoint.
 */
export class OperationLedgerSchemaError extends Error {
  readonly sheetId: string
  constructor(sheetId: string) {
    super(
      `sealed-operation schema incomplete (meta_record_revisions.operation_id absent) on sheet ${sheetId}; ` +
        `writer fence is ON — failing closed (deploy the L6-a migration before enabling the fence)`,
    )
    this.name = 'OperationLedgerSchemaError'
    this.sheetId = sheetId
  }
}

/**
 * A per-operation accumulator. Created by `mintOperation`. When `operationId` is null the ledger is INERT
 * (flag off) and every consumer degrades to byte-identical L4cov behaviour. Otherwise it accumulates the
 * exact event count and MAX(seq) across the operation's tagged revisions AND markers, for the seal to write
 * into the endpoint row.
 */
export class OperationLedger {
  readonly sheetId: string
  readonly operationId: string | null
  private _count = 0
  private _maxSeq: bigint | null = null

  constructor(sheetId: string, operationId: string | null) {
    this.sheetId = sheetId
    this.operationId = operationId
  }

  /** True iff this ledger is active (minting operation ids). Convenience for call-site branching. */
  get active(): boolean {
    return this.operationId !== null
  }

  /** Record one tagged event's exact seq (decimal string from the INSERT's RETURNING seq). Exact bigint. */
  track(seq: string): void {
    if (this.operationId === null) return
    const value = BigInt(seq)
    this._count += 1
    if (this._maxSeq === null || value > this._maxSeq) this._maxSeq = value
  }

  /** Exact number of events tagged with this operation id so far. */
  get eventCount(): number {
    return this._count
  }

  /** MAX(seq) as a decimal string, or null when no event has been tracked. Never a Number. */
  get maxSeq(): string | null {
    return this._maxSeq === null ? null : this._maxSeq.toString()
  }
}

// Cached probe for the L6-a `operation_id` column (the whole L6 schema — table, both event columns, FKs, and
// triggers — lands in ONE migration, so this single column's presence implies all of it). Mirrors
// `hasChainSeqColumn` / `hasRecoveryWriterStateColumn`. H3 (owner hardening): a MISSING column no longer means
// "degrade to inert" — a flag-ON writer whose schema is incomplete FAILS CLOSED (`mintOperation` throws).
// Positive-only cache (the column never disappears once present); reset in tests via
// `__resetOperationLedgerColumnProbe`.
let operationIdColumnPresent = false
export function __resetOperationLedgerColumnProbe(): void {
  operationIdColumnPresent = false
}
async function hasOperationIdColumn(query: LedgerQuery): Promise<boolean> {
  if (operationIdColumnPresent) return true
  const res = await query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'meta_record_revisions' AND column_name = 'operation_id'
        AND table_schema = ANY(current_schemas(false)) LIMIT 1`,
  )
  if ((res.rows as unknown[]).length > 0) {
    operationIdColumnPresent = true
    return true
  }
  return false
}

/**
 * Mint one server-side operation id for the current fenced write transaction. MUST be called AFTER the
 * canonical fence is held on this connection (so the seq the tagged events allocate reflects commit order).
 * Returns an INERT ledger (operationId=null) when the L4 fence flag is OFF. When the flag is ON but the L6
 * schema is incomplete, it FAILS CLOSED — throws `OperationLedgerSchemaError`, rolling the writer txn back
 * (H3 owner hardening; see the module docstring). The id is server-generated (`randomUUID`) — never taken
 * from request input.
 */
export async function mintOperation(query: LedgerQuery, sheetId: string): Promise<OperationLedger> {
  if (!isWriterFenceEnabled()) return new OperationLedger(sheetId, null)
  if (!(await hasOperationIdColumn(query))) throw new OperationLedgerSchemaError(sheetId)
  return new OperationLedger(sheetId, randomUUID())
}

/**
 * Insert the operation's endpoint row LAST, sealing it. No-op when the ledger is inert (flag off) OR when the
 * operation tagged ZERO events (a schema-only writer still takes the fence for a coherent schema, but an
 * operation with no record revision/marker is NOT an executable record anchor — §1.2, so no endpoint is
 * written and the FK has nothing to enforce). Returns true iff an endpoint row was inserted.
 *
 * The endpoint-validation trigger independently re-checks `event_count`/`endpoint_seq` against the actual
 * event rows; a mismatch RAISES here and rolls the writer back. Because the endpoint is inserted last, the
 * operation's events are already present (locally visible) for that check.
 */
export async function sealOperation(query: LedgerQuery, ledger: OperationLedger): Promise<boolean> {
  if (ledger.operationId === null) return false
  if (ledger.eventCount === 0) return false
  const maxSeq = ledger.maxSeq
  // eventCount>0 guarantees maxSeq is set; defensive guard keeps the type narrow and never seals a NULL seq.
  if (maxSeq === null) return false
  await query(
    `INSERT INTO meta_record_history_operations (sheet_id, operation_id, endpoint_seq, event_count)
     VALUES ($1, $2::uuid, $3::bigint, $4::int)`,
    [ledger.sheetId, ledger.operationId, maxSeq, ledger.eventCount],
  )
  return true
}

/**
 * H2 (owner hardening) — whole-operation retention. Atomically prunes ONE sealed operation: the DB function
 * `meta_record_history_operations_prune` deletes the operation's events across BOTH event tables AND its
 * endpoint row in ONE statement group, under a transaction-local GUC that the ledger's BEFORE-DELETE reject
 * trigger honours (an ordinary DELETE of an endpoint stays fail-closed — H1). A partial prune is impossible:
 * dropping only the endpoint leaves events referencing a vanished endpoint (the DEFERRABLE FK RAISES at
 * COMMIT); dropping only the events leaves an orphan endpoint. A younger / still-referenced operation is
 * untouched (keyed on the exact operation_id). Call inside the caller's own transaction so the prune commits
 * atomically with any surrounding retention bookkeeping.
 */
export async function pruneSealedOperation(query: LedgerQuery, sheetId: string, operationId: string): Promise<void> {
  await query(`SELECT meta_record_history_operations_prune($1, $2::uuid)`, [sheetId, operationId])
}
