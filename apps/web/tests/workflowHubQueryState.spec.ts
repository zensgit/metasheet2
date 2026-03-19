import { describe, expect, it } from 'vitest'
import {
  buildWorkflowHubRouteQuery,
  DEFAULT_WORKFLOW_HUB_ROUTE_STATE,
  getNextWorkflowHubOffset,
  isWorkflowHubRouteStateEqual,
  parseWorkflowHubRouteState,
} from '../src/views/workflowHubQueryState'

describe('workflowHubQueryState', () => {
  it('parses workflow and template filters from route query', () => {
    expect(
      parseWorkflowHubRouteState({
        wfSearch: 'approval',
        wfStatus: 'draft',
        wfSort: 'name',
        wfOffset: '8',
        tplSearch: 'parallel',
        tplSource: 'database',
        tplSort: 'updated_at',
        tplOffset: '6',
      }),
    ).toEqual({
      workflowSearch: 'approval',
      workflowStatus: 'draft',
      workflowSortBy: 'name',
      workflowOffset: 8,
      templateSearch: 'parallel',
      templateSource: 'database',
      templateSortBy: 'updated_at',
      templateOffset: 6,
    })
  })

  it('drops defaults when building a shareable route query', () => {
    expect(buildWorkflowHubRouteQuery(DEFAULT_WORKFLOW_HUB_ROUTE_STATE)).toEqual({})

    expect(buildWorkflowHubRouteQuery({
      ...DEFAULT_WORKFLOW_HUB_ROUTE_STATE,
      workflowSearch: '审批',
      workflowOffset: 8,
      templateSource: 'builtin',
      templateOffset: 6,
    })).toEqual({
      wfSearch: '审批',
      wfOffset: '8',
      tplSource: 'builtin',
      tplOffset: '6',
    })
  })

  it('computes next offsets only when another page exists', () => {
    expect(getNextWorkflowHubOffset(20, 8, 0, 8)).toBe(8)
    expect(getNextWorkflowHubOffset(14, 6, 8, 8)).toBe(null)
  })

  it('compares route states for browser history replay', () => {
    expect(isWorkflowHubRouteStateEqual(
      DEFAULT_WORKFLOW_HUB_ROUTE_STATE,
      { ...DEFAULT_WORKFLOW_HUB_ROUTE_STATE },
    )).toBe(true)

    expect(isWorkflowHubRouteStateEqual(
      DEFAULT_WORKFLOW_HUB_ROUTE_STATE,
      { ...DEFAULT_WORKFLOW_HUB_ROUTE_STATE, templateSearch: 'parallel' },
    )).toBe(false)
  })
})
