import { z } from 'zod';
declare const RootSchema: z.ZodObject<{
    server: z.ZodObject<{
        host: z.ZodDefault<z.ZodString>;
        port: z.ZodDefault<z.ZodNumber>;
        env: z.ZodDefault<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        host?: string;
        port?: number;
        env?: string;
    }, {
        host?: string;
        port?: number;
        env?: string;
    }>;
    db: z.ZodObject<{
        url: z.ZodOptional<z.ZodString>;
        poolMax: z.ZodDefault<z.ZodNumber>;
        idleTimeoutMs: z.ZodDefault<z.ZodNumber>;
        connTimeoutMs: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        url?: string;
        poolMax?: number;
        idleTimeoutMs?: number;
        connTimeoutMs?: number;
    }, {
        url?: string;
        poolMax?: number;
        idleTimeoutMs?: number;
        connTimeoutMs?: number;
    }>;
    jwt: z.ZodObject<{
        secret: z.ZodDefault<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        secret?: string;
    }, {
        secret?: string;
    }>;
    ws: z.ZodObject<{
        redisEnabled: z.ZodDefault<z.ZodEnum<["true", "false"]>>;
    }, "strip", z.ZodTypeAny, {
        redisEnabled?: "true" | "false";
    }, {
        redisEnabled?: "true" | "false";
    }>;
    auth: z.ZodObject<{
        kanbanAuthRequired: z.ZodDefault<z.ZodEnum<["true", "false"]>>;
    }, "strip", z.ZodTypeAny, {
        kanbanAuthRequired?: "true" | "false";
    }, {
        kanbanAuthRequired?: "true" | "false";
    }>;
    featureFlags: z.ZodObject<{
        useKyselyDB: z.ZodDefault<z.ZodEnum<["true", "false"]>>;
        kanbanDB: z.ZodDefault<z.ZodEnum<["true", "false"]>>;
        workflowEnabled: z.ZodDefault<z.ZodEnum<["true", "false"]>>;
    }, "strip", z.ZodTypeAny, {
        useKyselyDB?: "true" | "false";
        kanbanDB?: "true" | "false";
        workflowEnabled?: "true" | "false";
    }, {
        useKyselyDB?: "true" | "false";
        kanbanDB?: "true" | "false";
        workflowEnabled?: "true" | "false";
    }>;
    telemetry: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodEnum<["true", "false"]>>;
        jaegerEndpoint: z.ZodOptional<z.ZodString>;
        prometheusPort: z.ZodDefault<z.ZodNumber>;
        autoInstrumentation: z.ZodDefault<z.ZodEnum<["true", "false"]>>;
        metricsEnabled: z.ZodDefault<z.ZodEnum<["true", "false"]>>;
        tracingEnabled: z.ZodDefault<z.ZodEnum<["true", "false"]>>;
        samplingRate: z.ZodDefault<z.ZodNumber>;
    }, "strip", z.ZodTypeAny, {
        enabled?: "true" | "false";
        jaegerEndpoint?: string;
        prometheusPort?: number;
        autoInstrumentation?: "true" | "false";
        metricsEnabled?: "true" | "false";
        tracingEnabled?: "true" | "false";
        samplingRate?: number;
    }, {
        enabled?: "true" | "false";
        jaegerEndpoint?: string;
        prometheusPort?: number;
        autoInstrumentation?: "true" | "false";
        metricsEnabled?: "true" | "false";
        tracingEnabled?: "true" | "false";
        samplingRate?: number;
    }>>;
}, "strip", z.ZodTypeAny, {
    auth?: {
        kanbanAuthRequired?: "true" | "false";
    };
    server?: {
        host?: string;
        port?: number;
        env?: string;
    };
    db?: {
        url?: string;
        poolMax?: number;
        idleTimeoutMs?: number;
        connTimeoutMs?: number;
    };
    jwt?: {
        secret?: string;
    };
    ws?: {
        redisEnabled?: "true" | "false";
    };
    featureFlags?: {
        useKyselyDB?: "true" | "false";
        kanbanDB?: "true" | "false";
        workflowEnabled?: "true" | "false";
    };
    telemetry?: {
        enabled?: "true" | "false";
        jaegerEndpoint?: string;
        prometheusPort?: number;
        autoInstrumentation?: "true" | "false";
        metricsEnabled?: "true" | "false";
        tracingEnabled?: "true" | "false";
        samplingRate?: number;
    };
}, {
    auth?: {
        kanbanAuthRequired?: "true" | "false";
    };
    server?: {
        host?: string;
        port?: number;
        env?: string;
    };
    db?: {
        url?: string;
        poolMax?: number;
        idleTimeoutMs?: number;
        connTimeoutMs?: number;
    };
    jwt?: {
        secret?: string;
    };
    ws?: {
        redisEnabled?: "true" | "false";
    };
    featureFlags?: {
        useKyselyDB?: "true" | "false";
        kanbanDB?: "true" | "false";
        workflowEnabled?: "true" | "false";
    };
    telemetry?: {
        enabled?: "true" | "false";
        jaegerEndpoint?: string;
        prometheusPort?: number;
        autoInstrumentation?: "true" | "false";
        metricsEnabled?: "true" | "false";
        tracingEnabled?: "true" | "false";
        samplingRate?: number;
    };
}>;
export type AppConfig = z.infer<typeof RootSchema>;
export declare function loadConfig(): AppConfig;
export declare function getConfig(): AppConfig;
export declare function sanitizeConfig(cfg: AppConfig): {
    server: {
        host?: string;
        port?: number;
        env?: string;
    };
    db: {
        url: string;
        poolMax: number;
        idleTimeoutMs: number;
        connTimeoutMs: number;
    };
    jwt: {
        secret: string;
    };
    ws: {
        redisEnabled?: "true" | "false";
    };
    auth: {
        kanbanAuthRequired?: "true" | "false";
    };
    featureFlags: {
        useKyselyDB?: "true" | "false";
        kanbanDB?: "true" | "false";
        workflowEnabled?: "true" | "false";
    };
    telemetry: {
        jaegerEndpoint: string;
        enabled?: "true" | "false";
        prometheusPort?: number;
        autoInstrumentation?: "true" | "false";
        metricsEnabled?: "true" | "false";
        tracingEnabled?: "true" | "false";
        samplingRate?: number;
    };
};
export {};
//# sourceMappingURL=index.d.ts.map