module.exports = {
  lifecycle: {
    activate: () => {
      if (process.env.PLUGIN_DYNAMIC_ENABLED === 'true') {
        // Demo log (non-production)
        console.log('[example-plugin] example plugin loaded (flag enabled)')
      }
    }
  },
  capabilities: [
    // Add real capability keys here in future e.g. 'example:read'
  ]
}
