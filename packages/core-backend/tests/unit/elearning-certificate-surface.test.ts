import { describe, expect, it } from 'vitest'

import {
  ElearningCertificateSurfaceError,
  issueElearningCertificate,
  listActiveElearningCertificateTemplates,
  listMyElearningCertificates,
  publishElearningCertificateTemplate,
  type ElearningCertificateDb,
} from '../../src/services/elearning-certificate-surface'

const ORG = 'org-certificate-surface'
const ACTOR = 'admin-certificate-surface'
const USER = 'learner-certificate-surface'
const REVISION_ID = '11111111-1111-4111-8111-111111111111'
const ISSUE_ID = '22222222-2222-4222-8222-222222222222'
const SERIAL = '33333333-3333-4333-8333-333333333333'
const HEAD_ID = '44444444-4444-4444-8444-444444444444'

type QueryResult = { rows: Array<Record<string, unknown>>; rowCount: number | null }

function dbWith(
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>,
): ElearningCertificateDb {
  return {
    query,
    transaction: async (run) => run({ query }),
  }
}

function templateRow(overrides: Record<string, unknown> = {}) {
  return {
    certificate_key: 'course-completion',
    revision_id: REVISION_ID,
    version: 2,
    name: 'Course completion',
    template_text: '#learnerName# completed #courseName#',
    background_image_url: 'https://assets.example.test/certificate.png',
    created_at: '2026-08-30T04:00:00.000Z',
    ...overrides,
  }
}

function issueRow(overrides: Record<string, unknown> = {}) {
  return {
    issue_id: ISSUE_ID,
    certificate_key: 'course-completion',
    template_revision_id: REVISION_ID,
    serial_number: SERIAL,
    parameter_snapshot: {
      courseName: 'Safety',
      learnerName: 'Learner',
    },
    issued_at: '2026-08-30T05:00:00.000Z',
    effect_key: 'certificate-request-1',
    request_hash: 'a'.repeat(64),
    request_hash_version: 1,
    user_id: USER,
    template_name: 'Course completion',
    template_text: '#learnerName# completed #courseName#',
    background_image_url: null,
    ...overrides,
  }
}

function publishInput(overrides: Record<string, unknown> = {}) {
  return {
    orgId: ORG,
    actorId: ACTOR,
    requestId: 'template-request-1',
    certificateId: 'course-completion',
    name: 'Course completion',
    templateText: '#learnerName# completed #courseName#',
    backgroundImageUrl: 'https://assets.example.test/certificate.png',
    ...overrides,
  }
}

function issueInput(overrides: Record<string, unknown> = {}) {
  return {
    orgId: ORG,
    actorId: ACTOR,
    requestId: 'certificate-request-1',
    certificateId: 'course-completion',
    userId: USER,
    parameters: {
      courseName: 'Safety',
      learnerName: 'Learner',
    },
    ...overrides,
  }
}

