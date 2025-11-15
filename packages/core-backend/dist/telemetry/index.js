"use strict";
/**
 * Telemetry initialization and setup
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.Trace = exports.MetricsCollector = exports.StructuredLogger = void 0;
exports.initializeTelemetry = initializeTelemetry;
exports.getTelemetryInstance = getTelemetryInstance;
exports.restartTelemetryIfNeeded = restartTelemetryIfNeeded;
const TelemetryService_1 = require("../services/TelemetryService");
const config_1 = require("../config");
const metrics_1 = require("../metrics/metrics");
const logger_1 = require("../core/logger");
const logger = new logger_1.Logger('Telemetry');
/**
 * Initialize OpenTelemetry
 * Should be called at application startup before any other code
 */
async function initializeTelemetry() {
    try {
        const app = (0, config_1.getConfig)();
        const telemetry = (0, TelemetryService_1.getTelemetry)({
            serviceName: 'metasheet-backend',
            serviceVersion: process.env.npm_package_version || '1.0.0',
            environment: process.env.NODE_ENV || 'development',
            jaegerEndpoint: app?.telemetry?.jaegerEndpoint,
            prometheusPort: Number(app?.telemetry?.prometheusPort ?? 0),
            enableAutoInstrumentation: String(app?.telemetry?.autoInstrumentation) === 'true',
            enableMetrics: String(app?.telemetry?.metricsEnabled) === 'true',
            enableTracing: String(app?.telemetry?.tracingEnabled) === 'true',
            samplingRate: Number(app?.telemetry?.samplingRate ?? 1)
        });
        await telemetry.initialize();
        // Register shutdown handler
        process.on('SIGTERM', async () => {
            logger.info('SIGTERM received, shutting down telemetry...');
            await telemetry.shutdown();
        });
        process.on('SIGINT', async () => {
            logger.info('SIGINT received, shutting down telemetry...');
            await telemetry.shutdown();
        });
        logger.info('Telemetry initialized successfully');
        return telemetry;
    }
    catch (error) {
        logger.error('Failed to initialize telemetry', error);
        // Don't fail the application if telemetry fails
        return null;
    }
}
/**
 * Get telemetry instance
 */
function getTelemetryInstance() {
    return (0, TelemetryService_1.getTelemetry)();
}
/**
 * Restart telemetry when critical config changes
 */
async function restartTelemetryIfNeeded(oldCfg, newCfg) {
    const wasEnabled = oldCfg?.telemetry?.enabled === 'true';
    const nowEnabled = newCfg?.telemetry?.enabled === 'true';
    const criticalKeys = ['jaegerEndpoint', 'prometheusPort', 'tracingEnabled', 'metricsEnabled', 'autoInstrumentation', 'samplingRate'];
    const changed = criticalKeys.filter(k => (oldCfg?.telemetry?.[k] ?? undefined) !== (newCfg?.telemetry?.[k] ?? undefined));
    let restarted = false;
    if (nowEnabled) {
        // If newly enabled or critical fields changed
        if (!wasEnabled || changed.length > 0) {
            try {
                const inst = await initializeTelemetry(); // initializeTelemetry re-inits or warns if already started
                restarted = !!inst;
            }
            catch {
                restarted = false;
            }
        }
    }
    // Update sampling rate gauge (even if disabled set to 0)
    try {
        metrics_1.metrics.configSamplingRate.set(nowEnabled ? (newCfg.telemetry.samplingRate || 0) : 0);
    }
    catch { }
    return { restarted, changed };
}
var TelemetryService_2 = require("../services/TelemetryService");
Object.defineProperty(exports, "StructuredLogger", { enumerable: true, get: function () { return TelemetryService_2.StructuredLogger; } });
Object.defineProperty(exports, "MetricsCollector", { enumerable: true, get: function () { return TelemetryService_2.MetricsCollector; } });
Object.defineProperty(exports, "Trace", { enumerable: true, get: function () { return TelemetryService_2.Trace; } });
//# sourceMappingURL=index.js.map