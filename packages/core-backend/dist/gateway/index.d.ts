export * from './APIGateway';
export * from './RateLimiter';
export * from './CircuitBreaker';
import { Application } from 'express';
import { APIGateway, APIEndpoint, GatewayConfig } from './APIGateway';
import { createStrictRateLimiter, createModerateRateLimiter, createRelaxedRateLimiter, createApiRateLimiter, createUserRateLimiter } from './RateLimiter';
export declare const GATEWAY_PRESETS: {
    readonly strict: {
        readonly defaultRateLimit: {
            readonly windowMs: 60000;
            readonly maxRequests: 10;
        };
        readonly enableCircuitBreaker: true;
        readonly timeout: 5000;
        readonly retries: 1;
    };
    readonly moderate: {
        readonly defaultRateLimit: {
            readonly windowMs: 60000;
            readonly maxRequests: 60;
        };
        readonly enableCircuitBreaker: true;
        readonly timeout: 10000;
        readonly retries: 2;
    };
    readonly relaxed: {
        readonly defaultRateLimit: {
            readonly windowMs: 60000;
            readonly maxRequests: 200;
        };
        readonly enableCircuitBreaker: false;
        readonly timeout: 30000;
        readonly retries: 3;
    };
};
export declare function createGateway(app: Application, preset?: keyof typeof GATEWAY_PRESETS | GatewayConfig): APIGateway;
export declare const ENDPOINT_TEMPLATES: {
    readonly publicRead: {
        readonly method: "GET";
        readonly authentication: "none";
        readonly rateLimits: {
            readonly windowMs: 60000;
            readonly maxRequests: 100;
        };
        readonly cache: {
            readonly enabled: true;
            readonly ttl: 300;
        };
    };
    readonly publicWrite: {
        readonly method: "POST";
        readonly authentication: "none";
        readonly rateLimits: {
            readonly windowMs: 60000;
            readonly maxRequests: 10;
        };
        readonly circuitBreaker: true;
    };
    readonly authenticatedRead: {
        readonly method: "GET";
        readonly authentication: "jwt";
        readonly rateLimits: {
            readonly windowMs: 60000;
            readonly maxRequests: 200;
        };
        readonly cache: {
            readonly enabled: true;
            readonly ttl: 60;
        };
    };
    readonly authenticatedWrite: {
        readonly method: "POST";
        readonly authentication: "jwt";
        readonly rateLimits: {
            readonly windowMs: 60000;
            readonly maxRequests: 50;
        };
        readonly circuitBreaker: true;
    };
    readonly adminEndpoint: {
        readonly method: "POST";
        readonly authentication: "jwt";
        readonly authorization: readonly ["admin"];
        readonly rateLimits: {
            readonly windowMs: 60000;
            readonly maxRequests: 20;
        };
    };
};
export declare function createCRUDEndpoints(resource: string, options?: {
    authentication?: 'jwt' | 'api-key' | 'none';
    authorization?: string[];
    cache?: boolean;
    rateLimit?: number;
}): APIEndpoint[];
export declare function registerBulkEndpoints(gateway: APIGateway, endpoints: Record<string, APIEndpoint[]>): void;
export declare const rateLimiters: {
    strict: typeof createStrictRateLimiter;
    moderate: typeof createModerateRateLimiter;
    relaxed: typeof createRelaxedRateLimiter;
    api: typeof createApiRateLimiter;
    user: typeof createUserRateLimiter;
};
export type { APIEndpoint, GatewayConfig, RateLimitConfig, CircuitBreakerConfig, CircuitState, ValidationSchema, CacheConfig } from './APIGateway';
//# sourceMappingURL=index.d.ts.map