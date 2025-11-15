"use strict";
/**
 * Cache Module - Phase 1: Observation Infrastructure
 *
 * Provides cache abstraction with metrics collection.
 * Phase 1 focuses on observation without changing business logic.
 *
 * Usage:
 * ```typescript
 * import { cache } from './cache'
 *
 * // Get from cache
 * const result = await cache.get<User>('user:123')
 * if (result.ok && result.value) {
 *   // Cache hit
 * }
 *
 * // Set to cache
 * await cache.set('user:123', userData, 3600)
 * ```
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.cache = exports.cacheMetrics = exports.NullCache = exports.CacheRegistry = void 0;
var registry_1 = require("./registry");
Object.defineProperty(exports, "CacheRegistry", { enumerable: true, get: function () { return registry_1.CacheRegistry; } });
var null_cache_1 = require("./implementations/null-cache");
Object.defineProperty(exports, "NullCache", { enumerable: true, get: function () { return null_cache_1.NullCache; } });
var metrics_1 = require("./metrics");
Object.defineProperty(exports, "cacheMetrics", { enumerable: true, get: function () { return metrics_1.cacheMetrics; } });
// Create and export default cache instance
const registry_2 = require("./registry");
const null_cache_2 = require("./implementations/null-cache");
// Default: NullCache (safe, no-op)
const cacheRegistry = new registry_2.CacheRegistry(new null_cache_2.NullCache());
cacheRegistry.register('null', new null_cache_2.NullCache());
exports.cache = cacheRegistry;
//# sourceMappingURL=index.js.map