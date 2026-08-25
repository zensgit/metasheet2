import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ELEARNING_MEDIA_RANGE_MAX_BYTES } from '../../src/services/elearning-media-storage'
import {
  ELEARNING_MEDIA_PLAYBACK_CLAIM_KEYS,
  ELEARNING_MEDIA_PLAYBACK_SECRET_ENV,
  ELEARNING_MEDIA_PLAYBACK_SECRET_MIN_LENGTH,
  ELEARNING_MEDIA_PLAYBACK_TOKEN_VERSION,
  ELEARNING_MEDIA_PLAYBACK_TTL_MAX_SECONDS,
  ELEARNING_MEDIA_PLAYBACK_TYP,
  authorizeElearningMediaPlayback,
  issueElearningMediaPlaybackTicket,
  parseElearningMediaHttpByteRange,
  readElearningMediaPlaybackSigningSecret,
  requireElearningMediaPlaybackSigningSecret,
  signElearningMediaPlaybackToken,
  verifyElearningMediaPlaybackToken,
  ElearningPlaybackError,
  type ElearningMediaPlaybackClaims,
  type ElearningPlaybackDb,
  type ElearningPlaybackQueryable,
} from '../../src/services/elearning-media-playback'

const ORG = 'org-playback-1'
const USER = 'user-playback-1'
const OTHER_USER = 'user-playback-2'
const ITEM = '11111111-1111-4111-8111-111111111111'
const VERSION = '22222222-2222-4222-8222-222222222222'
const COURSE = '66666666-6666-4666-8666-666666666666'
const MEDIA = '44444444-4444-4444-8444-444444444444'
const OTHER_MEDIA = '55555555-5555-4555-8555-555555555555'
const MEMBER = '33333333-3333-4333-8333-333333333333'
const OTHER_MEMBER = '33333333-3333-4333-8333-333333333334'
const SCOPE = '77777777-7777-4777-8777-777777777777'
const SCOPE_REVISION = '88888888-8888-4888-8888-888888888888'
const SCOPE_RULE = '99999999-9999-4999-8999-999999999999'
const STORAGE_KEY =
  'elearning-media/2026-08/44444444-4444-4444-8444-444444444444.mp4'
const MIME = 'video/mp4'
const SIZE = 1024
const NOW = new Date('2026-08-25T12:00:00.000Z')
const PLAYBACK_SECRET = 'playback-signing-secret-min-32chars!'
const JWT_SECRET = 'jwt-secret-must-remain-unused-32b!!'

interface ItemRow {
  id: string
  versionId: string
  itemType: string
  mediaId: string
  versionStatus: string
  courseStatus: string
  mediaStatus: string
  storageKey: string
  mimeType: string
  sizeBytes: number
  activeVersionId?: string | null
  scopeId?: string | null
  scopeRevisionId?: string | null
  scopeRuleId?: string | null
  scopeSubjectType?: 'all' | 'user'
  scopeSubjectRef?: string | null
}

interface MemberRow {
  id: string
  userId: string
  versionId: string
  revokedAt: string | null
}

interface Mem {
  item: ItemRow | null
  members: MemberRow[]
  queries: Array<{ sql: string; params: unknown[] }>
}

function tagOf(sql: string): string | null {
  const match = /\/\* (elearning-(?:playback|access):[a-z-]+) \*\//.exec(sql)
  return match ? match[1] : null
}

