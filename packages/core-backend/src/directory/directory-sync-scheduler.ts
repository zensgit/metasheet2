import { Logger } from '../core/logger'
import { query } from '../db/pg'
import { SchedulerServiceImpl } from '../services/SchedulerService'
import { DirectorySyncInProgressError, reclaimStaleDirectorySyncRuns, syncDirectoryIntegration } from './directory-sync'
import { deliverDirectoryInactiveLinkedAlert } from './directory-sync-alert-delivery'

type DirectoryScheduleRow = {
  id: string
  name: string
  status: string
  sync_enabled: boolean
  schedule_cron: string | null
}

type DirectorySyncSchedulerLike = Pick<SchedulerServiceImpl, 'schedule' | 'reschedule' | 'unschedule' | 'getJob' | 'destroy'>

const logger = new Logger('DirectorySyncScheduler')
const SYSTEM_TRIGGERED_BY = 'system:directory-sync-scheduler'
const JOB_PREFIX = 'directory-sync'

let scheduler: DirectorySyncSchedulerLike | null = null
let started = false

function buildJobName(integrationId: string): string {
  return `${JOB_PREFIX}:${integrationId}`
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim()
}

function shouldSchedule(row: DirectoryScheduleRow | null): row is DirectoryScheduleRow {
  if (!row) return false
  return row.status === 'active' && row.sync_enabled === true && normalizeText(row.schedule_cron).length > 0
}

async function listScheduleRows(): Promise<DirectoryScheduleRow[]> {
  const result = await query<DirectoryScheduleRow>(
    `SELECT id, name, status, sync_enabled, schedule_cron
     FROM directory_integrations
     WHERE provider = 'dingtalk'`,
  )
  return result.rows
}

async function getScheduleRow(integrationId: string): Promise<DirectoryScheduleRow | null> {
  const result = await query<DirectoryScheduleRow>(
    `SELECT id, name, status, sync_enabled, schedule_cron
     FROM directory_integrations
     WHERE id = $1 AND provider = 'dingtalk'`,
    [integrationId],
  )
  return result.rows[0] ?? null
}

// P3-2 (#4057's gate): the schedule callback used to close over the mutable `row.name`
// captured at job-CREATION time. reschedule() (the `existingJob` branch of applySchedule)
// keeps the same job/handler and only swaps the cron expression, so a renamed integration
// kept alerting/logging under its old display name until the job was unscheduled and
// recreated (or the process restarted). Resolving the name at fire time — carrying only
// the immutable `row.id` in the closure — fixes that without changing reschedule-in-place
// semantics (job stats/runCount survive a rename, matching every other cron-only edit).
// Mirrors the existing `readIntegrationNameForAlert` fallback convention in directory-sync.ts.
async function resolveScheduledIntegrationName(integrationId: string): Promise<string> {
  try {
    const currentRow = await getScheduleRow(integrationId)
    return currentRow?.name || integrationId
  } catch {
    return integrationId
  }
}

async function runScheduledSync(integrationId: string, integrationName: string): Promise<void> {
  try {
    await syncDirectoryIntegration(integrationId, SYSTEM_TRIGGERED_BY, 'scheduler')
  } catch (error) {
    // DT-HARDEN-05: a manual sync (or another replica's scheduler) already holds the
    // lease. Skipping is the correct outcome — the directory is being refreshed. Any
    // other failure stays an error so the job reports it.
    if (error instanceof DirectorySyncInProgressError) {
      logger.info(`Skipped scheduled directory sync for ${integrationId}: ${error.message}`)
      return
    }
    throw error
  }

  // §7.1 offboarding blind-spot digest. Deliberately scoped to scheduler-triggered (nightly)
  // syncs only, not manual ones: the manual-sync route lives in directory-sync.ts's apply
  // region, which is being touched by an unlanded PR in the same lane batch — this hook
  // stays entirely in this file to avoid any collision there. `deliverDirectoryInactiveLinkedAlert`
  // is best-effort and never throws, so no try/catch is needed here.
  await deliverDirectoryInactiveLinkedAlert({ integrationId, integrationName })
}

type InvalidCronReport = { id: string; name: string; cron: string; error: string }

