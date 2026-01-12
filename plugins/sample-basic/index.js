module.exports = {
  install(ctx) {
    ctx.logger.info('[sample-basic] install starting')
    // Simple route
    ctx.api.http.addRoute('get','/api/plugin-sample', async (req,res)=> {
      res.json({ ok: true, plugin: 'sample-basic', ts: Date.now() })
    })
  },
  activate(ctx) {
    ctx.logger.info('[sample-basic] activated')
  },
  deactivate(ctx) {
    if (ctx?.logger?.info) {
      ctx.logger.info('[sample-basic] deactivated')
      return
    }
    console.log('[sample-basic] deactivated')
  }
}