function createMemoryDb(seed: Partial<Mem> = {}): {
  db: ElearningPlaybackDb
  mem: Mem
} {
  const mem: Mem = {
    item: {
      id: ITEM,
      versionId: VERSION,
      itemType: 'video',
      mediaId: MEDIA,
      versionStatus: 'published',
      courseStatus: 'active',
      mediaStatus: 'ready',
      storageKey: STORAGE_KEY,
      mimeType: MIME,
      sizeBytes: SIZE,
    },
    members: [
      { id: MEMBER, userId: USER, versionId: VERSION, revokedAt: null },
    ],
    queries: [],
    ...seed,
  }
  if (seed.item !== undefined) mem.item = seed.item
  if (seed.members) mem.members = seed.members

  const query: ElearningPlaybackQueryable['query'] = async (
    sql,
    params = [],
  ) => {
    mem.queries.push({ sql, params })
    const tag = tagOf(sql)
    const item = mem.item
    if (tag === 'elearning-playback:load-item') {
      expect(sql).toContain('$1')
      expect(sql).toContain('$2')
      expect(sql).not.toContain(ORG)
      expect(sql).not.toContain(STORAGE_KEY)
      if (!item || params[0] !== ORG || params[1] !== item.id)
        return { rows: [], rowCount: 0 }
      return {
        rows: [
          {
            id: item.id,
            course_version_id: item.versionId,
            item_type: item.itemType,
            media_id: item.mediaId,
            version_status: item.versionStatus,
            course_status: item.courseStatus,
            media_status: item.mediaStatus,
            storage_key: item.storageKey,
            mime_type: item.mimeType,
            size_bytes: String(item.sizeBytes),
          },
        ],
        rowCount: 1,
      }
    }
    if (tag === 'elearning-access:lock-course') {
      if (!item || params[0] !== ORG || params[1] !== item.versionId) {
        return { rows: [], rowCount: 0 }
      }
      return {
        rows: [
          {
            course_id: COURSE,
            course_status: item.courseStatus,
            active_version_id:
              item.activeVersionId === undefined
                ? item.versionId
                : item.activeVersionId,
            scope_id: item.scopeId ?? null,
            version_status: item.versionStatus,
          },
        ],
        rowCount: 1,
      }
    }
    if (tag === 'elearning-access:lock-assignment') {
      expect(sql).toContain('$1')
      expect(sql).toContain('$2')
      expect(sql).toContain('$3')
      const member = mem.members.find(
        (row) =>
          params[0] === ORG &&
          params[1] === row.userId &&
          params[2] === row.versionId &&
          row.revokedAt === null,
      )
      if (!member) return { rows: [], rowCount: 0 }
      return { rows: [{ id: member.id }], rowCount: 1 }
    }
    if (tag === 'elearning-access:lock-scope') {
      if (
        !item ||
        params[0] !== ORG ||
        params[1] !== item.scopeId ||
        !item.scopeRevisionId
      ) {
        return { rows: [], rowCount: 0 }
      }
      return {
        rows: [{ active_revision_id: item.scopeRevisionId }],
        rowCount: 1,
      }
    }
    if (tag === 'elearning-access:match-rule') {
      if (
        !item ||
        params[0] !== ORG ||
        params[1] !== item.scopeRevisionId ||
        !item.scopeRuleId
      ) {
        return { rows: [], rowCount: 0 }
      }
      const matches =
        item.scopeSubjectType !== 'user' || item.scopeSubjectRef === params[2]
      return matches
        ? { rows: [{ id: item.scopeRuleId }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    }
    throw new Error('unexpected query')
  }
  const db: ElearningPlaybackDb = {
    query,
    transaction: async (handler) => handler({ query }),
  }
  return { db, mem }
}

function decodeClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[0]
  return JSON.parse(
    Buffer.from(payload, 'base64url').toString('utf8'),
  ) as Record<string, unknown>
}

function assertValuesFree(error: unknown): void {
  expect(error).toBeInstanceOf(ElearningPlaybackError)
  const err = error as ElearningPlaybackError
  const blob = `${err.message}\n${err.stack ?? ''}\n${JSON.stringify(err)}`
  expect(blob).not.toContain(ORG)
  expect(blob).not.toContain(USER)
  expect(blob).not.toContain(OTHER_USER)
  expect(blob).not.toContain(MEDIA)
  expect(blob).not.toContain(OTHER_MEDIA)
  expect(blob).not.toContain(STORAGE_KEY)
  expect(blob).not.toContain(PLAYBACK_SECRET)
  expect(blob).not.toContain(JWT_SECRET)
  expect(blob).not.toContain('answer_key')
  expect(blob).not.toContain('answerKey')
  expect(blob).not.toMatch(/elearning-media\//)
  expect(err.message).toBe(err.code)
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn()
    throw new Error(`expected ${code}`)
  } catch (error) {
    expect((error as ElearningPlaybackError).code).toBe(code)
    assertValuesFree(error)
  }
}

async function expectAsyncCode(
  fn: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await fn()
    throw new Error(`expected ${code}`)
  } catch (error) {
    expect((error as ElearningPlaybackError).code).toBe(code)
    assertValuesFree(error)
  }
}

