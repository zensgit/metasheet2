/**
 * r6.1 §1.1 P1-1: the port has no "commit, then refuse" channel, and `dispatchAction`'s one branch
 * that does that — persist the node-operation policy refusal, COMMIT, throw 409 — is unreachable in
 * handed-over mode. The argument, pinned here so that it cannot rot silently:
 *
 *  - handed-over mode is for cancel-round instances, whose action gate (`assertCancelRoundActionAllowed`)
 *    lets only the actions in `CANCEL_ROUND_ALLOWED_ACTIONS` through, and runs before the policy check;
 *  - every one of those actions has a null node-operation policy key (`ACTION_POLICY_KEYS`), and the
 *    policy branch runs only for a non-null key;
 *  - should that ever change, the branch refuses before committing when handed over.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import { ACTION_POLICY_KEYS } from '../../src/types/approval-product'

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../../src/services/ApprovalProductService.ts'), 'utf8')

function allowedCancelRoundActions(): string[] {
  const match = SOURCE.match(/const CANCEL_ROUND_ALLOWED_ACTIONS: ReadonlySet<ApprovalActionType> = new Set\(\[([\s\S]*?)\]\)/)
  expect(match).not.toBeNull()
  return [...(match as RegExpMatchArray)[1].matchAll(/'([a-z_]+)'/g)].map((entry) => entry[1])
}

describe('the policy-refusal branch is unreachable in handed-over mode (r6.1 §1.1)', () => {
  it('every action a cancel-round instance accepts has a null node-operation policy key', () => {
    const allowed = allowedCancelRoundActions()
    expect(allowed.sort()).toEqual(['approve', 'comment', 'reject', 'revoke'])
    for (const action of allowed) expect(ACTION_POLICY_KEYS[action as keyof typeof ACTION_POLICY_KEYS]).toBeNull()
  })

  it('in dispatchAction a handed-over dispatch is refused unless the instance is a cancel round; the cancel-round gate runs before the policy check, and the policy branch refuses before committing when handed over', () => {
    const start = SOURCE.indexOf('  async dispatchAction(')
    const end = SOURCE.indexOf('      await rollbackQuietly(client)', start)
    const body = SOURCE.slice(start, end)
    // Handed over, only a cancel-round instance gets past the row lock (Codex S3 §4 B): the refusal
    // comes right after the instance row is read, before the gate and before any write.
    const rowRead = body.indexOf("FOR UPDATE`")
    const cancelRoundOnly = body.indexOf('if (handover && !isCancelRoundInstance(instance)) {')
    expect(rowRead).toBeGreaterThan(-1)
    expect(cancelRoundOnly).toBeGreaterThan(rowRead)
    const gate = body.indexOf('assertCancelRoundActionAllowed(instance, request.action)')
    expect(cancelRoundOnly).toBeLessThan(gate)
    const policyKey = body.indexOf('const nodeOperationPolicyKey: NodeOperationPolicyActionKey | null = ACTION_POLICY_KEYS[request.action]')
    const policyBranch = body.indexOf('if (nodeOperationPolicyKey !== null && currentNodeKey) {')
    const refuse = body.indexOf('if (handover) throw new Error(\'settlement coordination: the node-operation policy refusal is unreachable when handed over\')')
    const refusalCommit = body.indexOf('await commitTransaction()', refuse)
    const conflict = body.indexOf("'APPROVAL_NODE_OPERATION_DISABLED'", refuse)
    for (const offset of [gate, policyKey, policyBranch, refuse, refusalCommit, conflict]) expect(offset).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(policyKey)
    expect(policyKey).toBeLessThan(policyBranch)
    expect(policyBranch).toBeLessThan(refuse)
    expect(refuse).toBeLessThan(refusalCommit)
    expect(refusalCommit).toBeLessThan(conflict)
  })

  it('the 55P03 → 503 mapping holds only when handed over: the default path keeps raising the raw 55P03 (Opus P2-2)', () => {
    const start = SOURCE.indexOf('  async dispatchAction(')
    const catchAt = SOURCE.indexOf('      await rollbackQuietly(client)', start)
    const end = SOURCE.indexOf('    } finally {', catchAt)
    const catchBody = SOURCE.slice(catchAt, end)
    expect(catchBody).toContain("const contendedWhenHandedOver = handover !== undefined && rolloutLock.kind === 'required' && isLockNotAvailableSqlState(error)")
    expect(catchBody).toContain("if ((rolloutLock.kind === 'required' && isRetryableSqlState(error)) || contendedWhenHandedOver) {")
  })
})

