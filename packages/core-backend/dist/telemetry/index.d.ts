/**
 * Telemetry initialization and setup
 */
/**
 * Initialize OpenTelemetry
 * Should be called at application startup before any other code
 */
export declare function initializeTelemetry(): Promise<import("../services/TelemetryService").TelemetryService>;
/**
 * Get telemetry instance
 */
export declare function getTelemetryInstance(): import("../services/TelemetryService").TelemetryService;
/**
 * Restart telemetry when critical config changes
 */
export declare function restartTelemetryIfNeeded(oldCfg: any, newCfg: any): Promise<{
    restarted: boolean;
    changed: string[];
}>;
export { StructuredLogger, MetricsCollector, Trace } from '../services/TelemetryService';
//# sourceMappingURL=index.d.ts.map