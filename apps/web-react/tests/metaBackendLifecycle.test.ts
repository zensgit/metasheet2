import { describe, expect, it } from 'vitest'
import {
  isCurrentMetaBackendLifecycleRequest,
  syncMetaBackendLifecycleMarker,
  type MetaBackendLifecycleMarker,
} from '../src/useMetaBackendLifecycle'

describe('metaBackendLifecycle', () => {
  it('keeps the token stable when the lifecycle inputs have not changed', () => {
    const client = {
      ensureDevToken: async () => 'token',
      fetchViews: async () => [],
      fetchMetaView: async () => ({ data: { fields: [], rows: [] } }),
    }
    const marker: MetaBackendLifecycleMarker = {
      client,
      token: 2,
      useBackend: true,
    }

    expect(syncMetaBackendLifecycleMarker(marker, client, true)).toEqual({
      changed: false,
      marker,
    })
    expect(isCurrentMetaBackendLifecycleRequest(marker, 2, client)).toBe(true)
  })

  it('advances the token when the client or backend mode changes', () => {
    const firstClient = {
      ensureDevToken: async () => 'token-1',
      fetchViews: async () => [],
      fetchMetaView: async () => ({ data: { fields: [], rows: [] } }),
    }
    const secondClient = {
      ensureDevToken: async () => 'token-2',
      fetchViews: async () => [],
      fetchMetaView: async () => ({ data: { fields: [], rows: [] } }),
    }
    const marker: MetaBackendLifecycleMarker = {
      client: firstClient,
      token: 1,
      useBackend: true,
    }

    expect(syncMetaBackendLifecycleMarker(marker, secondClient, true)).toEqual({
      changed: true,
      marker: {
        client: secondClient,
        token: 2,
        useBackend: true,
      },
    })
    expect(syncMetaBackendLifecycleMarker(marker, firstClient, false)).toEqual({
      changed: true,
      marker: {
        client: firstClient,
        token: 2,
        useBackend: false,
      },
    })
    expect(isCurrentMetaBackendLifecycleRequest(marker, 1, secondClient)).toBe(false)
    expect(isCurrentMetaBackendLifecycleRequest({ ...marker, useBackend: false }, 1, firstClient)).toBe(false)
  })
})
