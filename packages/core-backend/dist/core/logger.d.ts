/**
 * 日志系统
 */
export declare class Logger {
    private winston;
    private context;
    constructor(context: string);
    debug(message: string, meta?: any): void;
    info(message: string, meta?: any): void;
    warn(message: string, meta?: any): void;
    error(message: string, error?: Error): void;
}
/**
 * 创建日志器实例的辅助函数
 */
export declare function createLogger(context: string): Logger;
//# sourceMappingURL=logger.d.ts.map