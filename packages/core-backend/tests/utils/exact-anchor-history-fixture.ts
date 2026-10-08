import { randomUUID } from 'node:crypto'

import { poolManager } from '../../src/integration/db/connection-pool'
import { activateCheckpoint, type QueryFn } from '../../src/multitable/history-trust-checkpoint'

type RecoveryAction = 'create' | 'update' | 'delete'
type FixturePhase = 'before' | 'anchor' | 'after'

export interface ExactAnchorHistoryFixture {
  readonly sheetId: string
  anchorOperationId(): string
  insertRevision(input: {
    recordId: string
    version: number
    action: RecoveryAction
    snapshot: Record<string, unknown>
    createdAt: string
    phase: FixturePhase
    changedFieldIds?: string[]
  }): Promise<string>
}

const query = (sql: string, params: unknown[] = []) => poolManager.get().query(sql, params)
const transaction = <T>(fn: (run: QueryFn) => Promise<T>): Promise<T> =>
  poolManager.get().transaction(async ({ query: run }) => fn(run as unknown as QueryFn)) as Promise<T>

/**
 * Reserve an exact causal range for a synthetic history fixture. The checkpoint is activated while the
 * sheet is empty, then fixture events are assigned explicit seq values on either side of one sealed anchor.
 * Tests may insert a historical event later in setup while still assigning it to the causal `before` range;
 * insertion order is fixture construction order, while `seq` is the modeled committed order under test.
 */
export async function prepareExactAnchorHistoryFixture(sheetId: string): Promise<ExactAnchorHistoryFixture> {
  await transaction((run) => activateCheckpoint(run, { sheetId }))
  const start = BigInt(String((await query("SELECT nextval('meta_record_chain_seq')::text AS seq")).rows[0].seq))
  const anchorSeq = start + 1000n
  let beforeSeq = start
  let afterSeq = anchorSeq + 1n
  let anchorOperationId: string | null = null

  // Keep production nextval allocations above the entire synthetic range. Execute-path revisions therefore
  // remain causally after every fixture event instead of accidentally re-entering its reserved interval.
  await query("SELECT setval('meta_record_chain_seq', $1::bigint, true)", [String(anchorSeq + 5000n)])

  return {
    sheetId,
    anchorOperationId() {
      if (!anchorOperationId) throw new Error(`exact-anchor fixture missing anchor operation for ${sheetId}`)
      return anchorOperationId
    },
    async insertRevision(input) {
      const seq = input.phase === 'anchor'
        ? anchorSeq
        : input.phase === 'before'
          ? beforeSeq++
          : afterSeq++
      const operationId = randomUUID()
      const batchId = `batch_fixture_${operationId}`
      await transaction(async (run) => {
        await run(
          `INSERT INTO meta_record_revisions
             (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot,
              created_at, seq, operation_id, batch_id)
           VALUES (gen_random_uuid(),$1,$2,$3,$4,'rest',$5::text[],'{}'::jsonb,$6::jsonb,
                   $7,$8::bigint,$9::uuid,$10)`,
          [
            sheetId,
            input.recordId,
            input.version,
            input.action,
            input.changedFieldIds ?? [],
            JSON.stringify(input.snapshot),
            input.createdAt,
            String(seq),
            operationId,
            batchId,
          ],
        )
        await run(
          `INSERT INTO meta_record_history_operations (sheet_id, operation_id, endpoint_seq, event_count)
           VALUES ($1,$2::uuid,$3::bigint,1)`,
          [sheetId, operationId, String(seq)],
        )
      })
      if (input.phase === 'anchor') anchorOperationId = operationId
      return operationId
    },
  }
}

/** Remove sealed endpoints through the only sanctioned whole-operation retention path. */
export async function pruneSealedHistoryOperations(sheetId: string): Promise<void> {
  const operations = (await query(
    'SELECT operation_id::text AS operation_id FROM meta_record_history_operations WHERE sheet_id = $1 ORDER BY endpoint_seq DESC',
    [sheetId],
  )).rows as Array<{ operation_id: string }>
  for (const { operation_id: operationId } of operations) {
    await query('SELECT meta_record_history_operations_prune($1,$2::uuid)', [sheetId, operationId])
  }
}
