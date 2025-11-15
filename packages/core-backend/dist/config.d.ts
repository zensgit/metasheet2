/**
 * 配置管理
 */
export interface AppConfig {
    db: {
        url: string;
        poolMax: number;
        idleTimeoutMs: number;
        connTimeoutMs: number;
    };
    server: {
        port: number;
        host: string;
    };
    auth: {
        jwtSecret: string;
        jwtPublicKey?: string;
        kanbanAuthRequired: boolean;
    };
    ws: {
        redisEnabled: string;
    };
    kanban: {
        authRequired: boolean;
    };
}
export declare function getConfig(): AppConfig;
/**
 * Sanitize config for external exposure (remove secrets)
 */
export declare function sanitizeConfig(cfg: AppConfig): any;
//# sourceMappingURL=config.d.ts.map