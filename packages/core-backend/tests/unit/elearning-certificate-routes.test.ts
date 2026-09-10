import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'

import { createElearningCreditRouter } from '../../src/routes/elearning-credit'
import {
  ElearningCertificateSurfaceError,
  type IssueElearningCertificateInput,
  type PublishElearningCertificateTemplateInput,
} from '../../src/services/elearning-certificate-surface'
import type { ElearningCreditSurfaceDb } from '../../src/services/elearning-credit-surface'
import { usePinnedServer } from '../utils/pinned-server'

const ORG = 'org-certificate-routes'
const ACTOR = 'actor-certificate-routes'
const TARGET = 'target-certificate-routes'
const REVISION_ID = '11111111-1111-4111-8111-111111111111'
const ISSUE_ID = '22222222-2222-4222-8222-222222222222'
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

function makeApp(over: {
  adminAllowed?: boolean
  readAllowed?: boolean
  error?: ElearningCertificateSurfaceError
} = {}) {
  const publishCalls: PublishElearningCertificateTemplateInput[] = []
  const issueCalls: IssueElearningCertificateInput[] = []
  const listCalls: Array<[string, string]> = []
  const router = createElearningCreditRouter({
    db: dummyDb(),
    env: { ...FLAG_ON },
    viewerId: () => ACTOR,
    orgId: () => ORG,
    adminGuard: (_req, res, next) => {
      if (over.adminAllowed === false) {
        res.status(403).json({ error: 'Insufficient permissions' })
        return
      }
      next()
    },
    readGuard: (_req, res, next) => {
      if (over.readAllowed === false) {
        res.status(403).json({ error: 'Insufficient permissions' })
        return
      }
      next()
    },
    listActiveElearningCertificateTemplates: async () => {
      if (over.error) throw over.error
      return [{
        certificateId: 'course-completion',
        revisionId: REVISION_ID,
        version: 2,
        name: 'Course completion',
        templateText: '#learnerName# completed #courseName#',
        backgroundImageUrl: null,
        placeholders: ['learnerName', 'courseName'],
        createdAt: '2026-08-30T04:00:00.000Z',
        requestHash: 'must-not-leak',
      } as never]
    },
    publishElearningCertificateTemplate: async (_db, input) => {
      publishCalls.push(input)
      if (over.error) throw over.error
      return {
        certificateId: input.certificateId as string,
        revisionId: REVISION_ID,
        version: 2,
        name: input.name as string,
        templateText: input.templateText as string,
        backgroundImageUrl: input.backgroundImageUrl as string | null,
        placeholders: ['learnerName', 'courseName'],
        createdAt: '2026-08-30T04:00:00.000Z',
        requestHash: 'must-not-leak',
      } as never
    },
    issueElearningCertificate: async (_db, input) => {
      issueCalls.push(input)
      if (over.error) throw over.error
      return {
        issueId: ISSUE_ID,
        certificateId: input.certificateId as string,
        templateRevisionId: REVISION_ID,
        templateName: 'Course completion',
        serialNumber: SERIAL,
        parameters: input.parameters as Record<string, string>,
        backgroundImageUrl: null,
        issuedAt: '2026-08-30T05:00:00.000Z',
        requestHash: 'must-not-leak',
        actorId: 'must-not-leak',
      } as never
    },
    listMyElearningCertificates: async (_db, orgId, userId) => {
      listCalls.push([orgId, userId])
      if (over.error) throw over.error
      return [{
        issueId: ISSUE_ID,
        certificateId: 'course-completion',
        templateRevisionId: REVISION_ID,
        templateName: 'Course completion',
        serialNumber: SERIAL,
        parameters: { courseName: 'Safety', learnerName: 'Learner' },
        backgroundImageUrl: null,
        issuedAt: '2026-08-30T05:00:00.000Z',
        sourceKey: 'must-not-leak',
      } as never]
    },
  })
  const app = express()
  if (router) app.use(router)
  pinned.setApp(app)
  return {
    api: request(pinned.url()),
    publishCalls,
    issueCalls,
    listCalls,
  }
}

