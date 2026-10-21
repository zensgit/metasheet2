import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createElearningPilotRuntime } from '../../src/services/elearning-pilot-runtime'
import type { ElearningCreditSurfaceDb } from '../../src/services/elearning-credit-surface'
import { usePinnedServer } from '../utils/pinned-server'

const ORG = 'org-certificate-runtime'
const ACTOR = 'actor-certificate-runtime'
const REVISION = '11111111-1111-4111-8111-111111111111'
const ISSUE = '22222222-2222-4222-8222-222222222222'
const SERIAL = '33333333-3333-4333-8333-333333333333'
const FLAG_ON = {
  ELEARNING_ENABLED: 'true',
  ELEARNING_INCENTIVE_ENABLED: 'true',
} as NodeJS.ProcessEnv

const pinned = usePinnedServer()

function dummyDb(): ElearningCreditSurfaceDb {
  return {
    query: async () => ({ rows: [], rowCount: 0 }),
    transaction: async (run) => run({
      query: async () => ({ rows: [], rowCount: 0 }),
    }),
  }
}

describe('e-learning certificate runtime', () => {
  it('mounts certificate admin and learner routes under the incentive gate', async () => {
    const listCalls: Array<[string, string]> = []
    const runtime = createElearningPilotRuntime({
      db: dummyDb(),
      env: { ...FLAG_ON },
      authenticate: (_req, _res, next) => next(),
      viewerId: () => ACTOR,
      orgId: () => ORG,
      readGuard: (_req, _res, next) => next(),
      adminGuard: (_req, _res, next) => next(),
      listActiveElearningCertificateTemplates: async () => [{
        certificateId: 'course-completion',
        revisionId: REVISION,
        version: 1,
        name: 'Course completion',
        templateText: '#learnerName#',
        backgroundImageUrl: null,
        placeholders: ['learnerName'],
        createdAt: '2026-08-30T04:00:00.000Z',
      }],
      listMyElearningCertificates: async (_db, orgId, userId) => {
        listCalls.push([orgId, userId])
        return [{
          issueId: ISSUE,
          certificateId: 'course-completion',
          templateRevisionId: REVISION,
          templateName: 'Course completion',
          serialNumber: SERIAL,
          parameters: { learnerName: 'Learner' },
          backgroundImageUrl: null,
          issuedAt: '2026-08-30T05:00:00.000Z',
        }]
      },
    })
    expect(runtime).not.toBeNull()
    const app = express()
    app.use(runtime!.router)
    pinned.setApp(app)
    const api = request(pinned.url())

    expect((await api.get('/api/elearning/admin/certificate-templates')).body)
      .toEqual({
        items: [{
          certificateId: 'course-completion',
          revisionId: REVISION,
          version: 1,
          name: 'Course completion',
          templateText: '#learnerName#',
          backgroundImageUrl: null,
          placeholders: ['learnerName'],
          createdAt: '2026-08-30T04:00:00.000Z',
        }],
      })
    expect((await api.get('/api/elearning/certificates')).body).toEqual({
      items: [{
        issueId: ISSUE,
        certificateId: 'course-completion',
        templateRevisionId: REVISION,
        templateName: 'Course completion',
        serialNumber: SERIAL,
        parameters: { learnerName: 'Learner' },
        backgroundImageUrl: null,
        issuedAt: '2026-08-30T05:00:00.000Z',
      }],
    })
    expect(listCalls).toEqual([[ORG, ACTOR]])
  })

  it('keeps certificate routes absent unless master and incentive are exact true', () => {
    expect(createElearningPilotRuntime({
      db: dummyDb(),
      env: { ELEARNING_ENABLED: 'true' },
    })).toBeNull()
    expect(createElearningPilotRuntime({
      db: dummyDb(),
      env: { ELEARNING_ENABLED: 'true', ELEARNING_INCENTIVE_ENABLED: 'TRUE' },
    })).toBeNull()
  })
})
