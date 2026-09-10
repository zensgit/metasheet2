import { describe, expect, it } from 'vitest'

import {
  ElearningPortalSettingsError,
  getActiveElearningPortalSettings,
  hashElearningPortalSettingsRequest,
  normalizeElearningPortalSettings,
  publishElearningPortalSettings,
  type ElearningPortalDb,
  type ElearningPortalQueryable,
} from '../../src/services/elearning-portal-settings'

const ORG = 'org-portal'
const OTHER_ORG = 'org-portal-other'
const ACTOR = 'actor-portal'
const REQUEST_1 = '11111111-1111-4111-8111-111111111111'
const REQUEST_2 = '22222222-2222-4222-8222-222222222222'
const CREATED_AT = '2026-08-30T01:02:03.456Z'

const SETTINGS = {
  siteName: 'MetaSheet Academy',
  tagline: 'Learn together',
  bannerUrl: 'https://assets.example.test/banner.png',
  navigation: [
    { label: 'My courses', href: '/elearning' },
    { label: 'My wallet', href: '/elearning/wallet' },
  ],
}

interface RevisionRow {
  id: string
  orgId: string
  version: number
  siteName: string
  tagline: string | null
  bannerUrl: string | null
  createdAt: string
}

class FakePortalDb implements ElearningPortalDb, ElearningPortalQueryable {
  readonly heads = new Map<string, { revisionId: string; latestVersion: number }>()
  readonly revisions = new Map<string, RevisionRow>()
  readonly navigation = new Map<string, Array<{ position: number; label: string; href: string }>>()
  readonly requests = new Map<string, {
    requestHash: string
    requestHashVersion: number
    revisionId: string
  }>()

  transaction<T>(handler: (tx: ElearningPortalQueryable) => Promise<T>): Promise<T> {
    return handler(this)
  }

  async query(sql: string, params: unknown[] = []) {
    if (sql.includes('elearning-portal:request-lock') || sql.includes('elearning-portal:head-lock')) {
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('elearning-portal:load-request')) {
      const row = this.requests.get(`${String(params[0])}:${String(params[1])}`)
      return {
        rows: row ? [{
          request_hash: row.requestHash,
          request_hash_version: row.requestHashVersion,
          revision_id: row.revisionId,
        }] : [],
        rowCount: row ? 1 : 0,
      }
    }
    if (sql.includes('elearning-portal:load-head-for-update')) {
      const row = this.heads.get(String(params[0]))
      return {
        rows: row ? [{ latest_version: row.latestVersion }] : [],
        rowCount: row ? 1 : 0,
      }
    }
    if (sql.includes('elearning-portal:insert-revision')) {
      const [id, orgId, version, siteName, tagline, bannerUrl] = params
      this.revisions.set(`${String(orgId)}:${String(id)}`, {
        id: String(id),
        orgId: String(orgId),
        version: Number(version),
        siteName: String(siteName),
        tagline: tagline === null ? null : String(tagline),
        bannerUrl: bannerUrl === null ? null : String(bannerUrl),
        createdAt: CREATED_AT,
      })
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('elearning-portal:insert-navigation')) {
      const [orgId, revisionId, position, label, href] = params
      const key = `${String(orgId)}:${String(revisionId)}`
      const rows = this.navigation.get(key) ?? []
      rows.push({ position: Number(position), label: String(label), href: String(href) })
      this.navigation.set(key, rows)
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('elearning-portal:insert-request')) {
      const [orgId, requestId, requestHash, requestHashVersion, _actorId, revisionId] = params
      this.requests.set(`${String(orgId)}:${String(requestId)}`, {
        requestHash: String(requestHash),
        requestHashVersion: Number(requestHashVersion),
        revisionId: String(revisionId),
      })
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('elearning-portal:insert-head')) {
      this.heads.set(String(params[0]), {
        revisionId: String(params[1]),
        latestVersion: Number(params[2]),
      })
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('elearning-portal:update-head')) {
      const [revisionId, version, orgId, expectedVersion] = params
      const row = this.heads.get(String(orgId))
      if (!row || row.latestVersion !== Number(expectedVersion)) return { rows: [], rowCount: 0 }
      this.heads.set(String(orgId), {
        revisionId: String(revisionId),
        latestVersion: Number(version),
      })
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('elearning-portal:load-head')) {
      const row = this.heads.get(String(params[0]))
      return {
        rows: row ? [{
          active_revision_id: row.revisionId,
          latest_version: row.latestVersion,
        }] : [],
        rowCount: row ? 1 : 0,
      }
    }
    if (sql.includes('elearning-portal:load-revision')) {
      const key = `${String(params[0])}:${String(params[1])}`
      const revision = this.revisions.get(key)
      if (!revision) return { rows: [], rowCount: 0 }
      const nav = this.navigation.get(key) ?? []
      const rows = nav.length === 0 ? [{
        revision_id: revision.id,
        version: revision.version,
        site_name: revision.siteName,
        tagline: revision.tagline,
        banner_url: revision.bannerUrl,
        created_at: revision.createdAt,
        position: null,
        label: null,
        href: null,
      }] : nav.map((item) => ({
        revision_id: revision.id,
        version: revision.version,
        site_name: revision.siteName,
        tagline: revision.tagline,
        banner_url: revision.bannerUrl,
        created_at: revision.createdAt,
        position: item.position,
        label: item.label,
        href: item.href,
      }))
      return { rows, rowCount: rows.length }
    }
    throw new Error(`unexpected query: ${sql}`)
  }
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject<ElearningPortalSettingsError>({ code })
}

