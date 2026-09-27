import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceApprovalExemptionForTests

type FlowRow = {
  id: string
  org_id: string
  name: string
  request_type: string
  steps: unknown[]
  is_active: boolean
  created_at: string
}

function flow(partial: Partial<FlowRow> & Pick<FlowRow, 'id' | 'request_type'>): FlowRow {
  return {
    org_id: 'org-1',
    name: partial.id,
    steps: [{ name: 'Lead', approverUserIds: ['lead-1'] }],
    is_active: true,
    created_at: '2026-09-01T00:00:00.000Z',
    ...partial,
  }
}

function fakeDb(rows: FlowRow[]) {
  const queries: string[] = []
  return {
    queries,
    async query(sql: string, params: unknown[] = []) {
      const text = sql.replace(/\s+/g, ' ').trim()
      queries.push(text)
      const orgId = String(params[0] ?? '')
      if (text.includes('id = $2') && text.includes('request_type = $3') && text.includes('is_active = true')) {
        const id = String(params[1])
        const requestType = String(params[2])
        return rows.filter(row =>
          row.org_id === orgId && row.id === id && row.request_type === requestType && row.is_active === true,
        )
      }
      if (text.includes('id = $2') && !text.includes('request_type = $3')) {
        const id = String(params[1])
        return rows.filter(row => row.org_id === orgId && row.id === id)
      }
      if (text.includes('LIMIT 2')) {
        const requestType = String(params[1])
        return rows
          .filter(row => row.org_id === orgId && row.request_type === requestType && row.is_active === true)
          .sort((left, right) => right.created_at.localeCompare(left.created_at))
          .slice(0, 2)
      }
      if (text.includes('LIMIT 1') && text.includes('is_active = true')) {
        const requestType = String(params[1])
        return rows
          .filter(row => row.org_id === orgId && row.request_type === requestType && row.is_active === true)
          .sort((left, right) => right.created_at.localeCompare(left.created_at))
          .slice(0, 1)
      }
      throw new Error(`unexpected sql: ${text}`)
    },
  }
}

describe('attendance approval exemption (#5967)', () => {
  it('skips approval only for leave and overtime when requiresApproval is strictly false', () => {
    expect(helpers.attendanceRequestSkipsApproval('leave', {
      leaveType: { requiresApproval: false },
    })).toBe(true)
    expect(helpers.attendanceRequestSkipsApproval('overtime', {
      overtimeRule: { requiresApproval: false },
    })).toBe(true)

    expect(helpers.attendanceRequestSkipsApproval('leave', {
      leaveType: { requiresApproval: true },
    })).toBe(false)
    expect(helpers.attendanceRequestSkipsApproval('leave', {
      leaveType: {},
    })).toBe(false)
    expect(helpers.attendanceRequestSkipsApproval('leave', {})).toBe(false)
    expect(helpers.attendanceRequestSkipsApproval('overtime', {
      overtimeRule: { requiresApproval: true },
    })).toBe(false)
    expect(helpers.attendanceRequestSkipsApproval('leave', {
      leaveType: { requiresApproval: 'false' },
    })).toBe(false)
    expect(helpers.attendanceRequestSkipsApproval('overtime', {
      overtimeRule: { requiresApproval: 0 },
    })).toBe(false)

    for (const requestType of ['missed_check_in', 'missed_check_out', 'time_correction']) {
      expect(helpers.attendanceRequestSkipsApproval(requestType, {
        leaveType: { requiresApproval: false },
        overtimeRule: { requiresApproval: false },
      })).toBe(false)
    }
  })

  it('returns null when no active flow exists so the admin queue fallback can stay', async () => {
    const db = fakeDb([])
    await expect(helpers.resolveGenericApprovalFlow(db, 'org-1', {
      requestType: 'leave',
      flowId: null,
    })).resolves.toBeNull()
  })

  it('uses the single active flow when approvalFlowId is omitted', async () => {
    const only = flow({ id: 'flow-1', request_type: 'leave', name: 'Only' })
    const db = fakeDb([only])
    const selected = await helpers.resolveGenericApprovalFlow(db, 'org-1', {
      requestType: 'leave',
      flowId: null,
    })
    expect(selected).toMatchObject({ id: 'flow-1', requestType: 'leave', isActive: true })
    expect(db.queries.some((sql: string) => sql.includes('LIMIT 1') && !sql.includes('id = $2'))).toBe(false)
  })

  it('rejects two active flows instead of taking the newest', async () => {
    const db = fakeDb([
      flow({ id: 'older', request_type: 'overtime', created_at: '2026-01-01T00:00:00.000Z' }),
      flow({ id: 'newer', request_type: 'overtime', created_at: '2026-09-01T00:00:00.000Z' }),
    ])
    await expect(helpers.resolveGenericApprovalFlow(db, 'org-1', {
      requestType: 'overtime',
      flowId: null,
    })).rejects.toMatchObject({
      status: 422,
      code: helpers.ATTENDANCE_APPROVAL_FLOW_REQUIRED,
    })
  })

  it('rejects an explicit flow that is inactive or a different request type', async () => {
    const db = fakeDb([
      flow({ id: 'inactive', request_type: 'leave', is_active: false }),
      flow({ id: 'other-type', request_type: 'overtime' }),
      flow({ id: 'good', request_type: 'missed_check_in' }),
    ])
    await expect(helpers.resolveGenericApprovalFlow(db, 'org-1', {
      requestType: 'leave',
      flowId: 'inactive',
    })).rejects.toMatchObject({ status: 422, code: helpers.ATTENDANCE_APPROVAL_FLOW_REQUIRED })
    await expect(helpers.resolveGenericApprovalFlow(db, 'org-1', {
      requestType: 'leave',
      flowId: 'other-type',
    })).rejects.toMatchObject({ status: 422, code: helpers.ATTENDANCE_APPROVAL_FLOW_REQUIRED })
    await expect(helpers.loadApprovalFlow(db, 'org-1', {
      requestType: 'leave',
      flowId: 'inactive',
    })).resolves.toBeNull()
  })

  it('accepts an explicit active flow even when another flow of the same type is enabled', async () => {
    const db = fakeDb([
      flow({ id: 'a', request_type: 'time_correction', created_at: '2026-01-01T00:00:00.000Z' }),
      flow({ id: 'b', request_type: 'time_correction', created_at: '2026-09-01T00:00:00.000Z' }),
    ])
    const selected = await helpers.resolveGenericApprovalFlow(db, 'org-1', {
      requestType: 'time_correction',
      flowId: 'a',
    })
    expect(selected).toMatchObject({ id: 'a', requestType: 'time_correction' })
  })

  it('keeps id-only lookup able to read an inactive flow', async () => {
    const db = fakeDb([
      flow({ id: 'inactive', request_type: 'outdoor_punch', is_active: false }),
    ])
    const loaded = await helpers.loadApprovalFlow(db, 'org-1', { flowId: 'inactive' })
    expect(loaded).toMatchObject({
      id: 'inactive',
      requestType: 'outdoor_punch',
      isActive: false,
    })
  })
})
