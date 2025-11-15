"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.rateLimiters = exports.ENDPOINT_TEMPLATES = exports.GATEWAY_PRESETS = void 0;
exports.createGateway = createGateway;
exports.createCRUDEndpoints = createCRUDEndpoints;
exports.registerBulkEndpoints = registerBulkEndpoints;
__exportStar(require("./APIGateway"), exports);
__exportStar(require("./RateLimiter"), exports);
__exportStar(require("./CircuitBreaker"), exports);
const APIGateway_1 = require("./APIGateway");
const RateLimiter_1 = require("./RateLimiter");
// Preset configurations for common use cases
exports.GATEWAY_PRESETS = {
    strict: {
        defaultRateLimit: {
            windowMs: 60000,
            maxRequests: 10
        },
        enableCircuitBreaker: true,
        timeout: 5000,
        retries: 1
    },
    moderate: {
        defaultRateLimit: {
            windowMs: 60000,
            maxRequests: 60
        },
        enableCircuitBreaker: true,
        timeout: 10000,
        retries: 2
    },
    relaxed: {
        defaultRateLimit: {
            windowMs: 60000,
            maxRequests: 200
        },
        enableCircuitBreaker: false,
        timeout: 30000,
        retries: 3
    }
};
// Helper to create gateway with preset
function createGateway(app, preset = 'moderate') {
    const config = typeof preset === 'string' ? exports.GATEWAY_PRESETS[preset] : preset;
    return new APIGateway_1.APIGateway(app, config);
}
// Endpoint templates
exports.ENDPOINT_TEMPLATES = {
    publicRead: {
        method: 'GET',
        authentication: 'none',
        rateLimits: {
            windowMs: 60000,
            maxRequests: 100
        },
        cache: {
            enabled: true,
            ttl: 300
        }
    },
    publicWrite: {
        method: 'POST',
        authentication: 'none',
        rateLimits: {
            windowMs: 60000,
            maxRequests: 10
        },
        circuitBreaker: true
    },
    authenticatedRead: {
        method: 'GET',
        authentication: 'jwt',
        rateLimits: {
            windowMs: 60000,
            maxRequests: 200
        },
        cache: {
            enabled: true,
            ttl: 60
        }
    },
    authenticatedWrite: {
        method: 'POST',
        authentication: 'jwt',
        rateLimits: {
            windowMs: 60000,
            maxRequests: 50
        },
        circuitBreaker: true
    },
    adminEndpoint: {
        method: 'POST',
        authentication: 'jwt',
        authorization: ['admin'],
        rateLimits: {
            windowMs: 60000,
            maxRequests: 20
        }
    }
};
// Common endpoint patterns
function createCRUDEndpoints(resource, options = {}) {
    const base = {
        authentication: options.authentication || 'jwt',
        authorization: options.authorization,
        rateLimits: {
            windowMs: 60000,
            maxRequests: options.rateLimit || 100
        }
    };
    return [
        // List
        {
            ...base,
            path: `/${resource}`,
            method: 'GET',
            cache: options.cache ? { enabled: true, ttl: 60 } : undefined,
            description: `List all ${resource}`
        },
        // Get
        {
            ...base,
            path: `/${resource}/:id`,
            method: 'GET',
            cache: options.cache ? { enabled: true, ttl: 300 } : undefined,
            description: `Get a specific ${resource}`
        },
        // Create
        {
            ...base,
            path: `/${resource}`,
            method: 'POST',
            circuitBreaker: true,
            description: `Create a new ${resource}`
        },
        // Update
        {
            ...base,
            path: `/${resource}/:id`,
            method: 'PUT',
            circuitBreaker: true,
            description: `Update a ${resource}`
        },
        // Patch
        {
            ...base,
            path: `/${resource}/:id`,
            method: 'PATCH',
            circuitBreaker: true,
            description: `Partially update a ${resource}`
        },
        // Delete
        {
            ...base,
            path: `/${resource}/:id`,
            method: 'DELETE',
            authorization: options.authorization || ['admin'],
            rateLimits: {
                windowMs: 60000,
                maxRequests: 10
            },
            description: `Delete a ${resource}`
        }
    ];
}
// Utility for bulk endpoint registration
function registerBulkEndpoints(gateway, endpoints) {
    for (const [category, endpointList] of Object.entries(endpoints)) {
        console.log(`Registering ${endpointList.length} endpoints for ${category}`);
        gateway.registerEndpoints(endpointList);
    }
}
// Rate limiter factories
exports.rateLimiters = {
    strict: RateLimiter_1.createStrictRateLimiter,
    moderate: RateLimiter_1.createModerateRateLimiter,
    relaxed: RateLimiter_1.createRelaxedRateLimiter,
    api: RateLimiter_1.createApiRateLimiter,
    user: RateLimiter_1.createUserRateLimiter
};
//# sourceMappingURL=index.js.map