const sampleClaims = (): ElearningMediaPlaybackClaims => ({
  v: ELEARNING_MEDIA_PLAYBACK_TOKEN_VERSION,
  typ: ELEARNING_MEDIA_PLAYBACK_TYP,
  org: ORG,
  sub: USER,
  item: ITEM,
  media: MEDIA,
  jti: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  iat: 1787659200,
  exp: 1787659800,
})

describe('playback signing secret', () => {
  it('fails closed for missing, short, weak, and JWT-secret reuse', () => {
    expectCode(
      () => requireElearningMediaPlaybackSigningSecret(undefined, JWT_SECRET),
      'unavailable',
    )
    expectCode(
      () => requireElearningMediaPlaybackSigningSecret('   ', JWT_SECRET),
      'unavailable',
    )
    expectCode(
      () =>
        requireElearningMediaPlaybackSigningSecret(
          'x'.repeat(ELEARNING_MEDIA_PLAYBACK_SECRET_MIN_LENGTH - 1),
          JWT_SECRET,
        ),
      'unavailable',
    )
    expectCode(
      () =>
        requireElearningMediaPlaybackSigningSecret(
          'dev-secret-key',
          JWT_SECRET,
        ),
      'unavailable',
    )
    expectCode(
      () => requireElearningMediaPlaybackSigningSecret(JWT_SECRET, JWT_SECRET),
      'unavailable',
    )
    expect(
      requireElearningMediaPlaybackSigningSecret(PLAYBACK_SECRET, JWT_SECRET),
    ).toBe(PLAYBACK_SECRET)
  })

  it('reads only the dedicated env name and never falls back to JWT_SECRET', () => {
    expectCode(
      () =>
        readElearningMediaPlaybackSigningSecret({
          JWT_SECRET,
        } as NodeJS.ProcessEnv),
      'unavailable',
    )
    expect(
      readElearningMediaPlaybackSigningSecret({
        [ELEARNING_MEDIA_PLAYBACK_SECRET_ENV]: PLAYBACK_SECRET,
        JWT_SECRET,
      } as NodeJS.ProcessEnv),
    ).toBe(PLAYBACK_SECRET)
  })
})

