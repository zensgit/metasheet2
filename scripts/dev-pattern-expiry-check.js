// Dev-only quick verification script for messaging pattern + expiry.
// Usage: node metasheet-v2/scripts/dev-pattern-expiry-check.js (after building core or in ts-node env)
import { messageBus } from '../packages/core-backend/src/integration/messaging/message-bus.js'
import { coreMetrics } from '../packages/core-backend/src/integration/metrics/metrics.js'

async function main() {
  const before = coreMetrics.get().messagesExpired
  messageBus.subscribePattern('demo.*', m => console.log('[PATTERN]', m.topic))
  messageBus.subscribe('demo.exact', m => console.log('[EXACT]', m.topic))

  // Valid publishes
  await messageBus.publish('demo.exact', { ok: true })
  await messageBus.publish('demo.other', { ok: true })

  // Expiring message (likely to expire before processing if delayed enough)
  await messageBus.publish('demo.expire', { should: 'drop' }, { expiryMs: 50 })

  // Invalid pattern forms
  for (const p of ['*', 'demo.*.x', 'demo*mid.*']) {
    try {
      messageBus.subscribePattern(p, () => {})
      console.error('UNEXPECTED: pattern accepted', p)
    } catch (e) {
      console.log('Expected reject:', p, '->', e.message)
    }
  }

  setTimeout(() => {
    const after = coreMetrics.get().messagesExpired
    console.log('Expired delta:', after - before)
  }, 120)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
