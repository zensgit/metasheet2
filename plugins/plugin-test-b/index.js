export default class PluginTestB {
  async activate(ctx) {
    // Expose a route to test cross-plugin call and storage
    ctx.api.http.addRoute('GET', '/api/test/plugins/ping', async (_req, res) => {
      try {
        const pong = await ctx.communication.call('plugin-test-a', 'ping')
        await ctx.communication.call('plugin-test-a', 'put', 'lastPing', { at: Date.now(), pong })
        const stored = await ctx.communication.call('plugin-test-a', 'get', 'lastPing')
        res.json({ ok: true, pong, stored })
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e && e.message || e) })
      }
    })

    // Route to intentionally trigger a capability denial to test metrics
    ctx.api.http.addRoute('GET', '/api/test/plugins/deny', async (_req, res) => {
      try {
        // This requires http.request permission which this plugin does not have
        await ctx.api.http.request({ method: 'GET', url: 'http://localhost:8900/health' })
        res.json({ ok: true, unexpected: true })
      } catch (e) {
        res.status(403).json({ ok: false, denied: true, error: String(e && e.message || e) })
      }
    })
    ctx.logger.info('plugin-test-b activated')
  }
}