describe('HMAC playback token', () => {
  it('signs v1 exact-schema claims as HMAC-SHA256 base64url and verifies with constant-time compare', () => {
    const claims = sampleClaims()
    const token = signElearningMediaPlaybackToken(
      claims,
      PLAYBACK_SECRET,
      JWT_SECRET,
    )
    expect(token.split('.')).toHaveLength(2)
    const [payloadB64, sig] = token.split('.')
    const expected = createHmac('sha256', PLAYBACK_SECRET).update(payloadB64, 'ascii').digest().toString('base64url')
    expect(sig).toBe(expected)
    const parsed = decodeClaims(token)
    expect(Object.keys(parsed)).toEqual([
      ...ELEARNING_MEDIA_PLAYBACK_CLAIM_KEYS,
    ])
    expect(parsed).toEqual(claims)
    expect(JSON.stringify(parsed)).not.toContain('storage_key')
    expect(JSON.stringify(parsed)).not.toContain(STORAGE_KEY)
    expect(
      verifyElearningMediaPlaybackToken(
        token,
        PLAYBACK_SECRET,
        JWT_SECRET,
        NOW,
      ),
    ).toEqual(claims)
  })

  it('rejects tamper, extra claims, TTL above 10 minutes, and expiry', () => {
    const token = signElearningMediaPlaybackToken(
      sampleClaims(),
      PLAYBACK_SECRET,
      JWT_SECRET,
    )
    const [payloadB64] = token.split('.')
    const tampered = `${payloadB64}.${'A'.repeat(43)}`
    expectCode(
      () =>
        verifyElearningMediaPlaybackToken(
          tampered,
          PLAYBACK_SECRET,
          JWT_SECRET,
          NOW,
        ),
      'invalid_token',
    )
    const extra = Buffer.from(
      JSON.stringify({ ...sampleClaims(), extra: 1 }),
      'utf8',
    ).toString('base64url')
    const extraSig = createHmac('sha256', PLAYBACK_SECRET)
      .update(extra, 'ascii')
      .digest()
      .toString('base64url')
    expectCode(
      () =>
        verifyElearningMediaPlaybackToken(
          `${extra}.${extraSig}`,
          PLAYBACK_SECRET,
          JWT_SECRET,
          NOW,
        ),
      'invalid_token',
    )
    const longTtl = {
      ...sampleClaims(),
      iat: 1787659200,
      exp: 1787659200 + ELEARNING_MEDIA_PLAYBACK_TTL_MAX_SECONDS + 1,
    }
    expectCode(
      () => signElearningMediaPlaybackToken(longTtl, PLAYBACK_SECRET, JWT_SECRET)
        && verifyElearningMediaPlaybackToken(
          signElearningMediaPlaybackToken(longTtl, PLAYBACK_SECRET, JWT_SECRET),
          PLAYBACK_SECRET,
          JWT_SECRET,
          NOW,
        ),
      'invalid_token',
    )
    expectCode(
      () =>
        verifyElearningMediaPlaybackToken(
          token,
          PLAYBACK_SECRET,
          JWT_SECRET,
          new Date(NOW.getTime() + 601_000),
        ),
      'token_expired',
    )
  })
})

describe('parseElearningMediaHttpByteRange', () => {
  it('parses absent, start-end, open-end, and suffix into a capped single range', () => {
    expect(parseElearningMediaHttpByteRange(undefined, 100)).toEqual({
      start: 0,
      end: 99,
      size: 100,
      length: 100,
      complete: true,
      absent: true,
      httpStatus: 200,
      contentRange: null,
    })
    expect(parseElearningMediaHttpByteRange('bytes=10-19', 100)).toEqual({
      start: 10,
      end: 19,
      size: 100,
      length: 10,
      complete: false,
      absent: false,
      httpStatus: 206,
      contentRange: 'bytes 10-19/100',
    })
    expect(parseElearningMediaHttpByteRange('bytes=90-', 100)).toEqual({
      start: 90,
      end: 99,
      size: 100,
      length: 10,
      complete: false,
      absent: false,
      httpStatus: 206,
      contentRange: 'bytes 90-99/100',
    })
    expect(parseElearningMediaHttpByteRange('bytes=-20', 100)).toEqual({
      start: 80,
      end: 99,
      size: 100,
      length: 20,
      complete: false,
      absent: false,
      httpStatus: 206,
      contentRange: 'bytes 80-99/100',
    })
  })

  it('never authorizes a span above ELEARNING_MEDIA_RANGE_MAX_BYTES', () => {
    const size = ELEARNING_MEDIA_RANGE_MAX_BYTES + 4096
    const absent = parseElearningMediaHttpByteRange(null, size)
    expect(absent).toEqual({
      start: 0,
      end: ELEARNING_MEDIA_RANGE_MAX_BYTES - 1,
      size,
      length: ELEARNING_MEDIA_RANGE_MAX_BYTES,
      complete: false,
      absent: true,
      httpStatus: 206,
      contentRange: `bytes 0-${ELEARNING_MEDIA_RANGE_MAX_BYTES - 1}/${size}`,
    })
    const open = parseElearningMediaHttpByteRange('bytes=0-', size)
    expect(open.length).toBe(ELEARNING_MEDIA_RANGE_MAX_BYTES)
    expect(open.end).toBe(ELEARNING_MEDIA_RANGE_MAX_BYTES - 1)
    const huge = parseElearningMediaHttpByteRange(`bytes=0-${size - 1}`, size)
    expect(huge.length).toBe(ELEARNING_MEDIA_RANGE_MAX_BYTES)
    const suffix = parseElearningMediaHttpByteRange(`bytes=-${size}`, size)
    expect(suffix.length).toBe(ELEARNING_MEDIA_RANGE_MAX_BYTES)
    expect(suffix.end).toBe(size - 1)
    expect(suffix.start).toBe(size - ELEARNING_MEDIA_RANGE_MAX_BYTES)
  })

  it('rejects multi-range, malformed, and unsatisfiable headers with typed values-free errors', () => {
    expectCode(
      () => parseElearningMediaHttpByteRange('bytes=0-1,2-3', 100),
      'invalid_range',
    )
    expectCode(
      () => parseElearningMediaHttpByteRange('bytes=0-1, 2-3', 100),
      'invalid_range',
    )
    expectCode(
      () => parseElearningMediaHttpByteRange('BYTES=0-1', 100),
      'invalid_range',
    )
    expectCode(
      () => parseElearningMediaHttpByteRange('bytes=abc', 100),
      'invalid_range',
    )
    expectCode(
      () => parseElearningMediaHttpByteRange('bytes=01-02', 100),
      'invalid_range',
    )
    expectCode(() => parseElearningMediaHttpByteRange('', 100), 'invalid_range')
    expectCode(
      () => parseElearningMediaHttpByteRange(['bytes=0-1'], 100),
      'invalid_range',
    )
    expectCode(
      () => parseElearningMediaHttpByteRange('bytes=1-0', 100),
      'unsatisfiable_range',
    )
    expectCode(
      () => parseElearningMediaHttpByteRange('bytes=100-200', 100),
      'unsatisfiable_range',
    )
    expectCode(
      () => parseElearningMediaHttpByteRange('bytes=-0', 100),
      'unsatisfiable_range',
    )
  })
})

