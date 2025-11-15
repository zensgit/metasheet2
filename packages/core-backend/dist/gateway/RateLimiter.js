"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RateLimiter = exports.RedisRateLimitStore = exports.MemoryRateLimitStore = void 0;
exports.createRateLimiter = createRateLimiter;
exports.createStrictRateLimiter = createStrictRateLimiter;
exports.createModerateRateLimiter = createModerateRateLimiter;
exports.createRelaxedRateLimiter = createRelaxedRateLimiter;
exports.createApiRateLimiter = createApiRateLimiter;
exports.createUserRateLimiter = createUserRateLimiter;
const crypto_1 = __importDefault(require("crypto"));
const events_1 = __importDefault(require("events"));
// Memory store for rate limiting
class MemoryRateLimitStore {
    store = new Map();
    timers = new Map();
    async get(key) {
        const entry = this.store.get(key);
        if (!entry)
            return null;
        if (entry.resetTime < new Date()) {
            this.store.delete(key);
            return null;
        }
        return entry;
    }
    async set(key, entry, ttlMs) {
        this.store.set(key, entry);
        // Clear existing timer
        const existingTimer = this.timers.get(key);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }
        // Set new timer for cleanup
        const timer = setTimeout(() => {
            this.store.delete(key);
            this.timers.delete(key);
        }, ttlMs);
        this.timers.set(key, timer);
    }
    async increment(key, weight = 1) {
        const entry = await this.get(key);
        if (entry) {
            entry.count += weight;
            return entry;
        }
        // Create new entry
        const windowMs = 60000; // Default 1 minute
        const newEntry = {
            count: weight,
            resetTime: new Date(Date.now() + windowMs),
            firstRequest: new Date()
        };
        await this.set(key, newEntry, windowMs);
        return newEntry;
    }
    async reset(key) {
        this.store.delete(key);
        const timer = this.timers.get(key);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(key);
        }
    }
    async resetAll() {
        this.store.clear();
        this.timers.forEach(timer => clearTimeout(timer));
        this.timers.clear();
    }
}
exports.MemoryRateLimitStore = MemoryRateLimitStore;
// Redis store for distributed rate limiting
class RedisRateLimitStore {
    redis; // Redis client type
    constructor(redisClient) {
        this.redis = redisClient;
    }
    async get(key) {
        const data = await this.redis.get(`ratelimit:${key}`);
        if (!data)
            return null;
        const entry = JSON.parse(data);
        entry.resetTime = new Date(entry.resetTime);
        entry.firstRequest = new Date(entry.firstRequest);
        if (entry.resetTime < new Date()) {
            await this.redis.del(`ratelimit:${key}`);
            return null;
        }
        return entry;
    }
    async set(key, entry, ttlMs) {
        const data = JSON.stringify(entry);
        await this.redis.set(`ratelimit:${key}`, data, 'PX', ttlMs);
    }
    async increment(key, weight = 1) {
        const redisKey = `ratelimit:${key}`;
        // Use Redis MULTI for atomic operation
        const multi = this.redis.multi();
        multi.get(redisKey);
        multi.ttl(redisKey);
        const [[error1, data], [error2, ttl]] = await multi.exec();
        if (error1 || error2) {
            throw new Error('Redis operation failed');
        }
        if (data) {
            const entry = JSON.parse(data);
            entry.count += weight;
            entry.resetTime = new Date(entry.resetTime);
            entry.firstRequest = new Date(entry.firstRequest);
            await this.redis.set(redisKey, JSON.stringify(entry), 'PX', ttl * 1000);
            return entry;
        }
        // Create new entry
        const windowMs = 60000;
        const newEntry = {
            count: weight,
            resetTime: new Date(Date.now() + windowMs),
            firstRequest: new Date()
        };
        await this.set(key, newEntry, windowMs);
        return newEntry;
    }
    async reset(key) {
        await this.redis.del(`ratelimit:${key}`);
    }
    async resetAll() {
        const keys = await this.redis.keys('ratelimit:*');
        if (keys.length > 0) {
            await this.redis.del(...keys);
        }
    }
}
exports.RedisRateLimitStore = RedisRateLimitStore;
class RateLimiter extends events_1.default {
    config;
    store;
    constructor(config = {}) {
        super();
        this.config = {
            windowMs: config.windowMs || 60000, // 1 minute default
            maxRequests: config.maxRequests || 100,
            keyGenerator: config.keyGenerator || this.defaultKeyGenerator,
            skipSuccessfulRequests: config.skipSuccessfulRequests || false,
            skipFailedRequests: config.skipFailedRequests || false,
            standardHeaders: config.standardHeaders !== false,
            legacyHeaders: config.legacyHeaders || false,
            handler: config.handler || this.defaultHandler,
            onLimitReached: config.onLimitReached || (() => { }),
            store: config.store || new MemoryRateLimitStore(),
            weight: config.weight || (() => 1),
            skipIf: config.skipIf || (() => false)
        };
        this.store = this.config.store;
    }
    defaultKeyGenerator(req) {
        // Use IP address as default key
        return req.ip ||
            req.headers['x-forwarded-for']?.toString().split(',')[0] ||
            req.connection.remoteAddress ||
            'unknown';
    }
    defaultHandler(req, res) {
        res.status(429).json({
            error: 'Too Many Requests',
            message: 'Rate limit exceeded, please try again later',
            retryAfter: Math.ceil(this.config.windowMs / 1000)
        });
    }
    middleware() {
        return async (req, res, next) => {
            try {
                // Check if should skip
                if (await this.config.skipIf(req)) {
                    return next();
                }
                const key = this.config.keyGenerator(req);
                const weight = this.config.weight(req);
                // Get current state
                let entry = await this.store.get(key);
                // Check if window expired
                if (!entry || entry.resetTime < new Date()) {
                    entry = await this.store.increment(key, 0);
                }
                const info = {
                    limit: this.config.maxRequests,
                    remaining: Math.max(0, this.config.maxRequests - entry.count),
                    resetTime: entry.resetTime,
                    retryAfter: Math.ceil((entry.resetTime.getTime() - Date.now()) / 1000)
                };
                // Set headers
                if (this.config.standardHeaders) {
                    res.setHeader('RateLimit-Limit', info.limit);
                    res.setHeader('RateLimit-Remaining', info.remaining);
                    res.setHeader('RateLimit-Reset', entry.resetTime.toISOString());
                }
                if (this.config.legacyHeaders) {
                    res.setHeader('X-RateLimit-Limit', info.limit);
                    res.setHeader('X-RateLimit-Remaining', info.remaining);
                    res.setHeader('X-RateLimit-Reset', Math.floor(entry.resetTime.getTime() / 1000));
                }
                // Check if limit exceeded
                if (entry.count >= this.config.maxRequests) {
                    res.setHeader('Retry-After', info.retryAfter);
                    this.emit('limitReached', { req, res, key, info });
                    this.config.onLimitReached(req, res);
                    return this.config.handler(req, res);
                }
                // Increment counter
                await this.store.increment(key, weight);
                req.rateLimit = info;
                // Hook to skip counting successful/failed requests
                const originalSend = res.send;
                res.send = function (data) {
                    const shouldSkip = ((res.statusCode < 400 && this.config.skipSuccessfulRequests) ||
                        (res.statusCode >= 400 && this.config.skipFailedRequests));
                    if (shouldSkip) {
                        // Decrement the counter
                        this.store.increment(key, -weight).catch(() => { });
                    }
                    return originalSend.call(this, data);
                }.bind(this);
                next();
            }
            catch (error) {
                this.emit('error', error);
                next(error);
            }
        };
    }
    async reset(key) {
        if (key) {
            await this.store.reset(key);
        }
        else {
            await this.store.resetAll();
        }
    }
    async getInfo(key) {
        const entry = await this.store.get(key);
        if (!entry)
            return null;
        return {
            limit: this.config.maxRequests,
            remaining: Math.max(0, this.config.maxRequests - entry.count),
            resetTime: entry.resetTime,
            retryAfter: Math.ceil((entry.resetTime.getTime() - Date.now()) / 1000)
        };
    }
}
exports.RateLimiter = RateLimiter;
// Utility functions for creating common rate limiters
function createRateLimiter(options) {
    return new RateLimiter(options);
}
function createStrictRateLimiter() {
    return new RateLimiter({
        windowMs: 60000, // 1 minute
        maxRequests: 10, // 10 requests per minute
        standardHeaders: true,
        legacyHeaders: false
    });
}
function createModerateRateLimiter() {
    return new RateLimiter({
        windowMs: 60000, // 1 minute
        maxRequests: 60, // 60 requests per minute
        standardHeaders: true,
        legacyHeaders: false
    });
}
function createRelaxedRateLimiter() {
    return new RateLimiter({
        windowMs: 60000, // 1 minute
        maxRequests: 200, // 200 requests per minute
        standardHeaders: true,
        legacyHeaders: false
    });
}
// API-specific rate limiters
function createApiRateLimiter() {
    return new RateLimiter({
        windowMs: 15 * 60 * 1000, // 15 minutes
        maxRequests: 100,
        standardHeaders: true,
        keyGenerator: (req) => {
            // Use API key if present, otherwise use IP
            const apiKey = req.headers['x-api-key']?.toString();
            if (apiKey) {
                return `api:${crypto_1.default.createHash('sha256').update(apiKey).digest('hex')}`;
            }
            return req.ip || 'unknown';
        }
    });
}
function createUserRateLimiter() {
    return new RateLimiter({
        windowMs: 60000,
        maxRequests: 100,
        standardHeaders: true,
        keyGenerator: (req) => {
            // Use user ID if authenticated
            const user = req.user;
            if (user?.id) {
                return `user:${user.id}`;
            }
            return req.ip || 'unknown';
        }
    });
}
//# sourceMappingURL=RateLimiter.js.map