export default {
  activate: (context) => {
    if (process.env.PLUGIN_DYNAMIC_ENABLED === 'true') {
      // Demo log (non-production)
      console.log('[example-plugin] example plugin loaded (flag enabled)')
    }
  },
  deactivate: () => {
    // Cleanup
  }
}