describe('issueElearningMediaPlaybackTicket', () => {
  it('issues a bound ticket after same-org video/ready/assignment checks and hides storage keys', async () => {
    const { db, mem } = createMemoryDb()
    const ticket = await issueElearningMediaPlaybackTicket(db, {
      orgId: ORG,
      userId: USER,
      itemId: ITEM,
      playbackSigningSecret: PLAYBACK_SECRET,
      jwtSecret: JWT_SECRET,
      now: NOW,
    })
    expect(mem.queries.map((row) => tagOf(row.sql))).toEqual([
      'elearning-playback:load-item',
      'elearning-access:lock-course',
      'elearning-access:lock-assignment',
    ])
    expect(ticket.itemId).toBe(ITEM)
    expect(ticket.mediaId).toBe(MEDIA)
    expect(ticket.ttlSeconds).toBe(ELEARNING_MEDIA_PLAYBACK_TTL_MAX_SECONDS)
    const blob = JSON.stringify(ticket)
    expect(blob).not.toContain('storage_key')
    expect(blob).not.toContain(STORAGE_KEY)
    expect(blob).not.toContain('answer_key')
    const claims = decodeClaims(ticket.token)
    expect(Object.keys(claims)).toEqual([
      ...ELEARNING_MEDIA_PLAYBACK_CLAIM_KEYS,
    ])
    expect(claims.org).toBe(ORG)
    expect(claims.sub).toBe(USER)
    expect(claims.item).toBe(ITEM)
    expect(claims.media).toBe(MEDIA)
    expect(claims).not.toHaveProperty('storage_key')
    expect(typeof claims.jti).toBe('string')
  })

  it('issues a ticket for active self-study visibility without an assignment', async () => {
    const { db, mem } = createMemoryDb({
      members: [],
      item: {
        id: ITEM,
        versionId: VERSION,
        itemType: 'video',
        mediaId: MEDIA,
        versionStatus: 'published',
        courseStatus: 'active',
        mediaStatus: 'ready',
        storageKey: STORAGE_KEY,
        mimeType: MIME,
        sizeBytes: SIZE,
        activeVersionId: VERSION,
        scopeId: SCOPE,
        scopeRevisionId: SCOPE_REVISION,
        scopeRuleId: SCOPE_RULE,
        scopeSubjectType: 'all',
        scopeSubjectRef: null,
      },
    })
    await expect(
      issueElearningMediaPlaybackTicket(db, {
        orgId: ORG,
        userId: USER,
        itemId: ITEM,
        playbackSigningSecret: PLAYBACK_SECRET,
        jwtSecret: JWT_SECRET,
        now: NOW,
      }),
    ).resolves.toMatchObject({ itemId: ITEM, mediaId: MEDIA })
    expect(mem.members).toEqual([])
    expect(mem.queries.map((row) => tagOf(row.sql))).toEqual([
      'elearning-playback:load-item',
      'elearning-access:lock-course',
      'elearning-access:lock-assignment',
      'elearning-access:lock-scope',
      'elearning-access:match-rule',
    ])
  })

  it('rejects invalid input, missing assignment, withdrawn course, and non-playable items', async () => {
    const { db } = createMemoryDb()
    await expectAsyncCode(
      () =>
        issueElearningMediaPlaybackTicket(db, {
          orgId: '',
          userId: USER,
          itemId: ITEM,
          playbackSigningSecret: PLAYBACK_SECRET,
          jwtSecret: JWT_SECRET,
        }),
      'invalid_input',
    )
    await expectAsyncCode(
      () =>
        issueElearningMediaPlaybackTicket(db, {
          orgId: ORG,
          userId: USER,
          itemId: ITEM,
          playbackSigningSecret: PLAYBACK_SECRET,
          jwtSecret: JWT_SECRET,
          ttlSeconds: ELEARNING_MEDIA_PLAYBACK_TTL_MAX_SECONDS + 1,
        }),
      'invalid_input',
    )

    const missing = createMemoryDb({ item: null })
    await expectAsyncCode(
      () =>
        issueElearningMediaPlaybackTicket(missing.db, {
          orgId: ORG,
          userId: USER,
          itemId: ITEM,
          playbackSigningSecret: PLAYBACK_SECRET,
          jwtSecret: JWT_SECRET,
        }),
      'not_found',
    )

    const withdrawn = createMemoryDb({
      item: {
        id: ITEM,
        versionId: VERSION,
        itemType: 'video',
        mediaId: MEDIA,
        versionStatus: 'published',
        courseStatus: 'withdrawn',
        mediaStatus: 'ready',
        storageKey: STORAGE_KEY,
        mimeType: MIME,
        sizeBytes: SIZE,
      },
    })
    await expectAsyncCode(
      () =>
        issueElearningMediaPlaybackTicket(withdrawn.db, {
          orgId: ORG,
          userId: USER,
          itemId: ITEM,
          playbackSigningSecret: PLAYBACK_SECRET,
          jwtSecret: JWT_SECRET,
        }),
      'course_withdrawn',
    )

    const revoked = createMemoryDb({
      members: [
        { id: MEMBER, userId: USER, versionId: VERSION, revokedAt: 'now' },
      ],
    })
    await expectAsyncCode(
      () =>
        issueElearningMediaPlaybackTicket(revoked.db, {
          orgId: ORG,
          userId: USER,
          itemId: ITEM,
          playbackSigningSecret: PLAYBACK_SECRET,
          jwtSecret: JWT_SECRET,
        }),
      'assignment_unavailable',
    )

    const exam = createMemoryDb({
      item: {
        id: ITEM,
        versionId: VERSION,
        itemType: 'exam',
        mediaId: MEDIA,
        versionStatus: 'published',
        courseStatus: 'active',
        mediaStatus: 'ready',
        storageKey: STORAGE_KEY,
        mimeType: MIME,
        sizeBytes: SIZE,
      },
    })
    await expectAsyncCode(
      () =>
        issueElearningMediaPlaybackTicket(exam.db, {
          orgId: ORG,
          userId: USER,
          itemId: ITEM,
          playbackSigningSecret: PLAYBACK_SECRET,
          jwtSecret: JWT_SECRET,
        }),
      'unsupported_item',
    )

    const probing = createMemoryDb({
      item: {
        id: ITEM,
        versionId: VERSION,
        itemType: 'video',
        mediaId: MEDIA,
        versionStatus: 'published',
        courseStatus: 'active',
        mediaStatus: 'probing',
        storageKey: STORAGE_KEY,
        mimeType: MIME,
        sizeBytes: SIZE,
      },
    })
    await expectAsyncCode(
      () =>
        issueElearningMediaPlaybackTicket(probing.db, {
          orgId: ORG,
          userId: USER,
          itemId: ITEM,
          playbackSigningSecret: PLAYBACK_SECRET,
          jwtSecret: JWT_SECRET,
        }),
      'unsupported_item',
    )
  })
})

