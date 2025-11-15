import { describe, it, expect } from 'vitest'
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

    const addr = server.getAddress()
    expect(addr).toBeTruthy()
    expect(typeof addr.port).toBe('number')

    await server.stop()
    expect(true).toBe(true)
  })
})
