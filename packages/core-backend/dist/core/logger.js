"use strict";
/**
 * 日志系统
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Logger = void 0;
exports.createLogger = createLogger;
const winston_1 = __importDefault(require("winston"));
class Logger {
    winston;
    context;
    constructor(context) {
        this.context = context;
        this.winston = winston_1.default.createLogger({
            level: process.env.LOG_LEVEL || 'info',
            format: winston_1.default.format.combine(winston_1.default.format.timestamp(), winston_1.default.format.errors({ stack: true }), winston_1.default.format.json()),
            defaultMeta: { service: 'metasheet', context },
            transports: [
                new winston_1.default.transports.Console({
                    format: winston_1.default.format.combine(winston_1.default.format.colorize(), winston_1.default.format.simple())
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
exports.Logger = Logger;
/**
 * 创建日志器实例的辅助函数
 */
function createLogger(context) {
    return new Logger(context);
}
//# sourceMappingURL=logger.js.map