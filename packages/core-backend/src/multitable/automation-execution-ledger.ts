/**
 * #4196 execution-scoped applied ledger — Class-A same-transaction claim + the §6.1 server-derived
 * test-run scoped root. Foundation slice: the ledger primitives only; the executor wiring that calls
 * them (retry SKIP-vs-apply, real_fire test-run isolation, Class-B intent/outcome states) ships as its
 * own reviewed slices on top.
 *
 *   - `claimExecutionAction(trx, claim)` — §2's claim INSERT, verbatim:
 *     `INSERT INTO meta_automation_action_applied (kind, root_execution_id, action_key) ON CONFLICT DO
 *     NOTHING`. 'claimed' → the caller performs the class-A mutation in the SAME transaction and commits;
 *     'duplicate' → a prior apply holds the claim; the caller ROLLS BACK and reports `already_applied`
 *     (skip — no mutation attempted). Same-transaction is MACHINE-ENFORCED (pg-transaction-guard xid
 *     probe): a pool / autocommit client / forged marker is rejected before the claim, because a claim
 *     that auto-commits apart from its mutation re-opens the exact at-least-once duplicate window §2
 *     dissolves.
 *   - `deriveTestRunScopedRoot({ actorId, ruleId, testRunOperationId })` — §6.1: the caller value is an
 *     INPUT ONLY; the server derives a scoped root deterministic in (actor_id, rule_id, clientOperationId),
 *     so the same tuple dedups (same derived root → same claim) while two different rules/actors carrying
 *     the same clientOperationId land on independent roots. The derived value is prefixed + hashed, so a
 *     client-supplied value can never equal (and thus never address) a real execution's lineage root — and
 *     even a contrived equality is harmless because `kind='test_run'` keeps the keyspace STRUCTURALLY
 *     disjoint from `kind='execution'` inside the UNIQUE claim key.
 *   - `action_key` identity is the shared #4196-C4 triple — use `deriveActionKey` from
 *     automation-action-idempotency.ts (injective JSON-array encoding); this module does not redefine it.
 */
import { createHash } from 'node:crypto'

import { assertInTransaction, type TransactionalQueryable } from './pg-transaction-guard'

export type ExecutionLedgerKind = 'execution' | 'test_run'

/**
 * #4196 Class-A same-transaction claim RUNTIME GATE — default OFF. The executor's Class-A action methods
 * (update/create/delete/lock_record) only claim-then-skip-on-duplicate when this is ON. Off ⇒ every
 * Class-A path is BYTE-IDENTICAL to pre-slice (no claim INSERT, no `assertInTransaction` probe, no skip).
 * Follows the repo flag convention (`env.<NAME> === 'true'`, e.g. isSideDoorDeleteTrashEnabled).
 */
export function isClassAExecutionClaimEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AUTOMATION_CLASSA_CLAIM_ENABLED === 'true'
}

const LEDGER_KINDS: ReadonlySet<string> = new Set<ExecutionLedgerKind>(['execution', 'test_run'])
const NON_BLANK = /[!-~]/
/** §6.1: the clientOperationId is an opaque bounded token — restricted charset, bounded length. */
const CLIENT_OPERATION_ID = /^[A-Za-z0-9_-]{1,128}$/

export interface ExecutionActionClaim {
  kind: ExecutionLedgerKind
  /** kind='execution': the original execution's lineage root; kind='test_run': the §6.1 DERIVED root. */
  rootExecutionId: string
  /** the §2.1 triple identity — produce with deriveActionKey (injective encoding). */
  actionKey: string
  /** optional audit metadata — never part of the claim key (§2.2). */
  actionType?: string | null
}

/**
 * Class-A same-transaction claim (§2). 'claimed' → proceed with the mutation in THIS transaction;
 * 'duplicate' → roll back and report `already_applied`.
 */
export async function claimExecutionAction(
  trx: TransactionalQueryable,
  c: ExecutionActionClaim,
): Promise<'claimed' | 'duplicate'> {
  if (typeof c.kind !== 'string' || !LEDGER_KINDS.has(c.kind)) {
    throw new RangeError(`claimExecutionAction: kind must be 'execution' | 'test_run' (got ${String(c.kind)})`)
  }
  for (const [name, v] of [['rootExecutionId', c.rootExecutionId], ['actionKey', c.actionKey]] as const) {
    if (typeof v !== 'string' || !NON_BLANK.test(v)) {
      throw new RangeError(`claimExecutionAction: ${name} must be non-blank`)
    }
  }
  // The claim must ride the SAME transaction as the class-A mutation — probed against the DB itself.
  await assertInTransaction(trx, 'claimExecutionAction')
  const res = await trx.query(
    `INSERT INTO meta_automation_action_applied (kind, root_execution_id, action_key, action_type)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (kind, root_execution_id, action_key) DO NOTHING`,
    [c.kind, c.rootExecutionId, c.actionKey, c.actionType ?? null],
  )
  return Number(res.rowCount ?? 0) === 1 ? 'claimed' : 'duplicate'
}

export interface TestRunRootInput {
  actorId: string
  ruleId: string
  /** the caller-supplied Idempotency-Key (§6.1) — validated + bounded; an INPUT to the derivation only. */
  testRunOperationId: string
}

/**
 * §6.1 server-side derivation of the test-run scoped root. Deterministic in (actorId, ruleId,
 * testRunOperationId) via an INJECTIVE JSON-array encoding + sha256, prefixed 'trroot_' so the derived
 * value is recognizable and can never equal a raw caller value or a real execution's lineage root format.
 */
export function deriveTestRunScopedRoot(input: TestRunRootInput): string {
  for (const [name, v] of [['actorId', input.actorId], ['ruleId', input.ruleId]] as const) {
    if (typeof v !== 'string' || !NON_BLANK.test(v)) {
      throw new RangeError(`deriveTestRunScopedRoot: ${name} must be non-blank`)
    }
  }
  if (typeof input.testRunOperationId !== 'string' || !CLIENT_OPERATION_ID.test(input.testRunOperationId)) {
    throw new RangeError(
      'deriveTestRunScopedRoot: testRunOperationId must be an opaque token of 1..128 chars from [A-Za-z0-9_-] (it is an Idempotency-Key, not free text)',
    )
  }
  const digest = createHash('sha256')
    .update(JSON.stringify([input.actorId, input.ruleId, input.testRunOperationId]))
    .digest('hex')
    .slice(0, 32)
  return `trroot_${digest}`
}
