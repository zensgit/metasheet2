import { beforeEach, describe, expect, it, vi } from 'vitest'

function createJsonResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => payload,
  } as Response
}

describe('usePlugins', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('dedupes concurrent fetches across consumers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(createJsonResponse([
      {
        name: 'plugin-attendance',
        status: 'active',
        contributes: {
          views: [
            {
              id: 'attendance',
              name: 'Attendance',
              location: 'main-nav',
            },
          ],
        },
      },
      {
        name: 'plugin-demo',
        status: 'active',
        contributes: {
          views: [
            {
              id: 'timeline',
              name: 'Timeline',
              location: 'main-nav',
              order: 20,
            },
          ],
        },
      },
    ]))

    vi.stubGlobal('fetch', fetchMock)

    const { usePlugins } = await import('../src/composables/usePlugins')
    const first = usePlugins()
    const second = usePlugins()

    await Promise.all([first.fetchPlugins(), second.fetchPlugins()])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(first.plugins.value).toHaveLength(2)
    expect(second.plugins.value).toHaveLength(2)
    expect(first.navItems.value).toEqual([
      {
        id: 'plugin-demo:timeline',
        label: 'Timeline',
        order: 20,
        path: '/p/plugin-demo/timeline',
      },
    ])
  })

  it('skips repeated fetches after load unless force is requested', async () => {
    const fetchMock = vi.fn().mockResolvedValue(createJsonResponse([
      {
        name: 'plugin-attendance',
        status: 'active',
        contributes: { views: [] },
      },
    ]))

    vi.stubGlobal('fetch', fetchMock)

    const { usePlugins } = await import('../src/composables/usePlugins')
    const pluginsApi = usePlugins()

    await pluginsApi.fetchPlugins()
    await pluginsApi.fetchPlugins()
    await pluginsApi.fetchPlugins({ force: true })

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
