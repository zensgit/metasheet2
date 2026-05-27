import { describe, expect, it } from 'vitest'
import { getBuildInfo } from '../../src/config/build-info'

describe('getBuildInfo', () => {
  it('normalizes deploy build metadata from environment variables', () => {
    const info = getBuildInfo({
      METASHEET_BUILD_COMMIT: ' 0123456789abcdef0123456789abcdef01234567 ',
      METASHEET_BUILD_IMAGE_TAG: '0123456789abcdef0123456789abcdef01234567',
      METASHEET_BUILD_IMAGE_DIGEST: 'ghcr.io/zensgit/metasheet2-backend@sha256:abc123',
      METASHEET_BUILD_SOURCE: 'https://github.com/zensgit/metasheet2',
      METASHEET_BUILD_CREATED: '2026-05-27T15:00:00Z',
    } as NodeJS.ProcessEnv)

    expect(info).toEqual({
      commit: '0123456789abcdef0123456789abcdef01234567',
      imageTag: '0123456789abcdef0123456789abcdef01234567',
      imageDigest: 'ghcr.io/zensgit/metasheet2-backend@sha256:abc123',
      source: 'https://github.com/zensgit/metasheet2',
      created: '2026-05-27T15:00:00Z',
    })
  })

  it('hides unset or placeholder metadata instead of exposing noisy values', () => {
    expect(getBuildInfo({
      METASHEET_BUILD_COMMIT: 'unknown',
      METASHEET_BUILD_IMAGE_TAG: '',
      METASHEET_BUILD_IMAGE_DIGEST: '   ',
    } as NodeJS.ProcessEnv)).toEqual({
      commit: null,
      imageTag: null,
      imageDigest: null,
      source: null,
      created: null,
    })
  })
})
