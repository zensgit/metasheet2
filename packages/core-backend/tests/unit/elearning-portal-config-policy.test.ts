import { describe, expect, it } from 'vitest'

import {
  ElearningPortalConfigPolicyError,
  createElearningPortalConfigSnapshot,
} from '../../src/services/elearning-portal-config-policy'

const SENTINEL = 'secret-portal-value'
const CONFIG_REVISION_ID = '10000000-0000-4000-8000-000000000001'
const LOGO_MEDIA_ID = '10000000-0000-4000-8000-000000000002'
const BANNER_MEDIA_ID = '10000000-0000-4000-8000-000000000003'
const CONTENT_ID = '10000000-0000-4000-8000-000000000004'

function config(overrides: Record<string, unknown> = {}) {
  return {
    banners: [
      {
        bannerKey: 'featured-course',
        mediaId: BANNER_MEDIA_ID,
        target: { contentId: CONTENT_ID, contentKind: 'course', kind: 'content' },
      },
      {
        bannerKey: 'announcement',
        mediaId: BANNER_MEDIA_ID,
        target: { kind: 'none' },
      },
    ],
    configRevisionId: CONFIG_REVISION_ID,
    logoMediaId: LOGO_MEDIA_ID,
    navigation: [
      {
        itemKey: 'learn',
        label: '学习中心',
        target: { destination: 'learning_center', kind: 'built_in' },
      },
      {
        itemKey: 'help',
        label: '帮助',
        target: { kind: 'external_https', url: 'https://example.com/help' },
      },
    ],
    orgId: 'org-1',
    platformName: 'MetaSheet 学习中心',
    tagline: '让知识在团队中流动',
    ...overrides,
  }
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error('expected portal config policy error')
  } catch (error) {
    expect(error).toBeInstanceOf(ElearningPortalConfigPolicyError)
    const policyError = error as ElearningPortalConfigPolicyError
    expect(policyError.code).toBe(code)
    expect(policyError.message).toBe(code)
    expect(policyError.cause).toBeUndefined()
    expect(`${policyError.message}\n${policyError.stack ?? ''}`).not.toContain(SENTINEL)
  }
}

