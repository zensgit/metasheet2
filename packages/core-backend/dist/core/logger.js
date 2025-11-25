/**
 * 日志系统
 */
import winston from 'winston';
export class Logger {
    winston;
    context;
    constructor(context) {
        this.context = context;
        this.winston = winston.createLogger({
            level: process.env.LOG_LEVEL || 'info',
            format: winston.format.combine(winston.format.timestamp(), winston.format.errors({ stack: true }), winston.format.json()),
            defaultMeta: { service: 'metasheet', context },
            transports: [
                new winston.transports.Console({
                    format: winston.format.combine(winston.format.colorize(), winston.format.simple())
                })
            ]
        });
    }
    debug(message, meta) {
        this.winston.debug(message, meta);
    }
    info(message, meta) {
        this.winston.info(message, meta);
    }
    warn(message, meta) {
        this.winston.warn(message, meta);
    }
    error(message, error) {
        this.winston.error(message, { error: error?.message, stack: error?.stack });
    }
}
/**
 * 创建日志器实例的辅助函数
 */
export function createLogger(context) {
    return new Logger(context);
}
//# sourceMappingURL=logger.js.map