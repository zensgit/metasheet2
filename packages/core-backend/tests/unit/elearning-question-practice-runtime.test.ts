import express from 'express'
import { readFileSync } from 'node:fs'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createElearningPilotRuntime } from '../../src/services/elearning-pilot-runtime'
import { usePinnedServer } from '../utils/pinned-server'

const ENABLED = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_ASSESSMENT_ENABLED: 'true',
} as NodeJS.ProcessEnv
const pinned = usePinnedServer()

function dummyDb() {
  return {
    query: async () => ({ rows: [], rowCount: 0 }),
    transaction: async <T>(handler: (tx: unknown) => Promise<T>) => handler({
      query: async () => ({ rows: [], rowCount: 0 }),
    }),
  }
}

function makeRuntime(env: NodeJS.ProcessEnv) {
  const calls: string[] = []
  const runtime = createElearningPilotRuntime({
    db: dummyDb() as never,
    env,
    authenticate: (_req, _res, next) => next(),
    viewerId: () => 'practice-user',
    orgId: () => 'practice-org',
    readGuard: (_req, _res, next) => next(),
    adminGuard: (_req, _res, next) => next(),
    listElearningPracticeSets: async () => {
      calls.push('list')
      return []
    },
  })
  if (!runtime) return { calls, mounted: false, api: null }
  const app = express()
  app.use(runtime.router)
  pinned.setApp(app)
  return { calls, mounted: true, api: request(pinned.url()) }
}

describe('e-learning question practice runtime', () => {
  it('mounts assessment practice without requiring content or media flags', async () => {
    const state = makeRuntime({ ...ENABLED })
    expect(state.mounted).toBe(true)
    const response = await state.api!.get('/api/elearning/me/practice-sets')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ practiceSets: [] })
    expect(state.calls).toEqual(['list'])
  })

  it.each([
    {},
    { ELEARNING_ENABLED: 'true' },
    { ELEARNING_ASSESSMENT_ENABLED: 'true' },
    { ELEARNING_ENABLED: 'true', ELEARNING_ASSESSMENT_ENABLED: 'TRUE' },
  ])('does not acquire a runtime for non-exact practice gates %#', (env) => {
    expect(makeRuntime(env as NodeJS.ProcessEnv).mounted).toBe(false)
  })

  it('rechecks the assessment flag after runtime creation', async () => {
    const env = { ...ENABLED }
    const state = makeRuntime(env)
    env.ELEARNING_ASSESSMENT_ENABLED = 'false'
    const response = await state.api!.get('/api/elearning/me/practice-sets')
    expect(response.status).toBe(404)
    expect(state.calls).toEqual([])
  })

  it('keeps the application startup pre-gate assessment-aware before acquiring the pool', () => {
    const source = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8')
    const runtime = source.slice(
      source.indexOf('const elearningPilotRuntime = ('),
      source.indexOf('if (elearningPilotRuntime)'),
    )
    expect(runtime).toContain('|| isElearningPracticeSurfaceEnabled(process.env)')
    expect(runtime.indexOf('isElearningPracticeSurfaceEnabled(process.env)'))
      .toBeLessThan(runtime.indexOf('poolManager.get()'))
  })
})