describe('elearning portal config policy', () => {
  it('creates a deeply immutable closed portal snapshot', () => {
    const result = createElearningPortalConfigSnapshot(config())
    expect(result).toEqual({
      banners: [
        {
          bannerKey: 'featured-course',
          mediaId: BANNER_MEDIA_ID,
          target: { contentId: CONTENT_ID, contentKind: 'course', kind: 'content' },
        },
        {
          bannerKey: 'announcement',
          mediaId: BANNER_MEDIA_ID,
          target: { kind: 'none' },
        },
      ],
      configRevisionId: CONFIG_REVISION_ID,
      logoMediaId: LOGO_MEDIA_ID,
      navigation: [
        {
          itemKey: 'learn',
          label: '学习中心',
          target: { destination: 'learning_center', kind: 'built_in' },
        },
        {
          itemKey: 'help',
          label: '帮助',
          target: { kind: 'external_https', url: 'https://example.com/help' },
        },
      ],
      orgId: 'org-1',
      platformName: 'MetaSheet 学习中心',
      tagline: '让知识在团队中流动',
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.navigation)).toBe(true)
    expect(Object.isFrozen(result.banners)).toBe(true)
    expect([...result.navigation, ...result.banners].every((item) => (
      Object.isFrozen(item) && Object.isFrozen(item.target)
    ))).toBe(true)
  })

  it('supports the closed built-in destination and content-kind sets', () => {
    for (const destination of ['instructor_center', 'learning_center', 'my_learning']) {
      const result = createElearningPortalConfigSnapshot(config({
        navigation: [{
          itemKey: destination,
          label: destination,
          target: { destination, kind: 'built_in' },
        }],
      }))
      expect(result.navigation[0].target).toEqual({ destination, kind: 'built_in' })
    }
    for (const contentKind of [
      'course',
      'learning_map',
      'live',
      'offline_training',
      'training_plan',
    ]) {
      const result = createElearningPortalConfigSnapshot(config({
        banners: [{
          bannerKey: contentKind,
          mediaId: BANNER_MEDIA_ID,
          target: { contentId: CONTENT_ID, contentKind, kind: 'content' },
        }],
      }))
      expect(result.banners[0].target).toEqual({
        contentId: CONTENT_ID,
        contentKind,
        kind: 'content',
      })
    }
    const externalBanner = createElearningPortalConfigSnapshot(config({
      banners: [{
        bannerKey: 'external',
        mediaId: BANNER_MEDIA_ID,
        target: { kind: 'external_https', url: 'https://EXAMPLE.com/launch' },
      }],
    }))
    expect(externalBanner.banners[0].target).toEqual({
      kind: 'external_https',
      url: 'https://example.com/launch',
    })
  })

  it('normalizes safe HTTPS links and rejects unsafe link forms', () => {
    const normalized = createElearningPortalConfigSnapshot(config({
      navigation: [{
        itemKey: 'docs',
        label: 'Docs',
        target: { kind: 'external_https', url: '  https://EXAMPLE.com/docs  ' },
      }],
    }))
    expect(normalized.navigation[0].target).toEqual({
      kind: 'external_https',
      url: 'https://example.com/docs',
    })
    for (const url of [
      'http://example.com',
      'javascript:alert(1)',
      'data:text/html,hello',
      'https://user:password@example.com',
      '/relative/path',
      SENTINEL,
    ]) {
      expectCode(() => createElearningPortalConfigSnapshot(config({
        navigation: [{
          itemKey: 'bad',
          label: 'Bad',
          target: { kind: 'external_https', url },
        }],
      })), 'invalid_target')
    }
  })

  it('rejects arbitrary internal routes, target kinds, and content kinds', () => {
    for (const target of [
      { destination: '/admin', kind: 'built_in' },
      { destination: 'admin', kind: 'built_in' },
      { kind: 'internal_path', path: '/admin' },
      { kind: 'external_https', url: 'https://example.com', extra: SENTINEL },
    ]) {
      expectCode(() => createElearningPortalConfigSnapshot(config({
        navigation: [{ itemKey: 'bad', label: 'Bad', target }],
      })), 'invalid_target')
    }
    expectCode(() => createElearningPortalConfigSnapshot(config({
      banners: [{
        bannerKey: 'bad',
        mediaId: BANNER_MEDIA_ID,
        target: { contentId: CONTENT_ID, contentKind: 'admin', kind: 'content' },
      }],
    })), 'invalid_target')
  })

  it('requires media and content references to be UUIDs without storage keys', () => {
    expectCode(() => createElearningPortalConfigSnapshot(config({
      logoMediaId: 'storage/private/logo.png',
    })), 'invalid_config')
    expectCode(() => createElearningPortalConfigSnapshot(config({
      banners: [{
        bannerKey: 'bad-media',
        mediaId: 'storage/private/banner.png',
        target: { kind: 'none' },
      }],
    })), 'invalid_banner')
    expectCode(() => createElearningPortalConfigSnapshot(config({
      banners: [{
        bannerKey: 'bad-content',
        mediaId: BANNER_MEDIA_ID,
        target: { contentId: 'course-1', contentKind: 'course', kind: 'content' },
      }],
    })), 'invalid_target')
    const serialized = JSON.stringify(createElearningPortalConfigSnapshot(config()))
    expect(serialized).not.toMatch(/storageKey|storage\/private/i)
  })

  it('accepts empty optional presentation fields and trims public text', () => {
    const result = createElearningPortalConfigSnapshot(config({
      banners: [],
      logoMediaId: null,
      navigation: [],
      platformName: '  学习中心  ',
      tagline: null,
    }))
    expect(result).toMatchObject({
      banners: [],
      logoMediaId: null,
      navigation: [],
      platformName: '学习中心',
      tagline: null,
    })
  })

  it('rejects duplicate stable keys and list-limit overflow', () => {
    expectCode(() => createElearningPortalConfigSnapshot(config({
      navigation: [
        { itemKey: 'dup', label: 'One', target: { destination: 'my_learning', kind: 'built_in' } },
        { itemKey: 'dup', label: 'Two', target: { destination: 'learning_center', kind: 'built_in' } },
      ],
    })), 'invalid_navigation')
    expectCode(() => createElearningPortalConfigSnapshot(config({
      banners: [
        { bannerKey: 'dup', mediaId: BANNER_MEDIA_ID, target: { kind: 'none' } },
        { bannerKey: 'dup', mediaId: BANNER_MEDIA_ID, target: { kind: 'none' } },
      ],
    })), 'invalid_banner')
    expectCode(() => createElearningPortalConfigSnapshot(config({
      navigation: Array.from({ length: 13 }, (_, index) => ({
        itemKey: `nav-${index}`,
        label: `Nav ${index}`,
        target: { destination: 'learning_center', kind: 'built_in' },
      })),
    })), 'invalid_navigation')
    expectCode(() => createElearningPortalConfigSnapshot(config({
      banners: Array.from({ length: 11 }, (_, index) => ({
        bannerKey: `banner-${index}`,
        mediaId: BANNER_MEDIA_ID,
        target: { kind: 'none' },
      })),
    })), 'invalid_banner')
  })

  it('rejects malformed and extra shapes values-free', () => {
    for (const value of [
      null,
      {},
      { ...config(), extra: SENTINEL },
      config({ orgId: `${SENTINEL}\0` }),
      config({ platformName: '\ud800' }),
      config({ tagline: '' }),
    ]) {
      expectCode(() => createElearningPortalConfigSnapshot(value), 'invalid_config')
    }
    expectCode(() => createElearningPortalConfigSnapshot(config({
      navigation: [{ itemKey: '', label: 'Bad', target: { destination: 'my_learning', kind: 'built_in' } }],
    })), 'invalid_navigation')
    expectCode(() => createElearningPortalConfigSnapshot(config({
      banners: [{ bannerKey: 'bad', mediaId: BANNER_MEDIA_ID, target: { kind: 'none' }, extra: SENTINEL }],
    })), 'invalid_banner')
  })

  it('fails closed on sparse arrays and hostile accessors', () => {
    expectCode(() => createElearningPortalConfigSnapshot(config({
      navigation: new Array(1),
    })), 'invalid_navigation')
    expectCode(() => createElearningPortalConfigSnapshot(config({
      banners: new Array(1),
    })), 'invalid_banner')
    const hostile = Object.defineProperty(config(), 'platformName', {
      enumerable: true,
      get(): never { throw new Error(SENTINEL) },
    })
    expectCode(() => createElearningPortalConfigSnapshot(hostile), 'invalid_config')
    const hostileTarget = Object.defineProperty({}, 'kind', {
      enumerable: true,
      get(): never { throw new Error(SENTINEL) },
    })
    expectCode(() => createElearningPortalConfigSnapshot(config({
      navigation: [{ itemKey: 'bad', label: 'Bad', target: hostileTarget }],
    })), 'invalid_target')
  })

  it('does not retain mutable caller arrays or objects', () => {
    const source = config()
    const result = createElearningPortalConfigSnapshot(source)
    ;(source.navigation as Array<{ label: string }>)[0].label = SENTINEL
    ;(source.banners as Array<{ bannerKey: string }>)[0].bannerKey = SENTINEL
    expect(result.navigation[0].label).toBe('学习中心')
    expect(result.banners[0].bannerKey).toBe('featured-course')
  })
})
