import { randomUUID } from 'crypto'

import { isWriterFenceEnabled } from './canonical-sheet-fence'

/**
 * W0-1 Lane L6-a — the SEALED OPERATION-ENDPOINT mint protocol.
 *
 * Design authority: `…v37-exact-anchor-trust-design-lock-20260715.md` §1.2 (sealed operation endpoints).
 * Migration: `zzzz20260715190000_create_meta_record_history_operations.ts`. DEFAULT-OFF: minting is gated on
 * `MULTITABLE_ENABLE_WRITER_FENCE` (the same L4 fence flag — an operation id is only causally meaningful once
 * seq is allocated under the canonical fence). With the flag off, `mintOperation` returns an INERT ledger
 * (`operationId === null`): no `operation_id` is set on any event, `sealOperation` is a no-op, no endpoint row
 * is written, and behaviour is byte-identical to L4cov.
 *
 * THE PROTOCOL (§1.2, one transaction / one connection, invoked by a writer that already holds the canonical
 * fence — see `fenceWriterEntry`):
 *   1. `const op = await mintOperation(query, sheetId)` — AFTER the fence, mint one server-side operation id.
 *   2. Write each revision/marker THROUGH the history-service helpers, passing `ledger: op`. Each tagged
 *      event carries `operation_id = op.operationId` and its exact `seq` (returned by the INSERT) is fed back
 *      into the ledger via `op.track(seq)`; the helper also aligns `batch_id = op.operationId` so a trusted
 *      write satisfies the design's "batch_id == operation_id" invariant.
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
 * A per-operation accumulator. Created by `mintOperation`. When `operationId` is null the ledger is INERT
 * (flag off, or the L6 migration is not yet deployed) and every consumer degrades to byte-identical L4cov
 * behaviour. Otherwise it accumulates the exact event count and MAX(seq) across the operation's tagged
 * revisions AND markers, for the seal to write into the endpoint row.
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
// `hasChainSeqColumn` / `hasRecoveryWriterStateColumn`: a missing column ⇒ the migration is not deployed ⇒
// mint returns an inert ledger, so a flag-ON deploy that predates the migration degrades to byte-identical
// L4cov behaviour instead of 42703-poisoning the writer txn. Positive-only cache (the column never
// disappears once present); reset in tests via `__resetOperationLedgerColumnProbe`.
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
 * Returns an INERT ledger (operationId=null) when the L4 fence flag is off OR the L6 migration is not yet
 * deployed. The id is server-generated (`randomUUID`) — never taken from request input.
 */
export async function mintOperation(query: LedgerQuery, sheetId: string): Promise<OperationLedger> {
  if (!isWriterFenceEnabled()) return new OperationLedger(sheetId, null)
  if (!(await hasOperationIdColumn(query))) return new OperationLedger(sheetId, null)
  return new OperationLedger(sheetId, randomUUID())
}

/**
 * Insert the operation's endpoint row LAST, sealing it. No-op when the ledger is inert (flag off / migration
 * absent) OR when the operation tagged ZERO events (a schema-only writer still takes the fence for a coherent
 * schema, but an operation with no record revision/marker is NOT an executable record anchor — §1.2, so no
 * endpoint is written and the FK has nothing to enforce). Returns true iff an endpoint row was inserted.
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
