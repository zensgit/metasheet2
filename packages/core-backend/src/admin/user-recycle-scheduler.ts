/**
 * Automatic purge of recycle-bin users whose purge_after has passed.
 * Starts only when USER_RECYCLE_SWEEPER_ENABLED is the exact string true.
 * USER_RECYCLE_SWEEPER_DISABLED=1 and the test-runtime helper stay kill switches.
 * Retention window: USER_RECYCLE_RETENTION_DAYS (default 30), applied when
 * the account is moved into the bin.
 */
import { Logger } from '../core/logger'
import {
  isUserRecycleSweeperDisabled,
  purgeDueRecycleUsers,
  resolveUserRecycleSweeperIntervalMs,
} from './user-recycle'

const logger = new Logger('UserRecycleSweeper')
let timer: NodeJS.Timeout | null = null
let running = false

async function tick(): Promise<void> {
  if (running) return
  running = true
  try {
    const purged = await purgeDueRecycleUsers()
    if (purged > 0) logger.info(`User recycle sweeper purged ${purged} account(s)`)
  } catch {
    logger.error('User recycle sweeper tick failed')
  } finally {
    running = false
  }
}

export function startUserRecycleSweeper(): boolean {
  if (process.env.USER_RECYCLE_SWEEPER_ENABLED !== 'true') return false
  if (isUserRecycleSweeperDisabled()) return false
  if (timer) return true
  const intervalMs = resolveUserRecycleSweeperIntervalMs()
  void tick()
  timer = setInterval(() => { void tick() }, intervalMs)
  timer.unref?.()
  logger.info(`User recycle sweeper started (interval ${intervalMs}ms)`)
  return true
}

export function stopUserRecycleSweeper(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
  logger.info('User recycle sweeper stopped')
}