describe('e-learning certificate routes', () => {
  it('lists and publishes closed template DTOs behind admin authority', async () => {
    const harness = makeApp()
    const listed = await harness.api.get('/api/elearning/admin/certificate-templates')
    expect(listed.status).toBe(200)
    expect(listed.body).toEqual({
      items: [{
        certificateId: 'course-completion',
        revisionId: REVISION_ID,
        version: 2,
        name: 'Course completion',
        templateText: '#learnerName# completed #courseName#',
        backgroundImageUrl: null,
        placeholders: ['learnerName', 'courseName'],
        createdAt: '2026-08-30T04:00:00.000Z',
      }],
    })
    expect(JSON.stringify(listed.body)).not.toMatch(/requestHash|must-not-leak/)

    const published = await harness.api
      .post('/api/elearning/admin/certificate-templates')
      .send({
        requestId: 'template-route-1',
        certificateId: 'course-completion',
        name: 'Course completion',
        templateText: '#learnerName# completed #courseName#',
        backgroundImageUrl: null,
      })
    expect(published.status).toBe(200)
    expect(published.body).toEqual(listed.body.items[0])
    expect(harness.publishCalls).toEqual([{
      orgId: ORG,
      actorId: ACTOR,
      requestId: 'template-route-1',
      certificateId: 'course-completion',
      name: 'Course completion',
      templateText: '#learnerName# completed #courseName#',
      backgroundImageUrl: null,
    }])
  })

  it('issues with server-derived authority and a closed result', async () => {
    const harness = makeApp()
    const response = await harness.api
      .post('/api/elearning/admin/certificate-issues')
      .send({
        requestId: 'issue-route-1',
        certificateId: 'course-completion',
        userId: TARGET,
        parameters: { learnerName: 'Learner', courseName: 'Safety' },
      })
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      issueId: ISSUE_ID,
      certificateId: 'course-completion',
      templateRevisionId: REVISION_ID,
      templateName: 'Course completion',
      serialNumber: SERIAL,
      parameters: { learnerName: 'Learner', courseName: 'Safety' },
      backgroundImageUrl: null,
      issuedAt: '2026-08-30T05:00:00.000Z',
    })
    expect(harness.issueCalls).toEqual([{
      orgId: ORG,
      actorId: ACTOR,
      requestId: 'issue-route-1',
      certificateId: 'course-completion',
      userId: TARGET,
      parameters: { learnerName: 'Learner', courseName: 'Safety' },
    }])
    expect(JSON.stringify(response.body)).not.toMatch(/requestHash|actorId|must-not-leak/)
  })

  it('lists only the authenticated learner certificate ledger', async () => {
    const harness = makeApp()
    const response = await harness.api.get('/api/elearning/certificates')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      items: [{
        issueId: ISSUE_ID,
        certificateId: 'course-completion',
        templateRevisionId: REVISION_ID,
        templateName: 'Course completion',
        serialNumber: SERIAL,
        parameters: { courseName: 'Safety', learnerName: 'Learner' },
        backgroundImageUrl: null,
        issuedAt: '2026-08-30T05:00:00.000Z',
      }],
    })
    expect(harness.listCalls).toEqual([[ORG, ACTOR]])
    expect(JSON.stringify(response.body)).not.toMatch(/sourceKey|must-not-leak/)
  })

  it('rejects extra authority keys before product calls', async () => {
    const harness = makeApp()
    const response = await harness.api
      .post('/api/elearning/admin/certificate-issues')
      .send({
        requestId: 'issue-route-2',
        certificateId: 'course-completion',
        userId: TARGET,
        parameters: {},
        orgId: 'injected',
      })
    expect(response.status).toBe(400)
    expect(harness.issueCalls).toEqual([])
  })

  it('enforces admin/read RBAC and maps certificate errors values-free', async () => {
    expect((await makeApp({ adminAllowed: false }).api.get(
      '/api/elearning/admin/certificate-templates',
    )).status).toBe(403)
    expect((await makeApp({ readAllowed: false }).api.get(
      '/api/elearning/certificates',
    )).status).toBe(403)

    for (const [code, status] of [
      ['invalid_input', 400],
      ['conflict', 409],
      ['not_found', 404],
      ['unavailable', 503],
    ] as const) {
      const response = await makeApp({
        error: new ElearningCertificateSurfaceError(code),
      }).api.get('/api/elearning/admin/certificate-templates')
      expect(response.status).toBe(status)
      expect(response.body).toEqual({ error: code })
    }
  })
})
