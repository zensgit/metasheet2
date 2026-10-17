/**
 * EventBusService Singleton
 * 事件总线服务单例
 */

import { EventBusService } from '../../core/EventBusService'
import type { CoreAPI } from '../../types/plugin'

let eventBusServiceInstance: EventBusService | null = null

/**
 * Initialize the EventBusService singleton
 */
export function initializeEventBusService(coreAPI: CoreAPI): Promise<void> {
  if (!eventBusServiceInstance) {
    eventBusServiceInstance = new EventBusService()
  }
  return eventBusServiceInstance.initialize(coreAPI)
}

/**
 * Get the EventBusService singleton instance
 */
export async function getEventBus(): Promise<EventBusService> {
  if (!eventBusServiceInstance) {
    throw new Error('EventBusService not initialized. Call initializeEventBusService first.')
  }
  return eventBusServiceInstance
}

/**
 * Get the EventBusService instance directly (without async)
 */
export function getEventBusSync(): EventBusService {
  if (!eventBusServiceInstance) {
    throw new Error('EventBusService not initialized. Call initializeEventBusService first.')
  }
  return eventBusServiceInstance
}

/** Drain the initialized singleton without creating a bus during shutdown. */
export async function shutdownEventBusService(): Promise<void> {
  const instance = eventBusServiceInstance
  if (!instance) return
  await instance.shutdown()
  if (eventBusServiceInstance === instance) eventBusServiceInstance = null
}
