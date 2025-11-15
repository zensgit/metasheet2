export default {
  activate(context) {
    console.log('[hello-plugin] activate called, context:', context ? 'present' : 'missing')

    // Check if context has expected properties
    if (!context || !context.core) {
      console.error('[hello-plugin] PluginContext or core API not available')
      return
    }

    const core = context.core
    console.log('[hello-plugin] Available core APIs:', Object.keys(core))

    // 注册HTTP路由（如果API可用）
    if (core.http && core.http.addRoute) {
      try {
        // 注册一个最小的 GET 路由
        core.http.addRoute('GET', '/api/v2/hello', async (req, res) => {
          res.status(200).json({
            message: 'Hello from MetaSheet v2 plugin',
            time: new Date().toISOString()
          })
        })

        // 暴露一个触发 RPC 的路由（用于测试RPC与Pattern并存）
        core.http.addRoute('GET', '/api/v2/rpc-test', async (_req, res) => {
          try {
            const result = await core.messaging.request('rpc.hello.ping', { ts: Date.now() }, 1500)
            res.json({ success: true, rpc: result })
          } catch (e) {
            res.status(500).json({ success: false, error: e.message })
          }
        })

        console.log('[hello-plugin] HTTP routes registered successfully')
      } catch (e) {
        console.error('[hello-plugin] Failed to register HTTP routes:', e.message)
      }
    } else {
      console.warn('[hello-plugin] HTTP API not available')
    }

    // 订阅并演示事件发布
    if (core.events) {
      const subId = core.events.on('system:startup', () => {
        // eslint-disable-next-line no-console
        console.log('[hello-plugin] received system:startup')
      })
      // 定时发布测试事件
      setTimeout(() => {
        core.events.emit('demo:event', { from: 'hello-plugin' })
      }, 1000)
    }

    // 注册 RPC handler
    if (core.messaging) {
      try {
        core.messaging.rpcHandler('rpc.hello.ping', async (data) => {
          console.log('[hello-plugin] RPC ping received:', data)
          return { pong: true, received: data, timestamp: Date.now() }
        })
        console.log('[hello-plugin] RPC handler registered successfully')
      } catch (e) {
        console.error('[hello-plugin] Failed to register RPC handler:', e.message)
      }
    } else {
      console.error('[hello-plugin] Messaging API not available')
    }

    // 演示卸载时清理（若将来支持插件卸载，可使用 subId）

    // ---------------- Messaging Demo (guarded by env: MS_DEMO_MESSAGING=true) ----------------
    if (process.env.MS_DEMO_MESSAGING === 'true' && core.messaging) {
      try {
        core.messaging.subscribePattern('demo.*', (msg) => {
          console.log('[hello-plugin][pattern] topic=', msg.topic, 'payload=', msg.payload)
        })
        core.messaging.subscribe('demo.keep', (msg) => {
          console.log('[hello-plugin][exact] topic=', msg.topic, 'payload=', msg.payload)
        })
        // Publish an expiring message (50ms TTL) and a normal one
        core.messaging.publish('demo.expireQuick', { should: 'drop' }, { expiryMs: 50 })
        core.messaging.publish('demo.keep', { test: 'exact-pattern-coexist' })
        setTimeout(() => core.messaging.publish('demo.late', { after: '50ms' }), 50)
        setTimeout(async () => {
          try {
            const res = await fetch('http://localhost:8900/metrics/prom')
            const text = await res.text()
            const expiredLine = text.split('\n').find(l => l.includes('metasheet_messages_expired_total'))
            console.log('[hello-plugin][metrics] expired =>', expiredLine || 'N/A')
          } catch (err) {
            console.warn('[hello-plugin] fetch metrics failed', err.message)
          }
        }, 2000)
      } catch (err) {
        console.warn('[hello-plugin] messaging demo init failed', err.message)
      }
    }
    // ---------------------------------------------------------------------------------------
  },

  deactivate() {
    console.log('[hello-plugin] Plugin deactivated')
  }
}
