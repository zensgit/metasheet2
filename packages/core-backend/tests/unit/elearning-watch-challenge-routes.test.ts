import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { createElearningPilotRouter } from '../../src/routes/elearning-pilot'
import type {
  AcknowledgeElearningWatchChallengeInput,
  ElearningWatchDb,
  ElearningWatchState,
  RecordElearningHeartbeatInput,
  StartElearningWatchInput,
} from '../../src/services/elearning-watch-progress'

const ORG = 'org-watch-challenge'
const USER = 'user-watch-challenge'
const ITEM = '11111111-1111-4111-8111-111111111111'
const SESSION = '22222222-2222-4222-8222-222222222222'
const CHALLENGE = '33333333-3333-4333-8333-333333333333'
const REQUEST = '44444444-4444-4444-8444-444444444444'

const FLAGS = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_CONTENT_ENABLED: 'true',
  ELEARNING_MEDIA_ENABLED: 'true',
  ELEARNING_WATCH_CHALLENGE_ENABLED: 'true',
} as NodeJS.ProcessEnv

const STATE: ElearningWatchState = {
  sessionId: SESSION,
  status: 'in_progress',
  lastSequence: 1,
  lastClientPositionMs: 1000,
  effectiveMs: 1000,
  maxPositionMs: 1000,
  durationMs: 10_000,
  creditedMs: 0,
  duplicate: false,
  challenge: null,
}

function db(): ElearningWatchDb {
  return {
    query: async () => ({ rows: [], rowCount: 0 }),
    transaction: async (handler) => handler({
      query: async () => ({ rows: [], rowCount: 0 }),
    }),
  }
}

function app(input: {
  env?: NodeJS.ProcessEnv
  viewerId?: string | null
  start?: (value: StartElearningWatchInput) => Promise<ElearningWatchState>
  heartbeat?: (value: RecordElearningHeartbeatInput) => Promise<ElearningWatchState>
  ack?: (value: AcknowledgeElearningWatchChallengeInput) => Promise<ElearningWatchState>
} = {}): express.Express {
  const router = createElearningPilotRouter({
    db: db() as never,
    env: input.env ?? FLAGS,
    viewerId: () => input.viewerId === undefined ? USER : input.viewerId,
    orgId: () => ORG,
    adminGuard: (_req, _res, next) => next(),
    readGuard: (_req, _res, next) => next(),
    startElearningWatch: async (_db, value) => input.start?.(value) ?? STATE,
    recordElearningHeartbeat: async (_db, value) => input.heartbeat?.(value) ?? STATE,
    acknowledgeElearningWatchChallenge: async (_db, value) => input.ack?.(value) ?? STATE,
  })
  if (!router) throw new Error('router unavailable')
  return express().use(router)
}

describe('elearning watch challenge routes', () => {
  it('passes the exact challenge gate into start and heartbeat only when enabled', async () => {
    const starts: StartElearningWatchInput[] = []
    const heartbeats: RecordElearningHeartbeatInput[] = []
    await request(app({
      start: async (value) => { starts.push(value); return STATE },
      heartbeat: async (value) => { heartbeats.push(value); return STATE },
    })).post(`/api/elearning/watch/items/${ITEM}/start`).send({}).expect(200)
    await request(app({
      start: async (value) => { starts.push(value); return STATE },
      heartbeat: async (value) => { heartbeats.push(value); return STATE },
    })).post(`/api/elearning/watch/sessions/${SESSION}/heartbeat`).send({
      sequence: 1,
      positionMs: 1000,
      playing: true,
    }).expect(200)
    expect(starts).toEqual([{ orgId: ORG, userId: USER, itemId: ITEM, challengeEnabled: true }])
    expect(heartbeats).toEqual([{
      orgId: ORG,
      userId: USER,
      sessionId: SESSION,
      sequence: 1,
      positionMs: 1000,
      playing: true,
      challengeEnabled: true,
    }])
  })

  it('keeps the legacy start payload byte-shaped when the challenge flag is off', async () => {
    const start = vi.fn(async () => STATE)
    await request(app({
      env: { ...FLAGS, ELEARNING_WATCH_CHALLENGE_ENABLED: 'false' },
      start,
    })).post(`/api/elearning/watch/items/${ITEM}/start`).send({}).expect(200)
    expect(start).toHaveBeenCalledWith({ orgId: ORG, userId: USER, itemId: ITEM })
  })

  it('acks with server-derived org/user and a closed request body', async () => {
    const ack = vi.fn(async () => STATE)
    const response = await request(app({ ack }))
      .post(`/api/elearning/watch/sessions/${SESSION}/challenges/${CHALLENGE}/ack`)
      .send({ requestId: REQUEST })
      .expect(200)
    expect(response.body).toEqual(STATE)
    expect(ack).toHaveBeenCalledWith({
      orgId: ORG,
      userId: USER,
      sessionId: SESSION,
      challengeId: CHALLENGE,
      requestId: REQUEST,
    })
    await request(app({ ack }))
      .post(`/api/elearning/watch/sessions/${SESSION}/challenges/${CHALLENGE}/ack`)
      .send({ requestId: REQUEST, answer: 'secret' })
      .expect(400, { error: 'invalid_input' })
    expect(ack).toHaveBeenCalledTimes(1)
  })

  it('fails closed for missing identity and every non-exact challenge flag', async () => {
    await request(app({ viewerId: null }))
      .post(`/api/elearning/watch/sessions/${SESSION}/challenges/${CHALLENGE}/ack`)
      .send({ requestId: REQUEST })
      .expect(401, { error: 'unauthenticated' })
    for (const value of [undefined, 'false', 'TRUE', 'true ']) {
      const env = { ...FLAGS, ELEARNING_WATCH_CHALLENGE_ENABLED: value }
      await request(app({ env }))
        .post(`/api/elearning/watch/sessions/${SESSION}/challenges/${CHALLENGE}/ack`)
        .send({ requestId: REQUEST })
        .expect(404, { error: 'not_found' })
    }
  })
})
