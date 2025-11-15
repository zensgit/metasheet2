import { coreMetrics } from './metrics'

interface CacheEntry { text: string; ts: number }
const CACHE_TTL_MS = 5000
let cache: CacheEntry | null = null

function formatLine(name: string, help: string, type: string, value: number) {
  return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name} ${value}`
}

export function renderPrometheus(): string {
  const now = Date.now()
  if (cache && now - cache.ts < CACHE_TTL_MS) return cache.text

  const snap = coreMetrics.get()
  const uptime = (Date.now() - snap.startedAt) / 1000
  const mem = process.memoryUsage()

  const lines: string[] = []
  lines.push(formatLine('metasheet_events_emitted_total', 'Total events emitted', 'counter', snap.eventsEmitted))
  lines.push(formatLine('metasheet_messages_processed_total', 'Total messages processed', 'counter', snap.messagesProcessed))
  lines.push(formatLine('metasheet_messages_retried_total', 'Total message retries', 'counter', snap.messagesRetried))
  lines.push(formatLine('metasheet_messages_expired_total', 'Total messages expired (dropped before processing)', 'counter', snap.messagesExpired))
  lines.push(formatLine('metasheet_permission_denied_total', 'Total permission denied (sandbox) occurrences', 'counter', snap.permissionDenied))
  lines.push(formatLine('metasheet_rpc_timeouts_total', 'Total RPC timeouts', 'counter', snap.rpcTimeouts))
  lines.push(formatLine('metasheet_process_uptime_seconds', 'Process uptime seconds', 'gauge', uptime))
  lines.push(formatLine('metasheet_process_memory_rss_bytes', 'Process RSS bytes', 'gauge', mem.rss))
  lines.push(formatLine('metasheet_process_memory_heap_used_bytes', 'Process heap used bytes', 'gauge', mem.heapUsed))

  const text = lines.join('\n') + '\n'
  cache = { text, ts: now }
  return text
}
