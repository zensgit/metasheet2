/**
 * EventBusService Singleton
 * 事件总线服务单例
 */
import { EventBusService } from '../../core/EventBusService';
import { CoreAPI } from '../../types/plugin';
/**
 * Initialize the EventBusService singleton
 */
export declare function initializeEventBusService(coreAPI: CoreAPI): Promise<void>;
/**
 * Get the EventBusService singleton instance
 */
export declare function getEventBus(): Promise<EventBusService>;
/**
 * Get the EventBusService instance directly (without async)
 */
export declare function getEventBusSync(): EventBusService;
//# sourceMappingURL=event-bus-service.d.ts.map