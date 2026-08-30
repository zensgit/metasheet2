import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import {
  createElearningPilotRuntime,
  type ElearningPilotRuntimeOptions,
} from '../../src/services/elearning-pilot-runtime'
import { buildElearningDepartmentStatsProjection } from '../../src/services/elearning-department-stats-policy'
import { usePinnedServer } from '../utils/pinned-server'

const ORG = 'org-analytics-runtime'
const ACTOR = 'actor-analytics-runtime'
const DEPARTMENT = '11111111-1111-4111-8111-111111111111'
const START = '2026-08-01T00:00:00.000Z'
const END = '2026-09-01T00:00:00.000Z'
const FLAG_ON = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_ANALYTICS_ENABLED: 'true',
} as NodeJS.ProcessEnv
const pinned = usePinnedServer()

function dummyDb(): ElearningPilotRuntimeOptions['db'] {
  return {
    query: async () => ({ rows: [], rowCount: 0 }),
    transaction: async (run) => run({
      query: async () => ({ rows: [], rowCount: 0 }),
    }),
  } as ElearningPilotRuntimeOptions['db']
}

describe('e-learning analytics runtime', () => {
  it('mounts analytics independently without content or incentive routes', async () => {
    const calls: string[] = []
    const runtime = createElearningPilotRuntime({
      db: dummyDb(),
      env: FLAG_ON,
      authenticate: (_req, _res, next) => next(),
      viewerId: () => ACTOR,
      orgId: () => ORG,
      isGlobalAdmin: () => true,
      statsGuard: (_req, _res, next) => next(),
      getElearningDepartmentStats: async (_db, input) => {
        calls.push(input.departmentId)
        return buildElearningDepartmentStatsProjection({
          orgId: input.orgId,
          departmentId: input.departmentId,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          sourceVersion: 'runtime-v1',
          minGroupSize: 5,
          counters: {
            assignedCount: 0,
            completedCount: 0,
            creditTotal: 0,
            examParticipantCount: 0,
            learnerCount: 0,
            learningSeconds: 0,
            memberCount: 4,
            overdueCount: 0,
          },
        })
      },
    })
    expect(runtime).not.toBeNull()
    const app = express()
    app.use(runtime!.router)
    pinned.setApp(app)
    const api = request(pinned.url())
    const response = await api.get(
      `/api/elearning/admin/analytics/departments/${DEPARTMENT}`
      + `?periodStart=${encodeURIComponent(START)}&periodEnd=${encodeURIComponent(END)}`,
    )
    expect(response.status).toBe(200)
    expect(response.body.suppressed).toBe(true)
    expect(calls).toEqual([DEPARTMENT])
    expect((await api.get('/api/elearning/courses')).status).toBe(404)
    expect((await api.get('/api/elearning/credits/wallet')).status).toBe(404)
  })

  it('does not mount unless master and analytics are exact true', () => {
    for (const env of [
      {},
      { ELEARNING_ENABLED: 'true' },
      { ELEARNING_ANALYTICS_ENABLED: 'true' },
      { ELEARNING_ENABLED: 'true', ELEARNING_ANALYTICS_ENABLED: 'TRUE' },
    ]) {
      expect(createElearningPilotRuntime({ db: dummyDb(), env })).toBeNull()
    }
  })
})
