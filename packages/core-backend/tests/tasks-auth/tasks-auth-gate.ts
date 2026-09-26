import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import { tasksRouter } from '../../src/routes/tasks'

if (process.env.TASKS_AUTH_GATE_SETUP !== '1') {
  throw new Error('tasks auth gate must load dedicated setup before this file')
}
if (process.env.RBAC_BYPASS !== 'false' || process.env.RBAC_TOKEN_TRUST !== 'false') {
  throw new Error('tasks auth gate requires RBAC_BYPASS=false and RBAC_TOKEN_TRUST=false at import')
}

describe('tasks auth gate', () => {
  it('mounts the read route and rejects a missing bearer', async () => {
    const router = tasksRouter()
    expect(router).not.toBeNull()
    const app = express()
    app.use(router!)
    const response = await request(app).get('/api/tasks/context')
    expect(response.status).toBe(401)
    expect(response.body).toEqual({
      ok: false,
      error: { code: 'UNAUTHORIZED', message: 'Missing Bearer token' },
    })
  })
})
