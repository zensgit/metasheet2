import { describe, it, expect, vi } from 'vitest'
import { PlmPersonalApprovalBindingService } from '../../src/services/PlmPersonalApprovalBindingService'
import {
  personalBindingInput,
  personalCommandSchema,
  requirePlmApprovalCard,
} from '../../src/services/plm-personal-approval-wire'
describe('personal PLM purpose contract', () => {
  it('has a persistent explicit binding service', () =>
    expect(PlmPersonalApprovalBindingService).toBeTypeOf('function'))
  it('does not admit an actor, URL or scope supplied in a binding', () => {
    const base = { connectionId: 'fixed', grant: `yua_${'a'.repeat(32)}_${'b'.repeat(43)}` }
    expect(personalBindingInput.safeParse(base).success).toBe(true)
    for (const extra of ['actor', 'subjectId', 'url', 'tenantId', 'orgId'])
      expect(personalBindingInput.safeParse({ ...base, [extra]: 'forged' }).success).toBe(false)
  })
  it('default off and exact true', () => {
    for (const flag of [undefined, 'TRUE', '1', ' true ']) {
      vi.stubEnv('PLM_APPROVAL_CARD_ENABLED', flag)
      expect(() => requirePlmApprovalCard()).toThrow()
    }
    vi.unstubAllEnvs()
  })
  it('requires comment for rejection and all command keys', () => {
    const c = {
      schema: 'yuantus.plm-approval-card-command.v1',
      command_id: '00000000-0000-4000-8000-000000000001',
      connection_id: 'fixed',
      delivery_id: '00000000-0000-4000-8000-000000000002',
      task_id: '00000000-0000-4000-8000-000000000003',
      round_id: '00000000-0000-4000-8000-000000000004',
      decision: 'reject',
      comment: null,
    }
    expect(personalCommandSchema.safeParse(c).success).toBe(false)
    expect(personalCommandSchema.safeParse({ ...c, comment: 'reason' }).success).toBe(true)
  })
})
