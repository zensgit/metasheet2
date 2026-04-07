const appManifest = require('./app.manifest.json')

module.exports = {
  async activate(context) {
    context.api.http.addRoute('GET', '/api/after-sales/health', async (_req, res) => {
      res.json({
        ok: true,
        plugin: 'plugin-after-sales',
        appId: appManifest.id,
        ts: Date.now(),
      })
    })

    context.api.http.addRoute('GET', '/api/after-sales/app-manifest', async (_req, res) => {
      res.json({
        ok: true,
        data: appManifest,
      })
    })

    context.communication.register('after-sales', {
      async getManifest() {
        return appManifest
      },
    })

    context.api.events.emit('after-sales.plugin.activated', {
      plugin: 'plugin-after-sales',
      appId: appManifest.id,
    })

    context.logger.info('After-sales plugin activated')
  },

  async deactivate() {},
}
