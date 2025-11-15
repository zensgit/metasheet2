"use strict";
/**
 * Feature Flags Configuration
 *
 * All feature flags follow the naming convention: FEATURE_{DOMAIN}_{CAPABILITY}
 * Default: false (disabled) for safety
 *
 * Usage:
 *   import { FEATURE_FLAGS, isFeatureEnabled } from './config/flags'
 *   if (isFeatureEnabled('FEATURE_VIEWSERVICE_UNIFICATION')) { ... }
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FEATURE_FLAGS = void 0;
exports.isFeatureEnabled = isFeatureEnabled;
exports.getEnabledFeatures = getEnabledFeatures;
exports.FEATURE_FLAGS = {
    // ViewService Unification (PR #246 Track)
    FEATURE_VIEWSERVICE_UNIFICATION: process.env.FEATURE_VIEWSERVICE_UNIFICATION === 'true',
    FEATURE_TABLE_RBAC_ENABLED: process.env.FEATURE_TABLE_RBAC_ENABLED === 'true',
    FEATURE_VIEWSERVICE_ROUTES: process.env.FEATURE_VIEWSERVICE_ROUTES === 'true',
    FEATURE_VIEWSERVICE_METRICS: process.env.FEATURE_VIEWSERVICE_METRICS === 'true',
    // PR #155 Backend Features
    FEATURE_JWT_IMPROVEMENTS: process.env.FEATURE_JWT_IMPROVEMENTS === 'true',
    FEATURE_ADMIN_ROUTES_V2: process.env.FEATURE_ADMIN_ROUTES_V2 === 'true',
    FEATURE_METRICS_V2: process.env.FEATURE_METRICS_V2 === 'true',
    // PR #155 Frontend Features
    FEATURE_VIEW_MANAGER_V2: process.env.FEATURE_VIEW_MANAGER_V2 === 'true',
    FEATURE_FORM_GALLERY_VIEWS: process.env.FEATURE_FORM_GALLERY_VIEWS === 'true',
};
/**
 * Type-safe feature flag accessor
 * @param flag - The feature flag key
 * @returns boolean - true if enabled, false otherwise
 */
function isFeatureEnabled(flag) {
    return exports.FEATURE_FLAGS[flag] === true;
}
/**
 * Get all enabled features (for debugging/monitoring)
 */
function getEnabledFeatures() {
    return Object.entries(exports.FEATURE_FLAGS)
        .filter(([_, enabled]) => enabled)
        .map(([flag]) => flag);
}
//# sourceMappingURL=flags.js.map