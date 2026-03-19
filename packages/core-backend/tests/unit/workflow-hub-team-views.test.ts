import { describe, expect, it } from 'vitest'
import {
  buildWorkflowHubTeamViewValues,
  mapWorkflowHubTeamViewRow,
  normalizeWorkflowHubTeamViewState,
} from '../../src/workflow/workflowHubTeamViews'

describe('workflowHubTeamViews helpers', () => {
  it('normalizes route state defensively', () => {
    expect(normalizeWorkflowHubTeamViewState({
      workflowSearch: '审批',
      workflowStatus: 'draft',
      workflowSortBy: 'name',
      workflowOffset: 8,
      templateSearch: 'parallel',
      templateSource: 'database',
      templateSortBy: 'updated_at',
      templateOffset: 6,
    })).toEqual({
      workflowSearch: '审批',
      workflowStatus: 'draft',
      workflowSortBy: 'name',
      workflowOffset: 8,
      templateSearch: 'parallel',
      templateSource: 'database',
      templateSortBy: 'updated_at',
      templateOffset: 6,
    })

    expect(normalizeWorkflowHubTeamViewState({
      workflowStatus: 'invalid',
      templateSource: 'invalid',
      workflowOffset: -1,
    })).toMatchObject({
      workflowStatus: '',
      templateSource: 'all',
      workflowOffset: 0,
    })
  })

  it('builds stored values with normalized name key', () => {
    const values = buildWorkflowHubTeamViewValues({
      tenantId: 'tenant-a',
      ownerUserId: 'user-1',
      name: '  Parallel Templates  ',
      state: { templateSearch: 'parallel' },
    })

    expect(values).toMatchObject({
      tenant_id: 'tenant-a',
      owner_user_id: 'user-1',
      scope: 'team',
      name: 'Parallel Templates',
      name_key: 'parallel templates',
    })
    expect(values.state).toContain('"templateSearch":"parallel"')
  })

  it('maps stored rows for the current user', () => {
    const mapped = mapWorkflowHubTeamViewRow({
      id: 'view-1',
      tenant_id: 'tenant-a',
      owner_user_id: 'user-1',
      scope: 'team',
      name: 'Shared Parallel',
      name_key: 'shared parallel',
      state: JSON.stringify({ templateSearch: 'parallel' }),
      created_at: new Date('2026-03-09T00:00:00.000Z'),
      updated_at: new Date('2026-03-09T01:00:00.000Z'),
    }, 'user-1')

    expect(mapped).toMatchObject({
      id: 'view-1',
      name: 'Shared Parallel',
      ownerUserId: 'user-1',
      canManage: true,
      state: expect.objectContaining({
        templateSearch: 'parallel',
      }),
    })
  })
})
