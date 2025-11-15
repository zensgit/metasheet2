export default class PluginTestA {
  async activate(ctx) {
    // Register a simple RPC API
    ctx.communication.register('plugin-test-a', {
      async ping() {
        return 'pong'
      },
      async put(key, value) {
        await ctx.storage.set(key, value)
        return true
      },
      async get(key) {
        return await ctx.storage.get(key)
      }
    })
    ctx.logger.info('plugin-test-a activated')
  }
}

