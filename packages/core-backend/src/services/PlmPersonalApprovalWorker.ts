import { Logger } from '../core/logger'
import { SchedulerServiceImpl } from './SchedulerService'
import { isPlmApprovalCardEnabled } from './plm-personal-approval-wire'
import type { PlmPersonalApprovalBindingService } from './PlmPersonalApprovalBindingService'
/** One finite page per minute, sequential binding locks; restart begins at the first page. */
export class PlmPersonalApprovalWorker {
  private readonly logger = new Logger('PlmPersonalApprovalWorker')
  private readonly scheduler = new SchedulerServiceImpl()
  private cursor = ''
  private running: Promise<number> | null = null
  private stopped = false
  private started = false
  constructor(private readonly service: PlmPersonalApprovalBindingService) {}
  async start() {
    if (this.started || this.stopped || !isPlmApprovalCardEnabled()) return
    this.started = true
    await this.scheduler.schedule('plm-personal-approval-cards', '* * * * *', () => this.tick(), {
      timezone: 'UTC',
    })
  }
  tick(): Promise<number> {
    if (this.stopped || !isPlmApprovalCardEnabled()) return Promise.resolve(0)
    if (this.running) return this.running
    this.running = this.scan().finally(() => {
      this.running = null
    })
    return this.running
  }
  private async scan() {
    const rows = (
      await this.service.pool.query<{ id: string; owner_id: string }>(
        'SELECT id,owner_id FROM plm_personal_approval_bindings WHERE encrypted_grant IS NOT NULL AND expires_at>now() AND id::text>$1 ORDER BY id LIMIT 25',
        [this.cursor],
      )
    ).rows
    let done = 0
    for (const b of rows) {
      if (this.stopped || !isPlmApprovalCardEnabled()) break
      try {
        const recovery = await this.service.reconcile(b.owner_id, b.id, () => !this.stopped)
        if (recovery.pending)
          this.logger.warn('Personal PLM receipt recovery incomplete', {
            code: 'receipt_unresolved',
            count: recovery.pending,
          })
        if (this.stopped) break
        await this.service.sync(b.owner_id, b.id)
        done++
      } catch (error) {
        const status = (error as { status?: number })?.status
        this.logger.warn('Personal PLM approval binding poll failed', {
          code:
            status === 401
              ? 'personal_grant_invalid'
              : status === 403
                ? 'authority_denied'
                : status === 409
                  ? 'binding_required'
                  : 'provider_or_store_unavailable',
        })
      }
      this.cursor = b.id
    }
    if (rows.length < 25) this.cursor = ''
    return done
  }
  async stop() {
    this.stopped = true
    this.scheduler.destroy()
    await this.running
  }
}
