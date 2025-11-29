// Kanban View Plugin
const KanbanPlugin = {
  activate: async (context) => {
    if (context && context.api && context.api.http && typeof context.api.http.addRoute === 'function') {
      // Boards list route
      context.api.http.addRoute('GET', '/api/kanban/boards', async (req, res) => {
        res.json({ boards: [] })
      })
      // Card move route
      context.api.http.addRoute('POST', '/api/kanban/cards/move', async (req, res) => {
        console.log('[PLUGIN] Card move endpoint hit')
        try {
          if (context.api.websocket && typeof context.api.websocket.broadcast === 'function') {
            const payload = {
              cardId: (req.body && req.body.cardId) || 'test-card',
              fromColumn: (req.body && req.body.fromColumn) || 'todo',
              toColumn: (req.body && req.body.toColumn) || 'doing'
            }
            console.log('[PLUGIN] Broadcasting kanban:card:moved event:', payload)
            context.api.websocket.broadcast('kanban:card:moved', payload)
            console.log('[PLUGIN] Broadcast complete')
          } else {
            console.log('[PLUGIN] WebSocket API not available or broadcast not a function')
          }
        } catch (err) {
          console.error('[PLUGIN] Error broadcasting:', err)
        }
        res.json({ ok: true })
      })
    }
  }
}

// Support both CommonJS and ESM
if (typeof module !== 'undefined' && module.exports) {
  module.exports = KanbanPlugin
}
export default KanbanPlugin