describe('e-learning certificate surface', () => {
  it('lists a closed ordered active-template envelope', async () => {
    const db = dbWith(async (sql, params) => {
      expect(sql).toContain('elearning-certificate:list-templates')
      expect(params).toEqual([ORG])
      return { rows: [templateRow()], rowCount: 1 }
    })

    await expect(listActiveElearningCertificateTemplates(db, ORG)).resolves.toEqual([{
      certificateId: 'course-completion',
      revisionId: REVISION_ID,
      version: 2,
      name: 'Course completion',
      templateText: '#learnerName# completed #courseName#',
      backgroundImageUrl: 'https://assets.example.test/certificate.png',
      placeholders: ['learnerName', 'courseName'],
      createdAt: '2026-08-30T04:00:00.000Z',
    }])
  })

  it('publishes an immutable template revision and records its request identity', async () => {
    const calls: string[] = []
    const db = dbWith(async (sql, params) => {
      calls.push(sql)
      if (sql.includes(':load-template-request')) return { rows: [], rowCount: 0 }
      if (sql.includes(':lock-template-head')) {
        return { rows: [{ id: HEAD_ID, latest_version: 1 }], rowCount: 1 }
      }
      if (sql.includes(':insert-template-revision')) {
        expect(params?.slice(1)).toEqual([
          ORG,
          HEAD_ID,
          'course-completion',
          2,
          ACTOR,
          'Course completion',
          '#learnerName# completed #courseName#',
          'https://assets.example.test/certificate.png',
        ])
        return { rows: [{ created_at: '2026-08-30T04:00:00.000Z' }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })

    await expect(publishElearningCertificateTemplate(db, publishInput())).resolves.toEqual({
      certificateId: 'course-completion',
      revisionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      version: 2,
      name: 'Course completion',
      templateText: '#learnerName# completed #courseName#',
      backgroundImageUrl: 'https://assets.example.test/certificate.png',
      placeholders: ['learnerName', 'courseName'],
      createdAt: '2026-08-30T04:00:00.000Z',
    })
    expect(calls.map((sql) => /elearning-certificate:([^*]+)/.exec(sql)?.[1]?.trim()))
      .toEqual([
        'template-request-lock',
        'load-template-request',
        'template-head-lock',
        'ensure-template-head',
        'lock-template-head',
        'insert-template-revision',
        'activate-template-revision',
        'record-template-request',
      ])
  })

  it('replays an exact template request and rejects a changed payload values-free', async () => {
    let firstHash: string | null = null
    const publishDb = dbWith(async (sql, params) => {
      if (sql.includes(':load-template-request')) {
        firstHash = null
        return { rows: [], rowCount: 0 }
      }
      if (sql.includes(':lock-template-head')) {
        return { rows: [{ id: HEAD_ID, latest_version: 1 }], rowCount: 1 }
      }
      if (sql.includes(':insert-template-revision')) {
        return { rows: [{ created_at: '2026-08-30T04:00:00.000Z' }], rowCount: 1 }
      }
      if (sql.includes(':record-template-request')) {
        firstHash = String(params?.[2])
      }
      return { rows: [], rowCount: 1 }
    })
    await publishElearningCertificateTemplate(publishDb, publishInput())
    expect(firstHash).toMatch(/^[0-9a-f]{64}$/)

    const replayDb = dbWith(async (sql) => {
      if (sql.includes(':template-request-lock')) return { rows: [], rowCount: 1 }
      if (sql.includes(':load-template-request')) {
        return {
          rows: [{
            ...templateRow(),
            request_hash: firstHash,
            request_hash_version: 1,
          }],
          rowCount: 1,
        }
      }
      throw new Error('unexpected query')
    })
    await expect(publishElearningCertificateTemplate(replayDb, publishInput()))
      .resolves.toMatchObject({ revisionId: REVISION_ID, version: 2 })
    await expect(publishElearningCertificateTemplate(
      replayDb,
      publishInput({ name: 'Changed' }),
    )).rejects.toEqual(expect.objectContaining({ code: 'conflict', message: 'conflict' }))
  })

  it('issues one immutable snapshot for an active same-org learner', async () => {
    const calls: string[] = []
    const db = dbWith(async (sql, params) => {
      calls.push(sql)
      if (sql.includes(':load-issue-request')) return { rows: [], rowCount: 0 }
      if (sql.includes(':load-active-template')) {
        return {
          rows: [{
            certificate_key: 'course-completion',
            revision_id: REVISION_ID,
            name: 'Course completion',
            template_text: '#learnerName# completed #courseName#',
            background_image_url: null,
          }],
          rowCount: 1,
        }
      }
      if (sql.includes(':target-membership')) return { rows: [{ ok: 1 }], rowCount: 1 }
      if (sql.includes(':insert-issue')) {
        expect(params?.[1]).toBe(ORG)
        expect(params?.[2]).toBe(USER)
        expect(params?.[3]).toBe('course-completion')
        expect(params?.[4]).toBe(REVISION_ID)
        expect(params?.[5]).toBe(ACTOR)
        expect(params?.[6]).toBe('certificate-request-1')
        expect(params?.[7]).toBe('certificate-request-1')
        expect(params?.[8]).toMatch(/^[0-9a-f]{64}$/)
        expect(params?.[10]).toMatch(/^[0-9a-f-]{36}$/)
        expect(JSON.parse(String(params?.[11]))).toEqual({
          courseName: 'Safety',
          learnerName: 'Learner',
        })
        return { rows: [{ issued_at: params?.[12] }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })

    await expect(issueElearningCertificate(db, issueInput())).resolves.toEqual({
      issueId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      certificateId: 'course-completion',
      templateRevisionId: REVISION_ID,
      templateName: 'Course completion',
      serialNumber: expect.stringMatching(/^[0-9a-f-]{36}$/),
      parameters: { courseName: 'Safety', learnerName: 'Learner' },
      backgroundImageUrl: null,
      issuedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    })
    expect(calls.map((sql) => /elearning-certificate:([^*]+)/.exec(sql)?.[1]?.trim()))
      .toEqual([
        'issue-request-lock',
        'load-issue-request',
        'load-active-template',
        'target-membership',
        'insert-issue',
      ])
  })

  it('replays the same issue payload and rejects changed parameters', async () => {
    let requestHash = ''
    let issuedAt = ''
    const captureDb = dbWith(async (sql, params) => {
      if (sql.includes(':load-issue-request')) return { rows: [], rowCount: 0 }
      if (sql.includes(':load-active-template')) {
        return {
          rows: [{
            revision_id: REVISION_ID,
            name: 'Course completion',
            template_text: '#learnerName# completed #courseName#',
            background_image_url: null,
          }],
          rowCount: 1,
        }
      }
      if (sql.includes(':target-membership')) return { rows: [{ ok: 1 }], rowCount: 1 }
      if (sql.includes(':insert-issue')) {
        requestHash = String(params?.[8])
        issuedAt = String(params?.[12])
        return { rows: [{ issued_at: issuedAt }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })
    await issueElearningCertificate(captureDb, issueInput())

    const replayDb = dbWith(async (sql) => {
      if (sql.includes(':issue-request-lock')) return { rows: [], rowCount: 1 }
      if (sql.includes(':load-issue-request')) {
        return {
          rows: [issueRow({ request_hash: requestHash, issued_at: issuedAt })],
          rowCount: 1,
        }
      }
      throw new Error('unexpected query')
    })
    await expect(issueElearningCertificate(replayDb, issueInput()))
      .resolves.toMatchObject({ issueId: ISSUE_ID, serialNumber: SERIAL })
    await expect(issueElearningCertificate(replayDb, issueInput({
      parameters: { courseName: 'Changed', learnerName: 'Learner' },
    }))).rejects.toMatchObject({ code: 'conflict', message: 'conflict' })
  })

  it('lists only the authenticated learner certificate ledger', async () => {
    const db = dbWith(async (sql, params) => {
      if (sql.includes(':list-membership')) {
        expect(params).toEqual([ORG, USER])
        return { rows: [{ ok: 1 }], rowCount: 1 }
      }
      if (sql.includes(':list-issues')) {
        expect(params).toEqual([ORG, USER])
        expect(sql).toContain('WHERE issue.org_id = $1 AND issue.user_id = $2')
        return { rows: [issueRow()], rowCount: 1 }
      }
      throw new Error('unexpected query')
    })
    await expect(listMyElearningCertificates(db, ORG, USER)).resolves.toEqual([{
      issueId: ISSUE_ID,
      certificateId: 'course-completion',
      templateRevisionId: REVISION_ID,
      templateName: 'Course completion',
      serialNumber: SERIAL,
      parameters: { courseName: 'Safety', learnerName: 'Learner' },
      backgroundImageUrl: null,
      issuedAt: '2026-08-30T05:00:00.000Z',
    }])
  })

  it.each([
    publishInput({ backgroundImageUrl: 'http://assets.example.test/certificate.png' }),
    publishInput({ templateText: '#missing' }),
    publishInput({ extra: 'forbidden' }),
    issueInput({ parameters: { learnerName: 'Learner' } }),
  ])('fails closed on invalid product input %#', async (input) => {
    const db = dbWith(async () => ({ rows: [], rowCount: 0 }))
    const action = 'templateText' in input
      ? publishElearningCertificateTemplate(db, input)
      : issueElearningCertificate(db, input)
    await expect(action).rejects.toBeInstanceOf(ElearningCertificateSurfaceError)
  })

  it('fails closed on malformed stored rows and inactive membership', async () => {
    const malformed = dbWith(async () => ({
      rows: [templateRow({ version: 2_147_483_648 })],
      rowCount: 1,
    }))
    await expect(listActiveElearningCertificateTemplates(malformed, ORG))
      .rejects.toMatchObject({ code: 'unavailable' })

    const inactive = dbWith(async () => ({ rows: [], rowCount: 0 }))
    await expect(listMyElearningCertificates(inactive, ORG, USER))
      .rejects.toMatchObject({ code: 'not_found' })
  })
})
