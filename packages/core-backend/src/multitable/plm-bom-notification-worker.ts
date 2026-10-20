import { isPlmEnabled } from '../config/product-mode'
import { isWriterFenceEnabled } from './canonical-sheet-fence'
import { isDurableDeliveryEnabled } from './automation-durable-delivery'
import type { BomReviewPool, PlmBomReviewService } from './plm-bom-review-service'

export function isBomNotificationWorkerEnabled(): boolean {
  return isPlmEnabled(process.env.PRODUCT_MODE,process.env.ENABLE_PLM)
    && process.env.PLM_BOM_REVIEW_ENABLED === 'true' && isWriterFenceEnabled() && isDurableDeliveryEnabled()
}

export class PlmBomNotificationWorker {
  private stopped = true
  private stopping = false
  private timer: ReturnType<typeof setInterval> | undefined
  private running: Promise<void> | null = null
  private bindingCursor: string | null = null
  private readonly eventCursors = new Map<string,string>()
  constructor(private readonly pool: BomReviewPool,
    private readonly service: Pick<PlmBomReviewService,'pollChanges' | 'scanNotifications' | 'prepareNotification' | 'deliverNotification' | 'prepareCompletion' | 'deliverCompletion'> & Partial<Pick<PlmBomReviewService,'drainPersonalReadRevocations'>>,
    private readonly warn: () => void) {}

  async start(): Promise<void> {
    if (this.stopping || !this.stopped || !isBomNotificationWorkerEnabled()) return
    this.stopped = false
    await this.tick()
    if (!this.stopped) {
      this.timer = setInterval(() => { void this.tick() },60000)
      this.timer.unref?.()
    }
  }
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.stopping = true
    try { await this.running } finally { this.stopping = false }
  }
  tick(): Promise<void> {
    if (this.stopped || !isBomNotificationWorkerEnabled()) return Promise.resolve()
    if (this.running) return this.running
    this.running = this.run().catch(() => { this.warn() }).finally(() => { this.running = null })
    return this.running
  }
  private async run(): Promise<void> {
    try { await this.service.drainPersonalReadRevocations?.() } catch { this.warn() }
    if (this.stopped || !isBomNotificationWorkerEnabled()) return
    const sql = `SELECT b.id FROM meta_plm_bom_review_bindings b WHERE ($1::uuid IS NULL OR b.id>$1::uuid)
      AND (EXISTS(SELECT 1 FROM meta_plm_bom_change_listeners l WHERE l.binding_id=b.id AND l.status='active')
       OR EXISTS(SELECT 1 FROM meta_plm_bom_review_notification_config c WHERE c.binding_id=b.id
        AND (c.notifications->'issue'->'enabled'='true'::jsonb OR c.notifications->'reminder'->'enabled'='true'::jsonb
         OR c.notifications->'escalation'->'enabled'='true'::jsonb))
       OR EXISTS(SELECT 1 FROM meta_plm_bom_review_notification_events e
        LEFT JOIN meta_plm_bom_review_notification_intents i ON i.event_id=e.id
        WHERE e.binding_id=b.id AND (i.state IS NULL OR i.state='prepared'))
       OR EXISTS(SELECT 1 FROM meta_plm_bom_review_completion_events e
        LEFT JOIN meta_plm_bom_review_completion_intents i ON i.event_id=e.id
        WHERE e.binding_id=b.id AND (i.state IS NULL OR i.state='prepared')))
      ORDER BY b.id LIMIT 50`
    let bindings = (await this.pool.query(sql,[this.bindingCursor])).rows
    if (!bindings.length && this.bindingCursor) {
      this.bindingCursor = null
      bindings = (await this.pool.query(sql,[null])).rows
    }
    for (const binding of bindings) {
      if (this.stopped || !isBomNotificationWorkerEnabled()) break
      const id = String(binding.id)
      this.bindingCursor = id
      try { await this.service.pollChanges(id) } catch { this.warn() }
      if (this.stopped || !isBomNotificationWorkerEnabled()) break
      try { await this.service.scanNotifications(id) } catch { this.warn() }
      if (this.stopped || !isBomNotificationWorkerEnabled()) break
      const events = (await this.pool.query(`SELECT e.id FROM meta_plm_bom_review_notification_events e
        LEFT JOIN meta_plm_bom_review_notification_intents i ON i.event_id=e.id
        WHERE e.binding_id=$1 AND ($2::uuid IS NULL OR e.id>$2::uuid) AND (i.state IS NULL OR i.state='prepared')
        ORDER BY e.id LIMIT 50`,[id,this.eventCursors.get(id) ?? null])).rows
      if (events.length === 50) this.eventCursors.set(id,String(events.at(-1)!.id))
      else this.eventCursors.delete(id)
      for (const event of events) {
        if (this.stopped || !isBomNotificationWorkerEnabled()) break
        try {
          const prepared = await this.service.prepareNotification(String(event.id))
          if (!this.stopped && isBomNotificationWorkerEnabled() && prepared.state === 'prepared')
            await this.service.deliverNotification(String(event.id))
        } catch { this.warn() }
      }
      if (this.stopped || !isBomNotificationWorkerEnabled()) break
      const completions = (await this.pool.query(`SELECT e.id FROM meta_plm_bom_review_completion_events e
        LEFT JOIN meta_plm_bom_review_completion_intents i ON i.event_id=e.id
        WHERE e.binding_id=$1 AND (i.state IS NULL OR i.state='prepared')
        AND (i.next_retry_at IS NULL OR i.next_retry_at<=clock_timestamp())
        AND (i.lease_until IS NULL OR i.lease_until<=clock_timestamp())
        ORDER BY COALESCE(i.next_retry_at,e.created_at),e.id LIMIT 50`,[id])).rows
      for (const event of completions) {
        if (this.stopped || !isBomNotificationWorkerEnabled()) break
        try {
          const prepared = await this.service.prepareCompletion(String(event.id))
          if (!this.stopped && isBomNotificationWorkerEnabled() && prepared.state === 'prepared')
            await this.service.deliverCompletion(String(event.id))
        } catch { this.warn() }
      }
    }
  }
}
