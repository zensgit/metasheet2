import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import net from 'net'
import { MetaSheetServer } from '../../src/index'

async function canListenOnEphemeralPort(): Promise<boolean> {
  return await new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
  })
}

describe('Admin users API mounting', () => {
  let server: MetaSheetServer
  let baseUrl = ''

  beforeAll(async () => {
    const canListen = await canListenOnEphemeralPort()
    if (!canListen) return

    server = new MetaSheetServer({
      port: 0,
      host: '127.0.0.1',
      pluginDirs: [],
    })
    await server.start()
    const address = server.getAddress()
    if (!address?.port) return
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    if (server && (server as { stop?: () => Promise<void> }).stop) {
      await server.stop()
    }
  })

  it('serves admin access presets for a legacy admin dev token', async () => {
    if (!baseUrl) return

    const tokenResponse = await fetch(`${baseUrl}/api/auth/dev-token?userId=dev-admin&roles=admin&perms=${encodeURIComponent('*:*')}`)
    expect(tokenResponse.status).toBe(200)
    const tokenJson = await tokenResponse.json()
    const token = tokenJson.token as string
    expect(token).toBeTruthy()

    const response = await fetch(`${baseUrl}/api/admin/access-presets`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })

    expect(response.status).toBe(200)
    const json = await response.json()
    expect(json.ok).toBe(true)
    expect(Array.isArray(json.data?.items)).toBe(true)
  })
})