describe('e-learning portal settings', () => {
  it('normalizes the closed portal shape and preserves ordered navigation', () => {
    expect(normalizeElearningPortalSettings({
      siteName: '  MetaSheet Academy ',
      tagline: ' Learn together ',
      bannerUrl: ' /assets/banner.png ',
      navigation: [{ label: ' Home ', href: ' /elearning ' }],
    })).toEqual({
      siteName: 'MetaSheet Academy',
      tagline: 'Learn together',
      bannerUrl: '/assets/banner.png',
      navigation: [{ label: 'Home', href: '/elearning' }],
    })
  })

  it.each([
    { ...SETTINGS, siteName: '' },
    { ...SETTINGS, siteName: 'x'.repeat(81) },
    { ...SETTINGS, tagline: 'x'.repeat(161) },
    { ...SETTINGS, bannerUrl: 'http://assets.example.test/banner.png' },
    { ...SETTINGS, bannerUrl: 'https://user@assets.example.test/banner.png' },
    { ...SETTINGS, bannerUrl: '//assets.example.test/banner.png' },
    { ...SETTINGS, navigation: Array.from({ length: 9 }, (_, i) => ({ label: `L${i}`, href: `/p/${i}` })) },
    { ...SETTINGS, navigation: [{ label: 'External', href: 'https://example.test' }] },
    { ...SETTINGS, navigation: [{ label: 'Bad', href: '/bad\\path' }] },
    { ...SETTINGS, navigation: [{ label: 'A', href: '/same' }, { label: 'B', href: '/same' }] },
    { ...SETTINGS, navigation: [{ label: 'A', href: '/a', extra: true }] },
  ])('rejects an unsafe or non-closed portal payload %#', (input) => {
    expect(() => normalizeElearningPortalSettings(input)).toThrowError(
      expect.objectContaining({ code: 'invalid_input' }),
    )
  })

  it('hashes logical payloads deterministically while preserving navigation order', () => {
    const normalized = normalizeElearningPortalSettings(SETTINGS)
    expect(hashElearningPortalSettingsRequest(normalized))
      .toBe(hashElearningPortalSettingsRequest({ ...normalized }))
    expect(hashElearningPortalSettingsRequest(normalized)).not.toBe(
      hashElearningPortalSettingsRequest({
        ...normalized,
        navigation: [...normalized.navigation].reverse(),
      }),
    )
  })

  it('returns a closed empty default when the organization has no active revision', async () => {
    await expect(getActiveElearningPortalSettings(new FakePortalDb(), ORG)).resolves.toEqual({
      revisionId: null,
      version: 0,
      siteName: null,
      tagline: null,
      bannerUrl: null,
      navigation: [],
      createdAt: null,
    })
  })

  it('publishes immutable versions and replays the same request without another version', async () => {
    const db = new FakePortalDb()
    const first = await publishElearningPortalSettings(db, {
      orgId: ORG,
      actorId: ACTOR,
      requestId: REQUEST_1,
      ...SETTINGS,
    })
    const replay = await publishElearningPortalSettings(db, {
      orgId: ORG,
      actorId: ACTOR,
      requestId: REQUEST_1.toUpperCase(),
      ...SETTINGS,
    })
    const second = await publishElearningPortalSettings(db, {
      orgId: ORG,
      actorId: ACTOR,
      requestId: REQUEST_2,
      ...SETTINGS,
      tagline: 'Updated',
    })

    expect(first).toMatchObject({ version: 1, duplicate: false, ...SETTINGS })
    expect(replay).toEqual({ ...first, duplicate: true })
    expect(second).toMatchObject({ version: 2, duplicate: false, tagline: 'Updated' })
    expect(second.revisionId).not.toBe(first.revisionId)
    await expect(getActiveElearningPortalSettings(db, ORG)).resolves.toEqual({
      ...second,
      duplicate: undefined,
    })
  })

  it('rejects same-key different-payload replay and malformed request ids', async () => {
    const db = new FakePortalDb()
    await publishElearningPortalSettings(db, {
      orgId: ORG,
      actorId: ACTOR,
      requestId: REQUEST_1,
      ...SETTINGS,
    })
    await expectCode(publishElearningPortalSettings(db, {
      orgId: ORG,
      actorId: ACTOR,
      requestId: REQUEST_1,
      ...SETTINGS,
      siteName: 'Changed',
    }), 'conflict')
    await expectCode(publishElearningPortalSettings(db, {
      orgId: ORG,
      actorId: ACTOR,
      requestId: 'not-a-uuid',
      ...SETTINGS,
    }), 'invalid_input')
  })

  it('scopes request identities, active heads and reads by organization', async () => {
    const db = new FakePortalDb()
    await publishElearningPortalSettings(db, {
      orgId: ORG,
      actorId: ACTOR,
      requestId: REQUEST_1,
      ...SETTINGS,
    })
    await publishElearningPortalSettings(db, {
      orgId: OTHER_ORG,
      actorId: ACTOR,
      requestId: REQUEST_1,
      ...SETTINGS,
      siteName: 'Other Academy',
    })
    expect((await getActiveElearningPortalSettings(db, ORG)).siteName)
      .toBe('MetaSheet Academy')
    expect((await getActiveElearningPortalSettings(db, OTHER_ORG)).siteName)
      .toBe('Other Academy')
  })

  it('fails closed when stored rows are noncanonical or duplicated', async () => {
    const malformed: ElearningPortalQueryable = {
      query: async (sql) => sql.includes('load-head')
        ? {
            rows: [
              { active_revision_id: REQUEST_1, latest_version: 1 },
              { active_revision_id: REQUEST_2, latest_version: 2 },
            ],
            rowCount: 2,
          }
        : { rows: [], rowCount: 0 },
    }
    await expectCode(getActiveElearningPortalSettings(malformed, ORG), 'unavailable')

    const db = new FakePortalDb()
    const published = await publishElearningPortalSettings(db, {
      orgId: ORG,
      actorId: ACTOR,
      requestId: REQUEST_1,
      ...SETTINGS,
    })
    const key = `${ORG}:${published.revisionId}`
    const revision = db.revisions.get(key)
    if (!revision) throw new Error('missing fixture revision')
    revision.siteName = ' MetaSheet Academy '
    await expectCode(getActiveElearningPortalSettings(db, ORG), 'unavailable')

    revision.siteName = 'MetaSheet Academy'
    const head = db.heads.get(ORG)
    if (!head) throw new Error('missing fixture head')
    head.latestVersion += 1
    await expectCode(getActiveElearningPortalSettings(db, ORG), 'unavailable')
  })
})
