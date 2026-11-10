import { afterEach, describe, expect, it } from 'vitest'
import { PlmPersonalApprovalBindingService } from '../../src/services/PlmPersonalApprovalBindingService'

const BINDING_ID = '00000000-0000-4000-8000-000000000001'
const binding = {
  id: BINDING_ID,
  owner_id: 'owner-1',
  connection_id: 'fixed',
  subject_id: '42',
  tenant_id: 'yt',
  org_id: 'org',
  grant_id: 'grant',
  expires_at: new Date(Date.now() + 60_000),
  encrypted_grant: 'enc:present',
  generation: 3,
}

function scripted() {
  const sql: string[] = []
  const query = async (text: string) => {
    sql.push(text)
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 }
    if (text.includes('FROM users')) return { rows: [{ id: 'owner-1' }], rowCount: 1 }
    if (text.includes('FROM plm_personal_approval_bindings') && text.includes('FOR UPDATE')) {
      return { rows: [binding], rowCount: 1 }
    }
    return { rows: [], rowCount: 1 }
  }
  const pool = {
    connect: async () => ({ query, release() {} }),
    query,
  }
  return { sql, pool }
}

describe('personal approval unbind while the card package is off', () => {
  afterEach(() => {
    delete process.env.PLM_APPROVAL_CARD_ENABLED
    delete process.env.PLM_APPROVAL_CARD_CONNECTION_ID
  })

  it('clears the stored grant and withdraws cards without calling the provider', async () => {
    delete process.env.PLM_APPROVAL_CARD_ENABLED
    delete process.env.PLM_APPROVAL_CARD_CONNECTION_ID
    const { sql, pool } = scripted()
    const provider = () => {
      throw new Error('provider must not run')
    }
    const service = new PlmPersonalApprovalBindingService(pool as never, provider as never)
    await service.unbind('owner-1', BINDING_ID)
    expect(sql.some((text) => text.includes('encrypted_grant=NULL'))).toBe(true)
    expect(sql.some((text) => text.includes("card_state='revoked'"))).toBe(true)
    expect(sql.some((text) => text.includes('SET active=false'))).toBe(true)
    expect(sql.some((text) => text.includes('personalApprovalRequest'))).toBe(false)
  })
})
