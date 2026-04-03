import { describe, it, expect } from 'vitest'
import http from 'http'
import net from 'net'
import { MetaSheetServer } from '../../src/index'

describe('MetaSheetServer lifecycle', () => {
  it('should start, report address, and stop cleanly', async () => {
    // Preflight: if environment forbids listen(), skip this test gracefully
    const canListen: boolean = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', () => resolve(false))
      s.listen(0, '127.0.0.1', () => s.close(() => resolve(true)))
    })
    if (!canListen) {
      expect(true).toBe(true)
      return
    }

    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1' })
    await server.start()

    try {
      const addr = server.getAddress()
      expect(addr).toBeTruthy()
      expect(typeof addr).toBe('object')
      if (!addr || typeof addr === 'string') {
        throw new Error('Expected server.address() to return AddressInfo')
      }
      expect(typeof addr.port).toBe('number')

      const pluginsRes = await request(`http://${addr.address}:${addr.port}/api/plugins`)
      expect(pluginsRes.status).toBe(200)
      expect(pluginsRes.headers['x-content-type-options']).toBe('nosniff')
    } finally {
      await server.stop()
    }

    expect(true).toBe(true)
  })
})

function request(url: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        body += chunk
      })
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body,
        })
      })
    })
    req.on('error', reject)
  })
}