type ApplyScheduleOptions = {
  // §7.8 follow-up (P3-1 from #4053's gate): rows saved before save-time cron validation
  // landed may hold a schedule_cron the runtime can never fire. applySchedule already
  // unschedules/skips them safely; this hook lets the boot sweep additionally collect
  // them for one aggregate telemetry line so ops can find and fix the rows. Never used
  // to mutate/auto-clear anything.
  onInvalidCron?: (report: InvalidCronReport) => void
}

async function applySchedule(row: DirectoryScheduleRow | null, options: ApplyScheduleOptions = {}): Promise<void> {
  if (!scheduler) return

  const jobName = buildJobName(normalizeText(row?.id))
  const existingJob = jobName ? await scheduler.getJob(jobName) : null

  if (!shouldSchedule(row)) {
    if (existingJob && jobName) {
      await scheduler.unschedule(jobName)
      logger.info(`Unscheduled directory sync job: ${jobName}`)
    }
    return
  }

  const cronExpression = normalizeText(row.schedule_cron)
  try {
    if (existingJob) {
      await scheduler.reschedule(jobName, cronExpression)
      logger.info(`Rescheduled directory sync job: ${jobName} (${cronExpression})`)
    } else {
      await scheduler.schedule(jobName, cronExpression, async () => {
        await runScheduledSync(row.id, await resolveScheduledIntegrationName(row.id))
      }, {
        timezone: 'UTC',
      })
      logger.info(`Scheduled directory sync job: ${jobName} (${cronExpression})`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(`Failed to apply directory sync schedule for ${row.id}: ${message}`, {
      integrationId: row.id,
      integrationName: row.name,
      scheduleCron: cronExpression,
    })
    options.onInvalidCron?.({ id: row.id, name: row.name, cron: cronExpression, error: message })
    if (existingJob) {
      await scheduler.unschedule(jobName)
    }
  }
}

export async function startDirectorySyncScheduler(
  options: { scheduler?: DirectorySyncSchedulerLike } = {},
): Promise<void> {
  if (started) return

  scheduler = options.scheduler ?? new SchedulerServiceImpl()
  started = true

  try {
    // DT-HARDEN-05: a crash or redeploy leaves `running` run rows nobody owns, which
    // would hold the lease until it expires. Sweep them once at boot so an integration
    // is never wedged waiting for a process that no longer exists.
    await reclaimStaleDirectorySyncRuns()
  } catch (error) {
    logger.warn(`Failed to reclaim stale directory sync runs: ${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    const rows = await listScheduleRows()
    const invalidCronRows: InvalidCronReport[] = []
    await Promise.all(rows.map((row) => applySchedule(row, {
      onInvalidCron: (report) => invalidCronRows.push(report),
    })))
    logger.info(`Directory sync scheduler started with ${rows.length} integration(s) loaded`)

    // §7.8 follow-up (P3-1): one structured summary per boot so ops can find legacy rows
    // with a schedule_cron the runtime can never fire, without scanning per-row warnings.
    // Read-only — this never clears or otherwise mutates the offending rows.
    if (invalidCronRows.length > 0) {
      logger.warn(
        `Directory sync scheduler boot found ${invalidCronRows.length} integration(s) with a schedule_cron the runtime can never fire`,
        { invalidCronIntegrations: invalidCronRows },
      )
    }
  } catch (error) {
    logger.warn(`Directory sync scheduler bootstrap failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function refreshDirectoryIntegrationSchedule(integrationId: string): Promise<void> {
  if (!started || !scheduler) return

  const normalizedIntegrationId = normalizeText(integrationId)
  if (!normalizedIntegrationId) return

  try {
    const row = await getScheduleRow(normalizedIntegrationId)
    await applySchedule(row)
  } catch (error) {
    logger.warn(`Failed to refresh directory sync schedule for ${normalizedIntegrationId}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function stopDirectorySyncScheduler(): Promise<void> {
  if (!scheduler) return

  try {
    scheduler.destroy()
  } finally {
    scheduler = null
    started = false
  }
}

export function resetDirectorySyncSchedulerForTests(): void {
  scheduler = null
  started = false
}
