import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createElearningPilotRuntime } from '../../src/services/elearning-pilot-runtime'
import { usePinnedServer } from '../utils/pinned-server'

const ENABLED = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_OFFLINE_TRAINING_ENABLED: 'true',
} as NodeJS.ProcessEnv
const pinned = usePinnedServer()

function dummyDb() {
  return {
    query: async () => ({ rows: [], rowCount: 0 }),
    transaction: async <T>(handler: (tx: never) => Promise<T>) => handler({
      query: async () => ({ rows: [], rowCount: 0 }),
    } as never),
  }
}

function runtime(env: NodeJS.ProcessEnv) {
  const calls: unknown[] = []
  const result = createElearningPilotRuntime({
    db: dummyDb() as never,
    env,
    authenticate: (_req, _res, next) => next(),
    viewerId: () => 'offline-user',
    orgId: () => 'offline-org',
    isGlobalAdmin: () => true,
    readGuard: (_req, _res, next) => next(),
    adminGuard: (_req, _res, next) => next(),
    listMyElearningOfflineTrainings: async (_db, input) => {
      calls.push(input)
      return []
    },
  })
  if (!result) return { api: null, calls }
  const app = express()
  app.use(result.router)
  pinned.setApp(app)
  return { api: request(pinned.url()), calls }
}

describe('e-learning offline training runtime', () => {
  it('mounts from master plus the independent exact offline flag', async () => {
    const state = runtime({ ...ENABLED })
    const response = await state.api!.get('/api/elearning/me/offline-trainings')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ trainings: [] })
    expect(state.calls).toEqual([{ orgId: 'offline-org', userId: 'offline-user' }])
  })

  it.each([
    {},
    { ELEARNING_ENABLED: 'true' },
    { ELEARNING_OFFLINE_TRAINING_ENABLED: 'true' },
    { ELEARNING_ENABLED: 'true', ELEARNING_OFFLINE_TRAINING_ENABLED: 'TRUE' },
  ])('does not acquire a runtime for non-exact gates %#', (env) => {
    expect(runtime(env as NodeJS.ProcessEnv).api).toBeNull()
  })
})
