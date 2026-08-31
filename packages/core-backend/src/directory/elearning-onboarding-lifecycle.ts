import { isElearningAssignmentSurfaceEnabled } from '../elearning/feature-flags'
import {
  enqueueElearningOnboardingForUser,
  ElearningOnboardingAssignmentError,
  type ElearningOnboardingAssignmentQueryable,
  type EnqueueElearningOnboardingForUserResult,
} from '../services/elearning-onboarding-assignment'

export interface DirectoryElearningOnboardingClient {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export interface EnqueueDirectoryElearningOnboardingInput {
  client: DirectoryElearningOnboardingClient
  orgId: string
  users: Iterable<{ userId: string; hiredDate?: string }>
  eventAt: string
  env?: NodeJS.ProcessEnv
}

export interface EnqueueDirectoryElearningOnboardingResult {
  enabled: boolean
  candidateUserCount: number
  eligibleUserCount: number
  skippedUserCount: number
  matchedPolicyCount: number
  enqueuedCount: number
}

type EnqueueUser = (
  db: {
    query: ElearningOnboardingAssignmentQueryable['query']
    transaction<T>(
      run: (tx: ElearningOnboardingAssignmentQueryable) => Promise<T>,
    ): Promise<T>
  },
  input: { orgId: string; userId: string; eventAt: string },
) => Promise<EnqueueElearningOnboardingForUserResult>

function isCanonicalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export async function enqueueDirectoryElearningOnboarding(
  input: EnqueueDirectoryElearningOnboardingInput,
  enqueueUser: EnqueueUser = enqueueElearningOnboardingForUser,
): Promise<EnqueueDirectoryElearningOnboardingResult> {
  const empty = {
    enabled: false,
    candidateUserCount: 0,
    eligibleUserCount: 0,
    skippedUserCount: 0,
    matchedPolicyCount: 0,
    enqueuedCount: 0,
  }
  if (!isElearningAssignmentSurfaceEnabled(input.env ?? process.env)) return empty

  const users = new Map<string, string | undefined>()
  for (const candidate of input.users) {
    const userId = candidate.userId.trim()
    if (!userId) throw new Error('Invalid directory onboarding user')
    const hiredDate = candidate.hiredDate
    if (
      hiredDate !== undefined
      && !isCanonicalDate(hiredDate)
    ) throw new Error('Invalid directory onboarding hire date')
    const existing = users.get(userId)
    if (users.has(userId) && existing !== hiredDate) {
      throw new Error('Conflicting directory onboarding hire date')
    }
    users.set(userId, hiredDate)
  }
  const candidates = Array.from(users, ([userId, hiredDate]) => ({ userId, hiredDate }))
    .sort((left, right) => left.userId.localeCompare(right.userId))

  const db = {
    query: (sql: string, params?: unknown[]) => input.client.query(sql, params),
    transaction: async <T>(
      run: (tx: ElearningOnboardingAssignmentQueryable) => Promise<T>,
    ): Promise<T> => run({
      query: (sql, params) => input.client.query(sql, params as unknown[] | undefined),
    }),
  }
  const result = { ...empty, enabled: true, candidateUserCount: candidates.length }
  for (const candidate of candidates) {
    try {
      if (candidate.hiredDate) {
        await input.client.query(
          `/* directory-elearning-onboarding:fill-hire-date */
           UPDATE users platform_user
           SET hire_date = COALESCE(platform_user.hire_date, $3::date)
           WHERE platform_user.id = $2
             AND EXISTS (
               SELECT 1
               FROM user_orgs membership
               WHERE membership.user_id = platform_user.id
                 AND membership.org_id = $1
                 AND membership.is_active = TRUE
             )
             AND platform_user.hire_date IS NULL`,
          [input.orgId, candidate.userId, candidate.hiredDate],
        )
      }
      const queued = await enqueueUser(db, {
        orgId: input.orgId,
        userId: candidate.userId,
        eventAt: input.eventAt,
      })
      result.eligibleUserCount += 1
      result.matchedPolicyCount += queued.matchedPolicyCount
      result.enqueuedCount += queued.enqueuedCount
    } catch (error) {
      if (
        error instanceof ElearningOnboardingAssignmentError
        && error.code === 'not_eligible'
      ) {
        result.skippedUserCount += 1
        continue
      }
      throw error
    }
  }
  return result
}