describe('authorizeElearningMediaPlayback', () => {
  async function issued(over: Partial<ItemRow> = {}) {
    const { db, mem } = createMemoryDb({
      item: {
        id: ITEM,
        versionId: VERSION,
        itemType: 'video',
        mediaId: MEDIA,
        versionStatus: 'published',
        courseStatus: 'active',
        mediaStatus: 'ready',
        storageKey: STORAGE_KEY,
        mimeType: MIME,
        sizeBytes: SIZE,
        ...over,
      },
    })
    const ticket = await issueElearningMediaPlaybackTicket(db, {
      orgId: ORG,
      userId: USER,
      itemId: ITEM,
      playbackSigningSecret: PLAYBACK_SECRET,
      jwtSecret: JWT_SECRET,
      now: NOW,
    })
    return { db, mem, ticket }
  }

  it('rechecks DB access and returns storage key, mime, and size only after a valid token', async () => {
    const { db, mem, ticket } = await issued()
    mem.queries.length = 0
    const auth = await authorizeElearningMediaPlayback(db, {
      token: ticket.token,
      orgId: ORG,
      userId: USER,
      rangeHeader: 'bytes=0-99',
      playbackSigningSecret: PLAYBACK_SECRET,
      jwtSecret: JWT_SECRET,
      now: NOW,
    })
    expect(mem.queries.map((row) => tagOf(row.sql))).toEqual([
      'elearning-playback:load-item',
      'elearning-access:lock-course',
      'elearning-access:lock-assignment',
    ])
    expect(auth).toEqual({
      storageKey: STORAGE_KEY,
      mimeType: MIME,
      sizeBytes: SIZE,
      range: {
        start: 0,
        end: 99,
        size: SIZE,
        length: 100,
        complete: false,
        absent: false,
        httpStatus: 206,
        contentRange: `bytes 0-99/${SIZE}`,
      },
    })
  })

  it('uses a bounded first chunk when Range is absent', async () => {
    const { db, ticket } = await issued()
    const auth = await authorizeElearningMediaPlayback(db, {
      token: ticket.token,
      orgId: ORG,
      userId: USER,
      playbackSigningSecret: PLAYBACK_SECRET,
      jwtSecret: JWT_SECRET,
      now: NOW,
    })
    expect(auth.range.absent).toBe(true)
    expect(auth.range.start).toBe(0)
    expect(auth.range.end).toBe(SIZE - 1)
    expect(auth.range.httpStatus).toBe(200)
    expect(auth.range.length).toBeLessThanOrEqual(
      ELEARNING_MEDIA_RANGE_MAX_BYTES,
    )
  })

  it('fails revocation, withdrawal, cross-org, tamper, and expiry after issue', async () => {
    const { db, mem, ticket } = await issued()
    mem.members = [
      { id: MEMBER, userId: USER, versionId: VERSION, revokedAt: 'now' },
    ]
    await expectAsyncCode(
      () =>
        authorizeElearningMediaPlayback(db, {
          token: ticket.token,
          orgId: ORG,
          userId: USER,
          playbackSigningSecret: PLAYBACK_SECRET,
          jwtSecret: JWT_SECRET,
          now: NOW,
        }),
      'assignment_unavailable',
    )

    const withdrawn = await issued()
    if (withdrawn.mem.item) withdrawn.mem.item.courseStatus = 'withdrawn'
    await expectAsyncCode(
      () =>
        authorizeElearningMediaPlayback(withdrawn.db, {
          token: withdrawn.ticket.token,
          orgId: ORG,
          userId: USER,
          playbackSigningSecret: PLAYBACK_SECRET,
          jwtSecret: JWT_SECRET,
          now: NOW,
        }),
      'course_withdrawn',
    )

    const live = await issued()
    await expectAsyncCode(
      () =>
        authorizeElearningMediaPlayback(live.db, {
          token: live.ticket.token,
          orgId: 'org-other',
          userId: USER,
          playbackSigningSecret: PLAYBACK_SECRET,
          jwtSecret: JWT_SECRET,
          now: NOW,
        }),
      'invalid_token',
    )

    const [payloadB64] = live.ticket.token.split('.')
    await expectAsyncCode(
      () =>
        authorizeElearningMediaPlayback(live.db, {
          token: `${payloadB64}.${'B'.repeat(43)}`,
          orgId: ORG,
          userId: USER,
          playbackSigningSecret: PLAYBACK_SECRET,
          jwtSecret: JWT_SECRET,
          now: NOW,
        }),
      'invalid_token',
    )

    await expectAsyncCode(
      () =>
        authorizeElearningMediaPlayback(live.db, {
          token: live.ticket.token,
          orgId: ORG,
          userId: USER,
          playbackSigningSecret: PLAYBACK_SECRET,
          jwtSecret: JWT_SECRET,
          now: new Date(NOW.getTime() + 601_000),
        }),
      'token_expired',
    )
  })

  it('rejects a valid issued ticket presented by a different same-org assigned user', async () => {
    const { db, mem, ticket } = await issued()
    mem.members = [
      { id: MEMBER, userId: USER, versionId: VERSION, revokedAt: null },
      {
        id: OTHER_MEMBER,
        userId: OTHER_USER,
        versionId: VERSION,
        revokedAt: null,
      },
    ]
    await expectAsyncCode(
      () =>
        authorizeElearningMediaPlayback(db, {
          token: ticket.token,
          orgId: ORG,
          userId: OTHER_USER,
          playbackSigningSecret: PLAYBACK_SECRET,
          jwtSecret: JWT_SECRET,
          now: NOW,
        }),
      'invalid_token',
    )
  })

  it('rejects a correctly HMAC-signed exact-schema ticket whose media claim differs from the current item', async () => {
    const { db } = createMemoryDb()
    const claims: ElearningMediaPlaybackClaims = {
      ...sampleClaims(),
      media: OTHER_MEDIA,
    }
    const token = signElearningMediaPlaybackToken(
      claims,
      PLAYBACK_SECRET,
      JWT_SECRET,
    )
    expect(
      verifyElearningMediaPlaybackToken(
        token,
        PLAYBACK_SECRET,
        JWT_SECRET,
        NOW,
      ),
    ).toEqual(claims)
    expect(claims.item).toBe(ITEM)
    expect(claims.media).not.toBe(MEDIA)
    await expectAsyncCode(
      () =>
        authorizeElearningMediaPlayback(db, {
          token,
          orgId: ORG,
          userId: USER,
          playbackSigningSecret: PLAYBACK_SECRET,
          jwtSecret: JWT_SECRET,
          now: NOW,
        }),
      'not_found',
    )
  })

  it('allows a retired pinned version and archived course when assignment remains unrevoked', async () => {
    const retired = await issued({ versionStatus: 'retired' })
    await expect(
      authorizeElearningMediaPlayback(retired.db, {
        token: retired.ticket.token,
        orgId: ORG,
        userId: USER,
        rangeHeader: 'bytes=0-1',
        playbackSigningSecret: PLAYBACK_SECRET,
        jwtSecret: JWT_SECRET,
        now: NOW,
      }),
    ).resolves.toMatchObject({
      storageKey: STORAGE_KEY,
      mimeType: MIME,
      sizeBytes: SIZE,
    })

    const archived = await issued({ courseStatus: 'archived' })
    await expect(
      authorizeElearningMediaPlayback(archived.db, {
        token: archived.ticket.token,
        orgId: ORG,
        userId: USER,
        playbackSigningSecret: PLAYBACK_SECRET,
        jwtSecret: JWT_SECRET,
        now: NOW,
      }),
    ).resolves.toMatchObject({ storageKey: STORAGE_KEY })
  })
})
