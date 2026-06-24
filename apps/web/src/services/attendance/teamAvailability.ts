import { apiFetch } from '../../utils/api'

// #6 TA-2/TA-3 (design-lock #3056): team-availability read surface. Mirrors fetchEffectiveCalendar's
// apiFetch/{ok,data}/error pattern, but a DISTINCT response shape (per-member state + per-date summary).

export type TeamAvailabilityState =
  | 'scheduled'
  | 'rest'
  | 'approved_leave'
  | 'pending_leave'
  | 'unscheduled'

export interface TeamAvailabilityItem {
  date: string
  userId: string
  state: TeamAvailabilityState
}

export interface TeamAvailabilityDaySummary {
  date: string
  scheduled: number
  rest: number
  approvedLeave: number
  pendingLeaveTentative: number
  unscheduled: number
  /** §3a: scheduled + pendingLeaveTentative — pending does NOT reduce the formal available headcount. */
  availableFormal: number
}

export interface TeamAvailabilityResponse {
  groupId: string
  range: { from: string; to: string }
  members: number
  items: TeamAvailabilityItem[]
  summary: TeamAvailabilityDaySummary[]
}

export interface FetchTeamAvailabilityOptions {
  groupId: string
  from: string
  to: string
  suppressUnauthorizedRedirect?: boolean
  signal?: AbortSignal
}

export class TeamAvailabilityFetchError extends Error {
  status: number
  code?: string
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'TeamAvailabilityFetchError'
    this.status = status
    this.code = code
  }
}

export async function fetchTeamAvailability(
  options: FetchTeamAvailabilityOptions,
): Promise<TeamAvailabilityResponse> {
  const { groupId, from, to, suppressUnauthorizedRedirect, signal } = options
  if (!groupId) {
    throw new Error('fetchTeamAvailability: "groupId" is required (v1 is group-only).')
  }
  if (!from || !to) {
    throw new Error('fetchTeamAvailability: "from" and "to" are required.')
  }

  const query = new URLSearchParams({ groupId, from, to })
  const response = await apiFetch(`/api/attendance/team-availability?${query.toString()}`, {
    suppressUnauthorizedRedirect: suppressUnauthorizedRedirect ?? true,
    signal,
  })
  let data: any = null
  try {
    data = await response.json()
  } catch {
    data = null
  }
  if (!response.ok || data?.ok === false) {
    const message = data?.error?.message
      ?? `Failed to load team availability (HTTP ${response.status}).`
    throw new TeamAvailabilityFetchError(message, response.status, data?.error?.code)
  }
  return data?.data as TeamAvailabilityResponse
}

// §3c state → presentation. pending_leave is PROVISIONAL: visually + semantically distinct from
// approved_leave, carries the "待审批，未生效" tooltip, and is NEVER treated as a deduction (it stays in
// availableFormal, §3a). Pure function — unit-tested without a DOM.
export interface TeamAvailabilityStateMeta {
  state: TeamAvailabilityState
  className: string
  provisional: boolean
  zhShort: string
  zhLabel: string
  enLabel: string
  /** §3c — only pending carries the not-yet-effective note. */
  zhTooltip?: string
  enTooltip?: string
}

const STATE_META: Record<TeamAvailabilityState, TeamAvailabilityStateMeta> = {
  scheduled: { state: 'scheduled', className: 'ta-state--scheduled', provisional: false, zhShort: '班', zhLabel: '排班', enLabel: 'Scheduled' },
  rest: { state: 'rest', className: 'ta-state--rest', provisional: false, zhShort: '休', zhLabel: '休息', enLabel: 'Rest' },
  approved_leave: { state: 'approved_leave', className: 'ta-state--approved-leave', provisional: false, zhShort: '假', zhLabel: '已批请假', enLabel: 'Approved leave' },
  pending_leave: {
    state: 'pending_leave',
    className: 'ta-state--pending-leave',
    provisional: true,
    zhShort: '待',
    zhLabel: '待审批请假',
    enLabel: 'Pending leave',
    zhTooltip: '待审批，未生效',
    enTooltip: 'Pending approval, not yet effective',
  },
  unscheduled: { state: 'unscheduled', className: 'ta-state--unscheduled', provisional: false, zhShort: '—', zhLabel: '未排班', enLabel: 'Unscheduled' },
}

export function teamAvailabilityStateMeta(state: TeamAvailabilityState): TeamAvailabilityStateMeta {
  return STATE_META[state] ?? STATE_META.unscheduled
}
